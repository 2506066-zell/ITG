const CACHE_NAME = 'cf-v12';
const ASSETS = [
  '/',
  '/login',
  'login.html',
  'index.html',
  'memories.html',
  'anniversary.html',
  'daily-tasks.html',
  'college-assignments.html',
  'goals.html',
  'schedule.html',
  'chat.html',
  'settings.html',
  'manifest.json',
  'css/style.css',
  'css/themes.css',
  'js/main.js',
  'js/api.js',
  'js/login.js',
  'js/memories.js',
  'js/anniversary.js',
  'js/tasks_v2.js',
  'js/assignments.js',
  'js/goals.js',
  'js/schedule.js',
  'js/chat.js',
  'js/settings.js',
  'icons/192.png',
  'icons/512.png',
  'icons/icon.svg'
];

// Install: Cache Assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
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
