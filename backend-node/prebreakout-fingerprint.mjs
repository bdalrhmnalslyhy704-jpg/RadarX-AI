// RadarX Pre-Breakout Fingerprint v1
// Pure market-data analysis.

const clamp=(x,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number(x)));
const finite=x=>Number.isFinite(Number(x));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const pct=(a,b)=>finite(a)&&finite(b)&&b!==0?(a/b-1)*100:null;

function atrSeries(c,n=14){
  const tr=c.map((x,i)=>i===0?x.high-x.low:Math.max(x.high-x.low,Math.abs(x.high-c[i-1].close),Math.abs(x.low-c[i-1].close)));
  const out=Array(c.length).fill(null);
  if(c.length<n)return out;
  let p=mean(tr.slice(0,n)); out[n-1]=p;
  for(let i=n;i<c.length;i++){p=((n-1)*p+tr[i])/n;out[i]=p}
  return out;
}
function ema(v,n){
  const o=Array(v.length).fill(null); if(v.length<n)return o;
  let p=mean(v.slice(0,n)); o[n-1]=p; const k=2/(n+1);
  for(let i=n;i<v.length;i++){p=k*v[i]+(1-k)*p;o[i]=p} return o;
}
function bbWidth(v,n=20,k=2){
  const o=Array(v.length).fill(null);
  for(let i=n-1;i<v.length;i++){const w=v.slice(i-n+1,i+1),m=mean(w),sd=Math.sqrt(mean(w.map(x=>(x-m)**2)));o[i]=m?(2*k*sd)/m:null}
  return o;
}
function rvolAt(c,i,n=20){
  if(i<n)return null; const b=mean(c.slice(i-n,i).map(x=>x.volume)); return b>0?c[i].volume/b:null;
}
const bodyFrac=c=>{const r=c.high-c.low;return r>0?Math.abs(c.close-c.open)/r:0};
const upperWick=c=>{const r=c.high-c.low;return r>0?(c.high-Math.max(c.open,c.close))/r:0};

function pivots(c){
  const hi=[],lo=[];
  for(let i=2;i<c.length-2;i++){
    if(c[i].high>c[i-1].high&&c[i].high>c[i-2].high&&c[i].high>=c[i+1].high&&c[i].high>=c[i+2].high)hi.push({index:i,price:c[i].high});
    if(c[i].low<c[i-1].low&&c[i].low<c[i-2].low&&c[i].low<=c[i+1].low&&c[i].low<=c[i+2].low)lo.push({index:i,price:c[i].low});
  }
  return{hi,lo};
}
function feature(v,a,b){if(!finite(v))return null;if(v<=a)return 0;if(v>=b)return 100;return clamp((v-a)/(b-a)*100)}

function evaluateAt(c,btc,i,book,ref4){
  const x=c[i],at=atrSeries(c),a=at[i],aBase=i>=40?mean(at.slice(Math.max(13,i-40),i).filter(finite)):null;
  const atrRatio=finite(a)&&aBase>0?a/aBase:null;
  const bw=bbWidth(c.map(x=>x.close)),bwBase=i>=40?mean(bw.slice(Math.max(19,i-40),i).filter(finite)):null;
  const bwRatio=finite(bw[i])&&bwBase>0?bw[i]/bwBase:null;
  const v5=i>=5?mean(c.slice(i-4,i+1).map(x=>x.volume)):null;
  const vPrev=i>=10?mean(c.slice(i-9,i-4).map(x=>x.volume)):null;
  const v20=i>=25?mean(c.slice(i-24,i-4).map(x=>x.volume)):null;
  const vAcc=finite(v5)&&v20>0?v5/v20:null, vSlope=finite(v5)&&vPrev>0?v5/vPrev:null, rv=rvolAt(c,i);
  const p=pivots(c.slice(0,i+1)), lows=p.lo.slice(-4), last=lows.at(-1), prev=lows.at(-2), prev2=lows.at(-3);
  const hl=Boolean(prev2&&prev&&last&&prev.price<prev2.price&&last.price>prev.price);
  const ll=Boolean(prev&&last&&last.price<prev.price);
  const structureScore=hl?100:ll?20:70;
  const resistance=i>=20?Math.max(...c.slice(i-40,i).map(x=>x.high)):null;
  const distanceAtr=finite(resistance)&&finite(a)&&a>0?(resistance-x.close)/a:null;
  let tests=0,pressureNow=[],pressurePrev=[];
  if(finite(resistance)&&finite(a)&&a>0){
    for(let j=Math.max(0,i-60);j<i;j++)if(Math.abs(c[j].high-resistance)<=a*.75){
      tests++; const q=upperWick(c[j])+(c[j].close<c[j].open?.25:0);
      if(j>=i-18)pressureNow.push(q); else if(j>=i-40)pressurePrev.push(q);
    }
  }
  const sellerPressureFalling=pressureNow.length&&pressurePrev.length?mean(pressureNow)<mean(pressurePrev):tests>=2;
  const resistanceScore=finite(distanceAtr)?clamp((Math.max(0,4-Math.max(0,distanceAtr))/3.5*100)*.65+(tests?60:35)*.2+(sellerPressureFalling?100:35)*.15):25;
  const compression=finite(atrRatio)||finite(bwRatio)?clamp((finite(atrRatio)?clamp((1.3-atrRatio)/.55*100):50)*.55+(finite(bwRatio)?clamp((1.15-bwRatio)/.45*100):50)*.45):null;
  const volume=finite(vAcc)||finite(vSlope)?clamp((feature(vAcc,.95,1.35)??50)*.6+(feature(vSlope,.95,1.25)??50)*.4):null;

  const bi=Math.min(i,Math.max(0,(btc||[]).length-1)),relative={score:null,return20:null,return40:null,excess20:null,excess40:null,status:'UNKNOWN'};
  if(btc&&btc.length>0&&bi>=40&&i>=40){
    relative.return20=pct(x.close,c[i-20].close); relative.return40=pct(x.close,c[i-40].close);
    const br20=pct(btc[bi].close,btc[bi-20].close),br40=pct(btc[bi].close,btc[bi-40].close);
    relative.excess20=finite(br20)?relative.return20-br20:null; relative.excess40=finite(br40)?relative.return40-br40:null;
    relative.score=((feature(relative.excess20,-2,4)??50)+(feature(relative.excess40,-4,8)??50))/2;
    relative.status=relative.score>=70?'INCREASING':relative.score>=45?'IMPROVING':'WEAK';
  }
  const taker=i>=10?(()=>{let v=0,b=0;for(const q of c.slice(i-9,i+1)){v+=Number(q.volume)||0;b+=Number(q.takerBuyBaseVolume)||0}return v?b/v:null})():null;
  const obi=finite(book?.obi)?Number(book.obi):null;
  const orderFlow=obi==null&&taker==null?null:clamp((obi==null?50:50+obi*300)*.55+(taker==null?50:taker*100)*.45);
  const e20=ema(ref4.map(x=>x.close),20).at(-1),e50=ema(ref4.map(x=>x.close),50).at(-1),e200=ema(ref4.map(x=>x.close),200).at(-1),c4=ref4.at(-1)?.close;
  const regime=c4!=null&&e20!=null&&e50!=null&&e200!=null?clamp((c4>e20?30:0)+(e20>e50?30:0)+(e50>e200?40:0)):50;
  const trigger=finite(distanceAtr)?clamp((Math.max(0,4-Math.max(0,distanceAtr))/3.5)*100):25;
  const bos=finite(resistance)&&finite(a)&&x.close>resistance+a*.1&&bodyFrac(x)>=.35&&upperWick(x)<.55&&(rv==null||rv>=1.35);
  let priorBos=-1;
  for(let j=Math.max(20,i-12);j<i;j++){const r=Math.max(...c.slice(Math.max(0,j-40),j).map(q=>q.high)),aj=at[j],rj=rvolAt(c,j);if(finite(r)&&finite(aj)&&c[j].close>r+aj*.1&&bodyFrac(c[j])>=.35&&(rj==null||rj>=1.35))priorBos=j}
  const retest=priorBos>=0&&i-priorBos<=12&&finite(resistance)&&x.low<=resistance+(a??0)*.3&&x.close>=resistance;
  let falseBreakout=false;
  if(finite(resistance))for(let j=Math.max(20,i-8);j<=i;j++){const aj=at[j]??a;if(c[j].high>resistance+(aj??0)*.1&&c[j].close<resistance){falseBreakout=true;break}}
  const evidence={
    structure:{score:structureScore,status:hl?'HL_EMERGING':ll?'LL_ACTIVE':'STABILIZING'},
    compression:{score:compression,status:compression==null?'UNKNOWN':compression>=70?'TIGHT':compression>=45?'COMPRESSING':'EXPANDING',atr_ratio:atrRatio,bb_width_ratio:bwRatio},
    volume:{score:volume,status:volume==null?'UNKNOWN':volume>=70?'ACCELERATING':volume>=45?'AWAKENING':'QUIET',rvol:rv,acceleration:vAcc,slope:vSlope},
    relative_power:{score:relative.score,status:relative.status,excess_20:relative.excess20,excess_40:relative.excess40},
    resistance:{score:resistanceScore,level:resistance,distance_atr:distanceAtr,tests,seller_pressure_falling:sellerPressureFalling,status:tests>=3?'REPEATED_TESTS':tests?'TESTING':'APPROACHING'},
    order_flow:{score:orderFlow,status:orderFlow==null?'UNKNOWN':orderFlow>=65?'BUYING_PRESSURE':orderFlow<=35?'SELLING_PRESSURE':'BALANCED',obi,taker_buy_ratio:taker},
    regime:{score:regime,status:regime>=70?'SUPPORTIVE':regime<=35?'HEADWIND':'NEUTRAL'},
    trigger:{score:trigger,status:bos?'BOS':retest?'RETEST':finite(distanceAtr)&&distanceAtr<=1.5?'NEAR_RESISTANCE':'AWAY'}
  };
  const weighted=[[structureScore,18],[compression,15],[volume,15],[relative.score,15],[resistanceScore,12],[orderFlow,10],[regime,7],[trigger,8]].filter(([v])=>finite(v));
  const score=weighted.length?weighted.reduce((s,[v,w])=>s+v*w,0)/weighted.reduce((s,[,w])=>s+w,0):0;
  const exhausted=!falseBreakout&&((rv??0)>=3&&(relative.score??50)<35||(bwRatio??0)>1.8&&(volume??50)<35);
  const stage=falseBreakout?'FALSE_BREAKOUT':exhausted?'EXHAUSTED':retest?'RETEST':bos?'BREAKOUT':score>=72?'PRE-BREAKOUT':score>=52?'BUILDING':'NORMAL';
  const trapRisk=clamp(50-(structureScore??50)*.12-(volume??50)*.1-(relative.score??50)*.1-(orderFlow??50)*.08-(resistanceScore??50)*.06+(falseBreakout?35:0)+(upperWick(x)>=.55?18:0)+(regime<35?12:0)+(distanceAtr>2.5?10:0));
  return{stage,score:Math.round(score*10)/10,trapRisk:Math.round(trapRisk*10)/10,direction:stage==='FALSE_BREAKOUT'?'NONE':score>=52?'LONG':'NONE',evidence,evidenceCount:weighted.filter(([v])=>v>=55).length,structure:{state:hl?'HL':ll?'LL':'HOLDING',hl,ll,lastLow:last?.price??null,previousLow:prev?.price??null},resistance:{level:resistance,distanceAtr,tests,sellerPressureFalling,remainingTests:distanceAtr!=null&&distanceAtr>0?(tests>=2?0:1):0},context:{breakout:bos,breakoutIndex:bos?i:priorBos,retest,falseBreakout,exhausted}};
}

function journey(c,btc,book,ref4){
  const out=[]; let prev=null;
  for(let i=Math.max(60,c.length-90);i<c.length;i+=3){const e=evaluateAt(c,btc,i,book,ref4);if(e.stage!==prev){out.push({stage:e.stage,at:c[i].closeTime,score:e.score});prev=e.stage}}
  return out;
}
function historical(c,btc,book,ref4,current){
  const rows=[];
  for(let i=60;i<c.length-16;i+=4){
    const e=evaluateAt(c,btc,i,book,ref4); if(!['BUILDING','PRE-BREAKOUT'].includes(e.stage)||e.score<55)continue;
    const base=c[i].close,fw=c.slice(i+1,i+17);if(!fw.length||!finite(base)||base<=0)continue;
    const hi=Math.max(...fw.map(x=>x.high)),lo=Math.min(...fw.map(x=>x.low)),up=(hi/base-1)*100,dd=(lo/base-1)*100;
    const dist=['structure','compression','volume','relative_power','resistance'].reduce((s,k)=>s+Math.abs((e.evidence[k]?.score??50)-(current.evidence[k]?.score??50)),0)+Math.abs(e.score-current.score);
    rows.push({at:c[i].closeTime,stage:e.stage,fingerprintScore:e.score,forwardMaxReturnPct:Math.round(up*100)/100,forwardMaxDrawdownPct:Math.round(dd*100)/100,similarity:Math.round(clamp(100-dist/6)*10)/10,successful:up>=4&&dd>-6});
  }
  rows.sort((a,b)=>b.similarity-a.similarity);
  const ok=rows.filter(x=>x.successful).length;
  return{samples:rows.length,lookaheadBars:16,successfulSamples:ok,descriptiveSuccessRatePct:rows.length?Math.round(ok/rows.length*1000)/10:null,analogs:rows.slice(0,3)};
}

export function evaluatePreBreakoutFingerprint({series15m,series1h=[],series4h=[],btc15m=[],book=null,now=Date.now()}={}){
  const c=(Array.isArray(series15m)?series15m:[]).filter(x=>x?.closed===true),btc=(Array.isArray(btc15m)?btc15m:[]).filter(x=>x?.closed===true),ref4=(Array.isArray(series4h)&&series4h.length?series4h:series1h).filter(x=>x?.closed===true);
  if(c.length<80)return{version:'prebreakout-fingerprint.v1',detected:false,stage:'NORMAL',score:0,trapRisk:100,direction:'NONE',evidenceCount:0,evidence:{},journey:[],sequence:[],historical:{samples:0,lookaheadBars:16,successfulSamples:0,descriptiveSuccessRatePct:null,analogs:[]},reasonCodes:['INSUFFICIENT_FINGERPRINT_DATA']};
  const e=evaluateAt(c,btc,c.length-1,book,ref4),j=journey(c,btc,book,ref4),h=historical(c,btc,book,ref4,e);
  return{version:'prebreakout-fingerprint.v1',detected:['BUILDING','PRE-BREAKOUT','BREAKOUT','RETEST'].includes(e.stage),stage:e.stage,score:e.score,trapRisk:e.trapRisk,direction:e.direction,evidenceCount:e.evidenceCount,evidence:e.evidence,structure:e.structure,resistance:e.resistance,context:e.context,journey:j,sequence:j.map(x=>x.stage).filter((x,i,a)=>i===0||a[i-1]!==x),historical:h,data:{closed15m:c.length,latestClosedCandle:c.at(-1)?.closeTime??null,candleAgeMs:c.at(-1)?.closeTime?Math.max(0,now-c.at(-1).closeTime):null,btcReferenceAvailable:btc.length>=40},reasonCodes:[
    ...(e.structure.hl?['HL_EMERGING']:[]),
    ...((e.evidence.compression.score??0)>=60?['COMPRESSION']:[]),
    ...((e.evidence.volume.score??0)>=60?['VOLUME_AWAKENING']:[]),
    ...((e.evidence.relative_power.score??0)>=60?['RELATIVE_POWER_INCREASING']:[]),
    ...(e.resistance.sellerPressureFalling?['SELL_PRESSURE_DECLINING']:[]),
    ...(e.context.breakout?['BOS_CONFIRMED']:[]),
    ...(e.context.retest?['RETEST_HOLDING']:[]),
    ...(e.context.falseBreakout?['FALSE_BREAKOUT_RISK']:[])
  ]};
}
