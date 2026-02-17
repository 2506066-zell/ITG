const base = '/api';
const getToken = () => localStorage.getItem('token') || '';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
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

function emitApiAction(path, method, status) {
  try {
    const normalizedPath = String(path || '').trim();
    const normalizedMethod = String(method || 'GET').toUpperCase();
    if (!normalizedPath || normalizedPath === '/activity' || normalizedPath.startsWith('/activity?')) return;
    if (!WRITE_METHODS.has(normalizedMethod)) return;
    document.dispatchEvent(new CustomEvent('zai:api-action', {
      detail: {
        path: normalizedPath,
        method: normalizedMethod,
        status: Number(status || 0),
      },
    }));
  } catch {}
}

export async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...authHeader(), ...(options.headers || {}) };
  const method = String(options.method || 'GET').toUpperCase();

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

    if ((res.status === 404 || res.status === 405) || isHtml || res.status >= 500 || (res.status === 401 && path !== '/login')) {
      throw new Error(`Backend error: ${res.status}`);
    }

    emitApiAction(path, method, res.status);

    if (path !== '/login') handle401(res);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
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
