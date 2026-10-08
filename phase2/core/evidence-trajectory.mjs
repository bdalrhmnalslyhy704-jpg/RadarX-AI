const clamp=(v,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number.isFinite(Number(v))?Number(v):0));
const num=(v,d=50)=>Number.isFinite(Number(v))?Number(v):d;

const MAX_POINTS=6;
const WINDOW_MS=14*60*1000;
const memory=new Map();

const paths={
  structure:['falcon_eye.domains.structure','components.structure_score','pre_breakout_fingerprint.structure_score'],
  flow:['falcon_eye.domains.flow','components.flow_score','components.buying_pressure','pre_breakout_fingerprint.pressure_score'],
  participation:['falcon_eye.domains.participation','move_forensics.ignition_score','components.volume','components.trades'],
  momentum:['falcon_eye.domains.momentum','move_forensics.ignition_score','components.momentum','momentum_score'],
  relative:['falcon_eye.domains.relative','move_forensics.rotation_score','components.relative_strength','pre_breakout_fingerprint.relative_strength_score'],
  compression:['falcon_eye.domains.volatility','move_forensics.compression_score','pre_breakout_fingerprint.compression_score'],
  liquidity:['falcon_eye.domains.liquidity','liquidity_quality','components.liquidity'],
  timing:['falcon_eye.capture','move_forensics.anti_late_score','pre_breakout_fingerprint.anti_chase_score']
};

function nested(obj,path){
  let x=obj;
  for(const k of String(path).split('.')){if(x==null)return null;x=x[k];}
  return x;
}

function pick(alert,keys){
  for(const p of keys){
    const n=Number(nested(alert,p));
    if(Number.isFinite(n))return n;
  }
  return null;
}

function snapshot(alert,now){
  const fields={};
  for(const [key,ks] of Object.entries(paths))fields[key]=clamp(pick(alert,ks)??50);
  const radar=String(alert?.radar||'UNKNOWN').toUpperCase();
  const symbol=String(alert?.symbol||'').trim().toUpperCase();
  const sourceStamp=String(alert?.processed_at??alert?.detected_at??alert?.as_of??'');
  const fingerprint=Object.values(fields).map(x=>Number(x.toFixed(1))).join(',');
  const id=sourceStamp||fingerprint;
  return {symbol,radar,id,at:Number(now)||Date.now(),fields};
}

function average(values,fallback=50){
  const xs=values.map(Number).filter(Number.isFinite);
  return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:fallback;
}

export function observeEvidenceTrajectory(alert={},now=Date.now()){
  const point=snapshot(alert,now);
  if(!point.symbol)return {version:'EVIDENCE_TRAJECTORY_V1',observed:false,quality:50,persistence:0,delta:0,improving_domains:0,degrading_domains:0,convergence:50,regime:'UNKNOWN'};
  const key=point.symbol+'|'+point.radar;
  const prev=memory.get(key)||[];
  const existing=prev.find(x=>x.id===point.id);
  let series=existing?[...prev]:[...prev,point];
  series=series.filter(x=>point.at-x.at<=WINDOW_MS).sort((a,b)=>a.at-b.at).slice(-MAX_POINTS);
  if(!existing)memory.set(key,series);

  const history=series;
  const previous=history.length>=2?history[history.length-2]:null;
  const deltas=previous?Object.keys(point.fields).map(k=>point.fields[k]-previous.fields[k]):[];
  const improving=deltas.filter(x=>x>=3).length;
  const degrading=deltas.filter(x=>x<=-3).length;
  const flat=deltas.filter(x=>Math.abs(x)<3).length;
  const delta=average(deltas,0);
  const positiveSteps=history.slice(1).reduce((n,p,i)=>{
    const prior=history[i];
    const ds=Object.keys(p.fields).map(k=>p.fields[k]-prior.fields[k]);
    return n+(average(ds,0)>=2?1:0);
  },0);
  const currentAverage=average(Object.values(point.fields),50);
  const earlySupport=average([
    point.fields.structure,
    point.fields.flow,
    point.fields.participation,
    point.fields.relative,
    point.fields.compression
  ],50);
  const convergence=clamp(
    42+
    Math.max(0,improving-degrading)*7+
    Math.max(0,currentAverage-60)*.5+
    Math.max(0,Math.min(3,positiveSteps))*6-
    Math.max(0,degrading-improving)*8
  );

  const quality=clamp(
    50+
    Math.max(-12,Math.min(12,delta))*2.2+
    improving*4+
    positiveSteps*4+
    Math.max(0,earlySupport-62)*.35-
    degrading*5-
    Math.max(0,55-currentAverage)*.4
  );

  const regime=
    degrading>=Math.max(3,improving+2)?'DETERIORATING':
    improving>=4&&quality>=72?'IGNITING':
    improving>=2&&convergence>=68?'BUILDING':
    history.length>=3&&Math.abs(delta)<2?'STABLE':
    quality>=68?'SUPPORTED':'UNPROVEN';

  return {
    version:'EVIDENCE_TRAJECTORY_V1',
    observed:true,
    persistence:history.length,
    window_ms:WINDOW_MS,
    quality:Number(quality.toFixed(1)),
    convergence:Number(convergence.toFixed(1)),
    delta:Number(delta.toFixed(2)),
    current_strength:Number(currentAverage.toFixed(1)),
    early_support:Number(earlySupport.toFixed(1)),
    improving_domains:improving,
    degrading_domains:degrading,
    flat_domains:flat,
    positive_steps:positiveSteps,
    regime,
    domains:Object.fromEntries(Object.entries(point.fields).map(([k,v])=>[k,Number(v.toFixed(1))])),
    as_of:new Date(point.at).toISOString()
  };
}

export function trajectoryPenalty(tr={}) {
  if(!tr?.observed)return 0;
  if(tr.regime==='DETERIORATING')return Math.min(18,8+Number(tr.degrading_domains||0)*2);
  if(Number(tr.quality)<55)return 8;
  return 0;
}

export function trajectoryBonus(tr={}) {
  if(!tr?.observed)return 0;
  if(tr.regime==='IGNITING')return 8;
  if(tr.regime==='BUILDING')return 5;
  if(Number(tr.persistence)>=3&&Number(tr.convergence)>=72)return 3;
  return 0;
}

export function resetEvidenceTrajectoryForTests(){memory.clear();}
export function evidenceTrajectoryHealth(){return {tracked_keys:memory.size,window_ms:WINDOW_MS,max_points:MAX_POINTS,mode:'IN_MEMORY_IDEMPOTENT'};}
