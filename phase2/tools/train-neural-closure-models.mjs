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
  runNeuralClosureBenchmark,sha256Canonical
} from '../core/neural-closure-contracts.mjs';
import {
  buildFourHourCognitiveLearningProfile,buildCognitiveFeatureVector,
  predictFourHourCognitiveResearchProbability,
  predictFourHourCognitiveChallengerProbability,
  COGNITIVE_FEATURE_SCHEMA,COGNITIVE_FEATURE_NAMES
} from '../core/cognitive-brain.mjs';
import {
  buildFourHourTemporalNeuralProfile,predictTemporalResearchOutput,
  TEMPORAL_SEQUENCE_CHANNELS
} from '../core/temporal-neural-brain.mjs';
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
const MODEL_SCHEMA='RADARX_BUILD224_NEURAL_MODEL_TRAINING_V2';

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
  const inputBytes=await readFile(inputPath);
  const inputFileSha256=sha256(inputBytes);
  const input=JSON.parse(inputBytes.toString('utf8'));
  if(input?.schema!==NEURAL_CLOSURE_DATASET_SCHEMA||!Array.isArray(input.rows))
    throw new Error('NEURAL_CLOSURE_DATASET_SCHEMA_INVALID');
  const rows=validateFourHourRows(input.rows);
  const datasetSha=sha256Canonical(rows.map(row=>({
    id:row.id,symbol:row.symbol,at:row.at,resolved_at:row.resolved_at,
    outcome:row.outcome,target:row.target,
    source_audit_sha256:row.source_audit.raw_klines_sha256,
    feature_information_cutoff_at:row.feature_information_cutoff_at,
    features:row.features,temporal_sequence:row.temporal_sequence,
    realized_return_pct:row.realized_return_pct
  })));
  if(datasetSha!==input.dataset_sha256)
    throw new Error('NEURAL_CLOSURE_DATASET_CANONICAL_SHA_MISMATCH');
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
  const training={
    model_source_commit_sha:sourceCommitSha,
    dataset_source_commit_sha:input.source_commit_sha??null,
    dataset_sha256:datasetSha,input_file_sha256:inputFileSha256,
    source_rows:rows.length,training_rows:split.train.length,
    validation_rows:split.validation.length,holdout_rows:split.holdout.length,
    dataset_scope:datasetScope,
    partition_class_support:supports
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
      minimumValidationSamples:80,
      minimumHoldoutSamples:80,
      liveHoldoutSamples:100,
      epochs:Math.max(4,Math.min(10,args.epochs)),
      enableTemporalBoostedTree:true
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
      inner_selection_diagnostics:cognitiveProfile.neural_network?.inner_selection_diagnostics??null,
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
  qualificationByModel.TCN_V11={
    passed:temporalProfile?.probability_ready===true,
    reason:temporalProfile?.status??'TCN_NOT_SELECTED',
    diagnostic_only:temporalProfile?.probability_ready!==true
  };
  training.model_internal_diagnostics.TCN_V11={
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
      selection_logistic_ranking_metrics:specialist.member_selection_logistic_ranking_metrics??null,
      validation_passed:specialist.validation_passed===true,
      holdout_passed:specialist.holdout_passed===true
    }]))
  };
  if(temporalProfile?._research_fit){
    const temporalNames=Array.from({length:TEMPORAL_SEQUENCE_CHANNELS},(_,index)=>
      'temporal_channel_'+String(index).padStart(2,'0'));
    const tcnArtifact=makeArtifact({
      name:'RADARX_TCN_V11_FIRST_TOUCH_4H',
      family:'TCN_V11',version:'TCN_V11_FIRST_TOUCH_4H_V2',
      sourceCommitSha,featureSchemaId:'RADARX_TEMPORAL_TCN_SEQUENCE_24X29_V2',
      featureNames:temporalNames,
      normalization:{mean:temporalNames.map(()=>0),std:temporalNames.map(()=>1)},
      modelState:{fit:temporalProfile._research_fit,
        selected_regimes:temporalProfile.selected_regimes??[],
        model_architecture:temporalProfile.model_architecture??null}
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
          sourceCommitSha,artifactSha256:tcnArtifact.artifact_sha256,modelName:'TCN_V11'
        });
      if(scored.valid){
        modelArtifactsByModel.TCN_V11=tcnArtifact;
        predictionsByModel.TCN_V11=scored.rows;
        trainingArtifacts.TCN_V11={
          artifact_sha256:tcnArtifact.artifact_sha256,
          probability_ready:temporalProfile.probability_ready===true,
          diagnostic_only:temporalProfile.probability_ready!==true,
          research_output_modes:researchOutputModes,
          internal_status:temporalProfile.status??null,
          selected_regimes:temporalProfile.selected_regimes??[],
          holdout_passed:temporalProfile.holdout_passed===true
        };
      }else unavailable.TCN_V11={
      reason:scored.reason,
      diagnostic_regimes:training.model_internal_diagnostics.TCN_V11.regime_specialists
    };
    }else unavailable.TCN_V11={reason:'ARTIFACT_VERIFICATION_FAILED:'+verified.reason};
  }else unavailable.TCN_V11={
    reason:temporalProfile?.status??'TEMPORAL_RESEARCH_FIT_NOT_AVAILABLE'
  };

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
    calibration_status:model.calibration?.status??null,
    brier:model.holdout?.brier_score??null,
    logistic_brier:benchmark.models.LOGISTIC_REGRESSION?.holdout?.brier_score??null,
    net_pnl_pct:model.holdout?.net_pnl_pct??null,
    max_drawdown_pct:model.holdout?.max_drawdown_pct??null,
    trades:model.holdout?.trade_count??null,
    acceptance:model.acceptance?.status??'NOT_EVALUATED',
    acceptance_gates:model.acceptance?.gates??null,
    inner_qualification:model.acceptance?.inner_qualification??null
  }));
  const report={
    schema:MODEL_SCHEMA,
    status:benchmark.status,
    integrity:{
      model_source_commit_sha:sourceCommitSha,
      dataset_source_commit_sha:input.source_commit_sha??null,
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
    dataset_scope:datasetScope,
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
