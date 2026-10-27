import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPreMoveBackgroundScanSummary} from '../core/pre-move-background-summary.mjs';

test('background summary exposes bounded near misses and the most common blockers',()=>{
  const snapshot={
    universe:{
      discovered:50,deep_scanned:50,scanned:46,valid_data:42,observed_candle_data:48,
      watch_only:8,actionable:0,returned:0,elapsed_ms:44123,
      eligible_spot_symbols:226,coverage_mode:'PINNED_PLUS_ROTATING_V1',rotation_cycle:5,rotation_offset:175
    },
    watch_notification_diagnostics:{
      evaluated:8,eligible:0,rejected:8,
      rejection_counts:{SCORE_BELOW_WATCH_FLOOR:4,BUY_FLOW_NOT_CONFIRMED:3},
      samples:[
        {symbol:'AAAUSDT',eligible:false,reason:'SCORE_BELOW_WATCH_FLOOR',score:67.5,
          session_return_pct:1.4,one_hour_return_pct:0.4,data_valid:true,data_stale:false,
          data_quality:95,liquidity_quality:83},
        {symbol:'BBBUSDT',eligible:false,reason:'LOW_LIQUIDITY',score:null,
          session_return_pct:null,one_hour_return_pct:null,data_valid:false,data_stale:true,
          data_quality:null,liquidity_quality:null}
      ]
    },
    near_miss_audit:[
      {symbol:'AAAUSDT',stage:'EARLY_WAKE',score:77.1,session_return_pct:2.3,one_hour_return_pct:0.8,
        volume_acceleration:1.7,trade_acceleration:1.4,data_valid:true,liquidity_quality:85,
        blocker_codes:['BUY_FLOW_NOT_CONFIRMED','BUY_FLOW_NOT_CONFIRMED','TARGET_RISK_REWARD_NOT_CONFIRMED']},
      {symbol:'BBBUSDT',stage:'QUIET_BUILD',score:70,session_return_pct:1.1,one_hour_return_pct:0.3,
        volume_acceleration:1.3,trade_acceleration:1.2,data_valid:false,liquidity_quality:null,
        blocker_codes:['DATA_OR_LIQUIDITY_GATE_NOT_PASSED','BUY_FLOW_NOT_CONFIRMED']},
      ...Array.from({length:8},(_,i)=>({symbol:'C'+String(i).padStart(2,'0')+'USDT',blocker_codes:['BUY_FLOW_NOT_CONFIRMED']}))
    ]
  };
  const summary=buildPreMoveBackgroundScanSummary({snapshot,watchAlerts:[],elapsedMs:50000});
  assert.equal(summary.deep_scanned,50);
  assert.equal(summary.near_miss_review_count,10);
  assert.equal(summary.near_miss_samples.length,5);
  assert.equal(summary.near_miss_samples[0].symbol,'AAAUSDT');
  assert.equal(summary.near_miss_samples[0].score,77.1);
  assert.deepEqual(summary.near_miss_samples[0].blocker_codes,
    ['BUY_FLOW_NOT_CONFIRMED','BUY_FLOW_NOT_CONFIRMED','TARGET_RISK_REWARD_NOT_CONFIRMED']);
  assert.equal(summary.near_miss_blocker_counts.BUY_FLOW_NOT_CONFIRMED,11);
  assert.equal(summary.near_miss_blocker_counts.DATA_OR_LIQUIDITY_GATE_NOT_PASSED,1);
  assert.equal(summary.watch_notification_evaluated,8);
  assert.equal(summary.watch_notification_eligible,0);
  assert.equal(summary.watch_notification_rejected,8);
  assert.equal(summary.watch_notification_top_rejections[0].score,67.5);
  assert.equal(summary.watch_notification_top_rejections[1].score,null);
  assert.equal(summary.watch_notification_top_rejections[1].data_quality,null);
});

test('background summary accepts empty or malformed optional diagnostics without inventing measurements',()=>{
  const summary=buildPreMoveBackgroundScanSummary({snapshot:{universe:{elapsed_ms:0}},watchAlerts:null,elapsedMs:123});
  assert.equal(summary.elapsed_ms,123);
  assert.equal(summary.near_miss_review_count,0);
  assert.deepEqual(summary.near_miss_blocker_counts,{});
  assert.deepEqual(summary.near_miss_samples,[]);
  assert.deepEqual(summary.watch_notification_top_rejections,[]);
  assert.equal(summary.watch_notification_eligible,0);
  assert.equal(summary.paper_trading,undefined);
});
