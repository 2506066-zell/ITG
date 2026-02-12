import { pool, readBody, verifyToken, logActivity, withErrorHandling, sendJson } from './_lib.js';

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  const user = v.user;

  if (req.method === 'GET') {
    const r = await pool.query('SELECT * FROM tasks WHERE is_deleted = FALSE ORDER BY deadline ASC NULLS LAST, id DESC');
    sendJson(res, 200, r.rows, 30);
    return;
  }

  if (req.method === 'POST') {
    const b = req.body || await readBody(req);
    const { title, deadline, priority, assigned_to, goal_id } = b;
    if (!title || typeof title !== 'string') { res.status(400).json({ error: 'Invalid title' }); return; }
    
    // Validate priority
    const prio = ['low', 'medium', 'high'].includes(priority) ? priority : 'medium';
    const dl = deadline ? new Date(deadline) : null;

    const r = await pool.query(
      'INSERT INTO tasks (title, created_by, updated_by, deadline, priority, assigned_to, goal_id) VALUES ($1, $2, $2, $3, $4, $5, $6) RETURNING *', 
      [title, user, dl, prio, assigned_to || user, goal_id || null]
    );
    
    await logActivity(pool, 'task', r.rows[0].id, 'CREATE', user, { title, deadline: dl, priority: prio, assigned_to, goal_id });
    
    sendJson(res, 200, r.rows[0]);
    return;
  }

  if (req.method === 'PUT') {
    const b = req.body || await readBody(req);
    const { id, title, completed, version, deadline, priority, assigned_to, goal_id } = b;
    const idNum = Number(id);
    if (!idNum) { res.status(400).json({ error: 'Invalid id' }); return; }

    // Check existence
    const current = await pool.query('SELECT * FROM tasks WHERE id=$1', [idNum]);
    if (current.rowCount === 0 || current.rows[0].is_deleted) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    
    const task = current.rows[0];
    const isOwner = task.created_by === user;
    const isAssigned = task.assigned_to === user;
    
    if (!isOwner && !isAssigned && task.created_by) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const fields = [];
    const vals = [];
    let i = 1;
    const changes = {};

    if (title !== undefined) { fields.push(`title=$${i++}`); vals.push(title); changes.title = title; }
    if (goal_id !== undefined) { fields.push(`goal_id=$${i++}`); vals.push(goal_id); changes.goal_id = goal_id; }
    
    // Score Calculation Logic on Completion
    if (completed !== undefined) { 
        fields.push(`completed=$${i++}`); 
        vals.push(completed); 
        changes.completed = completed;
        
        if (completed === true && !task.completed) {
            // Task is being completed now. Calculate score.
            let score = 10; // Base
            
            // Priority Multiplier
            const p = priority || task.priority || 'medium';
            if (p === 'medium') score = Math.round(score * 1.5);
            if (p === 'high') score = Math.round(score * 2);
            
            // Deadline Bonus
            const d = deadline ? new Date(deadline) : (task.deadline ? new Date(task.deadline) : null);
            if (d && new Date() <= d) {
                score += 5;
            }
            
            // Shared Goal Bonus
            const g = goal_id || task.goal_id;
            if (g) {
                score += 5;
            }
            
            fields.push(`score_awarded=$${i++}`);
            vals.push(score);
            changes.score_awarded = score;
            
            // Set completed_at and completed_by
            fields.push(`completed_at=NOW()`);
            fields.push(`completed_by=$${i++}`);
            vals.push(user);
            changes.completed_by = user;
        } else if (completed === false && task.completed) {
            // Task reopened. Reset score? 
            // "Do not recalculate score retroactively unless explicitly requested."
            // But if reopened, score should probably be revoked? 
            // User didn't specify behavior for reopening. 
            // To prevent gaming (toggle on/off), let's set score to 0 or keep it?
            // "Assign score to completed_by user". If reopened, no one completed it.
            // Let's reset to 0.
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
    
    // Update updated_by
    fields.push(`updated_by=$${i++}`);
    vals.push(user);

    // Increment version
    fields.push(`version = COALESCE(version, 0) + 1`);

    vals.push(idNum);
    let query = `UPDATE tasks SET ${fields.join(', ')} WHERE id=$${i}`;
    
    // Optimistic locking check
    if (version !== undefined) {
      i++;
      vals.push(version);
      query += ` AND version=$${i}`;
    }
    
    query += ` RETURNING *`;
    
    const r = await pool.query(query, vals);
    
    if (r.rowCount === 0) {
      res.status(409).json({ error: 'Conflict: Data modified by another user.' });
      return;
    }

    await logActivity(pool, 'task', idNum, 'UPDATE', user, changes);

    sendJson(res, 200, r.rows[0]);
    return;
  }

  if (req.method === 'DELETE') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const idNum = Number(id);
    if (!idNum) { res.status(400).json({ error: 'Invalid id' }); return; }

    const current = await pool.query('SELECT * FROM tasks WHERE id=$1', [idNum]);
    if (current.rowCount === 0 || current.rows[0].is_deleted) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const task = current.rows[0];
    if (task.created_by && task.created_by !== user) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    await pool.query(
      'UPDATE tasks SET is_deleted=TRUE, deleted_by=$1, deleted_at=NOW() WHERE id=$2', 
      [user, idNum]
    );

    await logActivity(pool, 'task', idNum, 'DELETE', user, {});

    sendJson(res, 200, { ok: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
})
