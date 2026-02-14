import { initProtected, showToast } from './main.js';
import { get, post, put, del } from './api.js';

let timerInterval;
let notifyInterval;
const LS_KEYS = {
  owners: 'assignment_owners',
  started: 'assignment_started',
  snooze: 'assignment_snooze',
  notified: 'assignment_last_notified'
};
function getMap(key) { const s = localStorage.getItem(key); return s ? JSON.parse(s) : {}; }
function setMap(key, m) { localStorage.setItem(key, JSON.stringify(m)); }
function getOwner(id) { const m = getMap(LS_KEYS.owners); return m[id] || 'Zaldy'; }
function setOwner(id, user) { const m = getMap(LS_KEYS.owners); m[id] = user; setMap(LS_KEYS.owners, m); }
function isStarted(id) { const m = getMap(LS_KEYS.started); return !!m[id]; }
function setStarted(id, v) { const m = getMap(LS_KEYS.started); if (v) m[id] = Date.now(); else delete m[id]; setMap(LS_KEYS.started, m); }
function getSnoozeUntil(id) { const m = getMap(LS_KEYS.snooze); return m[id] || 0; }
function setSnoozeUntil(id, ts) { const m = getMap(LS_KEYS.snooze); if (ts) m[id] = ts; else delete m[id]; setMap(LS_KEYS.snooze, m); }
function getLastNotified(id) { const m = getMap(LS_KEYS.notified); return m[id] || 0; }
function setLastNotified(id, ts) { const m = getMap(LS_KEYS.notified); m[id] = ts; setMap(LS_KEYS.notified, m); }

function formatCountdown(ms) {
  if (ms <= 0) return 'Overdue';
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((ms % (1000 * 60)) / 1000);
  
  if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function sendNotification(title, timeLeft, owner) {
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(`Tugas ${owner}`, {
      body: `"${title}" sisa waktu ${timeLeft}`,
      icon: '/icons/192.png'
    });
    n.onclick = () => window.focus();
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
    const id = el.dataset.id;
    const snoozeUntil = getSnoozeUntil(id);
    if (isStarted(id) || snoozeUntil > now) {
      parent.classList.remove('urgent');
      return;
    }
    // Urgent logic: < 12 hours (12 * 60 * 60 * 1000 = 43200000)
    if (diff > 0 && diff < 43200000) {
      if (!parent.classList.contains('urgent')) {
        parent.classList.add('urgent');
        const last = getLastNotified(id);
        if (!last || (Date.now() - last) > 1800000) {
          sendNotification(el.dataset.title, formatCountdown(diff), getOwner(id));
          setLastNotified(id, Date.now());
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

function checkReminders(list) {
  const now = Date.now();
  const TH48 = 48 * 3600 * 1000;
  const TH24 = 24 * 3600 * 1000;
  const TH2 = 2 * 3600 * 1000;
  list.forEach(a => {
    if (!a.deadline) return;
    if (a.completed) return;
    const id = String(a.id);
    if (isStarted(id)) return;
    const snoozeUntil = getSnoozeUntil(id);
    if (snoozeUntil > now) return;
    const dl = new Date(a.deadline).getTime();
    const diff = dl - now;
    if (diff <= 0) return;
    const last = getLastNotified(id);
    let should = false;
    if (diff <= TH48 && diff > TH24 && now - last > 3600000) should = true;
    else if (diff <= TH24 && diff > TH2 && now - last > 3600000) should = true;
    else if (diff <= TH2 && now - last > 1800000) should = true;
    if (should) {
      sendNotification(a.title, formatCountdown(diff), getOwner(id));
      setLastNotified(id, now);
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
  const trendEl = document.getElementById('stat-trend');
  
  // Skeleton
  activeList.innerHTML = `<div class="list-item"><div class="skeleton skeleton-line" style="width:70%"></div></div>`;
  completedList.innerHTML = '';

  const data = await get('/assignments');
  activeList.innerHTML = '';
  completedList.innerHTML = '';

  if (!data.length) {
    activeList.innerHTML = '<div class="empty center muted">Belum ada tugas.</div>';
    if (el1d) el1d.textContent = '0 tugas';
    if (el3d) el3d.textContent = '0 tugas';
    if (el5d) el5d.textContent = '0 tugas';
    if (trendEl) trendEl.innerHTML = '';
    return;
  }

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
    if (trendEl) {
      const days = [];
      const base = new Date();
      for (let i = 6; i >= 0; i++) {
        const d = new Date(base);
        d.setDate(base.getDate() - i);
        days.push(d.toISOString().slice(0,10));
      }
      const counts = days.map(d => byUser.filter(a => (a.completed_at || '').slice(0,10) === d).length);
      trendEl.innerHTML = '';
      const max = Math.max(1, ...counts);
      counts.forEach(cnt => {
        const cell = document.createElement('div');
        cell.style.textAlign = 'center';
        const barBox = document.createElement('div');
        barBox.style.height = '40px';
        barBox.style.display = 'flex';
        barBox.style.alignItems = 'flex-end';
        barBox.style.justifyContent = 'center';
        const bar = document.createElement('div');
        bar.style.width = '12px';
        bar.style.height = `${Math.max(4, Math.round((cnt / max) * 40))}px`;
        bar.style.background = 'var(--secondary)';
        bar.style.borderRadius = '3px';
        barBox.appendChild(bar);
        const num = document.createElement('div');
        num.className = 'muted small';
        num.textContent = String(cnt);
        cell.appendChild(barBox);
        cell.appendChild(num);
        trendEl.appendChild(cell);
      });
    }
  } catch (_) {
    if (el1d) el1d.textContent = '—';
    if (el3d) el3d.textContent = '—';
    if (el5d) el5d.textContent = '—';
    if (trendEl) trendEl.innerHTML = '';
  }

  // Sort: Active by deadline (asc), Completed by completed_at (desc)
  const active = data.filter(a => !a.completed).sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  const completed = data.filter(a => a.completed).sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));

  const createItem = (a, isCompleted) => {
    const el = document.createElement('div');
    el.className = 'list-item assignment-item';
    
    const left = document.createElement('div');
    left.style.flex = '1';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.gap = '10px';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = isCompleted;
    cb.dataset.id = String(a.id);
    cb.dataset.action = 'toggle';
    header.appendChild(cb);

    const title = document.createElement('strong');
    title.textContent = a.title;
    header.appendChild(title);

    const ownerSel = document.createElement('select');
    ownerSel.className = 'input small';
    ownerSel.dataset.id = String(a.id);
    ownerSel.dataset.action = 'owner';
    ['Zaldy', 'Nesya'].forEach(u => {
      const opt = document.createElement('option');
      opt.value = u;
      opt.textContent = u;
      ownerSel.appendChild(opt);
    });
    ownerSel.value = getOwner(String(a.id));
    header.appendChild(ownerSel);

    left.appendChild(header);

    if (a.description) {
      const desc = document.createElement('div');
      desc.className = 'muted small';
      desc.style.marginLeft = '24px';
      desc.textContent = a.description;
      left.appendChild(desc);
    }

    const info = document.createElement('div');
    info.className = 'muted small';
    info.style.marginLeft = '24px';
    info.style.marginTop = '4px';
    info.style.display = 'flex';
    info.style.gap = '10px';

    if (isCompleted) {
      const doneTime = a.completed_at ? new Date(a.completed_at).toLocaleString() : '-';
      info.innerHTML = `<span><i class="fa-solid fa-check"></i> Selesai: ${doneTime}</span>`;
    } else {
      const dl = new Date(a.deadline).toLocaleString();
      info.innerHTML = `<span><i class="fa-solid fa-clock"></i> Deadline: ${dl}</span>`;
      
      const timer = document.createElement('span');
      timer.className = 'countdown-timer badge';
      timer.dataset.deadline = a.deadline;
      timer.dataset.title = a.title;
      timer.dataset.id = String(a.id);
      timer.textContent = '...';
      info.appendChild(timer);
    }
    left.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'actions';
    if (!isCompleted) {
      const startBtn = document.createElement('button');
      startBtn.className = 'btn small';
      startBtn.dataset.id = String(a.id);
      startBtn.dataset.action = 'start';
      startBtn.textContent = isStarted(String(a.id)) ? 'Started' : 'Start';
      actions.appendChild(startBtn);

      const snoozeBtn = document.createElement('button');
      snoozeBtn.className = 'btn small';
      snoozeBtn.dataset.id = String(a.id);
      snoozeBtn.dataset.action = 'snooze';
      snoozeBtn.textContent = 'Snooze 1h';
      actions.appendChild(snoozeBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.className = 'btn danger small';
    delBtn.dataset.id = String(a.id);
    delBtn.dataset.action = 'delete';
    delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    actions.appendChild(delBtn);

    el.appendChild(left);
    el.appendChild(actions);
    return el;
  };

  if (active.length) {
    active.forEach(a => activeList.appendChild(createItem(a, false)));
  } else {
    activeList.innerHTML = '<div class="muted center p-2">Tidak ada tugas aktif.</div>';
  }

  if (completed.length) {
    completed.forEach(a => completedList.appendChild(createItem(a, true)));
  } else {
    completedList.innerHTML = '<div class="muted center p-2">Belum ada tugas selesai.</div>';
  }

  // Restart timer loop
  if (timerInterval) clearInterval(timerInterval);
  updateTimers(); // Initial call
  timerInterval = setInterval(updateTimers, 1000); // Update every second
  const activeData = active;
  if (notifyInterval) clearInterval(notifyInterval);
  checkReminders(activeData);
  notifyInterval = setInterval(() => checkReminders(activeData), 60000);
}

async function create(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  
  const f = new FormData(e.target);
  const deadline = f.get('deadline');
  
  // Validation: deadline must be future
  if (new Date(deadline) < new Date()) {
    showToast('Deadline tidak boleh di masa lalu', 'error');
    if (btn) btn.disabled = false;
    return;
  }

  const body = { 
    title: f.get('title'), 
    description: f.get('description'),
    deadline: deadline
  };
  
  await post('/assignments', body);
  e.target.reset();
  load();
  showToast('Tugas kuliah ditambahkan', 'success');
  if (btn) btn.disabled = false;
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
    await put('/assignments', { id, completed: btn.checked });
    showToast(btn.checked ? 'Tugas selesai' : 'Tugas dibuka kembali', 'info');
  }
   if (act === 'owner') {
     setOwner(id, btn.value);
     showToast(`Pemilik tugas: ${btn.value}`, 'info');
   }
   if (act === 'start') {
     const newVal = !isStarted(id);
     setStarted(id, newVal);
     btn.textContent = newVal ? 'Started' : 'Start';
     showToast(newVal ? 'Mulai mengerjakan' : 'Berhenti menandai', 'info');
   }
   if (act === 'snooze') {
     const until = Date.now() + 3600000;
     setSnoozeUntil(id, until);
     showToast('Di-snooze 1 jam', 'info');
   }
  load();
}

function init() {
  document.querySelector('#create-assignment').addEventListener('submit', create);
  
  // Delegate events for both lists
  const handleListClick = (e) => {
    if (e.target.tagName === 'INPUT') actions(e);
    else actions(e);
  };

  document.querySelector('#assignments-active').addEventListener('click', handleListClick);
  document.querySelector('#assignments-active').addEventListener('change', handleListClick);
  
  document.querySelector('#assignments-completed').addEventListener('click', handleListClick);
  document.querySelector('#assignments-completed').addEventListener('change', handleListClick);
  
  load();
}

document.addEventListener('DOMContentLoaded', init);
