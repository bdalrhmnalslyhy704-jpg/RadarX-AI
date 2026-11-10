import {buildCognitiveLearningProfile,COGNITIVE_FEATURE_SCHEMA} from './cognitive-brain.mjs';

export const DAILY_EARLY_RISER_HORIZON_MS = 24 * 60 * 60 * 1000;
export const DAILY_EARLY_RISER_TARGETS_PCT = Object.freeze([5,10,15]);
export const DAILY_EARLY_RISER_OUTCOME_SOURCE =
  'BINANCE_OFFICIAL_CLOSED_15M_FIRST_PASSAGE_24H_V1';
export const DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA = COGNITIVE_FEATURE_SCHEMA;

const finite=value=>{
  if(value===null||value===undefined||value===''||typeof value==='boolean')return null;
  const number=Number(value);
  return Number.isFinite(number)?number:null;
};
const targetKey=target=>'plus_'+String(target).replace('.','_')+'_pct';

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
    typeof label.target_definition!=='string'||!label.target_definition.includes('24H_15M'))
    return {row:null,reason:'OUTCOME_SOURCE_OR_DEFINITION_MISMATCH'};
  const symbol=String(sample.symbol||'').trim().toUpperCase();
  const id=String(sample.id||'').trim();
  if(!symbol||!id||!sample.features||typeof sample.features!=='object'||
    Array.isArray(sample.features))
    return {row:null,reason:'IDENTITY_OR_FEATURES_INVALID'};
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
      historical_baseline:true,
      closed_candle_baseline:true,
      training_eligible:true,
      features:sample.features
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
    maxNeuralTrainingSamples:6000,
    temporalSamples:[],
    temporalOptions:{},
    neuralIterations:Math.max(10,Math.min(40,Math.trunc(options.neuralIterations||20))),
    neuralLearningRate:0.012,
    neuralL2:0.04,
    neuralSelectionMargin:0.003,
    maxResolvedSamples:0
  });
  const neural=profile.neural_network||{};
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
    feature_schema_note:'Uses the existing 18-feature Cognitive V5 vector. Daily 24h return, daily BTC-relative return and absolute quote volume are not added as new neural channels in this first benchmark.',
    temporal_tcn_training_performed:false,
    temporal_tcn_reason:'Daily 24h TCN requires an explicit 24h target contract; the existing production TCN remains bound to its separate 4h target.',
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
    logistic_reference:{
      selected_model:profile.model_selection?.selected_model??null,
      validation:profile.validation??null,
      holdout:profile.holdout??null,
      model_selection_reason:selected.reason??null
    },
    neural_network:{
      status:neural.status??'NOT_EVALUATED',
      architecture:neural.architecture??null,
      input_neurons:neural.input_neurons??null,
      hidden_neurons:neural.hidden_neurons??null,
      second_hidden_neurons:neural.second_hidden_neurons??null,
      training_samples:neural.training_samples??0,
      preselection_training_samples:neural.preselection_training_samples??0,
      selection_samples:neural.selection_samples??0,
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
      forward_shadow_required:true,
      predictive_superiority_verified:false,
      profitability_verified:false,
      production_eligible:false,
      real_order_execution:false
    }
  };
}
