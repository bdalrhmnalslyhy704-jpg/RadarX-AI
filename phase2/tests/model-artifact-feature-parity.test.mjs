import test from 'node:test';
import assert from 'node:assert/strict';
import {createVersionedModelArtifact,verifyVersionedModelArtifact}
  from '../core/model-artifact-guardian.mjs';
import {buildFeatureSchemaFingerprint,createFeatureParityGuardian,FeatureParityError}
  from '../core/feature-parity-guardian.mjs';
import {NEURAL_CLOSURE_TARGET_DEFINITION} from '../core/neural-closure-contracts.mjs';

function artifact(){
  return createVersionedModelArtifact({
    modelName:'TCN_V11_TEST',modelFamily:'TCN_V11',modelVersion:'1.0.0',
    sourceCommitSha:'c'.repeat(40),
    featureSchemaId:'RADARX_TEST_FEATURES_V1',
    targetDefinition:NEURAL_CLOSURE_TARGET_DEFINITION,
    featureNames:['momentum','buyer_flow','kama_er'],
    featureIndexMap:{momentum:0,buyer_flow:1,kama_er:2},
    normalization:{mean:[1,1,0.5],std:[1,2,0.25]},
    modelState:{projection:[[0.1,0.2],[0.3,0.4]],bias:[0.01,0.02]},
    trainingReportSha256:'d'.repeat(64)
  });
}
function packet(manifest,overrides={}){
  const values=[1,2,1];
  const normalized=values.map((value,index)=>
    (value-manifest.normalization.mean[index])/manifest.normalization.std[index]);
  return {
    feature_schema_id:manifest.feature_schema_id,
    feature_schema_sha256:buildFeatureSchemaFingerprint(manifest),
    feature_names:[...manifest.feature_names],
    feature_index_map:manifest.feature_index_map,
    values,normalized_values:normalized,
    candle_is_closed:true,candle_open_at:100_000,
    candle_close_at:160_000,decision_at:160_000,
    ...overrides
  };
}

test('versioned artifact embeds exact feature mapping and tamper-evident weights',()=>{
  const manifest=artifact();
  assert.match(manifest.weights_sha256,/^[a-f0-9]{64}$/);
  assert.match(manifest.artifact_sha256,/^[a-f0-9]{64}$/);
  assert.equal(manifest.feature_index_map.kama_er,2);
  const verified=verifyVersionedModelArtifact(manifest,{
    expectedSourceCommitSha:'c'.repeat(40)
  });
  assert.equal(verified.valid,true);
  assert.deepEqual(verified.model_state,{projection:[[0.1,0.2],[0.3,0.4]],bias:[0.01,0.02]});
  const changed={...manifest,weights_base64:manifest.weights_base64.slice(0,-4)+'AAAA'};
  assert.equal(verifyVersionedModelArtifact(changed).valid,false);
  const wrongTarget={...manifest,target_definition:'OTHER'};
  assert.equal(verifyVersionedModelArtifact(wrongTarget).reason,
    'MODEL_ARTIFACT_TARGET_MISMATCH');
});

test('runtime feature guardian accepts only the exact closed 1m feature schema and normalization',()=>{
  const manifest=artifact();
  const guardian=createFeatureParityGuardian(manifest,{requireTrainingReference:true});
  const live=packet(manifest);
  const result=guardian.validate(live,{trainingReferenceValues:[1,2,1]});
  assert.equal(result.valid,true);
  assert.deepEqual(result.normalized_values,[0,0.5,2]);
  const predicted=guardian.predict(live,values=>({probability:values[1]}),{trainingReferenceValues:[1,2,1]});
  assert.equal(predicted.probability,0.5);
  assert.equal(guardian.getDiagnostics().accepted,2);
  assert.equal(guardian.getDiagnostics().rejected,0);
});

test('runtime feature guardian aborts on NaN missing fields schema drift and bit mismatch',()=>{
  const manifest=artifact();
  const guardian=createFeatureParityGuardian(manifest);
  assert.throws(()=>guardian.validate(packet(manifest,{values:[1,NaN,1]})),
    error=>error instanceof FeatureParityError&&error.code==='LIVE_FEATURE_VALUE_MISSING_OR_NON_FINITE');
  assert.throws(()=>guardian.validate(packet(manifest,{feature_names:['buyer_flow','momentum','kama_er']})),
    /LIVE_FEATURE_ORDER_OR_MAPPING_MISMATCH/);
  assert.throws(()=>guardian.validate(packet(manifest,{candle_close_at:160_001})),
    /LIVE_ONE_MINUTE_CANDLE_CADENCE_OR_FUTURE_CUTOFF_INVALID/);
  assert.throws(()=>guardian.validate(packet(manifest),{
    trainingReferenceValues:[1,2,1.0000000000000002]
  }),/LIVE_TRAINING_FEATURE_BITWISE_PARITY_FAILURE/);
  assert.equal(guardian.getDiagnostics().rejected,4);
});

test('schema fingerprint changes when feature order or scaler values change',()=>{
  const manifest=artifact();
  const original=buildFeatureSchemaFingerprint(manifest);
  const reordered={...manifest,feature_names:[...manifest.feature_names].reverse()};
  assert.notEqual(buildFeatureSchemaFingerprint(reordered),original);
  const changedScaler={...manifest,normalization:{...manifest.normalization,
    mean:[1,1.01,0.5]}};
  assert.notEqual(buildFeatureSchemaFingerprint(changedScaler),original);
});
