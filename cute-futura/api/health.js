import { withErrorHandling, sendJson, pool } from './_lib.js';
export default withErrorHandling(async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const env = {
    database_url: !!process.env.DATABASE_URL,
    jwt_secret: !!process.env.JWT_SECRET,
    app_password_hash: !!process.env.APP_PASSWORD_HASH,
    node_env: process.env.NODE_ENV || ''
  };
  let db = 'ok';
  try {
    const r = await pool.query('SELECT 1');
    if (!r || !r.rows || r.rows.length === 0) db = 'fail';
  } catch {
    db = 'fail';
  }
  sendJson(res, 200, { status: db === 'ok' && env.database_url ? 'ok' : 'degraded', db, env, time: new Date().toISOString() }, 5);
})
