import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateDynamicEarlyWarningGate} from '../core/dynamic-early-warning-gate.mjs';

const NOW=10_000_000_000;
function wLike(overrides={}){
  const alert={
    radar:'STRONG_MOVE_RADAR',symbol:'WUSDT',direction:'UP_MOVE',
    eligible:true,opportunity_score:87.33,price:0.02153,price_change_24h:21.5,
    observed_at:NOW-900,source_event_at:NOW-1000,source_candle_close_at:NOW-1000,
    risk_flags:['24H_ALREADY_EXTENDED','VOLATILITY_EXTREME'],
    strong_move:{
      score:87.33,direction:'UP_MOVE',source_candle_close_at:NOW-1000,
      trigger_diagnostics:{eligible:true,failed_checks:[]},
      metrics:{
        return_1m:2.0863,return_3m:2.3289,acceleration:2.3289,
        volume_ratio:2.063,trade_ratio:1.744,
        taker_buy_ratio:0.7604,three_second_taker_buy_ratio:0.7306,
        three_second_liquidity:{available:true,taker_buy_ratio:0.7306},
        independent_confirmations:9,breakout_up:true,micro_breakout:true
      }
    },
    ...overrides
  };
  return alert;
}
const row={priceChange24h:21.5,quoteVolume24h:8_000_000,minQuoteVolume24h:1_000_000};

test('W-like high-evidence ignition qualifies as an informational early warning despite extension-only strict vetoes',()=>{
  const alert=wLike();
  const result=evaluateDynamicEarlyWarningGate(alert,row,{
    now:NOW,alertScore:87.33,minQuoteVolume24h:1_000_000,
    strictFailures:['SCORE_BELOW_STRICT_THRESHOLD','RISK:24H_ALREADY_EXTENDED','RISK:ADVANCED_CHASE_RISK','RISK:ALREADY_EXTENDED_24H','ELITE_GATE_NOT_ELIGIBLE']
  });
  assert.equal(result.eligible,true,JSON.stringify(result.failures));
  assert.equal(result.mode,'DYNAMIC_EARLY_WARNING');
  assert.equal(result.alert_class,'PRE_EXPANSION_WATCH');
  assert.equal(result.flow_evidence.three_second_bucket_available,true);
  assert.ok(result.soft_failures.includes('RISK:ADVANCED_CHASE_RISK'));
  assert.ok(result.score>=result.min_score);
});

test('very strong long-window buy flow may emit only a watch when the completed 3-second bucket is unavailable',()=>{
  const alert=wLike({
    eligible:false,
    risk_flags:['THREE_SECOND_FLOW_UNAVAILABLE','VOLATILITY_EXTREME'],
    strong_move:{
      ...wLike().strong_move,score:86.87,
      trigger_diagnostics:{eligible:false,failed_checks:['THREE_SECOND_TAKER_BUY_RATIO_GT_70_PERCENT']},
      metrics:{
        return_1m:0.6650,return_3m:0.6484,acceleration:0.3342,
        volume_ratio:43.5548,trade_ratio:11.0909,
        taker_buy_ratio:0.9315,three_second_taker_buy_ratio:null,
        three_second_liquidity:{available:false,taker_buy_ratio:null},
        independent_confirmations:8,breakout_up:true,micro_breakout:true
      }
    }
  });
  const result=evaluateDynamicEarlyWarningGate(alert,{...row,priceChange24h:0.39},{
    now:NOW,alertScore:86.87,minQuoteVolume24h:1_000_000,
    strictFailures:['BASE_ALERT_NOT_ELIGIBLE'],
    coreTriggerFailures:['THREE_SECOND_TAKER_BUY_RATIO_GT_70_PERCENT']
  });
  assert.equal(result.eligible,true,JSON.stringify(result.failures));
  assert.equal(result.fallback_3s_flow,true);
  assert.ok(result.soft_failures.includes('STRICT_CORE_MISSING_COMPLETED_3S_BUCKET_HIGHER_FLOW_EVIDENCE_USED'));
  assert.equal(result.flow_evidence.three_second_bucket_available,false);
});

test('exceptional historical flow can pass the watch-only fallback when the caller has no dedicated missing-3s failure code',()=>{
  const alert=wLike({
    eligible:false,
    risk_flags:['THREE_SECOND_FLOW_UNAVAILABLE','VOLATILITY_EXTREME'],
    strong_move:{
      ...wLike().strong_move,score:86.87,
      trigger_diagnostics:{eligible:false,failed_checks:[]},
      metrics:{
        return_1m:0.6650,return_3m:0.6484,acceleration:0.3342,
        volume_ratio:43.5548,trade_ratio:11.0909,
        taker_buy_ratio:0.9315,three_second_taker_buy_ratio:null,
        three_second_liquidity:{available:false,taker_buy_ratio:null},
        independent_confirmations:8,breakout_up:true,micro_breakout:true
      }
    }
  });
  const result=evaluateDynamicEarlyWarningGate(alert,{...row,priceChange24h:0.39},{
    now:NOW,alertScore:86.87,minQuoteVolume24h:1_000_000,
    strictFailures:['STRONG_MOVE_CORE_GATE_FAILED','ELITE_GATE_NOT_ELIGIBLE'],
    coreTriggerFailures:[]
  });
  assert.equal(result.eligible,true,JSON.stringify(result.failures));
  assert.equal(result.fallback_3s_flow,true);
  assert.ok(result.soft_failures.includes('STRICT_CORE_GATE_FAILED_EXCEPTIONAL_FLOW_WATCH_ONLY'));
  assert.equal(result.flow_evidence.three_second_bucket_available,false);
  assert.equal(result.alert_class,'PRE_EXPANSION_WATCH');
});

test('ordinary low-baseline confluence is withheld unless flow, volume and trade participation are exceptional',()=>{
  const alert=wLike({
    price_change_24h:3.37,
    risk_flags:['VOLATILITY_EXTREME'],
    strong_move:{
      ...wLike().strong_move,score:87.2,
      metrics:{
        ...wLike().strong_move.metrics,
        return_1m:0.9955,return_3m:1.9488,acceleration:1.4592,
        volume_ratio:1.8822,trade_ratio:2.1507,taker_buy_ratio:0.7611,
        three_second_taker_buy_ratio:1,
        three_second_liquidity:{available:true,taker_buy_ratio:1},
        independent_confirmations:9,breakout_up:true,micro_breakout:true
      }
    }
  });
  const result=evaluateDynamicEarlyWarningGate(alert,{...row,priceChange24h:3.37},{
    now:NOW,alertScore:87.2
  });
  assert.equal(result.eligible,false);
  assert.ok(result.failures.includes('EARLY_WARNING_LOW_BASELINE_MOVE_REQUIRES_EXCEPTIONAL_EVIDENCE'));
});

test('borderline missing-3s fallback is rejected; only exceptional long-flow evidence can replace that bucket',()=>{
  const alert=wLike({
    price_change_24h:10.09,
    eligible:false,
    risk_flags:['THREE_SECOND_FLOW_UNAVAILABLE','VOLATILITY_EXTREME'],
    strong_move:{
      ...wLike().strong_move,score:88.3,
      trigger_diagnostics:{eligible:false,failed_checks:['THREE_SECOND_TAKER_BUY_RATIO_GT_70_PERCENT']},
      metrics:{
        ...wLike().strong_move.metrics,
        return_1m:1.3741,return_3m:1.7384,acceleration:1.816,
        volume_ratio:2.0306,trade_ratio:2.4018,taker_buy_ratio:0.9139,
        three_second_taker_buy_ratio:null,
        three_second_liquidity:{available:false,taker_buy_ratio:null},
        independent_confirmations:8,breakout_up:true,micro_breakout:true
      }
    }
  });
  const result=evaluateDynamicEarlyWarningGate(alert,{...row,priceChange24h:10.09},{
    now:NOW,alertScore:88.3,
    strictFailures:['BASE_ALERT_NOT_ELIGIBLE'],
    coreTriggerFailures:['THREE_SECOND_TAKER_BUY_RATIO_GT_70_PERCENT']
  });
  assert.equal(result.eligible,false);
  assert.equal(result.fallback_3s_flow,false);
  assert.ok(result.failures.includes('EARLY_WARNING_CORE_GATE_FAILED'));
  assert.ok(result.failures.includes('EARLY_WARNING_LOW_BASELINE_MOVE_REQUIRES_EXCEPTIONAL_EVIDENCE'));
});

test('weak or absent buyer flow cannot pass the early-warning lane',()=>{
  const alert=wLike();
  alert.strong_move.metrics.taker_buy_ratio=0.69;
  alert.strong_move.metrics.three_second_taker_buy_ratio=0.82;
  alert.strong_move.metrics.three_second_liquidity={available:true,taker_buy_ratio:0.82};
  const result=evaluateDynamicEarlyWarningGate(alert,row,{now:NOW,alertScore:87.33});
  assert.equal(result.eligible,false);
  assert.ok(result.failures.includes('EARLY_WARNING_BUY_FLOW_NOT_CONFIRMED'));
});

test('the smart lane rejects stale source candles, very large 24h extension and conflicting/downward evidence',()=>{
  const stale=wLike();
  stale.source_candle_close_at=NOW-120_000;
  stale.source_event_at=NOW-120_000;
  stale.strong_move.source_candle_close_at=NOW-120_000;
  const staleResult=evaluateDynamicEarlyWarningGate(stale,row,{now:NOW,alertScore:87.33});
  assert.equal(staleResult.eligible,false);
  assert.ok(staleResult.failures.includes('EARLY_WARNING_SOURCE_CANDLE_STALE'));

  const extended=wLike({price_change_24h:42});
  const extendedResult=evaluateDynamicEarlyWarningGate(extended,{...row,priceChange24h:42},{now:NOW,alertScore:87.33});
  assert.equal(extendedResult.eligible,false);
  assert.ok(extendedResult.failures.includes('EARLY_WARNING_24H_EXTENSION_TOO_LARGE'));

  const downward=wLike({direction:'DOWN_MOVE'});
  downward.strong_move.direction='DOWN_MOVE';
  const downResult=evaluateDynamicEarlyWarningGate(downward,row,{now:NOW,alertScore:87.33});
  assert.equal(downResult.eligible,false);
  assert.ok(downResult.failures.includes('EARLY_WARNING_DIRECTION_NOT_UP'));
});

test('strict vetoes unrelated to extension remain hard blockers',()=>{
  const alert=wLike();
  const result=evaluateDynamicEarlyWarningGate(alert,row,{
    now:NOW,alertScore:87.33,strictFailures:['CROSS_RADAR_COOLDOWN']
  });
  assert.equal(result.eligible,false);
  assert.ok(result.failures.includes('EARLY_WARNING_STRICT_BLOCKER:CROSS_RADAR_COOLDOWN'));
});

test('the 30-minute same-symbol early-warning cooldown prevents duplicate watches',()=>{
  const result=evaluateDynamicEarlyWarningGate(wLike(),row,{
    now:NOW,alertScore:87.33,lastAlertAt:NOW-5*60_000
  });
  assert.equal(result.eligible,false);
  assert.ok(result.failures.includes('EARLY_WARNING_SYMBOL_COOLDOWN'));
});
