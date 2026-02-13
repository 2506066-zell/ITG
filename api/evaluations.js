import { pool, readBody, verifyToken, withErrorHandling, sendJson } from './_lib.js';

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS evaluations (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      mood INTEGER NOT NULL CHECK (mood >= 1 AND mood <= 5),
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      is_deleted BOOLEAN DEFAULT FALSE
    )
  `);
}

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  const user = v.user;
  await ensureTable();

  if (req.method === 'GET') {
    const r = await pool.query(
      'SELECT id, user_id, mood, note, created_at FROM evaluations WHERE is_deleted = FALSE AND user_id = $1 ORDER BY created_at DESC',
      [user]
    );
    sendJson(res, 200, r.rows, 10);
    return;
  }

  if (req.method === 'POST') {
    const b = req.body || await readBody(req);
    const mood = Number(b.mood);
    const note = (b.note || '').toString();
    if (!Number.isInteger(mood) || mood < 1 || mood > 5) {
      res.status(400).json({ error: 'Invalid mood' });
      return;
    }
    const r = await pool.query(
      'INSERT INTO evaluations (user_id, mood, note) VALUES ($1, $2, $3) RETURNING id, user_id, mood, note, created_at',
      [user, mood, note]
    );
    sendJson(res, 200, r.rows[0]);
    return;
  }

  if (req.method === 'DELETE') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const idNum = Number(id);
    if (!idNum) { res.status(400).json({ error: 'Invalid id' }); return; }
    const cur = await pool.query('SELECT user_id FROM evaluations WHERE id=$1', [idNum]);
    if (cur.rowCount === 0) { res.status(404).json({ error: 'Not found' }); return; }
    if (cur.rows[0].user_id !== user) { res.status(403).json({ error: 'Forbidden' }); return; }
    await pool.query('UPDATE evaluations SET is_deleted=TRUE WHERE id=$1', [idNum]);
    sendJson(res, 200, { ok: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
});
