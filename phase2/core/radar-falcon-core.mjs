const clamp=(v,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number.isFinite(Number(v))?Number(v):lo));
const num=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const arr=v=>Array.isArray(v)?v:[];
const uniq=v=>[...new Set(arr(v).map(x=>String(x||'').trim().toUpperCase()).filter(Boolean))];

const DEFAULT_LIMITS=Object.freeze({
  EARLY_MOVE_RADAR:8,
  STRONG_MOVE_RADAR:18,
  ROTATION_LAG_RADAR:8,
  LIQUIDITY_ABSORPTION_RADAR:8,
  KAHIR_RADAR:15,
  DOOMSDAY_RADAR:18,
  PROFESSOR_RADAR:20,
  ALMUQAWIM_RADAR:12,
  EARLY_EXPANSION_RADAR:12,
  COIN_HUNTER_RADAR:8,
  WHALE_ACCUMULATION_RADAR:8,
  FALCON_EYE_RADAR:8
});

function firstNumber(obj,paths,fallback=null){
  for(const path of paths){
    let node=obj;
    for(const key of String(path).split('.')){
      if(node==null){node=undefined;break;}
      node=node[key];
    }
    if(node===null||node===undefined||node==='')continue;
    const n=Number(node);
    if(Number.isFinite(n))return n;
  }
  return fallback;
}

function collectNumericSignals(obj,{depth=0,maxDepth=5,out=[]}={}){
  if(depth>maxDepth||obj==null)return out;
  if(typeof obj==='number'&&Number.isFinite(obj)){out.push(obj);return out;}
  if(Array.isArray(obj)){
    for(const v of obj)collectNumericSignals(v,{depth:depth+1,maxDepth,out});
    return out;
  }
  if(typeof obj!=='object')return out;
  for(const [key,value] of Object.entries(obj)){
    if(typeof value==='number'&&Number.isFinite(value)&&/(score|strength|pressure|momentum|acceleration|compression|relative|resilience|efficiency|participation|confirmation|coverage|quality|imbalance|trigger|breakout|taker|volume|trade)/i.test(key)
      && !/(min|max|threshold|count|total|limit|cooldown|timeout|age|duration|price|time)/i.test(key))out.push(value);
    else if(value&&typeof value==='object')collectNumericSignals(value,{depth:depth+1,maxDepth,out});
  }
  return out;
}

function average(values,fallback=50){
  const a=arr(values).filter(v=>v!==null&&v!==undefined&&v!=='').map(Number).filter(Number.isFinite);
  return a.length?a.reduce((s,x)=>s+x,0)/a.length:fallback;
}

function median(values,fallback=50){
  const a=arr(values).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!a.length)return fallback;
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
}

function bandScore(value,{low=45,high=85}={}){
  const n=Number(value);
  if(!Number.isFinite(n))return 50;
  if(n<low)return clamp(35+(n/Math.max(low,1))*30);
  if(n<=high)return clamp(65+((n-low)/Math.max(high-low,1))*35);
  return clamp(100-(n-high)*1.2);
}

function freshnessScore(alert,now){
  const t=firstNumber(alert,[
    'processed_at','detected_at','as_of','timestamp','time'
  ],null);
  if(!Number.isFinite(t))return 45;
  const age=Math.max(0,Number(now)-t);
  if(age<=15*1000)return 100;
  if(age<=60*1000)return 96;
  if(age<=3*60*1000)return 90;
  if(age<=10*60*1000)return 78;
  if(age<=30*60*1000)return 60;
  if(age<=60*60*1000)return 42;
  return 20;
}

function priceTiming(alert,limit){
  const move=Math.abs(num(alert?.price_change_24h ?? alert?.priceChange24h,0));
  const fp=alert?.pre_breakout_fingerprint||{};
  const early=num(fp?.lead_edge ?? fp?.score,null);
  const antiChase=num(fp?.anti_chase_score,null);
  const momentum=num(fp?.acceleration_score ?? alert?.components?.acceleration ?? alert?.components?.momentum,null);

  const baseTiming=clamp(100-Math.max(0,move-limit)*10);
  const timingParts=[
    [baseTiming,.45],
    [Number.isFinite(early)?clamp(early):null,.25],
    [Number.isFinite(antiChase)?clamp(antiChase):null,.20],
    [Number.isFinite(momentum)?clamp(momentum):null,.10]
  ].filter(([value])=>Number.isFinite(value));
  const timingWeight=timingParts.reduce((s,[,w])=>s+w,0)||1;
  const timing=timingParts.reduce((s,[value,w])=>s+value*w,0)/timingWeight;

  const extended=move>limit;
  const late=move>limit*1.5;
  const stalking=(!extended&&((Number.isFinite(early)&&early>=68)||(Number.isFinite(momentum)&&momentum>=68)));
  return {
    score:clamp(timing),
    move24h:move,
    extended,
    late,
    stalking,
    early_edge:Number.isFinite(early)?clamp(early):null,
    anti_chase:Number.isFinite(antiChase)?clamp(antiChase):null
  };
}

function domainScores(alert){
  const c=alert?.components||{};
  const fp=alert?.pre_breakout_fingerprint||{};
  const elite=alert?.elite_gate||{};
  const liq=alert?.liquidity_absorption||{};
  const strong=alert?.strong_move||{};
  const rotation=alert?.rotation||{};
  const professor=alert?.professor_opinion||{};
  const whale=alert?.analysis||{};
  const pulse=alert?.market_pulse||{};

  const pick=(paths,fallback=50)=>firstNumber(alert,paths,
    firstNumber(c,paths,fallback));

  const structure=average([
    pick(['structure_score']),
    pick(['market_structure_score']),
    num(fp.structure_score,null),
    num(elite.categories?.structure,null),
    num(liq.metrics?.structure_score,null),
    num(rotation.metrics?.resilience,null)
  ],50);

  const flow=average([
    pick(['flow_score']),
    pick(['buying_pressure']),
    pick(['orderbook_pressure']),
    num(fp.pressure_score,null),
    num(elite.categories?.flow,null),
    num(liq.metrics?.absorption_score,null),
    num(whale.score,null),
    Number.isFinite(Number(pulse?.priceDeltaPct))?clamp(50+Number(pulse.priceDeltaPct)*40):null
  ],50);

  const momentum=average([
    pick(['momentum_score']),
    pick(['momentum']),
    num(fp.acceleration_score,null),
    num(strong.metrics?.return_3m,null)!=null?clamp(50+Number(strong.metrics.return_3m)*30):null,
    num(elite.categories?.momentum,null),
    num(pulse?.accelerationScore,null),
    num(pulse?.score,null)
  ],50);

  const volatility=average([
    pick(['compression_score']),
    pick(['compression']),
    num(fp.compression_score,null),
    num(elite.categories?.compression,null)
  ],50);

  const relative=average([
    pick(['relative_score']),
    pick(['relative_strength']),
    num(fp.relative_strength_score,null),
    num(elite.categories?.relative,null),
    num(rotation.metrics?.lag,null)
  ],50);

  const trigger=average([
    pick(['trigger_score']),
    pick(['breakout_score']),
    num(elite.categories?.trigger,null),
    num(elite.score,null),
    num(fp.score,null)
  ],50);

  const participation=average([
    pick(['participation_score']),
    pick(['volume_score']),
    pick(['trade_score']),
    num(fp.participation_score,null),
    num(elite.categories?.participation,null),
    num(liq.metrics?.volume_ratio,null)!=null?clamp(50+(Number(liq.metrics.volume_ratio)-1)*55):null,
    num(pulse?.score,null),
    num(pulse?.volumeBurstRatio,null)!=null?clamp(50+Math.log2(Math.max(.25,Number(pulse.volumeBurstRatio)))*18):null,
    num(pulse?.tradeBurstRatio,null)!=null?clamp(50+Math.log2(Math.max(.25,Number(pulse.tradeBurstRatio)))*18):null
  ],50);

  const liquidity=average([
    num(alert?.liquidity_quality,null),
    num(c?.liquidity,null),
    num(alert?.deep_scan?.assessment?.liquidity_score,null),
    num(liq.metrics?.depth_score,null)
  ],50);

  const data=average([
    num(alert?.data_quality,null),
    num(alert?.data_status?.data_quality,null),
    num(c?.data_quality,null),
    num(alert?.deep_scan?.assessment?.data_quality,null)
  ],100);

  const external=average([
    num(professor?.technical_score,null),
    num(professor?.stream_score,null),
    num(professor?.news_score,null),
    num(alert?.historical_followthrough?.score,null)
  ],50);

  return {
    structure:clamp(structure),
    flow:clamp(flow),
    momentum:clamp(momentum),
    volatility:clamp(volatility),
    relative:clamp(relative),
    trigger:clamp(trigger),
    participation:clamp(participation),
    liquidity:clamp(liquidity),
    data:clamp(data),
    external:clamp(external)
  };
}

function inferEvidence(alert,domains){
  const reasons=arr(alert?.reasons).filter(Boolean);
  const codes=arr(alert?.reason_codes).filter(Boolean);
  const risks=arr(alert?.risk_flags).filter(Boolean);
  const groups={
    STRUCTURE:domains.structure,
    FLOW:domains.flow,
    MOMENTUM:domains.momentum,
    VOLATILITY:domains.volatility,
    RELATIVE:domains.relative,
    TRIGGER:domains.trigger,
    PARTICIPATION:domains.participation,
    LIQUIDITY:domains.liquidity,
    DATA:domains.data
  };
  const strongGroups=Object.entries(groups).filter(([,v])=>Number(v)>=66).map(([k])=>k);
  const hardGroups=Object.entries(groups).filter(([,v])=>Number(v)<48).map(([k])=>k);
  const reasonBreadth=Math.min(12,reasons.length+Math.min(6,codes.length));
  return {
    strong_groups:strongGroups,
    weak_groups:hardGroups,
    group_count:strongGroups.length,
    reason_breadth:reasonBreadth,
    risk_count:risks.length,
    total_signal_domains:Object.keys(groups).length
  };
}

function contradictionCount(alert,domains,limit){
  const fp=alert?.pre_breakout_fingerprint||{};
  let count=0;
  if(domains.flow>=82&&domains.relative<45)count++;
  if(domains.participation>=84&&domains.structure<52)count++;
  if(domains.trigger>=82&&domains.structure<48)count++;
  if(domains.momentum>=85&&priceTiming(alert,limit).extended)count++;
  if(domains.liquidity>=80&&domains.data<72)count++;
  if(num(fp?.pressure_score,null)>=82&&num(fp?.anti_chase_score,null)<52)count++;
  const risks=arr(alert?.risk_flags).map(x=>String(x).toUpperCase());
  if(risks.some(x=>/WHIPSAW|FAKEOUT|SPOOF|WIDE_SPREAD|LOW_LIQUIDITY|DATA_GAP|FUTURE|STALE|INVALID/i.test(x)))count++;
  return count;
}

export function evaluateFalconEye(alert={},{
  now=Date.now(),
  limits=DEFAULT_LIMITS
}={}){
  const radar=String(alert?.radar||'UNKNOWN').toUpperCase();
  const limit=Number(limits?.[radar]||12);
  const timing=priceTiming(alert,limit);
  const domains=domainScores(alert);
  const evidence=inferEvidence(alert,domains);
  const freshness=freshnessScore(alert,now);
  const contradictionCountValue=contradictionCount(alert,domains,limit);

  const quality=clamp(
    domains.data*.16+
    domains.liquidity*.12+
    domains.structure*.12+
    domains.flow*.12+
    domains.momentum*.10+
    domains.relative*.09+
    domains.trigger*.10+
    domains.participation*.08+
    domains.volatility*.06+
    freshness*.03+
    domains.external*.02-
    Math.min(18,contradictionCountValue*4)
  );

  const capture=clamp(
    timing.score*.28+
    domains.momentum*.18+
    domains.participation*.16+
    domains.flow*.12+
    domains.volatility*.10+
    domains.structure*.08+
    domains.relative*.08
  );

  const earlyWindow=!timing.extended&&!timing.late&&(
    timing.stalking ||
    (timing.score>=74&&domains.volatility>=62&&domains.participation>=60)
  );

  const hardFail=
    domains.data<65 ||
    domains.liquidity<48 ||
    freshness<28 ||
    contradictionCountValue>=4 ||
    arr(alert?.risk_flags).some(x=>/FUTURE|STALE|INVALID_DATA|DATA_GAP/i.test(String(x).toUpperCase())) ||
    Boolean(alert?.data_status?.future_data_detected) ||
    Boolean(alert?.data_status?.stale);

  let stage='NOISE';
  if(hardFail)stage='REJECT';
  else if(earlyWindow&&capture>=82&&quality>=76)stage='FALCON_LOCK';
  else if(earlyWindow&&capture>=70&&quality>=68)stage='FALCON_STALK';
  else if(quality>=90&&capture>=82)stage='CONFIRMED';
  else if(quality>=78)stage='VALIDATED';
  else if(capture>=68)stage='WATCH';

  const radarClass=timing.late
    ? 'POST_MOVE'
    : timing.extended
      ? 'EXTENDED'
      : earlyWindow
        ? 'EARLY_DISCOVERY'
        : stage;

  const scoreSnapshot={
    quality:Number(quality.toFixed(1)),
    capture:Number(capture.toFixed(1)),
    freshness:Number(freshness.toFixed(1)),
    timing:Number(timing.score.toFixed(1)),
    contradiction_count:contradictionCountValue
  };

  return {
    version:'FALCON_EYE_V1',
    stage,
    radar_class:radarClass,
    ...scoreSnapshot,
    early_window:earlyWindow,
    timing:{
      move_24h_pct:Number(timing.move24h.toFixed(3)),
      limit_24h_pct:limit,
      extended:timing.extended,
      late:timing.late,
      stalking:timing.stalking,
      early_edge:timing.early_edge,
      anti_chase:timing.anti_chase
    },
    domains:Object.fromEntries(Object.entries(domains).map(([k,v])=>[k,Number(v.toFixed(1))])),
    evidence,
    independent_domains:evidence.group_count,
    decision:hardFail?'REJECT':quality>=85&&capture>=78?'HIGH_QUALITY':earlyWindow&&capture>=78&&quality>=72?'EARLY_HIGH_QUALITY':quality>=70?'QUALITY_WATCH':'LOW_QUALITY',
    hard_fail:hardFail,
    capture_priority:earlyWindow?Math.max(0,Number((capture-68).toFixed(1))):0
  };
}

export function falconThresholdFor(radar,mode='standard'){
  const r=String(radar||'').toUpperCase();
  const early=mode==='early'||r==='EARLY_MOVE_RADAR'||r==='EARLY_EXPANSION_RADAR'||r==='COIN_HUNTER_RADAR';
  return early
    ? {minQuality:72,minCapture:76,minIndependentDomains:4}
    : {minQuality:76,minCapture:72,minIndependentDomains:4};
}

export function isFalconEligible(alert,{now=Date.now(),mode='standard'}={}){
  const f=alert?.falcon_eye||evaluateFalconEye(alert,{now});
  const t=falconThresholdFor(alert?.radar,mode);
  return !f.hard_fail &&
    f.quality>=t.minQuality &&
    f.capture>=t.minCapture &&
    Number(f.independent_domains)>=t.minIndependentDomains;
}

export const FALCON_LIMITS=DEFAULT_LIMITS;
