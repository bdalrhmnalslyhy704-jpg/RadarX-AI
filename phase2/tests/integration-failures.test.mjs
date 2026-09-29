import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {SignalDeduplicator} from '../core/dedup.mjs';
import {PushManager,NoopPushProvider} from '../push/index.mjs';
import {defaultSettings} from '../core/signal-service.mjs';

const TEST_FIXTURE='TEST_FIXTURE';

function sub(){return{endpoint:'https://push.example.test/failure',expirationTime:null,keys:{p256dh:'TEST_FIXTURE_P256DH',auth:'TEST_FIXTURE_AUTH'}}}
function sig(){return{signal_id:'TEST_FIXTURE_FAILURE',symbol:'BTCUSDT',market:'SPOT',strategy:'CONFIRMED_BREAKOUT',direction:'LONG',
  signal_type:'CONFIRMED',candle:{timeframe:'15m',close_time:1700000000000,closed:true},price:{reference:100},
  scores:{data_quality:95,liquidity_quality:95},risk_filter:'PASS',reason_codes:['CLOSE_ABOVE_RANGE'],
  data_status:{source:'BINANCE_PUBLIC_WS',stale:false,gaps:false,future_data_detected:false},paper_trade:{enabled:true,real_order_execution:false}}}

class GoneProvider{
  status(){return{provider:TEST_FIXTURE,enabled:true}}
  async send(){return{ok:false,status:'GONE',reason:'PUSH_SUBSCRIPTION_EXPIRED',httpStatus:410}}
}

test('TEST_FIXTURE: no user subscription produces no push attempt',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-nosub-')),store=await new DurableStore({dir}).init();
  const p=new GoneProvider(),m=new PushManager({provider:p,store});
  const out=await m.notifySignal(sig());assert.equal(out.status,'NO_SUBSCRIBERS');assert.deepEqual(out.notifications,[]);
});

test('TEST_FIXTURE: expired push endpoint is disabled after provider returns 410',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-gone-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',defaultSettings());await store.upsertSubscription('u1',sub());
  const m=new PushManager({provider:new GoneProvider(),store}),out=await m.notifySignal(sig());
  assert.equal(out.status,'FAILED_OR_DISABLED');assert.equal(out.notifications[0].status,'GONE');
  assert.equal((await store.getSubscriptions('u1')).length,0);
});

test('TEST_FIXTURE: dedup survives service restart through durable storage',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-restart-'));
  const store1=await new DurableStore({dir}).init(),d1=new SignalDeduplicator({store:store1,windowMs:900000});
  await d1.markEmitted(sig(),1700000000000);
  const store2=await new DurableStore({dir}).init(),d2=new SignalDeduplicator({store:store2,windowMs:900000});
  const result=await d2.canEmit(sig(),1700000000100);
  assert.equal(result.allowed,false);assert.equal(result.reason,'DUPLICATE_SIGNAL');
});

test('TEST_FIXTURE: disabled push provider never pretends that delivery succeeded',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-disabled-push-')),store=await new DurableStore({dir}).init();
  const result=await new NoopPushProvider().send(sub(),sig());
  assert.equal(result.ok,false);assert.equal(result.status,'DISABLED');
});
