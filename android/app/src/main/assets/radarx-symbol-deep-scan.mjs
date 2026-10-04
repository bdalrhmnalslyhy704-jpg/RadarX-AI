import {getSymbolDeepScan} from './radarx-backend-client.mjs';

const STYLE_ID='radarx-symbol-deep-style';

const esc=value=>String(value??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const num=(v,d=2)=>{
  const n=Number(v);
  return Number.isFinite(n)?n.toLocaleString('en-US',{maximumFractionDigits:d}):'—';
};
const pct=(v,d=2)=>{
  const n=Number(v);
  return Number.isFinite(n)?(n>=0?'+':'')+n.toFixed(d)+'%':'—';
};
const scoreClass=v=>Number(v)>=67?'up':Number(v)<=33?'down':'mid';
const dirText=v=>v==='UPWARD_BIAS'?'ميل صاعد':v==='DOWNWARD_BIAS'?'ميل هابط':'محايد / نطاقي';

function injectStyle(){
  if(document.getElementById(STYLE_ID))return;
  const style=document.createElement('style');
  style.id=STYLE_ID;
  style.textContent=' #radarx-symbol-deep{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f7f3ff} .rxd-wrap{display:grid;gap:12px;margin-top:14px} .rxd-card{background:linear-gradient(145deg,#160c2c,#0b1020 70%);border:1px solid #4c2b75;border-radius:20px;box-shadow:0 14px 35px rgba(20,5,45,.25);overflow:hidden} .rxd-head{padding:15px;background:radial-gradient(circle at 100% 0,#33205b 0,#17102a 46%,#100b1d 100%)} .rxd-kicker{color:#bda7ff;font-size:10px;font-weight:1000;letter-spacing:.8px} .rxd-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:5px} .rxd-title h2{margin:0;font-size:21px}.rxd-badge{padding:6px 9px;border-radius:999px;border:1px solid #6c4ca0;background:#1f133b;color:#d9cbff;font-size:10px;font-weight:1000} .rxd-sub{margin:5px 0 0;color:#b7acc7;font-size:11px;line-height:1.6} .rxd-form{display:grid;grid-template-columns:1fr;gap:8px;margin-top:12px} .rxd-input{height:48px;border:1px solid #684394;border-radius:14px;background:#0d0b18;color:#fff;padding:0 14px;font:inherit;font-size:15px;font-weight:900;outline:none} .rxd-input:focus{border-color:#a174ff;box-shadow:0 0 0 3px rgba(161,116,255,.12)} .rxd-btn{height:48px;border:1px solid #8b62d4;border-radius:14px;background:linear-gradient(135deg,#7c3aed,#22d3ee);color:#07101a;font:inherit;font-weight:1000;cursor:pointer} .rxd-btn:disabled{opacity:.55;cursor:wait} .rxd-note{padding:10px 12px;border-top:1px solid #2a1d3f;color:#9d93ad;font-size:10px} .rxd-status{padding:10px 12px;border-radius:13px;border:1px solid #3a2b59;background:#0b0b17;color:#bcb1ca;font-size:11px} .rxd-status.err{border-color:#813f57;color:#ffc2d2}.rxd-status.ok{border-color:#2f7b68;color:#bff5e6} .rxd-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;padding:12px} .rxd-metric{padding:11px;border:1px solid #302045;border-radius:14px;background:#0c0a16} .rxd-metric span{display:block;color:#988ea7;font-size:10px}.rxd-metric b{display:block;margin-top:5px;font-size:18px} .rxd-section{padding:12px;border-top:1px solid #291a3c} .rxd-section h3{margin:0 0 9px;font-size:14px} .rxd-read{padding:13px;border-radius:15px;border:1px solid #5b3a88;background:linear-gradient(135deg,#20113d,#101421)} .rxd-read-top{display:flex;align-items:center;justify-content:space-between;gap:8px}.rxd-read strong{font-size:18px}.rxd-score{font-size:12px;color:#d5c8f0} .rxd-bar{height:9px;border-radius:999px;background:#0a0a12;overflow:hidden;margin-top:9px;border:1px solid #28183d}.rxd-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#22d3ee,#8b5cf6);transition:width .35s ease} .rxd-pill{display:inline-flex;padding:6px 9px;border-radius:999px;border:1px solid #402d5e;background:#120d20;color:#cfc3e8;font-size:10px;font-weight:900} .rxd-pill.up{border-color:#28765f;color:#b6f1dd}.rxd-pill.down{border-color:#813f57;color:#ffc1cd}.rxd-pill.mid{border-color:#7d6837;color:#ffe5aa} .rxd-zonegrid{display:grid;grid-template-columns:1fr;gap:8px} .rxd-zone{padding:11px;border-radius:14px;background:#0b0a16;border:1px solid #2a2039}.rxd-zone b{display:block;margin-top:4px;font-size:17px} .rxd-zone.support{border-color:#245e57}.rxd-zone.resistance{border-color:#6e394a} .rxd-row{display:grid;grid-template-columns:92px 1fr;gap:8px;padding:9px 0;border-bottom:1px solid #241936;font-size:11px}.rxd-row:last-child{border-bottom:0}.rxd-row span{color:#968aa4}.rxd-row b{text-align:left;direction:ltr} .rxd-tf{display:grid;gap:8px} .rxd-tf-card{padding:11px;border:1px solid #2b203d;border-radius:14px;background:#0b0915} .rxd-tf-head{display:flex;align-items:center;justify-content:space-between}.rxd-tf-head b{font-size:14px}.rxd-mini{font-size:10px;color:#a69ab5} .rxd-chiprow{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}.rxd-chip{padding:5px 8px;border-radius:999px;background:#130e21;border:1px solid #33234a;color:#cfc4df;font-size:10px} .rxd-algos{display:flex;flex-wrap:wrap;gap:6px}.rxd-algos span{padding:6px 8px;border-radius:999px;background:#120d20;border:1px solid #392752;color:#c9bed7;font-size:10px} .rxd-foot{padding:11px;color:#8e839d;font-size:10px;line-height:1.6} @media(min-width:680px){.rxd-form{grid-template-columns:1fr 170px}.rxd-grid{grid-template-columns:repeat(4,1fr)}.rxd-zonegrid{grid-template-columns:repeat(2,1fr)}.rxd-tf{grid-template-columns:repeat(3,1fr)}}`;`;';
  document.head.appendChild(style);
}

function metric(label,value){
  return '<div class="rxd-metric"><span>'+esc(label)+'</span><b>'+esc(value)+'</b></div>';
}

function timeframeCard(row){
  if(!row)return '';
  const bias=Number(row.trend_score)>=67?'صاعد':Number(row.trend_score)<=33?'هابط':'مختلط';
  return '<article class="rxd-tf-card"><div class="rxd-tf-head"><b>'+esc(row.timeframe)+'</b><span class="rxd-mini">'+esc(bias)+'</span></div>' +
    '<div class="rxd-chiprow">' +
    '<span class="rxd-chip">Trend '+esc(num(row.trend_score,0))+'</span>' +
    '<span class="rxd-chip">Momentum '+esc(num(row.momentum_score,0))+'</span>' +
    '<span class="rxd-chip">RSI '+esc(num(row.rsi14,1))+'</span>' +
    '<span class="rxd-chip">ADX '+esc(num(row.adx,1))+'</span>' +
    '</div>' +
    '<div class="rxd-row"><span>EMA20</span><b>'+esc(num(row.ema20,8))+'</b></div>' +
    '<div class="rxd-row"><span>EMA50</span><b>'+esc(num(row.ema50,8))+'</b></div>' +
    '<div class="rxd-row"><span>VWAP</span><b>'+esc(num(row.vwap,8))+'</b></div>' +
    '<div class="rxd-row"><span>RVOL</span><b>'+esc(num(row.rvol,2))+'×</b></div>' +
    '<div class="rxd-row"><span>ارتداد</span><b>'+esc(row.bullish_rejection?'صعودي':row.bearish_rejection?'هبوطي':'لا يوجد تأكيد')+'</b></div>' +
    '</article>';
}

function renderResult(root,data){
  const a=data.assessment||{},p=data.price||{},z=data.zones||{},press=data.pressure||{},liq=data.liquidity||{},mom=data.momentum||{};
  const cls=scoreClass(a.direction_score);
  root.querySelector('[data-rxd-output]').innerHTML=
    '<section class="rxd-section"><div class="rxd-read"><div class="rxd-read-top"><strong>'+esc(a.market_read||dirText(a.direction_bias))+'</strong><span class="rxd-pill '+cls+'">'+esc(dirText(a.direction_bias))+'</span></div>' +
      '<div class="rxd-bar"><div class="rxd-fill" style="width:'+Math.max(2,Math.min(100,Number(a.direction_score)||0))+'%"></div></div>' +
      '<div style="display:flex;justify-content:space-between;gap:8px;margin-top:7px"><span class="rxd-score">ميل الحركة: '+esc(num(a.direction_score,1))+'/100</span><span class="rxd-score">Trap Risk: '+esc(num(a.trap_risk,0))+'%</span></div></div></section>' +
    '<div class="rxd-grid">'+metric('السعر الحالي',p.last==null?'غير متاح':num(p.last,8))+metric('تغير 24h',pct(p.change_24h_pct))+metric('السيولة',num(liq.score,0)+'/100')+metric('ضغط الشراء/البيع',num(press.score,0)+'/100')+'</div>' +
    '<section class="rxd-section"><h3>🧠 القراءة المركبة</h3><div class="rxd-row"><span>الزخم</span><b>'+esc(num(mom.score,1))+'/100 • '+esc(mom.state||'MIXED')+'</b></div><div class="rxd-row"><span>ضغط السوق</span><b>'+esc(press.reading||'—')+'</b></div><div class="rxd-row"><span>سياق الحركة</span><b>'+esc(a.signal_context||'WAIT_FOR_CONFIRMATION')+'</b></div><div class="rxd-row"><span>قوة التحليل</span><b>'+esc(num(a.analysis_strength,1))+'/100</b></div></section>' +
    '<section class="rxd-section"><h3>🎯 الدعم والمقاومة ومنطق الارتداد</h3><div class="rxd-zonegrid"><div class="rxd-zone support"><span>أقرب دعم</span><b>'+esc(num(z.support,8))+'</b><small>'+esc(z.distance_to_support_pct==null?'لا يوجد مستوى قريب':num(z.distance_to_support_pct,2)+'% فوق الدعم')+'</small></div><div class="rxd-zone resistance"><span>أقرب مقاومة</span><b>'+esc(num(z.resistance,8))+'</b><small>'+esc(z.distance_to_resistance_pct==null?'لا يوجد مستوى قريب':num(z.distance_to_resistance_pct,2)+'% تحت المقاومة')+'</small></div></div><div class="rxd-row"><span>الموقع</span><b>'+esc(z.position||'UNKNOWN')+'</b></div><div class="rxd-row"><span>الارتداد</span><b>'+esc(z.bounce_signal||'NOT_CONFIRMED')+'</b></div><div class="rxd-row"><span>النتيجة</span><b>'+esc(z.retest||'NO_RETEST')+'</b></div></section>' +
    '<section class="rxd-section"><h3>⏱️ توافق الأطر الزمنية</h3><div class="rxd-tf">'+timeframeCard(data.timeframes?.['15m'])+timeframeCard(data.timeframes?.['1h'])+timeframeCard(data.timeframes?.['4h'])+'</div></section>' +
    '<section class="rxd-section"><h3>💧 عمق السيولة والصفقات</h3><div class="rxd-row"><span>حجم 24h</span><b>'+esc(num(liq.quote_volume_24h,0))+'</b></div><div class="rxd-row"><span>Taker Buy</span><b>'+esc(press.taker_buy_ratio==null?'—':(Number(press.taker_buy_ratio)*100).toFixed(1)+'%')+'</b></div><div class="rxd-row"><span>Order Book Imbalance</span><b>'+esc(num(press.orderbook_imbalance,3))+'</b></div><div class="rxd-row"><span>عمق ±0.5%</span><b>'+esc(num(liq.near_book_notional,0))+'</b></div></section>' +
    '<section class="rxd-section"><h3>🔬 الخوارزميات المستخدمة</h3><div class="rxd-algos">'+(data.algorithms||[]).map(x=>'<span>'+esc(x)+'</span>').join('')+'</div></section>' +
    '<section class="rxd-section"><h3>✅ جودة البيانات</h3><div class="rxd-row"><span>الدرجة</span><b>'+esc(num(data.data_quality?.score,0))+'/100</b></div><div class="rxd-row"><span>الشموع</span><b>'+esc(num(data.data_quality?.closed_candles,0))+' مغلقة</b></div><div class="rxd-row"><span>المصدر</span><b>'+esc(data.data_quality?.source||'Binance Public REST')+'</b></div></section>';
  const warnings=Array.isArray(data?.meta?.source_warnings)?data.meta.source_warnings:[];
  const liveNow=Boolean(data?.meta?.live&&data?.price?.last);
  const statusNode=root.querySelector('[data-rxd-status]');
  statusNode.className='rxd-status ok';
  statusNode.textContent=liveNow
    ? 'تم الفحص بالبيانات العامة، والتحليل استخدم الشموع المغلقة فقط.'
    : 'تم التحليل من الشموع المغلقة؛ السعر الحي الكامل غير متاح الآن.';
  const warnText=warnings.length?' • '+warnings.join(' • '):'';
  if(warnings.length)statusNode.textContent+=warnText;
}

export function buildSymbolDeepScanShell(){
  return '<div id="radarx-symbol-deep" class="rxd-wrap"><section class="rxd-card"><div class="rxd-head"><div class="rxd-kicker">RADARX • DEEP SYMBOL LAB</div><div class="rxd-title"><h2>🔮 فاحص العملة الشامل</h2><span class="rxd-badge">SPOT • READ ONLY</span></div><p class="rxd-sub">اكتب اسم العملة أو الزوج، ثم افحص السيولة والزخم والشراء/البيع والدعم والمقاومة ومنطق الارتداد عبر 15m / 1h / 4h.</p><form class="rxd-form" data-rxd-form><input class="rxd-input" data-rxd-symbol inputmode="text" autocomplete="off" placeholder="مثال: SAND أو SANDUSDT" aria-label="اسم العملة"/><button class="rxd-btn" type="submit" data-rxd-submit>ابدأ الفحص الشامل</button></form><div class="rxd-status" data-rxd-status style="margin-top:10px">جاهز — اكتب الرمز واضغط فحص شامل.</div></div><div data-rxd-output><div class="rxd-note">الفحص لا ينفذ أي أوامر. القراءة تصف حالة السوق وقت الفحص وليست ضمانًا بأن السعر سيرتفع أو ينخفض.</div></div></section></div>';
}

export function mountSymbolDeepScan(root,options={}){
  if(!root||typeof document==='undefined')return{destroy(){}};
  injectStyle();
  root.innerHTML=buildSymbolDeepScanShell();
  const client=options.client||{getSymbolDeepScan};
  const form=root.querySelector('[data-rxd-form]');
  const input=root.querySelector('[data-rxd-symbol]');
  const submit=root.querySelector('[data-rxd-submit]');
  const status=root.querySelector('[data-rxd-status]');
  let destroyed=false;

  async function run(raw){
    const symbol=String(raw||'').trim().toUpperCase();
    if(!/^[A-Z0-9_\/-]{2,20}$/.test(symbol)){status.className='rxd-status err';status.textContent='اكتب رمزًا صحيحًا مثل SAND أو SANDUSDT.';return;}
    submit.disabled=true;submit.textContent='جاري الفحص…';
    status.className='rxd-status';status.textContent='جاري جلب 15m + 1h + 4h ودفتر الأوامر…';
    try{
      const response=await client.getSymbolDeepScan(symbol);
      if(destroyed)return;
      if(response?.status!==200||!response?.ok||response?.body?.status!=='ok'){
        const technical=response?.body?.error||response?.error||('HTTP_'+String(response?.status||0));
        throw new Error(response?.status===503?'BINANCE_TEMPORARY_UNAVAILABLE:'+technical:technical);
      }
      renderResult(root,response.body);
    }catch(error){
      status.className='rxd-status err';
      const msg=String(error?.message||error||'تعذر إكمال الفحص.');
      status.textContent=msg.includes('BINANCE_TEMPORARY_UNAVAILABLE')
        ? 'مصدر Binance غير متاح مؤقتًا — أعد المحاولة، ولن يتم عرض سعر أو بيانات وهمية.'
        : msg;
      root.querySelector('[data-rxd-output]').innerHTML='<div class="rxd-note">لا توجد بيانات اصطناعية: إذا كان سعر السوق الحي أو دفتر الأوامر غير متاح، سيُظهر التطبيق ذلك صراحةً ويحتفظ فقط بالبيانات الحقيقية من الشموع المغلقة.</div>';
    }finally{
      submit.disabled=false;submit.textContent='ابدأ الفحص الشامل';
    }
  }

  form.addEventListener('submit',e=>{e.preventDefault();run(input.value);});
  input.addEventListener('input',()=>{input.value=input.value.toUpperCase().replace(/[^A-Z0-9_\/-]/g,'');});
  return {refresh:()=>run(input.value),destroy(){destroyed=true;root.innerHTML='';}};
}
