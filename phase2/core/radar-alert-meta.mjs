export const RADAR_NAMES=Object.freeze({
  EARLY_MOVE_RADAR:'Radar 1 — Early-Wake',
  STRONG_MOVE_RADAR:'Radar 2 — Strong-Move',
  ROTATION_LAG_RADAR:'Radar 3 — Rotation/Lag',
  LIQUIDITY_ABSORPTION_RADAR:'Radar 4 — Liquidity Absorption'
});
export function formatRadarTime12h(ms,timeZone='Asia/Aden'){
  const d=new Date(Number(ms));
  if(!Number.isFinite(d.getTime()))return 'غير متاح';
  const parts=new Intl.DateTimeFormat('ar-YE',{timeZone,hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true}).formatToParts(d);
  const map=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  const day=String(map.day||'').padStart(2,'0'),month=String(map.month||'').padStart(2,'0'),year=map.year||'';
  return `${day}/${month}/${year} • ${map.hour||'12'}:${map.minute||'00'}:${map.second||'00'} ${map.dayPeriod||''}`.trim();
}
export function decorateRadarAlert(alert,radarName){
  const now=Number(alert?.detected_at);
  const at=Number.isFinite(now)?now:Date.now();
  return {...alert,radar_name:alert?.radar_name||radarName||RADAR_NAMES[alert?.radar]||'RadarX',detected_at:at,
    detected_at_iso:alert?.detected_at_iso||new Date(at).toISOString(),
    detected_time_12h:alert?.detected_time_12h||formatRadarTime12h(at),
    detected_timezone:'Asia/Aden',paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'};
}
