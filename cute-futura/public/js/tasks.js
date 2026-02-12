import { initProtected, showToast } from './main.js';
import { get, post, put, del } from './api.js';

const currentUser = localStorage.getItem('user') || 'Unknown';
let allTasks = [];
let currentFilter = 'all'; // 'all' | 'mine'

async function load() {
  initProtected();
  
  const activeList = document.querySelector('#tasks-active');
  const completedList = document.querySelector('#tasks-completed');
  
  // Skeleton
  activeList.innerHTML = `<div class="list-item"><div class="skeleton skeleton-line" style="width:60%"></div></div>`;
  completedList.innerHTML = '';
  
  try {
    const data = await get('/tasks');
    allTasks = data;
    render();
  } catch (err) {
    console.error(err);
    activeList.innerHTML = '<div class="muted center p-2">Gagal memuat task.</div>';
  }
}

function render() {
  const activeList = document.querySelector('#tasks-active');
  const completedList = document.querySelector('#tasks-completed');
  
  activeList.innerHTML = '';
  completedList.innerHTML = '';

  let data = allTasks;
  if (currentFilter === 'mine') {
    data = data.filter(t => t.created_by === currentUser);
  }
  
  if (!data.length) {
    activeList.innerHTML = '<div class="empty center muted">Tidak ada task yang ditemukan.</div>';
    return;
  }
  
  const active = data.filter(t => !t.completed).sort((a, b) => b.id - a.id);
  const completed = data.filter(t => t.completed).sort((a, b) => b.id - a.id);
  
  if (active.length) {
    active.forEach(t => activeList.appendChild(createItem(t, false)));
  } else {
    activeList.innerHTML = '<div class="muted center p-2">Semua beres!</div>';
  }
  
  if (completed.length) {
    completed.forEach(t => completedList.appendChild(createItem(t, true)));
  } else {
    completedList.innerHTML = '<div class="muted center p-2">Belum ada yang selesai.</div>';
  }
}

const createItem = (t, isCompleted) => {
  const el = document.createElement('div');
  el.className = 'list-item';
  
  const left = document.createElement('div');
  left.style.display = 'flex';
  left.style.alignItems = 'center';
  left.style.gap = '10px';
  
  // Badge
  const owner = t.created_by || 'System';
  const isMine = owner === currentUser;
  const badge = document.createElement('span');
  badge.className = `badge ${isMine ? 'badge-mine' : (owner === 'System' ? 'badge-system' : 'badge-other')}`;
  badge.textContent = owner.charAt(0).toUpperCase();
  badge.title = `Created by ${owner}`;
  left.appendChild(badge);
  
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = isCompleted;
  cb.dataset.id = String(t.id);
  cb.dataset.version = String(t.version || 0);
  cb.dataset.action = 'toggle';
  // Disable toggle if not mine? User requirement says "hanya owner atau admin yang dapat melakukan edit/delete"
  // But usually shared tasks can be completed by anyone. 
  // "user hanya dapat melihat dan mengedit task... yang mereka miliki atau yang dibagikan ke mereka"
  // I'll assume completion is allowed for now, or backend will reject it.
  left.appendChild(cb);
  
  const strong = document.createElement('strong');
  strong.textContent = t.title || '';
  if (isCompleted) {
    strong.style.textDecoration = 'line-through';
    strong.style.opacity = '0.7';
  }
  left.appendChild(strong);
  
  // History Info
  const historyBtn = document.createElement('button');
  historyBtn.className = 'history-btn';
  historyBtn.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i>';
  historyBtn.title = 'View History';
  historyBtn.onclick = () => showHistory(t.id, t.title);
  left.appendChild(historyBtn);
  
  const actions = document.createElement('div');
  actions.className = 'actions';
  
  const delBtn = document.createElement('button');
  delBtn.className = 'btn danger small';
  delBtn.dataset.id = String(t.id);
  delBtn.dataset.action = 'delete';
  delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
  
  // Disable delete if not owner (Visual hint only, backend enforces security)
  if (!isMine && owner !== 'System') {
      delBtn.style.opacity = '0.5';
      delBtn.title = 'Only owner can delete';
  }
  
  actions.appendChild(delBtn);
  
  el.appendChild(left);
  el.appendChild(actions);
  return el;
};

async function showHistory(id, title) {
  try {
    const logs = await get(`/activity?entity_type=task&entity_id=${id}`);
    if (!logs.length) {
      alert(`No history found for "${title}"`);
      return;
    }
    
    const msg = logs.map(l => {
        const time = new Date(l.created_at).toLocaleString();
        return `[${time}] ${l.user_id} ${l.action_type} - ${JSON.stringify(l.changes || {})}`;
    }).join('\n');
    
    alert(`History for "${title}":\n\n${msg}`);
  } catch (e) {
    showToast('Failed to load history', 'error');
  }
}

async function create(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  const title = new FormData(e.target).get('title');
  try {
      await post('/tasks', { title });
      e.target.reset();
      await load();
      showToast('Task ditambahkan', 'success');
  } catch (err) {
      showToast('Gagal menambah task', 'error');
  }
  if (btn) btn.disabled = false;
}

async function actions(e) {
  let target = e.target;
  if (target.tagName === 'I') target = target.closest('button');
  if (!target || !target.dataset.action) return;
  
  const id = target.dataset.id;
  const act = target.dataset.action;
  
  if (act === 'delete') {
    if (!confirm('Hapus task ini?')) return;
    const res = await del(`/tasks?id=${id}`);
    if (res.error) {
        showToast(res.error, 'error'); // Show 403 error here
        return;
    }
    showToast('Task dihapus', 'success');
    load(); // Reload to refresh list
  }
  if (act === 'toggle') {
    const version = target.dataset.version ? Number(target.dataset.version) : undefined;
    const res = await put('/tasks', { id, completed: target.checked, version });
    
    if (res.error) {
       showToast(res.error, 'error');
       if (res.error.includes('Conflict')) {
         await load(); 
       } else {
         target.checked = !target.checked; 
       }
       return;
    }
    
    showToast(target.checked ? 'Task selesai' : 'Task dibuka', 'info');
    if (res.version) target.dataset.version = res.version;
    // Don't reload entire list on toggle to keep UI snappy, unless necessary
    // But updating badge/history might be nice. For now keep simple.
  }
}

function init() {
  document.querySelector('#create-task').addEventListener('submit', create);
  
  const handleListClick = (e) => {
    // Only handle if it's an action button or checkbox, history btn handled separately
    if (e.target.closest('.history-btn')) return; 
    if (e.target.tagName === 'INPUT' || e.target.closest('[data-action]')) actions(e);
  };
  
  document.querySelector('#tasks-active').addEventListener('click', handleListClick);
  document.querySelector('#tasks-active').addEventListener('change', handleListClick);
  document.querySelector('#tasks-completed').addEventListener('click', handleListClick);
  document.querySelector('#tasks-completed').addEventListener('change', handleListClick);
  
  // Setup Filter Buttons
  const header = document.querySelector('.card h2');
  if (header) {
      const div = document.createElement('div');
      div.className = 'flex gap-2 mb-3 mt-2';
      div.innerHTML = `
        <button class="btn small secondary" style="background:var(--primary);color:#000" id="filter-all">All Tasks</button>
        <button class="btn small secondary" id="filter-mine">My Tasks</button>
      `;
      header.parentNode.insertBefore(div, header.nextSibling);
      
      document.getElementById('filter-all').onclick = (e) => {
          currentFilter = 'all';
          document.getElementById('filter-all').style.background = 'var(--primary)';
          document.getElementById('filter-all').style.color = '#000';
          document.getElementById('filter-mine').style.background = 'transparent';
          document.getElementById('filter-mine').style.color = 'var(--primary)';
          render();
      };
      
      document.getElementById('filter-mine').onclick = (e) => {
          currentFilter = 'mine';
          document.getElementById('filter-mine').style.background = 'var(--primary)';
          document.getElementById('filter-mine').style.color = '#000';
          document.getElementById('filter-all').style.background = 'transparent';
          document.getElementById('filter-all').style.color = 'var(--primary)';
          render();
      };
  }
  
  load();
}

document.addEventListener('DOMContentLoaded', init);
