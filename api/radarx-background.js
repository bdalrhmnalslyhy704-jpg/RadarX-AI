// RadarX Server-Side Background Intelligence
// Runs independently of the browser. Spot-only public market data, multi-factor heuristic scoring,
// strict freshness validation, cooldowns, and optional Web Push / ntfy delivery.

const NTFY_TOPIC = 'radarx-alert-9c4c7b3e8e6d4a5fb7c2e1d9a6f3b8c1';
const NTFY_URL = 'https://ntfy.sh/' + NTFY_TOPIC;
const UPSTREAMS = ['https://data-api.binance.vision','https://api.binance.com'];
const EXCLUDED = /^(USDC|USDP|FDUSD|TUSD|DAI|USDE|USDS|BUSD|USDT)USDT$|(?:UP|DOWN|BULL|BEAR)USDT$|^1000[A-Z0-9]+USDT$/;
const CONFIG = {
  minQuoteVolume: 750000,
  universeLimit: 26,
  deepLimit: 18,
  alertScore: 82,
  alertTrap: 35,
  alertCooldownMs: 30 * 60 * 1000,
  maxAgeMs: 45 * 1000,
  cacheTtlMs: 25 * 1000,
  explosionUniverseLimit: 60,
  explosionResultLimit: 10,
  explosionMajorMoveLimit: 8,
  explosionMinQuoteVolume: 25000,
  explosionAlertScore: 78,
  explosionAlertTrap: 45,
  explosionAlertCooldownMs: 15 * 60 * 1000
};

let memory = { lastScanAt: 0, lastResult: null, alertMap: new Map(), explosionAlertMap: new Map() };

function n(v,d=0){ const x=Number(v); return Number.isFinite(x)?x:d; }
function clamp(v,a=0,b=100){ return Math.max(a,Math.min(b,n(v,a))); }
function avg(a){ return a.length ? a.reduce((s,x)=>s+n(x),0)/a.length : 0; }
function sum(a){ return a.reduce((s,x)=>s+n(x),0); }
function pct(a,b){ return a>0 ? (b/a-1)*100 : 0; }
function ema(values,len){
  if(!values.length)return 0;
  const k=2/(len+1); let e=values[0];
  for(let i=1;i<values.length;i++) e=values[i]*k+e*(1-k);
  return e;
}
function sd(values){
  if(!values.length)return 0;
  const m=avg(values); return Math.sqrt(avg(values.map(x=>(n(x)-m)**2)));
}
function truthy(v){ return v===true || v===1 || v==='true'; }
function timeoutFetch(url,ms=5000){
  const c=new AbortController(); const timer=setTimeout(()=>c.abort(),ms);
  return fetch(url,{headers:{Accept:'application/json'},cache:'no-store',signal:c.signal})
    .then(async r=>{ if(!r.ok)throw new Error('HTTP '+r.status); return r.json(); })
    .finally(()=>clearTimeout(timer));
}
async function binance(path){
  let last;
  for(const base of UPSTREAMS){
    try{ return await timeoutFetch(base+path,5500); }catch(e){ last=e; }
  }
  throw last || new Error('BINANCE_UNAVAILABLE');
}
function validKlines(rows){
  if(!Array.isArray(rows))return [];
  return rows.map(r=>Array.isArray(r)?({
    t:n(r[0]),o:n(r[1]),h:n(r[2]),l:n(r[3]),c:n(r[4]),v:n(r[5]),q:n(r[7]),trades:n(r[8]),tb:n(r[10])
  }):null).filter(x=>x&&x.t>0&&x.c>0&&x.h>=Math.max(x.o,x.c)&&x.l<=Math.min(x.o,x.c));
}
function closedKlines(rows,intervalMs){
  const now=Date.now();
  return validKlines(rows).filter(x=>x.t+intervalMs<=now);
}
function returnN(bars,count){
  if(bars.length<=count)return 0;
  const a=bars[bars.length-1-count]?.c, b=bars[bars.length-1]?.c;
  return pct(a,b);
}
function bollinger(bars,len=20){
  const c=bars.slice(-len).map(x=>x.c); if(c.length<len)return null;
  const m=avg(c), s=sd(c); return {mean:m,upper:m+2*s,lower:m-2*s,width:m>0?(4*s/m)*100:0};
}
function atrPct(bars,len=14){
  if(bars.length<len+1)return null;
  const trs=[];
  for(let i=1;i<bars.length;i++){
    const x=bars[i], p=bars[i-1].c;
    trs.push(Math.max(x.h-x.l,Math.abs(x.h-p),Math.abs(x.l-p)));
  }
  const atr=avg(trs.slice(-len)), c=bars.at(-1).c;
  return c>0?(atr/c)*100:0;
}
function vwap(bars,len=20){
  const a=bars.slice(-len); let pv=0,v=0;
  for(const x of a){ const tp=(x.h+x.l+x.c)/3; pv+=tp*x.v; v+=x.v; }
  return v>0?pv/v:0;
}
function depthMetrics(d){
  const bids=Array.isArray(d?.bids)?d.bids:[], asks=Array.isArray(d?.asks)?d.asks:[];
  const bn=bids.slice(0,20).reduce((s,r)=>s+n(r?.[0])*n(r?.[1]),0);
  const an=asks.slice(0,20).reduce((s,r)=>s+n(r?.[0])*n(r?.[1]),0);
  const bid=n(bids?.[0]?.[0]), ask=n(asks?.[0]?.[0]), mid=(bid+ask)/2;
  const imb=(bn+an)>0?bn/(bn+an)*100:50;
  const spread=mid>0?(ask-bid)/mid*100:null;
  return {bidNotional:bn,askNotional:an,imbalance:imb,spreadPct:spread};
}
function tradeMetrics(rows){
  const a=Array.isArray(rows)?rows.slice(-100):[];
  let buy=0,sell=0;
  for(const r of a){
    const q=n(r?.q), p=n(r?.p), notional=q*p;
    if(truthy(r?.isBuyerMaker))sell+=notional; else buy+=notional;
  }
  const total=buy+sell, buyPct=total>0?buy/total*100:50;
  return {buyNotional:buy,sellNotional:sell,buyPct,deltaPct:total>0?(buy-sell)/total*100:0};
}
async function pairFeatures(symbol,ticker,regime){
  const [m1,m5,m15,m60,depth,trades] = await Promise.all([
    binance('/api/v3/klines?symbol='+symbol+'&interval=1m&limit=130'),
    binance('/api/v3/klines?symbol='+symbol+'&interval=5m&limit=90'),
    binance('/api/v3/klines?symbol='+symbol+'&interval=15m&limit=70'),
    binance('/api/v3/klines?symbol='+symbol+'&interval=1h&limit=55'),
    binance('/api/v3/depth?symbol='+symbol+'&limit=20'),
    binance('/api/v3/aggTrades?symbol='+symbol+'&limit=100')
  ]);
  const bars1=closedKlines(m1,60000), bars5=closedKlines(m5,300000), bars15=closedKlines(m15,900000), bars60=closedKlines(m60,3600000);
  if(bars5.length<35||bars15.length<30||bars60.length<25) throw new Error('INSUFFICIENT_HISTORY');
  const last=bars5.at(-1), prev=bars5.at(-2), b20=bars5.slice(-21,-1);
  const priorHigh=b20.length?Math.max(...b20.map(x=>x.h)):last.h;
  const priorLow=b20.length?Math.min(...b20.map(x=>x.l)):last.l;
  const r5=returnN(bars5,1), r15=returnN(bars15,1), r30=returnN(bars5,6), r60=returnN(bars5,12);
  const prevR5=pct(bars5.at(-3)?.c,bars5.at(-2)?.c);
  const acceleration=r5-prevR5;
  const vavg=avg(bars5.slice(-21,-1).map(x=>x.v));
  const volumeRatio=vavg>0?last.v/vavg:0;
  const prevVolumeRatio=avg(bars5.slice(-21,-2).map(x=>x.v))>0?prev.v/avg(bars5.slice(-21,-2).map(x=>x.v)):1;
  const volumeAccel=volumeRatio-Math.max(0.1,prevVolumeRatio);
  const bb=bollinger(bars5,20), bbPrev=bollinger(bars5.slice(0,-1),20);
  const squeezeRatio=bb&&bbPrev&&bbPrev.width>0?bb.width/bbPrev.width:null;
  const atr=atrPct(bars5,14), vw=vwap(bars5,20), vwapDist=vw>0?pct(vw,last.c):0;
  const breakoutDist=pct(last.c,priorHigh);
  const breakPct=pct(priorHigh,last.c);
  const body=Math.abs(last.c-last.o), range=Math.max(1e-12,last.h-last.l);
  const upperWick=Math.max(0,last.h-Math.max(last.o,last.c))/range*100;
  const closeLocation=(last.c-last.l)/range*100;
  const dm=depthMetrics(depth), tm=tradeMetrics(trades);
  const e20=ema(bars5.map(x=>x.c).slice(-60),20), e50=ema(bars5.map(x=>x.c).slice(-80),50);
  const e15=ema(bars15.map(x=>x.c).slice(-80),20), e60=ema(bars60.map(x=>x.c).slice(-40),20);
  const mtfBull=[last.c>e20,bars15.at(-1).c>e15,bars60.at(-1).c>e60].filter(Boolean).length;
  const rs15=r15-n(regime.btc15);
  const liquidityScore=clamp(
    48 + Math.min(30,Math.log10(Math.max(1,ticker.quoteVolume/1e6))*10)
    - Math.min(18,Math.max(0,n(dm.spreadPct)-0.04)*120)
  );
  const regimeScore=clamp(50+(regime.btc15>0?12:-10)+(regime.btc60>0?16:-14)+(regime.eth15>0?7:-5)+(regime.breadth-50)*0.25);
  const momentumScore=clamp(50 + r5*24 + r15*9 + Math.max(0,acceleration)*12 - Math.max(0,r15-5)*10);
  const volumeScore=clamp(45 + Math.max(0,volumeRatio-1)*28 + Math.max(0,volumeAccel)*13);
  const compressionScore=bb?.width!=null
    ? clamp(60 + (squeezeRatio!=null?(1-squeezeRatio)*75:0) + (bb.width<2?13:0) + (atr!=null&&atr<2?8:0))
    : 50;
  const structureScore=clamp(
    breakPct>=0 ? 90 + Math.min(10,breakPct*8)
    : 72 + Math.max(0,1.2-Math.max(0,breakoutDist))*14
  );
  const flowScore=clamp(50 + (tm.buyPct-50)*1.15 + (tm.deltaPct>0?5:0));
  const bookScore=clamp(50 + (dm.imbalance-50)*1.2 - Math.max(0,n(dm.spreadPct)-0.10)*30);
  const mtfScore=mtfBull===3?96:mtfBull===2?78:mtfBull===1?56:32;
  const relativeScore=clamp(50+rs15*18+rs15*6);
  const score=(
    regimeScore*.10 + structureScore*.15 + momentumScore*.14 + volumeScore*.14 +
    compressionScore*.10 + flowScore*.12 + bookScore*.10 + mtfScore*.08 +
    relativeScore*.04 + liquidityScore*.03
  );
  let trap=8;
  const trapReasons=[];
  if(r15>4.5){trap+=18;trapReasons.push('15m overextension');}
  if(vwapDist>3.2){trap+=10;trapReasons.push('far above VWAP');}
  if(upperWick>45){trap+=12;trapReasons.push('upper-wick rejection');}
  if(volumeRatio<1.0&&r5>0.6){trap+=12;trapReasons.push('price up without volume');}
  if(dm.imbalance<43){trap+=15;trapReasons.push('bearish order-book imbalance');}
  if(tm.buyPct<44){trap+=15;trapReasons.push('sell-heavy tape');}
  if(breakPct>2.2){trap+=12;trapReasons.push('extended breakout');}
  if(mtfBull===0){trap+=16;trapReasons.push('multi-timeframe conflict');}
  trap=clamp(trap);
  let phase='NORMAL';
  const breakout=breakPct>=0.20;
  const pre=score>=82&&trap<35&&breakoutDist>=-0.10&&breakoutDist<=1.20;
  if(trap>=60)phase='EXHAUSTED-HIGH RISK';
  else if(breakout)phase='BREAKOUT';
  else if(pre)phase='PRE-BREAKOUT';
  else if(score>=68)phase='BUILDING';
  const entry=breakout?last.c:priorHigh*1.0015;
  const riskUnit=Math.max((atr||0.6)*last.c/100,last.c*0.004);
  const sl=Math.max(0,last.c-riskUnit);
  const tp1=entry+riskUnit*1.2, tp2=entry+riskUnit*2.0, tp3=entry+riskUnit*3.0;
  const reasons=[];
  if(regimeScore>=68)reasons.push('BTC/ETH regime supportive');
  if(mtfBull>=2)reasons.push('multi-timeframe alignment');
  if(volumeRatio>=1.4)reasons.push('relative volume expansion');
  if(squeezeRatio!=null&&squeezeRatio<0.82)reasons.push('volatility compression');
  if(breakoutDist>=0&&breakoutDist<=0.8)reasons.push('near prior resistance');
  if(dm.imbalance>=57)reasons.push('bid-side depth advantage');
  if(tm.buyPct>=57)reasons.push('buy-dominant tape');
  if(rs15>=0.7)reasons.push('relative strength vs BTC');
  return {
    symbol, price:last.c, change24:n(ticker.priceChangePercent), quoteVolume:n(ticker.quoteVolume),
    score:Math.round(clamp(score)), trapRisk:Math.round(trap), phase, breakout,
    r5,r15,r30,r60,volumeRatio:+volumeRatio.toFixed(2),squeezeRatio:squeezeRatio==null?null:+squeezeRatio.toFixed(2),
    atrPct:atr==null?null:+atr.toFixed(2),vwapDist:+vwapDist.toFixed(2),breakoutDist:+breakoutDist.toFixed(2),
    orderImbalance:+dm.imbalance.toFixed(1),spreadPct:dm.spreadPct==null?null:+dm.spreadPct.toFixed(3),
    tapeBuyPct:+tm.buyPct.toFixed(1),deltaPct:+tm.deltaPct.toFixed(1),mtfBull,relativeStrength:+rs15.toFixed(2),
    entry:+entry.toPrecision(12),sl:+sl.toPrecision(12),tp1:+tp1.toPrecision(12),tp2:+tp2.toPrecision(12),tp3:+tp3.toPrecision(12),
    reasons,rejections:trapReasons,checkedAt:Date.now(),dataFresh:true
  };
}
async function marketRegime(tickers){
  const [b5,b60,e5]=await Promise.all([
    binance('/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=70'),
    binance('/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=40'),
    binance('/api/v3/klines?symbol=ETHUSDT&interval=5m&limit=70')
  ]);
  const B5=closedKlines(b5,300000), B60=closedKlines(b60,3600000), E5=closedKlines(e5,300000);
  const pos=tickers.filter(x=>n(x.priceChangePercent)>0).length, breadth=tickers.length?pos/tickers.length*100:50;
  return {btc15:returnN(B5,3),btc60:returnN(B60,3),eth15:returnN(E5,3),breadth};
}
function candidateTickerSort(a){
  const vol=clamp(Math.log10(Math.max(1,n(a.quoteVolume)/1e6))*24);
  const move=Math.min(30,Math.abs(n(a.priceChangePercent))*3.2);
  const up=Math.max(0,n(a.priceChangePercent))*2.2;
  return vol+move+up;
}

function explosionTickerPriority(t){
  const move=Math.max(0,n(t?.priceChangePercent));
  const volume=Math.log10(Math.max(1,n(t?.quoteVolume)/Math.max(1,CONFIG.explosionMinQuoteVolume)))*8;
  const range=n(t?.highPrice)>0&&n(t?.lowPrice)>0&&n(t?.lastPrice)>0
    ?Math.max(0,(n(t.lastPrice)/n(t.lowPrice)-1)*1.2-Math.max(0,(n(t.highPrice)-n(t.lastPrice))/n(t.lastPrice)*.35))
    :0;
  return move*4.2+volume+range;
}
function closedExplosionRows(rows,intervalMs){
  const now=Date.now();
  return validKlines(rows).filter(x=>x.t+intervalMs<=now);
}
function explosionAvg(values){return values.length?values.reduce((s,x)=>s+n(x),0)/values.length:0}
function explosionPct(a,b){return a>0&&b>0?(b/a-1)*100:0}
function explosionRangeRatio(bars){
  if(bars.length<26)return null;
  const recent=explosionAvg(bars.slice(-5).map(x=>(x.h-x.l)/Math.max(x.c,1e-12)));
  const base=explosionAvg(bars.slice(-21,-5).map(x=>(x.h-x.l)/Math.max(x.c,1e-12)));
  return base>0?recent/base:null;
}
function explosionBbRatio(bars){
  if(bars.length<42)return null;
  function width(xs){
    const c=xs.slice(-20).map(x=>x.c),m=explosionAvg(c);
    if(!m)return 0;
    const s=Math.sqrt(explosionAvg(c.map(v=>(v-m)*(v-m))));
    return 4*s/m;
  }
  const cur=width(bars),prior=[];
  for(let i=Math.max(20,bars.length-45);i<bars.length-5;i++){
    const w=width(bars.slice(0,i+1));if(w>0)prior.push(w);
  }
  if(!prior.length||cur<=0)return null;
  prior.sort((a,b)=>a-b);
  return cur/(prior[Math.floor((prior.length-1)*.2)]||cur);
}
function explosionState(f){
  if((f.move24h>=25||f.r30>=10||f.r60>=18)&&!(f.move24h>=15&&f.r15<.35&&f.accel5<0))
    return f.move24h>=60?'MAJOR_MOVE':'STRONG_MOVE';
  if(f.move24h>=15&&f.r15<.35&&f.accel5<0)return 'EXTENDED_LATE';
  if((f.r15>=2.5||f.r30>=5)&&((f.volumeRatio??0)>=1.35||f.accel5>.15))return 'EXPLOSION';
  if((f.r5>=.8||f.r15>=1.6||f.r30>=3)&&((f.volumeRatio??0)>=1.25||f.accel5>.15))return 'ACCELERATING';
  if(f.score>=70&&f.move24h<=12)return 'EARLY';
  if(f.score>=58)return 'BUILDING';
  return 'WATCH';
}
function scoreExplosionFeatures(ticker,bars1,bars5){
  if(bars5.length<30)return {available:false,state:'NO_DATA',score:0,reason:'INSUFFICIENT_CLOSED_5M'};
  const last=bars5.at(-1),prev=bars5.at(-2);
  const move24=n(ticker?.priceChangePercent),lastPrice=n(ticker?.lastPrice)||last.c;
  const r1=explosionPct(bars1.at(-2)?.c,bars1.at(-1)?.c);
  const r5=explosionPct(prev.c,last.c),r15=explosionPct(bars5.at(-4)?.c,last.c),r30=explosionPct(bars5.at(-7)?.c,last.c),r60=explosionPct(bars5.at(-13)?.c,last.c);
  const prevR5=explosionPct(bars5.at(-3)?.c,prev.c),accel5=r5-prevR5;
  const baseVol=explosionAvg(bars5.slice(-21,-1).map(x=>x.v)),prevBaseVol=explosionAvg(bars5.slice(-22,-2).map(x=>x.v));
  const vr=baseVol>0?last.v/baseVol:null,prevVr=prevBaseVol>0?prev.v/prevBaseVol:null,volAccel=vr!=null&&prevVr!=null?vr-prevVr:0;
  const rr=explosionRangeRatio(bars5),squeeze=explosionBbRatio(bars5);
  const prior=bars5.length>=22?Math.max(...bars5.slice(-21,-1).map(x=>x.h)):last.h;
  const breakoutPct=prior>0?(last.c/prior-1)*100:0;
  const hi=n(ticker?.highPrice),lo=n(ticker?.lowPrice);
  const hiDist=hi>0&&last.c>0?(hi-last.c)/last.c*100:null;
  const fromLow=lo>0&&last.c>0?(last.c/lo-1)*100:null;
  const closePos=(last.c-last.l)/Math.max(last.h-last.l,1e-12);
  const rangeNow=(last.h-last.l)/Math.max(last.c,1e-12)*100;
  const momentum=clamp(50+r5*34+r15*10+r30*4+Math.max(0,accel5)*30);
  const volume=clamp(45+(vr==null?0:(vr-1)*30)+Math.max(0,volAccel)*25);
  const expansion=clamp(45+(rr==null?0:(rr-1)*34)+(breakoutPct>0?24:0)+(rangeNow>1.8?7:0));
  const pressure=clamp(52+(hiDist==null?0:Math.max(0,3-hiDist)*16)+(squeeze!=null&&squeeze<1?14:0)+(closePos>.72?10:0));
  const persistence=clamp(50+(r15>0?Math.min(20,r15*8):0)+(r30>0?Math.min(14,r30*3):0)+(move24>0?Math.min(16,move24*.35):0));
  let score=clamp(momentum*.34+volume*.28+expansion*.16+pressure*.12+persistence*.10);
  const cooling=move24>=15&&r15<.35&&accel5<0;
  if(cooling)score=clamp(score-12);
  const trap=clamp((cooling?28:0)+(hiDist!=null&&hiDist>4?8:0)+(r15<0&&r30<0?18:0)+(vr!=null&&vr<.85&&r5>.6?14:0)+(closePos<.35&&r5>0?10:0));
  const reasons=[];
  if(r5>=.8)reasons.push('5m momentum acceleration');
  if(r15>=1.6)reasons.push('15m expansion');
  if(vr!=null&&vr>=1.4)reasons.push('relative volume surge');
  if(volAccel>.15)reasons.push('volume rate accelerating');
  if(breakoutPct>0)reasons.push('fresh local range break');
  if(squeeze!=null&&squeeze<1)reasons.push('compression releasing');
  if(hiDist!=null&&hiDist<=1.2)reasons.push('near 24h high');
  if(move24>=25)reasons.push('major 24h move');
  const f={available:true,symbol:String(ticker?.symbol||''),price:lastPrice,move24h:+move24.toFixed(2),
    r1:+r1.toFixed(3),r5:+r5.toFixed(3),r15:+r15.toFixed(3),r30:+r30.toFixed(3),r60:+r60.toFixed(3),accel5:+accel5.toFixed(3),
    volumeRatio:vr==null?null:+vr.toFixed(2),volumeAccel:+volAccel.toFixed(3),rangeRatio:rr==null?null:+rr.toFixed(2),
    squeezeRatio:squeeze==null?null:+squeeze.toFixed(2),breakoutPct:+breakoutPct.toFixed(2),
    distanceToHigh24h:hiDist==null?null:+hiDist.toFixed(2),moveFromLow24h:fromLow==null?null:+fromLow.toFixed(2),
    closePosition:+closePos.toFixed(3),score:+score.toFixed(1),trapRisk:Math.round(trap),reasons};
  f.state=explosionState(f);return f;
}
async function scanExplosionUniverse(universe){
  const majorMoves=universe.filter(x=>n(x.priceChangePercent)>=25)
    .sort((a,b)=>n(b.priceChangePercent)-n(a.priceChangePercent)).slice(0,CONFIG.explosionMajorMoveLimit)
    .map(x=>({symbol:String(x.symbol),price:n(x.lastPrice),move24h:+n(x.priceChangePercent).toFixed(2),quoteVolume:n(x.quoteVolume),
      moveFromLow24h:n(x.lowPrice)>0?+(n(x.lastPrice)/n(x.lowPrice)-1)*100:null,
      distanceToHigh24h:n(x.highPrice)>0&&n(x.lastPrice)>0?+(n(x.highPrice)-n(x.lastPrice))/n(x.lastPrice)*100:null,
      state:n(x.priceChangePercent)>=60?'MAJOR_MOVE':'STRONG_MOVE',source:'BINANCE_PUBLIC_24H_TICKER'}));
  const pool=universe.filter(x=>n(x.quoteVolume)>=CONFIG.explosionMinQuoteVolume&&n(x.lastPrice)>0)
    .sort((a,b)=>explosionTickerPriority(b)-explosionTickerPriority(a)).slice(0,CONFIG.explosionUniverseLimit);
  const rows=[];
  for(let i=0;i<pool.length;i+=8){
    const batch=pool.slice(i,i+8);
    const settled=await Promise.allSettled(batch.map(async t=>{
      const [m1,m5]=await Promise.all([
        binance('/api/v3/klines?symbol='+t.symbol+'&interval=1m&limit=120'),
        binance('/api/v3/klines?symbol='+t.symbol+'&interval=5m&limit=80')
      ]);
      return scoreExplosionFeatures(t,closedExplosionRows(m1,60000),closedExplosionRows(m5,300000));
    }));
    settled.forEach(x=>{if(x.status==='fulfilled'&&x.value?.available)rows.push(x.value);});
  }
  rows.sort((a,b)=>b.score-a.score);
  const candidates=rows.slice(0,CONFIG.explosionResultLimit),alerts=[],now=Date.now();
  for(const x of rows){
    if(!['EARLY','ACCELERATING','EXPLOSION'].includes(x.state)||x.score<CONFIG.explosionAlertScore||x.trapRisk>=CONFIG.explosionAlertTrap)continue;
    const key='radarx:explosion:'+x.symbol;let recent=false;
    if(kvConfig()){try{const raw=await kv('get',[key]);const ts=n(raw,0);recent=ts>0&&now-ts<CONFIG.explosionAlertCooldownMs;}catch{}}
    else{const prior=memory.explosionAlertMap.get(x.symbol)||0;recent=now-prior<CONFIG.explosionAlertCooldownMs;}
    if(recent)continue;
    if(kvConfig())await kvSet(key,String(now),Math.ceil(CONFIG.explosionAlertCooldownMs/1000)).catch(()=>{});
    memory.explosionAlertMap.set(x.symbol,now);
    alerts.push({...x,alertKind:'MARKET_EXPLOSION'});
    await sendAlert({...x,phase:x.state,score:x.score,trapRisk:x.trapRisk}).catch(()=>{});
    if(alerts.length>=3)break;
  }
  return {engine:'RadarX Market Explosion / Anomaly 1.0',universe:universe.length,lightScanned:pool.length,candidates,majorMoves,alerts,asOf:new Date().toISOString(),
    rules:{minQuoteVolume:CONFIG.explosionMinQuoteVolume,universeLimit:CONFIG.explosionUniverseLimit,resultLimit:CONFIG.explosionResultLimit,alertScore:CONFIG.explosionAlertScore,alertTrap:CONFIG.explosionAlertTrap}};
}
async function scan(){
  const now=Date.now();
  if(memory.lastResult&&now-memory.lastScanAt<CONFIG.cacheTtlMs)return memory.lastResult;
  const tickers=await binance('/api/v3/ticker/24hr');
  if(!Array.isArray(tickers))throw new Error('INVALID_TICKER_RESPONSE');
  const allSpotUniverse=tickers.filter(x=>x&&/USDT$/.test(String(x.symbol||''))&&!EXCLUDED.test(String(x.symbol||''))&&n(x.lastPrice)>0);
  const universe=allSpotUniverse.filter(x=>n(x.quoteVolume)>=CONFIG.minQuoteVolume);
  const explosionPromise=scanExplosionUniverse(allSpotUniverse).catch(e=>({engine:'RadarX Market Explosion / Anomaly 1.0',universe:allSpotUniverse.length,lightScanned:0,candidates:[],majorMoves:[],alerts:[],error:String(e?.message||e),asOf:new Date().toISOString()}));
  const regime=await marketRegime(universe);
  const candidates=universe.sort((a,b)=>candidateTickerSort(b)-candidateTickerSort(a)).slice(0,CONFIG.universeLimit);
  const selected=candidates.slice(0,CONFIG.deepLimit);
  const settled=await Promise.allSettled(selected.map(x=>pairFeatures(String(x.symbol),x,regime)));
  const rows=settled.filter(x=>x.status==='fulfilled').map(x=>x.value)
    .filter(x=>x.dataFresh&&Date.now()-x.checkedAt<=CONFIG.maxAgeMs)
    .sort((a,b)=>b.score-a.score);
  const alerts=[];
  for(const x of rows){
    if(x.score<CONFIG.alertScore||x.trapRisk>=CONFIG.alertTrap)continue;
    if(!['PRE-BREAKOUT','BREAKOUT'].includes(x.phase))continue;
    const key='radarx:alert:'+x.symbol;
    let recent=false;
    if(kvConfig()){
      try{
        const raw=await kv('get',[key]);
        const ts=n(raw,0);
        recent=ts>0&&now-ts<CONFIG.alertCooldownMs;
      }catch{}
    }else{
      const prior=memory.alertMap.get(x.symbol)||0;
      recent=now-prior<CONFIG.alertCooldownMs;
    }
    if(recent)continue;
    if(kvConfig())await kvSet(key,String(now),Math.ceil(CONFIG.alertCooldownMs/1000)).catch(()=>{});
    memory.alertMap.set(x.symbol,now);
    alerts.push(x);
    await sendAlert(x).catch(()=>{});
    if(alerts.length>=3)break;
  }
  const explosion=await explosionPromise;
  const result={ok:true,engine:'RadarX Background Intelligence 5.13',checkedAt:now,universe:universe.length,spotUniverse:allSpotUniverse.length,deepScanned:rows.length,regime,alerts,top:rows.slice(0,8),explosion,freshness:{maxAgeMs:CONFIG.maxAgeMs,serverTs:now}};
  memory.lastScanAt=now; memory.lastResult=result;
  await kvSet('radarx:last-scan',result,600).catch(()=>{});
  return result;
}
function kvConfig(){
  const url=String(process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL||'').trim();
  const token=String(process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN||'').trim();
  return url&&token?{url,token}:null;
}
async function kv(cmd,args=[]){
  const c=kvConfig(); if(!c)throw new Error('KV_NOT_CONFIGURED');
  const r=await fetch(c.url,{method:'POST',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:JSON.stringify([cmd,...args])});
  if(!r.ok)throw new Error('KV_HTTP_'+r.status);
  const d=await r.json(); if(d.error)throw new Error(String(d.error)); return d.result;
}
async function kvSet(key,value,ttlSec=600){ return kv('set',[key,JSON.stringify(value),'EX',String(ttlSec)]); }
async function ensureVapid(){
  const envPub=String(process.env.RADARX_VAPID_PUBLIC_KEY||'').trim();
  const envPriv=String(process.env.RADARX_VAPID_PRIVATE_KEY||'').trim();
  if(envPub&&envPriv)return {publicKey:envPub,privateKey:envPriv};
  if(!kvConfig())return null;
  try{
    const cached=JSON.parse(await kv('get',['radarx:vapid'])||'null');
    if(cached?.publicKey&&cached?.privateKey)return cached;
  }catch{}
  try{
    const wp=(await import('web-push')).default || (await import('web-push'));
    const generated=wp.generateVAPIDKeys();
    await kvSet('radarx:vapid',generated,31536000);
    return generated;
  }catch{return null;}
}
async function sendWebPush(payload){
  const vapid=await ensureVapid(); if(!vapid)return 0;
  const wp=(await import('web-push')).default || (await import('web-push'));
  wp.setVapidDetails('mailto:alerts@radarx.app',vapid.publicKey,vapid.privateKey);
  const subs=await kv('smembers',['radarx:push:subs']);
  if(!Array.isArray(subs)||!subs.length)return 0;
  let sent=0;
  for(const raw of subs){
    try{ await wp.sendNotification(typeof raw==='string'?JSON.parse(raw):raw,JSON.stringify({title:'⚡ RadarX — '+payload.symbol,body:payload.body,url:'/','symbol':payload.symbol,tag:'radarx-'+payload.symbol})); sent++; }
    catch(e){ const code=n(e?.statusCode); if(code===404||code===410)await kv('srem',['radarx:push:subs',raw]).catch(()=>{}); }
  }
  return sent;
}
async function sendNtfy(x){
  const body=[
    'RadarX رصد فرصة تحتاج مراجعة',
    x.symbol+' · '+x.phase+' · Score '+x.score+'/100 · Trap '+x.trapRisk+'/100',
    'السعر: '+x.price,
    'دخول مشروط: '+x.entry,
    'SL: '+x.sl+' · TP1: '+x.tp1+' · TP2: '+x.tp2+' · TP3: '+x.tp3,
    'الأدلة: '+(x.reasons||[]).slice(0,5).join(' | '),
    'وقت الفحص: '+new Date(x.checkedAt).toLocaleString('en-US',{timeZone:'UTC'})+' UTC'
  ].join('\n');
  try{
    const r=await fetch(NTFY_URL,{method:'POST',headers:{Title:'RadarX '+x.symbol,Priority:'high',Tags:'rocket,chart_with_upwards_trend',Click:'https://radar-x-ai.vercel.app/','Content-Type':'text/plain; charset=utf-8'},body});
    return r.ok;
  }catch{return false;}
}
async function sendAlert(x){
  const body=(x.reasons||[]).slice(0,5).join(' · ')||'Multi-factor opportunity';
  await Promise.allSettled([sendNtfy(x),sendWebPush({symbol:x.symbol,body:x.phase+' · Score '+x.score+'/100 · Trap '+x.trapRisk+'/100\n'+body})]);
}
async function status(){
  let last=memory.lastResult;
  if(!last&&kvConfig())try{last=JSON.parse(await kv('get',['radarx:last-scan'])||'null')}catch{}
  return {ok:true,engine:'RadarX Background Intelligence 5.13',schedule:'5-minute GitHub Actions + foreground WebSocket',ntfyTopic:NTFY_TOPIC,ntfyUrl:NTFY_URL,webPushConfigured:!!(kvConfig()&&(process.env.RADARX_VAPID_PUBLIC_KEY&&process.env.RADARX_VAPID_PRIVATE_KEY||true)),kvConfigured:!!kvConfig(),lastScan:last?{checkedAt:last.checkedAt,universe:last.universe,spotUniverse:last.spotUniverse||null,deepScanned:last.deepScanned,alerts:last.alerts?.length||0,explosionAlerts:last.explosion?.alerts?.length||0,majorMoves:last.explosion?.majorMoves?.length||0,top:last.top?.[0]||null}:null,limits:{minQuoteVolume:CONFIG.minQuoteVolume,alertScore:CONFIG.alertScore,alertTrap:CONFIG.alertTrap,explosionMinQuoteVolume:CONFIG.explosionMinQuoteVolume,explosionUniverseLimit:CONFIG.explosionUniverseLimit,explosionAlertScore:CONFIG.explosionAlertScore}};
}
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept');
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return res.status(405).json({ok:false,error:'METHOD_NOT_ALLOWED'});
  const mode=String(req.query?.mode||'status');
  try{
    if(mode==='status'||mode==='config')return res.status(200).json(await status());
    if(mode==='test-alert'){
      const fake={symbol:'RADARX-TEST',phase:'TEST',score:99,trapRisk:1,price:1,entry:1,sl:.99,tp1:1.02,tp2:1.04,tp3:1.06,reasons:['اختبار قناة التنبيه'] ,checkedAt:Date.now()};
      const nt=await sendNtfy(fake);
      const wp=await sendWebPush({symbol:fake.symbol,body:'اختبار ناجح لقناة التنبيه الخلفية'});
      return res.status(200).json({ok:true,ntfy:nt,webPush:wp});
    }
    const result=await scan();
    return res.status(200).json(result);
  }catch(e){
    return res.status(502).json({ok:false,error:String(e?.message||e),engine:'RadarX Background Intelligence 5.13',checkedAt:Date.now()});
  }
}
