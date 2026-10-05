/* RadarX Background Intelligence client */
(function(){
'use strict';
var API='/api/radarx-background';
var PUSH='/api/radarx-push';
var TOPIC='radarx-alert-9c4c7b3e8e6d4a5fb7c2e1d9a6f3b8c1';
var busy=false,last=null;

function q(id){return document.getElementById(id);}
function esc(x){return String(x==null?'':x).replace(/[&<>"]/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m];});}
function style(){
 if(q('rxBgRadarStyles'))return;
 var s=document.createElement('style');s.id='rxBgRadarStyles';
 s.textContent=
 '#rxBgRadar{margin:14px 0;padding:16px;border:1px solid #244451;border-radius:18px;background:linear-gradient(135deg,#08151c,#071118);box-shadow:0 12px 40px rgba(0,0,0,.2)}'+
 '#rxBgRadar .rxbg-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}'+
 '#rxBgRadar .rxbg-brand{display:flex;gap:10px;align-items:flex-start}'+
 '#rxBgRadar .rxbg-icon{width:42px;height:42px;border-radius:13px;display:grid;place-items:center;background:#0d2530;border:1px solid #285364;font-size:21px}'+
 '#rxBgRadar h2{margin:3px 0 5px;font-size:17px}'+
 '#rxBgRadar p{margin:0;color:#8ea6b1;font-size:10px;line-height:1.7}'+
 '#rxBgRadar .rxbg-badges{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}'+
 '#rxBgRadar .rxbg-badge{padding:6px 9px;border-radius:999px;border:1px solid #27424e;color:#89b5c2;background:#0a171e;font-size:9px;font-weight:800}'+
 '#rxBgRadar .rxbg-badge.on{color:#8ef2bf;border-color:#245845;background:#091912}'+
 '#rxBgRadar .rxbg-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px}'+
 '#rxBgRadar .rxbg-kpi{padding:9px;border:1px solid #1c3039;border-radius:12px;background:#09131a}'+
 '#rxBgRadar .rxbg-kpi span{display:block;color:#6f8995;font-size:8px}'+
 '#rxBgRadar .rxbg-kpi b{display:block;margin-top:5px;font-size:13px}'+
 '#rxBgRadar .rxbg-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:11px}'+
 '#rxBgRadar .rxbg-note{margin-top:9px;padding:8px 10px;border-radius:10px;border:1px solid #1a303a;background:#08131a;color:#78919d;font-size:9px;line-height:1.6}'+
 '#rxBgRadar .rxbg-cands{display:grid;gap:7px;margin-top:10px}'+
 '#rxBgRadar .rxbg-row{display:grid;grid-template-columns:1.2fr .8fr .8fr .8fr;gap:8px;align-items:center;padding:9px 10px;border:1px solid #19303a;border-radius:11px;background:#09131a}'+
 '#rxBgRadar .rxbg-row b{font-size:11px}'+
 '#rxBgRadar .rxbg-row small{display:block;color:#7b949f;font-size:8px;margin-top:3px}'+
 '#rxBgRadar .rxbg-score{font-weight:900}'+
 '#rxBgRadar .rxbg-good{color:#7deab7}.rxbg-warn{color:#ffd77a}.rxbg-risk{color:#ff8d9b}'+
 ' '#rxBgRadar .rxbg-explosion{margin-top:12px;border:1px solid #5b4630;border-radius:14px;background:linear-gradient(135deg,#1a1309,#0b1115);padding:11px}'+
 ' '#rxBgRadar .rxbg-explosion-head{display:flex;justify-content:space-between;gap:8px;align-items:center}'+
 ' '#rxBgRadar .rxbg-explosion-head b{font-size:12px}'+
 ' '#rxBgRadar .rxbg-hot{color:#ffb454;font-weight:900}'+
 '@media(max-width:760px){#rxBgRadar .rxbg-head{flex-direction:column}#rxBgRadar .rxbg-badges{justify-content:flex-start}#rxBgRadar .rxbg-grid{grid-template-columns:repeat(2,1fr)}#rxBgRadar .rxbg-row{grid-template-columns:1.2fr 1fr 1fr}}';
 document.head.appendChild(s);
}
function makePanel(){
 if(q('rxBgRadar')||!q('dashboard'))return;
 style();
 var anchor=document.querySelector('#dashboard .hero-dashboard');
 var el=document.createElement('section');el.id='rxBgRadar';
 el.innerHTML=
 '<div class="rxbg-head">'+
 '<div class="rxbg-brand"><div class="rxbg-icon">🛰️</div><div><div class="eyebrow">BACKGROUND MARKET INTELLIGENCE</div>'+
 '<h2>الرادار الخلفي المستقل</h2><p>يعمل محرك الفحص من الخادم حتى عند إغلاق RadarX. عند فتح التطبيق يستمر رادار WebSocket السريع، والخادم يراجع السوق دوريًا ويطلق تنبيهًا عند تحقق بوابة متعددة العوامل.</p></div></div>'+
 '<div class="rxbg-badges"><span id="rxBgState" class="rxbg-badge">WAITING</span><span class="rxbg-badge">SPOT ONLY</span><span class="rxbg-badge">NO LEVERAGE</span></div></div>'+
 '<div class="rxbg-grid">'+
 '<div class="rxbg-kpi"><span>آخر فحص خادمي</span><b id="rxBgLast">—</b></div>'+
 '<div class="rxbg-kpi"><span>الكون</span><b id="rxBgUniverse">—</b></div>'+
 '<div class="rxbg-kpi"><span>Deep Scan</span><b id="rxBgDeep">—</b></div>'+
 '<div class="rxbg-kpi"><span>أعلى مرشح</span><b id="rxBgTop">—</b></div></div>'+
 '<div class="rxbg-actions">'+
 '<button class="btn primary" id="rxBgRun">🚀 فحص الخادم الآن</button>'+
 '<button class="btn ghost" id="rxBgPush">🔔 تفعيل إشعار الهاتف</button>'+
 '<button class="btn ghost" id="rxBgTest">🧪 اختبار التنبيه</button>'+
 '<button class="btn ghost" id="rxBgNtfy">📲 قناة التنبيه الخارجية</button></div>'+
 '<div id="rxBgNote" class="rxbg-note">جاري التحقق من الرادار الخلفي…</div>'+
 '<div id="rxBgExplosion" class="rxbg-explosion">'+
 '<div class="rxbg-explosion-head"><b>⚡ كاشف انفجار السوق</b><span id="rxBgExplosionMeta" class="rxbg-hot">بانتظار الفحص</span></div>'+
 '<div id="rxBgExplosionRows" class="rxbg-cands"></div></div>'+
 '<div id="rxBgCandidates" class="rxbg-cands"></div>';
 if(anchor)anchor.insertAdjacentElement('afterend',el);else q('dashboard').prepend(el);
 q('rxBgRun').onclick=runScan;
 q('rxBgPush').onclick=enablePush;
 q('rxBgTest').onclick=testAlert;
 q('rxBgNtfy').onclick=setupNtfy;
}
function humanTime(ts){if(!ts)return '—';var age=Math.max(0,Date.now()-new Date(ts).getTime());return age<60000?Math.round(age/1000)+'s ago':new Date(ts).toLocaleTimeString();}
function cls(phase){return phase==='PRE-BREAKOUT'||phase==='BREAKOUT'?'rxbg-good':phase==='BUILDING'?'rxbg-warn':'rxbg-risk';}
function render(d){
 last=d||last;if(!last)return;
 q('rxBgLast').textContent=humanTime(last.checkedAt);
 q('rxBgUniverse').textContent=Number(last.universe||0).toLocaleString();
 q('rxBgDeep').textContent=String(last.deepScanned||0);
 q('rxBgTop').textContent=last.top&&last.top[0]?last.top[0].symbol:'—';
 q('rxBgState').textContent=last.alerts&&last.alerts.length?'ALERT READY':'BACKGROUND ON';
 q('rxBgState').classList.add('on');
 var ex=last.explosion||{};
 var exRows=Array.isArray(ex.candidates)?ex.candidates:[];
 var majors=Array.isArray(ex.majorMoves)?ex.majorMoves:[];
 var exAlerts=Array.isArray(ex.alerts)?ex.alerts:[];
 q('rxBgExplosionMeta').textContent=(exAlerts.length?'🚨 '+exAlerts.length+' تنبيه':'فحص '+Number(ex.lightScanned||0)+' مرشح')+' · حركات كبيرة '+majors.length;
 var exHtml='';
 exAlerts.slice(0,3).forEach(function(x){
   exHtml+='<div class="rxbg-row"><div><b>🚨 '+esc(x.symbol)+'</b><small>'+esc(x.state)+'</small></div>'+
   '<div><b class="rxbg-score rxbg-hot">EXP '+Number(x.score||0)+'</b><small>Trap '+Number(x.trapRisk||0)+'</small></div>'+
   '<div><b>+'+Number(x.move24h||0).toFixed(2)+'%</b><small>15m '+Number(x.r15||0).toFixed(2)+'%</small></div>'+
   '<div><b>'+(x.volumeRatio==null?'—':Number(x.volumeRatio).toFixed(2)+'×')+'</b><small>Accel '+Number(x.accel5||0).toFixed(2)+'</small></div></div>';
 });
 exRows.slice(0,6).forEach(function(x){
   var hot=x.state==='EXPLOSION'||x.state==='ACCELERATING'||x.state==='EARLY';
   exHtml+='<div class="rxbg-row"><div><b>'+(hot?'⚡ ':'')+esc(x.symbol)+'</b><small>'+esc(x.state)+'</small></div>'+
   '<div><b class="rxbg-score '+(hot?'rxbg-hot':'rxbg-warn')+'">'+Number(x.score||0)+'/100</b><small>Trap '+Number(x.trapRisk||0)+'</small></div>'+
   '<div><b>+'+Number(x.move24h||0).toFixed(2)+'%</b><small>30m '+Number(x.r30||0).toFixed(2)+'%</small></div>'+
   '<div><b>'+(x.volumeRatio==null?'—':Number(x.volumeRatio).toFixed(2)+'×')+'</b><small>Break '+Number(x.breakoutPct||0).toFixed(2)+'%</small></div></div>';
 });
 majors.slice(0,4).forEach(function(x){
   exHtml+='<div class="rxbg-row"><div><b>🔥 '+esc(x.symbol)+'</b><small>حركة كبيرة 24h</small></div>'+
   '<div><b class="rxbg-hot">+'+Number(x.move24h||0).toFixed(2)+'%</b><small>'+esc(x.state)+'</small></div>'+
   '<div><b>'+ (x.moveFromLow24h==null?'—': '+'+Number(x.moveFromLow24h).toFixed(1)+'%')+'</b><small>من قاع 24h</small></div>'+
   '<div><b>'+Number(x.quoteVolume||0).toLocaleString()+'</b><small>Quote Vol</small></div></div>';
 });
 q('rxBgExplosionRows').innerHTML=exHtml||'<div class="rxbg-note">لا توجد حركة شاذة مؤكدة في آخر دورة.</div>';
 var note=q('rxBgNote');
 note.textContent=(last.alerts&&last.alerts.length?'⚡ تم رصد '+last.alerts.length+' تنبيه جديد. آخرها '+last.alerts[0].symbol+' · '+last.alerts[0].phase+' · Score '+last.alerts[0].score+'/100.':'✅ الرادار التقليدي لم يطلق تنبيهًا جديدًا في آخر دورة.')+
 ' · كاشف الانفجار يعمل بطبقة مستقلة واسعة، ويعرض الحركات الكبيرة حتى لو لم تدخل الرادارات التقليدية.';
 var rows=last.top||[],html='';
 rows.slice(0,8).forEach(function(x,i){
   html+='<div class="rxbg-row"><div><b>'+(i+1)+'. '+esc(x.symbol)+'</b><small>'+esc(x.phase)+'</small></div>'+
   '<div><b class="rxbg-score '+cls(x.phase)+'">Score '+Number(x.score||0)+'</b><small>Trap '+Number(x.trapRisk||0)+'</small></div>'+
   '<div><b>'+esc(x.price)+'</b><small>5m '+Number(x.r5||0).toFixed(2)+'%</small></div>'+
   '<div><b>'+Number(x.volumeRatio||0).toFixed(2)+'×</b><small>Book '+Number(x.orderImbalance||50).toFixed(0)+'%</small></div></div>';
 });
 q('rxBgCandidates').innerHTML=html;
}
async function get(url){
 var r=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});
 var d={};try{d=await r.json();}catch(_){}
 if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d;
}
async function refresh(){
 try{
   var d=await get(API+'?mode=status&ts='+Date.now());
   if(d.lastScan)render(d.lastScan);
   else q('rxBgNote').textContent='الخادم جاهز؛ لم تُحفظ نتيجة فحص سابقة بعد.';
 }catch(e){q('rxBgNote').textContent='تعذر قراءة الرادار الخلفي الآن: '+String(e.message||e);}
}
async function runScan(){
 if(busy)return;busy=true;q('rxBgRun').disabled=true;q('rxBgNote').textContent='⚙️ يجري الآن فرز السوق والتحليل العميق لأقوى المرشحين…';
 try{render(await get(API+'?mode=scan&source=ui&ts='+Date.now()));}
 catch(e){q('rxBgNote').textContent='فشل فحص الخادم: '+String(e.message||e);}
 finally{busy=false;q('rxBgRun').disabled=false;}
}
async function testAlert(){
 try{var d=await get(API+'?mode=test-alert&ts='+Date.now());q('rxBgNote').textContent='🧪 الاختبار: ntfy '+(d.ntfy?'OK':'NO')+' · Web Push '+String(d.webPush||0)+' جهاز.';}
 catch(e){q('rxBgNote').textContent='اختبار التنبيه تعذر: '+String(e.message||e);}
}
async function setupNtfy(){
 try{
  var d=await get(API+'?mode=status&ts='+Date.now());
  if(navigator.clipboard)try{await navigator.clipboard.writeText(d.ntfyTopic||TOPIC);}catch(_){}
  q('rxBgNote').textContent='📲 تم نسخ Topic. اشترك به داخل تطبيق ntfy، وبعدها ستصل التنبيهات حتى مع إغلاق RadarX.';
  window.open(d.ntfyUrl||('https://ntfy.sh/'+TOPIC),'_blank','noopener,noreferrer');
 }catch(e){q('rxBgNote').textContent='قناة ntfy غير متاحة الآن.';}
}
function b64(s){var str=atob(String(s).replace(/-/g,'+').replace(/_/g,'/'));var a=new Uint8Array(str.length);for(var i=0;i<str.length;i++)a[i]=str.charCodeAt(i);return a;}
async function enablePush(){
 try{
  if(!('serviceWorker' in navigator)||!('PushManager' in window))throw new Error('Web Push unsupported');
  if('Notification' in window&&Notification.permission!=='granted'){var p=await Notification.requestPermission();if(p!=='granted')throw new Error('Permission denied');}
  var key=await get(PUSH+'?mode=public-key');
  var reg=await navigator.serviceWorker.register('/radarx-sw-5.13.js',{scope:'/'});
  var sub=await reg.pushManager.getSubscription();
  if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(key.publicKey)});
  var r=await fetch(PUSH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub)});
  var d=await r.json();if(!r.ok)throw new Error(d.error||'SUBSCRIBE_FAILED');
  q('rxBgNote').textContent='✅ تم تفعيل Web Push؛ سيصل التنبيه حتى بعد إغلاق RadarX عندما يكون الخادم مهيأً.';
 }catch(_){q('rxBgNote').textContent='Web Push غير مهيأ على الخادم حاليًا. استخدم «قناة التنبيه الخارجية» لتفعيل ntfy.';}
}
function boot(){
 makePanel();refresh();
 setInterval(function(){if(document.visibilityState==='visible')refresh();},60000);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
window.RadarXBackgroundRadar={refresh:refresh,runScan:runScan,enablePush:enablePush};
})();