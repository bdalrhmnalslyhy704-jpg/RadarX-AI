/* RadarX Background Push Service Worker */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {
    data = { title: 'RadarX', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || '⚡ RadarX — فرصة مبكرة';
  const options = {
    body: data.body || 'تم رصد فرصة جديدة تحتاج مراجعة.',
    icon: data.icon || '/favicon.ico',
    badge: data.badge || '/favicon.ico',
    tag: data.tag || 'radarx-alert',
    renotify: true,
    requireInteraction: !!data.requireInteraction,
    data: { url: data.url || '/', symbol: data.symbol || '' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';
  event.waitUntil((async()=>{
    const list = await clients.matchAll({type:'window', includeUncontrolled:true});
    for (const client of list) {
      try { await client.focus(); client.navigate(url); return; } catch (_) {}
    }
    if (clients.openWindow) await clients.openWindow(url);
  })());
});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
