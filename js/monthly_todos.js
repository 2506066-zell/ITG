
import { get, post, del } from './api.js';
import { initProtected, normalizeLinks, showToast } from './main.js';

const state = {
    user: 'Zaldy', // Default user
    month: new Date().toISOString().slice(0, 7), // Current YYYY-MM
    todos: [],
    stats: null
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
    const currentMonth = new Date().toISOString().slice(0, 7);
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

function renderTodos() {
    if (!Array.isArray(state.todos) || state.todos.length === 0) {
        els.todoList.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);font-style:italic">No monthly habits yet. Create one!</div>';
        return;
    }

    const daysInMonth = new Date(state.month.split('-')[0], state.month.split('-')[1], 0).getDate();
    const today = new Date();
    const currentMonthStr = today.toISOString().slice(0, 7);
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
            month: new Date().toISOString().slice(0, 7)
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
    // Check read-only state
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (state.month < currentMonth) {
        alert('Past months are read-only.');
        return;
    }
    // Hanya hari ini yang bisa di-toggle
    const todayStr = new Date().toISOString().slice(0, 10);
    if (box.dataset.date !== todayStr) {
        showToast('Hanya hari ini yang bisa di-check', 'error');
        return;
    }

    const todoId = box.dataset.id;
    const date = box.dataset.date;
    const wasCompleted = box.dataset.completed === 'true';
    const newStatus = !wasCompleted;

    // Optimistic Update
    if (newStatus) {
        box.classList.add('completed');
        box.classList.add('flash-effect');
        setTimeout(() => box.classList.remove('flash-effect'), 500);
    } else {
        box.classList.remove('completed');
    }
    box.dataset.completed = newStatus;

    try {
        await post('/monthly', {
            action: 'toggle_log',
            todo_id: todoId,
            date: date,
            completed: newStatus
        });
        if (newStatus) {
            openMoodPrompt(`Selesai kebiasaan (${date})`);
        }
        
        // Refresh stats silently to update percentages
        loadStats();
    } catch (err) {
        console.error(err);
        // Revert
        if (wasCompleted) box.classList.add('completed');
        else box.classList.remove('completed');
        box.dataset.completed = wasCompleted;
        alert('Failed to update status');
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
    });
    els.moodForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const val = els.moodValueEl.value;
        if (!val) { showToast('Pilih mood', 'error'); return; }
        const body = { mood: val, note: els.moodNoteEl.value, date: new Date().toISOString() };
        try {
            await post('/evaluations', body);
            showToast('Mood disimpan', 'success');
        } catch (err) {
            showToast('Gagal menyimpan', 'error');
        }
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
