const CACHE_NAME = 'radarx-pages-backend-shell-v1';
const SHELL = [
  './index.html',
  './radarx-backend-client.mjs',
  './manifest.json',
  './sw.js',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './icons/icon-512-maskable.svg',
  './icons/apple-touch-icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function isShellRequest(request) {
  if (request.mode === 'navigate') return true;
  const url = new URL(request.url);
  return url.origin === self.location.origin &&
    SHELL.some(path => new URL(path, self.location.href).pathname === url.pathname);
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  // Backend market/signal responses are cross-origin and never enter this cache.
  if (url.origin !== self.location.origin) return;

  if (isShellRequest(request)) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (request.mode === 'navigate' || SHELL.some(path => new URL(path, self.location.href).pathname === url.pathname)) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then(hit => hit || caches.match('./index.html')))
    );
  }
});
