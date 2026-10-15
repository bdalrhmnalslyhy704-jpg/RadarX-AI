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
  DOOMSDAY_RADAR:{minScore:82,minData:88,minConfirmations:6,minCategoryHits:5,minLiquidity:78,globalCooldownMs:15*60*1000,priority:5},
  PROFESSOR_RADAR:{minScore:82,minData:85,minConfirmations:0,minCategoryHits:0,minLiquidity:0,globalCooldownMs:30*60*1000,priority:3},
  ALMUQAWIM_RADAR:{minScore:86,minData:85,minConfirmations:0,minCategoryHits:0,minLiquidity:0,globalCooldownMs:20*60*1000,priority:4},
  EARLY_EXPANSION_RADAR:{minScore:82,minData:70,minConfirmations:0,minCategoryHits:0,minLiquidity:60,globalCooldownMs:10*60*1000,priority:4},
  COIN_HUNTER_RADAR:{minScore:86,minData:80,minConfirmations:0,minCategoryHits:0,minLiquidity:65,globalCooldownMs:12*60*1000,priority:4},
  WHALE_ACCUMULATION_RADAR:{minScore:88,minData:80,minConfirmations:7,minCategoryHits:5,minLiquidity:70,globalCooldownMs:14*60*1000,priority:5},
  FALCON_EYE_RADAR:{minScore:78,minData:82,minConfirmations:8,minCategoryHits:5,minLiquidity:65,globalCooldownMs:12*60*1000,priority:5}
});

const recentBySymbol=new Map();
const preBreakoutStreakBySymbol=new Map();

function radarId(alert){return String(alert?.radar||'').toUpperCase();}
const UNKNOWN_PROFILE=Object.freeze({minScore:90,minData:90,minConfirmations:8,minCategoryHits:6,minLiquidity:75,globalCooldownMs:20*60*1000,priority:1});
function profileFor(alert){return PROFILES[radarId(alert)]||UNKNOWN_PROFILE;}

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
    alert?.kahir_analysis?.confirmation_count ??
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
  // Falcon Eye keeps its scores nested to preserve the alert schema. Reading only
  // alert.components yielded zero category hits and blocked valid Falcon pushes.
  if(r==='FALCON_EYE_RADAR'){
    const scores=alert?.falcon_eye?.component_scores||{};
    return ['quietness','compression','momentum','volume','trades','taker','structure',
      'resistance','relative_strength','derivatives','breakout','atr','range']
      .filter(key=>num(scores[key],0)>=70).length;
  }
  if(r==='KAHIR_RADAR'){
    const a=alert?.kahir_analysis||alert?.analysis||{};
    return Object.values(a.algorithms||{}).filter(x=>x&&typeof x==='object'&&Number(x.score)>=68).length;
  }
  if(r==='ALMUQAWIM_RADAR'){
    const c=alert?.almuqawim?.components||alert?.components||{};
    return ['market_structure','higher_timeframe_alignment','lower_timeframe_agreement','trendline','moving_average','entry_timing','entry_freshness']
      .filter(key=>c[key]!==null&&c[key]!==undefined&&c[key]!==''&&Number.isFinite(Number(c[key]))&&Number(c[key])>=70).length;
  }
  if(r==='ROTATION_LAG_RADAR'){
    const c=alert?.rotation?.component_scores||{};
    const scores=Object.values(c).filter(x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x))).map(Number);
    return scores.filter(x=>x>=70).length;
  }
  if(r==='DOOMSDAY_RADAR'){
    const c=alert?.doomsday?.component_scores||{};
    const scores=Object.values(c).filter(x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x))).map(Number);
    return scores.filter(x=>x>=70).length;
  }
  if(r==='WHALE_ACCUMULATION_RADAR'){
    const a=alert?.whale_accumulation||{};
    const p=a.large_prints||{},f=a.candle_flow||{},d=a.orderbook||{};
    const values=[p.score,p.repeatBuyScore,p.burstScore,f.absorptionScore,f.higherLowScore,a.support_score,a.stability_score,a.orderbook_persistence?.score,
      d.nearImbalance==null?null:50+Number(d.nearImbalance)*170,
      d.midImbalance==null?null:50+Number(d.midImbalance)*140];
    return values.filter(x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x))&&Number(x)>=70).length;
  }
  if(r==='LIQUIDITY_ABSORPTION_RADAR'||r==='ROTATION_LAG_RADAR'||r==='DOOMSDAY_RADAR'){
    const nested=r==='LIQUIDITY_ABSORPTION_RADAR'?(alert?.liquidity_absorption||{}):r==='ROTATION_LAG_RADAR'?(alert?.rotation||{}):(alert?.doomsday||{});
    const values=[];
    const visit=node=>{if(!node||typeof node!=='object')return;for(const [name,value] of Object.entries(node)){
      if(value&&typeof value==='object')visit(value);
      else if(/score|strength|potential/i.test(name)&&!/min|max|threshold|count|total/i.test(name)&&value!==null&&value!==''&&Number.isFinite(Number(value)))values.push(Number(value));
    }};
    visit(nested);
    return values.filter(x=>x>=70).length;
  }
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

function fingerprintOf(alert){
  return alert?.pre_breakout_fingerprint ?? alert?.pre_expansion_fingerprint ??
    alert?.early_expansion?.pre_expansion_fingerprint ?? alert?.falcon_eye?.pre_expansion_fingerprint ??
    alert?.falcon_eye?.pre_breakout_fingerprint ?? null;
}

function updatePreBreakoutStreak(alert,now){
  const symbol=String(alert?.symbol||'').toUpperCase();
  const fp=fingerprintOf(alert);
  if(!symbol||!fp)return null;
  const valid=Boolean(fp.ready)&&!Boolean(fp.late)&&!Boolean(fp.micro_move)&&Number(fp.score)>=72;
  const key=radarId(alert)+'|'+symbol;
  const prev=preBreakoutStreakBySymbol.get(key);
  const within=prev&&Number(now)-Number(prev.lastAt)<=8*60*1000;
  const streak=valid?(within?Number(prev.streak||0)+1:1):0;
  const next={streak,lastAt:Number(now)||Date.now(),score:Number(fp.score)||0,radar:radarId(alert)};
  preBreakoutStreakBySymbol.set(key,next);
  return next;
}

function radarSpecificChecks(alert,p,now){
  const r=radarId(alert);
  const fingerprint=fingerprintOf(alert);
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
    const streak=updatePreBreakoutStreak(alert,now);
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
    const lag=num(a.component_scores?.lag??a.metrics?.lag_score??a.metrics?.lag,null);
    const resilience=num(a.component_scores?.resilience??a.metrics?.resilience_score??a.metrics?.resilience,null);
    if((lag===null||lag<58)&&(resilience===null||resilience<65))failures.push('RELATIVE_STRENGTH_NOT_CONFIRMED');
    if(num(a.activation_score,0)<72)failures.push('ROTATION_ACTIVATION_WEAK');
  }

  if(r==='LIQUIDITY_ABSORPTION_RADAR'){
    const a=alert?.liquidity_absorption||{};
    const c=a.component_scores||a.algorithms||{};
    const m=a.metrics||{};
    const absorption=Math.max(num(c.absorption,0),num(c.absorption_score,0),num(c.SELLER_ABSORPTION?.score,0),num(m.absorption_score,0));
    const depth=Math.max(num(c.depth,0),num(c.depth_imbalance,0),num(c.DEPTH_IMBALANCE_VACUUM?.score,0),num(m.depth_score,0));
    const follow=num(c.FIVE_MINUTE_CONFIRMATION?.score??c.five_minute_confirmation??m.five_minute_confirmation,0);
    if(absorption<76)failures.push('ABSORPTION_NOT_STRONG_ENOUGH');
    if(depth<68)failures.push('ORDERBOOK_CONFIRMATION_WEAK');
    if(follow<65)failures.push('FIVE_MINUTE_CONFIRMATION_WEAK');
  }

  if(r==='KAHIR_RADAR'){
    const a=alert?.kahir_analysis||alert?.analysis||{};
    const m=a.metrics||{};
    const z=Math.max(num(m.one_minute_z,0),num(m.five_minute_z,0));
    const participation=num(a.algorithms?.PARTICIPATION_REGIME?.score,0);
    if(z<1.6)failures.push('SELF_BASELINE_ACCELERATION_WEAK');
    if(participation<68)failures.push('PARTICIPATION_REGIME_NOT_CONFIRMED');
  }

  if(r==='FALCON_EYE_RADAR'){
    const a=alert?.falcon_eye||{};
    const m=a.metrics||{};
    const cs=a.component_scores||{};
    const d=a.derivatives||{};
    if(Boolean(a.not_chasing)===false)failures.push('FALCON_ANTI_CHASE_FAIL');
    if(Number(a.confirmation_count||0)<8)failures.push('FALCON_CONFIRMATION_BREADTH_LOW');
    if(a.market_pulse && Number(a.market_pulse.score||0)<54)failures.push('FALCON_MARKET_PULSE_WEAK');
    if(Number(cs.quietness||0)<65)failures.push('FALCON_QUIET_BASE_WEAK');
    if(Number(cs.compression||0)<58)failures.push('FALCON_COMPRESSION_WEAK');
    if(Number(cs.structure||0)<65)failures.push('FALCON_STRUCTURE_WEAK');
    if(Number(cs.taker||0)<58)failures.push('FALCON_TAKER_FLOW_WEAK');
    if(Number(cs.relative_strength||0)<55)failures.push('FALCON_RELATIVE_STRENGTH_WEAK');
    if(Number(m.move_24h)>8)failures.push('FALCON_ALREADY_MOVED');
    if(Number(m.return_10m)>3.8)failures.push('FALCON_10M_CHASE');
    if(Number(m.return_5m)>2.5)failures.push('FALCON_5M_CHASE');
    if(Number(m.ema21_distance_pct)>4.2)failures.push('FALCON_EMA_EXTENSION');
    if(Number(m.resistance_gap_pct)<-1.2)failures.push('FALCON_BREAKOUT_EXTENSION');
    if(Boolean(d.futures_available) && Number(d.funding_rate)>0.004)failures.push('FALCON_POSITIVE_FUNDING_CROWDING');
  }

  if(r==='ALMUQAWIM_RADAR'){
    const a=alert?.almuqawim||{};
    const c=a.components||{};
    if(a.eligible!==true)failures.push('ALMUQAWIM_ANALYSIS_NOT_ELIGIBLE');
    if(!String(a.direction??alert?.direction??'').toUpperCase().startsWith('UP'))failures.push('ALMUQAWIM_UP_TREND_NOT_CONFIRMED');
    if(num(c.higher_timeframe_alignment,0)<100)failures.push('ALMUQAWIM_HIGHER_TIMEFRAME_ALIGNMENT_WEAK');
    if(num(c.market_structure,0)<90)failures.push('ALMUQAWIM_MARKET_STRUCTURE_WEAK');
    if(num(c.lower_timeframe_agreement,0)<90)failures.push('ALMUQAWIM_LOWER_TIMEFRAME_DISAGREEMENT');
    if(num(c.entry_timing,0)<78||num(c.entry_freshness,0)<72)failures.push('ALMUQAWIM_ENTRY_TIMING_STALE');
    const daily=num(alert?.price_change_24h,null);
    if(daily===null||Math.abs(daily)>8)failures.push('ALMUQAWIM_24H_EXTENSION_OR_UNKNOWN');
  }

  if(r==='EARLY_EXPANSION_RADAR'){
    const a=alert?.early_expansion||alert;
    const m=a?.metrics||alert?.metrics||alert?.price_change_windows||{};
    const stage=String(a?.pre_expansion_stage??alert?.pre_expansion_stage??a?.decision_band??alert?.potential_label??'').toUpperCase();
    const fp=fingerprintOf(alert);
    if(!fp&&!stage)failures.push('EARLY_EXPANSION_FINGERPRINT_MISSING');
    if(stage==='ALREADY_EXTENDED'||stage==='DATA_INSUFFICIENT')failures.push('EARLY_EXPANSION_STAGE_NOT_NOTIFIABLE');
    if(a?.data_stale===true||alert?.data_status?.stale===true||a?.gates?.data_gate?.valid===false)failures.push('EARLY_EXPANSION_DATA_GATE_FAILED');
    const qualityRaw=alert?.data_quality;
    if(qualityRaw===null||qualityRaw===undefined||qualityRaw===''||!Number.isFinite(Number(qualityRaw))||Number(qualityRaw)<70)failures.push('EARLY_EXPANSION_DATA_QUALITY_UNKNOWN_OR_LOW');
    if(a?.gates?.liquidity_gate?.allowed===false&&alert?.historical_replay!==true)failures.push('EARLY_EXPANSION_LIQUIDITY_GATE_FAILED');
    const liquidityRaw=alert?.liquidity_quality??alert?.liquidity_metrics?.liquidity_quality;
    const historicalSource=Boolean(alert?.historical_replay)||/historical|replay/i.test(String(alert?.source??''));
    if(!historicalSource&&(liquidityRaw===null||liquidityRaw===undefined||liquidityRaw===''||!Number.isFinite(Number(liquidityRaw))||Number(liquidityRaw)<60))failures.push('EARLY_EXPANSION_LIQUIDITY_QUALITY_UNKNOWN_OR_LOW');
    const rvol=num(m.rvol_5m??m.rvol_1m??m.volume_ratio,null);
    const trades=num(m.trade_ratio,null);
    const taker=num(m.taker_buy_ratio,null);
    if(rvol===null||rvol<1.10)failures.push('EARLY_EXPANSION_VOLUME_PARTICIPATION_WEAK');
    if(trades===null||trades<1.02)failures.push('EARLY_EXPANSION_TRADE_PARTICIPATION_WEAK');
    if(taker===null||taker<0.50)failures.push('EARLY_EXPANSION_BUY_FLOW_UNCONFIRMED');
    const daily=num(alert?.price_change_24h??m.price_change_24h_pct,null);
    if(daily===null||Math.abs(daily)>12)failures.push('EARLY_EXPANSION_24H_EXTENSION_OR_UNKNOWN');
    const five=num(m.price_change_5m_pct,null);
    if(five!==null&&five>3)failures.push('EARLY_EXPANSION_5M_CHASE_GUARD');
  }

  if(r==='COIN_HUNTER_RADAR'){
    const m=alert?.factors||alert?.coin_hunter||{};
    const early=num(m.early_setup_score??m.early_timing_fingerprint?.earlySetupScore,null);
    const vol=num(m.micro_volume_acceleration??m.volume_acceleration,null);
    const trades=num(m.micro_trade_acceleration??m.trade_acceleration,null);
    const taker=num(m.micro_taker_buy_ratio??m.taker_buy_ratio,null);
    const room=num(m.micro_resistance_distance_pct??m.resistance_distance_pct,null);
    if(early===null||early<68)failures.push('COIN_HUNTER_EARLY_FINGERPRINT_WEAK');
    if(vol===null||trades===null||taker===null)failures.push('COIN_HUNTER_MICRO_PARTICIPATION_MISSING');
    if(vol!==null&&vol<1.05)failures.push('COIN_HUNTER_VOLUME_ACCELERATION_WEAK');
    if(trades!==null&&trades<1.02)failures.push('COIN_HUNTER_TRADE_ACCELERATION_WEAK');
    if(taker!==null&&taker<0.505)failures.push('COIN_HUNTER_BUY_FLOW_WEAK');
    if(room===null||room<0.35)failures.push('COIN_HUNTER_RESISTANCE_ROOM_INSUFFICIENT');
    const daily=num(m.today_pct??alert?.price_change_24h,null);
    const hour=num(m.one_hour_pct,null),four=num(m.four_hour_pct,null);
    if(daily===null||daily>8||hour===null||hour>2.5||four===null||four>5)failures.push('COIN_HUNTER_ANTI_CHASE_OR_UNKNOWN');
  }

  if(r==='WHALE_ACCUMULATION_RADAR'){
    const a=alert?.whale_accumulation||{};
    const p=a.large_prints||{},f=a.candle_flow||{},d=a.orderbook||{};
    if(p.available!==true)failures.push('WHALE_LARGE_PRINT_DATA_UNAVAILABLE');
    if(num(p.largeCount,0)<4)failures.push('WHALE_LARGE_PRINT_COUNT_LOW');
    if(p.largeBuyRatio===null||p.largeBuyRatio===undefined||num(p.largeBuyRatio,0)<0.60)failures.push('WHALE_BUY_SIDE_NOT_CONFIRMED');
    if(p.largeNotionalRatio===null||p.largeNotionalRatio===undefined||num(p.largeNotionalRatio,0)<0.12)failures.push('WHALE_LARGE_NOTIONAL_IMBALANCE_WEAK');
    if(f.available!==true||num(f.absorptionScore,0)<67)failures.push('WHALE_CANDLE_ABSORPTION_WEAK');
    if(d.spreadBps!==null&&d.spreadBps!==undefined&&num(d.spreadBps,Infinity)>15)failures.push('WHALE_SPREAD_TOO_WIDE');
    if(a.price_context?.not_extended!==true)failures.push('WHALE_ANTI_CHASE_NOT_CONFIRMED');
  }

  if(r==='DOOMSDAY_RADAR'){
    const a=alert?.doomsday||{};
    const stage=String(a.stage??alert?.potential_label??'').toUpperCase();
    const ignitionConfirmations=num(a.ignition_confirmations,0);
    const earlyConfirmations=num(a.confirmation_count,0);
    const earlyScore=num(a.early_score,0);
    const ignitionScore=num(alert?.ignition_score??a.ignition_score,0);
    if(stage==='PRE_BREAKOUT'){
      if(earlyConfirmations<6)failures.push('DOOMSDAY_EARLY_CONFIRMATION_BREADTH_LOW');
      if(earlyScore<80)failures.push('DOOMSDAY_EARLY_SCORE_NOT_CONFIRMED');
    }else{
      if(ignitionConfirmations<5)failures.push('DOOMSDAY_IGNITION_CONFIRMATION_BREADTH_LOW');
      if(ignitionScore<86)failures.push('IGNITION_SCORE_NOT_CONFIRMED');
    }
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
  const failures=[...(!PROFILES[r] ? ['RADAR_PROFILE_MISSING'] : []),...radarSpecificChecks(alert,p,now),...risks.map(x=>'RISK:'+x)];

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

  const trajectoryPersistence=Number.isFinite(Number(trajectory.persistence))?Number(trajectory.persistence):0;
  const trajectoryConvergence=Number.isFinite(Number(trajectory.convergence))?Number(trajectory.convergence):0;
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
    (Number(trajectoryBonus(trajectory))>=5 || trajectoryPersistence<3 || trajectoryConvergence>=62);

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
    profile_thresholds:{min_score:p.minScore,min_data_quality:p.minData,min_confirmations:p.minConfirmations,min_category_hits:p.minCategoryHits,min_liquidity_quality:p.minLiquidity,global_cooldown_ms:p.globalCooldownMs},
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
  return {tracked_symbols:recentBySymbol.size,mode:'FALCON_EYE_V1_STRICT_PLUS_EARLY_TRACK',cross_radar_suppression:true,no_extra_network_calls:true,registered_profile_count:Object.keys(PROFILES).length,registered_profiles:Object.keys(PROFILES)};
}
