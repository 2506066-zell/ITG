const CACHE_NAME = 'cf-v27';
const ASSETS = [
  '/',
  '/login',
  '/college-widget',
  'login.html',
  'index.html',
  'college-widget.html',
  'memories.html',
  'anniversary.html',
  'daily-tasks.html',
  'college-assignments.html',
  'goals.html',
  'schedule.html',
  'chat.html',
  'settings.html',
  'report.html',
  'class-notes.html',
  'manifest.json',
  'css/style.css',
  'css/v2-system.css',
  'css/v3-polish.css',
  'css/home-v2.css',
  'css/chat.css',
  'css/college-widget.css',
  'css/daily-tasks.css',
  'css/orbit.css',
  'css/login-futuristik.css',
  'css/solar-system.css',
  'css/themes.css',
  'js/main.js',
  'js/api.js',
  'js/home-v2.js',
  'js/perf-mode.js',
  'js/v2-motion.js',
  'js/v3-micro.js',
  'js/login.js',
  'js/memories.js',
  'js/anniversary.js',
  'js/tasks_v2.js',
  'js/assignments.js',
  'js/goals.js',
  'js/monthly_todos.js',
  'js/schedule.js',
  'js/chat.js',
  'js/college-widget.js',
  'js/settings.js',
  'js/report.js',
  'js/class_notes.js',
  'icons/192.png',
  'icons/512.png',
  'icons/icon.svg'
];

// Install: Cache Assets
self.addEventListener('install', e => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.allSettled(
        ASSETS.map(async (asset) => {
          try {
            await cache.add(asset);
          } catch {}
        })
      );
      await self.skipWaiting();
    })()
  );
});

// Activate: Clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: Stale-While-Revalidate Strategy
self.addEventListener('fetch', e => {
  // Only handle GET requests
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Skip API calls (Network Only)
  if (url.pathname.startsWith('/api/')) return;

  // Skip cross-origin requests (e.g., Google Fonts, FontAwesome) to avoid CORS issues
  // unless we want to cache them explicitly. For now, let's keep it simple.
  if (url.origin !== self.location.origin) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(async (res) => {
        if (res && (res.redirected || (res.status >= 300 && res.status < 400))) {
          return fetch(res.url);
        }
        return res;
      }).catch(async () => {
        const cached = await caches.match(e.request);
        if (cached) return cached;
        const cachedIndex = await caches.match('/index.html');
        return cachedIndex || Response.error();
      })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(async (res) => {
        if (res && (res.redirected || (res.status >= 300 && res.status < 400))) {
          return fetch(res.url);
        }
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'NZ Assistant';
  const body = payload.body || 'Ada update baru dari Proactive Engine.';
  const url = payload.url || (payload.data && payload.data.url) || '/';
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const tag = payload.tag || 'nz-proactive';

  const options = {
    body,
    icon: '/icons/192.png',
    badge: '/icons/192.png',
    vibrate: [120, 40, 120],
    data: {
      ...(payload.data || {}),
      url,
    },
    actions,
    tag,
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification && event.notification.data) || {};
  const baseUrl = data.url || '/';
  const action = (event.action || '').trim();
  let targetUrl = baseUrl;

  async function runActionApi() {
    if (!data.action_token) return;
    const actionId = ['start', 'snooze', 'done'].includes(action) ? action : 'open';
    const body = {
      action: actionId,
      token: data.action_token,
      route_fallback: data.route_fallback || baseUrl,
      event_family: data.event_family || 'general',
    };
    if (actionId === 'snooze') body.snooze_minutes = 30;
    try {
      await fetch('/api/notifications/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {}
  }

  if (action === 'open-chat') targetUrl = '/chat';
  if (action === 'open-replan') targetUrl = '/schedule?replan=1';
  if (action === 'open-schedule') targetUrl = '/schedule';
  if (action === 'complete-task') targetUrl = '/daily-tasks?filter=urgent';
  if (action === 'snooze') targetUrl = '/';

  try {
    const u = new URL(targetUrl, self.location.origin);
    if (action) u.searchParams.set('notif_action', action);
    targetUrl = `${u.pathname}${u.search}${u.hash}`;
  } catch {}

  event.waitUntil(
    runActionApi().then(() =>
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
        for (const client of windowClients) {
          if ('focus' in client) {
            const samePath = new URL(client.url).pathname === new URL(targetUrl, self.location.origin).pathname;
            if (samePath) return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
        return undefined;
      })
    )
  );
});
