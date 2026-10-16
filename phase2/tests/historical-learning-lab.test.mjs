import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHistoricalLearningRow,buildHistoricalLearningDataset,
  evaluateHistoricalLearningMetrics,splitHistoricalLearningRows,
  auditHistoricalMatrixCoverage
} from '../core/historical-learning-lab.mjs';

const MINUTE=60_000;
function row({symbol='TESTUSDT',timestamp=1_800_000_000_000,decision='REJECTED',mode='NONE',move=0,horizon=true,score=90,window='window-a',eventAt=null,probability=null,leak=false,dataMode='FULL_TRADE',rejectionGroup=null}={}){
  return {
    symbol,timestamp,decision,accepted_mode:mode,score,stage_observed:mode.includes('EARLY')?'PRE_EXPANSION':'WATCH',
    window_id:window,market_regime:'BULL_TREND',replay_data_mode:dataMode,rejection_group:rejectionGroup,
    input_max_candle_close_at:timestamp-(leak?-1:1),
    trade_window:{from:timestamp-60_000,to_exclusive:timestamp-1},
    calibrated_probability:probability,
    outcome:{
      is_future_data_for_scoring:false,horizon_ms:24*60*MINUTE,
      horizon_observed:horizon,forward_max_upside_pct_from_decision:move,
      max_adverse_excursion_pct_from_decision:-1.8,
      max_adverse_excursion_before_moderate_target_pct:-0.7,
      minutes_to_moderate_target:move>=5?4:null,
      minutes_to_strong_target:move>=15?9:null,
      actual_window_5pct_candle_close_at:eventAt,
      actual_window_15pct_candle_close_at:null,
      actual_window_5pct_at:null,
      actual_window_5pct_timestamp_source:'UNAVAILABLE_INCOMPLETE_TRADE_COVERAGE'
    }
  };
}

test('historical labels separate successful early setups, failed early setups, false alerts and missed-move decisions',()=>{
  assert.equal(classifyHistoricalLearningRow(row({decision:'ACCEPTED',mode:'EARLY_WARNING',move:8})).outcome_class,'EARLY_SIGNAL_SUCCESS');
  assert.equal(classifyHistoricalLearningRow(row({decision:'ACCEPTED',mode:'EARLY_WARNING',move:1})).outcome_class,'EARLY_SIGNAL_FAILED');
  assert.equal(classifyHistoricalLearningRow(row({decision:'ACCEPTED',mode:'STRICT',move:1})).outcome_class,'FALSE_ALERT');
  assert.equal(classifyHistoricalLearningRow(row({decision:'ACCEPTED',mode:'STRICT',move:18})).outcome_class,'SIGNAL_SUCCESS');
  assert.equal(classifyHistoricalLearningRow(row({decision:'REJECTED',move:18})).outcome_class,'MISSED_MOVE_DECISION');
  assert.equal(classifyHistoricalLearningRow(row({decision:'REJECTED',move:1})).outcome_class,'CORRECT_REJECTION');
  assert.equal(classifyHistoricalLearningRow(row({decision:'ACCEPTED',move:1,horizon:false})).outcome_class,'OUTCOME_UNAVAILABLE');
});

test('future leakage and unproven label isolation are excluded from scored rows',()=>{
  const leaking=classifyHistoricalLearningRow(row({decision:'ACCEPTED',move:50,leak:true}));
  assert.equal(leaking.outcome_class,'DATA_INTEGRITY_REJECTED');
  assert.ok(leaking.integrity_issues.includes('FUTURE_CANDLE_LEAKAGE'));
  const missingIsolation=row({decision:'ACCEPTED',move:50});
  delete missingIsolation.outcome.is_future_data_for_scoring;
  assert.equal(classifyHistoricalLearningRow(missingIsolation).outcome_class,'DATA_INTEGRITY_REJECTED');

  const dataset=buildHistoricalLearningDataset([{window:{start_time:1},results:[{symbol:'TESTUSDT',steps:[row({decision:'ACCEPTED',move:50,leak:true}),row({decision:'ACCEPTED',move:8})]}]}]);
  const metrics=evaluateHistoricalLearningMetrics(dataset);
  assert.equal(metrics.evaluable_decisions,1);
  assert.equal(metrics.successful_alerts,1);
  assert.equal(metrics.calibration.status,'NOT_ESTIMABLE_NO_EXPLICIT_PROBABILITY');
});

test('metrics count lead time and unique missed market events separately from missed decisions',()=>{
  const reports=[{window:{start_time:100},results:[{symbol:'CAPTUREUSDT',steps:[
    row({symbol:'CAPTUREUSDT',timestamp:1_700_000_000_000,decision:'ACCEPTED',mode:'EARLY_WARNING',move:12,eventAt:1_700_000_300_000,window:'bull'}),
    row({symbol:'CAPTUREUSDT',timestamp:1_700_000_060_000,decision:'REJECTED',move:16,eventAt:1_700_000_300_000,window:'bull'})
  ]},{symbol:'MISSEDUSDT',steps:[
    row({symbol:'MISSEDUSDT',timestamp:1_700_100_000_000,decision:'REJECTED',move:18,eventAt:1_700_100_300_000,window:'bear'})
  ]}]}];
  const dataset=buildHistoricalLearningDataset(reports);
  const metrics=evaluateHistoricalLearningMetrics(dataset);
  assert.equal(metrics.successful_alerts,1);
  assert.equal(metrics.missed_move_decisions,2);
  assert.equal(metrics.observed_move_events,2);
  assert.equal(metrics.missed_move_events,1);
  assert.equal(metrics.move_event_capture_pct,50);
  assert.equal(metrics.median_lead_time_minutes,5);
  assert.equal(metrics.median_max_drawdown_pct,-1.8);
});

test('false-alert rate does not double-count failed early setups',()=>{
  const dataset=buildHistoricalLearningDataset([{window:{start_time:5},results:[{symbol:'EARLYUSDT',steps:[
    row({symbol:'EARLYUSDT',decision:'ACCEPTED',mode:'EARLY_WARNING',move:1}),
    row({symbol:'EARLYUSDT',timestamp:1_800_000_060_000,decision:'ACCEPTED',mode:'STRICT',move:1})
  ]}]}]);
  const metrics=evaluateHistoricalLearningMetrics(dataset);
  assert.equal(metrics.accepted_decisions,2);
  assert.equal(metrics.early_signal_failed,1);
  assert.equal(metrics.false_alerts,2);
  assert.equal(metrics.false_alert_rate_pct,100);
});

test('score values do not masquerade as probabilities; explicit probabilities get Brier and ECE scores',()=>{
  const rows=[
    row({symbol:'AUSDT',decision:'ACCEPTED',move:10,probability:0.8}),
    row({symbol:'BUSDT',decision:'ACCEPTED',move:1,probability:0.3}),
    row({symbol:'CUSDT',decision:'REJECTED',move:1,score:99})
  ];
  const metrics=evaluateHistoricalLearningMetrics(buildHistoricalLearningDataset([{window:{start_time:10},results:[{symbol:'AUSDT',steps:[rows[0]]},{symbol:'BUSDT',steps:[rows[1]]},{symbol:'CUSDT',steps:[rows[2]]}]}]));
  assert.equal(metrics.calibration.status,'ESTIMATED_FROM_EXPLICIT_PROBABILITIES');
  assert.equal(metrics.calibration.samples,2);
  assert.ok(metrics.calibration.brier_score!==null);
  assert.ok(metrics.calibration.expected_calibration_error!==null);
});

test('walk-forward split keeps timestamps ordered and purges labels crossing split boundaries',()=>{
  const rows=Array.from({length:10},(_,i)=>row({
    symbol:'TESTUSDT',timestamp:1_600_000_000_000+i*10*24*60*MINUTE,
    horizon:true,move:i%2?8:1,decision:i%2?'ACCEPTED':'REJECTED'
  })).map((x,i)=>({...x,outcome:{...x.outcome,horizon_ms:24*60*MINUTE},row_id:i}));
  const split=splitHistoricalLearningRows(rows,{trainFraction:0.6,validationFraction:0.2,embargoMs:0});
  assert.equal(split.no_random_split,true);
  assert.equal(split.temporal_order_enforced,true);
  assert.equal(split.status,'READY');
  assert.ok(split.train.every(t=>t<split.boundaries.validation_start));
  assert.ok(split.validation.every(t=>t>=split.boundaries.validation_start&&t<split.boundaries.test_start));
  assert.ok(split.test.every(t=>t>=split.boundaries.test_start));
  assert.ok(split.purged_rows>=0);
});

test('matrix audit flags a missing symbol-window pair and missing market regimes',()=>{
  const matrix={windows:[
    {id:'bull',market_regime:{regime:'BULL_TREND'},results:[{symbol:'AUSDT',data_quality:{candle_fetch_complete:true,outcome_candle_fetch_complete:true,synthetic_data_used:false,replay_mode:'FULL_TRADE'}}]},
    {id:'bear',market_regime:{regime:'BEAR_TREND'},results:[{symbol:'AUSDT',data_quality:{candle_fetch_complete:true,outcome_candle_fetch_complete:true,synthetic_data_used:false,replay_mode:'FULL_TRADE'}}]}
  ]};
  const audit=auditHistoricalMatrixCoverage(matrix,{expectedSymbols:['AUSDT','BUSDT'],expectedWindows:['bull','bear','sideways']});
  assert.equal(audit.status,'INCOMPLETE_OR_PARTIAL');
  assert.equal(audit.expected_symbol_window_pairs,6);
  assert.ok(audit.missing_symbol_window_pairs>0);
  assert.ok(audit.missing_required_regimes.includes('SIDEWAYS'));
});

test('incomplete-trade blocked scans are reported but never scored as false alerts or missed moves',()=>{
  const blocked=row({symbol:'GTCUSDT',decision:'REJECTED',move:45,dataMode:'BLOCKED_INCOMPLETE',rejectionGroup:'HISTORICAL_TRADE_COVERAGE_INCOMPLETE'});
  const metrics=evaluateHistoricalLearningMetrics(buildHistoricalLearningDataset([{window:{start_time:10},results:[{symbol:'GTCUSDT',steps:[blocked]}]}]));
  assert.equal(metrics.data_coverage_blocked_decisions,1);
  assert.equal(metrics.evaluable_decisions,0);
  assert.equal(metrics.missed_move_decisions,0);
  assert.equal(metrics.false_alerts,0);
});

