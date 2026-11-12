import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildCognitiveLearningProfile} from '../core/cognitive-brain.mjs';
import {
  TEMPORAL_TARGET_DEFINITION,
  TEMPORAL_MODEL_ARCHITECTURE,
  temporalBinaryTarget,
  TEMPORAL_SEQUENCE_STEPS,
  TEMPORAL_SEQUENCE_CHANNELS,
  TEMPORAL_POOLED_BASELINE_FEATURE_COUNT,
  isValidTemporalPooledBaselineFeatures,
  resetGradientBuffer,
  TEMPORAL_LATENT_CHANNELS,
  TEMPORAL_TRAINABLE_PARAMETER_COUNT,
  TEMPORAL_GRADIENT_ACCUMULATION,
  TEMPORAL_BASELINE_FEATURE_CACHE,
  TEMPORAL_GRADIENT_BUFFER_SCOPE,
  TEMPORAL_BRIER_SUPERIORITY_MARGIN,
  TEMPORAL_ORDERED_POOLING_MODE,
  TEMPORAL_ORDERED_POOLING_SEGMENTS,
  TEMPORAL_ORDERED_POOLING_FEATURE_COUNT,
  TEMPORAL_ORDERED_POOLING_TRAINABLE_PARAMETER_COUNT,
  TEMPORAL_ORDERED_POOLING_MODEL_ARCHITECTURE,
  TEMPORAL_MULTISCALE_POOLING_MODE,
  TEMPORAL_MULTISCALE_POOLING_SEGMENTS,
  TEMPORAL_MULTISCALE_POOLING_FEATURE_COUNT,
  TEMPORAL_MULTISCALE_DILATIONS,
  TEMPORAL_MULTISCALE_RECEPTIVE_FIELD,
  TEMPORAL_MULTISCALE_TRAINABLE_PARAMETER_COUNT,
  TEMPORAL_MULTISCALE_MODEL_ARCHITECTURE,
  poolOrderedTemporalSegments,
  poolMultiscaleTemporalSegments,
  hasTemporalBrierSuperiority,
  buildTemporalNeuralProfile,
  predictTemporalProbability
} from '../core/temporal-neural-brain.mjs';

const FOUR_HOURS=4*60*60*1000;
const EIGHT_HOURS=8*60*60*1000;
const BASE_TIME=1_710_000_000_000;

test('ordered four-segment pooling preserves temporal order instead of collapsing all 24 steps',()=>{
  const early=Array.from({length:TEMPORAL_SEQUENCE_STEPS},
    (_,time)=>Array.from({length:TEMPORAL_LATENT_CHANNELS},()=>time<6?1:0));
  const late=Array.from({length:TEMPORAL_SEQUENCE_STEPS},
    (_,time)=>Array.from({length:TEMPORAL_LATENT_CHANNELS},()=>time>=18?1:0));
  const pooledEarly=poolOrderedTemporalSegments(early);
  const pooledLate=poolOrderedTemporalSegments(late);
  assert.equal(TEMPORAL_ORDERED_POOLING_MODE,'ORDERED_FOUR_SEGMENT_MEAN_V1');
  assert.equal(TEMPORAL_ORDERED_POOLING_SEGMENTS,4);
  assert.equal(TEMPORAL_ORDERED_POOLING_FEATURE_COUNT,64);
  assert.equal(TEMPORAL_ORDERED_POOLING_TRAINABLE_PARAMETER_COUNT,1456);
  assert.equal(TEMPORAL_ORDERED_POOLING_MODEL_ARCHITECTURE,
    'TCN_24x29_TO16_LATENT_DILATED_RESIDUAL_ORDERED_FOUR_SEGMENT_POOLING_V9');
  assert.equal(pooledEarly.features.length,64);
  assert.equal(pooledLate.features.length,64);
  assert.equal(pooledEarly.poolSegments.length,4);
  assert.deepEqual(pooledEarly.poolSegments.map(row=>row.count),[6,6,6,6]);
  assert.notDeepEqual(pooledEarly.features,pooledLate.features,
    'same global mean but early and late movement must occupy different temporal feature groups');
  for(let channel=0;channel<TEMPORAL_LATENT_CHANNELS;channel++){
    assert.equal(pooledEarly.features[channel],1);
    assert.equal(pooledEarly.features[3*TEMPORAL_LATENT_CHANNELS+channel],0);
    assert.equal(pooledLate.features[channel],0);
    assert.equal(pooledLate.features[3*TEMPORAL_LATENT_CHANNELS+channel],1);
  }
  assert.equal(poolOrderedTemporalSegments(early.slice(1)),null,
    'incomplete latent windows must fail closed');
});

test('V10 full-window multiscale pooling preserves segment means, endpoints and slopes with exact gradient routes',()=>{
  const linear=Array.from({length:TEMPORAL_SEQUENCE_STEPS},(_,time)=>
    Array.from({length:TEMPORAL_LATENT_CHANNELS},(_,channel)=>time+channel*0.25));
  const pooled=poolMultiscaleTemporalSegments(linear);
  assert.equal(TEMPORAL_MULTISCALE_POOLING_MODE,'ORDERED_SEGMENT_MEAN_ENDPOINT_SLOPE_V1');
  assert.deepEqual(TEMPORAL_MULTISCALE_DILATIONS,[1,2,4,8]);
  assert.equal(TEMPORAL_MULTISCALE_RECEPTIVE_FIELD,31,
    'four dilated layers with two causal taps each must cover more than the 24-step input');
  assert.equal(TEMPORAL_MULTISCALE_POOLING_SEGMENTS,4);
  assert.equal(TEMPORAL_MULTISCALE_POOLING_FEATURE_COUNT,192);
  assert.equal(TEMPORAL_MULTISCALE_TRAINABLE_PARAMETER_COUNT,1888);
  assert.equal(TEMPORAL_MULTISCALE_MODEL_ARCHITECTURE,
    'TCN_24x29_TO16_LATENT_FOUR_LAYER_DILATED_RF31_MEAN_ENDPOINT_SLOPE_POOLING_V10');
  assert.equal(pooled.features.length,192);
  assert.equal(pooled.featureRoutes.length,192);
  assert.deepEqual(pooled.poolSegments.map(row=>row.count),[6,6,6,6]);
  assert.deepEqual(pooled.poolSegments.map(row=>row.feature_count),[48,48,48,48]);
  assert.equal(pooled.features[0],2.5,'first-segment mean');
  assert.equal(pooled.features[16],5,'first-segment endpoint');
  assert.equal(pooled.features[32],1,'first-segment per-step slope');
  assert.deepEqual(pooled.featureRoutes[0].time_weights,
    Array.from({length:6},(_,time)=>({time,weight:1/6})));
  assert.deepEqual(pooled.featureRoutes[16].time_weights,[{time:5,weight:1}]);
  assert.deepEqual(pooled.featureRoutes[32].time_weights,
    [{time:0,weight:-0.2},{time:5,weight:0.2}]);
  const early=Array.from({length:TEMPORAL_SEQUENCE_STEPS},(_,time)=>
    Array.from({length:TEMPORAL_LATENT_CHANNELS},()=>time<6?1:0));
  const late=Array.from({length:TEMPORAL_SEQUENCE_STEPS},(_,time)=>
    Array.from({length:TEMPORAL_LATENT_CHANNELS},()=>time>=18?1:0));
  assert.notDeepEqual(poolMultiscaleTemporalSegments(early).features,
    poolMultiscaleTemporalSegments(late).features,
    'same global mean but different timing must remain distinguishable');
  const invalid=linear.map(row=>row.slice());invalid[0][0]=null;
  assert.equal(poolMultiscaleTemporalSegments(invalid),null,
    'non-numeric latent values must fail closed');
  assert.equal(poolMultiscaleTemporalSegments(linear.slice(1)),null,
    'incomplete windows must fail closed');
});

test('reused TCN gradient scratch resets object-wrapped trainable arrays between rows',()=>{
  const scratch={
    projectionWeights:[[1.25,-0.5],[3,4]],
    depthWeights:[[[5,6],[7,8]]],
    biases:[[9,-10]],
    outputWeights:[11,12],
    diagnostics:{nested:[13,14]}
  };
  const reference=scratch;
  const reset=resetGradientBuffer(scratch);
  assert.equal(reset,reference,'reset must preserve the reusable scratch object identity');
  assert.deepEqual(scratch,{
    projectionWeights:[[0,0],[0,0]],
    depthWeights:[[[0,0],[0,0]]],
    biases:[[0,0]],
    outputWeights:[0,0],
    diagnostics:{nested:[0,0]}
  });
});

test('cached TCN baseline vector accepts exactly 58 finite pooled features',()=>{
  assert.equal(TEMPORAL_POOLED_BASELINE_FEATURE_COUNT,58);
  assert.equal(isValidTemporalPooledBaselineFeatures(Array(58).fill(0)),true,
    'the cache contains 29 full-window means plus 29 recent-window means');
  assert.equal(isValidTemporalPooledBaselineFeatures(Array(29).fill(0)),false,
    'the raw 29-channel count is not the pooled baseline vector length');
  const invalid=Array(58).fill(0);
  invalid[17]=Number.NaN;
  assert.equal(isValidTemporalPooledBaselineFeatures(invalid),false,
    'non-finite cached features must be rejected and recomputed safely');
});

function sequenceFor(up,index=0){
  return Array.from({length:TEMPORAL_SEQUENCE_STEPS},(_,step)=>{
    const pulse=Math.sin((step+index%7)*0.31)*0.04;
    return up
      ?[0.9+pulse,1.2,0.8,1.1,0.7,0.5,-0.2,0.9,1.25,1.1,0.8,0.7,0.4,0.5,0.7,0.2,1.1,0.9,1.2,1.4,0.6,0.3,0.8,1.4,0.9,0.1,1.2,1.0,1]
      :[-0.9-pulse,-1.1,-0.8,-1.0,-0.7,-0.5,0.2,-0.9,-1.0,-0.8,-0.9,-0.7,-0.4,0.5,-0.8,0.9,-0.7,-0.6,-1.1,-1.3,0.7,0.9,-0.8,-1.4,-0.9,0.1,-1.2,-1.0,1];
  });
}
function sample(group,index,{up=null}={}){
  const signal=up===null?(index%2===0):up;
  const at=BASE_TIME+group*EIGHT_HOURS;
  return {
    id:'TCN-'+group+'-'+index,
    symbol:'PAIR'+String(index).padStart(3,'0')+'USDT',
    at,resolved_at:at+FOUR_HOURS,horizon_ms:FOUR_HOURS,
    training_eligible:true,historical_baseline:true,closed_candle_baseline:false,
    target_definition:TEMPORAL_TARGET_DEFINITION,
    outcome_source:'HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1',
    outcome:signal?'UP':'DOWN',return_pct:signal?2.4:-2.2,
    first_passage:{hit:signal?'TAKE_PROFIT_REACHED_FIRST':'STOP_LEVEL_REACHED_FIRST',
      outcome:signal?'UP':'DOWN',path_resolution:'15M'},
    temporal_sequence:sequenceFor(signal,group+index)
  };
}

test('temporal target encodes only an actual +3% first-passage as success',()=>{
  assert.equal(temporalBinaryTarget('UP'),1);
  assert.equal(temporalBinaryTarget('DOWN'),0);
  assert.equal(temporalBinaryTarget('FLAT'),0);
});

test('TCN baseline gates require a strict 0.003 Brier improvement',()=>{
  assert.equal(TEMPORAL_BRIER_SUPERIORITY_MARGIN,0.003);
  assert.equal(hasTemporalBrierSuperiority(0.4,0.4029),false,
    'a 0.0029 improvement must not pass the policy gate');
  assert.equal(hasTemporalBrierSuperiority(0.4,0.403),false,
    'an improvement equal to the required margin must not pass a strict gate');
  assert.equal(hasTemporalBrierSuperiority(0.4,0.4031),true,
    'an improvement greater than 0.003 must pass');
  assert.equal(hasTemporalBrierSuperiority(null,0.5),false,
    'missing metrics must fail closed');
});

test('temporal network fails closed without first-passage tensor samples',()=>{
  const profile=buildTemporalNeuralProfile([]);
  assert.equal(profile.probability_ready,false);
  assert.equal(profile.live_eligibility_ready,false);
  assert.equal(profile.trained,false);
  assert.equal(predictTemporalProbability(sequenceFor(true),profile),null);
  assert.equal(profile.target_definition,TEMPORAL_TARGET_DEFINITION);
  assert.equal(profile.temporal_label_resolution,'15M_ONLY');
});

test('temporal boosted trees compete on the same first-passage target with regime-local purged blocks',()=>{
  const rows=[];
  const groups=70,perGroup=20;
  for(let group=0;group<groups;group++){
    for(let index=0;index<perGroup;index++){
      const volumeState=index%2===0;
      const compressionState=Math.floor(index/2)%2===0;
      const up=volumeState&&compressionState;
      const at=BASE_TIME+group*EIGHT_HOURS;
      const sequence=Array.from({length:TEMPORAL_SEQUENCE_STEPS},()=>{
        const step=Array(TEMPORAL_SEQUENCE_CHANNELS).fill(0);
        step[0]=volumeState?1.2:-1.2;
        step[1]=compressionState?1.1:-1.1;
        step[19]=-0.5; // BTC risk-off: a single independent regime specialist.
        return step;
      });
      rows.push({
        id:'TEMPORAL-AND-'+group+'-'+index,
        symbol:'ANDPAIR'+String(index).padStart(2,'0')+'USDT',
        at,resolved_at:at+FOUR_HOURS,horizon_ms:FOUR_HOURS,
        training_eligible:true,historical_baseline:true,closed_candle_baseline:false,
        target_definition:TEMPORAL_TARGET_DEFINITION,
        outcome_source:'HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1',
        outcome:up?'UP':'DOWN',return_pct:up?3.2:-2.3,
        first_passage:{hit:up?'TAKE_PROFIT_REACHED_FIRST':'STOP_LEVEL_REACHED_FIRST',
          outcome:up?'UP':'DOWN',path_resolution:'15M'},
        temporal_sequence:sequence
      });
    }
  }
  const profile=buildTemporalNeuralProfile(rows,{
    epochs:2,minimumHoldoutSamples:150,liveHoldoutSamples:150
  });
  const tree=profile.temporal_boosted_tree;
  assert.ok(tree,'the first-passage challenger diagnostics must always be present');
  assert.equal(tree.model_kind,'TEMPORAL_FIRST_PASSAGE_RESIDUAL_GBDT_V1');
  assert.equal(tree.target_definition,TEMPORAL_TARGET_DEFINITION);
  assert.equal(tree.architecture,'TEMPORAL_POOLED_58_NEWTON_GBDT_DEPTH2_24_ROUNDS');
  assert.equal(tree.trained,true);
  assert.ok(tree.regime_specialists.BTC_RISK_OFF.tree_count>0);
  const expert=tree.regime_specialists.BTC_RISK_OFF;
  assert.equal(expert.supported,true);
  assert.equal(expert.selection_passed,true);
  assert.equal(expert.validation_passed,true,JSON.stringify({
    status:expert.status,selection:expert.selection_brier,
    selection_logistic:expert.selection_logistic_brier,
    validation:expert.validation,validation_logistic:expert.validation_logistic
  }));
  assert.equal(expert.holdout_passed,true,JSON.stringify({
    status:expert.status,holdout:expert.holdout,holdout_logistic:expert.holdout_logistic
  }));
  assert.ok(expert.max_training_outcome_resolved_at<expert.training_cutoff_at);
  assert.ok(expert.training_cutoff_at<expert.member_selection_cutoff_at);
  assert.ok(expert.member_selection_cutoff_at<expert.calibration_cutoff_at);
  assert.ok(expert.calibration_cutoff_at<=expert.validation_start_at);
  assert.ok(expert.validation_start_at<profile.holdout_start_at);
  assert.ok(expert.holdout.sample_count>=150);
  assert.ok(expert.validation.model_brier_score+0.003<
    expert.validation_logistic.model_brier_score);
  assert.ok(expert.holdout.model_brier_score+0.003<
    expert.holdout_logistic.model_brier_score);
  assert.ok(expert.feature_importance.length>0);
  assert.ok(Math.abs(expert.feature_importance.reduce((sum,row)=>
    sum+row.gain_share_pct,0)-100)<0.1);
  assert.ok(tree.holdout_comparison.passed);
});

test('temporal network trains only on valid tensors and keeps chronological validation and holdout separate',()=>{
  const rows=[];
  for(let group=0;group<32;group++){
    for(let index=0;index<36;index++){
      const row=sample(group,index,{up:index<8});
      // Keep enough distinct rows in each chronological regime block for the
      // independent 30-row probability-calibration gate to be testable.
      // see both UP and DOWN outcomes within its own market regime.
      row.temporal_sequence=row.temporal_sequence.map(step=>{
        const copy=step.slice();
        copy[19]=group%2===0?1.35:-1.35;
        return copy;
      });
      rows.push(row);
    }
  }
  rows.push({...sample(0,999),id:'BAD-LEGACY',outcome_source:'HISTORICAL_CLOSED_CANDLE'});
  rows.push({...sample(0,998),id:'BAD-SEQUENCE',temporal_sequence:[[1,2]]});
  const profile=buildTemporalNeuralProfile(rows,{epochs:2,minimumHoldoutSamples:80});
  assert.equal(profile.resolved_samples,32*36);
  assert.equal(profile.trained,true,JSON.stringify({
    status:profile.status,
    training_samples:profile.training_samples,
    validation_samples:profile.validation_samples,
    holdout_samples:profile.holdout_samples,
    shared_model_training_cutoff_at:profile.shared_model_training_cutoff_at,
    shared_model_member_selection_cutoff_at:profile.shared_model_member_selection_cutoff_at,
    shared_model_selection_cutoff_at:profile.shared_model_selection_cutoff_at,
    supported_regimes:profile.supported_regimes,
    regime_specialists:profile.regime_specialists
  }));
  assert.equal(profile.architecture,TEMPORAL_MODEL_ARCHITECTURE);
  assert.equal(profile.ensemble_members,3);
  assert.equal(profile.training_strategy,'SHARED_POOLED_TCN_TRAIN_ONLY_SELECTION_CALIBRATION_V1');
  assert.equal(profile.gradient_accumulation,TEMPORAL_GRADIENT_ACCUMULATION);
  assert.equal(profile.gradient_accumulation,'IN_PLACE_WEIGHTED_SUM_V1',
    'full-batch gradient accumulation must reuse its epoch buffers instead of allocating one copy per sample');
  assert.equal(profile.baseline_feature_cache,TEMPORAL_BASELINE_FEATURE_CACHE);
  assert.equal(profile.baseline_feature_cache,'PER_ROW_POOLED_FEATURES_REUSED_ACROSS_EPOCHS_AND_MEMBERS_V1',
    'immutable pooled input features must be computed once per sample, not once per epoch');
  assert.equal(profile.gradient_buffer_scope,TEMPORAL_GRADIENT_BUFFER_SCOPE);
  assert.equal(profile.gradient_buffer_scope,'TRAINABLE_PARAMETERS_ONLY_REUSED_ROW_SCRATCH_V1',
    'per-sample backprop must reuse only the trainable gradient buffers and exclude frozen/model metadata arrays');
  assert.equal(profile.training_objective,'DIVERSE_PROPER_SCORING_RULE_TCN_ENSEMBLE_WITH_TRAIN_ONLY_CLASS_BALANCE_V1');
  assert.equal(profile.model_scope,'SHARED_POOLED_TCN_WITH_PER_REGIME_OUTER_GATES_AND_POOLED_LOGISTIC_ANCHOR');
  assert.equal(profile.member_selection_method,'SHARED_POOLED_CHRONOLOGICAL_MEMBER_AND_RESIDUAL_SCALE_SELECTION_BRIER');
  assert.equal(profile.regime_model_training_samples,profile.training_samples);
  assert.equal(profile.baseline_anchor,'SHARED_POOLED_TRAINING_ONLY_LOGISTIC_FROZEN');
  assert.equal(profile.residual_scale_selection,'SHARED_POOLED_SELECTION_BLOCK_BRIER_GRID_V1');
  assert.equal(profile.training_objective,'DIVERSE_PROPER_SCORING_RULE_TCN_ENSEMBLE_WITH_TRAIN_ONLY_CLASS_BALANCE_V1');
  assert.deepEqual(profile.candidate_residual_scales,[0,0.1,0.25,0.5,1]);
  assert.equal(profile.member_training_profiles.length,3);
  assert.equal(profile.member_training_profiles[0].trainingObjective,'UNWEIGHTED_BRIER_PROPER_SCORING_RULE');
  assert.equal(profile.member_training_profiles[1].trainingObjective,'UNWEIGHTED_LOG_LOSS_PROPER_SCORING_RULE');
  assert.equal(profile.member_training_profiles[2].trainingObjective,'MIXED_BRIER_LOG_LOSS_50_50_PROPER_SCORING_RULE');
  assert.equal(profile.member_training_profiles[2].positiveClassWeighting,'SQRT_INVERSE_PREVALENCE');
  assert.ok(profile.member_training_profiles.every(row=>
    Number.isFinite(Number(row.latentChannels))&&Number.isFinite(Number(row.trainableParameters))),
    'all members retain the fixed causal TCN architecture contract');
  assert.equal(new Set(profile.member_training_profiles.map(row=>JSON.stringify(row))).size,3,
    'ensemble members must use distinct deterministic training schedules');
  assert.equal(profile.sequence_steps,24);
  assert.equal(profile.sequence_channels,29);
  assert.equal(profile.latent_channels,TEMPORAL_LATENT_CHANNELS);
  assert.equal(profile.trainable_parameter_count,TEMPORAL_TRAINABLE_PARAMETER_COUNT);
  assert.equal(TEMPORAL_LATENT_CHANNELS,16);
  assert.equal(TEMPORAL_TRAINABLE_PARAMETER_COUNT,1408,
    'the learned 29-to-16 projection must keep the expanded residual under 1,500 parameters');
  assert.ok(profile.member_training_profiles.every(row=>
    row.latentChannels===16&&row.trainableParameters===1408));
  assert.ok(profile.training_samples>=160);
  assert.equal(profile.training_samples,profile.shared_model_training_samples);
  assert.ok(profile.shared_model_selection_samples>=10);
  assert.ok(profile.shared_model_calibration_samples>=30);
  assert.ok(profile.shared_model_training_cutoff_at<profile.shared_model_member_selection_cutoff_at);
  assert.ok(profile.shared_model_member_selection_cutoff_at<profile.shared_model_selection_cutoff_at);
  assert.ok(profile.shared_model_selection_cutoff_at<=profile.outer_validation_start_at);
  assert.ok(profile.outer_validation_start_at<profile.outer_holdout_start_at);
  assert.ok(profile.max_training_outcome_resolved_at<profile.shared_model_training_cutoff_at);
  assert.ok(profile.validation_samples>=50);
  assert.ok(profile.holdout_samples>=40,
    'small research fixtures use the 40-sample research minimum; live readiness still requires 100');
  assert.equal(profile.training_positive_count+profile.training_negative_count,profile.training_samples);
  assert.equal(profile.regime_model_training_samples,profile.training_samples);
  assert.equal(profile.model_split_scope,'SHARED_POOLED_CHRONOLOGICAL_PURGED_WALK_FORWARD_WITH_REGIME_GATES_V1');
  for(const regime of profile.supported_regimes){
    const specialist=profile.regime_specialists[regime];
    assert.ok(specialist.max_training_outcome_resolved_at<specialist.training_cutoff_at);
    assert.ok(specialist.training_cutoff_at<specialist.member_selection_cutoff_at);
    assert.ok(specialist.member_selection_cutoff_at<specialist.calibration_cutoff_at);
    assert.ok(specialist.calibration_cutoff_at<=specialist.validation_start_at);
  }
  assert.ok(profile.validation.positive_rate_pct>=0&&profile.validation.positive_rate_pct<=100);
  assert.ok(profile.holdout.positive_rate_pct>=0&&profile.holdout.positive_rate_pct<=100);
  assert.ok(profile.max_training_outcome_resolved_at<profile.validation_start_at);
  assert.ok(profile.validation_start_at<profile.holdout_start_at);
  assert.equal(profile.holdout_comparison.sample_count,profile.holdout.sample_count,
    'the model comparison must report the exact number of holdout rows it actually scored');
  assert.ok(profile.holdout.sample_count>=40,
    'the holdout block must retain the full research sample count for diagnostics');
  assert.ok(profile.holdout_comparison.sample_count===profile.holdout.sample_count,
    'the comparison count must equal the number of rows actually scored');
  assert.equal(profile.live_eligibility_ready,false,
    'a small research holdout must never satisfy the 100-outcome live gate');
  if(profile.probability_ready){
    const probability=predictTemporalProbability(sequenceFor(true),profile);
    assert.ok(Number.isFinite(probability)&&probability>=0&&probability<=1);
  }else{
    assert.equal(predictTemporalProbability(sequenceFor(true),profile),null,
      'no temporal probability is published until validation and untouched holdout pass');
  }
});

test('shared TCN and temporal tree do not inspect outer validation or holdout before prior gates pass',()=>{
  const rows=[];
  for(let group=0;group<32;group++){
    for(let index=0;index<36;index++){
      const row=sample(group,index,{up:index<8});
      row.temporal_sequence=row.temporal_sequence.map(step=>{
        const copy=step.slice();copy[19]=1.35;return copy;
      });
      rows.push(row);
    }
  }
  const profile=buildTemporalNeuralProfile(rows,{epochs:2,comparisonMargin:1});
  assert.equal(profile.shared_model_selection_passed,false,
    'a deliberately unattainable test-only margin forces selection rejection');
  assert.equal(profile.validation.evaluated,false);
  assert.equal(profile.validation.pooled_logistic_brier_score,null);
  assert.equal(profile.holdout.evaluated,false);
  assert.equal(profile.holdout.pooled_logistic_brier_score,null);
  const shared=profile.regime_specialists.BTC_RISK_ON;
  assert.equal(shared.selected_member_index,-1);
  assert.equal(shared.probability_calibration.fitted,false);
  assert.equal(shared.logistic_probability_calibration.fitted,false);
  assert.equal(shared.validation_brier,null);
  assert.equal(shared.validation_pooled_logistic_brier,null);
  assert.equal(shared.holdout_brier,null);
  assert.equal(shared.holdout_pooled_logistic_brier,null);
  assert.equal(shared.validation_diagnostic_only,false);
  assert.equal(shared.holdout_diagnostic_only,false);
  const tree=profile.temporal_boosted_tree.regime_specialists.BTC_RISK_ON;
  assert.equal(tree.selection_passed,false);
  assert.equal(tree.calibration.fitted,false);
  assert.equal(tree.validation.evaluated,false);
  assert.equal(tree.validation_logistic.evaluated,false);
  assert.equal(tree.holdout.evaluated,false);
  assert.equal(tree.holdout_logistic.evaluated,false);
});

test('one shared TCN gates outer validation and untouched holdout independently by BTC regime',()=>{
  const rows=[];
  for(let group=0;group<32;group++){
    for(let index=0;index<36;index++){
      const row=sample(group,index,{up:index<8});
      row.temporal_sequence=row.temporal_sequence.map(step=>{
        const copy=step.slice();
        copy[19]=1.35;
        return copy;
      });
      rows.push(row);
    }
  }
  const profile=buildTemporalNeuralProfile(rows,{epochs:2});
  assert.equal(profile.trained,true);
  assert.equal(profile.regime_split_method,'SHARED_GLOBAL_TIME_SPLIT_WITH_REGIME_LOCAL_AUXILIARY_TREE_SPLITS_V1');
  assert.deepEqual(profile.supported_regimes,['BTC_RISK_ON']);
  const expert=profile.regime_specialists.BTC_RISK_ON;
  const innerGatePassed=expert.selected_member_index>=0&&expert.neural_residual_contributes&&
    expert.probability_calibration?.fitted===true&&
    expert.logistic_probability_calibration?.fitted===true;
  assert.equal(profile.validation.evaluated,innerGatePassed,
    'outer validation is scored only after a neural member clears selection and calibration');
  assert.equal(profile.holdout.evaluated,expert.selected===true,
    'untouched holdout is scored only after the outer validation gate passes');
  if(!innerGatePassed){
    assert.equal(expert.validation_brier,null);
    assert.equal(expert.validation_pooled_logistic_brier,null);
    assert.equal(expert.validation_diagnostic_only,false);
    assert.equal(expert.selection_calibration_samples,0);
    assert.equal(expert.logistic_calibration_samples,0);
  }
  if(!expert.selected){
    assert.equal(expert.holdout_brier,null);
    assert.equal(expert.holdout_pooled_logistic_brier,null);
    assert.equal(expert.holdout_diagnostic_only,false);
  }
  assert.equal(expert.model_scope,'SHARED_POOLED_TCN_WITH_PER_REGIME_OUTER_GATES');
  assert.equal(profile.training_strategy,'SHARED_POOLED_TCN_TRAIN_ONLY_SELECTION_CALIBRATION_V1');
  assert.equal(profile.training_objective,'DIVERSE_PROPER_SCORING_RULE_TCN_ENSEMBLE_WITH_TRAIN_ONLY_CLASS_BALANCE_V1');
  assert.equal(profile.model_scope,'SHARED_POOLED_TCN_WITH_PER_REGIME_OUTER_GATES_AND_POOLED_LOGISTIC_ANCHOR');
  assert.equal(profile.member_training_profiles_by_regime.BTC_RISK_ON.length,3);
  assert.equal(profile.member_training_profiles_by_regime.BTC_RISK_ON[2].positiveClassWeighting,'SQRT_INVERSE_PREVALENCE');
  const regimeMembers=profile.member_training_profiles_by_regime.BTC_RISK_ON;
  assert.equal(regimeMembers[0].trainingObjective,'UNWEIGHTED_BRIER_PROPER_SCORING_RULE');
  assert.equal(regimeMembers[1].trainingObjective,'UNWEIGHTED_LOG_LOSS_PROPER_SCORING_RULE');
  assert.equal(regimeMembers[2].trainingObjective,'MIXED_BRIER_LOG_LOSS_50_50_PROPER_SCORING_RULE');
  assert.equal(regimeMembers[2].positiveClassWeighting,'SQRT_INVERSE_PREVALENCE');
  assert.equal(expert.baseline_anchor_source,'SHARED_POOLED_TRAINING_ONLY');
  assert.equal(expert.baseline_anchor_training_samples,expert.shared_training_samples);
  assert.ok(expert.shared_training_samples>=160);
  assert.ok(expert.training_samples>=80);
  assert.equal(expert.training_samples,expert.regime_training_samples);
  assert.ok(expert.selection_samples>=10);
  assert.ok(expert.validation_samples>=24);
  assert.ok(expert.holdout_samples>=20);
  assert.ok(expert.max_training_outcome_resolved_at<expert.selection_start_at,
    'training labels must resolve before member selection begins');
  assert.equal(expert.probability_calibration.method,'CALIBRATION_BLOCK_SHRUNK_BRIER_PLATT_V2');
  assert.equal(expert.probability_calibration.fit_on,'SHARED_POOLED_CALIBRATION_BLOCK_TCN');
  assert.equal(expert.member_selection_source,'SHARED_POOLED_MEMBER_SELECTION_BLOCK');
  assert.equal(expert.calibration_source,'SHARED_POOLED_CALIBRATION_BLOCK');
  assert.equal(expert.neural_residual_contributes,expert.selected_residual_scale>0);
  assert.equal(expert.logistic_probability_calibration.fitted,innerGatePassed);
  assert.equal(expert.logistic_probability_calibration.sample_count,expert.selection_calibration_samples);
  assert.equal(expert.probability_calibration.sample_count,expert.selection_calibration_samples,
    'probability calibration may use only the disjoint later calibration block');
  assert.ok(expert.member_selection_samples>0);
  if(innerGatePassed)assert.ok(expert.selection_calibration_samples>0);
  else assert.equal(expert.selection_calibration_samples,0);
  if(innerGatePassed)assert.notEqual(expert.member_selection_samples,expert.selection_calibration_samples,
    'member ranking and probability calibration must not reuse the same rows');
  assert.equal(expert.probability_calibration.fit_on,'SHARED_POOLED_CALIBRATION_BLOCK_TCN');
  assert.equal(expert.logistic_probability_calibration.fitted,true);
  assert.equal(expert.logistic_probability_calibration.sample_count,expert.selection_calibration_samples,
    'the logistic challenger must be calibrated on the exact same regime-local later block');
  if(innerGatePassed)assert.ok(Number.isFinite(profile.validation.pooled_logistic_brier_score));
  else assert.equal(profile.validation.pooled_logistic_brier_score,null);
  if(expert.selected)assert.ok(Number.isFinite(profile.holdout.pooled_logistic_brier_score));
  else assert.equal(profile.holdout.pooled_logistic_brier_score,null);
  assert.equal(profile.calibration_fit_scope,'SHARED_POOLED_CALIBRATION_BLOCK_ONLY');
  assert.equal(profile.training_strategy,'SHARED_POOLED_TCN_TRAIN_ONLY_SELECTION_CALIBRATION_V1');
  assert.equal(profile.training_objective,'DIVERSE_PROPER_SCORING_RULE_TCN_ENSEMBLE_WITH_TRAIN_ONLY_CLASS_BALANCE_V1');
  assert.equal(profile.model_scope,'SHARED_POOLED_TCN_WITH_PER_REGIME_OUTER_GATES_AND_POOLED_LOGISTIC_ANCHOR');
  assert.equal(typeof expert.member_selection_logistic_brier,'number');
  assert.ok(expert.member_selection_scores.every(row=>
    typeof row.beats_same_window_logistic==='boolean'));
  assert.ok(expert.selection_start_at<expert.calibration_start_at&&
    expert.calibration_start_at<expert.validation_start_at,
    'member selection, calibration and reported validation must use three disjoint chronological blocks');
  assert.ok(expert.validation_start_at<profile.holdout_start_at,
    'final holdout must remain strictly later than all fitting and selection data');
  assert.equal(profile.regime_specialists.BTC_RISK_OFF.status,'WAITING_FOR_REGIME_SPECIALIST_SAMPLE_COVERAGE');
  assert.ok(profile.regime_specialists.BTC_RISK_OFF.support_gaps.includes('HOLDOUT_SAMPLE_COUNT'));
  assert.equal(profile.holdout_comparison.sample_count,expert.selected?profile.holdout.sample_count:0);
  assert.equal(profile.holdout_comparison.sample_count,profile.holdout.sample_count,
    'comparison sample count must describe rows actually evaluated');
  for(const regime of profile.supported_regimes){
    const specialist=profile.regime_specialists[regime];
    assert.ok(specialist.logistic_calibration_samples>=0);
    assert.equal(specialist.neural_residual_contributes,
      specialist.selected_residual_scale>0,
      'zero residual scale is not a neural-network contribution');
    if(!specialist.neural_residual_contributes){
      assert.equal(specialist.selected,false);
      assert.equal(specialist.probability_ready,false);
    }
  }
});

test('mature history reserves a broad untouched holdout and a wider regime-supported validation block',()=>{
  // 90×20 preserves the 60% regime-local training floor after reserving
  // the unchanged 25% untouched holdout and 300-row validation blocks.
  const rows=[];
  for(let group=0;group<90;group++){
    for(let index=0;index<20;index++){
      const row=sample(group,index);
      const btcRiskOn=group%2===0;
      row.temporal_sequence=row.temporal_sequence.map(step=>{
        const copy=step.slice();
        copy[19]=btcRiskOn?1.35:-1.35;
        return copy;
      });
      rows.push(row);
    }
  }
  const profile=buildTemporalNeuralProfile(rows,{epochs:2});
  assert.equal(profile.trained,true);
  assert.ok(profile.holdout_samples>=Math.max(300,Math.ceil(rows.length*0.25)),
    'mature history must retain at least twice the live holdout floor and 25% untouched samples');
  assert.ok(profile.regime_model_training_samples>=600,
    'the bounded holdout must leave a larger purged chronological block for temporal fitting');
  assert.deepEqual(profile.shared_model_split_fractions,
    {training:0.60,memberSelection:0.76,calibration:0.995},
    'mature histories must retain distinct member selection and broaden regime-local calibration without moving outer validation or holdout');
  assert.ok(profile.validation_samples>=300,
    'mature histories must reserve at least 300 observations for inner TCN validation');
  assert.deepEqual(profile.supported_regimes,['BTC_RISK_ON','BTC_RISK_OFF']);
  for(const regime of ['BTC_RISK_ON','BTC_RISK_OFF']){
    const expert=profile.regime_specialists[regime];
    assert.ok(expert.holdout_samples>=20);
    assert.ok([0,0.1,0.25,0.5,1].includes(expert.selected_residual_scale));
    assert.ok(expert.holdout_positive_samples>=5);
    assert.ok(expert.holdout_negative_samples>=20);
    assert.ok(expert.validation_start_at<profile.holdout_start_at);
  }
});

test('shared TCN learns pooled selection/calibration but keeps the outer regime gate local',()=>{
  const rows=[];
  for(let group=0;group<32;group++){
    let riskOn=true;
    if(group===15||group===16||group===18||group===20||group===23||group===25||group===27||group===31)riskOn=false;
    for(let index=0;index<12;index++){
      let up;
      if(group>=12&&group<=17&&riskOn)up=false;
      else if(group===15||group===16)up=index<3;
      else if(group===18)up=index<4;
      else if(group>=28&&group<=30)up=index<5;
      else if(riskOn&&[8,9,10,11,17,19,21,22,23,24,25,26,27].includes(group))up=false; // remove positive labels from the actual local selection window
      else if(group>=17&&group<=27)up=index<2;
      else up=index<2;
      const row=sample(group,index,{up});
      row.temporal_sequence=row.temporal_sequence.map(step=>{
        const copy=step.slice();
        copy[19]=riskOn?1.35:-1.35;
        return copy;
      });
      rows.push(row);
    }
  }
  const profile=buildTemporalNeuralProfile(rows,{epochs:2,minTrainingSamples:120});
  const expert=profile.regime_specialists.BTC_RISK_ON;
  assert.ok(expert.shared_training_samples>=120);
  assert.ok(expert.training_samples>=80);
  assert.equal(expert.training_samples,expert.regime_training_samples);
  assert.ok(expert.local_selection_samples>=30&&expert.local_selection_samples<expert.member_selection_samples,
    'only the local outer regime is counted separately from the pooled member-selection block');
  assert.equal(expert.local_selection_positive_samples,0);
  assert.equal(expert.member_selection_source,'SHARED_POOLED_MEMBER_SELECTION_BLOCK');
  assert.ok(expert.member_selection_samples>expert.local_selection_samples);
  assert.ok(expert.pooled_selection_diagnostic_positive_samples>0);
  assert.ok(expert.local_calibration_samples>=30,
    'local-regime calibration coverage remains visible while pooled calibrator can use both regimes');
  assert.equal(expert.calibration_source,'SHARED_POOLED_CALIBRATION_BLOCK');
  assert.ok(expert.calibration_samples>expert.local_calibration_samples);
  assert.ok(expert.pooled_calibration_diagnostic_positive_samples>0);
  assert.ok(expert.support_gaps.includes('VALIDATION_POSITIVE_CLASS'),
    'the specialist remains unavailable because its own later validation block lacks positive outcomes');
  assert.equal(expert.selected,false);
  assert.equal(expert.probability_ready,false);
  assert.equal(expert.probability_calibration?.fitted,true);
  assert.equal(expert.selected,false);
  assert.equal(expert.probability_ready,false,
    'a regime with unsupported validation outcomes must not publish a temporal probability');
  assert.equal(profile.live_eligibility_ready,false);
});

test('TCN fits, selects and calibrates each specialist only on its own BTC regime',()=>{
  const rows=[];
  // 100 chronological groups preserve separate regime-local fitting,
  // member-selection and larger calibration blocks before outer validation
  // and the untouched final holdout.
  for(let group=0;group<100;group++){
    const riskOn=group%2===0;
    for(let index=0;index<7;index++){
      let up;
      if(group>=85)up=index===0;          // untouched holdout: one positive per group
      else if(group>=61)up=index<2;       // outer validation: two positives per group
      else if(group>=48)up=index<2;       // local calibration: >=35 matured rows per regime
      else if(group>=33)up=index%2===0;  // local member-selection block
      else up=index<2;                    // independent training for both regimes
      const row=sample(group,index,{up});
      row.temporal_sequence=row.temporal_sequence.map(step=>{
        const copy=step.slice();
        copy[19]=riskOn?1.35:-1.35;
        return copy;
      });
      rows.push(row);
    }
  }
  const profile=buildTemporalNeuralProfile(rows,{epochs:2,minimumHoldoutSamples:80});
  assert.equal(profile.trained,true);
  assert.deepEqual(profile.supported_regimes,['BTC_RISK_ON','BTC_RISK_OFF']);
  for(const regime of ['BTC_RISK_ON','BTC_RISK_OFF']){
    const expert=profile.regime_specialists[regime];
    assert.equal(expert.member_selection_source,'SHARED_POOLED_MEMBER_SELECTION_BLOCK');
    assert.ok(expert.shared_calibration_samples>=30,
      'each BTC regime needs at least 30 matured calibration rows of its own');
    assert.equal(expert.calibration_source,'SHARED_POOLED_CALIBRATION_BLOCK');
    assert.ok(expert.calibration_samples>expert.local_calibration_samples);
  assert.ok(expert.pooled_calibration_diagnostic_positive_samples>0);
    assert.ok(expert.calibration_targets.positive>=5);
    assert.ok(expert.calibration_targets.negative>=20);
    assert.equal(expert.probability_calibration.fit_on,'SHARED_POOLED_CALIBRATION_BLOCK_TCN');
    assert.equal(expert.probability_calibration.fitted,true);
    assert.equal(expert.logistic_probability_calibration.fitted,true);
    assert.ok(expert.max_training_outcome_resolved_at<expert.selection_start_at);
    assert.ok(expert.selection_start_at<expert.calibration_start_at);
    assert.ok(expert.calibration_start_at<expert.validation_start_at);
    assert.ok(expert.validation_start_at<profile.holdout_start_at);
  }
  assert.equal(profile.live_eligibility_ready,false,
    'a research fixture must not satisfy the 150-outcome live holdout requirement');
});

test('independent regime-local TCNs train, select and calibrate only on their own purged BTC regime',()=>{
  const rows=[];
  for(let group=0;group<100;group++){
    const riskOn=group%2===0;
    for(let index=0;index<7;index++){
      let up;
      if(group>=85)up=index===0;
      else if(group>=61)up=index<2;
      else if(group>=48)up=index<2;
      else if(group>=33)up=index%2===0;
      else up=index<2;
      const row=sample(group,index,{up});
      row.temporal_sequence=row.temporal_sequence.map(step=>{
        const copy=step.slice();
        copy[19]=riskOn?1.35:-1.35;
        return copy;
      });
      rows.push(row);
    }
  }
  const profile=buildTemporalNeuralProfile(rows,{
    epochs:2,minimumHoldoutSamples:80,
    enableRegimeLocalTcn:true,
    regimeLocalTcnMaxTrainingSamples:80,
    regimeLocalTcnEpochs:1,
    enableRegimeLocalTcnPyramid:true,
    regimeLocalTcnPyramidMaxTrainingSamples:80,
    regimeLocalTcnPyramidEpochs:1,
    enableRegimeLocalTcnMultiscale:true,
    regimeLocalTcnMultiscaleMaxTrainingSamples:80,
    regimeLocalTcnMultiscaleEpochs:1
  });
  const local=profile.regime_local_tcn_challenger;
  assert.equal(local.model_kind,'INDEPENDENT_REGIME_LOCAL_TCN_V1');
  assert.equal(local.training_strategy,'INDEPENDENT_BTC_REGIME_TCN_RECENT_4096_TRAIN_ONLY_V1');
  assert.equal(local.model_scope,'INDEPENDENT_BTC_REGIME_TCN_WITH_REGIME_LOCAL_LOGISTIC_ANCHOR');
  assert.deepEqual(local.supported_regimes,['BTC_RISK_ON','BTC_RISK_OFF'],JSON.stringify(local.regime_specialists,null,2));
  assert.equal(local.probability_ready,false,
    'the research challenger cannot unlock production probability or live execution');
  const on=local.regime_specialists.BTC_RISK_ON;
  const off=local.regime_specialists.BTC_RISK_OFF;
  for(const [regime,expert] of [['BTC_RISK_ON',on],['BTC_RISK_OFF',off]]){
    assert.equal(expert.trained,true,regime+' must have an independently fitted TCN');
    assert.equal(expert.baseline_anchor_source,'REGIME_LOCAL_TRAINING_ONLY');
    assert.ok(expert.training_samples>=80&&expert.training_samples<=80);
    assert.ok(expert.training_sample_fingerprint);
    assert.ok(expert.selection_sample_fingerprint);
    assert.ok(expert.calibration_sample_fingerprint);
    assert.equal(expert.chronology_valid,true);
    assert.ok(expert.max_training_outcome_resolved_at<expert.selection_start_at);
    assert.ok(expert.max_selection_outcome_resolved_at<expert.calibration_start_at);
    assert.ok(expert.max_calibration_outcome_resolved_at<expert.validation_start_at);
    assert.ok(expert.validation_start_at<expert.holdout_start_at);
    assert.equal(expert.training_targets.positive+expert.training_targets.negative,
      expert.training_samples);
    assert.equal(expert.selection_targets.positive+expert.selection_targets.negative,
      expert.selection_samples);
    assert.equal(expert.calibration_targets.positive+expert.calibration_targets.negative,
      expert.calibration_samples);
    assert.equal(expert.probability_calibration.fit_on,'REGIME_LOCAL_TCN_CALIBRATION_BLOCK');
    assert.equal(expert.logistic_probability_calibration.fit_on,'REGIME_LOCAL_LOGISTIC_CALIBRATION_BLOCK');
    assert.equal(expert.probability_calibration.sample_count,
      expert.probability_calibration.fitted?expert.calibration_samples:0);
    assert.equal(expert.logistic_probability_calibration.sample_count,
      expert.logistic_probability_calibration.fitted?expert.calibration_samples:0);
    if(!expert.validation_passed){
      assert.equal(expert.holdout.evaluated,false,
        'the untouched holdout must remain unscored until the local outer validation gate passes');
    }
    if(!expert.holdout_passed){
      assert.equal(expert.probability_ready,false);
    }
  }
  assert.notEqual(on.training_sample_fingerprint,off.training_sample_fingerprint,
    'risk-on and risk-off must not share the same fitted training rows');
  assert.notEqual(on.baseline_anchor_fingerprint,off.baseline_anchor_fingerprint,
    'each regime must have its own training-only logistic anchor');
  assert.equal(local.holdout_comparison.passed,
    local.selected_regimes.length>0&&local.holdout.evaluated===true&&
      local.holdout_logistic.evaluated===true&&
      local.holdout.model_brier_score+0.003<local.holdout_logistic.model_brier_score);

  const pyramid=profile.regime_local_tcn_pyramid_challenger;
  assert.equal(pyramid.model_kind,'INDEPENDENT_REGIME_LOCAL_TCN_ORDERED_PYRAMID_V1');
  assert.equal(pyramid.temporal_pooling,TEMPORAL_ORDERED_POOLING_MODE);
  assert.equal(pyramid.pooling_segments,4);
  assert.equal(pyramid.output_features,64);
  assert.equal(pyramid.trainable_parameter_count,1456);
  assert.deepEqual(pyramid.supported_regimes,['BTC_RISK_ON','BTC_RISK_OFF']);
  assert.equal(pyramid.probability_ready,false);
  for(const [regime,expert] of Object.entries(pyramid.regime_specialists)){
    assert.equal(expert.trained,true,regime+' ordered-pooling TCN must train independently');
    assert.equal(expert.temporal_pooling,TEMPORAL_ORDERED_POOLING_MODE);
    assert.equal(expert.output_features,64);
    assert.equal(expert.trainable_parameter_count,1456);
    assert.equal(expert.model_architecture,TEMPORAL_ORDERED_POOLING_MODEL_ARCHITECTURE);
    assert.ok(expert.member_training_profiles.every(row=>
      row.temporalPoolingMode===TEMPORAL_ORDERED_POOLING_MODE&&row.trainableParameters===1456));
    assert.equal(expert.chronology_valid,true);
    if(!expert.validation_passed)assert.equal(expert.holdout.evaluated,false);
    assert.equal(expert.probability_ready,false);
  }
  const multiscale=profile.regime_local_tcn_multiscale_challenger;
  assert.equal(multiscale.model_kind,'INDEPENDENT_REGIME_LOCAL_TCN_MULTISCALE_READOUT_V1');
  assert.equal(multiscale.temporal_pooling,TEMPORAL_MULTISCALE_POOLING_MODE);
  assert.equal(multiscale.pooling_segments,4);
  assert.equal(multiscale.output_features,192);
  assert.equal(multiscale.trainable_parameter_count,1888);
  assert.equal(multiscale.probability_ready,false,
    'V10 must remain research-only regardless of training success');
  assert.deepEqual(multiscale.supported_regimes,['BTC_RISK_ON','BTC_RISK_OFF']);
  for(const [regime,expert] of Object.entries(multiscale.regime_specialists)){
    assert.equal(expert.trained,true,regime+' V10 TCN must train independently');
    assert.equal(expert.temporal_pooling,TEMPORAL_MULTISCALE_POOLING_MODE);
    assert.equal(expert.output_features,192);
    assert.equal(expert.trainable_parameter_count,1888);
    assert.equal(expert.model_architecture,TEMPORAL_MULTISCALE_MODEL_ARCHITECTURE);
    assert.equal(expert.model_training_strategy,
      'INDEPENDENT_BTC_REGIME_TCN_FULL_RF31_MEAN_ENDPOINT_SLOPE_POOLING_V1');
    assert.ok(expert.member_training_profiles.every(row=>
      row.temporalPoolingMode===TEMPORAL_MULTISCALE_POOLING_MODE&&
      row.trainableParameters===1888));
    assert.equal(expert.chronology_valid,true);
    assert.equal(expert.probability_ready,false);
    if(!expert.validation_passed)assert.equal(expert.holdout.evaluated,false);
  }
  assert.equal(profile.architecture,TEMPORAL_MODEL_ARCHITECTURE,
    'the established shared TCN V8 control must remain unchanged');
  assert.equal(local.model_kind,'INDEPENDENT_REGIME_LOCAL_TCN_V1',
    'the original independent TCN remains available as a control');
});

test('thin BTC regime uses shared TCN weights but cannot publish a logistic-only substitute',()=>{
  const rows=[];
  for(let group=0;group<80;group++){
    const riskOn=group%2===0;
    for(let index=0;index<20;index++){
      const up=riskOn?group>=56&&index<6:index%4===0;
      const row=sample(group,index,{up});
      row.temporal_sequence=row.temporal_sequence.map(step=>{
        const copy=step.slice();copy[19]=riskOn?1.35:-1.35;return copy;
      });
      rows.push(row);
    }
  }
  const profile=buildTemporalNeuralProfile(rows,{epochs:1});
  const on=profile.regime_specialists.BTC_RISK_ON;
  const off=profile.regime_specialists.BTC_RISK_OFF;
  assert.equal(on.baseline_anchor_source,'SHARED_POOLED_TRAINING_ONLY');
  assert.equal(on.baseline_anchor_local_positive_samples,0);
  assert.equal(on.baseline_anchor_training_samples,profile.training_samples);
  assert.equal(on.training_positive_samples,0);
  assert.ok(profile.shared_model_training_targets.positive>0);
  assert.equal(on.baseline_anchor_source,'SHARED_POOLED_TRAINING_ONLY');
  assert.equal(on.neural_residual_contributes,on.selected_residual_scale>0);
  if(!on.neural_residual_contributes){assert.equal(on.selected,false);assert.equal(on.probability_ready,false);}
  assert.equal(off.baseline_anchor_source,'SHARED_POOLED_TRAINING_ONLY');
  assert.equal(profile.live_eligibility_ready,false,
    'live readiness still requires every supported regime to pass its untouched holdout');
});

test('V5, GBDT, hybrid and TCN consume identical first-passage rows and outer holdout',()=>{
  const rows=[];
  const groups=32,perGroup=36;
  for(let group=0;group<groups;group++){
    const riskOn=group%2===0;
    for(let index=0;index<perGroup;index++){
      const up=index%4===0;
      const row=sample(group,index,{up});
      row.temporal_sequence=row.temporal_sequence.map(step=>{
        const copy=step.slice();
        copy[19]=riskOn?1.35:-1.35;
        return copy;
      });
      row.features={
        volume_ratio:up?2.1:0.8,trade_ratio:up?1.7:0.85,
        taker_buy_ratio:up?0.62:0.44,close_location:up?0.82:0.32,
        higher_low:up,breakout_above_prior_high:false,
        compression_ratio:up?0.68:1.15,relative_strength_vs_btc_pct:up?1.1:-0.7,
        recent_15m_return_pct:up?0.45:-0.55,trend_aligned:up,
        micro_5m_available:true,micro_5m_taker_buy_ratio:up?0.61:0.43
      };
      rows.push(row);
    }
  }
  const profile=buildCognitiveLearningProfile(rows,{
    temporalSamples:rows,
    temporalOptions:{epochs:1},
    allowedOutcomeSources:['HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1'],
    iterations:30,neuralIterations:30
  });
  const temporal=profile.temporal_network;
  const contract=profile.comparison_contract;
  assert.equal(contract.target_definition,TEMPORAL_TARGET_DEFINITION);
  assert.equal(contract.sample_identity_matches,true);
  assert.equal(contract.shared_outer_split_applied,true);
  assert.equal(contract.sample_fingerprint,contract.temporal_sample_fingerprint);
  assert.equal(contract.validation_start_at,temporal.outer_validation_start_at);
  assert.equal(contract.holdout_start_at,temporal.outer_holdout_start_at);
  assert.equal(contract.validation_sample_count_matches,true);
  assert.equal(contract.holdout_sample_count_matches,true);
  assert.equal(contract.validation_samples,contract.temporal_validation_samples);
  assert.equal(contract.holdout_samples,contract.temporal_holdout_samples);
  assert.equal(profile.neural_network.target_definition,TEMPORAL_TARGET_DEFINITION);
  assert.equal(temporal.target_definition,TEMPORAL_TARGET_DEFINITION);
  assert.equal(profile.neural_network.holdout.sample_count,contract.holdout_samples);
  assert.equal(contract.holdout_samples,temporal.outer_holdout_samples);
});

test('cognitive challenger refuses shared-split claims when its rows differ from TCN',()=>{
  const row={
    ...sample(0,0),
    features:{volume_ratio:1.8,trade_ratio:1.4,taker_buy_ratio:0.58,close_location:0.7},
  };
  const profile=buildCognitiveLearningProfile([row],{
    temporalSamples:[],
    allowedOutcomeSources:['HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1']
  });
  assert.equal(profile.comparison_contract.sample_identity_matches,false);
  assert.equal(profile.comparison_contract.shared_outer_split_applied,false);
  assert.equal(profile.comparison_contract.shared_outer_split_applied,false);
  assert.equal(profile.comparison_contract.validation_sample_count_matches,false);
  assert.equal(profile.comparison_contract.holdout_sample_count_matches,false);
});

test('temporal network rejects wrong horizon, wrong target definition and incomplete sequences',()=>{
  const valid=sample(0,0);
  const wrongHorizon={...sample(1,0),horizon_ms:FOUR_HOURS/2};
  const wrongTarget={...sample(2,0),target_definition:'FOUR_HOUR_CLOSE_RETURN_V0'};
  const invalidSource={...sample(3,0),outcome_source:'LIVE_TICKER_PRICE'};
  const invalidTensor={...sample(4,0),temporal_sequence:Array.from({length:24},()=>Array(7).fill(0))};
  const profile=buildTemporalNeuralProfile([valid,wrongHorizon,wrongTarget,invalidSource,invalidTensor]);
  assert.equal(profile.resolved_samples,1);
  assert.equal(profile.probability_ready,false);
});


test('TCN regime fitting, member selection and calibration never cross BTC regimes',async()=>{
  const source=await readFile(new URL('../core/temporal-neural-brain.mjs',import.meta.url),'utf8');
  assert.ok(source.includes('const sharedTcnFit=sharedTcnTrainingSupported?fitEnsemble(sharedTrainingRows,{'));
  assert.ok(source.includes('const regimeFit=sharedTcnFit;'));
  assert.ok(!source.includes('fitEnsemble(regimeTraining,{'));
  assert.ok(source.includes('const sampleCountsByTime=new Map();'));
  assert.ok(source.includes('SHARED_GLOBAL_TIME_SPLIT_WITH_REGIME_LOCAL_AUXILIARY_TREE_SPLITS_V1'));
  assert.ok(source.includes('const memberSelectionRows=pooledMemberSelectionRows;'));
  assert.ok(source.includes('const calibrationRows=sharedCalibrationRows;'));
  assert.ok(!source.includes('const regimeFit=sharedResidualFit'));
  assert.ok(!source.includes('SHARED_TCN_MEMBER_SELECTION_BLOCK'));
  assert.ok(!source.includes('SHARED_SHARED_POOLED_CALIBRATION_BLOCK'));
});

test('DHDTech production acceptance requires both V5 and TCN scientific live gates',async()=>{
  const workflow=await readFile(new URL('../../.github/workflows/dhdtech-adaptive-trader-acceptance.yml',import.meta.url),'utf8');
  const containerWorkflow=await readFile(new URL('../../.github/workflows/build224-container-runtime-smoke.yml',import.meta.url),'utf8');
  const validStart=workflow.indexOf('const valid=');
  const successBranch=workflow.indexOf('if(valid)',validStart);
  assert.ok(validStart>=0&&successBranch>validStart,'acceptance success gate must remain explicit');
  const validExpression=workflow.slice(validStart,successBranch);
  for(const gate of ['cognitiveSplitReady','sharedDatasetReady','neuralNetworkContract','v5NeuralLiveReady','neuralLiveReady','probabilityClaimSafe']){
    assert.ok(validExpression.includes(gate),'DHDTech success must require '+gate);
  }
  for(const gate of [
    'Number(neuralNetwork.validation?.required_brier_margin)>=0.003',
    'Number(neuralNetwork.holdout?.required_brier_margin)>=0.003',
    'Number(neuralNetwork.holdout_comparison?.required_brier_margin)>=0.003',
    'Number(temporalNetwork.validation?.required_brier_margin)>=0.003',
    'Number(temporalNetwork.holdout?.required_brier_margin)>=0.003',
    'Number(temporalComparison.required_brier_margin)>=0.003'
  ]){
    assert.ok(workflow.includes(gate),'DHDTech acceptance must enforce the declared 0.003 Brier margin: '+gate);
  }
  for(const gate of [
    'neuralNetwork.selected===true',
    'neuralNetwork.probability_ready===true',
    'neuralNetwork.live_eligibility_ready===true',
    'neuralNetwork.holdout_comparison?.passed===true',
    'temporalNetwork.selected===true',
    'temporalNetwork.probability_ready===true',
    'temporalNetwork.live_eligibility_ready===true',
    'temporalComparison.beats_pooled_logistic===true'
  ]){
    assert.ok(workflow.includes(gate),'DHDTech model acceptance must verify '+gate);
  }
  assert.ok(workflow.includes('phase2/core/cognitive-brain.mjs'));
  assert.ok(workflow.includes('phase2/core/temporal-neural-brain.mjs'));
  assert.ok(workflow.includes('String(deployedBuildIdentity.commit||\'\')===context.sha'));
  assert.ok(workflow.includes('deploymentResponse.ok&&exactBuildCommit&&'));
  assert.ok(containerWorkflow.includes('FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2'));
  assert.ok(workflow.includes('sharedComparison.sample_fingerprint===temporalNetwork.outer_sample_fingerprint'));
  assert.ok(workflow.includes('sharedComparison.shared_outer_split_applied===true'));
  assert.ok(containerWorkflow.includes('CONTAINER_SHARED_NEURAL_SAMPLE_IDENTITY_MISMATCH'));
  assert.ok(containerWorkflow.includes("temporal_label_resolution==='15M_ONLY'"),
    'container smoke must verify the same uniform 15m target contract');
  assert.ok(containerWorkflow.includes("training_strategy==='SHARED_POOLED_TCN_TRAIN_ONLY_SELECTION_CALIBRATION_V1'"));
  assert.ok(containerWorkflow.includes('neural_residual_contributes===true'));
  assert.ok(workflow.includes('temporalNeuralContributionSafe'));
  assert.ok(workflow.includes('timeout-minutes: 65'));
  assert.ok(workflow.includes('55*60*1000'));
  for(const gate of [
    'fullUniverseCoverageReady',
    'sameEligibleUniverse',
    'sweepBelongsToThisAcceptance',
    'completedSweep.eligible_symbols_snapshot',
    'completedSweep.attempted_symbols',
    'completedSweep.failed_symbols',
    'paperTradingReady',
    'physicalDeviceDeliveryReady',
    'Number(push.fcm_devices)>=2',
    'Number(push.physical_device_receipt_count)>=2',
    'physical_device_receipt_window_ms',
    'push.physical_device_delivery_verified===true'
  ]){
    assert.ok(workflow.includes(gate),'DHDTech production acceptance must require '+gate);
  }
  assert.ok(workflow.includes('lastManualScanRequestedForScanAt'),
    'acceptance must drive bounded market scans to a complete universe sweep without duplicate requests');
});


test('TCN excludes mixed-resolution 5m first-passage labels from the 15m training target',()=>{
  const fiveMinute=sample(0,0,{up:true});
  const fifteenMinute={...sample(1,1,{up:false}),
    first_passage:{hit:'AMBIGUOUS_BOTH_LEVELS_IN_SAME_CANDLE',outcome:'FLAT',path_resolution:'5M'},
    outcome:'FLAT'};
  const profile=buildTemporalNeuralProfile([fiveMinute,fifteenMinute]);
  assert.equal(TEMPORAL_TARGET_DEFINITION,'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2');
  assert.equal(profile.resolved_samples,1,
    'the model must reject any first-passage sample built at a different candle resolution');
  assert.equal(profile.temporal_label_resolution,'15M_ONLY');
  assert.equal(profile.probability_ready,false);
});
