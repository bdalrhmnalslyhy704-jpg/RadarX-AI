import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApiServer} from '../http/api.mjs';
import {DurableStore} from '../core/store.mjs';
import {SignalDeduplicator} from '../core/dedup.mjs';
import {PushManager} from '../push/index.mjs';
import {createSessionToken} from '../core/auth.mjs';
import {EVENT_CLASS} from '../core/event-types.mjs';

class TestWebPushProvider{
  constructor(){this.calls=[];}
  status(){return{provider:'webpush',enabled:true};}
  async send(subscription,payload){this.calls.push({subscription,payload});return{ok:true,status:'SENT',httpStatus:201};}
}

async function setup(){
  const dir=await mkdtemp(join(tmpdir(),'radarx-real-push-')),store=await new DurableStore({dir}).init();
  const secret='TEST_FIXTURE_AUTH_SECRET';
  const config={
    environment:'staging',
    staging:{testPushEnabled:true},
    auth:{secret,allowedOrigins:['https://staging.example.test']},
    api:{maxBodyBytes:65536,rateLimitPerMinute:100},
    symbols:['BTCUSDT'],timeframes:['4h','1h','15m'],
    push:{vapidPublicKey:'TEST_FIXTURE_PUBLIC'}
  };
  const monitor={health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})};
  const provider=new TestWebPushProvider();
  const dedup=new SignalDeduplicator({store,windowMs:900000});
  const pushManager=new PushManager({provider,store,deduplicator:dedup,retryBaseMs:1});
  const server=createApiServer({config,store,monitor,pushProvider:provider,pushManager});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,base='http://127.0.0.1:'+port;
  const token=createSessionToken({userId:'staging-android',secret,ttlSec:3600});
  await store.upsertSubscription('staging-android',{
    endpoint:'https://push.example.test/staging',
    expirationTime:null,
    keys:{p256dh:'TEST_FIXTURE_P256DH',auth:'TEST_FIXTURE_AUTH'}
  });
  return {server,store,provider,base,token};
}

test('TEST_FIXTURE: TEST_PUSH_ONLY requires auth and a trusted browser Origin',async()=>{
  const x=await setup();
  const noAuth=await fetch(x.base+'/v1/push/test',{method:'POST',headers:{Origin:'https://staging.example.test'},body:JSON.stringify({test_id:'android-auth'})});
  assert.equal(noAuth.status,401);
  const noOrigin=await fetch(x.base+'/v1/push/test',{method:'POST',headers:{Authorization:'Bearer '+x.token},body:JSON.stringify({test_id:'android-origin'})});
  assert.equal(noOrigin.status,403);
  const evil=await fetch(x.base+'/v1/push/test',{method:'POST',headers:{Authorization:'Bearer '+x.token,Origin:'https://evil.example.test'},body:JSON.stringify({test_id:'android-evil'})});
  assert.equal(evil.status,403);
  await new Promise(resolve=>x.server.close(resolve));
});

test('TEST_FIXTURE: TEST_PUSH_ONLY is deduplicated, audited, and never masquerades as a market signal',async()=>{
  const x=await setup(),headers={Authorization:'Bearer '+x.token,Origin:'https://staging.example.test','content-type':'application/json'};
  const first=await fetch(x.base+'/v1/push/test',{method:'POST',headers,body:JSON.stringify({test_id:'android-manual-01'})});
  assert.equal(first.status,202);
  const firstBody=await first.json();
  assert.equal(firstBody.ok,true);assert.equal(firstBody.status,'SENT');assert.equal(x.provider.calls.length,1);
  assert.equal(x.provider.calls[0].payload.type,EVENT_CLASS.TEST_PUSH_ONLY);
  assert.equal(x.provider.calls[0].payload.event_class,EVENT_CLASS.TEST_PUSH_ONLY);
  assert.equal(x.provider.calls[0].payload.message,'اختبار إشعار فقط — ليس تحليلًا للسوق');
  assert.equal(x.provider.calls[0].payload.confidence_score,'UNKNOWN');
  assert.equal(x.provider.calls[0].payload.paper_trading,true);
  assert.equal(x.provider.calls[0].payload.real_order_execution,false);
  assert.equal(x.provider.calls[0].payload.test_id,'android-manual-01');
  assert.equal('signal_id' in x.provider.calls[0].payload,false);
  assert.equal('source_time' in x.provider.calls[0].payload,false);

  const duplicate=await fetch(x.base+'/v1/push/test',{method:'POST',headers,body:JSON.stringify({test_id:'android-manual-01'})});
  assert.equal(duplicate.status,409);assert.equal((await duplicate.json()).error,'DUPLICATE_TEST_PUSH');assert.equal(x.provider.calls.length,1);

  const signals=await x.store.readRecent('signals',20),notes=await x.store.readRecent('notifications',20);
  assert.ok(signals.some(e=>e.event_class===EVENT_CLASS.TEST_PUSH_ONLY&&e.test_id==='android-manual-01'));
  assert.ok(notes.some(e=>e.event_class===EVENT_CLASS.TEST_PUSH_ONLY&&e.test_id==='android-manual-01'));
  const joined=JSON.stringify([...signals,...notes]);
  assert.equal(joined.includes('TEST_FIXTURE'),false);
  assert.equal(joined.includes('LIVE_MARKET_SIGNAL'),false);
  assert.equal(/confidence_score["']?\s*:\s*\d/.test(joined),false);
  await new Promise(resolve=>x.server.close(resolve));
});

test('TEST_FIXTURE: staging test endpoint is disabled outside the explicit staging gate',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-real-push-disabled-')),store=await new DurableStore({dir}).init();
  const provider=new TestWebPushProvider(),dedup=new SignalDeduplicator({store});
  const pushManager=new PushManager({provider,store,deduplicator:dedup});
  const config={environment:'production',staging:{testPushEnabled:true},auth:{secret:'TEST_FIXTURE_AUTH_SECRET',allowedOrigins:['https://staging.example.test']},
    api:{maxBodyBytes:65536,rateLimitPerMinute:100},push:{vapidPublicKey:'TEST_FIXTURE_PUBLIC'}};
  const monitor={health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})};
  const server=createApiServer({config,store,monitor,pushProvider:provider,pushManager});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const token=createSessionToken({userId:'u1',secret:config.auth.secret,ttlSec:3600}),h={Authorization:'Bearer '+token,Origin:'https://staging.example.test','content-type':'application/json'};
  const r=await fetch('http://127.0.0.1:'+server.address().port+'/v1/push/test',{method:'POST',headers:h,body:JSON.stringify({test_id:'prod-block'})});
  assert.equal(r.status,404);assert.equal(provider.calls.length,0);
  await new Promise(resolve=>server.close(resolve));
});
