import {canonicalJson,sha256Canonical} from './neural-closure-contracts.mjs';

const finite=value=>value!==null&&value!==undefined&&value!==''&&
  typeof value!=='boolean'&&Number.isFinite(Number(value));
const exactArray=(left,right)=>Array.isArray(left)&&Array.isArray(right)&&
  left.length===right.length&&left.every((value,index)=>value===right[index]);

export class FeatureParityError extends Error {
  constructor(code,details={}){
    super(code);
    this.name='FeatureParityError';
    this.code=code;
    this.details=details;
  }
}
function fail(code,details){throw new FeatureParityError(code,details);}
function float64Bits(value){
  const bytes=Buffer.allocUnsafe(8);
  bytes.writeDoubleLE(Number(value),0);
  return bytes.toString('hex');
}
function assertBitwiseArrayEqual(actual,expected,code){
  if(!Array.isArray(actual)||!Array.isArray(expected)||actual.length!==expected.length)
    fail(code,{expected_length:expected?.length??null,actual_length:actual?.length??null});
  for(let index=0;index<actual.length;index++){
    if(!finite(actual[index])||!finite(expected[index])||
      float64Bits(actual[index])!==float64Bits(expected[index]))
      fail(code,{index,actual:actual[index],expected:expected[index]});
  }
}

export function buildFeatureSchemaFingerprint(manifest){
  if(!manifest||!Array.isArray(manifest.feature_names)||
    !manifest.normalization||!Array.isArray(manifest.normalization.mean)||
    !Array.isArray(manifest.normalization.std))
    throw new TypeError('FEATURE_PARITY_MANIFEST_INCOMPLETE');
  return sha256Canonical({
    feature_schema_id:manifest.feature_schema_id,
    feature_names:manifest.feature_names,
    feature_index_map:manifest.feature_index_map,
    normalization_mean:manifest.normalization.mean,
    normalization_std:manifest.normalization.std
  });
}

/**
 * Fail-closed live adapter for one-minute closed-candle feature packets.
 * Exact schema order and Float64 normalization are pinned by the signed
 * model artifact; this module never imputes or replaces unavailable values.
 */
export function createFeatureParityGuardian(artifactManifest,{
  expectedFeatureSchemaSha256=null,
  requireTrainingReference=false
}={}){
  if(!artifactManifest||artifactManifest.schema!=='RADARX_VERSIONED_NEURAL_MODEL_ARTIFACT_V1')
    throw new TypeError('FEATURE_PARITY_VERSIONED_ARTIFACT_REQUIRED');
  const names=artifactManifest.feature_names;
  const map=artifactManifest.feature_index_map;
  const mean=artifactManifest.normalization?.mean;
  const std=artifactManifest.normalization?.std;
  if(!Array.isArray(names)||!names.length||new Set(names).size!==names.length||
    !Array.isArray(mean)||!Array.isArray(std)||mean.length!==names.length||
    std.length!==names.length)
    throw new TypeError('FEATURE_PARITY_ARTIFACT_FEATURE_CONTRACT_INVALID');
  const expectedMap=Object.fromEntries(names.map((name,index)=>[name,index]));
  if(canonicalJson(map)!==canonicalJson(expectedMap))
    throw new TypeError('FEATURE_PARITY_ARTIFACT_INDEX_MAP_INVALID');
  if(mean.some(value=>!finite(value))||std.some(value=>!finite(value)||Number(value)<=0))
    throw new TypeError('FEATURE_PARITY_ARTIFACT_SCALER_INVALID');
  const fingerprint=buildFeatureSchemaFingerprint(artifactManifest);
  if(expectedFeatureSchemaSha256&&
    fingerprint!==String(expectedFeatureSchemaSha256).toLowerCase())
    throw new TypeError('FEATURE_PARITY_EXPECTED_SCHEMA_FINGERPRINT_MISMATCH');
  let accepted=0,rejected=0;

  function validate(packet,{trainingReferenceValues=null}={}){
    try{
      if(!packet||typeof packet!=='object')fail('LIVE_FEATURE_PACKET_MISSING');
      if(packet.feature_schema_id!==artifactManifest.feature_schema_id)
        fail('LIVE_FEATURE_SCHEMA_ID_MISMATCH');
      if(packet.feature_schema_sha256!==fingerprint)
        fail('LIVE_FEATURE_SCHEMA_FINGERPRINT_MISMATCH');
      if(!exactArray(packet.feature_names,names))
        fail('LIVE_FEATURE_ORDER_OR_MAPPING_MISMATCH');
      if(packet.feature_index_map&&canonicalJson(packet.feature_index_map)!==canonicalJson(map))
        fail('LIVE_FEATURE_INDEX_MAP_MISMATCH');
      if(packet.candle_is_closed!==true)
        fail('LIVE_CANDLE_NOT_CLOSED');
      if(!finite(packet.candle_open_at)||!finite(packet.candle_close_at)||
        !finite(packet.decision_at))
        fail('LIVE_CANDLE_TIMESTAMP_MISSING_OR_NON_FINITE');
      const open=Number(packet.candle_open_at),close=Number(packet.candle_close_at),
        decision=Number(packet.decision_at);
      if(close-open!==60_000||close>decision)
        fail('LIVE_ONE_MINUTE_CANDLE_CADENCE_OR_FUTURE_CUTOFF_INVALID',
          {open,close,decision});
      if(!Array.isArray(packet.values)||packet.values.length!==names.length||
        packet.values.some(value=>!finite(value)))
        fail('LIVE_FEATURE_VALUE_MISSING_OR_NON_FINITE');
      if(requireTrainingReference&&!Array.isArray(trainingReferenceValues))
        fail('TRAINING_REFERENCE_VALUES_REQUIRED');
      if(trainingReferenceValues)
        assertBitwiseArrayEqual(packet.values,trainingReferenceValues,
          'LIVE_TRAINING_FEATURE_BITWISE_PARITY_FAILURE');
      const normalized=packet.values.map((value,index)=>
        (Number(value)-Number(mean[index]))/Number(std[index]));
      if(normalized.some(value=>!Number.isFinite(value)))
        fail('LIVE_NORMALIZED_FEATURE_NON_FINITE');
      if(packet.normalized_values!==undefined)
        assertBitwiseArrayEqual(packet.normalized_values,normalized,
          'LIVE_NORMALIZATION_BITWISE_PARITY_FAILURE');
      accepted++;
      return {
        valid:true,feature_schema_id:artifactManifest.feature_schema_id,
        feature_schema_sha256:fingerprint,decision_at:decision,
        candle_close_at:close,feature_count:names.length,
        values:packet.values.map(Number),normalized_values:normalized,
        feature_index_map:map
      };
    }catch(error){
      rejected++;
      if(error instanceof FeatureParityError)throw error;
      throw new FeatureParityError('FEATURE_PARITY_UNEXPECTED_VALIDATION_ERROR',
        {message:String(error?.message||error)});
    }
  }

  function predict(packet,predictor,options={}){
    if(typeof predictor!=='function')throw new TypeError('FEATURE_PARITY_PREDICTOR_REQUIRED');
    const guarded=validate(packet,options);
    const output=predictor(guarded.normalized_values,guarded);
    const probability=typeof output==='number'?output:output?.probability;
    if(!finite(probability)||Number(probability)<0||Number(probability)>1)
      fail('LIVE_MODEL_PREDICTION_NON_FINITE_OR_OUT_OF_RANGE');
    return {probability:Number(probability),feature_schema_sha256:fingerprint,
      decision_at:guarded.decision_at,model_output:output};
  }

  return {
    validate,predict,
    getDiagnostics:()=>({
      accepted,rejected,feature_count:names.length,
      feature_schema_sha256:fingerprint,
      failure_policy:'ABORT_ON_MISSING_NAN_SCHEMA_MISMATCH_OR_TIME_LEAKAGE'
    })
  };
}
