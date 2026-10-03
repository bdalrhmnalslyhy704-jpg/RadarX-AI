export const RADAR_NAMES=Object.freeze({
  EARLY_MOVE_RADAR:'Radar 1 — Early-Wake',
  STRONG_MOVE_RADAR:'Radar 2 — Strong-Move',
  ROTATION_LAG_RADAR:'Radar 3 — Rotation/Lag',
  LIQUIDITY_ABSORPTION_RADAR:'Radar 4 — Liquidity Absorption'
});
export function formatRadarTime12h(ms,timeZone='Asia/Aden'){
  const d=new Date(Number(ms));
  if(!Number.isFinite(d.getTime()))return 'غير متاح';
  const dateParts=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
  const timeParts=new Intl.DateTimeFormat('en-US',{timeZone,hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true}).formatToParts(d);
  const date=Object.fromEntries(dateParts.map(x=>[x.type,x.value]));
  const time=Object.fromEntries(timeParts.map(x=>[x.type,x.value]));
  return `${date.day||'00'}/${date.month||'00'}/${date.year||''} • ${time.hour||'12'}:${time.minute||'00'}:${time.second||'00'} ${time.dayPeriod||''}`.trim();
}
export function decorateRadarAlert(alert,radarName){
  const now=Number(alert?.detected_at);
  const at=Number.isFinite(now)?now:Date.now();
  return {...alert,radar_name:alert?.radar_name||radarName||RADAR_NAMES[alert?.radar]||'RadarX',detected_at:at,
    detected_at_iso:alert?.detected_at_iso||new Date(at).toISOString(),
    detected_time_12h:alert?.detected_time_12h||formatRadarTime12h(at),
    detected_timezone:'Asia/Aden',paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'};
}
