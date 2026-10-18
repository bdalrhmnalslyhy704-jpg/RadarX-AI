import test from 'node:test';
import assert from 'node:assert/strict';
import {EarlyExpansionRadar,EARLY_EXPANSION_RADAR_DEFAULTS,nextEarlyExpansionPollDelayMs,isMarketWideCachePoolReady,adaptiveRadar8MicroConcurrency,adaptiveRadar8DeepConcurrency,fetchRadar8MarketContext,assessContinuationConfirmation,buildActivityShockWatchAlert,buildDirectionalDeepPendingQueue,selectUnderfloorFastShockCandidates,isEarlyExpansionCandidateAlertEligible} from '../core/early-expansion-radar.mjs';

const now=1_900_000_000_000;
function makeRadar(config={}){
  return new EarlyExpansionRadar({
    rest:{request:async()=>({data:[]}),klines:async()=>({candles:[]}),depth:async()=>({data:{bids:[],asks:[]}})},
    store:{},
    config:{minQuoteVolume24h:100000,microScanCandidates:36,deepCandidates:10,quietReserve:8,rotationReserve:8,...config},
    clock:()=>now,logger:{warn(){}}
  });
}
function rows(count){
  return Array.from({length:count},(_,i)=>({
    symbol:'SEL'+String(i).padStart(3,'0')+'USDT',
    lastPrice:1+i*.01,
    priceChange24h:(i%8)*.45,
    quoteVolume24h:1_000_000+i*1_000,
    tradeCount24h:20_000+i*100
  }));
}
function fastMap(items,overrides={}){
  return new Map(items.map((row,i)=>[row.symbol,{
    price_change_pct:.08+(i%4)*.02,
    price_acceleration_pct:.01+(i%3)*.01,
    volume_accel_ratio:1.25+(i%3)*.05,
    trade_accel_ratio:1.20+(i%2)*.1,
    ...overrides[row.symbol]
  }]));
}
function candidate(symbol,move,{score=65,participation=75,tradeParticipation=70,structure=78,compression=82,volume=1.5,trades=1.4}={}){
  return {
    row:{symbol,lastPrice:1,priceChange24h:move,quoteVolume24h:1_000_000,tradeCount24h:20_000},
    micro_fingerprint:{
      score,eligible:false,mode:'QUIET_COMPRESSION_BUILD',confirmation_count:4,
      metrics:{
        price_change_24h_abs:Math.abs(move),rvol_1m:volume,rvol_5m:Math.max(1.1,volume-.2),
        trade_rvol_1m:trades,trade_rvol_5m:Math.max(1.1,trades-.1),bb_ratio:.78,
        range_compression_ratio:.82,atr_ratio:.88,higher_low_count:structure,
        resistance_distance_pct:-2,acceleration_1m_pct:.08,acceleration_5m_pct:.12,taker_buy_ratio:.57
      },
      category_scores:{participation,tradeParticipation,structure,compression,momentumTurn:62}
    }
  };
}



function makeClosedCandles(symbol, intervalMs, count, at=now, source='BINANCE_PUBLIC_REST') {
  const latestOpen = Math.floor((at - intervalMs) / intervalMs) * intervalMs;
  return Array.from({length:count},(_,i)=>{
    const openTime=latestOpen-(count-1-i)*intervalMs;
    return {
      symbol,openTime,closeTime:openTime+intervalMs-1,
      open:100,high:101,low:99,close:100.5,volume:100,
      quoteVolume:10000,tradeCount:100,takerBuyBaseVolume:60,takerBuyQuoteVolume:6000,
      closed:true,source,receivedAt:at-1000
    };
  });
}

test('Radar 8 Activity Shock watch observations are explicitly non-entry signals',()=>{
  const watch=buildActivityShockWatchAlert({
    symbol:'SHOCKUSDT',last_price:1.25,price_change_24h:2.2,data_quality:100,data_stale:false,
    source:'BINANCE_PUBLIC_WS',
    activity_shock:{detected:true,stage:'EVENT_DRIVEN_BREAKOUT',score:94,watch_only:true,
      entry_eligible:false,detected_candle_close_time:now}
  },now);
  assert.equal(watch.event,'ACTIVITY_SHOCK_WATCH_ONLY');
  assert.equal(watch.watch_only,true);
  assert.equal(watch.entry_eligible,false);
  assert.ok(watch.risk_flags.includes('ACTIVITY_SHOCK_WATCH_ONLY'));
  assert.ok(watch.reason_codes.includes('MONITOR_ONLY_NOT_ENTRY'));
});

test('Radar 8 confirms continuation only when price holds or retests breakout and activity persists',()=>{
  const candles=[
    {openTime:1,closeTime:60,open:99.2,high:99.8,low:98.9,close:99.5,closed:true},
    {openTime:61,closeTime:120,open:99.6,high:100.2,low:99.4,close:100.05,closed:true},
    {openTime:121,closeTime:180,open:100.02,high:100.5,low:99.8,close:100.3,closed:true}
  ];
  const result=assessContinuationConfirmation({candles,breakoutLevel:100,volumeRatio:1.4,tradeRatio:1.2,takerBuyRatio:.56});
  assert.equal(result.stage,'CONTINUATION_CONFIRMED');
  assert.equal(result.confirmed,true);
  assert.equal(result.level_held,true);
  assert.equal(result.retest_held,true);
  assert.ok(result.score>=90);
});

test('Radar 8 refuses continuation confirmation when activity collapses or a fakeout is present',()=>{
  const candles=[
    {openTime:1,closeTime:60,open:99.2,high:100,low:99,close:99.7,closed:true},
    {openTime:61,closeTime:120,open:99.7,high:100.2,low:99.6,close:100.02,closed:true},
    {openTime:121,closeTime:180,open:100.02,high:100.3,low:99.8,close:100.1,closed:true}
  ];
  const lowActivity=assessContinuationConfirmation({candles,breakoutLevel:100,volumeRatio:.9,tradeRatio:.8,takerBuyRatio:.48});
  assert.equal(lowActivity.confirmed,false);
  assert.equal(lowActivity.stage,'BREAKOUT_UNCONFIRMED');
  const fakeout=assessContinuationConfirmation({candles,breakoutLevel:100,volumeRatio:1.5,tradeRatio:1.3,takerBuyRatio:.56,falseBreakout:true});
  assert.equal(fakeout.confirmed,false);
  assert.ok(fakeout.reasons.includes('FALSE_BREAKOUT_DETECTED'));
});

test('Radar 8 falls back to fresh BTC 1h REST context when no verified hour cache exists',async()=>{
  const fiveMinute=makeClosedCandles('BTCUSDT',5*60_000,120,now,'BINANCE_PUBLIC_WS');
  const requested=[];
  const result=await fetchRadar8MarketContext({
    rest:{async klines(symbol,interval,options){requested.push({symbol,interval,options});return {candles:makeClosedCandles(symbol,interval==='1h'?60*60_000:5*60_000,interval==='1h'?60:120,now,'BINANCE_PUBLIC_REST'),source:'BINANCE_PUBLIC_REST'};}},
    marketWideKlineCache:{getSeries(symbol){assert.equal(symbol,'BTCUSDT');return {symbol,candles:fiveMinute,source:'BINANCE_PUBLIC_WS'};}},
    config:{fiveMinuteKlines:120,freshness5mMs:8*60_000},
    eligible:[{priceChange24h:2},{priceChange24h:-1},{priceChange24h:null}],now
  });
  assert.deepEqual(requested.map(x=>x.interval),['1h']);
  assert.equal(result.fiveMinuteCacheHit,true);
  assert.equal(result.btcFive.length,120);
  assert.equal(result.marketContext.fiveMinute.length,120);
  assert.equal(result.marketContext.oneHour.length,60);
  assert.equal(result.marketContext.marketMedianChange24hPct,0.5);
  assert.equal(result.marketContext.marketBreadthPct,50);
  assert.equal(result.oneHourCacheHit,false);
  assert.equal(result.oneHourContextCache.candles.length,60);
});

test('Radar 8 reuses only a verified closed BTC 1h context until the next hour closes',async()=>{
  const fiveMinute=makeClosedCandles('BTCUSDT',5*60_000,120,now,'BINANCE_PUBLIC_WS');
  const oneHour=makeClosedCandles('BTCUSDT',60*60_000,60,now,'BINANCE_PUBLIC_REST');
  const requested=[];
  const result=await fetchRadar8MarketContext({
    rest:{async klines(symbol,interval,options){requested.push({symbol,interval,options});throw new Error('REST_SHOULD_NOT_BE_NEEDED_FOR_VALID_CACHES');}},
    marketWideKlineCache:{getSeries(symbol){assert.equal(symbol,'BTCUSDT');return {symbol,candles:fiveMinute,source:'BINANCE_PUBLIC_WS'};}},
    cachedOneHourContext:{candles:oneHour,source:'BINANCE_PUBLIC_REST'},
    config:{fiveMinuteKlines:120,freshness5mMs:8*60_000,freshness1hMs:75*60_000},
    eligible:[],now
  });
  assert.deepEqual(requested,[]);
  assert.equal(result.fiveMinuteCacheHit,true);
  assert.equal(result.oneHourCacheHit,true);
  assert.equal(result.marketContext.oneHour.length,60);
  assert.equal(result.marketContext.oneHour.at(-1).closeTime,Math.floor(now/(60*60_000))*60*60_000-1);
});

test('Radar 8 refreshes stale BTC 1h cache data from REST without reusing an old closed candle',async()=>{
  const fiveMinute=makeClosedCandles('BTCUSDT',5*60_000,120,now,'BINANCE_PUBLIC_WS');
  const staleOneHour=makeClosedCandles('BTCUSDT',60*60_000,60,now-60*60_000,'BINANCE_PUBLIC_REST');
  const requested=[];
  const result=await fetchRadar8MarketContext({
    rest:{async klines(symbol,interval,options){requested.push({symbol,interval,options});return {
      candles:makeClosedCandles(symbol,interval==='1h'?60*60_000:5*60_000,interval==='1h'?60:120,now,'BINANCE_PUBLIC_REST'),
      source:'BINANCE_PUBLIC_REST'
    };}},
    marketWideKlineCache:{getSeries(symbol){assert.equal(symbol,'BTCUSDT');return {symbol,candles:fiveMinute,source:'BINANCE_PUBLIC_WS'};}},
    cachedOneHourContext:{candles:staleOneHour,source:'BINANCE_PUBLIC_REST'},
    config:{fiveMinuteKlines:120,freshness5mMs:8*60_000,freshness1hMs:75*60_000},
    eligible:[],now
  });
  assert.deepEqual(requested.map(x=>x.interval),['1h']);
  assert.equal(result.oneHourCacheHit,false);
  assert.equal(result.oneHourContextCache.candles.length,60);
  assert.equal(result.marketContext.oneHour.at(-1).closeTime,Math.floor(now/(60*60_000))*60*60_000-1);
});

test('Radar 8 requests enough BTC 5m rows to retain 120 closed candles and reuses them until the next close',async()=>{
  const requested=[];
  let restNow=now;
  const rest={async klines(symbol,interval,options){
    requested.push({symbol,interval,limit:options?.limit});
    const intervalMs=interval==='1h'?60*60_000:5*60_000;
    const count=interval==='1h'?61:120;
    const closed=makeClosedCandles(symbol,intervalMs,count,restNow,'BINANCE_PUBLIC_REST');
    if(interval==='5m'){
      const openTime=Math.floor(restNow/intervalMs)*intervalMs;
      closed.push({
        symbol,openTime,closeTime:openTime+intervalMs-1,
        open:100,high:101,low:99,close:100.5,volume:100,quoteVolume:10000,tradeCount:100,
        takerBuyBaseVolume:60,takerBuyQuoteVolume:6000,closed:false,source:'BINANCE_PUBLIC_REST',receivedAt:now
      });
    }
    return {source:'BINANCE_PUBLIC_REST',candles:closed};
  }};
  const marketWideKlineCache={getSeries(){return {candles:[],source:'BINANCE_PUBLIC_WS'};}};
  const first=await fetchRadar8MarketContext({
    rest,marketWideKlineCache,config:{fiveMinuteKlines:120,freshness5mMs:8*60_000},
    eligible:[],now
  });
  assert.deepEqual(requested.map(x=>x.interval).sort(),['1h','5m']);
  assert.equal(requested.find(x=>x.interval==='5m').limit,121);
  assert.equal(first.btcFive.length,120);
  assert.equal(first.btcFive.every(candle=>candle.closed===true),true);
  assert.equal(first.fiveMinuteCacheHit,false);
  assert.equal(first.fiveMinuteContextCacheHit,false);
  assert.equal(first.fiveMinuteContextCache.candles.length,120);
  assert.equal(first.oneHourContextCache.candles.length,60);

  requested.length=0;
  const second=await fetchRadar8MarketContext({
    rest,marketWideKlineCache,cachedFiveMinuteContext:first.fiveMinuteContextCache,
    cachedOneHourContext:first.oneHourContextCache,
    config:{fiveMinuteKlines:120,freshness5mMs:8*60_000},eligible:[],now:now+1_000
  });
  assert.deepEqual(requested,[]);
  assert.equal(second.fiveMinuteCacheHit,false,'local validated cache must not be misreported as shared WebSocket cache');
  assert.equal(second.fiveMinuteContextCacheHit,true);
  assert.equal(second.oneHourCacheHit,true);
  assert.equal(second.btcFive.length,120);
  assert.equal(second.btcFive.every(candle=>candle.closed===true),true);

  requested.length=0;
  const nextFiveMinuteClose=Math.floor(now/(5*60_000))*5*60_000+5*60_000+1_000;
  restNow=nextFiveMinuteClose;
  const third=await fetchRadar8MarketContext({
    rest,marketWideKlineCache,cachedFiveMinuteContext:first.fiveMinuteContextCache,
    cachedOneHourContext:first.oneHourContextCache,
    config:{fiveMinuteKlines:120,freshness5mMs:8*60_000},eligible:[],now:nextFiveMinuteClose
  });
  assert.deepEqual(new Set(requested.map(x=>x.interval)),new Set(['5m']));
  assert.equal(third.fiveMinuteContextCacheHit,false,'close boundary invalidates the old BTC 5m window');
  assert.equal(third.fiveMinuteContextCache.candles.length,120);
});

test('Radar 8 falls back to BTC 5m REST when the shared cache is incomplete',async()=>{
  const requested=[];
  const result=await fetchRadar8MarketContext({
    rest:{async klines(symbol,interval,options){requested.push(interval);return {candles:makeClosedCandles(symbol,interval==='1h'?60*60_000:5*60_000,interval==='1h'?60:120,now,'BINANCE_PUBLIC_REST'),source:'BINANCE_PUBLIC_REST'};}},
    marketWideKlineCache:{getSeries(symbol){return {symbol,candles:makeClosedCandles(symbol,5*60_000,119,now,'BINANCE_PUBLIC_WS'),source:'BINANCE_PUBLIC_WS'};}},
    config:{fiveMinuteKlines:120,freshness5mMs:8*60_000},eligible:[],now
  });
  assert.deepEqual(new Set(requested),new Set(['5m','1h']));
  assert.equal(result.fiveMinuteCacheHit,false);
  assert.equal(result.btcFive.length,120);
  assert.equal(result.marketContext.marketMedianChange24hPct,null);
  assert.equal(result.marketContext.marketBreadthPct,null);
});

test('Radar 8 adaptive Micro concurrency respects cache readiness, shared REST request/weight headroom and candidate bounds',()=>{
  const lowPressure={shared_requests_last_minute:100,shared_max_requests_per_minute:420,
    shared_estimated_weight_last_minute:1000,shared_max_weight_per_minute:4000};
  const highWeightPressure={shared_requests_last_minute:100,shared_max_requests_per_minute:420,
    shared_estimated_weight_last_minute:3200,shared_max_weight_per_minute:4000};
  assert.equal(adaptiveRadar8MicroConcurrency(6,{expected_symbols:100,ready_symbols:80},lowPressure,18),10);
  assert.equal(adaptiveRadar8MicroConcurrency(6,{expected_symbols:100,ready_symbols:10},highWeightPressure,18),4);
  assert.equal(adaptiveRadar8MicroConcurrency(6,{expected_symbols:100,ready_symbols:80},highWeightPressure,18),4,
    'high REST weight pressure caps workers even when the WebSocket cache is warm');
  // A partly warmed production cache can use two extra workers when both shared budgets have headroom.
  assert.equal(adaptiveRadar8MicroConcurrency(6,{expected_symbols:100,ready_symbols:40},lowPressure,18),8);
  assert.equal(adaptiveRadar8MicroConcurrency(6,{expected_symbols:100,ready_symbols:31},lowPressure,18),8,
    '25-35% cache readiness should not leave the scanner at its base concurrency');
  assert.equal(adaptiveRadar8MicroConcurrency(6,{expected_symbols:100,ready_symbols:40},highWeightPressure,18),4);
  // Near the headroom boundary, the conservative 8-worker tier stays active.
  assert.equal(adaptiveRadar8MicroConcurrency(6,{expected_symbols:100,ready_symbols:80},
    {shared_requests_last_minute:100,shared_max_requests_per_minute:420,shared_estimated_weight_last_minute:2200,shared_max_weight_per_minute:4000},18),8);
  assert.equal(adaptiveRadar8MicroConcurrency(6,{expected_symbols:100,ready_symbols:80},lowPressure,3),3);
  assert.equal(adaptiveRadar8MicroConcurrency(6,{expected_symbols:100,ready_symbols:30},
    {shared_requests_last_minute:375,shared_max_requests_per_minute:600,shared_estimated_weight_last_minute:1300,shared_max_weight_per_minute:4000},18),8,
    'the wider internal request headroom allows extra workers only when measured weight and request ratios remain below pressure thresholds');
  assert.equal(adaptiveRadar8MicroConcurrency(0,{}, {},18),6);
  assert.equal(adaptiveRadar8MicroConcurrency(99,{expected_symbols:100,ready_symbols:100},
    {shared_requests_last_minute:100,shared_max_requests_per_minute:420,shared_estimated_weight_last_minute:0,shared_max_weight_per_minute:4000},18),10);
  assert.equal(adaptiveRadar8MicroConcurrency(6,{expected_symbols:100,ready_symbols:100},
    {shared_estimated_weight_last_minute:1000,shared_max_weight_per_minute:4000},18),6,
    'unknown shared request pressure must not promote concurrency');
  assert.equal(adaptiveRadar8MicroConcurrency(6,{expected_symbols:100,ready_symbols:100},
    {shared_requests_last_minute:350,shared_max_requests_per_minute:420,shared_estimated_weight_last_minute:1000,shared_max_weight_per_minute:4000},18),4,
    'high request-count pressure caps workers even when request weight is low');
});

test('Radar 8 adaptive Deep concurrency adds one worker only with full cache readiness and measured REST headroom',()=>{
  const ready={expected_symbols:100,ready_symbols:80};
  const headroom={shared_requests_last_minute:100,shared_max_requests_per_minute:420,shared_estimated_weight_last_minute:1000,shared_max_weight_per_minute:4000};
  const pressure={shared_requests_last_minute:100,shared_max_requests_per_minute:420,shared_estimated_weight_last_minute:3200,shared_max_weight_per_minute:4000};
  assert.equal(adaptiveRadar8DeepConcurrency(4,ready,headroom,5),5);
  assert.equal(adaptiveRadar8DeepConcurrency(4,ready,pressure,5),4);
  assert.equal(adaptiveRadar8DeepConcurrency(4,{expected_symbols:100,ready_symbols:40},headroom,5),4);
  assert.equal(adaptiveRadar8DeepConcurrency(4,ready,headroom,3),3);
  assert.equal(adaptiveRadar8DeepConcurrency(4,ready,headroom,0),1);
  assert.equal(adaptiveRadar8DeepConcurrency(0,{}, {},5),4);
  assert.equal(adaptiveRadar8DeepConcurrency(4,ready,
    {shared_requests_last_minute:350,shared_max_requests_per_minute:420,shared_estimated_weight_last_minute:1000,shared_max_weight_per_minute:4000},5),4,
    'deep worker promotion is blocked by high shared request-count pressure');
});

test('Radar 8 reuses only a complete fresh closed 5m cache window and keeps 1m REST fresh',async()=>{
  const requested=[];
  const oneMinute=makeClosedCandles('CACHEUSDT',60_000,180,now);
  const fiveMinute=makeClosedCandles('CACHEUSDT',5*60_000,180,now,'BINANCE_PUBLIC_WS');
  const btcFiveMinute=makeClosedCandles('BTCUSDT',5*60_000,180,now,'BINANCE_PUBLIC_WS');
  const radar=new EarlyExpansionRadar({
    rest:{
      async klines(symbol,interval){
        requested.push(interval);
        return {candles:interval==='1m'?oneMinute:fiveMinute,source:'BINANCE_PUBLIC_REST'};
      }
    },
    store:{},
    marketWideKlineCache:{getSeries(symbol){return {symbol,candles:fiveMinute,source:'BINANCE_PUBLIC_WS'};}},
    config:{oneMinuteKlines:180,fiveMinuteKlines:180},
    clock:()=>now,logger:{warn(){}}
  });
  const result=await radar.microScan({
    symbol:'CACHEUSDT',lastPrice:100.5,priceChange24h:1,quoteVolume24h:1_000_000,tradeCount24h:1000
  },{},btcFiveMinute);
  assert.deepEqual(requested,['1m'],'cache reuse must remove only the duplicated 5m REST request');
  assert.equal(result.five_minute_cache_hit,true);
  assert.equal(result.five_minute_cache_source,'BINANCE_PUBLIC_WS');
  assert.equal(result.fiveMinute.length,180);
  assert.equal(result.micro_fingerprint.closed_candles_only,true);
});

test('Radar 8 default Micro window reuses 60 closed candles from the shared market cache',async()=>{
  assert.equal(EARLY_EXPANSION_RADAR_DEFAULTS.fiveMinuteKlines,60);
  const requested=[];
  const oneMinute=makeClosedCandles('CACHE60USDT',60_000,120,now,'BINANCE_PUBLIC_REST');
  const fiveMinute=makeClosedCandles('CACHE60USDT',5*60_000,60,now,'BINANCE_PUBLIC_WS');
  const btcFiveMinute=makeClosedCandles('BTCUSDT',5*60_000,60,now,'BINANCE_PUBLIC_WS');
  const radar=new EarlyExpansionRadar({
    rest:{async klines(symbol,interval){requested.push(interval);return {candles:oneMinute,source:'BINANCE_PUBLIC_REST'};}},
    store:{},
    marketWideKlineCache:{getSeries(symbol){return {symbol,candles:fiveMinute,source:'BINANCE_PUBLIC_WS'};}},
    clock:()=>now,logger:{warn(){}}
  });
  const result=await radar.microScan({
    symbol:'CACHE60USDT',lastPrice:100.5,priceChange24h:1,quoteVolume24h:1_000_000,tradeCount24h:1000
  },{},btcFiveMinute);
  assert.deepEqual(requested,['1m'],'a valid shared 5m cache window must avoid the redundant 5m REST request');
  assert.equal(result.five_minute_cache_hit,true);
  assert.equal(result.fiveMinute.length,60);
  assert.equal(result.micro_fingerprint.closed_candles_only,true);
});

test('Radar 8 falls back to Binance REST when its cached 5m history is incomplete',async()=>{
  const requested=[];
  const oneMinute=makeClosedCandles('CACHEFALLBACKUSDT',60_000,180,now);
  const fiveMinute=makeClosedCandles('CACHEFALLBACKUSDT',5*60_000,180,now,'BINANCE_PUBLIC_REST');
  const staleWindow=fiveMinute.slice(1);
  const btcFiveMinute=makeClosedCandles('BTCUSDT',5*60_000,180,now,'BINANCE_PUBLIC_WS');
  const radar=new EarlyExpansionRadar({
    rest:{
      async klines(symbol,interval){
        requested.push(interval);
        return {candles:interval==='1m'?oneMinute:fiveMinute,source:'BINANCE_PUBLIC_REST'};
      }
    },
    store:{},
    marketWideKlineCache:{getSeries(symbol){return {symbol,candles:staleWindow,source:'BINANCE_PUBLIC_REST'};}},
    config:{oneMinuteKlines:180,fiveMinuteKlines:180},
    clock:()=>now,logger:{warn(){}}
  });
  const result=await radar.microScan({
    symbol:'CACHEFALLBACKUSDT',lastPrice:100.5,priceChange24h:1,quoteVolume24h:1_000_000,tradeCount24h:1000
  },{},btcFiveMinute);
  assert.deepEqual(new Set(requested),new Set(['1m','5m']));
  assert.equal(requested.length,2);
  assert.equal(result.five_minute_cache_hit,false);
  assert.equal(result.fiveMinute.length,180);
});


test('Radar 8 caches only a complete closed higher-timeframe window until the next candle closes',async()=>{
  let clockNow=now;
  const requests=[];
  const step=15*60_000;
  const radar=new EarlyExpansionRadar({
    rest:{
      async klines(symbol,interval,{limit}){
        requests.push({symbol,interval,limit});
        return {source:'BINANCE_PUBLIC_REST',candles:makeClosedCandles(symbol,step,limit-1,clockNow,'BINANCE_PUBLIC_REST')};
      }
    },
    store:{},clock:()=>clockNow,logger:{warn(){}},
    config:{retryAttempts:0,fifteenMinuteKlines:160,freshness15mMs:20*60_000}
  });
  const first=await radar.deepTimeframeKlines('DEEPCACHEUSDT','15m',160,20*60_000);
  assert.equal(first.cache_hit,false);
  assert.equal(first.candles.length,159);
  const sameInterval=await radar.deepTimeframeKlines('DEEPCACHEUSDT','15m',160,20*60_000);
  assert.equal(sameInterval.cache_hit,true);
  assert.equal(sameInterval.candles.length,first.candles.length);
  assert.equal(requests.length,1,'the same fully closed 15m window must not trigger duplicate REST requests');
  clockNow+=step;
  const nextInterval=await radar.deepTimeframeKlines('DEEPCACHEUSDT','15m',160,20*60_000);
  assert.equal(nextInterval.cache_hit,false,'a newly closed candle must force a fresh Binance response');
  assert.equal(requests.length,2);
  assert.equal(radar.deepCandleCacheHitTotal,1);
  assert.equal(radar.deepCandleCacheMissTotal,2);
});

test('Radar 8 activates guarded candidate pooling at 10 percent verified cache coverage but never with an unhealthy stream',()=>{
  assert.equal(EARLY_EXPANSION_RADAR_DEFAULTS.marketWideLightScanMinCoverageRatio,0.10,
    'the actual Radar 8 runtime default must use the verified post-restart coverage floor');
  assert.equal(makeRadar().config.marketWideLightScanMinCoverageRatio,0.10,
    'the constructed radar must not override the 10 percent recovery floor with a stale 85 percent default');
  const partial={expected_symbols:337,ready_symbols:46,websocket_live:true,
    websocket_subscription_complete:true,websocket_sync_ready:true,full_market_coverage_ready:false};
  assert.equal(isMarketWideCachePoolReady(partial,.10),true,
    '46/337 ready symbols plus a live complete subscription should enable guarded candidate pooling');
  assert.equal(isMarketWideCachePoolReady({...partial,ready_symbols:32},.10),false,
    'coverage below the configured 10 percent floor must stay in bootstrap mode');
  assert.equal(isMarketWideCachePoolReady({...partial,websocket_live:false},.10),false,
    'a degraded or disconnected WebSocket must never activate cache-ranked selection');
  assert.equal(isMarketWideCachePoolReady({...partial,websocket_subscription_complete:false},.10),false,
    'all eligible symbols must remain subscribed even when some candle histories are incomplete');
  assert.equal(isMarketWideCachePoolReady({...partial,websocket_sync_ready:false},.10),false,
    'transport synchronization is still required');
  assert.equal(isMarketWideCachePoolReady({...partial,ready_symbols:337},1.01),true,
    'coverage thresholds are clamped to the valid range');
});

test('Radar 8 burst-priority mode gives five Micro slots to verified early activity bursts without expanding the batch',()=>{
  assert.equal(EARLY_EXPANSION_RADAR_DEFAULTS.exceptionalRotationBypassSlots,5);
  const radar=makeRadar({microScanCandidates:18,quietReserve:8,rotationReserve:8,exceptionalRotationBypassSlots:5});
  const input=rows(60),fast=fastMap(input);
  for(const row of input.slice(0,8)){
    fast.set(row.symbol,{price_change_pct:.42,price_acceleration_pct:.20,volume_accel_ratio:3.2,trade_accel_ratio:2.1});
  }
  const selected=radar.selectMicro(input,fast,7);
  const lane=name=>selected.filter(x=>x._selection_lane===name).length;
  assert.equal(selected.length,18,'burst priority cannot increase REST workload per cycle');
  assert.equal(new Set(selected.map(x=>x.symbol)).size,18);
  assert.equal(lane('exceptional'),5,'prioritize up to five independent fast-activity bursts');
  assert.equal(lane('score'),2,'retain ranked-score observations');
  assert.equal(lane('quiet'),6,'retain quiet-base observations');
  assert.equal(lane('rotation'),5,'retain fair rotation coverage');
});

test('Radar 8 Deep burst prioritization still preserves one score slot and one rotation slot',()=>{
  const radar=makeRadar({deepCandidates:5,quietReserve:8,rotationReserve:8,exceptionalRotationBypassSlots:5});
  const items=Array.from({length:12},(_,i)=>candidate('BURST'+String(i).padStart(2,'0')+'USDT',1+i*.1,{score:90-i}));
  for(const item of items.slice(0,5)){
    item.micro_fingerprint.activity_shock={detected:true,stage:'EVENT_DRIVEN_BREAKOUT',score:92,
      watch_only:true,entry_eligible:false,extended:false};
  }
  const selected=radar.selectDeepFromMicro(items,17);
  assert.equal(selected.length,5);
  assert.equal(new Set(selected.map(x=>x.row.symbol)).size,5);
  assert.equal(selected.filter(x=>x._selection_lane==='exceptional').length,3,
    'reserve Deep capacity for score and fair rotation even during simultaneous bursts');
  assert.equal(selected.filter(x=>x._selection_lane==='score'||x._selection_lane==='fill_score').length,1);
  assert.equal(selected.filter(x=>x._selection_lane==='rotation'||x._selection_lane==='fill_rotation').length,1);
});

test('Radar 8 capacity of 18 preserves event, ranked-score, quiet, and rotation lanes',()=>{
  const radar=makeRadar({microScanCandidates:18,quietReserve:8,rotationReserve:8,exceptionalRotationBypassSlots:3});
  const input=rows(60),fast=fastMap(input);
  for(const row of input.slice(0,8)){
    fast.set(row.symbol,{price_change_pct:.42,price_acceleration_pct:.20,volume_accel_ratio:3.2,trade_accel_ratio:2.1});
  }
  const selected=radar.selectMicro(input,fast,7);
  const lane=name=>selected.filter(x=>x._selection_lane===name).length;
  assert.equal(selected.length,18);
  assert.equal(new Set(selected.map(x=>x.symbol)).size,18);
  assert.equal(lane('exceptional'),3);
  assert.equal(lane('score'),2,'two score-ranked slots remain after the event bypass');
  assert.equal(lane('quiet'),6);
  assert.equal(lane('rotation'),7);
});

test('Radar 8 five-slot Deep batch preserves a score-ranked slot when burst events arrive together',()=>{
  const radar=makeRadar({deepCandidates:5,quietReserve:8,rotationReserve:8,exceptionalRotationBypassSlots:3});
  const items=Array.from({length:12},(_,i)=>candidate('DP'+String(i).padStart(2,'0')+'USDT',1+i*.1,{score:90-i}));
  for(const item of items.slice(0,5)){
    item.micro_fingerprint.activity_shock={detected:true,stage:'EVENT_DRIVEN_BREAKOUT',score:92,
      watch_only:true,entry_eligible:false,extended:false};
  }
  const selected=radar.selectDeepFromMicro(items,17);
  assert.equal(selected.length,5);
  assert.equal(new Set(selected.map(x=>x.row.symbol)).size,5);
  assert.equal(selected.filter(x=>x._selection_lane==='exceptional').length,3);
  assert.equal(selected.filter(x=>x._selection_lane==='score'||x._selection_lane==='fill_score').length,1);
  assert.equal(selected.filter(x=>x._selection_lane==='rotation'||x._selection_lane==='fill_rotation').length,1);
});

test('a 48-symbol market-wide light pool preserves the configured Micro capacity of twelve',()=>{
  const radar=makeRadar({microScanCandidates:12,quietReserve:8,rotationReserve:8});
  const input=rows(48);
  const selected=radar.selectMicro(input,fastMap(input),100);
  assert.equal(radar.config.microScanCandidates,12);
  assert.equal(selected.length,12);
  assert.equal(new Set(selected.map(x=>x.symbol)).size,12);
});

test('Radar 8 health remains available while an activity-shock candidate is held',()=>{
  const radar=makeRadar();
  radar.running=true;
  radar.fastShockPendingUntil.set('TESTUSDT',now+60_000);
  const health=radar.health();
  assert.equal(health.running,true);
  assert.equal(health.fast_shock_pending_total,1);
  assert.equal(health.last_error,null);
});

test('Radar 8 schedules the next cycle from actual completion instead of skipping an overrun interval',()=>{
  assert.equal(nextEarlyExpansionPollDelayMs(45000,30000,true),15000);
  assert.equal(nextEarlyExpansionPollDelayMs(45000,45000,true),0);
  assert.equal(nextEarlyExpansionPollDelayMs(45000,61800,true),0);
  assert.equal(nextEarlyExpansionPollDelayMs(45000,64000,true),0);
  assert.equal(nextEarlyExpansionPollDelayMs(45000,1000,false),5000);
  assert.equal(nextEarlyExpansionPollDelayMs(1000,1000,false),1000);
});

test('Radar 8 logs a full-cycle duration and phase timing breakdown',async()=>{
  const events=[];
  const store={
    state:{records:[],last_historical_import_at:0,last_historical_backfill_at:0,last_report_log_at:0,updated_at:now},
    async updatePreExpansionOutcomes(update){
      const next=update(this.state);
      if(next&&next!==false)this.state=next;
      return this.state;
    },
    async readEarlyExpansionAlerts(){return[];},
    async readFalconEyeAlerts(){return[];}
  };
  const rest={
    async request(path){return path.includes('exchangeInfo')?{data:{symbols:[]}}:{data:[]};},
    async klines(){return {candles:[]};},
    async depth(){return {data:{bids:[],asks:[]}};}
  };
  const radar=new EarlyExpansionRadar({
    rest,store,config:{pollMs:45000,microScanCandidates:8,deepCandidates:3},
    clock:()=>now,logger:{info:x=>events.push(String(x)),warn:x=>events.push(String(x))}
  });
  // A stuck scheduler journal write must not hold the background cycle latch.
  radar.scheduler.flush=()=>new Promise(()=>{});
  radar.running=true;
  assert.equal(await radar.tick(),true);
  assert.equal(radar.busy,false,'scan latch must release even if archive flush never resolves');
  const line=events.find(x=>x.startsWith('[RADARX_SCAN_COMPLETE] '));
  assert.ok(line,'complete scan timing log must be emitted');
  const report=JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(report.radar,'RADAR_8');
  assert.equal(report.configured_poll_ms,45000);
  assert.equal(report.scan_duration_ms,0);
  assert.equal(report.scan_overrun_ms,0);
  assert.equal(report.expected_total,0);
  assert.equal(report.received_total,0);
  assert.equal(report.paper_trading,true);
  assert.equal(report.real_order_execution,false);
  for(const key of ['universe_refresh_ms','ticker_fast_selection_ms','market_context_ms','outcome_maintenance_ms','micro_scan_ms','market_micro_overlap_ms','deep_scan_ms','signal_archive_ms','notification_ms','other_ms'])
    assert.ok(Number.isFinite(report.phase_timings_ms[key]),key);
});

test('Radar 8 never awaits optional archive cache rehydration on the live scan path',async()=>{
  let finishHydration;
  let hydrationStarted=false;
  let hydrationCompleted=false;
  const hydrationWait=new Promise(resolve=>{finishHydration=resolve;});
  const store={
    state:{records:[],last_historical_import_at:0,last_historical_backfill_at:0,last_report_log_at:0,updated_at:now},
    async updatePreExpansionOutcomes(update){
      const next=update(this.state);
      if(next&&next!==false)this.state=next;
      return this.state;
    },
    async readEarlyExpansionAlerts(){return[];},
    async readFalconEyeAlerts(){return[];}
  };
  const rest={
    async request(path){return path.includes('exchangeInfo')?{data:{symbols:[]}}:{data:[]};},
    async klines(){return {candles:[]};},
    async depth(){return {data:{bids:[],asks:[]}};}
  };
  const cache={
    running:true,
    setSymbols(){},
    getSeries(){return null;},
    coverageReport(){return {symbols:[]};},
    health(){return {
      running:true,expected_symbols:0,ready_symbols:0,full_market_coverage_ready:false,
      cache_coverage_ready:false,websocket_live:false,websocket_subscription_complete:false,
      websocket_sync_ready:false,websocket_advanced_symbols:0
    };}
  };
  const radar=new EarlyExpansionRadar({
    rest,store,marketWideKlineCache:cache,
    config:{pollMs:45000,marketWideCacheWarmupEnabled:false},
    clock:()=>now,logger:{info(){},warn(){}}
  });
  radar.rehydrateMarketWideCacheFromArchive=async()=>{
    hydrationStarted=true;
    await hydrationWait;
    hydrationCompleted=true;
    return {status:'COMPLETE'};
  };
  radar.running=true;
  assert.equal(await radar.tick(),true);
  assert.equal(hydrationStarted,true,'archive hydration should be dispatched');
  assert.equal(hydrationCompleted,false,'the live scan must finish without waiting for archive file reads/decompression');
  finishHydration();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(hydrationCompleted,true,'the lower-priority archive task can finish independently');
});

test('Radar 8 always releases the cycle latch when scheduler hydration fails',async()=>{
  const events=[];
  const radar=new EarlyExpansionRadar({
    rest:{},store:{},
    clock:()=>now,
    logger:{info:x=>events.push(String(x)),warn:x=>events.push(String(x))}
  });
  radar.running=true;
  radar.scheduler.hydrate=async()=>{throw new Error('SIMULATED_SCHEDULER_HYDRATE_FAILURE');};
  assert.equal(await radar.tick(),false);
  assert.equal(radar.busy,false,'failed hydration must not leave the scanner permanently busy');
  assert.match(radar.lastError,/SIMULATED_SCHEDULER_HYDRATE_FAILURE/);
});

test('Radar 8 starts 15m, 1h, 4h and depth reads concurrently for each deep candidate',async()=>{
  let active=0,maxActive=0;
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const rest={
    async klines(symbol,interval){
      active++;maxActive=Math.max(maxActive,active);
      await delay(20);active--;
      return {source:'TEST_FIXTURE',candles:[]};
    },
    async depth(){
      active++;maxActive=Math.max(maxActive,active);
      await delay(20);active--;
      return {source:'TEST_FIXTURE',data:{bids:[],asks:[]}};
    }
  };
  const radar=new EarlyExpansionRadar({rest,store:{},config:{retryAttempts:1},clock:()=>now,logger:{warn(){}}});
  const result=await radar.deepScan(
    {symbol:'PARALLELUSDT',lastPrice:1,priceChange24h:1,quoteVolume24h:1_000_000,tradeCount24h:1000},
    {},{}, {oneMinute:[],fiveMinute:[],source:'TEST_FIXTURE'}
  );
  assert.ok(Number.isFinite(result.data_quality));
  assert.equal(maxActive,4,JSON.stringify({maxActive}));
});

test('Radar 8 fills the 36 unique-symbol micro batch across overlapping selector lanes',()=>{
  const radar=makeRadar({microScanCandidates:36,quietReserve:8,rotationReserve:8});
  const input=rows(60);
  const selected=radar.selectMicro([...input,input[0],input[1]],fastMap(input),1);
  assert.equal(selected.length,36);
  assert.equal(new Set(selected.map(x=>x.symbol.toUpperCase())).size,36);
  assert.equal(selected.filter(x=>x._selection_lane==='quiet').length,8);
  assert.equal(selected.filter(x=>x._selection_lane==='rotation').length,8);
});

test('Radar 8 quiet micro lane orders lowest valid daily change when participation is waking',()=>{
  const radar=makeRadar({microScanCandidates:10,quietReserve:5,rotationReserve:2});
  const input=rows(20);
  const overrides={};
  overrides[input[0].symbol]={price_change_pct:.12,price_acceleration_pct:.08,volume_accel_ratio:1.5,trade_accel_ratio:1.3};
  const fast=fastMap(input,overrides);
  const selected=radar.selectMicro(input,fast,1);
  const quiet=selected.filter(x=>x._selection_lane==='quiet');
  assert.equal(quiet.length,3);
  const quietMoves=quiet.map(x=>Math.abs(x.priceChange24h));
  assert.deepEqual(quietMoves,[...quietMoves].sort((a,b)=>a-b));
  assert.ok(quietMoves.every(x=>x<=8));
});

test('Radar 8 does not classify missing daily change as a quiet candidate',()=>{
  const radar=makeRadar({microScanCandidates:10,quietReserve:4,rotationReserve:2});
  const input=[...rows(12),{symbol:'UNKNOWN24HUSDT',lastPrice:1.2,quoteVolume24h:1_000_000,tradeCount24h:20000}];
  const fast=fastMap(input,{'UNKNOWN24HUSDT':{price_change_pct:.4,price_acceleration_pct:.2,volume_accel_ratio:3.1,trade_accel_ratio:2.4}});
  const selected=radar.selectMicro(input,fast,1);
  assert.equal(selected.length,10);
  assert.equal(selected.some(x=>x.symbol==='UNKNOWN24HUSDT'&&x._selection_lane==='quiet'),false);
});

test('Radar 8 excludes benchmarks and tokenized-equity symbols even before the full-market cache is ready',()=>{
  const radar=makeRadar({microScanCandidates:12,quietReserve:4,rotationReserve:3});
  const input=rows(24);
  input.push(
    {symbol:'BTCUSDT',lastPrice:65000,priceChange24h:1,quoteVolume24h:50_000_000,tradeCount24h:100000},
    {symbol:'BNBUSDT',lastPrice:600,priceChange24h:2,quoteVolume24h:10_000_000,tradeCount24h:50000},
    {symbol:'SOXLBUSDT',lastPrice:14,priceChange24h:5,quoteVolume24h:5_000_000,tradeCount24h:30000}
  );
  const selected=radar.selectMicro(input,fastMap(input),11);
  assert.equal(selected.length,12);
  assert.ok(selected.every(x=>!['BTCUSDT','BNBUSDT','SOXLBUSDT'].includes(x.symbol)));
});

test('Radar 8 prioritizes symbols not covered in the prior rotation cycle',()=>{
  const radar=makeRadar({microScanCandidates:10,quietReserve:0,rotationReserve:5});
  const input=rows(50),fast=fastMap(input);
  const first=radar.selectMicro(input,fast,1);
  const second=radar.selectMicro(input,fast,2);
  const firstSymbols=new Set(first.map(x=>x.symbol));
  assert.equal(first.length,10);
  assert.equal(second.length,10);
  assert.equal(second.filter(x=>!firstSymbols.has(x.symbol)).length,5,JSON.stringify({first:first.map(x=>({s:x.symbol,l:x._selection_lane,age:x._rotationAge})),second:second.map(x=>({s:x.symbol,l:x._selection_lane,age:x._rotationAge})),overlap:second.filter(x=>firstSymbols.has(x.symbol)).map(x=>x.symbol)}));
  assert.equal(second.filter(x=>x._selection_lane==='rotation').length,5);
});

test('Radar 8 exceptional acceleration may bypass rotation without changing batch size',()=>{
  const radar=makeRadar({microScanCandidates:8,quietReserve:2,rotationReserve:3,exceptionalRotationBypassSlots:2});
  const input=rows(40);
  input.push({symbol:'ZZZFASTUSDT',lastPrice:1,priceChange24h:3.5,quoteVolume24h:1_200_000,tradeCount24h:30000});
  const fast=fastMap(input);
  fast.set('ZZZFASTUSDT',{price_change_pct:.85,price_acceleration_pct:.28,volume_accel_ratio:3.8,trade_accel_ratio:2.7});
  const selected=radar.selectMicro(input,fast,1);
  assert.equal(selected.length,8);
  assert.equal(selected[0].symbol,'ZZZFASTUSDT');
  assert.equal(selected[0]._selection_lane,'exceptional');
});

test('Radar 8 gives confirmed activity shocks a deep-scan bypass without granting entry eligibility',()=>{
  const radar=makeRadar({deepCandidates:4,quietReserve:1,rotationReserve:1,exceptionalRotationBypassSlots:2});
  const event=candidate('EVENTUSDT',25,{score:57,participation:65,tradeParticipation:66,structure:48,compression:45,volume:1.1,trades:1.0});
  event.micro_fingerprint.activity_shock={detected:true,stage:'EVENT_DRIVEN_BREAKOUT',score:92,watch_only:true,entry_eligible:false,extended:true};
  const others=[candidate('AAAUSDT',2,{score:89}),candidate('BBBUSTDT',3,{score:88}),candidate('CCCUSDT',1,{score:84}),candidate('DDDUSDT',4,{score:82})];
  const selected=radar.selectDeepFromMicro([event,...others],9);
  assert.ok(selected.some(x=>x.row.symbol==='EVENTUSDT'&&x._selection_lane==='exceptional'));
  assert.equal(selected.length,4,'one exceptional event must not overfill a four-slot Deep batch');
  assert.equal(selected.filter(x=>x._selection_lane==='rotation'||x._selection_lane==='fill_rotation').length,1,
    'an exceptional event replaces one score slot; it must not erase fair rotation');
  assert.equal(selected.filter(x=>x._selection_lane==='score'||x._selection_lane==='fill_score').length,1);
  assert.equal(event.micro_fingerprint.activity_shock.entry_eligible,false);
});

test('Radar 8 gives a market-wide confirmed burst deep priority even when Micro score is weak',()=>{
  const radar=makeRadar({deepCandidates:3,quietReserve:1,rotationReserve:1,exceptionalRotationBypassSlots:2});
  const event=candidate('PLUMEUSDT',16,{score:18,participation:48,tradeParticipation:48,structure:42,compression:42,volume:1.0,trades:1.0});
  event.fast={
    price_change_pct:.42,price_acceleration_pct:.21,volume_accel_ratio:2.8,trade_accel_ratio:2.0,
    market_wide_event_driven_breakout:{detected:true,stage:'EVENT_DRIVEN_BREAKOUT',needs_micro_confirmation:true}
  };
  const others=[
    candidate('HIGH1USDT',10,{score:95}),candidate('HIGH2USDT',11,{score:91}),
    candidate('HIGH3USDT',12,{score:87}),candidate('HIGH4USDT',13,{score:85})
  ];
  radar.lastDeepScanCycleBySymbol.set('PLUMEUSDT',30);
  radar.lastDeepAtBySymbol.set('PLUMEUSDT',now-1000);
  radar.scheduler.lastStartedAt.set('DEEP:PLUMEUSDT',now-1000);
  const selected=radar.selectDeepFromMicro([event,...others],31);
  assert.ok(selected.some(x=>x.row.symbol==='PLUMEUSDT'&&x._selection_lane==='exceptional'));
  assert.equal(event.micro_fingerprint.eligible,false,'Deep priority does not grant alert eligibility');
});

test('Radar 8 gives two simultaneous confirmed bursts two deep slots while preserving rotation',()=>{
  const radar=makeRadar({deepCandidates:3,quietReserve:1,rotationReserve:1,exceptionalRotationBypassSlots:2});
  const mkEvent=(symbol,score)=> {
    const item=candidate(symbol,16,{score,participation:48,tradeParticipation:48,structure:42,compression:42,volume:1.0,trades:1.0});
    item.fast={price_change_pct:.40,price_acceleration_pct:.20,volume_accel_ratio:2.8,trade_accel_ratio:2.0,
      market_wide_event_driven_breakout:{detected:true,stage:'EVENT_DRIVEN_BREAKOUT',needs_micro_confirmation:true}};
    radar.lastDeepScanCycleBySymbol.set(symbol,30);radar.lastDeepAtBySymbol.set(symbol,now-1000);
    return item;
  };
  const a=mkEvent('EVENTAUSDT',20),b=mkEvent('EVENTBUSDT',19);
  const others=[candidate('HIGH1USDT',10,{score:95}),candidate('HIGH2USDT',11,{score:91}),candidate('HIGH3USDT',12,{score:87})];
  const selected=radar.selectDeepFromMicro([a,b,...others],31);
  assert.equal(selected.filter(x=>x._selection_lane==='exceptional').length,2);
  assert.ok(selected.some(x=>x.row.symbol==='EVENTAUSDT'));
  assert.ok(selected.some(x=>x.row.symbol==='EVENTBUSDT'));
});

test('Radar 8 ten-slot Deep batch preserves three fair-rotation slots during concurrent burst events',()=>{
  const radar=makeRadar({deepCandidates:10,quietReserve:8,rotationReserve:8,exceptionalRotationBypassSlots:5});
  const items=Array.from({length:24},(_,i)=>candidate(
    'FAIR'+String(i).padStart(2,'0')+'USDT',
    .15+i*.18,
    {score:94-i,participation:82,tradeParticipation:78,structure:80,compression:84,volume:1.8,trades:1.6}
  ));
  for(const item of items.slice(0,8)){
    item.micro_fingerprint.activity_shock={detected:true,stage:'EVENT_DRIVEN_BREAKOUT',score:92,
      watch_only:true,entry_eligible:false,extended:false};
  }
  const selected=radar.selectDeepFromMicro(items,44);
  const lane=name=>selected.filter(x=>x._selection_lane===name||x._selection_lane==='fill_'+name).length;
  assert.equal(selected.length,10);
  assert.equal(new Set(selected.map(x=>x.row.symbol)).size,10);
  assert.equal(lane('exceptional'),3,'retain the capped fast-event reserve');
  assert.equal(lane('quiet'),2,'retain quiet-base early detection');
  assert.equal(lane('rotation'),3,'rotate three never/longest-waiting symbols into deep analysis');
  assert.equal(lane('score'),2,'retain score-ranked capacity after event and fairness reserves');
});

test('Radar 8 deep scan preserves score capacity while selecting quiet bases from smallest move first',()=>{
  const radar=makeRadar({deepCandidates:10,quietReserve:8,rotationReserve:2});
  const candidates=[
    candidate('ZZZQUIETUSDT',.12,{score:54,volume:1.8,trades:1.7}),
    candidate('AAAUSDT',7.4,{score:92,volume:1.2,trades:1.1}),
    candidate('BBBUSDT',4.6,{score:85}),candidate('CCCUSDT',2.2,{score:76}),
    candidate('DDDUSDT',.65,{score:66}),candidate('EEEUSDT',1.1,{score:62}),
    candidate('FFFUSDT',3.4,{score:60}),candidate('GGGUSDT',5.1,{score:59}),
    candidate('HHHUSDT',.85,{score:57}),candidate('IIIUSDT',6.5,{score:55}),
    candidate('JJJUSDT',2.8,{score:53}),candidate('KKKUSDT',1.7,{score:52})
  ];
  const selected=radar.selectDeepFromMicro(candidates,1);
  assert.equal(selected.length,10);
  assert.equal(new Set(selected.map(x=>x.row.symbol)).size,10);
  const quiet=selected.filter(x=>x._selection_lane==='quiet');
  assert.equal(quiet.length,3);
  assert.equal(quiet[0].row.symbol,'ZZZQUIETUSDT');
});

test('Radar 8 deep scan de-duplicates row-wrapped candidates and fills ten slots',()=>{
  const radar=makeRadar({deepCandidates:10,quietReserve:8,rotationReserve:2});
  const input=Array.from({length:24},(_,i)=>candidate('DEEP'+String(i).padStart(2,'0')+'USDT',.25+(i%10)*.45,{
    score:90-(i%7),participation:75,tradeParticipation:72,structure:78,compression:82
  }));
  const selected=radar.selectDeepFromMicro([...input,input[0],input[1]],4);
  assert.equal(selected.length,10);
  assert.equal(new Set(selected.map(x=>x.row.symbol)).size,10);
  assert.equal(selected.filter(x=>x._selection_lane==='quiet').length,3);
});


test('Radar 8 micro rotation gives priority to symbols that have never reached Deep even when recently micro-scanned',()=>{
  const radar=makeRadar({microScanCandidates:4,quietReserve:0,rotationReserve:3,exceptionalRotationBypassSlots:0});
  const input=rows(12),fast=fastMap(input);
  for(let i=0;i<input.length;i++){
    const symbol=input[i].symbol;
    radar.scheduler.lastStartedAt.set(`MICRO:${symbol}`,now-(input.length-i)*1000);
    radar.lastMicroScanCycleBySymbol.set(symbol,10+i);
    radar.lastDeepScanCycleBySymbol.set(symbol,25);
    radar.lastDeepAtBySymbol.set(symbol,now-90_000);
    radar.firstEligibleAtBySymbol.set(symbol,now-3_600_000+i*1000);
  }
  const target=input.at(-1).symbol;
  radar.lastDeepScanCycleBySymbol.delete(target);
  radar.lastDeepAtBySymbol.delete(target);
  // Historical STARTED means an attempt happened, not that Deep completed.
  radar.scheduler.lastStartedAt.set(`DEEP:${target}`,now-60_000);
  radar.firstEligibleAtBySymbol.set(target,now-3_600_000);
  fast.set(target,{price_change_pct:0.001,price_acceleration_pct:0,volume_accel_ratio:1,trade_accel_ratio:1});
  const selected=radar.selectMicro(input,fast,30);
  assert.ok(selected.some(x=>x.symbol===target&&x._selection_lane==='rotation'),
    JSON.stringify({target,selected:selected.map(x=>({symbol:x.symbol,lane:x._selection_lane,neverDeep:x._neverDeepScanned}))}));
});

test('Radar 8 deep rotation prioritizes never-scanned eligible symbols over recently scanned symbols',()=>{
  const radar=makeRadar({deepCandidates:3,quietReserve:0,rotationReserve:2,exceptionalRotationBypassSlots:0});
  const items=[
    candidate('DEEPOK1USDT',4,{score:95}),
    candidate('DEEPOK2USDT',3,{score:88}),
    candidate('DEEPOK3USDT',2,{score:82}),
    candidate('DEEPOK4USDT',1,{score:75}),
    candidate('DEEPNONEUSDT',.2,{score:10})
  ];
  for(const item of items){
    const symbol=item.row.symbol;
    radar.lastDeepScanCycleBySymbol.set(symbol,25);
    radar.lastDeepAtBySymbol.set(symbol,now-60_000);
    radar.scheduler.lastStartedAt.set(`DEEP:${symbol}`,now-60_000);
    radar.firstEligibleAtBySymbol.set(symbol,now-300_000);
  }
  const target='DEEPNONEUSDT';
  radar.lastDeepScanCycleBySymbol.delete(target);
  radar.lastDeepAtBySymbol.delete(target);
  // A persisted start from a previous failed attempt must not erase the completion gap.
  radar.scheduler.lastStartedAt.set(`DEEP:${target}`,now-60_000);
  radar.firstEligibleAtBySymbol.set(target,now-3_600_000);
  const selected=radar.selectDeepFromMicro(items,30);
  assert.ok(selected.some(x=>x.row.symbol===target&&x._selection_lane==='rotation'),
    JSON.stringify({target,selected:selected.map(x=>({symbol:x.row.symbol,lane:x._selection_lane,neverDeep:x._neverScanned,wait:x._deepWaitAgeMs}))}));
});


function alignedClosedCandles(symbol, intervalMs, count, at=now) {
  const latestClose=Math.floor(at/intervalMs)*intervalMs-1;
  return Array.from({length:count},(_,i)=>{
    const openTime=latestClose-intervalMs+1-(count-1-i)*intervalMs;
    return {
      symbol,openTime,closeTime:openTime+intervalMs-1,
      open:100,high:101,low:99,close:100.5,volume:100,
      quoteVolume:10000,tradeCount:100,takerBuyBaseVolume:60,takerBuyQuoteVolume:6000,
      closed:true,source:'BINANCE_PUBLIC_REST',receivedAt:at-1000
    };
  });
}

test('Radar 8 reuses a validated local closed 5m window on the next cycle',async()=>{
  const calls={'1m':0,'5m':0};
  const rest={
    health:()=>({shared_requests_last_minute:100,shared_max_requests_per_minute:420,shared_estimated_weight_last_minute:0,shared_max_weight_per_minute:4000}),
    async klines(symbol,interval,{limit}={}){
      calls[interval]=(calls[interval]||0)+1;
      const step=interval==='1m'?60_000:interval==='5m'?300_000:900_000;
      return {source:'https://data-api.binance.vision',candles:alignedClosedCandles(symbol,step,limit||3,now)};
    }
  };
  const radar=new EarlyExpansionRadar({rest,store:{},config:{
    oneMinuteKlines:3,fiveMinuteKlines:3,retryAttempts:0
  },clock:()=>now,logger:{warn(){}}});
  const row={symbol:'CACHE5MUSDT',lastPrice:100,priceChange24h:0.5,quoteVolume24h:2_000_000,tradeCount24h:5000};
  const first=await radar.microScan(row,{},[]);
  assert.equal(first.five_minute_cache_hit,false);
  assert.equal(calls['5m'],1);
  assert.equal(radar.microFiveMinuteWindowCache.size,1);
  const second=await radar.microScan(row,{},[]);
  assert.equal(second.five_minute_cache_hit,true);
  assert.equal(second.five_minute_cache_tier,'RADAR8_LOCAL');
  assert.equal(calls['5m'],1,'fresh validated 5m data must not incur a duplicate REST request');
  assert.equal(calls['1m'],2,'1m remains live each cycle');
});

test('Radar 8 post-cycle ring cleanup prunes inactive symbols and bounds scheduler retry buffers',()=>{
  const radar=makeRadar({fiveMinuteKlines:3,maxActivityShockAlertsPerHour:6});
  radar.universe=['LIVEUSDT','KEEPUSDT'];
  radar.fastState.set('LIVEUSDT',[{price:1}]);
  radar.fastState.set('DELISTEDUSDT',Array.from({length:20},(_,i)=>({price:i+1})));
  radar.lastAlertAt.set('LIVEUSDT',now-1000);
  radar.lastAlertAt.set('DELISTEDUSDT',now-1000);
  radar.lastMicroScanCycleBySymbol.set('LIVEUSDT',10);
  radar.lastMicroScanCycleBySymbol.set('DELISTEDUSDT',1);
  radar.scheduler.lastStartedAt.set('MICRO:LIVEUSDT',now-1000);
  radar.scheduler.lastStartedAt.set('MICRO:DELISTEDUSDT',now-1000);
  radar.scheduler.queuedAt.set('DEEP:KEEPUSDT',now-1000);
  radar.scheduler.queuedAt.set('DEEP:DELISTEDUSDT',now-1000);
  radar.fastShockPendingUntil.set('LIVEUSDT',now+60_000);
  radar.fastShockPendingUntil.set('DELISTEDUSDT',now+60_000);
  radar.fastShockPendingUntil.set('KEEPUSDT',now-1);
  radar.activityShockTimestamps=[now-2*60*60*1000,now-1000];
  radar.scheduler.buffer=Array.from({length:5002},(_,i)=>({event_at:i}));
  const cleanup=radar.cleanupRuntimeRingBuffers(now);
  assert.equal(radar.fastState.has('LIVEUSDT'),true);
  assert.equal(radar.fastState.has('DELISTEDUSDT'),false);
  assert.equal(radar.lastAlertAt.has('LIVEUSDT'),true);
  assert.equal(radar.lastAlertAt.has('DELISTEDUSDT'),false);
  assert.equal(radar.lastMicroScanCycleBySymbol.has('LIVEUSDT'),true);
  assert.equal(radar.lastMicroScanCycleBySymbol.has('DELISTEDUSDT'),false);
  assert.equal(radar.scheduler.lastStartedAt.has('MICRO:LIVEUSDT'),true);
  assert.equal(radar.scheduler.lastStartedAt.has('MICRO:DELISTEDUSDT'),false);
  assert.equal(radar.scheduler.queuedAt.has('DEEP:KEEPUSDT'),true);
  assert.equal(radar.scheduler.queuedAt.has('DEEP:DELISTEDUSDT'),false);
  assert.equal(radar.fastShockPendingUntil.has('LIVEUSDT'),true);
  assert.equal(radar.fastShockPendingUntil.has('DELISTEDUSDT'),false);
  assert.equal(radar.fastShockPendingUntil.has('KEEPUSDT'),false);
  assert.equal(radar.activityShockTimestamps.length,1);
  assert.equal(radar.scheduler.buffer.length,5000);
  assert.equal(radar.schedulerBufferEventsDroppedTotal,2);
  assert.equal(cleanup.scheduler_buffer_dropped_this_cycle,2);
  assert.ok(cleanup.removed_inactive_symbol_entries>=6);
});

test('Radar 8 post-cycle cleanup preserves rehydrated state when the universe snapshot is unavailable',()=>{
  const radar=makeRadar();
  radar.universe=[];
  radar.lastMicroScanCycleBySymbol.set('RESTOREDUSDT',12);
  radar.lastDeepScanCycleBySymbol.set('RESTOREDUSDT',10);
  radar.scheduler.lastStartedAt.set('MICRO:RESTOREDUSDT',now-1000);
  radar.scheduler.queuedAt.set('DEEP:RESTOREDUSDT',now-2000);
  radar.marketWideCacheArchiveLastEligibleSymbols.add('RESTOREDUSDT');
  const cleanup=radar.cleanupRuntimeRingBuffers(now);
  assert.equal(cleanup.active_symbols,0);
  assert.equal(radar.lastMicroScanCycleBySymbol.has('RESTOREDUSDT'),true);
  assert.equal(radar.lastDeepScanCycleBySymbol.has('RESTOREDUSDT'),true);
  assert.equal(radar.scheduler.lastStartedAt.has('MICRO:RESTOREDUSDT'),true);
  assert.equal(radar.scheduler.queuedAt.has('DEEP:RESTOREDUSDT'),true);
  assert.equal(radar.marketWideCacheArchiveLastEligibleSymbols.has('RESTOREDUSDT'),true);
});

test('Radar 8 scheduled cycles force GC after tick and report post-GC RSS',async()=>{
  const originalGc=globalThis.gc;
  let gcCalls=0;
  const logRows=[];
  try{
    globalThis.gc=()=>{gcCalls++;};
    const radar=makeRadar();
    radar.tick=async()=>{radar.scans++;return true;};
    radar.logger={info(message){logRows.push(String(message));},warn(){}};
    radar.config={...radar.config,pollMs:45_000};
    radar.start();
    const stopAt=Date.now()+500;
    while(Date.now()<stopAt&&!logRows.some(row=>row.startsWith('[RADARX_POST_CYCLE_MEMORY]')))
      await new Promise(resolve=>setTimeout(resolve,10));
    await radar.stop();
    const reportLine=logRows.find(row=>row.startsWith('[RADARX_POST_CYCLE_MEMORY]'));
    assert.ok(reportLine,'scheduled cycle must emit post-GC memory telemetry');
    const report=JSON.parse(reportLine.slice(reportLine.indexOf('{')));
    assert.equal(gcCalls,1);
    assert.equal(report.forced_gc_available,true);
    assert.equal(report.forced_gc_ran,true);
    assert.equal(report.completed,true);
    assert.equal(report.cycle,1);
    assert.equal(typeof report.rss_under_036_gib,'boolean');
    assert.equal(report.cleanup.active_symbols,0);
  }finally{
    if(originalGc===undefined)delete globalThis.gc;else globalThis.gc=originalGc;
  }
});

test('Radar 8 cache cleanup evicts stale timeframe windows and remains bounded',()=>{
  const radar=makeRadar({fiveMinuteKlines:3});
  radar.deepCandleWindowCache.set('OLDUSDT:15m:160',{candles:[{}],latestCloseTime:0});
  radar.microFiveMinuteWindowCache.set('OLDUSDT',{candles:[{}],latestCloseTime:0});
  const report=radar.pruneCandleWindowCaches(now);
  assert.equal(report.deep_removed,1);
  assert.equal(report.micro_5m_removed,1);
  assert.equal(report.deep_entries,0);
  assert.equal(report.micro_5m_entries,0);
});

test('Radar 8 post-cycle trimming evicts inactive and low-momentum candle windows but preserves rising activity and recent scans',()=>{
  const radar=makeRadar({fiveMinuteKlines:3});
  radar.scans=20;
  radar.universe=['SLEEPYUSDT','QUIETBASEUSDT','ACTIVEUSDT'];
  const makeHistory=(baseline,recent)=>[
    ...Array.from({length:5},(_,i)=>({price:1,quote:1000,trades:1000,qDelta:baseline.quote,tDelta:baseline.trades,priceChange:0.001,at:now-(8-i)*45_000})),
    ...Array.from({length:3},(_,i)=>({price:1,quote:1000,trades:1000,qDelta:recent.quote,tDelta:recent.trades,
      priceChange:recent.move??0.001,at:now-(2-i)*45_000}))
  ];
  radar.fastState.set('SLEEPYUSDT',makeHistory({quote:100,trades:10},{quote:100,trades:10}));
  // Low price movement alone must not evict a quiet base whose participation is rising.
  radar.fastState.set('QUIETBASEUSDT',makeHistory({quote:100,trades:10},{quote:160,trades:18}));
  // A moving or just-scanned symbol must keep its cache for immediate deep analysis.
  radar.fastState.set('ACTIVEUSDT',makeHistory({quote:100,trades:10},{quote:100,trades:10,move:0.15}));
  radar.lastDeepScanCycleBySymbol.set('ACTIVEUSDT',20);
  const latest15m=Math.floor(now/(15*60_000))*(15*60_000)-1;
  const latest5m=Math.floor(now/(5*60_000))*(5*60_000)-1;
  const putCache=(symbol)=>{
    radar.deepCandleWindowCache.set(symbol+':15m:160',{
      candles:Array.from({length:60},()=>({closed:true})),latestCloseTime:latest15m,cachedAt:now
    });
    radar.microFiveMinuteWindowCache.set(symbol,{
      candles:Array.from({length:3},()=>({closed:true})),latestCloseTime:latest5m,cachedAt:now
    });
  };
  for(const symbol of ['SLEEPYUSDT','QUIETBASEUSDT','ACTIVEUSDT','GONEUSDT'])putCache(symbol);
  const cleanup=radar.cleanupRuntimeRingBuffers(now);
  assert.equal(radar.deepCandleWindowCache.has('SLEEPYUSDT:15m:160'),false);
  assert.equal(radar.microFiveMinuteWindowCache.has('SLEEPYUSDT'),false);
  assert.equal(radar.deepCandleWindowCache.has('GONEUSDT:15m:160'),false);
  assert.equal(radar.microFiveMinuteWindowCache.has('GONEUSDT'),false);
  assert.equal(radar.deepCandleWindowCache.has('QUIETBASEUSDT:15m:160'),true);
  assert.equal(radar.microFiveMinuteWindowCache.has('QUIETBASEUSDT'),true);
  assert.equal(radar.deepCandleWindowCache.has('ACTIVEUSDT:15m:160'),true);
  assert.equal(radar.microFiveMinuteWindowCache.has('ACTIVEUSDT'),true);
  assert.equal(cleanup.low_momentum_cache_trim.low_momentum_symbols_removed,1);
  assert.equal(cleanup.low_momentum_cache_trim.inactive_symbols_removed,1);
  assert.equal(cleanup.low_momentum_cache_trim.deep_windows_removed,2);
  assert.equal(cleanup.low_momentum_cache_trim.micro_5m_windows_removed,2);
  assert.equal(cleanup.low_momentum_cache_trim.candle_rows_released,126);
});


test('Deep starvation telemetry ignores non-directional assets but preserves directional rotation debt',()=>{
  const pending=buildDirectionalDeepPendingQueue({
    eligible:[
      {symbol:'XUSDUSDT'},
      {symbol:'ADAUSDT'},
      {symbol:'TRXUSDT'}
    ],
    deepThisCycle:new Set(['TRXUSDT']),
    lastDeepAtBySymbol:new Map(),
    firstEligibleAtBySymbol:new Map([
      ['XUSDUSDT',now-9_740*60_000],
      ['ADAUSDT',now-5*60_000],
      ['TRXUSDT',now-10*60_000]
    ]),
    priorDeepCycles:new Map([['XUSDUSDT',12],['ADAUSDT',0],['TRXUSDT',8108]]),
    fastScanAt:now-1_000,
    completedAt:now,
    cycle:8109
  });
  assert.deepEqual(pending.map(row=>row.symbol),['ADAUSDT']);
  assert.equal(pending[0].never_deep_scanned,true);
  assert.equal(pending[0].wait_ms,5*60_000);
  assert.equal(pending[0].wait_cycles,8109);
});


test('Radar 8 Micro rotation pays down the oldest Deep wait even when that symbol was recently micro-scanned',()=>{
  const radar=makeRadar({microScanCandidates:4,quietReserve:0,rotationReserve:3,exceptionalRotationBypassSlots:0});
  const input=rows(12),fast=fastMap(input);
  const target=input[0].symbol;
  for(let i=0;i<input.length;i++){
    const symbol=input[i].symbol;
    // Target was micro-scanned 1 second ago but has waited two days for a successful Deep scan.
    // Other symbols have older Micro scans, but each completed Deep within the last 15 minutes.
    radar.scheduler.lastStartedAt.set(`MICRO:${symbol}`,now-(symbol===target?1000:60_000+i*1000));
    radar.lastMicroScanCycleBySymbol.set(symbol,30-i);
    radar.lastDeepScanCycleBySymbol.set(symbol,25);
    radar.lastDeepAtBySymbol.set(symbol,now-(symbol===target?48*60*60*1000:15*60*1000));
    radar.firstEligibleAtBySymbol.set(symbol,now-(symbol===target?72*60*60*1000:60*60*1000));
  }
  fast.set(target,{price_change_pct:0.001,price_acceleration_pct:0,volume_accel_ratio:1,trade_accel_ratio:1});
  const selected=radar.selectMicro(input,fast,31);
  assert.ok(selected.some(x=>x.symbol===target&&x._selection_lane==='rotation'),
    JSON.stringify({target,selected:selected.map(x=>({symbol:x.symbol,lane:x._selection_lane,deepWaitMs:x._deepWaitAgeMs,microAgeMs:x._rotationAgeMs}))}));
});


test('Radar 8 admits only a bounded under-floor activity burst to Micro watch',()=>{
  const floor=100_000;
  const input=[
    {symbol:'LOWAUSDT',lastPrice:1.2,priceChange24h:1.1,quoteVolume24h:55_000,tradeCount24h:1000},
    {symbol:'LOWBUSDT',lastPrice:2.4,priceChange24h:2.0,quoteVolume24h:90_000,tradeCount24h:2500},
    {symbol:'TOOLOWUSDT',lastPrice:1,priceChange24h:.5,quoteVolume24h:9_000,tradeCount24h:100},
    {symbol:'BTCUSDT',lastPrice:65_000,priceChange24h:.7,quoteVolume24h:60_000,tradeCount24h:5000},
    {symbol:'STALEUSDT',lastPrice:1,priceChange24h:.5,quoteVolume24h:60_000,tradeCount24h:1000},
    {symbol:'FLOORUSDT',lastPrice:1,priceChange24h:.5,quoteVolume24h:floor,tradeCount24h:1000},
    {symbol:'NOFASTUSDT',lastPrice:1,priceChange24h:.2,quoteVolume24h:60_000,tradeCount24h:1000}
  ];
  const fastBySymbol=new Map(input.map(row=>[row.symbol,{
    price_change_pct:.5,price_acceleration_pct:.2,volume_accel_ratio:8,trade_accel_ratio:5
  }]));
  fastBySymbol.set('NOFASTUSDT',{
    price_change_pct:.01,price_acceleration_pct:0,volume_accel_ratio:1.1,trade_accel_ratio:1.05
  });
  const pendingUntilBySymbol=new Map([
    ['LOWAUSDT',now+60_000],['LOWBUSDT',now+60_000],
    ['TOOLOWUSDT',now+60_000],['BTCUSDT',now+60_000],
    ['STALEUSDT',now-1],['FLOORUSDT',now+60_000],['NOFASTUSDT',now+60_000]
  ]);
  const selected=selectUnderfloorFastShockCandidates({
    rows:input,fastBySymbol,pendingUntilBySymbol,now,
    minQuoteVolume24h:floor,minQuoteVolumeRatio:.10,limit:1
  });
  assert.equal(selected.length,1,'the under-floor burst capacity remains explicitly capped');
  assert.ok(['LOWAUSDT','LOWBUSDT'].includes(selected[0].symbol));
  assert.equal(selected[0]._low_liquidity_burst_bypass,true);
  assert.ok(selected[0].quoteVolume24h>=floor*.10&&selected[0].quoteVolume24h<floor);
  assert.ok(!selected.some(row=>['TOOLOWUSDT','BTCUSDT','STALEUSDT','FLOORUSDT','NOFASTUSDT'].includes(row.symbol)));
});

test('Radar 8 under-floor bypass rejects expired or unconfirmed ticker shocks',()=>{
  const floor=100_000;
  const input=[
    {symbol:'EXPIREDUSDT',lastPrice:1,priceChange24h:1,quoteVolume24h:50_000},
    {symbol:'QUIETUSDT',lastPrice:1,priceChange24h:1,quoteVolume24h:60_000}
  ];
  const fastBySymbol=new Map([
    ['EXPIREDUSDT',{price_change_pct:.5,price_acceleration_pct:.2,volume_accel_ratio:8,trade_accel_ratio:5}],
    ['QUIETUSDT',{price_change_pct:.01,price_acceleration_pct:0,volume_accel_ratio:1.1,trade_accel_ratio:1.05}]
  ]);
  const result=selectUnderfloorFastShockCandidates({
    rows:input,fastBySymbol,
    pendingUntilBySymbol:new Map([['EXPIREDUSDT',now-1],['QUIETUSDT',now+60_000]]),
    now,minQuoteVolume24h:floor,minQuoteVolumeRatio:.10,limit:2
  });
  assert.deepEqual(result,[]);
  assert.deepEqual(selectUnderfloorFastShockCandidates({
    rows:input,fastBySymbol,pendingUntilBySymbol:new Map(),now,
    minQuoteVolume24h:floor,minQuoteVolumeRatio:.10,limit:2
  }),[]);
});



test('Radar 8 reserves at most one Deep watch slot for a qualified under-floor burst',()=>{
  const radar=makeRadar({deepCandidates:4,quietReserve:1,rotationReserve:1,exceptionalRotationBypassSlots:2});
  const mkUnderfloor=(symbol,score,volume,trades)=>{
    const item=candidate(symbol,1.2,{score,participation:78,tradeParticipation:76,structure:70,compression:76,volume,trades});
    item.row.quoteVolume24h=55_000;
    item.row._low_liquidity_burst_bypass=true;
    item.fast={price_change_pct:.22,price_acceleration_pct:.04,volume_accel_ratio:1.5,trade_accel_ratio:1.4};
    item.micro_fingerprint.closed_candles_only=true;
    item.micro_fingerprint.stage='WATCH';
    item.micro_fingerprint.eligible=false;
    item.micro_fingerprint.confirmation_count=4;
    item.micro_fingerprint.metrics={
      ...item.micro_fingerprint.metrics,
      return_1m:.18,return_5m:.42,acceleration_1m_pct:.03,acceleration_5m_pct:.08,
      rvol_1m:volume,rvol_5m:Math.max(1.1,volume-.1),
      trade_rvol_1m:trades,trade_rvol_5m:Math.max(1.05,trades-.1),taker_buy_ratio:.56
    };
    return item;
  };
  const top=mkUnderfloor('BURSTAUSDT',72,1.65,1.45);
  const second=mkUnderfloor('BURSTBUSDT',68,1.45,1.3);
  const others=[
    candidate('HIGH1USDT',2,{score:95}),
    candidate('HIGH2USDT',3,{score:91}),
    candidate('HIGH3USDT',1,{score:87}),
    candidate('HIGH4USDT',4,{score:84})
  ];
  const selected=radar.selectDeepFromMicro([top,second,...others],31);
  assert.equal(selected.length,4,'Deep capacity is fixed; this must not create extra candle requests');
  const underfloor=selected.filter(x=>x.row?._low_liquidity_burst_bypass===true);
  assert.equal(underfloor.length,1,'no more than one under-floor burst consumes a Deep slot per cycle');
  assert.equal(underfloor[0].row.symbol,'BURSTAUSDT','pick the strongest qualified closed-candle evidence');
  assert.equal(underfloor[0]._selection_lane,'exceptional');
  assert.equal(isEarlyExpansionCandidateAlertEligible({
    early_expansion_score:99,decision_band:'PRE_EXPANSION',data_quality:100,data_stale:false,
    risk_flags:[],micro_fingerprint:{eligible:true},low_liquidity_burst_bypass:true
  },{minAlertScore:82,minDataQuality:70}),false,'Deep watch priority must never bypass the public alert gate');
});

test('Radar 8 under-floor burst can never satisfy the public buy-alert eligibility gate',()=>{
  const qualified={
    early_expansion_score:95,decision_band:'PRE_EXPANSION',data_quality:100,data_stale:false,
    risk_flags:[],micro_fingerprint:{eligible:true}
  };
  assert.equal(isEarlyExpansionCandidateAlertEligible(qualified,{minAlertScore:82,minDataQuality:70}),true);
  assert.equal(isEarlyExpansionCandidateAlertEligible({
    ...qualified,low_liquidity_burst_bypass:true
  },{minAlertScore:82,minDataQuality:70}),false,
  'even a fully qualified downstream fingerprint remains watch-only when it came through the under-floor lane');
  assert.equal(isEarlyExpansionCandidateAlertEligible({
    ...qualified,risk_flags:['WIDE_SPREAD']
  },{minAlertScore:82,minDataQuality:70}),false);
});
