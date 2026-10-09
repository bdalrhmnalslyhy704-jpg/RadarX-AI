
import { getMarketRadar, getSymbolDeepScan, getRadarAlerts } from './radarx-backend-client.mjs';

const esc = (v) => String(v || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = (v,d=2) => Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—';
const percent = (v,d=1) => Number.isFinite(Number(v)) ? Number(v).toFixed(d) + '%' : '—';

function addStyle() {
  if (document.getElementById('rx-suite-style')) return;
  const s = document.createElement('style');
  s.id = 'rx-suite-style';
  s.textContent =
    '.rxsuite{margin-top:12px;background:#0b1820;border:1px solid #1d3944;border-radius:17px;padding:14px}' +
    '.rxsuite-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin:12px 0}' +
    '.rxsuite-tab{min-height:44px;border:1px solid #234651;background:#08131a;color:#dff2f6;border-radius:11px;font:inherit;font-weight:900}' +
    '.rxsuite-tab.active{border-color:#35c9ff;background:linear-gradient(135deg,#112f40,#182748);box-shadow:0 5px 16px rgba(53,201,255,.12)}' +
    '.rxsuite-pane{display:none;background:#08131a;border:1px solid #17313a;border-radius:13px;padding:12px}' +
    '.rxsuite-pane.active{display:block}' +
    '.rxsuite-form{display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
    '.rxsuite-field{display:flex;flex-direction:column;gap:5px}.rxsuite-full{grid-column:1/-1}' +
    '.rxsuite-field label{font-size:11px;color:#8da7b1;font-weight:800}' +
    '.rxsuite-input,.rxsuite-select,.rxsuite-ta{min-height:44px;border:1px solid #2a4c58;border-radius:10px;background:#071018;color:#fff;padding:9px 11px;font:inherit}' +
    '.rxsuite-ta{min-height:110px;resize:vertical}' +
    '.rxsuite-actions{display:flex;gap:8px;margin-top:9px}.rxsuite-btn{flex:1;min-height:44px;border:1px solid #2a4c58;border-radius:10px;background:#10242c;color:#fff;font:inherit;font-weight:900}' +
    '.rxsuite-btn.primary{border-color:#3f9fb7;background:#123341}' +
    '.rxsuite-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:9px}' +
    '.rxsuite-box{padding:9px;border:1px solid #17313a;border-radius:10px;background:#071018}' +
    '.rxsuite-box span{display:block;color:#8da7b1;font-size:10px}.rxsuite-box b{display:block;margin-top:3px;font-size:15px}' +
    '.rxsuite-agents{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:9px}' +
    '.rxsuite-agent{padding:9px;border:1px solid #17313a;border-radius:10px;background:#071018}' +
    '.rxsuite-agent-top{display:flex;justify-content:space-between;font-size:11px;font-weight:900}' +
    '.rxsuite-meter{height:6px;background:#11272f;border-radius:99px;margin-top:7px;overflow:hidden}.rxsuite-meter i{display:block;height:100%;background:#54d5ff}' +
    '.rxsuite-tag{display:inline-flex;padding:5px 7px;border:1px solid #2a4c58;border-radius:999px;font-size:10px;font-weight:900}' +
    '.rxsuite-ok{border-color:#268c68;color:#b5f5da}.rxsuite-bad{border-color:#9b4651;color:#ffc4ca}.rxsuite-warn{border-color:#90713a;color:#ffe0a0}' +
    '.rxsuite-row{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:9px;border:1px solid #17313a;border-radius:10px;background:#071018;margin-top:7px}' +
    '.rxsuite-row small{display:block;color:#8da7b1;margin-top:2px}.rxsuite-images{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:7px}.rxsuite-thumb{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:8px;border:1px solid #244550}' +
    '@media(max-width:700px){.rxsuite-tabs{grid-template-columns:repeat(2,minmax(0,1fr))}.rxsuite-form{grid-template-columns:1fr}.rxsuite-full{grid-column:auto}.rxsuite-grid,.rxsuite-agents{grid-template-columns:repeat(2,minmax(0,1fr))}}' +
    '.rxsuite-live{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;background:linear-gradient(135deg,#0f2031,#101a2b);border:1px solid #294d6a;border-radius:12px;margin:9px 0}' +'.rxsuite-live-dot{width:9px;height:9px;border-radius:50%;background:#ffd166;box-shadow:0 0 12px rgba(255,209,102,.45)}' +'.rxsuite-title{display:flex;align-items:center;justify-content:space-between;gap:10px}.rxsuite-sub{font-size:11px;color:#8ea6b8;margin-top:3px}' +'.rxsuite-copy{min-height:38px;padding:0 11px;border-radius:9px;border:1px solid #355977;background:#0e2131;color:#e8f5ff;font:inherit;font-weight:900}' +'.rxsuite-danger{border-color:#7b4653;background:#2a1720}.rxsuite-safe{border-color:#2e7f65;background:#10261f}' +'@media(max-width:450px){.rxsuite-grid,.rxsuite-agents,.rxsuite-images{grid-template-columns:1fr}}';
  s.textContent +=
    '.rxsuite{position:relative;overflow:hidden;border-color:rgba(76,202,255,.28);background:radial-gradient(circle at 100% 0%,rgba(57,137,255,.12),transparent 34%),linear-gradient(150deg,#0b1b2b,#07111b 72%);box-shadow:0 18px 42px rgba(0,0,0,.27),inset 0 1px 0 rgba(255,255,255,.035)}' +
    '.rxsuite:before{content:"";position:absolute;top:0;left:12px;right:12px;height:2px;background:linear-gradient(90deg,transparent,#50ddff,#8b7cff,#ffd166,transparent);opacity:.8;pointer-events:none}' +
    '.rxsuite-tabs{gap:8px}.rxsuite-tab{box-shadow:inset 0 1px 0 rgba(255,255,255,.025);transition:transform .16s ease,border-color .16s ease,background .16s ease}.rxsuite-tab:active,.rxsuite-btn:active{transform:translateY(1px)}' +
    '.rxsuite-pane{background:linear-gradient(155deg,rgba(10,24,37,.98),rgba(5,13,22,.98));border-color:rgba(88,167,197,.23);box-shadow:inset 0 1px 0 rgba(255,255,255,.02)}' +
    '.rxsuite-box,.rxsuite-agent{background:linear-gradient(145deg,rgba(13,29,43,.95),rgba(6,15,24,.96));border-color:rgba(83,154,184,.22)}' +
    '.rxsuite-live{background:linear-gradient(115deg,rgba(16,44,61,.92),rgba(20,23,48,.92));border-color:rgba(67,192,232,.28);box-shadow:0 8px 22px rgba(0,0,0,.16)}' +
    '.rxsuite-chart{margin:9px 0;padding:10px;border:1px solid rgba(79,176,208,.28);border-radius:13px;background:linear-gradient(160deg,#081725,#07111a);overflow:hidden}.rxsuite-chart-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}.rxsuite-chart-head b{font-size:12px}.rxsuite-chart-head small,.rxsuite-chart-note{color:#8da7b1;font-size:10px}.rxsuite-chart svg{display:block;width:100%;height:auto;overflow:visible}.rxsuite-chart-note{display:block;margin-top:5px;line-height:1.6}' +
    '@media(max-width:380px){.rxsuite{padding:10px}.rxsuite-tabs{gap:6px}.rxsuite-tab{font-size:11px;min-height:42px}.rxsuite-chart{padding:7px}.rxsuite-chart-head{align-items:flex-start;flex-direction:column}}';
  document.head.appendChild(s);
}

let marketCache = null;
let marketCacheAt = 0;
const MARKET_CACHE_MS = 5000;
const MARKET_STORAGE_KEY = 'radarx.tradli.lastMarket.v1';
const MARKET_FALLBACK_MAX_AGE_MS = 10 * 60 * 1000;

function readStoredMarket() {
  try {
    const raw = localStorage.getItem(MARKET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.body || !Number.isFinite(parsed.savedAt)) return null;
    if (Date.now() - parsed.savedAt > MARKET_FALLBACK_MAX_AGE_MS) return null;
    return Object.assign({}, parsed.body, {
      __transportFallback: true,
      __transportAgeMs: Date.now() - parsed.savedAt
    });
  } catch {
    return null;
  }
}

function storeMarket(body) {
  try {
    localStorage.setItem(MARKET_STORAGE_KEY, JSON.stringify({
      savedAt: Date.now(),
      body
    }));
  } catch {}
}

async function market() {
  const now = Date.now();
  if (marketCache && now - marketCacheAt < MARKET_CACHE_MS) return marketCache;

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await getMarketRadar({quote:'USDT',limit:20});
      if (r.ok && r.body && Array.isArray(r.body.candidates)) {
        marketCache = r.body;
        marketCacheAt = Date.now();
        storeMarket(r.body);
        return marketCache;
      }
      lastError = new Error('MARKET_RADAR_HTTP_' + String(r.status || 0));
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 900 * (attempt + 1)));
  }

  const stored = readStoredMarket();
  if (stored) {
    marketCache = stored;
    marketCacheAt = Date.now();
    return stored;
  }

  throw lastError || new Error('MARKET_RADAR_UNAVAILABLE');
}

function findCandidate(body,symbol) {
  return (body.candidates || []).find(x => String(x.symbol).toUpperCase() === symbol.toUpperCase());
}

function marketNotice(body) {
  if (body?.__transportFallback) {
    const age = Math.max(0,Number(body.__transportAgeMs)||0);
    const mins = Math.max(1,Math.round(age/60000));
    return '<div class="rxsuite-row"><div><b>بيانات محفوظة — ليست حية</b><small>فشل الاتصال بالخادم؛ آخر نسخة محفوظة منذ '+mins+' دقيقة تقريبًا. لا تستخدمها لاتخاذ قرار تداول.</small></div><span class="rxsuite-tag rxsuite-warn">CACHED</span></div>';
  }
  if (body?.meta?.live === false || body?.meta?.data_stale === true) {
    return '<div class="rxsuite-row"><div><b>الخادم ردّ لكن البيانات غير مؤكدة كبيانات حية</b><small>انتظر تحديث المصدر؛ لا تُعامل هذه النتيجة كإشارة دخول حديثة.</small></div><span class="rxsuite-tag rxsuite-warn">NOT LIVE</span></div>';
  }
  return '<div class="rxsuite-row"><div><b>مصدر النتيجة: خادم RadarX</b><small>افحص حالة بيانات الرمز داخل التقرير؛ اتصال الخادم وحده لا يثبت صلاحية فرصة تداول.</small></div><span class="rxsuite-tag rxsuite-safe">BACKEND RESPONSE</span></div>';
}

function requireFreshMarket(body) {
  if (body?.__transportFallback) throw new Error('SAVED_DATA_NOT_VALID_FOR_TRADE_REVIEW');
  if (body?.meta?.live === false || body?.meta?.data_stale === true) throw new Error('LIVE_MARKET_DATA_NOT_CONFIRMED');
}

async function deepScan(symbol) {
  const response = await getSymbolDeepScan(symbol);
  if (!response?.ok || response.status !== 200 || response.body?.status !== 'ok') {
    const detail = response?.body?.error || response?.body?.code || response?.error || ('HTTP_' + String(response?.status || 0));
    throw new Error('DEEP_SCAN_' + detail);
  }
  const scan = response.body;
  if (scan.paper_trading !== true || scan.real_order_execution !== false ||
      scan.meta?.paper_trading !== true || scan.meta?.real_order_execution !== false ||
      scan.confidence_score !== 'UNKNOWN' || scan.meta?.confidence_score !== 'UNKNOWN') {
    throw new Error('DEEP_SCAN_SAFETY_CONTRACT_INVALID');
  }
  return scan;
}

function requireLiveDeepScan(scan) {
  if (scan?.meta?.live !== true || !Number.isFinite(Number(scan?.price?.last)) || Number(scan.price.last) <= 0) {
    throw new Error('LIVE_PRICE_NOT_AVAILABLE');
  }
}

function deepNotice(scan) {
  const live = scan?.meta?.live === true && Number(scan?.price?.last) > 0;
  const warnings = Array.isArray(scan?.meta?.source_warnings) ? scan.meta.source_warnings : [];
  const text = live
    ? 'آخر سعر مستلم من الخادم '+num(scan.price.last,8)+' • تحليل شموع مغلقة 15m / 1h / 4h'
    : 'التحليل الفني وصل، لكن السعر الحي غير متاح. لن نعرضه كفرصة حية.';
  const warningText = warnings.length ? ' • تنبيهات المصدر: '+warnings.join(', ') : '';
  return '<div class="rxsuite-row"><div><b>'+(live?'تحليل عميق من الخادم':'بيانات غير مكتملة')+'</b><small>'+esc(text+warningText)+'</small></div><span class="rxsuite-tag '+(live?'rxsuite-ok':'rxsuite-warn')+'">'+(live?'LIVE PRICE':'CHECK DATA')+'</span></div>';
}

function signalTime(row) {
  if (row?.detected_time_12h) return String(row.detected_time_12h);
  const raw = row?.detected_at ?? row?.processed_at;
  if (raw == null) return '—';
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return '—';
  try { return new Intl.DateTimeFormat('ar-YE',{timeZone:'Asia/Aden',hour:'2-digit',minute:'2-digit',hour12:true}).format(date); }
  catch { return date.toISOString(); }
}

function levelsFor(frame,key,price) {
  const rows = Array.isArray(frame?.[key]) ? frame[key] : [];
  const out = rows.map(x => {
    const level = Number(typeof x === 'number' ? x : (x?.price ?? x?.level ?? x?.value));
    if (!Number.isFinite(level) || level <= 0) return null;
    return {price:level,touches:Number(x?.touches)||0,distance:price>0?Math.abs(level-price)/price*100:Infinity};
  }).filter(Boolean).sort((a,b)=>a.distance-b.distance);
  return out.slice(0,3);
}
function agents(c) {
  const ss = Array.isArray(c && c.strategies) ? c.strategies : [];
  const m = Object.fromEntries(ss.map(x => [x.id,x]));
  const fp = c && c.pre_breakout_fingerprint || {};
  const e = fp.evidence || {};
  const rows = [
    ['Trend',m.MTF_TREND && m.MTF_TREND.score || 50],
    ['Structure',e.structure && e.structure.score || (fp.context && fp.context.breakout ? 82 : 50)],
    ['Momentum',c && c.price_change_24h == null ? 50 : Math.max(0,Math.min(100,50 + Number(c.price_change_24h)*4))],
    ['Volume',Math.max(0,Math.min(100,50 + ((Number(e.volume && e.volume.rvol)||1)-1)*35))],
    ['Liquidity',c && c.liquidity_quality || 50],
    ['RSI / Exhaustion',100-(m.MEAN_REVERSION && m.MEAN_REVERSION.score || 45)],
    ['MACD Continuation',m.MACD_TREND_CONTINUATION && m.MACD_TREND_CONTINUATION.score || 50],
    ['VWAP Position',m.VWAP_POSITION && m.VWAP_POSITION.score || m.VWAP_REVERSION && m.VWAP_REVERSION.score || 50],
    ['Volatility',m.ATR_EXPANSION && m.ATR_EXPANSION.score || 50],
    ['Breakout',m.CONFIRMED_BREAKOUT && m.CONFIRMED_BREAKOUT.score || 50],
    ['Mean Reversion',m.MEAN_REVERSION && m.MEAN_REVERSION.score || 50],
    ['Market Regime',e.regime && e.regime.score || 50]
  ];
  return '<div class="rxsuite-agents">' + rows.map(x =>
    '<div class="rxsuite-agent"><div class="rxsuite-agent-top"><span>' + esc(x[0]) + '</span><b>' + num(x[1],0) + '</b></div><div class="rxsuite-meter"><i style="width:' + Math.max(0,Math.min(100,Number(x[1])||0)) + '%"></i></div></div>'
  ).join('') + '</div>';
}
function box(a,b) {
  return '<div class="rxsuite-box"><span>' + esc(a) + '</span><b>' + esc(b) + '</b></div>';
}

function renderCandleChart(rawCandles,timeframe='15m') {
  const rows=(Array.isArray(rawCandles)?rawCandles:[]).filter(c=>{
    const values=[c?.open_time,c?.close_time,c?.open,c?.high,c?.low,c?.close,c?.volume].map(Number);
    return values.every(Number.isFinite)&&Number(c.close_time)<=Date.now()&&Number(c.open_time)<Number(c.close_time)&&
      Number(c.low)>0&&Number(c.high)>=Number(c.low)&&Number(c.volume)>=0;
  }).slice(-48);
  const title={'15m':'15m · حركة قصيرة','1h':'1h · حركة متوسطة','4h':'4h · اتجاه أوسع'}[timeframe]||timeframe;
  if(rows.length<3)return '<section class="rxsuite-chart"><div class="rxsuite-chart-head"><b>Chart Lab · '+esc(title)+'</b><span class="rxsuite-tag rxsuite-warn">NO CANDLES</span></div><small class="rxsuite-chart-note">لم تصل 3 شموع مغلقة صالحة على هذا الإطار. أعد الفحص عند استقرار اتصال الخادم.</small></section>';
  const high=Math.max(...rows.map(x=>Number(x.high)));
  const low=Math.min(...rows.map(x=>Number(x.low)));
  const span=Math.max(high-low,Math.abs(high)*1e-8,1e-12);
  const y=value=>6+((high-Number(value))/span)*68;
  const step=300/rows.length;
  const bodyWidth=Math.max(2,Math.min(7,step*.58));
  const maxVolume=Math.max(1,...rows.map(x=>Number(x.volume)));
  const grid=[8,42,76].map(gy=>'<line x1="3" y1="'+gy+'" x2="317" y2="'+gy+'" stroke="#20394b" stroke-width=".7" stroke-dasharray="3 4"/>').join('');
  const candles=rows.map((c,i)=>{
    const x=3+i*step+step/2;
    const openY=y(c.open),closeY=y(c.close),top=Math.min(openY,closeY),height=Math.max(1,Math.abs(closeY-openY));
    const up=Number(c.close)>=Number(c.open),color=up?'#49e3b0':'#ff748c';
    const volumeHeight=Math.max(1,Number(c.volume)/maxVolume*14);
    return '<line x1="'+x.toFixed(2)+'" y1="'+y(c.high).toFixed(2)+'" x2="'+x.toFixed(2)+'" y2="'+y(c.low).toFixed(2)+'" stroke="'+color+'" stroke-width="1.1"/>'+
      '<rect x="'+(x-bodyWidth/2).toFixed(2)+'" y="'+top.toFixed(2)+'" width="'+bodyWidth.toFixed(2)+'" height="'+height.toFixed(2)+'" rx=".6" fill="'+color+'"/>'+
      '<rect x="'+(x-bodyWidth/2).toFixed(2)+'" y="'+(106-volumeHeight).toFixed(2)+'" width="'+bodyWidth.toFixed(2)+'" height="'+volumeHeight.toFixed(2)+'" rx=".4" fill="'+color+'" opacity=".48"/>';
  }).join('');
  const latest=rows.at(-1);
  return '<section class="rxsuite-chart"><div class="rxsuite-chart-head"><b>Chart Lab · '+esc(title)+'</b><span class="rxsuite-tag rxsuite-safe">BINANCE · CLOSED</span></div>'+
    '<svg viewBox="0 0 320 112" role="img" aria-label="Candlestick chart '+esc(timeframe)+'">'+grid+candles+'<line x1="3" y1="91" x2="317" y2="91" stroke="#284456" stroke-width=".7"/></svg>'+
    '<div class="rxsuite-chart-head"><small>High '+num(high,8)+' · Low '+num(low,8)+'</small><small>آخر إغلاق '+num(latest.close,8)+'</small></div>'+
    '<small class="rxsuite-chart-note">شارت شموع من بيانات الخادم، لا من رسم توضيحي. تُستبعد الشمعة المفتوحة أو المستقبلية قبل العرض؛ ورفع صورة خارجية يعرضها محليًا فقط دون ادعاء تحليل بصري لها.</small></section>';
}

function chartPanel(root) {
  root.innerHTML =
    '<div class="rxsuite-form">' +
    '<div class="rxsuite-field"><label>الرمز</label><input id="rx-cs" class="rxsuite-input" value="BTCUSDT"></div>' +
    '<div class="rxsuite-field"><label>الإطار الزمني</label><select id="rx-cm" class="rxsuite-select"><option value="15m">15m · قصير</option><option value="1h">1h · متوسط</option><option value="4h">4h · اتجاه</option></select></div>' +
    '<div class="rxsuite-field rxsuite-full"><label>لقطات الشارت حتى 4</label><input id="rx-cf" class="rxsuite-input" type="file" accept="image/*" multiple></div>' +
    '</div><div id="rx-ci" class="rxsuite-images"></div>' +
    '<div class="rxsuite-actions"><button id="rx-cr" class="rxsuite-btn primary">تحليل الشارت + السوق</button></div>' +
    '<div id="rx-co"><p class="rxsuite-row">الصور تُعاين محليًا. التحليل الرقمي يعتمد على بيانات RadarX الحية.</p></div>';
  const f=root.querySelector('#rx-cf'), pv=root.querySelector('#rx-ci');
  f.onchange = () => {
    pv.innerHTML = '';
    Array.from(f.files || []).slice(0,4).forEach(file => {
      if (!file.type.startsWith('image/')) return;
      const img=document.createElement('img'); img.className='rxsuite-thumb'; img.alt=file.name;
      const rd=new FileReader(); rd.onload=()=>img.src=rd.result; rd.readAsDataURL(file); pv.appendChild(img);
    });
  };
  root.querySelector('#rx-cr').onclick = async () => {
    const out=root.querySelector('#rx-co'), symbol=root.querySelector('#rx-cs').value.trim().toUpperCase();
    out.innerHTML='<p class="rxsuite-row">جاري تحليل 12 زاوية…</p>';
    try {
      const scan=await deepScan(symbol);
      const body=await market().catch(()=>null);
      const c=body?findCandidate(body,symbol):null;
      const p=Number(scan.price?.last ?? scan.price?.last_closed_15m);
      const live=scan.meta?.live===true && Number.isFinite(Number(scan.price?.last));
      const assessment=scan.assessment||{}, zones=scan.zones||{}, frames=scan.timeframes||{};
      const timeframe=root.querySelector('#rx-cm').value;
      const mode={'15m':'15m · دخول قصير','1h':'1h · حركة متوسطة','4h':'4h · اتجاه عام'}[timeframe]||timeframe;
      const chartView=renderCandleChart(scan.chart?.timeframes?.[timeframe]?.candles,timeframe);
      const banner=body?marketNotice(body):'<div class="rxsuite-row"><div><b>Market Radar غير متاح حاليًا</b><small>استخدمنا الفحص العميق المستقل إن كانت بياناته سليمة؛ المرشح متعدد الاستراتيجيات لم يصل.</small></div><span class="rxsuite-tag rxsuite-warn">PARTIAL</span></div>';
      const zoneRow='<div class="rxsuite-grid">'+box('Trend / '+mode,assessment.market_read||assessment.direction_bias||'—')+box('Analysis strength',num(assessment.analysis_strength,0))+box('Momentum',num(scan.momentum?.score,0))+box('Buy / sell pressure',scan.pressure?.reading||num(scan.pressure?.score,0))+box('Demand / support',zones.support!=null?num(zones.support,8):'—')+box('Supply / resistance',zones.resistance!=null?num(zones.resistance,8):'—')+'</div>';
      const frameRows=['15m','1h','4h'].map(tf=>{const x=frames[tf]||{};return box(tf+' trend',x.structure?.label||x.structure?.state||x.trend_state||'—')+box(tf+' RSI',num(x.rsi14,1));}).join('');
      const candidateSummary=c?agents(c):'<div class="rxsuite-row"><div><b>لا يوجد مرشح من متعدد الاستراتيجيات لهذا الرمز الآن</b><small>يعرض التقرير العميق أدناه ما توفر من بياناته، ولا يخترع إشارة مفقودة.</small></div></div>';
      const fp=c?.pre_breakout_fingerprint||null;
      const fingerprint=fp?'<div class="rxsuite-row"><div><b>Pre-Breakout Fingerprint</b><small>stage='+esc(fp.stage||'NORMAL')+' · score='+num(fp.score,1)+' · trap='+percent(fp.trapRisk,0)+' · evidence='+(fp.evidenceCount||'—')+'/8</small></div><span class="rxsuite-tag '+(fp.detected?'rxsuite-ok':'rxsuite-warn')+'">'+(fp.detected?'DETECTED':'NOT CONFIRMED')+'</span></div>':'';
      out.innerHTML=banner+deepNotice(scan)+chartView+zoneRow+'<div class="rxsuite-grid">'+frameRows+'</div>'+candidateSummary+fingerprint+
        '<p class="rxsuite-row">صور الشارت تُعاين على الجهاز فقط؛ لا ندّعي استخراج أنماط بصرية من الصورة. مستويات العرض مأخوذة من تحليل الخادم للشموع المغلقة.</p>'+
        (!live?'<div class="rxsuite-row"><b>لا يوجد سعر حي مؤكد</b><small>التقرير الفني لا يُعامل كإشارة دخول.</small></div>':'');
    } catch(e){ out.innerHTML='<div class="rxsuite-row"><b>تعذر التحليل</b><small>'+esc(e.message)+'</small></div>'; }
  };
}

function verifyPanel(root) {
  root.innerHTML =
    '<div class="rxsuite-form"><div class="rxsuite-field"><label>الرمز</label><input id="rx-vs" class="rxsuite-input" value="BTCUSDT"></div>' +
    '<div class="rxsuite-field"><label>الإطار</label><select id="rx-vt" class="rxsuite-select"><option>1m</option><option>15m</option><option>1h</option><option>4h</option></select></div>' +
    '<div class="rxsuite-field rxsuite-full"><label>الإشارة الخارجية</label><textarea id="rx-vx" class="rxsuite-ta" placeholder="BUY BTCUSDT @ 65000 SL 64200 TP1 66200"></textarea></div></div>' +
    '<div class="rxsuite-actions"><button id="rx-vr" class="rxsuite-btn primary">تحقق من الإشارة</button></div><div id="rx-vo"></div>';
  root.querySelector('#rx-vr').onclick=async()=>{
    const o=root.querySelector('#rx-vo'), s=root.querySelector('#rx-vs').value.trim().toUpperCase(), t=root.querySelector('#rx-vx').value;
    o.innerHTML='<p class="rxsuite-row">جاري التحقق…</p>';
    try{
      const scan=await deepScan(s);
      requireLiveDeepScan(scan);
      const buy=/(?:buy|long)/i.test(t), sell=/(?:sell|short)/i.test(t);
      const bias=String(scan.assessment?.direction_bias||'UNKNOWN');
      const conflict=(buy&&bias==='DOWNWARD_BIAS')||(sell&&bias==='UPWARD_BIAS');
      const m=t.match(/(?:@|entry|دخول)\s*[=:]?\s*(\d+(?:\.\d+)?)/i);
      const ep=m?Number(m[1]):null,p=Number(scan.price.last),far=ep&&ep>0?Math.abs(p-ep)/ep*100:null;
      const neutral=!['UPWARD_BIAS','DOWNWARD_BIAS'].includes(bias);
      const v=!buy&&!sell?'AMBIGUOUS':conflict?'CONFLICTING':far!==null&&far>3?'STALE / FAR ENTRY':neutral?'NO CLEAR BIAS':'CONSISTENT — NOT AN ENTRY SIGNAL';
      const cl=conflict?'rxsuite-bad':(v==='AMBIGUOUS'||v.startsWith('STALE')||neutral)?'rxsuite-warn':'rxsuite-ok';
      const frame=root.querySelector('#rx-vt').value;
      o.innerHTML=deepNotice(scan)+'<div class="rxsuite-grid">'+box('Result',v)+box('Market read',scan.assessment?.market_read||bias)+box('Price',num(p,8))+box('Entry',ep?num(ep,8):'—')+box('Distance',far!==null?percent(far):'—')+box('Trap risk',percent(scan.assessment?.trap_risk,0))+'</div>' +
      '<div class="rxsuite-row"><div><b>Verify • '+esc(frame)+'</b><small>' + esc(conflict?'الإشارة تعاكس اتجاه الإطار متعدد الزمن.':far!==null&&far>3?'سعر الدخول بعيد أكثر من 3% عن السعر الحالي.':neutral?'الاتجاه غير حاسم؛ التحقق لا يعطي موافقة دخول.':'الإشارة لا تتعارض مباشرة مع الانحياز الحالي، وهذا لا يثبت نجاحها ولا يوصي بالدخول.') + '</small></div><span class="rxsuite-tag '+cl+'">'+v+'</span></div>';
    }catch(e){o.innerHTML='<div class="rxsuite-row"><b>تعذر التحقق</b><small>'+esc(e.message)+'</small></div>';}
  };
}

function advisorPanel(root) {
  root.innerHTML =
    '<div class="rxsuite-form"><div class="rxsuite-field"><label>الرمز</label><input id="rx-as" class="rxsuite-input" value="BTCUSDT"></div>' +
    '<div class="rxsuite-field"><label>الاتجاه</label><select id="rx-ad" class="rxsuite-select"><option value="LONG">Long</option><option value="SHORT">Short (تحليل فقط)</option></select></div>' +
    '<div class="rxsuite-field"><label>الدخول</label><input id="rx-ae" class="rxsuite-input" inputmode="decimal"></div><div class="rxsuite-field"><label>وقف الخسارة</label><input id="rx-asl" class="rxsuite-input" inputmode="decimal"></div>' +
    '<div class="rxsuite-field"><label>الهدف</label><input id="rx-atp" class="rxsuite-input" inputmode="decimal"></div></div>' +
    '<div class="rxsuite-actions"><button id="rx-ar" class="rxsuite-btn primary">استشر RadarX</button></div><div id="rx-ao"></div>';
  root.querySelector('#rx-ar').onclick=async()=>{
    const o=root.querySelector('#rx-ao'),s=root.querySelector('#rx-as').value.trim().toUpperCase(),d=root.querySelector('#rx-ad').value,e=Number(root.querySelector('#rx-ae').value),sl=Number(root.querySelector('#rx-asl').value),tp=Number(root.querySelector('#rx-atp').value);
    o.innerHTML='<p class="rxsuite-row">جاري فحص الصفقة…</p>';
    try{
      const scan=await deepScan(s);
      requireLiveDeepScan(scan);
      const p=Number(scan.price.last),bias=String(scan.assessment?.direction_bias||'UNKNOWN');
      const risk=e>0&&sl>0?Math.abs(e-sl)/e*100:null;
      const rr=e>0&&sl>0&&tp>0?Math.abs(tp-e)/Math.max(Math.abs(e-sl),1e-12):null;
      const bad=(d==='LONG'&&bias==='DOWNWARD_BIAS')||(d==='SHORT'&&bias==='UPWARD_BIAS');
      const neutral=!['UPWARD_BIAS','DOWNWARD_BIAS'].includes(bias);
      let act='WAIT / MORE EVIDENCE',cl='rxsuite-warn',reason='لم تصل المحاذاة المطلوبة أو ينقص مستوى تأكيد.';
      if(bad){act='DIRECTION CONFLICT';cl='rxsuite-bad';reason='الاتجاه المطلوب يعاكس انحياز تحليل 15m/1h/4h.'}
      else if(neutral){act='NO CLEAR BIAS';reason='الاتجاه المحايد لا يدعم تجهيز قرار دخول.'}
      else if(Number(scan.assessment?.trap_risk)>=60){act='HIGH TRAP RISK';cl='rxsuite-bad';reason='تقدير مخاطر الفخ مرتفع؛ انتظر بنية أوضح.'}
      else if(risk!==null&&risk>5){act='REASSESS RISK';reason='وقف الخسارة أبعد من 5% عن الدخول.'}
      else if(rr!==null&&rr<1.2){act='REASSESS TARGET';reason='نسبة العائد إلى المخاطرة أقل من 1.2.'}
      else if(Number(scan.assessment?.analysis_strength)>=70&&Number(scan.momentum?.score)>=58){act='ALIGNED / MONITOR';cl='rxsuite-ok';reason='المعايير الحالية متوافقة؛ هذا ليس أمر شراء ولا يضمن الربح.'}
      o.innerHTML=deepNotice(scan)+'<div class="rxsuite-grid">'+box('Advisor state',act)+box('Market read',scan.assessment?.market_read||bias)+box('Current',num(p,8))+box('Risk',risk!==null?percent(risk):'—')+box('R:R',rr!==null?num(rr,2):'—')+box('Liquidity',num(scan.liquidity?.score,0))+box('Trap Risk',percent(scan.assessment?.trap_risk,0))+box('Momentum',num(scan.momentum?.score,0))+'</div>' +
        '<div class="rxsuite-row"><div><b>Advisor • PAPER ONLY</b><small>'+esc(reason)+'</small></div><span class="rxsuite-tag '+cl+'">'+act+'</span></div>';
    }catch(e){o.innerHTML='<div class="rxsuite-row"><b>تعذر التحليل الاستشاري</b><small>'+esc(e.message)+'</small></div>';}
  };
}

function hubPanel(root) {
  root.innerHTML='<div class="rxsuite-actions"><button id="rx-hr" class="rxsuite-btn primary">تحديث مركز الإشارات</button></div>' +
    '<p class="rxsuite-row">هذه الوحدة تعرض مصادر RadarX. لا يتم اختلاق وصول إلى 200 قناة Telegram خارجية بدون API أو تفويض رسمي.</p><div id="rx-ho"></div>';
  root.querySelector('#rx-ho').innerHTML='<p class="rxsuite-row">اضغط "تحديث مركز الإشارات" لبدء الفحص. لن يتم تشغيل فحص سوق إضافي عند فتح التطبيق.</p>';
  root.querySelector('#rx-hr').onclick=async()=>{
    const o=root.querySelector('#rx-ho');o.innerHTML='<p class="rxsuite-row">تحديث…</p>';
    try{
      const [alertsResult,marketResult]=await Promise.allSettled([
        getRadarAlerts({radar:'ALL',limit:30}),
        market()
      ]);
      const signalResponse=alertsResult.status==='fulfilled'?alertsResult.value:null;
      const b=marketResult.status==='fulfilled'?marketResult.value:null;
      const alerts=signalResponse?.ok&&Array.isArray(signalResponse.body?.alerts)?signalResponse.body.alerts:[];
      const alertRows=alerts.slice(0,15).map((a,i)=>{
        const time=signalTime(a);
        const price=Number(a.price ?? a.detection_price ?? a.price_at_detection);
        const symbol=String(a.symbol||'UNKNOWN');
        const score=a.opportunity_score ?? a.score;
        const label=a.radar_name||a.radar||'RadarX';
        return '<div class="rxsuite-row"><div><b>'+(i+1)+'. '+esc(symbol)+' · '+esc(label)+'</b><small>'+esc(a.direction||a.event||'ALERT')+' · وقت الاكتشاف '+esc(time)+' · price '+(Number.isFinite(price)?num(price,8):'—')+' · score '+num(score,1)+'</small></div><span class="rxsuite-tag '+(a.eligible===false?'rxsuite-warn':'rxsuite-ok')+'">'+esc(a.potential_label||a.event||'SAVED ALERT')+'</span></div>';
      }).join('');
      const candidateRows=b?(b.candidates||[]).slice(0,8).map((x,i)=>
        '<div class="rxsuite-row"><div><b>'+(i+1)+'. '+esc(x.symbol)+'</b><small>'+esc(x.best_strategy||'—')+' · score '+num(x.overall_score,1)+' · liquidity '+num(x.liquidity_quality,0)+'</small></div><span class="rxsuite-tag '+(x.signal_state==='CONFIRMED'?'rxsuite-ok':'rxsuite-warn')+'">'+esc(x.signal_state||'UNKNOWN')+'</span></div>'
      ).join(''):'';
      const alertsError=alertsResult.status==='rejected'?'تعذر جلب سجل الإشارات المحفوظ: '+String(alertsResult.reason?.message||alertsResult.reason):(!signalResponse?.ok?'تعذر جلب سجل الإشارات من الخادم ('+String(signalResponse?.status||0)+').':'');
      const marketError=marketResult.status==='rejected'?'تعذر جلب مرشحي السوق الحاليين: '+String(marketResult.reason?.message||marketResult.reason):'';
      o.innerHTML=(b?marketNotice(b):'<div class="rxsuite-row"><b>Market Radar غير متاح</b><small>'+esc(marketError)+'</small></div>')+
        '<div class="rxsuite-row"><div><b>الإشارات المسجلة من الرادارات</b><small>أحداث محفوظة في خادم RadarX؛ ليست تغذية مزعومة من قنوات أو منصات خارجية.</small></div><span class="rxsuite-tag">'+alerts.length+' saved</span></div>'+
        (alertRows||'<div class="rxsuite-row"><b>لا توجد إشارات محفوظة ضمن النطاق الحالي</b><small>'+esc(alertsError||'لا توجد نتائج مسجلة الآن.')+'</small></div>')+
        '<div class="rxsuite-row"><div><b>مرشحو السوق الحاليون</b><small>نتائج Market Radar الحالية بحسب جودة البيانات والاستراتيجيات.</small></div><span class="rxsuite-tag">'+(b?.candidates?.length||0)+' candidates</span></div>'+
        (candidateRows||'<div class="rxsuite-row"><small>'+esc(marketError||'لا توجد مرشحات متاحة الآن.')+'</small></div>');
    }catch(e){o.innerHTML='<div class="rxsuite-row"><b>تعذر تحديث مركز الإشارات</b><small>'+esc(e.message)+'</small></div>';}
  };
}


function supplyPanel(root) {
  root.innerHTML='<div class="rxsuite-form"><div class="rxsuite-field"><label>الرمز</label><input id="rx-sds" class="rxsuite-input" value="BTCUSDT"></div></div>' +
    '<div class="rxsuite-actions"><button id="rx-sdr" class="rxsuite-btn primary">اكتشف Supply / Demand</button></div><div id="rx-sdo"></div>';
  root.querySelector('#rx-sdr').onclick=async()=>{
    const o=root.querySelector('#rx-sdo'),s=root.querySelector('#rx-sds').value.trim().toUpperCase();o.innerHTML='<p class="rxsuite-row">جاري الاكتشاف…</p>';
    try{
      const scan=await deepScan(s);
      requireLiveDeepScan(scan);
      const p=Number(scan.price.last),z=scan.zones||{},frame=scan.timeframes?.['15m']||{};
      const supportRows=levelsFor(frame,'support_levels',p);
      const resistanceRows=levelsFor(frame,'resistance_levels',p);
      if(z.support!=null&&!supportRows.some(x=>Math.abs(x.price-Number(z.support))/Math.max(1,p)<0.0001))supportRows.unshift({price:Number(z.support),touches:0,distance:Number(z.distance_to_support_pct)||0});
      if(z.resistance!=null&&!resistanceRows.some(x=>Math.abs(x.price-Number(z.resistance))/Math.max(1,p)<0.0001))resistanceRows.unshift({price:Number(z.resistance),touches:0,distance:Number(z.distance_to_resistance_pct)||0});
      const renderZones=(title,rows,cls)=>'<div class="rxsuite-row"><div><b>'+esc(title)+'</b><small>'+(rows.length?'مستويات من تحليل القمم والقيعان والشموع المغلقة.':'لم تتأكد مستويات صالحة من البيانات الحالية.')+'</small></div><span class="rxsuite-tag '+cls+'">'+rows.length+' levels</span></div>'+(rows.length?rows.slice(0,3).map((x,i)=>'<div class="rxsuite-row"><div><b>'+(i+1)+'. '+num(x.price,8)+'</b><small>distance '+percent(x.distance,2)+' · touches '+num(x.touches,0)+'</small></div></div>').join(''):'');
      o.innerHTML=deepNotice(scan)+'<div class="rxsuite-grid">'+box('Current price',num(p,8))+box('Position',z.position||'UNKNOWN')+box('Bounce signal',z.bounce_signal||'UNKNOWN')+box('Support distance',percent(z.distance_to_support_pct,2))+box('Resistance distance',percent(z.distance_to_resistance_pct,2))+box('Trap risk',percent(scan.assessment?.trap_risk,0))+'</div>'+renderZones('Demand / support',supportRows,'rxsuite-ok')+renderZones('Supply / resistance',resistanceRows,'rxsuite-warn')+'<div class="rxsuite-row"><small>هذه مناطق فنية مشتقة من بيانات الخادم وليست ضمانًا للارتداد أو الاختراق.</small></div>';
    }catch(e){o.innerHTML='<div class="rxsuite-row"><b>تعذر تحليل العرض والطلب</b><small>'+esc(e.message)+'</small></div>';}
  };
}

export function mountTradliFeatureSuite(container) {
  addStyle();
  container.innerHTML='<section class="rxsuite"><div style="font-size:17px;font-weight:950">RadarX Intelligence Suite</div>' +
    '<div class="rxsuite-row">وظائف مستقلة من فئة TRADLI مدمجة داخل RadarX. التداول الحقيقي غير مفعّل.</div>' +
    '<div class="rxsuite-tabs">' +
    '<button class="rxsuite-tab active" data-tab="chart">Chart Lab</button><button class="rxsuite-tab" data-tab="verify">Verify</button>' +
    '<button class="rxsuite-tab" data-tab="advisor">Advisor</button><button class="rxsuite-tab" data-tab="hub">Signals Hub</button><button class="rxsuite-tab" data-tab="sd">Supply / Demand</button><button class="rxsuite-tab" data-tab="desk">Order Desk</button></div>' +
    '<div class="rxsuite-live"><div><div class="rxsuite-title"><b>RadarX Live Data</b><span class="rxsuite-tag rxsuite-safe">PAPER ONLY</span></div><div class="rxsuite-sub">بيانات السوق عبر Backend RadarX • التنفيذ الحقيقي غير متاح داخل التطبيق</div></div><span class="rxsuite-live-dot"></span></div>' +'<div id="rx-p-chart" class="rxsuite-pane active"></div><div id="rx-p-verify" class="rxsuite-pane"></div><div id="rx-p-advisor" class="rxsuite-pane"></div><div id="rx-p-hub" class="rxsuite-pane"></div><div id="rx-p-sd" class="rxsuite-pane"></div><div id="rx-p-desk" class="rxsuite-pane"></div></section>';
  const tabs=[...container.querySelectorAll('.rxsuite-tab')];
  const keys=['chart','verify','advisor','hub','sd','desk'];
  tabs.forEach(t=>t.onclick=()=>{tabs.forEach(x=>x.classList.toggle('active',x===t));keys.forEach(k=>container.querySelector('#rx-p-'+k).classList.toggle('active',k===t.dataset.tab));});
  chartPanel(container.querySelector('#rx-p-chart'));
  verifyPanel(container.querySelector('#rx-p-verify'));
  advisorPanel(container.querySelector('#rx-p-advisor'));
  hubPanel(container.querySelector('#rx-p-hub'));
  supplyPanel(container.querySelector('#rx-p-sd'));
  orderDesk(container.querySelector('#rx-p-desk'));
}

function orderDesk(root) {
  root.innerHTML =
    '<div class="rxsuite-form">' +
    '<div class="rxsuite-field"><label>الرمز</label><input id="rx-os" class="rxsuite-input" value="BTCUSDT"></div>' +
    '<div class="rxsuite-field"><label>الاتجاه</label><select id="rx-od" class="rxsuite-select"><option value="LONG">LONG / شراء</option><option value="SHORT">SHORT / بيع (تحليل فقط)</option></select></div>' +
    '<div class="rxsuite-field"><label>الدخول</label><input id="rx-oe" class="rxsuite-input" inputmode="decimal"></div>' +
    '<div class="rxsuite-field"><label>وقف الخسارة</label><input id="rx-ol" class="rxsuite-input" inputmode="decimal"></div>' +
    '<div class="rxsuite-field"><label>الهدف 1</label><input id="rx-ot" class="rxsuite-input" inputmode="decimal"></div>' +
    '<div class="rxsuite-field"><label>المبلغ</label><input id="rx-oq" class="rxsuite-input" inputmode="decimal" placeholder="اختياري"></div>' +
    '</div>' +
    '<div class="rxsuite-actions"><button id="rx-og" class="rxsuite-btn primary">تحقق وجهّز الأمر</button></div>' +
    '<div id="rx-oo"><p class="rxsuite-row">هذه الشاشة لا ترسل أي أمر إلى منصة تداول. تستخدم فقط للتحقق من المدخلات وتجهيز تفاصيل صفقة قابلة للنسخ.</p></div>';
  root.querySelector('#rx-og').onclick = async () => {
    const o=root.querySelector('#rx-oo');
    const symbol=root.querySelector('#rx-os').value.trim().toUpperCase();
    const side=root.querySelector('#rx-od').value;
    const entry=Number(root.querySelector('#rx-oe').value);
    const sl=Number(root.querySelector('#rx-ol').value);
    const tp=Number(root.querySelector('#rx-ot').value);
    const qty=Number(root.querySelector('#rx-oq').value);
    o.innerHTML='<p class="rxsuite-row">جاري التحقق من السعر والاتجاه…</p>';
    try {
      const scan=await deepScan(symbol);
      requireLiveDeepScan(scan);
      const p=Number(scan.price.last);
      const valid=[entry,sl,tp].every(Number.isFinite) && entry>0 && sl>0 && tp>0;
      if(!valid) throw Error('INVALID_ORDER_FIELDS');
      const qtyRaw=root.querySelector('#rx-oq').value.trim();
      const hasQty=qtyRaw.length>0;
      if(hasQty&&(!Number.isFinite(qty)||qty<=0))throw Error('INVALID_QUANTITY');
      const dirOk=side==='LONG' ? sl<entry && tp>entry : sl>entry && tp<entry;
      const rr=Math.abs(tp-entry)/Math.max(Math.abs(entry-sl),1e-12);
      const distance=Math.abs(p-entry)/entry*100;
      const riskAmount=hasQty ? Math.abs(entry-sl)*qty : null;
      if(!dirOk) throw Error('INVALID_ORDER_DIRECTION_LEVELS');
      const bias=String(scan.assessment?.direction_bias||'UNKNOWN');
      const conflict=(side==='LONG'&&bias==='DOWNWARD_BIAS')||(side==='SHORT'&&bias==='UPWARD_BIAS');
      const neutral=!['UPWARD_BIAS','DOWNWARD_BIAS'].includes(bias);
      const readiness=conflict?'DIRECTION CONFLICT':neutral?'WAIT FOR CONFIRMATION':distance>3?'ENTRY TOO FAR':Number(scan.assessment?.trap_risk)>=60?'HIGH TRAP RISK':rr<1.2?'LOW R:R':'PAPER CALCULATION READY';
      const readinessClass=conflict||readiness==='HIGH TRAP RISK'?'rxsuite-danger':readiness==='PAPER CALCULATION READY'?'rxsuite-safe':'rxsuite-warn';
      const textOrder=(side==='LONG'?'BUY':'SELL')+' '+symbol+' @ '+entry+' | SL '+sl+' | TP1 '+tp+(hasQty?' | QTY '+qty:'');
      o.innerHTML=deepNotice(scan)+'<div class="rxsuite-grid">'+box('Live price',num(p,8))+box('Entry',num(entry,8))+box('SL',num(sl,8))+box('TP1',num(tp,8))+box('R:R',num(rr,2))+box('Entry distance',percent(distance))+'</div>'+
        '<div class="rxsuite-row"><div><b>Paper preparation status</b><small>'+esc(readiness)+' · '+esc(bias)+' · لا يوجد تنفيذ أو إرسال أوامر.</small></div><span class="rxsuite-tag '+readinessClass+'">'+esc(readiness)+'</span></div>'+
        '<div class="rxsuite-row"><div><b>Prepared order</b><small>'+esc(textOrder)+'</small></div><button id="rx-oc" class="rxsuite-copy">نسخ</button></div>'+
        '<div class="rxsuite-row"><div><b>Risk amount</b><small>'+ (riskAmount===null?'أدخل الكمية لحساب المخاطرة المالية.':num(riskAmount,8)) +'</small></div><span class="rxsuite-tag rxsuite-safe">NO EXECUTION</span></div>'+
        '<div class="rxsuite-row"><small>الحساب تعليمي فقط. تحقق من السيولة والمخاطر يدويًا؛ ليس أمرًا ماليًا ولا ضمانًا للربح.</small></div>';
      root.querySelector('#rx-oc').onclick=async()=>{
        try{await navigator.clipboard.writeText(textOrder);root.querySelector('#rx-oc').textContent='تم النسخ';}
        catch{root.querySelector('#rx-oc').textContent='انسخ النص الظاهر يدويًا';}
      };
    } catch(e) {
      o.innerHTML='<div class="rxsuite-row"><div><b>ORDER NOT READY</b><small>'+esc(e.message)+'</small></div><span class="rxsuite-tag rxsuite-danger">CHECK INPUT</span></div>';
    }
  };
}
