#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {writeJsonObjectWithArrayStreaming} from '../core/neural-closure-json-writer.mjs';
import {writeRawSpotKlineArchive} from '../core/neural-closure-raw-archive.mjs';
import {verifyBinanceRawArchives} from '../core/neural-closure-archive-guardian.mjs';
import {binanceServerRetryDelayMs} from '../core/binance-server-retry-policy.mjs';
import {selectBinanceSpotUsdtUniverse,verifyProspectiveUniverseCapture} from '../core/neural-closure-universe.mjs';
import {
  NEURAL_CLOSURE_DATASET_SCHEMA,NEURAL_CLOSURE_DATASET_INTERVALS,
  buildNeuralClosureMarketDataPolicy,createNeuralClosureDecisionSchedule,
  parseBinanceSpotKline,verifyNeuralClosureRawCoverage,buildNeuralClosureEventRow
} from '../core/neural-closure-data-builder.mjs';
import {
  NEURAL_CLOSURE_HORIZON_MS,NEURAL_CLOSURE_MIN_CLASS_SUPPORT,
  NEURAL_CLOSURE_MODEL_FAMILIES,validateFourHourRows,splitFourHourRows,
  buildNeuralClosureCalibrationBlocks,sha256CanonicalArrayMapped
} from '../core/neural-closure-contracts.mjs';

const BASE_URL='https://data-api.binance.vision';
const KLINE_LIMIT=1000;
const REQUEST_WEIGHT={
  TIME:1,EXCHANGE_INFO:20,TICKER_24HR_ALL:80,KLINES:2
};
const sleep=ms=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

const LEGACY_COHORT_DATASET_SHA256='f9923205db04e0356b0df078c138b8862987b42bbf81b7e329d29179392f8a77';
const LEGACY_COHORT_LAST_DECISION_AT=Date.parse('2026-11-17T16:14:59.999Z');
const LEGACY_COHORT_LAST_LABEL_RESOLVED_AT=
  LEGACY_COHORT_LAST_DECISION_AT+4*60*60_000;
function parseArgs(argv){
  const result={days:180,maxSymbols:100,minSymbols:40,
    minQuoteVolumeUsdt:750_000,prospectiveOnly:false,startAt:null,
    output:'artifacts/neural-closure/dataset.json',
    archiveDir:'artifacts/neural-closure/raw'};
  for(let index=2;index<argv.length;index++){
    const token=argv[index];
    if(!token.startsWith('--'))throw new Error('UNKNOWN_ARGUMENT:'+token);
    const name=token.slice(2),value=argv[index+1];
    if(value===undefined||value.startsWith('--'))throw new Error('ARGUMENT_VALUE_MISSING:'+token);
    if(['days','maxSymbols','minSymbols','minQuoteVolumeUsdt'].includes(name)){
      const number=Number(value);
      if(!Number.isFinite(number))throw new Error('ARGUMENT_NOT_NUMERIC:'+token);
      result[name]=number;
    }else if(name==='prospectiveOnly'){
      if(!['true','false'].includes(value))throw new Error('PROSPECTIVE_ONLY_BOOLEAN_INVALID');
      result.prospectiveOnly=value==='true';
    }else if(name==='startAt'){
      const parsed=Date.parse(value);
      if(!Number.isSafeInteger(parsed)||new Date(parsed).toISOString()!==value)
        throw new Error('PROSPECTIVE_START_AT_MUST_BE_CANONICAL_UTC_ISO8601');
      result.startAt=parsed;
    }else if(name==='output'||name==='archiveDir')result[name]=value;
    else throw new Error('UNKNOWN_ARGUMENT:'+token);
    index++;
  }
  if(!Number.isInteger(result.days)||result.days<60||result.days>180)
    throw new Error('DAYS_MUST_BE_AN_INTEGER_FROM_60_TO_180');
  if(!Number.isInteger(result.maxSymbols)||result.maxSymbols<10)
    throw new Error('MAX_SYMBOLS_MUST_BE_AN_INTEGER_AT_LEAST_10');
  if(!result.prospectiveOnly&&result.maxSymbols>100)
    throw new Error('LEGACY_MAX_SYMBOLS_MUST_NOT_EXCEED_100');
  if(result.prospectiveOnly&&result.maxSymbols>500)
    throw new Error('PROSPECTIVE_MAX_SYMBOLS_MUST_NOT_EXCEED_500');
  if(!Number.isInteger(result.minSymbols)||result.minSymbols<10||
    result.minSymbols>result.maxSymbols)
    throw new Error('MIN_SYMBOLS_MUST_BE_AT_LEAST_10_AND_NOT_EXCEED_MAX_SYMBOLS');
  if(!Number.isFinite(result.minQuoteVolumeUsdt)||result.minQuoteVolumeUsdt<750_000)
    throw new Error('MINIMUM_QUOTE_VOLUME_CANNOT_BE_LOWER_THAN_750000_USDT');
  if(result.prospectiveOnly){
    if(result.startAt===null)
      throw new Error('PROSPECTIVE_START_AT_REQUIRED');
    if(result.startAt<=LEGACY_COHORT_LAST_LABEL_RESOLVED_AT)
      throw new Error('PROSPECTIVE_COHORT_OVERLAPS_OR_PRECEDES_LEGACY_LABEL_MATURITY');
    if(result.startAt%(4*60*60_000)!==(15*60_000-1))
      throw new Error('PROSPECTIVE_START_AT_NOT_ON_4H_DECISION_GRID');
  }else if(result.startAt!==null){
    throw new Error('START_AT_REQUIRES_PROSPECTIVE_ONLY_MODE');
  }
  return result;
}

class ConservativeWeightBucket {
  constructor(limit=6000,reserveFraction=0.5){
    this.reserveFraction=reserveFraction;
    this.updateLimit(limit);
    this.tokens=this.capacity;
    this.last=Date.now();
  }
  updateLimit(limit){
    const safe=Number.isFinite(Number(limit))&&Number(limit)>0?Number(limit):6000;
    this.capacity=Math.max(100,Math.floor(safe*this.reserveFraction));
    this.refillPerMs=safe*this.reserveFraction/60_000;
    this.tokens=Math.min(this.tokens??this.capacity,this.capacity);
  }
  async take(weight){
    const cost=Number(weight);
    if(!Number.isFinite(cost)||cost<=0||cost>this.capacity)
      throw new Error('BINANCE_REQUEST_WEIGHT_INVALID:'+weight);
    for(;;){
      const now=Date.now();
      this.tokens=Math.min(this.capacity,
        this.tokens+Math.max(0,now-this.last)*this.refillPerMs);
      this.last=now;
      if(this.tokens>=cost){this.tokens-=cost;return;}
      const wait=Math.ceil((cost-this.tokens)/this.refillPerMs)+50;
      await sleep(wait);
    }
  }
}

const limiter=new ConservativeWeightBucket();

class BinanceHttpError extends Error{
  constructor(code,message,details={}){
    super(message);this.name='BinanceHttpError';this.code=code;
    Object.assign(this,details);
  }
}

async function getJson(route,params={},weight=1){
  const url=new URL('/api/v3/'+route,BASE_URL);
  for(const [key,value] of Object.entries(params))
    if(value!==undefined&&value!==null)url.searchParams.set(key,String(value));
  let networkAttempt=0,rateAttempt=0,serverAttempt=0;
  for(;;){
    await limiter.take(weight);
    let response;
    try{
      response=await fetch(url,{
        method:'GET',
        headers:{accept:'application/json','user-agent':'RadarX-Build224-NeuralResearch/1.0'},
        signal:AbortSignal.timeout(12_000)
      });
    }catch(error){
      if(networkAttempt++>=2)throw new BinanceHttpError('BINANCE_NETWORK_FAILURE',
        'Binance public market data request failed after bounded retries',
        {route,cause:String(error?.message||error)});
      await sleep(500*networkAttempt);
      continue;
    }
    if(response.status===451)
      throw new BinanceHttpError('BINANCE_GEO_RESTRICTION_451',
        'Binance returned HTTP 451; collection stopped without proxy or endpoint rotation',
        {route,status:451});
    if(response.status===418)
      throw new BinanceHttpError('BINANCE_IP_BAN_418',
        'Binance returned HTTP 418; collector stopped immediately to respect the IP ban',
        {route,status:418,retryAfter:response.headers.get('retry-after')});
    if(response.status===429){
      if(rateAttempt++>=4)
        throw new BinanceHttpError('BINANCE_RATE_LIMIT_RETRY_EXHAUSTED',
          'Binance continued returning HTTP 429 after bounded Retry-After backoff',
          {route,status:429});
      const retryAfter=Number(response.headers.get('retry-after'));
      const waitMs=Number.isFinite(retryAfter)&&retryAfter>0
        ?Math.max(1000,retryAfter*1000):Math.min(30_000,2000*rateAttempt);
      await sleep(waitMs);
      continue;
    }
    const serverRetryDelay=binanceServerRetryDelayMs(
      response.status,serverAttempt+1,response.headers.get('retry-after')
    );
    if(serverRetryDelay!==null){
      serverAttempt++;
      await sleep(serverRetryDelay);
      continue;
    }
    if(!response.ok)
      throw new BinanceHttpError('BINANCE_HTTP_'+response.status,
        'Binance request failed with HTTP '+response.status,
        {route,status:response.status});
    let payload;
    try{payload=await response.json();}
    catch{throw new BinanceHttpError('BINANCE_JSON_INVALID',
      'Binance response was not valid JSON',{route});}
    if(payload&&typeof payload==='object'&&!Array.isArray(payload)&&
      Number.isFinite(Number(payload.code))&&payload.msg)
      throw new BinanceHttpError('BINANCE_API_'+payload.code,
        String(payload.msg),{route,apiCode:payload.code});
    return {payload,headers:response.headers};
  }
}

async function getServerTime(){
  const {payload}=await getJson('time',{},REQUEST_WEIGHT.TIME);
  if(!Number.isInteger(Number(payload?.serverTime)))
    throw new Error('BINANCE_SERVER_TIME_INVALID');
  return Number(payload.serverTime);
}

async function getExchangeInfo(){
  const {payload}=await getJson('exchangeInfo',{},REQUEST_WEIGHT.EXCHANGE_INFO);
  if(!Array.isArray(payload?.symbols)||!Array.isArray(payload?.rateLimits))
    throw new Error('BINANCE_EXCHANGE_INFO_SCHEMA_INVALID');
  const minuteLimit=payload.rateLimits.find(item=>
    item.rateLimitType==='REQUEST_WEIGHT'&&item.interval==='MINUTE'&&
    Number(item.intervalNum)===1)?.limit;
  if(Number.isFinite(Number(minuteLimit)))limiter.updateLimit(Number(minuteLimit));
  return payload;
}

async function fetchKlines(symbol,interval,startTime,endTime,intervalMs,serverTime){
  const rawRows=[];
  const expectedCandles=Math.floor((endTime-startTime)/intervalMs)+1;
  if(!Number.isInteger(expectedCandles)||expectedCandles<1)
    throw new Error('BINANCE_KLINE_EXPECTED_CANDLE_WINDOW_INVALID:'+symbol+':'+interval);
  // Derive the page ceiling from the requested inclusive window. A fixed
  // 250-page cap incorrectly rejected a valid 180-day 1m archive (260 pages).
  const maximumPages=Math.ceil(expectedCandles/KLINE_LIMIT)+1;
  let cursor=startTime,requests=0;
  while(cursor<=endTime){
    const {payload}=await getJson('klines',{
      symbol,interval,startTime:cursor,endTime,limit:KLINE_LIMIT
    },REQUEST_WEIGHT.KLINES);
    if(!Array.isArray(payload))throw new Error('BINANCE_KLINES_RESPONSE_NOT_ARRAY:'+symbol+':'+interval);
    if(!payload.length)break;
    let lastOpen=null;
    for(const raw of payload){
      const open=num(raw?.[0]);
      if(open===null)throw new Error('BINANCE_KLINE_OPEN_TIME_INVALID:'+symbol+':'+interval);
      if(open>=startTime&&open<=endTime)rawRows.push(raw);
      lastOpen=open;
    }
    if(lastOpen===null||lastOpen<cursor)
      throw new Error('BINANCE_KLINE_PAGINATION_STALLED:'+symbol+':'+interval);
    cursor=lastOpen+intervalMs;
    requests++;
    if(requests>maximumPages)
      throw new Error('BINANCE_KLINE_PAGE_LIMIT_EXCEEDED:'+symbol+':'+interval+
        ':requested='+expectedCandles+':pages='+requests+':maximum='+maximumPages);
    if(payload.length<KLINE_LIMIT)break;
  }
  const candles=rawRows.map(row=>parseBinanceSpotKline(row,{serverTime,intervalMs}))
    .sort((a,b)=>a.openTime-b.openTime);
  return {rawRows,candles,request_pages:requests};
}
const num=value=>value===null||value===undefined||value===''?null:Number(value);

async function main(){
  const args=parseArgs(process.argv);
  const outputPath=resolve(args.output);
  const archiveDir=resolve(args.archiveDir);
  await mkdir(dirname(outputPath),{recursive:true});
  await mkdir(archiveDir,{recursive:true});

  const serverTimeAtStart=await getServerTime();
  const exchangeInfo=await getExchangeInfo();
  const {payload:tickers}=await getJson('ticker/24hr',{},REQUEST_WEIGHT.TICKER_24HR_ALL);
  if(!Array.isArray(tickers))throw new Error('BINANCE_24H_TICKERS_INVALID');
  const universe=selectBinanceSpotUsdtUniverse(exchangeInfo,tickers,{
    minimumQuoteVolume:args.minQuoteVolumeUsdt,
    maxSymbols:args.maxSymbols,
    includeAllEligible:args.prospectiveOnly===true,
    historicalEligibilityOnly:args.prospectiveOnly===true
  });
  if(universe.selected.length<args.minSymbols)
    throw new Error('LIQUIDITY_UNIVERSE_BELOW_MIN_SYMBOLS:'+universe.selected.length);

  const schedule=createNeuralClosureDecisionSchedule(args.prospectiveOnly
    ?{serverTime:serverTimeAtStart,startAt:args.startAt}
    :{serverTime:serverTimeAtStart,days:args.days});
  if(args.prospectiveOnly&&
    (schedule.mode!=='PROSPECTIVE_LOCKED_OUT_OF_TIME'||
      schedule.first_decision_at<=LEGACY_COHORT_LAST_DECISION_AT))
    throw new Error('PROSPECTIVE_SCHEDULE_LEGACY_COHORT_OVERLAP');
  const rawArchiveRecords=[];
  const symbolSummaries=[];
  const rows=[];
  const rejectedCounts={};
  const pageCounts={};
  let btcFifteenMinute=null;

  // Fetch, archive and release BTC's raw 15m rows immediately. Only the parsed
  // closed-candle context remains resident for reuse across the symbol universe.
  {
    const btc=await fetchKlines('BTCUSDT','15m',
      schedule.fifteen_minute_start_open_at,
      schedule.fifteen_minute_end_open_at,15*60_000,serverTimeAtStart);
    btcFifteenMinute=btc.candles;
    const coverage=verifyNeuralClosureRawCoverage({
      minuteCandles:[],fiveMinuteCandles:[],
      fifteenMinuteCandles:btcFifteenMinute,
      benchmarkFifteenMinuteCandles:btcFifteenMinute,
      schedule:{
        ...schedule,
        fifteen_minute_start_open_at:schedule.fifteen_minute_start_open_at,
        fifteen_minute_end_open_at:schedule.fifteen_minute_end_open_at
      }
    });
    if(!coverage.checks.fifteen_minute.valid)
      throw new Error('BTC_15M_FEATURE_ARCHIVE_INCOMPLETE:'+coverage.checks.fifteen_minute.reason);
    const archive=await writeRawSpotKlineArchive({
      symbol:'BTCUSDT',interval:'15m',rawRows:btc.rawRows,archiveDir
    });
    rawArchiveRecords.push({symbol:'BTCUSDT',interval:'15m',...archive});
    pageCounts.BTCUSDT_15m=btc.request_pages;
    btc.rawRows=null;
  }

  let includedSymbolCount=0;
  for(const asset of universe.selected){
    // Archive each interval as soon as it is fetched, then release its raw
    // Binance rows before requesting the next interval. Pending archives are
    // removed if candle coverage or valid-event support later rejects a symbol.
    const pendingArchives=[];
    try{
    const symbol=asset.symbol;
    const minute=await fetchKlines(symbol,'1m',
      schedule.one_minute_start_open_at,schedule.one_minute_end_open_at,
      60_000,serverTimeAtStart);
    pendingArchives.push({
      symbol,interval:'1m',
      ...await writeRawSpotKlineArchive({
        symbol,interval:'1m',rawRows:minute.rawRows,archiveDir
      })
    });
    minute.rawRows=null;

    const five=await fetchKlines(symbol,'5m',
      schedule.five_minute_start_open_at,schedule.five_minute_end_open_at,
      5*60_000,serverTimeAtStart);
    pendingArchives.push({
      symbol,interval:'5m',
      ...await writeRawSpotKlineArchive({
        symbol,interval:'5m',rawRows:five.rawRows,archiveDir
      })
    });
    five.rawRows=null;

    const fifteen=symbol==='BTCUSDT'
      ?{rawRows:null,candles:btcFifteenMinute,request_pages:0}
      :await fetchKlines(symbol,'15m',
        schedule.fifteen_minute_start_open_at,schedule.fifteen_minute_end_open_at,
        15*60_000,serverTimeAtStart);
    if(symbol!=='BTCUSDT'){
      pendingArchives.push({
        symbol,interval:'15m',
        ...await writeRawSpotKlineArchive({
          symbol,interval:'15m',rawRows:fifteen.rawRows,archiveDir
        })
      });
      fifteen.rawRows=null;
    }
    const coverage=verifyNeuralClosureRawCoverage({
      minuteCandles:minute.candles,fiveMinuteCandles:five.candles,
      fifteenMinuteCandles:fifteen.candles,
      benchmarkFifteenMinuteCandles:btcFifteenMinute,
      schedule
    });
    if(!coverage.valid){
      const rejection={
        symbol,status:'REJECTED_INCOMPLETE_RAW_ARCHIVE',
        collection_time_quote_volume_24h_usdt:asset.quote_volume_24h,coverage:coverage.checks
      };
      symbolSummaries.push(rejection);
      console.log(JSON.stringify({
        event:'NEURAL_CLOSURE_SYMBOL_PROGRESS',included:false,...rejection
      }));
      continue;
    }

    const receivedAt=await getServerTime();
    const symbolRows=[];
    let symbolRejected=0;
    let historicallyIneligibleEvents=0;
    const symbolRejectedReasons={};
    const historicalIneligibilityReasons={};
    for(const decisionAt of schedule.decision_times){
      const built=buildNeuralClosureEventRow({
        symbol,decisionAt,
        minuteCandles:minute.candles,
        fiveMinuteCandles:five.candles,
        fifteenMinuteCandles:fifteen.candles,
        benchmarkFifteenMinuteCandles:btcFifteenMinute,
        firstMinuteOpenAt:schedule.one_minute_start_open_at,
        sourceReceivedAt:receivedAt,
        minimumQuoteVolume24hUsdt:args.minQuoteVolumeUsdt
      });
      if(!built.ready){
        const key=built.reason||'UNKNOWN_EVENT_REJECTION';
        if(args.prospectiveOnly&&key==='HISTORICAL_24H_QUOTE_VOLUME_BELOW_MINIMUM'){
          historicallyIneligibleEvents++;
          historicalIneligibilityReasons[key]=(historicalIneligibilityReasons[key]||0)+1;
        }else{
          // Preserve the legacy collector's original coverage accounting. The
          // prospective cohort alone separates historical liquidity exclusions.
          symbolRejected++;
          rejectedCounts[key]=(rejectedCounts[key]||0)+1;
          symbolRejectedReasons[key]=(symbolRejectedReasons[key]||0)+1;
        }
        continue;
      }
      symbolRows.push(built.row);
    }
    if(!args.prospectiveOnly&&
      symbolRows.length<Math.ceil(schedule.decision_count*0.8)){
      const minimumValidEvents=Math.ceil(schedule.decision_count*0.8);
      const rejection={
        symbol,status:'REJECTED_LOW_VALID_EVENT_COVERAGE',
        collection_time_quote_volume_24h_usdt:asset.quote_volume_24h,
        valid_events:symbolRows.length,rejected_events:symbolRejected,
        expected_events:schedule.decision_count,
        minimum_valid_events:minimumValidEvents,
        rejection_reasons:symbolRejectedReasons
      };
      symbolSummaries.push(rejection);
      console.log(JSON.stringify({
        event:'NEURAL_CLOSURE_SYMBOL_PROGRESS',included:false,...rejection
      }));
      continue;
    }

    // All decisions are explicitly accounted for. A low historical-liquidity
    // event in the prospective cohort is not missing data; it is an expected
    // out-of-universe observation. Candle completeness is checked above.
    rows.push(...symbolRows);
    symbolSummaries.push({
      symbol,status:'INCLUDED',
      collection_time_quote_volume_24h_usdt:asset.quote_volume_24h,
      one_minute_candles:minute.candles.length,
      five_minute_candles:five.candles.length,
      fifteen_minute_candles:fifteen.candles.length,
      valid_events:symbolRows.length,
      historically_ineligible_events:historicallyIneligibleEvents,
      rejected_events:symbolRejected,
      expected_events:schedule.decision_count,
      historical_ineligibility_reasons:historicalIneligibilityReasons,
      rejection_reasons:symbolRejectedReasons,
      coverage:coverage.checks
    });
    rawArchiveRecords.push(...pendingArchives);
    pendingArchives.length=0;
    pageCounts[symbol+'_1m']=minute.request_pages;
    pageCounts[symbol+'_5m']=five.request_pages;
    if(symbol!=='BTCUSDT')pageCounts[symbol+'_15m']=fifteen.request_pages;
    includedSymbolCount++;
    const memory=process.memoryUsage();
    console.log(JSON.stringify({
      event:'NEURAL_CLOSURE_SYMBOL_PROGRESS',
      symbol,included:true,validated_symbols:includedSymbolCount,
      requested_symbols:universe.selected.length,cohort_rows:rows.length,
      heap_used_mb:Math.round(memory.heapUsed/1024/1024),
      rss_mb:Math.round(memory.rss/1024/1024),
      external_mb:Math.round(memory.external/1024/1024)
    }));
    }finally{
      // If any fetch, coverage or event-support gate failed, discard every
      // partial interval archive. A symbol enters the dataset and its manifest
      // only after the complete three-interval audit passes.
      if(pendingArchives.length){
        await Promise.all(pendingArchives.map(item=>
          unlink(join(archiveDir,item.file)).catch(()=>{})
        ));
      }
      // The symbol-local candle arrays are now unreachable before collection.
      if(global.gc)global.gc();
    }
  }

  btcFifteenMinute=null;
  const included=symbolSummaries.filter(item=>item.status==='INCLUDED');
  const prospectiveCaptureAudit=args.prospectiveOnly
    ?verifyProspectiveUniverseCapture({
      eligible:universe.eligible,selected:universe.selected,
      symbolResults:symbolSummaries
    })
    :null;
  if(included.length<args.minSymbols)
    throw new Error('VALIDATED_SYMBOL_COUNT_BELOW_MINIMUM:'+included.length);
  if(rows.length<600)throw new Error('NEURAL_CLOSURE_COHORT_BELOW_600_ROWS:'+rows.length);

  if(rawArchiveRecords.length!==included.length*3)
    throw new Error('RAW_ARCHIVE_INTERVAL_COUNT_MISMATCH:'+rawArchiveRecords.length+':'+included.length);
  // Verify every persisted archive byte and gzip payload before publishing the
  // cohort. This catches post-write truncation/replacement as well as a bad
  // writer-side digest; each file is streamed sequentially to bound RSS.
  const rawArchiveVerification=await verifyBinanceRawArchives({
    archiveDirectory:archiveDir,
    archiveRecords:rawArchiveRecords,
    expectedCount:included.length*3
  });
  if(rawArchiveVerification.verified_count!==included.length*3||
    rawArchiveVerification.total_rows<=0)
    throw new Error('RAW_ARCHIVE_POST_WRITE_VERIFICATION_INCOMPLETE');

  const validated=validateFourHourRows(rows);
  // Validation clones only row envelopes; release the prevalidated envelopes
  // before split/hash/output allocations while preserving shared feature data.
  rows.length=0;

  if(args.prospectiveOnly){
    const sourceCommitSha=String(process.env.GITHUB_SHA||'').toLowerCase();
    if(sourceCommitSha&&!/^[a-f0-9]{40}$/.test(sourceCommitSha))
      throw new Error('GITHUB_SOURCE_COMMIT_SHA_INVALID');
    if(!validated.length||validated.some(row=>Number(row.at)<args.startAt||
      Number(row.at)>schedule.last_decision_at))
      throw new Error('PROSPECTIVE_COHORT_ROW_BOUNDARY_INVALID');
    const datasetSha=sha256CanonicalArrayMapped(validated,row=>({
      id:row.id,symbol:row.symbol,at:row.at,resolved_at:row.resolved_at,
      outcome:row.outcome,target:row.target,
      source_audit_sha256:row.source_audit.raw_klines_sha256,
      feature_information_cutoff_at:row.feature_information_cutoff_at,
      features:row.features,temporal_sequence:row.temporal_sequence,
      quote_volume_24h:row.quote_volume_24h,
      historical_liquidity:row.historical_liquidity??null,
      feature_snapshot_sha:row.feature_snapshot_sha??null,
      realized_return_pct:row.realized_return_pct
    }));
    const finalServerTime=await getServerTime();
    if(validated.some(row=>Number(row.resolved_at)>finalServerTime))
      throw new Error('PROSPECTIVE_LABELS_NOT_MATURED_AT_FINAL_VERIFICATION');
    const counts={
      rows:validated.length,
      included_symbols:included.length,
      requested_symbols:universe.selected.length,
      historically_ineligible_events:included.reduce((sum,item)=>
        sum+item.historically_ineligible_events,0),
      rejected_events:included.reduce((sum,item)=>sum+item.rejected_events,0),
      first_decision_at:Math.min(...validated.map(row=>Number(row.at))),
      last_decision_at:Math.max(...validated.map(row=>Number(row.at))),
      maximum_label_resolved_at:Math.max(...validated.map(row=>Number(row.resolved_at)))
    };
    const output={
      schema:'RADARX_BUILD224_BINANCE_SPOT_4H_FIRST_TOUCH_PROSPECTIVE_COHORT_V1',
      dataset_sha256:datasetSha,
      source_commit_sha:sourceCommitSha||null,
      created_at_server_time:finalServerTime,
      market_data_endpoint:BASE_URL,
      cohort_contract:{
        schema:'RADARX_PROSPECTIVE_COHORT_LOCK_CONTRACT_V1',
        status:'LOCKED_UNSCORED',
        role:'RETROSPECTIVE_OUT_OF_TIME_BACKFILL_ONLY',
        collection_mode:'BINANCE_PUBLIC_HISTORICAL_BACKFILL_AFTER_LEGACY_LABEL_PURGE',
        real_time_forward_observation:false,
        live_forward_validation:false,
        legacy_cohort:{
          dataset_sha256:LEGACY_COHORT_DATASET_SHA256,
          last_decision_at:LEGACY_COHORT_LAST_DECISION_AT,
          last_decision_at_iso:new Date(LEGACY_COHORT_LAST_DECISION_AT).toISOString(),
          last_label_resolved_at:LEGACY_COHORT_LAST_LABEL_RESOLVED_AT,
          last_label_resolved_at_iso:new Date(LEGACY_COHORT_LAST_LABEL_RESOLVED_AT).toISOString()
        },
        requested_start_at:args.startAt,
        requested_start_at_iso:new Date(args.startAt).toISOString(),
        actual_first_decision_at:schedule.first_decision_at,
        actual_last_decision_at:schedule.last_decision_at,
        strictly_after_legacy_label_maturity:
          schedule.first_decision_at>LEGACY_COHORT_LAST_LABEL_RESOLVED_AT,
        decision_rows_are_label_matured:true,
        training_allowed:false,
        model_selection_allowed:false,
        calibration_allowed:false,
        model_scoring_allowed:false,
        outcome_distribution_reporting_allowed:false,
        prior_holdout_opened:false,
        prior_outer_validation_opened:false,
        execution_allowed:false
      },
      schedule,
      target:{
        definition:validated[0].target_definition,
        semantics:validated[0].target_semantics,
        outcome_source:validated[0].outcome_source,
        horizon_ms:NEURAL_CLOSURE_HORIZON_MS,
        take_profit_pct:3,stop_loss_pct:2,
        execution_return_contract:validated[0].execution_return_contract
      },
      universe:{
        selection:'ALL_CURRENTLY_TRADING_BINANCE_SPOT_USDT_PAIRS_WITH_POINT_IN_TIME_HISTORICAL_24H_EVENT_GATE_V3',
        candidate_prefilter:{
          method:'CURRENT_EXCHANGE_INFO_SPOT_TRADING_USDT_STATUS_ONLY',
          current_24h_ticker_used_for_eligibility:false,
          current_24h_ticker_used_for_ordering:false,
          current_24h_ticker_volume_is_diagnostic_only:true,
          minimum_quote_volume_24h_usdt:args.minQuoteVolumeUsdt,
          maximum_symbols:args.maxSymbols,
          eligible_candidate_count:universe.eligible.length,
          selected_candidate_count:universe.selected.length,
          all_eligible_candidates_included:universe.selected.length===universe.eligible.length,
          hard_cap_failure_mode:'FAIL_CLOSED_NO_TOP_N_TRUNCATION',
          scope:'CURRENTLY_TRADING_BINANCE_SPOT_USDT_PAIRS_ONLY'
        },
        historical_eligibility:{
          method:'SUM_OF_96_CLOSED_15M_KLINE_QUOTE_VOLUME_AT_EACH_DECISION_CLOSE',
          interval:'15m',lookback_candles:96,
          minimum_quote_volume_24h_usdt:args.minQuoteVolumeUsdt,
          future_or_unclosed_candles_used:false,
          below_threshold_events_excluded:true
        },
        quote_asset:'USDT',
        minimum_quote_volume_24h_usdt:args.minQuoteVolumeUsdt,
        maximum_symbols:args.maxSymbols,
        eligible_candidate_count:universe.eligible.length,
        selected_candidate_count:universe.selected.length,
        all_eligible_candidates_included:universe.selected.length===universe.eligible.length,
        capture_audit:prospectiveCaptureAudit,
        hard_cap_failure_mode:'FAIL_CLOSED_NO_TOP_N_TRUNCATION',
        survivorship_bias_warning:true,
        historical_delisted_asset_coverage:false,
        symbols:universe.selected.map(item=>({
          symbol:item.symbol,base_asset:item.base_asset,quote_asset:item.quote_asset,
          collection_time_quote_volume_24h_usdt:item.quote_volume_24h
        })),
        symbol_results:symbolSummaries
      },
      counts,
      label_access:{
        status:'LOCKED',
        outcome_distribution_reported:false,
        per_row_outcomes_not_summarized:true,
        use_requires_separate_predeclared_evaluation_protocol:true
      },
      data_quality:{
        source:'BINANCE_OFFICIAL_PUBLIC_REST_ONLY',
        intervals:NEURAL_CLOSURE_DATASET_INTERVALS,
        raw_archive_files:rawArchiveRecords.length,
        raw_archive_records:rawArchiveRecords,
        raw_archive_verification:rawArchiveVerification,
        request_pages:pageCounts,
        rejected_event_reasons:rejectedCounts,
        feature_masks:{
          micro_5m:'REAL_5M_KLINE_TAKER_BUY_QUOTE_VOLUME',
          order_book:'UNAVAILABLE_MASKED_NO_IMPUTATION',
          aggregate_trades:'UNAVAILABLE_MASKED_NO_IMPUTATION',
          trade_level_volume_profile:'UNAVAILABLE_MASKED_CANDLE_PROXY_ONLY'
        },
        exact_240_closed_1m_bars_required:true,
        no_synthetic_or_mock_rows:true
      },
      policy:buildNeuralClosureMarketDataPolicy({
        prospectiveOnly:args.prospectiveOnly,
        maxSymbols:args.maxSymbols,
        minQuoteVolumeUsdt:args.minQuoteVolumeUsdt
      }),
      training_allowed:false,
      model_scoring_allowed:false,
      outer_validation_opened:false,
      holdout_opened:false
    };
    await writeJsonObjectWithArrayStreaming(outputPath,{...output,rows:validated},'rows');
    console.log(JSON.stringify({
      status:'PROSPECTIVE_COHORT_CAPTURED_LOCKED',
      output:outputPath,dataset_sha256:datasetSha,
      source_commit_sha:sourceCommitSha||null,
      counts:{
        rows:counts.rows,included_symbols:counts.included_symbols,
        requested_symbols:counts.requested_symbols
      },
      first_decision_at:counts.first_decision_at,
      last_decision_at:counts.last_decision_at,
      archive_files:rawArchiveRecords.length,
      labels_matured:true,training_started:false,model_scoring_started:false
    },null,2));
    return;
  }

  const split=splitFourHourRows(validated);
  const countClasses=part=>{
    const positives=part.filter(row=>row.target===1).length;
    return {rows:part.length,positive:positives,negative:part.length-positives};
  };
  const calibrationBlocks=buildNeuralClosureCalibrationBlocks(split.validation);
  const classSupport={
    train:countClasses(split.train),
    validation:countClasses(split.validation),
    holdout:countClasses(split.holdout),
    calibration_fit:calibrationBlocks.support.fit,
    calibration_check:calibrationBlocks.support.check,
    calibration_purged:calibrationBlocks.support.purge
  };
  for(const name of ['train','validation','holdout']){
    const counts=classSupport[name];
    if(counts.positive<NEURAL_CLOSURE_MIN_CLASS_SUPPORT||
      counts.negative<NEURAL_CLOSURE_MIN_CLASS_SUPPORT)
      throw new Error('NEURAL_CLOSURE_CLASS_SUPPORT_BELOW_50:'+name+':'+
        counts.positive+':'+counts.negative);
  }
  for(const name of ['fit','check']){
    const support=calibrationBlocks.support[name];
    if(support.positive<NEURAL_CLOSURE_MIN_CLASS_SUPPORT||
      support.negative<NEURAL_CLOSURE_MIN_CLASS_SUPPORT)
      throw new Error('NEURAL_CLOSURE_CALIBRATION_BLOCK_SUPPORT_BELOW_50:'+
        name+':'+support.positive+':'+support.negative);
  }

  const sourceCommitSha=String(process.env.GITHUB_SHA||'').toLowerCase();
  if(sourceCommitSha&&!/^[a-f0-9]{40}$/.test(sourceCommitSha))
    throw new Error('GITHUB_SOURCE_COMMIT_SHA_INVALID');
  const datasetSha=sha256CanonicalArrayMapped(validated,row=>({
    id:row.id,symbol:row.symbol,at:row.at,resolved_at:row.resolved_at,
    outcome:row.outcome,target:row.target,
    source_audit_sha256:row.source_audit.raw_klines_sha256,
    feature_information_cutoff_at:row.feature_information_cutoff_at,
    features:row.features,temporal_sequence:row.temporal_sequence,
    quote_volume_24h:row.quote_volume_24h,
    historical_liquidity:row.historical_liquidity??null,
    feature_snapshot_sha:row.feature_snapshot_sha??null,
    realized_return_pct:row.realized_return_pct
  }));
  const finalServerTime=await getServerTime();
  const counts={
    rows:validated.length,
    up:validated.filter(row=>row.outcome==='UP').length,
    down:validated.filter(row=>row.outcome==='DOWN').length,
    flat:validated.filter(row=>row.outcome==='FLAT').length,
    included_symbols:included.length,
    requested_symbols:universe.selected.length
  };
  const output={
    schema:NEURAL_CLOSURE_DATASET_SCHEMA,
    dataset_sha256:datasetSha,
    source_commit_sha:sourceCommitSha||null,
    created_at_server_time:finalServerTime,
    market_data_endpoint:BASE_URL,
    target:{
      definition:validated[0].target_definition,
      semantics:validated[0].target_semantics,
      outcome_source:validated[0].outcome_source,
      horizon_ms:NEURAL_CLOSURE_HORIZON_MS,
      take_profit_pct:3,stop_loss_pct:2,
      execution_return_contract:validated[0].execution_return_contract
    },
    schedule,
    universe:{
      selection:'CURRENT_TOP_100_CANDIDATE_PREFILTER_WITH_POINT_IN_TIME_HISTORICAL_24H_EVENT_GATE_V1',
      candidate_prefilter:{
        method:'CURRENT_BINANCE_SPOT_24H_TICKER_AT_COLLECTION_TIME',
        minimum_quote_volume_24h_usdt:args.minQuoteVolumeUsdt,
        maximum_symbols:args.maxSymbols,
        scope:'CURRENTLY_TRADING_BINANCE_SPOT_USDT_PAIRS_ONLY'
      },
      historical_eligibility:{
        method:'SUM_OF_96_CLOSED_15M_KLINE_QUOTE_VOLUME_AT_EACH_DECISION_CLOSE',
        interval:'15m',lookback_candles:96,
        minimum_quote_volume_24h_usdt:args.minQuoteVolumeUsdt,
        future_or_unclosed_candles_used:false,
        below_threshold_events_excluded:true
      },
      quote_asset:'USDT',
      minimum_quote_volume_24h_usdt:args.minQuoteVolumeUsdt,
      maximum_symbols:args.maxSymbols,
      survivorship_bias_warning:true,
      historical_delisted_asset_coverage:false,
      symbols:universe.selected.map(item=>({
        symbol:item.symbol,base_asset:item.base_asset,quote_asset:item.quote_asset,
        collection_time_quote_volume_24h_usdt:item.quote_volume_24h
      })),
      symbol_results:symbolSummaries
    },
    counts,class_support:classSupport,
    data_quality:{
      source:'BINANCE_OFFICIAL_PUBLIC_REST_ONLY',
      intervals:NEURAL_CLOSURE_DATASET_INTERVALS,
      raw_archive_files:rawArchiveRecords.length,
      raw_archive_records:rawArchiveRecords,
      raw_archive_verification:rawArchiveVerification,
      request_pages:pageCounts,
      rejected_event_reasons:rejectedCounts,
      feature_masks:{
        micro_5m:'REAL_5M_KLINE_TAKER_BUY_QUOTE_VOLUME',
        order_book:'UNAVAILABLE_MASKED_NO_IMPUTATION',
        aggregate_trades:'UNAVAILABLE_MASKED_NO_IMPUTATION',
        trade_level_volume_profile:'UNAVAILABLE_MASKED_CANDLE_PROXY_ONLY'
      },
      exact_240_closed_1m_bars_required:true,
      no_synthetic_or_mock_rows:true
    },
    partitions:{
      schema:split.schema,
      days:split.days,
      counts:split.counts,
      class_support:classSupport
    },
    policy:{
      ...NEURAL_CLOSURE_MARKET_DATA_POLICY,
      paper_trading:true,real_order_execution:false
    },
    models_expected:[...NEURAL_CLOSURE_MODEL_FAMILIES]
  };
  await writeJsonObjectWithArrayStreaming(outputPath,{...output,rows:validated},'rows');
  const summary={
    status:'DATASET_READY_FOR_MODEL_TRAINING',
    output:outputPath,dataset_sha256:datasetSha,
    source_commit_sha:sourceCommitSha||null,counts,class_support:classSupport,
    archive_files:rawArchiveRecords.length,
    rejected_event_reasons:rejectedCounts
  };
  console.log(JSON.stringify(summary,null,2));
}
try{
  await main();
}catch(error){
  console.error(JSON.stringify({
    status:'DATASET_COLLECTION_FAILED_CLOSED',
    code:String(error?.code||error?.message||'UNKNOWN_FAILURE'),
    message:String(error?.message||error),
    policy:{paper_trading:true,real_order_execution:false,market:'BINANCE_SPOT_ONLY'}
  },null,2));
  process.exitCode=1;
}
