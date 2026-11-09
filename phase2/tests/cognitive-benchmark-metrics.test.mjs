import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFrozenRankingSignal,evaluateExistingEngineBaselines,auditCognitiveTrainingSampleCohorts} from '../core/cognitive-benchmark-metrics.mjs';

test('ranking metrics preserve misses and score coverage while excluding FLAT only from AUC pairs',()=>{
  const rows=[
    {id:'a',at:1,symbol:'AAAUSDT',outcome:'UP'},
    {id:'b',at:2,symbol:'BBBUSDT',outcome:'DOWN'},
    {id:'c',at:3,symbol:'CCCUSDT',outcome:'UP'},
    {id:'d',at:4,symbol:'DDDUSDT',outcome:'FLAT'}
  ];
  const metric=evaluateFrozenRankingSignal(rows,row=>row.id==='a'?0.9:row.id==='b'?0.1:row.id==='c'?0.8:null);
  assert.equal(metric.sample_count,4);
  assert.equal(metric.directional_sample_count,3);
  assert.equal(metric.positive_samples,2);
  assert.equal(metric.negative_samples,1);
  assert.equal(metric.missing_score_samples,1);
  assert.equal(metric.score_coverage_pct,75);
  assert.equal(metric.auc_roc,1);
  assert.equal(metric.no_probability_calibration_claim,true);
});

test('AUC handles tied scores with average ranks and is invariant to input order',()=>{
  const rows=[
    {id:'u1',at:1,symbol:'AAAUSDT',outcome:'UP',score:1},
    {id:'d1',at:2,symbol:'BBBUSDT',outcome:'DOWN',score:1},
    {id:'u2',at:3,symbol:'CCCUSDT',outcome:'UP',score:2},
    {id:'d2',at:4,symbol:'DDDUSDT',outcome:'DOWN',score:0}
  ];
  const a=evaluateFrozenRankingSignal(rows,row=>row.score);
  const b=evaluateFrozenRankingSignal(rows.slice().reverse(),row=>row.score);
  assert.equal(a.auc_roc,0.875);
  assert.equal(b.auc_roc,a.auc_roc);
});

test('existing-engine baselines evaluate identical rows with explicit extended-move exclusion',()=>{
  const rows=[
    {id:'1',at:1,symbol:'AAAUSDT',outcome:'UP',base_score:90,tier:'EARLY_SETUP',features:{hourly_return_pct:0.5}},
    {id:'2',at:2,symbol:'BBBUSDT',outcome:'DOWN',base_score:95,tier:'LATE_MOVE',features:{hourly_return_pct:6}},
    {id:'3',at:3,symbol:'CCCUSDT',outcome:'UP',base_score:70,tier:'WATCH',features:{hourly_return_pct:1}},
    {id:'4',at:4,symbol:'DDDUSDT',outcome:'FLAT',base_score:55,tier:'NO_SETUP',features:{hourly_return_pct:0.1}}
  ];
  const metrics=evaluateExistingEngineBaselines(rows);
  assert.equal(metrics.current_engine_base_score.sample_count,4);
  assert.equal(metrics.current_engine_base_score.score_coverage_pct,100);
  assert.equal(metrics.current_engine_score_excluding_late_move.score_coverage_pct,75);
  assert.equal(metrics.existing_early_setup_gate.score_coverage_pct,25);
  assert.equal(metrics.simple_hourly_momentum.sample_count,4);
});


test('top-k ranking denominators match the cognitive model directional universe, not the FLAT-inclusive universe',()=>{
  const rows=[];
  for(let index=0;index<5;index++){
    rows.push({id:'up-'+index,at:index*2+1,symbol:'UP'+index+'USDT',outcome:'UP',score:10-index});
    rows.push({id:'down-'+index,at:index*2+2,symbol:'DN'+index+'USDT',outcome:'DOWN',score:5-index});
  }
  rows.push({id:'flat',at:20,symbol:'FLATUSDT',outcome:'FLAT',score:100});
  const metric=evaluateFrozenRankingSignal(rows,row=>row.score);
  assert.equal(metric.sample_count,11);
  assert.equal(metric.directional_sample_count,10);
  assert.equal(metric.top_10_pct.selected_count,1,
    '10% of 10 directional outcomes is one, not 10% of 11 including FLAT');
  assert.equal(metric.top_20_pct.selected_count,2);
});


test('feature-label rows without TCN tensors are reported as temporal exclusions, not corrupt labels', () => {
  const base = {
    id:'sample-1', symbol:'AAAUSDT', at:1_000_000, resolved_at:1_000_000+4*60*60*1000,
    horizon_ms:4*60*60*1000, training_eligible:true, historical_baseline:true,
    target_definition:'TARGET_V1', outcome_source:'HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1',
    outcome:'UP', first_passage:{path_resolution:'15M',outcome:'UP'}, features:{volume_ratio:1.2}
  };
  const audit=auditCognitiveTrainingSampleCohorts([base],{targetDefinition:'TARGET_V1'});
  assert.equal(audit.invalid_samples,0);
  assert.equal(audit.feature_eligible_samples,1);
  assert.equal(audit.temporal_eligible_samples,0);
  assert.equal(audit.sequence_exclusions.missing,1);
  assert.equal(audit.temporal_sequence_coverage_ratio,0);
});

test('a complete bounded 24x29 tensor enters both feature and temporal cohorts', () => {
  const base = {
    id:'sample-2', symbol:'BBBUSDT', at:2_000_000, resolved_at:2_000_000+4*60*60*1000,
    horizon_ms:4*60*60*1000, training_eligible:true, historical_baseline:true,
    target_definition:'TARGET_V1', outcome_source:'HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1',
    outcome:'DOWN', first_passage:{path_resolution:'15M',outcome:'DOWN'}, features:{buyer_pressure:0.6},
    temporal_sequence:Array.from({length:24},()=>Array(29).fill(0.25))
  };
  const audit=auditCognitiveTrainingSampleCohorts([base],{targetDefinition:'TARGET_V1'});
  assert.equal(audit.invalid_samples,0);
  assert.equal(audit.feature_eligible_samples,1);
  assert.equal(audit.temporal_eligible_samples,1);
  assert.equal(audit.temporal_sequence_coverage_pct,100);
});

test('temporal sequence range violations are excluded separately from label corruption', () => {
  const base = {
    id:'sample-3', symbol:'CCCUSDT', at:3_000_000, resolved_at:3_000_000+4*60*60*1000,
    horizon_ms:4*60*60*1000, training_eligible:true, historical_baseline:true,
    target_definition:'TARGET_V1', outcome_source:'HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1',
    outcome:'FLAT', first_passage:{path_resolution:'15M',outcome:'FLAT'}, features:{buyer_pressure:0.5},
    temporal_sequence:Array.from({length:24},()=>Array(29).fill(0))
  };
  base.temporal_sequence[4][7]=4.01;
  const audit=auditCognitiveTrainingSampleCohorts([base],{targetDefinition:'TARGET_V1'});
  assert.equal(audit.invalid_samples,0);
  assert.equal(audit.sequence_exclusions.out_of_range,1);
  assert.equal(audit.temporal_eligible_samples,0);
});

test('broken labels and duplicate identities remain hard audit failures', () => {
  const base = {
    id:'sample-4', symbol:'DDDUSDT', at:4_000_000, resolved_at:4_000_000+4*60*60*1000,
    horizon_ms:4*60*60*1000, training_eligible:true, historical_baseline:true,
    target_definition:'TARGET_V1', outcome_source:'HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1',
    outcome:'UP', first_passage:{path_resolution:'15M',outcome:'UP'}, features:{volume_ratio:1},
    temporal_sequence:Array.from({length:24},()=>Array(29).fill(0))
  };
  const broken={...base,id:'sample-broken',horizon_ms:60_000};
  const audit=auditCognitiveTrainingSampleCohorts([base,{...base},broken],{targetDefinition:'TARGET_V1'});
  assert.equal(audit.duplicate_ids,1);
  assert.equal(audit.invalid_samples,1);
  assert.equal(audit.invalid_feature_reason_counts.HORIZON_FIELD_MISMATCH,1);
  assert.equal(audit.temporal_eligible_samples,1);
});
