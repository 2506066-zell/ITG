
import { sendNotificationToUser } from '../notifications.js';
import { withErrorHandling } from '../_lib.js';

export default withErrorHandling(async function handler(req, res) {
    // Check for cron secret if needed, but for now simple execution
    
    const now = new Date();
    // Vercel runs in UTC. We want 9 AM WIB = 2 AM UTC.
    // If we schedule cron at 2 AM UTC, we can just check current date.
    // But to be safe about "Monday", let's use UTC+7
    
    const offset = 7;
    const localTime = new Date(now.getTime() + offset * 3600 * 1000);
    
    const dayOfWeek = localTime.getDay(); // 0=Sun, 1=Mon
    const dayOfMonth = localTime.getDate(); // 1-31
    
    const users = ['Zaldy', 'Nesya'];
    const sent = [];

    // Weekly Report (Monday)
    if (dayOfWeek === 1) {
        console.log('Sending Weekly Report...');
        for (const user of users) {
            await sendNotificationToUser(user, {
                title: 'Raport Mingguan Kamu 📊',
                body: 'Cek performa produktivitas & mood kamu minggu lalu!',
                url: '/report?type=weekly',
                tag: 'weekly-report'
            });
        }
        sent.push('weekly');
    }

    // Monthly Report (1st of Month)
    if (dayOfMonth === 1) {
        console.log('Sending Monthly Report...');
        for (const user of users) {
            await sendNotificationToUser(user, {
                title: 'Raport Bulanan Kamu 🌟',
                body: 'Lihat pencapaian kamu bulan lalu!',
                url: '/report?type=monthly',
                tag: 'monthly-report'
            });
        }
        sent.push('monthly');
    }

    if (sent.length === 0) {
        res.status(200).json({ skipped: true, date: localTime.toISOString() });
    } else {
        res.status(200).json({ sent: true, types: sent, date: localTime.toISOString() });
    }
});
