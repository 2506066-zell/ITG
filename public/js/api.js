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
  const auth = options.headers && options.headers.Authorization;
  const userFromToken = auth && auth.startsWith('Bearer mock-jwt-') ? auth.replace('Bearer mock-jwt-','') : 'Zaldy';

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
        completed_at: null,
        user_id: userFromToken,
        completed_by: null
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
            completed_at: body.completed ? (i.completed_at || new Date().toISOString()) : null,
            completed_by: body.completed ? userFromToken : null
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
        created_at: new Date().toISOString(),
        user_id: userFromToken
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
  else if (path.startsWith('/weekly')) {
    const days = [];
    const now = new Date();
    for (let i = 6; i >= 0; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      days.push(d.toISOString().slice(0,10));
    }
    const users = ['Zaldy','Nesya'];
    const evals = db('evaluations', []);
    const monthlyFor = (month, user) => db(`monthly_${month}_${user}`, []);
    function avg(arr) { return arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length) : null; }
    function pearson(xs, ys) {
      const n = xs.length;
      if (!n) return null;
      let sx=0, sy=0, sxx=0, syy=0, sxy=0;
      for (let i=0;i<n;i++){ const x=xs[i], y=ys[i]; sx+=x; sy+=y; sxx+=x*x; syy+=y*y; sxy+=x*y; }
      const num = n*sxy - sx*sy;
      const den = Math.sqrt((n*sxx - sx*sx)*(n*syy - sy*sy));
      if (!den) return null;
      return Number((num/den).toFixed(3));
    }
    const usersOut = {};
    const assignments = db('assignments', []);
    users.forEach(u => {
      let totalTasks = 0;
      let totalMonthly = 0;
      let totalAssignments = 0;
      const perDay = days.map(d => {
        const ms = evals.filter(e => e.user_id === u && e.created_at.slice(0,10) === d).map(e => Number(e.mood));
        const mood = avg(ms);
        const actsAssignments = assignments.filter(a => a.completed_by === u && (a.completed_at || '').slice(0,10) === d).length;
        totalAssignments += actsAssignments;
        const mStr = d.slice(0,7);
        const todos = monthlyFor(mStr, u);
        const dayNum = parseInt(d.slice(8,10),10);
        const actsMonthly = todos.reduce((acc,t)=>acc + (Array.isArray(t.completed_days) && t.completed_days.includes(dayNum) ? 1 : 0), 0);
        totalMonthly += actsMonthly;
        const activities = ms.length + actsAssignments + actsMonthly;
        return { date: d, mood, activities };
      });
      const xs = perDay.filter(p => p.mood !== null).map(p => Number(p.mood));
      const ys = perDay.filter(p => p.mood !== null).map(p => Number(p.activities));
      const corr = pearson(xs, ys);
      const avgMood = xs.length ? Number((xs.reduce((a,b)=>a+b,0)/xs.length).toFixed(2)) : null;
      const totalActivities = perDay.reduce((a,b)=>a + Number(b.activities),0);
      usersOut[u] = { per_day: perDay, correlation: corr, avg_mood: avgMood, total_activities: totalActivities, totals: { tasks: totalTasks, monthly: totalMonthly, assignments: totalAssignments } };
    });
    const combinedXs = days.flatMap(d => users.map(u => {
      const ms = evals.filter(e => e.user_id === u && e.created_at.slice(0,10) === d).map(e => Number(e.mood));
      const m = avg(ms);
      return m;
    })).filter(m => m !== null).map(Number);
    const combinedYs = days.flatMap(d => users.map(u => {
      const cntEval = evals.filter(e => e.user_id === u && e.created_at.slice(0,10) === d).length;
      const cntAssignments = assignments.filter(a => a.completed_by === u && (a.completed_at || '').slice(0,10) === d).length;
      const mStr = d.slice(0,7);
      const todos = monthlyFor(mStr, u);
      const dayNum = parseInt(d.slice(8,10),10);
      const cntMonthly = todos.reduce((acc,t)=>acc + (Array.isArray(t.completed_days) && t.completed_days.includes(dayNum) ? 1 : 0), 0);
      const cnt = cntEval + cntAssignments;
      const ms = evals.filter(e => e.user_id === u && e.created_at.slice(0,10) === d).map(e => Number(e.mood));
      const m = avg(ms);
      return m !== null ? (cnt + cntMonthly) : null;
    })).filter(a => a !== null).map(Number);
    const combinedCorr = pearson(combinedXs, combinedYs);
    data = { days, users: usersOut, combined: { correlation: combinedCorr } };
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
  else if (path.startsWith('/monthly_stats')) {
    const qs = new URLSearchParams(path.split('?')[1] || '');
    const month = qs.get('month');
    const users = ['Zaldy', 'Nesya'];
    const stats = {};
    if (!month) {
      status = 400;
      data = { error: 'Missing month' };
    } else {
      const [y, m] = month.split('-');
      const daysInMonth = new Date(y, m, 0).getDate();
      users.forEach(u => {
        const key = `monthly_${month}_${u}`;
        const todos = db(key, []);
        const totalTodos = todos.length;
        const totalPossible = totalTodos * daysInMonth;
        const totalCompleted = todos.reduce((acc, t) => acc + (Array.isArray(t.completed_days) ? t.completed_days.length : 0), 0);
        let maxUserStreak = 0;
        todos.forEach(t => {
          const days = Array.isArray(t.completed_days) ? [...t.completed_days].sort((a,b)=>a-b) : [];
          let cur = 0, max = 0, prev = -1;
          days.forEach(d => {
            if (d === prev + 1) cur++; else cur = 1;
            if (cur > max) max = cur;
            prev = d;
          });
          if (max > maxUserStreak) maxUserStreak = max;
        });
        stats[u] = {
          completion_rate: totalPossible ? Math.round((totalCompleted / totalPossible) * 100) : 0,
          streak: maxUserStreak,
          total_completed: totalCompleted,
          total_possible: totalPossible
        };
      });
      const combined = Math.round((users.reduce((acc,u)=>acc + stats[u].completion_rate,0))/users.length);
      data = { users: stats, combined };
    }
  }
  else if (path.startsWith('/monthly')) {
    const qs = new URLSearchParams(path.split('?')[1] || '');
    const methodQSMonth = qs.get('month');
    const methodQSUser = qs.get('user');
    if (method === 'GET') {
      if (!methodQSMonth || !methodQSUser) {
        status = 400;
        data = { error: 'Missing month or user' };
      } else {
        const key = `monthly_${methodQSMonth}_${methodQSUser}`;
        const todos = db(key, []);
        data = todos.map(t => ({ id: t.id, title: t.title, completed_days: Array.isArray(t.completed_days) ? t.completed_days : [] }));
      }
    }
    if (method === 'POST') {
      const action = body.action;
      if (action === 'create_todo') {
        const { user_id, title } = body;
        const systemMonth = new Date().toISOString().slice(0,7);
        if (!title || !user_id) {
          status = 400;
          data = { error: 'Invalid data' };
        } else {
          const key = `monthly_${systemMonth}_${user_id}`;
          const todos = db(key, []);
          const newTodo = { id: Date.now(), title, completed_days: [] };
          todos.push(newTodo);
          save(key, todos);
          data = newTodo;
        }
      } else if (action === 'toggle_log') {
        const { todo_id, date, completed } = body;
        const month = (date || '').slice(0,7);
        const day = parseInt((date || '').slice(8,10), 10);
        const todayStr = new Date().toISOString().slice(0,10);
        const currentMonth = new Date().toISOString().slice(0,7);
        if (date !== todayStr || month !== currentMonth) {
          status = 403;
          data = { error: 'Only today in current month can be toggled' };
          return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
        }
        let affectedKey = null;
        const users = ['Zaldy','Nesya'];
        for (const u of users) {
          const key = `monthly_${month}_${u}`;
          const todos = db(key, []);
          const idx = todos.findIndex(t => t.id == todo_id);
          if (idx >= 0) {
            affectedKey = key;
            const cd = new Set(Array.isArray(todos[idx].completed_days) ? todos[idx].completed_days : []);
            if (completed) cd.add(day); else cd.delete(day);
            todos[idx].completed_days = Array.from(cd).sort((a,b)=>a-b);
            save(key, todos);
            data = { ok: true };
            break;
          }
        }
        if (!affectedKey) {
          status = 404;
          data = { error: 'Todo not found' };
        }
      } else {
        status = 400;
        data = { error: 'Unknown action' };
      }
    }
    if (method === 'DELETE') {
      const id = qs.get('id');
      if (!id) {
        status = 400;
        data = { error: 'Missing id' };
      } else {
        const users = ['Zaldy','Nesya'];
        let deleted = false;
        const currentMonth = new Date().toISOString().slice(0,7);
        users.forEach(u => {
          const keyPrefix = `monthly_`;
          const keys = [keyPrefix + currentMonth + '_' + u];
          keys.forEach(key => {
            let todos = db(key, []);
            const before = todos.length;
            todos = todos.filter(t => t.id != id);
            if (todos.length !== before) {
              save(key, todos);
              deleted = true;
            }
          });
        });
        data = deleted ? { ok: true } : { error: 'Not found' };
        status = deleted ? 200 : 404;
      }
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
    
    if (path !== '/login') handle401(res);
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
