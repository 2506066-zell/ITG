const CACHE_NAME = 'cf-v9';
const ASSETS = [
  '/',
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
  'icons/512.png'
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

  e.respondWith(
    caches.match(e.request).then(cached => {
      // Network Fetch in background to update cache
      const fetchPromise = fetch(e.request).then(res => {
        // Update cache if response is valid
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(err => {
        console.error('Fetch failed:', err);
        // Fallback logic could go here
      });

      // Return cached response immediately if available, else wait for network
      return cached || fetchPromise;
    })
  );
});
