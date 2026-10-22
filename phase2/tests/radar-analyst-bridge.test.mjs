import test from 'node:test';
import assert from 'node:assert/strict';
import {connectRadarAlertsToAnalysts} from '../core/radar-analyst-bridge.mjs';
import {evaluateRadarNotificationGate} from '../core/radar-notification-gate.mjs';

{
  const alerts=[];
  const queued=[];
  const decisions=[];
  const logs=[];
  const pushManager={
    async notifyRadarAlert(alert,extra){
      alerts.push({alert,extra});
      return {status:'delivered',marker:'ORIGINAL_PATH'};
    }
  };
  const multiAnalystRadar={
    enqueueRadarReview(symbol,options){
      queued.push({symbol,options});
      return {queued:true,already_queued:false,pending_count:queued.length};
    }
  };
  const installed=connectRadarAlertsToAnalysts({
    pushManager,multiAnalystRadar,logger:{info:x=>logs.push(x),warn:x=>logs.push(x)},
    clock:()=>1800000000000,
    decisionRecorder:(alert,gate,options)=>decisions.push({alert,gate,options})
  });
  assert.equal(installed.installed,true);
  assert.equal(installed.mode,'NON_BLOCKING_REVIEW_ONLY');
  const alert={symbol:'BTCUSDT',radar:'RADAR8',signal_type:'WATCH_EARLY',signal_score:81,detected_at:1799999999000};
  const result=await pushManager.notifyRadarAlert(alert,{trace:'kept'});
  assert.deepEqual(result,{status:'delivered',marker:'ORIGINAL_PATH'});
  assert.equal(alerts.length,1);
  assert.equal(alerts[0].alert,alert);
  assert.deepEqual(alerts[0].extra,{trace:'kept'});
  assert.equal(alerts[0].alert.signal_lifecycle.state,'MONITOR','missing evidence must not be presented as early or confirmed');
  assert.equal(queued.length,1);
  assert.deepEqual(queued[0],{symbol:'BTCUSDT',options:{sourceRadar:'RADAR8'}});
  assert.equal(decisions.length,1);
  assert.equal(decisions[0].alert.symbol,'BTCUSDT');
  assert.equal(decisions[0].gate.eligible,false,'emitted alerts with missing/failed shared-gate evidence are not accepted signals');
  assert.equal(decisions[0].gate.accepted_mode,'RADAR_ALERT_EMITTED_GATE_REJECTED_REVIEW_PENDING');
  assert.ok(decisions[0].gate.soft_failures.includes('DATA_QUALITY_BELOW_STRICT_THRESHOLD'));
  assert.equal(decisions[0].options.source,'LIVE');
  assert.equal(JSON.stringify(logs).includes('RADAR_ANALYST_REVIEW_QUEUED'),true);
  assert.deepEqual(connectRadarAlertsToAnalysts({pushManager,multiAnalystRadar}).reason,'ALREADY_INSTALLED');
}

console.log('radar analyst bridge preserves original push and enqueues review: PASS');

{
  let pushCalls=0,queueCalls=0,decisionCalls=0;
  const pushManager={async notifyRadarAlert(){pushCalls++;return 'sent';}};
  const result=connectRadarAlertsToAnalysts({
    pushManager,
    multiAnalystRadar:{enqueueRadarReview(){queueCalls++;throw new Error('queue unavailable');}},
    logger:{warn(){}},
    decisionRecorder(){decisionCalls++}
  });
  assert.equal(result.installed,true);
  assert.equal(await pushManager.notifyRadarAlert({symbol:'BAD/SYMBOL',radar:'RADAR4'}),'sent');
  assert.equal(await pushManager.notifyRadarAlert({symbol:'ETHUSDT',radar:'RADAR4'}),'sent');
  assert.equal(pushCalls,2,'review bridge must not suppress the existing push path');
  assert.equal(queueCalls,1);
  assert.equal(decisionCalls,1,'telemetry is recorded for valid symbols without blocking push');
}


test('common bridge classifies direct notifications from non-gated radars as watch-only when early evidence qualifies',async()=>{
  const alerts=[],logs=[];
  const pushManager={async notifyRadarAlert(alert){alerts.push(alert);return {status:'delivered'};}};
  const multiAnalystRadar={enqueueRadarReview(){return {queued:true,already_queued:false,pending_count:1};}};
  const installed=connectRadarAlertsToAnalysts({
    pushManager,multiAnalystRadar,logger:{info:x=>logs.push(x),warn:x=>logs.push(x)},clock:()=>1_800_000_300_000
  });
  assert.equal(installed.installed,true);
  const alert={
    symbol:'WATCHLANEUSDT',radar:'STRONG_MOVE_RADAR',radar_name:'Radar 2',direction:'UP',
    opportunity_score:84,radar_power_score:84,data_quality:96,liquidity_quality:90,price_change_24h:1.2,
    detected_at:1_800_000_299_000,eligible:true,
    reasons:['closed candle','volume participation','buy pressure','structure','relative strength','compression'],
    reason_codes:['VOLUME_PARTICIPATION','BUYING_PRESSURE_CONFIRMED'],
    components:{momentum:90,volume:90,trades:90,taker:90,range:90,breakout:90,ema:90,vwap:90,bollinger:90,efficiency:90,atr:90},
    structure_score:90,flow_score:90,momentum_score:90,compression_score:90,relative_strength:90,trigger_score:90,participation_score:90,
    strong_move:{score:84,metrics:{return_3m:0.7,micro_breakout:false,volume_ratio:1.8,trade_ratio:1.5,taker_buy_ratio:0.55,taker_buy_delta:0.02,five_min_trend:70,five_min_return:0.4}}
  };
  const response=await pushManager.notifyRadarAlert(alert);
  assert.deepEqual(response,{status:'delivered'});
  assert.equal(alerts[0],alert,'classification preserves alert identity');
  assert.equal(alert.notification_gate?.eligible,true,JSON.stringify({gate:alert.notification_gate}));
  assert.equal(alert.notification_gate?.watch_only,true);
  assert.equal(alert.notification_gate?.mode,'RADAR_WATCH_ONLY_EARLY_TRACK');
  assert.equal(alert.signal_lifecycle.state,'EARLY_SETUP');
  assert.equal(alert.signal_lifecycle.terminal,false);
  assert.equal(JSON.stringify(logs).includes('RADAR_SHARED_WATCH_ONLY_CLASSIFIED'),true);
});

console.log('radar analyst bridge fails open and validates symbol: PASS');
test('non-blocking bridge attaches a meaningful early lifecycle without changing delivery eligibility',async()=>{
  const decisions=[],alerts=[];
  const pushManager={async notifyRadarAlert(alert){alerts.push(alert);return {status:'delivered'};}};
  const multiAnalystRadar={enqueueRadarReview(){return {queued:true,already_queued:false,pending_count:1};}};
  const installed=connectRadarAlertsToAnalysts({pushManager,multiAnalystRadar,logger:{info(){},warn(){}},clock:()=>1_800_000_200_000,
    decisionRecorder:(alert,gate,options)=>decisions.push({alert,gate,options})});
  assert.equal(installed.installed,true);
  const alert={symbol:'EARLYUSDT',radar:'RADAR8',pre_expansion_stage:'PRE_EXPANSION',
    potential_label:'PRE_EXPANSION',data_quality:95,liquidity_quality:88,
    pre_expansion_fingerprint:{stage:'PRE_EXPANSION',ready:true,late:false,score:82}};
  const response=await pushManager.notifyRadarAlert(alert);
  assert.deepEqual(response,{status:'delivered'});
  assert.equal(alerts[0],alert);
  assert.equal(alert.signal_lifecycle.state,'EARLY_SETUP',JSON.stringify(alert.signal_lifecycle));
  assert.equal(alert.signal_lifecycle.label,'إعداد مبكر');
  assert.equal(decisions.length,1);
});


test('watch-only notifications reach analyst review without being recorded as accepted signals',async()=>{
  const calls=[],decisions=[],logs=[];
  let regularNotifyCalls=0,watchNotifyCalls=0;
  const pushManager={
    async notifyRadarAlert(){regularNotifyCalls++;return {status:'normal-delivery'};},
    async notifyRadarWatchOnlyAlert(alert,options){watchNotifyCalls++;return {status:'sent',attempted:true,alert,options};}
  };
  const multiAnalystRadar={
    enqueueRadarReview(symbol,options){
      calls.push({symbol,options});
      return {queued:true,already_queued:false,pending_count:calls.length};
    }
  };
  const installed=connectRadarAlertsToAnalysts({
    pushManager,multiAnalystRadar,logger:{info:x=>logs.push(x),warn:x=>logs.push(x)},
    clock:()=>1_800_000_500_000,
    decisionRecorder:(alert,gate,options)=>decisions.push({alert,gate,options})
  });
  assert.equal(installed.installed,true);
  const alert={
    symbol:'QUIETBASEUSDT',radar:'EARLY_EXPANSION_RADAR',
    event:'QUIET_BASE_PRE_EXPANSION_WATCH_ONLY',decision_band:'WATCH_EARLY',
    watch_only:true,entry_eligible:false,data_quality:92,liquidity_quality:81
  };
  const response=await pushManager.notifyRadarWatchOnlyAlert(alert,{trace:'kept'});
  assert.equal(response.status,'sent');
  assert.equal(response.alert,alert);
  assert.deepEqual(response.options,{trace:'kept'});
  assert.equal(regularNotifyCalls,0);
  assert.equal(watchNotifyCalls,1);
  assert.equal(calls.length,1);
  assert.equal(calls[0].symbol,'QUIETBASEUSDT');
  assert.equal(calls[0].options.sourceRadar,'EARLY_EXPANSION_RADAR');
  assert.equal(calls[0].options.watchOnly,true);
  assert.equal(calls[0].options.stage,'WATCH_EARLY');
  assert.equal(decisions.length,1);
  assert.equal(decisions[0].gate.eligible,false);
  assert.equal(decisions[0].gate.accepted_mode,'WATCH_ONLY_REVIEW_PENDING');
  assert.deepEqual(decisions[0].gate.soft_failures,['WATCH_ONLY_NOT_ENTRY_ELIGIBLE','MULTI_ANALYST_REVIEW_QUEUED']);
  assert.equal(JSON.stringify(logs).includes('RADAR_ANALYST_WATCH_REVIEW_QUEUED'),true);
});

test('watch-only review bridge accepts watch observations from all twelve radar roles',async()=>{
  const radarRoles=[
    'EARLY_MOVE_RADAR','STRONG_MOVE_RADAR','ROTATION_LAG_RADAR',
    'LIQUIDITY_ABSORPTION_RADAR','KAHIR_RADAR','DOOMSDAY_RADAR',
    'PROFESSOR_RADAR','ALMUQAWIM_RADAR','EARLY_EXPANSION_RADAR',
    'COIN_HUNTER_RADAR','WHALE_ACCUMULATION_RADAR','FALCON_EYE_RADAR'
  ];
  const queued=[],decisions=[],delivered=[];
  const pushManager={
    async notifyRadarAlert(){throw new Error('WATCH_ONLY_MUST_NOT_USE_ACTIONABLE_NOTIFY');},
    async notifyRadarWatchOnlyAlert(alert){delivered.push(alert);return {status:'sent',attempted:true};}
  };
  const multiAnalystRadar={
    enqueueRadarReview(symbol,options){
      queued.push({symbol,options});
      return {queued:true,already_queued:false,pending_count:queued.length};
    }
  };
  const installed=connectRadarAlertsToAnalysts({
    pushManager,multiAnalystRadar,logger:{info(){},warn(){}},
    clock:()=>1_800_000_600_000,
    decisionRecorder:(alert,gate,options)=>decisions.push({alert,gate,options})
  });
  assert.equal(installed.installed,true);
  for(let i=0;i<radarRoles.length;i++){
    const alert={
      symbol:'WATCH'+String(i).padStart(2,'0')+'USDT',
      radar:radarRoles[i],event:'RADAR_WATCH_ONLY',decision_band:'WATCH_EARLY',
      watch_only:true,entry_eligible:false
    };
    const response=await pushManager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(response.status,'sent');
    assert.equal(response.attempted,true);
  }
  assert.equal(delivered.length,12);
  assert.equal(queued.length,12);
  assert.equal(decisions.length,12);
  for(let i=0;i<radarRoles.length;i++){
    assert.equal(queued[i].symbol,'WATCH'+String(i).padStart(2,'0')+'USDT');
    assert.equal(queued[i].options.sourceRadar,radarRoles[i]);
    assert.equal(queued[i].options.watchOnly,true);
    assert.equal(decisions[i].gate.eligible,false);
    assert.equal(decisions[i].gate.accepted_mode,'WATCH_ONLY_REVIEW_PENDING');
    assert.equal(decisions[i].alert.entry_eligible,false);
  }
});


test('all numeric radar aliases resolve to their canonical profile',()=>{
  const aliases={
    RADAR1:'EARLY_MOVE_RADAR',RADAR_1:'EARLY_MOVE_RADAR',
    RADAR2:'STRONG_MOVE_RADAR',RADAR_2:'STRONG_MOVE_RADAR',
    RADAR3:'ROTATION_LAG_RADAR',RADAR_3:'ROTATION_LAG_RADAR',
    RADAR4:'LIQUIDITY_ABSORPTION_RADAR',RADAR_4:'LIQUIDITY_ABSORPTION_RADAR',
    RADAR5:'KAHIR_RADAR',RADAR_5:'KAHIR_RADAR',
    RADAR6:'DOOMSDAY_RADAR',RADAR_6:'DOOMSDAY_RADAR',
    RADAR7:'ALMUQAWIM_RADAR',RADAR_7:'ALMUQAWIM_RADAR',
    RADAR8:'EARLY_EXPANSION_RADAR',RADAR_8:'EARLY_EXPANSION_RADAR',
    RADAR9:'FALCON_EYE_RADAR',RADAR_9:'FALCON_EYE_RADAR',RADAR9_FALCON_EYE:'FALCON_EYE_RADAR',
    RADAR10:'COIN_HUNTER_RADAR',RADAR_10:'COIN_HUNTER_RADAR',RADAR10_COIN_HUNTER:'COIN_HUNTER_RADAR',
    RADAR11:'WHALE_ACCUMULATION_RADAR',RADAR_11:'WHALE_ACCUMULATION_RADAR',RADAR11_WHALE:'WHALE_ACCUMULATION_RADAR',
    RADAR12:'PROFESSOR_RADAR',RADAR_12:'PROFESSOR_RADAR',RADAR12_PROFESSOR:'PROFESSOR_RADAR'
  };
  for(const [alias,canonical] of Object.entries(aliases)){
    const event={symbol:'ALIASTESTUSDT',radar:alias,direction:'UP',data_quality:90,liquidity_quality:90};
    const gate=evaluateRadarNotificationGate(event,{now:NOW,commit:false});
    assert.equal(gate.radar,canonical,alias);
    assert.ok(!gate.failures.includes('RADAR_PROFILE_MISSING'),alias);
  }
});
