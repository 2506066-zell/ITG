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
    const month = url.searchParams.get('month'); // YYYY-MM
    const user_id = url.searchParams.get('user'); // Zaldy or Nesya
    
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
      const { user_id, month, title } = b;
      if (!title || !month || !user_id) { res.status(400).json({ error: 'Invalid data' }); return; }
      
      const r = await pool.query(
        'INSERT INTO monthly_todos (user_id, month, title) VALUES ($1, $2, $3) RETURNING *',
        [user_id, month, title]
      );
      sendJson(res, 200, r.rows[0]);
      return;
    }

    if (action === 'toggle_log') {
      const { todo_id, date, completed } = b; // date is YYYY-MM-DD
      if (!todo_id || !date) { res.status(400).json({ error: 'Invalid data' }); return; }

      // Check if month is archived (optional constraint check here or frontend)
      // "Toggling archived month must be disabled" -> Backend check
      const todoRes = await pool.query('SELECT month FROM monthly_todos WHERE id = $1', [todo_id]);
      if (todoRes.rowCount === 0) { res.status(404).json({ error: 'Todo not found' }); return; }
      
      const todoMonth = todoRes.rows[0].month;
      const currentMonth = new Date().toISOString().slice(0, 7);
      
      // Allow current and future? Or strict current only?
      // "At month change: All previous month todos move to archived state... Read-only"
      if (todoMonth < currentMonth) {
        res.status(403).json({ error: 'Cannot modify archived month' });
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
    const currentMonth = new Date().toISOString().slice(0, 7);
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
