import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  COGNITIVE_DAILY_FEATURE_NAMES,
  COGNITIVE_DAILY_FEATURE_SCHEMA
} from '../core/cognitive-brain.mjs';

const runner=fileURLToPath(new URL('../tools/daily-early-riser-forward-shadow.mjs',import.meta.url));
const interval=15*60*1000,horizon=96*interval;
const stable=value=>{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
};
const digest=value=>createHash('sha256').update(stable(value)).digest('hex');

function makeBundle(trainedThroughAt){
  const names=[...COGNITIVE_DAILY_FEATURE_NAMES];
  const modelFit={
    kind:'RESIDUAL_DEEP_MLP_V2',architecture:'35-4-3-1+RESIDUAL',
    input_size:35,hidden_units:4,second_hidden_units:3,output_size:1,
    input_weights:Array.from({length:35},()=>Array(4).fill(0)),
    hidden_bias_1:Array(4).fill(0),
    hidden_weights:Array.from({length:4},()=>Array(3).fill(0)),
    hidden_bias_2:Array(3).fill(0),
    output_weights:Array(3).fill(0),output_bias:0,
    skip_weights:Array(35).fill(0),residual_scale:1,
    feature_names:names,feature_schema:COGNITIVE_DAILY_FEATURE_SCHEMA,
    selected_member_index:0,selected_residual_scale:1,
    refit_max_outcome_resolved_at:trainedThroughAt
  };
  const logisticFit={
    weights:Array(35).fill(0),intercept:-0.3,base_rate:0.5,
    feature_names:names,feature_schema:COGNITIVE_DAILY_FEATURE_SCHEMA,l2:0.08
  };
  const bundle={
    schema:'RADARX_DAILY_EARLY_RISER_SHADOW_MODEL_V1',
    enabled:true,target_pct:5,
    target_definition:'FIRST_PASSAGE_PLUS_5_PCT_BEFORE_MINUS_2_PCT_24H_15M_V1',
    horizon_ms:horizon,feature_schema:COGNITIVE_DAILY_FEATURE_SCHEMA,
    feature_names:names,trained_through_at:trainedThroughAt,
    selected_member_index:0,selected_residual_scale:1,
    historical_holdout_passed:false,
    model_fit:modelFit,same_window_logistic_fit:logisticFit,
    research_only:true,production_eligible:false,real_order_execution:false,
    training_dataset_sha256:'a'.repeat(64),source_code_commit:'b'.repeat(40)
  };
  bundle.mlp_model_sha256=digest(modelFit);
  bundle.logistic_model_sha256=digest(logisticFit);
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
  bundle.model_bundle_sha256=digest(identity);
  return bundle;
}
function kline(openTime,index){
  const high=index===0?106:101;
  return [openTime,'100',String(high),'99','100','1000',
    openTime+interval-1,'100000','100','500','50000','0'];
}

test('forward-shadow CLI records, deduplicates, resolves official hashed paths and scores',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'radarx-forward-shadow-cli-'));
  try{
    const now=Date.now(),at=now-5000,trainedThroughAt=at-2*horizon;
    const bundle=makeBundle(trainedThroughAt);
    const modelReportPath=join(directory,'model-report.json');
    const observationsPath=join(directory,'observations.jsonl');
    const forecastsPath=join(directory,'forecasts.jsonl');
    const closedPathsPath=join(directory,'closed-paths.jsonl');
    const resolvedPath=join(directory,'resolved.jsonl');
    const scorePath=join(directory,'score.json');
    const modelReport={
      status:'COMPLETED_RESEARCH_ONLY',production_touched:false,deployed:false,
      merged:false,real_order_execution:false,
      target_results:{'5_PCT':{shadow_model_export:bundle}}
    };
    await writeFile(modelReportPath,JSON.stringify(modelReport));
    const features={quote_volume_24h:1_200_000,volume_ratio:1.5,taker_buy_ratio:0.61};
    const baseline={
      openTime:at-interval+1,open:100,high:101,low:99,close:100,
      closeTime:at,quoteVolume:100_000,trades:1000,takerBuyQuoteVolume:50_000
    };
    const observation={
      schema:'RADARX_DAILY_FORWARD_OBSERVATION_V1',symbol:'AAAUSDT',
      at,feature_information_cutoff_at:at,recorded_at:at+1000,
      observation_source:'BINANCE_OFFICIAL_CLOSED_15M_BASELINE',
      baseline,features
    };
    await writeFile(observationsPath,JSON.stringify(observation)+'\n');

    const run=(...args)=>execFileSync(process.execPath,[runner,...args],{encoding:'utf8'});
    const recorded=JSON.parse(run('--mode','record','--model-report',modelReportPath,
      '--observations',observationsPath,'--output',forecastsPath));
    assert.equal(recorded.created_paired_forecasts,1);
    assert.equal(recorded.emitted_model_forecast_rows,2);
    let forecasts=(await readFile(forecastsPath,'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(forecasts.length,2);
    assert.equal(forecasts[0].pair_id,forecasts[1].pair_id);
    assert.ok(forecasts.every(row=>row.status==='PENDING'));

    const duplicate=JSON.parse(run('--mode','record','--model-report',modelReportPath,
      '--observations',observationsPath,'--output',forecastsPath));
    assert.equal(duplicate.created_paired_forecasts,0);
    assert.equal(duplicate.skipped_duplicate_pairs,1);
    assert.equal((await readFile(forecastsPath,'utf8')).trim().split(/\r?\n/).length,2);

    const future=Array.from({length:96},(_,index)=>kline(at+1+index*interval,index));
    const responseBody=JSON.stringify(future);
    const requestUrl='https://api.binance.com/api/v3/klines?symbol=AAAUSDT&interval=15m&startTime='+
      String(at+1)+'&limit=96';
    const closedPath={
      symbol:'AAAUSDT',baseline_close_time:at,source:'BINANCE_SPOT_REST_KLINES_V1',
      http_status:200,request_url:requestUrl,response_body:responseBody,
      response_sha256:createHash('sha256').update(responseBody,'utf8').digest('hex'),
      recorded_at:at+horizon+1000
    };
    await writeFile(closedPathsPath,JSON.stringify(closedPath)+'\n');
    const resolved=JSON.parse(run('--mode','resolve','--forecasts',forecastsPath,
      '--closed-paths',closedPathsPath,'--output',resolvedPath));
    assert.equal(resolved.resolved,2);
    const resolvedRows=(await readFile(resolvedPath,'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(resolvedRows.length,2);
    assert.ok(resolvedRows.every(row=>row.status==='RESOLVED'&&row.outcome==='UP'));

    const score=JSON.parse(run('--mode','score','--resolved',resolvedPath,'--target','5',
      '--model-bundle-sha256',bundle.model_bundle_sha256,'--output',scorePath));
    assert.equal(score.score.status,'INSUFFICIENT_FORWARD_PAIRED_OUTCOMES');
    assert.equal(score.score.paired_resolved_samples,1);
    assert.equal(score.score.production_eligible,false);
    assert.ok((await readFile(scorePath,'utf8')).includes('INSUFFICIENT_FORWARD_PAIRED_OUTCOMES'));
    assert.ok((await readFile(forecastsPath,'utf8')).includes('"status":"PENDING"'),
      'forecast ledger remains immutable after resolution');
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
});
