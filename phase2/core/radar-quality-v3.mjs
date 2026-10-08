import {evaluateFalconEye} from './radar-falcon-core.mjs';

const clamp=(v,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number.isFinite(Number(v))?Number(v):0));
const arr=v=>Array.isArray(v)?v:[];
const upper=v=>String(v||'').toUpperCase();

const LIMITS=Object.freeze({
  EARLY_MOVE_RADAR:8,STRONG_MOVE_RADAR:18,ROTATION_LAG_RADAR:8,
  LIQUIDITY_ABSORPTION_RADAR:8,KAHIR_RADAR:15,DOOMSDAY_RADAR:18,
  PROFESSOR_RADAR:20,ALMUQAWIM_RADAR:12,EARLY_EXPANSION_RADAR:12,
  COIN_HUNTER_RADAR:8,WHALE_ACCUMULATION_RADAR:8
});

function evidenceCount(alert){
  const reasons=arr(alert&&alert.reasons).filter(Boolean).length;
  const codes=arr(alert&&alert.reason_codes).filter(x=>!upper(x).startsWith('STALE')).length;
  const components=alert&&alert.components;
  let numeric=0;
  if(components&&typeof components==='object'){
    for(const value of Object.values(components)){
      if(Number.isFinite(Number(value)))numeric++;
    }
  }
  return Math.min(12,reasons+Math.min(5,codes)+Math.min(5,numeric));
}

export function evaluateRadarQuality(alert={},options={}){
  const radar=upper(alert.radar);
  const data=clamp(alert.data_quality??alert.data_status?.data_quality??alert.components?.data_quality??100);
  const liquidity=clamp(alert.liquidity_quality??alert.components?.liquidity??100);
  const price24=Number(alert.price_change_24h);
  const limit=Number(LIMITS[radar]||12);
  const chasePenalty=Number.isFinite(price24)?clamp(Math.max(0,Math.abs(price24)-limit)*8,0,30);

  const hist=alert.historical_followthrough||alert.components?.historical_followthrough||alert.fast_impulse_context?.historical_followthrough||{};
  const histSamples=Number(hist.samples)||0;
  const histScore=Number(hist.score);
  const empirical=histSamples>=5&&Number.isFinite(histScore)?clamp(histScore):55;

  const evidence=evidenceCount(alert);
  const evidenceScore=clamp(45+evidence*5);
  const riskCount=arr(alert.risk_flags).length;
  const explicitRisk=arr(alert.risk_flags).some(x=>/STALE|FUTURE|INVALID|EXTENDED|CHAS|WIDE_SPREAD|LOW_LIQUIDITY/i.test(String(x)));
  const dataOk=data>=70,liquidityOk=liquidity>=60;

  const falcon=evaluateFalconEye(alert,{now:Number(options.now)||Date.now(),limits:LIMITS});
  const opportunity=clamp(alert.opportunity_score??alert.setup_score??alert.radar_power_score??50);
  const classicScore=
    opportunity*.38+
    data*.16+
    liquidity*.13+
    evidenceScore*.08+
    empirical*.10+
    falcon.quality*.15-
    Math.min(12,riskCount*2)-
    chasePenalty;

  const score=clamp(classicScore);
  const hardFail=
    explicitRisk||
    !dataOk||
    !liquidityOk||
    Boolean(alert.data_status?.future_data_detected)||
    Boolean(alert.data_status?.stale)||
    Boolean(falcon.hard_fail);

  return {
    version:'RADAR_QUALITY_V4_FALCON',
    score:Number(score.toFixed(1)),
    hard_fail:hardFail,
    data_quality:Number(data.toFixed(1)),
    liquidity_quality:Number(liquidity.toFixed(1)),
    evidence_count:evidence,
    evidence_score:Number(evidenceScore.toFixed(1)),
    historical_followthrough_score:histSamples>=5&&Number.isFinite(histScore)?Number(histScore.toFixed(1)):null,
    historical_followthrough_samples:histSamples,
    chase_penalty:Number(chasePenalty.toFixed(1)),
    risk_count:riskCount,
    falcon_eye:falcon,
    target_24h_abs_move_before_signal_pct:limit,
    decision:hardFail?'REJECT':score>=82?'HIGH_QUALITY':score>=70?'QUALITY_WATCH':'LOW_QUALITY'
  };
}
