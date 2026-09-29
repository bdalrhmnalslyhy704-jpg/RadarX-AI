import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const root=new URL('../../phase1/',import.meta.url);

test('TEST_FIXTURE: frontend never contains Binance credentials or VAPID private key',async()=>{
  const files=['app.html','settings.html','signal.html','phase2-api.mjs'];
  for(const f of files){
    const text=await readFile(new URL(f,root),'utf8');
    assert.equal(/BINANCE_(API_KEY|SECRET)|apiKey|apiSecret|secretKey|VAPID_PRIVATE_KEY|vapidPrivateKey/i.test(text),false,f);
  }
});

test('TEST_FIXTURE: frontend keeps confidence UNKNOWN and does not numerically display it',async()=>{
  const files=['app.html','signal.html','phase2-api.mjs'];
  for(const f of files){
    const text=await readFile(new URL(f,root),'utf8');
    assert.equal(/confidence_score\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i.test(text),false,f);
  }
  const app=await readFile(new URL('app.html',root),'utf8');
  assert.ok(app.includes('confidence_score'));assert.ok(app.includes('UNKNOWN'));
});

test('TEST_FIXTURE: settings requests notification permission only from the enable action and handles unsupported/VAPID failures',async()=>{
  const text=await readFile(new URL('settings.html',root),'utf8');
  assert.ok(text.includes("Notification.requestPermission()"));
  assert.ok(text.includes("!('PushManager' in window)"));
  assert.ok(text.includes("VAPID Public Key غير مضبوط"));
  assert.ok(text.includes("perm!=='granted'"));
  assert.ok(text.includes('apiTestPush'));
  assert.ok(text.includes('إرسال TEST_PUSH_ONLY'));
});

test('TEST_FIXTURE: service worker push displays analytical warning and notification click opens signal details',async()=>{
  const sw=await readFile(new URL('sw.js',root),'utf8');
  const handlers={};let shown=null;let opened=null;
  const caches={open:async()=>({addAll:async()=>{},put:async()=>{}}),keys:async()=>[],match:async()=>null,delete:async()=>{}};
  const self={addEventListener:(name,fn)=>{handlers[name]=fn},registration:{
    scope:'https://pwa.example/phase1/',showNotification:async(title,options)=>{shown={title,options}}
  },clients:{matchAll:async()=>[],openWindow:async url=>{opened=url}}};
  vm.runInNewContext(sw,{self,caches,URL,console,Date,Promise,setTimeout,clearTimeout});
  assert.equal(typeof handlers.push,'function');assert.equal(typeof handlers.notificationclick,'function');
  const payload={type:'RADARX_SIGNAL',event_class:'LIVE_MARKET_SIGNAL',signal_id:'TEST_FIXTURE_SIGNAL',symbol:'BTCUSDT',direction:'LONG',strategy:'CONFIRMED_BREAKOUT',
    price:100,data_quality:95,liquidity_quality:90,risk_filter:'PASS',source_time:1700000000000};
  let pushPromise;handlers.push({data:{json:()=>payload},waitUntil:p=>{pushPromise=p}});await pushPromise;
  assert.match(shown.title,/BTCUSDT LONG/);assert.match(shown.options.body,/وقت المصدر/);assert.match(shown.options.body,/سبب/);assert.match(shown.options.body,/هذه إشارة تحليلية وليست ضمانًا للربح/);
  let clickPromise;handlers.notificationclick({notification:{data:{...payload,received_at:1700000005000},close(){}},waitUntil:p=>{clickPromise=p}});await clickPromise;
  assert.match(opened,/signal\.html/);assert.match(opened,/signal_id=TEST_FIXTURE_SIGNAL/);assert.match(opened,/received_at=1700000005000/);
});

test('TEST_FIXTURE: TEST_PUSH_ONLY notification is visibly non-market and clicks to Settings',async()=>{
  const sw=await readFile(new URL('sw.js',root),'utf8');
  const handlers={};let shown=null;let opened=null;
  const self={addEventListener:(name,fn)=>{handlers[name]=fn},registration:{
    scope:'https://pwa.example/phase1/',showNotification:async(title,options)=>{shown={title,options}}
  },clients:{matchAll:async()=>[],openWindow:async url=>{opened=url}}};
  const caches={open:async()=>({addAll:async()=>{},put:async()=>{}}),keys:async()=>[],match:async()=>null,delete:async()=>{}};
  vm.runInNewContext(sw,{self,caches,URL,console,Date,Promise,setTimeout,clearTimeout});
  const payload={type:'TEST_PUSH_ONLY',event_class:'TEST_PUSH_ONLY',event_id:'TEST_PUSH_ONLY:staging-android:1',test_id:'1',
    message:'اختبار إشعار فقط — ليس تحليلًا للسوق',confidence_score:'UNKNOWN',paper_trading:true,real_order_execution:false};
  let pushPromise;handlers.push({data:{json:()=>payload},waitUntil:p=>{pushPromise=p}});await pushPromise;
  assert.equal(shown.title,'RadarX • TEST_PUSH_ONLY');
  assert.equal(shown.options.body,'اختبار إشعار فقط — ليس تحليلًا للسوق');
  assert.equal(shown.options.data.event_class,'TEST_PUSH_ONLY');
  assert.equal(shown.options.data.confidence_score,'UNKNOWN');
  assert.equal(shown.options.data.real_order_execution,false);
  let clickPromise;handlers.notificationclick({notification:{data:{...payload,received_at:1700000005000},close(){}},waitUntil:p=>{clickPromise=p}});await clickPromise;
  assert.match(opened,/settings\.html/);assert.doesNotMatch(opened,/signal\.html/);assert.match(opened,/event_id=TEST_PUSH_ONLY%3Astaging-android%3A1/);
});

test('TEST_FIXTURE: service worker does not intercept cross-origin backend or Binance requests',async()=>{
  const sw=await readFile(new URL('sw.js',root),'utf8');
  assert.ok(sw.includes("if (url.origin !== self.location.origin) return;"));
  assert.ok(sw.includes('Never cache backend, Binance, or other API responses.'));
});
