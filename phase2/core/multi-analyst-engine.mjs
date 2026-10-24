import {
  buildSpotUniverse,
  rankTickerRows,
  rankBottomTickerRows,
  normalizeRadarLimit,
  boundedMap,
  MarketUniverseScanner
} from '../market/universe-scanner.mjs';

import {finiteNumberOr} from './finite-number.mjs';
const clamp=(x,lo=0,hi=100)=>{
  // Null/blank/boolean inputs are missing evidence, not numeric zero.
  const n=finiteNumberOr(x,null);
  return n!==null?Math.max(lo,Math.min(hi,n)):50;
};
const avg=(xs)=>{
  const a=(Array.isArray(xs)?xs:[]).map(x=>finiteNumberOr(x,null)).filter(x=>x!==null);
  return a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
};

// Keep the top half of each early-move bucket, then rotate its remaining slots
// through lower-ranked eligible symbols so the same quiet coins do not monopolize deep analysis.
export function selectWithPriorityRotation(rows,limit,cursor=0){
  const source=Array.isArray(rows)?rows:[];
  const count=Math.max(0,Math.trunc(Number(limit)||0));
  if(!count||!source.length)return {rows:[],nextCursor:0};
  if(source.length<=count)return {rows:source.slice(),nextCursor:0};
  const priorityCount=Math.min(count,Math.max(1,Math.floor(count*.5)));
  const rotatingCount=count-priorityCount;
  if(!rotatingCount)return {rows:source.slice(0,count),nextCursor:0};
  const tail=source.slice(priorityCount);
  const start=((Math.trunc(Number(cursor)||0)%tail.length)+tail.length)%tail.length;
  const rotationSize=Math.min(rotatingCount,tail.length);
  const rotated=[];
  for(let i=0;i<rotationSize;i++)rotated.push(tail[(start+i)%tail.length]);
  return {
    rows:[...source.slice(0,priorityCount),...rotated],
    nextCursor:(start+rotationSize)%tail.length
  };
}

/** Reserve existing discovery capacity for queued radar symbols before round-robin buckets. */
export function selectDiscoveryWithRadarReviewPriority(priorityRows,buckets,limit,fallbackRows=[]){
  const max=Math.max(0,Math.trunc(Number(limit)||0));
  if(!max)return [];
  const selected=[],seen=new Set();
  const append=(row)=>{
    const symbol=String(row?.symbol||'').toUpperCase();
    if(!row||!symbol||seen.has(symbol))return false;
    seen.add(symbol);selected.push(row);return true;
  };
  for(const row of Array.isArray(priorityRows)?priorityRows:[]){
    append(row);
    if(selected.length>=max)return selected;
  }
  const lanes=(Array.isArray(buckets)?buckets:[]).map(rows=>Array.isArray(rows)?rows.slice():[]);
  let bucketIndex=0;
  while(selected.length<max&&lanes.some(rows=>rows.length)){
    const lane=lanes[bucketIndex%lanes.length];
    if(lane.length)append(lane.shift());
    bucketIndex++;
  }
  // The specialist buckets are intentionally selective and often overlap. If their
  // union is smaller than the scan budget, fill the unused slots from a rotating
  // eligible-market lane rather than silently scanning fewer coins than configured.
  for(const row of Array.isArray(fallbackRows)?fallbackRows:[]){
    if(selected.length>=max)break;
    append(row);
  }
  return selected;
}
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
  MARKET_REGIME:{group:'MACRO',role:'حالة السوق العام'},
  MTF_ALIGNMENT:{group:'TREND',role:'توافق الفترات الزمنية'},
  MARKET_STRUCTURE:{group:'STRUCTURE',role:'بنية السعر'},
  BOTTOM_TURN:{group:'COVERAGE',role:'اكتمال التغطية'},
  MOMENTUM:{group:'FLOW',role:'تسارع الصفقات'},
  VOLUME_CONFIRMATION:{group:'FLOW',role:'شذوذ الحجم'},
  VOLATILITY_COMPRESSION:{group:'VOLATILITY',role:'القاعدة الهادئة'},
  PRE_BREAKOUT:{group:'BREAKOUT',role:'تأكيد الاختراق'},
  SUPPORT_RESISTANCE:{group:'RISK',role:'التقلب والمخاطر'},
  RELATIVE_STRENGTH:{group:'RELATIVE',role:'القوة النسبية'},
  ORDERBOOK_PRESSURE:{group:'MICROSTRUCTURE',role:'تماسك عمق السوق'},
  LIQUIDITY_QUALITY:{group:'MICROSTRUCTURE',role:'السيولة'},
  LARGE_PLAYER_PROXY:{group:'HISTORY',role:'التشابه التاريخي'},
  ABSORPTION:{group:'FLOW',role:'ضغط الشراء'},
  RISK_TRAPS:{group:'RISK',role:'كشف المصائد'},
  EXTENSION:{group:'RISK',role:'منع المطاردة'},
  STRATEGY_CONSENSUS:{group:'CALIBRATION',role:'معايرة الثقة'},
  MARKET_BREADTH:{group:'CONSISTENCY',role:'تعارض الإشارات والتكرار'},
  DATA_INTEGRITY:{group:'DATA',role:'سلامة البيانات'}
});
export const MULTI_ANALYST_ROLE_CONTRACT=Object.freeze([
  {id:'DATA_INTEGRITY',role:'سلامة البيانات',hardGate:true},
  {id:'BOTTOM_TURN',role:'اكتمال التغطية',hardGate:true},
  {id:'LIQUIDITY_QUALITY',role:'السيولة',hardGate:true},
  {id:'VOLUME_CONFIRMATION',role:'شذوذ الحجم',hardGate:false},
  {id:'MOMENTUM',role:'تسارع الصفقات',hardGate:false},
  {id:'ABSORPTION',role:'ضغط الشراء',hardGate:false},
  {id:'MARKET_STRUCTURE',role:'بنية السعر',hardGate:false},
  {id:'VOLATILITY_COMPRESSION',role:'القاعدة الهادئة',hardGate:false},
  {id:'PRE_BREAKOUT',role:'تأكيد الاختراق',hardGate:false},
  {id:'EXTENSION',role:'منع المطاردة',hardGate:true},
  {id:'RISK_TRAPS',role:'كشف المصائد',hardGate:true},
  {id:'ORDERBOOK_PRESSURE',role:'تماسك عمق السوق',hardGate:false},
  {id:'MARKET_REGIME',role:'حالة السوق العام',hardGate:false},
  {id:'RELATIVE_STRENGTH',role:'القوة النسبية',hardGate:false},
  {id:'MTF_ALIGNMENT',role:'توافق الفترات الزمنية',hardGate:false},
  {id:'LARGE_PLAYER_PROXY',role:'التشابه التاريخي',hardGate:false},
  {id:'SUPPORT_RESISTANCE',role:'التقلب والمخاطر',hardGate:false},
  {id:'STRATEGY_CONSENSUS',role:'معايرة الثقة',hardGate:false},
  {id:'MARKET_BREADTH',role:'تعارض الإشارات والتكرار',hardGate:false}
]);

const finiteScalar=value=>value!==null&&value!==undefined&&!(typeof value==='string'&&value.trim()==='')&&typeof value!=='boolean'&&Number.isFinite(Number(value));
const hasFiniteEvidence=(value,depth=0)=>{
  if(finiteScalar(value))return true;
  if(depth>=5||value===null||value===undefined)return false;
  if(Array.isArray(value))return value.some(item=>hasFiniteEvidence(item,depth+1));
  if(typeof value==='object')return Object.values(value).some(item=>hasFiniteEvidence(item,depth+1));
  return false;
};
export const countAnalystEvidenceCoverage=evidence=>{
  const values=Object.values(evidence&&typeof evidence==='object'?evidence:{});
  return {used:values.filter(value=>hasFiniteEvidence(value)).length,total:values.length};
};
const finiteEvidenceCount=countAnalystEvidenceCoverage;

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

function inspectAnalystCandleCoverage(rows,{intervalMs,minCount,maxAgeMs,now}={}){
  const valid=(Array.isArray(rows)?rows:[]).filter(c=>c&&c.closed===true&&
    Number.isFinite(Number(c.openTime))&&Number.isFinite(Number(c.closeTime))&&
    Number(c.openTime)<=Number(c.closeTime)&&Number(c.closeTime)<=Number(now)&&
    Number(c.open)>0&&Number(c.low)>0&&Number(c.high)>=Math.max(Number(c.open),Number(c.close))&&
    Number(c.low)<=Math.min(Number(c.open),Number(c.close))&&Number(c.close)>0&&
    Number.isFinite(Number(c.volume))&&Number(c.volume)>=0)
    .slice().sort((a,b)=>Number(a.openTime)-Number(b.openTime));
  const unique=[];
  for(const c of valid){if(unique.length&&Number(unique.at(-1).openTime)===Number(c.openTime))continue;unique.push(c);}
  const tail=unique.slice(-20);let gapCount=0;
  for(let i=1;i<tail.length;i++){const delta=Number(tail[i].openTime)-Number(tail[i-1].openTime);if(delta<Number(intervalMs)*.5||delta>Number(intervalMs)*1.5)gapCount++;}
  const latest=unique.length?Number(unique.at(-1).closeTime):null,age=latest===null?null:Math.max(0,Number(now)-latest);
  const enough=unique.length>=Math.max(1,Number(minCount)||1),fresh=age!==null&&age<=Number(maxAgeMs),ready=enough&&fresh&&gapCount===0;
  const reasons=[];if(!enough)reasons.push('CLOSED_CANDLE_COUNT_INSUFFICIENT');if(!fresh)reasons.push('CLOSED_CANDLES_STALE');if(gapCount)reasons.push('CLOSED_CANDLE_SEQUENCE_HAS_GAPS');
  return {ready,count:unique.length,required_count:Math.max(1,Number(minCount)||1),coverage_pct:Math.round(Math.min(100,unique.length/Math.max(1,Number(minCount)||1)*100)*10)/10,latest_close_time_ms:latest,age_ms:age,gap_count:gapCount,interval_ms:Number(intervalMs),status:ready?'READY':'INCOMPLETE',reason_codes:reasons};
}
function historicalPatternSimilarity(rows,{windowBars=8,forwardBars=4}={}){
  const bars=(Array.isArray(rows)?rows:[]).filter(c=>c&&c.closed===true&&Number.isFinite(Number(c.close))&&Number(c.close)>0&&Number.isFinite(Number(c.volume))&&Number(c.volume)>=0);
  const n=bars.length,w=Math.max(6,Math.trunc(Number(windowBars)||8)),f=Math.max(2,Math.trunc(Number(forwardBars)||4));
  if(n<w+f+12)return {available:false,score:50,samples:0,win_rate:null,mean_forward_return_pct:null,nearest_distance:null,reason:'HISTORY_TOO_SHORT'};
  const cs=bars.map(c=>Number(c.close)),vs=bars.map(c=>Number(c.volume));
  const vector=end=>{const base=cs[end-w+1];if(!(base>0))return null;const ret=k=>end-k>=0&&cs[end-k]>0?(cs[end]/cs[end-k]-1)*100:null;const prior=vs.slice(Math.max(0,end-27),Math.max(0,end-3)),recent=vs.slice(Math.max(0,end-3),end+1),bv=median(prior),rv0=avg(recent);return [ret(2),ret(4),ret(w-1),bv>0&&Number.isFinite(rv0)?rv0/bv:null];};
  const current=vector(n-1);if(!current||current.some(v=>!Number.isFinite(v)))return {available:false,score:50,samples:0,win_rate:null,mean_forward_return_pct:null,nearest_distance:null,reason:'CURRENT_PATTERN_INCOMPLETE'};
  const scales=[1.25,2,3.5,1.25],matches=[];
  for(let end=w-1;end<=n-f-w-1;end++){const prior=vector(end);if(!prior||prior.some(v=>!Number.isFinite(v)))continue;const distance=avg(prior.map((v,i)=>Math.abs(v-current[i])/scales[i]));if(!Number.isFinite(distance)||distance>2.5)continue;const entry=cs[end],future=cs[end+f];if(entry>0&&future>0)matches.push({distance,forward_return_pct:(future/entry-1)*100});}
  matches.sort((a,b)=>a.distance-b.distance);const selected=matches.slice(0,12),count=selected.length;
  if(count<3)return {available:false,score:50,samples:count,win_rate:null,mean_forward_return_pct:null,nearest_distance:count?selected[0].distance:null,reason:'TOO_FEW_SIMILAR_HISTORICAL_PATTERNS'};
  const winRate=selected.filter(x=>x.forward_return_pct>0).length/count,meanReturn=avg(selected.map(x=>x.forward_return_pct))||0;
  return {available:true,score:Math.round(clamp(50+(winRate-.5)*70+meanReturn*9)*10)/10,samples:count,win_rate:Math.round(winRate*1000)/10,mean_forward_return_pct:Math.round(meanReturn*1000)/1000,nearest_distance:Math.round(selected[0].distance*1000)/1000,reason:'MATCHED_CLOSED_CANDLE_OUTCOMES'};
}
function calibrationReliability(calibration){
  let rows=[];try{rows=Array.isArray(calibration?.summary?.())?calibration.summary():[];}catch{}
  const usable=rows.filter(x=>Number(x?.samples)>0&&Number.isFinite(Number(x?.precision))),samples=usable.reduce((sum,x)=>sum+Number(x.samples||0),0),precision=samples?usable.reduce((sum,x)=>sum+Number(x.precision)*Number(x.samples),0)/samples:null;
  return {available:samples>0,samples,precision_pct:precision===null?null:Math.round(precision*10)/10,calibrated:samples>=30,score:samples>=10&&precision!==null?Math.round(clamp(50+(precision-50)*1.15)*10)/10:50,sources:'CLOSED_CANDLE_FORWARD_MARKOUTS'};
}
function specialistAnalysis(candidate, market={}, calibration=null){
  const raw=candidate?._analysis||{};
  const now=Number(raw?.completedAt)||Date.now();
  const s4=closed(raw?.series?.['4h'],now),s1=closed(raw?.series?.['1h'],now),s15=closed(raw?.series?.['15m'],now);
  const coverageReport={
    '4h':inspectAnalystCandleCoverage(s4,{intervalMs:4*60*60*1000,minCount:50,maxAgeMs:5*60*60*1000,now}),
    '1h':inspectAnalystCandleCoverage(s1,{intervalMs:60*60*1000,minCount:50,maxAgeMs:75*60*1000,now}),
    '15m':inspectAnalystCandleCoverage(s15,{intervalMs:15*60*1000,minCount:80,maxAgeMs:35*60*1000,now})
  };
  const coverageReady=Object.values(coverageReport).every(x=>x.ready===true);
  const symbol=String(candidate?.symbol||'').toUpperCase();
  const symbolValid=/^[A-Z0-9]{1,20}USDT$/.test(symbol)&&candidate?.data_status?.symbol_valid!==false&&candidate?.data_status?.spot_trading_allowed!==false&&candidate?.isSpotTradingAllowed!==false&&(!candidate?.quote_asset&&!candidate?.quoteAsset||String(candidate?.quote_asset??candidate?.quoteAsset).toUpperCase()==='USDT');
  const quoteVolume24h=safe(candidate?.quote_volume_24h,0);
  const sharedSnapshot={id:String(market?.snapshot_id||''),as_of:Number.isFinite(Number(market?.as_of))?Number(market.as_of):null,source:String(market?.snapshot_source||'UNKNOWN'),available:Boolean(market?.snapshot_id&&market?.as_of!==null&&market?.as_of!==undefined&&Number.isFinite(Number(market?.as_of))),btc_15m_count:Array.isArray(market?.btc15)?market.btc15.length:0,btc_1h_count:Array.isArray(market?.btc1)?market.btc1.length:0,market_median_24h:Number.isFinite(Number(market?.marketMedian24h))?Number(market.marketMedian24h):null,breadth_pct:Number.isFinite(Number(market?.breadthPct))?Number(market.breadthPct):null};
  const rowDataValid=candidate?.data_status?.data_valid===true;
  const c4=closes(s4),c1=closes(s1),c15=closes(s15);
  const price=safe(candidate?.last_price,null);
  const liq=safe(candidate?.liquidity_quality,0);
  const dq=safe(candidate?.data_quality,0);

  const tRatio=takerRatio(s15),rv=rvol(s15),uv=upVolRatio(s15),bb=bbRatio(s15),ar=atrRatio(s15);
  const recentTradeCount=avg(s15.slice(-4).map(c=>Number(c?.tradeCount??c?.count)).filter(Number.isFinite));
  const baselineTradeCount=median(s15.slice(-28,-4).map(c=>Number(c?.tradeCount??c?.count)).filter(Number.isFinite));
  const tradeAccelerationRatio=Number.isFinite(recentTradeCount)&&Number.isFinite(baselineTradeCount)&&baselineTradeCount>0?recentTradeCount/baselineTradeCount:null;
  const quoteVolumeRecent=s15.slice(-8).reduce((sum,c)=>sum+Math.max(0,Number(c?.quoteVolume)||0),0);
  const takerBuyQuoteRecent=s15.slice(-8).reduce((sum,c)=>sum+Math.max(0,Number(c?.takerBuyQuoteVolume)||0),0);
  const quoteBuyShare=quoteVolumeRecent>0&&takerBuyQuoteRecent<=quoteVolumeRecent*1.001?takerBuyQuoteRecent/quoteVolumeRecent:null;
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

  const coverageItems=Object.entries(coverageReport);
  const coverageScore=clamp(avg(coverageItems.map(([,item])=>item.ready?100:Math.max(0,item.coverage_pct-item.gap_count*12-(item.age_ms!==null&&item.age_ms>item.interval_ms*2?25:0))))||0);
  const coverageReasons=coverageItems.flatMap(([tf,item])=>item.reason_codes.map(code=>tf+':'+code));
  a.push(analyst('BOTTOM_TURN','محلل اكتمال التغطية',coverageScore,coverageReady?'LONG':coverageScore<55?'BEARISH':'NEUTRAL',{
    ready:coverageReady,score:coverageScore,fourHour:coverageReport['4h'],oneHour:coverageReport['1h'],fifteenMinute:coverageReport['15m'],gaps:coverageItems.reduce((sum,[,item])=>sum+item.gap_count,0),missingReasons:coverageReasons
  },coverageReasons));
  const tradeAccelerationScore=Number.isFinite(tradeAccelerationRatio)?clamp(50+(tradeAccelerationRatio-1)*42):50;
  a.push(analyst('MOMENTUM','محلل تسارع الصفقات',tradeAccelerationScore,tradeAccelerationScore>=62?'LONG':tradeAccelerationScore<=36?'BEARISH':'NEUTRAL',{
    recent_mean_trade_count:recentTradeCount,baseline_median_trade_count:baselineTradeCount,trade_count_acceleration_ratio:tradeAccelerationRatio,acceleration_pct:Number.isFinite(tradeAccelerationRatio)?(tradeAccelerationRatio-1)*100:null,recent_closed_candles:s15.slice(-4).length,baseline_closed_candles:s15.slice(-28,-4).length
  },tradeAccelerationRatio===null?['TRADE_COUNT_BASELINE_UNAVAILABLE']:[]));

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

  const compressionScore=avg([Number.isFinite(bb)?clamp(105-bb*95):null,Number.isFinite(ar)?clamp(105-ar*90):null,Number.isFinite(rangeBurst15)?clamp(92-(rangeBurst15-1)*70):null])||50;
  const dailyMoveAbs=Math.abs(Number(candidate?.price_change_24h)||0);
  const quietnessScore=clamp(100-Math.max(0,dailyMoveAbs-1.5)*10-Math.max(0,dailyMoveAbs-4)*8);
  const squeezeScore=clamp(compressionScore*.62+quietnessScore*.38);
  a.push(analyst('VOLATILITY_COMPRESSION','محلل القاعدة الهادئة',squeezeScore,squeezeScore>=70&&dailyMoveAbs<=6?'LONG':squeezeScore<38?'BEARISH':'NEUTRAL',{
    compression_score:compressionScore,quietness_score:quietnessScore,bb_width_ratio:bb,atr_ratio:ar,range_burst:rangeBurst15,abs_move_24h_pct:dailyMoveAbs,anti_chase_compatible:dailyMoveAbs<=6,own_volume_baseline_ratio:rv,own_trade_baseline_ratio:tradeAccelerationRatio
  },dailyMoveAbs>6?['QUIET_BASE_ALREADY_MOVED_TOO_FAR']:[]));

  const resistanceGap=Number.isFinite(price)&&Number.isFinite(sm.recentHigh)&&price>0?(sm.recentHigh-price)/price*100:null;
  const supportGap=Number.isFinite(price)&&Number.isFinite(sm.recentLow)&&price>0?(price-sm.recentLow)/price*100:null;
  const proximity=Number.isFinite(resistanceGap)?clamp(100-Math.max(0,resistanceGap)*14):50;
  const priorResistanceRows=s15.slice(-12,-3),priorResistance=priorResistanceRows.length?Math.max(...priorResistanceRows.map(c=>Number(c.high)).filter(Number.isFinite)):null;
  const recentBreakoutBars=s15.slice(-3),closesAboveResistance=Number.isFinite(priorResistance)?recentBreakoutBars.filter(c=>Number(c.close)>priorResistance).length:0;
  const latestClose=Number(s15.at(-1)?.close),currentLevelHeld=Number.isFinite(priorResistance)&&latestClose>=priorResistance;
  const recentActivityReady=Number.isFinite(rv)&&rv>=1.05&&Number.isFinite(tradeAccelerationRatio)&&tradeAccelerationRatio>=1.05;
  const buyFlowReady=Number.isFinite(quoteBuyShare??tRatio)&&Number(quoteBuyShare??tRatio)>=.50;
  const breakoutConfirmed=recentBreakoutBars.length===3&&closesAboveResistance>=2&&currentLevelHeld&&recentActivityReady&&buyFlowReady;
  const breakoutPressure=breakoutConfirmed?clamp(82+Math.min(8,Math.max(0,closesAboveResistance-1)*3)+(recentActivityReady?4:0)+(buyFlowReady?3:0)):clamp(Math.min(64,38+proximity*.12+(closesAboveResistance>0?8:0)+squeezeScore*.08+(Number.isFinite(rv)?Math.min(8,rv*2):0)));
  a.push(analyst('PRE_BREAKOUT','محلل تأكيد الاختراق',breakoutPressure,breakoutConfirmed?'LONG':breakoutPressure<35?'BEARISH':'NEUTRAL',{
    confirmed:breakoutConfirmed,resistance:priorResistance,closes_above_resistance:closesAboveResistance,recent_closed_candles:recentBreakoutBars.length,current_level_held:currentLevelHeld,volume_ratio:rv,trade_count_acceleration_ratio:tradeAccelerationRatio,buyer_quote_share:quoteBuyShare,taker_buy_ratio:tRatio
  },breakoutConfirmed?[]:['BREAKOUT_CONTINUATION_NOT_CONFIRMED']));

  const atrValue=atrLast(s15,14),atrPct=Number.isFinite(atrValue)&&price>0?atrValue/price*100:null;
  const volatilityRiskPenalty=Math.max(0,(Number(ar)||1)-1)*22+Math.max(0,(Number(candidate?.price_change_24h)||0)-5)*3.5+Math.max(0,(Number(atrPct)||0)-1.4)*12;
  const volatilityRiskScore=clamp(100-volatilityRiskPenalty);
  a.push(analyst('SUPPORT_RESISTANCE','محلل التقلب والمخاطر',volatilityRiskScore,volatilityRiskScore>=66?'LONG':volatilityRiskScore<38?'BEARISH':'NEUTRAL',{
    atr_14:atrValue,atr_pct:atrPct,atr_regime_ratio:ar,range_burst_ratio:rangeBurst15,price_change_24h_pct:candidate?.price_change_24h,normalized_risk_penalty:volatilityRiskPenalty
  },volatilityRiskScore<45?['VOLATILITY_OR_EXTENSION_RISK_HIGH']:[]));

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

  const historicalSimilarity=historicalPatternSimilarity(s15),historicalSimilarityScore=historicalSimilarity.score;
  a.push(analyst('LARGE_PLAYER_PROXY','محلل التشابه التاريخي',historicalSimilarityScore,historicalSimilarity.available&&historicalSimilarityScore>=62?'LONG':historicalSimilarity.available&&historicalSimilarityScore<38?'BEARISH':'NEUTRAL',{
    available:historicalSimilarity.available,similar_pattern_samples:historicalSimilarity.samples,historical_win_rate_pct:historicalSimilarity.win_rate,mean_forward_return_pct:historicalSimilarity.mean_forward_return_pct,nearest_pattern_distance:historicalSimilarity.nearest_distance,comparison_source:'SAME_SYMBOL_CLOSED_CANDLE_WINDOWS',reason:historicalSimilarity.reason
  },historicalSimilarity.available?[]:['HISTORICAL_ANALOG_SAMPLE_INSUFFICIENT']));

  const priorBuyShareRows=s15.slice(-16,-8),priorQuote=priorBuyShareRows.reduce((sum,c)=>sum+Math.max(0,Number(c?.quoteVolume)||0),0),priorBuy=priorBuyShareRows.reduce((sum,c)=>sum+Math.max(0,Number(c?.takerBuyQuoteVolume)||0),0);
  const priorBuyShare=priorQuote>0&&priorBuy<=priorQuote*1.001?priorBuy/priorQuote:null;
  const buyShare=Number.isFinite(quoteBuyShare)?quoteBuyShare:tRatio,priorShare=Number.isFinite(priorBuyShare)?priorBuyShare:null;
  const buyerShareDelta=Number.isFinite(buyShare)&&Number.isFinite(priorShare)?buyShare-priorShare:null;
  const buyPressureScore=Number.isFinite(buyShare)?clamp(50+(buyShare-.5)*250+(Number.isFinite(buyerShareDelta)?buyerShareDelta*120:0)):50;
  a.push(analyst('ABSORPTION','محلل ضغط الشراء',buyPressureScore,buyPressureScore>=62?'LONG':buyPressureScore<=38?'BEARISH':'NEUTRAL',{
    recent_buyer_initiated_quote_share:buyShare,previous_buyer_initiated_quote_share:priorShare,buyer_share_delta:buyerShareDelta,taker_buy_base_share:tRatio,quote_volume_recent:quoteVolumeRecent,taker_buy_quote_volume_recent:takerBuyQuoteRecent,buyer_flow_available:Number.isFinite(buyShare)
  },Number.isFinite(buyShare)?[]:['BUYER_FLOW_UNAVAILABLE']));

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

  const calibrationStats=calibrationReliability(calibration),calibratedConfidenceScore=calibrationStats.score;
  a.push(analyst('STRATEGY_CONSENSUS','محلل معايرة الثقة',calibratedConfidenceScore,calibratedConfidenceScore>=62?'LONG':calibratedConfidenceScore<38?'BEARISH':'NEUTRAL',{
    calibration_available:calibrationStats.available,closed_candle_markout_samples:calibrationStats.samples,realized_precision_pct:calibrationStats.precision_pct,calibration_mature:calibrationStats.calibrated,calibration_source:calibrationStats.sources,confidence_factor:calibrationStats.available?clamp(1+(Number(calibrationStats.precision_pct)-50)*.005,.86,1.14):1
  },calibrationStats.calibrated?[]:['CALIBRATION_SAMPLE_NOT_MATURE']));

  const priorDirectional=a.filter(x=>x.id!=='DATA_INTEGRITY'&&x.direction!=='NEUTRAL'&&x.score>=60);
  const bullishVotes=priorDirectional.filter(x=>x.direction==='LONG').length,bearishVotes=priorDirectional.filter(x=>x.direction==='BEARISH').length,directionalVotes=bullishVotes+bearishVotes;
  const conflictRatio=directionalVotes?2*Math.min(bullishVotes,bearishVotes)/directionalVotes:0;
  const sourceRadars=[...new Set((Array.isArray(candidate?._analyst_context?.source_radars)?candidate._analyst_context.source_radars:[]).map(x=>String(x||'').trim().toUpperCase()).filter(Boolean))].slice(0,8);
  const duplicateSourceCount=Math.max(0,sourceRadars.length-1),priorReview=Boolean(candidate?._analyst_context?.radar_review_priority),conflictScore=clamp(100-conflictRatio*100);
  a.push(analyst('MARKET_BREADTH','محلل تعارض الإشارات والتكرار',conflictScore,conflictScore>=68?'LONG':conflictScore<35?'BEARISH':'NEUTRAL',{
    directional_specialists:directionalVotes,bullish_specialists:bullishVotes,bearish_specialists:bearishVotes,directional_conflict_ratio:Math.round(conflictRatio*1000)/1000,source_radars:sourceRadars,unique_source_radar_count:sourceRadars.length,duplicate_source_count:duplicateSourceCount,one_symbol_one_review:true,radar_review_priority:priorReview,duplicate_notification_policy:'CONSOLIDATE_BY_SYMBOL_AND_USE_NOTIFICATION_GATE'
  },conflictRatio>=.65?['SPECIALIST_DIRECTION_CONFLICT_HIGH']:[]));

  const spreadAvailable=Number.isFinite(book.spreadBps),spreadAcceptable=spreadAvailable&&book.spreadBps<=35;
  const primaryEvidenceComplete=Boolean(rowDataValid&&symbolValid&&coverageReady&&quoteVolume24h>=300000&&liq>=60&&spreadAcceptable&&Number.isFinite(rv)&&Number.isFinite(tradeAccelerationRatio)&&Number.isFinite(buyShare));
  const dataScoreRaw=clamp(avg([dq,liq,coverageScore,spreadAvailable?clamp(94-book.spreadBps*2.5):null])||Math.min(dq,liq));
  const dataScore=primaryEvidenceComplete?dataScoreRaw:Math.min(45,dataScoreRaw);
  const dataRisks=[
    !rowDataValid?'DATA_STATUS_NOT_VALID':null,!symbolValid?'INVALID_SPOT_SYMBOL':null,!coverageReady?'CLOSED_CANDLE_COVERAGE_NOT_READY':null,
    quoteVolume24h<300000?'QUOTE_VOLUME_BELOW_MINIMUM':null,!spreadAvailable?'SPREAD_UNAVAILABLE':null,spreadAvailable&&!spreadAcceptable?'SPREAD_TOO_WIDE':null,
    !Number.isFinite(rv)?'VOLUME_BASELINE_UNAVAILABLE':null,!Number.isFinite(tradeAccelerationRatio)?'TRADE_COUNT_BASELINE_UNAVAILABLE':null,!Number.isFinite(buyShare)?'BUY_PRESSURE_UNAVAILABLE':null
  ].filter(Boolean);
  a.push(analyst('DATA_INTEGRITY','حارس سلامة البيانات',dataScore,primaryEvidenceComplete&&dq>=85&&liq>=70?'LONG':!primaryEvidenceComplete?'BEARISH':'NEUTRAL',{
    data_quality:dq,liquidity_quality:liq,quote_volume_24h:quoteVolume24h,spread_bps:book.spreadBps,spread_available:spreadAvailable,symbol_valid:symbolValid,source_status:candidate?.data_status||null,
    closed_candles:{'4h':s4.length,'1h':s1.length,'15m':s15.length},coverage_report:coverageReport,primary_evidence_complete:primaryEvidenceComplete,shared_snapshot:sharedSnapshot
  },dataRisks));

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
      volumeScore,bookScore,buyPressureScore,
      Number.isFinite(tRatio)?clamp(50+(tRatio-.5)*280):null
    ])||50),
    structure:clamp(avg([structureScore,breakoutPressure,mtf])||50),
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
    quoteVolume24h:quoteVolume24h,
    symbol_valid:symbolValid,
    coverage_report:{ready:coverageReady,by_timeframe:coverageReport},
    primary_evidence_complete:primaryEvidenceComplete,
    shared_snapshot:sharedSnapshot,
    trade_acceleration_ratio:tradeAccelerationRatio,
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
  const dataValid=primaryEvidenceComplete&&dq>=70&&liq>=60&&coverageReady&&symbolValid;
  return {a,features,dataValid,sharedSnapshot};
}


export function analyzeMultiAnalystCandidate(candidate, market={}, memory=null, calibration=null){
  const specialist=specialistAnalysis(candidate,market,calibration);
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
const CALIBRATION_MARKOUT_GRACE_MS=20*60*1000;
function closedHorizonMarkout(rows,dueAt,now){
  const candles=closed(rows,now).filter(c=>{
    const open=Number(c.open),high=Number(c.high),low=Number(c.low),close=Number(c.close),volume=Number(c.volume),closeTime=Number(c.closeTime);
    return Number.isFinite(closeTime)&&closeTime>=dueAt&&closeTime<=dueAt+CALIBRATION_MARKOUT_GRACE_MS&&
      [open,high,low,close,volume].every(Number.isFinite)&&open>0&&high>0&&low>0&&close>0&&volume>=0&&
      high>=Math.max(open,low,close)&&low<=Math.min(open,high,close);
  }).sort((a,b)=>Number(a.closeTime)-Number(b.closeTime));
  const candle=candles[0];
  return candle?{price:Number(candle.close),closeTime:Number(candle.closeTime),source:'CLOSED_15M_CANDLE'}:null;
}
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
    }).sort((a,b)=>b.samples-a.samples).slice(0,19);
  }
}
const GROUPS=['MACRO','TREND','STRUCTURE','COVERAGE','MOMENTUM','FLOW','VOLATILITY','BREAKOUT','PRICE_ACTION','RELATIVE','MICROSTRUCTURE','RISK','STRATEGY','DATA','HISTORY','CALIBRATION','CONSISTENCY'];

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

export function isMomentumLiquidityEligible(quoteVolume24h,volumeSpikeRatio){
  const quoteVolume=Number(quoteVolume24h),spike=Number(volumeSpikeRatio);
  return Number.isFinite(quoteVolume)&&quoteVolume>=1_000_000&&Number.isFinite(spike)&&spike>=2.5;
}

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
  const volumeSpikeValues=[features?.volBurst,features?.rv].map(Number).filter(Number.isFinite);
  const volumeSpikeRatio=volumeSpikeValues.length?Math.max(...volumeSpikeValues):null;
  const momentumLiquidityEligible=dataValid&&isMomentumLiquidityEligible(features?.quoteVolume24h,volumeSpikeRatio);
  const momentumWindow=momentumLiquidityEligible&&Number(features?.roc4)>=0.35&&
    (Number(features?.tRatio)>=0.51||Number(features?.priceAccel)>=0.15);
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
  if(features?.symbol_valid!==true)hardReasons.push('SPOT_SYMBOL_INVALID');
  if(features?.coverage_report?.ready!==true)hardReasons.push('CANDLE_COVERAGE_INCOMPLETE');
  if(Number(features?.quoteVolume24h)<300000)hardReasons.push('LIQUIDITY_NOTIONAL_TOO_LOW');
  if(!Number.isFinite(features?.book?.spreadBps))hardReasons.push('SPREAD_EVIDENCE_UNAVAILABLE');
  else if(Number(features.book.spreadBps)>35)hardReasons.push('SPREAD_TOO_WIDE');
  if(features?.primary_evidence_complete!==true)hardReasons.push('PRIMARY_EVIDENCE_INCOMPLETE');
  if(features?.shared_snapshot?.available!==true)hardReasons.push('SHARED_MARKET_SNAPSHOT_UNAVAILABLE');
  if(safeAnalysts.length!==19)hardReasons.push('SPECIALIST_COUNT_INVALID');
  if(new Set(safeAnalysts.map(x=>String(x?.id||''))).size!==19||safeAnalysts.some(x=>!Object.prototype.hasOwnProperty.call(ANALYST_PROFILES,String(x?.id||''))))hardReasons.push('SPECIALIST_IDS_INVALID');
  if(safeAnalysts.some(x=>!Number.isFinite(Number(x?.score))||!['LONG','BEARISH','NEUTRAL'].includes(x?.direction)))hardReasons.push('SPECIALIST_OUTPUT_INVALID');
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
  else if(!hardReasons.length&&direction==='LONG'&&momentumWindow&&balancedScore>=70&&
    positive>=Math.ceil(safeAnalysts.length*0.62)&&positiveGroups>=4&&criticalGood&&earlyCoreGood&&
    agreement>=60&&early.score>=60&&(Number.isFinite(fingerprint)?fingerprint:0)>=60&&
    early.trajectory_score>=40&&sniperScore>=65)
    verdict='CANDIDATE';
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
    momentum_window:momentumWindow,
    momentum_liquidity_eligible:momentumLiquidityEligible,
    momentum_volume_spike_ratio:Number.isFinite(Number(volumeSpikeRatio))?Math.round(Number(volumeSpikeRatio)*100)/100:null,
    momentum_consensus_ratio_required:momentumWindow?0.62:null,
    positive_consensus_ratio:safeAnalysts.length?Math.round(positive/safeAnalysts.length*1000)/1000:0,
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

  const decision=hardReasons.length?'REJECT':(verdict==='STRONG_CANDIDATE'||verdict==='CANDIDATE')?'ACCEPT':verdict==='WATCH'?'WAIT':'REDUCE_CONFIDENCE';
  return {
    score:Math.round(balancedScore*10)/10,
    verdict,direction,decision,
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
    setup_fingerprint:Number.isFinite(fingerprint)?Math.round(fingerprint*10)/10:null,
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

export function nextContinuousScanDelayMs(intervalMs, elapsedMs=0){
  const interval=Math.max(15000,Number(intervalMs)||60000);
  const elapsed=Number(elapsedMs);
  return Math.max(0,interval-(Number.isFinite(elapsed)?Math.max(0,elapsed):0));
}

/**
 * Read-only visibility lane for positive 24h Spot movers. It is deliberately
 * separate from analyst verdicts: ticker-only rows never become candidates,
 * recommendations, or push alerts. If a mover did enter this cycle's deep scan,
 * include the actual verdict and reasons; otherwise say it was not analyzed.
 */
export function buildMultiAnalystMarketMoverObservations(rows,analysedRows=[],{
  minMovePct=8,maxExtended24hMovePct=18,minQuoteVolume24h=300000,limit=15
}={}){
  const bySymbol=new Map((Array.isArray(analysedRows)?analysedRows:[])
    .filter(x=>x&&typeof x.symbol==='string')
    .map(x=>[String(x.symbol).trim().toUpperCase(),x]));
  const take=Math.max(1,Math.min(25,Math.trunc(Number(limit)||15)));
  return (Array.isArray(rows)?rows:[])
    .map(row=>({
      row,
      symbol:String(row?.symbol||'').trim().toUpperCase(),
      price:Number(row?.lastPrice??row?.last_price),
      change:Number(row?.priceChange24h??row?.price_change_24h),
      volume:Number(row?.quoteVolume24h??row?.quote_volume_24h),
      trades:Number(row?.tradeCount24h??row?.trade_count_24h)
    }))
    .filter(x=>/^[A-Z0-9]{1,26}USDT$/.test(x.symbol)&&Number.isFinite(x.price)&&x.price>0&&
      Number.isFinite(x.change)&&x.change>=Number(minMovePct)&&
      Number.isFinite(x.volume)&&x.volume>=Math.max(1,Number(minQuoteVolume24h)||1))
    .sort((a,b)=>b.change-a.change||b.volume-a.volume||a.symbol.localeCompare(b.symbol))
    .slice(0,take)
    .map(x=>{
      const analysed=bySymbol.get(x.symbol)||null;
      const extended=x.change>Number(maxExtended24hMovePct);
      const analysisFailed=analysed?.analyst_execution?.analysis_failed===true;
      return {
        symbol:x.symbol,last_price:x.price,price_change_24h:x.change,
        quote_volume_24h:x.volume,trade_count_24h:Number.isFinite(x.trades)?x.trades:null,
        stage:extended?'ALREADY_EXTENDED':analysed?String(analysed.verdict||'ANALYZED_THIS_CYCLE'):'TICKER_MOVER_ONLY',
        analysis_status:analysed?(analysisFailed?'ANALYSIS_FAILED':'ANALYZED_THIS_CYCLE'):'NOT_DEEP_SCANNED_THIS_CYCLE',
        analyst_verdict:analysed?(analysisFailed?'ANALYSIS_FAILED':String(analysed.verdict||'UNKNOWN')):null,
        final_score:analysed&&!analysisFailed&&Number.isFinite(Number(analysed.final_score))?Number(analysed.final_score):null,
        analyst_count:Number(analysed?.analyst_execution?.specialist_count)||0,
        reason_codes:analysed
          ?[...(Array.isArray(analysed.reason_codes)?analysed.reason_codes:[]),
             ...(Array.isArray(analysed.final_judge?.hardReasons)?analysed.final_judge.hardReasons:[])].slice(0,8)
          :extended?['ANTI_CHASE_24H_MOVE_EXCEEDED','ANALYSTS_NOT_RUN_FOR_THIS_SYMBOL']:['NOT_DEEP_SCANNED_THIS_CYCLE'],
        hard_reasons:analysed&&Array.isArray(analysed.final_judge?.hardReasons)?analysed.final_judge.hardReasons.slice(0,8):[],
        data_quality:analysed&&Number.isFinite(Number(analysed.data_quality))?Number(analysed.data_quality):null,
        liquidity_quality:analysed&&Number.isFinite(Number(analysed.liquidity_quality))?Number(analysed.liquidity_quality):null,
        diagnostic_only:true,watch_only:true,entry_eligible:false,actionable:false,
        paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
        source:analysed?'Binance Public REST + 19 specialists + final analyst':'Binance Public REST ticker only'
      };
    });
}

/**
 * Report whether the real 19 named specialists and final judge completed.
 * Placeholder records from an exception path must never masquerade as analysis.
 */
export function buildAnalystExecutionStatus({specialists=[],final=null,analysisFailed=false}={}){
  const rows=Array.isArray(specialists)?specialists:[];
  const ids=rows.map(item=>String(item?.id||'')).filter(Boolean);
  const roles=rows.map(item=>String(item?.role||'')).filter(Boolean);
  const uniqueIds=new Set(ids),uniqueRoles=new Set(roles);
  const placeholderIds=ids.filter(id=>/^ANALYST_\d+$/i.test(id));
  const failed=analysisFailed===true;
  const specialistsComplete=!failed&&rows.length===19&&uniqueIds.size===19&&
    uniqueRoles.size===19&&placeholderIds.length===0;
  return {
    expected_analysts:20,
    specialist_count:rows.length,
    unique_specialists:uniqueIds.size,
    unique_roles:uniqueRoles.size,
    specialists_complete:specialistsComplete,
    final_analyst_complete:Boolean(!failed&&specialistsComplete&&final&&
      Number(final.totalAnalysts)===19&&typeof final.verdict==='string'),
    analysis_failed:failed
  };
}

export class MultiAnalystEngine {
  constructor({rest,config={},clock=()=>Date.now(),store=null}={}){
    this.store=store;
    if(!rest||typeof rest.request!=='function')throw new Error('REST_CLIENT_REQUIRED');
    this.clock=clock;
    this.config={
      quote:'USDT',discoveryPool:28,deepScanPool:12,returnLimit:8,deepConcurrency:3,deepKlines:220,
      minQuoteVolume24h:300000,minDataQuality:70,minLiquidityQuality:60,
      ttlMs:45000,universeRefreshMs:30*60*1000,continuousIntervalMs:60000,continuousWarmupMs:8000,
      scanTimeoutMs:60000,
      radarReviewMaxQueue:200,radarReviewSlotsPerCycle:4,radarReviewQueueTtlMs:300000,
      radarReviewRetryCooldownMs:60000,radarReviewAssessmentTtlMs:180000,...config
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
    this.universeCacheByQuote=new Map();
    this.busy=null;
    this.calibration=new SelfCalibrator(30);
    this.discoveryRotationCursors=new Map();
    this.pendingOutcomes=new Map();
    this.running=false;
    this.monitorTimer=null;
    this.monitorStartedAt=null;
    this.monitorStats={scan_count:0,last_scan_at:null,last_error:null,next_scan_at:null,last_scan_successful:false,active_scan_started_at:null,active_scan_deadline_at:null};
    this.pendingRadarReviews=new Map();
    this.latestAnalystAssessments=new Map();
    this.lastRadarReviewSelection=[];
  }

  _pruneRadarReviewState(now=this.clock()){
    const queueTtl=Math.max(10000,Number(this.config.radarReviewQueueTtlMs)||300000);
    for(const [symbol,item] of this.pendingRadarReviews){
      if(now-Number(item?.last_queued_at||item?.first_queued_at||0)>queueTtl)this.pendingRadarReviews.delete(symbol);
    }
    const assessmentTtl=Math.max(60000,Number(this.config.radarReviewAssessmentTtlMs)||180000);
    const retention=Math.max(10*60*1000,assessmentTtl*4);
    for(const [symbol,item] of this.latestAnalystAssessments){
      if(now-Number(item?.assessed_at_ms||0)>retention)this.latestAnalystAssessments.delete(symbol);
    }
    while(this.pendingRadarReviews.size>Math.max(1,Math.trunc(Number(this.config.radarReviewMaxQueue)||200))){
      const oldest=[...this.pendingRadarReviews.values()].sort((a,b)=>a.first_queued_at-b.first_queued_at)[0];
      if(!oldest)break;
      this.pendingRadarReviews.delete(oldest.symbol);
    }
    while(this.latestAnalystAssessments.size>1000){
      const oldest=[...this.latestAnalystAssessments.values()].sort((a,b)=>a.assessed_at_ms-b.assessed_at_ms)[0];
      if(!oldest)break;
      this.latestAnalystAssessments.delete(oldest.symbol);
    }
  }

  enqueueRadarReview(symbol,{sourceRadar='UNKNOWN_RADAR'}={}){
    const clean=String(symbol||'').trim().toUpperCase();
    if(!/^[A-Z0-9]{2,30}$/.test(clean))return {queued:false,reason:'INVALID_SYMBOL',pending_count:this.pendingRadarReviews.size};
    const now=this.clock();
    this._pruneRadarReviewState(now);
    const source=String(sourceRadar||'UNKNOWN_RADAR').trim().toUpperCase().slice(0,80)||'UNKNOWN_RADAR';
    const existing=this.pendingRadarReviews.get(clean);
    if(existing){
      existing.last_queued_at=now;
      if(!existing.source_radars.includes(source)&&existing.source_radars.length<8)existing.source_radars.push(source);
      return {queued:true,already_queued:true,symbol:clean,pending_count:this.pendingRadarReviews.size};
    }
    const capacity=Math.max(1,Math.min(1000,Math.trunc(Number(this.config.radarReviewMaxQueue)||200)));
    if(this.pendingRadarReviews.size>=capacity){
      const oldest=[...this.pendingRadarReviews.values()].sort((a,b)=>a.first_queued_at-b.first_queued_at)[0];
      if(oldest)this.pendingRadarReviews.delete(oldest.symbol);
    }
    this.pendingRadarReviews.set(clean,{
      symbol:clean,first_queued_at:now,last_queued_at:now,last_attempt_at:null,
      attempts:0,last_error:null,source_radars:[source]
    });
    return {queued:true,already_queued:false,symbol:clean,pending_count:this.pendingRadarReviews.size};
  }

  getLatestAssessment(symbol,{maxAgeMs=Number(this.config.radarReviewAssessmentTtlMs)||180000}={}){
    const clean=String(symbol||'').trim().toUpperCase();
    const now=this.clock();
    this._pruneRadarReviewState(now);
    const row=this.latestAnalystAssessments.get(clean);
    if(!row)return null;
    const age=Math.max(0,now-Number(row.assessed_at_ms||0));
    if(age>Math.max(1000,Number(maxAgeMs)||180000))return null;
    return {...row,age_ms:age};
  }

  radarReviewQueueSnapshot(now=this.clock()){
    this._pruneRadarReviewState(now);
    const rows=[...this.pendingRadarReviews.values()];
    const oldest=rows.length?Math.min(...rows.map(x=>Number(x.first_queued_at)||now)):null;
    const assessmentTtl=Math.max(60000,Number(this.config.radarReviewAssessmentTtlMs)||180000);
    return {
      pending_count:rows.length,
      max_queue:Math.max(1,Math.min(1000,Math.trunc(Number(this.config.radarReviewMaxQueue)||200))),
      queue_ttl_ms:Math.max(10000,Number(this.config.radarReviewQueueTtlMs)||300000),
      priority_slots_per_cycle:Math.max(1,Math.min(5,Math.trunc(Number(this.config.radarReviewSlotsPerCycle)||4))),
      retry_cooldown_ms:Math.max(15000,Number(this.config.radarReviewRetryCooldownMs)||60000),
      oldest_pending_age_ms:oldest===null?0:Math.max(0,now-oldest),
      pending_reviews:rows.slice().sort((a,b)=>a.first_queued_at-b.first_queued_at).slice(0,50).map(item=>({
        symbol:item.symbol,
        age_ms:Math.max(0,now-Number(item.first_queued_at||now)),
        attempts:Number(item.attempts||0),
        source_radars:(item.source_radars||[]).slice(0,8),
        last_error:item.last_error||null
      })),
      last_selected_symbols:this.lastRadarReviewSelection.slice(),
      recent_assessment_count:this.latestAnalystAssessments.size,
      assessment_ttl_ms:assessmentTtl
    };
  }

  latestAssessments({limit=40,symbols=[]}={}){
    const now=this.clock();
    this._pruneRadarReviewState(now);
    const wanted=[...new Set((Array.isArray(symbols)?symbols:[]).map(x=>String(x||'').trim().toUpperCase()).filter(x=>/^[A-Z0-9]{2,30}$/.test(x)))].slice(0,30);
    let rows;
    if(wanted.length){
      rows=wanted.map(symbol=>this.latestAnalystAssessments.get(symbol)).filter(Boolean);
    }else{
      rows=[...this.latestAnalystAssessments.values()].sort((a,b)=>b.assessed_at_ms-a.assessed_at_ms)
        .slice(0,Math.max(1,Math.min(100,Math.trunc(Number(limit)||40))));
    }
    const freshAfterMs=Math.max(1000,Number(this.config.radarReviewAssessmentTtlMs)||180000);
    return rows.map(row=>{
      const age=Math.max(0,now-Number(row.assessed_at_ms||0));
      return {...row,age_ms:age,fresh:age<=freshAfterMs};
    });
  }

  _recordLatestAssessment(item,now=this.clock()){
    const analysts=Array.isArray(item?.analysts)?item.analysts:[];
    const ids=analysts.map(x=>String(x?.id||'')).filter(Boolean);
    const uniqueIds=new Set(ids);
    const placeholderIds=ids.filter(id=>/^ANALYST_\d+$/i.test(id));
    const analysisFailed=(Array.isArray(item?.reason_codes)?item.reason_codes:[]).includes('MULTI_ANALYST_ANALYSIS_FAILED');
    const execution=item?.analyst_execution||{};
    const assessment={
      symbol:String(item?.symbol||'').toUpperCase(),
      assessed_at:new Date(now).toISOString(),
      assessed_at_ms:now,
      verdict:String(item?.verdict||'UNKNOWN'),
      decision:String(item?.final_judge?.decision||item?.decision||'UNKNOWN'),
      direction:String(item?.direction||'NEUTRAL'),
      source_radars:Array.isArray(item?.source_radars)?item.source_radars.slice(0,8):[],
      shared_snapshot:item?.shared_snapshot||null,
      final_score:Number.isFinite(Number(item?.final_score))?Number(item.final_score):null,
      early_score:Number.isFinite(Number(item?.intelligence?.early_score))?Number(item.intelligence.early_score):null,
      sniper_score:Number.isFinite(Number(item?.final_judge?.sniper_score))?Number(item.final_judge.sniper_score):null,
      analyst_agreement:Number.isFinite(Number(item?.intelligence?.analyst_agreement))?Number(item.intelligence.analyst_agreement):null,
      specialist_count:analysts.length,
      unique_specialists:uniqueIds.size,
      unique_roles:new Set(analysts.map(x=>String(x?.role||'')).filter(Boolean)).size,
      specialists_complete:execution.specialists_complete===true&&!analysisFailed&&placeholderIds.length===0,
      final_analyst_complete:execution.final_analyst_complete===true,
      analysis_failed:analysisFailed,
      data_valid:item?.data_status?.data_valid===true,
      hard_reasons:(item?.final_judge?.hardReasons||item?.final_judge?.hard_reasons||[]).slice(0,12)
    };
    if(assessment.symbol)this.latestAnalystAssessments.set(assessment.symbol,assessment);
    this._pruneRadarReviewState(now);
  }

  _rotatingDiscoveryBucket(key,rows,limit){
    const selected=selectWithPriorityRotation(rows,limit,this.discoveryRotationCursors.get(key)||0);
    this.discoveryRotationCursors.set(key,selected.nextCursor);
    return selected.rows;
  }
  _settleOutcome(symbol,now,priceHistory=[]){
    const list=this.pendingOutcomes.get(symbol);
    if(!Array.isArray(list)||!list.length)return;
    const keep=[];
    for(const item of list){
      const age=now-item.asOf;
      const entry=Number(item.entryPrice);
      item.markoutSources??={};
      item.unavailableHorizons??=[];
      for(const h of CALIBRATION_HORIZONS){
        if(item.evaluated[h.key]||age<h.ms)continue;
        const dueAt=Number(item.asOf)+h.ms;
        const markout=entry>0?closedHorizonMarkout(priceHistory,dueAt,now):null;
        if(markout&&markout.price>0){
          item.evaluated[h.key]=true;
          item.markoutSources[h.key]=markout.source;
          this.calibration.settle(item.analysts,(markout.price-entry)/entry,h);
        }else if(now>dueAt+CALIBRATION_MARKOUT_GRACE_MS){
          item.evaluated[h.key]=true;
          item.markoutSources[h.key]='UNAVAILABLE';
          item.unavailableHorizons.push(h.key);
        }
      }
      if(now-item.asOf<5*60*60*1000&&!CALIBRATION_HORIZONS.every(h=>item.evaluated[h.key]))keep.push(item);
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
  async scan({quote=this.config.quote,limit=this.config.returnLimit,forceRefresh=false,requestId=null}={}){
    const now=this.clock();
    const q=String(quote||this.config.quote).trim().toUpperCase();
    const requested=Math.max(1,Math.min(15,Math.trunc(Number(limit)||this.config.returnLimit)));
    const refreshRequested=Boolean(forceRefresh);
    const safeRequestId=typeof requestId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(requestId)?requestId:null;
    if(!/^[A-Z]{2,10}$/.test(q))throw new Error('INVALID_QUOTE');
    if(!refreshRequested&&this.cache&&this.cache.quote===q&&this.cache.expiresAt>now)return this.cache.value;
    if(this.busy){
      const active=this.busy;
      return active.then(value=>refreshRequested
        ?{...value,meta:{...(value.meta||{}),analysis_mode:'FORCED_SCAN',force_refresh_requested:true,forced_scan_coalesced:true,request_id:safeRequestId,served_from_cache_while_scan:false}}
        :value);
    }
    const scanStartedAt=this.clock();
    const scanTimeoutMs=Math.max(100,Math.trunc(Number(this.config.scanTimeoutMs)||60000));
    const scanWallStartedAt=Date.now();
    const scanDeadlineAtMs=scanWallStartedAt+scanTimeoutMs;
    const scannerRest=this.scanner?.rest;
    const previousRequestDeadlineAtMs=scannerRest?.requestDeadlineAtMs??null;
    if(scannerRest)scannerRest.requestDeadlineAtMs=scanDeadlineAtMs;
    const assertScanDeadline=()=>{
      if(Date.now()<scanDeadlineAtMs)return;
      const elapsedMs=Math.max(0,Date.now()-scanWallStartedAt);
      throw new Error('MULTI_ANALYST_SCAN_DEADLINE_EXCEEDED:elapsed_ms='+elapsedMs+':limit_ms='+scanTimeoutMs);
    };
    this.monitorStats.active_scan_started_at=new Date(scanStartedAt).toISOString();
    this.monitorStats.active_scan_deadline_at=new Date(scanDeadlineAtMs).toISOString();
    this.monitorStats.last_scan_successful=false;
    this.monitorStats.last_error=null;
    this.busy=(async()=>{
      const startedAt=scanStartedAt;
      this.scanner._requests=new Map();
      const universeRefreshMs=Math.max(60_000,Number(this.config.universeRefreshMs)||30*60*1000);
      let universeEntry=this.universeCacheByQuote.get(q);
      if(!universeEntry||this.clock()-universeEntry.fetchedAt>=universeRefreshMs){
        const info=await this.scanner.exchangeInfo();
        assertScanDeadline();
        const symbols=buildSpotUniverse(info.data,q);
        if(!symbols.length)throw new Error('EMPTY_SPOT_UNIVERSE');
        universeEntry={symbols,fetchedAt:this.clock(),source:info.source||'Binance Public REST'};
        this.universeCacheByQuote.set(q,universeEntry);
      }
      const universe=universeEntry.symbols;
      const universeRefreshedAt=universeEntry.fetchedAt;
      const exchangeInfoSource=universeEntry.source;
      const tickers=await this.scanner.ticker24h();
      assertScanDeadline();
      const normalized=tickers.data.map(x=>({
        symbol:String(x.symbol||'').toUpperCase(),lastPrice:Number(x.lastPrice),quoteVolume24h:Number(x.quoteVolume),
        tradeCount24h:Number(x.count),priceChange24h:Number(x.priceChangePercent),
        highPrice24h:Number(x.highPrice),lowPrice24h:Number(x.lowPrice),tickerTime:Number(x.closeTime||x.eventTime||x.openTime||0)
      })).filter(x=>/^[A-Z0-9]{2,30}$/.test(x.symbol)&&universe.includes(x.symbol)&&Number.isFinite(x.lastPrice)&&x.lastPrice>0&&Number.isFinite(x.quoteVolume24h));

      // Radar alerts enter a bounded, fair review queue. They keep notification latency
      // unchanged; at most a small fixed share of the existing deep-scan budget is reserved
      // for these symbols while the rest of the market-discovery slots remain available.
      this._pruneRadarReviewState(this.clock());
      const normalizedBySymbol=new Map(normalized.map(row=>[row.symbol,row]));
      const rawTickerBySymbol=new Map(tickers.data.map(row=>[String(row?.symbol||'').toUpperCase(),row]));
      const configuredDeepPool=Math.max(1,Math.trunc(Number(this.config.deepScanPool)||this.config.discoveryPool));
      const plannedDeepPool=Math.max(1,Math.min(Math.max(1,Math.trunc(Number(this.config.discoveryPool)||1)),configuredDeepPool));
      const reviewSlots=Math.min(
        Math.max(1,Math.min(5,Math.trunc(Number(this.config.radarReviewSlotsPerCycle)||4))),
        Math.max(0,plannedDeepPool-1)
      );
      const dueRadarReviews=[...this.pendingRadarReviews.values()]
        .filter(item=>this.clock()-Number(item.last_queued_at||item.first_queued_at||0)<=Math.max(10000,Number(this.config.radarReviewQueueTtlMs)||300000))
        .filter(item=>item.last_attempt_at==null||this.clock()-Number(item.last_attempt_at)>=Math.max(15000,Number(this.config.radarReviewRetryCooldownMs)||60000))
        .sort((a,b)=>a.first_queued_at-b.first_queued_at)
        .map(item=>({item,normalized:normalizedBySymbol.get(item.symbol),raw:rawTickerBySymbol.get(item.symbol)}))
        .filter(row=>row.normalized&&row.raw)
        .slice(0,reviewSlots);
      const radarPriorityRows=dueRadarReviews.map(({item,normalized:row,raw})=>({
        ...raw,...row,_radar_review_priority:true,_radar_review_sources:item.source_radars.slice()
      }));

      const top=rankTickerRows(tickers.data,universe,{minQuoteVolume24h:this.config.minQuoteVolume24h,limit:Math.max(7,Math.trunc(this.config.discoveryPool*.36))});
      const bottom=rankBottomTickerRows(tickers.data,universe,{minQuoteVolume24h:this.config.minQuoteVolume24h,limit:Math.max(4,Math.trunc(this.config.discoveryPool*.20))});
      const wakeCandidates=normalized.filter(x=>x.priceChange24h>=0.35&&x.priceChange24h<=7).sort((a,b)=>{
        const sa=Math.log10(Math.max(1,a.quoteVolume24h))*0.6+Math.min(7,a.priceChange24h)*8;
        const sb=Math.log10(Math.max(1,b.quoteVolume24h))*0.6+Math.min(7,b.priceChange24h)*8;
        return sb-sa;
      });
      const wake=this._rotatingDiscoveryBucket('wake',wakeCandidates,Math.max(6,Math.trunc(this.config.discoveryPool*.30)));
      // Preserve real scan capacity for coins that are liquid but still relatively quiet.
      const surge=normalized.filter(x=>
        x.quoteVolume24h>=Math.max(1_000_000,this.config.minQuoteVolume24h)&&
        x.priceChange24h>7&&x.priceChange24h<=50
      ).sort((a,b)=>{
        const sa=Math.log10(Math.max(1,a.quoteVolume24h))*0.7+Math.min(50,a.priceChange24h)*1.2;
        const sb=Math.log10(Math.max(1,b.quoteVolume24h))*0.7+Math.min(50,b.priceChange24h)*1.2;
        return sb-sa||b.quoteVolume24h-a.quoteVolume24h;
      }).slice(0,Math.max(3,Math.trunc(this.config.discoveryPool*.34)));
      // Keep extended movers visible to the lab without removing the final anti-chase/data gates.
      const quietCandidates=normalized.filter(x=>
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
      }).sort((a,b)=>b.quiet_discovery_score-a.quiet_discovery_score);
      const quiet=this._rotatingDiscoveryBucket('quiet',quietCandidates,Math.max(5,Math.trunc(this.config.discoveryPool*.28)));
      // Round-robin the discovery buckets so volume leaders cannot consume the full deep-scan budget.
      const buckets=[top,wake,surge,quiet,bottom];
      const coverageFallback=this._rotatingDiscoveryBucket(
        'coverage',normalized,Math.min(normalized.length,this.config.discoveryPool)
      );
      const selected=selectDiscoveryWithRadarReviewPriority(
        radarPriorityRows,buckets,this.config.discoveryPool,coverageFallback
      );
      if(!selected.length)throw new Error('NO_SPOT_CANDIDATES');
      const deepPool=Math.max(1,Math.min(selected.length,Math.trunc(Number(this.config.deepScanPool)||selected.length)));
      const deepSelected=selected.slice(0,deepPool);
      this.lastRadarReviewSelection=deepSelected.filter(row=>row?._radar_review_priority===true)
        .map(row=>String(row.symbol||'').toUpperCase()).slice(0,reviewSlots);
      // Record attempt time before requests so a repeatedly failing symbol cannot monopolize
      // the priority lane. Failed symbols become eligible again after the retry cooldown.
      const attemptedRadarReviews=deepSelected.map(ticker=>this.pendingRadarReviews.get(String(ticker?.symbol||'').toUpperCase())).filter(Boolean);
      const reviewAttemptAt=this.clock();
      for(const review of attemptedRadarReviews){review.last_attempt_at=reviewAttemptAt;review.attempts=Number(review.attempts||0)+1;}
      let btc15=[],btc1=[];
      try{
        const [b15,b1]=await Promise.all([
          this.scanner.fetchSeries('BTCUSDT','15m',Math.min(this.config.deepKlines,220)),
          this.scanner.fetchSeries('BTCUSDT','1h',Math.min(this.config.deepKlines,220))
        ]);
        btc15=Array.isArray(b15.candles)?b15.candles:[]; btc1=Array.isArray(b1.candles)?b1.candles:[];
      }catch{}
      assertScanDeadline();
      const validTickerReturns=selected.map(x=>Number(x.priceChange24h)).filter(Number.isFinite).sort((a,b)=>a-b);
      const marketMedian24h=validTickerReturns.length?validTickerReturns[Math.floor(validTickerReturns.length/2)]:null;
      const breadthPct=validTickerReturns.length?validTickerReturns.filter(x=>x>0).length/validTickerReturns.length*100:null;
      const marketSnapshotAt=this.clock();
      const sharedMarketSnapshot={snapshot_id:'SPOT-'+Math.trunc(marketSnapshotAt)+'-'+selected.length+'-'+btc15.length+'-'+btc1.length,as_of:marketSnapshotAt,snapshot_source:String(tickers?.source||'BINANCE_PUBLIC_REST'),btc15,btc1,marketMedian24h,breadthPct};
      const scanErrors=[];
      const scanned=await boundedMap(deepSelected,Math.max(1,Math.min(4,this.config.deepConcurrency)),async(ticker,index)=>{
        try{
          const row=await this.scanner.scanSymbol(ticker,index+1,{exchangeInfo:exchangeInfoSource,ticker:tickers.source},{klinesLimit:this.config.deepKlines,fastInterval:'',includeAnalysisPayload:true});
          assertScanDeadline();
          if(!row)throw new Error('SYMBOL_SCAN_RETURNED_EMPTY');
          // A candidate must reach the 19 specialist analysts even when the data gate fails.
          // The final judge remains fail-closed: invalid/stale/future/incomplete data is rejected there.
          this._settleOutcome(ticker.symbol,this.clock(),row?._analysis?.series?.['15m']||[]);
          const reviewContext=this.pendingRadarReviews.get(String(ticker?.symbol||'').toUpperCase());
          row._analyst_context={snapshot_id:sharedMarketSnapshot.snapshot_id,snapshot_as_of:sharedMarketSnapshot.as_of,source_radars:Array.isArray(reviewContext?.source_radars)?reviewContext.source_radars.slice(0,8):[],radar_review_priority:ticker?._radar_review_priority===true,duplicate_alert_suppressed:false};
          let prior=null;
          try{ prior=await this.store?.getIntelligenceMemory?.(ticker.symbol) || null; }catch{ prior=null; }
          assertScanDeadline();
          let analysis;
          try{
            analysis=analyzeMultiAnalystCandidate(row,sharedMarketSnapshot,prior,this.calibration);
          }catch(analysisError){
            const msg='MULTI_ANALYST_ANALYSIS_FAILED:'+String(analysisError?.message||analysisError);
            const specialist={a:Array.from({length:19},(_,i)=>({
              id:'ANALYST_'+String(i+1).padStart(2,'0'),
              name:'محلل سلامة مؤقت '+String(i+1),
              score:0,direction:'NEUTRAL',decision:'FAIL',
              evidence:{error:msg},risks:[msg]
            })),features:{price:safe(row?.last_price,Number(ticker?.lastPrice)||null),priceChange24h:safe(row?.price_change_24h,0),structure:{bull:0,bear:0,headroom:null},book:{imbalance:null,bidWallShare:null,askWallShare:null}},dataValid:false};
            const final={
              score:0,verdict:'REJECT',decision:'REJECT',direction:'NEUTRAL',positiveAnalysts:0,strongAnalysts:0,totalAnalysts:19,
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
          const analystFailed=(Array.isArray(row.reason_codes)?row.reason_codes:[]).includes('MULTI_ANALYST_ANALYSIS_FAILED');
          const analystExecution=buildAnalystExecutionStatus({
            specialists:publicAnalysts,final,analysisFailed:analystFailed
          });
          delete row._analysis;
          this._registerOutcome({
            symbol:row.symbol,entryPrice:row.last_price,direction:final.direction,
            earlyScore:final.early_score,analysts:publicAnalysts
          },this.clock());
          return {
            symbol:row.symbol,rank:index+1,last_price:row.last_price,price_change_24h:row.price_change_24h,
            quote_volume_24h:row.quote_volume_24h,liquidity_quality:row.liquidity_quality,data_quality:row.data_quality,
            direction:final.direction,verdict:final.verdict,decision:final.decision,final_score:final.score,
            shared_snapshot:specialist.sharedSnapshot,source_radars:row._analyst_context.source_radars,
            consensus:{positive:final.positiveAnalysts,strong:final.strongAnalysts,total:final.totalAnalysts,ratio:final.totalAnalysts>0?final.positiveAnalysts/final.totalAnalysts:0,bearish_strong:Number(final.bearishStrongAnalysts||0)},
            analysts:publicAnalysts,analyst_execution:analystExecution,final_judge:final,
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
      assertScanDeadline();
      const live=scanned.filter(Boolean);
      const failedRadarReviewSymbols=new Set(scanErrors.map(x=>String(x?.symbol||'').toUpperCase()));
      for(const ticker of deepSelected){
        const symbol=String(ticker?.symbol||'').toUpperCase();
        if(!this.pendingRadarReviews.has(symbol))continue;
        const reviewed=live.find(item=>String(item?.symbol||'').toUpperCase()===symbol);
        const execution=reviewed?.analyst_execution||{};
        const reviewComplete=!failedRadarReviewSymbols.has(symbol)&&
          execution.specialists_complete===true&&execution.final_analyst_complete===true&&!execution.analysis_failed;
        if(reviewComplete){
          this.pendingRadarReviews.delete(symbol);
        }else{
          const review=this.pendingRadarReviews.get(symbol);
          if(review)review.last_error=String(
            scanErrors.find(x=>String(x?.symbol||'').toUpperCase()===symbol)?.error||
            (reviewed?.analyst_execution?.analysis_failed?'ANALYST_ANALYSIS_FAILED':'ANALYST_REVIEW_INCOMPLETE')
          ).slice(0,160);
        }
      }
      const assessmentAt=this.clock();
      for(const item of live)this._recordLatestAssessment(item,assessmentAt);
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
      assertScanDeadline();
      live.sort((a,b)=>(b.final_judge?.sniper_score??-1)-(a.final_judge?.sniper_score??-1)||b.final_score-a.final_score||b.consensus.ratio-a.consensus.ratio||b.liquidity_quality-a.liquidity_quality);
      const qualified=live.filter(x=>x.verdict==='STRONG_CANDIDATE'||x.verdict==='CANDIDATE');
      const candidates=qualified.slice(0,Math.min(requested,5)).map((x,i)=>({...x,rank:i+1}));
      const watchlist=live.filter(x=>x.verdict==='WATCH').slice(0,Math.min(requested,3)).map((x,i)=>({...x,rank:i+1}));
      const strongCount=live.filter(x=>x.verdict==='STRONG_CANDIDATE').length;
      const marketMovers=buildMultiAnalystMarketMoverObservations(normalized,live,{
        minMovePct:8,maxExtended24hMovePct:18,minQuoteVolume24h:this.config.minQuoteVolume24h,limit:15
      });
      const value={
        meta:{live:live.some(x=>x.data_status?.data_valid===true),paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',radar:'MULTI_ANALYST',analyst_count:20,specialist_count:19,engine_revision:'ELITE_SNIPER_V1',analysis_mode:refreshRequested?'FORCED_SCAN':'LIVE_SCAN',force_refresh_requested:refreshRequested,request_id:safeRequestId},
        as_of:new Date(this.clock()).toISOString(),
        source:'Binance Public REST',
        universe:{quote:q,eligible_spot_symbols:universe.length,discovery_pool:selected.length,deep_scan_pool:deepSelected.length,scanned:live.length,returned:candidates.length,min_quote_volume_24h:this.config.minQuoteVolume24h,universe_refreshed_at:new Date(universeRefreshedAt).toISOString(),universe_refresh_interval_ms:universeRefreshMs,surge_lane_candidates:surge.length},
        market_context:{regime:marketRegime({marketMedian24h,breadthPct}),median_24h_change_pct:marketMedian24h,positive_breadth_pct:breadthPct},
        market_movers:marketMovers,
        summary:{strong_candidates:strongCount,candidates:live.filter(x=>x.verdict==='CANDIDATE').length,qualified:qualified.length,watch:live.filter(x=>x.verdict==='WATCH').length,rejected:live.filter(x=>x.verdict==='REJECT').length},
        candidates,watchlist,
        // Keep rejected deep-scan rows visible for audit so a zero-candidate cycle
        // still explains what was actually tested and why each row failed to qualify.
        lab_results:live.filter(x=>x.verdict==='REJECT').slice(0,Math.max(8,Math.min(15,requested))).map(x=>({
          symbol:x.symbol,
          rank:x.rank,
          last_price:x.last_price,
          price_change_24h:x.price_change_24h,
          quote_volume_24h:x.quote_volume_24h,
          liquidity_quality:x.liquidity_quality,
          data_quality:x.data_quality,
          verdict:'REJECT',
          direction:x.direction,
          final_score:x.final_score,
          timing:x.final_judge?.timing??'NO_SETUP',
          early_score:x.intelligence?.early_score??x.final_judge?.early_score??null,
          analyst_agreement:x.intelligence?.analyst_agreement??x.final_judge?.agreement??null,
          evidence_coverage:x.final_judge?.evidence_coverage??null,
          hard_reasons:Array.isArray(x.final_judge?.hardReasons)?x.final_judge.hardReasons.slice(0,8):[],
          reason_codes:Array.isArray(x.reason_codes)?x.reason_codes.slice(0,8):[],
          analysts:Array.isArray(x.analysts)?x.analysts.slice(0,19):[],
          analyst_execution:x.analyst_execution||null,
          consensus:x.consensus||null,
          highlights:Array.isArray(x.highlights)?x.highlights.slice(0,6):[],
          risk_flags:Array.isArray(x.risk_flags)?x.risk_flags.slice(0,8):[],
          final_judge:x.final_judge||null,
          data_status:{
            data_valid:x.data_status?.data_valid===true,
            data_stale:x.data_status?.data_stale===true,
            last_error:x.data_status?.last_error??null
          }
        })),
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
          radar_review_queue:this.radarReviewQueueSnapshot(this.clock()),
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
      this.monitorStats.last_scan_successful=true;
      this.monitorStats.last_error=null;
      const monitorIntervalMs=Math.max(15000,Number(this.config.continuousIntervalMs)||60000);
      const elapsedMs=Math.max(0,this.clock()-startedAt);
      const nextDelayMs=nextContinuousScanDelayMs(monitorIntervalMs,elapsedMs);
      this.monitorStats.next_scan_at=this.running?new Date(this.clock()+nextDelayMs).toISOString():null;
      value.monitoring={
        continuous:true,
        running:this.running,
        interval_ms:monitorIntervalMs,
        scan_count:this.monitorStats.scan_count,
        last_scan_at:this.monitorStats.last_scan_at,
        last_error:null,
        next_scan_at:this.monitorStats.next_scan_at
      };
      assertScanDeadline();
      this.cache={quote:q,expiresAt:this.clock()+this.config.ttlMs,value};
      return value;
    })();
    try{return await this.busy}
    catch(error){
      this.monitorStats.last_error=String(error?.message??error);
      this.monitorStats.last_scan_successful=false;
      throw error;
    }
    finally{
      if(scannerRest&&scannerRest.requestDeadlineAtMs===scanDeadlineAtMs)scannerRest.requestDeadlineAtMs=previousRequestDeadlineAtMs;
      this.busy=null;
      this.monitorStats.active_scan_started_at=null;
      this.monitorStats.active_scan_deadline_at=null;
    }
  }
  getCached({quote=this.config.quote}={}){
    const key=String(quote||this.config.quote).toUpperCase();
    if(!this.cache||this.cache.quote!==key||this.cache.expiresAt<=this.clock())return null;
    const value=this.cache.value;
    return {...value,diagnostics:{...(value?.diagnostics||{}),radar_review_queue:this.radarReviewQueueSnapshot(this.clock())}};
  }
  start(){
    if(this.running)return;
    this.running=true;
    this.monitorStartedAt=this.clock();
    const interval=Math.max(15000,Number(this.config.continuousIntervalMs)||60000);
    const warmup=Math.max(0,Number(this.config.continuousWarmupMs)||8000);
    const loop=async()=>{
      if(!this.running)return;
      const cycleStartedAt=this.clock();
      try{
        await this.scan({quote:this.config.quote,limit:this.config.returnLimit});
      }catch(error){
        this.monitorStats.last_scan_successful=false;
        this.monitorStats.last_error=String(error?.message||error);
      }
      if(!this.running)return;
      // Schedule against the cycle start, not cycle completion, so scan work does
      // not silently stretch a requested 60-second cadence into 2–3 minutes.
      const delayMs=nextContinuousScanDelayMs(interval,this.clock()-cycleStartedAt);
      this.monitorStats.next_scan_at=new Date(this.clock()+delayMs).toISOString();
      this.monitorTimer=setTimeout(loop,delayMs);
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
  'حارس سلامة البيانات','مراقب اكتمال التغطية','محلل السيولة','راصد شذوذ الحجم','راصد تسارع الصفقات',
  'محلل ضغط الشراء','محلل بنية السعر','كاشف القاعدة الهادئة','مؤكد الاختراق','مانع مطاردة السعر',
  'كاشف المصائد','مراقب تماسك عمق السوق','محلل حالة السوق العام','محلل القوة النسبية','محلل توافق الفترات الزمنية',
  'محلل التشابه التاريخي','محلل التقلب والمخاطر','معاير الثقة بالنتائج','كاشف تعارض الإشارات والتكرار','المحلل النهائي'
]);