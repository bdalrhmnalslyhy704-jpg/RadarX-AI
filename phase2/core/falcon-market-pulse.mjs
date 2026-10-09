const clamp=(v,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number.isFinite(Number(v))?Number(v):lo));
const finite=(v,d=null)=>v!==null&&v!==undefined&&!(typeof v==='string'&&v.trim()==='')&&Number.isFinite(Number(v))?Number(v):d;
const known=(v)=>v!==null&&v!==undefined&&!(typeof v==='string'&&v.trim()==='')&&Number.isFinite(Number(v));
const pct=(a,b)=>known(a)&&known(b)&&Number(b)!==0?(Number(a)-Number(b))/Math.abs(Number(b))*100:null;
const median=(xs,fallback=null)=>{const a=xs.map(Number).filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return fallback;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;};

export function buildFastMarketPulse(row,history=[],now=Date.now(),{intervalMs=30000}={}){
  const current={
    symbol:String(row?.symbol||'').toUpperCase(),
    lastPrice:finite(row?.lastPrice,null),
    quoteVolume24h:Math.max(0,finite(row?.quoteVolume24h,0)),
    tradeCount24h:Math.max(0,finite(row?.tradeCount24h,0)),
    priceChange24h:finite(row?.priceChange24h,null),
    highPrice24h:finite(row?.highPrice24h,null),
    lowPrice24h:finite(row?.lowPrice24h,null),
    at:now
  };
  const prev=Array.isArray(history)&&history.length?history.at(-1):null;
  if(!prev||!Number.isFinite(current.lastPrice)||!Number.isFinite(prev.lastPrice)||prev.lastPrice<=0){
    return {ready:false,score:50,stage:'WARMING',symbol:current.symbol,ageMs:0,priceDeltaPct:null,priceVelocityPctPerMin:null,volumeBurstRatio:null,tradeBurstRatio:null,accelerationScore:50,baseBreakScore:50,highProximityScore:50,anomalyScore:50,marketPulseReady:false,fast_trigger:false};
  }

  const elapsed=Math.max(1000,Math.min(5*60*1000,now-Number(prev.at)||intervalMs));
  const minutes=elapsed/60000;
  const priceDelta=pct(current.lastPrice,prev.lastPrice);
  const velocity=Number.isFinite(priceDelta)?priceDelta/minutes:null;
  const expectedVolume=current.quoteVolume24h*(elapsed/86400000);
  const expectedTrades=current.tradeCount24h*(elapsed/86400000);
  const volumeDelta=Math.max(0,current.quoteVolume24h-prev.quoteVolume24h);
  const tradeDelta=Math.max(0,current.tradeCount24h-prev.tradeCount24h);
  const volumeBurst=expectedVolume>0?volumeDelta/expectedVolume:null;
  const tradeBurst=expectedTrades>0?tradeDelta/expectedTrades:null;

  const prior=Array.isArray(history)?history.slice(-6):[];
  const prevDeltas=[];
  for(let i=1;i<history.length;i++){
    const a=history[i-1],b=history[i];
    const d=pct(b.lastPrice,a.lastPrice);
    if(Number.isFinite(d))prevDeltas.push(d);
  }
  const priorVelocity=median(prevDeltas.slice(-4),0) ?? 0;
  const acceleration=Number.isFinite(priceDelta)?priceDelta-priorVelocity:null;

  const quietCount=prior.slice(-3).reduce((n,x,i)=>{
    if(i===0)return n;
    const d=pct(x.lastPrice,prior[i-1].lastPrice);
    return n+(Number.isFinite(d)&&Math.abs(d)<=0.18?1:0);
  },0);
  const baseBreakScore=clamp(45+quietCount*14+(Number.isFinite(priceDelta)&&priceDelta>=0.12?22:0));

  const positiveVelocity=Number.isFinite(velocity)?clamp(50+velocity*22):50;
  const volumeScore=Number.isFinite(volumeBurst)?clamp(42+Math.log2(Math.max(0.25,volumeBurst))*18):45;
  const tradeScore=Number.isFinite(tradeBurst)?clamp(42+Math.log2(Math.max(0.25,tradeBurst))*18):45;
  const accelerationScore=Number.isFinite(acceleration)?clamp(50+acceleration*35):50;

  const range=Number.isFinite(current.highPrice24h)&&Number.isFinite(current.lowPrice24h)&&current.highPrice24h>current.lowPrice24h
    ?current.highPrice24h-current.lowPrice24h:null;
  const position=range&&Number.isFinite(current.lastPrice)?(current.lastPrice-current.lowPrice24h)/range*100:null;
  const highProximityScore=Number.isFinite(position)?clamp(position>=75?62+(position-75)*1.52:62-(75-position)*0.9):50;

  // Ticker-pulse proxies for compression and rising lows. These are only
  // selection evidence; the deep scan still validates structure on closed candles.
  const priceTrail=[...(Array.isArray(history)?history.slice(-7).map(x=>x?.lastPrice):[]),current.lastPrice]
    .filter(known).map(Number).filter(x=>x>0);
  const pulseReturns=[];
  for(let i=1;i<priceTrail.length;i++){
    const change=pct(priceTrail[i],priceTrail[i-1]);
    if(Number.isFinite(change))pulseReturns.push(Math.abs(change));
  }
  const recentVol=pulseReturns.slice(-3),baseVol=pulseReturns.slice(-6,-3);
  const recentVolMedian=recentVol.length===3?median(recentVol,null):null;
  const baseVolMedian=baseVol.length===3?median(baseVol,null):null;
  const priceCompressionRatio=Number.isFinite(recentVolMedian)&&Number.isFinite(baseVolMedian)&&baseVolMedian>0
    ?recentVolMedian/baseVolMedian:null;
  const compressionScore=Number.isFinite(priceCompressionRatio)
    ?clamp(priceCompressionRatio<=0.65?90:priceCompressionRatio<=0.85?78:priceCompressionRatio<=1?65:priceCompressionRatio<=1.25?50:35)
    :null;
  let higherLowScore=null;
  if(priceTrail.length>=6){
    const lows=[
      Math.min(...priceTrail.slice(-6,-4)),
      Math.min(...priceTrail.slice(-4,-2)),
      Math.min(...priceTrail.slice(-2))
    ];
    higherLowScore=lows[2]>lows[1]*1.0002&&lows[1]>lows[0]*1.0002?88:
      lows[2]>=lows[1]*0.999&&lows[1]>=lows[0]*0.999&&lows[2]>lows[0]*1.0002?70:35;
  }
  const participationInputs=[volumeBurst,tradeBurst].filter(Number.isFinite);
  const participationScore=participationInputs.length
    ?clamp(50+Math.max(0,(Number.isFinite(volumeBurst)?volumeBurst:1)-1)*20+
      Math.max(0,(Number.isFinite(tradeBurst)?tradeBurst:1)-1)*15)
    :null;

  const priorVolumeBursts=prior.map(x=>Number(x.volumeBurstRatio)).filter(Number.isFinite);
  const priorTradeBursts=prior.map(x=>Number(x.tradeBurstRatio)).filter(Number.isFinite);
  const baselineVolume=median(priorVolumeBursts,1)||1;
  const baselineTrades=median(priorTradeBursts,1)||1;
  const anomalyRatio=Math.max(Number.isFinite(volumeBurst)?volumeBurst/baselineVolume:1,Number.isFinite(tradeBurst)?tradeBurst/baselineTrades:1);
  const anomalyScore=clamp(48+Math.log2(Math.max(.5,anomalyRatio))*24);

  const score=clamp(
    positiveVelocity*.20+
    volumeScore*.22+
    tradeScore*.16+
    accelerationScore*.18+
    baseBreakScore*.10+
    highProximityScore*.08+
    anomalyScore*.06
  );
  const fast_trigger=(
    (Number.isFinite(priceDelta)&&priceDelta>=0.12) ||
    (Number.isFinite(volumeBurst)&&volumeBurst>=1.8) ||
    (Number.isFinite(tradeBurst)&&tradeBurst>=1.8) ||
    (Number.isFinite(acceleration)&&acceleration>=0.10)
  );
  const explosive=Number.isFinite(priceDelta)&&priceDelta>=0.65;
  const stage=explosive?'EVENT':score>=72?'IGNITING':score>=62?'WAKING':score>=52?'WATCH':'QUIET';

  return {
    ready:true,symbol:current.symbol,score:Number(score.toFixed(1)),stage,
    ageMs:elapsed,priceDeltaPct:Number.isFinite(priceDelta)?Number(priceDelta.toFixed(4)):null,
    priceVelocityPctPerMin:Number.isFinite(velocity)?Number(velocity.toFixed(4)):null,
    volumeBurstRatio:Number.isFinite(volumeBurst)?Number(volumeBurst.toFixed(3)):null,
    tradeBurstRatio:Number.isFinite(tradeBurst)?Number(tradeBurst.toFixed(3)):null,
    accelerationScore:Number(accelerationScore.toFixed(1)),
    baseBreakScore:Number(baseBreakScore.toFixed(1)),
    highProximityScore:Number(highProximityScore.toFixed(1)),
    compressionScore:Number.isFinite(compressionScore)?Number(compressionScore.toFixed(1)):null,
    priceCompressionRatio:Number.isFinite(priceCompressionRatio)?Number(priceCompressionRatio.toFixed(3)):null,
    higherLowScore:Number.isFinite(higherLowScore)?Number(higherLowScore.toFixed(1)):null,
    participationScore:Number.isFinite(participationScore)?Number(participationScore.toFixed(1)):null,
    anomalyScore:Number(anomalyScore.toFixed(1)),
    fast_trigger,explosive,marketPulseReady:true
  };
}

export function updateMarketPulseHistory(rows,historyBySymbol=new Map(),now=Date.now(),opts={}){
  const output=[];
  const seen=new Set();
  for(const row of Array.isArray(rows)?rows:[]){
    const symbol=String(row?.symbol||'').toUpperCase();
    if(!symbol||seen.has(symbol))continue;
    seen.add(symbol);
    const history=historyBySymbol.get(symbol)||[];
    const pulse=buildFastMarketPulse(row,history,now,opts);
    const next=[...history,{...row,at:now,lastPrice:Number(row.lastPrice),volumeBurstRatio:pulse.volumeBurstRatio,tradeBurstRatio:pulse.tradeBurstRatio}].slice(-8);
    historyBySymbol.set(symbol,next);
    output.push({...row,market_pulse:pulse});
  }
  if(historyBySymbol.size>6000){
    for(const [symbol,h] of historyBySymbol){
      if(!h.length||now-Number(h.at(-1)?.at||0)>30*60*1000)historyBySymbol.delete(symbol);
    }
  }
  const up=output.filter(x=>Number(x.market_pulse?.priceDeltaPct)>0).length;
  return {
    rows:output,
    coverage:output.length,
    readyCount:output.filter(x=>x.market_pulse?.ready).length,
    breadthPct:output.length?Number((up/output.length*100).toFixed(1)):0
  };
}
