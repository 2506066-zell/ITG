import { pool, readBody, verifyToken, withErrorHandling, sendJson } from './_lib.js';
export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  if (req.method === 'GET') {
    const r = await pool.query('SELECT * FROM memories ORDER BY created_at DESC');
    sendJson(res, 200, r.rows, 30);
    return;
  }
  if (req.method === 'POST') {
    const b = req.body || await readBody(req);
    const { title, media_type, media_data, note } = b;
    if (!title || typeof title !== 'string') { res.status(400).json({ error: 'Invalid title' }); return; }
    if (media_type && typeof media_type !== 'string') { res.status(400).json({ error: 'Invalid media_type' }); return; }
    if (media_data && typeof media_data !== 'string') { res.status(400).json({ error: 'Invalid media_data' }); return; }
    if (note && typeof note !== 'string') { res.status(400).json({ error: 'Invalid note' }); return; }
    const r = await pool.query(
      'INSERT INTO memories (title, media_type, media_data, note) VALUES ($1,$2,$3,$4) RETURNING *',
      [title, media_type, media_data, note]
    );
    sendJson(res, 200, r.rows[0]);
    return;
  }
  if (req.method === 'PUT') {
    const b = req.body || await readBody(req);
    const { id, title, media_type, media_data, note, version } = b;
    const idNum = Number(id);
    if (!idNum) { res.status(400).json({ error: 'Invalid id' }); return; }
    const fields = [];
    const vals = [];
    let i = 1;
    if (title !== undefined) { fields.push(`title=$${i++}`); vals.push(title); }
    if (media_type !== undefined) { fields.push(`media_type=$${i++}`); vals.push(media_type); }
    if (media_data !== undefined) { fields.push(`media_data=$${i++}`); vals.push(media_data); }
    if (note !== undefined) { fields.push(`note=$${i++}`); vals.push(note); }
    
    // Increment version
    fields.push(`version = COALESCE(version, 0) + 1`);

    vals.push(idNum);
    let query = `UPDATE memories SET ${fields.join(', ')} WHERE id=$${i}`;
    
    if (version !== undefined) {
      i++;
      vals.push(version);
      query += ` AND version=$${i}`;
    }
    
    query += ` RETURNING *`;
    
    const r = await pool.query(query, vals);
    
    if (r.rowCount === 0) {
      const check = await pool.query('SELECT id FROM memories WHERE id=$1', [idNum]);
      if (check.rowCount === 0) {
        res.status(404).json({ error: 'Memory not found' });
      } else {
        res.status(409).json({ error: 'Conflict: Data has been modified by another user. Please refresh and try again.' });
      }
      return;
    }
    
    sendJson(res, 200, r.rows[0]);
    return;
  }
  if (req.method === 'DELETE') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const idNum = Number(id);
    if (!idNum) { res.status(400).json({ error: 'Invalid id' }); return; }
    await pool.query('DELETE FROM memories WHERE id=$1', [idNum]);
    sendJson(res, 200, { ok: true });
    return;
  }
  res.status(405).json({ error: 'Method not allowed' });
})
