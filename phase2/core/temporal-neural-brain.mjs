/**
 * RadarX Build 224 — Temporal Convolutional Neural Brain
 *
 * A compact, causal, dilated, residual depthwise-separable TCN. It learns
 * from fixed windows of verified closed-candle features. It is a challenger:
 * it may publish probabilities only after chronological validation and an
 * untouched holdout beat both a prevalence and same-window pooled-logistic
 * baseline. This module is analysis-only.
 */
// Backward-compatible default contract. The daily benchmark opts into its
// own target definition and horizon through buildTemporalNeuralProfile options.
export const TEMPORAL_TARGET_DEFINITION =
  'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2';
export const TEMPORAL_SEQUENCE_STEPS = 24;
export const TEMPORAL_SEQUENCE_CHANNELS=29;
export const TEMPORAL_POOLED_BASELINE_FEATURE_COUNT=TEMPORAL_SEQUENCE_CHANNELS*2;
export const TEMPORAL_LATENT_CHANNELS=16;
export const TEMPORAL_TRAINABLE_PARAMETER_COUNT=1408;
export const TEMPORAL_GRADIENT_ACCUMULATION='IN_PLACE_WEIGHTED_SUM_V1';
export const TEMPORAL_BASELINE_FEATURE_CACHE='PER_ROW_POOLED_FEATURES_REUSED_ACROSS_EPOCHS_AND_MEMBERS_V1';
export const TEMPORAL_GRADIENT_BUFFER_SCOPE='TRAINABLE_PARAMETERS_ONLY_REUSED_ROW_SCRATCH_V1';
export const TEMPORAL_REGIME_LOCAL_MAX_TRAINING_SAMPLES=4096;
export const TEMPORAL_REGIME_LOCAL_TRAINING_STRATEGY='INDEPENDENT_BTC_REGIME_TCN_RECENT_4096_TRAIN_ONLY_V1';
export const TEMPORAL_MODEL_ARCHITECTURE='TCN_24x29_TO16_LATENT_DILATED_RESIDUAL_BTC_CONTEXT_V8';
export const TEMPORAL_ORDERED_POOLING_MODE='ORDERED_FOUR_SEGMENT_MEAN_V1';
export const TEMPORAL_ORDERED_POOLING_SEGMENTS=4;
export const TEMPORAL_ORDERED_POOLING_FEATURE_COUNT=
  TEMPORAL_LATENT_CHANNELS*TEMPORAL_ORDERED_POOLING_SEGMENTS;
export const TEMPORAL_ORDERED_POOLING_TRAINABLE_PARAMETER_COUNT=
  TEMPORAL_TRAINABLE_PARAMETER_COUNT-
  TEMPORAL_LATENT_CHANNELS+TEMPORAL_ORDERED_POOLING_FEATURE_COUNT;
export const TEMPORAL_ORDERED_POOLING_MODEL_ARCHITECTURE=
  'TCN_24x29_TO16_LATENT_DILATED_RESIDUAL_ORDERED_FOUR_SEGMENT_POOLING_V9';

const DILATIONS = Object.freeze([1, 2, 4]);
const KERNEL_TAPS = 2;
// Default legacy horizon; parameterized daily experiments override this at the profile boundary.
const HORIZON_MS = 4 * 60 * 60 * 1000;
const SEEDS = Object.freeze([13, 29, 47]);
const RESIDUAL_SCALES = Object.freeze([0,0.1,0.25,0.5,1]);
const MIN_TRAIN = 160;
const MAX_TRAIN = 1280;
const MIN_VALIDATION = 24;
const MIN_HOLDOUT = 40;
const LIVE_HOLDOUT = 150;
const EPSILON = 1e-8;

import {createHash} from 'node:crypto';

function sampleIdentityFingerprint(rows){
  const canonical=(Array.isArray(rows)?rows:[]).map(row=>[
    String(row?.id||''),String(row?.symbol||'').trim().toUpperCase(),
    Number(row?.at),Number(row?.resolved_at),String(row?.outcome||'')
  ]).sort((a,b)=>a[2]-b[2]||a[0].localeCompare(b[0]));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function isValidTemporalPooledBaselineFeatures(features){
  return Array.isArray(features)&&features.length===TEMPORAL_POOLED_BASELINE_FEATURE_COUNT&&
    features.every(value=>finite(value)!==null);
}

// The scientific acceptance policy requires a strict 0.003 Brier improvement
// over every baseline. A tiny tolerance prevents floating-point equality from
// accidentally passing a boundary that is meant to be strictly greater.
export const TEMPORAL_BRIER_SUPERIORITY_MARGIN = 0.003;
export function hasTemporalBrierSuperiority(candidateScore, baselineScore,
  margin = TEMPORAL_BRIER_SUPERIORITY_MARGIN) {
  const candidate = finite(candidateScore);
  const baseline = finite(baselineScore);
  const required = finite(margin);
  return candidate !== null && baseline !== null && required !== null && required >= 0 &&
    baseline - candidate - required > 1e-12;
}
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const logistic = value => 1 / (1 + Math.exp(-clamp(value, -12, 12)));
export function temporalBinaryTarget(outcome) {
  // UP=1 is the sample-declared first-passage event; DOWN and FLAT are non-events.
  // DOWN and FLAT both mean that the success event did not occur.
  return outcome === 'UP' ? 1 : 0;
}
const targetOf = row => temporalBinaryTarget(row.outcome);

function validSequence(sequence) {
  return Array.isArray(sequence) && sequence.length === TEMPORAL_SEQUENCE_STEPS &&
    sequence.every(row => Array.isArray(row) && row.length === TEMPORAL_SEQUENCE_CHANNELS &&
      row.every(value => finite(value) !== null && Math.abs(Number(value)) <= 4));
}

function cleanRows(samples, {
  targetDefinition = TEMPORAL_TARGET_DEFINITION,
  outcomeHorizonMs = HORIZON_MS,
  allowedOutcomeSources = null
} = {}) {
  const horizonMs = Math.max(1, Math.trunc(Number(outcomeHorizonMs) || HORIZON_MS));
  const allowedSources = Array.isArray(allowedOutcomeSources)
    ? new Set(allowedOutcomeSources.map(String)) : null;
  const seen = new Set();
  return (Array.isArray(samples) ? samples : []).filter(row => {
    if (!row || row.training_eligible !== true ||
        (row.closed_candle_baseline !== true && row.historical_baseline !== true) ||
        row.target_definition !== targetDefinition ||
        row.first_passage?.path_resolution !== '15M' ||
        row.first_passage?.outcome !== row.outcome ||
        !['UP', 'DOWN', 'FLAT'].includes(row.outcome) ||
        !(allowedSources ? allowedSources.has(String(row.outcome_source || '')) :
          row.outcome_source === (row.historical_baseline === true
            ? 'HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1'
            : 'CLOSED_CANDLE_4H_FIRST_PASSAGE_V1')) ||
        !validSequence(row.temporal_sequence)) return false;
    const at = finite(row.at), resolvedAt = finite(row.resolved_at), horizon = finite(row.horizon_ms);
    const symbol = String(row.symbol || '').trim().toUpperCase();
    const id = String(row.id || '');
    const baseline = symbol + ':' + String(Math.trunc(at || 0));
    if (!id || !symbol || at === null || at <= 0 || resolvedAt === null ||
        resolvedAt - at !== horizonMs || horizon !== horizonMs ||
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
function zeroTrainableGradients(model) {
  return {
    projectionWeights:zerosLike(model.projectionWeights),
    projectionBiases:zerosLike(model.projectionBiases),
    depthWeights:zerosLike(model.depthWeights),
    pointWeights:zerosLike(model.pointWeights),
    biases:zerosLike(model.biases),
    outputWeights:zerosLike(model.outputWeights)
  };
}
export function resetGradientBuffer(target) {
  if(Array.isArray(target)){
    for(let index=0;index<target.length;index++){
      const value=target[index];
      if(Array.isArray(value)||(value&&typeof value==='object'))resetGradientBuffer(value);
      else target[index]=0;
    }
    return target;
  }
  if(target&&typeof target==='object'){
    for(const key of Object.keys(target)){
      const value=target[key];
      if(Array.isArray(value)||(value&&typeof value==='object'))resetGradientBuffer(value);
      else target[key]=0;
    }
  }
  return target;
}
// Accumulate one sample's weighted gradient directly into the reusable
// epoch buffer. The previous recursive map created a complete second gradient
// tree for every row in every epoch, causing avoidable allocation/GC pressure.
// Traversal and floating-point operation order remain identical.
function addScaledTreeInPlace(target, source, scale = 1) {
  if (!Array.isArray(target) || !Array.isArray(source) ||
      target.length !== source.length) {
    throw new TypeError('TEMPORAL_GRADIENT_SHAPE_MISMATCH');
  }
  for (let index = 0; index < target.length; index++) {
    if (Array.isArray(target[index])) {
      addScaledTreeInPlace(target[index], source[index], scale);
    } else {
      target[index] += source[index] * scale;
    }
  }
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

function initializeModel(seed, baseRate = 0.5, baselineFit = null, temporalPoolingMode='LAST_12_MEAN_V1') {
  const inputChannels=TEMPORAL_SEQUENCE_CHANNELS;
  const channels=TEMPORAL_LATENT_CHANNELS;
  const layers=DILATIONS.length;
  const offset=Number(seed)*0.6180339887498949;
  const projectionWeights=Array.from({length:inputChannels},(_,input)=>
    Array.from({length:channels},(_,output)=>
      0.045*Math.sin((input+1)*3.71+(output+1)*5.23+offset)));
  const projectionBiases=Array.from({length:channels},(_,channel)=>
    0.002*Math.cos((channel+1)*2.17+offset));
  const depthWeights=Array.from({length:layers},(_,layer)=>
    Array.from({length:KERNEL_TAPS},(_,tap)=>
      Array.from({length:channels},(_,channel)=>
        0.035*Math.sin((layer+1)*4.17+(tap+1)*6.31+(channel+1)*2.13+offset))));
  const pointWeights=Array.from({length:layers},(_,layer)=>
    Array.from({length:channels},(_,input)=>
      Array.from({length:channels},(_,output)=>
        0.025*Math.cos((layer+1)*3.71+(input+1)*2.91+(output+1)*5.23+offset))));
  const biases=Array.from({length:layers},(_,layer)=>
    Array.from({length:channels},(_,channel)=>
      0.002*Math.sin((layer+1)*5.3+(channel+1)*1.7+offset)));
  const orderedPooling=temporalPoolingMode===TEMPORAL_ORDERED_POOLING_MODE;
  const outputFeatureCount=orderedPooling
    ?TEMPORAL_ORDERED_POOLING_FEATURE_COUNT:channels;
  const trainableParameterCount=TEMPORAL_TRAINABLE_PARAMETER_COUNT-
    channels+outputFeatureCount;
  const outputWeights=Array.from({length:outputFeatureCount},(_,feature)=>
    0.01*Math.sin((feature+1)*4.73+offset));
  const prior=clamp(Number(baseRate)||0.5,0.02,0.98);
  const baselineWeights=Array.isArray(baselineFit?.weights)&&
    baselineFit.weights.length===inputChannels*2
      ?baselineFit.weights.map(value=>clamp(Number(value)||0,-4,4))
      :Array(inputChannels*2).fill(0);
  const baselineBias=Number.isFinite(Number(baselineFit?.bias))
    ?Number(baselineFit.bias):Math.log(prior/(1-prior));
  return {
    projectionWeights,projectionBiases,depthWeights,pointWeights,biases,outputWeights,
    skipWeights:baselineWeights,outputBias:baselineBias,baseline_by_regime:null,
    residual_anchor:baselineFit?'TRAINING_ONLY_LOGISTIC_ANCHOR':'TRAINING_PREVALENCE_PRIOR',
    temporal_pooling:temporalPoolingMode,
    output_features:outputFeatureCount,
    latent_channels:channels,trainable_parameters:trainableParameterCount
  };
}

/**
 * Preserve the order of a full 24-step latent sequence by averaging four
 * contiguous six-step segments independently. The output layout is
 * [segment_0 channels..., segment_1 channels..., segment_2..., segment_3...].
 */
export function poolOrderedTemporalSegments(latentRows){
  if(!Array.isArray(latentRows)||latentRows.length!==TEMPORAL_SEQUENCE_STEPS||
    latentRows.some(row=>!Array.isArray(row)||row.length!==TEMPORAL_LATENT_CHANNELS||
      row.some(value=>!Number.isFinite(Number(value)))))return null;
  const features=[],poolSegments=[];
  for(let segment=0;segment<TEMPORAL_ORDERED_POOLING_SEGMENTS;segment++){
    const start=Math.floor(segment*latentRows.length/TEMPORAL_ORDERED_POOLING_SEGMENTS);
    const end=Math.floor((segment+1)*latentRows.length/TEMPORAL_ORDERED_POOLING_SEGMENTS);
    const count=end-start,featureOffset=features.length;
    for(let channel=0;channel<TEMPORAL_LATENT_CHANNELS;channel++){
      let sum=0;
      for(let time=start;time<end;time++)sum+=Number(latentRows[time][channel]);
      features.push(sum/Math.max(1,count));
    }
    poolSegments.push({start,count,feature_offset:featureOffset,segment_index:segment});
  }
  return {features,poolSegments};
}

function forward(sequence, model, residualScale=1, precomputedBaselineFeatures=null) {
  const channels=TEMPORAL_LATENT_CHANNELS;
  const projected=sequence.map(row=>Array.from({length:channels},(_,outputChannel)=>{
    let value=model.projectionBiases[outputChannel];
    for(let inputChannel=0;inputChannel<TEMPORAL_SEQUENCE_CHANNELS;inputChannel++){
      value+=row[inputChannel]*model.projectionWeights[inputChannel][outputChannel];
    }
    return Math.tanh(value);
  }));
  const activations=[projected],depthCaches=[];
  for(let layer=0;layer<DILATIONS.length;layer++){
    const input=activations[layer],dilation=DILATIONS[layer];
    const depth=input.map((row,time)=>row.map((_,channel)=>{
      let value=input[time][channel];
      for(let tap=1;tap<=KERNEL_TAPS;tap++){
        const previous=time-tap*dilation;
        if(previous>=0)value+=model.depthWeights[layer][tap-1][channel]*input[previous][channel];
      }
      return value;
    }));
    const output=depth.map((row,time)=>row.map((_,outputChannel)=>{
      let value=input[time][outputChannel]+model.biases[layer][outputChannel];
      for(let inputChannel=0;inputChannel<channels;inputChannel++){
        value+=depth[time][inputChannel]*model.pointWeights[layer][inputChannel][outputChannel];
      }
      return Math.tanh(value);
    }));
    depthCaches.push(depth);activations.push(output);
  }
  const final=activations.at(-1);
  let pooled,poolSegments,poolStart,poolCount;
  if(model.temporal_pooling===TEMPORAL_ORDERED_POOLING_MODE){
    const pyramid=poolOrderedTemporalSegments(final);
    if(!pyramid)throw new TypeError('TEMPORAL_ORDERED_POOLING_INPUT_INVALID');
    pooled=pyramid.features;poolSegments=pyramid.poolSegments;
    poolStart=0;poolCount=TEMPORAL_SEQUENCE_STEPS;
  }else{
    poolStart=Math.max(0,final.length-12);
    poolCount=final.length-poolStart;
    pooled=Array(channels).fill(0);
    for(let time=poolStart;time<final.length;time++){
      for(let channel=0;channel<pooled.length;channel++)pooled[channel]+=final[time][channel]/poolCount;
    }
    poolSegments=[{start:poolStart,count:poolCount,feature_offset:0,segment_index:0}];
  }
  const baselineFeatures=isValidTemporalPooledBaselineFeatures(precomputedBaselineFeatures)
    ?precomputedBaselineFeatures:pooledSequence(sequence);
  const regimeBaseline=model.baseline_by_regime?.[regimeOfSequence(sequence)]||null;
  const baselineWeights=Array.isArray(regimeBaseline?.weights)?regimeBaseline.weights:model.skipWeights;
  const baselineBias=Number.isFinite(Number(regimeBaseline?.bias))?Number(regimeBaseline.bias):model.outputBias;
  let logit=baselineBias;
  for(let feature=0;feature<baselineFeatures.length;feature++){
    logit+=baselineFeatures[feature]*(Number(baselineWeights?.[feature])||0);
  }
  const boundedResidualScale=clamp(Number(residualScale)||0,0,1);
  for(let feature=0;feature<pooled.length;feature++){
    logit+=pooled[feature]*model.outputWeights[feature]*boundedResidualScale;
  }
  return {probability:logistic(logit),activations,depthCaches,pooled,poolStart,poolCount,poolSegments,baselineFeatures};
}

function gradientsFor(sequence, target, model, cache, trainingObjective='UNWEIGHTED_BRIER_PROPER_SCORING_RULE', gradients=null) {
  const targetGradients=gradients||zeroTrainableGradients(model);
  resetGradientBuffer(targetGradients);
  const channels=TEMPORAL_LATENT_CHANNELS;
  const activationGradients=Array(DILATIONS.length+1);
  const final=cache.activations.at(-1);
  activationGradients[DILATIONS.length]=final.map(()=>Array(channels).fill(0));
  const probabilityError=cache.probability-target;
  const brierGradient=2*probabilityError*cache.probability*(1-cache.probability);
  const logLossGradient=probabilityError;
  const error=trainingObjective==='UNWEIGHTED_LOG_LOSS_PROPER_SCORING_RULE'
    ?logLossGradient
    :trainingObjective==='MIXED_BRIER_LOG_LOSS_50_50_PROPER_SCORING_RULE'
      ?0.5*brierGradient+0.5*logLossGradient
      :brierGradient;
  const poolSegments=Array.isArray(cache.poolSegments)&&cache.poolSegments.length
    ?cache.poolSegments:[{start:cache.poolStart,count:cache.poolCount,feature_offset:0,segment_index:0}];
  for(let feature=0;feature<cache.pooled.length;feature++){
    const segmentIndex=Math.floor(feature/channels);
    const channel=feature%channels;
    const segment=poolSegments[segmentIndex];
    if(!segment)throw new TypeError('TEMPORAL_POOLING_GRADIENT_SEGMENT_MISSING');
    targetGradients.outputWeights[feature]=error*cache.pooled[feature];
    for(let time=segment.start;time<segment.start+segment.count;time++){
      activationGradients[DILATIONS.length][time][channel]+=
        error*model.outputWeights[feature]/segment.count;
    }
  }
  for(let layer=DILATIONS.length-1;layer>=0;layer--){
    const input=cache.activations[layer],output=cache.activations[layer+1];
    const depth=cache.depthCaches[layer],dilation=DILATIONS[layer];
    const inputGradient=input.map(()=>Array(channels).fill(0));
    const outputGradient=activationGradients[layer+1];
    for(let time=0;time<output.length;time++){
      for(let outputChannel=0;outputChannel<channels;outputChannel++){
        const activation=output[time][outputChannel];
        const dz=outputGradient[time][outputChannel]*(1-activation*activation);
        targetGradients.biases[layer][outputChannel]+=dz;
        inputGradient[time][outputChannel]+=dz;
        for(let inputChannel=0;inputChannel<channels;inputChannel++){
          targetGradients.pointWeights[layer][inputChannel][outputChannel]+=depth[time][inputChannel]*dz;
          const depthGradient=model.pointWeights[layer][inputChannel][outputChannel]*dz;
          inputGradient[time][inputChannel]+=depthGradient;
          for(let tap=1;tap<=KERNEL_TAPS;tap++){
            const previous=time-tap*dilation;
            if(previous<0)continue;
            targetGradients.depthWeights[layer][tap-1][inputChannel]+=
              input[previous][inputChannel]*depthGradient;
            inputGradient[previous][inputChannel]+=
              model.depthWeights[layer][tap-1][inputChannel]*depthGradient;
          }
        }
      }
    }
    activationGradients[layer]=inputGradient;
  }
  const projected=cache.activations[0];
  for(let time=0;time<sequence.length;time++){
    for(let outputChannel=0;outputChannel<channels;outputChannel++){
      const activation=projected[time][outputChannel];
      const dz=activationGradients[0][time][outputChannel]*(1-activation*activation);
      targetGradients.projectionBiases[outputChannel]+=dz;
      for(let inputChannel=0;inputChannel<TEMPORAL_SEQUENCE_CHANNELS;inputChannel++){
        targetGradients.projectionWeights[inputChannel][outputChannel]+=sequence[time][inputChannel]*dz;
      }
    }
  }
  return targetGradients;
}

function fitMember(rows, seed, {
  epochs = 10, learningRate = 0.006, l2 = 0.012,
  baseRate = 0.5, baselineFit = null, baselineByRegime = null,
  trainingObjective='UNWEIGHTED_BRIER_PROPER_SCORING_RULE',
  positiveClassWeighting='NONE',
  temporalPoolingMode='LAST_12_MEAN_V1'
} = {}) {
  const model = initializeModel(seed,baseRate,baselineFit,temporalPoolingMode);
  const positiveSamples=rows.filter(row=>Number(row?.target)>0.5).length;
  const negativeSamples=Math.max(0,rows.length-positiveSamples);
  const usePositiveClassWeighting=positiveClassWeighting==='SQRT_INVERSE_PREVALENCE';
  const positiveSampleWeight=usePositiveClassWeighting&&positiveSamples>0
    ?clamp(Math.sqrt(negativeSamples/positiveSamples),1,3):1;
  const totalSampleWeight=negativeSamples+positiveSamples*positiveSampleWeight;
  model.training_sample_profile={training_samples:rows.length,positive_samples:positiveSamples,
    negative_samples:negativeSamples,positive_class_weighting:usePositiveClassWeighting
      ?'SQRT_INVERSE_PREVALENCE':'NONE',positive_sample_weight:Number(positiveSampleWeight.toFixed(5))};
  model.baseline_by_regime=baselineByRegime&&typeof baselineByRegime==='object'
    ?baselineByRegime:null;
  model.training_objective=trainingObjective;
  const trainableParameters=()=>({
    projectionWeights:model.projectionWeights,projectionBiases:model.projectionBiases,
    depthWeights:model.depthWeights,pointWeights:model.pointWeights,
    biases:model.biases,outputWeights:model.outputWeights
  });
  let optimizer = { m: zerosLike(trainableParameters()), v: zerosLike(trainableParameters()) };
  const rowGradientScratch=zeroTrainableGradients(model);
  for (let epoch = 1; epoch <= epochs; epoch++) {
    const gradient = zerosLike(trainableParameters());
    for (const row of rows) {
      const cache = forward(row.sequence, model, 1, row._pooled_baseline_features);
      const itemGradient = gradientsFor(row.sequence, row.target, model, cache,trainingObjective,rowGradientScratch);
      const sampleWeight=row.target>0.5?positiveSampleWeight:1;
      for (const key of ['projectionWeights','projectionBiases','depthWeights','pointWeights','biases','outputWeights']) {
        addScaledTreeInPlace(gradient[key], itemGradient[key], sampleWeight);
      }
    }
    const averaged = scaleTree(gradient, 1 / Math.max(1, totalSampleWeight));
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
  if(!validSequence(sequence)||!fitted)return null;
  const regime=regimeOfSequence(sequence);
  const specialist=fitted.specialists_by_regime?.[regime];
  const selectedIndex=Number(specialist?.selected_member_index);
  if(!specialist||!Number.isInteger(selectedIndex)||selectedIndex<0||
     selectedIndex>=specialist.members?.length)return null;
  const residualScale=Number(specialist.selected_residual_scale);
  if(!Number.isFinite(residualScale)||residualScale<0)return null;
  // Keep zero-residual output for diagnostic comparison only. The regime's
  // neuralResidualContributes gate prevents it from being selected or published.
  const rawProbability=forward(sequence,specialist.members[selectedIndex],residualScale).probability;
  return calibratedProbability(rawProbability,specialist.probability_calibrator);
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

// A second challenger for the *same* early first-passage target as the TCN.
// It uses pooled causal sequence summaries (24-step means + recent 8-step means)
// and a frozen regime-local logistic anchor. Depth/leaf/round budgets are small
// for the limited per-regime sample counts; selection happens only on the
// disjoint regime member-selection block and calibration on the later block.
function temporalTreeLinearLogit(vector,fit){
  let value=Number(fit?.bias)||0;
  for(let index=0;index<vector.length;index++){
    value+=vector[index]*(Number(fit?.weights?.[index])||0);
  }
  return clamp(value,-12,12);
}

function temporalTreeNodeValue(node,vector){
  if(!node||typeof node!=='object')return 0;
  if(node.type==='leaf')return Number(node.value)||0;
  const feature=Number(node.feature);
  return vector[feature]<=Number(node.threshold)
    ?temporalTreeNodeValue(node.left,vector)
    :temporalTreeNodeValue(node.right,vector);
}

function bestTemporalTreeSplit(indices,rows,gradients,hessians,{
  minimumLeaf=12,l2=8,minGain=0.002
}={}){
  let totalGradient=0,totalHessian=0;
  for(const index of indices){
    totalGradient+=gradients[index];
    totalHessian+=hessians[index];
  }
  let best=null;
  const features=rows[0]?.vector?.length||0;
  for(let feature=0;feature<features;feature++){
    const ordered=indices.map(index=>({index,value:rows[index].vector[feature]}))
      .sort((a,b)=>a.value-b.value||a.index-b.index);
    let leftGradient=0,leftHessian=0;
    for(let offset=0;offset<ordered.length-1;offset++){
      const current=ordered[offset];
      leftGradient+=gradients[current.index];
      leftHessian+=hessians[current.index];
      const leftCount=offset+1,rightCount=ordered.length-leftCount;
      if(leftCount<minimumLeaf||rightCount<minimumLeaf)continue;
      const nextValue=ordered[offset+1].value;
      if(!(current.value<nextValue))continue;
      const rightGradient=totalGradient-leftGradient;
      const rightHessian=totalHessian-leftHessian;
      const gain=0.5*(
        leftGradient*leftGradient/(leftHessian+l2)+
        rightGradient*rightGradient/(rightHessian+l2)-
        totalGradient*totalGradient/(totalHessian+l2)
      );
      if(gain>minGain&&(!best||gain>best.gain)){
        best={feature,threshold:current.value+(nextValue-current.value)/2,gain};
      }
    }
  }
  return best;
}

function buildTemporalTreeNode(indices,depth,rows,gradients,hessians,options){
  let gradient=0,hessian=0;
  for(const index of indices){gradient+=gradients[index];hessian+=hessians[index];}
  const leafValue=clamp(-gradient/(hessian+options.l2),-0.55,0.55);
  if(depth>=options.maxDepth||indices.length<options.minimumLeaf*2){
    return {type:'leaf',value:leafValue};
  }
  const split=bestTemporalTreeSplit(indices,rows,gradients,hessians,options);
  if(!split)return {type:'leaf',value:leafValue};
  const left=[],right=[];
  for(const index of indices){
    (rows[index].vector[split.feature]<=split.threshold?left:right).push(index);
  }
  if(left.length<options.minimumLeaf||right.length<options.minimumLeaf){
    return {type:'leaf',value:leafValue};
  }
  return {
    type:'split',feature:split.feature,threshold:split.threshold,gain:split.gain,
    left:buildTemporalTreeNode(left,depth+1,rows,gradients,hessians,options),
    right:buildTemporalTreeNode(right,depth+1,rows,gradients,hessians,options)
  };
}

function accumulateTemporalTreeImportance(node,gains,counts){
  if(!node||typeof node!=='object'||node.type!=='split')return;
  const feature=Number(node.feature);
  if(Number.isInteger(feature)&&feature>=0&&feature<gains.length){
    gains[feature]+=Math.max(0,Number(node.gain)||0);
    counts[feature]++;
  }
  accumulateTemporalTreeImportance(node.left,gains,counts);
  accumulateTemporalTreeImportance(node.right,gains,counts);
}

function fitTemporalResidualTrees(training,baselineFit,{
  maxTrees=24,maxDepth=2,learningRate=0.04,l2=10,minimumLeafFraction=0.05
}={}){
  const rows=(Array.isArray(training)?training:[]).map(row=>({
    vector:pooledSequence(row.sequence),target:Number(row.target)
  })).filter(row=>row.vector.length===TEMPORAL_SEQUENCE_CHANNELS*2&&
    row.vector.every(Number.isFinite)&&(row.target===0||row.target===1));
  if(rows.length<160||!baselineFit||!Array.isArray(baselineFit.weights)||
     baselineFit.weights.length!==TEMPORAL_SEQUENCE_CHANNELS*2||
     !Number.isFinite(Number(baselineFit.bias)))return null;
  const options={
    maxDepth:Math.max(1,Math.min(2,Math.trunc(Number(maxDepth)||2))),
    minimumLeaf:Math.max(12,Math.min(60,Math.floor(rows.length*minimumLeafFraction))),
    l2:clamp(Number(l2)||10,3,30),minGain:0.002
  };
  const rate=clamp(Number(learningRate)||0.04,0.01,0.08);
  const logits=rows.map(row=>temporalTreeLinearLogit(row.vector,baselineFit));
  const trees=[];
  const featureGains=Array(TEMPORAL_SEQUENCE_CHANNELS*2).fill(0);
  const featureSplitCounts=Array(TEMPORAL_SEQUENCE_CHANNELS*2).fill(0);
  const rounds=Math.max(8,Math.min(32,Math.trunc(Number(maxTrees)||24)));
  for(let round=0;round<rounds;round++){
    const gradients=new Array(rows.length),hessians=new Array(rows.length);
    for(let index=0;index<rows.length;index++){
      const probability=logistic(logits[index]);
      gradients[index]=probability-rows[index].target;
      hessians[index]=Math.max(0.025,probability*(1-probability));
    }
    const root=buildTemporalTreeNode(rows.map((_,index)=>index),0,rows,gradients,hessians,options);
    if(root.type==='leaf')break;
    for(let index=0;index<rows.length;index++){
      logits[index]=clamp(logits[index]+rate*temporalTreeNodeValue(root,rows[index].vector),-12,12);
    }
    trees.push({root});
    accumulateTemporalTreeImportance(root,featureGains,featureSplitCounts);
  }
  if(!trees.length)return null;
  const totalGain=featureGains.reduce((sum,value)=>sum+value,0);
  const featureImportance=featureGains.map((gain,index)=>({
    feature:index<TEMPORAL_SEQUENCE_CHANNELS
      ?'sequence_mean_'+index
      :'recent_8_mean_'+(index-TEMPORAL_SEQUENCE_CHANNELS),
    gain:Number(gain.toFixed(7)),
    gain_share_pct:totalGain>0?Number((gain/totalGain*100).toFixed(2)):0,
    split_count:featureSplitCounts[index]
  })).filter(row=>row.split_count>0).sort((a,b)=>b.gain-a.gain||a.feature.localeCompare(b.feature));
  return {
    kind:'TEMPORAL_FIRST_PASSAGE_RESIDUAL_GBDT_V1',
    architecture:'TEMPORAL_POOLED_58_NEWTON_GBDT_DEPTH2_24_ROUNDS',
    baseline_fit:baselineFit,trees,tree_count:trees.length,
    learning_rate:rate,max_depth:options.maxDepth,
    minimum_leaf_samples:options.minimumLeaf,l2:options.l2,
    training_samples:rows.length,feature_importance:featureImportance,
    feature_importance_total_gain:Number(totalGain.toFixed(7))
  };
}

function predictTemporalResidualTrees(sequence,fit,residualScale=1,treeCount=null){
  if(!fit||fit.kind!=='TEMPORAL_FIRST_PASSAGE_RESIDUAL_GBDT_V1'||
     !Array.isArray(fit.trees)||!fit.trees.length)return null;
  const vector=pooledSequence(sequence);
  let value=temporalTreeLinearLogit(vector,fit.baseline_fit);
  const count=Math.max(1,Math.min(fit.trees.length,
    Math.trunc(Number(treeCount)||fit.trees.length)));
  for(let index=0;index<count;index++){
    value+=Number(fit.learning_rate)*clamp(Number(residualScale)||0,0,1)*
      temporalTreeNodeValue(fit.trees[index].root,vector);
  }
  return logistic(clamp(value,-12,12));
}

function evaluate(rows, predictFn, baseRate) {
  if (!rows.length) return {
    evaluated:false,sample_count:0,positive_count:0,negative_count:0,positive_rate_pct:null,
    model_brier_score:null,base_rate_brier_score:null,beat_base_rate:false,
    required_brier_margin:TEMPORAL_BRIER_SUPERIORITY_MARGIN
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
    required_brier_margin:TEMPORAL_BRIER_SUPERIORITY_MARGIN,
    reason:'NON_FINITE_TEMPORAL_PREDICTION'
  };
  const modelBrier = mean(predictions.map((value, index) => (value - targets[index]) ** 2));
  const baseBrier = mean(targets.map(target => (baseRate - target) ** 2));
  const logLoss = mean(predictions.map((value, index) => {
    const probability = clamp(value, 0.001, 0.999);
    return -(targets[index] * Math.log(probability) + (1 - targets[index]) * Math.log(1 - probability));
  }));
  // Reuse the already-computed predictions: inference must be deterministic
  // and each holdout row should be evaluated exactly once per metric pass.
  const directional = rows.map((row,index)=>({row,index}))
    .filter(item=>item.row.outcome !== 'FLAT');
  const correct = directional.filter(({row,index}) =>
    ((predictions[index] >= 0.5) === (row.outcome === 'UP'))).length;
  return {
    evaluated:true,sample_count:rows.length,
    positive_count:positiveCount,negative_count:negativeCount,positive_rate_pct:positiveRatePct,
    model_brier_score:Number(modelBrier.toFixed(5)),
    base_rate_brier_score: Number(baseBrier.toFixed(5)),
    log_loss: Number(logLoss.toFixed(5)),
    directional_accuracy_pct: directional.length ? Number((correct / directional.length * 100).toFixed(1)) : null,
    beat_base_rate: hasTemporalBrierSuperiority(modelBrier,baseBrier),
    required_brier_margin:TEMPORAL_BRIER_SUPERIORITY_MARGIN,
    improvement_vs_base_rate: Number((baseBrier - modelBrier).toFixed(5))
  };
}

function aggregateEvaluations(entries){
  const valid=(Array.isArray(entries)?entries:[]).filter(row=>row?.evaluated===true&&
    Number(row.sample_count)>0&&Number.isFinite(Number(row.model_brier_score))&&
    Number.isFinite(Number(row.base_rate_brier_score)));
  const count=valid.reduce((sum,row)=>sum+Number(row.sample_count),0);
  if(!count)return {evaluated:false,sample_count:0,positive_count:0,negative_count:0,
    positive_rate_pct:null,model_brier_score:null,base_rate_brier_score:null,beat_base_rate:false,
    required_brier_margin:TEMPORAL_BRIER_SUPERIORITY_MARGIN};
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
    beat_base_rate:hasTemporalBrierSuperiority(model,base),
    required_brier_margin:TEMPORAL_BRIER_SUPERIORITY_MARGIN,
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
  const temporalPoolingMode=String(options.temporalPoolingMode||'LAST_12_MEAN_V1');
  const outputFeatureCount=temporalPoolingMode===TEMPORAL_ORDERED_POOLING_MODE
    ?TEMPORAL_ORDERED_POOLING_FEATURE_COUNT:TEMPORAL_LATENT_CHANNELS;
  const trainableParameterCount=TEMPORAL_TRAINABLE_PARAMETER_COUNT-
    TEMPORAL_LATENT_CHANNELS+outputFeatureCount;
  const architecture=temporalPoolingMode===TEMPORAL_ORDERED_POOLING_MODE
    ?TEMPORAL_ORDERED_POOLING_MODEL_ARCHITECTURE:TEMPORAL_MODEL_ARCHITECTURE;
  const memberProfiles=[
    {epochs:Math.max(1,Math.ceil(baseEpochs*0.75)),learningRate:baseLearningRate*0.9,l2:baseL2*1.5,
      trainingObjective:'UNWEIGHTED_BRIER_PROPER_SCORING_RULE',
      latentChannels:TEMPORAL_LATENT_CHANNELS,trainableParameters:trainableParameterCount,temporalPoolingMode},
    {epochs:baseEpochs,learningRate:baseLearningRate,l2:baseL2,
      trainingObjective:'UNWEIGHTED_LOG_LOSS_PROPER_SCORING_RULE',
      latentChannels:TEMPORAL_LATENT_CHANNELS,trainableParameters:trainableParameterCount,temporalPoolingMode},
    {epochs:Math.max(1,Math.ceil(baseEpochs*1.5)),learningRate:baseLearningRate*0.75,l2:baseL2*2,
      trainingObjective:'MIXED_BRIER_LOG_LOSS_50_50_PROPER_SCORING_RULE',
      positiveClassWeighting:'SQRT_INVERSE_PREVALENCE',
      latentChannels:TEMPORAL_LATENT_CHANNELS,trainableParameters:trainableParameterCount,temporalPoolingMode}
  ];
  // These features depend only on the immutable 24x29 input, not on model
  // weights. Prepare them once and reuse across all epochs and ensemble members.
  const preparedRows=rows.map(row=>({...row,
    _pooled_baseline_features:pooledSequence(row.sequence)
  }));
  const members=SEEDS.map((seed,index)=>fitMember(preparedRows,seed,{
    ...options,...memberProfiles[index],baseRate
  }));
  return {
    members,seeds:[...SEEDS],
    architecture,
    temporal_pooling:temporalPoolingMode,
    output_features:outputFeatureCount,
    trainable_parameter_count:trainableParameterCount,
    training_strategy:temporalPoolingMode===TEMPORAL_ORDERED_POOLING_MODE
      ?'INDEPENDENT_TEMPORAL_TCN_REGIME_LOCAL_ORDERED_FOUR_SEGMENT_POOLING_V1'
      :'INDEPENDENT_TEMPORAL_TCN_REGIME_LOCAL_SELECTION_CALIBRATION_V22_TRAIN_ONLY_CLASS_BALANCE',
    baseline_anchor:'REGIME_SPECIFIC_TRAINING_ONLY_NO_CROSS_REGIME_FALLBACK_V3',
    member_training_profiles:memberProfiles,
    residual_scale_selection:'REGIME_LOCAL_SELECTION_BLOCK_BRIER_GRID_V4',
    training_objective:'DIVERSE_PROPER_SCORING_RULE_TCN_ENSEMBLE_WITH_TRAIN_ONLY_CLASS_BALANCE_V1',
    candidate_residual_scales:[...RESIDUAL_SCALES],
    training_prior_probability:baseRate
  };
}

/**
 * Independent BTC-regime TCN challenger.
 *
 * Unlike the pooled TCN control above, this model fits one ensemble and one
 * logistic anchor per regime. Training, member selection, calibration,
 * validation and holdout are all regime-local and chronologically disjoint.
 * The training window is capped to its newest 4,096 eligible rows to limit
 * regime drift; its logistic comparator is fitted on exactly the same rows.
 * This remains research-only and never relaxes the 0.003 Brier gates.
 */
function fitRegimeLocalTemporalTcn({
  regime,trainingRows=[],memberSelectionRows=[],calibrationRows=[],
  validationRows=[],holdoutRows=[],epochs=6,learningRate=0.006,l2=0.012,
  comparisonMargin=TEMPORAL_BRIER_SUPERIORITY_MARGIN,
  maxTrainingSamples=TEMPORAL_REGIME_LOCAL_MAX_TRAINING_SAMPLES,
  temporalPoolingMode='LAST_12_MEAN_V1',
  minTrainingSamples=80,minTrainingPositive=8,minTrainingNegative=20,
  minSelectionSamples=10,minSelectionPositive=3,minSelectionNegative=8,
  minCalibrationSamples=30,minCalibrationPositive=5,minCalibrationNegative=20,
  minValidationSamples=12,minValidationPositive=5,minValidationNegative=20,
  minHoldoutSamples=20,minHoldoutPositive=5,minHoldoutNegative=20
}={}){
  const sortRows=rows=>(Array.isArray(rows)?rows:[])
    .filter(row=>regimeOfSequence(row?.sequence)===regime)
    .sort((a,b)=>a.at-b.at||String(a.symbol||'').localeCompare(String(b.symbol||'')));
  const allTraining=sortRows(trainingRows),selection=sortRows(memberSelectionRows);
  const calibration=sortRows(calibrationRows),validation=sortRows(validationRows);
  const holdout=sortRows(holdoutRows);
  const limit=Math.max(minTrainingSamples,Math.min(TEMPORAL_REGIME_LOCAL_MAX_TRAINING_SAMPLES,
    Math.trunc(Number(maxTrainingSamples)||TEMPORAL_REGIME_LOCAL_MAX_TRAINING_SAMPLES)));
  const training=allTraining.slice(-limit);
  const counts=rows=>({
    samples:rows.length,
    positive:rows.filter(row=>row.target===1).length,
    negative:rows.filter(row=>row.target===0).length
  });
  const trainCounts=counts(training),selectionCounts=counts(selection),
    calibrationCounts=counts(calibration),validationCounts=counts(validation),
    holdoutCounts=counts(holdout);
  const supportGaps=[];
  if(training.length<minTrainingSamples)supportGaps.push('REGIME_LOCAL_TRAINING_SAMPLE_COUNT');
  if(trainCounts.positive<minTrainingPositive)supportGaps.push('REGIME_LOCAL_TRAINING_POSITIVE_CLASS');
  if(trainCounts.negative<minTrainingNegative)supportGaps.push('REGIME_LOCAL_TRAINING_NEGATIVE_CLASS');
  if(selectionCounts.samples<minSelectionSamples)supportGaps.push('REGIME_LOCAL_SELECTION_SAMPLE_COUNT');
  if(selectionCounts.positive<minSelectionPositive)supportGaps.push('REGIME_LOCAL_SELECTION_POSITIVE_CLASS');
  if(selectionCounts.negative<minSelectionNegative)supportGaps.push('REGIME_LOCAL_SELECTION_NEGATIVE_CLASS');
  if(calibrationCounts.samples<minCalibrationSamples)supportGaps.push('REGIME_LOCAL_CALIBRATION_SAMPLE_COUNT');
  if(calibrationCounts.positive<minCalibrationPositive)supportGaps.push('REGIME_LOCAL_CALIBRATION_POSITIVE_CLASS');
  if(calibrationCounts.negative<minCalibrationNegative)supportGaps.push('REGIME_LOCAL_CALIBRATION_NEGATIVE_CLASS');
  if(validationCounts.samples<minValidationSamples)supportGaps.push('REGIME_LOCAL_VALIDATION_SAMPLE_COUNT');
  if(validationCounts.positive<minValidationPositive)supportGaps.push('REGIME_LOCAL_VALIDATION_POSITIVE_CLASS');
  if(validationCounts.negative<minValidationNegative)supportGaps.push('REGIME_LOCAL_VALIDATION_NEGATIVE_CLASS');
  if(holdoutCounts.samples<minHoldoutSamples)supportGaps.push('REGIME_LOCAL_HOLDOUT_SAMPLE_COUNT');
  if(holdoutCounts.positive<minHoldoutPositive)supportGaps.push('REGIME_LOCAL_HOLDOUT_POSITIVE_CLASS');
  if(holdoutCounts.negative<minHoldoutNegative)supportGaps.push('REGIME_LOCAL_HOLDOUT_NEGATIVE_CLASS');

  const latestResolved=rows=>rows.length?Math.max(...rows.map(row=>Number(row.resolved_at))):null;
  const firstAt=rows=>rows[0]?.at??null;
  const trainingResolved=latestResolved(training),selectionResolved=latestResolved(selection),
    calibrationResolved=latestResolved(calibration);
  const chronologyValid=training.length>0&&selection.length>0&&calibration.length>0&&
    validation.length>0&&holdout.length>0&&
    trainingResolved<firstAt(selection)&&
    selectionResolved<firstAt(calibration)&&
    calibrationResolved<firstAt(validation)&&
    latestResolved(validation)<firstAt(holdout);
  if(!chronologyValid)supportGaps.push('REGIME_LOCAL_CHRONOLOGY_OR_PURGE_VIOLATION');
  const base={
    regime,status:supportGaps.length?'WAITING_FOR_REGIME_LOCAL_TCN_SUPPORT':'READY_FOR_REGIME_LOCAL_TCN_FIT',
    model_kind:temporalPoolingMode===TEMPORAL_ORDERED_POOLING_MODE
      ?'INDEPENDENT_REGIME_LOCAL_TCN_ORDERED_PYRAMID_V1':'INDEPENDENT_REGIME_LOCAL_TCN_V1',
    model_scope:'INDEPENDENT_BTC_REGIME_TCN_WITH_REGIME_LOCAL_LOGISTIC_ANCHOR',
    temporal_pooling:temporalPoolingMode,
    training_strategy:temporalPoolingMode===TEMPORAL_ORDERED_POOLING_MODE
      ?'INDEPENDENT_BTC_REGIME_TCN_ORDERED_FOUR_SEGMENT_POOLING_V1'
      :TEMPORAL_REGIME_LOCAL_TRAINING_STRATEGY,
    training_window_policy:'LATEST_ELIGIBLE_ROWS_WITHIN_FIXED_TRAINING_BLOCK',
    training_sample_budget:limit,
    training_samples:training.length,available_training_samples:allTraining.length,
    selection_samples:selection.length,calibration_samples:calibration.length,
    validation_samples:validation.length,holdout_samples:holdout.length,
    training_targets:trainCounts,selection_targets:selectionCounts,
    calibration_targets:calibrationCounts,validation_targets:validationCounts,
    holdout_targets:holdoutCounts,
    training_start_at:firstAt(training),training_end_at:training.at(-1)?.at??null,
    selection_start_at:firstAt(selection),calibration_start_at:firstAt(calibration),
    validation_start_at:firstAt(validation),holdout_start_at:firstAt(holdout),
    max_training_outcome_resolved_at:trainingResolved,
    max_selection_outcome_resolved_at:selectionResolved,
    max_calibration_outcome_resolved_at:calibrationResolved,
    chronology_valid:chronologyValid,
    training_sample_fingerprint:sampleIdentityFingerprint(training),
    selection_sample_fingerprint:sampleIdentityFingerprint(selection),
    calibration_sample_fingerprint:sampleIdentityFingerprint(calibration),
    support_gaps:supportGaps,
    trained:false,selected_for_research:false,validation_passed:false,holdout_passed:false,
    probability_ready:false,live_eligibility_ready:false,
    validation:{evaluated:false,sample_count:validation.length,reason:'REGIME_LOCAL_TCN_NOT_SELECTED'},
    validation_logistic:{evaluated:false,sample_count:validation.length},
    holdout:{evaluated:false,sample_count:holdout.length,reason:'REGIME_LOCAL_TCN_DID_NOT_PASS_VALIDATION'},
    holdout_logistic:{evaluated:false,sample_count:holdout.length},
    selected_member_index:null,selected_residual_scale:null,
    diagnostic_member_index:null,diagnostic_residual_scale:null,
    member_selection_scores:[]
  };
  if(supportGaps.length)return base;

  const targets=training.map(row=>row.target);
  const baseRate=(targets.reduce((sum,value)=>sum+value,0)+2)/(targets.length+4);
  const baseline=fitLogistic(training);
  const fitted=fitEnsemble(training,{
    epochs:Math.max(1,Math.min(8,Math.trunc(Number(epochs)||6))),
    learningRate,l2,baseRate,baselineFit:baseline,temporalPoolingMode
  });
  const selectionLogistic=evaluate(selection,
    sequence=>predictLogistic(sequence,baseline),baseRate);
  const candidates=fitted.members.flatMap((member,index)=>
    RESIDUAL_SCALES.map(residualScale=>({
      index,residual_scale:residualScale,
      metrics:evaluate(selection,
        sequence=>forward(sequence,member,residualScale).probability,baseRate)
    }))
  ).filter(row=>row.metrics.evaluated===true);
  const diagnostic=[...candidates].sort((a,b)=>
    a.metrics.model_brier_score-b.metrics.model_brier_score||
    a.index-b.index||a.residual_scale-b.residual_scale)[0]||null;
  const qualified=candidates.filter(row=>row.residual_scale>0&&
    row.metrics.beat_base_rate===true&&selectionLogistic.evaluated===true&&
    row.metrics.model_brier_score+comparisonMargin<selectionLogistic.model_brier_score)
    .sort((a,b)=>a.metrics.model_brier_score-b.metrics.model_brier_score||
      a.index-b.index||a.residual_scale-b.residual_scale);
  const selected=qualified[0]||null;
  const calibrationSupported=calibrationCounts.samples>=minCalibrationSamples&&
    calibrationCounts.positive>=minCalibrationPositive&&
    calibrationCounts.negative>=minCalibrationNegative;
  const calibrator=selected&&calibrationSupported
    ?fitSelectionProbabilityCalibrator(calibration,
      sequence=>forward(sequence,fitted.members[selected.index],selected.residual_scale).probability,
      {minimumSamples:minCalibrationSamples,minimumPositive:minCalibrationPositive,
       minimumNegative:minCalibrationNegative,iterations:300,learningRate:0.03,
       regularization:0.45,fitOn:'REGIME_LOCAL_TCN_CALIBRATION_BLOCK'})
    :{method:'CALIBRATION_BLOCK_SHRUNK_BRIER_PLATT_V2',
      fit_on:'REGIME_LOCAL_TCN_CALIBRATION_BLOCK',sample_count:0,
      positive_count:0,negative_count:0,slope:1,intercept:0,fitted:false,
      reason:selected?'REGIME_LOCAL_CALIBRATION_SUPPORT_BELOW_MINIMUM':
        'REGIME_LOCAL_TCN_DID_NOT_BEAT_SELECTION_LOGISTIC'};
  const logisticCalibrator=calibrationSupported
    ?fitSelectionProbabilityCalibrator(calibration,
      sequence=>predictLogistic(sequence,baseline),
      {minimumSamples:minCalibrationSamples,minimumPositive:minCalibrationPositive,
       minimumNegative:minCalibrationNegative,iterations:300,learningRate:0.03,
       regularization:0.45,fitOn:'REGIME_LOCAL_LOGISTIC_CALIBRATION_BLOCK'})
    :{method:'CALIBRATION_BLOCK_SHRUNK_BRIER_PLATT_V2',
      fit_on:'REGIME_LOCAL_LOGISTIC_CALIBRATION_BLOCK',sample_count:0,
      positive_count:0,negative_count:0,slope:1,intercept:0,fitted:false,
      reason:'REGIME_LOCAL_CALIBRATION_SUPPORT_BELOW_MINIMUM'};
  const predictCandidate=selected&&calibrator.fitted
    ?sequence=>calibratedProbability(
      forward(sequence,fitted.members[selected.index],selected.residual_scale).probability,calibrator)
    :()=>null;
  const predictBaseline=logisticCalibrator.fitted
    ?sequence=>calibratedProbability(predictLogistic(sequence,baseline),logisticCalibrator)
    :sequence=>predictLogistic(sequence,baseline);
  const validationModel=selected&&calibrator.fitted&&logisticCalibrator.fitted
    ?evaluate(validation,predictCandidate,baseRate)
    :{evaluated:false,sample_count:validation.length,model_brier_score:null,
      base_rate_brier_score:null,beat_base_rate:false,reason:'REGIME_LOCAL_TCN_SELECTION_OR_CALIBRATION_NOT_PASSED'};
  const validationLogistic=evaluate(validation,predictBaseline,baseRate);
  const validationPassed=Boolean(selected&&calibrator.fitted&&logisticCalibrator.fitted&&
    validationModel.evaluated&&validationLogistic.evaluated&&
    validationModel.beat_base_rate===true&&
    validationModel.model_brier_score+comparisonMargin<validationLogistic.model_brier_score);
  const holdoutModel=validationPassed
    ?evaluate(holdout,predictCandidate,baseRate)
    :{evaluated:false,sample_count:holdout.length,model_brier_score:null,
      base_rate_brier_score:null,beat_base_rate:false,
      reason:'REGIME_LOCAL_TCN_DID_NOT_PASS_CHRONOLOGICAL_VALIDATION'};
  const holdoutLogistic=validationPassed
    ?evaluate(holdout,predictBaseline,baseRate)
    :{evaluated:false,sample_count:holdout.length,model_brier_score:null,
      base_rate_brier_score:null,beat_base_rate:false,
      reason:'REGIME_LOCAL_TCN_DID_NOT_PASS_CHRONOLOGICAL_VALIDATION'};
  const holdoutPassed=Boolean(validationPassed&&holdoutModel.evaluated&&
    holdoutLogistic.evaluated&&holdoutModel.beat_base_rate===true&&
    holdoutModel.model_brier_score+comparisonMargin<holdoutLogistic.model_brier_score);
  return {
    ...base,
    status:!qualified.length?'REGIME_LOCAL_TCN_DID_NOT_BEAT_SELECTION_LOGISTIC':
      !calibrator.fitted?'REGIME_LOCAL_TCN_CALIBRATION_NOT_READY':
      !validationPassed?'REGIME_LOCAL_TCN_DID_NOT_PASS_VALIDATION':
      holdoutPassed?'REGIME_LOCAL_TCN_OUT_OF_SAMPLE_VALIDATED_RESEARCH_ONLY':
      'REGIME_LOCAL_TCN_VALIDATION_PASSED_HOLDOUT_NOT_PASSED',
    model_architecture:fitted.architecture,
    temporal_pooling:fitted.temporal_pooling,
    output_features:fitted.output_features,
    trainable_parameter_count:fitted.trainable_parameter_count,
    model_training_strategy:fitted.training_strategy,
    trained:true,selected_for_research:validationPassed,
    validation_passed:validationPassed,holdout_passed:holdoutPassed,
    selected_member_index:selected?.index??null,
    selected_residual_scale:selected?.residual_scale??null,
    diagnostic_member_index:diagnostic?.index??null,
    diagnostic_residual_scale:diagnostic?.residual_scale??0,
    neural_residual_contributes:Boolean(selected&&selected.residual_scale>0),
    ensemble_members:fitted.members.length,
    member_training_profiles:fitted.member_training_profiles,
    baseline_anchor_source:'REGIME_LOCAL_TRAINING_ONLY',
    baseline_anchor_training_samples:training.length,
    baseline_anchor_fingerprint:sampleIdentityFingerprint(training),
    member_selection_logistic_brier:selectionLogistic.model_brier_score??null,
    selection_best_candidate:diagnostic?{
      member_index:diagnostic.index,residual_scale:diagnostic.residual_scale,
      brier_score:diagnostic.metrics.model_brier_score,
      base_rate_brier_score:diagnostic.metrics.base_rate_brier_score
    }:null,
    member_selection_scores:candidates.map(row=>({
      index:row.index,residual_scale:row.residual_scale,
      brier_score:row.metrics.model_brier_score,
      base_rate_brier_score:row.metrics.base_rate_brier_score,
      beat_base_rate:row.metrics.beat_base_rate,
      same_window_logistic_brier_score:selectionLogistic.model_brier_score??null,
      beats_same_window_logistic:selectionLogistic.evaluated===true&&
        row.metrics.model_brier_score+comparisonMargin<selectionLogistic.model_brier_score,
      selected:Boolean(selected&&row.index===selected.index&&row.residual_scale===selected.residual_scale)
    })),
    selection_passed:Boolean(selected),
    probability_calibration:calibrator,
    logistic_probability_calibration:logisticCalibrator,
    validation:validationModel,validation_logistic:validationLogistic,
    holdout:holdoutModel,holdout_logistic:holdoutLogistic,
    holdout_comparison:{
      required_brier_margin:comparisonMargin,
      model_brier_score:holdoutModel.model_brier_score??null,
      logistic_brier_score:holdoutLogistic.model_brier_score??null,
      beats_base_rate:holdoutModel.beat_base_rate===true,
      beats_logistic:holdoutModel.evaluated===true&&holdoutLogistic.evaluated===true&&
        holdoutModel.model_brier_score+comparisonMargin<holdoutLogistic.model_brier_score,
      passed:holdoutPassed
    }
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
  learningRate=0.006,l2=0.012,comparisonMargin=0.003,
  targetDefinition=TEMPORAL_TARGET_DEFINITION,
  outcomeHorizonMs=HORIZON_MS,
  allowedOutcomeSources=null,
  enableRegimeLocalTcn=false,
  regimeLocalTcnMaxTrainingSamples=TEMPORAL_REGIME_LOCAL_MAX_TRAINING_SAMPLES,
  regimeLocalTcnEpochs=6,
  enableRegimeLocalTcnPyramid=false,
  regimeLocalTcnPyramidMaxTrainingSamples=TEMPORAL_REGIME_LOCAL_MAX_TRAINING_SAMPLES,
  regimeLocalTcnPyramidEpochs=6
}={}){
  const horizonMs=Math.max(1,Math.trunc(Number(outcomeHorizonMs)||HORIZON_MS));
  const rows=cleanRows(samples,{targetDefinition,outcomeHorizonMs:horizonMs,allowedOutcomeSources});
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
    model_scope:'INDEPENDENT_TCN_WITH_REGIME_LOCAL_LOGISTIC_ANCHOR',
    training_samples:0,validation_samples:0,holdout_samples:0,
    required_training_samples:minRegimeTraining,
    required_validation_samples:minRegimeValidation,
    required_holdout_samples:minRegimeHoldout,
    selected:false,probability_ready:false,live_eligibility_ready:false
  }]));
  const architecture=TEMPORAL_MODEL_ARCHITECTURE;
  const countTrailingGroups=(endExclusive,targetRows,minSpanMs=horizonMs+1)=>{
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
    validationTargetSamples,2*horizonMs+1);
  const trainingEndIndex=uniqueTimes.length-holdoutCount-validationCount;
  const enoughSplit=trainingEndIndex>0;
  if(!enoughSplit)return{
    status:'WAITING_FOR_TEMPORAL_FIRST_PASSAGE_SAMPLES',
    architecture,target_definition:targetDefinition,temporal_label_resolution:'15M_ONLY',
    sequence_steps:TEMPORAL_SEQUENCE_STEPS,sequence_channels:TEMPORAL_SEQUENCE_CHANNELS,
    ensemble_members:0,ensemble_members_required:SEEDS.length,
    regime_specialist_count:2,
    regime_selection_mode:'INDEPENDENT_REGIME_LOCAL_TCN_OUT_OF_SAMPLE_GATES_V21',
    model_scope:'INDEPENDENT_TCN_RESIDUAL_WITH_REGIME_LOCAL_LOGISTIC_ANCHORS',
    resolved_samples:rows.length,training_samples:0,validation_samples:0,holdout_samples:0,
    required_training_samples:minTrainingSamples,
    required_validation_samples:minimumValidationSamples,
    required_holdout_samples:minimumHoldoutSamples,
    probability_ready:false,live_eligibility_ready:false,
    validation_start_at:null,holdout_start_at:null,
    outer_validation_start_at:null,outer_holdout_start_at:null,
    outer_training_samples:0,outer_validation_samples:0,outer_holdout_samples:0,
    outer_sample_fingerprint:sampleIdentityFingerprint(rows),
    max_training_outcome_resolved_at:null,
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
      architecture,target_definition:targetDefinition,
      temporal_label_resolution:'15M_ONLY',
      sequence_steps:TEMPORAL_SEQUENCE_STEPS,sequence_channels:TEMPORAL_SEQUENCE_CHANNELS,
      ensemble_members:0,ensemble_members_required:SEEDS.length,
      regime_specialist_count:2,
      regime_selection_mode:'INDEPENDENT_REGIME_LOCAL_TCN_OUT_OF_SAMPLE_GATES_V21',
      model_scope:'INDEPENDENT_TCN_RESIDUAL_WITH_REGIME_LOCAL_LOGISTIC_ANCHORS',
      resolved_samples:rows.length,training_samples:training.length,
      validation_samples:validation.length,holdout_samples:holdout.length,
      required_training_samples:minTrainingSamples,
      required_validation_samples:minimumValidationSamples,
      required_holdout_samples:minimumHoldoutSamples,
      probability_ready:false,live_eligibility_ready:false,
      validation_start_at:validationStart,holdout_start_at:holdoutStart,
      outer_validation_start_at:validationStart,outer_holdout_start_at:holdoutStart,
      outer_training_samples:training.length,outer_validation_samples:validation.length,
      outer_holdout_samples:holdout.length,
      outer_sample_fingerprint:sampleIdentityFingerprint(rows),
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

  // The TCN itself is one shared pooled model. Regime-local chronological
  // partitions below support local training-only anchors and regime diagnostics;
  // they do not create separate TCN ensembles or per-regime TCN member weights.
  // The TCN uses shared training, selection and calibration cutoffs, followed
  // by independent outer validation and untouched holdout gates per regime.
  const fitRows=training.slice(-Math.max(minTrainingSamples,maxTrainingSamples));
  const fitTimes=[...new Set(fitRows.map(row=>row.at))].sort((a,b)=>a-b);
  // Allocate more of a small/medium fitted history to model estimation while
  // retaining distinct later blocks for member selection and calibration.
  // Large histories have enough observations to reserve wider selection and
  // calibration windows. Outer validation and final holdout remain untouched.
  const splitFractions=fitTimes.length<16
    ?{training:0.50,memberSelection:0.76,calibration:0.98}
    :rows.length<1200
      ?{training:0.55,memberSelection:0.72,calibration:0.995}
      // Mature histories use 60% for fitting, 16% for member selection,
      // and 23.5% for regime-local calibration before purging. This widens the
      // sparse risk-on calibration block while preserving its own member-
      // selection set. Outer validation and final holdout remain untouched.
      :{training:0.60,memberSelection:0.76,calibration:0.995};
  const sharedTrainCutIndex=Math.max(1,Math.min(fitTimes.length-2,
    Math.floor(fitTimes.length*splitFractions.training)));
  const sharedMemberSelectionCutIndex=Math.max(sharedTrainCutIndex+1,
    Math.min(fitTimes.length-1,Math.floor(fitTimes.length*splitFractions.memberSelection)));
  const sharedSelectionCutIndex=Math.max(sharedMemberSelectionCutIndex+1,
    Math.min(fitTimes.length,Math.floor(fitTimes.length*splitFractions.calibration)));
  const sharedTrainingCutoffAt=fitTimes[sharedTrainCutIndex]??validationStart;
  const sharedMemberSelectionCutoffAt=fitTimes[sharedMemberSelectionCutIndex]??validationStart;
  const sharedSelectionCutoffAt=fitTimes[sharedSelectionCutIndex]??validationStart;
  const regimeSplits=Object.fromEntries(regimes.map(regime=>{
    const regimeRows=fitRows.filter(row=>regimeOfSequence(row.sequence)===regime)
      .sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol));
    const times=[...new Set(regimeRows.map(row=>row.at))].sort((a,b)=>a-b);
    if(times.length<4)return [regime,{rows:regimeRows,training:[],memberSelection:[],calibration:[],innerValidation:[],trainingCutoffAt:null,memberSelectionCutoffAt:null,calibrationCutoffAt:null}];
    // Use sample-count quantiles per regime, not fractions of timestamp groups.
    // Different BTC regimes can have very different symbol density at each time;
    // timestamp-only splits can leave the sparse regime with too few positive
    // calibration labels despite an apparently large chronological window.
    const sampleCountsByTime=new Map();
    for(const row of regimeRows)sampleCountsByTime.set(row.at,(sampleCountsByTime.get(row.at)||0)+1);
    const sampleQuantileIndex=(fraction,minIndex,maxIndex)=>{
      const target=Math.max(1,Math.ceil(regimeRows.length*fraction));
      let cumulative=0;
      for(let index=0;index<times.length;index++){
        cumulative+=sampleCountsByTime.get(times[index])||0;
        if(cumulative>=target)return Math.max(minIndex,Math.min(maxIndex,index+1));
      }
      return maxIndex;
    };
    const trainIndex=sampleQuantileIndex(splitFractions.training,1,times.length-2);
    const selectionIndex=sampleQuantileIndex(splitFractions.memberSelection,trainIndex+1,times.length-1);
    const calibrationIndex=sampleQuantileIndex(splitFractions.calibration,selectionIndex+1,times.length);
    const trainingCutoffAt=times[trainIndex];
    const memberSelectionCutoffAt=times[selectionIndex];
    const calibrationCutoffAt=times[calibrationIndex]??validationStart;
    return [regime,{
      rows:regimeRows,
      training:regimeRows.filter(row=>row.at<trainingCutoffAt&&row.resolved_at<trainingCutoffAt),
      memberSelection:regimeRows.filter(row=>row.at>=trainingCutoffAt&&row.at<memberSelectionCutoffAt&&row.resolved_at<memberSelectionCutoffAt),
      calibration:regimeRows.filter(row=>row.at>=memberSelectionCutoffAt&&row.at<calibrationCutoffAt&&row.resolved_at<calibrationCutoffAt),
      innerValidation:regimeRows.filter(row=>row.at>=calibrationCutoffAt&&row.resolved_at<validationStart),
      trainingCutoffAt,memberSelectionCutoffAt,calibrationCutoffAt
    }];
  }));
  const allRegimeTrainingRows=regimes.flatMap(regime=>regimeSplits[regime].training);
  const regimeTrainingMaxResolvedAt=allRegimeTrainingRows.length?Math.max(...allRegimeTrainingRows.map(row=>row.resolved_at)):null;
  const sharedTrainingRows=fitRows.filter(row=>
    row.at<sharedTrainingCutoffAt&&row.resolved_at<sharedTrainingCutoffAt)
    .sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol));
  const sharedTrainingMaxResolvedAt=sharedTrainingRows.length
    ?Math.max(...sharedTrainingRows.map(row=>row.resolved_at)):null;
  const regimeTrainingCounts=Object.fromEntries(regimes.map(regime=>[
    regime,regimeSplits[regime].training.length
  ]));
  const hasTrainableRegime=regimes.some(regime=>regimeTrainingCounts[regime]>=minRegimeTraining);
  // Independent specialists are gated by their own matured history, not by
  // the old pooled 160-row floor. A healthy 80+ sample regime must not be
  // discarded simply because the opposite regime is sparse or absent.
  if(fitTimes.length<4||!hasTrainableRegime){
    return{
      status:'WAITING_FOR_REGIME_SPECIALIST_SAMPLE_COVERAGE',
      architecture,target_definition:targetDefinition,
      temporal_label_resolution:'15M_ONLY',
      sequence_steps:TEMPORAL_SEQUENCE_STEPS,sequence_channels:TEMPORAL_SEQUENCE_CHANNELS,
      ensemble_members:0,ensemble_members_required:SEEDS.length,
      regime_specialist_count:2,
      regime_selection_mode:'INDEPENDENT_REGIME_LOCAL_TCN_OUT_OF_SAMPLE_GATES_V21',
      model_scope:'INDEPENDENT_TCN_RESIDUAL_WITH_REGIME_LOCAL_LOGISTIC_ANCHORS',
      resolved_samples:rows.length,training_samples:allRegimeTrainingRows.length,
      regime_model_training_samples:sharedTrainingRows.length,
      model_split_scope:'INDEPENDENT_BTC_REGIME_PURGED_WALK_FORWARD',
       regime_split_method:'REGIME_LOCAL_SAMPLE_COUNT_CHRONOLOGICAL_QUANTILES_V1',
      regime_local_split_boundaries:Object.fromEntries(regimes.map(regime=>[regime,{
        training_cutoff_at:regimeSplits[regime].trainingCutoffAt,
        member_selection_cutoff_at:regimeSplits[regime].memberSelectionCutoffAt,
        calibration_cutoff_at:regimeSplits[regime].calibrationCutoffAt
      }])),
      selection_samples:0,validation_samples:validation.length,holdout_samples:holdout.length,
      required_training_samples:minTrainingSamples,
      required_selection_samples:Math.max(10,Math.ceil(minimumValidationSamples*0.4)),
      required_validation_samples:minimumValidationSamples,
      required_holdout_samples:minimumHoldoutSamples,
      selection_start_at:sharedTrainingCutoffAt,
      member_selection_cutoff_at:sharedMemberSelectionCutoffAt,
      calibration_cutoff_at:sharedSelectionCutoffAt,
      validation_start_at:sharedSelectionCutoffAt,holdout_start_at:holdoutStart,
      max_training_outcome_resolved_at:regimeTrainingMaxResolvedAt,
      shared_model_training_cutoff_at:sharedTrainingCutoffAt,
      shared_model_selection_cutoff_at:sharedSelectionCutoffAt,
      regime_model_training_max_outcome_resolved_at:sharedTrainingMaxResolvedAt,
      probability_ready:false,live_eligibility_ready:false,
      trained:false,selected:false,supported_regimes:[],selected_regimes:[],
      regime_specialists:emptyCoverage,
      validation:{evaluated:false,reason:'REGIME_LOCAL_TCN_TRAINING_BLOCK_BELOW_MINIMUM'},
      holdout:{evaluated:false,reason:'REGIME_LOCAL_TCN_TRAINING_BLOCK_BELOW_MINIMUM'},
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
    const regimeTrainingRows=regimeSplits[regime].training;
    const localPositive=regimeTrainingRows.filter(row=>row.target===1).length;
    const localNegative=regimeTrainingRows.filter(row=>row.target===0).length;
    if(regimeTrainingRows.length<minRegimeTraining||localPositive<3||localNegative<20){
      return [regime,{weights:pooledBaseline.weights,bias:pooledBaseline.bias,base_rate:pooledBaseline.base_rate,
        training_samples:sharedTrainingRows.length,local_training_samples:regimeTrainingRows.length,
        local_positive_samples:localPositive,local_negative_samples:localNegative,
        source:'POOLED_TRAINING_ONLY_FALLBACK'}];
    }
    const baseline=fitLogistic(regimeTrainingRows);
    return [regime,{weights:baseline.weights,bias:baseline.bias,base_rate:baseline.base_rate,
      training_samples:regimeTrainingRows.length,local_training_samples:regimeTrainingRows.length,
      local_positive_samples:localPositive,local_negative_samples:localNegative,
      source:'REGIME_SPECIFIC_TRAINING_ONLY'}];
  }));
  const sharedTrainingTargets={
    samples:sharedTrainingRows.length,
    positive:sharedTrainingRows.filter(row=>row.target===1).length,
    negative:sharedTrainingRows.filter(row=>row.target===0).length
  };
  // The TCN residual ensemble uses the shared training rows and pooled
  // training-only logistic anchor. Local regime anchors above are retained for
  // separate regime-specific temporal boosted-tree diagnostics.
  const sharedCalibrationRows=fitRows.filter(row=>
    row.at>=sharedMemberSelectionCutoffAt&&row.at<sharedSelectionCutoffAt&&
    row.resolved_at<sharedSelectionCutoffAt)
    .sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol));
  // One shared TCN is fitted on the global purged training block. The later
  // selection and calibration blocks are shared too; validation and untouched
  // holdout metrics remain independently gated for each BTC regime.
  const fitted={
    specialists_by_regime:{},
    selected_member_by_regime:{},
    residual_scales_by_regime:{},
    probability_calibrators_by_regime:{},
    training_strategy:'SHARED_POOLED_TCN_TRAIN_ONLY_SELECTION_CALIBRATION_V1',
    model_scope:'SHARED_POOLED_TCN_WITH_PER_REGIME_OUTER_GATES_AND_POOLED_LOGISTIC_ANCHOR',
    baseline_anchor:'SHARED_POOLED_TRAINING_ONLY_LOGISTIC_FROZEN',
    training_objective:'DIVERSE_PROPER_SCORING_RULE_TCN_ENSEMBLE_WITH_TRAIN_ONLY_CLASS_BALANCE_V1',
    residual_scale_selection:'SHARED_POOLED_SELECTION_BLOCK_BRIER_GRID_V1',
    candidate_residual_scales:[...RESIDUAL_SCALES]
  };

  const regimeResults={};
  const regimeLocalTcnResults={};
  const regimeLocalTcnPyramidResults={};
  const temporalBoostedTreeResults={};
  const trainingByRegime={},selectionByRegime={},validationByRegime={},holdoutByRegime={};
  const trainingTargets={},selectionTargets={},validationTargets={},holdoutTargets={};
  const minRegimePositive=Math.max(5,Math.ceil(minimumValidationSamples*0.2));
  const minRegimeNegative=Math.max(20,Math.ceil(minimumValidationSamples*0.8));
  const minRegimeTrainingPositive=Math.max(8,Math.ceil(minRegimeTraining*0.05));
  const minSelectionSamples=Math.max(10,Math.ceil(minimumValidationSamples*0.4));
  const minSelectionPositive=3,minSelectionNegative=8;
  const calibrationSupport=rows=>({
    samples:rows.length,
    positive:rows.filter(row=>row.target===1).length,
    negative:rows.filter(row=>row.target===0).length
  });
  const pooledCalibrationDiagnostics=calibrationSupport(sharedCalibrationRows);
  const pooledMemberSelectionRows=fitRows.filter(row=>
    row.at>=sharedTrainingCutoffAt&&row.at<sharedMemberSelectionCutoffAt&&
    row.resolved_at<sharedMemberSelectionCutoffAt)
    .sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol));
  const pooledMemberSelectionDiagnostics=calibrationSupport(pooledMemberSelectionRows);
  const sharedSelectionTargets=pooledMemberSelectionDiagnostics;
  const sharedCalibrationTargets=pooledCalibrationDiagnostics;
  const sharedTcnTrainingSupported=sharedTrainingRows.length>=minTrainingSamples&&
    sharedTrainingTargets.positive>=minRegimeTrainingPositive&&
    sharedTrainingTargets.negative>=minRegimeNegative;
  const sharedTcnSelectionSupported=sharedSelectionTargets.samples>=minSelectionSamples&&
    sharedSelectionTargets.positive>=minSelectionPositive&&
    sharedSelectionTargets.negative>=minSelectionNegative;
  const sharedTcnCalibrationSupported=sharedCalibrationTargets.samples>=30&&
    sharedCalibrationTargets.positive>=5&&sharedCalibrationTargets.negative>=20;
  const sharedTcnFit=sharedTcnTrainingSupported?fitEnsemble(sharedTrainingRows,{
    epochs,learningRate,l2,baseRate,baselineFit:pooledBaseline
  }):null;
  const sharedSelectionLogistic=evaluate(pooledMemberSelectionRows,
    sequence=>predictLogistic(sequence,pooledBaseline),baseRate);
  const sharedTcnCandidates=sharedTcnFit?sharedTcnFit.members.flatMap((member,index)=>
    RESIDUAL_SCALES.map(residualScale=>({
      index,residual_scale:residualScale,
      metrics:evaluate(pooledMemberSelectionRows,
        sequence=>forward(sequence,member,residualScale).probability,baseRate)
    }))
  ).filter(row=>row.metrics.evaluated===true):[];
  const sharedTcnDiagnosticCandidate=[...sharedTcnCandidates].sort((a,b)=>
    a.metrics.model_brier_score-b.metrics.model_brier_score||
    a.index-b.index||a.residual_scale-b.residual_scale)[0]||null;
  const sharedTcnQualifiedCandidates=sharedTcnCandidates.filter(row=>
    row.residual_scale>0&&sharedTcnSelectionSupported&&
    sharedSelectionLogistic.evaluated===true&&
    row.metrics.beat_base_rate===true&&
    row.metrics.model_brier_score+comparisonMargin<sharedSelectionLogistic.model_brier_score)
    .sort((a,b)=>a.metrics.model_brier_score-b.metrics.model_brier_score||
      a.index-b.index||a.residual_scale-b.residual_scale);
  const sharedTcnSelectedCandidate=sharedTcnQualifiedCandidates[0]||null;
  const sharedTcnSelectionPassed=Boolean(sharedTcnSelectedCandidate);
  const sharedTcnDiagnosticIndex=sharedTcnDiagnosticCandidate?.index??-1;
  const sharedTcnDiagnosticScale=sharedTcnDiagnosticCandidate?.residual_scale??0;
  const sharedTcnSelectedIndex=sharedTcnSelectedCandidate?.index??-1;
  const sharedTcnSelectedScale=sharedTcnSelectedCandidate?.residual_scale??0;
  const sharedTcnCalibrationCandidate=sharedTcnSelectedCandidate||sharedTcnDiagnosticCandidate;
  const sharedTcnCalibrationIndex=sharedTcnCalibrationCandidate?.index??-1;
  const sharedTcnCalibrationScale=sharedTcnCalibrationCandidate?.residual_scale??0;
  const sharedTcnCalibrator=sharedTcnFit&&sharedTcnCalibrationCandidate&&sharedTcnCalibrationSupported
    ?fitSelectionProbabilityCalibrator(sharedCalibrationRows,
      sequence=>forward(sequence,sharedTcnFit.members[sharedTcnCalibrationIndex],
        sharedTcnCalibrationScale).probability,
      {minimumSamples:30,minimumPositive:5,minimumNegative:20,
       iterations:300,learningRate:0.03,regularization:0.45,
       fitOn:'SHARED_POOLED_CALIBRATION_BLOCK_TCN'})
    :{method:'CALIBRATION_BLOCK_SHRUNK_BRIER_PLATT_V2',
      fit_on:'SHARED_POOLED_CALIBRATION_BLOCK_TCN',
      sample_count:0,positive_count:0,negative_count:0,slope:1,intercept:0,fitted:false,
      reason:!sharedTcnFit?'SHARED_TCN_TRAINING_SUPPORT_BELOW_MINIMUM':
        !sharedTcnCalibrationCandidate?'NO_SHARED_TCN_SELECTION_CANDIDATE':
        'SHARED_TCN_CALIBRATION_CLASS_SUPPORT_BELOW_MINIMUM'};
  const sharedLogisticCalibrator=sharedTcnCalibrationSupported
    ?fitSelectionProbabilityCalibrator(sharedCalibrationRows,
      sequence=>predictLogistic(sequence,pooledBaseline),
      {minimumSamples:30,minimumPositive:5,minimumNegative:20,
       iterations:300,learningRate:0.03,regularization:0.45,
       fitOn:'SHARED_POOLED_CALIBRATION_BLOCK_LOGISTIC'})
    :{method:'CALIBRATION_BLOCK_SHRUNK_BRIER_PLATT_V2',
      fit_on:'SHARED_POOLED_CALIBRATION_BLOCK_LOGISTIC',
      sample_count:0,positive_count:0,negative_count:0,slope:1,intercept:0,fitted:false,
      reason:'SHARED_LOGISTIC_CALIBRATION_CLASS_SUPPORT_BELOW_MINIMUM'};

  // Shared chronological cutoffs prevent look-ahead; all data use is local.
  for(const regime of regimes){
    const regimeSplit=regimeSplits[regime];
    const regimeRows=regimeSplit.rows;
    const regimeHoldout=holdout.filter(row=>regimeOfSequence(row.sequence)===regime).sort((a,b)=>a.at-b.at);
    const regimeTraining=regimeSplit.training;
    const regimeMemberSelection=regimeSplit.memberSelection;
    const regimeCalibration=regimeSplit.calibration;
    const outerValidation=validation.filter(row=>regimeOfSequence(row.sequence)===regime);
    // Pooled TCN calibration ends at the shared cutoff. Evaluate only the
    // common outer validation block; local inner slices can begin too early.
    const regimeValidation=outerValidation.sort((a,b)=>a.at-b.at);
    const targetsOf=block=>({
      samples:block.length,
      positive:block.filter(row=>row.target===1).length,
      negative:block.filter(row=>row.target===0).length
    });
    const trainTargets=targetsOf(regimeTraining);
    const selectTargets=targetsOf(regimeMemberSelection);
    const validTargets=targetsOf(regimeValidation);
    const holdTargets=targetsOf(regimeHoldout);
    const localSelectionTargets=selectTargets;
    const localSelectionSupported=localSelectionTargets.samples>=minSelectionSamples&&
      localSelectionTargets.positive>=minSelectionPositive&&
      localSelectionTargets.negative>=minSelectionNegative;
    const memberSelectionRows=pooledMemberSelectionRows;
    const memberSelectionTargets=pooledMemberSelectionDiagnostics;
    const memberSelectionSource='SHARED_POOLED_MEMBER_SELECTION_BLOCK';
    const memberSelectionSupported=sharedTcnSelectionSupported;
    const localCalibrationTargets=calibrationSupport(regimeCalibration);
    const localCalibrationSupported=localCalibrationTargets.samples>=30&&
      localCalibrationTargets.positive>=5&&localCalibrationTargets.negative>=20;
    const calibrationRows=sharedCalibrationRows;
    const calibrationTargets=pooledCalibrationDiagnostics;
    const selectedCalibrationTargets=calibrationTargets;
    const calibrationSource='SHARED_POOLED_CALIBRATION_BLOCK';
    const sharedRegimeTraining=sharedTrainingRows.filter(row=>regimeOfSequence(row.sequence)===regime);
    trainingByRegime[regime]=sharedRegimeTraining.length;
    selectionByRegime[regime]=regimeMemberSelection.length;
    validationByRegime[regime]=regimeValidation.length;
    holdoutByRegime[regime]=regimeHoldout.length;
    trainingTargets[regime]=targetsOf(sharedRegimeTraining);
    selectionTargets[regime]=localSelectionTargets;
    validationTargets[regime]=validTargets;
    holdoutTargets[regime]=holdTargets;

    // Resolve the training-only regime baseline before evaluating specialist support.
    // Keeping this above the support checks avoids a temporal-dead-zone ReferenceError.
    const regimeBaseline=regimeBaselines[regime];
    const regimePrior=(regimeTraining.reduce((sum,row)=>sum+row.target,0)+2)/(regimeTraining.length+4);
    regimeLocalTcnResults[regime]=enableRegimeLocalTcn
      ?fitRegimeLocalTemporalTcn({
      regime,trainingRows:regimeTraining,memberSelectionRows:regimeMemberSelection,
      calibrationRows:regimeCalibration,validationRows:regimeValidation,holdoutRows:regimeHoldout,
      epochs:regimeLocalTcnEpochs,learningRate,l2,comparisonMargin,
      maxTrainingSamples:regimeLocalTcnMaxTrainingSamples,
      minTrainingSamples:minRegimeTraining,
      minTrainingPositive:minRegimeTrainingPositive,
      minTrainingNegative:minRegimeNegative,
      minSelectionSamples,minSelectionPositive,minSelectionNegative,
      minCalibrationSamples:30,minCalibrationPositive:5,minCalibrationNegative:20,
      minValidationSamples:minRegimeValidation,minValidationPositive:minRegimePositive,
      minValidationNegative:minRegimeNegative,
      minHoldoutSamples:minRegimeHoldout,minHoldoutPositive:minRegimePositive,
      minHoldoutNegative:minRegimeNegative
    })
      :{
        regime,status:'NOT_ENABLED_FOR_THIS_PROFILE',
        model_kind:'INDEPENDENT_REGIME_LOCAL_TCN_V1',
        model_scope:'INDEPENDENT_BTC_REGIME_TCN_WITH_REGIME_LOCAL_LOGISTIC_ANCHOR',
        training_strategy:TEMPORAL_REGIME_LOCAL_TRAINING_STRATEGY,
        training_samples:0,trained:false,selected_for_research:false,
        validation_passed:false,holdout_passed:false,probability_ready:false,
        live_eligibility_ready:false,support_gaps:['EXPLICIT_RESEARCH_OPT_IN_REQUIRED']
      };
    regimeLocalTcnPyramidResults[regime]=enableRegimeLocalTcnPyramid
      ?fitRegimeLocalTemporalTcn({
        regime,trainingRows:regimeTraining,memberSelectionRows:regimeMemberSelection,
        calibrationRows:regimeCalibration,validationRows:regimeValidation,holdoutRows:regimeHoldout,
        epochs:regimeLocalTcnPyramidEpochs,learningRate,l2,comparisonMargin,
        maxTrainingSamples:regimeLocalTcnPyramidMaxTrainingSamples,
        temporalPoolingMode:TEMPORAL_ORDERED_POOLING_MODE,
        minTrainingSamples:minRegimeTraining,
        minTrainingPositive:minRegimeTrainingPositive,
        minTrainingNegative:minRegimeNegative,
        minSelectionSamples,minSelectionPositive,minSelectionNegative,
        minCalibrationSamples:30,minCalibrationPositive:5,minCalibrationNegative:20,
        minValidationSamples:minRegimeValidation,minValidationPositive:minRegimePositive,
        minValidationNegative:minRegimeNegative,
        minHoldoutSamples:minRegimeHoldout,minHoldoutPositive:minRegimePositive,
        minHoldoutNegative:minRegimeNegative
      })
      :{
        regime,status:'NOT_ENABLED_FOR_THIS_PROFILE',
        model_kind:'INDEPENDENT_REGIME_LOCAL_TCN_ORDERED_PYRAMID_V1',
        model_scope:'INDEPENDENT_BTC_REGIME_TCN_WITH_REGIME_LOCAL_LOGISTIC_ANCHOR',
        temporal_pooling:TEMPORAL_ORDERED_POOLING_MODE,
        training_strategy:'INDEPENDENT_BTC_REGIME_TCN_ORDERED_FOUR_SEGMENT_POOLING_V1',
        training_samples:0,trained:false,selected_for_research:false,
        validation_passed:false,holdout_passed:false,probability_ready:false,
        live_eligibility_ready:false,support_gaps:['EXPLICIT_RESEARCH_OPT_IN_REQUIRED']
      };
    const supportGaps=[];
    if(sharedRegimeTraining.length<minRegimeTraining)supportGaps.push('REGIME_TRAINING_SAMPLE_COUNT');
    if(!pooledBaseline)supportGaps.push('SHARED_POOLED_LOGISTIC_ANCHOR_UNAVAILABLE');
    if(!sharedTcnTrainingSupported)supportGaps.push('SHARED_TCN_TRAINING_CLASS_SUPPORT');
    if(!memberSelectionSupported)supportGaps.push('SHARED_TCN_SELECTION_BLOCK_UNSUPPORTED');
    if(!sharedTcnCalibrationSupported)supportGaps.push('SHARED_TCN_CALIBRATION_BLOCK_UNSUPPORTED');
    if(regimeValidation.length<minRegimeValidation)supportGaps.push('VALIDATION_SAMPLE_COUNT');
    if(regimeHoldout.length<minRegimeHoldout)supportGaps.push('HOLDOUT_SAMPLE_COUNT');
    if(sharedTrainingTargets.negative<minRegimeNegative)supportGaps.push('SHARED_TRAINING_NEGATIVE_CLASS');
    if(sharedTrainingTargets.positive<minRegimeTrainingPositive)supportGaps.push('SHARED_TRAINING_POSITIVE_CLASS');
    if(calibrationTargets.samples<30)supportGaps.push('SHARED_CALIBRATION_SAMPLE_COUNT');
    if(calibrationTargets.positive<5)supportGaps.push('SHARED_CALIBRATION_POSITIVE_CLASS');
    if(calibrationTargets.negative<20)supportGaps.push('SHARED_CALIBRATION_NEGATIVE_CLASS');
    if(validTargets.positive<minRegimePositive)supportGaps.push('VALIDATION_POSITIVE_CLASS');
    if(validTargets.negative<minRegimeNegative)supportGaps.push('VALIDATION_NEGATIVE_CLASS');
    if(holdTargets.positive<minRegimePositive)supportGaps.push('HOLDOUT_POSITIVE_CLASS');
    if(holdTargets.negative<minRegimeNegative)supportGaps.push('HOLDOUT_NEGATIVE_CLASS');
    const supported=supportGaps.length===0;
    if(!supported){
      temporalBoostedTreeResults[regime]={
        supported:false,status:'WAITING_FOR_REGIME_SPECIALIST_SAMPLE_COVERAGE',
        support_gaps:[...supportGaps],training_samples:regimeTraining.length,
        selection_samples:memberSelectionRows.length,calibration_samples:calibrationRows.length,
        validation_samples:regimeValidation.length,holdout_samples:regimeHoldout.length,
        validation:{evaluated:false,sample_count:regimeValidation.length},
        holdout:{evaluated:false,sample_count:regimeHoldout.length}
      };
      regimeResults[regime]={supported:false,support_gaps:supportGaps,
        training_start_at:sharedTrainingRows[0]?.at??null,
        training_cutoff_at:sharedTrainingCutoffAt,
        selection_start_at:memberSelectionRows[0]?.at??null,
        member_selection_cutoff_at:sharedMemberSelectionCutoffAt,
        calibration_cutoff_at:sharedSelectionCutoffAt,
        validation_start_at:regimeValidation[0]?.at??validationStart,
        max_training_outcome_resolved_at:sharedTrainingMaxResolvedAt,
        training_samples:sharedTrainingRows.length,selection_samples:memberSelectionRows.length,
        local_selection_samples:regimeMemberSelection.length,local_selection_targets:localSelectionTargets,
        calibration_samples:calibrationRows.length,local_calibration_samples:regimeCalibration.length,
        member_selection_samples:memberSelectionRows.length,member_selection_source:memberSelectionSource,
        calibration_selection_samples:calibrationRows.length,calibration_source:calibrationSource,
        calibration_targets:selectedCalibrationTargets,
        selection_calibration_samples:0,
        validation_samples:regimeValidation.length,holdout_samples:regimeHoldout.length,
        regime_training_samples:sharedRegimeTraining.length,
        training_targets:targetsOf(sharedRegimeTraining),selection_targets:selectTargets,
        member_selection_targets:memberSelectionTargets,
        validation_targets:validTargets,holdout_targets:holdTargets,
        validation_passed:false,holdout_passed:false,
        validation_model:{evaluated:false,sample_count:regimeValidation.length},
        validation_logistic:{evaluated:false,sample_count:regimeValidation.length},
        holdout_model:{evaluated:false,sample_count:regimeHoldout.length},
        holdout_logistic:{evaluated:false,sample_count:regimeHoldout.length},
        member_selection_samples:memberSelectionRows.length,
        shared_member_selection_samples:memberSelectionRows.length,
        member_selection_source:memberSelectionSource,
        calibration_samples:calibrationRows.length,
        shared_calibration_samples:calibrationRows.length,
        calibration_source:calibrationSource,
        calibration_targets:calibrationTargets,
        selected_member_index:sharedTcnSelectedIndex,
        selected_residual_scale:sharedTcnSelectedScale,
        diagnostic_member_index:sharedTcnDiagnosticIndex,
        diagnostic_residual_scale:sharedTcnDiagnosticScale,
        neural_residual_contributes:sharedTcnSelectedScale>0,
        selection_calibration_samples:sharedTcnCalibrator.sample_count,
        logistic_calibration_samples:sharedLogisticCalibrator.sample_count,
        probability_calibration:sharedTcnCalibrator,
        logistic_probability_calibration:sharedLogisticCalibrator};
      continue;
    }

    const regimeFit=sharedTcnFit;
    // Same first-passage target, same regime-local training/selection/calibration
    // blocks, and the exact same frozen logistic anchor used by the TCN.
    const temporalTreeFit=fitTemporalResidualTrees(regimeTraining,regimeBaseline,{
      maxTrees:24,maxDepth:2,learningRate:0.04,l2:10,minimumLeafFraction:0.05
    });
    const temporalTreeCandidates=temporalTreeFit
      ?[6,12,18,24].filter(count=>count<=temporalTreeFit.trees.length)
        .flatMap(treeCount=>[0.25,0.5,0.75,1].map(residualScale=>({
          tree_count:treeCount,residual_scale:residualScale,
          metrics:evaluate(regimeMemberSelection,
            sequence=>predictTemporalResidualTrees(sequence,temporalTreeFit,residualScale,treeCount),
            regimePrior)
        })))
      :[];
    const temporalTreeBaselineSelection=evaluate(regimeMemberSelection,
      sequence=>predictLogistic(sequence,regimeBaseline),regimePrior);
    const temporalTreeWinner=temporalTreeCandidates.filter(row=>row.metrics.evaluated===true)
      .sort((a,b)=>a.metrics.model_brier_score-b.metrics.model_brier_score||
        a.tree_count-b.tree_count||a.residual_scale-b.residual_scale)[0]||null;
    const temporalTreeSelectionPassed=Boolean(temporalTreeWinner&&
      temporalTreeWinner.metrics.beat_base_rate===true&&
      temporalTreeBaselineSelection.evaluated===true&&
      temporalTreeWinner.metrics.model_brier_score+comparisonMargin<
        temporalTreeBaselineSelection.model_brier_score);
    const temporalTreeCalibrator=temporalTreeFit&&temporalTreeSelectionPassed
      ?fitSelectionProbabilityCalibrator(regimeCalibration,
        sequence=>predictTemporalResidualTrees(sequence,temporalTreeFit,
          temporalTreeWinner.residual_scale,temporalTreeWinner.tree_count),
        {minimumSamples:30,minimumPositive:5,minimumNegative:20,
         iterations:300,learningRate:0.03,regularization:0.45,
         fitOn:calibrationSource+'_TEMPORAL_GBDT'})
      :{method:'CALIBRATION_BLOCK_SHRUNK_BRIER_PLATT_V2',
        fit_on:calibrationSource+'_TEMPORAL_GBDT',sample_count:0,
        positive_count:0,negative_count:0,slope:1,intercept:0,fitted:false,
        reason:!temporalTreeFit?'TEMPORAL_TREE_NOT_TRAINED':
          'TEMPORAL_TREE_DID_NOT_BEAT_SELECTION_LOGISTIC'};
    const selectionPrior=baseRate;
    const candidateResidualScales=RESIDUAL_SCALES;
    const memberSelectionLogistic=sharedSelectionLogistic;
    const memberCandidates=sharedTcnCandidates;
    const diagnosticMemberCandidate=sharedTcnDiagnosticCandidate;
    const memberRanks=sharedTcnQualifiedCandidates;
    const selectedMemberIndex=sharedTcnSelectedIndex;
    const selectedResidualScale=sharedTcnSelectedScale;
    const diagnosticMemberIndex=sharedTcnDiagnosticIndex;
    const diagnosticResidualScale=sharedTcnDiagnosticScale;
    fitted.selected_member_by_regime[regime]=selectedMemberIndex;
    fitted.residual_scales_by_regime[regime]=selectedResidualScale;
    const memberSelectionScores=memberCandidates.map(row=>({
      index:row.index,residual_scale:row.residual_scale,
      brier_score:row.metrics.model_brier_score,
      base_rate_brier_score:row.metrics.base_rate_brier_score,
      beat_base_rate:row.metrics.beat_base_rate,
      same_window_logistic_brier_score:memberSelectionLogistic.model_brier_score??null,
      beats_same_window_logistic:memberSelectionLogistic.evaluated===true&&
        row.metrics.model_brier_score+comparisonMargin<memberSelectionLogistic.model_brier_score,
      selected:row.index===selectedMemberIndex&&row.residual_scale===selectedResidualScale
    }));
    // Calibration has a later chronological block and is regime-local. It
    // never reuses selection labels or borrows outcomes from another regime.
    // Calibrate the best selection-block candidate for honest diagnostic scoring.
    // If it fails the logistic gate, these scores remain diagnostic-only.
    const selectionCalibrator=sharedTcnCalibrator;
    fitted.probability_calibrators_by_regime[regime]=selectionCalibrator;
    fitted.specialists_by_regime[regime]={
      ...regimeFit,selected_member_index:selectedMemberIndex,
      selected_residual_scale:selectedResidualScale,
      diagnostic_member_index:diagnosticMemberIndex,
      diagnostic_residual_scale:diagnosticResidualScale,
      probability_calibrator:selectionCalibrator
    };

    // Fair challenger: calibrate the regime-local TCN and logistic anchor on
    // the same later, disjoint regime-specific calibration rows.
    const logisticProbabilityCalibrator=sharedLogisticCalibrator;
    const predictCalibratedLogistic=sequence=>calibratedProbability(
      predictLogistic(sequence,pooledBaseline),logisticProbabilityCalibrator);
    const neuralResidualContributes=selectedResidualScale>0;
    const diagnosticPrediction=sequence=>diagnosticMemberIndex>=0
      ?calibratedProbability(forward(sequence,regimeFit.members[diagnosticMemberIndex],diagnosticResidualScale).probability,selectionCalibrator)
      :null;
    const validationModel=selectedMemberIndex>=0
      ?evaluate(regimeValidation,sequence=>predict(sequence,fitted),regimePrior)
      :evaluate(regimeValidation,diagnosticPrediction,regimePrior);
    const validationLogistic=evaluate(regimeValidation,
      predictCalibratedLogistic,regimeBaseline.base_rate);
    const validationPassed=neuralResidualContributes&&
      selectionCalibrator.fitted===true&&logisticProbabilityCalibrator.fitted===true&&
      validationModel.evaluated&&validationLogistic.evaluated&&
      validationModel.beat_base_rate===true&&
      validationModel.model_brier_score+comparisonMargin<validationLogistic.model_brier_score;
    const holdoutModel=selectedMemberIndex>=0
      ?evaluate(regimeHoldout,sequence=>predict(sequence,fitted),regimePrior)
      :evaluate(regimeHoldout,diagnosticPrediction,regimePrior);
    const holdoutLogistic=evaluate(regimeHoldout,
      predictCalibratedLogistic,regimeBaseline.base_rate);
    const predictCalibratedTemporalTree=sequence=>calibratedProbability(
      temporalTreeFit&&temporalTreeWinner
        ?predictTemporalResidualTrees(sequence,temporalTreeFit,
          temporalTreeWinner.residual_scale,temporalTreeWinner.tree_count)
        :null,temporalTreeCalibrator);
    const treeLogisticCalibrator=fitSelectionProbabilityCalibrator(regimeCalibration,
      sequence=>predictLogistic(sequence,regimeBaseline),
      {minimumSamples:30,minimumPositive:5,minimumNegative:20,
       iterations:300,learningRate:0.03,regularization:0.45,
       fitOn:'REGIME_CALIBRATION_BLOCK_TEMPORAL_GBDT_LOGISTIC'});
    const predictCalibratedTreeLogistic=sequence=>calibratedProbability(
      predictLogistic(sequence,regimeBaseline),treeLogisticCalibrator);
    const temporalTreeValidationLogistic=evaluate(regimeValidation,predictCalibratedTreeLogistic,regimePrior);
    const temporalTreeHoldoutLogistic=evaluate(regimeHoldout,predictCalibratedTreeLogistic,regimePrior);
    const temporalTreeValidation=temporalTreeFit&&temporalTreeWinner
      ?evaluate(regimeValidation,predictCalibratedTemporalTree,regimePrior)
      :{evaluated:false,sample_count:regimeValidation.length,model_brier_score:null,
        base_rate_brier_score:null,beat_base_rate:false,reason:'TEMPORAL_TREE_NOT_SELECTED'};
    const temporalTreeValidationPassed=temporalTreeSelectionPassed&&
      temporalTreeCalibrator.fitted===true&&logisticProbabilityCalibrator.fitted===true&&
      temporalTreeValidation.evaluated===true&&temporalTreeValidationLogistic.evaluated===true&&
      temporalTreeValidation.beat_base_rate===true&&
      temporalTreeValidation.model_brier_score+comparisonMargin<
        temporalTreeValidationLogistic.model_brier_score;
    // Do not even score the untouched holdout for a tree that failed the
    // earlier validation gate. This keeps the final block out of model review.
    const temporalTreeHoldout=temporalTreeValidationPassed
      ?evaluate(regimeHoldout,predictCalibratedTemporalTree,regimePrior)
      :{evaluated:false,sample_count:regimeHoldout.length,model_brier_score:null,
        base_rate_brier_score:null,beat_base_rate:false,
        reason:'TEMPORAL_TREE_DID_NOT_PASS_CHRONOLOGICAL_VALIDATION'};
    const temporalTreeHoldoutPassed=temporalTreeValidationPassed&&
      temporalTreeHoldout.evaluated===true&&temporalTreeHoldoutLogistic.evaluated===true&&
      temporalTreeHoldout.beat_base_rate===true&&
      temporalTreeHoldout.model_brier_score+comparisonMargin<
        temporalTreeHoldoutLogistic.model_brier_score;
    temporalBoostedTreeResults[regime]={
      supported:true,
      status:!temporalTreeFit?'NO_TEMPORAL_TREE_TRAINING_GAIN':
        !temporalTreeSelectionPassed?'TEMPORAL_TREE_DID_NOT_BEAT_SELECTION_LOGISTIC':
        !temporalTreeCalibrator.fitted?'TEMPORAL_TREE_CALIBRATION_NOT_READY':
        temporalTreeHoldoutPassed?'TEMPORAL_GBDT_OUT_OF_SAMPLE_VALIDATED':
        temporalTreeValidationPassed?'TEMPORAL_GBDT_VALIDATION_PASSED_HOLDOUT_NOT_PASSED':
        'TEMPORAL_GBDT_DID_NOT_BEAT_VALIDATION_LOGISTIC',
      training_samples:regimeTraining.length,
      selection_samples:memberSelectionRows.length,
      calibration_samples:calibrationRows.length,
      validation_samples:regimeValidation.length,
      holdout_samples:regimeHoldout.length,
      training_positive_samples:trainTargets.positive,
      selection_positive_samples:memberSelectionTargets.positive,
      calibration_positive_samples:calibrationTargets.positive,
      validation_positive_samples:validTargets.positive,
      holdout_positive_samples:holdTargets.positive,
      training_cutoff_at:regimeSplit.trainingCutoffAt,
      member_selection_cutoff_at:regimeSplit.memberSelectionCutoffAt,
      calibration_cutoff_at:regimeSplit.calibrationCutoffAt,
      validation_start_at:regimeValidation[0]?.at??validationStart,
      max_training_outcome_resolved_at:regimeTraining.length
        ?Math.max(...regimeTraining.map(row=>row.resolved_at)):null,
      tree_count:temporalTreeFit?.tree_count||0,
      selected_tree_count:temporalTreeWinner?.tree_count??null,
      selected_residual_scale:temporalTreeWinner?.residual_scale??null,
      selection_brier:temporalTreeWinner?.metrics?.model_brier_score??null,
      selection_logistic_brier:temporalTreeBaselineSelection.model_brier_score??null,
      selection_passed:temporalTreeSelectionPassed,
      calibration:temporalTreeCalibrator,
      validation:temporalTreeValidation,
      validation_logistic:temporalTreeValidationLogistic,
      validation_passed:temporalTreeValidationPassed,
      holdout:temporalTreeHoldout,
      holdout_logistic:temporalTreeHoldoutLogistic,
      holdout_passed:temporalTreeHoldoutPassed,
      feature_importance:temporalTreeFit?.feature_importance||[],
      feature_importance_total_gain:temporalTreeFit?.feature_importance_total_gain??0
    };
    const holdoutPassed=selectedMemberIndex>=0&&validationPassed&&neuralResidualContributes&&
      holdoutModel.evaluated&&holdoutLogistic.evaluated&&
      holdoutModel.beat_base_rate===true&&
      holdoutModel.model_brier_score+comparisonMargin<holdoutLogistic.model_brier_score;
    regimeResults[regime]={supported:true,prior:regimePrior,
      training_start_at:sharedTrainingRows[0]?.at??null,
      training_cutoff_at:sharedTrainingCutoffAt,
      selection_start_at:memberSelectionRows[0]?.at??null,
      member_selection_cutoff_at:sharedMemberSelectionCutoffAt,
      calibration_start_at:calibrationRows[0]?.at??null,
      calibration_cutoff_at:sharedSelectionCutoffAt,
      validation_start_at:regimeValidation[0]?.at??validationStart,
      max_training_outcome_resolved_at:sharedTrainingMaxResolvedAt,
      training_samples:sharedTrainingRows.length,selection_samples:memberSelectionRows.length,
      regime_training_samples:sharedRegimeTraining.length,
      local_selection_samples:regimeMemberSelection.length,local_selection_targets:localSelectionTargets,
      calibration_samples:calibrationRows.length,local_calibration_samples:regimeCalibration.length,
      shared_member_selection_samples:memberSelectionRows.length,
      member_selection_samples:memberSelectionRows.length,member_selection_source:memberSelectionSource,
      calibration_selection_samples:calibrationRows.length,shared_calibration_samples:calibrationRows.length,calibration_source:calibrationSource,
      calibration_targets:selectedCalibrationTargets,
      selected_member_index:selectedMemberIndex,selected_residual_scale:selectedResidualScale,
      diagnostic_member_index:diagnosticMemberIndex,diagnostic_residual_scale:diagnosticResidualScale,
      diagnostic_only:selectedMemberIndex<0,
      neural_residual_contributes:neuralResidualContributes,
      selection_calibration_samples:selectionCalibrator.sample_count,
      logistic_calibration_samples:logisticProbabilityCalibrator.sample_count,
      validation_samples:regimeValidation.length,holdout_samples:regimeHoldout.length,
      validation_passed:validationPassed,holdout_passed:holdoutPassed,
      validation_model:validationModel,validation_logistic:validationLogistic,
      holdout_model:holdoutModel,holdout_logistic:holdoutLogistic,
      member_selection_scores:memberSelectionScores,
      member_selection_logistic_brier:memberSelectionLogistic.model_brier_score??null,
      member_selection_qualified_candidates:memberRanks.length,
      probability_calibration:selectionCalibrator,
      logistic_probability_calibration:logisticProbabilityCalibrator};
  }
  const temporalTreeSupportedRegimes=regimes.filter(regime=>
    temporalBoostedTreeResults[regime]?.supported===true);
  const temporalTreeValidationRegimes=regimes.filter(regime=>
    temporalBoostedTreeResults[regime]?.validation_passed===true);
  const temporalTreeSelectedRegimes=regimes.filter(regime=>
    temporalBoostedTreeResults[regime]?.holdout_passed===true);
  const temporalTreeValidation=aggregateEvaluations(temporalTreeSupportedRegimes.map(regime=>
    temporalBoostedTreeResults[regime]?.validation));
  const temporalTreeHoldout=aggregateEvaluations(temporalTreeSupportedRegimes.map(regime=>
    temporalBoostedTreeResults[regime]?.holdout));
  const temporalTreeValidationLogistic=aggregateEvaluations(temporalTreeSupportedRegimes.map(regime=>
    temporalBoostedTreeResults[regime]?.validation_logistic));
  const temporalTreeHoldoutLogistic=aggregateEvaluations(temporalTreeSupportedRegimes.map(regime=>
    temporalBoostedTreeResults[regime]?.holdout_logistic));
  const temporalTreeHoldoutCount=temporalTreeSelectedRegimes.reduce((sum,regime)=>
    sum+Number(temporalBoostedTreeResults[regime]?.holdout?.sample_count||0),0);
  const temporalTreeAllSupportedValidated=temporalTreeSupportedRegimes.length>0&&
    temporalTreeSupportedRegimes.every(regime=>temporalTreeSelectedRegimes.includes(regime));
  const temporalTreeLiveReady=temporalTreeSelectedRegimes.length>0&&
    temporalTreeAllSupportedValidated&&temporalTreeHoldoutCount>=liveHoldoutSamples;
  const temporalTreeFeatureImportanceMap=new Map();
  for(const regime of temporalTreeSupportedRegimes){
    for(const item of temporalBoostedTreeResults[regime]?.feature_importance||[]){
      const previous=temporalTreeFeatureImportanceMap.get(item.feature)||{gain:0,split_count:0};
      previous.gain+=Number(item.gain)||0;
      previous.split_count+=Number(item.split_count)||0;
      temporalTreeFeatureImportanceMap.set(item.feature,previous);
    }
  }
  const temporalTreeTotalGain=[...temporalTreeFeatureImportanceMap.values()]
    .reduce((sum,item)=>sum+item.gain,0);
  const temporalTreeFeatureImportance=[...temporalTreeFeatureImportanceMap.entries()]
    .map(([feature,item])=>({feature,gain:Number(item.gain.toFixed(7)),
      gain_share_pct:temporalTreeTotalGain>0
        ?Number((item.gain/temporalTreeTotalGain*100).toFixed(2)):0,
      split_count:item.split_count}))
    .sort((a,b)=>b.gain-a.gain||a.feature.localeCompare(b.feature));
  const temporalBoostedTreeProfile={
    status:!temporalTreeSupportedRegimes.length?'WAITING_FOR_REGIME_SPECIALIST_SAMPLE_COVERAGE':
      !temporalTreeValidationRegimes.length?'TEMPORAL_GBDT_DID_NOT_BEAT_SELECTION_OR_VALIDATION_LOGISTIC':
      !temporalTreeSelectedRegimes.length?'TEMPORAL_GBDT_VALIDATION_PASSED_HOLDOUT_NOT_PASSED':
      'TEMPORAL_GBDT_OUT_OF_SAMPLE_VALIDATED_RESEARCH_ONLY',
    model_kind:'TEMPORAL_FIRST_PASSAGE_RESIDUAL_GBDT_V1',
    architecture:'TEMPORAL_POOLED_58_NEWTON_GBDT_DEPTH2_24_ROUNDS',
    target_definition:targetDefinition,
    model_split_scope:'INDEPENDENT_BTC_REGIME_PURGED_WALK_FORWARD',
    model_scope:'REGIME_LOCAL_TEMPORAL_TREE_WITH_FROZEN_LOGISTIC_ANCHOR',
    feature_source:'24_STEP_MEANS_PLUS_RECENT_8_STEP_MEANS',
    trained:temporalTreeSupportedRegimes.some(regime=>
      Number(temporalBoostedTreeResults[regime]?.tree_count)>0),
    selected_for_research:temporalTreeSelectedRegimes.length>0,
    research_out_of_sample_validated:temporalTreeSelectedRegimes.length>0,
    research_live_sample_count_gate_met:temporalTreeLiveReady,
    probability_ready:false,
    live_eligibility_ready:false,
    supported_regimes:temporalTreeSupportedRegimes,
    validation_selected_regimes:temporalTreeValidationRegimes,
    selected_regimes:temporalTreeSelectedRegimes,
    training_samples:temporalTreeSupportedRegimes.reduce((sum,regime)=>
      sum+Number(temporalBoostedTreeResults[regime]?.training_samples||0),0),
    selection_samples:temporalTreeSupportedRegimes.reduce((sum,regime)=>
      sum+Number(temporalBoostedTreeResults[regime]?.selection_samples||0),0),
    calibration_samples:temporalTreeSupportedRegimes.reduce((sum,regime)=>
      sum+Number(temporalBoostedTreeResults[regime]?.calibration_samples||0),0),
    validation_samples:temporalTreeValidation.sample_count||0,
    holdout_samples:temporalTreeHoldout.sample_count||0,
    validation:temporalTreeValidation,
    validation_logistic:temporalTreeValidationLogistic,
    holdout:temporalTreeHoldout,
    holdout_logistic:temporalTreeHoldoutLogistic,
    holdout_comparison:{
      required_brier_margin:comparisonMargin,
      sample_count:temporalTreeHoldout.sample_count||0,
      model_brier_score:temporalTreeHoldout.model_brier_score??null,
      logistic_brier_score:temporalTreeHoldoutLogistic.model_brier_score??null,
      beats_base_rate:temporalTreeHoldout.beat_base_rate===true,
      beats_logistic:temporalTreeHoldout.evaluated===true&&
        temporalTreeHoldoutLogistic.evaluated===true&&
        temporalTreeHoldout.model_brier_score+comparisonMargin<
          temporalTreeHoldoutLogistic.model_brier_score,
      passed:temporalTreeSelectedRegimes.length>0&&
        temporalTreeHoldout.evaluated===true&&temporalTreeHoldout.beat_base_rate===true&&
        temporalTreeHoldoutLogistic.evaluated===true&&
        temporalTreeHoldout.model_brier_score+comparisonMargin<
          temporalTreeHoldoutLogistic.model_brier_score,
      selected_regimes:temporalTreeSelectedRegimes,
      supported_regimes:temporalTreeSupportedRegimes,
      all_supported_regimes_validated:temporalTreeAllSupportedValidated,
      live_holdout_samples:temporalTreeHoldoutCount,
      required_live_holdout_samples:liveHoldoutSamples
    },
    regime_specialists:temporalBoostedTreeResults,
    feature_importance:temporalTreeFeatureImportance,
    feature_importance_total_gain:Number(temporalTreeTotalGain.toFixed(7))
  };
  const regimeLocalTcnSupportedRegimes=regimes.filter(regime=>
    regimeLocalTcnResults[regime]?.trained===true);
  const regimeLocalTcnValidationRegimes=regimes.filter(regime=>
    regimeLocalTcnResults[regime]?.validation_passed===true);
  const regimeLocalTcnSelectedRegimes=regimes.filter(regime=>
    regimeLocalTcnResults[regime]?.holdout_passed===true);
  const regimeLocalTcnValidation=aggregateEvaluations(regimeLocalTcnSupportedRegimes.map(regime=>
    regimeLocalTcnResults[regime]?.validation));
  const regimeLocalTcnValidationLogistic=aggregateEvaluations(regimeLocalTcnSupportedRegimes.map(regime=>
    regimeLocalTcnResults[regime]?.validation_logistic));
  const regimeLocalTcnHoldout=aggregateEvaluations(regimeLocalTcnSelectedRegimes.map(regime=>
    regimeLocalTcnResults[regime]?.holdout));
  const regimeLocalTcnHoldoutLogistic=aggregateEvaluations(regimeLocalTcnSelectedRegimes.map(regime=>
    regimeLocalTcnResults[regime]?.holdout_logistic));
  const regimeLocalTcnTrainingSamples=regimeLocalTcnSupportedRegimes.reduce((sum,regime)=>
    sum+Number(regimeLocalTcnResults[regime]?.training_samples||0),0);
  const regimeLocalTcnHoldoutSamples=regimeLocalTcnSelectedRegimes.reduce((sum,regime)=>
    sum+Number(regimeLocalTcnResults[regime]?.holdout?.sample_count||0),0);
  const regimeLocalTcnProfile={
    status:!regimeLocalTcnSupportedRegimes.length?'WAITING_FOR_REGIME_LOCAL_TCN_SUPPORT':
      !regimeLocalTcnValidationRegimes.length?'REGIME_LOCAL_TCN_DID_NOT_BEAT_SELECTION_OR_VALIDATION_LOGISTIC':
      !regimeLocalTcnSelectedRegimes.length?'REGIME_LOCAL_TCN_VALIDATION_PASSED_HOLDOUT_NOT_PASSED':
      'REGIME_LOCAL_TCN_OUT_OF_SAMPLE_VALIDATED_RESEARCH_ONLY',
    architecture:TEMPORAL_MODEL_ARCHITECTURE,
    model_kind:'INDEPENDENT_REGIME_LOCAL_TCN_V1',
    training_strategy:TEMPORAL_REGIME_LOCAL_TRAINING_STRATEGY,
    model_scope:'INDEPENDENT_BTC_REGIME_TCN_WITH_REGIME_LOCAL_LOGISTIC_ANCHOR',
    training_sample_budget:TEMPORAL_REGIME_LOCAL_MAX_TRAINING_SAMPLES,
    target_definition:targetDefinition,
    trained:regimeLocalTcnSupportedRegimes.length>0,
    selected_for_research:regimeLocalTcnValidationRegimes.length>0,
    research_out_of_sample_validated:regimeLocalTcnSelectedRegimes.length>0,
    probability_ready:false,live_eligibility_ready:false,
    supported_regimes:regimeLocalTcnSupportedRegimes,
    validation_selected_regimes:regimeLocalTcnValidationRegimes,
    selected_regimes:regimeLocalTcnSelectedRegimes,
    training_samples:regimeLocalTcnTrainingSamples,
    selection_samples:regimeLocalTcnSupportedRegimes.reduce((sum,regime)=>
      sum+Number(regimeLocalTcnResults[regime]?.selection_samples||0),0),
    calibration_samples:regimeLocalTcnSupportedRegimes.reduce((sum,regime)=>
      sum+Number(regimeLocalTcnResults[regime]?.calibration_samples||0),0),
    validation_samples:regimeLocalTcnValidation.sample_count||0,
    validation:regimeLocalTcnValidation,
    validation_logistic:regimeLocalTcnValidationLogistic,
    holdout_samples:regimeLocalTcnHoldout.sample_count||0,
    holdout:regimeLocalTcnHoldout,
    holdout_logistic:regimeLocalTcnHoldoutLogistic,
    holdout_comparison:{
      required_brier_margin:comparisonMargin,
      model_brier_score:regimeLocalTcnHoldout.model_brier_score??null,
      logistic_brier_score:regimeLocalTcnHoldoutLogistic.model_brier_score??null,
      beats_base_rate:regimeLocalTcnHoldout.beat_base_rate===true,
      beats_logistic:regimeLocalTcnHoldout.evaluated===true&&
        regimeLocalTcnHoldoutLogistic.evaluated===true&&
        regimeLocalTcnHoldout.model_brier_score+comparisonMargin<
          regimeLocalTcnHoldoutLogistic.model_brier_score,
      passed:regimeLocalTcnSelectedRegimes.length>0&&
        regimeLocalTcnHoldout.evaluated===true&&
        regimeLocalTcnHoldoutLogistic.evaluated===true&&
        regimeLocalTcnHoldout.model_brier_score+comparisonMargin<
          regimeLocalTcnHoldoutLogistic.model_brier_score,
      holdout_sample_count:regimeLocalTcnHoldoutSamples,
      selected_regimes:regimeLocalTcnSelectedRegimes,
      supported_regimes:regimeLocalTcnSupportedRegimes,
      all_supported_regimes_validated:regimeLocalTcnSupportedRegimes.length>0&&
        regimeLocalTcnSupportedRegimes.every(regime=>regimeLocalTcnSelectedRegimes.includes(regime))
    },
    regime_specialists:regimeLocalTcnResults
  };
  const regimeLocalTcnPyramidSupportedRegimes=regimes.filter(regime=>
    regimeLocalTcnPyramidResults[regime]?.trained===true);
  const regimeLocalTcnPyramidValidationRegimes=regimes.filter(regime=>
    regimeLocalTcnPyramidResults[regime]?.validation_passed===true);
  const regimeLocalTcnPyramidSelectedRegimes=regimes.filter(regime=>
    regimeLocalTcnPyramidResults[regime]?.holdout_passed===true);
  const regimeLocalTcnPyramidValidation=aggregateEvaluations(
    regimeLocalTcnPyramidSupportedRegimes.map(regime=>regimeLocalTcnPyramidResults[regime]?.validation));
  const regimeLocalTcnPyramidValidationLogistic=aggregateEvaluations(
    regimeLocalTcnPyramidSupportedRegimes.map(regime=>regimeLocalTcnPyramidResults[regime]?.validation_logistic));
  const regimeLocalTcnPyramidHoldout=aggregateEvaluations(
    regimeLocalTcnPyramidSelectedRegimes.map(regime=>regimeLocalTcnPyramidResults[regime]?.holdout));
  const regimeLocalTcnPyramidHoldoutLogistic=aggregateEvaluations(
    regimeLocalTcnPyramidSelectedRegimes.map(regime=>regimeLocalTcnPyramidResults[regime]?.holdout_logistic));
  const regimeLocalTcnPyramidTrainingSamples=regimeLocalTcnPyramidSupportedRegimes.reduce((sum,regime)=>
    sum+Number(regimeLocalTcnPyramidResults[regime]?.training_samples||0),0);
  const regimeLocalTcnPyramidHoldoutSamples=regimeLocalTcnPyramidSelectedRegimes.reduce((sum,regime)=>
    sum+Number(regimeLocalTcnPyramidResults[regime]?.holdout?.sample_count||0),0);
  const regimeLocalTcnPyramidProfile={
    status:!regimeLocalTcnPyramidSupportedRegimes.length?'WAITING_FOR_ORDERED_POOLING_TCN_SUPPORT':
      !regimeLocalTcnPyramidValidationRegimes.length?'ORDERED_POOLING_TCN_DID_NOT_BEAT_SELECTION_OR_VALIDATION_LOGISTIC':
      !regimeLocalTcnPyramidSelectedRegimes.length?'ORDERED_POOLING_TCN_VALIDATION_PASSED_HOLDOUT_NOT_PASSED':
      'ORDERED_POOLING_TCN_OUT_OF_SAMPLE_VALIDATED_RESEARCH_ONLY',
    architecture:TEMPORAL_ORDERED_POOLING_MODEL_ARCHITECTURE,
    model_kind:'INDEPENDENT_REGIME_LOCAL_TCN_ORDERED_PYRAMID_V1',
    temporal_pooling:TEMPORAL_ORDERED_POOLING_MODE,
    pooling_segments:TEMPORAL_ORDERED_POOLING_SEGMENTS,
    output_features:TEMPORAL_ORDERED_POOLING_FEATURE_COUNT,
    trainable_parameter_count:TEMPORAL_ORDERED_POOLING_TRAINABLE_PARAMETER_COUNT,
    training_strategy:'INDEPENDENT_BTC_REGIME_TCN_ORDERED_FOUR_SEGMENT_POOLING_V1',
    model_scope:'INDEPENDENT_BTC_REGIME_TCN_WITH_REGIME_LOCAL_LOGISTIC_ANCHOR',
    training_sample_budget:Math.max(80,Math.min(TEMPORAL_REGIME_LOCAL_MAX_TRAINING_SAMPLES,
      Math.trunc(Number(regimeLocalTcnPyramidMaxTrainingSamples)||TEMPORAL_REGIME_LOCAL_MAX_TRAINING_SAMPLES))),
    target_definition:targetDefinition,
    trained:regimeLocalTcnPyramidSupportedRegimes.length>0,
    selected_for_research:regimeLocalTcnPyramidValidationRegimes.length>0,
    research_out_of_sample_validated:regimeLocalTcnPyramidSelectedRegimes.length>0,
    probability_ready:false,live_eligibility_ready:false,
    supported_regimes:regimeLocalTcnPyramidSupportedRegimes,
    validation_selected_regimes:regimeLocalTcnPyramidValidationRegimes,
    selected_regimes:regimeLocalTcnPyramidSelectedRegimes,
    training_samples:regimeLocalTcnPyramidTrainingSamples,
    selection_samples:regimeLocalTcnPyramidSupportedRegimes.reduce((sum,regime)=>
      sum+Number(regimeLocalTcnPyramidResults[regime]?.selection_samples||0),0),
    calibration_samples:regimeLocalTcnPyramidSupportedRegimes.reduce((sum,regime)=>
      sum+Number(regimeLocalTcnPyramidResults[regime]?.calibration_samples||0),0),
    validation_samples:regimeLocalTcnPyramidValidation.sample_count||0,
    validation:regimeLocalTcnPyramidValidation,
    validation_logistic:regimeLocalTcnPyramidValidationLogistic,
    holdout_samples:regimeLocalTcnPyramidHoldout.sample_count||0,
    holdout:regimeLocalTcnPyramidHoldout,
    holdout_logistic:regimeLocalTcnPyramidHoldoutLogistic,
    holdout_comparison:{
      required_brier_margin:comparisonMargin,
      model_brier_score:regimeLocalTcnPyramidHoldout.model_brier_score??null,
      logistic_brier_score:regimeLocalTcnPyramidHoldoutLogistic.model_brier_score??null,
      beats_base_rate:regimeLocalTcnPyramidHoldout.beat_base_rate===true,
      beats_logistic:regimeLocalTcnPyramidHoldout.evaluated===true&&
        regimeLocalTcnPyramidHoldoutLogistic.evaluated===true&&
        regimeLocalTcnPyramidHoldout.model_brier_score+comparisonMargin<
          regimeLocalTcnPyramidHoldoutLogistic.model_brier_score,
      passed:regimeLocalTcnPyramidSelectedRegimes.length>0&&
        regimeLocalTcnPyramidHoldout.evaluated===true&&
        regimeLocalTcnPyramidHoldoutLogistic.evaluated===true&&
        regimeLocalTcnPyramidHoldout.model_brier_score+comparisonMargin<
          regimeLocalTcnPyramidHoldoutLogistic.model_brier_score,
      holdout_sample_count:regimeLocalTcnPyramidHoldoutSamples,
      selected_regimes:regimeLocalTcnPyramidSelectedRegimes,
      supported_regimes:regimeLocalTcnPyramidSupportedRegimes,
      all_supported_regimes_validated:regimeLocalTcnPyramidSupportedRegimes.length>0&&
        regimeLocalTcnPyramidSupportedRegimes.every(regime=>
          regimeLocalTcnPyramidSelectedRegimes.includes(regime))
    },
    regime_specialists:regimeLocalTcnPyramidResults
  };
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
      model_scope:'SHARED_POOLED_TCN_WITH_PER_REGIME_OUTER_GATES',
      model_split_scope:'SHARED_POOLED_CHRONOLOGICAL_PURGED_WALK_FORWARD_WITH_REGIME_GATES_V1',
      training_cutoff_at:sharedTrainingCutoffAt,
      member_selection_cutoff_at:sharedMemberSelectionCutoffAt,
      calibration_cutoff_at:sharedSelectionCutoffAt,
      local_selection_samples:Number(result.local_selection_samples)||0,
      local_selection_positive_samples:Number(result.local_selection_targets?.positive)||0,
      local_selection_negative_samples:Number(result.local_selection_targets?.negative)||0,
      pooled_selection_diagnostic_samples:pooledMemberSelectionDiagnostics.samples,
      pooled_selection_diagnostic_positive_samples:pooledMemberSelectionDiagnostics.positive,
      pooled_selection_diagnostic_negative_samples:pooledMemberSelectionDiagnostics.negative,
      pooled_calibration_diagnostic_samples:pooledCalibrationDiagnostics.samples,
      pooled_calibration_diagnostic_positive_samples:pooledCalibrationDiagnostics.positive,
      pooled_calibration_diagnostic_negative_samples:pooledCalibrationDiagnostics.negative,
      pooled_training_diagnostic_samples:sharedTrainingTargets.samples,
      pooled_training_diagnostic_positive_samples:sharedTrainingTargets.positive,
      local_calibration_samples:Number(result.local_calibration_samples)||0,
      baseline_anchor_source:'SHARED_POOLED_TRAINING_ONLY',
      baseline_anchor_training_samples:sharedTrainingRows.length,
      baseline_anchor_local_training_samples:trainingByRegime[regime],
      baseline_anchor_local_positive_samples:Number(trainingTargets[regime]?.positive)||0,
      baseline_anchor_local_negative_samples:Number(trainingTargets[regime]?.negative)||0,
      training_start_at:result.training_start_at??null,
      selection_start_at:result.selection_start_at??null,
      calibration_start_at:result.calibration_start_at??null,
      validation_start_at:result.validation_start_at??null,
      max_training_outcome_resolved_at:result.max_training_outcome_resolved_at??null,
      training_samples:trainingByRegime[regime],
      regime_training_samples:trainingByRegime[regime],
      shared_training_samples:Number(result.training_samples)||0,
      selection_samples:Number(result.selection_samples)||0,
      calibration_samples:Number(result.calibration_samples)||0,
      shared_calibration_samples:Number(result.shared_calibration_samples)||0,
      calibration_source:result.calibration_source||null,
      calibration_targets:result.calibration_targets||null,
      calibration_selection_samples:Number(result.calibration_selection_samples)||0,
      member_selection_samples:Number(result.member_selection_samples)||0,
      shared_member_selection_samples:Number(result.shared_member_selection_samples)||0,
      member_selection_source:result.member_selection_source||null,
      member_selection_logistic_brier:result.member_selection_logistic_brier??null,
      member_selection_qualified_candidates:Number(result.member_selection_qualified_candidates)||0,
      member_selection_scores:Array.isArray(result.member_selection_scores)?result.member_selection_scores:[],
      selected_member_index:Number.isInteger(result.selected_member_index)?result.selected_member_index:null,
      selected_residual_scale:Number(result.selected_residual_scale),
      diagnostic_member_index:Number.isInteger(result.diagnostic_member_index)?result.diagnostic_member_index:null,
      diagnostic_residual_scale:Number(result.diagnostic_residual_scale)||0,
      diagnostic_only:result.diagnostic_only===true,
      neural_residual_contributes:result.neural_residual_contributes===true,
      selection_calibration_samples:Number(result.selection_calibration_samples)||0,
      logistic_calibration_samples:Number(result.logistic_calibration_samples)||0,
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
      validation_diagnostic_only:result.validation_passed!==true&&result.validation_model?.evaluated===true,
      validation_base_rate_brier:result.validation_model?.base_rate_brier_score??null,
      validation_pooled_logistic_brier:result.validation_logistic?.model_brier_score??null,
      holdout_brier:result.holdout_model?.model_brier_score??null,
      holdout_diagnostic_only:result.holdout_passed!==true&&result.holdout_model?.evaluated===true,
      holdout_base_rate_brier:result.holdout_model?.base_rate_brier_score??null,
      holdout_pooled_logistic_brier:result.holdout_logistic?.model_brier_score??null,
      probability_calibration:result.probability_calibration||null,
      logistic_probability_calibration:result.logistic_probability_calibration?{
        fit_on:result.logistic_probability_calibration.fit_on||null,
        fitted:result.logistic_probability_calibration.fitted===true,
        sample_count:Number(result.logistic_probability_calibration.sample_count)||0,
        positive_count:Number(result.logistic_probability_calibration.positive_count)||0,
        negative_count:Number(result.logistic_probability_calibration.negative_count)||0
      }:null
    }];
  }));
  // Top-level training counts describe both separate regime-local fit sets.
  // The global outer validation and final holdout remain outside all fitting.
  const reportTrainingSamples=sharedTrainingRows.length;
  const reportSelectionSamples=pooledMemberSelectionRows.length;
  const reportValidationSamples=Object.values(validationByRegime).reduce((sum,value)=>sum+Number(value||0),0);
  const reportHoldoutSamples=holdout.length;
  const reportTrainingPositive=sharedTrainingRows.filter(row=>row.target===1).length;
  const reportTrainingNegative=sharedTrainingRows.filter(row=>row.target===0).length;
  const reportTrainingPrior=(reportTrainingPositive+2)/(reportTrainingSamples+4);
  const reportMaxTrainingResolvedAt=sharedTrainingMaxResolvedAt;
  const reportValidationStartAt=validationStart;
  const validationReason=!supportedRegimes.length?'NO_SUPPORTED_BTC_REGIME':
    !validationSelectedRegimes.length?'NO_REGIME_BEAT_ITS_VALIDATION_LOGISTIC':
    'AT_LEAST_ONE_REGIME_BEAT_ITS_VALIDATION_LOGISTIC';
  const holdoutReason=!selected?'VALIDATION_NOT_PASSED':
    !selectedRegimes.length?'NO_VALIDATED_REGIME_BEAT_ITS_UNTOUCHED_HOLDOUT_LOGISTIC':
    'AT_LEAST_ONE_REGIME_BEAT_ITS_UNTOUCHED_HOLDOUT_LOGISTIC';
  const status=!supportedRegimes.length?'WAITING_FOR_REGIME_SPECIALIST_SAMPLE_COVERAGE':
    !validationSelectedRegimes.length?'VALIDATION_DID_NOT_BEAT_REGIME_LOGISTIC':
    !holdoutPassed?'VALIDATION_PASSED_HOLDOUT_NOT_PASSED':
    !allSupportedRegimesValidated?'PARTIAL_REGIME_OUT_OF_SAMPLE_VALIDATED_PAPER_ONLY':
    liveReady?'LIVE_GATE_PASSED_OUT_OF_SAMPLE':'OUT_OF_SAMPLE_VALIDATED_PAPER_ONLY';
  return{
    status,architecture,target_definition:targetDefinition,
    temporal_boosted_tree:temporalBoostedTreeProfile,
    regime_local_tcn_challenger:regimeLocalTcnProfile,
    regime_local_tcn_pyramid_challenger:regimeLocalTcnPyramidProfile,
    latent_channels:TEMPORAL_LATENT_CHANNELS,
    trainable_parameter_count:TEMPORAL_TRAINABLE_PARAMETER_COUNT,
    temporal_label_resolution:'15M_ONLY',
    sequence_steps:TEMPORAL_SEQUENCE_STEPS,sequence_channels:TEMPORAL_SEQUENCE_CHANNELS,
    ensemble_members:sharedTcnFit?SEEDS.length:0,
    ensemble_members_required:SEEDS.length,
    training_strategy:fitted.training_strategy,
    gradient_accumulation:TEMPORAL_GRADIENT_ACCUMULATION,
    baseline_feature_cache:TEMPORAL_BASELINE_FEATURE_CACHE,
    baseline_feature_count:TEMPORAL_POOLED_BASELINE_FEATURE_COUNT,
    gradient_buffer_scope:TEMPORAL_GRADIENT_BUFFER_SCOPE,
    baseline_anchor:fitted.baseline_anchor,
    training_objective:fitted.training_objective,
    member_training_profiles:sharedTcnFit?.member_training_profiles||[],
    member_training_profiles_by_regime:Object.fromEntries(regimes.map(regime=>
      [regime,sharedTcnFit?.member_training_profiles||[]])),
    member_validation_scores:Object.fromEntries(regimes.map(regime=>[
      regime,regimeResults[regime]?.member_selection_scores||[]
    ])),
    selected_member_index:null,
    member_selection_method:'SHARED_POOLED_CHRONOLOGICAL_MEMBER_AND_RESIDUAL_SCALE_SELECTION_BRIER',
    residual_scale_selection:'SHARED_POOLED_SELECTION_BLOCK_BRIER_GRID_V1',
    candidate_residual_scales:[...RESIDUAL_SCALES],
    regime_specialist_count:2,
    independent_regime_models:0,
    shared_model_count:sharedTcnFit?1:0,
    regime_selection_mode:'SHARED_TCN_WITH_INDEPENDENT_PER_REGIME_OUTER_GATES_V1',
    regime_split_method:'SHARED_GLOBAL_TIME_SPLIT_WITH_REGIME_LOCAL_AUXILIARY_TREE_SPLITS_V1',
    model_split_scope:'SHARED_POOLED_CHRONOLOGICAL_PURGED_WALK_FORWARD_WITH_REGIME_GATES_V1',
    shared_model_split_boundaries:{training_cutoff_at:sharedTrainingCutoffAt,
      member_selection_cutoff_at:sharedMemberSelectionCutoffAt,
      calibration_cutoff_at:sharedSelectionCutoffAt,validation_start_at:validationStart,holdout_start_at:holdoutStart},
    regime_local_split_boundaries:Object.fromEntries(regimes.map(regime=>[regime,{
      training_cutoff_at:regimeSplits[regime].trainingCutoffAt,
      member_selection_cutoff_at:regimeSplits[regime].memberSelectionCutoffAt,
      calibration_cutoff_at:regimeSplits[regime].calibrationCutoffAt,
      training_samples:regimeSplits[regime].training.length,
      member_selection_samples:regimeSplits[regime].memberSelection.length,
      calibration_samples:regimeSplits[regime].calibration.length,
      inner_validation_samples:regimeSplits[regime].innerValidation.length
    }])),
    model_scope:'SHARED_POOLED_TCN_WITH_PER_REGIME_OUTER_GATES_AND_POOLED_LOGISTIC_ANCHOR',
    residual_anchor:'SHARED_POOLED_TRAINING_ONLY_LOGISTIC_FROZEN',
    calibration_strategy:'SHARED_POOLED_CALIBRATION_BLOCK_SHRUNK_BRIER_PLATT_V2',
    calibration_fit_scope:'SHARED_POOLED_CALIBRATION_BLOCK_ONLY',
    resolved_samples:rows.length,training_samples:reportTrainingSamples,
    regime_model_training_samples:sharedTrainingRows.length,
    pooled_model_selection_diagnostic_samples:pooledMemberSelectionDiagnostics.samples,
    member_selection_samples_total:reportSelectionSamples,
    selection_samples:reportSelectionSamples,
    validation_samples:reportValidationSamples,holdout_samples:reportHoldoutSamples,
    shared_model_training_cutoff_at:sharedTrainingCutoffAt,
    shared_model_member_selection_cutoff_at:sharedMemberSelectionCutoffAt,
    shared_model_selection_cutoff_at:sharedSelectionCutoffAt,
    shared_model_training_samples:sharedTrainingRows.length,
    shared_model_selection_samples:pooledMemberSelectionRows.length,
    shared_model_calibration_samples:sharedCalibrationRows.length,
    shared_model_training_targets:sharedTrainingTargets,
    shared_model_selection_targets:sharedSelectionTargets,
    shared_model_calibration_targets:sharedCalibrationTargets,
    shared_model_selection_logistic_brier:sharedSelectionLogistic.model_brier_score??null,
    shared_model_selection_passed:sharedTcnSelectionPassed,
    shared_model_selected_member_index:sharedTcnSelectedIndex,
    shared_model_selected_residual_scale:sharedTcnSelectedScale,
    shared_model_split_fractions:{...splitFractions},
    shared_model_selection_layout:`TRAIN_${Math.round(sharedTrainCutIndex/fitTimes.length*100)}_PERCENT_MEMBER_SELECTION_${Math.round((sharedMemberSelectionCutIndex-sharedTrainCutIndex)/fitTimes.length*100)}_PERCENT_CALIBRATION_${Math.round((sharedSelectionCutIndex-sharedMemberSelectionCutIndex)/fitTimes.length*100)}_PERCENT`,
    regime_model_training_max_outcome_resolved_at:sharedTrainingMaxResolvedAt,
    required_training_samples:minTrainingSamples,
    required_selection_samples:minSelectionSamples,
    required_validation_samples:minimumValidationSamples,
    required_holdout_samples:minimumHoldoutSamples,
    validation_start_at:reportValidationStartAt,holdout_start_at:holdoutStart,
    outer_validation_start_at:validationStart,outer_holdout_start_at:holdoutStart,
    outer_training_samples:training.length,outer_validation_samples:validation.length,
    outer_holdout_samples:holdout.length,
    outer_sample_fingerprint:sampleIdentityFingerprint(rows),
    max_training_outcome_resolved_at:reportMaxTrainingResolvedAt,
    training_positive_rate_pct:Number((reportTrainingPositive/Math.max(1,reportTrainingSamples)*100).toFixed(2)),
    training_positive_count:reportTrainingPositive,
    training_negative_count:reportTrainingNegative,
    training_prior_probability:Number(reportTrainingPrior.toFixed(5)),
    shared_tcn_model_count:sharedTcnFit?1:0,
    trained:sharedTcnFit!==null,selected,probability_ready:probabilityReady,
    live_eligibility_ready:liveReady,
    supported_regimes:supportedRegimes,
    selected_regimes:selectedRegimes,
    regime_specialists:specialistProfiles,
    pooled_selection_diagnostics:pooledMemberSelectionDiagnostics,
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
      // sample_count is the exact diagnostic holdout sample count; the
      // selected-regime count is separate and alone contributes to readiness.
      sample_count:holdoutModel.sample_count,
      selected_regime_sample_count:selectedRegimeHoldoutSamples,
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

