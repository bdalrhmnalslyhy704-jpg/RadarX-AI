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
  let slope=1,intercept=0;
  for(let iteration=0;iteration<iterations;iteration++){
    let g0=regularization*(slope-1),g1=regularization*intercept;
    let h00=regularization,h01=0,h11=regularization;
    for(let i=0;i<logits.length;i++){
      const x=Number(logits[i]),p=sigmoid(slope*x+intercept);
      const error=p-labels[i],weight=p*(1-p);
      g0+=error*x;g1+=error;
      h00+=weight*x*x;h01+=weight*x;h11+=weight;
    }
    const determinant=h00*h11-h01*h01;
    if(!Number.isFinite(determinant)||determinant<=1e-18)
      return {...base,status:'SINGULAR_HESSIAN'};
    const deltaSlope=(h11*g0-h01*g1)/determinant;
    const deltaIntercept=(-h01*g0+h00*g1)/determinant;
    slope=clamp(slope-deltaSlope,0.05,20);
    intercept=clamp(intercept-deltaIntercept,-12,12);
    if(!Number.isFinite(slope)||!Number.isFinite(intercept))
      return {...base,status:'NON_FINITE_OPTIMIZER_STATE'};
    if(Math.max(Math.abs(deltaSlope),Math.abs(deltaIntercept))<1e-9)break;
  }
  const before=binaryNll(logits,labels,sigmoid);
  const after=binaryNll(logits,labels,value=>sigmoid(slope*value+intercept));
  return {...base,status:'FITTED',fitted:true,accepted:after<before,
    slope,intercept,fit_nll_before:before,fit_nll_after:after};
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
/**
 * Auxiliary ranking scores are raw logits, not probabilities. This helper
 * creates a Top-K-per-closed-candle mask while preserving their order.
 * Only the selected/non-selected mask reaches the existing portfolio engine.
 */
export function topKRankingSignals(rows,scores,topK) {
  if(!Array.isArray(rows)||!Array.isArray(scores)||
    rows.length!==scores.length||!Number.isInteger(topK)||topK<1)
    throw new TypeError('NEURAL_TOP_K_RANKING_INPUT_INVALID');
  const groups=new Map();
  for(let index=0;index<rows.length;index++){
    const at=number(rows[index]?.at),score=number(scores[index]);
    if(at===null||score===null)
      throw new TypeError('NEURAL_TOP_K_RANKING_SCORE_INVALID:'+index);
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
      Number(scores[right])-Number(scores[left])||
      String(rows[left]?.symbol??'').localeCompare(String(rows[right]?.symbol??''))||
      String(rows[left]?.id??'').localeCompare(String(rows[right]?.id??'')));
    for(const index of indices.slice(0,topK)){
      const bounded=Math.max(-30,Math.min(30,Number(scores[index])));
      const scoreAsMonotonicRank=Math.max(0,Math.min(1,1/(1+Math.exp(-bounded))));
      masked[index]=0.5+0.5*scoreAsMonotonicRank;
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
    score_source:'RAW_AUXILIARY_RANKING_LOGIT',
    tie_break_order:'RANKING_LOGIT_DESCENDING_THEN_SYMBOL_ASCENDING_THEN_ID_ASCENDING'
  };
}

/**
 * Accept auxiliary ranking diagnostics only for a complete and exact set of
 * outer-validation IDs. Any holdout score is rejected before it can be read.
 */
function collectTcnLstmAuxiliaryRankingMap(predictions,validationRows,holdoutRows) {
  const property='auxiliary_ranking_logit';
  if(!Array.isArray(predictions))
    return {status:'UNAVAILABLE',reason:'PREDICTIONS_NOT_ARRAY',map:new Map()};
  const staged=predictions.filter(item=>
    Object.prototype.hasOwnProperty.call(item??{},property));
  if(!staged.length)
    return {status:'NOT_PROVIDED',reason:'AUXILIARY_RANKING_LOGIT_MISSING',map:new Map()};
  const holdoutIds=new Set(holdoutRows.map(row=>String(row.id)));
  if(staged.some(item=>holdoutIds.has(String(item?.id||''))))
    return {status:'REJECTED_HOLDOUT_RANKING_EXPOSURE',
      reason:'AUXILIARY_RANKING_DIAGNOSTICS_MUST_NOT_INCLUDE_FINAL_HOLDOUT',map:new Map()};
  const expectedIds=new Set(validationRows.map(row=>String(row.id)));
  const map=new Map();
  for(const item of staged){
    const id=String(item?.id||''),value=item?.[property];
    if(!id||!expectedIds.has(id)||map.has(id))
      return {status:'REJECTED_INVALID_RANKING_ROW_SET',
        reason:'AUXILIARY_RANKING_ID_INVALID_DUPLICATE_OR_OUT_OF_SCOPE',map:new Map()};
    if(typeof value!=='number'||!Number.isFinite(value))
      return {status:'REJECTED_INVALID_RANKING_SCORE',
        reason:'AUXILIARY_RANKING_SCORE_NON_FINITE',map:new Map()};
    map.set(id,value);
  }
  if(map.size!==expectedIds.size||[...expectedIds].some(id=>!map.has(id)))
    return {status:'REJECTED_INCOMPLETE_VALIDATION_COVERAGE',
      reason:'AUXILIARY_RANKING_MUST_COVER_EVERY_OUTER_VALIDATION_ROW',map:new Map()};
  return {status:'AVAILABLE',reason:null,map};
}

function evaluateAuxiliaryRankingHeadTopKPolicy(selectionRows,outerRows,rankingScoreMap,
  roundTripCostBps,{minimumTrades=20,minimumWinRatePct=55,maximumDrawdownPct=8}={}) {
  const unavailable=(reason,extra={})=>({
    schema:'RADARX_TCN_LSTM_AUXILIARY_RANK_HEAD_TOP_K_POLICY_V1',
    status:'UNAVAILABLE',diagnostic_only:true,
    affects_primary_probabilities:false,affects_primary_threshold:false,
    affects_acceptance_gates:false,holdout_values_used:false,reason,...extra
  });
  if(!(rankingScoreMap instanceof Map))
    return unavailable('AUXILIARY_RANKING_SCORE_MAP_MISSING');
  const selectionScores=selectionRows.map(row=>rankingScoreMap.get(String(row.id)));
  const outerScores=outerRows.map(row=>rankingScoreMap.get(String(row.id)));
  if(selectionScores.some(value=>!finite(value))||outerScores.some(value=>!finite(value)))
    return unavailable('AUXILIARY_RANKING_SCORE_COVERAGE_INCOMPLETE',{
      selection_rows:selectionRows.length,outer_validation_rows:outerRows.length
    });
  const topKGrid=[1,2,3];
  const riskGatesFor=metrics=>({
    return_data_complete:metrics?.return_data_status==='COMPLETE',
    minimum_validation_trades:Number(metrics?.trade_count)>=minimumTrades,
    minimum_validation_win_rate:finite(metrics?.win_rate_pct)&&
      metrics.win_rate_pct>=minimumWinRatePct,
    positive_validation_net_pnl:finite(metrics?.net_pnl_pct)&&
      metrics.net_pnl_pct>0,
    maximum_validation_drawdown:finite(metrics?.max_drawdown_pct)&&
      metrics.max_drawdown_pct<=maximumDrawdownPct
  });
  const trials=topKGrid.map(topK=>{
    const mask=topKRankingSignals(selectionRows,selectionScores,topK);
    const metrics=portfolioMetrics(selectionRows,mask.probabilities,0.5,roundTripCostBps);
    const gates=riskGatesFor(metrics);
    return {
      top_k_per_timestamp:topK,decision_group_count:mask.decision_group_count,
      total_time_buckets:mask.total_time_buckets,
      singleton_buckets_excluded:mask.singleton_buckets_excluded,
      signal_count:mask.signal_count,metrics,
      risk_gates:Object.fromEntries(Object.entries(gates)
        .map(([key,value])=>[key,value?'PASS':'FAIL'])),
      qualified:Object.values(gates).every(Boolean)
    };
  });
  const eligible=trials.filter(item=>item.qualified).sort((a,b)=>
    Number(b.metrics.net_pnl_pct)-Number(a.metrics.net_pnl_pct)||
    Number(a.metrics.max_drawdown_pct)-Number(b.metrics.max_drawdown_pct)||
    Number(b.metrics.trade_count)-Number(a.metrics.trade_count)||
    a.top_k_per_timestamp-b.top_k_per_timestamp);
  const selected=eligible[0]??null;
  const outerMask=selected
    ?topKRankingSignals(outerRows,outerScores,selected.top_k_per_timestamp):null;
  const outerMetrics=outerMask
    ?portfolioMetrics(outerRows,outerMask.probabilities,0.5,roundTripCostBps):null;
  const outerGates=riskGatesFor(outerMetrics);
  return {
    schema:'RADARX_TCN_LSTM_AUXILIARY_RANK_HEAD_TOP_K_POLICY_V1',
    status:'EVALUATED',diagnostic_only:true,
    policy:'TOP_K_PER_15M_DECISION_BUCKET_BY_AUXILIARY_RANKING_LOGIT',
    score_source:'FROZEN_TRAINING_ONLY_AUXILIARY_RANKING_HEAD_RAW_LOGIT',
    top_k_grid:topKGrid,minimum_trades:minimumTrades,
    minimum_win_rate_pct:minimumWinRatePct,
    require_positive_net_pnl:true,maximum_drawdown_pct:maximumDrawdownPct,
    decision_bucket_ms:NEURAL_CLOSURE_RANKING_BUCKET_MS,
    decision_grouping:'FLOOR_UNIX_EPOCH_15M_BUCKET',
    affects_primary_probabilities:false,affects_primary_threshold:false,
    affects_acceptance_gates:false,holdout_values_used:false,
    selection:{
      status:selected?'SELECTED_ON_DISJOINT_SELECTION_ONLY':'ABSTAINED_NO_TOP_K_PASSED_RISK_GATES',
      sample_count:selectionRows.length,
      decision_group_count:trials[0]?.decision_group_count??0,
      trials,selected_top_k_per_timestamp:selected?.top_k_per_timestamp??null,
      selected_metrics:selected?.metrics??null,labels_used_for_k_selection:true,
      ranking_scores_fit_using_selection_labels:false
    },
    outer_validation:{
      sample_count:outerRows.length,
      decision_group_count:outerMask?.decision_group_count??0,
      signal_count:outerMask?.signal_count??0,
      frozen_top_k_per_timestamp:selected?.top_k_per_timestamp??null,
      metrics:outerMetrics,
      risk_gates:Object.fromEntries(Object.entries(outerGates)
        .map(([key,value])=>[key,value?'PASS':'FAIL'])),
      risk_gates_passed:Object.values(outerGates).every(Boolean),
      labels_used_for_k_selection:false,
      return_data_status:outerMetrics?.return_data_status??'NOT_EVALUATED'
    }
  };
}

function buildExpandedThresholdWindowCounterfactual(rows,rawMap,roundTripCostBps,{
  minimumClassSupport=NEURAL_CLOSURE_MIN_CLASS_SUPPORT,
  minimumTrades=20,minimumWinRatePct=55,maximumDrawdownPct=8,
  fitFraction=0.35,rankingScoreMap=null
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


  const auxiliaryRankingHeadTopKPolicy=rankingScoreMap instanceof Map
    ?evaluateAuxiliaryRankingHeadTopKPolicy(
      blocks.threshold_selection,blocks.check,rankingScoreMap,roundTripCostBps,{
        minimumTrades,minimumWinRatePct,maximumDrawdownPct
      })
    :{
      schema:'RADARX_TCN_LSTM_AUXILIARY_RANK_HEAD_TOP_K_POLICY_V1',
      status:'UNAVAILABLE',diagnostic_only:true,
      affects_primary_probabilities:false,affects_primary_threshold:false,
      affects_acceptance_gates:false,holdout_values_used:false,
      reason:'AUXILIARY_RANKING_SCORE_MAP_NOT_AVAILABLE'
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
  qualificationByModel={}
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
  // Do not derive holdout labels, portfolio outcomes or performance metrics
  // until a challenger passes inner qualification, the independent outer
  // validation Brier margin and the preselected-threshold execution risk gates.
  let holdoutCounts=null;
  const holdoutAccess={
    opened:false,
    gate:'INNER_QUALIFICATION_AND_DISJOINT_OUTER_VALIDATION_BRIER_AND_EXECUTION_RISK_GATES',
    reason:'NO_MODEL_PASSED_INNER_AND_OUTER_VALIDATION_GATES',
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
  const calibrationBlocks=chronologicalValidationBlocks(split.validation);
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
    const tcnLstmPreInnerCalibration=modelName==='TCN_LSTM_HYBRID'
      ?collectTcnLstmPreInnerCalibrationMap(
        predictionsByModel[modelName],split.validation,split.holdout
      ):null;
    verifiedPredictions.set(modelName,rawMap);
    // The Logistic anchor and every neural challenger receive the same
    // chronological calibration fit/purge/check rows and the same candidate
    // calibrators. This prevents raw-vs-calibrated Brier comparisons.
    const thresholdSelectionRows=calibrationBlocks.threshold_selection;
    const validationRows=calibrationBlocks.check;
    const calibration=chooseCalibration(rawMap,
      calibrationBlocks.fit,validationRows,minimumClassSupport,{
        purgedRows:calibrationBlocks.purged,
        thresholdSelectionRows,
        thresholdPurgedRows:calibrationBlocks.threshold_purged,
        calibrationDays:calibrationBlocks.days
      });
    const rawValidation=probabilitiesFor(validationRows,rawMap);
    const calibratedValidation=probabilitiesFor(validationRows,rawMap,
      calibration.selected_calibrator);
    const validationLabels=validationRows.map(row=>row.target);
    const validationSupport=classCounts(validationLabels);
    const validationBrier=brier(calibratedValidation,validationLabels);
    const rawThresholdSelectionProbabilities=probabilitiesFor(thresholdSelectionRows,rawMap);
    const thresholdSelectionProbabilities=probabilitiesFor(thresholdSelectionRows,
      rawMap,calibration.selected_calibrator);
    const thresholdSelectionProbabilityDistribution={
      raw:summarizeProbabilityDistribution(rawThresholdSelectionProbabilities),
      calibrated:summarizeProbabilityDistribution(thresholdSelectionProbabilities)
    };
    const outerValidationProbabilityDistribution={
      raw:summarizeProbabilityDistribution(rawValidation),
      calibrated:summarizeProbabilityDistribution(calibratedValidation)
    };
    const walkForwardBaselineRawMap=modelName==='LOGISTIC_REGRESSION'
      ?null:(verifiedPredictions.get('LOGISTIC_REGRESSION')??null);
    const walkForwardCalibrationDiagnostics=
      buildWalkForwardCalibrationDiagnostics(split.validation,rawMap,{
        minimumClassSupport,baselineRawMap:walkForwardBaselineRawMap,
        roundTripCostBps,minimumTrades:20,minimumWinRatePct,maximumDrawdownPct
      });
    const probabilityStageDiagnostics=modelName==='TCN_LSTM_HYBRID'
      ?buildTcnLstmProbabilityStageDiagnostics({
        preInner:tcnLstmPreInnerCalibration,
        calibrationFitRows:calibrationBlocks.fit,
        thresholdSelectionRows,validationRows,
        minimumClassSupport,
        innerCalibratedThresholdSelection:
          summarizeProbabilityDistribution(rawThresholdSelectionProbabilities),
        innerCalibratedValidation:
          summarizeProbabilityDistribution(rawValidation),
        innerCalibratedThresholdSelectionProbabilities:rawThresholdSelectionProbabilities,
        innerCalibratedValidationProbabilities:rawValidation,
        sharedCalibratedThresholdSelection:
          summarizeProbabilityDistribution(thresholdSelectionProbabilities),
        sharedCalibratedValidation:
          summarizeProbabilityDistribution(calibratedValidation),
        sharedCalibratedThresholdSelectionProbabilities:thresholdSelectionProbabilities,
        sharedCalibratedValidationProbabilities:calibratedValidation,
        sharedCalibrationMethod:calibration.selected_method
      }):null;
    const thresholdSelection=selectThreshold(thresholdSelectionRows,
      thresholdSelectionProbabilities,roundTripCostBps,{
        minimumTrades:20,minimumWinRatePct,maximumDrawdownPct
      });
    // The threshold is chosen only on the earlier threshold-selection block.
    // The later outer-validation block evaluates that frozen threshold once.
    const validationThresholdMetrics=finite(thresholdSelection.threshold)
      ?portfolioMetrics(validationRows,calibratedValidation,
        thresholdSelection.threshold,roundTripCostBps)
      :null;
    const validationThresholdRiskGates={
      return_data_complete:validationThresholdMetrics?.return_data_status==='COMPLETE',
      minimum_validation_trades:Number(validationThresholdMetrics?.trade_count)>=20,
      minimum_validation_win_rate:finite(validationThresholdMetrics?.win_rate_pct)&&
        validationThresholdMetrics.win_rate_pct>=minimumWinRatePct,
      positive_validation_net_pnl:finite(validationThresholdMetrics?.net_pnl_pct)&&
        validationThresholdMetrics.net_pnl_pct>0,
      maximum_validation_drawdown:finite(validationThresholdMetrics?.max_drawdown_pct)&&
        validationThresholdMetrics.max_drawdown_pct<=maximumDrawdownPct
    };
    const validationThresholdRiskPassed=Object.values(validationThresholdRiskGates).every(Boolean);
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
      raw_brier_score:brier(rawValidation,validationLabels),
      calibrated_brier_score:validationBrier,
      threshold_selection_sample_count:thresholdSelectionRows.length,
      threshold_selection_probability_distribution:thresholdSelectionProbabilityDistribution,
      threshold_selection_positive_count:thresholdSelectionSupport.positive,
      threshold_selection_negative_count:thresholdSelectionSupport.negative,
      outer_validation_probability_distribution:outerValidationProbabilityDistribution,
      chronological_stability_diagnostics:{
        schema:'RADARX_MODEL_CHRONOLOGICAL_STABILITY_V1',
        diagnostic_only:true,
        threshold_selection:buildChronologicalStabilityDiagnostics(
          thresholdSelectionRows,thresholdSelectionProbabilities
        ),
        outer_validation:buildChronologicalStabilityDiagnostics(
          validationRows,calibratedValidation
        )
      },
      expanded_threshold_window_counterfactual:
        buildExpandedThresholdWindowCounterfactual(
          split.validation,rawMap,roundTripCostBps,{
            minimumClassSupport,minimumTrades:20,
            minimumWinRatePct,maximumDrawdownPct,fitFraction:0.35,
            rankingScoreMap:modelName==='TCN_LSTM_HYBRID'&&
              auxiliaryRankingMap?.status==='AVAILABLE'
                ?auxiliaryRankingMap.map:null
          }
        ),
      ...(modelName==='TCN_LSTM_HYBRID'
        ?{auxiliary_ranking_map_status:auxiliaryRankingMap?.status??'NOT_AVAILABLE',
          auxiliary_ranking_map_reason:auxiliaryRankingMap?.reason??null}:{}),
      ...(probabilityStageDiagnostics
        ?{probability_stage_diagnostics:probabilityStageDiagnostics}:{}),
      threshold_selection:thresholdSelection.status,
      selected_threshold:thresholdSelection.threshold,
      threshold_selection_eligible_count:thresholdSelection.eligible_count??0,
      threshold_selection_gates:{
        minimum_threshold_selection_trades:thresholdSelection.minimum_validation_trades??20,
        minimum_threshold_selection_win_rate_pct:thresholdSelection.minimum_validation_win_rate_pct??minimumWinRatePct,
        require_positive_threshold_selection_net_pnl:thresholdSelection.require_positive_validation_net_pnl===true,
        maximum_threshold_selection_drawdown_pct:thresholdSelection.maximum_validation_drawdown_pct??maximumDrawdownPct
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
        Object.entries(validationThresholdRiskGates).map(([key,value])=>[key,value?'PASS':'FAIL'])
      )
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

    const baselineValidationBrier=models.LOGISTIC_REGRESSION.validation?.calibrated_brier_score??null;
    const improvement=finite(baselineValidationBrier)&&finite(validationBrier)
      ?baselineValidationBrier-validationBrier:null;
    const qualification=qualificationByModel?.[modelName]??{
      passed:true,reason:'NO_ADDITIONAL_INNER_QUALIFICATION_CONFIGURED'
    };
    const validationGates={
      inner_selection_qualified:qualification.passed===true,
      calibration_class_support:calibration.support_ready===true,
      minimum_validation_positive_support:validationSupport.positive>=minimumClassSupport,
      minimum_validation_negative_support:validationSupport.negative>=minimumClassSupport,
      brier_improvement_vs_logistic:finite(improvement)&&improvement>requiredBrierImprovement,
      threshold_selection_qualified:
        thresholdSelection.status==='SELECTED_ON_VALIDATION_ONLY'&&
        finite(thresholdSelection.threshold)&&thresholdSelection.eligible_count>0,
      outer_validation_threshold_risk_gates:validationThresholdRiskPassed
    };
    const validationPassed=Object.values(validationGates).every(Boolean);
    const validationReason=!validationGates.inner_selection_qualified
      ?'INNER_SELECTION_NOT_QUALIFIED'
      :!validationGates.calibration_class_support
        ?'CALIBRATION_CLASS_SUPPORT_NOT_MET'
        :!validationGates.minimum_validation_positive_support||
          !validationGates.minimum_validation_negative_support
          ?'OUTER_VALIDATION_CLASS_SUPPORT_NOT_MET'
          :!validationGates.brier_improvement_vs_logistic
            ?'OUTER_VALIDATION_DID_NOT_BEAT_LOGISTIC_BY_REQUIRED_MARGIN'
            :!validationGates.threshold_selection_qualified
              ?'THRESHOLD_SELECTION_BLOCK_DID_NOT_QUALIFY'
              :!validationGates.outer_validation_threshold_risk_gates
                ?'OUTER_VALIDATION_THRESHOLD_RISK_GATES_FAILED':null;
    const validationGate={
      passed:validationPassed,
      baseline_logistic_brier:baselineValidationBrier,
      candidate_validation_brier:validationBrier,
      brier_improvement_vs_logistic:improvement,
      required_brier_improvement:requiredBrierImprovement,
      threshold_selection_method:'EARLIER_DISJOINT_PURGED_BLOCK',
      outer_validation_threshold:thresholdSelection.threshold,
      outer_validation_threshold_metrics:baseValidation.validation_threshold_metrics,
      outer_validation_threshold_risk_gates:baseValidation.validation_threshold_risk_gates,
      inner_qualification:{
        passed:qualification.passed===true,
        reason:qualification.reason??null,
        diagnostic_only:qualification.diagnostic_only===true
      },
      gates:Object.fromEntries(Object.entries(validationGates)
        .map(([key,value])=>[key,value?'PASS':'FAIL'])),
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
        thresholdSelection.threshold,roundTripCostBps,metricWeights),
      execution_evaluated:true
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
      model.acceptance={
        status:'HOLDOUT_LOCKED_UNTIL_VALIDATION_PASSES',
        passed:false,
        reason:model.holdout.reason,
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
    const logisticExecutionComparable=baseline.validation?.selected_threshold!==null&&
      baseline.validation?.selected_threshold!==undefined&&
      anchor.execution_evaluated===true&&
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
      ...(logisticExecutionComparable?{
        beat_logistic_net_pnl:finite(candidate.net_pnl_pct)&&
          candidate.net_pnl_pct>anchor.net_pnl_pct,
        no_higher_drawdown_than_logistic:finite(candidate.max_drawdown_pct)&&
          candidate.max_drawdown_pct<=anchor.max_drawdown_pct
      }:{}),
      return_data_complete:candidate.return_data_status==='COMPLETE',
      inner_selection_qualified:qualification.passed===true
    };
    model.acceptance={
      status:Object.values(gates).every(Boolean)?'PASS':'FAIL',
      passed:Object.values(gates).every(Boolean),
      execution_reference:logisticExecutionComparable
        ?'MATCHED_LOGISTIC_EXECUTION_THRESHOLD'
        :'ABSOLUTE_CANDIDATE_RISK_GATES_LOGISTIC_BRIER_ONLY',
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
      calibration_fit_rows:calibrationBlocks.fit.length,
      calibration_check_rows:calibrationBlocks.check.length
    },
    holdout_access:holdoutAccess,
    calibration_policy:{
      schema:'DISJOINT_CALIBRATION_THRESHOLD_SELECTION_OUTER_VALIDATION_V1',
      method:'PREDECLARED_PLATT_SCALING_WITH_RAW_FALLBACK',
      fit_partition:'CALIBRATION_FIT_ONLY',
      threshold_selection_partition:'EARLIER_DISJOINT_PURGED_BLOCK',
      outer_validation_partition:'LATER_DISJOINT_PURGED_CHECK_BLOCK',
      fallback:'RAW_IF_PLATT_NOT_ACCEPTED',
      temperature_scaling:'NOT_FIT_PREDECLARED_PLATT_ONLY',
      selection_scope:'PREDECLARED_PLATT_FIT_ON_CALIBRATION_FIT_ONLY',
      check_block_used_for_calibrator_selection:false,
      threshold_selection_rows_used_for_outer_validation_metrics:false,
      same_fit_purge_threshold_and_check_rows_for_logistic_and_neural_models:true,
      calibration_fit_rows:calibrationBlocks.fit.length,
      calibration_purged_rows:calibrationBlocks.purged.length,
      threshold_selection_rows:calibrationBlocks.threshold_selection.length,
      threshold_purged_rows:calibrationBlocks.threshold_purged.length,
      calibration_check_rows:calibrationBlocks.check.length,
      holdout_used_for_calibration:false,
      threshold_selection_risk_gates_unchanged:true,
      outer_validation_rechecks_frozen_threshold:true
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
