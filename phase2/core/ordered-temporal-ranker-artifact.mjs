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
function compareTuningCandidates(a,b){
 return b.minimum_fold_pairwise_accuracy_improvement_pct-a.minimum_fold_pairwise_accuracy_improvement_pct||
 (b.minimum_fold_pairwise_log_loss_improvement??0)-(a.minimum_fold_pairwise_log_loss_improvement??0)||
 b.best_validation_pairwise_accuracy_improvement_pct-a.best_validation_pairwise_accuracy_improvement_pct||
 b.best_validation_pairwise_log_loss_improvement-a.best_validation_pairwise_log_loss_improvement||
 b.minimum_fold_pairwise_accuracy_pct-a.minimum_fold_pairwise_accuracy_pct||
 b.best_validation_pairwise_accuracy_pct-a.best_validation_pairwise_accuracy_pct||
 a.best_validation_pairwise_log_loss-b.best_validation_pairwise_log_loss||
 a.parameter_count-b.parameter_count||b.l2-a.l2||a.best_epoch-b.best_epoch;
}
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
    const trainingObjective=trainingConfig?.training_objective??'PAIRWISE_LOGISTIC_V1';
    const rankingMargin=trainingConfig?.ranking_margin??0.25;
    const tuningGrid=tuning?.candidate_grid;
    const tuningFolds=tuning?.folds;
    const foldCount=tuning?.fold_count;
    const isThreeFoldV6=tuning?.schema==='RADARX_TCN_LSTM_ORDERED_RANKER_INTERNAL_PURGED_EXPANDING_VALIDATION_V6';
    const isCurrentParetoV3=isThreeFoldV6&&tuning?.method===
      'THREE_FOLD_NESTED_PARETO_CHECKPOINT_REQUIRED_LOGISTIC_ANCHORED_VALIDATION_V3';
    const isLegacyTwoFoldV5=tuning?.schema==='RADARX_TCN_LSTM_ORDERED_RANKER_INTERNAL_PURGED_EXPANDING_VALIDATION_V5';
    const validTemporalBlockCounts=[1,2,3,4,6,8,12,24];
    const temporalBlockCount=trainingConfig?.temporal_block_count;
    const temporalStepsPerBlock=Number.isInteger(temporalBlockCount)&&temporalBlockCount>0
      ?TCN_LSTM_STEPS/temporalBlockCount:NaN;
    const tiedParameterizationValid=validTemporalBlockCounts.includes(temporalBlockCount)&&
      Number.isInteger(temporalStepsPerBlock)&&
      trainingConfig?.parameter_count===temporalBlockCount*TCN_LSTM_INPUT_CHANNELS&&
      trainingConfig?.parameterization_id===
        'TEMPORAL_BLOCK_TIED_'+temporalBlockCount+'X'+TCN_LSTM_INPUT_CHANNELS+'_V1'&&
      Array.from({length:TCN_LSTM_STEPS},(_,step)=>step).every(step=>
        Array.from({length:TCN_LSTM_INPUT_CHANNELS},(_,channel)=>channel).every(channel=>{
          const first=(Math.floor(step/temporalStepsPerBlock)*temporalStepsPerBlock)*TCN_LSTM_INPUT_CHANNELS+channel;
          const current=step*TCN_LSTM_INPUT_CHANNELS+channel;
          return Math.abs(parameters.weights[current]-parameters.weights[first])<=1e-12&&
            Math.abs(parameters.feature_mean[current]-parameters.feature_mean[first])<=1e-12&&
            Math.abs(parameters.feature_std[current]-parameters.feature_std[first])<=1e-12;
        })
      );
    const foldContractValid=Array.isArray(tuningFolds)&&
      (isThreeFoldV6?foldCount===3:isLegacyTwoFoldV5&&foldCount===2)&&
      tuningFolds.length===foldCount&&
      tuningFolds.every((fold,index)=>
        fold?.fold_index===index+1&&
        finite(fold?.fit_end_fraction)&&fold.fit_end_fraction>0&&fold.fit_end_fraction<1&&
        Number.isInteger(fold?.tuning_rows)&&fold.tuning_rows>=20&&
        Number.isInteger(fold?.validation_rows)&&fold.validation_rows>=20&&
        Number.isInteger(fold?.purged_rows)&&fold.purged_rows>=0&&
        Number.isInteger(fold?.tuning_pairs)&&fold.tuning_pairs>=10&&
        Number.isInteger(fold?.validation_pairs)&&fold.validation_pairs>=10&&
        Number.isInteger(fold?.epoch_training_rows)&&fold.epoch_training_rows>=20&&
        Number.isInteger(fold?.epoch_training_pairs)&&fold.epoch_training_pairs>=10&&
        Number.isInteger(fold?.epoch_validation_rows)&&fold.epoch_validation_rows>=20&&
        Number.isInteger(fold?.epoch_validation_pairs)&&fold.epoch_validation_pairs>=10&&
        Number.isInteger(fold?.epoch_purged_rows)&&fold.epoch_purged_rows>=0&&
        Number.isInteger(fold?.epoch_unused_rows)&&fold.epoch_unused_rows>=0&&
        fold.epoch_training_rows+fold.epoch_validation_rows+
          fold.epoch_purged_rows+fold.epoch_unused_rows===fold.tuning_rows&&
        finite(fold?.epoch_training_max_at)&&finite(fold?.epoch_training_max_resolved_at)&&
        finite(fold?.epoch_validation_min_at)&&finite(fold?.epoch_validation_max_at)&&
        fold.epoch_validation_max_at>=fold.epoch_validation_min_at&&
        fold.epoch_validation_min_at>fold.epoch_training_max_resolved_at&&
        finite(fold?.epoch_purge_gap_ms)&&
        Math.abs(fold.epoch_purge_gap_ms-
          (fold.epoch_validation_min_at-fold.epoch_training_max_at))<=1e-6&&
        fold.epoch_purge_gap_ms>=tuning?.purge_horizon_ms&&
        fold.epoch_validation_max_at<fold.validation_min_at&&
        finite(fold?.tuning_max_resolved_at)&&finite(fold?.tuning_max_at)&&
        finite(fold?.validation_min_at)&&finite(fold?.validation_max_at)&&
        fold.validation_max_at>=fold.validation_min_at&&
        fold.validation_min_at>fold.tuning_max_resolved_at&&
        finite(fold?.logistic_validation_pairwise_log_loss)&&
        finite(fold?.logistic_validation_pairwise_accuracy_pct)&&
        fold.logistic_validation_pairwise_accuracy_pct>=0&&
        fold.logistic_validation_pairwise_accuracy_pct<=100&&
        fold.logistic_baseline_training_rows===fold.tuning_rows&&
        fold.logistic_baseline_validation_labels_read===false&&
        fold.logistic_baseline_validation_or_holdout_used===false&&
        finite(fold?.purge_gap_ms)&&
        Math.abs(fold.purge_gap_ms-(fold.validation_min_at-fold.tuning_max_at))<=1e-6&&
        fold.purge_gap_ms>=tuning?.purge_horizon_ms
      )&&
      tuningFolds.slice(0,-1).every((fold,index)=>
        fold.validation_max_at<tuningFolds[index+1].validation_min_at&&
        tuningFolds[index+1].tuning_max_at>=fold.validation_max_at);
    const foldTotalsValid=foldContractValid&&
      tuning?.tuning_rows===tuningFolds.reduce((sum,fold)=>sum+fold.tuning_rows,0)&&
      tuning?.validation_rows===tuningFolds.reduce((sum,fold)=>sum+fold.validation_rows,0)&&
      tuning?.purged_rows===tuningFolds.reduce((sum,fold)=>sum+fold.purged_rows,0)&&
      tuning?.tuning_pairs===tuningFolds.reduce((sum,fold)=>sum+fold.tuning_pairs,0)&&
      tuning?.validation_pairs===tuningFolds.reduce((sum,fold)=>sum+fold.validation_pairs,0)&&
      tuning?.purge_gap_ms===Math.min(...tuningFolds.map(fold=>fold.purge_gap_ms));
    const candidateGridValid=Array.isArray(tuningGrid)&&tuningGrid.length>=2&&
      new Set(tuningGrid.map(item=>String(item?.temporal_block_count)+'|'+String(item?.l2))).size===tuningGrid.length&&
      tuningGrid.every(item=>{
        const foldResults=item?.fold_results;
        if(!validTemporalBlockCounts.includes(item?.temporal_block_count)||
          item?.parameter_count!==item?.temporal_block_count*TCN_LSTM_INPUT_CHANNELS||
          item?.steps_per_block!==TCN_LSTM_STEPS/item?.temporal_block_count||
          item?.parameterization_id!=='TEMPORAL_BLOCK_TIED_'+item?.temporal_block_count+'X'+TCN_LSTM_INPUT_CHANNELS+'_V1'||
          !finite(item?.l2)||item.l2<0||item.l2>1||!Number.isInteger(item?.best_epoch)||item.best_epoch<1||
          !finite(item?.best_validation_pairwise_accuracy_pct)||item.best_validation_pairwise_accuracy_pct<0||
          item.best_validation_pairwise_accuracy_pct>100||!finite(item?.minimum_fold_pairwise_accuracy_pct)||
          item.minimum_fold_pairwise_accuracy_pct<0||item.minimum_fold_pairwise_accuracy_pct>100||
          !finite(item?.logistic_validation_pairwise_accuracy_pct)||
          item.logistic_validation_pairwise_accuracy_pct<0||item.logistic_validation_pairwise_accuracy_pct>100||
          !finite(item?.logistic_validation_pairwise_log_loss)||
          !finite(item?.best_validation_pairwise_accuracy_improvement_pct)||
          !finite(item?.minimum_fold_pairwise_accuracy_improvement_pct)||
          isThreeFoldV6&&!finite(item?.minimum_fold_pairwise_log_loss_improvement)||
          !finite(item?.best_validation_pairwise_log_loss_improvement)||
          !finite(item?.validation_pairwise_accuracy_std_pct)||item.validation_pairwise_accuracy_std_pct<0||
          !finite(item?.training_pairwise_accuracy_pct)||item.training_pairwise_accuracy_pct<0||
          item.training_pairwise_accuracy_pct>100||!finite(item?.best_validation_pairwise_log_loss)||
          !finite(item?.training_pairwise_log_loss)||item?.fold_count!==foldCount||
          !Array.isArray(foldResults)||foldResults.length!==foldCount)return false;
        const foldResultsValid=foldResults.every((result,index)=>{
          const fold=tuningFolds[index];
          return result?.fold_index===fold.fold_index&&Number.isInteger(result?.best_epoch)&&result.best_epoch>=1&&
            (!isCurrentParetoV3||typeof result?.epoch_checkpoint_selected==='boolean')&&
            finite(result?.best_validation_pairwise_accuracy_pct)&&result.best_validation_pairwise_accuracy_pct>=0&&
            result.best_validation_pairwise_accuracy_pct<=100&&finite(result?.logistic_validation_pairwise_accuracy_pct)&&
            result.logistic_validation_pairwise_accuracy_pct===fold.logistic_validation_pairwise_accuracy_pct&&
            finite(result?.logistic_validation_pairwise_log_loss)&&
            result.logistic_validation_pairwise_log_loss===fold.logistic_validation_pairwise_log_loss&&
            finite(result?.training_pairwise_accuracy_pct)&&result.training_pairwise_accuracy_pct>=0&&
            result.training_pairwise_accuracy_pct<=100&&
            finite(result?.epoch_selection_pairwise_log_loss)&&
            finite(result?.epoch_selection_pairwise_accuracy_pct)&&
            result.epoch_selection_pairwise_accuracy_pct>=0&&
            result.epoch_selection_pairwise_accuracy_pct<=100&&
            result?.epoch_training_rows===fold.epoch_training_rows&&
            result?.epoch_training_pairs===fold.epoch_training_pairs&&
            result?.epoch_validation_rows===fold.epoch_validation_rows&&
            result?.epoch_validation_pairs===fold.epoch_validation_pairs&&
            result?.epoch_purged_rows===fold.epoch_purged_rows&&
            result?.epoch_unused_rows===fold.epoch_unused_rows&&
            result?.epoch_purge_gap_ms===fold.epoch_purge_gap_ms&&
            finite(result?.best_validation_pairwise_log_loss)&&finite(result?.training_pairwise_log_loss)&&
            result?.training_rows===fold.tuning_rows&&result?.validation_rows===fold.validation_rows&&
            result?.purged_rows===fold.purged_rows&&result?.training_pairs===fold.tuning_pairs&&
            result?.validation_pairs===fold.validation_pairs;
        });
        if(!foldResultsValid)return false;
        const checkpointSelectedCount=foldResults.filter(result=>
          result.epoch_checkpoint_selected===true).length;
        const allEpochCheckpointsSelected=checkpointSelectedCount===foldCount;
        if(isCurrentParetoV3&&(
          item.epoch_checkpoint_selected_count!==checkpointSelectedCount||
          item.all_epoch_checkpoints_selected!==allEpochCheckpointsSelected
        ))return false;
        const validationPairs=foldResults.reduce((sum,result)=>sum+result.validation_pairs,0);
        const trainingPairs=foldResults.reduce((sum,result)=>sum+result.training_pairs,0);
        const expectedValidationLoss=foldResults.reduce((sum,result)=>sum+result.best_validation_pairwise_log_loss*result.validation_pairs,0)/validationPairs;
        const expectedTrainingLoss=foldResults.reduce((sum,result)=>sum+result.training_pairwise_log_loss*result.training_pairs,0)/trainingPairs;
        const expectedValidationAccuracy=foldResults.reduce((sum,result)=>sum+result.best_validation_pairwise_accuracy_pct*result.validation_pairs,0)/validationPairs;
        const expectedTrainingAccuracy=foldResults.reduce((sum,result)=>sum+result.training_pairwise_accuracy_pct*result.training_pairs,0)/trainingPairs;
        const expectedLogisticValidationAccuracy=foldResults.reduce((sum,result)=>sum+result.logistic_validation_pairwise_accuracy_pct*result.validation_pairs,0)/validationPairs;
        const expectedLogisticValidationLoss=foldResults.reduce((sum,result)=>sum+result.logistic_validation_pairwise_log_loss*result.validation_pairs,0)/validationPairs;
        const expectedMinimumFoldAccuracy=Math.min(...foldResults.map(result=>result.best_validation_pairwise_accuracy_pct));
        const expectedMinimumFoldAccuracyImprovement=Math.min(...foldResults.map(result=>
          result.best_validation_pairwise_accuracy_pct-result.logistic_validation_pairwise_accuracy_pct
        ));
        const expectedAccuracyImprovement=expectedValidationAccuracy-expectedLogisticValidationAccuracy;
        const expectedLogLossImprovement=expectedLogisticValidationLoss-expectedValidationLoss;
        const expectedMinimumFoldLogLossImprovement=Math.min(...foldResults.map(result=>
          result.logistic_validation_pairwise_log_loss-result.best_validation_pairwise_log_loss
        ));
        const accuracyVariance=foldResults.reduce((sum,result)=>sum+result.validation_pairs*(result.best_validation_pairwise_accuracy_pct-expectedValidationAccuracy)**2,0)/validationPairs;
        const epochs=foldResults.map(result=>result.best_epoch).sort((a,b)=>a-b);
        const middle=Math.floor(epochs.length/2);
        const expectedMedianEpoch=epochs.length%2?epochs[middle]:Math.max(1,Math.round((epochs[middle-1]+epochs[middle])/2));
        return item?.best_epoch===expectedMedianEpoch&&
          Math.abs(item.best_validation_pairwise_accuracy_pct-Number(expectedValidationAccuracy.toFixed(4)))<=1e-9&&
          Math.abs(item.minimum_fold_pairwise_accuracy_pct-Number(expectedMinimumFoldAccuracy.toFixed(4)))<=1e-9&&
          Math.abs(item.logistic_validation_pairwise_accuracy_pct-Number(expectedLogisticValidationAccuracy.toFixed(4)))<=1e-9&&
          Math.abs(item.logistic_validation_pairwise_log_loss-Number(expectedLogisticValidationLoss.toFixed(8)))<=1e-9&&
          Math.abs(item.best_validation_pairwise_accuracy_improvement_pct-Number(expectedAccuracyImprovement.toFixed(4)))<=1e-9&&
          Math.abs(item.minimum_fold_pairwise_accuracy_improvement_pct-Number(expectedMinimumFoldAccuracyImprovement.toFixed(4)))<=1e-9&&
          (!isThreeFoldV6||Math.abs(item.minimum_fold_pairwise_log_loss_improvement-Number(expectedMinimumFoldLogLossImprovement.toFixed(8)))<=1e-9)&&
          Math.abs(item.best_validation_pairwise_log_loss_improvement-Number(expectedLogLossImprovement.toFixed(8)))<=1e-9&&
          Math.abs(item.validation_pairwise_accuracy_std_pct-Number(Math.sqrt(Math.max(0,accuracyVariance)).toFixed(4)))<=1e-9&&
          Math.abs(item.training_pairwise_accuracy_pct-Number(expectedTrainingAccuracy.toFixed(4)))<=1e-9&&
          Math.abs(item.best_validation_pairwise_log_loss-Number(expectedValidationLoss.toFixed(8)))<=1e-9&&
          Math.abs(item.training_pairwise_log_loss-Number(expectedTrainingLoss.toFixed(8)))<=1e-9&&
          item?.training_rows===foldResults.reduce((sum,result)=>sum+result.training_rows,0)&&
          item?.validation_rows===foldResults.reduce((sum,result)=>sum+result.validation_rows,0)&&
          item?.purged_rows===foldResults.reduce((sum,result)=>sum+result.purged_rows,0)&&
          item?.training_pairs===trainingPairs&&item?.validation_pairs===validationPairs;
      });
    const selectedTuningCandidate=Array.isArray(tuningGrid)
      ?tuningGrid.find(item=>item?.l2===tuning?.selected_l2&&item?.best_epoch===tuning?.selected_epochs&&
        item?.temporal_block_count===tuning?.selected_temporal_block_count&&
        item?.parameter_count===tuning?.selected_parameter_count&&
        item?.parameterization_id===tuning?.selected_parameterization_id&&
        item?.best_validation_pairwise_log_loss===tuning?.selected_validation_pairwise_log_loss&&
        item?.best_validation_pairwise_accuracy_pct===tuning?.selected_validation_pairwise_accuracy_pct&&
        item?.minimum_fold_pairwise_accuracy_pct===tuning?.selected_minimum_fold_pairwise_accuracy_pct&&
        item?.logistic_validation_pairwise_accuracy_pct===tuning?.selected_logistic_validation_pairwise_accuracy_pct&&
        item?.logistic_validation_pairwise_log_loss===tuning?.selected_logistic_validation_pairwise_log_loss&&
        item?.best_validation_pairwise_accuracy_improvement_pct===tuning?.selected_validation_pairwise_accuracy_improvement_pct&&
        item?.minimum_fold_pairwise_accuracy_improvement_pct===tuning?.selected_minimum_fold_pairwise_accuracy_improvement_pct&&
        (!isThreeFoldV6||item?.minimum_fold_pairwise_log_loss_improvement===tuning?.selected_minimum_fold_pairwise_log_loss_improvement)&&
        item?.best_validation_pairwise_log_loss_improvement===tuning?.selected_validation_pairwise_log_loss_improvement):null;
    const robustTuningCandidates=isThreeFoldV6&&candidateGridValid?[...tuningGrid].filter(item=>
      (!isCurrentParetoV3||item.all_epoch_checkpoints_selected===true&&
        item.epoch_checkpoint_selected_count===foldCount)&&
      item.minimum_fold_pairwise_accuracy_improvement_pct>0&&
      item.minimum_fold_pairwise_log_loss_improvement>0
    ).sort(compareTuningCandidates):[];
    const bestTuningCandidate=robustTuningCandidates[0]??
      (candidateGridValid?[...tuningGrid].sort(compareTuningCandidates)[0]:null);
    if(training?.fit_partition!=='TRAINING_PARTITION_ONLY'||
      training?.source_partition!=='PRE_EXECUTION_MODEL_TRAINING_PARTITION'||
      training?.feature_scoring_partition!=='PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK'||
      training?.standardizer_fit_partition!=='TRAINING_PARTITION_ONLY'||
      !Number.isInteger(training?.training_rows)||training.training_rows<20||
      training?.standardizer_fit_rows!==training.training_rows||
      !Number.isInteger(training?.training_pairs)||training.training_pairs<10||
      !trainingConfig||!finite(trainingConfig.learning_rate)||trainingConfig.learning_rate<=0||
      !['PAIRWISE_LOGISTIC_V1','PAIRWISE_MARGIN_HINGE_V1'].includes(trainingObjective)||
      !finite(rankingMargin)||rankingMargin<=0||rankingMargin>5||
      !finite(trainingConfig.l2)||trainingConfig.l2<0||trainingConfig.l2>1||
      !Number.isInteger(trainingConfig.epochs_requested)||trainingConfig.epochs_requested<1||
      !Number.isInteger(trainingConfig.epochs_completed)||trainingConfig.epochs_completed<1||
      trainingConfig.epochs_completed>trainingConfig.epochs_requested||
      !Number.isInteger(trainingConfig.best_epoch)||trainingConfig.best_epoch<1||
      trainingConfig.best_epoch>trainingConfig.epochs_completed||
      !Number.isInteger(trainingConfig.patience)||trainingConfig.patience<1||
      !tiedParameterizationValid||
      trainingConfig.steps_per_block!==temporalStepsPerBlock||
      trainingConfig.epoch_selection_mode!=='FIXED_EPOCHS'||
      trainingConfig.selection_metric!==(isThreeFoldV6
        ?'THREE_FOLD_MINIMUM_LOGISTIC_ACCURACY_AND_LOG_LOSS_MARGIN_NESTED_PURGED_EXPANDING_WINDOW_V6'
        :'MIN_FOLD_LOGISTIC_ACCURACY_MARGIN_THEN_PAIR_WEIGHTED_MARGIN_AND_LOG_LOSS_NESTED_PURGED_EXPANDING_WINDOW_V5')||
      !(isThreeFoldV6
        ?(
          tuning?.method==='THREE_FOLD_NESTED_PARETO_CHECKPOINT_REQUIRED_LOGISTIC_ANCHORED_VALIDATION_V3'&&
          tuning?.epoch_checkpoint_selection_policy===
            'PARETO_NON_REGRESSION_PAIRWISE_ACCURACY_AND_LOG_LOSS_V1'||
          tuning?.method==='THREE_FOLD_NESTED_PARETO_DUAL_METRIC_LOGISTIC_ANCHORED_VALIDATION_V2'&&
          tuning?.epoch_checkpoint_selection_policy===
            'PARETO_NON_REGRESSION_PAIRWISE_ACCURACY_AND_LOG_LOSS_V1'||
          tuning?.method==='THREE_FOLD_NESTED_EARLY_STOPPING_LOGISTIC_ANCHORED_DUAL_METRIC_VALIDATION_V1'&&
          tuning?.epoch_checkpoint_selection_policy===undefined
        )
        :tuning?.method==='TWO_FOLD_NESTED_EARLY_STOPPING_LOGISTIC_ANCHORED_ACCURACY_GUARDED_VALIDATION_V1')||
      tuning?.epoch_selection_policy!=='NESTED_PURGED_EPOCH_WINDOW_THEN_FIXED_EPOCH_REFIT_ON_FULL_OUTER_FOLD_TRAINING_ROWS'||
      tuning?.logistic_baseline_config?.schema!=='RADARX_FOLD_LOCAL_RAW_TEMPORAL_LOGISTIC_RANKING_REFERENCE_V1'||
      tuning?.logistic_baseline_config?.feature_schema_id!==TCN_LSTM_ORDERED_RANKING_FEATURE_SCHEMA_ID||
      tuning?.logistic_baseline_config?.feature_count!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      tuning?.logistic_baseline_config?.l2!==1||tuning?.logistic_baseline_config?.learning_rate!==0.03||
      tuning?.logistic_baseline_config?.max_epochs!==160||
      tuning?.logistic_baseline_config?.fit_partition!=='EACH_COMPLETE_OUTER_FOLD_TUNING_WINDOW_ONLY'||
      tuning?.logistic_baseline_config?.epoch_selection_partition!==
        'EARLIER_NESTED_PURGED_SUBWINDOW_WITHIN_OUTER_FOLD_TRAINING_WINDOW'||
      tuning?.logistic_baseline_config?.scoring_partition!=='SAME_LATER_OUTER_FOLD_PURGED_VALIDATION_PAIRS'||
      tuning?.logistic_baseline_config?.validation_labels_read!==false||
      tuning?.logistic_baseline_config?.outer_validation_or_holdout_used!==false||
      tuning?.source_partition!=='PRE_EXECUTION_MODEL_TRAINING_PARTITION_ONLY'||
      tuning?.fit_partition!=='EXPANDING_EARLIER_SUBSETS_OF_PRE_EXECUTION_MODEL_TRAINING_PARTITION'||
      tuning?.validation_partition!==(isThreeFoldV6
        ?'THREE_NON_OVERLAPPING_LATER_PURGED_WINDOWS_WITHIN_PRE_EXECUTION_MODEL_TRAINING_PARTITION'
        :'TWO_NON_OVERLAPPING_LATER_PURGED_WINDOWS_WITHIN_PRE_EXECUTION_MODEL_TRAINING_PARTITION')||
      tuning?.outer_validation_or_holdout_used!==false||
      tuning?.model_selection_partition_used!==false||
      trainingObjective==='PAIRWISE_MARGIN_HINGE_V1'&&
        (tuning?.training_objective!==trainingObjective||tuning?.ranking_margin!==rankingMargin)||
      tuning?.chronology_valid!==true||
      isThreeFoldV6&&(tuning?.selection_rule!=='REQUIRE_STRICT_POSITIVE_LOGISTIC_MARGINS_FOR_PAIRWISE_ACCURACY_AND_LOG_LOSS_IN_EVERY_PURGED_TRAINING_FOLD'||
        tuning?.fold_stable_dual_metric_candidate_count!==robustTuningCandidates.length||
        tuning?.fold_stable_dual_metric_superiority!==(robustTuningCandidates.length>0)||
        tuning?.robustness_status!==(robustTuningCandidates.length>0?'FOLD_STABLE_DUAL_LOGISTIC_SUPERIORITY':'ABSTAIN_NO_FOLD_STABLE_DUAL_SUPERIORITY')||
        tuning?.selected_candidate_qualified!==(robustTuningCandidates.length>0))||
      !finite(tuning?.purge_horizon_ms)||tuning.purge_horizon_ms<4*60*60*1000||
      !foldContractValid||!foldTotalsValid||!candidateGridValid||
      !Number.isInteger(tuning?.tuning_rows)||tuning.tuning_rows<20||
      !Number.isInteger(tuning?.validation_rows)||tuning.validation_rows<20||
      !Number.isInteger(tuning?.purged_rows)||tuning.purged_rows<0||
      !Number.isInteger(tuning?.tuning_pairs)||tuning.tuning_pairs<10||
      !Number.isInteger(tuning?.validation_pairs)||tuning.validation_pairs<10||
      !selectedTuningCandidate||!bestTuningCandidate||
      !finite(tuning?.selected_validation_pairwise_log_loss)||!finite(tuning?.selected_validation_pairwise_accuracy_pct)||
      !finite(tuning?.selected_minimum_fold_pairwise_accuracy_pct)||
      !finite(tuning?.selected_logistic_validation_pairwise_accuracy_pct)||
      !finite(tuning?.selected_logistic_validation_pairwise_log_loss)||
      !finite(tuning?.selected_validation_pairwise_accuracy_improvement_pct)||
      !finite(tuning?.selected_minimum_fold_pairwise_accuracy_improvement_pct)||
      isThreeFoldV6&&!finite(tuning?.selected_minimum_fold_pairwise_log_loss_improvement)||
      !finite(tuning?.selected_validation_pairwise_log_loss_improvement)||
      selectedTuningCandidate!==bestTuningCandidate||
      Math.abs(selectedTuningCandidate.best_validation_pairwise_log_loss-tuning.selected_validation_pairwise_log_loss)>1e-9||
      Math.abs(selectedTuningCandidate.best_validation_pairwise_accuracy_pct-tuning.selected_validation_pairwise_accuracy_pct)>1e-9||
      Math.abs(selectedTuningCandidate.minimum_fold_pairwise_accuracy_pct-tuning.selected_minimum_fold_pairwise_accuracy_pct)>1e-9||
      Math.abs(selectedTuningCandidate.logistic_validation_pairwise_accuracy_pct-tuning.selected_logistic_validation_pairwise_accuracy_pct)>1e-9||
      Math.abs(selectedTuningCandidate.logistic_validation_pairwise_log_loss-tuning.selected_logistic_validation_pairwise_log_loss)>1e-9||
      Math.abs(selectedTuningCandidate.best_validation_pairwise_accuracy_improvement_pct-tuning.selected_validation_pairwise_accuracy_improvement_pct)>1e-9||
      Math.abs(selectedTuningCandidate.minimum_fold_pairwise_accuracy_improvement_pct-tuning.selected_minimum_fold_pairwise_accuracy_improvement_pct)>1e-9||
      isThreeFoldV6&&Math.abs(selectedTuningCandidate.minimum_fold_pairwise_log_loss_improvement-tuning.selected_minimum_fold_pairwise_log_loss_improvement)>1e-9||
      Math.abs(selectedTuningCandidate.best_validation_pairwise_log_loss_improvement-tuning.selected_validation_pairwise_log_loss_improvement)>1e-9||
      trainingConfig.l2!==tuning.selected_l2||
      trainingConfig.epochs_requested!==tuning.selected_epochs||
      temporalBlockCount!==tuning.selected_temporal_block_count||
      trainingConfig.parameter_count!==tuning.selected_parameter_count||
      trainingConfig.parameterization_id!==tuning.selected_parameterization_id||
      tuning.selected_steps_per_block!==temporalStepsPerBlock||
      tuning?.final_refit_rows!==training.training_rows||
      tuning?.final_refit_pairs!==training.training_pairs||
      tuning?.final_refit_epoch_selection_mode!==
        'FIXED_EPOCHS_FROM_NESTED_PURGED_FOLD_EARLY_STOPPING'||
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
    model_version:'RAW_ORDERED_696_TEMPORAL_BLOCK_TIED_PAIRWISE_RANKER_V1',
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
        training_objective:ranker.training_objective??'PAIRWISE_LOGISTIC_V1',
        ranking_margin:ranker.ranking_margin??0.25,
        l2:ranker.l2,
        epochs_requested:ranker.epochs_requested,
        epochs_completed:ranker.epochs_completed,
        best_epoch:ranker.best_epoch,
        patience:ranker.patience,
        epoch_selection_mode:ranker.epoch_selection_mode,
        parameterization_id:ranker.parameterization_id,
        temporal_block_count:ranker.temporal_block_count,
        steps_per_block:ranker.steps_per_block,
        parameter_count:ranker.parameter_count,
        selection_metric:ranker.selection_metric
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


function rankerQualificationSnapshot(artifact){
  const tuning=artifact.training_provenance?.internal_training_validation??{};
  const selected=Array.isArray(tuning.candidate_grid)
    ?tuning.candidate_grid.find(item=>
      item?.l2===tuning.selected_l2&&
      item?.best_epoch===tuning.selected_epochs&&
      item?.temporal_block_count===tuning.selected_temporal_block_count&&
      item?.parameter_count===tuning.selected_parameter_count&&
      item?.parameterization_id===tuning.selected_parameterization_id)
    :null;
  return {
    schema:tuning.schema??null,
    method:tuning.method??null,
    epoch_checkpoint_selection_policy:tuning.epoch_checkpoint_selection_policy??null,
    fold_count:tuning.fold_count??null,
    selected_candidate_qualified:tuning.selected_candidate_qualified===true,
    fold_stable_dual_metric_superiority:tuning.fold_stable_dual_metric_superiority===true,
    fold_stable_dual_metric_candidate_count:
      Number.isInteger(tuning.fold_stable_dual_metric_candidate_count)
        ?tuning.fold_stable_dual_metric_candidate_count:null,
    robustness_status:tuning.robustness_status??null,
    selection_rule:tuning.selection_rule??null,
    validation_or_holdout_used:tuning.outer_validation_or_holdout_used??null,
    selected_candidate:selected?{
      temporal_block_count:selected.temporal_block_count,
      l2:selected.l2,
      best_epoch:selected.best_epoch,
      parameterization_id:selected.parameterization_id,
      parameter_count:selected.parameter_count,
      minimum_fold_pairwise_accuracy_improvement_pct:
        selected.minimum_fold_pairwise_accuracy_improvement_pct,
      minimum_fold_pairwise_log_loss_improvement:
        selected.minimum_fold_pairwise_log_loss_improvement??null,
      fold_results:(selected.fold_results??[]).map(result=>({
        fold_index:result.fold_index,
        candidate_pairwise_accuracy_pct:result.best_validation_pairwise_accuracy_pct,
        logistic_pairwise_accuracy_pct:result.logistic_validation_pairwise_accuracy_pct,
        accuracy_improvement_pct:Number((
          result.best_validation_pairwise_accuracy_pct-
          result.logistic_validation_pairwise_accuracy_pct
        ).toFixed(4)),
        candidate_pairwise_log_loss:result.best_validation_pairwise_log_loss,
        logistic_pairwise_log_loss:result.logistic_validation_pairwise_log_loss,
        log_loss_improvement:Number((
          result.logistic_validation_pairwise_log_loss-
          result.best_validation_pairwise_log_loss
        ).toFixed(8))
      }))
    }:null
  };
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
      holdout_status:'LOCKED',
      ranker_qualification:rankerQualificationSnapshot(artifact)
    }
  };
}
