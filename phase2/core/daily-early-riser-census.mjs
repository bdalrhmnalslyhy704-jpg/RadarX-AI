import {createHash} from 'node:crypto';
import {scoreAdaptiveTraderCandidate} from './adaptive-trader-engine.mjs';

export const DAILY_EARLY_RISER_OUTCOME_SOURCE =
  'BINANCE_OFFICIAL_CLOSED_15M_FIRST_PASSAGE_24H_V1';
export const DAILY_EARLY_RISER_TARGETS_PCT = Object.freeze([5,10,15]);
export const DAILY_EARLY_RISER_HORIZON_BARS = 96;
export const DAILY_EARLY_RISER_INTERVAL_MS = 15 * 60 * 1000;
export const DAILY_EARLY_RISER_DEFAULT_ADVERSE_PCT = 2;

const finite=value=>{
  if(value===null||value===undefined||value===''||typeof value==='boolean')return null;
  const number=Number(value);
  return Number.isFinite(number)?number:null;
};
const pct=(current,baseline)=>baseline>0?(current/baseline-1)*100:null;
const isLeveraged=symbol=>/(?:UP|DOWN|BULL|BEAR)USDT$/.test(String(symbol||'').toUpperCase());

function normalizeCandle(raw,intervalMs=DAILY_EARLY_RISER_INTERVAL_MS){
  if(Array.isArray(raw)){
    if(raw.length<11)return null;
    const values={
      openTime:finite(raw[0]),open:finite(raw[1]),high:finite(raw[2]),low:finite(raw[3]),
      close:finite(raw[4]),closeTime:finite(raw[6]),quoteVolume:finite(raw[7]),
      trades:finite(raw[8]),takerBuyQuoteVolume:finite(raw[10])
    };
    if(Object.values(values).some(value=>value===null)||
      values.openTime<=0||values.closeTime!==values.openTime+intervalMs-1||
      values.open<=0||values.low<=0||values.high<values.low||values.close<=0||
      values.high<Math.max(values.open,values.close)||values.low>Math.min(values.open,values.close)||
      values.quoteVolume<0||values.trades<0||values.takerBuyQuoteVolume<0||
      values.takerBuyQuoteVolume>values.quoteVolume*1.000001)return null;
    return values;
  }
  if(!raw||typeof raw!=='object')return null;
  const values={
    openTime:finite(raw.openTime),open:finite(raw.open),high:finite(raw.high),low:finite(raw.low),
    close:finite(raw.close),closeTime:finite(raw.closeTime),quoteVolume:finite(raw.quoteVolume),
    trades:finite(raw.trades),takerBuyQuoteVolume:finite(raw.takerBuyQuoteVolume)
  };
  if(Object.values(values).some(value=>value===null)||
    values.openTime<=0||values.closeTime!==values.openTime+intervalMs-1||
    values.open<=0||values.low<=0||values.high<values.low||values.close<=0||
    values.high<Math.max(values.open,values.close)||values.low>Math.min(values.open,values.close)||
    values.quoteVolume<0||values.trades<0||values.takerBuyQuoteVolume<0||
    values.takerBuyQuoteVolume>values.quoteVolume*1.000001)return null;
  return values;
}

function normalizedRows(rows,intervalMs){
  return (Array.isArray(rows)?rows:[]).map(raw=>normalizeCandle(raw,intervalMs))
    .filter(Boolean).sort((a,b)=>a.openTime-b.openTime);
}

function validateClosedPath(baseline,path,horizonBars){
  if(!baseline||!(baseline.close>0)||!Number.isFinite(baseline.closeTime))
    return {valid:false,reason:'BASELINE_CANDLE_INVALID'};
  if(!Array.isArray(path)||path.length!==horizonBars)
    return {valid:false,reason:'INCOMPLETE_24H_PATH',observed_bars:Array.isArray(path)?path.length:0};
  let expectedOpen=baseline.closeTime+1;
  for(let index=0;index<path.length;index++){
    const candle=path[index];
    if(!candle||![candle.openTime,candle.closeTime,candle.high,candle.low,candle.close].every(Number.isFinite))
      return {valid:false,reason:'INVALID_FUTURE_CANDLE',index};
    if(candle.openTime!==expectedOpen||candle.closeTime!==expectedOpen+DAILY_EARLY_RISER_INTERVAL_MS-1)
      return {valid:false,reason:'FUTURE_CANDLE_GAP_OR_BAD_CLOSE_TIME',index,
        expected_open_time:expectedOpen,observed_open_time:candle.openTime};
    if(!(candle.low>0)||candle.high<candle.low||candle.close<=0)
      return {valid:false,reason:'FUTURE_CANDLE_OHLC_INVALID',index};
    expectedOpen+=DAILY_EARLY_RISER_INTERVAL_MS;
  }
  return {valid:true,end_close_time:path.at(-1).closeTime};
}

/**
 * Conservative first-passage outcome for one positive target versus a downside
 * barrier over exactly 96 contiguous, already-closed 15m candles.
 *
 * A candle that touches both barriers is AMBIGUOUS: OHLC cannot tell which was
 * first. Missing/gapped data is INVALID, never FLAT or a successful label.
 */
export function classifyDailyEarlyRiserFirstPassage({
  baseline,future15m,targetPct,adversePct=DAILY_EARLY_RISER_DEFAULT_ADVERSE_PCT,
  horizonBars=DAILY_EARLY_RISER_HORIZON_BARS
}={}){
  const target=finite(targetPct),adverse=finite(adversePct);
  if(target===null||target<=0||adverse===null||adverse<=0)
    return {status:'INVALID',reason:'TARGET_OR_ADVERSE_PCT_INVALID'};
  if(!Number.isInteger(horizonBars)||horizonBars!==DAILY_EARLY_RISER_HORIZON_BARS)
    return {status:'INVALID',reason:'HORIZON_MUST_BE_96_CLOSED_15M_BARS'};
  const path=(Array.isArray(future15m)?future15m:[]).map(row=>normalizeCandle(row));
  const validation=validateClosedPath(baseline,path,horizonBars);
  if(!validation.valid)return {status:'INVALID',...validation,
    target_pct:target,adverse_pct:adverse,horizon_bars:horizonBars};
  const upLevel=baseline.close*(1+target/100);
  const downLevel=baseline.close*(1-adverse/100);
  const maxHigh=Math.max(baseline.close,...path.map(row=>row.high));
  const minLow=Math.min(baseline.close,...path.map(row=>row.low));
  let result=null;
  for(let index=0;index<path.length;index++){
    const candle=path[index];
    const upHit=candle.high>=upLevel;
    const downHit=candle.low<=downLevel;
    if(upHit&&downHit){
      result={
        status:'AMBIGUOUS',outcome:'AMBIGUOUS',
        reason:'TARGET_AND_ADVERSE_BARRIER_TOUCHED_IN_SAME_15M_CANDLE',
        first_touch_index:index,first_touch_at:candle.closeTime,
        time_to_first_touch_minutes:Number(((candle.closeTime-baseline.closeTime)/60000).toFixed(2)),
        target_level:upLevel,adverse_level:downLevel
      };
      break;
    }
    if(upHit){
      result={
        status:'RESOLVED',outcome:'UP',reason:'TARGET_REACHED_BEFORE_ADVERSE_BARRIER',
        first_touch_index:index,first_touch_at:candle.closeTime,
        time_to_first_touch_minutes:Number(((candle.closeTime-baseline.closeTime)/60000).toFixed(2)),
        first_touch_price_level:upLevel
      };
      break;
    }
    if(downHit){
      result={
        status:'RESOLVED',outcome:'DOWN',reason:'ADVERSE_BARRIER_REACHED_BEFORE_TARGET',
        first_touch_index:index,first_touch_at:candle.closeTime,
        time_to_first_touch_minutes:Number(((candle.closeTime-baseline.closeTime)/60000).toFixed(2)),
        first_touch_price_level:downLevel
      };
      break;
    }
  }
  if(!result)result={
    status:'RESOLVED',outcome:'FLAT',reason:'NEITHER_BARRIER_REACHED_WITHIN_24H',
    first_touch_index:null,first_touch_at:validation.end_close_time,
    time_to_first_touch_minutes:null
  };
  return {
    ...result,
    target_pct:target,adverse_pct:adverse,horizon_bars:horizonBars,
    horizon_ms:horizonBars*DAILY_EARLY_RISER_INTERVAL_MS,
    baseline_close_time:baseline.closeTime,
    resolved_at:validation.end_close_time,
    max_favorable_excursion_pct:Number(pct(maxHigh,baseline.close).toFixed(5)),
    max_adverse_excursion_pct:Number(pct(minLow,baseline.close).toFixed(5)),
    outcome_source:DAILY_EARLY_RISER_OUTCOME_SOURCE,
    target_definition:'FIRST_PASSAGE_PLUS_'+target+'_PCT_BEFORE_MINUS_'+adverse+'_PCT_24H_15M_V1'
  };
}

export function classifyDailyEarlyRiserTargetSet({
  baseline,future15m,targetsPct=DAILY_EARLY_RISER_TARGETS_PCT,
  adversePct=DAILY_EARLY_RISER_DEFAULT_ADVERSE_PCT
}={}){
  const targets=[...new Set((Array.isArray(targetsPct)?targetsPct:[])
    .map(finite).filter(value=>value!==null&&value>0))].sort((a,b)=>a-b);
  if(!targets.length)return {status:'INVALID',reason:'NO_VALID_DAILY_TARGETS',targets:{}};
  const outcomes={};
  for(const target of targets){
    outcomes['plus_'+String(target).replace('.','_')+'_pct']=
      classifyDailyEarlyRiserFirstPassage({baseline,future15m,targetPct:target,adversePct});
  }
  return {status:Object.values(outcomes).every(row=>row.status==='RESOLVED')?'RESOLVED':'PARTIAL',
    outcome_source:DAILY_EARLY_RISER_OUTCOME_SOURCE,targets:outcomes};
}

function stableSymbolPhase(symbol,stride){
  const digest=createHash('sha256').update(String(symbol)).digest();
  return digest.readUInt32BE(0)%stride;
}

/**
 * Build one non-overlapping 24h training/audit anchor per symbol per day.
 * Features are scored at the baseline using only candles closed at or before
 * that baseline; labels are read from the following 96 closed 15m bars.
 */
export function buildDailyEarlyRiserHistoricalSamples({
  symbol,klines,fastKlines=null,btcKlines=null,now=Date.now(),
  minQuoteVolume24h=750000,targetsPct=DAILY_EARLY_RISER_TARGETS_PCT,
  adversePct=DAILY_EARLY_RISER_DEFAULT_ADVERSE_PCT,
  maxSamplesPerSymbol=500,sampleStrideBars=DAILY_EARLY_RISER_HORIZON_BARS
}={}){
  const cleanSymbol=String(symbol||'').trim().toUpperCase();
  if(!/^[A-Z0-9]{5,30}$/.test(cleanSymbol)||!cleanSymbol.endsWith('USDT')||isLeveraged(cleanSymbol))
    return {samples:[],audit:{status:'SYMBOL_REJECTED',reason:'SPOT_USDT_DIRECTIONAL_SYMBOL_REQUIRED'}};
  if(sampleStrideBars!==DAILY_EARLY_RISER_HORIZON_BARS)
    return {samples:[],audit:{status:'INVALID_POLICY',reason:'DAILY_ANCHORS_MUST_NOT_OVERLAP_24H_LABELS'}};
  const end=finite(now);
  if(end===null||end<=0)return {samples:[],audit:{status:'INVALID_POLICY',reason:'NOW_INVALID'}};
  const raw15m=Array.isArray(klines?.data)?klines.data:Array.isArray(klines)?klines:[];
  const rawFast=Array.isArray(fastKlines?.data)?fastKlines.data:Array.isArray(fastKlines)?fastKlines:[];
  const rawBtc=Array.isArray(btcKlines?.data)?btcKlines.data:Array.isArray(btcKlines)?btcKlines:[];
  const candles=normalizedRows(raw15m,DAILY_EARLY_RISER_INTERVAL_MS).filter(row=>row.closeTime<end);
  const fast=normalizedRows(rawFast,5*60*1000).filter(row=>row.closeTime<end);
  const btc=normalizedRows(rawBtc,DAILY_EARLY_RISER_INTERVAL_MS).filter(row=>row.closeTime<end);
  const rawCloseTime=row=>finite(Array.isArray(row)?row[6]:row?.closeTime);
  const ordered15m=raw15m.filter(row=>rawCloseTime(row)!==null&&rawCloseTime(row)<end)
    .slice().sort((x,y)=>Number(Array.isArray(x)?x[0]:x.openTime)-Number(Array.isArray(y)?y[0]:y.openTime));
  const orderedFast=rawFast.filter(row=>rawCloseTime(row)!==null&&rawCloseTime(row)<end)
    .slice().sort((x,y)=>Number(Array.isArray(x)?x[0]:x.openTime)-Number(Array.isArray(y)?y[0]:y.openTime));
  const orderedBtc=rawBtc.filter(row=>rawCloseTime(row)!==null&&rawCloseTime(row)<end)
    .slice().sort((x,y)=>Number(Array.isArray(x)?x[0]:x.openTime)-Number(Array.isArray(y)?y[0]:y.openTime));
  const minVolume=Math.max(0,finite(minQuoteVolume24h)??750000);
  const targets=[...new Set((Array.isArray(targetsPct)?targetsPct:[])
    .map(finite).filter(value=>value!==null&&value>0))].sort((a,b)=>a-b);
  if(!targets.length)return {samples:[],audit:{status:'INVALID_POLICY',reason:'NO_VALID_DAILY_TARGETS'}};
  const phase=stableSymbolPhase(cleanSymbol,sampleStrideBars);
  const quota=Math.max(1,Math.min(2000,Math.trunc(finite(maxSamplesPerSymbol)??500)));
  const possible=[];
  let rejectedHistoricalGaps=0,rejectedVolume=0,rejectedFuturePaths=0,rejectedFeatureRows=0;
  const rejectedFeatureReasonCounts={};
  const rejectedFeatureExamples=[];
  const btcByClose=new Map(btc.map(row=>[row.closeTime,row]));
  let fastCursor=-1,btcCursor=-1;
  for(let index=119;index+DAILY_EARLY_RISER_HORIZON_BARS<candles.length;index++){
    const baseline=candles[index];
    const absoluteBar=Math.floor((baseline.closeTime+1)/DAILY_EARLY_RISER_INTERVAL_MS);
    if(absoluteBar%sampleStrideBars!==phase)continue;
    const context=candles.slice(index-95,index+1);
    const future=candles.slice(index+1,index+1+DAILY_EARLY_RISER_HORIZON_BARS);
    if(context.length!==96||context.some((row,offset)=>
      offset>0&&row.openTime-context[offset-1].openTime!==DAILY_EARLY_RISER_INTERVAL_MS)){
      rejectedHistoricalGaps++;continue;
    }
    const volume24h=context.reduce((sum,row)=>sum+row.quoteVolume,0);
    if(volume24h<minVolume){rejectedVolume++;continue;}
    const targetSet=classifyDailyEarlyRiserTargetSet({baseline,future15m:future,
      targetsPct:targets,adversePct});
    if(Object.values(targetSet.targets).some(row=>row.status==='INVALID')){
      rejectedFuturePaths++;continue;
    }
    const baselineOpen=baseline.openTime;
    const evaluationNow=baseline.closeTime+1;
    // Compare closes exactly 96 x 15m bars apart for a true 24h return.
    const prior24h=candles[index-96];
    const btcDailyPrior=btcByClose.get(prior24h.closeTime);
    const btcDailyCurrent=btcByClose.get(baseline.closeTime);
    const btcDailyReturn=btcDailyPrior&&btcDailyCurrent
      ?pct(btcDailyCurrent.close,btcDailyPrior.close):null;
    const assetDailyReturn=pct(baseline.close,prior24h.close);
    if(assetDailyReturn===null){rejectedFeatureRows++;continue;}
    while(fastCursor+1<orderedFast.length&&rawCloseTime(orderedFast[fastCursor+1])<=baseline.closeTime)fastCursor++;
    while(btcCursor+1<orderedBtc.length&&rawCloseTime(orderedBtc[btcCursor+1])<=baseline.closeTime)btcCursor++;
    const base15m=ordered15m.slice(Math.max(0,index-119),index+1);
    const baseFast=orderedFast.slice(Math.max(0,fastCursor-719),fastCursor+1);
    const baseBtc=orderedBtc.slice(Math.max(0,btcCursor-999),btcCursor+1);
    const ticker={
      symbol:cleanSymbol,lastPrice:String(baseline.close),quoteVolume:String(volume24h),
      priceChangePercent:String(assetDailyReturn)
    };
    const featureCandidate=scoreAdaptiveTraderCandidate({
      symbol:cleanSymbol,ticker,
      klines:{data:base15m,source:klines?.source||'BINANCE_OFFICIAL_ARCHIVE',receivedAt:evaluationNow},
      fastKlines:{data:baseFast,source:fastKlines?.source||'BINANCE_OFFICIAL_ARCHIVE',receivedAt:evaluationNow},
      btcKlines:{data:baseBtc,source:btcKlines?.source||'BINANCE_OFFICIAL_ARCHIVE',receivedAt:evaluationNow},
      now:evaluationNow,minQuoteVolume24h:minVolume
    });
    if(featureCandidate.data_valid!==true||featureCandidate.data_stale===true||
      !featureCandidate.features||!Number.isFinite(Number(featureCandidate.score))){
      rejectedFeatureRows++;
      const reasons=Array.isArray(featureCandidate.reason_codes)&&featureCandidate.reason_codes.length
        ?featureCandidate.reason_codes
        :[featureCandidate.data_stale===true?'FEATURE_CANDIDATE_STALE':
          featureCandidate.data_valid!==true?'FEATURE_CANDIDATE_DATA_INVALID':
          !featureCandidate.features?'FEATURE_VECTOR_MISSING':
          'FEATURE_SCORE_NON_FINITE'];
      for(const reason of reasons)rejectedFeatureReasonCounts[reason]=(rejectedFeatureReasonCounts[reason]||0)+1;
      if(rejectedFeatureExamples.length<8)rejectedFeatureExamples.push({
        at:baseline.closeTime,baseline_index:index,
        data_valid:featureCandidate.data_valid===true,data_stale:featureCandidate.data_stale===true,
        score:finite(featureCandidate.score),reason_codes:reasons,
        candle_age_ms:finite(featureCandidate.candle_age_ms),
        input_counts:{15m:base15m.length,5m:baseFast.length,btc_15m:baseBtc.length}
      });
      continue;
    }
    possible.push({
      id:'DAILY_EARLY_RISER_24H:'+cleanSymbol+':'+String(baseline.closeTime),
      symbol:cleanSymbol,at:baseline.closeTime,at_utc:new Date(baseline.closeTime).toISOString(),
      baseline_open_time:baselineOpen,baseline_price:baseline.close,
      quote_volume_24h:Number(volume24h.toFixed(2)),
      daily_change_pct:Number(assetDailyReturn.toFixed(5)),
      relative_strength_vs_btc_24h_pct:btcDailyReturn===null?null:
        Number((assetDailyReturn-btcDailyReturn).toFixed(5)),
      base_score:Number(featureCandidate.score),tier:String(featureCandidate.tier||'NO_SETUP'),
      features:featureCandidate.features,
      temporal_sequence:featureCandidate.temporal_sequence||null,
      temporal_sequence_available:Array.isArray(featureCandidate.temporal_sequence),
      observation_source:'BINANCE_OFFICIAL_CLOSED_15M_BASELINE',
      feature_information_cutoff_at:baseline.closeTime,
      outcome_source:DAILY_EARLY_RISER_OUTCOME_SOURCE,
      target_definition_version:'MULTI_TARGET_FIRST_PASSAGE_24H_V1',
      targets:targetSet.targets
    });
  }
  possible.sort((a,b)=>a.at-b.at);
  let selected=possible;
  if(possible.length>quota){
    selected=[];
    for(let slot=0;slot<quota;slot++){
      const index=quota===1?Math.floor((possible.length-1)/2):
        Math.round(slot*(possible.length-1)/(quota-1));
      selected.push(possible[index]);
    }
  }
  let overlapViolations=0;
  for(let index=1;index<selected.length;index++){
    if(selected[index].at-selected[index-1].at<24*60*60*1000)overlapViolations++;
  }
  return {
    samples:selected,
    audit:{
      status:overlapViolations===0?'READY':'INVALID_OVERLAPPING_ANCHORS',
      symbol:cleanSymbol,observed_15m_candles:candles.length,
      daily_anchor_stride_bars:sampleStrideBars,
      daily_anchor_phase:phase,eligible_anchor_candidates:possible.length,
      emitted_samples:selected.length,maximum_samples_per_symbol:quota,
      non_overlapping_24h_labels:overlapViolations===0,
      overlap_violations:overlapViolations,
      rejected_historical_gaps:rejectedHistoricalGaps,
      rejected_low_quote_volume:rejectedVolume,
      rejected_incomplete_future_paths:rejectedFuturePaths,
      rejected_invalid_feature_rows:rejectedFeatureRows,
      rejected_feature_reason_counts:Object.fromEntries(
        Object.entries(rejectedFeatureReasonCounts).sort((a,b)=>a[0].localeCompare(b[0]))),
      rejected_feature_examples:rejectedFeatureExamples,
      min_quote_volume_24h:minVolume,
      targets_pct:targets,adverse_pct:adversePct,
      horizon_bars:DAILY_EARLY_RISER_HORIZON_BARS,
      future_target_outcomes:Object.fromEntries(targets.map(target=>{
        const key='plus_'+String(target).replace('.','_')+'_pct';
        const counts={UP:0,DOWN:0,FLAT:0,AMBIGUOUS:0,INVALID:0};
        for(const row of selected)counts[row.targets[key]?.outcome||'INVALID']++;
        return [key,counts];
      }))
    }
  };
}
