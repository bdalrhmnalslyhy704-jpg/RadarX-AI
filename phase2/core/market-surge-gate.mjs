const C=(v,a=0,b=100)=>Math.max(a,Math.min(b,Number.isFinite(Number(v))?Number(v):50));
const N=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;

export function buildSurgeFingerprint(candidate={}){
  const change=N(candidate.price_change_24h,0);
  const f=candidate.fast_impulse_context||{};
  const pre=N(candidate.pre_move_context?.score,0);
  const strat=N(candidate.overall_score,0);
  const liq=N(candidate.liquidity_quality,0);
  const dq=N(candidate.data_quality,0);
  const fast=N(f.score,0);
  const momentum=N(f.scores?.momentum,fast);
  const volume=N(f.scores?.volume,50);
  const taker=N(f.scores?.taker_buy,50);
  const breakout=N(f.scores?.breakout,50);
  const range=N(f.scores?.range_expansion,50);
  const body=N(f.scores?.body,50);
  const moveScore=change>=20?100:change>=12?97:change>=9?93:change>=6?88:change>=4?76:change>=2?58:change>=1?45:35;
  const high=N(candidate.high_price_24h,null),last=N(candidate.last_price,null);
  const nearHigh=Number.isFinite(high)&&high>0&&Number.isFinite(last)
    ? C(100-Math.max(0,(high-last)/high*100)*18)
    : 50;
  const acceleration=N(f.acceleration_pct,0);
  const accelerationScore=C(50+acceleration*35);
  const participation=C(volume*.45+taker*.35+range*.20);
  const ignition=C(momentum*.28+volume*.20+taker*.17+breakout*.15+range*.10+body*.10);
  const early=C(pre*.42+ignition*.28+nearHigh*.15+strat*.10+liq*.05);
  const strong=C(moveScore*.26+ignition*.32+accelerationScore*.12+strat*.14+liq*.08+dq*.08);
  const trap=N(candidate.risk_flags?.length,0);
  const qualityGate=dq>=70&&liq>=60;
  const explosive=(change>=6&&ignition>=70&&qualityGate)||(change>=10&&ignition>=62&&qualityGate);
  const earlyBreakout=change<6&&change>-6&&pre>=80&&ignition>=68&&strat>=60&&qualityGate;
  const tier=explosive?'EXPLOSIVE_6P':earlyBreakout?'EARLY_BREAKOUT':change>=4&&ignition>=65?'MOMENTUM_BUILD':strong>=72?'HIGH_CONVICTION':'WATCH';
  const meaningful=tier!=='WATCH';
  const reasons=[
    change>=6?'MOVE_ALREADY_6P_OR_MORE':null,
    change>=4&&change<6?'APPROACHING_6P_MOMENTUM':null,
    change<6&&pre>=80?'PRE_MOVE_FINGERPRINT':null,
    ignition>=72?'IGNITION_CONFLUENCE':null,
    momentum>=68?'MOMENTUM_ACCELERATION':null,
    volume>=68?'VOLUME_EXPANSION':null,
    taker>=68?'TAKER_BUY_PRESSURE':null,
    breakout>=75?'BREAKOUT_PRESSURE':null,
    nearHigh>=82?'NEAR_24H_HIGH':null,
    strat>=70?'STRATEGY_CONFLUENCE':null,
    liq>=75?'LIQUIDITY_OK':null,
    trap>=3?'MULTIPLE_RISK_FLAGS':null
  ].filter(Boolean);
  return {
    score:Number(strong.toFixed(1)),
    early_score:Number(early.toFixed(1)),
    ignition_score:Number(ignition.toFixed(1)),
    participation_score:Number(participation.toFixed(1)),
    move_score:Number(moveScore.toFixed(1)),
    tier,
    meaningful,
    quality_gate:qualityGate,
    change_24h_pct:Number(change.toFixed(3)),
    near_high_score:Number(nearHigh.toFixed(1)),
    acceleration_score:Number(accelerationScore.toFixed(1)),
    reasons
  };
}

export function rankMeaningfulCandidates(candidates=[]){
  return [...(Array.isArray(candidates)?candidates:[])].map(c=>({...c,surge_fingerprint:buildSurgeFingerprint(c)}))
    .sort((a,b)=>{
      const aa=a.surge_fingerprint,bb=b.surge_fingerprint;
      const tierRank={EXPLOSIVE_6P:4,EARLY_BREAKOUT:3,MOMENTUM_BUILD:2,HIGH_CONVICTION:1,WATCH:0};
      return (tierRank[bb.tier]||0)-(tierRank[aa.tier]||0) ||
        bb.score-aa.score ||
        Number(bb.fast_impulse_context?.score||0)-Number(aa.fast_impulse_context?.score||0) ||
        Number(bb.price_change_24h||0)-Number(aa.price_change_24h||0);
    });
}

export function selectSurgeSurface(candidates=[],{limit=10}={}){
  const ranked=rankMeaningfulCandidates(candidates);
  const meaningful=ranked.filter(x=>x.surge_fingerprint?.meaningful);
  return {
    all:ranked.slice(0,Math.max(1,Math.min(50,Math.trunc(limit)||10))),
    meaningful:meaningful.slice(0,Math.max(1,Math.min(20,Math.trunc(limit)||10))),
    explosive:meaningful.filter(x=>x.surge_fingerprint.tier==='EXPLOSIVE_6P').slice(0,20),
    early:meaningful.filter(x=>x.surge_fingerprint.tier==='EARLY_BREAKOUT').slice(0,20)
  };
}
