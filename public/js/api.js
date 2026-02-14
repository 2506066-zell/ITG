import { mockFetch } from './mock.js';

const base = '/api';
const getToken = () => localStorage.getItem('token') || '';
const authHeader = () => {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};
const handle401 = (res) => {
  if (res.status === 401) {
    localStorage.removeItem('token');
    location.href = '/login.html';
  }
};

export async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...authHeader(), ...(options.headers || {}) };

  // OPTIMIZATION: Use AbortController to timeout slow requests
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

  try {
    const res = await fetch(`${base}${path}`, {
      ...options,
      headers,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const type = res.headers.get('content-type');
    const isHtml = type && type.includes('text/html');

    if ((res.status === 404 || res.status === 405) || isHtml) {
      throw new Error(`Backend unreachable: ${res.status}`);
    }

    if (path !== '/login') handle401(res);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    console.log('Fetch failed/timeout, using mock:', err.message);
    return mockFetch(path, options);
  }
}

export async function get(path) {
  const res = await apiFetch(path, { method: 'GET' });
  return res.json();
}
export async function post(path, body) {
  const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}
export async function put(path, body) {
  const res = await apiFetch(path, { method: 'PUT', body: JSON.stringify(body) });
  return res.json();
}
export async function del(path) {
  const res = await apiFetch(path, { method: 'DELETE' });
  return res.json();
}
