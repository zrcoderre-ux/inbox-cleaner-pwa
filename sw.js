const CACHE_NAME = 'inbox-cleaner-v28';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Only handle same-origin requests; pass through Google API calls etc.
  if (!req.url.startsWith(self.location.origin)) return;

  const isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // Network-first for the page, so new code shows up as soon as you're
    // online; fall back to the cached shell when offline.
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put('/', copy)).catch(() => {});
        return res;
      }).catch(() =>
        caches.match(req).then(r => r || caches.match('/') || caches.match('/index.html'))
      )
    );
    return;
  }

  // Cache-first for everything else (manifest, icons).
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req))
  );
});
