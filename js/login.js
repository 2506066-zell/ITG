import { apiFetch } from './api.js';
import { showToast, registerSW } from './main.js';

function init() {
  registerSW();
  initVisuals();

  const form = document.querySelector('#login-form');
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

  // --- ☄️ AUTONOMOUS 3D WANDERER LOGIC ---
  let currentX = window.innerWidth / 2;
  let currentY = window.innerHeight / 3;
  let currentZ = 0;
  let targetX = currentX;
  let targetY = currentY;
  let targetZ = 0;
  let rotX = 0, rotY = 0;

  // Mouse Influence
  let mouseX = 0, mouseY = 0;
  window.addEventListener('mousemove', e => {
    mouseX = (e.clientX - window.innerWidth / 2) * 0.05;
    mouseY = (e.clientY - window.innerHeight / 2) * 0.05;
  });

  function updateTarget() {
    // Wanders to random parts of the screen
    const padding = 100;
    targetX = padding + Math.random() * (window.innerWidth - padding * 2);
    targetY = padding + Math.random() * (window.innerHeight - padding * 2);
    targetZ = Math.random() * 100 - 50; // Forward/Backward

    setTimeout(updateTarget, 3000 + Math.random() * 4000);
  }
  updateTarget();

  function animateWanderer() {
    // Smooth Lerp
    currentX += (targetX - currentX) * 0.005;
    currentY += (targetY - currentY) * 0.005;
    currentZ += (targetZ - currentZ) * 0.005;

    // Subtle 3D Rotation based on movement
    rotX += ((targetY - currentY) * 0.1 - rotX) * 0.02;
    rotY += ((currentX - targetX) * 0.1 - rotY) * 0.02;

    if (container) {
      // Offset from center because container is fixed 50/50
      const offsetX = currentX - window.innerWidth / 2 + mouseX;
      const offsetY = currentY - window.innerHeight / 2 + mouseY;

      container.style.transform = `
        translate3d(${offsetX}px, ${offsetY}px, ${currentZ}px) 
        rotateX(${rotX}deg) 
        rotateY(${rotY}deg)
      `;
    }
    requestAnimationFrame(animateWanderer);
  }
  animateWanderer();

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
