import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRadarNotificationGate,notificationGateHealth,resetRadarNotificationGateForTests,getRadarSignalLifecycleState,radarSignalLifecycleHealth,advanceSignalLifecycle} from '../core/radar-notification-gate.mjs';
import {evaluateRadarQuality} from '../core/radar-quality-v3.mjs';
import {buildEarlyExpansionAlert} from '../core/early-expansion-radar.mjs';

const NOW=1_900_000_000_000;
function baseline(radar,extra={}){
  return {radar,symbol:'TESTUSDT',opportunity_score:95,radar_power_score:95,data_quality:96,liquidity_quality:90,price_change_24h:1.2,
    detected_at:NOW,processed_at:NOW,eligible:true,direction:'UP',reasons:['closed candle','volume participation'],reason_codes:['VOLUME_PARTICIPATION'],
    risk_flags:[],components:{momentum:90,volume:90,trades:90,taker:90,range:90,breakout:90,ema:90,vwap:90,bollinger:90,efficiency:90,atr:90},...extra};
}
test('missing or invalid market-quality measurements fail closed instead of inheriting perfect scores',()=>{
  resetRadarNotificationGateForTests();
  const alert=baseline('STRONG_MOVE_RADAR',{
    data_quality:null,
    liquidity_quality:null,
    data_status:{data_quality:null},
    deep_scan:{assessment:{data_quality:null,liquidity_score:null}}
  });
  const result=evaluateRadarNotificationGate(alert,{now:NOW});
  assert.equal(result.data_quality,0);
  assert.equal(result.liquidity_quality,0);
  assert.ok(result.failures.includes('DATA_QUALITY_BELOW_STRICT_THRESHOLD'));
  assert.ok(result.failures.includes('LIQUIDITY_BELOW_STRICT_THRESHOLD'));
  assert.equal(result.eligible,false);
});


test('shared gate reads native score/data/liquidity fields for all twelve radar payload shapes without inventing values',()=>{
  const cases=[
    ['EARLY_MOVE_RADAR',{early_wake:{score:81,data_quality:91,liquidity_quality:82}},81],
    ['STRONG_MOVE_RADAR',{strong_move:{score:82,data_quality:91,liquidity_quality:82}},82],
    ['ROTATION_LAG_RADAR',{rotation:{score:83,data_quality:91,liquidity_quality:82}},83],
    ['LIQUIDITY_ABSORPTION_RADAR',{liquidity_absorption:{score:84,data_quality:91,liquidity_quality:82}},84],
    ['KAHIR_RADAR',{kahir_analysis:{score:85,data_quality:91,liquidity_quality:82}},85],
    ['DOOMSDAY_RADAR',{doomsday:{score:86,data_quality:91,liquidity_quality:82}},86],
    ['PROFESSOR_RADAR',{score:87,professor_opinion:{data_quality:91,liquidity_quality:82}},87],
    ['ALMUQAWIM_RADAR',{almuqawim:{score:88,data_quality:91,liquidity_quality:82}},88],
    ['EARLY_EXPANSION_RADAR',{early_expansion_score:89,early_expansion:{data_quality:91,liquidity_quality:82}},89],
    ['COIN_HUNTER_RADAR',{factors:{early_setup_score:90},coin_hunter:{data_quality:91,liquidity_quality:82}},90],
    ['WHALE_ACCUMULATION_RADAR',{whale_accumulation:{score:91,data_quality:91,liquidity_quality:82}},91],
    ['FALCON_EYE_RADAR',{falcon_eye:{score:92,data_quality:91,liquidity_quality:82}},92]
  ];
  for(const [radar,extra,expectedScore] of cases){
    resetRadarNotificationGateForTests();
    const alert=baseline(radar,{
      opportunity_score:undefined,radar_power_score:undefined,setup_score:undefined,
      data_quality:undefined,data_status:{data_quality:undefined},liquidity_quality:undefined,
      components:{},...extra
    });
    const result=evaluateRadarNotificationGate(alert,{now:NOW,commit:false});
    assert.equal(result.score,expectedScore,radar+' score alias');
    assert.equal(result.data_quality,91,radar+' data-quality alias');
    assert.equal(result.liquidity_quality,82,radar+' liquidity-quality alias');
  }
});

test('all twelve declared radar profiles are present and health reports them',()=>{
  resetRadarNotificationGateForTests();const h=notificationGateHealth();assert.equal(h.registered_profile_count,12);
  for(const radar of ['EARLY_MOVE_RADAR','STRONG_MOVE_RADAR','ROTATION_LAG_RADAR','LIQUIDITY_ABSORPTION_RADAR','KAHIR_RADAR','DOOMSDAY_RADAR','PROFESSOR_RADAR','ALMUQAWIM_RADAR','EARLY_EXPANSION_RADAR','COIN_HUNTER_RADAR','WHALE_ACCUMULATION_RADAR','FALCON_EYE_RADAR'])assert.ok(h.registered_profiles.includes(radar),radar);
});
test('unknown radar ids cannot inherit the more permissive Professor profile',()=>{
  resetRadarNotificationGateForTests();const r=evaluateRadarNotificationGate(baseline('UNREGISTERED_RADAR'),{now:NOW});
  assert.ok(r.failures.includes('RADAR_PROFILE_MISSING'));assert.equal(r.profile_thresholds.min_score,90);assert.equal(r.profile_thresholds.min_data_quality,90);
});
test('Al-Muqawim uses its own multi-timeframe and entry-freshness conditions',()=>{
  resetRadarNotificationGateForTests();const a=baseline('ALMUQAWIM_RADAR',{eligible:false,almuqawim:{eligible:false,direction:'UP',components:{higher_timeframe_alignment:75,market_structure:82,lower_timeframe_agreement:72,entry_timing:60,entry_freshness:40}}});
  const r=evaluateRadarNotificationGate(a,{now:NOW});assert.equal(r.profile_thresholds.min_score,86);
  for(const code of ['ALMUQAWIM_ANALYSIS_NOT_ELIGIBLE','ALMUQAWIM_HIGHER_TIMEFRAME_ALIGNMENT_WEAK','ALMUQAWIM_MARKET_STRUCTURE_WEAK','ALMUQAWIM_LOWER_TIMEFRAME_DISAGREEMENT','ALMUQAWIM_ENTRY_TIMING_STALE'])assert.ok(r.failures.includes(code),code);
});
test('Lightning recognises pre-expansion fingerprint alias and blocks late setups',()=>{
  resetRadarNotificationGateForTests();const a=baseline('EARLY_EXPANSION_RADAR',{pre_expansion_fingerprint:{ready:true,late:true,micro_move:false,score:88},pre_expansion_stage:'ALREADY_EXTENDED',early_expansion_score:90,metrics:{rvol_5m:2.1,trade_ratio:1.7,taker_buy_ratio:.58,price_change_5m_pct:1.1}});
  const r=evaluateRadarNotificationGate(a,{now:NOW});assert.ok(r.failures.includes('LATE_SETUP_CHASE_GUARD'));assert.ok(r.failures.includes('EARLY_EXPANSION_STAGE_NOT_NOTIFIABLE'));
});
test('Coin Hunter cannot pass without its own micro-participation and anti-chase measurements',()=>{
  resetRadarNotificationGateForTests();const r=evaluateRadarNotificationGate(baseline('COIN_HUNTER_RADAR',{factors:{early_setup_score:80}}),{now:NOW});
  for(const code of ['COIN_HUNTER_MICRO_PARTICIPATION_MISSING','COIN_HUNTER_RESISTANCE_ROOM_INSUFFICIENT','COIN_HUNTER_ANTI_CHASE_OR_UNKNOWN'])assert.ok(r.failures.includes(code),code);
});
test('Kahir category diversity reads scores from nested analysis',()=>{
  resetRadarNotificationGateForTests();const a=baseline('KAHIR_RADAR',{components:undefined,kahir_analysis:{eligible:true,score:90,direction:'UP',data_quality:92,confirmation_count:8,metrics:{one_minute_z:2.2,five_minute_z:2},algorithms:{
    PARTICIPATION_REGIME:{score:86},VOLATILITY_REGIME_TRANSITION:{score:78},KAUFMAN_EFFICIENCY_SHIFT:{score:80},RANGE_ACCEPTANCE:{score:77},IMPULSE_PERSISTENCE:{score:82}}}});
  const r=evaluateRadarNotificationGate(a,{now:NOW});assert.equal(r.confirmations,8,'read confirmation count from kahir_analysis');assert.ok(!r.failures.includes('CONFIRMATION_BREADTH_LOW'));assert.ok(r.category_hits>=5,'nested Kahir scores count: '+r.category_hits);assert.equal(r.profile_thresholds.min_score,88);assert.equal(r.profile_thresholds.min_confirmations,7);assert.equal(r.profile_thresholds.min_category_hits,4);
});
test('null or blank component values do not inflate evidence count',()=>{
  const missing=evaluateRadarQuality({radar:'STRONG_MOVE_RADAR',components:{volume:null,breakout:'',trades:undefined}});
  const measured=evaluateRadarQuality({radar:'STRONG_MOVE_RADAR',components:{volume:0,breakout:82,trades:undefined}});
  assert.equal(missing.evidence_count,0);assert.equal(measured.evidence_count,2);
});

test('Radar 8 alert carries the actual pre-expansion fingerprint and metrics into the notification gate',()=>{
  const candidate={
    symbol:'XYZUSDT',last_price:1.23,price_change_24h:2.0,early_expansion_score:84,
    decision_band:'PRE_EXPANSION',pre_expansion_stage:'PRE_EXPANSION',
    pre_expansion_fingerprint:{stage:'PRE_EXPANSION',ready:true,late:false,micro_move:false,score:82},
    metrics:{rvol_1m:1.4,rvol_5m:2.1,trade_ratio:1.7,taker_buy_ratio:0.58,price_change_5m_pct:0.8},
    data_quality:92,data_stale:false,liquidity_quality:80,
    risk_flags:[],reason_codes:[],source:'Binance Public REST'
  };
  const alert=buildEarlyExpansionAlert(candidate,NOW);
  assert.equal(alert.pre_expansion_fingerprint.score,82);
  assert.equal(alert.pre_expansion_fingerprint.late,false);
  assert.deepEqual(alert.metrics,candidate.metrics);
  assert.deepEqual(alert.price_change_windows,candidate.metrics);
});

test('Radar 8 rejects missing live liquidity evidence rather than defaulting it to perfect quality',()=>{
  resetRadarNotificationGateForTests();
  const alert=baseline('EARLY_EXPANSION_RADAR',{
    pre_expansion_fingerprint:{stage:'PRE_EXPANSION',ready:true,late:false,micro_move:false,score:85},
    pre_expansion_stage:'PRE_EXPANSION',
    metrics:{rvol_5m:2.1,trade_ratio:1.7,taker_buy_ratio:0.58,price_change_5m_pct:0.8},
    liquidity_quality:null,liquidity_metrics:{liquidity_quality:null},source:'Binance Public REST'
  });
  const result=evaluateRadarNotificationGate(alert,{now:NOW});
  assert.ok(result.failures.includes('EARLY_EXPANSION_LIQUIDITY_QUALITY_UNKNOWN_OR_LOW'));
});

test('Rotation Lag reads actual component_scores for category diversity and relative-strength evidence',()=>{
  resetRadarNotificationGateForTests();
  const alert=baseline('ROTATION_LAG_RADAR',{
    direction:'UP_ROTATION',
    rotation:{eligible:true,score:92,activation_score:82,confirmations:6,
      component_scores:{lag:72,resilience:70,silent_volume:78,reclaim_or_reject:76,value_acceptance:73,rsi_turn:72,mfi_turn:70,stochastic_turn:70,persistence:75,compression:78},
      metrics:{relative_30m_pct:0.8,resilience_score:70,volume_ratio:1.4,range_ratio:0.8}}
  });
  const result=evaluateRadarNotificationGate(alert,{now:NOW});
  assert.ok(result.category_hits>=5,'Rotation component scores should count as independent category evidence');
  assert.ok(!result.failures.includes('CATEGORY_DIVERSITY_LOW'));
  assert.ok(!result.failures.includes('RELATIVE_STRENGTH_NOT_CONFIRMED'));
  assert.equal(result.profile_thresholds.min_score,82);
  assert.equal(result.profile_thresholds.min_confirmations,5);
});

test('Liquidity Absorption reads the actual SELLER_ABSORPTION and FIVE_MINUTE_CONFIRMATION algorithm outputs',()=>{
  resetRadarNotificationGateForTests();
  const alert=baseline('LIQUIDITY_ABSORPTION_RADAR',{
    direction:'UP_SETUP',
    liquidity_absorption:{eligible:true,score:94,confirmation_count:8,
      algorithms:{
        SELLER_ABSORPTION:{score:84,volumeRatio:1.8,netMovePct:0.6},
        DEPTH_IMBALANCE_VACUUM:{score:76,imbalance:0.16,spreadBps:5},
        TRAPPED_SELLER_RELEASE:{score:78},
        MICROSTRUCTURE_DISLOCATION:{score:74},
        LOCAL_AUCTION_BALANCE:{score:75},
        FRACTAL_MICRO_STRUCTURE:{score:80},
        FIVE_MINUTE_CONFIRMATION:{score:72,returnPct:0.4}
      },
      metrics:{absorption_score:84,depth_score:76,trapped_seller_score:78,dislocation_score:74,auction_score:75,structure_score:80,depth_imbalance:0.16,spread_bps:5,volume_ratio:1.8,net_move_pct:0.6}},
  });
  const result=evaluateRadarNotificationGate(alert,{now:NOW});
  assert.ok(result.category_hits>=5);
  assert.ok(!result.failures.includes('ABSORPTION_NOT_STRONG_ENOUGH'));
  assert.ok(!result.failures.includes('FIVE_MINUTE_CONFIRMATION_WEAK'));
  assert.equal(result.profile_thresholds.min_score,83);
  assert.equal(result.profile_thresholds.min_confirmations,6);
});

test('Doomsday permits a valid pre-breakout candidate without requiring ignition score',()=>{
  resetRadarNotificationGateForTests();
  const alert=baseline('DOOMSDAY_RADAR',{
    opportunity_score:84,
    potential_label:'PRE_BREAKOUT',
    doomsday:{eligible:true,stage:'PRE_BREAKOUT',score:84,early_score:84,ignition_score:74,
      confirmation_count:6,ignition_confirmations:3,confirmation_total:9,
      component_scores:{impulse:70,volume:82,trades:78,taker:76,breakout:86,ema:80,vwap:72,squeeze:74,relative_strength:73,acceleration:84,range:70,atr:71,acceptance:80},
      metrics:{volume_ratio:1.5,trade_ratio:1.4,taker_buy_ratio:0.53,return_3m:0.2,return_5m:0.1,relative_strength_pct:0.3}}
  });
  const result=evaluateRadarNotificationGate(alert,{now:NOW});
  assert.equal(result.profile_thresholds.min_score,82);
  assert.ok(result.category_hits>=5);
  assert.ok(!result.failures.includes('DOOMSDAY_CONFIRMATION_BREADTH_LOW'));
  assert.ok(!result.failures.includes('IGNITION_SCORE_NOT_CONFIRMED'));
  assert.ok(!result.failures.includes('DOOMSDAY_EARLY_SCORE_NOT_CONFIRMED'));
});

test('Falcon Eye reads its eight confirmations from the nested alert payload',()=>{
  resetRadarNotificationGateForTests();
  const alert=baseline('FALCON_EYE_RADAR',{
    falcon_eye:{eligible:true,score:88,confirmation_count:8,not_chasing:true,
      pre_expansion_fingerprint:{ready:true,late:false,micro_move:false,score:82},
      component_scores:{quietness:82,compression:80,momentum:78,volume:82,trades:78,taker:74,structure:82,resistance:76,relative_strength:78,derivatives:72,breakout:80,atr:75,range:74},
      metrics:{taker_buy_ratio:0.56}}
  });
  const result=evaluateRadarNotificationGate(alert,{now:NOW});
  assert.equal(result.confirmations,8);
  assert.ok(!result.failures.includes('CONFIRMATION_BREADTH_LOW'));
  assert.ok(!result.failures.includes('FALCON_CONFIRMATION_BREADTH_LOW'));
});

test('Whale Accumulation reads confirmations from its nested analysis payload',()=>{
  resetRadarNotificationGateForTests();
  const alert=baseline('WHALE_ACCUMULATION_RADAR',{
    whale_accumulation:{eligible:true,score:90,confirmation_count:8,
      large_prints:{available:true,largeCount:5,largeBuyRatio:0.72,largeNotionalRatio:0.18,score:82,repeatBuyScore:80,burstScore:74},
      candle_flow:{available:true,absorptionScore:80,higherLowScore:76},
      orderbook:{spreadBps:6,nearImbalance:0.15,midImbalance:0.10},
      orderbook_persistence:{score:78},support_score:80,stability_score:82,price_context:{not_extended:true}}
  });
  const result=evaluateRadarNotificationGate(alert,{now:NOW});
  assert.equal(result.confirmations,8);
  assert.ok(!result.failures.includes('CONFIRMATION_BREADTH_LOW'));
});


test('final notification gates reject failed-breakout evidence for Radars 6, 8 and 9',()=>{
  resetRadarNotificationGateForTests();
  const trap={version:'RADAR_ROLE_EVIDENCE_V1',failed_breakout:{available:true,detected:true,status:'FAILED_BREAKOUT_TRAP'},continuation:{available:true,confirmed:true,status:'CONFIRMED'}};
  const doomsday=evaluateRadarNotificationGate(baseline('DOOMSDAY_RADAR',{
    opportunity_score:90,potential_label:'PRE_BREAKOUT',
    doomsday:{eligible:true,stage:'PRE_BREAKOUT',score:90,early_score:90,ignition_score:90,confirmation_count:8,ignition_confirmations:8,
      component_scores:{impulse:85,volume:90,trades:88,taker:86,breakout:90,ema:84,vwap:82,squeeze:82,relative_strength:80,acceleration:88,range:84,atr:82,acceptance:85},
      role_evidence:trap,metrics:{volume_ratio:1.8,trade_ratio:1.6,taker_buy_ratio:.58}}
  }),{now:NOW,commit:false});
  assert.ok(doomsday.failures.includes('DOOMSDAY_FAILED_BREAKOUT_TRAP_RISK'));

  const early=evaluateRadarNotificationGate(baseline('EARLY_EXPANSION_RADAR',{
    pre_expansion_stage:'BREAKOUT_DEVELOPING',
    pre_expansion_fingerprint:{stage:'BREAKOUT_DEVELOPING',ready:true,late:false,micro_move:false,score:86},
    metrics:{rvol_5m:1.8,trade_ratio:1.5,taker_buy_ratio:.58,price_change_5m_pct:.8},
    role_evidence:trap
  }),{now:NOW,commit:false});
  assert.ok(early.failures.includes('EARLY_EXPANSION_FAILED_BREAKOUT_TRAP_RISK'));

  const falcon=evaluateRadarNotificationGate(baseline('FALCON_EYE_RADAR',{
    falcon_eye:{eligible:true,score:92,confirmation_count:10,not_chasing:true,pre_expansion_stage:'BREAKOUT_DEVELOPING',
      component_scores:{quietness:85,compression:84,momentum:82,volume:88,trades:82,taker:84,structure:86,resistance:82,relative_strength:83,derivatives:75,breakout:85,atr:78,range:77},
      metrics:{move_24h_pct:2,return_5m:.7,return_10m:1.0,ema21_distance_pct:.8,resistance_gap_pct:.5},
      derivatives:{futures_available:false},role_evidence:trap}
  }),{now:NOW,commit:false});
  assert.ok(falcon.failures.includes('FALCON_FAILED_BREAKOUT_TRAP_RISK'));
});

test('final notification gates reject active breakouts without closed-candle continuation confirmation',()=>{
  resetRadarNotificationGateForTests();
  const evidence={failed_breakout:{detected:false,status:'NO_CONFIRMED_TRAP'},continuation:{status:'DATA_INSUFFICIENT',confirmed:false}};
  const doomsday=evaluateRadarNotificationGate(baseline('DOOMSDAY_RADAR',{
    potential_label:'IGNITION',
    doomsday:{eligible:true,stage:'IGNITION',score:92,early_score:92,ignition_score:92,confirmation_count:9,ignition_confirmations:8,
      component_scores:{impulse:88,volume:90,trades:90,taker:88,breakout:90,ema:85,vwap:82,squeeze:80,relative_strength:82,acceleration:90,range:85,atr:80,acceptance:86},
      role_evidence:evidence,metrics:{micro_breakout:true,volume_ratio:1.8,trade_ratio:1.6,taker_buy_ratio:.58}}
  }),{now:NOW,commit:false});
  assert.ok(doomsday.failures.includes('DOOMSDAY_BREAKOUT_CONTINUATION_UNCONFIRMED'));

  const early=evaluateRadarNotificationGate(baseline('EARLY_EXPANSION_RADAR',{
    pre_expansion_stage:'BREAKOUT_DEVELOPING',
    pre_expansion_fingerprint:{stage:'BREAKOUT_DEVELOPING',ready:true,late:false,micro_move:false,score:86},
    metrics:{rvol_5m:1.8,trade_ratio:1.5,taker_buy_ratio:.58,price_change_5m_pct:.8},
    role_evidence:evidence
  }),{now:NOW,commit:false});
  assert.ok(early.failures.includes('EARLY_EXPANSION_BREAKOUT_CONTINUATION_UNCONFIRMED'));

  const falcon=evaluateRadarNotificationGate(baseline('FALCON_EYE_RADAR',{
    falcon_eye:{eligible:true,score:92,confirmation_count:10,not_chasing:true,pre_expansion_stage:'BREAKOUT_DEVELOPING',
      component_scores:{quietness:85,compression:84,momentum:82,volume:88,trades:82,taker:84,structure:86,resistance:82,relative_strength:83,derivatives:75,breakout:85,atr:78,range:77},
      metrics:{move_24h_pct:2,return_5m:.7,return_10m:1.0,ema21_distance_pct:.8,resistance_gap_pct:.5},
      derivatives:{futures_available:false},role_evidence:evidence}
  }),{now:NOW,commit:false});
  assert.ok(falcon.failures.includes('FALCON_BREAKOUT_CONTINUATION_UNCONFIRMED'));
});


test('final notification gate fails closed when continuation evidence is missing for active breakouts',()=>{
  resetRadarNotificationGateForTests();
  const doomsday=evaluateRadarNotificationGate(baseline('DOOMSDAY_RADAR',{
    potential_label:'IGNITION',
    doomsday:{eligible:true,stage:'IGNITION',score:92,early_score:92,ignition_score:92,confirmation_count:9,ignition_confirmations:8,
      component_scores:{impulse:88,volume:90,trades:90,taker:88,breakout:90,ema:85,vwap:82,squeeze:80,relative_strength:82,acceleration:90,range:85,atr:80,acceptance:86},
      metrics:{micro_breakout:true,volume_ratio:1.8,trade_ratio:1.6,taker_buy_ratio:.58}}
  }),{now:NOW,commit:false});
  assert.ok(doomsday.failures.includes('DOOMSDAY_BREAKOUT_CONTINUATION_UNCONFIRMED'));

  const early=evaluateRadarNotificationGate(baseline('EARLY_EXPANSION_RADAR',{
    pre_expansion_stage:'BREAKOUT_DEVELOPING',
    pre_expansion_fingerprint:{stage:'BREAKOUT_DEVELOPING',ready:true,late:false,micro_move:false,score:86},
    metrics:{rvol_5m:1.8,trade_ratio:1.5,taker_buy_ratio:.58,price_change_5m_pct:.8}
  }),{now:NOW,commit:false});
  assert.ok(early.failures.includes('EARLY_EXPANSION_BREAKOUT_CONTINUATION_UNCONFIRMED'));

  const falcon=evaluateRadarNotificationGate(baseline('FALCON_EYE_RADAR',{
    falcon_eye:{eligible:true,score:92,confirmation_count:10,not_chasing:true,pre_expansion_stage:'BREAKOUT_DEVELOPING',
      component_scores:{quietness:85,compression:84,momentum:82,volume:88,trades:82,taker:84,structure:86,resistance:82,relative_strength:83,derivatives:75,breakout:85,atr:78,range:77},
      metrics:{move_24h_pct:2,return_5m:.7,return_10m:1.0,ema21_distance_pct:.8,resistance_gap_pct:.5},
      derivatives:{futures_available:false}}
  }),{now:NOW,commit:false});
  assert.ok(falcon.failures.includes('FALCON_BREAKOUT_CONTINUATION_UNCONFIRMED'));
});

test('shared signal lifecycle progresses from early setup to review then invalidation without replacing radar-specific eligibility',()=>{
  resetRadarNotificationGateForTests();
  const early=evaluateRadarNotificationGate(baseline('EARLY_EXPANSION_RADAR',{
    pre_expansion_stage:'PRE_EXPANSION',
    potential_label:'PRE_EXPANSION',
    pre_expansion_fingerprint:{stage:'PRE_EXPANSION',ready:true,late:false,micro_move:false,score:82}
  }),{now:NOW});
  assert.equal(early.signal_lifecycle.state,'EARLY_SETUP',JSON.stringify(early.signal_lifecycle));
  assert.equal(early.signal_lifecycle.label,'إعداد مبكر');
  assert.equal(typeof early.eligible,'boolean','existing per-radar eligibility remains independently evaluated');

  const review=evaluateRadarNotificationGate(baseline('EARLY_EXPANSION_RADAR',{
    pre_expansion_stage:'BREAKOUT_DEVELOPING',
    potential_label:'BREAKOUT_DEVELOPING',
    pre_expansion_fingerprint:{stage:'BREAKOUT_DEVELOPING',ready:true,late:false,micro_move:false,score:86}
  }),{now:NOW+1000});
  assert.equal(review.signal_lifecycle.state,'SIGNAL_REVIEW',JSON.stringify(review.signal_lifecycle));
  assert.equal(review.signal_lifecycle.transition,'TRIGGER_DETECTED');

  const invalid=evaluateRadarNotificationGate(baseline('EARLY_EXPANSION_RADAR',{
    pre_expansion_stage:'ALREADY_EXTENDED',
    potential_label:'ALREADY_EXTENDED'
  }),{now:NOW+2000});
  assert.equal(invalid.signal_lifecycle.state,'INVALIDATED',JSON.stringify(invalid.signal_lifecycle));
  assert.equal(invalid.signal_lifecycle.terminal,true);
  assert.ok(invalid.signal_lifecycle.reason_codes.includes('SETUP_STAGE_ALREADY_EXTENDED'));
  const stored=getRadarSignalLifecycleState({symbol:'TESTUSDT',radar:'EARLY_EXPANSION_RADAR'});
  assert.equal(stored.state,'INVALIDATED');
  assert.equal(stored.generation,1);
});

test('missing market evidence stays in monitoring instead of falsely invalidating the setup',()=>{
  resetRadarNotificationGateForTests();
  const result=evaluateRadarNotificationGate(baseline('STRONG_MOVE_RADAR',{
    data_quality:null,liquidity_quality:null,data_status:{data_quality:null,stale:true}
  }),{now:NOW});
  assert.equal(result.signal_lifecycle.state,'MONITOR',JSON.stringify(result.signal_lifecycle));
  assert.equal(result.signal_lifecycle.terminal,false);
  assert.ok(result.signal_lifecycle.reason_codes.includes('EVIDENCE_NOT_READY'));
  assert.equal(radarSignalLifecycleHealth({now:NOW}).tracked_candidates,1);
});

test('an invalidated setup is retained until a materially new early setup appears',()=>{
  resetRadarNotificationGateForTests();
  evaluateRadarNotificationGate(baseline('EARLY_EXPANSION_RADAR',{pre_expansion_stage:'ALREADY_EXTENDED'}),{now:NOW});
  const weak=evaluateRadarNotificationGate(baseline('EARLY_EXPANSION_RADAR',{}),{now:NOW+1000});
  assert.equal(weak.signal_lifecycle.state,'INVALIDATED');
  assert.equal(weak.signal_lifecycle.transition,'INVALIDATION_RETAINED');

  const renewed=evaluateRadarNotificationGate(baseline('EARLY_EXPANSION_RADAR',{
    pre_expansion_stage:'PRE_EXPANSION',
    pre_expansion_fingerprint:{stage:'PRE_EXPANSION',ready:true,late:false,score:84}
  }),{now:NOW+2000});
  assert.ok(['EARLY_SETUP','SIGNAL_REVIEW','CONFIRMED'].includes(renewed.signal_lifecycle.state),JSON.stringify(renewed.signal_lifecycle));
  assert.equal(renewed.signal_lifecycle.generation,2);
  assert.equal(renewed.signal_lifecycle.transition,'NEW_SETUP_AFTER_INVALIDATION');
});


function strongEarlyWatchCandidate(extra={}){
  return baseline('STRONG_MOVE_RADAR',{
    opportunity_score:84,radar_power_score:84,
    structure_score:90,flow_score:90,momentum_score:90,compression_score:90,
    relative_strength:90,trigger_score:90,participation_score:90,
    confirmation_count:3,
    strong_move:{score:84,metrics:{return_3m:0.7,micro_breakout:false,volume_ratio:1.8,trade_ratio:1.5,taker_buy_ratio:0.55,taker_buy_delta:0.02,five_min_trend:70,five_min_return:0.4}},
    ...extra
  });
}

test('evidence-gated watch-only early corridor can surface a strong fresh candidate across non-legacy radars',()=>{
  resetRadarNotificationGateForTests();
  const result=evaluateRadarNotificationGate(strongEarlyWatchCandidate(),{now:NOW,commit:false});
  assert.equal(result.eligible,true,JSON.stringify({mode:result.mode,failures:result.failures,falcon:result.falcon_eye}));
  assert.equal(result.mode,'RADAR_WATCH_ONLY_EARLY_TRACK');
  assert.equal(result.watch_only,true);
  assert.equal(result.requires_follow_up_confirmation,true);
  assert.ok(result.failures.includes('SCORE_BELOW_STRICT_THRESHOLD'));
  assert.notEqual(result.signal_lifecycle.state,'CONFIRMED');
});

test('shared watch-only corridor never bypasses a failed-breakout trap or anti-chase failure',()=>{
  resetRadarNotificationGateForTests();
  const result=evaluateRadarNotificationGate(baseline('FALCON_EYE_RADAR',{
    opportunity_score:84,radar_power_score:84,
    structure_score:90,flow_score:90,momentum_score:90,compression_score:90,
    relative_strength:90,trigger_score:90,participation_score:90,
    direction:'UP',confirmation_count:4,
    falcon_eye:{
      eligible:true,score:84,confirmation_count:4,not_chasing:true,
      pre_expansion_fingerprint:{ready:true,late:false,micro_move:false,score:82},
      component_scores:{quietness:82,compression:80,momentum:78,volume:82,trades:78,taker:74,structure:82,resistance:76,relative_strength:78,derivatives:72,breakout:80,atr:75,range:74},
      metrics:{move_24h_pct:2,return_5m:0.7,return_10m:1.0,ema21_distance_pct:0.8,resistance_gap_pct:0.5},
      derivatives:{futures_available:false},
      role_evidence:{failed_breakout:{detected:true,status:'FAILED_BREAKOUT_TRAP'},continuation:{confirmed:false,status:'DATA_INSUFFICIENT'}}
    }
  }),{now:NOW,commit:false});
  assert.ok(result.failures.includes('FALCON_FAILED_BREAKOUT_TRAP_RISK'));
  assert.equal(result.mode,'STRICT_NOTIFICATION');
  assert.equal(result.eligible,false);
});


test('shared early-watch corridor preserves Rotation/Lag thesis blockers',()=>{
  resetRadarNotificationGateForTests();
  const result=evaluateRadarNotificationGate(baseline('ROTATION_LAG_RADAR',{
    opportunity_score:84,radar_power_score:84,direction:'UP',
    rotation:{eligible:true,score:84,activation_score:40,confirmations:5,
      component_scores:{lag:30,resilience:40},
      metrics:{lag:30,resilience:40}}
  }),{now:NOW,commit:false});
  assert.ok(result.failures.includes('RELATIVE_STRENGTH_NOT_CONFIRMED'));
  assert.ok(result.failures.includes('ROTATION_ACTIVATION_WEAK'));
  assert.equal(result.eligible,false);
  assert.equal(result.mode,'STRICT_NOTIFICATION');
});

test('shared early-watch corridor does not bypass Al-Muqawim multi-timeframe structure checks',()=>{
  resetRadarNotificationGateForTests();
  const result=evaluateRadarNotificationGate(baseline('ALMUQAWIM_RADAR',{
    opportunity_score:82,radar_power_score:82,direction:'UP',
    almuqawim:{eligible:false,direction:'UP',components:{
      higher_timeframe_alignment:72,market_structure:78,lower_timeframe_agreement:70,entry_timing:60,entry_freshness:40
    }}
  }),{now:NOW,commit:false});
  for(const code of ['ALMUQAWIM_ANALYSIS_NOT_ELIGIBLE','ALMUQAWIM_HIGHER_TIMEFRAME_ALIGNMENT_WEAK',
    'ALMUQAWIM_MARKET_STRUCTURE_WEAK','ALMUQAWIM_LOWER_TIMEFRAME_DISAGREEMENT','ALMUQAWIM_ENTRY_TIMING_STALE']){
    assert.ok(result.failures.includes(code),code);
  }
  assert.equal(result.eligible,false);
  assert.equal(result.mode,'STRICT_NOTIFICATION');
});

test('watch-only early corridor requires an explicitly upward direction',()=>{
  resetRadarNotificationGateForTests();
  const result=evaluateRadarNotificationGate(strongEarlyWatchCandidate({direction:'DOWN'}),{now:NOW,commit:false});
  assert.equal(result.eligible,false,JSON.stringify({mode:result.mode,failures:result.failures}));
  assert.equal(result.mode,'STRICT_NOTIFICATION');
});

test('only a strict pass becomes confirmed; confirmation remains explicitly non-predictive',()=>{
  resetRadarNotificationGateForTests();
  const confirmed=advanceSignalLifecycle({symbol:'ATOMUSDT',radar:'TEST_RADAR',data_quality:96},{
    radar:'TEST_RADAR',eligible:true,mode:'STRICT_NOTIFICATION',failures:[],score:94,data_quality:96,liquidity_quality:90,
    confirmations:8,category_hits:6,
    profile_thresholds:{min_score:90,min_data_quality:90,min_liquidity_quality:70,min_confirmations:6,min_category_hits:4},
    falcon_eye:{capture:82,quality:84,independent_domains:5}
  },{now:NOW});
  assert.equal(confirmed.state,'CONFIRMED');
  assert.equal(confirmed.label,'تأكيد مستوفٍ للشروط');
  assert.ok(confirmed.reason_codes.includes('STRICT_GATES_PASSED'));
  assert.equal(confirmed.terminal,false);
});
