// RadarX VCP Strategy v1
// Volatility Contraction Pattern: pre-breakout watch, read-only.

const finite=x=>Number.isFinite(Number(x));
const clamp=(x,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number(x)));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;

function ema(v,n){
  const out=Array(v.length).fill(null); if(v.length<n)return out;
  let p=mean(v.slice(0,n)); out[n-1]=p; const k=2/(n+1);
  for(let i=n;i<v.length;i++){p=k*v[i]+(1-k)*p;out[i]=p} return out;
}
function atr(c,n=14){
  const tr=c.map((x,i)=>i===0?x.high-x.low:Math.max(x.high-x.low,Math.abs(x.high-c[i-1].close),Math.abs(x.low-c[i-1].close)));
  const out=Array(tr.length).fill(null); if(tr.length<n)return out;
  let p=mean(tr.slice(0,n)); out[n-1]=p;
  for(let i=n;i<tr.length;i++){p=((n-1)*p+tr[i])/n;out[i]=p} return out;
}
function pivots(c){
  const highs=[],lows=[];
  for(let i=2;i<c.length-2;i++){
    const hi=c[i].high>c[i-1].high&&c[i].high>c[i-2].high&&c[i].high>=c[i+1].high&&c[i].high>=c[i+2].high;
    const lo=c[i].low<c[i-1].low&&c[i].low<c[i-2].low&&c[i].low<=c[i+1].low&&c[i].low<=c[i+2].low;
    if(hi)highs.push({index:i,price:c[i].high});
    if(lo)lows.push({index:i,price:c[i].low});
  }
  return{highs,lows};
}
function rvol(c,i,n=20){
  if(i<n)return null; const base=mean(c.slice(i-n,i).map(x=>x.volume)); return base>0?c[i].volume/base:null;
}

export function evaluateVCP({series15m=[],series4h=[]}={}){
  const c=(Array.isArray(series15m)?series15m:[]).filter(x=>x?.closed===true);
  const ref=(Array.isArray(series4h)&&series4h.length?series4h:series15m).filter(x=>x?.closed===true);
  if(c.length<100){
    return{strategy:'VCP_PRE_BREAKOUT',direction:'NONE',state:'REJECTED',score:{vcpScore:null},evidence:{},reasonCodes:['INSUFFICIENT_VCP_DATA']};
  }

  const i=c.length-1, x=c[i], a=atr(c,14)[i]||0, p=pivots(c), highs=p.highs, lows=p.lows;
  const cycles=[];
  for(let h=Math.max(0,highs.length-7);h<highs.length;h++){
    const high=highs[h];
    const nextLow=lows.find(lo=>lo.index>high.index);
    if(!nextLow||nextLow.index>=i)continue;
    const depth=(high.price-nextLow.price)/high.price;
    cycles.push({highIndex:high.index,lowIndex:nextLow.index,high:high.price,low:nextLow.price,depth});
  }
  const recent=cycles.slice(-5);
  const contractionDepths=recent.map(q=>q.depth).filter(v=>finite(v)&&v>0);
  let tightening=0;
  if(contractionDepths.length>=2){
    const pairs=contractionDepths.slice(1).map((v,j)=>v<=contractionDepths[j]*.85);
    tightening=pairs.length?pairs.filter(Boolean).length/pairs.length:0;
  }
  const contractionCount=contractionDepths.length;
  const lastHigh=recent.at(-1)?.high;
  const priorHigh=recent.at(-2)?.high;
  const pivot=Math.max(...c.slice(Math.max(0,i-40),i).map(q=>q.high));
  const nearPivot=finite(pivot)&&a>0?(pivot-x.close)/a:null;

  const volRecent=mean(c.slice(Math.max(0,i-9),i+1).map(q=>q.volume));
  const volBase=mean(c.slice(Math.max(0,i-39),Math.max(0,i-9)).map(q=>q.volume));
  const dryUp=finite(volRecent)&&finite(volBase)&&volBase>0?volRecent/volBase:null;

  const rangeRecent=mean(c.slice(Math.max(0,i-9),i+1).map(q=>(q.high-q.low)/Math.max(q.close,1e-12)));
  const rangeBase=mean(c.slice(Math.max(0,i-39),Math.max(0,i-9)).map(q=>(q.high-q.low)/Math.max(q.close,1e-12)));
  const rangeRatio=finite(rangeRecent)&&finite(rangeBase)&&rangeBase>0?rangeRecent/rangeBase:null;

  const e20=ema(c.map(q=>q.close),20)[i],e50=ema(c.map(q=>q.close),50)[i];
  const e200=ema(c.map(q=>q.close),200)[i];
  const rc=ref.at(-1)?.close, r20=ref.length>=2?ema(ref.map(q=>q.close),20).at(-1):null, r50=ref.length>=2?ema(ref.map(q=>q.close),50).at(-1):null;
  const trendScore=finite(e20)&&finite(e50)?clamp((x.close>e20?30:0)+(e20>e50?35:0)+(e50>e200?25:10)+(finite(rc)&&finite(r20)&&rc>r20?10:0)):50;

  const pivotDistanceScore=finite(nearPivot)?clamp((2.5-Math.max(0,nearPivot))/2.5*100):20;
  const contractionScore=clamp((Math.min(5,contractionCount)/5)*55+tightening*45);
  const dryUpScore=finite(dryUp)?clamp((1.15-dryUp)/.5*100):null;
  const tightRangeScore=finite(rangeRatio)?clamp((1.1-rangeRatio)/.55*100):null;
  const rvi=rvol(c,i);
  const broke=finite(pivot)&&x.close>pivot+(a||0)*.1&&finite(rvi)&&(rvi>=1.5);
  const vcpScore=clamp(
    trendScore*.20+
    contractionScore*.35+
    (dryUpScore??50)*.15+
    (tightRangeScore??50)*.15+
    pivotDistanceScore*.15
  );
  const preBreakout=vcpScore>=60&&contractionCount>=2&&tightening>=.5&&
    (dryUp==null||dryUp<=1.05)&&
    (nearPivot==null||nearPivot<=2.5);
  const state=broke?'CONFIRMED':preBreakout?'CANDIDATE':'REJECTED';
  const reasonCodes=[
    ...(contractionCount>=2?['VCP_CONTRACTIONS']:[]),
    ...(tightening>=.5?['SUCCESSIVE_TIGHTENING']:[]),
    ...(finite(dryUp)&&dryUp<=1.05?['VOLUME_DRY_UP']:[]),
    ...(finite(rangeRatio)&&rangeRatio<1?['RANGE_CONTRACTION']:[]),
    ...(trendScore>=60?['CONSTRUCTIVE_TREND']:[]),
    ...(preBreakout&&!broke?['NEAR_BREAKOUT_PIVOT']:[]),
    ...(broke?['VCP_BREAKOUT_CONFIRMED']:[ ])
  ];
  return{
    strategy:'VCP_PRE_BREAKOUT',
    direction:state==='REJECTED'?'NONE':'LONG',
    state,
    score:{vcpScore:Math.round(vcpScore*10)/10},
    evidence:{
      prior_uptrend:{score:trendScore,status:trendScore>=70?'CONSTRUCTIVE':'NEUTRAL',ema20:e20,ema50:e50,ema200:e200,reference_close:rc},
      contractions:{count:contractionCount,depths:contractionDepths.map(v=>Math.round(v*10000)/100),tightening_ratio:Math.round(tightening*100)/100},
      volume:{dry_up_ratio:dryUp,rvol:rvi,status:dryUp==null?'UNKNOWN':dryUp<=.8?'DRY_UP':dryUp<=1.05?'QUIET':'ACTIVE'},
      range:{recent_to_base_ratio:rangeRatio,score:tightRangeScore},
      pivot:{level:pivot,distance_atr:nearPivot,score:pivotDistanceScore,previous_high:priorHigh,last_contraction_high:lastHigh},
      trigger:{breakout:broke,status:broke?'BREAKOUT':nearPivot!=null&&nearPivot<=2.5?'NEAR_PIVOT':'AWAY'}
    },
    reasonCodes,
    invalidation:state==='REJECTED'?['VCP_GATE_NOT_MET']:[],
    required_data:['closed_15m'],
    missing_required_data:[],
    confidence_score:'UNKNOWN'
  };
}
