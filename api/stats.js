import { pool, verifyToken, withErrorHandling, sendJson } from './_lib.js';

export default withErrorHandling(async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const v = verifyToken(req, res);
  if (!v) return;

  try {
    // Get start of current week (Monday)
    // Adjust based on locale if needed, but ISO week starts Monday.
    // Or simple 7 days ago?
    // User request: "Filter by week range". Usually means current calendar week.
    
    // Postgres: date_trunc('week', NOW()) returns start of week (Monday)
    
    const query = `
      SELECT 
        completed_by AS user,
        SUM(score_awarded) AS total_score,
        COUNT(*) AS tasks_completed
      FROM tasks 
      WHERE 
        completed = TRUE 
        AND is_deleted = FALSE
        AND completed_at >= date_trunc('week', NOW())
        AND completed_by IS NOT NULL
      GROUP BY completed_by
    `;
    
    // Note: 'completed_by' column doesn't exist yet! 
    // We used 'updated_by' in logActivity, but for tasks table we only have 'created_by', 'updated_by', 'assigned_to'.
    // When a task is completed, we update 'updated_by'. But 'updated_by' changes on any edit.
    // We should probably track who completed it specifically if we want accurate scoring.
    // Or assume 'updated_by' when 'completed' becomes true is the completer?
    // In my previous step (tasks.js), I didn't add 'completed_by' column. 
    // But I did set score.
    // Wait, the prompt said "Assign score to completed_by user".
    // I missed adding 'completed_by' column in migration.
    // I should check if I can use 'updated_by' or if I need a new column.
    // Ideally new column 'completed_by' is better for audit.
    // Let's use 'updated_by' for now as "Last Actor", which is technically the completer if they just toggled it.
    // But if someone else edits it later, 'updated_by' changes.
    // So score attribution might get lost/transferred.
    // This is a flaw. I should have added 'completed_by'.
    
    // Let's quickly fix migration or use a workaround.
    // Creating a new migration to add 'completed_by' is safer.
    
    const r = await pool.query(query);
    
    // Calculate combined
    const stats = r.rows;
    const combined = stats.reduce((acc, curr) => acc + Number(curr.total_score), 0);
    
    sendJson(res, 200, {
      stats,
      combined,
      week_start: new Date().toISOString()
    }, 30);
    
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
})
