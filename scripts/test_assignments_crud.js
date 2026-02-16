const base = process.argv[2] || 'http://localhost:3001';

async function login() {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Nesya' })
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const json = await res.json();
  return json.token;
}

async function main() {
  try {
    const token = await login();
    const auth = { Authorization: `Bearer ${token}` };
    let res = await fetch(`${base}/api/assignments`, { headers: auth });
    console.log('GET status:', res.status);
    const getText = await res.text();
    console.log('GET body:', getText.slice(0, 400));
    let list;
    try { list = JSON.parse(getText); } catch { list = []; }
    console.log('GET count:', Array.isArray(list) ? list.length : 'n/a');
    res = await fetch(`${base}/api/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ title: 'Test From Agent', description: 'CRUD test', deadline: new Date().toISOString() })
    });
    if (!res.ok) throw new Error(`POST failed: ${res.status}`);
    const created = await res.json();
    console.log('POST id:', created.id);
    res = await fetch(`${base}/api/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ action: 'toggle', id: created.id, completed: true })
    });
    console.log('TOGGLE status:', res.status);
    const updated = await res.json();
    console.log('TOGGLE completed:', updated.completed, 'completed_by:', updated.completed_by);
    res = await fetch(`${base}/api/assignments?id=${created.id}`, {
      method: 'DELETE',
      headers: auth
    });
    console.log('DELETE status:', res.status);
    const del = await res.json();
    console.log('DELETE ok:', del.ok === true);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}
main();
