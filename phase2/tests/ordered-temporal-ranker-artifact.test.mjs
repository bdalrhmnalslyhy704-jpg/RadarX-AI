import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT,
  TCN_LSTM_ORDERED_RANKING_FEATURE_SCHEMA_ID,
  buildTcnLstmFlattenedFeatures
} from '../core/temporal-lstm-hybrid.mjs';
import {
  createOrderedTemporalRankerArtifact,
  verifyOrderedTemporalRankerArtifact,
  predictOrderedTemporalRankerArtifact,
  writeOrderedTemporalRankerArtifactAtomic
} from '../core/ordered-temporal-ranker-artifact.mjs';

const sha40='1'.repeat(40);
const sha64='2'.repeat(64);
const trainingRows=32;
const means=Array.from({length:TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT},(_,i)=>i*0.001);
const stds=Array.from({length:TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT},(_,i)=>1+(i%7)*0.05);
const weights=Array.from({length:TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT},(_,i)=>Math.sin(i*0.03)*0.015);
const contract={
  schema:'RADARX_TCN_LSTM_EXECUTION_RANK_FEATURE_OUT_OF_SAMPLE_CONTRACT_V1',
  fit_partition:'PRE_EXECUTION_MODEL_TRAINING_PARTITION',
  feature_scoring_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK',
  ranker_training_rows:trainingRows,
  ranker_training_pairs:96,
  ranker_standardizer_fit_rows:trainingRows,
  ranker_standardizer_fit_partition:'TRAINING_PARTITION_ONLY',
  model_training_max_resolved_at:1000,
  execution_feature_min_at:1001,
  purge_gap_ms:1,
  training_and_execution_feature_identities_disjoint:true,
  chronology_valid:true,
  classifier_parameters_updated_by_ranker:false,
  validation_or_holdout_used:false,
  out_of_sample_for_execution_head_features:true
};

function makeProfile(overrides={}){
  const ranker={
    schema:'RADARX_TCN_LSTM_INDEPENDENT_ORDERED_696_RETURN_RANKER_V1',
    fitted:true,
    representation:'RAW_ORDERED_696_V1',
    fit_boundary:'TRAINING_PARTITION_ONLY',
    feature_count:TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT,
    training_rows,
    training_pairs:96,
    standardization:{
      method:'TRAIN_ONLY_POPULATION_ZSCORE',
      feature_mean:means,
      feature_std:stds,
      fit_partition:'TRAINING_PARTITION_ONLY',
      fit_rows:trainingRows,
      validation_or_holdout_used:false
    },
    source_partition:'PRE_EXECUTION_MODEL_TRAINING_PARTITION',
    feature_scoring_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK',
    classifier_parameters_updated:false,
    validation_or_holdout_used:false,
    downstream_feature_contract:structuredClone(contract),
    initial_pairwise_log_loss:0.693,
    final_pairwise_log_loss:0.62
  };
  const profile={
    model:{
      rankingRepresentation:'RAW_ORDERED_696_V1',
      orderedRankingHeadWeights:weights,
      orderedRankingFeatureMean:means,
      orderedRankingFeatureStd:stds
    },
    training:{
      return_ranking:{
        representation:'RAW_ORDERED_696_V1',
        pair_strategy:'PROFITABILITY_BOUNDARY_V1',
        round_trip_cost_bps:30,
        minimum_return_gap_pct:0.5,
        maximum_pairs_per_timestamp:16,
        ranking_head:ranker
      }
    }
  };
  return Object.assign(profile,overrides);
}
const provenance={
  sourceCommitSha:sha40,
  datasetSha256:sha64,
  inputFileSha256:'3'.repeat(64),
  datasetSourceCommitSha:'4'.repeat(40),
  datasetRowCount:32300,
  targetDefinition:'FIRST_TOUCH_PLUS_3_PCT_BEFORE_MINUS_2_PCT_WITHIN_4H_1M_V1',
  targetSemantics:'UP_IF_PLUS_3_PCT_FIRST_BEFORE_MINUS_2_PCT_ELSE_NON_SUCCESS_WITHIN_4H_1M_V1',
  roundTripCostBps:30,
  splitDefinition:{
    schema:'RADARX_NEURAL_CLOSURE_PURGED_60_20_20_UTC_DAY_SPLIT_V1',
    purge_ms:86400000,
    counts:{train:19269,validation:6282,holdout:6389},
    boundaries:{train_last_at:1000,validation_first_at:86401000,holdout_first_at:172801000}
  }
};

test('ordered raw 696 ranker exports a fully checksummed training-only artifact',()=>{
  const artifact=createOrderedTemporalRankerArtifact({profile:makeProfile(),provenance});
  const verification=verifyOrderedTemporalRankerArtifact(artifact);
  assert.equal(verification.valid,true);
  assert.equal(artifact.feature_schema_id,TCN_LSTM_ORDERED_RANKING_FEATURE_SCHEMA_ID);
  assert.equal(artifact.feature_count,696);
  assert.equal(artifact.parameters.weights.length,696);
  assert.equal(artifact.parameters.feature_mean.length,696);
  assert.equal(artifact.parameters.feature_std.length,696);
  assert.equal(artifact.training_provenance.fit_partition,'TRAINING_PARTITION_ONLY');
  assert.equal(artifact.training_provenance.validation_or_holdout_used,false);
  assert.equal(artifact.holdout_status,'LOCKED');
  assert.equal(artifact.real_order_execution,false);
  assert.equal(verification.content_hash.length,64);
});

test('artifact inference reproduces the exact raw ordered linear rank score',()=>{
  const artifact=createOrderedTemporalRankerArtifact({profile:makeProfile(),provenance});
  const sequence=Array.from({length:24},(_,step)=>
    Array.from({length:29},(_,channel)=>Math.sin((step+1)*(channel+2)*0.017)));
  const features=buildTcnLstmFlattenedFeatures(sequence);
  let expected=0;
  for(let i=0;i<696;i++)
    expected+=weights[i]*((features[i]-means[i])/stds[i]);
  expected=Math.max(-30,Math.min(30,expected));
  assert.equal(predictOrderedTemporalRankerArtifact(sequence,artifact),expected);
});

test('verifier rejects tampered parameters and an invalid OOS chronology contract',()=>{
  const artifact=createOrderedTemporalRankerArtifact({profile:makeProfile(),provenance});
  const changed=structuredClone(artifact);
  changed.parameters.weights[0]+=0.1;
  assert.equal(verifyOrderedTemporalRankerArtifact(changed).reason,
    'ORDERED_RANKER_CONTENT_HASH_MISMATCH');
  const broken=makeProfile();
  broken.training.return_ranking.ranking_head.downstream_feature_contract.execution_feature_min_at=900;
  assert.throws(()=>createOrderedTemporalRankerArtifact({profile:broken,provenance}),
    /ORDERED_RANKER_ARTIFACT_VERIFY_FAILED:ORDERED_RANKER_TRAINING_BOUNDARY_INVALID/);
});

test('atomic sidecar export reloads and verifies both artifact and manifest',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'radarx-ordered-ranker-'));
  try{
    const artifact=createOrderedTemporalRankerArtifact({profile:makeProfile(),provenance});
    const result=await writeOrderedTemporalRankerArtifactAtomic(directory,artifact);
    const restored=JSON.parse(await readFile(result.artifact_path,'utf8'));
    const manifest=JSON.parse(await readFile(result.manifest_path,'utf8'));
    assert.equal(result.status,'EXPORTED_AND_DISK_RELOAD_VERIFIED');
    assert.equal(verifyOrderedTemporalRankerArtifact(restored).valid,true);
    assert.deepEqual(manifest,artifact.artifact_manifest);
    assert.equal(result.artifact_content_hash,artifact.artifact_content_hash);
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
});
