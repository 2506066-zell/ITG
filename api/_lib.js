import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not defined');
}
if (!global._pool) {
  global._pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
  global._pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
  });
}
export const pool = global._pool;
if (!global._pool_pinged) {
  global._pool_pinged = (async () => {
    try {
      await pool.query('SELECT 1');
    } catch (e) {
      console.error('DB ping failed', e);
    }
  })();
}

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

export function sendJson(res, status, data, cacheSeconds = 0) {
  if (cacheSeconds > 0) {
    res.setHeader('Cache-Control', `private, max-age=${cacheSeconds}`);
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.status(status).json(data);
}

export function withErrorHandling(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error' });
      }
    }
  };
}
