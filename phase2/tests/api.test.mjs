import test,{fetchWithTimeout,closeServer} from './test-helpers.mjs';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApiServer} from '../http/api.mjs';
import {DurableStore} from '../core/store.mjs';
import {createSessionToken} from '../core/auth.mjs';
import {NoopPushProvider} from '../push/index.mjs';
import {pushSubscription} from './fixtures.mjs';

test('TEST_FIXTURE: subscription/settings API requires auth and never returns push keys',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-api-')),store=await new DurableStore({dir}).init();
  const secret='TEST_FIXTURE_AUTH_SECRET';
  const config={auth:{secret,allowedOrigins:[]},api:{maxBodyBytes:65536,rateLimitPerMinute:100}};
  const monitor={health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})};
  const server=createApiServer({config,store,monitor,pushProvider:new NoopPushProvider()});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>closeServer(server));const port=server.address().port,base='http://127.0.0.1:'+port;
  const bad=await fetchWithTimeout(base+'/v1/settings');assert.equal(bad.status,401);
  const token=createSessionToken({userId:'u1',secret,ttlSec:3600}),h={Authorization:'Bearer '+token,'content-type':'application/json'};
  const save=await fetchWithTimeout(base+'/v1/settings',{method:'PUT',headers:h,body:JSON.stringify({enabled:true,symbols:['BTCUSDT'],timeframes:['15m'],minDataQuality:80,minLiquidityQuality:70,signalTypes:['CONFIRMED']})});
  assert.equal(save.status,200);
  const add=await fetchWithTimeout(base+'/v1/subscriptions',{method:'POST',headers:h,body:JSON.stringify(pushSubscription())});assert.equal(add.status,201);
  const got=await add.json();assert.equal(got.subscription.endpoint,pushSubscription().endpoint);assert.equal(Object.hasOwn(got.subscription,'keys'),false);assert.equal(Object.hasOwn(got.subscription,'device_token'),false);
  const list=await fetchWithTimeout(base+'/v1/subscriptions',{headers:{Authorization:'Bearer '+token}});assert.equal(list.status,200);
  const rows=await list.json();assert.equal(rows.subscriptions.length,1);
  const del=await fetchWithTimeout(base+'/v1/subscriptions/'+rows.subscriptions[0].id,{method:'DELETE',headers:{Authorization:'Bearer '+token}});
  assert.equal(del.status,200);await closeServer(server);
});

test('TEST_FIXTURE: authenticated config exposes only the VAPID public key and signal detail is retrievable',async(t)=>{
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
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>closeServer(server));
  const port=server.address().port,base='http://127.0.0.1:'+port,token=createSessionToken({userId:'u1',secret,ttlSec:3600});
  const h={Authorization:'Bearer '+token};
  const cfgRes=await fetchWithTimeout(base+'/v1/config',{headers:h});assert.equal(cfgRes.status,200);const cfg=await cfgRes.json();
  assert.equal(cfg.push.vapidPublicKey,'TEST_FIXTURE_PUBLIC');assert.equal('vapidPrivateKey' in cfg.push,false);assert.equal(Object.hasOwn(cfg.push,'vapidPrivateKey'),false);assert.doesNotMatch(JSON.stringify(cfg),/TEST_FIXTURE_PRIVATE/);
  const detail=await fetchWithTimeout(base+'/v1/signals/TEST_FIXTURE_SIGNAL_DETAIL',{headers:h});assert.equal(detail.status,200);const d=await detail.json();
  assert.equal(d.event.signal_snapshot.scores.confidence_score,'UNKNOWN');assert.equal(d.event.signal_snapshot.paper_trade.real_order_execution,false);
  await closeServer(server);
});


test('staging validation ack endpoint requires trusted Origin and exact capability proof',async(t)=>{
 const dir=await mkdtemp(join(tmpdir(),'radarx-api-validation-')),store=await new DurableStore({dir}).init(),secret='TEST_FIXTURE_AUTH_SECRET';const config={environment:'staging',staging:{testPushEnabled:true},auth:{secret,allowedOrigins:['https://staging.example.test']},api:{publicOrigin:'https://api.example.test',maxBodyBytes:65536,rateLimitPerMinute:100},push:{vapidPublicKey:'TEST_FIXTURE_PUBLIC'}};const monitor={health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})},provider=new NoopPushProvider();
 const server=createApiServer({config,store,monitor,pushProvider:provider});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port,deviceToken='TEST_FIXTURE_DEVICE_TOKEN_123456789012345678901234',ackToken='TEST_FIXTURE_ACK_TOKEN';const sub=await store.upsertSubscription('u1',{endpoint:'https://push.example.test/ack',device_token:deviceToken,keys:{p256dh:'x',auth:'y'}});await store.createStagingPushValidationChallenge({userId:'u1',subscriptionId:sub.id,testEventId:'ev1',deviceToken,ackToken});await store.recordStagingPushValidationDelivery({subscriptionId:sub.id,testEventId:'ev1',status:'SENT'});
 const ack=await fetchWithTimeout(base+'/v1/push/ack',{method:'POST',headers:{Origin:'https://staging.example.test','content-type':'application/json'},body:JSON.stringify({subscription_id:sub.id,test_event_id:'ev1',device_token:deviceToken,ack_token:ackToken,delivered_at:Date.now()})});assert.equal(ack.status,200);assert.equal((await ack.json()).status,'VALIDATED');assert.equal((await store.getStagingPushValidationStatus()).status,'VALIDATED');await new Promise(r=>server.close(r));
});
