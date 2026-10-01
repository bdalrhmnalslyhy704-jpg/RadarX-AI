import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApiServer} from '../http/api.mjs';
import {DurableStore} from '../core/store.mjs';
import {createSessionToken} from '../core/auth.mjs';
import {NoopPushProvider} from '../push/index.mjs';
import {pushSubscription} from './fixtures.mjs';

test('TEST_FIXTURE: subscription/settings API requires auth and never returns push keys',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-api-')),store=await new DurableStore({dir}).init();
  const secret='TEST_FIXTURE_AUTH_SECRET';
  const config={auth:{secret,allowedOrigins:[]},api:{maxBodyBytes:65536,rateLimitPerMinute:100}};
  const monitor={health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})};
  const server=createApiServer({config,store,monitor,pushProvider:new NoopPushProvider()});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,base='http://127.0.0.1:'+port;
  const bad=await fetch(base+'/v1/settings');assert.equal(bad.status,401);
  const token=createSessionToken({userId:'u1',secret,ttlSec:3600}),h={Authorization:'Bearer '+token,'content-type':'application/json'};
  const save=await fetch(base+'/v1/settings',{method:'PUT',headers:h,body:JSON.stringify({enabled:true,symbols:['BTCUSDT'],timeframes:['15m'],minDataQuality:80,minLiquidityQuality:70,signalTypes:['CONFIRMED']})});
  assert.equal(save.status,200);
  const add=await fetch(base+'/v1/subscriptions',{method:'POST',headers:h,body:JSON.stringify(pushSubscription())});assert.equal(add.status,201);
  const got=await add.json();assert.equal(got.subscription.endpoint,pushSubscription().endpoint);assert.equal(Object.hasOwn(got.subscription,'keys'),false);
  const list=await fetch(base+'/v1/subscriptions',{headers:{Authorization:'Bearer '+token}});assert.equal(list.status,200);
  const rows=await list.json();assert.equal(rows.subscriptions.length,1);
  const del=await fetch(base+'/v1/subscriptions/'+rows.subscriptions[0].id,{method:'DELETE',headers:{Authorization:'Bearer '+token}});
  assert.equal(del.status,200);await new Promise(r=>server.close(r));
});

test('TEST_FIXTURE: authenticated config exposes only the VAPID public key and signal detail is retrievable',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-api-detail-')),store=await new DurableStore({dir}).init();
  const secret='TEST_FIXTURE_AUTH_SECRET',config={auth:{secret,allowedOrigins:[]},api:{maxBodyBytes:65536,rateLimitPerMinute:100},
    symbols:['BTCUSDT'],timeframes:['4h','1h','15m'],push:{vapidPublicKey:'TEST_FIXTURE_PUBLIC',vapidPrivateKey:'TEST_FIXTURE_PRIVATE'}};
  const monitor={health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})};
  const provider=new NoopPushProvider();
  await store.appendSignalAudit({signal_id:'TEST_FIXTURE_SIGNAL_DETAIL',user_id:'u1',source_time:1700000000000,processed_at:1700000001000,
    symbol:'BTCUSDT',timeframe:'15m',price:100,strategy:'CONFIRMED_BREAKOUT',data_quality:95,liquidity_quality:90,
    signal_snapshot:{signal_id:'TEST_FIXTURE_SIGNAL_DETAIL',symbol:'BTCUSDT',direction:'LONG',market:'SPOT',
      strategy:'CONFIRMED_BREAKOUT',signal_type:'CONFIRMED',candle:{timeframe:'15m',open_time:1699999100000,close_time:1700000000000,closed:true},
      scores:{data_quality:95,liquidity_quality:90,confidence_score:'UNKNOWN'},risk_filter:'PASS',
      data_status:{source:'TEST_FIXTURE',stale:false,gaps:false,future_data_detected:false},
      paper_trade:{enabled:true,real_order_execution:false},reason_codes:['TEST_FIXTURE_REASON']}
  });
  const server=createApiServer({config,store,monitor,pushProvider:provider});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,base='http://127.0.0.1:'+port,token=createSessionToken({userId:'u1',secret,ttlSec:3600});
  const h={Authorization:'Bearer '+token};
  const cfgRes=await fetch(base+'/v1/config',{headers:h});assert.equal(cfgRes.status,200);const cfg=await cfgRes.json();
  assert.equal(cfg.push.vapidPublicKey,'TEST_FIXTURE_PUBLIC');assert.equal('vapidPrivateKey' in cfg.push,false);assert.equal(Object.hasOwn(cfg.push,'vapidPrivateKey'),false);assert.doesNotMatch(JSON.stringify(cfg),/TEST_FIXTURE_PRIVATE/);
  const detail=await fetch(base+'/v1/signals/TEST_FIXTURE_SIGNAL_DETAIL',{headers:h});assert.equal(detail.status,200);const d=await detail.json();
  assert.equal(d.event.signal_snapshot.scores.confidence_score,'UNKNOWN');assert.equal(d.event.signal_snapshot.paper_trade.real_order_execution,false);
  await new Promise(resolve=>server.close(resolve));
});


function publicSnapshot(symbol='BTCUSDT',processedAt=Date.now(),overrides={}){
  const trend={strategy:'MTF_TREND',direction:'LONG',state:'CANDIDATE',score:{trendScore:82}};
  const breakout={strategy:'CONFIRMED_BREAKOUT',direction:'LONG',state:'CONFIRMED',score:{breakoutScore:91}};
  const meanReversion={strategy:'MEAN_REVERSION',direction:'NONE',state:'REJECTED',score:{}};
  const signal={
    signal_id:'TEST_FIXTURE_PUBLIC_SIGNAL',symbol,market:'SPOT',direction:'LONG',strategy:'CONFIRMED_BREAKOUT',
    candle:{timeframe:'15m',open_time:processedAt-899000,close_time:processedAt-1000,closed:true},
    price:{reference:100,entry:100,stop_loss:98,tp1:102,tp2:104,tp3:106},
    scores:{data_quality:95,liquidity_quality:90,confidence_score:'UNKNOWN'},
    risk_filter:'PASS',risk_reasons:[],reason_codes:['TEST_FIXTURE_REASON'],
    data_status:{source:'BINANCE_PUBLIC_REST',stale:false,gaps:false,future_data_detected:false},
    paper_trade:{enabled:true,real_order_execution:false}
  };
  return {symbol,processed_at:processedAt,source_time:signal.candle.close_time,signal,strategies:{trend,breakout,meanReversion},...overrides};
}

async function startTestApi(store,extraConfig={}){
  const config={auth:{secret:'TEST_FIXTURE_AUTH_SECRET',allowedOrigins:[]},api:{maxBodyBytes:65536,rateLimitPerMinute:100},
    monitoring:{maxStaleTriggerMs:1800000,minDataQuality:70},...extraConfig};
  const monitor={health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})};
  const server=createApiServer({config,store,monitor,pushProvider:new NoopPushProvider()});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,base:'http://127.0.0.1:'+server.address().port};
}

test('TEST_FIXTURE: public signal endpoint returns Android-compatible live contract for a fresh snapshot',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-public-signal-fresh-')),store=await new DurableStore({dir}).init();
  await store.putSignalSnapshot('BTCUSDT',publicSnapshot('BTCUSDT',Date.now()-1000));
  const {server,base}=await startTestApi(store);
  const res=await fetch(base+'/api/signal?symbol=BTCUSDT'); assert.equal(res.status,200);
  const body=await res.json();
  assert.equal(body.status,'ok'); assert.equal(body.symbol,'BTCUSDT'); assert.equal(body.meta.live,true);
  assert.equal(body.meta.paper_trading,true); assert.equal(body.meta.real_order_execution,false); assert.equal(body.meta.confidence_score,'UNKNOWN');
  assert.equal(body.signal.price.reference,100); assert.equal(body.signal.scores.trend_score,82); assert.equal(body.signal.scores.breakout_score,91);
  assert.equal(body.signal.scores.mean_reversion_score,null); assert.equal(body.signal.risk_filter,'PASS');
  assert.equal(body.signal.data_status.data_valid,true); assert.equal(body.signal.data_status.stale,false);
  assert.equal(body.signal.strategies.trend.strategy,'MTF_TREND'); assert.equal(body.signal.strategies.breakout.strategy,'CONFIRMED_BREAKOUT');
  assert.equal(body.signal.strategies.meanReversion.strategy,'MEAN_REVERSION');
  assert.ok(Number.isFinite(body.meta.fetch_age_ms)); assert.match(body.meta.as_of, /^20\d{2}-/);
  await new Promise(resolve=>server.close(resolve));
});

test('TEST_FIXTURE: public signal response contains every Android-read field',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-public-signal-fields-')),store=await new DurableStore({dir}).init();
  await store.putSignalSnapshot('BTCUSDT',publicSnapshot('BTCUSDT',Date.now()-1000));
  const {server,base}=await startTestApi(store); const body=await (await fetch(base+'/api/signal?symbol=BTCUSDT')).json();
  for(const key of ['status','symbol','meta','signal','paper_trading','real_order_execution','confidence_score'])assert.ok(Object.hasOwn(body,key),key);
  for(const key of ['live','source','as_of','fetch_age_ms','paper_trading','real_order_execution','confidence_score'])assert.ok(Object.hasOwn(body.meta,key),key);
  for(const key of ['price','scores','risk_filter','risk_reasons','data_status','strategies','reason_codes'])assert.ok(Object.hasOwn(body.signal,key),key);
  for(const key of ['reference','entry','stop_loss','tp1','tp2','tp3'])assert.ok(Object.hasOwn(body.signal.price,key),key);
  for(const key of ['trend_score','breakout_score','mean_reversion_score','data_quality','liquidity_quality','confidence_score'])assert.ok(Object.hasOwn(body.signal.scores,key),key);
  for(const key of ['source','stale','gaps','future_data_detected','data_valid','last_error'])assert.ok(Object.hasOwn(body.signal.data_status,key),key);
  for(const key of ['trend','breakout','meanReversion'])assert.ok(Object.hasOwn(body.signal.strategies,key),key);
  await new Promise(resolve=>server.close(resolve));
});

test('TEST_FIXTURE: stale snapshot returns 503/not_ready and never live=true',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-public-signal-stale-')),store=await new DurableStore({dir}).init();
  const old=Date.now()-1800001; await store.putSignalSnapshot('BTCUSDT',publicSnapshot('BTCUSDT',old));
  const {server,base}=await startTestApi(store); const res=await fetch(base+'/api/signal?symbol=BTCUSDT'); const body=await res.json();
  assert.equal(res.status,503); assert.equal(body.status,'not_ready'); assert.equal(body.meta.live,false); assert.equal(body.signal.data_status.stale,true); assert.equal(body.signal.data_status.last_error,'STALE_SNAPSHOT');
  await new Promise(resolve=>server.close(resolve));
});

test('TEST_FIXTURE: invalid/future snapshot returns 503 and live=false',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-public-signal-invalid-')),store=await new DurableStore({dir}).init();
  const future=publicSnapshot('BTCUSDT',Date.now()-1000); future.signal.data_status.future_data_detected=true;
  await store.putSignalSnapshot('BTCUSDT',future);
  const {server,base}=await startTestApi(store); let res=await fetch(base+'/api/signal?symbol=BTCUSDT'); let body=await res.json();
  assert.equal(res.status,503); assert.equal(body.status,'not_ready'); assert.equal(body.meta.live,false); assert.equal(body.signal.data_status.future_data_detected,true);
  const invalid=publicSnapshot('BTCUSDT',Date.now()-1000); invalid.signal.data_status.gaps=true; await store.putSignalSnapshot('BTCUSDT',invalid);
  res=await fetch(base+'/api/signal?symbol=BTCUSDT'); body=await res.json();
  assert.equal(res.status,503); assert.equal(body.meta.live,false); assert.equal(body.signal.data_status.gaps,true);
  await new Promise(resolve=>server.close(resolve));
});

test('TEST_FIXTURE: missing snapshot returns DATA_UNAVAILABLE and does not fabricate prices',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-public-signal-empty-')),store=await new DurableStore({dir}).init();
  const {server,base}=await startTestApi(store); const res=await fetch(base+'/api/signal?symbol=BTCUSDT'); const body=await res.json();
  assert.equal(res.status,503); assert.equal(body.status,'unavailable'); assert.equal(body.error,'DATA_UNAVAILABLE'); assert.equal(body.meta.live,false); assert.equal(body.signal.price.reference,null); assert.equal(body.signal.scores.data_quality,null);
  await new Promise(resolve=>server.close(resolve));
});

test('TEST_FIXTURE: invalid symbol returns HTTP 400',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-public-signal-symbol-')),store=await new DurableStore({dir}).init();
  const {server,base}=await startTestApi(store); const res=await fetch(base+'/api/signal?symbol=BAD!'); const body=await res.json();
  assert.equal(res.status,400); assert.equal(body.error,'INVALID_SYMBOL'); assert.equal(body.meta.live,false);
  await new Promise(resolve=>server.close(resolve));
});

test('TEST_FIXTURE: public signal lookup is symbol-isolated',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-public-signal-isolation-')),store=await new DurableStore({dir}).init();
  await store.putSignalSnapshot('BTCUSDT',publicSnapshot('BTCUSDT',Date.now()-1000));
  const eth=publicSnapshot('ETHUSDT',Date.now()-1000); eth.signal.price.reference=200; await store.putSignalSnapshot('ETHUSDT',eth);
  const {server,base}=await startTestApi(store); const body=await (await fetch(base+'/api/signal?symbol=BTCUSDT')).json();
  assert.equal(body.status,'ok'); assert.equal(body.symbol,'BTCUSDT'); assert.equal(body.signal.price.reference,100);
  await new Promise(resolve=>server.close(resolve));
});

test('TEST_FIXTURE: public signal route is read-only and existing API paths remain present',async()=>{
  const apiSource=await readFile(new URL('../http/api.mjs',import.meta.url),'utf8');
  assert.equal((apiSource.match(/u\.pathname==='\/api\/market-radar'/g)||[]).length,1);
  assert.equal((apiSource.match(/u\.pathname==='\/v1\/signals'/g)||[]).length,1);
  assert.equal((apiSource.match(/const signalPrefix='\/v1\/signals\/'/g)||[]).length,1);
  const route=apiSource.slice(apiSource.indexOf("u.pathname==='/api/signal'"),apiSource.indexOf("if(!u.pathname.startsWith('/v1/'))"));
  assert.doesNotMatch(route,/createOrder|placeOrder|withdraw|account/i);
  assert.match(route,/req\.method==='GET'/);
});
