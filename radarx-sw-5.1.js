/* RadarX Service Worker retirement shim.
   The web runtime no longer depends on a Service Worker.
   This file exists only so previously installed RadarX workers can retire cleanly.
*/
const RETIRE_PREFIX='radarx-ultimate-';
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => String(k).startsWith(RETIRE_PREFIX)).map(k => caches.delete(k)));
    } catch {}
    try {
      await self.registration.unregister();
    } catch {}
    try {
      const clients = await self.clients.matchAll({type:'window', includeUncontrolled:true});
      clients.forEach(c => c.postMessage({type:'RADARX_SW_RETIRED'}));
    } catch {}
  })());
});
/* Deliberately no fetch handler: browser requests pass through to the network. */
