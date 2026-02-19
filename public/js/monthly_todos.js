
import { get, post, del } from './api.js';
import { initProtected, normalizeLinks, showToast } from './main.js';

function localMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function localDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const state = {
    user: 'Zaldy', // Default user
    month: localMonth(), // Current YYYY-MM (local)
    todos: [],
    stats: null,
    habitMetrics: {},
    habitIntelligence: {}
};

const els = {
    monthPicker: document.getElementById('month-picker'),
    userTabs: document.querySelectorAll('.user-tab'),
    todoList: document.getElementById('todo-list'),
    fab: document.getElementById('fab-add'),
    modalOverlay: document.getElementById('modal-overlay'),
    modalCancel: document.getElementById('modal-cancel'),
    createForm: document.getElementById('create-form'),
    moodOverlay: document.getElementById('mood-overlay'),
    moodSheet: document.getElementById('mood-sheet'),
    moodForm: document.getElementById('mood-form'),
    moodGrid: document.getElementById('mood-grid'),
    moodValueEl: document.getElementById('mood-value'),
    moodNoteEl: document.getElementById('mood-note'),
    // Stats
    zRate: document.getElementById('stat-z-rate'),
    zStreak: document.getElementById('stat-z-streak'),
    zTotal: document.getElementById('stat-z-total'),
    nRate: document.getElementById('stat-n-rate'),
    nStreak: document.getElementById('stat-n-streak'),
    nTotal: document.getElementById('stat-n-total'),
    combinedRate: document.getElementById('stat-combined'),
    summaryRate: document.getElementById('summary-rate'),
    summaryStreak: document.getElementById('summary-streak'),
    summaryTotal: document.getElementById('summary-total'),
    weeklyReviewCard: document.getElementById('weekly-review-card'),
    weeklyReviewScore: document.getElementById('weekly-review-score'),
    weeklyReviewList: document.getElementById('weekly-review-list'),
    weeklyReviewAction: document.getElementById('weekly-review-action'),
    weeklyReviewSendChat: document.getElementById('weekly-review-send-chat')
};

function motionReduced() {
    return document.body.classList.contains('no-anim')
        || document.documentElement.classList.contains('perf-lite')
        || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function normalizeCompletedDays(todo, daysInMonth) {
    const set = new Set(Array.isArray(todo?.completed_days) ? todo.completed_days : []);
    return Array.from(set)
        .map((d) => Number(d))
        .filter((d) => Number.isInteger(d) && d >= 1 && d <= daysInMonth)
        .sort((a, b) => a - b);
}

function computeHabitMetrics(todo, daysInMonth, currentDay, isCurrentMonth) {
    const completedDays = normalizeCompletedDays(todo, daysInMonth);
    const completedCount = completedDays.length;
    const daysSoFar = isCurrentMonth ? Math.max(1, currentDay) : daysInMonth;
    const progressPct = Math.max(0, Math.min(100, Math.round((completedCount / Math.max(1, daysSoFar)) * 100)));

    const completedSet = new Set(completedDays);
    const streakStart = isCurrentMonth ? currentDay : daysInMonth;
    let streakCursor = streakStart;
    while (streakCursor > 0 && !completedSet.has(streakCursor)) streakCursor -= 1;
    let currentStreak = 0;
    while (streakCursor > 0 && completedSet.has(streakCursor)) {
        currentStreak += 1;
        streakCursor -= 1;
    }

    return {
        completedCount,
        daysSoFar,
        progressPct,
        currentStreak
    };
}

function clampNum(value, min, max) {
    return Math.max(min, Math.min(max, Number(value)));
}

function completionRateForRange(completedSet, startDay, endDay) {
    if (endDay < startDay) return 0;
    let total = 0;
    let done = 0;
    for (let d = startDay; d <= endDay; d += 1) {
        total += 1;
        if (completedSet.has(d)) done += 1;
    }
    if (total <= 0) return 0;
    return done / total;
}

function countMissedRecent(completedSet, endDay, lookback = 3) {
    let missed = 0;
    const start = Math.max(1, endDay - lookback + 1);
    for (let d = start; d <= endDay; d += 1) {
        if (!completedSet.has(d)) missed += 1;
    }
    return missed;
}

function countRecoveryBounce(completedSet, endDay) {
    // Recovery bounce: hari bolong yang berhasil "dibayar" 1-2 hari setelahnya.
    let recovered = 0;
    const start = Math.max(2, endDay - 13);
    for (let d = start; d <= endDay - 1; d += 1) {
        if (completedSet.has(d)) continue;
        if (completedSet.has(d + 1) || completedSet.has(d + 2)) recovered += 1;
    }
    return recovered;
}

function computeHabitIntelligence(todo, metrics, daysInMonth, currentDay, isCurrentMonth) {
    const completedDays = normalizeCompletedDays(todo, daysInMonth);
    const completedSet = new Set(completedDays);
    const endDay = isCurrentMonth ? currentDay : daysInMonth;
    const recentStart = Math.max(1, endDay - 6);
    const prevEnd = Math.max(1, recentStart - 1);
    const prevStart = Math.max(1, prevEnd - 6);
    const recentRate = completionRateForRange(completedSet, recentStart, endDay);
    const prevRate = completionRateForRange(completedSet, prevStart, prevEnd);
    const trend = recentRate - prevRate;
    const missedRecent = countMissedRecent(completedSet, endDay, 3);
    const recoveryBounce = countRecoveryBounce(completedSet, endDay);

    const consistencyPart = recentRate * 55;
    const streakPart = (Math.min(7, Number(metrics.currentStreak || 0)) / 7) * 25;
    const recoveryPart = (Math.min(3, recoveryBounce) / 3) * 12;
    const trendPart = trend > 0 ? Math.min(8, trend * 20) : Math.max(-8, trend * 20);
    const penalty = missedRecent * 8;
    const score = Math.round(clampNum(consistencyPart + streakPart + recoveryPart + trendPart - penalty, 0, 100));

    let level = 'low';
    if (score >= 75) level = 'high';
    else if (score >= 50) level = 'medium';

    let trendLabel = 'stabil';
    if (trend >= 0.12) trendLabel = 'naik';
    else if (trend <= -0.12) trendLabel = 'turun';

    let recoveryPlan = 'Momentum bagus. Pertahankan pola checklist di jam yang sama.';
    if (missedRecent >= 2) {
        recoveryPlan = 'Recovery mode: hari ini cukup 1 checklist cepat 5-10 menit agar ritme balik.';
    } else if (missedRecent === 1) {
        recoveryPlan = 'Ada 1 bolong terbaru. Tutup hari ini sebelum jam 21:00 untuk jaga streak.';
    } else if (level === 'low' && Number(metrics.currentStreak || 0) === 0) {
        recoveryPlan = 'Mulai ultra-ringan: fokus 1 aksi kecil dulu, bukan perfeksionis.';
    }

    return {
        score,
        level,
        trendLabel,
        missedRecent,
        recoveryPlan
    };
}

function getUserStats() {
    const users = (state.stats && state.stats.users) || {};
    return users[state.user] || {};
}

function renderStickySummary() {
    if (!els.summaryRate || !els.summaryStreak || !els.summaryTotal) return;

    const userStats = getUserStats();
    const apiRate = Number(userStats.completion_rate || 0);
    const apiStreak = Number(userStats.streak || 0);
    const apiTotal = Number(userStats.total_completed || 0);

    const metrics = Object.values(state.habitMetrics || {});
    const intel = Object.values(state.habitIntelligence || {});
    const derivedStreak = metrics.reduce((max, m) => Math.max(max, Number(m.currentStreak || 0)), 0);
    const derivedTotal = metrics.reduce((sum, m) => sum + Number(m.completedCount || 0), 0);

    const rate = Number.isFinite(apiRate) ? apiRate : 0;
    const streak = apiStreak > 0 ? apiStreak : derivedStreak;
    const total = apiTotal > 0 ? apiTotal : derivedTotal;
    const avgIntel = intel.length
        ? Math.round(intel.reduce((sum, item) => sum + Number(item.score || 0), 0) / intel.length)
        : 0;

    els.summaryRate.textContent = `${Math.max(rate, avgIntel)}%`;
    els.summaryStreak.textContent = `${streak} hari`;
    els.summaryTotal.textContent = `${total}`;
}

function renderWeeklyReview() {
    if (!els.weeklyReviewCard || !els.weeklyReviewScore || !els.weeklyReviewList || !els.weeklyReviewAction) return;

    const intelEntries = state.todos
        .map((todo) => ({
            title: String(todo?.title || 'Habit').trim(),
            metrics: state.habitMetrics[todo.id] || null,
            intel: state.habitIntelligence[todo.id] || null
        }))
        .filter((item) => item.metrics && item.intel);

    if (!intelEntries.length) {
        els.weeklyReviewScore.textContent = 'Skor --';
        els.weeklyReviewList.innerHTML = '<li>Belum ada data habit untuk direview.</li>';
        els.weeklyReviewAction.innerHTML = '<i class="fa-solid fa-bolt"></i><span>Mulai 1 habit dulu agar Z AI bisa bikin review mingguan.</span>';
        if (els.weeklyReviewSendChat) {
            els.weeklyReviewSendChat.href = '/chat?ai=' + encodeURIComponent('bantu saya mulai 1 habit ringan minggu ini');
        }
        return;
    }

    const avgScore = Math.round(intelEntries.reduce((sum, item) => sum + Number(item.intel.score || 0), 0) / intelEntries.length);
    const best = [...intelEntries].sort((a, b) => Number(b.intel.score || 0) - Number(a.intel.score || 0))[0];
    const risk = [...intelEntries].sort((a, b) => Number(a.intel.score || 0) - Number(b.intel.score || 0))[0];
    const trendUp = intelEntries.filter((item) => item.intel.trendLabel === 'naik').length;
    const trendDown = intelEntries.filter((item) => item.intel.trendLabel === 'turun').length;

    const insightLines = [
        `Habit paling stabil: ${best.title} (skor ${best.intel.score}).`,
        `Habit paling rawan putus: ${risk.title} (skor ${risk.intel.score}).`,
        `Tren minggu ini: ${trendUp} naik, ${trendDown} turun.`
    ];

    let action = `Aksi minggu ini: kunci 1 slot tetap harian untuk "${risk.title}" selama 10 menit.`;
    if (avgScore >= 75) {
        action = `Aksi minggu ini: pertahankan ritme, naikkan 1 level pada "${best.title}" (durasi +5 menit).`;
    } else if (avgScore < 50) {
        action = `Aksi minggu ini: mode recovery. Fokus dulu konsisten 1 habit termudah selama 3 hari berturut.`;
    }

    els.weeklyReviewScore.textContent = `Skor ${avgScore}`;
    els.weeklyReviewList.innerHTML = insightLines.map((line) => `<li>${line}</li>`).join('');
    els.weeklyReviewAction.innerHTML = `<i class="fa-solid fa-bolt"></i><span>${action}</span>`;
    if (els.weeklyReviewSendChat) {
        const prompt = `weekly review habit saya: skor ${avgScore}, habit stabil ${best.title}, habit rawan ${risk.title}, tren naik ${trendUp}, tren turun ${trendDown}. bantu susun rencana aksi 7 hari yang realistis.`;
        els.weeklyReviewSendChat.href = '/chat?ai=' + encodeURIComponent(prompt);
    }
}

function init() {
    initProtected();
    normalizeLinks();
    // Set initial month value
    els.monthPicker.value = state.month;

    // Event Listeners
    els.monthPicker.addEventListener('change', (e) => {
        state.month = e.target.value;
        loadAll();
    });

    els.userTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            state.user = tab.dataset.user;
            updateUserTabs();
            loadTodos(); // Only reload todos, stats are global
        });
    });

    els.fab.addEventListener('click', () => {
        els.modalOverlay.classList.add('active');
        els.createForm.querySelector('input').focus();
        els.monthPicker.disabled = true;
    });

    els.modalCancel.addEventListener('click', () => {
        els.modalOverlay.classList.remove('active');
        els.monthPicker.disabled = false;
    });

    els.createForm.addEventListener('submit', handleCreate);
    setupMoodEvents();

    // Initial Load
    loadAll();
}

function loadAll() {
    updateArchiveState();
    loadTodos();
    loadStats();
}

function updateArchiveState() {
    const currentMonth = localMonth();
    const isCurrent = state.month === currentMonth;
    // Hanya izinkan membuat habit di bulan sistem saat ini
    if (!isCurrent) {
        els.fab.style.display = 'none';
    } else {
        els.fab.style.display = 'flex';
    }
}

function updateUserTabs() {
    els.userTabs.forEach(tab => {
        if (tab.dataset.user === state.user) tab.classList.add('active');
        else tab.classList.remove('active');
    });
}

async function loadTodos() {
    els.todoList.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted)">Memuat kebiasaan...</div>';
    try {
        const data = await get(`/monthly?month=${state.month}&user=${state.user}`);
        state.todos = Array.isArray(data) ? data : [];
        renderTodos();
        renderStickySummary();
    } catch (err) {
        console.error(err);
        if (err.message.includes('backend unreachable') || err.message.includes('404')) {
            els.todoList.innerHTML = `
                 <div style="text-align:center;padding:20px;color:var(--danger)">
                     <p style="margin-bottom:8px"><strong>Koneksi bermasalah</strong></p>
                     <p style="font-size:13px;margin-bottom:12px">Pastikan backend aktif di Port 3000.</p>
                 </div>`;
        } else {
            els.todoList.innerHTML = '<div style="text-align:center;padding:20px;color:var(--danger)">Gagal memuat data</div>';
        }
    }
}

async function loadStats() {
    try {
        const s = await get(`/monthly_stats?month=${state.month}`);
        state.stats = s && s.users ? s : { users: { Zaldy: {}, Nesya: {} }, combined: 0 };
        renderStats();
    } catch (err) {
        console.error(err);
    }
}

function renderTodos() {
    if (!Array.isArray(state.todos) || state.todos.length === 0) {
        els.todoList.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);font-style:italic">Belum ada kebiasaan bulan ini. Coba buat satu.</div>';
        state.habitMetrics = {};
        state.habitIntelligence = {};
        renderWeeklyReview();
        return;
    }

    const daysInMonth = new Date(state.month.split('-')[0], state.month.split('-')[1], 0).getDate();
    const today = new Date();
    const currentMonthStr = localMonth();
    const isCurrentMonth = state.month === currentMonthStr;
    const currentDay = today.getDate();
    const isPastMonth = state.month < currentMonthStr;
    state.habitMetrics = {};
    state.habitIntelligence = {};

    els.todoList.innerHTML = state.todos.map(todo => {
        let daysHtml = '';
        const completedSet = new Set(normalizeCompletedDays(todo, daysInMonth));
        const metrics = computeHabitMetrics(todo, daysInMonth, currentDay, isCurrentMonth);
        const intelligence = computeHabitIntelligence(todo, metrics, daysInMonth, currentDay, isCurrentMonth);
        state.habitMetrics[todo.id] = metrics;
        state.habitIntelligence[todo.id] = intelligence;

        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${state.month}-${String(d).padStart(2, '0')}`;
            const isCompleted = completedSet.has(d);

            // Classes
            let classes = ['day-box'];
            if (isCurrentMonth && d === currentDay) classes.push('today');
            if (isCompleted) classes.push('completed');
            if (!isCurrentMonth || d !== currentDay) classes.push('disabled');

            daysHtml += `<div class="${classes.join(' ')}" 
                data-id="${todo.id}" 
                data-date="${dateStr}"
                data-completed="${isCompleted}"
                onclick="window.handleDayClick(this)">${d}</div>`;
        }

        return `
            <div class="todo-card todo-tier-${intelligence.level}">
                <div class="todo-header">
                    <span>${todo.title}</span>
                    ${!isPastMonth ? `<i class="fa-solid fa-trash" style="font-size:12px;color:var(--danger);cursor:pointer;opacity:0.5" onclick="window.deleteTodo(${todo.id})"></i>` : ''}
                </div>
                <div class="todo-meta">
                    <span class="habit-chip streak" id="habit-streak-${todo.id}">Runtun ${metrics.currentStreak} hari</span>
                    <span class="habit-chip progress">${metrics.completedCount}/${metrics.daysSoFar} hari</span>
                    <span class="habit-chip intel ${intelligence.level}">Skor ${intelligence.score}</span>
                    <span class="habit-chip trend ${intelligence.trendLabel}">Tren ${intelligence.trendLabel}</span>
                </div>
                <div class="habit-progress-rail">
                    <div class="habit-progress-fill" id="habit-progress-${todo.id}" style="width:${metrics.progressPct}%"></div>
                </div>
                <div class="habit-recovery ${intelligence.level}">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>${intelligence.recoveryPlan}</span>
                </div>
                <div class="day-scroller" id="scroller-${todo.id}">
                    ${daysHtml}
                </div>
            </div>
        `;
    }).join('');

    // Scroll to today if current month
    if (isCurrentMonth) {
        setTimeout(() => {
            const todayEl = document.querySelector('.day-box.today');
            if (todayEl) {
                todayEl.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
            }
        }, 100);
    }

    renderWeeklyReview();
}

function renderStats() {
    if (!state.stats) return;
    const users = (state.stats && state.stats.users) || {};
    const combined = state.stats && typeof state.stats.combined === 'number' ? state.stats.combined : 0;
    const z = users.Zaldy || {};
    const n = users.Nesya || {};

    els.zRate.textContent = (z.completion_rate || 0) + '%';
    els.zStreak.textContent = (z.streak || 0) + ' hari';
    els.zTotal.textContent = (z.total_completed || 0);

    els.nRate.textContent = (n.completion_rate || 0) + '%';
    els.nStreak.textContent = (n.streak || 0) + ' hari';
    els.nTotal.textContent = (n.total_completed || 0);

    els.combinedRate.textContent = (combined || 0) + '%';
    renderStickySummary();
}

async function handleCreate(e) {
    e.preventDefault();
    const title = e.target.title.value;

    try {
        await post('/monthly', {
            action: 'create_todo',
            title,
            user_id: state.user,
            month: localMonth(),
            tz_offset_min: new Date().getTimezoneOffset()
        });

        els.modalOverlay.classList.remove('active');
        e.target.reset();
        els.monthPicker.disabled = false;
        loadAll(); // Reload everything
    } catch (err) {
        console.error(err);
        showToast('Gagal membuat kebiasaan', 'error');
    }
}

// Global Handlers
window.handleDayClick = async (box) => {
    if (box.dataset.busy === '1') return;
    // Check read-only state
    const currentMonth = localMonth();
    if (state.month < currentMonth) {
        showToast('Bulan sebelumnya hanya bisa dilihat.', 'error');
        return;
    }
    // Hanya hari ini yang bisa di-toggle
    const todayStr = localDate();
    const boxDate = (box.dataset.date || '').trim();
    const isTodayVisual = box.classList.contains('today');
    if (!isTodayVisual || boxDate !== todayStr) {
        showToast('Hanya hari ini yang bisa di-check', 'error');
        return;
    }

    const todoId = box.dataset.id;
    const date = box.dataset.date;
    const wasCompleted = box.dataset.completed === 'true';
    const newStatus = !wasCompleted;

    try {
        box.dataset.busy = '1';
        if (newStatus) {
            const mood = await waitForMood(`Selesai kebiasaan (${date})`);
            await post('/monthly', {
                action: 'toggle_log',
                todo_id: todoId,
                date: date,
                completed: newStatus,
                tz_offset_min: new Date().getTimezoneOffset()
            });
            await post('/evaluations', {
                mood: mood.mood,
                note: mood.note || '',
                date: new Date().toISOString()
            });
            box.classList.add('completed');
            if (!motionReduced()) {
                box.classList.add('pulse-ok');
                const card = box.closest('.todo-card');
                card?.classList.add('streak-pop', 'progress-bump');
                setTimeout(() => {
                    box.classList.remove('pulse-ok');
                    card?.classList.remove('streak-pop', 'progress-bump');
                }, 520);
            }
            box.dataset.completed = true;
            const motivations = [
                'Keren, streak kamu lanjut',
                'Rapi banget, konsisten hari ini',
                'Mantap, progres kamu naik lagi'
            ];
            showToast(`${motivations[Math.floor(Math.random() * motivations.length)]} 🔥`, 'success');
        } else {
            await post('/monthly', {
                action: 'toggle_log',
                todo_id: todoId,
                date: date,
                completed: newStatus,
                tz_offset_min: new Date().getTimezoneOffset()
            });
            box.classList.remove('completed');
            box.dataset.completed = false;
            showToast('Checklist hari ini dibatalkan', 'info');
        }

        // Refresh stats silently to update percentages
        renderTodos();
        renderStickySummary();
        loadStats();
    } catch (err) {
        console.error(err);
        showToast('Gagal memproses', 'error');
    } finally {
        box.dataset.busy = '';
    }
};

window.deleteTodo = async (id) => {
    if (!confirm('Hapus kebiasaan ini? Aksi ini tidak bisa dibatalkan.')) return;

    try {
        await del(`/monthly?id=${id}`);
        loadAll();
    } catch (err) {
        console.error(err);
        showToast('Gagal menghapus kebiasaan', 'error');
    }
};

// Start
init();

function setupMoodEvents() {
    if (!els.moodGrid) return;
    els.moodGrid.querySelectorAll('.prio-btn').forEach(b => {
        b.addEventListener('click', () => {
            els.moodGrid.querySelectorAll('.prio-btn').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            els.moodValueEl.value = b.dataset.val;
            updateMoodGlow(b.dataset.val);
        });
    });
    document.getElementById('mood-cancel')?.addEventListener('click', () => {
        closeMoodPrompt();
        window.__moodReject && window.__moodReject(new Error('cancel'));
    });
    els.moodForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const val = els.moodValueEl.value;
        if (!val) { showToast('Pilih mood', 'error'); return; }
        const data = { mood: val, note: els.moodNoteEl.value };
        window.__moodResolve && window.__moodResolve(data);
        closeMoodPrompt();
    });
}

function openMoodPrompt(note) {
    if (!els.moodOverlay) return;
    els.moodValueEl.value = '';
    els.moodNoteEl.value = note || '';
    els.moodGrid.querySelectorAll('.prio-btn').forEach(x => x.classList.remove('active'));
    els.moodOverlay.classList.add('active');
    els.moodSheet.classList.add('active');
}

function closeMoodPrompt() {
    els.moodOverlay.classList.remove('active');
    els.moodSheet.classList.remove('active');
}

function updateMoodGlow(val) {
    const glowOverlay = document.getElementById('mood-glow');
    if (!glowOverlay) return;

    // Remove existing mood classes
    for (let i = 1; i <= 5; i++) {
        els.moodSheet.classList.remove(`mood-${i}`);
    }

    if (val) {
        els.moodSheet.classList.add(`mood-${val}`);
        glowOverlay.classList.add('mood-glow-active');
    } else {
        glowOverlay.classList.remove('mood-glow-active');
    }
}

function waitForMood(note) {
    openMoodPrompt(note);
    return new Promise((resolve, reject) => {
        window.__moodResolve = resolve;
        window.__moodReject = reject;
    });
}
