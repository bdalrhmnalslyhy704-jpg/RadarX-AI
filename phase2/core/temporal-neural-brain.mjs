/**
 * RadarX Build 224 — Temporal Convolutional Neural Brain
 *
 * A compact, causal, dilated, residual depthwise-separable TCN. It learns
 * from fixed windows of verified closed-candle features. It is a challenger:
 * it may publish probabilities only after chronological validation and an
 * untouched holdout beat both a prevalence and same-window pooled-logistic
 * baseline. This module is analysis-only.
 */
export const TEMPORAL_TARGET_DEFINITION =
  'FIRST_PASSAGE_2PCT_BEFORE_MINUS_2PCT_4H_V1';
export const TEMPORAL_SEQUENCE_STEPS = 24;
export const TEMPORAL_SEQUENCE_CHANNELS = 8;

const DILATIONS = Object.freeze([1, 2, 4]);
const KERNEL_TAPS = 2;
const HORIZON_MS = 4 * 60 * 60 * 1000;
const SEEDS = Object.freeze([13, 29, 47]);
const MIN_TRAIN = 160;
const MAX_TRAIN = 480;
const MIN_VALIDATION = 24;
const MIN_HOLDOUT = 40;
const LIVE_HOLDOUT = 100;
const EPSILON = 1e-8;

const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const logistic = value => 1 / (1 + Math.exp(-clamp(value, -12, 12)));
const targetOf = row => row.outcome === 'UP' ? 1 : row.outcome === 'DOWN' ? 0 : 0.5;

function validSequence(sequence) {
  return Array.isArray(sequence) && sequence.length === TEMPORAL_SEQUENCE_STEPS &&
    sequence.every(row => Array.isArray(row) && row.length === TEMPORAL_SEQUENCE_CHANNELS &&
      row.every(value => finite(value) !== null && Math.abs(Number(value)) <= 4));
}

function cleanRows(samples) {
  const seen = new Set();
  return (Array.isArray(samples) ? samples : []).filter(row => {
    if (!row || row.training_eligible !== true ||
        (row.closed_candle_baseline !== true && row.historical_baseline !== true) ||
        row.target_definition !== TEMPORAL_TARGET_DEFINITION ||
        !['UP', 'DOWN', 'FLAT'].includes(row.outcome) ||
        row.outcome_source !== (row.historical_baseline === true
          ? 'HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1'
          : 'CLOSED_CANDLE_4H_FIRST_PASSAGE_V1') ||
        !validSequence(row.temporal_sequence)) return false;
    const at = finite(row.at), resolvedAt = finite(row.resolved_at), horizon = finite(row.horizon_ms);
    const symbol = String(row.symbol || '').trim().toUpperCase();
    const id = String(row.id || '');
    const baseline = symbol + ':' + String(Math.trunc(at || 0));
    if (!id || !symbol || at === null || at <= 0 || resolvedAt === null ||
        resolvedAt - at !== HORIZON_MS || horizon !== HORIZON_MS ||
        seen.has(id) || seen.has(baseline)) return false;
    seen.add(id); seen.add(baseline);
    return true;
  }).map(row => ({
    id: String(row.id),
    symbol: String(row.symbol).toUpperCase(),
    at: Number(row.at),
    resolved_at: Number(row.resolved_at),
    outcome: row.outcome,
    target: targetOf(row),
    sequence: row.temporal_sequence.map(step => step.map(Number))
  })).sort((a, b) => a.at - b.at || a.symbol.localeCompare(b.symbol));
}

function zerosLike(value) {
  if (Array.isArray(value)) return value.map(zerosLike);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, zerosLike(child)]));
  }
  return 0;
}
function addTree(target, source) {
  if (Array.isArray(target)) {
    for (let index = 0; index < target.length; index++) addTree(target[index], source[index]);
  } else return target + source;
  return target;
}
function scaleTree(target, scale) {
  if (Array.isArray(target)) return target.map(value => scaleTree(value, scale));
  if (target && typeof target === 'object') {
    return Object.fromEntries(Object.entries(target).map(([key, value]) => [key, scaleTree(value, scale)]));
  }
  return target * scale;
}
function updateAdam(parameters, gradients, moments, variances, step, rate, l2) {
  if (Array.isArray(parameters)) {
    for (let index = 0; index < parameters.length; index++) {
      updateAdam(parameters[index], gradients[index], moments[index], variances[index], step, rate, l2);
    }
    return;
  }
  const gradient = clamp(gradients, -3, 3);
  const nextMoment = 0.9 * moments + 0.1 * gradient;
  const nextVariance = 0.999 * variances + 0.001 * gradient * gradient;
  const correctedMoment = nextMoment / (1 - Math.pow(0.9, step));
  const correctedVariance = nextVariance / (1 - Math.pow(0.999, step));
  const regularized = l2 * parameters;
  const updated = clamp(parameters - rate *
    (correctedMoment / (Math.sqrt(correctedVariance) + EPSILON) + regularized), -2.5, 2.5);
  // Numeric leaves are returned through their parent arrays below.
  return updated;
}
function adamTree(parameters, gradients, moments, variances, step, rate, l2) {
  if (Array.isArray(parameters)) {
    return parameters.map((value, index) =>
      adamTree(value, gradients[index], moments[index], variances[index], step, rate, l2));
  }
  const gradient = clamp(gradients, -3, 3);
  const moment = 0.9 * moments + 0.1 * gradient;
  const variance = 0.999 * variances + 0.001 * gradient * gradient;
  const correctedMoment = moment / (1 - Math.pow(0.9, step));
  const correctedVariance = variance / (1 - Math.pow(0.999, step));
  const value = clamp(parameters - rate *
    (correctedMoment / (Math.sqrt(correctedVariance) + EPSILON) + l2 * parameters), -2.5, 2.5);
  return { value, moment, variance };
}
function applyAdam(parameters, gradients, state, step, rate, l2) {
  const walk = (parameter, gradient, moment, variance) => {
    if (Array.isArray(parameter)) {
      const values = [], moments = [], variances = [];
      for (let index = 0; index < parameter.length; index++) {
        const next = walk(parameter[index], gradient[index], moment[index], variance[index]);
        values.push(next.value); moments.push(next.moment); variances.push(next.variance);
      }
      return { value: values, moment: moments, variance: variances };
    }
    if (parameter && typeof parameter === 'object') {
      const values = {}, moments = {}, variances = {};
      for (const key of Object.keys(parameter)) {
        const next = walk(parameter[key], gradient[key], moment[key], variance[key]);
        values[key] = next.value; moments[key] = next.moment; variances[key] = next.variance;
      }
      return { value: values, moment: moments, variance: variances };
    }
    const gradientValue = clamp(gradient, -3, 3);
    const nextMoment = 0.9 * moment + 0.1 * gradientValue;
    const nextVariance = 0.999 * variance + 0.001 * gradientValue * gradientValue;
    const mHat = nextMoment / (1 - Math.pow(0.9, step));
    const vHat = nextVariance / (1 - Math.pow(0.999, step));
    return {
      value: clamp(parameter - rate * (mHat / (Math.sqrt(vHat) + EPSILON) + l2 * parameter), -2.5, 2.5),
      moment: nextMoment,
      variance: nextVariance
    };
  };
  const next = walk(parameters, gradients, state.m, state.v);
  return { parameters: next.value, state: { m: next.moment, v: next.variance } };
}

function initializeModel(seed) {
  const channels = TEMPORAL_SEQUENCE_CHANNELS;
  const layers = DILATIONS.length;
  const offset = Number(seed) * 0.6180339887498949;
  const depthWeights = Array.from({ length: layers }, (_, layer) =>
    Array.from({ length: KERNEL_TAPS }, (_, tap) =>
      Array.from({ length: channels }, (_, channel) =>
        0.035 * Math.sin((layer + 1) * 4.17 + (tap + 1) * 6.31 + (channel + 1) * 2.13 + offset))));
  const pointWeights = Array.from({ length: layers }, (_, layer) =>
    Array.from({ length: channels }, (_, input) =>
      Array.from({ length: channels }, (_, output) =>
        0.025 * Math.cos((layer + 1) * 3.71 + (input + 1) * 2.91 + (output + 1) * 5.23 + offset))));
  const biases = Array.from({ length: layers }, (_, layer) =>
    Array.from({ length: channels }, (_, channel) =>
      0.002 * Math.sin((layer + 1) * 5.3 + (channel + 1) * 1.7 + offset)));
  const outputWeights = Array.from({ length: channels }, (_, channel) =>
    0.03 * Math.sin((channel + 1) * 2.47 + offset));
  return { depthWeights, pointWeights, biases, outputWeights, outputBias: 0 };
}

function forward(sequence, model) {
  const activations = [sequence];
  const depthCaches = [];
  for (let layer = 0; layer < DILATIONS.length; layer++) {
    const input = activations[layer];
    const dilation = DILATIONS[layer];
    const depth = input.map((row, time) => row.map((_, channel) => {
      let value = input[time][channel];
      for (let tap = 1; tap <= KERNEL_TAPS; tap++) {
        const previous = time - tap * dilation;
        if (previous >= 0) value += model.depthWeights[layer][tap - 1][channel] * input[previous][channel];
      }
      return value;
    }));
    const output = depth.map((row, time) => row.map((_, outputChannel) => {
      let value = input[time][outputChannel] + model.biases[layer][outputChannel];
      for (let inputChannel = 0; inputChannel < TEMPORAL_SEQUENCE_CHANNELS; inputChannel++) {
        value += depth[time][inputChannel] * model.pointWeights[layer][inputChannel][outputChannel];
      }
      return Math.tanh(value);
    }));
    depthCaches.push(depth);
    activations.push(output);
  }
  const final = activations.at(-1);
  const poolStart = Math.max(0, final.length - 8);
  const pooled = Array(TEMPORAL_SEQUENCE_CHANNELS).fill(0);
  const poolCount = final.length - poolStart;
  for (let time = poolStart; time < final.length; time++) {
    for (let channel = 0; channel < pooled.length; channel++) pooled[channel] += final[time][channel] / poolCount;
  }
  let logit = model.outputBias;
  for (let channel = 0; channel < pooled.length; channel++) logit += pooled[channel] * model.outputWeights[channel];
  return { probability: logistic(logit), activations, depthCaches, pooled, poolStart, poolCount };
}

function gradientsFor(sequence, target, model, cache) {
  const gradients = zerosLike(model);
  const activationGradients = Array(DILATIONS.length + 1);
  const final = cache.activations.at(-1);
  activationGradients[DILATIONS.length] = final.map(() => Array(TEMPORAL_SEQUENCE_CHANNELS).fill(0));
  const error = cache.probability - target;
  gradients.outputBias = error;
  for (let channel = 0; channel < TEMPORAL_SEQUENCE_CHANNELS; channel++) {
    gradients.outputWeights[channel] = error * cache.pooled[channel];
    for (let time = cache.poolStart; time < final.length; time++) {
      activationGradients[DILATIONS.length][time][channel] +=
        error * model.outputWeights[channel] / cache.poolCount;
    }
  }

  for (let layer = DILATIONS.length - 1; layer >= 0; layer--) {
    const input = cache.activations[layer];
    const output = cache.activations[layer + 1];
    const depth = cache.depthCaches[layer];
    const dilation = DILATIONS[layer];
    const inputGradient = input.map(() => Array(TEMPORAL_SEQUENCE_CHANNELS).fill(0));
    const outputGradient = activationGradients[layer + 1];
    for (let time = 0; time < output.length; time++) {
      for (let outputChannel = 0; outputChannel < TEMPORAL_SEQUENCE_CHANNELS; outputChannel++) {
        const activation = output[time][outputChannel];
        const dz = outputGradient[time][outputChannel] * (1 - activation * activation);
        gradients.biases[layer][outputChannel] += dz;
        // Residual identity path.
        inputGradient[time][outputChannel] += dz;
        for (let inputChannel = 0; inputChannel < TEMPORAL_SEQUENCE_CHANNELS; inputChannel++) {
          gradients.pointWeights[layer][inputChannel][outputChannel] += depth[time][inputChannel] * dz;
          const depthGradient = model.pointWeights[layer][inputChannel][outputChannel] * dz;
          inputGradient[time][inputChannel] += depthGradient;
          for (let tap = 1; tap <= KERNEL_TAPS; tap++) {
            const previous = time - tap * dilation;
            if (previous < 0) continue;
            gradients.depthWeights[layer][tap - 1][inputChannel] +=
              input[previous][inputChannel] * depthGradient;
            inputGradient[previous][inputChannel] +=
              model.depthWeights[layer][tap - 1][inputChannel] * depthGradient;
          }
        }
      }
    }
    activationGradients[layer] = inputGradient;
  }
  return gradients;
}

function fitMember(rows, seed, { epochs = 10, learningRate = 0.006, l2 = 0.012 } = {}) {
  const model = initializeModel(seed);
  let optimizer = { m: zerosLike(model), v: zerosLike(model) };
  for (let epoch = 1; epoch <= epochs; epoch++) {
    const gradient = zerosLike(model);
    for (const row of rows) {
      const cache = forward(row.sequence, model);
      const itemGradient = gradientsFor(row.sequence, row.target, model, cache);
      const plus = (target, source) => Array.isArray(target)
        ? target.map((value, index) => plus(value, source[index]))
        : target + source;
      for (const key of ['depthWeights', 'pointWeights', 'biases', 'outputWeights']) {
        gradient[key] = plus(gradient[key], itemGradient[key]);
      }
      gradient.outputBias += itemGradient.outputBias;
    }
    const averaged = scaleTree(gradient, 1 / Math.max(1, rows.length));
    const step = applyAdam(model, averaged, optimizer, epoch, learningRate, l2);
    Object.assign(model, step.parameters);
    optimizer = step.state;
  }
  return model;
}

function predict(sequence, fitted) {
  if (!validSequence(sequence) || !fitted) return null;
  const predictions = fitted.members.map(member => forward(sequence, member).probability);
  if (!predictions.length || predictions.some(value => !Number.isFinite(value))) return null;
  return clamp(mean(predictions), 0.02, 0.98);
}

function pooledSequence(sequence) {
  const output = [];
  for (let channel = 0; channel < TEMPORAL_SEQUENCE_CHANNELS; channel++) {
    output.push(mean(sequence.map(row => row[channel])) ?? 0);
  }
  for (let channel = 0; channel < TEMPORAL_SEQUENCE_CHANNELS; channel++) {
    output.push(mean(sequence.slice(-8).map(row => row[channel])) ?? 0);
  }
  return output;
}
function fitLogistic(rows, { iterations = 500, learningRate = 0.08, l2 = 0.05 } = {}) {
  const vectors = rows.map(row => pooledSequence(row.sequence));
  const targets = rows.map(row => row.target);
  const baseRate = (targets.reduce((sum, value) => sum + value, 0) + 2) / (targets.length + 4);
  const weights = Array(vectors[0]?.length || 16).fill(0);
  let bias = Math.log(baseRate / (1 - baseRate));
  for (let epoch = 0; epoch < iterations; epoch++) {
    const grad = Array(weights.length).fill(0);
    let gradBias = 0;
    for (let index = 0; index < vectors.length; index++) {
      let logit = bias;
      for (let feature = 0; feature < weights.length; feature++) logit += weights[feature] * vectors[index][feature];
      const error = logistic(logit) - targets[index];
      gradBias += error;
      for (let feature = 0; feature < weights.length; feature++) grad[feature] += error * vectors[index][feature];
    }
    bias -= learningRate * gradBias / vectors.length;
    for (let feature = 0; feature < weights.length; feature++) {
      weights[feature] = clamp(weights[feature] - learningRate *
        (grad[feature] / vectors.length + l2 * weights[feature]), -4, 4);
    }
  }
  return { weights, bias, base_rate: baseRate };
}
function predictLogistic(sequence, model) {
  const vector = pooledSequence(sequence);
  let value = model.bias;
  for (let index = 0; index < model.weights.length; index++) value += model.weights[index] * vector[index];
  return logistic(value);
}
function evaluate(rows, predictFn, baseRate) {
  if (!rows.length) return {
    evaluated: false, sample_count: 0, model_brier_score: null,
    base_rate_brier_score: null, beat_base_rate: false
  };
  const predictions = rows.map(row => predictFn(row.sequence));
  const targets = rows.map(row => row.target);
  if (predictions.some(value => !Number.isFinite(value))) return {
    evaluated: false, sample_count: rows.length, model_brier_score: null,
    base_rate_brier_score: null, beat_base_rate: false, reason: 'NON_FINITE_TEMPORAL_PREDICTION'
  };
  const modelBrier = mean(predictions.map((value, index) => (value - targets[index]) ** 2));
  const baseBrier = mean(targets.map(target => (baseRate - target) ** 2));
  const logLoss = mean(predictions.map((value, index) => {
    const probability = clamp(value, 0.001, 0.999);
    return -(targets[index] * Math.log(probability) + (1 - targets[index]) * Math.log(1 - probability));
  }));
  const directional = rows.filter(row => row.outcome !== 'FLAT');
  const correct = directional.filter(row =>
    ((predictFn(row.sequence) >= 0.5) === (row.outcome === 'UP'))).length;
  return {
    evaluated: true, sample_count: rows.length,
    model_brier_score: Number(modelBrier.toFixed(5)),
    base_rate_brier_score: Number(baseBrier.toFixed(5)),
    log_loss: Number(logLoss.toFixed(5)),
    directional_accuracy_pct: directional.length ? Number((correct / directional.length * 100).toFixed(1)) : null,
    beat_base_rate: modelBrier + 0.002 < baseBrier,
    improvement_vs_base_rate: Number((baseBrier - modelBrier).toFixed(5))
  };
}
function fitEnsemble(rows, options = {}) {
  const members = SEEDS.map(seed => fitMember(rows, seed, options));
  return { members, seeds: [...SEEDS], architecture: 'TCN_24x8_DILATED_RESIDUAL_DEPTHWISE_ENSEMBLE_V1' };
}

export function buildTemporalNeuralProfile(samples = [], {
  minTrainingSamples = MIN_TRAIN, maxTrainingSamples = MAX_TRAIN,
  minimumValidationSamples = MIN_VALIDATION, minimumHoldoutSamples = MIN_HOLDOUT,
  liveHoldoutSamples = LIVE_HOLDOUT, epochs = 10,
  learningRate = 0.006, l2 = 0.012, comparisonMargin = 0.003
} = {}) {
  const rows = cleanRows(samples);
  const uniqueTimes = [...new Set(rows.map(row => row.at))].sort((a, b) => a - b);
  // minimumValidationSamples/minimumHoldoutSamples count observations, not
  // timestamps. Keep every symbol observed at one close-time in one block.
  const holdoutCount = Math.max(2, Math.floor(uniqueTimes.length * 0.2));
  const validationCount = Math.max(2, Math.floor(uniqueTimes.length * 0.2));
  const trainingEndIndex = uniqueTimes.length - holdoutCount - validationCount;
  const enoughSplit = trainingEndIndex > 0;
  if (!enoughSplit) return {
    status: 'WAITING_FOR_TEMPORAL_FIRST_PASSAGE_SAMPLES',
    architecture: 'TCN_24x8_DILATED_RESIDUAL_DEPTHWISE_ENSEMBLE_V1',
    target_definition: TEMPORAL_TARGET_DEFINITION,
    sequence_steps: TEMPORAL_SEQUENCE_STEPS, sequence_channels: TEMPORAL_SEQUENCE_CHANNELS,
    ensemble_members: 0, ensemble_members_required: SEEDS.length,
    resolved_samples: rows.length, training_samples: 0, validation_samples: 0, holdout_samples: 0,
    required_training_samples: minTrainingSamples, required_validation_samples: minimumValidationSamples,
    required_holdout_samples: minimumHoldoutSamples, probability_ready: false, live_eligibility_ready: false,
    validation_start_at:null,holdout_start_at:null,max_training_outcome_resolved_at:null,
    trained: false, selected: false, validation: { evaluated: false, reason: 'THREE_CHRONOLOGICAL_BLOCKS_REQUIRED' },
    holdout: { evaluated: false, reason: 'THREE_CHRONOLOGICAL_BLOCKS_REQUIRED' },
    holdout_comparison: { passed: false, required_live_holdout_samples: liveHoldoutSamples },
    _fit: null, _baseline_fit: null
  };

  const validationStart = uniqueTimes[trainingEndIndex];
  const holdoutStart = uniqueTimes[uniqueTimes.length - holdoutCount];
  const trainingPool = rows.filter(row => row.at < validationStart);
  const training = trainingPool.filter(row => row.resolved_at < validationStart).slice(-Math.max(minTrainingSamples, maxTrainingSamples));
  const validationPool = rows.filter(row => row.at >= validationStart && row.at < holdoutStart);
  const validation = validationPool.filter(row => row.resolved_at < holdoutStart);
  const holdout = rows.filter(row => row.at >= holdoutStart);
  const maxTrainingOutcomeResolvedAt=training.length
    ?Math.max(...training.map(row=>row.resolved_at)):null;
  if (training.length < minTrainingSamples || validation.length < minimumValidationSamples ||
      holdout.length < minimumHoldoutSamples) return {
    status: 'WAITING_FOR_TEMPORAL_FIRST_PASSAGE_SAMPLES',
    architecture: 'TCN_24x8_DILATED_RESIDUAL_DEPTHWISE_ENSEMBLE_V1',
    target_definition: TEMPORAL_TARGET_DEFINITION,
    sequence_steps: TEMPORAL_SEQUENCE_STEPS, sequence_channels: TEMPORAL_SEQUENCE_CHANNELS,
    ensemble_members: 0, ensemble_members_required: SEEDS.length,
    resolved_samples: rows.length, training_samples: training.length,
    validation_samples: validation.length, holdout_samples: holdout.length,
    required_training_samples: minTrainingSamples, required_validation_samples: minimumValidationSamples,
    required_holdout_samples: minimumHoldoutSamples, probability_ready: false, live_eligibility_ready: false,
    validation_start_at:validationStart,holdout_start_at:holdoutStart,
    max_training_outcome_resolved_at:maxTrainingOutcomeResolvedAt,
    trained: false, selected: false, validation: { evaluated: false, reason: 'TEMPORAL_CHRONOLOGICAL_SAMPLE_MINIMUMS_NOT_MET' },
    holdout: { evaluated: false, reason: 'TEMPORAL_CHRONOLOGICAL_SAMPLE_MINIMUMS_NOT_MET' },
    holdout_comparison: { passed: false, required_live_holdout_samples: liveHoldoutSamples },
    _fit: null, _baseline_fit: null
  };

  const fitRows = training.slice(-Math.max(minTrainingSamples, maxTrainingSamples));
  const targets = fitRows.map(row => row.target);
  const baseRate = (targets.reduce((sum, value) => sum + value, 0) + 2) / (targets.length + 4);
  const fit = fitEnsemble(fitRows, { epochs, learningRate, l2 });
  const baseline = fitLogistic(fitRows);
  const tcnValidation = evaluate(validation, sequence => {
    const value = predict(sequence, fit);
    return value;
  }, baseRate);
  const baselineValidation = evaluate(validation, sequence => predictLogistic(sequence, baseline), baseline.base_rate);
  const selected = tcnValidation.evaluated && baselineValidation.evaluated &&
    tcnValidation.beat_base_rate === true &&
    tcnValidation.model_brier_score + comparisonMargin < baselineValidation.model_brier_score;
  const tcnHoldout = evaluate(holdout, sequence => predict(sequence, fit), baseRate);
  const baselineHoldout = evaluate(holdout, sequence => predictLogistic(sequence, baseline), baseline.base_rate);
  const holdoutPassed = selected && tcnHoldout.evaluated && baselineHoldout.evaluated &&
    tcnHoldout.beat_base_rate === true &&
    tcnHoldout.model_brier_score + comparisonMargin < baselineHoldout.model_brier_score;
  const probabilityReady = holdoutPassed === true;
  const liveReady = probabilityReady && holdout.length >= liveHoldoutSamples;
  return {
    status: !selected ? 'VALIDATION_DID_NOT_BEAT_POOLED_BASELINE' :
      !holdoutPassed ? 'VALIDATION_PASSED_HOLDOUT_NOT_PASSED' :
      liveReady ? 'LIVE_GATE_PASSED_OUT_OF_SAMPLE' : 'OUT_OF_SAMPLE_VALIDATED_PAPER_ONLY',
    architecture: fit.architecture,
    target_definition: TEMPORAL_TARGET_DEFINITION,
    sequence_steps: TEMPORAL_SEQUENCE_STEPS, sequence_channels: TEMPORAL_SEQUENCE_CHANNELS,
    ensemble_members: fit.members.length, ensemble_members_required: SEEDS.length,
    resolved_samples: rows.length, training_samples: fitRows.length,
    validation_samples: validation.length, holdout_samples: holdout.length,
    required_training_samples: minTrainingSamples, required_validation_samples: minimumValidationSamples,
    required_holdout_samples: minimumHoldoutSamples,
    validation_start_at:validationStart,holdout_start_at:holdoutStart,
    max_training_outcome_resolved_at:maxTrainingOutcomeResolvedAt,
    training_positive_rate_pct: Number((baseRate * 100).toFixed(1)),
    trained: true, selected, probability_ready: probabilityReady, live_eligibility_ready: liveReady,
    validation: {
      ...tcnValidation,
      selected_over_pooled_logistic: selected,
      pooled_logistic_brier_score: baselineValidation.model_brier_score
    },
    holdout: {
      ...tcnHoldout,
      pooled_logistic_brier_score: baselineHoldout.model_brier_score
    },
    holdout_comparison: {
      sample_count: holdout.length, required_live_holdout_samples: liveHoldoutSamples,
      required_brier_margin: comparisonMargin,
      tcn_brier_score: tcnHoldout.model_brier_score,
      pooled_logistic_brier_score: baselineHoldout.model_brier_score,
      beats_base_rate: tcnHoldout.beat_base_rate === true,
      beats_pooled_logistic: baselineHoldout.evaluated === true &&
        tcnHoldout.evaluated === true &&
        tcnHoldout.model_brier_score + comparisonMargin < baselineHoldout.model_brier_score,
      passed: holdoutPassed
    },
    _fit: probabilityReady ? fit : null,
    _baseline_fit: baseline
  };
}

export function predictTemporalProbability(sequence, profile = {}) {
  if (profile?.probability_ready !== true || !profile?._fit || !validSequence(sequence)) return null;
  return predict(sequence, profile._fit);
}
