import {buildTemporalNeuralProfile,predictTemporalProbability,TEMPORAL_TARGET_DEFINITION} from './temporal-neural-brain.mjs';

// Machine-readable identity for runtime/deployment acceptance. This is a code
// contract only; it does not imply that either challenger has passed validation.
export const COGNITIVE_MODEL_BUILD_CONTRACT = 'RADARX_COGNITIVE_AGENT_V5_TCN_V7';

/**
 * RadarX Build 224 — Cognitive Agent V5 (Residual Deep Neural Challenger)
 *
 * An interpretable, feedback-driven research model. It learns relationships
 * between market evidence and matured closed-candle outcomes, checks itself
 * against a purged chronological holdout, and exposes counterfactual evidence.
 * It is not consciousness, does not claim human-level reasoning, and cannot
 * create exchange orders or change radar configuration.
 */

const MIN_OUTCOME_HORIZON_MS = 4 * 60 * 60 * 1000;
const NEURAL_RESIDUAL_SCALES = Object.freeze([0,0.1,0.25,0.5,1]);
const NEURAL_POLICY = Object.freeze({
  hiddenUnits: 10,
  secondHiddenUnits: 6,
  minTrainingSamples: 240,
  // Use up to 1,500 newest purged training rows. This widens the model-fit,
  // member-selection and calibration blocks without consuming outer validation
  // or the untouched holdout; the 18-10-6 ensemble remains compact.
  maxTrainingSamples: 1500,
  iterations: 100,
  learningRate: 0.012,
  l2: 0.04,
  selectionMargin: 0.003,
  ensembleSeeds: Object.freeze([11, 29, 47])
});
const FEATURE_NAMES = Object.freeze([
  'volume_expansion',
  'trade_expansion',
  'buyer_pressure',
  'price_structure',
  'volatility_compression',
  'relative_strength',
  'short_momentum',
  'multi_hour_trend',
  'micro_buy_pressure',
  'close_location',
  'upper_wick_rejection',
  'volume_x_buyer',
  'structure_x_buyer',
  'relative_x_trend',
  'compression_x_structure',
  'volume_x_buyer_x_structure',
  'trade_x_buyer',
  'volume_buyer_structure_confluence'
]);

const FACTORS = Object.freeze([
  { key: 'volume_expansion', label_ar: 'تسارع حجم التداول', test: f => finite(f.volume_ratio) !== null && Number(f.volume_ratio) >= 1.5 },
  { key: 'trade_expansion', label_ar: 'تسارع عدد الصفقات', test: f => finite(f.trade_ratio) !== null && Number(f.trade_ratio) >= 1.25 },
  { key: 'buyer_flow', label_ar: 'ضغط المشترين', test: f => finite(f.taker_buy_ratio) !== null && Number(f.taker_buy_ratio) >= 0.52 },
  { key: 'price_structure', label_ar: 'قاع أعلى أو اختراق مغلق', test: f => f.higher_low === true || f.breakout_above_prior_high === true },
  { key: 'volatility_compression', label_ar: 'انكماش التذبذب', test: f => finite(f.compression_ratio) !== null && Number(f.compression_ratio) <= 0.8 },
  { key: 'relative_strength', label_ar: 'قوة نسبية مقابل BTC', test: f => finite(f.relative_strength_vs_btc_pct) !== null && Number(f.relative_strength_vs_btc_pct) >= 0.25 },
  { key: 'short_momentum', label_ar: 'زخم قصير غير ممتد', test: f => {
    const value = finite(f.recent_15m_return_pct) ?? finite(f.price_change_15m_pct);
    return value !== null && value >= 0 && value <= 1.5;
  }},
  { key: 'multi_hour_trend', label_ar: 'اتجاه متعدد الساعات', test: f => f.trend_aligned === true ||
    (finite(f.return_3h_pct) !== null && Number(f.return_3h_pct) > 0) },
  { key: 'five_minute_flow', label_ar: 'ضغط شراء على 5 دقائق', test: f => f.micro_5m_available === true &&
    finite(f.micro_5m_taker_buy_ratio) !== null && Number(f.micro_5m_taker_buy_ratio) >= 0.55 }
]);

const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const logit = p => Math.log(clamp(p, 0.001, 0.999) / (1 - clamp(p, 0.001, 0.999)));
const logistic = value => 1 / (1 + Math.exp(-clamp(value, -12, 12)));
const betaRate = (sum, count) => (sum + 2) / (count + 4);
const targetOf = row => row.outcome === 'UP' ? 1 : row.outcome === 'DOWN' ? 0 : 0.5;
// V5 estimates an upward opportunity; a neutral close is a non-success.
// The legacy/global learner retains its original soft three-way target.
const upEventTargetOf = row => row?.outcome === 'UP' ? 1 : 0;
const asUpEventRows = rows => (Array.isArray(rows)?rows:[]).map(row=>({...row,target:upEventTargetOf(row)}));

function factorValues(features = {}) {
  return Object.fromEntries(FACTORS.map(factor => [factor.key, Boolean(factor.test(features || {}))]));
}

function normalizedFeatures(features = {}) {
  const f = features || {};
  const volRaw = finite(f.volume_ratio);
  const tradeRaw = finite(f.trade_ratio);
  const buyerRaw = finite(f.taker_buy_ratio);
  const compressionRaw = finite(f.compression_ratio);
  const relativeRaw = finite(f.relative_strength_vs_btc_pct);
  const momentumRaw = finite(f.recent_15m_return_pct) ?? finite(f.price_change_15m_pct);
  const microRaw = finite(f.micro_5m_taker_buy_ratio);
  const closeRaw = finite(f.close_location);
  const rangeRaw = finite(f.current_range_pct);
  const wickRaw = finite(f.upper_wick_pct);

  const volume = volRaw === null ? 0 : clamp(Math.log(clamp(volRaw, 0.05, 20)) / Math.log(2), -2, 2);
  const trades = tradeRaw === null ? 0 : clamp(Math.log(clamp(tradeRaw, 0.05, 20)) / Math.log(2), -2, 2);
  const buyer = buyerRaw === null ? 0 : clamp((buyerRaw - 0.5) / 0.1, -2, 2);
  const structure = f.higher_low === true || f.breakout_above_prior_high === true ? 1 : 0;
  const compression = compressionRaw === null ? 0 : clamp((1 - compressionRaw) / 0.4, -2, 2);
  const relative = relativeRaw === null ? 0 : clamp(relativeRaw / 1.5, -2, 2);
  const momentum = momentumRaw === null ? 0 : clamp(momentumRaw / 1.5, -2, 2);
  const trend = f.trend_aligned === true || (finite(f.return_3h_pct) !== null && Number(f.return_3h_pct) > 0) ? 1 : 0;
  const micro = f.micro_5m_available === true && microRaw !== null
    ? clamp((microRaw - 0.5) / 0.1, -2, 2) : 0;
  const close = closeRaw === null ? 0 : clamp((closeRaw - 0.5) * 2, -1, 1);
  const wickRatio = wickRaw !== null && rangeRaw !== null && rangeRaw > 0 ? wickRaw / rangeRaw : null;
  const wickPenalty = wickRatio === null ? 0 : -clamp((wickRatio - 0.35) / 0.35, 0, 2);
  const coreConfluence = volRaw !== null && volRaw >= 1.5 && buyerRaw !== null && buyerRaw >= 0.52 && structure === 1 ? 1 : 0;

  return [
    volume,
    trades,
    buyer,
    structure,
    compression,
    relative,
    momentum,
    trend,
    micro,
    close,
    wickPenalty,
    volume * buyer,
    structure * buyer,
    relative * trend,
    compression * structure,
    volume * buyer * structure,
    trades * buyer,
    coreConfluence
  ];
}

function validResolvedSamples(samples, {
  outcomeHorizonMs = MIN_OUTCOME_HORIZON_MS,
  allowResolutionLag = false,
  allowedOutcomeSources = null
} = {}) {
  const horizonMs = Math.max(1, Math.trunc(Number(outcomeHorizonMs) || MIN_OUTCOME_HORIZON_MS));
  const allowedSources = Array.isArray(allowedOutcomeSources)
    ? new Set(allowedOutcomeSources.map(String)) : null;
  const seenIds = new Set();
  const seenBaselines = new Set();
  return (Array.isArray(samples) ? samples : [])
    .filter(row => {
      const radarOutcome = row?.radar_outcome_baseline === true;
      if (!row || row.training_eligible !== true ||
          (row.closed_candle_baseline !== true && row.historical_baseline !== true && !radarOutcome) ||
          !['UP', 'DOWN', 'FLAT'].includes(row.outcome) ||
          !row.features || typeof row.features !== 'object' || Array.isArray(row.features)) return false;
      const id = String(row.id || '');
      const symbol = String(row.symbol || '').trim().toUpperCase();
      const at = finite(row.at);
      const resolvedAt = finite(row.resolved_at);
      const horizon = finite(row.horizon_ms);
      const source = String(row.outcome_source || '');
      const expectedSource = row.historical_baseline === true
        ? 'HISTORICAL_CLOSED_CANDLE' : radarOutcome ? source : 'CLOSED_CANDLE_4H';
      const sourceValid = allowedSources ? allowedSources.has(source) : source === expectedSource;
      const resolvedAfterHorizon = resolvedAt !== null && at !== null &&
        (allowResolutionLag ? resolvedAt >= at + horizonMs : resolvedAt - at === horizonMs);
      if (!id || !symbol || at === null || at <= 0 ||
          resolvedAt === null || !resolvedAfterHorizon ||
          horizon !== horizonMs || !sourceValid ||
          (radarOutcome && !String(row.radar || '').trim())) return false;
      // Alerts from several radars can refer to the same pair/candle. Count the market event once.
      const baselineKey = symbol + ':' + String(Math.trunc(at));
      // A live observation and a later historical backfill can describe the
      // exact same pair/candle under different IDs. Count that market event once.
      if (seenIds.has(id) || seenBaselines.has(baselineKey)) return false;
      seenIds.add(id);
      seenBaselines.add(baselineKey);
      return true;
    })
    .map(row => ({
      ...row,
      at: Number(row.at),
      resolved_at: Number(row.resolved_at),
      target: targetOf(row),
      vector: normalizedFeatures(row.features)
    }))
    .sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
}

function fitLogisticModel(training, { l2 = 0.08, iterations = 900, learningRate = 0.12 } = {}) {
  const targets = training.map(row => row.target);
  const baseRate = betaRate(targets.reduce((sum, value) => sum + value, 0), targets.length);
  const weights = Array(FEATURE_NAMES.length).fill(0);
  let intercept = logit(baseRate);
  const n = Math.max(1, training.length);

  // Deterministic full-batch gradient descent: reproducible tests and no random seed.
  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradients = Array(FEATURE_NAMES.length).fill(0);
    let interceptGradient = 0;
    for (const row of training) {
      let linear = intercept;
      for (let i = 0; i < weights.length; i++) linear += weights[i] * row.vector[i];
      const error = logistic(linear) - row.target;
      interceptGradient += error;
      for (let i = 0; i < weights.length; i++) gradients[i] += error * row.vector[i];
    }
    intercept -= learningRate * interceptGradient / n;
    for (let i = 0; i < weights.length; i++) {
      const gradient = gradients[i] / n + l2 * weights[i];
      weights[i] = clamp(weights[i] - learningRate * gradient, -4, 4);
    }
  }
  return { intercept, weights, base_rate: baseRate, feature_names: [...FEATURE_NAMES], l2 };
}


// A bounded Newton-gradient boosted-tree challenger. Trees learn only residual
// interactions on top of a same-window logistic anchor; the anchor is never
// modified. The fixed depth/leaf/round budgets are intentionally conservative
// for the small, autocorrelated market sample sizes in Build 224.
function linearLogit(vector, fit) {
  let value=Number(fit?.intercept)||0;
  for(let index=0;index<vector.length;index++) value+=
    vector[index]*(Number(fit?.weights?.[index])||0);
  return clamp(value,-12,12);
}

function residualTreeValue(node, vector) {
  if(!node||typeof node!=='object')return 0;
  if(node.type==='leaf')return Number(node.value)||0;
  const feature=Number(node.feature);
  return vector[feature]<=Number(node.threshold)
    ?residualTreeValue(node.left,vector)
    :residualTreeValue(node.right,vector);
}

function bestResidualTreeSplit(indices, rows, gradients, hessians, {
  minimumLeaf=12,l2=8,minGain=0.002
}={}) {
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
        best={
          feature,threshold:current.value+(nextValue-current.value)/2,
          gain
        };
      }
    }
  }
  return best;
}

function buildResidualTreeNode(indices, depth, rows, gradients, hessians, options) {
  let gradient=0,hessian=0;
  for(const index of indices){gradient+=gradients[index];hessian+=hessians[index];}
  const leafValue=clamp(-gradient/(hessian+options.l2),-0.65,0.65);
  if(depth>=options.maxDepth||indices.length<options.minimumLeaf*2){
    return {type:'leaf',value:leafValue};
  }
  const split=bestResidualTreeSplit(indices,rows,gradients,hessians,options);
  if(!split)return {type:'leaf',value:leafValue};
  const left=[],right=[];
  for(const index of indices){
    (rows[index].vector[split.feature]<=split.threshold?left:right).push(index);
  }
  if(left.length<options.minimumLeaf||right.length<options.minimumLeaf){
    return {type:'leaf',value:leafValue};
  }
  return {
    type:'split',feature:split.feature,threshold:split.threshold,
    left:buildResidualTreeNode(left,depth+1,rows,gradients,hessians,options),
    right:buildResidualTreeNode(right,depth+1,rows,gradients,hessians,options)
  };
}

function fitResidualBoostedTrees(training, baselineFit, {
  maxTrees=36,maxDepth=3,learningRate=0.035,l2=12,
  minimumLeafFraction=0.035,residualScale=0.65
}={}) {
  const rows=(Array.isArray(training)?training:[]).filter(row=>
    Array.isArray(row?.vector)&&row.vector.length===FEATURE_NAMES.length&&
    row.vector.every(Number.isFinite)&&Number.isFinite(Number(row.target)));
  if(rows.length<200||!baselineFit||!Array.isArray(baselineFit.weights)||
     baselineFit.weights.length!==FEATURE_NAMES.length)return null;
  const options={
    maxDepth:Math.max(1,Math.min(3,Math.trunc(maxDepth)||3)),
    minimumLeaf:Math.max(12,Math.min(80,Math.floor(rows.length*minimumLeafFraction))),
    l2:clamp(Number(l2)||12,2,30),minGain:0.002
  };
  const rate=clamp(Number(learningRate)||0.035,0.01,0.08);
  const logits=rows.map(row=>linearLogit(row.vector,baselineFit));
  const trees=[];
  const rounds=Math.max(8,Math.min(48,Math.trunc(maxTrees)||36));
  for(let round=0;round<rounds;round++){
    const gradients=new Array(rows.length),hessians=new Array(rows.length);
    for(let index=0;index<rows.length;index++){
      const probability=logistic(logits[index]);
      gradients[index]=probability-Number(rows[index].target);
      hessians[index]=Math.max(0.025,probability*(1-probability));
    }
    const root=buildResidualTreeNode(
      rows.map((_,index)=>index),0,rows,gradients,hessians,options
    );
    if(root.type==='leaf')break;
    const tree={root};
    let changed=false;
    for(let index=0;index<rows.length;index++){
      const correction=rate*residualTreeValue(root,rows[index].vector);
      logits[index]=clamp(logits[index]+correction,-12,12);
      if(Math.abs(correction)>1e-9)changed=true;
    }
    if(!changed)break;
    trees.push(tree);
  }
  if(!trees.length)return null;
  return {
    kind:'RESIDUAL_GBDT_LOGISTIC_ANCHOR_V1',
    architecture:'NEWTON_GBDT_DEPTH3_SHRUNK_36_ROUNDS',
    baseline_fit:baselineFit,trees,tree_count:trees.length,
    learning_rate:rate,residual_scale:clamp(Number(residualScale)||0,0,1),
    max_depth:options.maxDepth,minimum_leaf_samples:options.minimumLeaf,
    l2:options.l2,base_rate:baselineFit.base_rate,
    training_samples:rows.length,
    training_strategy:'SAME_WINDOW_LOGISTIC_ANCHORED_NEWTON_GRADIENT_BOOSTING_V1'
  };
}

function predictResidualBoostedTrees(features, fit) {
  if(!fit||fit.kind!=='RESIDUAL_GBDT_LOGISTIC_ANCHOR_V1'||
     !Array.isArray(fit.trees)||!fit.trees.length)return null;
  const vector=normalizedFeatures(features);
  let value=linearLogit(vector,fit.baseline_fit);
  let residual=0;
  for(const tree of fit.trees)residual+=
    Number(fit.learning_rate)*residualTreeValue(tree.root,vector);
  value=clamp(value+clamp(Number(fit.residual_scale)||0,0,1)*residual,-12,12);
  return clamp(logistic(value),0.02,0.98);
}

function fitNeuralNetworkModel(training, {
  hiddenUnits = NEURAL_POLICY.hiddenUnits,
  secondHiddenUnits = NEURAL_POLICY.secondHiddenUnits,
  iterations = NEURAL_POLICY.iterations,
  learningRate = NEURAL_POLICY.learningRate,
  l2 = NEURAL_POLICY.l2,
  seed = 1,
  baselineFit = null,
  trainingObjective = 'UNWEIGHTED_BRIER_PROPER_SCORING_RULE'
} = {}) {
  const rows=(Array.isArray(training)?training:[]).map(row=>({
    vector:Array.isArray(row?.vector)&&row.vector.length===FEATURE_NAMES.length
      ?row.vector:normalizedFeatures(row?.features||{}),
    target:finite(row?.target)===null?targetOf(row):clamp(Number(row.target),0,1)
  })).filter(row=>row.vector.length===FEATURE_NAMES.length&&
    row.vector.every(value=>Number.isFinite(value))&&Number.isFinite(row.target));
  if(!rows.length)return null;

  const inputSize=FEATURE_NAMES.length;
  const units1=Math.max(4,Math.min(16,Math.trunc(Number(hiddenUnits)||NEURAL_POLICY.hiddenUnits)));
  const units2=Math.max(3,Math.min(12,Math.trunc(Number(secondHiddenUnits)||NEURAL_POLICY.secondHiddenUnits)));
  const steps=Math.max(30,Math.min(180,Math.trunc(Number(iterations)||NEURAL_POLICY.iterations)));
  const rate=clamp(Number(learningRate)||NEURAL_POLICY.learningRate,0.001,0.04);
  const regularization=clamp(Number(l2)||NEURAL_POLICY.l2,0.001,0.5);
  const baseRate=betaRate(rows.reduce((sum,row)=>sum+row.target,0),rows.length);
  const seedValue=Math.max(1,Math.min(997,Math.trunc(Number(seed)||1)));
  const seedOffset=seedValue*0.6180339887498949;

  // Each member gets a distinct deterministic initialization. This reduces
  // sensitivity to one lucky or unlucky weight seed without using validation
  // or holdout labels to train any member.
  const inputWeights=Array.from({length:inputSize},(_,i)=>
    Array.from({length:units1},(_,j)=>0.07*Math.sin((i+1)*12.9898+(j+1)*78.233+seedOffset)));
  const hiddenBias1=Array.from({length:units1},(_,j)=>0.008*Math.cos((j+1)*9.173+seedOffset));
  const hiddenWeights=Array.from({length:units1},(_,i)=>
    Array.from({length:units2},(_,j)=>0.07*Math.cos((i+1)*5.173+(j+1)*3.117+seedOffset)));
  const hiddenBias2=Array.from({length:units2},(_,j)=>0.008*Math.sin((j+1)*7.913+seedOffset));
  // Start the neural challenger at the same-window logistic model, then
  // learn nonlinear residuals. This prevents random initialization from
  // discarding reliable linear market evidence before the first gradient step.
  // The baseline is fitted on training rows only; validation and holdout labels
  // never enter initialization.
  const hasBaseline=baselineFit&&Array.isArray(baselineFit.weights)&&
    baselineFit.weights.length===inputSize&&Number.isFinite(Number(baselineFit.intercept));
  // Do not zero-initialize the residual output head: doing so makes the
  // first epoch train only the head while every hidden layer receives zero
  // gradient. A small deterministic seed-shaped head starts end-to-end
  // backpropagation on epoch one while the frozen logistic skip path remains intact.
  const outputWeights=Array.from({length:units2},(_,j)=>
    0.015*Math.sin((j+1)*4.73+seedOffset));
  const skipWeights=hasBaseline
    ?baselineFit.weights.map(value=>clamp(Number(value)||0,-4,4))
    :Array(inputSize).fill(0);
  let outputBias=hasBaseline?Number(baselineFit.intercept):logit(baseRate);

  const zerosLike=values=>Array.isArray(values)
    ?values.map(value=>Array.isArray(value)?zerosLike(value):0):0;
  const mInput=zerosLike(inputWeights),vInput=zerosLike(inputWeights);
  const mHidden=zerosLike(hiddenWeights),vHidden=zerosLike(hiddenWeights);
  const mBias1=zerosLike(hiddenBias1),vBias1=zerosLike(hiddenBias1);
  const mBias2=zerosLike(hiddenBias2),vBias2=zerosLike(hiddenBias2);
  const mOutput=zerosLike(outputWeights),vOutput=zerosLike(outputWeights);
  const mSkip=zerosLike(skipWeights),vSkip=zerosLike(skipWeights);
  let mOutputBias=0,vOutputBias=0;

  const update=(value,gradient,moment,variance,step,bound=3,decay=true)=>{
    const g=clamp(gradient,-3,3);
    const nextMoment=0.9*moment+0.1*g;
    const nextVariance=0.999*variance+0.001*g*g;
    const correctedMoment=nextMoment/(1-Math.pow(0.9,step));
    const correctedVariance=nextVariance/(1-Math.pow(0.999,step));
    const regularized=decay?regularization*value:0;
    return {
      value:clamp(value-rate*(correctedMoment/(Math.sqrt(correctedVariance)+1e-8)+regularized),-bound,bound),
      moment:nextMoment,variance:nextVariance
    };
  };

  for(let epoch=1;epoch<=steps;epoch++){
    const gradInput=zerosLike(inputWeights),gradHidden=zerosLike(hiddenWeights);
    const gradBias1=Array(units1).fill(0),gradBias2=Array(units2).fill(0);
    const gradOutput=Array(units2).fill(0);

    for(const row of rows){
      const hidden1=new Array(units1);
      for(let j=0;j<units1;j++){
        let sum=hiddenBias1[j];
        for(let i=0;i<inputSize;i++)sum+=row.vector[i]*inputWeights[i][j];
        hidden1[j]=Math.tanh(sum);
      }
      const hidden2=new Array(units2);
      for(let j=0;j<units2;j++){
        let sum=hiddenBias2[j];
        for(let i=0;i<units1;i++)sum+=hidden1[i]*hiddenWeights[i][j];
        hidden2[j]=Math.tanh(sum);
      }
      let output=outputBias;
      for(let j=0;j<units2;j++)output+=outputWeights[j]*hidden2[j];
      // Residual linear path preserves reliable first-order evidence while the
      // two nonlinear layers learn interactions between market conditions.
      for(let i=0;i<inputSize;i++)output+=skipWeights[i]*row.vector[i];
      const probability=logistic(output);
      // Optimize the same unweighted Brier proper-scoring objective used by
      // chronological validation, model selection, and the untouched holdout.
      const brierGradient=2*(probability-row.target)*probability*(1-probability);
      const logLossGradient=probability-row.target;
      const error=trainingObjective==='UNWEIGHTED_LOG_LOSS_PROPER_SCORING_RULE'
        ?logLossGradient
        :trainingObjective==='MIXED_BRIER_LOG_LOSS_50_50_PROPER_SCORING_RULE'
          ?0.5*brierGradient+0.5*logLossGradient
          :brierGradient;
      // The same-window logistic path is a frozen anchor. Only the hidden
      // nonlinear branch is trained, so a weak residual cannot erase the
      // simpler model that already supplied the initial prediction.
      const hidden2Error=new Array(units2);
      for(let j=0;j<units2;j++){
        gradOutput[j]+=error*hidden2[j];
        hidden2Error[j]=error*outputWeights[j]*(1-hidden2[j]*hidden2[j]);
        gradBias2[j]+=hidden2Error[j];
        for(let i=0;i<units1;i++)gradHidden[i][j]+=hidden1[i]*hidden2Error[j];
      }
      for(let i=0;i<units1;i++){
        let error1=0;
        for(let j=0;j<units2;j++)error1+=hidden2Error[j]*hiddenWeights[i][j];
        error1*=1-hidden1[i]*hidden1[i];
        gradBias1[i]+=error1;
        for(let j=0;j<inputSize;j++)gradInput[j][i]+=row.vector[j]*error1;
      }
    }

    const n=rows.length;
    for(let i=0;i<inputSize;i++)for(let j=0;j<units1;j++){
      const result=update(inputWeights[i][j],gradInput[i][j]/n,mInput[i][j],vInput[i][j],epoch);
      inputWeights[i][j]=result.value;mInput[i][j]=result.moment;vInput[i][j]=result.variance;
    }
    for(let i=0;i<units1;i++)for(let j=0;j<units2;j++){
      const result=update(hiddenWeights[i][j],gradHidden[i][j]/n,mHidden[i][j],vHidden[i][j],epoch);
      hiddenWeights[i][j]=result.value;mHidden[i][j]=result.moment;vHidden[i][j]=result.variance;
    }
    for(let j=0;j<units1;j++){
      const result=update(hiddenBias1[j],gradBias1[j]/n,mBias1[j],vBias1[j],epoch,4,false);
      hiddenBias1[j]=result.value;mBias1[j]=result.moment;vBias1[j]=result.variance;
    }
    for(let j=0;j<units2;j++){
      const bias=update(hiddenBias2[j],gradBias2[j]/n,mBias2[j],vBias2[j],epoch,4,false);
      hiddenBias2[j]=bias.value;mBias2[j]=bias.moment;vBias2[j]=bias.variance;
      const output=update(outputWeights[j],gradOutput[j]/n,mOutput[j],vOutput[j],epoch);
      outputWeights[j]=output.value;mOutput[j]=output.moment;vOutput[j]=output.variance;
    }
    // Keep skipWeights and outputBias frozen at the training-only logistic
    // anchor. The nonlinear residual may add information but cannot rewrite it.
  }

  return {
    kind:'RESIDUAL_DEEP_MLP_V2',
    architecture:inputSize+'-'+units1+'-'+units2+'-1+RESIDUAL',
    input_size:inputSize,hidden_units:units1,second_hidden_units:units2,output_size:1,
    input_weights:inputWeights,hidden_bias_1:hiddenBias1,
    hidden_weights:hiddenWeights,hidden_bias_2:hiddenBias2,
    output_weights:outputWeights,output_bias:outputBias,skip_weights:skipWeights,
    base_rate:baseRate,feature_names:[...FEATURE_NAMES],
    training_samples:rows.length,iterations:steps,l2:regularization,
    training_objective:trainingObjective,
    residual_anchor:hasBaseline?'SAME_WINDOW_LOGISTIC_FROZEN':'TRAINING_PREVALENCE_PRIOR'
  };
}

function fitNeuralEnsemble(training, options = {}) {
  const seeds=NEURAL_POLICY.ensembleSeeds;
  const baseIterations=Math.max(30,Math.min(180,Math.trunc(Number(options.iterations)||NEURAL_POLICY.iterations)));
  const baseLearningRate=clamp(Number(options.learningRate)||NEURAL_POLICY.learningRate,0.001,0.04);
  const baseL2=clamp(Number(options.l2)||NEURAL_POLICY.l2,0.001,0.5);
  // Keep total optimization work equal to three base schedules while reducing
  // dependence on one epoch/regularization choice. Selection remains on the
  // chronological validation block; the untouched holdout is never consulted.
  const memberProfiles=[
    {iterations:Math.max(30,Math.ceil(baseIterations*0.6)),learningRate:baseLearningRate*0.9,l2:baseL2*1.5,
      trainingObjective:'UNWEIGHTED_BRIER_PROPER_SCORING_RULE'},
    {iterations:baseIterations,learningRate:baseLearningRate,l2:baseL2,
      trainingObjective:'UNWEIGHTED_LOG_LOSS_PROPER_SCORING_RULE'},
    {iterations:Math.min(180,Math.ceil(baseIterations*1.4)),learningRate:baseLearningRate*0.75,l2:baseL2*2,
      trainingObjective:'MIXED_BRIER_LOG_LOSS_50_50_PROPER_SCORING_RULE'}
  ];
  const members=seeds.map((seed,index)=>fitNeuralNetworkModel(training,{
    ...options,...memberProfiles[index],seed
  }));
  if(members.length!==seeds.length||members.some(member=>!member))return null;
  return {
    kind:'RESIDUAL_DEEP_MLP_ENSEMBLE_V3',
    architecture:members[0].architecture,
    input_size:FEATURE_NAMES.length,
    hidden_units:NEURAL_POLICY.hiddenUnits,
    second_hidden_units:NEURAL_POLICY.secondHiddenUnits,
    output_size:1,
    members,
    ensemble_members:members.length,
    seeds:[...seeds],
    member_training_profiles:memberProfiles,
    training_strategy:'PROPER_LOSS_ENSEMBLE_RESIDUAL_MLP_VALIDATION_SHRUNK_V6',
    training_objective:'MIXED_PROPER_SCORING_RULE_ENSEMBLE_BRIER_LOG_LOSS_V6',
    member_training_objectives:memberProfiles.map(profile=>profile.trainingObjective),
    residual_scale_selection:'CHRONOLOGICAL_VALIDATION_BLOCK_BRIER_GRID_V1',
    candidate_residual_scales:[...NEURAL_RESIDUAL_SCALES],
    base_rate:mean(members.map(member=>member.base_rate)),
    feature_names:[...FEATURE_NAMES],
    training_samples:members[0].training_samples,
    iterations:baseIterations,
    l2:baseL2
  };
}

function predictFromFit(features, fit, residualScale=1) {
  if(fit?.kind==='RESIDUAL_GBDT_LOGISTIC_ANCHOR_V1'){
    return predictResidualBoostedTrees(features,fit);
  }
  if(fit?.kind==='BLENDED_GBDT_MLP_V1'){
    const boosted=predictFromFit(features,fit.boosted_fit);
    const neural=predictFromFit(features,fit.neural_fit);
    if(!Number.isFinite(boosted)||!Number.isFinite(neural))return null;
    const weight=clamp(Number(fit.boosted_weight)||0,0,1);
    return clamp(weight*boosted+(1-weight)*neural,0.02,0.98);
  }
  if(fit?.kind==='RESIDUAL_DEEP_MLP_ENSEMBLE_V3'){
    if(!Array.isArray(fit.members)||fit.members.length!==NEURAL_POLICY.ensembleSeeds.length)return null;
    const selected=Number(fit.selected_member_index);
    let rawPrediction;
    if(Number.isInteger(selected)&&selected>=0&&selected<fit.members.length){
      rawPrediction=predictFromFit(features,fit.members[selected],finite(fit.selected_residual_scale)??1);
    }else{
      const predictions=fit.members.map(member=>predictFromFit(features,member));
      if(predictions.some(value=>!Number.isFinite(value)))return null;
      rawPrediction=mean(predictions);
    }
    const calibration=fit.probability_calibrator;
    if(calibration?.accepted!==true||!Number.isFinite(rawPrediction))return clamp(rawPrediction,0.02,0.98);
    const raw=clamp(rawPrediction,0.02,0.98);
    const calibratedLogit=clamp(Number(calibration.slope)||1,0.5,1.5)*
      Math.log(raw/(1-raw))+clamp(Number(calibration.intercept)||0,-0.75,0.75);
    return clamp(logistic(calibratedLogit),0.02,0.98);
  }
  if(fit?.kind==='RESIDUAL_DEEP_MLP_V2'){
    if(!Array.isArray(fit.input_weights)||fit.input_weights.length!==FEATURE_NAMES.length||
       !Array.isArray(fit.hidden_bias_1)||!Array.isArray(fit.hidden_weights)||
       !Array.isArray(fit.hidden_bias_2)||!Array.isArray(fit.output_weights)||
       !Array.isArray(fit.skip_weights)||fit.input_weights.some(row=>!Array.isArray(row))||
       fit.hidden_weights.length!==fit.hidden_bias_1.length||
       fit.hidden_bias_2.length!==fit.output_weights.length||
       fit.skip_weights.length!==FEATURE_NAMES.length)return null;
    const vector=normalizedFeatures(features);
    const hidden1=fit.hidden_bias_1.map((bias,j)=>{
      let sum=Number(bias)||0;
      for(let i=0;i<vector.length;i++)sum+=vector[i]*(Number(fit.input_weights[i]?.[j])||0);
      return Math.tanh(sum);
    });
    const hidden2=fit.hidden_bias_2.map((bias,j)=>{
      let sum=Number(bias)||0;
      for(let i=0;i<hidden1.length;i++)sum+=hidden1[i]*(Number(fit.hidden_weights[i]?.[j])||0);
      return Math.tanh(sum);
    });
    let output=Number(fit.output_bias)||0;
    const scale=clamp(finite(fit.residual_scale)??finite(residualScale)??1,0,1);
    for(let j=0;j<hidden2.length;j++)output+=scale*(Number(fit.output_weights[j])||0)*hidden2[j];
    for(let i=0;i<vector.length;i++)output+=vector[i]*(Number(fit.skip_weights[i])||0);
    return clamp(logistic(output),0.02,0.98);
  }
  if(fit?.kind==='NEURAL_MLP_V1'){
    if(!Array.isArray(fit.input_weights)||fit.input_weights.length!==FEATURE_NAMES.length||
       !Array.isArray(fit.hidden_bias)||!Array.isArray(fit.output_weights)||
       fit.hidden_bias.length!==fit.output_weights.length)return null;
    const vector=normalizedFeatures(features);
    const hidden=fit.hidden_bias.map((bias,j)=>{
      let sum=Number(bias)||0;
      for(let i=0;i<vector.length;i++)sum+=vector[i]*(Number(fit.input_weights[i]?.[j])||0);
      return Math.tanh(sum);
    });
    let output=Number(fit.output_bias)||0;
    for(let j=0;j<hidden.length;j++)output+=(Number(fit.output_weights[j])||0)*hidden[j];
    return clamp(logistic(output),0.02,0.98);
  }
  if (!fit || !Array.isArray(fit.weights) || fit.weights.length !== FEATURE_NAMES.length) return null;
  const vector = normalizedFeatures(features);
  let value = Number(fit.intercept) || 0;
  for (let i = 0; i < fit.weights.length; i++) value += Number(fit.weights[i] || 0) * vector[i];
  return clamp(logistic(value), 0.02, 0.98);
}


function fitAndSelectNeuralProbabilityCalibrator(fitRows,checkRows,fit,{
  minimumFitSamples=30,minimumFitPositive=6,minimumFitNegative=6,
  minimumCheckSamples=20,minimumCheckPositive=3,minimumCheckNegative=3,
  iterations=260,learningRate=0.035,regularization=0.55,
  improvementMargin=0.00025
}={}){
  const makePredictions=(rows)=> (Array.isArray(rows)?rows:[]).map(row=>({
    probability:predictFromFit(row.features,fit),target:row.target
  })).filter(row=>Number.isFinite(row.probability)&&Number.isFinite(row.target));
  const fitPredictions=makePredictions(fitRows);
  const fitPositive=fitPredictions.filter(row=>row.target>0.5).length;
  const fitNegative=fitPredictions.filter(row=>row.target<0.5).length;
  const base={
    method:'DISJOINT_BRIER_PLATT_NEURAL_CALIBRATION_V1',
    fit_on:'LATE_CHRONOLOGICAL_CALIBRATION_FIT_BLOCK',
    check_on:'LATER_DISJOINT_CALIBRATION_CHECK_BLOCK',
    fit_samples:fitPredictions.length,fit_positive:fitPositive,fit_negative:fitNegative,
    check_samples:0,check_positive:0,check_negative:0,
    slope:1,intercept:0,fitted:false,accepted:false,
    raw_check_brier:null,calibrated_check_brier:null,improvement:null
  };
  if(fitPredictions.length<minimumFitSamples||fitPositive<minimumFitPositive||
     fitNegative<minimumFitNegative){
    return {...base,reason:'CALIBRATION_FIT_BLOCK_CLASS_SUPPORT_BELOW_MINIMUM'};
  }
  const points=fitPredictions.map(row=>{
    const probability=clamp(row.probability,0.02,0.98);
    return {x:Math.log(probability/(1-probability)),target:row.target};
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
  const checkPredictions=makePredictions(checkRows);
  const checkPositive=checkPredictions.filter(row=>row.target>0.5).length;
  const checkNegative=checkPredictions.filter(row=>row.target<0.5).length;
  const checkBase={
    ...base,fit_samples:fitPredictions.length,fit_positive:fitPositive,fit_negative:fitNegative,
    check_samples:checkPredictions.length,check_positive:checkPositive,check_negative:checkNegative,
    slope:Number(slope.toFixed(5)),intercept:Number(intercept.toFixed(5)),fitted:true
  };
  if(checkPredictions.length<minimumCheckSamples||checkPositive<minimumCheckPositive||
     checkNegative<minimumCheckNegative){
    return {...checkBase,reason:'CALIBRATION_CHECK_BLOCK_CLASS_SUPPORT_BELOW_MINIMUM'};
  }
  const rawBrier=mean(checkPredictions.map(row=>(row.probability-row.target)**2));
  const calibratedBrier=mean(checkPredictions.map(row=>{
    const raw=clamp(row.probability,0.02,0.98);
    const adjusted=logistic(slope*Math.log(raw/(1-raw))+intercept);
    return (adjusted-row.target)**2;
  }));
  const improvement=rawBrier-calibratedBrier;
  const accepted=improvement>improvementMargin;
  return {
    ...checkBase,accepted,raw_check_brier:Number(rawBrier.toFixed(5)),
    calibrated_check_brier:Number(calibratedBrier.toFixed(5)),
    improvement:Number(improvement.toFixed(5)),
    reason:accepted?null:'CALIBRATION_DID_NOT_IMPROVE_DISJOINT_CHECK_BLOCK'
  };
}

function factorEvidence(training, { minimumBucket = 8 } = {}) {
  const output = {};
  let covered = 0;
  const availability = {
    volume_expansion: f => finite(f.volume_ratio) !== null,
    trade_expansion: f => finite(f.trade_ratio) !== null,
    buyer_flow: f => finite(f.taker_buy_ratio) !== null,
    price_structure: f => f.higher_low !== null && f.higher_low !== undefined ||
      f.breakout_above_prior_high !== null && f.breakout_above_prior_high !== undefined,
    volatility_compression: f => finite(f.compression_ratio) !== null,
    relative_strength: f => finite(f.relative_strength_vs_btc_pct) !== null,
    short_momentum: f => finite(f.recent_15m_return_pct) !== null || finite(f.price_change_15m_pct) !== null,
    multi_hour_trend: f => f.trend_aligned !== null && f.trend_aligned !== undefined || finite(f.return_3h_pct) !== null,
    five_minute_flow: f => f.micro_5m_available === true && finite(f.micro_5m_taker_buy_ratio) !== null
  };
  for (const factor of FACTORS) {
    const available = training.filter(row => availability[factor.key]?.(row.features || {}) === true);
    const active = available.filter(row => factor.test(row.features || {}));
    const inactive = available.filter(row => !factor.test(row.features || {}));
    const activeMean = active.length ? mean(active.map(row => row.target)) : null;
    const inactiveMean = inactive.length ? mean(inactive.map(row => row.target)) : null;
    const ready = active.length >= minimumBucket && inactive.length >= minimumBucket;
    if (ready) covered++;
    output[factor.key] = {
      label_ar: factor.label_ar,
      present_samples: active.length,
      absent_samples: inactive.length,
      present_up_rate_pct: activeMean === null ? null : Number((activeMean * 100).toFixed(1)),
      absent_up_rate_pct: inactiveMean === null ? null : Number((inactiveMean * 100).toFixed(1)),
      lift_percentage_points: activeMean === null || inactiveMean === null
        ? null : Number(((activeMean - inactiveMean) * 100).toFixed(1)),
      evidence_ready: ready
    };
  }
  return { factors: output, covered_factor_buckets: covered };
}

function evaluateHoldout(rows, fit) {
  if (rows.length < 20) return {
    sample_count: rows.length, evaluated: false, model_brier_score: null,
    base_rate_brier_score: null, log_loss: null, accuracy_directional_pct: null,
    expected_calibration_error: null, beat_base_rate: false,
    reason: 'HOLDOUT_REQUIRES_20_OUTCOMES'
  };
  const base = fit.base_rate;
  const predictions = rows.map(row => predictFromFit(row.features, fit));
  const targets = rows.map(row => row.target);
  const modelBrier = mean(predictions.map((p, index) => (p - targets[index]) ** 2));
  const baselineBrier = mean(targets.map(target => (base - target) ** 2));
  const logLoss = mean(predictions.map((p, index) => {
    const probability = clamp(p, 0.001, 0.999);
    const target = targets[index];
    return -(target * Math.log(probability) + (1 - target) * Math.log(1 - probability));
  }));
  let directionalCorrect = 0, directionalCount = 0;
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].outcome === 'FLAT') continue;
    directionalCount++;
    if ((predictions[index] >= 0.5) === (rows[index].outcome === 'UP')) directionalCorrect++;
  }
  let calibrationError = 0;
  const bins = Array.from({ length: 10 }, () => ({ count: 0, predicted: 0, observed: 0 }));
  for (let index = 0; index < rows.length; index++) {
    const bin = bins[Math.min(9, Math.floor(predictions[index] * 10))];
    bin.count++;
    bin.predicted += predictions[index];
    bin.observed += targets[index];
  }
  for (const bin of bins) {
    if (!bin.count) continue;
    calibrationError += (bin.count / rows.length) *
      Math.abs(bin.predicted / bin.count - bin.observed / bin.count);
  }
  return {
    sample_count: rows.length,
    evaluated: true,
    model_brier_score: Number(modelBrier.toFixed(5)),
    base_rate_brier_score: Number(baselineBrier.toFixed(5)),
    log_loss: Number(logLoss.toFixed(5)),
    accuracy_directional_pct: directionalCount
      ? Number((directionalCorrect / directionalCount * 100).toFixed(1)) : null,
    expected_calibration_error: Number(calibrationError.toFixed(5)),
    beat_base_rate: modelBrier + 0.002 < baselineBrier,
    improvement_vs_base_rate: Number((baselineBrier - modelBrier).toFixed(5))
  };
}

/**
 * Uses three chronological blocks. The middle block chooses between the
 * all-history model and a recent-window challenger; the final block is never
 * used for model selection. Labels whose four-hour outcome crosses either
 * boundary are purged from the earlier block.
 */
export function buildCognitiveLearningProfile(samples = [], {
  minTrainingSamples = 60, minimumBucket = 8,
  minimumValidationSamples = 20, minimumHoldoutSamples = 20,
  validationFraction = 0.2, holdoutFraction = 0.2,
  recentWindowFraction = 0.6, recentSelectionMargin = 0.005, l2 = 0.08,
  outcomeHorizonMs = MIN_OUTCOME_HORIZON_MS,
  allowResolutionLag = false,
  allowedOutcomeSources = null,
  iterations = 900, learningRate = 0.12,
  minNeuralTrainingSamples = NEURAL_POLICY.minTrainingSamples,
  maxNeuralTrainingSamples = NEURAL_POLICY.maxTrainingSamples,
  temporalSamples = samples,
  neuralIterations = NEURAL_POLICY.iterations,
  neuralLearningRate = NEURAL_POLICY.learningRate,
  neuralL2 = NEURAL_POLICY.l2,
  neuralSelectionMargin = NEURAL_POLICY.selectionMargin,
  maxResolvedSamples = 0
} = {}) {
  const horizonMs=Math.max(1,Math.trunc(Number(outcomeHorizonMs)||MIN_OUTCOME_HORIZON_MS));
  const temporalNetwork=buildTemporalNeuralProfile(temporalSamples);
  const allResolved = validResolvedSamples(samples, {
    outcomeHorizonMs, allowResolutionLag, allowedOutcomeSources
  });
  const maxSamples = Math.max(0, Math.trunc(Number(maxResolvedSamples) || 0));
  const resolved = maxSamples > 0 ? allResolved.slice(-maxSamples) : allResolved;
  const uniqueTimes = [...new Set(resolved.map(row => row.at))].sort((a, b) => a - b);
  const rowsByTime=new Map();
  for(const row of resolved){
    if(!rowsByTime.has(row.at))rowsByTime.set(row.at,[]);
    rowsByTime.get(row.at).push(row);
  }
  const holdoutTargetSamples=Math.max(minimumHoldoutSamples,
    Math.min(100,Math.floor(resolved.length*holdoutFraction)));
  let holdoutCount=0,holdoutRows=0;
  for(let index=uniqueTimes.length-1;index>=0&&holdoutRows<holdoutTargetSamples;index--){
    holdoutCount++;
    holdoutRows+=(rowsByTime.get(uniqueTimes[index])||[]).length;
  }
  holdoutCount=Math.max(2,holdoutCount);
  // Keep the validation block at its existing chronological fraction; reduce only
  // excess holdout timestamps after preserving the 100-observation untouched live gate.
  const validationCount = Math.max(minimumValidationSamples, Math.floor(uniqueTimes.length * validationFraction));
  const trainingEndIndex = uniqueTimes.length - holdoutCount - validationCount;
  const canSplit = uniqueTimes.length >= 3 && trainingEndIndex > 0;

  if (!canSplit) {
    const fit = fitLogisticModel(resolved, { l2, iterations, learningRate });
    const evidence = factorEvidence(resolved, { minimumBucket });
    return {
      method: 'NESTED_PURGED_WALK_FORWARD_RESIDUAL_NEURAL_MODEL_V5',
      outcome_horizon_ms: horizonMs,
      ranking_ready: false, probability_ready: false, ready: false,
      resolved_samples: resolved.length, training_samples: resolved.length,
      fit_samples: resolved.length, validation_samples: 0, holdout_samples: 0,
      purged_overlap_samples: 0, validation_purged_samples: 0,
      required_training_samples: minTrainingSamples,
      required_validation_samples: minimumValidationSamples,
      required_holdout_samples: minimumHoldoutSamples,
      required_factor_buckets: 4, covered_factor_buckets: evidence.covered_factor_buckets,
      validation_start_at: null, holdout_start_at: null,
      max_training_outcome_resolved_at: resolved.length
        ? Math.max(...resolved.map(row => row.resolved_at)) : null,
      outcome_counts: {
        up: resolved.filter(row => row.outcome === 'UP').length,
        down: resolved.filter(row => row.outcome === 'DOWN').length,
        flat: resolved.filter(row => row.outcome === 'FLAT').length
      },
      training_positive_rate_pct: Number((fit.base_rate * 100).toFixed(1)),
      validation: { evaluated: false, reason: 'THREE_CHRONOLOGICAL_BLOCKS_REQUIRED' },
      holdout: { evaluated: false, reason: 'THREE_CHRONOLOGICAL_BLOCKS_REQUIRED' },
      model_selection: {
        selected_model: 'NONE',
        reason: 'INSUFFICIENT_CHRONOLOGICAL_DATA',
        global_validation_brier_score: null,
        recent_validation_brier_score: null
      },
      regime_adaptation: { status: 'INSUFFICIENT_DATA', recent_window_samples: 0 },
      factor_evidence: evidence.factors,
      neural_network: {
        status: resolved.length >= minNeuralTrainingSamples ? 'WAITING_FOR_CHRONOLOGICAL_SPLIT' : 'WAITING_FOR_MATURED_OUTCOMES',
        architecture: FEATURE_NAMES.length+'-'+NEURAL_POLICY.hiddenUnits+'-'+NEURAL_POLICY.secondHiddenUnits+'-1+RESIDUAL',
        input_neurons: FEATURE_NAMES.length, hidden_neurons: NEURAL_POLICY.hiddenUnits,
        second_hidden_neurons:NEURAL_POLICY.secondHiddenUnits,output_neurons: 1,
        samples_required:NEURAL_POLICY.minTrainingSamples,training_samples: 0, trained: false, selected: false,
        probability_ready: false, live_eligibility_ready:false, iterations: neuralIterations,
        model_kind:'RESIDUAL_DEEP_MLP_ENSEMBLE_V3',
        training_strategy:'UP_EVENT_BINARY_PROPER_LOSS_RESIDUAL_MLP_V6',
        training_objective:'MIXED_PROPER_SCORING_RULE_ENSEMBLE_BRIER_LOG_LOSS_V6',
        target_definition:'UP_CLOSE_RETURN_BINARY_V1',
        residual_scale_selection:'DISJOINT_CHRONOLOGICAL_SELECTION_BLOCK_BRIER_GRID_V1',
        candidate_residual_scales:[...NEURAL_RESIDUAL_SCALES],
        selection_samples:0,selection_start_at:null,max_training_outcome_resolved_at:null,
        max_selection_outcome_resolved_at:null,selected_residual_scale:null,
        ensemble_members:0,ensemble_members_required:NEURAL_POLICY.ensembleSeeds.length
      },
      feature_names: [...FEATURE_NAMES],
      temporal_network:temporalNetwork,
      identifier_features_used: false,
      note: 'INSUFFICIENT_CHRONOLOGICAL_DATA_FOR_NESTED_VALIDATION',
      _fit: fit
    };
  }

  const validationStartAt = uniqueTimes[trainingEndIndex];
  const holdoutStartAt = uniqueTimes[uniqueTimes.length - holdoutCount];
  const trainingPool = resolved.filter(row => row.at < validationStartAt);
  const training = trainingPool.filter(row => row.resolved_at < validationStartAt);
  const purgedTraining = trainingPool.length - training.length;
  const validationPool = resolved.filter(row => row.at >= validationStartAt && row.at < holdoutStartAt);
  const validation = validationPool.filter(row => row.resolved_at < holdoutStartAt);
  const purgedValidation = validationPool.length - validation.length;
  const holdout = resolved.filter(row => row.at >= holdoutStartAt);
  const globalFit = fitLogisticModel(training, { l2, iterations, learningRate });
  const globalValidation = evaluateHoldout(validation, globalFit);

  const trainingTimes = [...new Set(training.map(row => row.at))].sort((a, b) => a - b);
  const recentStartIndex = Math.max(0,
    Math.min(trainingTimes.length - 1, Math.floor(trainingTimes.length * (1 - recentWindowFraction))));
  const recentStartAt = trainingTimes[recentStartIndex] ?? null;
  const recentTraining = recentStartAt === null
    ? [] : training.filter(row => row.at >= recentStartAt);
  const recentFit = recentTraining.length >= minTrainingSamples
    ? fitLogisticModel(recentTraining, { l2, iterations, learningRate }) : null;
  const recentValidation = recentFit ? evaluateHoldout(validation, recentFit) : {
    evaluated: false, reason: 'RECENT_WINDOW_REQUIRES_MINIMUM_TRAINING_SAMPLES',
    sample_count: validation.length, model_brier_score: null, base_rate_brier_score: null,
    beat_base_rate: false
  };

  let selectedModel = 'GLOBAL_HISTORY';
  let selectedFit = globalFit;
  let selectedTraining = training;
  let selectedValidation = globalValidation;
  let selectionReason = globalValidation.beat_base_rate
    ? 'GLOBAL_MODEL_VALIDATED_ON_MIDDLE_WINDOW'
    : 'NO_CHALLENGER_VALIDATED_ON_MIDDLE_WINDOW';

  const recentWins = recentValidation.evaluated === true &&
    recentValidation.beat_base_rate === true &&
    (globalValidation.beat_base_rate !== true ||
      recentValidation.model_brier_score + recentSelectionMargin < globalValidation.model_brier_score);
  if (recentWins) {
    selectedModel = 'RECENT_WINDOW';
    selectedFit = recentFit;
    selectedTraining = recentTraining;
    selectedValidation = recentValidation;
    selectionReason = 'RECENT_MODEL_BEAT_GLOBAL_MODEL_ON_MIDDLE_WINDOW';
  }

  const neuralLimit=Math.max(240,Math.min(1500,Math.trunc(Number(maxNeuralTrainingSamples)||NEURAL_POLICY.maxTrainingSamples)));
  const neuralMinimum=Math.max(200,Math.min(900,Math.trunc(Number(minNeuralTrainingSamples)||NEURAL_POLICY.minTrainingSamples)));
  const upEventTraining=asUpEventRows(training);
  const upEventRecentTraining=asUpEventRows(recentTraining);
  const upEventValidation=asUpEventRows(validation);
  const upEventHoldout=asUpEventRows(holdout);
  // All neural/challenger comparisons use identical binary UP-event labels.
  const neuralGlobalLogisticFit=upEventTraining.length>=minTrainingSamples
    ?fitLogisticModel(upEventTraining,{l2,iterations,learningRate}):null;
  const neuralRecentLogisticFit=upEventRecentTraining.length>=minTrainingSamples
    ?fitLogisticModel(upEventRecentTraining,{l2,iterations,learningRate}):null;
  const neuralCandidateRows=training.length>=neuralMinimum
    ?asUpEventRows(training.slice(-neuralLimit)):[];
  const neuralCandidateTimes=[...new Set(neuralCandidateRows.map(row=>row.at))].sort((a,b)=>a-b);
  // V5 now reserves four chronological stages inside its training window:
  // 70% model fitting, 10% member/residual selection, and 20% probability
  // calibration (itself split into fit/check blocks), followed by outer
  // validation and the untouched final holdout. Every cutoff purges outcomes
  // that had not matured before that block ended.
  const neuralTrainingCutIndex=neuralCandidateTimes.length>=4
    ?Math.max(1,Math.min(neuralCandidateTimes.length-2,Math.floor(neuralCandidateTimes.length*0.70))):-1;
  const neuralSelectionCutIndex=neuralTrainingCutIndex>=0
    ?Math.max(neuralTrainingCutIndex+1,Math.min(neuralCandidateTimes.length-1,
      Math.floor(neuralCandidateTimes.length*0.80))):-1;
  const neuralSelectionStartAt=neuralTrainingCutIndex>=0
    ?neuralCandidateTimes[neuralTrainingCutIndex]:null;
  const neuralCalibrationStartAt=neuralSelectionCutIndex>=0
    ?neuralCandidateTimes[neuralSelectionCutIndex]:null;
  const neuralTraining=neuralSelectionStartAt===null?[]:neuralCandidateRows.filter(row=>
    row.at<neuralSelectionStartAt&&row.resolved_at<neuralSelectionStartAt);
  const neuralSelection=neuralCalibrationStartAt===null?[]:neuralCandidateRows.filter(row=>
    row.at>=neuralSelectionStartAt&&row.at<neuralCalibrationStartAt&&
    row.resolved_at<neuralCalibrationStartAt);
  const neuralCalibration=neuralCalibrationStartAt===null?[]:neuralCandidateRows.filter(row=>
    row.at>=neuralCalibrationStartAt&&row.resolved_at<validationStartAt);
  const neuralCalibrationTimes=[...new Set(neuralCalibration.map(row=>row.at))].sort((a,b)=>a-b);
  const neuralCalibrationFitCutIndex=neuralCalibrationTimes.length>=3
    ?Math.max(1,Math.min(neuralCalibrationTimes.length-1,Math.floor(neuralCalibrationTimes.length*0.70))):-1;
  const neuralCalibrationCheckStartAt=neuralCalibrationFitCutIndex>=0
    ?neuralCalibrationTimes[neuralCalibrationFitCutIndex]:null;
  const neuralCalibrationFit=neuralCalibrationCheckStartAt===null?[]:neuralCalibration.filter(row=>
    row.at<neuralCalibrationCheckStartAt&&row.resolved_at<neuralCalibrationCheckStartAt);
  const neuralCalibrationCheck=neuralCalibrationCheckStartAt===null?[]:neuralCalibration.filter(row=>
    row.at>=neuralCalibrationCheckStartAt&&row.resolved_at<validationStartAt);
  const neuralSelectionMinimum=Math.max(20,minimumValidationSamples);
  // Fit the logistic anchor and every nonlinear residual on the earliest
  // chronological training slice only. Selection labels cannot enter gradients.
  let neuralSameWindowLogisticFit=neuralTraining.length>=neuralMinimum
    ?fitLogisticModel(neuralTraining,{l2,iterations,learningRate}):null;
  const neuralFit=neuralTraining.length>=neuralMinimum&&
    neuralSelection.length>=neuralSelectionMinimum&&neuralSameWindowLogisticFit
    ?fitNeuralEnsemble(neuralTraining,{
      hiddenUnits:NEURAL_POLICY.hiddenUnits,
      secondHiddenUnits:NEURAL_POLICY.secondHiddenUnits,
      iterations:neuralIterations,learningRate:neuralLearningRate,l2:neuralL2,
      baselineFit:neuralSameWindowLogisticFit
    }):null;
  let neuralFinalTraining=neuralTraining;
  // Select the ensemble member and nonlinear residual contribution exclusively
  // from the disjoint selection block. Outer validation and holdout stay unused.
  const neuralResidualScales=NEURAL_RESIDUAL_SCALES;
  const neuralMemberSelection=neuralFit?neuralFit.members.flatMap((member,index)=>
    neuralResidualScales.map(residualScale=>({
      index,residual_scale:residualScale,
      metrics:evaluateHoldout(neuralSelection,{...member,residual_scale:residualScale})
    }))
  ):[];
  const neuralMemberOrder=neuralMemberSelection.filter(row=>row.metrics.evaluated===true)
    .sort((a,b)=>a.metrics.model_brier_score-b.metrics.model_brier_score||
      a.index-b.index||a.residual_scale-b.residual_scale);
  if(neuralFit){
    neuralFit.selected_member_index=neuralMemberOrder.length?neuralMemberOrder[0].index:-1;
    neuralFit.selected_residual_scale=neuralMemberOrder.length?neuralMemberOrder[0].residual_scale:0;
    // Refit only the selected member on the union of model-fit + selection rows.
    // All labels must mature before the separate calibration window begins.
    const selectedIndex=neuralFit.selected_member_index;
    const refitRows=[...neuralTraining,...neuralSelection]
      .sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol));
    const refitBaseline=selectedIndex>=0?fitLogisticModel(refitRows,{l2,iterations,learningRate}):null;
    const selectedProfile=selectedIndex>=0?neuralFit.member_training_profiles[selectedIndex]||{}:{};
    const refitMember=selectedIndex>=0&&refitBaseline
      ?fitNeuralNetworkModel(refitRows,{
        hiddenUnits:NEURAL_POLICY.hiddenUnits,secondHiddenUnits:NEURAL_POLICY.secondHiddenUnits,
        ...selectedProfile,seed:neuralFit.seeds[selectedIndex],baselineFit:refitBaseline
      }):null;
    if(refitMember&&refitBaseline){
      neuralFit.members[selectedIndex]=refitMember;
      neuralSameWindowLogisticFit=refitBaseline;
      neuralFinalTraining=refitRows;
      // All validation metrics must use the prevalence of the exact final refit
      // set. The previous code retained the earlier ensemble fit's base_rate,
      // even after adding the disjoint member-selection rows to the refit.
      // That made the Brier reference predictor inconsistent with the weights
      // that actually generated the validation and holdout probabilities.
      const refitPositiveSamples=refitRows.filter(row=>Number(row.target)===1).length;
      const refitNegativeSamples=refitRows.length-refitPositiveSamples;
      neuralFit.base_rate=refitBaseline.base_rate;
      neuralFit.refit_base_rate=refitBaseline.base_rate;
      neuralFit.refit_positive_samples=refitPositiveSamples;
      neuralFit.refit_negative_samples=refitNegativeSamples;
      neuralFit.training_samples=refitRows.length;
      neuralFit.refit_training_samples=refitRows.length;
      neuralFit.refit_max_outcome_resolved_at=Math.max(...refitRows.map(row=>row.resolved_at));
    }else{
      neuralFit.selected_member_index=-1;
      neuralFit.selected_residual_scale=0;
      neuralFit.refit_training_samples=0;
      neuralFit.refit_max_outcome_resolved_at=null;
    }
    // Fit calibration only after refitting; the calibration rows remain later.
    neuralFit.probability_calibrator=neuralFit.selected_member_index>=0
      ?fitAndSelectNeuralProbabilityCalibrator(neuralCalibrationFit,neuralCalibrationCheck,neuralFit)
      :null;
  }
  // This validation score is now measured on rows later than model fitting,
  // member selection and calibration, so it is an honest outer comparison.
  const neuralValidation=neuralFit&&neuralFit.selected_member_index>=0
    ?evaluateHoldout(upEventValidation,neuralFit):{
      evaluated:false,reason:'NEURAL_MODEL_REQUIRES_MATURED_SELECTION_SAMPLES',
      sample_count:upEventValidation.length,model_brier_score:null,base_rate_brier_score:null,beat_base_rate:false
    };
  const neuralSameWindowLogisticValidation=neuralSameWindowLogisticFit
    ?evaluateHoldout(upEventValidation,neuralSameWindowLogisticFit):{evaluated:false,model_brier_score:null};
  const neuralGlobalLogisticValidation=neuralGlobalLogisticFit
    ?evaluateHoldout(upEventValidation,neuralGlobalLogisticFit):{evaluated:false,model_brier_score:null};
  const neuralRecentLogisticValidation=neuralRecentLogisticFit
    ?evaluateHoldout(upEventValidation,neuralRecentLogisticFit):null;
  const comparisonMargin=Math.max(0.002,Number(neuralSelectionMargin)||0);
  const neuralValidationComparison={
    neural_brier_score:neuralValidation.model_brier_score??null,
    base_rate_brier_score:neuralValidation.base_rate_brier_score??null,
    base_rate_used:neuralFit?.base_rate??null,
    same_window_logistic_brier_score:neuralSameWindowLogisticValidation.model_brier_score??null,
    global_logistic_brier_score:neuralGlobalLogisticValidation.model_brier_score??null,
    recent_logistic_brier_score:neuralRecentLogisticValidation?.model_brier_score??null,
    beats_base_rate:neuralValidation.beat_base_rate===true,
    beats_same_window_logistic:neuralValidation.evaluated===true&&neuralSameWindowLogisticValidation.evaluated===true&&
      neuralValidation.model_brier_score+comparisonMargin<neuralSameWindowLogisticValidation.model_brier_score,
    beats_global_logistic:neuralValidation.evaluated===true&&neuralGlobalLogisticValidation.evaluated===true&&
      neuralValidation.model_brier_score+comparisonMargin<neuralGlobalLogisticValidation.model_brier_score,
    beats_recent_logistic:!neuralRecentLogisticFit||(neuralValidation.evaluated===true&&
      neuralRecentLogisticValidation?.evaluated===true&&
      neuralValidation.model_brier_score+comparisonMargin<neuralRecentLogisticValidation.model_brier_score)
  };
  const neuralWins=neuralFit!==null&&neuralValidation.evaluated===true&&
    neuralValidationComparison.beats_base_rate===true&&
    neuralValidationComparison.beats_same_window_logistic===true&&
    neuralValidationComparison.beats_global_logistic===true&&
    neuralValidationComparison.beats_recent_logistic===true;
  const neuralHoldout=neuralFit?evaluateHoldout(upEventHoldout,neuralFit):{
    sample_count:upEventHoldout.length,evaluated:false,model_brier_score:null,base_rate_brier_score:null,
    log_loss:null,beat_base_rate:false,reason:'NEURAL_MODEL_NOT_FITTED'
  };
  const neuralSameWindowLogisticHoldout=neuralSameWindowLogisticFit
    ?evaluateHoldout(upEventHoldout,neuralSameWindowLogisticFit):{evaluated:false,model_brier_score:null};
  const neuralGlobalLogisticHoldout=neuralGlobalLogisticFit
    ?evaluateHoldout(upEventHoldout,neuralGlobalLogisticFit):{evaluated:false,model_brier_score:null};
  const neuralRecentLogisticHoldout=neuralRecentLogisticFit
    ?evaluateHoldout(upEventHoldout,neuralRecentLogisticFit):null;
  const beatsSameWindowLogistic=neuralHoldout.evaluated===true&&
    neuralSameWindowLogisticHoldout.evaluated===true&&
    neuralHoldout.model_brier_score+comparisonMargin<neuralSameWindowLogisticHoldout.model_brier_score;
  const beatsGlobalLogistic=neuralHoldout.evaluated===true&&neuralGlobalLogisticHoldout.evaluated===true&&
    neuralHoldout.model_brier_score+comparisonMargin<neuralGlobalLogisticHoldout.model_brier_score;
  const beatsRecentLogistic=!neuralRecentLogisticFit||(neuralHoldout.evaluated===true&&
    neuralRecentLogisticHoldout?.evaluated===true&&
    neuralHoldout.model_brier_score+comparisonMargin<neuralRecentLogisticHoldout.model_brier_score);
  const neuralHoldoutReady=neuralHoldout.evaluated===true&&neuralHoldout.beat_base_rate===true&&
    beatsSameWindowLogistic&&beatsGlobalLogistic&&beatsRecentLogistic;
  const neuralHoldoutComparison={
    sample_count:upEventHoldout.length,required_live_holdout_samples:100,required_brier_margin:comparisonMargin,
    base_rate_used:neuralFit?.base_rate??null,
    neural_brier_score:neuralHoldout.model_brier_score,
    same_window_logistic_brier_score:neuralSameWindowLogisticHoldout.model_brier_score??null,
    global_logistic_brier_score:neuralGlobalLogisticHoldout.model_brier_score??null,
    recent_logistic_brier_score:neuralRecentLogisticHoldout?.model_brier_score??null,
    beats_base_rate:neuralHoldout.beat_base_rate===true,
    beats_same_window_logistic:beatsSameWindowLogistic,
    beats_global_logistic:beatsGlobalLogistic,
    beats_recent_logistic:neuralRecentLogisticFit?beatsRecentLogistic:null,
    passed:neuralHoldoutReady
  };
  // Fit the tabular challenger on the complete outer training block. Its
  // tree residuals are anchored to the same-window logistic model; validation
  // may select a challenger, but the final holdout is never used for selection.
  const boostedTreeFit=neuralGlobalLogisticFit&&upEventTraining.length>=neuralMinimum
    ?fitResidualBoostedTrees(upEventTraining,neuralGlobalLogisticFit):null;
  const boostedTreeValidation=boostedTreeFit
    ?evaluateHoldout(upEventValidation,boostedTreeFit)
    :{evaluated:false,model_brier_score:null,reason:'BOOSTED_TREE_TRAINING_NOT_READY'};
  const hybridFit=boostedTreeFit&&neuralFit
    ?{
      kind:'BLENDED_GBDT_MLP_V1',boosted_fit:boostedTreeFit,
      neural_fit:neuralFit,boosted_weight:0.5,
      base_rate:boostedTreeFit.base_rate,
      architecture:'50_50_PROBABILITY_BLEND_GBDT_TCN_MLP_V1',
      training_strategy:'VALIDATION_SELECTED_GBDT_MLP_PROBABILITY_BLEND_V1'
    }:null;
  const hybridValidation=hybridFit
    ?evaluateHoldout(upEventValidation,hybridFit)
    :{evaluated:false,model_brier_score:null,reason:'HYBRID_REQUIRES_BOTH_MODELS'};
  const challengerCandidates=[
    {name:'NEURAL_GLOBAL',fit:neuralFit,validation:neuralValidation},
    {name:'GBDT_RESIDUAL',fit:boostedTreeFit,validation:boostedTreeValidation},
    {name:'HYBRID_GBDT_MLP',fit:hybridFit,validation:hybridValidation}
  ].filter(candidate=>candidate.fit&&candidate.validation?.evaluated===true);
  const validationReferences=[
    neuralSameWindowLogisticValidation,
    neuralGlobalLogisticValidation,
    ...(neuralRecentLogisticFit?[neuralRecentLogisticValidation]:[])
  ].filter(metric=>metric?.evaluated===true&&Number.isFinite(metric.model_brier_score));
  const qualifiesOnValidation=candidate=>{
    const metric=candidate.validation;
    if(metric?.evaluated!==true||metric.beat_base_rate!==true)return false;
    return validationReferences.length>=2&&validationReferences.every(reference=>
      metric.model_brier_score+comparisonMargin<reference.model_brier_score);
  };
  const validationQualified=challengerCandidates.filter(qualifiesOnValidation)
    .sort((a,b)=>a.validation.model_brier_score-b.validation.model_brier_score||
      a.name.localeCompare(b.name));
  // Select exactly one challenger from validation. Do not fall through to a
  // runner-up after seeing the final holdout; that would turn the holdout into
  // another tuning set.
  const validationWinner=validationQualified[0]||null;
  let neuralSelected=validationWinner?.name==='NEURAL_GLOBAL';
  let challengerHoldout={evaluated:false,model_brier_score:null,reason:'NO_VALIDATED_CHALLENGER'};
  let challengerHoldoutComparison={passed:false,beats_base_rate:false,
    beats_same_window_logistic:false,beats_global_logistic:false,beats_recent_logistic:false};
  let activeChallenger=null;
  if(validationWinner){
    challengerHoldout=validationWinner.name==='NEURAL_GLOBAL'
      ?neuralHoldout:evaluateHoldout(upEventHoldout,validationWinner.fit);
    const holdoutReferences=[
      neuralSameWindowLogisticHoldout,neuralGlobalLogisticHoldout,
      ...(neuralRecentLogisticFit?[neuralRecentLogisticHoldout]:[])
    ].filter(metric=>metric?.evaluated===true&&Number.isFinite(metric.model_brier_score));
    const beatsReferences=challengerHoldout.evaluated===true&&
      holdoutReferences.length>=2&&holdoutReferences.every(reference=>
        challengerHoldout.model_brier_score+comparisonMargin<reference.model_brier_score);
    challengerHoldoutComparison={
      sample_count:upEventHoldout.length,
      required_brier_margin:comparisonMargin,
      model_brier_score:challengerHoldout.model_brier_score??null,
      base_rate_brier_score:challengerHoldout.base_rate_brier_score??null,
      beats_base_rate:challengerHoldout.beat_base_rate===true,
      beats_same_window_logistic:challengerHoldout.evaluated===true&&
        neuralSameWindowLogisticHoldout.evaluated===true&&
        challengerHoldout.model_brier_score+comparisonMargin<
          neuralSameWindowLogisticHoldout.model_brier_score,
      beats_global_logistic:challengerHoldout.evaluated===true&&
        neuralGlobalLogisticHoldout.evaluated===true&&
        challengerHoldout.model_brier_score+comparisonMargin<
          neuralGlobalLogisticHoldout.model_brier_score,
      beats_recent_logistic:!neuralRecentLogisticFit||
        (challengerHoldout.evaluated===true&&neuralRecentLogisticHoldout?.evaluated===true&&
          challengerHoldout.model_brier_score+comparisonMargin<
            neuralRecentLogisticHoldout.model_brier_score),
      passed:challengerHoldout.beat_base_rate===true&&beatsReferences
    };
    if(challengerHoldoutComparison.passed){
      activeChallenger=validationWinner.name;
      selectedModel=validationWinner.name;
      selectedFit=validationWinner.fit;
      selectedTraining=validationWinner.name==='NEURAL_GLOBAL'?neuralFinalTraining:training;
      selectedValidation=validationWinner.validation;
      selectionReason=validationWinner.name+'_BEAT_ALL_LOGISTIC_CHALLENGERS_ON_VALIDATION_AND_HOLDOUT';
    }else{
      selectionReason='VALIDATION_CHALLENGER_FAILED_UNTOUCHED_HOLDOUT;_LOGISTIC_FALLBACK_RETAINED';
    }
  }
  const holdoutMetrics = activeChallenger
    ?challengerHoldout:evaluateHoldout(holdout, selectedFit);
  const evidence = factorEvidence(selectedTraining, { minimumBucket });
  const rankingReady = training.length >= minTrainingSamples &&
    validation.length >= minimumValidationSamples &&
    holdout.length >= minimumHoldoutSamples &&
    evidence.covered_factor_buckets >= 4;
  const probabilityReady = rankingReady &&
    selectedValidation.evaluated === true && selectedValidation.beat_base_rate === true &&
    holdoutMetrics.evaluated === true && holdoutMetrics.beat_base_rate === true;
  const neuralProbabilityReady=rankingReady&&probabilityReady&&neuralSelected&&
    neuralValidation.evaluated===true&&neuralValidation.beat_base_rate===true&&neuralHoldoutReady&&
    holdoutMetrics.evaluated===true&&holdoutMetrics.beat_base_rate===true;
  const neuralLiveReady=neuralProbabilityReady&&neuralTraining.length>=NEURAL_POLICY.minTrainingSamples&&
    holdout.length>=100;
  const outcomes = {
    up: training.filter(row => row.outcome === 'UP').length,
    down: training.filter(row => row.outcome === 'DOWN').length,
    flat: training.filter(row => row.outcome === 'FLAT').length
  };
  const selectedMaxResolvedAt = selectedTraining.length
    ? Math.max(...selectedTraining.map(row => row.resolved_at)) : null;
  const recentGain = globalValidation.evaluated && recentValidation.evaluated
    ? Number((globalValidation.model_brier_score - recentValidation.model_brier_score).toFixed(5))
    : null;

  return {
    method: 'NESTED_PURGED_WALK_FORWARD_RESIDUAL_NEURAL_MODEL_V5',
    outcome_horizon_ms: horizonMs,
    ranking_ready: rankingReady,
    probability_ready: probabilityReady,
    ready: rankingReady,
    resolved_samples: resolved.length,
    training_samples: training.length,
    fit_samples: selectedTraining.length,
    validation_samples: validation.length,
    holdout_samples: holdout.length,
    purged_overlap_samples: purgedTraining + purgedValidation,
    validation_purged_samples: purgedValidation,
    required_training_samples: minTrainingSamples,
    required_validation_samples: minimumValidationSamples,
    required_holdout_samples: minimumHoldoutSamples,
    required_factor_buckets: 4,
    covered_factor_buckets: evidence.covered_factor_buckets,
    validation_start_at: validationStartAt,
    holdout_start_at: holdoutStartAt,
    max_training_outcome_resolved_at: selectedMaxResolvedAt,
    outcome_counts: outcomes,
    training_positive_rate_pct: Number((selectedFit.base_rate * 100).toFixed(1)),
    validation: selectedValidation,
    holdout: holdoutMetrics,
    neural_network: {
      status: !neuralFit ? 'WAITING_FOR_MATURED_TRAINING_SAMPLES' :
        neuralLiveReady ? 'LIVE_GATE_PASSED_OUT_OF_SAMPLE' :
        neuralSelected ? 'VALIDATION_SELECTED_BUT_HOLDOUT_COMPARISON_FAILED' :
        neuralValidation.beat_base_rate===true ? 'VALIDATED_BUT_NOT_BETTER_THAN_CHALLENGER' : 'VALIDATION_DID_NOT_BEAT_BASE_RATE',
      architecture: neuralFit?.architecture || FEATURE_NAMES.length+'-'+NEURAL_POLICY.hiddenUnits+'-'+NEURAL_POLICY.secondHiddenUnits+'-1+RESIDUAL',
      input_neurons: FEATURE_NAMES.length, hidden_neurons: NEURAL_POLICY.hiddenUnits,
      second_hidden_neurons: NEURAL_POLICY.secondHiddenUnits, output_neurons: 1,
      samples_required:neuralMinimum,training_samples: neuralFit?.training_samples??neuralTraining.length,
      preselection_training_samples:neuralTraining.length,
      refit_training_samples:neuralFit?.refit_training_samples??0,
      refit_positive_samples:neuralFit?.refit_positive_samples??0,
      refit_negative_samples:neuralFit?.refit_negative_samples??0,
      refit_base_rate:neuralFit?.refit_base_rate??null,
      scoring_base_rate:neuralFit?.base_rate??null,
      maximum_training_sample_budget:neuralLimit,
      model_kind:'RESIDUAL_DEEP_MLP_ENSEMBLE_V3',
      training_strategy:'UP_EVENT_BINARY_PROPER_LOSS_RESIDUAL_MLP_V6',
      training_objective:'MIXED_PROPER_SCORING_RULE_ENSEMBLE_BRIER_LOG_LOSS_V6',
      target_definition:'UP_CLOSE_RETURN_BINARY_V1',
      residual_scale_selection:'DISJOINT_CHRONOLOGICAL_SELECTION_BLOCK_BRIER_GRID_V1',
      candidate_residual_scales:[...neuralResidualScales],
      selection_samples:neuralSelection.length,
      selection_start_at:neuralSelectionStartAt,
      calibration_start_at:neuralCalibrationStartAt,
      calibration_fit_start_at:neuralCalibrationFit[0]?.at??null,
      calibration_check_start_at:neuralCalibrationCheckStartAt,
      calibration_samples:neuralCalibration.length,
      calibration_fit_samples:neuralCalibrationFit.length,
      calibration_check_samples:neuralCalibrationCheck.length,
      probability_calibration:neuralFit?.probability_calibrator??{
        method:'DISJOINT_BRIER_PLATT_NEURAL_CALIBRATION_V1',fitted:false,accepted:false,
        reason:'NEURAL_MODEL_NOT_FITTED'
      },
      max_training_outcome_resolved_at:neuralTraining.length?Math.max(...neuralTraining.map(row=>row.resolved_at)):null,
      max_refit_training_outcome_resolved_at:neuralFit?.refit_max_outcome_resolved_at??null,
      max_selection_outcome_resolved_at:neuralSelection.length?Math.max(...neuralSelection.map(row=>row.resolved_at)):null,
      max_calibration_fit_outcome_resolved_at:neuralCalibrationFit.length?Math.max(...neuralCalibrationFit.map(row=>row.resolved_at)):null,
      max_calibration_check_outcome_resolved_at:neuralCalibrationCheck.length?Math.max(...neuralCalibrationCheck.map(row=>row.resolved_at)):null,
      selected_residual_scale:neuralFit?.selected_residual_scale??null,
      ensemble_members:neuralFit?.members?.length||0,
      ensemble_members_required:NEURAL_POLICY.ensembleSeeds.length,
      selected_member_index:neuralFit?.selected_member_index??null,
      member_training_objectives:neuralFit?.members?.map(member=>member.training_objective)||[],
      member_selection_brier_scores:neuralMemberSelection.map(row=>({
        index:row.index,residual_scale:row.residual_scale,brier_score:row.metrics.model_brier_score,
        base_rate_brier_score:row.metrics.base_rate_brier_score,beat_base_rate:row.metrics.beat_base_rate
      })),
      member_validation_brier_scores:[],
      trained: neuralFit!==null, selected: neuralSelected,
      probability_ready: neuralProbabilityReady,
      live_eligibility_ready:neuralLiveReady,
      iterations: neuralFit?.iterations??Math.max(20,Math.min(240,Math.trunc(Number(neuralIterations)||NEURAL_POLICY.iterations))),
      validation: neuralValidation,
      validation_comparison:neuralValidationComparison,
      holdout: neuralHoldout,
      holdout_comparison:neuralHoldoutComparison,
      selection_margin: comparisonMargin
    },
    boosted_tree_model: {
      status:!boostedTreeFit?'WAITING_FOR_MATURED_TRAINING_SAMPLES':
        activeChallenger==='GBDT_RESIDUAL'?'OUT_OF_SAMPLE_VALIDATED':
        validationWinner?.name==='GBDT_RESIDUAL'?'VALIDATION_SELECTED_HOLDOUT_FAILED':
        'TRAINED_NOT_SELECTED',
      model_kind:'RESIDUAL_GBDT_LOGISTIC_ANCHOR_V1',
      architecture:boostedTreeFit?.architecture||'NEWTON_GBDT_DEPTH3_SHRUNK_36_ROUNDS',
      trained:boostedTreeFit!==null,selected:activeChallenger==='GBDT_RESIDUAL',
      probability_ready:activeChallenger==='GBDT_RESIDUAL',
      tree_count:boostedTreeFit?.tree_count||0,
      training_samples:boostedTreeFit?.training_samples||0,
      minimum_leaf_samples:boostedTreeFit?.minimum_leaf_samples||0,
      learning_rate:boostedTreeFit?.learning_rate??null,
      residual_scale:boostedTreeFit?.residual_scale??null,
      validation:boostedTreeValidation,
      hybrid_validation:hybridValidation,
      holdout:validationWinner?.name==='GBDT_RESIDUAL'?challengerHoldout:null,
      holdout_comparison:validationWinner?.name==='GBDT_RESIDUAL'?challengerHoldoutComparison:null
    },
    hybrid_model: {
      status:!hybridFit?'WAITING_FOR_BOTH_CHALLENGERS':
        activeChallenger==='HYBRID_GBDT_MLP'?'OUT_OF_SAMPLE_VALIDATED':
        validationWinner?.name==='HYBRID_GBDT_MLP'?'VALIDATION_SELECTED_HOLDOUT_FAILED':
        'TRAINED_NOT_SELECTED',
      model_kind:'BLENDED_GBDT_MLP_V1',
      architecture:hybridFit?.architecture||'50_50_PROBABILITY_BLEND_GBDT_MLP_V1',
      trained:hybridFit!==null,selected:activeChallenger==='HYBRID_GBDT_MLP',
      probability_ready:activeChallenger==='HYBRID_GBDT_MLP',
      boosted_weight:hybridFit?.boosted_weight??null,
      validation:hybridValidation,
      holdout:validationWinner?.name==='HYBRID_GBDT_MLP'?challengerHoldout:null,
      holdout_comparison:validationWinner?.name==='HYBRID_GBDT_MLP'?challengerHoldoutComparison:null
    },
    model_selection: {
      selected_model: selectedModel,
      validation_challenger:validationWinner?.name||null,
      active_challenger:activeChallenger,
      challenger_holdout_passed:challengerHoldoutComparison.passed===true,
      challenger_candidate_metrics:challengerCandidates.map(candidate=>({
        name:candidate.name,
        validation_brier_score:candidate.validation.model_brier_score??null,
        validation_base_rate_brier_score:candidate.validation.base_rate_brier_score??null
      })),
      reason: selectionReason,
      recent_window_samples: recentTraining.length,
      global_validation_brier_score: globalValidation.model_brier_score,
      global_validation_base_rate_brier_score: globalValidation.base_rate_brier_score,
      global_validation_beats_base_rate: globalValidation.beat_base_rate === true,
      recent_validation_brier_score: recentValidation.model_brier_score ?? null,
      recent_validation_base_rate_brier_score: recentValidation.base_rate_brier_score ?? null,
      recent_validation_beats_base_rate: recentValidation.beat_base_rate === true,
      recent_validation_gain: recentGain
    },
    regime_adaptation: {
      status: recentWins ? 'RECENT_WINDOW_SELECTED' :
        globalValidation.beat_base_rate ? 'GLOBAL_HISTORY_RETAINED' : 'NO_VALIDATED_MODEL',
      recent_window_samples: recentTraining.length,
      validation_improvement: recentGain,
      validated_on_middle_window: selectedValidation.beat_base_rate === true
    },
    factor_evidence: evidence.factors,
    feature_names: [...FEATURE_NAMES],
    temporal_network:temporalNetwork,
    identifier_features_used: false,
    note: probabilityReady
      ? 'SELECTED_MODEL_BEAT_VALIDATION_AND_UNTOUCHED_CHRONOLOGICAL_HOLDOUT_BASE_RATES'
      : rankingReady
        ? 'RANKING_EVIDENCE_READY_BUT_NESTED_VALIDATION_NOT_PASSED'
        : 'INSUFFICIENT_MATURED_OUTCOMES_OR_FACTOR_COVERAGE_AFTER_PURGING',
    _fit: selectedFit
  };
}

/**
 * Scores only immutable, matured forecasts produced before their outcomes
 * were known. This is the live prequential check, separate from historical
 * train/validation/test splits.
 */
export function buildCognitivePrequentialProfile(journal = [], {
  minimumWindowSamples = 20, windowSize = 40, modelVariant = null
} = {}) {
  const rows = (Array.isArray(journal) ? journal : [])
    .filter(row => row && Number(row.model_version) === 5 &&
      finite(row.predicted_up_probability) !== null &&
      Number(row.predicted_up_probability) >= 0 && Number(row.predicted_up_probability) <= 100 &&
      ['UP', 'DOWN', 'FLAT'].includes(row.outcome) &&
      (String(row.selected_model||row.model_variant||'')==='TEMPORAL_TCN'
        ? row.target_definition===TEMPORAL_TARGET_DEFINITION &&
          ['CLOSED_CANDLE_4H_FIRST_PASSAGE_V1','HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1'].includes(row.outcome_source)
        : row.target_definition==='UP_CLOSE_RETURN_BINARY_V1'
          ? ['NEURAL_GLOBAL','GBDT_RESIDUAL','HYBRID_GBDT_MLP'].includes(
              String(row.selected_model||row.model_variant||'')) &&
            ['CLOSED_CANDLE_4H','HISTORICAL_CLOSED_CANDLE'].includes(row.outcome_source)
          : (row.target_definition===undefined||row.target_definition===null||row.target_definition==='LEGACY_4H_CLOSE_RETURN') &&
            ['CLOSED_CANDLE_4H', 'HISTORICAL_CLOSED_CANDLE'].includes(row.outcome_source)) &&
      finite(row.at) !== null && finite(row.resolved_at) !== null &&
      finite(row.trained_through_at) !== null &&
      Number(row.trained_through_at) < Number(row.at) &&
      Number(row.resolved_at) - Number(row.at) === MIN_OUTCOME_HORIZON_MS)
    .map(row => ({
      ...row,
      model_variant: String(row.selected_model || row.model_variant || 'V5_UNSPECIFIED').trim() || 'V5_UNSPECIFIED',
      prediction: clamp(Number(row.predicted_up_probability) / 100, 0.001, 0.999),
      target: ['TEMPORAL_TCN','NEURAL_GLOBAL','GBDT_RESIDUAL','HYBRID_GBDT_MLP'].includes(
        String(row.selected_model||row.model_variant||'')) ||
        row.target_definition==='UP_CLOSE_RETURN_BINARY_V1'
        ? (row.outcome==='UP'?1:0)
        : row.outcome === 'UP' ? 1 : row.outcome === 'DOWN' ? 0 : 0.5
    }))
    .sort((a, b) => Number(a.at) - Number(b.at) || String(a.id).localeCompare(String(b.id)));

  // A changing winner (neural/global/recent) is a new model variant. Never
  // compare its forward errors against forecasts made by a different winner.
  const auditedModelVariant=String(modelVariant || rows.at(-1)?.model_variant || 'V5_UNSPECIFIED').trim() || 'V5_UNSPECIFIED';
  const variantRows=rows.filter(row=>row.model_variant===auditedModelVariant);
  const score = subset => {
    if (!subset.length) return {
      sample_count: 0, brier_score: null, log_loss: null,
      directional_accuracy_pct: null, high_confidence_error_count: 0,
      high_confidence_error_rate_pct: null, error_patterns: []
    };
    const brier = mean(subset.map(row => (row.prediction - row.target) ** 2));
    const logLoss = mean(subset.map(row =>
      -(row.target * Math.log(row.prediction) + (1 - row.target) * Math.log(1 - row.prediction))));
    const directional = subset.filter(row => row.outcome !== 'FLAT');
    const accuracy = directional.length
      ? mean(directional.map(row => (row.prediction >= 0.5) === (row.outcome === 'UP') ? 1 : 0))
      : null;
    const confident = directional.filter(row => row.prediction >= 0.8 || row.prediction <= 0.2);
    const confidentErrors = confident.filter(row =>
      (row.prediction >= 0.8 && row.outcome === 'DOWN') ||
      (row.prediction <= 0.2 && row.outcome === 'UP'));
    const reasons = new Map();
    for (const row of subset) {
      for (const reason of new Set(Array.isArray(row.reason_codes) ? row.reason_codes.map(String) : [])) {
        if (!reasons.has(reason)) reasons.set(reason, []);
        reasons.get(reason).push(row);
      }
    }
    const errorPatterns = [...reasons.entries()].map(([reasonCode, group]) => {
      const groupBrier = mean(group.map(row => (row.prediction - row.target) ** 2));
      const groupConfident = group.filter(row => row.outcome !== 'FLAT' &&
        (row.prediction >= 0.8 || row.prediction <= 0.2));
      const groupConfidentErrors = groupConfident.filter(row =>
        (row.prediction >= 0.8 && row.outcome === 'DOWN') ||
        (row.prediction <= 0.2 && row.outcome === 'UP'));
      return {
        reason_code: reasonCode,
        sample_count: group.length,
        brier_score: Number(groupBrier.toFixed(5)),
        high_confidence_errors: groupConfidentErrors.length,
        high_confidence_error_rate_pct: groupConfident.length
          ? Number((groupConfidentErrors.length / groupConfident.length * 100).toFixed(1)) : null
      };
    }).filter(row => row.sample_count >= 3)
      .sort((left, right) => right.brier_score - left.brier_score ||
        right.high_confidence_errors - left.high_confidence_errors)
      .slice(0, 8);
    return {
      sample_count: subset.length,
      brier_score: Number(brier.toFixed(5)),
      log_loss: Number(logLoss.toFixed(5)),
      directional_accuracy_pct: accuracy === null ? null : Number((accuracy * 100).toFixed(1)),
      high_confidence_error_count: confidentErrors.length,
      high_confidence_error_rate_pct: confident.length
        ? Number((confidentErrors.length / confident.length * 100).toFixed(1)) : null,
      error_patterns: errorPatterns
    };
  };

  const recent = variantRows.slice(-Math.max(minimumWindowSamples, windowSize));
  const previousEnd = Math.max(0, variantRows.length - recent.length);
  const previous = variantRows.slice(Math.max(0, previousEnd - Math.max(minimumWindowSamples, windowSize)), previousEnd);
  const recentMetrics = score(recent);
  const previousMetrics = score(previous);
  const enough = recent.length >= minimumWindowSamples && previous.length >= minimumWindowSamples;
  const degradation = enough
    ? Number((recentMetrics.brier_score - previousMetrics.brier_score).toFixed(5)) : null;
  const driftDetected = enough &&
    degradation >= 0.08 &&
    recentMetrics.brier_score >= previousMetrics.brier_score * 1.5;
  return {
    method: 'IMMUTABLE_FORWARD_FORECAST_PREQUENTIAL_AUDIT_V2',
    status: !enough ? 'INSUFFICIENT_FORWARD_PREDICTIONS' :
      driftDetected ? 'FORWARD_PERFORMANCE_DEGRADING' : 'FORWARD_MONITORING_STABLE',
    resolved_forecasts: variantRows.length,
    all_v5_resolved_forecasts: rows.length,
    audited_model_variant: auditedModelVariant,
    excluded_other_model_variant_forecasts: rows.length-variantRows.length,
    minimum_window_samples: minimumWindowSamples,
    previous_window: previousMetrics,
    recent_window: recentMetrics,
    brier_degradation: degradation,
    drift_detected: driftDetected,
    reassessment_required: driftDetected,
    note: driftDetected
      ? 'RECENT_IMMUTABLE_FORECASTS_DEGRADED_VS_PRIOR_WINDOW'
      : 'ONLY_FIRST_RECORDED_MODEL_V5_FORECAST_PER_CLOSED_CANDLE_IS_SCORED_PER_SELECTED_MODEL_VARIANT'
  };
}

export function applyCognitiveRankAdjustment(baseScore, features = {}, profile = {}) {
  const score = finite(baseScore);
  if (score === null || profile?.probability_ready !== true || !profile?._fit) return null;
  const probability = predictFromFit(features, profile._fit);
  if (probability === null) return null;
  const adjustment = clamp((probability - Number(profile._fit.base_rate)) * 12, -3, 3);
  return Number(clamp(score + adjustment, 0, 100).toFixed(1));
}

function counterfactualEvidence(features, fit) {
  const baseline = predictFromFit(features, fit);
  if (baseline === null) return [];
  const variants = [
    ['BUYER_PRESSURE', { taker_buy_ratio: 0.5 }],
    ['VOLUME_EXPANSION', { volume_ratio: 1 }],
    ['TRADE_EXPANSION', { trade_ratio: 1 }],
    ['PRICE_STRUCTURE', { higher_low: false, breakout_above_prior_high: false }],
    ['VOLATILITY_COMPRESSION', { compression_ratio: 1 }],
    ['RELATIVE_STRENGTH', { relative_strength_vs_btc_pct: 0 }],
    ['MULTI_HOUR_TREND', { trend_aligned: false, return_3h_pct: 0 }],
    ['MICRO_BUY_PRESSURE', { micro_5m_available: false, micro_5m_taker_buy_ratio: null }]
  ];
  return variants.map(([key, changes]) => {
    const altered = { ...features, ...changes };
    const alternative = predictFromFit(altered, fit);
    return {
      factor: key,
      probability_without_factor_pct: alternative === null ? null : Number((alternative * 100).toFixed(1)),
      contribution_percentage_points: alternative === null
        ? null : Number(((baseline - alternative) * 100).toFixed(1))
    };
  }).filter(row => row.contribution_percentage_points !== null)
    .sort((a, b) => Math.abs(b.contribution_percentage_points) - Math.abs(a.contribution_percentage_points))
    .slice(0, 6);
}

export function assessCognitiveCandidate(candidate, profile = {}, now = Date.now()) {
  const symbol = String(candidate?.symbol || '').trim().toUpperCase();
  const features = candidate?.features && typeof candidate.features === 'object' ? candidate.features : {};
  const daily = finite(candidate?.change_24h_pct);
  const hourly = finite(features.hourly_return_pct);
  const recent15 = finite(features.recent_15m_return_pct) ?? finite(features.price_change_15m_pct);
  const micro5 = finite(features.micro_5m_return_pct);
  const candleAge = finite(candidate?.candle_age_ms);
  const price = finite(candidate?.price);
  const score = finite(candidate?.score);
  const validData = /^[A-Z0-9]{5,30}$/.test(symbol) && candidate?.data_valid === true &&
    candidate?.data_stale !== true && candidate?.closed_candles_only === true &&
    price !== null && price > 0 && score !== null && candleAge !== null &&
    candleAge >= 0 && candleAge <= 20 * 60 * 1000;
  const base = {
    version: 5,
    symbol,
    assessed_at: Number(now),
    entry_eligible: false,
    paper_trading: true,
    real_order_execution: false,
    probability_status: profile?.probability_ready === true ||
      profile?.temporal_network?.probability_ready === true ? 'OUT_OF_SAMPLE_VALIDATED' : 'NOT_VALIDATED'
  };
  if (!validData) return {
    ...base, decision: 'DATA_UNAVAILABLE',
    summary_ar: 'لا يمكن إصدار حكم؛ بيانات السعر أو الشمعة المغلقة غير مكتملة أو قديمة.',
    reason_codes: ['FRESH_VALID_CLOSED_CANDLE_REQUIRED'],
    hypotheses: [], contradictions: [], counterfactual_evidence: [],
    predicted_up_probability: null, confidence_label: 'UNKNOWN'
  };

  const flags = factorValues(features);
  const orderBookChecked = candidate?.order_book_checked === true || features.order_book_checked === true;
  const orderBookSpread = finite(features.order_book_spread_bps ?? candidate?.order_book_spread_bps);
  const orderBookImbalance = finite(features.order_book_imbalance_pct ?? candidate?.order_book_imbalance_pct);
  const bidAskDepthRatio = finite(features.order_book_bid_ask_depth_ratio ?? candidate?.order_book_bid_ask_depth_ratio);
  const spoofingAssessment = orderBookChecked ? 'NOT_ASSESSABLE_SINGLE_SNAPSHOT' : 'NOT_CHECKED';
  const dailyLate = daily !== null && daily >= 8;
  const late = candidate?.tier === 'LATE_MOVE' || candidate?.thresholds?.late_move === true ||
    dailyLate || (hourly !== null && hourly >= 5) ||
    (recent15 !== null && recent15 >= 2.5) || (micro5 !== null && micro5 >= 3);
  const volume = finite(features.volume_ratio);
  const buyer = finite(features.taker_buy_ratio);
  const relative = finite(features.relative_strength_vs_btc_pct);
  const upperWick = finite(features.upper_wick_pct);
  const range = finite(features.current_range_pct);
  const close = finite(features.close_location);
  const contradictions = [];
  if (volume !== null && volume >= 1.5 && buyer !== null && buyer < 0.48)
    contradictions.push('تزايد الحجم دون ضغط شراء مؤيد');
  if (relative !== null && relative < -1)
    contradictions.push('ضعف نسبي واضح مقابل BTC');
  if (upperWick !== null && range !== null && range > 0 && upperWick / range > 0.55)
    contradictions.push('ذيل علوي كبير قد يدل على رفض الأسعار الأعلى');
  if (daily !== null && daily < -5)
    contradictions.push('ضغط هبوطي يومي مرتفع');
  if (orderBookChecked && orderBookSpread !== null && orderBookSpread > 30)
    contradictions.push('فارق دفتر الأوامر واسع ويضعف جودة التنفيذ');
  if (orderBookChecked && bidAskDepthRatio !== null && bidAskDepthRatio < 0.70 &&
      buyer !== null && buyer < 0.50)
    contradictions.push('عمق الطلبات أضعف من العروض رغم الحركة');

  const activityEvidence = [flags.volume_expansion, flags.trade_expansion, flags.buyer_flow].filter(Boolean).length;
  const supportingDomains = Object.values(flags).filter(Boolean).length;
  const hypotheses = [
    { key: 'BUYER_ACCUMULATION', label_ar: 'تراكم وضغط شراء',
      supported: activityEvidence >= 2 && flags.buyer_flow, evidence: activityEvidence, required: 2 },
    { key: 'VOLATILITY_COMPRESSION', label_ar: 'قاعدة هادئة وانكماش تذبذب',
      supported: flags.volatility_compression, evidence: flags.volatility_compression ? 1 : 0, required: 1 },
    { key: 'PRICE_STRUCTURE', label_ar: 'تحسن بنية السعر',
      supported: flags.price_structure, evidence: flags.price_structure ? 1 : 0, required: 1 },
    { key: 'RELATIVE_STRENGTH', label_ar: 'تفوق نسبي على BTC',
      supported: flags.relative_strength, evidence: flags.relative_strength ? 1 : 0, required: 1 },
    { key: 'MULTI_TIMEFRAME_TREND', label_ar: 'اتجاه متوافق على أكثر من إطار',
      supported: flags.multi_hour_trend && flags.short_momentum,
      evidence: [flags.multi_hour_trend, flags.short_momentum].filter(Boolean).length, required: 2 }
  ];
  const buyerAccumulationSupported = volume !== null && volume >= 1.5 &&
    finite(features.trade_ratio) !== null && Number(features.trade_ratio) >= 1.25 &&
    buyer !== null && buyer >= 0.54 &&
    (flags.price_structure || flags.volatility_compression) &&
    (relative === null || relative >= -0.25);
  const orderBookSupportsBuyers = orderBookChecked && orderBookSpread !== null &&
    orderBookSpread <= 20 && bidAskDepthRatio !== null && bidAskDepthRatio >= 1.15;
  const possibleTrap = (orderBookChecked && orderBookSpread !== null && orderBookSpread > 30) ||
    (orderBookChecked && bidAskDepthRatio !== null && bidAskDepthRatio < 0.70) ||
    (upperWick !== null && range !== null && range > 0 && upperWick / range > 0.55 &&
      close !== null && close < 0.45) ||
    (volume !== null && volume >= 1.5 && (buyer === null || buyer < 0.48));
  const marketMotiveAssessment = {
    accumulation_hypothesis: buyerAccumulationSupported ? 'SUPPORTED_BY_CONVERGENT_PUBLIC_EVIDENCE' : 'NOT_ESTABLISHED',
    order_book_confirmation: !orderBookChecked ? 'NOT_CHECKED' :
      orderBookSupportsBuyers ? 'BID_DEPTH_SUPPORTS_BUY_FLOW' : 'NO_CLEAR_BID_DEPTH_SUPPORT',
    possible_liquidity_trap: possibleTrap,
    reasons: [
      ...(buyerAccumulationSupported ? ['VOLUME_TRADE_BUYER_FLOW_AND_STRUCTURE_CONFLUENCE'] : []),
      ...(orderBookSupportsBuyers ? ['NARROW_SPREAD_AND_BID_DEPTH_IMBALANCE'] : []),
      ...(possibleTrap ? ['CONTRADICTORY_OR_TRAP_LIKE_MICROSTRUCTURE'] : [])
    ],
    order_book_checked: orderBookChecked,
    order_book_spread_bps: orderBookSpread,
    order_book_imbalance_pct: orderBookImbalance,
    order_book_bid_ask_depth_ratio: bidAskDepthRatio,
    spoofing_assessment: spoofingAssessment,
    whale_identity_claim: false,
    interpretation_ar: orderBookChecked
      ? 'هذه قرائن دفتر أوامر من لقطة واحدة؛ لا تثبت هوية الحوت أو نية التجميع ولا تكشف التلاعب زمنياً.'
      : 'لم يُفحص دفتر الأوامر لهذه العملة؛ لا يجوز استنتاج نية الحيتان أو نفي فخ السيولة.'
  };
  const noChase = (daily === null || daily <= 7) &&
    (hourly === null || hourly <= 3.5) &&
    (recent15 === null || recent15 <= 1.5) &&
    (micro5 === null || micro5 <= 1.8);
  const baselinePredicted = profile?.probability_ready === true
    ? predictFromFit(features, profile._fit) : null;
  const temporalPredicted = predictTemporalProbability(candidate?.temporal_sequence, profile?.temporal_network);
  // Use the temporal model only when its own chronological validation and
  // untouched holdout beat the pooled baseline. Never blend unvalidated scores.
  const predicted = temporalPredicted !== null ? temporalPredicted : baselinePredicted;
  const selectedTemporal = temporalPredicted !== null;
  const reasons = [];
  if (flags.volume_expansion) reasons.push('VOLUME_EXPANSION');
  if (flags.trade_expansion) reasons.push('TRADE_ACTIVITY_EXPANSION');
  if (flags.buyer_flow) reasons.push('BUYER_FLOW_SUPPORT');
  if (flags.price_structure) reasons.push('CLOSED_CANDLE_PRICE_STRUCTURE');
  if (flags.volatility_compression) reasons.push('VOLATILITY_COMPRESSION');
  if (flags.relative_strength) reasons.push('RELATIVE_STRENGTH_VS_BTC');
  if (!noChase) reasons.push('ANTI_CHASE_REVIEW_REQUIRED');
  if (contradictions.length) reasons.push('CONTRADICTORY_EVIDENCE_PRESENT');
  if (selectedTemporal) reasons.push('TEMPORAL_TCN_OUT_OF_SAMPLE_VALIDATED');
  else if (profile?.temporal_network?.trained === true)
    reasons.push('TEMPORAL_TCN_NOT_VALIDATED_NO_PROBABILITY_PUBLISHED');

  let decision = 'NO_SETUP';
  let summary = 'الأدلة الحالية لا تكفي لتصنيف فرصة مبكرة؛ يواصل المراقبة ولا يفتح أي صفقة.';
  if (late || !noChase) {
    decision = 'AVOID_CHASING';
    summary = 'الحركة امتدت؛ يتجنب مطاردة السعر وينتظر قاعدة وإشارة جديدة.';
  } else if (activityEvidence >= 2 && flags.price_structure && supportingDomains >= 4 &&
      contradictions.length === 0 && (predicted === null || predicted >= 0.55)) {
    decision = 'EARLY_SETUP_REVIEW';
    summary = predicted === null
      ? 'تجمعت أدلة مبكرة مستقلة؛ المراجعة والمحاكاة فقط حتى يثبت النموذج تعلمه خارج العينة.'
      : 'الأدلة المبكرة متوافقة، والنموذج المتعلم يدعمها في اختبار زمني مستقل؛ مراجعة ومحاكاة فقط.';
  } else if (supportingDomains >= 2 || contradictions.length > 0 || (predicted !== null && predicted < 0.48)) {
    decision = 'WATCH_AND_REASSESS';
    summary = contradictions.length
      ? 'الأدلة متعارضة؛ يخفض الثقة ويعيد الفحص بعد شمعة مغلقة جديدة.'
      : 'بعض الأدلة موجودة لكنّها لا تكفي؛ ينتظر معلومات جديدة ولا يتعجل.';
  }
  const counterfactuals = predicted === null || selectedTemporal
    ? [] : counterfactualEvidence(features, profile._fit);
  return {
    ...base,
    decision,
    summary_ar: summary,
    reason_codes: reasons.length ? reasons : ['INSUFFICIENT_CONFLUENT_EVIDENCE'],
    hypotheses,
    contradictions,
    market_motive_assessment:marketMotiveAssessment,
    evidence_domains: supportingDomains,
    activity_evidence: activityEvidence,
    anti_chase_passed: noChase,
    predicted_up_probability: predicted === null ? null : Number((predicted * 100).toFixed(1)),
    temporal_up_probability:temporalPredicted===null?null:Number((temporalPredicted*100).toFixed(1)),
    temporal_model_status:profile?.temporal_network?.status||'WAITING_FOR_TEMPORAL_SAMPLES',
    confidence_label: predicted === null ? 'UNKNOWN' : selectedTemporal
      ? 'VALIDATED_TEMPORAL_TCN_ON_CHRONOLOGICAL_HOLDOUT'
      : profile?.neural_network?.selected === true
        ? 'VALIDATED_NEURAL_MLP_ON_CHRONOLOGICAL_HOLDOUT' : 'VALIDATED_ON_NESTED_WALK_FORWARD_HOLDOUT',
    learning_samples: Number(profile?.resolved_samples) || 0,
    counterfactual_evidence: counterfactuals,
    entry_eligible: false,
    paper_trading: true,
    real_order_execution: false
  };
}
