import { initProtected, showToast } from './main.js';
import { get, post, put, del } from './api.js';

// State
let tasks = [];
let goals = [];
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
const moodOverlay = document.getElementById('mood-overlay');
const moodSheet = document.getElementById('mood-sheet');
const moodForm = document.getElementById('mood-form');
const moodGrid = document.getElementById('mood-grid');
const moodValueEl = document.getElementById('mood-value');
const moodNoteEl = document.getElementById('mood-note');

// Init
async function init() {
  initProtected();
  setupEventListeners();
  await Promise.all([loadTasks(), fetchGoals()]);
  setupMoodEvents();
}

async function fetchGoals() {
  try {
    const list = await get('/goals');
    goals = list.filter(g => !g.completed && !g.is_deleted);
    populateGoalSelector();
  } catch (err) {
    console.error('Failed to load goals', err);
  }
}

function populateGoalSelector() {
  const sel = document.getElementById('task-goal');
  if (!sel) return;
  sel.innerHTML = '<option value="">None</option>';
  goals.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.title;
    sel.appendChild(opt);
  });
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

  // Split by User
  // For 'today' and 'upcoming' filter, we split.
  // For 'completed', maybe just one list or split too? Let's split for consistency.

  const users = ['Nesya', 'Zaldy'];
  const grouped = { Nesya: [], Zaldy: [], Other: [] };

  // Custom sorting for grouped items
  const processList = (list) => {
    // Sort within group
    return sortTasks(list);
  };

  sorted.forEach(task => {
    const assignee = task.assigned_to || 'Other';
    if (users.includes(assignee)) {
      grouped[assignee].push(task);
    } else {
      grouped.Other.push(task);
    }
  });

  const createSection = (title, taskList) => {
    if (taskList.length === 0) return document.createDocumentFragment();

    const sec = document.createElement('div');
    sec.className = 'task-section';
    sec.style.marginBottom = '24px';

    const head = document.createElement('div');
    head.className = 'section-header';
    head.style.padding = '0 16px 8px';
    head.style.fontSize = '12px';
    head.style.fontWeight = '700';
    head.style.color = 'var(--text-muted)';
    head.style.textTransform = 'uppercase';
    head.style.letterSpacing = '1px';
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.gap = '8px';

    // Avatar/Icon for section
    const icon = title === 'Nesya' ? '<i class="fa-solid fa-venus" style="color:#ff69b4"></i>' :
      (title === 'Zaldy' ? '<i class="fa-solid fa-mars" style="color:#00bfff"></i>' : '<i class="fa-solid fa-users"></i>');

    head.innerHTML = `${icon} ${title} <span style="font-size:10px;opacity:0.7;margin-left:auto">${taskList.length}</span>`;

    sec.appendChild(head);

    taskList.forEach(task => {
      sec.appendChild(createTaskEl(task));
    });

    return sec;
  };

  taskListEl.appendChild(createSection('Nesya', grouped.Nesya));
  taskListEl.appendChild(createSection('Zaldy', grouped.Zaldy));
  if (grouped.Other.length > 0) {
    taskListEl.appendChild(createSection('Others', grouped.Other));
  }
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
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = isToday ? 'Today' : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    meta.appendChild(document.createTextNode(`${dateStr}, ${timeStr}`));
  }

  // Assigned & Completed Info
  const userMeta = document.createElement('div');
  userMeta.className = 'user-meta';
  userMeta.style.display = 'flex';
  userMeta.style.alignItems = 'center';
  userMeta.style.gap = '8px';
  userMeta.style.fontSize = '10px';
  userMeta.style.marginTop = '4px';
  userMeta.style.opacity = '0.7';

  if (task.assigned_to) {
    const assign = document.createElement('span');
    assign.innerHTML = `<i class="fa-solid fa-user-tag" style="margin-right:2px"></i> ${task.assigned_to}`;
    userMeta.appendChild(assign);
  }

  if (task.completed && task.completed_by) {
    const doneBy = document.createElement('span');
    doneBy.innerHTML = `<i class="fa-solid fa-check-double" style="margin-right:2px; color:var(--success)"></i> ${task.completed_by}`;
    userMeta.appendChild(doneBy);
  }

  info.appendChild(meta);
  if (task.assigned_to || (task.completed && task.completed_by)) {
    info.appendChild(userMeta);
  }
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
  }, { passive: true });

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
  }, { passive: true });

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
  now.setHours(0, 0, 0, 0);

  return list.filter(t => {
    const d = t.deadline ? new Date(t.deadline) : null;
    if (d) d.setHours(0, 0, 0, 0);

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
    if (task.completed) {
      openMoodPrompt(`Selesai tugas: ${task.title}`);
    }
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
    if (task.deadline) document.getElementById('task-deadline').value = task.deadline.slice(0, 16); // format for datetime-local
    if (task.assigned_to) document.getElementById('task-assigned').value = task.assigned_to;
    if (task.goal_id) document.getElementById('task-goal').value = task.goal_id;

    const prio = task.priority || 'medium';
    document.getElementById('task-priority').value = prio;
    document.querySelector(`.prio-btn[data-val="${prio}"]`).classList.add('active');

    // Snooze visible only on edit
    const snoozeSection = document.getElementById('snooze-section');
    if (snoozeSection) snoozeSection.style.display = 'block';
  } else {
    document.getElementById('task-id').value = '';
    document.getElementById('task-goal').value = '';
    document.querySelector('.prio-btn[data-val="medium"]').classList.add('active');

    const snoozeSection = document.getElementById('snooze-section');
    if (snoozeSection) snoozeSection.style.display = 'none';
  }

  sheetOverlay.classList.add('active');
  sheet.classList.add('active');
}

function closeSheet() {
  sheetOverlay.classList.remove('active');
  sheet.classList.remove('active');
  document.activeElement?.blur();
}

function setupMoodEvents() {
  if (!moodGrid) return;
  moodGrid.querySelectorAll('.prio-btn').forEach(b => {
    b.addEventListener('click', () => {
      moodGrid.querySelectorAll('.prio-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      moodValueEl.value = b.dataset.val;
    });
  });

  // Tag Chips
  const tagContainer = document.getElementById('mood-tags');
  if (tagContainer) {
    tagContainer.querySelectorAll('.tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('active');
      });
    });
  }

  document.getElementById('mood-cancel')?.addEventListener('click', () => {
    closeMoodPrompt();
  });
  moodForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = moodValueEl.value;
    if (!val) { showToast('Pilih mood', 'error'); return; }

    // Collect tags
    const tags = [];
    if (tagContainer) {
      tagContainer.querySelectorAll('.tag-chip.active').forEach(chip => {
        tags.push(chip.dataset.val);
      });
    }

    const body = { mood: val, note: moodNoteEl.value, tags: tags, date: new Date().toISOString() };
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
  if (!moodOverlay) return;
  moodValueEl.value = '';
  moodNoteEl.value = note || '';
  moodGrid.querySelectorAll('.prio-btn').forEach(x => x.classList.remove('active'));
  // Reset Tags
  const tagContainer = document.getElementById('mood-tags');
  if (tagContainer) {
    tagContainer.querySelectorAll('.tag-chip').forEach(x => x.classList.remove('active'));
  }

  moodOverlay.classList.add('active');
  moodSheet.classList.add('active');
}

function closeMoodPrompt() {
  moodOverlay.classList.remove('active');
  moodSheet.classList.remove('active');
}

// Event Listeners
function setupEventListeners() {
  // Sort Trigger
  document.getElementById('sort-trigger')?.addEventListener('click', () => {
    currentSort = currentSort === 'deadline' ? 'priority' : 'deadline';
    showToast(`Sorted by ${currentSort}`, 'info');
    render();
  });

  // Snooze Buttons
  document.querySelectorAll('.snooze-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      let mins = btn.dataset.min;
      if (mins === 'custom') {
        const input = prompt('Snooze for how many minutes?', '60');
        mins = parseInt(input);
      } else {
        mins = parseInt(mins);
      }

      const id = document.getElementById('task-id').value;
      if (!id || isNaN(mins)) return;

      try {
        await post('/tasks/snooze', { taskId: id, snoozeMinutes: mins });
        showToast(`Task snoozed for ${mins} mins`, 'success');
        closeSheet();
        loadTasks();
      } catch (err) {
        showToast('Failed to snooze', 'error');
      }
    });
  });

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
    openMoodPrompt('Selesai beberapa tugas');
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
