import { pool, readBody, verifyToken, withErrorHandling, sendJson } from './_lib.js';

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  // const user = v.user; // We might use this for permission check, but prompt says "support 2 fixed users". 
  // We will allow viewing both users data, but maybe only editing own?
  // "The system must support 2 fixed users... Each user has their own monthly to-do list."
  // Assuming shared view, own edit.

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const list = url.searchParams.get('list'); // months
    const month = url.searchParams.get('month'); // YYYY-MM
    const user_id = url.searchParams.get('user'); // Zaldy or Nesya
    
    if (list === 'months') {
      const uid = url.searchParams.get('user');
      let monthsRes;
      if (uid) {
        monthsRes = await pool.query(
          'SELECT month FROM monthly_todos WHERE user_id = $1 GROUP BY month ORDER BY month DESC',
          [uid]
        );
      } else {
        monthsRes = await pool.query(
          'SELECT month FROM monthly_todos GROUP BY month ORDER BY month DESC'
        );
      }
      const months = monthsRes.rows.map(r => r.month);
      sendJson(res, 200, { months }, 60);
      return;
    }
    
    if (!month || !user_id) {
      res.status(400).json({ error: 'Missing month or user' });
      return;
    }

    // Get Todos
    const todosRes = await pool.query(
      'SELECT * FROM monthly_todos WHERE month = $1 AND user_id = $2 ORDER BY id ASC',
      [month, user_id]
    );
    const todos = todosRes.rows;

    if (todos.length === 0) {
      sendJson(res, 200, [], 30);
      return;
    }

    // Get Logs for these todos
    const todoIds = todos.map(t => t.id);
    const logsRes = await pool.query(
      'SELECT * FROM monthly_todo_logs WHERE monthly_todo_id = ANY($1)',
      [todoIds]
    );
    const logs = logsRes.rows;

    // Merge logs into todos
    const result = todos.map(t => {
      const myLogs = logs.filter(l => l.monthly_todo_id === t.id);
      // Transform logs to a map or array of completed days?
      // Array of days is easier for frontend.
      // Logs store full date. We just need day number (1-31).
      const completedDays = myLogs.filter(l => l.completed).map(l => {
        return new Date(l.date).getDate();
      });
      return { ...t, completed_days: completedDays };
    });

    sendJson(res, 200, result, 30);
    return;
  }

  if (req.method === 'POST') {
    // Action: create_todo OR toggle_log
    const b = req.body || await readBody(req);
    const { action } = b;

    if (action === 'create_todo') {
      const { user_id, title, month, tz_offset_min } = b;
      const now = new Date();
      const dLocal = typeof tz_offset_min === 'number'
        ? new Date(now.getTime() - (tz_offset_min * 60000))
        : now;
      const systemMonth = `${dLocal.getFullYear()}-${String(dLocal.getMonth() + 1).padStart(2, '0')}`;
      const validMonth = (typeof month === 'string' && /^\d{4}-\d{2}$/.test(month)) ? month : systemMonth;
      if (!title || !user_id) { res.status(400).json({ error: 'Invalid data' }); return; }
      
      const r = await pool.query(
        'INSERT INTO monthly_todos (user_id, month, title) VALUES ($1, $2, $3) RETURNING *',
        [user_id, validMonth, title]
      );
      sendJson(res, 200, r.rows[0]);
      return;
    }

    if (action === 'toggle_log') {
      const { todo_id, date, completed, tz_offset_min } = b; // date is YYYY-MM-DD
      if (!todo_id || !date) { res.status(400).json({ error: 'Invalid data' }); return; }

      // Check if month is archived (optional constraint check here or frontend)
      // "Toggling archived month must be disabled" -> Backend check
      const todoRes = await pool.query('SELECT month FROM monthly_todos WHERE id = $1', [todo_id]);
      if (todoRes.rowCount === 0) { res.status(404).json({ error: 'Todo not found' }); return; }
      
      const todoMonth = todoRes.rows[0].month;
      const now = new Date();
      const dLocal = typeof tz_offset_min === 'number'
        ? new Date(now.getTime() - (tz_offset_min * 60000))
        : now;
      const currentMonth = `${dLocal.getFullYear()}-${String(dLocal.getMonth() + 1).padStart(2, '0')}`;
      const todayStr = `${dLocal.getFullYear()}-${String(dLocal.getMonth() + 1).padStart(2, '0')}-${String(dLocal.getDate()).padStart(2, '0')}`;
      // Strict enforcement: only current month and today's date can be toggled
      if (todoMonth !== currentMonth) {
        res.status(403).json({ error: 'Only current month can be modified' });
        return;
      }
      if (date !== todayStr) {
        res.status(403).json({ error: 'Only today can be toggled' });
        return;
      }
      
      // Upsert Log
      const r = await pool.query(
        `INSERT INTO monthly_todo_logs (monthly_todo_id, date, completed, completed_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (monthly_todo_id, date)
         DO UPDATE SET completed = $3, completed_at = NOW()
         RETURNING *`,
        [todo_id, date, completed]
      );
      sendJson(res, 200, r.rows[0]);
      return;
    }
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id');
    if (!id) { res.status(400).json({ error: 'Missing id' }); return; }

    const check = await pool.query('SELECT month FROM monthly_todos WHERE id = $1', [id]);
    if (check.rowCount === 0) { res.status(404).json({ error: 'Not found' }); return; }
    
    const todoMonth = check.rows[0].month;
    const d = new Date();
    const currentMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (todoMonth < currentMonth) {
        res.status(403).json({ error: 'Cannot delete archived todos' });
        return;
    }

    await pool.query('DELETE FROM monthly_todos WHERE id = $1', [id]);
    sendJson(res, 200, { success: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
})
