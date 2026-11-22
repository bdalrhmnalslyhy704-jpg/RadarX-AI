#!/usr/bin/env node
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

import {
  NEURAL_CLOSURE_DATASET_SCHEMA
} from '../core/neural-closure-data-builder.mjs';
import {
  NEURAL_CLOSURE_HORIZON_MS,NEURAL_CLOSURE_TARGET_DEFINITION,
  NEURAL_CLOSURE_TARGET_SEMANTICS,NEURAL_CLOSURE_MIN_CLASS_SUPPORT,
  NEURAL_CLOSURE_COST_MODEL_ID,
  NEURAL_CLOSURE_MODEL_FAMILIES,validateFourHourRows,splitFourHourRows,
  runNeuralClosureBenchmark,sha256CanonicalArrayMapped,
  evaluateExternalExecutionRiskTopK,simulateFirstTouchPaperPortfolio,
  bootstrapOuterValidationUncertainty
} from '../core/neural-closure-contracts.mjs';
import {
  buildFourHourCognitiveLearningProfile,buildCognitiveFeatureVector,
  predictFourHourCognitiveResearchProbability,
  predictFourHourCognitiveChallengerProbability,
  COGNITIVE_FEATURE_SCHEMA,COGNITIVE_FEATURE_NAMES
} from '../core/cognitive-brain.mjs';
import {
  buildFourHourTemporalNeuralProfile,predictTemporalResearchOutput,
  isUsableTemporalResearchInferenceSpecialist,auditTemporalResearchInferenceCoverage,
  predictTemporalAttentionResearchOutput,isUsableTemporalAttentionResearchInferenceState,
  auditTemporalAttentionResearchInferenceCoverage,
  isUsableTemporalVariantResearchInferenceState,auditTemporalVariantResearchInferenceCoverage,
  predictTemporalVariantResearchOutput,
  TEMPORAL_SEQUENCE_CHANNELS,TEMPORAL_SEQUENCE_STEPS,
  TEMPORAL_ATTENTION_MODEL_ARCHITECTURE,
  TEMPORAL_ORDERED_POOLING_MODE,TEMPORAL_ORDERED_POOLING_MODEL_ARCHITECTURE,
  TEMPORAL_MULTISCALE_POOLING_MODE,TEMPORAL_MULTISCALE_MODEL_ARCHITECTURE
} from '../core/temporal-neural-brain.mjs';
import {
  TCN_LSTM_HYBRID_SCHEMA,TCN_LSTM_STEPS,TCN_LSTM_INPUT_CHANNELS,TCN_LSTM_HIDDEN,
  TCN_LSTM_EXECUTION_HEAD_INPUT_FEATURE_SCHEMA,
  buildTcnLstmFlattenedFeatures,selectTcnLstmHybridHyperparameters,fitTcnLstmHybridCalibration,
  splitFourHourTcnLstmTrainingRows,
  predictTcnLstmHybridProbability,predictTcnLstmHybridCalibratedProbability,
  predictTcnLstmHybridRankingLogit,
  predictTcnLstmHybridRankingAnchorLogit,
  predictTcnLstmHybridExecutionHeads,predictTcnLstmHybridExecutionScore
} from '../core/temporal-lstm-hybrid.mjs';
import {
  HYBRID_FEATURE_NAMES,trainHybridTcnAttention,predictHybridTcnAttention
} from '../core/hybrid-tcn-attention-benchmark.mjs';
import {
  validateAndPrepareDense4hRows,splitDense4hChronologically,
  fitDenseStandardizer,fitDenseLogisticAnchor,
  fitDenseGeneralizationProjection,predictDenseProjectionProbability
} from '../core/dense-generalization-projection.mjs';
import {
  createVersionedModelArtifact,verifyVersionedModelArtifact,
  attachResearchLineageToModelArtifact
} from '../core/model-artifact-guardian.mjs';
import {
  createHurdleV2Artifact,writeHurdleV2ArtifactAtomic,
  HURDLE_V2_OBJECTIVE
} from '../core/hurdle-v2-artifact-contract.mjs';
import {
  fitTunedTemporalLogisticBaseline,predictTemporalLogisticProbability,
  predictCrossFittedCalibratedTemporalLogisticProbability,
  evaluateBinaryProbabilityMetrics
} from '../core/temporal-logistic-baseline.mjs';

const finite=value=>value!==null&&value!==undefined&&value!==''&&
  typeof value!=='boolean'&&Number.isFinite(Number(value));
const sigmoid=value=>1/(1+Math.exp(-Math.max(-30,Math.min(30,value))));
const probabilityLogit=value=>{
  const p=Math.max(1e-9,Math.min(1-1e-9,Number(value)));
  if(!Number.isFinite(p))throw new TypeError('LOGISTIC_CONTEXT_PROBABILITY_NON_FINITE');
  return Math.log(p/(1-p));
};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const MODEL_SCHEMA='RADARX_BUILD224_NEURAL_MODEL_TRAINING_V3';
const LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_SCHEMA =
  'RADARX_TCN_LSTM_LOGISTIC_FULL_ORDERED_SEQUENCE_24X29_696_V1';
const LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_NAMES = Object.freeze(
  Array.from({length:TCN_LSTM_STEPS},(_,step)=>
    HYBRID_FEATURE_NAMES.map(name=>'STEP_'+String(step).padStart(2,'0')+'_'+name)
  ).flat()
);
if(HYBRID_FEATURE_NAMES.length!==TCN_LSTM_INPUT_CHANNELS||
  LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_NAMES.length!==TCN_LSTM_STEPS*TCN_LSTM_INPUT_CHANNELS)
  throw new Error('LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_SCHEMA_WIDTH_MISMATCH');

function argsMap(argv){
  const args={input:'artifacts/neural-closure/dataset.json',
    output:'reports/neural-closure/fixed-sha-benchmark.json',
    epochs:8,denseEpochs:36,minimumHoldoutTrades:100,
    minimumWinRatePct:55,maximumDrawdownPct:8,roundTripCostBps:30,
    hurdleInnerOnly:false};
  for(let index=2;index<argv.length;index++){
    const token=argv[index];
    if(!token.startsWith('--'))throw new Error('UNKNOWN_ARGUMENT:'+token);
    if(token==='--hurdleInnerOnly'){args.hurdleInnerOnly=true;continue;}
    const value=argv[index+1];
    if(value===undefined||value.startsWith('--'))throw new Error('ARGUMENT_VALUE_MISSING:'+token);
    const key=token.slice(2);
    if(['input','output'].includes(key))args[key]=value;
    else if(['epochs','denseEpochs','minimumHoldoutTrades','minimumWinRatePct',
      'maximumDrawdownPct','roundTripCostBps'].includes(key)){
      const parsed=Number(value);
      if(!Number.isFinite(parsed))throw new Error('ARGUMENT_NOT_NUMERIC:'+token);
      args[key]=parsed;
    }else throw new Error('UNKNOWN_ARGUMENT:'+token);
    index++;
  }
  if(!Number.isInteger(args.epochs)||args.epochs<1||args.epochs>24)
    throw new Error('TEMPORAL_EPOCHS_MUST_BE_1_TO_24');
  if(!Number.isInteger(args.denseEpochs)||args.denseEpochs<10||args.denseEpochs>100)
    throw new Error('DENSE_EPOCHS_MUST_BE_10_TO_100');
  if(!Number.isInteger(args.minimumHoldoutTrades)||args.minimumHoldoutTrades<1)
    throw new Error('MINIMUM_HOLDOUT_TRADES_INVALID');
  if(!Number.isFinite(args.minimumWinRatePct)||args.minimumWinRatePct<0||args.minimumWinRatePct>100)
    throw new Error('MINIMUM_WIN_RATE_INVALID');
  if(!Number.isFinite(args.maximumDrawdownPct)||args.maximumDrawdownPct<=0||args.maximumDrawdownPct>100)
    throw new Error('MAXIMUM_DRAWDOWN_INVALID');
  if(!Number.isFinite(args.roundTripCostBps)||args.roundTripCostBps<0||args.roundTripCostBps>300)
    throw new Error('ROUND_TRIP_COST_INVALID');
  return args;
}

function safeModelState(value,path='model_state'){
  if(Array.isArray(value))return value.map((child,index)=>
    child===undefined?null:safeModelState(child,path+'['+index+']'));
  if(value&&typeof value==='object')
    return Object.fromEntries(Object.entries(value).filter(([,child])=>child!==undefined)
      .map(([key,child])=>[key,safeModelState(child,path+'.'+key)]));
  if(typeof value==='number'&&!Number.isFinite(value))
    throw new TypeError('MODEL_STATE_NON_FINITE:'+path);
  if(typeof value==='function'||typeof value==='symbol'||typeof value==='bigint')
    throw new TypeError('MODEL_STATE_NOT_SERIALIZABLE:'+path);
  return value;
}

function decodeArtifactState(artifact,expectedFamily,sourceCommitSha){
  const verified=verifyVersionedModelArtifact(artifact,{
    expectedSourceCommitSha:sourceCommitSha
  });
  if(!verified.valid||artifact.model_family!==expectedFamily)
    throw new Error('MODEL_ARTIFACT_NOT_VERIFIED:'+expectedFamily+':'+verified.reason);
  const bytes=Buffer.from(artifact.weights_base64,'base64');
  if(bytes.length!==Number(artifact.weights_byte_length))
    throw new Error('MODEL_ARTIFACT_BYTE_LENGTH_MISMATCH:'+expectedFamily);
  const state=JSON.parse(bytes.toString('utf8'));
  return {state,artifactSha256:artifact.artifact_sha256};
}

function classSupport(rows){
  const positive=rows.filter(row=>row.target===1).length;
  return {rows:rows.length,positive,negative:rows.length-positive};
}
function assertMinimumClassSupport(name,rows){
  const support=classSupport(rows);
  if(support.positive<NEURAL_CLOSURE_MIN_CLASS_SUPPORT||
    support.negative<NEURAL_CLOSURE_MIN_CLASS_SUPPORT)
    throw new Error('SHARED_PARTITION_CLASS_SUPPORT_BELOW_50:'+name+':'+
      support.positive+':'+support.negative);
  return support;
}
function idsOf(rows){return rows.map(row=>row.id).sort();}
function sameIds(a,b){
  const x=idsOf(a),y=idsOf(b);
  return x.length===y.length&&x.every((id,index)=>id===y[index]);
}

function fitLogisticBaseline(rows){
  const X=rows.map(row=>buildCognitiveFeatureVector(row.features,COGNITIVE_FEATURE_SCHEMA));
  const y=rows.map(row=>row.target);
  if(!X.length||X.some(vector=>vector.length!==COGNITIVE_FEATURE_NAMES.length||
    vector.some(value=>!Number.isFinite(value))))
    throw new Error('LOGISTIC_BASELINE_FEATURE_VECTOR_INVALID');
  const positives=y.reduce((sum,value)=>sum+value,0);
  const prior=(positives+2)/(y.length+4);
  let weights=Array(COGNITIVE_FEATURE_NAMES.length).fill(0);
  let bias=Math.log(prior/(1-prior));
  const epochs=1200,rate=0.08,l2=0.05;
  for(let epoch=0;epoch<epochs;epoch++){
    const gradient=Array(weights.length).fill(0);
    let biasGradient=0;
    for(let index=0;index<X.length;index++){
      let z=bias;
      for(let feature=0;feature<weights.length;feature++)
        z+=weights[feature]*X[index][feature];
      const error=sigmoid(z)-y[index];
      biasGradient+=error;
      for(let feature=0;feature<weights.length;feature++)
        gradient[feature]+=error*X[index][feature];
    }
    const inverse=1/X.length;
    bias-=rate*biasGradient*inverse;
    for(let feature=0;feature<weights.length;feature++)
      weights[feature]-=rate*(gradient[feature]*inverse+l2*weights[feature]);
    if(!Number.isFinite(bias)||weights.some(value=>!Number.isFinite(value)))
      throw new Error('LOGISTIC_BASELINE_NON_FINITE');
  }
  return {weights,bias,training_samples:rows.length,training_positive:positives,
    training_negative:rows.length-positives,training_partition_only:true};
}
function predictLogistic(features,fit){
  const vector=buildCognitiveFeatureVector(features,COGNITIVE_FEATURE_SCHEMA);
  let z=fit.bias;
  for(let index=0;index<vector.length;index++)z+=vector[index]*fit.weights[index];
  return Math.max(0.000001,Math.min(0.999999,sigmoid(z)));
}

function predictionRows(rows,predictor,{sourceCommitSha,targetDefinition=NEURAL_CLOSURE_TARGET_DEFINITION,
  artifactSha256=null,modelName}={}){
  const result=[];
  for(const row of rows){
    const probability=predictor(row);
    if(!finite(probability)||probability<0||probability>1)
      throw new Error('MODEL_PREDICTION_UNAVAILABLE:'+modelName+':'+row.id);
    const item={
      id:row.id,probability:Number(probability),
      raw_probability:Number(probability),
      calibrated_probability:Number(probability),
      source_commit_sha:sourceCommitSha,
      target_definition:targetDefinition,
      target_semantics:NEURAL_CLOSURE_TARGET_SEMANTICS
    };
    if(artifactSha256)item.artifact_sha256=artifactSha256;
    result.push(item);
  }
  return result;
}

function predictionAttempt(rows,predictor,options){
  try{return {valid:true,rows:predictionRows(rows,predictor,options),reason:null};}
  catch(error){return {valid:false,rows:null,reason:String(error?.message||error)};}
}
function markOuterValidationSuppressed(unavailable,modelName,reason,details={}){
  unavailable[modelName]={
    schema:'RADARX_NEURAL_OUTER_VALIDATION_GATE_V1',
    status:'NOT_EVALUATED',reason,inner_selection_passed:false,
    outer_validation_opened:false,holdout_rows_or_scores_used:false,...details
  };
}

function makeArtifact({name,family,version,sourceCommitSha,featureSchemaId,
  featureNames,normalization,modelState}){
  return createVersionedModelArtifact({
    modelName:name,modelFamily:family,modelVersion:version,sourceCommitSha,
    targetDefinition:NEURAL_CLOSURE_TARGET_DEFINITION,
    targetSemantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
    featureSchemaId,featureNames,
    featureIndexMap:Object.fromEntries(featureNames.map((field,index)=>[field,index])),
    normalization,modelState:safeModelState(modelState)
  });
}

async function atomicJson(path,value){
  await mkdir(dirname(path),{recursive:true});
  const temp=path+'.tmp-'+process.pid;
  await writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  await rename(temp,path);
}

async function main(){
  const args=argsMap(process.argv);
  const inputPath=resolve(args.input),outputPath=resolve(args.output);
  const sourceCommitSha=String(process.env.GITHUB_SHA||'').toLowerCase();
  if(!/^[a-f0-9]{40}$/.test(sourceCommitSha))
    throw new Error('MODEL_SOURCE_COMMIT_SHA_REQUIRED');
  let inputBytes=await readFile(inputPath);
  const inputFileSha256=sha256(inputBytes);
  let input=JSON.parse(inputBytes.toString('utf8'));
  if(input?.schema!==NEURAL_CLOSURE_DATASET_SCHEMA||!Array.isArray(input.rows))
    throw new Error('NEURAL_CLOSURE_DATASET_SCHEMA_INVALID');
  const datasetSourceCommitSha=input.source_commit_sha??null;
  const selectedSymbols=Array.isArray(input.universe?.symbols)
    ?input.universe.symbols.map(item=>String(item?.symbol??'').toUpperCase()).filter(Boolean)
    :[];
  const includedSymbols=Array.isArray(input.universe?.symbol_results)
    ?input.universe.symbol_results.filter(item=>item?.status==='INCLUDED')
      .map(item=>String(item.symbol??'').toUpperCase()).filter(Boolean)
    :[];
  // Preserve the frozen top-50 cohort while admitting new point-in-time cohorts up to 100 candidates.
  const maximumCandidateSymbols=Number(input.universe?.maximum_symbols);
  const expectedUniverseSelection=`CURRENT_TOP_${maximumCandidateSymbols}_CANDIDATE_PREFILTER_WITH_POINT_IN_TIME_HISTORICAL_24H_EVENT_GATE_V1`;
  const validCandidateUniverse=Number.isInteger(maximumCandidateSymbols)&&
    maximumCandidateSymbols>=10&&maximumCandidateSymbols<=100&&
    Number(input.universe?.candidate_prefilter?.maximum_symbols)===maximumCandidateSymbols;
  const datasetScope={
    market_data_source:input.data_quality?.source??null,
    market_data_endpoint:input.market_data_endpoint??null,
    universe_selection:input.universe?.selection??null,
    candidate_prefilter:input.universe?.candidate_prefilter??null,
    historical_liquidity_eligibility:input.universe?.historical_eligibility??null,
    minimum_quote_volume_24h_usdt:input.universe?.minimum_quote_volume_24h_usdt??null,
    selected_symbol_count:selectedSymbols.length,
    included_symbol_count:includedSymbols.length,
    selected_symbols:selectedSymbols,
    included_symbols:includedSymbols,
    survivorship_bias_warning:input.universe?.survivorship_bias_warning===true,
    historical_delisted_asset_coverage:false,
    interpretation:`POINT_IN_TIME_24H_LIQUIDITY_WITHIN_CURRENT_TOP_${maximumCandidateSymbols}_CANDIDATE_PREFILTER; HISTORICAL_DELISTED_PAIRS_NOT_COVERED`
  };
  const historicalPolicy=input.universe?.historical_eligibility??{};
  const historicalMinimum=Number(input.universe?.minimum_quote_volume_24h_usdt);
  if(input.universe?.selection!==expectedUniverseSelection||
    !validCandidateUniverse||
    historicalPolicy.method!==
      'SUM_OF_96_CLOSED_15M_KLINE_QUOTE_VOLUME_AT_EACH_DECISION_CLOSE'||
    historicalPolicy.interval!=='15m'||
    Number(historicalPolicy.lookback_candles)!==96||
    historicalPolicy.future_or_unclosed_candles_used!==false||
    historicalPolicy.below_threshold_events_excluded!==true||
    !Number.isFinite(historicalMinimum)||historicalMinimum<750_000||
    input.universe?.survivorship_bias_warning!==true||
    input.universe?.historical_delisted_asset_coverage!==false||
    Number(input.universe?.candidate_prefilter?.minimum_quote_volume_24h_usdt)!==750_000)
    throw new Error('POINT_IN_TIME_HISTORICAL_LIQUIDITY_POLICY_REQUIRED');
  const rows=validateFourHourRows(input.rows);
  const historicalLiquidityRowsValid=rows.every(row=>{
    const evidence=row.historical_liquidity;
    return evidence?.schema==='BINANCE_SPOT_POINT_IN_TIME_24H_LIQUIDITY_V1'&&
      evidence.status==='ELIGIBLE'&&evidence.eligible===true&&
      Number(evidence.window_candle_count)===96&&
      Number(evidence.decision_at)===Number(row.at)&&
      Number(evidence.window_end_close_at)===Number(row.at)&&
      Number(evidence.window_start_open_at)===Number(row.at)-96*15*60_000+1&&
      Number(evidence.minimum_quote_volume_24h_usdt)===historicalMinimum&&
      Number(evidence.quote_volume_24h_usdt)===Number(row.quote_volume_24h)&&
      Number(row.quote_volume_24h)>=historicalMinimum&&
      evidence.no_future_candles_used===true&&
      /^[a-f0-9]{64}$/.test(String(evidence.window_evidence_sha256??''))&&
      evidence.source==='BINANCE_OFFICIAL_CLOSED_15M_KLINE_QUOTE_VOLUME';
  });
  if(!historicalLiquidityRowsValid)
    throw new Error('POINT_IN_TIME_HISTORICAL_LIQUIDITY_ROW_EVIDENCE_INVALID');
  const datasetSha=sha256CanonicalArrayMapped(rows,row=>({
    id:row.id,symbol:row.symbol,at:row.at,resolved_at:row.resolved_at,
    outcome:row.outcome,target:row.target,
    source_audit_sha256:row.source_audit.raw_klines_sha256,
    feature_information_cutoff_at:row.feature_information_cutoff_at,
    features:row.features,temporal_sequence:row.temporal_sequence,
    quote_volume_24h:row.quote_volume_24h,
    historical_liquidity:row.historical_liquidity??null,
    feature_snapshot_sha:row.feature_snapshot_sha??null,
    realized_return_pct:row.realized_return_pct
  }));
  if(datasetSha!==input.dataset_sha256)
    throw new Error('NEURAL_CLOSURE_DATASET_CANONICAL_SHA_MISMATCH');
  // Validation creates the immutable row envelope used by every trainer. Drop
  // the parsed source document and original bytes before feature preparation,
  // so one full Buffer and one row-envelope array do not live beside the models.
  input.rows=null;
  input=null;
  inputBytes=null;
  if(global.gc)global.gc();
  if(rows.length<600)throw new Error('NEURAL_CLOSURE_DATASET_BELOW_600_ROWS');
  if(rows.some(row=>!Array.isArray(row.temporal_feature_names)||
    row.temporal_feature_names[19]!=='btc_trend_return_12bar'))
    throw new Error('TEMPORAL_SEQUENCE_CHANNEL_19_MUST_BE_BTC_TREND_RETURN_12BAR');
  const split=splitFourHourRows(rows);
  const supports={
    train:assertMinimumClassSupport('train',split.train),
    validation:assertMinimumClassSupport('validation',split.validation)
  };
  // The untouched holdout is present only as a row-count/integrity boundary.
  // No holdout labels, features, predictions, returns or metrics are consumed.
  const eventRows=[...split.validation];
  if(!eventRows.length)throw new Error('SHARED_EXTERNAL_SCORING_ROWS_EMPTY');
  const training={
    model_source_commit_sha:sourceCommitSha,
    dataset_source_commit_sha:datasetSourceCommitSha,
    dataset_sha256:datasetSha,input_file_sha256:inputFileSha256,
    source_rows:rows.length,training_rows:split.train.length,
    validation_rows:split.validation.length,holdout_rows:split.holdout.length,
    partition_class_support:supports,
    holdout_access_status:'LOCKED_NOT_SCORED',
    holdout_metrics_read:false,
    dataset_scope:datasetScope
  };

  // Promotion baseline is trained on the same 29 temporal channels consumed by
  // TCN-LSTM. Each channel contributes its 24-step mean and standard deviation;
  // this deterministic 58-feature reduction is also the frozen Logistic anchor
  // representation used inside TCN-LSTM, rather than the separate 18-feature
  // Cognitive vector used by the legacy comparator below.
  const modelArtifactsByModel={};
  const trainingArtifacts={};
  const unavailable={};
  let hurdleV2ExportStatus=null;
  const logisticTrainingVectors=split.train.map(row=>
    buildTcnLstmFlattenedFeatures(row.temporal_sequence));
  const fixedLogisticFit=fitLogisticBaseline(split.train);
  const fixedLogisticValidationProbabilities=args.hurdleInnerOnly?[]:
    split.validation.map(row=>predictLogistic(row.features,fixedLogisticFit));
  const logisticTuning=fitTunedTemporalLogisticBaseline(
    split.train,logisticTrainingVectors,{
      foldCount:5,purgeMs:86_400_000,
      initialTrainingFraction:0.32,validationFraction:0.12,
      minimumTrainingRows:100,minimumValidationRows:50,minimumClassCount:5,
      candidateGrid:[
        {l2:0.001,learningRate:0.01},{l2:0.01,learningRate:0.01},
        {l2:0.1,learningRate:0.01},{l2:1,learningRate:0.01},
        {l2:0.001,learningRate:0.03},{l2:0.01,learningRate:0.03},
        {l2:0.1,learningRate:0.03},{l2:1,learningRate:0.03}
      ],
      maxEpochs:160,seed:22429,
      // This is a predeclared, fixed-threshold diagnostic only. It is not
      // included in the Brier-based hyperparameter selection objective.
      executionEvaluator:(foldRows,probabilities)=>
        simulateFirstTouchPaperPortfolio(foldRows,probabilities,{
          threshold:0.15,roundTripCostBps:args.roundTripCostBps
        })
    });
  const logisticFit=logisticTuning.model;
  const rawTunedLogisticValidationProbabilities=args.hurdleInnerOnly?[]:
    split.validation.map(row=>predictTemporalLogisticProbability(
      buildTcnLstmFlattenedFeatures(row.temporal_sequence),logisticFit));
  const calibratedTunedLogisticValidationProbabilities=args.hurdleInnerOnly?[]:
    split.validation.map(row=>predictCrossFittedCalibratedTemporalLogisticProbability(
      buildTcnLstmFlattenedFeatures(row.temporal_sequence),logisticFit));
  const logisticArtifact=makeArtifact({
    name:'RADARX_LOGISTIC_TCN_LSTM_FULL_ORDERED_SEQUENCE_BASELINE',
    family:'LOGISTIC_REGRESSION',version:'FULL_ORDERED_TEMPORAL_SEQUENCE_696_V1',
    sourceCommitSha,featureSchemaId:LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_SCHEMA,
    featureNames:[...LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_NAMES],
    normalization:{mean:logisticFit.standardizer.means,std:logisticFit.standardizer.scales},
    modelState:{
      schema:'RADARX_TRAINED_TEMPORAL_LOGISTIC_FULL_SEQUENCE_STATE_V1',
      standardizer:logisticFit.standardizer,fit:logisticFit.fit,
      calibration:logisticFit.calibration,calibrator:logisticFit.calibrator,
      selected_configuration:logisticTuning.report.selected_configuration,
      cv_status:logisticTuning.report.status,
      fit_partition:'FIXED_SHA_OUTER_TRAIN_ONLY'
    }
  });
  const verifiedLogisticArtifact=verifyVersionedModelArtifact(logisticArtifact,{
    expectedSourceCommitSha:sourceCommitSha
  });
  if(!verifiedLogisticArtifact.valid)
    throw new Error('TUNED_LOGISTIC_MODEL_ARTIFACT_INVALID:'+verifiedLogisticArtifact.reason);
  modelArtifactsByModel.LOGISTIC_REGRESSION=logisticArtifact;
  trainingArtifacts.LOGISTIC_REGRESSION={
    artifact_sha256:logisticArtifact.artifact_sha256,
    feature_schema_id:LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_SCHEMA,
    feature_count:LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_NAMES.length,
    feature_transform:'24X29_ROW_MAJOR_FLATTENED_CLOSED_SEQUENCE',
    cv_status:logisticTuning.report.status,
    fold_count:logisticTuning.report.fold_count,
    selected_configuration:logisticTuning.report.selected_configuration,
    calibration:logisticTuning.report.calibration,
    fit_partition:'FIXED_SHA_OUTER_TRAIN_ONLY',
    training_rows:split.train.length
  };
  const fixedLogisticValidationMetrics=args.hurdleInnerOnly?null:
    evaluateBinaryProbabilityMetrics(fixedLogisticValidationProbabilities,
      split.validation.map(row=>row.target));
  const rawTunedLogisticValidationMetrics=args.hurdleInnerOnly?null:
    evaluateBinaryProbabilityMetrics(rawTunedLogisticValidationProbabilities,
      split.validation.map(row=>row.target));
  const calibratedTunedLogisticValidationMetrics=args.hurdleInnerOnly?null:
    evaluateBinaryProbabilityMetrics(calibratedTunedLogisticValidationProbabilities,
      split.validation.map(row=>row.target));
  training.logistic_baseline_temporal_cv={
    ...logisticTuning.report,
    feature_schema_id:LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_SCHEMA,
    feature_names:[...LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_NAMES],
    feature_transform:'24X29_ROW_MAJOR_FLATTENED_CLOSED_SEQUENCE',
    feature_source:'SAME_CLOSED_24X29_TEMPORAL_SEQUENCE_AS_TCN_LSTM'
  };
  training.logistic_baseline_comparison=args.hurdleInnerOnly?{
    schema:'RADARX_TUNED_LOGISTIC_INNER_CV_ONLY_V1',
    status:'OUTER_VALIDATION_NOT_SCORED_IN_HURDLE_INNER_ONLY_MODE',
    feature_schema_id:LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_SCHEMA,
    cv_status:logisticTuning.report.status,
    fold_count:logisticTuning.report.fold_count,
    selected_configuration:logisticTuning.report.selected_configuration,
    outer_validation_rows_scored:0,holdout_used:false
  }:{

    primary_promotion_baseline:{
      feature_schema_id:LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_SCHEMA,
      feature_count:LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_NAMES.length,
      feature_transform:'24X29_ROW_MAJOR_FLATTENED_CLOSED_SEQUENCE',
      same_temporal_channel_source_as_tcn_lstm:true
    },
    legacy_fixed_reference_role:'DIAGNOSTIC_ONLY_18_FEATURE_COGNITIVE_REPRESENTATION',
    legacy_fixed_reference_feature_schema_id:COGNITIVE_FEATURE_SCHEMA,
    outer_validation_rows:split.validation.length,
    same_outer_validation_rows:true,
    fixed_reference:{
      solver:'FULL_BATCH_GRADIENT_DESCENT',
      epochs:1200,learning_rate:0.08,l2:0.05,
      feature_normalization:'LEGACY_FEATURE_TRANSFORM_ONLY',
      raw_probability_metrics:fixedLogisticValidationMetrics,
      execution_metrics_at_frozen_reference_threshold:simulateFirstTouchPaperPortfolio(
        split.validation,fixedLogisticValidationProbabilities,{
          threshold:0.15,roundTripCostBps:args.roundTripCostBps
        })
    },
    tuned_temporal_cv:{
      selected_configuration:logisticTuning.report.selected_configuration,
      calibration:logisticTuning.report.calibration,
      raw_probability_metrics:rawTunedLogisticValidationMetrics,
      calibrated_probability_metrics:calibratedTunedLogisticValidationMetrics,
      execution_metrics_at_frozen_reference_threshold:simulateFirstTouchPaperPortfolio(
        split.validation,calibratedTunedLogisticValidationProbabilities,{
          threshold:0.15,roundTripCostBps:args.roundTripCostBps
        })
    },
    calibration_is_evaluated_separately_by_shared_benchmark:true,
    outer_validation_used_for_hyperparameter_selection:false,
    outer_validation_used_for_threshold_selection:false,
    holdout_used:false
  };
  const logisticRawPredictionRows=args.hurdleInnerOnly?[]:predictionRows(eventRows,
    row=>predictTemporalLogisticProbability(
      buildTcnLstmFlattenedFeatures(row.temporal_sequence),logisticFit
    ),{
      sourceCommitSha,artifactSha256:logisticArtifact.artifact_sha256,
      modelName:'LOGISTIC_REGRESSION'
    });
  const eventRowsById=new Map(eventRows.map(row=>[String(row.id),row]));
  const predictionsByModel={
    LOGISTIC_REGRESSION:logisticRawPredictionRows.map(item=>{
      const row=eventRowsById.get(String(item.id));
      const calibratedProbability=predictCrossFittedCalibratedTemporalLogisticProbability(
        buildTcnLstmFlattenedFeatures(row.temporal_sequence),logisticFit
      );
      return {
        ...item,
        calibrated_probability:Number(calibratedProbability),
        calibration_metadata:logisticTuning.report.calibration
      };
    })
  };
  // Train the Cognitive V5 MLP and the shared 24x29 TCN once on the same
  // matured first-touch cohort. The inner selection blocks remain chronological.
  const cognitiveProfile=buildFourHourCognitiveLearningProfile(split.train,{
    sourceCommitSha,
    maxNeuralTrainingSamples:6000,
    neuralTrainingHistoryFraction:1,
    temporalOptions:{
      minTrainingSamples:240,
      maxTrainingSamples:4096,
      minimumValidationSamples:80,
      minimumHoldoutSamples:80,
      liveHoldoutSamples:100,
      epochs:Math.max(4,Math.min(10,args.epochs)),
      enableTemporalBoostedTree:true,
      // Independent pooling variants share the exact purged train/selection/
      // calibration/validation/holdout boundaries but keep separate weights.
      // The 24-epoch base schedules members for 18/24/36 epochs; checkpointing
      // monitors training loss only, while the disjoint selection block decides
      // whether any non-zero neural residual is allowed through.
      enableRegimeLocalTcnPyramid:true,
      regimeLocalTcnPyramidMaxTrainingSamples:2048,
      regimeLocalTcnPyramidEpochs:Math.max(12,Math.min(24,args.epochs)),
      enableRegimeLocalTcnMultiscale:true,
      regimeLocalTcnMultiscaleMaxTrainingSamples:2048,
      regimeLocalTcnMultiscaleEpochs:Math.max(12,Math.min(24,args.epochs)),
      enableRegimeLocalTcnAttention:true,
      regimeLocalTcnAttentionMaxTrainingSamples:2048,
      regimeLocalTcnAttentionEpochs:Math.max(12,Math.min(24,args.epochs))
    }
  });
  const cognitiveArtifacts=cognitiveProfile.research_artifacts||{};
  training.cognitive_profile_rows=split.train.length;
  training.cognitive_profile_source_partition='FIXED_SHA_TRAIN_ONLY';
  training.validation_or_holdout_rows_seen_by_cognitive_training=0;
  const qualificationByModel={
    COGNITIVE_MLP_V5:{
      passed:cognitiveProfile.neural_network?.probability_ready===true,
      reason:cognitiveProfile.neural_network?.status??'MLP_NOT_SELECTED',
      diagnostic_only:cognitiveProfile.neural_network?.probability_ready!==true
    },
    MLP_GBDT_HYBRID:{
      passed:cognitiveProfile.hybrid_model?.probability_ready===true,
      reason:cognitiveProfile.hybrid_model?.status??'HYBRID_NOT_SELECTED',
      diagnostic_only:cognitiveProfile.hybrid_model?.probability_ready!==true
    },
    HYBRID_TCN_ATTENTION:{
      passed:false,reason:'INNER_SELECTION_PROTOCOL_NOT_IMPLEMENTED_OUTER_VALIDATION_NOT_OPENED',
      diagnostic_only:true
    },
    DENSE_MLP:{
      passed:false,reason:'INNER_SELECTION_PROTOCOL_NOT_IMPLEMENTED_OUTER_VALIDATION_NOT_OPENED',
      diagnostic_only:true
    }
  };
  training.model_internal_diagnostics={
    COGNITIVE_MLP_V5:{
      status:cognitiveProfile.neural_network?.status??null,
      probability_ready:cognitiveProfile.neural_network?.probability_ready===true,
      training_samples:cognitiveProfile.neural_network?.training_samples??0,
      selection_logistic_brier:cognitiveProfile.neural_network?.internal_selection_logistic_brier??null,
      selection_required_margin:cognitiveProfile.neural_network?.internal_selection_required_margin??null,
      best_candidate:cognitiveProfile.neural_network?.inner_selection_diagnostics?.best_candidate??null,
      member_selection_scores:cognitiveProfile.neural_network?.member_selection_brier_scores??[],
      validation_comparison:cognitiveProfile.neural_network?.validation_comparison??null,
      holdout_comparison:cognitiveProfile.neural_network?.holdout_comparison??null
    }
  };

  const mlpArtifact=cognitiveArtifacts.COGNITIVE_MLP_V5;
  if(mlpArtifact){
    const decoded=decodeArtifactState(mlpArtifact,'COGNITIVE_MLP_V5',sourceCommitSha);
    modelArtifactsByModel.COGNITIVE_MLP_V5=mlpArtifact;
    trainingArtifacts.COGNITIVE_MLP_V5={
      artifact_sha256:decoded.artifactSha256,
      internal_status:cognitiveProfile.neural_network?.status??null,
      probability_ready:cognitiveProfile.neural_network?.probability_ready===true,
      diagnostic_only:cognitiveProfile.neural_network?.probability_ready!==true,
      outer_validation_scored:false,
      research_inference:decoded.state.research_inference??null,
      training_samples:cognitiveProfile.neural_network?.training_samples??0,
      selected_member_index:cognitiveProfile.neural_network?.selected_member_index??null,
      selected_residual_scale:cognitiveProfile.neural_network?.selected_residual_scale??null,
      best_inner_candidate:cognitiveProfile.neural_network?.inner_selection_diagnostics?.best_candidate??null
    };
    if(cognitiveProfile.neural_network?.probability_ready===true){
      const scored=predictionAttempt(eventRows,
        row=>predictFourHourCognitiveResearchProbability(row.features,decoded.state),{
          sourceCommitSha,artifactSha256:decoded.artifactSha256,modelName:'COGNITIVE_MLP_V5'
        });
      if(scored.valid){
        predictionsByModel.COGNITIVE_MLP_V5=scored.rows;
        trainingArtifacts.COGNITIVE_MLP_V5.outer_validation_scored=true;
      }else unavailable.COGNITIVE_MLP_V5={reason:scored.reason};
    }else markOuterValidationSuppressed(unavailable,'COGNITIVE_MLP_V5',
      'INNER_SELECTION_NOT_QUALIFIED_OUTER_VALIDATION_NOT_OPENED',{
        internal_status:cognitiveProfile.neural_network?.status??null,
        probability_ready:false
      });
  }else unavailable.COGNITIVE_MLP_V5={
    reason:cognitiveProfile.neural_network?.status??'NO_INNER_SELECTED_MLP_ARTIFACT',
    probability_ready:cognitiveProfile.neural_network?.probability_ready===true,
    best_inner_candidate:cognitiveProfile.neural_network?.inner_selection_diagnostics?.best_candidate??null,
    member_selection_scores:cognitiveProfile.neural_network?.member_selection_brier_scores??[]
  };

  const hybridMlpArtifact=cognitiveArtifacts.MLP_GBDT_HYBRID;
  if(hybridMlpArtifact){
    const decoded=decodeArtifactState(hybridMlpArtifact,'MLP_GBDT_HYBRID',sourceCommitSha);
    modelArtifactsByModel.MLP_GBDT_HYBRID=hybridMlpArtifact;
    trainingArtifacts.MLP_GBDT_HYBRID={
      artifact_sha256:decoded.artifactSha256,
      internal_status:cognitiveProfile.hybrid_model?.status??null,
      boosted_weight:cognitiveProfile.hybrid_model?.boosted_weight??null,
      probability_ready:cognitiveProfile.hybrid_model?.probability_ready===true,
      outer_validation_scored:false
    };
    if(cognitiveProfile.hybrid_model?.probability_ready===true){
      const scored=predictionAttempt(eventRows,
        row=>predictFourHourCognitiveChallengerProbability(row.features,decoded.state.fit),{
          sourceCommitSha,artifactSha256:decoded.artifactSha256,modelName:'MLP_GBDT_HYBRID'
        });
      if(scored.valid){
        predictionsByModel.MLP_GBDT_HYBRID=scored.rows;
        trainingArtifacts.MLP_GBDT_HYBRID.outer_validation_scored=true;
      }else unavailable.MLP_GBDT_HYBRID={reason:scored.reason};
    }else markOuterValidationSuppressed(unavailable,'MLP_GBDT_HYBRID',
      'INNER_SELECTION_NOT_QUALIFIED_OUTER_VALIDATION_NOT_OPENED',{
        internal_status:cognitiveProfile.hybrid_model?.status??null,
        probability_ready:false
      });
  }else unavailable.MLP_GBDT_HYBRID={
    reason:cognitiveProfile.hybrid_model?.status??'NO_INNER_SELECTED_GBDT_MLP_BLEND'
  };

  // Keep the research inference path available even when the model's internal
  // outer performance gate has not passed. This allows one independent report
  // to measure it rather than suppressing a weak result.
  const temporalProfile=cognitiveProfile.temporal_network;
  // Audit V8 coverage before any row-wise external inference. A zero-residual
  // Logistic anchor is not a usable neural specialist.
  const requiredV8Regimes=[...new Set(eventRows.map(row=>
    Number(row.temporal_sequence?.at(-1)?.[19])>=0?'BTC_RISK_ON':'BTC_RISK_OFF'))];
  const v8Specialists=temporalProfile?._research_fit?.specialists_by_regime??{};
  const v8Coverage=auditTemporalResearchInferenceCoverage({
    requiredRegimes:requiredV8Regimes,regimeSpecialists:v8Specialists,
    allowDiagnostic:true
  });
  const v8PerformanceQualified=temporalProfile?.probability_ready===true;
  qualificationByModel.TCN_V8={
    passed:v8PerformanceQualified&&v8Coverage.complete,
    reason:!v8Coverage.complete
      ?'TCN_V8_MISSING_REGIME_INFERENCE_STATE:'+v8Coverage.missing_regimes.join(',')
      :temporalProfile?.status??'TCN_V8_NOT_SELECTED',
    diagnostic_only:!v8PerformanceQualified||!v8Coverage.complete
  };
  training.model_internal_diagnostics.TCN_V8={
    architecture:temporalProfile?.architecture??null,
    inner_selection_required_brier_margin:temporalProfile?.inner_selection_required_brier_margin??null,
    outer_validation_required_brier_margin:temporalProfile?.outer_validation_required_brier_margin??null,
    temporal_pooling:temporalProfile?.temporal_pooling??null,
    requested_max_training_samples:4096,
    status:temporalProfile?.status??null,
    probability_ready:temporalProfile?.probability_ready===true,
    supported_regimes:temporalProfile?.supported_regimes??[],
    validation_selected_regimes:temporalProfile?.validation_selected_regimes??[],
    selected_regimes:temporalProfile?.selected_regimes??[],
    outer_holdout_passed:temporalProfile?.holdout_passed===true,
    shared_model_training_samples:temporalProfile?.shared_model_training_samples??0,
    shared_model_selection_samples:temporalProfile?.shared_model_selection_samples??0,
    shared_model_calibration_samples:temporalProfile?.shared_model_calibration_samples??0,
    shared_selection_logistic_brier:temporalProfile?.shared_model_selection_logistic_brier??null,
    shared_selection_candidate_brier:temporalProfile?.shared_model_selection_candidate_brier??null,
    shared_selection_diagnostic_brier:temporalProfile?.shared_model_selection_diagnostic_brier??null,
    shared_selection_passed:temporalProfile?.shared_model_selection_passed===true,
    shared_selected_member_index:temporalProfile?.shared_model_selected_member_index??null,
    shared_split_fractions:temporalProfile?.shared_model_split_fractions??null,
    shared_split_layout:temporalProfile?.shared_model_selection_layout??null,
    member_validation_scores:temporalProfile?.member_validation_scores??{},
    // Candidate and regime score diagnostics belong to the public profile.
    // _research_fit.specialists_by_regime stores inference state, not the
    // report's selection-score audit trail.
    regime_specialists:Object.fromEntries(Object.entries(
      temporalProfile?.regime_specialists??{}
    ).map(([regime,specialist])=>[regime,{
      status:specialist.status??null,
      required_inner_selection_brier_margin:specialist.required_inner_selection_brier_margin??null,
      required_outer_validation_brier_margin:specialist.required_outer_validation_brier_margin??null,
      support_gaps:specialist.support_gaps??[],
      training_samples:specialist.regime_training_samples??specialist.training_samples??0,
      shared_training_samples:specialist.shared_training_samples??0,
      regime_training_samples:specialist.regime_training_samples??0,
      selection_samples:specialist.local_selection_samples??0,
      shared_member_selection_samples:specialist.shared_member_selection_samples??specialist.member_selection_samples??0,
      calibration_samples:specialist.local_calibration_samples??0,
      shared_calibration_samples:specialist.shared_calibration_samples??specialist.calibration_samples??0,
      validation_samples:specialist.validation_samples??0,
      holdout_samples:specialist.holdout_samples??0,
      training_positive_samples:specialist.training_positive_samples??0,
      training_negative_samples:specialist.training_negative_samples??0,
      selection_positive_samples:specialist.selection_positive_samples??0,
      selection_negative_samples:specialist.selection_negative_samples??0,
      validation_positive_samples:specialist.validation_positive_samples??0,
      validation_negative_samples:specialist.validation_negative_samples??0,
      holdout_positive_samples:specialist.holdout_positive_samples??0,
      holdout_negative_samples:specialist.holdout_negative_samples??0,
      selected_member_index:specialist.selected_member_index??null,
      selected_residual_scale:specialist.selected_residual_scale??null,
      diagnostic_member_index:specialist.diagnostic_member_index??null,
      diagnostic_residual_scale:specialist.diagnostic_residual_scale??0,
      neural_residual_contributes:specialist.neural_residual_contributes===true,
      selection_scores:specialist.member_selection_scores??[],
      selection_logistic_brier:specialist.member_selection_logistic_brier??null,
      selection_qualified_candidate_count:specialist.member_selection_qualified_candidates??0,
      validation_passed:specialist.selected===true,
      validation_brier:specialist.validation_brier??null,
      validation_base_rate_brier:specialist.validation_base_rate_brier??null,
      validation_logistic_brier:specialist.validation_pooled_logistic_brier??null,
      holdout_passed:specialist.probability_ready===true,
      holdout_brier:specialist.holdout_brier??null,
      holdout_base_rate_brier:specialist.holdout_base_rate_brier??null,
      holdout_logistic_brier:specialist.holdout_pooled_logistic_brier??null,
      training_cutoff_at:specialist.training_cutoff_at??null,
      member_selection_cutoff_at:specialist.member_selection_cutoff_at??null,
      calibration_cutoff_at:specialist.calibration_cutoff_at??null,
      validation_start_at:specialist.validation_start_at??null,
      max_training_outcome_resolved_at:specialist.max_training_outcome_resolved_at??null,
      model_split_scope:specialist.model_split_scope??null,
      probability_calibration:specialist.probability_calibration??null
    }])),
    exported_inference_regimes:v8Coverage.available_regimes,
    required_external_holdout_regimes:v8Coverage.required_regimes,
    missing_external_holdout_regimes:v8Coverage.missing_regimes,
    inference_coverage_complete:v8Coverage.complete
  };
  const attentionProfile=temporalProfile?.regime_local_tcn_attention_challenger;
  const attentionSpecialists=attentionProfile?.regime_specialists??{};
  const attentionPooledFallback=attentionProfile?.pooled_fallback??{};
  const attentionPooledState=attentionPooledFallback.research_inference??null;
  const requiredHoldoutRegimes=[...new Set(eventRows.map(row=>
    Number(row.temporal_sequence?.at(-1)?.[19])>=0?'BTC_RISK_ON':'BTC_RISK_OFF'))];
  const attentionCoverage=auditTemporalAttentionResearchInferenceCoverage({
    requiredRegimes:requiredHoldoutRegimes,regimeSpecialists:attentionSpecialists,
    pooledFallbackState:attentionPooledState,allowDiagnostic:true
  });
  const attentionInferenceRegimes=attentionCoverage.available_regimes;
  const attentionPooledStateUsable=attentionCoverage.pooled_fallback_usable;
  const missingAttentionRegimes=attentionCoverage.missing_regimes;
  const attentionPooledQualified=attentionPooledFallback.selection_passed===true&&
    attentionPooledFallback.validation_passed===true&&
    attentionPooledFallback.holdout_passed===true&&
    attentionPooledStateUsable&&
    attentionPooledState?.inference_mode==='INNER_SELECTED_TCN_ATTENTION_MEMBER';
  const expectedBtcRegimes=['BTC_RISK_ON','BTC_RISK_OFF'];
  const bothAttentionRegimesQualified=expectedBtcRegimes.every(regime=>{
    const specialist=attentionSpecialists[regime]??{};
    const state=specialist.research_inference;
    return attentionProfile?.supported_regimes?.includes(regime)&&
      attentionProfile?.selected_regimes?.includes(regime)&&
      specialist.validation_passed===true&&specialist.holdout_passed===true&&
      isUsableTemporalAttentionResearchInferenceState(state);
  });
  const attentionInnerQualified=bothAttentionRegimesQualified||attentionPooledQualified;
  qualificationByModel.TCN_V11={
    passed:attentionInnerQualified,
    reason:bothAttentionRegimesQualified
      ?'BOTH_BTC_REGIME_SPECIALISTS_PASSED_VALIDATION_AND_HOLDOUT'
      :attentionPooledQualified
        ?'POOLED_ALL_REGIMES_ATTENTION_FALLBACK_PASSED_VALIDATION_AND_HOLDOUT'
        :'NEITHER_BOTH_REGIME_SPECIALISTS_NOR_POOLED_FALLBACK_PASSED',
    diagnostic_only:!attentionInnerQualified
  };
  training.model_internal_diagnostics.TCN_V11={
    status:attentionProfile?.status??'NOT_TRAINED',
    inner_selection_required_brier_margin:attentionProfile?.inner_selection_required_brier_margin??null,
    outer_validation_required_brier_margin:attentionProfile?.outer_validation_required_brier_margin??null,
    architecture:attentionProfile?.architecture??TEMPORAL_ATTENTION_MODEL_ARCHITECTURE,
    temporal_pooling:attentionProfile?.temporal_pooling??null,
    training_samples:attentionProfile?.training_samples??0,
    supported_regimes:attentionProfile?.supported_regimes??[],
    validation_selected_regimes:attentionProfile?.validation_selected_regimes??[],
    selected_regimes:attentionProfile?.selected_regimes??[],
    research_out_of_sample_validated:attentionProfile?.research_out_of_sample_validated===true,
    validation:attentionProfile?.validation??null,
    validation_logistic:attentionProfile?.validation_logistic??null,
    holdout:attentionProfile?.holdout??null,
    holdout_logistic:attentionProfile?.holdout_logistic??null,
    holdout_comparison:attentionProfile?.holdout_comparison??null,
    exported_inference_regimes:attentionInferenceRegimes,
    required_external_holdout_regimes:requiredHoldoutRegimes,
    missing_external_holdout_regimes:missingAttentionRegimes,
    pooled_fallback:{
      status:attentionPooledFallback.status??'NOT_TRAINED',
      required_inner_selection_brier_margin:attentionPooledFallback.required_inner_selection_brier_margin??null,
      required_outer_validation_brier_margin:attentionPooledFallback.required_outer_validation_brier_margin??null,
      trained:attentionPooledFallback.trained===true,
      training_samples:attentionPooledFallback.training_samples??0,
      selection_samples:attentionPooledFallback.selection_samples??0,
      calibration_samples:attentionPooledFallback.calibration_samples??0,
      validation_samples:attentionPooledFallback.validation_samples??0,
      holdout_samples:attentionPooledFallback.holdout_samples??0,
      training_targets:attentionPooledFallback.training_targets??null,
      selection_targets:attentionPooledFallback.selection_targets??null,
      selection_passed:attentionPooledFallback.selection_passed===true,
      validation_passed:attentionPooledFallback.validation_passed===true,
      holdout_passed:attentionPooledFallback.holdout_passed===true,
      baseline_selection_brier:attentionPooledFallback.member_selection_logistic_brier??null,
      best_selection_candidate:attentionPooledFallback.selection_best_candidate??null,
      candidate_residual_scores:attentionPooledFallback.member_selection_scores??[],
      validation:attentionPooledFallback.validation??null,
      validation_logistic:attentionPooledFallback.validation_logistic??null,
      holdout:attentionPooledFallback.holdout??null,
      holdout_logistic:attentionPooledFallback.holdout_logistic??null,
      research_inference_mode:attentionPooledState?.inference_mode??null
    },
    pooled_fallback_qualified:attentionPooledQualified,
    both_regime_specialists_qualified:bothAttentionRegimesQualified,
    regime_specialists:Object.fromEntries(Object.entries(attentionSpecialists).map(([regime,specialist])=>[
      regime,{
        status:specialist.status??null,
        training_samples:specialist.training_samples??0,
        available_training_samples:specialist.available_training_samples??0,
        selection_samples:specialist.selection_samples??0,
        calibration_samples:specialist.calibration_samples??0,
        validation_samples:specialist.validation_samples??0,
        holdout_samples:specialist.holdout_samples??0,
        training_targets:specialist.training_targets??null,
        selection_targets:specialist.selection_targets??null,
        support_gaps:specialist.support_gaps??[],
        chronology_valid:specialist.chronology_valid===true,
        member_training_profiles:specialist.member_training_profiles??[],
        member_training_diagnostics:specialist.member_training_diagnostics??[],
        baseline_selection_brier:specialist.member_selection_logistic_brier??null,
        best_selection_candidate:specialist.selection_best_candidate??null,
        candidate_residual_scores:specialist.member_selection_scores??[],
        selected_member_index:specialist.selected_member_index??null,
        selected_residual_scale:specialist.selected_residual_scale??null,
        diagnostic_member_index:specialist.diagnostic_member_index??null,
        diagnostic_residual_scale:specialist.diagnostic_residual_scale??null,
        selection_passed:specialist.selection_passed===true,
        calibration:{
          fitted:specialist.probability_calibration?.fitted===true,
          method:specialist.probability_calibration?.method??null,
          fit_on:specialist.probability_calibration?.fit_on??null,
          samples:specialist.probability_calibration?.sample_count??0,
          positives:specialist.probability_calibration?.positive_count??0,
          negatives:specialist.probability_calibration?.negative_count??0,
          reason:specialist.probability_calibration?.reason??null
        },
        validation:specialist.validation??null,
        validation_logistic:specialist.validation_logistic??null,
        holdout:specialist.holdout??null,
        holdout_logistic:specialist.holdout_logistic??null,
        research_inference_mode:specialist.research_inference?.inference_mode??null
      }
    ]))
  };
  const temporalNames=Array.from({length:TEMPORAL_SEQUENCE_CHANNELS},(_,index)=>
    'temporal_channel_'+String(index).padStart(2,'0'));

  // V9 ordered-pyramid and V10 full-receptive-field multiscale are separate
  // model families. Each artifact contains only its regime-local fitted state,
  // never training/selection/validation/holdout rows.
  function exportTemporalPoolingVariant({
    family,name,version,profile,expectedPooling,architecture,modelKind,featureSchemaId
  }){
    const specialists=profile?.regime_specialists??{};
    const regimes=['BTC_RISK_ON','BTC_RISK_OFF'];
    const pooledFallback=profile?.pooled_fallback??{};
    const pooledState=pooledFallback.research_inference??null;
    const requiredExternalRegimes=[...new Set(eventRows.map(row=>
      Number(row.temporal_sequence?.at(-1)?.[19])>=0?'BTC_RISK_ON':'BTC_RISK_OFF'))];
    const variantCoverage=auditTemporalVariantResearchInferenceCoverage({
      requiredRegimes:requiredExternalRegimes,regimeSpecialists:specialists,
      pooledFallbackState:pooledState,allowDiagnostic:true,
      expectedPoolingMode:expectedPooling
    });
    const inferenceRegimes=variantCoverage.available_regimes;
    const pooledStateUsable=variantCoverage.pooled_fallback_usable;
    const missingRegimes=variantCoverage.missing_regimes;
    const pooledFallbackQualified=pooledFallback.selection_passed===true&&
      pooledFallback.validation_passed===true&&pooledFallback.holdout_passed===true&&
      pooledStateUsable&&
      pooledState?.inference_mode==='INNER_SELECTED_TCN_VARIANT_MEMBER';
    const bothRegimesSelected=regimes.every(regime=>{
      const expert=specialists[regime]??{};
      const state=expert.research_inference;
      return profile?.supported_regimes?.includes(regime)&&
        profile?.validation_selected_regimes?.includes(regime)&&
        profile?.selected_regimes?.includes(regime)&&
        expert.validation_passed===true&&expert.holdout_passed===true&&
        isUsableTemporalVariantResearchInferenceState(state,{
          expectedPoolingMode:expectedPooling
        });
    });
    const qualificationPassed=bothRegimesSelected||pooledFallbackQualified;
    qualificationByModel[family]={
      passed:qualificationPassed,
      reason:bothRegimesSelected
        ?'BOTH_BTC_REGIME_SPECIALISTS_PASSED_VALIDATION_AND_HOLDOUT'
        :pooledFallbackQualified
          ?'POOLED_ALL_REGIMES_FALLBACK_PASSED_VALIDATION_AND_HOLDOUT'
          :'NEITHER_BOTH_REGIME_SPECIALISTS_NOR_POOLED_FALLBACK_PASSED',
      diagnostic_only:!qualificationPassed
    };
    training.model_internal_diagnostics[family]={
      status:profile?.status??'VARIANT_PROFILE_NOT_AVAILABLE',
      inner_selection_required_brier_margin:profile?.inner_selection_required_brier_margin??null,
      outer_validation_required_brier_margin:profile?.outer_validation_required_brier_margin??null,
      architecture:profile?.architecture??architecture,
      model_kind:profile?.model_kind??modelKind,
      temporal_pooling:profile?.temporal_pooling??expectedPooling,
      training_sample_budget:profile?.training_sample_budget??2048,
      training_samples:profile?.training_samples??0,
      output_features:profile?.output_features??null,
      trainable_parameter_count:profile?.trainable_parameter_count??null,
      supported_regimes:profile?.supported_regimes??[],
      validation_selected_regimes:profile?.validation_selected_regimes??[],
      selected_regimes:profile?.selected_regimes??[],
      exported_inference_regimes:inferenceRegimes,
      required_external_holdout_regimes:requiredExternalRegimes,
      missing_external_holdout_regimes:missingRegimes,
      pooled_fallback:{
        status:pooledFallback.status??'NOT_TRAINED',
        required_inner_selection_brier_margin:pooledFallback.required_inner_selection_brier_margin??null,
        required_outer_validation_brier_margin:pooledFallback.required_outer_validation_brier_margin??null,
        state_present:Boolean(pooledState),
        inference_state_usable:pooledStateUsable,
        trained:pooledFallback.trained===true,
        selection_passed:pooledFallback.selection_passed===true,
        validation_passed:pooledFallback.validation_passed===true,
        holdout_passed:pooledFallback.holdout_passed===true,
        training_samples:pooledFallback.training_samples??0,
        selection_samples:pooledFallback.selection_samples??0,
        calibration_samples:pooledFallback.calibration_samples??0
      },
      pooled_fallback_qualified:pooledFallbackQualified,
      both_regime_specialists_qualified:bothRegimesSelected,
      // Publish a compact per-regime audit trail to the workflow summary.
      // This is diagnostics only; it does not change candidate selection.
      regime_specialists:Object.fromEntries(Object.entries(specialists).map(([regime,specialist])=>[
        regime,{
          status:specialist.status??null,
          required_inner_selection_brier_margin:specialist.required_inner_selection_brier_margin??null,
          required_outer_validation_brier_margin:specialist.required_outer_validation_brier_margin??null,
          model_kind:specialist.model_kind??modelKind,
          training_samples:specialist.training_samples??0,
          available_training_samples:specialist.available_training_samples??0,
          selection_samples:specialist.selection_samples??0,
          calibration_samples:specialist.calibration_samples??0,
          validation_samples:specialist.validation_samples??0,
          holdout_samples:specialist.holdout_samples??0,
          training_targets:specialist.training_targets??null,
          selection_targets:specialist.selection_targets??null,
          support_gaps:specialist.support_gaps??[],
          chronology_valid:specialist.chronology_valid===true,
          member_training_profiles:specialist.member_training_profiles??[],
          member_training_diagnostics:specialist.member_training_diagnostics??[],
          baseline_selection_brier:specialist.member_selection_logistic_brier??null,
          best_selection_candidate:specialist.selection_best_candidate??null,
          candidate_residual_scores:specialist.member_selection_scores??[],
          selected_member_index:specialist.selected_member_index??null,
          selected_residual_scale:specialist.selected_residual_scale??null,
          diagnostic_member_index:specialist.diagnostic_member_index??null,
          diagnostic_residual_scale:specialist.diagnostic_residual_scale??null,
          selection_passed:specialist.selection_passed===true,
          calibration:{
            fitted:specialist.probability_calibration?.fitted===true,
            method:specialist.probability_calibration?.method??null,
            fit_on:specialist.probability_calibration?.fit_on??null,
            samples:specialist.probability_calibration?.sample_count??0,
            positives:specialist.probability_calibration?.positive_count??0,
            negatives:specialist.probability_calibration?.negative_count??0,
            reason:specialist.probability_calibration?.reason??null
          },
          validation:specialist.validation??null,
          validation_logistic:specialist.validation_logistic??null,
          holdout:specialist.holdout??null,
          holdout_logistic:specialist.holdout_logistic??null,
          research_inference_mode:specialist.research_inference?.inference_mode??null
        }
      ])),
      pooled_fallback_diagnostics:{
        status:pooledFallback.status??null,
        trained:pooledFallback.trained===true,
        training_samples:pooledFallback.training_samples??0,
        selection_samples:pooledFallback.selection_samples??0,
        calibration_samples:pooledFallback.calibration_samples??0,
        validation_samples:pooledFallback.validation_samples??0,
        holdout_samples:pooledFallback.holdout_samples??0,
        training_targets:pooledFallback.training_targets??null,
        selection_targets:pooledFallback.selection_targets??null,
        selection_passed:pooledFallback.selection_passed===true,
        validation_passed:pooledFallback.validation_passed===true,
        holdout_passed:pooledFallback.holdout_passed===true,
        baseline_selection_brier:pooledFallback.member_selection_logistic_brier??null,
        best_selection_candidate:pooledFallback.selection_best_candidate??null,
        candidate_residual_scores:pooledFallback.member_selection_scores??[],
        validation:pooledFallback.validation??null,
        validation_logistic:pooledFallback.validation_logistic??null,
        holdout:pooledFallback.holdout??null,
        holdout_logistic:pooledFallback.holdout_logistic??null,
        research_inference_mode:pooledState?.inference_mode??null
      },
      validation:profile?.validation??null,
      validation_logistic:profile?.validation_logistic??null,
      holdout:profile?.holdout??null,
      holdout_logistic:profile?.holdout_logistic??null,
      both_btc_regimes_inner_qualified:bothRegimesSelected
    };
    if(!qualificationPassed){
      markOuterValidationSuppressed(unavailable,family,
        'INNER_SELECTION_NOT_QUALIFIED_OUTER_VALIDATION_NOT_OPENED',{
          both_regime_specialists_qualified:bothRegimesSelected,
          pooled_fallback_qualified:pooledFallbackQualified,
          inference_regimes:inferenceRegimes,
          missing_regimes:missingRegimes
        });
      return;
    }
    if((inferenceRegimes.length===0&&!pooledStateUsable)||missingRegimes.length>0){
      unavailable[family]={
        reason:'TEMPORAL_VARIANT_MISSING_REGIME_INFERENCE_STATE',
        inference_regimes:inferenceRegimes,
        missing_regimes:missingRegimes
      };
      return;
    }
    const variantState={
      schema:'RADARX_BUILD224_TEMPORAL_TCN_VARIANT_ARTIFACT_V1',
      family,architecture,model_kind:modelKind,
      temporal_pooling:expectedPooling,
      input_shape:[TEMPORAL_SEQUENCE_STEPS,TEMPORAL_SEQUENCE_CHANNELS],
      output_features:profile.output_features,
      trainable_parameter_count:profile.trainable_parameter_count,
      inference_scope:pooledStateUsable
        ?'REGIME_LOCAL_WITH_POOLED_ALL_REGIMES_FALLBACK'
        :'INDEPENDENT_BTC_REGIME_SPECIALISTS',
      regime_specialists:Object.fromEntries(inferenceRegimes.map(regime=>[
        regime,{research_inference:specialists[regime].research_inference}
      ])),
      pooled_fallback:pooledStateUsable?{research_inference:pooledState}:null,
      pooled_fallback_qualified:pooledFallbackQualified,
      supported_regimes:profile.supported_regimes??[],
      validation_selected_regimes:profile.validation_selected_regimes??[],
      selected_regimes:profile.selected_regimes??[]
    };
    const artifact=makeArtifact({
      name,family,version,sourceCommitSha,
      featureSchemaId,featureNames:temporalNames,
      normalization:{mean:temporalNames.map(()=>0),std:temporalNames.map(()=>1)},
      modelState:variantState
    });
    const verified=verifyVersionedModelArtifact(artifact,{
      expectedSourceCommitSha:sourceCommitSha
    });
    if(!verified.valid){
      unavailable[family]={reason:'TEMPORAL_VARIANT_ARTIFACT_VERIFICATION_FAILED:'+verified.reason};
      return;
    }
    const outputModes={};
    const scored=predictionAttempt(eventRows,row=>{
      const output=predictTemporalVariantResearchOutput(
        row.temporal_sequence,variantState,{
          allowDiagnostic:true,expectedPoolingMode:expectedPooling
        }
      );
      if(output?.mode)outputModes[output.mode]=(outputModes[output.mode]||0)+1;
      return output?.probability??null;
    },{
      sourceCommitSha,artifactSha256:artifact.artifact_sha256,modelName:family
    });
    if(!scored.valid){
      unavailable[family]={reason:scored.reason,diagnostic_only:!bothRegimesSelected};
      return;
    }
    modelArtifactsByModel[family]=artifact;
    predictionsByModel[family]=scored.rows;
    trainingArtifacts[family]={
      artifact_sha256:artifact.artifact_sha256,
      architecture,temporal_pooling:expectedPooling,
      inference_regimes:inferenceRegimes,
      pooled_fallback_used_for_missing_regimes:Boolean(pooledStateUsable&&missingRegimes.length===0&&inferenceRegimes.length<requiredExternalRegimes.length),
      pooled_fallback_available:pooledStateUsable,
      pooled_fallback_state_present:Boolean(pooledState),
      pooled_fallback_qualified:pooledFallbackQualified,
      both_regime_specialists_qualified:bothRegimesSelected,
      qualification_basis:bothRegimesSelected?'BOTH_REGIME_SPECIALISTS':pooledFallbackQualified?'POOLED_ALL_REGIMES_FALLBACK':'NONE',
      research_output_modes:outputModes,
      status:profile.status,
      both_btc_regimes_inner_qualified:bothRegimesSelected,
      pooled_fallback_qualified:pooledFallbackQualified,
      qualification_basis:bothRegimesSelected?'BOTH_REGIME_SPECIALISTS':pooledFallbackQualified?'POOLED_ALL_REGIMES_FALLBACK':'NONE',
      out_of_sample_validated:profile.research_out_of_sample_validated===true,
      diagnostic_only:!bothRegimesSelected,
      validation_brier:profile.validation?.model_brier_score??null,
      validation_logistic_brier:profile.validation_logistic?.model_brier_score??null,
      holdout_brier:profile.holdout?.model_brier_score??null,
      holdout_logistic_brier:profile.holdout_logistic?.model_brier_score??null
    };
  }

  exportTemporalPoolingVariant({
    family:'TCN_V9',name:'RADARX_TCN_V9_ORDERED_PYRAMID_FIRST_TOUCH_4H',
    version:'TCN_V9_ORDERED_PYRAMID_4H_V1',
    profile:temporalProfile?.regime_local_tcn_pyramid_challenger,
    expectedPooling:TEMPORAL_ORDERED_POOLING_MODE,
    architecture:TEMPORAL_ORDERED_POOLING_MODEL_ARCHITECTURE,
    modelKind:'INDEPENDENT_REGIME_LOCAL_TCN_ORDERED_PYRAMID_V1',
    featureSchemaId:'RADARX_TEMPORAL_TCN_V9_ORDERED_24X29_V1'
  });
  exportTemporalPoolingVariant({
    family:'TCN_V10',name:'RADARX_TCN_V10_MULTISCALE_FIRST_TOUCH_4H',
    version:'TCN_V10_MULTISCALE_4H_V1',
    profile:temporalProfile?.regime_local_tcn_multiscale_challenger,
    expectedPooling:TEMPORAL_MULTISCALE_POOLING_MODE,
    architecture:TEMPORAL_MULTISCALE_MODEL_ARCHITECTURE,
    modelKind:'INDEPENDENT_REGIME_LOCAL_TCN_MULTISCALE_READOUT_V1',
    featureSchemaId:'RADARX_TEMPORAL_TCN_V10_MULTISCALE_24X29_V1'
  });

  if(temporalProfile?._research_fit&&v8Coverage.complete&&v8PerformanceQualified){
    const tcnArtifact=makeArtifact({
      name:'RADARX_TCN_V8_FIRST_TOUCH_4H',
      family:'TCN_V8',version:'TCN_V8_FIRST_TOUCH_4H_V2',
      sourceCommitSha,featureSchemaId:'RADARX_TEMPORAL_TCN_SEQUENCE_24X29_V2',
      featureNames:temporalNames,
      normalization:{mean:temporalNames.map(()=>0),std:temporalNames.map(()=>1)},
      modelState:{fit:temporalProfile._research_fit,
        selected_regimes:temporalProfile.selected_regimes??[],
        model_architecture:temporalProfile.architecture??null}
    });
    const verified=verifyVersionedModelArtifact(tcnArtifact,{
      expectedSourceCommitSha:sourceCommitSha
    });
    if(verified.valid){
      const researchOutputModes={};
      const scored=predictionAttempt(eventRows,
        row=>{
          const output=predictTemporalResearchOutput(
            row.temporal_sequence,temporalProfile,{allowDiagnostic:true}
          );
          if(output?.mode){
            researchOutputModes[output.mode]=(researchOutputModes[output.mode]||0)+1;
          }
          return output?.probability??null;
        },{
          sourceCommitSha,artifactSha256:tcnArtifact.artifact_sha256,modelName:'TCN_V8'
        });
      if(scored.valid){
        modelArtifactsByModel.TCN_V8=tcnArtifact;
        predictionsByModel.TCN_V8=scored.rows;
        trainingArtifacts.TCN_V8={
          artifact_sha256:tcnArtifact.artifact_sha256,
          probability_ready:temporalProfile.probability_ready===true,
          diagnostic_only:temporalProfile.probability_ready!==true,
          research_output_modes:researchOutputModes,
          internal_status:temporalProfile.status??null,
          selected_regimes:temporalProfile.selected_regimes??[],
          holdout_passed:temporalProfile.holdout_passed===true
        };
      }else unavailable.TCN_V8={
      reason:scored.reason,
      diagnostic_regimes:training.model_internal_diagnostics.TCN_V8.regime_specialists
    };
    }else unavailable.TCN_V8={reason:'ARTIFACT_VERIFICATION_FAILED:'+verified.reason};
  }else if(temporalProfile?._research_fit){
    unavailable.TCN_V8={
      reason:!v8PerformanceQualified
        ?'TCN_V8_INNER_SELECTION_NOT_QUALIFIED_OUTER_VALIDATION_NOT_OPENED'
        :'TCN_V8_MISSING_REGIME_INFERENCE_STATE:'+v8Coverage.missing_regimes.join(','),
      inner_selection_passed:v8PerformanceQualified,
      inference_regimes:v8Coverage.available_regimes,
      missing_regimes:v8Coverage.missing_regimes,
      diagnostic_regimes:training.model_internal_diagnostics.TCN_V8.regime_specialists
    };
  }else unavailable.TCN_V8={
    reason:temporalProfile?.status??'TEMPORAL_RESEARCH_FIT_NOT_AVAILABLE'
  };

  if(attentionInnerQualified&&
    (attentionInferenceRegimes.length>0||attentionPooledStateUsable)&&
    missingAttentionRegimes.length===0){
    const v11State={
      schema:'RADARX_BUILD224_TCN_V11_ATTENTION_ARTIFACT_V1',
      architecture:TEMPORAL_ATTENTION_MODEL_ARCHITECTURE,
      temporal_pooling:attentionProfile.temporal_pooling,
      input_shape:[24,TEMPORAL_SEQUENCE_CHANNELS],
      inference_scope:attentionPooledStateUsable
        ?'REGIME_LOCAL_WITH_POOLED_ALL_REGIMES_FALLBACK'
        :'INDEPENDENT_BTC_REGIME_SELECTED_OR_INNER_DIAGNOSTIC_ATTENTION_MEMBER',
      regime_specialists:Object.fromEntries(attentionInferenceRegimes.map(regime=>[
        regime,{research_inference:attentionSpecialists[regime].research_inference}
      ])),
      pooled_fallback:attentionPooledStateUsable?{research_inference:attentionPooledState}:null,
      supported_regimes:attentionProfile.supported_regimes??[],
      validation_selected_regimes:attentionProfile.validation_selected_regimes??[],
      selected_regimes:attentionProfile.selected_regimes??[],
      pooled_fallback_qualified:attentionPooledQualified
    };
    const attentionArtifact=makeArtifact({
      name:'RADARX_TCN_V11_LEARNED_QUERY_ATTENTION_FIRST_TOUCH_4H',
      family:'TCN_V11',version:'TCN_V11_LEARNED_QUERY_ATTENTION_FIRST_TOUCH_4H_V1',
      sourceCommitSha,featureSchemaId:'RADARX_TEMPORAL_TCN_ATTENTION_SEQUENCE_24X29_V1',
      featureNames:temporalNames,
      normalization:{mean:temporalNames.map(()=>0),std:temporalNames.map(()=>1)},
      modelState:v11State
    });
    const verified=verifyVersionedModelArtifact(attentionArtifact,{
      expectedSourceCommitSha:sourceCommitSha
    });
    if(verified.valid){
      const attentionModes={};
      const scored=predictionAttempt(eventRows,row=>{
        const output=predictTemporalAttentionResearchOutput(
          row.temporal_sequence,v11State,{allowDiagnostic:true}
        );
        if(output?.mode)
          attentionModes[output.mode]=(attentionModes[output.mode]||0)+1;
        return output?.probability??null;
      },{
        sourceCommitSha,artifactSha256:attentionArtifact.artifact_sha256,
        modelName:'TCN_V11'
      });
      if(scored.valid){
        modelArtifactsByModel.TCN_V11=attentionArtifact;
        predictionsByModel.TCN_V11=scored.rows;
        trainingArtifacts.TCN_V11={
          artifact_sha256:attentionArtifact.artifact_sha256,
          architecture:attentionProfile.architecture,
          temporal_pooling:attentionProfile.temporal_pooling,
          inference_regimes:attentionInferenceRegimes,
          research_output_modes:attentionModes,
          status:attentionProfile.status,
          selected_for_research:attentionProfile.selected_for_research===true,
          out_of_sample_validated:attentionProfile.research_out_of_sample_validated===true,
          both_btc_regimes_inner_qualified:bothAttentionRegimesQualified,
          pooled_fallback_qualified:attentionPooledQualified,
          qualification_basis:bothAttentionRegimesQualified?'BOTH_REGIME_SPECIALISTS':
            attentionPooledQualified?'POOLED_ALL_REGIMES_FALLBACK':'NONE',
          diagnostic_only:!attentionInnerQualified,
          validation_brier:attentionProfile.validation?.model_brier_score??null,
          validation_logistic_brier:attentionProfile.validation_logistic?.model_brier_score??null,
          holdout_brier:attentionProfile.holdout?.model_brier_score??null,
          holdout_logistic_brier:attentionProfile.holdout_logistic?.model_brier_score??null
        };
      }else unavailable.TCN_V11={
        reason:'TCN_V11_EXTERNAL_PREDICTION_UNAVAILABLE:'+scored.reason,
        inference_regimes:attentionInferenceRegimes
      };
    }else unavailable.TCN_V11={
      reason:'TCN_V11_ARTIFACT_VERIFICATION_FAILED:'+verified.reason
    };
  }else{
    unavailable.TCN_V11={
      reason:!attentionInnerQualified
        ?'TCN_V11_INNER_SELECTION_NOT_QUALIFIED_OUTER_VALIDATION_NOT_OPENED'
        :missingAttentionRegimes.length
          ?'TCN_V11_MISSING_REGIME_INFERENCE_STATE:'+missingAttentionRegimes.join(',')
          :'TCN_V11_NO_NONZERO_ATTENTION_RESIDUAL_SELECTED',
      trained:attentionProfile?.trained===true,
      status:attentionProfile?.status??'ATTENTION_TCN_NOT_TRAINED',
      inference_regimes:attentionInferenceRegimes,
      required_external_holdout_regimes:requiredHoldoutRegimes
    };
  }

  // TCN -> LSTM -> temporal attention on the SAME 4h first-touch
  // cohort. Its private fitting/selection/calibration slices are drawn only
  // from the outer training partition and purged by the 4h label horizon.
  // Outer validation and untouched holdout are never passed to this trainer.
  try{
    const lstmHorizonMs=NEURAL_CLOSURE_HORIZON_MS;
    const lstmRows=split.train.map(row=>({
      id:row.id,symbol:row.symbol,at:row.at,resolved_at:row.resolved_at,
      target:row.target,sequence:row.temporal_sequence,
      temporal_sequence_timestamps:row.temporal_sequence_timestamps,
      // The separate temporal Logistic execution-context model consumes the
      // identical full ordered 24x29 flattened transform used by the primary Logistic baseline.
      logistic_feature_vector:buildTcnLstmFlattenedFeatures(row.temporal_sequence)
    })).sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol)||a.id.localeCompare(b.id));
    const lstmDays=[...new Set(lstmRows.map(row=>Math.floor(row.at/86_400_000)*86_400_000))]
      .sort((a,b)=>a-b);
    const externalValidationStart=split.validation.length
      ?Math.min(...split.validation.map(row=>row.at)):null;
    if(lstmDays.length<20||externalValidationStart===null){
      unavailable.TCN_LSTM_HYBRID={
        reason:'FOUR_HOUR_LSTM_INTERNAL_CHRONOLOGY_SUPPORT_TOO_SMALL',
        unique_training_days:lstmDays.length
      };
      qualificationByModel.TCN_LSTM_HYBRID={
        passed:false,reason:'FOUR_HOUR_LSTM_INTERNAL_CHRONOLOGY_SUPPORT_TOO_SMALL',
        diagnostic_only:true
      };
      training.model_internal_diagnostics.TCN_LSTM_HYBRID={
        status:'NOT_TRAINED',unique_training_days:lstmDays.length,
        required_unique_training_days:20
      };
    }else{
      const validationRowsForLstm=split.validation.map(row=>({
        id:row.id,symbol:row.symbol,at:row.at,resolved_at:row.resolved_at,
        sequence:row.temporal_sequence,
        temporal_sequence_timestamps:row.temporal_sequence_timestamps
      }));
      const internalSplit=splitFourHourTcnLstmTrainingRows(
        lstmRows,validationRowsForLstm,{horizonMs:lstmHorizonMs}
      );
      const trainingRows=internalSplit.partitions?.training??[];
      const selectionRows=internalSplit.partitions?.selection??[];
      const calibrationRows=internalSplit.partitions?.calibration??[];
      // Attach execution-only evidence to the internal selection rows.
      // These fields are consumed only by the return/rank diagnostics; model
      // fitting still receives feature tensors and binary targets only.
      const executionEvidenceById=new Map(split.train.map(row=>[String(row.id),({
        outcome:row.outcome,
        realized_return_pct:row.realized_return_pct,
        execution_return_contract:row.execution_return_contract,
        first_touch:row.first_touch,
        max_adverse_excursion_pct:row.max_adverse_excursion_pct,
        max_adverse_excursion_at:row.max_adverse_excursion_at,
        max_favorable_excursion_pct:row.max_favorable_excursion_pct,
        max_favorable_excursion_at:row.max_favorable_excursion_at
      })]));
      const trainingRowsWithExecutionEvidence=trainingRows.map(row=>({
        ...row,...(executionEvidenceById.get(String(row.id))??{})
      }));
      const selectionRowsWithExecutionEvidence=selectionRows.map(row=>({
        ...row,...(executionEvidenceById.get(String(row.id))??{})
      }));
      const internalChronologyValid=internalSplit.status==='READY';
      const internalSupport=internalSplit.support??{
        training:{rows:trainingRows.length,positive:trainingRows.filter(row=>row.target===1).length,
          negative:trainingRows.filter(row=>row.target===0).length},
        selection:{rows:selectionRows.length,positive:selectionRows.filter(row=>row.target===1).length,
          negative:selectionRows.filter(row=>row.target===0).length},
        calibration:{rows:calibrationRows.length,positive:calibrationRows.filter(row=>row.target===1).length,
          negative:calibrationRows.filter(row=>row.target===0).length}
      };
      if(!internalChronologyValid){
        unavailable.TCN_LSTM_HYBRID={
          reason:'FOUR_HOUR_LSTM_INTERNAL_PURGE_OR_SUPPORT_FAILED',
          chronology_valid:false,partition_support:internalSupport
        };
        qualificationByModel.TCN_LSTM_HYBRID={
          passed:false,reason:'FOUR_HOUR_LSTM_INTERNAL_PURGE_OR_SUPPORT_FAILED',
          diagnostic_only:true
        };
        training.model_internal_diagnostics.TCN_LSTM_HYBRID={
          status:'ABSTAIN_INTERNAL_PARTITIONS_INVALID',
          chronology_valid:false,partition_support:internalSupport,
          partition_diagnostics:internalSplit.split_boundaries??null,
          partition_failure:internalSplit.reason??null,
          validation_or_holdout_rows_seen_by_fit:0
        };
      }else{
        const selection=selectTcnLstmHybridHyperparameters(
          trainingRowsWithExecutionEvidence,selectionRowsWithExecutionEvidence,{
          requiredImprovement:0.00025,
          maxTrainingSamples:6144,
          seed:22429,
          roundTripCostBps:args.roundTripCostBps,
          minimumReturnTrades:20,
          minimumReturnWinRatePct:55,
          rankingScoreWeight:0.01,
          rankingMinimumReturnGapPct:0.50,
          rankingPairsPerTimestamp:12,
          rankingHeadLearningRate:0.03,
          rankingHeadEpochs:40,
          rankingHeadL2:0.001,
          requireExternalLogisticSelectionBaseline:true,
          // Fit a separate purged expanding-window Logistic model on the
          // recurrent model-training block only. Its predictions are then
          // generated for the later execution-head and inner-selection rows.
          // No execution-head/selection/calibration/outer-validation labels can
          // influence this Logistic context model.
          externalLogisticExecutionContextProvider:(modelTrainingRows,scoringRows)=>{
            if(modelTrainingRows.some(row=>!Array.isArray(row.logistic_feature_vector)||
                row.logistic_feature_vector.length!==LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_NAMES.length)||
              scoringRows.some(row=>!Array.isArray(row.logistic_feature_vector)||
                row.logistic_feature_vector.length!==LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_NAMES.length))
              throw new TypeError('TCN_LSTM_TEMPORAL_LOGISTIC_FEATURE_VECTOR_MISSING');
            const temporalLogisticContext=fitTunedTemporalLogisticBaseline(
              modelTrainingRows,
              modelTrainingRows.map(row=>row.logistic_feature_vector),{
                foldCount:5,purgeMs:86_400_000,
                initialTrainingFraction:0.32,validationFraction:0.12,
                minimumTrainingRows:100,minimumValidationRows:50,minimumClassCount:5,
                candidateGrid:[
                  {l2:0.001,learningRate:0.01},{l2:0.01,learningRate:0.01},
                  {l2:0.1,learningRate:0.01},{l2:1,learningRate:0.01},
                  {l2:0.001,learningRate:0.03},{l2:0.01,learningRate:0.03},
                  {l2:0.1,learningRate:0.03},{l2:1,learningRate:0.03}
                ],
                maxEpochs:160,seed:22429
              });
            const predictions=scoringRows.map(row=>{
              const rawProbability=predictTemporalLogisticProbability(
                row.logistic_feature_vector,temporalLogisticContext.model
              );
              const calibratedProbability=predictCrossFittedCalibratedTemporalLogisticProbability(
                row.logistic_feature_vector,temporalLogisticContext.model
              );
              return {
                id:String(row.id),at:Number(row.at),
                raw_logit:probabilityLogit(rawProbability),
                logit:probabilityLogit(calibratedProbability)
              };
            });
            return {
              model:temporalLogisticContext.model,
              report:temporalLogisticContext.report,
              feature_schema_id:LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_SCHEMA,
              feature_schema_names:[...LOGISTIC_TEMPORAL_SEQUENCE_FEATURE_NAMES],
              predictions
            };
          },
          candidates:[
            // Keep the proper-scoring Brier objective fixed while sweeping a
            // wider shared-classifier ranking-loss range. The previous Focal
            // sweep improved the sidecar rank score but degraded inner Brier;
            // this grid tests joint probability quality and return ordering.
            {name:'4H_BRIER_BASE_LR0015_L2_0005_E12',learningRate:0.0015,l2:0.0005,dropout:0,epochs:12,
              objective:'BRIER'},
            {name:'4H_BRIER_SHARED_RANK_W005_LR0015_E16',learningRate:0.0015,l2:0.0005,dropout:0,epochs:16,
              objective:'BRIER',rankingWeight:0.005},
            {name:'4H_BRIER_SHARED_RANK_W010_LR0015_E16',learningRate:0.0015,l2:0.0005,dropout:0,epochs:16,
              objective:'BRIER',rankingWeight:0.01},
            {name:'4H_BRIER_SHARED_RANK_W020_LR0015_E16',learningRate:0.0015,l2:0.0005,dropout:0,epochs:16,
              objective:'BRIER',rankingWeight:0.02},
            {name:'4H_BRIER_SHARED_RANK_W040_LR0015_E16',learningRate:0.0015,l2:0.0005,dropout:0,epochs:16,
              objective:'BRIER',rankingWeight:0.04},
            {name:'4H_BRIER_SHARED_RANK_W060_LR0015_E16',learningRate:0.0015,l2:0.0005,dropout:0,epochs:16,
              objective:'BRIER',rankingWeight:0.06},
            {name:'4H_BRIER_SHARED_RANK_W080_LR0015_E16',learningRate:0.0015,l2:0.0005,dropout:0,epochs:16,
              objective:'BRIER',rankingWeight:0.08},
            {name:'4H_BRIER_SHARED_RANK_W120_LR0015_E16',learningRate:0.0015,l2:0.0005,dropout:0,epochs:16,
              objective:'BRIER',rankingWeight:0.12}
          ]
        });
        const selectedFit=selection.selected_fit??selection.diagnostic_fit??null;
        const calibrator=selectedFit?fitTcnLstmHybridCalibration(
          calibrationRows,
          sequence=>predictTcnLstmHybridProbability(sequence,selectedFit),
          {minimumSamples:30,minimumPositive:8,minimumNegative:8,
            iterations:500,learningRate:0.03,regularization:0.05}
        ):{fitted:false,reason:'INNER_SELECTION_DID_NOT_QUALIFY'};
        const innerQualified=selection.status==='INNER_SELECTION_QUALIFIED_RESEARCH_ONLY'&&
          selectedFit!==null&&calibrator.fitted===true;
        const hurdleHeadsAvailable=selectedFit?.model?.executionRegressionHeadsFitted===true&&
          selectedFit?.model?.executionHeadInputFeatureSchema===TCN_LSTM_EXECUTION_HEAD_INPUT_FEATURE_SCHEMA&&
          selectedFit?.model?.executionHurdleReturnHeads?.LOGIT_CONTEXT_AUGMENTED?.fitted===true&&
          selectedFit?.model?.executionHurdleReturnHeads?.POOLED_ONLY?.fitted===true;
        if(hurdleHeadsAvailable){
          const hurdleArtifact=createHurdleV2Artifact({
            fit:selectedFit,selection,
            datasetSha256:datasetSha,inputFileSha256,
            datasetSourceCommitSha,datasetRowCount:rows.length,
            targetDefinition:NEURAL_CLOSURE_TARGET_DEFINITION,
            targetSemantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
            splitDefinition:{
              schema:split.schema,purge_ms:split.purge_ms,
              counts:{train:split.train.length,validation:split.validation.length,
                holdout:split.holdout.length},
              boundaries:split.boundaries
            },
            codeCommitSha:sourceCommitSha,
            roundTripCostBps:args.roundTripCostBps,
            randomSeed:22429,innerQualified,
            objectiveId:HURDLE_V2_OBJECTIVE,
            selectionObjectiveId:selection.selection_scoring?.method??
              'INNER_CLASSIFIER_BRIER_PLUS_INDEPENDENT_MULTISCALE_RETURN_RANKING_V6'
          });
          const exportResult=await writeHurdleV2ArtifactAtomic(
            join(dirname(outputPath),'model-artifacts'),hurdleArtifact
          );
          hurdleV2ExportStatus={
            ...exportResult,inner_qualified:innerQualified,
            qualification_status:innerQualified
              ?'INNER_QUALIFIED_FOR_OUTER_REPLAY':'NOT_QUALIFIED',
            selection_status:selection.status,
            execution_ablation:selection.execution_head_context_ablation??selection.execution_head_context_ablation_qualification?.result??null,
            selection_scoring:selection.selection_scoring??null
          };
          trainingArtifacts.HURDLE_V2={
            artifact_content_hash:exportResult.artifact_content_hash,
            artifact_manifest_hash:exportResult.artifact_manifest_hash,
            artifact_path:exportResult.artifact_path,
            manifest_path:exportResult.manifest_path,
            training_status:'TRAINED',
            evaluation_status:innerQualified?'INNER_QUALIFIED':'NOT_QUALIFIED',
            contextual_head_present:true,pooled_head_present:true,
            reload_status:'FRESH_PROCESS_RELOAD_VERIFIED',
            inner_qualification_status:selection.status,
            promotion_status:'NOT_APPROVED'
          };
          training.model_internal_diagnostics.HURDLE_V2={
            ...trainingArtifacts.HURDLE_V2,
            context_ablation:selection.execution_head_context_ablation??selection.execution_head_context_ablation_qualification?.result??null,
            selection_scoring:selection.selection_scoring??null,
            holdout_values_used:false
          };
        }else{
          hurdleV2ExportStatus={
            status:'HURDLE_V2_DUAL_HEAD_TRAINING_UNAVAILABLE',
            reason:'DIAGNOSTIC_FIT_DID_NOT_PRODUCE_BOTH_FITTED_HURDLE_HEADS',
            inner_qualified:false,holdout_values_used:false
          };
        }
        training.model_internal_diagnostics.TCN_LSTM_HYBRID={
          status:innerQualified?'INNER_SELECTION_AND_CALIBRATION_QUALIFIED':
            selection.status==='INNER_SELECTION_QUALIFIED_RESEARCH_ONLY'
              ?'ABSTAIN_CALIBRATION_SUPPORT_FAILED':selection.status,
          architecture:'CAUSAL_DILATED_TCN_UNIDIRECTIONAL_LSTM_SINGLE_HEAD_TEMPORAL_ATTENTION_V1',
          schema:TCN_LSTM_HYBRID_SCHEMA,
          input_shape:[TCN_LSTM_STEPS,TCN_LSTM_INPUT_CHANNELS],
          training_partition:'FIXED_SHA_OUTER_TRAIN_ONLY',
          internal_partitions:{training:trainingRows.length,selection:selectionRows.length,
            calibration:calibrationRows.length},
          internal_support:internalSupport,
          chronology_valid:internalChronologyValid,
          internal_split_schema:internalSplit.schema??null,
          internal_split_boundaries:internalSplit.split_boundaries??null,
          max_training_samples:6144,
          effective_training_rows:selection.effective_training_rows??null,
          training_sample_selection:selection.training_sample_selection??null,
          diagnostic_fit_available:selection.diagnostic_fit!==null&&selection.diagnostic_fit!==undefined,
          diagnostic_configuration:selection.diagnostic_configuration??null,
          required_inner_brier_improvement:0.00025,
          selection_scoring:selection.selection_scoring??null,
          selection_status:selection.status,
          baseline_selection_brier:selection.baseline?.selection_brier??null,
          candidates:selection.candidates??[],
          selected_configuration:selection.selected_configuration??null,
          calibration:{fitted:calibrator.fitted===true,method:calibrator.method??null,
            samples:calibrator.samples??0,positive:calibrator.positive??0,
            negative:calibrator.negative??0,reason:calibrator.reason??null},
          validation_or_holdout_rows_seen_by_fit:0,
          probability_ready:false,live_eligibility_ready:false
        };
        qualificationByModel.TCN_LSTM_HYBRID={
          passed:innerQualified,
          reason:innerQualified
            ?'FOUR_HOUR_LSTM_INNER_SELECTION_AND_CALIBRATION_PASSED'
            :selection.status!=='INNER_SELECTION_QUALIFIED_RESEARCH_ONLY'
              ?'FOUR_HOUR_LSTM_INNER_LOGISTIC_SUPERIORITY_NOT_PROVEN'
              :'FOUR_HOUR_LSTM_CALIBRATION_SUPPORT_NOT_MET',
          diagnostic_only:!innerQualified
        };
        if(!args.hurdleInnerOnly&&innerQualified&&selectedFit!==null&&calibrator.fitted===true){
          const artifact=makeArtifact({
            name:'RADARX_TCN_LSTM_HYBRID_FIRST_TOUCH_4H',
            family:'TCN_LSTM_HYBRID',version:'TCN_LSTM_ATTENTION_FIRST_TOUCH_4H_V2',
            sourceCommitSha,
            featureSchemaId:'RADARX_TEMPORAL_TCN_LSTM_ATTENTION_SEQUENCE_24X29_V1',
            featureNames:temporalNames,
            normalization:{mean:temporalNames.map(()=>0),std:temporalNames.map(()=>1)},
            modelState:{
              schema:'RADARX_TCN_LSTM_FOUR_HOUR_MODEL_STATE_V2',
              architecture:'CAUSAL_DILATED_TCN_UNIDIRECTIONAL_LSTM_SINGLE_HEAD_TEMPORAL_ATTENTION_V1',
              input_shape:[TCN_LSTM_STEPS,TCN_LSTM_INPUT_CHANNELS],
              fit:selectedFit,calibrator,
              execution_logistic_context_metadata:
                selectedFit.execution_logistic_context_metadata??null,
              execution_risk_policy:selectedFit.execution_risk_policy??null,
              execution_risk_score_semantics:'PREDICTED_NET_RETURN_MINUS_FROZEN_LAMBDA_TIMES_PREDICTED_DOWNSIDE_RISK',
              target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
              outcome_horizon_ms:NEURAL_CLOSURE_HORIZON_MS,
              fit_partition:'FIXED_SHA_OUTER_TRAIN_INTERNAL_TRAIN_ONLY'
            }
          });
          const verified=verifyVersionedModelArtifact(artifact,{expectedSourceCommitSha:sourceCommitSha});
          if(!verified.valid)throw new Error('TCN_LSTM_4H_ARTIFACT_INVALID:'+verified.reason);
          const scored=predictionAttempt(eventRows,row=>
            predictTcnLstmHybridCalibratedProbability(
              row.temporal_sequence,selectedFit,calibrator
            ),{
              sourceCommitSha,artifactSha256:artifact.artifact_sha256,
              modelName:'TCN_LSTM_HYBRID'
            });
          if(!scored.valid)throw new Error('TCN_LSTM_4H_EXTERNAL_PREDICTION_FAILED:'+scored.reason);
          // Preserve the TCN-LSTM network output before its internal Platt
          // calibration as a diagnostic-only side channel. Emit it only for
          // the outer validation partition; never calculate or attach it for
          // the final holdout. The primary prediction remains the existing
          // internally calibrated probability used by the evaluator.
          modelArtifactsByModel.TCN_LSTM_HYBRID=artifact;
          predictionsByModel.TCN_LSTM_HYBRID=scored.rows;
          const outerValidationIds=new Set(split.validation.map(row=>String(row.id)));
          const eventRowById=new Map(eventRows.map(row=>[String(row.id),row]));
          predictionsByModel.TCN_LSTM_HYBRID=predictionsByModel.TCN_LSTM_HYBRID.map(item=>{
            if(!outerValidationIds.has(String(item.id)))return item;
            const sourceRow=eventRowById.get(String(item.id));
            if(!sourceRow)
              throw new Error('TCN_LSTM_PRE_INNER_DIAGNOSTIC_ROW_MISSING:'+item.id);
            const preInnerProbability=predictTcnLstmHybridProbability(
              sourceRow.temporal_sequence,selectedFit
            );
            if(!finite(preInnerProbability)||preInnerProbability<0||preInnerProbability>1)
              throw new Error('TCN_LSTM_PRE_INNER_DIAGNOSTIC_NON_FINITE:'+item.id);
            const auxiliaryRankingScore=predictTcnLstmHybridRankingLogit(
              sourceRow.temporal_sequence,selectedFit
            );
            if(!finite(auxiliaryRankingScore))
              throw new Error('TCN_LSTM_AUXILIARY_RANKING_DIAGNOSTIC_NON_FINITE:'+item.id);
            const auxiliaryRankingAnchorLogit=predictTcnLstmHybridRankingAnchorLogit(
              sourceRow.temporal_sequence,selectedFit
            );
            if(!finite(auxiliaryRankingAnchorLogit))
              throw new Error('TCN_LSTM_AUXILIARY_RANKING_ANCHOR_DIAGNOSTIC_NON_FINITE:'+item.id);
            if(!selectedFit.execution_logistic_context_model||
              selectedFit.execution_logistic_context_metadata?.status!=='AVAILABLE')
              throw new Error('TCN_LSTM_TEMPORAL_LOGISTIC_EXECUTION_CONTEXT_NOT_AVAILABLE');
            const externalLogisticContextProbability=
              predictCrossFittedCalibratedTemporalLogisticProbability(
                buildTcnLstmFlattenedFeatures(sourceRow.temporal_sequence),
                selectedFit.execution_logistic_context_model
              );
            const externalLogisticLogit=probabilityLogit(externalLogisticContextProbability);
            const executionScore=predictTcnLstmHybridExecutionScore(
              sourceRow.temporal_sequence,selectedFit,{externalLogisticLogit}
            );
            if(executionScore.status!=='AVAILABLE'||
              !finite(executionScore.risk_adjusted_net_return_score))
              throw new Error('TCN_LSTM_EXECUTION_RISK_ADJUSTED_SCORE_UNAVAILABLE:'+item.id);
            const contextRiskPolicy=selectedFit.execution_risk_policy;
            const pooledOnlyRiskPolicy=selectedFit.pooled_only_execution_risk_policy;
            if(!contextRiskPolicy||!pooledOnlyRiskPolicy||
              !finite(contextRiskPolicy.selected_minimum_risk_adjusted_score)||
              !finite(pooledOnlyRiskPolicy.selected_minimum_risk_adjusted_score)||
              !finite(pooledOnlyRiskPolicy.selected_risk_penalty_weight))
              throw new Error('TCN_LSTM_FROZEN_SELECTIVE_POLICIES_UNAVAILABLE:'+item.id);
            // The pooled-only reference receives its own score penalty and
            // abstention threshold, both selected on the same inner block.
            // Neither policy may refit its threshold or lambda on outer rows.
            const pooledOnlyExecution=predictTcnLstmHybridExecutionHeads(
              sourceRow.temporal_sequence,selectedFit,{variant:'POOLED_ONLY'}
            );
            const pooledOnlyRiskPenaltyWeight=Number(
              pooledOnlyRiskPolicy.selected_risk_penalty_weight
            );
            const pooledOnlyReturnEstimator=
              pooledOnlyRiskPolicy.selected_return_estimator??'POINTWISE_HUBER';
            const pooledOnlyExpectedNetReturnPct=
              pooledOnlyReturnEstimator==='HURDLE_EXPECTED_VALUE'
                ?pooledOnlyExecution.predicted_hurdle_net_return_pct
                :pooledOnlyExecution.predicted_net_return_pct;
            const pooledOnlyRiskAdjustedScore=
              pooledOnlyExpectedNetReturnPct-
              pooledOnlyRiskPenaltyWeight*pooledOnlyExecution.predicted_downside_risk_pct;
            if(!finite(pooledOnlyRiskAdjustedScore)||
              !finite(pooledOnlyExpectedNetReturnPct)||
              !finite(pooledOnlyExecution.predicted_downside_risk_pct))
              throw new Error('TCN_LSTM_POOLED_ONLY_EXECUTION_RISK_SCORE_UNAVAILABLE:'+item.id);
            return {
              ...item,
              probability:Number(preInnerProbability),
              raw_probability:Number(preInnerProbability),
              calibrated_probability:Number(item.probability),
              calibration_metadata:{
                schema:'RADARX_TCN_LSTM_TRAIN_ONLY_INTERNAL_CALIBRATION_V1',
                status:'TRAIN_ONLY_CALIBRATED',
                selected_method:calibrator.method??'UNKNOWN',
                applied_to_final_model:true,
                fit_partition:'OUTER_TRAIN_INTERNAL_CALIBRATION_BLOCK',
                fit_rows:calibrationRows.length,
                fit_positive:calibrator.positive??null,
                fit_negative:calibrator.negative??null,
                training_partition_only:true,
                outer_validation_used_for_calibrator_fit:false,
                outer_validation_used_for_calibrator_selection:false,
                holdout_used_for_calibration:false
              },
              pre_inner_calibration_probability:Number(preInnerProbability),
              auxiliary_ranking_score:Number(auxiliaryRankingScore),
              auxiliary_ranking_anchor_logit:Number(auxiliaryRankingAnchorLogit),
              predicted_net_return_pct:Number(executionScore.predicted_net_return_pct),
              predicted_pointwise_net_return_pct:Number(executionScore.predicted_pointwise_net_return_pct),
              predicted_hurdle_net_return_pct:executionScore.predicted_hurdle_net_return_pct,
              predicted_positive_net_return_probability:
                executionScore.predicted_positive_net_return_probability,
              execution_return_estimator:executionScore.return_estimator,
              predicted_downside_risk_pct:Number(executionScore.predicted_downside_risk_pct),
              execution_risk_penalty_weight:Number(executionScore.risk_penalty_weight),
              execution_risk_adjusted_score:Number(executionScore.risk_adjusted_net_return_score),
              execution_risk_abstention_threshold:Number(contextRiskPolicy.selected_minimum_risk_adjusted_score),
              execution_risk_abstention_percentile:Number(contextRiskPolicy.selected_abstention_percentile),
              execution_risk_abstention_source_partition:'INNER_SELECTION_ONLY',
              temporal_logistic_cv_context_probability:Number(externalLogisticContextProbability),
              temporal_logistic_cv_context_logit:Number(externalLogisticLogit),
              execution_risk_score_semantics:executionScore.score_semantics,
              pooled_only_predicted_net_return_pct:Number(pooledOnlyExpectedNetReturnPct),
              pooled_only_pointwise_net_return_pct:Number(pooledOnlyExecution.predicted_net_return_pct),
              pooled_only_hurdle_net_return_pct:pooledOnlyExecution.predicted_hurdle_net_return_pct,
              pooled_only_positive_net_return_probability:
                pooledOnlyExecution.predicted_positive_net_return_probability,
              pooled_only_execution_return_estimator:pooledOnlyReturnEstimator,
              pooled_only_predicted_downside_risk_pct:Number(pooledOnlyExecution.predicted_downside_risk_pct),
              pooled_only_execution_risk_adjusted_score:Number(pooledOnlyRiskAdjustedScore),
              pooled_only_execution_risk_penalty_weight:Number(pooledOnlyRiskPenaltyWeight),
              pooled_only_execution_risk_abstention_threshold:Number(
                pooledOnlyRiskPolicy.selected_minimum_risk_adjusted_score
              ),
              pooled_only_execution_risk_abstention_percentile:Number(
                pooledOnlyRiskPolicy.selected_abstention_percentile
              ),
              pooled_only_execution_risk_abstention_source_partition:'INNER_SELECTION_ONLY'
            };
          });
          trainingArtifacts.TCN_LSTM_HYBRID={
            artifact_sha256:artifact.artifact_sha256,
            schema:TCN_LSTM_HYBRID_SCHEMA,
            architecture:'CAUSAL_DILATED_TCN_UNIDIRECTIONAL_LSTM_SINGLE_HEAD_TEMPORAL_ATTENTION_V1',
            input_shape:[TCN_LSTM_STEPS,TCN_LSTM_INPUT_CHANNELS],
            internal_training_rows:trainingRows.length,
            internal_selection_rows:selectionRows.length,
            internal_calibration_rows:calibrationRows.length,
            effective_training_rows:selection.effective_training_rows,
            selected_configuration:selection.selected_configuration,
            selection_brier:selection.candidates.find(row=>
              row.name===selection.selected_configuration)?.selection_brier??null,
            selection_score:selection.candidates.find(row=>
              row.name===selection.selected_configuration)?.selection_score??null,
            logistic_selection_brier:selection.baseline?.selection_brier??null,
            logistic_selection_score:selection.baseline?.selection_score??null,
            selected_pairwise_ranking:selection.candidates.find(row=>
              row.name===selection.selected_configuration)?.pairwise_ranking??null,
            selected_pairwise_ranking_head:selection.candidates.find(row=>
              row.name===selection.selected_configuration)?.ranking_head??null,
            selected_shared_classifier_loss:{
              method:'SHARED_TCN_LSTM_CLASSIFIER_PAIRWISE_LOGIT_BACKPROP_V1',
              enabled:Number(selection.candidates.find(row=>
                row.name===selection.selected_configuration)?.config?.rankingWeight??0)>0,
              weight:Number(selection.candidates.find(row=>
                row.name===selection.selected_configuration)?.config?.rankingWeight??0),
              training_pair_support:selection.training_return_pair_support??null,
              candidate_count_requested:selection.candidate_count_requested??null,
              candidate_count_evaluated:selection.candidate_count_evaluated??null,
              skipped_candidates:selection.skipped_candidates??[]
            },
            ranking_head_selection_qualification:selection.ranking_head_selection_qualification??null,
            execution_head_context_ablation:selection.execution_head_context_ablation_qualification?.result??null,
            execution_head_context_ablation_required_for_inner_qualification:true,
            execution_head_input_feature_schema:
              TCN_LSTM_EXECUTION_HEAD_INPUT_FEATURE_SCHEMA,
          execution_logistic_context:selection.execution_logistic_context??null,
            ranking_head_schema:'RADARX_TCN_LSTM_AUXILIARY_PAIRWISE_LOGIT_RESIDUAL_HEAD_V1',
            ranking_head_parameters:TCN_LSTM_HIDDEN,
            ranking_head_role:'AUXILIARY_CROSS_SECTIONAL_RANKING_WITH_OPTIONAL_SHARED_CLASSIFIER_PAIRWISE_TRAINING',
            ranking_scores_emitted_for:'OUTER_VALIDATION_ONLY',
            holdout_ranking_scores_emitted:false,
            ranking_anchor_scores_emitted_for:'OUTER_VALIDATION_ONLY',
            holdout_ranking_anchor_scores_emitted:false,
            internal_calibrator:calibrator.method,
            pre_inner_calibration_diagnostic:{
              schema:'RADARX_TCN_LSTM_PRE_INNER_CALIBRATION_SCORE_AUDIT_V1',
              rows:split.validation.length,
              source_partition:'OUTER_VALIDATION_ONLY',
              holdout_values_included:false,
              primary_probabilities_unchanged:true
            },
            scored_external_rows:eventRows.length,
            inference_mode:innerQualified?'INNER_SELECTED':'INNER_BEST_DIAGNOSTIC_ONLY',
            inner_selection_qualified:innerQualified,
            diagnostic_only:!innerQualified
          };
        }else{
          unavailable.TCN_LSTM_HYBRID={
            reason:args.hurdleInnerOnly
              ?'HURDLE_INNER_ONLY_MODE_OUTER_VALIDATION_SCORING_SUPPRESSED'
              :!innerQualified
                ?'INNER_SELECTION_NOT_QUALIFIED_OUTER_VALIDATION_NOT_OPENED'
                :selectedFit===null
                  ?'NO_SELECTED_OR_DIAGNOSTIC_TCN_LSTM_FIT'
                  :'TCN_LSTM_INTERNAL_CALIBRATION_SUPPORT_NOT_MET',
            inner_qualification_passed:innerQualified,
            outer_validation_opened:false,
            selection_status:selection.status,
            candidates:selection.candidates??[],
            calibration:calibrator
          };
        }
      }
    }
  }catch(error){
    qualificationByModel.TCN_LSTM_HYBRID={
      passed:false,reason:String(error?.message||error),diagnostic_only:true
    };
    unavailable.TCN_LSTM_HYBRID={
      reason:String(error?.message||error),training_rows:split.train.length
    };
    training.model_internal_diagnostics.TCN_LSTM_HYBRID={
      status:'TRAINING_OR_ARTIFACT_FAILED_CLOSED',
      reason:String(error?.message||error)
    };
  }

  if(args.hurdleInnerOnly){
    const innerOnlyReport={
      schema:'RADARX_BUILD224_HURDLE_V2_INNER_TRAINING_REPORT_V1',
      status:hurdleV2ExportStatus?.artifact_path
        ?(hurdleV2ExportStatus.inner_qualified
          ?'INNER_QUALIFIED_FOR_OUTER_REPLAY':'INNER_NOT_QUALIFIED_RETAIN_LOGISTIC')
        :'HURDLE_V2_TRAINING_OR_EXPORT_FAILED',
      code_commit_sha:sourceCommitSha,
      dataset_sha256:datasetSha,input_file_sha256:inputFileSha256,
      dataset_source_commit_sha:datasetSourceCommitSha,dataset_row_count:rows.length,
      target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
      target_semantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
      cost_model_id:NEURAL_CLOSURE_COST_MODEL_ID,round_trip_cost_bps:args.roundTripCostBps,
      split_id:split.schema,split_counts:{train:split.train.length,
        validation:split.validation.length,holdout:split.holdout.length},
      hurdle_v2:hurdleV2ExportStatus,
      tcn_lstm_inner_diagnostics:training.model_internal_diagnostics?.TCN_LSTM_HYBRID??null,
      logistic_baseline_cv:logisticTuning.report??null,
      holdout:{status:'LOCKED',opened:false,predictions_generated:false,
        metrics_read:false,rows_included_in_scored_predictions:0},
      paper_trading:true,real_order_execution:false,
      outer_validation_replay_started:false,holdout_values_used:false
    };
    await atomicJson(outputPath,innerOnlyReport);
    console.log(JSON.stringify(innerOnlyReport,null,2));
    if(!hurdleV2ExportStatus?.artifact_path)
      throw new Error(hurdleV2ExportStatus?.reason??'HURDLE_V2_INNER_ONLY_EXPORT_FAILED');
    return;
  }

  // Hybrid TCN+Attention: train only on the shared train partition.
  let hybridFit=null;
  try{
    hybridFit=trainHybridTcnAttention(split.train,{
      // This model previously optimized a trading-return surrogate while being
      // judged as a probability forecaster. Switch the primary experiment to
      // proper-scoring BCE; initialize only from the training-fold class prior.
      // The return/drawdown objective remains available for separate ranking work.
      epochs:16,learningRate:0.0015,l2:0.001,
      objectiveMode:'BINARY_CROSS_ENTROPY',
      targetDefinition:NEURAL_CLOSURE_TARGET_DEFINITION
    });
    const normalization=hybridFit.normalization;
    const hybridArtifact=makeArtifact({
      name:'RADARX_HYBRID_TCN_ATTENTION_FIRST_TOUCH_4H',
      family:'HYBRID_TCN_ATTENTION',version:'HYBRID_TCN_ATTENTION_4H_V2',
      sourceCommitSha,featureSchemaId:'RADARX_HYBRID_TCN_ATTENTION_SEQUENCE_24X29_V2',
      featureNames:[...HYBRID_FEATURE_NAMES],
      normalization:{mean:normalization.means,std:normalization.standard_deviations},
      modelState:{fitted:hybridFit}
    });
    const verified=verifyVersionedModelArtifact(hybridArtifact,{
      expectedSourceCommitSha:sourceCommitSha
    });
    if(!verified.valid)throw new Error('HYBRID_ARTIFACT_INVALID:'+verified.reason);
    modelArtifactsByModel.HYBRID_TCN_ATTENTION=hybridArtifact;
    trainingArtifacts.HYBRID_TCN_ATTENTION={
      artifact_sha256:hybridArtifact.artifact_sha256,
      architecture:hybridFit.architecture,
      training_samples:hybridFit.training_samples,
      epochs:hybridFit.epochs,
      outer_validation_scored:false,
      inner_selection_protocol:'NOT_IMPLEMENTED',
      memory_profile:hybridFit.memory_profile
    };
    markOuterValidationSuppressed(unavailable,'HYBRID_TCN_ATTENTION',
      'INNER_SELECTION_PROTOCOL_NOT_IMPLEMENTED_OUTER_VALIDATION_NOT_OPENED');
  }catch(error){
    unavailable.HYBRID_TCN_ATTENTION={
      reason:String(error?.message||error),training_rows:split.train.length
    };
  }

  // Dense MLP uses the same exact day partitions as the common fixed-SHA split.
  const densePrepared=validateAndPrepareDense4hRows(rows);
  const denseSplit=splitDense4hChronologically(densePrepared.rows);
  if(!sameIds(split.train,denseSplit.train)||
    !sameIds(split.validation,denseSplit.validation)||
    !sameIds(split.holdout,denseSplit.holdout))
    throw new Error('DENSE_MLP_SHARED_PARTITION_IDENTITY_MISMATCH');
  const denseScaler=fitDenseStandardizer(denseSplit.train);
  const denseAnchor=fitDenseLogisticAnchor(denseSplit.train,denseScaler);
  const denseFit=fitDenseGeneralizationProjection(denseSplit.train,denseAnchor,denseScaler,{
    dropout:0.15,l2:0.06,rank:6,hidden:12,epochs:args.denseEpochs,seed:1337,
    learningRate:0.008,lossObjective:'FOCAL_ASYMMETRIC_BRIER',
    focalGammaPositive:1,focalGammaNegative:2
  });
  const denseArtifact=makeArtifact({
    name:'RADARX_DENSE_MLP_FIRST_TOUCH_4H',
    family:'DENSE_MLP',version:'DENSE_MLP_4H_V1',
    sourceCommitSha,featureSchemaId:COGNITIVE_FEATURE_SCHEMA,
    featureNames:[...COGNITIVE_FEATURE_NAMES],
    normalization:{mean:denseScaler.means,std:denseScaler.scales},
    modelState:{fit:denseFit}
  });
  const denseVerified=verifyVersionedModelArtifact(denseArtifact,{
    expectedSourceCommitSha:sourceCommitSha
  });
  if(!denseVerified.valid)throw new Error('DENSE_MLP_ARTIFACT_INVALID:'+denseVerified.reason);
  const denseRowsById=new Map(densePrepared.rows.map(row=>[row.id,row]));
  modelArtifactsByModel.DENSE_MLP=denseArtifact;
  trainingArtifacts.DENSE_MLP={
    artifact_sha256:denseArtifact.artifact_sha256,
    training_rows:denseFit.training_rows,
    training_positives:denseFit.training_positives,
    training_negatives:denseFit.training_negatives,
    best_epoch:denseFit.best_epoch,
    early_stopping:denseFit.early_stopping,
    outer_validation_scored:false,
    inner_selection_protocol:'NOT_IMPLEMENTED',
    validation_split_rows:denseSplit.validation.length,
    holdout_split_rows:denseSplit.holdout.length
  };
  qualificationByModel.HYBRID_TCN_ATTENTION={
    passed:false,reason:'INNER_SELECTION_PROTOCOL_NOT_IMPLEMENTED_OUTER_VALIDATION_NOT_OPENED',
    diagnostic_only:true
  };
  qualificationByModel.DENSE_MLP={
    passed:false,reason:'INNER_SELECTION_PROTOCOL_NOT_IMPLEMENTED_OUTER_VALIDATION_NOT_OPENED',
    diagnostic_only:true
  };
  markOuterValidationSuppressed(unavailable,'DENSE_MLP',
    'INNER_SELECTION_PROTOCOL_NOT_IMPLEMENTED_OUTER_VALIDATION_NOT_OPENED');
  // Bind every serialized model to the exact data, target, feature, cost and
  // chronological split contract before hashing the final benchmark artifact.
  const modelArtifactResearchLineage={};
  for(const [modelName,artifact] of Object.entries(modelArtifactsByModel)){
    const enriched=attachResearchLineageToModelArtifact(artifact,{
      datasetSha256:datasetSha,
      inputFileSha256,
      datasetSourceCommitSha,
      targetDefinition:NEURAL_CLOSURE_TARGET_DEFINITION,
      targetSemantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
      featureSchemaId:artifact.feature_schema_id,
      horizonMs:NEURAL_CLOSURE_HORIZON_MS,
      costModelId:NEURAL_CLOSURE_COST_MODEL_ID,
      roundTripCostBps:args.roundTripCostBps,
      splitId:split.schema
    });
    const verified=verifyVersionedModelArtifact(enriched,{
      expectedSourceCommitSha:sourceCommitSha,requireResearchLineage:true
    });
    if(!verified.valid)
      throw new Error('MODEL_ARTIFACT_RESEARCH_LINEAGE_VERIFY_FAILED:'+modelName+':'+verified.reason);
    modelArtifactsByModel[modelName]=enriched;
    modelArtifactResearchLineage[modelName]=enriched.research_lineage;
    for(const prediction of predictionsByModel[modelName]??[])
      prediction.artifact_sha256=enriched.artifact_sha256;
    if(trainingArtifacts[modelName])
      trainingArtifacts[modelName].artifact_sha256=enriched.artifact_sha256;
  }
  training.model_artifact_research_lineage=modelArtifactResearchLineage;

  const benchmark=runNeuralClosureBenchmark({
    rows,predictionsByModel,modelArtifactsByModel,sourceCommitSha,
    qualificationByModel,
    minimumClassSupport:NEURAL_CLOSURE_MIN_CLASS_SUPPORT,
    roundTripCostBps:args.roundTripCostBps,
    minimumHoldoutTrades:args.minimumHoldoutTrades,
    minimumWinRatePct:args.minimumWinRatePct,
    maximumDrawdownPct:args.maximumDrawdownPct
  });

  // Outer-validation-only execution-risk rank comparison. The penalty lambda
  // was selected on the earlier inner-selection block and is never refitted here.
  let externalExecutionRiskTopK={
    schema:'RADARX_TCN_LSTM_FROZEN_EXECUTION_RISK_EXTERNAL_VALIDATION_TOP_K_V1',
    status:'UNAVAILABLE',reason:'TCN_LSTM_OR_LOGISTIC_EXTERNAL_PREDICTIONS_UNAVAILABLE',
    evaluation_partition:'OUTER_VALIDATION_ONLY',holdout_rows_or_scores_used:false
  };
  let pooledOnlyExternalExecutionRiskTopK={
    schema:'RADARX_TCN_LSTM_POOLED_ONLY_FROZEN_EXECUTION_RISK_EXTERNAL_VALIDATION_TOP_K_V1',
    status:'UNAVAILABLE',reason:'POOLED_ONLY_OR_LOGISTIC_EXTERNAL_PREDICTIONS_UNAVAILABLE',
    evaluation_partition:'OUTER_VALIDATION_ONLY',holdout_rows_or_scores_used:false
  };
  let executionHeadExternalAblation={
    schema:'RADARX_TCN_LSTM_SCORE_CONDITIONED_EXTERNAL_ABLATION_V1',
    status:'UNAVAILABLE',reason:'CONTEXT_OR_POOLED_ONLY_EXTERNAL_METRICS_UNAVAILABLE',
    selection_partition_only_for_lambda:true,evaluation_partition:'OUTER_VALIDATION_ONLY',
    outer_validation_used_for_lambda_or_top_k_selection:false,holdout_rows_or_scores_used:false
  };
  const lstmExternalPredictions=predictionsByModel.TCN_LSTM_HYBRID;
  const logisticExternalPredictions=predictionsByModel.LOGISTIC_REGRESSION;
  if(Array.isArray(lstmExternalPredictions)&&Array.isArray(logisticExternalPredictions)){
    const validationIds=new Set(split.validation.map(row=>String(row.id)));
    const riskById=new Map(lstmExternalPredictions.filter(item=>
      validationIds.has(String(item.id))).map(item=>[String(item.id),item]));
    const logisticById=new Map(logisticExternalPredictions.filter(item=>
      validationIds.has(String(item.id))).map(item=>[String(item.id),item]));
    const alignedRows=[...split.validation].sort((a,b)=>a.at-b.at||
      String(a.symbol).localeCompare(String(b.symbol))||
      String(a.id).localeCompare(String(b.id)));
    const complete=alignedRows.every(row=>{
      const neural=riskById.get(String(row.id)),logistic=logisticById.get(String(row.id));
      return neural&&logistic&&finite(neural.execution_risk_adjusted_score)&&
        finite(neural.execution_risk_penalty_weight)&&
        finite(neural.execution_risk_abstention_threshold)&&
        finite(neural.execution_risk_abstention_percentile)&&
        finite(neural.pooled_only_execution_risk_adjusted_score)&&
        finite(neural.pooled_only_execution_risk_penalty_weight)&&
        finite(neural.pooled_only_execution_risk_abstention_threshold)&&
        finite(neural.pooled_only_execution_risk_abstention_percentile)&&
        finite(logistic.probability);
    });
    if(complete){
      const contextScores=alignedRows.map(row=>riskById.get(String(row.id)).execution_risk_adjusted_score);
      const pooledScores=alignedRows.map(row=>riskById.get(String(row.id)).pooled_only_execution_risk_adjusted_score);
      const logisticScores=alignedRows.map(row=>
        logisticById.get(String(row.id)).calibrated_probability??
        logisticById.get(String(row.id)).probability);
      const contextLambdas=alignedRows.map(row=>riskById.get(String(row.id)).execution_risk_penalty_weight);
      const pooledLambdas=alignedRows.map(row=>riskById.get(String(row.id)).pooled_only_execution_risk_penalty_weight);
      const contextThresholds=alignedRows.map(row=>riskById.get(String(row.id)).execution_risk_abstention_threshold);
      const pooledThresholds=alignedRows.map(row=>riskById.get(String(row.id)).pooled_only_execution_risk_abstention_threshold);
      const contextPercentiles=alignedRows.map(row=>riskById.get(String(row.id)).execution_risk_abstention_percentile);
      const pooledPercentiles=alignedRows.map(row=>riskById.get(String(row.id)).pooled_only_execution_risk_abstention_percentile);
      if(new Set(contextThresholds).size!==1||new Set(pooledThresholds).size!==1||
        new Set(contextPercentiles).size!==1||new Set(pooledPercentiles).size!==1)
        throw new Error('OUTER_SELECTIVE_EXECUTION_POLICY_NOT_FROZEN');
      externalExecutionRiskTopK=evaluateExternalExecutionRiskTopK(
        alignedRows,contextScores,logisticScores,
        {riskPenaltyWeights:contextLambdas,topKGrid:[1],roundTripCostBps:args.roundTripCostBps,
          minimumRiskAdjustedScore:contextThresholds[0],abstentionPercentile:contextPercentiles[0]}
      );
      pooledOnlyExternalExecutionRiskTopK=evaluateExternalExecutionRiskTopK(
        alignedRows,pooledScores,logisticScores,
        {riskPenaltyWeights:pooledLambdas,topKGrid:[1],roundTripCostBps:args.roundTripCostBps,
          minimumRiskAdjustedScore:pooledThresholds[0],abstentionPercentile:pooledPercentiles[0]}
      );
      const contextTrials=new Map(externalExecutionRiskTopK.trials.map(row=>[row.top_k_per_timestamp,row]));
      const pooledTrials=new Map(pooledOnlyExternalExecutionRiskTopK.trials.map(row=>[row.top_k_per_timestamp,row]));
      const pairedTopK=[1].map(topK=>{
        const context=contextTrials.get(topK),pooled=pooledTrials.get(topK);
        const c=context?.neural_metrics,p=pooled?.neural_metrics;
        const delta=key=>finite(c?.[key])&&finite(p?.[key])
          ?Number((Number(c[key])-Number(p[key])).toFixed(6)):null;
        return {
          top_k_per_timestamp:topK,
          context_metrics:c??null,pooled_only_metrics:p??null,
          context_minus_pooled_only:{
            trade_count:delta('trade_count'),
            win_rate_percentage_points:delta('win_rate_pct'),
            net_pnl_percentage_points:delta('net_pnl_pct'),
            max_drawdown_percentage_points:delta('max_drawdown_pct')
          }
        };
      });
      executionHeadExternalAblation={
        schema:'RADARX_TCN_LSTM_SCORE_CONDITIONED_EXTERNAL_ABLATION_V1',
        status:'AVAILABLE',baseline_variant:'POOLED_ONLY',
        candidate_variant:'LOGIT_CONTEXT_AUGMENTED',
        selection_partition_only_for_lambda_and_abstention:true,
        evaluation_partition:'OUTER_VALIDATION_ONLY',
        same_outer_validation_opportunities:true,
        both_policies_frozen_on_selection:true,
        separate_inner_selected_risk_penalties:true,
        same_round_trip_cost_bps:args.roundTripCostBps,
        outer_validation_used_for_lambda_or_top_k_or_threshold_selection:false,
        outer_validation_used_for_lambda_or_top_k_selection:false,
        holdout_rows_or_scores_used:false,
        context_risk_penalty_weight:externalExecutionRiskTopK.risk_penalty_weight,
        pooled_only_risk_penalty_weight:pooledOnlyExternalExecutionRiskTopK.risk_penalty_weight,
        context_abstention_policy:externalExecutionRiskTopK.frozen_abstention_policy,
        pooled_only_abstention_policy:pooledOnlyExternalExecutionRiskTopK.frozen_abstention_policy,
        matched_logistic_trade_counts:externalExecutionRiskTopK.trials.every(row=>
          row.logistic_matched_candidate_trade_counts===true)&&
          pooledOnlyExternalExecutionRiskTopK.trials.every(row=>
            row.logistic_matched_candidate_trade_counts===true),
        trials:pairedTopK
      };
    }else{
      const reason='OUTER_VALIDATION_CONTEXT_POOLED_OR_LOGISTIC_ALIGNMENT_INCOMPLETE';
      externalExecutionRiskTopK={...externalExecutionRiskTopK,reason};
      pooledOnlyExternalExecutionRiskTopK={...pooledOnlyExternalExecutionRiskTopK,reason};
      executionHeadExternalAblation={...executionHeadExternalAblation,reason,
        expected_validation_rows:alignedRows.length};
    }
  }
  // Paired moving-block bootstrap over the outer-validation days.
  // It estimates uncertainty only; it never selects thresholds, Top-K, lambda,
  // calibration, hyperparameters or a candidate. The final holdout is excluded.
  let outerValidationUncertaintyBootstrap={
    schema:'RADARX_OUTER_VALIDATION_MOVING_BLOCK_BOOTSTRAP_V1',
    status:'UNAVAILABLE',reason:'OUTER_VALIDATION_BOOTSTRAP_INPUTS_UNAVAILABLE',
    evaluation_partition:'OUTER_VALIDATION_ONLY',holdout_rows_or_scores_used:false
  };
  const bootstrapRows=[...split.validation].sort((a,b)=>a.at-b.at||
    String(a.symbol).localeCompare(String(b.symbol))||
    String(a.id).localeCompare(String(b.id)));
  const bootstrapIds=bootstrapRows.map(row=>String(row.id));
  const bootstrapProbabilityByModel={};
  for(const [name,predictionRowsForModel] of Object.entries(predictionsByModel)){
    if(!Array.isArray(predictionRowsForModel))continue;
    const map=new Map(predictionRowsForModel.filter(item=>
      bootstrapIds.includes(String(item?.id))).map(item=>[String(item.id),Number(item.probability)]));
    if(map.size===bootstrapIds.length&&bootstrapIds.every(id=>finite(map.get(id))))
      bootstrapProbabilityByModel[name]=bootstrapIds.map(id=>map.get(id));
  }
  if(bootstrapProbabilityByModel.LOGISTIC_REGRESSION&&
    Array.isArray(lstmExternalPredictions)){
    const riskById=new Map(lstmExternalPredictions.filter(item=>
      bootstrapIds.includes(String(item?.id))).map(item=>[String(item.id),item]));
    const contextComplete=bootstrapIds.every(id=>
      finite(riskById.get(id)?.execution_risk_adjusted_score)&&
      finite(riskById.get(id)?.execution_risk_abstention_threshold));
    const pooledComplete=bootstrapIds.every(id=>
      finite(riskById.get(id)?.pooled_only_execution_risk_adjusted_score)&&
      finite(riskById.get(id)?.pooled_only_execution_risk_abstention_threshold));
    if(contextComplete&&pooledComplete){
      const logisticExecutionById=new Map(predictionsByModel.LOGISTIC_REGRESSION
        .map(item=>[String(item.id),Number(item.calibrated_probability??item.probability)]));
      const contextThresholds=[...new Set(bootstrapIds.map(id=>
        riskById.get(id).execution_risk_abstention_threshold))];
      const pooledThresholds=[...new Set(bootstrapIds.map(id=>
        riskById.get(id).pooled_only_execution_risk_abstention_threshold))];
      if(contextThresholds.length!==1||pooledThresholds.length!==1)
        throw new Error('BOOTSTRAP_SELECTIVE_EXECUTION_THRESHOLDS_NOT_FROZEN');
      const executionScoresByPolicy={
        LOGIT_CONTEXT_AUGMENTED:bootstrapIds.map(id=>
          riskById.get(id).execution_risk_adjusted_score),
        POOLED_ONLY:bootstrapIds.map(id=>
          riskById.get(id).pooled_only_execution_risk_adjusted_score),
        LOGISTIC_MATCHED_CONTEXT:bootstrapIds.map(id=>logisticExecutionById.get(id)),
        LOGISTIC_MATCHED_POOLED:bootstrapIds.map(id=>logisticExecutionById.get(id)),
        LOGISTIC_REGRESSION:bootstrapIds.map(id=>logisticExecutionById.get(id))
      };
      const executionPolicyConfigurations={
        LOGIT_CONTEXT_AUGMENTED:{minimum_score:contextThresholds[0]},
        POOLED_ONLY:{minimum_score:pooledThresholds[0]},
        LOGISTIC_MATCHED_CONTEXT:{match_trade_counts_with:'LOGIT_CONTEXT_AUGMENTED'},
        LOGISTIC_MATCHED_POOLED:{match_trade_counts_with:'POOLED_ONLY'}
      };
      outerValidationUncertaintyBootstrap=bootstrapOuterValidationUncertainty(
        bootstrapRows,bootstrapProbabilityByModel,{
          executionScoresByPolicy,executionPolicyConfigurations,topKGrid:[1],
          roundTripCostBps:args.roundTripCostBps,
          repetitions:250,blockLengthDays:3,seed:22429,
          maxConcurrentPositions:30
        }
      );
    }else{
      outerValidationUncertaintyBootstrap={
        ...outerValidationUncertaintyBootstrap,
        reason:'CONTEXT_OR_POOLED_ONLY_EXECUTION_SCORE_ALIGNMENT_INCOMPLETE',
        expected_outer_validation_rows:bootstrapRows.length
      };
    }
  }
  training.outer_validation_uncertainty_bootstrap=outerValidationUncertaintyBootstrap;
  training.model_internal_diagnostics.TCN_LSTM_HYBRID={
    ...(training.model_internal_diagnostics.TCN_LSTM_HYBRID??{}),
    external_validation_execution_risk_top_k:externalExecutionRiskTopK,
    pooled_only_external_validation_execution_risk_top_k:pooledOnlyExternalExecutionRiskTopK,
    score_conditioned_external_ablation:executionHeadExternalAblation,
    outer_validation_uncertainty_bootstrap:outerValidationUncertaintyBootstrap
  };
  const evaluated=Object.entries(benchmark.models).map(([name,model])=>({
    model:name,status:model.status,
    validation_brier:model.validation?.raw_brier_score??null,
    raw_validation_brier:model.validation?.raw_brier_score??null,
    calibrated_validation_brier:model.validation?.calibrated_brier_score??null,
    raw_validation_log_loss:model.validation?.raw_log_loss??null,
    calibrated_validation_log_loss:model.validation?.calibrated_log_loss??null,
    raw_validation_pr_auc:model.validation?.raw_pr_auc??null,
    calibrated_validation_pr_auc:model.validation?.calibrated_pr_auc??null,
    raw_validation_roc_auc:model.validation?.raw_roc_auc??null,
    calibrated_validation_roc_auc:model.validation?.calibrated_roc_auc??null,
    raw_confusion_matrix:model.validation?.raw_classification_metrics?.confusion_matrix??null,
    calibrated_confusion_matrix:model.validation?.calibrated_classification_metrics?.confusion_matrix??null,
    reliability_diagnostics:model.validation?.reliability_diagnostics??null,
    external_validation_execution_risk_top_k:name==='TCN_LSTM_HYBRID'?externalExecutionRiskTopK:null,
    pooled_only_external_validation_execution_risk_top_k:name==='TCN_LSTM_HYBRID'?pooledOnlyExternalExecutionRiskTopK:null,
    score_conditioned_external_ablation:name==='TCN_LSTM_HYBRID'?executionHeadExternalAblation:null,
    probability_stage_diagnostics:
      model.validation?.probability_stage_diagnostics??null,
    validation:model.validation?{
      sample_count:model.validation.sample_count??null,
      positive_count:model.validation.positive_count??null,
      negative_count:model.validation.negative_count??null,
      raw_brier_score:model.validation.raw_brier_score??null,
      calibrated_brier_score:model.validation.calibrated_brier_score??null,
      threshold_selection_sample_count:model.validation.threshold_selection_sample_count??0,
      threshold_selection_probability_distribution:
        model.validation.threshold_selection_probability_distribution??null,
      threshold_selection_positive_count:model.validation.threshold_selection_positive_count??0,
      threshold_selection_negative_count:model.validation.threshold_selection_negative_count??0,
      outer_validation_probability_distribution:
        model.validation.outer_validation_probability_distribution??null,
      chronological_stability_diagnostics:
        model.validation.chronological_stability_diagnostics??null,
      expanded_threshold_window_counterfactual:
        model.validation.expanded_threshold_window_counterfactual??null,
      threshold_selection:model.validation.threshold_selection??null,
      selected_threshold:model.validation.selected_threshold??null,
      threshold_selection_eligible_count:model.validation.threshold_selection_eligible_count??0,
      threshold_selection_gates:model.validation.threshold_selection_gates??null,
      threshold_trials:model.validation.threshold_trials??[],
      validation_threshold_metrics:model.validation.validation_threshold_metrics??null,
      validation_threshold_risk_gates:model.validation.validation_threshold_risk_gates??null,
      outer_validation_gate:model.validation.outer_validation_gate??null
    }:null,
    calibration_status:model.calibration?.status??null,
    brier:model.holdout?.brier_score??null,
    logistic_brier:benchmark.models.LOGISTIC_REGRESSION?.holdout?.brier_score??null,
    net_pnl_pct:model.holdout?.net_pnl_pct??null,
    max_drawdown_pct:model.holdout?.max_drawdown_pct??null,
    trades:model.holdout?.trade_count??null,
    holdout_lock_reason:model.holdout?.reason??null,
    acceptance:model.acceptance?.status??'NOT_EVALUATED',
    acceptance_gates:model.acceptance?.gates??null,
    inner_qualification:model.acceptance?.inner_qualification??null
  }));
  const experimentManifest={
    schema:'RADARX_BUILD224_NEURAL_CLOSURE_EXPERIMENT_MANIFEST_V1',
    artifact_status:'COMPLETE',
    run_status:'COMPLETE',
    scientific_status:benchmark.status,
    code_commit_sha:sourceCommitSha,
    dataset_sha256:datasetSha,
    input_file_sha256:inputFileSha256,
    target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
    target_semantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
    horizon_ms:NEURAL_CLOSURE_HORIZON_MS,
    cost_model_id:NEURAL_CLOSURE_COST_MODEL_ID,
    round_trip_cost_bps:args.roundTripCostBps,
    split_id:split.schema,
    objective_id:training.model_internal_diagnostics?.TCN_LSTM_HYBRID?.selection_scoring?.method??null,
    hurdle_v2_artifact:trainingArtifacts.HURDLE_V2??null,
    feature_schema_ids:Object.fromEntries(Object.entries(benchmark.models).map(([name])=>[
      name,modelArtifactsByModel[name]?.feature_schema_id??
        (name==='COGNITIVE_MLP_V5'||name==='MLP_GBDT_HYBRID'?COGNITIVE_FEATURE_SCHEMA:null)
    ])),
    dataset_source_commit_sha:datasetSourceCommitSha,
    dataset_row_count:rows.length,
    scored_row_count:eventRows.length,
    node_version:process.version,
    node_abi:process.versions.modules,
    command_line:process.argv.slice(2),
    configuration:{...args},
    random_seed_policy:{
      logistic_solver:'FULL_BATCH_GD_DETERMINISTIC_NO_RANDOM_SEED',
      logistic_cv_seed:null,
      logistic_optimizer_deterministic:true,
      logistic_unused_seed_parameter:22429,
      tcn_lstm_seed:22429,
      dense_mlp_seed:1337,
      bootstrap_seed:22429,
      bootstrap_repetitions:250,
      bootstrap_block_length_days:3
    },
    split:{
      schema:split.schema,
      purge_ms:split.purge_ms,
      utc_day_boundaries:split.boundaries,
      counts:split.counts,
      training_rows:split.train.length,
      outer_validation_rows:split.validation.length,
      untouched_holdout_rows:split.holdout.length,
      holdout_scored_rows:0
    },
    models:Object.fromEntries(Object.entries(benchmark.models).map(([name,model])=>[
      name,{
        training_status:trainingArtifacts[name]?'COMPLETE':
          unavailable[name]?'UNAVAILABLE':'NOT_TRAINED',
        feature_schema_id:modelArtifactsByModel[name]?.feature_schema_id??
          (name==='COGNITIVE_MLP_V5'||name==='MLP_GBDT_HYBRID'?COGNITIVE_FEATURE_SCHEMA:null),
        artifact_sha256:modelArtifactsByModel[name]?.artifact_sha256??null,
        evaluation_status:model.status,
        raw_brier:model.validation?.raw_brier_score??null,
        calibrated_brier:model.validation?.calibrated_brier_score??null,
        execution_status:model.validation?.outer_validation_gate?.passed===true
          ?'OUTER_EXECUTION_GATES_PASS':'NOT_APPROVED',
        acceptance_status:model.acceptance?.status??'NOT_EVALUATED'
      }
    ])),
    holdout:{
      status:'LOCKED',
      opened:false,
      predictions_generated:false,
      metrics_read:false,
      rows_included_in_scored_predictions:0,
      reasons:'FOURTEEN_CHECK_OPENING_PROTOCOL_NOT_APPROVED'
    },
    safety:{
      market:'BINANCE_SPOT_ONLY',
      round_trip_cost_bps:args.roundTripCostBps,
      paper_trading:true,
      real_order_execution:false,
      production_touched:false,
      deployment_triggered:false
    }
  };
  const experimentManifestBytes=Buffer.from(JSON.stringify(experimentManifest,null,2)+'\n','utf8');
  const experimentManifestSha256=sha256(experimentManifestBytes);
  const report={
    schema:MODEL_SCHEMA,
    status:benchmark.status,
    experiment_manifest:experimentManifest,
    integrity:{
      model_source_commit_sha:sourceCommitSha,
      dataset_source_commit_sha:datasetSourceCommitSha,
      experiment_manifest_sha256:experimentManifestSha256,
      dataset_sha256:datasetSha,input_file_sha256:inputFileSha256,
      fixed_benchmark_sha256:benchmark.integrity.fixed_benchmark_sha256,
      row_count:rows.length
    },
    training,
    dataset_scope:datasetScope,
    model_artifacts:trainingArtifacts,
    unavailable_models:unavailable,
    benchmark,
    model_comparison:evaluated,
    policy:{
      market:'BINANCE_SPOT_ONLY',paper_trading:true,
      real_order_execution:false,production_touched:false,
      same_shared_60_20_20_utc_day_partitions:true,
      no_validation_or_holdout_gradient_updates:true
    }
  };
  await atomicJson(outputPath,report);
  await atomicJson(join(dirname(outputPath),'experiment-manifest.json'),experimentManifest);
  const artifactDirectory=join(dirname(outputPath),'model-artifacts');
  for(const [family,artifact] of Object.entries(modelArtifactsByModel))
    await atomicJson(join(artifactDirectory,family+'.json'),artifact);
  await atomicJson(join(dirname(outputPath),'predictions.json'),{
    schema:'RADARX_BUILD224_FIXED_SHA_NEURAL_PREDICTION_MATRIX_V1',
    source_commit_sha:sourceCommitSha,dataset_sha256:datasetSha,
    rows_scored:eventRows.length,predictions_by_model:predictionsByModel
  });
  const summary={
    status:report.status,output:outputPath,
    source_commit_sha:sourceCommitSha,
    dataset_sha256:datasetSha,
    fixed_benchmark_sha256:benchmark.integrity.fixed_benchmark_sha256,
    training_artifacts:Object.keys(trainingArtifacts),
    unavailable_models:unavailable,
    model_comparison:evaluated,
    inner_diagnostics:training.model_internal_diagnostics??{},
    production_touched:false,paper_trading:true,real_order_execution:false
  };
  console.log(JSON.stringify(summary,null,2));
  // A valid benchmark that finds no neural superiority is a successful
  // research run. Only malformed data, training errors or invalid artifacts fail CI.
}

try{
  await main();
}catch(error){
  console.error(JSON.stringify({
    status:'NEURAL_TRAINING_OR_BENCHMARK_FAILED_CLOSED',
    code:String(error?.code||error?.message||'UNKNOWN_FAILURE'),
    message:String(error?.message||error),
    stack:String(error?.stack||'').split('\n').slice(0,10),
    policy:{market:'BINANCE_SPOT_ONLY',paper_trading:true,
      real_order_execution:false,production_touched:false}
  },null,2));
  process.exitCode=1;
}
