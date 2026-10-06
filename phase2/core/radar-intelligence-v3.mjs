const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number.isFinite(Number(v))?Number(v):min));
const num=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;

const EXTENSION_CAPS=Object.freeze({
  EARLY_MOVE_RADAR:2.5,
  STRONG_MOVE_RADAR:18,
  ROTATION_LAG_RADAR:8,
  LIQUIDITY_ABSORPTION_RADAR:8,
  KAHIR_RADAR:15,
  DOOMSDAY_RADAR:18,
  ALMUQAWIM_RADAR:10,
  PROFESSOR_RADAR:12
});

const BAD_RISK_PENALTIES=Object.freeze({
  ALREADY_EXTENDED_24H:12,
  ALREADY_MOVED:10,
  ALREADY_EXTENDED:10,
  MOVING_FAST:5,
  SESSION_EXTENDING:5,
  RESISTANCE_TOO_NEAR:7,
  DATA_QUALITY_ATTENTION:4,
  LIQUIDITY_ATTENTION:4,
  LIQUIDITY_TOO_WEAK:12,
  DATA_QUALITY_TOO_WEAK:12,
  NO_PRIMARY_TRIGGER:8,
  LOW_CONFLUENCE:10,
  LOW_CATEGORY_DIVERSITY:8,
  VOLUME_WITHOUT_PRICE_FOLLOW_THROUGH:10,
  FLOW_WITHOUT_RELATIVE_SUPPORT:8,
  SELLING_PRESSURE_HIGH:7,
  VOLATILITY_EXTREME:7,
  AGAINST_HIGHER_TIMEFRAME:12
});

const ROOTS=Object.freeze({
  EARLY_MOVE_RADAR:'early_wake',
  STRONG_MOVE_RADAR:'strong_move',
  ROTATION_LAG_RADAR:'rotation',
  LIQUIDITY_ABSORPTION_RADAR:'liquidity_absorption',
  KAHIR_RADAR:'kahir_analysis',
  DOOMSDAY_RADAR:'doomsday',
  ALMUQAWIM_RADAR:'almuqawim',
  PROFESSOR_RADAR:'professor'
});

function isPublicSource(value){
  const s=String(value??'').toUpperCase();
  return s==='BINANCE PUBLIC REST'||
    s==='BINANCE PUBLIC WS'||
    s==='BINANCE PUBLIC REST/WS'||
    s.includes('BINANCE PUBLIC');
}

function collectNumbers(node,key='',out=[]){
  if(node==null)return out;
  if(typeof node==='number'&&Number.isFinite(node)){
    out.push({key,value:node});
    return out;
  }
  if(Array.isArray(node)){
    for(const v of node)collectNumbers(v,key,out);
    return out;
  }
  if(typeof node==='object'){
    for(const [k,v] of Object.entries(node)){
      const next=key?key+'.'+k:k;
      collectNumbers(v,next,out);
    }
  }
  return out;
}

function keywordScore(rows,patterns){
  const values=rows.filter(row=>patterns.some(p=>p.test(row.key))).map(row=>clamp(row.value));
  if(!values.length)return null;
  values.sort((a,b)=>b-a);
  return values.slice(0,Math.min(5,values.length)).reduce((s,x)=>s+x,0)/Math.min(5,values.length);
}

function bucketScores(alert,rootRows){
  const all=[...collectNumbers(alert?.components),...rootRows];
  return {
    trigger:keywordScore(all,[/trigger/i,/breakout/i,/impulse/i,/wake/i,/ignition/i]),
    structure:keywordScore(all,[/structure/i,/trendline/i,/market_structure/i,/hh/i,/hl/i,/lh/i,/ll/i]),
    participation:keywordScore(all,[/volume/i,/trade/i,/participation/i,/activity/i]),
    flow:keywordScore(all,[/taker/i,/buy/i,/sell/i,/orderbook/i,/flow/i,/absorption/i,/imbalance/i]),
    relative:keywordScore(all,[/relative/i,/spread/i,/lead/i,/lag/i,/market.?speed/i]),
    momentum:keywordScore(all,[/momentum/i,/velocity/i,/acceleration/i,/impulse/i]),
    compression:keywordScore(all,[/compression/i,/squeeze/i,/range/i,/bollinger/i,/volatility/i,/atr/i]),
    trend:keywordScore(all,[/ema/i,/moving_average/i,/vwap/i,/trend/i,/acceptance/i,/efficiency/i]),
    quality:keywordScore(all,[/data_quality/i,/quality/i,/liquidity/i])
  };
}

function diversity(scores){
  const names=Object.entries(scores).filter(([name,v])=>
    name!=='quality'&&Number.isFinite(v)&&v>=70
  ).map(([name])=>name);
  return {count:names.length,names};
}

function confirmationScore(alert,rootRows){
  const count=num(alert?.confirmation_count,
    num(alert?.pre_explosion?.confirmation_count,
      num(alert?.early_wake?.leader_count,
        num(rootRows.find(x=>/confirmation_count$/.test(x.key))?.value,null)
      )
    )
  );
  const total=num(alert?.confirmation_total,
    num(alert?.pre_explosion?.confirmation_total,
      num(alert?.early_wake?.max_24h_move_pct,
        num(rootRows.find(x=>/confirmation_total$/.test(x.key))?.value,null)
      )
    )
  );
  if(Number.isFinite(count)&&Number.isFinite(total)&&total>0)return clamp(count/total*100);
  if(Number.isFinite(count))return clamp(50+Math.min(count,8)*6.25);
  return 55;
}

function extensionScore(alert,radar){
  const move=Math.abs(num(alert?.price_change_24h,0));
  const cap=EXTENSION_CAPS[radar]??10;
  if(!(move>0))return 100;
  const earlyCap=cap*.25;
  if(move<=earlyCap)return 100;
  if(move>=cap)return 0;
  return clamp(100-((move-earlyCap)/(cap-earlyCap))*100);
}

function directionQuality(alert,scores){
  const dir=String(alert?.direction??'').toUpperCase();
  if(!dir)return 75;
  const buyRatio=num(alert?.taker_flow?.buy_ratio,
    num(alert?.strong_move?.metrics?.taker_buy_ratio,
      num(alert?.liquidity_absorption?.metrics?.taker_buy_ratio,null)
    )
  );
  const up=dir.includes('UP')||dir.includes('BULL');
  if(Number.isFinite(buyRatio)){
    if(up)return clamp(50+(buyRatio-.5)*220);
    return clamp(50-(buyRatio-.5)*220);
  }
  if(String(alert?.entry_risk??'')==='AGAINST_HTF_TREND')return 25;
  if(Number.isFinite(scores.flow)&&Number.isFinite(scores.structure)){
    return clamp((scores.flow+scores.structure)/2);
  }
  return 70;
}

export function buildRadarIntelligenceV3(alert){
  const radar=String(alert?.radar??'').toUpperCase();
  const root=ROOTS[radar];
  const rootRows=root?collectNumbers(alert?.[root],root):[];
  const scores=bucketScores(alert,rootRows);
  const diversityInfo=diversity(scores);
  const baseScore=clamp(alert?.opportunity_score??alert?.setup_score??alert?.radar_power_score??0);
  const dataQuality=clamp(
    alert?.data_quality??
    alert?.data_status?.data_quality??
    alert?.components?.data_quality??
    scores.quality??
    90
  );
  const liquidity=clamp(
    alert?.liquidity_quality??
    alert?.components?.liquidity??
    90
  );
  const confirmations=confirmationScore(alert,rootRows);
  const extension=extensionScore(alert,radar);
  const direction=directionQuality(alert,scores);
  const evidenceValues=Object.values(scores).filter(Number.isFinite).filter(x=>x>=55).sort((a,b)=>b-a);
  const strongestEvidence=evidenceValues.length
    ? evidenceValues.slice(0,Math.min(6,evidenceValues.length)).reduce((s,x)=>s+x,0)/Math.min(6,evidenceValues.length)
    : 50;

  const riskFlags=Array.isArray(alert?.risk_flags)?alert.risk_flags.map(x=>String(x).toUpperCase()):[];
  let riskPenalty=0;
  for(const flag of riskFlags)riskPenalty+=BAD_RISK_PENALTIES[flag]??0;
  riskPenalty=clamp(riskPenalty,0,30);

  const dataGuard=(alert?.closed_candles_only===true?100:0);
  const sourceGuard=isPublicSource(alert?.source)?100:0;
  const paperGuard=alert?.paper_trading===true&&alert?.real_order_execution===false?100:0;
  const integrity=(dataGuard*.45+sourceGuard*.30+paperGuard*.25);

  const componentScore=
    baseScore*.24+
    strongestEvidence*.22+
    diversityInfo.count>=6?17:
    diversityInfo.count>=4?14:
    diversityInfo.count>=3?11:
    diversityInfo.count>=2?7:3+
    confirmations*.12+
    dataQuality*.10+
    liquidity*.08+
    extension*.07+
    direction*.05+
    integrity*.02;

  const quality=clamp(componentScore-riskPenalty);
  const gate=
    Boolean(alert?.eligible!==false)&&
    alert?.closed_candles_only===true&&
    isPublicSource(alert?.source)&&
    alert?.paper_trading===true&&
    alert?.real_order_execution===false&&
    dataQuality>=75&&
    liquidity>=60&&
    diversityInfo.count>=3&&
    quality>=72&&
    !riskFlags.includes('AGAINST_HIGHER_TIMEFRAME');

  const grade=gate&&quality>=90?'ELITE':
    gate&&quality>=82?'STRONG':
    quality>=72?'WATCH':'REJECT';

  const reasons=[];
  const add=(label,value,threshold=70)=>{if(Number.isFinite(value)&&value>=threshold)reasons.push({label,score:Number(value.toFixed(1))});};
  add('محفز رئيسي',scores.trigger,68);
  add('هيكل سعري',scores.structure,68);
  add('مشاركة الحجم/الصفقات',scores.participation,68);
  add('تدفق/سيولة',scores.flow,68);
  add('قوة نسبية',scores.relative,65);
  add('زخم/تسارع',scores.momentum,68);
  add('انكماش/تذبذب',scores.compression,65);
  add('اتجاه/متوسط',scores.trend,65);
  reasons.sort((a,b)=>b.score-a.score);

  const failures=[];
  if(alert?.closed_candles_only!==true)failures.push('OPEN_CANDLE_BLOCK');
  if(!isPublicSource(alert?.source))failures.push('SOURCE_BLOCK');
  if(dataQuality<75)failures.push('DATA_QUALITY_LOW');
  if(liquidity<60)failures.push('LIQUIDITY_LOW');
  if(diversityInfo.count<3)failures.push('LOW_EVIDENCE_DIVERSITY');
  if(quality<72)failures.push('QUALITY_BELOW_GATE');
  if(riskFlags.includes('AGAINST_HIGHER_TIMEFRAME'))failures.push('HIGHER_TIMEFRAME_CONFLICT');

  return {
    version:'3.0',
    radar,
    quality_score:Number(quality.toFixed(1)),
    grade,
    gate:Boolean(gate),
    base_score:Number(baseScore.toFixed(1)),
    strongest_evidence_score:Number(strongestEvidence.toFixed(1)),
    evidence_diversity:{count:diversityInfo.count,names:diversityInfo.names},
    confirmations:Number(confirmations.toFixed(1)),
    data_quality:Number(dataQuality.toFixed(1)),
    liquidity:Number(liquidity.toFixed(1)),
    anti_chase:{score:Number(extension.toFixed(1)),price_change_24h_pct:num(alert?.price_change_24h,0),cap_pct:EXTENSION_CAPS[radar]??10},
    direction_alignment:Number(direction.toFixed(1)),
    integrity:{score:Number(integrity.toFixed(1)),closed_candles:dataGuard===100,public_source:sourceGuard===100,paper_only:paperGuard===100},
    risk_penalty:Number(riskPenalty.toFixed(1)),
    top_evidence:reasons.slice(0,6),
    failures,
    decision:gate?'PASS':'FILTER',
    note:'طبقة جودة مشتركة؛ لا تمثل احتمال ربح ولا ثقة رقمية بالصفقة.'
  };
}
