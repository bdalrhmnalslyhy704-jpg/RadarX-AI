import {createHash} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';

import {
  buildTcnLstmFlattenedFeatures,
  predictTcnLstmHybridExecutionHeads,
  predictTcnLstmHybridRankingScore,
  buildTcnLstmExecutionHeadInputFeatures,
  predictTcnLstmHybridProbability
} from './temporal-lstm-hybrid.mjs';
import {
  predictTemporalLogisticProbability,
  predictCrossFittedCalibratedTemporalLogisticProbability
} from './temporal-logistic-baseline.mjs';
import {
  verifyOrderedTemporalRankerArtifact,
  predictOrderedTemporalRankerArtifact
} from './ordered-temporal-ranker-artifact.mjs';
import {
  verifyHurdleV2Artifact,
  predictHurdleV2ArtifactHead
} from './hurdle-v2-artifact-contract.mjs';

export const HURDLE_V2_RUNTIME_BUNDLE_SCHEMA =
  'RADARX_BUILD224_HURDLE_V2_COMPLETE_INFERENCE_RUNTIME_BUNDLE_V2';

const HEX_40=/^[a-f0-9]{40}$/i;
const HEX_64=/^[a-f0-9]{64}$/i;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const canonical=value=>{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')
    return '{'+Object.keys(value).sort().map(key=>
      JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
};
const hash=value=>createHash('sha256').update(Buffer.from(canonical(value),'utf8')).digest('hex');
const fail=reason=>({valid:false,reason});
const logit=p=>Math.log(Math.max(1e-9,Math.min(1-1e-9,p))/
  (1-Math.max(1e-9,Math.min(1-1e-9,p))));

function orderedRankerAnchorMatches(profile,artifact){
  const model=profile?.model,parameters=artifact?.parameters;
  const modelWeights=model?.orderedRankingAnchorWeights;
  const modelMeans=model?.orderedRankingAnchorFeatureMean;
  const modelStds=model?.orderedRankingAnchorFeatureStd;
  const artifactWeights=parameters?.anchor_weights;
  const artifactMeans=parameters?.anchor_feature_mean;
  const artifactStds=parameters?.anchor_feature_std;
  if(!Array.isArray(modelWeights)||modelWeights.length!==696||
    !Array.isArray(modelMeans)||modelMeans.length!==696||
    !Array.isArray(modelStds)||modelStds.length!==696||
    !Array.isArray(artifactWeights)||artifactWeights.length!==696||
    !Array.isArray(artifactMeans)||artifactMeans.length!==696||
    !Array.isArray(artifactStds)||artifactStds.length!==696||
    [...modelWeights,...modelMeans,...modelStds,...artifactWeights,...artifactMeans,...artifactStds]
      .some(value=>!finite(value))||
    modelStds.some(value=>value<=0)||artifactStds.some(value=>value<=0)||
    !finite(model?.orderedRankingAnchorBias)||!finite(parameters?.anchor_bias))
    return false;
  return canonical(modelWeights)===canonical(artifactWeights)&&
    canonical(modelMeans)===canonical(artifactMeans)&&
    canonical(modelStds)===canonical(artifactStds)&&
    Number(model.orderedRankingAnchorBias)===Number(parameters.anchor_bias);
}

function manifestFrom(core){
  const profile=core.inference_profile;
  const ranker=core.dependencies.ordered_ranker;
  const hurdle=core.dependencies.hurdle_v2;
  return {
    schema:'RADARX_BUILD224_HURDLE_V2_RUNTIME_DEPENDENCY_MANIFEST_V2',
    bundle_schema:core.schema,
    code_commit_sha:core.provenance.code_commit_sha,
    dataset_sha256:core.provenance.dataset_sha256,
    input_file_sha256:core.provenance.input_file_sha256,
    dataset_source_commit_sha:core.provenance.dataset_source_commit_sha,
    dataset_row_count:core.provenance.dataset_row_count,
    round_trip_cost_bps:core.provenance.round_trip_cost_bps,
    tcn_lstm_profile_sha256:hash(profile),
    tcn_lstm_model_sha256:hash(profile.model),
    logistic_anchor_sha256:hash(profile.baseline_fit),
    temporal_logistic_cv_sha256:hash(profile.execution_logistic_context_model),
    temporal_logistic_metadata_sha256:hash(profile.execution_logistic_context_metadata),
    ordered_ranker_content_sha256:ranker.artifact_content_hash,
    ordered_ranker_manifest_sha256:ranker.artifact_manifest_hash,
    hurdle_content_sha256:hurdle.artifact_content_hash,
    hurdle_manifest_sha256:hurdle.artifact_manifest_hash,
    probe_sequence_sha256:hash(core.probe.sequence),
    probe_sequence_shape:[core.probe.sequence.length,
      core.probe.sequence[0]?.length??0],
    holdout_status:'LOCKED',
    outer_validation_opened:false,
    holdout_values_used:false,
    real_order_execution:false
  };
}

export function createHurdleV2RuntimeBundle({
  profile,rankerArtifact,hurdleArtifact,provenance,probeSequence
}={}){
  if(!profile||typeof profile!=='object'||!profile.model||!profile.baseline_fit)
    throw new TypeError('HURDLE_V2_RUNTIME_PROFILE_REQUIRED');
  if(profile.model.executionRegressionHeadsFitted!==true||
    profile.model.executionHeadInputFeatureSchema!==
      'RADARX_TCN_LSTM_EXECUTION_HEAD_POOLED_SCORE_GATED_BY_MATCHED_FULL_SEQUENCE_LOGISTIC_CV_OOF_CLASSIFIER_AND_INDEPENDENT_RANK_SCORE_V8')
    throw new TypeError('HURDLE_V2_RUNTIME_TCN_LSTM_EXECUTION_HEAD_CONTRACT_INVALID');
  if(profile.model.executionHurdleReturnHeads?.LOGIT_CONTEXT_AUGMENTED?.fitted!==true||
    profile.model.executionHurdleReturnHeads?.POOLED_ONLY?.fitted!==true)
    throw new TypeError('HURDLE_V2_RUNTIME_HURDLE_HEADS_MISSING');
  const logisticMetadata=profile.execution_logistic_context_metadata;
  const temporalLogistic=profile.execution_logistic_context_model;
  if(logisticMetadata?.status!=='AVAILABLE'||
    logisticMetadata?.logistic_cv_schema!==
      'RADARX_TRAIN_ONLY_PURGED_EXPANDING_LOGISTIC_CV_V2'||
    logisticMetadata?.logistic_feature_schema_id!==
      'RADARX_TCN_LSTM_LOGISTIC_FULL_ORDERED_SEQUENCE_24X29_696_V1'||
    logisticMetadata?.predictions_are_out_of_sample_for_scoring_rows!==true||
    logisticMetadata?.training_predictions_are_out_of_fold!==true||
    logisticMetadata?.training_predictions_source_partition!==
      'PURGED_EXPANDING_TRAIN_ONLY_OOF_FOLDS'||
    logisticMetadata?.classifier_training_baseline_source!==
      'TUNED_FULL_ORDERED_TEMPORAL_LOGISTIC_696_RAW_OOF'||
    logisticMetadata?.validation_or_holdout_used!==false||
    logisticMetadata?.training_prediction_coverage?.outer_validation_or_holdout_used!==false||
    !Number.isInteger(logisticMetadata?.training_prediction_coverage?.oof_scored_rows)||
    logisticMetadata.training_prediction_coverage.oof_scored_rows<20||
    temporalLogistic?.training_partition_only!==true||
    !temporalLogistic?.standardizer||!temporalLogistic?.fit)
    throw new TypeError('HURDLE_V2_RUNTIME_TEMPORAL_LOGISTIC_DEPENDENCY_INVALID');
  if(!Array.isArray(profile.baseline_fit?.weights)||
    profile.baseline_fit.weights.length!==58||
    profile.baseline_fit.weights.some(value=>!finite(value))||
    !finite(profile.baseline_fit.bias))
    throw new TypeError('HURDLE_V2_RUNTIME_LOGISTIC_ANCHOR_DEPENDENCY_INVALID');
  const rankerCheck=verifyOrderedTemporalRankerArtifact(rankerArtifact);
  if(!rankerCheck.valid)
    throw new TypeError('HURDLE_V2_RUNTIME_ORDERED_RANKER_INVALID:'+rankerCheck.reason);
  if(!orderedRankerAnchorMatches(profile,rankerArtifact))
    throw new TypeError('HURDLE_V2_RUNTIME_ORDERED_RANKER_LOGISTIC_ANCHOR_MISMATCH');
  const hurdleCheck=verifyHurdleV2Artifact(hurdleArtifact);
  if(!hurdleCheck.valid)
    throw new TypeError('HURDLE_V2_RUNTIME_HURDLE_ARTIFACT_INVALID:'+hurdleCheck.reason);
  const expectedRanker=hurdleArtifact.upstream_ordered_ranker_dependency;
  if(!expectedRanker||
    expectedRanker.artifact_content_hash!==rankerCheck.content_hash||
    expectedRanker.artifact_manifest_hash!==rankerCheck.manifest_hash)
    throw new TypeError('HURDLE_V2_RUNTIME_RANKER_PIN_MISMATCH');
  const source=String(provenance?.sourceCommitSha??'').toLowerCase();
  const dataset=String(provenance?.datasetSha256??'').toLowerCase();
  const input=String(provenance?.inputFileSha256??'').toLowerCase();
  const datasetSource=String(provenance?.datasetSourceCommitSha??'').toLowerCase();
  if(!HEX_40.test(source)||!HEX_64.test(dataset)||!HEX_64.test(input)||
    !HEX_40.test(datasetSource)||!Number.isInteger(provenance?.datasetRowCount)||
    provenance.datasetRowCount!==32300||provenance.roundTripCostBps!==30)
    throw new TypeError('HURDLE_V2_RUNTIME_PROVENANCE_INVALID');
  for(const [name,artifact] of [['ranker',rankerArtifact],['hurdle',hurdleArtifact]]){
    if(artifact.code_commit_sha!==source||artifact.dataset_sha256!==dataset||
      artifact.input_file_sha256!==input||
      artifact.dataset_source_commit_sha!==datasetSource)
      throw new TypeError('HURDLE_V2_RUNTIME_'+name.toUpperCase()+'_PROVENANCE_MISMATCH');
  }
  if(!Array.isArray(probeSequence)||probeSequence.length!==24||
    probeSequence.some(row=>!Array.isArray(row)||row.length!==29||
      row.some(value=>!finite(value))))
    throw new TypeError('HURDLE_V2_RUNTIME_PROBE_SEQUENCE_INVALID');
  const portableProfile=JSON.parse(JSON.stringify(profile));
  const core={
    schema:HURDLE_V2_RUNTIME_BUNDLE_SCHEMA,
    schema_version:1,
    status:'DEPENDENCIES_PINNED_PENDING_FRESH_PROCESS_PROBE',
    provenance:{
      code_commit_sha:source,dataset_sha256:dataset,
      input_file_sha256:input,dataset_source_commit_sha:datasetSource,
      dataset_row_count:provenance.datasetRowCount,
      round_trip_cost_bps:provenance.roundTripCostBps,
      fit_partition:'FIXED_SHA_OUTER_TRAIN_INTERNAL_TRAIN_ONLY'
    },
    dependencies:{
      tcn_lstm_profile:{
        component:'TCN_LSTM_MODEL_AND_INFERENCE_PROFILE',
        inline_path:'inference_profile',
        content_sha256:hash(portableProfile)
      },
      logistic_anchor:{
        component:'FROZEN_TCN_LOGISTIC_ANCHOR_58',
        inline_path:'inference_profile.baseline_fit',
        content_sha256:hash(portableProfile.baseline_fit)
      },
      temporal_logistic_cv:{
        component:'PURGED_FULL_SEQUENCE_TEMPORAL_LOGISTIC_CV',
        inline_path:'inference_profile.execution_logistic_context_model',
        metadata:portableProfile.execution_logistic_context_metadata,
        content_sha256:hash(portableProfile.execution_logistic_context_model)
      },
      ordered_ranker:{
        component:'INDEPENDENT_RAW_ORDERED_696_RETURN_RANKER',
        artifact_path:'TCN_LSTM_ORDERED_RANKER.json',
        artifact_content_hash:rankerCheck.content_hash,
        artifact_manifest_hash:rankerCheck.manifest_hash,
        feature_schema_id:rankerArtifact.feature_schema_id,
        feature_count:rankerArtifact.feature_count
      },
      hurdle_v2:{
        component:'HURDLE_V2_CONTEXTUAL_AND_POOLED_RETURN_RISK_HEADS',
        artifact_path:'HURDLE_V2.json',
        artifact_content_hash:hurdleCheck.content_hash,
        artifact_manifest_hash:hurdleCheck.manifest_hash,
        contextual_feature_schema_id:hurdleArtifact.input_contract.contextual.feature_schema_id,
        pooled_feature_schema_id:hurdleArtifact.input_contract.pooled.feature_schema_id
      }
    },
    inference_profile:portableProfile,
    probe:{sequence:probeSequence}
  };
  const artifactContentHash=hash(core);
  const manifest=manifestFrom(core);
  return {
    ...core,
    artifact_content_hash:artifactContentHash,
    artifact_manifest:manifest,
    artifact_manifest_hash:hash(manifest),
    hash_status:'HASH_VERIFIED',
    signature_status:'HASH_VERIFIED_ONLY'
  };
}

export function verifyHurdleV2RuntimeBundle(bundle,{rankerArtifact,hurdleArtifact}={}){
  try{
    if(!bundle||bundle.schema!==HURDLE_V2_RUNTIME_BUNDLE_SCHEMA||
      bundle.schema_version!==1)return fail('RUNTIME_BUNDLE_SCHEMA_INVALID');
    const {artifact_content_hash,artifact_manifest,artifact_manifest_hash,
      hash_status,signature_status,...core}=bundle;
    if(hash(core)!==artifact_content_hash)return fail('RUNTIME_BUNDLE_CONTENT_HASH_MISMATCH');
    const expectedManifest=manifestFrom(core);
    if(canonical(expectedManifest)!==canonical(artifact_manifest)||
      hash(expectedManifest)!==artifact_manifest_hash)
      return fail('RUNTIME_BUNDLE_MANIFEST_MISMATCH');
    if(hash_status!=='HASH_VERIFIED'||signature_status!=='HASH_VERIFIED_ONLY')
      return fail('RUNTIME_BUNDLE_INTEGRITY_STATUS_INVALID');
    const profile=bundle.inference_profile;
    if(!profile?.model||!profile?.baseline_fit||
      profile.model.executionRegressionHeadsFitted!==true||
      profile.model.executionHeadInputFeatureSchema!==
       'RADARX_TCN_LSTM_EXECUTION_HEAD_POOLED_SCORE_GATED_BY_MATCHED_FULL_SEQUENCE_LOGISTIC_CV_OOF_CLASSIFIER_AND_INDEPENDENT_RANK_SCORE_V8')
      return fail('RUNTIME_TCN_LSTM_PROFILE_MISSING');
    if(hash(profile)!==bundle.dependencies?.tcn_lstm_profile?.content_sha256||
      hash(profile.model)!==bundle.artifact_manifest?.tcn_lstm_model_sha256||
      hash(profile.baseline_fit)!==bundle.dependencies?.logistic_anchor?.content_sha256||
      hash(profile.execution_logistic_context_model)!==
        bundle.dependencies?.temporal_logistic_cv?.content_sha256||
      hash(profile.execution_logistic_context_metadata)!==
        bundle.artifact_manifest?.temporal_logistic_metadata_sha256)
      return fail('RUNTIME_PROFILE_COMPONENT_HASH_MISMATCH');
    const logisticMetadata=profile.execution_logistic_context_metadata;
    const temporalLogistic=profile.execution_logistic_context_model;
    if(profile.model.executionRegressionHeadsFitted!==true||
      profile.model.executionHeadInputFeatureSchema!==
        'RADARX_TCN_LSTM_EXECUTION_HEAD_POOLED_SCORE_GATED_BY_MATCHED_FULL_SEQUENCE_LOGISTIC_CV_OOF_CLASSIFIER_AND_INDEPENDENT_RANK_SCORE_V8'||
      profile.model.executionHurdleReturnHeads?.LOGIT_CONTEXT_AUGMENTED?.fitted!==true||
      profile.model.executionHurdleReturnHeads?.POOLED_ONLY?.fitted!==true||
      !Array.isArray(profile.baseline_fit?.weights)||
      profile.baseline_fit.weights.length!==58||
      profile.baseline_fit.weights.some(value=>!finite(value))||
      !finite(profile.baseline_fit.bias))
      return fail('RUNTIME_TCN_LSTM_OR_ANCHOR_CONTRACT_INVALID');
    if(logisticMetadata?.status!=='AVAILABLE'||
      logisticMetadata?.logistic_cv_schema!==
        'RADARX_TRAIN_ONLY_PURGED_EXPANDING_LOGISTIC_CV_V2'||
      logisticMetadata?.logistic_feature_schema_id!==
        'RADARX_TCN_LSTM_LOGISTIC_FULL_ORDERED_SEQUENCE_24X29_696_V1'||
      logisticMetadata?.predictions_are_out_of_sample_for_scoring_rows!==true||
      logisticMetadata?.training_predictions_are_out_of_fold!==true||
      logisticMetadata?.training_predictions_source_partition!==
        'PURGED_EXPANDING_TRAIN_ONLY_OOF_FOLDS'||
      logisticMetadata?.classifier_training_baseline_source!==
        'TUNED_FULL_ORDERED_TEMPORAL_LOGISTIC_696_RAW_OOF'||
      logisticMetadata?.validation_or_holdout_used!==false||
      logisticMetadata?.training_prediction_coverage?.outer_validation_or_holdout_used!==false||
      !Number.isInteger(logisticMetadata?.training_prediction_coverage?.oof_scored_rows)||
      logisticMetadata.training_prediction_coverage.oof_scored_rows<20||
      temporalLogistic?.training_partition_only!==true||
      !temporalLogistic?.standardizer||!temporalLogistic?.fit)
      return fail('RUNTIME_TEMPORAL_LOGISTIC_NOT_PINNED');
    if(!rankerArtifact||!hurdleArtifact)
      return fail('RUNTIME_EXTERNAL_ARTIFACTS_MISSING');
    const rankerCheck=verifyOrderedTemporalRankerArtifact(rankerArtifact);
    if(!rankerCheck.valid||
      rankerCheck.content_hash!==bundle.dependencies.ordered_ranker.artifact_content_hash||
      rankerCheck.manifest_hash!==bundle.dependencies.ordered_ranker.artifact_manifest_hash)
      return fail('RUNTIME_ORDERED_RANKER_HASH_OR_CONTRACT_MISMATCH');
    if(!orderedRankerAnchorMatches(profile,rankerArtifact))
      return fail('RUNTIME_ORDERED_RANKER_LOGISTIC_ANCHOR_MISMATCH');
    const hurdleCheck=verifyHurdleV2Artifact(hurdleArtifact);
    if(!hurdleCheck.valid||
      hurdleCheck.content_hash!==bundle.dependencies.hurdle_v2.artifact_content_hash||
      hurdleCheck.manifest_hash!==bundle.dependencies.hurdle_v2.artifact_manifest_hash)
      return fail('RUNTIME_HURDLE_HASH_OR_CONTRACT_MISMATCH');
    if(hurdleArtifact.upstream_ordered_ranker_dependency?.artifact_content_hash!==
        rankerCheck.content_hash||
      hurdleArtifact.upstream_ordered_ranker_dependency?.artifact_manifest_hash!==
        rankerCheck.manifest_hash)
      return fail('RUNTIME_HURDLE_RANKER_DEPENDENCY_MISMATCH');
    if(bundle.provenance?.code_commit_sha!==rankerArtifact.code_commit_sha||
      bundle.provenance?.code_commit_sha!==hurdleArtifact.code_commit_sha||
      bundle.provenance?.dataset_sha256!==rankerArtifact.dataset_sha256||
      bundle.provenance?.dataset_sha256!==hurdleArtifact.dataset_sha256||
      bundle.provenance?.input_file_sha256!==rankerArtifact.input_file_sha256||
      bundle.provenance?.input_file_sha256!==hurdleArtifact.input_file_sha256||
      bundle.provenance?.dataset_source_commit_sha!==rankerArtifact.dataset_source_commit_sha||
      bundle.provenance?.dataset_source_commit_sha!==hurdleArtifact.dataset_source_commit_sha)
      return fail('RUNTIME_PROVENANCE_ALIGNMENT_MISMATCH');
    if(bundle.provenance?.round_trip_cost_bps!==30||
      bundle.provenance?.fit_partition!=='FIXED_SHA_OUTER_TRAIN_INTERNAL_TRAIN_ONLY'||
      bundle.provenance?.holdout_status!=='LOCKED'&&
        bundle.artifact_manifest?.holdout_status!=='LOCKED')
      return fail('RUNTIME_RESEARCH_BOUNDARY_INVALID');
    if(!Array.isArray(bundle.probe?.sequence)||bundle.probe.sequence.length!==24||
      bundle.probe.sequence.some(row=>!Array.isArray(row)||row.length!==29||
        row.some(value=>!finite(value))))
      return fail('RUNTIME_PROBE_SEQUENCE_INVALID');
    return {valid:true,content_hash:artifact_content_hash,
      manifest_hash:artifact_manifest_hash,dependency_count:5};
  }catch(error){
    return fail('RUNTIME_BUNDLE_VALIDATION_ERROR:'+String(error?.message||error));
  }
}

export function runHurdleV2RuntimeCompositionProbe(bundle,{rankerArtifact,hurdleArtifact}={}){
  const verification=verifyHurdleV2RuntimeBundle(bundle,{rankerArtifact,hurdleArtifact});
  if(!verification.valid)throw new TypeError('HURDLE_V2_RUNTIME_BUNDLE_REJECTED:'+verification.reason);
  const profile=bundle.inference_profile;
  const sequence=bundle.probe.sequence;
  const flattened=buildTcnLstmFlattenedFeatures(sequence);
  const temporalRawProbability=predictTemporalLogisticProbability(
    flattened,profile.execution_logistic_context_model);
  const temporalProbability=predictCrossFittedCalibratedTemporalLogisticProbability(
    flattened,profile.execution_logistic_context_model);
  if(!finite(temporalRawProbability)||temporalRawProbability<=0||temporalRawProbability>=1||
    !finite(temporalProbability)||temporalProbability<=0||temporalProbability>=1)
    throw new TypeError('HURDLE_V2_RUNTIME_TEMPORAL_LOGISTIC_PROBE_NON_FINITE');
  const externalLogisticLogit=logit(temporalProbability);
  const classifierBaselineLogit=logit(temporalRawProbability);
  const classificationProbability=predictTcnLstmHybridProbability(sequence,profile);
  const rankerArtifactScore=predictOrderedTemporalRankerArtifact(sequence,rankerArtifact);
  const profileRankerScore=predictTcnLstmHybridRankingScore(sequence,profile);
  const input=buildTcnLstmExecutionHeadInputFeatures(
    sequence,profile.model,profile.baseline_fit,{
      variant:'LOGIT_CONTEXT_AUGMENTED',
      externalLogisticLogit,classifierBaselineLogit
    });
  const execution=predictTcnLstmHybridExecutionHeads(sequence,profile,{
    variant:'LOGIT_CONTEXT_AUGMENTED',externalLogisticLogit
  });
  const hurdleHead=predictHurdleV2ArtifactHead(
    input.features,hurdleArtifact.contextual_head_parameters);
  const pooledInput=buildTcnLstmExecutionHeadInputFeatures(
    sequence,profile.model,profile.baseline_fit,{variant:'POOLED_ONLY'});
  const pooledExecution=predictTcnLstmHybridExecutionHeads(sequence,profile,{
    variant:'POOLED_ONLY'
  });
  const pooledHurdleHead=predictHurdleV2ArtifactHead(
    pooledInput.features,hurdleArtifact.pooled_head_parameters);
  const differences={
    ranker_score:Math.abs(rankerArtifactScore-profileRankerScore),
    contextual_hurdle_expected_net_return_pct:Math.abs(
      Number(hurdleHead.expected_net_return_pct)-
      Number(execution.predicted_hurdle_net_return_pct)),
    contextual_hurdle_positive_probability:Math.abs(
      Number(hurdleHead.probability_positive_net_return)-
      Number(execution.predicted_positive_net_return_probability)),
    pooled_hurdle_expected_net_return_pct:Math.abs(
      Number(pooledHurdleHead.expected_net_return_pct)-
      Number(pooledExecution.predicted_hurdle_net_return_pct)),
    pooled_hurdle_positive_probability:Math.abs(
      Number(pooledHurdleHead.probability_positive_net_return)-
      Number(pooledExecution.predicted_positive_net_return_probability))
  };
  if(!finite(classificationProbability)||classificationProbability<0||
    classificationProbability>1||
    !finite(execution.predicted_net_return_pct)||
    !finite(execution.predicted_hurdle_net_return_pct)||
    !finite(execution.predicted_positive_net_return_probability)||
    !finite(pooledExecution.predicted_net_return_pct)||
    !finite(pooledExecution.predicted_hurdle_net_return_pct)||
    !finite(pooledExecution.predicted_positive_net_return_probability)||
    Object.values(differences).some(value=>!finite(value)||value>1e-8))
    throw new TypeError('HURDLE_V2_RUNTIME_COMPOSITION_PARITY_FAILED');
  return {
    status:'FRESH_PROCESS_COMPOSITION_PROBE_PASSED',
    dependency_count:5,
    raw_temporal_logistic_probability:temporalRawProbability,
    calibrated_temporal_logistic_probability:temporalProbability,
    neural_classifier_probability:classificationProbability,
    independent_ranker_score:rankerArtifactScore,
    contextual_hurdle_expected_net_return_pct:hurdleHead.expected_net_return_pct,
    contextual_hurdle_positive_net_return_probability:hurdleHead.probability_positive_net_return,
    pooled_hurdle_expected_net_return_pct:pooledHurdleHead.expected_net_return_pct,
    pooled_hurdle_positive_net_return_probability:pooledHurdleHead.probability_positive_net_return,
    parity_max_abs_error:differences,
    labels_read:0,outer_validation_rows_read:0,holdout_rows_read:0,
    outer_validation_opened:false,holdout_opened:false,
    paper_trading:true,real_order_execution:false
  };
}

async function atomicJson(path,value){
  await mkdir(dirname(path),{recursive:true});
  const temp=path+'.tmp-'+process.pid;
  await writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  await rename(temp,path);
}

export async function writeHurdleV2RuntimeBundleAtomic(directory,bundle){
  const bundlePath=join(directory,'HURDLE_V2_RUNTIME_BUNDLE.json');
  const manifestPath=join(directory,'HURDLE_V2_RUNTIME_BUNDLE.manifest.json');
  await mkdir(directory,{recursive:true});
  const before=verifyHurdleV2RuntimeBundle(bundle,{
    rankerArtifact:JSON.parse(await readFile(join(directory,'TCN_LSTM_ORDERED_RANKER.json'),'utf8')),
    hurdleArtifact:JSON.parse(await readFile(join(directory,'HURDLE_V2.json'),'utf8'))
  });
  if(!before.valid)throw new Error('HURDLE_V2_RUNTIME_BUNDLE_EXPORT_REJECTED:'+before.reason);
  await atomicJson(bundlePath,bundle);
  await atomicJson(manifestPath,bundle.artifact_manifest);
  const restored=JSON.parse(await readFile(bundlePath,'utf8'));
  if(!verifyHurdleV2RuntimeBundle(restored,{
    rankerArtifact:JSON.parse(await readFile(join(directory,'TCN_LSTM_ORDERED_RANKER.json'),'utf8')),
    hurdleArtifact:JSON.parse(await readFile(join(directory,'HURDLE_V2.json'),'utf8'))
  }).valid)throw new Error('HURDLE_V2_RUNTIME_BUNDLE_DISK_RELOAD_FAILED');
  const manifestOnDisk=JSON.parse(await readFile(manifestPath,'utf8'));
  if(canonical(manifestOnDisk)!==canonical(bundle.artifact_manifest))
    throw new Error('HURDLE_V2_RUNTIME_BUNDLE_MANIFEST_RELOAD_FAILED');
  const moduleUrl=new URL('./hurdle-v2-runtime-bundle.mjs',import.meta.url).href;
  const childSource=[
    "import {readFile} from 'node:fs/promises';",
    "import {dirname,join} from 'node:path';",
    "import {verifyHurdleV2RuntimeBundle,runHurdleV2RuntimeCompositionProbe} from "+JSON.stringify(moduleUrl)+";",
    "const path=process.argv[1];",
    "const dir=dirname(path);",
    "const bundle=JSON.parse(await readFile(path,'utf8'));",
    "const ranker=JSON.parse(await readFile(join(dir,'TCN_LSTM_ORDERED_RANKER.json'),'utf8'));",
    "const hurdle=JSON.parse(await readFile(join(dir,'HURDLE_V2.json'),'utf8'));",
    "const verification=verifyHurdleV2RuntimeBundle(bundle,{rankerArtifact:ranker,hurdleArtifact:hurdle});",
    "if(!verification.valid) throw new Error(verification.reason);",
    "const probe=runHurdleV2RuntimeCompositionProbe(bundle,{rankerArtifact:ranker,hurdleArtifact:hurdle});",
    "console.log(JSON.stringify({verification,probe}));"
  ].join('\n');
  const child=spawnSync(process.execPath,['--input-type=module','-e',childSource,bundlePath],{
    encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024
  });
  if(child.error||child.status!==0)
    throw new Error('HURDLE_V2_RUNTIME_FRESH_PROCESS_PROBE_FAILED:'+
      String(child.error?.message||child.stderr||child.status));
  const fresh=JSON.parse(child.stdout.trim());
  if(fresh.probe?.status!=='FRESH_PROCESS_COMPOSITION_PROBE_PASSED')
    throw new Error('HURDLE_V2_RUNTIME_FRESH_PROCESS_PROBE_STATUS_INVALID');
  return {
    status:'EXPORTED_AND_FRESH_PROCESS_COMPOSITION_VERIFIED',
    bundle_path:bundlePath,manifest_path:manifestPath,
    artifact_content_hash:bundle.artifact_content_hash,
    artifact_manifest_hash:bundle.artifact_manifest_hash,
    artifact_bytes:Buffer.byteLength(JSON.stringify(bundle,null,2)+'\n'),
    dependency_count:5,fresh_process_probe:fresh.probe
  };
}
