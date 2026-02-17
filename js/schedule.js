import { initProtected, showToast } from './main.js';
import { get, post, del } from './api.js';

const daysMap = {
  1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday'
};

// State
let scheduleData = [];
let currentView = 'grid'; // grid, orbit

async function loadSchedule() {
  const container = document.getElementById('schedule-container');
  const orbContainer = document.getElementById('orbital-view');
  const adviceBox = document.getElementById('assistant-box');

  if (currentView === 'grid') {
    container.style.display = 'grid';
    orbContainer.classList.remove('active');
    adviceBox.style.display = 'none';
  } else {
    container.style.display = 'none';
    orbContainer.classList.add('active');
    adviceBox.style.display = 'flex';
  }

  container.innerHTML = '<div class="skeleton" style="height:200px;grid-column:1/-1"></div>';

  try {
    scheduleData = await get('/schedule');
    renderGridView();
    renderOrbitalView();
    updateAssistantAdvice();
  } catch (err) {
    container.innerHTML = '<div class="muted center">Failed to load schedule.</div>';
  }
}

function renderGridView() {
  const container = document.getElementById('schedule-container');
  container.innerHTML = '';
  const today = new Date().getDay() || 7;
  const grouped = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };

  scheduleData.forEach(item => {
    if (grouped[item.day_id]) grouped[item.day_id].push(item);
  });

  for (let d = 1; d <= 6; d++) {
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
      grouped[d].sort((a, b) => a.time_start.localeCompare(b.time_start));
      grouped[d].forEach(c => {
        const item = document.createElement('div');
        item.className = 'class-item';
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
            <div class="class-subject">${c.subject}</div>
            <div class="class-room"><i class="fa-solid fa-location-dot"></i> ${c.room || 'TBA'}</div>
            ${c.lecturer ? `<div class="class-lecturer"><i class="fa-solid fa-user-tie"></i> ${c.lecturer}</div>` : ''}
          `;
        item.appendChild(delBtn);
        card.appendChild(item);
      });
    }
    container.appendChild(card);
  }
}

function renderOrbitalView() {
  const staticLayer = document.getElementById('orbit-static-layer');
  const segmentLayer = document.getElementById('orbit-segments-layer');
  if (!staticLayer || !segmentLayer) return;

  staticLayer.innerHTML = '';
  segmentLayer.innerHTML = '';

  const CX = 250, CY = 250, R = 180;
  const today = new Date().getDay() || 7;
  const todayClasses = scheduleData.filter(c => c.day_id === today);

  // 🕒 Render Hour Marks (24h)
  for (let i = 0; i < 24; i++) {
    const angle = (i * 15 - 90) * (Math.PI / 180);
    const x1 = CX + (R - 10) * Math.cos(angle);
    const y1 = CY + (R - 10) * Math.sin(angle);
    const x2 = CX + (R + 10) * Math.cos(angle);
    const y2 = CY + (R + 10) * Math.sin(angle);

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1); line.setAttribute("y1", y1);
    line.setAttribute("x2", x2); line.setAttribute("y2", y2);
    line.setAttribute("class", `orbit-hour-line ${i % 6 === 0 ? 'major' : ''}`);
    staticLayer.appendChild(line);

    if (i % 3 === 0) {
      const tx = CX + (R + 30) * Math.cos(angle);
      const ty = CY + (R + 30) * Math.sin(angle);
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", tx); text.setAttribute("y", ty);
      text.setAttribute("fill", "hsla(0,0%,100%,0.3)");
      text.setAttribute("font-size", "10");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "middle");
      text.textContent = i;
      staticLayer.appendChild(text);
    }
  }

  // 🚀 Render Class Segments
  todayClasses.forEach(c => {
    const startHour = parseInt(c.time_start.split(':')[0]) + (parseInt(c.time_start.split(':')[1]) / 60);
    const endHour = parseInt(c.time_end.split(':')[0]) + (parseInt(c.time_end.split(':')[1]) / 60);

    const startAngle = (startHour * 15 - 90);
    const endAngle = (endHour * 15 - 90);

    const path = describeArc(CX, CY, R, startAngle, endAngle);
    const segment = document.createElementNS("http://www.w3.org/2000/svg", "path");
    segment.setAttribute("d", path);
    segment.setAttribute("class", "schedule-segment");

    // Resonance Detection (Overlapping logic placeholder)
    const isResonant = todayClasses.some(other => {
      if (other.id === c.id) return false;
      const os = parseInt(other.time_start.split(':')[0]) + (parseInt(other.time_start.split(':')[1]) / 60);
      return (os >= startHour && os < endHour);
    });
    if (isResonant) segment.classList.add('resonance-high');

    segment.onclick = () => showToast(`Class: ${c.subject} (${c.time_start.slice(0, 5)})`, 'info');
    segmentLayer.appendChild(segment);
  });

  updateTimeHand(CX, CY, R);
}

function updateTimeHand(cx, cy, r) {
  const now = new Date();
  const hours = now.getHours() + (now.getMinutes() / 60);
  const angle = (hours * 15 - 90) * (Math.PI / 180);
  const x2 = cx + (r + 40) * Math.cos(angle);
  const y2 = cy + (r + 40) * Math.sin(angle);

  const hand = document.getElementById('time-hand');
  if (hand) {
    hand.setAttribute("x2", x2);
    hand.setAttribute("y2", y2);
  }
}

function updateAssistantAdvice() {
  const textEl = document.getElementById('advice-text');
  if (!textEl) return;

  const today = new Date().getDay() || 7;
  const todayClasses = scheduleData.filter(c => c.day_id === today);

  if (todayClasses.length === 0) {
    textEl.textContent = "Orbit Anda bersih hari ini, Zaldy! Waktu sempurna untuk 'Deep Work' atau merencanakan kejutan untuk Nesya. ✨";
    return;
  }

  // Find Resonance (High Density)
  let resonantCount = 0;
  todayClasses.forEach(c => {
    const sh = parseInt(c.time_start.split(':')[0]);
    const overlap = todayClasses.find(o => o.id !== c.id && parseInt(o.time_start.split(':')[0]) === sh);
    if (overlap) resonantCount++;
  });

  if (resonantCount > 0) {
    textEl.innerHTML = "Ada <strong>Resonansi Tinggi</strong> di jadwalmu. Beberapa kelas berdekatan—pastikan siapkan energi ekstra atau geser tugas ringan ke sore hari. ⚡";
  } else if (todayClasses.length > 4) {
    textEl.textContent = "Hari yang padat! Fokus pada satu misi di setiap jendela waktu agar tetap tenang di orbitmu. 🧘";
  } else {
    textEl.textContent = "Jadwal stabil. Manfaatkan jendela waktu kosong untuk mencicil project besar! 🚀";
  }
}

// SVG Utils
function polarToCartesian(centerX, centerY, radius, angleInDegrees) {
  var angleInRadians = (angleInDegrees) * Math.PI / 180.0;
  return {
    x: centerX + (radius * Math.cos(angleInRadians)),
    y: centerY + (radius * Math.sin(angleInRadians))
  };
}

function describeArc(x, y, radius, startAngle, endAngle) {
  var start = polarToCartesian(x, y, radius, endAngle);
  var end = polarToCartesian(x, y, radius, startAngle);
  var largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  var d = [
    "M", start.x, start.y,
    "A", radius, radius, 0, largeArcFlag, 0, end.x, end.y,
    "L", x, y,
    "Z"
  ].join(" ");
  return d;
}

function initViewToggle() {
  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentView = btn.dataset.view;
      loadSchedule();
    };
  });
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
  initViewToggle();
  loadSchedule();
}

document.addEventListener('DOMContentLoaded', init);
