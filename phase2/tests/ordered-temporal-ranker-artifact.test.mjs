import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT,
  TCN_LSTM_ORDERED_RANKING_FEATURE_SCHEMA_ID,
  TCN_LSTM_STEPS,
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
const temporalBlockCount=4;
const stepsPerBlock=TCN_LSTM_STEPS/temporalBlockCount;
const parameterCount=temporalBlockCount*29;
const parameterizationId='TEMPORAL_BLOCK_TIED_4X29_V1';
const groupIndex=i=>Math.floor(Math.floor(i/29)/stepsPerBlock)*29+(i%29);
const means=Array.from({length:TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT},(_,i)=>groupIndex(i)*0.001);
const stds=Array.from({length:TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT},(_,i)=>1+(groupIndex(i)%7)*0.05);
const weights=Array.from({length:TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT},(_,i)=>
  Math.sin(groupIndex(i)*0.03)*0.015/stepsPerBlock);
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
    training_rows:trainingRows,
    training_pairs:96,
    standardization:{
      method:'TRAIN_ONLY_TEMPORAL_BLOCK_CHANNEL_ZSCORE',
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
    final_pairwise_log_loss:0.62,
    learning_rate:0.03,
    l2:0.05,
    training_objective:'PAIRWISE_SOFTPLUS_MARGIN_V1',
    ranking_margin:0.25,
    epochs_requested:8,
    epochs_completed:8,
    best_epoch:8,
    patience:8,
    epoch_selection_mode:'FIXED_EPOCHS',
    selection_metric:'MIN_FOLD_LOGISTIC_ACCURACY_MARGIN_THEN_PAIR_WEIGHTED_MARGIN_AND_LOG_LOSS_NESTED_PURGED_EXPANDING_WINDOW_V5',
    parameterization_id:parameterizationId,
    temporal_block_count:temporalBlockCount,
    steps_per_block:stepsPerBlock,
    parameter_count:parameterCount,
    internal_training_validation:{
      schema:'RADARX_TCN_LSTM_ORDERED_RANKER_INTERNAL_PURGED_EXPANDING_VALIDATION_V5',
      method:'TWO_FOLD_NESTED_EARLY_STOPPING_LOGISTIC_ANCHORED_ACCURACY_GUARDED_VALIDATION_V1',
      training_objective:'PAIRWISE_SOFTPLUS_MARGIN_V1',
      ranking_margin:0.25,
      epoch_selection_policy:'NESTED_PURGED_EPOCH_WINDOW_THEN_FIXED_EPOCH_REFIT_ON_FULL_OUTER_FOLD_TRAINING_ROWS',
      logistic_baseline_config:{
        schema:'RADARX_FOLD_LOCAL_RAW_TEMPORAL_LOGISTIC_RANKING_REFERENCE_V1',
        feature_schema_id:TCN_LSTM_ORDERED_RANKING_FEATURE_SCHEMA_ID,
        feature_count:TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT,
        l2:1,learning_rate:0.03,max_epochs:160,
        fit_partition:'EACH_COMPLETE_OUTER_FOLD_TUNING_WINDOW_ONLY',
        epoch_selection_partition:'EARLIER_NESTED_PURGED_SUBWINDOW_WITHIN_OUTER_FOLD_TRAINING_WINDOW',
        scoring_partition:'SAME_LATER_OUTER_FOLD_PURGED_VALIDATION_PAIRS',
        validation_labels_read:false,outer_validation_or_holdout_used:false
      },
      source_partition:'PRE_EXECUTION_MODEL_TRAINING_PARTITION_ONLY',
      fit_partition:'EXPANDING_EARLIER_SUBSETS_OF_PRE_EXECUTION_MODEL_TRAINING_PARTITION',
      validation_partition:'TWO_NON_OVERLAPPING_LATER_PURGED_WINDOWS_WITHIN_PRE_EXECUTION_MODEL_TRAINING_PARTITION',
      outer_validation_or_holdout_used:false,
      model_selection_partition_used:false,
      purge_horizon_ms:14400000,
      fold_count:2,
      folds:[
        {fold_index:1,fit_end_fraction:0.4,tuning_rows:64,validation_rows:24,purged_rows:8,
          tuning_pairs:48,validation_pairs:16,tuning_max_resolved_at:1000,tuning_max_at:500,
          validation_min_at:28800501,validation_max_at:28899000,purge_gap_ms:28800001,
          epoch_training_rows:20,epoch_training_pairs:24,epoch_validation_rows:20,
          epoch_validation_pairs:16,epoch_purged_rows:24,epoch_unused_rows:0,
          epoch_training_max_at:200,epoch_training_max_resolved_at:1000,
          epoch_validation_min_at:14400501,epoch_validation_max_at:14499000,
          epoch_purge_gap_ms:14400301,
          logistic_validation_pairwise_log_loss:0.66,logistic_validation_pairwise_accuracy_pct:60,
          logistic_baseline_training_rows:64,logistic_baseline_validation_labels_read:false,
          logistic_baseline_validation_or_holdout_used:false},
        {fold_index:2,fit_end_fraction:0.6,tuning_rows:64,validation_rows:24,purged_rows:8,
          tuning_pairs:48,validation_pairs:16,tuning_max_resolved_at:28900500,tuning_max_at:28900000,
          validation_min_at:57700501,validation_max_at:57799000,purge_gap_ms:28800501,
          epoch_training_rows:20,epoch_training_pairs:24,epoch_validation_rows:20,
          epoch_validation_pairs:16,epoch_purged_rows:24,epoch_unused_rows:0,
          epoch_training_max_at:28900000,epoch_training_max_resolved_at:28900500,
          epoch_validation_min_at:43300501,epoch_validation_max_at:43399000,
          epoch_purge_gap_ms:14400501,
          logistic_validation_pairwise_log_loss:0.64,logistic_validation_pairwise_accuracy_pct:61,
          logistic_baseline_training_rows:64,logistic_baseline_validation_labels_read:false,
          logistic_baseline_validation_or_holdout_used:false}
      ],
      tuning_max_resolved_at:28900500,
      tuning_max_at:28900000,
      validation_min_at:28800501,
      purge_gap_ms:28800001,
      chronology_valid:true,
      tuning_rows:128,
      validation_rows:48,
      purged_rows:16,
      tuning_pairs:96,
      validation_pairs:32,
      candidate_grid:[
        {temporal_block_count:4,steps_per_block:6,parameterization_id:parameterizationId,
          parameter_count:116,l2:0.001,best_epoch:6,best_validation_pairwise_accuracy_pct:61,minimum_fold_pairwise_accuracy_pct:60,
          validation_pairwise_accuracy_std_pct:1,logistic_validation_pairwise_accuracy_pct:60.5,
          logistic_validation_pairwise_log_loss:0.65,best_validation_pairwise_accuracy_improvement_pct:0.5,
          minimum_fold_pairwise_accuracy_improvement_pct:-1,best_validation_pairwise_log_loss_improvement:0.035,
          training_pairwise_accuracy_pct:69,best_validation_pairwise_log_loss:0.615,
          training_pairwise_log_loss:0.635,training_rows:128,validation_rows:48,purged_rows:16,
          training_pairs:96,validation_pairs:32,fold_count:2,
          fold_results:[
            {fold_index:1,best_epoch:6,best_validation_pairwise_log_loss:0.61,
              best_validation_pairwise_accuracy_pct:62,logistic_validation_pairwise_log_loss:0.66,
              logistic_validation_pairwise_accuracy_pct:60,training_pairwise_log_loss:0.63,
              training_pairwise_accuracy_pct:70,
              epoch_selection_pairwise_log_loss:0.62,epoch_selection_pairwise_accuracy_pct:65,
              epoch_training_rows:20,epoch_training_pairs:24,epoch_validation_rows:20,
              epoch_validation_pairs:16,epoch_purged_rows:24,epoch_unused_rows:0,
              epoch_purge_gap_ms:14400301,
              training_rows:64,validation_rows:24,purged_rows:8,
              training_pairs:48,validation_pairs:16},
            {fold_index:2,best_epoch:6,best_validation_pairwise_log_loss:0.62,
              best_validation_pairwise_accuracy_pct:60,logistic_validation_pairwise_log_loss:0.64,
              logistic_validation_pairwise_accuracy_pct:61,training_pairwise_log_loss:0.64,
              training_pairwise_accuracy_pct:68,
              epoch_selection_pairwise_log_loss:0.63,epoch_selection_pairwise_accuracy_pct:65,
              epoch_training_rows:20,epoch_training_pairs:24,epoch_validation_rows:20,
              epoch_validation_pairs:16,epoch_purged_rows:24,epoch_unused_rows:0,
              epoch_purge_gap_ms:14400501,
              training_rows:64,validation_rows:24,purged_rows:8,
              training_pairs:48,validation_pairs:16}
          ]},
        {temporal_block_count:4,steps_per_block:6,parameterization_id:parameterizationId,
          parameter_count:116,l2:0.05,best_epoch:8,best_validation_pairwise_accuracy_pct:66,minimum_fold_pairwise_accuracy_pct:65,
          validation_pairwise_accuracy_std_pct:1,logistic_validation_pairwise_accuracy_pct:60.5,
          logistic_validation_pairwise_log_loss:0.65,best_validation_pairwise_accuracy_improvement_pct:5.5,
          minimum_fold_pairwise_accuracy_improvement_pct:4,best_validation_pairwise_log_loss_improvement:0.065,
          training_pairwise_accuracy_pct:70.5,best_validation_pairwise_log_loss:0.585,
          training_pairwise_log_loss:0.605,training_rows:128,validation_rows:48,purged_rows:16,
          training_pairs:96,validation_pairs:32,fold_count:2,
          fold_results:[
            {fold_index:1,best_epoch:8,best_validation_pairwise_log_loss:0.58,
              best_validation_pairwise_accuracy_pct:67,logistic_validation_pairwise_log_loss:0.66,
              logistic_validation_pairwise_accuracy_pct:60,training_pairwise_log_loss:0.60,
              training_pairwise_accuracy_pct:71,
              epoch_selection_pairwise_log_loss:0.62,epoch_selection_pairwise_accuracy_pct:65,
              epoch_training_rows:20,epoch_training_pairs:24,epoch_validation_rows:20,
              epoch_validation_pairs:16,epoch_purged_rows:24,epoch_unused_rows:0,
              epoch_purge_gap_ms:14400301,
              training_rows:64,validation_rows:24,purged_rows:8,
              training_pairs:48,validation_pairs:16},
            {fold_index:2,best_epoch:8,best_validation_pairwise_log_loss:0.59,
              best_validation_pairwise_accuracy_pct:65,logistic_validation_pairwise_log_loss:0.64,
              logistic_validation_pairwise_accuracy_pct:61,training_pairwise_log_loss:0.61,
              training_pairwise_accuracy_pct:70,
              epoch_selection_pairwise_log_loss:0.63,epoch_selection_pairwise_accuracy_pct:65,
              epoch_training_rows:20,epoch_training_pairs:24,epoch_validation_rows:20,
              epoch_validation_pairs:16,epoch_purged_rows:24,epoch_unused_rows:0,
              epoch_purge_gap_ms:14400501,
              training_rows:64,validation_rows:24,purged_rows:8,
              training_pairs:48,validation_pairs:16}
          ]}
      ],
      selected_l2:0.05,
      selected_epochs:8,
      selected_validation_pairwise_log_loss:0.585,
      selected_validation_pairwise_accuracy_pct:66,
      selected_minimum_fold_pairwise_accuracy_pct:65,
      selected_logistic_validation_pairwise_accuracy_pct:60.5,
      selected_logistic_validation_pairwise_log_loss:0.65,
      selected_validation_pairwise_accuracy_improvement_pct:5.5,
      selected_minimum_fold_pairwise_accuracy_improvement_pct:4,
      selected_validation_pairwise_log_loss_improvement:0.065,
      selected_temporal_block_count:4,
      selected_steps_per_block:6,
      selected_parameterization_id:parameterizationId,
      selected_parameter_count:116,
      temporal_block_count:4,
      final_refit_epoch_selection_mode:'FIXED_EPOCHS_FROM_NESTED_PURGED_FOLD_EARLY_STOPPING',
      final_refit_rows:trainingRows,
      final_refit_pairs:96
    }
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
  featureNames:Array.from({length:696},(_,i)=>'STEP_FEATURE_'+String(i).padStart(3,'0')),
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
  assert.equal(artifact.feature_names.length,696);
  assert.equal(new Set(artifact.feature_names).size,696);
  assert.equal(artifact.parameters.weights.length,696);
  assert.equal(artifact.parameters.feature_mean.length,696);
  assert.equal(artifact.parameters.feature_std.length,696);
  assert.equal(artifact.training_provenance.fit_partition,'TRAINING_PARTITION_ONLY');
  assert.equal(artifact.training_provenance.validation_or_holdout_used,false);
  assert.equal(artifact.training_provenance.ranker_training_config.l2,0.05);
  assert.equal(artifact.training_provenance.ranker_training_config.training_objective,
    'PAIRWISE_SOFTPLUS_MARGIN_V1');
  assert.equal(artifact.training_provenance.ranker_training_config.ranking_margin,0.25);
  assert.equal(artifact.training_provenance.ranker_training_config.epochs_requested,8);
  assert.equal(artifact.training_provenance.ranker_training_config.epoch_selection_mode,'FIXED_EPOCHS');
  assert.equal(artifact.training_provenance.ranker_training_config.parameter_count,116);
  assert.equal(artifact.training_provenance.ranker_training_config.temporal_block_count,4);
  assert.equal(artifact.training_provenance.ranker_training_config.parameterization_id,parameterizationId);
  assert.equal(artifact.training_provenance.internal_training_validation.selected_l2,0.05);
  assert.equal(artifact.training_provenance.internal_training_validation.selected_epochs,8);
  assert.equal(artifact.training_provenance.internal_training_validation.purge_gap_ms,28800001);
  assert.equal(artifact.training_provenance.internal_training_validation.fold_count,2);
  assert.equal(artifact.training_provenance.internal_training_validation.method,
    'TWO_FOLD_NESTED_EARLY_STOPPING_LOGISTIC_ANCHORED_ACCURACY_GUARDED_VALIDATION_V1');
  assert.equal(artifact.training_provenance.internal_training_validation.epoch_selection_policy,
    'NESTED_PURGED_EPOCH_WINDOW_THEN_FIXED_EPOCH_REFIT_ON_FULL_OUTER_FOLD_TRAINING_ROWS');
  assert.equal(artifact.training_provenance.internal_training_validation.selected_minimum_fold_pairwise_accuracy_improvement_pct,4);
  assert.equal(artifact.training_provenance.internal_training_validation.selected_validation_pairwise_accuracy_improvement_pct,5.5);
  assert.equal(artifact.training_provenance.internal_training_validation.selected_validation_pairwise_accuracy_pct,66);
  assert.equal(artifact.training_provenance.internal_training_validation.selected_minimum_fold_pairwise_accuracy_pct,65);
  assert.equal(artifact.artifact_manifest.ranker_training_config_sha256.length,64);
  assert.equal(artifact.artifact_manifest.internal_training_validation_sha256.length,64);
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
  for(let step=0;step<stepsPerBlock;step++)
    changed.parameters.weights[step*29]+=0.1;
  assert.equal(verifyOrderedTemporalRankerArtifact(changed).reason,
    'ORDERED_RANKER_CONTENT_HASH_MISMATCH');
  const broken=makeProfile();
  broken.training.return_ranking.ranking_head.downstream_feature_contract.execution_feature_min_at=900;
  assert.throws(()=>createOrderedTemporalRankerArtifact({profile:broken,provenance}),
    /ORDERED_RANKER_ARTIFACT_VERIFY_FAILED:ORDERED_RANKER_TRAINING_BOUNDARY_INVALID/);
  const forgedTuning=structuredClone(artifact);
  forgedTuning.training_provenance.internal_training_validation.folds[0].purge_gap_ms=1;
  assert.equal(verifyOrderedTemporalRankerArtifact(forgedTuning).reason,
    'ORDERED_RANKER_TRAINING_BOUNDARY_INVALID',
    'a ranker artifact must reject a tuning record that does not preserve the four-hour internal purge');

  const untiedWeights=structuredClone(artifact);
  untiedWeights.parameters.weights[0]+=0.01;
  untiedWeights.artifact_content_hash=artifact.artifact_content_hash;
  assert.equal(verifyOrderedTemporalRankerArtifact(untiedWeights).reason,
    'ORDERED_RANKER_TRAINING_BOUNDARY_INVALID',
    'the verifier must reject weights that violate the declared tied temporal parameterization');

  const forgedPurgeClock=makeProfile();
  forgedPurgeClock.training.return_ranking.ranking_head.internal_training_validation.folds[0].validation_min_at+=1;
  assert.throws(()=>createOrderedTemporalRankerArtifact({profile:forgedPurgeClock,provenance}),
    /ORDERED_RANKER_ARTIFACT_VERIFY_FAILED:ORDERED_RANKER_TRAINING_BOUNDARY_INVALID/,
    'a one-millisecond timestamp change must invalidate a stale declared purge gap');
  const forgedFoldLoss=structuredClone(artifact);
  forgedFoldLoss.training_provenance.internal_training_validation.candidate_grid[1]
    .fold_results[0].best_validation_pairwise_log_loss+=0.10;
  forgedFoldLoss.artifact_content_hash=artifact.artifact_content_hash;
  assert.equal(verifyOrderedTemporalRankerArtifact(forgedFoldLoss).reason,
    'ORDERED_RANKER_TRAINING_BOUNDARY_INVALID',
    'the verifier must recompute the pair-weighted fold mean and reject a forged fold loss');
  const forgedFoldAccuracy=structuredClone(artifact);
  forgedFoldAccuracy.training_provenance.internal_training_validation.candidate_grid[1]
    .fold_results[0].best_validation_pairwise_accuracy_pct-=5;
  forgedFoldAccuracy.artifact_content_hash=artifact.artifact_content_hash;
  assert.equal(verifyOrderedTemporalRankerArtifact(forgedFoldAccuracy).reason,
    'ORDERED_RANKER_TRAINING_BOUNDARY_INVALID',
    'the verifier must recompute pair-weighted fold accuracy and reject a forged accuracy record');

  const inconsistentEpochs=makeProfile();
  inconsistentEpochs.training.return_ranking.ranking_head.epochs_completed=3;
  inconsistentEpochs.training.return_ranking.ranking_head.best_epoch=4;
  assert.throws(()=>createOrderedTemporalRankerArtifact({profile:inconsistentEpochs,provenance}),
    /ORDERED_RANKER_ARTIFACT_VERIFY_FAILED:ORDERED_RANKER_TRAINING_BOUNDARY_INVALID/,
    'the selected epoch cannot exceed the epochs actually completed');
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
    assert.equal(result.dependency.ranker_qualification.schema,
      'RADARX_TCN_LSTM_ORDERED_RANKER_INTERNAL_PURGED_EXPANDING_VALIDATION_V5');
    assert.equal(result.dependency.ranker_qualification.fold_count,2);
    assert.equal(result.dependency.ranker_qualification.selected_candidate_qualified,false);
    assert.equal(result.dependency.ranker_qualification.selected_candidate.fold_results.length,2);
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
});


test('Top-K artifact preserves per-fold pair-type metric provenance',()=>{
  const profile=makeProfile();
  const tuning=profile.training.return_ranking.ranking_head.internal_training_validation;
  profile.training.return_ranking.pair_strategy='PROFITABILITY_TOPK_V2';
  tuning.validation_fraction=0.15;
  tuning.validation_group_count=2;
  for(let index=0;index<tuning.folds.length;index++){
    const fold=tuning.folds[index];
    Object.assign(fold,{
      pair_strategy:'PROFITABILITY_TOPK_V2',
      tuning_decision_group_count:4,
      tuning_positive_vs_non_positive_pairs:24,
      tuning_positive_vs_positive_pairs:24,
      validation_decision_group_count:2,
      validation_positive_vs_non_positive_pairs:8,
      validation_positive_vs_positive_pairs:8,
      epoch_training_decision_group_count:2,
      epoch_training_positive_vs_non_positive_pairs:12,
      epoch_training_positive_vs_positive_pairs:12,
      epoch_validation_decision_group_count:2,
      epoch_validation_positive_vs_non_positive_pairs:8,
      epoch_validation_positive_vs_positive_pairs:8
    });
  }
  for(const candidate of tuning.candidate_grid){
    candidate.fold_results.forEach((result,index)=>{
      const makeTypeMetrics=(accuracy,loss)=>({
        pair_count:8,decision_group_count:2,
        pairwise_accuracy_pct:accuracy,pairwise_log_loss:loss
      });
      result.candidate_pair_type_metrics={
        positive_vs_non_positive:makeTypeMetrics(67,0.63),
        positive_vs_positive:makeTypeMetrics(55,0.70)
      };
      result.logistic_pair_type_metrics={
        positive_vs_non_positive:makeTypeMetrics(60,0.66),
        positive_vs_positive:makeTypeMetrics(61,0.64)
      };
      result.positive_vs_non_positive_pairwise_accuracy_improvement_pct=7;
      result.positive_vs_non_positive_pairwise_log_loss_improvement=0.03;
      result.positive_vs_positive_pairwise_accuracy_improvement_pct=-6;
      result.positive_vs_positive_pairwise_log_loss_improvement=-0.06;
    });
  }
  const artifact=createOrderedTemporalRankerArtifact({profile,provenance});
  const verification=verifyOrderedTemporalRankerArtifact(artifact);
  assert.equal(verification.valid,true);
  assert.equal(artifact.training_provenance.ranker_training_config.validation_fraction,0.15);
  assert.equal(artifact.training_provenance.ranker_training_config.validation_group_count,2);
  const folds=artifact.training_provenance.internal_training_validation.folds;
  assert.equal(folds[0].validation_positive_vs_non_positive_pairs,8);
  const result=artifact.training_provenance.internal_training_validation.candidate_grid[0].fold_results[0];
  assert.equal(result.candidate_pair_type_metrics.positive_vs_positive.pairwise_accuracy_pct,55);
  assert.equal(result.logistic_pair_type_metrics.positive_vs_non_positive.pairwise_log_loss,0.66);
  assert.equal(result.positive_vs_positive_pairwise_accuracy_improvement_pct,-6);

  const forgedValidationWindow=structuredClone(profile);
  forgedValidationWindow.training.return_ranking.ranking_head.internal_training_validation
    .validation_group_count++;
  assert.throws(()=>createOrderedTemporalRankerArtifact({
    profile:forgedValidationWindow,provenance
  }),/ORDERED_RANKER_ARTIFACT_VERIFY_FAILED:ORDERED_RANKER_TRAINING_BOUNDARY_INVALID/);

  const forged=structuredClone(profile);
  forged.training.return_ranking.ranking_head.internal_training_validation.candidate_grid[0]
    .fold_results[0].candidate_pair_type_metrics.positive_vs_positive.pair_count++;
  assert.throws(()=>createOrderedTemporalRankerArtifact({profile:forged,provenance}),
    /ORDERED_RANKER_ARTIFACT_VERIFY_FAILED:ORDERED_RANKER_TRAINING_BOUNDARY_INVALID/);
});

test('artifact verifier rejects confusing the expanded 696 inference width with tied free parameters',()=>{
  const profile=makeProfile();
  profile.training.return_ranking.ranking_head.parameter_count=
    TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT;
  assert.throws(
    ()=>createOrderedTemporalRankerArtifact({profile,provenance}),
    /ORDERED_RANKER_ARTIFACT_VERIFY_FAILED:ORDERED_RANKER_TRAINING_BOUNDARY_INVALID/
  );
});
