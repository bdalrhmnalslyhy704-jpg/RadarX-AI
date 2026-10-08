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
const stdev=(xs)=>{
  const a=xs.map(Number).filter(Number.isFinite);
  if(a.length<2)return 0;
  const m=avg(a);
  return Math.sqrt(avg(a.map(x=>(x-m)**2)));
};
const marketRegime=(market={})=>{
  const breadth=Number(market.breadthPct),median=Number(market.marketMedian24h);
  if(Number.isFinite(breadth)&&Number.isFinite(median)){
    if(breadth>=62&&median>=0.8)return 'RISK_ON';
    if(breadth<=38&&median<=-0.8)return 'RISK_OFF';
  }
  return 'MIXED';
};
const adaptiveWeights=(regime)=>{
  const w={...WEIGHTS};
  const bump=(id,n)=>{w[id]=(w[id]||0)*n;};
  if(regime==='RISK_ON'){
    bump('PRE_BREAKOUT',1.15);bump('VOLUME_CONFIRMATION',1.12);bump('RELATIVE_STRENGTH',1.12);
    bump('MARKET_STRUCTURE',1.05);bump('ABSORPTION',1.05);bump('RISK_TRAPS',1.03);
    bump('BOTTOM_TURN',.92);
  }else if(regime==='RISK_OFF'){
    bump('RISK_TRAPS',1.22);bump('DATA_INTEGRITY',1.15);bump('MARKET_STRUCTURE',1.12);
    bump('MTF_ALIGNMENT',1.10);bump('SUPPORT_RESISTANCE',1.08);bump('BOTTOM_TURN',1.06);
    bump('MOMENTUM',.82);bump('PRE_BREAKOUT',.88);bump('RELATIVE_STRENGTH',.92);
  }else{
    bump('RISK_TRAPS',1.12);bump('MTF_ALIGNMENT',1.06);bump('MARKET_BREADTH',1.08);
    bump('SUPPORT_RESISTANCE',1.05);bump('VOLUME_CONFIRMATION',1.04);
  }
  return w;
};

const impulseEvent=(rows,lookback=96)=>{
  const c=closes(rows),n=c.length;
  if(n<8)return {gain:0,age:999,start:null,end:null};
  const start=Math.max(0,n-Math.max(8,Math.trunc(lookback)));
  let minPrice=c[start],minIndex=start;
  let best={gain:0,age:n-1-start,start:start,end:start};
  for(let i=start+1;i<n;i++){
    const px=c[i];
    if(Number.isFinite(px)&&minPrice>0){
      const gain=(px-minPrice)/minPrice*100;
      if(gain>best.gain){
        best={gain,age:n-1-i,start:minIndex,end:i};
      }
    }
    if(Number.isFinite(px)&&px<minPrice){minPrice=px;minIndex=i;}
  }
  return {
    gain:Math.round(Math.max(0,best.gain)*100)/100,
    age:Math.max(0,best.age),start:best.start,end:best.end
  };
};
const decayedImpulseHeat=(event,decayBars=24,scale=7.5)=>{
  const gain=Number(event?.gain),age=Number(event?.age);
  if(!Number.isFinite(gain)||!Number.isFinite(age)||gain<=0)return 0;
  return clamp(gain*Math.exp(-age/Math.max(1,decayBars))*scale);
};
const buildSniperFreshness=(series)=>{
  const e15=impulseEvent(series?.['15m'],96);
  const e1=impulseEvent(series?.['1h'],48);
  const e4=impulseEvent(series?.['4h'],36);
  const heat15=decayedImpulseHeat(e15,24,7.5);
  const heat1=decayedImpulseHeat(e1,12,5.2);
  const heat4=decayedImpulseHeat(e4,6,2.6);
  const pumpHeat=clamp(Math.max(heat15,heat1,heat4));
  const veryRecent4=impulseEvent(series?.['15m'],8);
  const veryRecent8=impulseEvent(series?.['15m'],16);
  const freshness=clamp(100-pumpHeat*1.05);
  return {
    pumpHeat:Math.round(pumpHeat*10)/10,
    freshness:Math.round(freshness*10)/10,
    recent4Gain:Number(veryRecent4.gain)||0,
    recent8Gain:Number(veryRecent8.gain)||0,
    recent24h15mGain:Number(e15.gain)||0,
    recent48h1hGain:Number(e1.gain)||0,
    recent6d4hGain:Number(e4.gain)||0,
    recent15mAge:Number(veryRecent4.age)||999,
    peak15mAge:Number(e15.age)||999,
    peak1hAge:Number(e1.age)||999,
    peak4hAge:Number(e4.age)||999
  };
};

const trajectoryFromMemory=(memory)=>{
  const now=Date.now();
  const history=Array.isArray(memory?.history)?memory.history:[];
  const fresh=history.map(x=>({as_of:Number(x?.as_of),score:Number(x?.early_score)}))
    .filter(x=>Number.isFinite(x.as_of)&&Number.isFinite(x.score)&&now-x.as_of>=0&&now-x.as_of<=3*60*60*1000)
    .slice(-8);
  if(fresh.length<2)return {score:50,observations:fresh.length,slope:0,up_ratio:0,max_drop:0};
  const deltas=[];
  for(let i=1;i<fresh.length;i++)deltas.push(fresh[i].score-fresh[i-1].score);
  const upRatio=deltas.length?deltas.filter(x=>x>=0).length/deltas.length:0;
  const slope=(fresh.at(-1).score-fresh[0].score)/Math.max(1,fresh.length-1);
  let maxDrop=0;
  for(let i=1;i<fresh.length;i++)maxDrop=Math.max(maxDrop,fresh[i-1].score-fresh[i].score);
  const stability=clamp(100-maxDrop*5);
  const score=clamp(50+slope*5+(upRatio-.5)*30+(stability-50)*.12);
  return {score:Math.round(score*10)/10,observations:fresh.length,slope:Math.round(slope*100)/100,up_ratio:Math.round(upRatio*100)/100,max_drop:Math.round(maxDrop*10)/10};
};

const earlyOpportunity=(features,memory)=>{
  const move24=Number(features?.priceChange24h),head=Number(features?.structure?.headroom);
  const rv=Number(features?.rv),taker=Number(features?.tRatio),bb=Number(features?.bb);
  const rs=Number(features?.relativeStrength15),emaDist=Number(features?.distanceEma);
  const pumpHeat=Number(features?.pump_heat),freshness=Number(features?.sniper_freshness);
  const structure=Number(features?.structure?.bull)-Number(features?.structure?.bear);
  const trajectory=trajectoryFromMemory(memory);
  let score=50;
  if(Number.isFinite(head)) score += clamp(100-Math.abs(head-2.2)*28,0,100)*.18-9;
  if(Number.isFinite(rv)) score += clamp(50+(rv-1)*70)*.15-7.5;
  if(Number.isFinite(taker)) score += clamp(50+(taker-.5)*320)*.16-8;
  if(Number.isFinite(bb)) score += clamp(100-bb*70)*.13-6.5;
  if(Number.isFinite(rs)) score += clamp(50+rs*12)*.12-6;
  score += clamp(50+structure*20)*.10-5;
  if(Number.isFinite(emaDist)) score += clamp(72-Math.max(0,emaDist-2)*10)*.08-5.76;
  if(Number.isFinite(move24)) score += clamp(94-Math.abs(move24-2.2)*14)*.08-7.52;
  if(Number.isFinite(freshness)) score += (freshness-50)*.09;
  if(Number.isFinite(pumpHeat)) score -= Math.max(0,pumpHeat-45)*.10;
  const priorTs=Number(memory?.as_of),age=Date.now()-priorTs;
  const prior=Number(memory?.early_score);
  const freshPrior=age>=0&&age<=3*60*60*1000&&prior>=55;
  const persistence=freshPrior?Math.min(8,Math.max(0,(Number(score)-50)/5)):0;
  const trajectoryBonus=trajectory.observations>=2?clamp((trajectory.score-50)*.16,-4,8):0;
  score+=persistence+trajectoryBonus;
  return {score:clamp(score),persistence:persistence+trajectoryBonus,move24,head,emaDist,trajectory_score:trajectory.score,trajectory_observations:trajectory.observations,pump_heat:pumpHeat,sniper_freshness:freshness};
};
const ANALYST_PROFILES=Object.freeze({
  MARKET_REGIME:{group:'MACRO',role:'اتجاه السوق العام'},
  MTF_ALIGNMENT:{group:'TREND',role:'توافق الأطر'},
  MARKET_STRUCTURE:{group:'STRUCTURE',role:'هيكل السعر'},
  BOTTOM_TURN:{group:'REVERSAL',role:'القاع والتحول'},
  MOMENTUM:{group:'MOMENTUM',role:'قوة الحركة'},
  VOLUME_CONFIRMATION:{group:'FLOW',role:'تأكيد التدفق والحجم'},
  VOLATILITY_COMPRESSION:{group:'VOLATILITY',role:'الضغط والانفراج'},
  PRE_BREAKOUT:{group:'BREAKOUT',role:'ما قبل الاختراق'},
  SUPPORT_RESISTANCE:{group:'PRICE_ACTION',role:'الدعم والمقاومة'},
  RELATIVE_STRENGTH:{group:'RELATIVE',role:'القوة النسبية'},
  ORDERBOOK_PRESSURE:{group:'MICROSTRUCTURE',role:'ضغط دفتر الأوامر'},
  LIQUIDITY_QUALITY:{group:'MICROSTRUCTURE',role:'جودة التنفيذ والسيولة'},
  LARGE_PLAYER_PROXY:{group:'FLOW',role:'سلوك اللاعبين الكبار'},
  ABSORPTION:{group:'FLOW',role:'امتصاص العرض والطلب'},
  RISK_TRAPS:{group:'RISK',role:'الفخاخ والإرهاق'},
  EXTENSION:{group:'RISK',role:'خطر مطاردة السعر'},
  STRATEGY_CONSENSUS:{group:'STRATEGY',role:'إجماع الاستراتيجيات'},
  MARKET_BREADTH:{group:'MACRO',role:'اتساع السوق'},
  DATA_INTEGRITY:{group:'DATA',role:'سلامة البيانات'}
});

const finiteEvidenceCount=(evidence)=>{
  const values=Object.values(evidence||{});
  let used=0;
  for(const v of values){
    if(Number.isFinite(Number(v))) used++;
    else if(Array.isArray(v)&&v.some(x=>Number.isFinite(Number(x)))) used++;
    else if(v&&typeof v==='object'&&Object.values(v).some(x=>Number.isFinite(Number(x)))) used++;
  }
  return {used,total:values.length};
};

const analyst=(id,name,score,direction='NEUTRAL',evidence={},risks=[])=>{
  const profile=ANALYST_PROFILES[id]||{group:'OTHER',role:'محلل متخصص'};
  const s=Math.round(clamp(score)*10)/10;
  const ev=finiteEvidenceCount(evidence);
  const coverage=ev.total?Math.round(ev.used/ev.total*1000)/1000:1;
  const bias=direction==='LONG'?s:direction==='BEARISH'?100-s:50;
  return {
    id,name,group:profile.group,role:profile.role,
    score:s,direction,bias,
    decision:s>=80?'PASS':s>=65?'POSITIVE':s>=50?'WATCH':'FAIL',
    evidence,coverage,
    risks:Array.isArray(risks)?risks:[]
  };
};

const median=(xs)=>{
  const a=xs.map(Number).filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length)return null;
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
};

const directionalEfficiency=(rows,n=24)=>{
  const a=(Array.isArray(rows)?rows:[]).slice(-n).map(x=>Number(x?.close)).filter(Number.isFinite);
  if(a.length<4)return null;
  let path=0;
  for(let i=1;i<a.length;i++)path+=Math.abs(a[i]-a[i-1]);
  return path>0?Math.abs(a.at(-1)-a[0])/path:0;
};

const candlePressure=(row)=>{
  const o=Number(row?.open),h=Number(row?.high),l=Number(row?.low),c=Number(row?.close);
  const r=h-l;
  if(!(r>0)||![o,h,l,c].every(Number.isFinite))return {body:null,upperWick:null,lowerWick:null,closeLocation:null};
  return {
    body:Math.abs(c-o)/r,
    upperWick:Math.max(0,h-Math.max(o,c))/r,
    lowerWick:Math.max(0,Math.min(o,c)-l)/r,
    closeLocation:(c-l)/r
  };
};

const volumeBurst=(rows,short=4,base=24)=>{
  const a=(Array.isArray(rows)?rows:[]).map(x=>Number(x?.volume)).filter(Number.isFinite);
  if(a.length<short+4)return null;
  const s=avg(a.slice(-short)),b=avg(a.slice(-Math.max(short+1,base),-short));
  return Number.isFinite(s)&&Number.isFinite(b)&&b>0?s/b:null;
};

const rangeBurst=(rows,short=4,base=24)=>{
  const a=(Array.isArray(rows)?rows:[]).map(x=>Number(x?.high)-Number(x?.low)).filter(Number.isFinite);
  if(a.length<short+4)return null;
  const s=avg(a.slice(-short)),b=avg(a.slice(-Math.max(short+1,base),-short));
  return Number.isFinite(s)&&Number.isFinite(b)&&b>0?s/b:null;
};

const slopeDelta=(rows,period=6)=>{
  const c=closes(rows);
  if(c.length<period*2+1)return null;
  const recent=roc(c,period),prior=roc(c.slice(0,-period),period);
  return Number.isFinite(recent)&&Number.isFinite(prior)?recent-prior:null;
};

const rsiSlope=(rows,period=14,n=5)=>{
  const a=(Array.isArray(rows)?rows:[]).map(x=>Number(x.close)).filter(Number.isFinite);
  if(a.length<period+n+1)return null;
  const now=rsiLast(a,period);
  const prev=rsiLast(a.slice(0,-n),period);
  return Number.isFinite(now)&&Number.isFinite(prev)?now-prev:null;
};

function specialistAnalysis(candidate, market={}){
  const raw=candidate?._analysis||{};
  const now=Number(raw?.completedAt)||Date.now();
  const s4=closed(raw?.series?.['4h'],now),s1=closed(raw?.series?.['1h'],now),s15=closed(raw?.series?.['15m'],now);
  const rowDataValid=candidate?.data_status?.data_valid===true;
  const c4=closes(s4),c1=closes(s1),c15=closes(s15);
  const price=safe(candidate?.last_price,null);
  const liq=safe(candidate?.liquidity_quality,0);
  const dq=safe(candidate?.data_quality,0);

  const tRatio=takerRatio(s15),rv=rvol(s15),uv=upVolRatio(s15),bb=bbRatio(s15),ar=atrRatio(s15);
  const ema20=emaLast(c1,20),ema50=emaLast(c1,50),ema20_15=emaLast(c15,20),ema50_15=emaLast(c15,50);
  const ema200=emaLast(c4,200),ema50_4=emaLast(c4,50);
  const rsi=rsiLast(c15),rsi1=rsiLast(c1),rsiSlope15=rsiSlope(s15),rsiSlope1=rsiSlope(s1);
  const sm=structureMetrics(s15),book=orderbookMetrics(raw.depth,price);
  const roc4=roc(c15,4),roc16=roc(c15,16),trend4=slopePct(c4,20),trend1=slopePct(c1,20);
  const eff15=directionalEfficiency(s15,24),eff1=directionalEfficiency(s1,20);
  const volBurst=volumeBurst(s15,4,24),rangeBurst15=rangeBurst(s15,4,24),priceAccel=slopeDelta(s15,6);
  const lastCandle=candlePressure(s15.at(-1)),recentWicks=s15.slice(-8).map(candlePressure);
  const avgUpperWick=avg(recentWicks.map(x=>x.upperWick)),avgLowerWick=avg(recentWicks.map(x=>x.lowerWick));
  const avgBody=avg(recentWicks.map(x=>x.body)),closeLocation=lastCandle.closeLocation;
  const emaSpread15=Number.isFinite(price)&&Number.isFinite(ema20_15)&&Number.isFinite(ema50_15)?(ema20_15-ema50_15)/price*100:null;
  const emaSpread1=Number.isFinite(price)&&Number.isFinite(ema20)&&Number.isFinite(ema50)?(ema20-ema50)/price*100:null;
  const htfSpread=Number.isFinite(price)&&Number.isFinite(ema50_4)&&Number.isFinite(ema200)?(ema50_4-ema200)/price*100:null;
  // Distance from the fast trigger EMA; used to penalize chasing extended price.
  const distanceEma=Number.isFinite(price)&&Number.isFinite(ema20_15)&&ema20_15>0
    ?Math.abs((price-ema20_15)/ema20_15*100):null;
  const sniperFreshness=buildSniperFreshness({ '4h':s4, '1h':s1, '15m':s15 });

  const rangeHigh=Number.isFinite(Number(candidate?.high_price_24h))?Number(candidate.high_price_24h):Math.max(...s15.slice(-96).map(x=>Number(x.high)).filter(Number.isFinite));
  const rangeLow=Number.isFinite(Number(candidate?.low_price_24h))?Number(candidate.low_price_24h):Math.min(...s15.slice(-96).map(x=>Number(x.low)).filter(Number.isFinite));
  const rangePos=Number.isFinite(price)&&Number.isFinite(rangeHigh)&&Number.isFinite(rangeLow)&&rangeHigh>rangeLow?((price-rangeLow)/(rangeHigh-rangeLow))*100:null;
  const ret15=roc(c15,8),ret1=roc(c1,4);
  const btc15=market.btc15||[],btc1=market.btc1||[];
  const rs15=Number.isFinite(ret15)&&Number.isFinite(roc(btc15,8))?ret15-roc(btc15,8):null;
  const rs1=Number.isFinite(ret1)&&Number.isFinite(roc(btc1,4))?ret1-roc(btc1,4):null;
  const median24=safe(market.marketMedian24h,null);
  const rel24=Number.isFinite(median24)&&Number.isFinite(Number(candidate?.price_change_24h))?Number(candidate.price_change_24h)-median24:null;

  const htfBias=avg([
    Number.isFinite(trend4)?clamp(50+trend4*6):null,
    Number.isFinite(htfSpread)?clamp(50+htfSpread*12):null,
    Number.isFinite(ema200)&&Number.isFinite(ema50_4)&&c4.at(-1)>0?
      (c4.at(-1)>ema200&&ema50_4>=ema200?92:c4.at(-1)>ema50_4?68:28):null
  ])||50;
  const marketBreadth=Number.isFinite(Number(market.breadthPct))?Number(market.breadthPct):50;
  const marketScore=avg([htfBias,clamp(marketBreadth),Number.isFinite(median24)?clamp(50+median24*8):50])||50;
  const a=[];

  a.push(analyst('MARKET_REGIME','محلل نظام السوق',marketScore,marketScore>=60?'LONG':marketScore<=38?'BEARISH':'NEUTRAL',{
    trend4h:trend4,htfSpreadPct:htfSpread,breadthPct:market.breadthPct,median24h:median24
  }));

  const mtf=avg([
    Number.isFinite(c4.at(-1))&&Number.isFinite(ema50_4)&&Number.isFinite(ema200)?
      (c4.at(-1)>ema50_4&&ema50_4>=ema200?92:c4.at(-1)>ema200?66:28):50,
    Number.isFinite(emaSpread1)?clamp(50+emaSpread1*18):50,
    Number.isFinite(emaSpread15)?clamp(50+emaSpread15*24):50,
    Number.isFinite(trend1)?clamp(50+trend1*8):50
  ])||50;
  a.push(analyst('MTF_ALIGNMENT','محلل توافق الأطر الزمنية',mtf,mtf>=62?'LONG':mtf<=38?'BEARISH':'NEUTRAL',{
    htfTrend:trend4,emaSpread1h:emaSpread1,emaSpread15m:emaSpread15,trend1h:trend1
  }));

  const structureScore=clamp(
    48+(sm.bull-sm.bear)*22+
    (Number.isFinite(sm.headroom)?(sm.headroom>=4?16:sm.headroom>=2?8:sm.headroom<0?-14:-2):0)+
    (Number.isFinite(eff15)?eff15*16-8:0)+
    (Number.isFinite(closeLocation)&&closeLocation>0.72?5:0)
  );
  a.push(analyst('MARKET_STRUCTURE','محلل هيكل القمم والقيعان',structureScore,
    structureScore>=62?'LONG':structureScore<=38?'BEARISH':'NEUTRAL',{
      higherLows:sm.bull,lowerLows:sm.bear,headroomPct:sm.headroom,
      efficiency15m:eff15,closeLocationPct:Number.isFinite(closeLocation)?closeLocation*100:null
    }));

  const drawdown=safe(candidate?.high_price_24h,null)&&price?Math.max(0,(Number(candidate.high_price_24h)-price)/Number(candidate.high_price_24h)*100):0;
  const recovery=Number.isFinite(Number(candidate?.low_price_24h))&&price?Math.max(0,(price-Number(candidate.low_price_24h))/Number(candidate.low_price_24h)*100):0;
  const bottomScore=clamp(
    62+Math.min(28,drawdown*1.8)-Math.min(24,recovery*1.0)+
    (sm.bull>sm.bear?9:-2)+
    (Number.isFinite(rsi)&&rsi<=40?10:Number.isFinite(rsi)&&rsi<=50?5:0)+
    (Number.isFinite(avgLowerWick)&&avgLowerWick>.26?6:0)+
    (Number.isFinite(rsiSlope15)&&rsiSlope15>3?7:0)
  );
  a.push(analyst('BOTTOM_TURN','محلل القاع والتحول',bottomScore,
    bottomScore>=64?'LONG':bottomScore<=32?'BEARISH':'NEUTRAL',{
      drawdownFromHighPct:drawdown,recoveryFromLowPct:recovery,rsi,rsiSlope15,lowerWickAvg:avgLowerWick
    }));

  const momentumScore=avg([
    Number.isFinite(roc4)?clamp(50+roc4*12):null,
    Number.isFinite(roc16)?clamp(50+roc16*7):null,
    Number.isFinite(rsi)?clamp(50+(rsi-50)*1.5):null,
    Number.isFinite(rsiSlope15)?clamp(50+rsiSlope15*6):null,
    Number.isFinite(eff15)?clamp(45+eff15*55):null,
    Number.isFinite(priceAccel)?clamp(50+priceAccel*18):null
  ])||50;
  a.push(analyst('MOMENTUM','محلل الزخم',momentumScore,momentumScore>=63?'LONG':momentumScore<=37?'BEARISH':'NEUTRAL',{
    roc4,roc16,rsi,rsiSlope15,efficiency15m:eff15,acceleration:priceAccel
  }));

  const volumeScore=avg([
    Number.isFinite(rv)?clamp(50+(rv-1)*85):null,
    Number.isFinite(volBurst)?clamp(50+(volBurst-1)*95):null,
    Number.isFinite(uv.bias)?clamp(50+uv.bias*85):null,
    Number.isFinite(tRatio)?clamp(50+(tRatio-.5)*320):null,
    Number.isFinite(uv.acceleration)?clamp(50+(uv.acceleration-1)*90):null
  ])||50;
  a.push(analyst('VOLUME_CONFIRMATION','محلل تأكيد الحجم',volumeScore,volumeScore>=63?'LONG':volumeScore<=37?'BEARISH':'NEUTRAL',{
    rvol:rv,volumeBurst:volBurst,upDownBias:uv.bias,volumeAcceleration:uv.acceleration,takerBuyRatio:tRatio
  }));

  const squeezeScore=avg([
    Number.isFinite(bb)?clamp(105-bb*95):null,
    Number.isFinite(ar)?clamp(105-ar*90):null,
    Number.isFinite(rangeBurst15)?clamp(92-(rangeBurst15-1)*70):null
  ])||50;
  a.push(analyst('VOLATILITY_COMPRESSION','محلل الانكماش والتجهيز',squeezeScore,squeezeScore>=66?'LONG':'NEUTRAL',{
    bbWidthRatio:bb,atrRatio:ar,rangeBurst:rangeBurst15
  }));

  const resistanceGap=Number.isFinite(price)&&Number.isFinite(sm.recentHigh)&&price>0?(sm.recentHigh-price)/price*100:null;
  const supportGap=Number.isFinite(price)&&Number.isFinite(sm.recentLow)&&price>0?(price-sm.recentLow)/price*100:null;
  const proximity=Number.isFinite(resistanceGap)?clamp(100-Math.max(0,resistanceGap)*14):50;
  const breakoutPressure=avg([proximity,squeezeScore,volumeScore,structureScore,Number.isFinite(closeLocation)?clamp(closeLocation*100):50])||50;
  a.push(analyst('PRE_BREAKOUT','محلل ما قبل الاختراق',breakoutPressure,breakoutPressure>=68?'LONG':'NEUTRAL',{
    resistanceDistancePct:resistanceGap,headroomPct:sm.headroom,squeezeScore,volumeScore,closeLocationPct:Number.isFinite(closeLocation)?closeLocation*100:null
  }));

  const srScore=avg([
    Number.isFinite(supportGap)?clamp(92-supportGap*10):50,
    Number.isFinite(resistanceGap)?clamp(42+resistanceGap*11):50,
    structureScore,
    Number.isFinite(lastCandle.lowerWick)&&lastCandle.lowerWick>.22&&Number.isFinite(closeLocation)&&closeLocation>.55?78:50
  ])||50;
  a.push(analyst('SUPPORT_RESISTANCE','محلل الدعم والمقاومة',srScore,srScore>=63?'LONG':srScore<=36?'BEARISH':'NEUTRAL',{
    supportDistancePct:supportGap,resistanceDistancePct:resistanceGap,headroomPct:sm.headroom,
    lowerWick:lastCandle.lowerWick,closeLocationPct:Number.isFinite(closeLocation)?closeLocation*100:null
  }));

  const relativeScore=avg([
    Number.isFinite(rs15)?clamp(50+rs15*14):null,
    Number.isFinite(rs1)?clamp(50+rs1*11):null,
    Number.isFinite(rel24)?clamp(50+rel24*5):null
  ])||50;
  a.push(analyst('RELATIVE_STRENGTH','محلل القوة النسبية',relativeScore,relativeScore>=63?'LONG':relativeScore<=37?'BEARISH':'NEUTRAL',{
    vsBtc15m:rs15,vsBtc1h:rs1,vsMarket24h:rel24
  }));

  const bookScore=avg([
    Number.isFinite(book.imbalance)?clamp(50+book.imbalance*240):null,
    Number.isFinite(book.bidWallShare)&&Number.isFinite(book.askWallShare)?clamp(50+(book.bidWallShare-book.askWallShare)*240):null,
    Number.isFinite(book.spreadBps)?clamp(94-book.spreadBps*2.2):null
  ])||50;
  a.push(analyst('ORDERBOOK_PRESSURE','محلل دفتر الأوامر',bookScore,bookScore>=64?'LONG':bookScore<=36?'BEARISH':'NEUTRAL',{
    imbalance:book.imbalance,bidWallShare:book.bidWallShare,askWallShare:book.askWallShare,spreadBps:book.spreadBps
  }));

  const liquidityScore=clamp(liq);
  a.push(analyst('LIQUIDITY_QUALITY','محلل جودة السيولة',liquidityScore,liquidityScore>=72?'LONG':liquidityScore<45?'BEARISH':'NEUTRAL',{
    liquidityQuality:liq,spreadBps:book.spreadBps,depthBid:book.bidDepth,depthAsk:book.askDepth
  }));

  const whaleProxyScore=avg([
    bookScore,volumeScore,
    Number.isFinite(tRatio)?clamp(50+(tRatio-.5)*280):null,
    structureScore,
    Number.isFinite(volBurst)?clamp(50+(volBurst-1)*70):null
  ])||50;
  a.push(analyst('LARGE_PLAYER_PROXY','محلل سلوك اللاعبين الكبار',whaleProxyScore,whaleProxyScore>=66?'LONG':whaleProxyScore<=35?'BEARISH':'NEUTRAL',{
    bookImbalance:book.imbalance,takerBuyRatio:tRatio,volumeBurst:volBurst,structureScore
  }));

  const change15=Math.abs(Number.isFinite(Number(c15.at(-1)?.close))&&Number.isFinite(Number(c15.at(-8)?.close))
    ? (Number(c15.at(-1).close)-Number(c15.at(-8).close))/Math.max(1e-12,Number(c15.at(-8).close))*100 : NaN);
  const absorptionScore=avg([
    Number.isFinite(rv)?clamp(88-Math.abs(rv-1.8)*33):null,
    Number.isFinite(change15)?clamp(95-change15*17):null,
    Number.isFinite(uv.bias)?clamp(55+uv.bias*85):null,
    Number.isFinite(book.imbalance)?clamp(50+book.imbalance*150):null,
    Number.isFinite(closeLocation)?clamp(45+closeLocation*65):null
  ])||50;
  a.push(analyst('ABSORPTION','محلل امتصاص السيولة',absorptionScore,absorptionScore>=66?'LONG':'NEUTRAL',{
    rvol:rv,priceChangeWindowPct:change15,volumeBias:uv.bias,bookImbalance:book.imbalance,closeLocationPct:Number.isFinite(closeLocation)?closeLocation*100:null
  }));

  const extRisk=clamp(
    62
    -Math.max(0,(Number(candidate?.price_change_24h)||0)-7)*4.6
    -Math.max(0,(Number(distanceEma)||0)-4)*6
    -Math.max(0,(Number(avgUpperWick)||0)-.28)*100
    -Math.max(0,(Number(sniperFreshness.pumpHeat)||0)-45)*.38
    +(Number.isFinite(book.imbalance)&&book.imbalance>0.08?7:0)
    +(Number.isFinite(eff15)&&eff15>.62?4:0)
  );
  const riskScore=clamp(extRisk-(Number.isFinite(rsi)&&rsi>78?16:0));
  a.push(analyst('RISK_TRAPS','محلل الفخاخ والإرهاق',riskScore,riskScore>=64?'LONG':riskScore<42?'BEARISH':'NEUTRAL',{
    priceChange24h:candidate?.price_change_24h,distanceFromEmaPct:distanceEma,upperWickRatio:avgUpperWick,rsi,efficiency15m:eff15
  }));

  const extensionScore=clamp(
    82-Math.max(0,Number(distanceEma||0))*7-Math.max(0,(Number(candidate?.price_change_24h)||0)-4)*3.3+
    (Number.isFinite(closeLocation)&&closeLocation<.82?4:0)
    -(100-Number(sniperFreshness.freshness||50))*.32
  );
  a.push(analyst('EXTENSION','محلل عدم مطاردة السعر',extensionScore,extensionScore>=66?'LONG':extensionScore<42?'BEARISH':'NEUTRAL',{
    distanceFromEmaPct:distanceEma,move24hPct:candidate?.price_change_24h,closeLocationPct:Number.isFinite(closeLocation)?closeLocation*100:null,
    recentMoveHeat:sniperFreshness.pumpHeat,sniperFreshness:sniperFreshness.freshness,recent4Gain:sniperFreshness.recent4Gain,recent8Gain:sniperFreshness.recent8Gain
  }));

  const strategyScores=(candidate?.strategies||[]).map(x=>Number(x?.score?.value)).filter(Number.isFinite);
  const strategyScore=avg(strategyScores)||50;
  const accepted=Number(candidate?.accepted_strategies?.length)||0;
  const strategyCoverage=Number(candidate?.coverage?.ratio);
  a.push(analyst('STRATEGY_CONSENSUS','محلل إجماع الاستراتيجيات',strategyScore,strategyScore>=66?'LONG':strategyScore<=34?'BEARISH':'NEUTRAL',{
    strategyMean:strategyScore,activeStrategies:candidate?.coverage?.strategy_count||strategyScores.length,
    evaluatedStrategies:strategyScores.length,acceptedStrategies:accepted,coverageRatio:strategyCoverage
  }));

  const breadthScore=avg([
    Number.isFinite(Number(market.breadthPct))?Number(market.breadthPct):50,
    Number.isFinite(rel24)?clamp(50+rel24*8):50,
    Number.isFinite(median24)?clamp(50+median24*7):50
  ])||50;
  a.push(analyst('MARKET_BREADTH','محلل اتساع السوق',breadthScore,breadthScore>=63?'LONG':breadthScore<=37?'BEARISH':'NEUTRAL',{
    positiveBreadthPct:market.breadthPct,relative24h:rel24,marketMedian24h:median24
  }));

  const dataScore=clamp(avg([dq,liq,Number.isFinite(book.spreadBps)?clamp(94-book.spreadBps*2.5):null])||Math.min(dq,liq));
  a.push(analyst('DATA_INTEGRITY','حارس سلامة البيانات',dataScore,dq>=85&&liq>=70?'LONG':dq<50||liq<45?'BEARISH':'NEUTRAL',{
    dataQuality:dq,liquidityQuality:liq,spreadBps:book.spreadBps,
    closedCandles:{'4h':s4.length,'1h':s1.length,'15m':s15.length}
  }));

  const setupFingerprint={
    base_quality:clamp(avg([
      Number.isFinite(bb)?clamp(108-bb*90):null,
      Number.isFinite(ar)?clamp(108-ar*80):null,
      Number.isFinite(eff15)?clamp(35+eff15*65):null,
      Number.isFinite(rangePos)?clamp(100-Math.abs(rangePos-42)*1.8):null
    ])||50),
    momentum:clamp(avg([
      Number.isFinite(roc4)?clamp(50+roc4*12):null,
      Number.isFinite(rsiSlope15)?clamp(50+rsiSlope15*6):null,
      Number.isFinite(priceAccel)?clamp(50+priceAccel*18):null
    ])||50),
    pressure:clamp(avg([
      volumeScore,bookScore,absorptionScore,
      Number.isFinite(tRatio)?clamp(50+(tRatio-.5)*280):null
    ])||50),
    structure:clamp(avg([structureScore,srScore,mtf])||50),
    timing:clamp(avg([
      Number.isFinite(resistanceGap)?clamp(100-Math.max(0,resistanceGap)*15):50,
      Number.isFinite(sm.headroom)?clamp(100-Math.max(0,sm.headroom)*12):50,
      extensionScore
    ])||50),
    risk:clamp(avg([riskScore,extensionScore,liquidityScore])||50),
    freshness:sniperFreshness.freshness
  };
  const fingerprintScore=clamp(
    setupFingerprint.base_quality*.22+
    setupFingerprint.momentum*.18+
    setupFingerprint.pressure*.20+
    setupFingerprint.structure*.18+
    setupFingerprint.timing*.12+
    setupFingerprint.risk*.10
  );

  const features={
    price,priceChange24h:safe(candidate?.price_change_24h,0),
    high24:safe(candidate?.high_price_24h,null),low24:safe(candidate?.low_price_24h,null),
    rsi,rsi1,rsiSlope15,rsiSlope1,rv,volBurst,bb,ar,tRatio,
    structure:sm,book,roc4,roc16,trend4,trend1,rangePos,
    distanceEma,emaSpread15,emaSpread1,htfSpread,eff15,eff1,
    priceAccel,rangeBurst15,body:avgBody,upperWick:avgUpperWick,lowerWick:avgLowerWick,
    closeLocation,resistanceGap,supportGap,marketBreadth,
    relativeStrength15:rs15,relativeStrength1:rs1,relativeStrength24:rel24,
    setupFingerprint,fingerprintScore,
    recent_move:sniperFreshness,
    pump_heat:sniperFreshness.pumpHeat,
    sniper_freshness:sniperFreshness.freshness
  };
  return {a,features,dataValid:rowDataValid&&dq>=70&&liq>=60&&s4.length>=50&&s1.length>=50&&s15.length>=80};
}


export function analyzeMultiAnalystCandidate(candidate, market={}, memory=null, calibration=null){
  const specialist=specialistAnalysis(candidate,market);
  const final=finalVerdict(specialist.a,specialist.features,specialist.dataValid,market,memory,calibration);
  return {specialist,final};
}

const WEIGHTS={
  MARKET_REGIME:.06,MTF_ALIGNMENT:.06,MARKET_STRUCTURE:.07,BOTTOM_TURN:.07,MOMENTUM:.05,
  VOLUME_CONFIRMATION:.06,VOLATILITY_COMPRESSION:.05,PRE_BREAKOUT:.09,SUPPORT_RESISTANCE:.07,
  RELATIVE_STRENGTH:.05,ORDERBOOK_PRESSURE:.05,LIQUIDITY_QUALITY:.04,LARGE_PLAYER_PROXY:.04,
  ABSORPTION:.07,RISK_TRAPS:.09,EXTENSION:.04,STRATEGY_CONSENSUS:.05,MARKET_BREADTH:.04,DATA_INTEGRITY:.05
};
const CALIBRATION_HORIZONS=Object.freeze([
  {key:'15m',ms:15*60*1000,target:.010,stop:-.007},
  {key:'1h',ms:60*60*1000,target:.020,stop:-.012},
  {key:'4h',ms:4*60*60*1000,target:.040,stop:-.025}
]);
const calibrationFactor=(stats,minSamples=30)=>{
  const wins=Number(stats?.wins)||0,losses=Number(stats?.losses)||0,samples=wins+losses;
  if(samples<minSamples)return 1;
  return clamp(1+(wins/Math.max(1,samples)-.5)*.55,.86,1.14);
};
class SelfCalibrator{
  constructor(minSamples=30){
    this.minSamples=Math.max(10,Number(minSamples)||30);
    this.stats=new Map();
  }
  _get(id){
    if(!this.stats.has(id))this.stats.set(id,{wins:0,losses:0,neutral:0});
    return this.stats.get(id);
  }
  settle(analysts,ret,horizon){
    const r=Number(ret),target=Number(horizon?.target??.01),stop=Number(horizon?.stop??-.007);
    if(!Number.isFinite(r))return;
    for(const a of Array.isArray(analysts)?analysts:[]){
      if(a?.direction!=='LONG'||Number(a.score)<60)continue;
      const s=this._get(a.id);
      if(r>=target)s.wins++;
      else if(r<=stop)s.losses++;
      else s.neutral++;
    }
  }
  factor(id){return calibrationFactor(this.stats.get(id),this.minSamples);}
  summary(){
    return [...this.stats.entries()].map(([id,s])=>{
      const samples=s.wins+s.losses;
      return {id,samples,wins:s.wins,losses:s.losses,neutral:s.neutral,
        precision:samples?Math.round(s.wins/samples*1000)/10:null,
        factor:Math.round(this.factor(id)*1000)/1000};
    }).sort((a,b)=>b.samples-a.samples).slice(0,8);
  }
}
const GROUPS=['MACRO','TREND','STRUCTURE','REVERSAL','MOMENTUM','FLOW','VOLATILITY','BREAKOUT','PRICE_ACTION','RELATIVE','MICROSTRUCTURE','RISK','STRATEGY','DATA'];

const buildGroupConsensus=(analysts)=>{
  const out={};
  for(const group of GROUPS){
    const rows=analysts.filter(x=>x.group===group);
    if(!rows.length)continue;
    const scores=rows.map(x=>x.score);
    const long=rows.filter(x=>x.direction==='LONG').length;
    const bear=rows.filter(x=>x.direction==='BEARISH').length;
    out[group]={
      score:Math.round((avg(scores)||50)*10)/10,
      median:Math.round((median(scores)||50)*10)/10,
      long_votes:long,bearish_votes:bear,
      members:rows.length,
      coverage:Math.round((avg(rows.map(x=>x.coverage))*100)||0)/100
    };
  }
  return out;
};

const finalVerdict=(analysts,features,dataValid,market={},memory=null,calibration=null)=>{
  const regime=marketRegime(market);
  const weights=adaptiveWeights(regime);
  if(calibration instanceof SelfCalibrator){
    for(const id of Object.keys(weights))weights[id]*=calibration.factor(id);
  }
  const safeAnalysts=Array.isArray(analysts)?analysts:[];
  const groupConsensus=buildGroupConsensus(safeAnalysts);
  const weightedBase=safeAnalysts.reduce((sum,x)=>sum+clamp(x.score)*Number(weights[x.id]||0),0);
  const weightSum=Object.values(weights).reduce((sum,x)=>sum+Number(x||0),0)||1;
  const weightedScore=weightedBase/weightSum;
  const analystMedian=median(safeAnalysts.map(x=>x.score))||50;
  const groupScores=Object.values(groupConsensus).map(x=>x.score);
  const groupMean=avg(groupScores)||50;
  const balancedScore=clamp(weightedScore*.62+analystMedian*.15+groupMean*.23);

  const longStrength=safeAnalysts.reduce((s,x)=>s+(x.direction==='LONG'?Math.max(0,x.score-50):0),0);
  const bearStrength=safeAnalysts.reduce((s,x)=>s+(x.direction==='BEARISH'?Math.max(0,x.score-50):0),0);
  const directionEdge=longStrength-bearStrength;
  const positive=safeAnalysts.filter(x=>x.score>=65&&x.direction!=='BEARISH').length;
  const strong=safeAnalysts.filter(x=>x.score>=80&&x.direction==='LONG').length;
  const bearishStrong=safeAnalysts.filter(x=>x.score>=75&&x.direction==='BEARISH').length;
  const activeGroups=Object.keys(groupConsensus);
  const positiveGroups=activeGroups.filter(g=>groupConsensus[g].score>=62&&groupConsensus[g].long_votes>=1).length;
  const bearishGroups=activeGroups.filter(g=>groupConsensus[g].score<=42&&groupConsensus[g].bearish_votes>=1).length;
  const analystDispersion=stdev(safeAnalysts.map(x=>x.score));
  const groupDispersion=stdev(groupScores);
  const agreement=clamp(100-(analystDispersion||0)*2.35-(groupDispersion||0)*1.35);
  const avgCoverage=avg(safeAnalysts.map(x=>x.coverage))||0;
  const setup=features?.setupFingerprint||{};
  const early=earlyOpportunity({...features,setupFingerprint:setup},memory);
  const fingerprint=Number(features?.fingerprintScore);
  const move24=Number(early.move24),head=Number(early.head),emaDist=Number(early.emaDist);
  const pumpHeat=Number(early.pump_heat),freshness=Number(early.sniper_freshness);
  const recent4Gain=Number(features?.recent_move?.recent4Gain),recent8Gain=Number(features?.recent_move?.recent8Gain);
  const chase=(Number.isFinite(move24)&&move24>7)||(Number.isFinite(emaDist)&&emaDist>6)||(Number.isFinite(head)&&head<.15)||(Number.isFinite(recent4Gain)&&recent4Gain>=4.5);
  const pumpExhaustion=(Number.isFinite(pumpHeat)&&pumpHeat>=72)||
    (Number.isFinite(recent8Gain)&&recent8Gain>=7&&Number.isFinite(freshness)&&freshness<58);
  const sniperScore=clamp(
    Number(early.score||50)*.46+
    (Number.isFinite(freshness)?freshness:50)*.24+
    (Number.isFinite(early.trajectory_score)?early.trajectory_score:50)*.14+
    (Number.isFinite(Number(features?.fingerprintScore))?Number(features.fingerprintScore):50)*.16
  );
  if(chase||pumpExhaustion)early.score=Math.min(early.score,56);

  const earlyCoreIds=['MARKET_STRUCTURE','VOLUME_CONFIRMATION','PRE_BREAKOUT','SUPPORT_RESISTANCE','RELATIVE_STRENGTH','ABSORPTION'];
  const earlyCoreScores=earlyCoreIds.map(id=>Number(safeAnalysts.find(x=>x.id===id)?.score)).filter(Number.isFinite);
  const earlyCoreGood=earlyCoreScores.filter(x=>x>=58).length>=4&&Number(setup.base_quality)>=55&&Number(setup.pressure)>=55&&Number(setup.timing)>=55&&Number(setup.risk)>=55;
  const hardReasons=[];
  if(!dataValid)hardReasons.push('DATA_GATE_FAILED');
  if(safeAnalysts.length!==19)hardReasons.push('SPECIALIST_COUNT_INVALID');
  if(safeAnalysts.find(x=>x.id==='RISK_TRAPS')?.score<42)hardReasons.push('RISK_TOO_HIGH');
  if(safeAnalysts.find(x=>x.id==='EXTENSION')?.score<40)hardReasons.push('PRICE_ALREADY_EXTENDED');
  if(safeAnalysts.find(x=>x.id==='LIQUIDITY_QUALITY')?.score<60)hardReasons.push('LIQUIDITY_TOO_WEAK');
  if(bearishStrong>=3||bearishGroups>=3)hardReasons.push('CONSENSUS_CONTRADICTION');
  if(chase)hardReasons.push('EARLY_WINDOW_LOST');
  if(pumpExhaustion)hardReasons.push('RECENT_PUMP_EXHAUSTION');
  if(Number.isFinite(freshness)&&freshness<42)hardReasons.push('SNIPER_FRESHNESS_LOW');
  if(avgCoverage<0.78)hardReasons.push('ANALYST_EVIDENCE_COVERAGE_LOW');

  const direction=directionEdge>=40?'LONG':directionEdge<=-40?'BEARISH':'NEUTRAL';
  if(direction==='LONG'&&!earlyCoreGood&&early.score>=64)hardReasons.push('EARLY_CORE_NOT_READY');
  let timing='NO_SETUP';
  if(!chase&&direction==='LONG'&&early.score>=78&&(Number.isFinite(fingerprint)?fingerprint:0)>=76)timing='PRE_BREAKOUT';
  else if(!chase&&direction==='LONG'&&early.score>=68&&(Number.isFinite(fingerprint)?fingerprint:0)>=66)timing='EARLY_SETUP';
  else if(!chase&&direction==='LONG'&&early.score>=58)timing='CONFIRMING_SETUP';
  else if(chase)timing='EXTENDED';
  else if(direction==='BEARISH')timing='BEARISH';

  const criticalGood=['MARKET_STRUCTURE','VOLUME_CONFIRMATION','PRE_BREAKOUT','SUPPORT_RESISTANCE','RISK_TRAPS','LIQUIDITY_QUALITY']
    .every(id=>Number(safeAnalysts.find(x=>x.id===id)?.score)>=56);

  let verdict='REJECT';
  if(!hardReasons.length&&direction==='LONG'&&balancedScore>=84&&positive>=12&&strong>=5&&positiveGroups>=6&&criticalGood&&earlyCoreGood&&agreement>=74&&early.score>=76&&(Number.isFinite(fingerprint)?fingerprint:0)>=75&&early.trajectory_score>=48&&sniperScore>=82)
    verdict='STRONG_CANDIDATE';
  else if(!hardReasons.length&&direction==='LONG'&&balancedScore>=76&&positive>=10&&strong>=3&&positiveGroups>=5&&criticalGood&&earlyCoreGood&&agreement>=64&&early.score>=64&&(Number.isFinite(fingerprint)?fingerprint:0)>=64&&early.trajectory_score>=45&&sniperScore>=72)
    verdict='CANDIDATE';
  else if(!hardReasons.length&&direction==='LONG'&&balancedScore>=65&&positive>=8&&positiveGroups>=4&&agreement>=52&&early.score>=52&&sniperScore>=60)
    verdict='WATCH';

  const top=safeAnalysts.filter(x=>x.direction==='LONG').sort((a,b)=>b.score-a.score).slice(0,7);
  const weak=safeAnalysts.filter(x=>x.direction!=='LONG').sort((a,b)=>a.score-b.score).slice(0,5);
  const reasons=top.filter(x=>x.score>=72).slice(0,6).map(x=>x.name);
  if((Number(fingerprint)||0)>=74)reasons.push('بصمة تجهيز مبكر متعددة المصادر');
  if(positiveGroups>=6)reasons.push('توافق قوي بين مجموعات مستقلة');
  if(agreement>=74)reasons.push('تشتت منخفض بين المحللين');
  if(regime==='RISK_OFF')reasons.push('السوق دفاعي — تشديد بوابة المخاطر');

  const risks=[...new Set(safeAnalysts.flatMap(x=>x.risks||[]))].slice(0,8);
  const decisionGate={
    data_ok:dataValid,
    specialists_ok:safeAnalysts.length===19,
    critical_good:criticalGood,
    early_window_open:!chase,
    agreement_ok:agreement>=64,
    group_agreement_ok:positiveGroups>=5,
    contradiction_count:bearishStrong,
    evidence_coverage_ok:avgCoverage>=.78,
    early_core_ok:earlyCoreGood,
    trajectory_ok:early.trajectory_score>=45,
    trajectory_observations:early.trajectory_observations||0,
    sniper_freshness_ok:!Number.isFinite(freshness)||freshness>=42,
    recent_move_heat:Number.isFinite(pumpHeat)?Math.round(pumpHeat*10)/10:null,
    sniper_score:Math.round(sniperScore*10)/10,
    pump_exhaustion_blocked:pumpExhaustion
  };

  return {
    score:Math.round(balancedScore*10)/10,
    verdict,direction,
    positiveAnalysts:positive,strongAnalysts:strong,bearishStrongAnalysts:bearishStrong,totalAnalysts:safeAnalysts.length,
    hardReasons,reasons,risks,
    agreement:Math.round(agreement*10)/10,
    analyst_dispersion:Number.isFinite(analystDispersion)?Math.round(analystDispersion*10)/10:null,
    group_dispersion:Number.isFinite(groupDispersion)?Math.round(groupDispersion*10)/10:null,
    evidence_coverage:Math.round(avgCoverage*1000)/10,
    market_regime:regime,
    early_score:Math.round(early.score*10)/10,
    timing,
    temporal_persistence:Math.round(Number(early.persistence||0)*10)/10,
    temporal_trajectory:Number(early.trajectory_score),
    temporal_trajectory_observations:Number(early.trajectory_observations||0),
    recent_move_heat:Number.isFinite(pumpHeat)?Math.round(pumpHeat*10)/10:null,
    sniper_freshness:Number.isFinite(freshness)?Math.round(freshness*10)/10:null,
    sniper_score:Math.round(sniperScore*10)/10,
    setup_fingerprint:Number.isFinite(fingerprint)?Math.round(fingerprint*10)/10,
    group_consensus:groupConsensus,
    strongest_analysts:top.map(x=>({id:x.id,name:x.name,score:x.score,group:x.group})),
    weakest_analysts:weak.map(x=>({id:x.id,name:x.name,score:x.score,group:x.group,direction:x.direction})),
    score_components:{
      weighted:Math.round(weightedScore*10)/10,
      median:Math.round(analystMedian*10)/10,
      group_balance:Math.round(groupMean*10)/10,
      balanced:Math.round(balancedScore*10)/10,
      direction_edge:Math.round(directionEdge*10)/10
    },
    decision_gate:decisionGate,
    self_calibration:calibration instanceof SelfCalibrator?calibration.summary():null
  };
};

export class MultiAnalystEngine {
  constructor({rest,config={},clock=()=>Date.now(),store=null}={}){
    this.store=store;
    if(!rest||typeof rest.request!=='function')throw new Error('REST_CLIENT_REQUIRED');
    this.clock=clock;
    this.config={
      quote:'USDT',discoveryPool:28,deepScanPool:16,returnLimit:8,deepConcurrency:3,deepKlines:220,
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
    this.calibration=new SelfCalibrator(30);
    this.pendingOutcomes=new Map();
    this.running=false;
    this.monitorTimer=null;
    this.monitorStartedAt=null;
    this.monitorStats={scan_count:0,last_scan_at:null,last_error:null,next_scan_at:null,last_scan_successful:false};
  }
  _settleOutcome(symbol,currentPrice,now){
    const list=this.pendingOutcomes.get(symbol);
    if(!Array.isArray(list)||!list.length)return;
    const keep=[];
    for(const item of list){
      const age=now-item.asOf;
      const entry=Number(item.entryPrice),current=Number(currentPrice);
      for(const h of CALIBRATION_HORIZONS){
        if(item.evaluated[h.key]||age<h.ms)continue;
        item.evaluated[h.key]=true;
        if(entry>0&&current>0)this.calibration.settle(item.analysts,(current-entry)/entry,h);
      }
      if(now-item.asOf<5*60*60*1000)keep.push(item);
    }
    if(keep.length)this.pendingOutcomes.set(symbol,keep.slice(-2));
    else this.pendingOutcomes.delete(symbol);
  }
  _registerOutcome(item,now){
    if(!item||item.direction!=='LONG'||Number(item.earlyScore)<60||!(Number(item.entryPrice)>0))return;
    const existing=this.pendingOutcomes.get(item.symbol)||[];
    const last=existing.at(-1);
    if(last&&now-last.asOf<30*60*1000)return;
    existing.push({...item,asOf:now,evaluated:{'15m':false,'1h':false,'4h':false}});
    this.pendingOutcomes.set(item.symbol,existing.slice(-2));
  }
  async scan({quote=this.config.quote,limit=this.config.returnLimit}={}){
    const now=this.clock();
    const q=String(quote||this.config.quote).trim().toUpperCase();
    const requested=Math.max(1,Math.min(15,Math.trunc(Number(limit)||this.config.returnLimit)));
    if(!/^[A-Z]{2,10}$/.test(q))throw new Error('INVALID_QUOTE');
    if(this.cache&&this.cache.quote===q&&this.cache.expiresAt>now)return this.cache.value;
    if(this.busy){
      if(this.cache&&this.cache.quote===q){
        const cached=this.cache.value;
        return {...cached,meta:{...(cached.meta||{}),served_from_cache_while_scan:true,analysis_mode:'CACHE'}};
      }
      return this.busy;
    }
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

      const top=rankTickerRows(tickers.data,universe,{minQuoteVolume24h:this.config.minQuoteVolume24h,limit:Math.max(7,Math.trunc(this.config.discoveryPool*.36))});
      const bottom=rankBottomTickerRows(tickers.data,universe,{minQuoteVolume24h:this.config.minQuoteVolume24h,limit:Math.max(4,Math.trunc(this.config.discoveryPool*.20))});
      const wake=normalized.filter(x=>x.priceChange24h>=0.35&&x.priceChange24h<=7).sort((a,b)=>{
        const sa=Math.log10(Math.max(1,a.quoteVolume24h))*0.6+Math.min(7,a.priceChange24h)*8;
        const sb=Math.log10(Math.max(1,b.quoteVolume24h))*0.6+Math.min(7,b.priceChange24h)*8;
        return sb-sa;
      }).slice(0,Math.max(6,Math.trunc(this.config.discoveryPool*.30)));
      // Preserve real scan capacity for coins that are liquid but still relatively quiet.
      const quiet=normalized.filter(x=>
        x.quoteVolume24h>=this.config.minQuoteVolume24h &&
        x.priceChange24h>=-1.5&&x.priceChange24h<=3.5
      ).map(x=>{
        const range=Number.isFinite(x.highPrice24h)&&Number.isFinite(x.lowPrice24h)&&x.highPrice24h>x.lowPrice24h
          ?x.highPrice24h-x.lowPrice24h:null;
        const pos=range&&x.lastPrice>0?((x.lastPrice-x.lowPrice24h)/range)*100:50;
        const baseProximity=clamp(100-Math.abs(pos-42)*1.8);
        const moderateMove=clamp(100-Math.abs(x.priceChange24h-1.0)*22);
        const activity=clamp(Math.log10(Math.max(1,x.tradeCount24h))*16);
        const liquidity=clamp(Math.log10(Math.max(1,x.quoteVolume24h))*7);
        return {...x,quiet_discovery_score:baseProximity*.35+moderateMove*.25+activity*.18+liquidity*.22};
      }).sort((a,b)=>b.quiet_discovery_score-a.quiet_discovery_score)
        .slice(0,Math.max(5,Math.trunc(this.config.discoveryPool*.28)));
      // Round-robin the discovery buckets so volume leaders cannot consume the full deep-scan budget.
      const buckets=[top,wake,quiet,bottom],selected=[],seen=new Set();
      let bucketIndex=0;
      while(selected.length<this.config.discoveryPool&&buckets.some(b=>b.length)){
        const bucket=buckets[bucketIndex%buckets.length];
        if(bucket.length){
          const row=bucket.shift();
          if(row&&!seen.has(row.symbol)){seen.add(row.symbol);selected.push(row);}
        }
        bucketIndex++;
      }
      if(!selected.length)throw new Error('NO_SPOT_CANDIDATES');
      const deepPool=Math.max(1,Math.min(selected.length,Math.trunc(Number(this.config.deepScanPool)||selected.length)));
      const deepSelected=selected.slice(0,deepPool);
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
      const scanErrors=[];
      const scanned=await boundedMap(deepSelected,Math.max(1,Math.min(4,this.config.deepConcurrency)),async(ticker,index)=>{
        try{
          const row=await this.scanner.scanSymbol(ticker,index+1,{exchangeInfo:info.source,ticker:tickers.source},{klinesLimit:this.config.deepKlines,fastInterval:'',includeAnalysisPayload:true});
          if(!row)throw new Error('SYMBOL_SCAN_RETURNED_EMPTY');
          // A candidate must reach the 19 specialist analysts even when the data gate fails.
          // The final judge remains fail-closed: invalid/stale/future/incomplete data is rejected there.
          this._settleOutcome(ticker.symbol,row?.last_price,this.clock());
          let prior=null;
          try{ prior=await this.store?.getIntelligenceMemory?.(ticker.symbol) || null; }catch{ prior=null; }
          let analysis;
          try{
            analysis=analyzeMultiAnalystCandidate(row,{btc15,btc1,marketMedian24h,breadthPct},prior,this.calibration);
          }catch(analysisError){
            const msg='MULTI_ANALYST_ANALYSIS_FAILED:'+String(analysisError?.message||analysisError);
            const specialist={a:Array.from({length:19},(_,i)=>({
              id:'ANALYST_'+String(i+1).padStart(2,'0'),
              name:'محلل سلامة مؤقت '+String(i+1),
              score:0,direction:'NEUTRAL',decision:'FAIL',
              evidence:{error:msg},risks:[msg]
            })),features:{price:safe(row?.last_price,Number(ticker?.lastPrice)||null),priceChange24h:safe(row?.price_change_24h,0),structure:{bull:0,bear:0,headroom:null},book:{imbalance:null,bidWallShare:null,askWallShare:null}},dataValid:false};
            const final={
              score:0,verdict:'REJECT',direction:'NEUTRAL',positiveAnalysts:0,strongAnalysts:0,totalAnalysts:19,
              hardReasons:['DATA_GATE_FAILED',msg],reasons:[],risks:[msg],agreement:0,
              market_regime:'MIXED',early_score:0,timing:'NO_SETUP',temporal_persistence:0,
              decision_gate:{critical_good:false,early_window_open:false,agreement_ok:false},
              self_calibration:null
            };
            analysis={specialist,final};
            row.data_status={...(row.data_status||{}),data_valid:false,last_error:msg};
            row.reason_codes=[...(row.reason_codes||[]),'MULTI_ANALYST_ANALYSIS_FAILED'];
            row.invalidation=[...(row.invalidation||[]),'MULTI_ANALYST_ANALYSIS_FAILED'];
          }
          const specialist=analysis.specialist;
          const final=analysis.final;
          const publicAnalysts=specialist.a.map(x=>({...x}));
          delete row._analysis;
          this._registerOutcome({
            symbol:row.symbol,entryPrice:row.last_price,direction:final.direction,
            earlyScore:final.early_score,analysts:publicAnalysts
          },this.clock());
          return {
            symbol:row.symbol,rank:index+1,last_price:row.last_price,price_change_24h:row.price_change_24h,
            quote_volume_24h:row.quote_volume_24h,liquidity_quality:row.liquidity_quality,data_quality:row.data_quality,
            direction:final.direction,verdict:final.verdict,final_score:final.score,
            consensus:{positive:final.positiveAnalysts,strong:final.strongAnalysts,total:final.totalAnalysts,ratio:final.totalAnalysts>0?final.positiveAnalysts/final.totalAnalysts:0,bearish_strong:Number(final.bearishStrongAnalysts||0)},
            analysts:publicAnalysts,final_judge:final,
            highlights:specialist.a.filter(x=>x.score>=72).sort((a,b)=>b.score-a.score).slice(0,6),
            risk_flags:row.risk_flags||[],reason_codes:row.reason_codes||[],
            intelligence:{
              market_regime:final.market_regime,
              timing:final.timing,
              early_score:final.early_score,
              analyst_agreement:final.agreement,
              temporal_persistence:final.temporal_persistence,
              temporal_trajectory:final.temporal_trajectory,
              temporal_trajectory_observations:final.temporal_trajectory_observations,
              decision_gate:final.decision_gate
            },
            data_status:row.data_status,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
          };
        }catch(error){
          const message=String(error?.message??error);
          scanErrors.push({symbol:String(ticker?.symbol||'').toUpperCase(),rank:index+1,error:message});
          return null;
        }
      });
      const live=scanned.filter(Boolean);
      const validLive=live.filter(x=>x?.data_status?.data_valid===true);
      const gateRejected=live.filter(x=>x?.data_status?.data_valid!==true);

      for(const item of live){
        try{
          let previous=null;
          try{previous=await this.store?.getIntelligenceMemory?.(item.symbol)||null;}catch{}
          const previousHistory=Array.isArray(previous?.history)?previous.history:[];
          const history=[...previousHistory,{
            as_of:this.clock(),
            verdict:item.verdict,
            direction:item.direction,
            final_score:item.final_score,
            early_score:item.intelligence?.early_score ?? null,
            timing:item.intelligence?.timing ?? null,
            agreement:item.intelligence?.analyst_agreement ?? null
          }].slice(-12);
          await this.store?.putIntelligenceMemory?.(item.symbol,{
            as_of:this.clock(),
            verdict:item.verdict,
            direction:item.direction,
            final_score:item.final_score,
            early_score:item.intelligence?.early_score ?? null,
            timing:item.intelligence?.timing ?? null,
            agreement:item.intelligence?.analyst_agreement ?? null,
            history
          });
        }catch{}
      }
      live.sort((a,b)=>(b.final_judge?.sniper_score??-1)-(a.final_judge?.sniper_score??-1)||b.final_score-a.final_score||b.consensus.ratio-a.consensus.ratio||b.liquidity_quality-a.liquidity_quality);
      const qualified=live.filter(x=>x.verdict==='STRONG_CANDIDATE'||x.verdict==='CANDIDATE');
      const candidates=qualified.slice(0,Math.min(requested,5)).map((x,i)=>({...x,rank:i+1}));
      const watchlist=live.filter(x=>x.verdict==='WATCH').slice(0,Math.min(requested,3)).map((x,i)=>({...x,rank:i+1}));
      const strongCount=live.filter(x=>x.verdict==='STRONG_CANDIDATE').length;
      const value={
        meta:{live:live.some(x=>x.data_status?.data_valid===true),paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',radar:'MULTI_ANALYST',analyst_count:20,specialist_count:19,engine_revision:'ELITE_SNIPER_V1'},
        as_of:new Date(this.clock()).toISOString(),
        source:'Binance Public REST',
        universe:{quote:q,eligible_spot_symbols:universe.length,discovery_pool:selected.length,deep_scan_pool:deepSelected.length,scanned:live.length,returned:candidates.length,min_quote_volume_24h:this.config.minQuoteVolume24h},
        market_context:{regime:marketRegime({marketMedian24h,breadthPct}),median_24h_change_pct:marketMedian24h,positive_breadth_pct:breadthPct},
        summary:{strong_candidates:strongCount,candidates:live.filter(x=>x.verdict==='CANDIDATE').length,qualified:qualified.length,watch:live.filter(x=>x.verdict==='WATCH').length,rejected:live.filter(x=>x.verdict==='REJECT').length},
        candidates,watchlist,
        pipeline:['Broad Discovery','Early-Opportunity Gate','Data Gate','19 Specialist Analysts','Chief Analyst','Sniper Freshness Gate'],
        diagnostics:{
          scan_plan:{discovery:selected.length,deep:deepSelected.length,core_timeframes:['4h','1h','15m'],optional_fast_timeframe:null,shared_rest_broker:true},
          duration_ms:Math.max(0,this.clock()-startedAt),
          deep_concurrency:this.config.deepConcurrency,
          deep_klines:this.config.deepKlines,
          attempted_analyses:selected.length,
          successful_analyses:validLive.length,
          gate_rejected:gateRejected.length,
          failed_analyses:scanErrors.length,
          scan_errors:scanErrors.slice(0,20),
          gate_rejections:gateRejected.slice(0,20).map(x=>({
            symbol:x.symbol,
            reasons:x.reason_codes||[],
            invalidation:x.invalidation||[],
            last_error:x.data_status?.last_error??null
          }))
        }
      };
      this.monitorStats.scan_count=Number(this.monitorStats.scan_count||0)+1;
      this.monitorStats.last_scan_at=value.as_of;
      this.monitorStats.last_error=null;
      this.monitorStats.next_scan_at=new Date(this.clock()+Math.max(15000,Number(this.config.continuousIntervalMs)||90000)).toISOString();
      value.monitoring={
        continuous:true,
        running:this.running,
        interval_ms:Math.max(15000,Number(this.config.continuousIntervalMs)||90000),
        scan_count:this.monitorStats.scan_count,
        last_scan_at:this.monitorStats.last_scan_at,
        last_error:null,
        next_scan_at:this.monitorStats.next_scan_at
      };
      this.cache={quote:q,expiresAt:this.clock()+this.config.ttlMs,value};
      return value;
    })();
    try{return await this.busy}finally{this.busy=null;}
  }
  getCached({quote=this.config.quote}={}){
    return this.cache?.quote===String(quote).toUpperCase()?this.cache.value:null;
  }
  start(){
    if(this.running)return;
    this.running=true;
    this.monitorStartedAt=this.clock();
    const interval=Math.max(15000,Number(this.config.continuousIntervalMs)||90000);
    const warmup=Math.max(0,Number(this.config.continuousWarmupMs)||8000);
    const loop=async()=>{
      if(!this.running)return;
      try{
        await this.scan({quote:this.config.quote,limit:this.config.returnLimit});
      }catch(error){
        this.monitorStats.last_error=String(error?.message||error);
      }
      if(!this.running)return;
      this.monitorStats.next_scan_at=new Date(this.clock()+interval).toISOString();
      this.monitorTimer=setTimeout(loop,interval);
    };
    this.monitorTimer=setTimeout(loop,warmup);
  }
  stop(){
    this.running=false;
    if(this.monitorTimer)clearTimeout(this.monitorTimer);
    this.monitorTimer=null;
    this.monitorStats.next_scan_at=null;
  }
}

export const MULTI_ANALYST_NAMES=Object.freeze([
  'نظام السوق','توافق الأطر','هيكل القمم والقيعان','القاع والتحول','الزخم','تأكيد الحجم',
  'الانكماش والتجهيز','ما قبل الاختراق','الدعم والمقاومة','القوة النسبية','دفتر الأوامر',
  'جودة السيولة','سلوك اللاعبين الكبار','امتصاص السيولة','الفخاخ والإرهاق','عدم مطاردة السعر',
  'إجماع الاستراتيجيات','اتساع السوق','سلامة البيانات','المحلل النهائي'
]);