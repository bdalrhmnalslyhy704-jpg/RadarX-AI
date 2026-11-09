#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {
  normalizeBinanceSpotKlineArchiveTimestamp,
  parseBinanceSpotKlineArchiveCsv,
  listBinanceSpotArchiveMonths
} from '../core/binance-spot-kline-archive.mjs';
import {
  buildAdaptiveTraderHistoricalOutcomeSamples,
  HISTORICAL_TRAINING_SAMPLES_PER_SYMBOL
} from '../core/adaptive-trader-engine.mjs';
import {
  isDirectionalCandidateSymbol,
  isTokenizedSecurityCandidateSymbol
} from '../core/market-wide-light-scan.mjs';
import {
  buildCognitiveLearningProfile
} from '../core/cognitive-brain.mjs';
import {TEMPORAL_TARGET_DEFINITION} from '../core/temporal-neural-brain.mjs';

const execFile=promisify(execFileCallback);
const API_ROOT='https://data-api.binance.vision';
const ARCHIVE_ROOT='https://data.binance.vision/data/spot/monthly/klines';
const FOUR_HOURS_MS=4*60*60*1000;
const FIFTEEN_MINUTES_MS=15*60*1000;
const FIVE_MINUTES_MS=5*60*1000;
const MIN_QUOTE_VOLUME_24H=750000;
const MAX_ARCHIVE_BYTES=64*1024*1024;
const MAX_UNZIPPED_BYTES=64*1024*1024;
const DEFAULT_START='2025-11-01T00:00:00.000Z';
const DEFAULT_END_EXCLUSIVE='2026-11-01T00:00:00.000Z';
const REQUEST_AUDIT=[];
const OUTPUT_PATH=resolve(process.env.RADARX_COGNITIVE_BENCHMARK_REPORT||
  'artifacts/cognitive-market-wide-historical-benchmark.json');
const SAMPLE_PATH=resolve(process.env.RADARX_COGNITIVE_BENCHMARK_SAMPLES||
  'artifacts/cognitive-market-wide-historical-samples.jsonl');
const delay=ms=>new Promise(resolveDelay=>setTimeout(resolveDelay,ms));
const finite=value=>{
  if(value===null||value===undefined||value==='')return null;
  const n=Number(value);
  return Number.isFinite(n)?n:null;
};
const sha256=value=>createHash('sha256').update(value).digest('hex');

function parseArgs(argv){
  const values={};
  for(let index=0;index<argv.length;index++){
    const item=argv[index];
    if(!item.startsWith('--'))continue;
    const key=item.slice(2);
    const value=argv[index+1];
    if(value===undefined||String(value).startsWith('--'))values[key]='true';
    else{values[key]=value;index++;}
  }
  return values;
}
function parseUtc(value,label){
  const parsed=Date.parse(String(value||''));
  if(!Number.isFinite(parsed))throw new Error('INVALID_'+label.toUpperCase());
  return parsed;
}
function safeSymbol(value){
  const symbol=String(value||'').trim().toUpperCase();
  return /^[A-Z0-9]{5,30}$/.test(symbol)?symbol:null;
}
function isLeveragedToken(symbol){
  return /(?:UP|DOWN|BULL|BEAR)USDT$/.test(String(symbol||'').toUpperCase());
}
function sleepBackoff(attempt){
  return delay(Math.min(15000,500*Math.pow(2,attempt)));
}
async function fetchResponse(url,{timeoutMs=90000,retries=4,headers={}}={}){
  let lastError=null;
  for(let attempt=0;attempt<retries;attempt++){
    const audit={url,attempt:attempt+1,started_at:new Date().toISOString(),status:null};
    REQUEST_AUDIT.push(audit);
    try{
      const response=await fetch(url,{
        headers:{accept:'application/json, application/octet-stream, text/plain',...headers},
        signal:AbortSignal.timeout(timeoutMs)
      });
      audit.status=response.status;
      audit.finished_at=new Date().toISOString();
      if(response.status===404)return response;
      if(response.status===418||response.status===429||response.status>=500){
        lastError=new Error('HTTP_'+response.status);
        if(attempt+1<retries){
          const retryAfter=Number(response.headers.get('retry-after'));
          if(Number.isFinite(retryAfter)&&retryAfter>0)
            await delay(Math.min(60000,retryAfter*1000));
          else await sleepBackoff(attempt);
          continue;
        }
      }
      return response;
    }catch(error){
      audit.error=String(error?.message||error).slice(0,180);
      audit.finished_at=new Date().toISOString();
      lastError=error;
      if(attempt+1<retries)await sleepBackoff(attempt);
    }
  }
  throw new Error('FETCH_FAILED:'+String(lastError?.message||lastError||url).slice(0,180));
}
async function getJson(url){
  const response=await fetchResponse(url,{timeoutMs:30000});
  if(!response.ok)throw new Error('BINANCE_API_HTTP_'+response.status+':'+url.split('?')[0]);
  return response.json();
}
function archiveUrl(symbol,interval,month){
  return ARCHIVE_ROOT+'/'+symbol+'/'+interval+'/'+symbol+'-'+interval+'-'+month+'.zip';
}
async function fetchVerifiedMonthlyArchive({symbol,interval,month,tempDir}){
  const url=archiveUrl(symbol,interval,month);
  const checksumResponse=await fetchResponse(url+'.CHECKSUM',{timeoutMs:30000});
  if(checksumResponse.status===404)
    return {status:'MISSING',reason:'CHECKSUM_404',symbol,interval,month,url};
  if(!checksumResponse.ok)
    throw new Error('CHECKSUM_HTTP_'+checksumResponse.status+':'+symbol+':'+interval+':'+month);
  const checksumText=await checksumResponse.text();
  const expected=checksumText.match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase();
  if(!expected)throw new Error('OFFICIAL_CHECKSUM_INVALID:'+symbol+':'+interval+':'+month);
  const archiveResponse=await fetchResponse(url,{timeoutMs:120000});
  if(archiveResponse.status===404)
    return {status:'MISSING',reason:'ARCHIVE_404',symbol,interval,month,url};
  if(!archiveResponse.ok)
    throw new Error('ARCHIVE_HTTP_'+archiveResponse.status+':'+symbol+':'+interval+':'+month);
  const announced=Number(archiveResponse.headers.get('content-length'));
  if(Number.isFinite(announced)&&announced>MAX_ARCHIVE_BYTES)
    throw new Error('ARCHIVE_SIZE_LIMIT:'+symbol+':'+interval+':'+month);
  const bytes=Buffer.from(await archiveResponse.arrayBuffer());
  if(!bytes.length||bytes.length>MAX_ARCHIVE_BYTES)
    throw new Error('ARCHIVE_SIZE_INVALID:'+symbol+':'+interval+':'+month);
  const actual=sha256(bytes);
  if(actual!==expected)
    throw new Error('ARCHIVE_SHA256_MISMATCH:'+symbol+':'+interval+':'+month);
  const path=join(tempDir,symbol+'-'+interval+'-'+month+'.zip');
  await writeFile(path,bytes,{flag:'wx'});
  let csv;
  try{
    const result=await execFile('unzip',['-p',path],{
      encoding:'utf8',maxBuffer:MAX_UNZIPPED_BYTES,timeout:120000
    });
    csv=result.stdout;
  }finally{
    await rm(path,{force:true}).catch(()=>{});
  }
  const intervalMs=interval==='15m'?FIFTEEN_MINUTES_MS:FIVE_MINUTES_MS;
  const parsed=parseBinanceSpotKlineArchiveCsv(csv,{intervalMs});
  return {
    status:'VERIFIED',symbol,interval,month,url,sha256:actual,
    compressed_bytes:bytes.length,row_count:parsed.rows.length,
    rejected:parsed.rejected,continuity_ratio:parsed.continuity_ratio,
    rows:parsed.rows
  };
}
async function loadSymbolInterval({symbol,interval,months,tempDir}){
  const rowsByOpen=new Map();
  const files=[];
  const totalRejected={malformed:0,invalid_timestamp:0,invalid_price_or_volume:0,
    invalid_close_boundary:0,duplicate_open_time:0};
  for(const month of months){
    const archive=await fetchVerifiedMonthlyArchive({symbol,interval,month,tempDir});
    const {rows,...manifest}=archive;
    files.push(manifest);
    if(archive.status!=='VERIFIED')continue;
    for(const [key,value] of Object.entries(archive.rejected||{}))
      totalRejected[key]=(totalRejected[key]||0)+Number(value||0);
    for(const row of rows)rowsByOpen.set(Number(row[0]),row);
  }
  const rows=[...rowsByOpen.entries()].sort((a,b)=>a[0]-b[0]).map(([,row])=>row);
  return {
    rows,files,total_rejected:totalRejected,
    verified_months:files.filter(file=>file.status==='VERIFIED').length,
    missing_months:files.filter(file=>file.status!=='VERIFIED').length
  };
}
async function mapLimit(items,limit,worker){
  const results=new Array(items.length);
  let next=0;
  const workers=Array.from({length:Math.max(1,Math.min(limit,items.length||1))},async()=>{
    while(true){
      const index=next++;
      if(index>=items.length)return;
      results[index]=await worker(items[index],index);
    }
  });
  await Promise.all(workers);
  return results;
}
function isValidTrainingSample(row){
  const sequence=row?.temporal_sequence;
  return row?.training_eligible===true&&row?.historical_baseline===true&&
    row?.target_definition===TEMPORAL_TARGET_DEFINITION&&
    row?.outcome_source==='HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1'&&
    ['UP','DOWN','FLAT'].includes(row?.outcome)&&
    row?.first_passage?.path_resolution==='15M'&&
    row?.first_passage?.outcome===row?.outcome&&
    Number(row?.resolved_at)-Number(row?.at)===FOUR_HOURS_MS&&
    Number(row?.horizon_ms)===FOUR_HOURS_MS&&
    Array.isArray(sequence)&&sequence.length===24&&
    sequence.every(step=>Array.isArray(step)&&step.length===29&&step.every(Number.isFinite));
}
function countBy(items,keyOf){
  const out={};
  for(const item of items){
    const key=String(keyOf(item));
    out[key]=(out[key]||0)+1;
  }
  return Object.fromEntries(Object.entries(out).sort((a,b)=>a[0].localeCompare(b[0])));
}
function metricSummary(metric){
  if(!metric||typeof metric!=='object')return null;
  return {
    evaluated:metric.evaluated===true,
    sample_count:Number(metric.sample_count)||0,
    model_brier_score:finite(metric.model_brier_score),
    base_rate_brier_score:finite(metric.base_rate_brier_score),
    log_loss:finite(metric.log_loss),
    beat_base_rate:metric.beat_base_rate===true,
    required_brier_margin:finite(metric.required_brier_margin),
    improvement_vs_base_rate:finite(metric.improvement_vs_base_rate),
    ranking_metrics:metric.ranking_metrics||null,
    reason:metric.reason||null
  };
}
function summarizeRegimeSpecialists(specialists){
  const out={};
  for(const [regime,row] of Object.entries(specialists||{})){
    out[regime]={
      status:row?.status||null,
      training_samples:Number(row?.training_samples)||0,
      member_selection_samples:Number(row?.member_selection_samples)||0,
      calibration_samples:Number(row?.calibration_samples)||0,
      validation_samples:Number(row?.validation_samples)||0,
      holdout_samples:Number(row?.holdout_samples)||0,
      trained:row?.trained===true,
      selected:row?.selected===true,
      probability_ready:row?.probability_ready===true,
      neural_residual_contributes:row?.neural_residual_contributes===true,
      selected_residual_scale:finite(row?.selected_residual_scale),
      validation:metricSummary(row?.validation),
      validation_logistic:metricSummary(row?.validation_logistic),
      holdout:metricSummary(row?.holdout),
      holdout_logistic:metricSummary(row?.holdout_logistic)
    };
  }
  return out;
}
function summarizeProfile(profile){
  const temporal=profile?.temporal_network||{};
  const neural=profile?.neural_network||{};
  const boosted=profile?.boosted_tree_model||{};
  const hybrid=profile?.hybrid_model||{};
  return {
    method:profile?.method||null,
    feature_schema:profile?.feature_schema||null,
    identifier_features_used:profile?.identifier_features_used===true,
    resolved_samples:Number(profile?.resolved_samples)||0,
    training_samples:Number(profile?.training_samples)||0,
    validation_samples:Number(profile?.validation_samples)||0,
    holdout_samples:Number(profile?.holdout_samples)||0,
    max_training_outcome_resolved_at:profile?.max_training_outcome_resolved_at??null,
    validation_start_at:profile?.validation_start_at??null,
    holdout_start_at:profile?.holdout_start_at??null,
    comparison_contract:profile?.comparison_contract||null,
    probability_ready:profile?.probability_ready===true,
    model_selection:profile?.model_selection||null,
    neural_network:{
      status:neural.status||null,architecture:neural.architecture||null,
      trained:neural.trained===true,selected:neural.selected===true,
      probability_ready:neural.probability_ready===true,
      live_eligibility_ready:neural.live_eligibility_ready===true,
      training_samples:Number(neural.training_samples)||0,
      ensemble_members:Number(neural.ensemble_members)||0,
      validation:metricSummary(neural.validation),
      holdout:metricSummary(neural.holdout),
      validation_comparison:neural.validation_comparison||null,
      holdout_comparison:neural.holdout_comparison||null,
      probability_calibration:neural.probability_calibration||null
    },
    boosted_tree_model:{
      status:boosted.status||null,trained:boosted.trained===true,
      selected:boosted.selected===true,probability_ready:boosted.probability_ready===true,
      tree_count:Number(boosted.tree_count)||0,
      selected_configuration:boosted.selected_configuration||null,
      candidate_selection_metrics:boosted.candidate_selection_metrics||[],
      validation:metricSummary(boosted.validation),
      holdout:metricSummary(boosted.holdout),
      holdout_comparison:boosted.holdout_comparison||null,
      probability_calibration:boosted.probability_calibration||null,
      feature_importance:Array.isArray(boosted.feature_importance)?boosted.feature_importance.slice(0,12):[]
    },
    hybrid_model:{
      status:hybrid.status||null,trained:hybrid.trained===true,
      selected:hybrid.selected===true,probability_ready:hybrid.probability_ready===true,
      selection_winner_candidate:hybrid.selection_winner_candidate||null,
      boosted_weight:finite(hybrid.boosted_weight),
      selection_samples:Number(hybrid.selection_samples)||0,
      selection_start_at:hybrid.selection_start_at??null,
      selection_supported:hybrid.selection_supported===true,
      selection_logistic_brier_score:finite(hybrid.selection_logistic_brier_score),
      candidate_selection_metrics:hybrid.candidate_selection_metrics||[],
      candidate_validation_metrics:hybrid.candidate_validation_metrics||[],
      validation:metricSummary(hybrid.validation),
      holdout:metricSummary(hybrid.holdout),
      holdout_comparison:hybrid.holdout_comparison||null,
      probability_calibration:hybrid.probability_calibration||null
    },
    temporal_network:{
      status:temporal.status||null,architecture:temporal.architecture||null,
      target_definition:temporal.target_definition||null,
      training_strategy:temporal.training_strategy||null,
      model_split_scope:temporal.model_split_scope||null,
      model_scope:temporal.model_scope||null,
      sequence_steps:Number(temporal.sequence_steps)||0,
      sequence_channels:Number(temporal.sequence_channels)||0,
      resolved_samples:Number(temporal.resolved_samples)||0,
      training_samples:Number(temporal.training_samples)||0,
      validation_samples:Number(temporal.validation_samples)||0,
      holdout_samples:Number(temporal.holdout_samples)||0,
      ensemble_members:Number(temporal.ensemble_members)||0,
      trained:temporal.trained===true,selected:temporal.selected===true,
      probability_ready:temporal.probability_ready===true,
      live_eligibility_ready:temporal.live_eligibility_ready===true,
      validation:metricSummary(temporal.validation),
      holdout:metricSummary(temporal.holdout),
      holdout_comparison:temporal.holdout_comparison||null,
      supported_regimes:temporal.supported_regimes||[],
      selected_regimes:temporal.selected_regimes||[],
      regime_specialists:summarizeRegimeSpecialists(temporal.regime_specialists),
      temporal_boosted_tree:temporal.temporal_boosted_tree?{
        status:temporal.temporal_boosted_tree.status||null,
        trained:temporal.temporal_boosted_tree.trained===true,
        research_out_of_sample_validated:temporal.temporal_boosted_tree.research_out_of_sample_validated===true,
        probability_ready:temporal.temporal_boosted_tree.probability_ready===true,
        training_samples:Number(temporal.temporal_boosted_tree.training_samples)||0,
        validation:metricSummary(temporal.temporal_boosted_tree.validation),
        holdout:metricSummary(temporal.temporal_boosted_tree.holdout),
        holdout_comparison:temporal.temporal_boosted_tree.holdout_comparison||null
      }:null
    }
  };
}
function sampleAudit(rows){
  const ids=new Set(),bySymbol=new Map(),validRows=[];
  let duplicates=0,invalid=0,validSequences=0;
  for(const row of rows){
    const id=String(row?.id||'');
    if(!id||ids.has(id)){duplicates++;continue;}
    ids.add(id);
    if(!isValidTrainingSample(row)){invalid++;continue;}
    validRows.push(row);
    if(Array.isArray(row.temporal_sequence))validSequences++;
    const symbol=String(row.symbol);
    if(!bySymbol.has(symbol))bySymbol.set(symbol,[]);
    bySymbol.get(symbol).push(Number(row.at));
  }
  let spacingViolations=0;
  for(const times of bySymbol.values()){
    times.sort((a,b)=>a-b);
    for(let index=1;index<times.length;index++)
      if(times[index]-times[index-1]<FOUR_HOURS_MS)spacingViolations++;
  }
  return {
    observed_rows:rows.length,unique_ids:ids.size,duplicate_ids:duplicates,
    invalid_samples:invalid,valid_samples:validRows.length,
    valid_temporal_sequences:validSequences,
    per_symbol_4h_spacing_violations:spacingViolations,
    outcome_counts:countBy(validRows,row=>row.outcome),
    sample_month_counts:countBy(validRows,
      row=>new Date(Number(row.at)).toISOString().slice(0,7)),
    symbols_with_samples:bySymbol.size
  };
}
function csvEscape(value){
  const raw=String(value??'');
  return '"'+raw.replace(/"/g,'""')+'"';
}
function writeSampleJsonl(samples){
  return samples.map(row=>JSON.stringify({
    id:row.id,symbol:row.symbol,at:row.at,at_utc:new Date(row.at).toISOString(),
    resolved_at:row.resolved_at,resolved_at_utc:new Date(row.resolved_at).toISOString(),
    outcome:row.outcome,return_pct:row.return_pct,close_return_pct:row.close_return_pct,
    base_score:row.base_score,tier:row.tier,quote_volume_24h:row.quote_volume_24h,
    change_24h_pct:row.change_24h_pct,target_definition:row.target_definition,
    first_passage:row.first_passage,features:row.features,
    temporal_sequence_steps:row.temporal_sequence?.length||0,
    temporal_sequence_channels:row.temporal_sequence?.[0]?.length||0
  })).join('\n')+'\n';
}
async function main(){
  const args=parseArgs(process.argv.slice(2));
  const startText=args.start||DEFAULT_START;
  const endText=args['end-exclusive']||DEFAULT_END_EXCLUSIVE;
  const startMs=parseUtc(startText,'START_DATE');
  const endExclusiveMs=parseUtc(endText,'END_DATE');
  if(endExclusiveMs<=startMs)throw new Error('END_MUST_BE_AFTER_START');
  const months=listBinanceSpotArchiveMonths(startMs,endExclusiveMs);
  const concurrency=Math.max(1,Math.min(12,Math.trunc(Number(args.concurrency)||6)));
  const requestedMaxSymbols=Math.max(0,Math.trunc(Number(args['max-symbols'])||0));
  const minSymbols=Math.max(1,Math.trunc(Number(args['min-symbols'])||80));
  const minSamples=Math.max(1,Math.trunc(Number(args['min-samples'])||6000));
  const minSequences=Math.max(1,Math.trunc(Number(args['min-sequences'])||3000));
  const output=resolve(args.output||OUTPUT_PATH);
  const sampleOutput=resolve(args['samples-output']||SAMPLE_PATH);
  const outputDir=resolve(output,'..');
  await mkdir(outputDir,{recursive:true});
  const tempDir=await mkdtemp(join(tmpdir(),'radarx-cognitive-market-replay-'));
  const started=Date.now();
  const archiveManifest=[];
  const symbolFailures=[];
  const requestAudit=[];
  const baseReport={
    schema:'RADARX_COGNITIVE_MARKET_WIDE_HISTORICAL_BENCHMARK_V1',
    status:'INITIALIZING',
    created_at:new Date(started).toISOString(),
    methodology:{
      market:'BINANCE_SPOT_USDT_ONLY',
      data_source:'OFFICIAL_BINANCE_PUBLIC_DATA_MONTHLY_KLINE_ARCHIVES',
      intervals:['15m','5m'],
      target_definition:TEMPORAL_TARGET_DEFINITION,
      outcome:'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_WITHIN_4H',
      label_resolution:'CLOSED_15M_CANDLES_ONLY',
      features_use_future_data:false,
      outcome_uses_strictly_later_candles:true,
      sample_phase:'SYMBOL_STABLE_ABSOLUTE_4H_GRID',
      historical_volume_eligibility_usdt:MIN_QUOTE_VOLUME_24H,
      samples_per_symbol:HISTORICAL_TRAINING_SAMPLES_PER_SYMBOL,
      archive_checksum:'OFFICIAL_SHA256_REQUIRED',
      model_selection:'NESTED_CHRONOLOGICAL_SELECTION_CALIBRATION_VALIDATION_AND_UNTOUCHED_HOLDOUT',
      holdout_policy:'ONE_VALIDATION_WINNER_ONLY_NO_RUNNER_UP_AFTER_HOLDOUT',
      trading_policy:{paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'},
      limitations:[
        'The historical universe is reconstructed from symbols trading on Binance Spot at the run date; delisted symbols are not discoverable from current exchangeInfo and survivorship bias remains.',
        'Historical eligibility is reconstructed per decision from the preceding 96 closed 15m candles and the 750,000 USDT 24h quote-volume floor.',
        'This experiment measures predictive first-passage quality, not net trading profitability; a separate cost-aware execution replay is required.',
        'No exchange orders are submitted and no production service is contacted.'
      ]
    },
    window:{start:startText,end_exclusive:endText,months},
    universe:{current_spot_usdt_symbols:0,directional_crypto_symbols:0,selected_symbols:0,
      symbol_universe_scope:'CURRENTLY_TRADING_SPOT_USDT_SURVIVORS_ONLY'},
    data_quality:{status:'NOT_EVALUATED',minimum_symbols:minSymbols,
      minimum_samples:minSamples,minimum_temporal_sequences:minSequences,
      symbols_with_samples:0,samples:0,temporal_sequence_samples:0,
      archive_files_expected:0,archive_files_verified:0,archive_files_missing:0,
      archive_coverage_ratio:0,invalid_samples:0,duplicate_ids:0,
      spacing_violations:0,features_and_labels_audited:false},
    models:{status:'NOT_RUN'},
    archive_manifest:archiveManifest,
    symbol_failures:symbolFailures,
    request_audit:REQUEST_AUDIT
  };
  try{
    const exchangeInfo=await getJson(API_ROOT+'/api/v3/exchangeInfo');
    if(!Array.isArray(exchangeInfo?.symbols))throw new Error('EXCHANGE_INFO_SYMBOLS_INVALID');
    const allSpot=exchangeInfo.symbols.filter(row=>row.status==='TRADING'&&
      row.quoteAsset==='USDT'&&row.isSpotTradingAllowed!==false);
    const universe=[...new Set(allSpot.map(row=>safeSymbol(row.symbol)).filter(Boolean)
      .filter(symbol=>isDirectionalCandidateSymbol(symbol)&&
        !isTokenizedSecurityCandidateSymbol(symbol)&&!isLeveragedToken(symbol)))].sort();
    if(!universe.includes('BTCUSDT'))universe.unshift('BTCUSDT');
    const symbols=requestedMaxSymbols>0?universe.slice(0,requestedMaxSymbols):universe;
    baseReport.universe={
      as_of:new Date().toISOString(),
      exchange_info_spot_usdt_symbols:allSpot.length,
      current_spot_usdt_symbols:allSpot.length,
      directional_crypto_symbols:universe.length,
      selected_symbols:symbols.length,
      symbol_universe_scope:'CURRENTLY_TRADING_SPOT_USDT_SURVIVORS_ONLY',
      current_symbol_list_sha256:sha256(universe.join('\n'))
    };
    console.log('[HISTORICAL_UNIVERSE] '+JSON.stringify({symbols:symbols.length,months:months.length,window:{start:startText,end_exclusive:endText},concurrency}));
    if(!symbols.includes('BTCUSDT'))throw new Error('BTCUSDT_NOT_IN_RESEARCH_UNIVERSE');

    const [btc15,btc5]=await Promise.all([
      loadSymbolInterval({symbol:'BTCUSDT',interval:'15m',months,tempDir}),
      loadSymbolInterval({symbol:'BTCUSDT',interval:'5m',months,tempDir})
    ]);
    for(const file of [...btc15.files,...btc5.files])archiveManifest.push(file);
    if(btc15.rows.length<300||btc5.rows.length<300)
      throw new Error('BTC_ARCHIVE_HISTORY_INSUFFICIENT');
    console.log('[BTC_ARCHIVE_READY] '+JSON.stringify({rows_15m:btc15.rows.length,rows_5m:btc5.rows.length,verified_months_15m:btc15.verified_months,verified_months_5m:btc5.verified_months}));
    const btcKlines={data:btc15.rows,source:'BINANCE_OFFICIAL_ARCHIVE'};
    const btcFastKlines={data:btc5.rows,source:'BINANCE_OFFICIAL_ARCHIVE'};

    let completedSymbols=0;
    const emitSymbol=result=>{
      completedSymbols++;
      console.log('[HISTORICAL_SYMBOL_PROGRESS] '+JSON.stringify({completed:completedSymbols,total:symbols.length,symbol:result.symbol,status:result.status||'PROCESSED',samples:result.samples||0,temporal_sequences:result.temporal_sequences||0}));
      return result;
    };
    const symbolResults=await mapLimit(symbols,concurrency,async symbol=>{
      console.log('[HISTORICAL_SYMBOL_START] '+symbol);
      if(symbol==='BTCUSDT'){
        const samples=buildAdaptiveTraderHistoricalOutcomeSamples({
          symbol,klines:btcKlines,fastKlines:btcFastKlines,btcKlines,
          now:endExclusiveMs,minQuoteVolume24h:MIN_QUOTE_VOLUME_24H,
          maxSamples:HISTORICAL_TRAINING_SAMPLES_PER_SYMBOL
        });
        return emitSymbol({
          symbol,status:'PROCESSED',rows_15m:btc15.rows.length,rows_5m:btc5.rows.length,
          verified_months_15m:btc15.verified_months,verified_months_5m:btc5.verified_months,
          missing_months_15m:btc15.missing_months,missing_months_5m:btc5.missing_months,
          samples:samples.length,temporal_sequences:samples.filter(row=>isValidTrainingSample(row)).length,
          output:samples
        });
      }
      try{
        const [asset15,asset5]=await Promise.all([
          loadSymbolInterval({symbol,interval:'15m',months,tempDir}),
          loadSymbolInterval({symbol,interval:'5m',months,tempDir})
        ]);
        archiveManifest.push(...asset15.files,...asset5.files);
        if(asset15.rows.length<240||asset5.rows.length<100){
          return emitSymbol({
            symbol,status:'INSUFFICIENT_ARCHIVE_HISTORY',
            rows_15m:asset15.rows.length,rows_5m:asset5.rows.length,
            verified_months_15m:asset15.verified_months,verified_months_5m:asset5.verified_months,
            samples:0,temporal_sequences:0,output:[]
          });
        }
        const samples=buildAdaptiveTraderHistoricalOutcomeSamples({
          symbol,
          klines:{data:asset15.rows,source:'BINANCE_OFFICIAL_ARCHIVE'},
          fastKlines:{data:asset5.rows,source:'BINANCE_OFFICIAL_ARCHIVE'},
          btcKlines,
          now:endExclusiveMs,
          minQuoteVolume24h:MIN_QUOTE_VOLUME_24H,
          maxSamples:HISTORICAL_TRAINING_SAMPLES_PER_SYMBOL
        });
        return emitSymbol({
          symbol,status:'PROCESSED',
          rows_15m:asset15.rows.length,rows_5m:asset5.rows.length,
          verified_months_15m:asset15.verified_months,verified_months_5m:asset5.verified_months,
          missing_months_15m:asset15.missing_months,missing_months_5m:asset5.missing_months,
          rejected_15m:asset15.total_rejected,rejected_5m:asset5.total_rejected,
          samples:samples.length,
          temporal_sequences:samples.filter(row=>isValidTrainingSample(row)).length,
          output:samples
        });
      }catch(error){
        const failure={symbol,reason:String(error?.message||error).slice(0,240)};
        symbolFailures.push(failure);
        return emitSymbol({symbol,status:'FAILED',samples:0,temporal_sequences:0,output:[],error:failure.reason});
      }
    });

    const sampleRows=symbolResults.flatMap(row=>Array.isArray(row.output)?row.output:[]);
    const audit=sampleAudit(sampleRows);
    const uniqueSamples=new Map();
    for(const row of sampleRows){
      const key=String(row?.id||'');
      if(key&&!uniqueSamples.has(key)&&isValidTrainingSample(row))uniqueSamples.set(key,row);
    }
    const samples=[...uniqueSamples.values()]
      .sort((a,b)=>Number(a.at)-Number(b.at)||String(a.symbol).localeCompare(String(b.symbol)));
    const sequenceCount=samples.filter(row=>Array.isArray(row.temporal_sequence)&&
      row.temporal_sequence.length===24&&row.temporal_sequence.every(step=>
        Array.isArray(step)&&step.length===29&&step.every(Number.isFinite))).length;
    const archiveExpected=symbols.length*months.length*2;
    const archiveVerified=archiveManifest.filter(file=>file.status==='VERIFIED').length;
    const archiveMissing=archiveManifest.filter(file=>file.status!=='VERIFIED').length;
    const archiveCoverage=archiveExpected?archiveVerified/archiveExpected:0;
    const symbolsWithSamples=audit.symbols_with_samples;
    const qualityReady=symbolsWithSamples>=minSymbols&&samples.length>=minSamples&&
      sequenceCount>=minSequences&&audit.duplicate_ids===0&&
      audit.per_symbol_4h_spacing_violations===0&&audit.invalid_samples===0;
    const samplesJsonl=writeSampleJsonl(samples);
    await mkdir(resolve(sampleOutput,'..'),{recursive:true});
    await writeFile(sampleOutput,samplesJsonl,'utf8');
    console.log('[COGNITIVE_PROFILE_START] '+JSON.stringify({samples:samples.length,symbols:symbolsWithSamples,temporal_sequences:sequenceCount}));
    const profileStartedAt=Date.now();
    const profile=buildCognitiveLearningProfile(samples,{
      temporalSamples:samples,
      allowedOutcomeSources:['HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1'],
      minTrainingSamples:60,
      minimumValidationSamples:20,
      minimumHoldoutSamples:20,
      minNeuralTrainingSamples:240,
      maxNeuralTrainingSamples:1280,
      maxResolvedSamples:0,
      temporalOptions:{
        minimumHoldoutSamples:150,
        liveHoldoutSamples:150
      }
    });
    const modelProfileElapsedMs=Date.now()-profileStartedAt;
    const modelSummary=summarizeProfile(profile);
    console.log('[COGNITIVE_PROFILE_COMPLETE] '+JSON.stringify({elapsed_ms:modelProfileElapsedMs,selected_model:modelSummary.model_selection?.selected_model||null,cognitive_probability_ready:modelSummary.probability_ready,temporal_live_eligibility_ready:modelSummary.temporal_network.live_eligibility_ready}));
    const temporalPass=modelSummary.temporal_network.live_eligibility_ready===true;
    const cognitivePass=modelSummary.probability_ready===true;
    baseReport.status=qualityReady?'DATA_QUALITY_READY':'DATA_QUALITY_INSUFFICIENT';
    baseReport.data_quality={
      status:qualityReady?'READY_FOR_MODEL_EVALUATION':'INSUFFICIENT_COVERAGE',
      minimum_symbols:minSymbols,minimum_samples:minSamples,
      minimum_temporal_sequences:minSequences,
      symbols_with_samples:symbolsWithSamples,
      processed_symbols:symbolResults.filter(row=>row.status==='PROCESSED'||row.symbol==='BTCUSDT').length,
      symbols_without_sufficient_archive:symbolResults.filter(row=>row.status==='INSUFFICIENT_ARCHIVE_HISTORY').length,
      symbols_failed:symbolFailures.length,
      samples:samples.length,temporal_sequence_samples:sequenceCount,
      archive_files_expected:archiveExpected,archive_files_verified:archiveVerified,
      archive_files_missing:archiveMissing,archive_coverage_ratio:Number(archiveCoverage.toFixed(5)),
      invalid_samples:audit.invalid_samples,duplicate_ids:audit.duplicate_ids,
      per_symbol_4h_spacing_violations:audit.per_symbol_4h_spacing_violations,
      outcome_counts:audit.outcome_counts,sample_month_counts:audit.sample_month_counts,
      features_and_labels_audited:true,
      audit_rules:{
        feature_rows_closed_at_or_before_baseline:true,
        label_uses_only_16_later_closed_15m_candles:true,
        target_horizon_exactly_4h:true,
        tensor_shape:'24x29',
        no_overlapping_labels_per_symbol:true
      }
    };
    baseReport.symbol_results=symbolResults.map(({output,...row})=>row);
    baseReport.dataset={
      sample_file:sampleOutput,
      sample_file_sha256:sha256(samplesJsonl),
      symbols_with_samples:symbolsWithSamples,
      sample_rows:samples.length,
      sequence_rows:sequenceCount,
      samples_per_symbol_max:HISTORICAL_TRAINING_SAMPLES_PER_SYMBOL,
      outcome_counts:audit.outcome_counts,
      samples_by_month:audit.sample_month_counts
    };
    baseReport.models={
      status:'PROFILE_COMPUTED',
      predictive_superiority_verified:cognitivePass||temporalPass,
      cognitive_probability_ready:cognitivePass,
      temporal_live_eligibility_ready:temporalPass,
      profitability_verified:false,
      note:'Predictive scores on chronological validation and untouched holdout are not a transaction-level profitability proof.',
      profile:modelSummary
    };
    archiveManifest.sort((a,b)=>String(a.symbol).localeCompare(String(b.symbol))||String(a.interval).localeCompare(String(b.interval))||String(a.month).localeCompare(String(b.month)));
    baseReport.archive_manifest=archiveManifest;
    baseReport.symbol_failures=symbolFailures;
    baseReport.request_audit=REQUEST_AUDIT;
    baseReport.production_touched=false;
    baseReport.merged=false;
    baseReport.deployed=false;
    baseReport.paper_trading=true;
    baseReport.real_order_execution=false;
    baseReport.model_profile_elapsed_ms=modelProfileElapsedMs;
    baseReport.elapsed_ms=Date.now()-started;
    baseReport.completed_at=new Date().toISOString();
    await writeFile(output,JSON.stringify(baseReport,null,2),'utf8');
    console.log(JSON.stringify({
      status:baseReport.status,window:baseReport.window,universe:baseReport.universe,
      data_quality:baseReport.data_quality,
      models:{
        cognitive_probability_ready:cognitivePass,
        selected_model:modelSummary.model_selection?.selected_model||null,
        neural_status:modelSummary.neural_network.status,
        boosted_status:modelSummary.boosted_tree_model.status,
        hybrid_status:modelSummary.hybrid_model.status,
        temporal_status:modelSummary.temporal_network.status,
        temporal_holdout:modelSummary.temporal_network.holdout_comparison,
        profitability_verified:false
      },
      output,samples_output:sampleOutput,elapsed_ms:baseReport.elapsed_ms
    },null,2));
    if(!qualityReady)process.exitCode=1;
  }finally{
    await rm(tempDir,{recursive:true,force:true}).catch(()=>{});
  }
}

main().catch(async error=>{
  const failure={
    schema:'RADARX_COGNITIVE_MARKET_WIDE_HISTORICAL_BENCHMARK_V1',
    status:'FAILED',
    error:String(error?.stack||error).slice(0,5000),
    completed_at:new Date().toISOString(),
    methodology:{
      market:'BINANCE_SPOT_USDT_ONLY',
      data_source:'OFFICIAL_BINANCE_PUBLIC_DATA_MONTHLY_KLINE_ARCHIVES',
      paper_trading:true,real_order_execution:false,
      production_touched:false
    }
  };
  await mkdir(resolve(OUTPUT_PATH,'..'),{recursive:true}).catch(()=>{});
  await writeFile(OUTPUT_PATH,JSON.stringify(failure,null,2),'utf8').catch(()=>{});
  console.error('[COGNITIVE_HISTORICAL_BENCHMARK_FAILED] '+String(error?.stack||error));
  process.exitCode=1;
});
