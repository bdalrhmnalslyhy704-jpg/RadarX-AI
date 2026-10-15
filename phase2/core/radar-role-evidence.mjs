const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const median = values => { const a=values.map(Number).filter(Number.isFinite).sort((x,y)=>x-y); if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2; };
const mean = values => {const a=values.map(Number).filter(Number.isFinite);return a.length?a.reduce((s,x)=>s+x,0)/a.length:null;};
const pct = (a,b) => finite(a)&&finite(b)&&Number(b)>0?(Number(a)/Number(b)-1)*100:null;

function closedRows(rows,now=Date.now()){
 const valid=(Array.isArray(rows)?rows:[]).filter(c=>c?.closed!==false&&finite(c?.openTime)&&finite(c?.closeTime)&&
   Number(c.openTime)<=now&&Number(c.closeTime)<=now&&Number(c.closeTime)>Number(c.openTime)&&
   finite(c?.open)&&finite(c?.high)&&finite(c?.low)&&finite(c?.close)&&finite(c?.volume)&&
   Number(c.open)>0&&Number(c.low)>0&&Number(c.high)>=Number(c.low)&&Number(c.close)>0&&Number(c.volume)>=0)
   .sort((a,b)=>Number(a.openTime)-Number(b.openTime));
 const out=[],seen=new Set();
 for(const c of valid){const key=String(c.openTime);if(seen.has(key))continue;seen.add(key);out.push(c);}
 return out;
}

export function validateClosedCandleSeries(rows,{now=Date.now(),intervalMs=60_000,minCount=2,windowBars=20,maxAgeMs=intervalMs*2.5,futureToleranceMs=2_000}={}){
 const raw=Array.isArray(rows)?rows:[];
 const futureCount=raw.filter(c=>finite(c?.openTime)&&Number(c.openTime)>Number(now)+futureToleranceMs).length;
 const closed=closedRows(raw,now),reasons=[];
 if(closed.length<Math.max(1,Number(minCount)||1))reasons.push('CLOSED_CANDLE_COUNT_INSUFFICIENT');
 if(futureCount)reasons.push('FUTURE_CANDLE_TIMESTAMP');
 const tail=closed.slice(-Math.max(2,Math.trunc(Number(windowBars)||20)));
 for(let i=1;i<tail.length;i++){const delta=Number(tail[i].openTime)-Number(tail[i-1].openTime);if(delta<Number(intervalMs)-2_000||delta>Number(intervalMs)+2_000){reasons.push('CLOSED_CANDLE_SEQUENCE_HAS_GAPS');break;}}
 const latest=closed.length?Number(closed.at(-1).closeTime):null,age=latest===null?null:Math.max(0,Number(now)-latest);
 if(age===null||age>Number(maxAgeMs))reasons.push('STALE_CLOSED_CANDLES');
 const unique=[...new Set(reasons)];
 return {ready:unique.length===0,count:closed.length,latest_close_time:latest,age_ms:age,future_candle_count:futureCount,window_bars:tail.length,reasons:unique};
}

function returnOver(rows,bars=3){return rows.length>bars?pct(rows.at(-1)?.close,rows.at(-(bars+1))?.close):null;}
function failedBreakout(rows,{now=Date.now(),lookbackBars=20,volumeRatio=null,tradeRatio=null,takerBuyRatio=null}={}){
 const bars=closedRows(rows,now),lookback=Math.max(8,Number(lookbackBars)||20),need=lookback+4;
 if(bars.length<need)return {available:false,detected:false,status:'DATA_INSUFFICIENT',resistance:null,close_location_pct:null,reason_codes:['FAILED_BREAKOUT_DATA_INSUFFICIENT']};
 const prior=bars.slice(-(lookback+4),-4),recent=bars.slice(-4),resistance=Math.max(...prior.map(c=>Number(c.high)));
 const last=recent.at(-1),range=Number(last.high)-Number(last.low),location=range>0?(Number(last.close)-Number(last.low))/range*100:50;
 const pierced=recent.some(c=>Number(c.high)>resistance*1.001),backBelow=Number(last.close)<resistance;
 const sellOrFading=Number(last.close)<Number(last.open)||(finite(takerBuyRatio)&&Number(takerBuyRatio)<0.49)||
  (finite(volumeRatio)&&Number(volumeRatio)<0.95)||(finite(tradeRatio)&&Number(tradeRatio)<0.95);
 const detected=pierced&&backBelow&&location<=55&&sellOrFading,reasons=[];
 if(pierced)reasons.push('RECENT_RESISTANCE_PIERCE');if(backBelow)reasons.push('CLOSE_BACK_BELOW_RESISTANCE');
 if(location<=55)reasons.push('WEAK_CLOSE_LOCATION');if(sellOrFading)reasons.push('SELL_PRESSURE_OR_PARTICIPATION_FADE');
 return {available:true,detected,status:detected?'FAILED_BREAKOUT_TRAP':'NO_CONFIRMED_TRAP',resistance:Number(resistance.toFixed(12)),
  close_location_pct:Number(location.toFixed(2)),pierced,closed_back_below_resistance:backBelow,sell_pressure_or_participation_fade:sellOrFading,
  reason_codes:detected?reasons:['NO_FAILED_BREAKOUT_PATTERN'],bars_examined:recent.length,lookback_bars:lookback};
}
function continuation(rows,{now=Date.now(),lookbackBars=20,minVolumeRatio=1.05,minTradeRatio=1.02}={}){
 const bars=closedRows(rows,now),lookback=Math.max(8,Number(lookbackBars)||20);
 if(bars.length<lookback+3)return {available:false,status:'DATA_INSUFFICIENT',confirmed:false,resistance:null,volume_ratio:null,trade_ratio:null,taker_buy_ratio:null,reason_codes:['CONTINUATION_DATA_INSUFFICIENT']};
 const prior=bars.slice(-(lookback+3),-3),recent=bars.slice(-3),resistance=Math.max(...prior.map(c=>Number(c.high)));
 const breakoutSeen=recent.some(c=>Number(c.close)>resistance),holds=recent.filter(c=>Number(c.close)>=resistance).length,currentAbove=Number(recent.at(-1).close)>=resistance;
 const baseV=median(bars.slice(-(lookback+3),-3).map(c=>Number(c.quoteVolume??c.volume))),recentV=mean(recent.map(c=>Number(c.quoteVolume??c.volume)));
 const baseT=median(bars.slice(-(lookback+3),-3).map(c=>Number(c.tradeCount))),recentT=mean(recent.map(c=>Number(c.tradeCount)));
 const vr=baseV>0&&Number.isFinite(recentV)?recentV/baseV:null,tr=baseT>0&&Number.isFinite(recentT)?recentT/baseT:null;
 const total=recent.reduce((s,c)=>s+Math.max(0,Number(c.volume)||0),0),buy=recent.reduce((s,c)=>s+Math.max(0,Number(c.takerBuyBaseVolume)||0),0),taker=total>0?buy/total:null;
 const retest=Number(recent.at(-2).close)<resistance&&currentAbove,activity=vr!==null&&vr>=minVolumeRatio&&tr!==null&&tr>=minTradeRatio,flow=taker!==null&&taker>=.50;
 let status='NO_BREAKOUT';if(breakoutSeen&&currentAbove&&holds>=2&&activity&&flow)status='CONFIRMED';else if(breakoutSeen&&retest&&activity&&flow)status='RETEST_HOLD';else if(breakoutSeen)status='WEAK';
 const reasons=[];if(!breakoutSeen)reasons.push('NO_RECENT_CLOSED_BREAKOUT');else{if(!currentAbove)reasons.push('PRICE_NOT_HOLDING_BREAKOUT_LEVEL');if(holds<2)reasons.push('CLOSED_CANDLE_HOLD_COUNT_LOW');if(!activity)reasons.push('ACTIVITY_NOT_SUSTAINED');if(!flow)reasons.push('TAKER_BUY_FLOW_WEAK');if(retest)reasons.push('BREAKOUT_RETEST_RECLAIMED');if(status==='CONFIRMED')reasons.push('BREAKOUT_HOLD_AND_PARTICIPATION_CONFIRMED');}
 return {available:true,status,confirmed:status==='CONFIRMED'||status==='RETEST_HOLD',resistance:Number(resistance.toFixed(12)),breakout_seen:breakoutSeen,
  holding_closes:holds,current_close_above_resistance:currentAbove,under_then_reclaimed:retest,volume_ratio:vr===null?null:Number(vr.toFixed(3)),
  trade_ratio:tr===null?null:Number(tr.toFixed(3)),taker_buy_ratio:taker===null?null:Number(taker.toFixed(3)),reason_codes:reasons,lookback_bars:lookback};
}
export function buildRadarRoleEvidence({candles=[],relativeCandles=candles,benchmarkCandles=[],peerReturns=[],marketExcessPct=null,peerExcessPct=null,now=Date.now(),intervalMs=60_000,relativeIntervalMs=intervalMs,volumeRatio=null,tradeRatio=null,takerBuyRatio=null,lookbackBars=20}={}){
 const coin=closedRows(relativeCandles,now),bench=closedRows(benchmarkCandles,now),coinReturn=returnOver(coin,3),benchReturn=returnOver(bench,3);
 const excess=Number.isFinite(coinReturn)&&Number.isFinite(benchReturn)?coinReturn-benchReturn:null;
 const peerMedian=median((Array.isArray(peerReturns)?peerReturns:[]).filter(finite).map(Number)),peerExcess=excess!==null&&peerMedian!==null?excess-peerMedian:null;
 const marketDaily=finite(marketExcessPct)?Number(marketExcessPct):null,peerDaily=finite(peerExcessPct)?Number(peerExcessPct):null;
 const statusExcess=excess??marketDaily??peerDaily;
 return {version:'RADAR_ROLE_EVIDENCE_V1',relative_strength:{available:excess!==null||marketDaily!==null||peerDaily!==null,coin_return_pct:coinReturn===null?null:Number(coinReturn.toFixed(4)),
   benchmark_return_pct:benchReturn===null?null:Number(benchReturn.toFixed(4)),excess_vs_benchmark_pct:excess===null?null:Number(excess.toFixed(4)),
   peer_median_excess_pct:peerMedian,excess_vs_peer_median_pct:peerExcess===null?null:Number(peerExcess.toFixed(4)),
   excess_vs_market_24h_pct:marketDaily===null?null:Number(marketDaily.toFixed(4)),
   excess_vs_liquidity_peers_24h_pct:peerDaily===null?null:Number(peerDaily.toFixed(4)),
   status:statusExcess===null?'UNKNOWN':statusExcess>=.25?'OUTPERFORMING':statusExcess<=-.25?'UNDERPERFORMING':'IN_LINE',
   evidence:excess!==null?'CLOSED_CANDLE_RETURN_SPREAD':marketDaily!==null||peerDaily!==null?'DAILY_MARKET_AND_LIQUIDITY_PEER_SPREAD':'BENCHMARK_CLOSED_CANDLES_UNAVAILABLE'},
  failed_breakout:failedBreakout(candles,{now,lookbackBars,volumeRatio,tradeRatio,takerBuyRatio}),continuation:continuation(candles,{now,lookbackBars})};
}


export function attachDailyRelativeStrength(rows=[]) {
  const list=Array.isArray(rows)?rows.filter(row=>row&&row.symbol):[];
  const changes=list.map(row=>row.priceChange24h).filter(finite).map(Number);
  const marketMedian=median(changes);
  return list.map(row=>{
    const move=Number(row.priceChange24h), q=Number(row.quoteVolume24h)||0;
    const peers=list.filter(peer=>{
      if(String(peer.symbol).toUpperCase()===String(row.symbol).toUpperCase()||q<=0||!finite(peer.priceChange24h))return false;
      const v=Number(peer.quoteVolume24h)||0;
      return v>=q*0.5&&v<=q*2;
    });
    const peerMedian=median(peers.map(peer=>Number(peer.priceChange24h)));
    return {...row,
      marketMedianChange24hPct:marketMedian,
      relativeStrengthMarket24hPct:finite(row.priceChange24h)&&marketMedian!==null?move-marketMedian:null,
      relativeStrengthPeer24hPct:finite(row.priceChange24h)&&peerMedian!==null?move-peerMedian:null,
      comparableLiquidityPeers:peers.length
    };
  });
}
