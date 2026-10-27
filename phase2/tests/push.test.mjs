import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {PushManager,defaultSettings} from '../push/index.mjs';
import {pushSubscription} from './fixtures.mjs';

class ToggleProvider{
  constructor(){this.fail=true;this.calls=0;}
  status(){return{provider:'TEST_FIXTURE',enabled:true};}
  async send(){this.calls++;return this.fail?{ok:false,status:'FAILED',reason:'TEST_FIXTURE_PUSH_FAILURE'}:{ok:true,status:'SENT',httpStatus:201};}
}
function signal(){return{signal_id:'TEST_FIXTURE_SIGNAL',symbol:'BTCUSDT',market:'SPOT',strategy:'CONFIRMED_BREAKOUT',direction:'LONG',
  signal_type:'CONFIRMED',candle:{timeframe:'15m',close_time:1700000000000},price:{reference:100},scores:{data_quality:95,liquidity_quality:90},
  reason_codes:['CLOSE_ABOVE_RANGE'],confidence_score:'UNKNOWN'};}

test('TEST_FIXTURE: failed push is queued and succeeds after provider recovery',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-push-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{enabled:true,symbols:['BTCUSDT'],timeframes:['15m'],minDataQuality:70,minLiquidityQuality:60,signalTypes:['CONFIRMED']});
  await store.upsertSubscription('u1',pushSubscription());
  assert.equal((await store.getUserSettings('u1')).enabled,true);assert.equal((await store.getSubscriptions('u1')).length,1);
  const p=new ToggleProvider(),m=new PushManager({provider:p,store,retryBaseMs:1});
  const first=await m.notifySignal(signal());assert.equal(first[0].status,'FAILED');
  p.fail=false;await m.flushRetries(Date.now()+100);
  const events=await store.readRecent('notifications',10);
  assert.ok(events.some(x=>x.status==='SENT'));assert.ok(p.calls>=2);
});

test('TEST_FIXTURE: low data quality prevents push attempt',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-lowdq-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',defaultSettings());await store.upsertSubscription('u1',pushSubscription());
  assert.equal((await store.getSubscriptions()).length,1);
  const p=new ToggleProvider(),m=new PushManager({provider:p,store});
  const s={...signal(),scores:{data_quality:50,liquidity_quality:95}};
  const out=await m.notifySignal(s);
  assert.equal(out.length,0);assert.equal(p.calls,0);
});


test('TEST_FIXTURE: qualified early-track gates remain feed-only until final confirmation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-early-watch-push-')),store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true});
    await store.upsertSubscription('u1',pushSubscription());
    const sent=[];
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){sent.push(payload);return{ok:true,status:'SENT'};}};
    const manager=new PushManager({provider,store});
    const now=Date.now();
    const out=await manager.notifyRadarAlert({
      radar:'STRONG_MOVE_RADAR',radar_name:'Radar 2 — Strong-Move',symbol:'EARLYUSDT',market:'SPOT',direction:'UP',
      price:1.23,price_change_24h:2.1,data_quality:88,liquidity_quality:78,source:'BINANCE_PUBLIC_REST',
      closed_candles_only:true,detected_candle_close_time:now-1000,risk_flags:[],
      notification_gate:{eligible:true,watch_only:true,requires_follow_up_confirmation:true,mode:'RADAR_WATCH_ONLY_EARLY_TRACK',
        score:76,data_quality:88,liquidity_quality:78,failures:['SCORE_BELOW_STRICT_THRESHOLD']},
      signal_lifecycle:{state:'EARLY_SETUP',label:'إعداد مبكر',transition:'EARLY_EVIDENCE_CONVERGED',reason_codes:['RELATED_EARLY_EVIDENCE']}
    });
    assert.equal(out.length,1);
    assert.equal(out[0].status,'WATCH_ONLY_FEED_ONLY');
    assert.equal(sent.length,0);
    const rejected=await manager.notifyRadarAlert({radar:'FALCON_EYE_RADAR',symbol:'NOENTRYUSDT',data_quality:95,eligible:true,entry_eligible:false});
    assert.deepEqual(rejected,[]);
    assert.equal(sent.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});test('TEST_FIXTURE: Radar 8 early-flow watch stays feed-only even with valid evidence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-verified-watch-push-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70});
  await store.upsertSubscription('u1',pushSubscription());
  const sent=[];
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};}};
  const manager=new PushManager({provider,store});
  const now=Date.now();
  const alert={
    id:'RADAR8_EARLY_FLOW_WATCH:TESTUSDT:'+String(now-1000),
    event:'EARLY_FLOW_WATCH_ONLY',radar:'EARLY_EXPANSION_RADAR',radar_name:'Radar 8 — البرق',
    symbol:'TESTUSDT',market:'SPOT',direction:'UP_BIAS',price:1.01,price_change_24h:1.2,
    source:'Binance Public REST',watch_only:true,entry_eligible:false,data_stale:false,
    closed_candles_only:true,data_quality:88,liquidity_quality:82,detected_candle_close_time:now-1000,
    early_flow_watch_evidence:{
      closed_candles_only:true,closed_candle_close_time:now-1000,
      micro_score:68,confirmation_count:4,rvol_1m:1.6,rvol_5m:1.3,
      trade_rvol_1m:1.4,trade_rvol_5m:1.2,taker_buy_ratio:.55,
      acceleration_1m_pct:.03,acceleration_5m_pct:.04,return_1m:.02,return_5m:.05
    },
    risk_flags:['LOW_LIQUIDITY_WATCH_ONLY'],reason_codes:['MICRO_EARLY_FLOW']
  };
  const out=await manager.notifyRadarWatchOnlyAlert(alert);
  assert.equal(out.status,'REJECTED_WATCH_ONLY');
  assert.equal(out.reason,'LOW_LIQUIDITY_WATCH_ONLY');
  assert.equal(out.attempted,false);
  assert.equal(out.sent_count,0);
  assert.equal(sent.length,0,'low-liquidity watch-only candidates must not trigger a push');
  const audits=await store.readRecent('notifications',10);
  assert.equal(audits.filter(x=>x.event==='RADAR_WATCH_ONLY_NOTIFICATION').length,0);
});

test('TEST_FIXTURE: Radar 8 watch push fails closed on stale or incomplete evidence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-invalid-watch-push-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true});
  await store.upsertSubscription('u1',pushSubscription());
  let calls=0;
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(){calls++;return{ok:true,status:'SENT'};}};
  const manager=new PushManager({provider,store});
  const out=await manager.notifyRadarWatchOnlyAlert({
    event:'EARLY_FLOW_WATCH_ONLY',radar:'EARLY_EXPANSION_RADAR',symbol:'STALEUSDT',
    watch_only:true,entry_eligible:false,price:1,price_change_24h:1,source:'Binance Public REST',
    early_flow_watch_evidence:{closed_candles_only:true,closed_candle_close_time:Date.now()-300_000,
      micro_score:90,confirmation_count:6,rvol_1m:2.5,trade_rvol_1m:2.0,acceleration_1m_pct:.3}
  });
  assert.equal(out.status,'REJECTED_WATCH_ONLY');
  assert.ok(['CLOSED_CANDLE_EVIDENCE_REQUIRED','STALE_OR_INVALID_DATA','DATA_QUALITY_MISSING_OR_LOW','LIQUIDITY_QUALITY_MISSING_OR_LOW','CLOSED_CANDLE_EVIDENCE_TOO_OLD'].includes(out.reason));
  assert.equal(calls,0);
});


test('TEST_FIXTURE: validated early-flow watch sends once with non-entry metadata',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-earlyflow-watch-send-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
  await store.upsertSubscription('u1',pushSubscription());
  const sent=[];
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};}};
  const manager=new PushManager({provider,store});
  const now=Date.now();
  const out=await manager.notifyRadarWatchOnlyAlert({
  assert.equal(out.status,'WATCH_ONLY_FEED_ONLY',JSON.stringify(out));
  assert.equal(out.attempted,false);
  assert.equal(out.sent_count,0);
  assert.equal(out.attempted_count,0);
  assert.equal(sent.length,0,'early watch observations must stay in-app until final confirmation');
  const audits=await store.readRecent('notifications',10);
  assert.equal(audits.filter(x=>x.event==='RADAR_WATCH_ONLY_NOTIFICATION'&&x.status==='WATCH_ONLY_FEED_ONLY').length,1);

    await rm(dir,{recursive:true,force:true});

});test('TEST_FIXTURE: validated Micro early-flow may send a monitor-only alert without fabricated depth scores',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-micro-watch-no-depth-score-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
  await store.upsertSubscription('u1',pushSubscription());
  const sent=[];
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};}};
  const manager=new PushManager({provider,store});
  const now=Date.now();
  const out=await manager.notifyRadarWatchOnlyAlert({
  assert.equal(out.status,'WATCH_ONLY_FEED_ONLY',JSON.stringify(out));
  assert.equal(out.attempted,false);
  assert.equal(out.sent_count,0);
  assert.equal(out.attempted_count,0);
  assert.equal(sent.length,0,'early watch observations must stay in-app until final confirmation');
  const audits=await store.readRecent('notifications',10);
  assert.equal(audits.filter(x=>x.event==='RADAR_WATCH_ONLY_NOTIFICATION'&&x.status==='WATCH_ONLY_FEED_ONLY').length,1);

    await rm(dir,{recursive:true,force:true});

});test('TEST_FIXTURE: missing radar data quality fails closed instead of inheriting 100',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-radar-missing-dq-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70});
  await store.upsertSubscription('u1',pushSubscription());
  let calls=0;
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(){calls++;return{ok:true,status:'SENT'};}};
  const m=new PushManager({provider,store});
  const out=await m.notifyRadarAlert({radar:'ROTATION_LAG_RADAR',symbol:'MISSINGDQUSDT',direction:'UP_ROTATION',eligible:true});
  assert.equal(out.length,0);
  assert.equal(calls,0);
});

test('TEST_FIXTURE: radar alerts without an explicit final gate never push',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-radar-nested-dq-')),store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70});
    await store.upsertSubscription('u1',pushSubscription());
    let calls=0;
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(){calls++;return{ok:true,status:'SENT'};}};
    const m=new PushManager({provider,store});
    const out=await m.notifyRadarAlert({radar:'ALMUQAWIM_RADAR',symbol:'RESILIENTUSDT',direction:'UP',eligible:true,almuqawim:{data_quality:88}});
    assert.deepEqual(out,[]);
    assert.equal(calls,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});test('TEST_FIXTURE: only a final non-watch gate can push a confirmed radar alert',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-lifecycle-push-')),store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    const sent=[];
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){sent.push(payload);return{ok:true,status:'SENT'};}};
    const m=new PushManager({provider,store});
    await m.notifyRadarAlert({
      radar:'EARLY_EXPANSION_RADAR',radar_name:'Radar 8',symbol:'CONFIRMEDUSDT',eligible:true,entry_eligible:true,
      data_quality:95,liquidity_quality:85,
      notification_gate:{eligible:true,watch_only:false,requires_follow_up_confirmation:false,score:90,confirmations:7},
      signal_lifecycle:{state:'CONFIRMED',label:'تأكيد نهائي',transition:'CONFIRMED_BREAKOUT',reason_codes:['CLOSED_CANDLE_BREAKOUT']}
    });
    assert.equal(sent.length,1);
    assert.equal(sent[0].symbol,'CONFIRMEDUSDT');
    assert.equal(sent[0].watch_only,false);
    assert.equal(sent[0].signal_lifecycle_state,'CONFIRMED');
    assert.equal(sent[0].signal_lifecycle_label,'تأكيد نهائي');
    assert.equal(sent[0].signal_lifecycle_transition,'CONFIRMED_BREAKOUT');
    assert.deepEqual(sent[0].signal_lifecycle_reason_codes,['CLOSED_CANDLE_BREAKOUT']);
  }finally{await rm(dir,{recursive:true,force:true});}
});test('TEST_FIXTURE: validated quiet-base watch sends a labelled non-entry notification',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-quiet-base-watch-push-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70});
  await store.upsertSubscription('u1',pushSubscription());
  const sent=[];
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};}};
  const manager=new PushManager({provider,store});
  const now=Date.now();
  const fingerprint={
    classification:'WATCH_EARLY',reason:'QUIET_BASE_NEAR_MISS_BUY_FLOW_TRANSITION',
    detected:true,watch_only:true,entry_eligible:false,candle_close_time_ms:now-1000,
    metrics:{
      daily_change_24h_pct:2.1,move_5m_pct:0.3,move_15m_pct:0.7,
      buy_pressure_transition:{available:true,watch_only_qualified:true,near_miss_signal_count:5}
    },
    evidence:[
      {key:'anti_chase',passed:true},
      {key:'higher_lows_or_stable_support',passed:true},
      {key:'narrow_price_base_range_pct',passed:true}
    ]
  };
  const alert={
    id:'RADAR8_QUIET_BASE_WATCH:QUIETUSDT:'+String(now-1000),
    event:'QUIET_BASE_PRE_EXPANSION_WATCH_ONLY',radar:'EARLY_EXPANSION_RADAR',
    radar_name:'Radar 8 — البرق',symbol:'QUIETUSDT',market:'SPOT',direction:'UP_BIAS',
    price:1.05,price_change_24h:2.1,data_quality:92,liquidity_quality:81,
    source:'Binance Public REST',data_stale:false,closed_candles_only:true,
    detected_candle_close_time:now-1000,watch_only:true,entry_eligible:false,
    quiet_base_pre_expansion:fingerprint,risk_flags:['QUIET_BASE_WATCH_ONLY'],
    reason_codes:['QUIET_BASE_NEAR_MISS_BUY_FLOW_TRANSITION']
  };
  alert.paper_trading=true;alert.real_order_execution=false;
  const out=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(out.status,'WATCH_ONLY_FEED_ONLY',JSON.stringify(out));
    assert.equal(out.attempted,false);
    assert.equal(out.sent_count,0);
    assert.equal(sent.length,0,'monitor-only alerts cannot reach the phone before confirmation');

    await rm(dir,{recursive:true,force:true});

});test('TEST_FIXTURE: quiet-base near-miss push fails closed for incomplete flow or missing anti-chase evidence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-invalid-quiet-base-watch-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true});
  await store.upsertSubscription('u1',pushSubscription());
  let calls=0;
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(){calls++;return{ok:true,status:'SENT'};}};
  const manager=new PushManager({provider,store});
  const now=Date.now();
  const fingerprint={
    classification:'WATCH_EARLY',reason:'QUIET_BASE_NEAR_MISS_BUY_FLOW_TRANSITION',
    detected:true,watch_only:true,entry_eligible:false,candle_close_time_ms:now-1000,
    metrics:{
      daily_change_24h_pct:2,move_5m_pct:0.2,move_15m_pct:0.4,
      buy_pressure_transition:{available:true,watch_only_qualified:true,near_miss_signal_count:2}
    },
    evidence:[
      {key:'anti_chase',passed:false},
      {key:'higher_lows_or_stable_support',passed:true},
      {key:'narrow_price_base_range_pct',passed:true}
    ]
  };
  const out=await manager.notifyRadarWatchOnlyAlert({
    event:'QUIET_BASE_PRE_EXPANSION_WATCH_ONLY',radar:'EARLY_EXPANSION_RADAR',
    symbol:'INCOMPLETEUSDT',price:1.02,price_change_24h:2,data_quality:90,
    liquidity_quality:80,source:'Binance Public REST',data_stale:false,
    closed_candles_only:true,detected_candle_close_time:now-1000,
    watch_only:true,entry_eligible:false,quiet_base_pre_expansion:fingerprint,risk_flags:[]
  });
  assert.equal(out.status,'REJECTED_WATCH_ONLY');
  assert.equal(out.reason,'QUIET_BASE_EVIDENCE_INCOMPLETE');
  assert.equal(calls,0);
});


test('TEST_FIXTURE: evidence-gated Strong Move near miss sends only a WATCH_ONLY notification',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-strong-move-watch-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70});
  await store.upsertSubscription('u1',pushSubscription());
  const sent=[];
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};}};
  const manager=new PushManager({provider,store});
  const now=Date.now(),closeAt=now-15_000;
  const alert={
    id:'STRONG_MOVE_WATCH_ONLY:NEARUSDT:'+String(closeAt),
    event:'STRONG_MOVE_WATCH_ONLY',radar:'STRONG_MOVE_RADAR',radar_name:'Radar 2 — Strong-Move',
    symbol:'NEARUSDT',market:'SPOT',direction:'UP_SURGE',price:1.25,price_change_24h:3.2,
    data_quality:90,liquidity_quality:86,quote_volume_24h:3_500_000,
    source:'Binance Public REST',data_stale:false,data_status:{
      status:'LIVE_DATA',stale:false,data_stale:false,data_valid:true,future_data_detected:false,
      data_quality:90,source:'Binance Public REST',close_time:closeAt,candle_closed:true
    },
    detected_at:now,processed_at:now,detected_candle_close_time:closeAt,closed_candles_only:true,
    watch_only:true,entry_eligible:false,eligible:false,paper_trading:true,real_order_execution:false,
    confidence_score:'UNKNOWN',risk_flags:[],watch_reason_codes:['ELITE_GATE_NOT_ELIGIBLE'],
    strong_move:{eligible:false,watch_only:true,entry_eligible:false,closed_candles_only:true,
      score:71.4,data_quality:90,data_stale:false,metrics:{
        closed_5m_candle_close_time_ms:closeAt,return_1m:0.14,return_3m:0.28,
        volume_ratio:1.28,trade_ratio:1.17,taker_buy_ratio:0.555,taker_buy_delta:0.018,
        close_location_pct:61,breakout_up:false,micro_breakout:true
      }}
  };
  const out=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(out.status,'WATCH_ONLY_FEED_ONLY',JSON.stringify(out));
    assert.equal(out.attempted,false);
    assert.equal(out.sent_count,0);
    assert.equal(sent.length,0,'monitor-only alerts cannot reach the phone before confirmation');

    await rm(dir,{recursive:true,force:true});

});test('TEST_FIXTURE: Strong Move watch-only validator rejects missing buyer-flow evidence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-strong-move-watch-invalid-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true});
  await store.upsertSubscription('u1',pushSubscription());
  let calls=0;
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(){calls++;return{ok:true,status:'SENT'};}};
  const manager=new PushManager({provider,store});
  const now=Date.now(),closeAt=now-15_000;
  const alert={
    event:'STRONG_MOVE_WATCH_ONLY',radar:'STRONG_MOVE_RADAR',symbol:'NEARUSDT',price:1,
    price_change_24h:3,data_quality:90,liquidity_quality:85,source:'Binance Public REST',
    data_status:{status:'LIVE_DATA',stale:false,data_stale:false,data_valid:true,future_data_detected:false,
      source:'Binance Public REST',close_time:closeAt,candle_closed:true},
    detected_candle_close_time:closeAt,closed_candles_only:true,watch_only:true,entry_eligible:false,
    eligible:false,paper_trading:true,real_order_execution:false,risk_flags:[],
    strong_move:{eligible:false,watch_only:true,closed_candles_only:true,score:71,metrics:{
      closed_5m_candle_close_time_ms:closeAt,return_1m:0.14,return_3m:0.28,
      volume_ratio:1.28,trade_ratio:1.17,taker_buy_ratio:0.49,taker_buy_delta:0.002,
      close_location_pct:61,breakout_up:false,micro_breakout:true
    }}
  };
  const out=await manager.notifyRadarWatchOnlyAlert(alert);
  assert.equal(out.status,'REJECTED_WATCH_ONLY');
  assert.equal(out.reason,'STRONG_MOVE_WATCH_CONFLUENCE_INSUFFICIENT');
  assert.equal(calls,0);
});


test('TEST_FIXTURE: high-activity Pre-Move alerts pass the push validator with structure pending, but weak evidence fails closed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-pre-move-high-activity-push-'));
  const store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    const sent=[];
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){
      sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};
    }};
    const manager=new PushManager({provider,store});
    const now=Date.now(),closeAt=now-129_000;
    const alert={
      id:'PRE_MOVE_WATCH:MEGAUSDT:'+String(closeAt),
      event:'PRE_MOVE_RADAR_WATCH_ONLY',potential_label:'WATCH_EARLY',decision_band:'WATCH_EARLY',
      radar:'PRE_MOVE',radar_name:'رادار ما قبل الحركة',
      symbol:'MEGAUSDT',market:'SPOT',direction:'UP_BIAS',price:0.1977,price_change_24h:3.702,
      data_quality:100,liquidity_quality:92.36,source:'Binance Public REST',data_stale:false,
      data_status:{data_valid:true,data_stale:false,stale:false,future_data_detected:false,
        source:'Binance Public REST',close_time:closeAt},
      detected_at:now,detected_candle_close_time:closeAt,closed_candles_only:true,
      watch_only:true,entry_eligible:false,watch_notification_tier:'HIGH_ACTIVITY_STRUCTURE_PENDING',
      watch_review_reason:'STRONG_VOLUME_AND_TRADE_ACCELERATION_WITH_PRICE_STRUCTURE_PENDING',
      paper_trading:true,real_order_execution:false,risk_flags:[],
      pre_move_context:{
        stage:'WATCH_EARLY',watch_only:true,actionable:false,evidence_complete:true,
        closed_candles_only:true,already_moved:false,score:75.6,
        session_return_pct:2.6675,one_hour_return_pct:1.9399,
        volume_acceleration:23.4119,trade_acceleration:15.3842,
        taker_buy_ratio:0.71,taker_buy_acceleration:0.08,
        mean_close_location:0.3545,relative_strength_vs_market_pct:4.1490,
        components:{structure:54.0185,squeeze:0,buying_pressure:70.8968}
      }
    };
    const out=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(out.status,'WATCH_ONLY_FEED_ONLY',JSON.stringify(out));
    assert.equal(out.attempted,false);
    assert.equal(out.sent_count,0);
    assert.equal(sent.length,0,'monitor-only alerts cannot reach the phone before confirmation');
  }finally{
    await rm(dir,{recursive:true,force:true});
  }

});test('TEST_FIXTURE: high buyer flow before positive return can send only a monitor notification',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-neutral-flow-watch-'));
  const store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    const sent=[];
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){
      sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};
    }};
    const manager=new PushManager({provider,store});
    const now=Date.now(),closeAt=now-800_000;
    const alert={
      id:'PRE_MOVE_WATCH:ASTRUSDT:'+String(closeAt),
      event:'PRE_MOVE_RADAR_WATCH_ONLY',potential_label:'WATCH_EARLY',decision_band:'WATCH_EARLY',
      radar:'PRE_MOVE',radar_name:'رادار ما قبل الحركة',
      symbol:'ASTRUSDT',market:'SPOT',direction:'UP_BIAS',price:0.035,price_change_24h:1.1,
      data_quality:100,liquidity_quality:84.94,source:'Binance Public REST',data_stale:false,
      data_status:{data_valid:true,data_stale:false,stale:false,future_data_detected:false,
        source:'Binance Public REST',close_time:closeAt},
      detected_at:now,detected_candle_close_time:closeAt,closed_candles_only:true,
      watch_only:true,entry_eligible:false,watch_notification_tier:'HIGH_ACTIVITY_STRUCTURE_PENDING',
      watch_review_reason:'STRONG_BUYER_FLOW_BEFORE_PRICE_TURN',
      paper_trading:true,real_order_execution:false,risk_flags:[],
      pre_move_context:{
        stage:'WATCH_EARLY',watch_only:true,actionable:false,evidence_complete:true,
        closed_candles_only:true,already_moved:false,score:77.7,
        session_return_pct:-0.176366843,one_hour_return_pct:-0.0160771704,
        volume_acceleration:4.2677557,trade_acceleration:2.4360902,
        taker_buy_ratio:0.7292044,taker_buy_acceleration:0.3771112,
        mean_close_location:0.5048246,relative_strength_vs_market_pct:0.8874629,
        components:{structure:60.4391,squeeze:55,buying_pressure:80}
      }
    };
    const out=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(out.status,'WATCH_ONLY_FEED_ONLY',JSON.stringify(out));
    assert.equal(out.attempted,false);
    assert.equal(out.sent_count,0);
    assert.equal(sent.length,0,'monitor-only alerts cannot reach the phone before confirmation');
  }finally{
    await rm(dir,{recursive:true,force:true});
  }

});test('TEST_FIXTURE: persistent push guard allows at most one confirmed market push per minute per device',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-push-rate-'));
  try{
    const store=await new DurableStore({dir}).init();
    const symbols=['BTCUSDT','ETHUSDT'];
    await store.putUserSettings('u1',{enabled:true,symbols,timeframes:['15m'],minDataQuality:70,minLiquidityQuality:60,signalTypes:['CONFIRMED']});
    await store.upsertSubscription('u1',pushSubscription());
    const provider={calls:0,status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(){this.calls++;return{ok:true,status:'SENT',httpStatus:201};}};
    const firstManager=new PushManager({provider,store});
    const first=await firstManager.notifySignal({...signal(),symbol:symbols[0],signal_id:'RATE_LIMIT_TEST:'+symbols[0]});
    assert.equal(first[0]?.status,'SENT');
    const restartedManager=new PushManager({provider,store});
    const limited=await restartedManager.notifySignal({...signal(),symbol:symbols[1],signal_id:'RATE_LIMIT_TEST:'+symbols[1]});
    assert.equal(limited[0]?.status,'RATE_LIMITED');
    assert.equal(provider.calls,1,'the second confirmed alert must not create a burst on the same device');
    const audits=await store.readRecent('notifications',20);
    assert.equal(audits.filter(row=>row.event==='NOTIFICATION_ATTEMPT'&&row.status==='RATE_LIMITED').length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});test('TEST_FIXTURE: same-symbol cross-radar market alerts are suppressed persistently after one delivery',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-push-symbol-dedupe-'));
  try{
    const store=await new DurableStore({dir}).init();
    await store.putUserSettings('u1',{enabled:true,symbols:['BTCUSDT'],timeframes:['15m'],minDataQuality:70,minLiquidityQuality:60,signalTypes:['CONFIRMED']});
    await store.upsertSubscription('u1',pushSubscription());
    const provider={calls:0,status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(){this.calls++;return{ok:true,status:'SENT',httpStatus:201};}};
    const managerOne=new PushManager({provider,store});
    const first=await managerOne.notifySignal({...signal(),signal_id:'CROSS_RADAR_FIRST'});
    assert.equal(first[0]?.status,'SENT');
    const managerAfterRestart=new PushManager({provider,store});
    const duplicate=await managerAfterRestart.notifySignal({...signal(),signal_id:'CROSS_RADAR_DUPLICATE'});
    assert.equal(duplicate[0]?.status,'DUPLICATE_SUPPRESSED');
    assert.equal(provider.calls,1,'the same symbol must not retrigger a second push just because the manager restarted');
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});
