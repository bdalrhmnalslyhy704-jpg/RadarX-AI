import {timeframeMs} from '../../phase1/radarx-phase1-engine.mjs';

export const finite = v => Number.isFinite(Number(v));

export function validateCandle(c){
  const ok=Boolean(c)&&[c.openTime,c.closeTime,c.open,c.high,c.low,c.close,c.volume].every(finite)&&
    c.openTime<c.closeTime&&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close)&&
    c.high>=c.low&&c.volume>=0;
  return {valid:ok,issues:ok?[]:['INVALID_CANDLE']};
}

export function validateSeries(a,tf){
  const issues=[];const step=timeframeMs(tf);
  for(let i=0;i<a.length;i++){
    if(!validateCandle(a[i]).valid)issues.push(tf+':INVALID_'+i);
    if(i){
      const d=Number(a[i].openTime)-Number(a[i-1].openTime);
      if(d<=0)issues.push(tf+':UNORDERED_'+i);
      if(step&&d!==step)issues.push(tf+':GAP_'+i);
    }
  }
  return {valid:issues.length===0,issues};
}

export function latestClosed(a){return [...a].reverse().find(x=>x?.closed===true)||null;}
export function futureIssues(a,now=Date.now()){
  return a.flatMap((x,i)=>Number(x?.openTime)>now||Number(x?.closeTime)>now?['FUTURE_'+i]:[]);
}
export function expectedGap(previous,current,tf){
  const step=timeframeMs(tf);if(!previous||!current||!step)return[];
  const gaps=[];for(let t=Number(previous.openTime)+step;t<Number(current.openTime);t+=step)gaps.push(t);return gaps;
}
export function assessDataGate({series4h,series1h,series15m,now=Date.now(),sourceLive,unresolvedGap=false,
  minDataQuality=70,maxStaleTriggerMs=1800000}){
  const v4=validateSeries(series4h,'4h'),v1=validateSeries(series1h,'1h'),v15=validateSeries(series15m,'15m');
  const future=futureIssues([...series4h,...series1h,...series15m],now);
  const trigger=latestClosed(series15m);
  const staleMs=trigger?Math.max(0,now-Number(trigger.closeTime)):Infinity;
  let quality=100;const integrity=v4.issues.length+v1.issues.length+v15.issues.length;
  quality-=Math.min(60,integrity*10);if(staleMs>60000)quality-=Math.min(25,Math.floor(staleMs/60000)*5);
  if(!trigger||!sourceLive||unresolvedGap||future.length)quality=0;
  quality=Math.max(0,Math.min(100,quality));
  const blocked=[];
  if(!sourceLive)blocked.push('MARKET_SOURCE_DISCONNECTED');
  if(!trigger)blocked.push('NO_COMPLETED_TRIGGER_CANDLE');
  if(unresolvedGap)blocked.push('UNRESOLVED_GAP');
  if(future.length)blocked.push('FUTURE_DATA');
  if(staleMs>maxStaleTriggerMs)blocked.push('STALE_DATA');
  if(!v4.valid||!v1.valid||!v15.valid)blocked.push('SERIES_INTEGRITY_FAILURE');
  if(quality<minDataQuality)blocked.push('LOW_DATA_QUALITY');
  return {allowed:blocked.length===0,quality,blocked,staleMs,latestClosed15m:trigger?.closeTime??null,futureIssues:future,series:{v4,v1,v15}};
}

export function assessLiquidity({book,ticker24h,minQuality=60}){
  if(!book?.bids?.length||!book?.asks?.length)return{quality:0,allowed:false,reasons:['LIQUIDITY_DATA_UNAVAILABLE'],spreadBps:null};
  const bid=Number(book.bids[0][0]),ask=Number(book.asks[0][0]);if(!(bid>0)||!(ask>=bid))
    return{quality:0,allowed:false,reasons:['INVALID_BOOK'],spreadBps:null};
  const spreadBps=(ask-bid)/((ask+bid)/2)*10000,mid=(bid+ask)/2,lo=mid*0.995,hi=mid*1.005;
  let bd=0,ad=0;for(const [p,q] of book.bids){if(Number(p)>=lo&&Number(q)>=0)bd+=Number(p)*Number(q);}
  for(const [p,q] of book.asks){if(Number(p)<=hi&&Number(q)>=0)ad+=Number(p)*Number(q);}
  const total=bd+ad,qv=Number(ticker24h?.quoteVolume),tc=Number(ticker24h?.count);
  const c=[Math.max(0,Math.min(100,100*(1-spreadBps/20))),total>100000?100:total>25000?80:total>5000?60:30];
  if(Number.isFinite(qv))c.push(Math.max(0,Math.min(100,(Math.log10(Math.max(1,qv))-4)/4*100)));
  if(Number.isFinite(tc))c.push(Math.max(0,Math.min(100,tc)));
  const quality=c.reduce((a,b)=>a+b,0)/c.length,reasons=[];
  if(spreadBps>20)reasons.push('WIDE_SPREAD');if(quality<minQuality)reasons.push('LOW_LIQUIDITY');
  return {quality,allowed:reasons.length===0,reasons,spreadBps,bid,ask,totalDepth:total,bidDepth:bd,askDepth:ad};
}
export function sourceIsLive({wsState,restLastSuccessAt,now=Date.now(),maxStaleMs=1800000}){
  return wsState==='LIVE'||(Number.isFinite(restLastSuccessAt)&&now-restLastSuccessAt<=maxStaleMs);
}
