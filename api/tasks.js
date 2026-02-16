import { pool, readBody, verifyToken, logActivity, withErrorHandling, sendJson } from './_lib.js';
import { sendNotificationToUser } from './notifications.js';

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  const user = v.user;

  // Handle Snooze Action
  const url = new URL(req.url, `http://${req.headers.host}`);
  const isSnooze = url.pathname.endsWith('/snooze') || (req.query && req.query.path === 'snooze');

  if (isSnooze && req.method === 'POST') {
    const b = req.body || await readBody(req);
    const { taskId, snoozeMinutes } = b;
    
    if (!taskId) { res.status(400).json({ error: 'Missing taskId' }); return; }
    const minutes = parseInt(snoozeMinutes) || 60; // Default 1 hour

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Ensure table exists
      await client.query(`
        CREATE TABLE IF NOT EXISTS task_snoozes (
          task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          snooze_until TIMESTAMP NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      const snoozeUntil = new Date(Date.now() + minutes * 60000);
      
      // Upsert snooze
      await client.query(`
        INSERT INTO task_snoozes (task_id, snooze_until, created_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (task_id) 
        DO UPDATE SET snooze_until = $2, created_at = NOW()
      `, [taskId, snoozeUntil]);

      await client.query('COMMIT');
      
      // Log activity
      await logActivity(client, 'task', taskId, 'SNOOZE', user, { minutes, until: snoozeUntil });
      
      sendJson(res, 200, { success: true, snooze_until: snoozeUntil });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return;
  }

  if (req.method === 'GET') {
    const r = await pool.query('SELECT * FROM tasks WHERE is_deleted = FALSE ORDER BY deadline ASC NULLS LAST, id DESC');
    sendJson(res, 200, r.rows, 30);
    return;
  }

  if (req.method === 'POST') {
    const b = req.body || await readBody(req);
    const { title, deadline, priority, assigned_to, goal_id } = b;
    if (!title || typeof title !== 'string') { res.status(400).json({ error: 'Invalid title' }); return; }

    const prio = ['low', 'medium', 'high'].includes(priority) ? priority : 'medium';
    const dl = deadline ? new Date(deadline) : null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        'INSERT INTO tasks (title, created_by, updated_by, deadline, priority, assigned_to, goal_id) VALUES ($1, $2, $2, $3, $4, $5, $6) RETURNING *',
        [title, user, dl, prio, assigned_to || user, goal_id || null]
      );
      await logActivity(client, 'task', r.rows[0].id, 'CREATE', user, { title, deadline: dl, priority: prio, assigned_to, goal_id });
      await client.query('COMMIT');
      sendJson(res, 200, r.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return;
  }

  if (req.method === 'PUT') {
    const b = req.body || await readBody(req);
    const { id, title, completed, version, deadline, priority, assigned_to, goal_id } = b;
    const idNum = Number(id);
    if (!idNum) { res.status(400).json({ error: 'Invalid id' }); return; }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const current = await client.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [idNum]);
      if (current.rowCount === 0 || current.rows[0].is_deleted) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const task = current.rows[0];
      const isOwner = task.created_by === user;
      const isAssigned = task.assigned_to === user;
      if (!isOwner && !isAssigned && task.created_by) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'Permission denied' });
        return;
      }

      const fields = [];
      const vals = [];
      let i = 1;
      const changes = {};

      if (title !== undefined) { fields.push(`title=$${i++}`); vals.push(title); changes.title = title; }
      if (goal_id !== undefined) { fields.push(`goal_id=$${i++}`); vals.push(goal_id); changes.goal_id = goal_id; }

      if (completed !== undefined) {
        fields.push(`completed=$${i++}`);
        vals.push(completed);
        changes.completed = completed;

        if (completed === true && !task.completed) {
          let score = 10;
          const p = priority || task.priority || 'medium';
          if (p === 'medium') score = Math.round(score * 1.5);
          if (p === 'high') score = Math.round(score * 2);
          const d = deadline ? new Date(deadline) : (task.deadline ? new Date(task.deadline) : null);
          if (d && new Date() <= d) score += 5;
          const g = goal_id || task.goal_id;
          if (g) score += 5;

          fields.push(`score_awarded=$${i++}`);
          vals.push(score);
          changes.score_awarded = score;
          fields.push(`completed_at=NOW()`);
          fields.push(`completed_by=$${i++}`);
          vals.push(user);
          changes.completed_by = user;

          // Notify Partner Logic
          const partner = user === 'Zaldy' ? 'Nesya' : (user === 'Nesya' ? 'Zaldy' : null);
          if (partner) {
             const msg = `${user} telah menyelesaikan tugas "${task.title}". Ayo kerjakan tugas kamu! 💪`;
             // Fire and forget notification (don't await to block response)
             sendNotificationToUser(partner, {
                 title: 'Task Completed ✅',
                 body: msg,
                 url: '/daily-tasks'
             }).catch(console.error);
          }
        } else if (completed === false && task.completed) {
          fields.push(`score_awarded=$${i++}`);
          vals.push(0);
          changes.score_awarded = 0;
          fields.push(`completed_at=NULL`);
          fields.push(`completed_by=NULL`);
        }
      }

      if (deadline !== undefined) {
        const dl = deadline ? new Date(deadline) : null;
        fields.push(`deadline=$${i++}`); vals.push(dl); changes.deadline = dl;
      }
      if (priority !== undefined) {
        const prio = ['low', 'medium', 'high'].includes(priority) ? priority : 'medium';
        fields.push(`priority=$${i++}`); vals.push(prio); changes.priority = prio;
      }
      if (assigned_to !== undefined) { fields.push(`assigned_to=$${i++}`); vals.push(assigned_to); changes.assigned_to = assigned_to; }

      fields.push(`updated_by=$${i++}`);
      vals.push(user);
      fields.push(`version = COALESCE(version, 0) + 1`);

      vals.push(idNum);
      let query = `UPDATE tasks SET ${fields.join(', ')} WHERE id=$${i}`;
      if (version !== undefined) {
        i++;
        vals.push(version);
        query += ` AND version=$${i}`;
      }
      query += ` RETURNING *`;

      const r = await client.query(query, vals);
      if (r.rowCount === 0) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Conflict: Data modified by another user.' });
        return;
      }

      await logActivity(client, 'task', idNum, 'UPDATE', user, changes);
      await client.query('COMMIT');
      sendJson(res, 200, r.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return;
  }

  if (req.method === 'DELETE') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const idNum = Number(id);
    if (!idNum) { res.status(400).json({ error: 'Invalid id' }); return; }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [idNum]);
      if (current.rowCount === 0 || current.rows[0].is_deleted) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const task = current.rows[0];
      if (task.created_by && task.created_by !== user) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'Permission denied' });
        return;
      }

      await client.query(
        'UPDATE tasks SET is_deleted=TRUE, deleted_by=$1, deleted_at=NOW() WHERE id=$2',
        [user, idNum]
      );
      await logActivity(client, 'task', idNum, 'DELETE', user, {});
      await client.query('COMMIT');
      sendJson(res, 200, { ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
})
