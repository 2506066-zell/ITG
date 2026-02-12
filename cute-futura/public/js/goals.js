import { initProtected, showToast } from './main.js';
import { get, post, put, del } from './api.js';

let goals = [];
let evals = [];
let activeTab = 'goals';

// DOM Elements
const sheetOverlay = document.getElementById('sheet-overlay');
const sheet = document.getElementById('sheet');
const fab = document.getElementById('fab-add');
const goalForm = document.getElementById('goal-form');
const evalForm = document.getElementById('eval-form');
const sheetTitle = document.getElementById('sheet-title');

// Init
document.addEventListener('DOMContentLoaded', () => {
  initProtected();
  setupEvents();
  loadData();
});

function setupEvents() {
  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      activeTab = btn.dataset.tab;
      document.getElementById(`tab-${activeTab}`).classList.add('active');
      render();
    });
  });

  // FAB
  fab.addEventListener('click', openSheet);

  // Sheet Overlay
  sheetOverlay.addEventListener('click', (e) => {
    if (e.target === sheetOverlay) closeSheet();
  });

  // Mood Selection
  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      document.getElementById('mood-input').value = btn.dataset.val;
    });
  });

  // Forms
  goalForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(goalForm);
    try {
      await post('/goals', Object.fromEntries(fd));
      closeSheet();
      showToast('Goal created', 'success');
      loadData();
    } catch (err) { showToast('Error creating goal', 'error'); }
  });

  evalForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(evalForm);
    if (!fd.get('mood')) return showToast('Select a mood', 'error');

    try {
      await post('/evaluations', {
        mood: fd.get('mood'),
        note: fd.get('note'),
        date: new Date().toISOString()
      });
      closeSheet();
      showToast('Log saved', 'success');
      loadData();
    } catch (err) { showToast('Error saving log', 'error'); }
  });
}

async function loadData() {
  const [g, e] = await Promise.all([get('/goals'), get('/evaluations')]);
  goals = g || [];
  evals = e || [];
  render();
}

function render() {
  if (activeTab === 'goals') renderGoals();
  else renderEvals();
}

function renderGoals() {
  const list = document.getElementById('goals-list');
  list.innerHTML = '';

  if (!goals.length) {
    list.innerHTML = '<div class="empty-state" style="text-align:center;padding:40px;color:var(--muted)">No goals yet.</div>';
    return;
  }

  goals.forEach(g => {
    const el = document.createElement('div');
    el.className = 'goal-card';
    const percent = g.progress || 0;

    el.innerHTML = `
      <div class="goal-header">
        <div>
          <div class="goal-title">${g.title}</div>
          <span class="goal-cat">${g.category}</span>
        </div>
        <button class="btn danger small delete-btn" style="padding:4px 8px"><i class="fa-solid fa-trash"></i></button>
      </div>
      
      <div class="progress-track">
        <div class="progress-fill" style="width:${percent}%"></div>
      </div>
      
      <div class="goal-meta">
        <span>${percent}% Complete</span>
        <span>${g.deadline ? new Date(g.deadline).toLocaleDateString() : 'No Deadline'}</span>
      </div>
      
      <input type="range" min="0" max="100" value="${percent}" style="width:100%;margin-top:12px">
    `;

    // Sliders
    const slider = el.querySelector('input[type="range"]');
    slider.addEventListener('change', async (e) => {
      const val = parseInt(e.target.value);
      try {
        await put('/goals', { id: g.id, progress: val, version: g.version });
        loadData(); // Sync
      } catch (err) { loadData(); }
    });

    // Delete
    el.querySelector('.delete-btn').addEventListener('click', async () => {
      if (confirm('Delete goal?')) {
        await del(`/goals?id=${g.id}`);
        loadData();
      }
    });

    list.appendChild(el);
  });
}

function renderEvals() {
  const list = document.getElementById('evals-list');
  list.innerHTML = '';

  if (!evals.length) {
    list.innerHTML = '<div class="empty-state" style="text-align:center;padding:40px;color:var(--muted)">No evaluations yet.</div>';
    return;
  }

  const moods = { '1': '😫', '2': '😕', '3': '😐', '4': '🙂', '5': '🤩' };

  // Sort desc
  evals.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  evals.forEach(e => {
    const el = document.createElement('div');
    el.className = 'goal-card';
    el.style.display = 'flex';
    el.style.gap = '16px';

    el.innerHTML = `
      <div style="font-size:32px">${moods[e.mood] || '❓'}</div>
      <div style="flex:1">
        <div style="font-size:12px;color:var(--muted);margin-bottom:4px">
          ${new Date(e.created_at).toLocaleString()}
        </div>
        <div style="font-size:14px;line-height:1.4">${e.note}</div>
      </div>
      <button class="btn danger small delete-btn" style="align-self:flex-start;padding:4px 8px"><i class="fa-solid fa-trash"></i></button>
    `;

    el.querySelector('.delete-btn').addEventListener('click', async () => {
      if (confirm('Delete log?')) {
        await del(`/evaluations?id=${e.id}`);
        loadData();
      }
    });

    list.appendChild(el);
  });
}

function openSheet() {
  sheetOverlay.classList.add('active');
  sheet.classList.add('active');

  if (activeTab === 'goals') {
    sheetTitle.textContent = 'New Goal';
    goalForm.style.display = 'block';
    evalForm.style.display = 'none';
    goalForm.reset();
  } else {
    sheetTitle.textContent = 'Daily Evaluation';
    goalForm.style.display = 'none';
    evalForm.style.display = 'block';
    evalForm.reset();
    document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById('mood-input').value = '';
  }
}

function closeSheet() {
  sheetOverlay.classList.remove('active');
  sheet.classList.remove('active');
}
