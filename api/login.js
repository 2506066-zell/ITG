import bcrypt from 'bcryptjs';
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
  if (!username || !allowedUsers.includes(username)) {
    res.status(401).json({ error: 'Invalid username' });
    return;
  }

  const hash = process.env.APP_PASSWORD_HASH || '';
  await new Promise(r => setTimeout(r, 300));
  const ok = hash && await bcrypt.compare(password || '', hash);
  if (!ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const secret = process.env.JWT_SECRET || '';
  if (!secret) { res.status(500).json({ error: 'Server misconfigured' }); return; }
  
  // Payload now includes the specific user
  const payload = { user: username };
  const token = jwt.sign(payload, secret, { expiresIn: '1d', audience: 'cute-futura', issuer: 'cute-futura', algorithm: 'HS256' });
  res.status(200).json({ token, user: username });
}
