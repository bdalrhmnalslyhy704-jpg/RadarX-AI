import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import assert from 'node:assert/strict';
import {MarketWideLightScan, isDirectionalCandidateSymbol} from '../core/market-wide-light-scan.mjs';

const API_ROOT = 'https://data-api.binance.vision';
const MIN_QUOTE_VOLUME = 750000;
const KLINE_LIMIT = 1000;
const CANDLE_MS = 5 * 60 * 1000;
const SAMPLE_STEP_MS = 60 * 60 * 1000;
const LOOKBACK_BARS = 96;
const FUTURE_BARS = 48;
const HORIZONS = {m15: 3, h1: 12, h4: 48};
const MIN_HISTORY_BARS = 800;
const MIN_SAMPLE_UNIVERSE = 100;
const MIN_SAMPLE_COUNT = 24;
const MIN_COVERAGE_RATIO = 0.70;
const REPORT_PATH = resolve(process.env.RADARX_MARKET_WIDE_OUTCOME_REPORT || 'artifacts/market-wide-light-outcome-backtest.json');
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const startedAt = Date.now();
let lastRequestStartedAt = 0;
let requestQueue = Promise.resolve();
const requestAudit = [];

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}
function mean(values) {
  const rows = values.filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}
function median(values) {
  const rows = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}
function rate(values) {
  const rows = values.filter(value => typeof value === 'boolean');
  return rows.length ? rows.filter(Boolean).length / rows.length : null;
}
function stddev(values) {
  const rows = values.filter(Number.isFinite);
  if (rows.length < 2) return 0;
  const avg = mean(rows);
  return Math.sqrt(rows.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (rows.length - 1));
}
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lo = Math.floor(position), hi = Math.ceil(position);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
function movingBlockBootstrapCI(values, {blockLength = 4, iterations = 2000, seed = 224199} = {}) {
  const rows = values.filter(Number.isFinite);
  if (rows.length < 8) return {method:'MOVING_BLOCK_BOOTSTRAP_4H', n:rows.length, low:null, high:null};
  const random = seededRandom(seed);
  const means = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sample = [];
    while (sample.length < rows.length) {
      const start = Math.floor(random() * rows.length);
      for (let offset = 0; offset < blockLength && sample.length < rows.length; offset++) {
        sample.push(rows[(start + offset) % rows.length]);
      }
    }
    means.push(mean(sample));
  }
  means.sort((a, b) => a - b);
  return {method:'MOVING_BLOCK_BOOTSTRAP_4H', n:rows.length, low:round(quantile(means, 0.025), 6), high:round(quantile(means, 0.975), 6)};
}
function closeBoundary(timestamp) {
  return Math.floor((timestamp + 1) / CANDLE_MS) * CANDLE_MS - 1;
}
function continuous(rows) {
  if (!Array.isArray(rows) || !rows.length) return false;
  for (let index = 1; index < rows.length; index++) {
    if (Number(rows[index].openTime) - Number(rows[index - 1].openTime) !== CANDLE_MS) return false;
  }
  return true;
}
function summarizeRows(rows) {
  const available = rows.filter(row => row && Number.isFinite(row.return4h) && Number.isFinite(row.mfe4h) && Number.isFinite(row.mae4h));
  return {
    observations: available.length,
    unique_symbols: new Set(available.map(row => row.symbol)).size,
    avg_return_15m_pct: round(mean(available.map(row => row.return15m)), 4),
    avg_return_1h_pct: round(mean(available.map(row => row.return1h)), 4),
    median_return_1h_pct: round(median(available.map(row => row.return1h)), 4),
    avg_return_4h_pct: round(mean(available.map(row => row.return4h)), 4),
    median_return_4h_pct: round(median(available.map(row => row.return4h)), 4),
    median_max_upside_1h_pct: round(median(available.map(row => row.mfe1h)), 4),
    hit_3pct_upside_1h_pct: round((rate(available.map(row => row.mfe1h >= 3)) ?? 0) * 100, 3),
    hit_3pct_upside_4h_pct: round((rate(available.map(row => row.mfe4h >= 3)) ?? 0) * 100, 3),
    hit_5pct_upside_4h_pct: round((rate(available.map(row => row.mfe4h >= 5)) ?? 0) * 100, 3),
    hit_10pct_upside_4h_pct: round((rate(available.map(row => row.mfe4h >= 10)) ?? 0) * 100, 3),
    median_max_adverse_4h_pct: round(median(available.map(row => row.mae4h)), 4),
    adverse_5pct_4h_pct: round((rate(available.map(row => row.mae4h <= -5)) ?? 0) * 100, 3)
  };
}
function pairedDifferenceCI(perSample, leftKey, rightKey, metricKey, seed) {
  const diffs = perSample
    .filter(row => Number.isFinite(row[leftKey]?.[metricKey]) && Number.isFinite(row[rightKey]?.[metricKey]))
    .map(row => row[leftKey][metricKey] - row[rightKey][metricKey]);
  const ci = movingBlockBootstrapCI(diffs, {seed});
  return {
    matched_snapshots: diffs.length,
    mean_difference_percentage_points: round(mean(diffs) * 100, 3),
    confidence_interval_95_percentage_points: {
      method: ci.method,
      block_length_snapshots: 4,
      lower: ci.low === null ? null : round(ci.low * 100, 3),
      upper: ci.high === null ? null : round(ci.high * 100, 3)
    }
  };
}
function perSampleRates(rows) {
  return {
    hit5_mfe4h_rate: rate(rows.map(row => row.mfe4h >= 5)),
    hit3_mfe4h_rate: rate(rows.map(row => row.mfe4h >= 3)),
    mean_return4h: mean(rows.map(row => row.return4h)),
    mean_mfe4h: mean(rows.map(row => row.mfe4h)),
    median_mae4h: median(rows.map(row => row.mae4h))
  };
}
function normalizedKlines(symbol, rawRows, fetchedAt) {
  if (!Array.isArray(rawRows)) throw new Error('KLINE_RESPONSE_NOT_ARRAY:' + symbol);
  return rawRows.map(row => ({
    symbol,
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
    tradeCount: Number(row[8]),
    closed: Number(row[6]) <= fetchedAt,
    source: 'BINANCE_PUBLIC_REST'
  })).filter(row => row.closed && Number.isFinite(row.openTime) && Number.isFinite(row.closeTime) &&
    Number.isFinite(row.open) && Number.isFinite(row.high) && Number.isFinite(row.low) &&
    Number.isFinite(row.close) && row.close > 0)
    .sort((a, b) => a.openTime - b.openTime)
    .filter((row, index, rows) => index === 0 || row.openTime !== rows[index - 1].openTime);
}
async function getJson(url) {
  const previous = requestQueue;
  let release;
  requestQueue = new Promise(resolveQueue => { release = resolveQueue; });
  await previous;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const spacing = Math.max(0, lastRequestStartedAt + 220 - Date.now());
      if (spacing) await sleep(spacing);
      lastRequestStartedAt = Date.now();
      const audit = {url, started_at_ms:lastRequestStartedAt, status:null, attempt:attempt + 1};
      requestAudit.push(audit);
      let response;
      try {
        response = await fetch(url, {headers:{accept:'application/json','user-agent':'RadarX-Research-Shadow/1.0'}});
      } catch (error) {
        audit.error = String(error?.message || error).slice(0, 200);
        if (attempt === 3) throw error;
        await sleep(500 * (attempt + 1));
        continue;
      }
      audit.status = response.status;
      if (response.ok) {
        audit.finished_at_ms = Date.now();
        return await response.json();
      }
      audit.error = 'HTTP_' + response.status;
      if ((response.status === 418 || response.status === 429) && attempt < 3) {
        const header = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(header) && header > 0 ? Math.min(60000, header * 1000) : 5000 * (attempt + 1));
        continue;
      }
      if (response.status >= 500 && attempt < 3) {
        await sleep(750 * (attempt + 1));
        continue;
      }
      throw new Error('BINANCE_HTTP_' + response.status + ':' + url.split('?')[0]);
    }
    throw new Error('BINANCE_REQUEST_RETRIES_EXHAUSTED');
  } finally {
    release();
  }
}
function forwardOutcome(symbol, candles, index) {
  const previous = candles.slice(index - 12, index + 1);
  const current = candles[index];
  const next15 = candles.slice(index + 1, index + 1 + HORIZONS.m15);
  const next1h = candles.slice(index + 1, index + 1 + HORIZONS.h1);
  const next4h = candles.slice(index + 1, index + 1 + HORIZONS.h4);
  if (previous.length !== 13 || next15.length !== 3 || next1h.length !== 12 || next4h.length !== 48 ||
      !continuous(previous) || !continuous([current, ...next4h])) return null;
  assert.ok(next4h[0].openTime > current.closeTime, 'NO_LOOKAHEAD_FUTURE_START');
  const startPrice = current.close;
  const maxHigh = rows => Math.max(...rows.map(row => row.high));
  const minLow = rows => Math.min(...rows.map(row => row.low));
  const returnAt = rows => (rows.at(-1).close / startPrice - 1) * 100;
  const momentum1h = (current.close / candles[index - 12].close - 1) * 100;
  return {
    symbol, momentum1h,
    return15m: returnAt(next15),
    return1h: returnAt(next1h),
    return4h: returnAt(next4h),
    mfe1h: (maxHigh(next1h) / startPrice - 1) * 100,
    mfe4h: (maxHigh(next4h) / startPrice - 1) * 100,
    mae4h: (minLow(next4h) / startPrice - 1) * 100,
    signal_close_time_ms: current.closeTime
  };
}

function selfTest() {
  const fake = [];
  const open0 = 1800000000000;
  for (let index = 0; index < 60; index++) {
    const open = 100 + index * 0.01;
    fake.push({symbol:'TESTUSDT',openTime:open0 + index * CANDLE_MS,closeTime:open0 + index * CANDLE_MS + CANDLE_MS - 1,
      open,high:open * 1.01,low:open * 0.99,close:open * 1.005,volume:10,tradeCount:20,closed:true,source:'BINANCE_PUBLIC_REST'});
  }
  assert.equal(continuous(fake.slice(0, 12)), true);
  assert.equal(isDirectionalCandidateSymbol('OGNUSDT'), true);
  assert.equal(isDirectionalCandidateSymbol('USDCUSDT'), false);
  const ci = movingBlockBootstrapCI([0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8], {iterations:100,seed:224});
  assert.equal(ci.n, 8);
  assert.ok(Number.isFinite(ci.low) && Number.isFinite(ci.high));
}
selfTest();

const report = {
  schema_version: 1,
  status: 'INITIALIZING',
  started_at_utc: new Date(startedAt).toISOString(),
  mode: 'ISOLATED_HISTORICAL_OUTCOME_REPLAY',
  production_touched: false,
  merged: false,
  deployed: false,
  paper_trading: true,
  real_order_execution: false,
  confidence_score: 'UNKNOWN',
  settings: {
    minimum_quote_volume_24h_usdt: MIN_QUOTE_VOLUME,
    klines_interval: '5m',
    requested_history_limit_per_symbol: KLINE_LIMIT,
    snapshot_spacing_minutes: 60,
    indicator_history_bars: LOOKBACK_BARS,
    forward_horizons_minutes: {m15:15,h1:60,h4:240},
    min_history_bars_per_symbol: MIN_HISTORY_BARS,
    requests_serialized: true,
    minimum_request_spacing_ms: 220
  },
  methodology: {
    candle_policy: 'Only fully closed Binance public 5m candles; inputs are capped at the snapshot candle. Outcomes use strictly later candles.',
    comparator: 'All historically evaluable eligible symbols and a separate top-12 1h-momentum comparator; this is not claimed to reproduce the legacy Micro selector.',
    selection: 'MarketWideLightScan 48-symbol pool and a score-ranked 12-symbol shortlist from that pool; no alerts or orders are generated.',
    known_limitations: [
      'Current active symbols and current 24h quote-volume eligibility are used for a bounded recent-history replay, so delisted coins and historical eligibility are not reconstructed.',
      'The 4-hour forward windows overlap across hourly snapshots; confidence intervals use a deterministic circular 4-snapshot moving-block bootstrap, but results remain observational rather than proof of future profitability.',
      'A light-scan candidate is a prefilter only; this replay does not authorize trades or claim trading profitability.'
    ]
  },
  data: {},
  quality: {},
  outcome_metrics: {},
  per_sample: [],
  request_audit: requestAudit,
  failures: []
};

try {
  const exchangeInfo = await getJson(API_ROOT + '/api/v3/exchangeInfo');
  const tickers = await getJson(API_ROOT + '/api/v3/ticker/24hr');
  if (!Array.isArray(exchangeInfo?.symbols) || !Array.isArray(tickers)) throw new Error('BINANCE_UNIVERSE_RESPONSE_INVALID');
  const tickerBySymbol = new Map(tickers.map(row => [String(row.symbol || '').toUpperCase(), row]));
  const currentUniverse = exchangeInfo.symbols
    .filter(row => row.status === 'TRADING' && row.quoteAsset === 'USDT' && row.isSpotTradingAllowed !== false)
    .map(row => {
      const symbol = String(row.symbol || '').toUpperCase();
      const ticker = tickerBySymbol.get(symbol);
      return {symbol, quoteVolume24h:Number(ticker?.quoteVolume), lastPrice:Number(ticker?.lastPrice)};
    })
    .filter(row => row.symbol && Number.isFinite(row.quoteVolume24h) && row.quoteVolume24h >= MIN_QUOTE_VOLUME)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  report.data = {
    exchange_info_spot_usdt_symbols: exchangeInfo.symbols.filter(row => row.status === 'TRADING' && row.quoteAsset === 'USDT' && row.isSpotTradingAllowed !== false).length,
    current_eligible_symbols: currentUniverse.length,
    directional_eligible_symbols: currentUniverse.filter(row => isDirectionalCandidateSymbol(row.symbol)).length,
    history_ready_symbols: 0,
    history_ready_ratio_pct: 0,
    candles_requested_per_symbol: KLINE_LIMIT,
    candles_received_total: 0,
    candles_received_min_per_symbol: null,
    candles_received_median_per_symbol: null,
    candles_received_max_per_symbol: null,
    collection_started_at_ms: Date.now(),
    request_count_before_symbol_downloads: requestAudit.length
  };
  if (currentUniverse.length < MIN_SAMPLE_UNIVERSE) throw new Error('CURRENT_ELIGIBLE_UNIVERSE_TOO_SMALL:' + currentUniverse.length);
  const collectionStartedAt = Date.now();
  const history = new Map();
  for (const entry of currentUniverse) {
    const url = API_ROOT + '/api/v3/klines?symbol=' + encodeURIComponent(entry.symbol) + '&interval=5m&limit=' + KLINE_LIMIT;
    try {
      const raw = await getJson(url);
      const candles = normalizedKlines(entry.symbol, raw, collectionStartedAt);
      history.set(entry.symbol, {entry, candles, error:null});
    } catch (error) {
      const failure = {symbol:entry.symbol,reason:String(error?.message || error).slice(0, 220)};
      report.failures.push(failure);
      history.set(entry.symbol, {entry, candles:[], error:failure.reason});
    }
  }
  const perSymbolCounts = currentUniverse.map(row => history.get(row.symbol)?.candles?.length || 0);
  const historyReady = currentUniverse.filter(row => {
    const candles = history.get(row.symbol)?.candles || [];
    return candles.length >= MIN_HISTORY_BARS && candles.length > 0 &&
      collectionStartedAt - candles.at(-1).closeTime <= 15 * 60 * 1000;
  });
  report.data.history_ready_symbols = historyReady.length;
  report.data.history_ready_ratio_pct = round(historyReady.length / currentUniverse.length * 100, 3);
  report.data.candles_received_total = perSymbolCounts.reduce((sum, value) => sum + value, 0);
  report.data.candles_received_min_per_symbol = perSymbolCounts.length ? Math.min(...perSymbolCounts) : null;
  report.data.candles_received_median_per_symbol = median(perSymbolCounts);
  report.data.candles_received_max_per_symbol = perSymbolCounts.length ? Math.max(...perSymbolCounts) : null;
  report.data.collection_finished_at_ms = Date.now();
  report.data.kline_download_requests = currentUniverse.length;
  report.data.http_attempts_total = requestAudit.length;
  if (historyReady.length < Math.max(MIN_SAMPLE_UNIVERSE, Math.ceil(currentUniverse.length * MIN_COVERAGE_RATIO))) {
    throw new Error('HISTORICAL_UNIVERSE_COVERAGE_INSUFFICIENT:' + historyReady.length + '/' + currentUniverse.length);
  }

  const readyRows = historyReady.map(row => ({
    ...row,
    candles:history.get(row.symbol).candles,
    byCloseTime:new Map(history.get(row.symbol).candles.map((candle, index) => [candle.closeTime, index]))
  }));
  const earliestCommonClose = Math.max(...readyRows.map(row => row.candles[0].closeTime));
  const latestCommonClose = Math.min(...readyRows.map(row => row.candles.at(-1).closeTime));
  const earliestSnapshot = earliestCommonClose + (LOOKBACK_BARS - 1) * CANDLE_MS;
  let latestSnapshot = closeBoundary(latestCommonClose - FUTURE_BARS * CANDLE_MS);
  latestSnapshot = Math.min(latestSnapshot, closeBoundary(collectionStartedAt - FUTURE_BARS * CANDLE_MS));
  const sampleTimes = [];
  for (let at = latestSnapshot; at >= earliestSnapshot; at -= SAMPLE_STEP_MS) sampleTimes.push(at);
  sampleTimes.reverse(); // Stateful scanner replay must advance forward in time.
  if (sampleTimes.length < MIN_SAMPLE_COUNT) throw new Error('INSUFFICIENT_HISTORICAL_SNAPSHOTS:' + sampleTimes.length);
  report.data.history_window_start_utc = new Date(earliestCommonClose).toISOString();
  report.data.history_window_end_utc = new Date(latestCommonClose).toISOString();
  report.data.snapshot_count = sampleTimes.length;
  report.data.snapshot_first_utc = new Date(sampleTimes[0]).toISOString();
  report.data.snapshot_last_utc = new Date(sampleTimes.at(-1)).toISOString();
  report.data.common_history_symbols = readyRows.length;
  report.quality = {
    future_data_in_inputs: false,
    lookahead_violations: 0,
    snapshots_with_sufficient_universe: 0,
    snapshots_full_cache_coverage: 0,
    snapshots_missing_coverage: 0,
    total_market_wide_evaluations: 0,
    total_selected_pool_observations: 0,
    all_input_candles_closed: true,
    zero_live_orders: true
  };
  const scanner = new MarketWideLightScan({config:{candidateLimit:48,rotationReserve:12,maxCandleAgeMs:8 * 60 * 1000,
    minClosedCandles:60,maxClosedCandles:96,minimumReadyCandidates:24},clock:()=>Date.now()});
  const pooled = {market:[], light48:[], light12:[], momentum12:[]};
  const perSampleMetrics = [];
  let sampleIndex = 0;
  let totalEligibleInSnapshots = 0;
  let minEligibleInSnapshot = Infinity;
  let maxEligibleInSnapshot = 0;
  for (const timestamp of sampleTimes) {
    sampleIndex++;
    const eligibleNow = [];
    const indexBySymbol = new Map();
    const outcomeBySymbol = new Map();
    for (const row of readyRows) {
      const index = row.byCloseTime.get(timestamp);
      if (!Number.isInteger(index) || index < LOOKBACK_BARS - 1 || index + FUTURE_BARS >= row.candles.length) continue;
      const inputRows = row.candles.slice(index - LOOKBACK_BARS + 1, index + 1);
      const futureRows = row.candles.slice(index + 1, index + FUTURE_BARS + 1);
      if (inputRows.length !== LOOKBACK_BARS || !continuous(inputRows) || !continuous([row.candles[index], ...futureRows])) continue;
      if (inputRows.some(candle => candle.closed !== true || candle.closeTime > timestamp)) {
        report.quality.lookahead_violations++;
        report.quality.future_data_in_inputs = true;
        continue;
      }
      const outcome = forwardOutcome(row.symbol, row.candles, index);
      if (!outcome) continue;
      indexBySymbol.set(row.symbol, index);
      outcomeBySymbol.set(row.symbol, outcome);
      eligibleNow.push({symbol:row.symbol,quoteVolume24h:row.quoteVolume24h,lastPrice:row.lastPrice});
    }
    totalEligibleInSnapshots += eligibleNow.length;
    minEligibleInSnapshot = Math.min(minEligibleInSnapshot, eligibleNow.length);
    maxEligibleInSnapshot = Math.max(maxEligibleInSnapshot, eligibleNow.length);
    if (eligibleNow.length < Math.max(MIN_SAMPLE_UNIVERSE, Math.ceil(currentUniverse.length * MIN_COVERAGE_RATIO))) {
      report.quality.snapshots_missing_coverage++;
      continue;
    }
    report.quality.snapshots_with_sufficient_universe++;
    const result = scanner.scan({
      eligible:eligibleNow,
      getSeries:symbol => {
        const row = readyRows.find(item => item.symbol === symbol);
        const index = indexBySymbol.get(symbol);
        if (!row || !Number.isInteger(index)) return null;
        return {symbol,source:'BINANCE_PUBLIC_REST',candles:row.candles.slice(index - LOOKBACK_BARS + 1,index + 1)};
      },
      now:timestamp,
      cycle:sampleIndex,
      isExceptional:()=>false,
      lastMicroScannedAt:()=>null
    });
    report.quality.total_market_wide_evaluations += result.summary.evaluated_total;
    if (result.summary.evaluated_total === eligibleNow.length && result.summary.cache_coverage_ready) {
      report.quality.snapshots_full_cache_coverage++;
    }
    const marketRows = eligibleNow.map(row => outcomeBySymbol.get(row.symbol)).filter(Boolean);
    const lightPoolRows = result.candidateSymbols.map(symbol => outcomeBySymbol.get(symbol)).filter(Boolean);
    const ranked = result.selected.slice().sort((a, b) =>
      Number(b.result?.candidate) - Number(a.result?.candidate) ||
      Number(b.result?.candidate_score ?? -1) - Number(a.result?.candidate_score ?? -1) ||
      Number(b.result?.metrics?.optional_participation_available) - Number(a.result?.metrics?.optional_participation_available) ||
      a.symbol.localeCompare(b.symbol));
    const lightShortlistRows = ranked.slice(0, 12).map(item => outcomeBySymbol.get(item.symbol)).filter(Boolean);
    const momentumShortlistRows = eligibleNow.map(row => outcomeBySymbol.get(row.symbol)).filter(Boolean)
      .sort((a, b) => b.momentum1h - a.momentum1h).slice(0, 12);
    pooled.market.push(...marketRows);
    pooled.light48.push(...lightPoolRows);
    pooled.light12.push(...lightShortlistRows);
    pooled.momentum12.push(...momentumShortlistRows);
    report.quality.total_selected_pool_observations += lightPoolRows.length;
    const groups = {
      market:perSampleRates(marketRows),
      light48:perSampleRates(lightPoolRows),
      light12:perSampleRates(lightShortlistRows),
      momentum12:perSampleRates(momentumShortlistRows)
    };
    perSampleMetrics.push({
      snapshot_utc:new Date(timestamp).toISOString(),
      eligible_with_closed_continuous_outcomes:eligibleNow.length,
      evaluated_total:result.summary.evaluated_total,
      light_candidate_total:result.summary.light_candidate_total,
      light_pool_total:result.candidateSymbols.length,
      light_shortlist_total:lightShortlistRows.length,
      momentum_shortlist_total:momentumShortlistRows.length,
      metrics:groups
    });
  }
  report.quality.avg_eligible_per_snapshot = round(totalEligibleInSnapshots / sampleTimes.length, 2);
  report.quality.min_eligible_per_snapshot = Number.isFinite(minEligibleInSnapshot) ? minEligibleInSnapshot : 0;
  report.quality.max_eligible_per_snapshot = maxEligibleInSnapshot;
  report.quality.average_current_universe_coverage_pct = round(report.quality.avg_eligible_per_snapshot / currentUniverse.length * 100, 3);
  report.quality.lookahead_guard_passed = report.quality.lookahead_violations === 0 && report.quality.future_data_in_inputs === false;
  report.quality.full_cache_coverage_pct = round(report.quality.snapshots_full_cache_coverage / Math.max(1,report.quality.snapshots_with_sufficient_universe) * 100,3);
  report.per_sample = perSampleMetrics;
  report.outcome_metrics = {
    entire_historical_eligible_universe: summarizeRows(pooled.market),
    market_wide_light_pool_48: summarizeRows(pooled.light48),
    light_score_shortlist_12: summarizeRows(pooled.light12),
    recent_1h_momentum_shortlist_12: summarizeRows(pooled.momentum12),
    light_pool_vs_market: pairedDifferenceCI(perSampleMetrics.map(row=>({left:row.metrics.light48,right:row.metrics.market})),
      'left','right','hit5_mfe4h_rate',224199),
    light_shortlist_vs_momentum_shortlist: pairedDifferenceCI(perSampleMetrics.map(row=>({left:row.metrics.light12,right:row.metrics.momentum12})),
      'left','right','hit5_mfe4h_rate',824199),
    primary_metric: 'Percentage of selections whose maximum high within the next 4 hours is at least 5% above the signal-time close.',
    interpretation_note: 'Use paired per-snapshot differences and their 4-snapshot moving-block bootstrap intervals; pooled percentages are descriptive and may overweight symbols appearing in many snapshots.'
  };
  const poolCI = report.outcome_metrics.light_pool_vs_market.confidence_interval_95_percentage_points;
  const shortlistCI = report.outcome_metrics.light_shortlist_vs_momentum_shortlist.confidence_interval_95_percentage_points;
  const poolLiftPassed = Number.isFinite(poolCI?.lower) && poolCI.lower > 0;
  const shortlistLiftPassed = Number.isFinite(shortlistCI?.lower) && shortlistCI.lower > 0;
  const completeData = report.quality.lookahead_guard_passed === true &&
    report.quality.snapshots_with_sufficient_universe >= MIN_SAMPLE_COUNT &&
    report.quality.full_cache_coverage_pct >= 95;
  report.quality.prediction_evidence_gate = poolLiftPassed && shortlistLiftPassed ? 'PASS' : 'NOT_PROVEN';
  report.quality.data_integrity_gate = completeData ? 'PASS' : 'FAIL';
  report.quality.ready_for_merge = completeData && poolLiftPassed && shortlistLiftPassed;
  report.quality.rules = {
    minimum_sample_snapshots:MIN_SAMPLE_COUNT,
    minimum_market_coverage_ratio_pct:MIN_COVERAGE_RATIO * 100,
    require_lookahead_violations_zero:true,
    require_95pct_block_bootstrap_lower_bound_above_zero_for_both_primary_comparisons:true,
    primary_metric:'HIT_5PCT_MAX_UPSIDE_WITHIN_4H'
  };
  report.duration_seconds = round((Date.now() - startedAt) / 1000, 2);
  report.status = completeData ? (report.quality.ready_for_merge ? 'PREDICTIVE_EVIDENCE_PASS' : 'PREDICTIVE_EVIDENCE_NOT_PROVEN') : 'DATA_INTEGRITY_GATE_FAILED';
  report.finished_at_utc = new Date().toISOString();
  await mkdir(dirname(REPORT_PATH), {recursive:true});
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log('[MARKET_WIDE_LIGHT_OUTCOME_REPORT] ' + JSON.stringify({
    status:report.status,
    current_eligible:report.data.current_eligible_symbols,
    history_ready:report.data.history_ready_symbols,
    history_coverage_pct:report.data.history_ready_ratio_pct,
    snapshots:report.data.snapshot_count,
    snapshots_with_coverage:report.quality.snapshots_with_sufficient_universe,
    full_cache_coverage_pct:report.quality.full_cache_coverage_pct,
    lookahead_violations:report.quality.lookahead_violations,
    market_hit5_4h:report.outcome_metrics.entire_historical_eligible_universe.hit_5pct_upside_4h_pct,
    light48_hit5_4h:report.outcome_metrics.market_wide_light_pool_48.hit_5pct_upside_4h_pct,
    light48_lift_ci:report.outcome_metrics.light_pool_vs_market.confidence_interval_95_percentage_points,
    light12_hit5_4h:report.outcome_metrics.light_score_shortlist_12.hit_5pct_upside_4h_pct,
    momentum12_hit5_4h:report.outcome_metrics.recent_1h_momentum_shortlist_12.hit_5pct_upside_4h_pct,
    light12_vs_momentum_ci:report.outcome_metrics.light_shortlist_vs_momentum_shortlist.confidence_interval_95_percentage_points,
    prediction_evidence_gate:report.quality.prediction_evidence_gate,
    data_integrity_gate:report.quality.data_integrity_gate,
    ready_for_merge:report.quality.ready_for_merge,
    report_path:REPORT_PATH
  }));
  if (report.status === 'DATA_INTEGRITY_GATE_FAILED') process.exitCode = 1;
} catch (error) {
  report.status = 'FAILED';
  report.failure_reason = String(error?.message || error).slice(0, 500);
  report.duration_seconds = round((Date.now() - startedAt) / 1000, 2);
  report.finished_at_utc = new Date().toISOString();
  try {
    await mkdir(dirname(REPORT_PATH), {recursive:true});
    await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch {}
  console.error('[MARKET_WIDE_LIGHT_OUTCOME_FAILED] ' + report.failure_reason);
  process.exitCode = 1;
}
