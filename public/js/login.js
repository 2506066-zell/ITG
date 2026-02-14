import { apiFetch } from './api.js';
import { showToast, registerSW } from './main.js';

function init() {
  registerSW();
  initVisuals();

  const form = document.querySelector('#login-form');
  const card = document.querySelector('#login-card');
  const sun = document.querySelector('#sun-trigger');
  const overlay = document.querySelector('#login-overlay');
  if (card) card.classList.remove('visible');
  if (sun && card && overlay) {
    sun.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('sun-emit', { detail: { strength: 0.95 } }));
      card.classList.add('visible');
      overlay.classList.add('show');
    });
    overlay.addEventListener('click', () => {
      card.classList.remove('visible');
      overlay.classList.remove('show');
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        card.classList.remove('visible');
        overlay.classList.remove('show');
      }
    });
  }
  if (!form) return;

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.querySelector('#login-btn');
    const btnText = btn.querySelector('.btn-text');
    const originalText = btnText.textContent;

    if (btn) btn.disabled = true;
    btnText.innerHTML = '<span class="loading-ring"></span> SYNCING...';

    const f = new FormData(form);
    const username = (f.get('username') || '').toString().trim();

    const msg = document.querySelector('#login-msg');
    if (msg) msg.textContent = '';

    try {
      const res = await apiFetch('/login', { method: 'POST', body: JSON.stringify({ username }) });
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', data.user || username);
        showToast(`Selamat datang, ${username}!`, 'success');

        // Success animation glow
        btn.style.background = 'var(--neon-blue)';
        btn.style.boxShadow = '0 0 30px var(--neon-blue)';
        btnText.textContent = 'ACCESS GRANTED';

        setTimeout(() => location.href = '/', 800);
      } else {
        const text = res.status === 401 ? 'IDENTITY NOT RECOGNIZED' : 'SYSTEM MALFUNCTION';
        if (msg) msg.textContent = text;
        showToast(text, 'error');
        btnText.textContent = originalText;
        if (btn) btn.disabled = false;
      }
    } catch (err) {
      const text = 'CONNECTION LOST';
      if (msg) msg.textContent = text;
      showToast(text, 'error');
      btnText.textContent = originalText;
      if (btn) btn.disabled = false;
    }
  });
}

function initVisuals() {
  const container = document.querySelector('.romantic-container');
  const chars = document.querySelectorAll('.nesya-char');
  chars.forEach(char => char.classList.add('show'));

  // --- 🪐 STABLE CINEMATIC DRIFTER ---
  let pos = { x: window.innerWidth / 2, y: window.innerHeight / 3, z: 0 };
  let vel = { x: (Math.random() - 0.5) * 0.5, y: (Math.random() - 0.5) * 0.5, z: (Math.random() - 0.5) * 0.2 };
  let rot = { x: 0, y: 0 };

  const STABILITY = 0.995; // High stability factor
  const CONST_SPEED = 0.4; // Fixed cinematic speed

  // Mouse Influence (Subtle Parallax)
  let mouse = { x: 0, y: 0 };
  window.addEventListener('mousemove', e => {
    mouse.x = (e.clientX - window.innerWidth / 2) * 0.05;
    mouse.y = (e.clientY - window.innerHeight / 2) * 0.05;
  });

  function driftLoop() {
    // 1. Occasional smooth direction change
    if (Math.random() < 0.005) {
      vel.x += (Math.random() - 0.5) * 0.1;
      vel.y += (Math.random() - 0.5) * 0.1;
      vel.z += (Math.random() - 0.5) * 0.05;
    }

    // 2. Normalize Velocity to keep it STABLE (Constant Speed)
    const mag = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
    vel.x = (vel.x / mag) * CONST_SPEED;
    vel.y = (vel.y / mag) * CONST_SPEED;
    vel.z = (vel.z / mag) * CONST_SPEED;

    // 3. Keep within viewport boundaries (Smooth Bounce)
    const pad = 150;
    if (pos.x < pad || pos.x > window.innerWidth - pad) vel.x *= -1;
    if (pos.y < pad || pos.y > window.innerHeight - pad) vel.y *= -1;
    if (pos.z < -120 || pos.z > 120) vel.z *= -1;

    // 4. Update Position
    pos.x += vel.x;
    pos.y += vel.y;
    pos.z += vel.z;

    // 5. Cinematic Rotation (Inertia based on drift)
    rot.x += (vel.y * 5 - rot.x) * 0.02;
    rot.y += (-vel.x * 5 - rot.y) * 0.02;

    if (container) {
      const offsetX = pos.x - window.innerWidth / 2 + mouse.x;
      const offsetY = pos.y - window.innerHeight / 2 + mouse.y;

      container.style.transform = `
        translate3d(${offsetX}px, ${offsetY}px, ${pos.z}px) 
        rotateX(${rot.x}deg) 
        rotateY(${rot.y}deg)
      `;
    }
    requestAnimationFrame(driftLoop);
  }
  driftLoop();

  // --- 💬 INTERACTION & MIST ---
  const display = document.getElementById('message-display');
  const nebula = document.querySelector('.nebula-1');
  let messageTimeout;

  // Star Mist Effect
  function createStarMist(element, color = 'var(--neon-purple)') {
    const rect = element.getBoundingClientRect();
    for (let i = 0; i < 8; i++) {
      const p = document.createElement('div');
      p.className = 'cursor-trail';
      p.style.width = Math.random() * 15 + 5 + 'px';
      p.style.height = p.style.width;
      p.style.left = (rect.left + rect.width / 2) + 'px';
      p.style.top = (rect.top + rect.height / 2) + 'px';
      p.style.background = color;
      p.style.filter = 'blur(12px)';
      p.style.opacity = '0.4';
      document.body.appendChild(p);

      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 1.2 + 0.3;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;

      let op = 0.4;
      function move() {
        p.style.left = (parseFloat(p.style.left) + vx) + 'px';
        p.style.top = (parseFloat(p.style.top) + vy) + 'px';
        op -= 0.003;
        p.style.opacity = op;
        if (op > 0) requestAnimationFrame(move);
        else p.remove();
      }
      move();
    }
  }

  chars.forEach(char => {
    char.addEventListener('click', () => {
      const msg = char.getAttribute('data-msg');
      const letter = char.getAttribute('data-letter');

      // Mist
      const mist = document.createElement('div');
      mist.className = 'mist';
      char.appendChild(mist);
      setTimeout(() => mist.remove(), 1200);

      // Nebula Pulse
      if (nebula) {
        nebula.style.transition = 'all 1.5s ease-out';
        nebula.style.opacity = '0.7';
        setTimeout(() => nebula.style.opacity = '0.4', 1500);
      }

      // Show Message
      clearTimeout(messageTimeout);
      display.classList.remove('active');

      setTimeout(() => {
        display.textContent = msg;
        display.classList.remove('special-y');
        if (letter === 'Y') display.classList.add('special-y');
        display.classList.add('active');
        messageTimeout = setTimeout(() => display.classList.remove('active'), 7000);
      }, 250);

      createStarMist(char, letter === 'Y' ? 'var(--neon-purple)' : 'var(--neon-blue)');
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
