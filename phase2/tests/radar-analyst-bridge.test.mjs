import assert from 'node:assert/strict';
import {connectRadarAlertsToAnalysts} from '../core/radar-analyst-bridge.mjs';

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
  assert.equal(decisions[0].gate.eligible,true);
  assert.equal(decisions[0].gate.accepted_mode,'RADAR_ALERT_EMITTED_REVIEW_PENDING');
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

console.log('radar analyst bridge fails open and validates symbol: PASS');
test('non-blocking bridge attaches a meaningful early lifecycle without changing delivery eligibility',async()=>{
  const decisions=[],alerts=[];
  const pushManager={async notifyRadarAlert(alert){alerts.push(alert);return {status:'delivered'};}};
  const multiAnalystRadar={enqueueRadarReview(){return {queued:true,already_queued:false,pending_count:1};}};
  const installed=connectRadarAlertsToAnalysts({pushManager,multiAnalystRadar,logger:{info(){},warn(){}},clock:()=>NOW_TEST,
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
