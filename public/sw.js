const CACHE_VERSION = 'shinobu-web-shell-v3';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon32.png',
  '/icons/icon128.png',
];

function isCacheableStaticRequest(request, url) {
  if (request.method !== 'GET' || url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/models/')) return false;
  if (request.mode === 'navigate') return true;
  if (['script', 'style', 'worker', 'font', 'image', 'manifest'].includes(request.destination)) {
    return true;
  }
  return /\.(?:js|css|wasm|woff2?|ttf|png|svg|webp|avif)$/iu.test(url.pathname);
}

async function cacheShellAndBuildAssets() {
  const cache = await caches.open(CACHE_VERSION);
  await cache.addAll(APP_SHELL);
  const response = await fetch('/');
  if (!response.ok) return;
  await cache.put('/index.html', response.clone());
  const html = await response.text();
  const assetUrls = Array.from(
    html.matchAll(/(?:src|href)=["']([^"'#?]+)["']/giu),
    (match) => new URL(match[1], self.location.origin),
  ).filter((url) =>
    url.origin === self.location.origin
    && !url.pathname.startsWith('/models/')
    && /\.(?:js|css|woff2?|ttf|wasm|png|svg|webp)$/iu.test(url.pathname));
  await Promise.all(assetUrls.map(async (url) => {
    const assetResponse = await fetch(url);
    if (assetResponse.ok) await cache.put(url, assetResponse);
  }));
}

async function notifyClients(type) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((client) => client.postMessage({ type }));
}

self.addEventListener('install', (event) => {
  const updating = Boolean(self.registration.active);
  event.waitUntil(
    cacheShellAndBuildAssets().then(async () => {
      if (updating) await notifyClients('PWA_UPDATE_READY');
      else await self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith('shinobu-web-shell-') && name !== CACHE_VERSION)
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim())
      .then(() => notifyClients('PWA_OFFLINE_READY')),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!isCacheableStaticRequest(event.request, url)) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE_VERSION);
            await cache.put('/index.html', response.clone());
          }
          return response;
        })
        .catch(async () =>
          (await caches.match('/index.html'))
          ?? (await caches.match('/'))),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request, { ignoreVary: true }).then(async (cached) => {
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE_VERSION);
        await cache.put(event.request, response.clone());
      }
      return response;
    }),
  );
});
