
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
    loading.innerHTML = '<div style="color:var(--nova-pink); padding: 40px;">Gagal memuat raport cosmic.</div>';
  }
}

function animateValue(id, start, end, duration, suffix = '') {
  const obj = document.getElementById(id);
  if (!obj) return;
  const range = end - start;
  let current = start;
  const increment = end > start ? 1 : -1;
  const stepTime = Math.abs(Math.floor(duration / range));

  if (range === 0) {
    obj.textContent = end + suffix;
    return;
  }

  const timer = setInterval(() => {
    current += increment;
    obj.textContent = current + suffix;
    if (current == end) {
      clearInterval(timer);
    }
  }, stepTime || 10);
}

function updateRing(id, percent) {
  const ring = document.getElementById(id);
  if (!ring) return;
  const circumference = 2 * Math.PI * 40; // r=40
  const offset = circumference - (percent / 100) * circumference;
  ring.style.strokeDasharray = `${circumference} ${circumference}`;
  ring.style.strokeDashoffset = offset;
}

function render(data) {
  // Period Label
  const start = new Date(data.period.start).toLocaleDateString();
  const end = new Date(data.period.end).toLocaleDateString();
  document.getElementById('period-label').textContent = `${start} - ${end}`;

  // Productivity
  updateCard('prod', data.productivity);
  updateRing('prod-ring', data.productivity.current);

  // Consistency
  updateCard('cons', data.consistency);
  updateRing('cons-ring', data.consistency.current);

  // AI Insights
  generateInsights(data);
}

function generateInsights(data) {
  const insightEl = document.getElementById('ai-insights');
  const mainEl = document.getElementById('insight-main');
  const tipEl = document.getElementById('insight-tip-text');
  if (!insightEl) return;

  const prod = data.productivity.current;
  const mood = data.mood.current;
  const user = localStorage.getItem('user') || 'Cosmic Traveler';

  let mainText = "";
  let tipText = "";

  // 🧠 Logic Heuristics
  if (prod > 80 && mood > 4) {
    mainText = `${user}, ritme cosmic Anda sangat harmonis. Produktivitas tinggi tetap diimbangi dengan kebahagiaan. Pertahankan momentum ini!`;
    tipText = "Momentum sangat mahal. Jangan buat perubahan drastis pada rutinitas Anda saat ini.";
  } else if (prod < 50) {
    mainText = `Sepertinya ada hambatan dalam orbit produktivitas Anda. Seringkali ini karena misi yang terlalu berat dalam satu waktu.`;
    tipText = "Coba pindahkan misi tersulit ke jam 10 Pagi besok. Analisis kami menunjukkan itu adalah jendela fokus terbaik Anda.";
  } else if (mood < 3) {
    mainText = `Fokus Anda luar biasa, namun stabilitas emosional sedikit meredup. Ingat, misi tersulit adalah menjaga koneksi hati.`;
    tipText = "Gunakan fitur Chat atau Memories untuk sejenak rehat dan sinkronisasi dengan partner malam ini.";
  } else if (data.consistency.current < 40) {
    mainText = `Ritme Anda sedikit fluktuatif. Konsistensi kecil setiap hari jauh lebih kuat daripada lonjakan besar yang melelahkan.`;
    tipText = "Gunakan fitur 'Snooze' jika misi terlalu mendesak, tapi usahakan minimal selesaikan 1 tugas kecil hari ini.";
  } else {
    mainText = `${user}, aplikasi mendeteksi pola yang stabil. Anda bergerak maju dengan kecepatan yang aman dan terkendali.`;
    tipText = "Coba tantang diri Anda dengan satu 'Mission Impossible' (Goal jangka panjang) minggu ini.";
  }

  mainEl.textContent = mainText;
  tipEl.textContent = tipText;
  insightEl.style.display = 'block';
}

function updateCard(id, stats) {
  const valEl = document.getElementById(`${id}-val`);
  const changeEl = document.getElementById(`${id}-change`);
  const prevEl = document.getElementById(`${id}-prev`);

  // Animation
  animateValue(`${id}-val`, 0, stats.current, 800, '%');
  prevEl.textContent = stats.previous + '%';

  const change = stats.change;
  const icon = change >= 0 ? 'fa-arrow-up' : 'fa-arrow-down';
  const color = change >= 0 ? 'var(--success, #4caf50)' : 'var(--nova-pink)';

  changeEl.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${Math.abs(change)}%</span>`;
  changeEl.style.color = color;
}

function updateMood(stats) {
  const valEl = document.getElementById('mood-val');
  const changeEl = document.getElementById('mood-change');
  const tagsEl = document.getElementById('mood-tags');
  const visualEl = document.getElementById('mood-visual');

  valEl.textContent = stats.current.toFixed(1);

  // Mood Visual Emojis
  const emojis = { 5: '🤩', 4: '🙂', 3: '😐', 2: '😕', 1: '😫' };
  visualEl.textContent = emojis[Math.round(stats.current)] || '✨';

  const change = stats.change;
  const icon = change >= 0 ? 'fa-arrow-up' : 'fa-arrow-down';
  const color = change >= 0 ? 'var(--success, #4caf50)' : 'var(--nova-pink)';

  changeEl.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${Math.abs(change).toFixed(1)}</span>`;
  changeEl.style.color = color;

  // Tags
  tagsEl.innerHTML = '';
  if (stats.top_tags && stats.top_tags.length) {
    stats.top_tags.forEach(tag => {
      const chip = document.createElement('div');
      chip.className = 'tag-chip';
      chip.textContent = tag;
      tagsEl.appendChild(chip);
    });
  } else {
    tagsEl.innerHTML = '<span style="color:var(--text-500);font-size:0.8rem">Belum ada data</span>';
  }
}
