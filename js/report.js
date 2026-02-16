
import { initProtected } from './main.js';
import { get } from './api.js';

let currentType = 'weekly';

document.addEventListener('DOMContentLoaded', () => {
  initProtected();
  setupEvents();
  loadData();
});

function setupEvents() {
  document.querySelectorAll('.filter-tab').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      el.classList.add('active');
      currentType = el.dataset.type;
      loadData();
    });
  });
}

async function loadData() {
  const loading = document.getElementById('loading');
  const content = document.getElementById('report-content');
  
  loading.style.display = 'block';
  content.style.display = 'none';

  try {
    const data = await get(`/reports?type=${currentType}`);
    render(data);
    loading.style.display = 'none';
    content.style.display = 'block';
  } catch (err) {
    console.error(err);
    loading.innerHTML = '<div style="color:red">Gagal memuat raport.</div>';
  }
}

function render(data) {
  // Period Label
  const start = new Date(data.period.start).toLocaleDateString();
  const end = new Date(data.period.end).toLocaleDateString();
  document.getElementById('period-label').textContent = `${start} - ${end}`;

  // Productivity
  updateCard('prod', data.productivity);

  // Consistency
  updateCard('cons', data.consistency);

  // Mood
  updateMood(data.mood);
}

function updateCard(id, stats) {
  const valEl = document.getElementById(`${id}-val`);
  const changeEl = document.getElementById(`${id}-change`);
  const prevEl = document.getElementById(`${id}-prev`);

  valEl.textContent = stats.current;
  prevEl.textContent = stats.previous;

  const change = stats.change;
  const icon = change >= 0 ? 'fa-arrow-up' : 'fa-arrow-down';
  const color = change >= 0 ? 'var(--success, #4caf50)' : 'var(--danger, #f44336)';
  
  changeEl.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${Math.abs(change)}%</span>`;
  changeEl.style.color = color;
}

function updateMood(stats) {
  const valEl = document.getElementById('mood-val');
  const changeEl = document.getElementById('mood-change');
  const tagsEl = document.getElementById('mood-tags');

  valEl.textContent = stats.current.toFixed(1);
  
  const change = stats.change;
  const icon = change >= 0 ? 'fa-arrow-up' : 'fa-arrow-down';
  const color = change >= 0 ? 'var(--success, #4caf50)' : 'var(--danger, #f44336)';
  
  changeEl.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${Math.abs(change)}</span>`;
  changeEl.style.color = color;

  // Tags
  tagsEl.innerHTML = '';
  if (stats.top_tags && stats.top_tags.length) {
    stats.top_tags.forEach(tag => {
      const chip = document.createElement('div');
      chip.className = 'tag-chip';
      chip.textContent = tag;
      chip.style.fontSize = '12px';
      chip.style.padding = '4px 10px';
      tagsEl.appendChild(chip);
    });
  } else {
    tagsEl.innerHTML = '<span style="color:var(--muted);font-size:12px">Belum ada data</span>';
  }
}
