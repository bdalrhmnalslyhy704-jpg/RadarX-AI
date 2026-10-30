import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCognitiveLearningProfile,assessCognitiveCandidate,applyCognitiveRankAdjustment} from '../core/cognitive-brain.mjs';

const sample=(index,outcome,features={})=>({
  id:'COGNITIVE'+String(index),symbol:'COGNITIVEUSDT',at:1_700_000_000_000+index*15*60_000,
  training_eligible:true,closed_candle_baseline:true,outcome,
  return_pct:outcome==='UP'?2.5:outcome==='DOWN'?-2.5:0,
  features:{volume_ratio:1.8,trade_ratio:1.5,taker_buy_ratio:0.58,higher_low:true,
    compression_ratio:0.7,relative_strength_vs_btc_pct:0.8,recent_15m_return_pct:0.6,
    trend_aligned:true,micro_5m_available:true,micro_5m_taker_buy_ratio:0.59,...features}
});
const candidate=(overrides={})=>({
  symbol:'EARLYUSDT',price:0.42,change_24h_pct:2.1,score:74,tier:'WATCH',
  data_valid:true,data_stale:false,closed_candles_only:true,candle_age_ms:60_000,
  features:{volume_ratio:2.2,trade_ratio:1.7,taker_buy_ratio:0.61,higher_low:true,
    compression_ratio:0.72,relative_strength_vs_btc_pct:1.2,recent_15m_return_pct:0.7,
    trend_aligned:true,micro_5m_available:true,micro_5m_taker_buy_ratio:0.58},
  ...overrides
});

test('cognitive learner ignores unresolved and non-training market-wide observations',()=>{
  const rows=[
    sample(1,'UP'),
    {...sample(2,'DOWN'),training_eligible:false},
    {...sample(3,'FLAT'),outcome:null}
  ];
  const profile=buildCognitiveLearningProfile(rows);
  assert.equal(profile.resolved_samples,1);
  assert.equal(profile.ranking_ready,false);
  assert.equal(profile.probability_ready,false);
  assert.equal(profile.note,'INSUFFICIENT_MATURED_CLOSED_CANDLE_OUTCOMES_OR_FACTOR_COVERAGE');
});

test('cognitive learning keeps the newest chronological observations out of fitting',()=>{
  const rows=Array.from({length:100},(_,index)=>sample(index,index%2===0?'UP':'DOWN'));
  const profile=buildCognitiveLearningProfile(rows);
  assert.equal(profile.resolved_samples,100);
  assert.equal(profile.training_samples,80);
  assert.equal(profile.holdout_samples,20);
  assert.ok(profile.holdout.evaluated);
  assert.ok(profile.holdout.beat_base_rate===true||profile.holdout.beat_base_rate===false);
  assert.ok(rows[79].at<rows[80].at);
  assert.equal(profile.method,'BAYESIAN_FACTOR_EVIDENCE_WITH_CHRONOLOGICAL_HOLDOUT_V1');
});

test('cognitive candidate analysis combines independent hypotheses but never authorizes a trade',()=>{
  const assessment=assessCognitiveCandidate(candidate(),buildCognitiveLearningProfile([]),Date.now());
  assert.equal(assessment.decision,'EARLY_SETUP_REVIEW');
  assert.equal(assessment.entry_eligible,false);
  assert.equal(assessment.real_order_execution,false);
  assert.equal(assessment.paper_trading,true);
  assert.equal(assessment.predicted_up_probability,null);
  assert.ok(assessment.hypotheses.some(row=>row.key==='BUYER_ACCUMULATION'&&row.supported));
  assert.ok(assessment.hypotheses.some(row=>row.key==='PRICE_STRUCTURE'&&row.supported));
});

test('cognitive brain explicitly avoids chasing extended coins',()=>{
  const assessment=assessCognitiveCandidate(candidate({change_24h_pct:11}),buildCognitiveLearningProfile([]),Date.now());
  assert.equal(assessment.decision,'AVOID_CHASING');
  assert.ok(assessment.reason_codes.includes('ANTI_CHASE_REVIEW_REQUIRED'));
  assert.equal(assessment.entry_eligible,false);
});

test('cognitive brain refuses to form a view from stale or incomplete candle data',()=>{
  const assessment=assessCognitiveCandidate(candidate({data_valid:false}),buildCognitiveLearningProfile([]),Date.now());
  assert.equal(assessment.decision,'DATA_UNAVAILABLE');
  assert.equal(assessment.predicted_up_probability,null);
  assert.equal(assessment.confidence_label,'UNKNOWN');
});

test('cognitive ranking adjustment is inert until the minimum evidence and factor coverage exist',()=>{
  const profile=buildCognitiveLearningProfile(Array.from({length:40},(_,index)=>sample(index,index%2?'UP':'DOWN')));
  assert.equal(profile.ranking_ready,false);
  assert.equal(applyCognitiveRankAdjustment(72,candidate().features,profile),72);
});
