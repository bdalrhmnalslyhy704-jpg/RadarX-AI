const DEFAULT_CAPACITY = 3000;

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function percentile(values, p) {
  const xs = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = Math.max(0, Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1));
  return Math.round(xs[i] * 100) / 100;
}
function round(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
}
function reasonsOf(gate) {
  const failures = Array.isArray(gate?.failures) ? gate.failures : [];
  return [...new Set(failures.map(x => String(x).slice(0, 120)))].slice(0, 20);
}
function stageOf(alert) {
  return alert?.potential_label ?? alert?.stage ?? alert?.strong_move?.stage ??
    alert?.early_expansion?.stage ?? alert?.doomsday?.stage ?? alert?.rotation?.stage ??
    alert?.kahir_analysis?.stage ?? alert?.early_wake?.stage ?? null;
}
function candleCloseOf(alert) {
  return finite(alert?.source_event_at ?? alert?.source_candle_close_at ??
    alert?.strong_move?.source_candle_close_at ?? alert?.strong_move?.metrics?.source_candle_close_at ??
    alert?.candle?.close_time ?? alert?.signal?.candle?.close_time ?? null);
}
function liquidityAccelerationOf(alert) {
  return finite(alert?.strong_move?.metrics?.liquidity_acceleration?.three_minute_acceleration ??
    alert?.metrics?.liquidity_acceleration?.three_minute_acceleration ??
    alert?.liquidity_acceleration?.three_minute_acceleration ??
    alert?.early_expansion?.metrics?.liquidity_acceleration ?? null);
}
function radarOf(alert, gate) {
  return String(gate?.radar ?? alert?.radar ?? alert?.radar_id ?? "UNKNOWN").toUpperCase().slice(0, 80);
}

export class RadarTelemetry {
  constructor({capacity = DEFAULT_CAPACITY, clock = () => Date.now()} = {}) {
    this.capacity = Math.max(100, Math.min(20000, Math.trunc(Number(capacity) || DEFAULT_CAPACITY)));
    this.clock = clock;
    this.events = [];
    this.totalRecorded = 0;
    this.totalByRadar = new Map();
    this.lastEventAt = null;
  }

  recordDecision(alert = {}, gate = {}, {now = this.clock(), source = "LIVE", extraReasons = []} = {}) {
    const decisionAt = finite(now) ?? this.clock();
    const observedAt = finite(alert?.observed_at ?? alert?.processed_at ?? alert?.detected_at) ?? decisionAt;
    const sourceEventAt = candleCloseOf(alert);
    const latency = Math.max(0, decisionAt - observedAt);
    const sourceAge = sourceEventAt == null ? null : Math.max(0, decisionAt - sourceEventAt);
    const failures = [...new Set([...reasonsOf(gate), ...extraReasons.map(x => String(x).slice(0, 120))])];
    const event = {
      id: String(alert?.id ?? (radarOf(alert, gate) + ":" + String(alert?.symbol ?? "UNKNOWN") + ":" + decisionAt + ":" + this.totalRecorded)).slice(0, 180),
      radar: radarOf(alert, gate),
      symbol: String(alert?.symbol ?? "UNKNOWN").toUpperCase().slice(0, 30),
      source: source === "REPLAY" ? "REPLAY" : "LIVE",
      observed_at: observedAt,
      source_event_at: sourceEventAt,
      decision_at: decisionAt,
      pipeline_latency_ms: round(latency),
      source_data_age_ms: sourceAge,
      queue_depth: finite(alert?.rest_queue_depth ?? alert?.rest?.queue_depth ?? null),
      queue_wait_ms: finite(alert?.rest_queue_wait_ms ?? alert?.rest?.queue_wait_ms_last ?? null),
      stage_observed: String(stageOf(alert) ?? "UNKNOWN").slice(0, 80),
      stage_decision: String(gate?.eligible === true ? "GATE_ACCEPTED" : "REJECTED"),
      decision: gate?.eligible === true ? "GATE_ACCEPTED" : "REJECTED",
      score: round(finite(gate?.score ?? alert?.opportunity_score ?? alert?.strong_move?.score)),
      price: finite(alert?.price ?? alert?.ticker?.lastPrice ?? alert?.strong_move?.price),
      liquidity_acceleration: round(liquidityAccelerationOf(alert), 6),
      reason_codes: failures,
      accepted: gate?.eligible === true,
      market: "SPOT",
      paper_trading: true,
      real_order_execution: false,
      confidence_score: "UNKNOWN"
    };
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    this.totalRecorded += 1;
    this.totalByRadar.set(event.radar, (this.totalByRadar.get(event.radar) || 0) + 1);
    this.lastEventAt = decisionAt;
    return event;
  }

  countForRadar(radar) {
    return this.totalByRadar.get(String(radar || "UNKNOWN").toUpperCase()) || 0;
  }

  snapshot({limit = 100} = {}) {
    const n = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
    const sorted = [...this.events].sort((a, b) => b.decision_at - a.decision_at);
    const accepted = this.events.filter(x => x.accepted);
    const rejected = this.events.filter(x => !x.accepted);
    const latencies = this.events.map(x => x.pipeline_latency_ms).filter(Number.isFinite);
    const ages = this.events.map(x => x.source_data_age_ms).filter(Number.isFinite);
    const byRadarMap = new Map();
    const reasons = new Map();
    for (const event of this.events) {
      if (!byRadarMap.has(event.radar)) byRadarMap.set(event.radar, []);
      byRadarMap.get(event.radar).push(event);
      for (const reason of event.reason_codes) reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
    const byRadar = [...byRadarMap.entries()].map(([radar, rows]) => {
      const rowLatencies = rows.map(x => x.pipeline_latency_ms).filter(Number.isFinite);
      const top = new Map();
      for (const row of rows) for (const reason of row.reason_codes) top.set(reason, (top.get(reason) || 0) + 1);
      const latest = [...rows].sort((a, b) => b.decision_at - a.decision_at)[0];
      return {
        radar, cycles: rows.length, gate_accepted: rows.filter(x => x.accepted).length,
        rejected: rows.filter(x => !x.accepted).length,
        latency_ms_p50: percentile(rowLatencies, 0.50), latency_ms_p95: percentile(rowLatencies, 0.95),
        last_seen_at: latest?.decision_at ?? null, queue_depth: latest?.queue_depth ?? null,
        queue_wait_ms: latest?.queue_wait_ms ?? null,
        top_reasons: [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({reason, count}))
      };
    }).sort((a, b) => b.cycles - a.cycles);
    return {
      as_of: new Date(this.clock()).toISOString(),
      buffer_capacity: this.capacity,
      retained_events: this.events.length,
      total_recorded: this.totalRecorded,
      summary: {
        cycles: this.events.length, total_cycles_recorded: this.totalRecorded, gate_accepted: accepted.length, rejected: rejected.length,
        latency_ms_p50: percentile(latencies, 0.50), latency_ms_p95: percentile(latencies, 0.95),
        latency_ms_max: latencies.length ? Math.max(...latencies) : null,
        source_data_age_ms_p95: percentile(ages, 0.95),
        newest_event_at: this.lastEventAt
      },
      by_radar: byRadar,
      top_rejection_reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([reason, count]) => ({reason, count})),
      events: sorted.slice(0, n),
      measurement_notes: {
        pipeline_latency_ms: "Software time from observation/processing timestamp to notification-gate decision; not exchange/network end-to-end latency.",
        source_data_age_ms: "Age of the source candle close at decision time; unavailable where no source candle timestamp is exposed.",
        liquidity_acceleration: "Derived from public market-data metrics when that radar exposes the field; null means not supplied, not zero.",
        cycles: "Gate evaluations observed by telemetry, not a count of every internal loop iteration in each radar."
      },
      policy: {market: "SPOT", paper_trading: true, real_order_execution: false, confidence_score: "UNKNOWN"}
    };
  }
}

export const radarTelemetry = new RadarTelemetry();

export function recordRadarDecision(alert, gate, options = {}) {
  return radarTelemetry.recordDecision(alert, gate, options);
}

const instrumentedRadarInstances = new WeakSet();
export function instrumentRadarCycle(instance, radarId, {clock = () => Date.now()} = {}) {
  if (!instance || instrumentedRadarInstances.has(instance)) return false;
  const methodName = typeof instance.tick === "function" ? "tick" :
    (typeof instance.cycle === "function" ? "cycle" : null);
  if (!methodName) return false;
  const radar = String(radarId || "UNKNOWN").toUpperCase();
  const originalTick = instance[methodName].bind(instance);
  instrumentedRadarInstances.add(instance);
  instance[methodName] = async function(...args) {
    if (instance.running !== true || instance.busy === true) return originalTick(...args);
    const before = radarTelemetry.countForRadar(radar);
    const beganAt = clock();
    let cycleError = null;
    try {
      return await originalTick(...args);
    } catch (error) {
      const raw = String(error?.message ?? error ?? "UNKNOWN_ERROR");
      cycleError = "CYCLE_ERROR:" + raw.replace(/[^a-z0-9_.:-]/gi, "_").slice(0, 70);
      throw error;
    } finally {
      if (radarTelemetry.countForRadar(radar) === before) {
        const finishedAt = clock();
        try {
          recordRadarDecision({
            radar, symbol: "SYSTEM", observed_at: beganAt, processed_at: finishedAt,
            stage: "TICK_CYCLE", price: null, source_event_at: null
          }, {
            radar, eligible: false, score: null,
            failures: [cycleError || "CYCLE_COMPLETED_WITHOUT_GATE_DECISION"]
          }, {now: finishedAt, source: "LIVE"});
        } catch {}
      }
    }
  };
  return true;
}

export function renderRadarTelemetryDashboard() {
  return String.raw`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RadarX — لوحة التشخيص الحية</title>
<style>
:root{color-scheme:dark;background:#0b1020;color:#e8edf8;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
body{margin:0;padding:18px;max-width:1400px;margin-inline:auto}h1{font-size:1.45rem;margin:0 0 6px}
p{color:#aebbd2;line-height:1.6}.muted{color:#93a4bf;font-size:.88rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin:18px 0}
.card,section{background:#121a2e;border:1px solid #293550;border-radius:12px;padding:13px;min-width:0}
.k{color:#aebbd2;font-size:.84rem}.v{font-size:1.55rem;font-weight:700;margin-top:5px;overflow-wrap:anywhere}
section{margin-top:12px}h2{font-size:1.05rem;margin:0 0 10px}table{width:100%;border-collapse:collapse;font-size:.88rem}th,td{text-align:right;padding:9px 7px;border-bottom:1px solid #293550;vertical-align:top}th{color:#b6c7e2}
.wrap{overflow:auto}.pill{display:inline-block;background:#263451;border-radius:999px;padding:3px 8px;font-size:.78rem}.yes{color:#86efac}.no{color:#fda4af}
ul{padding-right:20px}li{margin:7px 0;overflow-wrap:anywhere}.foot{border-top:1px solid #293550;margin-top:18px;padding-top:10px}
@media(max-width:600px){body{padding:10px}td,th{padding:7px 5px;font-size:.8rem}.v{font-size:1.25rem}}
</style></head>
<body>
<h1>RadarX — لوحة التشخيص الحية</h1>
<p>قياس بوابة القرار للرادارات. تُحدّث اللوحة تلقائيًا كل 5 ثوانٍ عند توفر الخدمة.</p>
<p id="state" class="muted">جارٍ تحميل القياسات…</p>
<div class="grid">
<div class="card"><div class="k">قرارات مسجلة في الذاكرة</div><div class="v" id="cycles">—</div></div>
<div class="card"><div class="k">اجتازت البوابة</div><div class="v yes" id="accepted">—</div></div>
<div class="card"><div class="k">مرفوضة</div><div class="v no" id="rejected">—</div></div>
<div class="card"><div class="k">زمن المعالجة P50</div><div class="v" id="p50">—</div></div>
<div class="card"><div class="k">زمن المعالجة P95</div><div class="v" id="p95">—</div></div>
<div class="card"><div class="k">عمر المصدر P95</div><div class="v" id="age">—</div></div>
</div>
<section><h2>حالة الرادارات والطوابير</h2><div class="wrap"><table><thead><tr><th>الرادار</th><th>الحالة</th><th>المسح/الدورات</th><th>قبول/رفض البوابة</th><th>زمن P95</th><th>عمق الطابور</th><th>أكثر أسباب الرفض</th></tr></thead><tbody id="radars"><tr><td colspan="7">لا توجد بيانات بعد</td></tr></tbody></table></div></section>
<section><h2>آخر قرارات الإشعار</h2><div class="wrap"><table><thead><tr><th>الوقت</th><th>الرادار</th><th>العملة</th><th>المرحلة</th><th>القرار</th><th>السعر</th><th>تسارع السيولة</th><th>أسباب الرفض</th></tr></thead><tbody id="events"><tr><td colspan="8">لا توجد بيانات بعد</td></tr></tbody></table></div></section>
<section><h2>الأسباب الأكثر تكرارًا</h2><ul id="reasons"><li>لا توجد أسباب مسجلة بعد</li></ul></section>
<div class="foot muted">تنبيه: زمن المعالجة هنا من سجل الرصد إلى قرار بوابة الإشعار، وليس زمن الشبكة الكامل أو ضمانًا لتنفيذ الإشعار. عمر البيانات يُقاس منفصلًا. المقاييس في ذاكرة العملية الحالية وتُمسح عند إعادة تشغيل الخدمة. البيانات المفقودة تظهر كـ «—» ولا تُفسَّر على أنها صفر. Spot / Paper Trading / قراءة فقط.</div>
<script>
(function(){
"use strict";
const $=id=>document.getElementById(id);
const fmt=(x,suffix)=>x===null||x===undefined||!Number.isFinite(Number(x))?"—":String(Number(x).toFixed(2))+(suffix||"");
const time=x=>{if(!x)return"—";try{return new Intl.DateTimeFormat("ar",{timeZone:"Asia/Aden",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:true}).format(new Date(x));}catch{return String(x);}};
const cell=(row,value)=>{const td=document.createElement("td");td.textContent=value===null||value===undefined?"—":String(value);row.appendChild(td);return td;};
function rows(target,values,cols,emptyText){target.replaceChildren();if(!values||!values.length){const tr=document.createElement("tr"),td=cell(tr,emptyText);td.colSpan=cols;target.appendChild(tr);return;}for(const item of values){const tr=document.createElement("tr");for(const val of item)cell(tr,val);target.appendChild(tr);}}
async function update(){
try{
 const response=await fetch("/api/radar-telemetry?limit=80",{cache:"no-store",headers:{Accept:"application/json"}});
 if(!response.ok)throw new Error("HTTP "+response.status);
 const data=await response.json(),s=data.summary||{};
 $("cycles").textContent=String(s.cycles??0);$("accepted").textContent=String(s.gate_accepted??0);$("rejected").textContent=String(s.rejected??0);
 $("p50").textContent=fmt(s.latency_ms_p50," ms");$("p95").textContent=fmt(s.latency_ms_p95," ms");$("age").textContent=fmt(s.source_data_age_ms_p95," ms");
 const health=new Map((data.radars||[]).map(x=>[x.radar,x]));
 const eventMap=new Map((data.by_radar||[]).map(x=>[x.radar,x]));
 const radarIds=[...new Set([...(data.radars||[]).map(x=>x.radar),...(data.by_radar||[]).map(x=>x.radar)])];
 const byRadar=radarIds.map(id=>{const x=eventMap.get(id)||{radar:id,cycles:0,gate_accepted:0,rejected:0,latency_ms_p95:null,queue_depth:null,top_reasons:[]};const h=health.get(id);const state=h?(h.running?"يعمل":"متوقف"):(x.cycles?"دورة مسجلة":"لا توجد دورة مسجلة");const scans=h&&h.health?(h.health.scans??h.health.cycles??"—"):"—";const acceptedRejected=String(x.gate_accepted)+"/"+String(x.rejected);const reasons=(x.top_reasons||[]).map(v=>v.reason+" ("+v.count+")").join("، ");return [x.radar,state,String(scans)+" / "+String(x.cycles),acceptedRejected,fmt(x.latency_ms_p95," ms"),x.queue_depth===null?"—":String(x.queue_depth),reasons||"—"];});
 rows($("radars"),byRadar,7,"لا توجد دورات أو قرارات مسجلة");
 const ev=(data.events||[]).map(x=>[time(x.decision_at),x.radar,x.symbol,x.stage_observed,(x.accepted?"قبول":"رفض")+" · "+String(x.score??"—"),x.price===null?"—":String(x.price),fmt(x.liquidity_acceleration,""),(x.reason_codes||[]).join("، ")||"—"]);
 rows($("events"),ev,8,"لا توجد أحداث");
 const rs=data.top_rejection_reasons||[];$("reasons").replaceChildren();if(!rs.length){const li=document.createElement("li");li.textContent="لا توجد أسباب رفض مسجلة بعد";$("reasons").appendChild(li);}else for(const x of rs){const li=document.createElement("li");li.textContent=x.reason+" — "+x.count;$("reasons").appendChild(li);}
 $("state").textContent="آخر تحديث: "+time(Date.now())+" · سجل محفوظ في الذاكرة: "+String(data.retained_events??0)+" / "+String(data.buffer_capacity??0);
}catch(error){$("state").textContent="تعذر جلب القياسات: "+String(error&&error.message||error)+" · سيُعاد المحاولة تلقائيًا";}
}
update();setInterval(update,5000);
})();
</script></body></html>`;
}
