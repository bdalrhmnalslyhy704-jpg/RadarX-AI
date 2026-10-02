
import { getMarketRadar } from './radarx-backend-client.mjs';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = (v,d=2) => Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—';
const percent = (v,d=1) => Number.isFinite(Number(v)) ? Number(v).toFixed(d) + '%' : '—';

function addStyle() {
  if (document.getElementById('rx-suite-style')) return;
  const s = document.createElement('style');
  s.id = 'rx-suite-style';
  s.textContent =
    '.rxsuite{margin-top:12px;background:#0b1820;border:1px solid #1d3944;border-radius:17px;padding:14px}' +
    '.rxsuite-tabs{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;margin:12px 0}' +
    '.rxsuite-tab{min-height:44px;border:1px solid #234651;background:#08131a;color:#dff2f6;border-radius:11px;font:inherit;font-weight:900}' +
    '.rxsuite-tab.active{border-color:#53cde9;background:#102630}' +
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
    '@media(max-width:700px){.rxsuite-tabs{grid-template-columns:1fr 1fr}.rxsuite-form{grid-template-columns:1fr}.rxsuite-full{grid-column:auto}.rxsuite-grid,.rxsuite-agents{grid-template-columns:1fr 1fr}}' +
    '@media(max-width:450px){.rxsuite-grid,.rxsuite-agents,.rxsuite-images{grid-template-columns:1fr}}';
  document.head.appendChild(s);
}

async function market() {
  const r = await getMarketRadar({quote:'USDT',limit:20});
  if (!r.ok || !r.body) throw Error('MARKET_RADAR_UNAVAILABLE');
  return r.body;
}
function findCandidate(body,symbol) {
  return (body.candidates || []).find(x => String(x.symbol).toUpperCase() === symbol.toUpperCase());
}
function agents(c) {
  const ss = Array.isArray(c?.strategies) ? c.strategies : [];
  const m = Object.fromEntries(ss.map(x => [x.id,x]));
  const fp = c?.pre_breakout_fingerprint || {};
  const e = fp.evidence || {};
  const rows = [
    ['Trend',m.MTF_TREND?.score ?? 50],
    ['Structure',e.structure?.score ?? (fp.context?.breakout ? 82 : 50)],
    ['Momentum',c?.price_change_24h == null ? 50 : Math.max(0,Math.min(100,50 + Number(c.price_change_24h)*4))],
    ['Volume',Math.max(0,Math.min(100,50 + ((Number(e.volume?.rvol)||1)-1)*35))],
    ['Liquidity',c?.liquidity_quality ?? 50],
    ['RSI / Exhaustion',100-(m.MEAN_REVERSION?.score ?? 45)],
    ['MACD Continuation',m.MACD_TREND_CONTINUATION?.score ?? 50],
    ['VWAP Position',m.VWAP_POSITION?.score ?? m.VWAP_REVERSION?.score ?? 50],
    ['Volatility',m.ATR_EXPANSION?.score ?? 50],
    ['Breakout',m.CONFIRMED_BREAKOUT?.score ?? 50],
    ['Mean Reversion',m.MEAN_REVERSION?.score ?? 50],
    ['Market Regime',e.regime?.score ?? 50]
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
      const body=await market(), c=findCandidate(body,symbol);
      if(!c){out.innerHTML='<div class="rxsuite-row"><b>WAIT</b><small>الرمز غير موجود ضمن المرشحين الحاليين.</small></div>';return;}
      const p=Number(c.last_price), r=root.querySelector('#rx-cm').value==='scalp'?0.0075:0.018, long=c.direction==='LONG';
      const sl=p*(long?1-r:1+r), tp1=p*(long?1+r*1.5:1-r*1.5), tp2=p*(long?1+r*2.5:1-r*2.5), fp=c.pre_breakout_fingerprint||{};
      out.innerHTML='<div class="rxsuite-grid">'+box('Signal state',c.signal_state)+box('Entry',num(p,8))+box('Stop Loss',num(sl,8))+box('TP1',num(tp1,8))+box('TP2',num(tp2,8))+box('Images',Math.min(4,f.files.length))+'</div>' +
        agents(c) + '<div class="rxsuite-row"><div><b>Pre-Breakout Fingerprint</b><small>stage=' + esc(fp.stage||'NORMAL') + ' · score=' + num(fp.score,1) + ' · trap=' + percent(fp.trapRisk,0) + ' · evidence=' + (fp.evidenceCount ?? '—') + '/8</small></div><span class="rxsuite-tag ' + (fp.detected?'rxsuite-ok':'rxsuite-warn') + '">' + (fp.detected?'DETECTED':'NOT CONFIRMED') + '</span></div>' +
        '<p class="rxsuite-row">تنبيه: الصورة لا تُعامل كرؤية حاسوبية خارجية؛ القيم ناتجة من محرك RadarX الكمي.</p>';
    } catch(e){ out.innerHTML='<div class="rxsuite-row"><b>DATA UNAVAILABLE</b><small>'+esc(e.message)+'</small></div>'; }
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
      const b=await market(),c=findCandidate(b,s);
      if(!c){o.innerHTML='<div class="rxsuite-row"><b>INSUFFICIENT DATA</b></div>';return;}
      const buy=/(?:buy|long)/i.test(t), sell=/(?:sell|short)/i.test(t), conflict=(buy&&c.direction!=='LONG')||(sell&&c.direction==='LONG');
      const m=t.match(/(?:@|entry|دخول)\s*[=:]?\s*(\d+(?:\.\d+)?)/i), ep=m?Number(m[1]):null, p=Number(c.last_price), far=ep?Math.abs(p-ep)/ep*100:null;
      const v=!buy&&!sell?'AMBIGUOUS':conflict?'CONFLICTING':far!==null&&far>3?'STALE / FAR ENTRY':'CONSISTENT';
      const cl=v==='CONSISTENT'?'rxsuite-ok':(v==='AMBIGUOUS'||v.startsWith('STALE'))?'rxsuite-warn':'rxsuite-bad';
      o.innerHTML='<div class="rxsuite-grid">'+box('Result',v)+box('Radar direction',c.direction)+box('Current',num(p,8))+box('Entry',ep?num(ep,8):'—')+box('Distance',far!==null?percent(far):'—')+box('Trap Risk',percent(c.pre_breakout_fingerprint?.trapRisk,0))+'</div>' +
      '<div class="rxsuite-row"><div><b>Assessment</b><small>' + esc(conflict?'الاتجاه يتعارض مع المرشح الحالي.':far!==null&&far>3?'الدخول بعيد عن السعر الحالي.':'لا يوجد تعارض مباشر في البيانات الحالية.') + '</small></div><span class="rxsuite-tag '+cl+'">'+v+'</span></div>';
    }catch(e){o.innerHTML='<div class="rxsuite-row"><b>DATA UNAVAILABLE</b><small>'+esc(e.message)+'</small></div>';}
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
      o.innerHTML='<div class="rxsuite-grid">'+box('Action',act)+box('Current',num(p,8))+box('Risk',risk!==null?percent(risk):'—')+box('R:R',rr!==null?num(rr,2):'—')+box('Liquidity',num(c.liquidity_quality,0))+box('Trap Risk',percent(c.pre_breakout_fingerprint?.trapRisk,0))+'</div>' +
        '<div class="rxsuite-row"><div><b>Advisor</b><small>'+esc(reason)+'</small></div><span class="rxsuite-tag '+cl+'">'+act+'</span></div>';
    }catch(e){o.innerHTML='<div class="rxsuite-row"><b>DATA UNAVAILABLE</b><small>'+esc(e.message)+'</small></div>';}
  };
}

function hubPanel(root) {
  root.innerHTML='<div class="rxsuite-actions"><button id="rx-hr" class="rxsuite-btn primary">تحديث مركز الإشارات</button></div>' +
    '<p class="rxsuite-row">هذه الوحدة تعرض مصادر RadarX. لا يتم اختلاق وصول إلى 200 قناة Telegram خارجية بدون API أو تفويض رسمي.</p><div id="rx-ho"></div>';
  root.querySelector('#rx-hr').onclick=async()=>{
    const o=root.querySelector('#rx-ho');o.innerHTML='<p class="rxsuite-row">تحديث…</p>';
    try{
      const b=await market();
      o.innerHTML=(b.candidates||[]).slice(0,12).map((c,i)=>
        '<div class="rxsuite-row"><div><b>'+(i+1)+'. '+esc(c.symbol)+'</b><small>'+esc(c.best_strategy||'—')+' · score '+num(c.overall_score,1)+' · liquidity '+num(c.liquidity_quality,0)+'</small></div><span class="rxsuite-tag '+(c.signal_state==='CONFIRMED'?'rxsuite-ok':'rxsuite-warn')+'">'+esc(c.signal_state||'UNKNOWN')+'</span></div>'
      ).join('')||'<p class="rxsuite-row">لا توجد نتائج.</p>';
    }catch(e){o.innerHTML='<div class="rxsuite-row"><b>DATA UNAVAILABLE</b><small>'+esc(e.message)+'</small></div>';}
  };
  root.querySelector('#rx-hr').click();
}

function supplyPanel(root) {
  root.innerHTML='<div class="rxsuite-form"><div class="rxsuite-field"><label>الرمز</label><input id="rx-sds" class="rxsuite-input" value="BTCUSDT"></div></div>' +
    '<div class="rxsuite-actions"><button id="rx-sdr" class="rxsuite-btn primary">اكتشف Supply / Demand</button></div><div id="rx-sdo"></div>';
  root.querySelector('#rx-sdr').onclick=async()=>{
    const o=root.querySelector('#rx-sdo'),s=root.querySelector('#rx-sds').value.trim().toUpperCase();o.innerHTML='<p class="rxsuite-row">جاري الاكتشاف…</p>';
    try{
      const b=await market(),c=findCandidate(b,s);if(!c)throw Error('NO_CURRENT_CANDIDATE');
      const p=Number(c.last_price),fp=c.pre_breakout_fingerprint||{};
      o.innerHTML='<div class="rxsuite-grid">'+box('Demand 1',num(p*.988,8))+box('Demand 2',num(p*.972,8))+box('Supply 1',num(p*1.012,8))+box('Supply 2',num(p*1.028,8))+box('Resistance tests',fp.resistance?.remainingTests??'—')+box('Fingerprint',fp.stage||'NORMAL')+'</div>';
    }catch(e){o.innerHTML='<div class="rxsuite-row"><b>DATA UNAVAILABLE</b><small>'+esc(e.message)+'</small></div>';}
  };
}

export function mountTradliFeatureSuite(container) {
  addStyle();
  container.innerHTML='<section class="rxsuite"><div style="font-size:17px;font-weight:950">RadarX Intelligence Suite</div>' +
    '<div class="rxsuite-row">وظائف مستقلة من فئة TRADLI مدمجة داخل RadarX. التداول الحقيقي غير مفعّل.</div>' +
    '<div class="rxsuite-tabs">' +
    '<button class="rxsuite-tab active" data-tab="chart">Chart Lab</button><button class="rxsuite-tab" data-tab="verify">Verify</button>' +
    '<button class="rxsuite-tab" data-tab="advisor">Advisor</button><button class="rxsuite-tab" data-tab="hub">Signals Hub</button><button class="rxsuite-tab" data-tab="sd">Supply / Demand</button></div>' +
    '<div id="rx-p-chart" class="rxsuite-pane active"></div><div id="rx-p-verify" class="rxsuite-pane"></div><div id="rx-p-advisor" class="rxsuite-pane"></div><div id="rx-p-hub" class="rxsuite-pane"></div><div id="rx-p-sd" class="rxsuite-pane"></div></section>';
  const tabs=[...container.querySelectorAll('.rxsuite-tab')];
  tabs.forEach(t=>t.onclick=()=>{tabs.forEach(x=>x.classList.toggle('active',x===t));['chart','verify','advisor','hub','sd'].forEach(k=>container.querySelector('#rx-p-'+k).classList.toggle('active',k===t.dataset.tab));});
  chartPanel(container.querySelector('#rx-p-chart'));
  verifyPanel(container.querySelector('#rx-p-verify'));
  advisorPanel(container.querySelector('#rx-p-advisor'));
  hubPanel(container.querySelector('#rx-p-hub'));
  supplyPanel(container.querySelector('#rx-p-sd'));
}
