const url = process.argv[2] || 'http://localhost:3000/api/login';
async function main() {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Nesya', password: '123456' })
  }).catch(err => ({ ok: false, status: 0, error: err.message }));
  if (!res || !res.ok) {
    console.error('Login failed', res && res.status);
    process.exit(1);
  }
  const json = await res.json();
  console.log(JSON.stringify(json));
}
main();
