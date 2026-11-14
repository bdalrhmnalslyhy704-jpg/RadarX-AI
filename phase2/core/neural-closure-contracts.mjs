import {createHash} from 'node:crypto';

export const NEURAL_CLOSURE_TARGET_DEFINITION =
  'FIRST_TOUCH_PLUS_3_PCT_BEFORE_MINUS_2_PCT_WITHIN_4H_1M_V1';
export const NEURAL_CLOSURE_HORIZON_MS = 4 * 60 * 60 * 1000;
export const NEURAL_CLOSURE_PURGE_MS = 24 * 60 * 60 * 1000;
export const NEURAL_CLOSURE_OUTCOME_SOURCE =
  'BINANCE_OFFICIAL_CLOSED_1M_FIRST_TOUCH_4H_V1';
export const NEURAL_CLOSURE_MIN_CLASS_SUPPORT = 50;
export const NEURAL_CLOSURE_BRIER_MARGIN = 0.003;
export const NEURAL_CLOSURE_MODEL_FAMILIES = Object.freeze([
  'COGNITIVE_MLP_V5',
  'TCN_V6',
  'TCN_V7',
  'TCN_V8',
  'TCN_V9',
  'TCN_V10',
  'TCN_V11',
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
 * Resolve the exact +3% before -2% label from 240 consecutive completed
 * Binance Spot one-minute candles. If both barriers fall inside the same
 * candle, OHLC cannot determine which was first and the row is rejected.
 */
export function buildFourHourFirstTouchOutcome({
  id,symbol,baselineAt,baselinePrice,candles,
  featureInformationCutoffAt=baselineAt
}={}){
  const fail=(reason,extra={})=>({training_eligible:false,status:'REJECTED',
    reason,id:id??null,symbol:symbol??null,...extra});
  if(typeof id!=='string'||!id.trim()||typeof symbol!=='string'||!symbol.trim())
    return fail('IDENTITY_MISSING');
  if(!finite(baselineAt)||!finite(baselinePrice)||Number(baselinePrice)<=0||
    Number(featureInformationCutoffAt)!==Number(baselineAt))
    return fail('BASELINE_OR_FEATURE_CUTOFF_INVALID');
  const at=Number(baselineAt),price=Number(baselinePrice);
  if(at%60_000!==0)return fail('BASELINE_NOT_ON_ONE_MINUTE_BOUNDARY');
  if(!Array.isArray(candles)||candles.length!==240)
    return fail('EXACT_240_CLOSED_ONE_MINUTE_CANDLES_REQUIRED');
  const takePrice=price*1.03,stopPrice=price*0.98;
  let outcome='FLAT',resolution='HORIZON_END',firstTouchAt=at+NEURAL_CLOSURE_HORIZON_MS;
  let ambiguous=false;
  for(let index=0;index<240;index++){
    const candle=candles[index];
    const expectedOpen=at+(index+1)*60_000;
    const open=number(candle?.open_time??candle?.openTime);
    const close=number(candle?.close_time??candle?.closeTime);
    const high=number(candle?.high),low=number(candle?.low);
    if(candle?.is_closed!==true||open!==expectedOpen||close!==expectedOpen+59_999||
      high===null||low===null||high<low||low<=0)
      return fail('ONE_MINUTE_CANDLE_GAP_OPEN_OR_INVALID:'+index);
    const hitTake=high>=takePrice,hitStop=low<=stopPrice;
    if(hitTake&&hitStop){
      ambiguous=true;break;
    }
    if(hitTake){
      outcome='UP';resolution='TAKE_PROFIT_FIRST';firstTouchAt=expectedOpen+59_999;break;
    }
    if(hitStop){
      outcome='DOWN';resolution='STOP_LOSS_FIRST';firstTouchAt=expectedOpen+59_999;break;
    }
  }
  if(ambiguous)return fail('AMBIGUOUS_BOTH_BARRIERS_TOUCHED_IN_ONE_MINUTE_CANDLE',{
    target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
    outcome_source:NEURAL_CLOSURE_OUTCOME_SOURCE,
    horizon_ms:NEURAL_CLOSURE_HORIZON_MS
  });
  const finalClose=number(candles.at(-1)?.close);
  if(finalClose===null||finalClose<=0)return fail('FINAL_ONE_MINUTE_CLOSE_INVALID');
  const resolvedAt=at+NEURAL_CLOSURE_HORIZON_MS;
  return {
    id,symbol:String(symbol).trim().toUpperCase(),
    at,resolved_at:resolvedAt,horizon_ms:NEURAL_CLOSURE_HORIZON_MS,
    feature_information_cutoff_at:at,
    target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
    outcome_source:NEURAL_CLOSURE_OUTCOME_SOURCE,
    outcome,target:outcome==='UP'?1:0,
    first_touch:{
      resolution,first_touch_at:firstTouchAt,path_resolution:'1M',
      observed_candles:240,baseline_price:price,
      take_profit_price:takePrice,stop_loss_price:stopPrice
    },
    realized_return_pct:(finalClose/price-1)*100,
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
        source.outcome_source !== outcomeSource)
      throw new Error('NEURAL_CLOSURE_ROW_TARGET_OR_SOURCE_MISMATCH:' + index);
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
function chronologicalValidationBlocks(rows) {
  const days=[...new Set(rows.map(row=>Math.floor(row.at/NEURAL_CLOSURE_PURGE_MS)*
    NEURAL_CLOSURE_PURGE_MS))].sort((a,b)=>a-b);
  if(days.length<2)return {fit:[],check:[]};
  const midpoint=Math.max(1,Math.floor(days.length/2));
  const fitDays=new Set(days.slice(0,midpoint));
  const checkDays=new Set(days.slice(midpoint));
  return {
    fit:rows.filter(row=>fitDays.has(Math.floor(row.at/NEURAL_CLOSURE_PURGE_MS)*NEURAL_CLOSURE_PURGE_MS)),
    check:rows.filter(row=>checkDays.has(Math.floor(row.at/NEURAL_CLOSURE_PURGE_MS)*NEURAL_CLOSURE_PURGE_MS))
  };
}
function predictionMap(predictions,modelName,requiredIds) {
  if(!Array.isArray(predictions))
    return {valid:false,reason:'MODEL_PREDICTIONS_MISSING',map:new Map()};
  const map=new Map();
  for(const item of predictions){
    const id=String(item?.id||'');
    if(!id||map.has(id)||!finite(item?.probability)||
      Number(item.probability)<0||Number(item.probability)>1)
      return {valid:false,reason:'MODEL_PREDICTION_DUPLICATE_OR_INVALID:'+modelName,map};
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
function chooseCalibration(rawMap,fitRows,checkRows,minimumPositives) {
  const fitLabels=fitRows.map(row=>row.target);
  const fitLogits=probabilitiesFor(fitRows,rawMap).map(logit);
  const rawCheck=probabilitiesFor(checkRows,rawMap);
  const checkLabels=checkRows.map(row=>row.target);
  const rawCheckBrier=brier(rawCheck,checkLabels);
  const temperature=fitTemperatureScaler(fitLogits,fitLabels,{
    minimumPositives,minimumNegatives:minimumPositives});
  const platt=fitPlattScaler(fitLogits,fitLabels,{
    minimumPositives,minimumNegatives:minimumPositives});
  const candidates=[{calibrator:null,method:'RAW',brier:rawCheckBrier},
    ...[temperature,platt].filter(item=>item.fitted).map(calibrator=>({
      calibrator,method:calibrator.method,
      brier:brier(probabilitiesFor(checkRows,rawMap,calibrator),checkLabels)
    }))].filter(item=>finite(item.brier));
  candidates.sort((a,b)=>a.brier-b.brier||a.method.localeCompare(b.method));
  const best=candidates[0]||{calibrator:null,method:'RAW',brier:null};
  const supportReady=temperature.fitted&&platt.fitted;
  return {
    status:supportReady?'EVALUATED':'INSUFFICIENT_CLASS_SUPPORT',
    selected_method:best.method,selected_calibrator:best.calibrator,
    raw_check_brier:rawCheckBrier,selected_check_brier:best.brier,
    improvement:rawCheckBrier!==null&&best.brier!==null?rawCheckBrier-best.brier:null,
    temperature,platt,
    calibration_fit_support:classCounts(fitLabels),
    calibration_check_support:classCounts(checkLabels),
    minimum_positive_support_per_block:minimumPositives,
    calibration_fit_rows:fitRows.length,calibration_check_rows:checkRows.length,
    support_ready:supportReady
  };
}

function realizedNetReturns(rows,roundTripCostBps) {
  const costPct=Number(roundTripCostBps)/100;
  return rows.map(row=>finite(row.realized_return_pct)
    ?Number(row.realized_return_pct)-costPct:null);
}
function portfolioMetrics(rows,probabilities,threshold,roundTripCostBps) {
  const selected=[];
  for(let index=0;index<rows.length;index++)
    if(probabilities[index]>=threshold)selected.push(index);
  const netReturns=realizedNetReturns(selected.map(index=>rows[index]),roundTripCostBps);
  const returnsReady=netReturns.length>0&&netReturns.every(finite);
  if(!returnsReady){
    return {trade_count:selected.length,threshold,
      win_rate_pct:null,net_pnl_pct:null,max_drawdown_pct:null,
      sharpe_per_trade:null,return_data_status:'NOT_AVAILABLE_OR_INCOMPLETE'};
  }
  let equity=1,peak=1,maxDrawdown=0,sum=0,sumSquares=0,wins=0;
  for(const value of netReturns){
    if(value<=-100)throw new Error('NEURAL_CLOSURE_RETURN_AT_OR_BELOW_MINUS_100_PERCENT');
    equity*=1+value/100;peak=Math.max(peak,equity);
    maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak*100);
    sum+=value;sumSquares+=value*value;if(value>0)wins++;
  }
  const mean=sum/netReturns.length;
  const variance=Math.max(0,sumSquares/netReturns.length-mean*mean);
  const sd=Math.sqrt(variance);
  return {
    trade_count:selected.length,threshold,
    win_rate_pct:100*wins/netReturns.length,
    net_pnl_pct:(equity-1)*100,max_drawdown_pct:maxDrawdown,
    sharpe_per_trade:sd>0?mean/sd:null,
    return_data_status:'COMPLETE',
    average_net_return_pct:mean
  };
}
function selectThreshold(rows,probabilities,roundTripCostBps,minimumTrades=20) {
  const grid=[0.40,0.45,0.50,0.55,0.60,0.65,0.70,0.75,0.80];
  const trials=grid.map(threshold=>portfolioMetrics(rows,probabilities,threshold,roundTripCostBps));
  const ready=trials.filter(item=>item.return_data_status==='COMPLETE'&&
    item.trade_count>=minimumTrades&&finite(item.net_pnl_pct));
  if(!ready.length)return {threshold:0.55,status:'ABSTAINED_NO_VALIDATION_RETURN_SUPPORT',trials};
  ready.sort((a,b)=>b.net_pnl_pct-a.net_pnl_pct||
    a.max_drawdown_pct-b.max_drawdown_pct||a.trade_count-b.trade_count);
  return {threshold:ready[0].threshold,status:'SELECTED_ON_VALIDATION_ONLY',trials,
    selected:ready[0]};
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
 * Evaluation consumes frozen out-of-sample predictions, not in-sample scores.
 * The model training jobs must emit one prediction for every validation and
 * holdout id. Missing/extra rows fail that family closed.
 */
export function runNeuralClosureBenchmark({
  rows:inputRows,
  predictionsByModel,
  sourceCommitSha,
  minimumClassSupport=NEURAL_CLOSURE_MIN_CLASS_SUPPORT,
  roundTripCostBps=30,
  minimumHoldoutTrades=100,
  minimumWinRatePct=55,
  maximumDrawdownPct=8,
  requiredBrierImprovement=NEURAL_CLOSURE_BRIER_MARGIN
}={}) {
  if(!/^[a-f0-9]{40}$/i.test(String(sourceCommitSha||'')))
    throw new Error('NEURAL_CLOSURE_FULL_SOURCE_SHA_REQUIRED');
  if(!predictionsByModel||typeof predictionsByModel!=='object')
    throw new TypeError('NEURAL_CLOSURE_PREDICTIONS_BY_MODEL_REQUIRED');
  const rows=validateFourHourRows(inputRows);
  const split=splitFourHourRows(rows);
  if(!split.train.length||!split.validation.length||!split.holdout.length)
    throw new Error('NEURAL_CLOSURE_EMPTY_SPLIT');
  const trainCounts=classCounts(split.train.map(row=>row.target));
  const validationCounts=classCounts(split.validation.map(row=>row.target));
  const holdoutCounts=classCounts(split.holdout.map(row=>row.target));
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
  const fixedBenchmarkSha=sha256Canonical({
    source_commit_sha:String(sourceCommitSha).toLowerCase(),
    dataset_sha256:datasetSha,row_count:rows.length,
    target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
    split_schema:split.schema,purge_ms:NEURAL_CLOSURE_PURGE_MS
  });
  const calibrationBlocks=chronologicalValidationBlocks(split.validation);
  const modelNames=['LOGISTIC_REGRESSION',...NEURAL_CLOSURE_MODEL_FAMILIES];
  const models={};
  for(const modelName of modelNames){
    const verified=predictionMap(predictionsByModel[modelName],modelName,requiredIds);
    if(!verified.valid){
      models[modelName]={
        status:'NOT_EVALUATED',reason:verified.reason,
        missing_count:verified.missing_count??null,
        extra_count:verified.extra_count??null
      };
      continue;
    }
    const rawMap=verified.map;
    const calibration=modelName==='LOGISTIC_REGRESSION'
      ?{status:'BASELINE_RAW',selected_method:'RAW_LOGISTIC_BASELINE',
        selected_calibrator:null,support_ready:true,
        minimum_positive_support_per_block:minimumClassSupport}
      :chooseCalibration(rawMap,calibrationBlocks.fit,calibrationBlocks.check,minimumClassSupport);
    const validationRows=calibrationBlocks.check;
    const rawValidation=probabilitiesFor(validationRows,rawMap);
    const calibratedValidation=probabilitiesFor(validationRows,rawMap,
      calibration.selected_calibrator);
    const validationLabels=validationRows.map(row=>row.target);
    const thresholdSelection=selectThreshold(validationRows,calibratedValidation,
      roundTripCostBps);
    const holdoutProbabilities=probabilitiesFor(split.holdout,rawMap,
      calibration.selected_calibrator);
    const metricWeights={
      positiveWeight:trainingWeights.positiveWeight,
      negativeWeight:trainingWeights.negativeWeight,
      gammaPositive:1,gammaNegative:2
    };
    const metrics=holdoutMetrics(split.holdout,holdoutProbabilities,
      thresholdSelection.threshold,roundTripCostBps,metricWeights);
    models[modelName]={
      status:'EVALUATED',
      calibration,
      validation:{
        sample_count:validationRows.length,
        positive_count:classCounts(validationLabels).positive,
        negative_count:classCounts(validationLabels).negative,
        raw_brier_score:brier(rawValidation,validationLabels),
        calibrated_brier_score:brier(calibratedValidation,validationLabels),
        threshold_selection:thresholdSelection.status,
        selected_threshold:thresholdSelection.threshold
      },
      holdout:metrics,
      training_loss_contract:{
        name:'FOCAL_ASYMMETRIC_BRIER',
        gamma_positive:1,gamma_negative:2,
        ...metricWeights,
        weights_derived_from:'TRAINING_PARTITION_ONLY'
      }
    };
  }
  const baseline=models.LOGISTIC_REGRESSION;
  for(const modelName of NEURAL_CLOSURE_MODEL_FAMILIES){
    const model=models[modelName];
    if(model.status!=='EVALUATED'||baseline?.status!=='EVALUATED'){
      model.acceptance={status:'NOT_EVALUATED',passed:false,
        reason:'SAME_COHORT_MODEL_OR_LOGISTIC_PREDICTIONS_MISSING'};
      continue;
    }
    const candidate=model.holdout,anchor=baseline.holdout;
    const improvement=anchor.brier_score-candidate.brier_score;
    const gates={
      minimum_holdout_positive_support:holdoutCounts.positive>=minimumClassSupport,
      calibration_class_support:model.calibration.support_ready===true,
      brier_improvement:improvement>requiredBrierImprovement,
      minimum_oos_trades:candidate.trade_count>=minimumHoldoutTrades,
      minimum_net_win_rate:finite(candidate.win_rate_pct)&&candidate.win_rate_pct>=minimumWinRatePct,
      positive_net_pnl:finite(candidate.net_pnl_pct)&&candidate.net_pnl_pct>0,
      maximum_drawdown:finite(candidate.max_drawdown_pct)&&candidate.max_drawdown_pct<=maximumDrawdownPct,
      beat_logistic_net_pnl:finite(candidate.net_pnl_pct)&&finite(anchor.net_pnl_pct)&&
        candidate.net_pnl_pct>anchor.net_pnl_pct,
      no_higher_drawdown_than_logistic:finite(candidate.max_drawdown_pct)&&
        finite(anchor.max_drawdown_pct)&&candidate.max_drawdown_pct<=anchor.max_drawdown_pct,
      return_data_complete:candidate.return_data_status==='COMPLETE'
    };
    model.acceptance={
      status:Object.values(gates).every(Boolean)?'PASS':'FAIL',
      passed:Object.values(gates).every(Boolean),
      brier_improvement:improvement,required_brier_improvement:requiredBrierImprovement,
      gates:Object.fromEntries(Object.entries(gates).map(([key,value])=>[key,value?'PASS':'FAIL']))
    };
  }
  return {
    schema:'RADARX_BUILD224_FIXED_SHA_NEURAL_CLOSURE_BENCHMARK_V1',
    status:NEURAL_CLOSURE_MODEL_FAMILIES.some(name=>models[name]?.acceptance?.passed)
      ?'NEURAL_SUPERIORITY_PROVEN':'NEURAL_SUPERIORITY_NOT_PROVEN',
    integrity:{
      source_commit_sha:String(sourceCommitSha).toLowerCase(),
      dataset_sha256:datasetSha,
      fixed_benchmark_sha256:fixedBenchmarkSha,
      row_count:rows.length,
      validation_plus_holdout_rows:eventRows.length,
      row_identity_sha256:sha256Canonical(requiredIds)
    },
    target:{
      definition:NEURAL_CLOSURE_TARGET_DEFINITION,
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
      calibration_fit_rows:calibrationBlocks.fit.length,
      calibration_check_rows:calibrationBlocks.check.length
    },
    policy:{
      round_trip_cost_bps:roundTripCostBps,
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
