import { createHash } from 'node:crypto';
import { fitHurdleReturnHead,fitHurdlePositiveReturnCalibration,predictHurdleExpectedNetReturn } from './hurdle-return-head.mjs';
import {
  fitTemporalLogisticFoldRankingReference,
  predictTemporalLogisticRawLogit,
  predictTemporalLogisticProbability
} from './temporal-logistic-baseline.mjs';
import {
  focalAsymmetricBrierLoss,deriveTrainingClassWeights,
  topKProbabilitySignals,topKThresholdSignals,topKMatchedCountSignals,
  simulateFirstTouchPaperPortfolio,NEURAL_CLOSURE_PORTFOLIO_POLICY
} from './neural-closure-contracts.mjs';

/**
 * RadarX Build 224 — Research-only TCN → LSTM → temporal-attention challenger.
 *
 * Contract:
 *   - Input is exactly 24 completed 15m steps × 29 causal features.
 *   - A compact causal TCN produces per-step embeddings.
 *   - A unidirectional LSTM carries sequential hidden/cell state over the 24
 *     embeddings; a learned single-head query attends over its hidden states.
 *   - The readout is residual to a frozen same-training-row pooled Logistic
 *     anchor. The anchor and neural model are both fit on the same training rows.
 *   - Hyper-parameters are selected only on a separate inner-selection block.
 *   - This module never places orders and is not production/live eligible.
 *
 * Recurrent dropout is deliberately disabled in this first validated path.
 * Dense MLP dropout calibration exists separately. Adding locked/variational
 * recurrent dropout requires its own mask-gradient and temporal generalization
 * ablation; injecting ordinary per-step dropout here would corrupt memory.
 */

export const TCN_LSTM_HYBRID_SCHEMA = 'RADARX_BUILD224_TCN_LSTM_ATTENTION_V2_MULTISCALE_INDEPENDENT_RANKER';
export const TCN_LSTM_EXECUTION_HEAD_INPUT_FEATURE_SCHEMA =
  'RADARX_TCN_LSTM_EXECUTION_HEAD_POOLED_SCORE_GATED_BY_MATCHED_FULL_SEQUENCE_LOGISTIC_CV_OOF_CLASSIFIER_AND_INDEPENDENT_RANK_SCORE_V8';
const TCN_LSTM_EXECUTION_HEAD_SCORE_LOGIT_SCALE = 4;

export const TCN_LSTM_STEPS = 24;
export const TCN_LSTM_INPUT_CHANNELS = 29;
export const TCN_LSTM_HIDDEN = 8;
export const TCN_LSTM_LAYERS = 3;
export const TCN_LSTM_DILATIONS = Object.freeze([1, 2, 4]);
export const TCN_LSTM_KERNEL_TAPS = 2;
export const TCN_LSTM_RECEPTIVE_FIELD = 1 +
  TCN_LSTM_KERNEL_TAPS * TCN_LSTM_DILATIONS.reduce((sum, value) => sum + value, 0);
export const TCN_LSTM_GATE_ORDER = 'INPUT_FORGET_OUTPUT_CANDIDATE';
export const TCN_LSTM_DROPOUT = 0;
export const TCN_LSTM_PARAMETER_COUNT =
  TCN_LSTM_INPUT_CHANNELS * TCN_LSTM_HIDDEN + TCN_LSTM_HIDDEN +
  TCN_LSTM_LAYERS * (
    TCN_LSTM_KERNEL_TAPS * TCN_LSTM_HIDDEN +
    TCN_LSTM_HIDDEN * TCN_LSTM_HIDDEN + TCN_LSTM_HIDDEN
  ) +
  TCN_LSTM_HIDDEN * (4 * TCN_LSTM_HIDDEN) +
  TCN_LSTM_HIDDEN * (4 * TCN_LSTM_HIDDEN) +
  4 * TCN_LSTM_HIDDEN +
  TCN_LSTM_HIDDEN + TCN_LSTM_STEPS +
  TCN_LSTM_HIDDEN + 1;
// The original count is the classifier/encoder BPTT parameter surface. The
// auxiliary pairwise head is fitted separately and is not part of that BPTT.
export const TCN_LSTM_CLASSIFIER_PARAMETER_COUNT = TCN_LSTM_PARAMETER_COUNT;
export const TCN_LSTM_RANKING_FEATURE_COUNT = 4 * TCN_LSTM_HIDDEN;
export const TCN_LSTM_RANKING_HEAD_PARAMETER_COUNT = TCN_LSTM_RANKING_FEATURE_COUNT;
export const TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT =
  TCN_LSTM_STEPS * TCN_LSTM_INPUT_CHANNELS;
export const TCN_LSTM_ORDERED_RANKING_FEATURE_SCHEMA_ID =
  'RADARX_TCN_LSTM_LOGISTIC_FULL_ORDERED_SEQUENCE_24X29_696_V1';
export const TCN_LSTM_RANKING_REPRESENTATIONS = Object.freeze([
  'LATENT_MULTI_SCALE_V2','RAW_ORDERED_696_V1'
]);
export const TCN_LSTM_TOTAL_PARAMETER_COUNT =
  TCN_LSTM_CLASSIFIER_PARAMETER_COUNT + TCN_LSTM_RANKING_HEAD_PARAMETER_COUNT;

const EPSILON = 1e-12;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOGIT_LIMIT = 30;
const SOFTMAX_LIMIT = 40;
const BASELINE_FEATURES = TCN_LSTM_INPUT_CHANNELS * 2;
const TCN_LSTM_RANKING_BUCKET_MS=15*60*1000;
const finite = value => typeof value === 'number' && Number.isFinite(value);

/**
 * Controlled research budget for the recurrent challenger. This cap changes
 * only the recent training window; selection, calibration, validation and
 * untouched holdout partitions remain disjoint and unchanged.
 */
export const TCN_LSTM_MAX_TRAINING_SAMPLES = 8192;
export function effectiveTcnLstmTrainingSampleBudget(
  requested=TCN_LSTM_MAX_TRAINING_SAMPLES,
  available=TCN_LSTM_MAX_TRAINING_SAMPLES
){
  const desired=finite(requested)&&requested>0
    ?Math.trunc(requested):TCN_LSTM_MAX_TRAINING_SAMPLES;
  const capacity=finite(available)&&available>=0
    ?Math.trunc(available):TCN_LSTM_MAX_TRAINING_SAMPLES;
  return Math.max(0,Math.min(
    TCN_LSTM_MAX_TRAINING_SAMPLES,desired,capacity
  ));
}

/**
 * Spread the bounded recurrent fit budget over the complete inner-training
 * chronology. Sampling keeps whole 15-minute decision buckets together so
 * cross-sectional ranking pairs remain valid. Later partitions are never read.
 */
export function selectChronologicalTcnLstmTrainingRows(
  trainingRows,
  maxTrainingSamples=TCN_LSTM_MAX_TRAINING_SAMPLES
){
  if(!Array.isArray(trainingRows))
    throw new TypeError('TCN_LSTM_TRAINING_ROWS_INVALID');
  const budget=effectiveTcnLstmTrainingSampleBudget(
    maxTrainingSamples,trainingRows.length
  );
  const ordered=[...trainingRows].sort((a,b)=>
    Number(a.at)-Number(b.at)||
    String(a.symbol??a.id??'').localeCompare(String(b.symbol??b.id??''))||
    String(a.id??'').localeCompare(String(b.id??''))
  );
  if(ordered.some(row=>!finite(row?.at)))
    throw new TypeError('TCN_LSTM_TRAINING_ROW_TIMESTAMP_INVALID');
  const bucketMap=new Map();
  for(const row of ordered){
    const bucketAt=Math.floor(Number(row.at)/TCN_LSTM_RANKING_BUCKET_MS)*
      TCN_LSTM_RANKING_BUCKET_MS;
    if(!bucketMap.has(bucketAt))bucketMap.set(bucketAt,[]);
    bucketMap.get(bucketAt).push(row);
  }
  const buckets=[...bucketMap.entries()].sort((a,b)=>a[0]-b[0]);
  const recentWindowFraction=0.35;
  const recentBudgetFraction=0.70;
  const recentStartIndex=Math.min(
    Math.max(0,buckets.length-1),
    Math.floor(buckets.length*(1-recentWindowFraction))
  );
  const evenIndices=(start,end,count,preferRecent)=>{
    if(count<=0||end<start)return [];
    if(count===1)return [preferRecent?end:start];
    return Array.from({length:count},(_,index)=>
      Math.round(start+index*(end-start)/(count-1))
    );
  };
  const diagnostics={
    method:'ALL_AVAILABLE_ROWS_WITHIN_BUDGET_V1',
    requested_budget:finite(maxTrainingSamples)?Number(maxTrainingSamples):TCN_LSTM_MAX_TRAINING_SAMPLES,
    effective_budget:budget,
    available_rows:ordered.length,
    selected_rows:ordered.length,
    available_decision_groups:buckets.length,
    selected_decision_groups:buckets.length,
    first_selected_bucket_at:buckets[0]?.[0]??null,
    last_selected_bucket_at:buckets.at(-1)?.[0]??null,
    sampled_across_full_training_chronology:true,
    complete_decision_groups:true,
    recent_window_fraction:recentWindowFraction,
    recent_budget_fraction:recentBudgetFraction,
    recent_window_start_bucket_at:buckets[recentStartIndex]?.[0]??null,
    recent_selected_decision_groups:buckets.length,
    older_selected_decision_groups:0,
    recent_selected_fraction:1,
    selected_bucket_min_rows:buckets.length?Math.min(...buckets.map(([,group])=>group.length)):0,
    selected_bucket_max_rows:buckets.length?Math.max(...buckets.map(([,group])=>group.length)):0
  };
  if(ordered.length<=budget)return {rows:ordered,diagnostics};
  if(budget===0)return {rows:[],diagnostics:{
    ...diagnostics,method:'ZERO_BUDGET_V1',selected_rows:0,
    selected_decision_groups:0,first_selected_bucket_at:null,
    last_selected_bucket_at:null,sampled_across_full_training_chronology:false,
    complete_decision_groups:false,recent_selected_decision_groups:0,
    older_selected_decision_groups:0,recent_selected_fraction:null,
    selected_bucket_min_rows:0,selected_bucket_max_rows:0
  }};

  const averageBucketSize=ordered.length/Math.max(1,buckets.length);
  let targetGroups=Math.max(1,Math.min(
    buckets.length,Math.floor(budget/averageBucketSize)
  ));
  let selectedBuckets=[];
  let selectedRows=[];
  let selectedOlderGroups=0;
  let selectedRecentGroups=0;
  let desiredRecentGroups=0;
  let spilloverToOlderGroups=0;
  let spilloverToRecentGroups=0;
  const recentGroupCapacity=buckets.length-recentStartIndex;
  const olderGroupCapacity=recentStartIndex;
  while(targetGroups>=1){
    // Reserve up to 70% for the newest 35% of the chronology, but never
    // discard budget when that recent window runs out of complete groups.
    // Reassign overflow to older groups first; only then use spare recent slots.
    const olderAvailable=recentStartIndex>0;
    desiredRecentGroups=olderAvailable&&targetGroups>1
      ?Math.min(targetGroups-1,Math.max(1,Math.ceil(targetGroups*recentBudgetFraction)))
      :targetGroups;
    const desiredOlderGroups=targetGroups-desiredRecentGroups;
    selectedRecentGroups=Math.min(recentGroupCapacity,desiredRecentGroups);
    selectedOlderGroups=Math.min(olderGroupCapacity,desiredOlderGroups);
    let unassignedGroups=targetGroups-selectedRecentGroups-selectedOlderGroups;
    spilloverToOlderGroups=Math.min(
      unassignedGroups,olderGroupCapacity-selectedOlderGroups
    );
    selectedOlderGroups+=spilloverToOlderGroups;
    unassignedGroups-=spilloverToOlderGroups;
    spilloverToRecentGroups=Math.min(
      unassignedGroups,recentGroupCapacity-selectedRecentGroups
    );
    selectedRecentGroups+=spilloverToRecentGroups;
    unassignedGroups-=spilloverToRecentGroups;
    if(unassignedGroups!==0)
      throw new Error('TCN_LSTM_TRAINING_BUCKET_CAPACITY_ALLOCATION_INVALID');
    const olderIndices=selectedOlderGroups>0
      ?evenIndices(0,recentStartIndex-1,selectedOlderGroups,false):[];
    const recentIndices=evenIndices(
      recentStartIndex,buckets.length-1,selectedRecentGroups,true
    );
    const indices=[...new Set([...olderIndices,...recentIndices])].sort((a,b)=>a-b);
    selectedBuckets=indices.map(index=>buckets[index]);
    selectedRows=selectedBuckets.flatMap(([,group])=>group);
    if(selectedRows.length<=budget)break;
    targetGroups--;
  }
  if(!selectedRows.length||selectedRows.length>budget){
    selectedRows=ordered.slice(-budget);
    const fallbackGroups=new Map();
    for(const row of selectedRows){
      const key=Math.floor(Number(row.at)/TCN_LSTM_RANKING_BUCKET_MS)*
        TCN_LSTM_RANKING_BUCKET_MS;
      if(!fallbackGroups.has(key))fallbackGroups.set(key,[]);
      fallbackGroups.get(key).push(row);
    }
    const fallback=[...fallbackGroups.entries()].sort((a,b)=>a[0]-b[0]);
    return {rows:selectedRows,diagnostics:{
      ...diagnostics,method:'RECENT_PARTIAL_BUCKET_FALLBACK_V1',
      selected_rows:selectedRows.length,selected_decision_groups:fallback.length,
      first_selected_bucket_at:fallback[0]?.[0]??null,
      last_selected_bucket_at:fallback.at(-1)?.[0]??null,
      sampled_across_full_training_chronology:false,complete_decision_groups:false,
      recent_selected_decision_groups:fallback.filter(([at])=>at>=
        (buckets[recentStartIndex]?.[0]??Infinity)).length,
      older_selected_decision_groups:fallback.filter(([at])=>at<
        (buckets[recentStartIndex]?.[0]??Infinity)).length,
      recent_selected_fraction:fallback.length
        ?fallback.filter(([at])=>at>=(buckets[recentStartIndex]?.[0]??Infinity)).length/fallback.length:null,
      selected_bucket_min_rows:fallback.length?Math.min(...fallback.map(([,g])=>g.length)):0,
      selected_bucket_max_rows:fallback.length?Math.max(...fallback.map(([,g])=>g.length)):0
    }};
  }
  selectedRows.sort((a,b)=>Number(a.at)-Number(b.at)||
    String(a.symbol??a.id??'').localeCompare(String(b.symbol??b.id??''))||
    String(a.id??'').localeCompare(String(b.id??''))
  );
  const recentSelected=selectedBuckets.filter(([at])=>
    at>=(buckets[recentStartIndex]?.[0]??Infinity)
  ).length;
  const olderSelected=selectedBuckets.length-recentSelected;
  return {rows:selectedRows,diagnostics:{
    ...diagnostics,
    method:'RECENCY_WEIGHTED_COMPLETE_15M_DECISION_BUCKETS_V1',
    selected_rows:selectedRows.length,
    selected_decision_groups:selectedBuckets.length,
    first_selected_bucket_at:selectedBuckets[0]?.[0]??null,
    last_selected_bucket_at:selectedBuckets.at(-1)?.[0]??null,
    sampled_across_full_training_chronology:
      selectedBuckets.length>1&&selectedBuckets[0]?.[0]===buckets[0]?.[0]&&
      selectedBuckets.at(-1)?.[0]===buckets.at(-1)?.[0],
    complete_decision_groups:true,
    recent_selected_decision_groups:recentSelected,
    older_selected_decision_groups:olderSelected,
    recent_selected_fraction:selectedBuckets.length?recentSelected/selectedBuckets.length:null,
    desired_recent_decision_groups:desiredRecentGroups,
    recent_decision_group_capacity:recentGroupCapacity,
    recent_capacity_limited:desiredRecentGroups>recentGroupCapacity,
    spillover_selected_older_decision_groups:spilloverToOlderGroups,
    spillover_selected_recent_decision_groups:spilloverToRecentGroups,
    selected_bucket_min_rows:Math.min(...selectedBuckets.map(([,group])=>group.length)),
    selected_bucket_max_rows:Math.max(...selectedBuckets.map(([,group])=>group.length))
  }};
}
/**
 * Split an already representation-OOS execution-head cohort into an earlier
 * Hurdle fit block, a complete forward-label-maturity purge, and a later
 * probability-calibration block. The returned indexes refer to the original
 * rows/net-return vectors and are never derived from inner-selection outcomes.
 */
export function splitTcnLstmHurdleProbabilityCalibrationRows(rows, netReturns, {
  horizonMs = 4 * 60 * 60 * 1000,
  bucketMs = TCN_LSTM_RANKING_BUCKET_MS,
  calibrationGroupFraction = 0.20,
  minimumTrainingGroups = 20,
  minimumCalibrationGroups = 8,
  minimumClassRows = 8
} = {}) {
  if (!Array.isArray(rows) || !Array.isArray(netReturns) ||
      rows.length !== netReturns.length || !finite(horizonMs) || horizonMs <= 0 ||
      !finite(bucketMs) || bucketMs <= 0 ||
      !finite(calibrationGroupFraction) || calibrationGroupFraction <= 0 ||
      calibrationGroupFraction >= 0.5 ||
      !Number.isInteger(minimumTrainingGroups) || minimumTrainingGroups < 1 ||
      !Number.isInteger(minimumCalibrationGroups) || minimumCalibrationGroups < 1 ||
      !Number.isInteger(minimumClassRows) || minimumClassRows < 1 ||
      rows.some((row, index) => !row || !finite(row.at) ||
        !finite(row.resolved_at) || row.resolved_at <= row.at ||
        row.resolved_at > Number(row.at) + Number(horizonMs) ||
        !finite(netReturns[index]))) {
    throw new TypeError('HURDLE_PROBABILITY_CALIBRATION_SPLIT_INPUT_INVALID');
  }
  const ordered = rows.map((row, index) => ({row, index, net:Number(netReturns[index])}))
    .sort((a, b) => Number(a.row.at) - Number(b.row.at) ||
      String(a.row.symbol ?? a.row.id ?? '').localeCompare(String(b.row.symbol ?? b.row.id ?? '')) ||
      sampleIdentity(a.row).localeCompare(sampleIdentity(b.row)));
  const identities = ordered.map(item => sampleIdentity(item.row));
  if (new Set(identities).size !== identities.length)
    throw new TypeError('HURDLE_PROBABILITY_CALIBRATION_DUPLICATE_IDENTITY');

  const groupsByBucket = new Map();
  for (const item of ordered) {
    const bucketAt = Math.floor(Number(item.row.at) / bucketMs) * bucketMs;
    if (!groupsByBucket.has(bucketAt)) groupsByBucket.set(bucketAt, []);
    groupsByBucket.get(bucketAt).push(item);
  }
  const groups = [...groupsByBucket.entries()].sort((a, b) => a[0] - b[0])
    .map(([bucketAt, items]) => ({bucket_at:bucketAt, items}));
  const diagnosticBase = {
    schema:'RADARX_HURDLE_PURGED_EXECUTION_HEAD_PROBABILITY_CALIBRATION_SPLIT_V1',
    source_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK_ONLY',
    horizon_ms:Number(horizonMs),
    bucket_ms:Number(bucketMs),
    calibration_group_fraction:Number(calibrationGroupFraction),
    available_decision_groups:groups.length,
    validation_or_holdout_used:false
  };
  const unavailable = (reason, extra={}) => ({
    status:'UNAVAILABLE', reason,
    training_indexes:[], calibration_indexes:[], purged_indexes:[],
    diagnostics:{...diagnosticBase,status:'UNAVAILABLE',reason,...extra}
  });
  if (groups.length < minimumTrainingGroups + minimumCalibrationGroups + 1)
    return unavailable('INSUFFICIENT_DECISION_GROUPS_FOR_PURGED_HURDLE_CALIBRATION');

  const calibrationGroupCount = Math.max(
    minimumCalibrationGroups, Math.ceil(groups.length * calibrationGroupFraction)
  );
  if (calibrationGroupCount >= groups.length)
    return unavailable('HURDLE_CALIBRATION_GROUP_ALLOCATION_INVALID');
  const calibrationGroups = groups.slice(-calibrationGroupCount);
  const calibrationMinAt = Math.min(...calibrationGroups.flatMap(group =>
    group.items.map(item => Number(item.row.at))
  ));
  const earlierGroups = groups.slice(0, -calibrationGroupCount);
  const trainingGroups = earlierGroups.filter(group =>
    group.items.every(item =>
      Number(item.row.resolved_at) < calibrationMinAt &&
      Number(item.row.at) <= calibrationMinAt - horizonMs
    )
  );
  const trainingGroupSet = new Set(trainingGroups);
  const purgedGroups = earlierGroups.filter(group => !trainingGroupSet.has(group));
  const trainingItems = trainingGroups.flatMap(group => group.items);
  const calibrationItems = calibrationGroups.flatMap(group => group.items);
  const purgedItems = purgedGroups.flatMap(group => group.items);
  const trainingIndexes = trainingItems.map(item => item.index);
  const calibrationIndexes = calibrationItems.map(item => item.index);
  const purgedIndexes = purgedItems.map(item => item.index);
  const groupSizes = groups.map(group => group.items.length);
  const completeGroups = groupSizes.every(size => size === groupSizes[0]) &&
    groups.every(group => {
      const symbols = group.items.map(item => String(item.row.symbol ?? ''));
      return symbols.every(Boolean) && new Set(symbols).size === symbols.length;
    });
  const forwardHorizonValid = ordered.every(item =>
    Number(item.row.resolved_at) > Number(item.row.at) &&
    Number(item.row.resolved_at) <= Number(item.row.at) + Number(horizonMs)
  );
  const support = items => {
    const positive = items.filter(item => item.net > 0).length;
    return {rows:items.length,positive,non_positive:items.length-positive};
  };
  const trainingSupport = support(trainingItems);
  const calibrationSupport = support(calibrationItems);
  const trainingMaxResolvedAt = trainingItems.length
    ? Math.max(...trainingItems.map(item => Number(item.row.resolved_at))) : null;
  const trainingMaxAt = trainingItems.length
    ? Math.max(...trainingItems.map(item => Number(item.row.at))) : null;
  const calibrationMinRowAt = calibrationItems.length
    ? Math.min(...calibrationItems.map(item => Number(item.row.at))) : null;
  const trainingIds = new Set(trainingItems.map(item => sampleIdentity(item.row)));
  const calibrationIds = new Set(calibrationItems.map(item => sampleIdentity(item.row)));
  const identitiesDisjoint = [...calibrationIds].every(id => !trainingIds.has(id));
  const chronologyValid = forwardHorizonValid && completeGroups &&
    trainingGroups.length >= minimumTrainingGroups &&
    calibrationGroups.length >= minimumCalibrationGroups &&
    trainingMaxResolvedAt < calibrationMinRowAt &&
    calibrationMinRowAt - trainingMaxAt >= horizonMs &&
    identitiesDisjoint &&
    trainingSupport.positive >= minimumClassRows &&
    trainingSupport.non_positive >= minimumClassRows &&
    calibrationSupport.positive >= minimumClassRows &&
    calibrationSupport.non_positive >= minimumClassRows;
  const diagnostics = {
    ...diagnosticBase,
    status:chronologyValid?'READY':'UNAVAILABLE',
    training_groups:trainingGroups.length,
    purged_groups:purgedGroups.length,
    calibration_groups:calibrationGroups.length,
    training_rows:trainingItems.length,
    purged_rows:purgedItems.length,
    calibration_rows:calibrationItems.length,
    training_net_return_support:trainingSupport,
    calibration_net_return_support:calibrationSupport,
    training_max_at:trainingMaxAt,
    training_max_resolved_at:trainingMaxResolvedAt,
    calibration_min_at:calibrationMinRowAt,
    resolved_label_gap_ms:trainingMaxResolvedAt===null?null:
      calibrationMinRowAt-trainingMaxResolvedAt,
    training_decision_time_gap_ms:trainingMaxAt===null?null:
      calibrationMinRowAt-trainingMaxAt,
    forward_label_horizon_valid:forwardHorizonValid,
    complete_decision_groups:completeGroups,
    chronology_valid:chronologyValid,
    disjoint_sample_identities:identitiesDisjoint,
    validation_or_holdout_used:false
  };
  if (!chronologyValid)
    return unavailable('HURDLE_CALIBRATION_SUPPORT_OR_CHRONOLOGY_FAILED',diagnostics);
  return {
    status:'READY',reason:null,
    training_indexes:trainingIndexes,
    calibration_indexes:calibrationIndexes,
    purged_indexes:purgedIndexes,
    diagnostics
  };
}

export function splitTcnLstmTrainingRowsForExecutionHead(rows,{
  executionHeadFraction=0.40,minimumModelTrainingRows=20,minimumExecutionHeadRows=20
}={}){
  if(!Array.isArray(rows)||!finite(executionHeadFraction)||
    executionHeadFraction<=0||executionHeadFraction>=0.5||
    !Number.isInteger(minimumModelTrainingRows)||minimumModelTrainingRows<20||
    !Number.isInteger(minimumExecutionHeadRows)||minimumExecutionHeadRows<20)
    throw new TypeError('TCN_LSTM_EXECUTION_HEAD_SPLIT_CONFIGURATION_INVALID');
  const ordered=[...rows].sort((a,b)=>
    Number(a.at)-Number(b.at)||
    String(a.symbol??a.id??'').localeCompare(String(b.symbol??b.id??''))||
    String(a.id??'').localeCompare(String(b.id??''))
  );
  ordered.forEach((row,index)=>validateRow(row,index));
  const groups=new Map();
  for(const row of ordered){
    const bucketAt=Math.floor(Number(row.at)/TCN_LSTM_RANKING_BUCKET_MS)*
      TCN_LSTM_RANKING_BUCKET_MS;
    if(!groups.has(bucketAt))groups.set(bucketAt,[]);
    groups.get(bucketAt).push(row);
  }
  const buckets=[...groups.entries()].sort((a,b)=>a[0]-b[0]);
  const baseDiagnostics={
    schema:'RADARX_TCN_LSTM_PURGED_EXECUTION_HEAD_SPLIT_V1',
    execution_head_fraction:Number(executionHeadFraction),
    available_rows:ordered.length,
    available_decision_groups:buckets.length,
    split_method:'LATEST_COMPLETE_15M_GROUPS_WITH_FORWARD_LABEL_PURGE',
    source_partition:'INNER_TRAINING_PARTITION_ONLY',
    validation_or_holdout_used:false
  };
  const unavailable=(reason,extra={})=>({
    status:'UNAVAILABLE',
    reason,
    model_training_rows:ordered,
    execution_head_rows:null,
    purged_rows:[],
    diagnostics:{
      ...baseDiagnostics,status:'UNAVAILABLE',reason,
      model_training_rows:ordered.length,execution_head_rows:0,
      purged_rows:0,chronology_valid:false,representation_out_of_sample:false,
      ...extra
    }
  });
  if(buckets.length<2)
    return unavailable('INSUFFICIENT_DECISION_GROUPS_FOR_TEMPORAL_HEAD_FIT');
  const executionGroupCount=Math.max(1,Math.ceil(
    buckets.length*executionHeadFraction
  ));
  const splitIndex=buckets.length-executionGroupCount;
  if(splitIndex<1)
    return unavailable('INSUFFICIENT_EARLIER_GROUPS_FOR_MODEL_FIT');
  const executionHeadRows=buckets.slice(splitIndex).flatMap(([,group])=>group);
  if(executionHeadRows.some(row=>!finite(row.realized_return_pct)||
    !finite(row.max_adverse_excursion_pct)))
    return unavailable('EXECUTION_HEAD_OUTCOMES_INCOMPLETE');
  const executionHeadStartAt=Math.min(...executionHeadRows.map(row=>Number(row.at)));
  const earlierBuckets=buckets.slice(0,splitIndex);
  const retainedModelBuckets=earlierBuckets.filter(([,group])=>
    group.every(row=>Number(row.resolved_at)<executionHeadStartAt)
  );
  const purgedModelBuckets=earlierBuckets.filter(([,group])=>
    !group.every(row=>Number(row.resolved_at)<executionHeadStartAt)
  );
  const modelTrainingRows=retainedModelBuckets.flatMap(([,group])=>group);
  const purgedRows=purgedModelBuckets.flatMap(([,group])=>group);
  const modelSupport={
    rows:modelTrainingRows.length,
    positives:modelTrainingRows.filter(row=>row.target===1).length,
    negatives:modelTrainingRows.filter(row=>row.target===0).length
  };
  const headSupport={
    rows:executionHeadRows.length,
    positives:executionHeadRows.filter(row=>row.target===1).length,
    negatives:executionHeadRows.filter(row=>row.target===0).length
  };
  const modelMaxResolvedAt=modelTrainingRows.length
    ?Math.max(...modelTrainingRows.map(row=>Number(row.resolved_at))):null;
  const headMinAt=executionHeadRows.length
    ?Math.min(...executionHeadRows.map(row=>Number(row.at))):null;
  const ready=modelTrainingRows.length>=minimumModelTrainingRows&&
    headSupport.rows>=minimumExecutionHeadRows&&
    modelSupport.positives>=2&&modelSupport.negatives>=2&&
    headSupport.positives>=2&&headSupport.negatives>=2&&
    finite(modelMaxResolvedAt)&&finite(headMinAt)&&modelMaxResolvedAt<headMinAt;
  const diagnostics={
    ...baseDiagnostics,status:ready?'READY':'UNAVAILABLE',
    decision_boundary_at:headMinAt,
    model_training_rows:modelSupport.rows,
    execution_head_rows:headSupport.rows,
    purged_rows:purgedRows.length,
    model_training_support:modelSupport,
    execution_head_support:headSupport,
    model_training_max_resolved_at:modelMaxResolvedAt,
    execution_head_min_at:headMinAt,
    purge_gap_ms:finite(modelMaxResolvedAt)&&finite(headMinAt)
      ?headMinAt-modelMaxResolvedAt:null,
    chronology_valid:ready,
    complete_decision_groups:true,
    representation_out_of_sample:ready,
    disjoint_sample_identities:!modelTrainingRows.some(row=>
      executionHeadRows.some(head=>sampleIdentity(row)===sampleIdentity(head))
    )
  };
  if(!ready)
    return unavailable('EXECUTION_HEAD_SPLIT_SUPPORT_OR_PURGE_FAILED',diagnostics);
  if(modelTrainingRows.some(row=>
    executionHeadRows.some(head=>sampleIdentity(row)===sampleIdentity(head))
  ))
    return unavailable('EXECUTION_HEAD_SPLIT_IDENTITY_OVERLAP',diagnostics);
  return {
    status:'READY',reason:null,model_training_rows:modelTrainingRows,
    execution_head_rows:executionHeadRows,purged_rows:purgedRows,diagnostics
  };
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const sigmoid = value => 1 / (1 + Math.exp(-clamp(value, -LOGIT_LIMIT, LOGIT_LIMIT)));
const tanh = Math.tanh;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function validateSequence(sequence) {
  if (!Array.isArray(sequence) || sequence.length !== TCN_LSTM_STEPS)
    throw new TypeError('TCN_LSTM_SEQUENCE_STEP_COUNT_INVALID');
  for (let step = 0; step < TCN_LSTM_STEPS; step++) {
    const row = sequence[step];
    if (!Array.isArray(row) || row.length !== TCN_LSTM_INPUT_CHANNELS)
      throw new TypeError('TCN_LSTM_SEQUENCE_CHANNEL_COUNT_INVALID:' + step);
    for (let channel = 0; channel < TCN_LSTM_INPUT_CHANNELS; channel++) {
      const value = row[channel];
      if (!finite(value) || Math.abs(value) > 4)
        throw new TypeError('TCN_LSTM_SEQUENCE_VALUE_INVALID:' + step + ':' + channel);
    }
  }
  return true;
}

function sampleIdentity(row) {
  const id = String(row?.id ?? '').trim();
  if (id) return id;
  const symbol = String(row?.symbol ?? '').trim().toUpperCase();
  if (symbol && finite(row?.at)) return symbol + ':' + row.at;
  throw new TypeError('TCN_LSTM_SAMPLE_IDENTITY_MISSING');
}
function trainingFingerprint(rows) {
  const identities = rows.map(sampleIdentity).sort();
  if (new Set(identities).size !== identities.length)
    throw new TypeError('TCN_LSTM_DUPLICATE_TRAINING_IDENTITY');
  return createHash('sha256').update(identities.join('\n'), 'utf8').digest('hex');
}

function validateRow(row, index, requireTarget = true) {
  if (!row || typeof row !== 'object' || Array.isArray(row))
    throw new TypeError('TCN_LSTM_ROW_INVALID:' + index);
  validateSequence(row.sequence);
  if (requireTarget && row.target !== 0 && row.target !== 1)
    throw new TypeError('TCN_LSTM_TARGET_INVALID:' + index);
  if (row.at !== undefined && !finite(row.at))
    throw new TypeError('TCN_LSTM_EVENT_TIME_INVALID:' + index);
  const timestamps = row.temporal_sequence_timestamps ?? row.sequence_timestamps;
  if (timestamps !== undefined) {
    if (!Array.isArray(timestamps) || timestamps.length !== TCN_LSTM_STEPS ||
        timestamps.some(value => !finite(value)) ||
        (row.at !== undefined && timestamps.at(-1) !== row.at))
      throw new TypeError('TCN_LSTM_TIMESTAMP_VECTOR_INVALID:' + index);
    for (let step = 1; step < timestamps.length; step++) {
      if (timestamps[step] - timestamps[step - 1] !== 900000)
        throw new TypeError('TCN_LSTM_TIMESTAMP_CADENCE_INVALID:' + index + ':' + step);
    }
  }
  return true;
}

/**
 * Create disjoint TCN-LSTM inner partitions strictly inside an already
 * validated outer training cohort. External validation rows are inspected
 * for sequence/timestamp shape and the first timestamp only; their labels are
 * never read. The four-hour label-maturity purge is applied at all boundaries.
 */
export function splitFourHourTcnLstmTrainingRows(outerTrainingRows,externalValidationRows,{
  horizonMs=4*60*60*1000,trainingFraction=0.62,selectionFraction=0.82,
  minimumUniqueDays=20,minimumPartitionRows=20
}={}){
  if(!Array.isArray(outerTrainingRows)||!Array.isArray(externalValidationRows)||
    !finite(horizonMs)||horizonMs<=0||
    !finite(trainingFraction)||!finite(selectionFraction)||
    trainingFraction<=0.5||selectionFraction<=trainingFraction||selectionFraction>=0.95||
    !Number.isInteger(minimumUniqueDays)||minimumUniqueDays<10||
    !Number.isInteger(minimumPartitionRows)||minimumPartitionRows<20)
    throw new TypeError('TCN_LSTM_FOUR_HOUR_PARTITION_CONFIGURATION_INVALID');
  outerTrainingRows.forEach((row,index)=>validateRow(row,index,true));
  externalValidationRows.forEach((row,index)=>validateRow(row,index,false));
  const trainingIds=outerTrainingRows.map(sampleIdentity);
  const externalIds=externalValidationRows.map(sampleIdentity);
  if(new Set(trainingIds).size!==trainingIds.length||
    new Set(externalIds).size!==externalIds.length)
    throw new TypeError('TCN_LSTM_FOUR_HOUR_PARTITION_DUPLICATE_IDENTITY');
  const trainingIdSet=new Set(trainingIds);
  if(externalIds.some(id=>trainingIdSet.has(id)))
    throw new TypeError('TCN_LSTM_FOUR_HOUR_PARTITION_OUTER_IDENTITY_OVERLAP');
  const outerTrainingMaxResolvedAt=Math.max(...outerTrainingRows.map(row=>row.resolved_at));
  const externalValidationStartAt=Math.min(...externalValidationRows.map(row=>row.at));
  if(!(outerTrainingMaxResolvedAt<externalValidationStartAt))
    return {
      status:'ABSTAIN_OUTER_TRAIN_VALIDATION_PURGE_FAILED',
      reason:'OUTER_TRAINING_LABELS_OVERLAP_EXTERNAL_VALIDATION',
      outer_training_max_resolved_at:outerTrainingMaxResolvedAt,
      external_validation_start_at:externalValidationStartAt,
      partitions:{training:[],selection:[],calibration:[]}
    };
  if(outerTrainingRows.some(row=>row.resolved_at-row.at!==horizonMs))
    return {
      status:'ABSTAIN_FOUR_HOUR_LABEL_MATURITY_MISMATCH',
      reason:'OUTER_TRAIN_ROWS_DO_NOT_MATCH_EXACT_FOUR_HOUR_MATURITY',
      partitions:{training:[],selection:[],calibration:[]}
    };
  const rows=[...outerTrainingRows].sort((a,b)=>a.at-b.at||
    String(a.symbol||'').localeCompare(String(b.symbol||''))||
    sampleIdentity(a).localeCompare(sampleIdentity(b)));
  const days=[...new Set(rows.map(row=>Math.floor(row.at/86_400_000)*86_400_000))]
    .sort((a,b)=>a-b);
  if(days.length<minimumUniqueDays)
    return {
      status:'ABSTAIN_INTERNAL_UNIQUE_DAY_SUPPORT_TOO_SMALL',
      reason:'FOUR_HOUR_LSTM_INTERNAL_UNIQUE_DAY_SUPPORT_TOO_SMALL',
      unique_training_days:days.length,required_unique_training_days:minimumUniqueDays,
      partitions:{training:[],selection:[],calibration:[]}
    };
  const fitCut=days[Math.floor(days.length*trainingFraction)];
  const selectionCut=days[Math.floor(days.length*selectionFraction)];
  const training=rows.filter(row=>row.at<fitCut&&row.resolved_at<fitCut);
  const selection=rows.filter(row=>
    row.at>=fitCut+horizonMs&&row.at<selectionCut&&row.resolved_at<selectionCut);
  const calibration=rows.filter(row=>
    row.at>=selectionCut+horizonMs&&row.resolved_at<externalValidationStartAt);
  const maxResolved=part=>part.length?Math.max(...part.map(row=>row.resolved_at)):null;
  const minAt=part=>part.length?Math.min(...part.map(row=>row.at)):null;
  const support=part=>{
    const positive=part.filter(row=>row.target===1).length;
    return {rows:part.length,positive,negative:part.length-positive};
  };
  const partitions={training,selection,calibration};
  const supportByPartition=Object.fromEntries(Object.entries(partitions).map(([name,part])=>
    [name,support(part)]));
  const boundariesValid=training.length>0&&selection.length>0&&calibration.length>0&&
    maxResolved(training)<minAt(selection)&&
    maxResolved(selection)<minAt(calibration)&&
    maxResolved(calibration)<externalValidationStartAt;
  const supportValid=Object.values(supportByPartition).every(item=>
    item.rows>=minimumPartitionRows&&item.positive>=2&&item.negative>=2);
  const allIds=[...training,...selection,...calibration].map(sampleIdentity);
  const identitiesValid=new Set(allIds).size===allIds.length&&
    allIds.every(id=>trainingIdSet.has(id));
  if(!boundariesValid||!supportValid||!identitiesValid)
    return {
      status:'ABSTAIN_INTERNAL_PURGE_OR_CLASS_SUPPORT_FAILED',
      reason:!boundariesValid?'INTERNAL_FOUR_HOUR_MATURITY_PURGE_FAILED':
        !supportValid?'INTERNAL_LSTM_PARTITION_CLASS_SUPPORT_FAILED':
        'INTERNAL_LSTM_PARTITION_IDENTITY_FAILED',
      unique_training_days:days.length,
      split_boundaries:{fit_cut_at:fitCut,selection_cut_at:selectionCut,
        external_validation_start_at:externalValidationStartAt,
        training_max_resolved_at:maxResolved(training),
        selection_max_resolved_at:maxResolved(selection),
        calibration_max_resolved_at:maxResolved(calibration)},
      support:supportByPartition,
      chronology_valid:boundariesValid,
      identities_valid:identitiesValid,
      partitions
    };
  return {
    status:'READY',
    schema:'RADARX_TCN_LSTM_FOUR_HOUR_PURGED_INNER_SPLIT_V1',
    horizon_ms:horizonMs,
    unique_training_days:days.length,
    split_boundaries:{
      fit_cut_at:fitCut,selection_cut_at:selectionCut,
      external_validation_start_at:externalValidationStartAt,
      training_max_resolved_at:maxResolved(training),
      selection_max_resolved_at:maxResolved(selection),
      calibration_max_resolved_at:maxResolved(calibration)
    },
    support:supportByPartition,
    chronology_valid:true,
    identities_valid:true,
    external_validation_labels_read:false,
    partitions
  };
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function buildTcnLstmAnchorFeatures(sequence) {
  validateSequence(sequence);
  const means = Array(TCN_LSTM_INPUT_CHANNELS).fill(0);
  const variances = Array(TCN_LSTM_INPUT_CHANNELS).fill(0);
  for (const row of sequence) {
    for (let channel = 0; channel < TCN_LSTM_INPUT_CHANNELS; channel++)
      means[channel] += row[channel] / TCN_LSTM_STEPS;
  }
  for (const row of sequence) {
    for (let channel = 0; channel < TCN_LSTM_INPUT_CHANNELS; channel++)
      variances[channel] += (row[channel] - means[channel]) ** 2 / TCN_LSTM_STEPS;
  }
  return means.concat(variances.map(value => Math.sqrt(Math.max(0, value))));
}

/**
 * Preserve every closed temporal input value in chronological row-major order.
 * This is the full-information linear Logistic comparator for the 24x29 TCN
 * input; unlike the 58-value pooled anchor it does not discard within-window
 * time position. The caller fits normalization separately inside each
 * chronological training fold.
 */
export function buildTcnLstmFlattenedFeatures(sequence) {
  validateSequence(sequence);
  return sequence.flatMap(row=>row.map(Number));
}

export function fitTcnLstmLogisticAnchor(rows, {
  iterations = 300, learningRate = 0.04, l2 = 0.04
} = {}) {
  if (!Array.isArray(rows) || rows.length < 20)
    throw new TypeError('TCN_LSTM_LOGISTIC_TRAINING_SUPPORT_TOO_SMALL');
  rows.forEach((row, index) => validateRow(row, index));
  const features = rows.map(row => buildTcnLstmAnchorFeatures(row.sequence));
  const targets = rows.map(row => row.target);
  const positive = targets.reduce((sum, target) => sum + target, 0);
  const negative = targets.length - positive;
  if (positive < 2 || negative < 2)
    throw new TypeError('TCN_LSTM_LOGISTIC_ANCHOR_CLASS_SUPPORT_TOO_SMALL');
  const rate = clamp(Number(learningRate) || 0.04, 0.001, 0.15);
  const regularization = clamp(Number(l2) || 0.04, 0.0001, 1);
  const steps = Math.max(50, Math.min(1000, Math.trunc(Number(iterations) || 300)));
  const weights = Array(BASELINE_FEATURES).fill(0);
  const baseRate = (positive + 2) / (rows.length + 4);
  let bias = Math.log(baseRate / (1 - baseRate));
  for (let step = 0; step < steps; step++) {
    const gradient = Array(BASELINE_FEATURES).fill(0);
    let biasGradient = 0;
    for (let row = 0; row < features.length; row++) {
      let logit = bias;
      for (let feature = 0; feature < BASELINE_FEATURES; feature++)
        logit += weights[feature] * features[row][feature];
      const error = sigmoid(logit) - targets[row];
      biasGradient += error;
      for (let feature = 0; feature < BASELINE_FEATURES; feature++)
        gradient[feature] += error * features[row][feature];
    }
    bias -= rate * biasGradient / rows.length;
    for (let feature = 0; feature < BASELINE_FEATURES; feature++) {
      const update = gradient[feature] / rows.length + regularization * weights[feature];
      weights[feature] = clamp(weights[feature] - rate * update, -8, 8);
    }
  }
  if (!finite(bias) || weights.some(value => !finite(value)))
    throw new TypeError('TCN_LSTM_LOGISTIC_ANCHOR_NON_FINITE');
  return {
    kind: 'TCN_LSTM_FROZEN_POOLED_LOGISTIC_ANCHOR_V1',
    weights, bias, base_rate: baseRate,
    training_rows: rows.length,
    training_fingerprint: trainingFingerprint(rows),
    positive_rows: positive,
    negative_rows: negative,
    feature_count: BASELINE_FEATURES,
    fit_boundary: 'TRAINING_PARTITION_ONLY'
  };
}

export function predictTcnLstmLogisticLogit(sequence, anchor) {
  validateSequence(sequence);
  if (!anchor || !Array.isArray(anchor.weights) ||
      anchor.weights.length !== BASELINE_FEATURES ||
      anchor.weights.some(value => !finite(value)) || !finite(anchor.bias))
    throw new TypeError('TCN_LSTM_LOGISTIC_ANCHOR_INVALID');
  const features = buildTcnLstmAnchorFeatures(sequence);
  let logit = anchor.bias;
  for (let feature = 0; feature < BASELINE_FEATURES; feature++)
    logit += anchor.weights[feature] * features[feature];
  if (!finite(logit)) throw new TypeError('TCN_LSTM_LOGISTIC_LOGIT_NON_FINITE');
  return clamp(logit, -LOGIT_LIMIT, LOGIT_LIMIT);
}

function resolveTcnLstmRowClassifierBaselineLogit(row,anchor){
  if(Object.prototype.hasOwnProperty.call(row??{},'classifier_baseline_logit')){
    if(!finite(row.classifier_baseline_logit))
      throw new TypeError('TCN_LSTM_CLASSIFIER_BASELINE_ROW_LOGIT_INVALID');
    return clamp(Number(row.classifier_baseline_logit),-LOGIT_LIMIT,LOGIT_LIMIT);
  }
  return predictTcnLstmLogisticLogit(row.sequence,anchor);
}

function resolveTcnLstmProfileClassifierBaselineLogit(sequence,profile,explicitLogit=null){
  if(finite(explicitLogit))
    return clamp(Number(explicitLogit),-LOGIT_LIMIT,LOGIT_LIMIT);
  const externalModel=profile?.execution_logistic_context_model??null;
  const externalSchema=profile?.execution_logistic_context_metadata?.logistic_feature_schema_id;
  if(externalSchema===TCN_LSTM_FULL_SEQUENCE_LOGISTIC_FEATURE_SCHEMA_ID&&
    externalModel?.training_partition_only===true&&externalModel?.standardizer&&externalModel?.fit){
    const probability=predictTemporalLogisticProbability(
      buildTcnLstmFlattenedFeatures(sequence),externalModel
    );
    const bounded=clamp(Number(probability),1e-9,1-1e-9);
    return clamp(Math.log(bounded/(1-bounded)),-LOGIT_LIMIT,LOGIT_LIMIT);
  }
  return predictTcnLstmLogisticLogit(sequence,profile?.baseline_fit);
}

export const TCN_LSTM_FULL_SEQUENCE_LOGISTIC_FEATURE_SCHEMA_ID =
  'RADARX_TCN_LSTM_LOGISTIC_FULL_ORDERED_SEQUENCE_24X29_696_V1';
export const TCN_LSTM_FULL_SEQUENCE_LOGISTIC_FEATURE_COUNT =
  TCN_LSTM_STEPS * TCN_LSTM_INPUT_CHANNELS;

/**
 * Resolve the inner-selection Logistic reference without substituting the
 * older pooled 58-value anchor when promotion requires the full 696-value
 * ordered temporal representation. External raw logits are produced only by
 * a Logistic model fitted on the earlier purged model-training partition.
 */
export function resolveTcnLstmInnerSelectionLogisticBaseline(selectionRows,
  scoringRows,{
    anchor=null,featureSchemaId=null,featureNames=null,
    requireFullSequenceLogistic=false
  }={}
){
  if(!Array.isArray(selectionRows)||selectionRows.length===0||
    !Array.isArray(scoringRows))
    throw new TypeError('TCN_LSTM_INNER_LOGISTIC_BASELINE_ROWS_INVALID');
  const fullSequenceContract=
    featureSchemaId===TCN_LSTM_FULL_SEQUENCE_LOGISTIC_FEATURE_SCHEMA_ID&&
    Array.isArray(featureNames)&&
    featureNames.length===TCN_LSTM_FULL_SEQUENCE_LOGISTIC_FEATURE_COUNT&&
    scoringRows.length===selectionRows.length;
  if(fullSequenceContract){
    const byId=new Map();
    for(const row of scoringRows){
      const id=String(row?.id??'');
      if(!id||byId.has(id)||!finite(row?.at)||
        !finite(row?.external_logistic_raw_logit))
        throw new TypeError('TCN_LSTM_INNER_LOGISTIC_RAW_SCORE_INVALID:'+id);
      byId.set(id,{
        at:Number(row.at),logit:Number(row.external_logistic_raw_logit)
      });
    }
    const logits=selectionRows.map(row=>{
      const id=String(row?.id??''),score=byId.get(id);
      if(!score||score.at!==Number(row.at))
        throw new TypeError('TCN_LSTM_INNER_LOGISTIC_ROW_ALIGNMENT_FAILED:'+id);
      return score.logit;
    });
    return {
      source:'TUNED_FULL_ORDERED_TEMPORAL_LOGISTIC_696_RAW',
      feature_schema_id:featureSchemaId,
      feature_count:TCN_LSTM_FULL_SEQUENCE_LOGISTIC_FEATURE_COUNT,
      probability_stage:'RAW_UNCALIBRATED',
      fit_partition:'PRE_EXECUTION_HEAD_MODEL_TRAINING_ROWS_ONLY',
      scoring_partition:'PURGED_INNER_SELECTION_ONLY',
      holdout_values_used:false,
      logits
    };
  }
  if(requireFullSequenceLogistic)
    throw new Error('TCN_LSTM_FULL_ORDERED_LOGISTIC_SELECTION_BASELINE_REQUIRED');
  if(!anchor)
    throw new TypeError('TCN_LSTM_INNER_LOGISTIC_FALLBACK_ANCHOR_REQUIRED');
  return {
    source:'FROZEN_POOLED_LOGISTIC_ANCHOR_58_FALLBACK',
    feature_schema_id:'RADARX_TCN_LSTM_POOLED_ANCHOR_MEAN_STD_58_V1',
    feature_count:BASELINE_FEATURES,
    probability_stage:'RAW_UNCALIBRATED',
    fit_partition:'INNER_TRAINING_PARTITION_ONLY',
    scoring_partition:'PURGED_INNER_SELECTION_ONLY',
    holdout_values_used:false,
    logits:selectionRows.map(row=>predictTcnLstmLogisticLogit(row.sequence,anchor))
  };
}

function initializeModel(seed = 29) {
  const random = mulberry32(seed);
  const hidden = TCN_LSTM_HIDDEN;
  const projectionWeights = Array.from({ length: TCN_LSTM_INPUT_CHANNELS }, () =>
    Array.from({ length: hidden }, () => (random() - 0.5) * 0.10));
  const projectionBiases = Array(hidden).fill(0);
  const depthWeights = Array.from({ length: TCN_LSTM_LAYERS }, () =>
    Array.from({ length: TCN_LSTM_KERNEL_TAPS }, () =>
      Array.from({ length: hidden }, () => (random() - 0.5) * 0.10)));
  const pointWeights = Array.from({ length: TCN_LSTM_LAYERS }, () =>
    Array.from({ length: hidden }, () =>
      Array.from({ length: hidden }, () => (random() - 0.5) * 0.08)));
  const tcnBiases = Array.from({ length: TCN_LSTM_LAYERS }, () => Array(hidden).fill(0));
  const gates = hidden * 4;
  const lstmInputWeights = Array.from({ length: hidden }, () =>
    Array.from({ length: gates }, () => (random() - 0.5) * 0.12));
  const lstmRecurrentWeights = Array.from({ length: hidden }, () =>
    Array.from({ length: gates }, () => (random() - 0.5) * 0.10));
  const lstmBiases = Array(gates).fill(0);
  for (let channel = 0; channel < hidden; channel++)
    lstmBiases[hidden + channel] = 1; // positive initial memory retention
  return {
    projectionWeights, projectionBiases,
    depthWeights, pointWeights, tcnBiases,
    lstmInputWeights, lstmRecurrentWeights, lstmBiases,
    attentionQuery: Array.from({ length: hidden }, () => (random() - 0.5) * 0.06),
    attentionPositionBiases: Array(TCN_LSTM_STEPS).fill(0),
    // Start exactly at the frozen Logistic baseline. The temporal network must
    // learn a residual correction instead of perturbing reference probabilities
    // with a random output layer before any evidence-based update.
    outputWeights: Array(hidden).fill(0),
    // Trainable scalars are one-element arrays so optimizer/finite-difference
    // updates mutate the model object rather than a detached wrapper property.
    outputBias: [0],
    // Independent multi-scale return-rank head; separate from classification.
    rankingRepresentation:'LATENT_MULTI_SCALE_V2',
    rankingHeadWeights: Array(TCN_LSTM_RANKING_FEATURE_COUNT).fill(0),
    rankingFeatureMean: Array(TCN_LSTM_RANKING_FEATURE_COUNT).fill(0),
    rankingFeatureStd: Array(TCN_LSTM_RANKING_FEATURE_COUNT).fill(1),
    orderedRankingHeadWeights:Array(TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT).fill(0),
    orderedRankingFeatureMean:Array(TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT).fill(0),
    orderedRankingFeatureStd:Array(TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT).fill(1),
    // The active execution heads consume pooled state plus normalized frozen
    // Logistic-anchor and neural-classifier scores.
    executionReturnHeadWeights:Array(5*hidden+4).fill(0),executionReturnHeadBias:0,
    executionRiskHeadWeights:Array(5*hidden+4).fill(0),executionRiskHeadBias:0,
    // Matched pooled-only heads are retained as a reference ablation.
    executionReturnHeadPooledOnlyWeights:Array(hidden).fill(0),
    executionReturnHeadPooledOnlyBias:0,
    executionRiskHeadPooledOnlyWeights:Array(hidden).fill(0),
    executionRiskHeadPooledOnlyBias:0,
    executionHeadInputFeatureSchema:TCN_LSTM_EXECUTION_HEAD_INPUT_FEATURE_SCHEMA,
    executionRegressionHeadsFitted:false
  };
}

function trainableParameters(model) {
  return {
    projectionWeights: model.projectionWeights,
    projectionBiases: model.projectionBiases,
    depthWeights: model.depthWeights,
    pointWeights: model.pointWeights,
    tcnBiases: model.tcnBiases,
    lstmInputWeights: model.lstmInputWeights,
    lstmRecurrentWeights: model.lstmRecurrentWeights,
    lstmBiases: model.lstmBiases,
    attentionQuery: model.attentionQuery,
    attentionPositionBiases: model.attentionPositionBiases,
    outputWeights: model.outputWeights,
    outputBias: model.outputBias
  };
}

export function inspectTcnLstmForward(sequence, model, baselineLogit = 0, {
  dropoutScale = null
} = {}) {
  validateSequence(sequence);
  if (!finite(baselineLogit)) throw new TypeError('TCN_LSTM_BASELINE_LOGIT_NON_FINITE');
  const inputDropoutScale = dropoutScale === null
    ? Array(TCN_LSTM_HIDDEN).fill(1) : dropoutScale;
  if (!Array.isArray(inputDropoutScale) ||
      inputDropoutScale.length !== TCN_LSTM_HIDDEN ||
      inputDropoutScale.some(value => !finite(value) || value < 0 || value > 2))
    throw new TypeError('TCN_LSTM_LOCKED_DROPOUT_MASK_INVALID');
  const hidden = TCN_LSTM_HIDDEN;
  let current = sequence.map(row => Array.from({ length: hidden }, (_, output) => {
    let value = model.projectionBiases[output];
    for (let input = 0; input < TCN_LSTM_INPUT_CHANNELS; input++)
      value += row[input] * model.projectionWeights[input][output];
    return tanh(value);
  }));
  const projected = current;
  const tcnCaches = [];
  for (let layer = 0; layer < TCN_LSTM_LAYERS; layer++) {
    const input = current;
    const depth = Array.from({ length: TCN_LSTM_STEPS }, () => Array(hidden).fill(0));
    const output = Array.from({ length: TCN_LSTM_STEPS }, () => Array(hidden).fill(0));
    const dilation = TCN_LSTM_DILATIONS[layer];
    for (let time = 0; time < TCN_LSTM_STEPS; time++) {
      for (let channel = 0; channel < hidden; channel++) {
        let value = input[time][channel];
        for (let tap = 1; tap <= TCN_LSTM_KERNEL_TAPS; tap++) {
          const previous = time - tap * dilation;
          if (previous >= 0)
            value += model.depthWeights[layer][tap - 1][channel] * input[previous][channel];
        }
        depth[time][channel] = value;
      }
    }
    for (let time = 0; time < TCN_LSTM_STEPS; time++) {
      for (let out = 0; out < hidden; out++) {
        let value = input[time][out] + model.tcnBiases[layer][out];
        for (let channel = 0; channel < hidden; channel++)
          value += depth[time][channel] * model.pointWeights[layer][channel][out];
        output[time][out] = tanh(value);
      }
    }
    tcnCaches.push({ input, depth, output, dilation });
    current = output;
  }

  const lstmCaches = [];
  let previousHidden = Array(hidden).fill(0);
  let previousCell = Array(hidden).fill(0);
  const lstmInputSequence = [];
  for (let time = 0; time < TCN_LSTM_STEPS; time++) {
    const input = current[time].map((value, channel) =>
      value * inputDropoutScale[channel]);
    lstmInputSequence.push(input);
    const inputGate = Array(hidden), forgetGate = Array(hidden);
    const outputGate = Array(hidden), candidateGate = Array(hidden);
    const cell = Array(hidden), cellTanh = Array(hidden), state = Array(hidden);
    const preactivation = Array(hidden * 4).fill(0);
    for (let gate = 0; gate < hidden * 4; gate++) {
      let value = model.lstmBiases[gate];
      for (let channel = 0; channel < hidden; channel++) {
        value += input[channel] * model.lstmInputWeights[channel][gate];
        value += previousHidden[channel] * model.lstmRecurrentWeights[channel][gate];
      }
      preactivation[gate] = value;
    }
    // Gate order: [i_0..i_H, f_0..f_H, o_0..o_H, g_0..g_H].
    for (let index = 0; index < hidden; index++) {
      inputGate[index] = sigmoid(preactivation[index]);
      forgetGate[index] = sigmoid(preactivation[hidden + index]);
      outputGate[index] = sigmoid(preactivation[2 * hidden + index]);
      candidateGate[index] = tanh(preactivation[3 * hidden + index]);
    }
    for (let unit = 0; unit < hidden; unit++) {
      cell[unit] = forgetGate[unit] * previousCell[unit] +
        inputGate[unit] * candidateGate[unit];
      cellTanh[unit] = tanh(cell[unit]);
      state[unit] = outputGate[unit] * cellTanh[unit];
    }
    lstmCaches.push({
      input, dropoutScale:inputDropoutScale, previousHidden, previousCell,
      inputGate, forgetGate, outputGate, candidateGate,
      cell, cellTanh, state
    });
    previousHidden = state;
    previousCell = cell;
  }

  const scores = Array(TCN_LSTM_STEPS).fill(0);
  const maximum = -Infinity;
  const scale = 1 / Math.sqrt(hidden);
  let maxScore = maximum;
  for (let time = 0; time < TCN_LSTM_STEPS; time++) {
    let score = model.attentionPositionBiases[time];
    for (let channel = 0; channel < hidden; channel++)
      score += lstmCaches[time].state[channel] * model.attentionQuery[channel] * scale;
    scores[time] = score;
    maxScore = Math.max(maxScore, score);
  }
  const exponents = scores.map(score => Math.exp(clamp(score - maxScore, -SOFTMAX_LIMIT, 0)));
  const denominator = exponents.reduce((sum, value) => sum + value, 0);
  if (!finite(denominator) || denominator <= 0)
    throw new TypeError('TCN_LSTM_ATTENTION_SOFTMAX_INVALID');
  const attentionWeights = exponents.map(value => value / denominator);
  const pooled = Array(hidden).fill(0);
  for (let time = 0; time < TCN_LSTM_STEPS; time++) {
    for (let channel = 0; channel < hidden; channel++)
      pooled[channel] += attentionWeights[time] * lstmCaches[time].state[channel];
  }
  let residualLogit = model.outputBias[0];
  for (let channel = 0; channel < hidden; channel++)
    residualLogit += model.outputWeights[channel] * pooled[channel];
  const logit = clamp(baselineLogit + residualLogit, -LOGIT_LIMIT, LOGIT_LIMIT);
  const probability = sigmoid(logit);
  const rankingWeights = model.rankingHeadWeights === undefined
    ? Array(TCN_LSTM_RANKING_FEATURE_COUNT).fill(0) : model.rankingHeadWeights;
  const rankingMeans = model.rankingFeatureMean === undefined
    ? Array(TCN_LSTM_RANKING_FEATURE_COUNT).fill(0) : model.rankingFeatureMean;
  const rankingStds = model.rankingFeatureStd === undefined
    ? Array(TCN_LSTM_RANKING_FEATURE_COUNT).fill(1) : model.rankingFeatureStd;
  if (!Array.isArray(rankingWeights) || rankingWeights.length !== TCN_LSTM_RANKING_FEATURE_COUNT ||
      rankingWeights.some(value => !finite(value)) ||
      !Array.isArray(rankingMeans) || rankingMeans.length !== TCN_LSTM_RANKING_FEATURE_COUNT ||
      rankingMeans.some(value => !finite(value)) ||
      !Array.isArray(rankingStds) || rankingStds.length !== TCN_LSTM_RANKING_FEATURE_COUNT ||
      rankingStds.some(value => !finite(value) || value <= 0))
    throw new TypeError('TCN_LSTM_RANKING_HEAD_STATE_INVALID');
  const meanTail = startIndex => Array.from({length:hidden},(_,channel)=>{
    let total=0,count=0;
    for(let time=startIndex;time<TCN_LSTM_STEPS;time++){
      total+=lstmCaches[time].state[channel];
      count++;
    }
    return total/Math.max(1,count);
  });
  const rankingFeatures=[
    ...pooled,
    ...lstmCaches[TCN_LSTM_STEPS-1].state,
    ...meanTail(TCN_LSTM_STEPS-4),
    ...meanTail(TCN_LSTM_STEPS-8)
  ];
  const normalizedRankingFeatures=rankingFeatures.map((value,index)=>
    (value-rankingMeans[index])/rankingStds[index]
  );
  let rankingScore=0;
  let rankingAnchorScore=0;
  for(let index=0;index<TCN_LSTM_RANKING_FEATURE_COUNT;index++)
    rankingScore+=rankingWeights[index]*normalizedRankingFeatures[index];
  rankingScore=clamp(rankingScore,-LOGIT_LIMIT,LOGIT_LIMIT);
  let rankingScoreFeatures=normalizedRankingFeatures;
  const rankingRepresentation=model.rankingRepresentation??'LATENT_MULTI_SCALE_V2';
  if(!TCN_LSTM_RANKING_REPRESENTATIONS.includes(rankingRepresentation))
    throw new TypeError('TCN_LSTM_RANKING_REPRESENTATION_INVALID');
  if(rankingRepresentation==='RAW_ORDERED_696_V1'){
    const orderedWeights=model.orderedRankingHeadWeights;
    const orderedMeans=model.orderedRankingFeatureMean;
    const orderedStds=model.orderedRankingFeatureStd;
    if(!Array.isArray(orderedWeights)||
      orderedWeights.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      orderedWeights.some(value=>!finite(value))||
      !Array.isArray(orderedMeans)||
      orderedMeans.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      orderedMeans.some(value=>!finite(value))||
      !Array.isArray(orderedStds)||
      orderedStds.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      orderedStds.some(value=>!finite(value)||value<=0))
      throw new TypeError('TCN_LSTM_ORDERED_RANKING_HEAD_STATE_INVALID');
    const orderedFeatures=buildTcnLstmFlattenedFeatures(sequence);
    rankingScoreFeatures=orderedFeatures.map((value,index)=>
      (value-orderedMeans[index])/orderedStds[index]
    );
    rankingScore=0;
    for(let index=0;index<TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT;index++)
      rankingScore+=orderedWeights[index]*rankingScoreFeatures[index];
    const anchorWeights=model.orderedRankingAnchorWeights;
    const anchorMeans=model.orderedRankingAnchorFeatureMean;
    const anchorStds=model.orderedRankingAnchorFeatureStd;
    const hasAnchor=anchorWeights!==undefined||anchorMeans!==undefined||
      anchorStds!==undefined||model.orderedRankingAnchorBias!==undefined;
    if(hasAnchor){
      if(!Array.isArray(anchorWeights)||
        anchorWeights.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
        anchorWeights.some(value=>!finite(value))||
        !Array.isArray(anchorMeans)||
        anchorMeans.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
        anchorMeans.some(value=>!finite(value))||
        !Array.isArray(anchorStds)||
        anchorStds.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
        anchorStds.some(value=>!finite(value)||value<=0)||
        !finite(model.orderedRankingAnchorBias))
        throw new TypeError('TCN_LSTM_ORDERED_RANKING_LOGISTIC_ANCHOR_STATE_INVALID');
      rankingAnchorScore=Number(model.orderedRankingAnchorBias);
      for(let index=0;index<TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT;index++)
        rankingAnchorScore+=anchorWeights[index]*
          ((orderedFeatures[index]-anchorMeans[index])/anchorStds[index]);
      rankingAnchorScore=clamp(rankingAnchorScore,-LOGIT_LIMIT,LOGIT_LIMIT);
    }
    rankingScore=clamp(rankingAnchorScore+rankingScore,-LOGIT_LIMIT,LOGIT_LIMIT);
  }else if(rankingRepresentation!=='LATENT_MULTI_SCALE_V2'){
    throw new TypeError('TCN_LSTM_RANKING_REPRESENTATION_INVALID');
  }
  if (![...pooled, ...attentionWeights, probability, logit, rankingScore,
    ...rankingFeatures,...normalizedRankingFeatures,...rankingScoreFeatures].every(finite))
    throw new TypeError('TCN_LSTM_FORWARD_NON_FINITE');
  const rankingLogit = rankingScore;
  return {
    probability, logit, ranking_score: rankingScore, ranking_logit: rankingLogit,
    ranking_anchor_score:rankingRepresentation==='RAW_ORDERED_696_V1'
      ?(finite(model.orderedRankingAnchorBias)?rankingAnchorScore:null):null,
    ranking_representation:rankingRepresentation,
    ranking_score_feature_count:rankingScoreFeatures.length,
    residual_logit: residualLogit,
    ranking_features: rankingFeatures, normalized_ranking_features: normalizedRankingFeatures,
    ranking_score_features:rankingScoreFeatures,
    attention_weights: attentionWeights,
    tcn_latent_sequence: current,
    projected_sequence: projected,
    lstm_hidden_sequence: lstmCaches.map(row => row.state),
    lstm_cell_sequence: lstmCaches.map(row => row.cell),
    lstm_input_sequence:lstmInputSequence,
    input_dropout_scale:[...inputDropoutScale],
    cache: { projected, tcnCaches, lstmCaches, pooled, attentionWeights }
  };
}

function isPlainTreeObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function zerosLike(value) {
  if (Array.isArray(value)) return value.map(zerosLike);
  if (isPlainTreeObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, zerosLike(item)]));
  return 0;
}
function cloneTree(value) {
  if (Array.isArray(value)) return value.map(cloneTree);
  if (isPlainTreeObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneTree(item)]));
  return value;
}
function accumulateTree(target, source) {
  if (Array.isArray(target)) {
    if (!Array.isArray(source) || target.length !== source.length)
      throw new TypeError('TCN_LSTM_GRADIENT_TREE_SHAPE_MISMATCH');
    for (let index = 0; index < target.length; index++)
      target[index] = accumulateTree(target[index], source[index]);
    return target;
  }
  if (isPlainTreeObject(target)) {
    if (!isPlainTreeObject(source) ||
        Object.keys(target).length !== Object.keys(source).length)
      throw new TypeError('TCN_LSTM_GRADIENT_TREE_SHAPE_MISMATCH');
    for (const key of Object.keys(target)) {
      if (!(key in source)) throw new TypeError('TCN_LSTM_GRADIENT_TREE_KEY_MISMATCH:' + key);
      target[key] = accumulateTree(target[key], source[key]);
    }
    return target;
  }
  if (!finite(source)) throw new TypeError('TCN_LSTM_GRADIENT_NON_FINITE');
  return target + source;
}
function scaleTree(value, factor) {
  if (Array.isArray(value)) return value.map(item => scaleTree(item, factor));
  if (isPlainTreeObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scaleTree(item, factor)]));
  return value * factor;
}
function sumSquares(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + sumSquares(item), 0);
  if (isPlainTreeObject(value))
    return Object.values(value).reduce((sum, item) => sum + sumSquares(item), 0);
  return value * value;
}
function treeDot(left,right) {
  if(Array.isArray(left)){
    if(!Array.isArray(right)||left.length!==right.length)
      throw new TypeError('TCN_LSTM_GRADIENT_TREE_SHAPE_MISMATCH');
    return left.reduce((sum,value,index)=>sum+treeDot(value,right[index]),0);
  }
  if(isPlainTreeObject(left)){
    if(!isPlainTreeObject(right)||Object.keys(left).length!==Object.keys(right).length)
      throw new TypeError('TCN_LSTM_GRADIENT_TREE_SHAPE_MISMATCH');
    let total=0;
    for(const key of Object.keys(left)){
      if(!(key in right))throw new TypeError('TCN_LSTM_GRADIENT_TREE_KEY_MISMATCH:'+key);
      total+=treeDot(left[key],right[key]);
    }
    return total;
  }
  if(!finite(left)||!finite(right))
    throw new TypeError('TCN_LSTM_GRADIENT_NON_FINITE');
  return Number(left)*Number(right);
}

/**
 * Project a conflicting auxiliary ranking gradient away from the primary
 * probability-loss gradient. This PCGrad step prevents the ranking objective
 * from taking a first-order step that increases the proper-scoring objective.
 */
export function projectTcnLstmAuxiliaryGradient(primaryGradient,auxiliaryGradient) {
  if(!treeFinite(primaryGradient)||!treeFinite(auxiliaryGradient))
    throw new TypeError('TCN_LSTM_PCGRAD_INPUT_NON_FINITE');
  const dotBefore=treeDot(primaryGradient,auxiliaryGradient);
  const primaryNormSquared=sumSquares(primaryGradient);
  const auxiliaryNormSquared=sumSquares(auxiliaryGradient);
  const conflict=dotBefore<0;
  const projectionApplied=conflict&&primaryNormSquared>1e-18;
  const gradient=projectionApplied
    ?accumulateTree(cloneTree(auxiliaryGradient),
      scaleTree(primaryGradient,-dotBefore/primaryNormSquared))
    :cloneTree(auxiliaryGradient);
  const dotAfter=treeDot(primaryGradient,gradient);
  const cosineBefore=primaryNormSquared>0&&auxiliaryNormSquared>0
    ?dotBefore/Math.sqrt(primaryNormSquared*auxiliaryNormSquared):0;
  return {
    gradient,conflict,projection_applied:projectionApplied,
    dot_before:Number(dotBefore.toFixed(12)),
    dot_after:Number(dotAfter.toFixed(12)),
    cosine_before:Number(cosineBefore.toFixed(8)),
    primary_gradient_norm_squared:Number(primaryNormSquared.toFixed(12)),
    auxiliary_gradient_norm_squared:Number(auxiliaryNormSquared.toFixed(12))
  };
}

function treeFinite(value) {
  if (Array.isArray(value)) return value.every(treeFinite);
  if (isPlainTreeObject(value)) return Object.values(value).every(treeFinite);
  return finite(value);
}

function zeroGradients(model) {
  return zerosLike(trainableParameters(model));
}

export function lossAndGradientsTcnLstmHybrid(sequence, target, model, baselineLogit = 0, {
  dropoutScale = null,objective='BRIER',classWeights=null,
  gammaPositive=1,gammaNegative=2,externalLogitGradient=null
} = {}) {
  if (target !== 0 && target !== 1)
    throw new TypeError('TCN_LSTM_TARGET_INVALID');
  const forward = inspectTcnLstmForward(sequence, model, baselineLogit, {dropoutScale});
  const parameters = trainableParameters(model);
  const gradients = zeroGradients(model);
  const hidden = TCN_LSTM_HIDDEN;
  if(!['BRIER','FOCAL_ASYMMETRIC_BRIER','EXTERNAL_LOGIT'].includes(objective))
    throw new TypeError('TCN_LSTM_LOSS_OBJECTIVE_INVALID');
  const error = forward.probability - target;
  const focal=objective==='FOCAL_ASYMMETRIC_BRIER'
    ?focalAsymmetricBrierLoss(forward.probability,target,{
      ...(classWeights??{}),gammaPositive,gammaNegative
    }):null;
  if(objective==='FOCAL_ASYMMETRIC_BRIER'&&classWeights===null)
    throw new TypeError('TCN_LSTM_FOCAL_CLASS_WEIGHTS_REQUIRED');
  if(objective==='EXTERNAL_LOGIT'&&!finite(externalLogitGradient))
    throw new TypeError('TCN_LSTM_EXTERNAL_LOGIT_GRADIENT_INVALID');
  const logitGradient=objective==='EXTERNAL_LOGIT'?Number(externalLogitGradient):
    focal?focal.logitGradient:2*error*forward.probability*(1-forward.probability);
  const objectiveLoss=objective==='EXTERNAL_LOGIT'
    ?Number(externalLogitGradient)*forward.logit
    :focal?focal.loss:error*error;
  const cache = forward.cache;
  gradients.outputBias[0] = logitGradient;
  const pooledGradient = Array(hidden).fill(0);
  for (let channel = 0; channel < hidden; channel++) {
    gradients.outputWeights[channel] = logitGradient * cache.pooled[channel];
    pooledGradient[channel] = logitGradient * model.outputWeights[channel];
  }

  const hiddenGradients = Array.from({ length: TCN_LSTM_STEPS }, () => Array(hidden).fill(0));
  const attentionScale = 1 / Math.sqrt(hidden);
  for (let time = 0; time < TCN_LSTM_STEPS; time++) {
    const weight = cache.attentionWeights[time];
    let scoreGradient = 0;
    for (let channel = 0; channel < hidden; channel++) {
      const state = cache.lstmCaches[time].state[channel];
      scoreGradient += pooledGradient[channel] * (state - cache.pooled[channel]);
    }
    scoreGradient *= weight;
    gradients.attentionPositionBiases[time] += scoreGradient;
    for (let channel = 0; channel < hidden; channel++) {
      const state = cache.lstmCaches[time].state[channel];
      hiddenGradients[time][channel] += weight * pooledGradient[channel] +
        scoreGradient * model.attentionQuery[channel] * attentionScale;
      gradients.attentionQuery[channel] += scoreGradient * state * attentionScale;
    }
  }

  const tcnOutputGradients = Array.from({ length: TCN_LSTM_STEPS }, () => Array(hidden).fill(0));
  let nextHiddenGradient = Array(hidden).fill(0);
  let nextCellGradient = Array(hidden).fill(0);
  for (let time = TCN_LSTM_STEPS - 1; time >= 0; time--) {
    const step = cache.lstmCaches[time];
    const gateGradient = Array(hidden * 4).fill(0);
    const cellGradient = Array(hidden).fill(0);
    const previousHiddenGradient = Array(hidden).fill(0);
    const inputGradient = Array(hidden).fill(0);
    for (let unit = 0; unit < hidden; unit++) {
      const totalHiddenGradient = hiddenGradients[time][unit] + nextHiddenGradient[unit];
      const tanhCell = step.cellTanh[unit];
      const outputGateGradient = totalHiddenGradient * tanhCell;
      const totalCellGradient = totalHiddenGradient * step.outputGate[unit] *
        (1 - tanhCell * tanhCell) + nextCellGradient[unit];
      const inputGateGradient = totalCellGradient * step.candidateGate[unit];
      const candidateGateGradient = totalCellGradient * step.inputGate[unit];
      const forgetGateGradient = totalCellGradient * step.previousCell[unit];
      cellGradient[unit] = totalCellGradient * step.forgetGate[unit];
      gateGradient[unit] = inputGateGradient * step.inputGate[unit] *
        (1 - step.inputGate[unit]);
      gateGradient[hidden + unit] = forgetGateGradient * step.forgetGate[unit] *
        (1 - step.forgetGate[unit]);
      gateGradient[2 * hidden + unit] = outputGateGradient * step.outputGate[unit] *
        (1 - step.outputGate[unit]);
      gateGradient[3 * hidden + unit] = candidateGateGradient *
        (1 - step.candidateGate[unit] * step.candidateGate[unit]);
    }
    for (let input = 0; input < hidden; input++) {
      for (let gate = 0; gate < hidden * 4; gate++) {
        const gradient = gateGradient[gate];
        gradients.lstmInputWeights[input][gate] += step.input[input] * gradient;
        gradients.lstmRecurrentWeights[input][gate] += step.previousHidden[input] * gradient;
        inputGradient[input] += model.lstmInputWeights[input][gate] * gradient;
        previousHiddenGradient[input] += model.lstmRecurrentWeights[input][gate] * gradient;
      }
    }
    for (let gate = 0; gate < hidden * 4; gate++)
      gradients.lstmBiases[gate] += gateGradient[gate];
    nextHiddenGradient = previousHiddenGradient;
    nextCellGradient = cellGradient;
    tcnOutputGradients[time] = inputGradient.map((value, channel) =>
      value * step.dropoutScale[channel]);
  }

  let outputGradient = tcnOutputGradients;
  for (let layer = TCN_LSTM_LAYERS - 1; layer >= 0; layer--) {
    const layerCache = cache.tcnCaches[layer];
    const input = layerCache.input;
    const depth = layerCache.depth;
    const output = layerCache.output;
    const dilation = layerCache.dilation;
    const inputGradient = Array.from({ length: TCN_LSTM_STEPS }, () => Array(hidden).fill(0));
    const depthGradient = Array.from({ length: TCN_LSTM_STEPS }, () => Array(hidden).fill(0));
    for (let time = 0; time < TCN_LSTM_STEPS; time++) {
      for (let out = 0; out < hidden; out++) {
        const activationGradient = outputGradient[time][out] *
          (1 - output[time][out] * output[time][out]);
        inputGradient[time][out] += activationGradient; // residual path
        gradients.tcnBiases[layer][out] += activationGradient;
        for (let channel = 0; channel < hidden; channel++) {
          gradients.pointWeights[layer][channel][out] +=
            depth[time][channel] * activationGradient;
          depthGradient[time][channel] +=
            model.pointWeights[layer][channel][out] * activationGradient;
        }
      }
    }
    for (let time = 0; time < TCN_LSTM_STEPS; time++) {
      for (let channel = 0; channel < hidden; channel++) {
        inputGradient[time][channel] += depthGradient[time][channel]; // depthwise residual
        for (let tap = 1; tap <= TCN_LSTM_KERNEL_TAPS; tap++) {
          const previous = time - tap * dilation;
          if (previous >= 0) {
            gradients.depthWeights[layer][tap - 1][channel] +=
              input[previous][channel] * depthGradient[time][channel];
            inputGradient[previous][channel] +=
              model.depthWeights[layer][tap - 1][channel] * depthGradient[time][channel];
          }
        }
      }
    }
    outputGradient = inputGradient;
  }

  for (let time = 0; time < TCN_LSTM_STEPS; time++) {
    for (let out = 0; out < hidden; out++) {
      const activationGradient = outputGradient[time][out] *
        (1 - cache.projected[time][out] * cache.projected[time][out]);
      gradients.projectionBiases[out] += activationGradient;
      for (let input = 0; input < TCN_LSTM_INPUT_CHANNELS; input++)
        gradients.projectionWeights[input][out] += sequence[time][input] * activationGradient;
    }
  }

  if (!treeFinite(gradients) || !finite(logitGradient))
    throw new TypeError('TCN_LSTM_BACKPROP_NON_FINITE');
  return {
    loss: objectiveLoss,
    loss_objective:objective,
    gradient_logits: logitGradient,
    probability: forward.probability,
    gradients,
    parameter_count: TCN_LSTM_PARAMETER_COUNT
  };
}

function flattenPaths(value, prefix = [], output = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++)
      flattenPaths(value[index], prefix.concat(index), output);
  } else if (isPlainTreeObject(value)) {
    for (const [key, item] of Object.entries(value))
      flattenPaths(item, prefix.concat(key), output);
  } else output.push(prefix);
  return output;
}
function getPath(root, path) {
  return path.reduce((value, key) => value[key], root);
}
function setPath(root, path, next) {
  const parent = path.slice(0, -1).reduce((value, key) => value[key], root);
  parent[path.at(-1)] = next;
}

export function auditTcnLstmHybridGradients(sequence, target, {
  model = initializeModel(29),
  baselineLogit = 0,
  epsilon = 1e-5,
  dropoutScale = null,
  objective='BRIER',
  classWeights=null,
  gammaPositive=1,
  gammaNegative=2,
  externalLogitGradient=null
} = {}) {
  validateSequence(sequence);
  if (!finite(epsilon) || epsilon <= 0) throw new TypeError('TCN_LSTM_GRADIENT_EPSILON_INVALID');
  const objectiveOptions={dropoutScale,objective,classWeights,gammaPositive,gammaNegative,externalLogitGradient};
  const analytic = lossAndGradientsTcnLstmHybrid(
    sequence, target, model, baselineLogit, objectiveOptions
  );
  const objectiveLoss=()=>{
    const forward=inspectTcnLstmForward(
      sequence,model,baselineLogit,{dropoutScale}
    );
    const probability=forward.probability;
    if(objective==='EXTERNAL_LOGIT'){
      if(!finite(externalLogitGradient))throw new TypeError('TCN_LSTM_EXTERNAL_LOGIT_GRADIENT_INVALID');
      return Number(externalLogitGradient)*forward.logit;
    }
    return objective==='FOCAL_ASYMMETRIC_BRIER'
      ?focalAsymmetricBrierLoss(probability,target,{
        ...(classWeights??{}),gammaPositive,gammaNegative
      }).loss
      :(probability-target)**2;
  };
  const parameters = trainableParameters(model);
  const parameterPaths = flattenPaths(parameters);
  const gradientPaths = flattenPaths(analytic.gradients);
  if (parameterPaths.length !== gradientPaths.length)
    throw new TypeError('TCN_LSTM_GRADIENT_PARAMETER_SHAPE_MISMATCH');
  let maximumAbsoluteError = 0, maximumRelativeError = 0;
  let sumSquaredError = 0;
  let worstParameter = null;
  for (let index = 0; index < parameterPaths.length; index++) {
    const path = parameterPaths[index];
    const original = getPath(parameters, path);
    setPath(parameters, path, original + epsilon);
    const plus = objectiveLoss();
    setPath(parameters, path, original - epsilon);
    const minus = objectiveLoss();
    setPath(parameters, path, original);
    const numerical = (plus - minus) / (2 * epsilon);
    const exact = getPath(analytic.gradients, gradientPaths[index]);
    const absolute = Math.abs(numerical - exact);
    const relative = absolute / Math.max(1e-7, Math.abs(numerical), Math.abs(exact));
    maximumAbsoluteError = Math.max(maximumAbsoluteError, absolute);
    maximumRelativeError = Math.max(maximumRelativeError, relative);
    if (!worstParameter || absolute > worstParameter.absolute_error)
      worstParameter = {
        path: path.join('.'),
        analytic_gradient: exact,
        numerical_gradient: numerical,
        absolute_error: absolute,
        relative_error: relative
      };
    sumSquaredError += absolute * absolute;
  }
  return {
    parameter_count: parameterPaths.length,
    checked_parameters: parameterPaths.length,
    maximum_absolute_error: maximumAbsoluteError,
    maximum_relative_error: maximumRelativeError,
    worst_parameter: worstParameter,
    root_mean_squared_error: Math.sqrt(sumSquaredError / Math.max(1, parameterPaths.length)),
    passed: maximumAbsoluteError < 2e-5 && maximumRelativeError < 2e-3,
    method: 'CENTRAL_FINITE_DIFFERENCE_ALL_TRAINABLE_PARAMETERS_V1'
  };
}

function assertRows(rows, name) {
  if (!Array.isArray(rows) || rows.length < 20)
    throw new TypeError('TCN_LSTM_' + name + '_SUPPORT_TOO_SMALL');
  rows.forEach((row, index) => validateRow(row, index));
  const positive = rows.filter(row => row.target === 1).length;
  const negative = rows.length - positive;
  if (positive < 2 || negative < 2)
    throw new TypeError('TCN_LSTM_' + name + '_CLASS_SUPPORT_TOO_SMALL');
  return { rows: rows.length, positive, negative };
}

function parameterNorm(tree) {
  return Math.sqrt(sumSquares(tree));
}

function updateParameters(model, gradients, optimizer, step, learningRate, l2) {
  const parameters = trainableParameters(model);
  const parameterPaths = flattenPaths(parameters);
  const gradientPaths = flattenPaths(gradients);
  const firstPaths = flattenPaths(optimizer.m);
  const secondPaths = flattenPaths(optimizer.v);
  for (let index = 0; index < parameterPaths.length; index++) {
    const path = parameterPaths[index];
    const parameter = getPath(parameters, path);
    const gradient = getPath(gradients, path);
    const moment = 0.9 * getPath(optimizer.m, path) + 0.1 * gradient;
    const variance = 0.999 * getPath(optimizer.v, path) + 0.001 * gradient * gradient;
    setPath(optimizer.m, path, moment);
    setPath(optimizer.v, path, variance);
    const correctedMoment = moment / (1 - Math.pow(0.9, step));
    const correctedVariance = variance / (1 - Math.pow(0.999, step));
    const decayed = parameter * (1 - learningRate * l2);
    const next = decayed - learningRate * correctedMoment /
      (Math.sqrt(correctedVariance) + 1e-8);
    if (!finite(next)) throw new TypeError('TCN_LSTM_OPTIMIZER_NON_FINITE_PARAMETER');
    setPath(parameters, path, next);
  }
  return model;
}

function evaluateBrier(rows, model, anchor) {
  let sum = 0;
  for (const row of rows) {
    const baselineLogit = resolveTcnLstmRowClassifierBaselineLogit(row,anchor);
    const probability = inspectTcnLstmForward(row.sequence, model, baselineLogit).probability;
    sum += (probability - row.target) ** 2;
  }
  return sum / rows.length;
}

function safeProbabilityLogit(probability) {
  const value=clamp(Number(probability),1e-9,1-1e-9);
  return Math.log(value/(1-value));
}
function stableSoftplus(value) {
  const number=Number(value);
  return Math.max(0,number)+Math.log1p(Math.exp(-Math.abs(number)));
}
export function tcnLstmPairwiseLogitRankingLoss(highLogit,lowLogit) {
  if(!finite(highLogit)||!finite(lowLogit)||
    Math.abs(highLogit)>LOGIT_LIMIT||Math.abs(lowLogit)>LOGIT_LIMIT)
    throw new TypeError('TCN_LSTM_PAIRWISE_LOGIT_INVALID');
  const margin=Number(highLogit)-Number(lowLogit);
  const error=margin>=0
    ?Math.exp(-margin)/(1+Math.exp(-margin))
    :1/(1+Math.exp(margin));
  return {margin,loss:stableSoftplus(-margin),high_logit_gradient:-error,
    low_logit_gradient:error,correct:margin>0,tied:margin===0,
    accuracy_contribution:margin>0?1:margin===0?0.5:0};
}
/**
 * Epoch checkpoints must improve at least one ranking metric without
 * regressing the other. This Pareto rule matches the independent dual-metric
 * Logistic qualification gate and avoids accuracy-first checkpoint bias.
 */
export function isTcnLstmDualMetricCheckpointBetter(candidate,incumbent,epsilon=1e-9){
  const valid=metric=>metric&&
    finite(metric.pairwise_accuracy_pct)&&
    metric.pairwise_accuracy_pct>=0&&metric.pairwise_accuracy_pct<=100&&
    finite(metric.pairwise_log_loss)&&metric.pairwise_log_loss>=0;
  if(!valid(candidate)||!valid(incumbent)||!finite(epsilon)||epsilon<0||epsilon>1e-3)
    throw new TypeError('TCN_LSTM_DUAL_METRIC_CHECKPOINT_ARGUMENTS_INVALID');
  const accuracyNotWorse=candidate.pairwise_accuracy_pct>=
    incumbent.pairwise_accuracy_pct-epsilon;
  const lossNotWorse=candidate.pairwise_log_loss<=
    incumbent.pairwise_log_loss+epsilon;
  const strictImprovement=
    candidate.pairwise_accuracy_pct>incumbent.pairwise_accuracy_pct+epsilon||
    candidate.pairwise_log_loss<incumbent.pairwise_log_loss-epsilon;
  return accuracyNotWorse&&lossNotWorse&&strictImprovement;
}
export function tcnLstmPairwiseReturnRankingLoss(highProbability,lowProbability) {
  if(!finite(highProbability)||!finite(lowProbability)||highProbability<0||
    highProbability>1||lowProbability<0||lowProbability>1)
    throw new TypeError('TCN_LSTM_PAIRWISE_PROBABILITY_INVALID');
  return tcnLstmPairwiseLogitRankingLoss(
    safeProbabilityLogit(highProbability),safeProbabilityLogit(lowProbability)
  );
}
/** Build deterministic comparisons using realized returns from the fit partition only. */
export function buildTcnLstmReturnRankingPairs(trainingRows,rankingRows,{
  roundTripCostBps=30,minimumReturnGapPct=0.50,maxPairsPerTimestamp=4,
  pairStrategy='RETURN_EXTREMES_V1'
}={}) {
  if(!Array.isArray(trainingRows)||!Array.isArray(rankingRows)||
    trainingRows.length!==rankingRows.length||trainingRows.length<20)
    throw new TypeError('TCN_LSTM_RANKING_ROWS_IDENTITY_REQUIRED');
  if(!finite(roundTripCostBps)||roundTripCostBps<0||roundTripCostBps>300||
    !finite(minimumReturnGapPct)||minimumReturnGapPct<0||
    !Number.isInteger(maxPairsPerTimestamp)||maxPairsPerTimestamp<1||maxPairsPerTimestamp>32||
    !['RETURN_EXTREMES_V1','PROFITABILITY_BOUNDARY_V1','PROFITABILITY_TOPK_V2'].includes(pairStrategy))
    throw new TypeError('TCN_LSTM_RANKING_CONFIGURATION_INVALID');
  const evidenceById=new Map();
  for(const row of rankingRows){
    const id=sampleIdentity(row);
    if(evidenceById.has(id)||!finite(row.realized_return_pct))
      throw new TypeError('TCN_LSTM_RANKING_RETURN_EVIDENCE_INVALID:'+id);
    evidenceById.set(id,row);
  }
  if(evidenceById.size!==trainingRows.length)
    throw new TypeError('TCN_LSTM_RANKING_ROW_COUNT_MISMATCH');
  const groups=new Map(),costPct=Number(roundTripCostBps)/100;
  trainingRows.forEach((row,index)=>{
    const id=sampleIdentity(row),evidence=evidenceById.get(id);
    if(!evidence||Number(evidence.at)!==Number(row.at)||
      Number(evidence.target)!==Number(row.target)||
      String(evidence.symbol??'')!==String(row.symbol??''))
      throw new TypeError('TCN_LSTM_RANKING_ROW_IDENTITY_MISMATCH:'+id);
    if(!finite(row.at))throw new TypeError('TCN_LSTM_RANKING_EVENT_TIME_INVALID:'+id);
    const decisionAt=Math.floor(Number(row.at)/TCN_LSTM_RANKING_BUCKET_MS)*
      TCN_LSTM_RANKING_BUCKET_MS;
    const key=String(decisionAt);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({index,id,symbol:String(row.symbol??'').toUpperCase(),
      net_return_pct:Number(evidence.realized_return_pct)-costPct});
  });
  const pairs=[];
  let positiveOpportunityGroups=0,allNonPositiveGroups=0,allPositiveGroups=0,
    mixedDecisionGroups=0;
  for(const [at,items] of groups){
    const positive=items.filter(item=>item.net_return_pct>0);
    const nonPositive=items.filter(item=>item.net_return_pct<=0);
    if(positive.length)positiveOpportunityGroups++;
    if(nonPositive.length===items.length)allNonPositiveGroups++;
    if(positive.length===items.length)allPositiveGroups++;
    if(positive.length&&nonPositive.length)mixedDecisionGroups++;

    if(pairStrategy==='PROFITABILITY_TOPK_V2'){
      // Top-K training has two distinct ranking duties:
      // (1) profitable opportunities must outrank non-profitable candidates;
      // (2) among profitable opportunities, the higher net return must rank first.
      // The pair budget is stratified so neither duty silently consumes the full cohort.
      const boundaryCandidates=[];
      for(const better of positive)for(const worse of nonPositive){
        const gap=better.net_return_pct-worse.net_return_pct;
        if(gap>=minimumReturnGapPct)
          boundaryCandidates.push({high_index:better.index,low_index:worse.index,
            high_id:better.id,low_id:worse.id,return_gap_pct:Number(gap.toFixed(8)),
            decision_at:Number(at),pair_type:'POSITIVE_VS_NON_POSITIVE'});
      }
      const rankedPositive=[...positive].sort((a,b)=>
        b.net_return_pct-a.net_return_pct||a.id.localeCompare(b.id));
      const profitableOrderCandidates=[];
      for(let high=0;high<rankedPositive.length;high++)
        for(let low=high+1;low<rankedPositive.length;low++){
          const better=rankedPositive[high],worse=rankedPositive[low];
          const gap=better.net_return_pct-worse.net_return_pct;
          if(gap>=minimumReturnGapPct)
            profitableOrderCandidates.push({high_index:better.index,low_index:worse.index,
              high_id:better.id,low_id:worse.id,return_gap_pct:Number(gap.toFixed(8)),
              decision_at:Number(at),pair_type:'POSITIVE_VS_POSITIVE'});
        }
      const orderCandidates=(a,b)=>b.return_gap_pct-a.return_gap_pct||
        a.high_id.localeCompare(b.high_id)||a.low_id.localeCompare(b.low_id);
      boundaryCandidates.sort(orderCandidates);
      profitableOrderCandidates.sort(orderCandidates);
      const spreadSample=(candidates,limit)=>{
        const count=Math.min(limit,candidates.length);
        return Array.from({length:count},(_,index)=>
          candidates[Math.floor((index+0.5)*candidates.length/count)]);
      };
      const boundaryBudget=Math.ceil(maxPairsPerTimestamp/2);
      const profitableOrderBudget=Math.floor(maxPairsPerTimestamp/2);
      const selectedBoundary=spreadSample(boundaryCandidates,boundaryBudget);
      const selectedProfitableOrder=spreadSample(
        profitableOrderCandidates,profitableOrderBudget
      );
      const selectedKeys=new Set([...selectedBoundary,...selectedProfitableOrder].map(pair=>
        pair.high_id+'\\u0000'+pair.low_id
      ));
      let remaining=maxPairsPerTimestamp-selectedBoundary.length-selectedProfitableOrder.length;
      if(remaining>0){
        const refill=[...boundaryCandidates,...profitableOrderCandidates]
          .filter(pair=>!selectedKeys.has(pair.high_id+'\\u0000'+pair.low_id))
          .sort(orderCandidates);
        for(const pair of refill.slice(0,remaining)){
          if(pair.pair_type==='POSITIVE_VS_NON_POSITIVE')selectedBoundary.push(pair);
          else selectedProfitableOrder.push(pair);
        }
      }
      pairs.push(...selectedBoundary,...selectedProfitableOrder);
      continue;
    }

    if(pairStrategy==='PROFITABILITY_BOUNDARY_V1'){
      // Legacy boundary-only policy retained for exact historical reproduction.
      const candidates=[];
      for(const better of positive)for(const worse of nonPositive){
        const gap=better.net_return_pct-worse.net_return_pct;
        if(gap>=minimumReturnGapPct)
          candidates.push({high_index:better.index,low_index:worse.index,
            high_id:better.id,low_id:worse.id,return_gap_pct:Number(gap.toFixed(8)),
            decision_at:Number(at),pair_type:'POSITIVE_VS_NON_POSITIVE'});
      }
      candidates.sort((a,b)=>b.return_gap_pct-a.return_gap_pct||
        a.high_id.localeCompare(b.high_id)||a.low_id.localeCompare(b.low_id));
      const count=Math.min(maxPairsPerTimestamp,candidates.length);
      for(let i=0;i<count;i++)
        pairs.push(candidates[Math.floor((i+0.5)*candidates.length/count)]);
      continue;
    }

    // Legacy diagnostic: compare the outer return extremes, regardless of
    // whether both outcomes are profitable or both are losing.
    const ranked=[...items].sort((a,b)=>b.net_return_pct-a.net_return_pct||
      a.symbol.localeCompare(b.symbol)||a.id.localeCompare(b.id));
    const edges=Math.max(1,Math.min(4,Math.floor(ranked.length/4))),candidates=[];
    for(let hi=0;hi<edges;hi++)for(let lo=0;lo<edges;lo++){
      const better=ranked[hi],worse=ranked[ranked.length-1-lo];
      const gap=better.net_return_pct-worse.net_return_pct;
      if(better.index!==worse.index&&gap>=minimumReturnGapPct)
        candidates.push({high_index:better.index,low_index:worse.index,
          high_id:better.id,low_id:worse.id,return_gap_pct:Number(gap.toFixed(8)),
          decision_at:Number(at)});
    }
    candidates.sort((a,b)=>b.return_gap_pct-a.return_gap_pct||
      a.high_id.localeCompare(b.high_id)||a.low_id.localeCompare(b.low_id));
    const count=Math.min(maxPairsPerTimestamp,candidates.length);
    for(let i=0;i<count;i++)
      pairs.push(candidates[Math.floor((i+0.5)*candidates.length/count)]);
  }
  return {
    schema:pairStrategy==='PROFITABILITY_BOUNDARY_V1'
      ?'RADARX_TCN_LSTM_PROFITABILITY_BOUNDARY_RANK_PAIRS_V1'
      :pairStrategy==='PROFITABILITY_TOPK_V2'
        ?'RADARX_TCN_LSTM_PROFITABILITY_TOPK_RANK_PAIRS_V2'
        :'RADARX_TCN_LSTM_TRAINING_RETURN_RANK_PAIRS_V1',
    pair_strategy:pairStrategy,
    source_partition:'TRAINING_PARTITION_ONLY',
    round_trip_cost_bps:Number(roundTripCostBps),
    minimum_return_gap_pct:Number(minimumReturnGapPct),
    maximum_pairs_per_timestamp:maxPairsPerTimestamp,
    decision_group_count:groups.size,
    positive_opportunity_groups:positiveOpportunityGroups,
    mixed_decision_groups:mixedDecisionGroups,
    all_non_positive_groups:allNonPositiveGroups,
    all_positive_groups:allPositiveGroups,
    comparison_pairs:pairs.length,
    positive_vs_non_positive_pairs:pairStrategy==='PROFITABILITY_BOUNDARY_V1'
      ?pairs.length
      :pairStrategy==='PROFITABILITY_TOPK_V2'
        ?pairs.filter(pair=>pair.pair_type==='POSITIVE_VS_NON_POSITIVE').length:null,
    positive_vs_positive_pairs:pairStrategy==='PROFITABILITY_TOPK_V2'
      ?pairs.filter(pair=>pair.pair_type==='POSITIVE_VS_POSITIVE').length:0,
    pairs
  };
}
export function summarizeTcnLstmPairwiseReturnRanking(rows,probabilities,{
  roundTripCostBps=30,minimumReturnGapPct=0.50,maxPairsPerTimestamp=4,
  pairStrategy='RETURN_EXTREMES_V1'
}={}) {
  const unavailable=reason=>({schema:'RADARX_TCN_LSTM_PAIRWISE_RANKING_METRICS_V1',
    status:'UNAVAILABLE',reason,diagnostic_only:true});
  if(!Array.isArray(rows)||!Array.isArray(probabilities)||rows.length!==probabilities.length||
    rows.length<20||probabilities.some(v=>!finite(v)||v<0||v>1)||
    rows.some(row=>!finite(row?.realized_return_pct)))
    return unavailable('RANKING_EVALUATION_ROWS_OR_RETURNS_INVALID');
  let built;
  try{built=buildTcnLstmReturnRankingPairs(rows,rows,{
    roundTripCostBps,minimumReturnGapPct,maxPairsPerTimestamp,pairStrategy
  });}catch(error){return unavailable(String(error?.message||error));}
  if(!built.comparison_pairs)return unavailable(
    pairStrategy==='PROFITABILITY_BOUNDARY_V1'?'NO_PROFITABILITY_BOUNDARY_PAIRS':
    pairStrategy==='PROFITABILITY_TOPK_V2'?'NO_PROFITABILITY_TOPK_PAIRS':
    'NO_MATURED_WITHIN_TIMESTAMP_RETURN_PAIRS');
  let loss=0,correct=0;
  for(const pair of built.pairs){
    const item=tcnLstmPairwiseReturnRankingLoss(
      probabilities[pair.high_index],probabilities[pair.low_index]);
    loss+=item.loss;correct+=item.accuracy_contribution;
  }
  return {schema:pairStrategy==='PROFITABILITY_BOUNDARY_V1'
      ?'RADARX_TCN_LSTM_PROFITABILITY_BOUNDARY_RANKING_METRICS_V1'
      :pairStrategy==='PROFITABILITY_TOPK_V2'
        ?'RADARX_TCN_LSTM_PROFITABILITY_TOPK_RANKING_METRICS_V2'
        :'RADARX_TCN_LSTM_PAIRWISE_RANKING_METRICS_V1',
    status:'AVAILABLE',sample_count:rows.length,decision_group_count:built.decision_group_count,
    comparison_pairs:built.comparison_pairs,pairwise_log_loss:Number((loss/built.comparison_pairs).toFixed(8)),
    pairwise_accuracy_pct:Number((100*correct/built.comparison_pairs).toFixed(4)),
    pair_strategy:pairStrategy,
    positive_vs_non_positive_pairs:built.positive_vs_non_positive_pairs,
    positive_vs_positive_pairs:built.positive_vs_positive_pairs??0,
    positive_opportunity_groups:built.positive_opportunity_groups,
    mixed_decision_groups:built.mixed_decision_groups,
    source:pairStrategy==='PROFITABILITY_BOUNDARY_V1'
      ?'POSITIVE_NET_RETURN_VS_NON_POSITIVE_WITHIN_SIMULTANEOUS_DECISION_TIMESTAMP'
      :pairStrategy==='PROFITABILITY_TOPK_V2'
        ?'POSITIVE_VS_NON_POSITIVE_AND_WITHIN_POSITIVE_NET_RETURN_ORDER_WITHIN_SIMULTANEOUS_DECISION_TIMESTAMP'
        :'REALIZED_RETURN_WITHIN_SIMULTANEOUS_DECISION_TIMESTAMP',
    diagnostic_only:true,holdout_values_used:false};
}
/** Rank realized-return pairs directly from uncompressed forward logits. */
export function summarizeTcnLstmPairwiseLogitRanking(rows,logits,{
  roundTripCostBps=30,minimumReturnGapPct=0.50,maxPairsPerTimestamp=4,
  pairStrategy='RETURN_EXTREMES_V1'
}={}) {
  const unavailable=reason=>({schema:'RADARX_TCN_LSTM_PAIRWISE_LOGIT_RANKING_METRICS_V1',
    status:'UNAVAILABLE',reason,diagnostic_only:true,holdout_values_used:false});
  if(!Array.isArray(rows)||!Array.isArray(logits)||rows.length!==logits.length||
    rows.length<20||logits.some(v=>!finite(v)||Math.abs(v)>LOGIT_LIMIT)||
    rows.some(row=>!finite(row?.realized_return_pct)))
    return unavailable('RANKING_EVALUATION_ROWS_OR_LOGITS_INVALID');
  let built;
  try{built=buildTcnLstmReturnRankingPairs(rows,rows,{
    roundTripCostBps,minimumReturnGapPct,maxPairsPerTimestamp,pairStrategy
  });}catch(error){return unavailable(String(error?.message||error));}
  if(!built.comparison_pairs)return unavailable(
    pairStrategy==='PROFITABILITY_BOUNDARY_V1'?'NO_PROFITABILITY_BOUNDARY_PAIRS':
    pairStrategy==='PROFITABILITY_TOPK_V2'?'NO_PROFITABILITY_TOPK_PAIRS':
    'NO_MATURED_WITHIN_TIMESTAMP_RETURN_PAIRS');
  let loss=0,correct=0;
  for(const pair of built.pairs){
    const item=tcnLstmPairwiseLogitRankingLoss(logits[pair.high_index],logits[pair.low_index]);
    loss+=item.loss;correct+=item.accuracy_contribution;
  }
  return {schema:pairStrategy==='PROFITABILITY_BOUNDARY_V1'
      ?'RADARX_TCN_LSTM_PROFITABILITY_BOUNDARY_LOGIT_METRICS_V1'
      :pairStrategy==='PROFITABILITY_TOPK_V2'
        ?'RADARX_TCN_LSTM_PROFITABILITY_TOPK_LOGIT_METRICS_V2'
        :'RADARX_TCN_LSTM_PAIRWISE_LOGIT_RANKING_METRICS_V1',
    status:'AVAILABLE',sample_count:rows.length,decision_group_count:built.decision_group_count,
    comparison_pairs:built.comparison_pairs,pairwise_log_loss:Number((loss/built.comparison_pairs).toFixed(8)),
    pairwise_accuracy_pct:Number((100*correct/built.comparison_pairs).toFixed(4)),
    pair_strategy:pairStrategy,
    positive_vs_non_positive_pairs:built.positive_vs_non_positive_pairs,
    positive_vs_positive_pairs:built.positive_vs_positive_pairs??0,
    positive_opportunity_groups:built.positive_opportunity_groups,
    mixed_decision_groups:built.mixed_decision_groups,
    source:pairStrategy==='PROFITABILITY_BOUNDARY_V1'
      ?'POSITIVE_NET_RETURN_VS_NON_POSITIVE_WITHIN_SIMULTANEOUS_DECISION_TIMESTAMP'
      :pairStrategy==='PROFITABILITY_TOPK_V2'
        ?'POSITIVE_VS_NON_POSITIVE_AND_WITHIN_POSITIVE_NET_RETURN_ORDER_WITHIN_SIMULTANEOUS_DECISION_TIMESTAMP'
        :'REALIZED_RETURN_WITHIN_SIMULTANEOUS_DECISION_TIMESTAMP',
    score_domain:'RAW_MODEL_LOGITS_NO_PROBABILITY_CLIPPING',
    diagnostic_only:true,holdout_values_used:false};
}


/**
 * Execution-side qualification for the auxiliary rank head. Pairwise loss can
 * improve while the actual Top-K portfolio gets worse; only the disjoint
 * inner-selection rows may qualify this separate ranking policy.
 */
export function summarizeTcnLstmRankingExecutionSelection(rows,rankingLogits,anchorLogits,{
  roundTripCostBps=30,minimumTrades=20,minimumWinRatePct=55,maximumDrawdownPct=8,
  abstentionPercentileGrid=[0.05,0.10,0.15,0.20,0.25,0.30,0.35,0.375,0.40,0.425,0.45,0.475,0.50,0.60,0.70,0.80,0.825,0.85,0.875,0.90,0.95]
}={}){
  const unavailable=reason=>({
    schema:'RADARX_TCN_LSTM_RANKING_EXECUTION_SELECTION_V2',
    status:'UNAVAILABLE',diagnostic_only:true,passed:false,reason,top_k_trials:[]
  });
  if(!Array.isArray(rows)||!Array.isArray(rankingLogits)||!Array.isArray(anchorLogits)||
    rows.length!==rankingLogits.length||rows.length!==anchorLogits.length||rows.length<20||
    rankingLogits.some(value=>!finite(value))||anchorLogits.some(value=>!finite(value)))
    return unavailable('RANKING_EXECUTION_SELECTION_INPUT_INVALID');
  if(!finite(roundTripCostBps)||roundTripCostBps<0||
    !Number.isInteger(minimumTrades)||minimumTrades<1||
    !finite(minimumWinRatePct)||minimumWinRatePct<0||minimumWinRatePct>100||
    !finite(maximumDrawdownPct)||maximumDrawdownPct<=0||
    !Array.isArray(abstentionPercentileGrid)||!abstentionPercentileGrid.length||
    abstentionPercentileGrid.some(value=>!finite(value)||value<=0||value>=1)||
    new Set(abstentionPercentileGrid).size!==abstentionPercentileGrid.length)
    return unavailable('RANKING_EXECUTION_SELECTION_CONFIGURATION_INVALID');
  if(rows.some(row=>!finite(row?.at)||!finite(row?.realized_return_pct)||
    !row?.first_touch||!finite(row.first_touch.first_touch_at)||
    !finite(row?.max_adverse_excursion_pct)||!finite(row?.max_adverse_excursion_at)||
    !finite(row?.max_favorable_excursion_pct)||!finite(row?.max_favorable_excursion_at)))
    return unavailable('SELECTION_EXECUTION_EVIDENCE_INCOMPLETE');

  const groups=new Map();
  rows.forEach((row,index)=>{
    const bucket=Math.floor(Number(row.at)/TCN_LSTM_RANKING_BUCKET_MS);
    if(!groups.has(bucket))groups.set(bucket,[]);
    groups.get(bucket).push(index);
  });
  const decisionGroups=[...groups.values()];
  if(!decisionGroups.length)return unavailable('NO_SELECTION_DECISION_GROUPS');

  // Top-K remains fixed at one. Only the raw independent rank-score threshold
  // is selected on this purged inner-selection partition. A zero/positive
  // floor is NOT imposed because a rank score is an ordering coordinate, not
  // an expected-return estimate; the inner quantile is its only cutoff.
  const bestScoreByGroup=decisionGroups.map(indices=>
    Math.max(...indices.map(index=>Number(rankingLogits[index])))
  ).sort((a,b)=>a-b);
  const trials=[];
  for(const percentile of abstentionPercentileGrid){
    const position=(bestScoreByGroup.length-1)*Number(percentile);
    const lower=Math.floor(position),upper=Math.ceil(position);
    const threshold=lower===upper?bestScoreByGroup[lower]:
      bestScoreByGroup[lower]+(bestScoreByGroup[upper]-bestScoreByGroup[lower])*
        (position-lower);
    const modelSelection=topKThresholdSignals(rows,rankingLogits,1,threshold);
    const logisticSelection=topKMatchedCountSignals(rows,anchorLogits,modelSelection);
    const options={threshold:0.5,roundTripCostBps,
      maxConcurrentPositions:NEURAL_CLOSURE_PORTFOLIO_POLICY.max_concurrent_positions,
      initialEquity:100};
    let modelMetrics,anchorMetrics;
    try{
      modelMetrics=simulateFirstTouchPaperPortfolio(rows,modelSelection.probabilities,options);
      anchorMetrics=simulateFirstTouchPaperPortfolio(rows,logisticSelection.probabilities,options);
    }catch(error){
      return unavailable('SELECTION_EXECUTION_SIMULATION_FAILED:'+String(error?.message||error));
    }
    const complete=modelMetrics.return_data_status==='COMPLETE'&&
      anchorMetrics.return_data_status==='COMPLETE';
    const abstainedDecisionGroups=modelSelection.abstained_decision_group_count;
    const abstentionRate=decisionGroups.length
      ?100*abstainedDecisionGroups/decisionGroups.length:0;
    const matchedSignalCount=modelSelection.signal_count===logisticSelection.signal_count;
    const matchedExecutedTradeCount=Number(modelMetrics.trade_count)===
      Number(anchorMetrics.trade_count);
    const gates={
      return_data_complete:complete,
      minimum_trades:Number(modelMetrics.trade_count)>=minimumTrades,
      minimum_win_rate:finite(modelMetrics.win_rate_pct)&&
        modelMetrics.win_rate_pct>=minimumWinRatePct,
      positive_net_pnl:finite(modelMetrics.net_pnl_pct)&&modelMetrics.net_pnl_pct>0,
      maximum_drawdown:finite(modelMetrics.max_drawdown_pct)&&
        modelMetrics.max_drawdown_pct<=maximumDrawdownPct,
      genuine_abstention:abstainedDecisionGroups>0&&
        modelSelection.signal_count<decisionGroups.length,
      matched_logistic_signal_count:matchedSignalCount,
      matched_logistic_executed_trade_count:matchedExecutedTradeCount,
      beats_logistic_anchor:complete&&matchedExecutedTradeCount&&
        modelMetrics.net_pnl_pct>anchorMetrics.net_pnl_pct&&
        modelMetrics.max_drawdown_pct<=anchorMetrics.max_drawdown_pct
    };
    trials.push({
      top_k_per_timestamp:1,
      abstention_percentile:Number(percentile),
      minimum_rank_score_threshold:Number(threshold),
      threshold_source:'INNER_SELECTION_GROUP_MAX_SCORE_QUANTILE_V1',
      threshold_selected_on_inner_selection:true,
      threshold_frozen_before_outer_validation:true,
      selected_trade_count:modelSelection.signal_count,
      decision_group_count:modelSelection.decision_group_count,
      abstained_decision_group_count:abstainedDecisionGroups,
      abstention_rate_pct:Number(abstentionRate.toFixed(4)),
      model_metrics:modelMetrics,
      logistic_anchor_metrics:anchorMetrics,
      logistic_anchor_signal_counts_matched:matchedSignalCount,
      logistic_anchor_trade_counts_matched:matchedExecutedTradeCount,
      model_minus_anchor:{
        net_pnl_pct:finite(modelMetrics.net_pnl_pct)&&finite(anchorMetrics.net_pnl_pct)
          ?Number((modelMetrics.net_pnl_pct-anchorMetrics.net_pnl_pct).toFixed(6)):null,
        win_rate_percentage_points:finite(modelMetrics.win_rate_pct)&&finite(anchorMetrics.win_rate_pct)
          ?Number((modelMetrics.win_rate_pct-anchorMetrics.win_rate_pct).toFixed(6)):null
      },
      gates,passed:Object.values(gates).every(Boolean)
    });
  }
  trials.sort((a,b)=>
    Number(b.passed)-Number(a.passed)||
    Number(b.model_metrics.trade_count>=minimumTrades)-
      Number(a.model_metrics.trade_count>=minimumTrades)||
    Number(b.model_metrics.net_pnl_pct??-Infinity)-
      Number(a.model_metrics.net_pnl_pct??-Infinity)||
    Number(b.model_metrics.win_rate_pct??-Infinity)-
      Number(a.model_metrics.win_rate_pct??-Infinity)||
    Number(a.model_metrics.max_drawdown_pct??Infinity)-
      Number(b.model_metrics.max_drawdown_pct??Infinity)
  );
  const best=trials[0];
  const passed=best?.passed===true;
  return {
    schema:'RADARX_TCN_LSTM_RANKING_EXECUTION_SELECTION_V2',
    status:'EVALUATED',diagnostic_only:true,passed,
    reason:passed?null:'NO_ABSTAINING_RANK_SCORE_POLICY_PASSED_EXECUTION_AND_ANCHOR_GATES',
    source_partition:'INNER_SELECTION_ONLY',
    threshold_selected_on_inner_selection:true,
    threshold_frozen_before_outer_validation:true,
    holdout_values_used:false,
    round_trip_cost_bps:Number(roundTripCostBps),
    minimum_trades:minimumTrades,minimum_win_rate_pct:minimumWinRatePct,
    require_positive_net_pnl:true,maximum_drawdown_pct:maximumDrawdownPct,
    requires_strict_improvement_over_logistic_anchor:true,
    affects_classifier_probabilities:false,affects_primary_threshold:false,
    top_k_per_timestamp:1,
    selected_abstention_percentile:best?.abstention_percentile??null,
    selected_minimum_rank_score_threshold:best?.minimum_rank_score_threshold??null,
    selected_trade_count:best?.selected_trade_count??0,
    selected_trial:best??null,
    top_k_trials:trials
  };
}


function evaluatePairwiseReturnRankingLoss(rows,pairs,model,anchor) {
  if(!pairs.length)return 0;
  let total=0;
  for(const pair of pairs){
    const high=rows[pair.high_index],low=rows[pair.low_index];
    const highLogit=inspectTcnLstmForward(high.sequence,model,0).ranking_score;
    const lowLogit=inspectTcnLstmForward(low.sequence,model,0).ranking_score;
    total+=tcnLstmPairwiseLogitRankingLoss(highLogit,lowLogit).loss;
  }
  return total/pairs.length;
}

/**
 * Pairwise ranking loss on the classifier's primary logit, not the frozen
 * auxiliary ranking head. Its gradient is propagated through the same TCN,
 * LSTM and attention parameters used by the probability output.
 */
function evaluateSharedClassifierRankingLoss(rows,pairs,model,anchor) {
  if(!pairs.length)return 0;
  let total=0;
  for(const pair of pairs){
    const high=rows[pair.high_index],low=rows[pair.low_index];
    const highBase=resolveTcnLstmRowClassifierBaselineLogit(high,anchor);
    const lowBase=resolveTcnLstmRowClassifierBaselineLogit(low,anchor);
    const highLogit=inspectTcnLstmForward(high.sequence,model,highBase).logit;
    const lowLogit=inspectTcnLstmForward(low.sequence,model,lowBase).logit;
    total+=tcnLstmPairwiseLogitRankingLoss(highLogit,lowLogit).loss;
  }
  return total/pairs.length;
}

function evaluateClassifierTrainingObjective(rows,model,anchor,{
  objective='BRIER',classWeights=null,gammaPositive=1,gammaNegative=2
}={}) {
  if(objective==='BRIER')return evaluateBrier(rows,model,anchor);
  if(objective!=='FOCAL_ASYMMETRIC_BRIER'||classWeights===null)
    throw new TypeError('TCN_LSTM_TRAINING_OBJECTIVE_CONFIGURATION_INVALID');
  let total=0;
  for(const row of rows){
    const baselineLogit=resolveTcnLstmRowClassifierBaselineLogit(row,anchor);
    const probability=inspectTcnLstmForward(row.sequence,model,baselineLogit).probability;
    total+=focalAsymmetricBrierLoss(probability,row.target,{
      ...classWeights,gammaPositive,gammaNegative
    }).loss;
  }
  return total/rows.length;
}

/**
 * Fit independent pointwise execution heads on frozen pooled representations.
 * Targets are derived exclusively from matured TRAINING partition outcomes.
 */
/**
 * Build identical execution-head inputs for fitting and inference.
 * Logistic and neural scores use tanh(logit / 4), keeping them bounded while
 * preserving their relative ranking signal alongside pooled latent channels.
 */
export function buildTcnLstmExecutionHeadInputFeatures(sequence,model,anchor,{
  variant='LOGIT_CONTEXT_AUGMENTED',externalLogisticLogit=null,
  classifierBaselineLogit=null
}={}) {
  if(!['POOLED_ONLY','LOGIT_CONTEXT_AUGMENTED'].includes(variant))
    throw new TypeError('TCN_LSTM_EXECUTION_HEAD_VARIANT_INVALID');
  if(variant==='LOGIT_CONTEXT_AUGMENTED'&&!finite(externalLogisticLogit))
    throw new TypeError('TCN_LSTM_EXECUTION_HEAD_EXTERNAL_LOGISTIC_SCORE_REQUIRED');
  const baselineLogit=predictTcnLstmLogisticLogit(sequence,anchor);
  const matchedClassifierBaselineLogit=finite(classifierBaselineLogit)
    ?clamp(Number(classifierBaselineLogit),-LOGIT_LIMIT,LOGIT_LIMIT):baselineLogit;
  const forward=inspectTcnLstmForward(sequence,model,matchedClassifierBaselineLogit);
  const pooled=Array.from(forward.cache.pooled);
  const normalizedLogisticScore=Math.tanh(
    baselineLogit/TCN_LSTM_EXECUTION_HEAD_SCORE_LOGIT_SCALE
  );
  const normalizedExternalLogisticScore=variant==='POOLED_ONLY'?0:Math.tanh(
    Number(externalLogisticLogit)/TCN_LSTM_EXECUTION_HEAD_SCORE_LOGIT_SCALE
  );
  const normalizedClassifierScore=Math.tanh(
    forward.logit/TCN_LSTM_EXECUTION_HEAD_SCORE_LOGIT_SCALE
  );
  const normalizedRankingScore=Math.tanh(
    forward.ranking_score/TCN_LSTM_EXECUTION_HEAD_SCORE_LOGIT_SCALE
  );
  const logisticGatedPooled=pooled.map(value=>value*normalizedLogisticScore);
  const externalLogisticGatedPooled=pooled.map(
    value=>value*normalizedExternalLogisticScore
  );
  const classifierGatedPooled=pooled.map(value=>value*normalizedClassifierScore);
  const rankingGatedPooled=pooled.map(value=>value*normalizedRankingScore);
  // The return/downside head receives four frozen contexts independently:
  // the recurrent Logistic anchor, a purged temporal-CV Logistic score,
  // the neural classifier score, and the train-only ranking residual.
  // The temporal-CV Logistic score is generated only by a model fitted on
  // the earlier pre-execution-head training block, never by a model trained
  // on the execution-head or later selection/validation rows.
  const features=variant==='POOLED_ONLY'
    ?pooled
    :[...pooled,...logisticGatedPooled,...externalLogisticGatedPooled,
      ...classifierGatedPooled,...rankingGatedPooled,
      normalizedLogisticScore,normalizedExternalLogisticScore,
      normalizedClassifierScore,normalizedRankingScore];
  const featureNames=[
    ...pooled.map((_,index)=>'pooled_latent_'+index),
    ...(variant==='POOLED_ONLY'?[]:[
      ...pooled.map((_,index)=>'pooled_latent_'+index+'_x_logistic_anchor_score'),
      ...pooled.map((_,index)=>'pooled_latent_'+index+'_x_temporal_logistic_cv_score'),
      ...pooled.map((_,index)=>'pooled_latent_'+index+'_x_neural_classifier_score'),
      ...pooled.map((_,index)=>'pooled_latent_'+index+'_x_independent_return_rank_score'),
      'logistic_anchor_logit_tanh_div_4',
      'temporal_logistic_cv_logit_tanh_div_4',
      'neural_classifier_logit_tanh_div_4',
      'independent_return_rank_score_tanh_div_4'
    ])
  ];
  if(features.some(value=>!finite(value)))
    throw new TypeError('TCN_LSTM_EXECUTION_HEAD_INPUT_FEATURE_NON_FINITE');
  return {
    variant,
    schema:variant==='POOLED_ONLY'
      ?'RADARX_TCN_LSTM_EXECUTION_HEAD_POOLED_ONLY_V1'
      :TCN_LSTM_EXECUTION_HEAD_INPUT_FEATURE_SCHEMA,
    features,feature_names:featureNames,
    pooled_feature_count:pooled.length,
    normalized_logistic_score:normalizedLogisticScore,
    normalized_external_logistic_score:normalizedExternalLogisticScore,
    normalized_classifier_score:normalizedClassifierScore,
    normalized_ranking_score:normalizedRankingScore,
    external_logistic_logit:variant==='POOLED_ONLY'?null:Number(externalLogisticLogit),
    independent_return_rank_score:forward.ranking_score,
    baseline_logit:baselineLogit,classifier_logit:forward.logit
  };
}
/**
 * Fit matched pooled-only and score-conditioned return/risk heads on matured
 * TRAINING outcomes only. The pooled-only model is retained as an ablation
 * control; the score-conditioned model is the default inference path.
 */
function fitTcnLstmExecutionRegressionHeads(rows,evidenceRows,model,anchor,{
  roundTripCostBps=30,learningRate=0.015,epochs=100,l2=0.002,huberDelta=1
}={}) {
  if(!Array.isArray(rows)||!Array.isArray(evidenceRows)||rows.length<20||
    rows.length!==evidenceRows.length||!finite(roundTripCostBps)||
    roundTripCostBps<0||roundTripCostBps>300||
    !finite(learningRate)||learningRate<=0||learningRate>0.1||
    !Number.isInteger(epochs)||epochs<10||epochs>300||
    !finite(l2)||l2<0||l2>1||!finite(huberDelta)||huberDelta<=0)
    throw new TypeError('TCN_LSTM_EXECUTION_HEAD_CONFIGURATION_INVALID');
  const evidence=new Map();
  for(const row of evidenceRows){
    const id=sampleIdentity(row);
    if(evidence.has(id)||!finite(row.realized_return_pct)||
      !finite(row.max_adverse_excursion_pct))
      throw new TypeError('TCN_LSTM_EXECUTION_TRAINING_EVIDENCE_INVALID:'+id);
    evidence.set(id,row);
  }
  if(evidence.size!==rows.length)
    throw new TypeError('TCN_LSTM_EXECUTION_TRAINING_EVIDENCE_COUNT_MISMATCH');
  const costPct=Number(roundTripCostBps)/100;
  const vectors=rows.map(row=>{
    const item=evidence.get(sampleIdentity(row));
    if(!item||Number(item.at)!==Number(row.at)||
      String(item.symbol??'')!==String(row.symbol??''))
      throw new TypeError('TCN_LSTM_EXECUTION_TRAINING_IDENTITY_MISMATCH');
    const pooled=buildTcnLstmExecutionHeadInputFeatures(
      row.sequence,model,anchor,{
        variant:'POOLED_ONLY',
        classifierBaselineLogit:finite(row.classifier_baseline_logit)
          ?Number(row.classifier_baseline_logit):null
      }
    ).features;
    if(!finite(row.external_logistic_logit))
      throw new TypeError('TCN_LSTM_EXECUTION_HEAD_EXTERNAL_LOGISTIC_TRAINING_SCORE_MISSING:'+id);
    const contextual=buildTcnLstmExecutionHeadInputFeatures(
      row.sequence,model,anchor,{
        variant:'LOGIT_CONTEXT_AUGMENTED',
        externalLogisticLogit:Number(row.external_logistic_logit),
        classifierBaselineLogit:finite(row.classifier_baseline_logit)
          ?Number(row.classifier_baseline_logit):null
      }
    ).features;
    const net=Math.max(-30,Math.min(30,Number(item.realized_return_pct)-costPct));
    const downside=Math.max(0,Math.min(30,-Number(item.max_adverse_excursion_pct)));
    return {pooled,contextual,net,downside};
  });
  const hurdleCalibrationSplit=splitTcnLstmHurdleProbabilityCalibrationRows(
    rows,vectors.map(item=>item.net),{horizonMs:4*60*60*1000}
  );
  const fitHead=(targetKey,featureKey,featureCount)=>{
    const rawFeatures=vectors.map(item=>item[featureKey]);
    const rawTargets=vectors.map(item=>Number(item[targetKey]));
    const moments=values=>{
      const mean=values.reduce((sum,value)=>sum+Number(value),0)/values.length;
      const variance=values.reduce((sum,value)=>sum+Math.pow(Number(value)-mean,2),0)/values.length;
      const rawStd=Math.sqrt(Math.max(0,variance));
      return {mean,std:rawStd>1e-8?rawStd:1,constant:rawStd<=1e-8};
    };
    const featureMoments=Array.from({length:featureCount},(_,index)=>
      moments(rawFeatures.map(row=>row[index])));
    const targetMoments=moments(rawTargets);
    const normalizedVectors=vectors.map((item,rowIndex)=>({
      features:rawFeatures[rowIndex].map((value,index)=>
        (Number(value)-featureMoments[index].mean)/featureMoments[index].std),
      target:(rawTargets[rowIndex]-targetMoments.mean)/targetMoments.std
    }));
    if(normalizedVectors.some(item=>item.features.some(value=>!finite(value))||
      !finite(item.target)))
      throw new TypeError('TCN_LSTM_EXECUTION_HEAD_STANDARDIZATION_NON_FINITE:'+targetKey+':'+featureKey);
    let weights=Array(featureCount).fill(0),bias=0;
    const m=Array(featureCount).fill(0),v=Array(featureCount).fill(0);
    let mb=0,vb=0,bestLoss=Infinity,best={weights:[...weights],bias},wait=0,done=0;
    const predict=(item,w,b)=>b+item.features.reduce((sum,x,i)=>sum+x*w[i],0);
    const loss=()=>normalizedVectors.reduce((sum,item)=>{
      const error=predict(item,weights,bias)-item.target;
      return sum+(Math.abs(error)<=huberDelta
        ?0.5*error*error:huberDelta*(Math.abs(error)-0.5*huberDelta));
    },0)/normalizedVectors.length;
    const initial=loss();
    for(let epoch=1;epoch<=epochs;epoch++){
      const gw=Array(featureCount).fill(0);let gb=0;
      for(const item of normalizedVectors){
        const error=predict(item,weights,bias)-item.target;
        const grad=Math.max(-huberDelta,Math.min(huberDelta,error));
        gb+=grad;
        for(let i=0;i<featureCount;i++)gw[i]+=grad*item.features[i];
      }
      for(let i=0;i<featureCount;i++)gw[i]=gw[i]/normalizedVectors.length+l2*weights[i];
      gb/=normalizedVectors.length;
      const gradientNorm=Math.sqrt(gw.reduce((sum,x)=>sum+x*x,0)+gb*gb);
      const clip=gradientNorm>2?2/gradientNorm:1;
      for(let i=0;i<featureCount;i++){
        const g=gw[i]*clip;
        m[i]=0.9*m[i]+0.1*g;v[i]=0.999*v[i]+0.001*g*g;
        weights[i]-=learningRate*(m[i]/(1-Math.pow(0.9,epoch)))/
          (Math.sqrt(v[i]/(1-Math.pow(0.999,epoch)))+1e-8);
      }
      const g=gb*clip;mb=0.9*mb+0.1*g;vb=0.999*vb+0.001*g*g;
      bias-=learningRate*(mb/(1-Math.pow(0.9,epoch)))/
        (Math.sqrt(vb/(1-Math.pow(0.999,epoch)))+1e-8);
      const current=loss();
      if(!finite(current)||weights.some(x=>!finite(x))||!finite(bias))
        throw new TypeError('TCN_LSTM_EXECUTION_HEAD_NON_FINITE:'+targetKey+':'+featureKey);
      done=epoch;
      if(current<bestLoss-1e-9){bestLoss=current;best={weights:[...weights],bias};wait=0;}
      else if(++wait>=20)break;
    }
    return {
      weights:best.weights,bias:best.bias,
      feature_mean:featureMoments.map(item=>Number(item.mean)),
      feature_std:featureMoments.map(item=>Number(item.std)),
      target_mean:Number(targetMoments.mean),target_std:Number(targetMoments.std),
      zero_variance_feature_count:featureMoments.filter(item=>item.constant).length,
      initial_huber_loss:Number(initial.toFixed(8)),
      final_huber_loss:Number(bestLoss.toFixed(8)),
      epochs_completed:done,feature_count:featureCount
    };
  };
  const hidden=TCN_LSTM_HIDDEN,contextCount=5*hidden+4
  const pooledOnly={
    net_return:fitHead('net','pooled',hidden),
    downside_risk:fitHead('downside','pooled',hidden)
  };
  const contextual={
    net_return:fitHead('net','contextual',contextCount),
    downside_risk:fitHead('downside','contextual',contextCount)
  };
  model.executionReturnHeadWeights=contextual.net_return.weights;
  model.executionReturnHeadBias=contextual.net_return.bias;
  model.executionRiskHeadWeights=contextual.downside_risk.weights;
  model.executionRiskHeadBias=contextual.downside_risk.bias;
  model.executionReturnHeadPooledOnlyWeights=pooledOnly.net_return.weights;
  model.executionReturnHeadPooledOnlyBias=pooledOnly.net_return.bias;
  model.executionRiskHeadPooledOnlyWeights=pooledOnly.downside_risk.weights;
  model.executionRiskHeadPooledOnlyBias=pooledOnly.downside_risk.bias;
  model.executionHeadInputFeatureSchema=TCN_LSTM_EXECUTION_HEAD_INPUT_FEATURE_SCHEMA;
  const fitHurdleVariant=featureKey=>{
    const fitIndexes=hurdleCalibrationSplit.status==='READY'
      ?hurdleCalibrationSplit.training_indexes:vectors.map((_,index)=>index);
    const fitReturns=fitIndexes.map(index=>Number(vectors[index].net));
    const positiveCount=fitReturns.filter(value=>value>0).length;
    const nonPositiveCount=fitReturns.length-positiveCount;
    if(positiveCount<8||nonPositiveCount<8)return {
      schema:'RADARX_TCN_LSTM_HURDLE_RETURN_HEAD_V2',fitted:false,
      reason:'HURDLE_RETURN_HEAD_CLASS_SUPPORT_TOO_SMALL',
      positive_rows:positiveCount,non_positive_rows:nonPositiveCount,
      fit_boundary:'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK_ONLY',
      validation_or_holdout_used:false
    };
    const head=fitHurdleReturnHead(
      fitIndexes.map(index=>vectors[index][featureKey]),fitReturns,
      {learningRate:0.02,epochs:200,l2:0.05,minimumClassRows:8}
    );
    if(hurdleCalibrationSplit.status==='READY'){
      const calibrationIndexes=hurdleCalibrationSplit.calibration_indexes;
      const calibrationReturns=calibrationIndexes.map(index=>Number(vectors[index].net));
      const rawProbabilities=calibrationIndexes.map(index=>
        predictHurdleExpectedNetReturn(vectors[index][featureKey],head)
          .raw_probability_positive_net_return
      );
      const calibrator=fitHurdlePositiveReturnCalibration(
        rawProbabilities,calibrationReturns,{
          minimumSamples:30,minimumPositive:8,minimumNegative:8,
          iterations:800,learningRate:0.03,regularization:0.05
        }
      );
      if(calibrator.fitted===true){
        const split=hurdleCalibrationSplit.diagnostics;
        head.probability_calibration={
          ...calibrator,
          training_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_TRAINING_BLOCK',
          calibration_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_CALIBRATION_BLOCK',
          training_rows:split.training_rows,
          training_positive_rows:split.training_net_return_support.positive,
          training_non_positive_rows:split.training_net_return_support.non_positive,
          training_max_at:split.training_max_at,
          training_max_resolved_at:split.training_max_resolved_at,
          calibration_rows:split.calibration_rows,
          calibration_positive_rows:split.calibration_net_return_support.positive,
          calibration_non_positive_rows:split.calibration_net_return_support.non_positive,
          calibration_min_at:split.calibration_min_at,
          purged_rows:split.purged_rows,
          purged_groups:split.purged_groups,
          horizon_ms:split.horizon_ms,
          resolved_label_gap_ms:split.resolved_label_gap_ms,
          training_decision_time_gap_ms:split.training_decision_time_gap_ms,
          chronology_valid:split.chronology_valid,
          complete_decision_groups:split.complete_decision_groups,
          disjoint_sample_identities:split.disjoint_sample_identities,
          source_partition:split.source_partition,
          validation_or_holdout_used:false
        };
      }
    }
    return head;
  };
  const hurdleReturnHeads={
    LOGIT_CONTEXT_AUGMENTED:fitHurdleVariant('contextual'),
    POOLED_ONLY:fitHurdleVariant('pooled')
  };
  model.executionHurdleReturnHeads=hurdleReturnHeads;
  model.executionHeadNormalizers={
    LOGIT_CONTEXT_AUGMENTED:{
      net_return:{feature_mean:contextual.net_return.feature_mean,
        feature_std:contextual.net_return.feature_std,
        target_mean:contextual.net_return.target_mean,target_std:contextual.net_return.target_std},
      downside_risk:{feature_mean:contextual.downside_risk.feature_mean,
        feature_std:contextual.downside_risk.feature_std,
        target_mean:contextual.downside_risk.target_mean,target_std:contextual.downside_risk.target_std}
    },
    POOLED_ONLY:{
      net_return:{feature_mean:pooledOnly.net_return.feature_mean,
        feature_std:pooledOnly.net_return.feature_std,
        target_mean:pooledOnly.net_return.target_mean,target_std:pooledOnly.net_return.target_std},
      downside_risk:{feature_mean:pooledOnly.downside_risk.feature_mean,
        feature_std:pooledOnly.downside_risk.feature_std,
        target_mean:pooledOnly.downside_risk.target_mean,target_std:pooledOnly.downside_risk.target_std}
    }
  };
  model.executionRegressionHeadsFitted=true;
  const normalizationSummary=head=>{
    const values=Object.values(head);
    return Object.fromEntries(values.map((item,index)=>[
      index===0?'net_return':'downside_risk',
      {feature_count:item.feature_count,
       zero_variance_feature_count:item.zero_variance_feature_count,
       target_mean:item.target_mean,target_std:item.target_std}
    ]));
  };
  return {
    schema:'RADARX_TCN_LSTM_SCORE_GATED_RETURN_DOWNSIDE_HEADS_V6_TRAIN_ONLY_ZSCORE',
    fitted:true,fit_boundary:'TRAINING_PARTITION_ONLY',
    source:'MATURED_REALIZED_RETURN_AND_MAX_ADVERSE_EXCURSION',
    training_rows:rows.length,round_trip_cost_bps:Number(roundTripCostBps),
    net_return_target:'REALIZED_RETURN_PCT_MINUS_ROUND_TRIP_COST',
    downside_target:'MAX_0_NEGATIVE_MAX_ADVERSE_EXCURSION_PCT',
    target_clip_pct:[-30,30],validation_or_holdout_used:false,
    hurdle_return_head:{
      schema:'RADARX_TCN_LSTM_HURDLE_RETURN_HEAD_V2',
      conditional_mean_type:'FEATURE_CONDITIONAL_HUBER_REGRESSION_V1',
      return_estimators:['POINTWISE_HUBER','HURDLE_EXPECTED_VALUE'],
      pooled_only:{
        fitted:hurdleReturnHeads.POOLED_ONLY?.fitted===true,
        positive_rows:hurdleReturnHeads.POOLED_ONLY?.positive_rows??0,
        non_positive_rows:hurdleReturnHeads.POOLED_ONLY?.non_positive_rows??0,
        empirical_positive_rate:hurdleReturnHeads.POOLED_ONLY?.empirical_positive_rate??null,
        class_reweighting_used:hurdleReturnHeads.POOLED_ONLY?.class_reweighting_used??false
      },
      logit_context_augmented:{
        fitted:hurdleReturnHeads.LOGIT_CONTEXT_AUGMENTED?.fitted===true,
        positive_rows:hurdleReturnHeads.LOGIT_CONTEXT_AUGMENTED?.positive_rows??0,
        non_positive_rows:hurdleReturnHeads.LOGIT_CONTEXT_AUGMENTED?.non_positive_rows??0,
        empirical_positive_rate:hurdleReturnHeads.LOGIT_CONTEXT_AUGMENTED?.empirical_positive_rate??null,
        class_reweighting_used:hurdleReturnHeads.LOGIT_CONTEXT_AUGMENTED?.class_reweighting_used??false
      },
      fit_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK_ONLY',
      probability_calibration_split:hurdleCalibrationSplit.diagnostics,
      probability_calibration:{
        contextual_fitted:hurdleReturnHeads.LOGIT_CONTEXT_AUGMENTED?.probability_calibration?.fitted===true,
        pooled_fitted:hurdleReturnHeads.POOLED_ONLY?.probability_calibration?.fitted===true,
        contextual_fit_boundary:hurdleReturnHeads.LOGIT_CONTEXT_AUGMENTED?.probability_calibration?.fit_boundary??null,
        pooled_fit_boundary:hurdleReturnHeads.POOLED_ONLY?.probability_calibration?.fit_boundary??null
      },
      validation_or_holdout_used:false
    },
    score_context:{
      schema:TCN_LSTM_EXECUTION_HEAD_INPUT_FEATURE_SCHEMA,
      features:[
        'LOGISTIC_ANCHOR_LOGIT_TANH_DIV_4',
        'PURGED_TEMPORAL_CV_LOGISTIC_LOGIT_TANH_DIV_4',
        'NEURAL_CLASSIFIER_LOGIT_TANH_DIV_4',
        'INDEPENDENT_RETURN_RANK_SCORE_TANH_DIV_4'
      ],
      interaction_features:[
        'POOLED_LATENT_X_LOGISTIC_ANCHOR_SCORE',
        'POOLED_LATENT_X_PURGED_TEMPORAL_CV_LOGISTIC_SCORE',
        'POOLED_LATENT_X_NEURAL_CLASSIFIER_SCORE',
        'POOLED_LATENT_X_INDEPENDENT_RETURN_RANK_SCORE'
      ],
      normalization:'TANH(LOGIT/4); MULTIPLICATIVE_GATING_OF_EACH_POOLED_CHANNEL',
      score_source:'SAME_TRAINING_ROW_TCN_LOGISTIC_ANCHOR_PLUS_SEPARATE_PURGED_TEMPORAL_CV_LOGISTIC_FIT_ON_PRE_EXECUTION_TRAINING_BLOCK_PLUS_RAW_TCN_LSTM_CLASSIFIER_PLUS_INDEPENDENT_TRAIN_ONLY_MULTISCALE_RETURN_RANK_SCORE',
      score_values_used_for_training:'PURGED_OUT_OF_SAMPLE_EXECUTION_HEAD_BLOCK_ONLY',
      temporal_logistic_cv_context_required:true,
      temporal_logistic_cv_context_source:'FROZEN_MODEL_FIT_ONLY_ON_PRE_EXECUTION_HEAD_TRAINING_ROWS',
      validation_or_holdout_labels_used_for_context_fit:false
    },
    normalization:{
      schema:'RADARX_TCN_LSTM_EXECUTION_HEAD_TRAIN_ONLY_ZSCORE_V1',
      method:'TRAIN_ONLY_POPULATION_ZSCORE_FOR_FEATURES_AND_TARGETS',
      fit_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK',
      fit_rows:rows.length,
      validation_or_holdout_used:false,
      pooled_only_reference:normalizationSummary({
        net_return:pooledOnly.net_return,downside_risk:pooledOnly.downside_risk
      }),
      logit_context_augmented:normalizationSummary({
        net_return:contextual.net_return,downside_risk:contextual.downside_risk
      })
    },
    pooled_only_reference:{
      variant:'POOLED_ONLY',feature_count:hidden,
      net_return:pooledOnly.net_return,downside_risk:pooledOnly.downside_risk
    },
    logit_context_augmented:{
      variant:'LOGIT_CONTEXT_AUGMENTED',feature_count:contextCount,
      net_return:contextual.net_return,downside_risk:contextual.downside_risk
    }
  };
}

export function predictTcnLstmHybridExecutionHeads(sequence,profile,{
  variant='LOGIT_CONTEXT_AUGMENTED',externalLogisticLogit=null
}={}) {
  if(!profile?.model||!profile?.baseline_fit)
    throw new TypeError('TCN_LSTM_PROFILE_NOT_TRAINED');
  if(profile.model.executionRegressionHeadsFitted!==true||
    profile.model.executionHeadInputFeatureSchema!==TCN_LSTM_EXECUTION_HEAD_INPUT_FEATURE_SCHEMA)
    throw new TypeError('TCN_LSTM_EXECUTION_HEAD_FEATURE_SCHEMA_OR_FIT_FLAG_INVALID');
  if(!['POOLED_ONLY','LOGIT_CONTEXT_AUGMENTED'].includes(variant))
    throw new TypeError('TCN_LSTM_EXECUTION_HEAD_VARIANT_INVALID');
  const classifierBaselineLogit=resolveTcnLstmProfileClassifierBaselineLogit(
    sequence,profile
  );
  const input=buildTcnLstmExecutionHeadInputFeatures(
    sequence,profile.model,profile.baseline_fit,{
      variant,externalLogisticLogit,classifierBaselineLogit
    }
  );
  const contextual=variant==='LOGIT_CONTEXT_AUGMENTED';
  const rw=contextual?profile.model.executionReturnHeadWeights:
    profile.model.executionReturnHeadPooledOnlyWeights;
  const dw=contextual?profile.model.executionRiskHeadWeights:
    profile.model.executionRiskHeadPooledOnlyWeights;
  const rb=contextual?profile.model.executionReturnHeadBias:
    profile.model.executionReturnHeadPooledOnlyBias;
  const db=contextual?profile.model.executionRiskHeadBias:
    profile.model.executionRiskHeadPooledOnlyBias;
  if(!Array.isArray(rw)||rw.length!==input.features.length||
    !Array.isArray(dw)||dw.length!==input.features.length||
    [...rw,...dw].some(x=>!finite(x))||!finite(rb)||!finite(db))
    throw new TypeError('TCN_LSTM_EXECUTION_HEADS_NOT_FITTED:'+variant);
  const normalizationVariant=variant==='POOLED_ONLY'?'POOLED_ONLY':'LOGIT_CONTEXT_AUGMENTED';
  const normalizers=profile.model.executionHeadNormalizers?.[normalizationVariant];
  const normalizeHead=(head,features)=>{
    if(!head||!Array.isArray(head.feature_mean)||!Array.isArray(head.feature_std)||
      head.feature_mean.length!==features.length||head.feature_std.length!==features.length||
      head.feature_mean.some(x=>!finite(x))||
      head.feature_std.some(x=>!finite(x)||Number(x)<=0)||
      !finite(head.target_mean)||!finite(head.target_std)||Number(head.target_std)<=0)
      throw new TypeError('TCN_LSTM_EXECUTION_HEAD_NORMALIZER_INVALID:'+normalizationVariant);
    return features.map((value,index)=>(Number(value)-Number(head.feature_mean[index]))/
      Number(head.feature_std[index]));
  };
  if(!normalizers?.net_return||!normalizers?.downside_risk)
    throw new TypeError('TCN_LSTM_EXECUTION_HEAD_NORMALIZERS_MISSING:'+normalizationVariant);
  const dot=(weights,bias,features)=>Number(bias)+features.reduce(
    (sum,x,i)=>sum+x*weights[i],0
  );
  const returnFeatures=normalizeHead(normalizers.net_return,input.features);
  const riskFeatures=normalizeHead(normalizers.downside_risk,input.features);
  const predictedNet=dot(rw,rb,returnFeatures)*Number(normalizers.net_return.target_std)+
    Number(normalizers.net_return.target_mean);
  const predictedRisk=dot(dw,db,riskFeatures)*Number(normalizers.downside_risk.target_std)+
    Number(normalizers.downside_risk.target_mean);
  if(!finite(predictedNet)||!finite(predictedRisk))
    throw new TypeError('TCN_LSTM_EXECUTION_HEAD_PREDICTION_NON_FINITE:'+normalizationVariant);
  const hurdleModel=profile.model.executionHurdleReturnHeads?.[normalizationVariant];
  const hurdlePrediction=hurdleModel?.fitted===true
    ?predictHurdleExpectedNetReturn(input.features,hurdleModel):null;
  return {
    variant,input_feature_schema:input.schema,input_feature_count:input.features.length,
    predicted_net_return_pct:Number(predictedNet),
    predicted_hurdle_net_return_pct:hurdlePrediction?.expected_net_return_pct??null,
    predicted_positive_net_return_probability:
      hurdlePrediction?.probability_positive_net_return??null,
    hurdle_positive_net_return_mean_pct:
      hurdlePrediction?.positive_net_return_mean_pct??null,
    hurdle_non_positive_net_return_mean_pct:
      hurdlePrediction?.non_positive_net_return_mean_pct??null,
    independent_return_rank_score:Number(input.independent_return_rank_score),
    normalized_independent_return_rank_score:Number(input.normalized_ranking_score),
    predicted_downside_risk_pct:Math.max(0,Number(predictedRisk))
  };
}

export function summarizeTcnLstmExecutionHeadContextAblation(
  pooledOnlyPolicy,contextPolicy
){
  const pooledMetrics=pooledOnlyPolicy?.selected_trial?.model_metrics??null;
  const contextMetrics=contextPolicy?.selected_trial?.model_metrics??null;
  const pooledTradeCount=Number(pooledMetrics?.trade_count);
  const contextTradeCount=Number(contextMetrics?.trade_count);
  // A fully abstaining pooled policy is a valid zero-exposure reference, not
  // missing evidence. Its win rate is correctly null because it made no trades.
  const pooledOnlyNoExposure=pooledMetrics!==null&&
    finite(pooledMetrics?.signal_count)&&Number(pooledMetrics.signal_count)===0&&
    finite(pooledMetrics?.trade_count)&&pooledTradeCount===0&&
    finite(pooledMetrics?.net_pnl_pct)&&Number(pooledMetrics.net_pnl_pct)===0&&
    finite(pooledMetrics?.max_drawdown_pct)&&Number(pooledMetrics.max_drawdown_pct)===0&&
    pooledMetrics?.return_data_status==='COMPLETE';
  const pooledPolicyHasTrades=pooledMetrics!==null&&
    finite(pooledMetrics?.trade_count)&&pooledTradeCount>0&&
    finite(pooledMetrics?.win_rate_pct)&&finite(pooledMetrics?.net_pnl_pct)&&
    finite(pooledMetrics?.max_drawdown_pct);
  const contextPolicyHasTrades=contextMetrics!==null&&
    finite(contextMetrics?.trade_count)&&contextTradeCount>0&&
    finite(contextMetrics?.win_rate_pct)&&finite(contextMetrics?.net_pnl_pct)&&
    finite(contextMetrics?.max_drawdown_pct);
  const available=pooledOnlyPolicy?.status!=='UNAVAILABLE'&&
    contextPolicy?.status!=='UNAVAILABLE'&&contextPolicyHasTrades&&
    (pooledOnlyNoExposure||pooledPolicyHasTrades);
  if(!available)return {
    schema:'RADARX_TCN_LSTM_EXECUTION_HEAD_CONTEXT_ABLATION_V1',
    status:'UNAVAILABLE',source_partition:'INNER_SELECTION_ONLY',
    pooled_only_policy_passed:pooledOnlyPolicy?.passed===true,
    context_policy_passed:contextPolicy?.passed===true,
    passed:false,reason:'BOTH_EXECUTION_HEAD_POLICIES_MUST_HAVE_COMPLETE_SELECTION_METRICS',
    holdout_values_used:false
  };
  const minimumWinRatePct=finite(contextPolicy?.minimum_win_rate_pct)
    ?Number(contextPolicy.minimum_win_rate_pct):55;
  const maximumDrawdownPct=finite(contextPolicy?.maximum_drawdown_pct)
    ?Number(contextPolicy.maximum_drawdown_pct):8;
  const gates={
    context_policy_absolute_gates:contextPolicy.passed===true,
    net_pnl_strictly_improved:
      Number(contextMetrics.net_pnl_pct)>Number(pooledMetrics.net_pnl_pct),
    // With no pooled trades, compare against the predeclared absolute win-rate
    // gate instead of comparing against an undefined baseline win rate.
    win_rate_not_worse:pooledOnlyNoExposure
      ?Number(contextMetrics.win_rate_pct)>=minimumWinRatePct
      :Number(contextMetrics.win_rate_pct)>=Number(pooledMetrics.win_rate_pct),
    // No-exposure has zero drawdown by construction; requiring a trading
    // candidate to have <= 0 drawdown would make the comparison impossible.
    // Keep the unchanged absolute drawdown cap in this special case.
    drawdown_not_worse:pooledOnlyNoExposure
      ?Number(contextMetrics.max_drawdown_pct)<=maximumDrawdownPct
      :Number(contextMetrics.max_drawdown_pct)<=Number(pooledMetrics.max_drawdown_pct)
  };
  return {
    schema:'RADARX_TCN_LSTM_EXECUTION_HEAD_CONTEXT_ABLATION_V1',
    status:'EVALUATED',source_partition:'INNER_SELECTION_ONLY',
    baseline_variant:'POOLED_ONLY',
    candidate_variant:'LOGIT_CONTEXT_AUGMENTED',
    pooled_only_no_exposure:pooledOnlyNoExposure,
    comparison_reference_mode:pooledOnlyNoExposure
      ?'NO_EXPOSURE_ZERO_TRADE_REFERENCE'
      :'BOTH_POLICIES_EXECUTED_TRADES',
    pooled_only_policy_passed:pooledOnlyPolicy.passed===true,
    context_policy_passed:contextPolicy.passed===true,
    both_policies_frozen_on_selection:
      pooledOnlyPolicy.threshold_frozen_before_outer_validation===true&&
      contextPolicy.threshold_frozen_before_outer_validation===true,
    baseline_and_candidate_use_matched_logistic_trade_counts:
      pooledOnlyPolicy.selected_trial?.logistic_anchor_trade_counts_matched===true&&
      contextPolicy.selected_trial?.logistic_anchor_trade_counts_matched===true,
    pooled_only_frozen_policy:{
      return_estimator:pooledOnlyPolicy.selected_return_estimator??'POINTWISE_HUBER',
      risk_penalty_weight:pooledOnlyPolicy.selected_risk_penalty_weight??null,
      minimum_risk_adjusted_score:pooledOnlyPolicy.selected_minimum_risk_adjusted_score??null,
      abstention_percentile:pooledOnlyPolicy.selected_abstention_percentile??null,
      top_k_per_timestamp:pooledOnlyPolicy.selected_top_k_per_timestamp??null
    },
    context_frozen_policy:{
      return_estimator:contextPolicy.selected_return_estimator??'POINTWISE_HUBER',
      risk_penalty_weight:contextPolicy.selected_risk_penalty_weight??null,
      minimum_risk_adjusted_score:contextPolicy.selected_minimum_risk_adjusted_score??null,
      abstention_percentile:contextPolicy.selected_abstention_percentile??null,
      top_k_per_timestamp:contextPolicy.selected_top_k_per_timestamp??null
    },
    pooled_only_metrics:{
      signal_count:pooledMetrics.signal_count??0,
      trade_count:pooledMetrics.trade_count,win_rate_pct:pooledMetrics.win_rate_pct??null,
      net_pnl_pct:pooledMetrics.net_pnl_pct,max_drawdown_pct:pooledMetrics.max_drawdown_pct
    },
    context_metrics:{
      signal_count:contextMetrics.signal_count??null,
      trade_count:contextMetrics.trade_count,win_rate_pct:contextMetrics.win_rate_pct,
      net_pnl_pct:contextMetrics.net_pnl_pct,max_drawdown_pct:contextMetrics.max_drawdown_pct
    },
    delta:{
      trade_count:Number(contextMetrics.trade_count)-Number(pooledMetrics.trade_count),
      win_rate_percentage_points:pooledOnlyNoExposure?null:
        Number((contextMetrics.win_rate_pct-pooledMetrics.win_rate_pct).toFixed(6)),
      net_pnl_percentage_points:Number(
        (contextMetrics.net_pnl_pct-pooledMetrics.net_pnl_pct).toFixed(6)
      ),
      drawdown_percentage_points:pooledOnlyNoExposure?null:
        Number((contextMetrics.max_drawdown_pct-pooledMetrics.max_drawdown_pct).toFixed(6))
    },
    gates,passed:Object.values(gates).every(Boolean),
    reason:Object.values(gates).every(Boolean)?null:
      pooledOnlyNoExposure
        ?'CONTEXT_POLICY_FAILED_ABSOLUTE_GATES_VS_NO_EXPOSURE_REFERENCE'
        :'CONTEXT_AUGMENTED_HEAD_DID_NOT_STRICTLY_BEAT_POOLED_ONLY_REFERENCE',
    holdout_values_used:false
  };
}
/** Choose risk penalty only on purged inner-selection rows, against identical Logistic opportunities. */
/**
 * Frozen inference score for cross-sectional execution ranking.
 * The penalty weight is selected on the purged inner-selection partition and
 * then carried unchanged into outer validation. Probability calibration is
 * deliberately separate from this return/risk score.
 */
export function predictTcnLstmHybridExecutionScore(sequence,profile,{
  externalLogisticLogit=null,variant='LOGIT_CONTEXT_AUGMENTED'
}={}) {
  const prediction=predictTcnLstmHybridExecutionHeads(sequence,profile,{
    externalLogisticLogit,variant
  });
  const contextual=variant==='LOGIT_CONTEXT_AUGMENTED';
  const returnEstimator=contextual
    ?profile?.execution_return_estimator??'POINTWISE_HUBER'
    :profile?.pooled_only_execution_return_estimator??'POINTWISE_HUBER';
  const predictedNetReturn=returnEstimator==='HURDLE_EXPECTED_VALUE'
    ?prediction.predicted_hurdle_net_return_pct:prediction.predicted_net_return_pct;
  const configuredLambda=contextual
    ?profile?.execution_risk_penalty_weight
    :profile?.pooled_only_execution_risk_penalty_weight;
  const lambda=finite(configuredLambda)
    ?clamp(Number(configuredLambda),0,8):null;
  const configuredRankWeight=contextual
    ?profile?.execution_ranking_score_adjustment_weight
    :profile?.pooled_only_execution_ranking_score_adjustment_weight;
  const rankWeight=finite(configuredRankWeight)
    ?clamp(Number(configuredRankWeight),0,8):0;
  const configuredProbabilityThreshold=contextual
    ?profile?.execution_minimum_positive_net_return_probability
    :profile?.pooled_only_execution_minimum_positive_net_return_probability;
  const minimumPositiveNetReturnProbability=finite(configuredProbabilityThreshold)
    ?clamp(Number(configuredProbabilityThreshold),0,1):0;
  const predictedPositiveNetReturnProbability=
    Number(prediction.predicted_positive_net_return_probability);
  const positiveReturnProbabilityEligible=minimumPositiveNetReturnProbability===0||
    (finite(predictedPositiveNetReturnProbability)&&
      predictedPositiveNetReturnProbability>=minimumPositiveNetReturnProbability);
  if(lambda===null||!finite(predictedNetReturn))
    return {status:'UNAVAILABLE',
      reason:lambda===null?'FROZEN_EXECUTION_RISK_PENALTY_NOT_SELECTED':
        'SELECTED_RETURN_ESTIMATOR_UNAVAILABLE',
      return_estimator:returnEstimator,
      predicted_net_return_pct:finite(predictedNetReturn)?Number(predictedNetReturn):null,
      predicted_pointwise_net_return_pct:prediction.predicted_net_return_pct,
      predicted_hurdle_net_return_pct:prediction.predicted_hurdle_net_return_pct,
      predicted_positive_net_return_probability:prediction.predicted_positive_net_return_probability,
      predicted_downside_risk_pct:prediction.predicted_downside_risk_pct,
      risk_penalty_weight:lambda,
      ranking_score_adjustment_weight:rankWeight,
      minimum_positive_net_return_probability:minimumPositiveNetReturnProbability,
      predicted_positive_net_return_probability:finite(predictedPositiveNetReturnProbability)
        ?predictedPositiveNetReturnProbability:null,
      positive_return_probability_eligible:positiveReturnProbabilityEligible,
      normalized_independent_return_rank_score:prediction.normalized_independent_return_rank_score,
      risk_adjusted_net_return_score:null};
  const baseRiskAdjustedScore=Number(predictedNetReturn)-
    lambda*prediction.predicted_downside_risk_pct;
  const normalizedRank=Number(prediction.normalized_independent_return_rank_score??0);
  const rankAdjustedSelectionScore=baseRiskAdjustedScore>0&&positiveReturnProbabilityEligible
    ?baseRiskAdjustedScore+rankWeight*normalizedRank
    :-1e9;
  if(!finite(baseRiskAdjustedScore)||!finite(rankAdjustedSelectionScore))
    return {status:'UNAVAILABLE',reason:'EXECUTION_RISK_ADJUSTED_SCORE_NON_FINITE',
      return_estimator:returnEstimator,predicted_net_return_pct:Number(predictedNetReturn),
      predicted_downside_risk_pct:prediction.predicted_downside_risk_pct,
      risk_penalty_weight:lambda,ranking_score_adjustment_weight:rankWeight,
      risk_adjusted_net_return_score:null,rank_adjusted_execution_selection_score:null};
  return {status:'AVAILABLE',
    score_semantics:minimumPositiveNetReturnProbability>0
      ?'POSITIVE_BASE_RISK_ADJUSTED_RETURN_AND_HURDLE_POSITIVE_RETURN_PROBABILITY_GATES; RANK_ADJUSTMENT_ONLY_SORTS_ELIGIBLE_CANDIDATES_V3'
      :rankWeight>0
        ?'POSITIVE_BASE_RISK_ADJUSTED_RETURN_REQUIRED; RANK_ADJUSTMENT_ONLY_SORTS_ELIGIBLE_CANDIDATES_V2'
      :returnEstimator==='HURDLE_EXPECTED_VALUE'
        ?'HURDLE_EXPECTED_NET_RETURN_MINUS_FROZEN_LAMBDA_TIMES_PREDICTED_DOWNSIDE_RISK'
        :'PREDICTED_NET_RETURN_MINUS_FROZEN_LAMBDA_TIMES_PREDICTED_DOWNSIDE_RISK',
    return_estimator:returnEstimator,
    predicted_net_return_pct:Number(predictedNetReturn),
    predicted_pointwise_net_return_pct:Number(prediction.predicted_net_return_pct),
    predicted_hurdle_net_return_pct:prediction.predicted_hurdle_net_return_pct,
    predicted_positive_net_return_probability:prediction.predicted_positive_net_return_probability,
    predicted_downside_risk_pct:Number(prediction.predicted_downside_risk_pct),
    independent_return_rank_score:Number(prediction.independent_return_rank_score),
    normalized_independent_return_rank_score:Number(prediction.normalized_independent_return_rank_score),
    risk_penalty_weight:lambda,
    ranking_score_adjustment_weight:rankWeight,
    minimum_positive_net_return_probability:minimumPositiveNetReturnProbability,
    predicted_positive_net_return_probability:finite(predictedPositiveNetReturnProbability)
      ?predictedPositiveNetReturnProbability:null,
    positive_return_probability_eligible:positiveReturnProbabilityEligible,
    base_risk_adjusted_expected_net_return_pct:Number(baseRiskAdjustedScore),
    base_risk_adjusted_return_positive:baseRiskAdjustedScore>0,
    risk_adjusted_net_return_score:Number(baseRiskAdjustedScore),
    rank_adjusted_execution_selection_score:Number(rankAdjustedSelectionScore)};
}

export function selectTcnLstmExecutionRiskPolicy(rows,executionPredictions,logisticLogits,{
  roundTripCostBps=30,minimumTrades=20,minimumWinRatePct=55,maximumDrawdownPct=8,
  abstentionPercentileGrid=[0.20,0.35,0.50,0.65,0.80,0.825,0.85,0.875,0.90],
  riskPenaltyWeightGrid=[0.01,0.025,0.05,0.1,0.25,0.5,1,2,4,8],
  rankingScoreAdjustmentGrid=[0],
  minimumPositiveNetReturnProbabilityGrid=[0]
}={}) {
  const unavailable=reason=>({
    schema:'RADARX_TCN_LSTM_SELECTIVE_EXECUTION_POLICY_V2',
    status:'UNAVAILABLE',reason,selection_partition_only:true,
    threshold_selected_on_inner_selection:false,holdout_values_used:false,passed:false
  });
  if(!Array.isArray(rows)||rows.length<20||!Array.isArray(executionPredictions)||
    executionPredictions.length!==rows.length||!Array.isArray(logisticLogits)||
    logisticLogits.length!==rows.length||
    rows.some(row=>!finite(row?.at)||!row?.first_touch||
      !finite(row?.realized_return_pct)||!finite(row?.max_adverse_excursion_pct))||
    executionPredictions.some(x=>!finite(x?.predicted_net_return_pct)||
      (x?.predicted_hurdle_net_return_pct!==null&&
        x?.predicted_hurdle_net_return_pct!==undefined&&
        !finite(x.predicted_hurdle_net_return_pct))||
      !finite(x?.predicted_downside_risk_pct)||x.predicted_downside_risk_pct<0)||
    (minimumPositiveNetReturnProbabilityGrid.some(value=>Number(value)>0)&&
      executionPredictions.some(x=>!finite(x?.predicted_positive_net_return_probability)||
        x.predicted_positive_net_return_probability<0||
        x.predicted_positive_net_return_probability>1))||
    logisticLogits.some(x=>!finite(x)))
    return unavailable('INNER_SELECTION_EXECUTION_EVIDENCE_INVALID');
  if(!finite(roundTripCostBps)||roundTripCostBps<0||
    !Number.isInteger(minimumTrades)||minimumTrades<1||
    !finite(minimumWinRatePct)||minimumWinRatePct<0||minimumWinRatePct>100||
    !finite(maximumDrawdownPct)||maximumDrawdownPct<=0||
    !Array.isArray(abstentionPercentileGrid)||!abstentionPercentileGrid.length||
    abstentionPercentileGrid.some(value=>!finite(value)||value<=0||value>=1)||
    new Set(abstentionPercentileGrid).size!==abstentionPercentileGrid.length||
    !Array.isArray(riskPenaltyWeightGrid)||!riskPenaltyWeightGrid.length||
    riskPenaltyWeightGrid.some(value=>!finite(value)||value<=0||value>8)||
    new Set(riskPenaltyWeightGrid).size!==riskPenaltyWeightGrid.length||
    !Array.isArray(minimumPositiveNetReturnProbabilityGrid)||
    !minimumPositiveNetReturnProbabilityGrid.length||
    minimumPositiveNetReturnProbabilityGrid.some(value=>!finite(value)||value<0||value>1)||
    new Set(minimumPositiveNetReturnProbabilityGrid).size!==minimumPositiveNetReturnProbabilityGrid.length||
    !Array.isArray(rankingScoreAdjustmentGrid)||!rankingScoreAdjustmentGrid.length||
    rankingScoreAdjustmentGrid.some(value=>!finite(value)||value<0||value>8)||
    new Set(rankingScoreAdjustmentGrid).size!==rankingScoreAdjustmentGrid.length)
    return unavailable('SELECTIVE_EXECUTION_POLICY_CONFIGURATION_INVALID');
  const groups=new Map();
  rows.forEach((row,index)=>{
    const bucket=Math.floor(Number(row.at)/TCN_LSTM_RANKING_BUCKET_MS);
    if(!groups.has(bucket))groups.set(bucket,[]);
    groups.get(bucket).push(index);
  });
  // A one-candidate 15m bucket is still a valid decision: Top-K=1 may enter
  // it only when its frozen risk-adjusted score clears the inner-selected floor.
  const eligible=[...groups.values()];
  if(!eligible.length)return unavailable('NO_SIMULTANEOUS_DECISION_GROUPS');
  const trials=[];
  // Top-K=1 remains fixed. Only the score cutoff and a bounded multiplier for
  // the independent raw rank coordinate are selected on inner-selection data.
  // The rank coordinate is added to the return/risk score, never to probability.
  const returnEstimators=[
    {name:'POINTWISE_HUBER',field:'predicted_net_return_pct'},
    ...(executionPredictions.every(item=>finite(item?.predicted_hurdle_net_return_pct))
      ?[{name:'HURDLE_EXPECTED_VALUE',field:'predicted_hurdle_net_return_pct'}]:[])
  ];
  for(const returnEstimator of returnEstimators){
    for(const lambda of riskPenaltyWeightGrid){
      for(const rankAdjustmentWeight of rankingScoreAdjustmentGrid){
        const baseRiskAdjustedScores=executionPredictions.map(item=>
          Number(item[returnEstimator.field])-
            lambda*Number(item.predicted_downside_risk_pct));
        for(const minimumPositiveNetReturnProbability of minimumPositiveNetReturnProbabilityGrid){
          const probabilityEligible=executionPredictions.map(item=>
            Number(minimumPositiveNetReturnProbability)===0||
            (finite(item?.predicted_positive_net_return_probability)&&
              Number(item.predicted_positive_net_return_probability)>=
                Number(minimumPositiveNetReturnProbability)));
          const riskScores=executionPredictions.map((item,index)=>{
            const normalizedRank=finite(item?.normalized_independent_return_rank_score)
              ?Number(item.normalized_independent_return_rank_score):0;
            // Base expected net return and Hurdle positive-return probability
            // are separate eligibility gates; rank only orders eligible rows.
            return baseRiskAdjustedScores[index]>0&&probabilityEligible[index]
              ?baseRiskAdjustedScores[index]+Number(rankAdjustmentWeight)*normalizedRank
              :-1e9;
          });
          const bestScoreByGroup=eligible.map(indices=>
            Math.max(...indices.map(index=>riskScores[index])));
          const sortedBestScores=[...bestScoreByGroup].sort((a,b)=>a-b);
          for(const percentile of abstentionPercentileGrid){
          const position=(sortedBestScores.length-1)*Number(percentile);
          const lower=Math.floor(position),upper=Math.ceil(position);
          const innerQuantileThreshold=lower===upper?sortedBestScores[lower]:
            sortedBestScores[lower]+(sortedBestScores[upper]-sortedBestScores[lower])*
              (position-lower);
          // Non-negotiable economic guard: never enter when the predicted
          // risk-adjusted net-return score is zero or negative.
          const threshold=Math.max(0,innerQuantileThreshold);
          const modelSelection=topKThresholdSignals(rows,riskScores,1,threshold);
          const logisticSelection=topKMatchedCountSignals(rows,logisticLogits,modelSelection);
          const options={threshold:0.5,roundTripCostBps,
            maxConcurrentPositions:NEURAL_CLOSURE_PORTFOLIO_POLICY.max_concurrent_positions,
            initialEquity:100};
          let modelMetrics,anchorMetrics;
          try{
            modelMetrics=simulateFirstTouchPaperPortfolio(rows,modelSelection.probabilities,options);
            anchorMetrics=simulateFirstTouchPaperPortfolio(rows,logisticSelection.probabilities,options);
          }catch(error){
            return unavailable('SELECTIVE_EXECUTION_SIMULATION_FAILED:'+String(error?.message||error));
          }
          const complete=modelMetrics.return_data_status==='COMPLETE'&&
            anchorMetrics.return_data_status==='COMPLETE';
          const abstainedDecisionGroups=modelSelection.abstained_decision_group_count;
          const abstentionRate=eligible.length
            ?100*abstainedDecisionGroups/eligible.length:0;
          const matchedSignalCount=modelSelection.signal_count===logisticSelection.signal_count;
          const matchedExecutedTradeCount=Number(modelMetrics.trade_count)===
            Number(anchorMetrics.trade_count);
          const gates={
            positive_risk_penalty_weight:lambda>0,
            non_negative_rank_adjustment_weight:rankAdjustmentWeight>=0,
            return_data_complete:complete,
            minimum_trades:Number(modelMetrics.trade_count)>=minimumTrades,
            minimum_win_rate:finite(modelMetrics.win_rate_pct)&&
              modelMetrics.win_rate_pct>=minimumWinRatePct,
            positive_net_pnl:finite(modelMetrics.net_pnl_pct)&&modelMetrics.net_pnl_pct>0,
            maximum_drawdown:finite(modelMetrics.max_drawdown_pct)&&
              modelMetrics.max_drawdown_pct<=maximumDrawdownPct,
            genuine_abstention:abstainedDecisionGroups>0&&
              modelSelection.signal_count<eligible.length,
            matched_logistic_signal_count:matchedSignalCount,
            matched_logistic_executed_trade_count:matchedExecutedTradeCount,
            beats_matched_logistic_anchor:complete&&matchedExecutedTradeCount&&
              modelMetrics.net_pnl_pct>anchorMetrics.net_pnl_pct&&
              modelMetrics.max_drawdown_pct<=anchorMetrics.max_drawdown_pct
          };
          trials.push({
            return_estimator:returnEstimator.name,
            risk_penalty_weight:lambda,
            ranking_score_adjustment_weight:Number(rankAdjustmentWeight),
            score_formula_id:'POSITIVE_BASE_RISK_ADJUSTED_RETURN_GATE_PLUS_NORMALIZED_INDEPENDENT_RANK_SELECTION_ADJUSTMENT_V2',
            base_risk_adjusted_expected_net_return_pct:Number(baseRiskAdjustedScores.reduce(
              (sum,value)=>sum+value,0)/baseRiskAdjustedScores.length),
            positive_base_risk_adjusted_candidate_count:
              baseRiskAdjustedScores.filter(value=>value>0).length,
            positive_base_risk_adjusted_return_gate_enforced:true,
            minimum_positive_net_return_probability:Number(minimumPositiveNetReturnProbability),
            positive_return_probability_candidate_count:probabilityEligible.filter(Boolean).length,
            positive_return_probability_gate_enforced:Number(minimumPositiveNetReturnProbability)>0,
            top_k_per_timestamp:1,
            minimum_risk_adjusted_score:Number(threshold),
            inner_quantile_score_threshold:Number(innerQuantileThreshold),
            positive_score_floor_enforced:true,
            threshold_floor_rule:'MAX_ZERO_AND_INNER_SELECTION_QUANTILE',
            abstention_percentile:Number(percentile),
            selected_trade_count:modelSelection.signal_count,
            decision_group_count:modelSelection.decision_group_count,
            abstained_decision_group_count:abstainedDecisionGroups,
            abstention_rate_pct:Number(abstentionRate.toFixed(4)),
            model_metrics:modelMetrics,
            logistic_anchor_metrics:anchorMetrics,
            logistic_anchor_signal_counts_matched:matchedSignalCount,
            logistic_anchor_trade_counts_matched:matchedExecutedTradeCount,
            model_minus_logistic_net_pnl_pct:finite(modelMetrics.net_pnl_pct)&&
              finite(anchorMetrics.net_pnl_pct)
              ?Number((modelMetrics.net_pnl_pct-anchorMetrics.net_pnl_pct).toFixed(6)):null,
            gates,passed:Object.values(gates).every(Boolean)
          });
          }
        }
      }
    }
  }
  trials.sort((a,b)=>Number(b.passed)-Number(a.passed)||
    Number(b.abstained_decision_group_count>0)-Number(a.abstained_decision_group_count>0)||
    Number(b.model_metrics.trade_count>=minimumTrades)-
      Number(a.model_metrics.trade_count>=minimumTrades)||
    Number(b.model_metrics.net_pnl_pct??-Infinity)-
      Number(a.model_metrics.net_pnl_pct??-Infinity)||
    Number(b.model_metrics.win_rate_pct??-Infinity)-
      Number(a.model_metrics.win_rate_pct??-Infinity)||
    Number(a.model_metrics.max_drawdown_pct??Infinity)-
      Number(b.model_metrics.max_drawdown_pct??Infinity));
  const best=trials[0];
  const passed=best?.passed===true;
  return {
    schema:'RADARX_TCN_LSTM_SELECTIVE_EXECUTION_POLICY_V2',
    status:passed?'SELECTIVE_EXECUTION_POLICY_PASSED_INNER_SELECTION':
      'ABSTAIN_NO_SELECTIVE_EXECUTION_POLICY_PASSED',
    selection_partition_only:true,
    threshold_selected_on_inner_selection:true,
    threshold_frozen_before_outer_validation:true,
    holdout_values_used:false,
    round_trip_cost_bps:Number(roundTripCostBps),
    minimum_trades:minimumTrades,
    minimum_win_rate_pct:minimumWinRatePct,
    maximum_drawdown_pct:maximumDrawdownPct,
    top_k_per_timestamp:1,
    passed,
    selected_return_estimator:best?.return_estimator??'POINTWISE_HUBER',
    risk_penalty_weight_grid:[...riskPenaltyWeightGrid],
    ranking_score_adjustment_weight_grid:[...rankingScoreAdjustmentGrid],
    minimum_positive_net_return_probability_grid:[...minimumPositiveNetReturnProbabilityGrid],
    selected_minimum_positive_net_return_probability:
      best?.minimum_positive_net_return_probability??0,
    selected_risk_penalty_weight:best?.risk_penalty_weight??null,
    selected_ranking_score_adjustment_weight:best?.ranking_score_adjustment_weight??0,
    selected_score_formula_id:best?.score_formula_id??
      'POSITIVE_BASE_RISK_ADJUSTED_RETURN_GATE_PLUS_NORMALIZED_INDEPENDENT_RANK_SELECTION_ADJUSTMENT_V2',
    positive_base_risk_adjusted_return_gate_enforced:true,
    selected_top_k_per_timestamp:1,
    selected_minimum_risk_adjusted_score:best?.minimum_risk_adjusted_score??null,
    selected_inner_quantile_score_threshold:best?.inner_quantile_score_threshold??null,
    positive_score_floor_enforced:true,
    selected_threshold_floor_rule:best?.threshold_floor_rule??'MAX_ZERO_AND_INNER_SELECTION_QUANTILE',
    selected_abstention_percentile:best?.abstention_percentile??null,
    selected_abstention_rate_pct:best?.abstention_rate_pct??null,
    selected_trade_count:best?.selected_trade_count??0,
    selected_trial:best??null,
    trials
  };
}

/**
 * Fit an independent linear rank head on frozen multi-scale TCN-LSTM states.
 * Its score is not initialized from or added to any Logistic/classifier logit.
 */
function fitTcnLstmPairwiseRankingHead(rows,pairs,model,anchor,{
  learningRate=0.03,epochs=40,l2=0.001,patience=10
}={}) {
  if(!Array.isArray(rows)||!Array.isArray(pairs)||pairs.length<10)
    throw new TypeError('TCN_LSTM_RANKING_HEAD_TRAINING_SUPPORT_TOO_SMALL');
  if(!finite(learningRate)||learningRate<=0||learningRate>0.25||
    !Number.isInteger(epochs)||epochs<1||epochs>200||
    !finite(l2)||l2<0||l2>1||
    !Number.isInteger(patience)||patience<1||patience>50)
    throw new TypeError('TCN_LSTM_RANKING_HEAD_CONFIGURATION_INVALID');
  const rawVectors=rows.map(row=>
    inspectTcnLstmForward(row.sequence,model,0).ranking_features
  );
  const featureCount=TCN_LSTM_RANKING_FEATURE_COUNT;
  if(rawVectors.some(row=>!Array.isArray(row)||row.length!==featureCount||row.some(value=>!finite(value))))
    throw new TypeError('TCN_LSTM_RANKING_FEATURE_MATRIX_INVALID');
  const moments=Array.from({length:featureCount},(_,column)=>{
    const values=rawVectors.map(row=>row[column]);
    const mean=values.reduce((sum,value)=>sum+value,0)/values.length;
    const variance=values.reduce((sum,value)=>sum+(value-mean)**2,0)/values.length;
    const rawStd=Math.sqrt(Math.max(0,variance));
    return {mean,std:rawStd>1e-8?rawStd:1};
  });
  model.rankingFeatureMean=moments.map(item=>Number(item.mean));
  model.rankingFeatureStd=moments.map(item=>Number(item.std));
  const vectors=rawVectors.map(row=>row.map((value,index)=>
    (value-model.rankingFeatureMean[index])/model.rankingFeatureStd[index]
  ));
  let weights=Array.isArray(model.rankingHeadWeights)
    ?[...model.rankingHeadWeights]:Array(featureCount).fill(0);
  if(weights.length!==featureCount||weights.some(value=>!finite(value)))
    throw new TypeError('TCN_LSTM_RANKING_HEAD_INITIAL_WEIGHTS_INVALID');
  const score=(index,currentWeights)=>{
    let value=0;
    for(let column=0;column<featureCount;column++)
      value+=currentWeights[column]*vectors[index][column];
    return clamp(value,-LOGIT_LIMIT,LOGIT_LIMIT);
  };
  const evaluate=currentWeights=>{
    let loss=0;
    for(const pair of pairs)
      loss+=tcnLstmPairwiseLogitRankingLoss(
        score(pair.high_index,currentWeights),score(pair.low_index,currentWeights)
      ).loss;
    return loss/pairs.length;
  };
  let bestLoss=evaluate(weights),bestWeights=[...weights],wait=0,completed=0;
  const initialLoss=bestLoss;
  const firstMoment=Array(featureCount).fill(0),secondMoment=Array(featureCount).fill(0);
  const beta1=0.9,beta2=0.999,epsilon=1e-8;
  for(let epoch=1;epoch<=epochs;epoch++){
    const gradient=Array(featureCount).fill(0);
    for(const pair of pairs){
      const item=tcnLstmPairwiseLogitRankingLoss(
        score(pair.high_index,weights),score(pair.low_index,weights)
      );
      for(let column=0;column<featureCount;column++)
        gradient[column]+=
          item.high_logit_gradient*vectors[pair.high_index][column]+
          item.low_logit_gradient*vectors[pair.low_index][column];
    }
    const averaged=gradient.map((value,column)=>
      value/pairs.length+l2*weights[column]);
    const norm=Math.sqrt(averaged.reduce((sum,value)=>sum+value*value,0));
    const clipped=norm>1?averaged.map(value=>value/norm):averaged;
    for(let column=0;column<featureCount;column++){
      firstMoment[column]=beta1*firstMoment[column]+(1-beta1)*clipped[column];
      secondMoment[column]=beta2*secondMoment[column]+(1-beta2)*clipped[column]*clipped[column];
      const correctedFirst=firstMoment[column]/(1-Math.pow(beta1,epoch));
      const correctedSecond=secondMoment[column]/(1-Math.pow(beta2,epoch));
      weights[column]=clamp(weights[column]-
        learningRate*correctedFirst/(Math.sqrt(correctedSecond)+epsilon),-8,8);
    }
    const currentLoss=evaluate(weights);
    if(!finite(currentLoss)||weights.some(value=>!finite(value)))
      throw new TypeError('TCN_LSTM_RANKING_HEAD_NON_FINITE');
    completed=epoch;
    if(currentLoss<bestLoss-1e-9){
      bestLoss=currentLoss;bestWeights=[...weights];wait=0;
    }else wait++;
    if(wait>=patience)break;
  }
  model.rankingHeadWeights=bestWeights;
  const finalLoss=evaluate(bestWeights);
  if(!finite(finalLoss)||bestWeights.some(value=>!finite(value)))
    throw new TypeError('TCN_LSTM_RANKING_HEAD_FINAL_STATE_INVALID');
  return {
    schema:'RADARX_TCN_LSTM_INDEPENDENT_MULTISCALE_RETURN_RANKER_V2',
    fitted:true,fit_boundary:'TRAINING_PARTITION_ONLY',
    input:'FROZEN_TCN_LSTM_MULTI_SCALE_TEMPORAL_STATE_V1',
    feature_count:featureCount,
    feature_groups:[
      'FULL_WINDOW_ATTENTION_POOL','LATEST_LSTM_STATE',
      'TRAILING_4_STEP_MEAN_STATE','TRAILING_8_STEP_MEAN_STATE'
    ],
    standardization:{
      method:'TRAIN_ONLY_POPULATION_ZSCORE',
      feature_mean:model.rankingFeatureMean,feature_std:model.rankingFeatureStd,
      fit_partition:'TRAINING_PARTITION_ONLY',fit_rows:rows.length,
      validation_or_holdout_used:false
    },
    baseline:'NONE_RANK_SCORE_IS_INDEPENDENT_OF_CLASSIFIER_AND_LOGISTIC_LOGITS',
    training_rows:rows.length,training_pairs:pairs.length,
    learning_rate:learningRate,epochs_requested:epochs,epochs_completed:completed,
    l2,patience,early_stopped:completed<epochs,
    initial_pairwise_log_loss:Number(initialLoss.toFixed(8)),
    final_pairwise_log_loss:Number(finalLoss.toFixed(8)),
    weight_l2_norm:Number(Math.sqrt(bestWeights.reduce((sum,value)=>sum+value*value,0)).toFixed(8)),
    classifier_parameters_updated:false,validation_or_holdout_used:false
  };
}



/**
 * Fit an independent pairwise rank head directly on the full row-major 24x29
 * ordered input. The standardizer and weights use only the earlier model-fit
 * partition; downstream execution features are scored only after the frozen
 * ranker is complete. Classifier parameters and classifier probabilities are
 * not modified by this sidecar.
 */
function fitTcnLstmOrderedPairwiseRankingHead(rows,pairs,model,{
  learningRate=0.03,epochs=40,l2=0.001,patience=10,
  validationRows=null,validationPairs=null,temporalBlockCount=24,
  initialLogisticModel=null,
  epochSelectionMode='VALIDATION_CHECKPOINT'
}={}){
  const validTemporalBlockCounts=[1,2,3,4,6,8,12,24];
  if(!Array.isArray(rows)||!Array.isArray(pairs)||rows.length<20||pairs.length<10)
    throw new TypeError('TCN_LSTM_ORDERED_RANKING_HEAD_TRAINING_SUPPORT_TOO_SMALL');
  if(!finite(learningRate)||learningRate<=0||learningRate>0.25||
    !Number.isInteger(epochs)||epochs<1||epochs>200||
    !finite(l2)||l2<0||l2>8||
    !Number.isInteger(patience)||patience<1||patience>50||
    !validTemporalBlockCounts.includes(temporalBlockCount)||
    initialLogisticModel!==null&&(
      initialLogisticModel?.fit?.training_rows!==rows.length||
      initialLogisticModel?.standardizer?.fit_rows!==rows.length||
      !Array.isArray(initialLogisticModel?.fit?.weights)||
      initialLogisticModel.fit.weights.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      initialLogisticModel.fit.weights.some(value=>!finite(value))||
      !finite(initialLogisticModel?.fit?.bias)||
      !Array.isArray(initialLogisticModel?.standardizer?.means)||
      initialLogisticModel.standardizer.means.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      initialLogisticModel.standardizer.means.some(value=>!finite(value))||
      !Array.isArray(initialLogisticModel?.standardizer?.scales)||
      initialLogisticModel.standardizer.scales.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      initialLogisticModel.standardizer.scales.some(value=>!finite(value)||value<=0)||
      initialLogisticModel?.standardizer?.fit_partition!=='CURRENT_TRAINING_FOLD_ONLY'
    )||
    !['VALIDATION_CHECKPOINT','FIXED_EPOCHS'].includes(epochSelectionMode)||
    epochSelectionMode==='FIXED_EPOCHS'&&validationRows!==null)
    throw new TypeError('TCN_LSTM_ORDERED_RANKING_HEAD_CONFIGURATION_INVALID');
  const rawVectors=rows.map(row=>buildTcnLstmFlattenedFeatures(row.sequence));
  const featureCount=TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT;
  const channels=TCN_LSTM_INPUT_CHANNELS;
  const steps=TCN_LSTM_STEPS;
  const stepsPerBlock=steps/temporalBlockCount;
  const parameterCount=temporalBlockCount*channels;
  const parameterizationId='TEMPORAL_BLOCK_TIED_'+temporalBlockCount+'X'+channels+'_V1';
  if(rawVectors.some(row=>!Array.isArray(row)||row.length!==featureCount||
    row.some(value=>!finite(value))))
    throw new TypeError('TCN_LSTM_ORDERED_RANKING_FEATURE_MATRIX_INVALID');
  for(const pair of pairs){
    if(!Number.isInteger(pair.high_index)||!Number.isInteger(pair.low_index)||
      pair.high_index<0||pair.low_index<0||
      pair.high_index>=rows.length||pair.low_index>=rows.length||
      pair.high_index===pair.low_index)
      throw new TypeError('TCN_LSTM_ORDERED_RANKING_PAIR_INDEX_INVALID');
  }
  if((validationRows===null)!==(validationPairs===null)||
    validationRows!==null&&(!Array.isArray(validationRows)||!Array.isArray(validationPairs)||
      validationRows.length<20||validationPairs.length<10))
    throw new TypeError('TCN_LSTM_ORDERED_RANKING_VALIDATION_SUPPORT_INVALID');
  let validationRawVectors=null;
  if(validationRows!==null){
    assertRows(validationRows,'ORDERED_RANKER_INTERNAL_VALIDATION');
    const fitIds=new Set(rows.map(sampleIdentity));
    if(validationRows.some(row=>fitIds.has(sampleIdentity(row)))||
      !(Math.max(...rows.map(row=>Number(row.resolved_at)))<
        Math.min(...validationRows.map(row=>Number(row.at)))))
      throw new TypeError('TCN_LSTM_ORDERED_RANKING_VALIDATION_PURGE_VIOLATION');
    for(const pair of validationPairs){
      if(!Number.isInteger(pair.high_index)||!Number.isInteger(pair.low_index)||
        pair.high_index<0||pair.low_index<0||
        pair.high_index>=validationRows.length||pair.low_index>=validationRows.length||
        pair.high_index===pair.low_index)
        throw new TypeError('TCN_LSTM_ORDERED_RANKING_VALIDATION_PAIR_INDEX_INVALID');
    }
    validationRawVectors=validationRows.map(row=>buildTcnLstmFlattenedFeatures(row.sequence));
    if(validationRawVectors.some(row=>!Array.isArray(row)||row.length!==featureCount||
      row.some(value=>!finite(value))))
      throw new TypeError('TCN_LSTM_ORDERED_RANKING_VALIDATION_FEATURE_MATRIX_INVALID');
  }

  // Estimate one scaler per temporal block and channel. The same scaler is
  // repeated over the block so exported 696-wide inference remains identical.
  const groupMoments=Array.from({length:parameterCount},(_,parameter)=>{
    const block=Math.floor(parameter/channels);
    const channel=parameter%channels;
    const firstStep=block*stepsPerBlock;
    const lastStep=firstStep+stepsPerBlock;
    const count=rawVectors.length*stepsPerBlock;
    let mean=0;
    for(const vector of rawVectors)
      for(let step=firstStep;step<lastStep;step++)
        mean+=vector[step*channels+channel]/count;
    let variance=0;
    for(const vector of rawVectors)
      for(let step=firstStep;step<lastStep;step++)
        variance+=(vector[step*channels+channel]-mean)**2/count;
    const rawStd=Math.sqrt(Math.max(0,variance));
    return {mean,std:rawStd>1e-8?rawStd:1};
  });
  const means=Array(featureCount);
  const stds=Array(featureCount);
  for(let step=0;step<steps;step++){
    const block=Math.floor(step/stepsPerBlock);
    for(let channel=0;channel<channels;channel++){
      const feature=step*channels+channel;
      const moment=groupMoments[block*channels+channel];
      means[feature]=Number(moment.mean);
      stds[feature]=Number(moment.std);
    }
  }
  const vectors=rawVectors.map(row=>row.map((value,index)=>
    (value-means[index])/stds[index]
  ));
  const validationVectors=validationRawVectors?.map(row=>row.map((value,index)=>
    (value-means[index])/stds[index]
  ))??null;
  const initialFullWeights=Array.isArray(model.orderedRankingHeadWeights)
    ?[...model.orderedRankingHeadWeights]:Array(featureCount).fill(0);
  if(initialFullWeights.length!==featureCount||initialFullWeights.some(value=>!finite(value)))
    throw new TypeError('TCN_LSTM_ORDERED_RANKING_INITIAL_WEIGHTS_INVALID');
  // Preserve the complete fold-local Logistic score as an immutable anchor.
  // The temporal head learns only a residual initialized to exactly zero, so
  // every block count starts at the incumbent Logistic pair scores.
  const initialWeights=Array(parameterCount).fill(0);
  let initializationMethod='ZERO_OR_EXPLICIT_RANKER_WEIGHTS_V1';
  const logisticAnchor=initialLogisticModel===null?null:{
    weights:[...initialLogisticModel.fit.weights],
    means:[...initialLogisticModel.standardizer.means],
    scales:[...initialLogisticModel.standardizer.scales],
    bias:Number(initialLogisticModel.fit.bias)
  };
  if(initialLogisticModel!==null){
    initializationMethod='FOLD_LOCAL_LOGISTIC_ANCHORED_ZERO_RESIDUAL_HEAD_V1';
  }else{
    // Preserve the legacy initializer for independent diagnostic use.
    for(let block=0;block<temporalBlockCount;block++)
      for(let channel=0;channel<channels;channel++)
        for(let offset=0;offset<stepsPerBlock;offset++)
          initialWeights[block*channels+channel]+=
            initialFullWeights[(block*stepsPerBlock+offset)*channels+channel];
  }
  // L2 penalizes only the learned temporal residual, not the incumbent.
  const regularizationAnchorWeights=[...initialWeights];

  const pooledValue=(vector,block,channel)=>{
    let value=0;
    const firstStep=block*stepsPerBlock;
    for(let offset=0;offset<stepsPerBlock;offset++)
      value+=vector[(firstStep+offset)*channels+channel]/stepsPerBlock;
    return value;
  };
  const anchorScore=(index,rawFeatureVectors=rawVectors)=>{
    if(logisticAnchor===null)return 0;
    const vector=rawFeatureVectors[index];
    let value=logisticAnchor.bias;
    for(let feature=0;feature<featureCount;feature++)
      value+=((vector[feature]-logisticAnchor.means[feature])/
        logisticAnchor.scales[feature])*logisticAnchor.weights[feature];
    return clamp(value,-LOGIT_LIMIT,LOGIT_LIMIT);
  };
  const score=(index,currentWeights,featureVectors=vectors,rawFeatureVectors=rawVectors)=>{
    const vector=featureVectors[index];
    let residual=0;
    for(let block=0;block<temporalBlockCount;block++)
      for(let channel=0;channel<channels;channel++)
        residual+=currentWeights[block*channels+channel]*
          pooledValue(vector,block,channel);
    return clamp(anchorScore(index,rawFeatureVectors)+residual,-LOGIT_LIMIT,LOGIT_LIMIT);
  };
  const evaluate=(currentWeights,pairRows=pairs,featureVectors=vectors,rawFeatureVectors=rawVectors)=>{
    let loss=0,correct=0;
    for(const pair of pairRows){
      const metric=tcnLstmPairwiseLogitRankingLoss(
        score(pair.high_index,currentWeights,featureVectors,rawFeatureVectors),
        score(pair.low_index,currentWeights,featureVectors,rawFeatureVectors)
      );
      loss+=metric.loss;
      correct+=metric.accuracy_contribution;
    }
    return {pairwise_log_loss:loss/pairRows.length,pairwise_accuracy_pct:100*correct/pairRows.length};
  };
  const initialTrainingMetrics=evaluate(initialWeights);
  const initialValidationMetrics=validationPairs
    ?evaluate(initialWeights,validationPairs,validationVectors,validationRawVectors):initialTrainingMetrics;
  let bestLoss=initialValidationMetrics.pairwise_log_loss;
  let bestAccuracy=initialValidationMetrics.pairwise_accuracy_pct;
  let bestWeights=[...initialWeights],wait=0,completed=0,bestEpoch=0;
  let validationCheckpointSelected=false;
  const firstMoment=Array(parameterCount).fill(0),secondMoment=Array(parameterCount).fill(0);
  const beta1=0.9,beta2=0.999,epsilon=1e-8;
  for(let epoch=1;epoch<=epochs;epoch++){
    const gradient=Array(parameterCount).fill(0);
    for(const pair of pairs){
      const item=tcnLstmPairwiseLogitRankingLoss(
        score(pair.high_index,initialWeights),score(pair.low_index,initialWeights)
      );
      const high=vectors[pair.high_index],low=vectors[pair.low_index];
      for(let block=0;block<temporalBlockCount;block++)
        for(let channel=0;channel<channels;channel++){
          const parameter=block*channels+channel;
          gradient[parameter]+=
            item.high_logit_gradient*pooledValue(high,block,channel)+
            item.low_logit_gradient*pooledValue(low,block,channel);
        }
    }
    const averaged=gradient.map((value,parameter)=>
      value/pairs.length+l2*(initialLogisticModel!==null
        ?initialWeights[parameter]-regularizationAnchorWeights[parameter]
        :initialWeights[parameter]));
    const norm=Math.sqrt(averaged.reduce((sum,value)=>sum+value*value,0));
    const clipped=norm>1?averaged.map(value=>value/norm):averaged;
    for(let parameter=0;parameter<parameterCount;parameter++){
      firstMoment[parameter]=beta1*firstMoment[parameter]+(1-beta1)*clipped[parameter];
      secondMoment[parameter]=beta2*secondMoment[parameter]+
        (1-beta2)*clipped[parameter]*clipped[parameter];
      const correctedFirst=firstMoment[parameter]/(1-Math.pow(beta1,epoch));
      const correctedSecond=secondMoment[parameter]/(1-Math.pow(beta2,epoch));
      initialWeights[parameter]=clamp(initialWeights[parameter]-
        learningRate*correctedFirst/(Math.sqrt(correctedSecond)+epsilon),-8,8);
    }
    const trainingMetrics=evaluate(initialWeights);
    const validationMetrics=validationPairs
      ?evaluate(initialWeights,validationPairs,validationVectors,validationRawVectors):trainingMetrics;
    if(!finite(trainingMetrics.pairwise_log_loss)||!finite(trainingMetrics.pairwise_accuracy_pct)||
      !finite(validationMetrics.pairwise_log_loss)||!finite(validationMetrics.pairwise_accuracy_pct)||
      initialWeights.some(value=>!finite(value)))
      throw new TypeError('TCN_LSTM_ORDERED_RANKING_HEAD_NON_FINITE');
    completed=epoch;
    if(epochSelectionMode==='FIXED_EPOCHS'){
      // Final fold/full-partition refits use the already selected epoch count.
      // Do not re-select a checkpoint on training loss or on the scoring fold.
      bestAccuracy=trainingMetrics.pairwise_accuracy_pct;
      bestLoss=trainingMetrics.pairwise_log_loss;
      bestWeights=[...initialWeights];bestEpoch=epoch;wait=0;
    }else{
      const currentAccuracy=validationMetrics.pairwise_accuracy_pct;
      const currentLoss=validationMetrics.pairwise_log_loss;
      const checkpointBetter=isTcnLstmDualMetricCheckpointBetter(
        {pairwise_accuracy_pct:currentAccuracy,pairwise_log_loss:currentLoss},
        {pairwise_accuracy_pct:bestAccuracy,pairwise_log_loss:bestLoss}
      );
      if(checkpointBetter){
        bestAccuracy=currentAccuracy;bestLoss=currentLoss;
        bestWeights=[...initialWeights];wait=0;bestEpoch=epoch;
        validationCheckpointSelected=true;
      }else wait++;
    }
    if(epochSelectionMode!=='FIXED_EPOCHS'&&wait>=patience)break;
  }
  const expandedWeights=Array(featureCount);
  for(let step=0;step<steps;step++){
    const block=Math.floor(step/stepsPerBlock);
    for(let channel=0;channel<channels;channel++)
      expandedWeights[step*channels+channel]=
        bestWeights[block*channels+channel]/stepsPerBlock;
  }
  model.orderedRankingHeadWeights=expandedWeights;
  model.orderedRankingFeatureMean=means;
  model.orderedRankingFeatureStd=stds;
  if(logisticAnchor!==null){
    model.orderedRankingAnchorWeights=[...logisticAnchor.weights];
    model.orderedRankingAnchorFeatureMean=[...logisticAnchor.means];
    model.orderedRankingAnchorFeatureStd=[...logisticAnchor.scales];
    model.orderedRankingAnchorBias=logisticAnchor.bias;
  }
  model.rankingRepresentation='RAW_ORDERED_696_V1';
  const finalTrainingMetrics=evaluate(bestWeights);
  const finalValidationMetrics=validationPairs
    ?evaluate(bestWeights,validationPairs,validationVectors,validationRawVectors):null;
  if(!finite(finalTrainingMetrics.pairwise_log_loss)||!finite(finalTrainingMetrics.pairwise_accuracy_pct)||
    finalValidationMetrics!==null&&(!finite(finalValidationMetrics.pairwise_log_loss)||
      !finite(finalValidationMetrics.pairwise_accuracy_pct))||
    bestWeights.some(value=>!finite(value))||expandedWeights.some(value=>!finite(value)))
    throw new TypeError('TCN_LSTM_ORDERED_RANKING_HEAD_FINAL_STATE_INVALID');
  return {
    schema:'RADARX_TCN_LSTM_INDEPENDENT_ORDERED_696_RETURN_RANKER_V1',
    fitted:epochSelectionMode==='FIXED_EPOCHS'||validationCheckpointSelected,
    representation:'RAW_ORDERED_696_V1',
    parameterization_id:parameterizationId,
    temporal_block_count:temporalBlockCount,
    steps_per_block:stepsPerBlock,
    parameter_count:parameterCount,
    fit_boundary:'TRAINING_PARTITION_ONLY',
    input:'RAW_ORDERED_TCN_LSTM_SEQUENCE_24X29_ROW_MAJOR_V1',
    feature_schema_id:TCN_LSTM_ORDERED_RANKING_FEATURE_SCHEMA_ID,
    feature_count:featureCount,
    standardization:{
      method:'TRAIN_ONLY_TEMPORAL_BLOCK_CHANNEL_ZSCORE',
      feature_mean:means,feature_std:stds,
      fit_partition:'TRAINING_PARTITION_ONLY',fit_rows:rows.length,
      validation_or_holdout_used:false
    },
    baseline:initialLogisticModel!==null
      ?'FOLD_LOCAL_LOGISTIC_RAW_SCORE_PLUS_ORDERED_PAIRWISE_RETURN_RESIDUAL_V1'
      :'NONE_RAW_ORDERED_FEATURE_PAIRWISE_HEAD_INDEPENDENT_OF_CLASSIFIER_AND_LOGISTIC_LOGITS',
    initialization_method:initializationMethod,
    regularization_anchor_method:initialLogisticModel!==null
      ?'ZERO_RESIDUAL_CORRECTION_PENALTY_V1':'ZERO_WEIGHT_ORIGINAL_L2_V1',
    initialization_exact_at_full_temporal_resolution:
      initialLogisticModel!==null&&temporalBlockCount===steps,
    initialization_preserves_logistic_pair_scores:initialLogisticModel!==null,
    initialization_source_rows:initialLogisticModel?.fit?.training_rows??0,
    training_rows:rows.length,training_pairs:pairs.length,
    learning_rate:learningRate,epochs_requested:epochs,epochs_completed:completed,
    l2,patience,early_stopped:completed<epochs,
    best_epoch:epochSelectionMode==='FIXED_EPOCHS'?completed:
      (validationCheckpointSelected?bestEpoch:null),
    validation_checkpoint_selected:epochSelectionMode==='FIXED_EPOCHS'
      ?null:validationCheckpointSelected,
    epoch_selection_mode:epochSelectionMode,
    epoch_checkpoint_selection_policy:epochSelectionMode==='FIXED_EPOCHS'
      ?'FIXED_EPOCH_COUNT_NO_CHECKPOINT_SELECTION'
      :'PARETO_NON_REGRESSION_PAIRWISE_ACCURACY_AND_LOG_LOSS_V1',
    selection_metric:epochSelectionMode==='FIXED_EPOCHS'
      ?'FIXED_EPOCH_COUNT_NO_VALIDATION_CHECKPOINT'
      :validationPairs
        ?'NESTED_PURGED_EPOCH_VALIDATION_PARETO_DUAL_METRIC_NON_REGRESSION'
        :'TRAINING_PAIRWISE_PARETO_DUAL_METRIC_NON_REGRESSION',
    initial_pairwise_log_loss:Number(initialTrainingMetrics.pairwise_log_loss.toFixed(8)),
    initial_pairwise_accuracy_pct:Number(initialTrainingMetrics.pairwise_accuracy_pct.toFixed(4)),
    initial_validation_pairwise_log_loss:validationPairs===null?null:
      Number(initialValidationMetrics.pairwise_log_loss.toFixed(8)),
    initial_validation_pairwise_accuracy_pct:validationPairs===null?null:
      Number(initialValidationMetrics.pairwise_accuracy_pct.toFixed(4)),
    final_pairwise_log_loss:Number(finalTrainingMetrics.pairwise_log_loss.toFixed(8)),
    final_pairwise_accuracy_pct:Number(finalTrainingMetrics.pairwise_accuracy_pct.toFixed(4)),
    best_validation_pairwise_log_loss:finalValidationMetrics===null?null:Number(finalValidationMetrics.pairwise_log_loss.toFixed(8)),
    best_validation_pairwise_accuracy_pct:finalValidationMetrics===null?null:Number(finalValidationMetrics.pairwise_accuracy_pct.toFixed(4)),
    internal_validation_rows:validationRows?.length??0,
    internal_validation_pairs:validationPairs?.length??0,
    weight_l2_norm:Number(Math.sqrt(bestWeights.reduce((sum,value)=>sum+value*value,0)).toFixed(8)),
    expanded_weight_l2_norm:Number(Math.sqrt(expandedWeights.reduce((sum,value)=>sum+value*value,0)).toFixed(8)),
    classifier_parameters_updated:false,validation_or_holdout_used:false
  };
}

/**
 * Fit the raw ordered return ranker once on the complete pre-execution model
 * training partition. This sidecar is independent of the classifier's OOF
 * residual subset: it consumes no Logistic predictions or classifier logits.
 * The returned state is frozen and can be shared across classifier candidates.
 */
export function fitTcnLstmOrderedRankerForTrainingPartition(rows,{
  roundTripCostBps=30,minimumReturnGapPct=0.50,maxPairsPerTimestamp=16,
  pairStrategy='PROFITABILITY_BOUNDARY_V1',
  learningRate=0.03,learningRateGrid=null,epochs=40,l2=0.001,patience=10,
  l2Grid=[0.25,0.5,1,2],
  // Focus compute on resolutions with the strongest previous purged-fold evidence.
  // Lower learning rates test conservative residual updates around the Logistic anchor.
  temporalBlockCounts=[4,6,8,24],
  validationFraction=0.08,purgeHorizonMs=4*60*60*1000
}={}){
  const validTemporalBlockCounts=[1,2,3,4,6,8,12,24];
  if(!Array.isArray(rows)||rows.length<20)
    throw new TypeError('TCN_LSTM_ORDERED_RANKER_PARTITION_TOO_SMALL');
  const candidateLearningRates=learningRateGrid===null
    ?[...new Set([0.003,0.006,0.01,0.02,Number(learningRate)])].sort((a,b)=>a-b)
    :learningRateGrid;
  if(!Array.isArray(l2Grid)||l2Grid.length<2||
    l2Grid.some(value=>!finite(value)||value<0||value>8)||
    new Set(l2Grid).size!==l2Grid.length||
    !Array.isArray(candidateLearningRates)||!candidateLearningRates.length||
    candidateLearningRates.some(value=>!finite(value)||value<=0||value>0.25)||
    new Set(candidateLearningRates).size!==candidateLearningRates.length||
    !Array.isArray(temporalBlockCounts)||!temporalBlockCounts.length||
    temporalBlockCounts.some(value=>!validTemporalBlockCounts.includes(value))||
    new Set(temporalBlockCounts).size!==temporalBlockCounts.length||
    !['RETURN_EXTREMES_V1','PROFITABILITY_BOUNDARY_V1','PROFITABILITY_TOPK_V2'].includes(pairStrategy)||
    !finite(validationFraction)||validationFraction<0.08||validationFraction>0.40||
    !finite(purgeHorizonMs)||purgeHorizonMs<0)
    throw new TypeError('TCN_LSTM_ORDERED_RANKER_TUNING_CONFIGURATION_INVALID');
  assertRows(rows,'ORDERED_RANKER_TRAINING_PARTITION');
  if(rows.some(row=>!finite(row.realized_return_pct)))
    throw new TypeError('TCN_LSTM_ORDERED_RANKER_RETURN_EVIDENCE_INCOMPLETE');
  const ordered=[...rows].sort((a,b)=>Number(a.at)-Number(b.at)||
    String(a.symbol??a.id??'').localeCompare(String(b.symbol??b.id??''))||
    String(a.id??'').localeCompare(String(b.id??'')));
  const pairSupport=buildTcnLstmReturnRankingPairs(ordered,ordered,{
    roundTripCostBps,minimumReturnGapPct,maxPairsPerTimestamp,
    pairStrategy
  });
  if(pairSupport.comparison_pairs<10)
    throw new TypeError('TCN_LSTM_ORDERED_RANKER_TRAINING_PAIR_SUPPORT_TOO_SMALL');
  const bucketAt=row=>Math.floor(Number(row.at)/TCN_LSTM_RANKING_BUCKET_MS)*
    TCN_LSTM_RANKING_BUCKET_MS;
  const groups=[...new Set(ordered.map(bucketAt))].sort((a,b)=>a-b);
  const validationGroupCount=Math.max(5,Math.floor(groups.length*validationFraction));
  // Three expanding forward windows cover early, middle and late training periods.
  // Each later fit window contains the previous scored window, then applies its own
  // four-hour maturity purge before scoring the next disjoint validation window.
  const foldFitFractions=[0.35,0.56,0.77];
  const folds=foldFitFractions.map((fitFraction,index)=>{
    const fitGroupCount=Math.max(1,Math.floor(groups.length*fitFraction));
    const fitGroups=new Set(groups.slice(0,fitGroupCount));
    const tuningRows=ordered.filter(row=>fitGroups.has(bucketAt(row)));
    const tuningMaxResolvedAt=Math.max(...tuningRows.map(row=>Number(row.resolved_at)));
    const tuningMaxAt=Math.max(...tuningRows.map(row=>Number(row.at)));
    const validationStartAfter=Math.max(tuningMaxResolvedAt,tuningMaxAt+purgeHorizonMs);
    const validationBuckets=groups.filter(bucket=>bucket>validationStartAfter)
      .slice(0,validationGroupCount);
    const validationBucketSet=new Set(validationBuckets);
    const validationRows=ordered.filter(row=>validationBucketSet.has(bucketAt(row)));
    const purgedRows=ordered.filter(row=>!fitGroups.has(bucketAt(row))&&
      bucketAt(row)<=validationStartAfter);
    const tuningPairSupport=buildTcnLstmReturnRankingPairs(tuningRows,tuningRows,{
      roundTripCostBps,minimumReturnGapPct,maxPairsPerTimestamp,
      pairStrategy
    });
    const validationPairSupport=validationRows.length>=20
      ?buildTcnLstmReturnRankingPairs(validationRows,validationRows,{
        roundTripCostBps,minimumReturnGapPct,maxPairsPerTimestamp,
        pairStrategy
      }):{comparison_pairs:0,pairs:[]};
    if(tuningRows.length<20||tuningPairSupport.comparison_pairs<10||
      validationRows.length<20||validationPairSupport.comparison_pairs<10||
      validationBuckets.length!==validationGroupCount)
      throw new TypeError('TCN_LSTM_ORDERED_RANKER_EXPANDING_FOLD_SUPPORT_TOO_SMALL:'+String(index+1));
    const validationMinAt=Math.min(...validationRows.map(row=>Number(row.at)));
    const validationMaxAt=Math.max(...validationRows.map(row=>Number(row.at)));
    const purgeGapMs=validationMinAt-tuningMaxAt;
    if(!(tuningMaxResolvedAt<validationMinAt)||purgeGapMs<purgeHorizonMs)
      throw new TypeError('TCN_LSTM_ORDERED_RANKER_INTERNAL_PURGE_VIOLATION:'+String(index+1));
    return {
      fold_index:index+1,
      fit_end_fraction:fitFraction,
      tuning_rows:tuningRows.length,
      validation_rows:validationRows.length,
      validation_decision_group_count:validationBuckets.length,
      purged_rows:purgedRows.length,
      tuning_pairs:tuningPairSupport.comparison_pairs,
      validation_pairs:validationPairSupport.comparison_pairs,
      tuning_max_resolved_at:tuningMaxResolvedAt,
      tuning_max_at:tuningMaxAt,
      validation_min_at:validationMinAt,
      validation_max_at:validationMaxAt,
      purge_gap_ms:purgeGapMs,
      tuningRows,tuningPairSupport,validationRows,validationPairSupport
    };
  });
  if(!folds.slice(0,-1).every((fold,index)=>
    fold.validation_max_at<folds[index+1].validation_min_at&&
    folds[index+1].tuning_max_at>=fold.validation_max_at))
    throw new TypeError('TCN_LSTM_ORDERED_RANKER_EXPANDING_FOLD_CHRONOLOGY_INVALID');
  // Use a nested purged window to select epochs only. Each later fold window
  // remains untouched until scoring; all candidates and Logistic are refit on
  // the complete, identical outer-fold training rows before scoring.
  const nestedEpochWindows=folds.map(fold=>{
    const windowBuckets=[...new Set(fold.tuningRows.map(bucketAt))].sort((a,b)=>a-b);
    const fitGroupCount=Math.max(5,Math.floor(windowBuckets.length*0.40));
    const epochValidationGroupCount=Math.max(5,Math.floor(windowBuckets.length*0.20));
    const fitGroups=new Set(windowBuckets.slice(0,fitGroupCount));
    const epochTrainingRows=fold.tuningRows.filter(row=>fitGroups.has(bucketAt(row)));
    const epochTrainingMaxAt=Math.max(...epochTrainingRows.map(row=>Number(row.at)));
    const epochTrainingMaxResolvedAt=Math.max(...epochTrainingRows.map(row=>Number(row.resolved_at)));
    const epochValidationStartAfter=Math.max(
      epochTrainingMaxResolvedAt,epochTrainingMaxAt+purgeHorizonMs
    );
    const epochValidationBuckets=windowBuckets.filter(bucket=>bucket>epochValidationStartAfter)
      .slice(0,epochValidationGroupCount);
    const epochValidationBucketSet=new Set(epochValidationBuckets);
    const epochValidationRows=fold.tuningRows.filter(row=>epochValidationBucketSet.has(bucketAt(row)));
    const epochTrainingIds=new Set(epochTrainingRows.map(sampleIdentity));
    const epochValidationIds=new Set(epochValidationRows.map(sampleIdentity));
    const epochTrainingPairSupport=buildTcnLstmReturnRankingPairs(
      epochTrainingRows,epochTrainingRows,{
        roundTripCostBps,minimumReturnGapPct,maxPairsPerTimestamp,
        pairStrategy
      }
    );
    const epochValidationPairSupport=epochValidationRows.length>=20
      ?buildTcnLstmReturnRankingPairs(epochValidationRows,epochValidationRows,{
        roundTripCostBps,minimumReturnGapPct,maxPairsPerTimestamp,
        pairStrategy
      }):{comparison_pairs:0,pairs:[]};
    if(epochTrainingRows.length<20||epochTrainingPairSupport.comparison_pairs<10||
      epochValidationRows.length<20||epochValidationPairSupport.comparison_pairs<10||
      epochValidationBuckets.length!==epochValidationGroupCount)
      throw new TypeError('TCN_LSTM_ORDERED_RANKER_NESTED_EPOCH_WINDOW_SUPPORT_TOO_SMALL:'+String(fold.fold_index));
    const epochValidationMinAt=Math.min(...epochValidationRows.map(row=>Number(row.at)));
    const epochValidationMaxAt=Math.max(...epochValidationRows.map(row=>Number(row.at)));
    const epochPurgeGapMs=epochValidationMinAt-epochTrainingMaxAt;
    if(!(epochTrainingMaxResolvedAt<epochValidationMinAt)||
      epochPurgeGapMs<purgeHorizonMs||
      !(epochValidationMaxAt<fold.validation_min_at)||
      epochValidationRows.some(row=>epochTrainingIds.has(sampleIdentity(row)))||
      epochTrainingRows.some(row=>epochValidationIds.has(sampleIdentity(row))))
      throw new TypeError('TCN_LSTM_ORDERED_RANKER_NESTED_EPOCH_WINDOW_PURGE_VIOLATION:'+String(fold.fold_index));
    const epochPurgedRows=fold.tuningRows.filter(row=>
      !epochTrainingIds.has(sampleIdentity(row))&&
      bucketAt(row)<=epochValidationStartAfter
    ).length;
    const epochUnusedRows=fold.tuningRows.length-
      epochTrainingRows.length-epochValidationRows.length-epochPurgedRows;
    if(epochUnusedRows<0)
      throw new TypeError('TCN_LSTM_ORDERED_RANKER_NESTED_EPOCH_WINDOW_ROW_ACCOUNTING_INVALID');
    // The epoch-selection warm start is fitted only on this nested fit window.
    // The later nested validation rows are passed for chronology checks only;
    // their labels and realized returns are never used by Logistic fitting.
    const epochLogisticBaseline=fitTemporalLogisticFoldRankingReference(
      epochTrainingRows,
      epochTrainingRows.map(row=>buildTcnLstmFlattenedFeatures(row.sequence)),{
        validationRows:epochValidationRows,
        l2:1,learningRate:0.03,maxEpochs:160,purgeHorizonMs
      }
    );
    const epochLogisticValidationLogits=epochValidationRows.map(row=>
      predictTemporalLogisticRawLogit(
        buildTcnLstmFlattenedFeatures(row.sequence),epochLogisticBaseline
      )
    );
    let epochLogisticLoss=0,epochLogisticCorrect=0;
    for(const pair of epochValidationPairSupport.pairs){
      const metric=tcnLstmPairwiseLogitRankingLoss(
        epochLogisticValidationLogits[pair.high_index],
        epochLogisticValidationLogits[pair.low_index]
      );
      epochLogisticLoss+=metric.loss;
      epochLogisticCorrect+=metric.accuracy_contribution;
    }
    const epochLogisticValidationMetrics={
      // Match the ranker report precision before asserting exact parity.
      // The ranker exposes eight decimals for loss and four for accuracy.
      pairwise_log_loss:Number((epochLogisticLoss/
        epochValidationPairSupport.comparison_pairs).toFixed(8)),
      pairwise_accuracy_pct:Number((100*epochLogisticCorrect/
        epochValidationPairSupport.comparison_pairs).toFixed(4))
    };
    return {
      epochTrainingRows,epochTrainingPairSupport,
      epochValidationRows,epochValidationPairSupport,epochLogisticBaseline,
      epochLogisticValidationMetrics,
      epoch_training_rows:epochTrainingRows.length,
      epoch_training_pairs:epochTrainingPairSupport.comparison_pairs,
      epoch_validation_rows:epochValidationRows.length,
      epoch_validation_pairs:epochValidationPairSupport.comparison_pairs,
      epoch_purged_rows:epochPurgedRows,
      epoch_unused_rows:epochUnusedRows,
      epoch_training_max_at:epochTrainingMaxAt,
      epoch_training_max_resolved_at:epochTrainingMaxResolvedAt,
      epoch_validation_min_at:epochValidationMinAt,
      epoch_validation_max_at:epochValidationMaxAt,
      epoch_purge_gap_ms:epochPurgeGapMs
    };
  });
  folds.forEach((fold,index)=>Object.assign(fold,nestedEpochWindows[index],{
    epochTrainingRows:nestedEpochWindows[index].epochTrainingRows,
    epochTrainingPairSupport:nestedEpochWindows[index].epochTrainingPairSupport,
    epochValidationRows:nestedEpochWindows[index].epochValidationRows,
    epochValidationPairSupport:nestedEpochWindows[index].epochValidationPairSupport,
    epochLogisticValidationMetrics:nestedEpochWindows[index].epochLogisticValidationMetrics
  }));
  // Fit the fixed project Logistic specification separately inside each
  // purged outer fold. Both models train on all rows in that fold's fit window
  // and are evaluated on identical later profitability-boundary pairs.
  const foldLogisticBaselines=folds.map(fold=>{
    const trainingVectors=fold.tuningRows.map(row=>
      buildTcnLstmFlattenedFeatures(row.sequence)
    );
    const baseline=fitTemporalLogisticFoldRankingReference(
      fold.tuningRows,trainingVectors,{
        validationRows:fold.validationRows,
        l2:1,learningRate:0.03,maxEpochs:160,
        purgeHorizonMs
      }
    );
    const validationLogits=fold.validationRows.map(row=>
      predictTemporalLogisticRawLogit(
        buildTcnLstmFlattenedFeatures(row.sequence),baseline
      )
    );
    let loss=0,correct=0;
    for(const pair of fold.validationPairSupport.pairs){
      const metric=tcnLstmPairwiseLogitRankingLoss(
        validationLogits[pair.high_index],validationLogits[pair.low_index]
      );
      loss+=metric.loss;
      correct+=metric.accuracy_contribution;
    }
    return {
      schema:baseline.schema,
      pairwise_log_loss:Number((loss/fold.validationPairSupport.comparison_pairs).toFixed(8)),
      pairwise_accuracy_pct:Number((100*correct/fold.validationPairSupport.comparison_pairs).toFixed(4)),
      training_rows:baseline.training_rows,
      validation_rows:baseline.validation_rows,
      validation_labels_read:baseline.validation_labels_read,
      validation_or_holdout_used:baseline.validation_or_holdout_used,
      model:baseline
    };
  });
  const tuningCandidates=[];
  for(const temporalBlockCount of temporalBlockCounts)
    for(const candidateL2 of l2Grid)
      for(const candidateLearningRate of candidateLearningRates){
      const foldResults=folds.map((fold,index)=>{
        const epochModel={
          orderedRankingHeadWeights:Array(TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT).fill(0),
          orderedRankingFeatureMean:Array(TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT).fill(0),
          orderedRankingFeatureStd:Array(TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT).fill(1),
          rankingRepresentation:'RAW_ORDERED_696_V1'
        };
        const epochSelection=fitTcnLstmOrderedPairwiseRankingHead(
          fold.epochTrainingRows,fold.epochTrainingPairSupport.pairs,epochModel,{
            learningRate:candidateLearningRate,epochs,l2:candidateL2,patience,
            validationRows:fold.epochValidationRows,
            validationPairs:fold.epochValidationPairSupport.pairs,
            temporalBlockCount,
            initialLogisticModel:fold.epochLogisticBaseline
          }
        );
        const tuningModel={
          orderedRankingHeadWeights:Array(TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT).fill(0),
          orderedRankingFeatureMean:Array(TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT).fill(0),
          orderedRankingFeatureStd:Array(TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT).fill(1),
          rankingRepresentation:'RAW_ORDERED_696_V1'
        };
        // If the nested epoch window yields no Pareto checkpoint, keep a
        // deterministic fixed-budget diagnostic refit but mark the fold as
        // unqualified. Never relabel the last attempted epoch as a selected best.
        const refitEpochCount=epochSelection.validation_checkpoint_selected===true
          ?epochSelection.best_epoch:epochs;
        const tuned=fitTcnLstmOrderedPairwiseRankingHead(
          fold.tuningRows,fold.tuningPairSupport.pairs,tuningModel,{
            learningRate:candidateLearningRate,epochs:refitEpochCount,l2:candidateL2,
            patience:Math.max(1,refitEpochCount),
            temporalBlockCount,initialLogisticModel:foldLogisticBaselines[index].model,
            epochSelectionMode:'FIXED_EPOCHS'
          }
        );
        const externalLogits=fold.validationRows.map(row=>{
          const vector=buildTcnLstmFlattenedFeatures(row.sequence);
          const anchorWeights=tuningModel.orderedRankingAnchorWeights;
          const anchorMeans=tuningModel.orderedRankingAnchorFeatureMean;
          const anchorStds=tuningModel.orderedRankingAnchorFeatureStd;
          let anchorScore=Number(tuningModel.orderedRankingAnchorBias);
          if(!Array.isArray(anchorWeights)||anchorWeights.length!==vector.length||
            !Array.isArray(anchorMeans)||anchorMeans.length!==vector.length||
            !Array.isArray(anchorStds)||anchorStds.length!==vector.length||
            !finite(anchorScore))
            throw new TypeError('TCN_LSTM_ORDERED_RANKER_LOGISTIC_ANCHOR_STATE_INVALID');
          for(let feature=0;feature<vector.length;feature++)
            anchorScore+=anchorWeights[feature]*
              ((vector[feature]-anchorMeans[feature])/anchorStds[feature]);
          if(!finite(anchorScore))
            throw new TypeError('TCN_LSTM_ORDERED_RANKER_LOGISTIC_ANCHOR_NON_FINITE');
          let score=clamp(anchorScore,-LOGIT_LIMIT,LOGIT_LIMIT);
          for(let feature=0;feature<vector.length;feature++)
            score+=tuningModel.orderedRankingHeadWeights[feature]*
              ((vector[feature]-tuningModel.orderedRankingFeatureMean[feature])/
                tuningModel.orderedRankingFeatureStd[feature]);
          if(!finite(score))throw new TypeError('TCN_LSTM_ORDERED_RANKER_OUTER_FOLD_SCORE_NON_FINITE');
          return clamp(score,-LOGIT_LIMIT,LOGIT_LIMIT);
        });
        let externalLoss=0,externalCorrect=0;
        for(const pair of fold.validationPairSupport.pairs){
          const metric=tcnLstmPairwiseLogitRankingLoss(
            externalLogits[pair.high_index],externalLogits[pair.low_index]
          );
          externalLoss+=metric.loss;
          externalCorrect+=metric.accuracy_contribution;
        }
        const externalMetrics={
          pairwise_log_loss:externalLoss/fold.validationPairSupport.comparison_pairs,
          pairwise_accuracy_pct:100*externalCorrect/fold.validationPairSupport.comparison_pairs
        };
        const logistic=foldLogisticBaselines[index];
        return {
          fold_index:fold.fold_index,
          best_epoch:refitEpochCount,
          epoch_checkpoint_selected:epochSelection.validation_checkpoint_selected===true,
          best_validation_pairwise_log_loss:Number(externalMetrics.pairwise_log_loss.toFixed(8)),
          best_validation_pairwise_accuracy_pct:Number(externalMetrics.pairwise_accuracy_pct.toFixed(4)),
          epoch_selection_pairwise_log_loss:epochSelection.best_validation_pairwise_log_loss,
          epoch_selection_pairwise_accuracy_pct:epochSelection.best_validation_pairwise_accuracy_pct,
          epoch_initial_pairwise_log_loss:epochSelection.initial_validation_pairwise_log_loss,
          epoch_initial_pairwise_accuracy_pct:epochSelection.initial_validation_pairwise_accuracy_pct,
          epoch_logistic_validation_pairwise_log_loss:fold.epochLogisticValidationMetrics.pairwise_log_loss,
          epoch_logistic_validation_pairwise_accuracy_pct:fold.epochLogisticValidationMetrics.pairwise_accuracy_pct,
          epoch_initial_matches_logistic_anchor:
            Math.abs(epochSelection.initial_validation_pairwise_log_loss-
              fold.epochLogisticValidationMetrics.pairwise_log_loss)<=1e-10&&
            Math.abs(epochSelection.initial_validation_pairwise_accuracy_pct-
              fold.epochLogisticValidationMetrics.pairwise_accuracy_pct)<=1e-8,
          logistic_validation_pairwise_log_loss:logistic.pairwise_log_loss,
          logistic_validation_pairwise_accuracy_pct:logistic.pairwise_accuracy_pct,
          training_pairwise_log_loss:tuned.final_pairwise_log_loss,
          training_pairwise_accuracy_pct:tuned.final_pairwise_accuracy_pct,
          training_rows:fold.tuning_rows,
          validation_rows:fold.validation_rows,
          purged_rows:fold.purged_rows,
          training_pairs:fold.tuning_pairs,
          validation_pairs:fold.validation_pairs,
          epoch_training_rows:fold.epoch_training_rows,
          epoch_training_pairs:fold.epoch_training_pairs,
          epoch_validation_rows:fold.epoch_validation_rows,
          epoch_validation_pairs:fold.epoch_validation_pairs,
          epoch_purged_rows:fold.epoch_purged_rows,
          epoch_unused_rows:fold.epoch_unused_rows,
          epoch_purge_gap_ms:fold.epoch_purge_gap_ms
        };
      });
      const totalValidationPairs=foldResults.reduce((sum,item)=>sum+item.validation_pairs,0);
      const totalTrainingPairs=foldResults.reduce((sum,item)=>sum+item.training_pairs,0);
      const weightedValidationLoss=foldResults.reduce((sum,item)=>
        sum+item.best_validation_pairwise_log_loss*item.validation_pairs,0)/totalValidationPairs;
      const weightedTrainingLoss=foldResults.reduce((sum,item)=>
        sum+item.training_pairwise_log_loss*item.training_pairs,0)/totalTrainingPairs;
      const weightedValidationAccuracy=foldResults.reduce((sum,item)=>
        sum+item.best_validation_pairwise_accuracy_pct*item.validation_pairs,0)/totalValidationPairs;
      const weightedTrainingAccuracy=foldResults.reduce((sum,item)=>
        sum+item.training_pairwise_accuracy_pct*item.training_pairs,0)/totalTrainingPairs;
      const weightedLogisticValidationAccuracy=foldResults.reduce((sum,item)=>
        sum+item.logistic_validation_pairwise_accuracy_pct*item.validation_pairs,0)/totalValidationPairs;
      const weightedLogisticValidationLoss=foldResults.reduce((sum,item)=>
        sum+item.logistic_validation_pairwise_log_loss*item.validation_pairs,0)/totalValidationPairs;
      const minimumFoldValidationAccuracy=Math.min(...foldResults.map(item=>item.best_validation_pairwise_accuracy_pct));
      const minimumFoldAccuracyImprovement=Math.min(...foldResults.map(item=>
        item.best_validation_pairwise_accuracy_pct-item.logistic_validation_pairwise_accuracy_pct
      ));
      const weightedAccuracyImprovement=weightedValidationAccuracy-weightedLogisticValidationAccuracy;
      const minimumFoldLogLossImprovement=Math.min(...foldResults.map(item=>
        item.logistic_validation_pairwise_log_loss-item.best_validation_pairwise_log_loss
      ));
      const weightedLogLossImprovement=weightedLogisticValidationLoss-weightedValidationLoss;
      const accuracyVariance=foldResults.reduce((sum,item)=>
        sum+item.validation_pairs*(item.best_validation_pairwise_accuracy_pct-weightedValidationAccuracy)**2,0)/totalValidationPairs;
      const sortedEpochs=foldResults.map(item=>item.best_epoch).sort((a,b)=>a-b);
      const middle=Math.floor(sortedEpochs.length/2);
      const medianBestEpoch=sortedEpochs.length%2
        ?sortedEpochs[middle]
        :Math.max(1,Math.round((sortedEpochs[middle-1]+sortedEpochs[middle])/2));
      const lossVariance=foldResults.reduce((sum,item)=>
        sum+item.validation_pairs*(item.best_validation_pairwise_log_loss-weightedValidationLoss)**2,0)/
        totalValidationPairs;
      tuningCandidates.push({
        temporal_block_count:temporalBlockCount,
        steps_per_block:TCN_LSTM_STEPS/temporalBlockCount,
        parameterization_id:'TEMPORAL_BLOCK_TIED_'+temporalBlockCount+'X'+
          TCN_LSTM_INPUT_CHANNELS+'_V1',
        parameter_count:temporalBlockCount*TCN_LSTM_INPUT_CHANNELS,
        l2:candidateL2,
        learning_rate:candidateLearningRate,
        best_epoch:medianBestEpoch,
        best_validation_pairwise_accuracy_pct:Number(weightedValidationAccuracy.toFixed(4)),
        minimum_fold_pairwise_accuracy_pct:Number(minimumFoldValidationAccuracy.toFixed(4)),
        validation_pairwise_accuracy_std_pct:Number(Math.sqrt(Math.max(0,accuracyVariance)).toFixed(4)),
        logistic_validation_pairwise_accuracy_pct:Number(weightedLogisticValidationAccuracy.toFixed(4)),
        logistic_validation_pairwise_log_loss:Number(weightedLogisticValidationLoss.toFixed(8)),
        best_validation_pairwise_accuracy_improvement_pct:Number(weightedAccuracyImprovement.toFixed(4)),
        minimum_fold_pairwise_accuracy_improvement_pct:Number(minimumFoldAccuracyImprovement.toFixed(4)),
        minimum_fold_pairwise_log_loss_improvement:Number(minimumFoldLogLossImprovement.toFixed(8)),
        best_validation_pairwise_log_loss_improvement:Number(weightedLogLossImprovement.toFixed(8)),
        best_validation_pairwise_log_loss:Number(weightedValidationLoss.toFixed(8)),
        validation_pairwise_log_loss_std:Number(Math.sqrt(Math.max(0,lossVariance)).toFixed(8)),
        training_pairwise_accuracy_pct:Number(weightedTrainingAccuracy.toFixed(4)),
        training_pairwise_log_loss:Number(weightedTrainingLoss.toFixed(8)),
        training_rows:foldResults.reduce((sum,item)=>sum+item.training_rows,0),
        validation_rows:foldResults.reduce((sum,item)=>sum+item.validation_rows,0),
        purged_rows:foldResults.reduce((sum,item)=>sum+item.purged_rows,0),
        training_pairs:totalTrainingPairs,
        validation_pairs:totalValidationPairs,
        fold_count:foldResults.length,
        epoch_checkpoint_selected_count:foldResults.filter(item=>item.epoch_checkpoint_selected===true).length,
        all_epoch_checkpoints_selected:foldResults.every(item=>item.epoch_checkpoint_selected===true),
        fold_results:foldResults
      });
    }
  const candidateOrder=(a,b)=>
    b.minimum_fold_pairwise_accuracy_improvement_pct-a.minimum_fold_pairwise_accuracy_improvement_pct||
    b.minimum_fold_pairwise_log_loss_improvement-a.minimum_fold_pairwise_log_loss_improvement||
    b.best_validation_pairwise_accuracy_improvement_pct-a.best_validation_pairwise_accuracy_improvement_pct||
    b.best_validation_pairwise_log_loss_improvement-a.best_validation_pairwise_log_loss_improvement||
    b.minimum_fold_pairwise_accuracy_pct-a.minimum_fold_pairwise_accuracy_pct||
    b.best_validation_pairwise_accuracy_pct-a.best_validation_pairwise_accuracy_pct||
    a.best_validation_pairwise_log_loss-b.best_validation_pairwise_log_loss||
    a.parameter_count-b.parameter_count||b.l2-a.l2||
    a.learning_rate-b.learning_rate||a.best_epoch-b.best_epoch;
  const foldStableDualMetricCandidates=tuningCandidates.filter(item=>
    item.all_epoch_checkpoints_selected===true&&
    item.minimum_fold_pairwise_accuracy_improvement_pct>0&&
    item.minimum_fold_pairwise_log_loss_improvement>0
  ).sort(candidateOrder);
  tuningCandidates.sort(candidateOrder);
  const selectedTuning=foldStableDualMetricCandidates[0]??tuningCandidates[0];
  const selectedCandidateQualified=foldStableDualMetricCandidates.length>0;
  const finalEpochs=Math.max(1,selectedTuning.best_epoch);
  const finalLogisticRankingBaseline=fitTemporalLogisticFoldRankingReference(
    ordered,ordered.map(row=>buildTcnLstmFlattenedFeatures(row.sequence)),{
      l2:1,learningRate:0.03,maxEpochs:160,purgeHorizonMs
    }
  );
  const rankerModel={
    orderedRankingHeadWeights:Array(TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT).fill(0),
    orderedRankingFeatureMean:Array(TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT).fill(0),
    orderedRankingFeatureStd:Array(TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT).fill(1),
    rankingRepresentation:'RAW_ORDERED_696_V1'
  };
  const training=fitTcnLstmOrderedPairwiseRankingHead(
    ordered,pairSupport.pairs,rankerModel,{
      learningRate:selectedTuning.learning_rate,epochs:finalEpochs,l2:selectedTuning.l2,
      patience:Math.min(50,finalEpochs),
      temporalBlockCount:selectedTuning.temporal_block_count,
      initialLogisticModel:finalLogisticRankingBaseline,
      epochSelectionMode:'FIXED_EPOCHS'
    }
  );
  training.selection_metric='THREE_FOLD_MINIMUM_LOGISTIC_ACCURACY_AND_LOG_LOSS_MARGIN_NESTED_PURGED_EXPANDING_WINDOW_V6';
  const foldMetadata=folds.map(({tuningRows,tuningPairSupport,validationRows,
    validationPairSupport,epochTrainingRows,epochTrainingPairSupport,
    epochValidationRows,epochValidationPairSupport,...metadata},index)=>({
      ...metadata,
      logistic_validation_pairwise_log_loss:foldLogisticBaselines[index].pairwise_log_loss,
      logistic_validation_pairwise_accuracy_pct:foldLogisticBaselines[index].pairwise_accuracy_pct,
      logistic_baseline_training_rows:foldLogisticBaselines[index].training_rows,
      logistic_baseline_validation_labels_read:foldLogisticBaselines[index].validation_labels_read,
      logistic_baseline_validation_or_holdout_used:foldLogisticBaselines[index].validation_or_holdout_used
    }));
  const internalTuningRows=foldMetadata.reduce((sum,item)=>sum+item.tuning_rows,0);
  const internalValidationRows=foldMetadata.reduce((sum,item)=>sum+item.validation_rows,0);
  const internalPurgedRows=foldMetadata.reduce((sum,item)=>sum+item.purged_rows,0);
  const internalTuningPairs=foldMetadata.reduce((sum,item)=>sum+item.tuning_pairs,0);
  const internalValidationPairs=foldMetadata.reduce((sum,item)=>sum+item.validation_pairs,0);
  const internalPurgeGapMs=Math.min(...foldMetadata.map(item=>item.purge_gap_ms));
  training.internal_training_validation={
    schema:'RADARX_TCN_LSTM_ORDERED_RANKER_INTERNAL_PURGED_EXPANDING_VALIDATION_V6',
    method:'THREE_FOLD_NESTED_PARETO_CHECKPOINT_REQUIRED_LOGISTIC_ANCHORED_VALIDATION_V3',
    epoch_checkpoint_selection_policy:
      'PARETO_NON_REGRESSION_PAIRWISE_ACCURACY_AND_LOG_LOSS_V1',
    epoch_selection_policy:'NESTED_PURGED_EPOCH_WINDOW_THEN_FIXED_EPOCH_REFIT_ON_FULL_OUTER_FOLD_TRAINING_ROWS',
    logistic_baseline_config:{
      schema:'RADARX_FOLD_LOCAL_RAW_TEMPORAL_LOGISTIC_RANKING_REFERENCE_V1',
      ranker_initialization_method:
        'FOLD_LOCAL_LOGISTIC_RAW_SCORE_PLUS_ZERO_INITIALIZED_TEMPORAL_RETURN_RESIDUAL_V1',
      anchor_score_semantics:
        'EXACT_FOLD_LOCAL_LOGISTIC_LOGIT_CLAMPED_BEFORE_ZERO_INITIALIZED_TEMPORAL_RESIDUAL',
      exact_feature_mapping_temporal_blocks:TCN_LSTM_STEPS,
      feature_schema_id:TCN_LSTM_ORDERED_RANKING_FEATURE_SCHEMA_ID,
      feature_count:TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT,
      l2:1,learning_rate:0.03,max_epochs:160,
      fit_partition:'EACH_COMPLETE_OUTER_FOLD_TUNING_WINDOW_ONLY',
      epoch_selection_partition:'EARLIER_NESTED_PURGED_SUBWINDOW_WITHIN_OUTER_FOLD_TRAINING_WINDOW',
      scoring_partition:'SAME_LATER_OUTER_FOLD_PURGED_VALIDATION_PAIRS',
      validation_labels_read:false,
      outer_validation_or_holdout_used:false
    },
    source_partition:'PRE_EXECUTION_MODEL_TRAINING_PARTITION_ONLY',
    pair_strategy:pairStrategy,
    fit_partition:'EXPANDING_EARLIER_SUBSETS_OF_PRE_EXECUTION_MODEL_TRAINING_PARTITION',
    validation_partition:'THREE_NON_OVERLAPPING_LATER_PURGED_WINDOWS_WITHIN_PRE_EXECUTION_MODEL_TRAINING_PARTITION',
    outer_validation_or_holdout_used:false,
    model_selection_partition_used:false,
    purge_horizon_ms:purgeHorizonMs,
    validation_fraction:Number(validationFraction),
    validation_group_count:validationGroupCount,
    fold_count:foldMetadata.length,
    folds:foldMetadata,
    tuning_max_resolved_at:Math.max(...foldMetadata.map(item=>item.tuning_max_resolved_at)),
    tuning_max_at:Math.max(...foldMetadata.map(item=>item.tuning_max_at)),
    validation_min_at:Math.min(...foldMetadata.map(item=>item.validation_min_at)),
    purge_gap_ms:internalPurgeGapMs,
    chronology_valid:true,
    tuning_rows:internalTuningRows,
    validation_rows:internalValidationRows,
    purged_rows:internalPurgedRows,
    tuning_pairs:internalTuningPairs,
    validation_pairs:internalValidationPairs,
    l2_grid:[...l2Grid],
    candidate_grid:tuningCandidates,
    selection_rule:'REQUIRE_STRICT_POSITIVE_LOGISTIC_MARGINS_FOR_PAIRWISE_ACCURACY_AND_LOG_LOSS_IN_EVERY_PURGED_TRAINING_FOLD',
    fold_stable_dual_metric_candidate_count:foldStableDualMetricCandidates.length,
    fold_stable_dual_metric_superiority: selectedCandidateQualified,
    robustness_status:selectedCandidateQualified?'FOLD_STABLE_DUAL_LOGISTIC_SUPERIORITY':'ABSTAIN_NO_FOLD_STABLE_DUAL_SUPERIORITY',
    selected_l2:selectedTuning.l2,
    selected_learning_rate:selectedTuning.learning_rate,
    selected_epochs:finalEpochs,
    selected_validation_pairwise_log_loss:selectedTuning.best_validation_pairwise_log_loss,
    selected_validation_pairwise_accuracy_pct:selectedTuning.best_validation_pairwise_accuracy_pct,
    selected_minimum_fold_pairwise_accuracy_pct:selectedTuning.minimum_fold_pairwise_accuracy_pct,
    selected_logistic_validation_pairwise_accuracy_pct:selectedTuning.logistic_validation_pairwise_accuracy_pct,
    selected_logistic_validation_pairwise_log_loss:selectedTuning.logistic_validation_pairwise_log_loss,
    selected_validation_pairwise_accuracy_improvement_pct:selectedTuning.best_validation_pairwise_accuracy_improvement_pct,
    selected_minimum_fold_pairwise_accuracy_improvement_pct:selectedTuning.minimum_fold_pairwise_accuracy_improvement_pct,
    selected_minimum_fold_pairwise_log_loss_improvement:selectedTuning.minimum_fold_pairwise_log_loss_improvement,
    selected_validation_pairwise_log_loss_improvement:selectedTuning.best_validation_pairwise_log_loss_improvement,
    selected_candidate_qualified:selectedCandidateQualified,
    selected_temporal_block_count:selectedTuning.temporal_block_count,
    selected_steps_per_block:selectedTuning.steps_per_block,
    selected_parameterization_id:selectedTuning.parameterization_id,
    selected_parameter_count:selectedTuning.parameter_count,
    final_refit_epoch_selection_mode:'FIXED_EPOCHS_FROM_NESTED_PURGED_FOLD_EARLY_STOPPING',
    final_refit_ranker_initialization:
      'FULL_TRAINING_PARTITION_LOGISTIC_RAW_SCORE_PLUS_ZERO_INITIALIZED_TEMPORAL_RESIDUAL',
    final_refit_rows:ordered.length,
    final_refit_pairs:pairSupport.comparison_pairs
  };
  training.internal_training_validation.temporal_block_count=selectedTuning.temporal_block_count;
  training.pair_strategy=pairStrategy;
  return {
    schema:'RADARX_TCN_LSTM_PRE_EXECUTION_ORDERED_RANKER_FIT_V1',
    fitted:true,
    source_partition:'PRE_EXECUTION_MODEL_TRAINING_PARTITION',
    feature_scoring_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK',
    training_rows:ordered.length,
    training_pairs:pairSupport.comparison_pairs,
    pair_support:{
      schema:pairSupport.schema,
      pair_strategy:pairSupport.pair_strategy,
      source_partition:pairSupport.source_partition,
      decision_group_count:pairSupport.decision_group_count,
      comparison_pairs:pairSupport.comparison_pairs,
      positive_vs_non_positive_pairs:pairSupport.positive_vs_non_positive_pairs,
      positive_vs_positive_pairs:pairSupport.positive_vs_positive_pairs??0,
      positive_opportunity_groups:pairSupport.positive_opportunity_groups,
      mixed_decision_groups:pairSupport.mixed_decision_groups,
      round_trip_cost_bps:pairSupport.round_trip_cost_bps,
      minimum_return_gap_pct:pairSupport.minimum_return_gap_pct,
      maximum_pairs_per_timestamp:pairSupport.maximum_pairs_per_timestamp
    },
    model_state:{
      rankingRepresentation:'RAW_ORDERED_696_V1',
      orderedRankingHeadWeights:[...rankerModel.orderedRankingHeadWeights],
      orderedRankingFeatureMean:[...rankerModel.orderedRankingFeatureMean],
      orderedRankingFeatureStd:[...rankerModel.orderedRankingFeatureStd],
      orderedRankingAnchorWeights:[...rankerModel.orderedRankingAnchorWeights],
      orderedRankingAnchorFeatureMean:[...rankerModel.orderedRankingAnchorFeatureMean],
      orderedRankingAnchorFeatureStd:[...rankerModel.orderedRankingAnchorFeatureStd],
      orderedRankingAnchorBias:Number(rankerModel.orderedRankingAnchorBias)
    },
    training:{
      ...training,
      source_partition:'PRE_EXECUTION_MODEL_TRAINING_PARTITION',
      feature_scoring_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK',
      training_rows:ordered.length,
      training_pairs:pairSupport.comparison_pairs,
      classifier_parameters_updated:false,
      validation_or_holdout_used:false
    }
  };
}
/**
 * Fit the raw ordered return ranker once on the complete pre-execution model
 * training partition. This sidecar is independent of the classifier's OOF
 * residual subset: it consumes no Logistic predictions or classifier logits.
 * The returned state is frozen and can be shared across classifier candidates.
 */

export function trainTcnLstmHybrid(trainingRows, {
  epochs = 8, learningRate = 0.0025, l2 = 0.0015, dropout = TCN_LSTM_DROPOUT,
  batchSize = 32, seed = 29, maxTrainingSamples = TCN_LSTM_MAX_TRAINING_SAMPLES,
  baselineFit = null, earlyStoppingPatience = 5,
  objective='BRIER',gammaPositive=1,gammaNegative=2,
  rankingRows=null,executionRows=null,rankingWeight=0,rankingRoundTripCostBps=30,
  rankingMinimumReturnGapPct=0.50,rankingPairsPerTimestamp=4,
  rankingPairStrategy='RETURN_EXTREMES_V1',
  rankingRepresentation='LATENT_MULTI_SCALE_V2',
  rankingHeadLearningRate=0.03,rankingHeadEpochs=40,rankingHeadL2=0.001,
  rankingValidationFraction=0.08,
  fitIndependentRankingHead=true,preFittedIndependentRankingHead=null,
  executionHeadRoundTripCostBps=30,executionHeadLearningRate=0.015,
  executionHeadEpochs=100,executionHeadL2=0.002
} = {}) {
  assertRows(trainingRows, 'TRAINING');
  if (!Number.isSafeInteger(batchSize) || batchSize < 4 || batchSize > 256 ||
      !Number.isSafeInteger(maxTrainingSamples) || maxTrainingSamples < 20 ||
      !Number.isSafeInteger(epochs) || epochs < 1 || epochs > 80 ||
      !Number.isSafeInteger(earlyStoppingPatience) || earlyStoppingPatience < 1)
    throw new TypeError('TCN_LSTM_TRAINING_CONFIGURATION_INVALID');
  const rate = clamp(Number(learningRate), 0.0001, 0.01);
  const regularization = clamp(Number(l2), 0, 0.2);
  if(!['BRIER','FOCAL_ASYMMETRIC_BRIER'].includes(objective)||
    !finite(gammaPositive)||gammaPositive<0||
    !finite(gammaNegative)||gammaNegative<0)
    throw new TypeError('TCN_LSTM_LOSS_OBJECTIVE_CONFIGURATION_INVALID');
  if(!finite(rankingWeight)||rankingWeight<0||rankingWeight>1)
    throw new TypeError('TCN_LSTM_RANKING_WEIGHT_INVALID');
  if(rankingWeight>0&&!Array.isArray(rankingRows))
    throw new TypeError('TCN_LSTM_SHARED_RANKING_REQUIRES_TRAINING_RETURN_ROWS');
  const dropoutRate = Number(dropout);
  if (!finite(rate) || !finite(regularization) ||
      !finite(dropoutRate) || dropoutRate < 0 || dropoutRate > 0.40)
    throw new TypeError('TCN_LSTM_HYPERPARAMETER_INVALID');
  const ordered = [...trainingRows].sort((a, b) =>
    (finite(a.at) ? a.at : 0) - (finite(b.at) ? b.at : 0));
  const rows = ordered.slice(-Math.min(maxTrainingSamples, ordered.length));
  const support = assertRows(rows, 'EFFECTIVE_TRAINING');
  if(executionRows!==null){
    if(!Array.isArray(executionRows))
      throw new TypeError('TCN_LSTM_EXECUTION_HEAD_ROWS_INVALID');
    assertRows(executionRows,'EXECUTION_HEAD_TRAINING');
    if(executionRows.some(row=>!finite(row.realized_return_pct)||
      !finite(row.max_adverse_excursion_pct)))
      throw new TypeError('TCN_LSTM_EXECUTION_HEAD_OUTCOMES_INCOMPLETE');
    const modelTrainingIds=new Set(rows.map(sampleIdentity));
    if(executionRows.some(row=>modelTrainingIds.has(sampleIdentity(row))))
      throw new TypeError('TCN_LSTM_EXECUTION_HEAD_TRAINING_IDENTITY_OVERLAP');
    const modelTrainingMaxResolvedAt=Math.max(...rows.map(row=>Number(row.resolved_at)));
    const executionHeadMinAt=Math.min(...executionRows.map(row=>Number(row.at)));
    if(!(modelTrainingMaxResolvedAt<executionHeadMinAt))
      throw new TypeError('TCN_LSTM_EXECUTION_HEAD_TRAINING_PURGE_VIOLATION');
  }
  const classWeights=objective==='FOCAL_ASYMMETRIC_BRIER'
    ?deriveTrainingClassWeights(rows.map(row=>row.target)):null;
  if(rankingRows!==null&&!Array.isArray(rankingRows))
    throw new TypeError('TCN_LSTM_RANKING_ROWS_INVALID');
  if(!finite(rankingHeadLearningRate)||rankingHeadLearningRate<=0||
    rankingHeadLearningRate>0.25||!Number.isInteger(rankingHeadEpochs)||
    rankingHeadEpochs<1||rankingHeadEpochs>200||
    !finite(rankingHeadL2)||rankingHeadL2<0||rankingHeadL2>1||
    !finite(rankingValidationFraction)||rankingValidationFraction<0.08||
      rankingValidationFraction>0.40||
    !['RETURN_EXTREMES_V1','PROFITABILITY_BOUNDARY_V1','PROFITABILITY_TOPK_V2'].includes(rankingPairStrategy)||
    !TCN_LSTM_RANKING_REPRESENTATIONS.includes(rankingRepresentation)||
    typeof fitIndependentRankingHead!=='boolean')
    throw new TypeError('TCN_LSTM_RANKING_HEAD_CONFIGURATION_INVALID');
  if(preFittedIndependentRankingHead!==null){
    const prefit=preFittedIndependentRankingHead;
    const state=prefit?.model_state;
    const metadata=prefit?.training;
    if(rankingRepresentation!=='RAW_ORDERED_696_V1'||
      prefit?.schema!=='RADARX_TCN_LSTM_PRE_EXECUTION_ORDERED_RANKER_FIT_V1'||
      prefit?.fitted!==true||
      prefit?.source_partition!=='PRE_EXECUTION_MODEL_TRAINING_PARTITION'||
      prefit?.feature_scoring_partition!=='PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK'||
      !Array.isArray(state?.orderedRankingHeadWeights)||
      state.orderedRankingHeadWeights.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      state.orderedRankingHeadWeights.some(value=>!finite(value))||
      !Array.isArray(state?.orderedRankingFeatureMean)||
      state.orderedRankingFeatureMean.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      state.orderedRankingFeatureMean.some(value=>!finite(value))||
      !Array.isArray(state?.orderedRankingFeatureStd)||
      state.orderedRankingFeatureStd.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      state.orderedRankingFeatureStd.some(value=>!finite(value)||value<=0)||
      !Array.isArray(state?.orderedRankingAnchorWeights)||
      state.orderedRankingAnchorWeights.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      state.orderedRankingAnchorWeights.some(value=>!finite(value))||
      !Array.isArray(state?.orderedRankingAnchorFeatureMean)||
      state.orderedRankingAnchorFeatureMean.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      state.orderedRankingAnchorFeatureMean.some(value=>!finite(value))||
      !Array.isArray(state?.orderedRankingAnchorFeatureStd)||
      state.orderedRankingAnchorFeatureStd.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      state.orderedRankingAnchorFeatureStd.some(value=>!finite(value)||value<=0)||
      !finite(state?.orderedRankingAnchorBias)||
      metadata?.schema!=='RADARX_TCN_LSTM_INDEPENDENT_ORDERED_696_RETURN_RANKER_V1'||
      metadata?.fitted!==true||
      metadata?.representation!=='RAW_ORDERED_696_V1'||
      metadata?.feature_count!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      ![1,2,3,4,6,8,12,24].includes(metadata?.temporal_block_count)||
      metadata?.steps_per_block!==TCN_LSTM_STEPS/metadata.temporal_block_count||
      metadata?.parameter_count!==metadata.temporal_block_count*TCN_LSTM_INPUT_CHANNELS||
      metadata?.parameterization_id!=='TEMPORAL_BLOCK_TIED_'+
        metadata.temporal_block_count+'X'+TCN_LSTM_INPUT_CHANNELS+'_V1'||
      metadata?.internal_training_validation?.selected_temporal_block_count!==
        metadata?.temporal_block_count||
      metadata?.internal_training_validation?.selected_parameter_count!==
        metadata?.parameter_count||
      metadata?.internal_training_validation?.validation_fraction!==rankingValidationFraction||
      metadata?.training_rows!==Number(prefit.training_rows)||
      metadata?.training_pairs!==Number(prefit.training_pairs)||
      metadata?.standardization?.fit_partition!=='TRAINING_PARTITION_ONLY'||
      metadata?.standardization?.fit_rows!==Number(prefit.training_rows)||
      metadata?.validation_or_holdout_used!==false||
      metadata?.classifier_parameters_updated!==false||
      metadata?.initialization_preserves_logistic_pair_scores!==true||
      prefit?.pair_support?.pair_strategy!==rankingPairStrategy||
      prefit?.pair_support?.round_trip_cost_bps!==rankingRoundTripCostBps||
      prefit?.pair_support?.minimum_return_gap_pct!==rankingMinimumReturnGapPct||
      prefit?.pair_support?.maximum_pairs_per_timestamp!==rankingPairsPerTimestamp)
      throw new TypeError('TCN_LSTM_PREFITTED_ORDERED_RANKER_CONTRACT_INVALID');
  }
  const ranking=preFittedIndependentRankingHead!==null
    ?{
      schema:preFittedIndependentRankingHead.pair_support.schema,
      pair_strategy:preFittedIndependentRankingHead.pair_support.pair_strategy,
      source_partition:'PRE_EXECUTION_MODEL_TRAINING_PARTITION',
      decision_group_count:preFittedIndependentRankingHead.pair_support.decision_group_count,
      comparison_pairs:preFittedIndependentRankingHead.pair_support.comparison_pairs,
      positive_opportunity_groups:preFittedIndependentRankingHead.pair_support.positive_opportunity_groups,
      mixed_decision_groups:preFittedIndependentRankingHead.pair_support.mixed_decision_groups,
      round_trip_cost_bps:preFittedIndependentRankingHead.pair_support.round_trip_cost_bps,
      minimum_return_gap_pct:preFittedIndependentRankingHead.pair_support.minimum_return_gap_pct,
      maximum_pairs_per_timestamp:preFittedIndependentRankingHead.pair_support.maximum_pairs_per_timestamp,
      // A shared classifier-ranking loss, when explicitly enabled, still uses
      // its own OOF-filtered fit subset. These pairs never refit the frozen
      // independent sidecar and remain a distinct objective.
      pairs:Array.isArray(rankingRows)
        ?buildTcnLstmReturnRankingPairs(rows,rankingRows,{
          roundTripCostBps:rankingRoundTripCostBps,
          minimumReturnGapPct:rankingMinimumReturnGapPct,
          maxPairsPerTimestamp:rankingPairsPerTimestamp,
          pairStrategy:rankingPairStrategy
        }).pairs
        :[]
    }
    :Array.isArray(rankingRows)
      ?buildTcnLstmReturnRankingPairs(rows,rankingRows,{
        roundTripCostBps:rankingRoundTripCostBps,
        minimumReturnGapPct:rankingMinimumReturnGapPct,
        maxPairsPerTimestamp:rankingPairsPerTimestamp,
        pairStrategy:rankingPairStrategy
      })
      :{schema:'RADARX_TCN_LSTM_TRAINING_RETURN_RANK_PAIRS_V1',
        pair_strategy:rankingPairStrategy,
        source_partition:'DISABLED',decision_group_count:0,comparison_pairs:0,pairs:[]};
  if(Array.isArray(rankingRows)&&ranking.comparison_pairs<10)
    throw new TypeError('TCN_LSTM_RETURN_RANKING_PAIR_SUPPORT_TOO_SMALL');
  const rankingPairs=ranking.pairs;
  const rankingPairsByTime=new Map();
  for(const pair of rankingPairs){
    const key=String(pair.decision_at);
    if(!rankingPairsByTime.has(key))rankingPairsByTime.set(key,[]);
    rankingPairsByTime.get(key).push(pair);
  }
  const anchor = baselineFit || fitTcnLstmLogisticAnchor(rows);
  if (!Array.isArray(anchor.weights) || anchor.weights.length !== BASELINE_FEATURES ||
      anchor.weights.some(value => !finite(value)) || !finite(anchor.bias) ||
      anchor.training_rows !== rows.length ||
      anchor.training_fingerprint !== trainingFingerprint(rows))
    throw new TypeError('TCN_LSTM_TRAINING_ANCHOR_INVALID_OR_TRAINING_ROWS_MISMATCH');
  const explicitClassifierBaselineRows=rows.filter(row=>
    Object.prototype.hasOwnProperty.call(row,'classifier_baseline_logit')
  ).length;
  if(explicitClassifierBaselineRows!==0&&explicitClassifierBaselineRows!==rows.length)
    throw new TypeError('TCN_LSTM_CLASSIFIER_BASELINE_PARTIAL_ROW_COVERAGE');
  const classifierBaselineSource=explicitClassifierBaselineRows===rows.length
    ?'TUNED_FULL_ORDERED_TEMPORAL_LOGISTIC_696_RAW_OOF'
    :'FROZEN_POOLED_LOGISTIC_ANCHOR_58_FALLBACK';

  const model = initializeModel(seed);
  let optimizer = {
    m: zerosLike(trainableParameters(model)),
    v: zerosLike(trainableParameters(model))
  };
  let updateStep = 0;
  const random = mulberry32(seed ^ 0xA5A5A5A5);
  const history = [];
  const initialBrier = evaluateBrier(rows, model, anchor);
  const initialClassificationObjective=evaluateClassifierTrainingObjective(rows,model,anchor,{
    objective,classWeights,gammaPositive,gammaNegative
  });
  const initialSharedRankingLoss=rankingWeight>0
    ?evaluateSharedClassifierRankingLoss(rows,rankingPairs,model,anchor):0;
  let bestBrier=initialBrier;
  let bestClassificationObjective=initialClassificationObjective;
  let bestSharedRankingLoss=initialSharedRankingLoss;
  let bestObjective=initialClassificationObjective+rankingWeight*initialSharedRankingLoss;
  let sharedRankingGradientBatches=0;
  let sharedRankingPairsApplied=0;
  let sharedRankingGradientConflictBatches=0;
  let sharedRankingGradientProjectionBatches=0;
  let sharedRankingGradientCosineSum=0;
  let sharedRankingGradientCosineCount=0;
  let bestEpoch = 0;
  let bestModel = cloneTree(trainableParameters(model));
  let wait = 0, stoppedEarly = false;
  const patience = Math.min(12, Math.max(2, earlyStoppingPatience));

  for (let epoch = 1; epoch <= epochs; epoch++) {
    let batches;
    if(rankingPairs.length){
      const groups=new Map();
      rows.forEach((row,index)=>{
        const decisionAt=Math.floor(Number(row.at)/TCN_LSTM_RANKING_BUCKET_MS)*
          TCN_LSTM_RANKING_BUCKET_MS;
        const key=String(decisionAt);
        if(!groups.has(key))groups.set(key,[]);
        groups.get(key).push(index);
      });
      const shuffledGroups=[...groups.values()];
      for(let index=shuffledGroups.length-1;index>0;index--){
        const swap=Math.floor(random()*(index+1));
        [shuffledGroups[index],shuffledGroups[swap]]=
          [shuffledGroups[swap],shuffledGroups[index]];
      }
      batches=shuffledGroups;
    }else{
      const order=Array.from({length:rows.length},(_,index)=>index);
      for(let index=order.length-1;index>0;index--){
        const swap=Math.floor(random()*(index+1));
        [order[index],order[swap]]=[order[swap],order[index]];
      }
      batches=[];
      for(let start=0;start<order.length;start+=batchSize)
        batches.push(order.slice(start,Math.min(order.length,start+batchSize)));
    }
    let epochLoss=0,seen=0,maxGradientNorm=0,clippedBatches=0;
    let epochSharedRankingLoss=0,epochSharedRankingPairs=0,epochSharedRankingGradientBatches=0;
    const schedule = 0.1 + 0.9 * 0.5 *
      (1 + Math.cos(Math.PI * (epoch - 1) / Math.max(1, epochs - 1)));
    const epochRate = rate * schedule;

    for (const indexes of batches) {
      let accumulated = zeroGradients(model);
      for (const rowIndex of indexes) {
        const row = rows[rowIndex];
        const baselineLogit = resolveTcnLstmRowClassifierBaselineLogit(row,anchor);
        // One Bernoulli mask per channel, locked for all 24 time steps.
        // This is variational input dropout, not per-step recurrent dropout.
        const dropoutScale = Array(TCN_LSTM_HIDDEN).fill(0).map(() =>
          dropoutRate > 0 && random() < dropoutRate ? 0 : 1 / (1 - dropoutRate));
        const item = lossAndGradientsTcnLstmHybrid(
          row.sequence, row.target, model, baselineLogit,
          {dropoutScale,objective,classWeights,gammaPositive,gammaNegative}
        );
        epochLoss += item.loss;
        seen++;
        accumulated = accumulateTree(accumulated, item.gradients);
      }
      let averaged=scaleTree(accumulated,1/indexes.length);
      if(rankingWeight>0&&indexes.length){
        const inBatch=new Set(indexes);
        const decisionAt=String(Math.floor(Number(rows[indexes[0]].at)/
          TCN_LSTM_RANKING_BUCKET_MS)*TCN_LSTM_RANKING_BUCKET_MS);
        const batchPairs=(rankingPairsByTime.get(decisionAt)||[]).filter(pair=>
          inBatch.has(pair.high_index)&&inBatch.has(pair.low_index));
        if(batchPairs.length){
          let rankGradient=zeroGradients(model);
          for(const pair of batchPairs){
            const high=rows[pair.high_index],low=rows[pair.low_index];
            const highBase=resolveTcnLstmRowClassifierBaselineLogit(high,anchor);
            const lowBase=resolveTcnLstmRowClassifierBaselineLogit(low,anchor);
            const highLogit=inspectTcnLstmForward(high.sequence,model,highBase).logit;
            const lowLogit=inspectTcnLstmForward(low.sequence,model,lowBase).logit;
            const pairLoss=tcnLstmPairwiseLogitRankingLoss(highLogit,lowLogit);
            const highGrad=lossAndGradientsTcnLstmHybrid(high.sequence,high.target,model,highBase,{
              objective:'EXTERNAL_LOGIT',
              externalLogitGradient:pairLoss.high_logit_gradient
            });
            const lowGrad=lossAndGradientsTcnLstmHybrid(low.sequence,low.target,model,lowBase,{
              objective:'EXTERNAL_LOGIT',
              externalLogitGradient:pairLoss.low_logit_gradient
            });
            rankGradient=accumulateTree(rankGradient,highGrad.gradients);
            rankGradient=accumulateTree(rankGradient,lowGrad.gradients);
            epochSharedRankingLoss+=pairLoss.loss;
            epochSharedRankingPairs++;
          }
          const projectedRanking=projectTcnLstmAuxiliaryGradient(averaged,rankGradient);
          if(projectedRanking.conflict)sharedRankingGradientConflictBatches++;
          if(projectedRanking.projection_applied)sharedRankingGradientProjectionBatches++;
          sharedRankingGradientCosineSum+=projectedRanking.cosine_before;
          sharedRankingGradientCosineCount++;
          averaged=accumulateTree(averaged,scaleTree(
            projectedRanking.gradient,rankingWeight/batchPairs.length
          ));
          epochSharedRankingGradientBatches++;
          sharedRankingGradientBatches++;
          sharedRankingPairsApplied+=batchPairs.length;
        }
      }
      if (!treeFinite(averaged)) throw new TypeError('TCN_LSTM_BATCH_GRADIENT_NON_FINITE');
      const norm = parameterNorm(averaged);
      if (!finite(norm)) throw new TypeError('TCN_LSTM_BATCH_GRADIENT_NORM_NON_FINITE');
      maxGradientNorm = Math.max(maxGradientNorm, norm);
      if (norm > 1) {
        averaged = scaleTree(averaged, 1 / norm);
        clippedBatches++;
      }
      updateStep++;
      updateParameters(model, averaged, optimizer, updateStep, epochRate, regularization);
    }

    const trainingBrier=evaluateBrier(rows,model,anchor);
    const trainingClassificationObjective=evaluateClassifierTrainingObjective(rows,model,anchor,{
      objective,classWeights,gammaPositive,gammaNegative
    });
    const trainingSharedRankingLoss=rankingWeight>0
      ?evaluateSharedClassifierRankingLoss(rows,rankingPairs,model,anchor):0;
    const trainingObjective=trainingClassificationObjective+
      rankingWeight*trainingSharedRankingLoss;
    if(!finite(trainingBrier)||!finite(trainingClassificationObjective)||
      !finite(trainingSharedRankingLoss)||!finite(trainingObjective))
      throw new TypeError('TCN_LSTM_TRAINING_OBJECTIVE_NON_FINITE');
    if(trainingObjective<bestObjective-1e-8){
      bestObjective=trainingObjective;
      bestBrier=trainingBrier;
      bestClassificationObjective=trainingClassificationObjective;
      bestSharedRankingLoss=trainingSharedRankingLoss;
      bestEpoch=epoch;
      bestModel = cloneTree(trainableParameters(model));
      wait = 0;
    } else wait++;
    history.push({
      epoch,
      pre_update_mean_batch_objective_loss:Number((
        epochLoss/Math.max(1,seen)+
        rankingWeight*epochSharedRankingLoss/Math.max(1,epochSharedRankingPairs)
      ).toFixed(8)),
      post_update_training_brier:Number(trainingBrier.toFixed(8)),
      post_update_training_classification_objective:Number(trainingClassificationObjective.toFixed(8)),
      post_update_shared_classifier_pairwise_rank_loss:Number(trainingSharedRankingLoss.toFixed(8)),
      post_update_training_composite_objective:Number(trainingObjective.toFixed(8)),
      shared_ranking_pairs_used:epochSharedRankingPairs,
      shared_ranking_gradient_batches:epochSharedRankingGradientBatches,
      shared_ranking_gradient_conflict_batches:sharedRankingGradientConflictBatches,
      shared_ranking_gradient_projection_batches:sharedRankingGradientProjectionBatches,
      learning_rate: Number(epochRate.toFixed(8)),
      maximum_batch_gradient_l2_norm: Number(maxGradientNorm.toFixed(8)),
      clipped_batches: clippedBatches,
      dropout: dropoutRate,
      dropout_mode:'LOCKED_PER_SEQUENCE_TCN_TO_LSTM_INPUT_V1',
      loss_objective:objective
    });
    if (epoch >= Math.min(5, epochs) && wait >= patience) {
      stoppedEarly = true;
      break;
    }
  }

  Object.assign(model, cloneTree(bestModel));
  let rankingHeadFit;
  if(preFittedIndependentRankingHead!==null){
    Object.assign(model,cloneTree(preFittedIndependentRankingHead.model_state));
    rankingHeadFit={
      ...cloneTree(preFittedIndependentRankingHead.training),
      fitted:true,
      representation:'RAW_ORDERED_696_V1',
      // The exported inference vector stays 696-wide, but parameter_count
      // records the tied free parameters actually optimized (blocks x 29).
      // Do not overwrite it with the expanded feature count.
      feature_count:TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT,
      source_partition:'PRE_EXECUTION_MODEL_TRAINING_PARTITION',
      feature_scoring_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK',
      classifier_parameters_updated:false,
      validation_or_holdout_used:false
    };
  }else{
    rankingHeadFit=fitIndependentRankingHead&&rankingPairs.length
      ?rankingRepresentation==='RAW_ORDERED_696_V1'
        ?fitTcnLstmOrderedPairwiseRankingHead(rows,rankingPairs,model,{
          learningRate:rankingHeadLearningRate,epochs:rankingHeadEpochs,
          l2:rankingHeadL2,patience:Math.min(20,Math.max(5,earlyStoppingPatience*2))
        })
        :fitTcnLstmPairwiseRankingHead(rows,rankingPairs,model,anchor,{
          learningRate:rankingHeadLearningRate,epochs:rankingHeadEpochs,
          l2:rankingHeadL2,patience:Math.min(20,Math.max(5,earlyStoppingPatience*2))
        })
      :{
      schema:rankingRepresentation==='RAW_ORDERED_696_V1'
        ?'RADARX_TCN_LSTM_INDEPENDENT_ORDERED_696_RETURN_RANKER_V1'
        :'RADARX_TCN_LSTM_INDEPENDENT_MULTISCALE_RETURN_RANKER_V2',
      fitted:false,representation:rankingRepresentation,
      reason:fitIndependentRankingHead
        ?'NO_TRAINING_PARTITION_RETURN_PAIRS'
        :'INDEPENDENT_RANKER_FITTING_DISABLED',
      fit_boundary:'TRAINING_PARTITION_ONLY',
      training_rows:rows.length,training_pairs:rankingPairs.length,
      parameter_count:rankingRepresentation==='RAW_ORDERED_696_V1'
        ?TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT:TCN_LSTM_RANKING_HEAD_PARAMETER_COUNT,
      validation_or_holdout_used:false};
  }
  const executionHeadFit=Array.isArray(executionRows)
    ?{
      ...fitTcnLstmExecutionRegressionHeads(executionRows,executionRows,model,anchor,{
        roundTripCostBps:executionHeadRoundTripCostBps,
        learningRate:executionHeadLearningRate,epochs:executionHeadEpochs,l2:executionHeadL2
      }),
      model_training_rows:rows.length,
      model_training_max_resolved_at:Math.max(...rows.map(row=>Number(row.resolved_at))),
      execution_head_min_at:Math.min(...executionRows.map(row=>Number(row.at))),
      source_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK',
      execution_head_split_source_partition:null,
      execution_head_split_status:'UNVERIFIED_DIRECT_ROWS',
      execution_head_split_method:null,
      purged_rows:null,
      purge_gap_ms:Math.min(...executionRows.map(row=>Number(row.at)))-
        Math.max(...rows.map(row=>Number(row.resolved_at))),
      chronology_valid:Math.max(...rows.map(row=>Number(row.resolved_at)))<
        Math.min(...executionRows.map(row=>Number(row.at))),
      representation_out_of_sample:true,
      training_and_execution_head_identities_disjoint:true
    }
    :{schema:'RADARX_TCN_LSTM_SCORE_GATED_RETURN_DOWNSIDE_HEADS_V5',
      fitted:false,reason:'PURGED_EXECUTION_HEAD_TRAINING_BLOCK_NOT_AVAILABLE',
      input_feature_schema:TCN_LSTM_EXECUTION_HEAD_INPUT_FEATURE_SCHEMA,
      fit_boundary:'TRAINING_PARTITION_ONLY',validation_or_holdout_used:false,
      representation_out_of_sample:false};
  const rankingHeadParameterCount=rankingHeadFit.fitted===true
    ?Number(rankingHeadFit.parameter_count??TCN_LSTM_RANKING_HEAD_PARAMETER_COUNT):0;
  const finalBrier=evaluateBrier(rows,model,anchor);
  const finalRankingLoss=evaluatePairwiseReturnRankingLoss(rows,rankingPairs,model,anchor);
  const finalSharedRankingLoss=rankingWeight>0
    ?evaluateSharedClassifierRankingLoss(rows,rankingPairs,model,anchor):0;
  if(!finite(finalBrier)||!finite(finalRankingLoss)||!finite(finalSharedRankingLoss)||
    !treeFinite(trainableParameters(model))||
    !Array.isArray(model.rankingHeadWeights)||model.rankingHeadWeights.length!==TCN_LSTM_RANKING_FEATURE_COUNT||
    model.rankingHeadWeights.some(value=>!finite(value))||
    !Array.isArray(model.rankingFeatureMean)||model.rankingFeatureMean.length!==TCN_LSTM_RANKING_FEATURE_COUNT||
    model.rankingFeatureMean.some(value=>!finite(value))||
    !Array.isArray(model.rankingFeatureStd)||model.rankingFeatureStd.length!==TCN_LSTM_RANKING_FEATURE_COUNT||
    model.rankingFeatureStd.some(value=>!finite(value)||value<=0)||
    !Array.isArray(model.orderedRankingHeadWeights)||
    model.orderedRankingHeadWeights.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
    model.orderedRankingHeadWeights.some(value=>!finite(value))||
    !Array.isArray(model.orderedRankingFeatureMean)||
    model.orderedRankingFeatureMean.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
    model.orderedRankingFeatureMean.some(value=>!finite(value))||
    !Array.isArray(model.orderedRankingFeatureStd)||
    model.orderedRankingFeatureStd.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
    model.orderedRankingFeatureStd.some(value=>!finite(value)||value<=0)||
    !TCN_LSTM_RANKING_REPRESENTATIONS.includes(model.rankingRepresentation)||
    (executionHeadFit.fitted===true&&[
      ...model.executionReturnHeadWeights,...model.executionRiskHeadWeights,
      ...model.executionReturnHeadPooledOnlyWeights,...model.executionRiskHeadPooledOnlyWeights,
      model.executionReturnHeadBias,model.executionRiskHeadBias,
      model.executionReturnHeadPooledOnlyBias,model.executionRiskHeadPooledOnlyBias
    ].some(value=>!finite(value))))
    throw new TypeError('TCN_LSTM_FINAL_MODEL_NON_FINITE');
  return {
    schema: TCN_LSTM_HYBRID_SCHEMA,
    status: 'TRAINED_RESEARCH_CHALLENGER_NOT_VALIDATED',
    architecture: 'CAUSAL_DILATED_TCN_UNIDIRECTIONAL_LSTM_SINGLE_HEAD_TEMPORAL_ATTENTION_V1',
    input_steps: TCN_LSTM_STEPS,
    input_channels: TCN_LSTM_INPUT_CHANNELS,
    tcn_hidden_channels: TCN_LSTM_HIDDEN,
    lstm_hidden_units: TCN_LSTM_HIDDEN,
    lstm_gate_order: TCN_LSTM_GATE_ORDER,
    dilations: [...TCN_LSTM_DILATIONS],
    receptive_field: TCN_LSTM_RECEPTIVE_FIELD,
    attention: 'SINGLE_HEAD_QUERY_SOFTMAX_OVER_LSTM_HIDDEN_STATES',
    trainable_parameter_count: TCN_LSTM_CLASSIFIER_PARAMETER_COUNT,
    ranking_representation:rankingRepresentation,
    ranking_head_parameter_count:rankingHeadParameterCount,
    execution_regression_head_parameter_count:executionHeadFit.fitted
      ?2*(TCN_LSTM_HIDDEN+1)+2*(5*TCN_LSTM_HIDDEN+5):0,
    total_parameter_count:TCN_LSTM_CLASSIFIER_PARAMETER_COUNT+
      rankingHeadParameterCount+
      (executionHeadFit.fitted?2*(TCN_LSTM_HIDDEN+1)+2*(5*TCN_LSTM_HIDDEN+5):0),
    parameter_count_contract:{
      classifier_bptt_parameters:TCN_LSTM_CLASSIFIER_PARAMETER_COUNT,
      auxiliary_ranking_head_parameters:rankingHeadParameterCount,
      execution_regression_head_parameters:executionHeadFit.fitted
        ?2*(TCN_LSTM_HIDDEN+1)+2*(5*TCN_LSTM_HIDDEN+5):0,
      total:TCN_LSTM_CLASSIFIER_PARAMETER_COUNT+
        rankingHeadParameterCount+
        (executionHeadFit.fitted?2*(TCN_LSTM_HIDDEN+1)+2*(5*TCN_LSTM_HIDDEN+5):0)
    },
    dropout: dropoutRate,
    dropout_policy: 'LOCKED_PER_SEQUENCE_TCN_TO_LSTM_INPUT_DROPOUT_V1',
    loss_objective:objective,
    loss_class_weights:classWeights,
    loss_focal_gamma:{positive:gammaPositive,negative:gammaNegative},
    model, baseline_fit: anchor,
    training: {
      rows: rows.length,
      positives: support.positive,
      negatives: support.negative,
      training_fingerprint: trainingFingerprint(rows),
      anchor_training_fingerprint: anchor.training_fingerprint,
      classifier_baseline:{
        source:classifierBaselineSource,
        feature_count:explicitClassifierBaselineRows===rows.length
          ?TCN_LSTM_FULL_SEQUENCE_LOGISTIC_FEATURE_COUNT:BASELINE_FEATURES,
        training_logits_available_rows:explicitClassifierBaselineRows,
        source_partition:explicitClassifierBaselineRows===rows.length
          ?'PURGED_EXPANDING_TRAIN_ONLY_OOF_FOLDS':'TRAINING_PARTITION_ONLY',
        predictions_are_purged_out_of_fold:explicitClassifierBaselineRows===rows.length,
        validation_or_holdout_used:false
      },
      initial_training_brier:Number(initialBrier.toFixed(8)),
      fit_boundary: 'TRAINING_PARTITION_ONLY',
      optimizer: 'ADAMW_DECOUPLED_WEIGHT_DECAY',
      scheduler: 'COSINE_DECAY_10_PERCENT_FLOOR',
      gradient_clip_norm: 1,
      learning_rate_start: rate,
      learning_rate_end: rate * 0.1,
      l2: regularization,
      epochs_requested: epochs,
      epochs_completed: history.length,
      best_epoch: bestEpoch,
      best_training_brier:Number(bestBrier.toFixed(8)),
      best_training_pairwise_rank_loss:Number(
        (preFittedIndependentRankingHead!==null
          ?rankingHeadFit.final_pairwise_log_loss:finalRankingLoss).toFixed(8)
      ),
      best_training_shared_classifier_pairwise_rank_loss:Number(bestSharedRankingLoss.toFixed(8)),
      best_training_classification_objective:Number(bestClassificationObjective.toFixed(8)),
      best_training_composite_objective:Number(bestObjective.toFixed(8)),
      shared_classifier_loss:{
        enabled:rankingWeight>0,
        method:'SHARED_TCN_LSTM_CLASSIFIER_PAIRWISE_LOGIT_BACKPROP_PCGRAD_V2',
        conflict_resolution:'PCGRAD_PROJECT_AUXILIARY_RANKING_GRADIENT',
        gradient_conflict_batches:sharedRankingGradientConflictBatches,
        gradient_projection_batches:sharedRankingGradientProjectionBatches,
        mean_gradient_cosine_before_projection:sharedRankingGradientCosineCount
          ?Number((sharedRankingGradientCosineSum/sharedRankingGradientCosineCount).toFixed(8)):null,
        weight:Number(rankingWeight),
        source_partition:'TRAINING_PARTITION_ONLY',
        pair_schema:ranking.schema,
        comparison_pairs:rankingPairs.length,
        decision_group_count:rankingPairsByTime.size,
        pair_source_partition:preFittedIndependentRankingHead!==null
          ?'OOF_FILTERED_CLASSIFIER_RESIDUAL_TRAINING_SUBSET'
          :'TRAINING_PARTITION_ONLY',
        round_trip_cost_bps:Number(rankingRoundTripCostBps),
        minimum_return_gap_pct:Number(rankingMinimumReturnGapPct),
        maximum_pairs_per_timestamp:rankingPairsPerTimestamp,
        gradient_batches_applied:sharedRankingGradientBatches,
        pair_updates_applied:sharedRankingPairsApplied,
        classifier_parameters_updated:sharedRankingGradientBatches>0,
        initial_pairwise_log_loss:Number(initialSharedRankingLoss.toFixed(8)),
        restored_checkpoint_pairwise_log_loss:Number(bestSharedRankingLoss.toFixed(8)),
        final_restored_pairwise_log_loss:Number(finalSharedRankingLoss.toFixed(8)),
        validation_or_holdout_used:false
      },
      execution_regression_heads:executionHeadFit,
      return_ranking:{
        enabled:rankingHeadFit.fitted===true,
        method:rankingRepresentation==='RAW_ORDERED_696_V1'
          ?'INDEPENDENT_RAW_ORDERED_696_NET_PROFITABILITY_RANKER_V1'
          :'CLASSIFICATION_PROBABILITY_PLUS_INDEPENDENT_MULTISCALE_RETURN_RANKER_V2',
        representation:rankingRepresentation,
        shared_classifier_loss_weight:Number(rankingWeight),
        pair_strategy:rankingPairStrategy,
        pair_schema:ranking.schema,source_partition:ranking.source_partition,
        decision_group_count:ranking.decision_group_count,
        comparison_pairs:ranking.comparison_pairs,
        round_trip_cost_bps:Number(rankingRoundTripCostBps),
        minimum_return_gap_pct:Number(rankingMinimumReturnGapPct),
        maximum_pairs_per_timestamp:rankingPairsPerTimestamp,
        ranking_head:rankingHeadFit,
        training_pairwise_log_loss:Number(
          (preFittedIndependentRankingHead!==null
            ?rankingHeadFit.final_pairwise_log_loss:finalRankingLoss).toFixed(8)
        ),
        independent_ranker_fit_mode:preFittedIndependentRankingHead!==null
          ?'FITTED_ONCE_ON_COMPLETE_PRE_EXECUTION_MODEL_TRAINING_PARTITION'
          :'CANDIDATE_LOCAL_TRAINING_PARTITION',
        ordered_feature_count:rankingRepresentation==='RAW_ORDERED_696_V1'
          ?TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT:null,
        ranking_labels_seen_outside_training_partition:false,
        classifier_parameters_updated_by_ranking_head:false,
        classifier_parameters_updated_by_shared_ranking_loss:sharedRankingGradientBatches>0
      },
      restored_best_training_checkpoint: true,
      validation_or_selection_or_holdout_used_for_fit: false,
      early_stopping: {
        monitor:rankingWeight>0
          ?'TRAINING_CLASSIFICATION_OBJECTIVE_PLUS_WEIGHTED_SHARED_PAIRWISE_LOGIT_RANK_LOSS'
          :'TRAINING_CLASSIFICATION_OBJECTIVE_ONLY',
        patience,
        stopped_early: stoppedEarly
      },
      history
    },
    final_training_brier:Number(finalBrier.toFixed(8)),
    final_training_pairwise_rank_loss:Number(
      (preFittedIndependentRankingHead!==null
        ?rankingHeadFit.final_pairwise_log_loss:finalRankingLoss).toFixed(8)
    ),
    probability_ready: false,
    live_eligibility_ready: false,
    real_order_execution: false
  };
}

export function predictTcnLstmHybridProbability(sequence, profile, {
  externalLogisticLogit=null
}={}) {
  if (!profile?.model || !profile?.baseline_fit)
    throw new TypeError('TCN_LSTM_PROFILE_NOT_TRAINED');
  const baselineLogit = resolveTcnLstmProfileClassifierBaselineLogit(
    sequence,profile,externalLogisticLogit
  );
  const forward=inspectTcnLstmForward(sequence,profile.model,baselineLogit);
  // Primary classifier probability only. Ranking residuals stay independent
  // and cannot change Brier, calibration, or the Logistic entry-threshold gate.
  return sigmoid(forward.logit);
}

/** Separate ranking-sidecar probability, never used as classifier output. */
export function predictTcnLstmHybridRankingScore(sequence,profile){
  if(!profile?.model||!profile?.baseline_fit)
    throw new TypeError('TCN_LSTM_PROFILE_NOT_TRAINED');
  const forward=inspectTcnLstmForward(sequence,profile.model,0);
  return Number(forward.ranking_score);
}
// Legacy name retained as an alias for the raw independent rank score.
export function predictTcnLstmHybridRankingLogit(sequence,profile){
  return predictTcnLstmHybridRankingScore(sequence,profile);
}

/** Exact frozen Logistic anchor score underlying the separate ranking head. */
export function predictTcnLstmHybridRankingAnchorLogit(sequence, profile) {
  if (!profile?.model || !profile?.baseline_fit)
    throw new TypeError('TCN_LSTM_PROFILE_NOT_TRAINED');
  const model=profile.model;
  if(Array.isArray(model.orderedRankingAnchorWeights)){
    const features=buildTcnLstmFlattenedFeatures(sequence);
    const weights=model.orderedRankingAnchorWeights;
    const means=model.orderedRankingAnchorFeatureMean;
    const scales=model.orderedRankingAnchorFeatureStd;
    if(weights.length!==TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT||
      !Array.isArray(means)||means.length!==weights.length||
      !Array.isArray(scales)||scales.length!==weights.length||
      weights.some(value=>!finite(value))||means.some(value=>!finite(value))||
      scales.some(value=>!finite(value)||value<=0)||
      !finite(model.orderedRankingAnchorBias))
      throw new TypeError('TCN_LSTM_ORDERED_RANKING_LOGISTIC_ANCHOR_STATE_INVALID');
    let score=Number(model.orderedRankingAnchorBias);
    for(let index=0;index<features.length;index++)
      score+=weights[index]*((features[index]-means[index])/scales[index]);
    return clamp(score,-LOGIT_LIMIT,LOGIT_LIMIT);
  }
  return predictTcnLstmLogisticLogit(sequence, profile.baseline_fit);
}

function splitPredictions(rows, profile) {
  const modelPredictions = rows.map(row => predictTcnLstmHybridProbability(row.sequence, profile));
  const baselinePredictions = rows.map(row =>
    sigmoid(resolveTcnLstmProfileClassifierBaselineLogit(row.sequence,profile)));
  return { modelPredictions, baselinePredictions };
}

function brierFrom(rows, probabilities) {
  return rows.reduce((sum, row, index) =>
    sum + (probabilities[index] - row.target) ** 2, 0) / rows.length;
}

/**
 * Research-only realized-return diagnostics on the inner-selection block.
 * The binary model objective and candidate ranking remain Brier-based; this
 * sidecar answers whether a model's scores also concentrate positive net
 * first-touch returns after the declared round-trip cost. It is not a
 * portfolio simulator and cannot qualify a model for validation or live use.
 */
export function summarizeTcnLstmSelectionReturns(rows, probabilities, {
  roundTripCostBps = 30,
  minimumTrades = 20,
  minimumWinRatePct = 55,
  baselineProbabilities = null,
  thresholds = [
    0.10,0.15,0.20,0.25,0.30,0.325,0.35,0.355,0.36,0.365,
    0.37,0.375,0.38,0.39,0.40,0.425,0.45,0.475,0.50,0.55,0.60
  ]
} = {}) {
  const unavailable = reason => ({
    schema:'RADARX_TCN_LSTM_INNER_SELECTION_RETURN_DIAGNOSTICS_V1',
    status:'UNAVAILABLE',
    reason,
    diagnostic_only:false,
    selection_partition_only:true,
    holdout_values_used:false,
    affects_candidate_ranking:true,
    affects_acceptance_gates:true
  });
  if(!Array.isArray(rows)||!Array.isArray(probabilities)||!rows.length||
    rows.length!==probabilities.length)
    return unavailable('SELECTION_ROWS_OR_PROBABILITY_LENGTH_INVALID');
  if(!finite(roundTripCostBps)||roundTripCostBps<0||
    !Number.isInteger(minimumTrades)||minimumTrades<1||
    !finite(minimumWinRatePct)||minimumWinRatePct<0||minimumWinRatePct>100||
    !Array.isArray(thresholds)||!thresholds.length||
    thresholds.some(value=>!finite(value)||value<0||value>1)||
    new Set(thresholds).size!==thresholds.length)
    return unavailable('RETURN_DIAGNOSTIC_CONFIGURATION_INVALID');
  if(rows.some(row=>!finite(row?.realized_return_pct))||
    probabilities.some(value=>!finite(value)||value<0||value>1))
    return unavailable('SELECTION_REALIZED_RETURN_OR_PROBABILITY_INCOMPLETE');
  if(baselineProbabilities!==null&&
    (!Array.isArray(baselineProbabilities)||baselineProbabilities.length!==rows.length||
      baselineProbabilities.some(value=>!finite(value)||value<0||value>1)))
    return unavailable('LOGISTIC_BASELINE_PROBABILITY_VECTOR_INVALID');

  const roundTripCostPct=Number(roundTripCostBps)/100;
  const trials=thresholds.map(threshold=>{
    const selected=[];
    for(let index=0;index<rows.length;index++){
      if(probabilities[index]>=threshold){
        selected.push(Number(rows[index].realized_return_pct)-roundTripCostPct);
      }
    }
    const wins=selected.filter(value=>value>0);
    const losses=selected.filter(value=>value<0);
    const sum=values=>values.reduce((total,value)=>total+value,0);
    const sorted=[...selected].sort((a,b)=>a-b);
    const median=sorted.length
      ?(sorted.length%2
        ?sorted[(sorted.length-1)/2]
        :(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2)
      :null;
    const meanNet=selected.length?sum(selected)/selected.length:null;
    const winRate=selected.length?100*wins.length/selected.length:null;
    return {
      threshold,
      trade_count:selected.length,
      net_wins:wins.length,
      net_losses:losses.length,
      win_rate_pct:winRate===null?null:Number(winRate.toFixed(4)),
      mean_net_trade_return_pct:meanNet===null?null:Number(meanNet.toFixed(6)),
      median_net_trade_return_pct:median===null?null:Number(median.toFixed(6)),
      profit_factor:losses.length
        ?Number((sum(wins)/Math.abs(sum(losses))).toFixed(6))
        :wins.length?null:0,
      minimum_trade_and_win_rate_screen_passed:
        selected.length>=minimumTrades&&winRate!==null&&winRate>=minimumWinRatePct,
      positive_mean_net_return:
        meanNet!==null&&meanNet>0,
      preliminary_return_screen_passed:
        selected.length>=minimumTrades&&winRate!==null&&
        winRate>=minimumWinRatePct&&meanNet!==null&&meanNet>0
    };
  });
  const preliminary=trials.filter(item=>item.preliminary_return_screen_passed)
    .sort((a,b)=>b.mean_net_trade_return_pct-a.mean_net_trade_return_pct||
      b.trade_count-a.trade_count||a.threshold-b.threshold);
  // Diagnose cross-sectional ordering against the frozen Logistic anchor
  // using the exact first-touch execution simulator. This is selection-only:
  // the comparison is reported but never chooses the model, its threshold,
  // or any outer-validation/holdout acceptance gate.
  let crossSectionalRankDiagnostics={
    schema:'RADARX_TCN_LSTM_INNER_SELECTION_RANK_DIAGNOSTICS_V1',
    status:'UNAVAILABLE',
    reason:'LOGISTIC_BASELINE_OR_DECISION_TIMESTAMP_SUPPORT_UNAVAILABLE',
    diagnostic_only:true,
    selection_partition_only:true,
    holdout_values_used:false,
    affects_candidate_ranking:false,
    affects_acceptance_gates:false
  };
  const rankRowsValid=rows.every(row=>finite(row?.at)&&
    typeof row?.symbol==='string'&&row.symbol.length>0);
  if(baselineProbabilities!==null&&rankRowsValid){
    const trials=[1,2,3].map(topK=>{
      const modelMask=topKProbabilitySignals(rows,probabilities,topK);
      const logisticMask=topKProbabilitySignals(rows,baselineProbabilities,topK);
      const portfolioOptions={
        threshold:0.5,
        roundTripCostBps:Number(roundTripCostBps),
        maxConcurrentPositions:NEURAL_CLOSURE_PORTFOLIO_POLICY.max_concurrent_positions,
        initialEquity:100
      };
      const modelMetrics=simulateFirstTouchPaperPortfolio(
        rows,modelMask.probabilities,portfolioOptions
      );
      const logisticMetrics=simulateFirstTouchPaperPortfolio(
        rows,logisticMask.probabilities,portfolioOptions
      );
      const delta=(left,right,key)=>finite(left?.[key])&&finite(right?.[key])
        ?Number((Number(left[key])-Number(right[key])).toFixed(6)):null;
      return {
        top_k_per_timestamp:topK,
        decision_group_count:modelMask.decision_group_count,
        logistic_decision_group_count:logisticMask.decision_group_count,
        model_signal_count:modelMask.signal_count,
        logistic_signal_count:logisticMask.signal_count,
        model_metrics:modelMetrics,
        logistic_metrics:logisticMetrics,
        model_minus_logistic:{
          net_pnl_pct:delta(modelMetrics,logisticMetrics,'net_pnl_pct'),
          win_rate_percentage_points:delta(modelMetrics,logisticMetrics,'win_rate_pct'),
          max_drawdown_percentage_points:delta(modelMetrics,logisticMetrics,'max_drawdown_pct'),
          trade_count:delta(modelMetrics,logisticMetrics,'trade_count')
        }
      };
    });
    crossSectionalRankDiagnostics={
      schema:'RADARX_TCN_LSTM_INNER_SELECTION_RANK_DIAGNOSTICS_V1',
      status:'AVAILABLE',
      diagnostic_only:true,
      selection_partition_only:true,
      policy:'TOP_K_PER_DECISION_TIMESTAMP',
      decision_bucket_ms:15*60*1000,
      decision_grouping:'FLOOR_UNIX_EPOCH_15M_BUCKET',
      baseline:'FROZEN_LOGISTIC_ANCHOR_FIT_ON_IDENTICAL_TRAINING_ROWS',
      top_k_grid:[1,2,3],
      score_source:'RAW_FROZEN_CANDIDATE_AND_LOGISTIC_PROBABILITIES',
      round_trip_cost_bps:Number(roundTripCostBps),
      portfolio_simulation:NEURAL_CLOSURE_PORTFOLIO_POLICY,
      holdout_values_used:false,
      affects_candidate_ranking:false,
      affects_acceptance_gates:false,
      trials
    };
  }

  return {
    schema:'RADARX_TCN_LSTM_INNER_SELECTION_RETURN_DIAGNOSTICS_V1',
    status:'AVAILABLE',
    diagnostic_only:false,
    selection_partition_only:true,
    selection_sample_count:rows.length,
    round_trip_cost_bps:Number(roundTripCostBps),
    round_trip_cost_pct:roundTripCostPct,
    thresholds_tested:thresholds.length,
    minimum_trades:minimumTrades,
    minimum_win_rate_pct:minimumWinRatePct,
    holdout_values_used:false,
    affects_candidate_ranking:true,
    affects_acceptance_gates:true,
    portfolio_drawdown_evaluated:false,
    trials,
    preliminary_return_screen_candidates:preliminary.length,
    best_preliminary_threshold:preliminary[0]?.threshold??null,
    best_preliminary_metrics:preliminary[0]??null,
    cross_sectional_rank_diagnostics:crossSectionalRankDiagnostics
  };
}

/**
 * Predeclared LR/L2 calibration on inner selection only. The frozen Logistic
 * anchor is fit once on training rows and reused for every challenger config.
 */
/**
 * Ordered 696-feature rankers may participate in selection only when their
 * selected candidate beats the fold-local Logistic reference on BOTH ranking
 * accuracy and pairwise log loss in every one of the three purged folds.
 * Diagnostic artifacts remain exportable, but an unqualified ranker cannot
 * qualify the enclosing classifier/Hurdle selection.
 */
export function hasFoldStableOrderedRankerQualification(rankHead, rankingRepresentation = null) {
  const isOrderedRanker =
    rankingRepresentation === 'RAW_ORDERED_696_V1' ||
    rankHead?.representation === 'RAW_ORDERED_696_V1' ||
    rankHead?.schema === 'RADARX_TCN_LSTM_INDEPENDENT_ORDERED_696_RETURN_RANKER_V1';
  if (!isOrderedRanker) return true;

  const tuning = rankHead?.internal_training_validation;
  const isThreeFoldV6=tuning?.schema===
    'RADARX_TCN_LSTM_ORDERED_RANKER_INTERNAL_PURGED_EXPANDING_VALIDATION_V6';
  const currentParetoPolicy=tuning?.method===
    'THREE_FOLD_NESTED_PARETO_CHECKPOINT_REQUIRED_LOGISTIC_ANCHORED_VALIDATION_V3'&&
    tuning?.epoch_checkpoint_selection_policy===
      'PARETO_NON_REGRESSION_PAIRWISE_ACCURACY_AND_LOG_LOSS_V1';
  const previousParetoPolicy=tuning?.method===
    'THREE_FOLD_NESTED_PARETO_DUAL_METRIC_LOGISTIC_ANCHORED_VALIDATION_V2'&&
    tuning?.epoch_checkpoint_selection_policy===
      'PARETO_NON_REGRESSION_PAIRWISE_ACCURACY_AND_LOG_LOSS_V1';
  const legacyAccuracyFirstPolicy=tuning?.method===
    'THREE_FOLD_NESTED_EARLY_STOPPING_LOGISTIC_ANCHORED_DUAL_METRIC_VALIDATION_V1'&&
    tuning?.epoch_checkpoint_selection_policy===undefined;
  if (!isThreeFoldV6 || !(currentParetoPolicy||previousParetoPolicy||legacyAccuracyFirstPolicy) ||
      tuning.fold_count !== 3 ||
      tuning.selected_candidate_qualified !== true ||
      tuning.fold_stable_dual_metric_superiority !== true ||
      tuning.robustness_status !== 'FOLD_STABLE_DUAL_LOGISTIC_SUPERIORITY' ||
      !Number.isInteger(tuning.fold_stable_dual_metric_candidate_count) ||
      tuning.fold_stable_dual_metric_candidate_count < 1 ||
      !Array.isArray(tuning.candidate_grid)) return false;

  const selected = tuning.candidate_grid.find(candidate =>
    candidate?.temporal_block_count === tuning.selected_temporal_block_count &&
    candidate?.l2 === tuning.selected_l2 &&
    candidate?.best_epoch === tuning.selected_epochs &&
    candidate?.parameterization_id === tuning.selected_parameterization_id &&
    candidate?.parameter_count === tuning.selected_parameter_count
  );
  if (!Array.isArray(selected?.fold_results) || selected.fold_results.length !== 3) {
    return false;
  }
  if(currentParetoPolicy&&(
    selected.all_epoch_checkpoints_selected!==true||
    selected.epoch_checkpoint_selected_count!==3||
    selected.fold_results.some(fold=>fold?.epoch_checkpoint_selected!==true)
  )) return false;

  return selected.fold_results.every((fold, index) =>
    fold?.fold_index === index + 1 &&
    Number.isFinite(fold?.best_validation_pairwise_accuracy_pct) &&
    Number.isFinite(fold?.logistic_validation_pairwise_accuracy_pct) &&
    Number.isFinite(fold?.best_validation_pairwise_log_loss) &&
    Number.isFinite(fold?.logistic_validation_pairwise_log_loss) &&
    fold.best_validation_pairwise_accuracy_pct >
      fold.logistic_validation_pairwise_accuracy_pct &&
    fold.best_validation_pairwise_log_loss <
      fold.logistic_validation_pairwise_log_loss
  );
}

export function selectTcnLstmHybridHyperparameters(trainingRows, selectionRows, {
  candidates = [
    { name: 'LR_0015_L2_0005_DROP00', learningRate: 0.0015, l2: 0.0005, dropout: 0, epochs: 6 },
    { name: 'LR_0025_L2_0015_DROP10', learningRate: 0.0025, l2: 0.0015, dropout: 0.10, epochs: 6 },
    { name: 'LR_0035_L2_0035_DROP20', learningRate: 0.0035, l2: 0.0035, dropout: 0.20, epochs: 6 }
  ],
  requiredImprovement = 0.00025,
  seed = 29,
  maxTrainingSamples = TCN_LSTM_MAX_TRAINING_SAMPLES,
  roundTripCostBps=30,minimumReturnTrades=20,minimumReturnWinRatePct=55,
  rankingScoreWeight=0.01,rankingMinimumReturnGapPct=0.50,rankingPairsPerTimestamp=4,
  rankingPairStrategy='RETURN_EXTREMES_V1',
  rankingRepresentation='LATENT_MULTI_SCALE_V2',
  rankingHeadLearningRate=0.03,rankingHeadEpochs=40,rankingHeadL2=0.001,
  rankingValidationFraction=0.08,
  externalLogisticExecutionContextProvider=null,
  requireExternalLogisticSelectionBaseline=false
} = {}) {
  const trainSupport = assertRows(trainingRows, 'TRAINING');
  const selectionSupport = assertRows(selectionRows, 'SELECTION');
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 8)
    throw new TypeError('TCN_LSTM_HYPERPARAMETER_GRID_INVALID');
  if (!finite(requiredImprovement) || requiredImprovement < 0)
    throw new TypeError('TCN_LSTM_SELECTION_MARGIN_INVALID');
  if(!finite(roundTripCostBps)||roundTripCostBps<0||roundTripCostBps>300||
    !Number.isInteger(minimumReturnTrades)||minimumReturnTrades<1||
    !finite(minimumReturnWinRatePct)||minimumReturnWinRatePct<0||minimumReturnWinRatePct>100||
    !finite(rankingScoreWeight)||rankingScoreWeight<0||rankingScoreWeight>1||
    !finite(rankingMinimumReturnGapPct)||rankingMinimumReturnGapPct<0||
    !Number.isInteger(rankingPairsPerTimestamp)||rankingPairsPerTimestamp<1||rankingPairsPerTimestamp>32||
    !['RETURN_EXTREMES_V1','PROFITABILITY_BOUNDARY_V1','PROFITABILITY_TOPK_V2'].includes(rankingPairStrategy)||
    !TCN_LSTM_RANKING_REPRESENTATIONS.includes(rankingRepresentation)||
    !finite(rankingHeadLearningRate)||rankingHeadLearningRate<=0||rankingHeadLearningRate>0.25||
    !Number.isInteger(rankingHeadEpochs)||rankingHeadEpochs<1||rankingHeadEpochs>200||
    !finite(rankingHeadL2)||rankingHeadL2<0||rankingHeadL2>1||
    !finite(rankingValidationFraction)||rankingValidationFraction<0.08||
      rankingValidationFraction>0.40||
    typeof externalLogisticExecutionContextProvider!=='function'&&
      externalLogisticExecutionContextProvider!==null||
    typeof requireExternalLogisticSelectionBaseline!=='boolean'||
    requireExternalLogisticSelectionBaseline&&
      typeof externalLogisticExecutionContextProvider!=='function')
    throw new TypeError('TCN_LSTM_RETURN_DIAGNOSTIC_CONFIGURATION_INVALID');
  const trainingSampleSelection=selectChronologicalTcnLstmTrainingRows(
    trainingRows,maxTrainingSamples
  );
  const effectiveTrainingBudget=trainingSampleSelection.diagnostics.effective_budget;
  const effectiveTrainingRows=trainingSampleSelection.rows;
  // Realized returns belong only to the separate selection diagnostic; strip
  // them before either the Logistic anchor or neural optimizer sees fit rows.
  const trainAt = effectiveTrainingRows.map(row => row.at);
  const trainResolved = effectiveTrainingRows.map(row => row.resolved_at);
  const selectionAt = selectionRows.map(row => row.at);
  if (trainAt.some(value => !finite(value)) ||
      trainResolved.some(value => !finite(value) || value <= 0) ||
      selectionAt.some(value => !finite(value)) ||
      selectionRows.some(row => !finite(row.resolved_at) || row.resolved_at <= row.at))
    throw new TypeError('TCN_LSTM_SELECTION_REQUIRES_MATURED_CHRONOLOGICAL_TIMESTAMPS');
  if (!(Math.max(...trainResolved) < Math.min(...selectionAt)))
    throw new TypeError('TCN_LSTM_TRAIN_SELECTION_PURGE_VIOLATION');
  const trainingIds = new Set(effectiveTrainingRows.map(sampleIdentity));
  if (selectionRows.some(row => trainingIds.has(sampleIdentity(row))))
    throw new TypeError('TCN_LSTM_TRAIN_SELECTION_IDENTITY_OVERLAP');
  const executionEvidenceComplete=effectiveTrainingRows.every(row=>
    finite(row.realized_return_pct)&&finite(row.max_adverse_excursion_pct)
  );
  const executionHeadSplit=executionEvidenceComplete
    ?splitTcnLstmTrainingRowsForExecutionHead(effectiveTrainingRows)
    :{
      status:'UNAVAILABLE',reason:'EXECUTION_HEAD_OUTCOMES_INCOMPLETE',
      model_training_rows:effectiveTrainingRows,execution_head_rows:null,purged_rows:[],
      diagnostics:{
        schema:'RADARX_TCN_LSTM_PURGED_EXECUTION_HEAD_SPLIT_V1',
        status:'UNAVAILABLE',reason:'EXECUTION_HEAD_OUTCOMES_INCOMPLETE',
        available_rows:effectiveTrainingRows.length,
        model_training_rows:effectiveTrainingRows.length,execution_head_rows:0,
        purged_rows:0,chronology_valid:false,representation_out_of_sample:false,
        validation_or_holdout_used:false
      }
    };
  const modelTrainingRows=executionHeadSplit.model_training_rows;
  const executionHeadRows=executionHeadSplit.execution_head_rows;
  // Fit the independent raw ranker before the Logistic OOF filter. It uses
  // every matured row in the pre-execution model-training partition and no
  // later execution, selection, outer-validation, or holdout rows.
  const preFittedIndependentRankingHead=rankingRepresentation==='RAW_ORDERED_696_V1'
    ?fitTcnLstmOrderedRankerForTrainingPartition(modelTrainingRows,{
      roundTripCostBps,
      minimumReturnGapPct:rankingMinimumReturnGapPct,
      maxPairsPerTimestamp:rankingPairsPerTimestamp,
      pairStrategy:rankingPairStrategy,
      learningRate:rankingHeadLearningRate,
      epochs:rankingHeadEpochs,
      l2:rankingHeadL2,
      patience:10,
      validationFraction:rankingValidationFraction
    })
    :null;
  let effectiveTrainingRowsForFit=modelTrainingRows.map(row=>{
    const {realized_return_pct,...fitRow}=row;
    return fitRow;
  });
  let rankingRowsForFit=null;
  let rankingTrainingPairSupport={
    status:'UNAVAILABLE',reason:'TRAINING_RETURN_PAIR_SUPPORT_NOT_CHECKED',
    comparison_pairs:0,decision_group_count:0,
    source_partition:'TRAINING_PARTITION_ONLY'
  };
  let anchor=null;
  const externalLogisticScoringSourceRows=[
    ...(Array.isArray(executionHeadRows)?executionHeadRows:[]),...selectionRows
  ];
  // The Logistic context provider receives no realized return, excursion, or
  // target labels for rows whose scores it generates. Only the earlier model
  // fitting partition carries labels, and only its binary classifier target.
  const externalLogisticTrainingRows=modelTrainingRows.map(row=>({
    id:row.id,symbol:row.symbol,at:Number(row.at),
    resolved_at:Number(row.resolved_at),target:row.target,
    logistic_feature_vector:row.logistic_feature_vector
  }));
  const externalLogisticScoringRows=externalLogisticScoringSourceRows.map(row=>({
    id:row.id,symbol:row.symbol,at:Number(row.at),
    resolved_at:Number(row.resolved_at),
    logistic_feature_vector:row.logistic_feature_vector
  }));
  const modelTrainingMaxResolvedAt=Math.max(
    ...modelTrainingRows.map(row=>Number(row.resolved_at))
  );
  const externalLogisticScoringMinAt=Math.min(
    ...externalLogisticScoringRows.map(row=>Number(row.at))
  );
  if(!(modelTrainingMaxResolvedAt<externalLogisticScoringMinAt))
    throw new TypeError('TCN_LSTM_EXTERNAL_LOGISTIC_CONTEXT_PURGE_VIOLATION');
  let externalLogisticContextModel=null;
  let externalLogisticContextMetadata={
    schema:'RADARX_TCN_LSTM_TEMPORAL_LOGISTIC_CV_EXECUTION_CONTEXT_V1',
    status:'INTERNAL_ANCHOR_FALLBACK',
    reason:'TEMPORAL_LOGISTIC_CV_CONTEXT_PROVIDER_NOT_SUPPLIED',
    fit_partition:'PRE_EXECUTION_HEAD_TRAINING_ROWS_ONLY',
    training_rows:modelTrainingRows.length,
    scoring_rows:externalLogisticScoringRows.length,
    model_training_max_resolved_at:modelTrainingMaxResolvedAt,
    scoring_min_at:externalLogisticScoringMinAt,
    validation_or_holdout_used:false
  };
  let executionHeadRowsWithLogisticContext=
    Array.isArray(executionHeadRows)?executionHeadRows:null;
  let selectionRowsWithLogisticContext=selectionRows;
  if(externalLogisticExecutionContextProvider){
    const provided=externalLogisticExecutionContextProvider(
      externalLogisticTrainingRows,externalLogisticScoringRows
    );
    if(!provided?.model||provided?.model?.training_partition_only!==true||
      provided?.report?.schema!=='RADARX_TRAIN_ONLY_PURGED_EXPANDING_LOGISTIC_CV_V2'||
      provided?.report?.status!=='COMPLETE'||
      provided?.report?.training_partition_only!==true||
      provided?.report?.outer_validation_rows_used!==false||
      provided?.report?.holdout_rows_or_labels_used!==false||
      typeof provided?.feature_schema_id!=='string'||!provided.feature_schema_id||
      !Array.isArray(provided?.predictions)||
      provided.predictions.length!==externalLogisticScoringRows.length||
      requireExternalLogisticSelectionBaseline&&
        (!Array.isArray(provided?.training_predictions)||
          provided.training_predictions.length<20||
          provided.training_predictions.length>modelTrainingRows.length||
          provided.training_predictions_are_out_of_fold!==true||
          provided.training_prediction_coverage?.schema!==
            'RADARX_PURGED_EXPANDING_TEMPORAL_LOGISTIC_OOF_PREDICTIONS_V1'||
          provided.training_prediction_coverage?.total_training_rows!==modelTrainingRows.length||
          provided.training_prediction_coverage?.oof_scored_rows!==provided.training_predictions.length||
          provided.training_prediction_coverage?.outer_validation_or_holdout_used!==false||
          provided.feature_schema_id!==TCN_LSTM_FULL_SEQUENCE_LOGISTIC_FEATURE_SCHEMA_ID||
          !Array.isArray(provided.feature_schema_names)||
          provided.feature_schema_names.length!==TCN_LSTM_FULL_SEQUENCE_LOGISTIC_FEATURE_COUNT))
      throw new TypeError('TCN_LSTM_EXTERNAL_LOGISTIC_CONTEXT_PROVIDER_CONTRACT_INVALID');
    const trainingPredictedById=new Map();
    if(requireExternalLogisticSelectionBaseline){
      const modelTrainingById=new Map(modelTrainingRows.map(row=>[
        sampleIdentity(row),row
      ]));
      for(const prediction of provided.training_predictions){
        const id=String(prediction?.id??'');
        const sourceRow=modelTrainingById.get(id);
        if(!id||!sourceRow||trainingPredictedById.has(id)||
          !finite(prediction?.at)||!finite(prediction?.raw_logit)||
          !Number.isInteger(prediction?.oof_fold)||prediction.oof_fold<1||
          prediction?.source_partition!=='PURGED_EXPANDING_TRAIN_ONLY_OOF_FOLD'||
          !finite(prediction?.maximum_training_label_resolved_at)||
          Number(prediction.maximum_training_label_resolved_at)>=Number(prediction.at)||
          Number(prediction.at)!==Number(sourceRow.at))
          throw new TypeError('TCN_LSTM_EXTERNAL_LOGISTIC_TRAINING_OOF_PREDICTION_INVALID:'+id);
        trainingPredictedById.set(id,{
          at:Number(prediction.at),
          rawLogit:clamp(Number(prediction.raw_logit),-LOGIT_LIMIT,LOGIT_LIMIT),
          fold:Number(prediction.oof_fold),
          maximumTrainingLabelResolvedAt:Number(prediction.maximum_training_label_resolved_at)
        });
      }
      const minimumOofTrainingRows=Math.max(20,Math.ceil(modelTrainingRows.length*0.50));
      if(trainingPredictedById.size<minimumOofTrainingRows)
        throw new TypeError('TCN_LSTM_EXTERNAL_LOGISTIC_OOF_COVERAGE_TOO_SMALL:'+[
          trainingPredictedById.size,minimumOofTrainingRows
        ].join('/'));
      effectiveTrainingRowsForFit=effectiveTrainingRowsForFit
        .filter(row=>trainingPredictedById.has(sampleIdentity(row)))
        .map(row=>{
          const id=sampleIdentity(row),prediction=trainingPredictedById.get(id);
          if(prediction.at!==Number(row.at))
            throw new TypeError('TCN_LSTM_EXTERNAL_LOGISTIC_TRAINING_ROW_ALIGNMENT_FAILED:'+id);
          return {
            ...row,classifier_baseline_logit:prediction.rawLogit,
            classifier_baseline_oof_fold:prediction.fold,
            classifier_baseline_training_max_resolved_at:
              prediction.maximumTrainingLabelResolvedAt
          };
        });
      const retainedTargets=effectiveTrainingRowsForFit.map(row=>row.target);
      const retainedPositive=retainedTargets.filter(target=>target===1).length;
      const retainedNegative=retainedTargets.filter(target=>target===0).length;
      if(effectiveTrainingRowsForFit.length<20||retainedPositive<2||retainedNegative<2)
        throw new TypeError('TCN_LSTM_EXTERNAL_LOGISTIC_OOF_TRAINING_SUPPORT_FAILED');
      anchor=fitTcnLstmLogisticAnchor(effectiveTrainingRowsForFit);
    }
    const predictedById=new Map();
    for(const prediction of provided.predictions){
      const id=String(prediction?.id??'');
      if(!id||predictedById.has(id)||!finite(prediction?.at)||
        !finite(prediction?.logit)||
        requireExternalLogisticSelectionBaseline&&!finite(prediction?.raw_logit))
        throw new TypeError('TCN_LSTM_EXTERNAL_LOGISTIC_CONTEXT_PREDICTION_INVALID:'+id);
      predictedById.set(id,{
        at:Number(prediction.at),logit:Number(prediction.logit),
        rawLogit:finite(prediction?.raw_logit)?Number(prediction.raw_logit):null
      });
    }
    const enrichRows=sourceRows=>sourceRows.map(row=>{
      const prediction=predictedById.get(sampleIdentity(row));
      if(!prediction||prediction.at!==Number(row.at))
        throw new TypeError('TCN_LSTM_EXTERNAL_LOGISTIC_CONTEXT_ROW_ALIGNMENT_FAILED:'+row.id);
      return {...row,
        external_logistic_logit:prediction.logit,
        external_logistic_raw_logit:prediction.rawLogit,
        classifier_baseline_logit:prediction.rawLogit
      };
    });
    executionHeadRowsWithLogisticContext=Array.isArray(executionHeadRows)
      ?enrichRows(executionHeadRows):null;
    selectionRowsWithLogisticContext=enrichRows(selectionRows);
    externalLogisticContextModel=provided.model;
    externalLogisticContextMetadata={
      schema:'RADARX_TCN_LSTM_TEMPORAL_LOGISTIC_CV_EXECUTION_CONTEXT_V1',
      status:'AVAILABLE',
      fit_partition:'PRE_EXECUTION_HEAD_TRAINING_ROWS_ONLY',
      training_rows:modelTrainingRows.length,
      scoring_rows:externalLogisticScoringRows.length,
      model_training_max_resolved_at:modelTrainingMaxResolvedAt,
      scoring_min_at:externalLogisticScoringMinAt,
      purge_gap_ms:externalLogisticScoringMinAt-modelTrainingMaxResolvedAt,
      logistic_cv_schema:provided.report.schema,
      logistic_feature_schema_id:provided.feature_schema_id,
      logistic_feature_schema_names:provided.feature_schema_names??null,
      logistic_cv_selected_configuration:provided.report.selected_configuration,
      logistic_cv_calibration:provided.report.calibration,
      predictions_are_out_of_sample_for_scoring_rows:true,
      training_predictions_are_out_of_fold:true,
      training_predictions_source_partition:'PURGED_EXPANDING_TRAIN_ONLY_OOF_FOLDS',
      training_prediction_coverage:provided.training_prediction_coverage,
      classifier_training_baseline_source:requireExternalLogisticSelectionBaseline
        ?'TUNED_FULL_ORDERED_TEMPORAL_LOGISTIC_696_RAW_OOF'
        :'FROZEN_POOLED_LOGISTIC_ANCHOR_58_FALLBACK',
      validation_or_holdout_used:false
    };
  }else{
    anchor=fitTcnLstmLogisticAnchor(effectiveTrainingRowsForFit);
    const enrichRows=sourceRows=>sourceRows.map(row=>({
      ...row,
      external_logistic_logit:predictTcnLstmLogisticLogit(row.sequence,anchor),
      external_logistic_raw_logit:null
    }));
    executionHeadRowsWithLogisticContext=Array.isArray(executionHeadRows)
      ?enrichRows(executionHeadRows):null;
    selectionRowsWithLogisticContext=enrichRows(selectionRows);
  }
  if(!anchor)anchor=fitTcnLstmLogisticAnchor(effectiveTrainingRowsForFit);
  const fitTrainingIdentities=new Set(effectiveTrainingRowsForFit.map(sampleIdentity));
  const rankingEvidenceRows=modelTrainingRows.filter(row=>
    fitTrainingIdentities.has(sampleIdentity(row))
  );
  const rankingTrainingEvidenceComplete=rankingEvidenceRows.length>=20&&
    rankingEvidenceRows.every(row=>finite(row.realized_return_pct));
  if(preFittedIndependentRankingHead!==null){
    const support=preFittedIndependentRankingHead.pair_support;
    rankingTrainingPairSupport={
      status:'AVAILABLE',
      reason:null,
      comparison_pairs:support.comparison_pairs,
      decision_group_count:support.decision_group_count,
      pair_strategy:support.pair_strategy,
      positive_opportunity_groups:support.positive_opportunity_groups,
      mixed_decision_groups:support.mixed_decision_groups,
      source_partition:'PRE_EXECUTION_MODEL_TRAINING_PARTITION',
      training_rows:preFittedIndependentRankingHead.training_rows,
      out_of_fold_logistic_baseline:false,
      ranker_fitted_once_for_all_classifier_candidates:true
    };
    // If an independent candidate also opts into the separate shared
    // classifier-ranking objective, build those gradients on the OOF-filtered
    // classifier subset. Do not refit or redefine the frozen sidecar above.
    if(candidates.some(config=>Number(config?.rankingWeight??0)>0)){
      const sharedSupport=buildTcnLstmReturnRankingPairs(
        effectiveTrainingRowsForFit,rankingEvidenceRows,{
          roundTripCostBps,
          minimumReturnGapPct:rankingMinimumReturnGapPct,
          maxPairsPerTimestamp:rankingPairsPerTimestamp,
          pairStrategy:rankingPairStrategy
        }
      );
      if(sharedSupport.comparison_pairs>=10)rankingRowsForFit=rankingEvidenceRows;
    }
  }else if(rankingTrainingEvidenceComplete){
    try{
      const support=buildTcnLstmReturnRankingPairs(
        effectiveTrainingRowsForFit,rankingEvidenceRows,{
          roundTripCostBps,
          minimumReturnGapPct:rankingMinimumReturnGapPct,
          maxPairsPerTimestamp:rankingPairsPerTimestamp,
          pairStrategy:rankingPairStrategy
        }
      );
      rankingTrainingPairSupport={
        status:support.comparison_pairs>=10?'AVAILABLE':'UNAVAILABLE',
        reason:support.comparison_pairs>=10?null:'FEWER_THAN_10_TRAINING_RETURN_PAIRS',
        comparison_pairs:support.comparison_pairs,
        decision_group_count:support.decision_group_count,
        pair_strategy:support.pair_strategy,
        positive_opportunity_groups:support.positive_opportunity_groups,
        mixed_decision_groups:support.mixed_decision_groups,
        source_partition:'TRAINING_PARTITION_ONLY',
        training_rows:effectiveTrainingRowsForFit.length,
        out_of_fold_logistic_baseline:true
      };
      if(support.comparison_pairs>=10)rankingRowsForFit=rankingEvidenceRows;
    }catch(error){
      rankingTrainingPairSupport={
        status:'UNAVAILABLE',reason:String(error?.message||error),
        comparison_pairs:0,decision_group_count:0,
        source_partition:'TRAINING_PARTITION_ONLY',
        training_rows:effectiveTrainingRowsForFit.length
      };
    }
  }else{
    rankingTrainingPairSupport={
      ...rankingTrainingPairSupport,
      reason:'TRAINING_RETURN_EVIDENCE_OR_OOF_SUPPORT_INCOMPLETE',
      training_rows:effectiveTrainingRowsForFit.length
    };
  }
  const innerSelectionBaseline=resolveTcnLstmInnerSelectionLogisticBaseline(
    selectionRows,selectionRowsWithLogisticContext,{
      anchor,
      featureSchemaId:externalLogisticContextMetadata.logistic_feature_schema_id??null,
      featureNames:externalLogisticContextMetadata.logistic_feature_schema_names??null,
      requireFullSequenceLogistic:requireExternalLogisticSelectionBaseline
    }
  );
  const baselineLogits=innerSelectionBaseline.logits;
  const baselinePredictions=baselineLogits.map(sigmoid);
  externalLogisticContextMetadata.inner_selection_baseline_source=
    innerSelectionBaseline.source;
  externalLogisticContextMetadata.inner_selection_baseline_feature_schema_id=
    innerSelectionBaseline.feature_schema_id;
  externalLogisticContextMetadata.inner_selection_baseline_feature_count=
    innerSelectionBaseline.feature_count;
  externalLogisticContextMetadata.inner_selection_baseline_probability_stage=
    innerSelectionBaseline.probability_stage;
  externalLogisticContextMetadata.classifier_training_baseline_source=
    requireExternalLogisticSelectionBaseline
      ?'TUNED_FULL_ORDERED_TEMPORAL_LOGISTIC_696_RAW_OOF'
      :'FROZEN_POOLED_LOGISTIC_ANCHOR_58_FALLBACK';
  externalLogisticContextMetadata.classifier_training_baseline_rows=
    effectiveTrainingRowsForFit.filter(row=>finite(row.classifier_baseline_logit)).length;
  externalLogisticContextMetadata.classifier_training_baseline_rows_before_oof_filter=
    modelTrainingRows.length;
  externalLogisticContextMetadata.classifier_training_baseline_oof_coverage_pct=
    modelTrainingRows.length
      ?Number((100*externalLogisticContextMetadata.classifier_training_baseline_rows/
        modelTrainingRows.length).toFixed(4)):0;
  const baselineBrier = brierFrom(selectionRows, baselinePredictions);
  const baselineRanking=summarizeTcnLstmPairwiseLogitRanking(
    selectionRows,baselineLogits,{
      roundTripCostBps,minimumReturnGapPct:rankingMinimumReturnGapPct,
      maxPairsPerTimestamp:rankingPairsPerTimestamp,
      pairStrategy:rankingPairStrategy
    }
  );
  const rankingScoreAvailable=baselineRanking.status==='AVAILABLE';
  const baselineSelectionScore=baselineBrier+
    (rankingScoreAvailable?rankingScoreWeight*baselineRanking.pairwise_log_loss:0);
  const effectiveCandidates=candidates.filter(config=>
    Number(config?.rankingWeight??0)<=0||rankingRowsForFit!==null
  );
  const skippedCandidates=candidates.filter(config=>
    Number(config?.rankingWeight??0)>0&&rankingRowsForFit===null
  ).map(config=>({
    name:config?.name??null,
    ranking_weight:Number(config?.rankingWeight),
    reason:'TRAINING_RETURN_PAIR_SUPPORT_UNAVAILABLE'
  }));
  if(effectiveCandidates.length<2)
    throw new TypeError('TCN_LSTM_EFFECTIVE_HYPERPARAMETER_GRID_TOO_SMALL');
  const evaluated = [];
  for (let index = 0; index < effectiveCandidates.length; index++) {
    const config = effectiveCandidates[index];
    const candidateDropout = config?.dropout === undefined ? 0 : config.dropout;
    const candidateObjective=config?.objective??'BRIER';
    if (!config || typeof config.name !== 'string' ||
        !finite(config.learningRate) || !finite(config.l2) ||
        !finite(candidateDropout) || candidateDropout < 0 || candidateDropout > 0.40 ||
        !['BRIER','FOCAL_ASYMMETRIC_BRIER'].includes(candidateObjective)||
        (config.rankingWeight!==undefined&&
          (!finite(config.rankingWeight)||config.rankingWeight<0||config.rankingWeight>1))||
        (config.rankingHeadLearningRate!==undefined&&
          (!finite(config.rankingHeadLearningRate)||config.rankingHeadLearningRate<=0||
            config.rankingHeadLearningRate>0.25))||
        !Number.isSafeInteger(config.epochs) || config.epochs < 1 || config.epochs > 30)
      throw new TypeError('TCN_LSTM_HYPERPARAMETER_CANDIDATE_INVALID:' + index);
    const candidateRankingHeadLearningRate=Number(
      config.rankingHeadLearningRate??rankingHeadLearningRate
    );
    const fit = trainTcnLstmHybrid(effectiveTrainingRowsForFit, {
      epochs: config.epochs,
      learningRate: config.learningRate,
      l2: config.l2,
      dropout:candidateDropout,
      objective:candidateObjective,
      seed: seed + index * 101,
      maxTrainingSamples: modelTrainingRows.length,
      baselineFit: anchor,
      rankingRows:preFittedIndependentRankingHead!==null
        ?(Number(config.rankingWeight??0)>0?rankingRowsForFit:null)
        :rankingRowsForFit,
      executionRows:null,
      rankingWeight:Number(config.rankingWeight??0),
      rankingHeadLearningRate:candidateRankingHeadLearningRate,
      rankingHeadEpochs,rankingHeadL2,rankingValidationFraction,
      fitIndependentRankingHead:preFittedIndependentRankingHead===null,
      preFittedIndependentRankingHead,
      rankingRoundTripCostBps:roundTripCostBps,
      rankingMinimumReturnGapPct:rankingMinimumReturnGapPct,
      rankingPairsPerTimestamp:rankingPairsPerTimestamp,
      rankingPairStrategy,
      rankingRepresentation,
      executionHeadRoundTripCostBps:roundTripCostBps
    });
    if(!fit.training?.return_ranking)
      throw new TypeError('TCN_LSTM_PRE_EXECUTION_RANKER_PROFILE_CONTRACT_MISSING');
    const rankerHead=fit.training.return_ranking.ranking_head??null;
    const rankerFitRows=preFittedIndependentRankingHead!==null
      ?modelTrainingRows:effectiveTrainingRowsForFit;
    const rankerTrainingIds=new Set(rankerFitRows.map(sampleIdentity));
    const executionFeatureRows=Array.isArray(executionHeadRowsWithLogisticContext)
      ?executionHeadRowsWithLogisticContext:[];
    const executionFeatureIds=new Set(executionFeatureRows.map(sampleIdentity));
    const rankerAndExecutionFeatureIdentitiesDisjoint=
      [...executionFeatureIds].every(id=>!rankerTrainingIds.has(id));
    const rankerTrainingMaxResolvedAt=rankerFitRows.length
      ?Math.max(...rankerFitRows.map(row=>Number(row.resolved_at))):null;
    const executionFeatureMinAt=executionFeatureRows.length
      ?Math.min(...executionFeatureRows.map(row=>Number(row.at))):null;
    const rankerFeatureChronologyValid=finite(rankerTrainingMaxResolvedAt)&&
      finite(executionFeatureMinAt)&&rankerTrainingMaxResolvedAt<executionFeatureMinAt;
    const rankerFeatureContract={
      schema:'RADARX_TCN_LSTM_EXECUTION_RANK_FEATURE_OUT_OF_SAMPLE_CONTRACT_V1',
      fit_partition:'PRE_EXECUTION_MODEL_TRAINING_PARTITION',
      feature_scoring_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK',
      ranker_training_rows:rankerHead?.training_rows??0,
      ranker_training_pairs:rankerHead?.training_pairs??0,
      ranker_standardizer_fit_rows:rankerHead?.standardization?.fit_rows??0,
      ranker_standardizer_fit_partition:rankerHead?.standardization?.fit_partition??null,
      model_training_max_resolved_at:rankerTrainingMaxResolvedAt,
      execution_feature_min_at:executionFeatureMinAt,
      purge_gap_ms:finite(rankerTrainingMaxResolvedAt)&&finite(executionFeatureMinAt)
        ?executionFeatureMinAt-rankerTrainingMaxResolvedAt:null,
      training_and_execution_feature_identities_disjoint:
        rankerAndExecutionFeatureIdentitiesDisjoint,
      chronology_valid:rankerFeatureChronologyValid,
      classifier_parameters_updated_by_ranker:
        rankerHead?.classifier_parameters_updated===true,
      validation_or_holdout_used:rankerHead?.validation_or_holdout_used===true,
      out_of_sample_for_execution_head_features:
        rankerHead?.fitted===true&&
        rankerHead?.standardization?.fit_partition==='TRAINING_PARTITION_ONLY'&&
        Number(rankerHead?.standardization?.fit_rows)===rankerFitRows.length&&
        rankerAndExecutionFeatureIdentitiesDisjoint&&rankerFeatureChronologyValid&&
        rankerHead?.classifier_parameters_updated===false&&
        rankerHead?.validation_or_holdout_used===false
    };
    if(rankerHead?.fitted===true&&
      !rankerFeatureContract.out_of_sample_for_execution_head_features)
      throw new TypeError('TCN_LSTM_EXECUTION_RANK_FEATURE_LEAKAGE_CONTRACT_FAILED');
    if(rankerHead?.fitted===true){
      Object.assign(rankerHead,{
        source_partition:'PRE_EXECUTION_MODEL_TRAINING_PARTITION',
        feature_scoring_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK',
        feature_scores_out_of_sample:true,
        training_and_execution_feature_identities_disjoint:true,
        chronology_valid:true,
        classifier_parameters_updated:false,
        validation_or_holdout_used:false,
        downstream_feature_contract:rankerFeatureContract
      });
    }
    fit.training.return_ranking.ranking_head=rankerHead;
    fit.training.return_ranking.enabled=rankerHead?.fitted===true;
    fit.training.return_ranking.source_partition='PRE_EXECUTION_MODEL_TRAINING_PARTITION';
    fit.training.return_ranking.feature_scoring_partition=
      'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK';
    fit.training.return_ranking.feature_scores_out_of_sample=
      rankerFeatureContract.out_of_sample_for_execution_head_features;
    fit.training.return_ranking.downstream_feature_contract=rankerFeatureContract;
    fit.execution_logistic_context_model=externalLogisticContextModel;
    fit.execution_logistic_context_metadata=externalLogisticContextMetadata;
    const executionHeadsFitted=false;
    const executionRiskPolicyUnavailable={
      schema:'RADARX_TCN_LSTM_SELECTIVE_EXECUTION_POLICY_V2',
      status:'DEFERRED_UNTIL_DUAL_INNER_GATE',
      selection_partition_only:true,holdout_values_used:false,passed:false
    };
    const executionRiskPolicy=executionRiskPolicyUnavailable;
    const pooledOnlyExecutionRiskPolicy={...executionRiskPolicyUnavailable};
    const executionHeadContextAblation={
      schema:'RADARX_TCN_LSTM_EXECUTION_HEAD_CONTEXT_ABLATION_V1',
      status:'DEFERRED_UNTIL_DUAL_INNER_GATE',
      passed:false,source_partition:'INNER_SELECTION_ONLY',holdout_values_used:false
    };
    const selectionLogits = selectionRows.map((row,rowIndex) => {
      const baseLogit=baselineLogits[rowIndex];
      return inspectTcnLstmForward(row.sequence,fit.model,baseLogit).logit;
    });
    const selectionRankingScores = selectionRows.map(row => {
      return inspectTcnLstmForward(row.sequence,fit.model,0).ranking_score;
    });
    // Classification and return ranking are evaluated from independent heads.
    // No ranking score is sigmoid-transformed or added to a classifier/Logistic logit.
    const predictions=selectionLogits.map(logit=>sigmoid(logit));
    const score=brierFrom(selectionRows,predictions);
    const pairwiseRanking=summarizeTcnLstmPairwiseLogitRanking(
      selectionRows,selectionRankingScores,{
        roundTripCostBps,minimumReturnGapPct:rankingMinimumReturnGapPct,
        maxPairsPerTimestamp:rankingPairsPerTimestamp,
        pairStrategy:rankingPairStrategy
      }
    );
    const sharedClassifierPairwiseRanking=summarizeTcnLstmPairwiseLogitRanking(
      selectionRows,selectionLogits,{
        roundTripCostBps,minimumReturnGapPct:rankingMinimumReturnGapPct,
        maxPairsPerTimestamp:rankingPairsPerTimestamp,
        pairStrategy:rankingPairStrategy
      }
    );
    const selectionScore=score+
      (rankingScoreAvailable&&pairwiseRanking.status==='AVAILABLE'
        ?rankingScoreWeight*pairwiseRanking.pairwise_log_loss:0);
    const brierImprovement=baselineBrier-score;
    const pairwiseRankingImprovement=rankingScoreAvailable&&
      pairwiseRanking.status==='AVAILABLE'
        ?baselineRanking.pairwise_log_loss-pairwiseRanking.pairwise_log_loss:null;
    const sharedClassifierPairwiseRankingImprovement=rankingScoreAvailable&&
      sharedClassifierPairwiseRanking.status==='AVAILABLE'
        ?baselineRanking.pairwise_log_loss-sharedClassifierPairwiseRanking.pairwise_log_loss:null;
    const returnDiagnostics={
      schema:'RADARX_TCN_LSTM_RETURN_DIAGNOSTICS_DEFERRED_UNTIL_DUAL_INNER_GATE_V1',
      status:'DEFERRED_UNTIL_DUAL_INNER_GATE',
      selection_partition_only:true,holdout_values_used:false
    };
    const rankingExecutionSelection={
      schema:'RADARX_TCN_LSTM_RANKING_EXECUTION_SELECTION_V1',
      status:'DEFERRED_UNTIL_DUAL_INNER_GATE',passed:false,
      source_partition:'INNER_SELECTION_ONLY',holdout_values_used:false
    };
    const executionRiskPenaltyWeight=null;
    const ranking_score_method=rankingRepresentation==='RAW_ORDERED_696_V1'
      ?'RAW_ORDERED_696_INDEPENDENT_PAIRWISE_RANK_SCORE_V1'
      :'RAW_INDEPENDENT_MULTISCALE_TEMPORAL_RANK_SCORE_V2';
    const ranking_score_domain='RAW_LINEAR_SCORE_NO_SIGMOID_NO_CLASSIFIER_LOGIT_ADDITION';
    evaluated.push({
      name:config.name,
      config:{...config,dropout:candidateDropout,objective:candidateObjective,
        rankingRepresentation,
        rankingWeight:Number(config.rankingWeight??0),
        requested_shared_classifier_ranking_weight:Number(config.rankingWeight??0),
        rankingHeadLearningRate:candidateRankingHeadLearningRate},
      ranking_score_method,ranking_score_domain,
      _selection_probabilities:predictions,
      _selection_ranking_scores:selectionRankingScores,
      selection_brier:score,logistic_selection_brier:baselineBrier,
      brier_improvement:brierImprovement,
      pairwise_ranking:pairwiseRanking,logistic_pairwise_ranking:baselineRanking,
      pairwise_ranking_improvement:pairwiseRankingImprovement,
      shared_classifier_pairwise_ranking:sharedClassifierPairwiseRanking,
      shared_classifier_pairwise_ranking_improvement:sharedClassifierPairwiseRankingImprovement,
      ranking_execution_selection:rankingExecutionSelection,
      execution_risk_policy:executionRiskPolicy,
      pooled_only_execution_risk_policy:pooledOnlyExecutionRiskPolicy,
      execution_head_context_ablation:executionHeadContextAblation,
      execution_risk_penalty_weight:finite(fit.execution_risk_penalty_weight)
        ?fit.execution_risk_penalty_weight:null,
      execution_heads_fitted:fit.training.execution_regression_heads?.fitted===true,
      ranking_head_selection_qualified:rankingExecutionSelection.status==='EVALUATED'&&
        rankingExecutionSelection.passed===true,
      selection_score:selectionScore,logistic_selection_score:baselineSelectionScore,
      composite_improvement:baselineSelectionScore-selectionScore,
      improvement:baselineSelectionScore-selectionScore,
      return_selection_diagnostics:returnDiagnostics,fit
    });
  }
  evaluated.sort((a,b)=>
    Number(b.brier_improvement)-Number(a.brier_improvement)||
    Number(b.pairwise_ranking_improvement??-Infinity)-Number(a.pairwise_ranking_improvement??-Infinity)||
    a.selection_score-b.selection_score||a.name.localeCompare(b.name)
  );
  // A flat rank score must not pass merely because its neutral 0.693 loss
  // beats an over-confident Logistic logit. Ties count as half-correct in the
  // metric; qualification additionally requires a trained, nonzero rank head,
  // accuracy above chance, and accuracy above the matched Logistic anchor.
  const independentRankingSignalPassed=item=>{
    const returnRanking=item.fit?.training?.return_ranking??null;
    const rankHead=returnRanking?.ranking_head??null;
    const orderedFoldGatePassed=hasFoldStableOrderedRankerQualification(
      rankHead,returnRanking?.representation
    );
    const accuracy=Number(item.pairwise_ranking?.pairwise_accuracy_pct);
    const logisticAccuracy=Number(item.logistic_pairwise_ranking?.pairwise_accuracy_pct);
    return orderedFoldGatePassed&&rankHead?.fitted===true&&finite(rankHead.weight_l2_norm)&&
      rankHead.weight_l2_norm>1e-8&&
      finite(accuracy)&&accuracy>50&&finite(logisticAccuracy)&&
      accuracy>logisticAccuracy&&
      item.pairwise_ranking?.status==='AVAILABLE'&&
      finite(item.pairwise_ranking_improvement)&&item.pairwise_ranking_improvement>0;
  };
  // Stage 1 requires Brier improvement and non-degenerate independent return ranking.
  const stageOneQualified=evaluated.filter(item=>
    item.brier_improvement>requiredImprovement&&
    rankingScoreAvailable&&independentRankingSignalPassed(item)
  );
  // Stage 2 fits execution/Hurdle heads for every stage-1 qualifier. If the
  // classifier/ranker stage has no qualifier, also fit the single best
  // diagnostic candidate so a trained, reloadable research artifact can be
  // preserved with an explicit NOT_QUALIFIED status. This diagnostic fit does
  // not relax stage-1 or execution gates and cannot authorize outer scoring.
  const stageTwoCandidates=stageOneQualified.slice();
  if(evaluated.length>0&&!stageTwoCandidates.includes(evaluated[0])){
    evaluated[0].stage_two_diagnostic_only=true;
    stageTwoCandidates.push(evaluated[0]);
  }
  for(const item of stageTwoCandidates){
    try{
      if(!Array.isArray(executionHeadRowsWithLogisticContext)||
        executionHeadRowsWithLogisticContext.length<20)
        throw new TypeError('PURGED_EXECUTION_HEAD_TRAINING_BLOCK_NOT_AVAILABLE');
      const rankerFeatureContract=
        item.fit.training?.return_ranking?.downstream_feature_contract;
      if(rankerFeatureContract?.out_of_sample_for_execution_head_features!==true||
        rankerFeatureContract?.feature_scoring_partition!==
          'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK'||
        rankerFeatureContract?.fit_partition!==
          'PRE_EXECUTION_MODEL_TRAINING_PARTITION')
        throw new TypeError('TCN_LSTM_EXECUTION_HEAD_RANK_FEATURE_NOT_OUT_OF_SAMPLE');
      const executionHeadFit={
        ...fitTcnLstmExecutionRegressionHeads(
          executionHeadRowsWithLogisticContext,executionHeadRowsWithLogisticContext,
          item.fit.model,anchor,{roundTripCostBps}
        ),
        model_training_rows:modelTrainingRows.length,
        model_training_max_resolved_at:Math.max(...modelTrainingRows.map(row=>Number(row.resolved_at))),
        execution_head_min_at:Math.min(...executionHeadRowsWithLogisticContext.map(row=>Number(row.at))),
        source_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK',
        execution_head_split_source_partition:executionHeadSplit.diagnostics.source_partition,
        execution_head_split_status:executionHeadSplit.status,
        execution_head_split_method:executionHeadSplit.diagnostics.split_method,
        purged_rows:executionHeadSplit.purged_rows.length,
        purge_gap_ms:executionHeadSplit.diagnostics.purge_gap_ms,
        chronology_valid:executionHeadSplit.diagnostics.chronology_valid===true,
        representation_out_of_sample:executionHeadSplit.diagnostics.representation_out_of_sample===true,
        training_and_execution_head_identities_disjoint:executionHeadSplit.diagnostics.disjoint_sample_identities===true
      };
      if(executionHeadFit.representation_out_of_sample!==true||
        executionHeadFit.training_and_execution_head_identities_disjoint!==true||
        !(executionHeadFit.model_training_max_resolved_at<executionHeadFit.execution_head_min_at))
        throw new TypeError('TCN_LSTM_EXECUTION_HEAD_STAGE_TWO_PURGE_CONTRACT_FAILED');
      item.fit.training.execution_regression_heads=executionHeadFit;
      item.execution_heads_fitted=executionHeadFit.fitted===true;
      const contextPredictions=item.execution_heads_fitted
        ?selectionRowsWithLogisticContext.map(row=>predictTcnLstmHybridExecutionHeads(
          row.sequence,item.fit,{externalLogisticLogit:row.external_logistic_logit}
        )):null;
      const pooledPredictions=item.execution_heads_fitted
        ?selectionRowsWithLogisticContext.map(row=>predictTcnLstmHybridExecutionHeads(
          row.sequence,item.fit,{variant:'POOLED_ONLY'}
        )):null;
      const unavailable={
        schema:'RADARX_TCN_LSTM_SELECTIVE_EXECUTION_POLICY_V2',
        status:'UNAVAILABLE',reason:'EXECUTION_REGRESSION_HEADS_NOT_FITTED',
        selection_partition_only:true,holdout_values_used:false,passed:false
      };
      item.execution_risk_policy=item.execution_heads_fitted
        ?selectTcnLstmExecutionRiskPolicy(selectionRows,contextPredictions,baselineLogits,{
          roundTripCostBps,minimumTrades:minimumReturnTrades,
          minimumWinRatePct:minimumReturnWinRatePct,maximumDrawdownPct:8,
          rankingScoreAdjustmentGrid:[0,0.5,1,2,4],
          minimumPositiveNetReturnProbabilityGrid:[0,0.45,0.50,0.55,0.60]
        }):unavailable;
      item.pooled_only_execution_risk_policy=item.execution_heads_fitted
        ?selectTcnLstmExecutionRiskPolicy(selectionRows,pooledPredictions,baselineLogits,{
          roundTripCostBps,minimumTrades:minimumReturnTrades,
          minimumWinRatePct:minimumReturnWinRatePct,maximumDrawdownPct:8
        }):{...unavailable,reason:'POOLED_ONLY_REFERENCE_HEAD_NOT_FITTED'};
      item.execution_head_context_ablation=summarizeTcnLstmExecutionHeadContextAblation(
        item.pooled_only_execution_risk_policy,item.execution_risk_policy
      );
      item.execution_risk_penalty_weight=finite(item.execution_risk_policy.selected_risk_penalty_weight)
        ?item.execution_risk_policy.selected_risk_penalty_weight:null;
      item.execution_ranking_score_adjustment_weight=
        finite(item.execution_risk_policy.selected_ranking_score_adjustment_weight)
          ?item.execution_risk_policy.selected_ranking_score_adjustment_weight:0;
      if(item.execution_risk_policy.status!=='UNAVAILABLE'&&
        finite(item.execution_risk_policy.selected_risk_penalty_weight)&&
        finite(item.execution_risk_policy.selected_minimum_risk_adjusted_score)){
        item.fit.execution_risk_penalty_weight=item.execution_risk_policy.selected_risk_penalty_weight;
        item.fit.execution_ranking_score_adjustment_weight=
          item.execution_ranking_score_adjustment_weight;
        item.fit.execution_minimum_positive_net_return_probability=
          Number(item.execution_risk_policy.selected_minimum_positive_net_return_probability??0);
        item.fit.execution_return_estimator=item.execution_risk_policy.selected_return_estimator??'POINTWISE_HUBER';
        item.fit.execution_risk_policy=item.execution_risk_policy;
      }
      if(item.pooled_only_execution_risk_policy.status!=='UNAVAILABLE'&&
        finite(item.pooled_only_execution_risk_policy.selected_risk_penalty_weight)&&
        finite(item.pooled_only_execution_risk_policy.selected_minimum_risk_adjusted_score)){
        item.fit.pooled_only_execution_risk_penalty_weight=
          item.pooled_only_execution_risk_policy.selected_risk_penalty_weight;
        item.fit.pooled_only_execution_ranking_score_adjustment_weight=0;
        item.fit.pooled_only_execution_minimum_positive_net_return_probability=
          Number(item.pooled_only_execution_risk_policy.selected_minimum_positive_net_return_probability??0);
        item.fit.pooled_only_execution_return_estimator=
          item.pooled_only_execution_risk_policy.selected_return_estimator??'POINTWISE_HUBER';
        item.fit.pooled_only_execution_risk_policy=item.pooled_only_execution_risk_policy;
      }
      item.return_selection_diagnostics=summarizeTcnLstmSelectionReturns(
        selectionRows,item._selection_probabilities,{
          roundTripCostBps,minimumTrades:minimumReturnTrades,
          minimumWinRatePct:minimumReturnWinRatePct,baselineProbabilities:baselinePredictions
        }
      );
      item.ranking_execution_selection=summarizeTcnLstmRankingExecutionSelection(
        selectionRows,item._selection_ranking_scores,baselineLogits,{
          roundTripCostBps,minimumTrades:minimumReturnTrades,
          minimumWinRatePct:minimumReturnWinRatePct,maximumDrawdownPct:8
        }
      );
      item.ranking_head_selection_qualified=
        item.ranking_execution_selection.status==='EVALUATED'&&
        item.ranking_execution_selection.passed===true;
    }catch(error){
      item.execution_heads_fitted=false;
      item.execution_stage_two_failure=String(error?.message||error);
      item.execution_risk_policy={schema:'RADARX_TCN_LSTM_SELECTIVE_EXECUTION_POLICY_V2',
        status:'UNAVAILABLE',reason:item.execution_stage_two_failure,
        selection_partition_only:true,holdout_values_used:false,passed:false};
      item.pooled_only_execution_risk_policy={...item.execution_risk_policy};
      item.execution_head_context_ablation={schema:'RADARX_TCN_LSTM_EXECUTION_HEAD_CONTEXT_ABLATION_V1',
        status:'UNAVAILABLE',passed:false,reason:item.execution_stage_two_failure,
        holdout_values_used:false};
      item.return_selection_diagnostics={schema:'RADARX_TCN_LSTM_RETURN_DIAGNOSTICS_V1',
        status:'UNAVAILABLE',reason:item.execution_stage_two_failure,
        selection_partition_only:true,holdout_values_used:false};
      item.ranking_execution_selection={schema:'RADARX_TCN_LSTM_RANKING_EXECUTION_SELECTION_V1',
        status:'UNAVAILABLE',passed:false,reason:item.execution_stage_two_failure,
        holdout_values_used:false};
      item.ranking_head_selection_qualified=false;
    }
  }
  const isInnerQualified=item=>
    item.brier_improvement>requiredImprovement&&
    rankingScoreAvailable&&independentRankingSignalPassed(item)&&
    item.execution_heads_fitted===true&&
    item.execution_risk_policy?.status!=='UNAVAILABLE'&&
    item.execution_risk_policy?.passed===true&&
    item.execution_head_context_ablation?.passed===true&&
    item.return_selection_diagnostics?.status==='AVAILABLE'&&
    Number(item.return_selection_diagnostics.preliminary_return_screen_candidates)>0&&
    item.ranking_head_selection_qualified===true;
  const qualifiedCandidates=evaluated.filter(isInnerQualified);
  // When none fully qualifies, retain the best stage-one classifier+ranker
  // candidate for the diagnostic Hurdle artifact; do not fall back to a flat rank head.
  const winner=(qualifiedCandidates.length?qualifiedCandidates:
    stageOneQualified.length?stageOneQualified:evaluated)[0];
  const brierGatePassed=winner.brier_improvement>requiredImprovement;
  const rankingGatePassed=rankingScoreAvailable&&independentRankingSignalPassed(winner);
  const compositeGatePassed=brierGatePassed&&rankingGatePassed;
  const sharedClassifierRankingGateRequired=false;
  const sharedClassifierRankingGatePassed=true;
  const passed=isInnerQualified(winner);
  return {
    schema: TCN_LSTM_HYBRID_SCHEMA,
    status: passed ? 'INNER_SELECTION_QUALIFIED_RESEARCH_ONLY' : 'ABSTAIN_NO_INNER_SELECTION_SUPERIORITY',
    candidate_count_requested:candidates.length,
    candidate_count_evaluated:evaluated.length,
    skipped_candidates:skippedCandidates,
    training_return_pair_support:rankingTrainingPairSupport,
    training_support: trainSupport,
    selection_support: selectionSupport,
    effective_training_budget:effectiveTrainingBudget,
    effective_training_rows:effectiveTrainingRows.length,
    model_training_rows:modelTrainingRows.length,
    execution_head_training_rows:executionHeadRows?.length??0,
    execution_logistic_context:externalLogisticContextMetadata,
    classifier_baseline_source:externalLogisticContextMetadata.classifier_training_baseline_source,
    classifier_selection_baseline_source:innerSelectionBaseline.source,
    classifier_baseline_feature_count:requireExternalLogisticSelectionBaseline
      ?TCN_LSTM_FULL_SEQUENCE_LOGISTIC_FEATURE_COUNT:innerSelectionBaseline.feature_count,
    classifier_baseline_training_logits_used:requireExternalLogisticSelectionBaseline,
    classifier_baseline_training_logits_are_purged_oof:requireExternalLogisticSelectionBaseline,
    classifier_baseline_training_rows:effectiveTrainingRowsForFit.length,
    training_sample_selection:{
      ...trainingSampleSelection.diagnostics,
      execution_head_split:executionHeadSplit.diagnostics
    },
    ranking_training_pair_support:rankingTrainingPairSupport,
    execution_block_ranking_pair_support:{
      source_partition:winner.fit?.training?.return_ranking?.source_partition??null,
      training_rows:winner.fit?.training?.return_ranking?.training_rows??0,
      decision_group_count:winner.fit?.training?.return_ranking?.decision_group_count??0,
      comparison_pairs:winner.fit?.training?.return_ranking?.comparison_pairs??0,
      chronology_valid:winner.fit?.training?.execution_block_ranker?.chronology_valid===true,
      validation_or_holdout_used:false
    },
    baseline: {
      kind:innerSelectionBaseline.source,
      training_rows:innerSelectionBaseline.source==='TUNED_FULL_ORDERED_TEMPORAL_LOGISTIC_696_RAW'
        ?modelTrainingRows.length:anchor.training_rows,
      feature_schema_id:innerSelectionBaseline.feature_schema_id,
      feature_count:innerSelectionBaseline.feature_count,
      probability_stage:innerSelectionBaseline.probability_stage,
      fit_partition:innerSelectionBaseline.fit_partition,
      scoring_partition:innerSelectionBaseline.scoring_partition,
      holdout_values_used:innerSelectionBaseline.holdout_values_used,
      selection_brier:Number(baselineBrier.toFixed(8)),
      pairwise_ranking:baselineRanking,
      selection_score:Number(baselineSelectionScore.toFixed(8))
    },
    training_residual_anchor:{
      kind:anchor.kind,feature_count:BASELINE_FEATURES,
      training_rows:anchor.training_rows,
      role:requireExternalLogisticSelectionBaseline
        ?'POOLED_58D_INTERNAL_REFERENCE_FOR_ABLATION_AND_COMPATIBILITY_ONLY'
        :'TCN_LSTM_RESIDUAL_INITIALIZATION_AND_FIT_OBJECTIVE_ONLY'
    },
    classifier_residual_reference:{
      source:requireExternalLogisticSelectionBaseline
        ?'TUNED_FULL_ORDERED_TEMPORAL_LOGISTIC_696_RAW_OOF_TRAINING_AND_FINAL_REFIT_SELECTION'
        :innerSelectionBaseline.source,
      feature_schema_id:innerSelectionBaseline.feature_schema_id,
      feature_count:innerSelectionBaseline.feature_count,
      probability_stage:innerSelectionBaseline.probability_stage,
      training_logits_used_for_fit:requireExternalLogisticSelectionBaseline,
      training_logits_are_purged_out_of_fold:requireExternalLogisticSelectionBaseline,
      selection_logits_used_for_scoring:true,
      selection_logits_from_final_train_only_refit:true,
      same_logistic_feature_schema_and_objective:true
    },
    selection_scoring:{
      method:rankingRepresentation==='RAW_ORDERED_696_V1'
        ?'INNER_CLASSIFIER_BRIER_PLUS_RAW_ORDERED_696_RETURN_RANKING_V7'
        :'INNER_CLASSIFIER_BRIER_PLUS_INDEPENDENT_MULTISCALE_RETURN_RANKING_V6',
      ranking_representation:rankingRepresentation,
      pair_strategy:rankingPairStrategy,
      score_separation_method:rankingRepresentation==='RAW_ORDERED_696_V1'
        ?'RAW_ORDERED_696_RETURN_RANK_SCORE_NO_SIGMOID_NO_CLASSIFIER_LOGIT_ADDITION_V1'
        :'RAW_INDEPENDENT_MULTISCALE_RETURN_SCORE_NO_SIGMOID_NO_CLASSIFIER_LOGIT_ADDITION_V2',
      pairwise_score_weight:rankingScoreAvailable?rankingScoreWeight:0,
      required_inner_brier_improvement:requiredImprovement,
      required_composite_improvement:requiredImprovement,
      require_pairwise_ranking_improvement:true,
      minimum_pairwise_ranking_accuracy_pct:50,
      require_pairwise_accuracy_above_logistic_anchor:true,
      require_non_degenerate_independent_rank_head:true,
      gate_results:{
        brier_improvement:brierGatePassed?'PASS':'FAIL',
        pairwise_ranking_improvement:rankingGatePassed?'PASS':'FAIL',
        pairwise_ranking_accuracy:rankingGatePassed?'PASS':'FAIL',
        shared_classifier_pairwise_ranking_improvement:'DIAGNOSTIC_ONLY_NOT_USED_AS_RANK_SCORE',
        composite_improvement:compositeGatePassed?'PASS':'FAIL',
        execution_head_context_ablation:
          winner.execution_head_context_ablation?.passed===true?'PASS':'FAIL'
      },
      ranking_uses_inner_selection_partition_only:true,
      outer_validation_or_holdout_used:false
    },
    candidates:evaluated.map(({name,config,ranking_score_method,ranking_score_domain,selection_brier,logistic_selection_brier,
      brier_improvement,pairwise_ranking,logistic_pairwise_ranking,
      pairwise_ranking_improvement,shared_classifier_pairwise_ranking,
      shared_classifier_pairwise_ranking_improvement,
      ranking_execution_selection,execution_risk_policy,
      execution_heads_fitted,return_selection_diagnostics,stage_two_diagnostic_only,
      pooled_only_execution_risk_policy,execution_head_context_ablation,
      execution_risk_penalty_weight,execution_ranking_score_adjustment_weight,
      ranking_head_selection_qualified,selection_score,logistic_selection_score,
      composite_improvement,fit})=>({
      name,config,ranking_score_method,ranking_score_domain,
      stage_two_diagnostic_only:stage_two_diagnostic_only===true,
      selection_brier:Number(selection_brier.toFixed(8)),
      logistic_selection_brier:Number(logistic_selection_brier.toFixed(8)),
      brier_improvement:Number(brier_improvement.toFixed(8)),
      pairwise_ranking,logistic_pairwise_ranking,
      pairwise_ranking_improvement:finite(pairwise_ranking_improvement)
        ?Number(pairwise_ranking_improvement.toFixed(8)):null,
      pairwise_ranking_accuracy_improvement_pct:
        pairwise_ranking?.status==='AVAILABLE'&&logistic_pairwise_ranking?.status==='AVAILABLE'
          ?Number((pairwise_ranking.pairwise_accuracy_pct-
            logistic_pairwise_ranking.pairwise_accuracy_pct).toFixed(4)):null,
      independent_ranking_signal_passed:independentRankingSignalPassed({
        fit,pairwise_ranking,logistic_pairwise_ranking,pairwise_ranking_improvement
      }),
      shared_classifier_pairwise_ranking,
      shared_classifier_pairwise_ranking_improvement:
        finite(shared_classifier_pairwise_ranking_improvement)
          ?Number(shared_classifier_pairwise_ranking_improvement.toFixed(8)):null,
      ranking_execution_selection,
      execution_risk_policy,pooled_only_execution_risk_policy,
      execution_head_context_ablation,
      execution_risk_penalty_weight,
      execution_head_context_ablation_passed:execution_head_context_ablation?.passed===true,
      ranking_head_selection_qualified,
      ranking_head:fit.training?.return_ranking?.ranking_head??null,
      independent_ranker_fit_mode:
        fit.training?.return_ranking?.independent_ranker_fit_mode??null,
      shared_classifier_training:fit.training?.shared_classifier_loss??null,
      selection_score:Number(selection_score.toFixed(8)),
      logistic_selection_score:Number(logistic_selection_score.toFixed(8)),
      composite_improvement:Number(composite_improvement.toFixed(8)),
      improvement:Number(composite_improvement.toFixed(8)),
      passed_inner_brier_margin:brier_improvement>requiredImprovement,
      passed_inner_pairwise_ranking_gate:independentRankingSignalPassed({
        fit,pairwise_ranking,logistic_pairwise_ranking,pairwise_ranking_improvement
      }),
      passed_inner_shared_classifier_ranking_gate:null,
      shared_classifier_pairwise_ranking_is_diagnostic_only:true,
      passed_inner_composite_margin:brier_improvement>requiredImprovement&&
        independentRankingSignalPassed({
          fit,pairwise_ranking,logistic_pairwise_ranking,pairwise_ranking_improvement
        }),
      passed_inner_margin:brier_improvement>requiredImprovement&&
        independentRankingSignalPassed({
          fit,pairwise_ranking,logistic_pairwise_ranking,pairwise_ranking_improvement
        })&&
        execution_heads_fitted===true&&execution_risk_policy?.passed===true&&
        execution_head_context_ablation?.passed===true&&
        return_selection_diagnostics?.status==='AVAILABLE'&&
        Number(return_selection_diagnostics?.preliminary_return_screen_candidates)>0&&
        ranking_head_selection_qualified===true,
      return_selection_diagnostics
    })),
    execution_head_context_ablation_qualification:{
      qualified:winner.execution_head_context_ablation?.passed===true,
      status:winner.execution_head_context_ablation?.status??'UNAVAILABLE',
      reason:winner.execution_head_context_ablation?.reason??null,
      result:winner.execution_head_context_ablation??null,
      source_partition:'INNER_SELECTION_ONLY',holdout_values_used:false
    },
    ranking_head_selection_qualification:{
      qualified:winner.ranking_head_selection_qualified===true,
      status:winner.ranking_execution_selection?.status??'UNAVAILABLE',
      reason:winner.ranking_execution_selection?.reason??null,
      source_partition:'INNER_SELECTION_ONLY',
      holdout_values_used:false
    },
    selected_configuration: passed ? winner.name : null,
    diagnostic_configuration: passed ? null : winner.name,
    required_inner_improvement: requiredImprovement,
    selected_fit: passed ? winner.fit : null,
    // Preserve the best inner-selection challenger for research-only outer
    // scoring when it misses the qualification margin. The caller must keep
    // inner qualification false; this state can never become production-ready
    // merely because its later validation/holdout metrics look favorable.
    diagnostic_fit: passed ? null : winner.fit,
    validation_or_holdout_used_for_fit_or_selection: false,
    probability_ready: false,
    live_eligibility_ready: false,
    real_order_execution: false
  };
}


function meanBrier(rows, profile) {
  if (!rows.length) return null;
  return rows.reduce((sum, row) =>
    sum + (predictTcnLstmHybridProbability(row.sequence, profile) - row.target) ** 2, 0
  ) / rows.length;
}

function pairedBlockBootstrap(rows, profile, iterations = 400, seed = 1771) {
  const buckets = new Map();
  for (const row of rows) {
    const key = Math.floor(row.at / (5 * DAY_MS));
    if (!buckets.has(key)) buckets.set(key, []);
    const probability = predictTcnLstmHybridProbability(row.sequence, profile);
    const baseline = sigmoid(predictTcnLstmLogisticLogit(row.sequence, profile.baseline_fit));
    buckets.get(key).push({
      model: (probability - row.target) ** 2,
      baseline: (baseline - row.target) ** 2
    });
  }
  const blocks = [...buckets.values()];
  if (blocks.length < 10)
    return { evaluated:false, reason:'FEWER_THAN_10_FIVE_DAY_BLOCKS', block_count:blocks.length };
  const random = mulberry32(seed);
  const improvements = [];
  for (let sample = 0; sample < iterations; sample++) {
    let modelLoss = 0, baselineLoss = 0, count = 0;
    for (let block = 0; block < blocks.length; block++) {
      const chosen = blocks[Math.floor(random() * blocks.length)];
      for (const row of chosen) {
        modelLoss += row.model;
        baselineLoss += row.baseline;
        count++;
      }
    }
    if (count) improvements.push((baselineLoss - modelLoss) / count);
  }
  improvements.sort((a,b)=>a-b);
  const quantile = fraction => improvements[Math.min(
    improvements.length - 1, Math.floor((improvements.length - 1) * fraction)
  )];
  return {
    evaluated:true,
    block_count:blocks.length,
    iterations:improvements.length,
    block_length_days:5,
    improvement_ci95_low:quantile(0.025),
    improvement_ci95_high:quantile(0.975)
  };
}

/**
 * Same-cohort outer evaluation for the TCN-LSTM candidate. Time boundaries are
 * based on unique UTC days, and every 24h label is purged before the next block.
 * The selection block alone chooses the LR/L2 configuration. Validation and
 * untouched holdout are used only once for evaluation; neither updates weights.
 */
export function benchmarkTcnLstmHybridChronological(inputRows, {
  requiredInnerImprovement = 0.00025,
  requiredOuterImprovement = 0.003,
  outcomeHorizonMs = DAY_MS,
  requiredTargetDefinition = null,
  requiredOutcomeSource = null,
  maxTrainingSamples = TCN_LSTM_MAX_TRAINING_SAMPLES,
  bootstrapIterations = 400,
  seed = 29,
  candidates = [
    { name:'LR_0015_L2_0005_DROP00', learningRate:0.0015, l2:0.0005, dropout:0, epochs:6 },
    { name:'LR_0025_L2_0015_DROP10', learningRate:0.0025, l2:0.0015, dropout:0.10, epochs:6 },
    { name:'LR_0035_L2_0035_DROP20', learningRate:0.0035, l2:0.0035, dropout:0.20, epochs:6 }
  ]
} = {}) {
  const waiting = (status, reason, extra = {}) => ({
    schema:TCN_LSTM_HYBRID_SCHEMA,status,evaluated:false,reason,
    probability_ready:false,live_eligibility_ready:false,real_order_execution:false,
    ...extra
  });
  if (!Array.isArray(inputRows) || inputRows.length === 0)
    return waiting('WAITING_FOR_TEMPORAL_SEQUENCE_SUPPORT',
      'TEMPORAL_SEQUENCE_SUPPORT_TOO_SMALL', { input_samples:0 });
  inputRows.forEach((row,index)=>validateRow(row,index,false));
  const identities = inputRows.map(sampleIdentity);
  if (new Set(identities).size !== identities.length)
    throw new TypeError('TCN_LSTM_DUPLICATE_INPUT_IDENTITY');
  const rows = [...inputRows].sort((a,b)=>a.at-b.at||
    String(a.symbol||'').localeCompare(String(b.symbol||''))||
    sampleIdentity(a).localeCompare(sampleIdentity(b)));
  if (outcomeHorizonMs !== DAY_MS ||
      rows.some(row=>row.horizon_ms !== undefined && Number(row.horizon_ms) !== DAY_MS))
    return waiting('TARGET_CONTRACT_OR_HORIZON_REJECTED',
      'TCN_LSTM_REQUIRES_24H_LABEL_CONTRACT',{input_samples:rows.length,outcome_horizon_ms:outcomeHorizonMs});
  const targetDefinitions=new Set(rows.map(row=>row.target_definition).filter(Boolean));
  const outcomeSources=new Set(rows.map(row=>row.outcome_source).filter(Boolean));
  if ((targetDefinitions.size>1)||(outcomeSources.size>1)||
      (requiredTargetDefinition!==null&&[...targetDefinitions].some(value=>value!==requiredTargetDefinition))||
      (requiredOutcomeSource!==null&&[...outcomeSources].some(value=>value!==requiredOutcomeSource)))
    return waiting('TARGET_CONTRACT_OR_HORIZON_REJECTED',
      'TCN_LSTM_TARGET_DEFINITION_OR_SOURCE_MISMATCH',{
        target_definitions:[...targetDefinitions],outcome_sources:[...outcomeSources],
        required_target_definition:requiredTargetDefinition,required_outcome_source:requiredOutcomeSource
      });
  const days = [...new Set(rows.map(row=>Math.floor(row.at/DAY_MS)*DAY_MS))]
    .sort((a,b)=>a-b);
  if (days.length < 60)
    return waiting('WAITING_FOR_UNIQUE_UTC_DAY_SUPPORT','FEWER_THAN_60_UNIQUE_UTC_DAYS',{
      input_samples:rows.length,unique_utc_days:days.length
    });
  if (rows.length < 120)
    return waiting('WAITING_FOR_TEMPORAL_SEQUENCE_SUPPORT',
      'TEMPORAL_SEQUENCE_SUPPORT_TOO_SMALL',{
        input_samples:rows.length,unique_utc_days:days.length
      });

  // Reserve chronological train / selection / calibration / validation / holdout
  // blocks. A full 24h maturity purge separates every adjacent partition.
  const day1=days[Math.floor(days.length*0.50)];
  const day2=days[Math.floor(days.length*0.62)];
  const day3=days[Math.floor(days.length*0.74)];
  const day4=days[Math.floor(days.length*0.87)];
  const train=rows.filter(row=>row.at<day1-DAY_MS);
  const selection=rows.filter(row=>row.at>=day1+DAY_MS&&row.at<day2-DAY_MS);
  const calibration=rows.filter(row=>row.at>=day2+DAY_MS&&row.at<day3-DAY_MS);
  const validation=rows.filter(row=>row.at>=day3+DAY_MS&&row.at<day4-DAY_MS);
  const holdout=rows.filter(row=>row.at>=day4+DAY_MS);
  const partitions=[
    ['training',train],['selection',selection],['calibration',calibration],
    ['validation',validation],['holdout',holdout]
  ];
  // Structural partition checks must not inspect outcome labels. In particular,
  // the untouched holdout's classes remain unread until external validation passes.
  const partitionSupport=Object.fromEntries(partitions.map(([name,part])=>[name,{
    rows:part.length,
    first_at:part[0]?.at??null,last_at:part.at(-1)?.at??null
  }]));
  const unsupported=partitions.filter(([,part])=>part.length<20)
    .map(([name])=>name);
  const boundaryPairs=[
    ['training','selection'],['selection','calibration'],
    ['calibration','validation'],['validation','holdout']
  ];
  const purgeViolations=boundaryPairs.filter(([left,right])=>{
    const previous=partitions.find(([name])=>name===left)[1];
    const next=partitions.find(([name])=>name===right)[1];
    if(!previous.length||!next.length)return true;
    return Math.max(...previous.map(row=>row.resolved_at))>=
      Math.min(...next.map(row=>row.at));
  });
  const ids=partitions.map(([,part])=>new Set(part.map(sampleIdentity)));
  const overlaps=[];
  for(let left=0;left<ids.length;left++){
    for(let right=left+1;right<ids.length;right++){
      if([...ids[left]].some(id=>ids[right].has(id)))
        overlaps.push([partitions[left][0],partitions[right][0]]);
    }
  }
  const base={
    schema:TCN_LSTM_HYBRID_SCHEMA,
    architecture:'CAUSAL_DILATED_TCN_UNIDIRECTIONAL_LSTM_SINGLE_HEAD_TEMPORAL_ATTENTION_V1',
    input_samples:rows.length,unique_utc_days:days.length,
    target_definition:requiredTargetDefinition??[...targetDefinitions][0]??null,
    outcome_source:requiredOutcomeSource??[...outcomeSources][0]??null,
    outcome_horizon_ms:outcomeHorizonMs,
    split_boundaries:{
      selection_after_utc:new Date(day1+DAY_MS).toISOString(),
      calibration_after_utc:new Date(day2+DAY_MS).toISOString(),
      validation_after_utc:new Date(day3+DAY_MS).toISOString(),
      holdout_after_utc:new Date(day4+DAY_MS).toISOString()
    },
    partition_support:partitionSupport,
    purged_rows:rows.length-partitions.reduce((sum,[,part])=>sum+part.length,0),
    purge_violations:purgeViolations,
    unsupported_partitions:unsupported,
    cross_partition_identity_overlaps:overlaps,
    same_window_comparator:'FROZEN_LOGISTIC_FIT_ON_IDENTICAL_TRAINING_ROWS',
    required_inner_improvement:requiredInnerImprovement,
    required_outer_improvement:requiredOuterImprovement,
    probability_ready:false,live_eligibility_ready:false,real_order_execution:false
  };
  if(unsupported.length||purgeViolations.length||overlaps.length)
    return {
      ...base,status:'CHRONOLOGY_OR_CLASS_SUPPORT_REJECTED',evaluated:false,
      reason:'PARTITION_SUPPORT_PURGE_OR_IDENTITY_GATE_FAILED'
    };
  if(rows.some(row=>row.resolved_at-row.at!==DAY_MS))
    return {
      ...base,status:'TARGET_CONTRACT_OR_HORIZON_REJECTED',evaluated:false,
      reason:'TCN_LSTM_REQUIRES_MATURED_24H_LABELS'
    };

  const evaluation=evaluateTcnLstmHybridGeneralization({
    trainingRows:train,selectionRows:selection,calibrationRows:calibration,
    validationRows:validation,holdoutRows:holdout,
    candidates,requiredInnerImprovement,requiredOuterImprovement,
    maxTrainingSamples,bootstrapIterations,seed
  });
  const selectedFit=evaluation.selection?.selected_fit??null;
  const modelCalibrator=evaluation.calibration?.model??null;
  const inferenceLatency=selectedFit&&modelCalibrator?.fitted===true
    ?{
      evaluated:true,
      ...benchmarkTcnLstmHybridInference(rows[0].sequence,selectedFit,{
        warmup:20,iterations:200,modelCalibrator
      })
    }
    :{
      evaluated:false,
      reason:!selectedFit?'NO_SELECTED_FIT_AFTER_INNER_SELECTION_GATE':
        'CALIBRATION_NOT_FITTED',
      production_latency_claim:false
    };
  return {
    ...base,
    status:evaluation.status,
    evaluated:true,
    inference_latency:inferenceLatency,
    zero_latency_claim:false,
    trained:Boolean(selectedFit),
    selected_for_research:evaluation.validated_for_research===true,
    inner_selection_diagnostics:evaluation.selection,
    calibration:evaluation.calibration,
    validation:evaluation.validation,
    holdout:evaluation.holdout,
    holdout_passed:evaluation.holdout_passed===true,
    partition_summary:evaluation.partition_summary,
    trained_model:evaluation.selection?.selected_fit??null,
    probability_ready:false,live_eligibility_ready:false,real_order_execution:false
  };
}

function validateChronologicalPartitions(partitions) {
  const names = ['training', 'selection', 'calibration', 'validation', 'holdout'];
  const seen = new Set();
  const summary = {};
  for (let index = 0; index < names.length; index++) {
    const name = names[index], rows = partitions[index];
    if (!Array.isArray(rows) || rows.length === 0)
      throw new TypeError('TCN_LSTM_PARTITION_EMPTY:' + name);
    // Validate input tensors and timestamps without reading binary labels.
    // The holdout's target field is intentionally unopened at this stage.
    rows.forEach((row,rowIndex)=>validateRow(row,rowIndex,false));
    const identities = rows.map(sampleIdentity);
    for (const identity of identities) {
      if (seen.has(identity))
        throw new TypeError('TCN_LSTM_CROSS_PARTITION_IDENTITY_OVERLAP:' + identity);
      seen.add(identity);
    }
    const at = rows.map(row => row.at), resolved = rows.map(row => row.resolved_at);
    if (at.some(value => !finite(value) || value <= 0) ||
        resolved.some((value, rowIndex) => !finite(value) || value <= at[rowIndex]))
      throw new TypeError('TCN_LSTM_PARTITION_EVENT_OR_MATURITY_TIME_INVALID:' + name);
    const firstAt = Math.min(...at), lastAt = Math.max(...at);
    const latestResolved = Math.max(...resolved);
    summary[name] = {
      rows: rows.length,
      first_at: firstAt,
      last_at: lastAt,
      latest_resolved_at: latestResolved
    };
    if (index > 0) {
      const previous = partitions[index - 1];
      const previousResolved = Math.max(...previous.map(row => row.resolved_at));
      if (!(previousResolved < firstAt))
        throw new TypeError('TCN_LSTM_CHRONOLOGICAL_PURGE_VIOLATION:' + name);
    }
  }
  return summary;
}

function fitPlattCalibration(rows, predictor, {
  minimumSamples = 30, minimumPositive = 8, minimumNegative = 8,
  iterations = 500, learningRate = 0.03, regularization = 0.05
} = {}) {
  const positive = rows.filter(row => row.target === 1).length;
  const negative = rows.length - positive;
  if (rows.length < minimumSamples || positive < minimumPositive || negative < minimumNegative)
    return {
      fitted: false, reason: 'TCN_LSTM_CALIBRATION_SUPPORT_BELOW_MINIMUM',
      samples: rows.length, positive, negative,
      slope: 1, intercept: 0
    };
  const logits = rows.map(row => {
    const probability = predictor(row.sequence);
    if (!finite(probability) || probability < 0 || probability > 1)
      throw new TypeError('TCN_LSTM_CALIBRATION_RAW_PROBABILITY_INVALID');
    const bounded = clamp(probability, 1e-8, 1 - 1e-8);
    return clamp(Math.log(bounded / (1 - bounded)), -LOGIT_LIMIT, LOGIT_LIMIT);
  });
  const slopePenalty = clamp(regularization, 0.001, 2);
  const interceptPenalty = slopePenalty * 0.25;
  let slope = 1, intercept = 0;
  const steps = Math.max(100, Math.min(2000, Math.trunc(iterations)));
  const rate = clamp(learningRate, 0.001, 0.15);
  let bestLoss = Infinity, best = { slope, intercept };
  let wait = 0;
  for (let step = 0; step < steps; step++) {
    let loss = 0, gradSlope = 0, gradIntercept = 0;
    for (let index = 0; index < rows.length; index++) {
      const target = rows[index].target;
      const probability = sigmoid(slope * logits[index] + intercept);
      const error = probability - target;
      loss += -(target * Math.log(Math.max(1e-12, probability)) +
        (1 - target) * Math.log(Math.max(1e-12, 1 - probability)));
      gradSlope += error * logits[index];
      gradIntercept += error;
    }
    loss = loss / rows.length + slopePenalty * (slope - 1) ** 2 +
      interceptPenalty * intercept * intercept;
    gradSlope = gradSlope / rows.length + 2 * slopePenalty * (slope - 1);
    gradIntercept = gradIntercept / rows.length + 2 * interceptPenalty * intercept;
    if (![loss, gradSlope, gradIntercept].every(finite))
      throw new TypeError('TCN_LSTM_CALIBRATION_NON_FINITE_OBJECTIVE');
    if (loss < bestLoss - 1e-10) {
      bestLoss = loss;
      best = { slope, intercept };
      wait = 0;
    } else wait++;
    const decay = 0.15 + 0.85 * 0.5 * (1 + Math.cos(Math.PI * step / Math.max(1, steps - 1)));
    slope = clamp(slope - rate * decay * gradSlope, 0.05, 8);
    intercept = clamp(intercept - rate * decay * gradIntercept, -8, 8);
    if (wait >= 80) break;
  }
  if (![best.slope, best.intercept, bestLoss].every(finite))
    throw new TypeError('TCN_LSTM_CALIBRATION_BEST_STATE_INVALID');
  return {
    fitted: true, method: 'CALIBRATION_BLOCK_REGULARIZED_PLATT_LOGISTIC_NLL_V1',
    fit_boundary: 'CALIBRATION_PARTITION_ONLY',
    samples: rows.length, positive, negative,
    slope: best.slope, intercept: best.intercept,
    objective: bestLoss, iterations: steps,
    raw_logits_clipped: true,
    slope_bounds: [0.05, 8], intercept_bounds: [-8, 8]
  };
}

/**
 * Fit a probability calibrator on an explicitly supplied calibration-only
 * partition. The caller owns and must verify the chronology/purge boundary.
 * This wrapper exposes the existing implementation without exposing mutable
 * model internals or allowing validation/holdout labels into the fit.
 */
export function fitTcnLstmHybridCalibration(rows,predictor,options={}){
  if(!Array.isArray(rows)||typeof predictor!=='function')
    throw new TypeError('TCN_LSTM_CALIBRATION_ROWS_AND_PREDICTOR_REQUIRED');
  return fitPlattCalibration(rows,predictor,options);
}

function applyPlattCalibration(probability, calibrator) {
  if (!calibrator?.fitted) return null;
  if (!finite(probability) || probability < 0 || probability > 1 ||
      !finite(calibrator.slope) || !finite(calibrator.intercept))
    throw new TypeError('TCN_LSTM_CALIBRATED_PROBABILITY_INVALID');
  const bounded = clamp(probability, 1e-8, 1 - 1e-8);
  const logit = Math.log(bounded / (1 - bounded));
  return sigmoid(clamp(calibrator.slope * logit + calibrator.intercept, -LOGIT_LIMIT, LOGIT_LIMIT));
}

export function predictTcnLstmHybridCalibratedProbability(sequence, profile, calibrator,options={}) {
  if (!calibrator?.fitted)
    throw new TypeError('TCN_LSTM_INFERENCE_CALIBRATOR_NOT_FITTED');
  const raw = predictTcnLstmHybridProbability(sequence, profile,options);
  const calibrated = applyPlattCalibration(raw, calibrator);
  if (!finite(calibrated) || calibrated < 0 || calibrated > 1)
    throw new TypeError('TCN_LSTM_CALIBRATED_INFERENCE_NON_FINITE');
  return calibrated;
}

function probabilityMetrics(rows, predictions) {
  if (predictions.length !== rows.length || !predictions.length ||
      predictions.some(value => !finite(value) || value < 0 || value > 1))
    throw new TypeError('TCN_LSTM_OOS_PREDICTION_VECTOR_INVALID');
  let brier = 0, logLoss = 0, riskBrier = 0, falseHigh = 0, negatives = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (let index = 0; index < rows.length; index++) {
    const target = rows[index].target;
    const probability = clamp(predictions[index], 1e-9, 1 - 1e-9);
    const error = (probability - target) ** 2;
    brier += error;
    logLoss += -(target * Math.log(probability) + (1 - target) * Math.log(1 - probability));
    const falseConfidence = target === 0 && probability >= 0.70;
    riskBrier += error * (falseConfidence ? 3 : 1);
    if (target === 0) {
      negatives++;
      if (probability >= 0.80) falseHigh++;
    }
    const bin = bins[Math.min(9, Math.floor(probability * 10))];
    bin.n++; bin.p += probability; bin.y += target;
  }
  const count = rows.length;
  const ece = bins.reduce((sum, bin) => sum +
    (bin.n / count) * (bin.n ? Math.abs(bin.p / bin.n - bin.y / bin.n) : 0), 0);
  return {
    rows: count,
    positives: rows.filter(row => row.target === 1).length,
    negatives,
    brier: brier / count,
    log_loss: logLoss / count,
    expected_calibration_error: ece,
    asymmetric_risk_brier: riskBrier / count,
    false_high_confidence_rate_pct: negatives ? falseHigh / negatives * 100 : null
  };
}

function pairedFiveDayClusterBootstrap(rows, modelProbabilities, baselineProbabilities, {
  iterations = 500, seed = 73
} = {}) {
  const groups = new Map();
  for (let index = 0; index < rows.length; index++) {
    const bucket = Math.floor(rows[index].at / (5 * 86400000));
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(
      (baselineProbabilities[index] - rows[index].target) ** 2 -
      (modelProbabilities[index] - rows[index].target) ** 2
    );
  }
  const clusters = [...groups.values()];
  if (clusters.length < 10)
    return {
      evaluated: false, reason: 'FEWER_THAN_10_FIVE_UTC_DAY_CLUSTERS',
      clusters: clusters.length, iterations: 0,
      improvement_ci95_low: null, improvement_ci95_high: null
    };
  const random = mulberry32(seed);
  const improvements = [];
  const count = Math.max(200, Math.min(5000, Math.trunc(iterations)));
  for (let replicate = 0; replicate < count; replicate++) {
    let total = 0, rowsCount = 0;
    for (let draw = 0; draw < clusters.length; draw++) {
      const selected = clusters[Math.floor(random() * clusters.length)];
      for (const value of selected) { total += value; rowsCount++; }
    }
    if (rowsCount) improvements.push(total / rowsCount);
  }
  improvements.sort((a, b) => a - b);
  const quantile = fraction => improvements[Math.min(
    improvements.length - 1,
    Math.floor((improvements.length - 1) * fraction)
  )];
  return {
    evaluated: true, method: 'PAIRED_FIVE_UTC_DAY_CLUSTER_BOOTSTRAP_V1',
    clusters: clusters.length, iterations: improvements.length,
    block_length_days: 5,
    improvement_ci95_low: quantile(0.025),
    improvement_ci95_high: quantile(0.975)
  };
}

function evaluateCalibratedSplit(rows, selectedFit, modelCalibrator, baselineCalibrator, {
  bootstrapSeed = 73, bootstrapIterations = 500, requiredImprovement = 0.003,
  minimumSamples = 30, minimumPositive = 8, minimumNegative = 8
} = {}) {
  // Called for holdout only after external validation passes. Class-support
  // inspection therefore does not unseal the final partition early.
  const positive = rows.filter(row => row.target === 1).length;
  const negative = rows.length - positive;
  if (rows.length < minimumSamples || positive < minimumPositive || negative < minimumNegative)
    return {
      evaluated:false,sample_count:rows.length,positive_samples:positive,negative_samples:negative,
      passed:false,required_brier_improvement:requiredImprovement,
      reason:'TCN_LSTM_OOS_CLASS_SUPPORT_BELOW_MINIMUM'
    };
  const rawModel = rows.map(row => predictTcnLstmHybridProbability(row.sequence, selectedFit));
  const rawBaseline = rows.map(row =>
    sigmoid(predictTcnLstmLogisticLogit(row.sequence, selectedFit.baseline_fit)));
  const modelPredictions = rawModel.map(value => applyPlattCalibration(value, modelCalibrator));
  const baselinePredictions = rawBaseline.map(value => applyPlattCalibration(value, baselineCalibrator));
  if (modelPredictions.some(value => value === null) ||
      baselinePredictions.some(value => value === null))
    throw new TypeError('TCN_LSTM_OOS_CALIBRATOR_NOT_FITTED');
  const model = probabilityMetrics(rows, modelPredictions);
  const baseline = probabilityMetrics(rows, baselinePredictions);
  const improvement = baseline.brier - model.brier;
  const confidence = pairedFiveDayClusterBootstrap(rows, modelPredictions, baselinePredictions, {
    iterations: bootstrapIterations, seed: bootstrapSeed
  });
  return {
    evaluated:true,sample_count:rows.length,
    model, baseline,
    brier_improvement: improvement,
    paired_bootstrap_95ci: confidence,
    required_brier_improvement: requiredImprovement,
    passed: improvement > requiredImprovement &&
      confidence.evaluated === true && confidence.improvement_ci95_low > 0 &&
      model.asymmetric_risk_brier <= baseline.asymmetric_risk_brier + 1e-10
  };
}

/**
 * Full, purged five-partition evaluation:
 * training -> inner selection -> calibration -> external validation -> untouched holdout.
 * Holdout is not opened unless the external validation gate passes.
 */
export function evaluateTcnLstmHybridGeneralization({
  trainingRows = [], selectionRows = [], calibrationRows = [],
  validationRows = [], holdoutRows = [],
  candidates, requiredInnerImprovement = 0.00025, requiredOuterImprovement = 0.003,
  maxTrainingSamples = TCN_LSTM_MAX_TRAINING_SAMPLES, bootstrapIterations = 500, seed = 29
} = {}) {
  const partitionSummary = validateChronologicalPartitions([
    trainingRows, selectionRows, calibrationRows, validationRows, holdoutRows
  ]);
  const selection = selectTcnLstmHybridHyperparameters(trainingRows, selectionRows, {
    candidates, requiredImprovement: requiredInnerImprovement,
    seed, maxTrainingSamples
  });
  const base = {
    schema: TCN_LSTM_HYBRID_SCHEMA,
    architecture: 'CAUSAL_DILATED_TCN_UNIDIRECTIONAL_LSTM_SINGLE_HEAD_TEMPORAL_ATTENTION_V1',
    partition_summary: partitionSummary,
    selection,
    calibration: { fitted: false },
    validation: { evaluated: false },
    holdout: { evaluated: false, status:'LOCKED', reason: 'HOLDOUT_LOCKED_PENDING_EXPLICIT_FINAL_PROTOCOL_AUTHORIZATION' },
    validated_for_research: false,
    holdout_passed: false,
    probability_ready: false,
    live_eligibility_ready: false,
    real_order_execution: false
  };
  if (selection.status !== 'INNER_SELECTION_QUALIFIED_RESEARCH_ONLY' || !selection.selected_fit)
    return { ...base, status: 'ABSTAIN_INNER_SELECTION_GATE_FAILED' };

  const selectedFit = selection.selected_fit;
  const modelPredictor = sequence => predictTcnLstmHybridProbability(sequence, selectedFit);
  const baselinePredictor = sequence =>
    sigmoid(predictTcnLstmLogisticLogit(sequence, selectedFit.baseline_fit));
  const modelCalibrator = fitPlattCalibration(calibrationRows, modelPredictor);
  const baselineCalibrator = fitPlattCalibration(calibrationRows, baselinePredictor);
  const calibrationPassed = modelCalibrator.fitted && baselineCalibrator.fitted;
  if (!calibrationPassed)
    return {
      ...base, status: 'ABSTAIN_CALIBRATION_SUPPORT_FAILED',
      calibration: { model: modelCalibrator, baseline: baselineCalibrator }
    };

  const validation = evaluateCalibratedSplit(
    validationRows, selectedFit, modelCalibrator, baselineCalibrator,
    { bootstrapSeed: seed + 101, bootstrapIterations, requiredImprovement:requiredOuterImprovement }
  );
  const validationPassed = validation.passed;
  if (!validationPassed)
    return {
      ...base,
      status: 'VALIDATION_NOT_PASSED_HOLDOUT_REMAINS_LOCKED',
      calibration: { model: modelCalibrator, baseline: baselineCalibrator },
      validation
    };

  // External validation is the final scored partition in this research
  // round. The holdout remains sealed even when validation passes; a separate
  // explicit final-authorization procedure is required before any holdout read.
  const holdout={
    evaluated:false,status:'LOCKED',
    reason:'HOLDOUT_LOCKED_PENDING_EXPLICIT_FINAL_PROTOCOL_AUTHORIZATION',
    labels_read:false,predictions_generated:false,metrics_read:false
  };
  return {
    ...base,
    status:'VALIDATION_PASSED_HOLDOUT_STILL_LOCKED',
    calibration: {
      model: modelCalibrator, baseline: baselineCalibrator,
      fit_boundary: 'CALIBRATION_PARTITION_ONLY'
    },
    validation,
    holdout,
    validated_for_research:false,
    holdout_passed:false,
    probability_ready: false,
    live_eligibility_ready: false,
    real_order_execution: false
  };
}

export function benchmarkTcnLstmHybridInference(sequence, profile, {
  warmup = 10, iterations = 100, modelCalibrator = null
} = {}) {
  if (!Number.isSafeInteger(warmup) || warmup < 0 ||
      !Number.isSafeInteger(iterations) || iterations < 10 || iterations > 10000)
    throw new TypeError('TCN_LSTM_INFERENCE_BENCHMARK_CONFIGURATION_INVALID');
  if (modelCalibrator !== null && !modelCalibrator?.fitted)
    throw new TypeError('TCN_LSTM_INFERENCE_CALIBRATOR_NOT_FITTED');
  const predict = modelCalibrator
    ?()=>predictTcnLstmHybridCalibratedProbability(sequence,profile,modelCalibrator)
    :()=>predictTcnLstmHybridProbability(sequence,profile);
  for (let index = 0; index < warmup; index++) predict();
  const durations = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    predict();
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  const quantile = fraction => durations[Math.min(
    durations.length - 1, Math.floor((durations.length - 1) * fraction)
  )];
  return {
    iterations, warmup,
    p50_ms: Number(quantile(0.50).toFixed(6)),
    p95_ms: Number(quantile(0.95).toFixed(6)),
    max_ms: Number(durations.at(-1).toFixed(6)),
    calibrated:modelCalibrator?.fitted===true,
    measured_path:modelCalibrator?.fitted===true
      ?'TCN_LSTM_FORWARD_PLUS_FROZEN_LOGISTIC_ANCHOR_PLUS_PLATT_CALIBRATION'
      :'RAW_TCN_LSTM_FORWARD_PLUS_FROZEN_LOGISTIC_ANCHOR',
    measurement: 'LOCAL_SINGLE_PROCESS_SYNCHRONOUS_WALL_CLOCK',
    production_latency_claim: false
  };
}

export function createTcnLstmHybridModelForAudit(seed = 29) {
  return initializeModel(seed);
}
