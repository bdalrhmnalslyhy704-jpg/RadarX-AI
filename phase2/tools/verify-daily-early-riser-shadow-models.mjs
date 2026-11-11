#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {
  createDailyEarlyRiserForwardForecastPairFromModelBundle
} from '../core/daily-early-riser-forward-shadow.mjs';

const reportPath=resolve(process.argv[2]||'artifacts/daily-early-riser-neural-benchmark.json');
const outputPath=resolve(process.argv[3]||'artifacts/daily-shadow-model-verification.json');
const bundlePath=resolve(process.argv[4]||outputPath.replace(/\.json$/i,'.bundles.json'));
const stable=value=>{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
};
const sha=value=>createHash('sha256').update(stable(JSON.parse(JSON.stringify(value)))).digest('hex');
const isSha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const report=JSON.parse(await readFile(reportPath,'utf8'));
if(report.status!=='COMPLETED_RESEARCH_ONLY'||report.production_touched===true||
  report.deployed===true||report.merged===true||report.real_order_execution===true)
  throw new Error('MODEL_REPORT_NOT_RESEARCH_ONLY_OR_NOT_COMPLETED');

const results=[],disabled=[],verifiedTargets={};
for(const target of [5,10,15]){
  const key=String(target)+'_PCT';
  const bundle=report.target_results?.[key]?.shadow_model_export;
  if(!bundle||bundle.enabled!==true){
    disabled.push({target,reason:'SHADOW_MODEL_EXPORT_DISABLED'});
    continue;
  }
  if(!isSha(bundle.mlp_model_sha256)||sha(bundle.model_fit)!==bundle.mlp_model_sha256.toLowerCase())
    throw new Error('MLP_WEIGHT_SHA256_MISMATCH:'+key);
  if(!isSha(bundle.logistic_model_sha256)||
    sha(bundle.same_window_logistic_fit)!==bundle.logistic_model_sha256.toLowerCase())
    throw new Error('LOGISTIC_WEIGHT_SHA256_MISMATCH:'+key);
  const identity={
    schema:bundle.schema,target_pct:bundle.target_pct,
    target_definition:bundle.target_definition,horizon_ms:bundle.horizon_ms,
    feature_schema:bundle.feature_schema,feature_names:bundle.feature_names,
    trained_through_at:bundle.trained_through_at,
    training_dataset_sha256:bundle.training_dataset_sha256,
    source_code_commit:bundle.source_code_commit,
    mlp_model_sha256:bundle.mlp_model_sha256,
    logistic_model_sha256:bundle.logistic_model_sha256,
    selected_member_index:bundle.selected_member_index,
    selected_residual_scale:bundle.selected_residual_scale
  };
  if(!isSha(bundle.model_bundle_sha256)||sha(identity)!==bundle.model_bundle_sha256.toLowerCase())
    throw new Error('MODEL_BUNDLE_SHA256_MISMATCH:'+key);
  const at=Math.max(Date.now(),Number(bundle.trained_through_at)+86_400_001);
  const features=Object.fromEntries(bundle.feature_names.map(name=>[name,0]));
  features.quote_volume_24h=1_000_000;
  const baseline={
    openTime:at-900_000+1,open:100,high:101,low:99,close:100,closeTime:at,
    quoteVolume:100_000,trades:1000,takerBuyQuoteVolume:50_000
  };
  const pair=createDailyEarlyRiserForwardForecastPairFromModelBundle({
    model_bundle:bundle,model_bundle_sha256:bundle.model_bundle_sha256,
    symbol:'BTCUSDT',at,feature_information_cutoff_at:at,recorded_at:at+1,
    baseline,features
  });
  if(pair.length!==2||pair.some(row=>!Number.isFinite(row.up_probability)||
    row.up_probability<0.02||row.up_probability>0.98))
    throw new Error('MODEL_BUNDLE_INFERENCE_VERIFICATION_FAILED:'+key);
  verifiedTargets[key]={...bundle,historical_holdout_passed:bundle.historical_holdout_passed===true,
    production_eligible:false,real_order_execution:false};
  results.push({
    target_pct:target,feature_schema:bundle.feature_schema,
    feature_count:bundle.feature_names.length,
    training_dataset_sha256:bundle.training_dataset_sha256,
    source_code_commit:bundle.source_code_commit,
    trained_through_at:bundle.trained_through_at,
    selected_member_index:bundle.selected_member_index,
    selected_residual_scale:bundle.selected_residual_scale,
    historical_holdout_passed:bundle.historical_holdout_passed===true,
    mlp_model_sha256:bundle.mlp_model_sha256,
    logistic_model_sha256:bundle.logistic_model_sha256,
    model_bundle_sha256:bundle.model_bundle_sha256,
    sample_mlp_probability:pair[0].up_probability,
    sample_logistic_probability:pair[1].up_probability
  });
}
if(!results.length)throw new Error('NO_ENABLED_SHADOW_MODEL_BUNDLES_FOUND');
const output={
  schema:'RADARX_DAILY_SHADOW_MODEL_BUNDLE_VERIFICATION_V1',
  status:'VERIFIED_RESEARCH_EXPORTS',
  source_report:reportPath,source_dataset_sha256:report.input_sha256,
  verified_bundle_count:results.length,disabled_targets:disabled,
  bundles:results,production_eligible:false,real_order_execution:false
};
const deployableResearchBundleFile={
  schema:'RADARX_DAILY_FORWARD_SHADOW_MODEL_BUNDLES_V1',
  status:'VERIFIED_RESEARCH_EXPORTS',
  source_report_sha256:sha(report),source_dataset_sha256:report.input_sha256,
  verified_at:new Date().toISOString(),targets:verifiedTargets,
  production_eligible:false,real_order_execution:false
};
await mkdir(dirname(outputPath),{recursive:true});
await mkdir(dirname(bundlePath),{recursive:true});
await Promise.all([
  writeFile(outputPath,JSON.stringify(output,null,2)+'\n'),
  writeFile(bundlePath,JSON.stringify(deployableResearchBundleFile)+'\n')
]);
process.stdout.write(JSON.stringify({...output,bundle_file:bundlePath},null,2)+'\n');
