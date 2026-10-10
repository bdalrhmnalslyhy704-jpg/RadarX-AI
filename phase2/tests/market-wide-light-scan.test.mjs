import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {SCAN_JOURNEY_SCHEMA} from '../core/scan-journey-ledger.mjs';
import {MarketWideLightScan, evaluateMarketWideLightCandidate} from '../core/market-wide-light-scan.mjs';
import {MarketWideKlineCache} from '../market/market-wide-kline-cache.mjs';

const STEP = 5 * 60_000;
const SOURCE = 'BINANCE_PUBLIC_REST';

function candles({now = 1_900_000_000_000, count = 72, source = SOURCE, includeActivity = true} = {}) {
  const aligned = Math.floor(now / STEP) * STEP - 1;
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
      symbol:'ARCHIVEUSDT',evaluated:true,scanned:true,scanned_at:now,
      source:'BINANCE_PUBLIC_WS',data_age_ms:1200,result:'LIGHT_CANDIDATE',
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
    assert.equal(cycles[0].coins[0].market_wide_light_scan.metrics.volume_participation.available,false);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
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
