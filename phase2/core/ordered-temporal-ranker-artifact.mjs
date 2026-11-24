import {createHash} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {
  buildTcnLstmFlattenedFeatures,
  TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT,
  TCN_LSTM_ORDERED_RANKING_FEATURE_SCHEMA_ID,
  TCN_LSTM_STEPS,
  TCN_LSTM_INPUT_CHANNELS
} from './temporal-lstm-hybrid.mjs';

export const ORDERED_TEMPORAL_RANKER_ARTIFACT_SCHEMA =
  'RADARX_TCN_LSTM_ORDERED_TEMPORAL_RANKER_ARTIFACT_V1';

const HEX_40=/^[a-f0-9]{40}$/;
const HEX_64=/^[a-f0-9]{64}$/;
const finite=value=>typeof value==='number'&&Number.isFinite(value);

function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')
    return '{'+Object.keys(value).sort().map(key=>
      JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
function hashObject(value){
  return createHash('sha256').update(Buffer.from(canonical(value),'utf8')).digest('hex');
}
function fail(reason){return {valid:false,reason};}
function manifestFrom(core,contentHash){
  return {
    schema:'RADARX_TCN_LSTM_ORDERED_TEMPORAL_RANKER_MANIFEST_V1',
    artifact_schema:core.artifact_schema,
    artifact_content_hash:contentHash,
    code_commit_sha:core.code_commit_sha,
    dataset_sha256:core.dataset_sha256,
    input_file_sha256:core.input_file_sha256,
    dataset_source_commit_sha:core.dataset_source_commit_sha,
    feature_schema_id:core.feature_schema_id,
    feature_count:core.feature_count,
    feature_names_sha256:hashObject(core.feature_names),
    ranker_training_config_sha256:hashObject(core.training_provenance.ranker_training_config),
    internal_training_validation_sha256:
      hashObject(core.training_provenance.internal_training_validation),
    fit_partition:core.training_provenance.fit_partition,
    feature_scoring_partition:core.training_provenance.feature_scoring_partition,
    holdout_status:core.holdout_status,
    validation_or_holdout_used:core.training_provenance.validation_or_holdout_used
  };
}
function finalize(core){
  const contentHash=hashObject(core);
  const manifest=manifestFrom(core,contentHash);
  return {
    ...core,
    artifact_content_hash:contentHash,
    artifact_manifest:manifest,
    artifact_manifest_hash:hashObject(manifest),
    hash_status:'HASH_VERIFIED',
    signature_status:'HASH_VERIFIED_ONLY'
  };
}

export function verifyOrderedTemporalRankerArtifact(artifact){
  try{
    if(!artifact||artifact.artifact_schema!==ORDERED_TEMPORAL_RANKER_ARTIFACT_SCHEMA||
      artifact.artifact_schema_version!==1)
      return fail('ORDERED_RANKER_ARTIFACT_SCHEMA_INVALID');
    if(!HEX_40.test(String(artifact.code_commit_sha??''))||
      !HEX_40.test(String(artifact.dataset_source_commit_sha??''))||
      !HEX_64.test(String(artifact.dataset_sha256??''))||
      !HEX_64.test(String(artifact.input_file_sha256??'')))
      return fail('ORDERED_RANKER_PROVENANCE_SHA_INVALID');
    if(artifact.representation!=='RAW_ORDERED_696_V1'||
      artifact.feature_schema_id!==TCN_LSTM_ORDERED_RANKING_FEATURE_SCHEMA_ID||
      !Array.isArray(artifact.feature_names)||
      artifact.feature_names.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      artifact.feature_names.some(name=>typeof name!=='string'||!name.trim())||
      new Set(artifact.feature_names).size!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      artifact.feature_count!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      artifact.input_shape?.[0]!==TCN_LSTM_STEPS||
      artifact.input_shape?.[1]!==TCN_LSTM_INPUT_CHANNELS)
      return fail('ORDERED_RANKER_FEATURE_CONTRACT_INVALID');
    const parameters=artifact.parameters;
    if(!Array.isArray(parameters?.weights)||parameters.weights.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      parameters.weights.some(value=>!finite(value))||
      !Array.isArray(parameters?.feature_mean)||parameters.feature_mean.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      parameters.feature_mean.some(value=>!finite(value))||
      !Array.isArray(parameters?.feature_std)||parameters.feature_std.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      parameters.feature_std.some(value=>!finite(value)||value<=0))
      return fail('ORDERED_RANKER_PARAMETER_SHAPE_OR_VALUE_INVALID');
    const training=artifact.training_provenance;
    const contract=training?.downstream_feature_contract;
    const tuning=training?.internal_training_validation;
    const trainingConfig=training?.ranker_training_config;
    const tuningGrid=tuning?.candidate_grid;
    const selectedTuningCandidate=Array.isArray(tuningGrid)
      ?tuningGrid.find(item=>item?.l2===tuning?.selected_l2&&
        item?.best_epoch===tuning?.selected_epochs&&
        item?.best_validation_pairwise_log_loss===tuning?.selected_validation_pairwise_log_loss)
      :null;
    const tuningMinimumLoss=Array.isArray(tuningGrid)&&tuningGrid.length
      ?Math.min(...tuningGrid.map(item=>Number(item?.best_validation_pairwise_log_loss))):NaN;
    if(training?.fit_partition!=='TRAINING_PARTITION_ONLY'||
      training?.source_partition!=='PRE_EXECUTION_MODEL_TRAINING_PARTITION'||
      training?.feature_scoring_partition!=='PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK'||
      training?.standardizer_fit_partition!=='TRAINING_PARTITION_ONLY'||
      !Number.isInteger(training?.training_rows)||training.training_rows<20||
      training?.standardizer_fit_rows!==training.training_rows||
      !Number.isInteger(training?.training_pairs)||training.training_pairs<10||
      !trainingConfig||!finite(trainingConfig.learning_rate)||trainingConfig.learning_rate<=0||
      !finite(trainingConfig.l2)||trainingConfig.l2<0||trainingConfig.l2>1||
      !Number.isInteger(trainingConfig.epochs_requested)||trainingConfig.epochs_requested<1||
      !Number.isInteger(trainingConfig.epochs_completed)||trainingConfig.epochs_completed<1||
      !Number.isInteger(trainingConfig.best_epoch)||trainingConfig.best_epoch<1||
      trainingConfig.best_epoch>trainingConfig.epochs_requested||
      !Number.isInteger(trainingConfig.patience)||trainingConfig.patience<1||
      trainingConfig.selection_metric!=='PURGED_INTERNAL_TRAINING_VALIDATION_PAIRWISE_LOG_LOSS'||
      tuning?.schema!=='RADARX_TCN_LSTM_ORDERED_RANKER_INTERNAL_PURGED_TRAINING_VALIDATION_V1'||
      tuning?.source_partition!=='PRE_EXECUTION_MODEL_TRAINING_PARTITION_ONLY'||
      tuning?.fit_partition!=='EARLIER_SUBSET_OF_PRE_EXECUTION_MODEL_TRAINING_PARTITION'||
      tuning?.validation_partition!=='LATER_PURGED_SUBSET_OF_PRE_EXECUTION_MODEL_TRAINING_PARTITION'||
      tuning?.outer_validation_or_holdout_used!==false||
      tuning?.model_selection_partition_used!==false||
      tuning?.chronology_valid!==true||
      !finite(tuning?.purge_horizon_ms)||tuning.purge_horizon_ms<4*60*60*1000||
      !finite(tuning?.tuning_max_resolved_at)||
      !finite(tuning?.tuning_max_at)||
      !finite(tuning?.validation_min_at)||
      tuning.validation_min_at<=tuning.tuning_max_resolved_at||
      !finite(tuning?.purge_gap_ms)||tuning.purge_gap_ms<tuning.purge_horizon_ms||
      !Number.isInteger(tuning?.tuning_rows)||tuning.tuning_rows<20||
      !Number.isInteger(tuning?.validation_rows)||tuning.validation_rows<20||
      !Number.isInteger(tuning?.purged_rows)||tuning.purged_rows<0||
      !Number.isInteger(tuning?.tuning_pairs)||tuning.tuning_pairs<10||
      !Number.isInteger(tuning?.validation_pairs)||tuning.validation_pairs<10||
      !Array.isArray(tuningGrid)||tuningGrid.length<2||
      tuningGrid.some(item=>!finite(item?.l2)||item.l2<0||item.l2>1||
        !Number.isInteger(item?.best_epoch)||item.best_epoch<1||
        !finite(item?.best_validation_pairwise_log_loss)||
        item?.training_rows!==tuning.tuning_rows||
        item?.validation_rows!==tuning.validation_rows||
        item?.purged_rows!==tuning.purged_rows||
        item?.training_pairs!==tuning.tuning_pairs||
        item?.validation_pairs!==tuning.validation_pairs)||
      !selectedTuningCandidate||!finite(tuningMinimumLoss)||
      Math.abs(tuningMinimumLoss-tuning.selected_validation_pairwise_log_loss)>1e-9||
      trainingConfig.l2!==tuning.selected_l2||
      trainingConfig.epochs_requested!==tuning.selected_epochs||
      tuning?.final_refit_rows!==training.training_rows||
      tuning?.final_refit_pairs!==training.training_pairs||
      contract?.schema!=='RADARX_TCN_LSTM_EXECUTION_RANK_FEATURE_OUT_OF_SAMPLE_CONTRACT_V1'||
      contract?.out_of_sample_for_execution_head_features!==true||
      contract?.training_and_execution_feature_identities_disjoint!==true||
      contract?.chronology_valid!==true||
      !finite(contract?.model_training_max_resolved_at)||
      !finite(contract?.execution_feature_min_at)||
      !(contract.execution_feature_min_at>contract.model_training_max_resolved_at)||
      contract?.classifier_parameters_updated_by_ranker!==false||
      contract?.validation_or_holdout_used!==false||
      training?.validation_or_holdout_used!==false)
      return fail('ORDERED_RANKER_TRAINING_BOUNDARY_INVALID');
    if(artifact.holdout_status!=='LOCKED'||
      artifact.outer_validation_status!=='NOT_OPENED'||
      artifact.paper_trading!==true||artifact.real_order_execution!==false||
      artifact.promotion_status!=='NOT_APPROVED')
      return fail('ORDERED_RANKER_EXECUTION_OR_HOLDOUT_POLICY_INVALID');
    const core={...artifact};
    delete core.artifact_content_hash;
    delete core.artifact_manifest;
    delete core.artifact_manifest_hash;
    delete core.hash_status;
    delete core.signature_status;
    const contentHash=hashObject(core);
    if(contentHash!==artifact.artifact_content_hash)
      return fail('ORDERED_RANKER_CONTENT_HASH_MISMATCH');
    const expectedManifest=manifestFrom(core,contentHash);
    if(canonical(expectedManifest)!==canonical(artifact.artifact_manifest))
      return fail('ORDERED_RANKER_MANIFEST_CONTENT_MISMATCH');
    if(hashObject(expectedManifest)!==artifact.artifact_manifest_hash)
      return fail('ORDERED_RANKER_MANIFEST_HASH_MISMATCH');
    return {valid:true,content_hash:contentHash,manifest_hash:artifact.artifact_manifest_hash};
  }catch(error){
    return fail(String(error?.message||error));
  }
}

export function createOrderedTemporalRankerArtifact({profile,provenance}={}){
  const model=profile?.model;
  const ranking=profile?.training?.return_ranking;
  const ranker=ranking?.ranking_head;
  const contract=ranker?.downstream_feature_contract;
  if(!model||model.rankingRepresentation!=='RAW_ORDERED_696_V1'||
    ranking?.representation!=='RAW_ORDERED_696_V1'||
    ranker?.schema!=='RADARX_TCN_LSTM_INDEPENDENT_ORDERED_696_RETURN_RANKER_V1'||
    ranker?.fitted!==true)
    throw new TypeError('ORDERED_RANKER_TRAINED_RAW_696_PROFILE_REQUIRED');
  const weights=model.orderedRankingHeadWeights;
  const means=model.orderedRankingFeatureMean;
  const stds=model.orderedRankingFeatureStd;
  const standardization=ranker.standardization;
  if(!Array.isArray(weights)||weights.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
    !Array.isArray(means)||means.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
    !Array.isArray(stds)||stds.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
    !Array.isArray(standardization?.feature_mean)||!Array.isArray(standardization?.feature_std)||
    canonical(means)!==canonical(standardization.feature_mean)||
    canonical(stds)!==canonical(standardization.feature_std))
    throw new TypeError('ORDERED_RANKER_MODEL_AND_TRAINING_METADATA_MISMATCH');
  const required={
    sourceCommitSha:provenance?.sourceCommitSha,
    datasetSha256:provenance?.datasetSha256,
    inputFileSha256:provenance?.inputFileSha256,
    datasetSourceCommitSha:provenance?.datasetSourceCommitSha
  };
  if(!HEX_40.test(String(required.sourceCommitSha??''))||
    !HEX_64.test(String(required.datasetSha256??''))||
    !HEX_64.test(String(required.inputFileSha256??''))||
    !HEX_40.test(String(required.datasetSourceCommitSha??''))||
    !Number.isInteger(provenance?.datasetRowCount)||provenance.datasetRowCount<1||
    !provenance?.splitDefinition?.schema||
    !Number.isFinite(provenance?.splitDefinition?.purge_ms)||
    provenance.splitDefinition.purge_ms<=0||
    provenance?.roundTripCostBps!==30||
    !provenance?.targetDefinition||!provenance?.targetSemantics||
    !Array.isArray(provenance?.featureNames)||
    provenance.featureNames.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
    provenance.featureNames.some(name=>typeof name!=='string'||!name.trim())||
    new Set(provenance.featureNames).size!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT)
    throw new TypeError('ORDERED_RANKER_DATASET_PROVENANCE_INVALID');
  const trainingRows=Number(ranker.training_rows);
  const standardizerRows=Number(standardization.fit_rows);
  const trainingPairs=Number(ranker.training_pairs);
  const downstreamContract=ranker.downstream_feature_contract;
  const core={
    artifact_schema:ORDERED_TEMPORAL_RANKER_ARTIFACT_SCHEMA,
    artifact_schema_version:1,
    model_family:'TCN_LSTM_INDEPENDENT_RAW_ORDERED_RETURN_RANKER',
    model_version:'RAW_ORDERED_696_PAIRWISE_RANKER_V1',
    code_commit_sha:String(required.sourceCommitSha).toLowerCase(),
    dataset_sha256:String(required.datasetSha256).toLowerCase(),
    input_file_sha256:String(required.inputFileSha256).toLowerCase(),
    dataset_source_commit_sha:String(required.datasetSourceCommitSha).toLowerCase(),
    dataset_row_count:provenance.datasetRowCount,
    target_definition:provenance.targetDefinition,
    target_semantics:provenance.targetSemantics,
    cost_model_id:'FIXED_LINEAR_ROUND_TRIP_BPS_V1',
    round_trip_cost_bps:provenance.roundTripCostBps,
    split_id:provenance.splitDefinition.schema,
    split_definition:{
      schema:provenance.splitDefinition.schema,
      purge_ms:provenance.splitDefinition.purge_ms,
      counts:provenance.splitDefinition.counts??null,
      boundaries:provenance.splitDefinition.boundaries??null,
      holdout_scored_rows:0
    },
    representation:'RAW_ORDERED_696_V1',
    input_schema:'RAW_ORDERED_TCN_LSTM_SEQUENCE_24X29_ROW_MAJOR_V1',
    input_shape:[TCN_LSTM_STEPS,TCN_LSTM_INPUT_CHANNELS],
    feature_schema_id:TCN_LSTM_ORDERED_RANKING_FEATURE_SCHEMA_ID,
    feature_count:TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT,
    feature_names:[...provenance.featureNames],
    feature_order:'STEP_MAJOR_ROW_MAJOR_24_STEPS_X_29_CHANNELS',
    parameters:{
      weights:[...weights],
      feature_mean:[...means],
      feature_std:[...stds]
    },
    training_provenance:{
      fit_partition:'TRAINING_PARTITION_ONLY',
      source_partition:ranker.source_partition??null,
      feature_scoring_partition:ranker.feature_scoring_partition??null,
      standardizer_fit_partition:standardization.fit_partition??null,
      training_rows:trainingRows,
      standardizer_fit_rows:standardizerRows,
      training_pairs:trainingPairs,
      pair_strategy:ranking.pair_strategy??null,
      round_trip_cost_bps:ranking.round_trip_cost_bps??null,
      minimum_return_gap_pct:ranking.minimum_return_gap_pct??null,
      maximum_pairs_per_timestamp:ranking.maximum_pairs_per_timestamp??null,
      initial_pairwise_log_loss:ranker.initial_pairwise_log_loss??null,
      final_pairwise_log_loss:ranker.final_pairwise_log_loss??null,
      ranker_training_config:{
        learning_rate:ranker.learning_rate,
        l2:ranker.l2,
        epochs_requested:ranker.epochs_requested,
        epochs_completed:ranker.epochs_completed,
        best_epoch:ranker.best_epoch,
        patience:ranker.patience,
        selection_metric:'PURGED_INTERNAL_TRAINING_VALIDATION_PAIRWISE_LOG_LOSS'
      },
      internal_training_validation:ranker.internal_training_validation,
      downstream_feature_contract:downstreamContract,
      classifier_parameters_updated:ranker.classifier_parameters_updated,
      validation_or_holdout_used:ranker.validation_or_holdout_used
    },
    holdout_status:'LOCKED',
    outer_validation_status:'NOT_OPENED',
    paper_trading:true,
    real_order_execution:false,
    promotion_status:'NOT_APPROVED'
  };
  const artifact=finalize(core);
  const verification=verifyOrderedTemporalRankerArtifact(artifact);
  if(!verification.valid)
    throw new Error('ORDERED_RANKER_ARTIFACT_VERIFY_FAILED:'+verification.reason);
  return artifact;
}

export function predictOrderedTemporalRankerArtifact(sequence,artifact){
  const verification=verifyOrderedTemporalRankerArtifact(artifact);
  if(!verification.valid)
    throw new TypeError('ORDERED_RANKER_ARTIFACT_NOT_VERIFIED:'+verification.reason);
  const features=buildTcnLstmFlattenedFeatures(sequence);
  if(features.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
    features.some(value=>!Number.isFinite(value)))
    throw new TypeError('ORDERED_RANKER_INFERENCE_FEATURES_INVALID');
  let score=0;
  const {weights,feature_mean,feature_std}=artifact.parameters;
  for(let index=0;index<features.length;index++)
    score+=weights[index]*((features[index]-feature_mean[index])/feature_std[index]);
  return Math.max(-30,Math.min(30,score));
}

async function atomicJson(path,value){
  await mkdir(dirname(path),{recursive:true});
  const temporary=path+'.tmp-'+process.pid+'-'+Math.random().toString(16).slice(2);
  await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  await rename(temporary,path);
}

export async function writeOrderedTemporalRankerArtifactAtomic(directory,artifact){
  const verification=verifyOrderedTemporalRankerArtifact(artifact);
  if(!verification.valid)
    throw new TypeError('ORDERED_RANKER_EXPORT_REQUIRES_VERIFIED_ARTIFACT:'+verification.reason);
  const artifactPath=join(directory,'TCN_LSTM_ORDERED_RANKER.json');
  const manifestPath=join(directory,'TCN_LSTM_ORDERED_RANKER.manifest.json');
  await atomicJson(artifactPath,artifact);
  await atomicJson(manifestPath,artifact.artifact_manifest);
  const restored=JSON.parse(await readFile(artifactPath,'utf8'));
  const reloaded=verifyOrderedTemporalRankerArtifact(restored);
  if(!reloaded.valid||reloaded.content_hash!==verification.content_hash||
    reloaded.manifest_hash!==verification.manifest_hash)
    throw new Error('ORDERED_RANKER_DISK_RELOAD_VERIFICATION_FAILED');
  return {
    status:'EXPORTED_AND_DISK_RELOAD_VERIFIED',
    artifact_path:artifactPath,
    manifest_path:manifestPath,
    artifact_content_hash:verification.content_hash,
    artifact_manifest_hash:verification.manifest_hash,
    feature_schema_id:artifact.feature_schema_id,
    feature_count:artifact.feature_count,
    representation:artifact.representation,
    dependency:{
      artifact_schema:artifact.artifact_schema,
      artifact_path:'model-artifacts/TCN_LSTM_ORDERED_RANKER.json',
      manifest_path:'model-artifacts/TCN_LSTM_ORDERED_RANKER.manifest.json',
      artifact_content_hash:verification.content_hash,
      artifact_manifest_hash:verification.manifest_hash,
      code_commit_sha:artifact.code_commit_sha,
      dataset_sha256:artifact.dataset_sha256,
      input_file_sha256:artifact.input_file_sha256,
      representation:artifact.representation,
      feature_schema_id:artifact.feature_schema_id,
      feature_count:artifact.feature_count,
      validation_or_holdout_used:false,
      holdout_status:'LOCKED'
    }
  };
}
