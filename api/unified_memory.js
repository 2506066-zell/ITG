import { verifyToken, withErrorHandling, sendJson } from './_lib.js';
import { buildUnifiedMemorySnapshot, normalizeMemoryDate } from './_unified_memory.js';

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  const user = v.user;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const u = new URL(req.url, 'http://x');
  const dateText = normalizeMemoryDate(u.searchParams.get('date'));
  const snapshot = await buildUnifiedMemorySnapshot(user, { date: dateText });
  sendJson(res, 200, snapshot, 20);
});

