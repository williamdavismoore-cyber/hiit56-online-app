// NDYRA Service Worker — safe caching, no stuck builds.
// - Network-first for HTML + build.json
// - Stale-while-revalidate for static assets
// - Deletes old HIIT56 caches on activate

const CACHE_NAME = 'ndyra-static-v1';

// Keep this list minimal — the app should still work without SW.
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/assets/build.json',
  '/assets/css/styles.css',
  '/assets/js/site.js',
  // Branding (these filenames are kept for compatibility; assets are NDYRA-branded)
  '/assets/branding/Hiit56 Online Primary Logo_For Dark Background.png',
  '/assets/branding/Hiit56_Favicon_32x32.webp',
  '/assets/branding/Hiit56_Favicon_180x180.webp',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(CORE_ASSETS);
    } catch (e) {
      // SW is best-effort; don't block install on cache errors.
    } finally {
      self.skipWaiting();
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((k) => {
          // Purge any old HIIT56 caches, and any outdated NDYRA cache versions.
          if (k.startsWith('hiit56-')) return caches.delete(k);
          if (k.startsWith('ndyra-') && k !== CACHE_NAME) return caches.delete(k);
          return Promise.resolve(false);
        })
      );
    } finally {
      self.clients.claim();
    }
  })());
});

function isSameOrigin(request) {
  try {
    const url = new URL(request.url);
    return url.origin === self.location.origin;
  } catch (e) {
    return false;
  }
}

function isHTMLRequest(request) {
  return request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    // Cache successful responses (avoid caching opaque).
    if (fresh && fresh.ok && fresh.type === 'basic') cache.put(request, fresh.clone());
    return fresh;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Last resort: offline page for navigations
    if (isHTMLRequest(request)) {
      const offline = await cache.match('/offline.html');
      if (offline) return offline;
    }
    throw e;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((fresh) => {
      if (fresh && fresh.ok && fresh.type === 'basic') cache.put(request, fresh.clone());
      return fresh;
    })
    .catch(() => null);

  return cached || (await fetchPromise) || fetch(request);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle same-origin GET requests.
  if (req.method !== 'GET' || !isSameOrigin(req)) return;

  const url = new URL(req.url);

  // Always network-first for build.json so labels & cache-busting stay correct.
  if (url.pathname === '/assets/build.json') {
    event.respondWith(networkFirst(req));
    return;
  }

  // Navigation requests: network-first (prevents stale HTML).
  if (isHTMLRequest(req)) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(req));
});
