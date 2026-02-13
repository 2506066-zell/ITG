const base = '/api';
const getToken = () => localStorage.getItem('token') || '';
const authHeader = () => {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};
const handle401 = (res) => {
  if (res.status === 401) {
    localStorage.removeItem('token');
    location.href = '/login.html';
  }
};

// --- Mock Logic Start ---
let isMock = false;
async function mockFetch(path, options) {
  if (!isMock) {
    console.warn('Backend unreachable. Switching to Demo Mode (Mock API).');
    isMock = true;
    document.dispatchEvent(new CustomEvent('demo-mode-active'));
  }
  await new Promise(r => setTimeout(r, 400)); // Simulate latency
  
  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : {};
  const url = path.replace('/api', '') || path; // Handle with or without /api prefix if needed (here path is relative to /api in apiFetch)

  // Helpers for LocalStorage Mock DB
  const db = (key, def) => {
    const s = localStorage.getItem('mock_' + key);
    return s ? JSON.parse(s) : def;
  };
  const save = (key, data) => localStorage.setItem('mock_' + key, JSON.stringify(data));
  
  let data = null;
  let status = 200;

  // Routes
  if (path === '/login' && method === 'POST') {
    // Validate User
    const validUsers = ['Zaldy', 'Nesya'];
    if (validUsers.includes(body.username)) {
      data = { token: 'mock-jwt-' + body.username, user: body.username };
    } else {
      status = 401;
      data = { error: 'Invalid user' };
    }
  }
  else if (path.startsWith('/tasks')) {
    let tasks = db('tasks', [{ id: 1, title: 'Cobain Demo Mode', completed: false }]);
    if (method === 'GET') data = tasks;
    if (method === 'POST') {
      const newTask = { id: Date.now(), title: body.title, completed: false };
      tasks.push(newTask);
      save('tasks', tasks);
      data = newTask;
    }
    if (method === 'PUT') {
      tasks = tasks.map(t => t.id == body.id ? { ...t, completed: body.completed } : t);
      save('tasks', tasks);
      data = { ok: true };
    }
    if (method === 'DELETE') {
      const id = new URLSearchParams(path.split('?')[1]).get('id');
      tasks = tasks.filter(t => t.id != id);
      save('tasks', tasks);
      data = { ok: true };
    }
  }
  else if (path.startsWith('/assignments')) {
    let list = db('assignments', []);
    if (method === 'GET') data = list;
    if (method === 'POST') {
      const item = { 
        id: Date.now(), 
        title: body.title, 
        description: body.description || '', 
        deadline: body.deadline, 
        completed: false,
        completed_at: null
      };
      list.push(item);
      save('assignments', list);
      data = item;
    }
    if (method === 'PUT') {
      list = list.map(i => {
        if (i.id == body.id) {
          return { 
            ...i, 
            completed: body.completed,
            completed_at: body.completed ? (i.completed_at || new Date().toISOString()) : null
          };
        }
        return i;
      });
      save('assignments', list);
      data = { ok: true };
    }
    if (method === 'DELETE') {
      const id = new URLSearchParams(path.split('?')[1]).get('id');
      list = list.filter(i => i.id != id);
      save('assignments', list);
      data = { ok: true };
    }
  }
  else if (path.startsWith('/memories')) {
    let mems = db('memories', []);
    if (method === 'GET') data = mems;
    if (method === 'POST') {
      const m = { id: Date.now(), ...body, created_at: new Date().toISOString() };
      mems.push(m);
      save('memories', mems);
      data = m;
    }
    if (method === 'PUT') {
      mems = mems.map(m => m.id == body.id ? { ...m, ...body } : m);
      save('memories', mems);
      data = { ok: true };
    }
    if (method === 'DELETE') {
      const id = new URLSearchParams(path.split('?')[1]).get('id');
      mems = mems.filter(m => m.id != id);
      save('memories', mems);
      data = { ok: true };
    }
  }
  else if (path === '/anniversary') {
    let anniv = db('anniversary', { date: '', note: '' });
    if (method === 'GET') data = anniv;
    if (method === 'PUT') {
      save('anniversary', body);
      data = body;
    }
  }
  else if (path.startsWith('/goals')) {
    let goals = db('goals', []);
    if (method === 'GET') data = goals;
    if (method === 'POST') {
      const g = { 
        id: Date.now(), 
        title: body.title, 
        deadline: body.deadline, 
        progress: 0, 
        category: body.category || 'Personal',
        completed: false
      };
      goals.push(g);
      save('goals', goals);
      data = g;
    }
    if (method === 'PUT') {
      goals = goals.map(g => g.id == body.id ? { ...g, ...body } : g);
      save('goals', goals);
      data = { ok: true };
    }
    if (method === 'DELETE') {
      const id = new URLSearchParams(path.split('?')[1]).get('id');
      goals = goals.filter(g => g.id != id);
      save('goals', goals);
      data = { ok: true };
    }
  }
  else if (path.startsWith('/evaluations')) {
    let evals = db('evaluations', []);
    if (method === 'GET') data = evals;
    if (method === 'POST') {
      const e = { 
        id: Date.now(), 
        date: body.date, 
        mood: body.mood, 
        note: body.note,
        created_at: new Date().toISOString()
      };
      evals.push(e);
      save('evaluations', evals);
      data = e;
    }
    if (method === 'DELETE') {
      const id = new URLSearchParams(path.split('?')[1]).get('id');
      evals = evals.filter(e => e.id != id);
      save('evaluations', evals);
      data = { ok: true };
    }
  }
  else if (path.startsWith('/schedule')) {
    let schedule = db('schedule', []);
    if (method === 'GET') data = schedule;
    if (method === 'POST') {
      const s = { 
        id: Date.now(), 
        day: body.day, // 1 (Mon) - 7 (Sun)
        start: body.start, 
        end: body.end, 
        subject: body.subject, 
        room: body.room,
        lecturer: body.lecturer
      };
      schedule.push(s);
      save('schedule', schedule);
      data = s;
    }
    if (method === 'DELETE') {
      const id = new URLSearchParams(path.split('?')[1]).get('id');
      schedule = schedule.filter(s => s.id != id);
      save('schedule', schedule);
      data = { ok: true };
    }
  }
  else {
    status = 404;
    data = { error: 'Not Found (Mock)' };
  }

  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
// --- Mock Logic End ---

export async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...authHeader(), ...(options.headers || {}) };
  
  // OPTIMIZATION: Use AbortController to timeout slow requests
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

  try {
    const res = await fetch(`${base}${path}`, { 
      ...options, 
      headers,
      signal: controller.signal 
    });
    clearTimeout(timeoutId);

    // Live Server returns 405 Method Not Allowed for POST requests to static files/paths
    // It also returns 404 HTML pages for missing routes
    const type = res.headers.get('content-type');
    const isHtml = type && type.includes('text/html');
    
    // Fail if: 404, 405 (Method Not Allowed), or HTML response (implies route missing/static server)
    if ((res.status === 404 || res.status === 405) || isHtml) {
       // Specifically throw to trigger catch block for Mock
       throw new Error(`Backend unreachable: ${res.status}`);
    }
    
    handle401(res);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    // Fallback to Mock
    console.log('Fetch failed/timeout, using mock:', err.message);
    return mockFetch(path, options);
  }
}

export async function get(path) {
  const res = await apiFetch(path, { method: 'GET' });
  return res.json();
}
export async function post(path, body) {
  const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}
export async function put(path, body) {
  const res = await apiFetch(path, { method: 'PUT', body: JSON.stringify(body) });
  return res.json();
}
export async function del(path) {
  const res = await apiFetch(path, { method: 'DELETE' });
  return res.json();
}
