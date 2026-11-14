import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFourHourFirstTouchOutcome,
  NEURAL_CLOSURE_TARGET_DEFINITION,
  NEURAL_CLOSURE_TARGET_SEMANTICS,
  NEURAL_CLOSURE_OUTCOME_SOURCE,
  NEURAL_CLOSURE_HORIZON_MS
} from '../core/neural-closure-contracts.mjs';
import {
  DENSE_FOUR_HOUR_SCHEMA,
  validateAndPrepareDense4hRows,
  splitDense4hChronologically,
  runDense4hGeneralizationBenchmark
} from '../core/dense-generalization-projection.mjs';
import {verifyVersionedModelArtifact} from '../core/model-artifact-guardian.mjs';

const DAY=24*60*60*1000;
const FIFTEEN_MINUTES=15*60*1000;
const START=Date.UTC(2026,0,1);
const SOURCE_SHA='c7a94616dc3195304f4104bd5d6d8bbd9b611fb5';

function makeFeaturePacket(positive,index){
  const direction=positive?1:-1;
  return {
    volume_ratio:positive?3.1:0.65,
    trade_ratio:positive?2.4:0.72,
    taker_buy_ratio:positive?0.73:0.36,
    compression_ratio:positive?0.42:0.94,
    relative_strength_vs_btc_pct:positive?2.4:-1.1,
    recent_15m_return_pct:positive?1.1:-0.75,
    higher_low:positive,
    breakout_above_prior_high:false,
    trend_aligned:positive,
    return_30m_pct:positive?1.1:-0.8,
    hourly_return_pct:positive?1.8:-1.2,
    return_3h_pct:positive?2.6:-1.8,
    btc_hourly_return_pct:0.15,
    daily_change_pct:positive?4:-3,
    relative_strength_vs_btc_24h_pct:positive?2.6:-1.4,
    breakout_distance_pct:positive?0.25:1.1,
    current_range_pct:positive?1.5:2.8,
    lower_wick_pct:positive?0.55:0.2,
    micro_5m_available:true,
    micro_5m_taker_buy_ratio:positive?0.76:0.34,
    micro_5m_volume_ratio:positive?2.5:0.62,
    micro_5m_trade_ratio:positive?2.1:0.7,
    micro_5m_return_pct:positive?0.8:-0.6,
    micro_5m_close_location:positive?0.82:0.24,
    fixture_index:index
  };
}

function makeSequence(positive,index){
  return Array.from({length:24},(_,step)=>
    Array.from({length:29},(_,channel)=>{
      if(channel===28)return positive?0.62:0.18;
      if(channel===0)return positive?0.35:-0.3;
      return Math.sin((step+1)*(channel+1)*(index+1)*0.013)*0.12;
    }));
}

function makeAuditedRow(day,index){
  const at=START+day*DAY+index*60_000;
  const symbol='DENSE'+String(index).padStart(2,'0')+'USDT';
  const positive=(day+index)%2===0;
  const outcome=positive?'UP':((day+index)%4===1?'DOWN':'FLAT');
  const candles=Array.from({length:240},(_,minute)=>{
    const openTime=at+1+minute*60_000;
    let high=101.5,low=99.2,close=100.1;
    if(outcome==='UP'&&minute===4){high=103.2;close=103.05;}
    if(outcome==='DOWN'&&minute===4){low=97.5;close=97.8;}
    return {
      open_time:openTime,close_time:openTime+59_999,
      is_closed:true,open:100,high,low,close
    };
  });
  const label=buildFourHourFirstTouchOutcome({
    id:symbol+':'+at,symbol,baselineAt:at,baselinePrice:100,candles
  });
  assert.equal(label.outcome,outcome);
  return {
    ...label,
    features:makeFeaturePacket(positive,index),
    temporal_sequence:makeSequence(positive,index),
    temporal_sequence_timestamps:Array.from({length:24},(_,step)=>
      at-(23-step)*FIFTEEN_MINUTES)
  };
}

function makeCohort(){
  const rows=[];
  for(let day=0;day<100;day++){
    for(let symbol=0;symbol<8;symbol++)rows.push(makeAuditedRow(day,symbol));
  }
  return rows;
}

test('Dense 4h accepts only the same audited first-touch cohort used by V5 and TCN',()=>{
  const rows=makeCohort();
  const prepared=validateAndPrepareDense4hRows(rows);
  assert.equal(prepared.schema,DENSE_FOUR_HOUR_SCHEMA);
  assert.equal(prepared.row_count,800);
  assert.equal(prepared.target_definition,NEURAL_CLOSURE_TARGET_DEFINITION);
  assert.equal(prepared.target_semantics,NEURAL_CLOSURE_TARGET_SEMANTICS);
  assert.equal(prepared.outcome_source,NEURAL_CLOSURE_OUTCOME_SOURCE);
  assert.equal(prepared.horizon_ms,NEURAL_CLOSURE_HORIZON_MS);
  assert.equal(prepared.feature_names.length,18);
  assert.ok(prepared.positive_rows>=390&&prepared.negative_rows>=390);

  const wrongSemantics={...rows[0],target_semantics:'LEGACY_CLOSE_ONLY'};
  assert.throws(()=>validateAndPrepareDense4hRows([wrongSemantics]),
    /TARGET_SOURCE_OR_HORIZON_MISMATCH/);
  const badCutoff={...rows[0],feature_information_cutoff_at:rows[0].at-1};
  assert.throws(()=>validateAndPrepareDense4hRows([badCutoff]),
    /TEMPORAL_CUTOFF_OR_MATURITY_INVALID/);
  const badSequence={...rows[0],temporal_sequence_timestamps:
    [...rows[0].temporal_sequence_timestamps.slice(1),rows[0].at]};
  assert.throws(()=>validateAndPrepareDense4hRows([badSequence]),
    /SHARED_TCN_SEQUENCE_INVALID/);
});

test('Dense 4h uses chronological 60/20/20 partitions with full-day purge and maturity guards',()=>{
  const prepared=validateAndPrepareDense4hRows(makeCohort());
  const split=splitDense4hChronologically(prepared.rows);
  assert.equal(split.status,'READY');
  assert.ok(split.train.length>=450);
  assert.ok(split.validation.length>=130);
  assert.ok(split.holdout.length>=140);
  assert.equal(split.boundaries.requested_proportions.train,0.6);
  assert.equal(split.boundaries.requested_proportions.validation,0.2);
  assert.equal(split.boundaries.requested_proportions.holdout,0.2);
  assert.equal(split.boundaries.purge_ms,DAY);
  assert.ok(split.ranges.train.max_resolved_at<split.ranges.validation.first_at);
  assert.ok(split.ranges.validation.max_resolved_at<split.ranges.holdout.first_at);
  for(const name of ['train','validation','holdout']){
    const part=split[name];
    assert.ok(part.filter(row=>row.target===1).length>=50);
    assert.ok(part.filter(row=>row.target===0).length>=50);
  }
});

test('Dense 4h trains with train-only focal weights and emits a checksummed paper-only artifact',()=>{
  const prepared=validateAndPrepareDense4hRows(makeCohort());
  const split=splitDense4hChronologically(prepared.rows);
  const report=runDense4hGeneralizationBenchmark(prepared,split,{
    sourceCommitSha:SOURCE_SHA,epochs:12,bootstrapIterations:100
  });
  assert.equal(report.schema,DENSE_FOUR_HOUR_SCHEMA);
  assert.equal(report.source_commit_sha,SOURCE_SHA);
  assert.equal(report.training.scaler_fit_on,'TRAIN_ONLY');
  assert.equal(report.training.focal_asymmetric_brier.weights_derived_from,
    'CURRENT_TRAINING_PARTITION_ONLY');
  assert.equal(report.training.gradient_updates_from_validation,false);
  assert.equal(report.training.gradient_updates_from_holdout,false);
  assert.equal(report.training.focal_asymmetric_brier.training_positive,
    split.train.filter(row=>row.target===1).length);
  assert.equal(report.training.focal_asymmetric_brier.training_negative,
    split.train.filter(row=>row.target===0).length);
  assert.equal(report.model_artifact.target_definition,NEURAL_CLOSURE_TARGET_DEFINITION);
  assert.equal(report.model_artifact.target_semantics,NEURAL_CLOSURE_TARGET_SEMANTICS);
  assert.equal(report.model_artifact.paper_trading,true);
  assert.equal(report.model_artifact.real_order_execution,false);
  const verified=verifyVersionedModelArtifact(report.model_artifact,{
    expectedSourceCommitSha:SOURCE_SHA
  });
  assert.equal(verified.valid,true);
  assert.equal(verified.model_family,'DENSE_PROJECTION_MLP_4H');
  assert.equal(report.training_report_sha256.length,64);
  assert.equal(report.model_artifact_sha256,report.model_artifact.artifact_sha256);
  // A 100-day fixture supplies fewer than ten independent five-day holdout
  // clusters; the acceptance gate must remain closed rather than invent power.
  assert.notEqual(report.status,'DENSE4H_OOS_SUPERIORITY_VERIFIED');
  assert.equal(report.acceptance.real_order_execution,false);
});
