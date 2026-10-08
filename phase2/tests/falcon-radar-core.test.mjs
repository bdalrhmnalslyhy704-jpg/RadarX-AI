import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFalconEye} from '../core/radar-falcon-core.mjs';
import {evaluateRadarNotificationGate,resetRadarNotificationGateForTests} from '../core/radar-notification-gate.mjs';

function earlyAlert(overrides={}){
  return {
    radar:'EARLY_EXPANSION_RADAR',
    symbol:'TESTUSDT',
    processed_at:Date.now(),
    data_quality:92,
    liquidity_quality:84,
    price_change_24h:2.1,
    opportunity_score:79,
    setup_score:80,
    reasons:['compression','acceleration','flow','structure','relative strength','participation'],
    reason_codes:['COMPRESSION_BUILDING','ACCELERATION_DETECTED','BUYING_PRESSURE_CONFIRMED'],
    components:{
      structure_score:78,
      flow_score:82,
      momentum_score:84,
      compression_score:88,
      relative_score:76,
      trigger_score:74,
      participation_score:80,
      volume_score:84,
      buying_pressure:82,
      orderbook_pressure:79
    },
    pre_breakout_fingerprint:{
      score:84,
      lead_edge:88,
      anti_chase_score:91,
      acceleration_score:82,
      participation_score:81,
      pressure_score:83,
      structure_score:80,
      relative_strength_score:75,
      compression_score:89,
      ready:true,
      confirmed:true,
      late:false,
      micro_move:false
    },
    eligible:true,
    ...overrides
  };
}

test('Falcon Eye identifies a high-quality early stalking setup',()=>{
  const alert=earlyAlert();
  const f=evaluateFalconEye(alert);
  assert.equal(f.hard_fail,false);
  assert.ok(f.capture>=78);
  assert.ok(f.quality>=72);
  assert.ok(f.early_window);
  assert.ok(f.independent_domains>=4);
  assert.ok(['FALCON_LOCK','FALCON_STALK','CONFIRMED','VALIDATED'].includes(f.stage));
});

test('Falcon Eye hard-fails stale/future data',()=>{
  const alert=earlyAlert({processed_at:Date.now()-2*60*60*1000,data_status:{stale:true}});
  const f=evaluateFalconEye(alert);
  assert.equal(f.hard_fail,true);
  assert.equal(f.stage,'REJECT');
  assert.equal(f.decision,'REJECT');
});

test('Notification gate has an early Falcon corridor without weakening hard safety gates',()=>{
  resetRadarNotificationGateForTests();
  const r=evaluateRadarNotificationGate(earlyAlert(),{commit:false});
  assert.equal(r.eligible,true);
  assert.equal(r.mode,'FALCON_EARLY_TRACK');
  assert.equal(r.falcon_eye.early_window,true);
  assert.ok(r.falcon_eye.capture>=78);
});
