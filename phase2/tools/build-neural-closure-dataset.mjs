#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {writeJsonObjectWithArrayStreaming} from '../core/neural-closure-json-writer.mjs';
import {writeRawSpotKlineArchive} from '../core/neural-closure-raw-archive.mjs';
import {binanceServerRetryDelayMs} from '../core/binance-server-retry-policy.mjs';
import {
  NEURAL_CLOSURE_DATASET_SCHEMA,NEURAL_CLOSURE_DATASET_INTERVALS,
  NEURAL_CLOSURE_MARKET_DATA_POLICY,createNeuralClosureDecisionSchedule,
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
const STABLE_BASE_ASSETS=new Set([
  'USDC','BUSD','TUSD','FDUSD','USDP','DAI','USDE','EUR','AEUR',
  'EURI','TRY','BRL','BIDR','IDRT','UST','USTC','PAXG'
]);
const sleep=ms=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

function parseArgs(argv){
  const result={days:180,maxSymbols:30,minSymbols:25,
    minQuoteVolumeUsdt:750_000,
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
    }else if(name==='output'||name==='archiveDir')result[name]=value;
    else throw new Error('UNKNOWN_ARGUMENT:'+token);
    index++;
  }
  if(!Number.isInteger(result.days)||result.days<60||result.days>180)
    throw new Error('DAYS_MUST_BE_AN_INTEGER_FROM_60_TO_180');
  if(!Number.isInteger(result.maxSymbols)||result.maxSymbols<10||result.maxSymbols>30)
    throw new Error('MAX_SYMBOLS_MUST_BE_FROM_10_TO_30');
  if(!Number.isInteger(result.minSymbols)||result.minSymbols<10||
    result.minSymbols>result.maxSymbols)
    throw new Error('MIN_SYMBOLS_MUST_BE_AT_LEAST_10_AND_NOT_EXCEED_MAX_SYMBOLS');
  if(!Number.isFinite(result.minQuoteVolumeUsdt)||result.minQuoteVolumeUsdt<750_000)
    throw new Error('MINIMUM_QUOTE_VOLUME_CANNOT_BE_LOWER_THAN_750000_USDT');
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

function liquidityUniverse(exchangeInfo,tickers,{minimumQuoteVolume,maxSymbols}){
  const tickerMap=new Map(tickers.map(item=>[String(item.symbol),item]));
  const allowed=exchangeInfo.symbols.filter(item=>
    item.status==='TRADING'&&item.quoteAsset==='USDT'&&
    item.isSpotTradingAllowed===true&&
    !STABLE_BASE_ASSETS.has(String(item.baseAsset||'').toUpperCase())&&
    !/(UP|DOWN|BULL|BEAR)$/.test(String(item.baseAsset||'').toUpperCase()));
  const eligible=allowed.map(symbol=>{
    const ticker=tickerMap.get(symbol.symbol);
    const quoteVolume=num(ticker?.quoteVolume);
    return quoteVolume!==null&&quoteVolume>=minimumQuoteVolume?{
      symbol:symbol.symbol,base_asset:symbol.baseAsset,
      quote_asset:symbol.quoteAsset,quote_volume_24h:quoteVolume,
      last_price:num(ticker?.lastPrice),price_change_pct:num(ticker?.priceChangePercent)
    }:null;
  }).filter(Boolean).sort((a,b)=>b.quote_volume_24h-a.quote_volume_24h);
  const btc=eligible.find(item=>item.symbol==='BTCUSDT');
  if(!btc)throw new Error('BTCUSDT_NOT_IN_750K_USDT_SPOT_UNIVERSE');
  let selected=eligible.slice(0,maxSymbols);
  if(!selected.some(item=>item.symbol==='BTCUSDT')){
    selected=selected.slice(0,Math.max(0,maxSymbols-1));
    selected.push(btc);
    selected.sort((a,b)=>b.quote_volume_24h-a.quote_volume_24h);
  }
  return {eligible,selected};
}

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
  const universe=liquidityUniverse(exchangeInfo,tickers,{
    minimumQuoteVolume:args.minQuoteVolumeUsdt,maxSymbols:args.maxSymbols
  });
  if(universe.selected.length<args.minSymbols)
    throw new Error('LIQUIDITY_UNIVERSE_BELOW_MIN_SYMBOLS:'+universe.selected.length);

  const schedule=createNeuralClosureDecisionSchedule({
    serverTime:serverTimeAtStart,days:args.days
  });
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
      symbolSummaries.push({
        symbol,status:'REJECTED_INCOMPLETE_RAW_ARCHIVE',
        quote_volume_24h_usdt:asset.quote_volume_24h,coverage:coverage.checks
      });
      continue;
    }

    const receivedAt=await getServerTime();
    const symbolRows=[];
    let symbolRejected=0;
    for(const decisionAt of schedule.decision_times){
      const built=buildNeuralClosureEventRow({
        symbol,decisionAt,
        minuteCandles:minute.candles,
        fiveMinuteCandles:five.candles,
        fifteenMinuteCandles:fifteen.candles,
        benchmarkFifteenMinuteCandles:btcFifteenMinute,
        firstMinuteOpenAt:schedule.one_minute_start_open_at,
        sourceReceivedAt:receivedAt,
        quoteVolume24h:asset.quote_volume_24h
      });
      if(!built.ready){
        symbolRejected++;
        const key=built.reason||'UNKNOWN_EVENT_REJECTION';
        rejectedCounts[key]=(rejectedCounts[key]||0)+1;
        continue;
      }
      symbolRows.push(built.row);
    }
    if(symbolRows.length<Math.floor(schedule.decision_count*0.8)){
      symbolSummaries.push({
        symbol,status:'REJECTED_LOW_VALID_EVENT_COVERAGE',
        quote_volume_24h_usdt:asset.quote_volume_24h,
        valid_events:symbolRows.length,rejected_events:symbolRejected
      });
      for(const row of symbolRows){} // preserve diagnostic counts; do not add partial symbol cohorts
      continue;
    }

    rows.push(...symbolRows);
    symbolSummaries.push({
      symbol,status:'INCLUDED',
      quote_volume_24h_usdt:asset.quote_volume_24h,
      one_minute_candles:minute.candles.length,
      five_minute_candles:five.candles.length,
      fifteen_minute_candles:fifteen.candles.length,
      valid_events:symbolRows.length,rejected_events:symbolRejected,
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
  if(included.length<args.minSymbols)
    throw new Error('VALIDATED_SYMBOL_COUNT_BELOW_MINIMUM:'+included.length);
  if(rows.length<600)throw new Error('NEURAL_CLOSURE_COHORT_BELOW_600_ROWS:'+rows.length);

  const validated=validateFourHourRows(rows);
  // Validation clones only row envelopes; release the prevalidated envelopes
  // before split/hash/output allocations while preserving shared feature data.
  rows.length=0;
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
      selection:'CURRENT_BINANCE_SPOT_24H_QUOTE_VOLUME_AT_COLLECTION_TIME',
      quote_asset:'USDT',
      minimum_quote_volume_24h_usdt:args.minQuoteVolumeUsdt,
      maximum_symbols:args.maxSymbols,
      survivorship_bias_warning:true,
      symbols:universe.selected,
      symbol_results:symbolSummaries
    },
    counts,class_support:classSupport,
    data_quality:{
      source:'BINANCE_OFFICIAL_PUBLIC_REST_ONLY',
      intervals:NEURAL_CLOSURE_DATASET_INTERVALS,
      raw_archive_files:rawArchiveRecords.length,
      raw_archive_records:rawArchiveRecords,
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
