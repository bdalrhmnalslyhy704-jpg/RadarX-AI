import {
  buildSpotUniverse,
  rankTickerRows,
  rankBottomTickerRows,
  normalizeRadarLimit,
  boundedMap,
  MarketUniverseScanner
} from '../market/universe-scanner.mjs';

const clamp=(x,lo=0,hi=100)=>{
  const n=Number(x);
  return Number.isFinite(n)?Math.max(lo,Math.min(hi,n)):50;
};
const avg=(xs)=>{
  const a=xs.map(Number).filter(Number.isFinite);
  return a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
};
const mean=(xs)=>avg(xs);
const safe=(x,d=null)=>Number.isFinite(Number(x))?Number(x):d;
const pct=(a,b)=>Number.isFinite(Number(a))&&Number.isFinite(Number(b))&&Number(b)>0?(Number(a)-Number(b))/Number(b)*100:null;
const closed=(rows,now)=>{
  return (Array.isArray(rows)?rows:[]).filter(c=>
    c && c.closed!==false &&
    Number.isFinite(Number(c.closeTime)) &&
    Number(c.closeTime)<=now &&
    Number.isFinite(Number(c.open)) &&
    Number.isFinite(Number(c.high)) &&
    Number.isFinite(Number(c.low)) &&
    Number.isFinite(Number(c.close)) &&
    Number(c.high)>=Number(c.low)
  );
};
const values=(rows,key)=>rows.map(x=>Number(x?.[key])).filter(Number.isFinite);
const closes=rows=>values(rows,'close');
const emaLast=(xs,period)=>{
  const a=xs.map(Number).filter(Number.isFinite);
  if(!a.length)return null;
  const p=Math.max(2,Math.trunc(period));
  let out=avg(a.slice(0,p));
  if(!Number.isFinite(out))out=a[0];
  const alpha=2/(p+1);
  for(const x of a.slice(p))out=alpha*x+(1-alpha)*out;
  return out;
};
const rsiLast=(xs,period=14)=>{
  const a=xs.map(Number).filter(Number.isFinite);
  if(a.length<period+1)return null;
  let g=0,l=0;
  for(let i=1;i<=period;i++){const d=a[i]-a[i-1];if(d>=0)g+=d;else l-=d;}
  let ag=g/period,al=l/period;
  for(let i=period+1;i<a.length;i++){
    const d=a[i]-a[i-1],gg=Math.max(0,d),ll=Math.max(0,-d);
    ag=(ag*(period-1)+gg)/period;
    al=(al*(period-1)+ll)/period;
  }
  return al===0?100:100-(100/(1+ag/al));
};
const std=(xs)=>{
  const a=xs.map(Number).filter(Number.isFinite);
  if(!a.length)return null;
  const m=avg(a); return Math.sqrt(avg(a.map(x=>(x-m)**2)));
};
const atrLast=(rows,period=14)=>{
  const a=Array.isArray(rows)?rows:[]; if(a.length<2)return null;
  const tr=[];
  for(let i=1;i<a.length;i++){
    const h=Number(a[i].high),l=Number(a[i].low),pc=Number(a[i-1].close);
    if(Number.isFinite(h)&&Number.isFinite(l)&&Number.isFinite(pc))tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  return avg(tr.slice(-period));
};
const atrRatio=(rows)=>{
  const a=Array.isArray(rows)?rows:[]; if(a.length<50)return null;
  const ranges=a.map(x=>Number(x.high)-Number(x.low)).filter(Number.isFinite);
  const short=avg(ranges.slice(-8)),base=avg(ranges.slice(-40,-8));
  return Number.isFinite(short)&&Number.isFinite(base)&&base>0?short/base:null;
};
const bbRatio=(rows)=>{
  const c=closes(rows); if(c.length<42)return null;
  const widths=[];
  for(let i=19;i<c.length;i++){
    const w=c.slice(i-19,i+1),m=avg(w),sdv=std(w);
    if(Number.isFinite(m)&&m>0&&Number.isFinite(sdv))widths.push(4*sdv/m);
  }
  const now=widths.at(-1),base=avg(widths.slice(-21,-1));
  return Number.isFinite(now)&&Number.isFinite(base)&&base>0?now/base:null;
};
const roc=(c,n)=>c.length>n&&c.at(-n-1)>0?(c.at(-1)-c.at(-n-1))/c.at(-n-1)*100:null;
const slopePct=(c,n)=>{
  const a=c.slice(-n); if(a.length<4)return null;
  const first=a[0],last=a.at(-1); return first>0?(last-first)/first*100:null;
};
const pivotLows=(rows)=>{
  const out=[];for(let i=2;i<rows.length-2;i++){
    const x=Number(rows[i].low);if(!Number.isFinite(x))continue;
    if(x<=Number(rows[i-1].low)&&x<=Number(rows[i-2].low)&&x<=Number(rows[i+1].low)&&x<=Number(rows[i+2].low))out.push({i,price:x});
  }return out;
};
const pivotHighs=(rows)=>{
  const out=[];for(let i=2;i<rows.length-2;i++){
    const x=Number(rows[i].high);if(!Number.isFinite(x))continue;
    if(x>=Number(rows[i-1].high)&&x>=Number(rows[i-2].high)&&x>=Number(rows[i+1].high)&&x>=Number(rows[i+2].high))out.push({i,price:x});
  }return out;
};
const takerRatio=(rows)=>{
  const v=rows.slice(-8).reduce((s,x)=>s+(Number(x.volume)||0),0);
  const b=rows.slice(-8).reduce((s,x)=>s+(Number(x.takerBuyBaseVolume)||0),0);
  return v>0?b/v:null;
};
const upVolRatio=(rows)=>{
  const recent=rows.slice(-8), prev=rows.slice(-16,-8);
  const ru=recent.reduce((s,x)=>s+(Number(x.close)>Number(x.open)?Number(x.volume)||0:0),0);
  const rd=recent.reduce((s,x)=>s+(Number(x.close)<Number(x.open)?Number(x.volume)||0:0),0);
  const pu=prev.reduce((s,x)=>s+(Number(x.close)>Number(x.open)?Number(x.volume)||0:0),0);
  const pd=prev.reduce((s,x)=>s+(Number(x.close)<Number(x.open)?Number(x.volume)||0:0),0);
  return {bias:(ru+rd)>0?(ru-rd)/(ru+rd):null,acceleration:(pu+pd)>0?(ru+rd)/(pu+pd):null};
};
const rvol=(rows)=>{
  const a=rows.map(x=>Number(x.volume)).filter(Number.isFinite);
  const short=avg(a.slice(-8)),base=avg(a.slice(-28,-8));
  return Number.isFinite(short)&&Number.isFinite(base)&&base>0?short/base:null;
};
const orderbookMetrics=(depth,price)=>{
  const bids=Array.isArray(depth?.bids)?depth.bids:[],asks=Array.isArray(depth?.asks)?depth.asks:[];
  const mid=Number.isFinite(Number(price))?Number(price):
    (Number(bids[0]?.[0])+Number(asks[0]?.[0]))/2;
  if(!(mid>0)||!bids.length||!asks.length)return {imbalance:null,bidDepth:0,askDepth:0,spreadBps:null,bidWallShare:null,askWallShare:null};
  const band=.005;
  const bb=bids.filter(x=>Number(x?.[0])>=mid*(1-band));
  const aa=asks.filter(x=>Number(x?.[0])<=mid*(1+band));
  const b=bb.reduce((s,x)=>s+Number(x[0])*Number(x[1]),0);
  const a=aa.reduce((s,x)=>s+Number(x[0])*Number(x[1]),0);
  const total=b+a;
  const largestB=Math.max(0,...bb.map(x=>Number(x[0])*Number(x[1])));
  const largestA=Math.max(0,...aa.map(x=>Number(x[0])*Number(x[1])));
  const bid=Number(bids[0][0]),ask=Number(asks[0][0]);
  return {
    imbalance:total>0?(b-a)/total:null,bidDepth:b,askDepth:a,
    spreadBps:mid>0&&Number.isFinite(bid)&&Number.isFinite(ask)?(ask-bid)/mid*10000:null,
    bidWallShare:b>0?largestB/b:null,askWallShare:a>0?largestA/a:null
  };
};
const structureMetrics=(rows)=>{
  const lows=pivotLows(rows),highs=pivotHighs(rows);
  const ll=lows.slice(-3).map(x=>x.price),hh=highs.slice(-3).map(x=>x.price);
  let bull=0,bear=0;
  if(ll.length>=2){if(ll.at(-1)>ll.at(-2))bull++;else if(ll.at(-1)<ll.at(-2))bear++;}
  if(hh.length>=2){if(hh.at(-1)>hh.at(-2))bull++;else if(hh.at(-1)<hh.at(-2))bear++;}
  const last=Number(rows.at(-1)?.close);
  const recentHigh=Math.max(...rows.slice(-48).map(x=>Number(x.high)).filter(Number.isFinite));
  const recentLow=Math.min(...rows.slice(-48).map(x=>Number(x.low)).filter(Number.isFinite));
  const headroom=Number.isFinite(recentHigh)&&last>0?(recentHigh-last)/last*100:null;
  return {lows,highs,bull,bear,last,recentHigh,recentLow,headroom};
};
function whaleFlowMetrics(rows,minNotional=25000){
  const trades=(Array.isArray(rows)?rows:[]).map(x=>{
    const p=Number(x?.p),q=Number(x?.q);
    const notional=p>0&&q>=0?p*q:null;
    return Number.isFinite(notional)&&notional>0?{notional,buy:x?.m!==true,time:Number(x?.T)}:null;
  }).filter(Boolean);
  if(!trades.length)return {score:null,buyNotional:0,sellNotional:0,bigBuyNotional:0,bigSellNotional:0,bigCount:0,totalCount:0,threshold:null,ratio:null,net:null};
  const notionals=trades.map(x=>x.notional).sort((a,b)=>a-b);
  const p90=notionals[Math.max(0,Math.floor(notionals.length*.9)-1)]||0;
  const threshold=Math.max(minNotional,p90);
  const big=trades.filter(x=>x.notional>=threshold);
  const buyNotional=trades.filter(x=>x.buy).reduce((a,x)=>a+x.notional,0);
  const sellNotional=trades.filter(x=>!x.buy).reduce((a,x)=>a+x.notional,0);
  const bigBuyNotional=big.filter(x=>x.buy).reduce((a,x)=>a+x.notional,0);
  const bigSellNotional=big.filter(x=>!x.buy).reduce((a,x)=>a+x.notional,0);
  const bigTotal=bigBuyNotional+bigSellNotional;
  const ratio=bigTotal>0?bigBuyNotional/bigTotal:null;
  const net=bigTotal>0?(bigBuyNotional-bigSellNotional)/bigTotal:null;
  const burst=trades.length>0?big.length/trades.length:0;
  const score=Number.isFinite(net)?clamp(50+net*180+Math.min(15,burst*100)):50;
  return {score,buyNotional,sellNotional,bigBuyNotional,bigSellNotional,bigCount:big.length,totalCount:trades.length,threshold,ratio,net,burst};
}

const analyst=(id,name,score,direction='NEUTRAL',evidence={},risks=[])=>({
  id,name,score:Math.round(clamp(score)*10)/10,direction,
  decision:score>=80?'PASS':score>=65?'POSITIVE':score>=50?'WATCH':'FAIL',
  evidence,risks:Array.isArray(risks)?risks:[]
});

function specialistAnalysis(candidate, market={}){
  const raw=candidate?._analysis;
  const now=Number(raw?.completedAt)||Date.now();
  const s4=closed(raw?.series?.['4h'],now),s1=closed(raw?.series?.['1h'],now),s15=closed(raw?.series?.['15m'],now);
  const c4=closes(s4),c1=closes(s1),c15=closes(s15);
  const price=safe(candidate?.last_price,null);
  const liq=safe(candidate?.liquidity_quality,0);
  const dq=safe(candidate?.data_quality,0);
  const tRatio=takerRatio(s15),rv=rvol(s15),uv=upVolRatio(s15);
  const bb=bbRatio(s15),ar=atrRatio(s15);
  const ema20=emaLast(c1,20),ema50=emaLast(c1,50),ema20_15=emaLast(c15,20),ema50_15=emaLast(c15,50);
  const rsi=rsiLast(c15),rsi1=rsiLast(c1);
  const sm=structureMetrics(s15),book=orderbookMetrics(raw?.depth,price);
  const roc4=roc(c15,4),roc16=roc(c15,16),trend4=slopePct(c4,20),trend1=slopePct(c1,20);
  const atr=atrLast(s15,14);
  const distanceEma=Number.isFinite(price)&&Number.isFinite(ema20_15)&&ema20_15>0?(price-ema20_15)/ema20_15*100:null;
  const rangeHigh=Number.isFinite(Number(candidate?.high_price_24h))?Number(candidate.high_price_24h):Math.max(...s15.slice(-96).map(x=>Number(x.high)).filter(Number.isFinite));
  const rangeLow=Number.isFinite(Number(candidate?.low_price_24h))?Number(candidate.low_price_24h):Math.min(...s15.slice(-96).map(x=>Number(x.low)).filter(Number.isFinite));
  const rangePos=Number.isFinite(price)&&Number.isFinite(rangeHigh)&&Number.isFinite(rangeLow)&&rangeHigh>rangeLow?((price-rangeLow)/(rangeHigh-rangeLow))*100:null;
  const ret15=roc(c15,8),ret1=roc(c1,4);
  const btc15=market.btc15||[],btc1=market.btc1||[];
  const rs15=Number.isFinite(ret15)&&Number.isFinite(roc(btc15,8))?ret15-roc(btc15,8):null;
  const rs1=Number.isFinite(ret1)&&Number.isFinite(roc(btc1,4))?ret1-roc(btc1,4):null;
  const median24=safe(market.marketMedian24h,null);
  const rel24=Number.isFinite(median24)&&Number.isFinite(Number(candidate?.price_change_24h))?Number(candidate.price_change_24h)-median24:null;

  const htfBias=(Number.isFinite(trend4)?clamp(50+trend4*7):50);
  const htfEma=Number.isFinite(c4.at(-1))&&Number.isFinite(emaLast(c4,20))&&Number.isFinite(emaLast(c4,50))
    ? (c4.at(-1)>emaLast(c4,20)&&emaLast(c4,20)>=emaLast(c4,50)?92:c4.at(-1)>emaLast(c4,50)?68:28):50;
  const a=[];
  a.push(analyst('MARKET_REGIME','محلل نظام السوق',avg([htfBias,htfEma,Number.isFinite(trend1)?clamp(50+trend1*8):50]),htfBias>=60?'LONG':'NEUTRAL',{trend4h:trend4,emaBias:htfEma}));
  const mtf=[htfEma,Number.isFinite(ema20&&ema50)?(c1.at(-1)>ema20&&ema20>=ema50?90:c1.at(-1)>ema50?65:30):50,Number.isFinite(ema20_15&&ema50_15)?(price>ema20_15&&ema20_15>=ema50_15?88:price>ema50_15?64:28):50];
  a.push(analyst('MTF_ALIGNMENT','محلل توافق الأطر الزمنية',avg(mtf),avg(mtf)>=62?'LONG':'NEUTRAL',{'4h':mtf[0],'1h':mtf[1],'15m':mtf[2]}));
  const structureScore=clamp(50+(sm.bull-sm.bear)*25+(sm.headroom!=null?(sm.headroom>=3?10:sm.headroom>=1?4:sm.headroom<0?-10:0):0));
  a.push(analyst('MARKET_STRUCTURE','محلل هيكل القمم والقيعان',structureScore,sm.bull>sm.bear?'LONG':sm.bear>sm.bull?'BEARISH':'NEUTRAL',{higherLows:sm.bull,lowerLows:sm.bear,headroomPct:sm.headroom}));
  const drawdown=safe(candidate?.high_price_24h,null)&&price?Math.max(0,(Number(candidate.high_price_24h)-price)/Number(candidate.high_price_24h)*100):0;
  const recovery=Number.isFinite(Number(candidate?.low_price_24h))&&price?Math.max(0,(price-Number(candidate.low_price_24h))/Number(candidate.low_price_24h)*100):0;
  const bottomScore=clamp(70+Math.min(25,drawdown*2)-Math.min(20,recovery*1.3)+(sm.bull>sm.bear?10:0)+(Number.isFinite(rsi)&&rsi<42?8:0));
  a.push(analyst('BOTTOM_TURN','محلل القاع والتحول',bottomScore,drawdown>=8&&sm.bull>=sm.bear?'LONG':'NEUTRAL',{drawdownFromHighPct:drawdown,recoveryFromLowPct:recovery,rsi}));
  const momentumScore=avg([Number.isFinite(roc4)?clamp(50+roc4*12):50,Number.isFinite(rsi)?clamp(50+(rsi-50)*1.6):50,Number.isFinite(roc16)?clamp(50+roc16*7):50]);
  a.push(analyst('MOMENTUM','محلل الزخم',momentumScore,momentumScore>=62?'LONG':'NEUTRAL',{roc4,roc16,rsi,rsi1}));
  const volumeScore=avg([Number.isFinite(rv)?clamp(50+(rv-1)*80):50,Number.isFinite(uv.bias)?clamp(50+uv.bias*75):50,Number.isFinite(tRatio)?clamp(50+(tRatio-.5)*300):50,Number.isFinite(uv.acceleration)?clamp(50+(uv.acceleration-1)*80):50]);
  a.push(analyst('VOLUME_CONFIRMATION','محلل تأكيد الحجم',volumeScore,volumeScore>=62?'LONG':'NEUTRAL',{rvol:rv,upDownBias:uv.bias,volumeAcceleration:uv.acceleration,takerBuyRatio:tRatio}));
  const squeezeScore=avg([Number.isFinite(bb)?clamp(100-bb*90):50,Number.isFinite(ar)?clamp(100-ar*85):50]);
  a.push(analyst('VOLATILITY_COMPRESSION','محلل الانكماش والتجهيز',squeezeScore,squeezeScore>=65?'LONG':'NEUTRAL',{bbWidthRatio:bb,atrRatio:ar}));
  const breakoutProximity=Number.isFinite(sm.headroom)?clamp(100-Math.max(0,sm.headroom)*12):50;
  const breakoutScore=avg([breakoutProximity,squeezeScore,volumeScore,structureScore]);
  a.push(analyst('PRE_BREAKOUT','محلل ما قبل الاختراق',breakoutScore,breakoutScore>=68?'LONG':'NEUTRAL',{headroomPct:sm.headroom,squeezeScore,volumeScore}));
  const supportDist=Number.isFinite(price)&&Number.isFinite(sm.recentLow)&&price>0?(price-sm.recentLow)/price*100:null;
  const resistanceDist=Number.isFinite(sm.recentHigh)&&price>0?(sm.recentHigh-price)/price*100:null;
  const srScore=avg([Number.isFinite(supportDist)?clamp(92-supportDist*10):50,Number.isFinite(resistanceDist)?clamp(45+resistanceDist*9):50,structureScore]);
  a.push(analyst('SUPPORT_RESISTANCE','محلل الدعم والمقاومة',srScore,srScore>=62?'LONG':'NEUTRAL',{supportDistancePct:supportDist,resistanceDistancePct:resistanceDist,headroomPct:sm.headroom}));
  const relativeScore=avg([Number.isFinite(rs15)?clamp(50+rs15*12):50,Number.isFinite(rs1)?clamp(50+rs1*10):50,Number.isFinite(rel24)?clamp(50+rel24*5):50]);
  a.push(analyst('RELATIVE_STRENGTH','محلل القوة النسبية',relativeScore,relativeScore>=62?'LONG':'NEUTRAL',{vsBtc15m:rs15,vsBtc1h:rs1,vsMarket24h:rel24}));
  const bookScore=avg([Number.isFinite(book.imbalance)?clamp(50+book.imbalance*210):50,Number.isFinite(book.bidWallShare)&&Number.isFinite(book.askWallShare)?clamp(50+(book.bidWallShare-book.askWallShare)*220):50]);
  a.push(analyst('ORDERBOOK_PRESSURE','محلل دفتر الأوامر',bookScore,bookScore>=62?'LONG':'NEUTRAL',{imbalance:book.imbalance,bidWallShare:book.bidWallShare,askWallShare:book.askWallShare,spreadBps:book.spreadBps}));
  const liquidityScore=clamp(liq);
  a.push(analyst('LIQUIDITY_QUALITY','محلل جودة السيولة',liquidityScore,liquidityScore>=70?'LONG':'NEUTRAL',{liquidityQuality:liq,spreadBps:book.spreadBps}));
  const whaleFlow=whaleFlowMetrics(raw?.whaleTrades,25000);
  const whaleFlowScore=Number.isFinite(whaleFlow.score)
    ? avg([whaleFlow.score,bookScore,volumeScore])
    : avg([bookScore,volumeScore]);
  a.push(analyst('WHALE_FLOW','محلل تدفق الحيتان',whaleFlowScore,whaleFlowScore>=65?'LONG':whaleFlowScore<45?'BEARISH':'NEUTRAL',{largeBuyNotional:whaleFlow.bigBuyNotional,largeSellNotional:whaleFlow.bigSellNotional,largeBuyRatio:whaleFlow.ratio,largeTradeCount:whaleFlow.bigCount,largeThreshold:whaleFlow.threshold},Number.isFinite(whaleFlow.ratio)&&whaleFlow.ratio<.4?['LARGE_PRINT_SELL_DOMINANCE']:[]));
  const range15=s15.at(-1)?Number(s15.at(-1).high)-Number(s15.at(-1).low):null;
  const change15=Number.isFinite(Number(s15.at(-1)?.close))&&Number.isFinite(Number(s15.at(-8)?.close))?Math.abs(Number(s15.at(-1).close)-Number(s15.at(-8).close))/Math.max(1e-12,Number(s15.at(-8).close))*100:null;
  const absorptionScore=avg([Number.isFinite(rv)?clamp(100-Math.abs((rv-1.8))*35):50,Number.isFinite(change15)?clamp(96-change15*20):50,Number.isFinite(uv.bias)?clamp(55+uv.bias*80):50,Number.isFinite(book.imbalance)?clamp(50+book.imbalance*120):50]);
  a.push(analyst('ABSORPTION','محلل امتصاص السيولة',absorptionScore,absorptionScore>=68?'LONG':'NEUTRAL',{rvol:rv,priceChangeWindowPct:change15,volumeBias:uv.bias,bookImbalance:book.imbalance}));
  const upperWick=s15.slice(-8).reduce((sum,x)=>{
    const h=Number(x.high),l=Number(x.low),o=Number(x.open),c=Number(x.close),r=h-l;
    return sum+(r>0?Math.max(0,h-Math.max(o,c))/r:0);
  },0)/Math.max(1,s15.slice(-8).length);
  const extRisk=clamp(
    50
    -Math.max(0,(Number(candidate?.price_change_24h)||0)-8)*4
    -Math.max(0,(Number(distanceEma)||0)-5)*5
    -Math.max(0,(Number(upperWick)||0)-.35)*90
    +(Number.isFinite(book.imbalance)&&book.imbalance>0.08?8:0)
  );
  const riskScore=clamp(extRisk-(rsi>78?12:0));
  a.push(analyst('RISK_TRAPS','محلل الفخاخ والإرهاق',riskScore,riskScore>=62?'LONG':riskScore<45?'BEARISH':'NEUTRAL',{priceChange24h:candidate?.price_change_24h,distanceFromEmaPct:distanceEma,upperWickRatio:upperWick,rsi}));
  const extensionScore=clamp(70-Math.max(0,Number(distanceEma||0))*6-Math.max(0,(Number(candidate?.price_change_24h)||0)-5)*3);
  a.push(analyst('EXTENSION','محلل عدم مطاردة السعر',extensionScore,extensionScore>=65?'LONG':'NEUTRAL',{distanceFromEmaPct:distanceEma,move24hPct:candidate?.price_change_24h}));
  const strategyScores=(candidate?.strategies||[]).map(x=>Number(x?.score?.value)).filter(Number.isFinite);
  const strategyScore=avg(strategyScores)||50;
  a.push(analyst('STRATEGY_CONSENSUS','محلل إجماع الاستراتيجيات',strategyScore,strategyScore>=65?'LONG':'NEUTRAL',{activeStrategies:candidate?.coverage?.strategy_count||strategyScores.length,accepted:(candidate?.accepted_strategies||[]).length,best:candidate?.best_strategy||null}));
  const breadthScore=avg([Number.isFinite(market.breadthPct)?market.breadthPct:50,Number.isFinite(rel24)?clamp(50+rel24*8):50]);
  a.push(analyst('MARKET_BREADTH','محلل اتساع السوق',breadthScore,breadthScore>=62?'LONG':'NEUTRAL',{positiveBreadthPct:market.breadthPct,relative24h:rel24}));
  const dataScore=clamp(Math.min(dq,liq));
  a.push(analyst('DATA_INTEGRITY','حارس سلامة البيانات',dataScore,dq>=70&&liq>=60?'LONG':'NEUTRAL',{dataQuality:dq,liquidityQuality:liq,closedCandles:{'4h':s4.length,'1h':s1.length,'15m':s15.length}}));
  return {a,features:{price,rsi,rsi1,rv,bb,ar,tRatio,structure:sm,book,roc4,roc16,trend4,trend1,rangePos,distanceEma},dataValid:dq>=70&&liq>=60&&s4.length>=50&&s1.length>=50&&s15.length>=80};
}

export function analyzeMultiAnalystCandidate(candidate, market={}){
  const specialist=specialistAnalysis(candidate,market);
  const final=finalVerdict(specialist.a,specialist.features,specialist.dataValid);
  return {specialist,final};
}

const WEIGHTS={
  MARKET_REGIME:.06,MTF_ALIGNMENT:.06,MARKET_STRUCTURE:.07,BOTTOM_TURN:.07,MOMENTUM:.05,
  VOLUME_CONFIRMATION:.06,VOLATILITY_COMPRESSION:.05,PRE_BREAKOUT:.09,SUPPORT_RESISTANCE:.07,
  RELATIVE_STRENGTH:.05,ORDERBOOK_PRESSURE:.05,LIQUIDITY_QUALITY:.04,WHALE_FLOW:.05,
  ABSORPTION:.07,RISK_TRAPS:.09,EXTENSION:.04,STRATEGY_CONSENSUS:.05,MARKET_BREADTH:.04,DATA_INTEGRITY:.05
};
const finalVerdict=(analysts,features,dataValid)=>{
  const weighted=analysts.reduce((sum,x)=>sum+clamp(x.score)*Number(WEIGHTS[x.id]||0),0);
  const weightSum=analysts.reduce((sum,x)=>sum+Number(WEIGHTS[x.id]||0),0)||1;
  const score=clamp(weighted/weightSum);
  const positive=analysts.filter(x=>x.score>=65).length;
  const strong=analysts.filter(x=>x.score>=80).length;
  const byId=new Map(analysts.map(x=>[x.id,x]));
  const criticalGood=['MARKET_STRUCTURE','VOLUME_CONFIRMATION','PRE_BREAKOUT','SUPPORT_RESISTANCE','RISK_TRAPS'].every(id=>byId.get(id)?.score>=55);
  const hardReasons=[];
  if(!dataValid)hardReasons.push('DATA_GATE_FAILED');
  if(byId.get('RISK_TRAPS')?.score<45)hardReasons.push('RISK_TOO_HIGH');
  if(byId.get('EXTENSION')?.score<45)hardReasons.push('PRICE_ALREADY_EXTENDED');
  if(byId.get('LIQUIDITY_QUALITY')?.score<60)hardReasons.push('LIQUIDITY_TOO_WEAK');
  const directionVotes=analysts.filter(x=>x.direction==='LONG').length-analysts.filter(x=>x.direction==='BEARISH').length;
  const direction=directionVotes>=3?'LONG':directionVotes<=-3?'BEARISH':'NEUTRAL';
  let verdict='REJECT';
  if(!hardReasons.length&&direction==='LONG'&&score>=84&&positive>=12&&strong>=5&&criticalGood)verdict='STRONG_CANDIDATE';
  else if(!hardReasons.length&&direction==='LONG'&&score>=78&&positive>=10&&strong>=3&&criticalGood)verdict='CANDIDATE';
  else if(!hardReasons.length&&direction==='LONG'&&score>=68&&positive>=8)verdict='WATCH';
  const reasons=analysts.filter(x=>x.score>=72).sort((x,y)=>y.score-x.score).slice(0,6).map(x=>x.name);
  const risks=analysts.flatMap(x=>x.risks||[]).slice(0,8);
  return {score:Math.round(score*10)/10,verdict,direction,positiveAnalysts:positive,strongAnalysts:strong,totalAnalysts:analysts.length,hardReasons,reasons,risks};
};

export class MultiAnalystEngine {
  constructor({rest,config={},clock=()=>Date.now()}={}){
    if(!rest||typeof rest.request!=='function')throw new Error('REST_CLIENT_REQUIRED');
    this.clock=clock;
    this.config={
      quote:'USDT',discoveryPool:12,returnLimit:10,deepConcurrency:2,deepKlines:220,
      minQuoteVolume24h:300000,minDataQuality:70,minLiquidityQuality:60,
      ttlMs:45000,...config
    };
    this.scanner=new MarketUniverseScanner({
      rest,
      config:{
        minQuoteVolume24h:this.config.minQuoteVolume24h,
        minDataQuality:this.config.minDataQuality,
        minLiquidityQuality:this.config.minLiquidityQuality,
        deepConcurrency:this.config.deepConcurrency,
        deepKlines:this.config.deepKlines,
        maxTriggerAgeMs:30*60*1000,
        maxScanLimit:50,
        returnLimit:20,
        retryAttempts:2
      }
    });
    this.cache=null;
    this.busy=null;
  }
  async scan({quote=this.config.quote,limit=this.config.returnLimit}={}){
    const now=this.clock();
    const q=String(quote||this.config.quote).trim().toUpperCase();
    const requested=Math.max(1,Math.min(15,Math.trunc(Number(limit)||this.config.returnLimit)));
    if(!/^[A-Z]{2,10}$/.test(q))throw new Error('INVALID_QUOTE');
    if(this.cache&&this.cache.quote===q&&this.cache.expiresAt>now)return this.cache.value;
    if(this.busy)return this.busy;
    this.busy=(async()=>{
      const startedAt=this.clock();
      this.scanner._requests=new Map();
      const info=await this.scanner.exchangeInfo();
      const universe=buildSpotUniverse(info.data,q);
      const tickers=await this.scanner.ticker24h();
      const normalized=tickers.data.map(x=>({
        symbol:String(x.symbol||'').toUpperCase(),lastPrice:Number(x.lastPrice),quoteVolume24h:Number(x.quoteVolume),
        tradeCount24h:Number(x.count),priceChange24h:Number(x.priceChangePercent),
        highPrice24h:Number(x.highPrice),lowPrice24h:Number(x.lowPrice),tickerTime:Number(x.closeTime||x.eventTime||x.openTime||0)
      })).filter(x=>/^[A-Z0-9]{2,30}$/.test(x.symbol)&&Number.isFinite(x.lastPrice)&&x.lastPrice>0&&Number.isFinite(x.quoteVolume24h));
      const top=rankTickerRows(tickers.data,universe,{minQuoteVolume24h:this.config.minQuoteVolume24h,limit:Math.max(8,Math.trunc(this.config.discoveryPool/2))});
      const bottom=rankBottomTickerRows(tickers.data,universe,{minQuoteVolume24h:this.config.minQuoteVolume24h,limit:Math.max(4,Math.trunc(this.config.discoveryPool/5))});
      const wake=normalized.filter(x=>x.priceChange24h>=0.35&&x.priceChange24h<=7).sort((a,b)=>{
        const sa=Math.log10(Math.max(1,a.quoteVolume24h))*0.6+Math.min(7,a.priceChange24h)*8;
        const sb=Math.log10(Math.max(1,b.quoteVolume24h))*0.6+Math.min(7,b.priceChange24h)*8;
        return sb-sa;
      }).slice(0,Math.max(6,Math.trunc(this.config.discoveryPool*.4)));
      const selected=[];const seen=new Set();
      for(const row of [...top,...wake,...bottom]){
        if(seen.has(row.symbol))continue; seen.add(row.symbol); selected.push(row);
        if(selected.length>=this.config.discoveryPool)break;
      }
      if(!selected.length)throw new Error('NO_SPOT_CANDIDATES');
      let btc15=[],btc1=[];
      try{
        const [b15,b1]=await Promise.all([
          this.scanner.fetchSeries('BTCUSDT','15m',Math.min(this.config.deepKlines,220)),
          this.scanner.fetchSeries('BTCUSDT','1h',Math.min(this.config.deepKlines,220))
        ]);
        btc15=Array.isArray(b15.candles)?b15.candles:[]; btc1=Array.isArray(b1.candles)?b1.candles:[];
      }catch{}
      const validTickerReturns=selected.map(x=>Number(x.priceChange24h)).filter(Number.isFinite).sort((a,b)=>a-b);
      const marketMedian24h=validTickerReturns.length?validTickerReturns[Math.floor(validTickerReturns.length/2)]:null;
      const breadthPct=validTickerReturns.length?validTickerReturns.filter(x=>x>0).length/validTickerReturns.length*100:null;
      const scanned=await boundedMap(selected,Math.max(1,Math.min(5,this.config.deepConcurrency)),async(ticker,index)=>{
        const row=await this.scanner.scanSymbol(ticker,index+1,{exchangeInfo:info.source,ticker:tickers.source},{klinesLimit:this.config.deepKlines,includeAnalysisPayload:true,includeWhaleFlow:true});
        const analysis=analyzeMultiAnalystCandidate(row,{btc15,btc1,marketMedian24h,breadthPct});
        const specialist=analysis.specialist;
        const final=analysis.final;
        const publicAnalysts=specialist.a.map(x=>({...x}));
        delete row._analysis;
        return {
          symbol:row.symbol,rank:index+1,last_price:row.last_price,price_change_24h:row.price_change_24h,
          quote_volume_24h:row.quote_volume_24h,liquidity_quality:row.liquidity_quality,data_quality:row.data_quality,
          direction:final.direction,verdict:final.verdict,final_score:final.score,
          consensus:{positive:final.positiveAnalysts,strong:final.strongAnalysts,total:final.totalAnalysts,ratio:final.positiveAnalysts/final.totalAnalysts},
          analysts:publicAnalysts,final_judge:final,
          highlights:specialist.a.filter(x=>x.score>=72).sort((a,b)=>b.score-a.score).slice(0,6),
          risk_flags:row.risk_flags||[],reason_codes:row.reason_codes||[],
          data_status:row.data_status,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
        };
      });
      const live=scanned.filter(Boolean);
      live.sort((a,b)=>b.final_score-a.final_score||b.consensus.ratio-a.consensus.ratio||b.liquidity_quality-a.liquidity_quality);
      const candidates=live.slice(0,requested).map((x,i)=>({...x,rank:i+1}));
      const strongCount=live.filter(x=>x.verdict==='STRONG_CANDIDATE').length;
      const value={
        meta:{live:live.some(x=>x.data_status?.data_valid===true),paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',radar:'MULTI_ANALYST',analyst_count:20,specialist_count:19},
        as_of:new Date(this.clock()).toISOString(),
        source:'Binance Public REST',
        universe:{quote:q,eligible_spot_symbols:universe.length,discovery_pool:selected.length,scanned:live.length,returned:candidates.length,min_quote_volume_24h:this.config.minQuoteVolume24h},
        market_context:{median_24h_change_pct:marketMedian24h,positive_breadth_pct:breadthPct},
        summary:{strong_candidates:strongCount,candidates:live.filter(x=>x.verdict==='CANDIDATE').length,watch:live.filter(x=>x.verdict==='WATCH').length,rejected:live.filter(x=>x.verdict==='REJECT').length},
        candidates,
        pipeline:['Discovery','Data Gate','19 Specialist Analysts','Chief Analyst'],
        diagnostics:{duration_ms:Math.max(0,this.clock()-startedAt),deep_concurrency:this.config.deepConcurrency,deep_klines:this.config.deepKlines}
      };
      this.cache={quote:q,expiresAt:this.clock()+this.config.ttlMs,value};
      return value;
    })();
    try{return await this.busy}finally{this.busy=null;}
  }
  getCached({quote=this.config.quote}={}){return this.cache?.quote===String(quote).toUpperCase()?this.cache.value:null;}
}

export const MULTI_ANALYST_NAMES=Object.freeze([
  'نظام السوق','توافق الأطر','هيكل القمم والقيعان','القاع والتحول','الزخم','تأكيد الحجم',
  'الانكماش والتجهيز','ما قبل الاختراق','الدعم والمقاومة','القوة النسبية','دفتر الأوامر',
  'جودة السيولة','تدفق الحيتان','امتصاص السيولة','الفخاخ والإرهاق','عدم مطاردة السعر',
  'إجماع الاستراتيجيات','اتساع السوق','سلامة البيانات','المحلل النهائي'
]);
