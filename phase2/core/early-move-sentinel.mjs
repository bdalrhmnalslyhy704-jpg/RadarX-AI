import {MarketUniverseScanner,buildSpotUniverse,normalizeTickerRow} from '../market/universe-scanner.mjs';
import {finiteNumberOr} from './finite-number.mjs';
import {BinanceAllMarketTickerClient} from '../market/binance-market-ticker-ws.mjs';
import {decorateRadarAlert} from './radar-alert-meta.mjs';
import {evaluateEliteGate} from './elite-confluence-gate.mjs';

const clamp=(n,min=0,max=100)=>Math.max(min,Math.min(max,Number(n)||0));
const finite=(v,d=null)=>finiteNumberOr(v,d);
const avg=xs=>{const a=xs.filter(Number.isFinite);return a.length?a.reduce((s,x)=>s+x,0)/a.length:null};
const withDeadline=(promise,ms,label)=>{let timer;return Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]).finally(()=>clearTimeout(timer));};

export const MOVE_RADAR_DEFAULTS=Object.freeze({
  quote:'USDT',
  thresholdPct:1,
  fastRealertDeltaPct:0.8,
  pollMs:5000,
  reconcileMs:15000,
  reconcileTimeoutMs:20000,
  cooldownMs:30*60*1000,
  maxDeepPerCycle:4,
  minQuoteVolume24h:750000,
  minDataQuality:70,
  minLiquidityQuality:60,
  deepKlines:220,
  deepConcurrency:4,
  earlyMax24hMovePct:1.25,
  earlyMin24hMovePct:-8,
  earlyWakeTriggerPct:0.65,
  earlyWakeDeltaPct:0.35,
  earlyWakeMax24hMovePct:1.10,
  earlyWakeMin24hMovePct:-2,
  earlyWakeScanCooldownMs:90*1000,
  earlyWakeAlertCooldownMs:15*60*1000,
  earlyWakeWatchOnlyCooldownMs:15*60*1000,
  earlyWakeMinScore:76,
  earlyWakeMinLeaders:4,
  fastInterval:'5m',
  fastKlines:96,
  earlyScanCooldownMs:2*60*1000,
  maxEarlyDiscovery:36,
  earlyMinPreMoveScore:82,
  earlyMinExpansionScore:82,
  earlyMinStrategyScore:75,
  earlyMinAcceptedStrategies:3,
  earlyMinConfirmations:8
});

function strategyScore(candidate) {
  const rows=Array.isArray(candidate?.strategies)?candidate.strategies:[];
  const scoreOf=row=>finite(row?.score?.value,null);
  const accepted=rows.filter(x=>x?.accepted&&scoreOf(x)!==null);
  const best=rows.map(scoreOf).filter(Number.isFinite).reduce((m,x)=>Math.max(m,x),0);
  const acceptedMean=avg(accepted.map(scoreOf))??0;
  return {acceptedCount:accepted.length,bestScore:best,acceptedMean};
}

function component(candidate,keyPaths,fallback=50){
  for(const path of keyPaths){
    let node=candidate;
    for(const key of path.split('.')) node=node?.[key];
    const n=finite(node,null);
    if(n!==null) return clamp(n);
  }
  return fallback;
}

export function buildMoveAlert(candidate,trigger,{now=Date.now()}={}) {
  const direction=Number(trigger?.movePct)>=0?'UP_MOVE':'DOWN_MOVE';
  const ctx=candidate?.pre_move_context||{};
  const bottom=candidate?.bottom_context||{};
  const strategies=strategyScore(candidate);
  const liquidity=finite(candidate?.liquidity_quality,0);
  const dataQuality=finite(candidate?.data_quality,0);
  const preMove=component(candidate,['pre_move_context.score'],45);
  const bottomScore=component(candidate,['bottom_context.metrics.composite_algorithm_score'],45);
  const structure=component(candidate,['bottom_context.metrics.structure','bottom_context.algorithms.price_structure.score'],45);
  const buying=component(candidate,['bottom_context.metrics.buying_pressure','bottom_context.algorithms.orderbook_pressure.score'],45);
  const exhaustion=component(candidate,['bottom_context.metrics.selling_exhaustion','bottom_context.algorithms.sell_exhaustion.score'],45);
  const squeeze=component(candidate,['bottom_context.metrics.compression','bottom_context.algorithms.squeeze.score'],45);
  const volume=component(candidate,['bottom_context.algorithms.volume_price_divergence.score','bottom_context.algorithms.momentum_awaken.score'],45);
  const relative=component(candidate,['pre_move_context.components.relative_strength','bottom_context.algorithms.mtf_alignment.score'],50);
  const whale=component(candidate,['bottom_context.metrics.whale_pressure','bottom_context.algorithms.whale_pressure.score'],50);
  const atrRatio=finite(bottom?.algorithms?.momentum_awaken?.atr_ratio,null);
  const atrScore=Number.isFinite(atrRatio)?clamp(50+(atrRatio-1)*80):50;
  const acceptedConfluence=clamp(strategies.acceptedCount*22+strategies.bestScore*0.35);

  const setupScore=clamp(
    strategies.bestScore*0.30+
    acceptedConfluence*0.15+
    preMove*0.15+
    bottomScore*0.15+
    volume*0.08+
    relative*0.07+
    liquidity*0.05+
    dataQuality*0.05
  );

  const expansionPotential=clamp(
    squeeze*0.20+
    volume*0.20+
    structure*0.18+
    relative*0.14+
    atrScore*0.10+
    whale*0.08+
    buying*0.05+
    liquidity*0.05
  );

  const reversalPotential=clamp(
    bottomScore*0.24+
    exhaustion*0.18+
    buying*0.18+
    structure*0.14+
    squeeze*0.10+
    strategies.bestScore*0.08+
    liquidity*0.04+
    dataQuality*0.04
  );

  const opportunityScore=direction==='UP_MOVE'?clamp(setupScore*0.6+expansionPotential*0.4):reversalPotential;
  const eligible=direction==='UP_MOVE'
    ? dataQuality>=MOVE_RADAR_DEFAULTS.minDataQuality &&
      liquidity>=MOVE_RADAR_DEFAULTS.minLiquidityQuality &&
      strategies.bestScore>=65 &&
      opportunityScore>=70
    : dataQuality>=MOVE_RADAR_DEFAULTS.minDataQuality &&
      liquidity>=MOVE_RADAR_DEFAULTS.minLiquidityQuality &&
      reversalPotential>=72;

  const reasons=[];
  const push=(ok,text)=>{if(ok)reasons.push(text)};
  push(strategies.bestScore>=75,'استراتيجية قوية');
  push(strategies.acceptedCount>=2,'توافق استراتيجيات');
  push(volume>=72,'الحجم يستيقظ');
  push(relative>=68,'قوة نسبية');
  push(squeeze>=70,'انكماش قبل التوسع');
  push(structure>=70,'الهيكل يتحسن');
  push(buying>=70,'ضغط شراء');
  push(exhaustion>=70,'انحسار بيع');
  push(whale>=72,'ضغط سيولة شرائية');
  push(preMove>=72,'بصمة ما قبل الحركة');
  if(direction==='DOWN_MOVE'&&reversalPotential>=72) reasons.push('فرصة ارتداد بعد الهبوط');
  if(!reasons.length)reasons.push('حركة وصلت عتبة الرادار مع فحص عميق صالح');

  const potentialLabel=opportunityScore>=82?'HIGH_EXPANSION_SETUP':opportunityScore>=72?'EXPANSION_WATCH':'EARLY_MOVE';
  const riskFlags=[];
  if(finite(candidate?.price_change_24h,0)>20)riskFlags.push('ALREADY_EXTENDED_24H');
  if(finite(candidate?.data_quality,0)<80)riskFlags.push('DATA_QUALITY_NEEDS_ATTENTION');
  if(finite(candidate?.liquidity_quality,0)<70)riskFlags.push('LIQUIDITY_NEEDS_ATTENTION');
  if(finite(ctx.resistance_distance_pct,null)!=null&&finite(ctx.resistance_distance_pct,999)<=3)riskFlags.push('RESISTANCE_NEAR');

  return {
    id:'MOVE:'+candidate.symbol+':'+Number(trigger?.movePct).toFixed(3)+':'+now,
    event:'EARLY_MOVE_ALERT',
    symbol:candidate.symbol,
    market:'SPOT',
    direction,
    trigger:{
      type:'24H_PERCENT_THRESHOLD',
      threshold_pct:MOVE_RADAR_DEFAULTS.thresholdPct,
      move_pct:finite(trigger?.movePct),
      crossed_from_pct:finite(trigger?.previousMovePct)
    },
    price:finite(candidate?.last_price),
    price_change_24h:finite(candidate?.price_change_24h),
    setup_score:Math.round(setupScore*10)/10,
    expansion_potential:Math.round(expansionPotential*10)/10,
    reversal_potential:Math.round(reversalPotential*10)/10,
    opportunity_score:Math.round(opportunityScore*10)/10,
    potential_label:potentialLabel,
    strategy_confluence:{
      active_count:Array.isArray(candidate?.strategies)?candidate.strategies.length:0,
      accepted_count:strategies.acceptedCount,
      best_score:strategies.bestScore,
      accepted_mean:Math.round(strategies.acceptedMean*10)/10,
      accepted_ids:(candidate?.accepted_strategies||[]).slice(0,8)
    },
    components:{pre_move:preMove,bottom:bottomScore,structure,buying_pressure:buying,selling_exhaustion:exhaustion,squeeze,volume,relative_strength:relative,whale_pressure:whale,atr_expansion:atrScore,liquidity,data_quality:dataQuality},
    session_return_pct:finite(ctx.session_return_pct),
    reasons:[...new Set(reasons)],
    risk_flags:[...new Set(riskFlags)],
    data_status:candidate?.data_status||{},
    source:'Binance Public REST/WS',
    detected_at:now,
    processed_at:now,
    paper_trading:true,
    real_order_execution:false,
    confidence_score:'UNKNOWN',
    eligible,
    disclaimer:'Detection of an early setup is not a guarantee of a future +30% move.'
  };
}

export function rankPreExplosionTickerRows(tickers,symbols,{
  minQuoteVolume24h=MOVE_RADAR_DEFAULTS.minQuoteVolume24h,
  max24hMovePct=MOVE_RADAR_DEFAULTS.earlyMax24hMovePct,
  min24hMovePct=MOVE_RADAR_DEFAULTS.earlyMin24hMovePct,
  limit=MOVE_RADAR_DEFAULTS.maxEarlyDiscovery
}={}){
  const allowed=new Set(symbols.map(x=>x.symbol));
  return (Array.isArray(tickers)?tickers:[])
    .map(x=>normalizeTickerRow(x,symbols[0]?.quoteAsset||MOVE_RADAR_DEFAULTS.quote))
    .filter(Boolean)
    .filter(x=>allowed.has(x.symbol))
    .filter(x=>x.quoteVolume24h>=minQuoteVolume24h)
    .filter(x=>x.priceChange24h>=min24hMovePct&&x.priceChange24h<=max24hMovePct)
    .map(x=>{
      const calm=clamp(100-Math.abs(x.priceChange24h)*9);
      const volumeRank=clamp(50+Math.log10(Math.max(1,x.quoteVolume24h/minQuoteVolume24h))*25);
      const tradeRank=clamp(50+Math.log10(Math.max(1,x.tradeCount24h/100))*12);
      const notPumped=clamp(100-Math.max(0,x.priceChange24h)*22);
      const range=x.highPrice24h>x.lowPrice24h?x.highPrice24h-x.lowPrice24h:null;
      const rangePosition=Number.isFinite(range)&&range>0?clamp((x.lastPrice-x.lowPrice24h)/range*100):50;
      const highProximity=rangePosition>=75?90:rangePosition>=60?78:rangePosition>=45?62:38;
      return {
        ...x,
        discovery_factors:{calm,volume_rank:volumeRank,trade_rank:tradeRank,not_pumped:notPumped,range_position:rangePosition,high_proximity:highProximity},
        pre_explosion_discovery_score:
          calm*0.28+volumeRank*0.30+tradeRank*0.14+notPumped*0.16+highProximity*0.12
      };
    })
    .sort((a,b)=>b.pre_explosion_discovery_score-a.pre_explosion_discovery_score||b.quoteVolume24h-a.quoteVolume24h||a.symbol.localeCompare(b.symbol))
    .slice(0,Math.max(1,Math.trunc(limit)));
}

export function buildEarlyWakeAlert(candidate,trigger,{now=Date.now()}={}) {
  const ctx=candidate?.pre_move_context||{};
  const bottom=candidate?.bottom_context||{};
  const alg=bottom?.algorithms||{};
  const metrics=bottom?.metrics||{};
  const strategies=strategyScore(candidate);
  const dataQuality=finite(candidate?.data_quality,0);
  const liquidity=finite(candidate?.liquidity_quality,0);
  const priceChange=finite(candidate?.price_change_24h,0);
  const sessionReturn=finite(ctx.session_return_pct,null);
  const preMove=component(candidate,['pre_move_context.score'],45);
  const momentum=component(candidate,['bottom_context.metrics.momentum','bottom_context.algorithms.momentum_awaken.score'],45);
  const volume=component(candidate,['bottom_context.algorithms.volume_price_divergence.score','bottom_context.algorithms.momentum_awaken.score'],45);
  const buying=component(candidate,['bottom_context.metrics.buying_pressure','bottom_context.algorithms.taker_flow.score'],45);
  const orderbook=component(candidate,['bottom_context.metrics.orderbook_imbalance','bottom_context.algorithms.orderbook_pressure.score'],45);
  const structure=component(candidate,['bottom_context.metrics.structure','bottom_context.algorithms.price_structure.score'],45);
  const squeeze=component(candidate,['bottom_context.metrics.compression','bottom_context.algorithms.squeeze.score'],45);
  const relative=component(candidate,['pre_move_context.components.relative_strength','pre_move_context.components.relative_strength_vs_market'],45);
  const resistance=component(candidate,['pre_move_context.components.resistance_proximity'],45);
  const emaReclaim=component(candidate,['bottom_context.algorithms.ema20_50_reclaim.score'],45);
  const rsiScore=component(candidate,['bottom_context.algorithms.rsi14.score'],45);
  const obv=component(candidate,['bottom_context.algorithms.obv_accumulation.score'],45);
  const wyckoff=component(candidate,['bottom_context.algorithms.wyckoff_spring.score'],45);
  const mtf=component(candidate,['bottom_context.metrics.mtf_alignment','bottom_context.algorithms.mtf_alignment.score'],45);
  const fast=candidate?.fast_impulse_context||{};
  const fastScore=component(candidate,['fast_impulse_context.score'],45);
  const fastMomentum=component(candidate,['fast_impulse_context.scores.momentum'],45);
  const fastVolume=component(candidate,['fast_impulse_context.scores.volume'],45);
  const fastTaker=component(candidate,['fast_impulse_context.scores.taker_buy'],45);
  const fastBreakout=component(candidate,['fast_impulse_context.scores.breakout'],45);
  const fastEma=component(candidate,['fast_impulse_context.scores.ema'],45);
  const fastRange=component(candidate,['fast_impulse_context.scores.range_expansion'],45);
  const fastBody=component(candidate,['fast_impulse_context.scores.body'],45);
  const fastAcceleration=finite(fast?.acceleration_pct,null);
  const takerRatio=finite(alg?.taker_flow?.buy_ratio,null);
  const takerAccel=finite(ctx?.taker_buy_acceleration,null);
  const alreadyMoved=Boolean(ctx.already_moved)||priceChange>MOVE_RADAR_DEFAULTS.earlyWakeMax24hMovePct;
  const calmEnough=priceChange>=MOVE_RADAR_DEFAULTS.earlyWakeMin24hMovePct &&
    priceChange<=MOVE_RADAR_DEFAULTS.earlyWakeMax24hMovePct &&
    (!Number.isFinite(sessionReturn)||sessionReturn<=5);

  const leaderChecks=[
    ['FAST_IMPULSE',fastScore>=65],
    ['FAST_VOLUME_AWAKENING',fastVolume>=62],
    ['FAST_TAKER_PRESSURE',fastTaker>=62],
    ['FAST_BREAKOUT_PRESSURE',fastBreakout>=68],
    ['FAST_EMA_ALIGNMENT',fastEma>=68],
    ['FAST_RANGE_EXPANSION',fastRange>=60],
    ['FAST_BULLISH_BODY',fastBody>=62],
    ['FAST_PRICE_ACCELERATION',Number.isFinite(fastAcceleration)&&fastAcceleration>0.15],
    ['MOMENTUM_AWAKENING',momentum>=60],
    ['VOLUME_AWAKENING',volume>=60],
    ['TAKER_BUY_PRESSURE',(Number.isFinite(takerRatio)&&takerRatio>=0.515)||buying>=60],
    ['ORDERBOOK_PRESSURE',orderbook>=58],
    ['RELATIVE_STRENGTH',relative>=58],
    ['RESISTANCE_PROXIMITY',resistance>=60],
    ['STRUCTURE_IMPROVING',structure>=58],
    ['SQUEEZE_BUILDING',squeeze>=58],
    ['EMA_RECLAIM',emaReclaim>=60],
    ['RSI_TURN_OR_DIVERGENCE',rsiScore>=72],
    ['OBV_ACCUMULATION',obv>=60],
    ['WYCKOFF_SPRING',wyckoff>=60],
    ['MTF_ALIGNMENT',mtf>=58]
  ];
  const leaders=leaderChecks.filter(([,ok])=>ok).map(([name])=>name);
  const hardLeader=fastScore>=70||fastMomentum>=68||fastVolume>=68||fastTaker>=68||momentum>=65||volume>=65||(Number.isFinite(takerRatio)&&takerRatio>=0.53)||orderbook>=65;
  const leaderScore=clamp(
    fastScore*0.30+
    momentum*0.10+
    volume*0.10+
    buying*0.08+
    orderbook*0.06+
    relative*0.06+
    resistance*0.05+
    structure*0.05+
    squeeze*0.05+
    emaReclaim*0.04+
    rsiScore*0.03+
    obv*0.02+
    wyckoff*0.01+
    mtf*0.01+
    preMove*0.04
  );
  const eligible=!alreadyMoved&&calmEnough&&
    dataQuality>=75&&
    liquidity>=65&&
    leaders.length>=MOVE_RADAR_DEFAULTS.earlyWakeMinLeaders&&
    (leaders.length>=4||leaderScore>=MOVE_RADAR_DEFAULTS.earlyWakeMinScore)&&
    hardLeader&&leaderScore>=MOVE_RADAR_DEFAULTS.earlyWakeMinScore;

  const reasons=[];
  const push=(ok,text)=>{if(ok)reasons.push(text)};
  push(momentum>=60,'الزخم يستيقظ');
  push(volume>=60,'الحجم يبدأ بالاستيقاظ');
  push(Number.isFinite(takerRatio)&&takerRatio>=0.515,'Taker Buy يميل للشراء');
  push(orderbook>=58,'ضغط دفتر الأوامر يتحسن');
  push(relative>=58,'قوة نسبية');
  push(resistance>=60,'اقتراب من مقاومة/قمة محلية');
  push(structure>=58,'هيكل صاعد يتشكل');
  push(squeeze>=58,'انكماش يسبق التوسع');
  push(emaReclaim>=60,'استعادة EMA');
  push(rsiScore>=72,'RSI انعكاس/تباعد');
  push(obv>=60,'تراكم OBV');
  push(wyckoff>=60,'بصمة Wyckoff');
  push(mtf>=58,'توافق زمني');
  if(alreadyMoved)reasons.push('رفض: تجاوزت مرحلة الاستيقاظ');
  if(!calmEnough)reasons.push('رفض: الحركة أصبحت متقدمة');

  const potentialLabel=leaderScore>=82?'EARLY_WAKE_HIGH':leaderScore>=74?'EARLY_WAKE':'EARLY_WAKE_WATCH';
  const riskFlags=[];
  if(priceChange>0.75)riskFlags.push('MOVING_FAST');
  if(Number.isFinite(sessionReturn)&&sessionReturn>4)riskFlags.push('SESSION_EXTENDING');
  if(dataQuality<85)riskFlags.push('DATA_QUALITY_ATTENTION');
  if(liquidity<72)riskFlags.push('LIQUIDITY_ATTENTION');

  return {
    id:'WAKE:'+candidate.symbol+':'+Math.round(priceChange*1000)+':'+now,
    event:'EARLY_WAKE_ALERT',
    symbol:candidate.symbol,
    market:'SPOT',
    direction:'UP_MOVE',
    trigger:{
      type:'LEADING_IMPULSE_DETECTION',
      source:'ALL_MARKET_TICKER_WS',
      move_pct:priceChange,
      previous_move_pct:finite(trigger?.previousMovePct,null),
      delta_pct:finite(trigger?.deltaPct,null)
    },
    price:finite(candidate?.last_price),
    price_change_24h:priceChange,
    setup_score:Math.round(leaderScore*10)/10,
    expansion_potential:Math.round(clamp(
      momentum*0.24+volume*0.22+buying*0.16+orderbook*0.12+structure*0.10+squeeze*0.08+relative*0.08
    )*10)/10,
    reversal_potential:null,
    opportunity_score:Math.round(leaderScore*10)/10,
    potential_label:potentialLabel,
    early_wake:{
      eligible,
      leader_count:leaders.length,
      leaders,
      hard_leader:hardLeader,
      calm_enough:calmEnough,
      already_moved:alreadyMoved,
      trigger_delta_pct:finite(trigger?.deltaPct,null),
      max_24h_move_pct:MOVE_RADAR_DEFAULTS.earlyWakeMax24hMovePct,
      session_return_pct:sessionReturn
    },
    strategy_confluence:{
      active_count:Array.isArray(candidate?.strategies)?candidate.strategies.length:0,
      accepted_count:strategies.acceptedCount,
      best_score:strategies.bestScore,
      accepted_mean:Math.round(strategies.acceptedMean*10)/10,
      accepted_ids:(candidate?.accepted_strategies||[]).slice(0,8)
    },
    components:{
      fast_impulse:fastScore,fast_momentum:fastMomentum,fast_volume:fastVolume,fast_taker_buy:fastTaker,fast_breakout:fastBreakout,fast_ema:fastEma,fast_range_expansion:fastRange,fast_body:fastBody,
      pre_move:preMove,momentum,volume,buying_pressure:buying,orderbook_pressure:orderbook,
      structure,squeeze,relative_strength:relative,resistance_proximity:resistance,
      ema_reclaim:emaReclaim,rsi_score:rsiScore,obv_accumulation:obv,wyckoff_spring:wyckoff,mtf_alignment:mtf
    },
    taker_flow:{buy_ratio:takerRatio,buy_acceleration:takerAccel},
    reasons:[...new Set(reasons)].slice(0,10),
    risk_flags:[...new Set(riskFlags)],
    data_status:candidate?.data_status||{},
    source:'Binance Public REST/WS',
    detected_at:now,
    processed_at:now,
    paper_trading:true,
    real_order_execution:false,
    confidence_score:'UNKNOWN',
    eligible,
    disclaimer:'تنبيه استيقاظ مبكر لرصد بداية الحركة؛ لا يضمن ارتفاعًا مستقبليًا أو نسبة محددة.'
  };
}

export function buildPreExplosionAlert(candidate,trigger,{now=Date.now()}={}) {
  const ctx=candidate?.pre_move_context||{};
  const bottom=candidate?.bottom_context||{};
  const strategies=strategyScore(candidate);
  const dataQuality=finite(candidate?.data_quality,0);
  const liquidity=finite(candidate?.liquidity_quality,0);
  const priceChange=finite(candidate?.price_change_24h,0);
  const preMove=component(candidate,['pre_move_context.score'],45);
  const momentum=component(candidate,['bottom_context.metrics.momentum','bottom_context.algorithms.momentum_awaken.score'],45);
  const volume=component(candidate,['bottom_context.algorithms.volume_price_divergence.score','bottom_context.algorithms.momentum_awaken.score'],45);
  const buying=component(candidate,['bottom_context.metrics.buying_pressure','bottom_context.algorithms.orderbook_pressure.score'],45);
  const structure=component(candidate,['bottom_context.metrics.structure','bottom_context.algorithms.price_structure.score'],45);
  const squeeze=component(candidate,['bottom_context.metrics.compression','bottom_context.algorithms.squeeze.score'],45);
  const relative=component(candidate,['pre_move_context.components.relative_strength','bottom_context.algorithms.mtf_alignment.score'],45);
  const mtf=component(candidate,['bottom_context.metrics.mtf_alignment','bottom_context.algorithms.mtf_alignment.score'],45);
  const whale=component(candidate,['bottom_context.metrics.whale_pressure','bottom_context.algorithms.whale_pressure.score'],45);
  const exhaustion=component(candidate,['bottom_context.metrics.selling_exhaustion','bottom_context.algorithms.sell_exhaustion.score'],45);
  const takerRatio=finite(bottom?.algorithms?.taker_flow?.buy_ratio,null);
  const acceptedConfluence=clamp(strategies.acceptedCount*24+strategies.bestScore*0.35);
  const alreadyMoved=Boolean(ctx.already_moved)||priceChange>MOVE_RADAR_DEFAULTS.earlyMax24hMovePct||priceChange>20;
  const sessionReturn=finite(ctx.session_return_pct,null);
  const calmEnough=priceChange<=MOVE_RADAR_DEFAULTS.earlyMax24hMovePct &&
    priceChange>=MOVE_RADAR_DEFAULTS.earlyMin24hMovePct &&
    (!Number.isFinite(sessionReturn)||sessionReturn<=6);

  const confirmations=[
    strategies.bestScore>=MOVE_RADAR_DEFAULTS.earlyMinStrategyScore,
    strategies.acceptedCount>=MOVE_RADAR_DEFAULTS.earlyMinAcceptedStrategies,
    preMove>=MOVE_RADAR_DEFAULTS.earlyMinPreMoveScore,
    momentum>=68,
    volume>=70,
    buying>=68,
    structure>=65,
    squeeze>=65,
    relative>=60,
    mtf>=65,
    liquidity>=70,
    Number.isFinite(takerRatio)&&takerRatio>=0.53
  ];
  const confirmationCount=confirmations.filter(Boolean).length;

  const explosionScore=clamp(
    strategies.bestScore*0.17+
    acceptedConfluence*0.13+
    preMove*0.15+
    momentum*0.12+
    volume*0.10+
    buying*0.10+
    structure*0.08+
    squeeze*0.06+
    relative*0.03+
    mtf*0.03+
    liquidity*0.03
  );

  const eligible=!alreadyMoved&&calmEnough&&
    dataQuality>=80&&
    liquidity>=70&&
    strategies.bestScore>=MOVE_RADAR_DEFAULTS.earlyMinStrategyScore&&
    strategies.acceptedCount>=MOVE_RADAR_DEFAULTS.earlyMinAcceptedStrategies&&
    preMove>=MOVE_RADAR_DEFAULTS.earlyMinPreMoveScore&&
    explosionScore>=MOVE_RADAR_DEFAULTS.earlyMinExpansionScore&&
    confirmationCount>=MOVE_RADAR_DEFAULTS.earlyMinConfirmations;

  const reasons=[];
  const push=(ok,text)=>{if(ok)reasons.push(text)};
  push(strategies.bestScore>=72,'استراتيجية أساسية مؤكدة');
  push(strategies.acceptedCount>=2,'توافق عدة استراتيجيات');
  push(preMove>=78,'بصمة ما قبل الحركة');
  push(momentum>=68,'الزخم يبدأ بالتسارع');
  push(volume>=70,'الحجم يستيقظ قبل القفزة');
  push(buying>=68,'ضغط شراء متزايد');
  push(structure>=65,'الهيكل يتحسن');
  push(squeeze>=65,'انكماش قابل للتوسع');
  push(relative>=60,'قوة نسبية');
  push(mtf>=65,'توافق زمني متعدد');
  push(Number.isFinite(takerRatio)&&takerRatio>=0.53,'Taker Buy يؤكد الطلب');
  push(liquidity>=70,'سيولة قابلة للتنفيذ');
  if(alreadyMoved)reasons.push('رفض: العملة تحركت مسبقًا');
  if(!calmEnough)reasons.push('رفض: الحركة الحالية أعلى من نطاق ما قبل الانفجار');

  const potentialLabel=explosionScore>=86?'PRE_EXPLOSION_HIGH':explosionScore>=80?'PRE_EXPLOSION_CONFIRMED':'PRE_EXPLOSION_WATCH';
  const riskFlags=[];
  const resistanceDistance=finite(ctx.resistance_distance_pct,null);
  if(alreadyMoved)riskFlags.push('ALREADY_MOVED');
  if(Number.isFinite(resistanceDistance)&&resistanceDistance<=1)riskFlags.push('RESISTANCE_TOO_NEAR');
  if(dataQuality<90)riskFlags.push('DATA_QUALITY_ATTENTION');
  if(liquidity<75)riskFlags.push('LIQUIDITY_ATTENTION');

  return {
    id:'PREEXP:'+candidate.symbol+':'+Number(priceChange).toFixed(3)+':'+now,
    event:'PRE_EXPLOSION_ALERT',
    symbol:candidate.symbol,
    market:'SPOT',
    direction:'UP_MOVE',
    trigger:{
      type:'QUIET_PRE_EXPLOSION_DISCOVERY',
      source:'24H_LOW_MOVE_SCAN',
      max_24h_move_pct:MOVE_RADAR_DEFAULTS.earlyMax24hMovePct,
      move_pct:priceChange,
      discovery_score:finite(trigger?.discoveryScore,null)
    },
    price:finite(candidate?.last_price),
    price_change_24h:priceChange,
    setup_score:Math.round(explosionScore*10)/10,
    expansion_potential:Math.round(clamp(
      momentum*0.22+volume*0.20+buying*0.18+structure*0.15+squeeze*0.12+relative*0.06+mtf*0.07
    )*10)/10,
    reversal_potential:null,
    opportunity_score:Math.round(explosionScore*10)/10,
    potential_label:potentialLabel,
    pre_explosion:{
      eligible,
      confirmation_count:confirmationCount,
      confirmation_total:confirmations.length,
      calm_enough:calmEnough,
      already_moved:alreadyMoved,
      session_return_pct:sessionReturn,
      price_change_cap_pct:MOVE_RADAR_DEFAULTS.earlyMax24hMovePct
    },
    strategy_confluence:{
      active_count:Array.isArray(candidate?.strategies)?candidate.strategies.length:0,
      accepted_count:strategies.acceptedCount,
      best_score:strategies.bestScore,
      accepted_mean:Math.round(strategies.acceptedMean*10)/10,
      accepted_ids:(candidate?.accepted_strategies||[]).slice(0,8)
    },
    components:{pre_move:preMove,momentum,volume,buying_pressure:buying,structure,squeeze,relative_strength:relative,mtf_alignment:mtf,whale_pressure:whale,selling_exhaustion:exhaustion,liquidity,data_quality:dataQuality},
    taker_flow:{buy_ratio:takerRatio},
    reasons:[...new Set(reasons)].slice(0,12),
    risk_flags:[...new Set(riskFlags)],
    data_status:candidate?.data_status||{},
    source:'Binance Public REST/WS',
    detected_at:now,
    processed_at:now,
    paper_trading:true,
    real_order_execution:false,
    confidence_score:'UNKNOWN',
    eligible,
    disclaimer:'رادار ما قبل الانفجار يرصد توافق إشارات مبكر؛ لا يضمن ارتفاعًا بنسبة +30% أو أي نسبة مستقبلية.'
  };
}


/**
 * Preserve a narrowly qualified early-flow near miss as a non-entry observation.
 * The strict Early-Wake/Pre-Explosion + Elite gates remain unchanged.
 */
export function buildPreMoveWatchOnlyAlert(candidate,row,trigger,{now=Date.now(),strictFailures=[]}={}){
  const p=candidate?.pre_move_context||{};
  const numeric=value=>{
    if(value===null||value===undefined||value===''||typeof value==='boolean')return null;
    const n=Number(value);return Number.isFinite(n)?n:null;
  };
  const symbol=String(candidate?.symbol||row?.symbol||'').trim().toUpperCase();
  const price=numeric(candidate?.last_price??row?.lastPrice);
  const dailyMove=numeric(candidate?.price_change_24h??row?.priceChange24h);
  const quoteVolume=numeric(row?.quoteVolume24h??row?.quote_volume_24h);
  const dataQuality=numeric(candidate?.data_quality);
  const liquidityQuality=numeric(candidate?.liquidity_quality);
  const source=String(candidate?.data_status?.source||candidate?.source||'').trim();
  const closeAt=numeric(p.session_close);
  const session=numeric(p.session_return_pct);
  const hour=numeric(p.one_hour_return_pct);
  const score=numeric(p.score);
  const volumeRatio=numeric(p.volume_acceleration);
  const tradeRatio=numeric(p.trade_acceleration);
  const taker=numeric(p.taker_buy_ratio);
  const takerDelta=numeric(p.taker_buy_acceleration);
  const closeLocation=numeric(p.mean_close_location);
  const relative=numeric(p.relative_strength_vs_market_pct);
  const structure=numeric(p.components?.structure);
  const buyingPressure=numeric(p.components?.buying_pressure);
  const squeeze=numeric(p.components?.squeeze);
  const ageMs=closeAt===null?null:Number(now)-closeAt;
  const independentEvidence=[
    volumeRatio!==null&&volumeRatio>=1.0,
    tradeRatio!==null&&tradeRatio>=1.05,
    taker!==null&&taker>=0.54,
    takerDelta!==null&&takerDelta>=0.01,
    closeLocation!==null&&closeLocation>=0.54,
    relative!==null&&relative>=0.5
  ].filter(Boolean).length;
  const riskFlags=(Array.isArray(candidate?.risk_flags)?candidate.risk_flags:[])
    .map(value=>String(value).toUpperCase());
  const hardRisk=riskFlags.some(value=>/ALREADY_EXTENDED|EXTENDED_CHASE|HIGH_RISK|STALE|FUTURE_DATA|DATA_GAP|WIDE_SPREAD|FAILED_BREAKOUT|TRAP_RISK|LOW_LIQUIDITY/.test(value));
  const sourceTrusted=/BINANCE[\s_-]*PUBLIC[\s_-]*(REST|WS)|BINANCE PUBLIC REST\/WS/i.test(source);
  const dataValid=candidate?.data_status?.data_valid===true&&
    candidate?.data_status?.data_stale!==true&&candidate?.data_status?.stale!==true&&
    candidate?.data_status?.future_data_detected!==true&&candidate?.data_stale!==true;
  const eligible=
    /^[A-Z0-9]{5,30}USDT$/.test(symbol)&&price!==null&&price>0&&
    quoteVolume!==null&&quoteVolume>=750000&&
    sourceTrusted&&dataValid&&p.evidence_complete===true&&p.closed_candles_only===true&&
    p.already_moved!==true&&closeAt!==null&&ageMs!==null&&ageMs>=0&&ageMs<=20*60*1000&&
    dailyMove!==null&&dailyMove>=-5&&dailyMove<=4.5&&
    score!==null&&score>=68&&
    session!==null&&session>=-1.25&&session<=4.5&&
    hour!==null&&hour>=-0.75&&hour<=2.5&&
    volumeRatio!==null&&volumeRatio>=1.4&&
    tradeRatio!==null&&tradeRatio>=1.05&&
    taker!==null&&taker>=0.50&&
    takerDelta!==null&&takerDelta>=0.03&&
    relative!==null&&relative>=0.25&&
    dataQuality!==null&&dataQuality>=85&&dataQuality<=100&&
    liquidityQuality!==null&&liquidityQuality>=70&&liquidityQuality<=100&&
    structure!==null&&structure>=50&&independentEvidence>=4&&!hardRisk;
  if(!eligible)return null;
  const blockers=[...new Set([
    ...(Array.isArray(strictFailures)?strictFailures.map(String):[]),
    ...(!p.flow_transition_confirmed?['STRICT_FLOW_TRANSITION_NOT_CONFIRMED']:[]),
    ...(!p.structure_gate_passed?['STRICT_STRUCTURE_GATE_NOT_CONFIRMED']:[]),
    'EARLY_WATCH_ONLY_NOT_ENTRY_ELIGIBLE'
  ])].filter(Boolean).slice(0,30);
  const watchContext={
    ...p,stage:'WATCH_EARLY',watch_only:true,actionable:false,
    evidence_complete:true,closed_candles_only:true,already_moved:false
  };
  const evidence={
    volume_acceleration:volumeRatio,trade_acceleration:tradeRatio,
    taker_buy_ratio:taker,taker_buy_acceleration:takerDelta,
    mean_close_location:closeLocation,relative_strength_vs_market_pct:relative,
    independent_confirmations:independentEvidence,closed_candle_close_time:closeAt,
    candle_age_ms:ageMs,quote_volume_24h:quoteVolume
  };
  return {
    id:'EARLY_WAKE_WATCH_ONLY:'+symbol+':'+String(closeAt),
    event:'PRE_MOVE_RADAR_WATCH_ONLY',event_class:'RADAR_WATCH_ONLY',
    radar:'PRE_MOVE',radar_name:'رادار الاستيقاظ المبكر',
    symbol,market:'SPOT',direction:'NONE',price,
    price_change_24h:dailyMove,quote_volume_24h:quoteVolume,
    opportunity_score:score,setup_score:score,
    potential_label:'WATCH_EARLY',decision_band:'WATCH_EARLY',
    pre_move_context:watchContext,
    early_wake_watch_evidence:evidence,
    watch_evidence:evidence,
    watch_notification_tier:'EARLY_FLOW_MONITOR',
    watch_only:true,entry_eligible:false,alert_eligible:false,eligible:false,actionable:false,
    signal_type:'WATCH_ONLY',closed_candles_only:true,detected_candle_close_time:closeAt,
    data_quality:dataQuality,liquidity_quality:liquidityQuality,data_stale:false,
    data_status:{
      ...(candidate.data_status||{}),status:'LIVE_DATA',data_valid:true,
      data_stale:false,stale:false,future_data_detected:false,
      source,close_time:closeAt,candle_closed:true
    },
    source,detected_at:Number(now),processed_at:Number(now),
    reasons:[...(Array.isArray(p.reasons)?p.reasons:[]),
      'تدفق مبكر موثق؛ الشروط الصارمة للدخول لم تكتمل بعد'],
    reason_codes:blockers,watch_reason_codes:blockers,strict_gate_failures:blockers,
    risk_flags:riskFlags,
    notification_gate:{eligible:false,watch_only:true,mode:'PRE_MOVE_WATCH_ONLY'},
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
    disclaimer:'مراقبة مبكرة فقط من بيانات Spot مغلقة؛ لا تعني دخولًا ولا تضمن استمرار الصعود.'
  };
}

export class EarlyMoveSentinel {
  constructor({rest,store,pushManager=null,config={},clock=()=>Date.now(),logger=console,tickerWsFactory=null,scannerFactory=null}){
    if(!rest)throw new Error('REST_CLIENT_REQUIRED');
    if(!store)throw new Error('STORE_REQUIRED');
    this.rest=rest;
    this.store=store;
    this.pushManager=pushManager;
    this.config={...MOVE_RADAR_DEFAULTS,...config};
    this.clock=clock;
    this.logger=logger;
    this.scannerFactory=scannerFactory;
    this.scanner=null;
    this.tickerWsFactory=tickerWsFactory || (opts => new BinanceAllMarketTickerClient(opts));
    this.running=false;
    this.reconcileTimer=null;
    this.spotSymbols=new Set();
    this.lastTicker=new Map();
    this.lastAlertAt=new Map();
    this.lastAlertScore=new Map();
    this.lastEarlyScanAt=new Map();
    this.lastWatchOnlyAt=new Map();
    this.lastWatchOnlyCandleAt=new Map();
    this.preExplosionCursor=0;this.preExplosionRotationTotal=0;
    this.deepQueue=[];
    this.deepActive=0;
    this.deepActiveStartedAt=null;
    // Keep per-symbol start times so a continuously replenished queue does not
    // look like one five-minute scan when individual symbols are completing.
    this.deepActiveJobs=new Map();
    this.deepScanSequence=0;
    this.ws=null;
    this.lastTickAt=null;
    this.lastReconcileAt=null;
    this.reconciling=false;this.reconcileStartedAt=null;this.reconcileSkippedCount=0;this.lifecycleGeneration=0;
    this.alertCount=0;
    this.watchOnlyAlertCount=0;
    this.lastError=null;
  }

  async start(){
    if(this.running)return;
    // A watchdog restart starts a new scan generation. Never inherit an old
    // deep-scan latch/timestamp: stale timestamps can trigger an endless restart
    // loop even though the replacement worker is healthy.
    this.deepQueue=[];
    this.deepActive=0;
    this.deepActiveStartedAt=null;
    this.deepActiveJobs.clear();
    this.reconciling=false;
    this.reconcileStartedAt=null;
    this.running=true;
    const generation=++this.lifecycleGeneration;
    await this.store.init();
    this.scanner=this.scannerFactory?this.scannerFactory(this.rest):new MarketUniverseScanner({
      rest:this.rest,
      config:{
        minQuoteVolume24h:this.config.minQuoteVolume24h,
        minDataQuality:this.config.minDataQuality,
        minLiquidityQuality:this.config.minLiquidityQuality,
        deepKlines:this.config.deepKlines,
        deepConcurrency:this.config.deepConcurrency
      }
    });
    this.ws=this.tickerWsFactory({
      urls:this.config.websocket.urls,
      heartbeatTimeoutMs:this.config.websocket.heartbeatTimeoutMs,
      maxConnectionMs:this.config.websocket.maxConnectionMs,
      initialBackoffMs:this.config.websocket.initialBackoffMs,
      maxBackoffMs:this.config.websocket.maxBackoffMs,
      jitterRatio:this.config.websocket.jitterRatio,
      onTicker:t=>this.onTicker(t,generation),
      onState:(state,reason)=>this.logger.info?.('MOVE_WS',state,reason||'')
    });
    this.ws.start();
    this.reconcileTimer=setInterval(()=>this.reconcile(false,generation).catch(e=>{
      this.lastError=String(e?.message??e);
      this.logger.warn?.('MOVE_RECONCILE',this.lastError);
    }),this.config.reconcileMs);
    try{
      await this.reconcile(true,generation);
    }catch(e){
      this.lastError=String(e?.message??e);
      this.logger.warn?.('MOVE_BOOTSTRAP',this.lastError);
    }
  }

  async stop(){
    this.running=false;
    // Invalidate any in-flight REST reconciliation before a watchdog restart.
    // Its late completion must never mutate the new worker generation.
    this.lifecycleGeneration++;
    this.reconciling=false;
    this.reconcileStartedAt=null;
    if(this.reconcileTimer)clearInterval(this.reconcileTimer);
    this.reconcileTimer=null;
    this.ws?.stop();
    this.ws=null;
    this.deepQueue=[];
    this.deepActive=0;
    this.deepActiveStartedAt=null;
    this.deepActiveJobs.clear();
  }

  health(){
    return {
      running:this.running,
      universe:this.spotSymbols.size,
      websocket:this.ws?.health?.()||{state:'STOPPED'},
      last_tick_at:this.lastTickAt,
      last_reconcile_at:this.lastReconcileAt,
      last_error:this.lastError,
      // Include deep analysis, not only the REST ticker reconciliation, so the
      // swarm watchdog can detect a worker stuck while analyzing a symbol.
      busy:this.reconciling||this.deepActive>0,
      busy_since_at:[this.reconcileStartedAt,this.deepActiveStartedAt].filter(x=>Number.isFinite(Number(x))&&Number(x)>0).map(Number).sort((a,b)=>a-b)[0]||null,
      poll_ms:Math.max(10000,Number(this.config.reconcileMs)||15000),
      reconcile_in_flight:this.reconciling,
      reconcile_skipped_count:this.reconcileSkippedCount,
      queued_deep_scans:this.deepQueue.length,
      active_deep_scans:this.deepActive,
      pre_explosion_scans_tracked:this.lastEarlyScanAt.size,
      pre_explosion_rotation_cursor:this.preExplosionCursor,pre_explosion_rotation_total:this.preExplosionRotationTotal,
      alerts_emitted:this.alertCount,
      watch_only_observations_emitted:this.watchOnlyAlertCount
    };
  }

  eligibleSymbol(symbol){
    return this.spotSymbols.has(String(symbol||'').toUpperCase());
  }

  async reconcile(initial=false,generation=this.lifecycleGeneration){
    if(!this.running||generation!==this.lifecycleGeneration)return;
    // The timer fires every 15s, but public REST fallback can take longer.
    // Never overlap exchangeInfo/ticker reconciliations: overlapping runs amplify
    // timeout aborts and race the shared ticker snapshot/candidate queue.
    if(this.reconciling){this.reconcileSkippedCount++;return;}
    this.reconciling=true;
    this.reconcileStartedAt=this.clock();
    const timeoutMs=Math.max(5000,Math.min(45000,Number(this.config.reconcileTimeoutMs)||20000));
    try{
      const info=await withDeadline(this.rest.request('/api/v3/exchangeInfo'),timeoutMs,'MOVE_RECONCILE_TIMEOUT:EXCHANGE_INFO');
      if(!this.running||generation!==this.lifecycleGeneration)return;
      const universe=buildSpotUniverse(info.data,this.config.quote);
      this.spotSymbols=new Set(universe.map(x=>x.symbol));
      const tick=await withDeadline(this.rest.request('/api/v3/ticker/24hr'),timeoutMs,'MOVE_RECONCILE_TIMEOUT:TICKER_24H');
      if(!this.running||generation!==this.lifecycleGeneration)return;
      const rows=Array.isArray(tick.data)?tick.data:[];
      this.lastReconcileAt=this.clock();
      for(const raw of rows){
        const row=normalizeTickerRow(raw,this.config.quote);
        if(row&&this.eligibleSymbol(row.symbol))this.processTicker(row,initial,generation);
      }
      this.queuePreExplosionDiscovery(rows,generation);
    }catch(error){
      if(generation===this.lifecycleGeneration){
        this.lastError=String(error?.message??error);
        this.logger.warn?.('MOVE_RECONCILE',this.lastError);
      }
      throw error;
    }finally{
      if(generation===this.lifecycleGeneration){
        this.reconciling=false;
        this.reconcileStartedAt=null;
      }
    }
  }

  onTicker(ticker,generation=this.lifecycleGeneration){
    if(!this.running||generation!==this.lifecycleGeneration||!this.eligibleSymbol(ticker?.symbol))return;
    const symbol=String(ticker.symbol).toUpperCase();
    const previous=this.lastTicker.get(symbol);
    const incomingTradeCount=ticker.tradeCount24h;
    // Binance's supported all-market mini ticker stream omits the 24h trade
    // count. Keep the most recent count from the REST /ticker/24hr reconciliation
    // rather than converting missing data to zero and corrupting liquidity scoring.
    const tradeCount24h=incomingTradeCount!==null&&incomingTradeCount!==undefined&&
      Number.isFinite(Number(incomingTradeCount))
      ?Number(incomingTradeCount)
      :previous?.tradeCount24h!==null&&previous?.tradeCount24h!==undefined&&
        Number.isFinite(Number(previous.tradeCount24h))
        ?Number(previous.tradeCount24h):null;
    const row={
      symbol,
      lastPrice:Number(ticker.lastPrice),
      quoteVolume24h:Number(ticker.quoteVolume24h),
      tradeCount24h,
      priceChange24h:Number(ticker.priceChange24h),
      highPrice24h:Number(ticker.highPrice24h),
      lowPrice24h:Number(ticker.lowPrice24h),
      tickerTime:Number(ticker.eventTime)||this.clock(),
      quoteAsset:this.config.quote
    };
    this.processTicker(row,false,generation);
  }

  queuePreExplosionDiscovery(rows,generation=this.lifecycleGeneration){
    if(!this.running||generation!==this.lifecycleGeneration)return;
    const discovery=rankPreExplosionTickerRows(rows,[...this.spotSymbols].map(symbol=>({symbol})),{
      minQuoteVolume24h:this.config.minQuoteVolume24h,
      max24hMovePct:this.config.earlyMax24hMovePct,
      min24hMovePct:this.config.earlyMin24hMovePct,
      limit:Math.max(this.spotSymbols.size,Number(this.config.maxEarlyDiscovery)||36)
    });
    const now=this.clock();
    const queueLimit=Math.max(Number(this.config.maxEarlyDiscovery)||36,(Number(this.config.maxEarlyDiscovery)||36)*2);
    const available=discovery.filter(row=>{
      const last=this.lastEarlyScanAt.get(row.symbol)||0;
      return now-last>=this.config.earlyScanCooldownMs&&
        !this.deepQueue.some(x=>x.symbol===row.symbol&&x.mode==='PRE_EXPLOSION');
    });
    const maxPick=Math.max(1,Math.trunc(Number(this.config.maxEarlyDiscovery)||36));
    const priorityCount=Math.min(available.length,Math.max(1,Math.floor(maxPick*.5)));
    const selected=available.slice(0,priorityCount);
    const selectedSymbols=new Set(selected.map(x=>x.symbol));
    const rotationPool=available.slice(priorityCount);
    let visits=0;
    while(selected.length<Math.min(maxPick,available.length)&&rotationPool.length&&visits<rotationPool.length){
      const row=rotationPool[this.preExplosionCursor%rotationPool.length];
      this.preExplosionCursor=(this.preExplosionCursor+1)%rotationPool.length;
      visits++;
      if(row&&!selectedSymbols.has(row.symbol)){selected.push(row);selectedSymbols.add(row.symbol);}
    }
    this.preExplosionRotationTotal+=visits;
    for(const row of selected){
      if(this.deepQueue.length>=queueLimit)break;
      this.lastEarlyScanAt.set(row.symbol,now);
      this.deepQueue.push({
        symbol:row.symbol,
        row,
        trigger:{movePct:row.priceChange24h,discoveryScore:row.pre_explosion_discovery_score},
        queuedAt:now,
        mode:'PRE_EXPLOSION'
      });
    }
    this.drainDeepQueue(generation).catch(e=>{
      if(generation!==this.lifecycleGeneration)return;
      this.lastError=String(e?.message??e);
      this.logger.warn?.('PRE_EXPLOSION_DEEP',this.lastError);
    });
  }

  processTicker(row,initial=false,generation=this.lifecycleGeneration){
    if(!this.running||generation!==this.lifecycleGeneration)return;
    const symbol=row.symbol;
    const prev=this.lastTicker.get(symbol);
    this.lastTicker.set(symbol,row);
    this.lastTickAt=this.clock();
    if(initial||!prev)return;
    const previous=Number(prev.priceChange24h), current=Number(row.priceChange24h);
    if(!Number.isFinite(previous)||!Number.isFinite(current))return;
    const delta=current-previous;
    const previousPrice=Number(prev.lastPrice), currentPrice=Number(row.lastPrice);
    const priceDeltaPct=Number.isFinite(previousPrice)&&previousPrice>0&&
      Number.isFinite(currentPrice)&&currentPrice>0
      ?(currentPrice/previousPrice-1)*100:null;
    // The 24h-change field can stay nearly flat while a genuine short impulse
    // is forming. Use both the 24h-change delta and the observed tick-price move,
    // but preserve the strict early-stage daily-move ceiling.
    const impulseDeltaPct=Number.isFinite(priceDeltaPct)?Math.max(delta,priceDeltaPct):delta;
    const wakeCross=previous<this.config.earlyWakeTriggerPct&&current>=this.config.earlyWakeTriggerPct&&current<=this.config.earlyWakeMax24hMovePct;
    const wakeImpulse=impulseDeltaPct>=this.config.earlyWakeDeltaPct&&current>=0&&current<=this.config.earlyWakeMax24hMovePct;
    const now=this.clock();
    const wakeScanKey='EARLY_WAKE:'+symbol;
    const lastWakeScan=Number(this.lastEarlyScanAt.get(wakeScanKey)||0);
    if((wakeCross||wakeImpulse)&&now-lastWakeScan>=this.config.earlyWakeScanCooldownMs){
      this.lastEarlyScanAt.set(wakeScanKey,now);
      this.queueDeep(symbol,row,{movePct:current,previousMovePct:previous,deltaPct:impulseDeltaPct,
        dailyChangeDeltaPct:delta,priceDeltaPct,type:'EARLY_WAKE_TICKER_PULSE'},'EARLY_WAKE',generation);
    }
    const crossedUp=previous<this.config.thresholdPct&&current>=this.config.thresholdPct;
    const crossedDown=previous>-this.config.thresholdPct&&current<=-this.config.thresholdPct;
    const rapid=Math.abs(delta)>=this.config.fastRealertDeltaPct;
    const trigger= crossedUp||crossedDown ? {movePct:current,previousMovePct:previous,deltaPct:delta} :
      rapid&&Math.abs(current)>=this.config.thresholdPct ? {movePct:current,previousMovePct:previous,deltaPct:delta}:null;
    if(trigger)this.queueDeep(symbol,row,trigger,'MOVE',generation);
  }

  queueDeep(symbol,row,trigger,mode='MOVE',generation=this.lifecycleGeneration){
    if(!this.running||generation!==this.lifecycleGeneration)return;
    const now=this.clock();
    const last=this.lastAlertAt.get(`${symbol}:${mode==='EARLY_WAKE'?'EARLY_WAKE_ALERT':'EARLY_MOVE_ALERT'}`)||0;
    const cooldown=mode==='EARLY_WAKE'?this.config.earlyWakeAlertCooldownMs:this.config.cooldownMs;
    if(now-last<cooldown)return;
    const existingIndex=this.deepQueue.findIndex(x=>String(x?.symbol||'').toUpperCase()===String(symbol||'').toUpperCase());
    if(existingIndex>=0){
      const pending=this.deepQueue[existingIndex];
      const priorityOf=value=>value==='MOVE'?3:value==='EARLY_WAKE'?2:value==='PRE_EXPLOSION'?1:0;
      const timestamp=(sample,fallback)=>{
        const value=Number(sample?.tickerTime??sample?.eventTime??sample?.closeTime);
        return Number.isFinite(value)&&value>0?value:fallback;
      };
      const incomingAt=timestamp(row,now);
      const pendingAt=timestamp(pending?.row,Number(pending?.queuedAt)||0);
      const incomingFresh=incomingAt>=pendingAt;
      const impulse=value=>Math.abs(Number.isFinite(Number(value?.deltaPct))?Number(value.deltaPct):0);
      const move=value=>Math.abs(Number.isFinite(Number(value?.movePct))?Number(value.movePct):0);
      const incomingDelta=impulse(trigger),pendingDelta=impulse(pending?.trigger);
      const incomingMove=move(trigger),pendingMove=move(pending?.trigger);
      const higherPriority=priorityOf(mode)>priorityOf(pending?.mode);
      const stronger=incomingDelta>pendingDelta+1e-9||
        (incomingDelta>=pendingDelta&&incomingMove>pendingMove+1e-9);
      const replaceTrigger=incomingFresh&&(higherPriority||stronger);
      const refreshed={
        ...pending,
        row:incomingFresh?row:pending.row,
        trigger:replaceTrigger?trigger:pending.trigger,
        mode:replaceTrigger&&higherPriority?mode:pending.mode,
        updatedAt:now,
        refreshCount:(Number(pending?.refreshCount)||0)+1
      };
      this.deepQueue.splice(existingIndex,1);
      if(replaceTrigger)this.deepQueue.unshift(refreshed);
      else this.deepQueue.splice(existingIndex,0,refreshed);
    }else{
      this.deepQueue.push({symbol,row,trigger,queuedAt:now,mode});
    }
    this.drainDeepQueue(generation).catch(e=>{
      if(generation!==this.lifecycleGeneration)return;
      this.lastError=String(e?.message??e);
      this.logger.warn?.('MOVE_DEEP',this.lastError);
    });
  }

  async recordEarlyWakeWatchOnly(watch,job,generation=this.lifecycleGeneration){
    if(!this.running||generation!==this.lifecycleGeneration)return null;
    const closeAt=Number(watch?.detected_candle_close_time);
    if(!Number.isFinite(closeAt)||closeAt<=0)return null;
    if(Number(this.lastWatchOnlyCandleAt.get(job.symbol)||0)===closeAt)
      return {...watch,watch_only_deduplicated:true};
    const now=this.clock();
    const last=this.lastWatchOnlyAt.get(job.symbol)||0;
    const cooldown=Math.max(60_000,Number(this.config.earlyWakeWatchOnlyCooldownMs)||15*60*1000);
    if(now-last<cooldown)return {...watch,watch_only_suppressed_by_cooldown:true};
    const decorated=decorateRadarAlert(watch,'Radar 1 — Early-Wake / WATCH ONLY');
    await this.store.appendMoveAlert(decorated);
    if(!this.running||generation!==this.lifecycleGeneration)return null;
    this.lastWatchOnlyCandleAt.set(job.symbol,closeAt);
    this.lastWatchOnlyAt.set(job.symbol,now);
    this.watchOnlyAlertCount++;
    if(this.pushManager?.notifyRadarWatchOnlyAlert&&this.running&&generation===this.lifecycleGeneration){
      try{
        const result=await this.pushManager.notifyRadarWatchOnlyAlert(decorated);
        this.logger.info?.('[EARLY_WAKE_WATCH_ONLY_RESULT] '+JSON.stringify({
          symbol:job.symbol,status:String(result?.status||'UNKNOWN'),
          attempted:result?.attempted===true,sent_count:Number(result?.sent_count)||0,
          reason:result?.reason||null,watch_only:true,entry_eligible:false
        }));
      }catch(error){
        this.lastError=String(error?.message??error);
        this.logger.warn?.('EARLY_WAKE_WATCH_ONLY_PUSH',this.lastError);
      }
    }
    return decorated;
  }

  async drainDeepQueue(generation=this.lifecycleGeneration){
    const isCurrentGeneration=()=>this.running&&generation===this.lifecycleGeneration;
    while(isCurrentGeneration()&&this.deepActive<this.config.maxDeepPerCycle&&this.deepQueue.length){
      const job=this.deepQueue.shift();
      const activeId=++this.deepScanSequence;
      this.deepActiveJobs.set(activeId,this.clock());
      this.deepActive=this.deepActiveJobs.size;
      this.deepActiveStartedAt=Math.min(...this.deepActiveJobs.values());
      try{
        const candidate=await this.scanner.scanSymbol(job.row,1,{exchangeInfo:'Binance Public REST',ticker:'Binance Public REST'},{klinesLimit:this.config.deepKlines,fastInterval:this.config.fastInterval,fastKlines:this.config.fastKlines});
        // A scan from a stopped generation may finish after the watchdog has
        // restarted this worker. Discard its result before it can archive or
        // notify, and never let its finally block decrement the new generation.
        if(!isCurrentGeneration())return;
        const wakeAlert=buildEarlyWakeAlert(candidate,job.trigger,{now:this.clock()});
        const preAlert=buildPreExplosionAlert(candidate,job.trigger,{now:this.clock()});
        const moveAlert=job.mode==='MOVE'?buildMoveAlert(candidate,job.trigger,{now:this.clock()}):null;
        const alert=preAlert.eligible?preAlert:wakeAlert.eligible?wakeAlert:moveAlert;
        const strictFailures=[];
        if(!preAlert.eligible)strictFailures.push('PRE_EXPLOSION_STRICT_ELIGIBILITY_NOT_MET');
        if(!wakeAlert.eligible)strictFailures.push('EARLY_WAKE_STRICT_ELIGIBILITY_NOT_MET');
        if(moveAlert&&!moveAlert.eligible)strictFailures.push('MOVE_ALERT_STRICT_ELIGIBILITY_NOT_MET');
        if(!alert?.eligible){
          const watch=buildPreMoveWatchOnlyAlert(candidate,job.row,job.trigger,{
            now:this.clock(),strictFailures
          });
          if(watch){
            await this.recordEarlyWakeWatchOnly(watch,job,generation);
            if(!isCurrentGeneration())return;
          }else{
            this.logger.info?.('[EARLY_WAKE_SCAN_REVIEW] '+JSON.stringify({
              symbol:job.symbol,mode:job.mode,
              decision:'REJECTED_NO_WATCH_ONLY_CORRIDOR',
              strict_failures:strictFailures,
              pre_move_missing_evidence:candidate?.pre_move_context?.missing_evidence||[],
              pre_move_score:candidate?.pre_move_context?.score??null,
              data_quality:candidate?.data_quality??null,
              liquidity_quality:candidate?.liquidity_quality??null
            }));
          }
          continue;
        }
        const cc=alert.components||{};
        const sc=alert.strategy_confluence||{};
        const gate=evaluateEliteGate({
          radar:'EARLY_MOVE_SENTINEL',
          direction:alert.direction,
          baseScore:alert.opportunity_score,
          priceChange24h:alert.price_change_24h,
          liquidityScore:cc.liquidity||0,
          dataQualityScore:cc.data_quality||0,
          triggerScore:Math.max(Number(cc.pre_move)||0,Number(alert.expansion_potential)||0),
          structureScore:Number(cc.structure)||50,
          participationScore:Math.max(Number(cc.volume)||0,Number(sc.accepted_mean)||0),
          flowScore:Number(cc.buying_pressure)||50,
          relativeScore:Math.max(Number(cc.relative_strength)||0,Number(cc.mtf_alignment)||0),
          momentumScore:Number(cc.momentum)||50,
          compressionScore:Number(cc.squeeze)||50,
          confirmations:Number(alert.pre_explosion?.confirmation_count||alert.confirmation_count||0),
          minConfirmations:7,minScore:88,max24hMovePct:2.5,requireTrigger:true,minCategoryHits:5
        });
        alert.elite_gate=gate;
        if(!gate.eligible){
          strictFailures.push(...(Array.isArray(gate.failures)?gate.failures:['ELITE_GATE_NOT_ELIGIBLE']));
          const watch=buildPreMoveWatchOnlyAlert(candidate,job.row,job.trigger,{
            now:this.clock(),strictFailures
          });
          if(watch){
            await this.recordEarlyWakeWatchOnly(watch,job,generation);
            if(!isCurrentGeneration())return;
          }else{
            this.logger.info?.('[EARLY_WAKE_SCAN_REVIEW] '+JSON.stringify({
              symbol:job.symbol,mode:job.mode,decision:'REJECTED_ELITE_GATE',
              strict_failures:strictFailures,
              pre_move_missing_evidence:candidate?.pre_move_context?.missing_evidence||[]
            }));
          }
          continue;
        }
        const alertKey=job.symbol+':'+alert.event;
        const recent=this.lastAlertScore.get(alertKey)||0;
        const lastAt=this.lastAlertAt.get(alertKey)||0;
        const cooldown=alert.event==='EARLY_WAKE_ALERT'?this.config.earlyWakeAlertCooldownMs:this.config.cooldownMs;
        if(lastAt>0&&this.clock()-lastAt<cooldown&&alert.opportunity_score<recent+5)continue;
        this.lastAlertAt.set(alertKey,this.clock());
        this.lastAlertScore.set(alertKey,alert.opportunity_score);
        const decorated=decorateRadarAlert(alert,alert.event==='PRE_EXPLOSION_ALERT'?'Radar 1 — Early-Wake / Pre-Explosion':'Radar 1 — Early-Wake');
        if(!isCurrentGeneration())return;
        await this.store.appendMoveAlert(decorated);
        if(!isCurrentGeneration())return;
        if(this.pushManager?.notifyRadarAlert)await this.pushManager.notifyRadarAlert(decorated);
        if(!isCurrentGeneration())return;
        this.alertCount++;
      }catch(error){
        if(isCurrentGeneration()){
          this.lastError=String(error?.message??error);
          if(job.mode==='PRE_EXPLOSION'&&this.lastEarlyScanAt.get(job.symbol)===job.queuedAt)this.lastEarlyScanAt.delete(job.symbol);
          this.logger.warn?.('EARLY_MOVE_DEEP_SCAN',this.lastError);
        }
      }finally{
        if(generation===this.lifecycleGeneration){
          this.deepActiveJobs.delete(activeId);
          this.deepActive=this.deepActiveJobs.size;
          this.deepActiveStartedAt=this.deepActiveJobs.size
            ?Math.min(...this.deepActiveJobs.values()):null;
        }
      }
    }
  }}
