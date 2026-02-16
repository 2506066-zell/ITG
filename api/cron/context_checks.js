import { pool, withErrorHandling, sendJson } from '../../api/_lib.js';
import { sendNotificationToUser } from '../../api/notifications.js';

export default withErrorHandling(async function handler(req, res) {
  const client = await pool.connect();
  const results = { deadline: 0, burnout: 0, schedule: 0, habit: 0 };
  const now = new Date();
  const utcHour = now.getUTCHours(); // 0-23

  try {
    // 1. DEADLINE REMINDER (H-1) & BURNOUT ALERT
    // Run only in Morning (e.g. < 10 UTC, which is < 17 WIB. Cron is 02:00 UTC = 09:00 WIB)
    if (utcHour < 10) {
        // ... (Existing Deadline & Burnout Logic) ...
        // Cari tugas yang deadline-nya besok (antara 24-48 jam dari sekarang)
        // dan belum selesai.
        const deadlineRes = await client.query(`
          SELECT t.id, t.title, t.deadline, t.assigned_to
          FROM tasks t
          WHERE t.completed = FALSE
            AND t.deadline >= NOW() + INTERVAL '1 day'
            AND t.deadline < NOW() + INTERVAL '2 days'
            AND t.assigned_to IS NOT NULL
            AND t.is_deleted = FALSE
        `);

        for (const task of deadlineRes.rows) {
          const msg = `📅 Reminder: "${task.title}" deadline besok! Semangat kerjainnya ya!`;
          await sendNotificationToUser(task.assigned_to, {
            title: 'Deadline Alert ⏳',
            body: msg,
            data: { url: '/daily-tasks', taskId: task.id },
            actions: [
                { action: 'complete-task', title: '✅ Selesai' },
                { action: 'snooze', title: '💤 Ingatkan Nanti' }
            ]
          });
          results.deadline++;
        }

        // 1b. ASSIGNMENT DEADLINE REMINDER (H-1)
        const assignRes = await client.query(`
          SELECT id, title, deadline, assigned_to
          FROM assignments
          WHERE completed = FALSE
            AND deadline >= NOW() + INTERVAL '1 day'
            AND deadline < NOW() + INTERVAL '2 days'
            AND assigned_to IS NOT NULL
        `);

        for (const task of assignRes.rows) {
          const msg = `📚 College Reminder: "${task.title}" deadline besok! Jangan lupa submit!`;
          await sendNotificationToUser(task.assigned_to, {
            title: 'Assignment Deadline 🎓',
            body: msg,
            data: { url: '/college-assignments' }
          });
          results.deadline++;
        }

        // 2. BURNOUT ALERT (Context-Aware)
        // Cek mood rata-rata 3 hari terakhir per user.
        // Jika rata-rata < 2.5 (Bad), kirim notifikasi ke pasangan untuk menyemangati.
        const moodRes = await client.query(`
          SELECT user_id, AVG(mood)::float as avg_mood
          FROM evaluations
          WHERE created_at >= NOW() - INTERVAL '3 days'
          GROUP BY user_id
          HAVING AVG(mood) < 2.5
        `);

        for (const m of moodRes.rows) {
          const sadUser = m.user_id;
          // Tentukan pasangan (hardcoded logic sementara, bisa dibuat dinamis di DB)
          const partner = sadUser === 'Zaldy' ? 'Nesya' : (sadUser === 'Nesya' ? 'Zaldy' : null);
          
          if (partner) {
            const msg = `Sepertinya ${sadUser} lagi capek akhir-akhir ini (Mood: ${Number(m.avg_mood).toFixed(1)}). Coba kirim semangat! ❤️`;
            await sendNotificationToUser(partner, {
              title: 'Burnout Alert 🚨',
              body: msg,
              url: '/chat'
            });
            results.burnout++;
          }
        }

        // 3. SCHEDULE REMINDER (Morning Brief) & GAP FILLING
        // Runs every morning. Checks 'schedule' table for today's classes.
        const today = new Date();
        const dayId = today.getDay() === 0 ? 7 : today.getDay(); // 1=Mon, 7=Sun
        
        const schedRes = await client.query(`
            SELECT subject, time_start, time_end, room
            FROM schedule
            WHERE day_id = $1
            ORDER BY time_start ASC
        `, [dayId]);

        if (schedRes.rowCount > 0) {
            const classes = schedRes.rows.map(c => 
                `• ${c.time_start.slice(0,5)}: ${c.subject} (${c.room || 'On Site'})`
            ).join('\n');
            
            let msg = `📚 Jadwal Kuliah Hari Ini:\n${classes}`;

            // Smart Gap Filling Logic
            // Cari celah waktu antar jadwal (> 90 menit)
            let gapFound = false;
            let gapStart = null;
            let gapEnd = null;

            for (let i = 0; i < schedRes.rows.length - 1; i++) {
                const currentEnd = schedRes.rows[i].time_end; // HH:mm:ss
                const nextStart = schedRes.rows[i+1].time_start;
                
                // Parse time
                const d1 = new Date(`2000-01-01T${currentEnd}`);
                const d2 = new Date(`2000-01-01T${nextStart}`);
                const diffMin = (d2 - d1) / 60000;

                if (diffMin > 90) {
                    gapFound = true;
                    gapStart = currentEnd.slice(0,5);
                    gapEnd = nextStart.slice(0,5);
                    break; // Ambil gap pertama yang signifikan
                }
            }

            if (gapFound) {
                // Cari 1 tugas Medium/High yang belum selesai
                const suggestion = await client.query(`
                    SELECT title FROM tasks 
                    WHERE completed = FALSE 
                      AND is_deleted = FALSE 
                      AND (priority = 'medium' OR priority = 'high')
                      AND deadline >= NOW()
                    ORDER BY deadline ASC 
                    LIMIT 1
                `);
                
                if (suggestion.rowCount > 0) {
                    msg += `\n\n💡 Tip: Ada jeda waktu ${gapStart}-${gapEnd}. Cukup nih buat nyicil "${suggestion.rows[0].title}"!`;
                }
            } else {
                 // Jika tidak ada gap signifikan
                 msg += `\n\nSemangat kuliahnya! Jadwal padat hari ini, jangan lupa istirahat ya.`;
            }
            
            // Broadcast to all subscribed users (assuming shared schedule)
            const subs = await client.query('SELECT DISTINCT user_id FROM push_subscriptions');
            for (const u of subs.rows) {
                await sendNotificationToUser(u.user_id, {
                    title: 'Morning Brief ☀️',
                    body: msg,
                    data: { url: '/schedule' },
                    actions: [
                        { action: 'open-schedule', title: '📅 Lihat Detail' }
                    ]
                });
                results.schedule++;
            }
        } else {
             // Libur / Tidak ada jadwal
             // Cek Weekly Recap setiap Minggu (dayId = 7)
             if (dayId === 7) {
                 // Weekly Recap Logic
                 const startOfWeek = new Date(today);
                 startOfWeek.setDate(today.getDate() - 6);
                 
                 const completedCount = await client.query(`
                    SELECT COUNT(*) as cnt FROM tasks 
                    WHERE completed = TRUE 
                      AND completed_at >= $1
                 `, [startOfWeek]);
                 
                 const moodAvg = await client.query(`
                    SELECT AVG(mood)::float as val FROM evaluations 
                    WHERE created_at >= $1
                 `, [startOfWeek]);
                 
                 const count = completedCount.rows[0].cnt;
                 const mood = Number(moodAvg.rows[0].val || 0).toFixed(1);
                 
                 const msg = `Happy Sunday! Minggu ini kamu menyelesaikan ${count} tugas dengan rata-rata mood ${mood}. Siap untuk minggu depan?`;
                 
                 const subs = await client.query('SELECT DISTINCT user_id FROM push_subscriptions');
                 for (const u of subs.rows) {
                    await sendNotificationToUser(u.user_id, {
                        title: 'Weekly Recap 📊',
                        body: msg,
                        data: { url: '/monthly-todos' }
                    });
                 }
             }
        }
    }

    // 4. EVENING ACTIONS (Runs at 20:00 WIB = 13:00 UTC)
    if (utcHour >= 10) {
        // 4a. EVENING BRIEF (Schedule for Tomorrow)
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tmrDayId = tomorrow.getDay() === 0 ? 7 : tomorrow.getDay();
        const tmrSchedRes = await client.query(`
            SELECT subject, time_start, time_end, room
            FROM schedule
            WHERE day_id = $1
            ORDER BY time_start ASC
        `, [tmrDayId]);

        if (tmrSchedRes.rowCount > 0) {
            const classes = tmrSchedRes.rows.map(c => 
                `• ${c.time_start.slice(0,5)}: ${c.subject} (${c.room || 'On Site'})`
            ).join('\n');
            
            const msg = `🌙 Jadwal Kuliah Besok:\n${classes}`;
            
            const subs = await client.query('SELECT DISTINCT user_id FROM push_subscriptions');
            for (const u of subs.rows) {
                await sendNotificationToUser(u.user_id, {
                    title: 'Evening Brief 🌙',
                    body: msg,
                    data: { url: '/schedule' },
                    actions: [
                        { action: 'open-schedule', title: '📅 Lihat Detail' }
                    ]
                });
                results.schedule++;
            }
        }

        // 5. HABIT CHECK (Monthly Todos)
        // Cek jika user tidak mengerjakan habit selama 3 hari berturut-turut
        // UTC+7 (WIB)
        const nowWIB = new Date(now.getTime() + 7 * 3600000);
        const currentMonth = nowWIB.toISOString().slice(0, 7); // YYYY-MM
        
        // Get active todos
        const todos = await client.query(`
            SELECT id, title, user_id 
            FROM monthly_todos 
            WHERE month = $1
        `, [currentMonth]);

        // Dates to check: Today, Yesterday, D-2
        const datesToCheck = [];
        for (let i = 0; i < 3; i++) {
            const d = new Date(nowWIB);
            d.setDate(d.getDate() - i);
            datesToCheck.push(d.toISOString().slice(0, 10)); // YYYY-MM-DD
        }

        for (const todo of todos.rows) {
            const logs = await client.query(`
                SELECT date 
                FROM monthly_todo_logs 
                WHERE monthly_todo_id = $1 
                  AND completed = TRUE 
                  AND date = ANY($2::date[])
            `, [todo.id, datesToCheck]);
            
            // If NO completed logs in the last 3 days
            if (logs.rowCount === 0) {
                await sendNotificationToUser(todo.user_id, {
                    title: 'Habit Alert ⚠️',
                    body: `Kamu belum mengerjakan "${todo.title}" selama 3 hari berturut-turut! Yuk dikerjakan!`,
                    data: { url: '/monthly-todos' }
                });
                results.habit++;
            }
        }
    }

    sendJson(res, 200, { 
      message: 'Context checks completed', 
      stats: results 
    });

  } finally {
    client.release();
  }
});