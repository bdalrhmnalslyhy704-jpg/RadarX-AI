import {appendFile,readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyVersionedModelArtifact} from './model-artifact-guardian.mjs';
import {
  canonicalJson,sha256Canonical,NEURAL_CLOSURE_TARGET_DEFINITION,
  NEURAL_CLOSURE_HORIZON_MS,NEURAL_CLOSURE_OUTCOME_SOURCE
} from './neural-closure-contracts.mjs';

export const NEURAL_SHADOW_OBSERVATION_DAYS=14;
export const NEURAL_SHADOW_OBSERVATION_MS=NEURAL_SHADOW_OBSERVATION_DAYS*24*60*60*1000;
const finite=value=>value!==null&&value!==undefined&&value!==''&&
  typeof value!=='boolean'&&Number.isFinite(Number(value));
const sigmoid=value=>1/(1+Math.exp(-Math.max(-35,Math.min(35,value))));

async function appendRecord(ledgerPath,record){
  if(typeof ledgerPath!=='string'||!ledgerPath.trim())
    throw new TypeError('NEURAL_SHADOW_LEDGER_PATH_REQUIRED');
  const path=resolve(ledgerPath);
  const existing=await readLedger(path);
  const previous=existing.at(-1)?.event_sha256||'0'.repeat(64);
  const unsigned={...record,previous_event_sha256:previous};
  const chained={...unsigned,event_sha256:sha256Canonical(unsigned)};
  await mkdir(dirname(path),{recursive:true});
  await appendFile(path,canonicalJson(chained)+'\\n',{encoding:'utf8',flag:'a'});
}
async function readLedger(ledgerPath){
  if(typeof ledgerPath!=='string'||!ledgerPath.trim())
    throw new TypeError('NEURAL_SHADOW_LEDGER_PATH_REQUIRED');
  let raw;
  try{raw=await readFile(resolve(ledgerPath),'utf8');}
  catch(error){if(error?.code==='ENOENT')return [];throw error;}
  const events=[];
  let previous='0'.repeat(64);
  for(const [index,line] of raw.split(/\\r?\\n/).entries()){
    if(!line.trim())continue;
    try{
      const event=JSON.parse(line);
      const declared=String(event.event_sha256||'');
      if(event.previous_event_sha256!==previous)
        throw new Error('HASH_CHAIN_PREVIOUS_SHA_MISMATCH');
      const unsigned={...event};delete unsigned.event_sha256;
      if(sha256Canonical(unsigned)!==declared)
        throw new Error('HASH_CHAIN_EVENT_SHA_MISMATCH');
      previous=declared;events.push(event);
    }catch(error){
      throw new Error('NEURAL_SHADOW_LEDGER_CORRUPT_LINE:'+String(index+1)+':'+
        String(error?.message||error));
    }
  }
  return events;
}

function assertSafeSession(session){
  if(!session||session.schema!=='RADARX_PAPER_ONLY_NEURAL_SHADOW_SESSION_V1')
    throw new TypeError('NEURAL_SHADOW_SESSION_INVALID');
  if(session.target_definition!==NEURAL_CLOSURE_TARGET_DEFINITION||
    session.horizon_ms!==NEURAL_CLOSURE_HORIZON_MS)
    throw new Error('NEURAL_SHADOW_SESSION_TARGET_MISMATCH');
  if(session.paper_trading!==true||session.real_order_execution!==false||
    session.market!=='BINANCE_SPOT_ONLY')
    throw new Error('NEURAL_SHADOW_EXECUTION_POLICY_UNSAFE');
}
function assertInsideSession(session,now){
  const at=Number(now);
  if(!finite(at)||at<session.started_at||at>session.ends_at)
    throw new Error('NEURAL_SHADOW_TIMESTAMP_OUTSIDE_14_DAY_WINDOW');
}

export function createNeuralShadowObservationSession({
  modelArtifact,startedAt=Date.now(),observationDays=NEURAL_SHADOW_OBSERVATION_DAYS
}={}){
  const verified=verifyVersionedModelArtifact(modelArtifact);
  if(!verified.valid)throw new Error('NEURAL_SHADOW_MODEL_ARTIFACT_INVALID:'+verified.reason);
  if(observationDays!==NEURAL_SHADOW_OBSERVATION_DAYS)
    throw new Error('NEURAL_SHADOW_DURATION_MUST_BE_EXACTLY_14_DAYS');
  if(!finite(startedAt)||Number(startedAt)<=0)
    throw new TypeError('NEURAL_SHADOW_START_TIME_INVALID');
  const sessionBase={
    schema:'RADARX_PAPER_ONLY_NEURAL_SHADOW_SESSION_V1',
    model_name:verified.model_name,model_family:verified.model_family,
    model_version:verified.model_version,
    source_commit_sha:verified.source_commit_sha,
    model_artifact_sha256:verified.artifact_sha256,
    feature_schema_id:modelArtifact.feature_schema_id,
    feature_schema_sha256:sha256Canonical({
      feature_schema_id:modelArtifact.feature_schema_id,
      feature_names:modelArtifact.feature_names,
      feature_index_map:modelArtifact.feature_index_map,
      mean:modelArtifact.normalization.mean,std:modelArtifact.normalization.std
    }),
    target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
    outcome_source:NEURAL_CLOSURE_OUTCOME_SOURCE,
    horizon_ms:NEURAL_CLOSURE_HORIZON_MS,
    started_at:Number(startedAt),
    ends_at:Number(startedAt)+NEURAL_SHADOW_OBSERVATION_MS,
    observation_days:NEURAL_SHADOW_OBSERVATION_DAYS,
    paper_trading:true,real_order_execution:false,market:'BINANCE_SPOT_ONLY',
    execution_mode:'SHADOW_PREDICTIONS_ONLY_NO_ORDERS',
    status:'READY_TO_START',
    promotion_policy:'MANUAL_REVIEW_REQUIRED_AFTER_14_DAYS'
  };
  return {...sessionBase,session_id:sha256Canonical(sessionBase)};
}

export async function startNeuralShadowObservation(session,{ledgerPath}={}){
  assertSafeSession(session);
  const events=await readLedger(ledgerPath);
  if(events.some(event=>event.type==='SESSION_STARTED'&&event.session_id===session.session_id))
    throw new Error('NEURAL_SHADOW_SESSION_ALREADY_STARTED');
  const event={type:'SESSION_STARTED',session_id:session.session_id,
    started_at:session.started_at,ends_at:session.ends_at,
    model_artifact_sha256:session.model_artifact_sha256,
    source_commit_sha:session.source_commit_sha,
    paper_trading:true,real_order_execution:false,market:'BINANCE_SPOT_ONLY'};
  await appendRecord(ledgerPath,event);
  return {...session,status:'OBSERVING'};
}

export async function recordNeuralShadowPrediction(session,guardian,packet,{
  ledgerPath,now=Date.now(),predictor
}={}){
  assertSafeSession(session);assertInsideSession(session,now);
  if(!guardian||typeof guardian.predict!=='function')
    throw new TypeError('NEURAL_SHADOW_FEATURE_GUARDIAN_REQUIRED');
  if(packet?.model_artifact_sha256!==session.model_artifact_sha256)
    throw new Error('NEURAL_SHADOW_ARTIFACT_SHA_MISMATCH');
  const symbol=String(packet.symbol||'').trim().toUpperCase();
  const eventId=String(packet.event_id||'').trim();
  if(!symbol||!eventId)throw new TypeError('NEURAL_SHADOW_EVENT_ID_OR_SYMBOL_MISSING');
  const prediction=guardian.predict(packet,predictor);
  if(!finite(prediction.probability)||prediction.probability<0||prediction.probability>1)
    throw new Error('NEURAL_SHADOW_PREDICTION_INVALID');
  const decisionAt=Number(prediction.decision_at);
  const predictionId=sha256Canonical({
    session_id:session.session_id,event_id:eventId,symbol,
    decision_at:decisionAt,model_artifact_sha256:session.model_artifact_sha256
  });
  const events=await readLedger(ledgerPath);
  if(events.some(event=>event.type==='PREDICTION'&&event.prediction_id===predictionId))
    throw new Error('NEURAL_SHADOW_DUPLICATE_PREDICTION');
  const record={
    type:'PREDICTION',session_id:session.session_id,prediction_id:predictionId,
    event_id:eventId,symbol,decision_at:decisionAt,
    probability:prediction.probability,
    feature_schema_sha256:prediction.feature_schema_sha256,
    model_artifact_sha256:session.model_artifact_sha256,
    target_definition:session.target_definition,
    paper_trading:true,real_order_execution:false,
    execution_action:'NONE'
  };
  await appendRecord(ledgerPath,record);
  return record;
}

export async function recordNeuralShadowOutcome(session,{
  predictionId,outcome,resolvedAt,outcomeSource=NEURAL_CLOSURE_OUTCOME_SOURCE
}={},{
  ledgerPath,now=Date.now()
}={}){
  assertSafeSession(session);
  if(!['UP','DOWN','FLAT'].includes(outcome))
    throw new TypeError('NEURAL_SHADOW_OUTCOME_INVALID');
  if(outcomeSource!==session.outcome_source)
    throw new Error('NEURAL_SHADOW_OUTCOME_SOURCE_MISMATCH');
  if(!finite(resolvedAt)||!finite(now)||Number(resolvedAt)>Number(now))
    throw new Error('NEURAL_SHADOW_OUTCOME_NOT_MATURED');
  const events=await readLedger(ledgerPath);
  const prediction=events.find(event=>event.type==='PREDICTION'&&
    event.session_id===session.session_id&&event.prediction_id===predictionId);
  if(!prediction)throw new Error('NEURAL_SHADOW_PREDICTION_NOT_FOUND');
  if(Number(resolvedAt)-Number(prediction.decision_at)!==NEURAL_CLOSURE_HORIZON_MS)
    throw new Error('NEURAL_SHADOW_OUTCOME_HORIZON_MISMATCH');
  if(events.some(event=>event.type==='OUTCOME'&&event.prediction_id===predictionId))
    throw new Error('NEURAL_SHADOW_DUPLICATE_OUTCOME');
  const record={
    type:'OUTCOME',session_id:session.session_id,prediction_id:predictionId,
    event_id:prediction.event_id,symbol:prediction.symbol,
    decision_at:prediction.decision_at,resolved_at:Number(resolvedAt),
    target:outcome==='UP'?1:0,outcome,
    target_definition:session.target_definition,
    outcome_source:outcomeSource,
    paper_trading:true,real_order_execution:false,execution_action:'NONE'
  };
  await appendRecord(ledgerPath,record);
  return record;
}

export async function summarizeNeuralShadowObservation(session,{
  ledgerPath,now=Date.now()
}={}){
  assertSafeSession(session);
  const events=await readLedger(ledgerPath);
  const sessionEvents=events.filter(event=>event.session_id===session.session_id);
  const start=sessionEvents.find(event=>event.type==='SESSION_STARTED');
  if(!start)throw new Error('NEURAL_SHADOW_SESSION_START_NOT_FOUND');
  const predictions=sessionEvents.filter(event=>event.type==='PREDICTION');
  const outcomes=sessionEvents.filter(event=>event.type==='OUTCOME');
  const outcomeById=new Map(outcomes.map(event=>[event.prediction_id,event]));
  const matched=predictions.filter(event=>outcomeById.has(event.prediction_id));
  const duplicatePredictionIds=new Set();
  const seen=new Set();
  for(const event of predictions){
    if(seen.has(event.prediction_id))duplicatePredictionIds.add(event.prediction_id);
    seen.add(event.prediction_id);
  }
  const brier=matched.length?matched.reduce((sum,event)=>{
    const outcome=outcomeById.get(event.prediction_id);
    return sum+(Number(event.probability)-Number(outcome.target))**2;
  },0)/matched.length:null;
  const elapsed=Math.max(0,Math.min(Number(now),session.ends_at)-session.started_at);
  const durationComplete=Number(now)>=session.ends_at;
  const allPredictionsMatured=matched.length===predictions.length;
  const status=!durationComplete?'OBSERVING':
    allPredictionsMatured&&duplicatePredictionIds.size===0
      ?'COMPLETE_REVIEW_REQUIRED':'COMPLETE_WITH_UNMATURED_OR_DUPLICATE_EVENTS';
  return {
    schema:'RADARX_NEURAL_SHADOW_OBSERVATION_REPORT_V1',
    session_id:session.session_id,model_artifact_sha256:session.model_artifact_sha256,
    source_commit_sha:session.source_commit_sha,
    started_at:session.started_at,ends_at:session.ends_at,
    elapsed_ms:elapsed,required_observation_ms:NEURAL_SHADOW_OBSERVATION_MS,
    duration_complete:durationComplete,
    predictions:predictions.length,matured_outcomes:matched.length,
    unmatched_predictions:predictions.length-matched.length,
    positive_outcomes:matched.filter(event=>outcomeById.get(event.prediction_id).target===1).length,
    negative_outcomes:matched.filter(event=>outcomeById.get(event.prediction_id).target===0).length,
    duplicate_prediction_ids:duplicatePredictionIds.size,
    brier_score:brier,
    status,
    promotion_ready:false,
    manual_review_required:true,
    policy:{paper_trading:true,real_order_execution:false,
      market:'BINANCE_SPOT_ONLY',live_orders_sent:0,execution_action:'NONE'}
  };
}
