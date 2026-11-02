import {getRadarOutcomeReport} from './radarx-backend-client.mjs';

const root=document.getElementById('auditRoot');
const refreshButton=document.getElementById('refreshAudit');
const statusNode=document.getElementById('auditStatus');
const updatedNode=document.getElementById('auditUpdated');
const names={
  RADAR_1:'المدمر',RADAR_2:'ملك الظلام',RADAR_3:'الجوكر',RADAR_4:'الكاسح',
  RADAR_5:'القاهر',RADAR_6:'يوم القيامة',RADAR_7:'المقاوم',RADAR_8:'البرق',
  RADAR_9:'عين الصقر',RADAR_10:'صائد العملات',RADAR_11:'تجمع الحيتان',RADAR_12:'البروفيسور'
};
const horizons=['5m','15m','30m','60m','4h','24h'];
let busy=false,dead=false,timer=null;

function esc(value){
  return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function num(value,digits=2){
  if(value===null||value===undefined||!Number.isFinite(Number(value)))return '—';
  const n=Number(value);
  return (n>0?'+':'')+n.toFixed(digits)+'%';
}
function integer(value){return Number.isFinite(Number(value))?String(Number(value)):'0';}
function rate(stat,key){
  if(!stat||stat.rate_status!=='READY_N_GE_30')return '<span class="muted">عينة غير كافية</span>';
  return esc(num(stat[key]));
}
function horizonCell(stat){
  if(!stat)return '<span class="muted">لا بيانات</span>';
  return '<div class="hcell"><b>إغلاق '+esc(num(stat.avg_close_return_pct))+'</b>'+
    '<small>مواتية '+esc(num(stat.avg_max_favorable_pct))+' · تراجع '+esc(num(stat.avg_max_adverse_pct))+'</small>'+
    '<small>مكتملة '+integer(stat.completed_samples)+' · انتظار '+integer(stat.pending_samples)+'</small></div>';
}
function radarCard(row){
  const id=String(row.radar||'');
  const name=names[id]||id;
  const strict=row.horizons||{};
  const watch=row.watch_only_horizons||{};
  return '<article class="radar-card">'+
    '<header><div><span class="radar-id">'+esc(id)+'</span><h2>'+esc(name)+'</h2></div>'+
      '<div class="counts"><b>'+integer(row.emitted_alerts??row.archived_signals)+'</b><small>إشارات دخول</small></div>'+
      '<div class="counts watch"><b>'+integer(row.watch_only_observations)+'</b><small>مراقبة مبكرة</small></div></header>'+
    '<div class="cohort"><b>إشارات الدخول</b><span>نتائج بعد 5 دقائق</span></div>'+horizonCell(strict['5m'])+
    '<div class="cohort"><b>WATCH_EARLY</b><span>مراقبة فقط · لا تعني دخول</span></div>'+horizonCell(watch['5m'])+
    '<details><summary>عرض جميع الآفاق الزمنية</summary>'+
      '<div class="horizon-grid">'+horizons.map(key=>'<div><small>'+esc(key)+'</small>'+horizonCell(strict[key])+'</div>').join('')+'</div>'+
      '<div class="horizon-grid watch-grid">'+horizons.map(key=>'<div><small>'+esc(key)+' · مراقبة'+'</small>'+horizonCell(watch[key])+'</div>').join('')+'</div>'+
      '<div class="muted">نسبة بلوغ +1% خلال 5 دقائق: '+rate(strict['5m'],'max_favorable_gte_1pct_rate')+
      ' · نسبة التراجع ≤ -2%: '+rate(strict['5m'],'max_adverse_lte_minus_2pct_rate')+'</div>'+
    '</details></article>';
}
async function refresh(){
  if(busy||dead)return;
  busy=true;refreshButton.disabled=true;
  statusNode.textContent='جارٍ تحميل النتائج المحفوظة من الخادم…';
  try{
    const response=await getRadarOutcomeReport();
    if(!response.ok)throw new Error(response.error||'HTTP_'+response.status);
    const report=response.body||{};
    const rows=Array.isArray(report.by_radar)?report.by_radar:[];
    if(rows.length!==12)throw new Error('RADAR_ARCHIVE_COVERAGE_INVALID_'+rows.length);
    const summary=report.summary||{};
    document.getElementById('totalAlerts').textContent=integer(summary.emitted_alerts??summary.archived_signals);
    document.getElementById('totalWatch').textContent=integer(summary.watch_only_observations);
    document.getElementById('totalTracked').textContent=integer(summary.tracked_observations);
    root.innerHTML=rows.map(radarCard).join('');
    const policy=report.interpretation||{};
    statusNode.textContent='تم تحميل تدقيق الرادارات الاثني عشر · المصدر: شموع Binance Spot المغلقة';
    updatedNode.textContent='آخر تحديث: '+new Date(report.as_of||Date.now()).toLocaleString('ar-YE',{timeZone:'Asia/Aden'});
    const notes=[];
    if(policy.watch_only_observations_measured_separately)notes.push('إشارات WATCH_EARLY تُقاس في مجموعة مستقلة.');
    if(policy.watch_only_observations_are_not_entry_signals)notes.push('المراقبة المبكرة ليست توصية دخول.');
    notes.push('لا تُحسب نسب الأداء قبل 30 عينة مكتملة لكل أفق.');
    notes.push('بيانات الشموع تقيس أعلى وأدنى حركة داخل النافذة، ولا تثبت وقت تنفيذ صفقة.');
    document.getElementById('auditNotes').textContent=notes.join(' ');
  }catch(error){
    statusNode.textContent='تعذّر تحميل التقرير: '+String(error?.message||error);
    root.innerHTML='<div class="empty">لم يصل تقرير صالح من الخادم. تأكد من تشغيل خدمة Build 224 ثم حدّث الصفحة.</div>';
  }finally{busy=false;refreshButton.disabled=false;}
}
refreshButton.addEventListener('click',refresh);
window.addEventListener('pagehide',()=>{dead=true;if(timer)clearInterval(timer);},{once:true});
refresh();
timer=setInterval(refresh,90000);
