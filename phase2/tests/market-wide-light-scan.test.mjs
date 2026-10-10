import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {SCAN_JOURNEY_SCHEMA} from '../core/scan-journey-ledger.mjs';
import {MarketWideLightScan, evaluateMarketWideLightCandidate} from '../core/market-wide-light-scan.mjs';
import {MarketWideKlineCache} from '../market/market-wide-kline-cache.mjs';
import {BinanceStreamClient} from '../market/binance-ws.mjs';
import {RestClient} from '../market/binance-rest.mjs';

const STEP = 5 * 60_000;
const SOURCE = 'BINANCE_PUBLIC_REST';

function candles({now = 1_900_000_000_000, count = 72, source = SOURCE, includeActivity = true} = {}) {
  const aligned = Math.floor(now / STEP) * STEP - STEP;
  const firstOpen = aligned - (count - 1) * STEP;
  return Array.from({length: count}, (_, index) => {
    const openTime = firstOpen + index * STEP;
    const recent = index >= count - 24;
    const wobble = recent ? (index % 3 - 1) * 0.025 : (index % 5 - 2) * 0.32;
    const close = 100 + wobble;
    const supportRise = index >= count - 6 ? 0.08 : index >= count - 12 ? 0.04 : 0;
    const open = close - 0.015;
    const high = Math.max(close + (recent ? 0.08 : 0.55), open, close);
    const low = Math.min(
      99.55 + supportRise + (recent ? (index % 2) * 0.015 : (index % 4) * 0.12),
      open - 0.025, close - 0.025
    );
    return {
      symbol: 'TESTUSDT', openTime, closeTime: openTime + STEP - 1,
      open, high, low,
      close, volume: includeActivity ? (recent ? 150 + index : 1000 + (index % 4) * 250) : null,
      tradeCount: includeActivity ? (recent ? 18 + index % 6 : 100 + (index % 5) * 25) : null,
      closed: true, source, receivedAt: now - 1000
    };
  });
}

function row(i) {
  return {symbol:'LIGHT'+String(i).padStart(3,'0')+'USDT',lastPrice:1,quoteVolume24h:1_000_000,tradeCount24h:1000};
}

function cacheSeries(symbol, now, opts = {}) {
  const rows = candles({now, ...opts}).map(candle => ({...candle, symbol}));
  return {symbol, candles:rows, source:opts.source || SOURCE, receivedAt:now, latestCloseTime:rows.at(-1)?.closeTime};
}

test('market-wide light scan covers all eligible symbols once and keeps candidate pool bounded and unique', () => {
  const now = 1_900_000_000_000;
  const eligible = Array.from({length:330},(_,i)=>row(i));
  eligible.push({...row(3)});
  const seriesReads = new Map();
  const light = new MarketWideLightScan({config:{candidateLimit:48,rotationReserve:12,minimumReadyCandidates:24},clock:()=>now});
  const result = light.scan({
    eligible,now,cycle:1,
    getSeries:symbol=>{
      seriesReads.set(symbol,(seriesReads.get(symbol)||0)+1);
      const index=Number(symbol.match(/(\d+)USDT$/)?.[1]||0);
      return index<40?cacheSeries(symbol,now):null;
    }
  });
  assert.equal(result.eligibleTotal,330);
  assert.equal(result.summary.duplicate_symbol_total,1);
  assert.equal(result.audit.size,330);
  assert.equal(seriesReads.size,330);
  assert.ok([...seriesReads.values()].every(count=>count===1),'each eligible symbol is read from cache exactly once');
  assert.equal(result.candidateRows.length,48);
  assert.equal(new Set(result.candidateRows.map(x=>x.symbol)).size,48);
  assert.equal(result.summary.evaluated_total,40);
  assert.equal(result.summary.not_evaluated_total,290);
  assert.ok([...result.audit.values()].every(item=>Number.isInteger(item.light_rank)),'every eligible symbol needs an explicit light or rotation rank');
  assert.ok([...result.audit.values()].filter(item=>!item.evaluated).every(item=>item.rank_basis==='FAIR_ROTATION_NO_VALID_LIGHT_DATA'));
  assert.equal(result.summary.binance_rest_calls_added_by_light_scan,0);
  assert.equal(result.coverageReady,false,'partial cache coverage must not activate the filter');
  assert.equal(result.summary.selection_mode,'BOOTSTRAP_FULL_UNIVERSE');
  const fullyWarmed = light.scan({
    eligible,now:now+1000,cycle:2,
    getSeries:symbol=>cacheSeries(symbol,now+1000),
    lastMicroScannedAt:()=>null
  });
  assert.equal(fullyWarmed.summary.evaluated_total,330);
  assert.equal(fullyWarmed.coverageReady,true,'only complete fresh-candle coverage can activate ranking');
});

test('future candles are excluded and the returned evaluation never uses a close after as-of', () => {
  const now = 1_900_000_000_000;
  const input = candles({now,count:72});
  input.push({...input.at(-1),openTime:input.at(-1).openTime+STEP,closeTime:input.at(-1).closeTime+STEP,closed:true});
  const result = evaluateMarketWideLightCandidate({
    symbol:'FUTUREUSDT',series:{symbol:'FUTUREUSDT',candles:input,source:SOURCE},now
  });
  assert.equal(result.evaluated,true);
  assert.equal(result.closed_candles_only,true);
  assert.equal(result.future_candles_excluded,1);
  assert.ok(result.latest_candle_close_time_ms<=now);
  assert.equal(result.metrics.last_candle_close_time_ms>now,false);
});

test('stale 5m cache is rejected instead of being presented as current coverage', () => {
  const now = 1_900_000_000_000;
  const old = candles({now:now-12*60_000,count:72});
  const result = evaluateMarketWideLightCandidate({
    symbol:'STALEUSDT',series:{symbol:'STALEUSDT',candles:old,source:SOURCE},now
  });
  assert.equal(result.evaluated,false);
  assert.equal(result.scanned,false);
  assert.equal(result.reason,'STALE_CLOSED_5M_CACHE');
  assert.ok(result.data_age_ms>8*60_000);
});

test('missing volume and trade count remain unavailable and are not invented', () => {
  const now = 1_900_000_000_000;
  const bars = candles({now,count:72,includeActivity:false});
  const result = evaluateMarketWideLightCandidate({
    symbol:'NOMETRICSUSDT',series:{symbol:'NOMETRICSUSDT',candles:bars,source:SOURCE},now
  });
  assert.equal(result.evaluated,true);
  assert.equal(result.metrics.volume_participation.available,false);
  assert.equal(result.metrics.trade_count_participation.available,false);
  assert.equal(result.metrics.volume_participation.recentRatio,null);
  assert.equal(result.metrics.trade_count_participation.recentRatio,null);
  assert.equal(result.metrics.optional_participation_available,false);
});

test('invalid candles and sequence gaps are rejected, not compressed across', () => {
  const now = 1_900_000_000_000;
  const broken = candles({now,count:72});
  broken[40] = {...broken[40], high:broken[40].low - 1};
  const bad = evaluateMarketWideLightCandidate({
    symbol:'BADBARUSDT',series:{symbol:'BADBARUSDT',candles:broken,source:SOURCE},now
  });
  assert.equal(bad.evaluated,false);
  assert.equal(bad.reason,'INVALID_CLOSED_CANDLE');
  const gapBars = candles({now,count:72});
  gapBars.splice(35,1);
  const gap = evaluateMarketWideLightCandidate({
    symbol:'GAPBARUSDT',series:{symbol:'GAPBARUSDT',candles:gapBars,source:SOURCE},now
  });
  assert.equal(gap.evaluated,false);
  assert.equal(gap.reason,'CLOSED_CANDLE_SEQUENCE_HAS_GAPS');
});

test('exceptional candidates remain in the light pool and cold symbols get fair rotation', () => {
  const now = 1_900_000_000_000;
  const eligible = Array.from({length:30},(_,i)=>row(i));
  const light = new MarketWideLightScan({config:{candidateLimit:10,rotationReserve:4,minimumReadyCandidates:6},clock:()=>now});
  const first = light.scan({
    eligible,now,cycle:1,getSeries:()=>null,
    isExceptional:item=>item.symbol==='LIGHT029USDT',
    lastMicroScannedAt:()=>null
  });
  assert.ok(first.candidateSymbols.includes('LIGHT029USDT'));
  assert.equal(first.audit.get('LIGHT029USDT').candidate_selection_reason,'EXCEPTIONAL_PRESERVED');
  assert.equal(first.candidateRows.length,10);
  const second = light.scan({
    eligible,now:now+1000,cycle:2,getSeries:()=>null,
    isExceptional:()=>false,lastMicroScannedAt:()=>null
  });
  assert.equal(new Set(second.candidateSymbols).size,10);
  assert.ok(second.candidateSymbols.some(symbol=>!first.candidateSymbols.includes(symbol)),
    'symbols not included in the last candidate pool must rotate in');
  assert.equal(first.summary.binance_rest_calls_added_by_light_scan,0);
});

test('the scan journey archive preserves per-symbol light-scan provenance after store reload', async () => {
  const dir = await mkdtemp(join(tmpdir(),'radarx-market-wide-light-archive-'));
  try {
    const now = 1_900_000_000_000;
    const store = await new DurableStore({dir}).init();
    const lightAudit = {
      symbol:'ARCHIVEUSDT',layer_visited:true,evaluated:true,scanned:true,scanned_at:now,
      source:'BINANCE_PUBLIC_WS',data_age_ms:1200,result:'LIGHT_CANDIDATE',light_rank:2,rank_basis:'LIGHT_EVIDENCE',
      reason:'LIGHT_FEATURES_RANK_ONLY',rejection_reason:null,candidate_rank:2,
      candidate_selected:true,candidate_selection_reason:'LIGHT_SCORE_CANDIDATE',
      closed_candles_only:true,metrics:{base_range_pct:0.8,atr_ratio:0.7,volume_participation:{available:false,recentRatio:null}}
    };
    await store.appendScanJourneyCycle({
      schema_version:SCAN_JOURNEY_SCHEMA,cycle_id:'RADAR8:USDT:MWLIGHT:1',
      cycle_number:1,radar:'RADAR_8',quote:'USDT',status:'COMPLETE',
      started_at:now,completed_at:now+300,counters:{market_wide_light_scan:{eligible_total:330,evaluated_total:210,micro_candidate_pool_total:48,binance_rest_calls_added_by_light_scan:0}},
      data_policy:{closed_candles_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'},
      coins:[{symbol:'ARCHIVEUSDT',eligible:true,market_wide_light_scan:lightAudit}]
    });
    const restored = await new DurableStore({dir}).init();
    const cycles = await restored.readScanJourneyCycles({limit:1});
    assert.equal(cycles.length,1);
    assert.equal(cycles[0].counters.market_wide_light_scan.evaluated_total,210);
    assert.equal(cycles[0].coins[0].market_wide_light_scan.source,'BINANCE_PUBLIC_WS');
    assert.equal(cycles[0].coins[0].market_wide_light_scan.candidate_rank,2);
    assert.equal(cycles[0].coins[0].market_wide_light_scan.data_age_ms,1200);
    assert.equal(cycles[0].coins[0].market_wide_light_scan.light_rank,2);
    assert.equal(cycles[0].coins[0].market_wide_light_scan.rank_basis,'LIGHT_EVIDENCE');
    assert.equal(cycles[0].coins[0].market_wide_light_scan.metrics.volume_participation.available,false);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});

test('kline responses from another shared REST client seed the cache without another request', async () => {
  const now = Date.now();
  const step = 5 * 60_000;
  const boundary = Math.floor(now / step) * step;
  const raw = Array.from({length:72},(_,index)=>{
    const openTime = boundary - (72-index)*step;
    const closeTime = openTime + step - 1;
    return [openTime,'100','100.5','99.5','100','10',closeTime,'1000',100,'6','600','0'];
  });
  let actualFetchAttempts = 0;
  const cacheRest = new RestClient({
    baseUrls:['https://cache-client.test.invalid'],
    timeoutMs:1000,minIntervalMs:0,maxRequestsPerMinute:240,
    fetchImpl:async()=>{throw new Error('cache subscription must not create REST calls');}
  });
  const requestRest = new RestClient({
    baseUrls:['https://rest.test.invalid'],
    timeoutMs:1000,minIntervalMs:0,maxRequestsPerMinute:240,
    fetchImpl:async()=>{
      actualFetchAttempts++;
      return {ok:true,status:200,headers:{get:()=>null},json:async()=>raw};
    }
  });
  const cache = new MarketWideKlineCache({
    rest:cacheRest,urls:['wss://stream.test/stream'],WebSocketImpl:FakeSocket,
    clock:()=>Date.now(),logger:{warn(){}}
  });
  cache.setSymbols(['AAAUSDT']);
  const response = await requestRest.klines('AAAUSDT','5m',{limit:72});
  assert.equal(actualFetchAttempts,1,'the existing Micro/radar request remains the only outbound HTTP attempt');
  assert.equal(response.candles.filter(candle=>candle.closed).length,72);
  const series = cache.getSeries('AAAUSDT');
  assert.equal(series.candles.length,72,'all valid closed bars from the shared REST response should seed the cache');
  assert.ok(series.candles.every(candle=>candle.source==='BINANCE_PUBLIC_REST'));
  assert.ok(series.candles.every(candle=>candle.closeTime<=Date.now()));
  cache.stop();
});

class FakeSocket {
  static instances = [];
  constructor(url) {this.url=url;this.handlers={};FakeSocket.instances.push(this);}
  on(name,fn) {this.handlers[name]=fn;}
  emit(name,...args) {this.handlers[name]?.(...args);}
  close() {this.closed=true;}
  terminate() {this.terminated=true;this.emit('close');}
  pong() {}
}

test('market-wide websocket cache bounds/deduplicates streams and keeps only closed candles', () => {
  FakeSocket.instances.length=0;
  const now = 1_900_000_000_000;
  const cache = new MarketWideKlineCache({
    urls:['wss://stream.test/stream'],WebSocketImpl:FakeSocket,
    clock:()=>now,logger:{warn(){}}
  });
  assert.equal(cache.setSymbols(['AAAUSDT','BBBUSDT','AAAUSDT']),true);
  assert.deepEqual(cache.symbols,['AAAUSDT','BBBUSDT']);
  cache.start();
  assert.equal(FakeSocket.instances.length,1);
  assert.match(FakeSocket.instances[0].url,/aaausdt%40kline_5m/);
  const input = candles({now,count:3});
  input.forEach((candle,i)=>{
    cache.seed('AAAUSDT',[{...candle,symbol:'AAAUSDT',closed:true}],SOURCE);
  });
  cache.seed('AAAUSDT',[{...input.at(-1),openTime:input.at(-1).openTime+STEP,closeTime:input.at(-1).closeTime+STEP,closed:true}],SOURCE);
  const series = cache.getSeries('AAAUSDT');
  assert.equal(series.candles.length,3,'future bars must not be cached');
  assert.ok(series.candles.every(c=>c.closed===true&&c.closeTime<=now));
  assert.equal(cache.setSymbols(['BBBUSDT','AAAUSDT']),false,'identical normalized universe must not reconnect');
  cache.stop();
  assert.equal(cache.health().state,'STOPPED');
});


test('cache readiness requires all expected symbols to have fresh continuous closed 5m bars', () => {
  let now = 1_900_000_000_000;
  FakeSocket.instances.length = 0;
  const cache = new MarketWideKlineCache({
    urls:['wss://stream.binance.com:9443/stream','wss://stream.binance.com:443/stream'],
    WebSocketImpl:FakeSocket,clock:()=>now,logger:{warn(){}}
  });
  assert.equal(cache.urls[0],'wss://data-stream.binance.vision/stream',
    'the market-data-only WebSocket must be attempted first');
  cache.setSymbols(['AAAUSDT','BBBUSDT']);
  cache.start();
  assert.match(FakeSocket.instances[0].url,/data-stream\.binance\.vision\/stream/);
  cache.seed('AAAUSDT',candles({now,count:72}).map(candle=>({...candle,symbol:'AAAUSDT'})),'BINANCE_PUBLIC_REST');
  let status = cache.health();
  assert.equal(status.expected_symbols,2);
  assert.equal(status.ready_symbols,1);
  assert.equal(status.missing_symbols,1);
  assert.equal(status.cache_coverage_ready,false);
  now += 9 * 60_000;
  status = cache.health();
  assert.equal(status.stale_symbols,1);
  assert.equal(status.missing_symbols,1);
  assert.equal(status.cache_coverage_ready,false);
  cache.stop();
});

test('coverage gate stays closed for one missing symbol, opens only when all are ready, and closes on staleness', () => {
  let now = 1_900_000_000_000;
  const cache = new MarketWideKlineCache({
    urls:['wss://stream.test/stream'], WebSocketImpl:FakeSocket,
    clock:()=>now, logger:{warn(){}}
  });
  cache.setSymbols(['AAAUSDT','BBBUSDT','CCCUSDT']);
  cache.start();

  let proof = cache.coverageReport();
  assert.equal(proof.expected_symbols,3);
  assert.equal(proof.ready_symbols,0);
  assert.equal(proof.not_ready_symbols,3);
  assert.equal(proof.cache_coverage_ready,false);
  assert.equal(proof.full_market_coverage_ready,false);

  cache.seed('AAAUSDT',candles({now,count:72}).map(candle=>({...candle,symbol:'AAAUSDT'})),'BINANCE_PUBLIC_REST');
  cache.seed('BBBUSDT',candles({now,count:72}).map(candle=>({...candle,symbol:'BBBUSDT'})),'BINANCE_PUBLIC_REST');
  proof = cache.coverageReport();
  assert.equal(proof.ready_symbols,2);
  assert.equal(proof.not_ready_symbols,1);
  assert.equal(proof.symbols.find(item=>item.symbol==='CCCUSDT').state,'CANDLE_CACHE_MISSING');
  assert.equal(proof.cache_coverage_ready,false,'one missing eligible symbol must keep the gate closed');

  cache.seed('CCCUSDT',candles({now,count:72}).map(candle=>({...candle,symbol:'CCCUSDT'})),'BINANCE_PUBLIC_REST');
  proof = cache.coverageReport();
  assert.equal(proof.ready_symbols,3);
  assert.equal(proof.not_ready_symbols,0);
  assert.equal(proof.cache_coverage_ready,true,'historical REST backfill covers every eligible symbol');
  assert.equal(proof.full_market_coverage_ready,false,'REST history alone must not open the complete gate');
  assert.equal(proof.websocket_sync_ready,false);
  assert.ok(proof.symbols.every(item=>item.closed_candle_count>=60));
  assert.ok(proof.symbols.every(item=>item.continuity_gap_count===0));
  assert.ok(proof.symbols.every(item=>item.latest_candle_age_ms<=8*60_000));
  assert.ok(proof.symbols.every(item=>item.future_candle_count===0));

  now += STEP;
  const nextClosed = candles({now,count:1})[0];
  const socket = FakeSocket.instances.at(-1);
  for (const symbol of ['AAAUSDT','BBBUSDT','CCCUSDT']) {
    socket.emit('message',Buffer.from(JSON.stringify({
      e:'kline',E:now,s:symbol,k:{
        s:symbol,i:'5m',t:nextClosed.openTime,T:nextClosed.closeTime,
        o:String(nextClosed.open),h:String(nextClosed.high),l:String(nextClosed.low),c:String(nextClosed.close),
        v:String(nextClosed.volume??100),q:String(nextClosed.quoteVolume??1000),n:Number(nextClosed.tradeCount??10),
        V:String(nextClosed.takerBuyBaseVolume??50),Q:String(nextClosed.takerBuyQuoteVolume??500),x:true
      }
    })));
  }
  proof = cache.coverageReport();
  assert.equal(proof.websocket_advanced_symbols,3);
  assert.equal(proof.websocket_sync_ready,true);
  assert.equal(proof.full_market_coverage_ready,true,'only REST backfill plus a newer closed WebSocket candle opens the full gate');

  now += 9 * 60_000;
  proof = cache.coverageReport();
  assert.equal(proof.ready_symbols,0);
  assert.equal(proof.stale_symbols,3);
  assert.equal(proof.cache_coverage_ready,false,'historical coverage must close when the data becomes stale');
  assert.equal(proof.full_market_coverage_ready,false,'the full gate must stay closed when history becomes stale');
  cache.stop();
});

test('same closed-candle payload is deduplicated instead of being counted as fresh data', () => {
  const now = 1_900_000_000_000;
  const cache = new MarketWideKlineCache({urls:['wss://fake.test/stream'],WebSocketImpl:FakeSocket,
    clock:()=>now,logger:{warn(){}}});
  cache.setSymbols(['AAAUSDT']);
  const candle = {...candles({now,count:1})[0],symbol:'AAAUSDT',source:'BINANCE_PUBLIC_WS'};
  assert.equal(cache.putCandle(candle),true);
  assert.equal(cache.putCandle({...candle,receivedAt:now+100}),false);
  assert.equal(cache.getSeries('AAAUSDT').candles.length,1);
});

test('repeated scans reuse a still-fresh closed 5m evaluation until a new candle arrives', () => {
  const now = 1_900_000_000_000;
  const light = new MarketWideLightScan({config:{minClosedCandles:60},clock:()=>now});
  const eligible = [row(0)];
  const first = light.scan({eligible,now,cycle:1,getSeries:symbol=>cacheSeries(symbol,now)});
  const firstAudit = first.audit.get(eligible[0].symbol);
  assert.equal(firstAudit.new_closed_candle,true);
  assert.equal(firstAudit.evaluation_reused,false);
  const second = light.scan({eligible,now:now+1000,cycle:2,getSeries:symbol=>cacheSeries(symbol,now+1000)});
  const secondAudit = second.audit.get(eligible[0].symbol);
  assert.equal(secondAudit.new_closed_candle,false);
  assert.equal(secondAudit.evaluation_reused,true);
  assert.equal(secondAudit.evaluation_kind,'REUSED_CLOSED_CANDLE');
  assert.equal(secondAudit.evaluated_at,firstAudit.evaluated_at);
  assert.equal(second.summary.reused_evaluation_total,1);
  assert.equal(second.summary.new_closed_candle_total,0);
});

test('cache time regressions are rejected and never promoted as a new closed candle', () => {
  const now = 1_900_000_000_000;
  const light = new MarketWideLightScan({config:{minClosedCandles:60},clock:()=>now});
  const eligible = [row(0)];
  const first = light.scan({eligible,now,cycle:1,getSeries:symbol=>cacheSeries(symbol,now)});
  assert.equal(first.audit.get(eligible[0].symbol).new_closed_candle,true);
  const regressedSeries = cacheSeries(eligible[0].symbol,now).candles.slice(0,-1);
  const regressed = light.scan({
    eligible,now:now+1000,cycle:2,
    getSeries:symbol=>({symbol,candles:regressedSeries,source:SOURCE})
  });
  const audit = regressed.audit.get(eligible[0].symbol);
  assert.equal(audit.reason,'CACHE_TIME_REGRESSION');
  assert.equal(audit.cache_state,'STALE_DATA');
  assert.equal(audit.evaluated,false);
  assert.equal(audit.new_closed_candle,false);
  assert.equal(regressed.coverageReady,false);
});

test('WebSocket reconnect retries stop after the configured bound on HTTP 451', async () => {
  FakeSocket.instances.length = 0;
  const states = [];
  const client = new BinanceStreamClient({
    urls:['wss://data-stream.binance.vision/stream'],
    streams:['aaausdt@kline_5m'],
    WebSocketImpl:FakeSocket,
    initialBackoffMs:1,maxBackoffMs:1,jitterRatio:0,maxReconnectAttempts:2,
    onState:(state,reason)=>states.push({state,reason})
  });
  client.start();
  for (let attempt=0; attempt<3; attempt++) {
    const socket = FakeSocket.instances.at(-1);
    socket.emit('unexpected-response',{}, {statusCode:451,resume(){}});
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  const health = client.health();
  assert.equal(health.state,'DEGRADED');
  assert.equal(health.reconnect_attempts,2);
  assert.equal(health.consecutive_reconnect_attempts,2);
  assert.equal(FakeSocket.instances.length,3,'initial connection plus exactly two bounded retries');
  assert.ok(states.some(item=>String(item.reason||'').includes('WS_HTTP_451')));
  assert.ok(states.some(item=>String(item.reason||'').includes('WS_RECONNECT_LIMIT_REACHED')));
  client.stop();
});
