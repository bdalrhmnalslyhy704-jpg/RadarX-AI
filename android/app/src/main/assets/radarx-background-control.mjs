const STYLE_ID='radarx-background-control-style';

function addStyle(){
  if(document.getElementById(STYLE_ID))return;
  const s=document.createElement('style');
  s.id=STYLE_ID;
  s.textContent=[
    '.rx-bg-card{margin:10px 0;padding:14px;border:1px solid #254461;border-radius:18px;background:linear-gradient(145deg,#0c1726,#09111d);box-shadow:0 12px 30px rgba(0,0,0,.18)}',
    '.rx-bg-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.rx-bg-title{font-weight:950;font-size:15px}.rx-bg-sub{color:#90a7bc;font-size:11px;line-height:1.6;margin-top:3px}',
    '.rx-bg-state{display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border-radius:999px;border:1px solid #2b526d;font-size:10px;font-weight:900}',
    '.rx-bg-dot{width:7px;height:7px;border-radius:50%;background:#6b7f91}.rx-bg-dot.live{background:#43e0a3;box-shadow:0 0 10px #43e0a3}',
    '.rx-bg-actions{display:flex;gap:8px;margin-top:12px}.rx-bg-btn{flex:1;min-height:46px;border-radius:13px;border:1px solid #2b526d;background:#0d2232;color:#eaf5f8;font-weight:900;font:inherit}.rx-bg-btn.primary{background:linear-gradient(135deg,#199bd3,#5d67f5);border-color:#39b9ea;color:#06101b}.rx-bg-btn.stop{background:#2a1519;border-color:#7d3e49;color:#ffdfe3}.rx-bg-note{margin-top:9px;color:#6f879b;font-size:10px;line-height:1.6}'
  ].join('');
  document.head.appendChild(s);
}

export function mountBackgroundMonitorControl(root){
  addStyle();
  root.innerHTML=
    '<section class="rx-bg-card" aria-label="Background Monitor">'+
      '<div class="rx-bg-head"><div><div class="rx-bg-title">🛰️ Move Radar 24/7 • 3 رادارات RadarX مستقلة</div>'+
      '<div class="rx-bg-sub">يشغّل 3 رادارات مستقلة في الخلفية: Early-Wake/Pre-Explosion، Strong-Move/Burst، وRotation/Lag لاكتشاف العملات المتأخرة التي تبدأ تلحق بالسوق.</div></div>'+
      '<div id="rx-bg-state" class="rx-bg-state"><span id="rx-bg-dot" class="rx-bg-dot"></span><span id="rx-bg-label">متوقفة</span></div></div>'+
      '<div class="rx-bg-actions"><button id="rx-bg-start" class="rx-bg-btn primary" type="button">تشغيل في الخلفية</button>'+
      '<button id="rx-bg-stop" class="rx-bg-btn stop" type="button">إيقاف</button></div>'+
      '<div class="rx-bg-note">الراداران للتحليل فقط ولا يرسلان أوامر تداول. الخادم يستمر 24/7؛ لكل رادار سجل تنبيهات مستقل، والهاتف يستأنف استقبالها عند عودة الإنترنت.</div>'+
    '</section>';

  const start=root.querySelector('#rx-bg-start');
  const stop=root.querySelector('#rx-bg-stop');
  const label=root.querySelector('#rx-bg-label');
  const dot=root.querySelector('#rx-bg-dot');

  function isNative(){
    return window.RadarXNative && typeof window.RadarXNative.isBackgroundMonitorRunning==='function';
  }
  function refresh(){
    const running=isNative() && window.RadarXNative.isBackgroundMonitorRunning();
    label.textContent=running?'تعمل الآن':'متوقفة';
    dot.classList.toggle('live',running);
    start.disabled=running;
    stop.disabled=!running;
    start.textContent=running?'المراقبة مفعّلة':'تشغيل في الخلفية';
  }
  start.onclick=()=>{
    if(!isNative()){
      label.textContent='متاح داخل تطبيق Android فقط';
      dot.classList.remove('live');
      return;
    }
    window.RadarXNative.startBackgroundMonitor();
    setTimeout(refresh,700);
  };
  stop.onclick=()=>{
    if(isNative())window.RadarXNative.stopBackgroundMonitor();
    setTimeout(refresh,400);
  };
  refresh();
  setInterval(refresh,3000);
}
