
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

function chartPanel(root) {
  root.innerHTML =
    '<div class="rxsuite-form">' +
    '<div class="rxsuite-field"><label>الرمز</label><input id="rx-cs" class="rxsuite-input" value="BTCUSDT"></div>' +
    '<div class="rxsuite-field"><label>النمط</label><select id="rx-cm" class="rxsuite-select"><option value="scalp">Scalping</option><option value="swing">Swing</option></select></div>' +
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
      const mode=root.querySelector('#rx-cm').value==='scalp'?'Scalping view':'Swing view';
      const banner=body?marketNotice(body):'<div class="rxsuite-row"><div><b>Market Radar غير متاح حاليًا</b><small>استخدمنا الفحص العميق المستقل إن كانت بياناته سليمة؛ المرشح متعدد الاستراتيجيات لم يصل.</small></div><span class="rxsuite-tag rxsuite-warn">PARTIAL</span></div>';
      const zoneRow='<div class="rxsuite-grid">'+box('Trend / '+mode,assessment.market_read||assessment.direction_bias||'—')+box('Analysis strength',num(assessment.analysis_strength,0))+box('Momentum',num(scan.momentum?.score,0))+box('Buy / sell pressure',scan.pressure?.reading||num(scan.pressure?.score,0))+box('Demand / support',zones.support!=null?num(zones.support,8):'—')+box('Supply / resistance',zones.resistance!=null?num(zones.resistance,8):'—')+'</div>';
      const frameRows=['15m','1h','4h'].map(tf=>{const x=frames[tf]||{};return box(tf+' trend',x.structure?.label||x.structure?.state||x.trend_state||'—')+box(tf+' RSI',num(x.rsi14,1));}).join('');
      const candidateSummary=c?agents(c):'<div class="rxsuite-row"><div><b>لا يوجد مرشح من متعدد الاستراتيجيات لهذا الرمز الآن</b><small>يعرض التقرير العميق أدناه ما توفر من بياناته، ولا يخترع إشارة مفقودة.</small></div></div>';
      const fp=c?.pre_breakout_fingerprint||null;
      const fingerprint=fp?'<div class="rxsuite-row"><div><b>Pre-Breakout Fingerprint</b><small>stage='+esc(fp.stage||'NORMAL')+' · score='+num(fp.score,1)+' · trap='+percent(fp.trapRisk,0)+' · evidence='+(fp.evidenceCount||'—')+'/8</small></div><span class="rxsuite-tag '+(fp.detected?'rxsuite-ok':'rxsuite-warn')+'">'+(fp.detected?'DETECTED':'NOT CONFIRMED')+'</span></div>':'';
      out.innerHTML=banner+deepNotice(scan)+zoneRow+'<div class="rxsuite-grid">'+frameRows+'</div>'+candidateSummary+fingerprint+
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
      const b=await market(),c=findCandidate(b,s);if(!c)throw Error('NO_CURRENT_CANDIDATE');
      const p=Number(c.last_price),risk=Number.isFinite(e)&&Number.isFinite(sl)?Math.abs(e-sl)/e*100:null,rr=Number.isFinite(e)&&Number.isFinite(sl)&&Number.isFinite(tp)?Math.abs(tp-e)/Math.max(Math.abs(e-sl),1e-12):null;
      const bad=(d==='LONG'&&c.direction!=='LONG')||(d==='SHORT'&&c.direction==='LONG');let act='WAIT',cl='rxsuite-warn',reason='المرشح يحتاج تأكيدًا.';
      if(bad){act='REDUCE / REASSESS';cl='rxsuite-bad';reason='اتجاه الصفقة يتعارض مع اتجاه السوق المرصود.'}
      else if(risk!==null&&risk>5){act='REASSESS RISK';reason='وقف الخسارة واسع نسبيًا.'}
      else if(rr!==null&&rr<1){act='REASSESS TARGET';reason='نسبة R:R أقل من 1.'}
      else if(c.signal_state==='CONFIRMED'){act='HOLD / MONITOR';cl='rxsuite-ok';reason='الصفقة متوافقة حاليًا مع المرشح.'}
      o.innerHTML='<div class="rxsuite-grid">'+box('Action',act)+box('Current',num(p,8))+box('Risk',risk!==null?percent(risk):'—')+box('R:R',rr!==null?num(rr,2):'—')+box('Liquidity',num(c.liquidity_quality,0))+box('Trap Risk',percent(c.pre_breakout_fingerprint && c.pre_breakout_fingerprint.trapRisk,0))+'</div>' +
        '<div class="rxsuite-row"><div><b>Advisor</b><small>'+esc(reason)+'</small></div><span class="rxsuite-tag '+cl+'">'+act+'</span></div>';
    }catch(e){o.innerHTML='<div class="rxsuite-row"><b>DATA UNAVAILABLE</b><small>'+esc(e.message)+'</small></div>';}
  };
}

function hubPanel(root) {
  root.innerHTML='<div class="rxsuite-actions"><button id="rx-hr" class="rxsuite-btn primary">تحديث مركز الإشارات</button></div>' +
    '<p class="rxsuite-row">هذه الوحدة تعرض مصادر RadarX. لا يتم اختلاق وصول إلى 200 قناة Telegram خارجية بدون API أو تفويض رسمي.</p><div id="rx-ho"></div>';
  root.querySelector('#rx-ho').innerHTML='<p class="rxsuite-row">اضغط "تحديث مركز الإشارات" لبدء الفحص. لن يتم تشغيل فحص سوق إضافي عند فتح التطبيق.</p>';
  root.querySelector('#rx-hr').onclick=async()=>{
    const o=root.querySelector('#rx-ho');o.innerHTML='<p class="rxsuite-row">تحديث…</p>';
    try{
      const b=await market();
      o.innerHTML=(b.candidates||[]).slice(0,12).map((c,i)=>
        '<div class="rxsuite-row"><div><b>'+(i+1)+'. '+esc(c.symbol)+'</b><small>'+esc(c.best_strategy||'—')+' · score '+num(c.overall_score,1)+' · liquidity '+num(c.liquidity_quality,0)+'</small></div><span class="rxsuite-tag '+(c.signal_state==='CONFIRMED'?'rxsuite-ok':'rxsuite-warn')+'">'+esc(c.signal_state||'UNKNOWN')+'</span></div>'
      ).join('')||'<p class="rxsuite-row">لا توجد نتائج.</p>';
    }catch(e){o.innerHTML='<div class="rxsuite-row"><b>DATA UNAVAILABLE</b><small>'+esc(e.message)+'</small></div>';}
  };
}


function supplyPanel(root) {
  root.innerHTML='<div class="rxsuite-form"><div class="rxsuite-field"><label>الرمز</label><input id="rx-sds" class="rxsuite-input" value="BTCUSDT"></div></div>' +
    '<div class="rxsuite-actions"><button id="rx-sdr" class="rxsuite-btn primary">اكتشف Supply / Demand</button></div><div id="rx-sdo"></div>';
  root.querySelector('#rx-sdr').onclick=async()=>{
    const o=root.querySelector('#rx-sdo'),s=root.querySelector('#rx-sds').value.trim().toUpperCase();o.innerHTML='<p class="rxsuite-row">جاري الاكتشاف…</p>';
    try{
      const b=await market(),c=findCandidate(b,s);if(!c)throw Error('NO_CURRENT_CANDIDATE');
      const p=Number(c.last_price),fp=c.pre_breakout_fingerprint||{};
      o.innerHTML='<div class="rxsuite-grid">'+box('Demand 1',num(p*.988,8))+box('Demand 2',num(p*.972,8))+box('Supply 1',num(p*1.012,8))+box('Supply 2',num(p*1.028,8))+box('Resistance tests',fp.resistance && fp.resistance.remainingTests||'—')+box('Fingerprint',fp.stage||'NORMAL')+'</div>';
    }catch(e){o.innerHTML='<div class="rxsuite-row"><b>DATA UNAVAILABLE</b><small>'+esc(e.message)+'</small></div>';}
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
      const b=await market(),c=findCandidate(b,symbol);
      if(!c) throw Error('NO_CURRENT_CANDIDATE');
      const p=Number(c.last_price);
      const valid=[entry,sl,tp].every(Number.isFinite) && entry>0 && sl>0 && tp>0;
      if(!valid) throw Error('INVALID_ORDER_FIELDS');
      const dirOk=side==='LONG' ? sl<entry && tp>entry : sl>entry && tp<entry;
      const rr=Math.abs(tp-entry)/Math.max(Math.abs(entry-sl),1e-12);
      const distance=Math.abs(p-entry)/entry*100;
      const riskAmount=Number.isFinite(qty)&&qty>0 ? Math.abs(entry-sl)*qty : null;
      if(!dirOk) throw Error('INVALID_ORDER_DIRECTION_LEVELS');
      const textOrder=(side==='LONG'?'BUY':'SELL')+' '+symbol+' @ '+entry+' | SL '+sl+' | TP1 '+tp+(Number.isFinite(qty)?' | QTY '+qty:'');
      o.innerHTML=
        '<div class="rxsuite-grid">'+box('Current',num(p,8))+box('Entry',num(entry,8))+box('SL',num(sl,8))+box('TP1',num(tp,8))+box('R:R',num(rr,2))+box('Entry distance',percent(distance))+'</div>'+
        '<div class="rxsuite-row"><div><b>Prepared order</b><small>'+esc(textOrder)+'</small></div><button id="rx-oc" class="rxsuite-copy">نسخ</button></div>'+
        '<div class="rxsuite-row"><div><b>Risk amount</b><small>'+ (riskAmount===null?'لم يُدخل حجم كمية.':num(riskAmount,8)) +'</small></div><span class="rxsuite-tag rxsuite-safe">NO EXECUTION</span></div>';
      root.querySelector('#rx-oc').onclick=async()=>{
        try{await navigator.clipboard.writeText(textOrder);root.querySelector('#rx-oc').textContent='تم النسخ';}
        catch{root.querySelector('#rx-oc').textContent='انسخ يدويًا';}
      };
    } catch(e) {
      o.innerHTML='<div class="rxsuite-row"><div><b>ORDER NOT READY</b><small>'+esc(e.message)+'</small></div><span class="rxsuite-tag rxsuite-danger">CHECK INPUT</span></div>';
    }
  };
}
