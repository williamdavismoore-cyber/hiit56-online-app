const CACHE_NAME = 'hiit56-cp25-static-v1';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/workouts/',
  '/workouts/index.html',
  '/workouts/category.html',
  '/workouts/workout.html',
  '/app/',
  '/app/index.html',
  '/app/workouts/',
  '/app/workouts/index.html',
  '/app/workouts/category.html',
  '/app/workouts/workout.html',
  '/app/timer/',
  '/app/timer/builder/',
  '/app/timer/my-workouts/',
  '/app/timer/index.html',
  '/biz/',
  '/biz/index.html',
  '/biz/moves/',
  '/biz/moves/index.html',
  '/biz/moves/move.html',
  '/biz/gym-timer/',
  '/biz/gym-timer/builder/',
  '/biz/gym-timer/index.html',
  '/join.html',
  '/for-gyms/start.html',
  '/app/account/',
  '/app/account/index.html',
  '/biz/account/',
  '/biz/account/index.html',
  '/biz/onboarding/',
  '/biz/onboarding/index.html',
  '/admin/tenants/',
  '/admin/tenants/index.html',
  '/admin/coupons/',
  '/admin/coupons/index.html',
  '/admin/comps/',
  '/admin/comps/index.html',
  '/login.html',
  '/pricing.html',
  '/for-gyms/',
  '/for-gyms/index.html',
  '/for-gyms/pricing.html',
  '/admin/',
  '/admin/index.html',
  '/admin/status/',
  '/admin/status/index.html',
  '/assets/css/styles.css',
  '/assets/js/site.js',
  '/assets/data/categories_v1.json',
  '/assets/data/videos_classes.json',
  '/assets/data/timer_demos.json',
  '/assets/data/videos_moves.json',
  '/assets/data/equipment_catalog_v1.json',
  '/assets/data/tenants_demo.json',
  '/assets/data/pricing_v1.json',
  '/assets/data/stripe_public_test.json',
  '/assets/data/thumbnail_overrides.json',
  '/assets/branding/Hiit56 Online Primary Logo_For Dark Background.png',
  '/assets/branding/Desktop Poster.webp',
  '/assets/branding/Mobile Poster.webp',
  '/manifest.webmanifest',
  '/assets/build.json',
  '/offline.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async ()=>{
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CORE_ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async ()=>{
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k === CACHE_NAME) ? null : caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GET requests.
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  const accept = req.headers.get('accept') || '';
  const isHTML = req.mode === 'navigate' || accept.includes('text/html');
  const isData = url.pathname.startsWith('/assets/data/');
  const isAsset = url.pathname.startsWith('/assets/') || url.pathname.endsWith('.webmanifest') || url.pathname === '/assets/build.json';

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Normalize cache key (ignore search) for our own files.
    const cacheKey = (isData || isAsset || isHTML) ? new Request(url.pathname, {method: 'GET'}) : req;

    if (isHTML) {
      // Network-first for HTML (prevents "stuck on old CP")
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(cacheKey, fresh.clone());
        return fresh;
      } catch (err) {
        const cached = await cache.match(cacheKey);
        return cached || (await cache.match('/offline.html')) || Response.error();
      }
    }

    // Stale-while-revalidate for assets/data
    const cached = await cache.match(cacheKey);
    const fetchPromise = (async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(cacheKey, fresh.clone());
        return fresh;
      } catch (err) {
        return null;
      }
    })();

    return cached || (await fetchPromise) || (await cache.match('/offline.html')) || Response.error();
  })());
});

  // Only handle same-origin GET requests.
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  event.respondWith((async ()=>{
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;
    try{
      const fresh = await fetch(req);
      // cache only basic same-origin assets (not vimeo, not thumbnails)
      if (fresh.ok && url.origin === location.origin) cache.put(req, fresh.clone());
      return fresh;
    }catch(err){
      // fallback: try cached root
      return cached || (await cache.match('/index.html')) || Response.error();
    }
  })());
});