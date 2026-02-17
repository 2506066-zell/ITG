import { pool, readBody, verifyToken, withErrorHandling, sendJson, logActivity } from './_lib.js';
import { sendNotificationToUser } from './notifications.js';

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  const user = v.user;
  if (req.method === 'GET') {
    try {
      const r = await pool.query('SELECT * FROM assignments ORDER BY deadline NULLS LAST, id DESC');
      sendJson(res, 200, r.rows, 30);
    } catch (e) {
      res.status(500).json({ error: 'Internal Server Error', details: e.message });
    }
    return;
  }
  if (req.method === 'POST') {
    const b = req.body || await readBody(req);
    const { action, title, description, deadline, id, completed } = b;
    if (action === 'toggle') {
      const idNum = Number(id);
      if (!idNum) { res.status(400).json({ error: 'Invalid id' }); return; }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const cur = await client.query('SELECT * FROM assignments WHERE id=$1 FOR UPDATE', [idNum]);
        if (cur.rowCount === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'Not found' });
          return;
        }
        const row = cur.rows[0];
        const fields = [];
        const vals = [];
        let i = 1;
        const changes = {};
        if (completed !== undefined) {
          fields.push(`completed=$${i++}`);
          vals.push(completed);
          changes.completed = completed;
          if (completed === true && !row.completed) {
            fields.push(`completed_at=NOW()`);
            fields.push(`completed_by=$${i++}`);
            vals.push(user);
            changes.completed_by = user;

            // Notify partner when assignment is completed from quick-toggle flow
            const partner = user === 'Zaldy' ? 'Nesya' : (user === 'Nesya' ? 'Zaldy' : null);
            if (partner) {
              const msg = `${user} telah menyelesaikan tugas kuliah "${row.title}". Semangat ya! 🎓`;
              sendNotificationToUser(partner, {
                title: 'Assignment Done ✅',
                body: msg,
                url: '/college-assignments'
              }).catch(console.error);
            }
          } else if (completed === false && row.completed) {
            fields.push(`completed_at=NULL`);
            fields.push(`completed_by=NULL`);
          }
        }
        vals.push(idNum);
        const r = await client.query(`UPDATE assignments SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, vals);
        await logActivity(client, 'assignment', idNum, 'UPDATE', user, changes);
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
    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'Invalid title' });
      return;
    }

    const dl = deadline ? new Date(deadline) : null;
    if (deadline && isNaN(dl)) {
      res.status(400).json({ error: 'Invalid deadline' });
      return;
    }
    
    // Validate assigned_to
    const { assigned_to } = b;
    const assigned = assigned_to || null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query('INSERT INTO assignments (title, description, deadline, assigned_to) VALUES ($1,$2,$3,$4) RETURNING *', [title, description || null, dl || null, assigned]);
      await logActivity(client, 'assignment', r.rows[0].id, 'CREATE', user, { title, description, deadline: dl, assigned_to: assigned });
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
    const { id, title, deadline, completed, assigned_to } = b;
    const idNum = Number(id);
    if (!idNum) { res.status(400).json({ error: 'Invalid id' }); return; }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query('SELECT * FROM assignments WHERE id=$1 FOR UPDATE', [idNum]);
      if (cur.rowCount === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const row = cur.rows[0];

      const fields = [];
      const vals = [];
      let i = 1;
      const changes = {};

      if (title !== undefined) { fields.push(`title=$${i++}`); vals.push(title); changes.title = title; }
      if (assigned_to !== undefined) { fields.push(`assigned_to=$${i++}`); vals.push(assigned_to); changes.assigned_to = assigned_to; }
      if (deadline !== undefined) {
        const dl = deadline ? new Date(deadline) : null;
        if (deadline && isNaN(dl)) { await client.query('ROLLBACK'); res.status(400).json({ error: 'Invalid deadline' }); return; }
        fields.push(`deadline=$${i++}`); vals.push(dl || null); changes.deadline = dl;
      }
      if (completed !== undefined) {
        fields.push(`completed=$${i++}`);
        vals.push(completed);
        changes.completed = completed;
        if (completed === true && !row.completed) {
          fields.push(`completed_at=NOW()`);
          fields.push(`completed_by=$${i++}`);
          vals.push(user);
          changes.completed_by = user;

          // Notify Partner Logic
          const partner = user === 'Zaldy' ? 'Nesya' : (user === 'Nesya' ? 'Zaldy' : null);
          if (partner) {
             const msg = `${user} telah menyelesaikan tugas kuliah "${row.title}". Semangat ya! 🎓`;
             sendNotificationToUser(partner, {
                 title: 'Assignment Done ✅',
                 body: msg,
                 url: '/college-assignments'
             }).catch(console.error);
          }
        } else if (completed === false && row.completed) {
          fields.push(`completed_at=NULL`);
          fields.push(`completed_by=NULL`);
        }
      }

      vals.push(idNum);
      const r = await client.query(`UPDATE assignments SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, vals);
      await logActivity(client, 'assignment', idNum, 'UPDATE', user, changes);
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
      const cur = await client.query('SELECT id FROM assignments WHERE id=$1 FOR UPDATE', [idNum]);
      if (cur.rowCount === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Not found' });
        return;
      }
      await client.query('DELETE FROM assignments WHERE id=$1', [idNum]);
      await logActivity(client, 'assignment', idNum, 'DELETE', user, {});
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
