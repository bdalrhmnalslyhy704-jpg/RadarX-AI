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
export const TEMPORAL_SEQUENCE_CHANNELS=22;

const DILATIONS = Object.freeze([1, 2, 4]);
const KERNEL_TAPS = 2;
const HORIZON_MS = 4 * 60 * 60 * 1000;
const SEEDS = Object.freeze([13, 29, 47]);
const MIN_TRAIN = 160;
const MAX_TRAIN = 960;
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

function initializeModel(seed, baseRate = 0.5) {
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
  const prior=clamp(Number(baseRate)||0.5,0.02,0.98);
  // Start the neural residual at the training-only event prevalence instead of
  // an arbitrary 50% prior. This prevents a rare +3%-before-stop event from
  // remaining badly miscalibrated while the small residual layers learn.
  return {
    depthWeights,pointWeights,biases,outputWeights,
    outputBias:Math.log(prior/(1-prior))
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

function fitMember(rows, seed, { epochs = 10, learningRate = 0.006, l2 = 0.012, baseRate = 0.5 } = {}) {
  const model = initializeModel(seed,baseRate);
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
function fitEnsemble(rows, options = {}) {
  const baseRate=Number.isFinite(Number(options.baseRate))
    ?clamp(Number(options.baseRate),0.02,0.98)
    :(rows.reduce((sum,row)=>sum+row.target,0)+2)/(rows.length+4);
  const members = SEEDS.map(seed => fitMember(rows, seed, {...options,baseRate}));
  return {
    members,seeds:[...SEEDS],
    architecture:'TCN_24x22_DILATED_RESIDUAL_BTC_REGIME_MIXTURE_OF_EXPERTS_V5',
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
  const minRegimeValidation=Math.max(12,Math.floor(minimumValidationSamples/2));
  const minRegimeHoldout=Math.max(20,Math.floor(minimumHoldoutSamples/2));
  const countTrailingGroups=(endExclusive,targetRows,minPerRegime=0)=>{
    let groups=0,total=0,riskOn=0,riskOff=0;
    for(let index=endExclusive-1;index>=0;index--){
      const group=rowsByTime.get(uniqueTimes[index])||[];
      groups++;total+=group.length;
      for(const row of group){
        const regime=regimeOfSequence(row.sequence);
        if(regime==='BTC_RISK_ON')riskOn++;
        else if(regime==='BTC_RISK_OFF')riskOff++;
      }
      if(groups>=2&&total>=targetRows&&
         (!minPerRegime||(riskOn>=minPerRegime&&riskOff>=minPerRegime)))break;
    }
    return groups;
  };
  // Hold out enough complete timestamp groups to preserve at least 100 untouched
  // outcomes when the sample history permits it. This frees unnecessary old
  // timestamps for training without weakening the holdout performance threshold.
  const holdoutTargetSamples=Math.max(minimumHoldoutSamples,
    Math.min(liveHoldoutSamples,Math.floor(rows.length*0.2)));
  const holdoutCount=countTrailingGroups(uniqueTimes.length,holdoutTargetSamples);
  const validationTargetSamples=Math.max(minimumValidationSamples,Math.floor(rows.length*0.15));
  const validationCount=countTrailingGroups(uniqueTimes.length-holdoutCount,validationTargetSamples);
  const trainingEndIndex=uniqueTimes.length-holdoutCount-validationCount;
  const enoughSplit=trainingEndIndex>0;
  const emptySpecialists=Object.fromEntries(regimes.map(regime=>[regime,{
    status:'WAITING_FOR_CHRONOLOGICAL_SPLIT',training_samples:0,validation_samples:0,holdout_samples:0,
    selected:false,probability_ready:false
  }]));
  if(!enoughSplit)return{
    status:'WAITING_FOR_TEMPORAL_FIRST_PASSAGE_SAMPLES',
    architecture:'TCN_24x22_DILATED_RESIDUAL_BTC_REGIME_MIXTURE_OF_EXPERTS_V5',
    target_definition:TEMPORAL_TARGET_DEFINITION,
    sequence_steps:TEMPORAL_SEQUENCE_STEPS,sequence_channels:TEMPORAL_SEQUENCE_CHANNELS,
    ensemble_members:0,ensemble_members_required:SEEDS.length,regime_specialist_count:2,
    regime_selection_mode:'BTC_24H_TREND_SIGNED_TWO_EXPERTS',
    resolved_samples:rows.length,training_samples:0,validation_samples:0,holdout_samples:0,
    required_training_samples:minTrainingSamples,required_validation_samples:minimumValidationSamples,
    required_holdout_samples:minimumHoldoutSamples,probability_ready:false,live_eligibility_ready:false,
    validation_start_at:null,holdout_start_at:null,max_training_outcome_resolved_at:null,
    trained:false,selected:false,regime_specialists:emptySpecialists,
    validation:{evaluated:false,reason:'THREE_CHRONOLOGICAL_BLOCKS_REQUIRED'},
    holdout:{evaluated:false,reason:'THREE_CHRONOLOGICAL_BLOCKS_REQUIRED'},
    holdout_comparison:{passed:false,required_live_holdout_samples:liveHoldoutSamples},
    _fit:null,_regime_fits:null,_baseline_fit:null
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
     holdout.length<minimumHoldoutSamples)return{
    status:'WAITING_FOR_TEMPORAL_FIRST_PASSAGE_SAMPLES',
    architecture:'TCN_24x22_DILATED_RESIDUAL_BTC_REGIME_MIXTURE_OF_EXPERTS_V5',
    target_definition:TEMPORAL_TARGET_DEFINITION,
    sequence_steps:TEMPORAL_SEQUENCE_STEPS,sequence_channels:TEMPORAL_SEQUENCE_CHANNELS,
    ensemble_members:0,ensemble_members_required:SEEDS.length,regime_specialist_count:2,
    regime_selection_mode:'BTC_24H_TREND_SIGNED_TWO_EXPERTS',
    resolved_samples:rows.length,training_samples:training.length,
    validation_samples:validation.length,holdout_samples:holdout.length,
    required_training_samples:minTrainingSamples,required_validation_samples:minimumValidationSamples,
    required_holdout_samples:minimumHoldoutSamples,probability_ready:false,live_eligibility_ready:false,
    validation_start_at:validationStart,holdout_start_at:holdoutStart,
    max_training_outcome_resolved_at:maxTrainingOutcomeResolvedAt,
    trained:false,selected:false,regime_specialists:emptySpecialists,
    validation:{evaluated:false,reason:'TEMPORAL_CHRONOLOGICAL_SAMPLE_MINIMUMS_NOT_MET'},
    holdout:{evaluated:false,reason:'TEMPORAL_CHRONOLOGICAL_SAMPLE_MINIMUMS_NOT_MET'},
    holdout_comparison:{passed:false,required_live_holdout_samples:liveHoldoutSamples},
    _fit:null,_regime_fits:null,_baseline_fit:null
  };

  const fitRows=training.slice(-Math.max(minTrainingSamples,maxTrainingSamples));
  const targets=fitRows.map(row=>row.target);
  const baseRate=(targets.reduce((sum,value)=>sum+value,0)+2)/(targets.length+4);
  const pooledBaseline=fitLogistic(fitRows);
  const specialistFits={};
  const specialistProfiles={};

  for(const regime of regimes){
    const regimeTraining=fitRows.filter(row=>regimeOfSequence(row.sequence)===regime);
    const regimeValidation=validation.filter(row=>regimeOfSequence(row.sequence)===regime);
    const regimeHoldout=holdout.filter(row=>regimeOfSequence(row.sequence)===regime);
    const enoughRegimeSamples=regimeTraining.length>=minRegimeTraining&&
      regimeValidation.length>=minRegimeValidation&&regimeHoldout.length>=minRegimeHoldout;
    if(!enoughRegimeSamples){
      specialistProfiles[regime]={
        status:'WAITING_FOR_REGIME_CHRONOLOGICAL_SAMPLES',
        training_samples:regimeTraining.length,validation_samples:regimeValidation.length,
        holdout_samples:regimeHoldout.length,required_training_samples:minRegimeTraining,
        required_validation_samples:minRegimeValidation,required_holdout_samples:minRegimeHoldout,
        selected:false,probability_ready:false,live_eligibility_ready:false
      };
      continue;
    }
    const regimeTargets=regimeTraining.map(row=>row.target);
    const regimePrior=(regimeTargets.reduce((sum,value)=>sum+value,0)+2)/(regimeTargets.length+4);
    const regimeFit=fitEnsemble(regimeTraining,{epochs,learningRate,l2,baseRate:regimePrior});
    const regimeBaseline=fitLogistic(regimeTraining);
    const validationModel=evaluate(regimeValidation,sequence=>predict(sequence,regimeFit),regimePrior);
    const validationLogistic=evaluate(regimeValidation,sequence=>predictLogistic(sequence,regimeBaseline),regimeBaseline.base_rate);
    const selected=validationModel.evaluated&&validationLogistic.evaluated&&
      validationModel.beat_base_rate===true&&
      validationModel.model_brier_score+comparisonMargin<validationLogistic.model_brier_score;
    const holdoutModel=evaluate(regimeHoldout,sequence=>predict(sequence,regimeFit),regimePrior);
    const holdoutLogistic=evaluate(regimeHoldout,sequence=>predictLogistic(sequence,regimeBaseline),regimeBaseline.base_rate);
    const holdoutPassed=selected&&holdoutModel.evaluated&&holdoutLogistic.evaluated&&
      holdoutModel.beat_base_rate===true&&
      holdoutModel.model_brier_score+comparisonMargin<holdoutLogistic.model_brier_score;
    specialistFits[regime]=regimeFit;
    specialistProfiles[regime]={
      status:!selected?'VALIDATION_DID_NOT_BEAT_REGIME_BASELINE':
        !holdoutPassed?'VALIDATION_PASSED_HOLDOUT_NOT_PASSED':
        regimeHoldout.length>=liveHoldoutSamples?'LIVE_GATE_PASSED_OUT_OF_SAMPLE':'OUT_OF_SAMPLE_VALIDATED_PAPER_ONLY',
      training_samples:regimeTraining.length,validation_samples:regimeValidation.length,
      holdout_samples:regimeHoldout.length,training_positive_count:regimeTargets.filter(value=>value===1).length,
      training_positive_rate_pct:Number((regimePrior*100).toFixed(2)),
      validation_positive_rate_pct:validationModel.positive_rate_pct,
      holdout_positive_rate_pct:holdoutModel.positive_rate_pct,
      ensemble_members:regimeFit.members.length,ensemble_members_required:SEEDS.length,
      validation:{...validationModel,pooled_logistic_brier_score:validationLogistic.model_brier_score},
      holdout:{...holdoutModel,pooled_logistic_brier_score:holdoutLogistic.model_brier_score},
      selected,probability_ready:holdoutPassed,
      live_eligibility_ready:holdoutPassed&&regimeHoldout.length>=liveHoldoutSamples,
      holdout_comparison:{
        beats_base_rate:holdoutModel.beat_base_rate===true,
        beats_pooled_logistic:holdoutLogistic.evaluated&&holdoutModel.evaluated&&
          holdoutModel.model_brier_score+comparisonMargin<holdoutLogistic.model_brier_score,
        passed:holdoutPassed
      }
    };
  }

  const regimeCoverageReady=regimes.every(regime=>
    specialistProfiles[regime]?.training_samples>=minRegimeTraining&&
    specialistProfiles[regime]?.validation_samples>=minRegimeValidation&&
    specialistProfiles[regime]?.holdout_samples>=minRegimeHoldout);
  const regimeValidationSelected=regimes.every(regime=>specialistProfiles[regime]?.selected===true);
  const regimeHoldoutsPassed=regimes.every(regime=>specialistProfiles[regime]?.probability_ready===true);
  const regimePredict=sequence=>{
    const regime=regimeOfSequence(sequence);
    const fit=specialistFits[regime];
    return fit?predict(sequence,fit):Number.NaN;
  };
  const validationModel=evaluate(validation,regimePredict,baseRate);
  const validationLogistic=evaluate(validation,sequence=>predictLogistic(sequence,pooledBaseline),pooledBaseline.base_rate);
  const selected=regimeCoverageReady&&regimeValidationSelected&&validationModel.evaluated&&
    validationModel.model_brier_score+comparisonMargin<validationLogistic.model_brier_score;
  const holdoutModel=evaluate(holdout,regimePredict,baseRate);
  const holdoutLogistic=evaluate(holdout,sequence=>predictLogistic(sequence,pooledBaseline),pooledBaseline.base_rate);
  const holdoutPassed=selected&&regimeHoldoutsPassed&&holdoutModel.evaluated&&holdoutLogistic.evaluated&&
    holdoutModel.model_brier_score+comparisonMargin<holdoutLogistic.model_brier_score;
  const probabilityReady=holdoutPassed===true;
  const liveReady=probabilityReady&&holdout.length>=liveHoldoutSamples&&
    regimes.every(regime=>specialistProfiles[regime]?.holdout_samples>=minRegimeHoldout);
  const validationReason=!regimeCoverageReady?'REGIME_SPECIALIST_SAMPLE_COVERAGE_INCOMPLETE':
    !regimeValidationSelected?'A_REGIME_SPECIALIST_FAILED_CHRONOLOGICAL_VALIDATION':
    !selected?'REGIME_ENSEMBLE_DID_NOT_BEAT_POOLED_LOGISTIC':'VALIDATION_PASSED';
  const holdoutReason=!selected?'VALIDATION_NOT_PASSED':
    !regimeHoldoutsPassed?'A_REGIME_SPECIALIST_FAILED_UNTOUCHED_HOLDOUT':
    !holdoutPassed?'REGIME_ENSEMBLE_DID_NOT_BEAT_POOLED_LOGISTIC':'HOLDOUT_PASSED';
  return{
    status:!regimeCoverageReady?'WAITING_FOR_REGIME_SPECIALIST_SAMPLE_COVERAGE':
      !selected?'VALIDATION_DID_NOT_BEAT_POOLED_BASELINE':
      !holdoutPassed?'VALIDATION_PASSED_HOLDOUT_NOT_PASSED':
      liveReady?'LIVE_GATE_PASSED_OUT_OF_SAMPLE':'OUT_OF_SAMPLE_VALIDATED_PAPER_ONLY',
    architecture:'TCN_24x22_DILATED_RESIDUAL_BTC_REGIME_MIXTURE_OF_EXPERTS_V5',
    target_definition:TEMPORAL_TARGET_DEFINITION,
    sequence_steps:TEMPORAL_SEQUENCE_STEPS,sequence_channels:TEMPORAL_SEQUENCE_CHANNELS,
    ensemble_members:SEEDS.length,ensemble_members_required:SEEDS.length,
    regime_specialist_count:2,regime_selection_mode:'BTC_24H_TREND_SIGNED_TWO_EXPERTS',
    resolved_samples:rows.length,training_samples:fitRows.length,
    validation_samples:validation.length,holdout_samples:holdout.length,
    required_training_samples:minTrainingSamples,required_validation_samples:minimumValidationSamples,
    required_holdout_samples:minimumHoldoutSamples,
    validation_start_at:validationStart,holdout_start_at:holdoutStart,
    max_training_outcome_resolved_at:maxTrainingOutcomeResolvedAt,
    training_positive_rate_pct:Number((baseRate*100).toFixed(2)),
    training_positive_count:targets.filter(value=>value===1).length,
    training_negative_count:targets.filter(value=>value===0).length,
    training_prior_probability:Number(baseRate.toFixed(5)),
    trained:true,selected,probability_ready:probabilityReady,live_eligibility_ready:liveReady,
    regime_specialists:specialistProfiles,
    validation:{
      ...validationModel,selected_over_pooled_logistic:selected,
      pooled_logistic_brier_score:validationLogistic.model_brier_score,
      reason:validationReason
    },
    holdout:{
      ...holdoutModel,pooled_logistic_brier_score:holdoutLogistic.model_brier_score,
      reason:holdoutReason
    },
    holdout_comparison:{
      sample_count:holdout.length,required_live_holdout_samples:liveHoldoutSamples,
      required_brier_margin:comparisonMargin,
      tcn_brier_score:holdoutModel.model_brier_score,
      pooled_logistic_brier_score:holdoutLogistic.model_brier_score,
      beats_base_rate:holdoutModel.beat_base_rate===true,
      beats_pooled_logistic:holdoutLogistic.evaluated&&holdoutModel.evaluated&&
        holdoutModel.model_brier_score+comparisonMargin<holdoutLogistic.model_brier_score,
      regime_specialists_passed:regimeHoldoutsPassed,passed:holdoutPassed
    },
    _fit:null,
    _regime_fits:probabilityReady?specialistFits:null,
    _baseline_fit:pooledBaseline
  };
}

export function predictTemporalProbability(sequence,profile={}){
  if(profile?.probability_ready!==true||!profile?._regime_fits||!validSequence(sequence))return null;
  const regime=regimeOfSequence(sequence);
  const fit=profile._regime_fits[regime];
  return fit?predict(sequence,fit):null;
}
