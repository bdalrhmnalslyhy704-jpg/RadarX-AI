import {getKingIntelligence,getKingMarket} from './radarx-backend-client.mjs';

const $=id=>document.getElementById(id);
const output=$('output');
const status=$('status');
const form=$('kingForm');
const symbolInput=$('symbol');
const marketBtn=$('marketBtn');

function esc(v){return String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function fmt(v,d=1){const n=Number(v);return Number.isFinite(n)?n.toFixed(d):'—';}
function actionText(a){
  return ({PAPER_ENTRY_CANDIDATE:'فرصة مبكرة مشروطة',PAPER_WATCH:'مراقبة قوية',WAIT_CONFIRMATION:'انتظار التأكيد',SPOT_AVOID:'تجنب حاليًا'})[a]||a||'غير متاح';
}
function renderVerdict(v){
  const cats=v.category_scores||{};
  const positive=v.reasons?.positive||[];
  const negative=v.reasons?.negative||[];
  const facts=v.deep_facts||{};
  output.innerHTML=
    '<div class="row"><div><span class="badge">'+esc(v.stage||'KING_WAIT')+'</span> <span class="badge">'+esc(actionText(v.action))+'</span></div><b>'+esc(v.stance||'')+'</b></div>'+
    '<div class="hero" style="margin-top:12px">'+
      '<div class="metric"><small>King Score</small><b>'+fmt(v.score)+'/100</b></div>'+
      '<div class="metric"><small>توافق الرادارات</small><b>'+esc(v.independent_radar_count||0)+'</b></div>'+
      '<div class="metric"><small>الاتجاه العميق</small><b>'+fmt(facts.direction)+'</b></div>'+
      '<div class="metric"><small>خطر الفخ</small><b>'+fmt(facts.trap_risk)+'</b></div>'+
    '</div>'+
    '<h3>لماذا قال الكنق هذا؟</h3>'+
    positive.map(x=>'<div class="reason">✅ '+esc(x)+'</div>').join('')+
    negative.map(x=>'<div class="reason neg">⚠️ '+esc(x)+'</div>').join('')+
    '<h3>المحاور</h3>'+
    Object.entries(cats).map(([k,val])=>'<div class="reason"><b>'+esc(k)+'</b> — '+fmt(val)+'</div>').join('')+
    '<h3>معلومات الفحص العميق</h3>'+
    '<div class="reason">السعر المرجعي: '+fmt(facts.price,8)+' • الدعم: '+fmt(facts.support,8)+' • المقاومة: '+fmt(facts.resistance,8)+' • RVOL: '+fmt(facts.rvol,2)+'</div>'+
    '<div class="reason">الرادارات: '+(v.independent_radars||[]).map(esc).join(' • ')+'</div>'+
    '<p class="muted">'+esc(v.disclaimer||'')+'</p>';
}
function renderMarket(body){
  const rows=body?.candidates||[];
  if(!rows.length){output.innerHTML='<div class="muted">لا توجد حاليًا مرشحات كافية اجتازت الأدلة المسجلة.</div>';return;}
  output.innerHTML='<div class="row"><b>👑 حكم الكنق على السوق</b><span class="badge">'+rows.length+' مرشحين</span></div>'+
    rows.map((v,i)=>'<div class="card" style="margin:10px 0;background:#0e1824;border-color:#29415a"><div class="row"><b>#'+(i+1)+' '+esc(v.symbol)+'</b><span class="badge">'+fmt(v.score)+'</span></div><div class="reason">'+esc(v.stance||'')+' • '+esc(actionText(v.action))+' • رادارات مستقلة: '+esc(v.independent_radar_count||0)+'</div></div>').join('');
}
async function analyze(){
  const symbol=String(symbolInput.value||'').trim().toUpperCase();
  if(!/^[A-Z0-9]{5,20}$/.test(symbol)){output.innerHTML='<div class="reason neg">رمز العملة غير صحيح.</div>';return;}
  status.textContent='جاري التحليل...';
  output.innerHTML='<div class="muted">الكنق يجمع الأدلة ويجري الفحص العميق. لا توجد بيانات مصطنعة.</div>';
  try{
    const res=await getKingIntelligence({symbol,deep:true});
    if(!res.ok){output.innerHTML='<div class="reason neg">تعذر التحليل: HTTP_'+res.status+'</div>';status.textContent='غير متاح';return;}
    renderVerdict(res.body);status.textContent='تحليل مكتمل';
  }catch(e){output.innerHTML='<div class="reason neg">تعذر الاتصال بالكنق: '+esc(e?.message||e)+'</div>';status.textContent='انقطاع';}
}
async function market(){
  status.textContent='مسح السوق...';output.innerHTML='<div class="muted">يتم ترتيب المرشحين من الأدلة الموجودة فقط؛ لا يبدأ فحصًا مستمرًا.</div>';
  try{const res=await getKingMarket({limit:5,deep:false});if(!res.ok){output.innerHTML='<div class="reason neg">تعذر فحص السوق: HTTP_'+res.status+'</div>';status.textContent='غير متاح';return;}renderMarket(res.body);status.textContent='السوق مفحوص';}
  catch(e){output.innerHTML='<div class="reason neg">تعذر الاتصال: '+esc(e?.message||e)+'</div>';status.textContent='انقطاع';}
}
form.addEventListener('submit',e=>{e.preventDefault();analyze();});
marketBtn.addEventListener('click',market);
