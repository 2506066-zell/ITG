
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
    user: 'Zaldy',
    month: localMonth(),
    todos: [],
    stats: null,
    monthsList: [],
    archiveUser: 'Zaldy',
    currentDate: localDate()
};
let userOverride = false;
let autoSyncTimer = null;
let daySyncTimer = null;
let moodResolve = null;
let moodReject = null;

const els = {
    monthPicker: document.getElementById('month-picker'),
    userTabs: document.querySelectorAll('.user-tab'),
    todoList: document.getElementById('todo-list'),
    archiveToggle: document.getElementById('archive-toggle'),
    archivePanel: document.getElementById('archive-panel'),
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
    combinedRate: document.getElementById('stat-combined')
};

function init() {
    initProtected();
    normalizeLinks();
    // Set initial month value
    els.monthPicker.value = state.month;

    // Event Listeners
    els.monthPicker.addEventListener('change', (e) => {
        state.month = e.target.value;
        userOverride = true;
        loadAll();
    });

    els.archiveToggle.addEventListener('click', () => {
        els.archivePanel.classList.toggle('active');
        if (els.archivePanel.classList.contains('active')) {
            loadMonthsList();
        }
    });
    els.archivePanel.addEventListener('click', (e) => {
        const userChip = e.target.closest('.archive-user-chip');
        if (userChip) {
            const u = userChip.dataset.user;
            if (u && (u === 'Zaldy' || u === 'Nesya')) {
                state.archiveUser = u;
                state.user = u;
                updateUserTabs();
                loadMonthsList();
                loadTodos();
                renderArchivePanel();
            }
            return;
        }
        const chip = e.target.closest('.archive-chip');
        if (chip) {
            const m = chip.dataset.month;
            if (!m) return;
            state.month = m;
            userOverride = true;
            els.monthPicker.value = state.month;
            updateArchiveState();
            loadAll();
            renderArchivePanel(); // refresh active marker
        }
    });

    els.userTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            state.user = tab.dataset.user;
            state.archiveUser = state.user;
            updateUserTabs();
            loadTodos(); // Only reload todos, stats are global
            if (els.archivePanel.classList.contains('active')) {
                loadMonthsList();
            }
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
    startMonthAutoSync();
    startDayAutoSync();
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
    els.todoList.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted)">Loading...</div>';
    try {
        const data = await get(`/monthly?month=${state.month}&user=${state.user}`);
        state.todos = Array.isArray(data) ? data : [];
        renderTodos();
    } catch (err) {
        console.error(err);
        if (err.message.includes('backend unreachable') || err.message.includes('404')) {
             els.todoList.innerHTML = `
                 <div style="text-align:center;padding:20px;color:var(--danger)">
                     <p style="margin-bottom:8px"><strong>Connection Error</strong></p>
                     <p style="font-size:13px;margin-bottom:12px">Ensure backend is running on Port 3000.</p>
                 </div>`;
        } else {
            els.todoList.innerHTML = '<div style="text-align:center;padding:20px;color:var(--danger)">Error loading data</div>';
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

async function loadMonthsList() {
    try {
        const r = await get(`/monthly?list=months&user=${state.archiveUser}`);
        const arr = Array.isArray(r.months) ? r.months : [];
        state.monthsList = arr;
        renderArchivePanel();
    } catch (err) {
        console.error(err);
        els.archivePanel.innerHTML = '<div style="color:var(--danger)">Gagal memuat arsip</div>';
    }
}

function renderArchivePanel() {
    const months = Array.isArray(state.monthsList) ? state.monthsList : [];
    if (months.length === 0) {
        const uf = renderArchiveFilter();
        els.archivePanel.innerHTML = uf + '<div class="muted">Belum ada arsip bulan.</div>';
        return;
    }
    const groups = {};
    months.forEach(m => {
        const y = m.split('-')[0];
        if (!groups[y]) groups[y] = [];
        groups[y].push(m);
    });
    const uf = renderArchiveFilter();
    const listHtml = Object.keys(groups).sort((a,b) => b.localeCompare(a)).map(y => {
        const chips = groups[y].sort((a,b) => b.localeCompare(a)).map(m => {
            const active = m === state.month ? 'active' : '';
            const label = new Date(m + '-01').toLocaleString(undefined, { month: 'short', year: 'numeric' });
            return `<div class="archive-chip ${active}" data-month="${m}">${label}</div>`;
        }).join('');
        return `<div class="archive-year">${y}</div><div class="archive-chips">${chips}</div>`;
    }).join('');
    els.archivePanel.innerHTML = uf + listHtml;
}

function renderArchiveFilter() {
    const users = ['Zaldy','Nesya'];
    const chips = users.map(u => {
        const active = u === state.archiveUser ? 'active' : '';
        return `<div class="archive-user-chip ${active}" data-user="${u}">${u}</div>`;
    }).join('');
    return `<div class="archive-filter"><span class="muted">Filter:</span>${chips}</div>`;
}

function startMonthAutoSync() {
    if (autoSyncTimer) return;
    autoSyncTimer = setInterval(() => {
        const sysMonth = localMonth();
        if (!userOverride && state.month !== sysMonth) {
            state.month = sysMonth;
            els.monthPicker.value = state.month;
            updateArchiveState();
            loadAll();
        }
    }, 60000);
}

function startDayAutoSync() {
    if (daySyncTimer) return;
    daySyncTimer = setInterval(() => {
        const d = localDate();
        if (d !== state.currentDate) {
            state.currentDate = d;
            // Re-render to pindahkan highlight "today" ke tanggal baru
            renderTodos();
            renderStats();
        }
    }, 60000);
}

function renderTodos() {
    if (!Array.isArray(state.todos) || state.todos.length === 0) {
        els.todoList.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);font-style:italic">No monthly habits yet. Create one!</div>';
        return;
    }

    const daysInMonth = new Date(state.month.split('-')[0], state.month.split('-')[1], 0).getDate();
    const today = new Date();
    const currentMonthStr = localMonth();
    const isCurrentMonth = state.month === currentMonthStr;
    const currentDay = today.getDate();
    const isPastMonth = state.month < currentMonthStr;

    els.todoList.innerHTML = state.todos.map(todo => {
        let daysHtml = '';
        const completedSet = new Set(todo.completed_days || []);

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
            <div class="todo-card">
                <div class="todo-header">
                    <span>${todo.title}</span>
                    ${!isPastMonth ? `<i class="fa-solid fa-trash" style="font-size:12px;color:var(--danger);cursor:pointer;opacity:0.5" onclick="window.deleteTodo(${todo.id})"></i>` : ''}
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
}

function renderStats() {
    if (!state.stats) return;
    const users = (state.stats && state.stats.users) || {};
    const combined = state.stats && typeof state.stats.combined === 'number' ? state.stats.combined : 0;
    const z = users.Zaldy || {};
    const n = users.Nesya || {};
    
    els.zRate.textContent = (z.completion_rate || 0) + '%';
    els.zStreak.textContent = (z.streak || 0) + ' days';
    els.zTotal.textContent = (z.total_completed || 0);

    els.nRate.textContent = (n.completion_rate || 0) + '%';
    els.nStreak.textContent = (n.streak || 0) + ' days';
    els.nTotal.textContent = (n.total_completed || 0);
    
    els.combinedRate.textContent = (combined || 0) + '%';
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
        alert('Failed to create todo');
    }
}

// Global Handlers
window.handleDayClick = async (box) => {
    if (box.dataset.busy === '1') return;
    // Check read-only state
    const currentMonth = localMonth();
    if (state.month < currentMonth) {
        alert('Past months are read-only.');
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
            box.classList.add('flash-effect');
            setTimeout(() => box.classList.remove('flash-effect'), 500);
            box.dataset.completed = true;
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
        }
        
        // Refresh stats silently to update percentages
        loadStats();
    } catch (err) {
        console.error(err);
        showToast('Gagal memproses', 'error');
    } finally {
        box.dataset.busy = '';
    }
};

window.deleteTodo = async (id) => {
    if (!confirm('Delete this habit? This cannot be undone.')) return;
    
    try {
        await del(`/monthly?id=${id}`);
        loadAll();
    } catch (err) {
        console.error(err);
        alert('Failed to delete');
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
        });
    });
    document.getElementById('mood-cancel')?.addEventListener('click', () => {
        closeMoodPrompt();
        if (moodReject) moodReject(new Error('cancel'));
    });
    els.moodForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const val = els.moodValueEl.value;
        if (!val) { showToast('Pilih mood', 'error'); return; }
        const data = { mood: val, note: els.moodNoteEl.value };
        if (moodResolve) moodResolve(data);
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

function waitForMood(note) {
    openMoodPrompt(note);
    return new Promise((resolve, reject) => {
        moodResolve = resolve;
        moodReject = reject;
    });
}
