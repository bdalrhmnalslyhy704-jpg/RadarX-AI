import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVersionedModelArtifact} from '../core/model-artifact-guardian.mjs';
import {createFeatureParityGuardian,buildFeatureSchemaFingerprint}
  from '../core/feature-parity-guardian.mjs';
import {
  createNeuralShadowObservationSession,startNeuralShadowObservation,
  recordNeuralShadowPrediction,recordNeuralShadowOutcome,
  summarizeNeuralShadowObservation,NEURAL_SHADOW_OBSERVATION_MS
} from '../core/neural-shadow-observation.mjs';
import {NEURAL_CLOSURE_TARGET_DEFINITION} from '../core/neural-closure-contracts.mjs';

const START=1_780_000_000_000;
function modelArtifact(){
  return createVersionedModelArtifact({
    modelName:'Shadow-Test',modelFamily:'TCN_V11',modelVersion:'1.0.0',
    sourceCommitSha:'e'.repeat(40),targetDefinition:NEURAL_CLOSURE_TARGET_DEFINITION,
    featureSchemaId:'SHADOW_TEST_SCHEMA_V1',
    featureNames:['momentum','buyer_flow'],
    featureIndexMap:{momentum:0,buyer_flow:1},
    normalization:{mean:[0,0],std:[1,1]},
    modelState:{weights:[0.1,0.2],bias:0}
  });
}
function livePacket(manifest,eventId,at){
  return {
    event_id:eventId,symbol:'BTCUSDT',
    model_artifact_sha256:manifest.artifact_sha256,
    feature_schema_id:manifest.feature_schema_id,
    feature_schema_sha256:buildFeatureSchemaFingerprint(manifest),
    feature_names:manifest.feature_names,
    feature_index_map:manifest.feature_index_map,
    values:[0.2,0.4],candle_is_closed:true,
    candle_open_at:at-60_000,candle_close_at:at,decision_at:at
  };
}
async function tempLedger(){
  const folder=await mkdtemp(join(tmpdir(),'radarx-shadow-'));
  return {folder,path:join(folder,'shadow.jsonl')};
}

test('14-day observation records only paper predictions and matured 4h outcomes',async()=>{
  const manifest=modelArtifact();
  const guardian=createFeatureParityGuardian(manifest);
  const session=createNeuralShadowObservationSession({
    modelArtifact:manifest,startedAt:START,observationDays:14
  });
  assert.equal(session.ends_at-session.started_at,NEURAL_SHADOW_OBSERVATION_MS);
  assert.equal(session.paper_trading,true);
  assert.equal(session.real_order_execution,false);
  const ledger=await tempLedger();
  try{
    const active=await startNeuralShadowObservation(session,{ledgerPath:ledger.path});
    assert.equal(active.status,'OBSERVING');
    const prediction=await recordNeuralShadowPrediction(
      session,guardian,livePacket(manifest,'event-1',START+60_000),{
        ledgerPath:ledger.path,now:START+60_000,predictor:()=>0.7
      });
    assert.equal(prediction.probability,0.7);
    assert.equal(prediction.execution_action,'NONE');
    const resolvedAt=prediction.decision_at+4*60*60*1000;
    const outcome=await recordNeuralShadowOutcome(session,{
      predictionId:prediction.prediction_id,outcome:'UP',resolvedAt
    },{ledgerPath:ledger.path,now:resolvedAt});
    assert.equal(outcome.target,1);
    const during=await summarizeNeuralShadowObservation(session,{
      ledgerPath:ledger.path,now:session.ends_at-1
    });
    assert.equal(during.status,'OBSERVING');
    const completed=await summarizeNeuralShadowObservation(session,{
      ledgerPath:ledger.path,now:session.ends_at+4*60*60*1000
    });
    assert.equal(completed.status,'COMPLETE_REVIEW_REQUIRED');
    assert.equal(completed.predictions,1);
    assert.equal(completed.matured_outcomes,1);
    assert.equal(completed.brier_score,0.09);
    assert.equal(completed.promotion_ready,false);
    assert.equal(completed.policy.live_orders_sent,0);
    assert.equal(completed.policy.real_order_execution,false);
  }finally{await rm(ledger.folder,{recursive:true,force:true});}
});

test('observation cannot change duration, target or execution policy',()=>{
  const manifest=modelArtifact();
  assert.throws(()=>createNeuralShadowObservationSession({
    modelArtifact:manifest,startedAt:START,observationDays:7
  }),/EXACTLY_14_DAYS/);
  const session=createNeuralShadowObservationSession({modelArtifact:manifest,startedAt:START});
  assert.throws(()=>summarizeNeuralShadowObservation({
    ...session,real_order_execution:true
  },{ledgerPath:'/tmp/not-used',now:START}),/EXECUTION_POLICY_UNSAFE/);
});

test('tampered JSONL event is detected by the append-only hash chain',async()=>{
  const manifest=modelArtifact();
  const session=createNeuralShadowObservationSession({modelArtifact:manifest,startedAt:START});
  const ledger=await tempLedger();
  try{
    await startNeuralShadowObservation(session,{ledgerPath:ledger.path});
    const raw=await readFile(ledger.path,'utf8');
    await writeFile(ledger.path,raw.replace('SESSION_STARTED','SESSION_TAMPERED'));
    await assert.rejects(startNeuralShadowObservation(session,{ledgerPath:ledger.path}),
      /LEDGER_CORRUPT_LINE.*HASH_CHAIN_EVENT_SHA_MISMATCH/);
  }finally{await rm(ledger.folder,{recursive:true,force:true});}
});
