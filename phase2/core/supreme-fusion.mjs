// RadarX Supreme Fusion v1 — evidence-first market decision layer.
// Pure, deterministic, read-only analysis. It does not place orders and never fabricates confidence.
// Designed to sit above the analyst council as a correlation-aware decision layer.

const clamp=(v,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number.isFinite(Number(v))?Number(v):50));
const num=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const avg=(a,d=50)=>{const v=(Array.isArray(a)?a:[]).map(Number).filter(Number.isFinite);return v.length?v.reduce((s,x)=>s+x,0)/v.length:d};
const uniq=a=>[...new Set((Array.isArray(a)?a:[]).filter(Boolean))];

const FAMILY_MEMBERS=Object.freeze({
  STRUCTURE:['MTF_STRUCTURE','TREND_ALIGNMENT','SUPPORT_RESISTANCE'],
  MOMENTUM:['MOMENTUM_ENGINE','MACD_TREND_CONTINUATION','BREAKOUT_VALIDATOR'],
  PARTICIPATION:['RVOL_ACCELERATION','ORDER_FLOW_PRESSURE','LIQUIDITY_QUALITY'],
  VOLATILITY:['VOLATILITY_SQUEEZE','ATR_EXPANSION'],
  RELATIVE:['RELATIVE_STRENGTH','MARKET_REGIME'],
  CATALYST:['NEWS_SCOUT','OFFICIAL_VERIFIER','CATALYST_HUNTER','NARRATIVE_ENGINE','SOCIAL_PULSE'],
  RISK:['TRAP_DETECTOR','RISK_GEOMETRY','HISTORY_LEARNER']
});

function getAgentMap(verdict){
  const m=new Map();
  for(const a of Array.isArray(verdict?.agents)?verdict.agents:[]){
    const id=String(a?.id||'').toUpperCase();
    if(id)m.set(id,a);
  }
  return m;
}

function familyReadings(agents){
  const out={};
  for(const [family,ids] of Object.entries(FAMILY_MEMBERS)){
    const rows=ids.map(id=>agents.get(id)).filter(Boolean);
    const scores=rows.map(x=>num(x.score,null)).filter(v=>v!=null);
    const spread=scores.length>1?Math.sqrt(avg(scores.map(v=>(v-avg(scores,50))**2),0)):0;
    const evidence=rows.reduce((s,x)=>{
      const d=x.data_points||{};
      return s+Object.values(d).map(Number).filter(Number.isFinite).reduce((a,v)=>a+Math.min(v,10),0);
    },0);
    const missing=ids.filter(id=>!agents.has(id));
    out[family]={
      score:Number(avg(scores,50).toFixed(1)),
      count:rows.length,
      spread:Number(spread.toFixed(1)),
      coherence:Number(clamp(100-spread*1.9).toFixed(1)),
      evidence:Number(Math.min(100,evidence*3).toFixed(1)),
      missing
    };
  }
  return out;
}

function snapshot(candidate,verdict,families){
  const surge=candidate?.surge_fingerprint||{};
  const fast=candidate?.fast_impulse_context||{};
  const pre=num(candidate?.pre_move_context?.score,num(candidate?.pre_breakout_fingerprint?.score,50));
  const early=num(surge.early_score,50);
  const ignition=num(surge.ignition_score,50);
  const participation=num(surge.participation_score,50);
  const breakout=num(fast?.scores?.breakout,num(verdict?.decision?.score,50));
  const momentum=num(fast?.scores?.momentum,verdict?.decision?.score??50);
  const compression=num(candidate?.pre_breakout_fingerprint?.evidence?.compression?.score,
    num(candidate?.pre_move_context?.compression_score,families.VOLATILITY?.score));
  const relative=num(candidate?.pre_breakout_fingerprint?.evidence?.relative_power?.score,
    families.RELATIVE?.score);
  const structure=families.STRUCTURE?.score??50;
  const flow=families.PARTICIPATION?.score??50;
  const liquidity=num(candidate?.liquidity_quality,families.PARTICIPATION?.score);
  const dataQuality=num(candidate?.data_quality,0);
  const trapRisk=num(candidate?.pre_breakout_fingerprint?.trapRisk,
    50 + num(candidate?.risk_flags?.length,0)*8 + Math.max(0,Math.abs(num(candidate?.price_change_24h,0))-8)*2);
  const change=Math.abs(num(candidate?.price_change_24h,0));
  const nearHigh=num(candidate?.surge_fingerprint?.near_high_score,50);
  const agentAgreement=avg(Object.values(families).map(x=>x.coherence),50);
  const clusterHits=Object.values(families).filter(x=>x.count>=1&&x.score>=68).length;
  return {pre,early,ignition,participation,breakout,momentum,compression,relative,structure,flow,liquidity,dataQuality,trapRisk,change,nearHigh,agentAgreement,clusterHits};
}

function antiChaseScore(s){
  const base=s.change<=1.5?96:s.change<=3?90:s.change<=5?82:s.change<=8?67:s.change<=12?48:28;
  const highPenalty=s.nearHigh>=92?s.change>6?15:7:0;
  const ignitionPenalty=s.ignition>=88&&s.early<72?12:0;
  return clamp(base-highPenalty-ignitionPenalty);
}

function failureRiskScore(s){
  let r=clamp(s.trapRisk);
  r+=Math.max(0,65-s.agentAgreement)*.32;
  r+=Math.max(0,60-s.structure)*.18;
  r+=Math.max(0,60-s.relative)*.10;
  r+=Math.max(0,60-s.liquidity)*.12;
  r+=Math.max(0,70-s.dataQuality)*.20;
  r+=s.change>12?(s.change-12)*2.2:s.change>8?(s.change-8)*1.1:0;
  if(s.breakout>=86&&s.structure<58)r+=10;
  return clamp(r);
}

function stageFor(s,score,antiChase,failure){
  if(failure>=72||s.dataQuality<55||s.liquidity<45)return 'REJECT';
  if(antiChase<45&&s.change>8)return 'LATE_CHASE';
  if(s.ignition>=82&&s.breakout>=78)return 'TRIGGER_WINDOW';
  if(score>=78&&s.pre>=72)return 'PRE_MOVE';
  if(score>=62&&s.pre>=58)return 'BUILDING';
  return 'WATCH';
}

export function evaluateSupremeFusion({candidate={},verdict={},previous=null}={}){
  const agents=getAgentMap(verdict);
  const families=familyReadings(agents);
  const s=snapshot(candidate,verdict,families);
  const antiChase=antiChaseScore(s);
  const failureRisk=failureRiskScore(s);

  const earlyEdge=clamp(
    s.pre*.28+
    s.early*.18+
    s.structure*.14+
    s.compression*.10+
    s.relative*.10+
    s.flow*.10+
    antiChase*.10
  );
  const confirmation=clamp(
    s.ignition*.25+
    s.momentum*.18+
    s.participation*.15+
    s.breakout*.16+
    families.STRUCTURE.score*.10+
    families.PARTICIPATION.score*.08+
    families.RELATIVE.score*.08
  );
  const familyQuality=clamp(
    avg(Object.values(families).map(x=>x.score),50)*.65+
    s.agentAgreement*.35
  );
  const dataTrust=clamp(s.dataQuality*.70+s.liquidity*.20+Math.min(100,s.clusterHits*14)*.10);
  const historyAdjustment=clamp(50+(num(verdict?.learning?.weights?.HISTORY_LEARNER,1)-1)*100);
  const raw=s.pre*.18+s.early*.12+s.ignition*.13+s.structure*.10+s.compression*.07+s.relative*.08+
    s.flow*.07+s.liquidity*.06+confirmation*.09+familyQuality*.07+dataTrust*.03+historyAdjustment*.02+transitionScore*.03;
  const penalties=Math.max(0,failureRisk-35)*.45+Math.max(0,65-antiChase)*.22+
    (s.clusterHits<4? (4-s.clusterHits)*4:0);
  const supremeScore=clamp(raw-penalties);
  const stage=stageFor(s,supremeScore,antiChase,failureRisk);
  const direction=String(candidate?.direction||verdict?.decision?.direction||'NEUTRAL').toUpperCase();
  const bullish=direction.includes('BUY')||direction.includes('LONG')||direction.includes('UP');
  const hardReject=!bullish||s.dataQuality<65||s.liquidity<50||failureRisk>=72||antiChase<35;
  const eligible=!hardReject&&['PRE_MOVE','TRIGGER_WINDOW','BUILDING'].includes(stage)&&supremeScore>=84&&
    earlyEdge>=70&&familyQuality>=62&&dataTrust>=68&&s.clusterHits>=4&&failureRisk<48;
  const tier=eligible?(supremeScore>=93?'S+':supremeScore>=88?'S':'A+'):
    stage==='LATE_CHASE'?'REJECT_LATE':stage==='REJECT'?'REJECT':supremeScore>=72?'WATCH_STRONG':'WATCH';

  const riskFlags=[];
  if(failureRisk>=55)riskFlags.push('FAILURE_RISK_ELEVATED');
  if(s.change>8)riskFlags.push('EXTENDED_MOVE');
  if(antiChase<60)riskFlags.push('ANTI_CHASE_WARNING');
  if(s.clusterHits<4)riskFlags.push('LOW_EVIDENCE_DIVERSITY');
  if(s.agentAgreement<60)riskFlags.push('ANALYST_DISAGREEMENT');
  if(s.structure<55)riskFlags.push('STRUCTURE_WEAK');
  if(s.liquidity<60)riskFlags.push('LIQUIDITY_WEAK');
  if(s.dataQuality<75)riskFlags.push('DATA_TRUST_BELOW_ELITE');

  const positive=uniq([
    s.pre>=72?'PRE_MOVE_FINGERPRINT':null,
    s.compression>=70?'COMPRESSION_SETUP':null,
    s.structure>=70?'STRUCTURE_SUPPORT':null,
    s.relative>=70?'RELATIVE_STRENGTH':null,
    s.flow>=70?'FLOW_PARTICIPATION':null,
    s.ignition>=76?'IGNITION_BUILDING':null,
    s.breakout>=76?'BREAKOUT_PRESSURE':null,
    antiChase>=80?'EARLY_ENTRY_WINDOW':null,
    s.clusterHits>=5?'MULTI_FAMILY_CONFLUENCE':null
  ]);
  const negative=uniq([
    failureRisk>=55?'FAILURE_RISK_ELEVATED':null,
    s.change>8?'MOVE_ALREADY_EXTENDED':null,
    s.nearHigh>=92&&s.change>5?'NEAR_HIGH_AFTER_MOVE':null,
    s.structure<55?'WEAK_STRUCTURE':null,
    s.relative<45?'RELATIVE_POWER_WEAK':null,
    s.liquidity<60?'LIQUIDITY_NOT_ELITE':null,
    s.dataQuality<75?'DATA_QUALITY_NOT_ELITE':null
  ]);

  const momentumDelta=previous?supremeScore-num(previous.supreme_score,supremeScore):0;
  const transitionScore=clamp(50+momentumDelta*5);
  const transition=momentumDelta>=4?'ACCELERATING':momentumDelta<=-4?'DECELERATING':'STABLE';
  const action=eligible?'PAPER_ENTRY_CANDIDATE':
    hardReject?'SPOT_AVOID':
    stage==='LATE_CHASE'?'WAIT_CONFIRMATION':
    supremeScore>=76?'PAPER_WATCH':'WAIT_CONFIRMATION';

  return {
    engine:'RADARX_SUPREME_FUSION_V1',
    engine_name:'🧠⚡ Supreme Fusion — بصمة ما قبل الحركة',
    score:Number(supremeScore.toFixed(1)),
    tier,stage,direction,
    eligible,
    action,
    early_edge_score:Number(earlyEdge.toFixed(1)),
    confirmation_score:Number(confirmation.toFixed(1)),
    failure_risk:Number(failureRisk.toFixed(1)),
    anti_chase_score:Number(antiChase.toFixed(1)),
    family_quality:Number(familyQuality.toFixed(1)),
    data_trust:Number(dataTrust.toFixed(1)),
    cluster_hits:s.clusterHits,
    analyst_agreement:Number(s.agentAgreement.toFixed(1)),
    momentum_delta:Number(momentumDelta.toFixed(1)),
    transition_score:Number(transitionScore.toFixed(1)),
    transition,
    families,
    snapshot:s,
    positive_reasons:positive,
    risk_flags:riskFlags,
    negative_reasons:negative,
    timing:{
      mode:stage==='PRE_MOVE'?'EARLY':
        stage==='TRIGGER_WINDOW'?'TRIGGER':
        stage==='LATE_CHASE'?'LATE':'BUILD',
      chase_protection:antiChase>=70?'PROTECTED':antiChase>=55?'CAUTION':'BLOCK'
    },
    policy:{
      spot_only:true,paper_trading:true,real_order_execution:false,
      confidence_score:'UNKNOWN',confidence_state:'UNCALIBRATED',
      no_guaranteed_probability:true,closed_candles_only:true
    }
  };
}

export function rankSupremeCandidates(rows=[],{limit=20}={}){
  return [...(Array.isArray(rows)?rows:[])]
    .filter(Boolean)
    .sort((a,b)=>Number(b?.supreme_fusion?.score??-1)-Number(a?.supreme_fusion?.score??-1) ||
      Number(b?.supreme_fusion?.early_edge_score??-1)-Number(a?.supreme_fusion?.early_edge_score??-1) ||
      Number(a?.price_change_24h??0)-Number(b?.price_change_24h??0))
    .slice(0,Math.max(1,Math.min(50,Math.trunc(limit)||20)));
}

export function buildSupremeMarketState(decisions=[],{limit=20}={}){
  const rows=rankSupremeCandidates(decisions,{limit});
  const eligible=rows.filter(x=>x?.supreme_fusion?.eligible);
  return {
    engine:'RADARX_SUPREME_FUSION_V1',
    as_of:new Date().toISOString(),
    top:rows.map(x=>({
      symbol:x.symbol,
      score:x.supreme_fusion.score,
      tier:x.supreme_fusion.tier,
      stage:x.supreme_fusion.stage,
      action:x.supreme_fusion.action,
      early_edge:x.supreme_fusion.early_edge_score,
      failure_risk:x.supreme_fusion.failure_risk,
      anti_chase:x.supreme_fusion.anti_chase_score
    })),
    eligible_count:eligible.length,
    paper_only:true
  };
}
