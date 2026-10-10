import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {RestClient} from '../market/binance-rest.mjs';
import {MarketWideKlineCache} from '../market/market-wide-kline-cache.mjs';
import {buildSpotUniverse} from '../market/universe-scanner.mjs';

const MIN_QUOTE_VOLUME_24H = Number(process.env.RADARX_MARKET_WIDE_MIN_QUOTE_VOLUME_24H || 750000);
const MAX_WARMUP_MINUTES = Math.min(350, Math.max(1,
  Math.trunc(Number(process.env.RADARX_MARKET_WIDE_WARMUP_MAX_MINUTES || 330))));
const REPORT_PATH = resolve(process.env.RADARX_MARKET_WIDE_WARMUP_REPORT ||
  'artifacts/market-wide-cache-warmup.json');
const DATA_API = 'https://data-api.binance.vision';
const WS_URLS = [
  'wss://data-stream.binance.vision/stream',
  'wss://stream.binance.com:9443/stream',
  'wss://stream.binance.com:443/stream'
];
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const startedAt = Date.now();
const httpAttempts = [];
let cache = null;
let report = {
  schema_version: 1,
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
  discovery: {exchange_info_symbols: 0, valid_spot_usdt_symbols: 0, ticker_rows: 0, eligible_symbols: 0},
  transport: {
    websocket_endpoint: WS_URLS[0], websocket_state: 'NOT_STARTED',
    websocket_messages: 0, new_closed_candles_cached: 0,
    duplicate_closed_candle_frames: 0, rejected_candles: 0,
    reconnect_attempts: 0, maximum_reconnect_attempts: 5,
    rest_fallback_used: false, rest_klines_requests: 0
  },
  binance_http_attempts: httpAttempts,
  legacy_micro_selector: {
    isolated_warmup_runner: 'NOT_RUNNING',
    pr_runtime_fallback_while_gate_closed: 'ACTIVE'
  },
  per_symbol: [],
  reasons: {}
};

async function saveReport() {
  report.finished_at_ms = Date.now();
  report.duration_ms = Math.max(0, report.finished_at_ms - startedAt);
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
    elapsed_seconds: Math.round(report.duration_ms / 1000),
    eligible_total: report.discovery.eligible_symbols,
    ready_total: report.summary?.ready_symbols ?? 0,
    not_ready_total: report.summary?.not_ready_symbols ?? report.discovery.eligible_symbols,
    missing_total: report.summary?.missing_symbols ?? report.discovery.eligible_symbols,
    stale_total: report.summary?.stale_symbols ?? 0,
    cache_coverage_ready: report.market_wide_cache_coverage_ready,
    micro_pool_applied: report.micro_pool_applied,
    binance_http_attempts: report.binance_http_attempt_total,
    websocket_messages: report.transport.websocket_messages,
    reconnect_attempts: report.transport.reconnect_attempts,
    rest_fallback_used: report.transport.rest_fallback_used,
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

  // Match Radar 8 eligibility: live Binance Spot USDT symbols, with 24h quote volume >= threshold.
  const exchangeInfo = await rest.request('/api/v3/exchangeInfo');
  const spotUniverse = buildSpotUniverse(exchangeInfo.data, 'USDT').map(row => row.symbol);
  report.discovery.exchange_info_symbols = Array.isArray(exchangeInfo.data?.symbols)
    ? exchangeInfo.data.symbols.length : 0;
  report.discovery.valid_spot_usdt_symbols = spotUniverse.length;

  const tickerResponse = await rest.request('/api/v3/ticker/24hr');
  const allowed = new Set(spotUniverse);
  const tickerRows = Array.isArray(tickerResponse.data) ? tickerResponse.data : [];
  report.discovery.ticker_rows = tickerRows.length;
  const eligible = [...new Set(tickerRows
    .filter(row => allowed.has(String(row?.symbol || '').toUpperCase()))
    .filter(row => Number.isFinite(Number(row?.lastPrice)) && Number(row.lastPrice) > 0)
    .filter(row => Number.isFinite(Number(row?.quoteVolume)) && Number(row.quoteVolume) >= MIN_QUOTE_VOLUME_24H)
    .filter(row => Number.isFinite(Number(row?.count)) && Number(row.count) >= 0)
    .filter(row => Number.isFinite(Number(row?.priceChangePercent)))
    .map(row => String(row.symbol).toUpperCase()))].sort();
  report.discovery.eligible_symbols = eligible.length;

  if (!eligible.length) throw new Error('NO_ELIGIBLE_SPOT_USDT_SYMBOLS');
  if (eligible.length > 1024) throw new Error('ELIGIBLE_SYMBOLS_EXCEED_COMBINED_STREAM_LIMIT');

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
  cache.setSymbols(eligible);
  cache.start();
  report.status = 'WARMING_UP';
  report.warmup_connected_at_ms = Date.now();
  report.transport.websocket_urls_tried = cache.urls;

  const deadline = Date.now() + MAX_WARMUP_MINUTES * 60_000;
  let lastProgressAt = 0;
  let lastNotReadySignature = '';
  while (Date.now() < deadline) {
    const coverage = cache.coverageReport();
    const health = cache.health();
    const now = Date.now();
    if (coverage.cache_coverage_ready) {
      report.status = 'READY';
      break;
    }
    if (health.state === 'DEGRADED' && !health.running) {
      report.status = 'WEBSOCKET_DEGRADED';
      break;
    }
    if (now - lastProgressAt >= 60_000) {
      lastProgressAt = now;
      const counts = coverage.symbols.reduce((acc, row) => {
        acc[row.state] = (acc[row.state] || 0) + 1;
        return acc;
      }, {});
      const signature = JSON.stringify(counts);
      console.log('[MARKET_WIDE_CACHE_WARMUP_PROGRESS] ' + JSON.stringify({
        elapsed_seconds: Math.round((now - startedAt) / 1000),
        websocket_state: health.state,
        expected_symbols: coverage.expected_symbols,
        ready_symbols: coverage.ready_symbols,
        not_ready_symbols: coverage.not_ready_symbols,
        reason_counts: counts,
        websocket_messages: health.received_messages,
        unique_closed_candles_cached: health.received_closed_candles,
        duplicate_closed_candle_frames: health.duplicate_closed_candle_frames,
        rejected_candles: health.rejected_candles,
        reconnect_attempts: health.reconnect_attempts,
        changed_since_last_progress: signature !== lastNotReadySignature
      }));
      lastNotReadySignature = signature;
    }
    await sleep(5000);
  }

  const finalCoverage = cache.coverageReport();
  const finalHealth = cache.health();
  const summaryCounts = finalCoverage.symbols.reduce((acc, row) => {
    acc[row.state] = (acc[row.state] || 0) + 1;
    return acc;
  }, {});
  report.market_wide_cache_coverage_ready = finalCoverage.cache_coverage_ready === true &&
    finalCoverage.ready_symbols === finalCoverage.expected_symbols;
  report.acceptance_gate_open = report.market_wide_cache_coverage_ready;
  report.micro_pool_applied = false;
  report.shadow_started = false;
  report.merged = false;
  report.deployed = false;
  report.summary = {
    eligible_symbols: finalCoverage.expected_symbols,
    ready_symbols: finalCoverage.ready_symbols,
    not_ready_symbols: finalCoverage.not_ready_symbols,
    missing_symbols: finalCoverage.missing_symbols,
    stale_symbols: finalCoverage.stale_symbols,
    incomplete_symbols: finalCoverage.incomplete_symbols,
    reason_counts: summaryCounts
  };
  report.per_symbol = finalCoverage.symbols;
  report.transport = {
    websocket_endpoint_preferred: WS_URLS[0],
    websocket_url_connected: finalHealth.websocket_url,
    websocket_state: finalHealth.transport_state,
    websocket_messages: finalHealth.received_messages,
    new_closed_candles_cached: finalHealth.received_closed_candles,
    duplicate_closed_candle_frames: finalHealth.duplicate_closed_candle_frames,
    rejected_candles: finalHealth.rejected_candles,
    reconnect_attempts: finalHealth.reconnect_attempts,
    maximum_reconnect_attempts: finalHealth.max_reconnect_attempts,
    rest_fallback_state: finalHealth.rest_fallback_state,
    rest_fallback_used: finalHealth.rest_fallback_seeded_symbols > 0,
    rest_fallback_seeded_symbols: finalHealth.rest_fallback_seeded_symbols,
    rest_klines_requests: httpAttempts.filter(item => item.url.includes('/api/v3/klines')).length,
    rest_requests_added_by_warmup: httpAttempts.length,
    rest_per_symbol_warmup_requests: 0
  };
  report.binance_http_attempt_total = httpAttempts.length;
  report.binance_http_attempts = httpAttempts;
  report.reason_counts = summaryCounts;
  report.note = report.market_wide_cache_coverage_ready
    ? 'All eligible symbols have fresh, valid, continuous closed 5m coverage.'
    : 'Coverage incomplete: acceptance gate remains closed; do not start Shadow.';
} catch (error) {
  report.status = 'FAILED';
  report.failure_reason = String(error?.message || error || 'WARMUP_FAILED').slice(0, 500);
  if (cache) {
    const coverage = cache.coverageReport();
    const health = cache.health();
    report.summary = {
      eligible_symbols: coverage.expected_symbols, ready_symbols: coverage.ready_symbols,
      not_ready_symbols: coverage.not_ready_symbols, missing_symbols: coverage.missing_symbols,
      stale_symbols: coverage.stale_symbols, incomplete_symbols: coverage.incomplete_symbols
    };
    report.per_symbol = coverage.symbols;
    report.transport = {...report.transport, websocket_state:health.transport_state,
      websocket_messages:health.received_messages, new_closed_candles_cached:health.received_closed_candles,
      duplicate_closed_candle_frames:health.duplicate_closed_candle_frames,
      reconnect_attempts:health.reconnect_attempts, rest_fallback_state:health.rest_fallback_state};
  }
} finally {
  if (cache) cache.stop();
  await saveReport();
}
if (report.status !== 'READY' || report.acceptance_gate_open !== true) process.exitCode = 1;
