import { createHash } from 'node:crypto';
import {
  focalAsymmetricBrierLoss,deriveTrainingClassWeights,
  topKProbabilitySignals,simulateFirstTouchPaperPortfolio,
  NEURAL_CLOSURE_PORTFOLIO_POLICY
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

export const TCN_LSTM_HYBRID_SCHEMA = 'RADARX_BUILD224_TCN_LSTM_ATTENTION_V1';
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
export const TCN_LSTM_RANKING_HEAD_PARAMETER_COUNT = TCN_LSTM_HIDDEN;
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
export const TCN_LSTM_MAX_TRAINING_SAMPLES = 4096;
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
    outputWeights: Array.from({ length: hidden }, () => (random() - 0.5) * 0.04),
    // Trainable scalars are one-element arrays so optimizer/finite-difference
    // updates mutate the model object rather than a detached wrapper property.
    outputBias: [0],
    // Auxiliary rank head is separate from calibrated classification.
    rankingHeadWeights: Array(hidden).fill(0),
    executionReturnHeadWeights:Array(hidden).fill(0),executionReturnHeadBias:0,
    executionRiskHeadWeights:Array(hidden).fill(0),executionRiskHeadBias:0
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
    ? Array(hidden).fill(0) : model.rankingHeadWeights;
  if (!Array.isArray(rankingWeights) || rankingWeights.length !== hidden ||
      rankingWeights.some(value => !finite(value)))
    throw new TypeError('TCN_LSTM_RANKING_HEAD_WEIGHTS_INVALID');
  let rankingResidualLogit = 0;
  for (let channel = 0; channel < hidden; channel++)
    rankingResidualLogit += rankingWeights[channel] * pooled[channel];
  const rankingLogit = clamp(baselineLogit + rankingResidualLogit, -LOGIT_LIMIT, LOGIT_LIMIT);
  if (![...pooled, ...attentionWeights, probability, logit, rankingLogit].every(finite))
    throw new TypeError('TCN_LSTM_FORWARD_NON_FINITE');
  return {
    probability, logit, ranking_logit: rankingLogit,
    ranking_residual_logit: rankingResidualLogit, residual_logit: residualLogit,
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
    const baselineLogit = predictTcnLstmLogisticLogit(row.sequence, anchor);
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
    low_logit_gradient:error,correct:margin>0};
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
  roundTripCostBps=30,minimumReturnGapPct=0.50,maxPairsPerTimestamp=4
}={}) {
  if(!Array.isArray(trainingRows)||!Array.isArray(rankingRows)||
    trainingRows.length!==rankingRows.length||trainingRows.length<20)
    throw new TypeError('TCN_LSTM_RANKING_ROWS_IDENTITY_REQUIRED');
  if(!finite(roundTripCostBps)||roundTripCostBps<0||roundTripCostBps>300||
    !finite(minimumReturnGapPct)||minimumReturnGapPct<0||
    !Number.isInteger(maxPairsPerTimestamp)||maxPairsPerTimestamp<1||maxPairsPerTimestamp>32)
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
  for(const [at,items] of groups){
    if(items.length<2)continue;
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
    for(let i=0;i<count;i++)pairs.push(candidates[Math.floor((i+0.5)*candidates.length/count)]);
  }
  return {schema:'RADARX_TCN_LSTM_TRAINING_RETURN_RANK_PAIRS_V1',
    source_partition:'TRAINING_PARTITION_ONLY',round_trip_cost_bps:Number(roundTripCostBps),
    minimum_return_gap_pct:Number(minimumReturnGapPct),
    maximum_pairs_per_timestamp:maxPairsPerTimestamp,
    decision_group_count:groups.size,comparison_pairs:pairs.length,pairs};
}
export function summarizeTcnLstmPairwiseReturnRanking(rows,probabilities,{
  roundTripCostBps=30,minimumReturnGapPct=0.50,maxPairsPerTimestamp=4
}={}) {
  const unavailable=reason=>({schema:'RADARX_TCN_LSTM_PAIRWISE_RANKING_METRICS_V1',
    status:'UNAVAILABLE',reason,diagnostic_only:true});
  if(!Array.isArray(rows)||!Array.isArray(probabilities)||rows.length!==probabilities.length||
    rows.length<20||probabilities.some(v=>!finite(v)||v<0||v>1)||
    rows.some(row=>!finite(row?.realized_return_pct)))
    return unavailable('RANKING_EVALUATION_ROWS_OR_RETURNS_INVALID');
  let built;
  try{built=buildTcnLstmReturnRankingPairs(rows,rows,{
    roundTripCostBps,minimumReturnGapPct,maxPairsPerTimestamp
  });}catch(error){return unavailable(String(error?.message||error));}
  if(!built.comparison_pairs)return unavailable('NO_MATURED_WITHIN_TIMESTAMP_RETURN_PAIRS');
  let loss=0,correct=0;
  for(const pair of built.pairs){
    const item=tcnLstmPairwiseReturnRankingLoss(
      probabilities[pair.high_index],probabilities[pair.low_index]);
    loss+=item.loss;if(item.correct)correct++;
  }
  return {schema:'RADARX_TCN_LSTM_PAIRWISE_RANKING_METRICS_V1',
    status:'AVAILABLE',sample_count:rows.length,decision_group_count:built.decision_group_count,
    comparison_pairs:built.comparison_pairs,pairwise_log_loss:Number((loss/built.comparison_pairs).toFixed(8)),
    pairwise_accuracy_pct:Number((100*correct/built.comparison_pairs).toFixed(4)),
    source:'REALIZED_RETURN_WITHIN_SIMULTANEOUS_DECISION_TIMESTAMP',
    diagnostic_only:true,holdout_values_used:false};
}
/** Rank realized-return pairs directly from uncompressed forward logits. */
export function summarizeTcnLstmPairwiseLogitRanking(rows,logits,{
  roundTripCostBps=30,minimumReturnGapPct=0.50,maxPairsPerTimestamp=4
}={}) {
  const unavailable=reason=>({schema:'RADARX_TCN_LSTM_PAIRWISE_LOGIT_RANKING_METRICS_V1',
    status:'UNAVAILABLE',reason,diagnostic_only:true,holdout_values_used:false});
  if(!Array.isArray(rows)||!Array.isArray(logits)||rows.length!==logits.length||
    rows.length<20||logits.some(v=>!finite(v)||Math.abs(v)>LOGIT_LIMIT)||
    rows.some(row=>!finite(row?.realized_return_pct)))
    return unavailable('RANKING_EVALUATION_ROWS_OR_LOGITS_INVALID');
  let built;
  try{built=buildTcnLstmReturnRankingPairs(rows,rows,{
    roundTripCostBps,minimumReturnGapPct,maxPairsPerTimestamp
  });}catch(error){return unavailable(String(error?.message||error));}
  if(!built.comparison_pairs)return unavailable('NO_MATURED_WITHIN_TIMESTAMP_RETURN_PAIRS');
  let loss=0,correct=0;
  for(const pair of built.pairs){
    const item=tcnLstmPairwiseLogitRankingLoss(logits[pair.high_index],logits[pair.low_index]);
    loss+=item.loss;if(item.correct)correct++;
  }
  return {schema:'RADARX_TCN_LSTM_PAIRWISE_LOGIT_RANKING_METRICS_V1',
    status:'AVAILABLE',sample_count:rows.length,decision_group_count:built.decision_group_count,
    comparison_pairs:built.comparison_pairs,pairwise_log_loss:Number((loss/built.comparison_pairs).toFixed(8)),
    pairwise_accuracy_pct:Number((100*correct/built.comparison_pairs).toFixed(4)),
    source:'REALIZED_RETURN_WITHIN_SIMULTANEOUS_DECISION_TIMESTAMP',
    score_domain:'RAW_MODEL_LOGITS_NO_PROBABILITY_CLIPPING',
    diagnostic_only:true,holdout_values_used:false};
}


/**
 * Execution-side qualification for the auxiliary rank head. Pairwise loss can
 * improve while the actual Top-K portfolio gets worse; only the disjoint
 * inner-selection rows may qualify this separate ranking policy.
 */
export function summarizeTcnLstmRankingExecutionSelection(rows,rankingLogits,anchorLogits,{
  roundTripCostBps=30,minimumTrades=20,minimumWinRatePct=55,maximumDrawdownPct=8
}={}){
  const unavailable=reason=>({
    schema:'RADARX_TCN_LSTM_RANKING_EXECUTION_SELECTION_V1',
    status:'UNAVAILABLE',diagnostic_only:true,passed:false,reason,top_k_trials:[]
  });
  if(!Array.isArray(rows)||!Array.isArray(rankingLogits)||!Array.isArray(anchorLogits)||
    rows.length!==rankingLogits.length||rows.length!==anchorLogits.length||rows.length<20||
    rankingLogits.some(value=>!finite(value))||anchorLogits.some(value=>!finite(value)))
    return unavailable('RANKING_EXECUTION_SELECTION_INPUT_INVALID');
  if(!finite(roundTripCostBps)||roundTripCostBps<0||
    !Number.isInteger(minimumTrades)||minimumTrades<1||
    !finite(minimumWinRatePct)||minimumWinRatePct<0||minimumWinRatePct>100||
    !finite(maximumDrawdownPct)||maximumDrawdownPct<=0)
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
  const eligible=[...groups.values()].filter(indices=>indices.length>=2);
  if(!eligible.length)return unavailable('NO_SIMULTANEOUS_SELECTION_DECISION_GROUPS');
  const trials=[];
  for(const topK of [1,2,3]){
    const buildMask=scores=>{
      const mask=Array(rows.length).fill(0);
      for(const indices of eligible){
        const ordered=[...indices].sort((a,b)=>scores[b]-scores[a]||
          String(rows[a]?.symbol??'').localeCompare(String(rows[b]?.symbol??''))||
          String(rows[a]?.id??'').localeCompare(String(rows[b]?.id??'')));
        for(const index of ordered.slice(0,Math.min(topK,ordered.length)))mask[index]=1;
      }
      return mask;
    };
    let modelMetrics,anchorMetrics;
    try{
      modelMetrics=simulateFirstTouchPaperPortfolio(rows,buildMask(rankingLogits),{
        threshold:0.5,roundTripCostBps
      });
      anchorMetrics=simulateFirstTouchPaperPortfolio(rows,buildMask(anchorLogits),{
        threshold:0.5,roundTripCostBps
      });
    }catch(error){
      return unavailable('SELECTION_EXECUTION_SIMULATION_FAILED:'+String(error?.message||error));
    }
    const complete=modelMetrics.return_data_status==='COMPLETE'&&
      anchorMetrics.return_data_status==='COMPLETE';
    const gates={
      return_data_complete:complete,
      minimum_trades:Number(modelMetrics.trade_count)>=minimumTrades,
      minimum_win_rate:finite(modelMetrics.win_rate_pct)&&
        modelMetrics.win_rate_pct>=minimumWinRatePct,
      positive_net_pnl:finite(modelMetrics.net_pnl_pct)&&modelMetrics.net_pnl_pct>0,
      maximum_drawdown:finite(modelMetrics.max_drawdown_pct)&&
        modelMetrics.max_drawdown_pct<=maximumDrawdownPct,
      beats_logistic_anchor:complete&&
        modelMetrics.net_pnl_pct>anchorMetrics.net_pnl_pct&&
        modelMetrics.win_rate_pct>anchorMetrics.win_rate_pct
    };
    trials.push({
      top_k_per_timestamp:topK,decision_group_count:eligible.length,
      model_metrics:modelMetrics,logistic_anchor_metrics:anchorMetrics,
      model_minus_anchor:{
        net_pnl_pct:finite(modelMetrics.net_pnl_pct)&&finite(anchorMetrics.net_pnl_pct)
          ?Number((modelMetrics.net_pnl_pct-anchorMetrics.net_pnl_pct).toFixed(6)):null,
        win_rate_percentage_points:finite(modelMetrics.win_rate_pct)&&finite(anchorMetrics.win_rate_pct)
          ?Number((modelMetrics.win_rate_pct-anchorMetrics.win_rate_pct).toFixed(6)):null
      },
      risk_gates:gates,risk_gates_passed:Object.values(gates).every(Boolean)
    });
  }
  const passed=trials.some(trial=>trial.risk_gates_passed);
  return {
    schema:'RADARX_TCN_LSTM_RANKING_EXECUTION_SELECTION_V1',
    status:'EVALUATED',diagnostic_only:true,passed,
    reason:passed?null:'NO_TOP_K_POLICY_PASSED_EXECUTION_AND_ANCHOR_GATES',
    source_partition:'INNER_SELECTION_ONLY',
    round_trip_cost_bps:Number(roundTripCostBps),
    minimum_trades:minimumTrades,minimum_win_rate_pct:minimumWinRatePct,
    require_positive_net_pnl:true,maximum_drawdown_pct:maximumDrawdownPct,
    requires_strict_improvement_over_logistic_anchor:true,
    affects_classifier_probabilities:false,affects_primary_threshold:false,
    holdout_values_used:false,top_k_trials:trials
  };
}


function evaluatePairwiseReturnRankingLoss(rows,pairs,model,anchor) {
  if(!pairs.length)return 0;
  let total=0;
  for(const pair of pairs){
    const high=rows[pair.high_index],low=rows[pair.low_index];
    const highBase=predictTcnLstmLogisticLogit(high.sequence,anchor);
    const lowBase=predictTcnLstmLogisticLogit(low.sequence,anchor);
    const highLogit=inspectTcnLstmForward(high.sequence,model,highBase).ranking_logit;
    const lowLogit=inspectTcnLstmForward(low.sequence,model,lowBase).ranking_logit;
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
    const highBase=predictTcnLstmLogisticLogit(high.sequence,anchor);
    const lowBase=predictTcnLstmLogisticLogit(low.sequence,anchor);
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
    const baselineLogit=predictTcnLstmLogisticLogit(row.sequence,anchor);
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
    const baseline=predictTcnLstmLogisticLogit(row.sequence,anchor);
    const pooled=[...inspectTcnLstmForward(row.sequence,model,baseline).cache.pooled];
    const net=Math.max(-30,Math.min(30,Number(item.realized_return_pct)-costPct));
    const downside=Math.max(0,Math.min(30,-Number(item.max_adverse_excursion_pct)));
    return {pooled,net,downside};
  });
  const hidden=TCN_LSTM_HIDDEN;
  const fitHead=targetKey=>{
    let weights=Array(hidden).fill(0),bias=0;
    const m=Array(hidden).fill(0),v=Array(hidden).fill(0);
    let mb=0,vb=0,bestLoss=Infinity,best={weights:[...weights],bias},wait=0,done=0;
    const predict=(item,w,b)=>b+item.pooled.reduce((sum,x,i)=>sum+x*w[i],0);
    const loss=()=>vectors.reduce((sum,item)=>sum+
      (Math.abs(predict(item,weights,bias)-item[targetKey])<=huberDelta
        ?0.5*Math.pow(predict(item,weights,bias)-item[targetKey],2)
        :huberDelta*(Math.abs(predict(item,weights,bias)-item[targetKey])-0.5*huberDelta)),0)/vectors.length;
    const initial=loss();
    for(let epoch=1;epoch<=epochs;epoch++){
      const gw=Array(hidden).fill(0);let gb=0;
      for(const item of vectors){
        const error=predict(item,weights,bias)-item[targetKey];
        const grad=Math.max(-huberDelta,Math.min(huberDelta,error));
        gb+=grad;
        for(let i=0;i<hidden;i++)gw[i]+=grad*item.pooled[i];
      }
      for(let i=0;i<hidden;i++)gw[i]=gw[i]/vectors.length+l2*weights[i];
      gb/=vectors.length;
      const norm=Math.sqrt(gw.reduce((sum,x)=>sum+x*x,0)+gb*gb);
      const scale=norm>2?2/norm:1;
      for(let i=0;i<hidden;i++){
        const g=gw[i]*scale;
        m[i]=0.9*m[i]+0.1*g;v[i]=0.999*v[i]+0.001*g*g;
        weights[i]-=learningRate*(m[i]/(1-Math.pow(0.9,epoch)))/
          (Math.sqrt(v[i]/(1-Math.pow(0.999,epoch)))+1e-8);
      }
      const g=gb*scale;mb=0.9*mb+0.1*g;vb=0.999*vb+0.001*g*g;
      bias-=learningRate*(mb/(1-Math.pow(0.9,epoch)))/
        (Math.sqrt(vb/(1-Math.pow(0.999,epoch)))+1e-8);
      const current=loss();
      if(!finite(current)||weights.some(x=>!finite(x))||!finite(bias))
        throw new TypeError('TCN_LSTM_EXECUTION_HEAD_NON_FINITE:'+targetKey);
      done=epoch;
      if(current<bestLoss-1e-9){bestLoss=current;best={weights:[...weights],bias};wait=0;}
      else if(++wait>=20)break;
    }
    return {weights:best.weights,bias:best.bias,initial_huber_loss:Number(initial.toFixed(8)),
      final_huber_loss:Number(bestLoss.toFixed(8)),epochs_completed:done};
  };
  const returns=fitHead('net'),risk=fitHead('downside');
  model.executionReturnHeadWeights=returns.weights;
  model.executionReturnHeadBias=returns.bias;
  model.executionRiskHeadWeights=risk.weights;
  model.executionRiskHeadBias=risk.bias;
  return {
    schema:'RADARX_TCN_LSTM_NET_RETURN_DOWNSIDE_REGRESSION_HEADS_V1',
    fitted:true,fit_boundary:'TRAINING_PARTITION_ONLY',
    source:'MATURED_REALIZED_RETURN_AND_MAX_ADVERSE_EXCURSION',
    training_rows:rows.length,round_trip_cost_bps:Number(roundTripCostBps),
    net_return_target:'REALIZED_RETURN_PCT_MINUS_ROUND_TRIP_COST',
    downside_target:'MAX_0_NEGATIVE_MAX_ADVERSE_EXCURSION_PCT',
    target_clip_pct:[-30,30],validation_or_holdout_used:false,
    net_return:returns,downside_risk:risk
  };
}

export function predictTcnLstmHybridExecutionHeads(sequence,profile) {
  if(!profile?.model||!profile?.baseline_fit)
    throw new TypeError('TCN_LSTM_PROFILE_NOT_TRAINED');
  const baseline=predictTcnLstmLogisticLogit(sequence,profile.baseline_fit);
  const pooled=inspectTcnLstmForward(sequence,profile.model,baseline).cache.pooled;
  const dot=(weights,bias)=>Number(bias)+pooled.reduce((sum,x,i)=>sum+x*weights[i],0);
  const rw=profile.model.executionReturnHeadWeights;
  const dw=profile.model.executionRiskHeadWeights;
  if(!Array.isArray(rw)||rw.length!==pooled.length||
    !Array.isArray(dw)||dw.length!==pooled.length||
    [...rw,...dw].some(x=>!finite(x))||
    !finite(profile.model.executionReturnHeadBias)||
    !finite(profile.model.executionRiskHeadBias))
    throw new TypeError('TCN_LSTM_EXECUTION_HEADS_NOT_FITTED');
  return {
    predicted_net_return_pct:dot(rw,profile.model.executionReturnHeadBias),
    predicted_downside_risk_pct:Math.max(0,dot(dw,profile.model.executionRiskHeadBias))
  };
}

/** Choose risk penalty only on purged inner-selection rows, against identical Logistic opportunities. */
/**
 * Frozen inference score for cross-sectional execution ranking.
 * The penalty weight is selected on the purged inner-selection partition and
 * then carried unchanged into outer validation. Probability calibration is
 * deliberately separate from this return/risk score.
 */
export function predictTcnLstmHybridExecutionScore(sequence,profile) {
  const prediction=predictTcnLstmHybridExecutionHeads(sequence,profile);
  const lambda=finite(profile?.execution_risk_penalty_weight)
    ?clamp(Number(profile.execution_risk_penalty_weight),0,8):null;
  if(lambda===null)
    return {status:'UNAVAILABLE',reason:'FROZEN_EXECUTION_RISK_PENALTY_NOT_SELECTED',
      predicted_net_return_pct:prediction.predicted_net_return_pct,
      predicted_downside_risk_pct:prediction.predicted_downside_risk_pct,
      risk_penalty_weight:null,risk_adjusted_net_return_score:null};
  const score=prediction.predicted_net_return_pct-
    lambda*prediction.predicted_downside_risk_pct;
  if(!finite(score))
    return {status:'UNAVAILABLE',reason:'EXECUTION_RISK_ADJUSTED_SCORE_NON_FINITE',
      predicted_net_return_pct:prediction.predicted_net_return_pct,
      predicted_downside_risk_pct:prediction.predicted_downside_risk_pct,
      risk_penalty_weight:lambda,risk_adjusted_net_return_score:null};
  return {status:'AVAILABLE',score_semantics:'PREDICTED_NET_RETURN_MINUS_FROZEN_LAMBDA_TIMES_PREDICTED_DOWNSIDE_RISK',
    predicted_net_return_pct:Number(prediction.predicted_net_return_pct),
    predicted_downside_risk_pct:Number(prediction.predicted_downside_risk_pct),
    risk_penalty_weight:lambda,
    risk_adjusted_net_return_score:Number(score)};
}

export function selectTcnLstmExecutionRiskPolicy(rows,executionPredictions,logisticLogits,{
  roundTripCostBps=30,minimumTrades=20,minimumWinRatePct=55,maximumDrawdownPct=8
}={}) {
  const unavailable=reason=>({schema:'RADARX_TCN_LSTM_EXECUTION_RISK_POLICY_V1',
    status:'UNAVAILABLE',reason,selection_partition_only:true,holdout_values_used:false,passed:false});
  if(!Array.isArray(rows)||rows.length<20||!Array.isArray(executionPredictions)||
    executionPredictions.length!==rows.length||!Array.isArray(logisticLogits)||
    logisticLogits.length!==rows.length||
    rows.some(row=>!finite(row?.at)||!row?.first_touch||
      !finite(row?.realized_return_pct)||!finite(row?.max_adverse_excursion_pct))||
    executionPredictions.some(x=>!finite(x?.predicted_net_return_pct)||
      !finite(x?.predicted_downside_risk_pct)||x.predicted_downside_risk_pct<0)||
    logisticLogits.some(x=>!finite(x)))
    return unavailable('INNER_SELECTION_EXECUTION_EVIDENCE_INVALID');
  const groups=new Map();
  rows.forEach((row,index)=>{
    const bucket=Math.floor(Number(row.at)/TCN_LSTM_RANKING_BUCKET_MS);
    if(!groups.has(bucket))groups.set(bucket,[]);
    groups.get(bucket).push(index);
  });
  const eligible=[...groups.values()].filter(items=>items.length>=2);
  if(!eligible.length)return unavailable('NO_SIMULTANEOUS_DECISION_GROUPS');
  const costPct=Number(roundTripCostBps)/100;
  const trials=[];
  for(const lambda of [0,0.1,0.25,0.5,1,2,4,8]){
    for(const topK of [1,2,3]){
      const modelMask=Array(rows.length).fill(0),anchorMask=Array(rows.length).fill(0);
      for(const indices of eligible){
        const ordered=[...indices].sort((a,b)=>
          (executionPredictions[b].predicted_net_return_pct-
            lambda*executionPredictions[b].predicted_downside_risk_pct)-
          (executionPredictions[a].predicted_net_return_pct-
            lambda*executionPredictions[a].predicted_downside_risk_pct)||
          String(rows[a].symbol??'').localeCompare(String(rows[b].symbol??'')));
        for(const i of ordered.slice(0,Math.min(topK,ordered.length)))modelMask[i]=1;
        const anchor=[...indices].sort((a,b)=>logisticLogits[b]-logisticLogits[a]||
          String(rows[a].symbol??'').localeCompare(String(rows[b].symbol??'')));
        for(const i of anchor.slice(0,Math.min(topK,anchor.length)))anchorMask[i]=1;
      }
      const options={threshold:0.5,roundTripCostBps,
        maxConcurrentPositions:NEURAL_CLOSURE_PORTFOLIO_POLICY.max_concurrent_positions,
        initialEquity:100};
      const modelMetrics=simulateFirstTouchPaperPortfolio(rows,modelMask,options);
      const anchorMetrics=simulateFirstTouchPaperPortfolio(rows,anchorMask,options);
      const complete=modelMetrics.return_data_status==='COMPLETE'&&
        anchorMetrics.return_data_status==='COMPLETE';
      const gates={
        return_data_complete:complete,
        minimum_trades:Number(modelMetrics.trade_count)>=minimumTrades,
        minimum_win_rate:finite(modelMetrics.win_rate_pct)&&modelMetrics.win_rate_pct>=minimumWinRatePct,
        positive_net_pnl:finite(modelMetrics.net_pnl_pct)&&modelMetrics.net_pnl_pct>0,
        maximum_drawdown:finite(modelMetrics.max_drawdown_pct)&&modelMetrics.max_drawdown_pct<=maximumDrawdownPct,
        beats_logistic_anchor:complete&&modelMetrics.net_pnl_pct>anchorMetrics.net_pnl_pct&&
          modelMetrics.win_rate_pct>anchorMetrics.win_rate_pct
      };
      trials.push({risk_penalty_weight:lambda,top_k_per_timestamp:topK,
        model_metrics:modelMetrics,logistic_anchor_metrics:anchorMetrics,
        model_minus_logistic_net_pnl_pct:finite(modelMetrics.net_pnl_pct)&&finite(anchorMetrics.net_pnl_pct)
          ?Number((modelMetrics.net_pnl_pct-anchorMetrics.net_pnl_pct).toFixed(6)):null,
        gates,passed:Object.values(gates).every(Boolean)});
    }
  }
  trials.sort((a,b)=>Number(b.passed)-Number(a.passed)||
    Number(b.model_metrics.net_pnl_pct??-Infinity)-Number(a.model_metrics.net_pnl_pct??-Infinity)||
    Number(b.model_metrics.win_rate_pct??-Infinity)-Number(a.model_metrics.win_rate_pct??-Infinity)||
    Number(a.model_metrics.max_drawdown_pct??Infinity)-Number(b.model_metrics.max_drawdown_pct??Infinity));
  const best=trials[0];
  return {schema:'RADARX_TCN_LSTM_EXECUTION_RISK_POLICY_V1',
    status:'EVALUATED',selection_partition_only:true,holdout_values_used:false,
    round_trip_cost_bps:Number(roundTripCostBps),minimum_trades:minimumTrades,
    minimum_win_rate_pct:minimumWinRatePct,maximum_drawdown_pct:maximumDrawdownPct,
    passed:best?.passed===true,selected_risk_penalty_weight:best?.risk_penalty_weight??null,
    selected_top_k_per_timestamp:best?.top_k_per_timestamp??null,
    selected_trial:best??null,trials};
}

/**
 * Fit a linear residual ranking head on frozen TCN-LSTM pooled representations.
 * It starts from the training-only Logistic anchor, and never backpropagates
 * into classifier/encoder weights, isolating the calibrated probability path.
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
  const vectors=rows.map(row=>{
    const baselineLogit=predictTcnLstmLogisticLogit(row.sequence,anchor);
    const forward=inspectTcnLstmForward(row.sequence,model,baselineLogit);
    return {baselineLogit,pooled:[...forward.cache.pooled]};
  });
  const hidden=TCN_LSTM_HIDDEN;
  let weights=Array.isArray(model.rankingHeadWeights)
    ?[...model.rankingHeadWeights]:Array(hidden).fill(0);
  if(weights.length!==hidden||weights.some(value=>!finite(value)))
    throw new TypeError('TCN_LSTM_RANKING_HEAD_INITIAL_WEIGHTS_INVALID');
  const score=(item,currentWeights)=>{
    let logit=item.baselineLogit;
    for(let channel=0;channel<hidden;channel++)
      logit+=currentWeights[channel]*item.pooled[channel];
    return clamp(logit,-LOGIT_LIMIT,LOGIT_LIMIT);
  };
  const evaluate=currentWeights=>{
    let loss=0;
    for(const pair of pairs){
      const high=score(vectors[pair.high_index],currentWeights);
      const low=score(vectors[pair.low_index],currentWeights);
      loss+=tcnLstmPairwiseLogitRankingLoss(high,low).loss;
    }
    return loss/pairs.length;
  };
  let bestLoss=evaluate(weights),bestWeights=[...weights],wait=0,completed=0;
  const initialLoss=bestLoss;
  const firstMoment=Array(hidden).fill(0),secondMoment=Array(hidden).fill(0);
  const beta1=0.9,beta2=0.999,epsilon=1e-8;
  for(let epoch=1;epoch<=epochs;epoch++){
    const gradient=Array(hidden).fill(0);
    for(const pair of pairs){
      const high=vectors[pair.high_index],low=vectors[pair.low_index];
      const item=tcnLstmPairwiseLogitRankingLoss(score(high,weights),score(low,weights));
      for(let channel=0;channel<hidden;channel++)
        gradient[channel]+=
          item.high_logit_gradient*high.pooled[channel]+
          item.low_logit_gradient*low.pooled[channel];
    }
    const averaged=gradient.map((value,channel)=>
      value/pairs.length+l2*weights[channel]);
    const norm=Math.sqrt(averaged.reduce((sum,value)=>sum+value*value,0));
    const clipped=norm>1?averaged.map(value=>value/norm):averaged;
    for(let channel=0;channel<hidden;channel++){
      firstMoment[channel]=beta1*firstMoment[channel]+(1-beta1)*clipped[channel];
      secondMoment[channel]=beta2*secondMoment[channel]+(1-beta2)*clipped[channel]*clipped[channel];
      const correctedFirst=firstMoment[channel]/(1-Math.pow(beta1,epoch));
      const correctedSecond=secondMoment[channel]/(1-Math.pow(beta2,epoch));
      weights[channel]=clamp(weights[channel]-
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
    schema:'RADARX_TCN_LSTM_AUXILIARY_PAIRWISE_LOGIT_RESIDUAL_HEAD_V1',
    fitted:true,fit_boundary:'TRAINING_PARTITION_ONLY',
    input:'FROZEN_TCN_LSTM_TEMPORAL_ATTENTION_POOLED_REPRESENTATION',
    baseline:'SAME_TRAINING_ROW_FROZEN_LOGISTIC_ANCHOR',
    training_rows:rows.length,training_pairs:pairs.length,
    learning_rate:learningRate,epochs_requested:epochs,epochs_completed:completed,
    l2,patience,early_stopped:completed<epochs,
    initial_pairwise_log_loss:Number(initialLoss.toFixed(8)),
    final_pairwise_log_loss:Number(finalLoss.toFixed(8)),
    weight_l2_norm:Number(Math.sqrt(bestWeights.reduce((sum,value)=>sum+value*value,0)).toFixed(8)),
    classifier_parameters_updated:false,validation_or_holdout_used:false
  };
}

export function trainTcnLstmHybrid(trainingRows, {
  epochs = 8, learningRate = 0.0025, l2 = 0.0015, dropout = TCN_LSTM_DROPOUT,
  batchSize = 32, seed = 29, maxTrainingSamples = TCN_LSTM_MAX_TRAINING_SAMPLES,
  baselineFit = null, earlyStoppingPatience = 5,
  objective='BRIER',gammaPositive=1,gammaNegative=2,
  rankingRows=null,executionRows=null,rankingWeight=0,rankingRoundTripCostBps=30,
  rankingMinimumReturnGapPct=0.50,rankingPairsPerTimestamp=4,
  rankingHeadLearningRate=0.03,rankingHeadEpochs=40,rankingHeadL2=0.001,
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
  const classWeights=objective==='FOCAL_ASYMMETRIC_BRIER'
    ?deriveTrainingClassWeights(rows.map(row=>row.target)):null;
  if(rankingRows!==null&&!Array.isArray(rankingRows))
    throw new TypeError('TCN_LSTM_RANKING_ROWS_INVALID');
  if(!finite(rankingHeadLearningRate)||rankingHeadLearningRate<=0||
    rankingHeadLearningRate>0.25||!Number.isInteger(rankingHeadEpochs)||
    rankingHeadEpochs<1||rankingHeadEpochs>200||
    !finite(rankingHeadL2)||rankingHeadL2<0||rankingHeadL2>1)
    throw new TypeError('TCN_LSTM_RANKING_HEAD_CONFIGURATION_INVALID');
  const ranking=Array.isArray(rankingRows)
    ?buildTcnLstmReturnRankingPairs(rows,rankingRows,{
      roundTripCostBps:rankingRoundTripCostBps,
      minimumReturnGapPct:rankingMinimumReturnGapPct,
      maxPairsPerTimestamp:rankingPairsPerTimestamp
    })
    :{schema:'RADARX_TCN_LSTM_TRAINING_RETURN_RANK_PAIRS_V1',
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
        const baselineLogit = predictTcnLstmLogisticLogit(row.sequence, anchor);
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
            const highBase=predictTcnLstmLogisticLogit(high.sequence,anchor);
            const lowBase=predictTcnLstmLogisticLogit(low.sequence,anchor);
            const highLogit=inspectTcnLstmForward(high.sequence,model,highBase).logit;
            const lowLogit=inspectTcnLstmForward(low.sequence,model,lowBase).logit;
            const pairLoss=tcnLstmPairwiseLogitRankingLoss(highLogit,lowLogit);
            const highGrad=lossAndGradientsTcnLstmHybrid(high.sequence,high.target,model,highBase,{
              objective:'EXTERNAL_LOGIT',
              externalLogitGradient:pairLoss.high_logit_gradient*rankingWeight
            });
            const lowGrad=lossAndGradientsTcnLstmHybrid(low.sequence,low.target,model,lowBase,{
              objective:'EXTERNAL_LOGIT',
              externalLogitGradient:pairLoss.low_logit_gradient*rankingWeight
            });
            rankGradient=accumulateTree(rankGradient,highGrad.gradients);
            rankGradient=accumulateTree(rankGradient,lowGrad.gradients);
            epochSharedRankingLoss+=pairLoss.loss;
            epochSharedRankingPairs++;
          }
          averaged=accumulateTree(averaged,scaleTree(rankGradient,1/batchPairs.length));
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
  const rankingHeadFit=rankingPairs.length
    ?fitTcnLstmPairwiseRankingHead(rows,rankingPairs,model,anchor,{
      learningRate:rankingHeadLearningRate,epochs:rankingHeadEpochs,
      l2:rankingHeadL2,patience:Math.min(20,Math.max(5,earlyStoppingPatience*2))
    })
    :{schema:'RADARX_TCN_LSTM_AUXILIARY_PAIRWISE_LOGIT_RESIDUAL_HEAD_V1',
      fitted:false,reason:'NO_TRAINING_PARTITION_RETURN_PAIRS',
      fit_boundary:'TRAINING_PARTITION_ONLY',validation_or_holdout_used:false};
  const executionHeadFit=Array.isArray(executionRows)
    ?fitTcnLstmExecutionRegressionHeads(rows,executionRows,model,anchor,{
      roundTripCostBps:executionHeadRoundTripCostBps,
      learningRate:executionHeadLearningRate,epochs:executionHeadEpochs,l2:executionHeadL2
    })
    :{schema:'RADARX_TCN_LSTM_NET_RETURN_DOWNSIDE_REGRESSION_HEADS_V1',
      fitted:false,reason:'MATURED_TRAINING_EXECUTION_EVIDENCE_NOT_SUPPLIED',
      fit_boundary:'TRAINING_PARTITION_ONLY',validation_or_holdout_used:false};
  const finalBrier=evaluateBrier(rows,model,anchor);
  const finalRankingLoss=evaluatePairwiseReturnRankingLoss(rows,rankingPairs,model,anchor);
  const finalSharedRankingLoss=rankingWeight>0
    ?evaluateSharedClassifierRankingLoss(rows,rankingPairs,model,anchor):0;
  if(!finite(finalBrier)||!finite(finalRankingLoss)||!finite(finalSharedRankingLoss)||
    !treeFinite(trainableParameters(model))||
    !Array.isArray(model.rankingHeadWeights)||model.rankingHeadWeights.some(value=>!finite(value)))
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
    ranking_head_parameter_count:rankingHeadFit.fitted
      ?TCN_LSTM_RANKING_HEAD_PARAMETER_COUNT:0,
    execution_regression_head_parameter_count:executionHeadFit.fitted
      ?2*(TCN_LSTM_HIDDEN+1):0,
    total_parameter_count:TCN_LSTM_CLASSIFIER_PARAMETER_COUNT+
      (rankingHeadFit.fitted?TCN_LSTM_RANKING_HEAD_PARAMETER_COUNT:0)+
      (executionHeadFit.fitted?2*(TCN_LSTM_HIDDEN+1):0),
    parameter_count_contract:{
      classifier_bptt_parameters:TCN_LSTM_CLASSIFIER_PARAMETER_COUNT,
      auxiliary_ranking_head_parameters:rankingHeadFit.fitted
        ?TCN_LSTM_RANKING_HEAD_PARAMETER_COUNT:0,
      execution_regression_head_parameters:executionHeadFit.fitted
        ?2*(TCN_LSTM_HIDDEN+1):0,
      total:TCN_LSTM_CLASSIFIER_PARAMETER_COUNT+
        (rankingHeadFit.fitted?TCN_LSTM_RANKING_HEAD_PARAMETER_COUNT:0)+
        (executionHeadFit.fitted?2*(TCN_LSTM_HIDDEN+1):0)
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
      best_training_pairwise_rank_loss:Number(finalRankingLoss.toFixed(8)),
      best_training_shared_classifier_pairwise_rank_loss:Number(bestSharedRankingLoss.toFixed(8)),
      best_training_classification_objective:Number(bestClassificationObjective.toFixed(8)),
      best_training_composite_objective:Number(bestObjective.toFixed(8)),
      shared_classifier_loss:{
        enabled:rankingWeight>0,
        method:'SHARED_TCN_LSTM_CLASSIFIER_PAIRWISE_LOGIT_BACKPROP_V1',
        weight:Number(rankingWeight),
        source_partition:'TRAINING_PARTITION_ONLY',
        pair_schema:ranking.schema,
        comparison_pairs:ranking.comparison_pairs,
        decision_group_count:ranking.decision_group_count,
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
        method:'SHARED_CLASSIFIER_PAIRWISE_LOSS_PLUS_AUXILIARY_PAIRWISE_LOGIT_RESIDUAL_HEAD_V2',
        shared_classifier_loss_weight:Number(rankingWeight),
        pair_schema:ranking.schema,source_partition:ranking.source_partition,
        decision_group_count:ranking.decision_group_count,
        comparison_pairs:ranking.comparison_pairs,
        round_trip_cost_bps:Number(rankingRoundTripCostBps),
        minimum_return_gap_pct:Number(rankingMinimumReturnGapPct),
        maximum_pairs_per_timestamp:rankingPairsPerTimestamp,
        ranking_head:rankingHeadFit,
        training_pairwise_log_loss:Number(finalRankingLoss.toFixed(8)),
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
    final_training_pairwise_rank_loss:Number(finalRankingLoss.toFixed(8)),
    probability_ready: false,
    live_eligibility_ready: false,
    real_order_execution: false
  };
}

export function predictTcnLstmHybridProbability(sequence, profile) {
  if (!profile?.model || !profile?.baseline_fit)
    throw new TypeError('TCN_LSTM_PROFILE_NOT_TRAINED');
  const baselineLogit = predictTcnLstmLogisticLogit(sequence, profile.baseline_fit);
  const forward=inspectTcnLstmForward(sequence,profile.model,baselineLogit);
  // The return-ranking head is fitted on TRAINING rows only. Its blend weight
  // is selected on the disjoint inner-selection partition, then frozen before
  // calibration and outer validation. A zero weight preserves classifier-only
  // behavior for legacy artifacts.
  const blendWeight=finite(profile.ranking_probability_blend_weight)
    ?clamp(Number(profile.ranking_probability_blend_weight),0,2):0;
  return sigmoid(forward.logit+blendWeight*forward.ranking_logit);
}
export function predictTcnLstmHybridRankingLogit(sequence, profile) {
  if (!profile?.model || !profile?.baseline_fit)
    throw new TypeError('TCN_LSTM_PROFILE_NOT_TRAINED');
  const baselineLogit = predictTcnLstmLogisticLogit(sequence, profile.baseline_fit);
  return inspectTcnLstmForward(sequence, profile.model, baselineLogit).ranking_logit;
}

/** Exact frozen Logistic anchor score underlying the separate ranking head. */
export function predictTcnLstmHybridRankingAnchorLogit(sequence, profile) {
  if (!profile?.model || !profile?.baseline_fit)
    throw new TypeError('TCN_LSTM_PROFILE_NOT_TRAINED');
  return predictTcnLstmLogisticLogit(sequence, profile.baseline_fit);
}

function splitPredictions(rows, profile) {
  const modelPredictions = rows.map(row => predictTcnLstmHybridProbability(row.sequence, profile));
  const baselinePredictions = rows.map(row =>
    sigmoid(predictTcnLstmLogisticLogit(row.sequence, profile.baseline_fit)));
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
  rankingHeadLearningRate=0.03,rankingHeadEpochs=40,rankingHeadL2=0.001
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
    !finite(rankingHeadLearningRate)||rankingHeadLearningRate<=0||rankingHeadLearningRate>0.25||
    !Number.isInteger(rankingHeadEpochs)||rankingHeadEpochs<1||rankingHeadEpochs>200||
    !finite(rankingHeadL2)||rankingHeadL2<0||rankingHeadL2>1)
    throw new TypeError('TCN_LSTM_RETURN_DIAGNOSTIC_CONFIGURATION_INVALID');
  const effectiveTrainingBudget=effectiveTcnLstmTrainingSampleBudget(
    maxTrainingSamples,trainingRows.length
  );
  const effectiveTrainingRows = [...trainingRows].sort((a, b) => a.at - b.at)
    .slice(-effectiveTrainingBudget);
  // Realized returns belong only to the separate selection diagnostic; strip
  // them before either the Logistic anchor or neural optimizer sees fit rows.
  const effectiveTrainingRowsForFit=effectiveTrainingRows.map(row=>{
    const {realized_return_pct,...fitRow}=row;
    return fitRow;
  });
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
  const rankingTrainingEvidenceComplete=effectiveTrainingRows.every(row=>
    finite(row.realized_return_pct)
  );
  let rankingRowsForFit=null;
  let rankingTrainingPairSupport={
    status:'UNAVAILABLE',
    reason:rankingTrainingEvidenceComplete
      ?'TRAINING_RETURN_PAIR_SUPPORT_NOT_CHECKED'
      :'TRAINING_REALIZED_RETURN_EVIDENCE_INCOMPLETE',
    comparison_pairs:0,decision_group_count:0,
    source_partition:'TRAINING_PARTITION_ONLY'
  };
  if(rankingTrainingEvidenceComplete){
    try{
      const support=buildTcnLstmReturnRankingPairs(
        effectiveTrainingRowsForFit,effectiveTrainingRows,{
          roundTripCostBps,
          minimumReturnGapPct:rankingMinimumReturnGapPct,
          maxPairsPerTimestamp:rankingPairsPerTimestamp
        }
      );
      rankingTrainingPairSupport={
        status:support.comparison_pairs>=10?'AVAILABLE':'UNAVAILABLE',
        reason:support.comparison_pairs>=10?null:'FEWER_THAN_10_TRAINING_RETURN_PAIRS',
        comparison_pairs:support.comparison_pairs,
        decision_group_count:support.decision_group_count,
        source_partition:'TRAINING_PARTITION_ONLY'
      };
      if(support.comparison_pairs>=10)
        rankingRowsForFit=effectiveTrainingRows;
    }catch(error){
      rankingTrainingPairSupport={
        status:'UNAVAILABLE',reason:String(error?.message||error),
        comparison_pairs:0,decision_group_count:0,
        source_partition:'TRAINING_PARTITION_ONLY'
      };
    }
  }
  const anchor = fitTcnLstmLogisticAnchor(effectiveTrainingRowsForFit);
  const baselineLogits = selectionRows.map(row =>
    predictTcnLstmLogisticLogit(row.sequence, anchor));
  const baselinePredictions = baselineLogits.map(sigmoid);
  const baselineBrier = brierFrom(selectionRows, baselinePredictions);
  const baselineRanking=summarizeTcnLstmPairwiseLogitRanking(
    selectionRows,baselineLogits,{
      roundTripCostBps,minimumReturnGapPct:rankingMinimumReturnGapPct,
      maxPairsPerTimestamp:rankingPairsPerTimestamp
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
      maxTrainingSamples: effectiveTrainingRows.length,
      baselineFit: anchor,
      rankingRows:rankingRowsForFit,
      executionRows:effectiveTrainingRows.every(row=>finite(row.realized_return_pct)&&
        finite(row.max_adverse_excursion_pct))?effectiveTrainingRows:null,
      rankingWeight:Number(config.rankingWeight??0),
      rankingHeadLearningRate:candidateRankingHeadLearningRate,
      rankingHeadEpochs,rankingHeadL2,
      rankingRoundTripCostBps:roundTripCostBps,
      rankingMinimumReturnGapPct:rankingMinimumReturnGapPct,
      rankingPairsPerTimestamp:rankingPairsPerTimestamp,
      executionHeadRoundTripCostBps:roundTripCostBps
    });
    const selectionExecutionPredictions=selectionRows.map(row=>
      predictTcnLstmHybridExecutionHeads(row.sequence,fit));
    const executionRiskPolicy=selectTcnLstmExecutionRiskPolicy(
      selectionRows,selectionExecutionPredictions,baselineLogits,{
        roundTripCostBps,minimumTrades:minimumReturnTrades,
        minimumWinRatePct:minimumReturnWinRatePct,maximumDrawdownPct:8
      }
    );
    if(executionRiskPolicy.status==='EVALUATED'&&
      finite(executionRiskPolicy.selected_risk_penalty_weight)){
      fit.execution_risk_penalty_weight=executionRiskPolicy.selected_risk_penalty_weight;
      fit.execution_risk_policy=executionRiskPolicy;
    }
    const selectionLogits = selectionRows.map(row => {
      const baseLogit=predictTcnLstmLogisticLogit(row.sequence,fit.baseline_fit);
      return inspectTcnLstmForward(row.sequence,fit.model,baseLogit).logit;
    });
    const selectionRankingLogits = selectionRows.map(row => {
      const baseLogit=predictTcnLstmLogisticLogit(row.sequence,fit.baseline_fit);
      return inspectTcnLstmForward(row.sequence,fit.model,baseLogit).ranking_logit;
    });
    // Search a small, predeclared blend grid using only the purged inner-
    // selection partition. The ranking head is no longer stranded as a
    // diagnostic-only sidecar: it can improve candidate ordering, while the
    // frozen blend is independently calibrated and tested on later blocks.
    const rankingBlendGrid=[0,0.10,0.25,0.50,1.0,1.5,2.0];
    const blendTrials=rankingBlendGrid.map(weight=>{
      const probabilities=selectionLogits.map((logit,index)=>
        sigmoid(logit+weight*selectionRankingLogits[index]));
      const score=brierFrom(selectionRows,probabilities);
      const returns=summarizeTcnLstmSelectionReturns(
        selectionRows,probabilities,{
          roundTripCostBps,minimumTrades:minimumReturnTrades,
          minimumWinRatePct:minimumReturnWinRatePct,
          baselineProbabilities:baselinePredictions
        }
      );
      return {weight,probabilities,score,returns};
    });
    const returnQualifiedBlends=blendTrials.filter(item=>
      item.returns.status==='AVAILABLE'&&
      Number(item.returns.preliminary_return_screen_candidates)>0
    );
    const blendPool=returnQualifiedBlends.length?returnQualifiedBlends:blendTrials;
    blendPool.sort((a,b)=>{
      const aReturn=a.returns.best_preliminary_metrics;
      const bReturn=b.returns.best_preliminary_metrics;
      if(aReturn&&bReturn)
        return Number(bReturn.mean_net_trade_return_pct)-Number(aReturn.mean_net_trade_return_pct)||
          Number(bReturn.trade_count)-Number(aReturn.trade_count)||
          a.score-b.score||a.weight-b.weight;
      if(aReturn)return -1;
      if(bReturn)return 1;
      return a.score-b.score||a.weight-b.weight;
    });
    const selectedBlend=blendPool[0];
    fit.ranking_probability_blend_weight=selectedBlend.weight;
    const predictions=selectedBlend.probabilities;
    const selectedCombinedLogits=selectionLogits.map((logit,index)=>
      logit+selectedBlend.weight*selectionRankingLogits[index]
    );
    const score=selectedBlend.score;
    const pairwiseRanking=summarizeTcnLstmPairwiseLogitRanking(
      selectionRows,selectedCombinedLogits,{
        roundTripCostBps,minimumReturnGapPct:rankingMinimumReturnGapPct,
        maxPairsPerTimestamp:rankingPairsPerTimestamp
      }
    );
    const sharedClassifierPairwiseRanking=summarizeTcnLstmPairwiseLogitRanking(
      selectionRows,selectionLogits,{
        roundTripCostBps,minimumReturnGapPct:rankingMinimumReturnGapPct,
        maxPairsPerTimestamp:rankingPairsPerTimestamp
      }
    );
    const selectionScore=score+
      (rankingScoreAvailable&&pairwiseRanking.status==='AVAILABLE'
        ?rankingScoreWeight*pairwiseRanking.pairwise_log_loss:0);
    const returnDiagnostics=selectedBlend.returns;
    const brierImprovement=baselineBrier-score;
    const pairwiseRankingImprovement=rankingScoreAvailable&&
      pairwiseRanking.status==='AVAILABLE'
        ?baselineRanking.pairwise_log_loss-pairwiseRanking.pairwise_log_loss:null;
    const sharedClassifierPairwiseRankingImprovement=rankingScoreAvailable&&
      sharedClassifierPairwiseRanking.status==='AVAILABLE'
        ?baselineRanking.pairwise_log_loss-sharedClassifierPairwiseRanking.pairwise_log_loss:null;
    const rankingExecutionSelection=summarizeTcnLstmRankingExecutionSelection(
      selectionRows,selectedCombinedLogits,baselineLogits,{
        roundTripCostBps,minimumTrades:minimumReturnTrades,
        minimumWinRatePct:minimumReturnWinRatePct,maximumDrawdownPct:8
      }
    );
    evaluated.push({
      name:config.name,
      config:{...config,dropout:candidateDropout,objective:candidateObjective,
        rankingWeight:Number(config.rankingWeight??0),
        rankingHeadLearningRate:candidateRankingHeadLearningRate},
      ranking_probability_blend_weight:selectedBlend.weight,
      ranking_blend_search:blendTrials.map(item=>({
        weight:item.weight,selection_brier:Number(item.score.toFixed(8)),
        preliminary_return_screen_candidates:item.returns.preliminary_return_screen_candidates??0,
        best_preliminary_metrics:item.returns.best_preliminary_metrics??null
      })),
      selection_brier:score,logistic_selection_brier:baselineBrier,
      brier_improvement:brierImprovement,
      pairwise_ranking:pairwiseRanking,logistic_pairwise_ranking:baselineRanking,
      pairwise_ranking_improvement:pairwiseRankingImprovement,
      shared_classifier_pairwise_ranking:sharedClassifierPairwiseRanking,
      shared_classifier_pairwise_ranking_improvement:sharedClassifierPairwiseRankingImprovement,
      ranking_execution_selection:rankingExecutionSelection,
      execution_risk_policy:executionRiskPolicy,
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
  evaluated.sort((a,b)=>{
    const aReturn=a.return_selection_diagnostics?.best_preliminary_metrics;
    const bReturn=b.return_selection_diagnostics?.best_preliminary_metrics;
    if(aReturn&&bReturn)
      return Number(bReturn.mean_net_trade_return_pct)-Number(aReturn.mean_net_trade_return_pct)||
        Number(bReturn.trade_count)-Number(aReturn.trade_count)||
        a.selection_score-b.selection_score||a.name.localeCompare(b.name);
    if(aReturn)return -1;
    if(bReturn)return 1;
    return a.selection_score-b.selection_score||
      a.selection_brier-b.selection_brier||a.name.localeCompare(b.name);
  });
  const isInnerQualified=item=>
    item.brier_improvement>requiredImprovement&&
    item.composite_improvement>requiredImprovement&&
    (Number(item.config.rankingWeight??0)<=0||
      (finite(item.shared_classifier_pairwise_ranking_improvement)&&
        item.shared_classifier_pairwise_ranking_improvement>0))&&
    item.execution_heads_fitted===true&&
    item.execution_risk_policy?.status==='EVALUATED'&&
    item.execution_risk_policy?.passed===true&&
    item.return_selection_diagnostics?.status==='AVAILABLE'&&
    Number(item.return_selection_diagnostics.preliminary_return_screen_candidates)>0&&
    (!rankingScoreAvailable||
      (finite(item.pairwise_ranking_improvement)&&item.pairwise_ranking_improvement>0));
  const qualifiedCandidates=evaluated.filter(isInnerQualified);
  const winner=(qualifiedCandidates.length?qualifiedCandidates:evaluated)[0];
  const brierGatePassed=winner.brier_improvement>requiredImprovement;
  const rankingGatePassed=!rankingScoreAvailable||
    (finite(winner.pairwise_ranking_improvement)&&winner.pairwise_ranking_improvement>0);
  const compositeGatePassed=winner.composite_improvement>requiredImprovement;
  const sharedClassifierRankingGateRequired=Number(winner.config.rankingWeight??0)>0;
  const sharedClassifierRankingGatePassed=!sharedClassifierRankingGateRequired||
    (finite(winner.shared_classifier_pairwise_ranking_improvement)&&
      winner.shared_classifier_pairwise_ranking_improvement>0);
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
    ranking_training_pair_support:rankingTrainingPairSupport,
    baseline: {
      kind:anchor.kind,training_rows:anchor.training_rows,
      selection_brier:Number(baselineBrier.toFixed(8)),
      pairwise_ranking:baselineRanking,
      selection_score:Number(baselineSelectionScore.toFixed(8))
    },
    selection_scoring:{
      method:rankingScoreAvailable
        ?'INNER_RETURN_SCREENED_BRIER_PLUS_FINAL_COMBINED_LOGIT_AND_SHARED_CLASSIFIER_RANK_V3'
        :'INNER_RETURN_SCREENED_BRIER_PLUS_FINAL_COMBINED_LOGIT_V3',
      pairwise_score_weight:rankingScoreAvailable?rankingScoreWeight:0,
      required_inner_brier_improvement:requiredImprovement,
      required_composite_improvement:requiredImprovement,
      require_pairwise_ranking_improvement:rankingScoreAvailable,
      gate_results:{
        brier_improvement:brierGatePassed?'PASS':'FAIL',
        pairwise_ranking_improvement:rankingGatePassed?'PASS':'FAIL',
        shared_classifier_pairwise_ranking_improvement:
          !sharedClassifierRankingGateRequired?'NOT_REQUIRED':
            sharedClassifierRankingGatePassed?'PASS':'FAIL',
        composite_improvement:compositeGatePassed?'PASS':'FAIL'
      },
      ranking_uses_inner_selection_partition_only:true,
      outer_validation_or_holdout_used:false
    },
    candidates:evaluated.map(({name,config,ranking_probability_blend_weight,
      ranking_blend_search,selection_brier,logistic_selection_brier,
      brier_improvement,pairwise_ranking,logistic_pairwise_ranking,
      pairwise_ranking_improvement,shared_classifier_pairwise_ranking,
      shared_classifier_pairwise_ranking_improvement,
      ranking_execution_selection,execution_risk_policy,
      execution_risk_penalty_weight,ranking_head_selection_qualified,selection_score,logistic_selection_score,
      composite_improvement,return_selection_diagnostics,fit})=>({
      name,config,ranking_probability_blend_weight,ranking_blend_search,
      selection_brier:Number(selection_brier.toFixed(8)),
      logistic_selection_brier:Number(logistic_selection_brier.toFixed(8)),
      brier_improvement:Number(brier_improvement.toFixed(8)),
      pairwise_ranking,logistic_pairwise_ranking,
      pairwise_ranking_improvement:finite(pairwise_ranking_improvement)
        ?Number(pairwise_ranking_improvement.toFixed(8)):null,
      shared_classifier_pairwise_ranking,
      shared_classifier_pairwise_ranking_improvement:
        finite(shared_classifier_pairwise_ranking_improvement)
          ?Number(shared_classifier_pairwise_ranking_improvement.toFixed(8)):null,
      ranking_execution_selection,
      execution_risk_policy,execution_risk_penalty_weight,
      ranking_head_selection_qualified,
      ranking_head:fit.training?.return_ranking?.ranking_head??null,
      selection_score:Number(selection_score.toFixed(8)),
      logistic_selection_score:Number(logistic_selection_score.toFixed(8)),
      composite_improvement:Number(composite_improvement.toFixed(8)),
      improvement:Number(composite_improvement.toFixed(8)),
      passed_inner_brier_margin:brier_improvement>requiredImprovement,
      passed_inner_pairwise_ranking_gate:!rankingScoreAvailable||
        (finite(pairwise_ranking_improvement)&&pairwise_ranking_improvement>0),
      passed_inner_shared_classifier_ranking_gate:Number(config.rankingWeight??0)<=0||
        (finite(shared_classifier_pairwise_ranking_improvement)&&
          shared_classifier_pairwise_ranking_improvement>0),
      passed_inner_composite_margin:composite_improvement>requiredImprovement,
      passed_inner_margin:brier_improvement>requiredImprovement&&
        composite_improvement>requiredImprovement&&
        (Number(config.rankingWeight??0)<=0||
          (finite(shared_classifier_pairwise_ranking_improvement)&&
            shared_classifier_pairwise_ranking_improvement>0))&&
        (!rankingScoreAvailable||
          (finite(pairwise_ranking_improvement)&&pairwise_ranking_improvement>0)),
      return_selection_diagnostics
    })),
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

export function predictTcnLstmHybridCalibratedProbability(sequence, profile, calibrator) {
  if (!calibrator?.fitted)
    throw new TypeError('TCN_LSTM_INFERENCE_CALIBRATOR_NOT_FITTED');
  const raw = predictTcnLstmHybridProbability(sequence, profile);
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
    holdout: { evaluated: false, reason: 'HOLDOUT_LOCKED_UNTIL_VALIDATION_PASSES' },
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

  const holdout = evaluateCalibratedSplit(
    holdoutRows, selectedFit, modelCalibrator, baselineCalibrator,
    { bootstrapSeed: seed + 1001, bootstrapIterations, requiredImprovement:requiredOuterImprovement }
  );
  return {
    ...base,
    status: holdout.passed
      ? 'HOLDOUT_PASSED_RESEARCH_ONLY_NOT_PRODUCTION_APPROVED'
      : 'VALIDATION_PASSED_HOLDOUT_NOT_PASSED',
    calibration: {
      model: modelCalibrator, baseline: baselineCalibrator,
      fit_boundary: 'CALIBRATION_PARTITION_ONLY'
    },
    validation,
    holdout,
    validated_for_research: validationPassed && holdout.passed,
    holdout_passed: holdout.passed,
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
