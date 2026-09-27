/* RadarX Ultimate 5.1 service worker.
   Caches the 5.1 app shell and provides an event-driven push notification bridge.
   IMPORTANT: a service worker is not a permanently running Binance polling process.
   Continuous market scanning requires an active page/PWA runtime, or a backend worker. */
const CACHE='radarx-ultimate-5.1-v1';
const SHELL=['./RadarX_Ultimate_5.1_ROBUST.html','./RadarX_Ultimate_5.1.js','./RadarX_Ultimate_5.1.css','./RadarX_ProEngine_5.1.js','./manifest-5.1.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL).catch(()=>{})).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('radarx-ultimate-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;const url=new URL(event.request.url);if(url.origin!==self.location.origin)return;event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request).then(r=>{const cp=r.clone();caches.open(CACHE).then(c=>c.put(event.request,cp)).catch(()=>{});return r;}).catch(()=>caches.match('./RadarX_Ultimate_5.1_ROBUST.html'))));});
self.addEventListener('push',event=>{let data={};try{data=event.data?.json()||{};}catch{try{data={body:event.data?.text()||''};}catch{}}
 const title=data.title||'RadarX · Golden Opportunity'; const options={body:data.body||'New RadarX alert',tag:data.tag||'radarx-golden-opportunity',renotify:true,data:{url:data.url||'./RadarX_Ultimate_5.1_ROBUST.html',symbol:data.symbol||''}}; event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener('notificationclick',event=>{event.notification.close();const target=event.notification.data?.url||'./RadarX_Ultimate_5.1_ROBUST.html';event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{for(const client of list){if('focus' in client){client.navigate?.(target);return client.focus();}}return self.clients.openWindow(target);}));});
self.addEventListener('message',event=>{if(event.data?.type==='SHOW_GOLDEN'){const d=event.data;event.waitUntil(self.registration.showNotification(d.title||'RadarX · Golden Opportunity',{body:d.body||'',tag:d.tag||'radarx-golden-opportunity',renotify:true,data:{url:'./RadarX_Ultimate_5.1_ROBUST.html',symbol:d.symbol||''}}));}});
