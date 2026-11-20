import {createHash} from 'node:crypto';
import {verifyVersionedModelArtifact} from './model-artifact-guardian.mjs';

export const NEURAL_CLOSURE_TARGET_DEFINITION =
  'FIRST_TOUCH_PLUS_3_PCT_BEFORE_MINUS_2_PCT_WITHIN_4H_1M_V1';
export const NEURAL_CLOSURE_TARGET_SEMANTICS =
  'UP_IF_PLUS_3_PCT_FIRST_BEFORE_MINUS_2_PCT_ELSE_NON_SUCCESS_WITHIN_4H_1M_V1';
export const NEURAL_CLOSURE_HORIZON_MS = 4 * 60 * 60 * 1000;
export const NEURAL_CLOSURE_PURGE_MS = 24 * 60 * 60 * 1000;
export const NEURAL_CLOSURE_OUTCOME_SOURCE =
  'BINANCE_OFFICIAL_CLOSED_1M_FIRST_TOUCH_4H_V1';
export const NEURAL_CLOSURE_FEATURE_SEQUENCE_INTERVAL_MS = 15 * 60 * 1000;
// Keep cross-sectional selection aligned with the existing temporal ranking evaluator.
export const NEURAL_CLOSURE_RANKING_BUCKET_MS = 15 * 60 * 1000;
export const NEURAL_CLOSURE_MIN_CLASS_SUPPORT = 50;
export const NEURAL_CLOSURE_BRIER_MARGIN = 0.003;
export const NEURAL_CLOSURE_EXECUTION_RETURN_CONTRACT =
  'FIRST_TOUCH_PRICE_WITH_OPEN_GAP_AWARE_EXITS_V1';
export const NEURAL_CLOSURE_MODEL_FAMILIES = Object.freeze([
  'COGNITIVE_MLP_V5',
  'TCN_V6',
  'TCN_V7',
  'TCN_V8',
  'TCN_V9',
  'TCN_V10',
  'TCN_V11',
  'TCN_LSTM_HYBRID',
  'HYBRID_TCN_ATTENTION',
  'DENSE_MLP',
  'MLP_GBDT_HYBRID'
]);

const finite = value => value !== null && value !== undefined &&
  value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value));
const number = value => finite(value) ? Number(value) : null;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const sigmoid = value => 1 / (1 + Math.exp(-clamp(value, -35, 35)));
const logit = value => Math.log(clamp(value, 1e-12, 1 - 1e-12) /
  (1 - clamp(value, 1e-12, 1 - 1e-12)));

// Coarse predeclared sweep spans the observed calibrated score range on the
// fixed cohort. The baseline and every challenger share this exact grid; no
// trade/risk gate is relaxed, and selection still uses a disjoint earlier block.
const ENTRY_THRESHOLD_GRID = Object.freeze([
  // Preserve the original coarse sweep and add a predeclared fine sweep around
  // the 0.35 candidate that produced 19 trades (one below the unchanged floor).
  // The earlier selection block chooses the threshold; purged outer validation
  // must independently re-test that frozen threshold before holdout can open.
  0.05,0.10,0.15,0.20,0.25,0.30,
  0.305,0.310,0.315,0.320,0.325,0.330,0.335,0.340,0.345,
  0.350,0.355,0.360,0.365,0.370,0.375,0.380,0.385,0.390,0.395,
  0.40,0.45,0.50,0.55,0.60,0.65,0.70,0.75,0.80
]);

// A separate high-resolution grid for the 35% diagnostic allocation only.
// The primary ENTRY_THRESHOLD_GRID and primary acceptance path remain unchanged.
const EXPANDED_THRESHOLD_WINDOW_DIAGNOSTIC_GRID = Object.freeze(
  Array.from({length:51},(_,index)=>Number((0.280+index*0.001).toFixed(3)))
);

function summarizeProbabilityDistribution(values) {
  if(!Array.isArray(values)||values.length===0||values.some(value=>
    !finite(value)||Number(value)<0||Number(value)>1)){
    return {schema:'NEURAL_ENTRY_PROBABILITY_DISTRIBUTION_V1',
      status:'UNAVAILABLE',sample_count:Array.isArray(values)?values.length:0};
  }
  const sorted=values.map(Number).sort((a,b)=>a-b);
  const quantile=fraction=>{
    const position=(sorted.length-1)*fraction;
    const lower=Math.floor(position),upper=Math.ceil(position);
    const ratio=position-lower;
    return Number((sorted[lower]*(1-ratio)+sorted[upper]*ratio).toFixed(8));
  };
  const mean=sorted.reduce((sum,value)=>sum+value,0)/sorted.length;
  const variance=sorted.reduce((sum,value)=>sum+(value-mean)**2,0)/sorted.length;
  const atOrAboveThreshold=Object.fromEntries(ENTRY_THRESHOLD_GRID.map(threshold=>{
    let low=0,high=sorted.length;
    while(low<high){
      const middle=(low+high)>>1;
      if(sorted[middle]<threshold)low=middle+1;
      else high=middle;
    }
    return [threshold,sorted.length-low];
  }));
  return {
    schema:'NEURAL_ENTRY_PROBABILITY_DISTRIBUTION_V1',
    status:'AVAILABLE',
    sample_count:sorted.length,
    minimum:Number(sorted[0].toFixed(8)),
    p50:quantile(0.50),p75:quantile(0.75),p90:quantile(0.90),
    p95:quantile(0.95),p99:quantile(0.99),
    maximum:Number(sorted.at(-1).toFixed(8)),
    mean:Number(mean.toFixed(8)),
    standard_deviation:Number(Math.sqrt(variance).toFixed(8)),
    at_or_above_threshold:atOrAboveThreshold,
    diagnostic_only:true,
    used_to_select_threshold:false,
    labels_used:false
  };
}

function summarizeFrozenThresholdWindow(values,threshold) {
  const distribution={...summarizeProbabilityDistribution(values)};
  delete distribution.used_to_select_threshold;
  return {
    ...distribution,
    schema:'RADARX_FROZEN_THRESHOLD_WINDOW_DISTRIBUTION_V1',
    frozen_threshold:finite(threshold)?Number(threshold):null,
    frozen_threshold_signal_count:finite(threshold)
      ?values.filter(value=>Number(value)>=Number(threshold)).length:null,
    diagnostic_only:true,
    score_values_only:true
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key =>
      [key, stableValue(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new TypeError('NEURAL_CLOSURE_NON_FINITE_CANONICAL_VALUE');
  return value;
}
export function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}
export function sha256Canonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Hash a mapped array without materializing the mapped array or its complete
 * canonical JSON representation. Each item is serialized independently, so
 * large temporal tensors never require a single multi-gigabyte JS string.
 */
export function sha256CanonicalArrayMapped(rows,mapRow) {
  if(!Array.isArray(rows))
    throw new TypeError('NEURAL_CLOSURE_CANONICAL_ROWS_REQUIRED');
  if(typeof mapRow!=='function')
    throw new TypeError('NEURAL_CLOSURE_CANONICAL_ROW_MAPPER_REQUIRED');
  const hash=createHash('sha256');
  hash.update('[');
  for(let index=0;index<rows.length;index++){
    if(index>0)hash.update(',');
    hash.update(canonicalJson(mapRow(rows[index])));
  }
  hash.update(']');
  return hash.digest('hex');
}

/**
 * Validate the price actually available at the first-touch exit.
 * Intrabar touches fill at the barrier; opening gaps fill at the candle open;
 * horizon-end rows fill at the final closed-candle close.
 */
export function isValidFourHourFirstTouchExecution(firstTouch,outcome,realizedReturnPct) {
  const baseline=number(firstTouch?.baseline_price);
  const take=number(firstTouch?.take_profit_price);
  const stop=number(firstTouch?.stop_loss_price);
  const exit=number(firstTouch?.exit_price);
  const realized=number(realizedReturnPct);
  if(baseline===null||baseline<=0||take===null||stop===null||exit===null||exit<=0||
    realized===null||Math.abs(take/baseline-1.03)>1e-10||
    Math.abs(stop/baseline-0.98)>1e-10)return false;
  const resolution=firstTouch?.resolution;
  const source=firstTouch?.exit_price_source;
  const candle=firstTouch?.exit_candle;
  const candleOpenTime=number(candle?.open_time);
  const candleCloseTime=number(candle?.close_time);
  const candleOpen=number(candle?.open);
  const candleHigh=number(candle?.high);
  const candleLow=number(candle?.low);
  const candleClose=number(candle?.close);
  const firstTouchAt=number(firstTouch?.first_touch_at);
  const candleEvidenceValid=candle?.source==='BINANCE_PUBLIC_REST'&&
    candle?.is_closed===true&&candleOpenTime!==null&&candleCloseTime===candleOpenTime+59_999&&
    candleOpen!==null&&candleHigh!==null&&candleLow!==null&&candleClose!==null&&
    candleOpen>0&&candleLow>0&&candleClose>0&&
    candleHigh>=Math.max(candleOpen,candleClose,candleLow)&&
    candleLow<=Math.min(candleOpen,candleClose);
  if(!candleEvidenceValid||firstTouchAt===null)return false;
  const expected=outcome==='UP'?'TAKE_PROFIT_FIRST':
    outcome==='DOWN'?'STOP_LOSS_FIRST':
    outcome==='FLAT'?'HORIZON_END':null;
  if(resolution!==expected)return false;
  const tolerance=Math.max(1e-8,Math.abs(exit)*1e-10);
  if(outcome==='UP'){
    if(source==='BARRIER'&&(Math.abs(exit-take)>tolerance||
      candleOpen>=take||candleHigh<take||candleLow<=stop||
      firstTouchAt!==candleCloseTime))return false;
    if(source==='OPEN_GAP'&&(exit+ tolerance<take||
      Math.abs(exit-candleOpen)>tolerance||firstTouchAt!==candleOpenTime))return false;
    if(!['BARRIER','OPEN_GAP'].includes(source))return false;
  }else if(outcome==='DOWN'){
    if(source==='BARRIER'&&(Math.abs(exit-stop)>tolerance||
      candleOpen<=stop||candleLow>stop||candleHigh>=take||
      firstTouchAt!==candleCloseTime))return false;
    if(source==='OPEN_GAP'&&(exit-tolerance>stop||
      Math.abs(exit-candleOpen)>tolerance||firstTouchAt!==candleOpenTime))return false;
    if(!['BARRIER','OPEN_GAP'].includes(source))return false;
  }else if(outcome==='FLAT'){
    if(source!=='HORIZON_CLOSE'||Math.abs(exit-candleClose)>tolerance||
      firstTouchAt!==candleCloseTime)return false;
  }else return false;
  const expectedReturn=(exit/baseline-1)*100;
  return Math.abs(realized-expectedReturn)<=1e-8;
}

/**
 * Resolve the exact +3% before -2% label from 240 consecutive completed
 * Binance Spot one-minute candles. If both barriers fall inside the same
 * candle, OHLC cannot determine which was first and the row is rejected.
 * Opening gaps exit at the observable open, not the nominal barrier price.
 */
export function buildFourHourFirstTouchOutcome({
  id,symbol,baselineAt,baselinePrice,candles,
  featureInformationCutoffAt=baselineAt,marketContext={},sourceEvidence
}={}){
  const fail=(reason,extra={})=>({training_eligible:false,status:'REJECTED',
    reason,id:id??null,symbol:symbol??null,...extra});
  if(typeof id!=='string'||!id.trim()||typeof symbol!=='string'||!symbol.trim())
    return fail('IDENTITY_MISSING');
  const normalizedSymbol=String(symbol).trim().toUpperCase();
  if(!/^[A-Z0-9]{1,26}USDT$/.test(normalizedSymbol))
    return fail('BINANCE_SPOT_USDT_SYMBOL_REQUIRED');
  if(!sourceEvidence||sourceEvidence.exchange!=='BINANCE'||
    sourceEvidence.market!=='SPOT'||sourceEvidence.interval!=='1m'||
    sourceEvidence.transport!=='BINANCE_PUBLIC_REST'||
    String(sourceEvidence.symbol||'').toUpperCase()!==normalizedSymbol||
    !finite(sourceEvidence.received_at)||Number(sourceEvidence.received_at)<Number(baselineAt)+NEURAL_CLOSURE_HORIZON_MS)
    return fail('BINANCE_SPOT_REST_1M_SOURCE_EVIDENCE_REQUIRED');
  if(!finite(baselineAt)||!finite(baselinePrice)||Number(baselinePrice)<=0||
    Number(featureInformationCutoffAt)!==Number(baselineAt))
    return fail('BASELINE_OR_FEATURE_CUTOFF_INVALID');
  const at=Number(baselineAt),price=Number(baselinePrice);
  if(!Number.isInteger(at))return fail('BASELINE_TIMESTAMP_MUST_BE_INTEGER_MILLISECONDS');
  if(!Array.isArray(candles)||candles.length!==240)
    return fail('EXACT_240_CLOSED_ONE_MINUTE_CANDLES_REQUIRED');
  const takePrice=price*1.03,stopPrice=price*0.98;
  let outcome='FLAT',resolution='HORIZON_END',firstTouchAt=at+NEURAL_CLOSURE_HORIZON_MS;
  let exitPrice=null,exitPriceSource=null,exitCandleEvidence=null;
  const snapshotExitCandle=candle=>({
    open_time:number(candle?.open_time??candle?.openTime),
    close_time:number(candle?.close_time??candle?.closeTime),
    open:number(candle?.open),high:number(candle?.high),
    low:number(candle?.low),close:number(candle?.close),
    is_closed:candle?.is_closed===true||candle?.closed===true,
    source:candle?.source
  });
  let ambiguous=false;
  // Binance closed klines end at open_time + 59,999 ms. The first
  // post-decision minute therefore opens one millisecond after the prior
  // closed-candle cutoff; 240 consecutive bars then end exactly at +4h.
  for(let index=0;index<240;index++){
    const candle=candles[index];
    const expectedOpen=at+1+index*60_000;
    const openTime=number(candle?.open_time??candle?.openTime);
    const closeTime=number(candle?.close_time??candle?.closeTime);
    const open=number(candle?.open),high=number(candle?.high);
    const low=number(candle?.low),close=number(candle?.close);
    if((candle?.is_closed!==true&&candle?.closed!==true)||
      candle?.source!=='BINANCE_PUBLIC_REST'||openTime!==expectedOpen||
      closeTime!==expectedOpen+59_999||open===null||high===null||
      low===null||close===null||open<=0||low<=0||close<=0||
      high<low||high<Math.max(open,close)||low>Math.min(open,close))
      return fail('ONE_MINUTE_CANDLE_GAP_OPEN_OR_INVALID:'+index);
  }
  for(let index=0;index<240;index++){
    const candle=candles[index];
    const expectedOpen=at+1+index*60_000;
    const open=Number(candle.open),high=Number(candle.high),low=Number(candle.low);
    // A gap through a barrier is executable at the observed open, not at
    // the more favorable nominal threshold.
    if(open>=takePrice){
      outcome='UP';resolution='TAKE_PROFIT_FIRST';
      firstTouchAt=expectedOpen;exitPrice=open;exitPriceSource='OPEN_GAP';
      exitCandleEvidence=snapshotExitCandle(candle);break;
    }
    if(open<=stopPrice){
      outcome='DOWN';resolution='STOP_LOSS_FIRST';
      firstTouchAt=expectedOpen;exitPrice=open;exitPriceSource='OPEN_GAP';
      exitCandleEvidence=snapshotExitCandle(candle);break;
    }
    const hitTake=high>=takePrice,hitStop=low<=stopPrice;
    if(hitTake&&hitStop){ambiguous=true;break;}
    if(hitTake){
      outcome='UP';resolution='TAKE_PROFIT_FIRST';
      firstTouchAt=expectedOpen+59_999;exitPrice=takePrice;exitPriceSource='BARRIER';
      exitCandleEvidence=snapshotExitCandle(candle);break;
    }
    if(hitStop){
      outcome='DOWN';resolution='STOP_LOSS_FIRST';
      firstTouchAt=expectedOpen+59_999;exitPrice=stopPrice;exitPriceSource='BARRIER';
      exitCandleEvidence=snapshotExitCandle(candle);break;
    }
  }
  if(ambiguous)return fail('AMBIGUOUS_BOTH_BARRIERS_TOUCHED_IN_ONE_MINUTE_CANDLE',{
    target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
    target_semantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
    outcome_source:NEURAL_CLOSURE_OUTCOME_SOURCE,
    horizon_ms:NEURAL_CLOSURE_HORIZON_MS
  });
  const finalClose=number(candles.at(-1)?.close);
  if(finalClose===null||finalClose<=0)return fail('FINAL_ONE_MINUTE_CLOSE_INVALID');
  if(outcome==='FLAT'){
    exitPrice=finalClose;
    exitPriceSource='HORIZON_CLOSE';
    exitCandleEvidence=snapshotExitCandle(candles.at(-1));
  }
  if(!finite(exitPrice)||Number(exitPrice)<=0||!exitPriceSource)
    return fail('FIRST_TOUCH_EXECUTION_PRICE_INVALID');
  const realizedReturnPct=(Number(exitPrice)/price-1)*100;
  const horizonCloseReturnPct=(finalClose/price-1)*100;
  const resolvedAt=at+NEURAL_CLOSURE_HORIZON_MS;
  const canonicalPath=candles.map(candle=>({
    open_time:number(candle?.open_time??candle?.openTime),
    close_time:number(candle?.close_time??candle?.closeTime),
    open:number(candle?.open),high:number(candle?.high),
    low:number(candle?.low),close:number(candle?.close),
    volume:finite(candle?.volume)?Number(candle.volume):null,
    quote_volume:finite(candle?.quoteVolume??candle?.quote_volume)
      ?Number(candle.quoteVolume??candle.quote_volume):null
  }));
  const rawKlinesSha256=createHash('sha256')
    .update(JSON.stringify(canonicalPath)).digest('hex');
  return {
    id,symbol:normalizedSymbol,market:'BINANCE_SPOT_USDT',
    at,resolved_at:resolvedAt,horizon_ms:NEURAL_CLOSURE_HORIZON_MS,
    feature_information_cutoff_at:at,
    target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
    target_semantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
    outcome_source:NEURAL_CLOSURE_OUTCOME_SOURCE,
    source_audit:{
      exchange:'BINANCE',market:'SPOT',interval:'1m',
      transport:'BINANCE_PUBLIC_REST',symbol:normalizedSymbol,
      received_at:Number(sourceEvidence.received_at),
      observed_candles:240,raw_klines_sha256:rawKlinesSha256,
      path_digest_algorithm:'SHA256_CANONICAL_240_CLOSED_KLINES_V1'
    },
    outcome,target:outcome==='UP'?1:0,
    first_touch:{
      resolution,first_touch_at:firstTouchAt,path_resolution:'1M',
      observed_candles:240,raw_klines_sha256:rawKlinesSha256,baseline_price:price,
      take_profit_price:takePrice,stop_loss_price:stopPrice,
      exit_price:Number(exitPrice),exit_price_source:exitPriceSource,
      exit_candle:exitCandleEvidence
    },
    execution_return_contract:NEURAL_CLOSURE_EXECUTION_RETURN_CONTRACT,
    realized_return_pct:realizedReturnPct,
    horizon_close_return_pct:horizonCloseReturnPct,
    market_context:marketContext&&typeof marketContext==='object'?{
      kama_efficiency_ratio:marketContext.kama_efficiency_ratio??null,
      atr_pct:marketContext.atr_pct??null,
      atr_baseline_pct:marketContext.atr_baseline_pct??null
    }:null,
    closed_candle_baseline:true,
    training_eligible:true,status:'RESOLVED'
  };
}

function classCounts(labels) {
  let positive = 0, negative = 0;
  for (const label of labels) {
    if (label === 1) positive++;
    else if (label === 0) negative++;
    else throw new TypeError('NEURAL_CLOSURE_LABEL_NOT_BINARY');
  }
  return {positive, negative, total: positive + negative};
}

/**
 * Focal-Asymmetric Brier loss for the binary first-touch success event.
 * Positive/negative class weights are derived from TRAINING labels only.
 * The returned gradient is d(loss)/d(probability); logitGradient also applies
 * the sigmoid Jacobian. No non-finite probability is silently clipped in.
 */
export function focalAsymmetricBrierLoss(probability, target, {
  gammaPositive = 1,
  gammaNegative = 2,
  positiveWeight = 1,
  negativeWeight = 1
} = {}) {
  if (!finite(probability) || Number(probability) < 0 || Number(probability) > 1)
    throw new TypeError('FOCAL_ASYMMETRIC_BRIER_PROBABILITY_INVALID');
  if (target !== 0 && target !== 1)
    throw new TypeError('FOCAL_ASYMMETRIC_BRIER_TARGET_INVALID');
  for (const [key, value] of Object.entries({gammaPositive, gammaNegative,
    positiveWeight, negativeWeight})) {
    if (!finite(value) || Number(value) < 0)
      throw new TypeError('FOCAL_ASYMMETRIC_BRIER_CONFIG_INVALID:' + key);
  }
  const p = Number(probability);
  const loss = target === 1
    ? Number(positiveWeight) * (1 - p) ** (Number(gammaPositive) + 2)
    : Number(negativeWeight) * p ** (Number(gammaNegative) + 2);
  const derivative = target === 1
    ? -Number(positiveWeight) * (Number(gammaPositive) + 2) *
      (1 - p) ** (Number(gammaPositive) + 1)
    : Number(negativeWeight) * (Number(gammaNegative) + 2) *
      p ** (Number(gammaNegative) + 1);
  const result = {
    loss,
    probabilityGradient: derivative,
    logitGradient: derivative * p * (1 - p)
  };
  if (!Object.values(result).every(Number.isFinite))
    throw new TypeError('FOCAL_ASYMMETRIC_BRIER_NON_FINITE_RESULT');
  return result;
}

export function deriveTrainingClassWeights(trainingLabels) {
  if (!Array.isArray(trainingLabels) || !trainingLabels.length)
    throw new TypeError('NEURAL_CLOSURE_TRAINING_LABELS_REQUIRED');
  const counts = classCounts(trainingLabels);
  if (!counts.positive || !counts.negative)
    throw new Error('NEURAL_CLOSURE_TRAINING_REQUIRES_BOTH_CLASSES');
  return {
    positiveWeight: counts.total / (2 * counts.positive),
    negativeWeight: counts.total / (2 * counts.negative),
    training_positive: counts.positive,
    training_negative: counts.negative,
    derived_from: 'TRAINING_PARTITION_ONLY'
  };
}

export function validateFourHourRows(inputRows, {
  targetDefinition = NEURAL_CLOSURE_TARGET_DEFINITION,
  outcomeSource = NEURAL_CLOSURE_OUTCOME_SOURCE,
  horizonMs = NEURAL_CLOSURE_HORIZON_MS
} = {}) {
  if (!Array.isArray(inputRows) || inputRows.length < 1)
    throw new TypeError('NEURAL_CLOSURE_ROWS_REQUIRED');
  if (targetDefinition !== NEURAL_CLOSURE_TARGET_DEFINITION ||
      outcomeSource !== NEURAL_CLOSURE_OUTCOME_SOURCE ||
      Number(horizonMs) !== NEURAL_CLOSURE_HORIZON_MS)
    throw new Error('NEURAL_CLOSURE_TARGET_CONTRACT_OVERRIDE_FORBIDDEN');

  const ids = new Set(), symbolsAt = new Set();
  const rows = inputRows.map((source, index) => {
    if (!source || typeof source !== 'object')
      throw new TypeError('NEURAL_CLOSURE_ROW_INVALID:' + index);
    const id = String(source.id || '').trim();
    const symbol = String(source.symbol || '').trim().toUpperCase();
    const at = number(source.at);
    const resolvedAt = number(source.resolved_at);
    const declaredHorizon = number(source.horizon_ms);
    const cutoff = number(source.feature_information_cutoff_at);
    if (!id || !symbol || at === null || at <= 0 || resolvedAt === null ||
        declaredHorizon !== NEURAL_CLOSURE_HORIZON_MS ||
        resolvedAt - at !== NEURAL_CLOSURE_HORIZON_MS ||
        cutoff !== at)
      throw new Error('NEURAL_CLOSURE_ROW_TIME_OR_CUTOFF_INVALID:' + index);
    if (source.target_definition !== targetDefinition ||
        source.target_semantics !== NEURAL_CLOSURE_TARGET_SEMANTICS ||
        source.outcome_source !== outcomeSource)
      throw new Error('NEURAL_CLOSURE_ROW_TARGET_OR_SOURCE_MISMATCH:' + index);
    if(source.training_eligible!==true||source.closed_candle_baseline!==true)
      throw new Error('NEURAL_CLOSURE_ROW_NOT_TRAINING_ELIGIBLE_CLOSED_BASELINE:'+index);
    const sourceAudit=source.source_audit;
    if(source.market!=='BINANCE_SPOT_USDT'||
      sourceAudit?.exchange!=='BINANCE'||sourceAudit?.market!=='SPOT'||
      sourceAudit?.interval!=='1m'||sourceAudit?.transport!=='BINANCE_PUBLIC_REST'||
      String(sourceAudit?.symbol||'').toUpperCase()!==symbol||
      Number(sourceAudit?.observed_candles)!==240||
      !/^[a-f0-9]{64}$/i.test(String(sourceAudit?.raw_klines_sha256||''))||
      source.first_touch?.raw_klines_sha256!==sourceAudit.raw_klines_sha256)
      throw new Error('NEURAL_CLOSURE_ROW_BINANCE_SOURCE_AUDIT_INVALID:'+index);
    if (!['UP','DOWN','FLAT'].includes(source.outcome))
      throw new Error('NEURAL_CLOSURE_ROW_OUTCOME_INVALID:' + index);
    const firstTouch=source.first_touch;
    const expectedResolution=source.outcome==='UP'?'TAKE_PROFIT_FIRST':
      source.outcome==='DOWN'?'STOP_LOSS_FIRST':'HORIZON_END';
    if(!firstTouch||firstTouch.path_resolution!=='1M'||
      firstTouch.resolution!==expectedResolution||!finite(firstTouch.first_touch_at))
      throw new Error('NEURAL_CLOSURE_ROW_FIRST_TOUCH_AUDIT_INVALID:'+index);
    if(source.outcome==='FLAT'
      ?Number(firstTouch.first_touch_at)!==resolvedAt
      :Number(firstTouch.first_touch_at)<=at||Number(firstTouch.first_touch_at)>resolvedAt)
      throw new Error('NEURAL_CLOSURE_ROW_FIRST_TOUCH_TIME_INVALID:'+index);
    const baselinePrice=number(firstTouch.baseline_price);
    const takeProfitPrice=number(firstTouch.take_profit_price);
    const stopLossPrice=number(firstTouch.stop_loss_price);
    if(baselinePrice===null||baselinePrice<=0||
      takeProfitPrice===null||stopLossPrice===null||
      Math.abs(takeProfitPrice/baselinePrice-1.03)>1e-10||
      Math.abs(stopLossPrice/baselinePrice-0.98)>1e-10)
      throw new Error('NEURAL_CLOSURE_ROW_EXIT_BARRIER_INVALID:'+index);
    if(source.execution_return_contract!==NEURAL_CLOSURE_EXECUTION_RETURN_CONTRACT||
      !isValidFourHourFirstTouchExecution(firstTouch,source.outcome,source.realized_return_pct))
      throw new Error('NEURAL_CLOSURE_ROW_EXECUTION_EXIT_INVALID:'+index);
    if(Number(firstTouch.observed_candles)!==240)
      throw new Error('NEURAL_CLOSURE_ROW_ONE_MINUTE_COVERAGE_INVALID:'+index);
    const target = source.outcome === 'UP' ? 1 : 0;
    if (source.target !== undefined && Number(source.target) !== target)
      throw new Error('NEURAL_CLOSURE_ROW_TARGET_LABEL_MISMATCH:' + index);
    if (ids.has(id)) throw new Error('NEURAL_CLOSURE_DUPLICATE_ID:' + id);
    const identity = symbol + ':' + String(Math.trunc(at));
    if (symbolsAt.has(identity))
      throw new Error('NEURAL_CLOSURE_DUPLICATE_SYMBOL_TIMESTAMP:' + identity);
    ids.add(id); symbolsAt.add(identity);
    const row = {
      ...source, id, symbol, at, resolved_at: resolvedAt,
      horizon_ms: NEURAL_CLOSURE_HORIZON_MS,
      feature_information_cutoff_at: cutoff,
      target, outcome: source.outcome
    };
    if (row.realized_return_pct !== undefined &&
        !finite(row.realized_return_pct))
      throw new Error('NEURAL_CLOSURE_REALIZED_RETURN_NON_FINITE:' + id);
    return row;
  }).sort((a,b) => a.at-b.at || a.symbol.localeCompare(b.symbol) ||
    a.id.localeCompare(b.id));
  return rows;
}

/**
 * UTC-day partitioning uses nominal 60/20/20 calendar-day boundaries and
 * removes one complete UTC day between each adjacent partition. Every model
 * consumes these exact row identities; same-day symbols are never split.
 */
export function splitFourHourRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1)
    throw new TypeError('NEURAL_CLOSURE_SPLIT_ROWS_REQUIRED');
  const days = [...new Set(rows.map(row =>
    Math.floor(Number(row.at) / NEURAL_CLOSURE_PURGE_MS) *
      NEURAL_CLOSURE_PURGE_MS))].sort((a,b)=>a-b);
  if (days.length < 8)
    throw new Error('NEURAL_CLOSURE_INSUFFICIENT_UTC_DAYS_FOR_PURGED_60_20_20_SPLIT');
  const nominalTrainEnd = Math.floor(days.length * 0.60);
  const nominalValidationEnd = Math.floor(days.length * 0.80);
  const trainDays = days.slice(0, nominalTrainEnd);
  const purgeTrainValidationDays = days.slice(nominalTrainEnd, nominalTrainEnd + 1);
  const validationDays = days.slice(nominalTrainEnd + 1, nominalValidationEnd);
  const purgeValidationHoldoutDays = days.slice(nominalValidationEnd, nominalValidationEnd + 1);
  const holdoutDays = days.slice(nominalValidationEnd + 1);
  if (!trainDays.length || !validationDays.length || !holdoutDays.length ||
      purgeTrainValidationDays.length !== 1 ||
      purgeValidationHoldoutDays.length !== 1)
    throw new Error('NEURAL_CLOSURE_PURGED_SPLIT_EMPTY_PARTITION');
  const toSet = values => new Set(values);
  const trainSet = toSet(trainDays), validationSet = toSet(validationDays);
  const holdoutSet = toSet(holdoutDays);
  const purgeSet = toSet([...purgeTrainValidationDays,...purgeValidationHoldoutDays]);
  const dayOf = row => Math.floor(Number(row.at) / NEURAL_CLOSURE_PURGE_MS) *
    NEURAL_CLOSURE_PURGE_MS;
  const train = rows.filter(row=>trainSet.has(dayOf(row)));
  const validation = rows.filter(row=>validationSet.has(dayOf(row)));
  const holdout = rows.filter(row=>holdoutSet.has(dayOf(row)));
  const purged = rows.filter(row=>purgeSet.has(dayOf(row)));
  const identities = set => new Set(set.map(row=>row.id));
  const a=identities(train),b=identities(validation),c=identities(holdout);
  if ([...a].some(id=>b.has(id)||c.has(id)) || [...b].some(id=>c.has(id)))
    throw new Error('NEURAL_CLOSURE_PARTITION_IDENTITY_OVERLAP');
  const firstAt = values => values.length ? Math.min(...values.map(row=>row.at)) : null;
  const lastAt = values => values.length ? Math.max(...values.map(row=>row.at)) : null;
  if (!(lastAt(train)<firstAt(validation)-NEURAL_CLOSURE_PURGE_MS) ||
      !(lastAt(validation)<firstAt(holdout)-NEURAL_CLOSURE_PURGE_MS))
    throw new Error('NEURAL_CLOSURE_ONE_DAY_PURGE_NOT_ENFORCED');
  return {
    schema:'RADARX_NEURAL_CLOSURE_PURGED_60_20_20_UTC_DAY_SPLIT_V1',
    nominal_day_fractions:{train:0.60,validation:0.20,holdout:0.20},
    purge_ms:NEURAL_CLOSURE_PURGE_MS,
    train,validation,holdout,purged,
    days:{
      total:days.length,
      train:trainDays,
      purge_train_validation:purgeTrainValidationDays,
      validation:validationDays,
      purge_validation_holdout:purgeValidationHoldoutDays,
      holdout:holdoutDays
    },
    counts:{train:train.length,validation:validation.length,holdout:holdout.length,
      purged:purged.length,total:rows.length},
    boundaries:{
      train_last_at:lastAt(train),validation_first_at:firstAt(validation),
      validation_last_at:lastAt(validation),holdout_first_at:firstAt(holdout)
    }
  };
}

function validateCalibrationInputs(logits, labels) {
  if (!Array.isArray(logits) || !Array.isArray(labels) ||
      logits.length !== labels.length || !logits.length ||
      logits.some(value=>!finite(value)) ||
      labels.some(value=>value!==0&&value!==1))
    throw new TypeError('NEURAL_CALIBRATION_INPUT_INVALID');
  return classCounts(labels);
}
function supportFailure(counts, minimumPositives, minimumNegatives) {
  return counts.positive < minimumPositives ||
    counts.negative < minimumNegatives;
}
function binaryNll(logits, labels, transform) {
  let total=0;
  for(let i=0;i<logits.length;i++){
    const p=clamp(transform(logits[i]),1e-12,1-1e-12);
    total-=labels[i]*Math.log(p)+(1-labels[i])*Math.log(1-p);
  }
  return total/logits.length;
}

export function fitTemperatureScaler(logits, labels, {
  minimumPositives = NEURAL_CLOSURE_MIN_CLASS_SUPPORT,
  minimumNegatives = NEURAL_CLOSURE_MIN_CLASS_SUPPORT
} = {}) {
  const counts=validateCalibrationInputs(logits,labels);
  const base={method:'TEMPERATURE_SCALING',fitted:false,accepted:false,
    samples:logits.length,positive:counts.positive,negative:counts.negative,
    min_positive:minimumPositives,min_negative:minimumNegatives,temperature:null};
  if(supportFailure(counts,minimumPositives,minimumNegatives))
    return {...base,status:'INSUFFICIENT_CLASS_SUPPORT'};
  const objective=logTemperature=>{
    const temperature=Math.exp(logTemperature);
    return binaryNll(logits,labels,value=>sigmoid(value/temperature));
  };
  let left=-3,right=3;
  const ratio=(Math.sqrt(5)-1)/2;
  let x1=right-ratio*(right-left),x2=left+ratio*(right-left);
  let f1=objective(x1),f2=objective(x2);
  for(let iteration=0;iteration<180;iteration++){
    if(f1<=f2){
      right=x2;x2=x1;f2=f1;x1=right-ratio*(right-left);f1=objective(x1);
    }else{
      left=x1;x1=x2;f1=f2;x2=left+ratio*(right-left);f2=objective(x2);
    }
  }
  const temperature=Math.exp((left+right)/2);
  const before=binaryNll(logits,labels,sigmoid);
  const after=objective(Math.log(temperature));
  return {...base,status:'FITTED',fitted:true,accepted:after<before,
    temperature,fit_nll_before:before,fit_nll_after:after};
}

export function fitPlattScaler(logits, labels, {
  minimumPositives = NEURAL_CLOSURE_MIN_CLASS_SUPPORT,
  minimumNegatives = NEURAL_CLOSURE_MIN_CLASS_SUPPORT,
  iterations = 160,
  regularization = 1e-5
} = {}) {
  const counts=validateCalibrationInputs(logits,labels);
  const base={method:'PLATT_SCALING',fitted:false,accepted:false,
    samples:logits.length,positive:counts.positive,negative:counts.negative,
    min_positive:minimumPositives,min_negative:minimumNegatives,
    slope:null,intercept:null};
  if(supportFailure(counts,minimumPositives,minimumNegatives))
    return {...base,status:'INSUFFICIENT_CLASS_SUPPORT'};

  const before=binaryNll(logits,labels,sigmoid);
  const steps=Math.max(1,Math.min(2000,Math.trunc(iterations)));
  const fitOrientation=orientation=>{
    let slope=orientation,intercept=0;
    const lower=orientation>0?0.05:-20;
    const upper=orientation>0?20:-0.05;
    for(let iteration=0;iteration<steps;iteration++){
      let g0=regularization*(slope-orientation),g1=regularization*intercept;
      let h00=regularization,h01=0,h11=regularization;
      for(let i=0;i<logits.length;i++){
        const x=Number(logits[i]),p=sigmoid(slope*x+intercept);
        const error=p-labels[i],weight=p*(1-p);
        g0+=error*x;g1+=error;
        h00+=weight*x*x;h01+=weight*x;h11+=weight;
      }
      const determinant=h00*h11-h01*h01;
      if(!Number.isFinite(determinant)||determinant<=1e-18)
        return {orientation,status:'SINGULAR_HESSIAN'};
      const deltaSlope=(h11*g0-h01*g1)/determinant;
      const deltaIntercept=(-h01*g0+h00*g1)/determinant;
      slope=clamp(slope-deltaSlope,lower,upper);
      intercept=clamp(intercept-deltaIntercept,-12,12);
      if(!Number.isFinite(slope)||!Number.isFinite(intercept))
        return {orientation,status:'NON_FINITE_OPTIMIZER_STATE'};
      if(Math.max(Math.abs(deltaSlope),Math.abs(deltaIntercept))<1e-9)break;
    }
    const after=binaryNll(logits,labels,value=>sigmoid(slope*value+intercept));
    if(!Number.isFinite(after))
      return {orientation,status:'NON_FINITE_OBJECTIVE'};
    return {orientation,status:'FITTED',slope,intercept,fit_nll_after:after,
      accepted:after<before};
  };

  // Platt orientation is selected only on the declared calibration-fit rows.
  // The held-out calibration-check and outer-validation blocks never choose
  // the sign; they remain independent tests of the selected transform.
  const orientationTrials=[fitOrientation(1),fitOrientation(-1)];
  const fitted=orientationTrials.filter(candidate=>candidate.status==='FITTED');
  if(!fitted.length)
    return {...base,status:'OPTIMIZER_FAILED',orientation_trials:orientationTrials};
  fitted.sort((a,b)=>a.fit_nll_after-b.fit_nll_after||
    (b.orientation-a.orientation));
  const best=fitted[0];
  return {...base,status:'FITTED',fitted:true,accepted:best.accepted===true,
    slope:best.slope,intercept:best.intercept,
    slope_orientation:best.orientation>0?'POSITIVE':'NEGATIVE',
    fit_nll_before:before,fit_nll_after:best.fit_nll_after,
    orientation_trials:orientationTrials.map(candidate=>({
      orientation:candidate.orientation>0?'POSITIVE':'NEGATIVE',
      status:candidate.status,
      accepted:candidate.accepted??false,
      slope:candidate.slope??null,
      intercept:candidate.intercept??null,
      fit_nll_after:candidate.fit_nll_after??null
    }))
  };
}
export function applyProbabilityCalibrator(logitValue, calibrator) {
  if(!finite(logitValue))throw new TypeError('NEURAL_CALIBRATION_LOGIT_NON_FINITE');
  if(!calibrator||calibrator.fitted!==true)return sigmoid(Number(logitValue));
  if(calibrator.method==='TEMPERATURE_SCALING'){
    if(!finite(calibrator.temperature)||Number(calibrator.temperature)<=0)
      throw new TypeError('NEURAL_TEMPERATURE_INVALID');
    return sigmoid(Number(logitValue)/Number(calibrator.temperature));
  }
  if(calibrator.method==='PLATT_SCALING'){
    if(!finite(calibrator.slope)||!finite(calibrator.intercept))
      throw new TypeError('NEURAL_PLATT_PARAMETERS_INVALID');
    return sigmoid(Number(calibrator.slope)*Number(logitValue)+Number(calibrator.intercept));
  }
  throw new TypeError('NEURAL_CALIBRATOR_METHOD_UNSUPPORTED');
}

function brier(probabilities,labels) {
  if(!probabilities.length||probabilities.length!==labels.length)return null;
  return probabilities.reduce((sum,p,i)=>sum+(p-labels[i])**2,0)/probabilities.length;
}
function focalMean(probabilities,labels,weights) {
  if(!probabilities.length||probabilities.length!==labels.length)return null;
  return probabilities.reduce((sum,p,i)=>sum+focalAsymmetricBrierLoss(p,labels[i],weights).loss,0)/
    probabilities.length;
}
function chronologicalValidationBlocks(rows,{fitFraction=0.50}={}) {
  const days=[...new Set(rows.map(row=>Math.floor(row.at/NEURAL_CLOSURE_PURGE_MS)*
    NEURAL_CLOSURE_PURGE_MS))].sort((a,b)=>a-b);
  const empty={
    fit:[],purged:[],threshold_selection:[],threshold_purged:[],check:[],
    days:{fit:[],purge:[],threshold_selection:[],threshold_purge:[],check:[]}
  };
  // Require enough whole UTC days for three disjoint chronological blocks
  // and two full-day purges. Anything shorter or an invalid allocation fails closed.
  if(days.length<7||!finite(fitFraction)||Number(fitFraction)<0.20||
    Number(fitFraction)>0.70)return empty;
  const fitCount=Math.max(2,Math.floor(days.length*Number(fitFraction)));
  const fitDaysList=days.slice(0,fitCount);
  const purgeDaysList=days.slice(fitCount,fitCount+1);
  const remainingDays=days.slice(fitCount+1);
  const thresholdCount=Math.max(1,Math.floor(remainingDays.length/2));
  const thresholdDaysList=remainingDays.slice(0,thresholdCount);
  const thresholdPurgeDaysList=remainingDays.slice(thresholdCount,thresholdCount+1);
  const checkDaysList=remainingDays.slice(thresholdCount+1);
  if(!fitDaysList.length||!purgeDaysList.length||!thresholdDaysList.length||
    !thresholdPurgeDaysList.length||!checkDaysList.length)return empty;
  const fitDays=new Set(fitDaysList),purgeDays=new Set(purgeDaysList),
    thresholdDays=new Set(thresholdDaysList),thresholdPurgeDays=new Set(thresholdPurgeDaysList),
    checkDays=new Set(checkDaysList);
  const dayOf=row=>Math.floor(row.at/NEURAL_CLOSURE_PURGE_MS)*NEURAL_CLOSURE_PURGE_MS;
  const fit=rows.filter(row=>fitDays.has(dayOf(row)));
  const purged=rows.filter(row=>purgeDays.has(dayOf(row)));
  const threshold_selection=rows.filter(row=>thresholdDays.has(dayOf(row)));
  const threshold_purged=rows.filter(row=>thresholdPurgeDays.has(dayOf(row)));
  const check=rows.filter(row=>checkDays.has(dayOf(row)));
  const lastAt=values=>values.length?Math.max(...values.map(row=>row.at)):null;
  const firstAt=values=>values.length?Math.min(...values.map(row=>row.at)):null;
  if(!(lastAt(fit)<firstAt(threshold_selection)-NEURAL_CLOSURE_PURGE_MS))
    throw new Error('NEURAL_CLOSURE_CALIBRATION_TO_THRESHOLD_ONE_DAY_PURGE_NOT_ENFORCED');
  if(!(lastAt(threshold_selection)<firstAt(check)-NEURAL_CLOSURE_PURGE_MS))
    throw new Error('NEURAL_CLOSURE_THRESHOLD_TO_OUTER_VALIDATION_ONE_DAY_PURGE_NOT_ENFORCED');
  return {
    fit,purged,threshold_selection,threshold_purged,check,
    days:{
      fit:fitDaysList,purge:purgeDaysList,
      threshold_selection:thresholdDaysList,
      threshold_purge:thresholdPurgeDaysList,
      check:checkDaysList
    }
  };
}
/** Public, deterministic split of the validation partition into chronological
 * calibration-fit, threshold-selection and untouched outer-validation blocks.
 * Each adjacent block is separated by one complete purged UTC day.
 */
export function buildNeuralClosureCalibrationBlocks(rows,options={}){
  if(!Array.isArray(rows)||!rows.length)
    throw new TypeError('NEURAL_CLOSURE_CALIBRATION_ROWS_REQUIRED');
  const blocks=chronologicalValidationBlocks(rows,options);
  return {
    ...blocks,
    support:{
      fit:classCounts(blocks.fit.map(row=>row.target)),
      purge:classCounts(blocks.purged.map(row=>row.target)),
      threshold_selection:classCounts(blocks.threshold_selection.map(row=>row.target)),
      threshold_purge:classCounts(blocks.threshold_purged.map(row=>row.target)),
      check:classCounts(blocks.check.map(row=>row.target))
    }
  };
}

function crossSectionalRankingMetrics(rows,probabilities){
  if(!Array.isArray(rows)||!Array.isArray(probabilities)||
    rows.length!==probabilities.length||!rows.length)return null;
  const buckets=new Map();
  for(let index=0;index<rows.length;index++){
    const at=number(rows[index]?.at),score=number(probabilities[index]);
    const target=rows[index]?.target;
    if(at===null||at<=0||score===null||score<0||score>1||
      (target!==0&&target!==1))return null;
    const bucket=Math.floor(at/NEURAL_CLOSURE_RANKING_BUCKET_MS);
    if(!buckets.has(bucket))buckets.set(bucket,[]);
    buckets.get(bucket).push({
      score,target,symbol:String(rows[index]?.symbol??''),
      id:String(rows[index]?.id??''),index
    });
  }
  const allGroups=[...buckets.values()];
  const groups=allGroups.filter(items=>items.length>=2);
  const singletonCount=allGroups.length-groups.length;
  const fractions=[5,10,20];
  const stats=new Map(fractions.map(pct=>[pct,{
    precision:[],recall:[],lift:[],selected:[]
  }]));
  let averagePrecisionSum=0,positiveGroups=0,totalPositives=0,multiSymbolRows=0,maxSize=0;
  for(const items of groups){
    const ordered=[...items].sort((a,b)=>b.score-a.score||
      a.symbol.localeCompare(b.symbol)||a.id.localeCompare(b.id)||a.index-b.index);
    const positives=ordered.reduce((sum,row)=>sum+(row.target===1?1:0),0);
    totalPositives+=positives;multiSymbolRows+=ordered.length;
    maxSize=Math.max(maxSize,ordered.length);
    if(positives>0){
      let hits=0,precisionSum=0;
      for(let rank=0;rank<ordered.length;rank++){
        if(ordered[rank].target===1){hits++;precisionSum+=hits/(rank+1);}
      }
      averagePrecisionSum+=precisionSum/positives;positiveGroups++;
    }
    for(const pct of fractions){
      const selected=Math.max(1,Math.ceil(ordered.length*pct/100));
      const hits=ordered.slice(0,selected).reduce((sum,row)=>sum+(row.target===1?1:0),0);
      const metric=stats.get(pct);
      metric.precision.push(hits/selected);metric.selected.push(selected);
      if(positives>0){
        metric.recall.push(hits/positives);
        metric.lift.push((hits/selected)/(positives/ordered.length));
      }
    }
  }
  const average=values=>values.length
    ?values.reduce((sum,value)=>sum+value,0)/values.length:null;
  const result={
    method:'WITHIN_15M_MULTI_SYMBOL_TOP_K_MACRO_V2',
    bucket_ms:NEURAL_CLOSURE_RANKING_BUCKET_MS,
    total_time_buckets:allGroups.length,groups:groups.length,
    singleton_buckets_excluded:singletonCount,
    multi_symbol_rows:multiSymbolRows,
    mean_symbols_per_ranking_bucket:groups.length
      ?Number((multiSymbolRows/groups.length).toFixed(3)):null,
    maximum_symbols_per_ranking_bucket:maxSize,
    groups_with_positive:positiveGroups,positive_events:totalPositives,
    average_precision:positiveGroups
      ?Number((averagePrecisionSum/positiveGroups).toFixed(5)):null
  };
  for(const pct of fractions){
    const metric=stats.get(pct),name='top_'+pct+'_pct';
    result[name]={
      groups:metric.precision.length,
      mean_selected_per_timestamp:average(metric.selected)===null?null:
        Number(average(metric.selected).toFixed(3)),
      precision_pct:average(metric.precision)===null?null:
        Number((average(metric.precision)*100).toFixed(2)),
      recall_pct:average(metric.recall)===null?null:
        Number((average(metric.recall)*100).toFixed(2)),
      lift:average(metric.lift)===null?null:Number(average(metric.lift).toFixed(5))
    };
  }
  return result;
}

export function buildWalkForwardCalibrationDiagnostics(rows,rawMap,{
  fitFraction=0.50,minimumClassSupport=NEURAL_CLOSURE_MIN_CLASS_SUPPORT,
  maximumBlocks=4,minimumTestDays=2,baselineRawMap=null,
  roundTripCostBps=30,minimumTrades=20,minimumWinRatePct=55,
  maximumDrawdownPct=8
}={}) {
  const unavailable=(reason,extra={})=>({
    schema:'RADARX_WALK_FORWARD_CALIBRATION_DIAGNOSTICS_V1',
    status:'UNAVAILABLE',diagnostic_only:true,holdout_values_used:false,
    calibration_uses_only_prior_matured_labels:true,reason,...extra
  });
  if(!Array.isArray(rows)||!rows.length||!(rawMap instanceof Map))
    return unavailable('ROWS_OR_VERIFIED_PREDICTION_MAP_INVALID');
  if(baselineRawMap!==null&&!(baselineRawMap instanceof Map))
    return unavailable('BASELINE_PREDICTION_MAP_INVALID');
  if(!finite(fitFraction)||Number(fitFraction)<0.20||Number(fitFraction)>0.80||
    !Number.isInteger(maximumBlocks)||maximumBlocks<2||
    !Number.isInteger(minimumTestDays)||minimumTestDays<1||
    !Number.isInteger(minimumClassSupport)||minimumClassSupport<1||
    !finite(roundTripCostBps)||Number(roundTripCostBps)<0||
    !Number.isInteger(minimumTrades)||minimumTrades<1||
    !finite(minimumWinRatePct)||Number(minimumWinRatePct)<0||
    !finite(maximumDrawdownPct)||Number(maximumDrawdownPct)<0)
    return unavailable('WALK_FORWARD_CONFIGURATION_INVALID');
  const ordered=[...rows].sort((a,b)=>Number(a?.at)-Number(b?.at)||
    String(a?.id??'').localeCompare(String(b?.id??'')));
  const ids=new Set();
  for(let index=0;index<ordered.length;index++){
    const row=ordered[index],id=String(row?.id??'');
    const at=row?.at,resolved=row?.resolved_at,probability=rawMap.get(id);
    if(!id||ids.has(id))
      return unavailable('WALK_FORWARD_ROW_ID_MISSING_OR_DUPLICATE',{
        row_index:index,row_id:id||null
      });
    if(!finite(at)||!finite(resolved)||Number(resolved)<=Number(at))
      return unavailable('WALK_FORWARD_ROW_TIME_INVALID',{
        row_index:index,row_id:id,at:at??null,resolved_at:resolved??null
      });
    if(row.target!==0&&row.target!==1)
      return unavailable('WALK_FORWARD_ROW_TARGET_INVALID',{
        row_index:index,row_id:id,target:row?.target??null
      });
    if(!finite(probability)||Number(probability)<0||Number(probability)>1)
      return unavailable('WALK_FORWARD_MODEL_SCORE_INVALID',{
        row_index:index,row_id:id,probability:probability??null,map_size:rawMap.size
      });
    if(baselineRawMap!==null){
      const baselineProbability=baselineRawMap.get(id);
      if(!finite(baselineProbability)||Number(baselineProbability)<0||
        Number(baselineProbability)>1)
        return unavailable('WALK_FORWARD_BASELINE_SCORE_INVALID',{
          row_index:index,row_id:id,
          probability:baselineProbability??null,map_size:baselineRawMap.size
        });
    }
    ids.add(id);
  }
  const dayOf=row=>Math.floor(Number(row.at)/NEURAL_CLOSURE_PURGE_MS)*
    NEURAL_CLOSURE_PURGE_MS;
  const days=[...new Set(ordered.map(dayOf))].sort((a,b)=>a-b);
  const fitDayCount=Math.floor(days.length*Number(fitFraction));
  if(days.length<10||fitDayCount<5||fitDayCount+1>=days.length)
    return unavailable('INSUFFICIENT_CHRONOLOGICAL_DAYS');
  const initialFitDays=new Set(days.slice(0,fitDayCount));
  const initialFitRows=ordered.filter(row=>initialFitDays.has(dayOf(row)));
  const firstForwardDay=days[fitDayCount+1];
  const firstForwardRows=ordered.filter(row=>dayOf(row)===firstForwardDay);
  const firstForwardAt=firstForwardRows.length
    ?Math.min(...firstForwardRows.map(row=>Number(row.at))):null;
  if(firstForwardAt===null)return unavailable('EMPTY_FIRST_FORWARD_TEST_BLOCK');
  // Both static references are fitted only on labels resolved before the
  // first scored block. Unmatured labels must not leak into either comparator.
  const initialFitMaturedRows=initialFitRows.filter(row=>
    finite(row?.resolved_at)&&Number(row.resolved_at)<firstForwardAt);
  const initialSupport=classCounts(initialFitMaturedRows.map(row=>row.target));
  if(initialSupport.positive<minimumClassSupport||
    initialSupport.negative<minimumClassSupport)
    return unavailable('INITIAL_CALIBRATION_CLASS_SUPPORT_NOT_MET',{
      initial_fit_rows:initialFitRows.length,
      initial_fit_matured_rows:initialFitMaturedRows.length,
      initial_fit_support:initialSupport,
      minimum_class_support:minimumClassSupport
    });
  const fitStaticCalibrator=(fitRows,scoreMap)=>{
    const fitScores=probabilitiesFor(fitRows,scoreMap);
    const platt=fitPlattScaler(fitScores.map(logit),
      fitRows.map(row=>row.target),{
        minimumPositives:minimumClassSupport,
        minimumNegatives:minimumClassSupport
      });
    return {platt,calibrator:platt.fitted===true&&platt.accepted===true?platt:null};
  };
  const initialModelFit=fitStaticCalibrator(initialFitMaturedRows,rawMap);
  const staticCalibrator=initialModelFit.calibrator;
  const initialBaselineFit=baselineRawMap===null?null:
    fitStaticCalibrator(initialFitMaturedRows,baselineRawMap);
  const staticBaselineCalibrator=initialBaselineFit?.calibrator??null;
  let cursor=fitDayCount+1; // one full UTC day is purged before the first test block.
  const availableDays=days.length-cursor;
  let blockCount=0;
  for(let candidate=Math.min(maximumBlocks,availableDays);candidate>=2;candidate--){
    if(availableDays-(candidate-1)>=candidate*minimumTestDays){
      blockCount=candidate;break;
    }
  }
  if(blockCount<2)
    return unavailable('INSUFFICIENT_DISJOINT_FORWARD_TEST_BLOCKS',{
      initial_fit_days:fitDayCount,available_test_days:availableDays,
      minimum_test_days:minimumTestDays
    });
  const distributable=availableDays-(blockCount-1);
  const baseSize=Math.floor(distributable/blockCount),extras=distributable%blockCount;
  const plans=[];
  for(let i=0;i<blockCount;i++){
    const size=baseSize+(i<extras?1:0),planned=days.slice(cursor,cursor+size);
    if(planned.length!==size)return unavailable('FORWARD_BLOCK_PLAN_INCOMPLETE');
    plans.push(planned);cursor+=size;
    if(i<blockCount-1)cursor+=1; // one full UTC day between scored blocks.
  }
  const firstRows=ordered.filter(row=>dayOf(row)===plans[0][0]);
  const initialLastAt=Math.max(...initialFitMaturedRows.map(row=>Number(row.at)));
  const initialPurgeGapMs=firstRows.length
    ?Math.min(...firstRows.map(row=>Number(row.at)))-initialLastAt:null;
  if(!(initialPurgeGapMs>NEURAL_CLOSURE_PURGE_MS))
    return unavailable('INITIAL_FIT_TO_FORWARD_TEST_PURGE_NOT_ENFORCED',{
      initial_purge_gap_ms:initialPurgeGapMs
    });
  const priorTestRows=[],blocks=[];
  const staticAll=[],adaptiveAll=[],baselineStaticAll=[],baselineAdaptiveAll=[],labelsAll=[];
  const firstForwardRowsForSelection=[],firstForwardAdaptiveProbabilities=[];
  const laterForwardRows=[],laterForwardAdaptiveProbabilities=[];
  const average=values=>values.reduce((sum,value)=>sum+value,0)/values.length;
  for(let i=0;i<plans.length;i++){
    const daySet=new Set(plans[i]),testRows=ordered.filter(row=>daySet.has(dayOf(row)));
    if(!testRows.length)return unavailable('EMPTY_FORWARD_TEST_BLOCK',{block_index:i+1});
    const firstAt=Math.min(...testRows.map(row=>Number(row.at)));
    const lastAt=Math.max(...testRows.map(row=>Number(row.at)));
    const candidates=[...initialFitRows,...priorTestRows];
    const historyRows=candidates.filter(row=>
      finite(row?.resolved_at)&&Number(row.resolved_at)<firstAt);
    const excludedUnmatured=candidates.length-historyRows.length;
    const support=classCounts(historyRows.map(row=>row.target));
    const latestAt=historyRows.length?Math.max(...historyRows.map(row=>Number(row.at))):null;
    const latestResolved=historyRows.length?Math.max(...historyRows.map(row=>Number(row.resolved_at))):null;
    const purgeGap=latestAt===null?null:firstAt-latestAt;
    const maturityGap=latestResolved===null?null:firstAt-latestResolved;
    if(!historyRows.length||support.positive<minimumClassSupport||
      support.negative<minimumClassSupport)
      return unavailable('FORWARD_CALIBRATION_HISTORY_CLASS_SUPPORT_NOT_MET',{
        block_index:i+1,history_rows:historyRows.length,history_support:support,
        minimum_class_support:minimumClassSupport
      });
    if(!(purgeGap>NEURAL_CLOSURE_PURGE_MS)||!(maturityGap>0))
      return unavailable('FORWARD_CALIBRATION_HISTORY_NOT_FULLY_PURGED_OR_MATURED',{
        block_index:i+1,purge_gap_ms:purgeGap,maturity_gap_ms:maturityGap
      });
    const adaptivePlatt=fitStaticCalibrator(historyRows,rawMap);
    const adaptiveCalibrator=adaptivePlatt.calibrator;
    const staticProb=probabilitiesFor(testRows,rawMap,staticCalibrator);
    const adaptiveProb=probabilitiesFor(testRows,rawMap,adaptiveCalibrator);
    const staticScore=brier(staticProb,testRows.map(row=>row.target));
    const adaptiveScore=brier(adaptiveProb,testRows.map(row=>row.target));
    const staticRanking=crossSectionalRankingMetrics(testRows,staticProb);
    const adaptiveRanking=crossSectionalRankingMetrics(testRows,adaptiveProb);
    const rankOrderPreserved=Boolean(staticRanking&&adaptiveRanking&&
      staticRanking.average_precision===adaptiveRanking.average_precision&&
      [5,10,20].every(pct=>{
        const key='top_'+pct+'_pct';
        return staticRanking[key]?.precision_pct===adaptiveRanking[key]?.precision_pct&&
          staticRanking[key]?.recall_pct===adaptiveRanking[key]?.recall_pct;
      }));
    let baselineBlock=null,baselineStaticProb=null,baselineAdaptiveProb=null;
    if(baselineRawMap!==null){
      const baselineAdaptivePlatt=fitStaticCalibrator(historyRows,baselineRawMap);
      baselineStaticProb=probabilitiesFor(testRows,baselineRawMap,staticBaselineCalibrator);
      baselineAdaptiveProb=probabilitiesFor(testRows,baselineRawMap,
        baselineAdaptivePlatt.calibrator);
      const baselineStaticScore=brier(baselineStaticProb,testRows.map(row=>row.target));
      const baselineAdaptiveScore=brier(baselineAdaptiveProb,testRows.map(row=>row.target));
      const baselineStaticRanking=crossSectionalRankingMetrics(testRows,baselineStaticProb);
      const baselineAdaptiveRanking=crossSectionalRankingMetrics(testRows,baselineAdaptiveProb);
      baselineBlock={
        static_calibrator_method:staticBaselineCalibrator?'PLATT':'RAW_FALLBACK',
        static_brier_score:baselineStaticScore,
        adaptive_calibrator_method:baselineAdaptivePlatt.calibrator?'PLATT':'RAW_FALLBACK',
        adaptive_calibrator_fitted:baselineAdaptivePlatt.platt.fitted===true,
        adaptive_calibrator_accepted:baselineAdaptivePlatt.platt.accepted===true,
        adaptive_brier_score:baselineAdaptiveScore,
        static_ranking_metrics:baselineStaticRanking,
        adaptive_ranking_metrics:baselineAdaptiveRanking,
        static_model_brier_improvement:baselineStaticScore-staticScore,
        adaptive_model_brier_improvement:baselineAdaptiveScore-adaptiveScore,
        adaptive_average_precision_improvement:
          adaptiveRanking&&baselineAdaptiveRanking
            ?adaptiveRanking.average_precision-baselineAdaptiveRanking.average_precision:null,
        adaptive_top_5_precision_improvement:
          adaptiveRanking&&baselineAdaptiveRanking
            ?adaptiveRanking.top_5_pct.precision_pct-baselineAdaptiveRanking.top_5_pct.precision_pct:null,
        adaptive_top_10_precision_improvement:
          adaptiveRanking&&baselineAdaptiveRanking
            ?adaptiveRanking.top_10_pct.precision_pct-baselineAdaptiveRanking.top_10_pct.precision_pct:null,
        adaptive_top_20_precision_improvement:
          adaptiveRanking&&baselineAdaptiveRanking
            ?adaptiveRanking.top_20_pct.precision_pct-baselineAdaptiveRanking.top_20_pct.precision_pct:null
      };
      baselineStaticAll.push(...baselineStaticProb);
      baselineAdaptiveAll.push(...baselineAdaptiveProb);
    }
    // Regime diagnostics split identical forward-block rows by the
    // closed BTC 3h regime feature. They are observational only and do not
    // train regime specialists, fit calibrators, select thresholds or alter gates.
    const regimeOfRow=row=>{
      const btcTrend=number(row?.temporal_sequence?.at(-1)?.[19]);
      return btcTrend===null?'BTC_REGIME_UNKNOWN':
        btcTrend>=0?'BTC_RISK_ON':'BTC_RISK_OFF';
    };
    const regimeDiagnostics=Object.fromEntries(
      ['BTC_RISK_ON','BTC_RISK_OFF','BTC_REGIME_UNKNOWN'].map(regime=>{
        const indices=[];
        for(let index=0;index<testRows.length;index++){
          if(regimeOfRow(testRows[index])===regime)indices.push(index);
        }
        const regimeRows=indices.map(index=>testRows[index]);
        const selectValues=values=>indices.map(index=>values[index]);
        const regimeStaticProb=selectValues(staticProb);
        const regimeAdaptiveProb=selectValues(adaptiveProb);
        const regimeLabels=regimeRows.map(row=>row.target);
        const regimeSupport=classCounts(regimeLabels);
        const regimeStaticBrier=regimeRows.length?brier(regimeStaticProb,regimeLabels):null;
        const regimeAdaptiveBrier=regimeRows.length?brier(regimeAdaptiveProb,regimeLabels):null;
        const staticRegimeRanking=regimeRows.length
          ?crossSectionalRankingMetrics(regimeRows,regimeStaticProb):null;
        const adaptiveRegimeRanking=regimeRows.length
          ?crossSectionalRankingMetrics(regimeRows,regimeAdaptiveProb):null;
        let baselineRegime=null;
        if(baselineRawMap!==null&&baselineStaticProb&&baselineAdaptiveProb){
          const baseStatic=selectValues(baselineStaticProb);
          const baseAdaptive=selectValues(baselineAdaptiveProb);
          const baseStaticBrier=regimeRows.length?brier(baseStatic,regimeLabels):null;
          const baseAdaptiveBrier=regimeRows.length?brier(baseAdaptive,regimeLabels):null;
          const baseStaticRanking=regimeRows.length
            ?crossSectionalRankingMetrics(regimeRows,baseStatic):null;
          const baseAdaptiveRanking=regimeRows.length
            ?crossSectionalRankingMetrics(regimeRows,baseAdaptive):null;
          baselineRegime={
            static_brier_score:baseStaticBrier,
            adaptive_brier_score:baseAdaptiveBrier,
            static_model_brier_improvement:baseStaticBrier===null||regimeStaticBrier===null
              ?null:Number((baseStaticBrier-regimeStaticBrier).toFixed(10)),
            adaptive_model_brier_improvement:baseAdaptiveBrier===null||regimeAdaptiveBrier===null
              ?null:Number((baseAdaptiveBrier-regimeAdaptiveBrier).toFixed(10)),
            static_ranking_metrics:baseStaticRanking,
            adaptive_ranking_metrics:baseAdaptiveRanking,
            adaptive_average_precision_improvement:
              adaptiveRegimeRanking&&baseAdaptiveRanking
                ?Number((adaptiveRegimeRanking.average_precision-
                  baseAdaptiveRanking.average_precision).toFixed(8)):null,
            adaptive_top_5_precision_improvement:
              adaptiveRegimeRanking&&baseAdaptiveRanking
                ?Number((adaptiveRegimeRanking.top_5_pct.precision_pct-
                  baseAdaptiveRanking.top_5_pct.precision_pct).toFixed(8)):null,
            adaptive_top_10_precision_improvement:
              adaptiveRegimeRanking&&baseAdaptiveRanking
                ?Number((adaptiveRegimeRanking.top_10_pct.precision_pct-
                  baseAdaptiveRanking.top_10_pct.precision_pct).toFixed(8)):null,
            adaptive_top_20_precision_improvement:
              adaptiveRegimeRanking&&baseAdaptiveRanking
                ?Number((adaptiveRegimeRanking.top_20_pct.precision_pct-
                  baseAdaptiveRanking.top_20_pct.precision_pct).toFixed(8)):null
          };
        }
        return [regime,{
          sample_count:regimeRows.length,
          positive_count:regimeSupport.positive,
          negative_count:regimeSupport.negative,
          positive_rate:Number((regimeSupport.positive/Math.max(1,regimeSupport.total)).toFixed(8)),
          static_brier_score:regimeStaticBrier,
          adaptive_brier_score:regimeAdaptiveBrier,
          adaptive_brier_improvement:regimeStaticBrier===null||regimeAdaptiveBrier===null
            ?null:Number((regimeStaticBrier-regimeAdaptiveBrier).toFixed(10)),
          static_mean_probability:regimeStaticProb.length
            ?Number(average(regimeStaticProb).toFixed(8)):null,
          adaptive_mean_probability:regimeAdaptiveProb.length
            ?Number(average(regimeAdaptiveProb).toFixed(8)):null,
          static_ranking_metrics:staticRegimeRanking,
          adaptive_ranking_metrics:adaptiveRegimeRanking,
          ...(baselineRegime?{logistic_baseline:baselineRegime}:{})
        }];
      })
    );
    const positives=classCounts(testRows.map(row=>row.target)).positive;
    blocks.push({
      block_index:i+1,first_at:firstAt,last_at:lastAt,
      first_utc_day:plans[i][0],last_utc_day:plans[i].at(-1),
      test_day_count:plans[i].length,sample_count:testRows.length,
      positive_count:positives,negative_count:testRows.length-positives,
      observed_positive_rate:Number((positives/testRows.length).toFixed(8)),
      calibration_history_rows:historyRows.length,calibration_history_support:support,
      latest_history_at:latestAt,latest_history_label_resolved_at:latestResolved,
      calibration_to_test_purge_gap_ms:purgeGap,
      latest_label_maturity_gap_ms:maturityGap,
      excluded_unmatured_history_rows:excludedUnmatured,
      static_calibrator_method:staticCalibrator?'PLATT':'RAW_FALLBACK',
      static_brier_score:staticScore,
      static_mean_probability:Number(average(staticProb).toFixed(8)),
      adaptive_calibrator_method:adaptiveCalibrator?'PLATT':'RAW_FALLBACK',
      adaptive_calibrator_fitted:adaptivePlatt.platt.fitted===true,
      adaptive_calibrator_accepted:adaptivePlatt.platt.accepted===true,
      adaptive_brier_score:adaptiveScore,
      adaptive_mean_probability:Number(average(adaptiveProb).toFixed(8)),
      adaptive_brier_improvement:Number((staticScore-adaptiveScore).toFixed(10)),
      static_ranking_metrics:staticRanking,
      adaptive_ranking_metrics:adaptiveRanking,
      btc_regime_diagnostics:regimeDiagnostics,
      calibration_preserved_cross_sectional_ranking:rankOrderPreserved,
      ...(baselineBlock?{logistic_baseline:baselineBlock}:{}),
      adaptive_fit_nll_before:adaptivePlatt.platt.fit_nll_before??null,
      adaptive_fit_nll_after:adaptivePlatt.platt.fit_nll_after??null
    });
    staticAll.push(...staticProb);adaptiveAll.push(...adaptiveProb);
    labelsAll.push(...testRows.map(row=>row.target));
    if(i===0){
      firstForwardRowsForSelection.push(...testRows);
      firstForwardAdaptiveProbabilities.push(...adaptiveProb);
    }else{
      laterForwardRows.push(...testRows);
      laterForwardAdaptiveProbabilities.push(...adaptiveProb);
    }
    priorTestRows.push(...testRows);
  }
  const positives=labelsAll.reduce((sum,value)=>sum+value,0),count=labelsAll.length;
  const staticBrier=brier(staticAll,labelsAll),adaptiveBrier=brier(adaptiveAll,labelsAll);
  const baselineStaticBrier=baselineRawMap===null?null:brier(baselineStaticAll,labelsAll);
  const baselineAdaptiveBrier=baselineRawMap===null?null:brier(baselineAdaptiveAll,labelsAll);
  // Causal execution diagnostic: select from the first forward block only,
  // freeze that threshold, and test it on the later blocks with adaptive
  // calibration fitted exclusively on prior matured labels.
  const forwardThresholdSelection=selectThreshold(
    firstForwardRowsForSelection,firstForwardAdaptiveProbabilities,
    Number(roundTripCostBps),{
      minimumTrades,minimumWinRatePct,maximumDrawdownPct,
      thresholdGrid:ENTRY_THRESHOLD_GRID
    }
  );
  const frozenForwardThreshold=forwardThresholdSelection.threshold;
  const laterForwardMetrics=finite(frozenForwardThreshold)&&laterForwardRows.length
    ?portfolioMetrics(laterForwardRows,laterForwardAdaptiveProbabilities,
      frozenForwardThreshold,Number(roundTripCostBps)):null;
  const laterForwardRiskGates={
    return_data_complete:laterForwardMetrics?.return_data_status==='COMPLETE',
    minimum_validation_trades:Number(laterForwardMetrics?.trade_count)>=minimumTrades,
    minimum_validation_win_rate:finite(laterForwardMetrics?.win_rate_pct)&&
      laterForwardMetrics.win_rate_pct>=minimumWinRatePct,
    positive_validation_net_pnl:finite(laterForwardMetrics?.net_pnl_pct)&&
      laterForwardMetrics.net_pnl_pct>0,
    maximum_validation_drawdown:finite(laterForwardMetrics?.max_drawdown_pct)&&
      laterForwardMetrics.max_drawdown_pct<=maximumDrawdownPct
  };
  const laterForwardPassed=Object.values(laterForwardRiskGates).every(Boolean);
  const causalForwardExecution={
    schema:'RADARX_CAUSAL_WALK_FORWARD_ENTRY_POLICY_V1',
    diagnostic_only:true,
    labels_used_for_threshold_selection:'FIRST_FORWARD_BLOCK_ONLY',
    later_threshold_frozen:true,
    adaptive_calibration_used:true,
    holdout_values_used:false,
    acceptance_gates:{
      minimum_trades:minimumTrades,
      minimum_win_rate_pct:minimumWinRatePct,
      positive_net_pnl:true,
      maximum_drawdown_pct:maximumDrawdownPct,
      round_trip_cost_bps:Number(roundTripCostBps)
    },
    selection:{
      block_index:1,sample_count:firstForwardRowsForSelection.length,
      status:forwardThresholdSelection.status,
      eligible_threshold_count:forwardThresholdSelection.eligible_count??0,
      selected_threshold:frozenForwardThreshold,
      selected_metrics:forwardThresholdSelection.selected?{
        signal_count:forwardThresholdSelection.selected.signal_count,
        trade_count:forwardThresholdSelection.selected.trade_count,
        win_rate_pct:forwardThresholdSelection.selected.win_rate_pct,
        net_pnl_pct:forwardThresholdSelection.selected.net_pnl_pct,
        max_drawdown_pct:forwardThresholdSelection.selected.max_drawdown_pct
      }:null
    },
    later_forward_validation:{
      block_count:Math.max(0,blocks.length-1),
      sample_count:laterForwardRows.length,
      frozen_threshold:frozenForwardThreshold,
      metrics:laterForwardMetrics?{
        signal_count:laterForwardMetrics.signal_count,
        trade_count:laterForwardMetrics.trade_count,
        win_rate_pct:laterForwardMetrics.win_rate_pct,
        net_pnl_pct:laterForwardMetrics.net_pnl_pct,
        max_drawdown_pct:laterForwardMetrics.max_drawdown_pct,
        return_data_status:laterForwardMetrics.return_data_status,
        skipped_capacity:laterForwardMetrics.skipped_capacity,
        skipped_same_symbol:laterForwardMetrics.skipped_same_symbol
      }:null,
      risk_gates:Object.fromEntries(Object.entries(laterForwardRiskGates)
        .map(([key,value])=>[key,value?'PASS':'FAIL'])),
      passed:laterForwardPassed
    }
  };
  const aggregateRanking=crossSectionalRankingMetrics(
    ordered.filter(row=>new Set(plans.flat()).has(dayOf(row))),
    adaptiveAll
  );
  const aggregateBaselineRanking=baselineRawMap===null?null:
    crossSectionalRankingMetrics(
      ordered.filter(row=>new Set(plans.flat()).has(dayOf(row))),
      baselineAdaptiveAll
    );
  return {
    schema:'RADARX_WALK_FORWARD_CALIBRATION_DIAGNOSTICS_V1',
    status:'AVAILABLE',diagnostic_only:true,
    affects_model_weights:false,affects_primary_probabilities:false,
    affects_primary_threshold:false,affects_acceptance_gates:false,
    labels_used_for_gradient_fit:false,labels_used_for_calibration:true,
    labels_used_for_current_or_future_block_calibration:false,
    calibration_uses_only_prior_matured_labels:true,holdout_values_used:false,
    baseline_comparison_available:baselineRawMap!==null,
    baseline_comparison_policy:baselineRawMap!==null
      ?'SAME_ROWS_SAME_FORWARD_BLOCKS_SAME_MATURED_HISTORY_AND_PURGE':'NOT_REQUESTED',
    purge_ms:NEURAL_CLOSURE_PURGE_MS,ranking_bucket_ms:NEURAL_CLOSURE_RANKING_BUCKET_MS,
    minimum_class_support:minimumClassSupport,
    initial_fit_fraction:Number(fitFraction),initial_fit_day_count:fitDayCount,
    initial_fit_rows:initialFitRows.length,initial_fit_support:initialSupport,
    initial_calibrator_method:staticCalibrator?'PLATT':'RAW_FALLBACK',
    initial_calibrator_accepted:initialModelFit.platt.accepted===true,
    initial_purge_gap_ms:initialPurgeGapMs,
    scored_block_count:blocks.length,scored_rows:count,
    unscored_purge_and_initial_fit_rows:ordered.length-count,
    causal_forward_execution:causalForwardExecution,
    aggregate:{
      observed_positive_rate:Number((positives/count).toFixed(8)),
      static_brier_score:staticBrier,adaptive_brier_score:adaptiveBrier,
      adaptive_brier_improvement:Number((staticBrier-adaptiveBrier).toFixed(10)),
      static_mean_probability:Number(average(staticAll).toFixed(8)),
      adaptive_mean_probability:Number(average(adaptiveAll).toFixed(8)),
      baseline_static_brier_score:baselineStaticBrier,
      baseline_adaptive_brier_score:baselineAdaptiveBrier,
      static_brier_improvement_vs_logistic:baselineStaticBrier===null?null:
        Number((baselineStaticBrier-staticBrier).toFixed(10)),
      adaptive_brier_improvement_vs_logistic:baselineAdaptiveBrier===null?null:
        Number((baselineAdaptiveBrier-adaptiveBrier).toFixed(10)),
      ranking_metrics:aggregateRanking,
      logistic_ranking_metrics:aggregateBaselineRanking,
      adaptive_average_precision_improvement_vs_logistic:
        aggregateRanking&&aggregateBaselineRanking
          ?Number((aggregateRanking.average_precision-
            aggregateBaselineRanking.average_precision).toFixed(8)):null
    },
    blocks
  };
}

function collectTcnLstmPreInnerCalibrationMap(predictions,validationRows,holdoutRows){
  const property='pre_inner_calibration_probability';
  if(!Array.isArray(predictions))
    return {status:'UNAVAILABLE',reason:'PREDICTIONS_NOT_ARRAY',map:new Map()};
  const staged=predictions.filter(item=>
    Object.prototype.hasOwnProperty.call(item??{},property));
  if(!staged.length)
    return {status:'NOT_PROVIDED',reason:'PRE_INNER_CALIBRATION_CHANNEL_MISSING',map:new Map()};
  const holdoutIds=new Set(holdoutRows.map(row=>String(row.id)));
  if(staged.some(item=>holdoutIds.has(String(item?.id||''))))
    return {status:'REJECTED_HOLDOUT_DIAGNOSTIC_EXPOSURE',
      reason:'PRE_INNER_DIAGNOSTICS_MUST_NOT_INCLUDE_FINAL_HOLDOUT_VALUES',map:new Map()};
  const expectedIds=new Set(validationRows.map(row=>String(row.id)));
  const map=new Map();
  for(const item of staged){
    const id=String(item?.id||'');
    const value=item?.[property];
    if(!id||!expectedIds.has(id)||map.has(id))
      return {status:'REJECTED_INVALID_DIAGNOSTIC_ROW_SET',
        reason:'PRE_INNER_DIAGNOSTIC_ID_INVALID_DUPLICATE_OR_OUT_OF_SCOPE',map:new Map()};
    if(!finite(value)||Number(value)<0||Number(value)>1)
      return {status:'REJECTED_INVALID_DIAGNOSTIC_VALUE',
        reason:'PRE_INNER_DIAGNOSTIC_PROBABILITY_OUT_OF_RANGE',map:new Map()};
    map.set(id,Number(value));
  }
  if(map.size!==expectedIds.size||[...expectedIds].some(id=>!map.has(id)))
    return {status:'REJECTED_INCOMPLETE_VALIDATION_COVERAGE',
      reason:'PRE_INNER_DIAGNOSTIC_MUST_COVER_EVERY_OUTER_VALIDATION_ROW',map:new Map()};
  return {status:'AVAILABLE',reason:null,map};
}

function buildTcnLstmProbabilityStageDiagnostics({
  preInner,calibrationFitRows,thresholdSelectionRows,validationRows,
  minimumClassSupport=NEURAL_CLOSURE_MIN_CLASS_SUPPORT,
  innerCalibratedThresholdSelection,innerCalibratedValidation,
  innerCalibratedThresholdSelectionProbabilities,innerCalibratedValidationProbabilities,
  sharedCalibratedThresholdSelection,sharedCalibratedValidation,
  sharedCalibratedThresholdSelectionProbabilities,sharedCalibratedValidationProbabilities,
  sharedCalibrationMethod
}={}){
  const base={
    schema:'RADARX_TCN_LSTM_PROBABILITY_STAGE_DISTRIBUTIONS_V1',
    diagnostic_only:true,
    labels_used:false,
    holdout_values_used:false,
    affects_primary_probabilities:false,
    affects_threshold_selection:false,
    shared_evaluator_calibration_method:sharedCalibrationMethod??null
  };
  if(preInner?.status!=='AVAILABLE')
    return {...base,status:preInner?.status??'NOT_PROVIDED',
      reason:preInner?.reason??'PRE_INNER_DIAGNOSTICS_UNAVAILABLE'};
  const distribution=(rows,map)=>summarizeProbabilityDistribution(
    rows.map(row=>map.get(String(row.id)))
  );
  const preThreshold=distribution(thresholdSelectionRows,preInner.map);
  const preValidation=distribution(validationRows,preInner.map);

  // Counterfactual only: fit one evaluator Platt calibrator directly on the
  // network's pre-inner scores, using the same isolated calibration-fit rows.
  // This tests whether applying an evaluator Platt transform to an already
  // internally-Platt-calibrated score compounds calibration error. Its outputs
  // never replace primary predictions or participate in threshold selection.
  const fitLabels=calibrationFitRows.map(row=>row.target);
  const fitLogits=probabilitiesFor(calibrationFitRows,preInner.map).map(logit);
  const directPlatt=fitPlattScaler(fitLogits,fitLabels,{
    minimumPositives:minimumClassSupport,
    minimumNegatives:minimumClassSupport
  });
  const directCalibrator=directPlatt.fitted===true&&directPlatt.accepted===true
    ?directPlatt:null;
  const directMethod=directCalibrator
    ?'SINGLE_STAGE_SHARED_PLATT_ON_PRE_INNER_SCORES'
    :'RAW_PRE_INNER_FALLBACK_PLATT_NOT_ACCEPTED';
  const scoredBlock=(rows,probabilities)=>({
    sample_count:rows.length,
    positive_count:classCounts(rows.map(row=>row.target)).positive,
    negative_count:classCounts(rows.map(row=>row.target)).negative,
    brier_score:brier(probabilities,rows.map(row=>row.target)),
    probability_distribution:summarizeProbabilityDistribution(probabilities)
  });
  const directThresholdProbabilities=probabilitiesFor(
    thresholdSelectionRows,preInner.map,directCalibrator
  );
  const directValidationProbabilities=probabilitiesFor(
    validationRows,preInner.map,directCalibrator
  );
  const rawThresholdProbabilities=probabilitiesFor(thresholdSelectionRows,preInner.map);
  const rawValidationProbabilities=probabilitiesFor(validationRows,preInner.map);
  const directCalibrationCounterfactual={
    schema:'RADARX_TCN_LSTM_SINGLE_STAGE_SHARED_PLATT_COUNTERFACTUAL_V1',
    diagnostic_only:true,
    affects_primary_probabilities:false,
    affects_threshold_selection:false,
    holdout_values_used:false,
    fit_partition:'CALIBRATION_FIT_ONLY',
    fit_rows:calibrationFitRows.length,
    fit_positive:classCounts(fitLabels).positive,
    fit_negative:classCounts(fitLabels).negative,
    fit_labels_used:true,
    threshold_selection_labels_used_for_fit:false,
    outer_validation_labels_used_for_fit:false,
    shared_calibrator:{
      method:'PLATT_SCALING',
      fitted:directPlatt.fitted,
      accepted:directPlatt.accepted,
      status:directPlatt.status,
      selected_path:directMethod,
      samples:directPlatt.samples,
      positive:directPlatt.positive,
      negative:directPlatt.negative,
      min_positive:directPlatt.min_positive,
      min_negative:directPlatt.min_negative,
      slope:directPlatt.slope,
      intercept:directPlatt.intercept,
      fit_nll_before:directPlatt.fit_nll_before,
      fit_nll_after:directPlatt.fit_nll_after
    },
    threshold_selection:{
      raw_network_output:scoredBlock(thresholdSelectionRows,rawThresholdProbabilities),
      single_stage_shared_calibration:scoredBlock(
        thresholdSelectionRows,directThresholdProbabilities
      ),
      evaluation_labels_used:true,
      labels_used_for_calibrator_fit:false
    },
    outer_validation:{
      raw_network_output:scoredBlock(validationRows,rawValidationProbabilities),
      single_stage_shared_calibration:scoredBlock(
        validationRows,directValidationProbabilities
      ),
      evaluation_labels_used:true,
      labels_used_for_calibrator_fit:false
    }
  };
  return {
    ...base,status:'AVAILABLE',
    threshold_selection:{
      sample_count:thresholdSelectionRows.length,
      network_output_before_inner_platt:preThreshold,
      inner_platt_output_before_shared_evaluator:
        innerCalibratedThresholdSelection,
      shared_evaluator_output_after_selected_calibration:
        sharedCalibratedThresholdSelection
    },
    outer_validation:{
      sample_count:validationRows.length,
      network_output_before_inner_platt:preValidation,
      inner_platt_output_before_shared_evaluator:innerCalibratedValidation,
      shared_evaluator_output_after_selected_calibration:sharedCalibratedValidation
    },
    single_stage_shared_calibration_counterfactual:directCalibrationCounterfactual,
    chronological_stages:{
      threshold_selection:{
        network_output_before_inner_platt:buildChronologicalStabilityDiagnostics(
          thresholdSelectionRows,rawThresholdProbabilities
        ),
        inner_platt_output_before_shared_evaluator:buildChronologicalStabilityDiagnostics(
          thresholdSelectionRows,innerCalibratedThresholdSelectionProbabilities
        ),
        shared_evaluator_output_after_selected_calibration:buildChronologicalStabilityDiagnostics(
          thresholdSelectionRows,sharedCalibratedThresholdSelectionProbabilities
        ),
        single_stage_shared_calibration_counterfactual:buildChronologicalStabilityDiagnostics(
          thresholdSelectionRows,directThresholdProbabilities
        )
      },
      outer_validation:{
        network_output_before_inner_platt:buildChronologicalStabilityDiagnostics(
          validationRows,rawValidationProbabilities
        ),
        inner_platt_output_before_shared_evaluator:buildChronologicalStabilityDiagnostics(
          validationRows,innerCalibratedValidationProbabilities
        ),
        shared_evaluator_output_after_selected_calibration:buildChronologicalStabilityDiagnostics(
          validationRows,sharedCalibratedValidationProbabilities
        ),
        single_stage_shared_calibration_counterfactual:buildChronologicalStabilityDiagnostics(
          validationRows,directValidationProbabilities
        )
      }
    }
  };
}

function predictionMap(predictions,modelName,requiredIds,{
  sourceCommitSha,targetDefinition,targetSemantics,artifactSha256=null
}={}) {
  if(!Array.isArray(predictions))
    return {valid:false,reason:'MODEL_PREDICTIONS_MISSING',map:new Map()};
  const map=new Map();
  for(const item of predictions){
    const id=String(item?.id||'');
    if(!id||map.has(id)||!finite(item?.probability)||
      Number(item.probability)<0||Number(item.probability)>1)
      return {valid:false,reason:'MODEL_PREDICTION_DUPLICATE_OR_INVALID:'+modelName,map};
    if(String(item?.source_commit_sha||'').toLowerCase()!==String(sourceCommitSha).toLowerCase())
      return {valid:false,reason:'MODEL_PREDICTION_SOURCE_SHA_MISMATCH:'+modelName,map};
    if(item?.target_definition!==targetDefinition)
      return {valid:false,reason:'MODEL_PREDICTION_TARGET_DEFINITION_MISMATCH:'+modelName,map};
    if(item?.target_semantics!==targetSemantics)
      return {valid:false,reason:'MODEL_PREDICTION_TARGET_SEMANTICS_MISMATCH:'+modelName,map};
    if(artifactSha256
      ?String(item?.artifact_sha256||'').toLowerCase()!==artifactSha256
      :(item?.artifact_sha256!==undefined&&item?.artifact_sha256!==null))
      return {valid:false,reason:'MODEL_PREDICTION_ARTIFACT_SHA_MISMATCH:'+modelName,map};
    map.set(id,Number(item.probability));
  }
  const missing=requiredIds.filter(id=>!map.has(id));
  const extra=[...map.keys()].filter(id=>!requiredIds.includes(id));
  if(missing.length||extra.length)
    return {valid:false,reason:'MODEL_PREDICTION_ROW_SET_MISMATCH:'+modelName,
      missing_count:missing.length,extra_count:extra.length,map};
  return {valid:true,map};
}
function probabilitiesFor(rows,map,calibrator=null) {
  return rows.map(row=>{
    const p=map.get(row.id);
    if(!finite(p))throw new Error('MODEL_PROBABILITY_MISSING:'+row.id);
    const rawLogit=logit(p);
    return calibrator?applyProbabilityCalibrator(rawLogit,calibrator):p;
  });
}
export function chooseCalibration(rawMap,fitRows,checkRows,minimumPositives,{
  purgedRows=[],thresholdSelectionRows=[],thresholdPurgedRows=[],calibrationDays=null
}={}){
  const fitLabels=fitRows.map(row=>row.target);
  const fitLogits=probabilitiesFor(fitRows,rawMap).map(logit);
  const checkLabels=checkRows.map(row=>row.target);
  const rawCheck=probabilitiesFor(checkRows,rawMap);
  const rawCheckBrier=brier(rawCheck,checkLabels);

  // Calibration algorithm is predeclared: Platt is fitted only on the
  // calibration-fit block. The check block is a sealed evaluation block and
  // must never be used to choose between RAW / temperature / Platt.
  const temperature={
    method:'TEMPERATURE_SCALING',status:'NOT_FIT_PREDECLARED_PLATT_ONLY',
    fitted:false,accepted:false,fit_partition:'NOT_USED'
  };
  const fittedPlatt=fitPlattScaler(fitLogits,fitLabels,{
    minimumPositives,minimumNegatives:minimumPositives
  });
  const platt={...fittedPlatt,fit_partition:'CALIBRATION_FIT_ONLY'};
  const selectedCalibrator=platt.fitted===true&&platt.accepted===true
    ?platt:null;
  const selectedMethod=selectedCalibrator
    ?'PLATT_SCALING_FIT_ONLY':'RAW_PLATT_NOT_ACCEPTED';
  const selectedCheckProbabilities=probabilitiesFor(
    checkRows,rawMap,selectedCalibrator
  );
  const selectedCheckBrier=brier(selectedCheckProbabilities,checkLabels);
  const supportReady=platt.fitted===true;
  return {
    status:supportReady?'EVALUATED':'INSUFFICIENT_CLASS_SUPPORT',
    selected_method:selectedMethod,
    selection_scope:'PREDECLARED_PLATT_FIT_ON_CALIBRATION_FIT_ONLY',
    selected_calibrator:selectedCalibrator,
    raw_check_brier:rawCheckBrier,
    selected_check_brier:selectedCheckBrier,
    check_block_used_for_calibrator_selection:false,
    improvement:rawCheckBrier!==null&&selectedCheckBrier!==null
      ?rawCheckBrier-selectedCheckBrier:null,
    temperature,platt,
    calibration_fit_support:classCounts(fitLabels),
    calibration_check_support:classCounts(checkLabels),
    minimum_positive_support_per_block:minimumPositives,
    calibration_fit_rows:fitRows.length,
    calibration_purged_rows:purgedRows.length,
    threshold_selection_rows:thresholdSelectionRows.length,
    threshold_purged_rows:thresholdPurgedRows.length,
    calibration_check_rows:checkRows.length,
    calibration_days:calibrationDays,
    support_ready:supportReady
  };
}

/**
 * Gross realized return follows the first-touch execution contract:
 * take-profit/stop-loss exits occur at their recorded barrier prices;
 * only rows that reach the horizon without either barrier use the final close.
 */
export function realizedExecutionGrossReturnPct(row) {
  const firstTouch=row?.first_touch;
  if(row?.execution_return_contract!==NEURAL_CLOSURE_EXECUTION_RETURN_CONTRACT||
    !isValidFourHourFirstTouchExecution(firstTouch,row?.outcome,row?.realized_return_pct))
    return null;
  const baseline=number(firstTouch.baseline_price);
  const exitPrice=number(firstTouch.exit_price);
  return baseline!==null&&baseline>0&&exitPrice!==null
    ?(exitPrice/baseline-1)*100:null;
}

export function realizedExecutionNetReturnPct(row,roundTripCostBps=30) {
  if(!finite(roundTripCostBps)||Number(roundTripCostBps)<0)
    throw new TypeError('NEURAL_CLOSURE_ROUND_TRIP_COST_INVALID');
  const gross=realizedExecutionGrossReturnPct(row);
  return finite(gross)?gross-Number(roundTripCostBps)/100:null;
}

export const NEURAL_CLOSURE_PORTFOLIO_POLICY=Object.freeze({
  method:'EVENT_DRIVEN_FIRST_TOUCH_EXECUTION_MTM_V1',
  max_concurrent_positions:30,
  position_fraction_of_initial_equity:1/30,
  entry_order:'PROBABILITY_DESCENDING_THEN_SYMBOL_ASCENDING',
  exit_time:'FIRST_TOUCH_AT_OR_HORIZON_CLOSE_AT',
  mark_to_market:'OBSERVED_MAX_ADVERSE_AND_FAVORABLE_EXCURSIONS',
  same_timestamp_exit_before_entry:true
});

/**
 * Event-driven long-only Spot portfolio. Each trade uses one fixed equal slot
 * of initial equity; overlapping positions cannot reuse the same capital.
 * MAE/MFE events mark open positions before their actual first-touch exit.
 */
export function simulateFirstTouchPaperPortfolio(rows,probabilities,{
  threshold=0.55,roundTripCostBps=30,maxConcurrentPositions=30,
  initialEquity=100
}={}){
  if(!Array.isArray(rows)||!Array.isArray(probabilities)||rows.length!==probabilities.length)
    throw new TypeError('NEURAL_CLOSURE_PORTFOLIO_ROWS_AND_PROBABILITIES_REQUIRED');
  if(!finite(roundTripCostBps)||Number(roundTripCostBps)<0)
    throw new TypeError('NEURAL_CLOSURE_ROUND_TRIP_COST_INVALID');
  const maxOpen=Math.max(1,Math.min(100,Math.trunc(Number(maxConcurrentPositions)||30)));
  const equityStart=Math.max(1,Number(initialEquity)||100);
  const slotCapital=equityStart/maxOpen;
  const selected=[];
  for(let index=0;index<rows.length;index++){
    const probability=number(probabilities[index]);
    if(probability===null||probability<0||probability>1)
      throw new TypeError('NEURAL_CLOSURE_PORTFOLIO_PROBABILITY_INVALID:'+index);
    if(probability>=threshold)selected.push({row:rows[index],probability,index});
  }
  const invalid=selected.find(item=>{
    const row=item.row;
    const at=number(row?.at);
    const exitAt=number(row?.first_touch?.first_touch_at);
    const gross=realizedExecutionGrossReturnPct(row);
    const mae=number(row?.max_adverse_excursion_pct);
    const maeAt=number(row?.max_adverse_excursion_at);
    const mfe=number(row?.max_favorable_excursion_pct);
    const mfeAt=number(row?.max_favorable_excursion_at);
    return at===null||exitAt===null||exitAt<=at||gross===null||
      mae===null||maeAt===null||maeAt<at||maeAt>exitAt||
      mfe===null||mfeAt===null||mfeAt<at||mfeAt>exitAt;
  });
  if(invalid)return {
    signal_count:selected.length,trade_count:0,threshold,
    win_rate_pct:null,net_pnl_pct:null,max_drawdown_pct:null,
    sharpe_per_trade:null,return_data_status:'NOT_AVAILABLE_OR_INCOMPLETE',
    failure_id:String(invalid.row?.id??invalid.index)
  };
  const events=[];
  for(const item of selected){
    const row=item.row;
    const at=Number(row.at),exitAt=Number(row.first_touch.first_touch_at);
    const netReturn=realizedExecutionNetReturnPct(row,roundTripCostBps);
    if(!finite(netReturn)||netReturn<=-100)
      throw new Error('NEURAL_CLOSURE_RETURN_AT_OR_BELOW_MINUS_100_PERCENT');
    const position={
      id:String(row.id??item.index),
      symbol:String(row.symbol??'').toUpperCase(),
      row,at,exitAt,netReturn,probability:item.probability,
      capital:slotCapital,markPct:0
    };
    const adversePriority=row.outcome==='DOWN'?1:0;
    const favorablePriority=row.outcome==='DOWN'?0:1;
    if(Number(row.max_adverse_excursion_at)<=exitAt)
      events.push({at:Number(row.max_adverse_excursion_at),type:'MAE',
        priority:adversePriority,position,value:Number(row.max_adverse_excursion_pct)});
    if(Number(row.max_favorable_excursion_at)<=exitAt)
      events.push({at:Number(row.max_favorable_excursion_at),type:'MFE',
        priority:favorablePriority,position,value:Number(row.max_favorable_excursion_pct)});
    events.push({at:exitAt,type:'EXIT',priority:2,position});
    events.push({at,type:'ENTRY',priority:3,position});
  }
  events.sort((a,b)=>a.at-b.at||a.priority-b.priority||
    (a.type==='ENTRY'&&b.type==='ENTRY'
      ?b.position.probability-a.position.probability||
        a.position.symbol.localeCompare(b.position.symbol)
      :a.position.id.localeCompare(b.position.id)));
  let cash=equityStart,peakEquity=equityStart,maxDrawdown=0;
  const open=new Map(),openSymbols=new Set(),executedReturns=[],holdingMinutes=[];
  let skippedCapacity=0,skippedSameSymbol=0,skippedInsufficientCash=0;
  let maximumConcurrent=0;
  const markedEquity=()=>cash+[...open.values()].reduce((sum,position)=>
    sum+position.capital*(1+position.markPct/100),0);
  const markDrawdown=()=>{
    const equity=markedEquity();
    peakEquity=Math.max(peakEquity,equity);
    if(peakEquity>0)maxDrawdown=Math.max(maxDrawdown,(peakEquity-equity)/peakEquity*100);
  };
  for(const event of events){
    const position=event.position;
    if(event.type==='ENTRY'){
      if(openSymbols.has(position.symbol)){skippedSameSymbol++;continue;}
      if(open.size>=maxOpen){skippedCapacity++;continue;}
      if(cash+1e-10<slotCapital){skippedInsufficientCash++;continue;}
      cash-=slotCapital;
      open.set(position.id,position);openSymbols.add(position.symbol);
      maximumConcurrent=Math.max(maximumConcurrent,open.size);
      markDrawdown();
      continue;
    }
    if(!open.has(position.id))continue;
    if(event.type==='MAE'){
      position.markPct=Math.min(position.markPct,event.value);
      markDrawdown();
      continue;
    }
    if(event.type==='MFE'){
      position.markPct=Math.max(position.markPct,event.value);
      markDrawdown();
      continue;
    }
    if(event.type==='EXIT'){
      position.markPct=position.netReturn;
      cash+=position.capital*(1+position.netReturn/100);
      open.delete(position.id);openSymbols.delete(position.symbol);
      executedReturns.push(position.netReturn);
      holdingMinutes.push((position.exitAt-position.at)/60_000);
      markDrawdown();
    }
  }
  if(open.size!==0)return {
    signal_count:selected.length,trade_count:executedReturns.length,threshold,
    win_rate_pct:null,net_pnl_pct:null,max_drawdown_pct:maxDrawdown,
    sharpe_per_trade:null,return_data_status:'OPEN_POSITIONS_REMAIN',
    open_positions:open.size
  };
  const wins=executedReturns.filter(value=>value>0).length;
  const mean=executedReturns.length
    ?executedReturns.reduce((sum,value)=>sum+value,0)/executedReturns.length:null;
  const variance=executedReturns.length
    ?executedReturns.reduce((sum,value)=>sum+(value-mean)**2,0)/executedReturns.length:null;
  const sd=variance===null?null:Math.sqrt(variance);
  return {
    signal_count:selected.length,trade_count:executedReturns.length,threshold,
    win_rate_pct:executedReturns.length?100*wins/executedReturns.length:null,
    net_pnl_pct:(cash/equityStart-1)*100,max_drawdown_pct:maxDrawdown,
    sharpe_per_trade:sd>0?mean/sd:null,
    average_net_return_pct:mean,
    average_holding_minutes:holdingMinutes.length
      ?holdingMinutes.reduce((sum,value)=>sum+value,0)/holdingMinutes.length:null,
    max_concurrent_positions:maximumConcurrent,
    skipped_capacity:skippedCapacity,
    skipped_same_symbol:skippedSameSymbol,
    skipped_insufficient_cash:skippedInsufficientCash,
    position_fraction_pct:100/maxOpen,
    return_data_status:'COMPLETE',
    portfolio_simulation:NEURAL_CLOSURE_PORTFOLIO_POLICY
  };
}

function portfolioMetrics(rows,probabilities,threshold,roundTripCostBps) {
  return simulateFirstTouchPaperPortfolio(rows,probabilities,{
    threshold,roundTripCostBps,
    maxConcurrentPositions:NEURAL_CLOSURE_PORTFOLIO_POLICY.max_concurrent_positions,
    initialEquity:100
  });
}

/**
 * Describe temporal stability without fitting or selecting anything.
 * Evaluation rows are split into contiguous, chronological slices. Their
 * labels are used only to score Brier/prevalence; they never fit calibration,
 * choose a threshold, update weights, change gates, or unlock the holdout.
 */
function buildChronologicalStabilityDiagnostics(rows,probabilities,{blockCount=4}={}) {
  if(!Array.isArray(rows)||!Array.isArray(probabilities)||
    rows.length===0||rows.length!==probabilities.length||
    !Number.isInteger(blockCount)||blockCount<1)
    return {
      schema:'RADARX_CHRONOLOGICAL_STABILITY_DIAGNOSTICS_V1',
      status:'UNAVAILABLE',sample_count:Array.isArray(rows)?rows.length:0,
      diagnostic_only:true,reason:'ROWS_OR_PROBABILITIES_INVALID'
    };
  const paired=rows.map((row,index)=>({
    row,probability:Number(probabilities[index])
  })).sort((a,b)=>Number(a.row.at)-Number(b.row.at)||
    String(a.row.id).localeCompare(String(b.row.id)));
  if(paired.some(item=>!Number.isFinite(item.probability)||
    item.probability<0||item.probability>1||
    !finite(item.row?.at)||(item.row?.target!==0&&item.row?.target!==1))){
    return {
      schema:'RADARX_CHRONOLOGICAL_STABILITY_DIAGNOSTICS_V1',
      status:'UNAVAILABLE',sample_count:rows.length,
      diagnostic_only:true,reason:'NON_FINITE_SCORE_OR_INVALID_EVALUATION_ROW'
    };
  }
  // Keep rows sharing one decision timestamp in the same slice. In a
  // multi-symbol cohort many assets can have the same candle-close time.
  const timestampGroups=[];
  for(const item of paired){
    const at=Number(item.row.at);
    const last=timestampGroups.at(-1);
    if(last&&last.at===at)last.items.push(item);
    else timestampGroups.push({at,items:[item]});
  }
  const count=Math.min(blockCount,timestampGroups.length);
  const blocks=[];
  const scoreThresholds=[0.15,0.20,0.25,0.30,0.35];
  let groupCursor=0,consumedRows=0;
  for(let index=0;index<count;index++){
    const remainingBlocks=count-index;
    let groupEnd;
    if(remainingBlocks===1)groupEnd=timestampGroups.length;
    else{
      const target=((index+1)*paired.length)/count;
      const maximumEnd=timestampGroups.length-(remainingBlocks-1);
      groupEnd=groupCursor;
      while(groupEnd<maximumEnd){
        const currentError=Math.abs(consumedRows-target);
        const nextRows=timestampGroups[groupEnd].items.length;
        const nextError=Math.abs(consumedRows+nextRows-target);
        if(groupEnd>groupCursor&&currentError<=nextError)break;
        consumedRows+=nextRows;
        groupEnd++;
        if(consumedRows>=target)break;
      }
      if(groupEnd===groupCursor){
        consumedRows+=timestampGroups[groupEnd].items.length;
        groupEnd++;
      }
    }
    const slice=timestampGroups.slice(groupCursor,groupEnd)
      .flatMap(group=>group.items);
    groupCursor=groupEnd;
    const labels=slice.map(item=>item.row.target);
    const scores=slice.map(item=>item.probability);
    const support=classCounts(labels);
    const prevalence=support.positive/support.total;
    const meanScore=scores.reduce((sum,value)=>sum+value,0)/scores.length;
    const scoreCounts=Object.fromEntries(scoreThresholds.map(threshold=>[
      String(threshold),scores.filter(value=>value>=threshold).length
    ]));
    const localPrevalenceBrier=prevalence*(1-prevalence);
    const blockBrier=brier(scores,labels);
    blocks.push({
      block_index:index+1,
      sample_count:slice.length,
      first_at:Number(slice[0].row.at),
      last_at:Number(slice.at(-1).row.at),
      first_id:String(slice[0].row.id),
      last_id:String(slice.at(-1).row.id),
      positive_count:support.positive,
      negative_count:support.negative,
      positive_rate_pct:Number((100*prevalence).toFixed(6)),
      mean_probability:Number(meanScore.toFixed(8)),
      mean_probability_minus_prevalence:Number((meanScore-prevalence).toFixed(8)),
      brier_score:Number(blockBrier.toFixed(8)),
      constant_prevalence_brier:Number(localPrevalenceBrier.toFixed(8)),
      brier_skill_vs_local_prevalence:Number((localPrevalenceBrier-blockBrier).toFixed(8)),
      scores_at_or_above:scoreCounts
    });
  }
  return {
    schema:'RADARX_CHRONOLOGICAL_STABILITY_DIAGNOSTICS_V1',
    status:'AVAILABLE',
    diagnostic_only:true,
    sample_count:paired.length,
    block_count:blocks.length,
    ordering:'ASCENDING_ROW_AT_CONTIGUOUS_EQUAL_COUNT_SLICES',
    labels_used_for_scoring:true,
    labels_used_for_fit:false,
    labels_used_for_threshold_selection:false,
    affects_primary_probabilities:false,
    affects_threshold_selection:false,
    affects_acceptance_gates:false,
    holdout_values_used:false,
    blocks
  };
}
function selectThreshold(rows,probabilities,roundTripCostBps,{
  minimumTrades=20,minimumWinRatePct=55,maximumDrawdownPct=8,
  referenceOnly=false,thresholdGrid=ENTRY_THRESHOLD_GRID
}={}) {
  if(!Array.isArray(thresholdGrid)||thresholdGrid.length===0||
    thresholdGrid.some(value=>!finite(value)||Number(value)<=0||Number(value)>=1))
    throw new TypeError('NEURAL_CLOSURE_THRESHOLD_GRID_INVALID');
  const trials=thresholdGrid.map(threshold=>portfolioMetrics(rows,probabilities,threshold,roundTripCostBps));
  if(referenceOnly){
    // A comparator does not need to pass promotion gates. Freeze its threshold
    // on this earlier disjoint block using net return after fees, but require
    // complete evidence and the same minimum sample support as the challenger.
    const eligible=trials.filter(item=>item.return_data_status==='COMPLETE'&&
      Number(item.trade_count)>=minimumTrades&&
      finite(item.net_pnl_pct)&&finite(item.max_drawdown_pct)&&
      finite(item.win_rate_pct));
    if(!eligible.length)return {
      threshold:null,status:'ABSTAINED_NO_REFERENCE_THRESHOLD_WITH_MINIMUM_TRADES',
      selected:null,trials,eligible_count:0,
      selection_role:'LOGISTIC_BASELINE_REFERENCE_ONLY',
      selection_objective:'MAX_NET_PNL_AFTER_COST_WITH_MINIMUM_TRADES_ON_EARLIER_DISJOINT_BLOCK',
      minimum_validation_trades:minimumTrades,
      minimum_validation_win_rate_pct:minimumWinRatePct,
      minimum_validation_win_rate_enforced:false,
      require_positive_validation_net_pnl:false,
      maximum_validation_drawdown_pct:maximumDrawdownPct,
      acceptance_qualified:false
    };
    eligible.sort((a,b)=>b.net_pnl_pct-a.net_pnl_pct||
      a.max_drawdown_pct-b.max_drawdown_pct||
      b.win_rate_pct-a.win_rate_pct||b.trade_count-a.trade_count);
    return {
      threshold:eligible[0].threshold,status:'SELECTED_ON_VALIDATION_REFERENCE_ONLY',
      trials,eligible_count:eligible.length,selected:eligible[0],
      selection_role:'LOGISTIC_BASELINE_REFERENCE_ONLY',
      selection_objective:'MAX_NET_PNL_AFTER_COST_WITH_MINIMUM_TRADES_ON_EARLIER_DISJOINT_BLOCK',
      minimum_validation_trades:minimumTrades,
      minimum_validation_win_rate_pct:minimumWinRatePct,
      minimum_validation_win_rate_enforced:false,
      require_positive_validation_net_pnl:false,
      maximum_validation_drawdown_pct:maximumDrawdownPct,
      acceptance_qualified:false
    };
  }
  const ready=trials.filter(item=>item.return_data_status==='COMPLETE'&&
    item.trade_count>=minimumTrades&&
    finite(item.win_rate_pct)&&item.win_rate_pct>=minimumWinRatePct&&
    finite(item.net_pnl_pct)&&item.net_pnl_pct>0&&
    finite(item.max_drawdown_pct)&&item.max_drawdown_pct<=maximumDrawdownPct);
  if(!ready.length)return {
    threshold:null,status:'ABSTAINED_NO_VALIDATION_THRESHOLD_PASSED_RISK_GATES',
    selected:null,trials,eligible_count:0,
    selection_role:'NEURAL_OR_CANDIDATE_QUALIFICATION',
    minimum_validation_trades:minimumTrades,
    minimum_validation_win_rate_pct:minimumWinRatePct,
    minimum_validation_win_rate_enforced:true,
    require_positive_validation_net_pnl:true,
    maximum_validation_drawdown_pct:maximumDrawdownPct,
    acceptance_qualified:false
  };
  ready.sort((a,b)=>b.net_pnl_pct-a.net_pnl_pct||
    a.max_drawdown_pct-b.max_drawdown_pct||b.trade_count-a.trade_count);
  return {
    threshold:ready[0].threshold,status:'SELECTED_ON_VALIDATION_ONLY',
    trials,eligible_count:ready.length,selected:ready[0],
    selection_role:'NEURAL_OR_CANDIDATE_QUALIFICATION',
    minimum_validation_trades:minimumTrades,
    minimum_validation_win_rate_pct:minimumWinRatePct,
    minimum_validation_win_rate_enforced:true,
    require_positive_validation_net_pnl:true,
    maximum_validation_drawdown_pct:maximumDrawdownPct,
    acceptance_qualified:true
  };
}

/**
 * Construct a diagnostic-only top-K signal mask per simultaneous decision
 * timestamp. Selected scores retain their original within-group order; the
 * 0.5/0 encoding only separates selected from non-selected rows for the
 * existing event-driven portfolio simulator.
 */
export function topKProbabilitySignals(rows,probabilities,topK) {
  if(!Array.isArray(rows)||!Array.isArray(probabilities)||
    rows.length!==probabilities.length||!Number.isInteger(topK)||topK<1)
    throw new TypeError('NEURAL_TOP_K_TIMESTAMP_INPUT_INVALID');
  const groups=new Map();
  for(let index=0;index<rows.length;index++){
    const at=number(rows[index]?.at),probability=number(probabilities[index]);
    if(at===null||probability===null||probability<0||probability>1)
      throw new TypeError('NEURAL_TOP_K_TIMESTAMP_SCORE_INVALID:'+index);
    // Match timeGroupedRankingMetrics: timestamps a few milliseconds apart
    // within the same closed 15m candle are one simultaneous decision group.
    const bucket=Math.floor(at/NEURAL_CLOSURE_RANKING_BUCKET_MS);
    const key=String(bucket);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(index);
  }
  const masked=Array(rows.length).fill(0);
  const eligibleGroups=[...groups.values()].filter(indices=>indices.length>=2);
  const singletonBucketCount=groups.size-eligibleGroups.length;
  let signalCount=0;
  for(const indices of eligibleGroups){
    indices.sort((left,right)=>
      Number(probabilities[right])-Number(probabilities[left])||
      String(rows[left]?.symbol??'').localeCompare(String(rows[right]?.symbol??''))||
      String(rows[left]?.id??'').localeCompare(String(rows[right]?.id??'')));
    for(const index of indices.slice(0,topK)){
      masked[index]=0.5+0.5*Number(probabilities[index]);
      signalCount++;
    }
  }
  return {
    probabilities:masked,
    decision_group_count:eligibleGroups.length,
    total_time_buckets:groups.size,
    singleton_buckets_excluded:singletonBucketCount,
    decision_bucket_ms:NEURAL_CLOSURE_RANKING_BUCKET_MS,
    decision_grouping:'FLOOR_UNIX_EPOCH_15M_BUCKET',
    signal_count:signalCount,
    selected_scores_preserve_rank:true,
    tie_break_order:'PROBABILITY_DESCENDING_THEN_SYMBOL_ASCENDING_THEN_ID_ASCENDING'
  };
}



/**
 * Compare a frozen execution-risk score with the frozen Logistic ranker on
 * identical outer-validation opportunities. Lambda is read-only here.
 */
export function evaluateExternalExecutionRiskTopK(rows,riskAdjustedScores,logisticProbabilities,{
  riskPenaltyWeights,topKGrid=[1,2,3],roundTripCostBps=30
}={}){
  if(!Array.isArray(rows)||!rows.length||
    !Array.isArray(riskAdjustedScores)||riskAdjustedScores.length!==rows.length||
    !Array.isArray(logisticProbabilities)||logisticProbabilities.length!==rows.length||
    !Array.isArray(riskPenaltyWeights)||riskPenaltyWeights.length!==rows.length||
    !Array.isArray(topKGrid)||!topKGrid.length||
    topKGrid.some(k=>!Number.isInteger(k)||k<1||k>100)||
    !finite(roundTripCostBps)||Number(roundTripCostBps)<0||Number(roundTripCostBps)>300)
    throw new TypeError('EXTERNAL_EXECUTION_RISK_TOP_K_INPUT_INVALID');
  if(rows.some((row,index)=>!row?.id||!row?.symbol||!finite(row?.at)||
    !finite(riskAdjustedScores[index])||
    !finite(logisticProbabilities[index])||Number(logisticProbabilities[index])<0||
    Number(logisticProbabilities[index])>1||
    !finite(riskPenaltyWeights[index])||Number(riskPenaltyWeights[index])<0))
    throw new TypeError('EXTERNAL_EXECUTION_RISK_TOP_K_ROW_INVALID');
  const lambdas=[...new Set(riskPenaltyWeights.map(Number))];
  if(lambdas.length!==1)
    throw new TypeError('EXTERNAL_EXECUTION_RISK_LAMBDA_NOT_FROZEN');
  if(new Set(rows.map(row=>String(row.id))).size!==rows.length)
    throw new TypeError('EXTERNAL_EXECUTION_RISK_TOP_K_DUPLICATE_ROW_ID');
  const trials=topKGrid.map(topK=>{
    const neuralMask=topKRankingSignals(rows,riskAdjustedScores,topK);
    const logisticMask=topKRankingSignals(rows,logisticProbabilities,topK);
    const options={threshold:0.5,roundTripCostBps:Number(roundTripCostBps),
      maxConcurrentPositions:NEURAL_CLOSURE_PORTFOLIO_POLICY.max_concurrent_positions,
      initialEquity:100};
    const neural=simulateFirstTouchPaperPortfolio(rows,neuralMask.probabilities,options);
    const logistic=simulateFirstTouchPaperPortfolio(rows,logisticMask.probabilities,options);
    const delta=(a,b,key)=>finite(a?.[key])&&finite(b?.[key])
      ?Number((Number(a[key])-Number(b[key])).toFixed(6)):null;
    return {
      top_k_per_timestamp:topK,
      decision_group_count:neuralMask.decision_group_count,
      logistic_decision_group_count:logisticMask.decision_group_count,
      neural_selected_count:neuralMask.signal_count,
      logistic_selected_count:logisticMask.signal_count,
      neural_metrics:neural,logistic_metrics:logistic,
      neural_minus_logistic:{
        executed_trade_count:delta(neural,logistic,'trade_count'),
        win_rate_percentage_points:delta(neural,logistic,'win_rate_pct'),
        net_pnl_percentage_points:delta(neural,logistic,'net_pnl_pct'),
        max_drawdown_percentage_points:delta(neural,logistic,'max_drawdown_pct')
      }
    };
  });
  return {
    schema:'RADARX_TCN_LSTM_FROZEN_EXECUTION_RISK_EXTERNAL_VALIDATION_TOP_K_V1',
    status:'AVAILABLE',evaluation_partition:'OUTER_VALIDATION_ONLY',
    score_source:'PREDICTED_NET_RETURN_MINUS_FROZEN_LAMBDA_TIMES_PREDICTED_DOWNSIDE_RISK',
    risk_penalty_weight:lambdas[0],
    baseline:'LOGISTIC_REGRESSION_SAME_TRAINING_PARTITION',
    ranking:'TOP_K_PER_IDENTICAL_CLOSED_15M_DECISION_TIMESTAMP',
    top_k_grid:[...topKGrid],opportunity_rows:rows.length,
    round_trip_cost_bps:Number(roundTripCostBps),
    portfolio_policy:NEURAL_CLOSURE_PORTFOLIO_POLICY,
    lambda_refitted_on_outer_validation:false,
    outer_validation_used_for_model_fit_or_selection:false,
    holdout_rows_or_scores_used:false,
    thresholds_or_lambda_tuned_on_outer_validation:false,
    trials
  };
}

/**
 * Moving-block bootstrap for outer-validation probability and frozen execution
 * policies. Blocks are contiguous UTC-day clusters (longer than the 4h label
 * horizon); one empty UTC day is inserted between sampled blocks so events
 * from separate resampled blocks cannot overlap. All candidate/baseline
 * policies share the exact same sampled blocks.
 *
 * This is uncertainty estimation only: no parameter, threshold, Top-K or
 * execution lambda is fitted or selected by this function.
 */
export function bootstrapOuterValidationUncertainty(rows,probabilitiesByModel,{
  executionScoresByPolicy={},
  topKGrid=[1,2,3],
  roundTripCostBps=30,
  repetitions=250,
  blockLengthDays=3,
  seed=22429,
  maxConcurrentPositions=NEURAL_CLOSURE_PORTFOLIO_POLICY.max_concurrent_positions
}={}) {
  const unavailable=(reason,extra={})=>({
    schema:'RADARX_OUTER_VALIDATION_MOVING_BLOCK_BOOTSTRAP_V1',
    status:'UNAVAILABLE',diagnostic_only:true,reason,
    evaluation_partition:'OUTER_VALIDATION_ONLY',
    holdout_rows_or_scores_used:false,
    affects_model_fit:false,affects_threshold_selection:false,
    affects_top_k_selection:false,affects_lambda_selection:false,
    affects_acceptance_gates:false,...extra
  });
  if(!Array.isArray(rows)||rows.length===0||
    !probabilitiesByModel||typeof probabilitiesByModel!=='object'||
    !Array.isArray(probabilitiesByModel.LOGISTIC_REGRESSION)||
    probabilitiesByModel.LOGISTIC_REGRESSION.length!==rows.length||
    !executionScoresByPolicy||typeof executionScoresByPolicy!=='object'||
    !Array.isArray(topKGrid)||!topKGrid.length||
    topKGrid.some(k=>!Number.isInteger(k)||k<1||k>100)||
    !Number.isInteger(repetitions)||repetitions<100||repetitions>5000||
    !Number.isInteger(blockLengthDays)||blockLengthDays<1||blockLengthDays>10||
    !Number.isInteger(seed)||seed<1||
    !finite(roundTripCostBps)||Number(roundTripCostBps)<0||
    !Number.isInteger(maxConcurrentPositions)||maxConcurrentPositions<1)
    return unavailable('BOOTSTRAP_CONFIGURATION_OR_INPUT_INVALID');

  const rowIds=new Set();
  for(let i=0;i<rows.length;i++){
    const row=rows[i];
    if(!row?.id||rowIds.has(String(row.id))||!finite(row.at)||
      (row.target!==0&&row.target!==1)||
      !finite(probabilitiesByModel.LOGISTIC_REGRESSION[i])||
      Number(probabilitiesByModel.LOGISTIC_REGRESSION[i])<0||
      Number(probabilitiesByModel.LOGISTIC_REGRESSION[i])>1)
      return unavailable('BOOTSTRAP_BASELINE_OR_ROW_ALIGNMENT_INVALID',{invalid_row_index:i});
    rowIds.add(String(row.id));
  }
  const modelNames=Object.keys(probabilitiesByModel);
  for(const name of modelNames){
    const values=probabilitiesByModel[name];
    if(!Array.isArray(values)||values.length!==rows.length||
      values.some(value=>!finite(value)||Number(value)<0||Number(value)>1))
      return unavailable('BOOTSTRAP_MODEL_PROBABILITY_ALIGNMENT_INVALID',{model:name});
  }
  const policyNames=Object.keys(executionScoresByPolicy);
  if(!policyNames.length)return unavailable('BOOTSTRAP_EXECUTION_POLICIES_EMPTY');
  for(const name of policyNames){
    const values=executionScoresByPolicy[name];
    if(!Array.isArray(values)||values.length!==rows.length||
      values.some(value=>!finite(value)))
      return unavailable('BOOTSTRAP_EXECUTION_SCORE_ALIGNMENT_INVALID',{policy:name});
  }

  const dayMap=new Map();
  for(let index=0;index<rows.length;index++){
    const day=Math.floor(Number(rows[index].at)/86_400_000)*86_400_000;
    if(!dayMap.has(day))dayMap.set(day,[]);
    dayMap.get(day).push(index);
  }
  const days=[...dayMap.keys()].sort((a,b)=>a-b);
  if(days.length<blockLengthDays*4)
    return unavailable('BOOTSTRAP_TOO_FEW_INDEPENDENT_TIME_BLOCKS',{
      utc_day_count:days.length,block_length_days:blockLengthDays,
      minimum_required_days:blockLengthDays*4
    });
  if(rows.some((row,index)=>index>0&&Number(row.at)<Number(rows[index-1].at)))
    return unavailable('BOOTSTRAP_ROWS_MUST_BE_CHRONOLOGICALLY_ORDERED');

  for(const [name,values] of Object.entries(probabilitiesByModel)){
    if(name==='LOGISTIC_REGRESSION')continue;
    if(values.some((value,index)=>!finite(value)||Number(value)<0||Number(value)>1))
      return unavailable('BOOTSTRAP_MODEL_PROBABILITY_INVALID',{model:name});
  }

  const selectedMasks={};
  try{
    for(const topK of topKGrid){
      for(const [policyName,scores] of Object.entries(executionScoresByPolicy)){
        selectedMasks[policyName+'|'+topK]=topKRankingSignals(rows,scores,topK).probabilities;
      }
    }
  }catch(error){
    return unavailable('BOOTSTRAP_TOP_K_POLICY_PREPARATION_FAILED',{
      detail:String(error?.message||error)
    });
  }

  let randomState=(seed>>>0)||0x9e3779b9;
  const random=()=>{
    randomState^=randomState<<13;
    randomState^=randomState>>>17;
    randomState^=randomState<<5;
    return (randomState>>>0)/4294967296;
  };
  const quantile=(values,p)=>{
    if(!values.length)return null;
    const sorted=[...values].sort((a,b)=>a-b);
    const position=(sorted.length-1)*p;
    const lower=Math.floor(position),upper=Math.ceil(position);
    if(lower===upper)return sorted[lower];
    return sorted[lower]+(sorted[upper]-sorted[lower])*(position-lower);
  };
  const summarize=values=>{
    const usable=values.filter(finite).map(Number);
    if(usable.length<Math.ceil(repetitions*0.95))return {
      status:'UNAVAILABLE',valid_repetitions:usable.length,
      requested_repetitions:repetitions,lower_95:null,upper_95:null
    };
    return {
      status:'AVAILABLE',valid_repetitions:usable.length,
      requested_repetitions:repetitions,
      mean:Number((usable.reduce((sum,value)=>sum+value,0)/usable.length).toFixed(8)),
      median:Number(quantile(usable,0.5).toFixed(8)),
      lower_95:Number(quantile(usable,0.025).toFixed(8)),
      upper_95:Number(quantile(usable,0.975).toFixed(8)),
      probability_above_zero:Number((usable.filter(value=>value>0).length/usable.length).toFixed(6))
    };
  };
  const modelNamesForBootstrap=modelNames.filter(name=>name!=='LOGISTIC_REGRESSION');
  const brierSamples=Object.fromEntries(modelNamesForBootstrap.map(name=>[name,[]]));
  const logLossSamples=Object.fromEntries(modelNamesForBootstrap.map(name=>[name,[]]));
  const metricNames=['trade_count','win_rate_pct','net_pnl_pct',
    'average_net_return_pct','median_net_return_pct','max_drawdown_pct'];
  const strategySamples=Object.fromEntries(topKGrid.map(k=>[String(k),
    Object.fromEntries(policyNames.map(name=>[name,
      Object.fromEntries(metricNames.map(metric=>[metric,[]]))
    ]))
  ]));
  const pairNames=[];
  for(let i=0;i<policyNames.length;i++)
    for(let j=i+1;j<policyNames.length;j++)
      pairNames.push([policyNames[i],policyNames[j]]);
  const pairedSamples=Object.fromEntries(topKGrid.map(k=>[String(k),
    Object.fromEntries(pairNames.map(([left,right])=>[
      left+'_MINUS_'+right,
      Object.fromEntries(metricNames.map(metric=>[metric,[]]))
    ]))
  ]));
  const baseline=probabilitiesByModel.LOGISTIC_REGRESSION;
  const firstDay=days[0];
  const blockStarts=days.slice(0,days.length-blockLengthDays+1);
  const dayRows=days.map(day=>dayMap.get(day));
  let completed=0;
  try{
    for(let repetition=0;repetition<repetitions;repetition++){
      const sampledDayIndices=[];
      while(sampledDayIndices.length<days.length){
        const startIndex=Math.floor(random()*blockStarts.length);
        for(let offset=0;offset<blockLengthDays&&sampledDayIndices.length<days.length;offset++)
          sampledDayIndices.push(startIndex+offset);
      }
      const sampledRows=[];
      const sampledProbabilityByModel=Object.fromEntries(modelNames.map(name=>[name,[]]));
      const sampledPolicyMasks=Object.fromEntries(
        Object.entries(selectedMasks).map(([key])=>[key,[]])
      );
      let targetDayCursor=0;
      for(let blockStart=0;blockStart<sampledDayIndices.length;blockStart+=blockLengthDays){
        const blockEnd=Math.min(sampledDayIndices.length,blockStart+blockLengthDays);
        for(let sampleDay=blockStart;sampleDay<blockEnd;sampleDay++){
          const sourceDay=days[sampledDayIndices[sampleDay]];
          const targetDay=firstDay+targetDayCursor*86_400_000;
          const shift=targetDay-sourceDay;
          const indices=dayRows[sampledDayIndices[sampleDay]];
          for(const sourceIndex of indices){
            const row=rows[sourceIndex];
            const firstTouch=row.first_touch?{
              ...row.first_touch,
              first_touch_at:Number(row.first_touch.first_touch_at)+shift,
              ...(row.first_touch.exit_candle?{exit_candle:{
                ...row.first_touch.exit_candle,
                open_time:Number(row.first_touch.exit_candle.open_time)+shift,
                close_time:Number(row.first_touch.exit_candle.close_time)+shift
              }}:{})
            }:row.first_touch;
            const sampledRow={
              ...row,id:String(row.id)+'#BOOT'+repetition+'_'+sampleDay,
              at:Number(row.at)+shift,
              resolved_at:Number(row.resolved_at)+shift,
              first_touch,
              max_adverse_excursion_at:Number(row.max_adverse_excursion_at)+shift,
              max_favorable_excursion_at:Number(row.max_favorable_excursion_at)+shift
            };
            sampledRows.push(sampledRow);
            for(const name of modelNames)
              sampledProbabilityByModel[name].push(Number(probabilitiesByModel[name][sourceIndex]));
            for(const [key,mask] of Object.entries(selectedMasks))
              sampledPolicyMasks[key].push(Number(mask[sourceIndex]));
          }
          targetDayCursor++;
        }
        // Prevent a first-touch event from one sampled block from interacting
        // with a position opened in the next independently sampled block.
        if(blockEnd<sampledDayIndices.length)targetDayCursor++;
      }
      const labels=sampledRows.map(row=>row.target);
      for(const name of modelNamesForBootstrap){
        const candidate=sampledProbabilityByModel[name];
        let brierDelta=0,logLossDelta=0;
        for(let i=0;i<labels.length;i++){
          const p=clamp(Number(candidate[i]),1e-12,1-1e-12);
          const q=clamp(Number(sampledProbabilityByModel.LOGISTIC_REGRESSION[i]),1e-12,1-1e-12);
          const y=labels[i];
          brierDelta+=(p-y)**2-(q-y)**2;
          logLossDelta+=-(y*Math.log(p)+(1-y)*Math.log(1-p))+
            (y*Math.log(q)+(1-y)*Math.log(q===1?1:1-q));
        }
        brierSamples[name].push(brierDelta/labels.length);
        logLossSamples[name].push(logLossDelta/labels.length);
      }
      const strategyMetrics={};
      for(const topK of topKGrid){
        for(const policyName of policyNames){
          const simulated=simulateFirstTouchPaperPortfolio(
            sampledRows,sampledPolicyMasks[policyName+'|'+topK],{
              threshold:0.5,roundTripCostBps:Number(roundTripCostBps),
              maxConcurrentPositions,initialEquity:100
            });
          strategyMetrics[policyName]=strategyMetrics[policyName]??{};
          strategyMetrics[policyName][topK]=simulated;
          for(const metric of metricNames)
            strategySamples[String(topK)][policyName][metric].push(
              finite(simulated?.[metric])?Number(simulated[metric]):null
            );
        }
        for(const [left,right] of pairNames){
          const a=strategyMetrics[left]?.[topK]??simulateFirstTouchPaperPortfolio(
            sampledRows,sampledPolicyMasks[left+'|'+topK],{
              threshold:0.5,roundTripCostBps:Number(roundTripCostBps),
              maxConcurrentPositions,initialEquity:100
            });
          const b=strategyMetrics[right]?.[topK]??simulateFirstTouchPaperPortfolio(
            sampledRows,sampledPolicyMasks[right+'|'+topK],{
              threshold:0.5,roundTripCostBps:Number(roundTripCostBps),
              maxConcurrentPositions,initialEquity:100
            });
          for(const metric of metricNames){
            const delta=finite(a?.[metric])&&finite(b?.[metric])
              ?Number(a[metric])-Number(b[metric]):null;
            pairedSamples[String(topK)][left+'_MINUS_'+right][metric].push(delta);
          }
        }
      }
      completed++;
    }
  }catch(error){
    return unavailable('BOOTSTRAP_SIMULATION_FAILED',{
      completed_repetitions:completed,
      detail:String(error?.message||error)
    });
  }

  const brierComparisons=Object.fromEntries(modelNamesForBootstrap.map(name=>[
    name,{
      candidate_minus_logistic_raw_brier:summarize(brierSamples[name]),
      candidate_minus_logistic_raw_log_loss:summarize(logLossSamples[name]),
      interpretation:'NEGATIVE_VALUES_FAVOR_CANDIDATE',
      paired_same_sampled_time_blocks:true
    }
  ]));
  const executionPolicies=Object.fromEntries(topKGrid.map(k=>[String(k),
    Object.fromEntries(policyNames.map(name=>[name,
      Object.fromEntries(metricNames.map(metric=>[
        metric,summarize(strategySamples[String(k)][name][metric])
      ]))
    ]))
  ]));
  const pairedExecution=Object.fromEntries(topKGrid.map(k=>[String(k),
    Object.fromEntries(pairNames.map(([left,right])=>[
      left+'_MINUS_'+right,
      Object.fromEntries(metricNames.map(metric=>[
        metric,summarize(pairedSamples[String(k)][left+'_MINUS_'+right][metric])
      ]))
    ]))
  ]));
  return {
    schema:'RADARX_OUTER_VALIDATION_MOVING_BLOCK_BOOTSTRAP_V1',
    status:'AVAILABLE',diagnostic_only:true,
    evaluation_partition:'OUTER_VALIDATION_ONLY',
    sampling:{
      method:'MOVING_BLOCK_BOOTSTRAP_WITHOUT_REPLACEMENT_WITHIN_BLOCKS',
      resampling:'CONTIGUOUS_UTC_DAY_BLOCKS_SAMPLED_WITH_REPLACEMENT',
      block_length_days:blockLengthDays,
      utc_day_count:days.length,
      minimum_independent_blocks:Math.floor(days.length/blockLengthDays),
      blocks_sampled_per_repetition:Math.ceil(days.length/blockLengthDays),
      inter_block_gap_ms:86_400_000,
      repetitions:completed,seed,
      pairing:'SAME_RESAMPLED_DAY_BLOCKS_FOR_ALL_MODELS_AND_POLICIES',
      market_dependence_preserved_within_blocks:true,
      four_hour_event_overlap_between_resampled_blocks:false
    },
    probability_quality:{
      baseline:'LOGISTIC_REGRESSION',
      metric_source:'NATIVE_MODEL_PREDICTIONS_NO_OUTER_CALIBRATION',
      comparisons:brierComparisons
    },
    execution:{
      policy_score_source:'FROZEN_OUTER_VALIDATION_RANK_SCORES',
      top_k_grid:[...topKGrid],
      round_trip_cost_bps:Number(roundTripCostBps),
      max_concurrent_positions:maxConcurrentPositions,
      strategy_confidence_intervals:executionPolicies,
      paired_strategy_differences:pairedExecution
    },
    isolation:{
      parameters_refitted:false,thresholds_selected:false,top_k_selected:false,
      lambda_refitted:false,calibration_selected:false,
      holdout_rows_or_scores_used:false,affects_acceptance_gates:false
    },
    summary:{
      model_probability_comparisons:Object.keys(brierComparisons).length,
      execution_policies:policyNames,
      top_k_values:[...topKGrid]
    }
  };
}
\n/** Rank raw auxiliary logits within each simultaneous closed 15m bucket. */
export function topKRankingSignals(rows,scores,topK) {
  if(!Array.isArray(rows)||!Array.isArray(scores)||rows.length!==scores.length||
    !Number.isInteger(topK)||topK<1)
    throw new TypeError('NEURAL_TOP_K_RANKING_INPUT_INVALID');
  const groups=new Map();
  for(let i=0;i<rows.length;i++){
    const at=number(rows[i]?.at),score=number(scores[i]);
    if(at===null||score===null)throw new TypeError('NEURAL_TOP_K_RANKING_SCORE_INVALID:'+i);
    const key=String(Math.floor(at/NEURAL_CLOSURE_RANKING_BUCKET_MS));
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(i);
  }
  const masked=Array(rows.length).fill(0);
  const eligible=[...groups.values()].filter(indices=>indices.length>=2);
  let signalCount=0;
  for(const indices of eligible){
    indices.sort((a,b)=>Number(scores[b])-Number(scores[a])||
      String(rows[a]?.symbol??'').localeCompare(String(rows[b]?.symbol??''))||
      String(rows[a]?.id??'').localeCompare(String(rows[b]?.id??'')));
    const selected=indices.slice(0,topK);
    for(let rank=0;rank<selected.length;rank++){
      masked[selected[rank]]=0.5+0.5*((indices.length-rank)/(indices.length+1));
      signalCount++;
    }
  }
  return {
    probabilities:masked,decision_group_count:eligible.length,total_time_buckets:groups.size,
    singleton_buckets_excluded:groups.size-eligible.length,
    decision_bucket_ms:NEURAL_CLOSURE_RANKING_BUCKET_MS,
    decision_grouping:'FLOOR_UNIX_EPOCH_15M_BUCKET',signal_count:signalCount,
    selected_scores_preserve_rank:true,score_source:'RAW_AUXILIARY_RANKING_LOGIT'
  };
}


/** Accept ranking logits for the exact validation set; reject every holdout score. */
function collectTcnLstmValidationScoreMap(predictions,validationRows,holdoutRows,key) {
  if(!Array.isArray(predictions))
    return {status:'UNAVAILABLE',reason:'PREDICTIONS_NOT_ARRAY',map:new Map()};
  const staged=predictions.filter(item=>Object.prototype.hasOwnProperty.call(item??{},key));
  if(!staged.length)
    return {status:'NOT_PROVIDED',reason:key.toUpperCase()+'_MISSING',map:new Map()};
  const holdoutIds=new Set(holdoutRows.map(row=>String(row.id)));
  if(staged.some(item=>holdoutIds.has(String(item?.id??''))))
    return {status:'REJECTED_HOLDOUT_SCORE_EXPOSURE',
      reason:'TCN_LSTM_RANKING_DIAGNOSTICS_MUST_NOT_INCLUDE_FINAL_HOLDOUT:'+key,
      map:new Map()};
  const expected=new Set(validationRows.map(row=>String(row.id)));
  const map=new Map();
  for(const item of staged){
    const id=String(item?.id??''),value=item?.[key];
    if(!id||!expected.has(id)||map.has(id))
      return {status:'REJECTED_INVALID_SCORE_ROW_SET',
        reason:'TCN_LSTM_RANKING_SCORE_ID_INVALID_DUPLICATE_OR_OUT_OF_SCOPE:'+key,
        map:new Map()};
    if(typeof value!=='number'||!Number.isFinite(value))
      return {status:'REJECTED_INVALID_RANKING_SCORE',
        reason:'TCN_LSTM_RANKING_SCORE_NON_FINITE:'+key,map:new Map()};
    map.set(id,value);
  }
  if(map.size!==expected.size||[...expected].some(id=>!map.has(id)))
    return {status:'REJECTED_INCOMPLETE_VALIDATION_COVERAGE',
      reason:'TCN_LSTM_RANKING_SCORE_MUST_COVER_EVERY_VALIDATION_ROW:'+key,
      map:new Map()};
  return {status:'AVAILABLE',reason:null,map};
}
function collectTcnLstmAuxiliaryRankingMap(predictions,validationRows,holdoutRows) {
  return collectTcnLstmValidationScoreMap(
    predictions,validationRows,holdoutRows,'auxiliary_ranking_logit'
  );
}
function collectTcnLstmRankingAnchorMap(predictions,validationRows,holdoutRows) {
  return collectTcnLstmValidationScoreMap(
    predictions,validationRows,holdoutRows,'auxiliary_ranking_anchor_logit'
  );
}

/** Diagnostic only: tune K on the disjoint selection rows, then freeze it on outer validation. */
export function compareTcnLstmRankingExecutionMetrics(rankingHeadMetrics,logisticAnchorMetrics) {
  const delta=key=>finite(rankingHeadMetrics?.[key])&&finite(logisticAnchorMetrics?.[key])
    ?Number((Number(rankingHeadMetrics[key])-Number(logisticAnchorMetrics[key])).toFixed(6))
    :null;
  return {
    comparison_baseline:'SAME_FROZEN_TCN_LSTM_LOGISTIC_ANCHOR',
    head_minus_anchor:{
      trade_count:delta('trade_count'),
      win_rate_percentage_points:delta('win_rate_pct'),
      net_pnl_percentage_points:delta('net_pnl_pct'),
      max_drawdown_percentage_points:delta('max_drawdown_pct'),
      average_net_return_percentage_points:delta('average_net_return_pct'),
      sharpe_per_trade:delta('sharpe_per_trade')
    }
  };
}

/** Diagnostic only: tune K on disjoint selection rows; evaluate the frozen anchor beside the head. */
function evaluateAuxiliaryRankingHeadTopKPolicy(selectionRows,outerRows,scoreMap,
  anchorScoreMap,roundTripCostBps,{
    minimumTrades=20,minimumWinRatePct=55,maximumDrawdownPct=8
  }={}) {
  const unavailable=(reason)=>({
    schema:'RADARX_TCN_LSTM_AUXILIARY_RANK_HEAD_TOP_K_POLICY_V1',
    status:'UNAVAILABLE',diagnostic_only:true,affects_primary_probabilities:false,
    affects_primary_threshold:false,affects_acceptance_gates:false,
    holdout_values_used:false,reason
  });
  if(!(scoreMap instanceof Map))return unavailable('AUXILIARY_RANKING_SCORE_MAP_MISSING');
  if(!(anchorScoreMap instanceof Map))return unavailable('AUXILIARY_RANKING_ANCHOR_SCORE_MAP_MISSING');
  const selectionScores=selectionRows.map(row=>scoreMap.get(String(row.id)));
  const outerScores=outerRows.map(row=>scoreMap.get(String(row.id)));
  const selectionAnchorScores=selectionRows.map(row=>anchorScoreMap.get(String(row.id)));
  const outerAnchorScores=outerRows.map(row=>anchorScoreMap.get(String(row.id)));
  if([...selectionScores,...outerScores,...selectionAnchorScores,...outerAnchorScores]
    .some(v=>typeof v!=='number'||!Number.isFinite(v)))
    return unavailable('AUXILIARY_RANKING_OR_ANCHOR_SCORE_COVERAGE_INCOMPLETE');
  const gatesFor=metrics=>({
    return_data_complete:metrics?.return_data_status==='COMPLETE',
    minimum_trades:Number(metrics?.trade_count)>=minimumTrades,
    minimum_win_rate:finite(metrics?.win_rate_pct)&&metrics.win_rate_pct>=minimumWinRatePct,
    positive_net_pnl:finite(metrics?.net_pnl_pct)&&metrics.net_pnl_pct>0,
    maximum_drawdown:finite(metrics?.max_drawdown_pct)&&metrics.max_drawdown_pct<=maximumDrawdownPct
  });
  const compare=(head,anchor)=>({
    logistic_anchor_metrics:anchor,
    ...compareTcnLstmRankingExecutionMetrics(head,anchor)
  });
  const evaluateGrid=(rows,headScores,anchorScores)=>[1,2,3].map(topK=>{
    const headMask=topKRankingSignals(rows,headScores,topK);
    const anchorMask=topKRankingSignals(rows,anchorScores,topK);
    const metrics=portfolioMetrics(rows,headMask.probabilities,0.5,roundTripCostBps);
    const anchorMetrics=portfolioMetrics(rows,anchorMask.probabilities,0.5,roundTripCostBps);
    return {
      top_k_per_timestamp:topK,
      decision_group_count:headMask.decision_group_count,
      signal_count:headMask.signal_count,
      metrics,
      ...compare(metrics,anchorMetrics)
    };
  });
  const trials=evaluateGrid(selectionRows,selectionScores,selectionAnchorScores).map(row=>{
    const gates=gatesFor(row.metrics);
    return {
      top_k_per_timestamp:row.top_k_per_timestamp,
      decision_group_count:row.decision_group_count,
      signal_count:row.signal_count,
      metrics:row.metrics,
      logistic_anchor_metrics:row.logistic_anchor_metrics,
      comparison_baseline:row.comparison_baseline,
      head_minus_anchor:row.head_minus_anchor,
      risk_gates:Object.fromEntries(Object.entries(gates).map(([k,v])=>[k,v?'PASS':'FAIL'])),
      qualified:Object.values(gates).every(Boolean)
    };
  });
  const eligible=trials.filter(t=>t.qualified).sort((a,b)=>
    Number(b.metrics.net_pnl_pct)-Number(a.metrics.net_pnl_pct)||
    Number(a.metrics.max_drawdown_pct)-Number(b.metrics.max_drawdown_pct)||
    Number(b.metrics.trade_count)-Number(a.metrics.trade_count));
  const selected=eligible[0]??null;
  // This predeclared grid is a report-only comparison. Outer-validation outcomes
  // cannot choose K, change gates, or unlock the final holdout.
  const outerDiagnosticGrid=evaluateGrid(outerRows,outerScores,outerAnchorScores);
  const outerMask=selected
    ?topKRankingSignals(outerRows,outerScores,selected.top_k_per_timestamp):null;
  const outerAnchorMask=selected
    ?topKRankingSignals(outerRows,outerAnchorScores,selected.top_k_per_timestamp):null;
  const outerMetrics=outerMask
    ?portfolioMetrics(outerRows,outerMask.probabilities,0.5,roundTripCostBps):null;
  const outerAnchorMetrics=outerAnchorMask
    ?portfolioMetrics(outerRows,outerAnchorMask.probabilities,0.5,roundTripCostBps):null;
  const outerGates=outerMetrics?gatesFor(outerMetrics):{
    return_data_complete:false,minimum_trades:false,minimum_win_rate:false,
    positive_net_pnl:false,maximum_drawdown:false
  };
  return {
    schema:'RADARX_TCN_LSTM_AUXILIARY_RANK_HEAD_TOP_K_POLICY_V1',
    status:'EVALUATED',diagnostic_only:true,
    policy:'TOP_K_PER_15M_DECISION_BUCKET_BY_AUXILIARY_RANKING_LOGIT',
    score_source:'TRAINING_ONLY_AUXILIARY_RANKING_HEAD_RAW_LOGIT',
    baseline_score_source:'SAME_FROZEN_TCN_LSTM_LOGISTIC_ANCHOR_LOGIT',
    top_k_grid:[1,2,3],minimum_trades:minimumTrades,
    minimum_win_rate_pct:minimumWinRatePct,require_positive_net_pnl:true,
    maximum_drawdown_pct:maximumDrawdownPct,
    affects_primary_probabilities:false,affects_primary_threshold:false,
    affects_acceptance_gates:false,holdout_values_used:false,
    selection:{
      status:selected?'SELECTED_ON_DISJOINT_SELECTION_ONLY':'ABSTAINED_NO_TOP_K_PASSED_RISK_GATES',
      sample_count:selectionRows.length,
      trials,
      selected_top_k_per_timestamp:selected?.top_k_per_timestamp??null,
      selected_metrics:selected?.metrics??null,
      selected_logistic_anchor_metrics:selected?.logistic_anchor_metrics??null,
      selected_head_minus_anchor:selected?.head_minus_anchor??null,
      labels_used_for_k_selection:true
    },
    outer_validation:{
      sample_count:outerRows.length,
      diagnostic_grid_only:true,
      diagnostic_grid:outerDiagnosticGrid,
      decision_group_count:outerMask?.decision_group_count??0,
      signal_count:outerMask?.signal_count??0,
      frozen_top_k_per_timestamp:selected?.top_k_per_timestamp??null,
      metrics:outerMetrics,
      logistic_anchor_metrics:outerAnchorMetrics,
      ...(outerMetrics?compareTcnLstmRankingExecutionMetrics(outerMetrics,outerAnchorMetrics):{}),
      risk_gates:Object.fromEntries(Object.entries(outerGates).map(([k,v])=>[k,v?'PASS':'FAIL'])),
      risk_gates_passed:Object.values(outerGates).every(Boolean),
      labels_used_for_k_selection:false,
      return_data_status:outerMetrics?.return_data_status??'NOT_EVALUATED'
    }
  };
}

function holdoutMetrics(rows,probabilities,threshold,roundTripCostBps,weights) {
  const labels=rows.map(row=>row.target);
  const counts=classCounts(labels);
  return {
    sample_count:rows.length,
    positive_count:counts.positive,negative_count:counts.negative,
    brier_score:brier(probabilities,labels),
    focal_asymmetric_brier:focalMean(probabilities,labels,weights),
    ...portfolioMetrics(rows,probabilities,threshold,roundTripCostBps)
  };
}

/**
 * Diagnostic-only alternative allocation of the existing outer-validation
 * partition. It trades some calibration-fit days for larger disjoint threshold
 * selection and later outer-check blocks. The original 50% fit allocation
 * remains the primary acceptance path and is never overwritten.
 */
function buildExpandedThresholdWindowCounterfactual(rows,rawMap,roundTripCostBps,{
  minimumClassSupport=NEURAL_CLOSURE_MIN_CLASS_SUPPORT,
  minimumTrades=20,minimumWinRatePct=55,maximumDrawdownPct=8,
  fitFraction=0.35,rankingScoreMap=null,rankingAnchorScoreMap=null
}={}) {
  const unavailable=(reason,extra={})=>({
    schema:'RADARX_EXPANDED_THRESHOLD_WINDOW_COUNTERFACTUAL_V1',
    status:'UNAVAILABLE',diagnostic_only:true,
    affects_primary_probabilities:false,
    affects_primary_threshold:false,
    affects_acceptance_gates:false,
    holdout_values_used:false,
    reason,...extra
  });
  if(!Array.isArray(rows)||rows.length===0||!(rawMap instanceof Map))
    return unavailable('ROWS_OR_VERIFIED_PREDICTION_MAP_INVALID');
  const blocks=chronologicalValidationBlocks(rows,{fitFraction});
  if(!blocks.fit.length||!blocks.threshold_selection.length||!blocks.check.length)
    return unavailable('ALTERNATIVE_CHRONOLOGICAL_SPLIT_UNAVAILABLE');
  const support={
    fit:classCounts(blocks.fit.map(row=>row.target)),
    purge:classCounts(blocks.purged.map(row=>row.target)),
    threshold_selection:classCounts(blocks.threshold_selection.map(row=>row.target)),
    threshold_purge:classCounts(blocks.threshold_purged.map(row=>row.target)),
    outer_validation:classCounts(blocks.check.map(row=>row.target))
  };
  if(support.fit.positive<minimumClassSupport||
    support.fit.negative<minimumClassSupport)
    return unavailable('ALTERNATIVE_CALIBRATION_FIT_CLASS_SUPPORT_NOT_MET',{
      support,fit_fraction:fitFraction,fit_day_count:blocks.days.fit.length
    });
  const fitLogits=probabilitiesFor(blocks.fit,rawMap).map(logit);
  const fitLabels=blocks.fit.map(row=>row.target);
  const platt=fitPlattScaler(fitLogits,fitLabels,{
    minimumPositives:minimumClassSupport,minimumNegatives:minimumClassSupport
  });
  if(platt.fitted!==true)
    return unavailable('ALTERNATIVE_PLATT_FIT_FAILED',{
      support,fit_fraction:fitFraction,calibration:platt,
      fit_day_count:blocks.days.fit.length
    });
  const calibrator=platt.accepted===true?platt:null;
  const selectedMethod=calibrator?'PLATT_SCALING_FIT_ONLY':'RAW_PLATT_NOT_ACCEPTED';
  const selectionProbabilities=probabilitiesFor(
    blocks.threshold_selection,rawMap,calibrator
  );
  const outerProbabilities=probabilitiesFor(blocks.check,rawMap,calibrator);
  const selection=selectThreshold(blocks.threshold_selection,
    selectionProbabilities,roundTripCostBps,{
      minimumTrades,minimumWinRatePct,maximumDrawdownPct,
      thresholdGrid:EXPANDED_THRESHOLD_WINDOW_DIAGNOSTIC_GRID
    });
  const frozenThreshold=selection.threshold;
  const outerLabels=blocks.check.map(row=>row.target);
  const outerSupport=support.outer_validation;
  const outerBrier=brier(outerProbabilities,outerLabels);
  const outerMetrics=finite(frozenThreshold)
    ?portfolioMetrics(blocks.check,outerProbabilities,frozenThreshold,roundTripCostBps)
    :null;
  // Quantify how much signal density survives the frozen threshold on the
  // later block. These diagnostics do not alter probabilities, threshold,
  // selection, risk gates, or the primary acceptance path.
  const selectionDistribution=summarizeFrozenThresholdWindow(
    selectionProbabilities,frozenThreshold
  );
  const outerDistribution=summarizeFrozenThresholdWindow(
    outerProbabilities,frozenThreshold
  );
  const selectionSignalCount=selectionDistribution.frozen_threshold_signal_count;
  const outerSignalCount=outerDistribution.frozen_threshold_signal_count;
  const selectionSignalDensityPct=finite(selectionSignalCount)
    ?Number((100*selectionSignalCount/blocks.threshold_selection.length).toFixed(6))
    :null;
  const outerSignalDensityPct=finite(outerSignalCount)
    ?Number((100*outerSignalCount/blocks.check.length).toFixed(6))
    :null;
  const signalRetentionPct=finite(selectionSignalCount)&&selectionSignalCount>0&&
    finite(outerSignalCount)
    ?Number((100*outerSignalCount/selectionSignalCount).toFixed(6)):null;
  const outerRiskGates={
    return_data_complete:outerMetrics?.return_data_status==='COMPLETE',
    minimum_validation_trades:Number(outerMetrics?.trade_count)>=minimumTrades,
    minimum_validation_win_rate:finite(outerMetrics?.win_rate_pct)&&
      outerMetrics.win_rate_pct>=minimumWinRatePct,
    positive_validation_net_pnl:finite(outerMetrics?.net_pnl_pct)&&
      outerMetrics.net_pnl_pct>0,
    maximum_validation_drawdown:finite(outerMetrics?.max_drawdown_pct)&&
      outerMetrics.max_drawdown_pct<=maximumDrawdownPct
  };

  // Separately test whether the score ranking remains useful when its absolute
  // probability scale shifts. K is selected only on the disjoint selection
  // block and frozen for the later outer block. All acceptance gates are
  // identical to the absolute-threshold policy and remain diagnostic-only.
  const topKGrid=[1,2,3];
  const rankSelectionTrials=topKGrid.map(topK=>{
    const masked=topKProbabilitySignals(
      blocks.threshold_selection,selectionProbabilities,topK
    );
    const metrics=portfolioMetrics(
      blocks.threshold_selection,masked.probabilities,0.5,roundTripCostBps
    );
    const riskGates={
      return_data_complete:metrics?.return_data_status==='COMPLETE',
      minimum_validation_trades:Number(metrics?.trade_count)>=minimumTrades,
      minimum_validation_win_rate:finite(metrics?.win_rate_pct)&&
        metrics.win_rate_pct>=minimumWinRatePct,
      positive_validation_net_pnl:finite(metrics?.net_pnl_pct)&&
        metrics.net_pnl_pct>0,
      maximum_validation_drawdown:finite(metrics?.max_drawdown_pct)&&
        metrics.max_drawdown_pct<=maximumDrawdownPct
    };
    return {
      top_k_per_timestamp:topK,
      decision_group_count:masked.decision_group_count,
      total_time_buckets:masked.total_time_buckets,
      singleton_buckets_excluded:masked.singleton_buckets_excluded,
      decision_bucket_ms:masked.decision_bucket_ms,
      decision_grouping:masked.decision_grouping,
      signal_count:masked.signal_count,
      metrics,
      risk_gates:Object.fromEntries(Object.entries(riskGates)
        .map(([key,value])=>[key,value?'PASS':'FAIL'])),
      qualified:Object.values(riskGates).every(Boolean)
    };
  });
  const rankSelectionReady=rankSelectionTrials.filter(item=>item.qualified)
    .sort((a,b)=>Number(b.metrics.net_pnl_pct)-Number(a.metrics.net_pnl_pct)||
      Number(a.metrics.max_drawdown_pct)-Number(b.metrics.max_drawdown_pct)||
      Number(b.metrics.trade_count)-Number(a.metrics.trade_count)||
      a.top_k_per_timestamp-b.top_k_per_timestamp);
  const frozenTopK=rankSelectionReady[0]?.top_k_per_timestamp??null;
  const outerRankMask=frozenTopK===null?null:topKProbabilitySignals(
    blocks.check,outerProbabilities,frozenTopK
  );
  const outerRankMetrics=outerRankMask===null?null:portfolioMetrics(
    blocks.check,outerRankMask.probabilities,0.5,roundTripCostBps
  );
  const outerRankRiskGates={
    return_data_complete:outerRankMetrics?.return_data_status==='COMPLETE',
    minimum_validation_trades:Number(outerRankMetrics?.trade_count)>=minimumTrades,
    minimum_validation_win_rate:finite(outerRankMetrics?.win_rate_pct)&&
      outerRankMetrics.win_rate_pct>=minimumWinRatePct,
    positive_validation_net_pnl:finite(outerRankMetrics?.net_pnl_pct)&&
      outerRankMetrics.net_pnl_pct>0,
    maximum_validation_drawdown:finite(outerRankMetrics?.max_drawdown_pct)&&
      outerRankMetrics.max_drawdown_pct<=maximumDrawdownPct
  };
  const rankSelectionMask=frozenTopK===null?null:topKProbabilitySignals(
    blocks.threshold_selection,selectionProbabilities,frozenTopK
  );
  const rankRetention=rankSelectionMask&&outerRankMask&&
    rankSelectionMask.decision_group_count>0&&outerRankMask.decision_group_count>0
    ?Number((100*(outerRankMask.signal_count/outerRankMask.decision_group_count)/
      (rankSelectionMask.signal_count/rankSelectionMask.decision_group_count)).toFixed(6))
    :null;
  const rankBasedTopKPolicy={
    schema:'RADARX_TOP_K_PER_TIMESTAMP_POLICY_COUNTERFACTUAL_V1',
    status:'EVALUATED',
    diagnostic_only:true,
    policy:'TOP_K_PER_DECISION_TIMESTAMP',
    decision_bucket_ms:NEURAL_CLOSURE_RANKING_BUCKET_MS,
    decision_grouping:'FLOOR_UNIX_EPOCH_15M_BUCKET',
    score_source:'SAME_FROZEN_CALIBRATED_PROBABILITY_ORDERING_AS_ABSOLUTE_THRESHOLD',
    top_k_grid:topKGrid,
    signal_mask_threshold:0.5,
    minimum_trades:minimumTrades,
    minimum_win_rate_pct:minimumWinRatePct,
    require_positive_net_pnl:true,
    maximum_drawdown_pct:maximumDrawdownPct,
    affects_primary_probabilities:false,
    affects_primary_threshold:false,
    affects_acceptance_gates:false,
    holdout_values_used:false,
    threshold_selection_labels_used_for_calibrator_fit:false,
    outer_validation_labels_used_for_calibrator_fit:false,
    outer_validation_labels_used_for_top_k_selection:false,
    selection:{
      status:frozenTopK===null?'ABSTAINED_NO_TOP_K_PASSED_RISK_GATES':'SELECTED_ON_SELECTION_ONLY',
      sample_count:blocks.threshold_selection.length,
      decision_group_count:rankSelectionTrials[0]?.decision_group_count??0,
      total_time_buckets:rankSelectionTrials[0]?.total_time_buckets??0,
      singleton_buckets_excluded:rankSelectionTrials[0]?.singleton_buckets_excluded??0,
      trials:rankSelectionTrials,
      selected_top_k_per_timestamp:frozenTopK,
      selected_metrics:rankSelectionReady[0]?.metrics??null,
      labels_used_for_k_selection:true
    },
    outer_validation:{
      sample_count:blocks.check.length,
      decision_group_count:outerRankMask?.decision_group_count??0,
      total_time_buckets:outerRankMask?.total_time_buckets??0,
      singleton_buckets_excluded:outerRankMask?.singleton_buckets_excluded??0,
      frozen_top_k_per_timestamp:frozenTopK,
      signal_count:outerRankMask?.signal_count??0,
      signals_per_decision_group:outerRankMask&&outerRankMask.decision_group_count>0
        ?Number((outerRankMask.signal_count/outerRankMask.decision_group_count).toFixed(6)):null,
      selection_signals_per_decision_group:rankSelectionMask&&rankSelectionMask.decision_group_count>0
        ?Number((rankSelectionMask.signal_count/rankSelectionMask.decision_group_count).toFixed(6)):null,
      outer_to_selection_signal_density_retention_pct:rankRetention,
      threshold:0.5,
      metrics:outerRankMetrics,
      risk_gates:Object.fromEntries(Object.entries(outerRankRiskGates)
        .map(([key,value])=>[key,value?'PASS':'FAIL'])),
      risk_gates_passed:Object.values(outerRankRiskGates).every(Boolean),
      labels_used_for_k_selection:false,
      return_data_status:outerRankMetrics?.return_data_status??'NOT_EVALUATED'
    }
  };

  const auxiliaryRankingHeadTopKPolicy=rankingScoreMap instanceof Map&&
    rankingAnchorScoreMap instanceof Map
    ?evaluateAuxiliaryRankingHeadTopKPolicy(
      blocks.threshold_selection,blocks.check,rankingScoreMap,
      rankingAnchorScoreMap,roundTripCostBps,{
        minimumTrades,minimumWinRatePct,maximumDrawdownPct
      })
    :{
      schema:'RADARX_TCN_LSTM_AUXILIARY_RANK_HEAD_TOP_K_POLICY_V1',
      status:'UNAVAILABLE',diagnostic_only:true,
      affects_primary_probabilities:false,affects_primary_threshold:false,
      affects_acceptance_gates:false,holdout_values_used:false,
      reason:!(rankingScoreMap instanceof Map)
        ?'AUXILIARY_RANKING_SCORE_MAP_NOT_AVAILABLE'
        :'AUXILIARY_RANKING_ANCHOR_SCORE_MAP_NOT_AVAILABLE'
    };
  return {
    schema:'RADARX_EXPANDED_THRESHOLD_WINDOW_COUNTERFACTUAL_V1',
    status:'EVALUATED',
    diagnostic_only:true,
    fit_fraction:fitFraction,
    allocation:'35_PERCENT_CALIBRATION_FIT_WITH_DISJOINT_EXPANDED_THRESHOLD_AND_OUTER_CHECK_BLOCKS',
    affects_primary_probabilities:false,
    affects_primary_threshold:false,
    affects_acceptance_gates:false,
    holdout_values_used:false,
    labels_used_for_fit_partition_only:true,
    threshold_selection_labels_used_for_calibrator_fit:false,
    outer_validation_labels_used_for_calibrator_fit:false,
    calibration:{
      method:selectedMethod,
      fit_partition:'ALTERNATIVE_CALIBRATION_FIT_ONLY',
      fit_rows:blocks.fit.length,
      fit_days:blocks.days.fit,
      positive:support.fit.positive,negative:support.fit.negative,
      slope:platt.slope,intercept:platt.intercept,
      fit_nll_before:platt.fit_nll_before,fit_nll_after:platt.fit_nll_after,
      accepted:platt.accepted===true
    },
    partitions:{
      days:{
        fit:blocks.days.fit,purge:blocks.days.purge,
        threshold_selection:blocks.days.threshold_selection,
        threshold_purge:blocks.days.threshold_purge,
        outer_validation:blocks.days.check
      },
      rows:{
        fit:blocks.fit.length,purge:blocks.purged.length,
        threshold_selection:blocks.threshold_selection.length,
        threshold_purge:blocks.threshold_purged.length,
        outer_validation:blocks.check.length
      },
      support
    },
    threshold_selection:{
      status:selection.status,
      sample_count:blocks.threshold_selection.length,
      grid_scope:'DIAGNOSTIC_FINE_THRESHOLD_SWEEP_ONLY',
      threshold_grid:EXPANDED_THRESHOLD_WINDOW_DIAGNOSTIC_GRID,
      selected_threshold:frozenThreshold,
      eligible_threshold_count:selection.eligible_count,
      acceptance_gates:{
        minimum_trades:minimumTrades,
        minimum_win_rate_pct:minimumWinRatePct,
        require_positive_net_pnl:true,
        maximum_drawdown_pct:maximumDrawdownPct
      },
      selected_metrics:selection.selected??null,
      trials:selection.trials
    },
    rank_based_top_k_policy:rankBasedTopKPolicy,
    auxiliary_ranking_head_top_k_policy:auxiliaryRankingHeadTopKPolicy,
    outer_validation:{
      sample_count:blocks.check.length,
      positive_count:outerSupport.positive,
      negative_count:outerSupport.negative,
      calibrated_brier_score:outerBrier,
      threshold:frozenThreshold,
      threshold_metrics:outerMetrics,
      probability_distribution:{
        threshold_selection:selectionDistribution,
        outer_validation:outerDistribution
      },
      threshold_signal_transfer:{
        frozen_threshold:finite(frozenThreshold)?Number(frozenThreshold):null,
        selection_signal_count:selectionSignalCount,
        outer_validation_signal_count:outerSignalCount,
        selection_signal_density_pct:selectionSignalDensityPct,
        outer_validation_signal_density_pct:outerSignalDensityPct,
        selection_to_outer_signal_retention_pct:signalRetentionPct
      },
      risk_gates:Object.fromEntries(Object.entries(outerRiskGates)
        .map(([key,value])=>[key,value?'PASS':'FAIL'])),
      risk_gates_passed:Object.values(outerRiskGates).every(Boolean),
      return_data_status:outerMetrics?.return_data_status??'NOT_EVALUATED'
    }
  };
}

/**
 * Evaluation consumes frozen out-of-sample predictions, not in-sample scores.
 * The model training jobs must emit one prediction for every validation and
 * holdout id. Missing/extra rows fail that family closed.
 */
export const NEURAL_CLOSURE_HOLDOUT_OPENING_REQUIRED_CHECKS=Object.freeze([
  'tuned_logistic_baseline_complete',
  'fixed_cohort_ablation_complete',
  'candidate_decision_documented',
  'calibration_selection_inner_only_or_cross_fitted',
  'leakage_audit_passed',
  'checkpoint_selection_mathematically_validated',
  'outer_execution_gates_passed',
  'confidence_intervals_and_robustness_reported',
  'final_model_architecture_frozen',
  'final_execution_policy_frozen',
  'threshold_top_k_lambda_calibration_and_hyperparameters_frozen',
  'holdout_opening_decision_documented',
  'single_holdout_evaluation_authorized',
  'no_holdout_feedback_into_tuning'
]);

export function evaluateNeuralClosureHoldoutOpeningProtocol(protocol={}) {
  if(!protocol||typeof protocol!=='object'||Array.isArray(protocol))
    throw new TypeError('NEURAL_CLOSURE_HOLDOUT_PROTOCOL_MUST_BE_AN_OBJECT');
  const checks=Object.fromEntries(
    NEURAL_CLOSURE_HOLDOUT_OPENING_REQUIRED_CHECKS.map(name=>[
      name,protocol[name]===true
    ])
  );
  const missing=Object.entries(checks).filter(([,passed])=>!passed)
    .map(([name])=>name);
  return {
    schema:'RADARX_NEURAL_CLOSURE_HOLDOUT_OPENING_PROTOCOL_V1',
    status:missing.length?'LOCKED':'APPROVED',
    passed:missing.length===0,
    checks,
    missing_checks:missing,
    holdout_metrics_read:false
  };
}

export function runNeuralClosureBenchmark({
  rows:inputRows,
  predictionsByModel,
  modelArtifactsByModel,
  sourceCommitSha,
  minimumClassSupport=NEURAL_CLOSURE_MIN_CLASS_SUPPORT,
  roundTripCostBps=30,
  minimumHoldoutTrades=100,
  minimumWinRatePct=55,
  maximumDrawdownPct=8,
  requiredBrierImprovement=NEURAL_CLOSURE_BRIER_MARGIN,
  qualificationByModel={},
  holdoutOpeningProtocol={}
}={}) {
  if(!/^[a-f0-9]{40}$/i.test(String(sourceCommitSha||'')))
    throw new Error('NEURAL_CLOSURE_FULL_SOURCE_SHA_REQUIRED');
  if(!predictionsByModel||typeof predictionsByModel!=='object')
    throw new TypeError('NEURAL_CLOSURE_PREDICTIONS_BY_MODEL_REQUIRED');
  if(!modelArtifactsByModel||typeof modelArtifactsByModel!=='object')
    throw new TypeError('NEURAL_CLOSURE_MODEL_ARTIFACTS_BY_MODEL_REQUIRED');
  const rows=validateFourHourRows(inputRows);
  const split=splitFourHourRows(rows);
  if(!split.train.length||!split.validation.length||!split.holdout.length)
    throw new Error('NEURAL_CLOSURE_EMPTY_SPLIT');
  const trainCounts=classCounts(split.train.map(row=>row.target));
  const validationCounts=classCounts(split.validation.map(row=>row.target));
  const holdoutOpeningProtocolStatus=
    evaluateNeuralClosureHoldoutOpeningProtocol(holdoutOpeningProtocol);
  // The legacy inner/outer model gates are necessary but no longer sufficient.
  // The untouched holdout stays locked until every explicit research-protocol
  // check is true. Missing flags fail closed.
  let holdoutCounts=null;
  const holdoutAccess={
    opened:false,
    gate:'ALL_14_PREDECLARED_RESEARCH_PROTOCOL_CHECKS_AND_MODEL_QUALIFICATION',
    reason:'NO_MODEL_PASSED_INNER_AND_OUTER_VALIDATION_GATES',
    opening_protocol:holdoutOpeningProtocolStatus,
    opened_for_models:[]
  };
  const trainingWeights=deriveTrainingClassWeights(split.train.map(row=>row.target));
  const eventRows=[...split.validation,...split.holdout];
  const requiredIds=eventRows.map(row=>row.id);
  const datasetSha=sha256Canonical(rows.map(row=>({
    id:row.id,symbol:row.symbol,at:row.at,resolved_at:row.resolved_at,
    target_definition:row.target_definition,outcome_source:row.outcome_source,
    outcome:row.outcome,target:row.target,
    feature_information_cutoff_at:row.feature_information_cutoff_at,
    realized_return_pct:row.realized_return_pct??null,
    features:row.features??null,temporal_sequence:row.temporal_sequence??null
  })));
  // Strict external protocol: outer validation is evaluation-only. No
  // calibrator, threshold, Top-K, lambda or hyperparameter is fit/selected here.
  // Calibration is deliberately identity/no-calibration until a train-only
  // cross-fitted calibration artifact is supplied by each model trainer.
  const modelNames=['LOGISTIC_REGRESSION',...NEURAL_CLOSURE_MODEL_FAMILIES];
  const models={},verifiedPredictions=new Map(),verifiedArtifactShaByModel={};
  for(const modelName of modelNames){
    let artifactSha256=null,artifactVerification=null;
    if(modelName!=='LOGISTIC_REGRESSION'){
      const artifact=modelArtifactsByModel[modelName];
      if(!artifact){
        models[modelName]={status:'NOT_EVALUATED',
          reason:'EXACT_VERSIONED_MODEL_ARTIFACT_MISSING'};
        continue;
      }
      artifactVerification=verifyVersionedModelArtifact(artifact,{
        expectedSourceCommitSha:String(sourceCommitSha).toLowerCase()
      });
      if(!artifactVerification.valid||artifact.model_family!==modelName){
        models[modelName]={status:'NOT_EVALUATED',
          reason:'EXACT_VERSIONED_MODEL_ARTIFACT_INVALID_OR_FAMILY_MISMATCH',
          artifact_validation_reason:artifactVerification.reason??'MODEL_FAMILY_MISMATCH'};
        continue;
      }
      artifactSha256=artifactVerification.artifact_sha256;
      verifiedArtifactShaByModel[modelName]=artifactSha256;
    }
    const verified=predictionMap(predictionsByModel[modelName],modelName,requiredIds,{
      sourceCommitSha:String(sourceCommitSha).toLowerCase(),
      targetDefinition:NEURAL_CLOSURE_TARGET_DEFINITION,
      targetSemantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
      artifactSha256
    });
    if(!verified.valid){
      models[modelName]={
        status:'NOT_EVALUATED',reason:verified.reason,
        missing_count:verified.missing_count??null,
        extra_count:verified.extra_count??null
      };
      continue;
    }

    const rawMap=verified.map;
    const auxiliaryRankingMap=modelName==='TCN_LSTM_HYBRID'
      ?collectTcnLstmAuxiliaryRankingMap(
        predictionsByModel[modelName],split.validation,split.holdout
      ):null;
    const auxiliaryRankingAnchorMap=modelName==='TCN_LSTM_HYBRID'
      ?collectTcnLstmRankingAnchorMap(
        predictionsByModel[modelName],split.validation,split.holdout
      ):null;
    const tcnLstmPreInnerCalibration=modelName==='TCN_LSTM_HYBRID'
      ?collectTcnLstmPreInnerCalibrationMap(
        predictionsByModel[modelName],split.validation,split.holdout
      ):null;
    verifiedPredictions.set(modelName,rawMap);
    // All 6,282 outer-validation opportunities are scored once with the
    // model's native output. This block is never used to fit/select calibration.
    const thresholdSelectionRows=[];
    const validationRows=split.validation;
    const rawValidation=probabilitiesFor(validationRows,rawMap);
    const calibratedValidation=rawValidation;
    const validationLabels=validationRows.map(row=>row.target);
    const validationSupport=classCounts(validationLabels);
    const validationBrier=brier(rawValidation,validationLabels);
    const rawThresholdSelectionProbabilities=[];
    const thresholdSelectionProbabilities=[];
    const calibration={
      schema:'RADARX_OUTER_VALIDATION_NO_CALIBRATION_V1',
      status:'NOT_APPLIED_PREDECLARED_IDENTITY',
      selected_method:'IDENTITY_NO_CALIBRATION',
      selection_scope:'PREDECLARED_NO_OUTER_VALIDATION_FIT_OR_SELECTION',
      selected_calibrator:null,
      fit_partition:'NONE',
      fit_rows:0,
      check_block_rows:validationRows.length,
      raw_check_brier:validationBrier,
      selected_check_brier:null,
      improvement:null,
      check_block_used_for_calibrator_selection:false,
      outer_validation_labels_used_for_calibrator_fit:false,
      support_ready:true,
      holdout_values_used:false,
      reason:'NO_TRAIN_ONLY_CROSS_FITTED_CALIBRATOR_WAS_SUPPLIED'
    };
    const thresholdSelectionProbabilityDistribution={
      raw:summarizeProbabilityDistribution(rawThresholdSelectionProbabilities),
      calibrated:summarizeProbabilityDistribution(thresholdSelectionProbabilities)
    };
    const outerValidationProbabilityDistribution={
      raw:summarizeProbabilityDistribution(rawValidation),
      calibrated:summarizeProbabilityDistribution(calibratedValidation)
    };
    const walkForwardCalibrationDiagnostics={
      schema:'RADARX_WALK_FORWARD_CALIBRATION_DIAGNOSTICS_V1',
      status:'DISABLED_STRICT_OUTER_EVALUATION_ONLY',
      diagnostic_only:true,
      holdout_values_used:false,
      outer_validation_labels_used_for_calibrator_fit:false,
      reason:'OUTER_VALIDATION_MUST_NOT_FIT_OR_SELECT_CALIBRATION'
    };
    const probabilityStageDiagnostics=modelName==='TCN_LSTM_HYBRID'?{
      schema:'RADARX_TCN_LSTM_PROBABILITY_STAGE_DIAGNOSTICS_V1',
      status:'DISABLED_STRICT_OUTER_EVALUATION_ONLY',
      diagnostic_only:true,
      labels_used:false,
      holdout_values_used:false,
      affects_primary_probabilities:false,
      affects_threshold_selection:false,
      reason:'NO_OUTER_VALIDATION_CALIBRATION_OR_THRESHOLD_SELECTION'
    }:null;
    const thresholdSelection={
      threshold:0.15,
      status:'PREDECLARED_FROZEN_REFERENCE_THRESHOLD',
      selected:null,
      eligible_count:1,
      selection_role:'PREDECLARED_POLICY_NO_OUTER_SELECTION',
      selection_objective:'FIXED_REFERENCE_THRESHOLD_0_15',
      minimum_validation_trades:20,
      minimum_validation_win_rate_pct:minimumWinRatePct,
      minimum_validation_win_rate_enforced:false,
      require_positive_validation_net_pnl:false,
      maximum_validation_drawdown_pct:maximumDrawdownPct,
      acceptance_qualified:false,
      trials:[]
    };
    // The 0.15 reference threshold was frozen before this outer evaluation;
    // no outer-validation row is used to choose or adjust it.
    const validationThresholdMetrics=finite(thresholdSelection.threshold)
      ?portfolioMetrics(validationRows,calibratedValidation,
        thresholdSelection.threshold,roundTripCostBps)
      :null;
    // If threshold selection abstains, outer execution gates were not run.
    // Preserve that distinction instead of misreporting absent metrics as
    // incomplete return data or failed risk measurements.
    const validationThresholdRiskGates=validationThresholdMetrics?{
      return_data_complete:validationThresholdMetrics.return_data_status==='COMPLETE',
      minimum_validation_trades:Number(validationThresholdMetrics.trade_count)>=20,
      minimum_validation_win_rate:finite(validationThresholdMetrics.win_rate_pct)&&
        validationThresholdMetrics.win_rate_pct>=minimumWinRatePct,
      positive_validation_net_pnl:finite(validationThresholdMetrics.net_pnl_pct)&&
        validationThresholdMetrics.net_pnl_pct>0,
      maximum_validation_drawdown:finite(validationThresholdMetrics.max_drawdown_pct)&&
        validationThresholdMetrics.max_drawdown_pct<=maximumDrawdownPct
    }:{
      return_data_complete:null,
      minimum_validation_trades:null,
      minimum_validation_win_rate:null,
      positive_validation_net_pnl:null,
      maximum_validation_drawdown:null
    };
    const validationThresholdRiskPassed=validationThresholdMetrics!==null&&
      Object.values(validationThresholdRiskGates).every(value=>value===true);
    // Every model is compared at the same predeclared 0.15 threshold.
    // Outer validation only scores this frozen policy; it never chooses it.
    const logisticValidationReference=modelName==='LOGISTIC_REGRESSION'
      ?null:models.LOGISTIC_REGRESSION?.validation??null;
    const matchedExecutionThreshold=logisticValidationReference?.selected_threshold??null;
    const logisticReferenceMetrics=
      logisticValidationReference?.validation_threshold_metrics??null;
    // Eligibility is determined on the earlier disjoint threshold-selection block.
    // Do not require Logistic to win again on the later outer-validation block:
    // that block exists precisely to compare the neural challenger against it.
    const logisticThresholdSelectionReady=
      logisticValidationReference?.threshold_selection==='PREDECLARED_FROZEN_REFERENCE_THRESHOLD'&&
      Number(logisticValidationReference?.selected_threshold)===0.15;
    const matchedExecutionThresholdReady=finite(matchedExecutionThreshold)&&
      logisticThresholdSelectionReady&&
      logisticReferenceMetrics?.return_data_status==='COMPLETE';
    const matchedValidationMetrics=modelName!=='LOGISTIC_REGRESSION'&&
      matchedExecutionThresholdReady
      ?portfolioMetrics(validationRows,calibratedValidation,
        Number(matchedExecutionThreshold),roundTripCostBps)
      :null;
    const matchedValidationRiskGates=matchedValidationMetrics?{
      return_data_complete:matchedValidationMetrics.return_data_status==='COMPLETE',
      minimum_validation_trades:matchedValidationMetrics.trade_count>=20,
      minimum_validation_win_rate:finite(matchedValidationMetrics.win_rate_pct)&&
        matchedValidationMetrics.win_rate_pct>=minimumWinRatePct,
      positive_validation_net_pnl:finite(matchedValidationMetrics.net_pnl_pct)&&
        matchedValidationMetrics.net_pnl_pct>0,
      maximum_validation_drawdown:finite(matchedValidationMetrics.max_drawdown_pct)&&
        matchedValidationMetrics.max_drawdown_pct<=maximumDrawdownPct,
      strictly_beats_logistic_net_pnl:finite(matchedValidationMetrics.net_pnl_pct)&&
        finite(logisticReferenceMetrics?.net_pnl_pct)&&
        matchedValidationMetrics.net_pnl_pct>logisticReferenceMetrics.net_pnl_pct,
      drawdown_no_worse_than_logistic:finite(matchedValidationMetrics.max_drawdown_pct)&&
        finite(logisticReferenceMetrics?.max_drawdown_pct)&&
        matchedValidationMetrics.max_drawdown_pct<=logisticReferenceMetrics.max_drawdown_pct
    }:{
      return_data_complete:null,minimum_validation_trades:null,
      minimum_validation_win_rate:null,positive_validation_net_pnl:null,
      maximum_validation_drawdown:null
    };
    const matchedValidationRiskPassed=matchedValidationMetrics!==null&&
      Object.values(matchedValidationRiskGates).every(value=>value===true);
    const matchedValidationMetricsSummary=matchedValidationMetrics?{
      threshold:Number(matchedExecutionThreshold),
      signal_count:matchedValidationMetrics.signal_count,
      trade_count:matchedValidationMetrics.trade_count,
      win_rate_pct:matchedValidationMetrics.win_rate_pct,
      net_pnl_pct:matchedValidationMetrics.net_pnl_pct,
      max_drawdown_pct:matchedValidationMetrics.max_drawdown_pct,
      return_data_status:matchedValidationMetrics.return_data_status,
      skipped_capacity:matchedValidationMetrics.skipped_capacity,
      skipped_same_symbol:matchedValidationMetrics.skipped_same_symbol
    }:null;
    const matchedValidationRiskGateSummary=Object.fromEntries(
      Object.entries(matchedValidationRiskGates).map(([key,value])=>[
        key,value===null?'NOT_EVALUATED':value?'PASS':'FAIL'
      ])
    );
    const thresholdSelectionSupport=classCounts(thresholdSelectionRows.map(row=>row.target));
    const metricWeights={
      positiveWeight:trainingWeights.positiveWeight,
      negativeWeight:trainingWeights.negativeWeight,
      gammaPositive:1,gammaNegative:2
    };
    const baseValidation={
      walk_forward_calibration_diagnostics:walkForwardCalibrationDiagnostics,
      sample_count:validationRows.length,
      positive_count:validationSupport.positive,
      negative_count:validationSupport.negative,
      raw_brier_score:validationBrier,
      calibrated_brier_score:null,
      evaluation_brier_score:validationBrier,
      probability_evaluation_method:'MODEL_NATIVE_OUTPUT_NO_OUTER_CALIBRATION',
      calibration_applied:false,
      threshold_selection_sample_count:thresholdSelectionRows.length,
      threshold_selection_probability_distribution:thresholdSelectionProbabilityDistribution,
      threshold_selection_positive_count:thresholdSelectionSupport.positive,
      threshold_selection_negative_count:thresholdSelectionSupport.negative,
      outer_validation_probability_distribution:outerValidationProbabilityDistribution,
      chronological_stability_diagnostics:{
        schema:'RADARX_MODEL_CHRONOLOGICAL_STABILITY_V1',
        diagnostic_only:true,
        threshold_selection:{
          status:'NOT_EVALUATED_NO_OUTER_POLICY_SELECTION',
          labels_used_for_threshold_selection:false
        },
        outer_validation:buildChronologicalStabilityDiagnostics(
          validationRows,rawValidation
        )
      },
      expanded_threshold_window_counterfactual:{
        schema:'RADARX_EXPANDED_THRESHOLD_WINDOW_COUNTERFACTUAL_V1',
        status:'DISABLED_STRICT_OUTER_EVALUATION_ONLY',
        diagnostic_only:true,
        affects_primary_probabilities:false,
        affects_primary_threshold:false,
        affects_acceptance_gates:false,
        holdout_values_used:false,
        outer_validation_labels_used_for_calibrator_fit:false,
        outer_validation_labels_used_for_threshold_selection:false,
        reason:'OUTER_VALIDATION_MUST_NOT_FIT_CALIBRATION_OR_SELECT_POLICY'
      },
      ...(modelName==='TCN_LSTM_HYBRID'
        ?{auxiliary_ranking_map_status:auxiliaryRankingMap?.status??'NOT_AVAILABLE',
          auxiliary_ranking_map_reason:auxiliaryRankingMap?.reason??null,
          auxiliary_ranking_anchor_map_status:auxiliaryRankingAnchorMap?.status??'NOT_AVAILABLE',
          auxiliary_ranking_anchor_map_reason:auxiliaryRankingAnchorMap?.reason??null}:{}),
      ...(probabilityStageDiagnostics
        ?{probability_stage_diagnostics:probabilityStageDiagnostics}:{}),
      threshold_selection:thresholdSelection.status,
      selected_threshold:thresholdSelection.threshold,
      threshold_selection_eligible_count:thresholdSelection.eligible_count??0,
      threshold_selection_gates:{
        selection_role:thresholdSelection.selection_role??'MODEL_QUALIFICATION',
        selection_objective:thresholdSelection.selection_objective??'RISK_GATED_NET_RETURN',
        minimum_threshold_selection_trades:thresholdSelection.minimum_validation_trades??20,
        minimum_threshold_selection_win_rate_pct:thresholdSelection.minimum_validation_win_rate_pct??minimumWinRatePct,
        minimum_threshold_selection_win_rate_enforced:thresholdSelection.minimum_validation_win_rate_enforced!==false,
        require_positive_threshold_selection_net_pnl:thresholdSelection.require_positive_validation_net_pnl===true,
        maximum_threshold_selection_drawdown_pct:thresholdSelection.maximum_validation_drawdown_pct??maximumDrawdownPct,
        acceptance_qualified:thresholdSelection.acceptance_qualified===true
      },
      threshold_trials:thresholdSelection.trials.map(item=>({
        threshold:item.threshold,signal_count:item.signal_count,trade_count:item.trade_count,
        win_rate_pct:item.win_rate_pct,net_pnl_pct:item.net_pnl_pct,
        max_drawdown_pct:item.max_drawdown_pct,return_data_status:item.return_data_status,
        skipped_capacity:item.skipped_capacity,skipped_same_symbol:item.skipped_same_symbol
      })),
      validation_threshold_metrics:validationThresholdMetrics?{
        threshold:thresholdSelection.threshold,
        signal_count:validationThresholdMetrics.signal_count,
        trade_count:validationThresholdMetrics.trade_count,
        win_rate_pct:validationThresholdMetrics.win_rate_pct,
        net_pnl_pct:validationThresholdMetrics.net_pnl_pct,
        max_drawdown_pct:validationThresholdMetrics.max_drawdown_pct,
        return_data_status:validationThresholdMetrics.return_data_status,
        skipped_capacity:validationThresholdMetrics.skipped_capacity,
        skipped_same_symbol:validationThresholdMetrics.skipped_same_symbol
      }:null,
      validation_threshold_risk_gates:Object.fromEntries(
        Object.entries(validationThresholdRiskGates).map(([key,value])=>[
          key,value===null?'NOT_EVALUATED':value?'PASS':'FAIL'
        ])
      ),
      matched_execution_reference:modelName==='LOGISTIC_REGRESSION'
        ?'LOGISTIC_REFERENCE_THRESHOLD'
        :matchedExecutionThresholdReady?'MATCHED_LOGISTIC_EXECUTION_THRESHOLD'
          :'UNAVAILABLE_NO_QUALIFIED_LOGISTIC_THRESHOLD',
      matched_execution_threshold:modelName==='LOGISTIC_REGRESSION'
        ?thresholdSelection.threshold:matchedExecutionThreshold,
      matched_execution_validation_metrics:modelName==='LOGISTIC_REGRESSION'
        ?(validationThresholdMetrics?{threshold:thresholdSelection.threshold,signal_count:validationThresholdMetrics.signal_count,trade_count:validationThresholdMetrics.trade_count,win_rate_pct:validationThresholdMetrics.win_rate_pct,net_pnl_pct:validationThresholdMetrics.net_pnl_pct,max_drawdown_pct:validationThresholdMetrics.max_drawdown_pct,return_data_status:validationThresholdMetrics.return_data_status}:null):matchedValidationMetricsSummary,
      matched_execution_validation_risk_gates:modelName==='LOGISTIC_REGRESSION'
        ?Object.fromEntries(Object.entries(validationThresholdRiskGates).map(([key,value])=>[
          key,value===null?'NOT_EVALUATED':value?'PASS':'FAIL'
        ]))
        :matchedValidationRiskGateSummary
    };

    if(modelName==='LOGISTIC_REGRESSION'){
      models[modelName]={
        status:'VALIDATION_EVALUATED',
        model_artifact_sha256:null,
        calibration,
        validation:baseValidation,
        holdout:{
          evaluated:false,sample_count:split.holdout.length,
          brier_score:null,trade_count:0,net_pnl_pct:null,
          max_drawdown_pct:null,return_data_status:'NOT_EVALUATED',
          reason:'HOLDOUT_LOCKED_UNTIL_A_NEURAL_CANDIDATE_PASSES_VALIDATION'
        },
        training_loss_contract:{
          name:'LOGISTIC_BASELINE_RAW_PROPER_SCORING',
          weights_derived_from:'TRAINING_PARTITION_ONLY',
          ...metricWeights
        }
      };
      continue;
    }

    const baselineValidationBrier=models.LOGISTIC_REGRESSION.validation?.evaluation_brier_score??null;
    const improvement=finite(baselineValidationBrier)&&finite(validationBrier)
      ?baselineValidationBrier-validationBrier:null;
    const qualification=qualificationByModel?.[modelName]??{
      passed:true,reason:'NO_ADDITIONAL_INNER_QUALIFICATION_CONFIGURED'
    };
    const validationGates={
      inner_selection_qualified:qualification.passed===true,
      probability_output_available:rawValidation.length===validationRows.length&&
        rawValidation.every(value=>finite(value)&&value>=0&&value<=1),
      minimum_validation_positive_support:validationSupport.positive>=minimumClassSupport,
      minimum_validation_negative_support:validationSupport.negative>=minimumClassSupport,
      brier_improvement_vs_logistic:finite(improvement)&&improvement>requiredBrierImprovement,
      matched_execution_threshold_available:matchedExecutionThresholdReady,
      matched_outer_validation_execution_risk_gates:
        matchedValidationMetrics===null?null:matchedValidationRiskPassed
    };
    const validationPassed=Object.values(validationGates).every(value=>value===true);
    const validationReason=!validationGates.inner_selection_qualified
      ?'INNER_SELECTION_NOT_QUALIFIED'
      :!validationGates.probability_output_available
        ?'MODEL_PROBABILITY_OUTPUT_INVALID'
        :!validationGates.minimum_validation_positive_support||
          !validationGates.minimum_validation_negative_support
          ?'OUTER_VALIDATION_CLASS_SUPPORT_NOT_MET'
          :!validationGates.brier_improvement_vs_logistic
            ?'OUTER_VALIDATION_DID_NOT_BEAT_LOGISTIC_BY_REQUIRED_MARGIN'
            :!validationGates.matched_execution_threshold_available
              ?'LOGISTIC_MATCHED_EXECUTION_THRESHOLD_NOT_AVAILABLE'
              :!validationGates.matched_outer_validation_execution_risk_gates
                ?'OUTER_VALIDATION_MATCHED_EXECUTION_RISK_GATES_FAILED':null;
    const validationGate={
      passed:validationPassed,
      baseline_logistic_brier:baselineValidationBrier,
      candidate_validation_brier:validationBrier,
      brier_improvement_vs_logistic:improvement,
      required_brier_improvement:requiredBrierImprovement,
      threshold_selection_method:'PREDECLARED_FROZEN_REFERENCE_THRESHOLD_0_15_NO_OUTER_FIT',
      outer_validation_threshold:matchedExecutionThreshold,
      model_specific_outer_validation_threshold:thresholdSelection.threshold,
      outer_validation_threshold_metrics:matchedValidationMetricsSummary,
      outer_validation_threshold_risk_gates:matchedValidationRiskGateSummary,
      model_specific_outer_validation_threshold_metrics:baseValidation.validation_threshold_metrics,
      execution_reference:matchedExecutionThresholdReady
        ?'MATCHED_LOGISTIC_EXECUTION_THRESHOLD'
        :'UNAVAILABLE_NO_QUALIFIED_LOGISTIC_THRESHOLD',
      inner_qualification:{
        passed:qualification.passed===true,
        reason:qualification.reason??null,
        diagnostic_only:qualification.diagnostic_only===true
      },
      gates:Object.fromEntries(Object.entries(validationGates)
        .map(([key,value])=>[
          key,value===null?'NOT_EVALUATED':value?'PASS':'FAIL'
        ])),
      reason:validationReason
    };
    const baseModel={
      model_artifact_sha256:artifactSha256,
      calibration,
      validation:{...baseValidation,outer_validation_gate:validationGate},
      training_loss_contract:{
        name:'FOCAL_ASYMMETRIC_BRIER',
        gamma_positive:1,gamma_negative:2,
        ...metricWeights,
        weights_derived_from:'TRAINING_PARTITION_ONLY'
      }
    };
    if(!validationPassed){
      models[modelName]={
        status:'VALIDATION_EVALUATED_HOLDOUT_LOCKED',
        ...baseModel,
        holdout:{
          evaluated:false,sample_count:split.holdout.length,
          brier_score:null,trade_count:0,net_pnl_pct:null,
          max_drawdown_pct:null,return_data_status:'NOT_EVALUATED',
          reason:validationReason??'OUTER_VALIDATION_GATE_FAILED'
        }
      };
      continue;
    }

    if(!holdoutOpeningProtocolStatus.passed){
      // Keep the model's complete outer-validation result while withholding
      // every holdout label-derived score and execution statistic.
      models[modelName]={
        status:'VALIDATION_EVALUATED_HOLDOUT_LOCKED',
        ...baseModel,
        holdout:{
          evaluated:false,sample_count:split.holdout.length,
          brier_score:null,trade_count:null,net_pnl_pct:null,
          max_drawdown_pct:null,return_data_status:'NOT_EVALUATED',
          reason:'HOLDOUT_OPENING_PROTOCOL_INCOMPLETE',
          missing_protocol_checks:holdoutOpeningProtocolStatus.missing_checks
        },
        acceptance:{
          status:'HOLDOUT_LOCKED_PENDING_COMPLETE_RESEARCH_PROTOCOL',
          passed:false,
          reason:'HOLDOUT_OPENING_PROTOCOL_INCOMPLETE',
          missing_protocol_checks:holdoutOpeningProtocolStatus.missing_checks,
          validation_gate:validationGate
        }
      };
      holdoutAccess.reason='HOLDOUT_OPENING_PROTOCOL_INCOMPLETE';
      continue;
    }

    // The holdout is opened only after the candidate has passed the inner
    // selection gate, calibration support and outer validation Brier margin.
    // Logistic is scored on that same holdout exactly once as the reference.
    if(!holdoutAccess.opened){
      holdoutCounts=classCounts(split.holdout.map(row=>row.target));
      const logisticMap=verifiedPredictions.get('LOGISTIC_REGRESSION');
      const logisticProbabilities=probabilitiesFor(split.holdout,logisticMap);
      const logisticThreshold=models.LOGISTIC_REGRESSION.validation.selected_threshold;
      let logisticHoldout;
      if(finite(logisticThreshold)){
        logisticHoldout={
          ...holdoutMetrics(split.holdout,logisticProbabilities,
            logisticThreshold,roundTripCostBps,metricWeights),
          execution_evaluated:true
        };
      }else{
        // Logistic remains the Brier reference. Without its own validated
        // threshold, it has no comparable execution policy.
        const holdoutLabels=split.holdout.map(row=>row.target);
        logisticHoldout={
          sample_count:split.holdout.length,
          positive_count:holdoutCounts.positive,
          negative_count:holdoutCounts.negative,
          brier_score:brier(logisticProbabilities,holdoutLabels),
          focal_asymmetric_brier:focalMean(logisticProbabilities,holdoutLabels,metricWeights),
          execution_evaluated:false,
          trade_count:null,
          net_pnl_pct:null,
          max_drawdown_pct:null,
          return_data_status:'NOT_EVALUATED',
          reason:'NO_QUALIFIED_LOGISTIC_EXECUTION_THRESHOLD'
        };
      }
      models.LOGISTIC_REGRESSION={
        ...models.LOGISTIC_REGRESSION,
        status:'EVALUATED',
        holdout:logisticHoldout
      };
      holdoutAccess.opened=true;
      holdoutAccess.reason='INNER_AND_OUTER_VALIDATION_GATES_PASSED';
      holdoutAccess.execution_reference=finite(logisticThreshold)
        ?'MATCHED_LOGISTIC_EXECUTION_THRESHOLD'
        :'ABSOLUTE_CANDIDATE_RISK_GATES_LOGISTIC_BRIER_ONLY';
    }
    const holdoutProbabilities=probabilitiesFor(split.holdout,rawMap,
      calibration.selected_calibrator);
    const metrics={
      ...holdoutMetrics(split.holdout,holdoutProbabilities,
        Number(matchedExecutionThreshold),roundTripCostBps,metricWeights),
      execution_evaluated:true,
      execution_threshold_source:'LOGISTIC_REGRESSION_FROZEN_THRESHOLD',
      model_specific_selected_threshold:thresholdSelection.threshold
    };
    models[modelName]={
      status:'EVALUATED',
      ...baseModel,
      holdout:metrics
    };
    holdoutAccess.opened_for_models.push(modelName);
  }
  const baseline=models.LOGISTIC_REGRESSION;
  const alternativeBaselineBrier=
    baseline?.validation?.expanded_threshold_window_counterfactual?.outer_validation
      ?.calibrated_brier_score??null;
  for(const modelName of NEURAL_CLOSURE_MODEL_FAMILIES){
    const alternative=models[modelName];
    const diagnostic=alternative?.validation?.expanded_threshold_window_counterfactual;
    if(diagnostic?.status==='EVALUATED'&&finite(alternativeBaselineBrier)){
      const candidateBrier=diagnostic.outer_validation.calibrated_brier_score;
      const improvement=finite(candidateBrier)
        ?alternativeBaselineBrier-candidateBrier:null;
      diagnostic.outer_validation.baseline_logistic_brier=alternativeBaselineBrier;
      diagnostic.outer_validation.brier_improvement_vs_logistic=improvement;
      diagnostic.outer_validation.required_brier_improvement=NEURAL_CLOSURE_BRIER_MARGIN;
      diagnostic.outer_validation.brier_margin_gate=finite(improvement)&&
        improvement>NEURAL_CLOSURE_BRIER_MARGIN?'PASS':'FAIL';
    }
    const model=models[modelName];
    if(model.status==='VALIDATION_EVALUATED_HOLDOUT_LOCKED'){
      const protocolBlocked=model.holdout.reason==='HOLDOUT_OPENING_PROTOCOL_INCOMPLETE';
      model.acceptance={
        status:protocolBlocked
          ?'HOLDOUT_LOCKED_PENDING_COMPLETE_RESEARCH_PROTOCOL'
          :'HOLDOUT_LOCKED_UNTIL_VALIDATION_PASSES',
        passed:false,
        reason:model.holdout.reason,
        missing_protocol_checks:protocolBlocked
          ?model.holdout.missing_protocol_checks??[]:[],
        validation_gate:model.validation.outer_validation_gate
      };
      continue;
    }
    if(model.status!=='EVALUATED'||baseline?.status!=='EVALUATED'){
      model.acceptance={status:'NOT_EVALUATED',passed:false,
        reason:model.reason??'SAME_COHORT_MODEL_OR_LOGISTIC_PREDICTIONS_MISSING'};
      continue;
    }
    const candidate=model.holdout,anchor=baseline.holdout;
    const improvement=anchor.brier_score-candidate.brier_score;
    const matchedThreshold=baseline.validation?.selected_threshold;
    const logisticExecutionComparable=finite(matchedThreshold)&&
      anchor.execution_evaluated===true&&candidate.execution_evaluated===true&&
      finite(anchor.threshold)&&finite(candidate.threshold)&&
      Number(anchor.threshold)===Number(matchedThreshold)&&
      Number(candidate.threshold)===Number(matchedThreshold)&&
      finite(anchor.net_pnl_pct)&&finite(anchor.max_drawdown_pct);
    const qualification=qualificationByModel?.[modelName]??{
      passed:true,reason:'NO_ADDITIONAL_INNER_QUALIFICATION_CONFIGURED'
    };
    const gates={
      minimum_holdout_positive_support:holdoutCounts.positive>=minimumClassSupport,
      calibration_class_support:model.calibration.support_ready===true,
      brier_improvement:improvement>requiredBrierImprovement,
      minimum_oos_trades:candidate.trade_count>=minimumHoldoutTrades,
      minimum_net_win_rate:finite(candidate.win_rate_pct)&&candidate.win_rate_pct>=minimumWinRatePct,
      positive_net_pnl:finite(candidate.net_pnl_pct)&&candidate.net_pnl_pct>0,
      maximum_drawdown:finite(candidate.max_drawdown_pct)&&candidate.max_drawdown_pct<=maximumDrawdownPct,
      matched_logistic_execution_threshold:logisticExecutionComparable,
      beat_logistic_net_pnl:logisticExecutionComparable&&
        finite(candidate.net_pnl_pct)&&candidate.net_pnl_pct>anchor.net_pnl_pct,
      no_higher_drawdown_than_logistic:logisticExecutionComparable&&
        finite(candidate.max_drawdown_pct)&&candidate.max_drawdown_pct<=anchor.max_drawdown_pct,
      return_data_complete:candidate.return_data_status==='COMPLETE',
      inner_selection_qualified:qualification.passed===true
    };
    model.acceptance={
      status:Object.values(gates).every(Boolean)?'PASS':'FAIL',
      passed:Object.values(gates).every(Boolean),
      execution_reference:logisticExecutionComparable
        ?'MATCHED_LOGISTIC_EXECUTION_THRESHOLD'
        :'MATCHED_LOGISTIC_EXECUTION_THRESHOLD_NOT_VERIFIED',
      inner_qualification:{
        passed:qualification.passed===true,
        reason:qualification.reason??null,
        diagnostic_only:qualification.diagnostic_only===true
      },
      brier_improvement:improvement,required_brier_improvement:requiredBrierImprovement,
      gates:Object.fromEntries(Object.entries(gates).map(([key,value])=>[key,value?'PASS':'FAIL']))
    };
  }
  const predictionMatrixSha=sha256Canonical(Object.fromEntries(modelNames.map(name=>[
    name,verifiedPredictions.has(name)
      ?[...verifiedPredictions.get(name).entries()].sort((a,b)=>a[0].localeCompare(b[0]))
      :null
  ])));
  const modelArtifactMatrixSha=sha256Canonical(verifiedArtifactShaByModel);
  const qualificationMatrixSha=sha256Canonical(qualificationByModel);
  const fixedBenchmarkSha=sha256Canonical({
    source_commit_sha:String(sourceCommitSha).toLowerCase(),
    dataset_sha256:datasetSha,row_count:rows.length,
    qualification_matrix_sha256:qualificationMatrixSha,
    target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
    split_schema:split.schema,purge_ms:NEURAL_CLOSURE_PURGE_MS,
    model_artifacts_sha256:modelArtifactMatrixSha,
    prediction_matrix_sha256:predictionMatrixSha
  });
  return {
    schema:'RADARX_BUILD224_FIXED_SHA_NEURAL_CLOSURE_BENCHMARK_V3',
    status:NEURAL_CLOSURE_MODEL_FAMILIES.some(name=>models[name]?.acceptance?.passed)
      ?'NEURAL_SUPERIORITY_PROVEN':'NEURAL_SUPERIORITY_NOT_PROVEN',
    integrity:{
      source_commit_sha:String(sourceCommitSha).toLowerCase(),
      dataset_sha256:datasetSha,
      fixed_benchmark_sha256:fixedBenchmarkSha,
      model_artifacts_sha256:modelArtifactMatrixSha,
      qualification_matrix_sha256:qualificationMatrixSha,
      prediction_matrix_sha256:predictionMatrixSha,
      verified_model_artifacts:Object.keys(verifiedArtifactShaByModel).length,
      row_count:rows.length,
      validation_plus_holdout_rows:eventRows.length,
      row_identity_sha256:sha256Canonical(requiredIds)
    },
    target:{
      definition:NEURAL_CLOSURE_TARGET_DEFINITION,
      semantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
      upside_pct:3,downside_pct:-2,horizon_ms:NEURAL_CLOSURE_HORIZON_MS,
      source:NEURAL_CLOSURE_OUTCOME_SOURCE,
      decision_features_must_be_closed:true
    },
    split:{
      schema:split.schema,nominal_fractions:split.nominal_day_fractions,
      purge_ms:split.purge_ms,days:split.days,counts:split.counts,
      boundaries:split.boundaries,
      train_support:trainCounts,validation_support:validationCounts,
      holdout_support:holdoutCounts,
      holdout_support_opened:holdoutAccess.opened,
      calibration_fit_rows:0,
      calibration_check_rows:0,
      outer_validation_evaluation_rows:split.validation.length
    },
    holdout_access:holdoutAccess,
    calibration_policy:{
      schema:'RADARX_STRICT_OUTER_EVALUATION_POLICY_V1',
      method:'IDENTITY_NO_OUTER_VALIDATION_CALIBRATION',
      fit_partition:'NONE_OUTER_VALIDATION_IS_EVALUATION_ONLY',
      threshold_selection_partition:'NONE_PREDECLARED_FROZEN_POLICY',
      outer_validation_partition:'ALL_OUTER_VALIDATION_ROWS_EVALUATED_ONCE',
      reference_threshold:0.15,
      threshold_selection_scope:'PREDECLARED_BEFORE_OUTER_VALIDATION',
      calibrator_selection_scope:'NONE_NO_EXTERNAL_CALIBRATION_APPLIED',
      outer_validation_used_to_fit_calibrator:false,
      outer_validation_used_to_select_calibrator:false,
      outer_validation_used_to_select_threshold:false,
      outer_validation_used_to_select_top_k:false,
      outer_validation_used_to_select_risk_penalty:false,
      same_fixed_policy_for_logistic_and_neural_models:true,
      calibration_fit_rows:0,
      calibration_purged_rows:0,
      threshold_selection_rows:0,
      threshold_purged_rows:0,
      calibration_check_rows:0,
      outer_validation_evaluation_rows:split.validation.length,
      holdout_used_for_calibration:false,
      outer_validation_only_scores_frozen_models_and_policy:true
    },
    policy:{
      round_trip_cost_bps:roundTripCostBps,
      portfolio_simulation:NEURAL_CLOSURE_PORTFOLIO_POLICY,
      execution_return_contract:NEURAL_CLOSURE_EXECUTION_RETURN_CONTRACT,
      realized_return_contract:{
        take_profit_first:'FIRST_TOUCH_BARRIER_OR_GAP_OPEN_FILL',
        stop_loss_first:'FIRST_TOUCH_BARRIER_OR_GAP_OPEN_FILL',
        horizon_end:'FINAL_CLOSED_4H_CLOSE_FILL',
        horizon_close_return_retained_separately:true,
        round_trip_cost_applied_once:true
      },
      minimum_positive_class_support_per_calibration_block:minimumClassSupport,
      required_brier_improvement:requiredBrierImprovement,
      minimum_holdout_trades:minimumHoldoutTrades,
      minimum_net_win_rate_pct:minimumWinRatePct,
      maximum_drawdown_pct:maximumDrawdownPct,
      paper_trading:true,real_order_execution:false,market:'BINANCE_SPOT_ONLY'
    },
    models
  };
}
