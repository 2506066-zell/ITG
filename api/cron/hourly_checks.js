import { pool, withErrorHandling, sendJson } from '../../api/_lib.js';
import { sendNotificationToUser } from '../../api/notifications.js';

export default withErrorHandling(async function handler(req, res) {
  const client = await pool.connect();
  const results = { urgent: 0, progress: 0 };

  try {
    // Ensure snooze table exists to prevent query errors
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_snoozes (
        task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        snooze_until TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // 1. URGENT ACTION (Deadline < 1 Jam)
    // Cek tugas yang deadline-nya dalam 1 jam ke depan dan belum selesai.
    // Exclude snoozed tasks
    const urgentRes = await client.query(`
      SELECT t.id, t.title, t.deadline, t.assigned_to
      FROM tasks t
      LEFT JOIN task_snoozes s ON t.id = s.task_id
      WHERE t.completed = FALSE
        AND t.deadline > NOW()
        AND t.deadline <= NOW() + INTERVAL '1 hour'
        AND t.assigned_to IS NOT NULL
        AND t.is_deleted = FALSE
        AND (s.snooze_until IS NULL OR s.snooze_until < NOW())
    `);

    for (const task of urgentRes.rows) {
      const msg = `🚨 CRITICAL: "${task.title}" deadline < 1 jam lagi! Segera selesaikan!`;
      await sendNotificationToUser(task.assigned_to, {
        title: 'Urgent Action ⚡',
        body: msg,
        data: { url: '/daily-tasks', taskId: task.id },
        actions: [
            { action: 'complete-task', title: '✅ Selesai Sekarang' }
        ]
      });
      results.urgent++;
    }

    // 1b. ASSIGNMENT URGENT (Deadline < 1 Jam)
    const assignUrgent = await client.query(`
      SELECT id, title, deadline, assigned_to
      FROM assignments
      WHERE completed = FALSE
        AND deadline > NOW()
        AND deadline <= NOW() + INTERVAL '1 hour'
        AND assigned_to IS NOT NULL
    `);

    for (const task of assignUrgent.rows) {
      const msg = `🎓 URGENT: "${task.title}" deadline < 1 jam! Submit sekarang!`;
      await sendNotificationToUser(task.assigned_to, {
        title: 'Assignment Critical 🚨',
        body: msg,
        data: { url: '/college-assignments' }
      });
      results.urgent++;
    }

    // 2. TASK DEPENDENCY (Progress Check untuk Tugas Besar)
    // Cek tugas High Priority, durasi > 3 hari, dan sudah lewat 50% waktu.
    // Asumsi: created_at ada. Jika tidak, skip.
    const progressRes = await client.query(`
      SELECT t.id, t.title, t.assigned_to
      FROM tasks t
      LEFT JOIN task_snoozes s ON t.id = s.task_id
      WHERE t.completed = FALSE
        AND t.priority = 'high'
        AND t.deadline > NOW() + INTERVAL '1 day'
        AND t.created_at < NOW() - (t.deadline - t.created_at) / 2
        AND t.assigned_to IS NOT NULL
        AND t.is_deleted = FALSE
        -- Hindari spam: Cek log aktivitas atau flag khusus (disimplifikasi: random check kecil untuk demo)
        AND EXTRACT(HOUR FROM NOW()) = 14 -- Cek hanya jam 14:00 siang
        AND (s.snooze_until IS NULL OR s.snooze_until < NOW())
    `);

    for (const task of progressRes.rows) {
      const msg = `🚀 Progress Check: Gimana kabar tugas "${task.title}"? Jangan lupa dicicil ya!`;
      await sendNotificationToUser(task.assigned_to, {
        title: 'Keep Going! 💪',
        body: msg,
        data: { url: '/daily-tasks', taskId: task.id },
        actions: [
            { action: 'snooze', title: '👀 Nanti Aja' }
        ]
      });
      results.progress++;
    }

    sendJson(res, 200, { 
      message: 'Hourly checks completed', 
      stats: results 
    });

  } finally {
    client.release();
  }
});
