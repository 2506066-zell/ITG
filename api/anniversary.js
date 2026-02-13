import { pool, readBody, verifyToken, withErrorHandling, sendJson } from './_lib.js';
export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  if (req.method === 'GET') {
    const r = await pool.query('SELECT * FROM anniversary WHERE id=1');
    if (r.rows.length === 0) {
      const created = await pool.query('INSERT INTO anniversary (id) VALUES (1) RETURNING *');
      sendJson(res, 200, created.rows[0], 300);
      return;
    }
    sendJson(res, 200, r.rows[0], 300);
    return;
  }
  if (req.method === 'PUT') {
    const b = req.body || await readBody(req);
    const { date, note } = b;
    let dval = null;
    if (date) {
      const dt = new Date(date);
      if (isNaN(dt)) { res.status(400).json({ error: 'Invalid date' }); return; }
      dval = dt;
    }
    const r = await pool.query('UPDATE anniversary SET date=$1, note=$2 WHERE id=1 RETURNING *', [dval, note || null]);
    sendJson(res, 200, r.rows[0]);
    return;
  }
  res.status(405).json({ error: 'Method not allowed' });
})
