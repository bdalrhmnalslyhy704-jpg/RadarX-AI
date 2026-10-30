import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPreMoveWatchOnlyAlert,buildPreMoveWatchOnlyAlerts,diagnosePreMoveWatchOnlyCandidates} from '../http/api.mjs';
import {PushManager, isTrustedBinancePublicSpotSource} from '../push/index.mjs';
import {DurableStore} from '../core/store.mjs';
import {SignalDeduplicator} from '../core/dedup.mjs';
import {defaultSettings} from '../core/signal-service.mjs';
import {pushSubscription} from './fixtures.mjs';
import {buildPreMoveWatchCandidates} from '../market/universe-scanner.mjs';

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

test('fresh market-wide ticker activity acceleration can produce a separate non-entry watch tier before hourly price confirmation',()=>{
  const {candidate,snapshot,now}=fixture();
  const early={
    ...candidate,
    symbol:'CFGUSDT',
    price_change_24h:0.59,
    quote_volume_24h:5_000_000,
    data_quality:100,
    liquidity_quality:85,
    ticker_activity:{
      score:14,volume_delta_per_minute:1200,trade_delta_per_minute:65,
      volume_acceleration_ratio:2.4,trade_acceleration_ratio:1.7,
      observed_at:now-45_000,baseline_age_ms:90_000
    },
    pre_move_context:{
      ...candidate.pre_move_context,
      score:77.5,session_return_pct:0.59,one_hour_return_pct:0,
      volume_acceleration:1.30,trade_acceleration:1.02,
      taker_buy_ratio:0.535,taker_buy_acceleration:0.084,
      mean_close_location:0.375,relative_strength_vs_market_pct:1.32,
      components:{squeeze:55,structure:60.1,buying_pressure:64},
      reasons:['VOLUME_ACCELERATING','TICKER_ACTIVITY_ACCELERATING']
    },
    data_status:{data_valid:true,data_stale:false,stale:false,future_data_detected:false,candle_data_valid:true,volume_gate_pass:true}
  };
  const alert=buildPreMoveWatchOnlyAlert(early,snapshot,now);
  assert.ok(alert,'a high-quality, recent volume/trade surge with independent buy evidence should be monitored even when one-hour return is zero');
  assert.equal(alert.symbol,'CFGUSDT');
  assert.equal(alert.watch_notification_tier,'TICKER_ACTIVITY_ACCELERATION_MONITOR');
  assert.equal(alert.watch_only,true);
  assert.equal(alert.entry_eligible,false);
  assert.equal(alert.paper_trading,true);
  assert.equal(alert.real_order_execution,false);
  assert.equal(alert.ticker_activity_watch_evidence.score,14);
});

test('ticker-activity watch tier rejects weak, stale, low-liquidity and extended setups',()=>{
  const {candidate,snapshot,now}=fixture();
  const base={
    ...candidate,symbol:'EARLYACTUSDT',price_change_24h:1.1,quote_volume_24h:2_000_000,
    ticker_activity:{score:14,volume_acceleration_ratio:2.2,trade_acceleration_ratio:1.5,observed_at:now-30_000,baseline_age_ms:90_000},
    data_quality:96,liquidity_quality:82,
    pre_move_context:{...candidate.pre_move_context,score:72,session_return_pct:1,one_hour_return_pct:0.05,
      volume_acceleration:1.1,trade_acceleration:0.9,taker_buy_ratio:0.53,taker_buy_acceleration:0.04,
      mean_close_location:0.55,relative_strength_vs_market_pct:0.8,components:{...candidate.pre_move_context.components,structure:55}},
    data_status:{data_valid:true,data_stale:false,stale:false,future_data_detected:false,candle_data_valid:true,volume_gate_pass:true}
  };
  assert.ok(buildPreMoveWatchOnlyAlert(base,snapshot,now));
  assert.ok(buildPreMoveWatchOnlyAlert({...base,ticker_activity:{...base.ticker_activity,score:10.32}},snapshot,now),
    'moderate but sustained activity is eligible only for the stricter monitor-only lane');
  assert.equal(buildPreMoveWatchOnlyAlert({...base,ticker_activity:{...base.ticker_activity,score:8}},snapshot,now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...base,ticker_activity:{...base.ticker_activity,observed_at:now-6*60_000}},snapshot,now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...base,liquidity_quality:65},snapshot,now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...base,price_change_24h:6},snapshot,now),null);
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

test('ordinary watch-only Pre-Move observations remain in-app until a qualified monitor tier',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-pre-move-watch-')),store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    let calls=0;
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(){calls++;return{ok:true,status:'SENT',httpStatus:201};}};
    const manager=new PushManager({provider,store,deduplicator:new SignalDeduplicator({store,windowMs:15*60*1000})});
    const {candidate,snapshot,now}=fixture();
    const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
    assert.ok(alert);
    const first=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(first.status,'WATCH_ONLY_FEED_ONLY');
    assert.equal(first.sent_count,0);
    assert.equal(first.attempted,false);
    const second=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(second.status,'WATCH_ONLY_FEED_ONLY');
    assert.equal(second.sent_count,0);
    assert.equal(calls,0);
    const audits=await store.readRecent('notifications',10);
    assert.equal(audits.filter(x=>x.event==='RADAR_WATCH_ONLY_NOTIFICATION'&&x.status==='WATCH_ONLY_FEED_ONLY'&&x.symbol==='DASHUSDT').length,2);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('live-scan DOGE-like early flow becomes a bounded monitor alert when price is still negative',async()=>{
  const now=Date.now();
  const candidate={
    symbol:'DOGEUSDT',last_price:0.07691,price_change_24h:-0.298,
    data_quality:100,liquidity_quality:98.37,
    data_status:{data_valid:true,data_stale:false,stale:false,future_data_detected:false,source:'Binance Public REST'},
    watch_only:true,alert_eligible:false,watch_reason_codes:[
      'BUY_FLOW_NOT_CONFIRMED','PRICE_WINDOW_NOT_CONFIRMED','COMPRESSION_NOT_CONFIRMED'
    ],
    risk_flags:[],
    pre_move_context:{
      stage:'WATCH_EARLY',watch_only:true,actionable:false,evidence_complete:true,
      closed_candles_only:true,already_moved:false,session_close:now-60_000,
      score:70.5,session_return_pct:-1.2455,one_hour_return_pct:-0.2719,
      volume_acceleration:1.6229,trade_acceleration:1.0977,
      taker_buy_ratio:0.5024,taker_buy_acceleration:0.1332,
      mean_close_location:0.5978,relative_strength_vs_market_pct:0.3293,
      components:{squeeze:49.97,structure:65.48,buying_pressure:56.59},
      reasons:['VOLUME_ACCELERATING','TRADE_COUNT_ACCELERATING','TAKER_BUY_ACCELERATING']
    }
  };
  const snapshot={source:'Binance Public REST',meta:{
    radar:'PRE_MOVE',live:true,paper_trading:true,real_order_execution:false
  }};
  const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
  assert.ok(alert,'qualified early-flow monitoring should not require positive price return');
  assert.equal(alert.watch_notification_tier,'EARLY_FLOW_MONITOR');
  assert.equal(alert.watch_only,true);
  assert.equal(alert.entry_eligible,false);

  const dir=await mkdtemp(join(tmpdir(),'radarx-live-scan-early-flow-'));
  const store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    const sent=[];
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){
      sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};
    }};
    const manager=new PushManager({provider,store,deduplicator:new SignalDeduplicator({store,windowMs:15*60*1000})});
    const result=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(result.status,'SENT',JSON.stringify(result));
    assert.equal(result.sent_count,1);
    assert.equal(result.attempted,true);
    assert.equal(sent.length,1,'a strictly qualified early-flow monitor reaches the phone as a non-entry heads-up');
    assert.equal(sent[0].watch_only,true);
    assert.equal(sent[0].entry_eligible,false);
    assert.equal(sent[0].real_order_execution,false);
    assert.equal(sent[0].notification_mode,'PRE_MOVE_WATCH_ONLY');
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});


test('live near-miss with 1.5x volume, 1.5x trades and strong relative strength receives non-entry accumulation-prep heads-up',async()=>{
  const now=Date.now();
  const candidate={
    symbol:'LINKUSDT',last_price:12.5,price_change_24h:2.695,quote_volume_24h:7_500_000,
    data_quality:100,liquidity_quality:98.94,
    data_status:{data_valid:true,data_stale:false,stale:false,future_data_detected:false,source:'Binance Public REST'},
    watch_only:true,alert_eligible:false,risk_flags:[],
    pre_move_context:{
      stage:'WATCH_EARLY',watch_only:true,actionable:false,evidence_complete:true,
      closed_candles_only:true,already_moved:false,session_close:now-8*60_000,
      score:67.6,session_return_pct:1.5785,one_hour_return_pct:-0.0849,
      volume_acceleration:1.7754,trade_acceleration:1.5660,
      taker_buy_ratio:0.5207,taker_buy_acceleration:0.0169,
      mean_close_location:0.4855,relative_strength_vs_market_pct:1.6853,
      components:{squeeze:55,structure:65.62,buying_pressure:56},
      reasons:['VOLUME_ACCELERATING','TRADE_COUNT_ACCELERATING','RELATIVE_STRENGTH']
    }
  };
  const snapshot={source:'Binance Public REST',meta:{
    radar:'PRE_MOVE',live:true,paper_trading:true,real_order_execution:false
  }};
  const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
  assert.ok(alert,'a qualified high-liquidity accumulation near-miss should be visible as monitoring');
  assert.equal(alert.watch_notification_tier,'ACCUMULATION_PREP_MONITOR');
  assert.equal(alert.watch_only,true);
  assert.equal(alert.entry_eligible,false);
  assert.equal(alert.real_order_execution,false);
  const dir=await mkdtemp(join(tmpdir(),'radarx-accumulation-prep-monitor-'));
  const store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    const sent=[];
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){
      sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};
    }};
    const manager=new PushManager({provider,store,deduplicator:new SignalDeduplicator({store,windowMs:15*60*1000})});
    const result=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(result.status,'SENT',JSON.stringify(result));
    assert.equal(result.sent_count,1);
    assert.equal(sent.length,1);
    assert.equal(sent[0].watch_notification_tier,'ACCUMULATION_PREP_MONITOR');
    assert.equal(sent[0].watch_only,true);
    assert.equal(sent[0].entry_eligible,false);
    assert.equal(sent[0].real_order_execution,false);
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});

test('compressed buyer absorption qualifies as one bounded pre-breakout watch, never as entry',async()=>{
  const now=Date.now();
  const {candidate:base,snapshot}=fixture(now);
  const candidate={
    ...base,symbol:'HYPEUSDT',last_price:79.39,price_change_24h:-3.723,
    quote_volume_24h:125_370_000,data_quality:100,liquidity_quality:96,
    data_status:{data_valid:true,data_stale:false,stale:false,future_data_detected:false,candle_data_valid:true,volume_gate_pass:true},
    watch_only:true,alert_eligible:false,risk_flags:[],
    pre_move_context:{
      ...base.pre_move_context,stage:'WATCH_EARLY',watch_only:true,actionable:false,
      evidence_complete:true,closed_candles_only:true,already_moved:false,session_close:now-5*60_000,
      score:72.6,session_return_pct:-0.9482,one_hour_return_pct:0.2526,
      volume_acceleration:0.267,trade_acceleration:0.5407,
      taker_buy_ratio:0.6822,taker_buy_acceleration:0.1231,
      mean_close_location:0.5575,relative_strength_vs_market_pct:0.1599,
      relative_strength_vs_btc_pct:0.1599,
      components:{squeeze:48.68,structure:60.68,buying_pressure:99.83},
      reasons:['TAKER_BUY_ACCELERATING','BUYERS_HOLDING_CANDLE_CLOSES']
    }
  };
  const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
  assert.ok(alert,'high buyer absorption, compression and structure warrants a bounded watch before confirmation');
  assert.equal(alert.watch_notification_tier,'COMPRESSED_BUYER_ABSORPTION_MONITOR');
  assert.equal(alert.watch_only,true);
  assert.equal(alert.entry_eligible,false);
  assert.equal(alert.real_order_execution,false);
  assert.equal(alert.paper_trading,true);

  const weaker=buildPreMoveWatchOnlyAlert({
    ...candidate,pre_move_context:{
      ...candidate.pre_move_context,
      components:{...candidate.pre_move_context.components,buying_pressure:72}
    }
  },snapshot,now);
  assert.notEqual(weaker?.watch_notification_tier,'COMPRESSED_BUYER_ABSORPTION_MONITOR',
    'weaker buyer absorption must not qualify this special lane');

  const dir=await mkdtemp(join(tmpdir(),'radarx-compressed-buyer-watch-'));
  const store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    const sent=[];
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){
      sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};
    }};
    const manager=new PushManager({provider,store,deduplicator:new SignalDeduplicator({store,windowMs:15*60*1000})});
    const result=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(result.status,'SENT',JSON.stringify(result));
    assert.equal(result.sent_count,1);
    assert.equal(sent.length,1);
    assert.equal(sent[0].watch_notification_tier,'COMPRESSED_BUYER_ABSORPTION_MONITOR');
    assert.equal(sent[0].watch_only,true);
    assert.equal(sent[0].entry_eligible,false);
    assert.equal(sent[0].real_order_execution,false);
    const duplicate=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(duplicate.status,'DUPLICATE_SUPPRESSED');
    assert.equal(sent.length,1,'one market event must not create repeated monitor pushes');
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});

test('EARLY_FLOW_MONITOR survives the final push gate before price confirmation, as monitor-only',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-pre-move-early-flow-monitor-'));
  const store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    const sent=[];
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){
      sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};
    }};
    const manager=new PushManager({provider,store,deduplicator:new SignalDeduplicator({store,windowMs:15*60*1000})});
    const now=Date.now();
    const candidate={
      symbol:'EARLYMONITORUSDT',last_price:1.02,price_change_24h:1.1,
      data_quality:92,liquidity_quality:82,
      data_status:{data_valid:true,data_stale:false,stale:false,future_data_detected:false,source:'Binance Public REST'},
      watch_only:true,alert_eligible:false,watch_reason_codes:['BUY_FLOW_NOT_CONFIRMED','PRICE_WINDOW_NOT_CONFIRMED'],
      risk_flags:[],
      pre_move_context:{
        stage:'WATCH_EARLY',watch_only:true,actionable:false,evidence_complete:true,
        closed_candles_only:true,already_moved:false,session_close:now-60_000,
        score:73,session_return_pct:-0.4,one_hour_return_pct:-0.25,
        volume_acceleration:1.8,trade_acceleration:1.3,
        taker_buy_ratio:0.58,taker_buy_acceleration:0.035,
        mean_close_location:0.56,relative_strength_vs_market_pct:0.45,
        components:{structure:57,squeeze:62,buying_pressure:63},
        reasons:['VOLUME_ACCELERATING','TRADE_COUNT_ACCELERATING','EARLY_FLOW_MONITOR']
      }
    };
    const snapshot={source:'Binance Public REST',meta:{radar:'PRE_MOVE',live:true,paper_trading:true,real_order_execution:false}};
    const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
    assert.ok(alert);
    assert.equal(alert.watch_notification_tier,'EARLY_FLOW_MONITOR');
    const result=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(result.status,'SENT',JSON.stringify(result));
    assert.equal(result.sent_count,1);
    assert.equal(sent.length,1,'high-evidence EARLY_FLOW_MONITOR is a phone heads-up while remaining non-actionable');
    assert.equal(sent[0].watch_only,true);
    assert.equal(sent[0].entry_eligible,false);
    assert.equal(sent[0].signal_type,'WATCH_ONLY');
    const duplicate=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(duplicate.status,'DUPLICATE_SUPPRESSED');
    assert.equal(sent.length,1,'the same coin is capped by its per-symbol cooldown');

    const unsafe={
      ...alert,
      symbol:'WEAKFLOWUSDT',
      id:'PRE_MOVE_WATCH:WEAKFLOWUSDT:'+String(now-60_000),
      pre_move_context:{
        ...alert.pre_move_context,session_return_pct:0.1,one_hour_return_pct:0.2,
        taker_buy_ratio:0.49,volume_acceleration:1.1,
        components:{...alert.pre_move_context.components,structure:60}
      }
    };
    const rejected=await manager.notifyRadarWatchOnlyAlert(unsafe);
    assert.equal(rejected.status,'REJECTED_WATCH_ONLY');
    assert.equal(rejected.reason,'PRE_MOVE_EARLY_FLOW_TIER_UNVERIFIED');
    assert.equal(sent.length,1,'weak flow remains blocked and does not produce an additional push');
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});

test('final push gate accepts only a fresh, high-confluence ticker-activity monitor alert',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-ticker-activity-watch-push-'));
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
    const early={
      ...candidate,symbol:'CFGUSDT',price_change_24h:.59,quote_volume_24h:5_000_000,
      data_quality:100,liquidity_quality:85,
      ticker_activity:{score:10.32,volume_delta_per_minute:29104.16,trade_delta_per_minute:143,
        volume_acceleration_ratio:2.74,trade_acceleration_ratio:1.45,observed_at:now-45_000,baseline_age_ms:60_000},
      pre_move_context:{...candidate.pre_move_context,score:77.5,session_return_pct:.59,one_hour_return_pct:0,
        volume_acceleration:1.05,trade_acceleration:.92,taker_buy_ratio:.52,taker_buy_acceleration:.084,
        mean_close_location:.48,relative_strength_vs_market_pct:1.32,
        components:{squeeze:45,structure:55,buying_pressure:54}},
      data_status:{data_valid:true,data_stale:false,stale:false,future_data_detected:false,close_time:now-60_000}
    };
    const alert=buildPreMoveWatchOnlyAlert(early,snapshot,now);
    assert.ok(alert);
    assert.equal(alert.watch_notification_tier,'TICKER_ACTIVITY_ACCELERATION_MONITOR');
    const result=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(result.status,'SENT',JSON.stringify(result));
    assert.equal(result.sent_count,1);
    assert.equal(sent.length,1,'a fresh high-confluence ticker-activity monitor sends a watch-only push');
    assert.equal(sent[0].watch_only,true);
    assert.equal(sent[0].entry_eligible,false);
    assert.equal(sent[0].real_order_execution,false);

    const weakAlert={...alert,id:alert.id.replace('CFGUSDT','WEAKUSDT'),symbol:'WEAKUSDT',
      ticker_activity_watch_evidence:{...alert.ticker_activity_watch_evidence,score:8}};
    const rejected=await manager.notifyRadarWatchOnlyAlert(weakAlert);
    assert.equal(rejected.status,'REJECTED_WATCH_ONLY');
    assert.equal(rejected.reason,'PRE_MOVE_TICKER_ACTIVITY_TIER_UNVERIFIED');
    assert.equal(sent.length,1,'weak activity evidence cannot add a second phone push');
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});

test('non-tiered Pre-Move watch remains feed-only and cannot queue push retries',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-pre-move-watch-retry-')),store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    let calls=0;
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(){calls++;return{ok:false,status:'FAILED',reason:'TEMPORARY_TEST_FAILURE'};}};
    const manager=new PushManager({provider,store,deduplicator:new SignalDeduplicator({store,windowMs:15*60*1000}),retryBaseMs:1});
    const {candidate,snapshot,now}=fixture();
    const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
    assert.ok(alert);
    const result=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(result.status,'WATCH_ONLY_FEED_ONLY');
    assert.equal(result.sent_count,0);
    assert.equal(result.attempted,false);
    assert.equal(manager.retryQueue.size,0);
    await manager.flushRetries(Date.now()+100);
    assert.equal(calls,0);
    const audits=await store.readRecent('notifications',10);
    assert.ok(audits.some(x=>x.event==='RADAR_WATCH_ONLY_NOTIFICATION'&&x.status==='WATCH_ONLY_FEED_ONLY'&&x.alert_id===alert.id));
    assert.equal(audits.some(x=>x.event==='RADAR_WATCH_ONLY_NOTIFICATION_RETRY'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('feed-only Pre-Move watch does not queue stale push retries',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-pre-move-watch-expire-')),store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    let calls=0;
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(){calls++;return{ok:false,status:'FAILED',reason:'TEMPORARY_TEST_FAILURE'};}};
    const manager=new PushManager({provider,store,deduplicator:new SignalDeduplicator({store,windowMs:15*60*1000}),retryBaseMs:1});
    const {candidate,snapshot,now}=fixture();
    const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
    assert.ok(alert);
    const result=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(result.status,'WATCH_ONLY_FEED_ONLY');
    await manager.flushRetries(Date.now()+22*60*1000);
    assert.equal(calls,0);
    assert.equal(manager.retryQueue.size,0);
    const audits=await store.readRecent('notifications',10);
    assert.ok(audits.some(x=>x.event==='RADAR_WATCH_ONLY_NOTIFICATION'&&x.status==='WATCH_ONLY_FEED_ONLY'&&x.alert_id===alert.id));
    assert.equal(audits.some(x=>x.status==='EXPIRED'&&x.event==='RADAR_WATCH_ONLY_NOTIFICATION_RETRY'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('non-qualified Pre-Move watches are reported as feed-only even when no phone subscription exists',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-pre-move-feed-only-no-subscriber-'));
  const store=await new DurableStore({dir}).init();
  try{
    const provider={status:()=>({provider:'fcm',enabled:true}),async send(){
      throw new Error('FEED_ONLY_MUST_NOT_SEND');
    }};
    const manager=new PushManager({provider,store,deduplicator:new SignalDeduplicator({store,windowMs:15*60*1000})});
    const {candidate,snapshot,now}=fixture();
    const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
    assert.ok(alert);
    assert.notEqual(alert.watch_notification_tier,'HIGH_ACTIVITY_STRUCTURE_PENDING');
    assert.notEqual(alert.watch_notification_tier,'EARLY_FLOW_MONITOR');
    assert.notEqual(alert.watch_notification_tier,'TICKER_ACTIVITY_ACCELERATION_MONITOR');
    const result=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(result.status,'WATCH_ONLY_FEED_ONLY');
    assert.equal(result.reason,'FINAL_CONFIRMATION_REQUIRED');
    assert.equal(result.attempted,false);
    assert.equal(result.sent_count,0);
    assert.equal(manager.retryQueue.size,0);
    assert.equal((await store.readRecent('notifications',10)).length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
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


test('exceptional live-like activity creates a labelled watch-only heads-up at 57% buy share when independent flow acceleration is exceptional',async()=>{
  const {snapshot,now}=fixture();
  const candidate={
    symbol:'MEGAUSDT',last_price:0.1977,price_change_24h:3.702,data_quality:100,liquidity_quality:92.36,
    data_status:{data_valid:true,data_stale:false,stale:false,future_data_detected:false,candle_data_valid:true},
    watch_only:true,alert_eligible:false,watch_reason_codes:[
      'BUY_FLOW_NOT_CONFIRMED','BUYER_CANDLE_CLOSES_NOT_CONFIRMED','STRUCTURE_NOT_CONFIRMED'
    ],risk_flags:[],
    pre_move_context:{
      stage:'WATCH_EARLY',watch_only:true,actionable:false,evidence_complete:true,closed_candles_only:true,
      already_moved:false,session_close:now-129_000,score:75.6,
      session_return_pct:2.6675,one_hour_return_pct:1.9399,
      volume_acceleration:23.4119,trade_acceleration:15.3842,
      taker_buy_ratio:0.57,taker_buy_acceleration:0.08,
      mean_close_location:0.3545,relative_strength_vs_market_pct:4.1490,
      components:{structure:54.0185,squeeze:0,buying_pressure:70.8968},
      reasons:['VOLUME_ACCELERATION_STRONG','TRADE_ACCELERATION_STRONG','RELATIVE_STRENGTH']
    }
  };
  const report=diagnosePreMoveWatchOnlyCandidates([candidate],snapshot,now,12);
  assert.equal(report.eligible,1,JSON.stringify(report));
  assert.equal(report.samples[0].watch_notification_tier,'HIGH_ACTIVITY_STRUCTURE_PENDING');
  const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
  assert.ok(alert);
  assert.equal(alert.watch_notification_tier,'HIGH_ACTIVITY_STRUCTURE_PENDING');
  assert.equal(alert.watch_only,true);
  assert.equal(alert.entry_eligible,false);
  assert.equal(alert.paper_trading,true);
  assert.equal(alert.real_order_execution,false);
  assert.ok(alert.reason_codes.includes('HIGH_ACTIVITY_STRUCTURE_PENDING'));

  // Verify that the second, independent push gate accepts this same strict tier,
  // without converting it to an entry signal or creating an exchange order.
  const dir=await mkdtemp(join(tmpdir(),'radarx-high-activity-57pct-push-'));
  const store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    const sent=[];
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){
      sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};
    }};
    const manager=new PushManager({provider,store,deduplicator:new SignalDeduplicator({store,windowMs:15*60*1000})});
    const result=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(result.status,'SENT',JSON.stringify(result));
    assert.equal(result.sent_count,1);
    assert.equal(sent.length,1);
    assert.equal(sent[0].watch_only,true);
    assert.equal(sent[0].entry_eligible,false);
    assert.equal(sent[0].paper_trading,true);
    assert.equal(sent[0].real_order_execution,false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('exceptional buyer flow qualifies for monitor-only before session and hourly returns turn positive',()=>{
  const {snapshot,now}=fixture();
  const candidate={
    symbol:'ASTRUSDT',last_price:0.035,price_change_24h:1.1,data_quality:100,liquidity_quality:84.94,
    data_status:{data_valid:true,data_stale:false,stale:false,future_data_detected:false,candle_data_valid:true},
    watch_only:true,alert_eligible:false,watch_reason_codes:['BUYER_FLOW_STRONG','PRICE_WINDOW_NOT_CONFIRMED'],
    risk_flags:[],
    pre_move_context:{
      stage:'WATCH_EARLY',watch_only:true,actionable:false,evidence_complete:true,closed_candles_only:true,
      already_moved:false,session_close:now-800_000,score:77.7,
      session_return_pct:-0.176366843,one_hour_return_pct:-0.0160771704,
      volume_acceleration:4.2677557,trade_acceleration:2.4360902,
      taker_buy_ratio:0.7292044,taker_buy_acceleration:0.3771112,
      mean_close_location:0.5048246,relative_strength_vs_market_pct:0.8874629,
      components:{structure:60.4391,squeeze:55.0,buying_pressure:80.0}
    }
  };
  const diagnostics=diagnosePreMoveWatchOnlyCandidates([candidate],snapshot,now,12);
  assert.equal(diagnostics.eligible,1,JSON.stringify(diagnostics));
  assert.equal(diagnostics.samples[0].watch_notification_tier,'HIGH_ACTIVITY_STRUCTURE_PENDING');
  const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
  assert.ok(alert);
  assert.equal(alert.symbol,'ASTRUSDT');
  assert.equal(alert.watch_notification_tier,'HIGH_ACTIVITY_STRUCTURE_PENDING');
  assert.equal(alert.watch_only,true);
  assert.equal(alert.entry_eligible,false);
  assert.equal(alert.real_order_execution,false);
});

test('early buyer-flow monitor can notify before price confirmation without becoming an entry signal',()=>{
  const {candidate,snapshot,now}=fixture();
  const early={
    ...candidate,
    price_change_24h:1.1,
    data_quality:92,
    liquidity_quality:82,
    pre_move_context:{
      ...candidate.pre_move_context,
      stage:'WATCH_EARLY',watch_only:true,actionable:false,evidence_complete:true,
      closed_candles_only:true,already_moved:false,session_close:now-60_000,
      score:73,session_return_pct:-0.4,one_hour_return_pct:-0.25,
      volume_acceleration:1.8,trade_acceleration:1.3,
      taker_buy_ratio:0.58,taker_buy_acceleration:0.035,
      mean_close_location:0.56,relative_strength_vs_market_pct:0.45,
      components:{...candidate.pre_move_context.components,structure:57,squeeze:62,buying_pressure:63}
    }
  };
  const report=diagnosePreMoveWatchOnlyCandidates([early],snapshot,now,12);
  assert.equal(report.eligible,1,JSON.stringify(report));
  assert.equal(report.samples[0].watch_notification_tier,'EARLY_FLOW_MONITOR');
  const alert=buildPreMoveWatchOnlyAlert(early,snapshot,now);
  assert.ok(alert);
  assert.equal(alert.watch_notification_tier,'EARLY_FLOW_MONITOR');
  assert.equal(alert.watch_review_reason,'BUY_FLOW_AND_ACTIVITY_BEFORE_PRICE_CONFIRMATION');
  assert.ok(alert.reason_codes.includes('EARLY_FLOW_MONITOR'));
  assert.equal(alert.watch_only,true);
  assert.equal(alert.entry_eligible,false);
  assert.equal(alert.paper_trading,true);
  assert.equal(alert.real_order_execution,false);

  // The relaxed monitor lane must still reject overextended or unsafe market data.
  assert.equal(buildPreMoveWatchOnlyAlert({...early,price_change_24h:12},snapshot,now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...early,data_quality:84},snapshot,now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...early,risk_flags:['WIDE_SPREAD']},snapshot,now),null);
});

test('strong flow just outside the exceptional corridor falls back to the pre-price monitor tier',()=>{
  const {candidate,snapshot,now}=fixture();
  const early={
    ...candidate,price_change_24h:1.1,data_quality:92,liquidity_quality:82,
    pre_move_context:{
      ...candidate.pre_move_context,
      stage:'WATCH_EARLY',watch_only:true,actionable:false,evidence_complete:true,
      closed_candles_only:true,already_moved:false,session_close:now-60_000,
      score:76,session_return_pct:-1,one_hour_return_pct:-0.7,
      volume_acceleration:3,trade_acceleration:2,taker_buy_ratio:0.65,
      taker_buy_acceleration:0.05,mean_close_location:0.56,
      relative_strength_vs_market_pct:0.7,
      components:{...candidate.pre_move_context.components,structure:54,squeeze:62,buying_pressure:63}
    }
  };
  const report=diagnosePreMoveWatchOnlyCandidates([early],snapshot,now,12);
  assert.equal(report.eligible,1,JSON.stringify(report));
  assert.equal(report.samples[0].watch_notification_tier,'EARLY_FLOW_MONITOR');
  const alert=buildPreMoveWatchOnlyAlert(early,snapshot,now);
  assert.ok(alert);
  assert.equal(alert.watch_notification_tier,'EARLY_FLOW_MONITOR');
  assert.equal(alert.entry_eligible,false);
  assert.equal(alert.real_order_execution,false);
});

test('high-activity watch override still fails closed on weak data, low participation, extended risk, or very weak structure',()=>{
  const {candidate,snapshot,now}=fixture();
  const strong={
    ...candidate,symbol:'MEGAUSDT',price_change_24h:3.702,data_quality:100,liquidity_quality:92.36,
    pre_move_context:{
      ...candidate.pre_move_context,score:75.6,session_return_pct:2.6675,one_hour_return_pct:1.9399,
      volume_acceleration:23.4119,trade_acceleration:15.3842,taker_buy_ratio:0.71,
      taker_buy_acceleration:0.08,mean_close_location:0.3545,relative_strength_vs_market_pct:4.149,
      session_close:now-129_000,components:{...candidate.pre_move_context.components,structure:54.0185}
    }
  };
  assert.equal(buildPreMoveWatchOnlyAlert({...strong,data_quality:65},{...snapshot},now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...strong,pre_move_context:{...strong.pre_move_context,taker_buy_ratio:0.49,volume_acceleration:1.2,trade_acceleration:1.1,relative_strength_vs_market_pct:0.2}},snapshot,now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...strong,risk_flags:['ALREADY_EXTENDED']},snapshot,now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...strong,pre_move_context:{...strong.pre_move_context,components:{...strong.pre_move_context.components,structure:49.9}}},snapshot,now),null);
});


test('live public Spot source aliases are accepted but futures, unavailable and replay sources fail closed',()=>{
  for(const source of [
    'Binance Public REST',
    'Binance Public REST/WS',
    'Binance Public WebSocket',
    'Binance Public REST with endpoint rotation/fallback',
    'BINANCE_SPOT_PUBLIC_REST'
  ]) assert.equal(isTrustedBinancePublicSpotSource(source),true,source);
  for(const source of [
    'Binance Futures Public REST',
    'Binance Public REST unavailable',
    'Binance Public REST failed',
    'Mock Binance Public REST',
    'Historical replay data',
    'Unknown market source'
  ]) assert.equal(isTrustedBinancePublicSpotSource(source),false,source);
});


test('NIL-like participation surge becomes a bounded phone watch when the old 1h ceiling was too tight',async()=>{
  const {candidate:base,snapshot,now}=fixture();
  const candidate={
    ...base,symbol:'NILUSDT',price_change_24h:-3.94,quote_volume_24h:5_840_696,
    data_quality:96,liquidity_quality:82,
    data_status:{data_valid:true,candle_data_valid:true,volume_gate_pass:true,data_stale:false,stale:false,future_data_detected:false},
    pre_move_context:{
      ...base.pre_move_context,score:63.9,session_return_pct:-1.0537,one_hour_return_pct:3.6255,
      volume_acceleration:2.4838,trade_acceleration:2.3913,taker_buy_ratio:0.5231,
      taker_buy_acceleration:0.1009,mean_close_location:0.7936,
      relative_strength_vs_market_pct:-1.4456,relative_strength_vs_btc_pct:-1.4456,
      session_close:now-60_000,
      components:{squeeze:60,structure:80.2,buying_pressure:73.2}
    }
  };
  const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
  assert.ok(alert,'qualified participation surge should not be hidden by the old 2.5% 1h ceiling');
  assert.equal(alert.watch_notification_tier,'PARTICIPATION_SURGE_MONITOR');
  assert.equal(alert.watch_only,true);
  assert.equal(alert.entry_eligible,false);
  assert.equal(alert.real_order_execution,false);

  const dir=await mkdtemp(join(tmpdir(),'radarx-nil-participation-watch-'));
  const store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    const sent=[];
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){
      sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};
    }};
    const manager=new PushManager({provider,store,deduplicator:new SignalDeduplicator({store,windowMs:15*60*1000})});
    const result=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(result.status,'SENT',JSON.stringify(result));
    assert.equal(result.sent_count,1);
    assert.equal(sent[0].watch_notification_tier,'PARTICIPATION_SURGE_MONITOR');
    assert.equal(sent[0].watch_only,true);
    assert.equal(sent[0].entry_eligible,false);
    assert.equal(sent[0].real_order_execution,false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('PUNDIX/SOLV-like strong buyer absorption can notify below the normal volume floor as WATCH ONLY',async()=>{
  const {candidate:base,snapshot,now}=fixture();
  const cases=[
    {
      symbol:'PUNDIXUSDT',daily:-1.0913,quote:509_262,session:3.6383,hour:2.8986,
      score:76.4,volume:0.7415,trades:1.0442,taker:0.7955,delta:0.3023,
      close:0.8431,relative:2.3077,structure:74.0,buying:100
    },
    {
      symbol:'SOLVUSDT',daily:-4.4919,quote:548_093,session:-2.5104,hour:1.9093,
      score:60.4,volume:0.7399,trades:0.9340,taker:0.6160,delta:0.2379,
      close:0.5811,relative:-3.2672,structure:76.8,buying:100
    }
  ];
  for(const row of cases){
    const candidate={
      ...base,symbol:row.symbol,price_change_24h:row.daily,quote_volume_24h:row.quote,
      data_quality:94,liquidity_quality:72,
      data_status:{data_valid:false,candle_data_valid:true,volume_gate_pass:false,data_stale:false,stale:false,future_data_detected:false},
      pre_move_context:{
        ...base.pre_move_context,score:row.score,session_return_pct:row.session,
        one_hour_return_pct:row.hour,volume_acceleration:row.volume,trade_acceleration:row.trades,
        taker_buy_ratio:row.taker,taker_buy_acceleration:row.delta,mean_close_location:row.close,
        relative_strength_vs_market_pct:row.relative,relative_strength_vs_btc_pct:row.relative,
        session_close:now-60_000,
        components:{squeeze:50,structure:row.structure,buying_pressure:row.buying}
      }
    };
    const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
    assert.ok(alert, row.symbol+' should survive the strict low-volume watch-only corridor');
    assert.equal(alert.watch_notification_tier,'STRONG_BUYER_ABSORPTION_MONITOR');
    assert.equal(alert.low_volume_watch_only,true);
    assert.equal(alert.data_status.data_valid,false);
    assert.equal(alert.entry_eligible,false);
    assert.equal(alert.paper_trading,true);
    assert.equal(alert.real_order_execution,false);

    const dir=await mkdtemp(join(tmpdir(),'radarx-strong-buyer-watch-'));
    const store=await new DurableStore({dir}).init();
    try{
      await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
      await store.upsertSubscription('u1',pushSubscription());
      const sent=[];
      const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){
        sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};
      }};
      const manager=new PushManager({provider,store,deduplicator:new SignalDeduplicator({store,windowMs:15*60*1000})});
      const result=await manager.notifyRadarWatchOnlyAlert(alert);
      assert.equal(result.status,'SENT',row.symbol+': '+JSON.stringify(result));
      assert.equal(result.sent_count,1);
      assert.equal(sent[0].watch_notification_tier,'STRONG_BUYER_ABSORPTION_MONITOR');
      assert.equal(sent[0].watch_only,true);
      assert.equal(sent[0].entry_eligible,false);
      assert.equal(sent[0].low_volume_watch_only,true);
      assert.equal(sent[0].real_order_execution,false);
    }finally{await rm(dir,{recursive:true,force:true});}
  }
});

test('low-volume monitor cannot bypass stale candles, weak buyer flow, or poor liquidity',()=>{
  const {candidate:base,snapshot,now}=fixture();
  const candidate={
    ...base,symbol:'LOWFLOWUSDT',price_change_24h:1.2,quote_volume_24h:510_000,
    data_quality:90,liquidity_quality:72,
    data_status:{data_valid:false,candle_data_valid:true,volume_gate_pass:false,data_stale:false,stale:false,future_data_detected:false},
    pre_move_context:{
      ...base.pre_move_context,score:76,session_return_pct:2,one_hour_return_pct:2.4,
      volume_acceleration:0.75,trade_acceleration:1.0,taker_buy_ratio:0.52,
      taker_buy_acceleration:0.02,mean_close_location:0.60,
      relative_strength_vs_market_pct:1,relative_strength_vs_btc_pct:1,
      session_close:now-60_000,
      components:{squeeze:50,structure:70,buying_pressure:75}
    }
  };
  assert.equal(buildPreMoveWatchOnlyAlert(candidate,snapshot,now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...candidate,liquidity_quality:59},snapshot,now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...candidate,data_status:{...candidate.data_status,data_stale:true}},snapshot,now),null);
});


test('market scanner retains PUNDIX and SOLV-like strong-buyer low-volume near misses for the bounded watch lane',()=>{
  const now=Date.now();
  const rows=[
    {
      symbol:'PUNDIXUSDT',last_price:0.0997,price_change_24h:-1.0913,
      quote_volume_24h:509262,data_quality:94,liquidity_quality:72,
      data_status:{data_valid:false,candle_data_valid:true,volume_gate_pass:false,data_stale:false,stale:false,future_data_detected:false},
      risk_flags:[],
      pre_move_context:{
        stage:'NO_SETUP',evidence_complete:true,closed_candles_only:true,already_moved:false,
        session_close:now-60_000,score:76.4,session_return_pct:3.6383,one_hour_return_pct:2.8986,
        volume_acceleration:0.7415,trade_acceleration:1.0442,taker_buy_ratio:0.7955,
        taker_buy_acceleration:0.3023,mean_close_location:0.8431,
        relative_strength_vs_market_pct:2.3077,relative_strength_vs_btc_pct:2.3077,
        components:{squeeze:50,structure:74,buying_pressure:100}
      }
    },
    {
      symbol:'SOLVUSDT',last_price:0.004699,price_change_24h:-4.4919,
      quote_volume_24h:548093,data_quality:94,liquidity_quality:72,
      data_status:{data_valid:false,candle_data_valid:true,volume_gate_pass:false,data_stale:false,stale:false,future_data_detected:false},
      risk_flags:[],
      pre_move_context:{
        stage:'NO_SETUP',evidence_complete:true,closed_candles_only:true,already_moved:false,
        session_close:now-60_000,score:60.4,session_return_pct:-2.5104,one_hour_return_pct:1.9093,
        volume_acceleration:0.7399,trade_acceleration:0.9340,taker_buy_ratio:0.6160,
        taker_buy_acceleration:0.2379,mean_close_location:0.5811,
        relative_strength_vs_market_pct:-3.2672,relative_strength_vs_btc_pct:-3.2672,
        components:{squeeze:50,structure:76.8,buying_pressure:100}
      }
    }
  ];
  const candidates=buildPreMoveWatchCandidates(rows,{
    minQuoteVolume24h:750000,minLiquidityQuality:60,minDataQuality:70
  });
  assert.deepEqual(candidates.map(x=>x.symbol).sort(),['PUNDIXUSDT','SOLVUSDT']);
  assert.ok(candidates.every(x=>x.watch_only===true&&x.alert_eligible===false));
  assert.ok(candidates.every(x=>x.pre_move_context.strong_buyer_absorption_monitor_only===true));
  assert.ok(candidates.every(x=>x.data_status.data_valid===false));
});
