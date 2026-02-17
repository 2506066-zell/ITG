import { verifyToken, withErrorHandling, sendJson } from './_lib.js';
import { getProactiveFeedForUser, runProactiveEngine } from './proactive_engine.js';

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  const user = v.user;

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const limit = Number(url.searchParams.get('limit') || 20);
    const data = await getProactiveFeedForUser(user, limit);
    sendJson(res, 200, data, 10);
    return;
  }

  if (req.method === 'POST') {
    if (user !== 'Zaldy') {
      res.status(403).json({ error: 'Only admin can trigger proactive engine manually' });
      return;
    }

    const result = await runProactiveEngine({ notify: true });
    sendJson(res, 200, result);
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
});
