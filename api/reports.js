
import { pool, verifyToken, withErrorHandling, sendJson } from './_lib.js';

export default withErrorHandling(async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const v = verifyToken(req, res);
  if (!v) return;
  const user = v.user;

  const url = new URL(req.url, `http://${req.headers.host}`);
  const type = url.searchParams.get('type') || 'weekly'; // weekly, monthly
  const dateStr = url.searchParams.get('date'); // Optional reference date

  let start, end, prevStart, prevEnd;
  const now = dateStr ? new Date(dateStr) : new Date();

  if (type === 'monthly') {
    // Current Month
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    
    // Previous Month
    prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    prevEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  } else {
    // Weekly (Monday to Sunday)
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
    start = new Date(now.setDate(diff));
    start.setHours(0, 0, 0, 0);
    
    end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);

    prevStart = new Date(start);
    prevStart.setDate(start.getDate() - 7);
    
    prevEnd = new Date(end);
    prevEnd.setDate(end.getDate() - 7);
  }

  // 1. Productivity (Tasks Completed)
  const getTaskStats = async (s, e) => {
    const res = await pool.query(`
      SELECT COUNT(*) as count 
      FROM tasks 
      WHERE completed = TRUE 
      AND is_deleted = FALSE
      AND completed_by = $1
      AND completed_at >= $2 AND completed_at <= $3
    `, [user, s.toISOString(), e.toISOString()]);
    return parseInt(res.rows[0].count);
  };

  const currentTasks = await getTaskStats(start, end);
  const prevTasks = await getTaskStats(prevStart, prevEnd);

  // 2. Consistency (Habits / Monthly Todos Logs)
  // We count total logs in the period
  const getHabitStats = async (s, e) => {
    const res = await pool.query(`
      SELECT COUNT(*) as count 
      FROM monthly_todo_logs l
      JOIN monthly_todos t ON l.monthly_todo_id = t.id
      WHERE t.user_id = $1
      AND l.date >= $2 AND l.date <= $3
      AND l.completed = TRUE
    `, [user, s.toISOString().split('T')[0], e.toISOString().split('T')[0]]);
    return parseInt(res.rows[0].count);
  };

  const currentHabits = await getHabitStats(start, end);
  const prevHabits = await getHabitStats(prevStart, prevEnd);

  // 3. Mood (Evaluations)
  const getMoodStats = async (s, e) => {
    const res = await pool.query(`
      SELECT mood, tags
      FROM evaluations
      WHERE user_id = $1
      AND created_at >= $2 AND created_at <= $3
      AND is_deleted = FALSE
    `, [user, s.toISOString(), e.toISOString()]);
    
    if (res.rowCount === 0) return { avg: 0, topTags: [] };

    const rows = res.rows;
    const totalMood = rows.reduce((acc, r) => acc + r.mood, 0);
    const avg = totalMood / rows.length;
    
    // Process tags
    const tagCounts = {};
    rows.forEach(r => {
      if (Array.isArray(r.tags)) {
        r.tags.forEach(tag => {
          if (tag) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        });
      }
    });

    const topTags = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(e => e[0]);

    return { avg, topTags };
  };

  const currentMood = await getMoodStats(start, end);
  const prevMood = await getMoodStats(prevStart, prevEnd);

  // Calculate Changes
  const calcChange = (curr, prev) => {
    if (prev === 0) return curr > 0 ? 100 : 0;
    return Math.round(((curr - prev) / prev) * 100);
  };

  const response = {
    period: {
      type,
      start: start.toISOString(),
      end: end.toISOString()
    },
    productivity: {
      current: currentTasks,
      previous: prevTasks,
      change: calcChange(currentTasks, prevTasks),
      trend: currentTasks >= prevTasks ? 'up' : 'down'
    },
    consistency: {
      current: currentHabits,
      previous: prevHabits,
      change: calcChange(currentHabits, prevHabits),
      trend: currentHabits >= prevHabits ? 'up' : 'down'
    },
    mood: {
      current: parseFloat(currentMood.avg.toFixed(1)),
      previous: parseFloat(prevMood.avg.toFixed(1)),
      change: parseFloat((currentMood.avg - prevMood.avg).toFixed(1)),
      trend: currentMood.avg >= prevMood.avg ? 'up' : 'down',
      top_tags: currentMood.topTags
    }
  };

  sendJson(res, 200, response);
});
