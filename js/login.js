import { apiFetch } from './api.js';
import { showToast, disableSW } from './main.js';
function init() {
  disableSW();
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
      const res = await apiFetch('/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', data.user || username);
        showToast(`Selamat datang, ${username}!`, 'success');
        setTimeout(() => location.href = '/', 500);
      } else if (res.status === 401) {
        if (msg) msg.textContent = 'Password salah';
        showToast('Password salah', 'error');
      } else {
        if (msg) msg.textContent = 'Backend error';
        showToast('Backend error', 'error');
      }
    } catch (err) {
      const codeText = (err && err.message) || '';
      const isTimeout = codeText.includes('abort') || codeText.includes('timeout');
      const text = isTimeout ? 'Server timeout' : 'Backend error';
      if (msg) msg.textContent = text;
      showToast(text, 'error');
    }
    if (btn) btn.disabled = false;
  });
}
document.addEventListener('DOMContentLoaded', init);
