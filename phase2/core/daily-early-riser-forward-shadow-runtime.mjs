import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile} from 'node:fs/promises';
import readline from 'node:readline';
import {
  createDailyEarlyRiserForwardForecastPairFromModelBundle,
  resolveDailyEarlyRiserForwardForecast,
  DAILY_FORWARD_SHADOW_SCHEMA
} from './daily-early-riser-forward-shadow.mjs';
import {COGNITIVE_DAILY_FEATURE_NAMES,COGNITIVE_DAILY_FEATURE_SCHEMA} from './cognitive-brain.mjs';

const TARGETS=Object.freeze([5,10,15]);
const INTERVAL_MS=15*60*1000;
const HORIZON_BARS=96;
const HORIZON_MS=INTERVAL_MS*HORIZON_BARS;
const MIN_QUOTE_VOLUME_USDT=750000;
const MAX_BASELINE_AGE_MS=45*60*1000;
const OFFICIAL_BINANCE_HOSTS=new Set([
  'api.binance.com','api1.binance.com','api2.binance.com',
  'api3.binance.com','api4.binance.com','data-api.binance.vision',
  'api.binance.vision'
]);
const finite=value=>{
  if(value===null||value===undefined||value===''||typeof value==='boolean')return null;
  const number=Number(value);
  return Number.isFinite(number)?number:null;
};
const isSha256=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const cleanSymbol=value=>String(value||'').trim().toUpperCase();
const pairKey=(symbol,target,at,modelHash)=>[
  cleanSymbol(symbol),String(target),String(Math.trunc(Number(at)||0)),
  String(modelHash||'').toLowerCase()
].join('|');
const jsonLines=async function* (path){
  const input=createReadStream(path,{encoding:'utf8'});
  const reader=readline.createInterface({input,crlfDelay:Infinity});
  try{
    for await(const line of reader){
      if(!line.trim())continue;
      let row;
      try{row=JSON.parse(line);}
      catch{throw new Error('DAILY_FORWARD_SHADOW_JSONL_CORRUPT:'+path);}
      yield row;
    }
  }finally{
    reader.close();input.destroy();
  }
};

function validateBundlePayload(payload){
  if(!payload||payload.schema!=='RADARX_DAILY_FORWARD_SHADOW_MODEL_BUNDLES_V1'||
    payload.production_eligible!==false||payload.real_order_execution!==false||
    !payload.targets||typeof payload.targets!=='object'||Array.isArray(payload.targets))
    throw new Error('DAILY_FORWARD_SHADOW_MODEL_BUNDLE_FILE_INVALID');
  const bundles=new Map();
  for(const target of TARGETS){
    const key=String(target)+'_PCT';
    const entry=payload.targets[key];
    if(!entry||entry.enabled!==true)continue;
    if(!isSha256(entry.model_bundle_sha256)||entry.feature_schema!==COGNITIVE_DAILY_FEATURE_SCHEMA||
      !Array.isArray(entry.feature_names)||
      JSON.stringify(entry.feature_names)!==JSON.stringify(COGNITIVE_DAILY_FEATURE_NAMES))
      throw new Error('DAILY_FORWARD_SHADOW_MODEL_BUNDLE_CONTRACT_INVALID:'+key);
    if(typeof entry.historical_holdout_passed!=='boolean'||
      entry.production_eligible!==false||entry.real_order_execution!==false)
      throw new Error('DAILY_FORWARD_SHADOW_MODEL_BUNDLE_RESEARCH_STATUS_INVALID:'+key);
    bundles.set(target,entry);
  }
  if(!bundles.size)throw new Error('DAILY_FORWARD_SHADOW_NO_ENABLED_MODEL_BUNDLES');
  return bundles;
}

function validateClosedRestResponse(result,symbol,baselineCloseTime){
  if(!result||Number(result.httpStatus)!==200||typeof result.responseBody!=='string'||
    !Array.isArray(result.data))
    return {valid:false,reason:'BINANCE_REST_RESPONSE_PROVENANCE_MISSING'};
  // RestClient returns the exact body and request URL without caching when
  // includeResponseBody is enabled. Hash that raw body here so resolution is
  // independently verifiable without requiring a precomputed response hash.
  const actual=createHash('sha256').update(result.responseBody,'utf8').digest('hex');
  if(result.responseSha256!==undefined&&
    (!isSha256(result.responseSha256)||actual!==result.responseSha256.toLowerCase()))
    return {valid:false,reason:'BINANCE_REST_RESPONSE_SHA256_MISMATCH'};
  let url;
  try{url=new URL(String(result.requestUrl||''));}
  catch{return {valid:false,reason:'BINANCE_REST_REQUEST_URL_INVALID'};}
  if(url.protocol!=='https:'||!OFFICIAL_BINANCE_HOSTS.has(url.hostname)||
    url.pathname!=='/api/v3/klines'||
    url.searchParams.get('symbol')!==symbol||
    url.searchParams.get('interval')!=='15m'||
    url.searchParams.get('startTime')!==String(baselineCloseTime+1)||
    url.searchParams.get('endTime')!==String(baselineCloseTime+HORIZON_MS)||
    url.searchParams.get('limit')!=='96')
    return {valid:false,reason:'BINANCE_REST_REQUEST_PROVENANCE_MISMATCH'};
  let parsed;
  try{parsed=JSON.parse(result.responseBody);}
  catch{return {valid:false,reason:'BINANCE_REST_RESPONSE_JSON_INVALID'};}
  if(!Array.isArray(parsed)||JSON.stringify(parsed)!==JSON.stringify(result.data))
    return {valid:false,reason:'BINANCE_REST_PARSED_BODY_MISMATCH'};
  return {valid:true,requestUrl:url.toString(),responseSha256:actual,responseBody:result.responseBody};
}

/**
 * Optional research-only sidecar attached to Adaptive Trader's existing
 * closed-candle scan. It is disabled unless the caller explicitly enables it,
 * and it only writes paired forecast/result ledgers on DHDTech durable storage.
 */
export class DailyEarlyRiserForwardShadowRuntime{
  constructor({
    store,rest,modelBundles,logger=console,
    maxNewSymbolsPerCycle=4,maxResolutionsPerCycle=1
  }={}){
    if(!store||typeof store.appendDailyForwardShadowForecasts!=='function'||
      typeof store.appendDailyForwardShadowResolutions!=='function'||
      !store.files?.dailyForwardShadowForecasts||!store.files?.dailyForwardShadowResolved)
      throw new Error('DAILY_FORWARD_SHADOW_DURABLE_LEDGER_UNAVAILABLE');
    if(!rest||typeof rest.request!=='function')
      throw new Error('DAILY_FORWARD_SHADOW_BINANCE_REST_UNAVAILABLE');
    if(!(modelBundles instanceof Map)||!modelBundles.size)
      throw new Error('DAILY_FORWARD_SHADOW_VERIFIED_MODEL_BUNDLES_REQUIRED');
    this.store=store;this.rest=rest;this.modelBundles=modelBundles;this.logger=logger;
    this.maxNewSymbolsPerCycle=Math.max(1,Math.min(8,Math.trunc(Number(maxNewSymbolsPerCycle)||4)));
    this.maxResolutionsPerCycle=Math.max(1,Math.min(2,Math.trunc(Number(maxResolutionsPerCycle)||1)));
    this.initialized=false;this.initializing=null;
    this.latestAtByModelSymbol=new Map();
    this.seenPairIds=new Set();this.resolvedForecastIds=new Set();
    this.pendingPairs=new Map();
    this.lastError=null;this.lastCaptureAt=null;this.lastResolveAt=null;
    this.capturedPairs=0;this.resolvedPairs=0;this.ambiguousPairs=0;
    this.rejectedReasons={};
  }

  static async create({store,rest,modelBundleFile,logger=console,...options}={}){
    const file=String(modelBundleFile||'').trim();
    if(!file)throw new Error('DAILY_FORWARD_SHADOW_MODEL_BUNDLE_PATH_REQUIRED');
    const payload=JSON.parse(await readFile(file,'utf8'));
    const modelBundles=validateBundlePayload(payload);
    const service=new DailyEarlyRiserForwardShadowRuntime({
      store,rest,modelBundles,logger,...options
    });
    await service.initialize();
    return service;
  }

  reject(reason){
    const key=String(reason||'UNKNOWN').slice(0,120);
    this.rejectedReasons[key]=(this.rejectedReasons[key]||0)+1;
    this.lastError=key;
  }

  async initialize(){
    if(this.initialized)return this.snapshot();
    if(this.initializing)return this.initializing;
    this.initializing=(async()=>{
      const resolvedById=new Set();
      const resolvedPairs=new Map();
      for await(const row of jsonLines(this.store.files.dailyForwardShadowResolved)){
        if(row?.schema!==DAILY_FORWARD_SHADOW_SCHEMA||!isSha256(row.forecast_id))continue;
        this.resolvedForecastIds.add(row.forecast_id);
        resolvedById.add(row.forecast_id);
        if(isSha256(row.pair_id)){
          if(!resolvedPairs.has(row.pair_id))resolvedPairs.set(row.pair_id,[]);
          resolvedPairs.get(row.pair_id).push(row);
        }
      }
      for(const rows of resolvedPairs.values()){
        if(rows.length===2){
          if(rows.every(row=>row.status==='AMBIGUOUS'))this.ambiguousPairs++;
          else if(rows.every(row=>row.status==='RESOLVED'))this.resolvedPairs++;
        }
      }
      const restoredForecastPairs=new Set();
      for await(const row of jsonLines(this.store.files.dailyForwardShadowForecasts)){
        if(row?.schema!==DAILY_FORWARD_SHADOW_SCHEMA||!isSha256(row.pair_id)||
          !isSha256(row.forecast_id)||!isSha256(row.model_bundle_sha256)||
          !Number.isFinite(Number(row.at)))continue;
        const target=Number(row.target_pct);
        const bundle=this.modelBundles.get(target);
        if(!bundle||bundle.model_bundle_sha256!==row.model_bundle_sha256)continue;
        this.seenPairIds.add(row.pair_id);
        const symbol=cleanSymbol(row.symbol);
        const cadenceKey=symbol+'|'+row.model_bundle_sha256;
        const prior=this.latestAtByModelSymbol.get(cadenceKey);
        if(prior===undefined||Number(row.at)>prior)
          this.latestAtByModelSymbol.set(cadenceKey,Number(row.at));
        if(!restoredForecastPairs.has(row.pair_id)){
          restoredForecastPairs.add(row.pair_id);
          this.capturedPairs++;
        }
        if(row.status==='PENDING'&&!resolvedById.has(row.forecast_id)){
          if(!this.pendingPairs.has(row.pair_id))this.pendingPairs.set(row.pair_id,[]);
          const pendingRows=this.pendingPairs.get(row.pair_id);
          if(!pendingRows.some(existing=>existing.forecast_id===row.forecast_id))
            pendingRows.push(row);
        }
      }
      // Ignore incomplete, duplicated, mixed-model or already-resolved pairs.
      for(const [id,rows] of this.pendingPairs){
        const complete=rows.length===2&&
          rows.some(row=>row.model_variant==='DAILY_MLP_CHALLENGER_V1')&&
          rows.some(row=>row.model_variant==='SAME_WINDOW_LOGISTIC_BASELINE_V1')&&
          rows.every(row=>row.model_bundle_sha256===rows[0].model_bundle_sha256&&
            row.symbol===rows[0].symbol&&row.at===rows[0].at&&row.target_pct===rows[0].target_pct);
        if(!complete)this.pendingPairs.delete(id);
      }
      this.initialized=true;
      return this.snapshot();
    })().finally(()=>{this.initializing=null;});
    return this.initializing;
  }

  async captureCandidates(candidates,now=Date.now()){
    if(!this.initialized)await this.initialize();
    const atNow=finite(now)??Date.now();
    const ranked=(Array.isArray(candidates)?candidates:[])
      .filter(candidate=>candidate?.data_valid===true&&candidate?.data_stale!==true&&
        candidate?.closed_candles_only===true&&candidate?.daily_forward_context_ready===true&&
        candidate?.shock_move_audit_only!==true&&candidate?.candle_baseline&&candidate?.features)
      .sort((a,b)=>(Number(b.cognitive_rank_score??b.score)||0)-
        (Number(a.cognitive_rank_score??a.score)||0));
    const rowsToAppend=[],stagedPairs=[],stagedSymbols=new Set();
    let skippedInvalid=0,skippedCadence=0,skippedDuplicate=0;
    for(const candidate of ranked){
      if(stagedSymbols.size>=this.maxNewSymbolsPerCycle)break;
      const symbol=cleanSymbol(candidate.symbol);
      const at=finite(candidate.candle_close_time);
      const cutoff=finite(candidate.feature_information_cutoff_at);
      const baseline=candidate.candle_baseline;
      const quoteVolume=finite(candidate.features.quote_volume_24h);
      if(!symbol||at===null||cutoff!==at||!baseline||baseline.closeTime!==at||
        candidate.observation_source!=='BINANCE_OFFICIAL_CLOSED_15M_BASELINE'||
        candidate.candidate_status==='DATA_REJECTED'||
        quoteVolume===null||quoteVolume<MIN_QUOTE_VOLUME_USDT||
        atNow<=at||atNow-at>MAX_BASELINE_AGE_MS){
        skippedInvalid++;continue;
      }
      const features={...candidate.features};
      if(finite(features.daily_change_pct)===null||
        finite(features.relative_strength_vs_btc_24h_pct)===null&&features.relative_strength_vs_btc_24h_pct!==null){
        // Null BTC-relative 24h strength is permitted only when the feature key
        // is explicitly present; an absent field is a schema/data-contract gap.
        skippedInvalid++;continue;
      }
      const targetPairs=[];
      let candidateInvalid=false;
      for(const [target,bundle] of this.modelBundles.entries()){
        const identity=symbol+'|'+bundle.model_bundle_sha256;
        const lastAt=this.latestAtByModelSymbol.get(identity);
        if(lastAt!==undefined&&at-lastAt<HORIZON_MS){skippedCadence++;continue;}
        try{
          const pair=createDailyEarlyRiserForwardForecastPairFromModelBundle({
            model_bundle:bundle,model_bundle_sha256:bundle.model_bundle_sha256,
            symbol,at,feature_information_cutoff_at:cutoff,recorded_at:atNow,
            observation_source:candidate.observation_source,
            baseline,features
          });
          if(this.seenPairIds.has(pair[0].pair_id)||
            stagedPairs.some(item=>item.pairId===pair[0].pair_id)){
            skippedDuplicate++;continue;
          }
          targetPairs.push(pair);
        }catch(error){
          this.reject(String(error?.message??error));
          skippedInvalid++;candidateInvalid=true;break;
        }
      }
      if(targetPairs.length&&!candidateInvalid){
        stagedSymbols.add(symbol);
        for(const pair of targetPairs){
          const pairId=pair[0].pair_id;
          stagedPairs.push({pairId,pair,symbol,at,modelBundleSha:pair[0].model_bundle_sha256});
          rowsToAppend.push(...pair);
        }
      }
    }
    if(rowsToAppend.length){
      await this.store.appendDailyForwardShadowForecasts(rowsToAppend);
      for(const item of stagedPairs){
        this.seenPairIds.add(item.pairId);
        this.pendingPairs.set(item.pairId,item.pair);
        this.latestAtByModelSymbol.set(item.symbol+'|'+item.modelBundleSha,item.at);
        this.capturedPairs++;
      }
      this.lastCaptureAt=atNow;
    }
    return {
      status:'CAPTURED',
      candidate_count:ranked.length,
      new_paired_forecasts:stagedPairs.length,
      emitted_model_rows:rowsToAppend.length,
      skipped_invalid:skippedInvalid,skipped_daily_cadence:skippedCadence,
      skipped_duplicates:skippedDuplicate
    };
  }

  async resolveMatured(now=Date.now()){
    if(!this.initialized)await this.initialize();
    const atNow=finite(now)??Date.now();
    // All three target pairs for a symbol/baseline share one closed-candle
    // request. Grouping avoids tripling Binance REST traffic per observation.
    const byPath=new Map();
    for(const [pairId,rows] of this.pendingPairs.entries()){
      if(rows.length!==2||Number(rows[0].at)+HORIZON_MS>atNow||
        !rows.some(row=>!this.resolvedForecastIds.has(row.forecast_id)))continue;
      const pathKey=cleanSymbol(rows[0].symbol)+'|'+String(rows[0].at);
      if(!byPath.has(pathKey))byPath.set(pathKey,[]);
      byPath.get(pathKey).push({pairId,rows});
    }
    const due=[...byPath.entries()]
      .sort((a,b)=>Number(a[1][0].rows[0].at)-Number(b[1][0].rows[0].at))
      .slice(0,this.maxResolutionsPerCycle);
    const appended=[];
    let attempts=0,failed=0;
    for(const [pathKey,pairs] of due){
      const first=pairs[0].rows[0],symbol=cleanSymbol(first.symbol),at=Number(first.at);
      attempts++;
      try{
        const response=await this.rest.request('/api/v3/klines',{
          symbol,interval:'15m',startTime:at+1,endTime:at+HORIZON_MS,limit:96
        },{includeResponseBody:true});
        const provenance=validateClosedRestResponse(response,symbol,at);
        if(!provenance.valid){
          this.reject(provenance.reason);failed++;continue;
        }
        const future15m=JSON.parse(provenance.responseBody);
        const recordedAt=finite(response.receivedAt)??atNow;
        const pathResolved=[];
        for(const {pairId,rows} of pairs){
          const pairRows=[];
          for(const row of rows){
            if(this.resolvedForecastIds.has(row.forecast_id))continue;
            const result=resolveDailyEarlyRiserForwardForecast(row,{future15m,recorded_at:recordedAt});
            if(!result.accepted)
              throw new Error('DAILY_FORWARD_SHADOW_RESOLUTION_REJECTED:'+String(result.reason));
            pairRows.push({
              ...result.forecast,
              resolution_provenance:{
                source:'BINANCE_OFFICIAL_SPOT_REST_KLINES',
                request_url:provenance.requestUrl,http_status:200,
                response_sha256:provenance.responseSha256,
                recorded_at:recordedAt
              }
            });
          }
          // Recover safely if a process stopped during a two-row append and only
          // one model forecast reached the resolved ledger before restart.
          if(pairRows.length>0)pathResolved.push({pairId,pairRows});
        }
        const resolvedRows=pathResolved.flatMap(item=>item.pairRows);
        if(resolvedRows.length){
          await this.store.appendDailyForwardShadowResolutions(resolvedRows);
          for(const item of pathResolved){
            this.pendingPairs.delete(item.pairId);
            for(const row of item.pairRows)this.resolvedForecastIds.add(row.forecast_id);
            if(item.pairRows[0].status==='AMBIGUOUS')this.ambiguousPairs++;
            else this.resolvedPairs++;
          }
          appended.push(...resolvedRows);
        }
      }catch(error){
        this.reject(String(error?.message??error));
        failed++;
      }
    }
    if(appended.length)this.lastResolveAt=atNow;
    return {
      status:'RESOLUTION_CHECKED',due_pairs:due.length,attempted_paths:attempts,
      resolved_model_rows:appended.length,failed_paths:failed,
      pending_pairs:this.pendingPairs.size
    };
  }

  async processSnapshot(candidates,now=Date.now()){
    const capture=await this.captureCandidates(candidates,now);
    const resolution=await this.resolveMatured(now);
    return {capture,resolution,status:'RESEARCH_ONLY'};
  }

  snapshot(){
    return {
      enabled:true,mode:'READ_ONLY_PAIRED_FORWARD_SHADOW',
      model_targets:[...this.modelBundles.keys()].sort((a,b)=>a-b),
      model_bundle_hashes:Object.fromEntries([...this.modelBundles.entries()].map(([target,bundle])=>
        [String(target),bundle.model_bundle_sha256])),
      captured_pairs:this.capturedPairs,resolved_pairs:this.resolvedPairs,
      ambiguous_pairs:this.ambiguousPairs,pending_pairs:this.pendingPairs.size,
      last_capture_at:this.lastCaptureAt,last_resolve_at:this.lastResolveAt,
      last_error:this.lastError,rejections:{...this.rejectedReasons},
      real_order_execution:false,production_eligible:false
    };
  }
}
