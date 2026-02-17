const ACTIVITY_QUEUE_KEY = 'zai_activity_queue_v1';
const ACTIVITY_SESSION_KEY = 'zai_activity_session_v1';
const FLUSH_INTERVAL_MS = 15000;
const FLUSH_BATCH_SIZE = 20;
const MAX_QUEUE_SIZE = 220;
const CLICK_TRACK_THROTTLE_MS = 700;

let trackerStarted = false;
let flushTimer = null;
let flushInFlight = false;
let lastClickTrackedAt = 0;

function randomId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readQueue() {
  try {
    const raw = localStorage.getItem(ACTIVITY_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  try {
    localStorage.setItem(ACTIVITY_QUEUE_KEY, JSON.stringify(Array.isArray(queue) ? queue : []));
  } catch {}
}

function normalizeEventName(raw = '') {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-:.]+/g, '_')
    .slice(0, 80);
}

function sanitizePayload(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  try {
    const text = JSON.stringify(raw);
    if (text.length <= 6000) return raw;
    return { truncated: true, raw: text.slice(0, 6000) };
  } catch {
    return {};
  }
}

function getSessionId() {
  try {
    const existing = sessionStorage.getItem(ACTIVITY_SESSION_KEY);
    if (existing) return existing;
    const created = randomId();
    sessionStorage.setItem(ACTIVITY_SESSION_KEY, created);
    return created;
  } catch {
    return randomId();
  }
}

function currentPagePath() {
  try {
    const url = new URL(window.location.href);
    return `${url.pathname}${url.search}`.slice(0, 200);
  } catch {
    return '/';
  }
}

function buildEvent(eventName, payload = {}, options = {}) {
  const name = normalizeEventName(eventName);
  if (!name) return null;
  return {
    event_name: name,
    session_id: String(options.session_id || getSessionId()).slice(0, 80),
    page_path: String(options.page_path || currentPagePath()).slice(0, 200),
    source: String(options.source || 'web').slice(0, 40),
    entity_type: String(options.entity_type || '').slice(0, 80) || null,
    entity_id: String(options.entity_id || '').slice(0, 80) || null,
    payload: sanitizePayload(payload),
    client_ts: new Date().toISOString(),
  };
}

function enqueueEvent(event) {
  if (!event) return;
  const current = readQueue();
  current.push(event);
  const trimmed = current.length > MAX_QUEUE_SIZE
    ? current.slice(current.length - MAX_QUEUE_SIZE)
    : current;
  writeQueue(trimmed);
}

function hasAuthToken() {
  try {
    return Boolean(localStorage.getItem('token'));
  } catch {
    return false;
  }
}

function shouldTrackApiAction(detail = {}) {
  const method = String(detail.method || 'GET').toUpperCase();
  const path = String(detail.path || '').trim();
  if (!path || path === '/activity' || path.startsWith('/activity?')) return false;
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return true;
  return false;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushActivityQueue().catch(() => {});
  }, FLUSH_INTERVAL_MS);
}

async function flushActivityQueue(options = {}) {
  if (flushInFlight) return false;
  if (!hasAuthToken()) return false;

  const queue = readQueue();
  if (!queue.length) return true;
  const batch = queue.slice(0, FLUSH_BATCH_SIZE);
  if (!batch.length) return true;

  flushInFlight = true;
  try {
    const token = localStorage.getItem('token') || '';
    const response = await fetch('/api/activity', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ events: batch }),
      keepalive: Boolean(options.keepalive),
    });
    if (!response.ok) return false;

    const current = readQueue();
    writeQueue(current.slice(batch.length));
    return true;
  } catch {
    return false;
  } finally {
    flushInFlight = false;
  }
}

function handleApiAction(event) {
  const detail = event?.detail || {};
  if (!shouldTrackApiAction(detail)) return;
  trackActivity('api_write', {
    path: String(detail.path || ''),
    method: String(detail.method || 'POST').toUpperCase(),
    status: Number(detail.status || 0),
  });
}

function handleTrackedClick(event) {
  const now = Date.now();
  if (now - lastClickTrackedAt < CLICK_TRACK_THROTTLE_MS) return;

  const target = event?.target?.closest?.('a,button,[data-track-event]');
  if (!target) return;

  const customEvent = String(target.getAttribute('data-track-event') || '').trim();
  const href = String(target.getAttribute?.('href') || '').trim();
  const id = String(target.id || '').trim();
  const className = String(target.className || '').trim().slice(0, 120);
  const tag = String(target.tagName || '').toLowerCase();

  if (customEvent) {
    trackActivity(customEvent, { id, href, class_name: className, tag });
    lastClickTrackedAt = now;
    return;
  }

  if (target.classList?.contains('nav-item') || href.startsWith('/')) {
    trackActivity('nav_open', { href, id, class_name: className });
    lastClickTrackedAt = now;
    return;
  }

  if (tag === 'button' && id) {
    trackActivity('ui_click', { id, class_name: className });
    lastClickTrackedAt = now;
  }
}

export function trackActivity(eventName, payload = {}, options = {}) {
  const event = buildEvent(eventName, payload, options);
  if (!event) return false;
  enqueueEvent(event);
  scheduleFlush();
  if ((readQueue().length % 8) === 0) {
    flushActivityQueue().catch(() => {});
  }
  return true;
}

export function startActivityTracker() {
  if (trackerStarted) return;
  trackerStarted = true;

  scheduleFlush();
  document.addEventListener('zai:api-action', handleApiAction);
  document.addEventListener('click', handleTrackedClick, { passive: true });

  trackActivity('page_view', {
    title: String(document.title || ''),
    referrer: String(document.referrer || ''),
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      flushActivityQueue({ keepalive: true }).catch(() => {});
    }
  });
  window.addEventListener('pagehide', () => {
    flushActivityQueue({ keepalive: true }).catch(() => {});
  });

  if (typeof window !== 'undefined') {
    window.__zaiTrackActivity = trackActivity;
  }
}

export function flushActivityTracker(options = {}) {
  return flushActivityQueue(options);
}
