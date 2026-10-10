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
    logger:{info:(...args)=>console.log(...args),warn:(...args)=>console.warn(...args)}
  });
  // This evidence-only run should not issue 15m/1h/4h/depth Deep requests.
  radar.selectDeepFromMicro = () => [];
  radar.running = true;
  report.status = 'WARMING_UP';
  report.warmup_started_at_ms = Date.now();

  const deadline = Date.now() + MAX_WARMUP_MINUTES * 60_000;
  while (Date.now() < deadline) {
    const cycleStartedAt = Date.now();
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
      deep_scans_disabled_for_this_isolated_warmup:true,
      micro_candidates_per_cycle:12
    };

    const coverage = cache.coverageReport();
    finalizeCoverage(coverage);
    const health = cache.health();
    const now = Date.now();
    if (report.market_wide_cache_coverage_ready === true) {
      report.status = 'READY';
      break;
    }
    if (health.state === 'DEGRADED' && !health.running) {
      report.status = 'WEBSOCKET_DEGRADED';
      break;
    }
    if (now - lastProgressAt >= 60000) {
      lastProgressAt = now;
      progressLog('[MARKET_WIDE_CACHE_WARMUP_PROGRESS]', {
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
        micro_pool_applied:false
      });
    }
    const spent = Date.now() - cycleStartedAt;
    await sleep(Math.max(0, CYCLE_DELAY_MS - spent));
  }

  const coverage = cache.coverageReport();
  finalizeCoverage(coverage);
  const health = cache.health();
  const wsAdvanced = coverage.websocket_advanced_symbols || 0;
  const allReady = report.market_wide_cache_coverage_ready === true;
  report.status = allReady ? 'READY' : report.status === 'WEBSOCKET_DEGRADED' ? 'WEBSOCKET_DEGRADED' : 'INCOMPLETE';
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
  report.shadow_started = false;
  report.merged = false;
  report.deployed = false;
  report.note = allReady
    ? 'Every eligible symbol has >=60 fresh continuous closed 5m candles and a newer closed WebSocket candle after its first REST backfill.'
    : 'Acceptance gate remains closed; inspect per_symbol readiness_reason. Shadow must not start.';
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
  report.shadow_started = false;
  report.merged = false;
  report.deployed = false;
  await saveReport();
}
if (report.status !== 'READY' || report.acceptance_gate_open !== true) process.exitCode = 1;
