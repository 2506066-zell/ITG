import { pool, verifyToken, withErrorHandling, sendJson } from './_lib.js';

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n === 0) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  if (den === 0) return null;
  return Number((num / den).toFixed(3));
}

export default withErrorHandling(async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const v = verifyToken(req, res);
  if (!v) return;

  const users = ['Zaldy', 'Nesya'];
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    days.push(fmt(d));
  }

  const moodsRes = await pool.query(`
    SELECT user_id, date_trunc('day', created_at)::date AS day, AVG(mood)::float AS avg_mood
    FROM evaluations
    WHERE created_at >= NOW() - INTERVAL '7 days'
    GROUP BY user_id, day
  `);
  const tasksRes = await pool.query(`
    SELECT completed_by AS user_id, date_trunc('day', completed_at)::date AS day, COUNT(*)::int AS cnt
    FROM tasks
    WHERE completed = TRUE AND completed_at >= NOW() - INTERVAL '7 days' AND completed_by IS NOT NULL
    GROUP BY completed_by, day
  `);
  const monthlyRes = await pool.query(`
    SELECT mt.user_id, date_trunc('day', mtl.completed_at)::date AS day, COUNT(*)::int AS cnt
    FROM monthly_todo_logs mtl
    JOIN monthly_todos mt ON mt.id = mtl.monthly_todo_id
    WHERE mtl.completed = TRUE AND mtl.completed_at >= NOW() - INTERVAL '7 days'
    GROUP BY mt.user_id, day
  `);
  const assignmentsRes = await pool.query(`
    SELECT completed_by AS user_id, date_trunc('day', completed_at)::date AS day, COUNT(*)::int AS cnt
    FROM assignments
    WHERE completed = TRUE AND completed_at >= NOW() - INTERVAL '7 days' AND completed_by IS NOT NULL
    GROUP BY completed_by, day
  `);

  const moodMap = {};
  const actMap = {};
  const tasksTotals = {};
  const monthlyTotals = {};
  const assignmentsTotals = {};
  users.forEach(u => {
    moodMap[u] = {};
    actMap[u] = {};
    tasksTotals[u] = 0;
    monthlyTotals[u] = 0;
    assignmentsTotals[u] = 0;
  });
  moodsRes.rows.forEach(r => {
    const u = r.user_id;
    const d = r.day.toISOString().slice(0,10);
    if (!moodMap[u]) moodMap[u] = {};
    moodMap[u][d] = Number(r.avg_mood);
  });
  tasksRes.rows.forEach(r => {
    const u = r.user_id;
    const d = r.day.toISOString().slice(0,10);
    if (!actMap[u]) actMap[u] = {};
    actMap[u][d] = (actMap[u][d] || 0) + Number(r.cnt);
    tasksTotals[u] += Number(r.cnt);
  });
  monthlyRes.rows.forEach(r => {
    const u = r.user_id;
    const d = r.day.toISOString().slice(0,10);
    if (!actMap[u]) actMap[u] = {};
    actMap[u][d] = (actMap[u][d] || 0) + Number(r.cnt);
    monthlyTotals[u] += Number(r.cnt);
  });
  assignmentsRes.rows.forEach(r => {
    const u = r.user_id;
    const d = r.day.toISOString().slice(0,10);
    if (!actMap[u]) actMap[u] = {};
    actMap[u][d] = (actMap[u][d] || 0) + Number(r.cnt);
    assignmentsTotals[u] += Number(r.cnt);
  });

  const usersOut = {};
  users.forEach(u => {
    const perDay = days.map(d => {
      const mood = moodMap[u] && moodMap[u][d] !== undefined ? moodMap[u][d] : null;
      const activities = actMap[u] && actMap[u][d] !== undefined ? actMap[u][d] : 0;
      return { date: d, mood, activities };
    });
    const xs = perDay.filter(p => p.mood !== null).map(p => Number(p.mood));
    const ys = perDay.filter(p => p.mood !== null).map(p => Number(p.activities));
    const corr = pearson(xs, ys);
    const avgMood = xs.length ? Number((xs.reduce((a,b)=>a+b,0)/xs.length).toFixed(2)) : null;
    const totalActivities = perDay.reduce((a,b)=>a + Number(b.activities),0);
    usersOut[u] = { 
      per_day: perDay, 
      correlation: corr, 
      avg_mood: avgMood, 
      total_activities: totalActivities,
      totals: { tasks: tasksTotals[u], monthly: monthlyTotals[u], assignments: assignmentsTotals[u] }
    };
  });

  const combinedXs = days.flatMap(d => users.map(u => {
    const m = moodMap[u] && moodMap[u][d] !== undefined ? moodMap[u][d] : null;
    return m;
  })).filter(m => m !== null).map(Number);
  const combinedYs = days.flatMap(d => users.map(u => {
    const a = actMap[u] && actMap[u][d] !== undefined ? actMap[u][d] : 0;
    const m = moodMap[u] && moodMap[u][d] !== undefined ? moodMap[u][d] : null;
    return m !== null ? a : null;
  })).filter(a => a !== null).map(Number);
  const combinedCorr = pearson(combinedXs, combinedYs);

  sendJson(res, 200, { days, users: usersOut, combined: { correlation: combinedCorr } }, 10);
}) 
