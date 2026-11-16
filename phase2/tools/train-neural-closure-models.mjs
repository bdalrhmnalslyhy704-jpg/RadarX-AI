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
  NEURAL_CLOSURE_MODEL_FAMILIES,validateFourHourRows,splitFourHourRows,
  runNeuralClosureBenchmark,sha256CanonicalArrayMapped
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
  TCN_LSTM_HYBRID_SCHEMA,TCN_LSTM_STEPS,TCN_LSTM_INPUT_CHANNELS,
  selectTcnLstmHybridHyperparameters,fitTcnLstmHybridCalibration,
  splitFourHourTcnLstmTrainingRows,
  predictTcnLstmHybridProbability,predictTcnLstmHybridCalibratedProbability
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
  createVersionedModelArtifact,verifyVersionedModelArtifact
} from '../core/model-artifact-guardian.mjs';

const finite=value=>value!==null&&value!==undefined&&value!==''&&
  typeof value!=='boolean'&&Number.isFinite(Number(value));
const sigmoid=value=>1/(1+Math.exp(-Math.max(-30,Math.min(30,value))));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const MODEL_SCHEMA='RADARX_BUILD224_NEURAL_MODEL_TRAINING_V3';

function argsMap(argv){
  const args={input:'artifacts/neural-closure/dataset.json',
    output:'reports/neural-closure/fixed-sha-benchmark.json',
    epochs:8,denseEpochs:36,minimumHoldoutTrades:100,
    minimumWinRatePct:55,maximumDrawdownPct:8,roundTripCostBps:30};
  for(let index=2;index<argv.length;index++){
    const token=argv[index];
    if(!token.startsWith('--'))throw new Error('UNKNOWN_ARGUMENT:'+token);
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
  if(!Number.isInteger(args.epochs)||args.epochs<1||args.epochs>20)
    throw new Error('HYBRID_EPOCHS_MUST_BE_1_TO_20');
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
  const datasetScope={
    market_data_source:input.data_quality?.source??null,
    market_data_endpoint:input.market_data_endpoint??null,
    universe_selection:input.universe?.selection??null,
    minimum_quote_volume_24h_usdt:input.universe?.minimum_quote_volume_24h_usdt??null,
    selected_symbol_count:selectedSymbols.length,
    included_symbol_count:includedSymbols.length,
    selected_symbols:selectedSymbols,
    included_symbols:includedSymbols,
    survivorship_bias_warning:input.universe?.survivorship_bias_warning===true,
    historical_delisted_asset_coverage:false,
    interpretation:'CONDITIONAL_ON_CURRENTLY_TRADING_SPOT_PAIRS_AND_CURRENT_24H_LIQUIDITY'
  };
  const rows=validateFourHourRows(input.rows);
  const datasetSha=sha256CanonicalArrayMapped(rows,row=>({
    id:row.id,symbol:row.symbol,at:row.at,resolved_at:row.resolved_at,
    outcome:row.outcome,target:row.target,
    source_audit_sha256:row.source_audit.raw_klines_sha256,
    feature_information_cutoff_at:row.feature_information_cutoff_at,
    features:row.features,temporal_sequence:row.temporal_sequence,
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
    validation:assertMinimumClassSupport('validation',split.validation),
    holdout:assertMinimumClassSupport('holdout',split.holdout)
  };
  const eventRows=[...split.validation,...split.holdout];
  if(!eventRows.length)throw new Error('SHARED_EXTERNAL_SCORING_ROWS_EMPTY');
  const training={
    model_source_commit_sha:sourceCommitSha,
    dataset_source_commit_sha:datasetSourceCommitSha,
    dataset_sha256:datasetSha,input_file_sha256:inputFileSha256,
    source_rows:rows.length,training_rows:split.train.length,
    validation_rows:split.validation.length,holdout_rows:split.holdout.length,
    partition_class_support:supports,
    dataset_scope:datasetScope
  };

  // Proper-scoring logistic baseline: same exact train rows, 18 decision features.
  const logisticFit=fitLogisticBaseline(split.train);
  const predictionsByModel={
    LOGISTIC_REGRESSION:predictionRows(eventRows,
      row=>predictLogistic(row.features,logisticFit),{
        sourceCommitSha,modelName:'LOGISTIC_REGRESSION'
      })
  };
  const modelArtifactsByModel={};
  const trainingArtifacts={};
  const unavailable={};

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
      enableRegimeLocalTcnPyramid:true,
      regimeLocalTcnPyramidMaxTrainingSamples:2048,
      regimeLocalTcnPyramidEpochs:Math.max(4,Math.min(6,args.epochs)),
      enableRegimeLocalTcnMultiscale:true,
      regimeLocalTcnMultiscaleMaxTrainingSamples:2048,
      regimeLocalTcnMultiscaleEpochs:Math.max(4,Math.min(6,args.epochs)),
      enableRegimeLocalTcnAttention:true,
      regimeLocalTcnAttentionMaxTrainingSamples:2048,
      regimeLocalTcnAttentionEpochs:Math.max(4,Math.min(6,args.epochs))
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
      passed:true,reason:'FIXED_CONFIG_TRAINED_ON_TRAIN_PARTITION',
      diagnostic_only:false
    },
    DENSE_MLP:{
      passed:true,reason:'FIXED_CONFIG_TRAINED_ON_TRAIN_PARTITION',
      diagnostic_only:false
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
    const scored=predictionAttempt(eventRows,
      row=>predictFourHourCognitiveResearchProbability(row.features,decoded.state),{
        sourceCommitSha,artifactSha256:decoded.artifactSha256,modelName:'COGNITIVE_MLP_V5'
      });
    if(scored.valid){
      modelArtifactsByModel.COGNITIVE_MLP_V5=mlpArtifact;
      predictionsByModel.COGNITIVE_MLP_V5=scored.rows;
      trainingArtifacts.COGNITIVE_MLP_V5={
        artifact_sha256:decoded.artifactSha256,
        internal_status:cognitiveProfile.neural_network?.status??null,
        probability_ready:cognitiveProfile.neural_network?.probability_ready===true,
        diagnostic_only:cognitiveProfile.neural_network?.probability_ready!==true,
        research_inference:decoded.state.research_inference??null,
        training_samples:cognitiveProfile.neural_network?.training_samples??0,
        selected_member_index:cognitiveProfile.neural_network?.selected_member_index??null,
        selected_residual_scale:cognitiveProfile.neural_network?.selected_residual_scale??null,
        best_inner_candidate:cognitiveProfile.neural_network?.inner_selection_diagnostics?.best_candidate??null
      };
    }else unavailable.COGNITIVE_MLP_V5={reason:scored.reason};
  }else unavailable.COGNITIVE_MLP_V5={
    reason:cognitiveProfile.neural_network?.status??'NO_INNER_SELECTED_MLP_ARTIFACT',
    probability_ready:cognitiveProfile.neural_network?.probability_ready===true,
    best_inner_candidate:cognitiveProfile.neural_network?.inner_selection_diagnostics?.best_candidate??null,
    member_selection_scores:cognitiveProfile.neural_network?.member_selection_brier_scores??[]
  };

  const hybridMlpArtifact=cognitiveArtifacts.MLP_GBDT_HYBRID;
  if(hybridMlpArtifact){
    const decoded=decodeArtifactState(hybridMlpArtifact,'MLP_GBDT_HYBRID',sourceCommitSha);
    const scored=predictionAttempt(eventRows,
      row=>predictFourHourCognitiveChallengerProbability(row.features,decoded.state.fit),{
        sourceCommitSha,artifactSha256:decoded.artifactSha256,modelName:'MLP_GBDT_HYBRID'
      });
    if(scored.valid){
      modelArtifactsByModel.MLP_GBDT_HYBRID=hybridMlpArtifact;
      predictionsByModel.MLP_GBDT_HYBRID=scored.rows;
      trainingArtifacts.MLP_GBDT_HYBRID={artifact_sha256:decoded.artifactSha256,
        internal_status:cognitiveProfile.hybrid_model?.status??null,
        boosted_weight:cognitiveProfile.hybrid_model?.boosted_weight??null};
    }else unavailable.MLP_GBDT_HYBRID={reason:scored.reason};
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
    temporal_pooling:temporalProfile?.temporal_pooling??null,
    requested_max_training_samples:4096,
    status:temporalProfile?.status??null,
    probability_ready:temporalProfile?.probability_ready===true,
    supported_regimes:temporalProfile?.supported_regimes??[],
    selected_regimes:temporalProfile?.selected_regimes??[],
    outer_holdout_passed:temporalProfile?.holdout_passed===true,
    regime_specialists:Object.fromEntries(Object.entries(
      temporalProfile?._research_fit?.specialists_by_regime??{}
    ).map(([regime,specialist])=>[regime,{
      selected_member_index:specialist.selected_member_index??null,
      selected_residual_scale:specialist.selected_residual_scale??null,
      diagnostic_member_index:specialist.diagnostic_member_index??null,
      diagnostic_residual_scale:specialist.diagnostic_residual_scale??null,
      selection_scores:specialist.member_selection_scores??[],
      selection_logistic_brier:specialist.member_selection_logistic_brier??null,
      validation_passed:specialist.validation_passed===true,
      holdout_passed:specialist.holdout_passed===true
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
    pooled_fallback:{status:attentionPooledFallback.status??'NOT_TRAINED',
      trained:attentionPooledFallback.trained===true,
      selection_passed:attentionPooledFallback.selection_passed===true,
      validation_passed:attentionPooledFallback.validation_passed===true,
      holdout_passed:attentionPooledFallback.holdout_passed===true,
      training_samples:attentionPooledFallback.training_samples??0,
      selection_samples:attentionPooledFallback.selection_samples??0,
      calibration_samples:attentionPooledFallback.calibration_samples??0},
    pooled_fallback_qualified:attentionPooledQualified,
    both_regime_specialists_qualified:bothAttentionRegimesQualified
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
      validation:profile?.validation??null,
      validation_logistic:profile?.validation_logistic??null,
      holdout:profile?.holdout??null,
      holdout_logistic:profile?.holdout_logistic??null,
      both_btc_regimes_inner_qualified:bothRegimesSelected
    };
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

  if(temporalProfile?._research_fit&&v8Coverage.complete){
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
      reason:'TCN_V8_MISSING_REGIME_INFERENCE_STATE:'+v8Coverage.missing_regimes.join(','),
      inference_regimes:v8Coverage.available_regimes,
      missing_regimes:v8Coverage.missing_regimes,
      diagnostic_regimes:training.model_internal_diagnostics.TCN_V8.regime_specialists
    };
  }else unavailable.TCN_V8={
    reason:temporalProfile?.status??'TEMPORAL_RESEARCH_FIT_NOT_AVAILABLE'
  };

  if((attentionInferenceRegimes.length>0||attentionPooledStateUsable)&&missingAttentionRegimes.length===0){
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
      reason:missingAttentionRegimes.length
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
      temporal_sequence_timestamps:row.temporal_sequence_timestamps
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
        const selection=selectTcnLstmHybridHyperparameters(trainingRows,selectionRows,{
          requiredImprovement:0.00025,
          maxTrainingSamples:2048,
          seed:22429,
          candidates:[
            {name:'4H_LR_0015_L2_0005_DROP00',learningRate:0.0015,l2:0.0005,dropout:0,epochs:4},
            {name:'4H_LR_0025_L2_0015_DROP10',learningRate:0.0025,l2:0.0015,dropout:0.10,epochs:4},
            {name:'4H_LR_0035_L2_0035_DROP20',learningRate:0.0035,l2:0.0035,dropout:0.20,epochs:4}
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
          max_training_samples:2048,
          effective_training_rows:selection.effective_training_rows??null,
          diagnostic_fit_available:selection.diagnostic_fit!==null&&selection.diagnostic_fit!==undefined,
          diagnostic_configuration:selection.diagnostic_configuration??null,
          required_inner_brier_improvement:0.00025,
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
        if(selectedFit!==null&&calibrator.fitted===true){
          const artifact=makeArtifact({
            name:'RADARX_TCN_LSTM_HYBRID_FIRST_TOUCH_4H',
            family:'TCN_LSTM_HYBRID',version:'TCN_LSTM_ATTENTION_FIRST_TOUCH_4H_V1',
            sourceCommitSha,
            featureSchemaId:'RADARX_TEMPORAL_TCN_LSTM_ATTENTION_SEQUENCE_24X29_V1',
            featureNames:temporalNames,
            normalization:{mean:temporalNames.map(()=>0),std:temporalNames.map(()=>1)},
            modelState:{
              schema:'RADARX_TCN_LSTM_FOUR_HOUR_MODEL_STATE_V1',
              architecture:'CAUSAL_DILATED_TCN_UNIDIRECTIONAL_LSTM_SINGLE_HEAD_TEMPORAL_ATTENTION_V1',
              input_shape:[TCN_LSTM_STEPS,TCN_LSTM_INPUT_CHANNELS],
              fit:selectedFit,calibrator,
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
          modelArtifactsByModel.TCN_LSTM_HYBRID=artifact;
          predictionsByModel.TCN_LSTM_HYBRID=scored.rows;
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
            logistic_selection_brier:selection.baseline?.selection_brier??null,
            internal_calibrator:calibrator.method,
            scored_external_rows:eventRows.length,
            inference_mode:innerQualified?'INNER_SELECTED':'INNER_BEST_DIAGNOSTIC_ONLY',
            inner_selection_qualified:innerQualified,
            diagnostic_only:!innerQualified
          };
        }else{
          unavailable.TCN_LSTM_HYBRID={
            reason:selectedFit===null
              ?'NO_SELECTED_OR_DIAGNOSTIC_TCN_LSTM_FIT'
              :'TCN_LSTM_INTERNAL_CALIBRATION_SUPPORT_NOT_MET',
            inner_qualification_passed:innerQualified,
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

  // Hybrid TCN+Attention: train only on the shared train partition.
  let hybridFit=null;
  try{
    hybridFit=trainHybridTcnAttention(split.train,{
      epochs:args.epochs,targetDefinition:NEURAL_CLOSURE_TARGET_DEFINITION
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
    predictionsByModel.HYBRID_TCN_ATTENTION=predictionRows(eventRows,
      row=>predictHybridTcnAttention(row.temporal_sequence,hybridFit)?.probability,{
        sourceCommitSha,artifactSha256:hybridArtifact.artifact_sha256,
        modelName:'HYBRID_TCN_ATTENTION'
      });
    trainingArtifacts.HYBRID_TCN_ATTENTION={
      artifact_sha256:hybridArtifact.artifact_sha256,
      architecture:hybridFit.architecture,
      training_samples:hybridFit.training_samples,
      epochs:hybridFit.epochs,
      memory_profile:hybridFit.memory_profile
    };
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
  predictionsByModel.DENSE_MLP=predictionRows(eventRows,
    row=>predictDenseProjectionProbability(denseRowsById.get(row.id)?.vector,denseFit),{
      sourceCommitSha,artifactSha256:denseArtifact.artifact_sha256,modelName:'DENSE_MLP'
    });
  trainingArtifacts.DENSE_MLP={
    artifact_sha256:denseArtifact.artifact_sha256,
    training_rows:denseFit.training_rows,
    training_positives:denseFit.training_positives,
    training_negatives:denseFit.training_negatives,
    best_epoch:denseFit.best_epoch,
    early_stopping:denseFit.early_stopping,
    validation_split_rows:denseSplit.validation.length,
    holdout_split_rows:denseSplit.holdout.length
  };

  qualificationByModel.HYBRID_TCN_ATTENTION={
    passed:trainingArtifacts.HYBRID_TCN_ATTENTION!==undefined,
    reason:trainingArtifacts.HYBRID_TCN_ATTENTION
      ?'FIXED_CONFIG_TRAINED_ON_TRAIN_PARTITION'
      :unavailable.HYBRID_TCN_ATTENTION?.reason??'HYBRID_TCN_TRAINING_UNAVAILABLE',
    diagnostic_only:false
  };
  qualificationByModel.DENSE_MLP={
    passed:trainingArtifacts.DENSE_MLP!==undefined,
    reason:trainingArtifacts.DENSE_MLP
      ?'FIXED_CONFIG_TRAINED_ON_TRAIN_PARTITION'
      :'DENSE_MLP_TRAINING_UNAVAILABLE',
    diagnostic_only:false
  };
  const benchmark=runNeuralClosureBenchmark({
    rows,predictionsByModel,modelArtifactsByModel,sourceCommitSha,
    qualificationByModel,
    minimumClassSupport:NEURAL_CLOSURE_MIN_CLASS_SUPPORT,
    roundTripCostBps:args.roundTripCostBps,
    minimumHoldoutTrades:args.minimumHoldoutTrades,
    minimumWinRatePct:args.minimumWinRatePct,
    maximumDrawdownPct:args.maximumDrawdownPct
  });
  const evaluated=Object.entries(benchmark.models).map(([name,model])=>({
    model:name,status:model.status,
    validation_brier:model.validation?.calibrated_brier_score??null,
    validation:model.validation?{
      sample_count:model.validation.sample_count??null,
      positive_count:model.validation.positive_count??null,
      negative_count:model.validation.negative_count??null,
      raw_brier_score:model.validation.raw_brier_score??null,
      calibrated_brier_score:model.validation.calibrated_brier_score??null,
      threshold_selection_sample_count:model.validation.threshold_selection_sample_count??0,
      threshold_selection_positive_count:model.validation.threshold_selection_positive_count??0,
      threshold_selection_negative_count:model.validation.threshold_selection_negative_count??0,
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
  const report={
    schema:MODEL_SCHEMA,
    status:benchmark.status,
    integrity:{
      model_source_commit_sha:sourceCommitSha,
      dataset_source_commit_sha:datasetSourceCommitSha,
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
