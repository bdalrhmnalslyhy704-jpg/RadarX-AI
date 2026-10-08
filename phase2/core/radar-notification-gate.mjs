import {isPreBreakoutNotificationEligible} from './radar-prebreakout-engine.mjs';
import {evaluateFalconEye} from './radar-falcon-core.mjs';
import {buildMoveForensics} from './move-forensics.mjs';
import {trajectoryBonus,trajectoryPenalty} from './evidence-trajectory.mjs';
const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number.isFinite(Number(v))?Number(v):0));
const num=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const arr=v=>Array.isArray(v)?v:[];

const PROFILES=Object.freeze({
  EARLY_MOVE_RADAR:{minScore:84,minData:85,minConfirmations:7,minCategoryHits:5,minAcceptedStrategies:2,minLiquidity:75,globalCooldownMs:12*60*1000,priority:3},
  STRONG_MOVE_RADAR:{minScore:88,minData:85,minConfirmations:5,minCategoryHits:5,minLiquidity:75,globalCooldownMs:15*60*1000,priority:4},
  ROTATION_LAG_RADAR:{minScore:89,minData:85,minConfirmations:7,minCategoryHits:5,minLiquidity:75,globalCooldownMs:18*60*1000,priority:3},
  LIQUIDITY_ABSORPTION_RADAR:{minScore:91,minData:88,minConfirmations:8,minCategoryHits:5,minLiquidity:78,globalCooldownMs:18*60*1000,priority:3},
  KAHIR_RADAR:{minScore:91,minData:88,minConfirmations:8,minCategoryHits:5,minLiquidity:78,globalCooldownMs:18*60*1000,priority:4},
  DOOMSDAY_RADAR:{minScore:92,minData:88,minConfirmations:8,minCategoryHits:5,minLiquidity:78,globalCooldownMs:15*60*1000,priority:5},
  PROFESSOR_RADAR:{minScore:82,minData:85,minConfirmations:0,minCategoryHits:0,minLiquidity:0,globalCooldownMs:30*60*1000,priority:3},
  EARLY_EXPANSION_RADAR:{minScore:82,minData:70,minConfirmations:0,minCategoryHits:0,minLiquidity:60,globalCooldownMs:10*60*1000,priority:4},
  COIN_HUNTER_RADAR:{minScore:86,minData:80,minConfirmations:0,minCategoryHits:0,minLiquidity:65,globalCooldownMs:12*60*1000,priority:4},
  WHALE_ACCUMULATION_RADAR:{minScore:88,minData:80,minConfirmations:7,minCategoryHits:5,minLiquidity:70,globalCooldownMs:14*60*1000,priority:5}
});

const recentBySymbol=new Map();
const preBreakoutStreakBySymbol=new Map();

function radarId(alert){return String(alert?.radar||'').toUpperCase();}
function profileFor(alert){return PROFILES[radarId(alert)]||PROFILES.PROFESSOR_RADAR;}

function dataQualityOf(alert){
  return clamp(alert?.data_quality ?? alert?.data_status?.data_quality ??
    alert?.components?.data_quality ?? alert?.components?.dataQuality ?? alert?.deep_scan?.assessment?.data_quality ?? 100);
}

function liquidityOf(alert){
  return clamp(alert?.liquidity_quality ?? alert?.components?.liquidity ??
    alert?.deep_scan?.assessment?.liquidity_score ?? 100);
}

function confirmationsOf(alert){
  const r=radarId(alert);
  return num(
    alert?.elite_gate?.confirmations ??
    alert?.strong_move?.metrics?.flash_confirmations ??
    alert?.rotation?.confirmations ??
    alert?.liquidity_absorption?.confirmation_count ??
    alert?.confirmation_count ??
    alert?.doomsday?.confirmation_count ??
    alert?.doomsday?.ignition_confirmations ??
    alert?.pre_explosion?.confirmation_count ??
    alert?.early_wake?.leader_count ??
    null,0
  );
}

function categoryHitsOf(alert){
  const gate=alert?.elite_gate;
  if(Number.isFinite(Number(gate?.category_hits)))return Number(gate.category_hits);
  const r=radarId(alert);
  const c=alert?.components||{};
  const checks=r==='EARLY_MOVE_RADAR'
    ? [c.momentum,c.volume,c.buying_pressure,c.orderbook_pressure,c.structure,c.squeeze,c.relative_strength,c.mtf_alignment,c.ema_reclaim,c.rsi_score,c.obv_accumulation,c.wyckoff_spring].filter(v=>num(v,0)>=65)
    : [c.momentum,c.volume,c.trades,c.taker,c.range,c.breakout,c.ema,c.vwap,c.bollinger,c.efficiency,c.atr].filter(v=>num(v,0)>=70);
  return checks.length;
}

function scoreOf(alert){
  return num(alert?.elite_gate?.score ??
    alert?.radar_power_score ??
    alert?.opportunity_score ??
    alert?.strong_move?.score ??
    alert?.rotation?.score ??
    alert?.setup_score ?? 0,0);
}

function acceptedStrategiesOf(alert){
  return num(alert?.strategy_confluence?.accepted_count,0);
}

function criticalRisk(alert){
  const quality=alert?.radar_quality_v3||null;
  const qualityRisks=quality?.hard_fail?['RADAR_QUALITY_HARD_FAIL']:(Number(quality?.historical_followthrough_samples)>=5&&Number(quality?.historical_followthrough_score)<42?['HISTORICAL_FOLLOWTHROUGH_WEAK']:[]);
  const risks=[...arr(alert?.risk_flags),...qualityRisks].map(x=>String(x).toUpperCase());
  const gateRisks=arr(alert?.elite_gate?.risk_flags).map(x=>String(x).toUpperCase());
  const all=[...risks,...gateRisks];
  return all.filter(x=>/ALREADY_MOVED|ALREADY_EXTENDED|EXTENDED_CHASE|DATA_QUALITY|NO_PRIMARY_TRIGGER|LOW_CONFLUENCE|DISJOINTED|FLOW_WITHOUT|VOLUME_WITHOUT|LIQUIDITY_TOO_WEAK|RESISTANCE_TOO_NEAR|CHAS(E|ING)/.test(x));
}

function updatePreBreakoutStreak(alert,now){
  const symbol=String(alert?.symbol||'').toUpperCase();
  const fp=alert?.pre_breakout_fingerprint;
  if(!symbol||!fp)return null;
  const valid=Boolean(fp.ready)&&!Boolean(fp.late)&&!Boolean(fp.micro_move)&&Number(fp.score)>=72;
  const prev=preBreakoutStreakBySymbol.get(symbol);
  const within=prev&&Number(now)-Number(prev.lastAt)<=8*60*1000;
  const streak=valid?(within?Number(prev.streak||0)+1:1):0;
  const next={streak,lastAt:Number(now)||Date.now(),score:Number(fp.score)||0};
  preBreakoutStreakBySymbol.set(symbol,next);
  return next;
}

function radarSpecificChecks(alert,p){
  const r=radarId(alert);
  const fingerprint=alert?.pre_breakout_fingerprint||null;
  const failures=[];
  const confirmations=confirmationsOf(alert);
  const score=scoreOf(alert);
  const categories=categoryHitsOf(alert);
  const data=dataQualityOf(alert);
  const liq=liquidityOf(alert);

  if(score<p.minScore)failures.push('SCORE_BELOW_STRICT_THRESHOLD');
  if(data<p.minData)failures.push('DATA_QUALITY_BELOW_STRICT_THRESHOLD');
  if(p.minLiquidity&&liq<p.minLiquidity)failures.push('LIQUIDITY_BELOW_STRICT_THRESHOLD');
  if(fingerprint?.micro_move)failures.push('MICRO_MOVE_NOISE');
  if(fingerprint?.late&&r!=='STRONG_MOVE_RADAR')failures.push('LATE_SETUP_CHASE_GUARD');
  if(p.minConfirmations&&confirmations<p.minConfirmations)failures.push('CONFIRMATION_BREADTH_LOW');
  if(p.minCategoryHits&&categories<p.minCategoryHits)failures.push('CATEGORY_DIVERSITY_LOW');

  if(r==='EARLY_MOVE_RADAR'){
    const accepted=acceptedStrategiesOf(alert);
    const streak=updatePreBreakoutStreak(alert,Date.now());
    const pre=alert?.pre_explosion;
    const wake=alert?.early_wake;
    const hasPreConfirm=num(pre?.confirmation_count,0)>=8 && accepted>=p.minAcceptedStrategies;
    const hasWakeConfirm=num(wake?.leader_count,0)>=8 && num(alert?.opportunity_score,0)>=p.minScore;
    if(!hasPreConfirm&&!hasWakeConfirm)failures.push('EARLY_SETUP_NOT_ENOUGH_INDEPENDENT_CONFIRMATIONS');
    if(fingerprint&&!isPreBreakoutNotificationEligible(fingerprint,{requireConfirmed:true})&&!(Number(fingerprint.impulse_quality_score)>=84&&Number(fingerprint.score)>=90))failures.push('PRE_BREAKOUT_FINGERPRINT_NOT_CONFIRMED');
    if(fingerprint&&streak&&Number(streak.streak)<2&&!(Number(fingerprint.impulse_quality_score)>=84&&Number(fingerprint.score)>=90))failures.push('PRE_BREAKOUT_PERSISTENCE_LOW');
    if(Boolean(pre?.already_moved)||Boolean(wake?.already_moved))failures.push('EARLY_SETUP_ALREADY_MOVED');
    if(num(pre?.calm_enough,1)===0||num(wake?.calm_enough,1)===0)failures.push('EARLY_SETUP_NOT_CALM');
  }

  if(r==='STRONG_MOVE_RADAR'){
    const m=alert?.strong_move?.metrics||{};
    const hasImpulse=num(m.return_3m,0)>=0.60 || Boolean(m.micro_breakout);
    const hasParticipation=num(m.volume_ratio,0)>=1.6 || num(m.trade_ratio,0)>=1.35;
    const hasFlow=num(m.taker_buy_ratio,0)>=0.53 || num(m.taker_buy_delta,0)>=0.01;
    const has5m=num(m.five_min_trend,0)>=65 || num(m.five_min_return,0)>=0.30;
    if(!(hasImpulse&&hasParticipation&&hasFlow&&has5m))failures.push('STRONG_MOVE_FINGERPRINT_NOT_COMPLETE');
  }

  if(r==='ROTATION_LAG_RADAR'){
    const a=alert?.rotation||{};
    if(num(a.metrics?.lag,0)<58 && num(a.metrics?.resilience,0)<65)failures.push('RELATIVE_STRENGTH_NOT_CONFIRMED');
    if(num(a.activation_score,0)<72)failures.push('ROTATION_ACTIVATION_WEAK');
  }

  if(r==='LIQUIDITY_ABSORPTION_RADAR'){
    const a=alert?.liquidity_absorption||{};
    const c=a.component_scores||a.algorithms||{};
    const m=a.metrics||{};
    const absorption=Math.max(num(c.absorption,0),num(c.absorption_score,0));
    const depth=Math.max(num(c.depth,0),num(c.depth_imbalance,0),num(m.depth_score,0));
    const follow=num(c.five_minute_confirmation,0)||num(m.five_minute_confirmation,0);
    if(absorption<78)failures.push('ABSORPTION_NOT_STRONG_ENOUGH');
    if(depth<68)failures.push('ORDERBOOK_CONFIRMATION_WEAK');
    if(follow<65)failures.push('FIVE_MINUTE_CONFIRMATION_WEAK');
  }

  if(r==='KAHIR_RADAR'){
    const a=alert?.analysis||{};
    const m=a.metrics||{};
    const z=Math.max(num(m.one_minute_z,0),num(m.five_minute_z,0));
    const participation=num(a.algorithms?.PARTICIPATION_REGIME?.score,0);
    if(z<1.6)failures.push('SELF_BASELINE_ACCELERATION_WEAK');
    if(participation<68)failures.push('PARTICIPATION_REGIME_NOT_CONFIRMED');
  }

  if(r==='DOOMSDAY_RADAR'){
    const a=alert?.doomsday||{};
    const ignition=num(a.ignition_confirmations,0);
    const early=num(a.confirmation_count,0);
    const ignitionScore=num(alert?.ignition_score ?? a.ignition_score,0);
    if(Math.max(ignition,early)<8)failures.push('DOOMSDAY_CONFIRMATION_BREADTH_LOW');
    if(ignitionScore<82)failures.push('IGNITION_SCORE_NOT_CONFIRMED');
  }

  if(r!=='EARLY_MOVE_RADAR'&&r!=='PROFESSOR_RADAR'&&fingerprint&&!fingerprint.late&&!fingerprint.micro_move&&Number(fingerprint.score)>0&&Number(fingerprint.score)<68)failures.push('PRE_BREAKOUT_QUALITY_WEAK');

  if(r==='PROFESSOR_RADAR'){
    const opinion=alert?.professor_opinion||{};
    const evidence=Number(alert?.stream_mentions||0)>0?1:0;
    const news=Number(alert?.news_mentions||0)>0?1:0;
    if(num(opinion.technical_score,0)<72)failures.push('PROFESSOR_TECHNICAL_CONFIRMATION_WEAK');
    if(num(opinion.stream_score,0)<60&&num(opinion.news_score,0)<55)failures.push('PROFESSOR_EXTERNAL_EVIDENCE_WEAK');
    if(evidence+news+Number(opinion?.evidence_types||0)<4)failures.push('PROFESSOR_SOURCE_BREADTH_LOW');
  }
  return failures;
}

const EARLY_RADARS=new Set(['EARLY_MOVE_RADAR','EARLY_EXPANSION_RADAR','COIN_HUNTER_RADAR']);

export function evaluateRadarNotificationGate(alert,{now=Date.now(),commit=false}={}){
  const r=radarId(alert);
  const p=profileFor(alert);
  const score=scoreOf(alert);
  const data=dataQualityOf(alert);
  const liquidity=liquidityOf(alert);
  const confirmations=confirmationsOf(alert);
  const categoryHits=categoryHitsOf(alert);
  const risks=criticalRisk(alert);
  const falcon=evaluateFalconEye(alert,{now});
  const forensics=buildMoveForensics(alert,now);
  const trajectory=alert?.evidence_trajectory||{};
  const failures=[...radarSpecificChecks(alert,p),...risks.map(x=>'RISK:'+x)];

  if(falcon.hard_fail)failures.push('FALCON_HARD_FAIL');
  if(falcon.quality<60&&r!=='PROFESSOR_RADAR')failures.push('FALCON_QUALITY_TOO_LOW');
  if(falcon.independent_domains<3&&r!=='PROFESSOR_RADAR')failures.push('FALCON_EVIDENCE_TOO_NARROW');
  if(forensics.hard_fail)failures.push('MOVER_FORENSICS_HARD_FAIL');
  if(forensics.quality<58&&r!=='PROFESSOR_RADAR')failures.push('MOVER_FORENSICS_QUALITY_LOW');
  if(trajectory.regime==='DETERIORATING'&&r!=='PROFESSOR_RADAR')failures.push('EVIDENCE_TRAJECTORY_DETERIORATING');
  if(Number(trajectory.persistence)>=3&&Number(trajectory.convergence)<48&&r!=='PROFESSOR_RADAR')failures.push('EVIDENCE_TRAJECTORY_DISJOINTED');

  if(alert?.eligible===false)failures.push('BASE_ALERT_NOT_ELIGIBLE');
  if(alert?.elite_gate&&alert.elite_gate.eligible===false)failures.push('ELITE_GATE_NOT_ELIGIBLE');

  const symbol=String(alert?.symbol||'').toUpperCase();
  const previous=symbol?recentBySymbol.get(symbol):null;
  const elapsed=previous?Math.max(0,Number(now)-previous.at):Infinity;
  const stronger=previous && (score>=previous.score+8 || p.priority>previous.priority);
  const crossRadarBlocked=Boolean(previous)&&elapsed<p.globalCooldownMs&&!stronger;
  if(crossRadarBlocked)failures.push('CROSS_RADAR_COOLDOWN');

  const earlyHardFailures=failures.filter(x=>
    /^(RISK:)|DATA_QUALITY_BELOW|LIQUIDITY_BELOW|MICRO_MOVE_NOISE|LATE_SETUP_CHASE_GUARD|EARLY_SETUP_ALREADY_MOVED|EARLY_SETUP_NOT_CALM|FALCON_HARD_FAIL|MOVER_FORENSICS_HARD_FAIL|EVIDENCE_TRAJECTORY_DETERIORATING|BASE_ALERT_NOT_ELIGIBLE|ELITE_GATE_NOT_ELIGIBLE/.test(String(x))
  );
  const earlyCorridor=
    EARLY_RADARS.has(r) &&
    earlyHardFailures.length===0 &&
    !falcon.hard_fail &&
    falcon.early_window &&
    falcon.capture>=78 &&
    falcon.quality>=72 &&
    falcon.independent_domains>=4 &&
    score>=Math.max(72,p.minScore-6) &&
    data>=p.minData &&
    (!p.minLiquidity||liquidity>=p.minLiquidity) &&
    (Number(trajectoryBonus(trajectory))>=5 || Number(trajectory.persistence)<3 || Number(trajectory.convergence)>=62);

  const persistentEarlyCorridor=
    EARLY_RADARS.has(r) &&
    failures.length===0 &&
    trajectory.regime==='IGNITING' &&
    Number(trajectory.persistence)>=3 &&
    Number(trajectory.convergence)>=72 &&
    falcon.capture>=80 &&
    forensics.score>=74 &&
    score>=70 &&
    data>=p.minData &&
    (!p.minLiquidity||liquidity>=p.minLiquidity);

  const strictEligible=
    failures.length===0 &&
    score>=p.minScore &&
    data>=p.minData &&
    (!p.minLiquidity||liquidity>=p.minLiquidity) &&
    falcon.quality>=68 &&
    falcon.capture>=66 &&
    falcon.independent_domains>=4;

  const eligible=Boolean(strictEligible||earlyCorridor||persistentEarlyCorridor);
  const mode=persistentEarlyCorridor?'PERSISTENT_EARLY_TRACK':earlyCorridor&&!strictEligible?'FALCON_EARLY_TRACK':'STRICT_NOTIFICATION';
  const result={
    eligible,
    radar:r,
    score:Number(score.toFixed(1)),
    data_quality:Number(data.toFixed(1)),
    liquidity_quality:Number(liquidity.toFixed(1)),
    confirmations,
    category_hits:categoryHits,
    falcon_eye:falcon,
    move_forensics:forensics,
    evidence_trajectory:trajectory,
    previous_alert:previous?{radar:previous.radar,at:previous.at,score:previous.score}:null,
    cooldown_remaining_ms:crossRadarBlocked?Math.max(0,p.globalCooldownMs-elapsed):0,
    failures:[...new Set(failures)],
    mode,
    no_extra_network_calls:true
  };
  if(eligible&&commit&&symbol)rememberRadarAlert(alert,now);
  return result;
}

export function rememberRadarAlert(alert,now=Date.now()){
  const symbol=String(alert?.symbol||'').toUpperCase();
  if(!symbol)return;
  const p=profileFor(alert);
  recentBySymbol.set(symbol,{radar:radarId(alert),at:Number(now)||Date.now(),score:scoreOf(alert),priority:p.priority});
  if(recentBySymbol.size>4000){
    const cutoff=(Number(now)||Date.now())-2*60*60*1000;
    for(const [k,v] of recentBySymbol)if(v.at<cutoff)recentBySymbol.delete(k);
  }
}

export function resetRadarNotificationGateForTests(){recentBySymbol.clear();preBreakoutStreakBySymbol.clear();}

export function notificationGateHealth(){
  return {tracked_symbols:recentBySymbol.size,mode:'FALCON_EYE_V1_STRICT_PLUS_EARLY_TRACK',cross_radar_suppression:true,no_extra_network_calls:true};
}
