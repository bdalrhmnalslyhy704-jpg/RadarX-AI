import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HURDLE_V2_RUNTIME_BUNDLE_SCHEMA,
  createHurdleV2RuntimeBundle,
  verifyHurdleV2RuntimeBundle,
  verifyOrderedTemporalRankerRuntimeBinding
} from '../core/hurdle-v2-runtime-bundle.mjs';

const CONTEXT_SCHEMA =
  'RADARX_TCN_LSTM_EXECUTION_HEAD_POOLED_SCORE_GATED_BY_MATCHED_FULL_SEQUENCE_LOGISTIC_CV_OOF_CLASSIFIER_AND_INDEPENDENT_RANK_SCORE_V8';
const LOGISTIC_SCHEMA =
  'RADARX_TCN_LSTM_LOGISTIC_FULL_ORDERED_SEQUENCE_24X29_696_V1';

function validProfile() {
  return {
    model: {
      executionRegressionHeadsFitted: true,
      executionHeadInputFeatureSchema: CONTEXT_SCHEMA,
      executionHurdleReturnHeads: {
        LOGIT_CONTEXT_AUGMENTED: {fitted:true},
        POOLED_ONLY: {fitted:true}
      }
    },
    baseline_fit: {
      weights: Array(58).fill(0),
      bias: 0
    },
    execution_logistic_context_metadata: {
      status: 'AVAILABLE',
      logistic_cv_schema: 'RADARX_TRAIN_ONLY_PURGED_EXPANDING_LOGISTIC_CV_V2',
      logistic_feature_schema_id: LOGISTIC_SCHEMA,
      predictions_are_out_of_sample_for_scoring_rows: true,
      training_predictions_are_out_of_fold: true,
      training_predictions_source_partition: 'PURGED_EXPANDING_TRAIN_ONLY_OOF_FOLDS',
      classifier_training_baseline_source: 'TUNED_FULL_ORDERED_TEMPORAL_LOGISTIC_696_RAW_OOF',
      validation_or_holdout_used: false,
      training_prediction_coverage: {
        oof_scored_rows: 40,
        outer_validation_or_holdout_used: false
      }
    },
    execution_logistic_context_model: {
      training_partition_only: true,
      standardizer: {},
      fit: {}
    }
  };
}

function validProvenance() {
  return {
    sourceCommitSha: '1'.repeat(40),
    datasetSha256: '2'.repeat(64),
    inputFileSha256: '3'.repeat(64),
    datasetSourceCommitSha: '4'.repeat(40),
    datasetRowCount: 32300,
    roundTripCostBps: 30
  };
}

test('runtime bundle pins the exact residual and Logistic anchor used by the ranker artifact',()=>{
  const makeBinding=()=>({
    profile:{model:{
      orderedRankingHeadWeights:Array.from({length:696},(_,i)=>i*0.0001),
      orderedRankingFeatureMean:Array.from({length:696},(_,i)=>i*0.001),
      orderedRankingFeatureStd:Array.from({length:696},(_,i)=>1+i*0.0001),
      orderedRankingAnchorWeights:Array.from({length:696},(_,i)=>-i*0.0002),
      orderedRankingAnchorFeatureMean:Array.from({length:696},(_,i)=>i*0.0003),
      orderedRankingAnchorFeatureStd:Array.from({length:696},(_,i)=>1+i*0.0002),
      orderedRankingAnchorBias:-0.125
    }},
    artifact:{parameters:{
      weights:Array.from({length:696},(_,i)=>i*0.0001),
      feature_mean:Array.from({length:696},(_,i)=>i*0.001),
      feature_std:Array.from({length:696},(_,i)=>1+i*0.0001),
      anchor_weights:Array.from({length:696},(_,i)=>-i*0.0002),
      anchor_feature_mean:Array.from({length:696},(_,i)=>i*0.0003),
      anchor_feature_std:Array.from({length:696},(_,i)=>1+i*0.0002),
      anchor_bias:-0.125
    }}
  });
  const valid=makeBinding();
  assert.equal(verifyOrderedTemporalRankerRuntimeBinding(valid.profile,valid.artifact),true);

  const changedResidual=makeBinding();
  changedResidual.artifact.parameters.weights[12]+=0.01;
  assert.equal(verifyOrderedTemporalRankerRuntimeBinding(
    changedResidual.profile,changedResidual.artifact),false);

  const changedAnchor=makeBinding();
  changedAnchor.artifact.parameters.anchor_weights[12]+=0.01;
  assert.equal(verifyOrderedTemporalRankerRuntimeBinding(
    changedAnchor.profile,changedAnchor.artifact),false);

  const changedBias=makeBinding();
  changedBias.profile.model.orderedRankingAnchorBias+=0.01;
  assert.equal(verifyOrderedTemporalRankerRuntimeBinding(
    changedBias.profile,changedBias.artifact),false);
});

test('runtime bundle requires a complete TCN-LSTM inference profile', () => {
  assert.throws(
    () => createHurdleV2RuntimeBundle(),
    /HURDLE_V2_RUNTIME_PROFILE_REQUIRED/
  );
});

test('runtime bundle rejects a missing purged temporal Logistic scorer', () => {
  const profile=validProfile();
  profile.execution_logistic_context_model=null;
  assert.throws(
    () => createHurdleV2RuntimeBundle({
      profile,rankerArtifact:{},hurdleArtifact:{},
      provenance:validProvenance(),
      probeSequence:Array.from({length:24},()=>Array(29).fill(0))
    }),
    /HURDLE_V2_RUNTIME_TEMPORAL_LOGISTIC_DEPENDENCY_INVALID/
  );
});

test('runtime bundle rejects an incomplete 58-feature Logistic anchor', () => {
  const profile=validProfile();
  profile.baseline_fit.weights=Array(57).fill(0);
  assert.throws(
    () => createHurdleV2RuntimeBundle({
      profile,rankerArtifact:{},hurdleArtifact:{},
      provenance:validProvenance(),
      probeSequence:Array.from({length:24},()=>Array(29).fill(0))
    }),
    /HURDLE_V2_RUNTIME_LOGISTIC_ANCHOR_DEPENDENCY_INVALID/
  );
});

test('runtime bundle does not accept an unverified ordered ranker', () => {
  assert.throws(
    () => createHurdleV2RuntimeBundle({
      profile:validProfile(),rankerArtifact:{},hurdleArtifact:{},
      provenance:validProvenance(),
      probeSequence:Array.from({length:24},()=>Array(29).fill(0))
    }),
    /HURDLE_V2_RUNTIME_ORDERED_RANKER_INVALID/
  );
});

test('runtime bundle verifier fails closed on absent or altered dependencies', () => {
  assert.equal(HURDLE_V2_RUNTIME_BUNDLE_SCHEMA,
    'RADARX_BUILD224_HURDLE_V2_COMPLETE_INFERENCE_RUNTIME_BUNDLE_V1');
  assert.deepEqual(
    verifyHurdleV2RuntimeBundle({schema:'WRONG'}),
    {valid:false,reason:'RUNTIME_BUNDLE_SCHEMA_INVALID'}
  );
});
