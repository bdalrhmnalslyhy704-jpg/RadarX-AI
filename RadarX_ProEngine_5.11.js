(() => {
  'use strict';

  // RadarX Pro Intelligence Engine 6.8
  // This module extends RadarX 4.15 without replacing its existing engines.
  // It never invents market data. Missing providers are marked unavailable and
  // their weight is excluded from the evidence average, while coverage reduces confidence.

  const CORE = window.RadarXCore;
  if (!CORE?.state) return;
  const {state, $, num, clamp, t, fetchAllTickers, fetchAllTickersResilient, fetchTicker, fetchKlines, fetchDepth, fetchTrades, fetchJSON, notifyUser, toast, premiumIsUnlocked} = CORE;

  const PERSIST_KEY = 'radarx_pro_engine_511';
  const LOG_KEY = 'radarx_pro_logs_511';
  const CACHE_TTL = {global: 2*60e3, exchange: 180e3, kline: 90e3, flow: 30e3, derivatives: 180e3};
  const PRO = {
    version: '6.8',
    cycleMs: 60000,
    initialCandidates: 24,
    mtfCandidates: 7,
    flowCandidates: 3,
    derivativeCandidates: 3,
    klineLimit: { '5m': 120, '15m': 90, '1h': 80, '4h': 72 },
    targetMovePct: 2.0,
    targetWindowBars: 12,
    baseThreshold: 64,
    preThreshold: 70,
    breakoutThreshold: 74,
    falseTrap: 68,
    exhaustedMove24h: 15,
    maxPreMove24h: 10,
    minQuoteVolume: 350000,
    cacheMaxAgeMs: 24*3600e3,
    maxLog: 400,
    evidenceRefreshMs: 45000,
    researchYieldEvery: 40
  };

  const WEIGHTS = {
    market: 16,
    structure: 12,
    compression: 11,
    volume: 15,
    relative: 10,
    liquidity: 9,
    orderbook: 7,
    orderflow: 5,
    mtf: 9,
    derivatives: 3,
    crossExchange: 3,
    sector: 2,
    catalyst: 1,
    social: 1,
    onchain: 1,
  };

  const SECTORS = {
    L1: ['ETHUSDT','BNBUSDT','SOLUSDT','SUIUSDT','AVAXUSDT','APTUSDT','NEARUSDT','ATOMUSDT','SEIUSDT'],
    DEFI: ['AAVEUSDT','UNIUSDT','CRVUSDT','MKRUSDT','COMPUSDT','LDOUSDT','RUNEUSDT','LINKUSDT'],
    AI: ['RENDERUSDT','TAOUSDT','FETUSDT','THETAUSDT','NEARUSDT','GRTUSDT'],
    GAMING: ['IMXUSDT','SANDUSDT'],
    MEME: ['DOGEUSDT','PEPEUSDT'],
    INFRA: ['LINKUSDT','RUNEUSDT','GRTUSDT','ATOMUSDT'],
  };

  const DEFAULT_STATE = {
    running:false,
    lastCycleAt:0,
    lastGoodCycleAt:0,
    lastError:'',
    source:'waiting',
    latencyMs:0,
    candidates:[],
    regime:null,
    crossExchange:{},
    global:null,
    flow:new Map(),
    derivatives:new Map(),
    klines:new Map(),
    orderbookHistory:new Map(),
    pulseMemory:new Map(),
    external:{catalyst:new Map(),social:new Map(),onchain:new Map(),tokenomics:new Map()},
    alerts:new Map(),
    research:null,
    weights:{...WEIGHTS},
    config:{...PRO}, lastEnrichFingerprint:'', lastEnrichAt:0, lastCrossAt:0, lastOnchainAt:0, lastSocialAt:0,
  };

  const old = window.__RadarXProState;
  const ps = old && typeof old === 'object' ? Object.assign(DEFAULT_STATE, old) : DEFAULT_STATE;
  ps.weights={...WEIGHTS,...(old?.weights||{})};
  ps.external={catalyst:new Map(),social:new Map(),onchain:new Map(),tokenomics:new Map(),...(old?.external||{})};
  ps.pulseMemory=old?.pulseMemory instanceof Map?old.pulseMemory:new Map();
  window.__RadarXProState = ps;
  state.proEngine = ps;

  function now(){ return Date.now(); }
  function finite(x){ return Number.isFinite(Number(x)); }
  function avg(a){ const v=(a||[]).map(Number).filter(Number.isFinite); return v.length?v.reduce((s,x)=>s+x,0)/v.length:0; }
  function median(a){ const v=(a||[]).map(Number).filter(Number.isFinite).sort((x,y)=>x-y); if(!v.length)return 0; const m=(v.length-1)/2; return v[Math.floor(m)] + (v[Math.ceil(m)]-v[Math.floor(m)])*(m-Math.floor(m)); }
  function stdev(a){ const v=(a||[]).map(Number).filter(Number.isFinite); if(v.length<2)return 0; const m=avg(v); return Math.sqrt(avg(v.map(x=>(x-m)*(x-m)))); }
  function pctChange(a,b){ return a>0 && b>0 ? ((b/a)-1)*100 : null; }
  const yieldToBrowser=()=>new Promise(r=>setTimeout(r,0));
  function tfMinutes(tf){return tf==='1m'?1:tf==='5m'?5:tf==='15m'?15:tf==='1h'?60:tf==='4h'?240:5;}
  function ratio(a,b, fallback=0){ return b>0 ? a/b : fallback; }
  function weightedScore(parts, weights=ps.weights){
    let total=0, w=0, present=0;
    for(const [key,part] of Object.entries(parts||{})){
      if(!part || part.available!==true || !finite(part.score)) continue;
      const ww=num(weights[key],0); if(ww<=0)continue;
      total += clamp(part.score)*ww; w += ww; present += ww;
    }
    const raw=w?total/w:50;
    const coverage=Object.values(weights).reduce((s,x)=>s+num(x),0)>0?present/Object.values(weights).reduce((s,x)=>s+num(x),0):0;
    // Missing evidence does not get a fabricated neutral score. It reduces confidence and final score.
    const final=clamp(raw*(0.55+0.45*coverage));
    return {score:final,coverage,observedWeight:w};
  }
  function saveLog(type,payload={}){
    try{
      const logs=JSON.parse(localStorage.getItem(LOG_KEY)||'[]');
      logs.unshift({ts:now(),type,payload}); localStorage.setItem(LOG_KEY,JSON.stringify(logs.slice(0,PRO.maxLog)));
    }catch{}
  }

  function eligibleTicker(x){
    if(!x?.symbol||!/USDT$/.test(x.symbol)||!(x.last>0))return false;
    if(state.marketsBySymbol?.[x.symbol]?.quoteAsset && state.marketsBySymbol[x.symbol].quoteAsset!=='USDT')return false;
    if(/^(USDC|USDP|FDUSD|TUSD|DAI|USDE|USDS|BUSD)USDT$/.test(x.symbol))return false;
    if(/(UP|DOWN|BULL|BEAR)USDT$/.test(x.symbol))return false;
    return num(x.quoteVolume)>=PRO.minQuoteVolume;
  }

  function sma(vals,n){ const v=(vals||[]).slice(-n).map(Number).filter(Number.isFinite); return v.length?v.reduce((a,b)=>a+b,0)/v.length:0; }
  function ema(vals,n){ const v=(vals||[]).map(Number).filter(Number.isFinite); if(!v.length)return 0; const k=2/(n+1); let e=v[0]; for(let i=1;i<v.length;i++)e=v[i]*k+e*(1-k); return e; }
  function trueRange(rows){ const out=[]; for(let i=0;i<rows.length;i++){const c=rows[i],p=rows[i-1]||c;out.push(Math.max(c.h-c.l,Math.abs(c.h-p.c),Math.abs(c.l-p.c)));} return out; }
  function atr(rows,n=14){return sma(trueRange(rows),n);}
  function rsi(vals,p=14){if(vals.length<p+1)return 50;let g=0,l=0;for(let i=vals.length-p;i<vals.length;i++){const d=vals[i]-vals[i-1];if(d>=0)g+=d;else l-=d;}if(l===0)return 100;return 100-(100/(1+g/l));}
  function macd(vals){const e12=ema(vals,12),e26=ema(vals,26); const line=e12-e26; const series=[]; for(let i=Math.max(0,vals.length-60);i<vals.length;i++){const s=vals.slice(0,i+1);series.push(ema(s,12)-ema(s,26));} const sig=ema(series,9); return {line,hist:line-sig,signal:sig};}
  function adx(rows,p=14){
    if(rows.length<p*2+2)return 0;
    const tr=[],plus=[],minus=[];
    for(let i=1;i<rows.length;i++){
      const c=rows[i],pr=rows[i-1];
      tr.push(Math.max(c.h-c.l,Math.abs(c.h-pr.c),Math.abs(c.l-pr.c)));
      const up=c.h-pr.h,down=pr.l-c.l;plus.push(up>down&&up>0?up:0);minus.push(down>up&&down>0?down:0);
    }
    const atrv=sma(tr.slice(-p),p)||1, pdi=sma(plus.slice(-p),p)/atrv*100, mdi=sma(minus.slice(-p),p)/atrv*100;
    const dx=(pdi+mdi)?Math.abs(pdi-mdi)/(pdi+mdi)*100:0; return clamp(dx*1.15,0,100);
  }
  function linSlope(vals){if(vals.length<2)return 0;const m=avg(vals),xbar=(vals.length-1)/2;let a=0,b=0;for(let i=0;i<vals.length;i++){a+=(i-xbar)*(vals[i]-m);b+=(i-xbar)*(i-xbar);}return b?a/b:0;}
  function swingPoints(rows,left=2,right=2){
    const highs=[],lows=[];
    for(let i=left;i<rows.length-right;i++){
      let hi=true,lo=true;for(let j=1;j<=left;j++){hi&&=rows[i].h>=rows[i-j].h;lo&&=rows[i].l<=rows[i-j].l;}for(let j=1;j<=right;j++){hi&&=rows[i].h>=rows[i+j].h;lo&&=rows[i].l<=rows[i+j].l;}
      if(hi)highs.push({i,p:rows[i].h,t:rows[i].t}); if(lo)lows.push({i,p:rows[i].l,t:rows[i].t});
    } return {highs,lows};
  }
  function detectPatterns(rows,structure,volume){
    if(rows.length<30)return {patterns:[],confidence:20};
    const c=rows.map(x=>x.c), h=rows.map(x=>x.h), l=rows.map(x=>x.l), last=c.at(-1);
    const win=c.slice(-30), hi=Math.max(...h.slice(-30,-3)), lo=Math.min(...l.slice(-30,-3));
    const older=rows.slice(-30,-15), recent=rows.slice(-15);
    const olderRange=pctChange(Math.min(...older.map(x=>x.l)),Math.max(...older.map(x=>x.h)));
    const recentRange=pctChange(Math.min(...recent.map(x=>x.l)),Math.max(...recent.map(x=>x.h)));
    const patterns=[];
    if(hi>0){
      const highs=(structure?.highs||[]).slice(-4).map(x=>x.p), lows=(structure?.lows||[]).slice(-4).map(x=>x.p);
      if(highs.length>=2&&lows.length>=2){
        const highFlat=Math.abs((highs.at(-1)-highs.at(-2))/highs.at(-2))*100<1.2;
        const lowRise=lows.at(-1)>lows.at(-2)*1.006;
        if(highFlat&&lowRise)patterns.push('ASCENDING_TRIANGLE');
      }
    }
    const pullback=(Math.max(...h.slice(-12))-last)/Math.max(last,1e-9)*100;
    const flagTrend=linSlope(c.slice(-25))>0;
    if(flagTrend&&pullback<5&&pullback>0.4&&num(volume?.ratio)>1.05)patterns.push('BULL_FLAG');
    const mid=avg(c.slice(-14)), side=stdev(c.slice(-14))/Math.max(mid,1e-9)*100;
    if(side<1.8&&Math.max(...h.slice(-8))-Math.min(...l.slice(-8))>0)patterns.push('PENNANT');
    const base=(Math.max(...h.slice(-20))-Math.min(...l.slice(-20)))/Math.max(last,1e-9)*100;
    if(base<8&&linSlope(c.slice(-10))>0&&num(volume?.ratio)>1.15)patterns.push('BASE_BREAKOUT');
    const downSlope=linSlope(c.slice(-20))<0, lowerHighs=(structure?.highs?.length>=2?structure.highs.at(-1).p<structure.highs.at(-2).p:false), lowerLows=(structure?.lows?.length>=2?structure.lows.at(-1).p<structure.lows.at(-2).p:false);
    if(downSlope&&lowerHighs&&lowerLows&&pctChange(lo,last)!==null&&last>c.at(-10))patterns.push('FALLING_WEDGE_CONTEXT');
    if(recentRange!=null&&olderRange!=null&&recentRange<olderRange*.55&&olderRange<12)patterns.push('CUP_HANDLE_BASE');
    return {patterns:[...new Set(patterns)],confidence:clamp(40+patterns.length*12,20,95)};
  }
  function volumeProfile(rows,bins=28){
    const usable=rows.slice(-120).filter(x=>x.h>0&&x.l>0&&x.v>0), out={poc:null,vah:null,val:null,hvn:[],lvn:[],available:false};
    if(usable.length<20)return out;
    const lo=Math.min(...usable.map(x=>x.l)),hi=Math.max(...usable.map(x=>x.h)); if(!(hi>lo))return out;
    const width=(hi-lo)/bins, hist=Array.from({length:bins},()=>0);
    usable.forEach(r=>{const mid=(r.h+r.l+r.c)/3;const i=Math.max(0,Math.min(bins-1,Math.floor((mid-lo)/width)));hist[i]+=r.v;});
    const total=hist.reduce((a,b)=>a+b,0),pocI=hist.indexOf(Math.max(...hist));
    let l=pocI,r=pocI,c=hist[pocI],target=total*.70; while(c<target&&(l>0||r<bins-1)){const lv=l>0?hist[l-1]:-1,rv=r<bins-1?hist[r+1]:-1;if(rv>=lv){r=Math.min(bins-1,r+1);c+=hist[r];}else{l=Math.max(0,l-1);c+=hist[l];}}
    const level=i=>lo+(i+.5)*width;
    const ranked=hist.map((v,i)=>({i,v,price:level(i)})).sort((a,b)=>b.v-a.v);
    out.poc=level(pocI);out.val=level(l);out.vah=level(r);out.hvn=ranked.slice(0,3).map(x=>x.price);out.lvn=ranked.slice(-3).map(x=>x.price);out.available=true; return out;
  }
  function vwap(rows){const u=rows.slice(-80).filter(r=>r.v>0);let pv=0,v=0;for(const r of u){const tp=(r.h+r.l+r.c)/3;pv+=tp*r.v;v+=r.v;}return v?pv/v:null;}
  function divergence(rows){
    if(rows.length<35)return {available:false};
    const c=rows.map(r=>r.c), rv=c.map((_,i)=>rsi(c.slice(0,i+1),14));
    const sp=swingPoints(rows,2,2), highs=sp.highs.slice(-3),lows=sp.lows.slice(-3);let bull=false,bear=false;
    if(lows.length>=2){const a=lows.at(-2),b=lows.at(-1);bull=b.p<a.p && rv[b.i]>rv[a.i]+2;}
    if(highs.length>=2){const a=highs.at(-2),b=highs.at(-1);bear=b.p>a.p && rv[b.i]<rv[a.i]-2;}
    return {available:true,bull,bear};
  }
  function structure(rows){
    const sp=swingPoints(rows,2,2), hs=sp.highs.slice(-5),ls=sp.lows.slice(-5), last=rows.at(-1),p=rows.at(-2)||last;
    const hh=hs.length>=2&&hs.at(-1).p>hs.at(-2).p,hl=ls.length>=2&&ls.at(-1).p>ls.at(-2).p,lh=hs.length>=2&&hs.at(-1).p<hs.at(-2).p,ll=ls.length>=2&&ls.at(-1).p<ls.at(-2).p;
    const rh=hs.at(-1)?.p||Math.max(...rows.slice(-20).map(x=>x.h)),rl=ls.at(-1)?.p||Math.min(...rows.slice(-20).map(x=>x.l));
    const resistance=Math.max(...rows.slice(-30,-1).map(x=>x.h)),support=Math.min(...rows.slice(-30,-1).map(x=>x.l));
    const breakout=last.c>resistance && p.c<=resistance; const failed=last.h>resistance && last.c<resistance;
    const bias=(hh&&hl)?'BULLISH':(lh&&ll)?'BEARISH':'RANGE';
    const rangePct=last.c?((Math.max(...rows.slice(-24).map(x=>x.h))-Math.min(...rows.slice(-24).map(x=>x.l)))/last.c)*100:0;
    const distResistance=last.c?((resistance-last.c)/last.c)*100:null;
    return {highs:hs,lows:ls,higherHigh:hh,higherLow:hl,lowerHigh:lh,lowerLow:ll,bias,resistance,support,breakout,failed,localHigh:rh,localLow:rl,rangePct,distResistance};
  }
  function compression(rows){
    const tr=trueRange(rows), atrF=sma(tr.slice(-8),8), atrS=sma(tr.slice(-34),34)||atrF||1;
    const c=rows.map(x=>x.c),mid=sma(c.slice(-20),20),sd=stdev(c.slice(-20)),bb=mid?sd*4/mid*100:0;
    const prevWidths=[]; for(let i=Math.max(20,rows.length-50);i<rows.length-5;i++){const q=c.slice(i-20,i),m=sma(q,20),s=stdev(q);prevWidths.push(m?s*4/m*100:0);} const bbPct=prevWidths.length?bb<=quantile(prevWidths,.2):false;
    const ranges=rows.slice(-10).map(x=>(x.h-x.l)/Math.max(x.c,1e-9)*100), prevRanges=rows.slice(-35,-10).map(x=>(x.h-x.l)/Math.max(x.c,1e-9)*100);
    const rangeRatio=avg(ranges)/Math.max(avg(prevRanges),1e-9);
    const atrRatio=atrF/atrS;
    const score=clamp((1-atrRatio)*80 + (bbPct?30:0) + (1-rangeRatio)*65,0,100);
    const expansion=atrRatio>1.15 || rangeRatio>1.35;
    return {atrFast:atrF,atrSlow:atrS,atrRatio,bbWidth:bb,bbSqueeze:bbPct,rangeRatio,expansion,score};
  }
  function volumeIntel(rows){
    const cur=rows.at(-1), prev=rows.slice(-26,-1), v=prev.map(x=>x.v).filter(x=>x>0); if(!cur||!v.length)return {available:false};
    const baseline=avg(v), med=median(v)||baseline||1, rv=cur.v/(baseline||1);
    const short=avg(rows.slice(-3).map(x=>x.v)); const base10=avg(rows.slice(-13,-3).map(x=>x.v));
    const volAccel=base10>0?short/base10:1; const priorShort=avg(rows.slice(-6,-3).map(x=>x.v)); const accel2=priorShort>0?short/priorShort:1;
    const deltaRows=rows.slice(-30).map(x=>{const tb=num(x.tb,0);const v=num(x.v,0);return tb>0?(tb-Math.max(0,v-tb)):0;});
    const delta=deltaRows.length?deltaRows.at(-1):0, deltaPct=cur.v?delta/cur.v*100:0;
    const cvd=deltaRows.reduce((s,x)=>s+x,0);
    const dryup=rv<.68 && volAccel<.9, expansion=rv>1.15 || volAccel>1.25, spike=rv>=1.8;
    const score=clamp(45 + (rv-1)*26 + (volAccel-1)*22 + (deltaPct>5?8:deltaPct<-5?-8:0),0,100);
    return {available:true,rvol:rv,volumeRatio:rv,acceleration:volAccel,acceleration2:accel2,delta,deltaPct,cvd,deltaBias:deltaPct>=5?'BUY':deltaPct<=-5?'SELL':'BALANCED',dryup,expansion,spike,score};
  }
  function quantile(a,q){const v=(a||[]).filter(Number.isFinite).sort((x,y)=>x-y);if(!v.length)return 0;const p=(v.length-1)*q,lo=Math.floor(p),hi=Math.ceil(p);return lo===hi?v[lo]:v[lo]+(v[hi]-v[lo])*(p-lo);}

  function technicalFeatures(rows){
    if(!rows?.length)return null;
    const closes=rows.map(r=>r.c), last=rows.at(-1), c20=closes.slice(-20), e20=ema(closes,20),e50=ema(closes,50),e100=ema(closes,100),e200=ema(closes,200), r=rsi(closes,14), m=macd(closes), a=atr(rows,14), ad=adx(rows,14), cp=compression(rows), vi=volumeIntel(rows), st=structure(rows), vp=volumeProfile(rows), vw=vwap(rows), div=divergence(rows), pats=detectPatterns(rows,st,vi), body=Math.abs(last.c-last.o)/Math.max(last.h-last.l,1e-9), closePos=(last.c-last.l)/Math.max(last.h-last.l,1e-9);
    const priceVsVwap=vw?((last.c/vw)-1)*100:null, ret5=pctChange(closes.at(-6),last.c),ret15=pctChange(closes.at(-16),last.c),ret60=pctChange(closes.at(-13),last.c), atrPct=last.c?a/last.c*100:0;
    const trendScore=clamp(50 + (last.c>e20?8:-8) + (e20>e50?9:-9) + (e50>e100?6:-6) + (e100>e200?5:-5) + (ad>35?8:ad>20?4:0));
    const distResistance=st.distResistance;
    const pressure=distResistance!=null?clamp(100-Math.max(-1,distResistance)*45,0,100):50;
    const priceStructureScore=clamp(50 + (st.bias==='BULLISH'?18:st.bias==='BEARISH'?-18:0) + (st.higherHigh&&st.higherLow?14:st.lowerHigh&&st.lowerLow?-14:0) + (st.breakout?22:0) - (st.failed?30:0));
    const compressionScore=clamp(cp.score + (Math.abs(distResistance||99)<2?12:0) + (cp.expansion?10:0));
    const volumeScore=vi?.score||50;
    const vwapScore=vw==null?50:clamp(50+priceVsVwap*18 + (vi?.expansion&&priceVsVwap>0?10:0),0,100);
    const stageMove24h=num(rows.__ticker24h,0);
    let phase='NORMAL';
    const trap=st.failed || (st.breakout && vi?.rvol<1.05) ? clamp((st.failed?62:35)+(vi?.rvol<1?15:0),0,100):0;
    const nearResistance=distResistance!=null&&distResistance>=-0.5&&distResistance<=2.2;
    const early=cp.score>=55&&nearResistance&&vi?.acceleration>=1.10&&priceStructureScore>=55;
    const breakout=st.breakout || (distResistance!=null&&distResistance<-0.15&&vi?.rvol>=1.35&&last.c>rows.at(-2).c);
    const late=num(stageMove24h)>PRO.maxPreMove24h || (st.breakout&&num(ret60)>5&&cp.expansion&&vi?.acceleration<1.05);
    if(trap>=68)phase='HIGH_RISK_FALSE_BREAKOUT'; else if(late)phase='EXHAUSTED_LATE'; else if(breakout)phase='BREAKOUT'; else if(early)phase='PRE_BREAKOUT'; else if(cp.score>=50&&vi?.dryup&&nearResistance)phase='BUILDING';
    return {last,e20,e50,e100,e200,rsi:r,macd:m,atr:a,atrPct,adx:ad,compression:cp,volume:vi,structure:st,volumeProfile:vp,vwap:vw,priceVsVwap,divergence:div,patterns:pats,ret5,ret15,ret60,trendScore,priceStructureScore,pressure,vwapScore,phase,trap,bodyRatio:body,closePos};
  }

  function marketRegime(markets, btcRows=null, ethRows=null, global=null){
    const arr=(markets||[]).filter(eligibleTicker), up=arr.filter(x=>x.priceChangePercent>0).length, down=arr.filter(x=>x.priceChangePercent<0).length;
    const breadth=arr.length?up/arr.length*100:50, median24=median(arr.map(x=>num(x.priceChangePercent))), avgAbs=avg(arr.map(x=>Math.abs(num(x.priceChangePercent))));
    const btc=arr.find(x=>x.symbol==='BTCUSDT'),eth=arr.find(x=>x.symbol==='ETHUSDT');
    const btcF=btcRows?technicalFeatures(btcRows):null, ethF=ethRows?technicalFeatures(ethRows):null;
    const btcTrend=btcF?.trendScore??clamp(50+num(btc?.priceChangePercent)*5);
    const ethTrend=ethF?.trendScore??clamp(50+num(eth?.priceChangePercent)*5);
    const btc1h=btcF?.ret60??null, eth1h=ethF?.ret60??null;
    const btcComponent=clamp(btcTrend-50,-35,35), ethComponent=clamp(ethTrend-50,-30,30);
    const marketStrength=clamp(50+(breadth-50)*.55+median24*4.5+btcComponent*.35+ethComponent*.20);
    let regime='RANGE';
    if(avgAbs>=4)regime='HIGH_VOLATILITY'; else if(avgAbs<1.2)regime='LOW_VOLATILITY'; else if(breadth>=62&&marketStrength>58)regime='TREND_BULL'; else if(breadth<=38&&marketStrength<42)regime='TREND_BEAR';
    const riskPenalty=regime==='TREND_BEAR'?18:regime==='HIGH_VOLATILITY'?10:regime==='LOW_VOLATILITY'?2:0;
    const dominance=num(global?.btcDominance,NaN);
    const dominanceContext=finite(dominance)?clamp(50-(dominance-50)*.35):null;
    const score=clamp(marketStrength-riskPenalty + (dominanceContext==null?0:(dominanceContext-50)*.18));
    const sectors={};
    for(const [name,syms] of Object.entries(SECTORS)){
      const xs=syms.map(s=>arr.find(x=>x.symbol===s)).filter(Boolean); if(xs.length<2)continue;
      sectors[name]={count:xs.length,avg24:avg(xs.map(x=>x.priceChangePercent)),breadth:xs.filter(x=>x.priceChangePercent>0).length/xs.length*100};
    }
    let strongestSector=null;
    const ranked=Object.entries(sectors).sort((a,b)=>b[1].avg24-a[1].avg24);if(ranked[0])strongestSector={name:ranked[0][0],...ranked[0][1],proxy:true};
    return {available:arr.length>0,score,breadth,up,down,median24,avgAbs,btc24:num(btc?.priceChangePercent),eth24:num(eth?.priceChangePercent),btcTrend,ethTrend,btc1h,eth1h,btcDominance:finite(dominance)?dominance:null,regime,riskPenalty,sectors,strongestSector};
  }

  async function fetchGlobalContext(){
    if(ps.global?.ts && now()-ps.global.ts<CACHE_TTL.global)return ps.global;
    try{
      const d=await fetchJSON('/api/radarx-context',{timeout:6000,retries:0});
      ps.global={
        ts:now(),
        btcDominance:num(d?.btcDominance,NaN),
        totalMarketCap:num(d?.totalMarketCapUsd,NaN),
        marketCapChange24h:num(d?.marketCapChange24h,NaN),
        fearGreed:num(d?.fearGreed,NaN),
        fearGreedLabel:d?.fearGreedLabel||null,
        contextSources:d?.availableSources||[],
        contextSourceStatus:d?.sources||{},
        available:d?.ok===true
      };
      if(ps.global.available)return ps.global;
    }catch{}
    try{
      const d=await fetchJSON('https://api.coingecko.com/api/v3/global',{timeout:3500,retries:0});
      const x=d?.data||{};ps.global={...(ps.global||{}),ts:now(),btcDominance:num(x.market_cap_percentage?.btc,NaN),totalMarketCap:num(x.total_market_cap?.usd,NaN),marketCapChange24h:num(x.market_cap_change_percentage_24h_usd,NaN),available:true,contextSources:['coingecko-fallback']};
    }catch{ps.global={...(ps.global||{}),available:false,ts:now()};}
    return ps.global;
  }




  async function refreshSocial(symbols){
    if(ps.lastSocialAt&&now()-ps.lastSocialAt<180000) return {ok:true,cached:true};
    try{
      const q=(symbols||[]).slice(0,8).map(encodeURIComponent).join(',');
      const d=await fetchJSON('/api/radarx-social?symbols='+q,{timeout:9000,retries:0});
      if(d?.ok){
        for(const [symbol,data] of Object.entries(d.socialBySymbol||{})){
          if(data?.available===true&&finite(data.score)){
            ps.external.social.set(symbol,{...data,available:true,source:data.source||'Reddit public RSS'});
          }else ps.external.social.delete(symbol);
        }
        ps.lastSocialAt=now(); ps.socialStatus={ok:true,checkedAt:now(),source:d.source||'Reddit public RSS'};
        return ps.socialStatus;
      }
    }catch{}
    ps.socialStatus={ok:false,checkedAt:now()};
    return ps.socialStatus;
  }

  async function refreshOnchain(symbols){
    if(ps.lastOnchainAt&&now()-ps.lastOnchainAt<300000) return {ok:true,cached:true};
    try{
      const q=(symbols||[]).slice(0,8).map(encodeURIComponent).join(',');
      const d=await fetchJSON('/api/radarx-onchain?symbols='+q,{timeout:9000,retries:0});
      if(d?.ok){
        for(const [symbol,data] of Object.entries(d.onchainBySymbol||{})){
          if(data?.available===true&&finite(data.score)) ps.external.onchain.set(symbol,{...data,available:true,source:data.source||'GeckoTerminal'});
          else ps.external.onchain.delete(symbol);
        }
        for(const [symbol,data] of Object.entries(d.tokenomicsBySymbol||{})){
          if(data?.available===true&&finite(data.score)) ps.external.tokenomics.set(symbol,{...data,available:true,source:data.source||'GeckoTerminal'});
          else ps.external.tokenomics.delete(symbol);
        }
        ps.lastOnchainAt=now();
        ps.onchainStatus={ok:true,checkedAt:now(),source:d.source||'GeckoTerminal'};
        return ps.onchainStatus;
      }
    }catch{}
    ps.onchainStatus={ok:false,checkedAt:now()};
    return ps.onchainStatus;
  }

  async function refreshNews(symbols){
    try{
      const q=(symbols||[]).slice(0,32).map(encodeURIComponent).join(',');
      const d=await fetchJSON('/api/radarx-news?symbols='+q,{timeout:6500,retries:0});
      if(d?.ok){
        ps.news={ok:true,items:Array.isArray(d.items)?d.items:[],checkedAt:num(d.checkedAt,now()),catalystBySymbol:d.catalystBySymbol||{}};
        for(const [symbol,data] of Object.entries(ps.news.catalystBySymbol||{})){
          if(data?.available===true&&finite(data.score)){
            ps.external.catalyst.set(symbol,{...data,available:true,source:'CoinDesk RSS'});
          }else{
            ps.external.catalyst.delete(symbol);
          }
        }
        return ps.news;
      }
    }catch{}
    ps.news={...(ps.news||{}),ok:false};
    return ps.news;
  }
  function newsCatalyst(symbol){
    return ps.news?.catalystBySymbol?.[symbol]||{available:false};
  }
  function sectorFor(symbol){for(const [k,v] of Object.entries(SECTORS))if(v.includes(symbol))return k;return null;}
  function relativeStrength(x,rows,market,sector){
    const tf=technicalFeatures(rows), ret1h=tf?.ret60??null, ret24=num(x.priceChangePercent), btc1h=market?.btc1h, btc24=num(market?.btc24);
    const vsBTC24=ret24-btc24, vsBTC1h=ret1h-btc1h;
    let sec24=null; if(sector)sec24=num(sector.avg24,null);
    const score=clamp(50+vsBTC24*6+(vsBTC1h!=null?vsBTC1h*5:0)+(sec24!=null?(ret24-sec24)*4:0));
    return {available:market?.available===true,score,ret1h,ret24,vsBTC24,vsBTC1h,vsSector24:sec24!=null?ret24-sec24:null,sector:sector?.name||null};
  }

  function flowScore(flow, prev){
    if(!flow)return {available:false};
    const imb=num(flow.imbalance), cvd=num(flow.cvd), bs=num(flow.buySell);
    const spread=(num(flow.ask)-num(flow.bid));
    const deltaImb=prev?imb-num(prev.imbalance):0;
    const score=clamp(50+imb*.6+cvd*.4+(bs>0?Math.log(Math.max(bs,0.25))*15:0)+deltaImb*.35);
    return {available:true,score,imbalance:imb,cvd,buySell:bs,deltaImbalance:deltaImb,bid:num(flow.bid),ask:num(flow.ask),whales:flow.whales||null};
  }

  async function fetchFlow(symbol,provider='binance'){
    const cacheKey=provider+'|'+symbol;
    const c=ps.flow.get(cacheKey); if(c?.ts && now()-c.ts<CACHE_TTL.flow)return c.data;
    try{
      const [d,tr]=await Promise.all([fetchDepth(provider,symbol,80),fetchTrades(provider,symbol,220)]);
      const b=(d.bids||[]).reduce((s,a)=>s+num(a[0])*num(a[1]),0), a=(d.asks||[]).reduce((s,z)=>s+num(z[0])*num(z[1]),0), den=b+a||1;
      const buy=tr.filter(z=>z.buy).reduce((s,z)=>s+num(z.price)*num(z.amount),0), sell=tr.filter(z=>!z.buy).reduce((s,z)=>s+num(z.price)*num(z.amount),0), td=buy+sell||1;
      const mid=(num(d.bids?.[0]?.[0])+num(d.asks?.[0]?.[0]))/2, spreadPct=mid>0?Math.abs(num(d.asks?.[0]?.[0])-num(d.bids?.[0]?.[0]))/mid*100:null;
      const wallBid=Math.max(0,...(d.bids||[]).slice(0,20).map(q=>num(q[0])*num(q[1]))),wallAsk=Math.max(0,...(d.asks||[]).slice(0,20).map(q=>num(q[0])*num(q[1])));
      const data={ts:now(),provider,symbol,imbalance:(b-a)/den*100,bid:b,ask:a,cvm:0,cvd:(buy-sell)/td*100,buySell:sell?buy/sell:0,spreadPct,depthUsd:b+a,wallBid,wallAsk};
      const prior=ps.flow.get(cacheKey)?.data||null;
      ps.flow.set(cacheKey,{ts:now(),data,prev:prior});
      const hist=ps.orderbookHistory.get(cacheKey)||[];hist.push({ts:now(),imbalance:data.imbalance,wallBid,wallAsk,buySell:data.buySell});while(hist.length>12)hist.shift();ps.orderbookHistory.set(cacheKey,hist);
      return data;
    }catch(e){saveLog('flow_error',{symbol,error:String(e?.message||e)});return null;}
  }

  function orderBookDynamic(symbol,flow,provider='binance'){
    const cacheKey=provider+'|'+symbol;
    const h=ps.orderbookHistory.get(cacheKey)||[]; if(!flow||h.length<2)return {available:false};
    const prev=h.at(-2), first=h[0]; const dImb=flow.imbalance-prev.imbalance, windowImb=flow.imbalance-first.imbalance, dWall=(flow.wallBid-flow.wallAsk)-(prev.wallBid-prev.wallAsk), speed=dImb;
    const pressure=clamp(50+flow.imbalance*.42+windowImb*.18+speed*.48+(dWall>0?5:dWall<0?-5:0)+(flow.wallBid>flow.wallAsk?7:-7));
    const spreadPenalty=flow.spreadPct==null?0:clamp(flow.spreadPct*18,0,18);
    return {available:true,score:clamp(pressure-spreadPenalty),imbalance:flow.imbalance,deltaImbalance:dImb,imbalanceSpeed:speed,wallDelta:dWall,spreadPct:flow.spreadPct,depthUsd:flow.depthUsd,liquidityNear:flow.depthUsd};
  }

  async function fetchCrossExchange(symbols){
    if(ps.crossExchange.ts && now()-ps.crossExchange.ts<CACHE_TTL.exchange)return ps.crossExchange;
    const providers=['okx','bybit','gate']; const out={};
    const jobs=providers.map(async p=>({p,data:await fetchAllTickers(p)}));
    const rr=await Promise.allSettled(jobs);
    for(const r of rr){if(r.status!=='fulfilled')continue; const {p,data}=r.value;for(const x of data||[]){if(symbols.includes(x.symbol))out[x.symbol]=out[x.symbol]||{}; if(symbols.includes(x.symbol))out[x.symbol][p]=x;}}
    ps.crossExchange={ts:now(),data:out,available:Object.keys(out).length>0}; return ps.crossExchange;
  }

  function crossScore(symbol,x,cross){
    const row=cross?.data?.[symbol]||{}, vals=Object.values(row).filter(v=>v?.last>0); if(vals.length<2)return {available:false,partial:vals.length>0,exchanges:vals.length};
    const main=x.last, prices=vals.map(v=>v.last), dispersion=avg(prices.map(p=>Math.abs(p/main-1)*100));
    const changes=[num(x.priceChangePercent),...vals.map(v=>num(v.priceChangePercent)).filter(v=>v!==0)];
    const mean=avg(changes), cons=changes.length>1?1-(stdev(changes)/(Math.abs(mean)+1)):1;
    return {available:true,score:clamp(65-dispersion*35+cons*25),exchanges:Object.keys(row).length,priceDispersionPct:dispersion,changeMean:mean,confirmation:clamp(50+cons*50)};
  }

  async function fetchDerivatives(symbol){
    const c=ps.derivatives.get(symbol); if(c?.ts&&now()-c.ts<CACHE_TTL.derivatives)return c.data;
    const base='https://fapi.binance.com';
    async function tryOne(urls){for(const u of urls){try{return await fetchJSON(u,{timeout:3000,retries:0});}catch{}}return null;}
    try{
      const premium=await tryOne([`${base}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`]);
      const oi=await tryOne([`${base}/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`]);
      const hist=await tryOne([`${base}/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=5m&limit=6&contractType=PERPETUAL`,`${base}/futures/data/openInterestHist?pair=${encodeURIComponent(symbol.replace(/USDT$/,'USDT'))}&period=5m&limit=6&contractType=PERPETUAL`]);
      const ls=await tryOne([`${base}/futures/data/globalLongShortAccountRatio?symbol=${encodeURIComponent(symbol)}&period=5m&limit=12&contractType=PERPETUAL`,`${base}/futures/data/globalLongShortAccountRatio?pair=${encodeURIComponent(symbol.replace(/USDT$/,'USDT'))}&period=5m&limit=12&contractType=PERPETUAL`]);
      const top=await tryOne([`${base}/futures/data/topLongShortPositionRatio?symbol=${encodeURIComponent(symbol)}&period=5m&limit=12&contractType=PERPETUAL`,`${base}/futures/data/topLongShortPositionRatio?pair=${encodeURIComponent(symbol.replace(/USDT$/,'USDT'))}&period=5m&limit=12&contractType=PERPETUAL`]);
      const lsArr=Array.isArray(ls)?ls:[], topArr=Array.isArray(top)?top:[], oiArr=Array.isArray(hist)?hist:[];
      const longShort=num(lsArr.at(-1)?.longShortRatio,NaN), prevLs=num(lsArr.at(-2)?.longShortRatio,NaN), oiVal=num(oi?.openInterest,NaN);
      const oiPrev=num(oiArr.at(-2)?.sumOpenInterestValue??oiArr.at(-2)?.sumOpenInterest,NaN), oiHistLast=num(oiArr.at(-1)?.sumOpenInterestValue??oiArr.at(-1)?.sumOpenInterest,NaN);
      const oiChange=finite(oiHistLast)&&finite(oiPrev)&&oiPrev!==0?((oiHistLast/oiPrev)-1)*100:null;
      const lsChange=finite(longShort)&&finite(prevLs)?longShort-prevLs:null;
      const funding=num(premium?.lastFundingRate,NaN);
      const score=clamp(50+(funding>0.0008?7:funding<-0.0008?-7:0)+(oiChange!=null&&oiChange>1?7:oiChange!=null&&oiChange<-1?-6:0)+(lsChange!=null&&lsChange>0.05?6:lsChange!=null&&lsChange<-0.05?-6:0));
      const data={available:finite(oiVal)||finite(funding)||finite(longShort),funding,openInterest:oiVal,oiChangePct:oiChange,longShortRatio:longShort,lsChange,topLongShort:num(topArr.at(-1)?.longShortRatio,NaN),score,source:'Binance Futures public market data',ts:now()};
      ps.derivatives.set(symbol,{ts:now(),data});return data;
    }catch(e){saveLog('derivatives_error',{symbol,error:String(e?.message||e)});return null;}
  }
  function externalScore(map,symbol){
    const x=map?.get(symbol); if(!x||!finite(x.score))return {available:false}; return {...x,available:true};
  }

  // ---------- Persistent Early Pulse ----------
  function pulsePersistence(symbol,rawScore,ts){
    let rec=ps.pulseMemory.get(symbol);
    if(!rec){rec={samples:[],lastTs:0};ps.pulseMemory.set(symbol,rec);}
    if(num(ts)>num(rec.lastTs)){
      rec.samples.push({ts:num(ts),score:clamp(rawScore)});
      if(rec.samples.length>6)rec.samples.splice(0,rec.samples.length-6);
      rec.lastTs=num(ts);
    }
    const recent=rec.samples.slice(-3);
    const persistenceCount=recent.filter(x=>x.score>=68).length;
    const persistenceAvg=avg(recent.map(x=>x.score));
    const rising=recent.length>=2?num(recent.at(-1).score)-num(recent[0].score):0;
    const persistenceScore=clamp(persistenceAvg+Math.max(0,rising)*0.75);
    const effectiveScore=clamp(num(rawScore)*0.72+persistenceScore*0.28);
    return {persistenceCount,persistenceAvg,rising,persistenceScore,effectiveScore,samples:recent.length};
  }

  // ---------- Early Explosion Pulse ----------
  function earlyExplosionPulse(symbol,ticker=null,features=null){
    const tape=state.continuous?.tape?.get(symbol)?.samples||[];
    if(tape.length<6)return {available:false,score:0,reason:'INSUFFICIENT_LIVE_TAPE'};
    const last=tape.at(-1);
    const before=(ms)=>{const target=last.ts-ms;for(let i=tape.length-1;i>=0;i--)if(tape[i].ts<=target)return tape[i];return tape[0]||null;};
    const s10=before(10000),s20=before(20000),s30=before(30000),s60=before(60000);
    if(!s20||!s30)return {available:false,score:0,reason:'INSUFFICIENT_LIVE_WINDOW'};
    const pct=(a,b)=>a?.price>0&&b?.price>0?((b.price/a.price)-1)*100:0;
    const rate=(a,b)=>a&&b&&b.ts>a.ts?Math.max(0,b.quoteVolume-a.quoteVolume)/Math.max(1,(b.ts-a.ts)/1000):0;
    const move10=s10?pct(s10,last):0,move20=pct(s20,last),move30=pct(s30,last),move60=s60?pct(s60,last):move30;
    const rate10=s10?rate(s10,last):0,rate20=rate(s20,last),rate30=rate(s30,last);
    const accelShort=rate20>0?rate10/rate20:1,accelMid=rate30>0?rate20/rate30:1,accelOfAccel=(accelShort-1)+(accelMid-1);
    const bars=state.multiRadar?.klineBars?.get(symbol)||[];let volumeSpike=null,nearHigh=null,rangeCompression=null;
    if(bars.length>=8){
      const cur=bars.at(-1),closed=bars.filter(b=>b.closed&&b.q>0&&b.t!==cur?.t).slice(-20);
      if(cur?.q>0&&closed.length>=8){const avgQ=closed.reduce((a,b)=>a+num(b.q),0)/closed.length;const elapsed=cur.closed?60:Math.max(10,Math.min(60,(Date.now()-num(cur.t,Date.now()))/1000));if(avgQ>0)volumeSpike=num(cur.q)/(avgQ*(elapsed/60));}
      const high=Math.max(...bars.slice(-12).map(b=>num(b.h,0)).filter(v=>v>0));
      nearHigh=high>0&&last.price>0?clamp(100-Math.max(0,(high-last.price)/last.price*100)*55,0,100):null;
      const ranges=bars.slice(-6).map(b=>b.c>0?(b.h-b.l)/b.c*100:0).filter(v=>v>0);const prev=bars.slice(-20,-6).map(b=>b.c>0?(b.h-b.l)/b.c*100:0).filter(v=>v>0);
      if(ranges.length>=3&&prev.length>=5){const rr=avg(ranges)/(avg(prev)||1);rangeCompression=clamp(100-rr*72,0,100);}
    }
    const compression=clamp(num(features?.compression?.score,50)),structure=clamp(num(features?.pressure,50)),volBase=clamp(num(features?.volume?.score,50)),trend=clamp(num(features?.trendScore,50));
    const positiveMove=clamp(50+move10*120+move20*75+move30*45,0,100);
    const accelerationScore=clamp(50+(accelShort-1)*55+(accelMid-1)*35+(accelOfAccel>0.20?8:0),0,100);
    const volumeScore=volumeSpike==null?volBase:clamp(45+(volumeSpike-1)*34,0,100);
    const proximity=nearHigh==null?structure:nearHigh;
    const squeeze=rangeCompression==null?compression:clamp(rangeCompression*.55+compression*.45,0,100);
    const move24=num(ticker?.priceChangePercent,0),exhaustionPenalty=move24>10?Math.min(20,(move24-10)*2.2):0,reversalPenalty=(move10<-.12&&move30<-.18)?10:0;
    const rawScore=clamp(positiveMove*.25+accelerationScore*.24+volumeScore*.20+squeeze*.12+proximity*.10+trend*.09-exhaustionPenalty-reversalPenalty);
    const persist=pulsePersistence(symbol,rawScore,last.ts),score=persist.effectiveScore;
    return {available:true,score,rawScore,persistenceCount:persist.persistenceCount,persistenceAvg:persist.persistenceAvg,rising:persist.rising,persistenceScore:persist.persistenceScore,move10s:move10,move20s:move20,move30s:move30,move60s:move60,rate10s:rate10,rate20s:rate20,rate30s:rate30,accelShort,accelMid,accelOfAccel,volumeSpike,nearHigh,rangeCompression,exhaustionPenalty,reversalPenalty,ts:last.ts};
  }
  function stageScore(features,context){
    const f=features, m=context.market, flow=context.flowScore, ob=context.orderBook, cross=context.cross, deriv=context.derivatives, rel=context.relative, pulse=context.earlyPulse;
    const rangeNearResistance=f.structure.distResistance!=null&&f.structure.distResistance>=-0.5&&f.structure.distResistance<=2.4;
    const relBoost=rel?.available ? (rel.score-50)*.35 : 0;
    const pulseBoost=pulse?.available ? (pulse.score-50)*.28 : 0;
    const pre = clamp(45 + (f.compression.score*.22) + (f.volume.acceleration>=1?10:0) + (rangeNearResistance?14:0) + relBoost + pulseBoost + (f.vwapScore>55?8:0) + (f.trendScore>55?6:0) + (pulse?.accelOfAccel>0.20?5:0) - (f.phase==='EXHAUSTED_LATE'?16:0));
    const breakout=clamp(45 + (f.structure.breakout?22:0) + (f.volume.rvol>=1.35?12:0) + (f.closePos>.7?7:0) + (f.priceStructureScore>65?8:0) + (flow?.score?((flow.score-50)*.18):0) + (ob?.score?((ob.score-50)*.12):0));
    const market=m?.score??null;
    const price={available:true,score:f.priceStructureScore};
    const comp={available:true,score:f.compression.score};
    const vol={available:true,score:f.volume.score};
    const q=num(context.ticker.quoteVolume,NaN), depth=num(ob?.depthUsd,NaN); const liqScore=finite(q)?clamp(28+Math.min(42,Math.log10(Math.max(q,1))*4.8)+(finite(depth)?Math.min(25,Math.log10(Math.max(depth,1))*4):0)-(context.ticker.spreadPct>0.15?8:0),0,100):null; const liq={available:liqScore!=null,score:liqScore};
    const parts={
      market:{available:!!m?.available&&market!=null,score:market==null?null:clamp(market)},
      structure:price,
      compression:comp,
      volume:vol,
      relative:rel||{available:false},
      liquidity:liq,
      orderbook:ob||{available:false},
      orderflow:flow||{available:false},
      mtf:context.mtf||{available:false},
      derivatives:deriv||{available:false},
      crossExchange:cross||{available:false},
      sector:context.sector||{available:false},
      catalyst:externalScore(ps.external.catalyst,f.symbol),
      social:externalScore(ps.external.social,f.symbol),
      onchain:externalScore(ps.external.onchain,f.symbol),
      tokenomics:externalScore(ps.external.tokenomics,f.symbol),
    };
    let wres=weightedScore(parts);
    const coreAligned=(f.compression.score>=55?1:0)+(f.volume.acceleration>=1.12?1:0)+(rangeNearResistance?1:0)+(rel?.available&&rel.score>=60?1:0)+(f.priceStructureScore>=58?1:0)+(f.vwapScore>=55?1:0)+(context.mtf?.available&&context.mtf.score>=60?1:0);
    const conflict=(f.trap>=55?1:0)+(f.divergence?.bear?1:0)+(context.market?.regime==='TREND_BEAR'?1:0)+(deriv?.funding>0.0015?1:0);
    const confluence=Math.round(clamp(coreAligned/7*100-conflict*10));
    let phase=f.phase;
    if(f.trap>=68)phase='HIGH_RISK_FALSE_BREAKOUT';
    else if(phase==='BREAKOUT' && num(context.ticker.priceChangePercent)>PRO.exhaustedMove24h)phase='EXHAUSTED_LATE';
    else if(phase==='NORMAL'&&pre>=PRO.preThreshold&&num(context.ticker.priceChangePercent)<=PRO.maxPreMove24h)phase='PRE_BREAKOUT';
    else if(phase==='NORMAL'&&pre>=55)phase='BUILDING';
    const persistentPulse=pulse?.available&&(num(pulse.persistenceCount,0)>=2||num(pulse.rawScore,0)>=82);
    if(persistentPulse&&pulse.score>=74&&pulse.accelShort>=1.10&&pulse.move60s<=3.5&&num(context.ticker?.priceChangePercent,0)<=PRO.maxPreMove24h&&f.compression.score>=50&&phase!=='BREAKOUT'&&phase!=='EXHAUSTED_LATE') phase='PRE_BREAKOUT';
    if(m?.regime==='TREND_BEAR'&&phase==='PRE_BREAKOUT')wres.score=Math.min(wres.score,72);
    const globalPenalty=finite(context.global?.btcDominance)&&context.global.btcDominance>62?4:0;
    const confluenceMultiplier=.70+.30*(confluence/100);
    let score=clamp(wres.score*confluenceMultiplier-globalPenalty);
    if(confluence<35)score=clamp(score-8);
    return {score,preScore:pre,breakoutScore:breakout,coverage:wres.coverage,confluence,phase,parts,coreAligned,conflict};
  }

  function mtfScore(frames){
    const keys=['4h','1h','15m','5m']; const got=keys.filter(k=>frames[k]); if(!got.length)return {available:false};
    const scores=[];let bull=0,bear=0,pressure=0,comp=0;
    for(const k of got){const f=technicalFeatures(frames[k]);if(!f)continue;const wt=k==='4h'?1.5:k==='1h'?1.25:k==='15m'?1:.75;const s=f.trendScore*.55+f.priceStructureScore*.25+f.vwapScore*.20;scores.push(s*wt);if(f.trendScore>=55)bull+=wt;else if(f.trendScore<=45)bear+=wt;if(f.structure.distResistance!=null&&f.structure.distResistance<=2.2)pressure+=wt;if(f.compression.score>=50)comp+=wt;}
    const denom=got.reduce((a,k)=>a+(k==='4h'?1.5:k==='1h'?1.25:k==='15m'?1:.75),0)||1;
    const score=clamp(avg(scores)*(1));
    const align=Math.max(bull,bear)/denom;
    return {available:true,score,alignment:align,bullRatio:bull/denom,bearRatio:bear/denom,pressureRatio:pressure/denom,compressionRatio:comp/denom,frames:got};
  }

  function explanations(x){
    const lang=state.lang||'ar';
    const reasons=[], risks=[];
    const f=x.features, p=x.pro;
    const push=(en,aa)=>reasons.push(lang==='ar'?aa:en);
    const risk=(en,aa)=>risks.push(lang==='ar'?aa:en);
    if(f.compression.score>=55)push('Compression is elevated','ضغط/انكماش سعري واضح قبل التوسع');
    if(f.patterns?.patterns?.length)push('Contextual pattern: '+f.patterns.patterns[0],'نمط سعري سياقي: '+f.patterns.patterns[0]);
    if(f.trendScore>=60)push('Trend structure is aligned','هيكل الاتجاه متوافق صعوديًا');
    if(f.volume.acceleration>=1.2)push('Volume acceleration','تسارع حقيقي في معدل الحجم');
    else if(f.volume.rvol>=1.3)push('Relative volume is above baseline','الحجم النسبي أعلى من خط الأساس');
    if(x.earlyPulse?.available&&x.earlyPulse?.persistenceCount>=2)push('Early pulse persists across multiple live samples','نبضة مبكرة متكررة عبر عدة عينات حية');
    else if(x.earlyPulse?.available&&x.earlyPulse?.rawScore>=82)push('Early pulse is exceptionally strong','النبضة المبكرة قوية بشكل استثنائي');
    if(x.relative?.score>=60)push('Relative strength vs market','قوة نسبية أمام السوق');
    if(f.structure.distResistance!=null&&f.structure.distResistance>=-0.5&&f.structure.distResistance<=2.2)push('Resistance pressure','ضغط سعري قريب من المقاومة');
    if(f.vwapScore>=60)push('Price holds above VWAP','السعر متماسك فوق VWAP');
    if(x.mtf?.alignment>=.75)push('Multi-timeframe alignment','توافق قوي بين الأطر الزمنية');
    if(x.flow?.score>=60)push('Spot order flow confirms','تدفق صفقات/دلتا داعم');
    if(x.orderBook?.score>=60)push('Order book demand pressure','ضغط طلب ديناميكي في دفتر الأوامر');
    if(x.cross?.score>=65)push('Cross-exchange confirmation','الحركة مؤكدة عبر عدة منصات');
    if(x.market?.regime==='TREND_BULL')push('Broad market trend supports risk-on conditions','اتجاه السوق العام داعم للمخاطرة');
    if(x.market?.breadth>=60)push('Market breadth is positive','اتساع السوق إيجابي');
    if(x.derivatives?.funding>0.001)risk('Funding is elevated','Funding مرتفع نسبيًا');
    if(f.structure.distResistance!=null&&f.structure.distResistance<0)risk('Price already cleared resistance','السعر تجاوز المقاومة بالفعل');
    if(f.structure.rangePct>12)risk('Range is already wide','النطاق السعري واسع بالفعل');
    if(x.orderBook?.spreadPct>0.18)risk('Spread is elevated','السبريد مرتفع نسبيًا');
    if(x.market?.regime==='TREND_BEAR')risk('Broad market is bearish','اتجاه السوق العام هابط');
    if(f.divergence?.bear)risk('Bearish RSI divergence','انحراف RSI هابط');
    return {reasons:reasons.slice(0,7),risks:risks.slice(0,5)};
  }

  async function buildCandidate(x,marketCtx,globalCtx,cross){
    const symbol=x.symbol, provider=x.provider||'binance', start=performance.now();
    const f5=await getKlines(symbol,'5m',provider); if(!f5?.length)return null;
    f5.__ticker24h=num(x.priceChangePercent); const f=technicalFeatures(f5); f.symbol=symbol;
    const secName=sectorFor(symbol); const sec=secName?marketCtx.sectors?.[secName]:null;
    const relative=relativeStrength(x,f5,marketCtx,sec?{name:secName,...sec}:null);
    const pulse=earlyExplosionPulse(symbol,x,f);
    const preContext={ticker:x,market:marketCtx,global:globalCtx,relative,earlyPulse:pulse,sector:sec?{available:true,score:clamp(50+(sec.avg24-marketCtx.median24)*8),name:secName}:null,mtf:null,flow:null,flowScore:null,orderBook:null,derivatives:null,cross:crossScore(symbol,x,cross)};
    let pro=stageScore(f,preContext);
    return {...x,features:f,earlyPulse:pulse,relative,market:marketCtx,global:globalCtx,pro,mtf:null,flow:null,orderBook:null,derivatives:null,cross:preContext.cross,sector:secName,latencyMs:Math.round(performance.now()-start)};
  }

  const klineCache = new Map();
  async function getKlines(symbol,tf,provider='binance'){
    const key=`${provider}|${symbol}|${tf}`, c=klineCache.get(key);if(c?.ts&&now()-c.ts<CACHE_TTL.kline)return c.rows;
    const rows=await fetchKlines(provider,symbol,tf,PRO.klineLimit[tf]||100);
    if(rows?.length){klineCache.set(key,{ts:now(),rows}); ps.klines.set(key,{ts:now(),rows}); return rows;} return c?.rows||null;
  }

  async function enrichCandidate(x,idx){
    const symbol=x.symbol;
    const frameKeys=['4h','1h','15m','5m'];
    const provider=x.provider||'binance';
    const other=await Promise.all(frameKeys.slice(0,3).map(async tf=>[tf,await getKlines(symbol,tf,provider).catch(()=>null)]));
    const frames={ '5m': x.features ? x.features.last ? await getKlines(symbol,'5m',provider).catch(()=>null) : null : null };
    for(const [k,r] of other)frames[k]=r;
    if(!frames['5m'])frames['5m']=await getKlines(symbol,'5m',provider).catch(()=>null);
    x.mtf=mtfScore(frames);
    const useFlow=idx<PRO.flowCandidates;
    if(useFlow){
      const flow=await fetchFlow(symbol,provider); x.flow=flow; x.orderBook=orderBookDynamic(symbol,flow,provider); x.flowScore=flowScore(flow,ps.flow.get(provider+'|'+symbol)?.prev); 
    }
    if(idx<PRO.derivativeCandidates)x.derivatives=await fetchDerivatives(symbol);
    const context={ticker:x,market:x.market,global:x.global,relative:x.relative,earlyPulse:x.earlyPulse||earlyExplosionPulse(symbol,x,x.features),sector:x.sector?{available:true,name:x.sector,score:clamp(50+(num(x.market?.sectors?.[x.sector]?.avg24)-num(x.market?.median24))*8)}:null,mtf:x.mtf,flow:x.flowScore,orderBook:x.orderBook,derivatives:x.derivatives,cross:x.cross};
    x.pro=stageScore(x.features,context);
    x.explain=explanations({...x,...context});
    x.pro.latencyMs=x.latencyMs;
    return x;
  }

  function candidateSort(a,b){
    const pa=a.pro?.phase, pb=b.pro?.phase; const phaseW={'PRE_BREAKOUT':1.25,'BREAKOUT':1.18,'BUILDING':1.10,'EXHAUSTED_LATE':.82,'HIGH_RISK_FALSE_BREAKOUT':.55,'NORMAL':1};
    return ((b.pro?.score||0)*(phaseW[pb]||1))-((a.pro?.score||0)*(phaseW[pa]||1)) || (b.pro?.preScore||0)-(a.pro?.preScore||0) || (b.earlyPulse?.score||0)-(a.earlyPulse?.score||0);
  }

  function phaseLabel(p){
    const ar=state.lang==='ar'; return ({NORMAL:ar?'🟢 NORMAL':'🟢 NORMAL',BUILDING:ar?'🟡 BUILDING':'🟡 BUILDING',PRE_BREAKOUT:ar?'🟠 PRE-BREAKOUT':'🟠 PRE-BREAKOUT',BREAKOUT:ar?'🔴 BREAKOUT':'🔴 BREAKOUT',EXHAUSTED_LATE:ar?'⚠️ EXHAUSTED / LATE':'⚠️ EXHAUSTED / LATE',HIGH_RISK_FALSE_BREAKOUT:ar?'❌ FALSE BREAKOUT / HIGH RISK':'❌ FALSE BREAKOUT / HIGH RISK'})[p]||p;
  }
  function scoreClass(s){return s>=78?'score-high':s>=66?'score-mid':'score-low';}

  function render(){
    const host=$('proRadarGrid'); if(!host)return;
    const rows=(ps.candidates||[]).slice(0,8);
    if(!rows.length){host.innerHTML=`<div class="pro-empty">📡 ${state.lang==='ar'?'بانتظار بيانات السوق الحقيقية لبناء الرادار المتعدد الطبقات.':'Waiting for real market data to build the multi-layer radar.'}</div>`; return;}
    host.innerHTML=rows.map((x,i)=>{
      const f=x.features||{}, p=x.pro||{}, flow=x.flowScore||{}, ob=x.orderBook||{}, d=x.derivatives||{}, tok=externalScore(ps.external.tokenomics,x.symbol), chain=externalScore(ps.external.onchain,x.symbol), social=externalScore(ps.external.social,x.symbol);
      const reasons=(x.explain?.reasons||[]).map(r=>`<span class="pro-chip good">+ ${esc(r)}</span>`).join('');
      const risks=(x.explain?.risks||[]).map(r=>`<span class="pro-chip risk">− ${esc(r)}</span>`).join('');
      return `<article class="pro-card" data-pro-symbol="${esc(x.symbol)}">
        <div class="pro-card-head"><div><span class="pro-rank">#${i+1}</span><b class="pro-symbol">${esc(x.symbol)}</b><span class="pro-phase">${phaseLabel(p.phase)}</span><small>${p.coverage!=null?`Coverage ${Math.round(p.coverage*100)}%`:''}</small></div><div class="pro-score ${scoreClass(p.score)}">${Math.round(p.score)}<small>/100</small></div></div>
        <div class="pro-price-row"><b>${fmtLocal(x.last)}</b><span class="${x.priceChangePercent>=0?'gain':'loss'}">${pctLocal(x.priceChangePercent)}</span><span class="pro-source">${esc(String(x.provider||'BINANCE').toUpperCase())}</span></div>\n        <div class="pro-price-row" style="margin-top:4px"><span>⚡ Early Pulse</span><b>${x.earlyPulse?.available?Math.round(x.earlyPulse.score):'N/A'}/100</b><span>${x.earlyPulse?.move30s!=null?(x.earlyPulse.move30s>=0?' +':'')+x.earlyPulse.move30s.toFixed(2)+'% / 30s':'—'}</span><span>${x.earlyPulse?.volumeSpike!=null?x.earlyPulse.volumeSpike.toFixed(2)+'× vol':'—'}</span><span>${x.earlyPulse?.available?`Persist ${x.earlyPulse.persistenceCount||0}/3 · Raw ${Math.round(x.earlyPulse.rawScore||0)}`:'—'}</span></div>
        <div class="pro-metric-grid"><div><span>24h Vol</span><b>${x.quoteVolume!=null?fmtLocal(x.quoteVolume):'N/A'}</b></div><div><span>24h</span><b>${pctLocal(x.priceChangePercent)}</b></div><div><span>Mkt Cap</span><b>${tok.marketCapUsd!=null?fmtLocal(tok.marketCapUsd):'N/A'}</b></div><div><span>Liquidity</span><b>${p.parts?.liquidity?.available?Math.round(p.parts.liquidity.score):'N/A'}</b></div><div><span>RVOL</span><b>${f.volume?.rvol!=null?f.volume.rvol.toFixed(2)+'×':'N/A'}</b></div><div><span>Vol Acc</span><b>${f.volume?.acceleration!=null?f.volume.acceleration.toFixed(2)+'×':'N/A'}</b></div><div><span>RSI</span><b>${f.rsi!=null?f.rsi.toFixed(1):'N/A'}</b></div><div><span>ATR</span><b>${f.atrPct!=null?f.atrPct.toFixed(2)+'%':'N/A'}</b></div><div><span>BB Width</span><b>${f.compression?.bbWidth!=null?f.compression.bbWidth.toFixed(2)+'%':'N/A'}</b></div><div><span>VWAP</span><b>${f.priceVsVwap!=null?pctLocal(f.priceVsVwap):'N/A'}</b></div><div><span>RS</span><b>${x.relative?.score!=null?Math.round(x.relative.score):'N/A'}</b></div><div><span>vs BTC</span><b>${x.relative?.vsBTC24!=null?pctLocal(x.relative.vsBTC24):'N/A'}</b></div><div><span>Breakout</span><b>${f.structure?.distResistance!=null?pctLocal(-f.structure.distResistance):'N/A'}</b></div><div><span>Trend</span><b>${f.trendScore!=null?Math.round(f.trendScore):'N/A'}</b></div><div><span>OI</span><b>${d.openInterest!=null?fmtLocal(d.openInterest):'N/A'}</b></div><div><span>OI Δ</span><b>${d.oiChangePct!=null?pctLocal(d.oiChangePct):'N/A'}</b></div><div><span>Funding</span><b>${d.funding!=null?(d.funding*100).toFixed(4)+'%':'N/A'}</b></div></div>
        <div class="pro-provider-row"><span>Catalyst <b>${externalScore(ps.external.catalyst,x.symbol).available?'LIVE':'N/A'}</b></span><span>Social <b>${social.available?'LIVE':'N/A'}</b></span><span>On-chain <b>${chain.available?'LIVE':'N/A'}</b></span><span>Tokenomics <b>${tok.available?'LIVE':'N/A'}</b></span></div><div class="pro-bars"><div><span>Confluence</span><i><em style="width:${clamp(p.confluence||0)}%"></em></i><b>${Math.round(p.confluence||0)}</b></div><div><span>MTF</span><i><em style="width:${x.mtf?.score!=null?clamp(x.mtf.score):0}%"></em></i><b>${x.mtf?.score!=null?Math.round(x.mtf.score):'N/A'}</b></div><div><span>Flow</span><i><em style="width:${flow.score!=null?clamp(flow.score):0}%"></em></i><b>${flow.score!=null?Math.round(flow.score):'N/A'}</b></div></div>
        <div class="pro-evidence"><strong>${state.lang==='ar'?'الأسباب':'Evidence'}</strong>${reasons||`<span class="pro-chip">${state.lang==='ar'?'أدلة غير كافية بعد':'Evidence not sufficient yet'}</span>`}</div>
        <div class="pro-evidence"><strong>${state.lang==='ar'?'المخاطر':'Risks'}</strong>${risks||`<span class="pro-chip">${state.lang==='ar'?'لا يوجد تعارض رئيسي مسجل':'No major recorded conflict'}</span>`}</div>
        <div class="pro-card-foot"><span>${phaseLabel(p.phase)}</span><span>${x.latencyMs||0}ms</span><button class="btn ghost" data-pro-deep="${esc(x.symbol)}">🔬 ${state.lang==='ar'?'تحليل أعمق':'Deep analyze'}</button></div>
      </article>`;
    }).join('');
    updateProMeta();
  }
  function fmtLocal(x){const v=num(x);if(!v)return '—';if(Math.abs(v)>=1000)return v.toLocaleString('en-US',{maximumFractionDigits:2});if(Math.abs(v)>=1)return v.toLocaleString('en-US',{maximumFractionDigits:6});return v.toPrecision(6);}
  function pctLocal(x){const v=num(x);return `${v>=0?'+':''}${v.toFixed(2)}%`;}
  function esc(x){return String(x??'').replace(/[&<>\'"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[m]));}
  function updateProMeta(){const meta=$('proRadarMeta');if(!meta)return;const r=ps.regime; const age=ps.lastGoodCycleAt?Math.max(0,Math.floor((Date.now()-ps.lastGoodCycleAt)/1000)):null;meta.textContent=r?`${r.regime} · Breadth ${Math.round(r.breadth)}% · ${r.up}↑/${r.down}↓ · ${age!=null?`${age}s`:''} · ${ps.source.toUpperCase()}`:`${ps.source.toUpperCase()}`; const dom=$('proRadarDominance');if(dom)dom.textContent=ps.global?.btcDominance!=null?`BTC.D ${ps.global.btcDominance.toFixed(2)}%`:'BTC.D N/A'; const sec=$('proRadarSector');if(sec)sec.textContent=r?.strongestSector?`${state.lang==='ar'?'قطاع نشط':'Sector'}: ${r.strongestSector.name}${r.strongestSector.proxy?' · proxy':''}`:'Sector: N/A';}

  function chooseCandidates(markets){
    const pulseLight=(symbol)=>{
      const samples=state.continuous?.tape?.get(symbol)?.samples||[]; if(samples.length<5)return 0;
      const last=samples.at(-1),find=(ms)=>{const target=last.ts-ms;for(let i=samples.length-1;i>=0;i--)if(samples[i].ts<=target)return samples[i];return samples[0];};
      const s15=find(15000),s30=find(30000),s60=find(60000);
      const mv15=s15?.price>0?((last.price/s15.price)-1)*100:0,mv30=s30?.price>0?((last.price/s30.price)-1)*100:0,mv60=s60?.price>0?((last.price/s60.price)-1)*100:mv30;
      const rate=(a,b)=>a&&b&&b.ts>a.ts?Math.max(0,b.quoteVolume-a.quoteVolume)/Math.max(1,(b.ts-a.ts)/1000):0;
      const r15=rate(s15,last),r30=rate(s30,last),acc=r30>0?r15/r30:1;
      return Math.max(0,mv15)*32+Math.max(0,mv30)*18+Math.max(0,mv60)*8+Math.max(0,acc-1)*22;
    };
    return markets.filter(eligibleTicker).map(x=>({...x,_earlyPulseLight:pulseLight(x.symbol),_candidate:(Math.max(-2,Math.min(12,num(x.priceChangePercent)))*1.6)+(Math.log10(Math.max(1,num(x.quoteVolume)))-6)*4+pulseLight(x.symbol)})).sort((a,b)=>b._candidate-a._candidate).slice(0,PRO.initialCandidates);
  }

  async function runCycle(){
    if(ps.running || !premiumIsUnlocked())return;
    ps.running=true; ps.lastCycleAt=now(); ps.source='running'; const started=performance.now();
    try{
      const cachedRows=Object.values(state.marketsBySymbol||{});
      const freshRows=cachedRows.filter(x=>{
        const ts=num(x?.receivedAt??x?.eventTime,0);
        return x?.last>0 && ts>0 && now()-ts>=0 && now()-ts<=20000;
      });
      let markets=freshRows.length>=50?freshRows:[];
      if(markets.length<50){
        try{markets=await (fetchAllTickersResilient?fetchAllTickersResilient('binance'):fetchAllTickers('binance'));}catch{}
        if(markets.length<50){
          for(const p of ['okx','bybit','gate']){
            try{const alt=await fetchAllTickers(p);if(alt.length){markets=alt;break;}}catch{}
          }
        }
      }
      if(!markets?.length)throw new Error('NO_MARKET_DATA');
      const normalized=markets.filter(eligibleTicker); if(!normalized.length)throw new Error('NO_ELIGIBLE_TICKERS');
      const [btcRows,ethRows,global]=await Promise.all([
        getKlines('BTCUSDT','1h').catch(()=>null),getKlines('ETHUSDT','1h').catch(()=>null),fetchGlobalContext()
      ]);
      const regime=marketRegime(normalized,btcRows,ethRows,global); ps.regime=regime; ps.global=global;
      const symbols=chooseCandidates(normalized).map(x=>x.symbol);
      // External evidence is independent. Refresh it concurrently so a slow
      // provider never serializes the entire intelligence cycle.
      const fingerprint=symbols.slice(0,PRO.mtfCandidates).join('|');
      const crossAge=now()-num(ps.lastCrossAt,0);
      const crossPromise=crossAge<150000&&ps.crossExchange?.data
        ?Promise.resolve(ps.crossExchange)
        :fetchCrossExchange(symbols).catch(()=>({available:false,data:{}}));
      const [newsResult,onchainResult,socialResult,cross]=await Promise.all([
        refreshNews(symbols).catch(()=>null),
        refreshOnchain(symbols).catch(()=>null),
        refreshSocial(symbols).catch(()=>null),
        crossPromise
      ]);
      if(cross?.available)ps.lastCrossAt=now();
      const candidates=[];
      for(let i=0;i<symbols.length;i+=3){
        const batch=symbols.slice(i,i+3).map(s=>normalized.find(x=>x.symbol===s)).filter(Boolean);
        const rr=await Promise.allSettled(batch.map(x=>buildCandidate(x,regime,global,cross)));
        rr.forEach(v=>{if(v.status==='fulfilled'&&v.value)candidates.push(v.value);});
        await yieldToBrowser();
      }
      candidates.sort((a,b)=>(b.pro?.preScore||0)-(a.pro?.preScore||0));
      const enrichFingerprint=candidates.slice(0,PRO.mtfCandidates).map(x=>`${x.symbol}:${Math.round(x.pro?.preScore||0)}`).join('|');
      const enrichDue=now()-num(ps.lastEnrichAt,0)>=num(PRO.evidenceRefreshMs,30000) || enrichFingerprint!==ps.lastEnrichFingerprint || !ps.candidates.length;
      if(enrichDue){
        for(let i=0;i<Math.min(PRO.mtfCandidates,candidates.length);i+=2){
          const rr=await Promise.allSettled(candidates.slice(i,i+2).map((x,j)=>enrichCandidate(x,i+j)));
          rr.forEach(v=>{if(v.status==='fulfilled'&&v.value){const at=candidates.findIndex(c=>c.symbol===v.value.symbol);if(at>=0)candidates[at]=v.value;}});
          await yieldToBrowser();
        }
        ps.lastEnrichFingerprint=enrichFingerprint; ps.lastEnrichAt=now();
      } else {
        const prior=new Map((ps.candidates||[]).map(x=>[x.symbol,x]));
        candidates.forEach((x,i)=>{const old=prior.get(x.symbol);if(old){const pulse=earlyExplosionPulse(x.symbol,x,old.features);const context={ticker:x,market:x.market,global:x.global,relative:old.relative,earlyPulse:pulse,sector:x.sector?{available:true,name:x.sector,score:clamp(50+(num(x.market?.sectors?.[x.sector]?.avg24)-num(x.market?.median24))*8)}:null,mtf:old.mtf,flow:old.flowScore,orderBook:old.orderBook,derivatives:old.derivatives,cross:x.cross};candidates[i]={...old,...x,features:old.features,relative:old.relative,earlyPulse:pulse,mtf:old.mtf,flow:old.flow,flowScore:old.flowScore,orderBook:old.orderBook,derivatives:old.derivatives,pro:stageScore(old.features,context),explain:explanations({...old,...x,...context})};}});
      }
      candidates.sort(candidateSort);
      ps.candidates=candidates.slice(0,10); ps.latencyMs=Math.round(performance.now()-started); ps.lastGoodCycleAt=now(); ps.source='live'; ps.lastError='';
      state.proEngine.lastUpdated=now();
      render(); updateDashboardKpis(); await emitAlerts(ps.candidates);
      saveLog('cycle',{count:ps.candidates.length,latencyMs:ps.latencyMs,regime:regime.regime});
    }catch(e){ps.lastError=String(e?.message||e);ps.source=Object.keys(state.marketsBySymbol||{}).length?'cached':'offline';saveLog('cycle_error',{error:ps.lastError});updateProMeta();}
    finally{ps.running=false;}
  }

  function updateDashboardKpis(){
    const pre=ps.candidates.filter(x=>['PRE_BREAKOUT','BUILDING'].includes(x.pro?.phase));
    if($('dashCandidates'))$('dashCandidates').textContent=String(ps.candidates.length);
    if($('dashEarly'))$('dashEarly').textContent=String(pre.length);
    if($('dashTop'))$('dashTop').textContent=ps.candidates[0]?ps.candidates[0].symbol:'—';
    if($('dashTopFoot'))$('dashTopFoot').textContent=ps.candidates[0]?`${Math.round(ps.candidates[0].pro.score)}/100 · ${phaseLabel(ps.candidates[0].pro.phase)}`:'—';
    if($('dashUniverse'))$('dashUniverse').textContent=Object.keys(state.marketsBySymbol||{}).length.toLocaleString('en-US');
  }

  async function emitAlerts(rows){
    const n=now();
    for(const x of rows.slice(0,8)){
      const phase=x.pro?.phase;
      const trap=num(x.features?.trap,100);
      const score=num(x.pro?.score,0);
      const coverage=num(x.pro?.coverage,0);
      if(!['BUILDING','PRE_BREAKOUT','BREAKOUT'].includes(phase))continue;
      if(!(trap<35 && score>=70 && coverage>=0.55))continue;
      if(phase==='PRE_BREAKOUT'&&!(x.earlyPulse?.available&&(num(x.earlyPulse.persistenceCount,0)>=2||num(x.earlyPulse.rawScore,0)>=82)))continue;
      const last=ps.alerts.get(x.symbol);
      if(last&&last.phase===phase&&n-last.ts<20*60e3)continue;
      ps.alerts.set(x.symbol,{phase,ts:n,score,trap,coverage});
      const title=`RadarX ${phase.replaceAll('_',' ')}`;
      const body=`${x.symbol} · Score ${Math.round(score)}/100 · Trap ${Math.round(trap)}/100 · Coverage ${Math.round(coverage*100)}%`;
      try{notifyUser(title,body);}catch{} try{toast(`${title} · ${body}`);}catch{}
      saveLog('alert',{symbol:x.symbol,phase,score,trap,coverage});
    }
  }

  async function historicalKlines(symbol,tf,limit=4000,provider='binance'){
    const target=Math.min(12000,Math.max(500,limit)); const out=[]; let endTime=Date.now(), pages=0;
    // Historical research must use the same provider family as the live candidate.
    // Binance supports deep pagination; other public spot providers are intentionally
    // limited to their documented candle windows rather than silently mixing sources.
    if(provider!=='binance'){
      try{
        const rows=await fetchKlines(provider,symbol,tf,Math.min(1000,target));
        return Array.isArray(rows)?rows.slice(-target):[];
      }catch{return [];}
    }
    while(out.length<target && pages<13){
      const take=Math.min(1000,target-out.length);
      const path=`/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(tf)}&limit=${take}&endTime=${endTime}`;
      const urls=binanceUrlsForResearch(path);
      let d; try{d=await CORE.firstJSONRace(urls,{timeout:5000,retries:0,maxUrls:Math.min(4,urls.length)});}catch{break;}
      const page=(Array.isArray(d)?d:[]).map(r=>({t:num(r[0]),o:num(r[1]),h:num(r[2]),l:num(r[3]),c:num(r[4]),v:num(r[5]),q:num(r[7]),trades:num(r[8]),tb:num(r[9]),closed:true})).filter(r=>r.t>0);
      if(!page.length)break;
      out.unshift(...page); const firstTs=page[0].t; if(!(firstTs<endTime))break; endTime=firstTs-1; pages++; if(page.length<take)break;
    }
    const map=new Map(); out.sort((a,b)=>a.t-b.t).forEach(r=>map.set(r.t,r)); return [...map.values()].slice(-target);
  }
  function binanceUrlsForResearch(path){
    return [`/api/binance?path=${encodeURIComponent(path)}`,...['https://data-api.binance.vision','https://api.binance.com','https://api-gcp.binance.com'].map(base=>base+path)];
  }
  function historicalLiquidityScore(rows,i){
    const vals=rows.slice(Math.max(0,i-35),i+1).map(x=>num(x.q??x.v,NaN)).filter(finite);
    if(vals.length<12)return {available:false};
    const cur=vals.at(-1), base=avg(vals.slice(0,-1)); if(!(cur>0&&base>0))return {available:false};
    const s=clamp(50+Math.log(cur/base)*28); return {available:true,score:s};
  }
  // ---------- Historical Early Pulse Calibration ----------
  function historicalPulseRawAt(rows,i){
    if(!Array.isArray(rows)||i<14||!rows[i])return null;
    const cur=rows[i],b1=rows[i-1],b2=rows[i-2],b3=rows[i-3],b5=rows[i-5],px=num(cur.c,0);
    if(!(px>0&&b5?.c>0))return null;
    const pct=(a,b)=>a?.c>0&&b?.c>0?((b.c/a.c)-1)*100:0;
    const move1=pct(b1,cur),move2=pct(b2,cur),move3=pct(b3,cur),move5=pct(b5,cur);
    const q=k=>Math.max(0,num(rows[k]?.q??rows[k]?.v,0));
    const rate1=q(i),rate2=(q(i-1)+q(i-2))/2,ratePrev3=(q(i-4)+q(i-5)+q(i-6))/3;
    const accelShort=rate2>0?rate1/rate2:1,accelMid=ratePrev3>0?rate2/ratePrev3:1,accelOfAccel=(accelShort-1)+(accelMid-1);
    const baseVol=avg(Array.from({length:10},(_,k)=>q(i-1-k)).filter(v=>v>0)),volumeSpike=baseVol>0?q(i)/baseVol:null;
    const recentRanges=rows.slice(i-2,i+1).map(r=>r?.c>0?(r.h-r.l)/r.c*100:0).filter(v=>v>0);
    const prevRanges=rows.slice(i-11,i-2).map(r=>r?.c>0?(r.h-r.l)/r.c*100:0).filter(v=>v>0);
    const rr=recentRanges.length>=2&&prevRanges.length>=5?avg(recentRanges)/(avg(prevRanges)||1):null;
    const rangeCompression=rr!=null?clamp(100-rr*72,0,100):50;
    const localHigh=Math.max(...rows.slice(i-9,i+1).map(r=>num(r?.h,0)).filter(v=>v>0));
    const nearHigh=localHigh>0?clamp(100-Math.max(0,(localHigh-px)/px*100)*55,0,100):50;
    const positiveMove=clamp(50+Math.max(0,move1)*55+Math.max(0,move2)*38+Math.max(0,move3)*25+Math.max(0,move5)*12,0,100);
    const accelerationScore=clamp(50+(accelShort-1)*55+(accelMid-1)*35+(accelOfAccel>0.20?8:0),0,100);
    const volumeScore=volumeSpike==null?50:clamp(45+(volumeSpike-1)*34,0,100);
    const reversalPenalty=(move1<-.10&&move3<-.18)?10:0;
    const latePenalty=(move5>3.5||move3>2.6)?Math.min(16,Math.max(move5-3.5,move3-2.6)*3.2):0;
    const rawScore=clamp(positiveMove*.28+accelerationScore*.26+volumeScore*.20+rangeCompression*.11+nearHigh*.15-reversalPenalty-latePenalty);
    return {available:true,rawScore,move1,move2,move3,move5,accelShort,accelMid,accelOfAccel,volumeSpike,rangeCompression,nearHigh,ts:num(cur.t)};
  }
  function historicalPulseAt(rows,i){
    const raw=historicalPulseRawAt(rows,i);if(!raw)return null;
    const recent=[i-2,i-1,i].map(k=>historicalPulseRawAt(rows,k)).filter(Boolean).map(x=>x.rawScore);
    const persistenceCount=recent.filter(s=>s>=68).length;
    const persistenceAvg=avg(recent),rising=recent.length>=2?recent.at(-1)-recent[0]:0;
    const persistenceScore=clamp(persistenceAvg+Math.max(0,rising)*0.75);
    const score=clamp(raw.rawScore*.72+persistenceScore*.28);
    return {...raw,score,persistenceCount,persistenceAvg,rising,persistenceScore};
  }
  async function pulseBacktestPreds(rows,threshold=70,step=3){
    const out=[];let n=0;
    for(let i=20;i<rows.length-PRO.targetWindowBars;i+=step){
      const pulse=historicalPulseAt(rows,i),signal=!!(pulse&&pulse.score>=threshold&&(pulse.persistenceCount>=2||pulse.rawScore>=82));
      out.push({signal,target:evaluateForward(rows,i),score:pulse?.score||0,pulse});
      if((++n%PRO.researchYieldEvery)===0)await yieldToBrowser();
    }
    return out;
  }

  function selectPulseThreshold(preds){
    let best=70,bestUtility=-Infinity;
    for(let th=62;th<=84;th+=2){
      const m=metrics(preds.map(x=>({...x,signal:x.score>=th&&(x.pulse?.persistenceCount>=2||x.pulse?.rawScore>=82)})));
      if(m.signals<10)continue;
      const precision=m.precision/100,recall=m.recall/100,utility=precision*.65+recall*.20-Math.min(1,m.falsePositiveRate/100)*.15;
      if(utility>bestUtility){bestUtility=utility;best=th;}
    }
    return best;
  }
  async function pulseWalkForward(all){
    const block=async(rows,a,b,th)=>{
      const out=[];let n=0;
      for(let i=Math.max(20,a);i<Math.min(b,rows.length-PRO.targetWindowBars);i+=3){
        const pulse=historicalPulseAt(rows,i);
        out.push({signal:!!(pulse&&pulse.score>=th&&(pulse.persistenceCount>=2||pulse.rawScore>=82)),target:evaluateForward(rows,i),score:pulse?.score||0,pulse});
        if((++n%PRO.researchYieldEvery)===0)await yieldToBrowser();
      }
      return out;
    };
    const train=[],val=[],oos=[];
    for(const [,rows] of all){
      const n=rows.length,s1=Math.floor(n*.6),s2=Math.floor(n*.8);
      train.push(...await block(rows,20,s1,70));
      val.push(...await block(rows,s1,s2,70));
      oos.push(...await block(rows,s2,n,70));
      await yieldToBrowser();
    }
    const trainTh=selectPulseThreshold(train),valTh=selectPulseThreshold(train.concat(val));
    return [
      {name:'TRAIN',threshold:trainTh,...metrics(train.map(x=>({...x,signal:x.score>=trainTh&&(x.pulse?.persistenceCount>=2||x.pulse?.rawScore>=82)})))},
      {name:'VALIDATION',threshold:trainTh,...metrics(val.map(x=>({...x,signal:x.score>=trainTh&&(x.pulse?.persistenceCount>=2||x.pulse?.rawScore>=82)})))},
      {name:'OOS',threshold:valTh,...metrics(oos.map(x=>({...x,signal:x.score>=valTh&&(x.pulse?.persistenceCount>=2||x.pulse?.rawScore>=82)})))}
    ];
  }

  function backtestSignalAt(rows,i,{disabled=new Set()}={}){
    const slice=rows.slice(0,i+1); if(slice.length<70)return null;
    const f=technicalFeatures(slice); const liq=historicalLiquidityScore(rows,i);
    const parts={
      market:{available:false},structure:{available:!disabled.has('structure'),score:f.priceStructureScore},compression:{available:!disabled.has('compression'),score:f.compression.score},volume:{available:!disabled.has('volume'),score:f.volume.score},relative:{available:false},liquidity:{available:liq.available&&!disabled.has('liquidity'),score:liq.score},orderbook:{available:false},orderflow:{available:!disabled.has('orderflow')&&f.volume.available,score:clamp(50+f.volume.deltaPct*3)},mtf:{available:false},derivatives:{available:false},crossExchange:{available:false},sector:{available:false},catalyst:{available:false},social:{available:false},onchain:{available:false}
    };
    const w=weightedScore(parts,ps.weights);
    const pre=clamp(45+f.compression.score*.25+(f.volume.acceleration>=1.1?10:0)+(f.structure.distResistance!=null&&f.structure.distResistance<=2.2?14:0)+(f.trendScore>55?8:0)+(f.vwapScore>55?8:0));
    const phase=f.trap>=68?'HIGH_RISK_FALSE_BREAKOUT':pre>=PRO.preThreshold&&f.structure.distResistance!=null&&f.structure.distResistance>=-0.5&&f.structure.distResistance<=2.2?'PRE_BREAKOUT':f.structure.breakout?'BREAKOUT':pre>=55?'BUILDING':'NORMAL';
    return {score:w.score,pre,phase,f,coverage:w.coverage};
  }
  function evaluateForward(rows,i){
    const entry=rows[i].c, end=Math.min(rows.length-1,i+PRO.targetWindowBars);let hit=null,mae=0,mfe=0,ambiguous=0;
    for(let j=i+1;j<=end;j++){
      const r=rows[j], hiPct=(r.h/entry-1)*100, loPct=(r.l/entry-1)*100; mfe=Math.max(mfe,hiPct);mae=Math.min(mae,loPct);
      if(hiPct>=PRO.targetMovePct && loPct<=-1.2){ambiguous++;continue;}
      if(hiPct>=PRO.targetMovePct && hit==null)hit=j;
    }
    return {positive:hit!=null,leadBars:hit!=null?hit-i:null,mfe,mae,ambiguous};
  }
  function metrics(preds){
    const tp=preds.filter(x=>x.signal&&x.target.positive).length, fp=preds.filter(x=>x.signal&&!x.target.positive).length, fn=preds.filter(x=>!x.signal&&x.target.positive).length, tn=preds.filter(x=>!x.signal&&!x.target.positive).length;
    const precision=(tp+fp)?tp/(tp+fp)*100:0, recall=(tp+fn)?tp/(tp+fn)*100:0, fpr=(fp+tn)?fp/(fp+tn)*100:0;
    const leads=preds.filter(x=>x.signal&&x.target.positive&&x.target.leadBars!=null).map(x=>x.target.leadBars); const maes=preds.filter(x=>x.signal).map(x=>x.target.mae),mfes=preds.filter(x=>x.signal).map(x=>x.target.mfe);
    return {samples:preds.length,signals:preds.filter(x=>x.signal).length,tp,fp,fn,tn,precision,recall,falsePositiveRate:fpr,falseNegativeRate:recall?100-recall:0,avgLeadBars:avg(leads),medianLeadBars:median(leads),avgMAE:avg(maes),avgMFE:avg(mfes),maxMAE:maes.length?Math.min(...maes):0,maxMFE:mfes.length?Math.max(...mfes):0,signalFrequency:preds.length?preds.filter(x=>x.signal).length/preds.length*100:0,ambiguous:preds.reduce((s,x)=>s+num(x.target.ambiguous,0),0)};
  }
  function walkForward(rows,threshold){
    const n=rows.length,s1=Math.floor(n*.6),s2=Math.floor(n*.8); const blocks=[[0,s1,'TRAIN'],[s1,s2,'VALIDATION'],[s2,n,'OOS']];
    return blocks.map(([a,b,name])=>{const p=[];for(let i=Math.max(70,a);i<Math.min(b,n-PRO.targetWindowBars);i+=2){const s=backtestSignalAt(rows,i);p.push({signal:s&&s.score>=threshold,target:evaluateForward(rows,i),score:s?.score||0});}return {name,...metrics(p)};});
  }
  function selectThreshold(preds){
    let best=64,bestUtility=-Infinity;
    for(let th=56;th<=78;th+=2){const m=metrics(preds.map(x=>({...x,signal:x.score>=th}))); if(m.signals<8)continue; const precision=m.precision/100, recall=m.recall/100; const utility=precision*.60+recall*.25-Math.min(1,m.falsePositiveRate/100)*.15; if(utility>bestUtility){bestUtility=utility;best=th;}}
    return best;
  }
  async function pooledWalkForward(all,baseThreshold){
    const trainPred=[],valPred=[],oosPred=[];
    for(const [,rows] of all){
      const n=rows.length,s1=Math.floor(n*.6),s2=Math.floor(n*.8);
      let count=0;
      for(let i=70;i<n-PRO.targetWindowBars;i+=3){
        const s=backtestSignalAt(rows,i);
        const item={signal:!!(s&&s.score>=baseThreshold),target:evaluateForward(rows,i),score:s?.score||0};
        if(i<s1)trainPred.push(item);else if(i<s2)valPred.push(item);else oosPred.push(item);
        if((++count%PRO.researchYieldEvery)===0)await yieldToBrowser();
      }
      await yieldToBrowser();
    }
    const trainThreshold=selectThreshold(trainPred),valThreshold=selectThreshold(trainPred.concat(valPred));
    return [
      {name:'TRAIN',threshold:trainThreshold,...metrics(trainPred.map(x=>({...x,signal:x.score>=trainThreshold})))},
      {name:'VALIDATION',threshold:trainThreshold,...metrics(valPred.map(x=>({...x,signal:x.score>=trainThreshold})))},
      {name:'OOS',threshold:valThreshold,...metrics(oosPred.map(x=>({...x,signal:x.score>=valThreshold})))}
    ];
  }

  async function runResearch(symbols=[],tf='5m'){
    if(ps.research?.running)return ps.research;
    const list=(symbols.length?symbols:(ps.candidates||[]).slice(0,8).map(x=>x.symbol)).slice(0,10);
    ps.research={running:true,startedAt:now(),tf,symbols:list,results:[],ablation:[],walkForward:[],error:'',progress:0,stage:'historical download'};renderResearch();
    try{
      const rowsMap=new Map();
      for(let i=0;i<list.length;i+=3){const rr=await Promise.allSettled(list.slice(i,i+3).map(s=>historicalKlines(s,tf,4000,(ps.candidates.find(x=>x.symbol===s)?.provider)||'binance')));rr.forEach((r,j)=>{if(r.status==='fulfilled'&&r.value?.length)rowsMap.set(list[i+j],r.value);});}
      const all=Array.from(rowsMap.entries()); const reports=[]; ps.research.progress=25; ps.research.stage='base model evaluation'; renderResearch(); await yieldToBrowser();
      for(const [symbol,rows] of all){
        const pred=[];for(let i=70;i<rows.length-PRO.targetWindowBars;i+=2){const s=backtestSignalAt(rows,i);pred.push({signal:s&&s.score>=PRO.baseThreshold,target:evaluateForward(rows,i),score:s?.score||0});}
        reports.push({symbol,bars:rows.length,metrics:metrics(pred)});
      }
      ps.research.progress=45; ps.research.stage='feature ablation'; renderResearch(); await yieldToBrowser();
      const pooled=[...all.flatMap(([symbol,rows])=>{const a=[];for(let i=70;i<rows.length-PRO.targetWindowBars;i+=2){const s=backtestSignalAt(rows,i);a.push({signal:s&&s.score>=PRO.baseThreshold,target:evaluateForward(rows,i),score:s?.score||0});}return a;})];
      const groups=['compression','volume','structure']; const ablation=[]; const base=metrics(pooled);
      for(const g of groups){const p=[];for(const [,rows] of all)for(let i=70;i<rows.length-PRO.targetWindowBars;i+=2){const s=backtestSignalAt(rows,i,{disabled:new Set([g])});p.push({signal:s&&s.score>=PRO.baseThreshold,target:evaluateForward(rows,i),score:s?.score||0});}const m=metrics(p);ablation.push({feature:g,basePrecision:base.precision,without:m.precision,deltaPrecision:m.precision-base.precision,baseLead:base.avgLeadBars,withoutLead:m.avgLeadBars});}
      ps.research.progress=65; ps.research.stage='walk-forward validation'; renderResearch(); await yieldToBrowser();
      const wf=all.length?await pooledWalkForward(all,PRO.baseThreshold):[];
      ps.research.progress=72; ps.research.stage='early pulse data'; renderResearch(); await yieldToBrowser();
      const pulseList=list.slice(0,8),pulseRowsMap=new Map();
      for(let i=0;i<pulseList.length;i+=2){
        const rr=await Promise.allSettled(pulseList.slice(i,i+2).map(s=>historicalKlines(s,'1m',2500,(ps.candidates.find(x=>x.symbol===s)?.provider)||'binance')));
        rr.forEach((r,j)=>{if(r.status==='fulfilled'&&r.value?.length)pulseRowsMap.set(pulseList[i+j],r.value);});
      }
      const pulseAll=Array.from(pulseRowsMap.entries()),pulsePred=[];
      for(const [,rows] of pulseAll){pulsePred.push(...await pulseBacktestPreds(rows,70,3));await yieldToBrowser();}
      ps.research.progress=88; ps.research.stage='early pulse calibration'; renderResearch(); await yieldToBrowser();
      const pulseThreshold=selectPulseThreshold(pulsePred),pulseBase=metrics(pulsePred.map(x=>({...x,signal:x.score>=pulseThreshold&&(x.pulse?.persistenceCount>=2||x.pulse?.rawScore>=82)}))),pulseWf=pulseAll.length?await pulseWalkForward(pulseAll):[];
      ps.research={...ps.research,running:false,completedAt:now(),progress:100,stage:'completed',results:reports,pooled:base,ablation,wf,pulse:{symbols:pulseAll.map(([s])=>s),bars:pulseAll.reduce((n,[,rows])=>n+rows.length,0),threshold:pulseThreshold,metrics:pulseBase,wf:pulseWf,proxyTf:'1m'}};
      renderResearch();saveLog('research',{symbols:list,tf,pooled:base,pulse:{threshold:pulseThreshold,metrics:pulseBase,proxyTf:'1m'}});return ps.research;
    }catch(e){ps.research={...ps.research,running:false,error:String(e?.message||e)};renderResearch();return ps.research;}
  }

  function renderResearch(){
    const host=$('proResearchOutput');if(!host)return;const r=ps.research;if(!r){host.innerHTML='';return;}
    if(r.running){const rp=clamp(num(r.progress,0),0,100);host.innerHTML='<div class="pro-research-status">🧪 '+(state.lang==='ar'?'جاري الاختبار التاريخي دون استخدام بيانات مستقبلية…':'Running historical test without future data…')+' <b>'+Math.round(rp)+'%</b><div style="height:6px;margin-top:8px;border-radius:9px;background:rgba(255,255,255,.08);overflow:hidden"><i style="display:block;width:'+rp+'%;height:100%;background:var(--cyan);transition:width .2s ease"></i></div><small style="opacity:.7">'+esc(r.stage||'')+'</small></div>';return;}
    if(r.error){host.innerHTML=`<div class="pro-research-status risk">${esc(r.error)}</div>`;return;}
    const m=r.pooled||{},pm=r.pulse?.metrics||{},pw=r.pulse?.wf||[],pth=r.pulse?.threshold; const rows=(r.results||[]).map(x=>`<tr><td>${esc(x.symbol)}</td><td>${x.bars}</td><td>${x.metrics.signals}</td><td>${x.metrics.precision.toFixed(1)}%</td><td>${x.metrics.recall.toFixed(1)}%</td><td>${x.metrics.falsePositiveRate.toFixed(1)}%</td><td>${x.metrics.avgLeadBars.toFixed(1)}</td><td>${x.metrics.avgMFE.toFixed(2)}%</td><td>${x.metrics.avgMAE.toFixed(2)}%</td><td>${x.metrics.maxMFE.toFixed(2)}%</td><td>${x.metrics.maxMAE.toFixed(2)}%</td><td>${x.metrics.ambiguous||0}</td></tr>`).join('');
    const ab=(r.ablation||[]).map(x=>`<div class="pro-ablation-row"><b>${esc(x.feature)}</b><span>Base ${x.basePrecision.toFixed(1)}%</span><span>Without ${x.without.toFixed(1)}%</span><span class="${x.deltaPrecision<0?'gain':'loss'}">Δ ${x.deltaPrecision>=0?'+':''}${x.deltaPrecision.toFixed(1)}pp</span></div>`).join('');
    const wf=(r.wf||[]).map(x=>`<div class="pro-wf-row"><b>${x.name}</b><span>Precision ${x.precision.toFixed(1)}%</span><span>Recall ${x.recall.toFixed(1)}%</span><span>FPR ${x.falsePositiveRate.toFixed(1)}%</span><span>Lead ${x.avgLeadBars.toFixed(1)} bars</span><span>Threshold ${x.threshold!=null?x.threshold:'—'}</span></div>`).join('');
    host.innerHTML=`<div class="pro-research-grid"><div class="pro-research-kpi"><span>⚡ Pulse Precision</span><b>${(pm.precision||0).toFixed(1)}%</b></div><div class="pro-research-kpi"><span>⚡ Pulse Recall</span><b>${(pm.recall||0).toFixed(1)}%</b></div><div class="pro-research-kpi"><span>⚡ Pulse FPR</span><b>${(pm.falsePositiveRate||0).toFixed(1)}%</b></div><div class="pro-research-kpi"><span>⚡ Pulse Lead (min)</span><b>${(pm.avgLeadBars||0).toFixed(1)}</b></div><div class="pro-research-kpi"><span>Pulse Threshold</span><b>${pth!=null?pth:'—'}</b></div><div class="pro-research-kpi"><span>Signals</span><b>${m.signals||0}</b></div><div class="pro-research-kpi"><span>Precision</span><b>${(m.precision||0).toFixed(1)}%</b></div><div class="pro-research-kpi"><span>Recall</span><b>${(m.recall||0).toFixed(1)}%</b></div><div class="pro-research-kpi"><span>FPR</span><b>${(m.falsePositiveRate||0).toFixed(1)}%</b></div><div class="pro-research-kpi"><span>Lead</span><b>${(m.avgLeadBars||0).toFixed(1)}</b></div><div class="pro-research-kpi"><span>FNR</span><b>${(m.falseNegativeRate||0).toFixed(1)}%</b></div></div><div class="pro-table-wrap"><table><thead><tr><th>Symbol</th><th>Bars</th><th>Signals</th><th>Precision</th><th>Recall</th><th>FPR</th><th>Lead</th><th>Avg MFE</th><th>Avg MAE</th><th>Max MFE</th><th>Max MAE</th><th>Amb.</th></tr></thead><tbody>${rows||'<tr><td colspan="12">No historical data</td></tr>'}</tbody></table></div><div class="pro-research-section"><h4>Ablation</h4>${ab||'—'}</div><div class="pro-research-section"><h4>Walk-Forward (time-split)</h4>${wf||'—'}</div><div class="pro-research-section"><h4>⚡ Early Pulse Calibration — 1m proxy</h4>${pw.map(x=>`<div class="pro-wf-row"><b>${x.name}</b><span>Precision ${x.precision.toFixed(1)}%</span><span>Recall ${x.recall.toFixed(1)}%</span><span>FPR ${x.falsePositiveRate.toFixed(1)}%</span><span>Lead ${x.avgLeadBars.toFixed(1)} min</span><span>Threshold ${x.threshold!=null?x.threshold:'—'}</span></div>`).join('')||'—'}<small class="pro-note">هذه المعايرة تستخدم OHLCV تاريخي على 1m كبديل محافظ عن شريط الثواني الحي 10–60s، ولا تدّعي محاكاة order flow داخل الثانية.</small></div><small class="pro-note">Historical research here is based on OHLCV data available from the public API. Order book, derivatives, social, news and on-chain factors are excluded from the historical score when their timestamped history is unavailable; they are never backfilled with current/future values.</small>`;
  }

  function bind(){
    $('proRadarRun')?.addEventListener('click',()=>runCycle());
    $('proResearchBtn')?.addEventListener('click',()=>runResearch());
    document.addEventListener('click',e=>{const b=e.target.closest('[data-pro-deep]');if(!b)return;const s=b.dataset.proDeep;const c=ps.candidates.find(x=>x.symbol===s);if(c){try{CORE.selectActiveAsset(s,{openSignal:true,refresh:true,source:'pro-engine'});}catch{}}},true);
  }

  function expose(){
    window.RadarXPro={
      state:ps, runCycle, runResearch, render, getCandidates:()=>ps.candidates||[], getRegime:()=>ps.regime, getNews:()=>ps.news, refreshNews, refreshOnchain, refreshSocial,
      setExternalSignal:(kind,symbol,data)=>{if(!['catalyst','social','onchain','tokenomics'].includes(kind))return false;ps.external[kind].set(symbol,{...data,available:true});return true;},
      setWeights:(w)=>{for(const k of Object.keys(ps.weights))if(finite(w?.[k]))ps.weights[k]=Math.max(0,num(w[k]));return {...ps.weights};},
      clearExternal:(kind,symbol)=>{ps.external[kind]?.delete(symbol);},
      metrics:{technicalFeatures,marketRegime,mtfScore,metrics,backtestSignalAt}
    };
  }

  function start(){
    bind();renderResearch();render();updateDashboardKpis();expose();
    setTimeout(()=>runCycle().catch(()=>{}),600);
    setInterval(()=>{runCycle().catch(()=>{});},PRO.cycleMs);
    setInterval(()=>{updateProMeta();},2000);
    CORE?.state?.marketsBySymbol && (ps.source='cached');
  }

  document.addEventListener('DOMContentLoaded',start,{once:true});
})();
