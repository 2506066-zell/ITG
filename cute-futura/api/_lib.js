import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
export const pool = new Pool({
  // Use POSTGRES_URL first (Vercel default), fallback to DATABASE_URL
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
  max: 1, // Limit connections for Serverless environment
  idleTimeoutMillis: 3000, // Close idle connections faster
  connectionTimeoutMillis: 5000, // Fail fast if connection hangs
});

// Prevent crash on unexpected connection loss
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
  // Don't exit process, just log. Vercel/Neon will recover on next request.
});

export function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}
export function verifyToken(req, res) {
  const auth = req.headers.authorization || '';
  const [type, token] = auth.split(' ');
  if (type !== 'Bearer' || !token) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  try {
    const opts = { audience: 'cute-futura', issuer: 'cute-futura' };
    return jwt.verify(token, process.env.JWT_SECRET, opts);
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
}

export async function logActivity(client, entityType, entityId, actionType, userId, changes = {}) {
  try {
    await client.query(
      `INSERT INTO activity_logs (entity_type, entity_id, action_type, user_id, changes) 
       VALUES ($1, $2, $3, $4, $5)`,
      [entityType, entityId, actionType, userId, JSON.stringify(changes)]
    );
  } catch (err) {
    console.error('Failed to log activity:', err);
  }
}
