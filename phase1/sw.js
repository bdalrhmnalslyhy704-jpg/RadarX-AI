const CACHE_NAME = 'radarx-phase2-shell-v3';
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

  // Never cache exchange market/API responses. Never cache backend, Binance, or other API responses.
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
  if(p.event_class==='TEST_PUSH_ONLY'||p.type==='TEST_PUSH_ONLY'){
    return 'اختبار إشعار فقط — ليس تحليلًا للسوق';
  }
  const price=p.price==null?'UNKNOWN':String(p.price);
  const dq=p.data_quality==null?'UNKNOWN':String(p.data_quality);
  const lq=p.liquidity_quality==null?'UNKNOWN':String(p.liquidity_quality);
  const sourceTime=p.source_time?new Date(Number(p.source_time)).toISOString():'UNKNOWN';
  const reason=Array.isArray(p.reason_codes)?p.reason_codes.join(', '):String(p.reason_codes||'UNKNOWN');
  return 'السعر: '+price+' • وقت المصدر: '+sourceTime+' • DQ: '+dq+' • LQ: '+lq+' • Risk: '+String(p.risk_filter||'UNKNOWN')+
    ' • '+String(p.strategy||'UNKNOWN')+' • السبب: '+reason+' • confidence_score: UNKNOWN';
}

self.addEventListener('push', event => {
  event.waitUntil((async() => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
    const receivedAt = Date.now();
    const isTest = payload.event_class==='TEST_PUSH_ONLY'||payload.type==='TEST_PUSH_ONLY';
    const title = isTest ? 'RadarX • TEST_PUSH_ONLY' : 'RadarX • '+String(payload.symbol||'UNKNOWN')+' '+String(payload.direction||'UNKNOWN');
    const body = isTest ? 'اختبار إشعار فقط — ليس تحليلًا للسوق' : notificationText(payload)+'\nهذه إشارة تحليلية وليست ضمانًا للربح.';
    const notificationData={...payload};delete notificationData.ack_token;delete notificationData.device_token;delete notificationData.ack_url;
    await self.registration.showNotification(title,{body,tag:'radarx-'+(isTest?'test-':'signal-')+String(payload.event_id||payload.signal_id||receivedAt),renotify:false,data:{...notificationData,received_at:receivedAt},icon:'./icons/icon-192.svg',badge:'./icons/icon-192.svg'});
    if(isTest&&payload.ack_url&&payload.ack_token&&payload.device_token&&payload.subscription_id&&payload.event_id){try{await fetch(payload.ack_url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subscription_id:payload.subscription_id,test_event_id:payload.event_id,device_token:payload.device_token,ack_token:payload.ack_token,delivered_at:Date.now()})});}catch{}}
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async() => {
    const p = event.notification.data || {};
    const receivedAt = Number(p.received_at || Date.now());
    if(p.event_class==='TEST_PUSH_ONLY'||p.type==='TEST_PUSH_ONLY'){
      const testTarget = new URL('./settings.html', self.registration.scope);
      testTarget.searchParams.set('test_push','1');
      testTarget.searchParams.set('event_id',String(p.event_id||''));
      testTarget.searchParams.set('received_at',String(receivedAt));
      const windows = await self.clients.matchAll({type:'window', includeUncontrolled:true});
      for (const client of windows) {
        try { await client.navigate(testTarget.href); await client.focus(); return; } catch {}
      }
      await self.clients.openWindow(testTarget.href);
      return;
    }
    const id = p.signal_id;
    const target = new URL('./signal.html', self.registration.scope);
    if (id) target.searchParams.set('signal_id', id);
    target.searchParams.set('received_at', String(receivedAt));
    const windows = await self.clients.matchAll({type:'window', includeUncontrolled:true});
    for (const client of windows) {
      try { await client.navigate(target.href); await client.focus(); return; } catch {}
    }
    await self.clients.openWindow(target.href);
  })());
});
