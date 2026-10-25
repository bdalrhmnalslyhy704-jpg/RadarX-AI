import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPreMoveWatchOnlyAlert,buildPreMoveWatchOnlyAlerts,diagnosePreMoveWatchOnlyCandidates} from '../http/api.mjs';
import {PushManager} from '../push/index.mjs';
import {DurableStore} from '../core/store.mjs';
import {SignalDeduplicator} from '../core/dedup.mjs';
import {defaultSettings} from '../core/signal-service.mjs';
import {pushSubscription} from './fixtures.mjs';

function fixture(now=Date.now()){
  const p={
    stage:'WATCH_EARLY',watch_only:true,actionable:false,evidence_complete:true,closed_candles_only:true,
    already_moved:false,session_close:now-60_000,score:72.2,session_return_pct:.98,one_hour_return_pct:2.11,
    volume_acceleration:.96,trade_acceleration:1.078,taker_buy_ratio:.552,taker_buy_acceleration:.069,
    mean_close_location:.82,relative_strength_vs_market_pct:2.18,
    components:{squeeze:23.3,structure:76.4,buying_pressure:67.1},
    reasons:['TRADE_COUNT_ACCELERATING','TAKER_BUY_ACCELERATING','RELATIVE_STRENGTH']
  };
  const candidate={
    symbol:'DASHUSDT',last_price:51.31,price_change_24h:-4.628,data_quality:100,liquidity_quality:97.56,
    data_status:{data_valid:true,data_stale:false,stale:false,future_data_detected:false},
    watch_only:true,alert_eligible:false,watch_reason_codes:['VOLUME_ACCELERATION_NOT_CONFIRMED'],
    risk_flags:[],pre_move_context:p
  };
  const snapshot={source:'Binance Public REST',meta:{radar:'PRE_MOVE',live:true,paper_trading:true,real_order_execution:false}};
  return {candidate,snapshot,now};
}

test('Build 224 converts qualified Pre-Move WATCH_EARLY into a non-entry watch alert only',()=>{
  const {candidate,snapshot,now}=fixture();
  const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
  assert.ok(alert);
  assert.equal(alert.event,'PRE_MOVE_RADAR_WATCH_ONLY');
  assert.equal(alert.radar,'PRE_MOVE');
  assert.equal(alert.symbol,'DASHUSDT');
  assert.equal(alert.watch_only,true);
  assert.equal(alert.entry_eligible,false);
  assert.equal(alert.closed_candles_only,true);
  assert.equal(alert.paper_trading,true);
  assert.equal(alert.real_order_execution,false);
  assert.equal(alert.detected_candle_close_time,now-60_000);
});

test('Pre-Move local fallback exposes only the top three unique, strictly validated WATCH_EARLY rows',()=>{
  const {candidate,snapshot,now}=fixture();
  const low={...candidate,symbol:'LOWUSDT',pre_move_context:{...candidate.pre_move_context,score:69}};
  const strong={...candidate,symbol:'STRONGUSDT',pre_move_context:{...candidate.pre_move_context,score:81}};
  const sameSymbolBetter={...candidate,pre_move_context:{...candidate.pre_move_context,score:76}};
  const invalid={...candidate,symbol:'STALEUSDT',data_status:{data_valid:false,data_stale:true}};
  const alerts=buildPreMoveWatchOnlyAlerts([candidate,low,strong,sameSymbolBetter,invalid],snapshot,now,3);
  assert.deepEqual(alerts.map(x=>x.symbol),['STRONGUSDT','DASHUSDT','LOWUSDT']);
  assert.equal(alerts.length,3);
  assert.ok(alerts.every(x=>x.watch_only===true&&x.entry_eligible===false&&x.event==='PRE_MOVE_RADAR_WATCH_ONLY'));
  assert.ok(alerts.every(x=>x.paper_trading===true&&x.real_order_execution===false&&x.closed_candles_only===true));
});

test('Pre-Move watch creation fails closed for stale, incomplete, extended, or low-confluence observations',()=>{
  const base=fixture();
  assert.equal(buildPreMoveWatchOnlyAlert({...base.candidate,data_status:{data_valid:false}},base.snapshot,base.now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...base.candidate,pre_move_context:{...base.candidate.pre_move_context,session_close:base.now-21*60_000}},base.snapshot,base.now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...base.candidate,price_change_24h:13},base.snapshot,base.now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...base.candidate,pre_move_context:{...base.candidate.pre_move_context,already_moved:true}},base.snapshot,base.now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...base.candidate,pre_move_context:{...base.candidate.pre_move_context,trade_acceleration:.5,taker_buy_ratio:.48,taker_buy_acceleration:0,mean_close_location:.3,relative_strength_vs_market_pct:-1}},base.snapshot,base.now),null);
  assert.equal(buildPreMoveWatchOnlyAlert(base.candidate,{...base.snapshot,meta:{...base.snapshot.meta,live:false}},base.now),null);
});

test('Pre-Move watch notification sends only as WATCH_ONLY and suppresses repeat delivery',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-pre-move-watch-'));
  const store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    const sent=[];
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){
      sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};
    }};
    const manager=new PushManager({provider,store,deduplicator:new SignalDeduplicator({store,windowMs:15*60*1000})});
    const {candidate,snapshot,now}=fixture();
    const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
    assert.ok(alert);
    const first=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(first.status,'SENT',JSON.stringify(first));
    assert.equal(first.sent_count,1);
    assert.equal(sent.length,1);
    assert.equal(sent[0].watch_only,true);
    assert.equal(sent[0].entry_eligible,false);
    assert.equal(sent[0].paper_trading,true);
    assert.equal(sent[0].real_order_execution,false);
    assert.match(sent[0].title,/رادار ما قبل الحركة/);
    const second=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(second.status,'DUPLICATE_SUPPRESSED');
    assert.equal(sent.length,1);
    const audits=await store.readRecent('notifications',10);
    assert.equal(audits.filter(x=>x.event==='RADAR_WATCH_ONLY_NOTIFICATION'&&x.symbol==='DASHUSDT').length,1);
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});

test('failed Pre-Move watch delivery is retried with the same stable event ID and remains watch-only',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-pre-move-watch-retry-'));
  const store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    const sent=[];
    let calls=0;
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){
      sent.push(payload);calls++;
      return calls===1?{ok:false,status:'FAILED',reason:'TEMPORARY_TEST_FAILURE'}:{ok:true,status:'SENT',httpStatus:201};
    }};
    const manager=new PushManager({provider,store,deduplicator:new SignalDeduplicator({store,windowMs:15*60*1000}),retryBaseMs:1});
    const {candidate,snapshot,now}=fixture();
    const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
    assert.ok(alert);
    const first=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(first.status,'FAILED');
    assert.equal(first.sent_count,0);
    assert.equal(manager.retryQueue.size,1);
    await manager.flushRetries(Date.now()+100);
    assert.equal(calls,2);
    assert.equal(manager.retryQueue.size,0);
    assert.equal(sent[0].event_id,alert.id);
    assert.equal(sent[1].event_id,alert.id);
    for(const payload of sent){
      assert.equal(payload.watch_only,true);
      assert.equal(payload.entry_eligible,false);
      assert.equal(payload.paper_trading,true);
      assert.equal(payload.real_order_execution,false);
    }
    const audits=await store.readRecent('notifications',10);
    assert.ok(audits.some(x=>x.event==='RADAR_WATCH_ONLY_NOTIFICATION_RETRY'&&x.status==='SENT'&&x.alert_id===alert.id));
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});

test('failed Pre-Move watch delivery expires instead of sending stale evidence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-pre-move-watch-expire-'));
  const store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    let calls=0;
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(){
      calls++;return{ok:false,status:'FAILED',reason:'TEMPORARY_TEST_FAILURE'};
    }};
    const manager=new PushManager({provider,store,deduplicator:new SignalDeduplicator({store,windowMs:15*60*1000}),retryBaseMs:1});
    const {candidate,snapshot,now}=fixture();
    const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
    assert.ok(alert);
    const first=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(first.status,'FAILED');
    await manager.flushRetries(Date.now()+22*60*1000);
    assert.equal(calls,1);
    assert.equal(manager.retryQueue.size,0);
    const audits=await store.readRecent('notifications',10);
    assert.ok(audits.some(x=>x.event==='RADAR_WATCH_ONLY_NOTIFICATION_RETRY'&&x.status==='EXPIRED'&&x.alert_id===alert.id));
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});


test('Pre-Move live watch diagnostics identify the precise gate that blocks notifications',()=>{
  const {candidate,snapshot,now}=fixture();
  const blocked={...candidate,symbol:'BLOCKEDUSDT',data_status:{data_valid:false,data_stale:true}};
  const report=diagnosePreMoveWatchOnlyCandidates([candidate,blocked],snapshot,now,12);
  assert.equal(report.evaluated,2);
  assert.equal(report.eligible,1);
  assert.equal(report.rejected,1);
  assert.equal(report.rejection_counts.DATA_FRESHNESS_QUALITY_OR_LIQUIDITY_GATE,1);
  assert.equal(report.samples.find(x=>x.symbol==='DASHUSDT')?.eligible,true);
  assert.equal(report.samples.find(x=>x.symbol==='BLOCKEDUSDT')?.reason,'DATA_FRESHNESS_QUALITY_OR_LIQUIDITY_GATE');
});

test('live-like GTC early-watch sample qualifies for a watch-only heads-up when its full evidence is fresh',()=>{
  const {snapshot,now}=fixture();
  const candidate={
    symbol:'GTCUSDT',last_price:0.245,price_change_24h:1.87,data_quality:100,liquidity_quality:86.82,
    data_status:{data_valid:true,data_stale:false,candle_data_valid:true,volume_gate_pass:true},
    watch_only:true,alert_eligible:false,watch_reason_codes:[
      'BUY_FLOW_NOT_CONFIRMED','BUYER_CANDLE_CLOSES_NOT_CONFIRMED','COMPRESSION_NOT_CONFIRMED'
    ],risk_flags:[],
    pre_move_context:{
      stage:'WATCH_EARLY',watch_only:true,actionable:false,evidence_complete:true,
      closed_candles_only:true,already_moved:false,session_close:now-164_000,score:70.4,
      session_return_pct:1.2308651112,one_hour_return_pct:2.7285557472,
      volume_acceleration:3.5803363318,trade_acceleration:2.5414376321,
      taker_buy_ratio:0.4973520241,taker_buy_acceleration:0.0518422258,
      mean_close_location:0.4741007895,relative_strength_vs_market_pct:2.8217298389,
      components:{structure:77.6620484763,squeeze:42.5578369311,buying_pressure:55.4780308022}
    }
  };
  const report=diagnosePreMoveWatchOnlyCandidates([candidate],snapshot,now,12);
  assert.equal(report.eligible,1,JSON.stringify(report));
  assert.equal(report.samples[0].participation,4);
  const alerts=buildPreMoveWatchOnlyAlerts([candidate],snapshot,now,3);
  assert.equal(alerts.length,1);
  assert.equal(alerts[0].symbol,'GTCUSDT');
  assert.equal(alerts[0].watch_only,true);
  assert.equal(alerts[0].entry_eligible,false);
});
