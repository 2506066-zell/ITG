import { pool, withErrorHandling, sendJson } from '../../api/_lib.js';
import { sendNotificationToUser } from '../../api/notifications.js';

export default withErrorHandling(async function handler(req, res) {
  // CRON Authentication (Vercel automatically sets this header)
  const auth = req.headers.authorization || '';
  // In production, Vercel Cron sets 'Authorization: Bearer <CRON_SECRET>'
  // For now, we allow manual trigger or Vercel Cron.
  // if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ error: 'Unauthorized' });
  // }

  const client = await pool.connect();
  try {
    // 1. Select a random unused topic
    let r = await client.query(`
      SELECT * FROM discussion_topics 
      WHERE is_used = FALSE 
      ORDER BY RANDOM() 
      LIMIT 1
    `);

    // If all used, reset cycle
    if (r.rowCount === 0) {
      await client.query('UPDATE discussion_topics SET is_used = FALSE');
      r = await client.query(`
        SELECT * FROM discussion_topics 
        ORDER BY RANDOM() 
        LIMIT 1
      `);
    }

    const topic = r.rows[0];
    if (!topic) {
      return sendJson(res, 200, { message: 'No topics available' });
    }

    // 2. Mark as used
    await client.query(`
      UPDATE discussion_topics 
      SET is_used = TRUE, last_used_at = NOW() 
      WHERE id = $1
    `, [topic.id]);

    // 3. Post to Chat as 'System'
    const message = `🤖 **Daily Topic:** ${topic.topic}`;
    await client.query(`
      INSERT INTO chat_messages (user_id, message) 
      VALUES ('System', $1)
    `, [message]);

    // 4. Send Push Notification to all users
    const usersRes = await client.query('SELECT DISTINCT user_id FROM push_subscriptions');
    for (const u of usersRes.rows) {
      await sendNotificationToUser(u.user_id, {
        title: 'Daily Discussion 💬',
        body: topic.topic,
        url: '/chat'
      });
    }

    sendJson(res, 200, { posted: true, topic: topic.topic });
  } finally {
    client.release();
  }
});
