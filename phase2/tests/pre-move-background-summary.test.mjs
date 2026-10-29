import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPreMoveBackgroundScanSummary} from '../core/pre-move-background-summary.mjs';
import {buildPreMoveNotificationDeliveryState} from '../core/pre-move-background-summary.mjs';

test('background summary exposes bounded near misses and the most common blockers',()=>{
  const snapshot={
    universe:{
      discovered:50,deep_scanned:50,scanned:46,valid_data:42,observed_candle_data:48,
      watch_only:8,actionable:0,returned:0,elapsed_ms:44123,
      eligible_spot_symbols:226,coverage_mode:'PINNED_PLUS_ROTATING_V1',rotation_cycle:5,rotation_offset:175,
      rotation_width:33,rotation_cursor_source:'DURABLE_STORE',rotation_cursor_persisted:true,
      ticker_activity_signal_count:3,ticker_activity_baseline_source:'DURABLE_STORE',
      ticker_activity_baseline_persisted:true,ticker_activity_baseline_error:null
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
  assert.equal(summary.rotation_width,33);
  assert.equal(summary.rotation_cursor_source,'DURABLE_STORE');
  assert.equal(summary.rotation_cursor_persisted,true);
  assert.equal(summary.ticker_activity_signal_count,3);
  assert.equal(summary.ticker_activity_baseline_source,'DURABLE_STORE');
  assert.equal(summary.ticker_activity_baseline_persisted,true);
  assert.equal(summary.ticker_activity_baseline_error,null);
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
  assert.equal(summary.ticker_activity_signal_count,null,
    'missing activity telemetry must stay unknown rather than being misreported as zero');
  assert.equal(summary.ticker_activity_baseline_source,'UNAVAILABLE');
  assert.equal(summary.ticker_activity_baseline_persisted,null);
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


test('notification delivery history distinguishes scan eligibility from actual push delivery',()=>{
  let state=buildPreMoveNotificationDeliveryState(null,{
    symbol:'TRXUSDT',status:'NO_SUBSCRIPTIONS',reason:'NO_PUSH_SUBSCRIPTIONS',
    attempted:false,sent_count:0,attempted_count:0
  },1793101620000);
  assert.equal(state.results,1);
  assert.equal(state.send_calls,0);
  assert.equal(state.notifications_sent,0);
  assert.equal(state.current_status,'NO_SUBSCRIPTIONS');
  assert.equal(state.current_reason,'NO_PUSH_SUBSCRIPTIONS');

  state=buildPreMoveNotificationDeliveryState(state,{
    symbol:'NEARUSDT',status:'SENT',reason:null,
    attempted:true,sent_count:1,attempted_count:1
  },1793101680000);
  assert.equal(state.results,2);
  assert.equal(state.send_calls,1);
  assert.equal(state.recipients_attempted,1);
  assert.equal(state.notifications_sent,1);
  assert.equal(state.current_status,'SENT');
  assert.equal(state.status_counts.NO_SUBSCRIPTIONS,1);
  assert.equal(state.status_counts.SENT,1);
  assert.equal(state.last_results.length,2);
  assert.equal(state.last_results[0].symbol,'NEARUSDT');
  assert.equal(state.last_results[1].symbol,'TRXUSDT');

  state=buildPreMoveNotificationDeliveryState(state,{
    symbol:'HUMAUSDT',status:'FAILED',reason:'FCM_UNAVAILABLE',
    attempted:true,sent_count:0,attempted_count:1
  },1793101740000);
  assert.equal(state.send_calls,2);
  assert.equal(state.recipients_attempted,2);
  assert.equal(state.notifications_sent,1);
  assert.equal(state.current_status,'FAILED');
  assert.equal(state.reason_counts.FCM_UNAVAILABLE,1);
});

test('notification delivery history bounds retained records and sanitizes unknown values',()=>{
  let state=null;
  for(let i=0;i<15;i++){
    state=buildPreMoveNotificationDeliveryState(state,{
      symbol:'C'+i+'USDT',status:i%2?'SENT':'NO_ELIGIBLE_SUBSCRIPTIONS',
      reason:i%2?null:'USER_SETTINGS_OR_QUALITY_FILTER',
      attempted:i%2===1,sent_count:i%2?1:0,attempted_count:i%2?1:0
    },1793101800000+i*1000);
  }
  assert.equal(state.results,15);
  assert.equal(state.notifications_sent,7);
  assert.equal(state.send_calls,7);
  assert.equal(state.last_results.length,10);
  assert.equal(state.last_results[0].symbol,'C14USDT');
  assert.equal(state.last_results.at(-1).symbol,'C5USDT');
  const next=buildPreMoveNotificationDeliveryState(state,{
    symbol:'BTCUSDT',status:'DELIVERY_PROMISE_REJECTED',reason:'PUSH_RESULT_PROMISE_REJECTED',
    attempted:false,sent_count:0,attempted_count:0,error:'network unavailable'
  },1793101900000);
  assert.equal(next.results,16);
  assert.equal(next.current_status,'DELIVERY_PROMISE_REJECTED');
  assert.equal(next.last_results[0].error,'network unavailable');
  assert.equal(next.last_results.length,10);
});
