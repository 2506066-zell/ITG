import { initProtected, showToast } from './main.js';
import { get, post, put, del } from './api.js';

// State
let tasks = [];
let currentFilter = 'today'; // today, upcoming, completed
let currentSort = 'deadline'; // deadline, priority
let selectedIds = new Set();
let isMultiSelectMode = false;
let touchStartX = 0;
let touchStartY = 0;
let activeSwipeEl = null;

// DOM Elements
const taskListEl = document.getElementById('task-list');
const fabEl = document.getElementById('fab-add');
const sheetOverlay = document.getElementById('sheet-overlay');
const sheet = document.getElementById('sheet');
const multiToolbar = document.getElementById('multi-toolbar');
const taskForm = document.getElementById('task-form');

// Init
async function init() {
  initProtected();
  setupEventListeners();
  await loadTasks();
}

// Load Data
async function loadTasks() {
  renderSkeleton();
  try {
    tasks = await get('/tasks');
    render();
    updateHeaderStats();
  } catch (err) {
    console.error(err);
    taskListEl.innerHTML = '<div class="empty-state">Failed to load tasks. <br><button class="btn small mt-2" onclick="location.reload()">Retry</button></div>';
  }
}

// Render Logic
function render() {
  taskListEl.innerHTML = '';
  const filtered = filterTasks(tasks);
  const sorted = sortTasks(filtered);

  if (sorted.length === 0) {
    taskListEl.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-clipboard-check empty-icon"></i>
        <div>No tasks found</div>
        <div style="font-size:12px;opacity:0.5;margin-top:4px">Tap + to add one</div>
      </div>
    `;
    return;
  }

  const frag = document.createDocumentFragment();
  sorted.forEach(task => {
    const el = createTaskEl(task);
    frag.appendChild(el);
  });
  taskListEl.appendChild(frag);
}

function createTaskEl(task) {
  const el = document.createElement('div');
  el.className = `task-item ${task.completed ? 'completed' : ''}`;
  el.dataset.id = task.id;
  
  // Swipe Backgrounds
  const swipeActions = document.createElement('div');
  swipeActions.className = 'swipe-actions';
  swipeActions.innerHTML = `
    <div class="swipe-bg swipe-left"></div>
    <div class="swipe-bg swipe-right"></div>
  `;
  el.appendChild(swipeActions);

  // Content Container (for transform)
  const content = document.createElement('div');
  content.className = 'task-content-wrapper';
  content.style.display = 'flex';
  content.style.alignItems = 'center';
  content.style.gap = '12px';
  content.style.width = '100%';
  content.style.zIndex = '1';
  content.style.position = 'relative';

  // Checkbox
  const check = document.createElement('div');
  check.className = 'task-check';
  if (isMultiSelectMode) {
      check.innerHTML = selectedIds.has(String(task.id)) ? '<i class="fa-solid fa-check" style="font-size:10px"></i>' : '';
      if (selectedIds.has(String(task.id))) check.style.background = 'var(--primary)';
  } else {
      check.innerHTML = task.completed ? '<i class="fa-solid fa-check" style="font-size:10px"></i>' : '';
  }
  // Prevent click propagation for checkbox specific logic if needed, but tap on item handles it usually.
  content.appendChild(check);

  // Text Info
  const info = document.createElement('div');
  info.className = 'task-content';
  
  const title = document.createElement('div');
  title.className = 'task-title';
  title.textContent = task.title;
  info.appendChild(title);
  
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  
  // Priority Dot
  const prioDot = document.createElement('div');
  prioDot.className = `priority-dot p-${task.priority || 'medium'}`;
  meta.appendChild(prioDot);

  // Deadline
  if (task.deadline) {
    const d = new Date(task.deadline);
    // Format: "Today, 10:00" or "Nov 23"
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const timeStr = d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    const dateStr = isToday ? 'Today' : d.toLocaleDateString([], {day:'numeric', month:'short'});
    meta.appendChild(document.createTextNode(`${dateStr}, ${timeStr}`));
  }

  // Assigned
  if (task.assigned_to) {
    const tag = document.createElement('span');
    tag.className = 'meta-tag';
    tag.textContent = task.assigned_to.substring(0,1); // Initial
    meta.appendChild(tag);
  }

  info.appendChild(meta);
  content.appendChild(info);

  el.appendChild(content);

  // Interaction Handlers
  setupInteractions(el, task);

  return el;
}

function setupInteractions(el, task) {
  // Tap
  el.addEventListener('click', (e) => {
    if (activeSwipeEl) return; // Ignore tap if swiping
    
    if (isMultiSelectMode) {
      toggleSelection(task.id);
    } else {
      // Logic: Tap checkbox area -> Toggle Complete, Tap Body -> Edit
      // Simplified: Tap anywhere opens Edit, Checkbox tap Toggles.
      if (e.target.closest('.task-check')) {
        toggleComplete(task);
      } else {
        openSheet(task);
      }
    }
  });

  // Long Press
  let timer;
  el.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    activeSwipeEl = null; // Reset
    
    timer = setTimeout(() => {
      if (!isMultiSelectMode) {
        enterMultiSelectMode(task.id);
        navigator.vibrate?.(50);
      }
    }, 500);
  }, {passive: true});

  el.addEventListener('touchend', () => clearTimeout(timer));
  el.addEventListener('touchmove', (e) => {
    const diffY = Math.abs(e.touches[0].clientY - touchStartY);
    if (diffY > 10) clearTimeout(timer); // Cancel on scroll
    
    // Horizontal Swipe Logic
    if (isMultiSelectMode) return;
    const diffX = e.touches[0].clientX - touchStartX;
    
    // Only handle horizontal
    if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 20) {
       // e.preventDefault(); // Passive listener issue, can't preventDefault here easily without active listener
       // Just visual feedback here
       const content = el.querySelector('.task-content-wrapper');
       content.style.transform = `translateX(${diffX}px)`;
       
       const leftBg = el.querySelector('.swipe-left'); // Edit/Delete (Swipe Right -> Left?) No.
       // Swipe Right (diffX > 0) -> Complete (Green)
       // Swipe Left (diffX < 0) -> Delete (Red)
       
       if (diffX > 0) {
         el.querySelector('.swipe-left').style.opacity = Math.min(diffX / 100, 1);
       } else {
         el.querySelector('.swipe-right').style.opacity = Math.min(Math.abs(diffX) / 100, 1);
       }
       
       activeSwipeEl = el;
    }
  }, {passive: true});

  el.addEventListener('touchend', (e) => {
    if (!activeSwipeEl) return;
    const diffX = e.changedTouches[0].clientX - touchStartX;
    const content = el.querySelector('.task-content-wrapper');
    
    if (Math.abs(diffX) > 100) {
      // Trigger Action
      if (diffX > 0) {
        // Right Swipe -> Complete
        toggleComplete(task);
      } else {
        // Left Swipe -> Delete
        if (confirm('Delete task?')) deleteTask(task.id);
      }
      // Reset anim
      content.style.transition = 'transform 0.2s';
      content.style.transform = 'translateX(0)';
      setTimeout(() => {
         content.style.transition = '';
         el.querySelector('.swipe-left').style.opacity = 0;
         el.querySelector('.swipe-right').style.opacity = 0;
      }, 200);
    } else {
      // Bounce back
      content.style.transition = 'transform 0.2s';
      content.style.transform = 'translateX(0)';
      el.querySelector('.swipe-left').style.opacity = 0;
      el.querySelector('.swipe-right').style.opacity = 0;
    }
    activeSwipeEl = null;
  });
}

// Logic Helpers
function filterTasks(list) {
  const now = new Date();
  now.setHours(0,0,0,0);
  
  return list.filter(t => {
    const d = t.deadline ? new Date(t.deadline) : null;
    if (d) d.setHours(0,0,0,0);

    if (currentFilter === 'completed') return t.completed;
    if (t.completed) return false; // Hide completed in other tabs
    
    if (currentFilter === 'today') {
      // Show tasks with deadline today or earlier (overdue), or no deadline? 
      // Planner usually: No deadline = Backlog/Anytime. Today = Today + Overdue.
      if (!d) return true; // Show no-deadline tasks in Today for visibility
      return d <= now;
    }
    if (currentFilter === 'upcoming') {
      return d && d > now;
    }
    return true;
  });
}

function sortTasks(list) {
  return list.sort((a, b) => {
    if (currentSort === 'priority') {
      const pMap = { high: 3, medium: 2, low: 1 };
      return (pMap[b.priority] || 2) - (pMap[a.priority] || 2);
    }
    // Default deadline sort
    const da = a.deadline ? new Date(a.deadline).getTime() : Infinity;
    const db = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    return da - db;
  });
}

function updateHeaderStats() {
  const completed = tasks.filter(t => t.completed).length;
  const total = tasks.length;
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  
  document.getElementById('completed-count').textContent = completed;
  document.getElementById('total-count').textContent = total;
  document.getElementById('percent-count').textContent = percent + '%';
  document.getElementById('progress-fill').style.width = percent + '%';
}

// Actions
async function toggleComplete(task) {
  // Optimistic UI
  task.completed = !task.completed;
  render(); 
  updateHeaderStats();
  
  try {
    await put('/tasks', { id: task.id, completed: task.completed, version: task.version });
    showToast(task.completed ? 'Task completed' : 'Task reopened', 'success');
    loadTasks(); // Sync version
  } catch (e) {
    // Revert
    task.completed = !task.completed;
    render();
    showToast('Failed to update', 'error');
  }
}

async function deleteTask(id) {
  // Optimistic
  tasks = tasks.filter(t => t.id !== id);
  render();
  updateHeaderStats();
  
  try {
    await del(`/tasks?id=${id}`);
    showToast('Task deleted');
  } catch (e) {
    loadTasks();
    showToast('Failed to delete', 'error');
  }
}

// Multi Select
function enterMultiSelectMode(initialId) {
  isMultiSelectMode = true;
  selectedIds.clear();
  selectedIds.add(String(initialId));
  fabEl.style.display = 'none';
  multiToolbar.classList.add('active');
  render();
  updateMultiToolbar();
}

function exitMultiSelectMode() {
  isMultiSelectMode = false;
  selectedIds.clear();
  fabEl.style.display = 'flex';
  multiToolbar.classList.remove('active');
  render();
}

function toggleSelection(id) {
  const sid = String(id);
  if (selectedIds.has(sid)) selectedIds.delete(sid);
  else selectedIds.add(sid);
  
  if (selectedIds.size === 0) exitMultiSelectMode();
  else {
      render();
      updateMultiToolbar();
  }
}

function updateMultiToolbar() {
  document.getElementById('selected-count').textContent = selectedIds.size;
}

// Bottom Sheet
function openSheet(task = null) {
  const isEdit = !!task;
  document.getElementById('sheet-title').textContent = isEdit ? 'Edit Task' : 'New Task';
  
  // Reset Form
  taskForm.reset();
  document.querySelectorAll('.prio-btn').forEach(b => b.classList.remove('active'));
  
  if (isEdit) {
    document.getElementById('task-id').value = task.id;
    document.getElementById('task-title').value = task.title;
    if (task.deadline) document.getElementById('task-deadline').value = task.deadline.slice(0,16); // format for datetime-local
    if (task.assigned_to) document.getElementById('task-assigned').value = task.assigned_to;
    
    const prio = task.priority || 'medium';
    document.getElementById('task-priority').value = prio;
    document.querySelector(`.prio-btn[data-val="${prio}"]`).classList.add('active');
  } else {
    document.getElementById('task-id').value = '';
    document.querySelector('.prio-btn[data-val="medium"]').classList.add('active');
    // Default assigned to current user? Handled by backend if null.
  }
  
  sheetOverlay.classList.add('active');
  sheet.classList.add('active');
}

function closeSheet() {
  sheetOverlay.classList.remove('active');
  sheet.classList.remove('active');
  document.activeElement?.blur();
}

// Event Listeners
function setupEventListeners() {
  // Filter Chips
  document.querySelectorAll('.filter-chip[data-filter]').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      currentFilter = el.dataset.filter;
      render();
    });
  });

  // FAB
  fabEl.addEventListener('click', () => openSheet(null));

  // Sheet
  document.getElementById('sheet-cancel').addEventListener('click', closeSheet);
  sheetOverlay.addEventListener('click', (e) => {
    if (e.target === sheetOverlay) closeSheet();
  });

  // Priority Selector
  document.querySelectorAll('.prio-btn').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.prio-btn').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('task-priority').value = el.dataset.val;
    });
  });

  // Form Submit
  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(taskForm);
    const data = Object.fromEntries(fd.entries());
    
    const isEdit = !!data.id;
    const method = isEdit ? put : post;
    
    try {
      await method('/tasks', data);
      closeSheet();
      showToast(isEdit ? 'Task updated' : 'Task created', 'success');
      loadTasks();
    } catch (err) {
      showToast('Error saving task', 'error');
    }
  });
  
  // Multi Actions
  document.getElementById('bulk-delete').addEventListener('click', async () => {
      if (!confirm(`Delete ${selectedIds.size} tasks?`)) return;
      // In real app, bulk API. Here loop.
      for (const id of selectedIds) {
          await del(`/tasks?id=${id}`);
      }
      exitMultiSelectMode();
      loadTasks();
      showToast('Tasks deleted');
  });
  
  document.getElementById('bulk-complete').addEventListener('click', async () => {
      // Loop
      for (const id of selectedIds) {
          const t = tasks.find(x => String(x.id) === id);
          if (t && !t.completed) {
              await put('/tasks', { id: t.id, completed: true, version: t.version });
          }
      }
      exitMultiSelectMode();
      loadTasks();
      showToast('Tasks completed');
  });
}

function renderSkeleton() {
  taskListEl.innerHTML = `
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
  `;
}

document.addEventListener('DOMContentLoaded', init);
