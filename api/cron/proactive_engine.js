import { withErrorHandling, sendJson } from '../../api/_lib.js';
import { runProactiveEngine } from '../../api/proactive_engine.js';

export default withErrorHandling(async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await runProactiveEngine({ notify: true });
  sendJson(res, 200, result);
});
