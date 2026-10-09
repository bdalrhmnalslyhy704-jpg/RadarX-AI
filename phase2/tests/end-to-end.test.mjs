import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CONFIG} from '../config.mjs';
import {DurableStore} from '../core/store.mjs';
import {SignalDeduplicator} from '../core/dedup.mjs';
import {SignalService} from '../core/signal-service.mjs';
import {PushManager} from '../push/index.mjs';

const TEST_FIXTURE='TEST_FIXTURE';
const step=tf=>tf==='4h'?14400000:tf==='1h'?3600000:900000;

function series(tf,count,now=1700054000000){
  const start=now-count*step(tf)+1;
  const s=step(tf);
  return Array.from({length:count},(_,i)=>{
    const o=100+i*.02,c=o+.02;
    return {symbol:'BTCUSDT',timeframe:tf,openTime:start+i*s,closeTime:start+i*s+s-1,open:o,high:c+.05,low:o-.05,close:c,
      volume:1000,quoteVolume:c*1000,tradeCount:1000,takerBuyBaseVolume:500,takerBuyQuoteVolume:c*500,
      closed:true,source:TEST_FIXTURE,sourceTime:start+i*s+s-1};
  });
}
function breakout(start=1700054000000-60*900000+1){
  const s=900000;
  const a=Array.from({length:59},(_,i)=>({symbol:'BTCUSDT',timeframe:'15m',openTime:start+i*s,closeTime:start+i*s+s-1,
    open:100,high:101,low:99,close:100.1,volume:1000,quoteVolume:100000,tradeCount:1000,
    takerBuyBaseVolume:500,takerBuyQuoteVolume:50000,closed:true,source:TEST_FIXTURE,sourceTime:start+i*s+s-1}));
  a.push({symbol:'BTCUSDT',timeframe:'15m',openTime:start+59*s,closeTime:start+60*s-1,open:100.2,high:103.2,low:100.1,close:103,
    volume:2200,quoteVolume:226600,tradeCount:3000,takerBuyBaseVolume:1300,takerBuyQuoteVolume:133900,
    closed:true,source:TEST_FIXTURE,sourceTime:start+60*s-1});
  return a;
}
function snap(now=1700054000000){
  return {symbol:'BTCUSDT',series4h:series('4h',250,now),series1h:series('1h',250,now),series15m:breakout(now-60*900000+1),
    bookRaw:{bids:[['102.99','2000']],asks:[['103.01','1000']]},ticker24hRaw:{quoteVolume:'100000000',count:10000},
    wsState:'LIVE',restLastSuccessAt:1700054000000,source:'BINANCE_PUBLIC_WS',unresolvedGap:false};
}
class TestPush{constructor(){this.calls=[]}status(){return{provider:TEST_FIXTURE,enabled:true}}async send(sub,payload){this.calls.push({sub,payload});return{ok:true,status:'SENT',httpStatus:201}}}

async function serviceCase(){
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-e2e-')),store=await new DurableStore({dir}).init(),provider=new TestPush();
  await store.putUserSettings('u1',{enabled:true,symbols:['BTCUSDT'],timeframes:['15m'],minDataQuality:70,minLiquidityQuality:60,signalTypes:['CONFIRMED','ENTRY_CANDIDATE']});
  await store.upsertSubscription('u1',{endpoint:'https://push.example.test/e2e',expirationTime:null,keys:{p256dh:'TEST_FIXTURE_P256DH',auth:'TEST_FIXTURE_AUTH'}});
  const service=new SignalService({deduplicator:new SignalDeduplicator({store,windowMs:900000}),store,
    pushManager:new PushManager({provider,store,retryBaseMs:1}),
    config:{...CONFIG,monitoring:{...CONFIG.monitoring,maxStaleTriggerMs:1800000},paper:{feeRate:0,slippageBps:0}},
    clock:()=>1700054000000});
  return {store,provider,service};
}

test('TEST_FIXTURE: market -> closed candle -> gate -> Phase1 engine -> Unified JSON -> dedup -> audit -> push',async()=>{
  const {store,provider,service}=await serviceCase();
  const first=await service.evaluateSnapshot(snap());
  assert.equal(first.emitted,true);assert.equal(first.signal.market,'SPOT');assert.equal(first.signal.candle.closed,true);
  assert.equal(first.signal.data_status.status,'LIVE_DATA');
  assert.equal(first.signal.data_status.source,'BINANCE_PUBLIC_WS');
  assert.equal(first.signal.data_status.candle_closed,true);
  assert.ok(Number.isFinite(first.signal.data_status.open_time));
  assert.ok(Number.isFinite(first.signal.data_status.close_time));
  assert.ok(Number.isFinite(first.signal.data_status.source_time));
  assert.ok(Number.isFinite(first.signal.data_status.age_seconds));
  assert.equal(first.signal.data_status.received_at,null);
  assert.equal(first.signal.scores.confidence_score,'UNKNOWN');assert.equal(first.signal.paper_trade.enabled,true);
  assert.equal(first.signal.paper_trade.real_order_execution,false);assert.equal(provider.calls.length,1);
  assert.equal(first.notifications[0].status,'SENT');
  const sig=await store.readRecent('signals',20),note=await store.readRecent('notifications',20);
  assert.ok(sig.some(x=>x.signal_id===first.signal.signal_id&&x.signal_snapshot));
  assert.ok(note.some(x=>x.signal_id===first.signal.signal_id&&x.status==='SENT'));
  const latest=await store.getSignalSnapshot('BTCUSDT');
  assert.equal(latest.symbol,'BTCUSDT');
  assert.equal(latest.signal.paper_trade.real_order_execution,false);
  assert.equal(latest.signal.scores.confidence_score,'UNKNOWN');
  assert.equal(latest.strategies.trend.strategy,'MTF_TREND');
  assert.equal(latest.strategies.breakout.strategy,'CONFIRMED_BREAKOUT');
  assert.equal(latest.strategies.meanReversion.strategy,'MEAN_REVERSION');
  const second=await service.evaluateSnapshot(snap());
  assert.equal(second.emitted,false);assert.ok(second.blocked.includes('DUPLICATE_SIGNAL'));assert.equal(provider.calls.length,1);
});

test('TEST_FIXTURE: incomplete candle and stale data cannot send push',async()=>{
  const a=await serviceCase();const input=snap();
  input.series15m=input.series15m.map((c,i)=>i===input.series15m.length-1?{...c,closed:false}:c);
  const incomplete=await a.service.evaluateSnapshot(input);assert.equal(incomplete.emitted,false);
  assert.equal(incomplete.signal.data_status.status,'LIVE_DATA');
  assert.equal(incomplete.signal.data_status.candle_closed,true);
  assert.equal(incomplete.signal.data_status.latest_series_candle_closed,false);
  assert.equal(a.provider.calls.length,0);
  const b=await serviceCase();const staleService=new SignalService({deduplicator:new SignalDeduplicator({store:b.store}),store:b.store,pushManager:new PushManager({provider:b.provider,store:b.store}),
    config:{...CONFIG,paper:{feeRate:0,slippageBps:0},monitoring:{...CONFIG.monitoring,maxStaleTriggerMs:60000}},clock:()=>1701000000000});
  const stale=await staleService.evaluateSnapshot(snap());assert.equal(stale.emitted,false);assert.equal(b.provider.calls.length,0);
});
