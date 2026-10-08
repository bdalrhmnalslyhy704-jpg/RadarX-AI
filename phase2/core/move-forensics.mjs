const clamp=(v,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number.isFinite(Number(v))?Number(v):50));
const num=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const arr=v=>Array.isArray(v)?v:[];

const pick=(obj,paths,d=null)=>{
  for(const p of paths){
    let x=obj;
    for(const k of String(p).split('.')){if(x==null)break;x=x[k];}
    const n=Number(x);
    if(Number.isFinite(n))return n;
  }
  return d;
};

function scoreRatio(ratio,base=1.0,scale=55){
  const n=Number(ratio);
  return Number.isFinite(n)?clamp(50+(n-base)*scale):50;
}

function scorePct(value,scale=12){
  const n=Number(value);
  return Number.isFinite(n)?clamp(50+n*scale):50;
}

function boolScore(v,yes=88,no=45){return v===true?yes:no;}

export function buildMoveForensics(alert={},now=Date.now()){
  const c=alert?.components||{};
  const fp=alert?.pre_breakout_fingerprint||{};
  const strong=alert?.strong_move?.metrics||{};
  const whale=alert?.analysis||{};
  const liq=alert?.liquidity_absorption||{};
  const opinion=alert?.professor_opinion||{};

  const price24=Math.abs(num(alert.price_change_24h??alert.priceChange24h,0));
  const volumeRatio=pick(alert,['volume_ratio','volumeAcceleration'],pick(c,['volume_ratio','volume_acceleration'],pick(fp,['volume_ratio'],null)));
  const tradeRatio=pick(alert,['trade_ratio','tradeAcceleration'],pick(c,['trade_ratio','trade_acceleration'],null));
  const taker=pick(alert,['taker_buy_ratio'],pick(c,['taker_buy_ratio','taker'],pick(fp,['taker_buy_ratio'],pick(strong,['taker_buy_ratio'],null))));
  const breakout=pick(alert,['breakout_score','breakout'],pick(c,['breakout'],pick(fp,['resistance_pressure_score'],null)));
  const compression=pick(alert,['compression_score'],pick(c,['compression','squeeze'],pick(fp,['compression_score'],null)));
  const relative=pick(alert,['relative_score','relative_strength'],pick(c,['relative_strength'],pick(fp,['relative_strength_score'],null)));
  const liquidity=pick(alert,['liquidity_quality'],pick(c,['liquidity'],pick(liq,['metrics.depth_score'],null)));
  const data=pick(alert,['data_quality'],pick(alert,['data_status.data_quality'],100));
  const impulse=pick(alert,['momentum_score','opportunity_score'],pick(c,['momentum','momentum_score'],pick(fp,['acceleration_score'],50)));
  const marketCap=pick(alert,['market_cap','marketCap','market.cap'],null);
  const quoteVolume=pick(alert,['quote_volume_24h','quoteVolume24h','quoteVolume','volume_24h'],null);

  const newsMentions=num(alert.news_mentions,0);
  const streamMentions=num(alert.stream_mentions,0);
  const newsScore=pick(opinion,['news_score'],pick(alert,['news_score'],50));
  const streamScore=pick(opinion,['stream_score'],pick(alert,['stream_score'],50));

  const buybackTokens=pick(alert,['buyback_tokens','buybacks_og_n','buybacks'],null);
  const boughtPct=pick(alert,['buyback_pct_circulating','buyback_percent_circulating'],null);
  const stakedPct=pick(alert,['staked_pct','staking_pct','percent_staked'],null);
  const annualizedBuybacks=pick(alert,['annualized_buybacks'],null);
  const protocolRevenue=pick(alert,['protocol_revenue_30d','revenue_30d','protocol_revenue'],null);

  const volumeScore=scoreRatio(volumeRatio,1,58);
  const tradeScore=scoreRatio(tradeRatio,1,48);
  const flowScore=Number.isFinite(taker)?clamp(50+(taker-.5)*360):50;
  const breakoutScore=Number.isFinite(breakout)?clamp(breakout):50;
  const compressionScore=Number.isFinite(compression)?clamp(compression):50;
  const relativeScore=Number.isFinite(relative)?clamp(relative):50;
  const liquidityScore=Number.isFinite(liquidity)?clamp(liquidity):50;
  const impulseScore=Number.isFinite(impulse)?clamp(impulse):50;

  const priceElasticity=(marketCap&&quoteVolume&&marketCap>0&&quoteVolume>0)
    ?clamp(55+Math.log10(Math.max(1,quoteVolume/marketCap))*34):50;

  const catalystEvidence=Math.min(100,
    (newsMentions>0?22:0)+
    (streamMentions>0?18:0)+
    (newsScore>62?20:0)+
    (streamScore>62?15:0)+
    (buybackTokens>0?12:0)+
    (boughtPct>0?8:0)+
    (stakedPct>=35?10:0)
  );

  const supplySqueeze=clamp(
    (stakedPct!=null?clamp(stakedPct*1.7):50)*.45+
    (boughtPct!=null?clamp(boughtPct*5):50)*.25+
    (annualizedBuybacks!=null?68:50)*.15+
    (protocolRevenue!=null?65:50)*.15
  );

  const rotation=clamp(
    relativeScore*.50+
    scorePct(num(alert.market_rotation_pct,0),10)*.20+
    scorePct(num(alert.sector_rotation_pct,0),8)*.15+
    (num(alert.btc_24h,null)!=null?clamp(50-num(alert.btc_24h)*3):50)*.15
  );

  const ignition=clamp(
    volumeScore*.20+
    tradeScore*.10+
    flowScore*.18+
    breakoutScore*.17+
    compressionScore*.10+
    relativeScore*.10+
    liquidityScore*.08+
    impulseScore*.07
  );

  const antiLate=clamp(
    price24<=3?92:
    price24<=6?82:
    price24<=10?62:
    price24<=15?38:15
  );

  const signatures=[];
  if(ignition>=78)signatures.push('LIQUIDITY_VOLUME_IGNITION');
  if(volumeScore>=80&&tradeScore>=72)signatures.push('TRADE_PARTICIPATION_BURST');
  if(breakoutScore>=72&&compressionScore>=65)signatures.push('COMPRESSION_TO_BREAKOUT');
  if(relativeScore>=68)signatures.push('RELATIVE_STRENGTH_ROTATION');
  if(priceElasticity>=70)signatures.push('LOW_CAPITALIZATION_ELASTICITY');
  if(flowScore>=70)signatures.push('TAKER_BUY_PRESSURE');
  if(supplySqueeze>=68)signatures.push('SUPPLY_SQUEEZE_TAILWIND');
  if(catalystEvidence>=55)signatures.push('EXTERNAL_CATALYST_EVIDENCE');

  const immediateDrivers=signatures.filter(x=>/IGNITION|BURST|BREAKOUT|ROTATION|TAKER/.test(x));
  const contextualDrivers=signatures.filter(x=>/ELASTICITY|SUPPLY|CATALYST/.test(x));

  const score=clamp(
    ignition*.34+
    priceElasticity*.12+
    supplySqueeze*.12+
    catalystEvidence*.12+
    rotation*.12+
    liquidityScore*.08+
    data*.05+
    antiLate*.05
  );

  const quality=clamp(data*.25+liquidityScore*.20+ignition*.25+(100-Math.max(0,price24-8)*8)*.10+catalystEvidence*.10+supplySqueeze*.10);
  const reject= data<65 || liquidityScore<45 || price24>25 || alert?.data_status?.stale || alert?.data_status?.future_data_detected;

  return {
    version:'MOVE_FORENSICS_V1',
    as_of:new Date(Number(now)||Date.now()).toISOString(),
    score:Number(score.toFixed(1)),
    quality:Number(quality.toFixed(1)),
    ignition_score:Number(ignition.toFixed(1)),
    price_elasticity_score:Number(priceElasticity.toFixed(1)),
    supply_squeeze_score:Number(supplySqueeze.toFixed(1)),
    catalyst_evidence_score:Number(catalystEvidence.toFixed(1)),
    rotation_score:Number(rotation.toFixed(1)),
    anti_late_score:Number(antiLate.toFixed(1)),
    immediate_drivers:immediateDrivers,
    contextual_drivers:contextualDrivers,
    signatures,
    factors:{
      volume_ratio:Number.isFinite(volumeRatio)?Number(volumeRatio.toFixed(3)):null,
      trade_ratio:Number.isFinite(tradeRatio)?Number(tradeRatio.toFixed(3)):null,
      taker_buy_ratio:Number.isFinite(taker)?Number(taker.toFixed(4)):null,
      price_change_24h_pct:Number(price24.toFixed(3)),
      breakout_score:Number(breakoutScore.toFixed(1)),
      compression_score:Number(compressionScore.toFixed(1)),
      relative_strength_score:Number(relativeScore.toFixed(1)),
      liquidity_score:Number(liquidityScore.toFixed(1)),
      market_cap:marketCap,
      quote_volume_24h:quoteVolume,
      news_mentions:newsMentions,
      stream_mentions:streamMentions,
      buyback_tokens:buybackTokens,
      buyback_pct_circulating:boughtPct,
      staked_pct:stakedPct,
      annualized_buybacks:annualizedBuybacks,
      protocol_revenue_30d:protocolRevenue
    },
    decision:reject?'REJECT':score>=82?'HIGH_IMPULSE_QUALITY':score>=70?'EARLY_MOVER_QUALITY':'WATCH',
    hard_fail:Boolean(reject),
    learning_target:'CAPTURE_BEFORE_THE_MOVE',
    disclaimer:'Forensic factor extraction explains observed market mechanics; it does not prove causation or guarantee repetition.'
  };
}
