import {
  NEURAL_CLOSURE_HORIZON_MS,NEURAL_CLOSURE_TARGET_DEFINITION,
  NEURAL_CLOSURE_TARGET_SEMANTICS,NEURAL_CLOSURE_OUTCOME_SOURCE,
  NEURAL_CLOSURE_EXECUTION_RETURN_CONTRACT,buildFourHourFirstTouchOutcome,
  sha256Canonical
} from './neural-closure-contracts.mjs';
import {
  buildHybridSequence,HYBRID_CANDLE_INTERVAL_MS
} from './hybrid-tcn-attention-benchmark.mjs';
import {
  buildCognitiveFeatureVector,COGNITIVE_FEATURE_SCHEMA,COGNITIVE_FEATURE_NAMES
} from './cognitive-brain.mjs';

const MINUTE_MS=60_000;
const FIVE_MINUTES_MS=5*MINUTE_MS;
const FIFTEEN_MINUTES_MS=15*MINUTE_MS;
const FOUR_HOURS_MS=NEURAL_CLOSURE_HORIZON_MS;
const DAY_MS=24*60*MINUTE_MS;
const DECISION_OFFSET_MS=FIFTEEN_MINUTES_MS-1;
const SOURCE='BINANCE_PUBLIC_REST';
const finite=value=>value!==null&&value!==undefined&&value!==''&&
  typeof value!=='boolean'&&Number.isFinite(Number(value));
const num=value=>finite(value)?Number(value):null;
const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const std=values=>{
  if(!values.length)return null;
  const average=mean(values);
  return Math.sqrt(mean(values.map(value=>(value-average)**2)));
};
const candleCloseTime=candle=>num(candle?.closeTime??candle?.close_time);
const candleOpenTime=candle=>num(candle?.openTime??candle?.open_time);
const quoteVolume=candle=>num(candle?.quoteVolume??candle?.quote_volume);
const tradeCount=candle=>num(candle?.numberOfTrades??candle?.tradeCount??candle?.trade_count);
const pct=(current,previous)=>current>0&&previous>0?(current/previous-1)*100:null;
const log2=value=>Math.log(Math.max(0.05,value))/Math.LN2;

export const NEURAL_CLOSURE_DATASET_SCHEMA=
  'RADARX_BUILD224_BINANCE_SPOT_4H_FIRST_TOUCH_DATASET_V2';
export const NEURAL_CLOSURE_DATASET_INTERVALS=Object.freeze({
  label:'1m',micro:'5m',features:'15m'
});

/** Parse the public Binance Spot kline tuple without filling missing fields. */
export function parseBinanceSpotKline(raw,{serverTime,intervalMs}={}) {
  if(!Array.isArray(raw)||raw.length<12)
    throw new TypeError('BINANCE_KLINE_TUPLE_INVALID');
  const values={
    openTime:num(raw[0]),open:num(raw[1]),high:num(raw[2]),low:num(raw[3]),
    close:num(raw[4]),volume:num(raw[5]),closeTime:num(raw[6]),
    quoteVolume:num(raw[7]),numberOfTrades:num(raw[8]),
    takerBuyBaseVolume:num(raw[9]),takerBuyQuoteVolume:num(raw[10])
  };
  if(Object.values(values).some(value=>value===null)||
    !Number.isInteger(values.openTime)||!Number.isInteger(values.closeTime)||
    values.open<=0||values.high<=0||values.low<=0||values.close<=0||
    values.volume<0||values.quoteVolume<0||values.numberOfTrades<0||
    values.high<Math.max(values.open,values.close,values.low)||
    values.low>Math.min(values.open,values.close)||
    values.closeTime!==values.openTime+Number(intervalMs)-1)
    throw new Error('BINANCE_KLINE_OHLCV_OR_TIME_INVALID');
  const closed=finite(serverTime)&&values.closeTime<Number(serverTime);
  return {
    ...values,
    open_time:values.openTime,close_time:values.closeTime,
    quote_volume:values.quoteVolume,trade_count:values.numberOfTrades,
    taker_buy_quote_volume:values.takerBuyQuoteVolume,
    is_closed:closed===true,closed:closed===true,
    source:SOURCE
  };
}

/** Build 4h-spaced decisions on closed 15m boundaries, all with matured labels. */
export function createNeuralClosureDecisionSchedule({serverTime,days=60}={}) {
  const now=num(serverTime),durationDays=num(days);
  if(now===null||now<=0||durationDays===null||
    !Number.isInteger(durationDays)||durationDays<60||durationDays>180)
    throw new TypeError('NEURAL_CLOSURE_SCHEDULE_ARGUMENTS_INVALID');
  const decisionsPerDay=DAY_MS/FOUR_HOURS_MS;
  const decisionCount=durationDays*decisionsPerDay;
  const endAt=Math.floor((now-FOUR_HOURS_MS-DECISION_OFFSET_MS)/FOUR_HOURS_MS)*
    FOUR_HOURS_MS+DECISION_OFFSET_MS;
  const startAt=endAt-(decisionCount-1)*FOUR_HOURS_MS;
  const decisionTimes=Array.from({length:decisionCount},(_,index)=>
    startAt+index*FOUR_HOURS_MS);
  return {
    days:durationDays,decision_count:decisionCount,
    first_decision_at:startAt,last_decision_at:endAt,
    decision_interval_ms:FOUR_HOURS_MS,
    decision_times:decisionTimes,
    one_minute_start_open_at:startAt+1,
    one_minute_end_open_at:endAt+FOUR_HOURS_MS-MINUTE_MS+1,
    five_minute_start_open_at:startAt-23*FIVE_MINUTES_MS-FIVE_MINUTES_MS+1,
    five_minute_end_open_at:endAt-FIVE_MINUTES_MS+1,
    fifteen_minute_start_open_at:startAt-23*FIFTEEN_MINUTES_MS-FIFTEEN_MINUTES_MS+1,
    fifteen_minute_end_open_at:endAt-FIFTEEN_MINUTES_MS+1,
    required_unique_utc_days:durationDays
  };
}

function lastClosedWindow(candles,decisionAt,count,intervalMs) {
  const eligible=candles.filter(candle=>candle.closed===true&&
    candleCloseTime(candle)<=decisionAt)
    .sort((a,b)=>candleCloseTime(a)-candleCloseTime(b));
  const selected=eligible.slice(-count);
  if(selected.length!==count||candleCloseTime(selected.at(-1))!==decisionAt)
    return null;
  for(let index=1;index<selected.length;index++)
    if(candleCloseTime(selected[index])-candleCloseTime(selected[index-1])!==intervalMs)
      return null;
  return selected;
}
function returnsFrom(candles) {
  const output=[];
  for(let index=1;index<candles.length;index++){
    const current=num(candles[index].close),previous=num(candles[index-1].close);
    if(current===null||previous===null||current<=0||previous<=0)return [];
    output.push((current/previous)-1);
  }
  return output;
}
function ratioOrNull(numerator,denominator) {
  return finite(numerator)&&finite(denominator)&&Number(denominator)>0
    ?Number(numerator)/Number(denominator):null;
}

/**
 * Derive the 18 Cognitive MLP inputs only from synchronized, closed Spot
 * klines. Five-minute buyer pressure is present only when its own closed
 * Binance candle exists; order-book and aggregate-trade data remain masked.
 */
export function buildNeuralClosureFeatureSnapshot({
  symbolCandles,benchmarkCandles,fiveMinuteCandles,decisionAt
}={}) {
  const at=num(decisionAt);
  if(at===null)throw new TypeError('NEURAL_FEATURE_DECISION_TIME_INVALID');
  const symbolWindow=lastClosedWindow(symbolCandles,at,24,FIFTEEN_MINUTES_MS);
  const btcWindow=lastClosedWindow(benchmarkCandles,at,24,FIFTEEN_MINUTES_MS);
  const microWindow=lastClosedWindow(fiveMinuteCandles,at,24,FIVE_MINUTES_MS);
  if(!symbolWindow||!btcWindow||!microWindow)
    return {ready:false,reason:'CLOSED_MULTI_INTERVAL_FEATURE_WINDOW_INCOMPLETE'};
  const sequenceResult=buildHybridSequence({
    candles:symbolCandles,benchmarkCandles,asOf:at,sequenceSteps:24
  });
  if(sequenceResult.ready!==true)
    return {ready:false,reason:sequenceResult.reason||'HYBRID_SEQUENCE_NOT_READY'};
  const latest=symbolWindow.at(-1),previous=symbolWindow.at(-2);
  const latestBtc=btcWindow.at(-1),previousBtc=btcWindow.at(-2);
  const latestMicro=microWindow.at(-1),previousMicro=microWindow.at(-2);
  const latestClose=num(latest.close),latestOpen=num(latest.open);
  const latestHigh=num(latest.high),latestLow=num(latest.low);
  const range=latestHigh-latestLow;
  const quote=quoteVolume(latest),trades=tradeCount(latest);
  const previousQuotes=symbolWindow.slice(0,-1).map(quoteVolume).filter(value=>value>0);
  const previousTrades=symbolWindow.slice(0,-1).map(tradeCount).filter(value=>value>0);
  const volumeRatio=ratioOrNull(quote,mean(previousQuotes));
  const tradeRatio=ratioOrNull(trades,mean(previousTrades));
  const takerBuyRatio=ratioOrNull(latest.takerBuyQuoteVolume,quote);
  const symbolReturns=returnsFrom(symbolWindow);
  const btcReturns=returnsFrom(btcWindow);
  const symbol3h=pct(latestClose,num(symbolWindow.at(-13)?.close));
  const symbol1h=pct(latestClose,num(symbolWindow.at(-5)?.close));
  const btc3h=pct(num(latestBtc.close),num(btcWindow.at(-13)?.close));
  const relativeStrength=symbol3h!==null&&btc3h!==null?symbol3h-btc3h:null;
  const recent15m=pct(latestClose,num(previous.close));
  const atrSeries=symbolWindow.slice(-14).map(row=>{
    const close=num(row.close),high=num(row.high),low=num(row.low);
    return close>0?(high-low)/close*100:null;
  }).filter(finite);
  const atrBaselineSeries=symbolWindow.slice(-24,-14).map(row=>{
    const close=num(row.close),high=num(row.high),low=num(row.low);
    return close>0?(high-low)/close*100:null;
  }).filter(finite);
  const atrPct=mean(atrSeries);
  const atrBaselinePct=mean(atrBaselineSeries);
  const shortVol=std(symbolReturns.slice(-4));
  const baseVol=std(symbolReturns.slice(0,-4));
  const compressionRatio=shortVol!==null&&baseVol!==null&&baseVol>1e-10
    ?shortVol/baseVol:null;
  const priorLows=symbolWindow.slice(-4,-1).map(row=>num(row.low)).filter(value=>value>0);
  const priorHighs=symbolWindow.slice(-13,-1).map(row=>num(row.high)).filter(value=>value>0);
  const closeLocation=range>0?(latestClose-latestLow)/range:null;
  const upperWickPct=range>0
    ?(latestHigh-Math.max(latestOpen,latestClose))/latestClose*100:null;
  const currentRangePct=range>0?range/latestClose*100:null;
  const microQuote=quoteVolume(latestMicro);
  const microTrades=tradeCount(latestMicro);
  const previousMicroQuotes=microWindow.slice(0,-1).map(quoteVolume).filter(value=>value>0);
  const previousMicroTrades=microWindow.slice(0,-1).map(tradeCount).filter(value=>value>0);
  const microBuyer=ratioOrNull(latestMicro.takerBuyQuoteVolume,microQuote);
  const microVolumeRatio=ratioOrNull(microQuote,mean(previousMicroQuotes));
  const microTradeRatio=ratioOrNull(microTrades,mean(previousMicroTrades));
  const microReturn=pct(num(latestMicro.close),num(previousMicro.close));
  const microRange=num(latestMicro.high)-num(latestMicro.low);
  const microCloseLocation=microRange>0
    ?(num(latestMicro.close)-num(latestMicro.low))/microRange:null;
  const features={
    volume_ratio:volumeRatio,trade_ratio:tradeRatio,taker_buy_ratio:takerBuyRatio,
    higher_low:priorLows.length===3&&num(latest.low)>Math.min(...priorLows),
    breakout_above_prior_high:priorHighs.length===12&&latestClose>Math.max(...priorHighs),
    compression_ratio:compressionRatio,
    relative_strength_vs_btc_pct:relativeStrength,
    recent_15m_return_pct:recent15m,return_3h_pct:symbol3h,
    trend_aligned:symbol3h!==null&&symbol1h!==null&&symbol3h>0&&symbol1h>0,
    micro_5m_available:microBuyer!==null&&microVolumeRatio!==null&&microTradeRatio!==null,
    micro_5m_taker_buy_ratio:microBuyer,
    close_location:closeLocation,upper_wick_pct:upperWickPct,
    current_range_pct:currentRangePct,
    micro_5m_volume_ratio:microVolumeRatio,micro_5m_trade_ratio:microTradeRatio,
    micro_5m_return_pct:microReturn,micro_5m_close_location:microCloseLocation,
    quote_volume_24h:null
  };
  if(Object.values(features).some(value=>
    value!==null&&typeof value!=='boolean'&&!Number.isFinite(Number(value))))
    return {ready:false,reason:'COGNITIVE_FEATURE_NON_FINITE'};
  const featureVector=buildCognitiveFeatureVector(features,COGNITIVE_FEATURE_SCHEMA);
  if(featureVector.length!==18||featureVector.some(value=>!Number.isFinite(value)))
    return {ready:false,reason:'COGNITIVE_FEATURE_VECTOR_NOT_FINITE'};
  const btcRegime=btc3h===null?'SIDEWAYS':
    btc3h>0.5?'BULL_TREND':btc3h< -0.5?'BEAR_TREND':'SIDEWAYS';
  const classicInputs=[
    volumeRatio===null?0:clamp(log2(volumeRatio)/2,-1,1),
    tradeRatio===null?0:clamp(log2(tradeRatio)/2,-1,1),
    takerBuyRatio===null?0:clamp((takerBuyRatio-0.5)/0.2,-1,1),
    features.higher_low||features.breakout_above_prior_high?1:0,
    relativeStrength===null?0:clamp(relativeStrength/3,-1,1),
    recent15m===null?0:clamp(recent15m/1.5,-1,1)
  ];
  const classicLogit=classicInputs.reduce((sum,value,index)=>
    sum+value*[0.28,0.16,0.20,0.16,0.12,0.08][index],0);
  const classicScore=1/(1+Math.exp(-4*classicLogit));
  return {
    ready:true,features,feature_vector:featureVector,
    temporal_sequence:sequenceResult.sequence,
    temporal_sequence_timestamps:sequenceResult.sequence_timestamps,
    latest_input_at:sequenceResult.latest_input_at,
    kama_efficiency_ratio:sequenceResult.kama_efficiency_ratio,
    atr_pct:atrPct,atr_baseline_pct:atrBaselinePct,
    volatility_zscore:sequenceResult.volatility_zscore,
    btc_trend_return_pct:sequenceResult.btc_trend_return_pct,
    market_regime:btcRegime,classic_score:clamp(classicScore,0.01,0.99),
    feature_schema:COGNITIVE_FEATURE_SCHEMA,
    feature_names:[...COGNITIVE_FEATURE_NAMES],
    temporal_feature_names:[...sequenceResult.feature_names],
    micro_data_source:'BINANCE_SPOT_PUBLIC_5M_KLINE_TAKER_BUY_VOLUME',
    micro_availability_mask:features.micro_5m_available?1:0,
    order_book_available:false,aggregate_trade_available:false,
    trade_level_volume_profile_available:false
  };
}

function excursionMetrics(minuteCandles,firstTouch,baselinePrice) {
  const exitCandle=firstTouch?.exit_candle;
  const exitOpenAt=candleOpenTime(exitCandle);
  const exitCloseAt=candleCloseTime(exitCandle);
  const exitAt=num(firstTouch?.first_touch_at);
  if(exitOpenAt===null||exitCloseAt===null||exitAt===null)return null;
  const executed=minuteCandles.filter(candle=>candleOpenTime(candle)<=exitOpenAt);
  const prior=executed.filter(candle=>candleOpenTime(candle)<exitOpenAt);
  const resolution=firstTouch.resolution;
  const lows=[],highs=[];
  for(const candle of prior){
    lows.push({price:num(candle.low),at:candleCloseTime(candle)});
    highs.push({price:num(candle.high),at:candleCloseTime(candle)});
  }
  if(resolution==='TAKE_PROFIT_FIRST'){
    lows.push({price:num(exitCandle.low),at:exitCloseAt});
    highs.push({price:num(firstTouch.exit_price),at:exitAt});
  }else if(resolution==='STOP_LOSS_FIRST'){
    lows.push({price:num(firstTouch.exit_price),at:exitAt});
    highs.push({price:num(exitCandle.open),at:exitOpenAt});
  }else if(resolution==='HORIZON_END'){
    for(const candle of executed){
      lows.push({price:num(candle.low),at:candleCloseTime(candle)});
      highs.push({price:num(candle.high),at:candleCloseTime(candle)});
    }
  }else return null;
  const validLows=lows.filter(item=>finite(item.price)&&finite(item.at));
  const validHighs=highs.filter(item=>finite(item.price)&&finite(item.at));
  if(!validLows.length||!validHighs.length)return null;
  const adverse=validLows.reduce((worst,item)=>item.price<worst.price?item:worst);
  const favourable=validHighs.reduce((best,item)=>item.price>best.price?item:best);
  return {
    max_adverse_excursion_pct:(adverse.price/baselinePrice-1)*100,
    max_adverse_excursion_at:adverse.at,
    max_favorable_excursion_pct:Math.max(0,(favourable.price/baselinePrice-1)*100),
    max_favorable_excursion_at:favourable.at
  };
}

/** Create one fully audited 4h outcome and all decision-time feature families. */
export function buildNeuralClosureEventRow({
  symbol,decisionAt,minuteCandles,fiveMinuteCandles,fifteenMinuteCandles,
  benchmarkFifteenMinuteCandles,firstMinuteOpenAt,sourceReceivedAt,
  quoteVolume24h
}={}) {
  const at=num(decisionAt),baseline=num(sourceReceivedAt),firstMinute=num(firstMinuteOpenAt);
  if(at===null||baseline===null||firstMinute===null)
    throw new TypeError('NEURAL_CLOSURE_EVENT_TIME_INVALID');
  const feature=buildNeuralClosureFeatureSnapshot({
    symbolCandles:fifteenMinuteCandles,
    benchmarkCandles:benchmarkFifteenMinuteCandles,
    fiveMinuteCandles,decisionAt:at
  });
  if(feature.ready!==true)return {ready:false,reason:feature.reason};
  const baseCandle=fifteenMinuteCandles.find(candle=>candleCloseTime(candle)===at);
  if(!baseCandle)return {ready:false,reason:'DECISION_15M_CANDLE_MISSING'};
  const minuteOffset=(at+1-firstMinute)/MINUTE_MS;
  if(!Number.isInteger(minuteOffset)||minuteOffset<0)
    return {ready:false,reason:'ONE_MINUTE_WINDOW_OFFSET_INVALID'};
  const future=minuteCandles.slice(minuteOffset,minuteOffset+240);
  if(future.length!==240)return {ready:false,reason:'ONE_MINUTE_FORWARD_WINDOW_INCOMPLETE'};
  const label=buildFourHourFirstTouchOutcome({
    id:symbol+':'+at,symbol,baselineAt:at,baselinePrice:num(baseCandle.close),
    candles:future,featureInformationCutoffAt:at,
    marketContext:{
      kama_efficiency_ratio:feature.kama_efficiency_ratio,
      atr_pct:feature.atr_pct,
      atr_baseline_pct:feature.atr_baseline_pct
    },
    sourceEvidence:{
      exchange:'BINANCE',market:'SPOT',interval:'1m',
      transport:SOURCE,symbol,received_at:baseline
    }
  });
  if(label.training_eligible!==true)
    return {ready:false,reason:label.reason||'FIRST_TOUCH_LABEL_REJECTED'};
  const excursions=excursionMetrics(future,label.first_touch,num(baseCandle.close));
  if(!excursions)return {ready:false,reason:'FIRST_TOUCH_EXCURSION_METRICS_UNAVAILABLE'};
  const closeAt=new Date(at).toISOString();
  const historicalWindowId='utc-'+closeAt.slice(0,10).replaceAll('-','');
  return {
    ready:true,
    row:{
      ...label,
      features:feature.features,
      temporal_sequence:feature.temporal_sequence,
      temporal_sequence_timestamps:feature.temporal_sequence_timestamps,
      sequence:feature.temporal_sequence,
      sequence_timestamps:feature.temporal_sequence_timestamps,
      feature_schema:feature.feature_schema,
      feature_names:[...feature.feature_names],
      temporal_feature_names:[...feature.temporal_feature_names],
      latest_input_at:at,
      feature_snapshot_sha:sha256Canonical({
        features:feature.features,temporal_sequence:feature.temporal_sequence,
        temporal_sequence_timestamps:feature.temporal_sequence_timestamps
      }),
      market_regime:feature.market_regime,
      historical_window_id:historicalWindowId,
      outcome_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
      outcome_horizon_ms:NEURAL_CLOSURE_HORIZON_MS,
      maturity_ms:NEURAL_CLOSURE_HORIZON_MS,
      gross_return_pct:label.realized_return_pct,
      max_adverse_excursion_pct:excursions.max_adverse_excursion_pct,
      max_adverse_excursion_at:excursions.max_adverse_excursion_at,
      max_favorable_excursion_pct:excursions.max_favorable_excursion_pct,
      max_favorable_excursion_at:excursions.max_favorable_excursion_at,
      classic_score:feature.classic_score,
      classic_score_method:'CLOSED_CANDLE_EVIDENCE_WEIGHTS_V1',
      kama_efficiency_ratio:feature.kama_efficiency_ratio,
      atr_pct:feature.atr_pct,atr_baseline_pct:feature.atr_baseline_pct,
      volatility_zscore:feature.volatility_zscore,
      btc_trend_return_pct:feature.btc_trend_return_pct,
      quote_volume_24h:finite(quoteVolume24h)?Number(quoteVolume24h):null,
      micro_data_source:feature.micro_data_source,
      micro_availability_mask:feature.micro_availability_mask,
      order_book_available:feature.order_book_available,
      aggregate_trade_available:feature.aggregate_trade_available,
      trade_level_volume_profile_available:feature.trade_level_volume_profile_available
    }
  };
}

export function verifyNeuralClosureRawCoverage({
  minuteCandles,fiveMinuteCandles,fifteenMinuteCandles,
  benchmarkFifteenMinuteCandles,schedule
}={}) {
  const check=(rows,start,end,interval,name)=>{
    if(!Array.isArray(rows)||!rows.length)return {valid:false,reason:name+'_EMPTY'};
    const sorted=[...rows].sort((a,b)=>candleOpenTime(a)-candleOpenTime(b));
    if(candleOpenTime(sorted[0])!==start||candleOpenTime(sorted.at(-1))!==end)
      return {valid:false,reason:name+'_BOUNDARY_MISMATCH'};
    for(let index=0;index<sorted.length;index++){
      if(sorted[index].closed!==true)return {valid:false,reason:name+'_CONTAINS_UNCLOSED_CANDLE'};
      if(index&&candleOpenTime(sorted[index])-candleOpenTime(sorted[index-1])!==interval)
        return {valid:false,reason:name+'_GAP_OR_DUPLICATE'};
    }
    return {valid:true,count:sorted.length,first_open_at:start,last_open_at:end};
  };
  if(!schedule)return {valid:false,reason:'SCHEDULE_REQUIRED'};
  const checks={
    minute:check(minuteCandles,schedule.one_minute_start_open_at,
      schedule.one_minute_end_open_at,MINUTE_MS,'1M'),
    five_minute:check(fiveMinuteCandles,schedule.five_minute_start_open_at,
      schedule.five_minute_end_open_at,FIVE_MINUTES_MS,'5M'),
    fifteen_minute:check(fifteenMinuteCandles,schedule.fifteen_minute_start_open_at,
      schedule.fifteen_minute_end_open_at,FIFTEEN_MINUTES_MS,'15M'),
    benchmark_fifteen_minute:check(benchmarkFifteenMinuteCandles,
      schedule.fifteen_minute_start_open_at,schedule.fifteen_minute_end_open_at,
      FIFTEEN_MINUTES_MS,'BTC_15M')
  };
  return {
    valid:Object.values(checks).every(result=>result.valid),
    checks
  };
}

export const NEURAL_CLOSURE_MARKET_DATA_POLICY=Object.freeze({
  market:'BINANCE_SPOT_USDT',transport:SOURCE,
  quote_asset:'USDT',minimum_24h_quote_volume_usdt:750_000,
  intervals:['1m','5m','15m'],
  decision_cadence_ms:FOUR_HOURS_MS,
  feature_window:{steps:24,channels:29,interval_ms:HYBRID_CANDLE_INTERVAL_MS},
  label_window:{closed_one_minute_candles:240},
  no_synthetic_data:true,no_order_book_or_agg_trade_imputation:true,
  paper_trading:true,real_order_execution:false
});
