import 'dotenv/config';
const BASE = process.env.API_URL || 'http://localhost:3000/api';

async function login(username, password) {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${txt}`);
  return JSON.parse(txt).token;
}

async function call(path, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  console.log(`[GET ${path}] status=${res.status} type=${type}`);
  console.log(body.slice(0, 300));
}

async function main() {
  try {
    const token = await login('Zaldy', '123456');
    await call('/health', token);
    await call('/stats', token);
    await call('/schedule', token);
    await call('/chat', token);
  } catch (e) {
    console.error('Ping failed:', e);
    process.exitCode = 1;
  }
}

main();
