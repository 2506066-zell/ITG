import { initProtected, showToast } from './main.js';
import { get, post, del } from './api.js';

const daysMap = {
  1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday'
};

async function loadSchedule() {
  const container = document.getElementById('schedule-container');
  container.innerHTML = '<div class="skeleton" style="height:200px;grid-column:1/-1"></div>';

  try {
    const data = await get('/schedule');
    container.innerHTML = '';

    const today = new Date().getDay() || 7;

    // Group by day
    const grouped = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
    data.forEach(item => {
      if (grouped[item.day_id]) grouped[item.day_id].push(item);
    });

    for (let d = 1; d <= 7; d++) {
      if (!grouped[d].length && d > 5 && d !== today) continue;

      const card = document.createElement('div');
      card.className = 'day-card';
      if (d === today) card.style.border = '1px solid var(--accent)';

      const header = document.createElement('div');
      header.className = 'day-header';
      header.innerHTML = `<span>${daysMap[d]}</span> ${d === today ? '<span class="today-badge">TODAY</span>' : ''}`;
      card.appendChild(header);

      if (!grouped[d].length) {
        const empty = document.createElement('div');
        empty.className = 'muted small center';
        empty.textContent = 'No classes.';
        card.appendChild(empty);
      } else {
        // Sort items by time
        grouped[d].sort((a, b) => a.time_start.localeCompare(b.time_start));

        grouped[d].forEach(c => {
          const item = document.createElement('div');
          item.className = 'class-item';

          // Slice seconds from time (HH:MM:SS -> HH:MM)
          const start = c.time_start.slice(0, 5);
          const end = c.time_end.slice(0, 5);

          const delBtn = document.createElement('button');
          delBtn.className = 'btn danger small';
          delBtn.style.position = 'absolute';
          delBtn.style.top = '10px';
          delBtn.style.right = '10px';
          delBtn.style.padding = '4px 8px';
          delBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
          delBtn.onclick = async () => {
            if (confirm(`Remove ${c.subject}?`)) {
              await del(`/schedule?id=${c.id}`);
              loadSchedule();
              showToast('Class removed');
            }
          };

          item.innerHTML = `
              <div class="class-time"><i class="fa-regular fa-clock"></i> ${start} - ${end}</div>
              <div style="font-weight:600; font-size:1.1rem; margin-bottom:4px;">${c.subject}</div>
              <div class="class-room"><i class="fa-solid fa-location-dot"></i> ${c.room || 'TBA'}</div>
              ${c.lecturer ? `<div class="class-lecturer"><i class="fa-solid fa-user-tie"></i> ${c.lecturer}</div>` : ''}
              <div class="muted small" style="margin-top:4px;font-size:10px">By ${c.created_by}</div>
            `;
          item.appendChild(delBtn);
          card.appendChild(item);
        });
      }
      container.appendChild(card);
    }
  } catch (err) {
    container.innerHTML = '<div class="muted center">Failed to load schedule.</div>';
  }
}

function initModal() {
  const modal = document.getElementById('modal');
  const btn = document.getElementById('open-add');
  const close = document.getElementById('close-modal');

  if (btn) btn.onclick = () => modal.classList.add('active');
  if (close) close.onclick = () => modal.classList.remove('active');

  if (modal) modal.onclick = (e) => {
    if (e.target === modal) modal.classList.remove('active');
  };

  const form = document.getElementById('add-class-form');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await post('/schedule', {
        day: parseInt(f.get('day')),
        start: f.get('start'),
        end: f.get('end'),
        subject: f.get('subject'),
        room: f.get('room'),
        lecturer: f.get('lecturer')
      });

      e.target.reset();
      modal.classList.remove('active');
      loadSchedule();
      showToast('Class added!', 'success');
    } catch (err) {
      showToast('Failed to add class', 'error');
    }
  });
}

function init() {
  initProtected();
  initModal();
  loadSchedule();
}

document.addEventListener('DOMContentLoaded', init);
