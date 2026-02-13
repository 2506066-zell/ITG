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
    const username = (f.get('username') || '').toString().trim();
    const password = (f.get('password') || '').toString();

    const msg = document.querySelector('#login-msg');
    if (msg) msg.textContent = '';
    if (!username) {
      if (msg) msg.textContent = 'Username wajib diisi';
      showToast('Username wajib diisi', 'error');
      if (btn) btn.disabled = false;
      return;
    }
    if (!password || password.length < 4) {
      if (msg) msg.textContent = 'Password minimal 4 karakter';
      showToast('Password minimal 4 karakter', 'error');
      if (btn) btn.disabled = false;
      return;
    }

    try {
      const data = await post('/login', { username, password });
      if (data.token) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', data.user || username);
        showToast(`Selamat datang, ${username}!`, 'success');
        setTimeout(() => location.href = '/', 500);
      } else {
        throw new Error('No token');
      }
    } catch (err) {
      const codeText = (err && err.message) || '';
      const isTimeout = codeText.includes('abort') || codeText.includes('timeout');
      const isUnauthorized = codeText.includes('401') || codeText.toLowerCase().includes('unauthorized');
      const text = isUnauthorized ? 'Password salah' : (isTimeout ? 'Server timeout' : 'Backend error');
      if (msg) msg.textContent = text;
      showToast(text, 'error');
    }
    if (btn) btn.disabled = false;
  });
}
document.addEventListener('DOMContentLoaded', init);
