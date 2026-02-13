import { pool, readBody, verifyToken, logActivity, withErrorHandling, sendJson } from './_lib.js';

export default withErrorHandling(async function handler(req, res) {
    const v = verifyToken(req, res);
    if (!v) return;
    const user = v.user;

    if (req.method === 'GET') {
        // Fetch last 50 messages
        const r = await pool.query('SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT 50');
        // Reverse to show oldest first in UI
        sendJson(res, 200, r.rows.reverse(), 15);
        return;
    }

    if (req.method === 'POST') {
        const b = req.body || await readBody(req);
        const { message } = b;

        if (!message || typeof message !== 'string') {
            res.status(400).json({ error: 'Message required' });
            return;
        }

        const r = await pool.query(
            'INSERT INTO chat_messages (user_id, message) VALUES ($1, $2) RETURNING *',
            [user, message]
        );

        sendJson(res, 200, r.rows[0]);
        return;
    }

    if (req.method === 'DELETE') {
        // Optional: Admin clear chat
        if (user !== 'Zaldy') { // Hardcoded admin check for now
            res.status(403).json({ error: 'Only admin can clear chat' });
            return;
        }
        await pool.query('DELETE FROM chat_messages');
        sendJson(res, 200, { ok: true });
        return;
    }

    res.status(405).json({ error: 'Method not allowed' });
})
