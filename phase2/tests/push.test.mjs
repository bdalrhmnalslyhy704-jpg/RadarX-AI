import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
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


test('TEST_FIXTURE: qualified early-track gates send a labelled watch-only push, while unqualified alerts stay blocked',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-early-watch-push-')),store=await new DurableStore({dir}).init();
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
      score:76,data_quality:88,liquidity_quality:78,failures:['SCORE_BELOW_STRICT_THRESHOLD'],
      falcon_eye:{quality:70,capture:76,independent_domains:3,early_window:true}},
    signal_lifecycle:{state:'EARLY_SETUP',label:'إعداد مبكر',transition:'EARLY_EVIDENCE_CONVERGED',reason_codes:['RELATED_EARLY_EVIDENCE']}
  });
  assert.equal(out.length,1);
  assert.equal(sent.length,1);
  assert.equal(sent[0].symbol,'EARLYUSDT');
  assert.equal(sent[0].watch_only,true);
  assert.equal(sent[0].entry_eligible,false);
  assert.equal(sent[0].notification_mode,'WATCH_ONLY_EARLY_TRACK');
  assert.equal(sent[0].paper_trading,true);
  assert.equal(sent[0].real_order_execution,false);
  const rejected=await manager.notifyRadarAlert({
    radar:'FALCON_EYE_RADAR',symbol:'NOENTRYUSDT',data_quality:95,
    eligible:true,entry_eligible:false
  });
  assert.deepEqual(rejected,[]);
  assert.equal(sent.length,1,'entry-ineligible alerts without an approved watch gate must remain blocked');
});

test('TEST_FIXTURE: Radar 8 early-flow watch stays feed-only even with valid evidence',async()=>{
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
    event:'EARLY_FLOW_WATCH_ONLY',potential_label:'EARLY_FLOW_WATCH_ONLY',decision_band:'WATCH_EARLY',
    radar:'EARLY_EXPANSION_RADAR',symbol:'EARLYFLOWUSDT',market:'SPOT',direction:'UP_BIAS',
    price:1.02,price_change_24h:1.2,data_quality:88,liquidity_quality:82,data_stale:false,
    source:'BINANCE_PUBLIC_REST',detected_at:now,detected_candle_close_time:now-1000,
    closed_candles_only:true,watch_only:true,entry_eligible:false,paper_trading:true,real_order_execution:false,
    early_flow_watch_evidence:{closed_candles_only:true,closed_candle_close_time:now-1000,
      micro_score:70,confirmation_count:5,rvol_1m:1.5,rvol_5m:1.3,
      trade_rvol_1m:1.4,trade_rvol_5m:1.2,taker_buy_ratio:.56,acceleration_1m_pct:.08}
  });
  assert.equal(out.status,'SENT',JSON.stringify(out));
  assert.equal(out.sent_count,1);
  assert.equal(sent.length,1);
  assert.equal(sent[0].symbol,'EARLYFLOWUSDT');
  assert.equal(sent[0].watch_only,true);
  assert.equal(sent[0].entry_eligible,false);
  assert.equal(sent[0].paper_trading,true);
  assert.equal(sent[0].real_order_execution,false);
  const audits=await store.readRecent('notifications',10);
  assert.equal(audits.filter(x=>x.event==='RADAR_WATCH_ONLY_NOTIFICATION').length,1);
});

test('TEST_FIXTURE: validated Micro early-flow may send a monitor-only alert without fabricated depth scores',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-micro-watch-no-depth-score-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
  await store.upsertSubscription('u1',pushSubscription());
  const sent=[];
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};}};
  const manager=new PushManager({provider,store});
  const now=Date.now();
  const out=await manager.notifyRadarWatchOnlyAlert({
    event:'EARLY_FLOW_WATCH_ONLY',potential_label:'EARLY_FLOW_WATCH_ONLY',decision_band:'WATCH_EARLY',
    radar:'EARLY_EXPANSION_RADAR',symbol:'MICROWATCHUSDT',market:'SPOT',direction:'UP_BIAS',
    price:1.02,price_change_24h:2.1,data_quality:null,liquidity_quality:null,data_stale:false,
    source:'BINANCE_PUBLIC_REST',quote_volume_24h:900000,micro_data_validated:true,
    liquidity_evidence_status:'ORDER_BOOK_NOT_CHECKED_AT_MICRO_STAGE',
    detected_at:now,detected_candle_close_time:now-1000,closed_candles_only:true,
    watch_only:true,entry_eligible:false,paper_trading:true,real_order_execution:false,
    early_flow_watch_evidence:{
      closed_candles_only:true,closed_candle_close_time:now-1000,
      micro_score:60,confirmation_count:3,rvol_1m:1.25,rvol_5m:1.05,
      trade_rvol_1m:1.05,trade_rvol_5m:1.16,taker_buy_ratio:.55,
      acceleration_1m_pct:.03,acceleration_5m_pct:.01,return_1m:.02,return_5m:.04
    },
    risk_flags:['EARLY_FLOW_WATCH_ONLY'],reason_codes:['MICRO_EARLY_FLOW']
  });
  assert.equal(out.status,'SENT',JSON.stringify(out));
  assert.equal(out.sent_count,1);
  assert.equal(sent[0].watch_only,true);
  assert.equal(sent[0].entry_eligible,false);
  assert.equal(sent[0].real_order_execution,false);
  const audits=await store.readRecent('notifications',10);
  const audit=audits.find(x=>x.event==='RADAR_WATCH_ONLY_NOTIFICATION');
  assert.ok(audit);
  assert.equal(audit.data_quality,null);
  assert.equal(audit.liquidity_quality,null);
  assert.equal(audit.micro_data_validated,true);
  assert.equal(audit.liquidity_evidence_status,'ORDER_BOOK_NOT_CHECKED_AT_MICRO_STAGE');
});

test('TEST_FIXTURE: missing radar data quality fails closed instead of inheriting 100',async()=>{
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

test('TEST_FIXTURE: nested Al-Muqawim quality is honored by the shared push filter',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-radar-nested-dq-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70});
  await store.upsertSubscription('u1',pushSubscription());
  const sent=[];
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){sent.push(payload);return{ok:true,status:'SENT'};}};
  const m=new PushManager({provider,store});
  const out=await m.notifyRadarAlert({radar:'ALMUQAWIM_RADAR',symbol:'RESILIENTUSDT',direction:'UP',almuqawim:{data_quality:88}});
  assert.equal(out.length,1);
  assert.equal(sent.length,1);
});

test('TEST_FIXTURE: radar notifications forward lifecycle labels and reasons to the push provider',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-lifecycle-push-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70});
  await store.upsertSubscription('u1',pushSubscription());
  const sent=[];
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){sent.push(payload);return{ok:true,status:'SENT'};}};
  const m=new PushManager({provider,store});
  await m.notifyRadarAlert({
    radar:'EARLY_EXPANSION_RADAR',radar_name:'Radar 8',symbol:'EARLYUSDT',data_quality:95,
    signal_lifecycle:{state:'EARLY_SETUP',label:'إعداد مبكر',transition:'EARLY_EVIDENCE_CONVERGED',reason_codes:['RELATED_EARLY_EVIDENCE']}
  });
  assert.equal(sent.length,1);
  assert.equal(sent[0].signal_lifecycle_state,'EARLY_SETUP');
  assert.equal(sent[0].signal_lifecycle_label,'إعداد مبكر');
  assert.equal(sent[0].signal_lifecycle_transition,'EARLY_EVIDENCE_CONVERGED');
  assert.deepEqual(sent[0].signal_lifecycle_reason_codes,['RELATED_EARLY_EVIDENCE']);
  assert.equal(sent[0].message,'EARLYUSDT • إعداد مبكر');
});



test('TEST_FIXTURE: validated quiet-base watch sends a labelled non-entry notification',async()=>{
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
  assert.equal(out.status,'SENT',JSON.stringify(out));
  assert.equal(out.attempted,true);
  assert.equal(out.sent_count,1);
  assert.equal(sent.length,1,'validated watch-only evidence must reach the opted-in notification provider');
  assert.equal(sent[0].watch_only,true);
  assert.equal(sent[0].entry_eligible,false);
  assert.equal(sent[0].notification_mode,'WATCH_ONLY_EARLY_TRACK');
  assert.equal(sent[0].real_order_execution,false);
  const audits=await store.readRecent('notifications',10);
  assert.equal(audits.filter(x=>x.event==='RADAR_WATCH_ONLY_NOTIFICATION').length,1);
});

test('TEST_FIXTURE: quiet-base near-miss push fails closed for incomplete flow or missing anti-chase evidence',async()=>{
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
