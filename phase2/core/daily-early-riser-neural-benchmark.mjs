import {buildCognitiveLearningProfile,COGNITIVE_DAILY_FEATURE_SCHEMA,COGNITIVE_FEATURE_SCHEMA} from './cognitive-brain.mjs';
import {buildTemporalNeuralProfile,TEMPORAL_SEQUENCE_STEPS,TEMPORAL_SEQUENCE_CHANNELS} from './temporal-neural-brain.mjs';
import {benchmarkTcnLstmHybridChronological} from './temporal-lstm-hybrid.mjs';
import {DAILY_EARLY_RISER_SAFE_OUTCOME_SOURCE} from './daily-early-riser-census.mjs';

export const DAILY_EARLY_RISER_HORIZON_MS = 24 * 60 * 60 * 1000;
export const DAILY_EARLY_RISER_TARGETS_PCT = Object.freeze([5,10,15]);
export const DAILY_EARLY_RISER_TCN_MAX_TRAINING_SAMPLES = 32768;
export const DAILY_EARLY_RISER_MLP_MAX_TRAINING_SAMPLES = 32768;
export const DAILY_EARLY_RISER_MLP_TRAINING_HISTORY_FRACTION = 0.60;
// Inner MLP member-choice margin only; outer validation and holdout remain 0.003.
export const DAILY_EARLY_RISER_MLP_INNER_SELECTION_MARGIN = 0.00025;
// Experimental MLP anchor update; coefficients stay inside a narrow trust region.
export const DAILY_EARLY_RISER_MLP_ANCHOR_ADAPTATION = 'TRUST_REGION_TETHERED_V1';
export const DAILY_EARLY_RISER_TCN_DEFAULT_REGIME_TRAINING_SAMPLES = 4096;
export const DAILY_EARLY_RISER_TCN_V10_EXTENDED_REGIME_TRAINING_SAMPLES = 8192;

/**
 * Isolated training-window ablation: only TCN-only V10 may expand its
 * per-BTC-regime recent training block to 8,192 rows. Other profiles keep
 * their 4,096-row budget unless explicitly configured within their cap.
 */
export function effectiveDailyTcnMultiscaleTrainingBudget(options={}) {
  const tcnOnly=options?.tcnOnly===true;
  const cap=tcnOnly
    ?DAILY_EARLY_RISER_TCN_V10_EXTENDED_REGIME_TRAINING_SAMPLES
    :DAILY_EARLY_RISER_TCN_DEFAULT_REGIME_TRAINING_SAMPLES;
  const requested=Number(options?.temporalRegimeLocalTcnMultiscaleMaxTrainingSamples);
  const budget=Number.isFinite(requested)&&requested>0
    ?Math.trunc(requested):cap;
  return Math.max(80,Math.min(cap,budget));
}
export const DAILY_EARLY_RISER_OUTCOME_SOURCE =
  'BINANCE_OFFICIAL_CLOSED_15M_FIRST_PASSAGE_24H_V1';
export const DAILY_EARLY_RISER_OPPORTUNITY_OUTCOME_SOURCE =
  'BINANCE_OFFICIAL_CLOSED_15M_UPSIDE_TOUCH_HORIZONS_V1';
export const DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA = COGNITIVE_DAILY_FEATURE_SCHEMA;
export const DAILY_EARLY_RISER_CORE_FEATURE_SCHEMA = COGNITIVE_FEATURE_SCHEMA;
export function effectiveDailyMlpFeatureSchema(value='DAILY_CONTEXT_35'){
  const key=String(value??'DAILY_CONTEXT_35').trim().toUpperCase();
  if(['CORE_FLOW_18',COGNITIVE_FEATURE_SCHEMA].includes(key))
    return DAILY_EARLY_RISER_CORE_FEATURE_SCHEMA;
  if(['DAILY_CONTEXT_35',COGNITIVE_DAILY_FEATURE_SCHEMA].includes(key))
    return DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA;
  throw new Error('UNSUPPORTED_DAILY_MLP_FEATURE_SCHEMA');
}

const finite=value=>{
  if(value===null||value===undefined||value===''||typeof value==='boolean')return null;
  const number=Number(value);
  return Number.isFinite(number)?number:null;
};
export const DAILY_EARLY_RISER_MLP_MAX_ITERATIONS=180;
export function effectiveDailyMlpIterations(value=20){
  const requested=finite(value);
  return Math.max(30,Math.min(DAILY_EARLY_RISER_MLP_MAX_ITERATIONS,
    Math.trunc(requested??20)));
}
export const DAILY_EARLY_RISER_MLP_DEFAULT_OUTPUT_INITIALIZATION_SCALE=0.015;
export const DAILY_EARLY_RISER_MLP_MIN_OUTPUT_INITIALIZATION_SCALE=0.005;
export const DAILY_EARLY_RISER_MLP_MAX_OUTPUT_INITIALIZATION_SCALE=0.12;
export function effectiveDailyMlpOutputInitializationScale(value=DAILY_EARLY_RISER_MLP_DEFAULT_OUTPUT_INITIALIZATION_SCALE){
  const requested=finite(value);
  const scale=requested??DAILY_EARLY_RISER_MLP_DEFAULT_OUTPUT_INITIALIZATION_SCALE;
  return Math.max(DAILY_EARLY_RISER_MLP_MIN_OUTPUT_INITIALIZATION_SCALE,
    Math.min(DAILY_EARLY_RISER_MLP_MAX_OUTPUT_INITIALIZATION_SCALE,scale));
}
const targetKey=target=>'plus_'+String(target).replace('.','_')+'_pct';
const targetDefinition=(target,labelMode='first_passage',horizonHours=24)=>
  labelMode==='upside_opportunity'
    ?'ANY_UPSIDE_TOUCH_PLUS_'+target+'_PCT_WITHIN_'+horizonHours+'H_15M_V1'
    :labelMode==='safe_opportunity'
      ?'FIRST_TOUCH_PLUS_'+target+'_PCT_BEFORE_MINUS_2_PCT_WITHIN_'+horizonHours+'H_15M_V1'
      :'FIRST_PASSAGE_PLUS_'+target+'_PCT_BEFORE_MINUS_2_PCT_24H_15M_V1';
const outcomeSourceFor=labelMode=>labelMode==='upside_opportunity'
  ?DAILY_EARLY_RISER_OPPORTUNITY_OUTCOME_SOURCE
  :labelMode==='safe_opportunity'
    ?DAILY_EARLY_RISER_SAFE_OUTCOME_SOURCE:DAILY_EARLY_RISER_OUTCOME_SOURCE;
const targetSemanticsFor=labelMode=>labelMode==='upside_opportunity'
  ?'ANY_UPSIDE_TOUCH_WITHIN_HORIZON_INDEPENDENT_OF_DRAWDOWN'
  :labelMode==='safe_opportunity'
    ?'PLUS_TARGET_BEFORE_MINUS_2_PERCENT_WITHIN_HORIZON'
    :'TARGET_BEFORE_MINUS_2_PERCENT_ADVERSE_BARRIER_WITHIN_24H';

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

/** Attach the already-audited 24x29 sidecar to the exact daily label cohort. */
export function buildDailyEarlyRiserTcnLstmRows(rows){
  return (Array.isArray(rows)?rows:[])
    .filter(row=>validTemporalSequence(row.temporal_sequence)&&
      ['UP','DOWN','FLAT'].includes(row.outcome))
    .map(row=>({
      id:row.id,symbol:row.symbol,at:row.at,resolved_at:row.resolved_at,
      horizon_ms:row.horizon_ms,target:row.outcome==='UP'?1:0,
      outcome:row.outcome,outcome_source:row.outcome_source,
      target_definition:row.target_definition,
      sequence:row.temporal_sequence,
      temporal_sequence_timestamps:row.temporal_sequence_timestamps
    }));
}

function benchmarkDailyTcnLstm(rows,targetDefinition,outcomeSource,horizonHours,options={}){
  if(options.enableTcnLstmHybrid!==true)return {
    status:'SKIPPED_NOT_REQUESTED',evaluated:false,trained:false,
    probability_ready:false,live_eligibility_ready:false,real_order_execution:false
  };
  if(horizonHours!==24)return {
    status:'SKIPPED_UNSUPPORTED_LABEL_HORIZON',evaluated:false,trained:false,
    reason:'TCN_LSTM_RELEASE_SPLIT_POLICY_IS_24H_ONLY',
    probability_ready:false,live_eligibility_ready:false,real_order_execution:false
  };
  const tcnLstmRows=buildDailyEarlyRiserTcnLstmRows(rows);
  return benchmarkTcnLstmHybridChronological(tcnLstmRows,{
    requiredInnerImprovement:0.00025,requiredOuterImprovement:0.003,
    outcomeHorizonMs:DAILY_EARLY_RISER_HORIZON_MS,
    requiredTargetDefinition:targetDefinition,
    requiredOutcomeSource:outcomeSource,
    maxTrainingSamples:Math.max(80,Math.min(1024,
      Math.trunc(options.temporalTcnLstmMaxTrainingSamples||512))),
    bootstrapIterations:Math.max(200,Math.min(2000,
      Math.trunc(options.temporalTcnLstmBootstrapIterations||400))),
    seed:Math.trunc(options.temporalTcnLstmSeed||37),
    candidates:Array.isArray(options.temporalTcnLstmCandidates)
      ?options.temporalTcnLstmCandidates:[
        {name:'LR_0015_L2_0005_DROP00',learningRate:0.0015,l2:0.0005,dropout:0,epochs:Math.max(1,Math.min(8,Math.trunc(options.temporalTcnLstmEpochs||4)))},
        {name:'LR_0025_L2_0015_DROP10',learningRate:0.0025,l2:0.0015,dropout:0.10,epochs:Math.max(1,Math.min(8,Math.trunc(options.temporalTcnLstmEpochs||4)))},
        {name:'LR_0035_L2_0035_DROP20',learningRate:0.0035,l2:0.0035,dropout:0.20,epochs:Math.max(1,Math.min(8,Math.trunc(options.temporalTcnLstmEpochs||4)))}
      ]
  });
}


export function prepareDailyEarlyRiserCognitiveRow(sample,targetPct,options={}){
  const target=finite(targetPct);
  if(target===null||!DAILY_EARLY_RISER_TARGETS_PCT.includes(target))
    return {row:null,reason:'UNSUPPORTED_TARGET'};
  if(!sample||typeof sample!=='object')
    return {row:null,reason:'SAMPLE_INVALID'};
  const labelMode=String(options.labelMode||'first_passage');
  if(!['first_passage','upside_opportunity','safe_opportunity'].includes(labelMode))
    return {row:null,reason:'UNSUPPORTED_LABEL_MODE'};
  const horizonHours=finite(options.horizonHours)??24;
  if(![24,48,72].includes(horizonHours)||
    (labelMode==='first_passage'&&horizonHours!==24))
    return {row:null,reason:'UNSUPPORTED_LABEL_HORIZON'};
  const horizonMs=horizonHours*60*60*1000;
  const key=targetKey(target);
  const label=labelMode==='first_passage'
    ?sample.targets?.[key]
    :labelMode==='safe_opportunity'
      ?sample.safe_opportunity_targets?.[String(horizonHours)+'h']?.[key]
      :sample.opportunity_targets?.[String(horizonHours)+'h']?.[key];
  const allowedOutcomes=labelMode==='upside_opportunity'?['UP','FLAT']:['UP','DOWN','FLAT'];
  if(!label||label.status!=='RESOLVED'||!allowedOutcomes.includes(label.outcome))
    return {row:null,reason:'LABEL_NOT_RESOLVED'};
  const at=finite(sample.at);
  const resolvedAt=finite(label.resolved_at);
  const labelHorizon=finite(label.horizon_ms);
  if(at===null||resolvedAt===null||resolvedAt-at!==horizonMs||labelHorizon!==horizonMs)
    return {row:null,reason:'LABEL_HORIZON_MISMATCH'};
  if(finite(sample.feature_information_cutoff_at)!==at||
    sample.observation_source!=='BINANCE_OFFICIAL_CLOSED_15M_BASELINE')
    return {row:null,reason:'FEATURE_CUTOFF_NOT_AT_BASELINE'};
  const expectedSource=outcomeSourceFor(labelMode);
  const modelTargetDefinition=targetDefinition(target,labelMode,horizonHours);
  const modelTargetSemantics=targetSemanticsFor(labelMode);
  const expectedDefinition=targetDefinition(target,labelMode,horizonHours);
  if(label.outcome_source!==expectedSource||label.target_definition!==expectedDefinition)
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
  const row={
    id:id+':'+(labelMode==='first_passage'?'TRADEABLE_FIRST_PASSAGE':
      labelMode==='safe_opportunity'?'SAFE_FIRST_TOUCH':'UPSIDE_OPPORTUNITY')+
      '_PLUS_'+target+'_PCT_'+horizonHours+'H',
    symbol,at,resolved_at:resolvedAt,horizon_ms:horizonMs,
    outcome:label.outcome,outcome_source:expectedSource,
    target_definition:expectedDefinition,
    target_semantics:targetSemanticsFor(labelMode),
    temporal_sequence:validTemporalSequence(sample.temporal_sequence)?sample.temporal_sequence:null,
    temporal_sequence_timestamps:Array.isArray(sample.temporal_sequence_timestamps)
      ?sample.temporal_sequence_timestamps:null,
    historical_baseline:true,closed_candle_baseline:true,training_eligible:true,
    features:baselineFeatures,
    liquidity_lane:sample.liquidity_lane||null,
    quote_volume_24h:finite(sample.quote_volume_24h)
  };
  if(labelMode==='first_passage')
    row.first_passage={path_resolution:'15M',outcome:label.outcome};
  else if(labelMode==='safe_opportunity')
    row.outcome_contract={
      kind:'SAFE_FIRST_PASSAGE',path_resolution:'15M',outcome:label.outcome,
      horizon_hours:horizonHours,adverse_pct:2
    };
  else
    row.outcome_contract={
      kind:'UPSIDE_TOUCH',path_resolution:'15M',outcome:label.outcome,
      horizon_hours:horizonHours,independent_of_adverse_barrier:true
    };
  return {row,reason:null};
}

function buildDailyCognitiveProfile(rows,options={}){
  return buildCognitiveLearningProfile(rows,{
    minTrainingSamples:Math.max(300,Math.trunc(options.minTrainingSamples||600)),
    minimumBucket:Math.max(20,Math.trunc(options.minimumBucket||50)),
    minimumValidationSamples:Math.max(1000,Math.trunc(options.minimumValidationSamples||3000)),
    minimumHoldoutSamples:Math.max(1000,Math.trunc(options.minimumHoldoutSamples||5000)),
    validationFraction:0.20,holdoutFraction:0.20,recentWindowFraction:0.60,
    recentSelectionMargin:0.005,l2:0.08,outcomeHorizonMs:options.outcomeHorizonMs,
    modelTargetDefinition:options.modelTargetDefinition,
    modelTargetSemantics:options.modelTargetSemantics,
    allowedOutcomeSources:options.allowedOutcomeSources,
    iterations:Math.max(300,Math.trunc(options.logisticIterations||500)),
    learningRate:0.10,minNeuralTrainingSamples:240,
    minimumNeuralSelectionSamples:300,
    minimumNeuralSelectionPositiveSamples:10,
    minimumNeuralSelectionNegativeSamples:30,
    maxNeuralTrainingSamples:DAILY_EARLY_RISER_MLP_MAX_TRAINING_SAMPLES,
    neuralTrainingHistoryFraction:options.neuralTrainingHistoryFraction ??
      DAILY_EARLY_RISER_MLP_TRAINING_HISTORY_FRACTION,
    temporalSamples:[],temporalOptions:{},
    neuralIterations:effectiveDailyMlpIterations(options.neuralIterations),
    neuralOutputInitializationScale:effectiveDailyMlpOutputInitializationScale(options.neuralOutputInitializationScale),
    neuralLearningRate:0.012,neuralL2:0.04,neuralSelectionMargin:0.003,
    neuralInnerSelectionMargin:options.neuralInnerSelectionMargin ??
      DAILY_EARLY_RISER_MLP_INNER_SELECTION_MARGIN,
    neuralAnchorAdaptation:options.neuralAnchorAdaptation ??
      DAILY_EARLY_RISER_MLP_ANCHOR_ADAPTATION,
    enableFactorizationMachine:options.enableFactorizationMachine===true,
    factorizationRank:Math.max(2,Math.min(16,Math.trunc(options.factorizationRank||8))),
    factorizationIterations:Math.max(30,Math.min(180,Math.trunc(options.factorizationIterations||20))),
    factorizationLearningRate:Math.max(0.0005,Math.min(0.03,Number(options.factorizationLearningRate||0.008))),
    factorizationL2:Math.max(0.001,Math.min(0.5,Number(options.factorizationL2||0.06))),
    featureSchema:options.dailyFeatureSchema||DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA,maxResolvedSamples:0
  });
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
  const labelMode=String(options.labelMode||'first_passage');
  if(!['first_passage','upside_opportunity','safe_opportunity'].includes(labelMode))
    throw new Error('UNSUPPORTED_DAILY_EARLY_RISER_LABEL_MODE');
  const horizonHours=finite(options.horizonHours)??24;
  if(![24,48,72].includes(horizonHours)||(labelMode==='first_passage'&&horizonHours!==24))
    throw new Error('UNSUPPORTED_DAILY_EARLY_RISER_LABEL_HORIZON');
  const outcomeHorizonMs=horizonHours*60*60*1000;
  const contractKind=labelMode==='first_passage'?'FIRST_PASSAGE':
    labelMode==='safe_opportunity'?'SAFE_FIRST_PASSAGE':'UPSIDE_TOUCH';
  const selectedOutcomeSource=outcomeSourceFor(labelMode);
  const requiredLiquidityLane=String(options.requiredLiquidityLane||'').trim();
  if(requiredLiquidityLane&&!['STANDARD_750K_PLUS','MICRO_WATCH_ONLY_UNDER_750K'].includes(requiredLiquidityLane))
    throw new Error('UNSUPPORTED_DAILY_EARLY_RISER_LIQUIDITY_LANE');
  const modelFeatureSchema=effectiveDailyMlpFeatureSchema(
    options.dailyFeatureSchema??DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA
  );
  const rows=[];
  const rejected={};
  const seen=new Set();
  for(const sample of Array.isArray(samples)?samples:[]){
    const prepared=prepareDailyEarlyRiserCognitiveRow(sample,target,{labelMode,horizonHours});
    if(!prepared.row){
      const reason=prepared.reason||'UNKNOWN_REJECTION';
      rejected[reason]=(rejected[reason]||0)+1;
      continue;
    }
    if(requiredLiquidityLane&&prepared.row.liquidity_lane!==requiredLiquidityLane){
      rejected.LIQUIDITY_LANE_FILTER=(rejected.LIQUIDITY_LANE_FILTER||0)+1;
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
  const targetContract=targetDefinition(target,labelMode,horizonHours);
  const modelTargetSemantics=targetSemanticsFor(labelMode);
  const temporalTcnLstm=benchmarkDailyTcnLstm(
    temporalRows,targetContract,selectedOutcomeSource,horizonHours,options
  );
  const temporal=options.skipTemporal===true?{
    status:'SKIPPED_BY_EXPLICIT_RESEARCH_COMPUTE_SPLIT',trained:false,selected:false,
    probability_ready:false,live_eligibility_ready:false,
    resolved_samples:0,training_samples:0,validation_samples:0,holdout_samples:0,
    temporal_boosted_tree:{status:'SKIPPED_BY_EXPLICIT_RESEARCH_COMPUTE_SPLIT',trained:false}
  }:buildTemporalNeuralProfile(temporalRows,{
    minTrainingSamples:Math.max(160,Math.trunc(options.temporalMinTrainingSamples||160)),
    maxTrainingSamples:Math.max(160,Math.min(DAILY_EARLY_RISER_TCN_MAX_TRAINING_SAMPLES,
      Math.trunc(options.temporalMaxTrainingSamples||DAILY_EARLY_RISER_TCN_MAX_TRAINING_SAMPLES))),
    minimumValidationSamples:Math.max(24,Math.trunc(options.temporalMinValidationSamples||24)),
    minimumHoldoutSamples:Math.max(40,Math.trunc(options.temporalMinHoldoutSamples||40)),
    liveHoldoutSamples:Math.max(100,Math.trunc(options.temporalLiveHoldoutSamples||150)),
    requireSequenceTimestamps:true,
    enableAsymmetricDirectionalRankingLoss:options.enableAsymmetricDirectionalRankingLoss===true,
    directionalRankingLossConfig:options.directionalRankingLossConfig||{},
    epochs:Math.max(5,Math.min(20,Math.trunc(options.temporalEpochs||10))),
    targetDefinition:targetContract,
    outcomeHorizonMs,
    allowedOutcomeSources:[selectedOutcomeSource],
    outcomeContractKind:contractKind,
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
    regimeLocalTcnMultiscaleMaxTrainingSamples:effectiveDailyTcnMultiscaleTrainingBudget(options),
    enableRegimeLocalTcnAttention:options.enableRegimeLocalTcnAttention!==false,
    regimeLocalTcnAttentionMaxTrainingSamples:Math.max(80,Math.min(4096,
      Math.trunc(options.temporalRegimeLocalTcnAttentionMaxTrainingSamples||4096))),
    regimeLocalTcnAttentionEpochs:Math.max(1,Math.min(8,
      Math.trunc(options.temporalRegimeLocalTcnAttentionEpochs||6))),
    regimeLocalTcnAttentionPositionBiasL2Multiplier:Math.max(1,Math.min(64,
      finite(options.temporalRegimeLocalTcnAttentionPositionBiasL2Multiplier)??1)),
    regimeLocalTcnMultiscaleEpochs:Math.max(1,Math.min(8,
      Math.trunc(options.temporalRegimeLocalTcnMultiscaleEpochs||6))),
    enableTemporalBoostedTree:options.enableTemporalBoostedTree!==false
  });
  const temporalTree=temporal.temporal_boosted_tree||{};
  if(options.tcnOnly===true){
    return {
      target_pct:target,
      outcome_semantics:labelMode==='upside_opportunity'?'ANY_UPSIDE_TOUCH_WITHIN_HORIZON_INDEPENDENT_OF_DRAWDOWN':
        labelMode==='safe_opportunity'?'PLUS_TARGET_BEFORE_MINUS_2_PERCENT_WITHIN_HORIZON':'TARGET_BEFORE_MINUS_2_PERCENT_ADVERSE_BARRIER_WITHIN_24H',
      label_mode:labelMode,
      horizon_hours:horizonHours,
      outcome_source:selectedOutcomeSource,
      target_definition:targetContract,
      required_liquidity_lane:requiredLiquidityLane||null,
      horizon_ms:outcomeHorizonMs,
      feature_schema:'TCN_ONLY_24X29_CLOSED_CANDLE_SEQUENCE',
      feature_names:[],
      research_mode:'TCN_ONLY_ISOLATED_COMPUTE',
      temporal_tcn_training_performed:temporal.trained===true,
      temporal_tcn_evaluation_performed:temporalRows.length>0,
      temporal_tcn_sequence_samples:temporalRows.length,
      temporal_tcn_reason:temporal.trained===true?null:
        (temporal.status||'TEMPORAL_TCN_TRAINING_NOT_COMPLETED'),
      temporal_tcn:temporal,
      temporal_tcn_lstm_hybrid_training_performed:temporalTcnLstm.trained===true,
      temporal_tcn_lstm_hybrid_challenger:temporalTcnLstm,
      temporal_tree_training_performed:false,
      temporal_tree_challenger:temporalTree,
      temporal_regime_local_tcn_challenger:temporal.regime_local_tcn_challenger??null,
      temporal_regime_local_tcn_pyramid_challenger:temporal.regime_local_tcn_pyramid_challenger??null,
      temporal_regime_local_tcn_multiscale_challenger:temporal.regime_local_tcn_multiscale_challenger??null,
      temporal_regime_local_tcn_attention_challenger:temporal.regime_local_tcn_attention_challenger??null,
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
  const profile=buildDailyCognitiveProfile(rows,{
    ...options,dailyFeatureSchema:modelFeatureSchema,
    enableAsymmetricDirectionalRankingLoss:options.enableAsymmetricDirectionalRankingLoss===true,
    directionalRankingLossConfig:options.directionalRankingLossConfig||{},
    outcomeHorizonMs,modelTargetDefinition:targetContract,
    modelTargetSemantics,allowedOutcomeSources:[selectedOutcomeSource]
  });
  const neural=profile.neural_network||{};
  const neuralAnchorMode=options.neuralAnchorAdaptation ??
    DAILY_EARLY_RISER_MLP_ANCHOR_ADAPTATION;
  const boosted=profile.boosted_tree_model||{};
  const hybrid=profile.hybrid_model||{};
  const selected=profile.model_selection||{};
  return {
    target_pct:target,
    outcome_semantics:labelMode==='upside_opportunity'?'ANY_UPSIDE_TOUCH_WITHIN_HORIZON_INDEPENDENT_OF_DRAWDOWN':
      labelMode==='safe_opportunity'?'PLUS_TARGET_BEFORE_MINUS_2_PERCENT_WITHIN_HORIZON':'TARGET_BEFORE_MINUS_2_PERCENT_ADVERSE_BARRIER_WITHIN_24H',
    label_mode:labelMode,
    horizon_hours:horizonHours,
    outcome_source:selectedOutcomeSource,
    target_definition:targetContract,
    required_liquidity_lane:requiredLiquidityLane||null,
    horizon_ms:outcomeHorizonMs,
    feature_schema:modelFeatureSchema,
    feature_names:profile.feature_names??[],
    feature_schema_note:modelFeatureSchema===DAILY_EARLY_RISER_CORE_FEATURE_SCHEMA
      ?'Controlled CORE_FLOW_18 ablation: the 18 original cross-asset flow features only. The TCN remains the separate 24x29 closed-candle temporal model.'
      :'DAILY_CONTEXT_35 control: the original 18 cross-asset flow features plus 17 baseline-only daily/micro context features. The TCN remains the separate 24x29 closed-candle temporal model.',
    temporal_tcn_training_performed:temporal.trained===true,
    temporal_tcn_evaluation_performed:temporalRows.length>0,
    temporal_tcn_sequence_samples:temporalRows.length,
    temporal_tcn_lstm_hybrid_training_performed:temporalTcnLstm.trained===true,
    temporal_tcn_lstm_hybrid_challenger:temporalTcnLstm,
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
      horizon_ms:outcomeHorizonMs,
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
      shared_model_selection_candidate_brier:temporal.shared_model_selection_candidate_brier??null,
      shared_model_selection_logistic_brier:temporal.shared_model_selection_logistic_brier??null,
      shared_model_selection_diagnostic_brier:temporal.shared_model_selection_diagnostic_brier??null,
      shared_model_selection_passed:temporal.shared_model_selection_passed===true,
      pooled_selection_diagnostics:temporal.pooled_selection_diagnostics??null,
      member_training_diagnostics:temporal.member_training_diagnostics??[],
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
      regime_specialists:temporal.regime_local_tcn_pyramid_challenger?.regime_specialists??{},
      member_training_diagnostics:temporal.regime_local_tcn_pyramid_challenger?.member_training_diagnostics??[]
    },
    temporal_regime_local_tcn_attention_challenger:temporal.regime_local_tcn_attention_challenger??null,
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
      regime_specialists:temporal.regime_local_tcn_multiscale_challenger?.regime_specialists??{},
      member_training_diagnostics:temporal.regime_local_tcn_multiscale_challenger?.member_training_diagnostics??[]
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
      regime_specialists:temporal.regime_local_tcn_challenger?.regime_specialists??{},
      member_training_diagnostics:temporal.regime_local_tcn_challenger?.member_training_diagnostics??[]
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
      training_strategy:neural.training_strategy??null,
      factorization_member_enabled:neural.factorization_member_enabled===true,
      factorization_member_index:neural.factorization_member_index??-1,
      ensemble_members:neural.ensemble_members??0,
      ensemble_members_required:neural.ensemble_members_required??null,
      member_training_profiles:neural.member_training_profiles??[],
      input_neurons:neural.input_neurons??null,
      hidden_neurons:neural.hidden_neurons??null,
      second_hidden_neurons:neural.second_hidden_neurons??null,
      output_initialization_scale:neural.output_initialization_scale??null,
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
      same_window_logistic_validation:boosted.same_window_logistic_validation??null,
      same_window_logistic_holdout:boosted.same_window_logistic_holdout??null,
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
      validation_logistic_brier_score:hybrid.validation_logistic_brier_score??null,
      candidate_validation_metrics:hybrid.candidate_validation_metrics??[],
      holdout:hybrid.holdout??null,
      holdout_comparison:hybrid.holdout_comparison??selected.challenger_holdout_comparison??null,
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

export function benchmarkDailyEarlyRiserRegimeLocalMlp(samples,targetPct,options={}){
  const target=finite(targetPct);
  if(target===null||!DAILY_EARLY_RISER_TARGETS_PCT.includes(target))
    throw new Error('UNSUPPORTED_DAILY_EARLY_RISER_TARGET');
  const labelMode=String(options.labelMode||'first_passage');
  if(!['first_passage','upside_opportunity','safe_opportunity'].includes(labelMode))
    throw new Error('UNSUPPORTED_DAILY_EARLY_RISER_LABEL_MODE');
  const horizonHours=finite(options.horizonHours)??24;
  if(![24,48,72].includes(horizonHours)||(labelMode==='first_passage'&&horizonHours!==24))
    throw new Error('UNSUPPORTED_DAILY_EARLY_RISER_LABEL_HORIZON');
  const outcomeHorizonMs=horizonHours*60*60*1000;
  const requiredLiquidityLane=String(options.requiredLiquidityLane||'').trim();
  if(requiredLiquidityLane&&!['STANDARD_750K_PLUS','MICRO_WATCH_ONLY_UNDER_750K'].includes(requiredLiquidityLane))
    throw new Error('UNSUPPORTED_DAILY_EARLY_RISER_LIQUIDITY_LANE');
  const expectedSource=outcomeSourceFor(labelMode);
  const groups={BTC_RISK_ON:[],BTC_RISK_OFF:[]};
  const rejectionCounts={};
  let assigned=0;
  for(const sample of Array.isArray(samples)?samples:[]){
    const prepared=prepareDailyEarlyRiserCognitiveRow(sample,target,{labelMode,horizonHours});
    if(!prepared.row){
      const reason=prepared.reason||'UNKNOWN_REJECTION';
      rejectionCounts[reason]=(rejectionCounts[reason]||0)+1;
      continue;
    }
    if(requiredLiquidityLane&&prepared.row.liquidity_lane!==requiredLiquidityLane){
      rejectionCounts.LIQUIDITY_LANE_FILTER=(rejectionCounts.LIQUIDITY_LANE_FILTER||0)+1;
      continue;
    }
    const sequence=prepared.row.temporal_sequence;
    const sequenceBtc24h=validTemporalSequence(sequence)
      ?finite(sequence[TEMPORAL_SEQUENCE_STEPS-1]?.[19]):null;
    const assetDailyReturn=finite(sample.daily_change_pct);
    const relativeStrength=finite(sample.relative_strength_vs_btc_24h_pct);
    const archivedBtc24h=assetDailyReturn!==null&&relativeStrength!==null
      ?assetDailyReturn-relativeStrength:null;
    // The census stores asset 24h return and (asset - BTC) relative return,
    // both measured over the same 96 closed 15m candles. Their difference
    // reconstructs BTC 24h return without requiring the optional 24x29 tensor.
    if(sequenceBtc24h!==null&&archivedBtc24h!==null&&
      Math.abs(archivedBtc24h)>0.00002&&
      (sequenceBtc24h>=0)!==(archivedBtc24h>=0)){
      rejectionCounts.BTC_REGIME_SOURCE_DISAGREEMENT=
        (rejectionCounts.BTC_REGIME_SOURCE_DISAGREEMENT||0)+1;
      continue;
    }
    const btc24h=sequenceBtc24h??(
      archivedBtc24h!==null&&Math.abs(archivedBtc24h)>0.00002?archivedBtc24h:null
    );
    if(btc24h===null){
      const reason=sequenceBtc24h===null&&archivedBtc24h===null
        ?'BTC_REGIME_ALL_SOURCES_MISSING':'BTC_REGIME_RETURN_NEAR_ZERO_AMBIGUOUS';
      rejectionCounts[reason]=(rejectionCounts[reason]||0)+1;
      continue;
    }
    const regime=btc24h>=0?'BTC_RISK_ON':'BTC_RISK_OFF';
    prepared.row.btc_regime_source=sequenceBtc24h!==null
      ?'TEMPORAL_SEQUENCE_CHANNEL_19'
      :'ARCHIVED_96_CLOSED_15M_ASSET_MINUS_RELATIVE_RETURN';
    groups[regime].push(prepared.row);
    assigned++;
  }
  for(const rows of Object.values(groups))
    rows.sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol)||a.id.localeCompare(b.id));
  const minValidation=Math.max(1000,Math.trunc(options.minimumValidationSamples||1500));
  const minHoldout=Math.max(1000,Math.trunc(options.minimumHoldoutSamples||2000));
  const specialists={};
  for(const regime of ['BTC_RISK_ON','BTC_RISK_OFF']){
    const rows=groups[regime];
    const profile=rows.length>=Math.max(300,Math.trunc(options.minTrainingSamples||600))
      ?buildDailyCognitiveProfile(rows,{
        ...options,outcomeHorizonMs,modelTargetDefinition,modelTargetSemantics,
        allowedOutcomeSources:[expectedSource],
        minTrainingSamples:Math.max(300,Math.trunc(options.minTrainingSamples||600)),
        minimumValidationSamples:minValidation,minimumHoldoutSamples:minHoldout,
        neuralTrainingHistoryFraction:options.neuralTrainingHistoryFraction??1,
        temporalSamples:[],temporalOptions:{}
      }):null;
    const neural=profile?.neural_network||{};
    const inner=neural.inner_selection_diagnostics||{};
    const validation=neural.validation||{evaluated:false,sample_count:0,model_brier_score:null};
    const validationComparison=neural.validation_comparison||{};
    const holdout=neural.holdout||{evaluated:false,sample_count:0,model_brier_score:null};
    const holdoutComparison=neural.holdout_comparison||{};
    const selectionPassed=inner.passed===true&&neural.trained===true;
    const validationPassed=selectionPassed&&neural.selected===true&&
      validation.evaluated===true&&validationComparison.beats_base_rate===true&&
      validationComparison.beats_same_window_logistic===true&&
      validationComparison.beats_global_logistic===true&&
      validationComparison.beats_recent_logistic===true;
    const holdoutPassed=validationPassed&&holdout.evaluated===true&&
      holdoutComparison.passed===true;
    const status=!profile?'WAITING_FOR_REGIME_LOCAL_MLP_SAMPLE_SUPPORT':
      !neural.trained?'MLP_NOT_TRAINED':
      !selectionPassed?'TRAINED_NOT_SELECTED_ON_INNER_SELECTION':
      !validationPassed?'INNER_SELECTION_PASSED_OUTER_VALIDATION_FAILED':
      !holdoutPassed?'VALIDATION_PASSED_HOLDOUT_NOT_PASSED':
      'OUT_OF_SAMPLE_VALIDATED_RESEARCH_ONLY';
    const outcomes=countOutcomes(rows);
    specialists[regime]={
      regime,status,architecture:neural.architecture??null,
      training_strategy:neural.training_strategy??null,
      sample_count:rows.length,outcomes,
      positive_rate_pct:rows.length?Number((outcomes.UP/rows.length*100).toFixed(3)):null,
      first_at:rows[0]?.at??null,last_at:rows.at(-1)?.at??null,
      trained:neural.trained===true,
      training_samples:neural.preselection_training_samples??neural.training_samples??0,
      fitted_training_samples:neural.training_samples??0,
      selection_samples:neural.selection_samples??0,
      validation_samples:validation.sample_count??0,
      holdout_samples:holdout.sample_count??0,
      inner_selection:inner,
      validation,validation_comparison:validationComparison,
      holdout,holdout_comparison:holdoutComparison,
      selected_member_index:neural.selected_member_index??null,
      selected_residual_scale:neural.selected_residual_scale??null,
      selection_passed:selectionPassed,validation_passed:validationPassed,
      holdout_passed:holdoutPassed,
      probability_ready:false,live_eligibility_ready:false,
      chronology:profile?.comparison_contract??null,
      model_selection_reason:profile?.model_selection?.reason??null
    };
  }
  const regimes=Object.values(specialists);
  const allSupported=regimes.length===2&&regimes.every(item=>item.sample_count>=300);
  const trained=allSupported&&regimes.every(item=>item.trained);
  const selected=trained&&regimes.every(item=>item.selection_passed);
  const validationPassed=selected&&regimes.every(item=>item.validation_passed);
  const holdoutPassed=validationPassed&&regimes.every(item=>item.holdout_passed);
  const coverageComplete=Number(rejectionCounts.BTC_REGIME_SOURCE_DISAGREEMENT||0)===0&&
    Number(rejectionCounts.BTC_REGIME_ALL_SOURCES_MISSING||0)===0&&
    Number(rejectionCounts.BTC_REGIME_RETURN_NEAR_ZERO_AMBIGUOUS||0)===0;
  return {
    schema:'RADARX_DAILY_EARLY_RISER_REGIME_LOCAL_MLP_ABLATION_V1',
    status:!coverageComplete?'REGIME_ASSIGNMENT_COVERAGE_INCOMPLETE':
      !allSupported?'WAITING_FOR_BOTH_BTC_REGIME_SUPPORT':
      !trained?'REGIME_LOCAL_MLP_TRAINING_INCOMPLETE':
      !selected?'REGIME_LOCAL_MLP_NOT_SELECTED_ON_INNER_SELECTION':
      !validationPassed?'REGIME_LOCAL_MLP_DID_NOT_BEAT_LOGISTIC_ON_VALIDATION':
      !holdoutPassed?'REGIME_LOCAL_MLP_VALIDATION_PASSED_HOLDOUT_NOT_PASSED':
      'REGIME_LOCAL_MLP_OUT_OF_SAMPLE_VALIDATED_RESEARCH_ONLY',
    target_pct:target,label_mode:labelMode,horizon_hours:horizonHours,
    outcome_source:expectedSource,required_liquidity_lane:requiredLiquidityLane||null,
    feature_schema:DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA,
    btc_regime_definition:'LAST_CLOSED_15M_SEQUENCE_BTC_24H_RETURN_CHANNEL_19_SIGN_V1',
    chronology_policy:'EACH_BTC_REGIME_HAS_ITS_OWN_PURGED_TRAIN_SELECTION_CALIBRATION_VALIDATION_AND_UNTOUCHED_HOLDOUT',
    comparison_margin:0.003,
    inner_selection_margin:DAILY_EARLY_RISER_MLP_INNER_SELECTION_MARGIN,
    neural_training_history_fraction:options.neuralTrainingHistoryFraction??1,
    sample_count:assigned,
    unassigned_or_rejected_samples:Object.values(rejectionCounts).reduce((sum,value)=>sum+value,0),
    rejection_counts:rejectionCounts,
    regime_sample_counts:Object.fromEntries(Object.entries(groups).map(([name,rows])=>[name,rows.length])),
    trained,selected_for_research:selected,
    validation_passed:validationPassed,
    research_out_of_sample_validated:holdoutPassed,
    probability_ready:false,live_eligibility_ready:false,
    production_touched:false,real_order_execution:false,
    regime_specialists:specialists
  };
}
