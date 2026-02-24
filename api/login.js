import jwt from 'jsonwebtoken';
import { readBody } from './_lib.js';
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const body = req.body || await readBody(req);
  const { username, password } = body;
  
  // Validate username
  const allowedUsers = ['Zaldy', 'Nesya'];
  const requiredPassword = process.env.APP_LOGIN_PASSWORD || 'Zal123456';

  if (!username || !allowedUsers.includes(username) || !password || password !== requiredPassword) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const secret = process.env.JWT_SECRET || '';
  if (!secret) { res.status(500).json({ error: 'Server misconfigured' }); return; }
  
  // Payload now includes the specific user
  const payload = { user: username };
  const token = jwt.sign(payload, secret, { expiresIn: '1d', audience: 'cute-futura', issuer: 'cute-futura', algorithm: 'HS256' });
  res.status(200).json({ token, user: username });
}
