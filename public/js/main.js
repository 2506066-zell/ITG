function requireAuth() {
  const t = localStorage.getItem('token');
  if (!t) location.href = '/login.html';
}

/** @deprecated Use registerSW instead */
export function disableSW() {
  console.log('SW Disable called (Deprecated)');
}
export async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      console.log('SW Registered:', registration.scope);
    } catch (err) {
      console.error('SW Registration failed:', err);
    }
  }
}
function loadTheme() {
  const t = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', t);
}
export function setTheme(t) {
  localStorage.setItem('theme', t);
  document.documentElement.setAttribute('data-theme', t);
}
function ensureToastRoot() {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  return el;
}
export function showToast(text, type = 'info', timeout = 2500) {
  const root = ensureToastRoot();
  const item = document.createElement('div');
  item.className = 'toast-item';
  if (type === 'error') item.style.background = 'rgba(225,29,72,0.9)';
  if (type === 'success') item.style.background = 'rgba(34,197,94,0.9)';
  item.textContent = text;
  root.appendChild(item);
  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transform = 'translateY(6px)';
    setTimeout(() => item.remove(), 220);
  }, timeout);
}
export function initProtected() {
  requireAuth();
  registerSW();
  loadTheme();
  setReducedMotion();
  startHeroTimer();
  initParallax();
}

function setReducedMotion() {
  const noAnim = window.innerWidth < 768;
  document.body.classList.toggle('no-anim', noAnim);
  window.addEventListener('resize', () => {
    const noAnimNow = window.innerWidth < 768;
    document.body.classList.toggle('no-anim', noAnimNow);
  });
}

function initParallax() {
  const bg = document.querySelector('.galaxy-bg');
  if (!bg || window.innerWidth < 768 || document.body.classList.contains('no-anim')) return;

  const nebulae = document.querySelectorAll('.nebula');
  const stars = document.querySelector('.stars-container');
  const planets = document.querySelector('.planet-container');

  window.addEventListener('mousemove', (e) => {
    const x = (e.clientX / window.innerWidth - 0.5) * 2; // -1 to 1
    const y = (e.clientY / window.innerHeight - 0.5) * 2;

    nebulae.forEach((n, i) => {
      const depth = (i + 1) * 10;
      n.style.transform = `translate(${x * depth}px, ${y * depth}px)`;
    });

    if (stars) {
      stars.style.transform = `translate(${x * 5}px, ${y * 5}px) rotate(${x * 0.5}deg)`;
    }

    if (planets) {
      planets.style.transform = `translate(${x * 20}px, ${y * 15}px)`;
    }
  });
}

function startHeroTimer() {
  const heroTimer = document.getElementById('countdown');
  if (!heroTimer) return;

  const startDate = new Date('2025-11-23T00:00:00').getTime();
  const elDays = document.getElementById('t-days');
  const elHours = document.getElementById('t-hours');
  const elMinutes = document.getElementById('t-minutes');
  const elSeconds = document.getElementById('t-seconds');

  function updateHero() {
    const now = Date.now();
    let diff = Math.abs(now - startDate);

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    const pad = (n) => n.toString().padStart(2, '0');

    if (elDays) elDays.textContent = pad(days);
    if (elHours) elHours.textContent = pad(hours);
    if (elMinutes) elMinutes.textContent = pad(minutes);
    if (elSeconds) elSeconds.textContent = pad(seconds);
  }

  updateHero();
  setInterval(updateHero, 1000);
}
export function logout() {
  localStorage.removeItem('token');
  location.href = '/login.html';
}

export function normalizeLinks() { }

// PWA Install Prompt
window.deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.deferredPrompt = e;
  // Dispatch event so other pages can react
  document.dispatchEvent(new CustomEvent('pwa-installable'));
});

if (typeof window !== 'undefined') {
}
