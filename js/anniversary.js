import { initProtected, showToast } from './main.js';
import { get, put } from './api.js';

let interval;

async function load() {
  initProtected();
  const data = await get('/anniversary');
  const dateEl = document.querySelector('#anniv-date');
  const noteEl = document.querySelector('#anniv-note');
  
  if (data && data.date) {
      dateEl.value = data.date.slice(0,10);
      startCountdown(data.date);
  }
  if (data && data.note) noteEl.value = data.note;
}

function startCountdown(dateStr) {
  if (interval) clearInterval(interval);
  
  const target = new Date(dateStr).getTime();
  
  function update() {
    const now = new Date().getTime();
    
    // If target is in past, maybe calculate next anniversary?
    // Or just show negative / 0
    // Assuming we want next occurrence if passed? Or just raw diff.
    // Let's do raw diff to target first.
    
    let diff = target - now;
    
    // If passed, maybe we want to target next year?
    // For now simple countdown to specific date set by user.
    
    if (diff < 0) {
        // If it's a birthday/anniversary, usually we want the next one.
        // Let's just show 00 or negative if user specifically set a past date.
        // Or if it's 0, say "Today!"
        // For simplicity:
        document.getElementById('d').innerText = '00';
        document.getElementById('h').innerText = '00';
        document.getElementById('m').innerText = '00';
        document.getElementById('s').innerText = '00';
        return;
    }
    
    const d = Math.floor(diff / (1000 * 60 * 60 * 24));
    const h = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const s = Math.floor((diff % (1000 * 60)) / 1000);
    
    document.getElementById('d').innerText = d < 10 ? '0' + d : d;
    document.getElementById('h').innerText = h < 10 ? '0' + h : h;
    document.getElementById('m').innerText = m < 10 ? '0' + m : m;
    document.getElementById('s').innerText = s < 10 ? '0' + s : s;
  }
  
  update();
  interval = setInterval(update, 1000);
}

async function save(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  const date = document.querySelector('#anniv-date').value;
  const note = document.querySelector('#anniv-note').value;
  
  try {
      await put('/anniversary', { date, note });
      showToast('Anniversary disimpan', 'success');
      startCountdown(date);
  } catch (err) {
      showToast('Gagal menyimpan', 'error');
  }
  
  if (btn) btn.disabled = false;
}

function init() {
  document.querySelector('#anniv-form').addEventListener('submit', save);
  load();
}

document.addEventListener('DOMContentLoaded', init);
