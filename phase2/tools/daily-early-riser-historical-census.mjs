#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {appendFile,mkdir,mkdtemp,rename,rm,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {
  parseBinanceSpotKlineArchiveCsv,
  listBinanceSpotArchiveMonths,
  summarizeBinanceSpotArchiveMonthCoverage
} from '../core/binance-spot-kline-archive.mjs';
import {
  isDirectionalCandidateSymbol,
  isTokenizedSecurityCandidateSymbol
} from '../core/market-wide-light-scan.mjs';
import {
  DAILY_EARLY_RISER_TARGETS_PCT,
  DAILY_EARLY_RISER_HORIZON_BARS,
  DAILY_EARLY_RISER_OUTCOME_SOURCE,
  buildDailyEarlyRiserHistoricalSamples
} from '../core/daily-early-riser-census.mjs';

const execFile=promisify(execFileCallback);
const API_ROOT='https://data-api.binance.vision';
const ARCHIVE_ROOT='https://data.binance.vision/data/spot/monthly/klines';
const FIFTEEN_MS=15*60*1000;
const FIVE_MS=5*60*1000;
const MAX_ARCHIVE_BYTES=64*1024*1024;
const MAX_UNZIPPED_BYTES=96*1024*1024;
const DEFAULT_START='2025-11-01T00:00:00.000Z';
const DEFAULT_END='2026-11-01T00:00:00.000Z';
const DEFAULT_MIN_VOLUME=750000;
const DEFAULT_ADVERSE_PCT=2;
const OUTPUT_PATH=resolve(process.env.RADARX_DAILY_EARLY_RISER_REPORT||
  'artifacts/daily-early-riser-census.json');
const SAMPLES_PATH=resolve(process.env.RADARX_DAILY_EARLY_RISER_SAMPLES||
  'artifacts/daily-early-riser-samples.jsonl');
const REQUEST_AUDIT=[];
const execHash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function sha256File(path){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest('hex');
}
function validTemporalSequence(sequence){
  return Array.isArray(sequence)&&sequence.length===24&&
    sequence.every(step=>Array.isArray(step)&&step.length===29&&
      step.every(value=>value!==null&&value!==undefined&&value!==''&&typeof value!=='boolean'&&
        Number.isFinite(Number(value))&&Math.abs(Number(value))<=4));
}
const finite=value=>{
  if(value===null||value===undefined||value==='')return null;
  const n=Number(value);
  return Number.isFinite(n)?n:null;
};
const delay=ms=>new Promise(resolveDelay=>setTimeout(resolveDelay,ms));

function parseArgs(argv){
  const values={};
  for(let i=0;i<argv.length;i++){
    if(!argv[i].startsWith('--'))continue;
    const key=argv[i].slice(2),value=argv[i+1];
    if(value===undefined||String(value).startsWith('--'))values[key]='true';
    else{values[key]=value;i++;}
  }
  return values;
}
function parseUtc(value,label){
  const ms=Date.parse(String(value||''));
  if(!Number.isFinite(ms))throw new Error('INVALID_'+label.toUpperCase());
  return ms;
}
function safeSymbol(value){
  const symbol=String(value||'').trim().toUpperCase();
  return /^[A-Z0-9]{5,30}$/.test(symbol)?symbol:null;
}
function sleepBackoff(attempt){return delay(Math.min(15000,500*2**attempt));}
async function fetchResponse(url,{timeoutMs=90000,retries=4}={}){
  let lastError=null;
  for(let attempt=0;attempt<retries;attempt++){
    const audit={url,attempt:attempt+1,started_at:new Date().toISOString(),status:null};
    REQUEST_AUDIT.push(audit);
    try{
      const response=await fetch(url,{headers:{accept:'application/json, application/octet-stream, text/plain'},
        signal:AbortSignal.timeout(timeoutMs)});
      audit.status=response.status;
      audit.finished_at=new Date().toISOString();
      if(response.status===404)return response;
      if(response.status===418||response.status===429||response.status>=500){
        lastError=new Error('HTTP_'+response.status);
        if(attempt+1<retries){
          const retryAfter=Number(response.headers.get('retry-after'));
          if(retryAfter>0)await delay(Math.min(60000,retryAfter*1000));
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
  if(!response.ok)throw new Error('BINANCE_API_HTTP_'+response.status);
  return response.json();
}
function archiveUrl(symbol,interval,month){
  return ARCHIVE_ROOT+'/'+symbol+'/'+interval+'/'+symbol+'-'+interval+'-'+month+'.zip';
}
async function loadVerifiedMonth({symbol,interval,month,tempDir}){
  const url=archiveUrl(symbol,interval,month);
  const checksum=await fetchResponse(url+'.CHECKSUM',{timeoutMs:30000});
  if(checksum.status===404)return {status:'MISSING',reason:'CHECKSUM_404',symbol,interval,month,url};
  if(!checksum.ok)throw new Error('CHECKSUM_HTTP_'+checksum.status+':'+symbol+':'+interval+':'+month);
  const checksumText=await checksum.text();
  const expected=checksumText.match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase();
  if(!expected)throw new Error('OFFICIAL_CHECKSUM_INVALID:'+symbol+':'+interval+':'+month);
  const response=await fetchResponse(url,{timeoutMs:120000});
  if(response.status===404)return {status:'MISSING',reason:'ARCHIVE_404',symbol,interval,month,url};
  if(!response.ok)throw new Error('ARCHIVE_HTTP_'+response.status+':'+symbol+':'+interval+':'+month);
  const announced=Number(response.headers.get('content-length'));
  if(Number.isFinite(announced)&&announced>MAX_ARCHIVE_BYTES)
    throw new Error('ARCHIVE_SIZE_LIMIT:'+symbol+':'+interval+':'+month);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(!bytes.length||bytes.length>MAX_ARCHIVE_BYTES)throw new Error('ARCHIVE_SIZE_INVALID:'+symbol+':'+interval+':'+month);
  const actual=execHash(bytes);
  if(actual!==expected)throw new Error('ARCHIVE_SHA256_MISMATCH:'+symbol+':'+interval+':'+month);
  const zipPath=join(tempDir,symbol+'-'+interval+'-'+month+'.zip');
  await writeFile(zipPath,bytes,{flag:'wx'});
  let csv='';
  try{
    const unzipped=await execFile('unzip',['-p',zipPath],{
      encoding:'utf8',maxBuffer:MAX_UNZIPPED_BYTES,timeout:120000
    });
    csv=unzipped.stdout;
  }finally{await rm(zipPath,{force:true}).catch(()=>{});}
  const intervalMs=interval==='15m'?FIFTEEN_MS:FIVE_MS;
  const parsed=parseBinanceSpotKlineArchiveCsv(csv,{intervalMs});
  return {
    status:'VERIFIED',symbol,interval,month,url,sha256:actual,
    compressed_bytes:bytes.length,row_count:parsed.rows.length,
    rejected:parsed.rejected,continuity_ratio:parsed.continuity_ratio,
    rows:parsed.rows
  };
}
async function loadSymbolInterval({symbol,interval,months,tempDir}){
  const byOpen=new Map(),files=[];
  const rejected={malformed:0,invalid_timestamp:0,invalid_price_or_volume:0,
    invalid_close_boundary:0,duplicate_open_time:0};
  for(const month of months){
    let archive;
    try{archive=await loadVerifiedMonth({symbol,interval,month,tempDir});}
    catch(error){archive={status:'FAILED',symbol,interval,month,url:archiveUrl(symbol,interval,month),
      reason:String(error?.message||error).slice(0,240)};}
    const {rows,...manifest}=archive;
    files.push(manifest);
    if(archive.status!=='VERIFIED')continue;
    for(const [key,value] of Object.entries(archive.rejected||{}))rejected[key]=(rejected[key]||0)+Number(value||0);
    for(const row of rows)byOpen.set(Number(row[0]),row);
  }
  const rows=[...byOpen.entries()].sort((a,b)=>a[0]-b[0]).map(([,row])=>row);
  return {rows,files,rejected,...summarizeBinanceSpotArchiveMonthCoverage(files)};
}
async function mapLimit(items,limit,worker){
  const results=new Array(items.length);let next=0;
  const workers=Array.from({length:Math.max(1,Math.min(limit,items.length||1))},async()=>{
    while(true){const index=next++;if(index>=items.length)return;results[index]=await worker(items[index],index);}
  });
  await Promise.all(workers);
  return results;
}
function countsForTarget(samples,key){
  const counts={UP:0,DOWN:0,FLAT:0,AMBIGUOUS:0,INVALID:0};
  for(const row of samples)counts[row.targets?.[key]?.outcome||'INVALID']++;
  return counts;
}
function countsForMarketMove(samples,key){
  const counts={UP:0,FLAT:0,INVALID:0};
  for(const row of samples){
    const event=row.targets?.[key]?.market_move_event;
    if(event?.status!=='RESOLVED'){counts.INVALID++;continue;}
    if(event.outcome==='UP')counts.UP++;
    else if(event.outcome==='FLAT')counts.FLAT++;
    else counts.INVALID++;
  }
  return counts;
}
function median(values){
  const rows=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!rows.length)return null;
  const mid=Math.floor(rows.length/2);
  return rows.length%2?(rows[mid]):(rows[mid-1]+rows[mid])/2;
}
function rankingMetric(rows,targetKey,fraction,includeFlat=false,labelField='tradeable'){
  const labelFor=row=>labelField==='market_move_event'
    ?row.targets?.[targetKey]?.market_move_event:row.targets?.[targetKey];
  const eligible=rows.filter(row=>{
    const label=labelFor(row);
    return label?.status==='RESOLVED'&&
      (includeFlat?['UP','DOWN','FLAT'].includes(label.outcome):['UP','DOWN'].includes(label.outcome));
  });
  const ranked=eligible.map((row,index)=>({index,outcome:labelFor(row).outcome,
    score:finite(row.base_score)??Number.NEGATIVE_INFINITY}))
    .sort((a,b)=>b.score-a.score||a.index-b.index);
  const up=ranked.filter(row=>row.outcome==='UP').length;
  const down=ranked.filter(row=>row.outcome==='DOWN').length;
  const nonUp=ranked.length-up;
  const selectedCount=Math.max(1,Math.ceil(ranked.length*fraction));
  const selected=ranked.slice(0,Math.min(ranked.length,selectedCount));
  const selectedUp=selected.filter(row=>row.outcome==='UP').length;
  const precision=selected.length?selectedUp/selected.length:null;
  const recall=up?selectedUp/up:null;
  const ascending=ranked.slice().sort((a,b)=>a.score-b.score||a.index-b.index);
  let rankSum=0;
  for(let i=0;i<ascending.length;){
    let end=i+1;
    while(end<ascending.length&&ascending[end].score===ascending[i].score)end++;
    const avg=((i+1)+end)/2;
    let positives=0;
    for(let j=i;j<end;j++)if(ascending[j].outcome==='UP')positives++;
    rankSum+=positives*avg;i=end;
  }
  const pairs=up*nonUp;
  const auc=pairs?(rankSum-up*(up+1)/2)/pairs:null;
  return {
    eligible_samples:ranked.length,excluded_flat_or_ambiguous:rows.length-ranked.length,
    positive_up:up,negative_down:down,negative_non_up_including_flat:nonUp,
    selected_count:selected.length,selected_up:selectedUp,
    precision_pct:precision===null?null:Number((precision*100).toFixed(3)),
    recall_pct:recall===null?null:Number((recall*100).toFixed(3)),
    auc_roc:auc===null?null:Number(auc.toFixed(6)),
    positive_prevalence_pct:ranked.length?Number((up/ranked.length*100).toFixed(3)):null
  };
}
function summarizeTarget(rows,targetPct){
  const key='plus_'+String(targetPct).replace('.','_')+'_pct';
  // Tradeability: target must be reached before the -2% adverse barrier.
  const tradeableOutcomes=countsForTarget(rows,key);
  const tradeableWinners=rows.filter(row=>row.targets?.[key]?.status==='RESOLVED'&&
    row.targets[key].outcome==='UP');
  const tradeableTop10=rankingMetric(rows,key,0.10,false,'tradeable');
  const tradeableTop20=rankingMetric(rows,key,0.20,false,'tradeable');
  const tradeableLead=tradeableWinners.map(row=>
    finite(row.targets[key].time_to_first_touch_minutes)).filter(v=>v!==null);

  // Pure market move: +target happened at any point in 24h, even after an
  // earlier -2% adverse move. This prevents volatile daily gainers disappearing.
  const marketMoveOutcomes=countsForMarketMove(rows,key);
  const marketMovers=rows.filter(row=>
    row.targets?.[key]?.market_move_event?.status==='RESOLVED'&&
    row.targets[key].market_move_event.outcome==='UP');
  const marketMoveTop10=rankingMetric(rows,key,0.10,true,'market_move_event');
  const marketMoveTop20=rankingMetric(rows,key,0.20,true,'market_move_event');
  const marketMoveLead=marketMovers.map(row=>
    finite(row.targets[key].market_move_event.time_to_target_minutes)).filter(v=>v!==null);
  const marketMoversAfterAdverse=marketMovers.filter(row=>
    row.targets[key].market_move_event.target_touch_after_adverse_barrier===true).length;
  const ambiguousSameBar=rows.filter(row=>
    row.targets?.[key]?.market_move_event?.target_and_adverse_touched_same_15m_candle===true).length;
  const tierCountsFor=cohort=>{
    const counts={EARLY_SETUP:0,WATCH:0,LATE_MOVE:0,NO_SETUP:0,OTHER:0};
    for(const row of cohort){
      const rawTier=String(row.tier||'OTHER');
      const tier=Object.prototype.hasOwnProperty.call(counts,rawTier)?rawTier:'OTHER';
      counts[tier]++;
    }
    return counts;
  };
  return {
    target_pct:targetPct,adverse_pct:DEFAULT_ADVERSE_PCT,horizon_hours:24,
    market_move_event:{
      outcomes:marketMoveOutcomes,successful_event_count:marketMovers.length,
      target_hit_after_adverse_barrier_count:marketMoversAfterAdverse,
      target_and_adverse_same_15m_candle_count:ambiguousSameBar,
      top_10_pct_up_vs_non_up:marketMoveTop10,
      top_20_pct_up_vs_non_up:marketMoveTop20,
      median_time_to_target_minutes:median(marketMoveLead),
      lead_time_sample_count:marketMoveLead.length,
      successful_event_tier_counts:tierCountsFor(marketMovers)
    },
    tradeable_first_passage:{
      outcomes:tradeableOutcomes,successful_event_count:tradeableWinners.length,
      ambiguous_count:tradeableOutcomes.AMBIGUOUS,
      incomplete_or_invalid_count:tradeableOutcomes.INVALID,
      top_10_pct_up_vs_down:tradeableTop10,
      top_20_pct_up_vs_down:tradeableTop20,
      median_time_to_target_minutes:median(tradeableLead),
      lead_time_sample_count:tradeableLead.length,
      successful_event_tier_counts:tierCountsFor(tradeableWinners)
    },
    // Backward-compatible aliases refer strictly to first-passage tradeability.
    outcomes:tradeableOutcomes,
    successful_event_count:tradeableWinners.length,
    ambiguous_count:tradeableOutcomes.AMBIGUOUS,
    incomplete_or_invalid_count:tradeableOutcomes.INVALID,
    top_10_pct_event_vs_up_down_flat:rankingMetric(rows,key,0.10,true,'tradeable'),
    top_10_pct_directional_up_vs_down:tradeableTop10,
    top_20_pct_directional_up_vs_down:tradeableTop20,
    median_time_to_target_minutes:median(tradeableLead),
    lead_time_sample_count:tradeableLead.length,
    successful_event_tier_counts:tierCountsFor(tradeableWinners)
  };
}
function compactSample(row){
  const {temporal_sequence,...small}=row;
  return {...small,temporal_sequence_omitted:true,
    temporal_sequence_steps:row.temporal_sequence?.length||0,
    temporal_sequence_channels:row.temporal_sequence?.[0]?.length||0};
}
function buildDataQuality(symbolResults,manifest,metrics){
  const verified=manifest.filter(row=>row.status==='VERIFIED').length;
  const missing=manifest.filter(row=>row.status==='MISSING').length;
  const failed=manifest.filter(row=>row.status==='FAILED').length;
  const expectedAfter=manifest.reduce((sum,row)=>sum+
    (Number.isFinite(Number(row.expected_months_after_first_available))?Number(row.expected_months_after_first_available):0),0);
  const verifiedAfter=manifest.reduce((sum,row)=>sum+
    (Number.isFinite(Number(row.verified_months_after_first_available))
      ?Number(row.verified_months_after_first_available):0),0);
  const incomplete=symbolResults.filter(row=>row.status==='INCOMPLETE_ARCHIVE_COVERAGE').length;
  const failedSymbols=symbolResults.filter(row=>row.status==='FAILED').length;
  return {
    status:failed===0&&incomplete===0&&failedSymbols===0?'READY':'INCOMPLETE',
    expected_archive_files:manifest.length,verified_archive_files:verified,
    missing_archive_files:missing,failed_archive_files:failed,
    archive_coverage_all_pct:manifest.length?Number((verified/manifest.length*100).toFixed(3)):0,
    expected_months_after_first_available:expectedAfter,
    verified_months_after_first_available:verifiedAfter,
    archive_coverage_after_first_available_pct:expectedAfter
      ?Number((verifiedAfter/expectedAfter*100).toFixed(3)):0,
    symbols_with_incomplete_archive_coverage:incomplete,
    symbols_failed:failedSymbols,
    processed_symbols:symbolResults.filter(row=>row.status==='PROCESSED').length,
    symbols_with_samples:symbolResults.filter(row=>row.samples>0).length,
    total_daily_samples:symbolResults.reduce((sum,row)=>sum+row.samples,0),
    non_overlapping_labels:symbolResults.every(row=>row.overlap_violations===0),
    all_baselines_closed_only:symbolResults.every(row=>row.feature_cutoff_violations===0),
    model_training_performed:false,
    predictive_superiority_verified:false,
    profitability_verified:false
  };
}
async function writeJsonAtomic(path,value){
  const temp=path+'.tmp';
  await writeFile(temp,JSON.stringify(value,null,2)+'\n');
  await rename(temp,path);
}
async function main(){
  const args=parseArgs(process.argv.slice(2));
  const startText=args.start||DEFAULT_START,endText=args['end-exclusive']||DEFAULT_END;
  const start=parseUtc(startText,'START'),end=parseUtc(endText,'END_EXCLUSIVE');
  if(end<=start)throw new Error('END_MUST_BE_AFTER_START');
  const months=listBinanceSpotArchiveMonths(start,end);
  const concurrency=Math.max(1,Math.min(8,Math.trunc(Number(args.concurrency)||4)));
  const maxSymbols=Math.max(0,Math.trunc(Number(args['max-symbols'])||0));
  const minVolume=Math.max(0,finite(args['min-quote-volume'])??DEFAULT_MIN_VOLUME);
  const maxSamples=Math.max(1,Math.min(2000,Math.trunc(Number(args['max-samples-per-symbol'])||500)));
  const output=resolve(args.output||OUTPUT_PATH),samplesOutput=resolve(args['samples-output']||SAMPLES_PATH);
  const temporalSamplesOutput=resolve(args['temporal-samples-output']||
    process.env.RADARX_DAILY_EARLY_RISER_TEMPORAL_SAMPLES||
    'artifacts/daily-early-riser-temporal-sequences.jsonl');
  await mkdir(resolve(output,'..'),{recursive:true});
  await mkdir(resolve(samplesOutput,'..'),{recursive:true});
  await mkdir(resolve(temporalSamplesOutput,'..'),{recursive:true});
  await writeFile(samplesOutput,'');
  await writeFile(temporalSamplesOutput,'');
  const tempDir=await mkdtemp(join(tmpdir(),'radarx-daily-early-riser-'));
  const started=Date.now(),manifest=[],symbolFailures=[];
  let completed=0,totalSamples=0,queue=Promise.resolve(),reportQueue=Promise.resolve();
  const persistReport=()=>{
    reportQueue=reportQueue.then(()=>writeJsonAtomic(output,report));
    return reportQueue;
  };
  const methods={
    market:'BINANCE_SPOT_USDT_ONLY',
    universe:'CURRENTLY_TRADING_SPOT_USDT_SURVIVORS_ONLY',
    data_source:'BINANCE_OFFICIAL_MONTHLY_KLINE_ARCHIVES',
    intervals:['15m','5m'],
    targets_pct:[...DAILY_EARLY_RISER_TARGETS_PCT],
    adverse_pct:DEFAULT_ADVERSE_PCT,
    horizon_bars:DAILY_EARLY_RISER_HORIZON_BARS,
    horizon_hours:24,
    anchor_cadence:'ONE_FIXED_UTC_PHASE_ANCHOR_PER_SYMBOL_PER_24H',
    volume_floor_usdt:minVolume,
    closed_candles_only:true,
    baseline_features_have_future_data:false,
    simultaneous_intrabar_target_stop:'AMBIGUOUS_NOT_A_WIN',
    missing_or_gapped_future_path:'INVALID_NOT_FLAT',
    model_training_performed:false,
    real_order_execution:false,
    paper_trading:true,
    limitations:[
      'Universe is limited to symbols trading on Binance Spot at run time; delisted-symbol survivorship bias remains.',
      'The fixed one-per-24h anchor grid tiles decision windows but cannot measure every intraday alert opportunity or production notification latency.',
      'This stage builds labels and baseline ranking diagnostics only; it does not train a model or establish profitability.',
      'The main compact JSONL omits raw 24x29 tensors; a separate SHA-256-audited temporal sidecar stores each valid sequence for the dedicated daily TCN benchmark.'
    ]
  };
  const report={
    schema:'RADARX_DAILY_EARLY_RISER_CENSUS_V1',
    status:'INITIALIZING',created_at:new Date(started).toISOString(),
    methodology:methods,window:{start:startText,end_exclusive:endText,months},
    universe:{selected_symbols:0},data_quality:{status:'NOT_EVALUATED'},
    targets:{},symbol_results:[],archive_manifest:manifest,symbol_failures:symbolFailures,
    sample_file:{path:samplesOutput,sha256:null},request_audit:REQUEST_AUDIT,
    production_touched:false,deployed:false,merged:false,
    paper_trading:true,real_order_execution:false,
    predictive_superiority_verified:false,profitability_verified:false
  };
  await writeJsonAtomic(output,report);
  try{
    const exchangeInfo=await getJson(API_ROOT+'/api/v3/exchangeInfo');
    if(!Array.isArray(exchangeInfo?.symbols))throw new Error('EXCHANGE_INFO_SYMBOLS_INVALID');
    const spot=exchangeInfo.symbols.filter(row=>row.status==='TRADING'&&row.quoteAsset==='USDT'&&row.isSpotTradingAllowed!==false);
    const universe=[...new Set(spot.map(row=>safeSymbol(row.symbol)).filter(Boolean)
      .filter(symbol=>isDirectionalCandidateSymbol(symbol)&&
        !isTokenizedSecurityCandidateSymbol(symbol)&&!/(?:UP|DOWN|BULL|BEAR)USDT$/.test(symbol)))].sort();
    if(!universe.includes('BTCUSDT'))universe.push('BTCUSDT');
    const symbols=maxSymbols?universe.slice(0,maxSymbols):universe;
    report.universe={
      as_of:new Date().toISOString(),spot_usdt_pairs:spot.length,
      directional_symbols:universe.length,selected_symbols:symbols.length,
      current_symbol_list_sha256:execHash(Buffer.from(universe.join('\n')))
    };
    console.log('[DAILY_CENSUS_UNIVERSE] '+JSON.stringify({symbols:symbols.length,months:months.length,concurrency}));
    const [btc15,btc5]=await Promise.all([
      loadSymbolInterval({symbol:'BTCUSDT',interval:'15m',months,tempDir}),
      loadSymbolInterval({symbol:'BTCUSDT',interval:'5m',months,tempDir})
    ]);
    manifest.push(...btc15.files,...btc5.files);
    if(!btc15.complete_from_first_available||!btc5.complete_from_first_available)
      throw new Error('BTC_ARCHIVE_COVERAGE_INCOMPLETE');
    const btcKlines={data:btc15.rows,source:'BINANCE_OFFICIAL_ARCHIVE'};
    let writeQueue=Promise.resolve();
    let temporalWriteQueue=Promise.resolve();
    let temporalSequenceRows=0;
    let temporalSequenceRejected=0;
    const persist=rows=>{
      if(!rows.length)return Promise.all([writeQueue,temporalWriteQueue]);
      const content=rows.map(row=>JSON.stringify(compactSample(row))).join('\n')+'\n';
      const temporalRows=[];
      for(const row of rows){
        if(validTemporalSequence(row.temporal_sequence)){
          temporalRows.push(JSON.stringify({
            id:row.id,symbol:row.symbol,at:row.at,
            temporal_sequence:row.temporal_sequence
          }));
        }else temporalSequenceRejected++;
      }
      writeQueue=writeQueue.then(()=>appendFile(samplesOutput,content));
      if(temporalRows.length){
        temporalSequenceRows+=temporalRows.length;
        temporalWriteQueue=temporalWriteQueue.then(()=>
          appendFile(temporalSamplesOutput,temporalRows.join('\n')+'\n'));
      }
      return Promise.all([writeQueue,temporalWriteQueue]);
    };
    const results=await mapLimit(symbols,concurrency,async symbol=>{
      let result;
      if(symbol==='BTCUSDT'){
        const census=buildDailyEarlyRiserHistoricalSamples({
          symbol,klines:btcKlines,
          fastKlines:{data:btc5.rows,source:'BINANCE_OFFICIAL_ARCHIVE'},
          btcKlines,now:end,minQuoteVolume24h:minVolume,maxSamplesPerSymbol:maxSamples
        });
        const featureCutoffViolations=census.samples.filter(row=>
          row.feature_information_cutoff_at!==row.at).length;
        const horizonViolations=census.samples.filter(row=>
          Object.values(row.targets||{}).some(label=>
            Number(label?.resolved_at)-Number(row.at)!==24*60*60*1000)).length;
        result={symbol,status:featureCutoffViolations||horizonViolations?'SAMPLE_AUDIT_FAILED':'PROCESSED',
          rows_15m:btc15.rows.length,rows_5m:btc5.rows.length,
          coverage_15m:{first_available_month:btc15.first_available_month,
            expected_months_after_first_available:btc15.expected_months_after_first_available,
            verified_months_after_first_available:btc15.verified_months_after_first_available,
            complete_from_first_available:btc15.complete_from_first_available},
          coverage_5m:{first_available_month:btc5.first_available_month,
            expected_months_after_first_available:btc5.expected_months_after_first_available,
            verified_months_after_first_available:btc5.verified_months_after_first_available,
            complete_from_first_available:btc5.complete_from_first_available},
          samples:census.samples.length,audit:census.audit,
          feature_cutoff_violations:featureCutoffViolations,horizon_violations:horizonViolations,
          output:census.samples};
      }else{
        try{
          const [asset15,asset5]=await Promise.all([
            loadSymbolInterval({symbol,interval:'15m',months,tempDir}),
            loadSymbolInterval({symbol,interval:'5m',months,tempDir})
          ]);
          manifest.push(...asset15.files,...asset5.files);
          if(!asset15.complete_from_first_available||!asset5.complete_from_first_available){
            result={symbol,status:'INCOMPLETE_ARCHIVE_COVERAGE',rows_15m:asset15.rows.length,rows_5m:asset5.rows.length,
              first_available_month_15m:asset15.first_available_month,
              first_available_month_5m:asset5.first_available_month,
              missing_after_listing_15m:asset15.missing_months_after_first_available,
              missing_after_listing_5m:asset5.missing_months_after_first_available,
              coverage_15m:{expected_months_after_first_available:asset15.expected_months_after_first_available,
                verified_months_after_first_available:asset15.verified_months_after_first_available,
                complete_from_first_available:asset15.complete_from_first_available},
              coverage_5m:{expected_months_after_first_available:asset5.expected_months_after_first_available,
                verified_months_after_first_available:asset5.verified_months_after_first_available,
                complete_from_first_available:asset5.complete_from_first_available},
              samples:0,audit:null,feature_cutoff_violations:0,horizon_violations:0,output:[]};
          }else{
            const census=buildDailyEarlyRiserHistoricalSamples({
              symbol,klines:{data:asset15.rows,source:'BINANCE_OFFICIAL_ARCHIVE'},
              fastKlines:{data:asset5.rows,source:'BINANCE_OFFICIAL_ARCHIVE'},
              btcKlines,now:end,minQuoteVolume24h:minVolume,maxSamplesPerSymbol:maxSamples
            });
            const featureCutoffViolations=census.samples.filter(row=>
              row.feature_information_cutoff_at!==row.at).length;
            const horizonViolations=census.samples.filter(row=>
              Object.values(row.targets||{}).some(label=>
                Number(label?.resolved_at)-Number(row.at)!==24*60*60*1000)).length;
            result={symbol,status:census.audit.status==='READY'&&!featureCutoffViolations&&!horizonViolations
                ?'PROCESSED':'SAMPLE_AUDIT_FAILED',
              rows_15m:asset15.rows.length,rows_5m:asset5.rows.length,
              verified_months_15m:asset15.verified_months,verified_months_5m:asset5.verified_months,
              first_available_month_15m:asset15.first_available_month,
              first_available_month_5m:asset5.first_available_month,
              coverage_15m:{expected_months_after_first_available:asset15.expected_months_after_first_available,
                verified_months_after_first_available:asset15.verified_months_after_first_available,
                complete_from_first_available:asset15.complete_from_first_available},
              coverage_5m:{expected_months_after_first_available:asset5.expected_months_after_first_available,
                verified_months_after_first_available:asset5.verified_months_after_first_available,
                complete_from_first_available:asset5.complete_from_first_available},
              samples:census.samples.length,audit:census.audit,
              feature_cutoff_violations:featureCutoffViolations,horizon_violations:horizonViolations,
              output:census.samples};
          }
        }catch(error){
          const reason=String(error?.message||error).slice(0,240);
          symbolFailures.push({symbol,reason});
          result={symbol,status:'FAILED',samples:0,audit:null,output:[],error:reason};
        }
      }
      const metricRows=(result.output||[]).map(compactSample);
      await persist(result.output||[]);
      totalSamples+=Number(result.samples)||0;
      completed++;
      const {output:rows,...compactResult}=result;
      report.symbol_results.push(compactResult);
      report.data_quality={
        status:'IN_PROGRESS',completed_symbols:completed,total_symbols:symbols.length,
        total_daily_samples:totalSamples,
        symbols_failed:symbolFailures.length,
        archives_verified:manifest.filter(row=>row.status==='VERIFIED').length,
        archives_missing:manifest.filter(row=>row.status==='MISSING').length,
        archives_failed:manifest.filter(row=>row.status==='FAILED').length
      };
      report.archive_manifest=manifest;
      console.log('[DAILY_CENSUS_PROGRESS] '+JSON.stringify({
        completed,total:symbols.length,symbol,status:result.status,samples:result.samples,
        total_samples:totalSamples,archives:manifest.length
      }));
      await Promise.all([writeQueue,temporalWriteQueue]);
      await persistReport();
      return {...compactResult,metricRows};
    });
    await Promise.all([writeQueue,temporalWriteQueue]);
    await reportQueue;
    const allMetricRows=results.flatMap(row=>row?.metricRows||[]);
    report.targets=Object.fromEntries(DAILY_EARLY_RISER_TARGETS_PCT.map(target=>
      [String(target)+'_PCT',summarizeTarget(allMetricRows,target)]));
    const archiveFilesExpected=symbols.length*months.length*2;
    const verified=manifest.filter(row=>row.status==='VERIFIED').length;
    const missing=manifest.filter(row=>row.status==='MISSING').length;
    const failed=manifest.filter(row=>row.status==='FAILED').length;
    const coverageRows=report.symbol_results
      .flatMap(row=>[row.coverage_15m,row.coverage_5m]).filter(Boolean);
    const afterFirstExpected=coverageRows.reduce((sum,row)=>
      sum+(Number(row.expected_months_after_first_available)||0),0);
    const afterFirstVerified=coverageRows.reduce((sum,row)=>
      sum+(Number(row.verified_months_after_first_available)||0),0);
    const featureCutoffViolations=report.symbol_results.reduce((sum,row)=>
      sum+(row.feature_cutoff_violations||0),0);
    const horizonViolations=report.symbol_results.reduce((sum,row)=>
      sum+(row.horizon_violations||0),0);
    const allAuditsReady=report.symbol_results.every(row=>
      row.status==='PROCESSED'&&row.audit?.status==='READY'&&row.audit?.overlap_violations===0);
    report.data_quality={
      status:failed===0&&symbolFailures.length===0&&allAuditsReady&&
        featureCutoffViolations===0&&horizonViolations===0
        ?'AUDITED_WITH_SURVIVOR_UNIVERSE_CAVEAT':'INCOMPLETE',
      expected_archive_files:archiveFilesExpected,
      observed_archive_files:manifest.length,
      verified_archive_files:verified,missing_archive_files:missing,failed_archive_files:failed,
      archive_coverage_all_pct:manifest.length?Number((verified/manifest.length*100).toFixed(3)):0,
      expected_months_after_first_available:afterFirstExpected,
      verified_months_after_first_available:afterFirstVerified,
      archive_coverage_after_first_available_pct:afterFirstExpected
        ?Number((afterFirstVerified/afterFirstExpected*100).toFixed(3)):0,
      symbols_processed:report.symbol_results.filter(row=>row.status==='PROCESSED').length,
      symbols_incomplete_archive:report.symbol_results.filter(row=>row.status==='INCOMPLETE_ARCHIVE_COVERAGE').length,
      symbols_failed:symbolFailures.length,
      total_daily_samples:totalSamples,
      all_sample_audits_ready:allAuditsReady,
      no_overlapping_daily_labels:report.symbol_results.every(row=>
        row.audit===null||row.audit?.overlap_violations===0),
      feature_cutoff_violations:featureCutoffViolations,
      horizon_violations:horizonViolations
    };
    report.sample_file={
      path:samplesOutput,rows:totalSamples,
      sha256:await sha256File(samplesOutput)
    };
    report.temporal_sample_file={
      path:temporalSamplesOutput,rows:temporalSequenceRows,
      rejected_or_missing_sequences:temporalSequenceRejected,
      sequence_steps:24,sequence_channels:29,
      sha256:await sha256File(temporalSamplesOutput)
    };
    report.status=report.data_quality.status;
    report.completed_at=new Date().toISOString();
    report.elapsed_ms=Date.now()-started;
    report.request_audit=REQUEST_AUDIT;
    await writeJsonAtomic(output,report);
    console.log('[DAILY_CENSUS_COMPLETE] '+JSON.stringify({
      status:report.status,symbols:symbols.length,samples:totalSamples,
      archive_files:manifest.length,verified,missing,failed,
      targets:report.targets
    }));
  }catch(error){
    report.status='FAILED';
    report.fatal_error=String(error?.stack||error).slice(0,2000);
    report.failed_at=new Date().toISOString();
    await persistReport().catch(()=>{});
    throw error;
  }finally{
    await rm(tempDir,{recursive:true,force:true}).catch(()=>{});
  }
}
main().catch(error=>{
  console.error('[DAILY_CENSUS_FATAL] '+String(error?.stack||error));
  process.exitCode=1;
});
