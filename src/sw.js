// Service worker template. vite.config.js injects the version and precache
// list at build time and writes the result to dist/sw.js.
const VERSION = '__SW_VERSION__';
const PRECACHE = __PRECACHE_MANIFEST__;
const CACHE = `wod-timer-${VERSION}`;
const SHELL = new URL('index.html', self.registration.scope).href;
const NETWORK_TIMEOUT_MS = 3000;

// Rejects if the server doesn't answer in time (e.g. the host is asleep).
function fetchWithTimeout(request) {
  return Promise.race([
    fetch(request),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
  ]);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('wod-timer-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only same-origin GETs. Gemini calls (direct or via /api/) always go to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  // Pages: network first so updates show up; cached shell when offline or slow.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetchWithTimeout(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(SHELL, copy));
          }
          return res;
        })
        .catch(() => caches.match(SHELL)),
    );
    return;
  }

  // Hashed assets and icons: cache first.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        }),
    ),
  );
});
