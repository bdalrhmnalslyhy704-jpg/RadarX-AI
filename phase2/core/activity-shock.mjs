const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number.isFinite(Number(v))?Number(v):min));
const known=v=>v!==null&&v!==undefined&&!(typeof v==='string'&&v.trim()==='')&&Number.isFinite(Number(v));
const median=values=>{const a=values.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;};
const pct=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&b>0?(a/b-1)*100:null;

function cleanClosedCandles(rows,now){
  return (Array.isArray(rows)?rows:[]).filter(c=>
    c&&c.closed!==false&&Number.isFinite(Number(c.openTime))&&Number.isFinite(Number(c.closeTime))&&
    Number(c.closeTime)<=now&&Number(c.open)>0&&Number(c.high)>0&&Number(c.low)>0&&Number(c.close)>0&&
    Number(c.high)>=Math.max(Number(c.open),Number(c.close))&&Number(c.low)<=Math.min(Number(c.open),Number(c.close))&&
    Number(c.low)<=Number(c.high)&&Number(c.volume)>=0
  ).sort((a,b)=>Number(a.openTime)-Number(b.openTime));
}
function quoteVol(c){const q=Number(c?.quoteVolume);return Number.isFinite(q)&&q>=0?q:Math.max(0,Number(c?.volume)||0)*Math.max(0,Number(c?.close)||0);}
function tradeCount(c){const n=Number(c?.tradeCount??c?.count);return Number.isFinite(n)&&n>=0?n:null;}
function rangePct(c){const close=Number(c?.close),high=Number(c?.high),low=Number(c?.low);return close>0&&high>=low?(high-low)/close*100:null;}

export function assessQuietBaseActivityShock({fiveMinute=[],ticker={},now=Date.now(),config={}}={}){
  const rows=cleanClosedCandles(fiveMinute,Number(now));
  const missing={available:false,detected:false,stage:'NO_SHOCK',score:0,reason:'INSUFFICIENT_CLOSED_CANDLES',
    reasons:[],metrics:{closed_candles:rows.length},watch_only:true,entry_eligible:false,
    taker_buy_is_required:false,closed_candles_only:true,detected_candle_close_time:null};
  if(rows.length<22)return missing;

  // The comparison baseline excludes the latest completed candle so the shock
  // cannot inflate its own RVOL/trade-count denominator.
  const last=rows.at(-1),baseline=rows.slice(-21,-1),previous=rows.at(-2);
  if(!baseline.length||!previous)return missing;
  const qValues=baseline.map(quoteVol),tValues=baseline.map(tradeCount).filter(Number.isFinite);
  const qBase=median(qValues),tBase=median(tValues);
  const qNow=quoteVol(last),tNow=tradeCount(last),volumeRatio=qBase>0?qNow/qBase:null;
  const tradesRatio=Number.isFinite(tNow)&&tBase>0?tNow/tBase:null;
  const close=Number(last.close),open=Number(last.open),high=Number(last.high),low=Number(last.low);
  const previousClose=Number(previous.close);
  const return5m=pct(close,previousClose);
  const bodyReturn=pct(close,open);
  const closeLocation=high>low?(close-low)/(high-low)*100:null;
  const priorHigh=Math.max(...baseline.map(c=>Number(c.high)).filter(Number.isFinite));
  const breakoutDistancePct=pct(close,priorHigh);
  const breakoutConfirmed=Number.isFinite(close)&&Number.isFinite(priorHigh)&&close>priorHigh;
  const recentRanges=baseline.slice(-8).map(rangePct).filter(Number.isFinite);
  const olderRanges=baseline.slice(-20,-8).map(rangePct).filter(Number.isFinite);
  const recentRange=median(recentRanges),olderRange=median(olderRanges);
  const baseCompressionRatio=Number.isFinite(recentRange)&&Number.isFinite(olderRange)&&olderRange>0?recentRange/olderRange:null;
  const priorWasQuiet=Number.isFinite(baseCompressionRatio)&&baseCompressionRatio<=Number(config.maxBaseCompressionRatio??0.92);
  const takerVolume=Number(last.takerBuyBaseVolume);
  const lastVolume=Number(last.volume);
  const takerBuyRatio=Number.isFinite(takerVolume)&&Number.isFinite(lastVolume)&&lastVolume>0?takerVolume/lastVolume:null;
  const priceChange24h=known(ticker?.priceChange24h)?Number(ticker.priceChange24h):null;
  const move24hKnown=priceChange24h!==null;
  const largeVolume=Number.isFinite(volumeRatio)&&volumeRatio>=Number(config.minVolumeShockRatio??3.5);
  const largeTrades=Number.isFinite(tradesRatio)&&tradesRatio>=Number(config.minTradeShockRatio??2.5);
  const priceAcceptance=(breakoutDistancePct!==null&&breakoutDistancePct>=-0.35)||
    (Number.isFinite(closeLocation)&&closeLocation>=68)||
    (Number.isFinite(bodyReturn)&&bodyReturn>=Number(config.minBodyReturnPct??0.8));
  const bullishClose=close>open;
  const rapidEvent=largeVolume&&largeTrades&&bullishClose&&priceAcceptance;
  const eventDriven=rapidEvent&&(
    breakoutConfirmed&&((Number(volumeRatio)>=Number(config.eventVolumeShockRatio??10))||
      (Number(tradesRatio)>=Number(config.eventTradeShockRatio??8))||
      Number(return5m)>=Number(config.eventReturn5mPct??8))
  );
  const quietBaseShock=rapidEvent&&priorWasQuiet;
  const generalShock=rapidEvent&&Number(volumeRatio)>=6&&Number(tradesRatio)>=4;
  const detected=Boolean(eventDriven||quietBaseShock||generalShock);
  let stage='NO_SHOCK',reason='ACTIVITY_SHOCK_CONFIRMATION_NOT_MET';
  if(eventDriven){stage='EVENT_DRIVEN_BREAKOUT';reason='EXTREME_VOLUME_AND_TRADES_WITH_CLOSED_BREAKOUT';}
  else if(quietBaseShock){stage='QUIET_BASE_ACTIVITY_SHOCK';reason='COMPRESSED_BASE_VOLUME_AND_TRADE_SHOCK';}
  else if(generalShock){stage='ACTIVITY_SHOCK';reason='VOLUME_AND_TRADE_SHOCK_WITH_PRICE_ACCEPTANCE';}
  const move5m=Math.abs(Number(return5m)||0);
  const extended=(move24hKnown&&Math.abs(priceChange24h)>=Number(config.maxEntryMove24hPct??18))||
    move5m>=Number(config.maxEntryMove5mPct??8);
  const ratioScore=(v,scale)=>Number.isFinite(v)&&v>0?Math.min(28,Math.max(0,Math.log10(v)*scale)):0;
  const score=detected?Number(clamp(28+ratioScore(volumeRatio,18)+ratioScore(tradesRatio,13)+
    (priorWasQuiet?14:0)+(breakoutConfirmed?16:0)+(priceAcceptance?8:0)+
    (takerBuyRatio!==null&&takerBuyRatio>0.5?3:0)).toFixed(1)):0;
  const reasons=[];
  if(priorWasQuiet)reasons.push('QUIET_BASE_BEFORE_SHOCK');
  if(largeVolume)reasons.push('CLOSED_CANDLE_VOLUME_SPIKE');
  if(largeTrades)reasons.push('CLOSED_CANDLE_TRADE_COUNT_SPIKE');
  if(breakoutConfirmed)reasons.push('CLOSED_CANDLE_RESISTANCE_BREAK');
  else if(priceAcceptance)reasons.push('PRICE_ACCEPTANCE_NEAR_RESISTANCE');
  if(takerBuyRatio!==null&&takerBuyRatio<=0.5)reasons.push('TAKER_BUY_BELOW_50_NOT_A_REJECTION');
  if(extended)reasons.push('ALREADY_EXTENDED_WATCH_ONLY');
  return {
    available:true,detected,stage,reason,score,reasons,
    // This detector is an observation/event flag only; it is never a buy/entry gate.
    watch_only:true,entry_eligible:false,extended,taker_buy_is_required:false,
    taker_flow_confirmed:takerBuyRatio!==null?takerBuyRatio>0.5:null,
    closed_candles_only:true,detected_candle_close_time:Number(last.closeTime),
    metrics:{
      symbol:String(ticker?.symbol||'').toUpperCase()||null,
      volume_shock_ratio:Number.isFinite(volumeRatio)?Number(volumeRatio.toFixed(3)):null,
      trade_shock_ratio:Number.isFinite(tradesRatio)?Number(tradesRatio.toFixed(3)):null,
      base_compression_ratio:Number.isFinite(baseCompressionRatio)?Number(baseCompressionRatio.toFixed(4)):null,
      prior_base_was_quiet:priorWasQuiet,
      return_5m_pct:Number.isFinite(return5m)?Number(return5m.toFixed(4)):null,
      body_return_pct:Number.isFinite(bodyReturn)?Number(bodyReturn.toFixed(4)):null,
      resistance_distance_pct:Number.isFinite(breakoutDistancePct)?Number(breakoutDistancePct.toFixed(4)):null,
      breakout_confirmed:breakoutConfirmed,
      close_location_pct:Number.isFinite(closeLocation)?Number(closeLocation.toFixed(2)):null,
      taker_buy_ratio:Number.isFinite(takerBuyRatio)?Number(takerBuyRatio.toFixed(4)):null,
      price_change_24h_pct:priceChange24h,
      move_24h_known:move24hKnown,
      closed_candles:rows.length
    }
  };
}

/** Fast ticker-delta bypass: select shock candidates for candle confirmation even
 * when the daily move is already large. It never promotes them to entry eligibility. */
export function isFastActivityShockCandidate(row={},fast={},config={}){
  const price=Number(row?.lastPrice);
  const volume=Number(fast?.volume_accel_ratio),trades=Number(fast?.trade_accel_ratio);
  const change=Number(fast?.price_change_pct),accel=Number(fast?.price_acceleration_pct);
  if(!(Number.isFinite(price)&&price>0)||!Number.isFinite(change)||change<=0)return false;
  const volumeMin=Number(config.fastShockVolumeRatio??4);
  const tradeMin=Number(config.fastShockTradeRatio??3);
  return (Number.isFinite(volume)&&volume>=volumeMin&&Number.isFinite(trades)&&trades>=tradeMin)||
    (Number.isFinite(volume)&&volume>=volumeMin*2&&Number.isFinite(accel)&&accel>0.05);
}
