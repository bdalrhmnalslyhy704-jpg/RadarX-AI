import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {
  DailyEarlyRiserForwardShadowRuntime
} from '../core/daily-early-riser-forward-shadow-runtime.mjs';
import {
  COGNITIVE_DAILY_FEATURE_NAMES,
  COGNITIVE_DAILY_FEATURE_SCHEMA
} from '../core/cognitive-brain.mjs';

const INTERVAL=15*60*1000,HORIZON=96*INTERVAL;
const stable=value=>{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
};
const sha=value=>createHash('sha256').update(stable(value)).digest('hex');

function makeBundle(target,trainedThroughAt){
  const featureNames=[...COGNITIVE_DAILY_FEATURE_NAMES];
  const modelFit={
    kind:'RESIDUAL_DEEP_MLP_V2',architecture:'35-4-3-1+RESIDUAL',
    input_size:35,hidden_units:4,second_hidden_units:3,output_size:1,
    input_weights:Array.from({length:35},()=>Array(4).fill(0)),
    hidden_bias_1:Array(4).fill(0),
    hidden_weights:Array.from({length:4},()=>Array(3).fill(0)),
    hidden_bias_2:Array(3).fill(0),
    output_weights:Array(3).fill(0),output_bias:0,
    skip_weights:Array(35).fill(0),residual_scale:1,
    feature_names:featureNames,feature_schema:COGNITIVE_DAILY_FEATURE_SCHEMA,
    selected_member_index:0,selected_residual_scale:1,
    refit_max_outcome_resolved_at:trainedThroughAt
  };
  const logisticFit={
    weights:Array(35).fill(0),intercept:-0.3,base_rate:0.5,
    feature_names:featureNames,feature_schema:COGNITIVE_DAILY_FEATURE_SCHEMA,l2:0.08
  };
  const bundle={
    schema:'RADARX_DAILY_EARLY_RISER_SHADOW_MODEL_V1',
    enabled:true,target_pct:target,
    target_definition:'FIRST_PASSAGE_PLUS_'+target+'_PCT_BEFORE_MINUS_2_PCT_24H_15M_V1',
    horizon_ms:HORIZON,feature_schema:COGNITIVE_DAILY_FEATURE_SCHEMA,
    feature_names:featureNames,trained_through_at:trainedThroughAt,
    selected_member_index:0,selected_residual_scale:1,
    historical_holdout_passed:false,
    model_fit:safeClone(modelFit),same_window_logistic_fit:safeClone(logisticFit),
    research_only:true,production_eligible:false,real_order_execution:false,
    training_dataset_sha256:'a'.repeat(64),source_code_commit:'b'.repeat(40)
  };
  bundle.mlp_model_sha256=sha(bundle.model_fit);
  bundle.logistic_model_sha256=sha(bundle.same_window_logistic_fit);
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
  bundle.model_bundle_sha256=sha(identity);
  return bundle;
}
function safeClone(value){return JSON.parse(JSON.stringify(value));}
function candidateAt(at){
  const baseline={
    openTime:at-INTERVAL+1,open:100,high:101,low:99,close:100,closeTime:at,
    quoteVolume:150_000,trades:1600,takerBuyQuoteVolume:90_000
  };
  const features={
    volume_ratio:1.7,trade_ratio:1.5,taker_buy_ratio:0.6,close_location:0.72,
    higher_low:true,breakout_above_prior_high:false,compression_ratio:0.75,
    hourly_return_pct:0.5,return_30m_pct:0.2,return_3h_pct:1.2,
    trend_aligned:true,btc_hourly_return_pct:0.2,relative_strength_vs_btc_pct:0.3,
    recent_15m_return_pct:0.4,current_range_pct:1.2,upper_wick_pct:0.2,
    lower_wick_pct:0.25,breakout_distance_pct:0.1,micro_5m_available:true,
    micro_5m_volume_ratio:1.7,micro_5m_trade_ratio:1.5,micro_5m_taker_buy_ratio:0.62,
    micro_5m_close_location:0.7,micro_5m_return_pct:0.2,
    daily_change_pct:2.1,relative_strength_vs_btc_24h_pct:1.3,
    quote_volume_24h:1_200_000
  };
  return {
    symbol:'AAAUSDT',data_valid:true,data_stale:false,closed_candles_only:true,
    daily_forward_context_ready:true,shock_move_audit_only:false,
    observation_source:'BINANCE_OFFICIAL_CLOSED_15M_BASELINE',
    candle_close_time:at,feature_information_cutoff_at:at,candle_baseline:baseline,
    features,cognitive_rank_score:82,score:79
  };
}
function futurePath(at){
  return Array.from({length:96},(_,index)=>{
    const openTime=at+1+index*INTERVAL;
    return [openTime,'100',index===0?'106':'101','99',index===0?'105':'100',
      '1000',openTime+INTERVAL-1,'100000','100','500','50000','0'];
  });
}

test('DHDTech forward-shadow runtime captures paired model targets and resolves a single Binance path',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-forward-shadow-runtime-'));
  const store=await new DurableStore({dir}).init();
  const now=Date.now(),at=now-30_000,trainedThrough=at-2*HORIZON;
  const bundle=makeBundle(5,trainedThrough);
  const bundleFile=join(dir,'daily-forward-shadow-model-bundles.json');
  await writeFile(bundleFile,JSON.stringify({
    schema:'RADARX_DAILY_FORWARD_SHADOW_MODEL_BUNDLES_V1',
    status:'VERIFIED_RESEARCH_EXPORTS',
    targets:{'5_PCT':bundle},
    production_eligible:false,real_order_execution:false
  }));
  let restCalls=0,requestArgs=null;
  const rawPath=JSON.stringify(futurePath(at));
  const rest={
    async request(path,query,options){
      restCalls++;requestArgs={path,query,options};
      assert.equal(path,'/api/v3/klines');
      assert.equal(options.includeResponseBody,true);
      const requestUrl='https://api.binance.com/api/v3/klines?symbol=AAAUSDT&interval=15m&startTime='+
        String(at+1)+'&endTime='+String(at+HORIZON)+'&limit=96';
      return {
        data:JSON.parse(rawPath),source:'https://api.binance.com',
        receivedAt:at+HORIZON+2000,httpStatus:200,
        requestUrl,responseBody:rawPath
      };
    }
  };
  try{
    const runtime=await DailyEarlyRiserForwardShadowRuntime.create({
      store,rest,modelBundleFile:bundleFile,maxNewSymbolsPerCycle:8,maxResolutionsPerCycle:1,
      logger:{warn(){},info(){}}
    });
    const candidate=candidateAt(at);
    const capture=await runtime.captureCandidates([candidate],now);
    assert.equal(capture.new_paired_forecasts,1);
    assert.equal(capture.emitted_model_rows,2);
    assert.equal(capture.skipped_invalid,0);
    assert.equal(restCalls,0,'capturing a forecast must not call future-price data');
    const forecasts=(await readFile(store.files.dailyForwardShadowForecasts,'utf8'))
      .trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(forecasts.length,2);
    assert.equal(forecasts[0].pair_id,forecasts[1].pair_id);
    assert.ok(forecasts.every(row=>row.status==='PENDING'));
    assert.equal(forecasts[0].feature_information_cutoff_at,at);
    assert.equal(forecasts[0].trained_through_at,trainedThrough);

    const resolution=await runtime.resolveMatured(at+HORIZON+10_000);
    assert.equal(restCalls,1,'all MLP/logistic forecasts for a symbol/baseline share one official request');
    assert.equal(resolution.resolved_model_rows,2);
    assert.equal(resolution.pending_pairs,0);
    assert.equal(requestArgs.query.symbol,'AAAUSDT');
    assert.equal(requestArgs.query.interval,'15m');
    assert.equal(requestArgs.query.startTime,at+1);
    assert.equal(requestArgs.query.endTime,at+HORIZON);
    const resolved=(await readFile(store.files.dailyForwardShadowResolved,'utf8'))
      .trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(resolved.length,2);
    assert.ok(resolved.every(row=>row.status==='RESOLVED'&&row.outcome==='UP'));
    assert.ok(resolved.every(row=>/^[a-f0-9]{64}$/.test(row.resolution_provenance.response_sha256)));
    assert.equal(runtime.snapshot().resolved_pairs,1);
    const storedPaths=(await readFile(store.files.dailyForwardShadowMarketPaths,'utf8'))
      .trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(storedPaths.length,1);
    assert.equal(storedPaths[0].schema,'RADARX_DAILY_FORWARD_SHADOW_MARKET_PATH_V1');
    assert.equal(storedPaths[0].symbol,'AAAUSDT');
    assert.equal(storedPaths[0].baseline_close_time,at);
    assert.equal(storedPaths[0].response_body,rawPath);
    assert.equal(storedPaths[0].response_sha256,createHash('sha256').update(rawPath,'utf8').digest('hex'));
    assert.equal(runtime.snapshot().stored_market_paths,1);

    // Simulate interruption after one outcome row reached the append-only
    // ledger. Restart must reuse the immutable raw path and resolve only the
    // missing model row without a second Binance request.
    await writeFile(store.files.dailyForwardShadowResolved,JSON.stringify(resolved[0])+'\n');
    const restored=await DailyEarlyRiserForwardShadowRuntime.create({
      store,rest,modelBundleFile:bundleFile,maxNewSymbolsPerCycle:8,maxResolutionsPerCycle:1,
      logger:{warn(){},info(){}}
    });
    assert.equal(restCalls,1,'restart restore must load the saved raw market path without redownloading');
    assert.equal(restored.snapshot().stored_market_paths,1);
    assert.equal(restored.snapshot().pending_pairs,1,'a partial resolution must retain the complete original pair');
    const recovery=await restored.resolveMatured(at+HORIZON+20_000);
    assert.equal(restCalls,1,'a persisted official raw path is replayed instead of requesting Binance again');
    assert.equal(recovery.resolved_model_rows,1,'only the missing model forecast is appended on recovery');
    assert.equal(restored.snapshot().pending_pairs,0);
    const recoveredRows=(await readFile(store.files.dailyForwardShadowResolved,'utf8'))
      .trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(recoveredRows.length,2);
    assert.equal(new Set(recoveredRows.map(row=>row.forecast_id)).size,2);

    const duplicate=await restored.captureCandidates([candidate],now+2000);
    assert.equal(duplicate.new_paired_forecasts,0);
    assert.equal(duplicate.skipped_daily_cadence,1);
    assert.equal((await readFile(store.files.dailyForwardShadowForecasts,'utf8'))
      .trim().split(/\r?\n/).length,2);
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});

test('runtime rejects non-Binance forward paths and leaves the paired forecasts unresolved',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-forward-shadow-untrusted-path-'));
  const store=await new DurableStore({dir}).init();
  const now=Date.now(),at=now-30_000,trainedThrough=at-2*HORIZON;
  const bundle=makeBundle(5,trainedThrough);
  const bundleFile=join(dir,'daily-forward-shadow-model-bundles.json');
  await writeFile(bundleFile,JSON.stringify({
    schema:'RADARX_DAILY_FORWARD_SHADOW_MODEL_BUNDLES_V1',
    targets:{'5_PCT':bundle},production_eligible:false,real_order_execution:false
  }));
  const rawPath=JSON.stringify(futurePath(at));
  let restCalls=0;
  const rest={async request(){
    restCalls++;
    return {
      data:JSON.parse(rawPath),httpStatus:200,receivedAt:at+HORIZON+1000,
      requestUrl:'https://attacker.example/api/v3/klines?symbol=AAAUSDT&interval=15m&startTime='+
        String(at+1)+'&endTime='+String(at+HORIZON)+'&limit=96',
      responseBody:rawPath
    };
  }};
  try{
    const runtime=await DailyEarlyRiserForwardShadowRuntime.create({
      store,rest,modelBundleFile:bundleFile,logger:{warn(){},info(){}}
    });
    const capture=await runtime.captureCandidates([candidateAt(at)],now);
    assert.equal(capture.new_paired_forecasts,1);
    const resolution=await runtime.resolveMatured(at+HORIZON+10_000);
    assert.equal(restCalls,1);
    assert.equal(resolution.failed_paths,1);
    assert.equal(resolution.resolved_model_rows,0);
    assert.equal(runtime.snapshot().pending_pairs,1);
    assert.equal(runtime.snapshot().stored_market_paths,0);
    assert.equal((await readFile(store.files.dailyForwardShadowResolved,'utf8')).trim(),'');
    assert.equal((await readFile(store.files.dailyForwardShadowMarketPaths,'utf8')).trim(),'');
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});

test('daily-shadow runtime rejects malformed or production-enabled bundle envelopes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-forward-shadow-invalid-bundle-'));
  const store=await new DurableStore({dir}).init();
  const path=join(dir,'bad-bundles.json');
  try{
    await writeFile(path,JSON.stringify({
      schema:'RADARX_DAILY_FORWARD_SHADOW_MODEL_BUNDLES_V1',
      targets:{'5_PCT':{enabled:true}},production_eligible:true,real_order_execution:false
    }));
    await assert.rejects(DailyEarlyRiserForwardShadowRuntime.create({
      store,rest:{request:async()=>({})},modelBundleFile:path
    }),/MODEL_BUNDLE_FILE_INVALID/);
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});
