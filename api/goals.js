import { pool, readBody, verifyToken, logActivity, withErrorHandling, sendJson } from './_lib.js';

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  const user = v.user;

  if (req.method === 'GET') {
    const r = await pool.query('SELECT * FROM goals WHERE is_deleted = FALSE ORDER BY id DESC');
    sendJson(res, 200, r.rows, 30);
    return;
  }

  if (req.method === 'POST') {
    const b = req.body || await readBody(req);
    const { title, category, deadline } = b;

    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'Invalid title' });
      return;
    }

    const dl = deadline ? new Date(deadline) : null;
    if (deadline && isNaN(dl)) {
      res.status(400).json({ error: 'Invalid deadline' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        'INSERT INTO goals (title, category, deadline, progress, created_by, updated_by) VALUES ($1, $2, $3, 0, $4, $4) RETURNING *',
        [title, category || 'Personal', dl, user]
      );
      await logActivity(client, 'goal', r.rows[0].id, 'CREATE', user, { title, category, deadline: dl });
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
    const { id, title, category, deadline, progress, completed, version } = b;
    const idNum = Number(id);

    if (!idNum) { res.status(400).json({ error: 'Invalid id' }); return; }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM goals WHERE id=$1 FOR UPDATE', [idNum]);
      if (current.rowCount === 0 || current.rows[0].is_deleted) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Goal not found' });
        return;
      }

      const goal = current.rows[0];
      if (goal.created_by && goal.created_by !== user) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'You do not have permission to edit this goal' });
        return;
      }

      const fields = [];
      const vals = [];
      let i = 1;
      const changes = {};

      if (title !== undefined) { fields.push(`title=$${i++}`); vals.push(title); changes.title = title; }
      if (category !== undefined) { fields.push(`category=$${i++}`); vals.push(category); changes.category = category; }
      if (deadline !== undefined) {
        const dl = deadline ? new Date(deadline) : null;
        if (deadline && isNaN(dl)) { await client.query('ROLLBACK'); res.status(400).json({ error: 'Invalid deadline' }); return; }
        fields.push(`deadline=$${i++}`); vals.push(dl); changes.deadline = dl;
      }
      if (progress !== undefined) { fields.push(`progress=$${i++}`); vals.push(progress); changes.progress = progress; }
      if (completed !== undefined) { fields.push(`completed=$${i++}`); vals.push(completed); changes.completed = completed; }

      fields.push(`updated_by=$${i++}`);
      vals.push(user);
      fields.push(`version = COALESCE(version, 0) + 1`);

      vals.push(idNum);
      let query = `UPDATE goals SET ${fields.join(', ')} WHERE id=$${i}`;
      if (version !== undefined) {
        i++;
        vals.push(version);
        query += ` AND version=$${i}`;
      }
      query += ` RETURNING *`;

      const r = await client.query(query, vals);
      if (r.rowCount === 0) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Conflict: Data has been modified by another user. Please refresh.' });
        return;
      }

      await logActivity(client, 'goal', idNum, 'UPDATE', user, changes);
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
      const current = await client.query('SELECT * FROM goals WHERE id=$1 FOR UPDATE', [idNum]);
      if (current.rowCount === 0 || current.rows[0].is_deleted) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Goal not found' });
        return;
      }

      const goal = current.rows[0];
      if (goal.created_by && goal.created_by !== user) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'You do not have permission to delete this goal' });
        return;
      }

      await client.query(
        'UPDATE goals SET is_deleted=TRUE, deleted_by=$1, deleted_at=NOW() WHERE id=$2',
        [user, idNum]
      );
      await logActivity(client, 'goal', idNum, 'DELETE', user, {});
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
