import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRadarNotificationGate,rememberRadarAlert,resetRadarNotificationGateForTests} from '../core/radar-notification-gate.mjs';

function strongAlert(overrides={}){
  return {
    radar:'STRONG_MOVE_RADAR',symbol:'ABCUSDT',opportunity_score:93,data_quality:96,liquidity_quality:90,
    strong_move:{score:93,metrics:{
      flash_confirmations:7,return_3m:0.9,micro_breakout:true,volume_ratio:2.1,trade_ratio:1.7,
      taker_buy_ratio:0.55,taker_buy_delta:0.02,five_min_trend:76,five_min_return:0.5
    }},
    elite_gate:{eligible:true,score:92,confirmations:7,category_hits:6,risk_flags:[]},
    ...overrides
  };
}

test('strict gate accepts only multi-factor confirmed strong move',()=>{
  resetRadarNotificationGateForTests();
  const g=evaluateRadarNotificationGate(strongAlert(),{now:1000});
  assert.equal(g.eligible,true);
  assert.equal(g.failures.length,0);
});

test('strict gate rejects a small/simple movement',()=>{
  resetRadarNotificationGateForTests();
  const g=evaluateRadarNotificationGate(strongAlert({
    opportunity_score:87,
    strong_move:{score:87,metrics:{flash_confirmations:3,return_3m:0.18,micro_breakout:false,volume_ratio:1.05,trade_ratio:1.0,taker_buy_ratio:0.50,taker_buy_delta:0,five_min_trend:52,five_min_return:0.05}},
    elite_gate:{eligible:true,score:84,confirmations:3,category_hits:3,risk_flags:[]}
  }),{now:1000});
  assert.equal(g.eligible,false);
  assert.ok(g.failures.length>=3);
});

test('strict gate blocks extended/chasing candidates',()=>{
  resetRadarNotificationGateForTests();
  const g=evaluateRadarNotificationGate(strongAlert({risk_flags:['ALREADY_EXTENDED_24H']}),{now:1000});
  assert.equal(g.eligible,false);
  assert.ok(g.failures.some(x=>x.includes('RISK:ALREADY_EXTENDED_24H')));
});

test('cross-radar suppression blocks duplicate symbol alerts but allows a materially stronger radar',()=>{
  resetRadarNotificationGateForTests();
  const first=strongAlert({radar:'STRONG_MOVE_RADAR',symbol:'SAMEUSDT',opportunity_score:92,elite_gate:{eligible:true,score:92,confirmations:7,category_hits:6,risk_flags:[]}});
  assert.equal(evaluateRadarNotificationGate(first,{now:1000}).eligible,true);
  rememberRadarAlert(first,1000);
  const duplicate=strongAlert({radar:'ROTATION_LAG_RADAR',symbol:'SAMEUSDT',opportunity_score:91,elite_gate:{eligible:true,score:91,confirmations:8,category_hits:6,risk_flags:[]}});
  assert.equal(evaluateRadarNotificationGate(duplicate,{now:120000}).eligible,false);
  const stronger=strongAlert({radar:'DOOMSDAY_RADAR',symbol:'SAMEUSDT',opportunity_score:101,elite_gate:{eligible:true,score:101,confirmations:9,category_hits:7,risk_flags:[]},doomsday:{confirmation_count:9,ignition_confirmations:9,ignition_score:90}});
  assert.equal(evaluateRadarNotificationGate(stronger,{now:120000}).eligible,true);
});
