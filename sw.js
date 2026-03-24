/**
 * Service Worker — caches static assets for offline launch.
 * Stale-while-revalidate: serve from cache, update in background.
 */

const CACHE_NAME = 'cc-scribe-v2';
const ASSETS = [
  './',
  'index.html',
  'app.js',
  'style.css',
  'glossary.json',
  'splash.mp4',
  'manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Don't cache API calls
  if (url.hostname !== location.hostname) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetching = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetching;
    })
  );
});
