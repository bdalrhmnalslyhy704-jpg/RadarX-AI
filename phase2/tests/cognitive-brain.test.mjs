import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCognitiveLearningProfile,
  buildFourHourCognitiveLearningProfile,
  buildCognitivePrequentialProfile,
  assessCognitiveCandidate,
  applyCognitiveRankAdjustment,
  COGNITIVE_CHALLENGER_BRIER_MARGIN,
  effectiveCognitiveChallengerMargin,
  hasCognitiveBrierSuperiority,
  COGNITIVE_FEATURE_SCHEMA,
  COGNITIVE_FEATURE_NAMES,
  COGNITIVE_DAILY_FEATURE_SCHEMA,
  COGNITIVE_DAILY_FEATURE_NAMES,
  buildCognitiveFeatureVector,
  evaluateCognitiveDirectionalRanking,
  hasSelectedNeuralResidual,
  deriveBrierOptimalBlendWeight,
  isMeaningfulHybridBlendWeight,
  auditNeuralOneBatchOverfit,
  isValidCognitiveMlpFit
} from '../core/cognitive-brain.mjs';

import { NEURAL_CLOSURE_TARGET_DEFINITION, NEURAL_CLOSURE_TARGET_SEMANTICS, NEURAL_CLOSURE_OUTCOME_SOURCE, NEURAL_CLOSURE_HORIZON_MS } from '../core/neural-closure-contracts.mjs';

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const BASE_TIME = 1_700_000_000_000;

test('MLP V5 training loop consumes the asymmetric same-time ranking objective',()=>{
  const rows=Array.from({length:60*12},(_,index)=>{
    const group=Math.floor(index/12),within=index%12;
    const at=BASE_TIME+group*8*60*60*1000;
    const signal=within%2===0;
    return {
      ...sample(index,signal?'UP':'DOWN'),
      id:'MLP-RANK:'+group+':'+within,
      symbol:'RANK'+String(within).padStart(3,'0')+'USDT',
      at,resolved_at:at+FOUR_HOURS,
      horizon_ms:FOUR_HOURS,
      outcome:signal?'UP':'DOWN',
      target_definition:'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2',
      target_semantics:'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2_PCT_4H_15M_V2'
    };
  });
  const profile=buildCognitiveLearningProfile(rows,{
    minTrainingSamples:60,
    minimumValidationSamples:20,
    minimumHoldoutSamples:20,
    minimumNeuralSelectionSamples:20,
    minimumNeuralSelectionPositiveSamples:6,
    minimumNeuralSelectionNegativeSamples:6,
    minNeuralTrainingSamples:60,
    maxNeuralTrainingSamples:400,
    neuralIterations:30,
    neuralTrainingHistoryFraction:1,
    enableAsymmetricDirectionalRankingLoss:true,
    directionalRankingLossConfig:{
      brierWeight:1,rankingWeight:0.25,falsePositiveWeight:0.5,
      baselineGapWeight:0.2,pairMargin:0.1,pairTemperature:0.5,
      falsePositiveProbabilityThreshold:0.7,requiredBaselineImprovement:0.00025,
      maxPairsPerTimestamp:256
    }
  });
  const diagnostics=profile.neural_network?.member_training_diagnostics||[];
  assert.ok(diagnostics.length>0,
    'MLP V5 ensemble should reach the gradient-fit loop: '+JSON.stringify({status:profile.neural_network?.status,split:profile.comparison_contract,training_samples:profile.neural_network?.training_samples,fit_samples:profile.neural_network?.fit_training_samples,selection_samples:profile.neural_network?.selection_samples,selection_positive:profile.neural_network?.selection_positive_samples,selection_negative:profile.neural_network?.selection_negative_samples}));
  assert.ok(diagnostics.every(member=>Array.isArray(member.epoch_history)),
    'each MLP member should retain its actual epoch history');
  const ranking=diagnostics.flatMap(member=>member.epoch_history)
    .map(epoch=>epoch.directional_ranking_loss).filter(Boolean);
  assert.ok(ranking.length>0,
    'ranking objective must execute inside the MLP optimizer loop');
  assert.ok(ranking.some(metrics=>metrics.same_timestamp_pair_count>0),
    'MLP training should build same-time cross-sectional UP/DOWN pairs');
  assert.ok(ranking.every(metrics=>Number.isFinite(metrics.candidate_brier)&&
    Number.isFinite(metrics.baseline_brier)&&
    Number.isFinite(metrics.pairwise_ranking_loss)),
    'the MLP ranking objective diagnostics must remain finite');
});

test('V5 ensemble trains every MLP member with Focal-Asymmetric Brier and train-only class weights',()=>{
  const rows=Array.from({length:60*12},(_,index)=>{
    const group=Math.floor(index/12),within=index%12;
    const at=BASE_TIME+group*8*60*60*1000;
    const up=within%5===0;
    return {
      ...sample(index,up?'UP':'DOWN'),
      id:'MLP-FOCAL:'+group+':'+within,
      symbol:'FOCAL'+String(within).padStart(3,'0')+'USDT',
      at,resolved_at:at+FOUR_HOURS,horizon_ms:FOUR_HOURS,
      outcome:up?'UP':'DOWN',
      target_definition:'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2'
    };
  });
  const profile=buildCognitiveLearningProfile(rows,{
    minTrainingSamples:60,minimumValidationSamples:20,minimumHoldoutSamples:20,
    minimumNeuralSelectionSamples:20,minimumNeuralSelectionPositiveSamples:6,
    minimumNeuralSelectionNegativeSamples:6,minNeuralTrainingSamples:60,
    maxNeuralTrainingSamples:400,neuralIterations:30,neuralTrainingHistoryFraction:1
  });
  const neural=profile.neural_network;
  assert.ok(neural&&neural.member_training_profiles?.length===3,
    'V5 should fit three deterministic MLP candidates: '+JSON.stringify({
      status:neural?.status,fit:neural?.fit_training_samples
    }));
  assert.deepEqual(neural.member_training_objectives,
    ['FOCAL_ASYMMETRIC_BRIER','FOCAL_ASYMMETRIC_BRIER','FOCAL_ASYMMETRIC_BRIER']);
  assert.ok(neural.member_training_profiles.length===3&&
    neural.member_training_profiles.every(member=>
    member.trainingObjective==='FOCAL_ASYMMETRIC_BRIER'&&
    member.focal_asymmetric_brier?.weights_derived_from==='CURRENT_TRAINING_PARTITION_ONLY'&&
    Number.isFinite(member.focal_asymmetric_brier.positive_weight)&&
    Number.isFinite(member.focal_asymmetric_brier.negative_weight)));
});

test('cognitive features separate early-flow divergence from momentum and missing micro data',()=>{
  assert.equal(COGNITIVE_FEATURE_SCHEMA,'CROSS_ASSET_EARLY_FLOW_FEATURES_V2');
  const index=Object.fromEntries(COGNITIVE_FEATURE_NAMES.map((name,i)=>[name,i]));
  for(const name of [
    'relative_momentum_divergence','compression_x_buyer',
    'micro_buy_flow_acceleration','average_trade_size_expansion','micro_availability_mask'
  ])assert.ok(Number.isInteger(index[name]),'missing feature '+name);
  const vector=buildCognitiveFeatureVector({
    volume_ratio:4,trade_ratio:1,taker_buy_ratio:0.55,
    compression_ratio:0.6,relative_strength_vs_btc_pct:2,
    recent_15m_return_pct:0.5,higher_low:true,
    micro_5m_available:true,micro_5m_taker_buy_ratio:0.7
  });
  assert.equal(vector.length,18,'the compact V5 input size remains unchanged');
  assert.ok(vector[index.relative_momentum_divergence]>0);
  assert.ok(vector[index.compression_x_buyer]>0);
  assert.ok(vector[index.micro_buy_flow_acceleration]>0);
  assert.ok(vector[index.average_trade_size_expansion]>0);
  assert.equal(vector[index.micro_availability_mask],1);
  const withoutMicro=buildCognitiveFeatureVector({
    volume_ratio:4,trade_ratio:1,taker_buy_ratio:0.55,compression_ratio:0.6,
    relative_strength_vs_btc_pct:2,recent_15m_return_pct:0.5,micro_5m_available:false
  });
  assert.equal(withoutMicro[index.micro_buy_flow_acceleration],0);
  assert.equal(withoutMicro[index.micro_availability_mask],0,
    'missing 5m evidence must not look like neutral buyer flow');
});

test('hybrid blend uses a true two-component Brier optimum and rejects endpoint collapse',()=>{
  const boosted=[0.9,0.4,0.1,0.6];
  const neural=[0.4,0.9,0.6,0.1];
  const targets=[1,1,0,0];
  const weight=deriveBrierOptimalBlendWeight(boosted,neural,targets);
  assert.ok(Math.abs(weight-0.5)<1e-12);
  assert.equal(isMeaningfulHybridBlendWeight(weight),true);
  const brier=candidate=>boosted.reduce((sum,value,index)=>{
    const p=candidate*value+(1-candidate)*neural[index];
    return sum+(p-targets[index])**2;
  },0);
  const epsilon=1e-5;
  assert.ok(brier(weight)<=brier(Math.max(0.05,weight-epsilon))+1e-10);
  assert.ok(brier(weight)<=brier(Math.min(0.95,weight+epsilon))+1e-10);
  const endpoint=deriveBrierOptimalBlendWeight(
    [0.8,0.2,0.7,0.3,0.9,0.1],
    [0.4,0.6,0.5,0.5,0.4,0.6],[1,0,1,0,1,0]);
  assert.equal(endpoint,1);
  assert.equal(isMeaningfulHybridBlendWeight(endpoint),false,
    'a pure component cannot be published as a hybrid');
  assert.equal(isMeaningfulHybridBlendWeight(0.04),false);
  assert.equal(isMeaningfulHybridBlendWeight(0.96),false);
  assert.equal(deriveBrierOptimalBlendWeight([0.5,0.5],[0.5,0.5],[1,0]),null);
  assert.equal(deriveBrierOptimalBlendWeight([0.4,0.6],[0.5],[1,0]),null);
  assert.equal(deriveBrierOptimalBlendWeight([0.4,Number.NaN],[0.5,0.2],[1,0]),null);
});

test('hybrid fail-closed gate requires an inner-selected positive neural residual',()=>{
  const unselected={
    kind:'RESIDUAL_DEEP_MLP_ENSEMBLE_V3',
    members:[{kind:'RESIDUAL_DEEP_MLP_V2'}],
    seeds:[11],selected_member_index:-1,selected_residual_scale:0
  };
  assert.equal(hasSelectedNeuralResidual(unselected),false);
  assert.equal(hasSelectedNeuralResidual({
    ...unselected,selected_member_index:0,selected_residual_scale:0
  }),false,'zero residual is only the logistic anchor');
  assert.equal(hasSelectedNeuralResidual({
    ...unselected,selected_member_index:0,selected_residual_scale:0.1
  }),true,'a selected MLP residual may be used by the blend');
  assert.equal(hasSelectedNeuralResidual({
    ...unselected,seeds:[11,29]
  }),false,'member and seed manifests must agree');
});

test('V5 neural and hybrid challengers require a strict 0.003 Brier improvement',()=>{
  assert.equal(COGNITIVE_CHALLENGER_BRIER_MARGIN,0.003);
  assert.equal(hasCognitiveBrierSuperiority(0.4,0.4029),false,
    'a 0.0029 improvement must not pass');
  assert.equal(hasCognitiveBrierSuperiority(0.4,0.403),false,
    'an improvement equal to 0.003 must not pass a strict gate');
  assert.equal(hasCognitiveBrierSuperiority(0.4,0.4031),true,
    'only an improvement above 0.003 passes');
  assert.equal(hasCognitiveBrierSuperiority(null,0.5),false,
    'missing metrics fail closed');
  assert.equal(effectiveCognitiveChallengerMargin(0.002),0.003,
    'a caller cannot weaken the V5 policy floor');
  assert.equal(effectiveCognitiveChallengerMargin(0.004),0.004,
    'a caller may request a stricter margin');
  assert.equal(effectiveCognitiveChallengerMargin(null),0.003,
    'missing configuration retains the declared policy margin');
});

function sample(index, outcome, features = {}) {
  const at = BASE_TIME + index * 15 * 60 * 1000;
  return {
    id: 'MEMORY-' + String(index),
    symbol: 'MEMORYUSDT',
    at,
    resolved_at: at + FOUR_HOURS,
    horizon_ms: FOUR_HOURS,
    outcome_source: 'CLOSED_CANDLE_4H',
    training_eligible: true,
    closed_candle_baseline: true,
    outcome,
    return_pct: outcome === 'UP' ? 2.5 : outcome === 'DOWN' ? -2.5 : 0,
    features: {
      volume_ratio: 1.8,
      trade_ratio: 1.5,
      taker_buy_ratio: 0.58,
      close_location: 0.72,
      higher_low: true,
      compression_ratio: 0.7,
      relative_strength_vs_btc_pct: 0.8,
      recent_15m_return_pct: 0.6,
      trend_aligned: true,
      micro_5m_available: true,
      micro_5m_taker_buy_ratio: 0.59,
      ...features
    }
  };
}

function candidate(overrides = {}) {
  return {
    symbol: 'EARLYUSDT',
    price: 0.42,
    change_24h_pct: 2.1,
    score: 74,
    tier: 'WATCH',
    data_valid: true,
    data_stale: false,
    closed_candles_only: true,
    candle_age_ms: 60_000,
    features: {
      volume_ratio: 2.2,
      trade_ratio: 1.7,
      taker_buy_ratio: 0.61,
      close_location: 0.8,
      higher_low: true,
      breakout_above_prior_high: true,
      compression_ratio: 0.72,
      relative_strength_vs_btc_pct: 1.2,
      recent_15m_return_pct: 0.7,
      trend_aligned: true,
      micro_5m_available: true,
      micro_5m_taker_buy_ratio: 0.58,
      micro_5m_return_pct: 0.4
    },
    ...overrides
  };
}

function behavioralSamples({ seed = 0, reverse = false, count = 600 } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const n = i + seed;
    const volumeOn = n % 2 === 0;
    const buyerOn = Math.floor(n / 2) % 2 === 0;
    const structureOn = Math.floor(n / 4) % 2 === 0;
    const signal = volumeOn && buyerOn && structureOn;
    const tradeOn = (n * 7) % 5 < 3;
    const compressionOn = (n * 3) % 4 < 2;
    const relativeOn = n % 3 === 0;
    const trendOn = n % 2 === 0;
    const microOn = n % 4 < 2;
    const features = {
      volume_ratio: volumeOn ? 2.2 : 0.8,
      trade_ratio: tradeOn ? 1.7 : 0.85,
      taker_buy_ratio: buyerOn ? 0.62 : 0.44,
      close_location: structureOn ? 0.78 : 0.35,
      higher_low: structureOn,
      breakout_above_prior_high: false,
      compression_ratio: compressionOn ? 0.68 : 1.12,
      relative_strength_vs_btc_pct: relativeOn ? 0.9 : -0.45,
      recent_15m_return_pct: n % 3 === 0 ? 0.7 : -0.2,
      return_3h_pct: trendOn ? 1.1 : -0.4,
      trend_aligned: trendOn,
      micro_5m_available: true,
      micro_5m_taker_buy_ratio: microOn ? 0.61 : 0.43,
      micro_5m_return_pct: 0.2
    };
    const isPositive = reverse ? !signal : signal;
    const outcome = isPositive
      ? (i % 5 === 0 ? 'FLAT' : 'UP')
      : (i % 7 === 0 ? 'FLAT' : 'DOWN');
    const at = BASE_TIME + i * 5 * 60 * 60 * 1000;
    rows.push({
      id: 'EXAMPLE-' + seed + '-' + i,
      symbol: 'PAIR' + String(i % 13).padStart(2, '0') + 'USDT',
      at,
      resolved_at: at + FOUR_HOURS,
      horizon_ms: FOUR_HOURS,
      outcome_source: 'CLOSED_CANDLE_4H',
      training_eligible: true,
      closed_candle_baseline: true,
      outcome,
      return_pct: outcome === 'UP' ? 2.8 : outcome === 'DOWN' ? -2.6 : 0,
      features
    });
  }
  return rows;
}

test('learner rejects unresolved, duplicate and non-training observations', () => {
  const good = sample(1, 'UP');
  const rows = [
    good,
    { ...sample(2, 'DOWN'), training_eligible: false },
    { ...sample(3, 'FLAT'), outcome: null },
    { ...sample(4, 'DOWN'), resolved_at: null },
    good
  ];
  const profile = buildCognitiveLearningProfile(rows);
  assert.equal(profile.resolved_samples, 1);
  assert.equal(profile.probability_ready, false);
  assert.equal(profile.identifier_features_used, false);
});

test('live and historical copies of the same symbol/candle count as one training event', () => {
  const live = sample(12, 'UP');
  const backfill = {
    ...live,
    id: 'HISTORICAL_CLOSED_CANDLE:MEMORYUSDT:' + String(live.at),
    closed_candle_baseline: false,
    historical_baseline: true,
    outcome_source: 'HISTORICAL_CLOSED_CANDLE',
    outcome: 'DOWN',
    return_pct: -2.5
  };
  const invalidSource = { ...sample(13, 'UP'), outcome_source: 'LIVE_TICKER_PRICE' };
  const profile = buildCognitiveLearningProfile([live, backfill, invalidSource]);
  assert.equal(profile.resolved_samples, 1);
  assert.equal(profile.outcome_counts.up, 1);
  assert.equal(profile.outcome_counts.down, 0);
});

test('nested chronological validation purges labels crossing both validation and untouched test boundaries', () => {
  const rows = Array.from({ length: 200 }, (_, index) =>
    sample(index, index % 2 === 0 ? 'UP' : 'DOWN'));
  const profile = buildCognitiveLearningProfile(rows);
  assert.equal(profile.resolved_samples, 200);
  assert.equal(profile.training_samples, 104);
  assert.equal(profile.validation_samples, 24);
  assert.equal(profile.holdout_samples, 40);
  assert.equal(profile.purged_overlap_samples, 32);
  assert.equal(profile.validation_purged_samples, 16);
  assert.ok(profile.max_training_outcome_resolved_at < profile.validation_start_at);
  assert.ok(profile.validation_start_at < profile.holdout_start_at);
  assert.equal(profile.holdout.evaluated, true);
  assert.equal(profile.method, 'NESTED_PURGED_WALK_FORWARD_RESIDUAL_NEURAL_MODEL_V5');
});

test('unseen-pair validation keeps focal MLP fail-closed when it misses the inner Logistic gate', () => {
  for (const seed of [0, 3, 7]) {
    const profile = buildCognitiveLearningProfile(behavioralSamples({ seed }));
    assert.equal(profile.ranking_ready, true, 'both present and absent evidence buckets must be covered');
    assert.equal(profile.holdout.evaluated, true);
    assert.equal(profile.probability_ready, true,
      'the model must beat the chronological baseline before publishing probabilities');
    assert.ok(profile.holdout.model_brier_score < profile.holdout.base_rate_brier_score);
    assert.equal(profile.identifier_features_used, false);
    assert.equal(profile.neural_network.architecture, '18-10-6-1+RESIDUAL');
    assert.equal(profile.neural_network.trained, true);
    assert.equal(profile.neural_network.training_history_fraction,1,
      'legacy callers keep the full chronological training history by default');
    assert.equal(profile.neural_network.fit_training_samples,profile.neural_network.preselection_training_samples,
      'the default 100% history setting preserves the existing training rows');
    assert.equal(profile.neural_network.anchor_adaptation,'FROZEN_LOGISTIC',
      'legacy V5 callers must keep the original frozen logistic skip path');
    assert.equal(profile.neural_network.anchor_trust_radius,0);
    assert.equal(profile.neural_network.max_anchor_skip_delta,0);
    assert.equal(profile.neural_network.model_kind, 'RESIDUAL_DEEP_MLP_ENSEMBLE_V3');
    assert.equal(profile.neural_network.training_objective, 'FOCAL_ASYMMETRIC_BRIER_ENSEMBLE_WITH_TRAIN_ONLY_CLASS_WEIGHTS_V1');
    assert.equal(profile.neural_network.training_strategy,
      'FOCAL_ASYMMETRIC_BRIER_RESIDUAL_MLP_VALIDATION_SHRUNK_V1_TRAIN_ONLY_CLASS_BALANCE');
    assert.ok(profile.neural_network.calibration_samples>0);
    assert.ok(profile.neural_network.calibration_fit_samples>0);
    assert.ok(profile.neural_network.calibration_check_samples>0);
    assert.ok(profile.neural_network.selection_start_at<profile.neural_network.calibration_start_at);
    assert.ok(profile.neural_network.max_selection_outcome_resolved_at<
      profile.neural_network.calibration_start_at,
      'member/residual selection labels must finish before probability calibration begins');
    assert.ok(profile.neural_network.max_calibration_fit_outcome_resolved_at<
      profile.neural_network.calibration_check_start_at,
      'calibrator fitting labels must finish before its disjoint calibration-check block');
    assert.ok(profile.neural_network.max_calibration_check_outcome_resolved_at<
      profile.validation_start_at,
      'calibration-check labels must mature before outer validation begins');
    assert.ok(profile.neural_network.calibration_check_samples>=20);
    assert.equal(profile.neural_network.residual_scale_selection, 'DISJOINT_CHRONOLOGICAL_SELECTION_BLOCK_BRIER_GRID_V1');
    assert.ok(profile.neural_network.selection_samples >= 20);
    if(profile.neural_network.selected_member_index>=0){
      assert.equal(profile.neural_network.refit_training_samples,profile.neural_network.training_samples);
      assert.equal(profile.neural_network.scoring_base_rate,profile.neural_network.refit_base_rate,
        'Brier baseline must use the final refit training prevalence, not the pre-refit ensemble prevalence');
      assert.equal(profile.neural_network.refit_positive_samples+profile.neural_network.refit_negative_samples,
        profile.neural_network.refit_training_samples);
      assert.ok(Math.abs(profile.neural_network.refit_base_rate-
        ((profile.neural_network.refit_positive_samples+2)/(profile.neural_network.refit_training_samples+4)))<1e-12,
        'reported refit prevalence must match the final refit labels');
      assert.ok(profile.neural_network.refit_training_samples<=profile.neural_network.maximum_training_sample_budget);
      assert.ok(profile.neural_network.refit_training_samples>=profile.neural_network.preselection_training_samples);
      assert.ok(profile.neural_network.max_refit_training_outcome_resolved_at < profile.neural_network.calibration_start_at,
        'all refit labels must mature before the independent calibration block begins');
    }else{
      assert.equal(profile.neural_network.refit_training_samples,0);
      assert.equal(profile.neural_network.selected,false);
      assert.equal(profile.neural_network.probability_ready,false,
        'a trained MLP that misses the inner Logistic gate must not publish a probability');
      assert.equal(profile.neural_network.live_eligibility_ready,false);
      assert.equal(profile.neural_network.max_refit_training_outcome_resolved_at,null);
    }
    assert.ok(profile.neural_network.max_training_outcome_resolved_at < profile.neural_network.selection_start_at,
      'V5 fitting labels must be resolved before the separate selection block');
    assert.ok(profile.neural_network.max_selection_outcome_resolved_at < profile.validation_start_at,
      'V5 member and residual selection must finish before outer validation begins');
    assert.ok(profile.neural_network.selection_start_at < profile.validation_start_at);
    assert.ok(profile.neural_network.member_selection_brier_scores.length > 0);
    assert.equal(profile.neural_network.residual_scale_selection, 'DISJOINT_CHRONOLOGICAL_SELECTION_BLOCK_BRIER_GRID_V1');
    assert.deepEqual(profile.neural_network.candidate_residual_scales, [0, 0.1, 0.25, 0.5, 1]);
    assert.ok([0, 0.1, 0.25, 0.5, 1].includes(profile.neural_network.selected_residual_scale));
    assert.equal(profile.neural_network.ensemble_members, 3);
    assert.deepEqual(profile.neural_network.member_training_objectives,[
      'FOCAL_ASYMMETRIC_BRIER',
      'FOCAL_ASYMMETRIC_BRIER',
      'FOCAL_ASYMMETRIC_BRIER'
    ]);
    assert.equal(profile.neural_network.member_training_profiles[2].positiveClassWeighting,
      'FOCAL_ASYMMETRIC_BRIER_TRAIN_ONLY_CLASS_WEIGHTS');
    assert.ok(profile.neural_network.internal_selection_logistic_brier>=0);
    assert.ok(profile.neural_network.member_selection_brier_scores.every(row=>
      typeof row.beats_same_window_logistic==='boolean'));
    assert.equal(profile.neural_network.ensemble_members_required, 3);
    assert.equal(profile.feature_schema,COGNITIVE_FEATURE_SCHEMA);
    assert.equal(profile.neural_network.feature_schema,COGNITIVE_FEATURE_SCHEMA);
    assert.equal(profile.neural_network.input_neurons, 18);
    assert.equal(profile.neural_network.hidden_neurons, 10);
    assert.equal(profile.neural_network.second_hidden_neurons, 6);

    // The new tree and hybrid challengers are independently scored against
    // the same chronological UP-event target. A model may be selected only
    // after the untouched holdout independently confirms its validation win.
    assert.equal(profile.boosted_tree_model.model_kind,'RESIDUAL_GBDT_LOGISTIC_ANCHOR_V1');
    assert.equal(profile.hybrid_model.model_kind,'BLENDED_GBDT_MLP_V1');
    assert.ok(['WAITING_FOR_MATURED_TRAINING_SAMPLES','TRAINED_NOT_SELECTED',
      'VALIDATION_SELECTED_HOLDOUT_FAILED','OUT_OF_SAMPLE_VALIDATED']
      .includes(profile.boosted_tree_model.status));
    assert.ok(['GBDT_COMPONENT_NOT_STANDALONE_QUALIFIED',
      'MLP_COMPONENT_NOT_STANDALONE_QUALIFIED',
      'WAITING_FOR_BOTH_CHALLENGERS','NEURAL_COMPONENT_NOT_SELECTED',
      'WAITING_FOR_HYBRID_WEIGHT_FIT_SUPPORT','WAITING_FOR_HYBRID_WEIGHT_SELECTION_SUPPORT',
      'HYBRID_WEIGHT_NOT_IDENTIFIABLE','HYBRID_WEIGHT_COLLAPSED_TO_SINGLE_COMPONENT',
      'HYBRID_BLEND_SELECTION_NOT_BEAT_LOGISTIC','TRAINED_NOT_SELECTED',
      'VALIDATION_SELECTED_HOLDOUT_FAILED','OUT_OF_SAMPLE_VALIDATED']
      .includes(profile.hybrid_model.status));
    if(profile.model_selection.selected_model==='GBDT_RESIDUAL'){
      assert.equal(profile.boosted_tree_model.selected,true);
      assert.equal(profile.boosted_tree_model.holdout_comparison.passed,true);
    }
    if(profile.model_selection.selected_model==='HYBRID_GBDT_MLP'){
      assert.equal(profile.hybrid_model.selected,true);
      assert.equal(profile.hybrid_model.holdout_comparison.passed,true);
    }
    if(profile.model_selection.validation_challenger?.startsWith('HYBRID_GBDT_MLP')){
      assert.equal(profile.hybrid_model.holdout?.evaluated,true,
        'the validation winner must expose untouched holdout metrics even when it fails');
      assert.equal(profile.model_selection.challenger_holdout?.evaluated,true);
      assert.ok(profile.hybrid_model.holdout_comparison);
      assert.equal(profile.hybrid_model.holdout_comparison.passed,
        profile.model_selection.challenger_holdout_comparison.passed);
    }
    assert.ok(profile.neural_network.inner_selection_diagnostics);
    assert.equal(profile.neural_network.inner_selection_diagnostics.candidate_member_scale_count,
      profile.neural_network.member_selection_brier_scores.length);
    assert.equal(profile.neural_network.inner_selection_diagnostics.passed,
      Number.isInteger(profile.neural_network.selected_member_index)&&
        profile.neural_network.selected_member_index>=0);
    assert.equal(profile.neural_network.inner_selection_diagnostics.failure_reason,
      Number.isInteger(profile.neural_network.selected_member_index)&&
        profile.neural_network.selected_member_index>=0
        ?'NEURAL_MEMBER_SELECTION_PASSED'
        :profile.neural_network.validation.reason);

    const highEvidence = candidate();
    const renamedPair = candidate({ symbol: 'UNSEENPAIRUSDT' });
    const highProbability = assessCognitiveCandidate(highEvidence, profile, BASE_TIME + 20_000);
    const renamedProbability = assessCognitiveCandidate(renamedPair, profile, BASE_TIME + 20_000);
    assert.equal(highProbability.predicted_up_probability, renamedProbability.predicted_up_probability);
    assert.equal(highProbability.probability_status, 'OUT_OF_SAMPLE_VALIDATED');
    assert.ok(highProbability.counterfactual_evidence.length > 0);
  }
});

test('MLP inference tensor validator rejects ragged matrices and non-finite parameters',()=>{
  const inputSize=COGNITIVE_FEATURE_NAMES.length,hidden1=10,hidden2=6;
  const valid={
    kind:'RESIDUAL_DEEP_MLP_V2',input_size:inputSize,
    feature_schema:COGNITIVE_FEATURE_SCHEMA,
    feature_names:[...COGNITIVE_FEATURE_NAMES],
    input_weights:Array.from({length:inputSize},()=>Array(hidden1).fill(0.01)),
    hidden_bias_1:Array(hidden1).fill(0),
    hidden_weights:Array.from({length:hidden1},()=>Array(hidden2).fill(0.01)),
    hidden_bias_2:Array(hidden2).fill(0),
    output_weights:Array(hidden2).fill(0.01),
    skip_weights:Array(inputSize).fill(0),
    output_bias:0
  };
  assert.equal(isValidCognitiveMlpFit(valid),true);
  assert.equal(isValidCognitiveMlpFit({
    ...valid,input_weights:valid.input_weights.map((row,index)=>
      index===4?row.slice(1):row)
  }),false);
  assert.equal(isValidCognitiveMlpFit({
    ...valid,hidden_weights:valid.hidden_weights.map((row,index)=>
      index===2?row.concat(0):row)
  }),false);
  assert.equal(isValidCognitiveMlpFit({
    ...valid,output_weights:[...valid.output_weights.slice(1),Number.NaN]
  }),false);
  assert.equal(isValidCognitiveMlpFit({
    ...valid,feature_names:[...valid.feature_names].reverse()
  }),false);
});

test('MLP tensor interface rejects reordered features, mismatched schemas, bad shapes and non-finite inputs',()=>{
  const baseFeatures={
    volume_ratio:2,trade_ratio:1.5,taker_buy_ratio:0.62,
    compression_ratio:0.7,relative_strength_vs_btc_pct:1,
    recent_15m_return_pct:0.4,micro_5m_available:true,
    micro_5m_taker_buy_ratio:0.65
  };
  const rows=Array.from({length:32},(_,index)=>({
    id:'CONTRACT:'+index,symbol:'CONTRACTUSDT',
    at:BASE_TIME+index*60_000,resolved_at:BASE_TIME+(index+1)*60_000,
    outcome:index%2?'UP':'DOWN',target:index%2,
    features:baseFeatures,feature_schema:COGNITIVE_FEATURE_SCHEMA,
    feature_names:[...COGNITIVE_FEATURE_NAMES],
    vector:buildCognitiveFeatureVector(baseFeatures)
  }));
  const reordered=rows.map((row,index)=>index===7?{
    ...row,feature_names:[...row.feature_names].reverse()
  }:row);
  assert.throws(()=>auditNeuralOneBatchOverfit(reordered),
    /NEURAL_FEATURE_NAME_ORDER_MISMATCH:7/);
  const wrongSchema=rows.map((row,index)=>index===9?{
    ...row,feature_schema:'CROSS_ASSET_DAILY_CONTEXT_FEATURES_V3'
  }:row);
  assert.throws(()=>auditNeuralOneBatchOverfit(wrongSchema),
    /NEURAL_FEATURE_SCHEMA_MISMATCH:9/);
  const wrongShape=rows.map((row,index)=>index===11?{
    ...row,vector:row.vector.slice(1)
  }:row);
  assert.throws(()=>auditNeuralOneBatchOverfit(wrongShape),
    /NEURAL_FEATURE_VECTOR_SHAPE_MISMATCH:11/);
  const nonFinite=rows.map((row,index)=>index===13?{
    ...row,vector:row.vector.map((value,feature)=>feature===4?Number.NaN:value)
  }:row);
  assert.throws(()=>auditNeuralOneBatchOverfit(nonFinite),
    /NEURAL_FEATURE_VECTOR_NON_FINITE_OR_NON_NUMERIC:13/);
  const misaligned=rows.map((row,index)=>index===15?{
    ...row,vector:row.vector.map((value,feature)=>feature===0?value+0.1:value)
  }:row);
  assert.throws(()=>auditNeuralOneBatchOverfit(misaligned),
    /NEURAL_FEATURE_VECTOR_VALUE_MISMATCH:15/);
});

test('daily-context 35-feature MLP tensor contract also overfits one deterministic 32-row batch',()=>{
  assert.equal(COGNITIVE_DAILY_FEATURE_NAMES.length,35);
  const rows=Array.from({length:32},(_,index)=>{
    const positive=index<16,sign=positive?1:-1;
    const features={
      volume_ratio:positive?4:0.25,
      trade_ratio:positive?3:0.3,
      taker_buy_ratio:positive?0.78:0.22,
      compression_ratio:positive?0.35:1.25,
      relative_strength_vs_btc_pct:sign*2,
      recent_15m_return_pct:sign*0.9,
      higher_low:positive,trend_aligned:positive,
      micro_5m_available:true,
      micro_5m_taker_buy_ratio:positive?0.76:0.24,
      return_30m_pct:sign*1.2,
      hourly_return_pct:sign*2.1,
      return_3h_pct:sign*3.4,
      btc_hourly_return_pct:sign*0.2,
      daily_change_pct:sign*5.5,
      relative_strength_vs_btc_24h_pct:sign*3,
      quote_volume_24h:2_000_000,
      breakout_distance_pct:sign*0.65,
      current_range_pct:2.5,
      lower_wick_pct:positive?1.1:0.2,
      micro_5m_volume_ratio:positive?2.4:0.3,
      micro_5m_trade_ratio:positive?2.1:0.4,
      micro_5m_return_pct:sign*0.6,
      micro_5m_close_location:positive?0.85:0.15
    };
    return {
      id:'DAILY35:'+index,symbol:'DAILY35USDT',
      at:BASE_TIME+index*60_000,resolved_at:BASE_TIME+(index+1)*60_000,
      outcome:positive?'UP':'DOWN',target:positive?1:0,features,
      feature_schema:COGNITIVE_DAILY_FEATURE_SCHEMA,
      feature_names:[...COGNITIVE_DAILY_FEATURE_NAMES],
      vector:buildCognitiveFeatureVector(features,COGNITIVE_DAILY_FEATURE_SCHEMA)
    };
  });
  const report=auditNeuralOneBatchOverfit(rows,{iterations:48,seed:29});
  console.log('[COGNITIVE_MLP_35_FEATURE_32_ROW_OVERFIT]',JSON.stringify(report));
  assert.equal(report.feature_count,35);
  assert.equal(report.feature_schema,COGNITIVE_DAILY_FEATURE_SCHEMA);
  assert.equal(report.finite_predictions,true);
  assert.equal(report.all_gradients_finite,true);
  assert.equal(report.all_parameters_finite,true);
  assert.equal(report.passed,true,JSON.stringify(report));
});

test('MLP numerical training audit drives an exactly balanced 32-row batch to near-zero Brier',()=>{
  const rows=Array.from({length:32},(_,index)=>{
    const positive=index<16;
    const features=positive?{
      volume_ratio:4,trade_ratio:3,taker_buy_ratio:0.78,
      compression_ratio:0.35,relative_strength_vs_btc_pct:2,
      recent_15m_return_pct:0.9,higher_low:true,trend_aligned:true,
      micro_5m_available:true,micro_5m_taker_buy_ratio:0.76
    }:{
      volume_ratio:0.25,trade_ratio:0.3,taker_buy_ratio:0.22,
      compression_ratio:1.25,relative_strength_vs_btc_pct:-2,
      recent_15m_return_pct:-0.9,higher_low:false,trend_aligned:false,
      micro_5m_available:true,micro_5m_taker_buy_ratio:0.24
    };
    return {
      id:'MLP32:'+index,symbol:'MLP32USDT',
      at:BASE_TIME+index*60_000,resolved_at:BASE_TIME+(index+1)*60_000,
      outcome:positive?'UP':'DOWN',target:positive?1:0,features,
      feature_schema:COGNITIVE_FEATURE_SCHEMA,
      feature_names:[...COGNITIVE_FEATURE_NAMES],
      vector:buildCognitiveFeatureVector(features)
    };
  });
  const report=auditNeuralOneBatchOverfit(rows,{iterations:48,seed:17});
  console.log('[COGNITIVE_MLP_32_ROW_OVERFIT]',JSON.stringify(report));
  assert.equal(report.sample_count,32);
  assert.ok(report.epochs_completed>=30&&report.epochs_completed<=48,
    'the diagnostic must prove one-batch fit within a few dozen epochs');
  assert.equal(report.requested_epochs,48);
  assert.ok(report.early_stopping?.enabled);
  assert.equal(report.early_stopping?.monitor,'TRAINING_BLOCK_OBJECTIVE_ONLY');
  assert.equal(report.early_stopping?.validation_or_holdout_used,false);
  assert.equal(report.early_stopping?.restored_best_checkpoint,true);
  assert.ok(report.best_epoch>=1&&report.best_epoch<=report.epochs_completed);
  assert.equal(report.optimizer,'ADAMW_DECOUPLED_WEIGHT_DECAY');
  assert.equal(report.scheduler,'COSINE_DECAY_10_PERCENT_FLOOR');
  assert.equal(report.gradient_clip_norm,1);
  assert.equal(report.feature_count,18);
  assert.equal(report.finite_predictions,true);
  assert.equal(report.all_gradients_finite,true);
  assert.equal(report.all_parameters_finite,true);
  assert.equal(report.passed,true,JSON.stringify(report));
});

test('MLP early stopping restores best training-only checkpoint on a zero-signal plateau',()=>{
  const features={};
  const rows=Array.from({length:32},(_,index)=>{
    const target=index<16?1:0;
    return {
      id:'MLP-PLATEAU:'+index,symbol:'MLPPLATEAUUSDT',
      at:BASE_TIME+index*60_000,resolved_at:BASE_TIME+(index+1)*60_000,
      outcome:target?'UP':'DOWN',target,features,
      feature_schema:COGNITIVE_FEATURE_SCHEMA,
      feature_names:[...COGNITIVE_FEATURE_NAMES],
      vector:buildCognitiveFeatureVector(features)
    };
  });
  const report=auditNeuralOneBatchOverfit(rows,{iterations:180,seed:71});
  console.log('[COGNITIVE_MLP_EARLY_STOPPING_PLATEAU]',JSON.stringify(report));
  assert.equal(report.sample_count,32);
  assert.ok(report.epochs_completed<report.requested_epochs,
    'a training-only plateau must stop before the requested epoch budget');
  assert.equal(report.early_stopping.stopped_early,true);
  assert.equal(report.early_stopping.monitor,'TRAINING_BLOCK_OBJECTIVE_ONLY');
  assert.equal(report.early_stopping.validation_or_holdout_used,false);
  assert.equal(report.early_stopping.restored_best_checkpoint,true);
  assert.ok(report.best_epoch<=report.epochs_completed);
});

test('the learner changes its conclusion when the same evidence leads to opposite matured outcomes', () => {
  const normal = buildCognitiveLearningProfile(behavioralSamples({ seed: 2, reverse: false }));
  const reversed = buildCognitiveLearningProfile(behavioralSamples({ seed: 2, reverse: true }));
  assert.equal(normal.probability_ready, true);
  assert.equal(reversed.probability_ready, true);
  const evidence = candidate().features;
  const normalProbability = assessCognitiveCandidate(candidate(), normal, BASE_TIME + 20_000)
    .predicted_up_probability;
  const reversedProbability = assessCognitiveCandidate(candidate(), reversed, BASE_TIME + 20_000)
    .predicted_up_probability;
  assert.ok(normalProbability > reversedProbability + 15,
    'same pattern must receive a different estimate after the learned outcome relationship reverses; normal=' + normalProbability + ', reversed=' + reversedProbability);
  assert.ok(applyCognitiveRankAdjustment(70, evidence, normal) >
    applyCognitiveRankAdjustment(70, evidence, reversed));
});

test('candidate reasoning shows hypotheses and contradictions without claiming certainty', () => {
  const assessment = assessCognitiveCandidate(candidate(), buildCognitiveLearningProfile([]), BASE_TIME);
  assert.equal(assessment.decision, 'EARLY_SETUP_REVIEW');
  assert.equal(assessment.entry_eligible, false);
  assert.equal(assessment.real_order_execution, false);
  assert.equal(assessment.paper_trading, true);
  assert.equal(assessment.predicted_up_probability, null);
  assert.ok(assessment.hypotheses.some(row => row.key === 'BUYER_ACCUMULATION' && row.supported));
  assert.ok(assessment.hypotheses.some(row => row.key === 'PRICE_STRUCTURE' && row.supported));
  assert.equal(assessment.confidence_label, 'UNKNOWN');
});

test('a late or contradictory market move is not rescued by a high learned probability', () => {
  const profile = buildCognitiveLearningProfile(behavioralSamples());
  const late = assessCognitiveCandidate(candidate({
    change_24h_pct: 11,
    tier: 'LATE_MOVE',
    features: { ...candidate().features, hourly_return_pct: 5.5 }
  }), profile, BASE_TIME);
  assert.equal(late.decision, 'AVOID_CHASING');
  assert.equal(late.entry_eligible, false);
  assert.ok(late.reason_codes.includes('ANTI_CHASE_REVIEW_REQUIRED'));

  const contradictory = assessCognitiveCandidate(candidate({
    features: { ...candidate().features, taker_buy_ratio: 0.43, upper_wick_pct: 0.8, current_range_pct: 1 }
  }), profile, BASE_TIME);
  assert.ok(contradictory.contradictions.length > 0);
  assert.equal(contradictory.entry_eligible, false);
});

test('ranking adjustment stays disabled until independent holdout validation succeeds', () => {
  const profile = buildCognitiveLearningProfile(Array.from({ length: 40 }, (_, index) =>
    sample(index, index % 2 ? 'UP' : 'DOWN')));
  assert.equal(profile.probability_ready, false);
  assert.equal(applyCognitiveRankAdjustment(72, candidate().features, profile), null);
});

function regimeDriftSamples({ count = 360, changeAt = 96 } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const signal = i % 4 < 2;
    const features = {
      volume_ratio: signal ? 2.2 : 0.8,
      trade_ratio: signal ? 1.7 : 0.85,
      taker_buy_ratio: signal ? 0.62 : 0.44,
      close_location: signal ? 0.78 : 0.35,
      higher_low: signal,
      breakout_above_prior_high: false,
      compression_ratio: signal ? 0.68 : 1.12,
      relative_strength_vs_btc_pct: signal ? 0.9 : -0.45,
      recent_15m_return_pct: signal ? 0.7 : -0.2,
      return_3h_pct: signal ? 1.1 : -0.4,
      trend_aligned: signal,
      micro_5m_available: true,
      micro_5m_taker_buy_ratio: signal ? 0.61 : 0.43
    };
    const oldRegimeUp = signal;
    const newRegimeUp = !signal;
    const up = i < changeAt ? oldRegimeUp : newRegimeUp;
    const outcome = i % 8 === 0 ? 'FLAT' : up ? 'UP' : 'DOWN';
    const at = BASE_TIME + i * 5 * 60 * 60 * 1000;
    rows.push({
      id: 'DRIFT-' + i,
      symbol: 'DRIFT' + String(i % 19).padStart(2, '0') + 'USDT',
      at,
      resolved_at: at + FOUR_HOURS,
      horizon_ms: FOUR_HOURS,
      outcome_source: 'CLOSED_CANDLE_4H',
      training_eligible: true,
      closed_candle_baseline: true,
      outcome,
      return_pct: outcome === 'UP' ? 2.8 : outcome === 'DOWN' ? -2.6 : 0,
      features
    });
  }
  return rows;
}

function noSignalSamples({ count = 600 } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const block = Math.floor(i / 8);
    const combo = i % 8;
    const features = {
      volume_ratio: combo & 1 ? 2.2 : 0.8,
      trade_ratio: combo & 2 ? 1.7 : 0.85,
      taker_buy_ratio: combo & 4 ? 0.62 : 0.44,
      close_location: combo & 1 ? 0.78 : 0.35,
      higher_low: Boolean(combo & 1),
      breakout_above_prior_high: false,
      compression_ratio: combo & 2 ? 0.68 : 1.12,
      relative_strength_vs_btc_pct: combo & 4 ? 0.9 : -0.45,
      recent_15m_return_pct: combo & 1 ? 0.7 : -0.2,
      return_3h_pct: combo & 2 ? 1.1 : -0.4,
      trend_aligned: Boolean(combo & 2),
      micro_5m_available: true,
      micro_5m_taker_buy_ratio: combo & 4 ? 0.61 : 0.43
    };
    const outcome = block % 2 === 0 ? 'UP' : 'DOWN';
    const at = BASE_TIME + i * 5 * 60 * 60 * 1000;
    rows.push({
      id: 'NO-SIGNAL-' + i,
      symbol: 'IDENTITY' + String(block).padStart(2, '0') + 'USDT',
      at,
      resolved_at: at + FOUR_HOURS,
      horizon_ms: FOUR_HOURS,
      outcome_source: 'CLOSED_CANDLE_4H',
      training_eligible: true,
      closed_candle_baseline: true,
      outcome,
      return_pct: outcome === 'UP' ? 2.2 : -2.2,
      features
    });
  }
  return rows;
}

test('recent challenger adapts to a reversed market relationship only after middle-window validation', () => {
  const profile = buildCognitiveLearningProfile(regimeDriftSamples());
  assert.equal(profile.probability_ready, true);
  assert.equal(profile.model_selection.selected_model, 'RECENT_WINDOW');
  assert.equal(profile.regime_adaptation.status, 'RECENT_WINDOW_SELECTED');
  assert.ok(profile.model_selection.recent_validation_brier_score <
    profile.model_selection.global_validation_brier_score);
  const sameEvidence = candidate().features;
  const prediction = assessCognitiveCandidate(candidate(), profile, BASE_TIME + 999_999)
    .predicted_up_probability;
  assert.ok(prediction < 50,
    'the current regime reverses the earlier evidence relationship, so the same evidence must now be judged bearish');
});

test('the model refuses to claim learning when labels are unrelated to market evidence', () => {
  const profile = buildCognitiveLearningProfile(noSignalSamples());
  assert.equal(profile.identifier_features_used, false);
  assert.equal(profile.probability_ready, false,
    'a model that memorizes alternating pair identities must not pass evidence-only validation');
  assert.equal(profile.neural_network.trained, true);
  assert.equal(profile.neural_network.model_kind, 'RESIDUAL_DEEP_MLP_ENSEMBLE_V3');
  assert.equal(profile.neural_network.ensemble_members, 3);
  assert.equal(profile.neural_network.selected, false);
  assert.equal(profile.neural_network.probability_ready, false);
  assert.equal(profile.neural_network.live_eligibility_ready, false,
    'a trained model that was not selected by chronological validation cannot pass the mainnet gate');
  assert.ok(['NO_VALIDATED_MODEL', 'GLOBAL_HISTORY_RETAINED'].includes(profile.regime_adaptation.status));
});


test('market-motive reasoning requires convergent flow and structure, and does not claim whale identity',()=>{
  const candidate={
    symbol:'ACCUMUSDT',price:1.05,change_24h_pct:1.2,score:78,
    data_valid:true,data_stale:false,closed_candles_only:true,candle_age_ms:60_000,
    order_book_checked:true,
    features:{
      volume_ratio:2.1,trade_ratio:1.8,taker_buy_ratio:0.61,
      higher_low:true,breakout_above_prior_high:false,compression_ratio:0.68,
      relative_strength_vs_btc_pct:1.1,recent_15m_return_pct:0.5,
      close_location:0.82,current_range_pct:1.1,upper_wick_pct:0.12,
      trend_aligned:true,micro_5m_available:true,micro_5m_taker_buy_ratio:0.6,
      order_book_checked:true,order_book_spread_bps:9.5,
      order_book_bid_ask_depth_ratio:1.6,order_book_imbalance_pct:23,
      order_book_persistence_samples:1
    }
  };
  const result=assessCognitiveCandidate(candidate,{},BASE_TIME+1_000);
  assert.equal(result.market_motive_assessment.accumulation_hypothesis,'SUPPORTED_BY_CONVERGENT_PUBLIC_EVIDENCE');
  assert.equal(result.market_motive_assessment.order_book_confirmation,'BID_DEPTH_SUPPORTS_BUY_FLOW');
  assert.equal(result.market_motive_assessment.spoofing_assessment,'NOT_ASSESSABLE_SINGLE_SNAPSHOT');
  assert.equal(result.market_motive_assessment.whale_identity_claim,false);
});

test('cognitive brain reports order book not checked and identifies a possible liquidity trap without inventing depth',()=>{
  const candidate={
    symbol:'TRAPUSDT',price:1.01,change_24h_pct:1,score:66,
    data_valid:true,data_stale:false,closed_candles_only:true,candle_age_ms:60_000,
    features:{
      volume_ratio:2.0,trade_ratio:0.85,taker_buy_ratio:0.41,
      higher_low:false,breakout_above_prior_high:false,compression_ratio:1.15,
      relative_strength_vs_btc_pct:-1.3,recent_15m_return_pct:0.8,
      close_location:0.28,current_range_pct:1.0,upper_wick_pct:0.82,
      order_book_checked:true,order_book_spread_bps:42,
      order_book_bid_ask_depth_ratio:0.52,order_book_imbalance_pct:-31,
      order_book_persistence_samples:1
    }
  };
  const result=assessCognitiveCandidate(candidate,{},BASE_TIME+1_000);
  assert.equal(result.market_motive_assessment.possible_liquidity_trap,true);
  assert.equal(result.market_motive_assessment.order_book_confirmation,'NO_CLEAR_BID_DEPTH_SUPPORT');
  assert.equal(result.market_motive_assessment.spoofing_assessment,'NOT_ASSESSABLE_SINGLE_SNAPSHOT');
  assert.ok(result.contradictions.length>=2);
});

test('unobserved order book stays explicitly unknown and never receives a fabricated neutral score',()=>{
  const candidate={
    symbol:'NOBOOKUSDT',price:1,change_24h_pct:0.5,score:60,
    data_valid:true,data_stale:false,closed_candles_only:true,candle_age_ms:30_000,
    features:{volume_ratio:1.4,trade_ratio:1.2,taker_buy_ratio:0.53,
      higher_low:true,breakout_above_prior_high:false,compression_ratio:0.75,
      relative_strength_vs_btc_pct:0.4,close_location:0.7,current_range_pct:1,upper_wick_pct:0.1}
  };
  const result=assessCognitiveCandidate(candidate,{},BASE_TIME+1_000);
  assert.equal(result.market_motive_assessment.order_book_checked,false);
  assert.equal(result.market_motive_assessment.order_book_confirmation,'NOT_CHECKED');
  assert.equal(result.market_motive_assessment.order_book_spread_bps,null);
  assert.equal(result.market_motive_assessment.spoofing_assessment,'NOT_CHECKED');
});

test('prequential audit isolates boosted-tree and hybrid predictions by model variant',()=>{
  const journal=[];
  for(const model of ['GBDT_RESIDUAL','HYBRID_GBDT_MLP_W75']){
    for(let index=0;index<12;index++){
      const at=BASE_TIME+(model==='GBDT_RESIDUAL'?0:100)*FOUR_HOURS+
        index*5*60*60*1000;
      const outcome=index%2===0?'UP':'DOWN';
      journal.push({
        id:model+'-'+index,model_version:5,selected_model:model,
        target_definition:'UP_CLOSE_RETURN_BINARY_V1',
        at,trained_through_at:at-60_000,resolved_at:at+FOUR_HOURS,
        outcome_source:'CLOSED_CANDLE_4H',outcome,
        predicted_up_probability:outcome==='UP'?90:10
      });
    }
  }
  const treeAudit=buildCognitivePrequentialProfile(journal,{
    minimumWindowSamples:4,windowSize:6,modelVariant:'GBDT_RESIDUAL'
  });
  const hybridAudit=buildCognitivePrequentialProfile(journal,{
    minimumWindowSamples:4,windowSize:6,modelVariant:'HYBRID_GBDT_MLP_W75'
  });
  assert.equal(treeAudit.resolved_forecasts,12);
  assert.equal(treeAudit.excluded_other_model_variant_forecasts,12);
  assert.equal(hybridAudit.resolved_forecasts,12);
  assert.equal(hybridAudit.excluded_other_model_variant_forecasts,12);
  assert.equal(treeAudit.recent_window.brier_score,0.01);
  assert.equal(hybridAudit.recent_window.brier_score,0.01);
});

test('prequential audit never mixes neural and logistic model variants after model selection changes', () => {
  const journal = [];
  for (let index = 0; index < 40; index++) {
    const outcome = index % 2 === 0 ? 'UP' : 'DOWN';
    const at = BASE_TIME + index * 5 * 60 * 60 * 1000;
    const logisticBlock = index < 20;
    const correct = logisticBlock;
    const predicted = correct
      ? (outcome === 'UP' ? 90 : 10)
      : (outcome === 'UP' ? 10 : 90);
    journal.push({
      id: 'VARIANT-' + index, model_version: 5,
      selected_model: logisticBlock ? 'GLOBAL_HISTORY' : 'NEURAL_GLOBAL',
      target_definition:logisticBlock?undefined:'UP_CLOSE_RETURN_BINARY_V1',
      at, trained_through_at: at - 60 * 60 * 1000,
      resolved_at: at + FOUR_HOURS,
      outcome_source: 'CLOSED_CANDLE_4H', outcome,
      predicted_up_probability: predicted
    });
  }
  const audit = buildCognitivePrequentialProfile(journal, {
    minimumWindowSamples: 10, windowSize: 10
  });
  assert.equal(audit.all_v5_resolved_forecasts, 40);
  assert.equal(audit.audited_model_variant, 'NEURAL_GLOBAL');
  assert.equal(audit.resolved_forecasts, 20);
  assert.equal(audit.excluded_other_model_variant_forecasts, 20);
  assert.equal(audit.previous_window.sample_count, 10);
  assert.equal(audit.recent_window.sample_count, 10);
  assert.equal(audit.drift_detected, false,
    'a newly selected model must not inherit the previous model variant error history');
});


test('prequential audit isolates temporal first-passage forecasts from the legacy four-hour close target',()=>{
  const journal=[];
  for(let index=0;index<30;index++){
    const at=BASE_TIME+index*5*60*60*1000;
    const outcome=index%2===0?'UP':'DOWN';
    journal.push({
      id:'TCN-FWD-'+index,model_version:5,selected_model:'TEMPORAL_TCN',
      target_definition:'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2',
      at,trained_through_at:at-60_000,resolved_at:at+FOUR_HOURS,horizon_ms:FOUR_HOURS,
      outcome_source:'CLOSED_CANDLE_4H_FIRST_PASSAGE_V1',outcome,
      predicted_up_probability:outcome==='UP'?80:20
    });
  }
  journal.push({
    ...journal[0],id:'TCN-WRONG-TARGET',
    target_definition:'LEGACY_4H_CLOSE_RETURN',outcome_source:'CLOSED_CANDLE_4H'
  });
  journal.push({
    ...journal[0],id:'TCN-WRONG-SOURCE',
    outcome_source:'CLOSED_CANDLE_4H'
  });
  const audit=buildCognitivePrequentialProfile(journal,{
    minimumWindowSamples:10,windowSize:10,modelVariant:'TEMPORAL_TCN'
  });
  assert.equal(audit.audited_model_variant,'TEMPORAL_TCN');
  assert.equal(audit.resolved_forecasts,30);
  assert.equal(audit.all_v5_resolved_forecasts,30);
  assert.equal(audit.recent_window.sample_count,10);
  assert.equal(audit.previous_window.sample_count,10);
  assert.equal(audit.drift_detected,false);
});


test('temporal prequential audit counts flat first-passage outcomes as target misses',()=>{
  const journal=Array.from({length:4},(_,index)=>{
    const at=BASE_TIME+index*5*60*60*1000;
    return {
      id:'TCN-FLAT-'+index,model_version:5,selected_model:'TEMPORAL_TCN',
      target_definition:'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2',
      at,trained_through_at:at-60_000,resolved_at:at+FOUR_HOURS,horizon_ms:FOUR_HOURS,
      outcome_source:'CLOSED_CANDLE_4H_FIRST_PASSAGE_V1',outcome:'FLAT',
      predicted_up_probability:10
    };
  });
  const audit=buildCognitivePrequentialProfile(journal,{
    minimumWindowSamples:2,windowSize:2,modelVariant:'TEMPORAL_TCN'
  });
  assert.equal(audit.previous_window.brier_score,0.01);
  assert.equal(audit.recent_window.brier_score,0.01);
  assert.equal(audit.previous_window.directional_accuracy_pct,null);
});

test('prequential audit scores only immutable, matured V5 forecasts and detects sustained degradation', () => {
  const journal = Array.from({ length: 60 }, (_, index) => {
    const outcome = index % 2 === 0 ? 'UP' : 'DOWN';
    const predictionIsCorrect = index < 30;
    const predicted = predictionIsCorrect
      ? (outcome === 'UP' ? 90 : 10)
      : (outcome === 'UP' ? 10 : 90);
    const at = BASE_TIME + index * 5 * 60 * 60 * 1000;
    return {
      id: 'FORWARD-' + index, model_version: 5, at,
      trained_through_at: at - 60 * 60 * 1000,
      resolved_at: at + FOUR_HOURS, horizon_ms: FOUR_HOURS,
      outcome_source: 'CLOSED_CANDLE_4H', outcome,
      reason_codes: index < 30 ? ['VOLUME_EXPANSION'] : ['BUYER_FLOW_SUPPORT'],
      predicted_up_probability: predicted
    };
  });
  journal.push({ ...journal[0], id: 'OLD-V3', model_version: 3 });
  journal.push({ ...journal[0], id: 'OLD-V4', model_version: 4 });
  journal.push({ ...journal[0], id: 'OLD-V1', model_version: 1 });
  journal.push({ ...journal[0], id: 'UNRESOLVED', outcome: null });
  journal.push({ ...journal[0], id: 'LOOKAHEAD', trained_through_at: journal[0].at + 1 });
  journal.push({ ...journal[0], id: 'NO-CUTOFF', trained_through_at: null });
  const audit = buildCognitivePrequentialProfile(journal, { minimumWindowSamples: 20, windowSize: 30 });
  assert.equal(audit.resolved_forecasts, 60);
  assert.equal(audit.previous_window.sample_count, 30);
  assert.equal(audit.recent_window.sample_count, 30);
  assert.equal(audit.drift_detected, true);
  assert.equal(audit.reassessment_required, true);
  assert.equal(audit.status, 'FORWARD_PERFORMANCE_DEGRADING');
  assert.equal(audit.recent_window.high_confidence_error_count, 30);
  assert.equal(audit.recent_window.error_patterns[0].reason_code, 'BUYER_FLOW_SUPPORT');
  assert.equal(audit.recent_window.error_patterns[0].high_confidence_errors, 30);
});


test('Newton boosted-tree challenger learns nonlinear conjunctions without using the final holdout for selection',()=>{
  const rows=Array.from({length:1440},(_,index)=>{
    const volumeState=index%2===0;
    const compressionState=Math.floor(index/2)%2===0;
    const isPositive=volumeState&&compressionState;
    const at=BASE_TIME+index*5*60*60*1000;
    return {
      id:'XOR-BOOST-'+index,symbol:'XORPAIR'+String(index%19)+'USDT',
      at,resolved_at:at+FOUR_HOURS,horizon_ms:FOUR_HOURS,
      outcome_source:'CLOSED_CANDLE_4H',training_eligible:true,
      closed_candle_baseline:true,outcome:isPositive?'UP':'DOWN',
      features:{
        volume_ratio:volumeState?2.8:0.55,trade_ratio:1,
        taker_buy_ratio:0.55,higher_low:false,breakout_above_prior_high:false,
        compression_ratio:compressionState?0.55:1.25,
        relative_strength_vs_btc_pct:0,recent_15m_return_pct:0,
        trend_aligned:false,micro_5m_available:false,close_location:0.5
      }
    };
  });
  const profile=buildCognitiveLearningProfile(rows);
  console.log('[GBDT_NONLINEAR_FIXTURE_DIAGNOSTIC]',JSON.stringify({
    tree:{trained:profile.boosted_tree_model.trained,selected:profile.boosted_tree_model.selected,
      tree_count:profile.boosted_tree_model.tree_count,
      candidate_count:profile.boosted_tree_model.candidate_attempt_count,
      fit_count:profile.boosted_tree_model.candidate_tree_fit_count,
      selection_count:profile.boosted_tree_model.selection_sample_count,
      selection_support:profile.boosted_tree_model.selection_support_ready,
      selected_configuration:profile.boosted_tree_model.selected_configuration,
      fit_failure_reason:profile.boosted_tree_model.fit_failure_reason,
      probability_calibration:profile.boosted_tree_model.probability_calibration,
      selection:profile.boosted_tree_model.selection_logistic,
      candidates:profile.boosted_tree_model.candidate_selection_metrics?.map(row=>({
        configuration:row.configuration,selection_brier:row.selection_brier_score,
        selection_beats_logistic:row.selection_beats_same_window_logistic,
        selected:row.selected_for_refit
      }))},
    hybrid:{status:profile.hybrid_model.status,trained:profile.hybrid_model.trained,
      weight_fit_samples:profile.hybrid_model.weight_fit_samples,
      selection_samples:profile.hybrid_model.selection_samples,
      weight:profile.hybrid_model.boosted_weight}
  }));
  assert.equal(profile.boosted_tree_model.trained,true,
    'the new tree challenger must train once the outer training block has enough mature rows');
  assert.ok(profile.boosted_tree_model.tree_count>0);
  assert.equal(profile.boosted_tree_model.probability_calibration?.fit_on,
    'LATE_CHRONOLOGICAL_CALIBRATION_FIT_BLOCK',
    'the GBDT component must expose its own later, disjoint probability calibration');
  assert.equal(profile.boosted_tree_model.validation.evaluated,true);
  assert.equal(profile.boosted_tree_model.search_grid_size,9);
  assert.equal(profile.boosted_tree_model.candidate_fit_diagnostics.length,9,
    'every pre-declared GBDT schedule must report whether a gainful root split exists');
  assert.equal(profile.boosted_tree_model.candidate_attempt_count,9);
  assert.ok(profile.boosted_tree_model.candidate_fit_diagnostics.every(row=>
    row.root_gain?.evaluated===true&&Number.isFinite(row.root_gain.best_root_split_gain??0)));
  assert.equal(profile.boosted_tree_model.candidate_selection_metrics.length,
    profile.boosted_tree_model.candidate_tree_fit_count,
    'only actual fitted GBDT trees may enter selection scoring');
  const treeCandidates=profile.boosted_tree_model.candidate_selection_metrics;
  assert.ok(treeCandidates.every(row=>
    row.training_samples===profile.boosted_tree_model.selection_training_samples&&
    row.selection_sample_count===profile.boosted_tree_model.selection_sample_count));
  assert.equal(treeCandidates.filter(row=>row.selected_for_refit).length,1,
    'only one selection-qualified GBDT configuration may be refit');
  const selectionWinner=treeCandidates.find(row=>row.selected_for_refit);
  assert.ok(selectionWinner.selection_beats_base_rate);
  assert.ok(selectionWinner.selection_beats_same_window_logistic);
  assert.equal(profile.boosted_tree_model.selected_configuration,selectionWinner.configuration,
    'the GBDT configuration must be fixed before the outer validation block is scored');
  assert.equal(selectionWinner.validation_sample_count,profile.validation_samples);
  assert.ok(treeCandidates.filter(row=>!row.selected_for_refit)
    .every(row=>row.validation_sample_count===0&&row.validation_brier_score===null),
    'unselected configurations must never be evaluated against the outer validation block');
  const importance=profile.boosted_tree_model.feature_importance;
  assert.ok(importance.length>0,'every fitted tree must expose at least one gain-attributed feature');
  assert.ok(importance.every(row=>profile.feature_names.includes(row.feature)&&
    row.gain>0&&row.split_count>0));
  assert.ok(Math.abs(importance.reduce((sum,row)=>sum+row.gain_share_pct,0)-100)<0.1);
  assert.ok(profile.boosted_tree_model.feature_importance_total_gain>0);
  const ranking=profile.boosted_tree_model.validation.ranking_metrics;
  assert.ok(Number.isFinite(ranking.auc_roc)&&ranking.auc_roc>=0&&ranking.auc_roc<=1);
  assert.ok(ranking.top_10_pct.sample_count>=1);
  assert.ok(ranking.top_20_pct.sample_count>=ranking.top_10_pct.sample_count);
  assert.equal(profile.hybrid_model.minimum_component_weight,0.05);
  if(profile.hybrid_model.trained){
    assert.equal(profile.hybrid_model.candidate_selection_metrics.length,1,
      'only a genuine two-component analytically weighted hybrid may be trained');
    assert.equal(profile.hybrid_model.weight_collapsed_to_single_component,false);
    const blendCandidate=profile.hybrid_model.candidate_selection_metrics[0];
    assert.equal(blendCandidate.name,'HYBRID_GBDT_MLP_BRIER_OPTIMAL');
    assert.ok(Number.isFinite(blendCandidate.boosted_weight)&&
      blendCandidate.boosted_weight>=0.05&&blendCandidate.boosted_weight<=0.95);
  }else{
    assert.equal(profile.hybrid_model.candidate_selection_metrics.length,0);
    assert.equal(profile.hybrid_model.weight_collapsed_to_single_component,true);
    assert.equal(profile.hybrid_model.status,'HYBRID_WEIGHT_COLLAPSED_TO_SINGLE_COMPONENT');
  }
  const blendCandidate=profile.hybrid_model.candidate_selection_metrics[0];
  if(profile.hybrid_model.trained){
    assert.ok(blendCandidate.weight_fit_sample_count>=20);
    assert.ok(blendCandidate.weight_fit_start_at<=blendCandidate.weight_fit_end_at);
    assert.ok(blendCandidate.weight_fit_end_at<blendCandidate.weight_fit_selection_start_at,
      'blend-weight fitting labels must finish before its disjoint selection block begins');
  }else{
    assert.ok(Number.isFinite(profile.hybrid_model.raw_optimal_boosted_weight)&&
      profile.hybrid_model.raw_optimal_boosted_weight>=0&&
      profile.hybrid_model.raw_optimal_boosted_weight<=1,
      'a rejected blend must still expose its finite unconstrained weight-fit diagnostic');
    assert.equal(profile.hybrid_model.weight_collapsed_to_single_component,true,
      'the final blend must fail closed when later selection does not validate a two-component mixture');
  }
  assert.ok(profile.hybrid_model.weight_fit_samples>=20);
  assert.ok(profile.hybrid_model.weight_fit_end_at<profile.hybrid_model.weight_fit_cut_at);
  assert.ok(profile.hybrid_model.selection_samples>=20);
  assert.ok(profile.hybrid_model.weight_fit_cut_at<profile.validation_start_at,
    'the frozen blend weight must be tested on a later pre-validation block');
  assert.ok(profile.hybrid_model.selection_start_at<profile.validation_start_at,
    'blend-weight selection must finish before outer validation begins');
  if(profile.hybrid_model.trained){
    assert.ok(profile.hybrid_model.candidate_selection_metrics.every(row=>
      row.selection_sample_count===profile.hybrid_model.selection_samples&&
      Number.isFinite(row.selection_brier_score)&&Number.isFinite(row.selection_base_rate_brier_score)&&
      Number.isFinite(row.weight_fit_sample_count)&&row.weight_fit_sample_count===profile.hybrid_model.weight_fit_samples));
  }
  assert.ok(profile.hybrid_model.candidate_validation_metrics.length<=1,
    'only the inner-selected blend weight may reach outer validation');
  if(profile.hybrid_model.candidate_validation_metrics.length===1){
    const frozen=profile.hybrid_model.candidate_validation_metrics[0];
    assert.equal(frozen.name,profile.hybrid_model.selection_winner_candidate);
    assert.equal(frozen.boosted_weight,profile.hybrid_model.boosted_weight);
    assert.equal(frozen.validation_sample_count,profile.validation_samples);
  }
  assert.ok(profile.max_training_outcome_resolved_at<profile.validation_start_at);
  assert.ok(profile.validation_start_at<profile.holdout_start_at);
  if(profile.model_selection.active_challenger){
    assert.equal(profile.model_selection.challenger_holdout_passed,true,
      'a challenger is active only after its single validation-selected candidate passes the untouched holdout');
    assert.equal(profile.model_selection.selected_model,profile.model_selection.active_challenger);
  }
});

test('prequential audit treats boosted and hybrid forecasts as separate binary model variants',()=>{
  for(const modelVariant of ['GBDT_RESIDUAL','HYBRID_GBDT_MLP_W75']){
    const journal=Array.from({length:8},(_,index)=>{
      const at=BASE_TIME+index*5*60*60*1000;
      const outcome=index%2===0?'UP':'DOWN';
      return {
        id:modelVariant+'-'+index,model_version:5,selected_model:modelVariant,
        target_definition:'UP_CLOSE_RETURN_BINARY_V1',
        at,trained_through_at:at-60_000,resolved_at:at+FOUR_HOURS,horizon_ms:FOUR_HOURS,
        outcome_source:'CLOSED_CANDLE_4H',outcome,
        predicted_up_probability:outcome==='UP'?90:10
      };
    });
    const audit=buildCognitivePrequentialProfile(journal,{
      minimumWindowSamples:2,windowSize:4,modelVariant
    });
    assert.equal(audit.audited_model_variant,modelVariant);
    assert.equal(audit.resolved_forecasts,8);
    assert.equal(audit.recent_window.brier_score,0.01);
    assert.equal(audit.previous_window.brier_score,0.01);
  }
});

test('V5 prequential audit treats FLAT as a non-UP outcome',()=>{
  const journal=Array.from({length:8},(_,index)=>{
    const at=BASE_TIME+index*5*60*60*1000;
    const outcome=index%2===0?'UP':index%4===1?'FLAT':'DOWN';
    return {
      id:'V5-UP-EVENT-'+index,model_version:5,selected_model:'NEURAL_GLOBAL',
      target_definition:'UP_CLOSE_RETURN_BINARY_V1',
      at,trained_through_at:at-60_000,resolved_at:at+FOUR_HOURS,horizon_ms:FOUR_HOURS,
      outcome_source:'CLOSED_CANDLE_4H',outcome,
      predicted_up_probability:outcome==='UP'?90:10
    };
  });
  const audit=buildCognitivePrequentialProfile(journal,{
    minimumWindowSamples:2,windowSize:4,modelVariant:'NEURAL_GLOBAL'
  });
  assert.equal(audit.audited_model_variant,'NEURAL_GLOBAL');
  assert.equal(audit.resolved_forecasts,8);
  assert.equal(audit.recent_window.brier_score,0.01);
  assert.equal(audit.previous_window.brier_score,0.01);
});


test('cognitive model ranking excludes FLAT from directional AUC and top-k denominators',()=>{
  const rows=[
    {outcome:'FLAT',target:0},
    {outcome:'FLAT',target:0},
    {outcome:'UP',target:1},
    {outcome:'UP',target:1},
    {outcome:'DOWN',target:0},
    {outcome:'DOWN',target:0},
    {outcome:'DOWN',target:0},
    {outcome:'DOWN',target:0},
    {outcome:'DOWN',target:0},
    {outcome:'DOWN',target:0},
    {outcome:'DOWN',target:0},
    {outcome:'DOWN',target:0}
  ];
  // The FLAT scores are deliberately highest. They must not take top-k slots.
  const scores=[0.999,0.998,0.99,0.98,0.97,0.96,0.95,0.94,0.93,0.92,0.91,0.90];
  const metrics=evaluateCognitiveDirectionalRanking(rows,scores);
  assert.equal(metrics.all_outcome_sample_count,12);
  assert.equal(metrics.directional_sample_count,10);
  assert.equal(metrics.excluded_flat_samples,2);
  assert.equal(metrics.positive_samples,2);
  assert.equal(metrics.negative_samples,8);
  assert.equal(metrics.top_10_pct.sample_count,1,
    'top 10% must be 10% of the 10 directional cases, not 10% of 12 including FLAT');
  assert.equal(metrics.top_10_pct.positive_samples,1);
  assert.equal(metrics.top_10_pct.precision_pct,100);
  assert.equal(metrics.top_20_pct.sample_count,2);
  assert.equal(metrics.top_20_pct.positive_samples,2);
  assert.equal(metrics.top_20_pct.recall_pct,100);
});

test('cognitive directional ranking keeps missing scores at the bottom without dropping directional rows',()=>{
  const rows=[
    {outcome:'UP',target:1},{outcome:'DOWN',target:0},
    {outcome:'UP',target:1},{outcome:'DOWN',target:0},
    {outcome:'FLAT',target:0}
  ];
  const metrics=evaluateCognitiveDirectionalRanking(rows,[null,0.8,0.7,null,0.99]);
  assert.equal(metrics.directional_sample_count,4);
  assert.equal(metrics.missing_score_samples,2);
  assert.equal(metrics.top_10_pct.sample_count,1);
  assert.equal(metrics.top_10_pct.positive_samples,0);
});


test('Cognitive MLP V5 accepts only the same audited four-hour 1m first-touch event contract as TCN',()=>{
  const interval=15*60*1000;
  const at=Math.ceil(BASE_TIME/interval)*interval;
  const row={
    ...sample(701,'UP'),
    id:'MLP-4H-FIRST-TOUCH-VALID',
    symbol:'VALIDPAIRUSDT',
    at,resolved_at:at+NEURAL_CLOSURE_HORIZON_MS,
    horizon_ms:NEURAL_CLOSURE_HORIZON_MS,
    feature_information_cutoff_at:at,
    closed_candle_baseline:true,
    historical_baseline:false,
    training_eligible:true,
    market:'BINANCE_SPOT_USDT',
    source_audit:{
      exchange:'BINANCE',market:'SPOT',interval:'1m',
      transport:'BINANCE_PUBLIC_REST',symbol:'VALIDPAIRUSDT',
      received_at:at+NEURAL_CLOSURE_HORIZON_MS+60_000,
      observed_candles:240,raw_klines_sha256:'b'.repeat(64)
    },
    outcome:'UP',
    outcome_source:NEURAL_CLOSURE_OUTCOME_SOURCE,
    target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
    target_semantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
    first_touch:{
      resolution:'TAKE_PROFIT_FIRST',first_touch_at:at+59_999,
      path_resolution:'1M',observed_candles:240,
      raw_klines_sha256:'b'.repeat(64),
      baseline_price:100,take_profit_price:103,stop_loss_price:98
    },
    temporal_sequence:Array.from({length:24},(_,time)=>
      Array.from({length:29},(_,channel)=>channel===28?0.65:
        Math.sin((time+1)*(channel+1)*0.07)*0.35)),
    temporal_sequence_timestamps:Array.from({length:24},(_,index)=>
      at-(23-index)*interval)
  };
  const profile=buildFourHourCognitiveLearningProfile([row]);
  assert.equal(profile.resolved_samples,1);
  assert.equal(profile.outcome_counts.up,1);
  assert.equal(profile.neural_network.target_definition,NEURAL_CLOSURE_TARGET_DEFINITION);
  assert.equal(profile.neural_network.target_semantics,NEURAL_CLOSURE_TARGET_SEMANTICS);
  assert.equal(profile.temporal_network.resolved_samples,1);
  assert.equal(profile.temporal_network.outcome_contract_kind,'FIRST_TOUCH_4H_1M');
  assert.equal(profile.temporal_network.temporal_label_resolution,
    '1M_FIRST_TOUCH_WITH_15M_CLOSED_FEATURES');
  assert.equal(profile.neural_network.probability_ready,false,
    'one audited row is valid intake but insufficient for training or model selection');

  const badCount={...row,first_touch:{...row.first_touch,observed_candles:239}};
  assert.throws(()=>buildFourHourCognitiveLearningProfile([badCount]),
    /FOUR_HOUR_COGNITIVE_LABEL_INVALID/);
  const badSource={...row,outcome_source:'HISTORICAL_CLOSED_CANDLE'};
  assert.throws(()=>buildFourHourCognitiveLearningProfile([badSource]),
    /FOUR_HOUR_COGNITIVE_LABEL_INVALID/);
  const badBarrier={...row,first_touch:{...row.first_touch,take_profit_price:104}};
  assert.throws(()=>buildFourHourCognitiveLearningProfile([badBarrier]),
    /FOUR_HOUR_COGNITIVE_LABEL_INVALID/);
  assert.throws(()=>buildFourHourCognitiveLearningProfile([row],{
    modelTargetDefinition:'LEGACY_CLOSE_ONLY_TARGET'
  }),/FOUR_HOUR_COGNITIVE_CONTRACT_OVERRIDE_FORBIDDEN/);
  assert.throws(()=>buildFourHourCognitiveLearningProfile([row],{
    temporalOptions:{sequenceIntervalMs:60_000}
  }),/FOUR_HOUR_COGNITIVE_TEMPORAL_CONTRACT_OVERRIDE_FORBIDDEN/);
});
