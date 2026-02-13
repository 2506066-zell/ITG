import { parse } from 'url';

const cache = new Map();
async function load(name) {
  if (cache.has(name)) return cache.get(name);
  const mod = await import(`../cute-futura/api/${name}.js`);
  const fn = mod.default || mod.handler || mod;
  cache.set(name, fn);
  return fn;
}

const routes = new Set([
  'login',
  'tasks',
  'memories',
  'assignments',
  'anniversary',
  'goals',
  'activity',
  'stats',
  'schedule',
  'chat',
  'monthly',
  'monthly_stats',
  'health'
]);

export default async function handler(req, res) {
  try {
    const u = parse(req.url, true);
    let p = (u.query.path || '').toString().trim();
    p = p.replace(/^\/+|\/+$/g, '');
    const seg = p.split('/')[0];
    if (!seg || !routes.has(seg)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }
    const fn = await load(seg);
    await fn(req, res);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal Server Error', details: err.message }));
  }
}
