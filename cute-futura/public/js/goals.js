import { initProtected, showToast } from './main.js';
import { get, post, put, del } from './api.js';

// TABS LOGIC
function initTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      t.classList.add('active');
      document.getElementById(`tab-${t.dataset.tab}`).classList.add('active');
    });
  });
}

// MOOD LOGIC
function initMood() {
  const btns = document.querySelectorAll('.mood-btn');
  btns.forEach(b => {
    b.addEventListener('click', () => {
      btns.forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      document.getElementById('mood-input').value = b.dataset.value;
    });
  });
}

// GOALS LOGIC
async function loadGoals() {
  const list = document.getElementById('goals-list');
  list.innerHTML = '<div class="skeleton skeleton-line"></div>';
  const data = await get('/goals');
  list.innerHTML = '';
  
  if (!data.length) {
    list.innerHTML = '<div class="muted center">No goals set yet.</div>';
    return;
  }

  data.forEach(g => {
    const el = document.createElement('div');
    el.className = 'list-item';
    el.style.display = 'block'; // Override flex for block layout
    
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    
    const title = document.createElement('div');
    title.innerHTML = `<strong>${g.title}</strong> <span class="badge">${g.category}</span>`;
    
    const delBtn = document.createElement('button');
    delBtn.className = 'btn danger small';
    delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    delBtn.onclick = async () => {
      if (confirm('Delete goal?')) {
        await del(`/goals?id=${g.id}`);
        loadGoals();
        showToast('Goal deleted');
      }
    };
    
    header.appendChild(title);
    header.appendChild(delBtn);
    
    const meta = document.createElement('div');
    meta.className = 'muted small';
    meta.style.marginTop = '4px';
    const dl = g.deadline ? new Date(g.deadline).toLocaleDateString() : 'No deadline';
    meta.textContent = `Target: ${dl} • Progress: ${g.progress}%`;
    
    const progCont = document.createElement('div');
    progCont.className = 'progress-container';
    
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    bar.style.width = `${g.progress}%`;
    
    // Slider for updating progress
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = 0;
    slider.max = 100;
    slider.value = g.progress;
    slider.style.width = '100%';
    slider.style.marginTop = '8px';
    slider.onchange = async (e) => {
      const res = await put('/goals', { 
        id: g.id, 
        progress: parseInt(e.target.value),
        version: g.version
      });

      if (res.error) {
        showToast(res.error, 'error');
        if (res.error.includes('Conflict')) {
            loadGoals();
        } else {
            e.target.value = g.progress;
        }
        return;
      }

      loadGoals();
    };
    
    progCont.appendChild(bar);
    
    el.appendChild(header);
    el.appendChild(meta);
    el.appendChild(progCont);
    el.appendChild(slider);
    
    list.appendChild(el);
  });
}

async function createGoal(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  await post('/goals', {
    title: f.get('title'),
    category: f.get('category'),
    deadline: f.get('deadline')
  });
  e.target.reset();
  loadGoals();
  showToast('Goal set!', 'success');
}

// EVALUATIONS LOGIC
async function loadEvals() {
  const list = document.getElementById('evals-list');
  list.innerHTML = '<div class="skeleton skeleton-line"></div>';
  const data = await get('/evaluations');
  list.innerHTML = '';
  
  if (!data.length) {
    list.innerHTML = '<div class="muted center">No evaluations yet.</div>';
    return;
  }

  // Sort newest first
  data.sort((a, b) => b.id - a.id);

  const moods = { '1': '😫', '2': '😕', '3': '😐', '4': '🙂', '5': '🤩' };

  data.forEach(e => {
    const el = document.createElement('div');
    el.className = 'list-item';
    el.style.alignItems = 'flex-start';
    
    const icon = document.createElement('div');
    icon.style.fontSize = '24px';
    icon.style.marginRight = '10px';
    icon.textContent = moods[e.mood] || '❓';
    
    const content = document.createElement('div');
    content.style.flex = 1;
    
    const date = new Date(e.created_at).toLocaleString();
    content.innerHTML = `<div class="muted small">${date}</div><div>${e.note}</div>`;
    
    const delBtn = document.createElement('button');
    delBtn.className = 'btn danger small';
    delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    delBtn.onclick = async () => {
      if (confirm('Delete log?')) {
        await del(`/evaluations?id=${e.id}`);
        loadEvals();
        showToast('Log deleted');
      }
    };
    
    el.appendChild(icon);
    el.appendChild(content);
    el.appendChild(delBtn);
    list.appendChild(el);
  });
}

async function createEval(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const mood = f.get('mood');
  if (!mood) {
    showToast('Please select a mood', 'error');
    return;
  }
  
  await post('/evaluations', {
    mood: mood,
    note: f.get('note'),
    date: new Date().toISOString()
  });
  
  e.target.reset();
  document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('mood-input').value = '';
  
  loadEvals();
  showToast('Evaluation saved!', 'success');
}

function init() {
  initProtected();
  initTabs();
  initMood();
  
  document.getElementById('create-goal').addEventListener('submit', createGoal);
  document.getElementById('create-eval').addEventListener('submit', createEval);
  
  loadGoals();
  loadEvals();
}

document.addEventListener('DOMContentLoaded', init);
