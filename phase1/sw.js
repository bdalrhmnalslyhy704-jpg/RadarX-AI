const CACHE_NAME = 'radarx-phase1-shell-v1';
const SHELL = [
  './app.html',
  './radarx-phase1-engine.mjs',
  './manifest.json',
  './sw.js',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './icons/icon-512-maskable.svg',
  './icons/apple-touch-icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function isAppShellRequest(request) {
  return request.mode === 'navigate' || new URL(request.url).pathname.endsWith('/phase1/app.html');
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache exchange market/API responses. Only application shell assets are cached.
  if (isAppShellRequest(request)) {
    event.respondWith(
      fetch(request).then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put('./app.html', copy));
        return response;
      }).catch(() => caches.match('./app.html'))
    );
    return;
  }

  if (SHELL.some(path => new URL(path, self.location.href).pathname === url.pathname)) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        return response;
      }))
    );
  }
}