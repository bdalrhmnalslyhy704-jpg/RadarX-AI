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
  'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2';
export const TEMPORAL_SEQUENCE_STEPS = 24;
export const TEMPORAL_SEQUENCE_CHANNELS=29;
export const TEMPORAL_MODEL_ARCHITECTURE='TCN_24x29_DILATED_RESIDUAL_BTC_CONTEXT_GATED_MASKED_MICRO_ENSEMBLE_V6';

const DILATIONS = Object.freeze([1, 2, 4]);
const KERNEL_TAPS = 2;
const HORIZON_MS = 4 * 60 * 60 * 1000;
const SEEDS = Object.freeze([13, 29, 47]);
const MIN_TRAIN = 160;
const MAX_TRAIN = 1280;
const MIN_VALIDATION = 24;
const MIN_HOLDOUT = 40;
const LIVE_HOLDOUT = 150;
const EPSILON = 1e-8;

const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const logistic = value => 1 / (1 + Math.exp(-clamp(value, -12, 12)));
export function temporalBinaryTarget(outcome) {
  // This network estimates the chance of reaching +3% before -2%.
  // DOWN and FLAT both mean that the success event did not occur.
  return outcome === 'UP' ? 1 : 0;
}
const targetOf = row => temporalBinaryTarget(row.outcome);

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
        row.first_passage?.path_resolution !== '15M' ||
        row.first_passage?.outcome !== row.outcome ||
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

function initializeModel(seed, baseRate = 0.5, baselineFit = null) {
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
  // The shared TCN starts from a pooled-sequence logistic fit trained only
  // on the chronological training block. The convolutional stack learns an
  // additive temporal residual; it cannot erase the linear anchor.
  // A zero output head blocks gradients from reaching every temporal layer
  // during the first epoch. Start with a tiny deterministic seed-shaped head:
  // it preserves the frozen logistic anchor while allowing full backpropagation
  // from the first training pass without adding runtime randomness.
  const outputWeights = Array.from({ length: channels }, (_, channel) =>
    0.01 * Math.sin((channel + 1) * 4.73 + offset));
  const prior=clamp(Number(baseRate)||0.5,0.02,0.98);
  const baselineWeights=Array.isArray(baselineFit?.weights)&&baselineFit.weights.length===channels*2
    ?baselineFit.weights.map(value=>clamp(Number(value)||0,-4,4)):Array(channels*2).fill(0);
  const baselineBias=Number.isFinite(Number(baselineFit?.bias))
    ?Number(baselineFit.bias):Math.log(prior/(1-prior));
  return {
    depthWeights,pointWeights,biases,outputWeights,
    skipWeights:baselineWeights,outputBias:baselineBias,
    baseline_by_regime:null,
    residual_anchor:baselineFit?'TRAINING_ONLY_LOGISTIC_ANCHOR':'TRAINING_PREVALENCE_PRIOR'
  };
}

function forward(sequence, model, residualScale=1) {
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
  // The causal receptive field spans the 24-step window. Pool the latest
  // 12 states, so older multi-hour setup/market-regime context contributes.
  const poolStart=Math.max(0,final.length-12);
  const pooled = Array(TEMPORAL_SEQUENCE_CHANNELS).fill(0);
  const poolCount = final.length - poolStart;
  for (let time = poolStart; time < final.length; time++) {
    for (let channel = 0; channel < pooled.length; channel++) pooled[channel] += final[time][channel] / poolCount;
  }
  const baselineFeatures=pooledSequence(sequence);
  // Each BTC regime uses its own logistic anchor fitted only on the shared
  // chronological training block. This matches the regime-specific logistic
  // challenger used in validation/holdout; the TCN residual learns only what
  // is additional to that regime's linear signal.
  const regimeBaseline=model.baseline_by_regime?.[regimeOfSequence(sequence)]||null;
  const baselineWeights=Array.isArray(regimeBaseline?.weights)
    ?regimeBaseline.weights:model.skipWeights;
  const baselineBias=Number.isFinite(Number(regimeBaseline?.bias))
    ?Number(regimeBaseline.bias):model.outputBias;
  let logit = baselineBias;
  for(let feature=0;feature<baselineFeatures.length;feature++){
    logit+=baselineFeatures[feature]*(Number(baselineWeights?.[feature])||0);
  }
  const boundedResidualScale=clamp(Number(residualScale)||0,0,1);
  for (let channel = 0; channel < pooled.length; channel++) logit += pooled[channel] * model.outputWeights[channel] * boundedResidualScale;
  return { probability: logistic(logit), activations, depthCaches, pooled, poolStart, poolCount, baselineFeatures };
}

function gradientsFor(sequence, target, model, cache) {
  const gradients = zerosLike(model);
  const activationGradients = Array(DILATIONS.length + 1);
  const final = cache.activations.at(-1);
  activationGradients[DILATIONS.length] = final.map(() => Array(TEMPORAL_SEQUENCE_CHANNELS).fill(0));
  const error = 2 * (cache.probability - target) * cache.probability * (1 - cache.probability);
  // outputBias and skipWeights are frozen at the training-only logistic anchor.
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

function fitMember(rows, seed, {
  epochs = 10, learningRate = 0.006, l2 = 0.012,
  baseRate = 0.5, baselineFit = null, baselineByRegime = null
} = {}) {
  const model = initializeModel(seed,baseRate,baselineFit);
  model.baseline_by_regime=baselineByRegime&&typeof baselineByRegime==='object'
    ?baselineByRegime:null;
  const trainableParameters=()=>({
    depthWeights:model.depthWeights,pointWeights:model.pointWeights,
    biases:model.biases,outputWeights:model.outputWeights
  });
  let optimizer = { m: zerosLike(trainableParameters()), v: zerosLike(trainableParameters()) };
  for (let epoch = 1; epoch <= epochs; epoch++) {
    const gradient = zerosLike(trainableParameters());
    for (const row of rows) {
      const cache = forward(row.sequence, model);
      const itemGradient = gradientsFor(row.sequence, row.target, model, cache);
      const plus = (target, source) => Array.isArray(target)
        ? target.map((value, index) => plus(value, source[index]))
        : target + source;
      for (const key of ['depthWeights', 'pointWeights', 'biases', 'outputWeights']) {
        gradient[key] = plus(gradient[key], itemGradient[key]);
      }
    }
    const averaged = scaleTree(gradient, 1 / Math.max(1, rows.length));
    const step = applyAdam(trainableParameters(), averaged, optimizer, epoch, learningRate, l2);
    // Only convolutional trainable parameters are replaced. The pooled logistic
    // weights and intercept remain frozen as a stable, training-only anchor.
    Object.assign(model, step.parameters);
    optimizer = step.state;
  }
  return model;
}

function calibratedProbability(rawProbability, calibrator) {
  if(!Number.isFinite(rawProbability))return null;
  const raw=clamp(rawProbability,0.02,0.98);
  if(calibrator?.fitted!==true)return raw;
  const rawLogit=Math.log(raw/(1-raw));
  return clamp(logistic(
    clamp(Number(calibrator.slope)||1,0.5,1.5)*rawLogit+
    clamp(Number(calibrator.intercept)||0,-0.75,0.75)
  ),0.02,0.98);
}

// A small two-parameter Brier calibrator is fitted only on the disjoint
// chronological regime-selection block. Validation and final holdout are
// never used to fit the slope/intercept. Strong shrinkage keeps small samples
// close to the identity transform; under-supported blocks stay uncalibrated.
function fitSelectionProbabilityCalibrator(rows, predictFn, {
  minimumSamples=18,minimumPositive=3,minimumNegative=10,
  iterations=240,learningRate=0.05,regularization=0.18,
  fitOn='REGIME_SELECTION_ONLY'
}={}) {
  const predictions=(Array.isArray(rows)?rows:[]).map(row=>({
    probability:predictFn(row.sequence),
    target:row.target
  })).filter(row=>Number.isFinite(row.probability)&&
    Number.isFinite(row.target));
  const positive=predictions.filter(row=>row.target===1).length;
  const negative=predictions.length-positive;
  const base={
    method:'CALIBRATION_BLOCK_SHRUNK_BRIER_PLATT_V2',
    fit_on:String(fitOn||'REGIME_SELECTION_ONLY'),
    sample_count:predictions.length,
    positive_count:positive,
    negative_count:negative,
    slope:1,
    intercept:0,
    fitted:false
  };
  if(predictions.length<minimumSamples||positive<minimumPositive||negative<minimumNegative){
    return {...base,reason:'SELECTION_BLOCK_CLASS_SUPPORT_BELOW_CALIBRATION_MINIMUM'};
  }
  const points=predictions.map(row=>{
    const p=clamp(row.probability,0.02,0.98);
    return {x:Math.log(p/(1-p)),target:row.target};
  });
  let slope=1,intercept=0;
  for(let iteration=0;iteration<iterations;iteration++){
    let slopeGradient=0,interceptGradient=0;
    for(const point of points){
      const prediction=logistic(slope*point.x+intercept);
      const error=prediction-point.target;
      const derivative=prediction*(1-prediction);
      slopeGradient+=2*error*derivative*point.x;
      interceptGradient+=2*error*derivative;
    }
    slopeGradient=slopeGradient/points.length+regularization*(slope-1);
    interceptGradient=interceptGradient/points.length+regularization*intercept;
    slope=clamp(slope-learningRate*slopeGradient,0.5,1.5);
    intercept=clamp(intercept-learningRate*interceptGradient,-0.75,0.75);
  }
  return {
    ...base,fitted:true,slope:Number(slope.toFixed(5)),
    intercept:Number(intercept.toFixed(5)),reason:null
  };
}

function predict(sequence, fitted) {
  if (!validSequence(sequence) || !fitted) return null;
  const regime=regimeOfSequence(sequence);
  const selectedIndex=Number.isInteger(fitted.selected_member_by_regime?.[regime])
    ?fitted.selected_member_by_regime[regime]
    :Number.isInteger(fitted.selected_member_index)?fitted.selected_member_index:-1;
  let rawProbability;
  if(selectedIndex>=0&&selectedIndex<fitted.members.length){
    rawProbability=forward(sequence,fitted.members[selectedIndex],fitted.residual_scales_by_regime?.[regime]??1).probability;
  }else{
    const predictions=fitted.members.map(member=>forward(sequence,member).probability);
    if(!predictions.length||predictions.some(value=>!Number.isFinite(value)))return null;
    rawProbability=mean(predictions);
  }
  return calibratedProbability(rawProbability,fitted.probability_calibrators_by_regime?.[regime]);
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
    evaluated:false,sample_count:0,positive_count:0,negative_count:0,positive_rate_pct:null,
    model_brier_score:null,base_rate_brier_score:null,beat_base_rate:false
  };
  const predictions = rows.map(row => predictFn(row.sequence));
  const targets=rows.map(row=>row.target);
  const positiveCount=targets.reduce((sum,target)=>sum+(target===1?1:0),0);
  const negativeCount=targets.length-positiveCount;
  const positiveRatePct=targets.length?Number((positiveCount/targets.length*100).toFixed(2)):null;
  if (predictions.some(value => !Number.isFinite(value))) return {
    evaluated:false,sample_count:rows.length,positive_count:positiveCount,
    negative_count:negativeCount,positive_rate_pct:positiveRatePct,
    model_brier_score:null,base_rate_brier_score:null,beat_base_rate:false,
    reason:'NON_FINITE_TEMPORAL_PREDICTION'
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
    evaluated:true,sample_count:rows.length,
    positive_count:positiveCount,negative_count:negativeCount,positive_rate_pct:positiveRatePct,
    model_brier_score:Number(modelBrier.toFixed(5)),
    base_rate_brier_score: Number(baseBrier.toFixed(5)),
    log_loss: Number(logLoss.toFixed(5)),
    directional_accuracy_pct: directional.length ? Number((correct / directional.length * 100).toFixed(1)) : null,
    beat_base_rate: modelBrier + 0.002 < baseBrier,
    improvement_vs_base_rate: Number((baseBrier - modelBrier).toFixed(5))
  };
}

function aggregateEvaluations(entries){
  const valid=(Array.isArray(entries)?entries:[]).filter(row=>row?.evaluated===true&&
    Number(row.sample_count)>0&&Number.isFinite(Number(row.model_brier_score))&&
    Number.isFinite(Number(row.base_rate_brier_score)));
  const count=valid.reduce((sum,row)=>sum+Number(row.sample_count),0);
  if(!count)return {evaluated:false,sample_count:0,positive_count:0,negative_count:0,
    positive_rate_pct:null,model_brier_score:null,base_rate_brier_score:null,beat_base_rate:false};
  const weighted=key=>valid.reduce((sum,row)=>sum+Number(row[key])*Number(row.sample_count),0)/count;
  const model=weighted('model_brier_score'),base=weighted('base_rate_brier_score');
  const positive=valid.reduce((sum,row)=>sum+Number(row.positive_count||0),0);
  const negative=count-positive;
  const directionalRows=valid.filter(row=>Number.isFinite(Number(row.directional_accuracy_pct)));
  const directionalCount=directionalRows.reduce((sum,row)=>sum+Number(row.sample_count),0);
  return {
    evaluated:true,sample_count:count,positive_count:positive,negative_count:negative,
    positive_rate_pct:Number((positive/count*100).toFixed(2)),
    model_brier_score:Number(model.toFixed(5)),base_rate_brier_score:Number(base.toFixed(5)),
    log_loss:valid.every(row=>Number.isFinite(Number(row.log_loss)))?Number(weighted('log_loss').toFixed(5)):null,
    directional_accuracy_pct:directionalCount?Number((directionalRows.reduce((sum,row)=>sum+
      Number(row.directional_accuracy_pct)*Number(row.sample_count),0)/directionalCount).toFixed(1)):null,
    beat_base_rate:model+0.002<base,
    improvement_vs_base_rate:Number((base-model).toFixed(5))
  };
}
function fitEnsemble(rows, options = {}) {
  const baseRate=Number.isFinite(Number(options.baseRate))
    ?clamp(Number(options.baseRate),0.02,0.98)
    :(rows.reduce((sum,row)=>sum+row.target,0)+2)/(rows.length+4);
  // Keep three deterministic members but vary fit duration and regularization.
  // This reduces dependence on one arbitrary optimizer schedule while retaining
  // the same training-only logistic anchor for every member.
  const baseEpochs=Math.max(1,Math.trunc(Number(options.epochs)||10));
  const baseLearningRate=Math.max(0.0001,Number(options.learningRate)||0.006);
  const baseL2=Math.max(0,Number(options.l2)||0.012);
  const memberProfiles=[
    {epochs:Math.max(1,Math.ceil(baseEpochs*0.75)),learningRate:baseLearningRate*0.9,l2:baseL2*1.5},
    {epochs:baseEpochs,learningRate:baseLearningRate,l2:baseL2},
    {epochs:Math.max(1,Math.ceil(baseEpochs*1.5)),learningRate:baseLearningRate*0.75,l2:baseL2*2}
  ];
  const members=SEEDS.map((seed,index)=>fitMember(rows,seed,{
    ...options,...memberProfiles[index],baseRate
  }));
  return {
    members,seeds:[...SEEDS],
    architecture:TEMPORAL_MODEL_ARCHITECTURE,
    training_strategy:'BRIER_OPTIMIZED_REGIME_ANCHORED_NESTED_SELECTION_CALIBRATION_TCN_V11',
    baseline_anchor:'REGIME_SPECIFIC_TRAINING_ONLY_LOGISTIC_V1',
    member_training_profiles:memberProfiles,
    residual_scale_selection:'REGIME_SELECTION_BLOCK_BRIER_GRID_V1',
    training_objective:'UNWEIGHTED_BRIER_PROPER_SCORING_RULE',
    candidate_residual_scales:[0,0.25,0.5,0.75,1],
    training_prior_probability:baseRate
  };
}

function regimeOfSequence(sequence){
  const last=Array.isArray(sequence)?sequence[TEMPORAL_SEQUENCE_STEPS-1]:null;
  const btc24h=finite(last?.[19]);
  if(btc24h===null)return null;
  return btc24h>=0?'BTC_RISK_ON':'BTC_RISK_OFF';
}

export function buildTemporalNeuralProfile(samples = [], {
  minTrainingSamples=MIN_TRAIN,maxTrainingSamples=MAX_TRAIN,
  minimumValidationSamples=MIN_VALIDATION,minimumHoldoutSamples=MIN_HOLDOUT,
  liveHoldoutSamples=LIVE_HOLDOUT,epochs=10,
  learningRate=0.006,l2=0.012,comparisonMargin=0.003
}={}){
  const rows=cleanRows(samples);
  const regimes=['BTC_RISK_ON','BTC_RISK_OFF'];
  const uniqueTimes=[...new Set(rows.map(row=>row.at))].sort((a,b)=>a-b);
  const rowsByTime=new Map();
  for(const row of rows){
    if(!rowsByTime.has(row.at))rowsByTime.set(row.at,[]);
    rowsByTime.get(row.at).push(row);
  }
  const minRegimeTraining=Math.max(80,Math.floor(minTrainingSamples/2));
  const minRegimeHoldout=Math.max(20,Math.floor(minimumHoldoutSamples/2));
  const minRegimeValidation=Math.max(12,Math.floor(minimumValidationSamples/2));
  const emptyCoverage=Object.fromEntries(regimes.map(regime=>[regime,{
    status:'WAITING_FOR_REGIME_EXPERT_CHRONOLOGICAL_SPLIT',
    model_scope:'SHARED_TCN_WITH_REGIME_CONDITIONAL_MEMBER_SELECTION',
    training_samples:0,validation_samples:0,holdout_samples:0,
    required_training_samples:minRegimeTraining,
    required_validation_samples:minRegimeValidation,
    required_holdout_samples:minRegimeHoldout,
    selected:false,probability_ready:false,live_eligibility_ready:false
  }]));
  const architecture=TEMPORAL_MODEL_ARCHITECTURE;
  const countTrailingGroups=(endExclusive,targetRows,minSpanMs=HORIZON_MS+1)=>{
    let groups=0,total=0;
    const latestAt=endExclusive>0?uniqueTimes[endExclusive-1]:null;
    for(let index=endExclusive-1;index>=0;index--){
      const group=rowsByTime.get(uniqueTimes[index])||[];
      groups++;total+=group.length;
      const span=latestAt===null?0:latestAt-uniqueTimes[index];
      if(groups>=2&&total>=targetRows&&span>=minSpanMs)break;
    }
    return groups;
  };
  // Reserve a broad, untouched final block once the historical journal is mature.
  // The larger holdout must cover both BTC regimes and both outcome classes; it
  // never relaxes the per-regime sample or performance gates.
  // Mature datasets reserve a broad untouched holdout of at least twice
  // the live sample floor, while capping it at 25% so more purged history can
  // train the shared temporal model. Medium datasets keep a 20%/180-row floor.
  const holdoutTargetSamples=rows.length>=liveHoldoutSamples*8
    ?Math.max(liveHoldoutSamples*2,Math.ceil(rows.length*0.25))
    :rows.length>=liveHoldoutSamples*4
      ?Math.max(liveHoldoutSamples+30,Math.ceil(rows.length*0.20))
      :minimumHoldoutSamples;
  const holdoutCount=countTrailingGroups(uniqueTimes.length,holdoutTargetSamples,0);
  // Mature histories use a wider inner validation block because the
  // first-passage positive class can be sparse and regime-skewed. This widens
  // sample support without touching the final holdout or reducing its floor.
  const validationTargetSamples=rows.length>=liveHoldoutSamples*8
    ?Math.max(liveHoldoutSamples*2,Math.ceil(rows.length*0.15))
    :rows.length>=liveHoldoutSamples*5
      ?Math.ceil(liveHoldoutSamples*4/3)
      :Math.max(minimumValidationSamples*2,60);
  const validationCount=countTrailingGroups(uniqueTimes.length-holdoutCount,
    validationTargetSamples,2*HORIZON_MS+1);
  const trainingEndIndex=uniqueTimes.length-holdoutCount-validationCount;
  const enoughSplit=trainingEndIndex>0;
  if(!enoughSplit)return{
    status:'WAITING_FOR_TEMPORAL_FIRST_PASSAGE_SAMPLES',
    architecture,target_definition:TEMPORAL_TARGET_DEFINITION,temporal_label_resolution:'15M_ONLY',
    sequence_steps:TEMPORAL_SEQUENCE_STEPS,sequence_channels:TEMPORAL_SEQUENCE_CHANNELS,
    ensemble_members:0,ensemble_members_required:SEEDS.length,
    regime_specialist_count:2,
    regime_selection_mode:'BTC_24H_CONTEXT_FEATURE_WITH_REGIME_CONDITIONAL_OUT_OF_SAMPLE_GATES',
    model_scope:'SHARED_TCN_WITH_REGIME_CONDITIONAL_MEMBER_SELECTIONS',
    resolved_samples:rows.length,training_samples:0,validation_samples:0,holdout_samples:0,
    required_training_samples:minTrainingSamples,
    required_validation_samples:minimumValidationSamples,
    required_holdout_samples:minimumHoldoutSamples,
    probability_ready:false,live_eligibility_ready:false,
    validation_start_at:null,holdout_start_at:null,max_training_outcome_resolved_at:null,
    trained:false,selected:false,regime_specialists:emptyCoverage,
    supported_regimes:[],
    validation:{evaluated:false,reason:'THREE_CHRONOLOGICAL_BLOCKS_REQUIRED'},
    holdout:{evaluated:false,reason:'THREE_CHRONOLOGICAL_BLOCKS_REQUIRED'},
    holdout_comparison:{passed:false,required_live_holdout_samples:liveHoldoutSamples},
    _fit:null,_baseline_fit:null
  };

  const validationStart=uniqueTimes[trainingEndIndex];
  const holdoutStart=uniqueTimes[uniqueTimes.length-holdoutCount];
  const trainingPool=rows.filter(row=>row.at<validationStart);
  const training=trainingPool.filter(row=>row.resolved_at<validationStart)
    .slice(-Math.max(minTrainingSamples,maxTrainingSamples));
  const validationPool=rows.filter(row=>row.at>=validationStart&&row.at<holdoutStart);
  const validation=validationPool.filter(row=>row.resolved_at<holdoutStart);
  const holdout=rows.filter(row=>row.at>=holdoutStart);
  const maxTrainingOutcomeResolvedAt=training.length
    ?Math.max(...training.map(row=>row.resolved_at)):null;
  if(training.length<minTrainingSamples||validation.length<minimumValidationSamples||
     holdout.length<minimumHoldoutSamples){
    return{
      status:'WAITING_FOR_TEMPORAL_FIRST_PASSAGE_SAMPLES',
      architecture,target_definition:TEMPORAL_TARGET_DEFINITION,
      temporal_label_resolution:'15M_ONLY',
      sequence_steps:TEMPORAL_SEQUENCE_STEPS,sequence_channels:TEMPORAL_SEQUENCE_CHANNELS,
      ensemble_members:0,ensemble_members_required:SEEDS.length,
      regime_specialist_count:2,
      regime_selection_mode:'BTC_24H_CONTEXT_FEATURE_WITH_REGIME_CONDITIONAL_OUT_OF_SAMPLE_GATES',
      model_scope:'SHARED_TCN_WITH_REGIME_CONDITIONAL_MEMBER_SELECTIONS',
      resolved_samples:rows.length,training_samples:training.length,
      validation_samples:validation.length,holdout_samples:holdout.length,
      required_training_samples:minTrainingSamples,
      required_validation_samples:minimumValidationSamples,
      required_holdout_samples:minimumHoldoutSamples,
      probability_ready:false,live_eligibility_ready:false,
      validation_start_at:validationStart,holdout_start_at:holdoutStart,
      max_training_outcome_resolved_at:maxTrainingOutcomeResolvedAt,
      trained:false,selected:false,regime_specialists:emptyCoverage,
      supported_regimes:[],
      selected_regimes:[],
      validation:{evaluated:false,reason:'TEMPORAL_CHRONOLOGICAL_SAMPLE_MINIMUMS_NOT_MET'},
      holdout:{evaluated:false,reason:'TEMPORAL_CHRONOLOGICAL_SAMPLE_MINIMUMS_NOT_MET'},
      holdout_comparison:{passed:false,required_live_holdout_samples:liveHoldoutSamples},
      _fit:null,_baseline_fit:null
    };
  }

  // One shared TCN ensemble is trained only on the union of chronological
  // training slices. Regime-specific selection, validation and holdout rows
  // never enter the shared model's gradient updates.
  const fitRows=training.slice(-Math.max(minTrainingSamples,maxTrainingSamples));
  const fitTimes=[...new Set(fitRows.map(row=>row.at))].sort((a,b)=>a-b);
  // Allocate more of a small/medium fitted history to model estimation while
  // retaining distinct later blocks for member selection and calibration.
  // Large histories have enough observations to reserve wider selection and
  // calibration windows. Outer validation and final holdout remain untouched.
  const splitFractions=fitTimes.length<16
    ?{training:0.80,memberSelection:0.86,calibration:1.00}
    :rows.length<1200
      ?{training:0.70,memberSelection:0.85,calibration:0.98}
      :{training:0.78,memberSelection:0.88,calibration:0.97};
  const sharedTrainCutIndex=Math.max(1,Math.min(fitTimes.length-2,
    Math.floor(fitTimes.length*splitFractions.training)));
  const sharedMemberSelectionCutIndex=Math.max(sharedTrainCutIndex+1,
    Math.min(fitTimes.length-1,Math.floor(fitTimes.length*splitFractions.memberSelection)));
  const sharedSelectionCutIndex=Math.max(sharedMemberSelectionCutIndex+1,
    Math.min(fitTimes.length,Math.floor(fitTimes.length*splitFractions.calibration)));
  const sharedTrainingCutoffAt=fitTimes[sharedTrainCutIndex]??validationStart;
  const sharedMemberSelectionCutoffAt=fitTimes[sharedMemberSelectionCutIndex]??validationStart;
  const sharedSelectionCutoffAt=fitTimes[sharedSelectionCutIndex]??validationStart;
  const sharedTrainingRows=fitRows.filter(row=>
    row.at<sharedTrainingCutoffAt&&row.resolved_at<sharedTrainingCutoffAt)
    .sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol));
  const sharedTrainingMaxResolvedAt=sharedTrainingRows.length
    ?Math.max(...sharedTrainingRows.map(row=>row.resolved_at)):null;
  if(fitTimes.length<4||sharedTrainingRows.length<minTrainingSamples){
    return{
      status:'WAITING_FOR_SHARED_TCN_TRAINING_SAMPLES',
      architecture,target_definition:TEMPORAL_TARGET_DEFINITION,
      temporal_label_resolution:'15M_ONLY',
      sequence_steps:TEMPORAL_SEQUENCE_STEPS,sequence_channels:TEMPORAL_SEQUENCE_CHANNELS,
      ensemble_members:0,ensemble_members_required:SEEDS.length,
      regime_specialist_count:2,
      regime_selection_mode:'BTC_24H_CONTEXT_FEATURE_WITH_REGIME_CONDITIONAL_OUT_OF_SAMPLE_GATES',
      model_scope:'SHARED_TCN_WITH_REGIME_CONDITIONAL_MEMBER_SELECTIONS',
      resolved_samples:rows.length,training_samples:sharedTrainingRows.length,
      shared_model_training_samples:sharedTrainingRows.length,
      selection_samples:0,validation_samples:validation.length,holdout_samples:holdout.length,
      required_training_samples:minTrainingSamples,
      required_selection_samples:Math.max(10,Math.ceil(minimumValidationSamples*0.4)),
      required_validation_samples:minimumValidationSamples,
      required_holdout_samples:minimumHoldoutSamples,
      selection_start_at:sharedTrainingCutoffAt,
      member_selection_cutoff_at:sharedMemberSelectionCutoffAt,
      calibration_cutoff_at:sharedSelectionCutoffAt,
      validation_start_at:sharedSelectionCutoffAt,holdout_start_at:holdoutStart,
      max_training_outcome_resolved_at:sharedTrainingMaxResolvedAt,
      shared_model_training_cutoff_at:sharedTrainingCutoffAt,
      shared_model_selection_cutoff_at:sharedSelectionCutoffAt,
      shared_model_training_max_outcome_resolved_at:sharedTrainingMaxResolvedAt,
      probability_ready:false,live_eligibility_ready:false,
      trained:false,selected:false,supported_regimes:[],selected_regimes:[],
      regime_specialists:emptyCoverage,
      validation:{evaluated:false,reason:'SHARED_TCN_TRAINING_BLOCK_BELOW_MINIMUM'},
      holdout:{evaluated:false,reason:'SHARED_TCN_TRAINING_BLOCK_BELOW_MINIMUM'},
      holdout_comparison:{passed:false,required_live_holdout_samples:liveHoldoutSamples},
      _fit:null,_baseline_fit:null
    };
  }

  const targets=sharedTrainingRows.map(row=>row.target);
  const baseRate=(targets.reduce((sum,value)=>sum+value,0)+2)/(targets.length+4);
  const pooledBaseline=fitLogistic(sharedTrainingRows);
  // Fit regime-matched linear anchors from this same purged training block.
  // Validation, selection and final holdout rows are never used to build anchors.
  const regimeBaselines=Object.fromEntries(regimes.map(regime=>{
    const regimeTrainingRows=sharedTrainingRows.filter(row=>regimeOfSequence(row.sequence)===regime);
    const baseline=regimeTrainingRows.length>=minRegimeTraining
      ?fitLogistic(regimeTrainingRows):pooledBaseline;
    return [regime,{weights:baseline.weights,bias:baseline.bias,
      training_samples:regimeTrainingRows.length,
      source:regimeTrainingRows.length>=minRegimeTraining
        ?'REGIME_SPECIFIC_TRAINING_ONLY':'POOLED_TRAINING_ONLY_FALLBACK'}];
  }));
  const fitted=fitEnsemble(sharedTrainingRows,{
    epochs,learningRate,l2,baseRate,baselineFit:pooledBaseline,baselineByRegime:regimeBaselines
  });
  // This global member score is diagnostic only. Valid regime probabilities
  // use the member index selected on that regime's separate selection block.
  const globalMemberValidation=fitted.members.map((member,index)=>({
    index,metrics:evaluate(validation,sequence=>forward(sequence,member).probability,baseRate)
  }));
  fitted.selected_member_index=-1;
  fitted.member_validation_scores=globalMemberValidation.map(row=>({
    index:row.index,brier_score:row.metrics.model_brier_score,
    base_rate_brier_score:row.metrics.base_rate_brier_score,
    beat_base_rate:row.metrics.beat_base_rate
  }));

  const regimeResults={};
  const trainingByRegime={},selectionByRegime={},validationByRegime={},holdoutByRegime={};
  const trainingTargets={},selectionTargets={},validationTargets={},holdoutTargets={};
  const minRegimePositive=Math.max(5,Math.ceil(minimumValidationSamples*0.2));
  const minRegimeNegative=Math.max(20,Math.ceil(minimumValidationSamples*0.8));
  const minSelectionSamples=Math.max(10,Math.ceil(minimumValidationSamples*0.4));
  const minSelectionPositive=3,minSelectionNegative=8;
  fitted.selected_member_by_regime={};
  fitted.residual_scales_by_regime={};
  fitted.probability_calibrators_by_regime={};
  const pooledMemberSelectionRows=fitRows.filter(row=>
    row.at>=sharedTrainingCutoffAt&&row.at<sharedMemberSelectionCutoffAt&&
    row.resolved_at<sharedMemberSelectionCutoffAt)
    .sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol));
  const pooledMemberSelectionTargets={
    samples:pooledMemberSelectionRows.length,
    positive:pooledMemberSelectionRows.filter(row=>row.target===1).length,
    negative:pooledMemberSelectionRows.filter(row=>row.target===0).length
  };
  const pooledMemberSelectionReady=pooledMemberSelectionTargets.samples>=minSelectionSamples&&
    pooledMemberSelectionTargets.positive>=minSelectionPositive&&
    pooledMemberSelectionTargets.negative>=minSelectionNegative;
  const pooledCalibrationRows=fitRows.filter(row=>
    row.at>=sharedMemberSelectionCutoffAt&&row.at<sharedSelectionCutoffAt&&
    row.resolved_at<sharedSelectionCutoffAt)
    .sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol));
  const calibrationSupport=rows=>({
    samples:rows.length,
    positive:rows.filter(row=>row.target===1).length,
    negative:rows.filter(row=>row.target===0).length
  });
  const pooledCalibrationTargets=calibrationSupport(pooledCalibrationRows);
  const pooledCalibrationReady=pooledCalibrationTargets.samples>=30&&
    pooledCalibrationTargets.positive>=5&&pooledCalibrationTargets.negative>=20;

  // All regimes share the same time cutoffs. The shared TCN trains only before
  // sharedTrainingCutoffAt; member selection is later, validation starts at
  // sharedSelectionCutoffAt, and the final holdout remains untouched.
  for(const regime of regimes){
    const regimeRows=fitRows.filter(row=>regimeOfSequence(row.sequence)===regime)
      .sort((a,b)=>a.at-b.at);
    const regimeHoldout=holdout.filter(row=>regimeOfSequence(row.sequence)===regime)
      .sort((a,b)=>a.at-b.at);
    const regimeTraining=regimeRows.filter(row=>
      row.at<sharedTrainingCutoffAt&&row.resolved_at<sharedTrainingCutoffAt);
    const regimeMemberSelection=regimeRows.filter(row=>
      row.at>=sharedTrainingCutoffAt&&row.at<sharedMemberSelectionCutoffAt&&
      row.resolved_at<sharedMemberSelectionCutoffAt);
    const regimeCalibration=regimeRows.filter(row=>
      row.at>=sharedMemberSelectionCutoffAt&&row.at<sharedSelectionCutoffAt&&
      row.resolved_at<sharedSelectionCutoffAt);
    const innerValidation=regimeRows.filter(row=>
      row.at>=sharedSelectionCutoffAt&&row.resolved_at<validationStart);
    const outerValidation=validation.filter(row=>regimeOfSequence(row.sequence)===regime);
    const regimeValidation=[...innerValidation,...outerValidation].sort((a,b)=>a.at-b.at);
    const targetsOf=block=>({
      samples:block.length,
      positive:block.filter(row=>row.target===1).length,
      negative:block.filter(row=>row.target===0).length
    });
    const trainTargets=targetsOf(regimeTraining);
    const selectTargets=targetsOf(regimeMemberSelection);
    const validTargets=targetsOf(regimeValidation);
    const holdTargets=targetsOf(regimeHoldout);
    const localMemberSelectionReady=selectTargets.samples>=minSelectionSamples&&
      selectTargets.positive>=minSelectionPositive&&selectTargets.negative>=minSelectionNegative;
    const memberSelectionRows=localMemberSelectionReady?regimeMemberSelection:
      pooledMemberSelectionReady?pooledMemberSelectionRows:regimeMemberSelection;
    const memberSelectionTargets=targetsOf(memberSelectionRows);
    const memberSelectionSource=localMemberSelectionReady?'REGIME_MEMBER_SELECTION_BLOCK':
      pooledMemberSelectionReady?'POOLED_MEMBER_SELECTION_BLOCK_FALLBACK':'REGIME_MEMBER_SELECTION_BLOCK_INSUFFICIENT';
    const calibrationTargets=calibrationSupport(regimeCalibration);
    const localCalibrationReady=calibrationTargets.samples>=30&&
      calibrationTargets.positive>=5&&calibrationTargets.negative>=20;
    const calibrationRows=localCalibrationReady?regimeCalibration:
      pooledCalibrationReady?pooledCalibrationRows:regimeCalibration;
    const selectedCalibrationTargets=calibrationSupport(calibrationRows);
    const calibrationSource=localCalibrationReady?'REGIME_CALIBRATION_BLOCK':
      pooledCalibrationReady?'POOLED_CALIBRATION_BLOCK_FALLBACK':'CALIBRATION_BLOCK_INSUFFICIENT';
    trainingByRegime[regime]=regimeTraining.length;
    selectionByRegime[regime]=regimeMemberSelection.length;
    validationByRegime[regime]=regimeValidation.length;
    holdoutByRegime[regime]=regimeHoldout.length;
    trainingTargets[regime]=trainTargets;
    selectionTargets[regime]=selectTargets;
    validationTargets[regime]=validTargets;
    holdoutTargets[regime]=holdTargets;

    const supportGaps=[];
    if(regimeTraining.length<minRegimeTraining)supportGaps.push('TRAINING_SAMPLE_COUNT');
    if(memberSelectionTargets.samples<minSelectionSamples)supportGaps.push('SELECTION_SAMPLE_COUNT');
    if(regimeValidation.length<minRegimeValidation)supportGaps.push('VALIDATION_SAMPLE_COUNT');
    if(regimeHoldout.length<minRegimeHoldout)supportGaps.push('HOLDOUT_SAMPLE_COUNT');
    if(trainTargets.positive<minRegimePositive)supportGaps.push('TRAINING_POSITIVE_CLASS');
    if(trainTargets.negative<minRegimeNegative)supportGaps.push('TRAINING_NEGATIVE_CLASS');
    if(memberSelectionTargets.positive<minSelectionPositive)supportGaps.push('SELECTION_POSITIVE_CLASS');
    if(memberSelectionTargets.negative<minSelectionNegative)supportGaps.push('SELECTION_NEGATIVE_CLASS');
    if(validTargets.positive<minRegimePositive)supportGaps.push('VALIDATION_POSITIVE_CLASS');
    if(validTargets.negative<minRegimeNegative)supportGaps.push('VALIDATION_NEGATIVE_CLASS');
    if(holdTargets.positive<minRegimePositive)supportGaps.push('HOLDOUT_POSITIVE_CLASS');
    if(holdTargets.negative<minRegimeNegative)supportGaps.push('HOLDOUT_NEGATIVE_CLASS');
    const supported=supportGaps.length===0;
    if(!supported){
      regimeResults[regime]={supported:false,support_gaps:supportGaps,
        training_start_at:regimeTraining[0]?.at??null,
        selection_start_at:regimeMemberSelection[0]?.at??null,
        validation_start_at:regimeValidation[0]?.at??null,
        max_training_outcome_resolved_at:regimeTraining.length?Math.max(...regimeTraining.map(row=>row.resolved_at)):null,
        training_samples:regimeTraining.length,selection_samples:regimeMemberSelection.length,
        calibration_samples:regimeCalibration.length,
        member_selection_samples:memberSelectionRows.length,member_selection_source:memberSelectionSource,
        calibration_selection_samples:calibrationRows.length,calibration_source:calibrationSource,
        calibration_targets:selectedCalibrationTargets,
        selection_calibration_samples:0,
        validation_samples:regimeValidation.length,holdout_samples:regimeHoldout.length,
        training_targets:trainTargets,selection_targets:selectTargets,
        member_selection_targets:memberSelectionTargets,
        validation_targets:validTargets,holdout_targets:holdTargets,
        validation_passed:false,holdout_passed:false,
        validation_model:{evaluated:false,sample_count:regimeValidation.length},
        validation_logistic:{evaluated:false,sample_count:regimeValidation.length},
        holdout_model:{evaluated:false,sample_count:regimeHoldout.length},
        holdout_logistic:{evaluated:false,sample_count:regimeHoldout.length}};
      continue;
    }

    const regimePrior=(regimeTraining.reduce((sum,row)=>sum+row.target,0)+2)/(regimeTraining.length+4);
    const regimeBaseline=regimeBaselines[regime]||pooledBaseline;
    // Reuse the shared three-member TCN. The active regime selects a member
    // only from its disjoint selection block; no selection/validation/holdout
    // example is included in the shared model's training rows.
    const candidateResidualScales=[0,0.25,0.5,0.75,1];
    const memberRanks=fitted.members.flatMap((member,index)=>
      candidateResidualScales.map(residualScale=>({
        index,residual_scale:residualScale,
        metrics:evaluate(memberSelectionRows,
          sequence=>forward(sequence,member,residualScale).probability,regimePrior)
      }))
    ).filter(row=>row.metrics.evaluated===true)
      .sort((a,b)=>a.metrics.model_brier_score-b.metrics.model_brier_score||
        a.index-b.index||b.residual_scale-a.residual_scale);
    const selectedMemberIndex=memberRanks.length?memberRanks[0].index:-1;
    const selectedResidualScale=memberRanks.length?memberRanks[0].residual_scale:1;
    fitted.selected_member_by_regime[regime]=selectedMemberIndex;
    fitted.residual_scales_by_regime[regime]=selectedResidualScale;
    const memberSelectionScores=memberRanks.map(row=>({
      index:row.index,residual_scale:row.residual_scale,
      brier_score:row.metrics.model_brier_score,
      base_rate_brier_score:row.metrics.base_rate_brier_score,
      beat_base_rate:row.metrics.beat_base_rate
    }));
    // Calibration has its own later chronological block. It never reuses
    // labels that selected the member or residual scale. When local support is
    // sparse, only the pooled calibration block may be used as a fallback.
    const selectionCalibrator=fitSelectionProbabilityCalibrator(
      calibrationRows,
      sequence=>forward(sequence,fitted.members[selectedMemberIndex],selectedResidualScale).probability,
      {minimumSamples:30,minimumPositive:5,minimumNegative:20,
       iterations:300,learningRate:0.03,regularization:0.45,
       fitOn:calibrationSource}
    );
    fitted.probability_calibrators_by_regime[regime]=selectionCalibrator;

    const validationModel=evaluate(regimeValidation,sequence=>predict(sequence,fitted),regimePrior);
    const validationLogistic=evaluate(regimeValidation,
      sequence=>predictLogistic(sequence,regimeBaseline),regimeBaseline.base_rate);
    const validationPassed=validationModel.evaluated&&validationLogistic.evaluated&&
      validationModel.beat_base_rate===true&&
      validationModel.model_brier_score+comparisonMargin<validationLogistic.model_brier_score;
    const holdoutModel=evaluate(regimeHoldout,sequence=>predict(sequence,fitted),regimePrior);
    const holdoutLogistic=evaluate(regimeHoldout,
      sequence=>predictLogistic(sequence,regimeBaseline),regimeBaseline.base_rate);
    const holdoutPassed=validationPassed&&holdoutModel.evaluated&&holdoutLogistic.evaluated&&
      holdoutModel.beat_base_rate===true&&
      holdoutModel.model_brier_score+comparisonMargin<holdoutLogistic.model_brier_score;
    regimeResults[regime]={supported:true,prior:regimePrior,
      training_start_at:regimeTraining[0]?.at??null,
      selection_start_at:regimeMemberSelection[0]?.at??null,
      calibration_start_at:regimeCalibration[0]?.at??null,
      validation_start_at:regimeValidation[0]?.at??null,
      max_training_outcome_resolved_at:regimeTraining.length?Math.max(...regimeTraining.map(row=>row.resolved_at)):null,
      training_samples:regimeTraining.length,selection_samples:regimeMemberSelection.length,
      calibration_samples:regimeCalibration.length,
      member_selection_samples:memberSelectionRows.length,member_selection_source:memberSelectionSource,
      calibration_selection_samples:calibrationRows.length,calibration_source:calibrationSource,
      calibration_targets:selectedCalibrationTargets,
      selected_member_index:selectedMemberIndex,selected_residual_scale:selectedResidualScale,
      selection_calibration_samples:selectionCalibrator.sample_count,
      validation_samples:regimeValidation.length,holdout_samples:regimeHoldout.length,
      validation_passed:validationPassed,holdout_passed:holdoutPassed,
      validation_model:validationModel,validation_logistic:validationLogistic,
      holdout_model:holdoutModel,holdout_logistic:holdoutLogistic,
      member_selection_scores:memberSelectionScores,
      probability_calibration:selectionCalibrator};
  }
  const supportedRegimes=regimes.filter(regime=>regimeResults[regime]?.supported===true);
  const validationSelectedRegimes=regimes.filter(regime=>regimeResults[regime]?.validation_passed===true);
  const selectedRegimes=regimes.filter(regime=>regimeResults[regime]?.holdout_passed===true);
  // Report only validated regime slices when at least one is eligible. When
  // none passes, retain supported/validation slices for honest diagnostics.
  const diagnosticRegimes=selectedRegimes.length?selectedRegimes:
    validationSelectedRegimes.length?validationSelectedRegimes:supportedRegimes;
  // Keep global block metrics visible when no regime has enough class support.
  // These fallback diagnostics can never unlock probability readiness.
  const hasDiagnosticRegimes=diagnosticRegimes.length>0;
  const validationModel=hasDiagnosticRegimes
    ?aggregateEvaluations(diagnosticRegimes.map(regime=>regimeResults[regime]?.validation_model))
    :evaluate(validation,sequence=>predict(sequence,fitted),baseRate);
  const validationLogistic=hasDiagnosticRegimes
    ?aggregateEvaluations(diagnosticRegimes.map(regime=>regimeResults[regime]?.validation_logistic))
    :evaluate(validation,sequence=>predictLogistic(sequence,pooledBaseline),pooledBaseline.base_rate);
  const holdoutModel=hasDiagnosticRegimes
    ?aggregateEvaluations(diagnosticRegimes.map(regime=>regimeResults[regime]?.holdout_model))
    :evaluate(holdout,sequence=>predict(sequence,fitted),baseRate);
  const holdoutLogistic=hasDiagnosticRegimes
    ?aggregateEvaluations(diagnosticRegimes.map(regime=>regimeResults[regime]?.holdout_logistic))
    :evaluate(holdout,sequence=>predictLogistic(sequence,pooledBaseline),pooledBaseline.base_rate);
  // Each BTC regime has already been compared with its own training-only
  // logistic anchor on disjoint chronological validation and untouched holdout
  // rows. The deployable predictor is conditional: it must return null in any
  // regime that did not independently clear both gates. Do not reject a valid
  // regime merely because a different regime is weaker, and never broaden the
  // selected regime set using pooled holdout metrics.
  const selected=validationSelectedRegimes.length>0;
  const holdoutPassed=selectedRegimes.length>0;
  const probabilityReady=holdoutPassed;
  const allSupportedRegimesValidated=supportedRegimes.length>0&&
    supportedRegimes.every(regime=>selectedRegimes.includes(regime));
  const selectedRegimeHoldoutSamples=selectedRegimes.reduce((sum,regime)=>
    sum+Number(regimeResults[regime]?.holdout_model?.sample_count||0),0);
  const liveReady=probabilityReady&&allSupportedRegimesValidated&&
    selectedRegimeHoldoutSamples>=liveHoldoutSamples;
  const specialistProfiles=Object.fromEntries(regimes.map(regime=>{
    const supported=supportedRegimes.includes(regime);
    const result=regimeResults[regime]||{};
    return [regime,{
      status:!supported?'WAITING_FOR_REGIME_SPECIALIST_SAMPLE_COVERAGE':
        result.holdout_passed?'REGIME_TCN_OUT_OF_SAMPLE_VALIDATED':
        result.validation_passed?'REGIME_VALIDATION_PASSED_HOLDOUT_NOT_PASSED':
        'REGIME_TCN_DID_NOT_PASS_VALIDATION',
      support_gaps:result.support_gaps||[],
      model_scope:'SHARED_TCN_WITH_REGIME_CONDITIONAL_MEMBER_SELECTION',
      baseline_anchor_source:regimeBaselines[regime]?.source||'POOLED_TRAINING_ONLY_FALLBACK',
      baseline_anchor_training_samples:Number(regimeBaselines[regime]?.training_samples)||0,
      training_start_at:result.training_start_at??null,
      selection_start_at:result.selection_start_at??null,
      calibration_start_at:result.calibration_start_at??null,
      validation_start_at:result.validation_start_at??null,
      max_training_outcome_resolved_at:result.max_training_outcome_resolved_at??null,
      training_samples:trainingByRegime[regime],
      selection_samples:selectionByRegime[regime],
      calibration_samples:Number(result.calibration_samples)||0,
      calibration_source:result.calibration_source||null,
      calibration_targets:result.calibration_targets||null,
      calibration_selection_samples:Number(result.calibration_selection_samples)||0,
      member_selection_samples:Number(result.member_selection_samples)||0,
      member_selection_source:result.member_selection_source||null,
      selected_member_index:Number.isInteger(result.selected_member_index)?result.selected_member_index:null,
      selected_residual_scale:Number(result.selected_residual_scale),
      selection_calibration_samples:Number(result.selection_calibration_samples)||0,
      validation_samples:validationByRegime[regime],
      holdout_samples:holdoutByRegime[regime],
      training_positive_samples:trainingTargets[regime].positive,
      training_negative_samples:trainingTargets[regime].negative,
      selection_positive_samples:selectionTargets[regime].positive,
      selection_negative_samples:selectionTargets[regime].negative,
      validation_positive_samples:validationTargets[regime].positive,
      validation_negative_samples:validationTargets[regime].negative,
      holdout_positive_samples:holdoutTargets[regime].positive,
      holdout_negative_samples:holdoutTargets[regime].negative,
      required_training_samples:minRegimeTraining,
      required_selection_samples:minSelectionSamples,
      required_validation_samples:minRegimeValidation,
      required_holdout_samples:minRegimeHoldout,
      required_validation_positive_samples:minRegimePositive,
      required_holdout_positive_samples:minRegimePositive,
      required_validation_negative_samples:minRegimeNegative,
      required_holdout_negative_samples:minRegimeNegative,
      selected:result.validation_passed===true,
      probability_ready:result.holdout_passed===true,
      live_eligibility_ready:result.holdout_passed===true&&
        Number(result.holdout_model?.sample_count)>=liveHoldoutSamples,
      validation_brier:result.validation_model?.model_brier_score??null,
      validation_base_rate_brier:result.validation_model?.base_rate_brier_score??null,
      validation_pooled_logistic_brier:result.validation_logistic?.model_brier_score??null,
      holdout_brier:result.holdout_model?.model_brier_score??null,
      holdout_base_rate_brier:result.holdout_model?.base_rate_brier_score??null,
      holdout_pooled_logistic_brier:result.holdout_logistic?.model_brier_score??null,
      probability_calibration:result.probability_calibration||null
    }];
  }));
  // Top-level sample counts describe the shared model's actual fit and the
  // complete chronological evidence blocks. Per-regime scored subsets remain
  // explicit under regime_specialists and holdout_comparison.
  const reportTrainingSamples=sharedTrainingRows.length;
  const reportSelectionSamples=Object.values(selectionByRegime).reduce((sum,value)=>sum+Number(value||0),0);
  const reportValidationSamples=Object.values(validationByRegime).reduce((sum,value)=>sum+Number(value||0),0);
  const reportHoldoutSamples=holdout.length;
  const reportTrainingPositive=targets.filter(value=>value===1).length;
  const reportTrainingNegative=targets.filter(value=>value===0).length;
  const reportTrainingPrior=(reportTrainingPositive+2)/(reportTrainingSamples+4);
  const reportMaxTrainingResolvedAt=sharedTrainingMaxResolvedAt;
  const reportValidationStartAt=sharedSelectionCutoffAt;
  const validationReason=!supportedRegimes.length?'NO_SUPPORTED_BTC_REGIME':
    !validationSelectedRegimes.length?'NO_REGIME_BEAT_ITS_VALIDATION_LOGISTIC':
    'AT_LEAST_ONE_REGIME_BEAT_ITS_VALIDATION_LOGISTIC';
  const holdoutReason=!selected?'VALIDATION_NOT_PASSED':
    !selectedRegimes.length?'NO_VALIDATED_REGIME_BEAT_ITS_UNTOUCHED_HOLDOUT_LOGISTIC':
    'AT_LEAST_ONE_REGIME_BEAT_ITS_UNTOUCHED_HOLDOUT_LOGISTIC';
  const status=!validationSelectedRegimes.length?'VALIDATION_DID_NOT_BEAT_REGIME_LOGISTIC':
    !holdoutPassed?'VALIDATION_PASSED_HOLDOUT_NOT_PASSED':
    !allSupportedRegimesValidated?'PARTIAL_REGIME_OUT_OF_SAMPLE_VALIDATED_PAPER_ONLY':
    liveReady?'LIVE_GATE_PASSED_OUT_OF_SAMPLE':'OUT_OF_SAMPLE_VALIDATED_PAPER_ONLY';
  return{
    status,architecture,target_definition:TEMPORAL_TARGET_DEFINITION,
    temporal_label_resolution:'15M_ONLY',
    sequence_steps:TEMPORAL_SEQUENCE_STEPS,sequence_channels:TEMPORAL_SEQUENCE_CHANNELS,
    ensemble_members:SEEDS.length,ensemble_members_required:SEEDS.length,
    training_strategy:fitted.training_strategy,
    baseline_anchor:fitted.baseline_anchor,
    training_objective:fitted.training_objective,
    member_training_profiles:fitted.member_training_profiles,
    member_validation_scores:fitted.member_validation_scores,
    selected_member_index:fitted.selected_member_index,
    member_selection_method:'REGIME_SPECIFIC_CHRONOLOGICAL_MEMBER_AND_RESIDUAL_SCALE_SELECTION_BRIER',
    residual_scale_selection:'REGIME_SELECTION_BLOCK_BRIER_GRID_V1',
    candidate_residual_scales:[0,0.25,0.5,0.75,1],
    regime_specialist_count:2,
    regime_selection_mode:'BTC_24H_CONTEXT_FEATURE_WITH_REGIME_CONDITIONAL_OUT_OF_SAMPLE_GATES',
    model_scope:'SHARED_TCN_WITH_REGIME_CONDITIONAL_MEMBER_SELECTIONS',
    residual_anchor:'REGIME_SPECIFIC_TRAINING_ONLY_LOGISTIC_FROZEN',
    calibration_strategy:'SELECTION_BLOCK_SHRUNK_BRIER_PLATT_V1',
    calibration_fit_scope:'REGIME_OR_POOLED_CALIBRATION_BLOCK_ONLY',
    resolved_samples:rows.length,training_samples:reportTrainingSamples,
    shared_model_training_samples:sharedTrainingRows.length,
    shared_model_selection_samples:reportSelectionSamples,
    selection_samples:reportSelectionSamples,
    validation_samples:reportValidationSamples,holdout_samples:reportHoldoutSamples,
    shared_model_training_cutoff_at:sharedTrainingCutoffAt,
    shared_model_member_selection_cutoff_at:sharedMemberSelectionCutoffAt,
    shared_model_selection_cutoff_at:sharedSelectionCutoffAt,
    shared_model_selection_layout:`TRAIN_${Math.round(sharedTrainCutIndex/fitTimes.length*100)}_PERCENT_MEMBER_SELECTION_${Math.round((sharedMemberSelectionCutIndex-sharedTrainCutIndex)/fitTimes.length*100)}_PERCENT_CALIBRATION_${Math.round((sharedSelectionCutIndex-sharedMemberSelectionCutIndex)/fitTimes.length*100)}_PERCENT`,
    shared_model_training_max_outcome_resolved_at:sharedTrainingMaxResolvedAt,
    required_training_samples:minTrainingSamples,
    required_selection_samples:minSelectionSamples,
    required_validation_samples:minimumValidationSamples,
    required_holdout_samples:minimumHoldoutSamples,
    validation_start_at:reportValidationStartAt,holdout_start_at:holdoutStart,
    max_training_outcome_resolved_at:reportMaxTrainingResolvedAt,
    training_positive_rate_pct:Number((reportTrainingPositive/Math.max(1,reportTrainingSamples)*100).toFixed(2)),
    training_positive_count:reportTrainingPositive,
    training_negative_count:reportTrainingNegative,
    training_prior_probability:Number(reportTrainingPrior.toFixed(5)),
    trained:true,selected,probability_ready:probabilityReady,
    live_eligibility_ready:liveReady,
    supported_regimes:supportedRegimes,
    selected_regimes:selectedRegimes,
    regime_specialists:specialistProfiles,
    regime_data_coverage:{
      training:trainingTargets,selection:selectionTargets,validation:validationTargets,holdout:holdoutTargets,
      minimum_positive_samples:minRegimePositive,
      minimum_negative_samples:minRegimeNegative
    },
    validation:{
      ...validationModel,selected_over_pooled_logistic:selected,
      pooled_logistic_brier_score:validationLogistic.model_brier_score,
      reason:validationReason
    },
    holdout:{
      ...holdoutModel,
      pooled_logistic_brier_score:holdoutLogistic.model_brier_score,
      reason:holdoutReason
    },
    holdout_comparison:{
      sample_count:selectedRegimeHoldoutSamples,
      required_live_holdout_samples:liveHoldoutSamples,
      required_brier_margin:comparisonMargin,
      tcn_brier_score:holdoutModel.model_brier_score,
      pooled_logistic_brier_score:holdoutLogistic.model_brier_score,
      beats_base_rate:holdoutPassed,
      // True only when at least one independently selected regime has already
      // beaten both its own base-rate and logistic challengers on the untouched
      // holdout. Unselected regimes remain unavailable at prediction time.
      beats_pooled_logistic:holdoutPassed,
      selected_regimes:selectedRegimes,
      regime_comparisons:Object.fromEntries(regimes.map(regime=>{
        const result=regimeResults[regime]||{};
        return [regime,{
          supported:result.supported===true,
          validation_passed:result.validation_passed===true,
          holdout_passed:result.holdout_passed===true,
          sample_count:Number(result.holdout_model?.sample_count)||0,
          tcn_brier:result.holdout_model?.model_brier_score??null,
          base_rate_brier:result.holdout_model?.base_rate_brier_score??null,
          logistic_brier:result.holdout_logistic?.model_brier_score??null
        }];
      })),
      regime_coverage:{training:trainingByRegime,selection:selectionByRegime,validation:validationByRegime,holdout:holdoutByRegime},
      supported_regimes:supportedRegimes,
      all_supported_regimes_validated:allSupportedRegimesValidated,
      partial_regime_validation:holdoutPassed&&!allSupportedRegimesValidated,
      passed:holdoutPassed
    },
    _fit:probabilityReady?fitted:null,
    _baseline_fit:pooledBaseline
  };
}

export function predictTemporalProbability(sequence,profile={}){
  if(profile?.probability_ready!==true||!profile?._fit||!validSequence(sequence))return null;
  const regime=regimeOfSequence(sequence);
  const eligible=Array.isArray(profile.selected_regimes)?profile.selected_regimes:profile.supported_regimes;
  if(!Array.isArray(eligible)||!eligible.includes(regime))return null;
  return predict(sequence,profile._fit);
}

