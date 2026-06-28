const CACHE_NAME = 'inbox-cleaner-v35';
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
    // Network-first for the page so new code shows up when online — but with a
    // short timeout so a slow/spotty connection falls back to the cached shell
    // instead of hanging (which made the app "never load").
    e.respondWith(htmlStrategy(req));
    return;
  }

  // Cache-first for everything else (manifest, icons).
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req))
  );
});

async function cachedShell(req) {
  return (await caches.match(req)) ||
         (await caches.match('/')) ||
         (await caches.match('/index.html'));
}

async function htmlStrategy(req) {
  let cached;
  try { cached = await cachedShell(req); } catch (e) {}
  try {
    const net = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500))
    ]);
    if (net && net.ok) {
      caches.open(CACHE_NAME).then(c => c.put('/', net.clone())).catch(() => {});
      return net;
    }
    return cached || net;
  } catch (e) {
    // Timed out or offline — serve the cached shell; last resort is a raw fetch.
    return cached || fetch(req);
  }
}
