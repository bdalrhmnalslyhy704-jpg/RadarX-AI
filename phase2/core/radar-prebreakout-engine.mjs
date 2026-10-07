const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number.isFinite(Number(v))?Number(v):0));
const num=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const avg=(xs,fallback=null)=>{const a=(xs||[]).map(Number).filter(Number.isFinite);return a.length?a.reduce((s,x)=>s+x,0)/a.length:fallback;};

function component(obj,paths,fallback=50){
  for(const path of paths){
    let node=obj;
    for(const key of String(path).split('.')) node=node?.[key];
    const n=Number(node);
    if(Number.isFinite(n))return clamp(n);
  }
  return fallback;
}

function ratioScore(ratio,center=1,sensitivity=90){
  const r=Number(ratio);
  return Number.isFinite(r)?clamp(50+(r-center)*sensitivity):50;
}

function pctScore(pct,scale=20){
  const n=Number(pct);
  return Number.isFinite(n)?clamp(50+n*scale):50;
}

export const PRE_BREAKOUT_DEFAULTS=Object.freeze({
  minDataQuality:80,
  minLiquidityQuality:70,
  minScore:78,
  minConfirmedScore:84,
  minConfirmations:6,
  minConfirmedConfirmations:7,
  max24hMovePct:8,
  hardLate24hMovePct:12,
  maxSessionReturnPct:6,
  minLeadGroups:4,
  microMovePct:0.30,
  microMoveAccelerationPct:0.12,
  minPersistenceObservations:2
});

export function buildPreBreakoutFingerprint({
  ticker={},
  bottom={},
  preMove={},
  fast={},
  strategies=[],
  dataQuality=0,
  liquidity=0,
  radar='UNKNOWN',
  now=Date.now(),
  config={}
}={}){
  const cfg={...PRE_BREAKOUT_DEFAULTS,...config};
  const priceChange24h=num(ticker?.priceChange24h ?? ticker?.price_change_24h,0);
  const sessionReturn=num(preMove?.session_return_pct,null);
  const fastAcceleration=num(fast?.acceleration_pct,null);
  const volumeRatio=num(fast?.volume_ratio ?? bottom?.algorithms?.volume_price_divergence?.rvol_ratio,null);
  const buyRatio=num(fast?.taker_buy_ratio ?? bottom?.algorithms?.taker_flow?.buy_ratio,null);
  const buyDelta=num(fast?.taker_buy_delta ?? bottom?.algorithms?.taker_flow?.buy_delta ?? preMove?.taker_buy_acceleration,null);
  const breakoutDistance=num(fast?.breakout_distance_pct,null);

  const compression=component(bottom,[
    'metrics.compression',
    'algorithms.squeeze.score'
  ],45);
  const structure=component(bottom,[
    'metrics.structure',
    'algorithms.price_structure.score'
  ],45);
  const flow=component(bottom,[
    'metrics.buying_pressure',
    'algorithms.taker_flow.score',
    'algorithms.orderbook_pressure.score'
  ],45);
  const orderbook=component(bottom,[
    'metrics.orderbook_imbalance',
    'algorithms.orderbook_pressure.score'
  ],45);
  const relative=component(preMove,[
    'components.relative_strength',
    'components.relative_strength_vs_market_pct'
  ],50);
  const resistance=component(preMove,['components.resistance_proximity'],45);
  const mtf=component(bottom,['metrics.mtf_alignment','algorithms.mtf_alignment.score'],45);
  const liquidityScore=clamp(liquidity);
  const dataScore=clamp(dataQuality);
  const momentum=component(bottom,['metrics.momentum','algorithms.momentum_awaken.score'],45);
  const participationBase=component(bottom,[
    'algorithms.volume_price_divergence.score',
    'algorithms.momentum_awaken.score'
  ],45);

  const acceleration=clamp(
    ratioScore(volumeRatio,1,78)*0.38+
    ratioScore(Math.abs(buyDelta)*10+1,1,55)*0.12+
    pctScore(fastAcceleration,48)*0.22+
    pctScore(num(preMove?.price_acceleration_pct,null),42)*0.14+
    pctScore(num(preMove?.relative_strength_vs_market_pct,null),12)*0.14
  );

  const participation=clamp(
    participationBase*0.34+
    ratioScore(volumeRatio,1,85)*0.28+
    ratioScore(num(fast?.trade_ratio,null),1,50)*0.10+
    flow*0.16+
    orderbook*0.12
  );

  const pressure=clamp(
    flow*0.42+
    orderbook*0.20+
    component(bottom,['algorithms.whale_pressure.score'],50)*0.10+
    ratioScore(buyRatio,.5,260)*0.20+
    pctScore(buyDelta*100,2.2)*0.08
  );

  const structureScore=clamp(
    structure*0.48+
    mtf*0.18+
    component(bottom,['algorithms.ema20_50_reclaim.score'],50)*0.12+
    component(bottom,['algorithms.obv_accumulation.score'],50)*0.10+
    (Boolean(bottom?.metrics?.higher_low)||Boolean(bottom?.algorithms?.price_structure?.higher_low)?88:50)*0.06+
    (Boolean(bottom?.metrics?.bos_up)||Boolean(bottom?.algorithms?.price_structure?.break_of_structure)?92:50)*0.06
  );

  const resistancePressure=clamp(
    resistance*0.62+
    (breakoutDistance!=null ? clamp(100-Math.max(0,-breakoutDistance)*55) : 55)*0.18+
    component(bottom,['algorithms.price_structure.score'],50)*0.20
  );

  const relativeScore=clamp(
    relative*0.72+
    component(bottom,['metrics.mtf_alignment'],50)*0.18+
    pctScore(num(preMove?.relative_strength_vs_btc_pct,null),10)*0.10
  );

  const impulseQuality=clamp(
    component(fast,['score'],45)*0.34+
    component(fast,['scores.range_expansion'],45)*0.18+
    component(fast,['scores.body'],45)*0.16+
    component(fast,['scores.breakout'],45)*0.18+
    component(fast,['scores.taker_buy'],45)*0.14
  );

  const calmScore=
    Number.isFinite(priceChange24h)
      ? priceChange24h<=2?100
        : priceChange24h<=4?92
        : priceChange24h<=6?82
        : priceChange24h<=8?68
        : priceChange24h<=12?42
        : 12
      : 35;

  const antiChase=clamp(
    calmScore*0.62+
    (Number.isFinite(sessionReturn)?sessionReturn<=cfg.maxSessionReturnPct?88:sessionReturn<=10?55:18:50)*0.22+
    (priceChange24h<=cfg.max24hMovePct?90:priceChange24h<=cfg.hardLate24hMovePct?45:8)*0.16
  );

  const breakoutReadiness=clamp(
    compression*0.20+
    acceleration*0.20+
    participation*0.14+
    pressure*0.12+
    structureScore*0.14+
    resistancePressure*0.08+
    relativeScore*0.07+
    mtf*0.05
  );

  const leadGroups=[
    ['COMPRESSION',compression>=68],
    ['ACCELERATION',acceleration>=66],
    ['PARTICIPATION',participation>=66],
    ['FLOW',pressure>=66],
    ['STRUCTURE',structureScore>=66],
    ['RELATIVE_STRENGTH',relativeScore>=62],
    ['RESISTANCE_PRESSURE',resistancePressure>=62]
  ];
  const groupHits=leadGroups.filter(([,ok])=>ok).map(([id])=>id);

  const independentConfirmations=[
    compression>=68,
    acceleration>=66,
    participation>=66,
    pressure>=66,
    structureScore>=66,
    relativeScore>=62,
    resistancePressure>=62,
    mtf>=64,
    Number.isFinite(volumeRatio)&&volumeRatio>=1.18,
    Number.isFinite(buyRatio)&&buyRatio>=0.515
  ];
  const confirmationCount=independentConfirmations.filter(Boolean).length;

  const strategyScores=(Array.isArray(strategies)?strategies:[])
    .map(x=>Number(x?.score?.value))
    .filter(Number.isFinite);
  const strategyBest=strategyScores.length?Math.max(...strategyScores):0;
  const acceptedCount=(Array.isArray(strategies)?strategies:[]).filter(x=>x?.accepted).length;

  const late=priceChange24h>cfg.hardLate24hMovePct||
    (Number.isFinite(sessionReturn)&&sessionReturn>12)||
    Boolean(preMove?.already_moved);

  const microMove=
    Math.abs(num(preMove?.late_window_return_pct ?? fast?.roc_15m,0))<cfg.microMovePct&&
    (!Number.isFinite(fastAcceleration)||fastAcceleration<=cfg.microMoveAccelerationPct)&&
    impulseQuality<72;

  const targetReady =
    dataScore>=cfg.minDataQuality &&
    liquidityScore>=cfg.minLiquidityQuality &&
    !late &&
    !microMove &&
    breakoutReadiness>=cfg.minScore &&
    confirmationCount>=cfg.minConfirmations &&
    groupHits.length>=cfg.minLeadGroups &&
    antiChase>=65;

  const confirmed =
    targetReady &&
    breakoutReadiness>=cfg.minConfirmedScore &&
    confirmationCount>=cfg.minConfirmedConfirmations &&
    acceptedCount>=2 &&
    strategyBest>=72 &&
    (acceleration>=72||impulseQuality>=78) &&
    (pressure>=68||participation>=72);

  const stage=
    late?'LATE_CHASE':
    microMove?'MICRO_NOISE':
    confirmed?'CONFIRMED_PRE_BREAKOUT':
    targetReady?'PRE_BREAKOUT_READY':
    breakoutReadiness>=68?'EARLY_BUILD':
    'NO_SETUP';

  const score=Number(breakoutReadiness.toFixed(1));

  return {
    version:'V1_PRE_BREAKOUT_FINGERPRINT',
    timestamp:now,
    radar,
    score,
    stage,
    ready:targetReady,
    confirmed,
    late,
    micro_move:microMove,
    anti_chase_score:Number(antiChase.toFixed(1)),
    acceleration_score:Number(acceleration.toFixed(1)),
    participation_score:Number(participation.toFixed(1)),
    pressure_score:Number(pressure.toFixed(1)),
    structure_score:Number(structureScore.toFixed(1)),
    resistance_pressure_score:Number(resistancePressure.toFixed(1)),
    relative_strength_score:Number(relativeScore.toFixed(1)),
    impulse_quality_score:Number(impulseQuality.toFixed(1)),
    compression_score:Number(compression.toFixed(1)),
    confirmation_count:confirmationCount,
    confirmation_total:independentConfirmations.length,
    group_hits:groupHits,
    group_count:groupHits.length,
    strategy_best_score:Number(strategyBest.toFixed(1)),
    accepted_strategy_count:acceptedCount,
    price_change_24h_pct:priceChange24h,
    session_return_pct:sessionReturn,
    volume_ratio:Number.isFinite(volumeRatio)?Number(volumeRatio.toFixed(3)):null,
    taker_buy_ratio:Number.isFinite(buyRatio)?Number(buyRatio.toFixed(4)):null,
    taker_buy_delta:Number.isFinite(buyDelta)?Number(buyDelta.toFixed(4)):null,
    breakout_distance_pct:Number.isFinite(breakoutDistance)?Number(breakoutDistance.toFixed(3)):null,
    lead_edge:Number(Math.max(0,Math.min(100,
      (100-Math.abs(priceChange24h))*0.22+
      acceleration*0.26+
      compression*0.14+
      pressure*0.14+
      structureScore*0.12+
      relativeScore*0.06+
      antiChase*0.06
    )).toFixed(1)),
    reasons:[
      compression>=68?'COMPRESSION_BUILDING':null,
      acceleration>=66?'ACCELERATION_DETECTED':null,
      participation>=66?'PARTICIPATION_CONFIRMED':null,
      pressure>=66?'BUYING_PRESSURE_CONFIRMED':null,
      structureScore>=66?'STRUCTURE_IMPROVING':null,
      resistancePressure>=62?'RESISTANCE_PRESSURE':null,
      relativeScore>=62?'RELATIVE_STRENGTH':null,
      impulseQuality>=75?'IGNITION_QUALITY':null,
      late?'LATE_CHASE_REJECT':null,
      microMove?'MICRO_MOVE_REJECT':null
    ].filter(Boolean)
  };
}

export function isPreBreakoutNotificationEligible(fingerprint,{requireConfirmed=true}={}){
  if(!fingerprint?.ready)return false;
  if(fingerprint.late||fingerprint.micro_move)return false;
  return requireConfirmed?fingerprint.confirmed===true:true;
}

export function buildRadarOutcomeTargets({price,now=Date.now()}={}){
  const p=Number(price);
  return {
    reference_price:Number.isFinite(p)?p:null,
    observed_at:now,
    horizons:[5*60*1000,15*60*1000,30*60*1000,60*60*1000,4*60*60*1000].map(ms=>({
      horizon_ms:ms,
      horizon_minutes:Math.round(ms/60000),
      up_3_pct:3,
      up_5_pct:5,
      up_10_pct:10,
      up_20_pct:20
    })),
    learning_mode:'PAPER_OUTCOME_EVALUATION_ONLY'
  };
}
