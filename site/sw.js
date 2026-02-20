/*
  NDYRA Service Worker
  --------------------
  Goals:
    • Never “stick” users on an old checkpoint build
    • Keep offline behavior as a best-effort fallback (not a source of truth)
    • Keep install resilient (missing files should NOT brick updates)

  Key decisions:
    • HTML navigations: NETWORK FIRST (fallback to cache/offline)
    • Static assets: STALE-WHILE-REVALIDATE
    • Minimal pre-cache to avoid install failures
*/

// Bump this when you want to force-refresh caches globally.
// (HTML is network-first, so this is mostly for static assets.)
const CACHE_NAME = 'ndyra-static-v1';

// Keep precache small + safe (install should not fail on a 404).
const PRECACHE_URLS = [
  '/offline.html',
  '/assets/build.json',
  '/assets/css/styles.css',
  '/assets/js/site.js',
  '/manifest.webmanifest',
  '/assets/branding/NDYRA App Icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Best-effort precache: never fail install because one asset is missing.
    await Promise.allSettled(
      PRECACHE_URLS.map(async (url) => {
        try {
          await cache.add(url);
        } catch {
          // Ignore individual failures.
        }
      })
    );

    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Delete old caches (including legacy HIIT56 caches).
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );

    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only same-origin GET requests
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // HTML navigations: network-first so users never get stuck on an old checkpoint.
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-store' });

        // Cache a copy (best-effort)
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, res.clone());

        return res;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req);
        return cached || (await cache.match('/offline.html')) || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // Static assets: stale-while-revalidate
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);

    const fetchPromise = fetch(req)
      .then((res) => {
        // Only cache successful basic/cors responses.
        if (res && (res.status === 200 || res.status === 0)) {
          cache.put(req, res.clone());
        }
        return res;
      })
      .catch(() => cached);

    return cached || fetchPromise;
  })());
});
