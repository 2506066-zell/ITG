import { pool, verifyToken, withErrorHandling, sendJson } from './_lib.js';

export default withErrorHandling(async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const v = verifyToken(req, res);
  if (!v) return;
  
  const url = new URL(req.url, 'http://x');
  const entity_type = url.searchParams.get('entity_type');
  const entity_id = url.searchParams.get('entity_id');
  
  if (!entity_type || !entity_id) {
    res.status(400).json({ error: 'Missing entity_type or entity_id' });
    return;
  }
  
  try {
    const r = await pool.query(
      'SELECT * FROM activity_logs WHERE entity_type=$1 AND entity_id=$2 ORDER BY created_at DESC',
      [entity_type, entity_id]
    );
    sendJson(res, 200, r.rows, 30);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
})
