import {getRadarStatus,getRadarAlerts,setRadarState} from './radarx-backend-client.mjs';

const STYLE_ID='radarx-independent-radars-style';
const RADARS=[
  {id:'EARLY_MOVE_RADAR',name:'Radar 1 — المدمر',icon:'☠️',color:'#ff3b30',desc:'يرصد الاستيقاظ المبكر قبل الحركة الكبيرة، ويمنع مطاردة العملة بعد تمددها.',algos:'Pre-Move Fingerprint • Relative Strength • Compression • Strategy Confluence'},
  {id:'STRONG_MOVE_RADAR',name:'Radar 2 — ملك الظلام',icon:'🌑',color:'#7c3aed',desc:'يرصد توسع الحركة الفعلية فقط بعد تسارع واضح، حجم أعلى وتأكيد تدفق.',algos:'Momentum Burst • Volume Climax • Donchian • ATR/BB Expansion'},
  {id:'ROTATION_LAG_RADAR',name:'Radar 3 — الجوكر',icon:'🃏',color:'#f59e0b',desc:'يبحث عن العملات المتأخرة عن BTC/ETH عندما يبدأ فرق القوة بالتقلص لصالحها.',algos:'Cross-Market Lead/Lag • Relative Spread • Silent Volume/Price Dislocation'},
  {id:'LIQUIDITY_ABSORPTION_RADAR',name:'Radar 4 — الكاسح',icon:'🧹',color:'#06b6d4',desc:'رادار مختلف: يراقب امتصاص البيع، اختلال دفتر الطلب، البائعين العالقين وتوازن المزاد قبل القفزة.',algos:'Seller Absorption • Depth Imbalance/Vacuum • Trapped Sellers • Microstructure Dislocation • Auction Balance'},
  {id:'KAHIR_RADAR',name:'Radar 5 — القاهر',icon:'👑',desc:'يفحص كامل سوق Spot ويقارن كل عملة بسلوكها السابق، ثم يلتقط التسارع غير المعتاد وجودة الاندفاع قبل أن يصبح مجرد حركة ممتدة.',algos:'Self-Baseline Z • Participation Regime • Volatility Shift • Kaufman Efficiency • Range Acceptance • Impulse Persistence'}
  ,{id:'DOOMSDAY_RADAR',name:'Radar 6 — يوم القيامة',icon:'☄️',color:'#ff4d3d',desc:'صياد الانفجار المفاجئ: يراقب الشرارة قبل أن تصبح حركة يومية ممتدة، مع مراقبة خاصة لفجائية التسارع.',algos:'1m/3m/5m Momentum • Self Acceleration • RVOL • Trade Surge • Taker Flow • Squeeze Release • Donchian • EMA/VWAP • ATR • BTC Relative Strength'}
  ,{id:'ALMUQAWIM_RADAR',name:'Radar 7 — المقاوم',icon:'🛡️',color:'#38bdf8',desc:'حارس اتجاه السوق: هيكل HH/HL أو LH/LL، خط الاتجاه، المتوسط المتحرك وتوافق 4H + 1H.',algos:'HH/HL • LH/LL • Trendline • EMA Filter • 4H/1H Alignment • 15m Risk Guard'}
];

function addStyle(){
  if(document.getElementById(STYLE_ID))return;
  const s=document.createElement('style');s.id=STYLE_ID;
  s.textContent=[
    '.rx-radar-wrap{margin:10px 0;padding:14px;border:1px solid #28445d;border-radius:20px;background:linear-gradient(145deg,#0b1725,#08101a);box-shadow:0 12px 32px rgba(0,0,0,.18)}',
    '.rx-radar-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.rx-radar-title{font-size:16px;font-weight:1000}.rx-radar-sub{color:#8fa5b8;font-size:10px;line-height:1.7;margin-top:4px}',
    '.rx-radar-grid{display:grid;gap:9px;margin-top:12px}.rx-radar-card{padding:12px;border:1px solid #1e3b52;border-radius:16px;background:#07131f}.rx-radar-card.live{border-color:#2d8064;box-shadow:0 0 0 1px rgba(67,224,163,.08)}',
    '.rx-radar-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.rx-radar-name{font-weight:1000;font-size:13px}.rx-radar-desc{color:#8ca4b7;font-size:9px;line-height:1.6;margin-top:3px}.rx-radar-algos{color:#668196;font-size:8px;line-height:1.55;margin-top:7px}',
    '.rx-radar-badge{display:inline-flex;align-items:center;gap:5px;padding:5px 8px;border:1px solid #294b63;border-radius:999px;font-size:9px;font-weight:950;white-space:nowrap}.rx-radar-dot{width:7px;height:7px;border-radius:50%;background:#657b8e}.rx-radar-dot.live{background:#43e0a3;box-shadow:0 0 10px #43e0a3}',
    '.rx-radar-actions{display:flex;gap:7px;margin-top:9px;flex-wrap:wrap}.rx-radar-btn{flex:1;min-height:41px;border-radius:11px;border:1px solid #2a4a64;background:#0b1d2d;color:#e9f4fc;font:inherit;font-size:10px;font-weight:950;text-decoration:none;display:flex;align-items:center;justify-content:center}.rx-radar-btn.on{background:linear-gradient(135deg,#209dcc,#5e67f4);border-color:#38b9e9;color:#06101b}.rx-radar-btn.off{background:#2a1519;border-color:#75404b;color:#ffdfe3}',
    '.rx-radar-alerts{margin-top:9px;padding-top:9px;border-top:1px solid #173247}.rx-radar-alert{padding:8px 9px;border:1px solid #163448;border-radius:10px;background:#06111b;font-size:9px;line-height:1.6;margin-top:6px}.rx-radar-alert b{font-size:10px}.rx-radar-alert small{display:block;color:#71899d;margin-top:2px}',
    '.rx-radar-empty{color:#637b90;font-size:9px}.rx-radar-foot{margin-top:10px;color:#678196;font-size:9px;line-height:1.7}'
  ].join('');
  document.head.appendChild(s);
}

function esc(v){return String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function fmt(v){return Number.isFinite(Number(v))?Number(v).toLocaleString('en-US',{maximumFractionDigits:8}):'—';}

export function mountBackgroundMonitorControl(root){
  if(!root||typeof document==='undefined')return{destroy(){}};
  addStyle();
  root.innerHTML='<section class="rx-radar-wrap"><div class="rx-radar-head"><div><div class="rx-radar-title">🛰️ الرادارات المستقلة</div><div class="rx-radar-sub">كل رادار يعمل ويُوقف بشكل مستقل. لا يتم خلط الإشعارات: اسم الرادار + العملة + وقت الاكتشاف 12 ساعة.</div></div><span class="rx-radar-badge"><span class="rx-radar-dot" id="rx-radar-live-dot"></span><span id="rx-radar-global">جارٍ التحقق</span></span></div><div class="rx-radar-grid" id="rx-radar-grid"></div><div class="rx-radar-foot">Spot فقط • Paper Trading • لا أوامر حقيقية • لا أسعار مستقبلية صناعية. لخفض استهلاك طلبات Binance تم رفع شروط الإشارة وتخفيض دورات الفحص.</div></section>';
  const grid=root.querySelector('#rx-radar-grid');
  const global=root.querySelector('#rx-radar-global');
  let destroyed=false,timer=null;

  function cardHtml(spec,status,alerts){
    const live=status?.running===true;
    const sourceAlerts=(alerts||[]).filter(x=>x.radar===spec.id).slice(0,3);
    return '<article class="rx-radar-card '+(live?'live':'')+'" style="border-color:'+esc(spec.color||'#1e3b52')+'66" data-radar="'+spec.id+'">'+
      '<div class="rx-radar-card-top"><div><div class="rx-radar-name">'+spec.icon+' '+esc(spec.name)+'</div><div class="rx-radar-desc">'+esc(spec.desc)+'</div><div class="rx-radar-algos">'+esc(spec.algos)+'</div></div>'+
      '<span class="rx-radar-badge"><span class="rx-radar-dot '+(live?'live':'')+'"></span>'+(live?'يعمل':'متوقف')+'</span></div>'+
      '<div class="rx-radar-actions"><button class="rx-radar-btn on" data-action="start" '+(live?'disabled':'')+'>تشغيل هذا الرادار</button><button class="rx-radar-btn off" data-action="stop" '+(live?'':'disabled')+'>إيقاف هذا الرادار</button><a class="rx-radar-btn" href="'+({
 EARLY_MOVE_RADAR:'./radar1-destroyer.html',
 STRONG_MOVE_RADAR:'./radar2-dark-king.html',
 ROTATION_LAG_RADAR:'./radar3-joker.html',
 LIQUIDITY_ABSORPTION_RADAR:'./radar4-sweeper.html',
 KAHIR_RADAR:'./kahir-radar.html',
 DOOMSDAY_RADAR:'./doomsday-radar.html',
 ALMUQAWIM_RADAR:'./al-muqawim-radar.html'
 }[spec.id]||'#')+'">فتح نافذة الرادار</a></div>'+
      '<div class="rx-radar-alerts"><b>آخر اكتشافات هذا الرادار</b>'+ (sourceAlerts.length?sourceAlerts.map(a=>'<div class="rx-radar-alert"><b>'+esc(a.symbol||'—')+'</b> • '+esc(a.potential_label||a.event||'اكتشاف')+' • '+esc(fmt(a.price))+'<small>'+esc(a.radar_name||spec.name)+' • وقت الاكتشاف: '+esc(a.detected_time_12h||'غير متاح')+'</small></div>').join(''):'<div class="rx-radar-empty">لا يوجد اكتشاف محفوظ في المدة المعروضة.</div>')+'</div>'+
      '</article>';
  }

  async function refresh(){
    if(destroyed)return;
    try{
      const [s,a]=await Promise.all([getRadarStatus(),getRadarAlerts({radar:'ALL',limit:20})]);
      const statuses=(s.ok&&Array.isArray(s.body?.radars)?s.body.radars:[]);
      const alerts=(a.ok&&Array.isArray(a.body?.alerts)?a.body.alerts:[]);
      const active=statuses.filter(x=>x.running).length;
      global.textContent=active?'يعمل '+active+' رادار':'كل الرادارات متوقفة';
      root.querySelector('#rx-radar-live-dot')?.classList.toggle('live',active>0);
      grid.innerHTML=RADARS.map(spec=>cardHtml(spec,statuses.find(x=>x.radar===spec.id),alerts)).join('');
      grid.querySelectorAll('[data-action]').forEach(btn=>btn.addEventListener('click',async()=>{
        const card=btn.closest('[data-radar]');const radar=card?.dataset.radar;const action=btn.dataset.action;
        if(!radar)return;
        btn.disabled=true;
        const r=await setRadarState(radar,action);
        if(!r.ok)global.textContent='تعذر تغيير حالة '+radar+' — '+String(r.body?.error||r.error||r.status);
        await refresh();
      }));
    }catch(e){
      global.textContent='Backend غير متاح';
    }
  }
  refresh();
  timer=setInterval(refresh,15000);
  return {destroy(){destroyed=true;if(timer)clearInterval(timer);root.innerHTML='';}};
}
