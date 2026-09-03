const CACHE_NAME = 'hands-gesture-cache-v2';
const CACHEABLE_EXTENSIONS = [
  '.js',
  '.css',
  '.html',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.wasm',
  '.task',
];

function isCacheableRequest(request) {
  if (request.method !== 'GET') return false;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  return CACHEABLE_EXTENSIONS.some((ext) => url.pathname.endsWith(ext)) ||
    url.pathname === '/' ||
    url.pathname.endsWith('/');
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.addAll([
        './',
        './index.html',
      ]);
    } catch {
      // Ignore install-time prefetch failures; runtime caching will fill gaps on demand.
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => (key === CACHE_NAME ? null : caches.delete(key))));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isCacheableRequest(request)) return;

  const url = new URL(request.url);

  // HTML navigations stay network-first so page updates still arrive quickly.
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        return caches.match('./index.html');
      }
    })());
    return;
  }

  // Runtime cache for JS/CSS/WASM/model/image assets.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
      const response = await fetch(request);
      // Cache successful same-origin or CORS responses. Opaque responses are also safe to store.
      if (response && response.ok || response.type === 'opaque') {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (err) {
      if (cached) return cached;
      throw err;
    }
  })());
});
