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

const EPSILON = 1e-12;
const LOGIT_LIMIT = 30;
const SOFTMAX_LIMIT = 40;
const BASELINE_FEATURES = TCN_LSTM_INPUT_CHANNELS * 2;
const finite = value => typeof value === 'number' && Number.isFinite(value);
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
    outputBias: 0
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

export function inspectTcnLstmForward(sequence, model, baselineLogit = 0) {
  validateSequence(sequence);
  if (!finite(baselineLogit)) throw new TypeError('TCN_LSTM_BASELINE_LOGIT_NON_FINITE');
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
  for (let time = 0; time < TCN_LSTM_STEPS; time++) {
    const input = current[time];
    const inputGate = Array(hidden), forgetGate = Array(hidden);
    const outputGate = Array(hidden), candidateGate = Array(hidden);
    const cell = Array(hidden), cellTanh = Array(hidden), state = Array(hidden);
    for (let unit = 0; unit < hidden; unit++) {
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
      break;
    }
    for (let unit = 0; unit < hidden; unit++) {
      cell[unit] = forgetGate[unit] * previousCell[unit] +
        inputGate[unit] * candidateGate[unit];
      cellTanh[unit] = tanh(cell[unit]);
      state[unit] = outputGate[unit] * cellTanh[unit];
    }
    lstmCaches.push({
      input, previousHidden, previousCell,
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
  let residualLogit = model.outputBias;
  for (let channel = 0; channel < hidden; channel++)
    residualLogit += model.outputWeights[channel] * pooled[channel];
  const logit = clamp(baselineLogit + residualLogit, -LOGIT_LIMIT, LOGIT_LIMIT);
  const probability = sigmoid(logit);
  if (![...pooled, ...attentionWeights, probability, logit].every(finite))
    throw new TypeError('TCN_LSTM_FORWARD_NON_FINITE');
  return {
    probability, logit, residual_logit: residualLogit,
    attention_weights: attentionWeights,
    tcn_latent_sequence: current,
    projected_sequence: projected,
    lstm_hidden_sequence: lstmCaches.map(row => row.state),
    lstm_cell_sequence: lstmCaches.map(row => row.cell),
    cache: { projected, tcnCaches, lstmCaches, pooled, attentionWeights }
  };
}

function zerosLike(value) {
  if (Array.isArray(value)) return value.map(zerosLike);
  return 0;
}
function cloneTree(value) {
  if (Array.isArray(value)) return value.map(cloneTree);
  return value;
}
function addTree(target, source) {
  if (Array.isArray(target)) {
    if (!Array.isArray(source) || target.length !== source.length)
      throw new TypeError('TCN_LSTM_GRADIENT_TREE_SHAPE_MISMATCH');
    for (let index = 0; index < target.length; index++) addTree(target[index], source[index]);
  } else {
    if (!finite(source)) throw new TypeError('TCN_LSTM_GRADIENT_NON_FINITE');
    target += source;
  }
  return target;
}
function accumulateTree(target, source) {
  if (Array.isArray(target)) {
    if (!Array.isArray(source) || target.length !== source.length)
      throw new TypeError('TCN_LSTM_GRADIENT_TREE_SHAPE_MISMATCH');
    for (let index = 0; index < target.length; index++)
      target[index] = accumulateTree(target[index], source[index]);
    return target;
  }
  if (!finite(source)) throw new TypeError('TCN_LSTM_GRADIENT_NON_FINITE');
  return target + source;
}
function scaleTree(value, factor) {
  if (Array.isArray(value)) return value.map(item => scaleTree(item, factor));
  return value * factor;
}
function sumSquares(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + sumSquares(item), 0);
  return value * value;
}
function treeFinite(value) {
  if (Array.isArray(value)) return value.every(treeFinite);
  return finite(value);
}

function zeroGradients(model) {
  return zerosLike(trainableParameters(model));
}

export function lossAndGradientsTcnLstmHybrid(sequence, target, model, baselineLogit = 0) {
  if (target !== 0 && target !== 1)
    throw new TypeError('TCN_LSTM_TARGET_INVALID');
  const forward = inspectTcnLstmForward(sequence, model, baselineLogit);
  const parameters = trainableParameters(model);
  const gradients = zeroGradients(model);
  const hidden = TCN_LSTM_HIDDEN;
  const error = forward.probability - target;
  const logitGradient = 2 * error * forward.probability * (1 - forward.probability);
  const cache = forward.cache;
  gradients.outputBias = logitGradient;
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
    tcnOutputGradients[time] = inputGradient;
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
    loss: error * error,
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
  epsilon = 1e-5
} = {}) {
  validateSequence(sequence);
  if (!finite(epsilon) || epsilon <= 0) throw new TypeError('TCN_LSTM_GRADIENT_EPSILON_INVALID');
  const analytic = lossAndGradientsTcnLstmHybrid(sequence, target, model, baselineLogit);
  const parameters = trainableParameters(model);
  const parameterPaths = flattenPaths(parameters);
  const gradientPaths = flattenPaths(analytic.gradients);
  if (parameterPaths.length !== gradientPaths.length)
    throw new TypeError('TCN_LSTM_GRADIENT_PARAMETER_SHAPE_MISMATCH');
  let maximumAbsoluteError = 0, maximumRelativeError = 0;
  let sumSquaredError = 0;
  for (let index = 0; index < parameterPaths.length; index++) {
    const path = parameterPaths[index];
    const original = getPath(parameters, path);
    setPath(parameters, path, original + epsilon);
    const plus = (inspectTcnLstmForward(sequence, model, baselineLogit).probability - target) ** 2;
    setPath(parameters, path, original - epsilon);
    const minus = (inspectTcnLstmForward(sequence, model, baselineLogit).probability - target) ** 2;
    setPath(parameters, path, original);
    const numerical = (plus - minus) / (2 * epsilon);
    const exact = getPath(analytic.gradients, gradientPaths[index]);
    const absolute = Math.abs(numerical - exact);
    const relative = absolute / Math.max(1e-7, Math.abs(numerical), Math.abs(exact));
    maximumAbsoluteError = Math.max(maximumAbsoluteError, absolute);
    maximumRelativeError = Math.max(maximumRelativeError, relative);
    sumSquaredError += absolute * absolute;
  }
  return {
    parameter_count: parameterPaths.length,
    checked_parameters: parameterPaths.length,
    maximum_absolute_error: maximumAbsoluteError,
    maximum_relative_error: maximumRelativeError,
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

export function trainTcnLstmHybrid(trainingRows, {
  epochs = 8, learningRate = 0.0025, l2 = 0.0015,
  batchSize = 32, seed = 29, maxTrainingSamples = 2048,
  baselineFit = null, earlyStoppingPatience = 5
} = {}) {
  assertRows(trainingRows, 'TRAINING');
  if (!Number.isSafeInteger(batchSize) || batchSize < 4 || batchSize > 256 ||
      !Number.isSafeInteger(maxTrainingSamples) || maxTrainingSamples < 20 ||
      !Number.isSafeInteger(epochs) || epochs < 1 || epochs > 80 ||
      !Number.isSafeInteger(earlyStoppingPatience) || earlyStoppingPatience < 1)
    throw new TypeError('TCN_LSTM_TRAINING_CONFIGURATION_INVALID');
  const rate = clamp(Number(learningRate), 0.0001, 0.01);
  const regularization = clamp(Number(l2), 0, 0.2);
  if (!finite(rate) || !finite(regularization))
    throw new TypeError('TCN_LSTM_HYPERPARAMETER_INVALID');
  const ordered = [...trainingRows].sort((a, b) =>
    (finite(a.at) ? a.at : 0) - (finite(b.at) ? b.at : 0));
  const rows = ordered.slice(-Math.min(maxTrainingSamples, ordered.length));
  const support = assertRows(rows, 'EFFECTIVE_TRAINING');
  const anchor = baselineFit || fitTcnLstmLogisticAnchor(rows);
  if (!Array.isArray(anchor.weights) || anchor.weights.length !== BASELINE_FEATURES ||
      anchor.weights.some(value => !finite(value)) || !finite(anchor.bias))
    throw new TypeError('TCN_LSTM_TRAINING_ANCHOR_INVALID');

  const model = initializeModel(seed);
  let optimizer = {
    m: zerosLike(trainableParameters(model)),
    v: zerosLike(trainableParameters(model))
  };
  let updateStep = 0;
  const random = mulberry32(seed ^ 0xA5A5A5A5);
  const history = [];
  const initialBrier = evaluateBrier(rows, model, anchor);
  let bestBrier = initialBrier;
  let bestEpoch = 0;
  let bestModel = cloneTree(trainableParameters(model));
  let wait = 0, stoppedEarly = false;
  const patience = Math.min(12, Math.max(2, earlyStoppingPatience));

  for (let epoch = 1; epoch <= epochs; epoch++) {
    const order = Array.from({ length: rows.length }, (_, index) => index);
    for (let index = order.length - 1; index > 0; index--) {
      const swap = Math.floor(random() * (index + 1));
      [order[index], order[swap]] = [order[swap], order[index]];
    }
    let epochLoss = 0, seen = 0, maxGradientNorm = 0, clippedBatches = 0;
    const schedule = 0.1 + 0.9 * 0.5 *
      (1 + Math.cos(Math.PI * (epoch - 1) / Math.max(1, epochs - 1)));
    const epochRate = rate * schedule;

    for (let start = 0; start < order.length; start += batchSize) {
      const indexes = order.slice(start, Math.min(order.length, start + batchSize));
      let accumulated = zeroGradients(model);
      for (const index of indexes) {
        const row = rows[order[index]];
        const baselineLogit = predictTcnLstmLogisticLogit(row.sequence, anchor);
        const item = lossAndGradientsTcnLstmHybrid(
          row.sequence, row.target, model, baselineLogit
        );
        epochLoss += item.loss;
        seen++;
        accumulated = accumulateTree(accumulated, item.gradients);
      }
      let averaged = scaleTree(accumulated, 1 / indexes.length);
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

    const trainingBrier = evaluateBrier(rows, model, anchor);
    if (!finite(trainingBrier)) throw new TypeError('TCN_LSTM_TRAINING_BRIER_NON_FINITE');
    if (trainingBrier < bestBrier - 1e-8) {
      bestBrier = trainingBrier;
      bestEpoch = epoch;
      bestModel = cloneTree(trainableParameters(model));
      wait = 0;
    } else wait++;
    history.push({
      epoch,
      pre_update_mean_batch_brier: Number((epochLoss / Math.max(1, seen)).toFixed(8)),
      post_update_training_brier: Number(trainingBrier.toFixed(8)),
      learning_rate: Number(epochRate.toFixed(8)),
      maximum_batch_gradient_l2_norm: Number(maxGradientNorm.toFixed(8)),
      clipped_batches: clippedBatches,
      dropout: TCN_LSTM_DROPOUT
    });
    if (epoch >= Math.min(5, epochs) && wait >= patience) {
      stoppedEarly = true;
      break;
    }
  }

  Object.assign(model, cloneTree(bestModel));
  const finalBrier = evaluateBrier(rows, model, anchor);
  if (!finite(finalBrier) || !treeFinite(trainableParameters(model)))
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
    receptive_field: 1 + (TCN_LSTM_KERNEL_TAPS - 1) *
      TCN_LSTM_DILATIONS.reduce((sum, value) => sum + value, 0),
    attention: 'SINGLE_HEAD_QUERY_SOFTMAX_OVER_LSTM_HIDDEN_STATES',
    trainable_parameter_count: TCN_LSTM_PARAMETER_COUNT,
    dropout: TCN_LSTM_DROPOUT,
    dropout_policy: 'DISABLED_UNTIL_LOCKED_RECURRENT_DROPOUT_ABLATION_PASSES',
    model, baseline_fit: anchor,
    training: {
      rows: rows.length,
      positives: support.positive,
      negatives: support.negative,
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
      best_training_brier: Number(bestBrier.toFixed(8)),
      restored_best_training_checkpoint: true,
      validation_or_selection_or_holdout_used_for_fit: false,
      early_stopping: {
        monitor: 'TRAINING_PARTITION_BRIER_ONLY',
        patience,
        stopped_early: stoppedEarly
      },
      history
    },
    probability_ready: false,
    live_eligibility_ready: false,
    real_order_execution: false
  };
}

export function predictTcnLstmHybridProbability(sequence, profile) {
  if (!profile?.model || !profile?.baseline_fit)
    throw new TypeError('TCN_LSTM_PROFILE_NOT_TRAINED');
  const baselineLogit = predictTcnLstmLogisticLogit(sequence, profile.baseline_fit);
  return inspectTcnLstmForward(sequence, profile.model, baselineLogit).probability;
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
 * Predeclared LR/L2 calibration on inner selection only. The frozen Logistic
 * anchor is fit once on training rows and reused for every challenger config.
 */
export function selectTcnLstmHybridHyperparameters(trainingRows, selectionRows, {
  candidates = [
    { name: 'LR_0015_L2_0005', learningRate: 0.0015, l2: 0.0005, epochs: 6 },
    { name: 'LR_0025_L2_0015', learningRate: 0.0025, l2: 0.0015, epochs: 6 },
    { name: 'LR_0035_L2_0035', learningRate: 0.0035, l2: 0.0035, epochs: 6 }
  ],
  requiredImprovement = 0.00025,
  seed = 29,
  maxTrainingSamples = 2048
} = {}) {
  const trainSupport = assertRows(trainingRows, 'TRAINING');
  const selectionSupport = assertRows(selectionRows, 'SELECTION');
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 8)
    throw new TypeError('TCN_LSTM_HYPERPARAMETER_GRID_INVALID');
  if (!finite(requiredImprovement) || requiredImprovement < 0)
    throw new TypeError('TCN_LSTM_SELECTION_MARGIN_INVALID');
  const anchor = fitTcnLstmLogisticAnchor(trainingRows);
  const baselinePredictions = selectionRows.map(row =>
    sigmoid(predictTcnLstmLogisticLogit(row.sequence, anchor)));
  const baselineBrier = brierFrom(selectionRows, baselinePredictions);
  const evaluated = [];
  for (let index = 0; index < candidates.length; index++) {
    const config = candidates[index];
    if (!config || typeof config.name !== 'string' ||
        !finite(config.learningRate) || !finite(config.l2) ||
        !Number.isSafeInteger(config.epochs) || config.epochs < 1 || config.epochs > 30 ||
        config.dropout !== undefined && config.dropout !== 0)
      throw new TypeError('TCN_LSTM_HYPERPARAMETER_CANDIDATE_INVALID:' + index);
    const fit = trainTcnLstmHybrid(trainingRows, {
      epochs: config.epochs,
      learningRate: config.learningRate,
      l2: config.l2,
      seed: seed + index * 101,
      maxTrainingSamples,
      baselineFit: anchor
    });
    const predictions = selectionRows.map(row => predictTcnLstmHybridProbability(row.sequence, fit));
    const score = brierFrom(selectionRows, predictions);
    evaluated.push({
      name: config.name, config: { ...config, dropout: 0 },
      selection_brier: score,
      logistic_selection_brier: baselineBrier,
      improvement: baselineBrier - score,
      fit
    });
  }
  evaluated.sort((a, b) =>
    a.selection_brier - b.selection_brier || a.name.localeCompare(b.name));
  const winner = evaluated[0];
  const passed = winner.improvement > requiredImprovement;
  return {
    schema: TCN_LSTM_HYBRID_SCHEMA,
    status: passed ? 'INNER_SELECTION_QUALIFIED_RESEARCH_ONLY' : 'ABSTAIN_NO_INNER_SELECTION_SUPERIORITY',
    training_support: trainSupport,
    selection_support: selectionSupport,
    baseline: {
      kind: anchor.kind,
      training_rows: anchor.training_rows,
      selection_brier: Number(baselineBrier.toFixed(8))
    },
    candidates: evaluated.map(({ name, config, selection_brier, logistic_selection_brier, improvement }) => ({
      name, config,
      selection_brier: Number(selection_brier.toFixed(8)),
      logistic_selection_brier: Number(logistic_selection_brier.toFixed(8)),
      improvement: Number(improvement.toFixed(8)),
      passed_inner_margin: improvement > requiredImprovement
    })),
    selected_configuration: passed ? winner.name : null,
    required_inner_improvement: requiredImprovement,
    selected_fit: passed ? winner.fit : null,
    validation_or_holdout_used_for_fit_or_selection: false,
    probability_ready: false,
    live_eligibility_ready: false,
    real_order_execution: false
  };
}

export function benchmarkTcnLstmHybridInference(sequence, profile, {
  warmup = 10, iterations = 100
} = {}) {
  if (!Number.isSafeInteger(warmup) || warmup < 0 ||
      !Number.isSafeInteger(iterations) || iterations < 10 || iterations > 10000)
    throw new TypeError('TCN_LSTM_INFERENCE_BENCHMARK_CONFIGURATION_INVALID');
  for (let index = 0; index < warmup; index++)
    predictTcnLstmHybridProbability(sequence, profile);
  const durations = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    predictTcnLstmHybridProbability(sequence, profile);
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
    measurement: 'LOCAL_SINGLE_PROCESS_SYNCHRONOUS_WALL_CLOCK',
    production_latency_claim: false
  };
}

export function createTcnLstmHybridModelForAudit(seed = 29) {
  return initializeModel(seed);
}
