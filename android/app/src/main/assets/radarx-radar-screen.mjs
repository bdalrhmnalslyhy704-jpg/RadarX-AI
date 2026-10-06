import {getRadarStatus,getRadarAlerts,getRotationRadar,setRadarState} from './radarx-backend-client.mjs';

const P = {
  EARLY_MOVE_RADAR:{n:'المدمر',i:'☠️',c:'#ff3b30',m:'ما قبل الانفجار',s:'Pre-Breakout Fingerprint + Relative Strength + Compression',t:'1m • 5m • 15m',a:['Fast Impulse','RVOL','Taker Flow','EMA Reclaim','S/R','RSI','OBV','Wyckoff','MTF'],g:['يمنع مطاردة الحركة','جودة وسيولة لازمتان','شموع مغلقة فقط']},
  STRONG_MOVE_RADAR:{n:'ملك الظلام',i:'🌑',c:'#7c3aed',m:'الانفجار الجاري',s:'Momentum Burst + Flash Acceleration + Breakout + Climax',t:'1m • 5m',a:['Momentum','Flash Acceleration','Volume Climax','Trade Surge','Taker Flow','Donchian','EMA','VWAP','BB','ATR'],g:['أكثر من دليل','منع التمدد الشديد','شموع مغلقة فقط']},
  ROTATION_LAG_RADAR:{n:'الجوكر',i:'🃏',c:'#f59e0b',m:'دوران السيولة',s:'BTC/ETH Lead-Lag + Relative Strength + Value Acceptance',t:'15m • 1h',a:['BTC/ETH Lead-Lag','Relative Spread','Volume Dislocation','VWAP','Value Acceptance','RSI/MFI','Stochastic','Persistence','Compression'],g:['التأخر وحده ليس إشارة','رفض التمدد','توافق السوق والعملة']},
  LIQUIDITY_ABSORPTION_RADAR:{n:'الكاسح',i:'🧹',c:'#06b6d4',m:'امتصاص البيع',s:'Seller Absorption + Depth Imbalance + Trapped Sellers',t:'1m • 5m',a:['Seller Absorption','Depth Imbalance','Trapped Sellers','Microstructure','Auction Balance','Fractal Structure','5m Confirm'],g:['سبريد ضيق','حجم وامتصاص حقيقي','رفض التمدد']}
};

function e(v){return String(v||'').replace(/[&<>"]/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[x]));}
function q(v){return Number.isFinite(Number(v))?Number(v).toFixed(1):'—';}

function idFromPath(){
  const f=String(location.pathname||'').split('/').pop().toLowerCase();
  if(f.startsWith('radar2-'))return 'STRONG_MOVE_RADAR';
  if(f.startsWith('radar3-'))return 'ROTATION_LAG_RADAR';
  if(f.startsWith('radar4-'))return 'LIQUIDITY_ABSORPTION_RADAR';
  return 'EARLY_MOVE_RADAR';
}

function installTheme(p){
  const old=document.getElementById('rxs-style');
  old && old.remove();
  const st=document.createElement('style');
  st.id='rxs-style';
  st.textContent=`
    .rxs{max-width:780px;margin:auto;padding:12px;overflow-wrap:anywhere}
    .rxs .card{background:#0b1520;border:1px solid #223b4f;border-radius:20px;padding:14px;margin:9px 0;box-shadow:0 10px 28px rgba(0,0,0,.16)}
    .rxs .hero{border-color:${p.c}88;background:linear-gradient(145deg,${p.c}26,#0b1520)}
    .rxs h1{margin:3px 0;font-size:26px}
    .rxs .muted{color:#8fa5b5;font-size:11px;line-height:1.7}
    .rxs .actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
    .rxs .btn{min-height:44px;border-radius:12px;border:1px solid #34546a;background:#0d2131;color:#fff;font-weight:900;transition:transform .16s ease,opacity .16s ease,filter .16s ease}
    .rxs .btn:active{transform:scale(.985)}
    .rxs .btn.go{background:${p.c};color:#051018;border-color:${p.c}}
    .rxs .btn.stop{background:#28151b;border-color:#7d4651}
    .rxs .btn:disabled{opacity:.55}
    .rxs .status{padding:9px;border-radius:11px;margin-top:10px;background:#07111a;border:1px solid #29465a;font-size:11px;font-weight:900}
    .rxs .status.live{border-color:${p.c};box-shadow:0 0 18px ${p.c}25}
    .rxs .chips{display:flex;flex-wrap:wrap;gap:6px}
    .rxs .chip{padding:6px 8px;border-radius:999px;background:#07121b;border:1px solid #244055;font-size:9px}
    .rxs .alert{padding:10px;border-radius:13px;background:#07121b;border:1px solid #1d394d;margin-top:7px}
    .rxs .top{display:flex;justify-content:space-between;gap:8px;align-items:center}
    .rxs .score{color:${p.c};font-weight:1000}
    @media(max-width:520px){.rxs{padding:8px}.rxs h1{font-size:23px}}
  `;
  document.head.appendChild(st);
}

export function mountStandaloneRadar(root,radarId=idFromPath()){
  const id=String(radarId).toUpperCase();
  const p=P[id];
  if(!root||!p)return{destroy(){}};

  let dead=false,busy=false,timer=null;
  const CACHE_KEY='radarx.radar.cache.'+id;
  const CACHE_TTL_MS=5*60*1000;
  function readRadarCache(){try{const raw=sessionStorage.getItem(CACHE_KEY);if(!raw)return null;const x=JSON.parse(raw);return x&&Number.isFinite(Number(x.savedAt))&&x.body&&(Date.now()-Number(x.savedAt)<CACHE_TTL_MS)?x:null;}catch(error){return null;}}
  function writeRadarCache(body){try{sessionStorage.setItem(CACHE_KEY,JSON.stringify({savedAt:Date.now(),body:body}));}catch(error){}}
  installTheme(p);

  try{
    root.innerHTML=`<main class="rxs" dir="rtl">
      <section class="card hero">
        <div class="muted">RADARX • INDEPENDENT SPOT RADAR</div>
        <h1>${p.i} ${p.n}</h1>
        <div class="muted">${p.m} — ${p.s}</div>
        <div class="status" data-st>جارٍ التحقق…</div>
        <div class="actions">
          <button class="btn go" data-on>تشغيل ${p.n}</button>
          <button class="btn stop" data-off>إيقاف ${p.n}</button>
        </div>
      </section>
      <section class="card"><b>🎯 المهمة</b><p class="muted">${p.s} • ${p.t}</p></section>
      <section class="card"><b>⚙️ الخوارزميات</b><div class="chips">${p.a.map(x=>'<span class="chip">'+e(x)+'</span>').join('')}</div></section>
      <section class="card"><b>🛡️ حواجز الجودة</b><div class="chips">${p.g.map(x=>'<span class="chip">'+e(x)+'</span>').join('')}</div></section>
      <section class="card">
        <div class="top"><b>🚨 آخر اكتشافات ${p.n}</b><button class="btn go" style="min-height:34px;padding:0 10px" data-ref>تحديث</button></div>
        <div data-a><div class="muted">لا توجد بيانات بعد.</div></div>
      </section>
    </main>`;

    const stn=root.querySelector('[data-st]');
    const on=root.querySelector('[data-on]');
    const off=root.querySelector('[data-off]');
    const box=root.querySelector('[data-a]');
    const ref=root.querySelector('[data-ref]');

    const setStatus=(x)=>{
      const live=x && x.running===true;
      stn.className='status '+(live?'live':'');
      stn.textContent=live?'● '+p.n+' يعمل مستقلًا':'○ '+p.n+' متوقف';
      on.disabled=live;off.disabled=!live;
    };

    const show=(rows)=>{
      if(!Array.isArray(rows)||!rows.length){
        box.innerHTML='<div class="muted">لا يوجد مرشح أو اكتشاف محفوظ حاليًا.</div>';
        return;
      }
      const sorted=[...rows].sort((a,b)=>Number(b.radar_power_score||b.opportunity_score||b.score||0)-Number(a.radar_power_score||a.opportunity_score||a.score||0));
      box.innerHTML=sorted.slice(0,20).map(x=>{
        const rotation=x.rotation||{};
        const isJoker=id==='ROTATION_LAG_RADAR';
        const score=q(x.radar_power_score||x.radar_v2 && x.radar_v2.score||x.opportunity_score||x.score);
        const label=isJoker?(x.eligible===true?'جاهز للدوران':(x.potential_label||rotation.stage||'مراقبة')):(x.potential_label||x.event||'اكتشاف');
        const extra=isJoker?' • تأكيدات '+String((x.rotation && x.rotation.confirmations) || x.confirmations || 0):'';
        return '<article class="alert">'+
          '<div class="top"><b>'+e(x.symbol||'—')+'</b><span class="score">'+score+'/100</span></div>'+
          '<div class="muted">'+e(label)+' • '+e(x.direction||rotation.direction||'—')+' • '+e(x.detected_time_12h||'—')+extra+'</div>'+
          '<div class="muted">'+e(Array.isArray(x.reasons)?x.reasons.slice(0,4).join(' • '):Array.isArray(rotation.reasons)?rotation.reasons.slice(0,4).join(' • '):'')+'</div>'+
        '</article>';
      }).join('');
    };

    async function refresh(force=false){
      if(dead||busy)return;
      if(!force){
        const cached=readRadarCache();
        if(cached){
          const body=cached.body||{};
          const rows=id==='ROTATION_LAG_RADAR'?(body.candidates||[]).concat(body.alerts||[]):(body.alerts||[]);
          show(rows);
          const st=body.monitoring||body.status;
          if(st)setStatus(st);
          else stn.textContent='● بيانات محفوظة — بدون إعادة فحص السوق';
          return;
        }
      }
      busy=true;
      try{
        const s=await getRadarStatus();
        if(s.ok)setStatus((s.body && s.body.radars||[]).find(x=>x.radar===id));
        else stn.textContent='تعذر قراءة حالة الرادار — HTTP_'+(s.status||0);
        let a;
        if(id==='ROTATION_LAG_RADAR') a=await getRotationRadar({limit:20,scan:true});
        else a=await getRadarAlerts({radar:id,limit:50});
        if(a.ok){
          writeRadarCache(a.body||{});
          if(id==='ROTATION_LAG_RADAR')show([].concat(a.body&&a.body.candidates||[],a.body&&a.body.alerts||[]));
          else show(a.body&&a.body.alerts||[]);
        }else if(a.status===404)box.innerHTML='<div class="muted">لا يوجد مسار بيانات لهذا الرادار في الخادم الحالي.</div>';
      }catch(x){
        stn.className='status';
        stn.textContent='Backend غير متاح — '+e(x && x.message||x);
        box.innerHTML='<div class="muted">تعذر تحميل النتائج، لكن واجهة الرادار تعمل. أعد التحديث لاحقًا.</div>';
      }finally{busy=false;}
    };

    async function control(action){
      on.disabled=true;off.disabled=true;
      stn.className='status';
      stn.textContent=action==='start'?'جاري التشغيل…':'جاري الإيقاف…';
      try{
        const x=await setRadarState(id,action);
        if(!x.ok)throw new Error(x.body && x.body.error||x.error||('HTTP_'+x.status));
      }catch(x){
        stn.textContent='فشل تغيير الحالة — '+e(x && x.message||x);
      }
      await refresh();
    }

    on.onclick=()=>control('start');
    off.onclick=()=>control('stop');
    ref.onclick=()=>refresh(true);
    refresh(false);
    timer=setInterval(refresh,20000);
  }catch(error){
    root.innerHTML=`<main class="rxs" dir="rtl"><section class="card hero"><h1>${p.i} ${p.n}</h1><div class="status">تعذر رسم الرادار</div><div class="muted">${e(error && error.message||error)}</div></section></main>`;
  }

  return {
    refresh:()=>refresh(),
    destroy(){dead=true;if(timer)clearInterval(timer);root.innerHTML='';(function(){var _n=document.getElementById('rxs-style');if(_n)_n.remove();})();}
  };
}
