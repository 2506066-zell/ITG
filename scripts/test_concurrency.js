import fetch from 'node-fetch';

const BASE_URL = process.env.API_URL || 'http://localhost:3000/api';

async function login(username, password) {
  const res = await fetch(`${BASE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}

async function run() {
  try {
    console.log('--- Concurrency Test Start ---');
    
    // 1. Login
    console.log('Logging in Zaldy...');
    const tokenZ = await login('Zaldy', '123456'); // Use default password
    console.log('Logging in Nesya...');
    const tokenN = await login('Nesya', '123456');
    
    // 2. Setup: Create a task
    console.log('Creating shared task...');
    const createRes = await fetch(`${BASE_URL}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenZ}` },
      body: JSON.stringify({ title: 'Shared Task ' + Date.now() })
    });
    const task = await createRes.json();
    console.log('Task created:', task.id, 'Version:', task.version);

    // 3. Simulate Concurrent Read
    console.log('Zaldy reads task...');
    // In real app, we would GET /tasks and find it. Here we use the task object we just got, 
    // but let's fetch it to be sure we have latest version
    const getZ = await fetch(`${BASE_URL}/tasks`, { headers: { 'Authorization': `Bearer ${tokenZ}` } });
    const tasksZ = await getZ.json();
    const taskZ = tasksZ.find(t => t.id === task.id);
    
    console.log('Nesya reads task...');
    const getN = await fetch(`${BASE_URL}/tasks`, { headers: { 'Authorization': `Bearer ${tokenN}` } });
    const tasksN = await getN.json();
    const taskN = tasksN.find(t => t.id === task.id);
    
    console.log(`Zaldy has version ${taskZ.version}, Nesya has version ${taskN.version}`);

    // 4. Zaldy updates
    console.log('Zaldy updates task (Completing it)...');
    const updateZ = await fetch(`${BASE_URL}/tasks`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenZ}` },
      body: JSON.stringify({ id: task.id, completed: true, version: taskZ.version })
    });
    
    if (updateZ.ok) {
        console.log('Zaldy update success:', await updateZ.json());
    } else {
        console.error('Zaldy update failed:', await updateZ.text());
    }

    // 5. Nesya tries to update (using OLD version)
    console.log('Nesya tries to update (Changing title)...');
    const updateN = await fetch(`${BASE_URL}/tasks`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenN}` },
      body: JSON.stringify({ id: task.id, title: 'Nesya Title', version: taskN.version })
    });

    if (updateN.status === 409) {
        console.log('SUCCESS: Nesya update blocked with 409 Conflict.');
        const err = await updateN.json();
        console.log('Error message:', err.error);
    } else {
        console.error('FAILURE: Nesya update should have failed, but got:', updateN.status);
    }

    // 6. Nesya re-reads and updates
    console.log('Nesya re-reads task...');
    const getN2 = await fetch(`${BASE_URL}/tasks`, { headers: { 'Authorization': `Bearer ${tokenN}` } });
    const tasksN2 = await getN2.json();
    const taskN2 = tasksN2.find(t => t.id === task.id);
    console.log('Nesya new version:', taskN2.version);
    
    console.log('Nesya updates again...');
    const updateN2 = await fetch(`${BASE_URL}/tasks`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenN}` },
      body: JSON.stringify({ id: task.id, title: 'Nesya Title', version: taskN2.version })
    });
    
    if (updateN2.ok) {
        console.log('Nesya update success:', await updateN2.json());
    } else {
        console.error('Nesya update failed:', await updateN2.text());
    }

    console.log('--- Concurrency Test Complete ---');

  } catch (err) {
    console.error('Test failed:', err);
  }
}

run();
