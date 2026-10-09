const clamp=(value,min=0,max=100)=>Math.max(min,Math.min(max,Number.isFinite(Number(value))?Number(value):min));
const known=value=>value!==null&&value!==undefined&&!(typeof value==='string'&&value.trim()==='')&&Number.isFinite(Number(value));
const numberOrNull=value=>known(value)?Number(value):null;
const median=values=>{const xs=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!xs.length)return null;const m=Math.floor(xs.length/2);return xs.length%2?xs[m]:(xs[m-1]+xs[m])/2;};


const shockCandleCloseTime=row=>{
  const closeTime=Number(row?.closeTime);
  return Number.isFinite(closeTime)?closeTime:null;
};
const shockRangePct=row=>{
  const high=numberOrNull(row?.high),low=numberOrNull(row?.low),close=numberOrNull(row?.close);
  return high!==null&&low!==null&&close>0&&high>=low?(high-low)/close*100:null;
};
const shockTradeCount=row=>numberOrNull(row?.tradeCount??row?.count);

function assessActivityShockAt(rows,index){
  if(index<24||index>=rows.length)return null;
  const candle=rows[index],prior=rows.slice(Math.max(0,index-30),index);
  if(prior.length<24)return null;
  const previousClose=numberOrNull(rows[index-1]?.close),close=numberOrNull(candle?.close);
  const volume=numberOrNull(candle?.volume),baseVolume=median(prior.slice(-20).map(x=>numberOrNull(x?.volume)).filter(x=>x!==null&&x>0));
  const trades=shockTradeCount(candle),baseTrades=median(prior.slice(-20).map(shockTradeCount).filter(x=>x!==null&&x>0));
  const volumeRatio=volume!==null&&baseVolume>0?volume/baseVolume:null;
  const tradeRatio=trades!==null&&baseTrades>0?trades/baseTrades:null;
  const dualShock=Number.isFinite(volumeRatio)&&volumeRatio>=4&&Number.isFinite(tradeRatio)&&tradeRatio>=3;
  const extremeVolumeShock=Number.isFinite(volumeRatio)&&volumeRatio>=10&&Number.isFinite(tradeRatio)&&tradeRatio>=1.6;
  const extremeTradeShock=Number.isFinite(tradeRatio)&&tradeRatio>=8&&Number.isFinite(volumeRatio)&&volumeRatio>=1.6;
  const activityShock=dualShock||extremeVolumeShock||extremeTradeShock;
  if(!activityShock||!(close>0)||!(previousClose>0))return null;

  const recentRanges=prior.slice(-12).map(shockRangePct).filter(x=>x!==null);
  const olderRanges=prior.slice(-24,-12).map(shockRangePct).filter(x=>x!==null);
  const recentRange=median(recentRanges),olderRange=median(olderRanges);
  const compressionRatio=recentRange!==null&&olderRange>0?recentRange/olderRange:null;
  const compressed=Number.isFinite(compressionRatio)&&compressionRatio<=0.92;
  const resistance=Math.max(...prior.slice(-20).map(x=>numberOrNull(x?.high)).filter(x=>x!==null));
  const resistanceGapPct=resistance>0?(close/resistance-1)*100:null;
  const nearResistance=Number.isFinite(resistanceGapPct)&&resistanceGapPct>=-2&&resistanceGapPct<=2.5;
  const return5mPct=(close/previousClose-1)*100;
  const takerBuy=numberOrNull(candle?.takerBuyBaseVolume);
  const takerBuyRatio=volume>0&&takerBuy!==null?takerBuy/volume:null;
  const closeTime=shockCandleCloseTime(candle);
  return {
    index,closeTime,volumeRatio,tradeRatio,compressionRatio,compressed,
    resistance,resistanceGapPct,nearResistance,return5mPct,takerBuyRatio,
    currentClose:close,activityShock
  };
}

/**
 * Detects a closed-candle activity shock without requiring taker-buy dominance.
 * It is a watch-only observation, not a buy signal. Timestamps are reconstructed
 * only from Binance closed candles in the recent replay window; news causality is
 * not inferred from OHLCV.
 */
export function assessQuietBaseActivityShock({
  fiveMinute=[],oneMinute=[],ticker={},now=Date.now(),config={}
}={}){
  const validRows=rows=>(Array.isArray(rows)?rows:[]).filter(row=>{
    const ot=Number(row?.openTime),ct=Number(row?.closeTime);
    return row?.closed!==false&&Number.isFinite(ot)&&Number.isFinite(ct)&&ct<=Number(now)&&
      Number.isFinite(Number(row?.open))&&Number(row.open)>0&&
      Number.isFinite(Number(row?.high))&&Number(row.high)>=Math.max(Number(row?.open),Number(row?.close))&&
      Number.isFinite(Number(row?.low))&&Number(row.low)>0&&
      Number.isFinite(Number(row?.close))&&Number(row.close)>0&&
      Number.isFinite(Number(row?.volume))&&Number(row.volume)>=0;
  }).sort((a,b)=>Number(a.openTime)-Number(b.openTime));
  const five=validRows(fiveMinute);
  const one=validRows(oneMinute);
  const empty={
    detected:false,pattern:null,classification:'NONE',watch_only:true,
    reason:'NO_QUALIFIED_ACTIVITY_SHOCK',volume_ratio:null,trade_ratio:null,
    compression_ratio:null,resistance_gap_pct:null,return_5m_pct:null,
    taker_buy_ratio:null,possible_accumulation_or_absorption:false,
    first_activity_time:null,first_activity_time_ms:null,
    first_price_acceleration_time:null,first_price_acceleration_time_ms:null,
    first_breakout_time:null,first_breakout_time_ms:null,
    event_time:null,event_time_ms:null,news_time:null,news_time_ms:null,
    alert_time:null,alert_time_ms:null,observed_at:new Date(Number(now)||Date.now()).toISOString(),
    source:'Binance Public REST — closed OHLCV/trade-count candles',
    timing_method:'CLOSED_CANDLE_REPLAY_WINDOW_6',
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
  };
  if(five.length<30)return {...empty,reason:'INSUFFICIENT_CLOSED_5M_CANDLES'};
  const start=Math.max(24,five.length-6);
  const matched=[];
  for(let i=start;i<five.length;i++){
    const hit=assessActivityShockAt(five,i);
    if(hit)matched.push(hit);
  }
  if(!matched.length)return empty;
  const hit=matched.at(-1);
  const eventAt=hit.closeTime;
  if(eventAt===null||Number(now)-eventAt>Number(config.maxActivityShockAgeMs??30*60*1000))
    return {...empty,reason:'ACTIVITY_SHOCK_OUTSIDE_FRESHNESS_WINDOW'};
  const eventMove=Math.abs(hit.return5mPct);
  const isEventDriven=hit.return5mPct>=8;
  const technicalEarly=!isEventDriven&&hit.compressed&&hit.nearResistance&&hit.return5mPct>=0.35&&hit.return5mPct<=5.5;
  const classification=isEventDriven?'EVENT_DRIVEN_BREAKOUT':
    technicalEarly?'TECHNICAL_PRE_EXPANSION':'ACTIVITY_SHOCK_WATCH';
  const pattern=technicalEarly?'QUIET_BASE_ACTIVITY_SHOCK':'ACTIVITY_SHOCK';
  const recentMatched=matched[0];
  const firstActivityAt=recentMatched.closeTime;
  const accelerationRows=one.filter(x=>Number(x.closeTime)<=Number(eventAt)).slice(-20);
  let accelerationAt=null;
  for(let i=1;i<accelerationRows.length;i++){
    const before=numberOrNull(accelerationRows[i-1]?.close),after=numberOrNull(accelerationRows[i]?.close);
    if(before>0&&after>0&&(after/before-1)*100>=0.35){accelerationAt=shockCandleCloseTime(accelerationRows[i]);break;}
  }
  let breakoutAt=null;
  for(let i=Math.max(20,five.length-6);i<five.length;i++){
    if(Number(five[i].closeTime)>Number(eventAt))break;
    const prior=five.slice(Math.max(0,i-20),i);
    if(prior.length<20)continue;
    const priorHigh=Math.max(...prior.map(x=>Number(x.high)));
    if(Number(five[i].close)>priorHigh){breakoutAt=shockCandleCloseTime(five[i]);break;}
  }
  const symbols=String(ticker?.symbol||'').toUpperCase();
  const score=clamp(
    Math.min(100,Math.log10(Math.max(1,hit.volumeRatio||1))*23)*0.32+
    Math.min(100,Math.log10(Math.max(1,hit.tradeRatio||1))*23)*0.28+
    (hit.compressed?82:48)*0.18+
    (hit.nearResistance?82:45)*0.14+
    clamp(50+hit.return5mPct*12)*0.08
  );
  const reasons=[
    hit.volumeRatio>=4?'CLOSED_CANDLE_VOLUME_SHOCK':null,
    hit.tradeRatio>=3?'CLOSED_CANDLE_TRADE_COUNT_SHOCK':null,
    hit.compressed?'PRE_SHOCK_RANGE_COMPRESSION':null,
    hit.nearResistance?'NEAR_20_CANDLE_RESISTANCE':null,
    hit.return5mPct>0?'POSITIVE_PRICE_ACCELERATION':null,
    hit.takerBuyRatio!==null&&hit.takerBuyRatio<0.5?'TAKER_BUY_NOT_REQUIRED_FOR_WATCH':null,
    isEventDriven?'LARGE_SINGLE_CANDLE_EVENT_RISK':null
  ].filter(Boolean);
  return {
    detected:true,pattern,classification,watch_only:true,score:Number(score.toFixed(1)),
    symbol:symbols||null,reason:technicalEarly?'QUIET_BASE_WITH_ACTIVITY_SHOCK_NEAR_RESISTANCE':
      isEventDriven?'LARGE_CLOSED_CANDLE_ACTIVITY_SHOCK':'ACTIVITY_SHOCK_WITHOUT_FULL_EARLY_STRUCTURE',
    volume_ratio:Number(hit.volumeRatio.toFixed(3)),trade_ratio:Number(hit.tradeRatio.toFixed(3)),
    compression_ratio:Number.isFinite(hit.compressionRatio)?Number(hit.compressionRatio.toFixed(3)):null,
    compressed:hit.compressed,near_resistance:hit.nearResistance,
    resistance:hit.resistance,resistance_gap_pct:Number.isFinite(hit.resistanceGapPct)?Number(hit.resistanceGapPct.toFixed(3)):null,
    return_5m_pct:Number(hit.return5mPct.toFixed(3)),taker_buy_ratio:Number.isFinite(hit.takerBuyRatio)?Number(hit.takerBuyRatio.toFixed(4)):null,
    possible_accumulation_or_absorption:Boolean(technicalEarly&&hit.takerBuyRatio!==null&&hit.takerBuyRatio<0.45),
    first_activity_time:firstActivityAt!==null?new Date(firstActivityAt).toISOString():null,
    first_activity_time_ms:firstActivityAt,
    first_price_acceleration_time:accelerationAt!==null?new Date(accelerationAt).toISOString():null,
    first_price_acceleration_time_ms:accelerationAt,
    first_breakout_time:breakoutAt!==null?new Date(breakoutAt).toISOString():null,
    first_breakout_time_ms:breakoutAt,
    event_time:eventAt!==null?new Date(eventAt).toISOString():null,event_time_ms:eventAt,
    news_time:null,news_time_ms:null,alert_time:null,alert_time_ms:null,
    observed_at:new Date(Number(now)||Date.now()).toISOString(),
    replayed_shock_candles:matched.length,reasons,
    source:'Binance Public REST — closed OHLCV/trade-count candles',
    timing_method:'CLOSED_CANDLE_REPLAY_WINDOW_6',
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
  };
}

export function createActivityShockWatchEvent({shock={},symbol='',price=null,radar='UNKNOWN',radarName=null,now=Date.now()}={}){
  if(shock?.detected!==true)return null;
  const safeSymbol=String(symbol||shock.symbol||'').trim().toUpperCase();
  if(!/^[A-Z0-9]{5,30}$/.test(safeSymbol))return null;
  const eventAt=numberOrNull(shock.event_time_ms);
  const firstAt=numberOrNull(shock.first_activity_time_ms);
  const radarId=String(radar||'UNKNOWN').toUpperCase();
  return {
    id:`ACTIVITY_SHOCK:${radarId}:${safeSymbol}:${firstAt??eventAt??Math.trunc(now)}:${shock.classification||'WATCH'}`,
    event:'ACTIVITY_SHOCK_WATCH_ONLY',event_type:'ACTIVITY_SHOCK_WATCH_ONLY',
    radar:radarId,radar_name:radarName||radarId,symbol:safeSymbol,market:'SPOT',
    classification:shock.classification||'ACTIVITY_SHOCK_WATCH',
    direction:'UP_WATCH_ONLY',price_at_observation:numberOrNull(price),
    event_time:eventAt,event_time_iso:shock.event_time||null,
    first_activity_time:firstAt,first_activity_time_iso:shock.first_activity_time||null,
    first_price_acceleration_time:numberOrNull(shock.first_price_acceleration_time_ms),
    first_price_acceleration_time_iso:shock.first_price_acceleration_time||null,
    first_breakout_time:numberOrNull(shock.first_breakout_time_ms),first_breakout_time_iso:shock.first_breakout_time||null,
    news_time:null,alert_time:null,observed_at:Number(now)||Date.now(),
    watch_only:true,early_prediction_claim:false,
    activity_shock:shock,source:shock.source,
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
    disclaimer:'رصد نشاط فقط. ليس أمر شراء ولا يثبت وجود حيتان أو أن خبرًا تسبب بالحركة.'
  };
}

export const PRE_EXPANSION_STAGES=Object.freeze([
  'WATCH_EARLY','PRE_EXPANSION','BREAKOUT_DEVELOPING','ALREADY_EXTENDED','DATA_INSUFFICIENT'
]);

/**
 * Measure participation as three smoothed, chronological buckets. A single
 * volume spike is not called a gradual build unless the middle bucket holds
 * and the newest bucket improves again.
 */
export function measureGradualParticipation(values,{maxSamples=12,minSamples=6}={}){
  const xs=(Array.isArray(values)?values:[]).map(numberOrNull).filter(x=>x!==null&&x>=0);
  if(xs.length<minSamples)return {available:false,samples:xs.length,baseline:null,middle:null,recent:null,ratio:null,step_ratio:null,score:null,improving:false};
  const count=Math.min(maxSamples,xs.length);
  const segment=Math.max(2,Math.floor(count/3));
  const tail=xs.slice(-segment*3);
  if(tail.length<6)return {available:false,samples:xs.length,baseline:null,middle:null,recent:null,ratio:null,step_ratio:null,score:null,improving:false};
  const groups=[tail.slice(0,segment),tail.slice(segment,segment*2),tail.slice(segment*2)];
  const [baseline,middle,recent]=groups.map(group=>median(group));
  if(!Number.isFinite(baseline)||baseline<=0||!Number.isFinite(middle)||!Number.isFinite(recent)){
    return {available:false,samples:xs.length,baseline,middle,recent,ratio:null,step_ratio:null,score:null,improving:false};
  }
  const ratio=recent/baseline,stepRatio=middle>0?recent/middle:null,middleRatio=middle/baseline;
  const improving=ratio>=1.08&&middleRatio>=0.98&&Number.isFinite(stepRatio)&&stepRatio>=1.01;
  const score=clamp(50+Math.max(-1,ratio-1)*28+(middleRatio>=0.98?4:0)+(stepRatio>=1.01?6:0));
  return {available:true,samples:xs.length,baseline,middle,recent,ratio:Number(ratio.toFixed(4)),step_ratio:Number(stepRatio.toFixed(4)),middle_ratio:Number(middleRatio.toFixed(4)),score:Number(score.toFixed(1)),improving};
}

/**
 * Shared five-state classifier used only by Radar 8 (Lightning) and Radar 9
 * (Falcon Eye). Unknown daily movement is never interpreted as quiet movement.
 */
export function assessPreExpansionFingerprint(input={}){
  const dailyChangePct=numberOrNull(input.dailyChangePct);
  const price=numberOrNull(input.lastPrice);
  const volumeRatio=numberOrNull(input.volumeRatio);
  const tradeRatio=numberOrNull(input.tradeRatio);
  const resistanceDistanceAtr=numberOrNull(input.resistanceDistanceAtr);
  const return5mPct=numberOrNull(input.return5mPct);
  const return10mPct=numberOrNull(input.return10mPct);
  const return15mPct=numberOrNull(input.return15mPct);
  const higherLowScore=numberOrNull(input.higherLowScore);
  const baseScore=numberOrNull(input.baseScore);
  const compressionScore=numberOrNull(input.compressionScore);
  const compressionRatios=[input.compressionRatio,input.rangeCompressionRatio,input.bollingerRatio,input.atrRatio]
    .map(numberOrNull).filter(x=>x!==null&&x>0);
  const volumeTrend=input.volumeTrend&&typeof input.volumeTrend==='object'?input.volumeTrend:{};
  const tradeTrend=input.tradeTrend&&typeof input.tradeTrend==='object'?input.tradeTrend:{};
  const relativeStrengthBtcPct=numberOrNull(input.relativeStrengthBtcPct);
  const relativeStrengthMarketPct=numberOrNull(input.relativeStrengthMarketPct);
  const maxMove24hPct=Math.max(0,numberOrNull(input.maxMove24hPct)??8);
  const maxMove5mPct=Math.max(0,numberOrNull(input.maxMove5mPct)??2.5);
  const maxMove10mPct=Math.max(0,numberOrNull(input.maxMove10mPct)??3.8);
  const maxMove15mPct=Math.max(0,numberOrNull(input.maxMove15mPct)??6);
  const volumeTrendScore=numberOrNull(volumeTrend.score);
  const tradeTrendScore=numberOrNull(tradeTrend.score);
  const gradualVolume=volumeTrend.improving===true;
  const gradualTrades=tradeTrend.improving===true;
  const participationTrendScore=Number.isFinite(volumeTrendScore)&&Number.isFinite(tradeTrendScore)
    ?Number((volumeTrendScore*.55+tradeTrendScore*.45).toFixed(1))
    :Number.isFinite(volumeTrendScore)?volumeTrendScore:Number.isFinite(tradeTrendScore)?tradeTrendScore:null;
  const falseBreakout=input.falseBreakout===true;
  const structureDetected=(Number.isFinite(baseScore)&&baseScore>=60)&&Number.isFinite(higherLowScore)&&higherLowScore>=60;
  const baseDetected=structureDetected&&
    ((Number.isFinite(compressionScore)&&compressionScore>=60)||compressionRatios.some(x=>x<=0.90));
  const volumeImproving=gradualVolume||(Number.isFinite(volumeRatio)&&volumeRatio>=1.18);
  const tradesImproving=gradualTrades||(Number.isFinite(tradeRatio)&&tradeRatio>=1.12);
  const participationImproving=(volumeImproving||tradesImproving)&&
    (gradualVolume||gradualTrades||
      (Number.isFinite(volumeRatio)&&volumeRatio>=1.18&&Number.isFinite(tradeRatio)&&tradeRatio>=1.12));
  const relativeStrengthWeak=(relativeStrengthBtcPct!==null&&relativeStrengthBtcPct< -0.75)||
    (relativeStrengthMarketPct!==null&&relativeStrengthMarketPct< -0.75);
  const resistanceClose=Number.isFinite(resistanceDistanceAtr)&&resistanceDistanceAtr>=-1.25&&resistanceDistanceAtr<=3.5;
  let stage='WATCH_EARLY',reason='BASE_OR_PARTICIPATION_NOT_CONFIRMED';

  if(input.dataReady!==true||dailyChangePct===null||!(price>0)||input.requiredDataMissing===true){
    stage='DATA_INSUFFICIENT';reason=dailyChangePct===null?'DAILY_CHANGE_UNKNOWN':'REQUIRED_MARKET_DATA_UNAVAILABLE';
  }else{
    const extended=Math.abs(dailyChangePct)>=maxMove24hPct||
      (Number.isFinite(return5mPct)&&Math.abs(return5mPct)>=maxMove5mPct)||
      (Number.isFinite(return10mPct)&&Math.abs(return10mPct)>=maxMove10mPct)||
      (Number.isFinite(return15mPct)&&Math.abs(return15mPct)>=maxMove15mPct)||
      (Number.isFinite(resistanceDistanceAtr)&&resistanceDistanceAtr< -1.5)||
      input.alreadyExtended===true;
    if(extended){stage='ALREADY_EXTENDED';reason='MOVE_ALREADY_EXTENDED';}
    else if(falseBreakout){stage='WATCH_EARLY';reason='FALSE_BREAKOUT_REJECTED';}
    else if(structureDetected&&participationImproving&&!relativeStrengthWeak&&resistanceClose&&input.breakoutConfirmed===true){
      stage='BREAKOUT_DEVELOPING';reason='BASE_STRUCTURE_AND_CLOSED_BREAKOUT_CONFIRMED';
    }else if(baseDetected&&participationImproving&&!relativeStrengthWeak&&resistanceClose&&
      resistanceDistanceAtr<=0.45&&Number.isFinite(volumeRatio)&&volumeRatio>=1.2&&
      Number.isFinite(tradeRatio)&&tradeRatio>=1.15&&
      ((Number.isFinite(return5mPct)&&return5mPct>0)||(Number.isFinite(return10mPct)&&return10mPct>0.15))){
      stage='BREAKOUT_DEVELOPING';reason='BASE_PARTICIPATION_AND_RESISTANCE_CONFIRMATION';
    }else if(baseDetected&&participationImproving&&!relativeStrengthWeak&&resistanceClose){
      stage='PRE_EXPANSION';reason='COMPRESSED_BASE_AND_IMPROVING_PARTICIPATION';
    }else if(baseDetected&&relativeStrengthWeak){
      stage='WATCH_EARLY';reason='RELATIVE_STRENGTH_WEAK_VS_BENCHMARKS';
    }
  }
  return {
    stage,
    reason,
    base_detected:baseDetected,
    compression_detected:(Number.isFinite(compressionScore)&&compressionScore>=60)||compressionRatios.some(x=>x<=0.90),
    participation_improving:participationImproving,
    volume_improving:gradualVolume,
    trades_improving:gradualTrades,
    participation_trend_score:participationTrendScore,
    relative_strength_vs_btc_pct:relativeStrengthBtcPct,
    relative_strength_vs_market_pct:relativeStrengthMarketPct,
    resistance_distance_atr:resistanceDistanceAtr,
    false_breakout_detected:falseBreakout,
    daily_change_known:dailyChangePct!==null,
    data_ready:input.dataReady===true,
    metrics:{
      daily_change_pct:dailyChangePct,
      volume_ratio:volumeRatio,
      trade_ratio:tradeRatio,
      volume_trend:volumeTrend,
      trade_trend:tradeTrend,
      higher_low_score:higherLowScore,
      base_score:baseScore,
      compression_score:compressionScore,
      compression_ratios:{range:input.rangeCompressionRatio??null,bollinger:input.bollingerRatio??null,atr:input.atrRatio??null},
      return_5m_pct:return5mPct,
      return_10m_pct:return10mPct,
      return_15m_pct:return15mPct,
      resistance_distance_atr:resistanceDistanceAtr
    }
  };
}
