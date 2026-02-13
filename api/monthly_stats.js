import { pool, verifyToken, withErrorHandling, sendJson } from './_lib.js';

export default withErrorHandling(async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const v = verifyToken(req, res);
  if (!v) return;

  const url = new URL(req.url, 'http://x');
  const month = url.searchParams.get('month'); // YYYY-MM
  if (!month) { res.status(400).json({ error: 'Missing month' }); return; }

  // Get all users? Or just fixed two.
  const users = ['Zaldy', 'Nesya'];
  const stats = {};

  // Days in month
  const [y, m] = month.split('-');
  const daysInMonth = new Date(y, m, 0).getDate();

  for (const user of users) {
    const todosRes = await pool.query(
      'SELECT id FROM monthly_todos WHERE month = $1 AND user_id = $2',
      [month, user]
    );
    const todoIds = todosRes.rows.map(t => t.id);
    const totalTodos = todoIds.length;
    
    if (totalTodos === 0) {
      stats[user] = { completion_rate: 0, streak: 0, total_completed: 0, total_possible: 0 };
      continue;
    }

    const totalPossible = totalTodos * daysInMonth;

    // Get logs
    const logsRes = await pool.query(
      'SELECT date FROM monthly_todo_logs WHERE monthly_todo_id = ANY($1) AND completed = TRUE',
      [todoIds]
    );
    const totalCompleted = logsRes.rowCount;
    
    // Calculate Streak (Longest consecutive days where AT LEAST ONE task was done? Or ALL tasks?)
    // Usually habit tracker streak is per task.
    // Prompt says "Longest streak" per user. Maybe "Longest streak across all tasks"?
    // "Most consistent task" is separate.
    // Let's interpret "Longest Streak" as: Max consecutive days where user completed ALL their tasks? Or ANY?
    // Habit apps usually track streak per habit.
    // But here it's User Summary. 
    // Let's assume: Longest chain of days where user checked off *something*? 
    // Or maybe sum of streaks of all tasks?
    // Let's go with "Global Streak": Consecutive days with at least 1 completion? 
    // Or simpler: Just aggregate max streak of any single task.
    // Let's calc streak per task and find max.
    
    // Better metric: Daily Consistency. 
    // Let's just count total completed.
    
    // Longest Streak Calculation (Per task max)
    // We need logs grouped by todo_id
    const logsByTask = {}; // { todo_id: [dates...] }
    logsRes.rows.forEach(r => {
        // We need todo_id here.
        // Wait, query above only selected date.
    });
    
    // Re-query with todo_id
    const logsFullRes = await pool.query(
      'SELECT monthly_todo_id, date FROM monthly_todo_logs WHERE monthly_todo_id = ANY($1) AND completed = TRUE ORDER BY date ASC',
      [todoIds]
    );
    
    let maxUserStreak = 0;
    
    const taskLogs = {};
    logsFullRes.rows.forEach(r => {
        if (!taskLogs[r.monthly_todo_id]) taskLogs[r.monthly_todo_id] = [];
        taskLogs[r.monthly_todo_id].push(new Date(r.date).getDate());
    });
    
    // Calc max streak for this user across all tasks
    Object.values(taskLogs).forEach(days => {
        // days is sorted asc? DB sort order by date.
        // days are 1..31
        // Calc streak
        let current = 0;
        let max = 0;
        let prev = -1;
        
        // Ensure sorted
        days.sort((a,b) => a-b);
        
        days.forEach(d => {
            if (d === prev + 1) {
                current++;
            } else {
                current = 1;
            }
            if (current > max) max = current;
            prev = d;
        });
        if (max > maxUserStreak) maxUserStreak = max;
    });

    stats[user] = {
      completion_rate: Math.round((totalCompleted / totalPossible) * 100) || 0,
      streak: maxUserStreak,
      total_completed: totalCompleted,
      total_possible: totalPossible
    };
  }
  
  // Combined
  const combinedRate = Math.round(
    (Object.values(stats).reduce((acc, s) => acc + s.completion_rate, 0)) / users.length
  );

  sendJson(res, 200, { users: stats, combined: combinedRate }, 60);
})
