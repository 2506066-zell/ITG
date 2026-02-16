import { pool } from '../api/_lib.js';
import { sendNotificationToUser } from '../api/notifications.js';

// Mock sendNotificationToUser to avoid actual push but log output
const mockNotifications = [];
async function mockSendNotification(userId, payload) {
    mockNotifications.push({ userId, payload });
    console.log(`[MOCK PUSH] To: ${userId}`, payload);
}

// Override original import if possible or just test logic isolation
// Since we can't easily mock ESM imports in this script without a test runner,
// we will replicate the logic inside the test script using the same queries.

async function runTest() {
    const client = await pool.connect();
    try {
        console.log('--- Setting up Test Data ---');
        await client.query('BEGIN');

        // 1. Create Dummy Schedule for Today (Monday=1 for test simplicity)
        // Gap > 90 min between 10:00 and 13:00
        const today = new Date();
        const dayId = today.getDay() === 0 ? 7 : today.getDay();
        
        // Backup existing schedule for today
        await client.query('CREATE TEMP TABLE temp_schedule AS SELECT * FROM schedule WHERE day_id = $1', [dayId]);
        await client.query('DELETE FROM schedule WHERE day_id = $1', [dayId]);

        // Insert Test Schedule
        await client.query(`
            INSERT INTO schedule (day_id, subject, time_start, time_end, room) VALUES
            ($1, 'Test Subject 1', '08:00', '10:00', 'R101'),
            ($1, 'Test Subject 2', '13:00', '15:00', 'R102')
        `, [dayId]);

        // 2. Create Dummy Task
        const taskRes = await client.query(`
            INSERT INTO tasks (title, priority, deadline, assigned_to, created_by) 
            VALUES ('Tugas Besar Gap Filling', 'high', NOW() + INTERVAL '2 days', 'TestUser', 'System')
            RETURNING id
        `);

        // 3. Run Logic (Replicated from context_checks.js)
        console.log('--- Running Gap Filling Logic ---');
        
        const schedRes = await client.query(`
            SELECT subject, time_start, time_end, room
            FROM schedule
            WHERE day_id = $1
            ORDER BY time_start ASC
        `, [dayId]);

        let msg = '';
        if (schedRes.rowCount > 0) {
            const classes = schedRes.rows.map(c => 
                `• ${c.time_start.slice(0,5)}: ${c.subject} (${c.room || 'On Site'})`
            ).join('\n');
            msg = `📚 Jadwal Kuliah Hari Ini:\n${classes}`;

            let gapFound = false;
            let gapStart = null;
            let gapEnd = null;

            for (let i = 0; i < schedRes.rows.length - 1; i++) {
                const currentEnd = schedRes.rows[i].time_end;
                const nextStart = schedRes.rows[i+1].time_start;
                const d1 = new Date(`2000-01-01T${currentEnd}`);
                const d2 = new Date(`2000-01-01T${nextStart}`);
                const diffMin = (d2 - d1) / 60000;

                console.log(`Gap Check: ${currentEnd} -> ${nextStart} = ${diffMin} mins`);

                if (diffMin > 90) {
                    gapFound = true;
                    gapStart = currentEnd.slice(0,5);
                    gapEnd = nextStart.slice(0,5);
                    break;
                }
            }

            if (gapFound) {
                console.log('✅ Gap Found!');
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
                } else {
                    console.log('❌ No suitable task found for suggestion.');
                }
            } else {
                 console.log('❌ No gap found.');
            }
        }

        console.log('--- Result Message ---');
        console.log(msg);
        
        // Assertion
        if (msg.includes('💡 Tip: Ada jeda waktu') && msg.includes('Tugas Besar Gap Filling')) {
            console.log('✅ TEST PASSED: Notification contains gap suggestion.');
        } else {
            console.log('❌ TEST FAILED: Notification missing gap suggestion.');
        }

    } catch (err) {
        console.error(err);
    } finally {
        console.log('--- Cleaning Up ---');
        await client.query('ROLLBACK'); // Always rollback to keep DB clean
        client.release();
    }
}

runTest();
