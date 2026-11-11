#!/usr/bin/env node
import {createReadStream} from 'node:fs';
import {appendFile,mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import readline from 'node:readline';
import {
  createDailyEarlyRiserForwardForecastPairFromModelBundle,
  resolveDailyEarlyRiserForwardForecast,
  scoreDailyEarlyRiserForwardShadow,
  DAILY_FORWARD_SHADOW_SCHEMA,
  DAILY_FORWARD_SHADOW_MINIMUM_PAIRED_SAMPLES,
  DAILY_FORWARD_SHADOW_REQUIRED_BRIER_GAIN
} from '../core/daily-early-riser-forward-shadow.mjs';

const OBSERVATION_SCHEMA='RADARX_DAILY_FORWARD_OBSERVATION_V1';
const MIN_QUOTE_VOLUME_USDT=750000;
const DEFAULT_MAX_OBSERVATION_AGE_MS=30*60*1000;
const finite=value=>{
  if(value===null||value===undefined||value===''||typeof value==='boolean')return null;
  const number=Number(value);
  return Number.isFinite(number)?number:null;
};
const isSha256=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const keyOf=(symbol,at)=>String(symbol||'').trim().toUpperCase()+':'+String(at);

function parseArgs(argv){
  const values={};
  for(let index=0;index<argv.length;index++){
    if(!argv[index].startsWith('--'))continue;
    const key=argv[index].slice(2),value=argv[index+1];
    if(value===undefined||String(value).startsWith('--'))values[key]='true';
    else{values[key]=value;index++;}
  }
  return values;
}
async function* readJsonl(path){
  const input=createReadStream(path,{encoding:'utf8'});
  const lines=readline.createInterface({input,crlfDelay:Infinity});
  let lineNumber=0;
  for await(const line of lines){
    lineNumber++;
    if(!line.trim())continue;
    let value;
    try{value=JSON.parse(line);}
    catch(error){throw new Error('JSONL_PARSE_ERROR:'+path+':'+lineNumber+':'+error.message);}
    yield value;
  }
}
async function readJsonlArray(path){
  const rows=[];
  for await(const row of readJsonl(path))rows.push(row);
  return rows;
}
async function readExistingIds(path,field){
  const ids=new Set();
  try{
    await stat(path);
    for await(const row of readJsonl(path)){
      const value=String(row?.[field]||'');
      if(value)ids.add(value);
    }
  }catch(error){
    if(error?.code!=='ENOENT')throw error;
  }
  return ids;
}
function targetsFromReport(report,requestedTarget){
  const targets=requestedTarget===undefined
    ?[5,10,15]:[Number(requestedTarget)];
  const bundles=[];
  for(const target of targets){
    if(![5,10,15].includes(target))throw new Error('UNSUPPORTED_TARGET:'+target);
    const key=String(target)+'_PCT';
    const bundle=report.target_results?.[key]?.shadow_model_export;
    if(!bundle||bundle.enabled!==true||!isSha256(bundle.model_bundle_sha256))
      throw new Error('VERIFIED_SHADOW_MODEL_BUNDLE_UNAVAILABLE:'+key);
    bundles.push({target,bundle,hash:bundle.model_bundle_sha256});
  }
  return bundles;
}
async function loadReport(path){
  const report=JSON.parse(await readFile(path,'utf8'));
  if(report.status!=='COMPLETED_RESEARCH_ONLY'||
    report.production_touched===true||report.deployed===true||report.merged===true||
    report.real_order_execution===true)
    throw new Error('MODEL_REPORT_NOT_RESEARCH_ONLY_OR_NOT_COMPLETED');
  return report;
}
async function ensureOutputDirectory(path){
  await mkdir(dirname(resolve(path)),{recursive:true});
}
function writeSummary(value){
  process.stdout.write(JSON.stringify(value,null,2)+'\n');
}

async function recordMode(args){
  const reportPath=resolve(args['model-report']||'artifacts/daily-early-riser-neural-benchmark.json');
  const observationsPath=resolve(args.observations||'artifacts/daily-forward-observations.jsonl');
  const outputPath=resolve(args.output||'artifacts/daily-forward-forecasts.jsonl');
  const report=await loadReport(reportPath);
  const bundles=targetsFromReport(report,args.target);
  const maxAge=Math.max(60_000,Math.trunc(finite(args['maximum-observation-age-ms'])??DEFAULT_MAX_OBSERVATION_AGE_MS));
  const minVolume=Math.max(MIN_QUOTE_VOLUME_USDT,finite(args['minimum-quote-volume-usdt'])??MIN_QUOTE_VOLUME_USDT);
  const seenPairs=await readExistingIds(outputPath,'pair_id');
  const records=[],rejections={};
  let observations=0,duplicatePairs=0,createdPairs=0;
  const reject=reason=>{rejections[reason]=(rejections[reason]||0)+1;};
  const now=Date.now();
  for await(const observation of readJsonl(observationsPath)){
    observations++;
    if(observation?.schema!==OBSERVATION_SCHEMA){reject('OBSERVATION_SCHEMA_MISMATCH');continue;}
    const at=finite(observation.at),recorded=finite(observation.recorded_at)??now;
    if(at===null||finite(observation.feature_information_cutoff_at)!==at||
      recorded<=at||at>now+60_000||now-at>maxAge||recorded-at>maxAge){
      reject('OBSERVATION_TIME_OR_CLOSED_CANDLE_CUTOFF_INVALID');continue;
    }
    const volume=finite(observation.features?.quote_volume_24h);
    if(volume===null||volume<minVolume){reject('MINIMUM_24H_QUOTE_VOLUME_NOT_MET');continue;}
    const before=records.length;
    let rejected=false;
    for(const {target,bundle,hash} of bundles){
      try{
        const pair=createDailyEarlyRiserForwardForecastPairFromModelBundle({
          model_bundle:bundle,model_bundle_sha256:hash,
          symbol:observation.symbol,at,
          feature_information_cutoff_at:observation.feature_information_cutoff_at,
          recorded_at:recorded,
          observation_source:observation.observation_source,
          baseline:observation.baseline,features:observation.features
        });
        const pairId=pair[0].pair_id;
        if(seenPairs.has(pairId)){duplicatePairs++;continue;}
        seenPairs.add(pairId);
        records.push(...pair);
        createdPairs++;
      }catch(error){
        reject(String(error?.message||'FORWARD_FORECAST_REJECTED'));
        rejected=true;
      }
    }
    if(rejected&&records.length===before)continue;
  }
  if(records.length){
    await ensureOutputDirectory(outputPath);
    await appendFile(outputPath,records.map(row=>JSON.stringify(row)).join('\n')+'\n');
  }
  writeSummary({
    schema:DAILY_FORWARD_SHADOW_SCHEMA,mode:'RECORD',
    model_report:reportPath,observations_path:observationsPath,output_path:outputPath,
    observation_rows:observations,created_paired_forecasts:createdPairs,
    emitted_model_forecast_rows:records.length,skipped_duplicate_pairs:duplicatePairs,
    rejected_observations:rejections,minimum_quote_volume_usdt:minVolume,
    maximum_observation_age_ms:maxAge,immutable_append_only:true,
    production_eligible:false,real_order_execution:false
  });
}

async function resolveMode(args){
  const forecastsPath=resolve(args.forecasts||'artifacts/daily-forward-forecasts.jsonl');
  const pathsPath=resolve(args['closed-paths']||'artifacts/daily-forward-closed-paths.jsonl');
  const outputPath=resolve(args.output||'artifacts/daily-forward-resolved.jsonl');
  const [forecasts,paths]=await Promise.all([readJsonlArray(forecastsPath),readJsonlArray(pathsPath)]);
  const pathMap=new Map();
  for(const row of paths){
    const symbol=String(row?.symbol||'').trim().toUpperCase();
    const at=finite(row?.baseline_close_time);
    if(!symbol||at===null||!Array.isArray(row.future15m))continue;
    const key=keyOf(symbol,at);
    if(pathMap.has(key))throw new Error('DUPLICATE_CLOSED_PATH:'+key);
    pathMap.set(key,row);
  }
  const existing=await readExistingIds(outputPath,'forecast_id');
  const appended=[],rejections={};
  let pending=0,ambiguous=0,resolved=0,duplicateResolutions=0;
  for(const forecast of forecasts){
    if(forecast?.schema!==DAILY_FORWARD_SHADOW_SCHEMA||forecast.status!=='PENDING')continue;
    if(existing.has(forecast.forecast_id)){duplicateResolutions++;continue;}
    const path=pathMap.get(keyOf(forecast.symbol,forecast.at));
    if(!path){pending++;continue;}
    const result=resolveDailyEarlyRiserForwardForecast(forecast,{
      future15m:path.future15m,recorded_at:finite(path.recorded_at)??Date.now()
    });
    if(!result.accepted){
      const reason=result.reason||'RESOLUTION_REJECTED';
      rejections[reason]=(rejections[reason]||0)+1;
      continue;
    }
    appended.push(result.forecast);
    existing.add(result.forecast.forecast_id);
    if(result.forecast.status==='AMBIGUOUS')ambiguous++;
    else resolved++;
  }
  if(appended.length){
    await ensureOutputDirectory(outputPath);
    await appendFile(outputPath,appended.map(row=>JSON.stringify(row)).join('\n')+'\n');
  }
  writeSummary({
    schema:DAILY_FORWARD_SHADOW_SCHEMA,mode:'RESOLVE',
    forecasts_path:forecastsPath,closed_paths_path:pathsPath,output_path:outputPath,
    forecast_rows:forecasts.length,closed_path_rows:paths.length,
    appended_resolutions:appended.length,resolved,ambiguous,pending_without_path:pending,
    duplicate_resolutions_skipped:duplicateResolutions,rejections,
    immutable_source_forecasts_preserved:true,
    production_eligible:false,real_order_execution:false
  });
}

async function scoreMode(args){
  const inputPath=resolve(args.resolved||'artifacts/daily-forward-resolved.jsonl');
  const outputPath=args.output?resolve(args.output):null;
  const target=finite(args.target),bundleSha=args['model-bundle-sha256'];
  if(target===null||!isSha256(bundleSha))throw new Error('SCORE_MODE_REQUIRES_TARGET_AND_MODEL_BUNDLE_SHA256');
  const rows=await readJsonlArray(inputPath);
  const score=scoreDailyEarlyRiserForwardShadow(rows,{
    target_pct:target,model_bundle_sha256:bundleSha,
    minimum_paired_samples:DAILY_FORWARD_SHADOW_MINIMUM_PAIRED_SAMPLES,
    required_brier_gain:DAILY_FORWARD_SHADOW_REQUIRED_BRIER_GAIN
  });
  if(outputPath){
    await ensureOutputDirectory(outputPath);
    await writeFile(outputPath,JSON.stringify(score,null,2)+'\n');
  }
  writeSummary({
    mode:'SCORE',input_path:inputPath,output_path:outputPath,
    score
  });
}

async function main(){
  const args=parseArgs(process.argv.slice(2));
  const mode=String(args.mode||'').toLowerCase();
  if(mode==='record')return recordMode(args);
  if(mode==='resolve')return resolveMode(args);
  if(mode==='score')return scoreMode(args);
  throw new Error('USAGE: --mode record|resolve|score (see repository research notes)');
}
main().catch(error=>{
  process.stderr.write(String(error?.stack||error)+'\n');
  process.exitCode=1;
});
