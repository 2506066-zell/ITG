const base = process.argv[2] || 'http://localhost:3002';
async function login() {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Nesya' })
  });
  const json = await res.json();
  return json.token;
}
async function main() {
  const token = await login();
  const res = await fetch(`${base}/api/assignments`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  console.log('Status:', res.status);
  console.log(text);
}
main();
