const clamp=(value,min=0,max=100)=>Math.max(min,Math.min(max,Number.isFinite(Number(value))?Number(value):min));
const known=value=>value!==null&&value!==undefined&&!(typeof value==='string'&&value.trim()==='')&&Number.isFinite(Number(value));
const numberOrNull=value=>known(value)?Number(value):null;
const median=values=>{const xs=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!xs.length)return null;const m=Math.floor(xs.length/2);return xs.length%2?xs[m]:(xs[m-1]+xs[m])/2;};

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
  // A zero middle bucket has no valid denominator for the middle→recent ratio.
  // Treat it as unavailable; otherwise stepRatio becomes null and formatting it
  // with toFixed can abort the entire symbol's deep scan.
  if(!Number.isFinite(baseline)||baseline<=0||!Number.isFinite(middle)||middle<=0||!Number.isFinite(recent)){
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
