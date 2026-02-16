import webpush from 'web-push';
import { pool, verifyToken, readBody, withErrorHandling, sendJson } from './_lib.js';

// Setup VAPID details
const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (publicVapidKey && privateVapidKey) {
  webpush.setVapidDetails(vapidSubject, publicVapidKey, privateVapidKey);
}

export default withErrorHandling(async function handler(req, res) {
  if (req.method === 'POST') {
    // SUBSCRIBE
    const v = verifyToken(req, res);
    if (!v) return;
    
    const subscription = req.body || await readBody(req);
    const userId = v.user;
    
    const client = await pool.connect();
    try {
      await client.query(`
        INSERT INTO push_subscriptions (user_id, endpoint, keys, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id, endpoint) 
        DO UPDATE SET keys = EXCLUDED.keys, updated_at = NOW()
      `, [userId, subscription.endpoint, JSON.stringify(subscription.keys)]);
      
      sendJson(res, 201, { ok: true });
    } finally {
      client.release();
    }
    return;
  }
  
  if (req.method === 'GET') {
      // Get VAPID Public Key
      sendJson(res, 200, { publicKey: publicVapidKey });
      return;
  }
  
  res.status(405).json({ error: 'Method not allowed' });
});

// Helper to send notifications (can be imported by other modules)
export async function sendNotificationToUser(userId, payload) {
    if (!publicVapidKey || !privateVapidKey) return;
    
    const r = await pool.query('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]);
    const promises = r.rows.map(async sub => {
        const pushSubscription = {
            endpoint: sub.endpoint,
            keys: sub.keys
        };
        try {
            await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
        } catch (err) {
            if (err.statusCode === 410 || err.statusCode === 404) {
                // Subscription expired/invalid
                await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
            } else {
                console.error('Push error', err);
            }
        }
    });
    await Promise.all(promises);
}
