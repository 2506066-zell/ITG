import { initProtected, showToast } from './main.js';
import { get, post, put, del } from './api.js';

let timerInterval;

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
    // Urgent logic: < 12 hours (12 * 60 * 60 * 1000 = 43200000)
    if (diff > 0 && diff < 43200000) {
      if (!parent.classList.contains('urgent')) {
        parent.classList.add('urgent');
        // Trigger notification only once per session logic could be added here
        // For now simple check to avoid spamming
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
  
  // Skeleton
  activeList.innerHTML = `<div class="list-item"><div class="skeleton skeleton-line" style="width:70%"></div></div>`;
  completedList.innerHTML = '';

  const data = await get('/assignments');
  activeList.innerHTML = '';
  completedList.innerHTML = '';

  if (!data.length) {
    activeList.innerHTML = '<div class="empty center muted">Belum ada tugas.</div>';
    return;
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
      timer.textContent = '...';
      info.appendChild(timer);
    }
    left.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'actions';
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
  load();
}

function init() {
  document.querySelector('#create-assignment').addEventListener('submit', create);
  
  // Delegate events for both lists
  const handleListClick = (e) => {
    if (e.target.tagName === 'INPUT') actions(e); // Checkbox change
    else actions(e); // Button click (via closest in actions)
  };

  document.querySelector('#assignments-active').addEventListener('click', handleListClick);
  document.querySelector('#assignments-active').addEventListener('change', handleListClick); // For checkbox
  
  document.querySelector('#assignments-completed').addEventListener('click', handleListClick);
  document.querySelector('#assignments-completed').addEventListener('change', handleListClick); // For checkbox
  
  load();
}

document.addEventListener('DOMContentLoaded', init);
