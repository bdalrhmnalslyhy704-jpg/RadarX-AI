const CACHE_NAME = 'radarx-phase2-shell-v2';
const SHELL = [
  './app.html',
  './settings.html',
  './signal.html',
  './phase2-api.mjs',
  './radarx-phase1-engine.mjs',
  './manifest.json',
  './sw.js',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './icons/icon-512-maskable.svg',
  './icons/apple-touch-icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isAppShellRequest(request) {
  const path = new URL(request.url).pathname;
  return request.mode === 'navigate' && (path.endsWith('/phase1/') || path.endsWith('/phase1/app.html') || path.endsWith('/phase1/settings.html') || path.endsWith('/phase1/signal.html'));
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache backend, Binance, or other API responses.
  if (isAppShellRequest(request)) {
    event.respondWith(
      fetch(request).then(response => {
        const copy = response.clone();
        const key = url.pathname.endsWith('/settings.html') ? './settings.html' :
          url.pathname.endsWith('/signal.html') ? './signal.html' : './app.html';
        caches.open(CACHE_NAME).then(cache => cache.put(key, copy));
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
});

function notificationText(p) {
  const price = p.price == null ? 'UNKNOWN' : String(p.price);
  const dq = p.data_quality == null ? 'UNKNOWN' : String(p.data_quality);
  const lq = p.liquidity_quality == null ? 'UNKNOWN' : String(p.liquidity_quality);
  return 'السعر: '+price+' • DQ: '+dq+' • LQ: '+lq+' • Risk: '+String(p.risk_filter||'UNKNOWN')+
    ' • '+String(p.strategy||'UNKNOWN')+' • confidence_score: UNKNOWN';
}

self.addEventListener('push', event => {
  event.waitUntil((async() => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
    const receivedAt = Date.now();
    const title = 'RadarX • '+String(payload.symbol||'UNKNOWN')+' '+String(payload.direction||'UNKNOWN');
    const body = notificationText(payload)+'\nهذه إشارة تحليلية وليست ضمانًا للربح.';
    await self.registration.showNotification(title, {
      body,
      tag: 'radarx-signal-'+String(payload.signal_id||receivedAt),
      renotify: false,
      data: {...payload, received_at: receivedAt},
      icon: './icons/icon-192.svg',
      badge: './icons/icon-192.svg'
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async() => {
    const p = event.notification.data || {};
    const id = p.signal_id;
    const receivedAt = Number(p.received_at || Date.now());
    const target = new URL('./signal.html', self.registration.scope);
    if (id) target.searchParams.set('signal_id', id);
    target.searchParams.set('received_at', String(receivedAt));
    const windows = await self.clients.matchAll({type:'window', includeUncontrolled:true});
    for (const client of windows) {
      try {
        await client.navigate(target.href);
        await client.focus();
        return;
      } catch {}
    }
    await self.clients.openWindow(target.href);
  })());
});
