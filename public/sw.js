/**
 * SageTV MiniClient PWA Service Worker
 *
 * Caches static assets for offline use and fast loading.
 * Follows a cache-first strategy for static files,
 * network-first for API/WebSocket connections.
 */

const CACHE_NAME = 'sagetv-miniclient-v4';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/protocol/binary-utils.js',
  '/js/protocol/connection.js',
  '/js/protocol/constants.js',
  '/js/protocol/crypto.js',
  '/js/protocol/compression.js',
  '/js/ui/renderer.js',
  '/js/media/player.js',
  '/js/input/input-manager.js',
  '/js/session/session-manager.js',
  '/js/settings/settings-manager.js',
  '/manifest.json',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch: cache-first for static, network-first for dynamic
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests and WebSocket upgrades
  if (event.request.method !== 'GET') return;

  // Skip cross-origin CDN requests (hls.js, pako, etc.) - let them go to network
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Return cached, but also update cache in background (stale-while-revalidate)
        const fetchPromise = fetch(event.request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => cached);

        return cached;
      }

      // Not cached - fetch from network and cache it
      return fetch(event.request)
        .then((response) => {
          if (response.ok && url.pathname.match(/\.(js|css|html|json|png|jpg|svg|woff2?)$/)) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline fallback for navigation
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('Offline', { status: 503 });
        });
    })
  );
});
