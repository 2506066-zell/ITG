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
  // Show characters immediately (Remove cheesy entry)
  const chars = document.querySelectorAll('.nesya-char');
  chars.forEach(char => char.classList.add('show'));

  // 3. Star Mist Effect (Premium Cosmic Dust)
  function createStarMist(element, color = 'var(--neon-purple)') {
    const rect = element.getBoundingClientRect();
    for (let i = 0; i < 6; i++) {
      const p = document.createElement('div');
      p.className = 'cursor-trail';
      p.style.width = Math.random() * 12 + 4 + 'px';
      p.style.height = p.style.width;
      p.style.left = (rect.left + rect.width / 2) + 'px';
      p.style.top = (rect.top + rect.height / 2) + 'px';
      p.style.background = color;
      p.style.filter = 'blur(10px)';
      p.style.boxShadow = `0 0 20px ${color}`;
      document.body.appendChild(p);

      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 1.5 + 0.5;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;

      let opacity = 0.6;
      let scale = 1;

      function animate() {
        p.style.left = (parseFloat(p.style.left) + vx) + 'px';
        p.style.top = (parseFloat(p.style.top) + vy) + 'px';
        opacity -= 0.005;
        scale += 0.01;
        p.style.opacity = opacity;
        p.style.transform = `scale(${scale})`;
        if (opacity > 0) requestAnimationFrame(animate);
        else p.remove();
      }
      animate();
    }
  }

  // 4. Cursor Trail & Parallax
  const neb1 = document.querySelector('.nebula-1');
  const neb2 = document.querySelector('.nebula-2');

  window.addEventListener('mousemove', e => {
    // Parallax
    const x = (e.clientX / window.innerWidth - 0.5) * 2;
    const y = (e.clientY / window.innerHeight - 0.5) * 2;

    neb1.style.transform = `translate(${x * 30}px, ${y * 30}px)`;
    neb2.style.transform = `translate(${x * -30}px, ${y * -30}px)`;

    // Soft Cursor Trail
    const trail = document.createElement('div');
    trail.className = 'cursor-trail';
    trail.style.left = e.clientX + 'px';
    trail.style.top = e.clientY + 'px';
    trail.style.opacity = '0.3';
    document.body.appendChild(trail);

    setTimeout(() => {
      trail.style.opacity = '0';
      trail.style.transform = 'scale(2)';
      setTimeout(() => trail.remove(), 600);
    }, 50);
  });

  // 5. Interactive Letter Messages
  const display = document.getElementById('message-display');
  const nebula = document.querySelector('.nebula-1');
  let messageTimeout;

  chars.forEach(char => {
    char.addEventListener('click', () => {
      const msg = char.getAttribute('data-msg');
      const letter = char.getAttribute('data-letter');

      // Mist effect (Replaced ripple)
      const mist = document.createElement('div');
      mist.className = 'mist';
      char.appendChild(mist);
      setTimeout(() => mist.remove(), 1200);

      // Nebula Pulse (Smoother)
      nebula.style.transition = 'all 1.2s cubic-bezier(0.4, 0, 0.2, 1)';
      nebula.style.opacity = '0.6';
      setTimeout(() => {
        nebula.style.opacity = '0.4';
      }, 1200);

      // Show Message (Liquid transition)
      clearTimeout(messageTimeout);
      display.classList.remove('active');

      setTimeout(() => {
        display.textContent = msg;
        display.classList.remove('special-y');
        if (letter === 'Y') display.classList.add('special-y');
        display.classList.add('active');

        messageTimeout = setTimeout(() => {
          display.classList.remove('active');
        }, 6000);
      }, 200);

      // Star Mist
      createStarMist(char, letter === 'Y' ? 'var(--neon-purple)' : 'var(--neon-blue)');
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
