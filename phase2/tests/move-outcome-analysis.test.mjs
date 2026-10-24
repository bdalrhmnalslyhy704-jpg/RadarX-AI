import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMoveOutcomeAnalysis,summarizeMoveOutcomeAnalyses} from '../core/move-outcome-analysis.mjs';

const MIN=60_000;
function step(timestamp,{decision='REJECTED',mode='NONE',upside=0,drawdown=-0.2,terminal=0,failures=['BUY_FLOW_NOT_CONFIRMED']}={}){
  return {
    timestamp,timestamp_iso:new Date(timestamp).toISOString(),decision,accepted_mode:mode,score:decision==='ACCEPTED'?86:67,
    rejection_group:decision==='ACCEPTED'?'ACCEPTED':'NOTIFICATION_GATE',
    reason_codes:decision==='REJECTED'?failures:[],
    strict_gate_failures:decision==='REJECTED'?failures:[],
    core_trigger_diagnostics:{failed_checks:decision==='REJECTED'?failures:[]},
    notification_gate:{eligible:decision==='ACCEPTED',failures:decision==='REJECTED'?failures:[]},
    elite_gate:{eligible:decision==='ACCEPTED',score:decision==='ACCEPTED'?86:70,
      failures:decision==='REJECTED'?['CATEGORY_DIVERSITY_LOW']:[],risk_flags:[]},
    market_evidence:{data_quality:82,liquidity_quality:74,spread_bps:4.5,relative_strength_vs_market_pct:0.6},
    signal_metrics:{volume_ratio:1.4,trade_ratio:1.3,taker_buy_ratio_1m_3m:0.56,acceleration:0.12,micro_breakout:false},
    risk_flags:[],
    outcome:{horizon_observed:true,horizon_ms:24*60*MIN,
      forward_max_upside_pct_from_decision:upside,
      forward_max_drawdown_pct_from_decision:drawdown,
      forward_return_pct_at_horizon:terminal}
  };
}
function replay({symbol='TESTUSDT',steps,move5=120*MIN,move15=180*MIN,complete=true,tradeCoverage=true}={}){
  return {
    symbol,steps,
    data_quality:{candle_fetch_complete:complete,outcome_candle_fetch_complete:complete,
      synthetic_data_used:false,trade_coverage_complete:tradeCoverage,
      replay_mode:complete?(tradeCoverage?'FULL_TRADE':'CANDLE_ONLY_FALLBACK'):'BLOCKED_INCOMPLETE'},
    summary:{first_actual_window_5pct_at:move5,first_actual_window_15pct_at:move15,
      first_actual_window_5pct_candle_close_at:move5,first_actual_window_15pct_candle_close_at:move15}
  };
}

test('labels early detections and reports lead time, run-up, and adverse excursion',()=>{
  const source=replay({steps:[step(60*MIN,{decision:'ACCEPTED',mode:'DYNAMIC_EARLY_WARNING',upside:12.5,drawdown:-2.1,terminal:8})]});
  const x=buildMoveOutcomeAnalysis(source);
  assert.equal(x.moderate_move.classification,'EARLY_DETECTION_BEFORE_PLUS_5_PERCENT');
  assert.equal(x.moderate_move.minutes_before_move,60);
  assert.equal(x.strong_move.classification,'EARLY_DETECTION_BEFORE_PLUS_15_PERCENT');
  assert.equal(x.strong_move.minutes_before_move,120);
  assert.equal(x.moderate_move.first_early_detection.forward_max_upside_pct,12.5);
  assert.equal(x.moderate_move.first_early_detection.forward_max_drawdown_pct,-2.1);
  assert.equal(x.observation.trade_coverage_complete,true);
  assert.equal(x.observation.replay_mode,'FULL_TRADE');
});

test('labels a missed move and retains the last rejection reasons before the move',()=>{
  const source=replay({steps:[
    step(90*MIN,{failures:['VOLUME_ACCELERATION_NOT_CONFIRMED','BUY_FLOW_NOT_CONFIRMED']}),
    step(119*MIN,{failures:['RESISTANCE_RECLAIM_NOT_CONFIRMED']})
  ]});
  const x=buildMoveOutcomeAnalysis(source);
  assert.equal(x.moderate_move.classification,'MISSED_PLUS_5_PERCENT_MOVE');
  assert.equal(x.moderate_move.missed_move.last_rejection_before_move.at,119*MIN);
  assert.ok(x.moderate_move.missed_move.last_rejection_before_move.failed_checks.includes('RESISTANCE_RECLAIM_NOT_CONFIRMED'));
  assert.equal(x.moderate_move.missed_move.last_rejection_before_move.market_evidence.liquidity_quality,74);
  assert.equal(x.moderate_move.missed_move.last_rejection_before_move.signal_metrics.taker_buy_ratio_1m_3m,0.56);
  assert.ok(x.moderate_move.missed_move.last_rejection_before_move.gate_failure_layers.elite_confluence.failures.includes('CATEGORY_DIVERSITY_LOW'));
  assert.ok(x.missed_move_failure_codes.includes('RESISTANCE_RECLAIM_NOT_CONFIRMED'));
  assert.equal(x.strong_move.classification,'MISSED_PLUS_15_PERCENT_MOVE');
});

test('accepted alert after the move is marked late, not early',()=>{
  const source=replay({steps:[
    step(119*MIN,{failures:['STRICT_SCORE_BELOW_THRESHOLD']}),
    step(125*MIN,{decision:'ACCEPTED',mode:'STRICT',upside:1.5,drawdown:-2,terminal:-1})
  ]});
  const x=buildMoveOutcomeAnalysis(source);
  assert.equal(x.moderate_move.classification,'LATE_DETECTION_AFTER_PLUS_5_PERCENT');
  assert.equal(x.moderate_move.detected_early,false);
  assert.equal(x.moderate_move.missed_move.classification,'LATE_DETECTION_AFTER_PLUS_5_PERCENT');
});

test('matured candidate shadows report weak follow-through separately from actual alert outcomes',()=>{
  const decision=step(60*MIN,{decision:'REJECTED',failures:['CANDIDATE_SHADOW_NOT_A_PUSH']});
  decision.candidate_detected=true;
  decision.candidate_mode='RADAR8_PREMOVE_SHADOW_CANDIDATE_SHADOW';
  decision.outcome={
    horizon_observed:true,horizon_ms:24*60*MIN,
    forward_max_upside_pct_from_decision:3.2,
    forward_max_drawdown_pct_from_decision:-1.8,
    forward_return_pct_at_horizon:-1.1
  };
  const x=buildMoveOutcomeAnalysis(replay({move5:null,move15:null,steps:[decision]}));
  assert.equal(x.observation.accepted,0);
  assert.equal(x.candidate_detection.candidate_count,1);
  assert.equal(x.candidate_detection.candidate_with_matured_outcomes,1);
  assert.equal(x.candidate_detection.low_follow_through_candidate_count,1);
  assert.equal(x.candidate_detection.low_follow_through_candidate_rate_pct,100);
  assert.equal(x.candidate_detection.low_follow_through_candidates[0].not_a_notification,true);
  assert.equal(x.summary.low_follow_through_candidate_count,1);
  const summary=summarizeMoveOutcomeAnalyses([x]);
  assert.equal(summary.matured_candidate_detections,1);
  assert.equal(summary.low_follow_through_candidate_count,1);
  assert.equal(summary.low_follow_through_candidate_rate_pct,100);
});

test('low-follow-through accepted decisions are called out only after the outcome horizon matures',()=>{
  const mature=replay({move5:null,move15:null,steps:[
    step(60*MIN,{decision:'ACCEPTED',mode:'STRICT',upside:3.2,drawdown:-1.8,terminal:-1.1})
  ]});
  const x=buildMoveOutcomeAnalysis(mature);
  assert.equal(x.low_follow_through_acceptances.length,1);
  assert.equal(x.low_follow_through_acceptances[0].classification,'LOW_FOLLOW_THROUGH_OR_ADVERSE_MOVE');
  const immature=replay({move5:null,move15:null,steps:[
    {...step(60*MIN,{decision:'ACCEPTED',mode:'STRICT',upside:1,drawdown:-2,terminal:-1}),outcome:{...step(60*MIN).outcome,horizon_observed:false}}
  ]});
  assert.equal(buildMoveOutcomeAnalysis(immature).low_follow_through_acceptances.length,0);
});

test('incomplete or synthetic replay coverage is not counted as a missed move or hit-rate denominator',()=>{
  const bad=replay({symbol:'BADUSDT',complete:false,tradeCoverage:false,steps:[step(60*MIN)]});
  const x=buildMoveOutcomeAnalysis(bad);
  assert.equal(x.observation.candle_coverage_complete,false);
  assert.equal(x.moderate_move.classification,'INCOMPLETE_MARKET_DATA');
  assert.equal(x.moderate_move.missed_move,null);
  const report=summarizeMoveOutcomeAnalyses([
    buildMoveOutcomeAnalysis(replay({symbol:'EARLYUSDT',steps:[step(60*MIN,{decision:'ACCEPTED',mode:'STRICT',upside:10,drawdown:-2,terminal:5})]})),
    x
  ]);
  assert.equal(report.symbols_requested,2);
  assert.equal(report.candle_coverage_complete_symbols,1);
  assert.equal(report.coverage_incomplete_symbols,1);
  assert.equal(report.moderate_moves_observed,1);
  assert.equal(report.early_detections_before_5pct,1);
  assert.equal(report.early_5pct_detection_rate_pct,100);
});
