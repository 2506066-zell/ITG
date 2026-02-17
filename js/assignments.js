import { initProtected, showToast } from './main.js';
import { get, post, put, del } from './api.js';

let timerInterval;
let moodOverlay, moodSheet, moodForm, moodGrid, moodValueEl, moodNoteEl;
let addOverlay, addForm;

function formatCountdown(ms) {
  if (ms <= 0) return 'Overdue';
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((ms % (1000 * 60)) / 1000);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function sendNotification(title, timeLeft) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Tugas Urgent!', {
      body: `"${title}" sisa waktu ${timeLeft}`,
      icon: '/icons/192.png'
    });
  }
}

function updateTimers() {
  const items = document.querySelectorAll('.countdown-timer');
  const now = Date.now();

  items.forEach(el => {
    const deadline = new Date(el.dataset.deadline).getTime();
    const diff = deadline - now;

    el.textContent = formatCountdown(diff);

    const parent = el.closest('.list-item');
    if (diff > 0 && diff < 43200000) {
      if (!parent.classList.contains('urgent')) {
        parent.classList.add('urgent');
        if (!el.dataset.notified) {
          sendNotification(el.dataset.title, formatCountdown(diff));
          el.dataset.notified = 'true';
        }
      }
    } else if (diff <= 0) {
      parent.classList.add('overdue');
      parent.classList.remove('urgent');
    } else {
      parent.classList.remove('urgent');
      parent.classList.remove('overdue');
    }
  });
}

async function load() {
  initProtected();
  await requestNotificationPermission();

  const activeList = document.querySelector('#assignments-active');
  const completedList = document.querySelector('#assignments-completed');
  const el1d = document.getElementById('stat-1d');
  const el3d = document.getElementById('stat-3d');
  const el5d = document.getElementById('stat-5d');

  activeList.innerHTML = '';
  completedList.innerHTML = '';

  const data = await get('/assignments');

  if (!data.length) {
    activeList.innerHTML = '<div class="empty center muted">Belum ada tugas.</div>';
    if (el1d) el1d.textContent = '0 tugas';
    if (el3d) el3d.textContent = '0 tugas';
    if (el5d) el5d.textContent = '0 tugas';
    return;
  }

  // Stats
  try {
    const currentUser = localStorage.getItem('user') || '';
    const now = Date.now();
    const daysToMs = (d) => d * 24 * 60 * 60 * 1000;
    const done = data.filter(a => a.completed && a.completed_at);
    const byUser = currentUser ? done.filter(a => (a.completed_by || '') === currentUser) : done;
    const within = (a, days) => {
      const t = new Date(a.completed_at).getTime();
      return (now - t) <= daysToMs(days);
    };
    const c1 = byUser.filter(a => within(a, 1)).length;
    const c3 = byUser.filter(a => within(a, 3)).length;
    const c5 = byUser.filter(a => within(a, 5)).length;
    if (el1d) el1d.textContent = `${c1} tugas`;
    if (el3d) el3d.textContent = `${c3} tugas`;
    if (el5d) el5d.textContent = `${c5} tugas`;
  } catch (_) { }

  const active = data.filter(a => !a.completed).sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  const completed = data.filter(a => a.completed).sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));

  const createItem = (a, isCompleted) => {
    const el = document.createElement('div');
    el.className = 'list-item assignment-item';

    el.innerHTML = `
      <div style="flex:1">
        <div style="display:flex; align-items:center; gap:8px">
          <input type="checkbox" ${isCompleted ? 'checked' : ''} data-id="${a.id}" data-action="toggle">
          <strong style="font-size:13px">${a.title}</strong>
        </div>
        ${a.description ? `<div class="muted small" style="margin-left:24px; font-size:11px">${a.description}</div>` : ''}
        <div class="muted small" style="margin-left:24px; margin-top:4px; display:flex; flex-wrap:wrap; gap:6px; align-items:center">
          ${isCompleted ?
        `<span class="badge success"><i class="fa-solid fa-check"></i> ${new Date(a.completed_at).toLocaleDateString()}</span>` :
        `<span class="badge countdown-timer" data-deadline="${a.deadline}" data-title="${a.title}">...</span>`
      }
          <span style="font-size:10px; opacity:0.6"><i class="fa-solid fa-user"></i> ${a.assigned_to || 'Users'}</span>
        </div>
      </div>
      <div class="actions">
        <button class="btn danger small" data-id="${a.id}" data-action="delete" style="padding:4px 8px"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;
    return el;
  };

  active.forEach(item => activeList.appendChild(createItem(item, false)));
  completed.forEach(item => completedList.appendChild(createItem(item, true)));

  if (timerInterval) clearInterval(timerInterval);
  updateTimers();
  timerInterval = setInterval(updateTimers, 1000);
}

async function create(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const deadline = f.get('deadline');

  if (new Date(deadline) < new Date()) {
    showToast('Deadline tidak boleh di masa lalu', 'error');
    return;
  }

  const body = {
    title: f.get('title'),
    description: f.get('description'),
    deadline: deadline,
    assigned_to: f.get('assigned_to')
  };

  await post('/assignments', body);
  e.target.reset();
  closeAddModal();
  load();
  showToast('Tugas ditambahkan', 'success');
}

async function actions(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const id = btn.dataset.id;
  const act = btn.dataset.action;

  if (act === 'delete') {
    if (!confirm('Hapus tugas ini?')) return;
    await del(`/assignments?id=${id}`);
    showToast('Tugas dihapus', 'success');
  }
  if (act === 'toggle') {
    await post('/assignments', { action: 'toggle', id, completed: btn.checked });
    if (btn.checked) {
      const title = btn.closest('.list-item')?.querySelector('strong')?.textContent || '';
      openMoodPrompt(`Selesai tugas kuliah: ${title}`);
    }
  }
  load();
}

function init() {
  document.querySelector('#create-assignment').addEventListener('submit', create);
  document.querySelector('#assignments-active').addEventListener('change', actions);
  document.querySelector('#assignments-completed').addEventListener('change', actions);
  document.querySelector('#assignments-active').addEventListener('click', actions);
  document.querySelector('#assignments-completed').addEventListener('click', actions);

  // FAB Modal logic
  addOverlay = document.getElementById('add-overlay');
  document.getElementById('open-add').addEventListener('click', openAddModal);
  document.getElementById('add-cancel').addEventListener('click', closeAddModal);

  load();
  moodOverlay = document.getElementById('mood-overlay');
  moodSheet = document.getElementById('mood-sheet');
  moodForm = document.getElementById('mood-form');
  moodGrid = document.getElementById('mood-grid');
  moodValueEl = document.getElementById('mood-value');
  moodNoteEl = document.getElementById('mood-note');
  setupMoodEvents();
}

function openAddModal() {
  addOverlay.classList.add('active');
  addOverlay.querySelector('.bottom-sheet').classList.add('active');
}

function closeAddModal() {
  addOverlay.classList.remove('active');
  addOverlay.querySelector('.bottom-sheet').classList.remove('active');
}

document.addEventListener('DOMContentLoaded', init);

function setupMoodEvents() {
  if (!moodGrid) return;

  const moodGlows = {
    1: 'radial-gradient(circle at center, hsla(0, 70%, 50%, 0.15), transparent 70%)',
    2: 'radial-gradient(circle at center, hsla(30, 70%, 50%, 0.15), transparent 70%)',
    3: 'radial-gradient(circle at center, hsla(200, 70%, 50%, 0.15), transparent 70%)',
    4: 'radial-gradient(circle at center, hsla(140, 70%, 50%, 0.15), transparent 70%)',
    5: 'radial-gradient(circle at center, hsla(280, 70%, 55%, 0.15), transparent 70%)'
  };

  moodGrid.querySelectorAll('.prio-btn').forEach(b => {
    b.addEventListener('click', () => {
      moodGrid.querySelectorAll('.prio-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      moodValueEl.value = b.dataset.val;

      const glow = document.getElementById('mood-glow');
      glow.style.background = moodGlows[b.dataset.val];
      glow.style.opacity = '1';
    });
  });

  document.querySelectorAll('.tag-chip-enhanced').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('active'));
  });

  document.getElementById('mood-cancel')?.addEventListener('click', closeMoodPrompt);

  moodForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!moodValueEl.value) { showToast('Pilih mood', 'error'); return; }

    const tags = Array.from(document.querySelectorAll('.tag-chip-enhanced.active'))
      .map(c => c.dataset.val).join(', ');

    const body = {
      mood: moodValueEl.value,
      note: `${tags ? '[' + tags + '] ' : ''}${moodNoteEl.value}`,
      date: new Date().toISOString()
    };

    await post('/evaluations', body);
    showToast('Mood disimpan', 'success');
    closeMoodPrompt();
  });
}

function openMoodPrompt(note) {
  if (!moodOverlay) return;
  moodValueEl.value = '';
  moodNoteEl.value = note || '';
  moodGrid.querySelectorAll('.prio-btn').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tag-chip-enhanced').forEach(x => x.classList.remove('active'));
  document.getElementById('mood-glow').style.opacity = '0';
  moodOverlay.classList.add('active');
  moodSheet.classList.add('active');
}

function closeMoodPrompt() {
  moodOverlay.classList.remove('active');
  moodSheet.classList.remove('active');
}

