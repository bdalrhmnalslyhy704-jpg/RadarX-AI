import fs from 'node:fs/promises';

const BASE='https://data-api.binance.vision/api/v3';
const SYMBOLS=['RLCUSDT','RADUSDT','ORCAUSDT','API3USDT','DIAUSDT','OGNUSDT','C98USDT','BTCUSDT'];
const TARGETS={RLCUSDT:108.44,RADUSDT:47.55,ORCAUSDT:28.87,API3USDT:26.95,DIAUSDT:17.56,OGNUSDT:15.40,C98USDT:15.37};

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const num=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const clamp=(v,a=0,b=100)=>Math.max(a,Math.min(b,Number(v)||0));
const mean=a=>{const x=a.filter(Number.isFinite);return x.length?x.reduce((s,v)=>s+v,0)/x.length:null;};
const median=a=>{const x=a.filter(Number.isFinite).slice().sort((a,b)=>a-b);if(!x.length)return null;const m=x.length>>1;return x.length%2?x[m]:(x[m-1]+x[m])/2;};
const stdev=a=>{const m=mean(a);if(!Number.isFinite(m))return null;const x=a.filter(Number.isFinite);return x.length?Math.sqrt(mean(x.map(v=>(v-m)**2))):null;};

function ema(x,p){const a=x.filter(Number.isFinite);if(a.length<p)return null;let e=mean(a.slice(0,p));const k=2/(p+1);for(const v of a.slice(p))e=v*k+e*(1-k);return e;}
function emaSeries(x,p){const a=x.map(Number);if(a.length<p)return Array(a.length).fill(null);const out=Array(a.length).fill(null);let e=mean(a.slice(0,p));out[p-1]=e;const k=2/(p+1);for(let i=p;i<a.length;i++){e=a[i]*k+e*(1-k);out[i]=e;}return out;}
function rsiSeries(x,p=14){if(x.length<p+1)return [];let g=0,l=0;for(let i=1;i<=p;i++){const d=x[i]-x[i-1];if(d>=0)g+=d;else l-=d;}let ag=g/p,al=l/p;const out=Array(x.length).fill(null);out[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<x.length;i++){const d=x[i]-x[i-1];ag=(ag*(p-1)+Math.max(0,d))/p;al=(al*(p-1)+Math.max(0,-d))/p;out[i]=al===0?100:100-100/(1+ag/al);}return out;}
function trueRanges(c){const out=Array(c.length).fill(null);for(let i=0;i<c.length;i++){const h=c[i].h,l=c[i].l,pc=i?c[i-1].c:null;out[i]=i?Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)):h-l;}return out;}
function atrSeries(c,p=14){const tr=trueRanges(c),out=Array(c.length).fill(null);if(c.length<p)return out;let a=mean(tr.slice(0,p));out[p-1]=a;for(let i=p;i<c.length;i++){a=(a*(p-1)+tr[i])/p;out[i]=a;}return out;}
function macdHistSeries(c){const x=c.map(v=>v.c),e12=emaSeries(x,12),e26=emaSeries(x,26);const macd=x.map((_,i)=>Number.isFinite(e12[i])&&Number.isFinite(e26[i])?e12[i]-e26[i]:null);const vals=macd.filter(Number.isFinite);const sig=emaSeries(vals,9);const aligned=Array(x.length).fill(null);let j=0;for(let i=0;i<macd.length;i++)if(Number.isFinite(macd[i])){if(Number.isFinite(sig[j]))aligned[i]=sig[j];j++;}return macd.map((m,i)=>Number.isFinite(m)&&Number.isFinite(aligned[i])?m-aligned[i]:null);}
function adxApprox(c,p=14){if(c.length<p*2+2)return null;const tr=trueRanges(c),plus=Array(c.length).fill(0),minus=Array(c.length).fill(0);for(let i=1;i<c.length;i++){const up=c[i].h-c[i-1].h,down=c[i-1].l-c[i].l;plus[i]=up>down&&up>0?up:0;minus[i]=down>up&&down>0?down:0;}let atr=mean(tr.slice(1,p+1)),pg=mean(plus.slice(1,p+1)),mg=mean(minus.slice(1,p+1)),adx=null;const dx=[];for(let i=p+1;i<c.length;i++){atr=(atr*(p-1)+tr[i])/p;pg=(pg*(p-1)+plus[i])/p;mg=(mg*(p-1)+minus[i])/p;const pdi=100*pg/Math.max(atr,1e-12),mdi=100*mg/Math.max(atr,1e-12);dx.push(100*Math.abs(pdi-mdi)/Math.max(pdi+mdi,1e-12));}adx=dx.length>=p?mean(dx.slice(-p)):mean(dx);return Number.isFinite(adx)?adx:null;}
function obvSeries(c){let o=0;const out=[0];for(let i=1;i<c.length;i++){if(c[i].c>c[i-1].c)o+=c[i].v;else if(c[i].c<c[i-1].c)o-=c[i].v;out.push(o);}return out;}
function bb(c,p=20,k=2){const x=c.slice(-p).map(v=>v.c);if(x.length<p)return null;const m=mean(x),sd=stdev(x);return {mid:m,upper:m+k*sd,lower:m-k*sd,width:m>0?(2*k*sd/m):null};}
function vwap(c,n=96){const a=c.slice(-n);const den=a.reduce((s,x)=>s+x.v,0);return den>0?a.reduce((s,x)=>s+((x.h+x.l+x.c)/3)*x.v,0)/den:null;}
function rvol(c,n=20){if(c.length<n+1)return null;const base=c.slice(-(n+1),-1).map(x=>x.v);return c.at(-1).v/Math.max(mean(base),1e-12);}
function tradeRvol(c,n=20){if(c.length<n+1)return null;const base=c.slice(-(n+1),-1).map(x=>x.t);return c.at(-1).t/Math.max(mean(base),1e-12);}
function ret(c,bars){if(c.length<=bars)return null;const a=c.at(-1).c,b=c.at(-(bars+1)).c;return b>0?(a-b)/b*100:null;}
function higherLowScore(c,n=24){const a=c.slice(-n);if(a.length<8)return 0;const chunk=Math.max(2,Math.floor(a.length/4));const lows=[0,1,2,3].map(k=>mean(a.slice(k*chunk,(k+1)*chunk).map(x=>x.l)));let rises=0;for(let i=1;i<lows.length;i++)if(lows[i]>lows[i-1]*(1+0.001))rises++;return rises/3*100;}
function localResistance(c,n=24){const a=c.slice(-n);if(a.length<6)return null;return Math.max(...a.slice(0,-2).map(x=>x.h));}
function featureAt(c,i,btcByTime){
  if(i<60)return null;const a=c.slice(0,i+1),last=a.at(-1),closes=a.map(x=>x.c),rs=rsiSeries(closes),atr=atrSeries(a),macd=macdHistSeries(a),obv=obvSeries(a);
  const b=bb(a),vw=vwap(a),res=localResistance(a), rv=rvol(a),trv=tradeRvol(a);
  const e9=ema(closes,9),e21=ema(closes,21),e50=ema(closes,50),adx=adxApprox(a);
  const r1=ret(a,1),r3=ret(a,3),r5=ret(a,5),r15=ret(a,15);
  const p3=Number.isFinite(r3)&&Number.isFinite(ret(a,6))?r3-ret(a,6):null;
  const rsival=rs.at(-1),rsiPrev=rs.at(-4),macdh=macd.at(-1),macdPrev=macd.at(-4);
  const atrNow=atr.at(-1),atrBase=mean(atr.slice(-31,-1));const atrRatio=Number.isFinite(atrNow)&&atrBase>0?atrNow/atrBase:null;
  const bbw=b?.width??null;const bbBase=mean(a.slice(-41,-1).map((_,j)=>{const q=a.slice(Math.max(0,a.length-41+j-20),Math.max(0,a.length-41+j));return q.length===20?bb(q)?.width:null}).filter(Number.isFinite));const bbRatio=Number.isFinite(bbw)&&bbBase>0?bbw/bbBase:null;
  const taker=last.v>0?last.tb/last.v:null;const takerBase=mean(a.slice(-21,-1).map(x=>x.v>0?x.tb/x.v:null).filter(Number.isFinite));const takerAccel=Number.isFinite(taker)&&Number.isFinite(takerBase)?taker-takerBase:null;
  const bv=btcByTime.get(last.ts)?.c;const bprev=btcByTime.get(a.at(-6)?.ts)?.c;const btc5=bprev>0?(bv-bprev)/bprev*100:null;const rel5=Number.isFinite(r5)&&Number.isFinite(btc5)?r5-btc5:null;
  const resDist=Number.isFinite(res)&&res>last.c?(res-last.c)/last.c*100:(Number.isFinite(res)&&last.c>=res?0:null);
  const obvDelta=obv.at(-1)-obv.at(-6),obvBase=Math.abs(mean(obv.slice(-30,-5)))||1;const obvScore=clamp(50+obvDelta/obvBase*500);
  return {
    r1,r3,r5,r15,acceleration:Number.isFinite(p3)?p3:null,rvol:rv,trade_rvol:trv,atr_ratio:atrRatio,bb_width:bbw,bb_ratio:bbRatio,vwap_distance:vw&&last.c>0?(last.c-vw)/last.c*100:null,
    ema9_21:e9&&e21?(e9-e21)/last.c*100:null,ema_stack:e9>e21&&e21>e50,adx,rsi:rsival,rsi_slope:Number.isFinite(rsival)&&Number.isFinite(rsiPrev)?rsival-rsiPrev:null,
    macd_hist:macdh,macd_slope:Number.isFinite(macdh)&&Number.isFinite(macdPrev)?macdh-macdPrev:null,obv_score:obvScore,higher_lows:higherLowScore(a,24),resistance_distance:resDist,
    taker_ratio:taker,taker_accel:takerAccel,relative_strength_5m:rel5
  };
}
function score(f){
  if(!f)return null;
  const s=[];
  s.push(clamp(50+(f.r5??0)*10));s.push(clamp(50+(f.acceleration??0)*15));s.push(clamp(50+((f.rvol??1)-1)*65));
  s.push(clamp(50+((f.trade_rvol??1)-1)*45));s.push(Number.isFinite(f.atr_ratio)?clamp(100-Math.abs(f.atr_ratio-0.8)*150):50);
  s.push(Number.isFinite(f.bb_ratio)?clamp(100-Math.max(0,f.bb_ratio-0.8)*120):50);s.push(clamp(50-(f.vwap_distance??0)*80));
  s.push(f.ema_stack?86:55);s.push(Number.isFinite(f.adx)?clamp(f.adx*2.5):50);s.push(Number.isFinite(f.rsi)?(f.rsi>=52&&f.rsi<=72?82:f.rsi>=48?64:35):50);
  s.push(Number.isFinite(f.macd_hist)&&f.macd_hist>0?clamp(65+(f.macd_slope??0)*80):40);s.push(f.obv_score??50);s.push(f.higher_lows);
  s.push(Number.isFinite(f.resistance_distance)?(f.resistance_distance<=2?94:f.resistance_distance<=5?84:f.resistance_distance<=9?68:44):50);
  s.push(Number.isFinite(f.taker_ratio)?clamp(50+(f.taker_ratio-.5)*240+(f.taker_accel??0)*180):50);
  s.push(Number.isFinite(f.relative_strength_5m)?clamp(50+f.relative_strength_5m*20):50);
  return mean(s);
}
function findPreMove(c){
  const n=c.length;let best=null;
  for(let i=Math.max(60,n-288);i<n-12;i++){
    const p=c[i].c;const fut=c.slice(i+1,Math.min(n,i+73));const peak=Math.max(...fut.map(x=>x.h));const rise=(peak-p)/p*100;
    const pre15=i>=15?(c[i].c-c[i-15].c)/c[i-15].c*100:0;const pre60=i>=60?(c[i].c-c[i-60].c)/c[i-60].c*100:0;
    const score= rise>=8 ? rise - Math.max(0,pre60-4)*2 - Math.max(0,pre15-2) : -1;
    if(best==null || score>best.score)best={i,rise,pre15,pre60,score};
  }
  return best;
}
async function getKlines(symbol,interval,limit){
  const u=new URL(BASE+'/klines');u.searchParams.set('symbol',symbol);u.searchParams.set('interval',interval);u.searchParams.set('limit',String(limit));
  for(let k=0;k<4;k++){try{const r=await fetch(u,{headers:{accept:'application/json'}});if(!r.ok)throw new Error('HTTP_'+r.status);return (await r.json()).map(x=>({ts:Number(x[0]),o:Number(x[1]),h:Number(x[2]),l:Number(x[3]),c:Number(x[4]),v:Number(x[5]),ct:Number(x[6]),t:Number(x[8]),tb:Number(x[9])}));}catch(e){if(k===3)throw e;await sleep(300*(k+1));}}
}
async function one(symbol){
  const [m5,b5,m15,m1]=await Promise.all([getKlines(symbol,'5m',500),getKlines('BTCUSDT','5m',500),getKlines(symbol,'15m',260),getKlines(symbol,'1m',1500)]);
  const btcMap=new Map(b5.filter(x=>x.ct<=Date.now()).map(x=>[x.ts,x]));
  const pre=findPreMove(m5);
  const i=pre?.i??(m5.length-1);
  const f5=featureAt(m5,i,btcMap);
  const i1=Math.min(m1.length-1,Math.max(60,Math.round((m1.length-1)-(m5.length-1-i)*5)));
  const f1=featureAt(m1,i1,new Map(b5.map(x=>[x.ts,x])));
  const nowF=featureAt(m5,m5.length-1,btcMap);
  const snap={symbol,target_24h_pct:TARGETS[symbol],pre_move_at:new Date(m5[i].ts).toISOString(),forward_peak_pct:Number(pre.rise.toFixed(2)),pre_window_15m_pct:Number(pre.pre15.toFixed(2)),pre_window_60m_pct:Number(pre.pre60.toFixed(2)),pre_5m_score:Number(score(f5)?.toFixed(1)),pre_1m_score:Number(score(f1)?.toFixed(1)),now_5m_score:Number(score(nowF)?.toFixed(1)),features_5m:f5,features_1m:f1};
  return snap;
}
const rows=[];
for(const symbol of SYMBOLS){try{rows.push(await one(symbol));console.log('RESEARCH',JSON.stringify(rows.at(-1)));}catch(e){console.log('ERROR',symbol,String(e?.message||e));}}
const out={generated_at:new Date().toISOString(),timezone:'Asia/Aden',symbols:rows,method:'5m/1m closed-candle lookback; future window only for offline labeling; no future data used by live gate.'};
await fs.writeFile('radar8-research.json',JSON.stringify(out,null,2));
console.log('RADAR8_RESEARCH_DONE',rows.length);
