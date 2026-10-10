import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {RestClient} from '../market/binance-rest.mjs';
import {MarketWideKlineCache} from '../market/market-wide-kline-cache.mjs';
import {DurableStore} from '../core/store.mjs';
import {EarlyExpansionRadar} from '../core/early-expansion-radar.mjs';
import {CONFIG} from '../config.mjs';

const MIN_QUOTE_VOLUME_24H = Number(process.env.RADARX_MARKET_WIDE_MIN_QUOTE_VOLUME_24H || 750000);
const MAX_WARMUP_MINUTES = Math.min(120, Math.max(1,
  Math.trunc(Number(process.env.RADARX_MARKET_WIDE_WARMUP_MAX_MINUTES || 90))));
const REPORT_PATH = resolve(process.env.RADARX_MARKET_WIDE_WARMUP_REPORT ||
  'artifacts/market-wide-cache-warmup.json');
const DATA_API = 'https://data-api.binance.vision';
const WS_URLS = [
  'wss://data-stream.binance.vision/stream',
  'wss://stream.binance.com:9443/stream',
  'wss://stream.binance.com:443/stream'
];
const CYCLE_DELAY_MS = Math.min(45000, Math.max(1000,
  Math.trunc(Number(process.env.RADARX_MARKET_WIDE_WARMUP_CYCLE_DELAY_MS || 1000))));
const configuredShadowCycles = Number(process.env.RADARX_MARKET_WIDE_SHADOW_CYCLES || 30);
const SHADOW_CYCLES = Number.isFinite(configuredShadowCycles)
  ? Math.min(30, Math.max(25, Math.trunc(configuredShadowCycles))) : 30;
const configuredShadowMinutes = Number(process.env.RADARX_MARKET_WIDE_SHADOW_MAX_MINUTES || 25);
const MAX_SHADOW_MINUTES = Number.isFinite(configuredShadowMinutes)
  ? Math.min(45, Math.max(1, Math.trunc(configuredShadowMinutes))) : 25;
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const startedAt = Date.now();
const httpAttempts = [];
const report = {
  schema_version: 2,
  started_at_ms: startedAt,
  status: 'INITIALIZING',
  acceptance_gate_open: false,
  market_wide_cache_coverage_ready: false,
  micro_pool_applied: false,
  shadow_started: false,
  shadow: {status:'NOT_STARTED',requested_cycles:SHADOW_CYCLES,max_duration_minutes:MAX_SHADOW_MINUTES,completed_cycles:0,cycles:[]},
  merged: false,
  deployed: false,
  minimum_quote_volume_24h: MIN_QUOTE_VOLUME_24H,
  max_warmup_minutes: MAX_WARMUP_MINUTES,
  cycle_delay_ms: CYCLE_DELAY_MS,
  discovery: {
    exchange_info_symbols: 0,
    valid_spot_usdt_symbols: 0,
    ticker_rows: null,
    eligible_symbols: 0
  },
  transport: {
    websocket_endpoint_preferred: WS_URLS[0],
    websocket_state: 'NOT_STARTED',
    websocket_messages: 0,
    new_closed_candles_cached: 0,
    duplicate_closed_candle_frames: 0,
    rejected_future_candles: 0,
    rejected_candles: 0,
    reconnect_attempts: 0,
    maximum_reconnect_attempts: 5,
    rest_historical_backfill_used: false,
    rest_transport_fallback_used: false,
    rest_per_symbol_extra_warmup_requests: 0
  },
  binance_http_attempts: httpAttempts,
  micro_selector: {
    mode: 'EXISTING_EARLY_EXPANSION_MICRO_SELECTOR',
    micro_pool_applied: false,
    legacy_selector_kept_active: true,
    deep_scans_disabled_for_this_isolated_warmup: true
  },
  cycles: 0,
  per_symbol: [],
  reasons: {}
};

let cache = null;
let radar = null;
let store = null;
let latestCoverage = null;
let lastProgressAt = 0;
const observedCycleArchives = [];
const observedSchedulerReports = [];
const observedScanCompletions = [];
function captureRadarLog(target, line, marker) {
  const prefix = marker + ' ';
  if (!line.startsWith(prefix)) return;
  try { target.push(JSON.parse(line.slice(prefix.length))); } catch {}
}
function radarInfoLogger(...args) {
  const line = args.map(value => {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }).join(' ');
  captureRadarLog(observedCycleArchives,line,'[RADARX_SCAN_JOURNEY_ARCHIVE]');
  captureRadarLog(observedSchedulerReports,line,'[RADARX_SCHEDULER_REPORT]');
  captureRadarLog(observedScanCompletions,line,'[RADARX_SCAN_COMPLETE]');
  console.log(...args);
}
const progressLog = (value, data) => console.log(value + ' ' + JSON.stringify(data));

async function saveReport() {
  report.finished_at_ms = Date.now();
  report.duration_ms = Math.max(0, report.finished_at_ms - startedAt);
  report.elapsed_seconds = Math.round(report.duration_ms / 1000);
  report.binance_http_attempt_total = httpAttempts.length;
  try {
    await mkdir(dirname(REPORT_PATH), {recursive: true});
    await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch (error) {
    console.error('[MARKET_WIDE_WARMUP_REPORT_WRITE_FAILED]', String(error?.message || error));
    throw error;
  }
  console.log('[MARKET_WIDE_CACHE_WARMUP_REPORT] ' + JSON.stringify({
    status: report.status,
    shadow_status: report.shadow?.status || 'NOT_STARTED',
    shadow_completed_cycles: report.shadow?.completed_cycles || 0,
    shadow_requested_cycles: report.shadow?.requested_cycles || SHADOW_CYCLES,
    shadow_abort_reason: report.shadow?.abort_reason || null,
    elapsed_seconds: report.elapsed_seconds,
    eligible_total: report.discovery.eligible_symbols,
    ready_total: report.summary?.ready_symbols ?? 0,
    not_ready_total: report.summary?.not_ready_symbols ?? report.discovery.eligible_symbols,
    missing_total: report.summary?.missing_symbols ?? report.discovery.eligible_symbols,
    stale_total: report.summary?.stale_symbols ?? 0,
    websocket_advanced_total: report.summary?.websocket_advanced_symbols ?? 0,
    cache_coverage_ready: report.market_wide_cache_coverage_ready,
    micro_pool_applied: report.micro_pool_applied,
    binance_http_attempts: report.binance_http_attempt_total,
    websocket_messages: report.transport.websocket_messages,
    reconnect_attempts: report.transport.reconnect_attempts,
    historical_rest_backfill: report.transport.rest_historical_backfill_used,
    websocket_updated_every_symbol: report.summary?.websocket_sync_ready ?? false,
    report_path: REPORT_PATH
  }));
}

const countedFetch = async (url, options = {}) => {
  const entry = {url: String(url), started_at_ms: Date.now(), status: null, error: null};
  httpAttempts.push(entry);
  try {
    const response = await fetch(url, options);
    entry.status = response.status;
    entry.finished_at_ms = Date.now();
    return response;
  } catch (error) {
    entry.error = String(error?.code || error?.message || error?.name || 'FETCH_FAILED').slice(0, 180);
    entry.finished_at_ms = Date.now();
    throw error;
  }
};

function finalizeCoverage(coverage) {
  if (!coverage) return;
  latestCoverage = coverage;
  const symbols = coverage.symbols.map(row => {
    const historyReady = row.ready === true;
    const wsAdvanced = row.websocket_advanced_beyond_backfill === true;
    const ready = historyReady && wsAdvanced;
    const reason = !historyReady ? row.state : !wsAdvanced ? 'WS_NOT_ADVANCED_AFTER_BACKFILL' : null;
    return {
      ...row,
      historical_backfill_ready: historyReady,
      websocket_updated_after_backfill: wsAdvanced,
      ready,
      state: reason || 'READY',
      readiness_reason: reason
    };
  });
  const counts = symbols.reduce((acc, row) => {
    acc[row.state] = (acc[row.state] || 0) + 1;
    return acc;
  }, {});
  const readyCount = symbols.filter(row => row.ready).length;
  report.summary = {
    eligible_symbols: symbols.length,
    ready_symbols: readyCount,
    not_ready_symbols: symbols.length - readyCount,
    missing_symbols: symbols.filter(row => row.state === 'CANDLE_CACHE_MISSING').length,
    stale_symbols: symbols.filter(row => row.state === 'STALE_DATA').length,
    incomplete_symbols: symbols.filter(row => !row.ready &&
      !['CANDLE_CACHE_MISSING','STALE_DATA','WS_NOT_ADVANCED_AFTER_BACKFILL'].includes(row.state)).length,
    websocket_not_advanced_symbols: symbols.filter(row => row.state === 'WS_NOT_ADVANCED_AFTER_BACKFILL').length,
    websocket_advanced_symbols: coverage.websocket_advanced_symbols,
    websocket_sync_ready: coverage.websocket_sync_ready,
    reason_counts: counts
  };
  report.per_symbol = symbols;
  report.reasons = counts;
  report.market_wide_cache_coverage_ready = symbols.length > 0 && readyCount === symbols.length &&
    coverage.full_market_coverage_ready === true && coverage.websocket_sync_ready === true;
  report.acceptance_gate_open = report.market_wide_cache_coverage_ready;
  // The warm-up evidence job must never activate candidate-pool selection itself.
  report.micro_pool_applied = false;
  report.micro_selector.micro_pool_applied = false;
}

try {
  if (!Number.isFinite(MIN_QUOTE_VOLUME_24H) || MIN_QUOTE_VOLUME_24H < 0) {
    throw new Error('INVALID_MIN_QUOTE_VOLUME_24H');
  }

  const rest = new RestClient({
    baseUrls: [DATA_API],
    fetchImpl: countedFetch,
    timeoutMs: 12000,
    minIntervalMs: 0,
    maxRequestsPerMinute: 240
  });
  store = await new DurableStore({dir:resolve(tmpdir(),'radarx-market-wide-cache-warmup-store')}).init();

  cache = new MarketWideKlineCache({
    rest,
    urls: WS_URLS,
    initialBackoffMs: 1000,
    maxBackoffMs: 60000,
    maxReconnectAttempts: 5,
    jitterRatio: 0.2,
    heartbeatTimeoutMs: 90000,
    maxConnectionMs: 23 * 60 * 60 * 1000,
    maxCandleAgeMs: 8 * 60_000,
    logger: {warn: (...args) => console.warn(...args)}
  });

  // Run the existing Radar 8 selector in an isolated process. Its usual Micro REST
  // responses are already observed by the shared RestClient broker and seed this cache.
  // No new per-symbol warm-up Kline loop is introduced; Deep requests are disabled here.
  radar = new EarlyExpansionRadar({
    rest, store, marketWideKlineCache:cache,
    config:{
      ...CONFIG.earlyExpansionRadar,
      quote:'USDT',
      minQuoteVolume24h:MIN_QUOTE_VOLUME_24H,
      pollMs:CYCLE_DELAY_MS,
      universeRefreshMs:5*60_000,
      microScanCandidates:12,
      microConcurrency:6,
      retryAttempts:1,
      marketWideLightScanEnabled:true,
      marketWideLightScanPoolActivationEnabled:false,
      marketWideLightScanMaxCandleAgeMs:8*60_000,
      marketWideLightScanMinClosedCandles:60
    },
    logger:{info:radarInfoLogger,warn:(...args)=>console.warn(...args)}
  });
  // Warm-up disables deeper requests to keep bootstrap bounded. After the cache gate opens,
  // restore the real selector for a representative isolated Shadow comparison.
  const liveSelectDeepFromMicro = radar.selectDeepFromMicro.bind(radar);
  radar.selectDeepFromMicro = () => [];
  radar.running = true;
  report.status = 'WARMING_UP';
  report.warmup_started_at_ms = Date.now();

  const warmupDeadline = Date.now() + MAX_WARMUP_MINUTES * 60_000;
  let warmupReady = false;
  let shadowDeadline = 0;
  let shadowAbortReason = null;
  while (true) {
    const beforeCycleAt = Date.now();
    if (!warmupReady && beforeCycleAt >= warmupDeadline) break;
    if (warmupReady && report.shadow.cycles.length >= SHADOW_CYCLES) break;
    if (warmupReady && beforeCycleAt >= shadowDeadline) {
      shadowAbortReason = 'SHADOW_MAX_DURATION_EXCEEDED';
      break;
    }

    const isShadowCycle = warmupReady;
    const cycleStartedAt = Date.now();
    const httpBefore = httpAttempts.length;
    const archiveIndexBefore = observedCycleArchives.length;
    const schedulerIndexBefore = observedSchedulerReports.length;
    const completionIndexBefore = observedScanCompletions.length;
    try {
      await radar.tick();
    } catch (error) {
      report.last_cycle_error = String(error?.message || error || 'RADAR_TICK_FAILED').slice(0, 500);
      console.warn('[MARKET_WIDE_CACHE_WARMUP_CYCLE_FAILED]', report.last_cycle_error);
    }
    report.cycles++;
    report.discovery.exchange_info_symbols = radar.universe.length;
    report.discovery.valid_spot_usdt_symbols = radar.universe.length;
    report.discovery.eligible_symbols = cache.symbols.length;
    report.legacy_micro_selector = {
      mode:'EXISTING_EARLY_EXPANSION_MICRO_SELECTOR',
      micro_pool_applied:false,
      legacy_selector_kept_active:true,
      deep_scans_disabled_for_warmup:true,
      micro_candidates_per_cycle:12
    };

    const coverage = cache.coverageReport();
    finalizeCoverage(coverage);
    const health = cache.health();
    const now = Date.now();

    if (!warmupReady && report.market_wide_cache_coverage_ready === true &&
        health.running === true && health.transport_state === 'LIVE') {
      warmupReady = true;
      shadowDeadline = now + MAX_SHADOW_MINUTES * 60_000;
      report.status = 'SHADOW_RUNNING';
      report.warmup_completed_at_ms = now;
      report.shadow_started = true;
      radar.selectDeepFromMicro = liveSelectDeepFromMicro;
      report.shadow = {
        status:'RUNNING',
        requested_cycles:SHADOW_CYCLES,
        max_duration_minutes:MAX_SHADOW_MINUTES,
        started_at_ms:now,
        gate_ready_cycle:report.cycles,
        completed_cycles:0,
        micro_pool_applied:false,
        pool_activation_enabled:false,
        legacy_micro_selector_active:true,
        deep_scans_enabled:true,
        isolated_process:true,
        baseline:{
          eligible_symbols:coverage.expected_symbols,
          cache_ready_symbols:coverage.ready_symbols,
          websocket_advanced_symbols:coverage.websocket_advanced_symbols,
          websocket_transport_state:health.transport_state,
          actual_http_attempt_total:httpAttempts.length,
          actual_5m_kline_http_attempts:httpAttempts.filter(item=>item.url.includes('/api/v3/klines')&&item.url.includes('interval=5m')).length,
          micro_scanned_total:Number(radar.lastCoverage?.micro_scanned_total)||0,
          scan_duration_ms:Number(radar.lastCoverage?.scan_duration_ms)||0
        },
        cycles:[]
      };
      progressLog('[MARKET_WIDE_CACHE_SHADOW_STARTED]',{
        gate_ready:true,cycle:report.cycles,eligible_symbols:coverage.expected_symbols,
        ready_symbols:coverage.ready_symbols,websocket_advanced_symbols:coverage.websocket_advanced_symbols,
        requested_shadow_cycles:SHADOW_CYCLES,maximum_shadow_minutes:MAX_SHADOW_MINUTES,
        micro_pool_applied:false,legacy_micro_selector_active:true,deep_scans_enabled:true
      });
    } else if (isShadowCycle) {
      const archive = observedCycleArchives.length > archiveIndexBefore
        ? observedCycleArchives.at(-1) : null;
      const scheduler = observedSchedulerReports.length > schedulerIndexBefore
        ? observedSchedulerReports.at(-1) : null;
      const completion = observedScanCompletions.length > completionIndexBefore
        ? observedScanCompletions.at(-1) : null;
      if (!archive || archive.status !== 'COMPLETE' || !archive.counters) {
        shadowAbortReason = 'SHADOW_CYCLE_ARCHIVE_MISSING_OR_FAILED';
        progressLog('[MARKET_WIDE_CACHE_SHADOW_CYCLE_FAILED]',{
          shadow_cycle:report.shadow.cycles.length+1,radar_cycle:report.cycles,
          archive_status:archive?.status||'MISSING',last_error:radar.lastError||null
        });
        break;
      }
      const counters = archive.counters;
      const light = counters.market_wide_light_scan || {};
      const currentDuration = Number(completion?.scan_duration_ms ?? radar.lastCoverage?.scan_duration_ms);
      const cycleRow = {
        shadow_cycle:report.shadow.cycles.length+1,
        radar_cycle:report.cycles,
        cycle_id:archive.cycle_id||null,
        observed_at:new Date(now).toISOString(),
        scan_duration_ms:Number.isFinite(currentDuration)?currentDuration:null,
        eligible_total:Number(counters.eligible_total)||0,
        expected_ticker_total:Number(counters.expected_total)||0,
        received_ticker_total:Number(counters.received_total)||0,
        missing_ticker_total:Number(counters.missing_ticker_total)||0,
        light_evaluated_total:Number(light.evaluated_total)||0,
        light_not_evaluated_total:Number(light.not_evaluated_total)||0,
        fresh_cache_coverage_ratio:Number(light.fresh_cache_coverage_ratio)||0,
        light_candidate_total:Number(light.light_candidate_total)||0,
        micro_candidate_pool_total:Number(light.micro_candidate_pool_total)||0,
        candidate_to_micro_total:Number(light.candidate_to_micro_total)||0,
        candidate_to_deep_total:Number(light.candidate_to_deep_total)||0,
        micro_selected_total:Number(counters.micro_selected_total)||0,
        micro_attempted_total:Number(counters.micro_attempted_total)||0,
        micro_success_total:Number(counters.micro_success_total)||0,
        deep_selected_total:Number(counters.deep_selected_total)||0,
        deep_attempted_total:Number(counters.deep_attempted_total)||0,
        deep_completed_total:Number(counters.deep_completed_total)||0,
        deep_failed_total:Number(counters.deep_failed_total)||0,
        micro_pre_expansion_total:Number(light.micro_pre_expansion_total)||0,
        deep_pre_expansion_total:Number(light.deep_pre_expansion_total)||0,
        cache_coverage_ready:light.cache_coverage_ready===true,
        market_wide_cache_coverage_ready:light.market_wide_cache_coverage_ready===true,
        websocket_advanced_symbols:Number(light.websocket_advanced_symbols)||0,
        websocket_transport_state:health.transport_state,
        websocket_running:health.running===true,
        actual_binance_http_attempts:Math.max(0,httpAttempts.length-httpBefore),
        actual_5m_kline_http_attempts:httpAttempts.slice(httpBefore).filter(item=>item.url.includes('/api/v3/klines')&&item.url.includes('interval=5m')).length,
        binance_rest_calls_added_by_light_scan:Number(light.binance_rest_calls_added_by_light_scan)||0,
        micro_symbols:Array.isArray(scheduler?.micro_symbols)?scheduler.micro_symbols:[],
        deep_symbols:Array.isArray(scheduler?.deep_symbols)?scheduler.deep_symbols:[]
      };
      report.shadow.cycles.push(cycleRow);
      report.shadow.completed_cycles = report.shadow.cycles.length;
      if (cycleRow.market_wide_cache_coverage_ready !== true || cycleRow.websocket_transport_state !== 'LIVE' || cycleRow.websocket_running !== true) {
        shadowAbortReason = cycleRow.market_wide_cache_coverage_ready !== true
          ? 'CACHE_GATE_CLOSED_DURING_SHADOW' : 'WEBSOCKET_NOT_LIVE_DURING_SHADOW';
        progressLog('[MARKET_WIDE_CACHE_SHADOW_ABORTED]',{
          shadow_cycle:cycleRow.shadow_cycle,reason:shadowAbortReason,
          ready_symbols:coverage.ready_symbols,expected_symbols:coverage.expected_symbols,
          websocket_state:health.transport_state,websocket_running:health.running
        });
        break;
      }
      if (report.shadow.cycles.length === SHADOW_CYCLES) {
        report.shadow.status = 'COMPLETE';
        report.shadow.finished_at_ms = now;
        report.shadow.duration_ms = Math.max(0,now-report.shadow.started_at_ms);
        progressLog('[MARKET_WIDE_CACHE_SHADOW_COMPLETE]',{
          requested_cycles:SHADOW_CYCLES,completed_cycles:report.shadow.cycles.length,
          duration_ms:report.shadow.duration_ms,coverage_ready_every_cycle:true,
          websocket_live_every_cycle:true,micro_pool_applied:false,
          light_scan_added_rest_calls:report.shadow.cycles.reduce((sum,row)=>sum+row.binance_rest_calls_added_by_light_scan,0)
        });
      }
    }

    if (!warmupReady && health.state === 'DEGRADED' && !health.running) {
      report.status = 'WEBSOCKET_DEGRADED';
      break;
    }
    if (now - lastProgressAt >= 60000) {
      lastProgressAt = now;
      progressLog(warmupReady ? '[MARKET_WIDE_CACHE_SHADOW_PROGRESS]' : '[MARKET_WIDE_CACHE_WARMUP_PROGRESS]', {
        elapsed_seconds:Math.round((now-startedAt)/1000),
        cycle:report.cycles,
        websocket_state:health.state,
        expected_symbols:coverage.expected_symbols,
        historical_ready_symbols:coverage.ready_symbols,
        websocket_advanced_symbols:coverage.websocket_advanced_symbols,
        fully_ready_symbols:report.summary.ready_symbols,
        not_ready_symbols:report.summary.not_ready_symbols,
        reason_counts:report.summary.reason_counts,
        websocket_messages:health.received_messages,
        new_closed_candles_cached:health.received_closed_candles,
        duplicate_closed_candle_frames:health.duplicate_closed_candle_frames,
        ignored_open_candle_frames:health.ignored_open_candle_frames,
        rejected_future_candles:health.rejected_future_candles,
        rejected_candles:health.rejected_candles,
        reconnect_attempts:health.reconnect_attempts,
        actual_http_attempts:httpAttempts.length,
        existing_micro_5m_rest_attempts:httpAttempts.filter(item=>item.url.includes('/api/v3/klines')&&item.url.includes('interval=5m')).length,
        legacy_micro_selector_active:true,
        micro_pool_applied:false,
        shadow_cycles_completed:report.shadow.completed_cycles,
        shadow_cycles_requested:report.shadow.requested_cycles
      });
    }
    const spent = Date.now() - cycleStartedAt;
    await sleep(Math.max(0, CYCLE_DELAY_MS - spent));
  }
  if (shadowAbortReason) {
    report.shadow.abort_reason = shadowAbortReason;
    if (report.shadow.status === 'RUNNING') report.shadow.status = 'INCOMPLETE';
  }
  const coverage = cache.coverageReport();
  finalizeCoverage(coverage);
  const health = cache.health();
  const wsAdvanced = coverage.websocket_advanced_symbols || 0;
  const allReady = report.market_wide_cache_coverage_ready === true;
  if (report.shadow_started) {
    const rows = report.shadow.cycles || [];
    const numeric = key => rows.map(row=>Number(row[key])||0);
    const sum = key => numeric(key).reduce((total,value)=>total+value,0);
    const mean = key => rows.length ? sum(key)/rows.length : null;
    const durations = numeric('scan_duration_ms').filter(Number.isFinite).sort((a,b)=>a-b);
    report.shadow.completed_cycles = rows.length;
    report.shadow.coverage_ready_every_cycle = rows.length === SHADOW_CYCLES && rows.every(row=>row.market_wide_cache_coverage_ready===true);
    report.shadow.websocket_live_every_cycle = rows.length === SHADOW_CYCLES && rows.every(row=>row.websocket_transport_state==='LIVE'&&row.websocket_running===true);
    report.shadow.summary = {
      requested_cycles:SHADOW_CYCLES,
      completed_cycles:rows.length,
      eligible_symbols_min:rows.length?Math.min(...numeric('eligible_total')):null,
      eligible_symbols_max:rows.length?Math.max(...numeric('eligible_total')):null,
      average_scan_duration_ms:mean('scan_duration_ms'),
      p95_scan_duration_ms:durations.length?durations[Math.min(durations.length-1,Math.ceil(durations.length*0.95)-1)]:null,
      maximum_scan_duration_ms:durations.length?durations.at(-1):null,
      average_light_candidate_total:mean('light_candidate_total'),
      average_micro_candidate_pool_total:mean('micro_candidate_pool_total'),
      light_candidate_to_micro_total:sum('candidate_to_micro_total'),
      light_candidate_to_deep_total:sum('candidate_to_deep_total'),
      micro_selected_total:sum('micro_selected_total'),
      micro_attempted_total:sum('micro_attempted_total'),
      micro_success_total:sum('micro_success_total'),
      deep_selected_total:sum('deep_selected_total'),
      deep_attempted_total:sum('deep_attempted_total'),
      deep_completed_total:sum('deep_completed_total'),
      deep_failed_total:sum('deep_failed_total'),
      micro_pre_expansion_pass_through_total:sum('micro_pre_expansion_total'),
      deep_pre_expansion_pass_through_total:sum('deep_pre_expansion_total'),
      actual_binance_http_attempts:sum('actual_binance_http_attempts'),
      actual_5m_kline_http_attempts:sum('actual_5m_kline_http_attempts'),
      binance_rest_calls_added_by_light_scan:sum('binance_rest_calls_added_by_light_scan'),
      cycles_with_zero_light_scan_rest_calls:rows.filter(row=>row.binance_rest_calls_added_by_light_scan===0).length,
      coverage_ready_every_cycle:report.shadow.coverage_ready_every_cycle,
      websocket_live_every_cycle:report.shadow.websocket_live_every_cycle,
      micro_pool_applied:false,
      paper_trading:true,
      real_order_execution:false
    };
    if (report.shadow.status !== 'COMPLETE' || rows.length !== SHADOW_CYCLES ||
        report.shadow.coverage_ready_every_cycle !== true || report.shadow.websocket_live_every_cycle !== true) {
      if (report.shadow.status === 'RUNNING') report.shadow.status = 'INCOMPLETE';
      report.status = 'SHADOW_INCOMPLETE';
    } else {
      report.status = 'SHADOW_COMPLETE';
    }
  } else {
    report.status = allReady ? 'SHADOW_NOT_STARTED' : report.status === 'WEBSOCKET_DEGRADED' ? 'WEBSOCKET_DEGRADED' : 'INCOMPLETE';
  }
  report.transport = {
    websocket_endpoint_preferred:WS_URLS[0],
    websocket_url_connected:health.websocket_url,
    websocket_state:health.transport_state,
    websocket_messages:health.received_messages,
    new_closed_candles_cached:health.received_closed_candles,
    duplicate_closed_candle_frames:health.duplicate_closed_candle_frames,
    ignored_open_candle_frames:health.ignored_open_candle_frames,
    rejected_future_candles:health.rejected_future_candles,
    rejected_candles:health.rejected_candles,
    reconnect_attempts:health.reconnect_attempts,
    consecutive_reconnect_attempts:health.consecutive_reconnect_attempts,
    maximum_reconnect_attempts:health.max_reconnect_attempts,
    rest_historical_backfill_used:health.rest_backfilled_symbols>0,
    rest_backfilled_symbols:health.rest_backfilled_symbols,
    websocket_updated_symbols:wsAdvanced,
    rest_transport_fallback_used:health.transport_state==='DEGRADED' && health.rest_fallback_seeded_symbols>0,
    rest_fallback_state:health.rest_fallback_state,
    rest_fallback_seeded_symbols:health.rest_fallback_seeded_symbols,
    actual_http_attempt_total:httpAttempts.length,
    actual_klines_http_attempts:httpAttempts.filter(item=>item.url.includes('/api/v3/klines')).length,
    actual_5m_klines_http_attempts:httpAttempts.filter(item=>item.url.includes('/api/v3/klines')&&item.url.includes('interval=5m')).length,
    actual_micro_1m_klines_http_attempts:httpAttempts.filter(item=>item.url.includes('/api/v3/klines')&&item.url.includes('interval=1m')).length,
    extra_per_symbol_rest_warmup_requests:0,
    historical_backfill_method:'EXISTING_MICRO_KLINE_RESPONSES_VIA_SHARED_REST_OBSERVER',
    websocket_sync_ready:coverage.websocket_sync_ready,
    full_market_coverage_ready:coverage.full_market_coverage_ready
  };
  report.binance_http_attempt_total = httpAttempts.length;
  report.binance_http_attempts = httpAttempts;
  report.legacy_micro_selector_active = true;
  report.micro_pool_applied = false;
  report.merged = false;
  report.deployed = false;
  report.note = report.status === 'SHADOW_COMPLETE'
    ? 'Full eligible market history and WebSocket freshness gate passed; isolated live Shadow cycles completed with candidate pool activation disabled. No merge or deployment.'
    : allReady
      ? 'Full cache coverage was reached, but the isolated Shadow comparison did not complete its required cycles. Inspect shadow.abort_reason.'
      : 'Acceptance gate remains closed; inspect per_symbol readiness_reason. Shadow did not start.';
} catch (error) {
  report.status = 'FAILED';
  report.failure_reason = String(error?.message || error || 'WARMUP_FAILED').slice(0, 500);
  if (cache) {
    const coverage = cache.coverageReport();
    finalizeCoverage(coverage);
    const health = cache.health();
    report.transport = {
      websocket_state:health.transport_state,
      websocket_messages:health.received_messages,
      new_closed_candles_cached:health.received_closed_candles,
      duplicate_closed_candle_frames:health.duplicate_closed_candle_frames,
      ignored_open_candle_frames:health.ignored_open_candle_frames,
      rejected_future_candles:health.rejected_future_candles,
      reconnect_attempts:health.reconnect_attempts,
      rest_historical_backfill_used:health.rest_backfilled_symbols>0,
      rest_backfilled_symbols:health.rest_backfilled_symbols,
      websocket_updated_symbols:health.websocket_updated_symbols,
      rest_transport_fallback_used:health.transport_state==='DEGRADED' && health.rest_fallback_seeded_symbols>0,
      full_market_coverage_ready:health.full_market_coverage_ready
    };
  }
} finally {
  if (radar) {
    radar.running=false;
    if (radar.timer) clearTimeout(radar.timer);
    radar.timer=null;
  }
  if (cache) cache.stop();
  report.market_wide_cache_coverage_ready = report.market_wide_cache_coverage_ready === true;
  report.acceptance_gate_open = report.market_wide_cache_coverage_ready;
  report.micro_pool_applied = false;
  report.merged = false;
  report.deployed = false;
  await saveReport();
}
if (report.status !== 'SHADOW_COMPLETE' || report.acceptance_gate_open !== true ||
    report.shadow?.completed_cycles !== SHADOW_CYCLES || report.shadow?.coverage_ready_every_cycle !== true ||
    report.shadow?.websocket_live_every_cycle !== true || report.shadow?.summary?.binance_rest_calls_added_by_light_scan !== 0) process.exitCode = 1;
