import {buildCognitiveLearningProfile,COGNITIVE_DAILY_FEATURE_SCHEMA} from './cognitive-brain.mjs';
import {buildTemporalNeuralProfile,TEMPORAL_SEQUENCE_STEPS,TEMPORAL_SEQUENCE_CHANNELS} from './temporal-neural-brain.mjs';

export const DAILY_EARLY_RISER_HORIZON_MS = 24 * 60 * 60 * 1000;
export const DAILY_EARLY_RISER_TARGETS_PCT = Object.freeze([5,10,15]);
export const DAILY_EARLY_RISER_TCN_MAX_TRAINING_SAMPLES = 32768;
export const DAILY_EARLY_RISER_MLP_MAX_TRAINING_SAMPLES = 32768;
export const DAILY_EARLY_RISER_MLP_TRAINING_HISTORY_FRACTION = 0.60;
// Inner MLP member-choice margin only; outer validation and holdout remain 0.003.
export const DAILY_EARLY_RISER_MLP_INNER_SELECTION_MARGIN = 0.00025;
// Experimental MLP anchor update; coefficients stay inside a narrow trust region.
export const DAILY_EARLY_RISER_MLP_ANCHOR_ADAPTATION = 'TRUST_REGION_TETHERED_V1';
export const DAILY_EARLY_RISER_OUTCOME_SOURCE =
  'BINANCE_OFFICIAL_CLOSED_15M_FIRST_PASSAGE_24H_V1';
export const DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA = COGNITIVE_DAILY_FEATURE_SCHEMA;

const finite=value=>{
  if(value===null||value===undefined||value===''||typeof value==='boolean')return null;
  const number=Number(value);
  return Number.isFinite(number)?number:null;
};
const targetKey=target=>'plus_'+String(target).replace('.','_')+'_pct';
const targetDefinition=target=>'FIRST_PASSAGE_PLUS_'+target+'_PCT_BEFORE_MINUS_2_PCT_24H_15M_V1';

export function summarizeDailyNeuralAnchorDiagnostics(
  neural={},requestedMode=DAILY_EARLY_RISER_MLP_ANCHOR_ADAPTATION
){
  return {
    anchor_adaptation_requested:requestedMode,
    anchor_adaptation:neural?.anchor_adaptation??'NOT_REPORTED',
    anchor_trust_radius:finite(neural?.anchor_trust_radius),
    anchor_bias_trust_radius:finite(neural?.anchor_bias_trust_radius),
    anchor_tether_strength:finite(neural?.anchor_tether_strength),
    anchor_learning_rate_scale:finite(neural?.anchor_learning_rate_scale),
    max_anchor_skip_delta:finite(neural?.max_anchor_skip_delta),
    anchor_output_bias_delta:finite(neural?.anchor_output_bias_delta)
  };
}

function validTemporalSequence(sequence){
  return Array.isArray(sequence)&&sequence.length===TEMPORAL_SEQUENCE_STEPS&&
    sequence.every(step=>Array.isArray(step)&&step.length===TEMPORAL_SEQUENCE_CHANNELS&&
      step.every(value=>finite(value)!==null&&Math.abs(Number(value))<=4));
}

export function prepareDailyEarlyRiserCognitiveRow(sample,targetPct){
  const target=finite(targetPct);
  if(target===null||!DAILY_EARLY_RISER_TARGETS_PCT.includes(target))
    return {row:null,reason:'UNSUPPORTED_TARGET'};
  if(!sample||typeof sample!=='object')
    return {row:null,reason:'SAMPLE_INVALID'};
  const label=sample.targets?.[targetKey(target)];
  if(!label||label.status!=='RESOLVED'||!['UP','DOWN','FLAT'].includes(label.outcome))
    return {row:null,reason:'LABEL_NOT_RESOLVED'};
  const at=finite(sample.at);
  const resolvedAt=finite(label.resolved_at);
  const horizon=finite(label.horizon_ms);
  if(at===null||resolvedAt===null||resolvedAt-at!==DAILY_EARLY_RISER_HORIZON_MS||
    horizon!==DAILY_EARLY_RISER_HORIZON_MS)
    return {row:null,reason:'LABEL_HORIZON_MISMATCH'};
  if(finite(sample.feature_information_cutoff_at)!==at||
    sample.observation_source!=='BINANCE_OFFICIAL_CLOSED_15M_BASELINE')
    return {row:null,reason:'FEATURE_CUTOFF_NOT_AT_BASELINE'};
  if(label.outcome_source!==DAILY_EARLY_RISER_OUTCOME_SOURCE||
    label.target_definition!==targetDefinition(target))
    return {row:null,reason:'OUTCOME_SOURCE_OR_DEFINITION_MISMATCH'};
  const symbol=String(sample.symbol||'').trim().toUpperCase();
  const id=String(sample.id||'').trim();
  if(!symbol||!id||!sample.features||typeof sample.features!=='object'||
    Array.isArray(sample.features))
    return {row:null,reason:'IDENTITY_OR_FEATURES_INVALID'};
  const baselineFeatures={...sample.features};
  // These values are independently calculated from the 96 closed 15m
  // candles ending exactly at the observation baseline.
  for(const key of ['quote_volume_24h','daily_change_pct','relative_strength_vs_btc_24h_pct']){
    const value=finite(sample[key]);
    if(value!==null)baselineFeatures[key]=value;
  }
  return {
    row:{
      id:id+':TRADEABLE_FIRST_PASSAGE_PLUS_'+target+'_PCT',
      symbol,
      at,
      resolved_at:resolvedAt,
      horizon_ms:DAILY_EARLY_RISER_HORIZON_MS,
      outcome:label.outcome,
      outcome_source:DAILY_EARLY_RISER_OUTCOME_SOURCE,
      target_definition:label.target_definition,
      first_passage:{path_resolution:'15M',outcome:label.outcome},
      temporal_sequence:validTemporalSequence(sample.temporal_sequence)?sample.temporal_sequence:null,
      historical_baseline:true,
      closed_candle_baseline:true,
      training_eligible:true,
      features:baselineFeatures
    },
    reason:null
  };
}

function countOutcomes(rows){
  const counts={UP:0,DOWN:0,FLAT:0};
  for(const row of rows)counts[row.outcome]++;
  return counts;
}

export function benchmarkDailyEarlyRiserTarget(samples,targetPct,options={}){
  const target=finite(targetPct);
  if(target===null||!DAILY_EARLY_RISER_TARGETS_PCT.includes(target))
    throw new Error('UNSUPPORTED_DAILY_EARLY_RISER_TARGET');
  const rows=[];
  const rejected={};
  const seen=new Set();
  for(const sample of Array.isArray(samples)?samples:[]){
    const prepared=prepareDailyEarlyRiserCognitiveRow(sample,target);
    if(!prepared.row){
      const reason=prepared.reason||'UNKNOWN_REJECTION';
      rejected[reason]=(rejected[reason]||0)+1;
      continue;
    }
    const identity=prepared.row.symbol+':'+String(prepared.row.at);
    if(seen.has(identity)){
      rejected.DUPLICATE_SYMBOL_BASELINE=(rejected.DUPLICATE_SYMBOL_BASELINE||0)+1;
      continue;
    }
    seen.add(identity);
    rows.push(prepared.row);
  }
  rows.sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol)||a.id.localeCompare(b.id));
  const outcomeCounts=countOutcomes(rows);
  const temporalRows=rows.filter(row=>validTemporalSequence(row.temporal_sequence));
  const targetContract=targetDefinition(target);
  const temporal=buildTemporalNeuralProfile(temporalRows,{
    minTrainingSamples:Math.max(160,Math.trunc(options.temporalMinTrainingSamples||160)),
    maxTrainingSamples:Math.max(160,Math.min(DAILY_EARLY_RISER_TCN_MAX_TRAINING_SAMPLES,
      Math.trunc(options.temporalMaxTrainingSamples||DAILY_EARLY_RISER_TCN_MAX_TRAINING_SAMPLES))),
    minimumValidationSamples:Math.max(24,Math.trunc(options.temporalMinValidationSamples||24)),
    minimumHoldoutSamples:Math.max(40,Math.trunc(options.temporalMinHoldoutSamples||40)),
    liveHoldoutSamples:Math.max(100,Math.trunc(options.temporalLiveHoldoutSamples||150)),
    epochs:Math.max(5,Math.min(20,Math.trunc(options.temporalEpochs||10))),
    targetDefinition:targetContract,
    outcomeHorizonMs:DAILY_EARLY_RISER_HORIZON_MS,
    allowedOutcomeSources:[DAILY_EARLY_RISER_OUTCOME_SOURCE],
    comparisonMargin:0.003,
    enableRegimeLocalTcn:options.enableRegimeLocalTcn!==false,
    regimeLocalTcnMaxTrainingSamples:Math.max(80,Math.min(4096,
      Math.trunc(options.temporalRegimeLocalTcnMaxTrainingSamples||4096))),
    regimeLocalTcnEpochs:Math.max(1,Math.min(8,
      Math.trunc(options.temporalRegimeLocalTcnEpochs||6))),
    enableRegimeLocalTcnPyramid:options.enableRegimeLocalTcnPyramid!==false,
    regimeLocalTcnPyramidMaxTrainingSamples:Math.max(80,Math.min(4096,
      Math.trunc(options.temporalRegimeLocalTcnPyramidMaxTrainingSamples||4096))),
    regimeLocalTcnPyramidEpochs:Math.max(1,Math.min(8,
      Math.trunc(options.temporalRegimeLocalTcnPyramidEpochs||6))),
    enableRegimeLocalTcnMultiscale:options.enableRegimeLocalTcnMultiscale!==false,
    regimeLocalTcnMultiscaleMaxTrainingSamples:Math.max(80,Math.min(4096,
      Math.trunc(options.temporalRegimeLocalTcnMultiscaleMaxTrainingSamples||4096))),
    regimeLocalTcnMultiscaleEpochs:Math.max(1,Math.min(8,
      Math.trunc(options.temporalRegimeLocalTcnMultiscaleEpochs||6))),
    enableTemporalBoostedTree:options.enableTemporalBoostedTree!==false
  });
  const temporalTree=temporal.temporal_boosted_tree||{};
  if(options.tcnOnly===true){
    return {
      target_pct:target,
      outcome_semantics:'TARGET_BEFORE_MINUS_2_PERCENT_ADVERSE_BARRIER_WITHIN_24H',
      outcome_source:DAILY_EARLY_RISER_OUTCOME_SOURCE,
      target_definition:targetContract,
      horizon_ms:DAILY_EARLY_RISER_HORIZON_MS,
      feature_schema:'TCN_ONLY_24X29_CLOSED_CANDLE_SEQUENCE',
      feature_names:[],
      research_mode:'TCN_ONLY_ISOLATED_COMPUTE',
      temporal_tcn_training_performed:temporal.trained===true,
      temporal_tcn_evaluation_performed:temporalRows.length>0,
      temporal_tcn_sequence_samples:temporalRows.length,
      temporal_tcn_reason:temporal.trained===true?null:
        (temporal.status||'TEMPORAL_TCN_TRAINING_NOT_COMPLETED'),
      temporal_tcn:temporal,
      temporal_tree_training_performed:false,
      temporal_tree_challenger:temporalTree,
      temporal_regime_local_tcn_challenger:temporal.regime_local_tcn_challenger??null,
      temporal_regime_local_tcn_pyramid_challenger:temporal.regime_local_tcn_pyramid_challenger??null,
      temporal_regime_local_tcn_multiscale_challenger:temporal.regime_local_tcn_multiscale_challenger??null,
      samples:{
        accepted:rows.length,
        rejected:Object.values(rejected).reduce((sum,value)=>sum+value,0),
        rejection_reasons:rejected,
        outcomes:outcomeCounts,
        positive_rate_pct:rows.length?Number((outcomeCounts.UP/rows.length*100).toFixed(4)):0
      },
      chronology:{
        first_at:rows[0]?.at??null,
        last_at:rows.at(-1)?.at??null,
        validation_start_at:temporal.validation_start_at??null,
        holdout_start_at:temporal.holdout_start_at??null,
        training_samples:temporal.training_samples??0,
        validation_samples:temporal.validation_samples??0,
        holdout_samples:temporal.holdout_samples??0,
        maximum_training_outcome_resolved_at:temporal.max_training_outcome_resolved_at??null,
        label_horizon_purged_at_both_outer_boundaries:true
      },
      approval:{
        status:'RESEARCH_ONLY_NOT_APPROVED_FOR_LIVE_USE',
        probability_ready:false,
        live_eligibility_ready:false,
        production_touched:false,
        real_order_execution:false
      }
    };
  }
  const profile=buildCognitiveLearningProfile(rows,{
    minTrainingSamples:Math.max(300,Math.trunc(options.minTrainingSamples||600)),
    minimumBucket:Math.max(20,Math.trunc(options.minimumBucket||50)),
    minimumValidationSamples:Math.max(1000,Math.trunc(options.minimumValidationSamples||3000)),
    minimumHoldoutSamples:Math.max(1000,Math.trunc(options.minimumHoldoutSamples||5000)),
    validationFraction:0.20,
    holdoutFraction:0.20,
    recentWindowFraction:0.60,
    recentSelectionMargin:0.005,
    l2:0.08,
    outcomeHorizonMs:DAILY_EARLY_RISER_HORIZON_MS,
    allowedOutcomeSources:[DAILY_EARLY_RISER_OUTCOME_SOURCE],
    iterations:Math.max(300,Math.trunc(options.logisticIterations||500)),
    learningRate:0.10,
    minNeuralTrainingSamples:240,
    minimumNeuralSelectionSamples:300,
    minimumNeuralSelectionPositiveSamples:10,
    minimumNeuralSelectionNegativeSamples:30,
    maxNeuralTrainingSamples:DAILY_EARLY_RISER_MLP_MAX_TRAINING_SAMPLES,
    neuralTrainingHistoryFraction:options.neuralTrainingHistoryFraction ??
      DAILY_EARLY_RISER_MLP_TRAINING_HISTORY_FRACTION,
    temporalSamples:[],
    temporalOptions:{},
    neuralIterations:Math.max(10,Math.min(40,Math.trunc(options.neuralIterations||20))),
    neuralLearningRate:0.012,
    neuralL2:0.04,
    neuralSelectionMargin:0.003,
    neuralInnerSelectionMargin:options.neuralInnerSelectionMargin ??
      DAILY_EARLY_RISER_MLP_INNER_SELECTION_MARGIN,
    neuralAnchorAdaptation:options.neuralAnchorAdaptation ??
      DAILY_EARLY_RISER_MLP_ANCHOR_ADAPTATION,
    featureSchema:DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA,
    maxResolvedSamples:0
  });
  const neural=profile.neural_network||{};
  const neuralAnchorMode=options.neuralAnchorAdaptation ??
    DAILY_EARLY_RISER_MLP_ANCHOR_ADAPTATION;
  const boosted=profile.boosted_tree_model||{};
  const hybrid=profile.hybrid_model||{};
  const selected=profile.model_selection||{};
  return {
    target_pct:target,
    outcome_semantics:'TARGET_BEFORE_MINUS_2_PERCENT_ADVERSE_BARRIER_WITHIN_24H',
    outcome_source:DAILY_EARLY_RISER_OUTCOME_SOURCE,
    target_definition:'FIRST_PASSAGE_PLUS_'+target+'_PCT_BEFORE_MINUS_2_PCT_24H_15M_V1',
    horizon_ms:DAILY_EARLY_RISER_HORIZON_MS,
    feature_schema:DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA,
    feature_names:profile.feature_names??[],
    feature_schema_note:'Daily MLP/GBDT use an isolated 35-channel V3 schema. Daily MLP research also compares a frozen logistic anchor with a trust-region-tethered anchor (max coefficient delta 0.12, bias delta 0.15); the outer validation and untouched holdout still require 0.003 Brier improvement. TCN remains the separate 24x29 temporal model.',
    temporal_tcn_training_performed:temporal.trained===true,
    temporal_tcn_evaluation_performed:temporalRows.length>0,
    temporal_tcn_sequence_samples:temporalRows.length,
    temporal_tree_training_performed:temporalTree.trained===true,
    temporal_tree_challenger:{
      status:temporalTree.status??'NOT_EVALUATED',
      architecture:temporalTree.architecture??null,
      model_kind:temporalTree.model_kind??null,
      target_definition:temporalTree.target_definition??targetContract,
      trained:temporalTree.trained===true,
      selected_for_research:temporalTree.selected_for_research===true,
      research_out_of_sample_validated:temporalTree.research_out_of_sample_validated===true,
      probability_ready:temporalTree.probability_ready===true,
      live_eligibility_ready:temporalTree.live_eligibility_ready===true,
      training_samples:temporalTree.training_samples??0,
      selection_samples:temporalTree.selection_samples??0,
      calibration_samples:temporalTree.calibration_samples??0,
      validation_samples:temporalTree.validation_samples??0,
      holdout_samples:temporalTree.holdout_samples??0,
      validation:temporalTree.validation??null,
      validation_logistic:temporalTree.validation_logistic??null,
      holdout:temporalTree.holdout??null,
      holdout_logistic:temporalTree.holdout_logistic??null,
      holdout_comparison:temporalTree.holdout_comparison??null,
      supported_regimes:temporalTree.supported_regimes??[],
      selected_regimes:temporalTree.selected_regimes??[],
      feature_importance:temporalTree.feature_importance??[]
    },
    temporal_tcn_reason:temporal.trained===true?null:
      (temporal.status|| (temporalRows.length?'TEMPORAL_TCN_TRAINING_NOT_COMPLETED':'NO_VALID_24X29_TEMPORAL_SEQUENCES')),
    temporal_tcn:{
      status:temporal.status??'NOT_EVALUATED',
      architecture:temporal.architecture??null,
      target_definition:temporal.target_definition??targetContract,
      horizon_ms:DAILY_EARLY_RISER_HORIZON_MS,
      sequence_steps:temporal.sequence_steps??TEMPORAL_SEQUENCE_STEPS,
      sequence_channels:temporal.sequence_channels??TEMPORAL_SEQUENCE_CHANNELS,
      resolved_samples:temporal.resolved_samples??0,
      training_samples:temporal.training_samples??0,
      training_sample_budget:Math.min(DAILY_EARLY_RISER_TCN_MAX_TRAINING_SAMPLES,
        Math.max(160,Math.trunc(options.temporalMaxTrainingSamples||DAILY_EARLY_RISER_TCN_MAX_TRAINING_SAMPLES))),
      validation_samples:temporal.validation_samples??0,
      holdout_samples:temporal.holdout_samples??0,
      outer_training_samples:temporal.outer_training_samples??0,
      outer_validation_samples:temporal.outer_validation_samples??0,
      outer_holdout_samples:temporal.outer_holdout_samples??0,
      validation_start_at:temporal.validation_start_at??null,
      holdout_start_at:temporal.holdout_start_at??null,
      max_training_outcome_resolved_at:temporal.max_training_outcome_resolved_at??null,
      trained:temporal.trained===true,
      selected:temporal.selected===true,
      probability_ready:temporal.probability_ready===true,
      live_eligibility_ready:temporal.live_eligibility_ready===true,
      validation:temporal.validation??null,
      holdout:temporal.holdout??null,
      holdout_comparison:temporal.holdout_comparison??null,
      regime_specialists:temporal.regime_specialists??null,
      supported_regimes:temporal.supported_regimes??[],
      selected_regimes:temporal.selected_regimes??[]
    },
    temporal_regime_local_tcn_pyramid_challenger:{
      status:temporal.regime_local_tcn_pyramid_challenger?.status??'NOT_EVALUATED',
      model_kind:temporal.regime_local_tcn_pyramid_challenger?.model_kind??'INDEPENDENT_REGIME_LOCAL_TCN_ORDERED_PYRAMID_V1',
      architecture:temporal.regime_local_tcn_pyramid_challenger?.architecture??null,
      temporal_pooling:temporal.regime_local_tcn_pyramid_challenger?.temporal_pooling??null,
      pooling_segments:temporal.regime_local_tcn_pyramid_challenger?.pooling_segments??0,
      output_features:temporal.regime_local_tcn_pyramid_challenger?.output_features??0,
      trainable_parameter_count:temporal.regime_local_tcn_pyramid_challenger?.trainable_parameter_count??0,
      training_strategy:temporal.regime_local_tcn_pyramid_challenger?.training_strategy??null,
      training_sample_budget:temporal.regime_local_tcn_pyramid_challenger?.training_sample_budget??0,
      trained:temporal.regime_local_tcn_pyramid_challenger?.trained===true,
      selected_for_research:temporal.regime_local_tcn_pyramid_challenger?.selected_for_research===true,
      research_out_of_sample_validated:temporal.regime_local_tcn_pyramid_challenger?.research_out_of_sample_validated===true,
      probability_ready:false,live_eligibility_ready:false,
      supported_regimes:temporal.regime_local_tcn_pyramid_challenger?.supported_regimes??[],
      validation_selected_regimes:temporal.regime_local_tcn_pyramid_challenger?.validation_selected_regimes??[],
      selected_regimes:temporal.regime_local_tcn_pyramid_challenger?.selected_regimes??[],
      training_samples:temporal.regime_local_tcn_pyramid_challenger?.training_samples??0,
      selection_samples:temporal.regime_local_tcn_pyramid_challenger?.selection_samples??0,
      calibration_samples:temporal.regime_local_tcn_pyramid_challenger?.calibration_samples??0,
      validation_samples:temporal.regime_local_tcn_pyramid_challenger?.validation_samples??0,
      validation:temporal.regime_local_tcn_pyramid_challenger?.validation??null,
      validation_logistic:temporal.regime_local_tcn_pyramid_challenger?.validation_logistic??null,
      holdout_samples:temporal.regime_local_tcn_pyramid_challenger?.holdout_samples??0,
      holdout:temporal.regime_local_tcn_pyramid_challenger?.holdout??null,
      holdout_logistic:temporal.regime_local_tcn_pyramid_challenger?.holdout_logistic??null,
      holdout_comparison:temporal.regime_local_tcn_pyramid_challenger?.holdout_comparison??null,
      regime_specialists:temporal.regime_local_tcn_pyramid_challenger?.regime_specialists??{}
    },
    temporal_regime_local_tcn_multiscale_challenger:{
      status:temporal.regime_local_tcn_multiscale_challenger?.status??'NOT_EVALUATED',
      model_kind:temporal.regime_local_tcn_multiscale_challenger?.model_kind??'INDEPENDENT_REGIME_LOCAL_TCN_MULTISCALE_READOUT_V1',
      architecture:temporal.regime_local_tcn_multiscale_challenger?.architecture??null,
      temporal_pooling:temporal.regime_local_tcn_multiscale_challenger?.temporal_pooling??null,
      pooling_segments:temporal.regime_local_tcn_multiscale_challenger?.pooling_segments??0,
      output_features:temporal.regime_local_tcn_multiscale_challenger?.output_features??0,
      trainable_parameter_count:temporal.regime_local_tcn_multiscale_challenger?.trainable_parameter_count??0,
      training_strategy:temporal.regime_local_tcn_multiscale_challenger?.training_strategy??null,
      training_sample_budget:temporal.regime_local_tcn_multiscale_challenger?.training_sample_budget??0,
      trained:temporal.regime_local_tcn_multiscale_challenger?.trained===true,
      selected_for_research:temporal.regime_local_tcn_multiscale_challenger?.selected_for_research===true,
      research_out_of_sample_validated:temporal.regime_local_tcn_multiscale_challenger?.research_out_of_sample_validated===true,
      probability_ready:false,live_eligibility_ready:false,
      supported_regimes:temporal.regime_local_tcn_multiscale_challenger?.supported_regimes??[],
      validation_selected_regimes:temporal.regime_local_tcn_multiscale_challenger?.validation_selected_regimes??[],
      selected_regimes:temporal.regime_local_tcn_multiscale_challenger?.selected_regimes??[],
      training_samples:temporal.regime_local_tcn_multiscale_challenger?.training_samples??0,
      selection_samples:temporal.regime_local_tcn_multiscale_challenger?.selection_samples??0,
      calibration_samples:temporal.regime_local_tcn_multiscale_challenger?.calibration_samples??0,
      validation_samples:temporal.regime_local_tcn_multiscale_challenger?.validation_samples??0,
      validation:temporal.regime_local_tcn_multiscale_challenger?.validation??null,
      validation_logistic:temporal.regime_local_tcn_multiscale_challenger?.validation_logistic??null,
      holdout_samples:temporal.regime_local_tcn_multiscale_challenger?.holdout_samples??0,
      holdout:temporal.regime_local_tcn_multiscale_challenger?.holdout??null,
      holdout_logistic:temporal.regime_local_tcn_multiscale_challenger?.holdout_logistic??null,
      holdout_comparison:temporal.regime_local_tcn_multiscale_challenger?.holdout_comparison??null,
      regime_specialists:temporal.regime_local_tcn_multiscale_challenger?.regime_specialists??{}
    },
    temporal_regime_local_tcn_challenger:{
      status:temporal.regime_local_tcn_challenger?.status??'NOT_EVALUATED',
      model_kind:temporal.regime_local_tcn_challenger?.model_kind??'INDEPENDENT_REGIME_LOCAL_TCN_V1',
      model_scope:temporal.regime_local_tcn_challenger?.model_scope??null,
      training_strategy:temporal.regime_local_tcn_challenger?.training_strategy??null,
      training_sample_budget:temporal.regime_local_tcn_challenger?.training_sample_budget??0,
      trained:temporal.regime_local_tcn_challenger?.trained===true,
      selected_for_research:temporal.regime_local_tcn_challenger?.selected_for_research===true,
      research_out_of_sample_validated:temporal.regime_local_tcn_challenger?.research_out_of_sample_validated===true,
      probability_ready:false,live_eligibility_ready:false,
      supported_regimes:temporal.regime_local_tcn_challenger?.supported_regimes??[],
      validation_selected_regimes:temporal.regime_local_tcn_challenger?.validation_selected_regimes??[],
      selected_regimes:temporal.regime_local_tcn_challenger?.selected_regimes??[],
      training_samples:temporal.regime_local_tcn_challenger?.training_samples??0,
      selection_samples:temporal.regime_local_tcn_challenger?.selection_samples??0,
      calibration_samples:temporal.regime_local_tcn_challenger?.calibration_samples??0,
      validation_samples:temporal.regime_local_tcn_challenger?.validation_samples??0,
      validation:temporal.regime_local_tcn_challenger?.validation??null,
      validation_logistic:temporal.regime_local_tcn_challenger?.validation_logistic??null,
      holdout_samples:temporal.regime_local_tcn_challenger?.holdout_samples??0,
      holdout:temporal.regime_local_tcn_challenger?.holdout??null,
      holdout_logistic:temporal.regime_local_tcn_challenger?.holdout_logistic??null,
      holdout_comparison:temporal.regime_local_tcn_challenger?.holdout_comparison??null,
      regime_specialists:temporal.regime_local_tcn_challenger?.regime_specialists??{}
    },
    samples:{
      accepted:rows.length,
      rejected:Object.values(rejected).reduce((sum,value)=>sum+value,0),
      rejection_reasons:rejected,
      outcomes:outcomeCounts,
      positive_rate_pct:rows.length?Number((outcomeCounts.UP/rows.length*100).toFixed(4)):0
    },
    chronology:{
      first_at:rows.length?rows[0].at:null,
      last_at:rows.length?rows[rows.length-1].at:null,
      validation_start_at:profile.validation_start_at??null,
      holdout_start_at:profile.holdout_start_at??null,
      training_samples:profile.training_samples??0,
      validation_samples:profile.validation_samples??0,
      holdout_samples:profile.holdout_samples??0,
      purged_overlap_samples:profile.purged_overlap_samples??0,
      maximum_training_outcome_resolved_at:profile.max_training_outcome_resolved_at??null,
      label_horizon_purged_at_both_outer_boundaries:true
    },
    legacy_three_way_diagnostic:{
      target_semantics:'UP=1, DOWN=0, FLAT=0.5; this legacy soft-label diagnostic is not the binary up-event comparator',
      selected_model:profile.model_selection?.selected_model??null,
      validation:profile.validation??null,
      holdout:profile.holdout??null,
      model_selection_reason:selected.reason??null
    },
    binary_up_event_contract:{
      target_semantics:'UP=1; DOWN and FLAT=0 for all primary probability comparisons',
      required_brier_margin:0.003,
      neural_validation_comparison:neural.validation_comparison??null,
      neural_holdout_comparison:neural.holdout_comparison??null,
      boosted_tree_same_window_logistic_validation:boosted.same_window_logistic_validation??null,
      boosted_tree_same_window_logistic_holdout:boosted.same_window_logistic_holdout??null
    },
    neural_network:{
      status:neural.status??'NOT_EVALUATED',
      architecture:neural.architecture??null,
      input_neurons:neural.input_neurons??null,
      hidden_neurons:neural.hidden_neurons??null,
      second_hidden_neurons:neural.second_hidden_neurons??null,
      training_samples:neural.training_samples??0,
      preselection_training_samples:neural.preselection_training_samples??0,
      samples_required:neural.samples_required??null,
      selection_samples:neural.selection_samples??0,
      selection_positive_samples:neural.selection_positive_samples??
        neural.inner_selection_diagnostics?.selection_positive_samples??0,
      selection_negative_samples:neural.selection_negative_samples??
        neural.inner_selection_diagnostics?.selection_negative_samples??0,
      required_selection_samples:neural.required_selection_samples??null,
      required_selection_positive_samples:neural.required_selection_positive_samples??null,
      required_selection_negative_samples:neural.required_selection_negative_samples??null,
      selection_support_ready:neural.selection_support_ready===true,
      selected_member_index:finite(neural.selected_member_index),
      selected_residual_scale:finite(neural.selected_residual_scale),
      probability_calibration:neural.probability_calibration??null,
      member_selection_brier_scores:Array.isArray(neural.member_selection_brier_scores)
        ?neural.member_selection_brier_scores:[],
      ...summarizeDailyNeuralAnchorDiagnostics(neural,neuralAnchorMode),
      trained:neural.trained===true,
      selected:neural.selected===true,
      validation:neural.validation??null,
      validation_comparison:neural.validation_comparison??null,
      holdout:neural.holdout??null,
      holdout_comparison:neural.holdout_comparison??null,
      inner_selection_diagnostics:neural.inner_selection_diagnostics??null
    },
    boosted_tree_model:{
      status:boosted.status??'NOT_EVALUATED',
      architecture:boosted.architecture??null,
      trained:boosted.trained===true,
      selected:boosted.selected===true,
      training_samples:boosted.training_samples??0,
      tree_count:boosted.tree_count??0,
      feature_importance:boosted.feature_importance??[],
      validation:boosted.validation??null,
      holdout:boosted.holdout??null,
      holdout_comparison:selected.challenger_candidate_metrics?.find(row=>row.name==='GBDT_RESIDUAL')??null
    },
    hybrid_model:{
      status:hybrid.status??'NOT_EVALUATED',
      architecture:hybrid.architecture??null,
      trained:hybrid.trained===true,
      selected:hybrid.selected===true,
      selected_candidate:hybrid.selected_candidate??null,
      boosted_weight:hybrid.boosted_weight??null,
      selection_winner_candidate:hybrid.selection_winner_candidate??null,
      validation:hybrid.validation??null,
      holdout:hybrid.holdout??null,
      candidate_selection_metrics:hybrid.candidate_selection_metrics??[]
    },
    model_selection:{
      validation_challenger:selected.validation_challenger??null,
      active_challenger:selected.active_challenger??null,
      holdout_comparison:selected.challenger_holdout_comparison??null,
      reason:selected.reason??null
    },
    approval:{
      historical_prediction_gate_passed:profile.challenger_holdout_comparison?.passed===true||
        selected.challenger_holdout_comparison?.passed===true,
      daily_tcn_historical_holdout_gate_passed:temporal.holdout_comparison?.passed===true,
      forward_shadow_required:true,
      predictive_superiority_verified:false,
      profitability_verified:false,
      production_eligible:false,
      real_order_execution:false
    }
  };
}
