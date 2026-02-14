import { apiFetch } from './api.js';
import { showToast, disableSW } from './main.js';

function init() {
  disableSW();
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
  // 1. Romantic Typing Animation
  const typeContainer = document.getElementById('type-text');
  const text = "I LOVE U";
  let i = 0;

  function type() {
    if (i < text.length) {
      typeContainer.textContent += text.charAt(i);
      i++;
      setTimeout(type, 150);
    } else {
      setTimeout(revealNesya, 500);
    }
  }

  setTimeout(type, 1000);

  // 2. Nesya Name Burst
  function revealNesya() {
    const chars = document.querySelectorAll('.nesya-char');
    chars.forEach((char, idx) => {
      setTimeout(() => {
        char.classList.add('show');
        createParticles(char);
      }, idx * 200);
    });
  }

  // 3. Particles Effect for Name
  function createParticles(element) {
    const rect = element.getBoundingClientRect();
    for (let i = 0; i < 10; i++) {
      const p = document.createElement('div');
      p.className = 'cursor-trail';
      p.style.left = (rect.left + rect.width / 2) + 'px';
      p.style.top = (rect.top + rect.height / 2) + 'px';
      p.style.background = 'var(--neon-purple)';
      document.body.appendChild(p);

      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 5 + 2;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;

      let opacity = 0.8;
      function animate() {
        p.style.left = (parseFloat(p.style.left) + vx) + 'px';
        p.style.top = (parseFloat(p.style.top) + vy) + 'px';
        opacity -= 0.02;
        p.style.opacity = opacity;
        if (opacity > 0) requestAnimationFrame(animate);
        else p.remove();
      }
      animate();
    }
  }

  // 4. Cursor Trail & Parallax
  const canvas = document.querySelector('.galaxy-canvas');
  const neb1 = document.querySelector('.nebula-1');
  const neb2 = document.querySelector('.nebula-2');

  window.addEventListener('mousemove', e => {
    // Parallax
    const x = (e.clientX / window.innerWidth - 0.5) * 2;
    const y = (e.clientY / window.innerHeight - 0.5) * 2;

    neb1.style.transform = `translate(${x * 30}px, ${y * 30}px)`;
    neb2.style.transform = `translate(${x * -30}px, ${y * -30}px)`;

    // Cursor Trail
    const trail = document.createElement('div');
    trail.className = 'cursor-trail';
    trail.style.left = e.clientX + 'px';
    trail.style.top = e.clientY + 'px';
    document.body.appendChild(trail);

    setTimeout(() => {
      trail.style.opacity = '0';
      trail.style.transform = 'scale(0.5)';
      setTimeout(() => trail.remove(), 300);
    }, 50);
  });

  // 5. Interactive Letter Messages
  const chars = document.querySelectorAll('.nesya-char');
  const display = document.getElementById('message-display');
  const nebula = document.querySelector('.nebula-1');
  let messageTimeout;

  chars.forEach(char => {
    char.addEventListener('click', () => {
      const msg = char.getAttribute('data-msg');
      const letter = char.getAttribute('data-letter');

      // Ripple effect
      const ripple = document.createElement('div');
      ripple.className = 'ripple';
      char.appendChild(ripple);
      setTimeout(() => ripple.remove(), 800);

      // Nebula Pulse
      nebula.style.transition = 'all 0.4s ease';
      nebula.style.opacity = '0.7';
      nebula.style.filter = 'blur(60px)';
      setTimeout(() => {
        nebula.style.opacity = '0.4';
        nebula.style.filter = 'blur(100px)';
      }, 400);

      // Show Message
      clearTimeout(messageTimeout);
      display.classList.remove('active', 'special-y');

      // Small delay for smooth state change
      setTimeout(() => {
        display.textContent = msg;
        display.classList.add('active');
        if (letter === 'Y') display.classList.add('special-y');

        messageTimeout = setTimeout(() => {
          display.classList.remove('active');
        }, 5000);
      }, 50);

      // Click Particles
      createParticles(char);
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
