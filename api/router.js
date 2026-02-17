

const cache = new Map();
async function load(name) {
  if (cache.has(name)) return cache.get(name);
  const mod = await import(`./${name}.js`);
  const fn = mod.default || mod.handler || mod;
  cache.set(name, fn);
  return fn;
}

const routes = new Set([
  'login',
  'assistant',
  'tasks',
  'memories',
  'assignments',
  'anniversary',
  'goals',
  'activity',
  'stats',
  'schedule',
  'chat',
  'weekly',
  'monthly',
  'monthly_stats',
  'health',
  'evaluations',
  'notifications',
  'reports'
]);

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    let p = (u.searchParams.get('path') || '').toString().trim();
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
    console.error('Router error:', err);
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
}
