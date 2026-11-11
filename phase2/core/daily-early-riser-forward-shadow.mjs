import {createHash} from 'node:crypto';
import {
  classifyDailyEarlyRiserFirstPassage,
  DAILY_EARLY_RISER_OUTCOME_SOURCE,
  DAILY_EARLY_RISER_HORIZON_BARS,
  DAILY_EARLY_RISER_INTERVAL_MS,
  DAILY_EARLY_RISER_TARGETS_PCT
} from './daily-early-riser-census.mjs';

export const DAILY_FORWARD_SHADOW_SCHEMA='RADARX_DAILY_FORWARD_SHADOW_V1';
export const DAILY_FORWARD_SHADOW_MODEL_MLP='DAILY_MLP_CHALLENGER_V1';
export const DAILY_FORWARD_SHADOW_MODEL_LOGISTIC='SAME_WINDOW_LOGISTIC_BASELINE_V1';
export const DAILY_FORWARD_SHADOW_REQUIRED_BRIER_GAIN=0.003;
export const DAILY_FORWARD_SHADOW_MINIMUM_PAIRED_SAMPLES=150;
const HORIZON_MS=DAILY_EARLY_RISER_HORIZON_BARS*DAILY_EARLY_RISER_INTERVAL_MS;

const finite=value=>{
  if(value===null||value===undefined||value===''||typeof value==='boolean')return null;
  const number=Number(value);
  return Number.isFinite(number)?number:null;
};
const isSha256=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const cleanSymbol=value=>String(value||'').trim().toUpperCase();
const targetDefinition=target=>'FIRST_PASSAGE_PLUS_'+target+'_PCT_BEFORE_MINUS_2_PCT_24H_15M_V1';

function stableStringify(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(stableStringify).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stableStringify(value[key])).join(',')+'}';
}
function sha256(value){
  return createHash('sha256').update(String(value)).digest('hex');
}
function validBaseline(baseline,at){
  if(!baseline||typeof baseline!=='object'||Array.isArray(baseline))return false;
  const fields=['openTime','open','high','low','close','closeTime','quoteVolume','trades','takerBuyQuoteVolume'];
  const row=Object.fromEntries(fields.map(key=>[key,finite(baseline[key])]));
  if(Object.values(row).some(value=>value===null))return false;
  return row.openTime>0&&row.closeTime===at&&
    row.closeTime===row.openTime+DAILY_EARLY_RISER_INTERVAL_MS-1&&
    row.open>0&&row.low>0&&row.close>0&&row.high>=Math.max(row.open,row.close)&&
    row.low<=Math.min(row.open,row.close)&&row.quoteVolume>=0&&row.trades>=0&&
    row.takerBuyQuoteVolume>=0&&row.takerBuyQuoteVolume<=row.quoteVolume*1.000001;
}
function normalizedProbability(value){
  const probability=finite(value);
  return probability!==null&&probability>=0&&probability<=1?probability:null;
}
function loss(probability,target){
  return (probability-target)**2;
}

/**
 * Build paired immutable forecasts for one symbol, closed baseline candle and
 * target. The neural and same-window logistic probabilities are captured
 * together, so both models are evaluated on exactly the same future event.
 */
export function createDailyEarlyRiserForwardForecastPair({
  symbol,target_pct,at,feature_information_cutoff_at,recorded_at,trained_through_at,
  observation_source='BINANCE_OFFICIAL_CLOSED_15M_BASELINE',
  baseline,features,model_bundle_sha256,mlp_model_sha256,logistic_model_sha256,
  mlp_up_probability,logistic_up_probability
}={}){
  const clean=cleanSymbol(symbol);
  const target=finite(target_pct),time=finite(at),cutoff=finite(feature_information_cutoff_at);
  const recorded=finite(recorded_at),trainedThrough=finite(trained_through_at);
  const mlp=normalizedProbability(mlp_up_probability),logistic=normalizedProbability(logistic_up_probability);
  if(!/^[A-Z0-9]{2,24}USDT$/.test(clean)||/(?:UP|DOWN|BULL|BEAR)USDT$/.test(clean))
    throw new Error('FORWARD_SHADOW_SPOT_USDT_SYMBOL_INVALID');
  if(target===null||!DAILY_EARLY_RISER_TARGETS_PCT.includes(target))
    throw new Error('FORWARD_SHADOW_TARGET_INVALID');
  if(time===null||cutoff!==time||!validBaseline(baseline,time))
    throw new Error('FORWARD_SHADOW_BASELINE_OR_FEATURE_CUTOFF_INVALID');
  if(recorded===null||recorded<=time)
    throw new Error('FORWARD_SHADOW_FORECAST_MUST_FOLLOW_CLOSED_BASELINE');
  if(trainedThrough===null||trainedThrough>=time)
    throw new Error('FORWARD_SHADOW_MODEL_TRAINING_CUTOFF_NOT_BEFORE_FORECAST');
  if(observation_source!=='BINANCE_OFFICIAL_CLOSED_15M_BASELINE')
    throw new Error('FORWARD_SHADOW_BASELINE_SOURCE_UNVERIFIED');
  if(!features||typeof features!=='object'||Array.isArray(features))
    throw new Error('FORWARD_SHADOW_FEATURE_SNAPSHOT_INVALID');
  if(!isSha256(model_bundle_sha256)||!isSha256(mlp_model_sha256)||!isSha256(logistic_model_sha256))
    throw new Error('FORWARD_SHADOW_MODEL_SHA256_INVALID');
  if(mlp===null||logistic===null)throw new Error('FORWARD_SHADOW_PROBABILITY_OUT_OF_RANGE');

  const featureSnapshotSha256=sha256(stableStringify(features));
  const pairId=sha256([
    DAILY_FORWARD_SHADOW_SCHEMA,clean,target,time,model_bundle_sha256,
    mlp_model_sha256,logistic_model_sha256,featureSnapshotSha256
  ].join('|'));
  const common={
    schema:DAILY_FORWARD_SHADOW_SCHEMA,
    pair_id:pairId,
    model_bundle_sha256:model_bundle_sha256.toLowerCase(),
    symbol:clean,target_pct:target,target_definition:targetDefinition(target),
    at:time,feature_information_cutoff_at:cutoff,recorded_at:recorded,
    trained_through_at:trainedThrough,observation_source,
    baseline_candle:{...baseline},
    feature_snapshot_sha256:featureSnapshotSha256,
    outcome_source:DAILY_EARLY_RISER_OUTCOME_SOURCE,
    horizon_bars:DAILY_EARLY_RISER_HORIZON_BARS,
    horizon_ms:HORIZON_MS,
    status:'PENDING',
    outcome:null,resolved_at:null,resolution_reason:null
  };
  const make=(model_variant,model_sha256,probability)=>({
    ...common,
    forecast_id:sha256(pairId+'|'+model_variant+'|'+model_sha256),
    model_variant,model_sha256:model_sha256.toLowerCase(),
    up_probability:probability
  });
  return [
    make(DAILY_FORWARD_SHADOW_MODEL_MLP,mlp_model_sha256,mlp),
    make(DAILY_FORWARD_SHADOW_MODEL_LOGISTIC,logistic_model_sha256,logistic)
  ];
}

/**
 * Resolve only after all 96 future 15m candles are closed and contiguous.
 * A missing/gapped path is retryable, never relabelled as FLAT.
 */
export function resolveDailyEarlyRiserForwardForecast(forecast,{
  future15m,recorded_at
}={}){
  if(!forecast||forecast.schema!==DAILY_FORWARD_SHADOW_SCHEMA||
    forecast.status!=='PENDING'||!isSha256(forecast.forecast_id)||
    !isSha256(forecast.pair_id))return {accepted:false,reason:'FORWARD_SHADOW_FORECAST_INVALID'};
  const at=finite(forecast.at),recorded=finite(recorded_at);
  if(at===null||recorded===null)return {accepted:false,reason:'FORWARD_SHADOW_RESOLUTION_TIME_INVALID'};
  const result=classifyDailyEarlyRiserFirstPassage({
    baseline:forecast.baseline_candle,future15m,targetPct:forecast.target_pct,
    adversePct:2,horizonBars:DAILY_EARLY_RISER_HORIZON_BARS
  });
  if(result.status==='INVALID')
    return {accepted:false,reason:result.reason||'FORWARD_SHADOW_PATH_INVALID',
      observed_bars:result.observed_bars??null};
  if(recorded<result.resolved_at)
    return {accepted:false,reason:'FORWARD_SHADOW_OUTCOME_NOT_YET_CLOSED'};
  return {
    accepted:true,
    forecast:{
      ...forecast,
      status:result.status==='RESOLVED'?'RESOLVED':'AMBIGUOUS',
      outcome:result.outcome,
      resolved_at:result.resolved_at,
      resolution_recorded_at:recorded,
      resolution_reason:result.reason,
      outcome_source:result.outcome_source,
      first_touch_at:result.first_touch_at??null,
      max_favorable_excursion_pct:result.max_favorable_excursion_pct??null,
      max_adverse_excursion_pct:result.max_adverse_excursion_pct??null
    },
    resolution:result
  };
}

function summarizeScores(pairs){
  if(!pairs.length)return {sample_count:0,mlp_brier:null,logistic_brier:null,brier_gain:null,
    gain_standard_error:null,gain_95pct_lower_bound:null};
  const mlpLosses=pairs.map(row=>loss(row.mlp.up_probability,row.target));
  const logisticLosses=pairs.map(row=>loss(row.logistic.up_probability,row.target));
  const gains=logisticLosses.map((value,index)=>value-mlpLosses[index]);
  const avg=values=>values.reduce((sum,value)=>sum+value,0)/values.length;
  const gain=avg(gains);
  const variance=gains.length>1
    ?gains.reduce((sum,value)=>sum+(value-gain)**2,0)/(gains.length-1):0;
  const standardError=Math.sqrt(variance/gains.length);
  return {
    sample_count:pairs.length,
    mlp_brier:Number(avg(mlpLosses).toFixed(8)),
    logistic_brier:Number(avg(logisticLosses).toFixed(8)),
    brier_gain:Number(gain.toFixed(8)),
    gain_standard_error:Number(standardError.toFixed(8)),
    gain_95pct_lower_bound:Number((gain-1.96*standardError).toFixed(8))
  };
}

/**
 * Paired prequential score. Only forecasts recorded before their outcomes
 * matured count. The forward gate requires >=0.003 Brier gain over the paired
 * logistic reference and at least 150 resolved pairs.
 */
export function scoreDailyEarlyRiserForwardShadow(rows,{
  target_pct,model_bundle_sha256,
  minimum_paired_samples=DAILY_FORWARD_SHADOW_MINIMUM_PAIRED_SAMPLES,
  required_brier_gain=DAILY_FORWARD_SHADOW_REQUIRED_BRIER_GAIN,
  recent_window_size=80
}={}){
  const target=finite(target_pct);
  const minimum=Math.max(1,Math.trunc(finite(minimum_paired_samples)??DAILY_FORWARD_SHADOW_MINIMUM_PAIRED_SAMPLES));
  const requiredGain=finite(required_brier_gain);
  if(target===null||!DAILY_EARLY_RISER_TARGETS_PCT.includes(target)||
    !isSha256(model_bundle_sha256)||requiredGain===null||requiredGain<DAILY_FORWARD_SHADOW_REQUIRED_BRIER_GAIN)
    throw new Error('FORWARD_SHADOW_SCORE_CONFIGURATION_INVALID');
  const records=Array.isArray(rows)?rows:[];
  const byPair=new Map(),seenIds=new Set(),duplicatePairIds=new Set();
  let duplicateForecastIds=0,invalidRecords=0,ambiguousRecords=0;
  for(const row of records){
    if(!row||row.schema!==DAILY_FORWARD_SHADOW_SCHEMA||row.target_pct!==target||
      row.model_bundle_sha256!==model_bundle_sha256.toLowerCase())continue;
    if(row.status==='AMBIGUOUS'||row.status==='PENDING'){
      ambiguousRecords++;continue;
    }
    if(row.status!=='RESOLVED')continue;
    if(!isSha256(row.forecast_id)||seenIds.has(row.forecast_id)){
      duplicateForecastIds++;continue;
    }
    seenIds.add(row.forecast_id);
    const at=finite(row.at),resolvedAt=finite(row.resolved_at);
    if(!isSha256(row.pair_id)||!['UP','DOWN','FLAT'].includes(row.outcome)||
      row.target_definition!==targetDefinition(target)||
      row.outcome_source!==DAILY_EARLY_RISER_OUTCOME_SOURCE||
      at===null||resolvedAt===null||resolvedAt-at!==HORIZON_MS||
      finite(row.recorded_at)===null||Number(row.recorded_at)>=resolvedAt||
      finite(row.trained_through_at)===null||Number(row.trained_through_at)>=at||
      row.feature_information_cutoff_at!==row.at||
      !isSha256(row.feature_snapshot_sha256)||!isSha256(row.model_sha256)||
      normalizedProbability(row.up_probability)===null){
      invalidRecords++;continue;
    }
    if(!byPair.has(row.pair_id))byPair.set(row.pair_id,[]);
    byPair.get(row.pair_id).push(row);
  }
  const pairs=[];
  for(const group of byPair.values()){
    if(group.length!==2){invalidRecords+=group.length;continue;}
    const mlp=group.find(row=>row.model_variant===DAILY_FORWARD_SHADOW_MODEL_MLP);
    const logistic=group.find(row=>row.model_variant===DAILY_FORWARD_SHADOW_MODEL_LOGISTIC);
    if(!mlp||!logistic||mlp.forecast_id===logistic.forecast_id||
      mlp.outcome!==logistic.outcome||mlp.symbol!==logistic.symbol||
      mlp.at!==logistic.at||mlp.target_pct!==logistic.target_pct||
      mlp.feature_snapshot_sha256!==logistic.feature_snapshot_sha256||
      mlp.trained_through_at!==logistic.trained_through_at||
      mlp.resolved_at!==logistic.resolved_at){
      invalidRecords+=group.length;continue;
    }
    pairs.push({pair_id:mlp.pair_id,symbol:mlp.symbol,at:mlp.at,
      target:mlp.outcome==='UP'?1:0,mlp,logistic});
  }
  pairs.sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol)||a.pair_id.localeCompare(b.pair_id));
  const overall=summarizeScores(pairs);
  const recentCount=Math.max(10,Math.trunc(finite(recent_window_size)??80));
  const recentPairs=pairs.slice(-recentCount);
  const previousPairs=pairs.slice(Math.max(0,pairs.length-2*recentCount),
    Math.max(0,pairs.length-recentCount));
  const recent=summarizeScores(recentPairs),previous=summarizeScores(previousPairs);
  const enough=pairs.length>=minimum;
  const passed=enough&&overall.brier_gain>=requiredGain&&
    overall.gain_95pct_lower_bound>0&&overall.mlp_brier<overall.logistic_brier;
  return {
    schema:DAILY_FORWARD_SHADOW_SCHEMA,
    method:'IMMUTABLE_PAIRED_DAILY_FORWARD_PREQUENTIAL_BRIER_V1',
    status:!enough?'INSUFFICIENT_FORWARD_PAIRED_OUTCOMES':
      passed?'FORWARD_SHADOW_BRIER_GATE_PASSED':'FORWARD_SHADOW_DID_NOT_BEAT_LOGISTIC',
    target_pct:target,model_bundle_sha256:model_bundle_sha256.toLowerCase(),
    required_brier_gain:requiredGain,minimum_paired_samples:minimum,
    paired_resolved_samples:pairs.length,
    excluded_duplicate_forecast_ids:duplicateForecastIds,
    excluded_invalid_records:invalidRecords,
    excluded_ambiguous_or_pending_records:ambiguousRecords,
    overall,recent,previous,passed,
    production_eligible:false,real_order_execution:false,
    note:'Research-only paired forecasts; this gate does not authorize live orders or replace net-fee/slippage profitability and drawdown validation.'
  };
}
