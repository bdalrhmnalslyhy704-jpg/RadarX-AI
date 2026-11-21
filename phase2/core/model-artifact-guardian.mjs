import {createHash} from 'node:crypto';
import {canonicalJson,NEURAL_CLOSURE_TARGET_DEFINITION,NEURAL_CLOSURE_TARGET_SEMANTICS} from './neural-closure-contracts.mjs';

const SHA256=/^[a-f0-9]{64}$/i;
const COMMIT=/^[a-f0-9]{40}$/i;
const finite=value=>value!==null&&value!==undefined&&value!==''&&
  typeof value!=='boolean'&&Number.isFinite(Number(value));
const hashBytes=bytes=>createHash('sha256').update(bytes).digest('hex');

function assertFiniteTree(value,path='model_state'){
  if(Array.isArray(value)){
    for(let index=0;index<value.length;index++)assertFiniteTree(value[index],path+'['+index+']');
    return;
  }
  if(value&&typeof value==='object'){
    for(const [key,child] of Object.entries(value))assertFiniteTree(child,path+'.'+key);
    return;
  }
  if(typeof value==='number'&&!Number.isFinite(value))
    throw new TypeError('MODEL_ARTIFACT_NON_FINITE_WEIGHT:'+path);
  if(value===undefined||typeof value==='function'||typeof value==='symbol'||typeof value==='bigint')
    throw new TypeError('MODEL_ARTIFACT_NON_SERIALIZABLE_VALUE:'+path);
}

function normalizeFeatureMap(featureNames,featureIndexMap){
  if(!Array.isArray(featureNames)||featureNames.length<1||
    featureNames.some(name=>typeof name!=='string'||!name.trim())||
    new Set(featureNames).size!==featureNames.length)
    throw new TypeError('MODEL_ARTIFACT_FEATURE_NAMES_INVALID');
  const expected=Object.fromEntries(featureNames.map((name,index)=>[name,index]));
  if(!featureIndexMap||typeof featureIndexMap!=='object'||
    canonicalJson(featureIndexMap)!==canonicalJson(expected))
    throw new Error('MODEL_ARTIFACT_FEATURE_INDEX_MAP_MISMATCH');
  return expected;
}

export function createVersionedModelArtifact({
  modelName,modelFamily,modelVersion,sourceCommitSha,
  targetDefinition=NEURAL_CLOSURE_TARGET_DEFINITION,
  targetSemantics=NEURAL_CLOSURE_TARGET_SEMANTICS,
  featureSchemaId,featureNames,featureIndexMap,
  normalization,modelState,trainingReportSha256,createdAt=new Date().toISOString()
}={}){
  if(typeof modelName!=='string'||!modelName.trim()||
    typeof modelFamily!=='string'||!modelFamily.trim()||
    typeof modelVersion!=='string'||!modelVersion.trim())
    throw new TypeError('MODEL_ARTIFACT_IDENTITY_INVALID');
  if(!COMMIT.test(String(sourceCommitSha||'')))
    throw new TypeError('MODEL_ARTIFACT_SOURCE_COMMIT_SHA_INVALID');
  if(targetDefinition!==NEURAL_CLOSURE_TARGET_DEFINITION)
    throw new Error('MODEL_ARTIFACT_TARGET_DEFINITION_MISMATCH');
  if(targetSemantics!==NEURAL_CLOSURE_TARGET_SEMANTICS)
    throw new Error('MODEL_ARTIFACT_TARGET_SEMANTICS_MISMATCH');
  if(typeof featureSchemaId!=='string'||!featureSchemaId.trim())
    throw new TypeError('MODEL_ARTIFACT_FEATURE_SCHEMA_REQUIRED');
  const indexMap=normalizeFeatureMap(featureNames,featureIndexMap);
  if(!normalization||!Array.isArray(normalization.mean)||!Array.isArray(normalization.std)||
    normalization.mean.length!==featureNames.length||
    normalization.std.length!==featureNames.length||
    normalization.mean.some(value=>!finite(value))||
    normalization.std.some(value=>!finite(value)||Number(value)<=0))
    throw new Error('MODEL_ARTIFACT_NORMALIZATION_INVALID');
  if(!modelState||typeof modelState!=='object')
    throw new TypeError('MODEL_ARTIFACT_MODEL_STATE_REQUIRED');
  assertFiniteTree(modelState);
  if(trainingReportSha256!==undefined&&!SHA256.test(String(trainingReportSha256)))
    throw new TypeError('MODEL_ARTIFACT_TRAINING_REPORT_SHA_INVALID');
  const weightsBytes=Buffer.from(canonicalJson(modelState),'utf8');
  const weightsSha256=hashBytes(weightsBytes);
  const weightsBase64=weightsBytes.toString('base64');
  const manifest={
    schema:'RADARX_VERSIONED_NEURAL_MODEL_ARTIFACT_V1',
    model_name:modelName,model_family:modelFamily,model_version:modelVersion,
    source_commit_sha:String(sourceCommitSha).toLowerCase(),
    target_definition:targetDefinition,target_semantics:targetSemantics,feature_schema_id:featureSchemaId,
    feature_names:[...featureNames],feature_index_map:indexMap,
    normalization:{mean:normalization.mean.map(Number),std:normalization.std.map(Number)},
    model_state_format:'CANONICAL_JSON_UTF8',
    weights_encoding:'BASE64',
    weights_byte_length:weightsBytes.length,
    weights_sha256:weightsSha256,weights_base64:weightsBase64,
    training_report_sha256:trainingReportSha256??null,
    created_at:createdAt,
    paper_trading:true,real_order_execution:false,market:'BINANCE_SPOT_ONLY'
  };
  const artifactSha256=hashBytes(Buffer.from(canonicalJson(manifest),'utf8'));
  return {...manifest,artifact_sha256:artifactSha256};
}

export function attachResearchLineageToModelArtifact(artifact,lineage={}){
  const initial=verifyVersionedModelArtifact(artifact);
  if(!initial.valid)throw new Error('MODEL_ARTIFACT_LINEAGE_SOURCE_INVALID:'+initial.reason);
  const researchLineage={
    dataset_sha256:String(lineage.datasetSha256||'').toLowerCase(),
    input_file_sha256:String(lineage.inputFileSha256||'').toLowerCase(),
    dataset_source_commit_sha:String(lineage.datasetSourceCommitSha||'').toLowerCase(),
    target_definition:String(lineage.targetDefinition||''),
    target_semantics:String(lineage.targetSemantics||''),
    feature_schema_id:String(lineage.featureSchemaId||''),
    feature_names_sha256:hashBytes(Buffer.from(canonicalJson(artifact.feature_names),'utf8')),
    horizon_ms:Number(lineage.horizonMs),
    cost_model_id:String(lineage.costModelId||''),
    round_trip_cost_bps:Number(lineage.roundTripCostBps),
    split_id:String(lineage.splitId||'')
  };
  if(!SHA256.test(researchLineage.dataset_sha256)||
    !SHA256.test(researchLineage.input_file_sha256)||
    !COMMIT.test(researchLineage.dataset_source_commit_sha)||
    researchLineage.target_definition!==artifact.target_definition||
    researchLineage.target_semantics!==artifact.target_semantics||
    researchLineage.feature_schema_id!==artifact.feature_schema_id||
    !finite(researchLineage.horizon_ms)||researchLineage.horizon_ms<=0||
    !researchLineage.cost_model_id.trim()||
    !finite(researchLineage.round_trip_cost_bps)||researchLineage.round_trip_cost_bps<0||
    !researchLineage.split_id.trim())
    throw new TypeError('MODEL_ARTIFACT_RESEARCH_LINEAGE_INVALID');
  const manifest={...artifact,research_lineage:researchLineage};
  delete manifest.artifact_sha256;
  manifest.artifact_sha256=hashBytes(Buffer.from(canonicalJson(manifest),'utf8'));
  const verified=verifyVersionedModelArtifact(manifest,{
    expectedSourceCommitSha:artifact.source_commit_sha,requireResearchLineage:true
  });
  if(!verified.valid)throw new Error('MODEL_ARTIFACT_RESEARCH_LINEAGE_VERIFY_FAILED:'+verified.reason);
  return manifest;
}

export function verifyVersionedModelArtifact(artifact,{
  expectedTargetDefinition=NEURAL_CLOSURE_TARGET_DEFINITION,
  expectedTargetSemantics=NEURAL_CLOSURE_TARGET_SEMANTICS,
  expectedSourceCommitSha=null,
  requireResearchLineage=false
}={}){
  const fail=reason=>({valid:false,reason});
  if(!artifact||artifact.schema!=='RADARX_VERSIONED_NEURAL_MODEL_ARTIFACT_V1')
    return fail('MODEL_ARTIFACT_SCHEMA_INVALID');
  if(artifact.target_definition!==expectedTargetDefinition)
    return fail('MODEL_ARTIFACT_TARGET_MISMATCH');
  if(artifact.target_semantics!==expectedTargetSemantics)
    return fail('MODEL_ARTIFACT_TARGET_SEMANTICS_MISMATCH');
  if(!COMMIT.test(String(artifact.source_commit_sha||'')))
    return fail('MODEL_ARTIFACT_SOURCE_SHA_INVALID');
  if(expectedSourceCommitSha&&artifact.source_commit_sha!==String(expectedSourceCommitSha).toLowerCase())
    return fail('MODEL_ARTIFACT_SOURCE_SHA_MISMATCH');
  const lineage=artifact.research_lineage;
  if(requireResearchLineage&&!lineage)return fail('MODEL_ARTIFACT_RESEARCH_LINEAGE_MISSING');
  if(lineage){
    if(!SHA256.test(String(lineage.dataset_sha256||''))||
      !SHA256.test(String(lineage.input_file_sha256||''))||
      !COMMIT.test(String(lineage.dataset_source_commit_sha||''))||
      lineage.target_definition!==artifact.target_definition||
      lineage.target_semantics!==artifact.target_semantics||
      lineage.feature_schema_id!==artifact.feature_schema_id||
      lineage.feature_names_sha256!==hashBytes(Buffer.from(canonicalJson(artifact.feature_names),'utf8'))||
      !finite(lineage.horizon_ms)||Number(lineage.horizon_ms)<=0||
      typeof lineage.cost_model_id!=='string'||!lineage.cost_model_id.trim()||
      !finite(lineage.round_trip_cost_bps)||Number(lineage.round_trip_cost_bps)<0||
      typeof lineage.split_id!=='string'||!lineage.split_id.trim())
      return fail('MODEL_ARTIFACT_RESEARCH_LINEAGE_INVALID');
  }
  try{
    normalizeFeatureMap(artifact.feature_names,artifact.feature_index_map);
    if(!artifact.normalization||artifact.normalization.mean.length!==artifact.feature_names.length||
      artifact.normalization.std.length!==artifact.feature_names.length||
      artifact.normalization.mean.some(value=>!finite(value))||
      artifact.normalization.std.some(value=>!finite(value)||Number(value)<=0))
      return fail('MODEL_ARTIFACT_SCALER_INVALID');
    const weights=Buffer.from(String(artifact.weights_base64||''),'base64');
    if(weights.length!==Number(artifact.weights_byte_length)||
      hashBytes(weights)!==String(artifact.weights_sha256||'').toLowerCase())
      return fail('MODEL_ARTIFACT_WEIGHTS_SHA256_MISMATCH');
    const state=JSON.parse(weights.toString('utf8'));
    assertFiniteTree(state);
    const manifest={...artifact};
    delete manifest.artifact_sha256;
    if(hashBytes(Buffer.from(canonicalJson(manifest),'utf8'))!==
      String(artifact.artifact_sha256||'').toLowerCase())
      return fail('MODEL_ARTIFACT_MANIFEST_SHA256_MISMATCH');
    return {valid:true,model_name:artifact.model_name,model_family:artifact.model_family,
      model_version:artifact.model_version,source_commit_sha:artifact.source_commit_sha,
      target_definition:artifact.target_definition,target_semantics:artifact.target_semantics,
      feature_count:artifact.feature_names.length,
      weights_sha256:artifact.weights_sha256,artifact_sha256:artifact.artifact_sha256,
      model_state:state};
  }catch(error){
    return fail('MODEL_ARTIFACT_VALIDATION_ERROR:'+String(error?.message||error));
  }
}
