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
  'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_V1';
export const TEMPORAL_SEQUENCE_STEPS = 24;
export const TEMPORAL_SEQUENCE_CHANNELS=29;
export const TEMPORAL_MODEL_ARCHITECTURE='TCN_24x29_DILATED_RESIDUAL_BTC_CONTEXT_GATED_MASKED_MICRO_ENSEMBLE_V6';

const DILATIONS = Object.freeze([1, 2, 4]);
const KERNEL_TAPS = 2;
const HORIZON_MS = 4 * 60 * 60 * 1000;
const SEEDS = Object.freeze([13, 29, 47]);
const MIN_TRAIN = 160;
const MAX_TRAIN = 960;
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
    residual_anchor:baselineFit?'POOLED_SEQUENCE_LOGISTIC_FROZEN':'TRAINING_PREVALENCE_PRIOR'
  };
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
  // The causal receptive field spans the 24-step window. Pool the latest
  // 12 states, so older multi-hour setup/market-regime context contributes.
  const poolStart=Math.max(0,final.length-12);
  const pooled = Array(TEMPORAL_SEQUENCE_CHANNELS).fill(0);
  const poolCount = final.length - poolStart;
  for (let time = poolStart; time < final.length; time++) {
    for (let channel = 0; channel < pooled.length; channel++) pooled[channel] += final[time][channel] / poolCount;
  }
  const baselineFeatures=pooledSequence(sequence);
  let logit = model.outputBias;
  for(let feature=0;feature<baselineFeatures.length;feature++){
    logit+=baselineFeatures[feature]*(Number(model.skipWeights?.[feature])||0);
  }
  for (let channel = 0; channel < pooled.length; channel++) logit += pooled[channel] * model.outputWeights[channel];
  return { probability: logistic(logit), activations, depthCaches, pooled, poolStart, poolCount, baselineFeatures };
}

function gradientsFor(sequence, target, model, cache) {
  const gradients = zerosLike(model);
  const activationGradients = Array(DILATIONS.length + 1);
  const final = cache.activations.at(-1);
  activationGradients[DILATIONS.length] = final.map(() => Array(TEMPORAL_SEQUENCE_CHANNELS).fill(0));
  const error = cache.probability - target;
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
  baseRate = 0.5, baselineFit = null
} = {}) {
  const model = initializeModel(seed,baseRate,baselineFit);
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

function predict(sequence, fitted) {
  if (!validSequence(sequence) || !fitted) return null;
  const regime=regimeOfSequence(sequence);
  const model=fitted.regime_fits?.[regime]||fitted;
  const selectedIndex=Number.isInteger(model.selected_member_index)?model.selected_member_index:
    Number.isInteger(fitted.selected_member_by_regime?.[regime])?fitted.selected_member_by_regime[regime]:-1;
  if(selectedIndex>=0&&selectedIndex<model.members.length){
    const value=forward(sequence,model.members[selectedIndex]).probability;
    return Number.isFinite(value)?clamp(value,0.02,0.98):null;
  }
  const predictions=model.members.map(member=>forward(sequence,member).probability);
  if(!predictions.length||predictions.some(value=>!Number.isFinite(value)))return null;
  return clamp(mean(predictions),0.02,0.98);
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
    training_strategy:'DIVERSIFIED_EPOCH_AND_REGULARIZATION_ENSEMBLE_V1',
    member_training_profiles:memberProfiles,
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
    model_scope:'INDEPENDENT_BTC_REGIME_TCN_EXPERT',
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
  // Reserve an untouched final block. Once at least 500 valid sequences exist,
  // reserve an expanded final block so one eligible regime can still supply the full live holdout minimum.
  const holdoutTargetSamples=rows.length>=liveHoldoutSamples*4
    ?liveHoldoutSamples+30:minimumHoldoutSamples;
  const holdoutCount=countTrailingGroups(uniqueTimes.length,holdoutTargetSamples,0);
  const validationTargetSamples=rows.length>=liveHoldoutSamples*5
    ?Math.ceil(liveHoldoutSamples*4/3)
    :Math.max(minimumValidationSamples*2,60);
  const validationCount=countTrailingGroups(uniqueTimes.length-holdoutCount,
    validationTargetSamples,2*HORIZON_MS+1);
  const trainingEndIndex=uniqueTimes.length-holdoutCount-validationCount;
  const enoughSplit=trainingEndIndex>0;
  if(!enoughSplit)return{
    status:'WAITING_FOR_TEMPORAL_FIRST_PASSAGE_SAMPLES',
    architecture,target_definition:TEMPORAL_TARGET_DEFINITION,
    sequence_steps:TEMPORAL_SEQUENCE_STEPS,sequence_channels:TEMPORAL_SEQUENCE_CHANNELS,
    ensemble_members:0,ensemble_members_required:SEEDS.length,
    regime_specialist_count:2,
    regime_selection_mode:'BTC_24H_CONTEXT_FEATURE_WITH_REGIME_CONDITIONAL_OUT_OF_SAMPLE_GATES',
    model_scope:'INDEPENDENT_BTC_REGIME_TCN_EXPERTS',
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
      sequence_steps:TEMPORAL_SEQUENCE_STEPS,sequence_channels:TEMPORAL_SEQUENCE_CHANNELS,
      ensemble_members:0,ensemble_members_required:SEEDS.length,
      regime_specialist_count:2,
      regime_selection_mode:'BTC_24H_CONTEXT_FEATURE_WITH_REGIME_CONDITIONAL_OUT_OF_SAMPLE_GATES',
      model_scope:'INDEPENDENT_BTC_REGIME_TCN_EXPERTS',
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

  // A pooled reference is retained for diagnostics only. Actual probabilities
  // come from independent chronological experts for the active BTC regime.
  const fitRows=training.slice(-Math.max(minTrainingSamples,maxTrainingSamples));
  const targets=fitRows.map(row=>row.target);
  const baseRate=(targets.reduce((sum,value)=>sum+value,0)+2)/(targets.length+4);
  const pooledBaseline=fitLogistic(fitRows);
  const fitted=fitEnsemble(fitRows,{epochs,learningRate,l2,baseRate,baselineFit:pooledBaseline});
  const globalMemberValidation=fitted.members.map((member,index)=>({
    index,metrics:evaluate(validation,sequence=>forward(sequence,member).probability,baseRate)
  }));
  const globalRankedMembers=globalMemberValidation.filter(row=>row.metrics.evaluated===true)
    .sort((a,b)=>a.metrics.model_brier_score-b.metrics.model_brier_score||a.index-b.index);
  fitted.selected_member_index=globalRankedMembers.length?globalRankedMembers[0].index:-1;
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
  fitted.regime_fits={};
  fitted.selected_member_by_regime={};

  // Each BTC regime has four disjoint chronological slices: expert fitting,
  // member selection, validation, and an untouched global final holdout.
  // Selection and validation never reuse the same examples.
  for(const regime of regimes){
    const regimeRows=fitRows.filter(row=>regimeOfSequence(row.sequence)===regime)
      .sort((a,b)=>a.at-b.at);
    const regimeHoldout=holdout.filter(row=>regimeOfSequence(row.sequence)===regime)
      .sort((a,b)=>a.at-b.at);
    const trainCutIndex=Math.max(1,Math.min(regimeRows.length-2,Math.floor(regimeRows.length*0.65)));
    const selectionCutIndex=Math.max(trainCutIndex+1,
      Math.min(regimeRows.length-1,Math.floor(regimeRows.length*0.80)));
    const trainCutAt=regimeRows[trainCutIndex]?.at??validationStart;
    const selectionCutAt=regimeRows[selectionCutIndex]?.at??validationStart;
    const regimeTraining=regimeRows.filter(row=>row.at<trainCutAt&&row.resolved_at<trainCutAt);
    const regimeSelection=regimeRows.filter(row=>row.at>=trainCutAt&&row.at<selectionCutAt&&
      row.resolved_at<selectionCutAt);
    const innerValidation=regimeRows.filter(row=>row.at>=selectionCutAt&&row.resolved_at<validationStart);
    const outerValidation=validation.filter(row=>regimeOfSequence(row.sequence)===regime);
    const regimeValidation=[...innerValidation,...outerValidation].sort((a,b)=>a.at-b.at);
    const targetsOf=block=>({
      samples:block.length,
      positive:block.filter(row=>row.target===1).length,
      negative:block.filter(row=>row.target===0).length
    });
    const trainTargets=targetsOf(regimeTraining);
    const selectTargets=targetsOf(regimeSelection);
    const validTargets=targetsOf(regimeValidation);
    const holdTargets=targetsOf(regimeHoldout);
    trainingByRegime[regime]=regimeTraining.length;
    selectionByRegime[regime]=regimeSelection.length;
    validationByRegime[regime]=regimeValidation.length;
    holdoutByRegime[regime]=regimeHoldout.length;
    trainingTargets[regime]=trainTargets;
    selectionTargets[regime]=selectTargets;
    validationTargets[regime]=validTargets;
    holdoutTargets[regime]=holdTargets;

    const supportGaps=[];
    if(regimeTraining.length<minRegimeTraining)supportGaps.push('TRAINING_SAMPLE_COUNT');
    if(regimeSelection.length<minSelectionSamples)supportGaps.push('SELECTION_SAMPLE_COUNT');
    if(regimeValidation.length<minRegimeValidation)supportGaps.push('VALIDATION_SAMPLE_COUNT');
    if(regimeHoldout.length<minRegimeHoldout)supportGaps.push('HOLDOUT_SAMPLE_COUNT');
    if(trainTargets.positive<minRegimePositive)supportGaps.push('TRAINING_POSITIVE_CLASS');
    if(trainTargets.negative<minRegimeNegative)supportGaps.push('TRAINING_NEGATIVE_CLASS');
    if(selectTargets.positive<minSelectionPositive)supportGaps.push('SELECTION_POSITIVE_CLASS');
    if(selectTargets.negative<minSelectionNegative)supportGaps.push('SELECTION_NEGATIVE_CLASS');
    if(validTargets.positive<minRegimePositive)supportGaps.push('VALIDATION_POSITIVE_CLASS');
    if(validTargets.negative<minRegimeNegative)supportGaps.push('VALIDATION_NEGATIVE_CLASS');
    if(holdTargets.positive<minRegimePositive)supportGaps.push('HOLDOUT_POSITIVE_CLASS');
    if(holdTargets.negative<minRegimeNegative)supportGaps.push('HOLDOUT_NEGATIVE_CLASS');
    const supported=supportGaps.length===0;
    if(!supported){
      regimeResults[regime]={supported:false,support_gaps:supportGaps,
        training_start_at:regimeTraining[0]?.at??null,
        selection_start_at:regimeSelection[0]?.at??null,
        validation_start_at:regimeValidation[0]?.at??null,
        max_training_outcome_resolved_at:regimeTraining.length?Math.max(...regimeTraining.map(row=>row.resolved_at)):null,
        training_samples:regimeTraining.length,selection_samples:regimeSelection.length,
        validation_samples:regimeValidation.length,holdout_samples:regimeHoldout.length,
        training_targets:trainTargets,selection_targets:selectTargets,
        validation_targets:validTargets,holdout_targets:holdTargets,
        validation_passed:false,holdout_passed:false,
        validation_model:{evaluated:false,sample_count:regimeValidation.length},
        validation_logistic:{evaluated:false,sample_count:regimeValidation.length},
        holdout_model:{evaluated:false,sample_count:regimeHoldout.length},
        holdout_logistic:{evaluated:false,sample_count:regimeHoldout.length}};
      continue;
    }

    const regimePrior=(regimeTraining.reduce((sum,row)=>sum+row.target,0)+2)/(regimeTraining.length+4);
    const regimeBaseline=fitLogistic(regimeTraining);
    const regimeFit=fitEnsemble(regimeTraining,{epochs,learningRate,l2,
      baseRate:regimePrior,baselineFit:regimeBaseline});
    const memberRanks=regimeFit.members.map((member,index)=>({
      index,metrics:evaluate(regimeSelection,sequence=>forward(sequence,member).probability,regimePrior)
    })).filter(row=>row.metrics.evaluated===true)
      .sort((a,b)=>a.metrics.model_brier_score-b.metrics.model_brier_score||a.index-b.index);
    regimeFit.selected_member_index=memberRanks.length?memberRanks[0].index:-1;
    regimeFit.member_validation_scores=memberRanks.map(row=>({
      index:row.index,brier_score:row.metrics.model_brier_score,
      base_rate_brier_score:row.metrics.base_rate_brier_score,
      beat_base_rate:row.metrics.beat_base_rate
    }));
    fitted.regime_fits[regime]=regimeFit;
    fitted.selected_member_by_regime[regime]=regimeFit.selected_member_index;

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
      validation_start_at:regimeValidation[0]?.at??null,
      selection_start_at:regimeSelection[0]?.at??null,
      max_training_outcome_resolved_at:regimeTraining.length?Math.max(...regimeTraining.map(row=>row.resolved_at)):null,
      training_samples:regimeTraining.length,selection_samples:regimeSelection.length,
      validation_samples:regimeValidation.length,holdout_samples:regimeHoldout.length,
      validation_passed:validationPassed,holdout_passed:holdoutPassed,
      validation_model:validationModel,validation_logistic:validationLogistic,
      holdout_model:holdoutModel,holdout_logistic:holdoutLogistic,
      member_selection_scores:regimeFit.member_validation_scores};
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
  const selected=validationSelectedRegimes.length>0&&validationModel.evaluated&&
    validationModel.beat_base_rate===true&&validationLogistic.evaluated&&
    validationModel.model_brier_score+comparisonMargin<validationLogistic.model_brier_score;
  const holdoutPassed=selectedRegimes.length>0&&holdoutModel.evaluated&&
    holdoutModel.beat_base_rate===true&&holdoutLogistic.evaluated&&
    holdoutModel.model_brier_score+comparisonMargin<holdoutLogistic.model_brier_score;
  const probabilityReady=holdoutPassed;
  const liveReady=probabilityReady&&holdoutModel.sample_count>=liveHoldoutSamples;
  const specialistProfiles=Object.fromEntries(regimes.map(regime=>{
    const supported=supportedRegimes.includes(regime);
    const result=regimeResults[regime]||{};
    return [regime,{
      status:!supported?'WAITING_FOR_REGIME_SPECIALIST_SAMPLE_COVERAGE':
        result.holdout_passed?'REGIME_TCN_OUT_OF_SAMPLE_VALIDATED':
        result.validation_passed?'REGIME_VALIDATION_PASSED_HOLDOUT_NOT_PASSED':
        'REGIME_TCN_DID_NOT_PASS_VALIDATION',
      support_gaps:result.support_gaps||[],
      model_scope:'INDEPENDENT_BTC_REGIME_TCN_EXPERT',
      training_start_at:result.training_start_at??null,
      selection_start_at:result.selection_start_at??null,
      validation_start_at:result.validation_start_at??null,
      max_training_outcome_resolved_at:result.max_training_outcome_resolved_at??null,
      training_samples:trainingByRegime[regime],
      selection_samples:selectionByRegime[regime],
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
      holdout_pooled_logistic_brier:result.holdout_logistic?.model_brier_score??null
    }];
  }));
  const reportTrainingSamples=hasDiagnosticRegimes
    ?diagnosticRegimes.reduce((sum,regime)=>sum+Number(trainingByRegime[regime]||0),0):fitRows.length;
  const reportSelectionSamples=hasDiagnosticRegimes
    ?diagnosticRegimes.reduce((sum,regime)=>sum+Number(selectionByRegime[regime]||0),0):0;
  const reportValidationSamples=hasDiagnosticRegimes
    ?diagnosticRegimes.reduce((sum,regime)=>sum+Number(validationByRegime[regime]||0),0):validation.length;
  const reportHoldoutSamples=hasDiagnosticRegimes
    ?diagnosticRegimes.reduce((sum,regime)=>sum+Number(holdoutByRegime[regime]||0),0):holdout.length;
  const reportTrainingPositive=hasDiagnosticRegimes
    ?diagnosticRegimes.reduce((sum,regime)=>sum+Number(trainingTargets[regime]?.positive||0),0)
    :targets.filter(value=>value===1).length;
  const reportTrainingNegative=hasDiagnosticRegimes
    ?diagnosticRegimes.reduce((sum,regime)=>sum+Number(trainingTargets[regime]?.negative||0),0)
    :targets.filter(value=>value===0).length;
  const reportTrainingPrior=(reportTrainingPositive+2)/(reportTrainingSamples+4);
  const reportMaxTrainingResolvedAt=hasDiagnosticRegimes
    ?Math.max(...diagnosticRegimes.map(regime=>Number(regimeResults[regime]?.max_training_outcome_resolved_at)||0))
    :maxTrainingOutcomeResolvedAt;
  const reportValidationStartAt=hasDiagnosticRegimes
    ?Math.min(...diagnosticRegimes.map(regime=>Number(regimeResults[regime]?.validation_start_at)||validationStart))
    :validationStart;
  const validationReason=!validationModel.evaluated?'CHRONOLOGICAL_VALIDATION_NOT_EVALUATED':
    !validationModel.beat_base_rate?'REGIME_TCN_DID_NOT_BEAT_BASE_RATE':
    !validationLogistic.evaluated?'REGIME_LOGISTIC_VALIDATION_NOT_EVALUATED':
    !selected?'REGIME_TCN_DID_NOT_BEAT_POOLED_LOGISTIC':'VALIDATION_PASSED';
  const holdoutReason=!selected?'VALIDATION_NOT_PASSED':
    !holdoutModel.evaluated?'UNTOUCHED_HOLDOUT_NOT_EVALUATED':
    !holdoutModel.beat_base_rate?'REGIME_TCN_DID_NOT_BEAT_HOLDOUT_BASE_RATE':
    !holdoutLogistic.evaluated?'REGIME_LOGISTIC_HOLDOUT_NOT_EVALUATED':
    !holdoutPassed?'REGIME_TCN_DID_NOT_BEAT_POOLED_LOGISTIC':'HOLDOUT_PASSED';
  const status=!validationModel.evaluated?'VALIDATION_NOT_EVALUATED':
    !selected?'VALIDATION_DID_NOT_BEAT_POOLED_BASELINE':
    !holdoutPassed?'VALIDATION_PASSED_HOLDOUT_NOT_PASSED':
    !supportedRegimes.length?'WAITING_FOR_REGIME_HOLDOUT_COVERAGE':
    liveReady?'LIVE_GATE_PASSED_OUT_OF_SAMPLE':'OUT_OF_SAMPLE_VALIDATED_PAPER_ONLY';
  return{
    status,architecture,target_definition:TEMPORAL_TARGET_DEFINITION,
    sequence_steps:TEMPORAL_SEQUENCE_STEPS,sequence_channels:TEMPORAL_SEQUENCE_CHANNELS,
    ensemble_members:SEEDS.length,ensemble_members_required:SEEDS.length,
    training_strategy:fitted.training_strategy,
    member_training_profiles:fitted.member_training_profiles,
    member_validation_scores:fitted.member_validation_scores,
    selected_member_index:fitted.selected_member_index,
    member_selection_method:'REGIME_SPECIFIC_CHRONOLOGICAL_SELECTION_BLOCK_BRIER',
    regime_specialist_count:2,
    regime_selection_mode:'BTC_24H_CONTEXT_FEATURE_WITH_REGIME_CONDITIONAL_OUT_OF_SAMPLE_GATES',
    model_scope:'INDEPENDENT_BTC_REGIME_TCN_EXPERTS',
    residual_anchor:'REGIME_MATCHED_POOLED_SEQUENCE_LOGISTIC_FROZEN',
    resolved_samples:rows.length,training_samples:reportTrainingSamples,
    selection_samples:reportSelectionSamples,
    validation_samples:reportValidationSamples,holdout_samples:reportHoldoutSamples,
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
      sample_count:holdoutModel.sample_count,
      required_live_holdout_samples:liveHoldoutSamples,
      required_brier_margin:comparisonMargin,
      tcn_brier_score:holdoutModel.model_brier_score,
      pooled_logistic_brier_score:holdoutLogistic.model_brier_score,
      beats_base_rate:holdoutModel.beat_base_rate===true,
      beats_pooled_logistic:holdoutLogistic.evaluated&&holdoutModel.evaluated&&
        holdoutModel.model_brier_score+comparisonMargin<holdoutLogistic.model_brier_score,
      regime_coverage:{training:trainingByRegime,selection:selectionByRegime,validation:validationByRegime,holdout:holdoutByRegime},
      supported_regimes:supportedRegimes,passed:holdoutPassed
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

