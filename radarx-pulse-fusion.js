/* RadarX Pulse Fusion Engine — regime adaptive, multi-factor, self-calibrating */
(function(){
  'use strict';
  const KEY='radarx_pulse_calibration_v2';
  const CFG={horizonBars:6,minMoveATR:.22,maxPending:18,minSamples:6,cacheMs:350};
  let lastEval={key:'',at:0,value:null};
  let cachedCalibration=null;
  let breadthCache={key:'',value:50};
  const clamp=(x,a=0,b=100)=>Math.max(a,Math.min(b,Number.isFinite(Number(x))?Number(x):50));
  const num=(x,d=0)=>Number.isFinite(Number(x))?Number(x):d;
  const sma=(a,p)=>{const x=a.slice(-p);return x.length?x.reduce((s,v)=>s+num(v),0)/x.length:0;};
  const ema=(a,p)=>{if(!a.length)return 0;const k=2/(p+1);let e=num(a[0]);for(let i=1;i<a.length;i++)e=num(a[i])*k+e*(1-k);return e;};
  const emaSeries=(a,p)=>{const src=a.map(num);if(!src.length)return[];const k=2/(p+1),out=new Array(src.length);let e=num(src[0]);out[0]=e;for(let i=1;i<src.length;i++){e=num(src[i])*k+e*(1-k);out[i]=e;}return out;};
  const stdev=a=>{if(!a.length)return 0;const m=sma(a,a.length);return Math.sqrt(a.reduce((s,v)=>s+(num(v)-m)*(num(v)-m),0)/a.length);};
  const trueRange=(rows,i)=>i<1?Math.max(0,num(rows[i]?.h)-num(rows[i]?.l)):Math.max(num(rows[i].h)-num(rows[i].l),Math.abs(num(rows[i].h)-num(rows[i-1].c)),Math.abs(num(rows[i].l)-num(rows[i-1].c)));
  const atr=(rows,p=14)=>{const x=[];for(let i=Math.max(1,rows.length-p);i<rows.length;i++)x.push(trueRange(rows,i));return sma(x,x.length)||0;};
  const rsi=(a,p=14)=>{if(a.length<p+1)return 50;let g=0,l=0;for(let i=a.length-p;i<a.length;i++){const d=num(a[i])-num(a[i-1]);if(d>=0)g+=d;else l-=d;}if(!l)return 100;const rs=g/l;return 100-100/(1+rs);};
  const slope=(a,p)=>{const x=a.slice(-p).map(num);if(x.length<3)return 0;const m=sma(x,x.length),mid=(x.length-1)/2;let u=0,v=0;for(let i=0;i<x.length;i++){u+=(i-mid)*(x[i]-m);v+=(i-mid)*(i-mid);}return v?u/v:0;};
  const trix=a=>{if(a.length<2)return 0;const e1=emaSeries(a,15),e2=emaSeries(e1,15),e3=emaSeries(e2,15);return e3.at(-1)-e3.at(-2);};
  const adx=(rows,p=14)=>{if(rows.length<p*2)return 20;const plus=[],minus=[],trs=[];for(let i=1;i<rows.length;i++){const up=num(rows[i].h)-num(rows[i-1].h),dn=num(rows[i-1].l)-num(rows[i].l);plus.push(up>dn&&up>0?up:0);minus.push(dn>up&&dn>0?dn:0);trs.push(trueRange(rows,i));}const at=sma(trs.slice(-p),p)||1,dp=sma(plus.slice(-p),p)/at*100,dm=sma(minus.slice(-p),p)/at*100;return 100*Math.abs(dp-dm)/Math.max(1,dp+dm);};
  const percentile=(a,v)=>{const x=a.slice().sort((m,n)=>m-n);if(!x.length)return 50;let k=0;while(k<x.length&&x[k]<=v)k++;return k/x.length*100;};
  const vwap=rows=>{let pv=0,v=0;rows.forEach(r=>{const q=num(r.v),p=(num(r.h)+num(r.l)+num(r.c))/3;pv+=p*q;v+=q;});return v?pv/v:0;};
  const obv=rows=>{let v=0;const out=[];for(let i=1;i<rows.length;i++){if(num(rows[i].c)>num(rows[i-1].c))v+=num(rows[i].v);else if(num(rows[i].c)<num(rows[i-1].c))v-=num(rows[i].v);out.push(v);}return out;};
  const macd=a=>{const src=a.map(num);if(!src.length)return{line:0,signal:0,hist:0,slope:0};const f=emaSeries(src,12),sl=emaSeries(src,26),m=f.map((v,i)=>v-sl[i]),line=m.at(-1)||0,sig=ema(m.slice(-60),9);return{line,signal:sig,hist:line-sig,slope:slope(m,5)};};
  const getStore=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'{}');}catch{return{};}};
  const putStore=x=>{try{localStorage.setItem(KEY,JSON.stringify(x));}catch{}cachedCalibration=x;};
  const emptyCal=()=>{const names=['trend','structure','compression','volume','momentum','flow','whale','mtf','relative','liquidity','wyckoff'];return Object.fromEntries(names.map(k=>[k,{a:4,b:4,n:0}]))};
  const calibration=()=>{if(cachedCalibration)return cachedCalibration;const x=getStore();if(!x.components)x.components=emptyCal();if(!Array.isArray(x.pending))x.pending=[];cachedCalibration=x;return x;};
  const invalidateCalibration=()=>{cachedCalibration=null;};
  const reliability=(x)=>clamp((num(x.a,4)/(num(x.a,4)+num(x.b,4)))*100,25,75);
  function resolveCalibration(symbol,tf,closedRows,dir){
    if(!symbol||!closedRows?.length)return;
    const c=calibration(),nowRows=closedRows;
    let changed=false;
    c.pending=(c.pending||[]).filter(p=>{
      const idx=nowRows.findIndex(r=>r.t===p.createdT);
      if(idx<0||nowRows.length-idx<=p.horizon)return true;
      const base=num(p.price),end=num(nowRows[Math.min(nowRows.length-1,idx+p.horizon)].c),a=num(p.atr,p.price*.004);
      const ret=base?(end/base-1):0,good=p.dir>0?ret>=a/Math.max(base,1)*CFG.minMoveATR:ret<=-a/Math.max(base,1)*CFG.minMoveATR;
      Object.entries(p.parts||{}).forEach(([k,v])=>{
        const c0=c.components[k]||(c.components[k]={a:4,b:4,n:0});
        if(Math.abs(num(v))<.08)return;
        const aligned=p.dir*Number(v)>0;
        c0[good===aligned?'a':'b']+=.75;c0.n++;
      });
      changed=true;return false;
    });
    c.pending=c.pending.slice(-CFG.maxPending);
    if(changed)putStore(c);
  }
  function marketRegime(rows,st){
    const closes=rows.map(r=>num(r.c)),ranges=rows.map(r=>Math.max(0,num(r.h)-num(r.l))),a=atr(rows,14)||closes.at(-1)*.004;
    const e20=ema(closes.slice(-100),20),e50=ema(closes.slice(-120),50),adxV=adx(rows),atrPct=clamp(a/Math.max(1,closes.at(-1))*100,0,20);
    const widths=[];for(let i=20;i<closes.length;i++){const z=stdev(closes.slice(i-20,i)),m=sma(closes.slice(i-20,i),20)||1;widths.push(z*4/m*100);}
    const bw=widths.at(-1)||0,bwp=percentile(widths,bw),rangePct=clamp(sma(ranges.slice(-20),20)/Math.max(1,closes.at(-1))*100,0,20);
    const trend=Math.abs(e20-e50)/Math.max(a,closes.at(-1)*.001);
    const markets=st.markets||[];
    const breadthKey=String(markets.length)+'|'+String(num(st.multiRadar?.lastUpdated||st.multiRadar?.cacheAt,0));
    let breadth=50;
    if(breadthCache.key===breadthKey) breadth=breadthCache.value;
    else{
      breadth=markets.length?markets.filter(x=>num(x.priceChangePercent)>0).length/markets.length*100:50;
      breadthCache={key:breadthKey,value:breadth};
    }
    let type='RANGE';
    if(adxV>=28&&trend>=1.2)type='TREND';
    else if(bwp<=22)type='SQUEEZE';
    else if(atrPct>=3.2||rangePct>=2.2)type='VOLATILE';
    else if(Math.abs(breadth-50)>=22)type='BROAD_MOVE';
    if(adxV>=20&&bwp<=35)type='TRANSITION';
    return{type,adx:adxV,atrPct,bw,bwp,rangePct,breadth};
  }
  function structureSignal(rows){
    const last=rows.at(-1),prev=rows.at(-2)||last,prior=rows.slice(-12,-2);
    if(!prior.length)return 50;
    const hi=Math.max(...prior.map(r=>num(r.h))),lo=Math.min(...prior.map(r=>num(r.l)));
    const reclaimedHigh=num(last.c)>hi&&num(prev.c)<=hi, reclaimedLow=num(last.c)<lo&&num(prev.c)>=lo;
    const highs=[],lows=[];for(let i=2;i<rows.length-2;i++){if(num(rows[i].h)>=num(rows[i-1].h)&&num(rows[i].h)>=num(rows[i+1].h))highs.push(num(rows[i].h));if(num(rows[i].l)<=num(rows[i-1].l)&&num(rows[i].l)<=num(rows[i+1].l))lows.push(num(rows[i].l));}
    const hh=highs.at(-1)>highs.at(-2),hl=lows.at(-1)>lows.at(-2),lh=highs.at(-1)<highs.at(-2),ll=lows.at(-1)<lows.at(-2);
    let s=50;if(hh&&hl)s+=27;if(lh&&ll)s-=27;if(reclaimedHigh)s+=30;if(reclaimedLow)s-=30;
    const sweepLow=num(last.l)<lo&&num(last.c)>lo,sweepHigh=num(last.h)>hi&&num(last.c)<hi;if(sweepLow)s+=18;if(sweepHigh)s-=18;
    return clamp(s);
  }
  function volumeSignal(rows){
    const vs=rows.map(r=>num(r.v)),last=vs.at(-1),base=sma(vs.slice(-31,-1),30)||1,rv=last/base,acc=(last/(vs.at(-2)||last)-1)*100;
    const recent=sma(vs.slice(-5),5)||1,older=sma(vs.slice(-20,-5),15)||1,dry=clamp(100-recent/older*100);
    const expansion=clamp(50+(rv-1)*24+acc*3+(dry>25&&rv>1.35?12:0));
    return{score:expansion,rv,acc,dry};
  }
  function momentumSignal(rows){
    const c=rows.map(r=>num(r.c)),a=atr(rows,14)||c.at(-1)*.004,rr5=(c.at(-1)/c.at(-6)-1)*100,rr15=(c.at(-1)/c.at(-16)-1)*100,m=macd(c),rs=rsi(c),acc1=(c.at(-1)/c.at(-2)-1)*100,acc2=acc1-(c.at(-2)/c.at(-3)-1)*100;
    const score=clamp(50+rr5*12+rr15*4+(m.hist/a)*18+(m.slope/a)*35+(rs-50)*.25+acc2*12);
    return{score,rr5,rr15,rsi:rs,macd:m,acceleration:acc1,accel2:acc2};
  }
  function compressionSignal(rows,reg){
    const c=rows.map(r=>num(r.c));const widths=[];const atrs=[];for(let i=20;i<c.length;i++){const ss=stdev(c.slice(i-20,i)),mid=sma(c.slice(i-20,i),20)||1;widths.push(ss*4/mid*100);atrs.push(atr(rows.slice(Math.max(0,i-14),i+1),14));}
    const bw=widths.at(-1)||0,bwP=percentile(widths,bw),last=c.at(-1),a=atr(rows,14)||last*.004,hi=Math.max(...rows.slice(-21,-1).map(r=>num(r.h))),near=hi?clamp(100-(hi-last)/a*22):50;
    const score=clamp((100-bwP)*.58+near*.42+(reg.type==='SQUEEZE'?8:0));
    return{score,bw,bwP,near};
  }
  function flowSignal(st){
    const f=st.selected?.flow||st.selected?.flowWhales||null,w=f?.whales||null;
    const book=f?clamp(50+num(f.imbalance)*.55):50,cvd=f?clamp(50+num(f.cvd)*.65):50,ratio=f?.buySell?clamp(50+(f.buySell-1)*45):50;
    const whale=w?clamp(num(w.score,50)*.86+num(w.confidence,50)*.14):50;
    const micro=w?.bestBid&&w?.bestAsk?50:50;
    return{score:clamp(book*.33+cvd*.30+ratio*.18+whale*.19),book,cvd,ratio,whale};
  }
  function mtfSignal(st){
    const m=st.selected?.mtf;if(!m?.rows?.length)return{score:50,agreement:0};
    return{score:clamp(num(m.consensusScore,50)),agreement:clamp(num(m.agreement,0))};
  }
  function volatilityForecast(rows){
    const c=rows.map(function(r){return num(r.c);}),rets=[];
    for(let i=1;i<c.length;i++)if(c[i-1]>0&&c[i]>0)rets.push(Math.log(c[i]/c[i-1]));
    if(rets.length<20)return{score:50,sigma:0,shortLong:1,skew:0,p80:0,p95:0};
    const lam=.94;let v=0;rets.forEach(function(r){v=lam*v+(1-lam)*r*r;});
    const sigma=Math.sqrt(Math.max(v,1e-12)),short=Math.sqrt(sma(rets.slice(-5).map(function(x){return x*x;}),5)||v),long=Math.sqrt(sma(rets.slice(-30).map(function(x){return x*x;}),30)||v);
    const shortLong=short/Math.max(long,1e-12),recent=rets.slice(-30),m=sma(recent,recent.length);
    const mu3=recent.reduce(function(a,x){return a+Math.pow(x-m,3);},0)/recent.length,skew=mu3/Math.pow(long||1e-9,3);
    return{score:clamp(50+(shortLong-1)*42-skew*6),sigma:sigma,shortLong:shortLong,skew:skew,p80:sigma*1.28,p95:sigma*1.96};
  }
  function changePointSignal(rows){
    const c=rows.map(function(r){return num(r.c);}),a=atr(rows,14)||num(c.at(-1))*.004,re=[];
    for(let i=1;i<c.length;i++)re.push((c[i]-c[i-1])/Math.max(a,1e-12));
    let pos=0,neg=0;
    re.slice(-30).forEach(function(x){pos=Math.max(0,pos+x-.35);neg=Math.min(0,neg+x+.35);});
    return{score:clamp(50+(Math.max(0,pos)-Math.abs(neg))*7),positive:pos,negative:neg};
  }
  function efficiencySignal(rows,p=20){
    const c=rows.map(r=>num(r.c));if(c.length<p+1)return{score:50,er:0};
    const net=Math.abs(c.at(-1)-c.at(-1-p)),noise=c.slice(-p-0).reduce(function(s,v,i,a){return i?s+Math.abs(v-a[i-1]):s;},0)||1;
    const er=clamp(net/noise*100);
    const dir=c.at(-1)>c.at(-1-p)?1:-1;
    return{score:clamp(50+dir*(er-35)*1.15),er:er};
  }
  function donchianSignal(rows,p=20){
    if(rows.length<p+2)return{score:50,breakout:0};
    const x=rows.slice(-p-1,-1),hi=Math.max(...x.map(r=>num(r.h))),lo=Math.min(...x.map(r=>num(r.l))),last=rows.at(-1),a=atr(rows,14)||num(last.c)*.004;
    const pos=hi>lo?(num(last.c)-lo)/(hi-lo):.5;
    const breakout=hi?(num(last.c)-hi)/Math.max(a,hi*.001)*100:0;
    return{score:clamp(45+pos*40+(breakout>0?20:breakout>-1?8:0)),breakout:breakout};
  }
  function priceVolumeDivergence(rows){
    if(rows.length<25)return{score:50,div:0};
    const c=rows.map(r=>num(r.c)),v=rows.map(r=>num(r.v));
    const priceSlope=slope(c,10),volSlope=slope(v,10);
    const priceNorm=priceSlope/Math.max(1,atr(rows,14)||c.at(-1)*.004),volNorm=volSlope/Math.max(1,sma(v.slice(-10),10));
    const same=priceNorm*volNorm,div=same<0?Math.abs(priceNorm-volNorm):0;
    return{score:clamp(50+(same>0?Math.sign(priceNorm)*Math.min(30,Math.abs(priceNorm)*8):0)-Math.sign(priceNorm)*Math.min(18,div*6)),div:div};
  }

  function relativeSignal(st,mom){
    const s=st.selected||{},btc=st.marketsBySymbol?.BTCUSDT,price=s.priceChangePercent,btc24=btc?.priceChangePercent;
    const edge=Number.isFinite(Number(price))&&Number.isFinite(Number(btc24))?num(price)-num(btc24):mom.rr15;
    const score=clamp(50+edge*3.2+mom.acceleration*4);
    return{score,edge};
  }
  function liquiditySignal(st){
    const f=st.selected?.flow,depth=st.selected?.liveDepth;if(!f&&!depth)return{score:50,spread:0};
    const bid=num(f?.bid),ask=num(f?.ask),spread=Math.abs(num(f?.whales?.spreadBps));
    const depthScore=bid+ask?clamp(50+(bid-ask)/(bid+ask)*70):50,spreadScore=spread<=3?88:spread<=8?70:spread<=15?48:25;
    return{score:clamp(depthScore*.62+spreadScore*.38),spread};
  }
  function wyckoffSignal(rows,vol){
    const x=rows.slice(-24),hi=Math.max(...x.map(r=>num(r.h))),lo=Math.min(...x.map(r=>num(r.l))),last=x.at(-1),pos=hi>lo?(num(last.c)-lo)/(hi-lo):.5;
    const ob=obv(x),obvUp=slope(ob,Math.min(12,ob.length))>0;
    const spring=num(last.l)<lo+(hi-lo)*.18&&num(last.c)>lo+(hi-lo)*.30;
    const upthrust=num(last.h)>lo+(hi-lo)*.82&&num(last.c)<hi-(hi-lo)*.30;
    const score=clamp(50+(pos<.48?12:pos>.60?-6:0)+(obvUp?14:-8)+(spring?24:0)-(upthrust?24:0)+(vol.rv>1.4&&obvUp?8:0));
    return{score,spring,upthrust,obvUp};
  }
  function trapPenalty(st){
    const f=st.selected?.fakeout,w=st.selected?.flow?.whales;if(f?.level==='HIGH')return 28;if(f?.level==='MEDIUM')return 14;
    if(w?.warnings?.some(x=>String(x).includes('امتصاص')))return 8;return 0;
  }
  function weights(reg){
    const w={trend:.11,structure:.11,compression:.10,volume:.11,momentum:.11,flow:.13,whale:.07,mtf:.10,relative:.06,liquidity:.04,wyckoff:.06};
    if(reg.type==='TREND'){w.trend+=.05;w.mtf+=.03;w.momentum+=.02;w.compression-=.03;}
    if(reg.type==='RANGE'){w.compression+=.04;w.liquidity+=.02;w.structure+=.02;w.trend-=.04;}
    if(reg.type==='SQUEEZE'){w.compression+=.08;w.volume+=.04;w.structure+=.03;w.trend-=.04;w.relative-=.02;}
    if(reg.type==='VOLATILE'){w.flow+=.05;w.liquidity+=.03;w.momentum+=.02;w.trend-=.05;w.compression-=.03;}
    if(reg.type==='BROAD_MOVE'){w.relative+=.04;w.mtf+=.02;w.flow+=.02;}
    return w;
  }
  function evaluate(rows,st){
    const symbol=st.selected?.symbol||'',tf=st.selected?.timeframe||'5m',lastRow=rows.at(-1),cacheKey=symbol+'|'+tf+'|'+String(lastRow?.t||0)+'|'+String(lastRow?.c||0)+'|'+String(lastRow?.v||0);
    if(lastEval.key===cacheKey&&performance.now()-lastEval.at<CFG.cacheMs)return lastEval.value;
    const closed=rows.filter(r=>r.closed!==false&&num(r.c)>0);if(closed.length<28)return{score:50,confidence:0,coverage:0,label:'INSUFFICIENT',parts:{}};
    resolveCalibration(symbol,tf,closed,1);
    const reg=marketRegime(closed,st),mom=momentumSignal(closed),vol=volumeSignal(closed),comp=compressionSignal(closed,reg),fl=flowSignal(st),mtf=mtfSignal(st),rel=relativeSignal(st,mom),liq=liquiditySignal(st),wy=wyckoffSignal(closed,vol),str=structureSignal(closed),eff=efficiencySignal(closed),don=donchianSignal(closed),pvd=priceVolumeDivergence(closed),vf=volatilityForecast(closed),cp=changePointSignal(closed);
    const last=closed.at(-1),a=atr(closed,14)||num(last.c)*.004,e20=ema(closed.map(r=>num(r.c)).slice(-100),20),e50=ema(closed.map(r=>num(r.c)).slice(-120),50),adxV=reg.adx;
    const trend=clamp(50+(e20-e50)/Math.max(a,num(last.c)*.001)*22+(adxV-20)*.8);
    const comps={trend,structure:str,compression:comp.score,volume:vol.score,momentum:mom.score,flow:fl.score,whale:fl.whale,mtf:mtf.score,relative:rel.score,liquidity:liq.score,wyckoff:wy.score,efficiency:eff.score,donchian:don.score,priceVolume:pvd.score,volForecast:vf.score,changePoint:cp.score};
    const w=Object.assign(weights(reg),{efficiency:.045,donchian:.045,priceVolume:.035,volForecast:.055,changePoint:.04});
    const cal=calibration();
    let totalW=0,score=0;Object.entries(comps).forEach(([k,v])=>{const baseW=num(w[k],.03),reli=reliability(cal.components?.[k]||{a:4,b:4}),factor=.75+reli/200;totalW+=baseW*factor;score+=v*baseW*factor;});score/=Math.max(.001,totalW);
    const signs=Object.values(comps).map(v=>v>58?1:v<42?-1:0).filter(Boolean),bull=signs.filter(x=>x>0).length,bear=signs.filter(x=>x<0).length,conflict=signs.length?Math.min(bull,bear)/signs.length*100:0;
    const trap=trapPenalty(st),breadth=reg.breadth;
    const breadthGate=reg.type==='BROAD_MOVE'?((breadth-50)*.10):0;
    const conflictPenalty=conflict*.12;
    const readinessBoost=(reg.type==='SQUEEZE'&&vol.rv>1.35&&comp.near>62)?7:0;
    score=clamp(score+breadthGate+readinessBoost-trap-conflictPenalty);
    const reliabilityAvg=Object.keys(comps).reduce((a,k)=>a+reliability(cal.components?.[k]||{a:4,b:4}),0)/Object.keys(comps).length;
    const liveAt=num(st.selected?.liveAt||st.selected?.eventTime,0),ageMs=liveAt?Math.max(0,Date.now()-liveAt):999999;
    const freshness=ageMs<=2500?100:ageMs<=5000?90:ageMs<=10000?72:ageMs<=20000?48:20;
    const coverage=[st.selected?.flow,st.selected?.mtf,st.markets?.length,rows.length>=60,st.selected?.fakeout,eff.score,don.score,pvd.score].filter(v=>v!==null&&v!==undefined).length/8*100;
    const confidence=clamp(coverage*.36+freshness*.18+reliabilityAvg*.21+Math.abs(score-50)*.70-conflict*.10-trap*.30);
    if(freshness<48)score=50+(score-50)*.60;
    let label='NEUTRAL';if(score>=82&&confidence>=68)label='PRE-BREAKOUT';else if(score>=72&&confidence>=56)label='BUILDING';else if(score<=30)label='HIGH RISK / WEAK';else if(score<=42)label='WEAK';
    const dir=score>=50?1:-1;
    if(closed.length>=CFG.horizonBars+2&&score>=68&&confidence>=55){
      const pending=cal.pending||[],exists=pending.some(p=>p.symbol===symbol&&p.tf===tf&&p.createdT===last.t);
      if(!exists){pending.push({symbol,tf,createdT:last.t,price:num(last.c),atr:a,dir,parts:Object.fromEntries(Object.entries(comps).map(([k,v])=>[k,(v-50)/50])),horizon:CFG.horizonBars});cal.pending=pending.slice(-CFG.maxPending);putStore(cal);}
    }
    const reasons=[];
    if(reg.type==='SQUEEZE')reasons.push('Volatility squeeze / compression');
    if(comp.near>65)reasons.push('قريب من مقاومة/قمة محلية مع طاقة مضغوطة');
    if(vol.rv>=1.5)reasons.push('Volume expansion / RVOL');
    if(mom.accel2>0)reasons.push('تسارع زخم من الدرجة الثانية');
    if(str>=68)reasons.push('هيكل HH/HL أو reclaim');
    if(fl.score>=68)reasons.push('Order-flow confluence');
    if(fl.whale>=68)reasons.push('Whale-flow confirmation');
    if(mtf.score>=68&&mtf.agreement>=60)reasons.push('MTF consensus');
    if(wy.spring||wy.obvUp)reasons.push('Wyckoff accumulation proxy');
    if(eff.er>55)reasons.push('High market efficiency / directed move');
    if(don.score>70)reasons.push('Donchian breakout pressure');
    if(pvd.score>60)reasons.push('Price/volume confirmation');
    if(vf.shortLong>1.2)reasons.push('Volatility expansion is accelerating');
    if(cp.score>68)reasons.push('Change-point / regime-shift evidence');
    if(trap>0)reasons.push('⚠ Trap penalty applied');
    const conflictsList=[];Object.entries(comps).forEach(([k,v])=>{if(v<35&&score>65)conflictsList.push(k+' conflict');if(v>72&&score<45)conflictsList.push(k+' bullish vs regime');});
    const result={score,confidence,coverage,freshness,ageMs,label,direction:dir>0?'BULLISH':'BEARISH',regime:reg.type,regimeStats:reg,parts:comps,weights:w,calibration:Object.fromEntries(Object.entries(cal.components||{}).map(([k,v])=>[k,{reliability:reliability(v),samples:num(v.n)}])),conflict:conflict,trapPenalty:trap,reasons,reasonsText:reasons.slice(0,8),conflicts:conflictsList,metrics:{rsi:mom.rsi,rv:vol.rv,accel2:mom.accel2,bw:comp.bw,bwPercentile:comp.bwP,adx:adxV,whale:fl.whale,mtf:mtf.score,mtfAgreement:mtf.agreement,breadth:breadth,relative:rel.edge,spread:liq.spread,vwapDistance:((num(last.c)-vwap(closed))/Math.max(a,num(last.c)*.001))*100,efficiency:eff.er,donchian:don.score,priceVolume:pvd.score,volSigma:vf.sigma,volShortLong:vf.shortLong,volSkew:vf.skew,changePoint:cp.score}};
    lastEval={key:cacheKey,at:performance.now(),value:result};return result;
  }
  window.RadarXPulseFusion={evaluate,calibration,clearCalibration:function(){try{localStorage.removeItem(KEY);}catch{}invalidateCalibration();lastEval={key:'',at:0,value:null};breadthCache={key:'',value:50};},version:'3.0-fusion-adaptive'};
})();