import { post } from './api.js';
import { showToast } from './main.js';
function init() {
  const form = document.querySelector('#login-form');
  if (!form) return;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    
    const f = new FormData(form);
    const username = f.get('username');
    const password = f.get('password');

    try {
      const data = await post('/login', { username, password });
      if (data.token) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', data.user || username);
        showToast(`Selamat datang, ${username}!`, 'success');
        setTimeout(() => location.href = 'index.html', 500);
      } else {
        throw new Error('No token');
      }
    } catch (err) {
      const msg = document.querySelector('#login-msg');
      if (msg) msg.textContent = 'Invalid password';
      showToast('Password salah / Backend error', 'error');
    }
    if (btn) btn.disabled = false;
  });
}
document.addEventListener('DOMContentLoaded', init);
