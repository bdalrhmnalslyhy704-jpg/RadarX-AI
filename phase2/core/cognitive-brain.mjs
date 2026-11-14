import {buildTemporalNeuralProfile,predictTemporalProbability,TEMPORAL_TARGET_DEFINITION} from './temporal-neural-brain.mjs';
import {focalAsymmetricBrierLoss,deriveTrainingClassWeights} from './neural-closure-contracts.mjs';

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
export const NEURAL_FACTOR_CROSS_RESIDUAL_SCALES=Object.freeze([
  0,0.025,0.05,0.075,0.1,0.125,0.15,0.2,0.25,0.5,1
]);
const NEURAL_POLICY = Object.freeze({
  hiddenUnits: 10,
  secondHiddenUnits: 6,
  minTrainingSamples: 240,
  // Research cap for expanded chronological-history ablations. The caller
  // may request fewer rows; outer validation/holdout remain strictly excluded.
  maxTrainingSamples: 6000,
  iterations: 100,
  learningRate: 0.012,
  l2: 0.04,
  selectionMargin: 0.003,
  ensembleSeeds: Object.freeze([11, 29, 47])
});
export const COGNITIVE_CHALLENGER_BRIER_MARGIN = NEURAL_POLICY.selectionMargin;

// Pre-declared GBDT capacity/regularization candidates. The outer chronological
// validation window selects one candidate; the untouched holdout is opened once
// for that winner and is never used to choose a different tree configuration.
const COGNITIVE_GBDT_VALIDATION_GRID=Object.freeze([
  Object.freeze({name:'DEPTH3_36R_LR035_L2_12_S065',maxTrees:36,maxDepth:3,
    learningRate:0.035,l2:12,minimumLeafFraction:0.035,residualScale:0.65}),
  Object.freeze({name:'DEPTH2_24R_LR020_L2_20_S035',maxTrees:24,maxDepth:2,
    learningRate:0.02,l2:20,minimumLeafFraction:0.06,residualScale:0.35}),
  Object.freeze({name:'DEPTH3_32R_LR018_L2_24_S030',maxTrees:32,maxDepth:3,
    learningRate:0.018,l2:24,minimumLeafFraction:0.07,residualScale:0.30}),
  Object.freeze({name:'DEPTH2_36R_LR025_L2_10_S045',maxTrees:36,maxDepth:2,
    learningRate:0.025,l2:10,minimumLeafFraction:0.045,residualScale:0.45}),
  Object.freeze({name:'DEPTH3_48R_LR025_L2_16_S050',maxTrees:48,maxDepth:3,
    learningRate:0.025,l2:16,minimumLeafFraction:0.05,residualScale:0.50}),
  Object.freeze({name:'DEPTH2_48R_LR035_L2_08_S065',maxTrees:48,maxDepth:2,
    learningRate:0.035,l2:8,minimumLeafFraction:0.06,residualScale:0.65}),
  Object.freeze({name:'DEPTH3_36R_LR045_L2_18_S050',maxTrees:36,maxDepth:3,
    learningRate:0.045,l2:18,minimumLeafFraction:0.025,residualScale:0.50}),
  Object.freeze({name:'DEPTH2_32R_LR050_L2_14_S080',maxTrees:32,maxDepth:2,
    learningRate:0.05,l2:14,minimumLeafFraction:0.04,residualScale:0.80}),
  Object.freeze({name:'DEPTH3_48R_LR030_L2_24_S085',maxTrees:48,maxDepth:3,
    learningRate:0.03,l2:24,minimumLeafFraction:0.06,residualScale:0.85})
]);
export const COGNITIVE_FEATURE_SCHEMA='CROSS_ASSET_EARLY_FLOW_FEATURES_V2';
export const COGNITIVE_FEATURE_NAMES = Object.freeze([
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
  'relative_momentum_divergence',
  'compression_x_buyer',
  'micro_buy_flow_acceleration',
  'average_trade_size_expansion',
  'micro_availability_mask'
]);
export const COGNITIVE_DAILY_FEATURE_SCHEMA='CROSS_ASSET_DAILY_CONTEXT_FEATURES_V3';
export const COGNITIVE_DAILY_FEATURE_NAMES=Object.freeze([
  ...COGNITIVE_FEATURE_NAMES,
  'momentum_30m','momentum_1h','momentum_3h','btc_momentum_1h',
  'daily_momentum','relative_strength_24h','quote_volume_scale',
  'breakout_distance','range_scale','lower_wick_support',
  'micro_volume_expansion','micro_trade_expansion','micro_momentum',
  'micro_close_location','micro_buyer_divergence','timeframe_trend_consensus',
  'relative_strength_timeframe_divergence'
]);
const FEATURE_NAMES=COGNITIVE_FEATURE_NAMES;

function featureNamesForSchema(schema=COGNITIVE_FEATURE_SCHEMA){
  if(schema===COGNITIVE_DAILY_FEATURE_SCHEMA)return COGNITIVE_DAILY_FEATURE_NAMES;
  if(schema===COGNITIVE_FEATURE_SCHEMA)return COGNITIVE_FEATURE_NAMES;
  throw new Error('UNSUPPORTED_COGNITIVE_FEATURE_SCHEMA:'+String(schema));
}

function isCognitiveBinaryModelVariant(value) {
  const variant=String(value||'').trim();
  return variant==='NEURAL_GLOBAL'||variant==='GBDT_RESIDUAL'||
    /^HYBRID_GBDT_MLP_(?:W(?:25|50|75)|BRIER_OPTIMAL)$/.test(variant);
}

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

import {createHash} from 'node:crypto';
import {
  calculateAsymmetricDirectionalRankingLoss,
  prequalifyHybridComponent
} from './neural-safety-contracts.mjs';

function sampleIdentityFingerprint(rows){
  const canonical=(Array.isArray(rows)?rows:[]).map(row=>[
    String(row?.id||''),String(row?.symbol||'').trim().toUpperCase(),
    Number(row?.at),Number(row?.resolved_at),String(row?.outcome||'')
  ]).sort((a,b)=>a[2]-b[2]||a[0].localeCompare(b[0]));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function effectiveCognitiveChallengerMargin(requestedMargin) {
  const requested = finite(requestedMargin);
  return requested === null ? COGNITIVE_CHALLENGER_BRIER_MARGIN :
    Math.max(COGNITIVE_CHALLENGER_BRIER_MARGIN, requested);
}

// Inner member selection is only a model-choice step on the training-side
// selection block. It may use a smaller predeclared margin, but never weakens
// the independent outer validation/holdout requirement.
export function effectiveNeuralInnerSelectionMargin(requestedMargin, outerMargin=COGNITIVE_CHALLENGER_BRIER_MARGIN) {
  const outer=finite(outerMargin);
  const requiredOuter=outer===null?COGNITIVE_CHALLENGER_BRIER_MARGIN:
    Math.max(COGNITIVE_CHALLENGER_BRIER_MARGIN,outer);
  const requested=finite(requestedMargin);
  return requested===null?requiredOuter:Math.max(0,Math.min(requiredOuter,requested));
}

export function hasCognitiveBrierSuperiority(candidateScore, baselineScore,
  margin = COGNITIVE_CHALLENGER_BRIER_MARGIN) {
  const candidate = finite(candidateScore);
  const baseline = finite(baselineScore);
  const required = finite(margin);
  return candidate !== null && baseline !== null && required !== null && required >= 0 &&
    baseline - candidate - required > 1e-12;
}
export function effectiveNeuralSelectionMinimum(minimumValidationSamples, requestedMinimum=null) {
  const requested=finite(requestedMinimum);
  if(requested===null)return Math.max(20,Math.trunc(Number(minimumValidationSamples)||20));
  return Math.max(20,Math.min(900,Math.trunc(requested)));
}
export function hasNeuralSelectionSupport({
  sampleCount=0,positiveCount=0,negativeCount=0,
  minimumSamples=20,minimumPositive=0,minimumNegative=0
}={}){
  const sample=finite(sampleCount),positive=finite(positiveCount),negative=finite(negativeCount);
  return sample!==null&&positive!==null&&negative!==null&&
    sample>=Math.max(20,Math.trunc(Number(minimumSamples)||20))&&
    positive>=Math.max(0,Math.trunc(Number(minimumPositive)||0))&&
    negative>=Math.max(0,Math.trunc(Number(minimumNegative)||0))&&
    positive+negative===sample;
}
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

function normalizedFeatures(features = {}, featureSchema=COGNITIVE_FEATURE_SCHEMA) {
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
  const relativeMomentumDivergence=relativeRaw!==null&&momentumRaw!==null
    ?clamp((relativeRaw-momentumRaw)/1.5,-2,2):0;
  const compressionBuyer=compression*buyer;
  const microAvailable=f.micro_5m_available===true&&microRaw!==null;
  const microBuyFlowAcceleration=microAvailable&&buyerRaw!==null
    ?clamp((microRaw-buyerRaw)/0.1,-2,2):0;
  const averageTradeSizeExpansion=volRaw!==null&&tradeRaw!==null&&tradeRaw>0
    ?clamp(Math.log(clamp(volRaw/tradeRaw,0.05,20))/Math.log(2),-2,2):0;

  const baseVector=[
    volume,trades,buyer,structure,compression,relative,momentum,trend,micro,
    close,wickPenalty,volume*buyer,structure*buyer,relativeMomentumDivergence,
    compressionBuyer,microBuyFlowAcceleration,averageTradeSizeExpansion,
    microAvailable?1:0
  ];
  if(featureSchema!==COGNITIVE_DAILY_FEATURE_SCHEMA)return baseVector;

  // Daily-only inputs are derived from candles closed at the exact baseline.
  // No price identities, composite heuristic scores or future labels enter.
  const scale=(value,divisor=1)=>value===null?0:clamp(value/divisor,-2,2);
  const ratioLog=value=>value===null?0:
    clamp(Math.log(clamp(value,0.05,20))/Math.log(2),-2,2);
  const return30=finite(f.return_30m_pct),return60=finite(f.hourly_return_pct);
  const return180=finite(f.return_3h_pct),btcReturn60=finite(f.btc_hourly_return_pct);
  const dailyReturn=finite(f.daily_change_pct);
  const relative24=finite(f.relative_strength_vs_btc_24h_pct);
  const quoteVolume=finite(f.quote_volume_24h);
  const breakoutDistance=finite(f.breakout_distance_pct);
  const currentRange=finite(f.current_range_pct),lowerWick=finite(f.lower_wick_pct);
  const microVolume=finite(f.micro_5m_volume_ratio),microTrades=finite(f.micro_5m_trade_ratio);
  const microReturn=finite(f.micro_5m_return_pct),microClose=finite(f.micro_5m_close_location);
  const microBuyer=finite(f.micro_5m_taker_buy_ratio);
  const relativeDenominator=relative24!==null&&relativeRaw!==null?2:
    relative24!==null?1:0;
  const relativeMean=relativeDenominator
    ?((relative24??0)+(relativeRaw??0))/relativeDenominator:null;
  const returns=[return30,return60,return180,dailyReturn].filter(value=>value!==null);
  const trendConsensus=returns.length
    ?returns.reduce((sum,value)=>sum+(value>0?1:value<0?-1:0),0)/returns.length:0;
  const relativeDivergence=relative24!==null&&relativeRaw!==null
    ?clamp((relative24-relativeRaw)/3,-2,2):0;
  const lowerSupport=lowerWick!==null&&currentRange!==null&&currentRange>0
    ?clamp((lowerWick/currentRange-0.2)/0.3,-1,2):0;
  const liquidity=quoteVolume!==null&&quoteVolume>0
    ?clamp(Math.log10(quoteVolume/750000),-2,2):0;
  const microEnabled=f.micro_5m_available===true;
  const microDivergence=microEnabled&&microBuyer!==null&&buyerRaw!==null
    ?clamp((microBuyer-buyerRaw)/0.1,-2,2):0;

  return baseVector.concat([
    scale(return30,2),scale(return60,3),scale(return180,5),scale(btcReturn60,3),
    scale(dailyReturn,15),scale(relativeMean,3),liquidity,scale(breakoutDistance,1.5),
    ratioLog(currentRange),lowerSupport,microEnabled?ratioLog(microVolume):0,
    microEnabled?ratioLog(microTrades):0,microEnabled?scale(microReturn,1.5):0,
    microEnabled&&microClose!==null?clamp((microClose-0.5)*2,-1,1):0,
    microDivergence,trendConsensus,relativeDivergence
  ]);
}

export function buildCognitiveFeatureVector(features={},featureSchema=COGNITIVE_FEATURE_SCHEMA){
  return normalizedFeatures(features,featureSchema);
}

function validResolvedSamples(samples, {
  outcomeHorizonMs = MIN_OUTCOME_HORIZON_MS,
  modelTargetDefinition = TEMPORAL_TARGET_DEFINITION,
  modelTargetSemantics = 'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2_PCT_4H_15M_V2',
  allowResolutionLag = false,
  allowedOutcomeSources = null,
  featureSchema = COGNITIVE_FEATURE_SCHEMA
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
      const rowTargetDefinition=String(row.target_definition||'');
      const rowTargetSemantics=String(row.target_semantics||'');
      const targetContractValid=(!rowTargetDefinition||rowTargetDefinition===modelTargetDefinition)&&
        (!rowTargetSemantics||rowTargetSemantics===modelTargetSemantics);
      const expectedSource = row.historical_baseline === true
        ? 'HISTORICAL_CLOSED_CANDLE' : radarOutcome ? source : 'CLOSED_CANDLE_4H';
      const sourceValid = allowedSources ? allowedSources.has(source) : source === expectedSource;
      const resolvedAfterHorizon = resolvedAt !== null && at !== null &&
        (allowResolutionLag ? resolvedAt >= at + horizonMs : resolvedAt - at === horizonMs);
      if (!id || !symbol || at === null || at <= 0 ||
          resolvedAt === null || !resolvedAfterHorizon ||
          horizon !== horizonMs || !sourceValid || !targetContractValid ||
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
      feature_schema:featureSchema,
      feature_names:[...featureNamesForSchema(featureSchema)],
      vector: normalizedFeatures(row.features,featureSchema)
    }))
    .sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
}

function fitLogisticModel(training, { l2 = 0.08, iterations = 900, learningRate = 0.12 } = {}) {
  const featureNames=training[0]?.feature_names||FEATURE_NAMES;
  const featureSchema=training[0]?.feature_schema||COGNITIVE_FEATURE_SCHEMA;
  const featureCount=featureNames.length;
  const targets = training.map(row => row.target);
  const baseRate = betaRate(targets.reduce((sum, value) => sum + value, 0), targets.length);
  const weights = Array(featureCount).fill(0);
  let intercept = logit(baseRate);
  const n = Math.max(1, training.length);

  // Deterministic full-batch gradient descent: reproducible tests and no random seed.
  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradients = Array(featureCount).fill(0);
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
  return { intercept, weights, base_rate: baseRate, feature_names: [...featureNames], feature_schema:featureSchema, l2 };
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
    type:'split',feature:split.feature,threshold:split.threshold,gain:split.gain,
    left:buildResidualTreeNode(left,depth+1,rows,gradients,hessians,options),
    right:buildResidualTreeNode(right,depth+1,rows,gradients,hessians,options)
  };
}

function accumulateResidualTreeImportance(node,gains,counts) {
  if(!node||typeof node!=='object'||node.type!=='split')return;
  const feature=Number(node.feature);
  if(Number.isInteger(feature)&&feature>=0&&feature<gains.length){
    gains[feature]+=Math.max(0,Number(node.gain)||0);
    counts[feature]++;
  }
  accumulateResidualTreeImportance(node.left,gains,counts);
  accumulateResidualTreeImportance(node.right,gains,counts);
}

function diagnoseResidualBoostedTreeRootGain(training,baselineFit,{
  l2=12,minimumLeafFraction=0.035
}={}){
  const featureCount=baselineFit?.weights?.length||0;
  const rows=(Array.isArray(training)?training:[]).filter(row=>
    Array.isArray(row?.vector)&&row.vector.length===featureCount&&
    row.vector.every(Number.isFinite)&&Number.isFinite(Number(row.target)));
  if(rows.length<200||!featureCount||!baselineFit)
    return {evaluated:false,reason:'GBDT_ROOT_DIAGNOSTIC_TRAINING_NOT_READY'};
  const minimumLeaf=Math.max(12,Math.min(80,Math.floor(rows.length*minimumLeafFraction)));
  const regularization=clamp(Number(l2)||12,2,30);
  const logits=rows.map(row=>linearLogit(row.vector,baselineFit));
  const gradients=new Array(rows.length),hessians=new Array(rows.length);
  for(let index=0;index<rows.length;index++){
    const probability=logistic(logits[index]);
    gradients[index]=probability-Number(rows[index].target);
    hessians[index]=Math.max(0.025,probability*(1-probability));
  }
  const split=bestResidualTreeSplit(rows.map((_,index)=>index),rows,gradients,hessians,{
    minimumLeaf,l2:regularization,minGain:Number.NEGATIVE_INFINITY
  });
  return {
    evaluated:true,training_samples:rows.length,feature_count:featureCount,
    minimum_leaf_samples:minimumLeaf,l2:regularization,
    best_root_split_gain:split?Number(split.gain.toFixed(10)):null,
    best_root_split_feature:split?.feature??null,
    best_root_split_threshold:split?.threshold??null,
    best_root_gain_is_positive:split?split.gain>0:false,
    configured_min_gain:0.002,
    positive_gain_but_blocked_by_default_threshold:split
      ?split.gain>0&&split.gain<=0.002:false
  };
}

function fitResidualBoostedTrees(training, baselineFit, {
  maxTrees=36,maxDepth=3,learningRate=0.035,l2=12,
  minimumLeafFraction=0.035,residualScale=0.65
}={}) {
  const featureNames=training[0]?.feature_names||baselineFit?.feature_names||FEATURE_NAMES;
  const featureSchema=training[0]?.feature_schema||baselineFit?.feature_schema||COGNITIVE_FEATURE_SCHEMA;
  const featureCount=featureNames.length;
  const rows=(Array.isArray(training)?training:[]).filter(row=>
    Array.isArray(row?.vector)&&row.vector.length===featureCount&&
    row.vector.every(Number.isFinite)&&Number.isFinite(Number(row.target)));
  if(rows.length<200||!baselineFit||!Array.isArray(baselineFit.weights)||
     baselineFit.weights.length!==featureCount)return null;
  const options={
    maxDepth:Math.max(1,Math.min(3,Math.trunc(maxDepth)||3)),
    minimumLeaf:Math.max(12,Math.min(80,Math.floor(rows.length*minimumLeafFraction))),
    l2:clamp(Number(l2)||12,2,30),minGain:0.002
  };
  const rate=clamp(Number(learningRate)||0.035,0.01,0.08);
  const logits=rows.map(row=>linearLogit(row.vector,baselineFit));
  const trees=[];
  const featureGains=Array(featureCount).fill(0);
  const featureSplitCounts=Array(featureCount).fill(0);
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
      const correction=rate*clamp(Number(residualScale)||0,0,1)*
        residualTreeValue(root,rows[index].vector);
      logits[index]=clamp(logits[index]+correction,-12,12);
      if(Math.abs(correction)>1e-9)changed=true;
    }
    if(!changed)break;
    trees.push(tree);
    accumulateResidualTreeImportance(root,featureGains,featureSplitCounts);
  }
  if(!trees.length)return null;
  const totalFeatureGain=featureGains.reduce((sum,value)=>sum+value,0);
  const featureImportance=featureNames.map((feature,index)=>({
    feature,gain:Number(featureGains[index].toFixed(7)),
    gain_share_pct:totalFeatureGain>0
      ?Number((featureGains[index]/totalFeatureGain*100).toFixed(2)):0,
    split_count:featureSplitCounts[index]
  })).filter(row=>row.split_count>0)
    .sort((a,b)=>b.gain-a.gain||a.feature.localeCompare(b.feature));
  return {
    kind:'RESIDUAL_GBDT_LOGISTIC_ANCHOR_V1',
    architecture:'NEWTON_GBDT_DEPTH3_SHRUNK_36_ROUNDS',
    baseline_fit:baselineFit,trees,tree_count:trees.length,
    learning_rate:rate,residual_scale:clamp(Number(residualScale)||0,0,1),
    max_depth:options.maxDepth,minimum_leaf_samples:options.minimumLeaf,
    l2:options.l2,base_rate:baselineFit.base_rate,
    training_samples:rows.length,feature_names:[...featureNames],feature_schema:featureSchema,
    feature_importance:featureImportance,
    feature_importance_total_gain:Number(totalFeatureGain.toFixed(7)),
    training_strategy:'SAME_WINDOW_LOGISTIC_ANCHORED_NEWTON_GRADIENT_BOOSTING_V1'
  };
}

function predictResidualBoostedTrees(features, fit) {
  if(!fit||fit.kind!=='RESIDUAL_GBDT_LOGISTIC_ANCHOR_V1'||
     !Array.isArray(fit.trees)||!fit.trees.length)return null;
  const vector=normalizedFeatures(features,fit.feature_schema||COGNITIVE_FEATURE_SCHEMA);
  let value=linearLogit(vector,fit.baseline_fit);
  let residual=0;
  for(const tree of fit.trees)residual+=
    Number(fit.learning_rate)*residualTreeValue(tree.root,vector);
  value=clamp(value+clamp(Number(fit.residual_scale)||0,0,1)*residual,-12,12);
  return clamp(logistic(value),0.02,0.98);
}

function assertNeuralFeatureBatch(training,featureNames,featureSchema){
  const expected=featureNamesForSchema(featureSchema);
  if(!Array.isArray(featureNames)||JSON.stringify(featureNames)!==JSON.stringify(expected))
    throw new TypeError('NEURAL_FEATURE_SCHEMA_NAME_ORDER_MISMATCH');
  if(!Array.isArray(training)||training.length===0)
    throw new TypeError('NEURAL_TRAINING_ROWS_EMPTY');
  for(let index=0;index<training.length;index++){
    const row=training[index];
    if(!row||typeof row!=='object')throw new TypeError('NEURAL_TRAINING_ROW_INVALID:'+index);
    if(row.feature_schema!==undefined&&row.feature_schema!==featureSchema)
      throw new TypeError('NEURAL_FEATURE_SCHEMA_MISMATCH:'+index);
    if(row.feature_names!==undefined&&
      (!Array.isArray(row.feature_names)||JSON.stringify(row.feature_names)!==JSON.stringify(featureNames)))
      throw new TypeError('NEURAL_FEATURE_NAME_ORDER_MISMATCH:'+index);
    if(!row.features||typeof row.features!=='object'||Array.isArray(row.features))
      throw new TypeError('NEURAL_FEATURE_INPUT_MISSING:'+index);
    if(Array.isArray(row.vector)){
      if(row.vector.length!==featureNames.length)
        throw new TypeError('NEURAL_FEATURE_VECTOR_SHAPE_MISMATCH:'+index);
      if(row.vector.some(value=>typeof value!=='number'||!Number.isFinite(value)))
        throw new TypeError('NEURAL_FEATURE_VECTOR_NON_FINITE_OR_NON_NUMERIC:'+index);
      const canonical=normalizedFeatures(row.features,featureSchema);
      if(canonical.length!==row.vector.length||row.vector.some((value,feature)=>
          Math.abs(value-canonical[feature])>1e-10))
        throw new TypeError('NEURAL_FEATURE_VECTOR_VALUE_MISMATCH:'+index);
    }
    const target=finite(row.target);
    if(target===null&&!['UP','DOWN','FLAT'].includes(row.outcome))
      throw new TypeError('NEURAL_TARGET_MISSING_OR_INVALID:'+index);
  }
}

function fitNeuralNetworkModel(training, {
  hiddenUnits = NEURAL_POLICY.hiddenUnits,
  secondHiddenUnits = NEURAL_POLICY.secondHiddenUnits,
  iterations = NEURAL_POLICY.iterations,
  learningRate = NEURAL_POLICY.learningRate,
  l2 = NEURAL_POLICY.l2,
  seed = 1,
  baselineFit = null,
  trainingObjective = 'UNWEIGHTED_BRIER_PROPER_SCORING_RULE',
  positiveClassWeighting = 'NONE',
  anchorAdaptation = 'FROZEN',
  outputInitializationScale = 0.015,
  enableAsymmetricDirectionalRankingLoss = false,
  directionalRankingLossConfig = {},
  focalGammaPositive = 1,
  focalGammaNegative = 2
} = {}) {
  const sourceRows=Array.isArray(training)?training:[];
  const featureNames=[...(sourceRows[0]?.feature_names||FEATURE_NAMES)];
  const featureSchema=sourceRows[0]?.feature_schema||COGNITIVE_FEATURE_SCHEMA;
  const featureCount=featureNames.length;
  assertNeuralFeatureBatch(sourceRows,featureNames,featureSchema);
  const rawRows=sourceRows.map(row=>({
    vector:Array.isArray(row.vector)?row.vector:normalizedFeatures(row.features,featureSchema),
    target:finite(row.target)===null?targetOf(row):clamp(Number(row.target),0,1),
    at:finite(row.at),symbol:String(row.symbol||'').trim().toUpperCase()
  }));
  if(!rawRows.length)return null;
  const positiveSamples=rawRows.filter(row=>row.target>0.5).length;
  const negativeSamples=rawRows.length-positiveSamples;
  const isFocalObjective=trainingObjective==='FOCAL_ASYMMETRIC_BRIER';
  if(isFocalObjective&&rawRows.some(row=>row.target!==0&&row.target!==1))
    throw new TypeError('NEURAL_FOCAL_ASYMMETRIC_BRIER_REQUIRES_BINARY_TARGETS');
  const usePositiveClassWeighting=!isFocalObjective&&positiveClassWeighting==='SQRT_INVERSE_PREVALENCE';
  const positiveSampleWeight=usePositiveClassWeighting&&positiveSamples>0
    ?clamp(Math.sqrt(negativeSamples/positiveSamples),1,3):1;
  const focalClassWeights=isFocalObjective
    ?deriveTrainingClassWeights(rawRows.map(row=>row.target))
    :{positiveWeight:1,negativeWeight:1};
  const focalWeights={
    positiveWeight:focalClassWeights.positiveWeight,
    negativeWeight:focalClassWeights.negativeWeight,
    gammaPositive:focalGammaPositive,gammaNegative:focalGammaNegative
  };
  const rows=rawRows.map(row=>({...row,sample_weight:isFocalObjective?1:
    row.target>0.5?positiveSampleWeight:1}));
  const totalSampleWeight=rows.reduce((sum,row)=>sum+row.sample_weight,0);

  const inputSize=featureCount;
  const units1=Math.max(4,Math.min(16,Math.trunc(Number(hiddenUnits)||NEURAL_POLICY.hiddenUnits)));
  const units2=Math.max(3,Math.min(12,Math.trunc(Number(secondHiddenUnits)||NEURAL_POLICY.secondHiddenUnits)));
  const steps=Math.max(30,Math.min(180,Math.trunc(Number(iterations)||NEURAL_POLICY.iterations)));
  const rate=clamp(Number(learningRate)||NEURAL_POLICY.learningRate,0.001,0.04);
  const regularization=clamp(Number(l2)||NEURAL_POLICY.l2,0.001,0.5);
  const outputHeadInitializationScale=clamp(Number(outputInitializationScale)||0.015,0.005,0.12);
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
    outputHeadInitializationScale*Math.sin((j+1)*4.73+seedOffset));
  const skipWeights=hasBaseline
    ?baselineFit.weights.map(value=>clamp(Number(value)||0,-4,4))
    :Array(inputSize).fill(0);
  let outputBias=hasBaseline?Number(baselineFit.intercept):logit(baseRate);
  const initialSkipWeights=[...skipWeights];
  const initialOutputBias=outputBias;
  const anchorAdaptationEnabled=hasBaseline&&anchorAdaptation==='TRUST_REGION_TETHERED_V1';
  const anchorTrustRadius=0.12;
  const anchorBiasTrustRadius=0.15;
  const anchorTetherStrength=0.35;
  const anchorLearningRateScale=0.25;

  const zerosLike=values=>Array.isArray(values)
    ?values.map(value=>Array.isArray(value)?zerosLike(value):0):0;
  const mInput=zerosLike(inputWeights),vInput=zerosLike(inputWeights);
  const mHidden=zerosLike(hiddenWeights),vHidden=zerosLike(hiddenWeights);
  const mBias1=zerosLike(hiddenBias1),vBias1=zerosLike(hiddenBias1);
  const mBias2=zerosLike(hiddenBias2),vBias2=zerosLike(hiddenBias2);
  const mOutput=zerosLike(outputWeights),vOutput=zerosLike(outputWeights);
  const mSkip=zerosLike(skipWeights),vSkip=zerosLike(skipWeights);
  let mOutputBias=0,vOutputBias=0;

  const update=(value,gradient,moment,variance,step,bound=3,decay=true,
    learningRateScale=1,stepRate=rate)=>{
    const g=clamp(gradient,-3,3);
    const nextMoment=0.9*moment+0.1*g;
    const nextVariance=0.999*variance+0.001*g*g;
    const correctedMoment=nextMoment/(1-Math.pow(0.9,step));
    const correctedVariance=nextVariance/(1-Math.pow(0.999,step));
    // Decoupled weight decay remains outside Adam's moment estimates.
    const stepSize=stepRate*learningRateScale;
    // True decoupled AdamW update: decay is applied to the parameter itself,
    // not added to the gradient before Adam's adaptive moment normalization.
    const decayedValue=decay?value*(1-stepSize*regularization):value;
    return {
      value:clamp(decayedValue-stepSize*correctedMoment/(Math.sqrt(correctedVariance)+1e-8),-bound,bound),
      moment:nextMoment,variance:nextVariance
    };
  };
  const maximumGradientNorm=1.0;
  const earlyStoppingPatience=Math.min(20,Math.max(8,Math.ceil(steps*0.25)));
  const minimumEpochs=Math.min(30,steps);
  const checkpointMinDelta=1e-8;
  const epochHistory=[];
  let bestTrainingObjective=Number.POSITIVE_INFINITY,bestEpoch=0;
  let epochsWithoutImprovement=0,bestCheckpoint=null,stoppedEarly=false;

  for(let epoch=1;epoch<=steps;epoch++){
    const gradInput=zerosLike(inputWeights),gradHidden=zerosLike(hiddenWeights);
    const gradBias1=Array(units1).fill(0),gradBias2=Array(units2).fill(0);
    const gradOutput=Array(units2).fill(0);
    const gradSkip=anchorAdaptationEnabled?Array(inputSize).fill(0):null;
    let gradOutputBias=0,weightedBrier=0,weightedObjectiveLoss=0;
    let directionalLoss=null;
    if(enableAsymmetricDirectionalRankingLoss){
      const trainingLogit=vector=>{
        const first=hiddenBias1.map((bias,j)=>{
          let value=bias;
          for(let i=0;i<inputSize;i++)value+=vector[i]*inputWeights[i][j];
          return Math.tanh(value);
        });
        const second=hiddenBias2.map((bias,j)=>{
          let value=bias;
          for(let i=0;i<units1;i++)value+=first[i]*hiddenWeights[i][j];
          return Math.tanh(value);
        });
        let value=outputBias;
        for(let j=0;j<units2;j++)value+=outputWeights[j]*second[j];
        for(let i=0;i<inputSize;i++)value+=skipWeights[i]*vector[i];
        return value;
      };
      const currentLogits=rows.map(row=>trainingLogit(row.vector));
      const baselineLogits=rows.map(row=>hasBaseline?linearLogit(row.vector,baselineFit):logit(baseRate));
      directionalLoss=calculateAsymmetricDirectionalRankingLoss({
        logits:currentLogits,targets:rows.map(row=>row.target),
        timestamps:rows.map(row=>row.at),symbols:rows.map(row=>row.symbol),
        baselineLogits,sampleWeights:rows.map(row=>row.sample_weight),
        config:directionalRankingLossConfig
      });
      weightedObjectiveLoss=directionalLoss.loss*totalSampleWeight;
    }
    for(let rowIndex=0;rowIndex<rows.length;rowIndex++){
      const row=rows[rowIndex];
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
      if(!Number.isFinite(probability))throw new TypeError('NEURAL_FORWARD_NON_FINITE');
      weightedBrier+=(probability-row.target)**2*row.sample_weight;
      const safeProbability=clamp(probability,1e-12,1-1e-12);
      const brierLoss=(safeProbability-row.target)**2;
      const logLoss=-(row.target*Math.log(safeProbability)+
        (1-row.target)*Math.log(1-safeProbability));
      const objectiveLoss=trainingObjective==='FOCAL_ASYMMETRIC_BRIER'
        ?focalAsymmetricBrierLoss(safeProbability,row.target,focalWeights).loss
        :trainingObjective==='UNWEIGHTED_LOG_LOSS_PROPER_SCORING_RULE'
          ?logLoss
          :trainingObjective==='MIXED_BRIER_LOG_LOSS_50_50_PROPER_SCORING_RULE'
            ?0.5*brierLoss+0.5*logLoss:brierLoss;
      if(!directionalLoss)weightedObjectiveLoss+=objectiveLoss*row.sample_weight;
      // Optimize the proper-score objective by default. The optional ranking
      // path supplies an exact derivative of its composite objective w.r.t. logit.
      const brierGradient=2*(probability-row.target)*probability*(1-probability);
      const logLossGradient=probability-row.target;
      const error=directionalLoss
        ?directionalLoss.gradient_logits[rowIndex]*totalSampleWeight
        :trainingObjective==='FOCAL_ASYMMETRIC_BRIER'
          ?focalAsymmetricBrierLoss(safeProbability,row.target,focalWeights).logitGradient
          :(trainingObjective==='UNWEIGHTED_LOG_LOSS_PROPER_SCORING_RULE'
            ?logLossGradient
            :trainingObjective==='MIXED_BRIER_LOG_LOSS_50_50_PROPER_SCORING_RULE'
              ?0.5*brierGradient+0.5*logLossGradient
              :brierGradient)*row.sample_weight;
      // The same-window logistic path is a frozen anchor. Only the hidden
      // nonlinear branch is trained, so a weak residual cannot erase the
      // simpler model that already supplied the initial prediction.
      if(anchorAdaptationEnabled){
        gradOutputBias+=error;
        for(let i=0;i<inputSize;i++)gradSkip[i]+=error*row.vector[i];
      }
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

    const n=Math.max(1,totalSampleWeight);
    const trainingObjectiveScore=weightedObjectiveLoss/n;
    if(!Number.isFinite(trainingObjectiveScore))
      throw new TypeError('NEURAL_TRAINING_OBJECTIVE_NON_FINITE');
    if(trainingObjectiveScore<bestTrainingObjective-checkpointMinDelta){
      bestTrainingObjective=trainingObjectiveScore;
      bestEpoch=epoch;
      epochsWithoutImprovement=0;
      bestCheckpoint={
        inputWeights:inputWeights.map(row=>[...row]),
        hiddenWeights:hiddenWeights.map(row=>[...row]),
        hiddenBias1:[...hiddenBias1],hiddenBias2:[...hiddenBias2],
        outputWeights:[...outputWeights],skipWeights:[...skipWeights],
        outputBias
      };
    }else{
      epochsWithoutImprovement++;
    }
    const gradientLeaves=[
      ...gradInput.flat(),...gradHidden.flat(),...gradBias1,...gradBias2,...gradOutput,
      ...(gradSkip||[]),gradOutputBias
    ];
    if(gradientLeaves.some(value=>!Number.isFinite(value)))
      throw new TypeError('NEURAL_BACKPROP_NON_FINITE_GRADIENT');
    const meanGradientNorm=Math.sqrt(gradientLeaves.reduce((sum,value)=>
      sum+(value/n)**2,0));
    const clipScale=meanGradientNorm>maximumGradientNorm
      ?maximumGradientNorm/meanGradientNorm:1;
    const epochRate=rate*(0.1+0.9*0.5*(1+Math.cos(
      Math.PI*(epoch-1)/Math.max(1,steps-1)
    )));
    if(anchorAdaptationEnabled){
      // This research mode updates the logistic skip path only inside a narrow
      // trust region around the training-only anchor. No validation/holdout
      // gradients or labels are ever used.
      for(let i=0;i<inputSize;i++){
        const gradient=gradSkip[i]/n+
          anchorTetherStrength*(skipWeights[i]-initialSkipWeights[i]);
        const result=update(skipWeights[i],gradient*clipScale,mSkip[i],vSkip[i],epoch,4,false,
          anchorLearningRateScale,epochRate);
        skipWeights[i]=clamp(result.value,
          initialSkipWeights[i]-anchorTrustRadius,
          initialSkipWeights[i]+anchorTrustRadius);
        mSkip[i]=result.moment;vSkip[i]=result.variance;
      }
      const biasGradient=gradOutputBias/n+
        anchorTetherStrength*(outputBias-initialOutputBias);
      const biasResult=update(outputBias,biasGradient*clipScale,mOutputBias,vOutputBias,epoch,12,false,
        anchorLearningRateScale,epochRate);
      outputBias=clamp(biasResult.value,
        initialOutputBias-anchorBiasTrustRadius,
        initialOutputBias+anchorBiasTrustRadius);
      mOutputBias=biasResult.moment;vOutputBias=biasResult.variance;
    }
    for(let i=0;i<inputSize;i++)for(let j=0;j<units1;j++){
      const result=update(inputWeights[i][j],gradInput[i][j]/n*clipScale,mInput[i][j],vInput[i][j],epoch,3,true,1,epochRate);
      inputWeights[i][j]=result.value;mInput[i][j]=result.moment;vInput[i][j]=result.variance;
    }
    for(let i=0;i<units1;i++)for(let j=0;j<units2;j++){
      const result=update(hiddenWeights[i][j],gradHidden[i][j]/n*clipScale,mHidden[i][j],vHidden[i][j],epoch,3,true,1,epochRate);
      hiddenWeights[i][j]=result.value;mHidden[i][j]=result.moment;vHidden[i][j]=result.variance;
    }
    for(let j=0;j<units1;j++){
      const result=update(hiddenBias1[j],gradBias1[j]/n*clipScale,mBias1[j],vBias1[j],epoch,4,false,1,epochRate);
      hiddenBias1[j]=result.value;mBias1[j]=result.moment;vBias1[j]=result.variance;
    }
    for(let j=0;j<units2;j++){
      const bias=update(hiddenBias2[j],gradBias2[j]/n*clipScale,mBias2[j],vBias2[j],epoch,4,false,1,epochRate);
      hiddenBias2[j]=bias.value;mBias2[j]=bias.moment;vBias2[j]=bias.variance;
      const output=update(outputWeights[j],gradOutput[j]/n*clipScale,mOutput[j],vOutput[j],epoch,3,true,1,epochRate);
      outputWeights[j]=output.value;mOutput[j]=output.moment;vOutput[j]=output.variance;
    }
    const parameterLeaves=[
      ...inputWeights.flat(),...hiddenWeights.flat(),...hiddenBias1,...hiddenBias2,
      ...outputWeights,...skipWeights,outputBias
    ];
    if(parameterLeaves.some(value=>!Number.isFinite(value)))
      throw new TypeError('NEURAL_UPDATE_NON_FINITE_PARAMETER');
    epochHistory.push({
      epoch,
      pre_update_weighted_brier:Number((weightedBrier/n).toFixed(8)),
      gradient_l2_norm:Number(meanGradientNorm.toFixed(8)),
      clip_scale:Number(clipScale.toFixed(8)),
      learning_rate:Number(epochRate.toFixed(8)),
      pre_update_training_objective:Number(trainingObjectiveScore.toFixed(8)),
      directional_ranking_loss:directionalLoss?.metrics??null,
      best_training_objective:Number(bestTrainingObjective.toFixed(8))
    });
    // The stop signal is derived exclusively from the training block. It does
    // not read validation, calibration-check or untouched holdout outcomes.
    if(epoch>=minimumEpochs&&epochsWithoutImprovement>=earlyStoppingPatience){
      stoppedEarly=true;
      break;
    }
    // In the default mode, skipWeights and outputBias remain exactly frozen.
    // The opt-in trust-region experiment constrains all linear-anchor movement.
  }

  if(!bestCheckpoint)throw new Error('NEURAL_BEST_CHECKPOINT_MISSING');
  for(let index=0;index<inputWeights.length;index++)
    inputWeights[index]=[...bestCheckpoint.inputWeights[index]];
  for(let index=0;index<hiddenWeights.length;index++)
    hiddenWeights[index]=[...bestCheckpoint.hiddenWeights[index]];
  hiddenBias1.splice(0,hiddenBias1.length,...bestCheckpoint.hiddenBias1);
  hiddenBias2.splice(0,hiddenBias2.length,...bestCheckpoint.hiddenBias2);
  outputWeights.splice(0,outputWeights.length,...bestCheckpoint.outputWeights);
  skipWeights.splice(0,skipWeights.length,...bestCheckpoint.skipWeights);
  outputBias=bestCheckpoint.outputBias;

  const maxAnchorSkipDelta=skipWeights.reduce((maximum,value,index)=>
    Math.max(maximum,Math.abs(value-initialSkipWeights[index])),0);
  const anchorAdaptationMode=anchorAdaptationEnabled
    ?'TRUST_REGION_TETHERED_V1':hasBaseline?'FROZEN_LOGISTIC':'FROZEN_TRAINING_PRIOR';
  return {
    kind:'RESIDUAL_DEEP_MLP_V2',
    architecture:inputSize+'-'+units1+'-'+units2+'-1+RESIDUAL',
    input_size:inputSize,hidden_units:units1,second_hidden_units:units2,output_size:1,
    input_weights:inputWeights,hidden_bias_1:hiddenBias1,
    hidden_weights:hiddenWeights,hidden_bias_2:hiddenBias2,
    output_weights:outputWeights,output_bias:outputBias,skip_weights:skipWeights,
    base_rate:baseRate,feature_names:[...featureNames],feature_schema:featureSchema,
    training_samples:rows.length,positive_samples:positiveSamples,negative_samples:negativeSamples,
    positive_class_weighting:isFocalObjective
      ?'FOCAL_ASYMMETRIC_BRIER_TRAIN_ONLY_CLASS_WEIGHTS'
      :usePositiveClassWeighting?'SQRT_INVERSE_PREVALENCE':'NONE',
    focal_positive_weight:focalWeights.positiveWeight,
    focal_negative_weight:focalWeights.negativeWeight,
    positive_sample_weight:Number(positiveSampleWeight.toFixed(5)),
    iterations:steps,l2:regularization,
    requested_iterations:steps,
    epochs_completed:epochHistory.length,
    best_epoch:bestEpoch,
    optimizer:'ADAMW_DECOUPLED_WEIGHT_DECAY',
    scheduler:'COSINE_DECAY_10_PERCENT_FLOOR',
    gradient_clip_norm:maximumGradientNorm,
    training_diagnostics:{
      schema:'COGNITIVE_MLP_NUMERICAL_TRAINING_AUDIT_V1',
      epochs_completed:epochHistory.length,
      requested_epochs:steps,
      best_epoch:bestEpoch,
      best_training_objective:Number(bestTrainingObjective.toFixed(8)),
      early_stopping:{
        enabled:true,monitor:'TRAINING_BLOCK_OBJECTIVE_ONLY',
        patience:earlyStoppingPatience,minimum_epochs:minimumEpochs,
        stopped_early:stoppedEarly,restored_best_checkpoint:true,
        validation_or_holdout_used:false
      },
      all_gradients_finite:true,all_parameters_finite:true,
      initial_pre_update_brier:epochHistory[0]?.pre_update_weighted_brier??null,
      final_pre_update_brier:epochHistory.at(-1)?.pre_update_weighted_brier??null,
      maximum_gradient_l2_norm:Number(Math.max(...epochHistory.map(row=>row.gradient_l2_norm)).toFixed(8)),
      epoch_history:epochHistory
    },
    output_initialization_scale:outputHeadInitializationScale,
    training_objective:trainingObjective,
    anchor_adaptation:anchorAdaptationMode,
    anchor_trust_radius:anchorAdaptationEnabled?anchorTrustRadius:0,
    anchor_bias_trust_radius:anchorAdaptationEnabled?anchorBiasTrustRadius:0,
    anchor_tether_strength:anchorAdaptationEnabled?anchorTetherStrength:0,
    anchor_learning_rate_scale:anchorAdaptationEnabled?anchorLearningRateScale:0,
    max_anchor_skip_delta:Number(maxAnchorSkipDelta.toFixed(6)),
    anchor_output_bias_delta:Number(Math.abs(outputBias-initialOutputBias).toFixed(6)),
    residual_anchor:anchorAdaptationEnabled
      ?'SAME_WINDOW_LOGISTIC_TRUST_REGION_TETHERED_V1'
      :hasBaseline?'SAME_WINDOW_LOGISTIC_FROZEN':'TRAINING_PREVALENCE_PRIOR'
  };
}


export function auditNeuralOneBatchOverfit(trainingRows,{
  iterations=120,seed=17
}={}){
  if(!Array.isArray(trainingRows)||trainingRows.length!==32)
    throw new TypeError('NEURAL_OVERFIT_AUDIT_REQUIRES_EXACTLY_32_ROWS');
  const schema=trainingRows[0]?.feature_schema||COGNITIVE_FEATURE_SCHEMA;
  const names=[...(trainingRows[0]?.feature_names||featureNamesForSchema(schema))];
  if(trainingRows.some(row=>!row||!row.features||typeof row.features!=='object'||
      !Number.isInteger(row.target)||![0,1].includes(row.target)))
    throw new TypeError('NEURAL_OVERFIT_AUDIT_REQUIRES_BINARY_FEATURE_ROWS');
  const prepared=trainingRows.map(row=>({
    ...row,feature_schema:row.feature_schema??schema,
    feature_names:row.feature_names??names,
    vector:row.vector??normalizedFeatures(row.features,schema)
  }));
  assertNeuralFeatureBatch(prepared,names,schema);
  const fit=fitNeuralNetworkModel(prepared,{
    hiddenUnits:16,secondHiddenUnits:12,iterations,
    learningRate:0.04,l2:0.001,seed,baselineFit:null,
    trainingObjective:'UNWEIGHTED_LOG_LOSS_PROPER_SCORING_RULE',
    positiveClassWeighting:'NONE',outputInitializationScale:0.12
  });
  if(!fit)throw new Error('NEURAL_OVERFIT_AUDIT_FIT_FAILED');
  const probabilities=prepared.map(row=>{
    const h1=fit.hidden_bias_1.map((bias,j)=>{
      let value=bias;
      for(let i=0;i<row.vector.length;i++)value+=row.vector[i]*fit.input_weights[i][j];
      return Math.tanh(value);
    });
    const h2=fit.hidden_bias_2.map((bias,j)=>{
      let value=bias;
      for(let i=0;i<h1.length;i++)value+=h1[i]*fit.hidden_weights[i][j];
      return Math.tanh(value);
    });
    let value=fit.output_bias;
    for(let j=0;j<h2.length;j++)value+=fit.output_weights[j]*h2[j];
    return logistic(value);
  });
  const finitePredictions=probabilities.every(Number.isFinite);
  const brier=finitePredictions?mean(probabilities.map((value,index)=>
    (value-prepared[index].target)**2)):null;
  const accuracy=finitePredictions?Number((probabilities.filter((value,index)=>
    (value>=0.5)===Boolean(prepared[index].target)).length/32*100).toFixed(2)):null;
  const diagnostics=fit.training_diagnostics||{};
  return {
    schema:'COGNITIVE_MLP_32_SAMPLE_OVERFIT_AUDIT_V1',
    diagnostic_only:true,production_training_changed:false,
    sample_count:32,feature_count:fit.input_size,feature_schema:fit.feature_schema,
    architecture:fit.architecture,
    epochs_completed:diagnostics.epochs_completed??fit.iterations,
    requested_epochs:diagnostics.requested_epochs??fit.iterations,
    best_epoch:diagnostics.best_epoch??null,
    best_training_objective:diagnostics.best_training_objective??null,
    early_stopping:diagnostics.early_stopping??null,
    finite_predictions:finitePredictions,
    all_gradients_finite:diagnostics.all_gradients_finite===true,
    all_parameters_finite:diagnostics.all_parameters_finite===true,
    optimizer:fit.optimizer,
    scheduler:fit.scheduler,
    gradient_clip_norm:fit.gradient_clip_norm,
    initial_brier:diagnostics.initial_pre_update_brier,
    final_training_brier:diagnostics.final_pre_update_brier,
    post_fit_brier:brier,post_fit_accuracy_pct:accuracy,
    passed:finitePredictions&&diagnostics.all_gradients_finite===true&&
      diagnostics.all_parameters_finite===true&&brier!==null&&brier<=0.01&&accuracy===100
  };
}

export function factorizationMachineProjection(vector,factors){
  if(!Array.isArray(vector)||!vector.length||
    !vector.every(value=>finite(value)!==null)||
    !Array.isArray(factors)||factors.length!==vector.length||
    !Array.isArray(factors[0])||!factors[0].length||
    factors.some(row=>!Array.isArray(row)||row.length!==factors[0].length||
      row.some(value=>finite(value)===null)))return null;
  const rank=factors[0].length;
  const sums=Array(rank).fill(0),sumSquares=Array(rank).fill(0);
  for(let feature=0;feature<vector.length;feature++){
    const x=Number(vector[feature]);
    for(let component=0;component<rank;component++){
      const value=Number(factors[feature][component])*x;
      sums[component]+=value;sumSquares[component]+=value*value;
    }
  }
  const interactions=sums.map((sum,component)=>0.5*(sum*sum-sumSquares[component]));
  const factorDerivatives=factors.map((row,feature)=>
    row.map((weight,component)=>Number(vector[feature])*
      (sums[component]-Number(weight)*Number(vector[feature]))));
  if(interactions.some(value=>!Number.isFinite(value))||
    factorDerivatives.some(row=>row.some(value=>!Number.isFinite(value))))return null;
  return {interactions,factor_derivatives:factorDerivatives,sums};
}

export function predictFactorizationMachineProbability(vector,fit,residualScale=1){
  if(fit?.kind!=='RESIDUAL_FACTOR_CROSS_V1'||
    !Array.isArray(fit.skip_weights)||fit.skip_weights.length!==vector?.length||
    !Array.isArray(fit.factors)||fit.factors.length!==vector.length||
    !Array.isArray(fit.cross_weights)||!Number.isFinite(Number(fit.intercept)))return null;
  const projection=factorizationMachineProjection(vector,fit.factors);
  if(!projection||projection.interactions.length!==fit.cross_weights.length)return null;
  let logit=Number(fit.intercept);
  for(let index=0;index<vector.length;index++)
    logit+=Number(fit.skip_weights[index])*Number(vector[index]);
  const scale=clamp(finite(residualScale)??1,0,1);
  for(let component=0;component<fit.cross_weights.length;component++)
    logit+=scale*Number(fit.cross_weights[component])*projection.interactions[component];
  return Number.isFinite(logit)?clamp(logistic(logit),0.02,0.98):null;
}

/**
 * Low-rank Factorization-Machine residual challenger.
 * The same-window logistic skip path is frozen; only pairwise feature
 * interactions are learned. No selection, calibration, validation or holdout
 * labels enter the gradient path.
 */
export function fitFactorizationMachineModel(training,{
  baselineFit=null,rank=8,iterations=100,learningRate=0.008,l2=0.06,seed=73,
  trainingObjective='UNWEIGHTED_BRIER_PROPER_SCORING_RULE',
  positiveClassWeighting='NONE'
}={}){
  const sourceRows=Array.isArray(training)?training:[];
  const featureNames=[...(sourceRows[0]?.feature_names||FEATURE_NAMES)];
  const featureSchema=sourceRows[0]?.feature_schema||COGNITIVE_FEATURE_SCHEMA;
  const featureCount=featureNames.length;
  assertNeuralFeatureBatch(sourceRows,featureNames,featureSchema);
  const rows=sourceRows.map(row=>({
    vector:Array.isArray(row.vector)?row.vector:normalizedFeatures(row.features,featureSchema),
    target:finite(row.target)===null?targetOf(row):clamp(Number(row.target),0,1)
  }));
  if(rows.length<NEURAL_POLICY.minTrainingSamples)return null;
  const positiveSamples=rows.filter(row=>row.target>0.5).length;
  const negativeSamples=rows.length-positiveSamples;
  const useWeighting=positiveClassWeighting==='SQRT_INVERSE_PREVALENCE';
  const positiveWeight=useWeighting&&positiveSamples>0
    ?clamp(Math.sqrt(negativeSamples/positiveSamples),1,3):1;
  const totalSampleWeight=negativeSamples+positiveSamples*positiveWeight;
  const dimensions=Math.max(2,Math.min(16,Math.trunc(Number(rank)||8)));
  const steps=Math.max(30,Math.min(180,Math.trunc(Number(iterations)||100)));
  const rate=clamp(Number(learningRate)||0.008,0.0005,0.03);
  const regularization=clamp(Number(l2)||0.06,0.001,0.5);
  const seedValue=Math.max(1,Math.min(997,Math.trunc(Number(seed)||73)));
  const seedOffset=seedValue*0.6180339887498949;
  const baseRate=betaRate(rows.reduce((sum,row)=>sum+row.target,0),rows.length);
  const validBaseline=baselineFit&&Array.isArray(baselineFit.weights)&&
    baselineFit.weights.length===featureCount&&Number.isFinite(Number(baselineFit.intercept));
  const skipWeights=validBaseline
    ?baselineFit.weights.map(value=>clamp(Number(value)||0,-4,4))
    :Array(featureCount).fill(0);
  const intercept=validBaseline?Number(baselineFit.intercept):logit(baseRate);
  const factors=Array.from({length:featureCount},(_,feature)=>
    Array.from({length:dimensions},(_,component)=>
      0.055*Math.sin((feature+1)*7.913+(component+1)*3.117+seedOffset)));
  const crossWeights=Array.from({length:dimensions},(_,component)=>
    0.08*Math.cos((component+1)*5.731+seedOffset));
  const firstFactorMoment=factors.map(row=>row.map(()=>0));
  const secondFactorMoment=factors.map(row=>row.map(()=>0));
  const firstCrossMoment=Array(dimensions).fill(0);
  const secondCrossMoment=Array(dimensions).fill(0);
  const maximumGradientNorm=1.0;
  const earlyStoppingPatience=Math.min(20,Math.max(8,Math.ceil(steps*0.25)));
  const minimumEpochs=Math.min(30,steps);
  const checkpointMinDelta=1e-8;
  const epochHistory=[];
  let bestTrainingObjective=Number.POSITIVE_INFINITY,bestEpoch=0;
  let epochsWithoutImprovement=0,bestCheckpoint=null,stoppedEarly=false;
  for(let epoch=1;epoch<=steps;epoch++){
    const factorGradient=factors.map(row=>row.map(()=>0));
    const crossGradient=Array(dimensions).fill(0);
    let lossSum=0;
    for(const row of rows){
      const projection=factorizationMachineProjection(row.vector,factors);
      if(!projection)throw new TypeError('FACTOR_CROSS_PROJECTION_INVALID');
      const sampleWeight=row.target>0.5?positiveWeight:1;
      const probability=predictFactorizationMachineProbability(row.vector,{
        kind:'RESIDUAL_FACTOR_CROSS_V1',skip_weights:skipWeights,
        intercept,factors,cross_weights:crossWeights
      },1);
      if(!Number.isFinite(probability))
        throw new TypeError('FACTOR_CROSS_NON_FINITE_PROBABILITY');
      const safeProbability=clamp(probability,1e-12,1-1e-12);
      const brierGradient=2*(safeProbability-row.target)*safeProbability*(1-safeProbability);
      const logLossGradient=safeProbability-row.target;
      const error=(trainingObjective==='UNWEIGHTED_LOG_LOSS_PROPER_SCORING_RULE'
        ?logLossGradient
        :trainingObjective==='MIXED_BRIER_LOG_LOSS_50_50_PROPER_SCORING_RULE'
          ?0.5*brierGradient+0.5*logLossGradient:brierGradient)*sampleWeight;
      const brierLoss=(safeProbability-row.target)**2;
      const logLoss=-(row.target*Math.log(safeProbability)+
        (1-row.target)*Math.log(1-safeProbability));
      const objectiveLoss=trainingObjective==='UNWEIGHTED_LOG_LOSS_PROPER_SCORING_RULE'
        ?logLoss
        :trainingObjective==='MIXED_BRIER_LOG_LOSS_50_50_PROPER_SCORING_RULE'
          ?0.5*brierLoss+0.5*logLoss:brierLoss;
      lossSum+=objectiveLoss*sampleWeight;
      for(let component=0;component<dimensions;component++){
        crossGradient[component]+=error*projection.interactions[component];
        for(let feature=0;feature<featureCount;feature++)
          factorGradient[feature][component]+=error*crossWeights[component]*
            projection.factor_derivatives[feature][component];
      }
    }
    const objectiveScore=lossSum/Math.max(1,totalSampleWeight);
    if(!Number.isFinite(objectiveScore))
      throw new TypeError('FACTOR_CROSS_TRAINING_OBJECTIVE_NON_FINITE');
    if(objectiveScore<bestTrainingObjective-checkpointMinDelta){
      bestTrainingObjective=objectiveScore;
      bestEpoch=epoch;
      epochsWithoutImprovement=0;
      bestCheckpoint={
        factors:factors.map(row=>[...row]),
        crossWeights:[...crossWeights]
      };
    }else{
      epochsWithoutImprovement++;
    }
    const averagedFactorGradient=factorGradient.map(row=>
      row.map(value=>value/Math.max(1,totalSampleWeight)));
    const averagedCrossGradient=crossGradient.map(value=>
      value/Math.max(1,totalSampleWeight));
    const gradientLeaves=[...averagedFactorGradient.flat(),...averagedCrossGradient];
    if(gradientLeaves.some(value=>!Number.isFinite(value)))
      throw new TypeError('FACTOR_CROSS_NON_FINITE_GRADIENT');
    const gradientL2Norm=Math.sqrt(gradientLeaves.reduce((sum,value)=>sum+value*value,0));
    if(!Number.isFinite(gradientL2Norm))
      throw new TypeError('FACTOR_CROSS_GRADIENT_NORM_NON_FINITE');
    const gradientClipScale=gradientL2Norm>maximumGradientNorm
      ?maximumGradientNorm/gradientL2Norm:1;
    const epochRate=rate*(0.1+0.9*0.5*(1+Math.cos(
      Math.PI*(epoch-1)/Math.max(1,steps-1)
    )));
    for(let feature=0;feature<featureCount;feature++)for(let component=0;component<dimensions;component++){
      const gradient=clamp(averagedFactorGradient[feature][component]*gradientClipScale,-3,3);
      const m=0.9*firstFactorMoment[feature][component]+0.1*gradient;
      const v=0.999*secondFactorMoment[feature][component]+0.001*gradient*gradient;
      firstFactorMoment[feature][component]=m;secondFactorMoment[feature][component]=v;
      const mHat=m/(1-Math.pow(0.9,epoch)),vHat=v/(1-Math.pow(0.999,epoch));
      const decayed=factors[feature][component]*(1-epochRate*regularization);
      factors[feature][component]=clamp(decayed-
        epochRate*mHat/(Math.sqrt(vHat)+1e-8),-2.5,2.5);
    }
    for(let component=0;component<dimensions;component++){
      const gradient=clamp(averagedCrossGradient[component]*gradientClipScale,-3,3);
      const m=0.9*firstCrossMoment[component]+0.1*gradient;
      const v=0.999*secondCrossMoment[component]+0.001*gradient*gradient;
      firstCrossMoment[component]=m;secondCrossMoment[component]=v;
      const mHat=m/(1-Math.pow(0.9,epoch)),vHat=v/(1-Math.pow(0.999,epoch));
      const decayed=crossWeights[component]*(1-epochRate*regularization);
      crossWeights[component]=clamp(decayed-
        epochRate*mHat/(Math.sqrt(vHat)+1e-8),-2.5,2.5);
    }
    const parametersFinite=factors.flat().every(Number.isFinite)&&crossWeights.every(Number.isFinite);
    if(!parametersFinite)throw new TypeError('FACTOR_CROSS_OPTIMIZER_NON_FINITE_PARAMETER');
    epochHistory.push({
      epoch,mean_training_objective:Number(objectiveScore.toFixed(8)),
      best_training_objective:Number(bestTrainingObjective.toFixed(8)),
      gradient_l2_norm:Number(gradientL2Norm.toFixed(8)),
      gradient_clip_scale:Number(gradientClipScale.toFixed(8)),
      learning_rate:Number(epochRate.toFixed(8)),
      factor_l2_norm:Number(Math.sqrt(factors.flat().reduce((sum,value)=>sum+value*value,0)).toFixed(8)),
      cross_head_l2_norm:Number(Math.sqrt(crossWeights.reduce((sum,value)=>sum+value*value,0)).toFixed(8))
    });
    if(epoch>=minimumEpochs&&epochsWithoutImprovement>=earlyStoppingPatience){
      stoppedEarly=true;
      break;
    }
  }
  if(!bestCheckpoint)throw new Error('FACTOR_CROSS_BEST_CHECKPOINT_MISSING');
  for(let feature=0;feature<featureCount;feature++)
    factors[feature]=[...bestCheckpoint.factors[feature]];
  crossWeights.splice(0,crossWeights.length,...bestCheckpoint.crossWeights);
  return {
    kind:'RESIDUAL_FACTOR_CROSS_V1',
    architecture:featureCount+'x'+dimensions+'-FACTOR_CROSS+FROZEN_LOGISTIC',
    input_size:featureCount,rank:dimensions,feature_names:[...featureNames],
    feature_schema:featureSchema,factors,cross_weights:crossWeights,
    skip_weights:skipWeights,intercept,base_rate:baseRate,
    training_samples:rows.length,positive_samples:positiveSamples,negative_samples:negativeSamples,
    positive_class_weighting:useWeighting?'SQRT_INVERSE_PREVALENCE':'NONE',
    positive_sample_weight:Number(positiveWeight.toFixed(5)),
    training_objective:trainingObjective,
    focal_asymmetric_brier:isFocalObjective?{
      gamma_positive:focalGammaPositive,gamma_negative:focalGammaNegative,
      positive_weight:focalWeights.positiveWeight,negative_weight:focalWeights.negativeWeight,
      weights_derived_from:'CURRENT_TRAINING_PARTITION_ONLY'
    }:null,
    iterations:epochHistory.length,
    requested_iterations:steps,l2:regularization,
    optimizer:'ADAMW_DECOUPLED_WEIGHT_DECAY',
    scheduler:'COSINE_DECAY_10_PERCENT_FLOOR',
    gradient_clip_norm:maximumGradientNorm,
    anchor_adaptation:'FROZEN_LOGISTIC',anchor_trust_radius:0,anchor_bias_trust_radius:0,
    anchor_tether_strength:0,anchor_learning_rate_scale:0,
    max_anchor_skip_delta:0,anchor_output_bias_delta:0,
    residual_anchor:validBaseline?'SAME_WINDOW_LOGISTIC_FROZEN':'TRAINING_PREVALENCE_PRIOR',
    training_diagnostics:{
      schema:'FACTOR_CROSS_PER_EPOCH_TRAINING_DIAGNOSTICS_V2',
      epochs_completed:epochHistory.length,requested_epochs:steps,
      best_epoch:bestEpoch,best_training_objective:Number(bestTrainingObjective.toFixed(8)),
      optimizer:'ADAMW_DECOUPLED_WEIGHT_DECAY',
      scheduler:'COSINE_DECAY_10_PERCENT_FLOOR',
      gradient_clip_norm:maximumGradientNorm,
      early_stopping:{
        enabled:true,monitor:'TRAINING_BLOCK_OBJECTIVE_ONLY',
        patience:earlyStoppingPatience,minimum_epochs:minimumEpochs,
        stopped_early:stoppedEarly,restored_best_checkpoint:true,
        validation_or_holdout_used:false
      },
      all_gradients_finite:true,all_parameters_finite:true,
      epoch_history:epochHistory
    }
  };
}

function fitNeuralEnsemble(training, options = {}) {
  const seeds=NEURAL_POLICY.ensembleSeeds;
  const baseIterations=Math.max(30,Math.min(180,Math.trunc(Number(options.iterations)||NEURAL_POLICY.iterations)));
  const baseLearningRate=clamp(Number(options.learningRate)||NEURAL_POLICY.learningRate,0.001,0.04);
  const baseL2=clamp(Number(options.l2)||NEURAL_POLICY.l2,0.001,0.5);
  const outputInitializationScale=clamp(Number(options.outputInitializationScale)||0.015,0.005,0.12);
  // Keep total optimization work equal to three base schedules while reducing
  // dependence on one epoch/regularization choice. Selection remains on the
  // chronological validation block; the untouched holdout is never consulted.
  const enabledDirectionalLoss=options.enableAsymmetricDirectionalRankingLoss===true;
  const objectiveFor=objective=>enabledDirectionalLoss
    ?'ASYMMETRIC_DIRECTIONAL_RANKING_V1':objective;
  const memberProfiles=[
    {iterations:Math.max(30,Math.ceil(baseIterations*0.6)),learningRate:baseLearningRate*0.9,l2:baseL2*1.5,
      outputInitializationScale,
      trainingObjective:objectiveFor('FOCAL_ASYMMETRIC_BRIER'),
      focalGammaPositive:1,focalGammaNegative:2,
      positiveClassWeighting:'FOCAL_ASYMMETRIC_BRIER_TRAIN_ONLY_CLASS_WEIGHTS'},
    {iterations:baseIterations,learningRate:baseLearningRate,l2:baseL2,
      outputInitializationScale,
      trainingObjective:objectiveFor('FOCAL_ASYMMETRIC_BRIER'),
      focalGammaPositive:0.5,focalGammaNegative:2,
      positiveClassWeighting:'FOCAL_ASYMMETRIC_BRIER_TRAIN_ONLY_CLASS_WEIGHTS'},
    {iterations:Math.min(180,Math.ceil(baseIterations*1.4)),learningRate:baseLearningRate*0.75,l2:baseL2*2,
      outputInitializationScale,
      trainingObjective:objectiveFor('FOCAL_ASYMMETRIC_BRIER'),
      focalGammaPositive:1.5,focalGammaNegative:2.5,
      positiveClassWeighting:'FOCAL_ASYMMETRIC_BRIER_TRAIN_ONLY_CLASS_WEIGHTS'}
  ];
  const members=seeds.map((seed,index)=>fitNeuralNetworkModel(training,{
    ...options,...memberProfiles[index],seed
  }));
  const memberSeeds=[...seeds];
  const factorizationMemberIndex=options.enableFactorizationMachine===true?members.length:-1;
  if(options.enableFactorizationMachine===true){
    const factorizationProfile={
      model_kind:'RESIDUAL_FACTOR_CROSS_V1',
      rank:Math.max(2,Math.min(16,Math.trunc(Number(options.factorizationRank)||8))),
      iterations:Math.max(30,Math.min(180,Math.trunc(Number(options.factorizationIterations)||baseIterations))),
      learningRate:clamp(Number(options.factorizationLearningRate)||baseLearningRate*0.75,0.0005,0.03),
      l2:clamp(Number(options.factorizationL2)||baseL2*1.5,0.001,0.5),
      seed:Math.max(1,Math.min(997,Math.trunc(Number(options.factorizationSeed)||73))),
      trainingObjective:'UNWEIGHTED_BRIER_PROPER_SCORING_RULE',
      positiveClassWeighting:'NONE'
    };
    const factorizationMember=fitFactorizationMachineModel(training,{
      baselineFit:options.baselineFit,...factorizationProfile
    });
    if(!factorizationMember)return null;
    members.push(factorizationMember);memberSeeds.push(factorizationProfile.seed);
    memberProfiles.push(factorizationProfile);
  }
  if(members.length!==memberSeeds.length||members.some(member=>!member))return null;
  const completedMemberProfiles=memberProfiles.map((profile,index)=>({
    ...profile,
    requested_iterations:profile.iterations,
    iterations:members[index]?.training_diagnostics?.epochs_completed??profile.iterations,
    best_epoch:members[index]?.training_diagnostics?.best_epoch??null,
    best_training_objective:members[index]?.training_diagnostics?.best_training_objective??null,
    early_stopping:members[index]?.training_diagnostics?.early_stopping??null
  }));
  return {
    kind:'RESIDUAL_DEEP_MLP_ENSEMBLE_V3',
    architecture:members[0].architecture,
    input_size:members[0].input_size,
    hidden_units:NEURAL_POLICY.hiddenUnits,
    second_hidden_units:NEURAL_POLICY.secondHiddenUnits,
    output_size:1,
    members,
    ensemble_members:members.length,
    seeds:memberSeeds,
    factorization_member_index:factorizationMemberIndex,
    member_training_profiles:completedMemberProfiles,
    member_training_diagnostics:members.map((member,index)=>({
      member_index:index,seed:memberSeeds[index],
      ...(member?.training_diagnostics||{})
    })),
    training_strategy:factorizationMemberIndex>=0
      ?'RESIDUAL_MLP_PLUS_LOW_RANK_FACTOR_CROSS_V1_SAME_WINDOW_LOGISTIC_ANCHOR'
      :'FOCAL_ASYMMETRIC_BRIER_RESIDUAL_MLP_VALIDATION_SHRUNK_V1_TRAIN_ONLY_CLASS_BALANCE',
    training_objective:'FOCAL_ASYMMETRIC_BRIER_ENSEMBLE_WITH_TRAIN_ONLY_CLASS_WEIGHTS_V1',
    member_training_objectives:memberProfiles.map(profile=>profile.trainingObjective),
    residual_scale_selection:'CHRONOLOGICAL_VALIDATION_BLOCK_BRIER_GRID_V1',
    candidate_residual_scales:[...NEURAL_RESIDUAL_SCALES],
    base_rate:mean(members.map(member=>member.base_rate)),
    output_initialization_scale:members[0].output_initialization_scale??outputInitializationScale,
    feature_names:[...members[0].feature_names],
    feature_schema:members[0].feature_schema,
    anchor_adaptation:members[0].anchor_adaptation,
    anchor_adaptation_mode:options.anchorAdaptation||'FROZEN',
    anchor_trust_radius:members[0].anchor_trust_radius,
    anchor_bias_trust_radius:members[0].anchor_bias_trust_radius,
    anchor_tether_strength:members[0].anchor_tether_strength,
    anchor_learning_rate_scale:members[0].anchor_learning_rate_scale,
    max_anchor_skip_delta:Math.max(...members.map(member=>member.max_anchor_skip_delta||0)),
    anchor_output_bias_delta:Math.max(...members.map(member=>member.anchor_output_bias_delta||0)),
    training_samples:members[0].training_samples,
    iterations:baseIterations,
    l2:baseL2
  };
}

function applyAcceptedProbabilityCalibration(rawProbability,calibration){
  if(!Number.isFinite(rawProbability))return null;
  const raw=clamp(rawProbability,0.02,0.98);
  if(calibration?.accepted!==true)return raw;
  const slope=clamp(Number(calibration.slope)||1,0.5,1.5);
  const intercept=clamp(Number(calibration.intercept)||0,-0.75,0.75);
  return clamp(logistic(slope*Math.log(raw/(1-raw))+intercept),0.02,0.98);
}

export function deriveBrierOptimalBlendWeight(
  boostedProbabilities,neuralProbabilities,targets
){
  if(!Array.isArray(boostedProbabilities)||!Array.isArray(neuralProbabilities)||
     !Array.isArray(targets)||boostedProbabilities.length!==neuralProbabilities.length||
     boostedProbabilities.length!==targets.length||targets.length<2)return null;
  let numerator=0,denominator=0;
  for(let index=0;index<targets.length;index++){
    const boosted=finite(boostedProbabilities[index]);
    const neural=finite(neuralProbabilities[index]);
    const target=finite(targets[index]);
    if(boosted===null||neural===null||target===null||
       boosted<0||boosted>1||neural<0||neural>1||![0,1].includes(target))
      return null;
    const delta=boosted-neural;
    numerator+=delta*(target-neural);
    denominator+=delta*delta;
  }
  if(!Number.isFinite(numerator)||!Number.isFinite(denominator)||denominator<=1e-12)
    return null;
  return clamp(numerator/denominator,0,1);
}

export function isMeaningfulHybridBlendWeight(weight,minimumComponentWeight=0.05){
  const value=finite(weight);
  const minimum=clamp(Number(minimumComponentWeight)||0.05,0.01,0.25);
  return value!==null&&value>=minimum&&value<=1-minimum;
}

export function hasSelectedNeuralResidual(fit){
  const index=fit?.selected_member_index;
  const scale=finite(fit?.selected_residual_scale);
  return fit?.kind==='RESIDUAL_DEEP_MLP_ENSEMBLE_V3'&&
    Array.isArray(fit.members)&&Array.isArray(fit.seeds)&&
    fit.members.length===fit.seeds.length&&
    Number.isInteger(index)&&index>=0&&index<fit.members.length&&
    scale!==null&&scale>0&&
    ['RESIDUAL_DEEP_MLP_V2','RESIDUAL_FACTOR_CROSS_V1'].includes(fit.members[index]?.kind);
}

export function isValidCognitiveMlpFit(fit){
  try{
    const schema=fit?.feature_schema||COGNITIVE_FEATURE_SCHEMA;
    const expectedNames=featureNamesForSchema(schema);
    const inputSize=Number(fit?.input_size);
    const hidden1=fit?.hidden_bias_1?.length;
    const hidden2=fit?.hidden_bias_2?.length;
    return fit?.kind==='RESIDUAL_DEEP_MLP_V2'&&
      Number.isInteger(inputSize)&&inputSize===expectedNames.length&&
      Array.isArray(fit.feature_names)&&
      JSON.stringify(fit.feature_names)===JSON.stringify(expectedNames)&&
      Array.isArray(fit.input_weights)&&fit.input_weights.length===inputSize&&
      Array.isArray(fit.hidden_bias_1)&&hidden1>0&&
      Array.isArray(fit.hidden_weights)&&fit.hidden_weights.length===hidden1&&
      fit.hidden_weights.every(row=>Array.isArray(row)&&row.length===hidden2&&
        row.every(Number.isFinite))&&
      fit.input_weights.every(row=>Array.isArray(row)&&row.length===hidden1&&
        row.every(Number.isFinite))&&
      Array.isArray(fit.hidden_bias_2)&&hidden2>0&&fit.hidden_bias_2.every(Number.isFinite)&&
      Array.isArray(fit.output_weights)&&fit.output_weights.length===hidden2&&
      fit.output_weights.every(Number.isFinite)&&
      Array.isArray(fit.skip_weights)&&fit.skip_weights.length===inputSize&&
      fit.skip_weights.every(Number.isFinite)&&
      fit.hidden_bias_1.every(Number.isFinite)&&
      Number.isFinite(fit.output_bias);
  }catch{return false;}
}

function predictFromFit(features, fit, residualScale=1) {
  if(fit?.kind==='RESIDUAL_GBDT_LOGISTIC_ANCHOR_V1'){
    return applyAcceptedProbabilityCalibration(
      predictResidualBoostedTrees(features,fit),fit.probability_calibrator
    );
  }
  if(fit?.kind==='BLENDED_GBDT_MLP_V1'){
    const boosted=predictFromFit(features,fit.boosted_fit);
    const neural=predictFromFit(features,fit.neural_fit);
    if(!Number.isFinite(boosted)||!Number.isFinite(neural))return null;
    const weight=clamp(Number(fit.boosted_weight)||0,0,1);
    return clamp(weight*boosted+(1-weight)*neural,0.02,0.98);
  }
  if(fit?.kind==='RESIDUAL_FACTOR_CROSS_V1'){
    const vector=normalizedFeatures(features,fit.feature_schema||COGNITIVE_FEATURE_SCHEMA);
    if(vector.length!==Number(fit.input_size))return null;
    return applyAcceptedProbabilityCalibration(
      predictFactorizationMachineProbability(
        vector,fit,finite(fit.residual_scale)??finite(residualScale)??1
      ),fit.probability_calibrator
    );
  }
  if(fit?.kind==='RESIDUAL_DEEP_MLP_ENSEMBLE_V3'){
    if(!hasSelectedNeuralResidual(fit))return null;
    const expectedMembers=fit.seeds.length;
    if(fit.members.length!==expectedMembers)return null;
    const rawPrediction=predictFromFit(
      features,fit.members[fit.selected_member_index],fit.selected_residual_scale
    );
    if(!Number.isFinite(rawPrediction))return null;
    return applyAcceptedProbabilityCalibration(rawPrediction,fit.probability_calibrator);
  }
  if(fit?.kind==='RESIDUAL_DEEP_MLP_V2'){
    const inputSize=Number(fit.input_size)||fit.feature_names?.length||FEATURE_NAMES.length;
    if(!isValidCognitiveMlpFit(fit))return null;
    const vector=normalizedFeatures(features,fit.feature_schema||COGNITIVE_FEATURE_SCHEMA);
    if(vector.length!==inputSize)return null;
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
    const inputSize=Number(fit.input_size)||fit.feature_names?.length||FEATURE_NAMES.length;
    if(!Array.isArray(fit.input_weights)||fit.input_weights.length!==inputSize||
       !Array.isArray(fit.hidden_bias)||!Array.isArray(fit.output_weights)||
       fit.hidden_bias.length!==fit.output_weights.length)return null;
    const vector=normalizedFeatures(features,fit.feature_schema||COGNITIVE_FEATURE_SCHEMA);
    if(vector.length!==inputSize)return null;
    const hidden=fit.hidden_bias.map((bias,j)=>{
      let sum=Number(bias)||0;
      for(let i=0;i<vector.length;i++)sum+=vector[i]*(Number(fit.input_weights[i]?.[j])||0);
      return Math.tanh(sum);
    });
    let output=Number(fit.output_bias)||0;
    for(let j=0;j<hidden.length;j++)output+=(Number(fit.output_weights[j])||0)*hidden[j];
    return clamp(logistic(output),0.02,0.98);
  }
  if (!fit || !Array.isArray(fit.weights) || fit.weights.length !== (fit.feature_names?.length||FEATURE_NAMES.length)) return null;
  const vector = normalizedFeatures(features,fit.feature_schema||COGNITIVE_FEATURE_SCHEMA);
  if(vector.length!==fit.weights.length)return null;
  let value = Number(fit.intercept) || 0;
  for (let i = 0; i < fit.weights.length; i++) value += Number(fit.weights[i] || 0) * vector[i];
  return applyAcceptedProbabilityCalibration(clamp(logistic(value),0.02,0.98),fit.probability_calibrator);
}


function fitAndSelectProbabilityCalibrator(fitRows,checkRows,fit,{
  minimumFitSamples=100,minimumFitPositive=50,minimumFitNegative=50,
  minimumCheckSamples=100,minimumCheckPositive=50,minimumCheckNegative=50,
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
    method:'DISJOINT_BRIER_PLATT_MODEL_CALIBRATION_V2',
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

/**
 * Rank only UP versus DOWN outcomes, matching evaluateFrozenRankingSignal()
 * used for the existing engine. FLAT remains a non-UP label for Brier/log-loss,
 * but is excluded from directional AUC and precision@K denominators.
 */
export function evaluateCognitiveDirectionalRanking(rows, predictions) {
  const sourceRows=Array.isArray(rows)?rows:[];
  const sourceScores=Array.isArray(predictions)?predictions:[];
  const allOutcomeCount=sourceRows.length;
  const ranked=sourceRows.map((row,index)=>({
    index,
    outcome:row?.outcome,
    score:finite(sourceScores[index])??Number.NEGATIVE_INFINITY
  })).filter(row=>row.outcome==='UP'||row.outcome==='DOWN')
    .sort((a,b)=>b.score-a.score||a.index-b.index);
  const positiveCount=ranked.filter(row=>row.outcome==='UP').length;
  const negativeCount=ranked.length-positiveCount;
  const directionalCount=ranked.length;
  const prevalenceAll=positiveCount/Math.max(1,allOutcomeCount);
  const prevalenceDirectional=positiveCount/Math.max(1,directionalCount);
  const rankingAtFraction=fraction=>{
    const selectedCount=Math.max(1,Math.min(directionalCount,Math.ceil(directionalCount*fraction)));
    const selected=ranked.slice(0,selectedCount);
    const selectedPositive=selected.filter(row=>row.outcome==='UP').length;
    const precision=selectedPositive/selectedCount;
    const recall=positiveCount?selectedPositive/positiveCount:null;
    return {
      sample_count:selectedCount,
      positive_samples:selectedPositive,
      selected_count:selectedCount,
      positive_count:selectedPositive,
      precision_pct:Number((precision*100).toFixed(3)),
      recall_pct:recall===null?null:Number((recall*100).toFixed(3)),
      lift_vs_prevalence:prevalenceAll>0?Number((precision/prevalenceAll).toFixed(5)):null,
      lift_vs_all_outcome_prevalence:prevalenceAll>0
        ?Number((precision/prevalenceAll).toFixed(5)):null,
      lift_vs_directional_prevalence:prevalenceDirectional>0
        ?Number((precision/prevalenceDirectional).toFixed(5)):null
    };
  };
  const ascending=ranked.slice().sort((a,b)=>a.score-b.score||a.index-b.index);
  let positiveRankSum=0;
  for(let start=0;start<ascending.length;){
    let end=start+1;
    while(end<ascending.length&&ascending[end].score===ascending[start].score)end++;
    const averageRank=((start+1)+end)/2;
    let groupPositive=0;
    for(let index=start;index<end;index++)
      if(ascending[index].outcome==='UP')groupPositive++;
    positiveRankSum+=groupPositive*averageRank;
    start=end;
  }
  const pairs=positiveCount*negativeCount;
  const auc=pairs>0
    ?(positiveRankSum-positiveCount*(positiveCount+1)/2)/pairs:null;
  return {
    all_outcome_sample_count:allOutcomeCount,
    directional_sample_count:directionalCount,
    excluded_flat_samples:sourceRows.filter(row=>row?.outcome==='FLAT').length,
    positive_samples:positiveCount,
    negative_samples:negativeCount,
    missing_score_samples:ranked.filter(row=>!Number.isFinite(row.score)).length,
    auc_roc:auc===null?null:Number(auc.toFixed(6)),
    top_10_pct:directionalCount?rankingAtFraction(0.10):null,
    top_20_pct:directionalCount?rankingAtFraction(0.20):null
  };
}

function evaluateHoldout(rows, fit, comparisonMargin = 0.002) {
  const requiredMargin = finite(comparisonMargin);
  if (rows.length < 20) return {
    sample_count: rows.length, evaluated: false, model_brier_score: null,
    base_rate_brier_score: null, log_loss: null, accuracy_directional_pct: null,
    expected_calibration_error: null, beat_base_rate: false,
    required_brier_margin: requiredMargin,
    reason: 'HOLDOUT_REQUIRES_20_OUTCOMES'
  };
  const base = fit.base_rate;
  const predictions = rows.map(row => predictFromFit(row.features, fit));
  const targets = rows.map(row => row.target);
  // Match the existing-engine comparison cohort exactly: UP/DOWN only.
  // Brier/log-loss retain the full binary target, including FLAT as non-UP.
  const rankingMetrics=evaluateCognitiveDirectionalRanking(rows,predictions);
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
    ranking_metrics:rankingMetrics,
    beat_base_rate: hasCognitiveBrierSuperiority(modelBrier,baselineBrier,comparisonMargin),
    required_brier_margin: requiredMargin,
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
  modelTargetDefinition = TEMPORAL_TARGET_DEFINITION,
  modelTargetSemantics = 'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2_PCT_4H_15M_V2',
  allowResolutionLag = false,
  allowedOutcomeSources = null,
  iterations = 900, learningRate = 0.12,
  minNeuralTrainingSamples = NEURAL_POLICY.minTrainingSamples,
  minimumNeuralSelectionSamples = null,
  minimumNeuralSelectionPositiveSamples = 0,
  minimumNeuralSelectionNegativeSamples = 0,
  maxNeuralTrainingSamples = NEURAL_POLICY.maxTrainingSamples,
  temporalSamples = samples,
  temporalOptions = {},
  neuralIterations = NEURAL_POLICY.iterations,
  neuralLearningRate = NEURAL_POLICY.learningRate,
  neuralL2 = NEURAL_POLICY.l2,
  neuralSelectionMargin = NEURAL_POLICY.selectionMargin,
  neuralInnerSelectionMargin = null,
  neuralTrainingHistoryFraction = 1.0,
  neuralAnchorAdaptation = 'FROZEN',
  neuralOutputInitializationScale = 0.015,
  enableAsymmetricDirectionalRankingLoss=false,
  directionalRankingLossConfig={},
  enableFactorizationMachine=false,
  factorizationRank=8,
  factorizationIterations=null,
  factorizationLearningRate=null,
  factorizationL2=null,
  featureSchema = COGNITIVE_FEATURE_SCHEMA,
  maxResolvedSamples = 0
} = {}) {
  const horizonMs=Math.max(1,Math.trunc(Number(outcomeHorizonMs)||MIN_OUTCOME_HORIZON_MS));
  const activeFeatureNames=featureNamesForSchema(featureSchema);
  const activeFeatureSchema=featureSchema;
  const temporalNetwork=buildTemporalNeuralProfile(temporalSamples,temporalOptions);
  const cognitiveSampleFingerprint=sampleIdentityFingerprint(validResolvedSamples(samples,{
    outcomeHorizonMs,modelTargetDefinition,modelTargetSemantics,
    allowResolutionLag,allowedOutcomeSources,featureSchema:activeFeatureSchema
  }));
  const temporalSampleFingerprint=String(temporalNetwork?.outer_sample_fingerprint||'');
  const sharedSampleIdentityMatches=Boolean(temporalSampleFingerprint&&
    cognitiveSampleFingerprint===temporalSampleFingerprint);
  const allResolved = validResolvedSamples(samples, {
    outcomeHorizonMs,modelTargetDefinition,modelTargetSemantics,
    allowResolutionLag,allowedOutcomeSources,featureSchema:activeFeatureSchema
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
  const validationCount = Math.max(minimumValidationSamples, Math.floor(uniqueTimes.length * validationFraction));
  const calculatedTrainingEndIndex = uniqueTimes.length - holdoutCount - validationCount;
  const calculatedValidationStartAt=uniqueTimes[calculatedTrainingEndIndex]??null;
  const calculatedHoldoutStartAt=uniqueTimes[uniqueTimes.length-holdoutCount]??null;
  const sharedValidationStartAt=finite(temporalNetwork.outer_validation_start_at);
  const sharedHoldoutStartAt=finite(temporalNetwork.outer_holdout_start_at);
  const sharedOuterSplitApplied=sharedSampleIdentityMatches&&
    sharedValidationStartAt!==null&&sharedHoldoutStartAt!==null&&
    sharedValidationStartAt<sharedHoldoutStartAt&&
    uniqueTimes.includes(sharedValidationStartAt)&&uniqueTimes.includes(sharedHoldoutStartAt);
  const validationStartAt=sharedOuterSplitApplied?sharedValidationStartAt:calculatedValidationStartAt;
  const holdoutStartAt=sharedOuterSplitApplied?sharedHoldoutStartAt:calculatedHoldoutStartAt;
  const trainingEndIndex=validationStartAt===null?-1:uniqueTimes.indexOf(validationStartAt);
  const canSplit = uniqueTimes.length >= 3 && trainingEndIndex > 0 &&
    holdoutStartAt!==null&&validationStartAt<holdoutStartAt;

  if (!canSplit) {
    const fit = fitLogisticModel(resolved, { l2, iterations, learningRate });
    const evidence = factorEvidence(resolved, { minimumBucket });
    return {
      method: 'NESTED_PURGED_WALK_FORWARD_RESIDUAL_NEURAL_MODEL_V5',
      feature_schema:activeFeatureSchema,
      outcome_horizon_ms: horizonMs,
      comparison_contract:{
        target_definition:modelTargetDefinition,
        target_semantics:modelTargetSemantics,
        shared_outer_split_applied:false,
        sample_identity_matches:sharedSampleIdentityMatches,
        sample_fingerprint:cognitiveSampleFingerprint,
        temporal_sample_fingerprint:temporalSampleFingerprint,
        validation_start_at:null,holdout_start_at:null,
        validation_samples:0,holdout_samples:0,
        temporal_validation_samples:Number(temporalNetwork.outer_validation_samples)||0,
        temporal_holdout_samples:Number(temporalNetwork.outer_holdout_samples)||0,
        validation_sample_count_matches:false,holdout_sample_count_matches:false
      },
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
        architecture: activeFeatureNames.length+'-'+NEURAL_POLICY.hiddenUnits+'-'+NEURAL_POLICY.secondHiddenUnits+'-1+RESIDUAL',
        feature_schema:activeFeatureSchema,
      input_neurons: activeFeatureNames.length, hidden_neurons: NEURAL_POLICY.hiddenUnits,
        second_hidden_neurons:NEURAL_POLICY.secondHiddenUnits,output_neurons: 1,
        samples_required:NEURAL_POLICY.minTrainingSamples,training_samples: 0, trained: false, selected: false,
        probability_ready: false, live_eligibility_ready:false, iterations: neuralIterations,
        model_kind:'RESIDUAL_DEEP_MLP_ENSEMBLE_V3',
        training_strategy:'UP_EVENT_BINARY_PROPER_LOSS_RESIDUAL_MLP_V6',
        training_objective:'MIXED_PROPER_SCORING_RULE_ENSEMBLE_BRIER_LOG_LOSS_V6',
        target_definition:modelTargetDefinition,
        target_semantics:modelTargetSemantics,
        output_initialization_scale:clamp(Number(neuralOutputInitializationScale)||0.015,0.005,0.12),
        residual_scale_selection:'DISJOINT_CHRONOLOGICAL_SELECTION_BLOCK_BRIER_GRID_V1',
        candidate_residual_scales:[...NEURAL_RESIDUAL_SCALES],
        anchor_adaptation:'FROZEN_LOGISTIC',
        anchor_trust_radius:0,
        anchor_bias_trust_radius:0,
        anchor_tether_strength:0,
        anchor_learning_rate_scale:0,
        max_anchor_skip_delta:0,
        anchor_output_bias_delta:0,
        selection_samples:0,selection_start_at:null,max_training_outcome_resolved_at:null,
        max_selection_outcome_resolved_at:null,selected_residual_scale:null,
        ensemble_members:0,ensemble_members_required:NEURAL_POLICY.ensembleSeeds.length
      },
      feature_names: [...activeFeatureNames],
      temporal_network:temporalNetwork,
      identifier_features_used: false,
      note: 'INSUFFICIENT_CHRONOLOGICAL_DATA_FOR_NESTED_VALIDATION',
      _fit: fit
    };
  }

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

  const neuralLimit=Math.max(240,Math.min(32768,Math.trunc(Number(maxNeuralTrainingSamples)||NEURAL_POLICY.maxTrainingSamples)));
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
  // V5 reserves chronological model-fit, member-selection and calibration
  // blocks before outer validation. The allocation preserves the 240-row
  // model-fit floor while keeping a meaningful blend-selection tail. Every cutoff purges outcomes
  // that had not matured before that block ended.
  const neuralTrainingCutIndex=neuralCandidateTimes.length>=4
    ?Math.max(1,Math.min(neuralCandidateTimes.length-2,Math.floor(neuralCandidateTimes.length*0.64))):-1;
  const neuralSelectionCutIndex=neuralTrainingCutIndex>=0
    ?Math.max(neuralTrainingCutIndex+1,Math.min(neuralCandidateTimes.length-1,
      Math.floor(neuralCandidateTimes.length*0.74))):-1;
  const neuralSelectionStartAt=neuralTrainingCutIndex>=0
    ?neuralCandidateTimes[neuralTrainingCutIndex]:null;
  const neuralCalibrationStartAt=neuralSelectionCutIndex>=0
    ?neuralCandidateTimes[neuralSelectionCutIndex]:null;
  const neuralTraining=neuralSelectionStartAt===null?[]:neuralCandidateRows.filter(row=>
    row.at<neuralSelectionStartAt&&row.resolved_at<neuralSelectionStartAt);
  // Restrict the gradient-fit window by distinct timestamps, never by raw row
  // count, so all symbols observed at one market time stay in the same slice.
  // The later member-selection/calibration/outer blocks remain untouched.
  const requestedNeuralHistoryFraction=Number(neuralTrainingHistoryFraction);
  const effectiveNeuralHistoryFraction=Number.isFinite(requestedNeuralHistoryFraction)
    ?Math.max(0.35,Math.min(1,requestedNeuralHistoryFraction)):1;
  const neuralTrainingTimes=[...new Set(neuralTraining.map(row=>row.at))].sort((a,b)=>a-b);
  const neuralHistoryStartIndex=neuralTrainingTimes.length
    ?Math.max(0,Math.min(neuralTrainingTimes.length-1,
      Math.floor(neuralTrainingTimes.length*(1-effectiveNeuralHistoryFraction)))):-1;
  const neuralHistoryStartAt=neuralHistoryStartIndex>=0
    ?neuralTrainingTimes[neuralHistoryStartIndex]:null;
  const neuralModelTraining=neuralHistoryStartAt===null?[]:neuralTraining.filter(row=>
    row.at>=neuralHistoryStartAt);
  const neuralSelection=neuralCalibrationStartAt===null?[]:neuralCandidateRows.filter(row=>
    row.at>=neuralSelectionStartAt&&row.at<neuralCalibrationStartAt&&
    row.resolved_at<neuralCalibrationStartAt);
  const neuralSelectionPositiveMinimum=Math.max(0,Math.min(1000,
    Math.trunc(Number(minimumNeuralSelectionPositiveSamples)||0)));
  const neuralSelectionNegativeMinimum=Math.max(0,Math.min(1000,
    Math.trunc(Number(minimumNeuralSelectionNegativeSamples)||0)));
  const neuralSelectionPositiveSamples=neuralSelection.filter(row=>Number(row.target)===1).length;
  const neuralSelectionNegativeSamples=neuralSelection.length-neuralSelectionPositiveSamples;
  // The outer validation minimum remains independent from inner selection.
  const neuralSelectionMinimum=effectiveNeuralSelectionMinimum(
    minimumValidationSamples,minimumNeuralSelectionSamples);
  const neuralSelectionSupportReady=hasNeuralSelectionSupport({
    sampleCount:neuralSelection.length,positiveCount:neuralSelectionPositiveSamples,
    negativeCount:neuralSelectionNegativeSamples,minimumSamples:neuralSelectionMinimum,
    minimumPositive:neuralSelectionPositiveMinimum,minimumNegative:neuralSelectionNegativeMinimum
  });
  const neuralCalibration=neuralCalibrationStartAt===null?[]:neuralCandidateRows.filter(row=>
    row.at>=neuralCalibrationStartAt&&row.resolved_at<validationStartAt);
  const neuralCalibrationTimes=[...new Set(neuralCalibration.map(row=>row.at))].sort((a,b)=>a-b);
  // Keep probability-calibrator fit, calibration check, and hybrid-weight
  // selection in three disjoint chronological slices before outer validation.
  // The last slice chooses only a blend weight; it never updates either model.
  const neuralCalibrationFitCutIndex=neuralCalibrationTimes.length>=4
    ?Math.max(1,Math.min(neuralCalibrationTimes.length-2,Math.floor(neuralCalibrationTimes.length*0.55))):-1;
  const neuralHybridSelectionCutIndex=neuralCalibrationTimes.length>=4
    ?Math.max(neuralCalibrationFitCutIndex+1,Math.min(neuralCalibrationTimes.length-1,
      Math.floor(neuralCalibrationTimes.length*0.78))):-1;
  const neuralCalibrationCheckStartAt=neuralCalibrationFitCutIndex>=0
    ?neuralCalibrationTimes[neuralCalibrationFitCutIndex]:null;
  const neuralHybridSelectionStartAt=neuralHybridSelectionCutIndex>=0
    ?neuralCalibrationTimes[neuralHybridSelectionCutIndex]:null;
  const neuralCalibrationFit=neuralCalibrationCheckStartAt===null?[]:neuralCalibration.filter(row=>
    row.at<neuralCalibrationCheckStartAt&&row.resolved_at<neuralCalibrationCheckStartAt);
  const neuralCalibrationCheck=neuralCalibrationCheckStartAt===null||neuralHybridSelectionStartAt===null?[]:neuralCalibration.filter(row=>
    row.at>=neuralCalibrationCheckStartAt&&row.at<neuralHybridSelectionStartAt&&
    row.resolved_at<neuralHybridSelectionStartAt);
  const neuralHybridSelection=neuralHybridSelectionStartAt===null?[]:neuralCalibration.filter(row=>
    row.at>=neuralHybridSelectionStartAt&&row.resolved_at<validationStartAt);
  // Fit the logistic anchor and every nonlinear residual on the configured
  // timestamp-safe recency subset of the chronological training block. The
  // member-selection/calibration/outer labels cannot enter gradient updates.
  let neuralSameWindowLogisticFit=neuralModelTraining.length>=neuralMinimum
    ?fitLogisticModel(neuralModelTraining,{l2,iterations,learningRate}):null;
  const neuralFit=neuralModelTraining.length>=neuralMinimum&&
    neuralSelectionSupportReady&&neuralSameWindowLogisticFit
    ?fitNeuralEnsemble(neuralModelTraining,{
      hiddenUnits:NEURAL_POLICY.hiddenUnits,
      secondHiddenUnits:NEURAL_POLICY.secondHiddenUnits,
      iterations:neuralIterations,learningRate:neuralLearningRate,l2:neuralL2,
      baselineFit:neuralSameWindowLogisticFit,
      anchorAdaptation:neuralAnchorAdaptation,
      outputInitializationScale:neuralOutputInitializationScale,
      enableAsymmetricDirectionalRankingLoss,
      directionalRankingLossConfig,
      enableFactorizationMachine,
      factorizationRank,factorizationIterations,factorizationLearningRate,factorizationL2
    }):null;
  let neuralFinalTraining=neuralModelTraining;
  // Enforce at least the declared V5 challenger margin; caller options may
  // demand a stricter improvement but cannot weaken the 0.003 policy floor.
  const comparisonMargin=effectiveCognitiveChallengerMargin(neuralSelectionMargin);
  const innerSelectionMargin=effectiveNeuralInnerSelectionMargin(
    neuralInnerSelectionMargin,comparisonMargin);
  // Select the ensemble member and nonlinear residual contribution exclusively
  // from the disjoint selection block. Outer validation and holdout stay unused.
  const neuralResidualScales=NEURAL_RESIDUAL_SCALES;
  const neuralSelectionLogistic=neuralSameWindowLogisticFit
    ?evaluateHoldout(neuralSelection,neuralSameWindowLogisticFit,innerSelectionMargin)
    :{evaluated:false,model_brier_score:null};
  const neuralMemberSelection=neuralFit?neuralFit.members.flatMap((member,index)=>{
    const memberResidualScales=member?.kind==='RESIDUAL_FACTOR_CROSS_V1'
      ?NEURAL_FACTOR_CROSS_RESIDUAL_SCALES:neuralResidualScales;
    return memberResidualScales.map(residualScale=>({
      index,residual_scale:residualScale,
      metrics:evaluateHoldout(neuralSelection,{...member,residual_scale:residualScale},innerSelectionMargin)
    }));
  }):[];
  const neuralMemberOrder=neuralMemberSelection.filter(row=>row.metrics.evaluated===true&&
    neuralSelectionLogistic.evaluated===true&&
    row.metrics.model_brier_score+innerSelectionMargin<neuralSelectionLogistic.model_brier_score)
    .sort((a,b)=>a.metrics.model_brier_score-b.metrics.model_brier_score||
      a.index-b.index||a.residual_scale-b.residual_scale);
  const neuralBestMemberCandidate=neuralMemberSelection
    .filter(row=>row.metrics?.evaluated===true&&Number.isFinite(row.metrics.model_brier_score))
    .sort((a,b)=>a.metrics.model_brier_score-b.metrics.model_brier_score||
      a.index-b.index||a.residual_scale-b.residual_scale)[0]||null;
  if(neuralFit){
    neuralFit.selected_member_index=neuralMemberOrder.length?neuralMemberOrder[0].index:-1;
    neuralFit.selected_residual_scale=neuralMemberOrder.length?neuralMemberOrder[0].residual_scale:0;
    // Refit only the selected member on the union of model-fit + selection rows.
    // All labels must mature before the separate calibration window begins.
    const selectedIndex=neuralFit.selected_member_index;
    const refitRows=[...neuralModelTraining,...neuralSelection]
      .sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol));
    const refitBaseline=selectedIndex>=0?fitLogisticModel(refitRows,{l2,iterations,learningRate}):null;
    const selectedProfile=selectedIndex>=0?neuralFit.member_training_profiles[selectedIndex]||{}:{};
    const refitMember=selectedIndex>=0&&refitBaseline
      ?selectedProfile.model_kind==='RESIDUAL_FACTOR_CROSS_V1'
        ?fitFactorizationMachineModel(refitRows,{
          ...selectedProfile,seed:neuralFit.seeds[selectedIndex],baselineFit:refitBaseline
        })
        :fitNeuralNetworkModel(refitRows,{
          hiddenUnits:NEURAL_POLICY.hiddenUnits,secondHiddenUnits:NEURAL_POLICY.secondHiddenUnits,
          ...selectedProfile,seed:neuralFit.seeds[selectedIndex],baselineFit:refitBaseline,
          anchorAdaptation:neuralFit.anchor_adaptation_mode
        }):null;
    if(refitMember&&refitBaseline){
      neuralFit.members[selectedIndex]=refitMember;
      neuralFit.anchor_adaptation=refitMember.anchor_adaptation;
      neuralFit.anchor_trust_radius=refitMember.anchor_trust_radius;
      neuralFit.anchor_bias_trust_radius=refitMember.anchor_bias_trust_radius;
      neuralFit.anchor_tether_strength=refitMember.anchor_tether_strength;
      neuralFit.anchor_learning_rate_scale=refitMember.anchor_learning_rate_scale;
      neuralFit.max_anchor_skip_delta=refitMember.max_anchor_skip_delta;
      neuralFit.anchor_output_bias_delta=refitMember.anchor_output_bias_delta;
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
      ?fitAndSelectProbabilityCalibrator(neuralCalibrationFit,neuralCalibrationCheck,neuralFit)
      :null;
  }
  // Calibrate reference logits on the same disjoint chronological calibration
  // blocks used by the residual models. Rejected calibrators leave raw scores
  // unchanged; they never consume blend-selection, validation or holdout labels.
  const calibrateReferenceFit=fit=>{
    if(!fit)return {method:'DISJOINT_BRIER_PLATT_MODEL_CALIBRATION_V2',
      fitted:false,accepted:false,reason:'REFERENCE_FIT_UNAVAILABLE'};
    const calibration=fitAndSelectProbabilityCalibrator(
      neuralCalibrationFit,neuralCalibrationCheck,fit);
    fit.probability_calibrator=calibration;
    return calibration;
  };
  const neuralSameWindowLogisticCalibration=calibrateReferenceFit(neuralSameWindowLogisticFit);
  const neuralGlobalLogisticCalibration=calibrateReferenceFit(neuralGlobalLogisticFit);
  const neuralRecentLogisticCalibration=calibrateReferenceFit(neuralRecentLogisticFit);
  // This validation score is now measured on rows later than model fitting,
  // member selection and calibration, so it is an honest outer comparison.
  const neuralSelectionFailureReason=!neuralFit
    ?!neuralSameWindowLogisticFit?'NEURAL_SELECTION_LOGISTIC_BASELINE_UNAVAILABLE'
      :neuralModelTraining.length<neuralMinimum?'NEURAL_TRAINING_SAMPLE_MINIMUM_NOT_MET'
      :!neuralSelectionSupportReady?'NEURAL_SELECTION_SAMPLE_MINIMUM_NOT_MET'
      :'NEURAL_ENSEMBLE_FIT_FAILED'
    :neuralFit.selected_member_index<0
      ?neuralSelectionLogistic.evaluated===true
        ?'NO_NEURAL_MEMBER_BEAT_INNER_SELECTION_LOGISTIC_BY_REQUIRED_MARGIN'
        :'NEURAL_SELECTION_LOGISTIC_BASELINE_UNAVAILABLE'
      :'NEURAL_MEMBER_SELECTION_PASSED';
  const neuralValidation=neuralFit&&neuralFit.selected_member_index>=0
    ?evaluateHoldout(upEventValidation,neuralFit,comparisonMargin):{
      evaluated:false,reason:neuralSelectionFailureReason,
      sample_count:upEventValidation.length,model_brier_score:null,base_rate_brier_score:null,beat_base_rate:false
    };
  const neuralSameWindowLogisticValidation=neuralSameWindowLogisticFit
    ?evaluateHoldout(upEventValidation,neuralSameWindowLogisticFit,comparisonMargin):{evaluated:false,model_brier_score:null};
  const neuralGlobalLogisticValidation=neuralGlobalLogisticFit
    ?evaluateHoldout(upEventValidation,neuralGlobalLogisticFit,comparisonMargin):{evaluated:false,model_brier_score:null};
  const neuralRecentLogisticValidation=neuralRecentLogisticFit
    ?evaluateHoldout(upEventValidation,neuralRecentLogisticFit,comparisonMargin):null;
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
  const neuralHoldout=neuralFit&&neuralFit.selected_member_index>=0
    ?evaluateHoldout(upEventHoldout,neuralFit,comparisonMargin):{
    sample_count:upEventHoldout.length,evaluated:false,model_brier_score:null,base_rate_brier_score:null,
    log_loss:null,beat_base_rate:false,reason:neuralSelectionFailureReason
  };
  const neuralSameWindowLogisticHoldout=neuralSameWindowLogisticFit
    ?evaluateHoldout(upEventHoldout,neuralSameWindowLogisticFit,comparisonMargin):{evaluated:false,model_brier_score:null};
  const neuralGlobalLogisticHoldout=neuralGlobalLogisticFit
    ?evaluateHoldout(upEventHoldout,neuralGlobalLogisticFit,comparisonMargin):{evaluated:false,model_brier_score:null};
  const neuralRecentLogisticHoldout=neuralRecentLogisticFit
    ?evaluateHoldout(upEventHoldout,neuralRecentLogisticFit,comparisonMargin):null;
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
  // GBDT capacity/regularization is selected only on the disjoint inner
  // selection block. It is then refit on model-fit + selection rows and scored
  // once on the common outer validation block. The final holdout remains closed.
  const boostedTrainingRows=neuralTraining;
  const boostedSelectionRows=neuralSelection;
  const boostedTrainingBaselineFit=boostedTrainingRows.length>=neuralMinimum
    ?fitLogisticModel(boostedTrainingRows,{l2,iterations,learningRate}):null;
  const boostedTrainingReady=boostedTrainingBaselineFit!==null&&
    boostedTrainingRows.length>=neuralMinimum;
  const boostedSelectionLogistic=boostedTrainingReady
    ?evaluateHoldout(boostedSelectionRows,boostedTrainingBaselineFit,comparisonMargin)
    :{evaluated:false,sample_count:boostedSelectionRows.length,model_brier_score:null,
      reason:'BOOSTED_TREE_TRAINING_NOT_READY'};
  const boostedSelectionTargets={
    samples:boostedSelectionRows.length,
    positive:boostedSelectionRows.filter(row=>row.target===1).length,
    negative:boostedSelectionRows.filter(row=>row.target===0).length
  };
  const boostedSelectionSupported=boostedSelectionTargets.samples>=neuralSelectionMinimum&&
    boostedSelectionTargets.positive>=Math.max(3,neuralSelectionPositiveMinimum)&&
    boostedSelectionTargets.negative>=Math.max(8,neuralSelectionNegativeMinimum);
  const boostedTreeCandidateAttempts=boostedTrainingReady
    ?COGNITIVE_GBDT_VALIDATION_GRID.map(configuration=>{
      const fit=fitResidualBoostedTrees(boostedTrainingRows,boostedTrainingBaselineFit,configuration);
      const rootGainDiagnostic=diagnoseResidualBoostedTreeRootGain(
        boostedTrainingRows,boostedTrainingBaselineFit,configuration
      );
      return {
        configuration,fit,root_gain_diagnostic:rootGainDiagnostic,
        selection:fit?evaluateHoldout(boostedSelectionRows,fit,comparisonMargin):{
          evaluated:false,model_brier_score:null,reason:'NO_GAINFUL_TREE_SPLIT'
        }
      };
    }):[];
  const boostedTreeCandidates=boostedTreeCandidateAttempts.filter(candidate=>
    candidate.fit&&candidate.selection?.evaluated===true);
  const boostedTreeCandidateFitDiagnostics=boostedTreeCandidateAttempts.map(candidate=>({
    configuration:candidate.configuration.name,
    max_trees:candidate.configuration.maxTrees,
    max_depth:candidate.configuration.maxDepth,
    learning_rate:candidate.configuration.learningRate,
    l2:candidate.configuration.l2,
    minimum_leaf_fraction:candidate.configuration.minimumLeafFraction,
    residual_scale:candidate.configuration.residualScale,
    fitted_tree_count:candidate.fit?.tree_count??0,
    failure_reason:candidate.fit?null:'NO_GAINFUL_TREE_SPLIT',
    root_gain:candidate.root_gain_diagnostic
  }));
  const bestBoostedTreeDiagnosticCandidate=[...boostedTreeCandidates].sort((a,b)=>
    a.selection.model_brier_score-b.selection.model_brier_score||
    a.configuration.name.localeCompare(b.configuration.name))[0]||null;
  const qualifiedBoostedTreeCandidates=boostedSelectionSupported&&boostedSelectionLogistic.evaluated===true
    ?boostedTreeCandidates.filter(candidate=>
      candidate.selection?.evaluated===true&&candidate.selection.beat_base_rate===true&&
      candidate.selection.model_brier_score+comparisonMargin<
        boostedSelectionLogistic.model_brier_score)
    :[];
  const bestBoostedTreeCandidate=[...qualifiedBoostedTreeCandidates].sort((a,b)=>
    a.selection.model_brier_score-b.selection.model_brier_score||
    a.configuration.name.localeCompare(b.configuration.name))[0]||null;
  const boostedTreeRefitRows=bestBoostedTreeCandidate
    ?[...boostedTrainingRows,...boostedSelectionRows]
      .filter(row=>row.resolved_at<neuralCalibrationStartAt)
      .sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol))
    :[];
  const boostedTreeRefitBaselineFit=boostedTreeRefitRows.length>=neuralMinimum
    ?fitLogisticModel(boostedTreeRefitRows,{l2,iterations,learningRate}):null;
  const boostedTreeFit=bestBoostedTreeCandidate&&boostedTreeRefitBaselineFit
    ?fitResidualBoostedTrees(boostedTreeRefitRows,boostedTreeRefitBaselineFit,
      bestBoostedTreeCandidate.configuration):null;
  const boostedSameWindowLogisticValidation=boostedTreeRefitBaselineFit
    ?evaluateHoldout(upEventValidation,boostedTreeRefitBaselineFit,comparisonMargin)
    :{evaluated:false,sample_count:upEventValidation.length,model_brier_score:null};
  const boostedSameWindowLogisticHoldout=boostedTreeRefitBaselineFit
    ?evaluateHoldout(upEventHoldout,boostedTreeRefitBaselineFit,comparisonMargin)
    :{evaluated:false,sample_count:upEventHoldout.length,model_brier_score:null};
  const boostedTreeProbabilityCalibration=boostedTreeFit
    ?fitAndSelectProbabilityCalibrator(neuralCalibrationFit,neuralCalibrationCheck,boostedTreeFit)
    :{method:'DISJOINT_BRIER_PLATT_MODEL_CALIBRATION_V2',fitted:false,accepted:false,reason:'GBDT_FIT_UNAVAILABLE'};
  if(boostedTreeFit)boostedTreeFit.probability_calibrator=boostedTreeProbabilityCalibration;
  const boostedSameWindowLogisticCalibration=boostedTreeRefitBaselineFit
    ?fitAndSelectProbabilityCalibrator(neuralCalibrationFit,neuralCalibrationCheck,boostedTreeRefitBaselineFit)
    :{method:'DISJOINT_BRIER_PLATT_MODEL_CALIBRATION_V2',fitted:false,accepted:false,reason:'GBDT_LOGISTIC_REFERENCE_UNAVAILABLE'};
  if(boostedTreeRefitBaselineFit)boostedTreeRefitBaselineFit.probability_calibrator=boostedSameWindowLogisticCalibration;
  const boostedTreeValidation=boostedTreeFit
    ?evaluateHoldout(upEventValidation,boostedTreeFit,comparisonMargin)
    :{evaluated:false,sample_count:upEventValidation.length,model_brier_score:null,
      reason:bestBoostedTreeCandidate?'BOOSTED_TREE_REFIT_FAILED':
        !boostedTrainingReady?'BOOSTED_TREE_TRAINING_NOT_READY':
        !boostedSelectionSupported?'BOOSTED_TREE_SELECTION_SUPPORT_BELOW_MINIMUM':
        'NO_GBDT_CONFIGURATION_BEAT_INNER_SELECTION_LOGISTIC'};
  const boostedTreeCandidateMetrics=boostedTreeCandidates.map(candidate=>({
    configuration:candidate.configuration.name,
    max_trees:candidate.configuration.maxTrees,
    max_depth:candidate.configuration.maxDepth,
    learning_rate:candidate.configuration.learningRate,
    l2:candidate.configuration.l2,
    minimum_leaf_fraction:candidate.configuration.minimumLeafFraction,
    residual_scale:candidate.configuration.residualScale,
    minimum_gain:candidate.configuration.minGain??0.002,
    actual_tree_count:candidate.fit.tree_count,
    training_samples:candidate.fit.training_samples,
    selection_sample_count:candidate.selection.sample_count,
    selection_brier_score:candidate.selection.model_brier_score,
    selection_base_rate_brier_score:candidate.selection.base_rate_brier_score,
    selection_beats_base_rate:candidate.selection.beat_base_rate===true,
    selection_logistic_brier_score:boostedSelectionLogistic.model_brier_score??null,
    selection_beats_same_window_logistic:boostedSelectionLogistic.evaluated===true&&
      candidate.selection.model_brier_score+comparisonMargin<
        boostedSelectionLogistic.model_brier_score,
    selected_for_refit:candidate.configuration.name===bestBoostedTreeCandidate?.configuration.name,
    validation_sample_count:candidate.configuration.name===bestBoostedTreeCandidate?.configuration.name
      ?boostedTreeValidation.sample_count:0,
    validation_brier_score:candidate.configuration.name===bestBoostedTreeCandidate?.configuration.name
      ?boostedTreeValidation.model_brier_score??null:null,
    validation_base_rate_brier_score:candidate.configuration.name===bestBoostedTreeCandidate?.configuration.name
      ?boostedTreeValidation.base_rate_brier_score??null:null,
    validation_auc_roc:candidate.configuration.name===bestBoostedTreeCandidate?.configuration.name
      ?boostedTreeValidation.ranking_metrics?.auc_roc??null:null,
    validation_beats_base_rate:candidate.configuration.name===bestBoostedTreeCandidate?.configuration.name&&
      boostedTreeValidation.beat_base_rate===true
  }));
  // Derive one convex Brier-optimal probability weight on an earlier
  // chronological slice, then freeze and evaluate it on a later disjoint slice.
  // Components are already fitted and calibrated; neither slice updates them.
  const hybridTimes=[...new Set(neuralHybridSelection.map(row=>row.at))].sort((a,b)=>a-b);
  const hybridWeightFitCutIndex=hybridTimes.length>=4
    ?Math.max(1,Math.min(hybridTimes.length-2,Math.floor(hybridTimes.length*0.60))):-1;
  const hybridWeightSelectionStartAt=hybridWeightFitCutIndex>=0
    ?hybridTimes[hybridWeightFitCutIndex]:null;
  const hybridWeightFitRows=hybridWeightSelectionStartAt===null?[]:
    neuralHybridSelection.filter(row=>row.at<hybridWeightSelectionStartAt&&
      row.resolved_at<hybridWeightSelectionStartAt);
  const hybridWeightSelectionRows=hybridWeightSelectionStartAt===null?[]:
    neuralHybridSelection.filter(row=>row.at>=hybridWeightSelectionStartAt&&
      row.resolved_at<validationStartAt);
  const hybridWeightFitTargets={
    samples:hybridWeightFitRows.length,
    positive:hybridWeightFitRows.filter(row=>row.target===1).length,
    negative:hybridWeightFitRows.filter(row=>row.target===0).length
  };
  const hybridSelectionTargets={
    samples:hybridWeightSelectionRows.length,
    positive:hybridWeightSelectionRows.filter(row=>row.target===1).length,
    negative:hybridWeightSelectionRows.filter(row=>row.target===0).length
  };
  const hybridWeightFitSupported=hybridWeightFitTargets.samples>=neuralSelectionMinimum&&
    hybridWeightFitTargets.positive>=3&&hybridWeightFitTargets.negative>=8;
  const hybridSelectionSupported=hybridSelectionTargets.samples>=neuralSelectionMinimum&&
    hybridSelectionTargets.positive>=3&&hybridSelectionTargets.negative>=8;
  const hybridSelectionLogistic=boostedTreeRefitBaselineFit
    ?evaluateHoldout(hybridWeightSelectionRows,boostedTreeRefitBaselineFit,comparisonMargin)
    :{evaluated:false,sample_count:hybridWeightSelectionRows.length,model_brier_score:null,
      reason:'HYBRID_LOGISTIC_REFERENCE_UNAVAILABLE'};
  const neuralBestSelectionMetrics=neuralBestMemberCandidate?.metrics||{};
  const neuralComponentPrequalification=prequalifyHybridComponent({
    name:'MLP_V5',
    fitValid:hasSelectedNeuralResidual(neuralFit),
    selection:{
      samples:neuralSelection.length,
      positive:neuralSelectionPositiveSamples,
      negative:neuralSelectionNegativeSamples,
      candidateBrier:neuralBestSelectionMetrics.model_brier_score,
      logisticBrier:neuralSelectionLogistic.model_brier_score
    },
    requiredMargin:innerSelectionMargin,
    minimumSamples:neuralSelectionMinimum,
    minimumPositive:Math.max(3,neuralSelectionPositiveMinimum),
    minimumNegative:Math.max(8,neuralSelectionNegativeMinimum)
  });
  const boostedComponentPrequalification=prequalifyHybridComponent({
    name:'GBDT',
    fitValid:Boolean(bestBoostedTreeCandidate&&boostedTreeFit&&boostedTreeRefitBaselineFit),
    selection:{
      samples:boostedSelectionTargets.samples,
      positive:boostedSelectionTargets.positive,
      negative:boostedSelectionTargets.negative,
      candidateBrier:bestBoostedTreeCandidate?.selection?.model_brier_score,
      logisticBrier:boostedSelectionLogistic.model_brier_score
    },
    requiredMargin:innerSelectionMargin,
    minimumSamples:neuralSelectionMinimum,
    minimumPositive:Math.max(3,neuralSelectionPositiveMinimum),
    minimumNegative:Math.max(8,neuralSelectionNegativeMinimum)
  });
  const hybridComponentPrequalification={
    schema:'HYBRID_STANDALONE_COMPONENT_PREQUALIFICATION_V1',
    minimum_qualified_components:2,
    qualified_component_count:[
      neuralComponentPrequalification,boostedComponentPrequalification
    ].filter(component=>component.qualified).length,
    qualified:[
      neuralComponentPrequalification.qualified,
      boostedComponentPrequalification.qualified
    ].every(Boolean),
    mlp:neuralComponentPrequalification,
    gbdt:boostedComponentPrequalification
  };
  const hybridNeuralComponentReady=neuralComponentPrequalification.qualified&&
    hasSelectedNeuralResidual(neuralFit);
  const hybridBoostedComponentReady=boostedComponentPrequalification.qualified&&
    Boolean(boostedTreeFit);
  const hybridWeightFitPredictions=hybridBoostedComponentReady&&hybridNeuralComponentReady&&
    hybridWeightFitSupported?{
      boosted:hybridWeightFitRows.map(row=>predictFromFit(row.features,boostedTreeFit)),
      neural:hybridWeightFitRows.map(row=>predictFromFit(row.features,neuralFit)),
      targets:hybridWeightFitRows.map(row=>row.target)
    }:null;
  const hybridRawOptimalBoostedWeight=hybridWeightFitPredictions&&
    hybridWeightFitPredictions.boosted.every(Number.isFinite)&&
    hybridWeightFitPredictions.neural.every(Number.isFinite)
    ?deriveBrierOptimalBlendWeight(hybridWeightFitPredictions.boosted,
      hybridWeightFitPredictions.neural,hybridWeightFitPredictions.targets):null;
  // Reject a 0/100 or 100/0 blend: it is one component masquerading as a hybrid.
  const hybridWeightCollapsedToSingleComponent=hybridRawOptimalBoostedWeight!==null&&
    !isMeaningfulHybridBlendWeight(hybridRawOptimalBoostedWeight,0.05);
  const hybridOptimalBoostedWeight=isMeaningfulHybridBlendWeight(hybridRawOptimalBoostedWeight,0.05)
    ?hybridRawOptimalBoostedWeight:null;
  const hybridSelectionCandidates=hybridBoostedComponentReady&&hybridNeuralComponentReady&&
    hybridWeightFitSupported&&hybridOptimalBoostedWeight!==null
    ?[{
      name:'HYBRID_GBDT_MLP_BRIER_OPTIMAL',
      fit:{
        kind:'BLENDED_GBDT_MLP_V1',boosted_fit:boostedTreeFit,
        neural_fit:neuralFit,boosted_weight:hybridOptimalBoostedWeight,
        base_rate:boostedTreeFit.base_rate,
        architecture:'GBDT_BRIER_OPTIMAL_CONVEX_WEIGHT_V4',
        training_strategy:'CHRONOLOGICAL_WEIGHT_FIT_THEN_DISJOINT_SELECTION_V1',
        blend_weight_fit_samples:hybridWeightFitRows.length,
        blend_weight_fit_start_at:hybridWeightFitRows[0]?.at??null,
        blend_weight_fit_end_at:hybridWeightFitRows.at(-1)?.at??null,
        blend_weight_selection_start_at:hybridWeightSelectionStartAt
      },
      selection:evaluateHoldout(hybridWeightSelectionRows,{
        kind:'BLENDED_GBDT_MLP_V1',boosted_fit:boostedTreeFit,
        neural_fit:neuralFit,boosted_weight:hybridOptimalBoostedWeight,
        base_rate:boostedTreeFit.base_rate
      },comparisonMargin)
    }]:[];
  const qualifiedHybridCandidates=hybridSelectionSupported&&hybridSelectionLogistic.evaluated===true
    ?hybridSelectionCandidates.filter(candidate=>candidate.selection?.evaluated===true&&
      candidate.selection.beat_base_rate===true&&
      candidate.selection.model_brier_score+comparisonMargin<hybridSelectionLogistic.model_brier_score)
    :[];
  const bestHybridCandidate=[...qualifiedHybridCandidates].sort((a,b)=>
    a.selection.model_brier_score-b.selection.model_brier_score||
    a.name.localeCompare(b.name))[0]||null;
  const hybridCandidates=bestHybridCandidate?[{
    ...bestHybridCandidate,
    validation:evaluateHoldout(upEventValidation,bestHybridCandidate.fit,comparisonMargin)
  }]:[];
  const hybridFit=bestHybridCandidate?.fit||null;
  const hybridValidation=hybridCandidates[0]?.validation||
    {evaluated:false,sample_count:upEventValidation.length,model_brier_score:null,
      reason:!boostedTreeFit?'HYBRID_GBDT_FIT_UNAVAILABLE':
        !hybridNeuralComponentReady?'HYBRID_NEURAL_MEMBER_NOT_SELECTED_ON_INNER_SELECTION':
        !hybridWeightFitSupported?'HYBRID_WEIGHT_FIT_SUPPORT_BELOW_MINIMUM':
        hybridWeightCollapsedToSingleComponent?'HYBRID_WEIGHT_COLLAPSED_TO_SINGLE_COMPONENT':
        hybridRawOptimalBoostedWeight===null?'HYBRID_OPTIMAL_WEIGHT_UNIDENTIFIABLE':
        !hybridSelectionSupported?'HYBRID_SELECTION_SUPPORT_BELOW_MINIMUM':
        'NO_ANALYTIC_BLEND_WEIGHT_BEAT_BASE_RATE_AND_SAME_WINDOW_LOGISTIC'};
  const challengerCandidates=[
    {name:'NEURAL_GLOBAL',fit:neuralFit,validation:neuralValidation},
    {name:'GBDT_RESIDUAL',fit:boostedTreeFit,validation:boostedTreeValidation},
    ...hybridCandidates
  ].filter(candidate=>candidate.fit&&candidate.validation?.evaluated===true);
  const validationReferencesFor=candidate=>[
    candidate.name==='NEURAL_GLOBAL'?neuralSameWindowLogisticValidation:
      boostedSameWindowLogisticValidation,
    neuralGlobalLogisticValidation,
    ...(neuralRecentLogisticFit?[neuralRecentLogisticValidation]:[])
  ].filter(metric=>metric?.evaluated===true&&Number.isFinite(metric.model_brier_score));
  const qualifiesOnValidation=candidate=>{
    const metric=candidate.validation;
    const references=validationReferencesFor(candidate);
    if(metric?.evaluated!==true||metric.beat_base_rate!==true)return false;
    return references.length>=2&&references.every(reference=>
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
      ?neuralHoldout:evaluateHoldout(upEventHoldout,validationWinner.fit,comparisonMargin);
    const challengerSameWindowLogisticHoldout=validationWinner.name==='NEURAL_GLOBAL'
      ?neuralSameWindowLogisticHoldout:boostedSameWindowLogisticHoldout;
    const holdoutReferences=[
      challengerSameWindowLogisticHoldout,neuralGlobalLogisticHoldout,
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
      same_window_logistic_brier_score:challengerSameWindowLogisticHoldout.model_brier_score??null,
      global_logistic_brier_score:neuralGlobalLogisticHoldout.model_brier_score??null,
      recent_logistic_brier_score:neuralRecentLogisticHoldout?.model_brier_score??null,
      beats_base_rate:challengerHoldout.beat_base_rate===true,
      beats_same_window_logistic:challengerHoldout.evaluated===true&&
        challengerSameWindowLogisticHoldout.evaluated===true&&
        challengerHoldout.model_brier_score+comparisonMargin<
          challengerSameWindowLogisticHoldout.model_brier_score,
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
  const neuralLiveReady=neuralProbabilityReady&&neuralFinalTraining.length>=NEURAL_POLICY.minTrainingSamples&&
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
    feature_schema:activeFeatureSchema,
    outcome_horizon_ms: horizonMs,
    comparison_contract:{
      target_definition:modelTargetDefinition,
      target_semantics:modelTargetSemantics,
      shared_outer_split_applied:sharedOuterSplitApplied,
      sample_identity_matches:sharedSampleIdentityMatches,
      sample_fingerprint:cognitiveSampleFingerprint,
      temporal_sample_fingerprint:temporalSampleFingerprint,
      validation_start_at:validationStartAt,
      holdout_start_at:holdoutStartAt,
      validation_samples:validation.length,
      holdout_samples:holdout.length,
      temporal_validation_samples:Number(temporalNetwork.outer_validation_samples)||0,
      temporal_holdout_samples:Number(temporalNetwork.outer_holdout_samples)||0,
      validation_sample_count_matches:Number(temporalNetwork.outer_validation_samples)===validation.length,
      holdout_sample_count_matches:Number(temporalNetwork.outer_holdout_samples)===holdout.length
    },
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
      status: !neuralFit ? (!neuralSelectionSupportReady
          ?'WAITING_FOR_SELECTION_SUPPORT':'WAITING_FOR_MATURED_TRAINING_SAMPLES') :
        neuralFit.selected_member_index<0 ? 'TRAINED_NOT_SELECTED_ON_INNER_SELECTION' :
        neuralLiveReady ? 'LIVE_GATE_PASSED_OUT_OF_SAMPLE' :
        neuralSelected ? 'VALIDATION_SELECTED_BUT_HOLDOUT_COMPARISON_FAILED' :
        neuralValidation.beat_base_rate===true ? 'VALIDATED_BUT_NOT_BETTER_THAN_CHALLENGER' : 'VALIDATION_DID_NOT_BEAT_BASE_RATE',
      architecture: neuralFit?.architecture || activeFeatureNames.length+'-'+NEURAL_POLICY.hiddenUnits+'-'+NEURAL_POLICY.secondHiddenUnits+'-1+RESIDUAL',
      feature_schema:activeFeatureSchema,
      input_neurons: activeFeatureNames.length, hidden_neurons: NEURAL_POLICY.hiddenUnits,
      second_hidden_neurons: NEURAL_POLICY.secondHiddenUnits, output_neurons: 1,
      samples_required:neuralMinimum,
      required_selection_samples:neuralSelectionMinimum,
      required_selection_positive_samples:neuralSelectionPositiveMinimum,
      required_selection_negative_samples:neuralSelectionNegativeMinimum,
      selection_positive_samples:neuralSelectionPositiveSamples,
      selection_negative_samples:neuralSelectionNegativeSamples,
      selection_support_ready:neuralSelectionSupportReady,
      training_samples: neuralFit?.training_samples??neuralModelTraining.length,
      preselection_training_samples:neuralTraining.length,
      fit_training_samples:neuralModelTraining.length,
      training_history_fraction:effectiveNeuralHistoryFraction,
      training_history_start_at:neuralHistoryStartAt,
      training_history_end_at:neuralModelTraining.at(-1)?.at??null,
      refit_training_samples:neuralFit?.refit_training_samples??0,
      refit_positive_samples:neuralFit?.refit_positive_samples??0,
      refit_negative_samples:neuralFit?.refit_negative_samples??0,
      refit_base_rate:neuralFit?.refit_base_rate??null,
      scoring_base_rate:neuralFit?.base_rate??null,
      maximum_training_sample_budget:neuralLimit,
      model_kind:'RESIDUAL_DEEP_MLP_ENSEMBLE_V3',
      training_strategy:neuralFit?.training_strategy||
        (neuralFit?.anchor_adaptation==='TRUST_REGION_TETHERED_V1'
          ?'UP_EVENT_BINARY_PROPER_LOSS_RESIDUAL_MLP_V7_TRUST_REGION'
          :'UP_EVENT_BINARY_PROPER_LOSS_RESIDUAL_MLP_V6'),
      training_objective:'MIXED_PROPER_SCORING_RULE_ENSEMBLE_BRIER_LOG_LOSS_V6',
      target_definition:modelTargetDefinition,
      target_semantics:modelTargetSemantics,
      output_initialization_scale:neuralFit?.output_initialization_scale??clamp(Number(neuralOutputInitializationScale)||0.015,0.005,0.12),
      residual_scale_selection:'DISJOINT_CHRONOLOGICAL_SELECTION_BLOCK_BRIER_GRID_V1',
      candidate_residual_scales:[...neuralResidualScales],
      factorization_candidate_residual_scales:[...NEURAL_FACTOR_CROSS_RESIDUAL_SCALES],
      selection_samples:neuralSelection.length,
      selection_start_at:neuralSelectionStartAt,
      calibration_start_at:neuralCalibrationStartAt,
      calibration_fit_start_at:neuralCalibrationFit[0]?.at??null,
      calibration_check_start_at:neuralCalibrationCheckStartAt,
      calibration_samples:neuralCalibration.length,
      calibration_fit_samples:neuralCalibrationFit.length,
      calibration_check_samples:neuralCalibrationCheck.length,
      probability_calibration:neuralFit?.probability_calibrator??{
        method:'DISJOINT_BRIER_PLATT_MODEL_CALIBRATION_V2',fitted:false,accepted:false,
        reason:'NEURAL_MODEL_NOT_FITTED'
      },
      max_training_outcome_resolved_at:neuralModelTraining.length?Math.max(...neuralModelTraining.map(row=>row.resolved_at)):null,
      max_refit_training_outcome_resolved_at:neuralFit?.refit_max_outcome_resolved_at??null,
      max_selection_outcome_resolved_at:neuralSelection.length?Math.max(...neuralSelection.map(row=>row.resolved_at)):null,
      max_calibration_fit_outcome_resolved_at:neuralCalibrationFit.length?Math.max(...neuralCalibrationFit.map(row=>row.resolved_at)):null,
      max_calibration_check_outcome_resolved_at:neuralCalibrationCheck.length?Math.max(...neuralCalibrationCheck.map(row=>row.resolved_at)):null,
      selected_residual_scale:neuralFit?.selected_residual_scale??null,
      ensemble_members:neuralFit?.members?.length||0,
      ensemble_members_required:neuralFit?.seeds?.length??NEURAL_POLICY.ensembleSeeds.length,
      factorization_member_enabled:Number.isInteger(neuralFit?.factorization_member_index)&&
        neuralFit.factorization_member_index>=0,
      factorization_member_index:neuralFit?.factorization_member_index??-1,
      selected_member_index:neuralFit?.selected_member_index??null,
      anchor_adaptation:neuralFit?.anchor_adaptation??'FROZEN_LOGISTIC',
      anchor_trust_radius:neuralFit?.anchor_trust_radius??0,
      anchor_bias_trust_radius:neuralFit?.anchor_bias_trust_radius??0,
      anchor_tether_strength:neuralFit?.anchor_tether_strength??0,
      anchor_learning_rate_scale:neuralFit?.anchor_learning_rate_scale??0,
      max_anchor_skip_delta:neuralFit?.max_anchor_skip_delta??0,
      anchor_output_bias_delta:neuralFit?.anchor_output_bias_delta??0,
      member_training_objectives:neuralFit?.members?.map(member=>member.training_objective)||[],
      member_training_profiles:neuralFit?.member_training_profiles||[],
      member_training_diagnostics:neuralFit?.member_training_diagnostics||[],
      internal_selection_logistic_brier:neuralSelectionLogistic.model_brier_score??null,
      internal_selection_required_margin:innerSelectionMargin,
      outer_validation_required_margin:comparisonMargin,
      internal_selection_qualified_members:neuralMemberOrder.length,
      inner_selection_diagnostics:{
        training_sample_count:neuralModelTraining.length,
        selection_sample_count:neuralSelection.length,
        selection_positive_samples:neuralSelection.filter(row=>Number(row.target)===1).length,
        selection_negative_samples:neuralSelection.filter(row=>Number(row.target)===0).length,
        logistic_baseline_evaluated:neuralSelectionLogistic.evaluated===true,
        logistic_baseline_brier_score:neuralSelectionLogistic.model_brier_score??null,
        required_brier_margin:innerSelectionMargin,
        outer_validation_required_margin:comparisonMargin,
        candidate_member_scale_count:neuralMemberSelection.length,
        qualifying_member_scale_count:neuralMemberOrder.length,
        best_candidate:neuralBestMemberCandidate?{
          member_index:neuralBestMemberCandidate.index,
          residual_scale:neuralBestMemberCandidate.residual_scale,
          brier_score:neuralBestMemberCandidate.metrics.model_brier_score,
          base_rate_brier_score:neuralBestMemberCandidate.metrics.base_rate_brier_score,
          beats_same_window_logistic:neuralSelectionLogistic.evaluated===true&&
            neuralBestMemberCandidate.metrics.model_brier_score+innerSelectionMargin<
              neuralSelectionLogistic.model_brier_score
        }:null,
        passed:Number.isInteger(neuralFit?.selected_member_index)&&neuralFit.selected_member_index>=0,
        failure_reason:neuralSelectionFailureReason
      },
      member_selection_brier_scores:neuralMemberSelection.map(row=>({
        index:row.index,residual_scale:row.residual_scale,brier_score:row.metrics.model_brier_score,
        base_rate_brier_score:row.metrics.base_rate_brier_score,beat_base_rate:row.metrics.beat_base_rate,
        beats_same_window_logistic:neuralSelectionLogistic.evaluated===true&&
          row.metrics.model_brier_score+innerSelectionMargin<neuralSelectionLogistic.model_brier_score
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
      status:!boostedTrainingReady?'WAITING_FOR_MATURED_TRAINING_SAMPLES':
        !boostedSelectionSupported?'WAITING_FOR_SELECTION_SUPPORT':
        !boostedTreeFit?'NO_TRAINING_RESIDUAL_GAIN':
        activeChallenger==='GBDT_RESIDUAL'?'OUT_OF_SAMPLE_VALIDATED':
        validationWinner?.name==='GBDT_RESIDUAL'?'VALIDATION_SELECTED_HOLDOUT_FAILED':
        'TRAINED_NOT_SELECTED',
      model_kind:'RESIDUAL_GBDT_LOGISTIC_ANCHOR_V1',
      probability_calibration:boostedTreeFit?.probability_calibrator||boostedTreeProbabilityCalibration,
      architecture:boostedTreeFit?.architecture||'NEWTON_GBDT_VALIDATION_SELECTED_REGULARIZED_GRID_V2',
      search_grid_size:COGNITIVE_GBDT_VALIDATION_GRID.length,
      selection_training_samples:boostedTrainingRows.length,
      selection_sample_count:boostedSelectionRows.length,
      required_selection_samples:neuralSelectionMinimum,
      required_selection_positive_samples:Math.max(3,neuralSelectionPositiveMinimum),
      required_selection_negative_samples:Math.max(8,neuralSelectionNegativeMinimum),
      selection_logistic:boostedSelectionLogistic,
      selected_configuration:bestBoostedTreeCandidate?.configuration.name||null,
      candidate_selection_metrics:boostedTreeCandidateMetrics,
      candidate_validation_metrics:boostedTreeCandidateMetrics,
      candidate_fit_diagnostics:boostedTreeCandidateFitDiagnostics,
      configured_minimum_gain:0.002,
      candidate_attempt_count:boostedTreeCandidateAttempts.length,
      candidate_tree_fit_count:boostedTreeCandidates.length,
      same_window_logistic_validation:boostedSameWindowLogisticValidation,
      same_window_logistic_holdout:boostedSameWindowLogisticHoldout,
      training_support_ready:boostedTrainingReady,
      selection_support_ready:boostedSelectionSupported,
      fit_failure_reason:boostedTrainingReady&&!boostedTreeFit
        ?(!boostedSelectionSupported?'SELECTION_CLASS_SUPPORT_BELOW_MINIMUM':
          'NO_GBDT_CONFIGURATION_BEAT_INNER_SELECTION_LOGISTIC_BY_REQUIRED_MARGIN'):null,
      trained:boostedTreeCandidates.length>0,selected:activeChallenger==='GBDT_RESIDUAL',
      probability_ready:activeChallenger==='GBDT_RESIDUAL',
      tree_count:boostedTreeFit?.tree_count||bestBoostedTreeDiagnosticCandidate?.fit?.tree_count||0,
      training_samples:boostedTreeFit?.training_samples||
        (boostedTrainingReady?boostedTrainingRows.length:0),
      refit_training_samples:boostedTreeFit?.training_samples||0,
      minimum_leaf_samples:boostedTreeFit?.minimum_leaf_samples||
        bestBoostedTreeDiagnosticCandidate?.fit?.minimum_leaf_samples||0,
      learning_rate:boostedTreeFit?.learning_rate??null,
      residual_scale:boostedTreeFit?.residual_scale??null,
      feature_importance:boostedTreeFit?.feature_importance||[],
      feature_importance_total_gain:boostedTreeFit?.feature_importance_total_gain??0,
      validation:boostedTreeValidation,
      hybrid_validation:hybridValidation,
      holdout:validationWinner?.name==='GBDT_RESIDUAL'?challengerHoldout:null,
      holdout_comparison:validationWinner?.name==='GBDT_RESIDUAL'?challengerHoldoutComparison:null
    },
    hybrid_model: {
      status:!hybridBoostedComponentReady?'GBDT_COMPONENT_NOT_STANDALONE_QUALIFIED':
        !neuralFit?'WAITING_FOR_BOTH_CHALLENGERS':
        !hybridNeuralComponentReady?'MLP_COMPONENT_NOT_STANDALONE_QUALIFIED':
        !hybridWeightFitSupported?'WAITING_FOR_HYBRID_WEIGHT_FIT_SUPPORT':
        !hybridSelectionSupported?'WAITING_FOR_HYBRID_WEIGHT_SELECTION_SUPPORT':
        hybridWeightCollapsedToSingleComponent?'HYBRID_WEIGHT_COLLAPSED_TO_SINGLE_COMPONENT':
        hybridRawOptimalBoostedWeight===null?'HYBRID_WEIGHT_NOT_IDENTIFIABLE':
        !bestHybridCandidate?'HYBRID_BLEND_SELECTION_NOT_BEAT_LOGISTIC':
        String(activeChallenger||'').startsWith('HYBRID_GBDT_MLP')?'OUT_OF_SAMPLE_VALIDATED':
        String(validationWinner?.name||'').startsWith('HYBRID_GBDT_MLP')?'VALIDATION_SELECTED_HOLDOUT_FAILED':
        'TRAINED_NOT_SELECTED',
      model_kind:'BLENDED_GBDT_MLP_V1',
      component_prequalification:hybridComponentPrequalification,
      architecture:hybridCandidates.find(candidate=>candidate.name===activeChallenger)?.fit?.architecture||
        bestHybridCandidate?.fit?.architecture||'GBDT_V5_PROBABILITY_BLEND_V2',
      trained:hybridSelectionCandidates.length>0,
      selected:String(activeChallenger||'').startsWith('HYBRID_GBDT_MLP'),
      probability_ready:String(activeChallenger||'').startsWith('HYBRID_GBDT_MLP'),
      selected_candidate:String(activeChallenger||'').startsWith('HYBRID_GBDT_MLP')?activeChallenger:null,
      boosted_weight:hybridCandidates.find(candidate=>candidate.name===activeChallenger)?.fit?.boosted_weight??
        bestHybridCandidate?.fit?.boosted_weight??null,
      selection_winner_candidate:bestHybridCandidate?.name??null,
      weight_fit_samples:hybridWeightFitTargets.samples,
      weight_fit_positive_samples:hybridWeightFitTargets.positive,
      weight_fit_negative_samples:hybridWeightFitTargets.negative,
      weight_fit_start_at:hybridWeightFitRows[0]?.at??null,
      weight_fit_end_at:hybridWeightFitRows.at(-1)?.at??null,
      weight_fit_cut_at:hybridWeightSelectionStartAt,
      weight_fit_supported:hybridWeightFitSupported,
      raw_optimal_boosted_weight:hybridRawOptimalBoostedWeight,
      minimum_component_weight:0.05,
      analytic_weight_identifiable:hybridRawOptimalBoostedWeight!==null,
      meaningful_two_component_weight:hybridOptimalBoostedWeight!==null,
      weight_collapsed_to_single_component:hybridWeightCollapsedToSingleComponent,
      selection_samples:hybridSelectionTargets.samples,
      selection_positive_samples:hybridSelectionTargets.positive,
      selection_negative_samples:hybridSelectionTargets.negative,
      selection_supported:hybridSelectionSupported,
      neural_component_selected:hybridNeuralComponentReady,
      neural_selected_member_index:neuralFit?.selected_member_index??null,
      neural_selected_residual_scale:neuralFit?.selected_residual_scale??null,
      selection_start_at:neuralHybridSelectionStartAt,
      selection_logistic_brier_score:hybridSelectionLogistic.model_brier_score??null,
      selection_required_brier_margin:comparisonMargin,
      probability_calibration:{
        neural:neuralFit?.probability_calibrator??null,
        boosted_tree:boostedTreeProbabilityCalibration,
        boosted_tree_logistic:boostedSameWindowLogisticCalibration
      },
      validation:hybridValidation,
      validation_logistic_brier_score:boostedSameWindowLogisticValidation.model_brier_score??null,
      candidate_selection_metrics:hybridSelectionCandidates.map(candidate=>({
        name:candidate.name,boosted_weight:candidate.fit.boosted_weight,
        weight_fit_sample_count:candidate.fit.blend_weight_fit_samples??0,
        weight_fit_start_at:candidate.fit.blend_weight_fit_start_at??null,
        weight_fit_end_at:candidate.fit.blend_weight_fit_end_at??null,
        weight_fit_selection_start_at:candidate.fit.blend_weight_selection_start_at??null,
        selection_sample_count:candidate.selection?.sample_count??0,
        selection_brier_score:candidate.selection?.model_brier_score??null,
        selection_base_rate_brier_score:candidate.selection?.base_rate_brier_score??null,
        selection_logistic_brier_score:hybridSelectionLogistic.model_brier_score??null,
        selection_beats_base_rate:candidate.selection?.beat_base_rate===true,
        selection_beats_same_window_logistic:hybridSelectionLogistic.evaluated===true&&
          candidate.selection?.evaluated===true&&
          candidate.selection.model_brier_score+comparisonMargin<hybridSelectionLogistic.model_brier_score,
        selected_for_outer_validation:candidate.name===bestHybridCandidate?.name
      })),
      candidate_validation_metrics:hybridCandidates.map(candidate=>({
        name:candidate.name,boosted_weight:candidate.fit.boosted_weight,
        validation_sample_count:candidate.validation?.sample_count??0,
        model_brier_score:candidate.validation?.model_brier_score??null,
        same_window_logistic_brier_score:boostedSameWindowLogisticValidation.model_brier_score??null,
        base_rate_brier_score:candidate.validation?.base_rate_brier_score??null,
        auc_roc:candidate.validation?.ranking_metrics?.auc_roc??null,
        top_10pct_precision_pct:candidate.validation?.ranking_metrics?.top_10_pct?.precision_pct??null,
        top_10pct_recall_pct:candidate.validation?.ranking_metrics?.top_10_pct?.recall_pct??null,
        top_20pct_precision_pct:candidate.validation?.ranking_metrics?.top_20_pct?.precision_pct??null,
        top_20pct_recall_pct:candidate.validation?.ranking_metrics?.top_20_pct?.recall_pct??null,
        beat_base_rate:candidate.validation?.beat_base_rate===true
      })),
      // Publish the validation winner's holdout evidence even when it failed.
      // Evidence visibility must not depend on acceptance state.
      holdout:String(validationWinner?.name||'').startsWith('HYBRID_GBDT_MLP')
        ?challengerHoldout:null,
      holdout_comparison:String(validationWinner?.name||'').startsWith('HYBRID_GBDT_MLP')
        ?challengerHoldoutComparison:null
    },
    model_selection: {
      selected_model: selectedModel,
      validation_challenger:validationWinner?.name||null,
      active_challenger:activeChallenger,
      challenger_holdout_passed:challengerHoldoutComparison.passed===true,
      challenger_holdout:validationWinner?challengerHoldout:null,
      challenger_holdout_comparison:validationWinner?challengerHoldoutComparison:null,
      challenger_candidate_metrics:challengerCandidates.map(candidate=>({
        name:candidate.name,
        validation_brier_score:candidate.validation.model_brier_score??null,
        validation_base_rate_brier_score:candidate.validation.base_rate_brier_score??null,
        validation_beats_base_rate:candidate.validation.beat_base_rate===true,
        holdout_brier_score:candidate.name===validationWinner?.name
          ?challengerHoldout.model_brier_score??null:null,
        holdout_beats_base_rate:candidate.name===validationWinner?.name
          ?challengerHoldout.beat_base_rate===true:null,
        holdout_comparison_passed:candidate.name===validationWinner?.name
          ?challengerHoldoutComparison.passed===true:null
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
    feature_names: [...activeFeatureNames],
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
          ? isCognitiveBinaryModelVariant(row.selected_model||row.model_variant) &&
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
      target: String(row.selected_model||row.model_variant||'')==='TEMPORAL_TCN' ||
        isCognitiveBinaryModelVariant(row.selected_model||row.model_variant) ||
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
