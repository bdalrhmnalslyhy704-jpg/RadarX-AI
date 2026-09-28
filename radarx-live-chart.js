/* RadarX Live Signal Chart — real-time candle renderer + adaptive confluence layer */
(function(){
  'use strict';

  const CFG={
    bars:82,
    pollMs:160,
    minDrawMs:70,
    chartHeight:390,
    tfMs:{'1m':60000,'5m':300000,'15m':900000,'1h':3600000}
  };
  let canvas=null,wrap=null,tip=null,resizeObs=null,raf=0,lastDraw=0,lastSig='',pointer=null,toolbar=null;

  const $=id=>document.getElementById(id);
  const n=(x,d=0)=>Number.isFinite(Number(x))?Number(x):d;
  const clamp=(x,a=0,b=100)=>Math.max(a,Math.min(b,n(x)));
  const esc=x=>String(x==null?'':x).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const fmt=(x,p=6)=>{x=n(x);if(!x)return'—';if(Math.abs(x)>=1000)return x.toLocaleString('en-US',{maximumFractionDigits:2});if(Math.abs(x)>=1)return x.toLocaleString('en-US',{maximumFractionDigits:p});return x.toPrecision(Math.min(8,Math.max(3,p+1)));};
  const tfMs=tf=>CFG.tfMs[tf]||300000;

  function sma(a,p){const x=a.slice(-p);return x.length?x.reduce((s,v)=>s+n(v),0)/x.length:0;}
  function ema(a,p){if(!a.length)return 0;const k=2/(p+1);let e=n(a[0]);for(let i=1;i<a.length;i++)e=n(a[i])*k+e*(1-k);return e;}
  function std(a){if(!a.length)return 0;const m=sma(a,a.length);return Math.sqrt(a.reduce((s,v)=>s+(n(v)-m)*(n(v)-m),0)/a.length);}
  function tr(rows,i){if(i<1)return Math.max(0,n(rows[i]?.h)-n(rows[i]?.l));return Math.max(n(rows[i].h)-n(rows[i].l),Math.abs(n(rows[i].h)-n(rows[i-1].c)),Math.abs(n(rows[i].l)-n(rows[i-1].c)));}
  function atr(rows,p=14){if(rows.length<2)return 0;const a=[];for(let i=Math.max(1,rows.length-p);i<rows.length;i++)a.push(tr(rows,i));return sma(a,a.length);}
  function rsi(a,p=14){if(a.length<p+1)return 50;let g=0,l=0;for(let i=a.length-p;i<a.length;i++){const d=n(a[i])-n(a[i-1]);if(d>=0)g+=d;else l-=d;}if(!l)return 100;const rs=g/l;return 100-(100/(1+rs));}
  function macd(a){
    const src=a.slice(-140).map(n),fast=[],slow=[],mac=[];
    for(let i=0;i<src.length;i++){
      fast.push(ema(src.slice(0,i+1),12)); slow.push(ema(src.slice(0,i+1),26)); mac.push(fast[i]-slow[i]);
    }
    const signal=ema(mac.slice(-60),9);
    const line=mac.at(-1)||0;
    return{line:line,signal:signal,hist:line-signal};
  }
  function adx(rows,p=14){
    if(rows.length<p*2)return 20;
    const plus=[],minus=[],trs=[];
    for(let i=1;i<rows.length;i++){
      const up=n(rows[i].h)-n(rows[i-1].h),down=n(rows[i-1].l)-n(rows[i].l);
      plus.push(up>down&&up>0?up:0);minus.push(down>up&&down>0?down:0);trs.push(tr(rows,i));
    }
    const at=sma(trs.slice(-p),p)||1,diP=sma(plus.slice(-p),p)/at*100,diM=sma(minus.slice(-p),p)/at*100;
    return 100*Math.abs(diP-diM)/Math.max(1,diP+diM);
  }
  function volumeProfile(rows,bins=24){
    if(!rows.length)return{poc:0,vah:0,val:0};
    const lo=Math.min(...rows.map(r=>n(r.l))),hi=Math.max(...rows.map(r=>n(r.h))),span=hi-lo||1, step=span/bins;
    const vol=Array(bins).fill(0);
    rows.forEach(function(r){
      const px=(n(r.h)+n(r.l)+n(r.c))/3,idx=Math.max(0,Math.min(bins-1,Math.floor((px-lo)/step)));
      vol[idx]+=n(r.v);
    });
    const pocIdx=vol.indexOf(Math.max(...vol)),target=vol.reduce((a,b)=>a+b,0)*.70;
    let left=pocIdx,right=pocIdx,sum=vol[pocIdx]||0;
    while(sum<target&&(left>0||right<bins-1)){const lv=left>0?vol[left-1]:-1,rv=right<bins-1?vol[right+1]:-1;if(rv>lv&&right<bins-1){right++;sum+=vol[right];}else if(left>0){left--;sum+=vol[left];}else break;}
    const priceAt=i=>lo+(i+.5)*step;
    return{poc:priceAt(pocIdx),vah:priceAt(right),val:priceAt(left)};
  }
  function obv(rows){let v=0;const out=[];for(let i=1;i<rows.length;i++){if(n(rows[i].c)>n(rows[i-1].c))v+=n(rows[i].v);else if(n(rows[i].c)<n(rows[i-1].c))v-=n(rows[i].v);out.push(v);}return out;}
  function vwap(rows){let pv=0,v=0;for(const r of rows){const q=n(r.v),typ=(n(r.h)+n(r.l)+n(r.c))/3;pv+=typ*q;v+=q;}return v?pv/v:0;}
  function rollingHigh(rows,p,field='h'){const x=rows.slice(-p);return x.length?Math.max(...x.map(r=>n(r[field]))):0;}
  function rollingLow(rows,p,field='l'){const x=rows.slice(-p);return x.length?Math.min(...x.map(r=>n(r[field]))):0;}
  function normalize(v,lo,hi){return hi===lo?50:clamp((v-lo)/(hi-lo)*100);}

  function liveRows(st){
    const s=st?.selected;if(!s?.symbol)return [];
    const tf=s.timeframe||$('analysisTf')?.value||'5m';
    let rows=(st.klinesCache?.[s.symbol]?.[tf]||s.rows||[]).filter(r=>n(r.o)>0&&n(r.h)>0&&n(r.l)>0&&n(r.c)>0);
    rows=rows.slice(-CFG.bars);
    const px=n(st.marketsBySymbol?.[s.symbol]?.last,s.price);
    if(!px)return rows;
    const ms=tfMs(tf), now=Date.now(), bucket=Math.floor(now/ms)*ms;
    let cur=rows.at(-1);
    if(!cur || Math.abs(n(cur.t)-bucket)>ms/2){
      const base=n(cur?.c,px);
      cur={t:bucket,o:base,h:Math.max(base,px),l:Math.min(base,px),c:px,v:0,q:0,trades:0,tb:0,closed:false,syntheticOpen:true};
      rows=rows.concat(cur).slice(-CFG.bars);
    }else{
      cur={...cur,c:px,h:Math.max(n(cur.h),px),l:Math.min(n(cur.l),px),closed:false,syntheticOpen:false};
      rows=rows.slice(0,-1).concat(cur);
    }
    return rows;
  }

  function adaptiveConfluence(rows,st){
    if(rows.length<20)return{score:50,coverage:Math.min(100,rows.length/20*100),label:'INSUFFICIENT',parts:{}};
    const closes=rows.map(r=>n(r.c)),vols=rows.map(r=>n(r.v)),last=rows.at(-1),a=atr(rows,14)||last.c*.004;
    const e20=ema(closes.slice(-100),20),e50=ema(closes.slice(-120),50),e100=ema(closes,Math.min(100,closes.length));
    const m=macd(closes),rr5=closes.length>5?(last.c/closes.at(-6)-1)*100:0,rr15=closes.length>15?(last.c/closes.at(-16)-1)*100:0;
    const base=sma(vols.slice(-31,-1),30)||1,rv=n(last.v)/base;
    const hi=rollingHigh(rows.slice(0,-1),20),lo=rollingLow(rows.slice(0,-1),20);
    const proximity=hi?clamp(100-Math.max(0,(hi-last.c)/Math.max(a,hi*.001))*25):50;
    const compression=(()=>{const ranges=rows.slice(-30).map(r=>n(r.h)-n(r.l)),fast=sma(ranges.slice(-8),8)||1,slow=sma(ranges,30)||fast;return clamp((1-fast/slow)*100);})();
    const vw=vwap(rows),vwapScore=vw?clamp(50+(last.c/vw-1)*10000/4):50;
    const flow=st.flow||st.flowWhales||null,whale=flow?.whales||null;
    const book=flow?clamp(50+n(flow.imbalance)*.5):50;
    const cvd=flow?clamp(50+n(flow.cvd)*.5):50;
    const whaleScore=whale?clamp(n(whale.score,50)):50;
    const adxVal=adx(rows);
    const depth=st.selected.liveDepth||null,db=depth?.bids?.[0],da=depth?.asks?.[0];
    const micro=(db&&da)?((n(da[0])*n(db[1])+n(db[0])*n(da[1]))/Math.max(1,n(db[1])+n(da[1]))):0;
    const microBias=micro?clamp(50+(micro-last.c)/(a||last.c*.001)*18):50;
    const bullTrend=e20>e50?72:28;
    const trendSlope=e20>e100?68:32;
    const momentum=clamp(50+rr5*13+rr15*5+Math.tanh(m.hist/(a||1))*18);
    const volume=rv>=3?90:rv>=2?78:rv>=1.4?66:rv>=1?54:35;
    const structure=clamp(50+(last.c>hi?32:last.c>e20?10:-12)+(last.c>lo?4:0));
    const squeeze=clamp(50+compression*.5+(last.c>=hi?25:0));
    const score=clamp(
      bullTrend*.14+trendSlope*.10+momentum*.16+volume*.14+structure*.12+
      squeeze*.07+vwapScore*.08+book*.065+cvd*.055+whaleScore*.05+clamp(adxVal*1.15)*.065+microBias*.035
    );
    const available=[e20,e50,m.hist,rv,hi,lo,vw,flow?.imbalance,flow?.cvd,whale?.score];
    const coverage=available.filter(v=>Number.isFinite(Number(v))).length/available.length*100;
    const label=score>=78?'HIGH CONFLUENCE':score>=65?'BUILDING':score<=38?'WEAK / RISK':'NEUTRAL';
    const vp=volumeProfile(rows);
    return{score,coverage,label,parts:{trend:bullTrend,slope:trendSlope,momentum,volume,structure,squeeze,vwap:vwapScore,book,cvd,whale:whaleScore,adx:clamp(adxVal),micro:microBias},e20,e50,vwap:vw,vp:vp,bb:{mid:sma(closes.slice(-20),20),std:std(closes.slice(-20),20),upper:0,lower:0},atr:a,rsi:rsi(closes),adx:adxVal,macd:m,rv,hi,lo};
  }

  function ensureUI(){
    canvas=$('signalCanvas');if(!canvas)return false;
    if(!wrap||wrap.querySelector('canvas')!==canvas){
      wrap=canvas.closest('.chart-card')||canvas.parentElement;
      if(!wrap)return false;
      wrap.classList.add('rx-live-chart-shell');
      let old=wrap.querySelector('.rx-live-toolbar');if(old)old.remove();
      toolbar=document.createElement('div');toolbar.className='rx-live-toolbar';
      toolbar.innerHTML='<div class="rx-live-tools"><div class="rx-tf-buttons">'+['1m','5m','15m','1h'].map(tf=>'<button type="button" data-rx-tf="'+tf+'">'+tf+'</button>').join('')+'</div><span class="rx-live-badge" id="rxLiveState">LIVE CANDLE</span><span class="rx-live-pulse" id="rxLivePulse">●</span></div><div class="rx-live-tools"><span class="rx-chip" id="rxPulseScore">RX Pulse —</span><span class="rx-chip" id="rxChartMode">Live Binance feed</span><button type="button" class="rx-chart-refresh" id="rxChartRefresh">↻ مزامنة</button></div>';
      wrap.insertBefore(toolbar,canvas);
      tip=document.createElement('div');tip.className='rx-live-tip';tip.hidden=true;wrap.appendChild(tip);
      toolbar.querySelectorAll('[data-rx-tf]').forEach(btn=>btn.onclick=()=>switchTf(btn.dataset.rxTf));
      $('rxChartRefresh').onclick=()=>resync();
      if(resizeObs)resizeObs.disconnect();
      resizeObs=new ResizeObserver(()=>draw(true));
      resizeObs.observe(wrap);
      canvas.addEventListener('pointermove',onPointer,{passive:true});
      canvas.addEventListener('pointerleave',()=>{if(tip)tip.hidden=true;pointer=null;draw(true);},{passive:true});
    }
    syncTfButtons();
    return true;
  }

  function syncTfButtons(){
    if(!toolbar)return;
    const tf=window.RadarXCore?.state?.selected?.timeframe||$('analysisTf')?.value||'5m';
    toolbar.querySelectorAll('[data-rx-tf]').forEach(b=>b.classList.toggle('active',b.dataset.rxTf===tf));
  }

  async function switchTf(tf){
    const core=window.RadarXCore;if(!core?.state?.selected?.symbol)return;
    const sel=$('analysisTf');if(sel)sel.value=tf;
    try{await core.selectActiveAsset(core.state.selected.symbol,{openSignal:true,refresh:true,source:'live-chart-tf'});}
    catch{}
    syncTfButtons();
  }

  async function resync(){
    const core=window.RadarXCore;if(!core?.state?.selected?.symbol)return;
    try{await core.selectActiveAsset(core.state.selected.symbol,{openSignal:true,refresh:true,source:'live-chart-refresh'});}
    catch{}
  }

  function onPointer(e){
    if(!canvas||!wrap)return;
    const r=canvas.getBoundingClientRect(),dpr=canvas.width/r.width;
    pointer={x:(e.clientX-r.left)*dpr,y:(e.clientY-r.top)*dpr};
    draw(true);
  }

  function draw(force){
    if(!canvas||!document.body.contains(canvas))return;
    const core=window.RadarXCore,st=core?.state;if(!st?.selected)return;
    const rows=liveRows(st);if(rows.length<2)return;
    const sig=(st.selected.symbol||'')+'|'+(st.selected.timeframe||'')+'|'+rows.at(-1).t+'|'+rows.at(-1).c+'|'+rows.at(-1).h+'|'+rows.at(-1).l;
    const now=performance.now();
    if(!force&&sig===lastSig&&now-lastDraw<CFG.minDrawMs)return;
    lastSig=sig;lastDraw=now;
    const rect=canvas.getBoundingClientRect(),cssW=Math.max(320,rect.width||800),cssH=CFG.chartHeight,dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1));
    if(canvas.width!==Math.round(cssW*dpr)||canvas.height!==Math.round(cssH*dpr)){canvas.width=Math.round(cssW*dpr);canvas.height=Math.round(cssH*dpr);}
    const ctx=canvas.getContext('2d');if(!ctx)return;ctx.setTransform(dpr,0,0,dpr,0,0);
    const W=cssW,H=cssH,pad={l:10,r:76,t:26,b:54},plotH=H-pad.t-pad.b,volH=48,priceH=plotH-volH;
    ctx.clearRect(0,0,W,H);ctx.fillStyle='#071018';ctx.fillRect(0,0,W,H);
    const lo=Math.min(...rows.map(r=>n(r.l))),hi=Math.max(...rows.map(r=>n(r.h))),range=hi-lo||1;
    const py=v=>pad.t+(hi-v)/range*priceH;
    const vx=i=>pad.l+(W-pad.l-pad.r)*(i/(rows.length-1));
    const cw=Math.max(3,(W-pad.l-pad.r)/rows.length);
    ctx.strokeStyle='rgba(90,130,145,.18)';ctx.lineWidth=1;
    for(let j=1;j<6;j++){const y=pad.t+j*priceH/6;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(W-pad.r,y);ctx.stroke();}
    for(let j=0;j<5;j++){const x=pad.l+j*(W-pad.l-pad.r)/4;ctx.beginPath();ctx.moveTo(x,pad.t);ctx.lineTo(x,H-pad.b);ctx.stroke();}
    const con=window.RadarXPulseFusion?.evaluate(rows,st)||adaptiveConfluence(rows,st);
    const ema20=rows.map((_,i)=>ema(rows.slice(0,i+1).map(r=>n(r.c)).slice(-100),20));
    const ema50=rows.map((_,i)=>ema(rows.slice(0,i+1).map(r=>n(r.c)).slice(-120),50));
    const vw=vwap(rows),closes=rows.map(r=>n(r.c)),bbmid=sma(closes.slice(-20),20),bbs=std(closes.slice(-20)),bbu=bbmid+bbs*2,bbl=bbmid-bbs*2,vp=con.vp||volumeProfile(rows);
    const volumeMax=Math.max(1,...rows.map(r=>n(r.v)));
    rows.forEach((r,i)=>{
      const x=vx(i),o=py(n(r.o)),c=py(n(r.c)),h=py(n(r.h)),l=py(n(r.l)),up=n(r.c)>=n(r.o);
      ctx.strokeStyle=up?'#27e89a':'#ff5d6c';ctx.lineWidth=1.1;ctx.beginPath();ctx.moveTo(x,h);ctx.lineTo(x,l);ctx.stroke();
      ctx.fillStyle=up?'#27e89a':'#ff5d6c';ctx.fillRect(x-cw*.28,Math.min(o,c),Math.max(1,cw*.56),Math.max(1,Math.abs(c-o)));
      const vh=volH*(n(r.v)/volumeMax),base=H-pad.b+10;ctx.globalAlpha=.22;ctx.fillRect(x-cw*.24,base-vh,cw*.48,vh);ctx.globalAlpha=1;
    });
    function line(values,stroke,width=1.4,dash=[]){ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.beginPath();values.forEach((v,i)=>{if(!Number.isFinite(v))return;const x=vx(i),y=py(v);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.stroke();ctx.setLineDash([]);}
    line(ema20,'#6fd7ff',1.5);
    line(ema50,'#c9a6ff',1.2);
    if(vw)line(rows.map(()=>vw),'#ffd36b',1.2,[5,4]);
    if(Number.isFinite(bbu)&&Number.isFinite(bbl)){line(rows.map(()=>bbu),'rgba(145,190,205,.42)',1);line(rows.map(()=>bbl),'rgba(145,190,205,.42)',1);}
    if(vp?.poc){line(rows.map(()=>vp.poc),'rgba(255,190,95,.72)',1.1,[3,3]);line(rows.map(()=>vp.vah),'rgba(255,190,95,.28)',1,[2,5]);line(rows.map(()=>vp.val),'rgba(255,190,95,.28)',1,[2,5]);}
    const last=rows.at(-1),lastPrice=n(last.c),yLast=py(lastPrice);
    ctx.strokeStyle='rgba(84,213,255,.65)';ctx.setLineDash([4,5]);ctx.beginPath();ctx.moveTo(pad.l,yLast);ctx.lineTo(W-pad.r,yLast);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='#9feaff';ctx.font='700 11px system-ui,sans-serif';ctx.fillText(fmt(lastPrice),W-pad.r+8,yLast+4);
    // Structure / breakout markers
    const ev=st.selected.structure?.event||st.structure?.event;
    if(ev&&Number.isFinite(Number(ev.price))&&ev.i>=0&&ev.i<rows.length){
      const x=vx(ev.i),y=py(n(ev.price));ctx.fillStyle=ev.direction==='BULLISH'?'#54e2b2':'#ff7b91';ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fill();ctx.font='800 9px system-ui,sans-serif';ctx.fillText(String(ev.type||'BOS'),Math.min(W-pad.r-44,x+6),y-7);
    }
    // Information header
    const px=st.marketsBySymbol?.[st.selected.symbol]?.last||st.selected.price;
    const flow=st.selected.flow||st.selected.flowWhales,whale=flow?.whales;
    ctx.fillStyle='#e9f8ff';ctx.font='800 12px system-ui,sans-serif';ctx.fillText(st.selected.symbol+' · '+fmt(px),pad.l,15);
    ctx.fillStyle=con.score>=78?'#83efbf':con.score>=65?'#ffe28d':'#9fb3bf';ctx.fillText('RX Pulse '+Math.round(con.score),pad.l+170,15);
    ctx.fillStyle='#68818d';ctx.font='600 9px system-ui,sans-serif';ctx.fillText('EMA20 / EMA50 / VWAP / BB · Live',pad.l+270,15);
    // Right labels
    ctx.font='600 8px system-ui,sans-serif';ctx.fillStyle='#6f8995';
    for(let j=0;j<5;j++){const v=lo+range*(1-j/4);ctx.fillText(fmt(v,4),W-pad.r+8,pad.t+j*(priceH/4)+3);}
    // Volume label
    ctx.fillText('VOL',pad.l,H-10);ctx.fillText('RVOL '+(con.rv||0).toFixed(2)+'x',pad.l+38,H-10);
    if(st.selected.flow?.cvd!=null){ctx.fillText('CVD '+n(st.selected.flow.cvd).toFixed(1)+'%',pad.l+115,H-10);}
    if(whale){ctx.fillText('Whale '+Math.round(n(whale.score,50)),pad.l+195,H-10);}
    // Pointer crosshair
    if(pointer){
      const sx=pointer.x/dpr,sy=pointer.y/dpr;
      const idx=Math.max(0,Math.min(rows.length-1,Math.round((sx-pad.l)/(W-pad.l-pad.r)*(rows.length-1))));
      const rr=rows[idx],cx=vx(idx);ctx.strokeStyle='rgba(220,240,248,.24)';ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(cx,pad.t);ctx.lineTo(cx,H-pad.b);ctx.stroke();ctx.beginPath();ctx.moveTo(pad.l,sy);ctx.lineTo(W-pad.r,sy);ctx.stroke();ctx.setLineDash([]);
      const when=new Date(n(rr.t));tip.innerHTML='<b>'+esc(st.selected.symbol)+' · '+esc(st.selected.timeframe||'')+'</b><br>O '+fmt(rr.o)+' · H '+fmt(rr.h)+'<br>L '+fmt(rr.l)+' · C '+fmt(rr.c)+'<br>V '+fmt(rr.v)+'<br>'+when.toLocaleString();
      tip.hidden=false;const x=Math.min(Math.max(8,cx-70),Math.max(8,W-180));const y=Math.min(Math.max(8,sy-86),H-110);tip.style.left=x+'px';tip.style.top=y+'px';
    }
    const stateBadge=$('rxLiveState'),pulse=$('rxLivePulse'),ps=$('rxPulseScore'),mode=$('rxChartMode');
    if(stateBadge){stateBadge.textContent='● LIVE CANDLE';stateBadge.classList.add('on');}
    if(pulse){pulse.textContent='●';pulse.classList.add('pulse');}
    if(ps){ps.textContent='RX Pulse '+Math.round(con.score)+' · '+con.label;ps.dataset.regime=con.regime||'';ps.title=(con.reasonsText||[]).join(' · ')||('Regime: '+(con.regime||'NEUTRAL'));}
    if(mode)mode.textContent='Binance WebSocket · '+(st.selected.timeframe||'5m')+' · '+(con.regime||'')+' · '+Math.round(con.coverage||0)+'% evidence';
    if(ps&&con.parts)ps.title='Trend '+Math.round(con.parts.trend)+' · Momentum '+Math.round(con.parts.momentum)+' · Volume '+Math.round(con.parts.volume)+' · ADX '+Math.round(con.parts.adx)+' · Microprice '+Math.round(con.parts.micro);
    syncTfButtons();
  }

  function loop(){
    if(!document.body.contains(canvas||document.body))return;
    ensureUI();
    const core=window.RadarXCore,st=core?.state;
    if(st?.selected){
      const rows=liveRows(st);
      if(rows.length>1)draw(false);
    }
    raf=requestAnimationFrame(loop);
  }

  function init(){
    if(!window.ResizeObserver)return;
    const mo=new MutationObserver(()=>{ensureUI();draw(true);});
    mo.observe(document.documentElement,{childList:true,subtree:true});
    const tfSel=$('analysisTf');
    if(tfSel&&!tfSel.dataset.rxLiveBound){tfSel.dataset.rxLiveBound='1';tfSel.addEventListener('change',function(){switchTf(tfSel.value);});}
    ensureUI();
    if(raf)cancelAnimationFrame(raf);
    raf=requestAnimationFrame(loop);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
  window.RadarXLiveChart={draw:()=>draw(true),resync:resync,switchTf:switchTf,adaptiveConfluence:adaptiveConfluence};
})();
