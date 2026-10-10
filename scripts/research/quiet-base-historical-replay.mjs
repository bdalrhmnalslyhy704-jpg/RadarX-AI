#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { assessQuietBasePreExpansion, QUIET_BASE_PRE_EXPANSION_DEFAULTS } from '../../phase2/core/quiet-base-pre-expansion.mjs';

const OUT = path.resolve(process.env.REPLAY_OUT_DIR || 'artifacts/quiet-base-replay');
const INTERVAL_MS = 5 * 60_000;
const WINDOW_START_MS = Date.parse(process.env.REPLAY_START_UTC || '2026-09-15T00:00:00.000Z');
const MAX_COMPARISONS = Math.max(8, Math.min(48, Number(process.env.REPLAY_COMPARISON_SYMBOLS || 48)));
const MIN_SAMPLE_QUOTE_VOLUME = 750_000;
const API_BASES = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com'
];
const TARGETS = ['MAGICUSDT', 'KAIAUSDT'];
const STABLE_BASES = new Set([
  'USDT','USDC','BUSD','TUSD','FDUSD','USDP','DAI','EUR','EURT','USDE','USTC',
  'PYUSD','USDS','USD1','EURI','AEUR','UST','PAXG','RLUSD'
]);
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const iso = ms => Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null;
const csvCell = value => {
  const raw = value === null || value === undefined ? '' :
    (typeof value === 'object' ? JSON.stringify(value) : String(value));
  return '"' + raw.replaceAll('"', '""') + '"';
};
const toMs = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) >= 1e14) return Math.trunc(n / 1000); // Binance microseconds -> milliseconds
  if (Math.abs(n) >= 1e11) return Math.trunc(n);        // Binance milliseconds
  if (Math.abs(n) >= 1e9) return Math.trunc(n * 1000);  // epoch seconds, if a future source supplies them
  return null;
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(pathname, params = {}, label = pathname) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  const suffix = query.size ? '?' + query.toString() : '';
  const failures = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const offset = attempt;
    for (let hostIndex = 0; hostIndex < API_BASES.length; hostIndex++) {
      const host = API_BASES[(hostIndex + offset) % API_BASES.length];
      try {
        const response = await fetch(host + pathname + suffix, {
          headers: { accept: 'application/json', 'user-agent': 'RadarX-QuietBase-HistoricalReplay/1.0' },
          signal: AbortSignal.timeout(20_000)
        });
        if (!response.ok) {
          const body = (await response.text()).slice(0, 300);
          failures.push(host + ' HTTP ' + response.status + ' ' + body);
          if (response.status === 418 || response.status === 429) await wait(800 * (attempt + 1));
          continue;
        }
        const data = await response.json();
        return { data, source: host, requestedUrl: host + pathname + suffix };
      } catch (error) {
        failures.push(host + ' ' + String(error?.message || error));
      }
    }
    await wait(400 * (attempt + 1));
  }
  throw new Error('BINANCE_PUBLIC_DOWNLOAD_FAILED[' + label + ']: ' + failures.slice(-12).join(' | '));
}

function normalizeKline(raw, symbol, serverNow) {
  if (!Array.isArray(raw) || raw.length < 11) return null;
  const openTime = toMs(raw[0]);
  const closeTime = toMs(raw[6]);
  const values = raw.slice(1, 6).map(Number);
  const [open, high, low, close, volume] = values;
  const quoteVolume = Number(raw[7]);
  const tradeCount = Number(raw[8]);
  const takerBuyBaseVolume = Number(raw[9]);
  if (![openTime, closeTime, open, high, low, close, volume, quoteVolume, tradeCount, takerBuyBaseVolume].every(Number.isFinite)) return null;
  if (!(openTime < closeTime && open > 0 && high >= Math.max(open, close) && low > 0 &&
        low <= Math.min(open, close) && high >= low && close > 0 && volume >= 0 &&
        quoteVolume >= 0 && tradeCount >= 0 && takerBuyBaseVolume >= 0)) return null;
  return {
    symbol,
    openTime,
    closeTime,
    open,
    high,
    low,
    close,
    volume,
    quoteVolume,
    tradeCount,
    takerBuyBaseVolume,
    closed: closeTime < serverNow
  };
}

async function downloadBars(symbol, startMs, endMs, serverNow) {
  const all = [];
  let cursor = startMs;
  const pages = [];
  let source = null;
  while (cursor <= endMs) {
    const result = await fetchJson('/api/v3/klines', {
      symbol, interval: '5m', startTime: cursor, endTime: endMs, limit: 1000
    }, symbol + '/5m/from=' + cursor);
    source = result.source;
    const raw = result.data;
    if (!Array.isArray(raw)) throw new Error('BINANCE_KLINES_RESPONSE_NOT_ARRAY:' + symbol);
    pages.push({ source: result.source, first_open_raw: raw[0]?.[0] ?? null, last_open_raw: raw.at(-1)?.[0] ?? null, rows: raw.length });
    if (!raw.length) break;
    let latestOpen = null;
    for (const row of raw) {
      const bar = normalizeKline(row, symbol, serverNow);
      if (!bar) continue;
      all.push(bar);
      latestOpen = Math.max(latestOpen ?? 0, bar.openTime);
    }
    if (latestOpen === null || latestOpen < cursor) throw new Error('BINANCE_KLINES_PAGINATION_STALLED:' + symbol);
    cursor = latestOpen + INTERVAL_MS;
    if (raw.length < 1000) break;
    await wait(40);
  }
  const map = new Map();
  for (const bar of all) map.set(bar.openTime, bar);
  const bars = [...map.values()].sort((a, b) => a.openTime - b.openTime);
  return { bars, source, pages };
}

const evidenceFor = (result, key) => result?.evidence?.find(row => row.key === key) || null;
const hasPassed = (result, key) => evidenceFor(result, key)?.passed === true;
function coreBasePassed(result) {
  return [
    'narrow_price_base_range_pct',
    'atr_contraction_ratio',
    'bollinger_width_ratio',
    'higher_lows_or_stable_support',
    'resistance_proximity_pct'
  ].every(key => hasPassed(result, key));
}
function firstBlocker(result) {
  if (!result) return { key: null, value: null, threshold: null, reason: 'NO_RESULT' };
  const keys = result.classification === 'ALREADY_EXTENDED'
    ? ['anti_chase']
    : result.classification === 'DATA_INSUFFICIENT'
      ? result.evidence.filter(row => row.passed === false).map(row => row.key)
      : [
          'narrow_price_base_range_pct', 'atr_contraction_ratio', 'bollinger_width_ratio',
          'higher_lows_or_stable_support', 'resistance_proximity_pct',
          'gradual_volume_vs_same_coin', 'gradual_trades_vs_same_coin'
        ];
  const row = keys.map(key => evidenceFor(result, key)).find(item => item && item.passed === false);
  return row ? { key: row.key, value: row.value, threshold: row.threshold, reason: row.reason } :
    { key: null, value: null, threshold: null, reason: result.reason || 'NO_FAILED_EVIDENCE_RECORDED' };
}
function resultSnapshot(bars, index, fullFutureList = false, strictBaseline = false) {
  const current = bars[index];
  const asOf = current.closeTime + 1;
  const window = fullFutureList ? bars : bars.slice(Math.max(0, index - 179), index + 1);
  const ref = index >= 288 ? bars[index - 288] : null;
  const dailyChange = ref && ref.close > 0 ? (current.close / ref.close - 1) * 100 : null;
  const result = assessQuietBasePreExpansion({
    fiveMinute: window,
    ticker: { symbol: current.symbol, lastPrice: current.close, priceChange24h: dailyChange },
    now: asOf,
    dataReady: dailyChange !== null,
    dataIssues: dailyChange === null ? ['DAILY_CHANGE_UNKNOWN'] : [],
    config: strictBaseline ? { ...QUIET_BASE_PRE_EXPANSION_DEFAULTS, persistentTradeMinRecentVsBaseline: Number.POSITIVE_INFINITY } : QUIET_BASE_PRE_EXPANSION_DEFAULTS
  });
  return { result, asOf, dailyChange };
}
function movementMetrics(bars, index) {
  const current = bars[index];
  const hourRef = index >= 12 ? bars[index - 12] : null;
  const fourHourRef = index >= 48 ? bars[index - 48] : null;
  const move1h = hourRef?.close > 0 ? (current.close / hourRef.close - 1) * 100 : null;
  const move4h = fourHourRef?.close > 0 ? (current.close / fourHourRef.close - 1) * 100 : null;
  const prior48 = bars.slice(Math.max(0, index - 48), index);
  const low4h = prior48.length ? Math.min(...prior48.map(bar => bar.low)) : null;
  const abovePriorLow4h = low4h > 0 ? (current.close / low4h - 1) * 100 : null;
  return { move1hPct: move1h, move4hPct: move4h, abovePriorLow4hPct: abovePriorLow4h };
}
function firstFailedMovementLabel(bars, target = false) {
  const start = target ? Date.parse('2026-10-09T00:00:00.000Z') : WINDOW_START_MS;
  const end = target ? Date.parse('2026-10-11T00:00:00.000Z') : Infinity;
  for (let i = 288; i < bars.length; i++) {
    const at = bars[i].closeTime;
    if (at < start || at >= end) continue;
    const m = movementMetrics(bars, i);
    if ((m.move1hPct !== null && m.move1hPct >= 5) ||
        (m.move4hPct !== null && m.move4hPct >= 10)) {
      return {
        index: i,
        time_ms: at,
        time_utc: iso(at),
        price: bars[i].close,
        threshold_rule: 'FIRST_5M_CLOSE_WITH_1H_RETURN_GTE_5_PERCENT_OR_4H_RETURN_GTE_10_PERCENT',
        return_1h_pct: round(m.move1hPct),
        return_4h_pct: round(m.move4hPct)
      };
    }
  }
  return null;
}
function futureMfe4h(bars, index) {
  if (index + 48 >= bars.length) return null;
  const start = bars[index].close;
  const horizon = bars.slice(index + 1, index + 49);
  if (horizon.length !== 48) return null;
  for (let j = 1; j < horizon.length; j++) {
    if (horizon[j].openTime - horizon[j - 1].openTime !== INTERVAL_MS) return null;
  }
  return round((Math.max(...horizon.map(bar => bar.high)) / start - 1) * 100);
}
function futureMfe24h(bars, index) {
  if (index + 288 >= bars.length) return null;
  const start = bars[index].close;
  const horizon = bars.slice(index + 1, index + 289);
  if (horizon.length !== 288) return null;
  for (let j = 1; j < horizon.length; j++) {
    if (horizon[j].openTime - horizon[j - 1].openTime !== INTERVAL_MS) return null;
  }
  return round((Math.max(...horizon.map(bar => bar.high)) / start - 1) * 100);
}
function mfeLabel(value, horizon) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'UNLABELLED_INCOMPLETE_' + horizon;
  return Number(value) >= 5 ? 'RISE_MFE_' + horizon + '_GTE_5_PERCENT' : 'NO_RISE_MFE_' + horizon + '_LT_5_PERCENT';
}
function asCsv(rows, columns) {
  return [columns.map(csvCell).join(','), ...rows.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\n') + '\n';
}
async function saveGzip(filename, content) {
  await writeFile(filename, gzipSync(Buffer.from(content), { level: 9 }));
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const timestampNormalizationCases = [
    { unit: 'milliseconds', raw: 1791500400000, expected_ms: 1791500400000 },
    { unit: 'microseconds', raw: 1791500400000000, expected_ms: 1791500400000 },
    { unit: 'seconds', raw: 1791500400, expected_ms: 1791500400000 }
  ].map(item => ({ ...item, actual_ms: toMs(item.raw), pass: toMs(item.raw) === item.expected_ms }));
  if (timestampNormalizationCases.some(item => !item.pass)) throw new Error('TIMESTAMP_UNIT_NORMALIZATION_SELF_TEST_FAILED');
  const manifest = {
    status: 'STARTING',
    generated_at: new Date().toISOString(),
    source_policy: 'Binance public Spot REST raw /api/v3/klines interval=5m; no daily candles as detector input',
    timestamp_normalization: 'epoch microseconds >= 1e14 divided by 1000; milliseconds >= 1e11 retained; seconds >= 1e9 multiplied by 1000',
    timestamp_normalization_self_test: timestampNormalizationCases,
    window_start_utc: iso(WINDOW_START_MS),
    comparison_selection: 'Deterministic top quote-volume eligible Spot USDT assets from current Binance 24h ticker snapshot; targets MAGICUSDT and KAIAUSDT added explicitly; comparisons are exploratory and survivor-biased, not a random market sample',
    event_start_label_rule: 'First closed 5m bar in the target event day with prior 1h close-to-close return >=5% OR prior 4h return >=10%; diagnostic label only',
    quiet_outcome_rule: 'For each episode passing five core-base gates, label future outcome only (not a detector feature): max favorable high excursion over next 4h >=5% = quiet_then_rise; <5% = quiet_no_rise; incomplete 4h future = unlabelled',
    detector_thresholds: QUIET_BASE_PRE_EXPANSION_DEFAULTS,
    symbols: [],
    download_errors: [],
    future_leakage_checks: [],
    production_coverage_reference: {
      observed_eligible_per_cycle_range: [338, 339],
      observed_micro_candidates_per_cycle: 12,
      light_screen_candidates_per_cycle: 96,
      light_screen_fraction_of_eligible_pct: round(96 / 339 * 100, 3),
      light_rotation_slots_per_cycle: 88,
      theoretical_rotation_sweep_cycles: Math.ceil(339 / 88),
      observed_micro_candidates_per_cycle: 12,
      observed_deep_scans_per_cycle: 3,
      deep_scan_fraction_of_eligible_pct: round(3 / 339 * 100, 3)
    }
  };
  let serverNow;
  try {
    const response = await fetchJson('/api/v3/time', {}, 'server-time');
    serverNow = toMs(response.data?.serverTime);
    manifest.server_time_source = response.source;
  } catch (error) {
    manifest.status = 'DOWNLOAD_BLOCKED';
    manifest.download_errors.push({ stage: 'server_time', error: String(error?.message || error) });
    await writeFile(path.join(OUT, 'download-diagnostics.json'), JSON.stringify(manifest, null, 2));
    console.error('DOWNLOAD_BLOCKED: unable to obtain Binance public server time');
    process.exitCode = 2;
    return;
  }
  if (!Number.isFinite(serverNow)) throw new Error('BINANCE_SERVER_TIME_INVALID');

  let exchange, tickers, marketDataSource;
  try {
    const exchangeResponse = await fetchJson('/api/v3/exchangeInfo', {}, 'exchangeInfo');
    const tickerResponse = await fetchJson('/api/v3/ticker/24hr', {}, 'ticker-24hr');
    exchange = exchangeResponse.data;
    tickers = tickerResponse.data;
    marketDataSource = { exchange_info: exchangeResponse.source, ticker_24h: tickerResponse.source };
  } catch (error) {
    manifest.status = 'DOWNLOAD_BLOCKED';
    manifest.download_errors.push({ stage: 'universe_discovery', error: String(error?.message || error) });
    await writeFile(path.join(OUT, 'download-diagnostics.json'), JSON.stringify(manifest, null, 2));
    console.error('DOWNLOAD_BLOCKED: unable to discover Binance Spot universe: ' + String(error?.message || error));
    process.exitCode = 2;
    return;
  }
  const spotSymbols = new Map((exchange.symbols || [])
    .filter(item => item.status === 'TRADING' && item.quoteAsset === 'USDT' &&
      item.isSpotTradingAllowed !== false && !STABLE_BASES.has(item.baseAsset) &&
      !/(UP|DOWN|BULL|BEAR)USDT$/.test(item.symbol))
    .map(item => [item.symbol, item]));
  const tickerBySymbol = new Map((Array.isArray(tickers) ? tickers : [])
    .filter(item => spotSymbols.has(item.symbol) && Number(item.quoteVolume) >= MIN_SAMPLE_QUOTE_VOLUME)
    .map(item => [item.symbol, item]));
  const comparisons = [...tickerBySymbol.values()]
    .filter(item => !TARGETS.includes(item.symbol) && !['BTCUSDT','ETHUSDT'].includes(item.symbol))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, MAX_COMPARISONS)
    .map(item => item.symbol);
  const symbols = [...new Set([...TARGETS.filter(symbol => spotSymbols.has(symbol)), ...comparisons])];
  manifest.market_data_source = marketDataSource;
  manifest.server_time_utc = iso(serverNow);
  manifest.comparison_quote_volume_threshold = MIN_SAMPLE_QUOTE_VOLUME;
  manifest.comparison_symbols_requested = comparisons;
  manifest.symbols_requested = symbols;
  if (!symbols.includes('MAGICUSDT') || !symbols.includes('KAIAUSDT')) {
    manifest.status = 'TARGET_SYMBOL_NOT_TRADING_SPOT_USDT';
    manifest.download_errors.push({ stage: 'universe_discovery', error: 'MAGICUSDT or KAIAUSDT was not available as a TRADING Spot USDT pair at run time' });
    await writeFile(path.join(OUT, 'download-diagnostics.json'), JSON.stringify(manifest, null, 2));
    console.error('TARGET_SYMBOL_NOT_TRADING_SPOT_USDT');
    process.exitCode = 2;
    return;
  }

  const traces = [];
  const summaries = [];
  const allEpisodes = [];
  const allTransitions = [];
  for (const symbol of symbols) {
    console.log('[DOWNLOAD_START] ' + symbol);
    let downloaded;
    try {
      downloaded = await downloadBars(symbol, WINDOW_START_MS, serverNow, serverNow);
    } catch (error) {
      manifest.download_errors.push({ symbol, stage: 'klines_5m', error: String(error?.message || error) });
      manifest.symbols.push({ symbol, status: 'DOWNLOAD_FAILED', error: String(error?.message || error) });
      console.error('[DOWNLOAD_FAILED] ' + symbol + ' ' + String(error?.message || error));
      continue;
    }
    const allBars = downloaded.bars;
    const bars = allBars.filter(bar => bar.closed && bar.closeTime <= serverNow);
    const gaps = [];
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].openTime - bars[i - 1].openTime !== INTERVAL_MS) gaps.push({
        after: iso(bars[i - 1].openTime), before: iso(bars[i].openTime),
        gap_ms: bars[i].openTime - bars[i - 1].openTime
      });
    }
    await saveGzip(path.join(OUT, symbol + '-5m-raw.csv.gz'), asCsv(allBars, [
      'symbol','openTime','closeTime','open','high','low','close','volume','quoteVolume','tradeCount','takerBuyBaseVolume','closed'
    ]));
    const row = {
      symbol,
      status: bars.length >= 400 ? 'DOWNLOADED' : 'INSUFFICIENT_HISTORY',
      source: downloaded.source,
      pages: downloaded.pages,
      raw_rows: allBars.length,
      closed_rows: bars.length,
      first_closed_candle_utc: bars.length ? iso(bars[0].closeTime) : null,
      last_closed_candle_utc: bars.length ? iso(bars.at(-1).closeTime) : null,
      rows_with_timestamp_microseconds: downloaded.pages.filter(page => Number(page.first_open_raw) >= 1e14 || Number(page.last_open_raw) >= 1e14).length,
      gap_count: gaps.length,
      first_gaps: gaps.slice(0, 5)
    };
    manifest.symbols.push(row);
    if (bars.length < 400) continue;

    const assessments = [];
    const strictStageEpisodes = [];
    const temporalStageEpisodes = [];
    let previousStrictStage = null;
    let previousTemporalStage = null;
    let activeCoreEpisode = null;
    let previousCore = false;
    let previousExtended = false;
    let firstWatch = null;
    let firstPre = null;
    let blockerCounts = {};
    let strictBlockerCounts = {};
    let classCounts = {};
    let strictClassCounts = {};
    for (let i = 288; i < bars.length; i++) {
      const current = bars[i];
      const { result, asOf, dailyChange } = resultSnapshot(bars, i);
      const { result: strictResult } = resultSnapshot(bars, i, false, true);
      const m = movementMetrics(bars, i);
      const core = coreBasePassed(result);
      const blocker = firstBlocker(result);
      const strictBlocker = firstBlocker(strictResult);
      classCounts[result.classification] = (classCounts[result.classification] || 0) + 1;
      strictClassCounts[strictResult.classification] = (strictClassCounts[strictResult.classification] || 0) + 1;
      if (blocker.key) blockerCounts[blocker.key] = (blockerCounts[blocker.key] || 0) + 1;
      if (strictBlocker.key) strictBlockerCounts[strictBlocker.key] = (strictBlockerCounts[strictBlocker.key] || 0) + 1;
      if (result.classification === 'WATCH_EARLY' && !firstWatch) firstWatch = { time_utc: iso(current.closeTime), time_ms: current.closeTime, price: current.close, reason: result.reason, blocker };
      if (result.classification === 'PRE_EXPANSION' && !firstPre) firstPre = { time_utc: iso(current.closeTime), time_ms: current.closeTime, price: current.close, reason: result.reason, blocker };
      const watchOrPre = stage => stage === 'WATCH_EARLY' || stage === 'PRE_EXPANSION';
      const temporalStage = result.classification, strictStage = strictResult.classification;
      if (watchOrPre(temporalStage) && temporalStage !== previousTemporalStage) {
        const mfe4 = futureMfe4h(bars, i), mfe24 = futureMfe24h(bars, i);
        temporalStageEpisodes.push({symbol,stage:temporalStage,time_utc:iso(current.closeTime),time_ms:current.closeTime,
          price:current.close,reason:result.reason,first_blocker:blocker,temporal_promotion:result.metrics?.temporal_promotion===true,
          minutes_before_move_start:null,mfe_next_4h_pct_lookahead_only:mfe4,mfe_next_24h_pct_lookahead_only:mfe24,
          outcome_4h:mfeLabel(mfe4,'4H'),outcome_24h:mfeLabel(mfe24,'24H')});
      }
      if (watchOrPre(strictStage) && strictStage !== previousStrictStage) {
        const mfe4 = futureMfe4h(bars, i), mfe24 = futureMfe24h(bars, i);
        strictStageEpisodes.push({symbol,stage:strictStage,time_utc:iso(current.closeTime),time_ms:current.closeTime,
          price:current.close,reason:strictResult.reason,first_blocker:strictBlocker,
          mfe_next_4h_pct_lookahead_only:mfe4,mfe_next_24h_pct_lookahead_only:mfe24,
          outcome_4h:mfeLabel(mfe4,'4H'),outcome_24h:mfeLabel(mfe24,'24H')});
      }
      previousTemporalStage=temporalStage;
      previousStrictStage=strictStage;
      const evidence = result.evidence || [];
      const rowTrace = {
        symbol,
        candle_open_time_utc: iso(current.openTime),
        candle_close_time_utc: iso(current.closeTime),
        close_price: round(current.close, 10),
        daily_change_24h_pct: round(dailyChange, 4),
        move_1h_pct: round(m.move1hPct, 4),
        move_4h_pct: round(m.move4hPct, 4),
        classification: result.classification,
        reason: result.reason,
        strict_baseline_classification: strictResult.classification,
        strict_baseline_reason: strictResult.reason,
        temporal_promotion: result.metrics?.temporal_promotion===true,
        first_blocker_key: blocker.key,
        strict_baseline_first_blocker_key: strictBlocker.key,
        strict_baseline_first_blocker_value: strictBlocker.value,
        strict_baseline_first_blocker_threshold: strictBlocker.threshold,
        first_blocker_value: blocker.value,
        first_blocker_threshold: blocker.threshold,
        narrow_base_range_pct: result.metrics?.narrow_base_range_pct ?? null,
        atr_current: result.metrics?.atr_current ?? null,
        atr_baseline: result.metrics?.atr_baseline ?? null,
        atr_contraction_ratio: result.metrics?.atr_ratio ?? null,
        bollinger_width_pct: result.metrics?.bollinger_width_pct ?? null,
        bollinger_width_baseline_pct: result.metrics?.bollinger_width_baseline_pct ?? null,
        bollinger_width_ratio: result.metrics?.bollinger_width_ratio ?? null,
        higher_lows: result.metrics?.higher_lows ?? null,
        support_stable: result.metrics?.support_stable ?? null,
        support_undercut_pct: result.metrics?.support_undercut_pct ?? null,
        resistance_distance_pct: result.metrics?.resistance_distance_pct ?? null,
        volume_recent_vs_baseline: result.metrics?.volume_trend?.recent_vs_self_baseline ?? null,
        volume_middle_vs_oldest: result.metrics?.volume_trend?.middle_vs_oldest ?? null,
        volume_recent_vs_middle: result.metrics?.volume_trend?.recent_vs_middle ?? null,
        trades_recent_vs_baseline: result.metrics?.trades_trend?.recent_vs_self_baseline ?? null,
        trades_middle_vs_oldest: result.metrics?.trades_trend?.middle_vs_oldest ?? null,
        trades_recent_vs_middle: result.metrics?.trades_trend?.recent_vs_middle ?? null,
        flow_state: result.metrics?.flow_state ?? result.flow_state ?? null,
        core_base_passed: core,
        temporal_promotion: result.metrics?.temporal_promotion===true,
        outcome_mfe_next_4h_pct_lookahead_only: futureMfe4h(bars, i),
        outcome_mfe_next_24h_pct_lookahead_only: futureMfe24h(bars, i),
        candle_close_time_ms: result.candle_close_time_ms ?? current.closeTime,
        evidence_json: evidence
      };
      // Preserve every replay timestamp where a narrow base is present or the fingerprint changes the classification.
      const narrow = hasPassed(result, 'narrow_price_base_range_pct');
      if (narrow || ['WATCH_EARLY','PRE_EXPANSION','ALREADY_EXTENDED','DATA_INSUFFICIENT'].includes(result.classification)) traces.push(rowTrace);
      const candidate = {
        symbol,
        time_ms: current.closeTime,
        time_utc: iso(current.closeTime),
        price: current.close,
        classification: result.classification,
        reason: result.reason,
        core_base_passed: core,
        blocker,
        metrics: result.metrics,
        evidence,
        daily_change_24h_pct: round(dailyChange, 4),
        move_1h_pct: round(m.move1hPct, 4),
        move_4h_pct: round(m.move4hPct, 4),
        future_mfe_4h_pct_lookahead_only: futureMfe4h(bars, i)
      };
      if (core && (!previousCore || !activeCoreEpisode)) {
        activeCoreEpisode = {
          symbol,
          start_time_ms: current.closeTime,
          start_time_utc: iso(current.closeTime),
          start_price: current.close,
          classification_at_episode_start: result.classification,
          reason_at_episode_start: result.reason,
          first_blocker: blocker,
          metrics_at_episode_start: result.metrics,
          evidence_at_episode_start: evidence,
          future_mfe_4h_pct_lookahead_only: candidate.future_mfe_4h_pct_lookahead_only,
          future_mfe_24h_pct_lookahead_only: futureMfe24h(bars, i),
          outcome_label: candidate.future_mfe_4h_pct_lookahead_only === null ? 'UNLABELLED_INCOMPLETE_4H' :
            candidate.future_mfe_4h_pct_lookahead_only >= 5 ? 'QUIET_THEN_RISE_MFE_4H_GTE_5_PERCENT' : 'QUIET_NO_RISE_MFE_4H_LT_5_PERCENT',
          outcome_label_24h: mfeLabel(futureMfe24h(bars,i),'24H')
        };
        allEpisodes.push(activeCoreEpisode);
      }
      if (!core) activeCoreEpisode = null;
      if (result.classification === 'ALREADY_EXTENDED' && !previousExtended) {
        allTransitions.push({ symbol, time_ms: current.closeTime, time_utc: iso(current.closeTime), price: current.close, classification: 'ALREADY_EXTENDED', metrics: result.metrics, blocker });
      }
      previousExtended = result.classification === 'ALREADY_EXTENDED';
      previousCore = core;
      assessments.push({
        index: i, time_ms: current.closeTime, time_utc: iso(current.closeTime), price: current.close,
        result, strictResult, asOf, dailyChange, movement: m, core, blocker, strictBlocker, metrics: result.metrics
      });
    }

    const targetDay = TARGETS.includes(symbol);
    const moveStart = firstFailedMovementLabel(bars, targetDay);
    const eventStartMs = moveStart?.time_ms ?? null;
    const annotateStageDurations=(episodes,strict)=>{
      let cursor=0;
      for(const episode of episodes.filter(item=>item.symbol===symbol)){
        while(cursor<assessments.length&&assessments[cursor].time_ms<=episode.time_ms)cursor++;
        let endIndex=cursor;
        while(endIndex<assessments.length&&(strict?assessments[endIndex].strictResult.classification:assessments[endIndex].result.classification)===episode.stage)endIndex++;
        const endItem=endIndex<assessments.length?assessments[endIndex]:null;
        const endTime=endItem?.time_ms??assessments.at(-1)?.time_ms??episode.time_ms;
        episode.end_time_utc=iso(endTime);
        episode.duration_minutes=round(Math.max(0,endTime-episode.time_ms)/60_000,2);
        episode.ended_by_classification=endItem?(strict?endItem.strictResult.classification:endItem.result.classification):'REPLAY_WINDOW_END';
        episode.right_censored=!endItem;
        cursor=endIndex;
      }
    };
    annotateStageDurations(strictStageEpisodes,true);
    annotateStageDurations(temporalStageEpisodes,false);
    for(const episode of [...strictStageEpisodes,...temporalStageEpisodes].filter(item=>item.symbol===symbol)){
      episode.minutes_before_move_start=eventStartMs===null?null:round((eventStartMs-episode.time_ms)/60_000,2);
      episode.within_24h_before_move=eventStartMs!==null&&episode.time_ms>=eventStartMs-24*60*60_000&&episode.time_ms<=eventStartMs;
    }
    const signalBeforeEvent = (which, strictBaseline = false) => {
      if (eventStartMs === null) return null;
      const cutoff = eventStartMs - 24 * 60 * 60_000;
      const found = assessments.find(item => item.time_ms >= cutoff && item.time_ms <= eventStartMs &&
        (strictBaseline ? item.strictResult.classification : item.result.classification) === which);
      if(!found)return null;
      const observed = strictBaseline ? found.strictResult : found.result;
      const firstBlocker = strictBaseline ? found.strictBlocker : found.blocker;
      return {time_utc:found.time_utc,time_ms:found.time_ms,price:found.price,
        minutes_before_move_start:round((eventStartMs-found.time_ms)/60_000,2),
        episode_duration_minutes:(strictBaseline?strictStageEpisodes:temporalStageEpisodes).find(item=>item.symbol===symbol&&item.stage===which&&item.time_ms===found.time_ms)?.duration_minutes??null,
        episode_ended_by:(strictBaseline?strictStageEpisodes:temporalStageEpisodes).find(item=>item.symbol===symbol&&item.stage===which&&item.time_ms===found.time_ms)?.ended_by_classification??null,
        reason:observed.reason,first_blocker_if_any:firstBlocker,metrics:observed.metrics,evidence:observed.evidence,
        temporal_promotion:observed.metrics?.temporal_promotion===true};
    };
    const blockedPreEvent = eventStartMs === null ? [] : assessments.filter(item =>
      item.time_ms >= eventStartMs - 24 * 60 * 60_000 && item.time_ms < eventStartMs &&
      item.result.classification === 'NO_SIGNAL');
    const firstPreEventBlocker = blockedPreEvent[0] ? {
      time_utc: blockedPreEvent[0].time_utc,
      time_ms: blockedPreEvent[0].time_ms,
      blocker: blockedPreEvent[0].blocker,
      classification: blockedPreEvent[0].result.classification,
      reason: blockedPreEvent[0].result.reason,
      metrics: blockedPreEvent[0].result.metrics,
      evidence: blockedPreEvent[0].result.evidence
    } : null;
    const perCoinStageAfter=temporalStageEpisodes.filter(item=>item.symbol===symbol);
    const perCoinStageBefore=strictStageEpisodes.filter(item=>item.symbol===symbol);
    const countStageOutcomes=(items,stage,horizon,label)=>items.filter(item=>item.stage===stage&&item['outcome_'+horizon]===label).length;
    const stageStats=(items,counts)=>({
      watch_early_episodes:items.filter(item=>item.stage==='WATCH_EARLY').length,
      pre_expansion_episodes:items.filter(item=>item.stage==='PRE_EXPANSION').length,
      watch_no_rise_4h:countStageOutcomes(items,'WATCH_EARLY','4h','NO_RISE_MFE_4H_LT_5_PERCENT'),
      pre_no_rise_4h:countStageOutcomes(items,'PRE_EXPANSION','4h','NO_RISE_MFE_4H_LT_5_PERCENT'),
      watch_no_rise_24h:countStageOutcomes(items,'WATCH_EARLY','24h','NO_RISE_MFE_24H_LT_5_PERCENT'),
      pre_no_rise_24h:countStageOutcomes(items,'PRE_EXPANSION','24h','NO_RISE_MFE_24H_LT_5_PERCENT'),
      incomplete_4h:items.filter(item=>item.outcome_4h==='UNLABELLED_INCOMPLETE_4H').length,
      incomplete_24h:items.filter(item=>item.outcome_24h==='UNLABELLED_INCOMPLETE_24H').length,
      repeated_candle_rows_proxy:Math.max(0,(counts.WATCH_EARLY||0)+(counts.PRE_EXPANSION||0)-items.length)
    });
    const perCoinEpisodes = allEpisodes.filter(item => item.symbol === symbol);
    const preEventEpisodes = eventStartMs === null ? [] : perCoinEpisodes.filter(item =>
      item.start_time_ms >= eventStartMs - 24 * 60 * 60_000 && item.start_time_ms <= eventStartMs);
    const summary = {
      symbol,
      status: 'REPLAYED',
      raw_closed_candles: bars.length,
      candle_gaps: gaps.length,
      first_closed_candle_utc: iso(bars[0].closeTime),
      last_closed_candle_utc: iso(bars.at(-1).closeTime),
      first_event_threshold_crossing: moveStart,
      first_watch_early_in_replay: firstWatch,
      first_pre_expansion_in_replay: firstPre,
      first_watch_early_within_24h_before_event: signalBeforeEvent('WATCH_EARLY'),
      first_pre_expansion_within_24h_before_event: signalBeforeEvent('PRE_EXPANSION'),
      strict_baseline_first_watch_within_24h_before_event: signalBeforeEvent('WATCH_EARLY',true),
      strict_baseline_first_pre_expansion_within_24h_before_event: signalBeforeEvent('PRE_EXPANSION',true),
      first_no_signal_blocker_within_24h_before_event: firstPreEventBlocker,
      classifications: classCounts,
      strict_baseline_classifications: strictClassCounts,
      blocker_counts_per_5m_evaluation: blockerCounts,
      strict_baseline_blocker_counts_per_5m_evaluation: strictBlockerCounts,
      temporal_promotion_candles: assessments.filter(item=>item.result.metrics?.temporal_promotion===true).length,
      stage_episodes_before: stageStats(perCoinStageBefore,strictClassCounts),
      stage_episodes_after: stageStats(perCoinStageAfter,classCounts),
      quiet_core_base_episodes_total: perCoinEpisodes.length,
      quiet_core_base_episodes_before_event: preEventEpisodes.length,
      quiet_then_rise_episodes_4h: perCoinEpisodes.filter(item => item.outcome_label === 'QUIET_THEN_RISE_MFE_4H_GTE_5_PERCENT').length,
      quiet_no_rise_episodes_4h: perCoinEpisodes.filter(item => item.outcome_label === 'QUIET_NO_RISE_MFE_4H_LT_5_PERCENT').length,
      quiet_no_rise_episodes_24h: perCoinEpisodes.filter(item => item.outcome_label_24h === 'NO_RISE_MFE_24H_LT_5_PERCENT').length,
      episodes_without_complete_4h_outcome: perCoinEpisodes.filter(item => item.outcome_label === 'UNLABELLED_INCOMPLETE_4H').length,
      episodes_without_complete_24h_outcome: perCoinEpisodes.filter(item => item.outcome_label_24h === 'UNLABELLED_INCOMPLETE_24H').length,
      already_extended_transitions_total: allTransitions.filter(item => item.symbol === symbol).length,
      diagnostic_note: 'Classification uses only closed 5m bars at or before each replay timestamp. Future MFE is outcome labeling only and is never passed to the detector.'
    };
    summaries.push(summary);
    console.log('[SYMBOL_REPLAY_COMPLETE] ' + JSON.stringify({
      symbol, candles: bars.length, event_start: moveStart?.time_utc ?? null,
      watch: summary.first_watch_early_within_24h_before_event?.time_utc ?? null,
      pre: summary.first_pre_expansion_within_24h_before_event?.time_utc ?? null,
      quiet_episodes: summary.quiet_core_base_episodes_total,
      temporal_promotions: summary.temporal_promotion_candles,
      strict_pre: summary.strict_baseline_classifications.PRE_EXPANSION||0,
      after_pre: summary.classifications.PRE_EXPANSION||0,
      strict_watch: summary.strict_baseline_classifications.WATCH_EARLY||0,
      after_watch: summary.classifications.WATCH_EARLY||0,
      stage_episodes_before:summary.stage_episodes_before,stage_episodes_after:summary.stage_episodes_after,
      quiet_rise_4h: summary.quiet_then_rise_episodes_4h,
      quiet_no_rise_4h: summary.quiet_no_rise_episodes_4h,
      quiet_no_rise_24h: summary.quiet_no_rise_episodes_24h,
      blockers: summary.blocker_counts_per_5m_evaluation
    }));
    // A future-leakage invariance check: the exact same as-of window must yield the same verdict with future bars appended.
    if (bars.length > 600) {
      const sampleIndices = [...new Set([300, Math.min(600, bars.length - 1), Math.min(1800, bars.length - 1), Math.min(3500, bars.length - 1), bars.length - 2])]
        .filter(index => index >= 288 && index < bars.length - 1);
      for (const index of sampleIndices) {
        const windowStart = Math.max(0, index - 179);
        const pastOnly = bars.slice(windowStart, index + 1);
        const withFuture = bars.slice(windowStart);
        const dailyRef = bars[index - 288];
        const daily = (bars[index].close / dailyRef.close - 1) * 100;
        const a = assessQuietBasePreExpansion({
          fiveMinute: pastOnly,
          ticker: { symbol, lastPrice: bars[index].close, priceChange24h: daily },
          now: bars[index].closeTime + 1,
          dataReady: true, dataIssues: [],
          config: QUIET_BASE_PRE_EXPANSION_DEFAULTS
        });
        const b = assessQuietBasePreExpansion({
          fiveMinute: withFuture,
          ticker: { symbol, lastPrice: bars[index].close, priceChange24h: daily },
          now: bars[index].closeTime + 1,
          dataReady: true, dataIssues: [],
          config: QUIET_BASE_PRE_EXPANSION_DEFAULTS
        });
        const passed = a.classification === b.classification &&
          a.reason === b.reason &&
          a.candle_close_time_ms === b.candle_close_time_ms &&
          a.metrics?.last_closed_price === b.metrics?.last_closed_price;
        manifest.future_leakage_checks.push({
          symbol, as_of_utc: iso(bars[index].closeTime), pass: passed,
          past_only_classification: a.classification,
          with_future_appended_classification: b.classification,
          future_candles_excluded: b.metrics?.future_candles_excluded ?? null
        });
        if (!passed) manifest.download_errors.push({ symbol, stage: 'future_leakage_check', error: 'ASSESSMENT_CHANGED_WHEN_FUTURE_CANDLES_APPENDED' });
      }
    }
  }

  const episodeSummary = allEpisodes.reduce((summary, episode) => {
    summary[episode.outcome_label] = (summary[episode.outcome_label] || 0) + 1;
    summary[episode.outcome_label_24h] = (summary[episode.outcome_label_24h] || 0) + 1;
    return summary;
  }, {});
  const stageSummary = (items) => items.reduce((summary,item)=>{
    const key=item.stage+'_'+item.outcome_4h;summary[key]=(summary[key]||0)+1;
    const key24=item.stage+'_'+item.outcome_24h;summary[key24]=(summary[key24]||0)+1;
    if(item.temporal_promotion)summary.temporal_promotion_episodes=(summary.temporal_promotion_episodes||0)+1;
    return summary;
  },{});
  const stageEpisodesBeforeAfter={strict_baseline:stageSummary(strictStageEpisodes),temporal_path:stageSummary(temporalStageEpisodes),
    strict_baseline_total:strictStageEpisodes.length,temporal_path_total:temporalStageEpisodes.length,
    repeated_stage_candle_rows_proxy_before:strictClassCounts.WATCH_EARLY+strictClassCounts.PRE_EXPANSION-strictStageEpisodes.length,
    repeated_stage_candle_rows_proxy_after:classCounts.WATCH_EARLY+classCounts.PRE_EXPANSION-temporalStageEpisodes.length};
  const targetSummary = summaries.filter(item => TARGETS.includes(item.symbol));
  const symbolSummary = summaries.filter(item => !TARGETS.includes(item.symbol));
  const report = {
    status: manifest.download_errors.some(item => item.stage === 'klines_5m' || item.stage === 'future_leakage_check') ? 'PARTIAL_OR_FAILED' : 'COMPLETED',
    generated_at: new Date().toISOString(),
    server_time_utc: iso(serverNow),
    window_start_utc: iso(WINDOW_START_MS),
    window_end_utc: iso(serverNow),
    source: 'Binance public Spot REST raw 5m klines',
    current_market_selection: 'Current quote volume is used only to choose a finite comparison universe; it is not detector input and this creates survivor/selection bias.',
    simulation: {
      loop: 'Candle-by-candle; each decision gets at most the 180 candles ending at the simulated as-of candle, all closed at that timestamp.',
      daily_change_24h: 'Derived from the close 288 five-minute intervals earlier, not daily candles.',
      event_start: 'First closed candle during 2026-10-09 UTC for MAGIC/KAIA with a preceding 1h return >=5% or 4h return >=10%. This is a diagnostic move threshold, not an assertion of the exact first trade of the event.',
      quiet_outcome: 'A core-base episode is labeled only after looking forward 4h at raw 5m highs; future data is confined to outcome labeling.',
      comparison_universe: comparisons,
      comparisons_are_representative: false
    },
    production_coverage: manifest.production_coverage_reference,
    target_results: targetSummary,
    comparison_results: symbolSummary,
    core_base_episode_labels_4h_and_24h: episodeSummary,
    stage_episodes_before_after:stageEpisodesBeforeAfter,
    all_stage_episodes_before:strictStageEpisodes,
    all_stage_episodes_after:temporalStageEpisodes,
    all_core_base_episodes: allEpisodes,
    already_extended_transitions: allTransitions,
    future_leakage: {
      checks: manifest.future_leakage_checks.length,
      passed: manifest.future_leakage_checks.filter(item => item.pass).length,
      failed: manifest.future_leakage_checks.filter(item => !item.pass).length,
      rows: manifest.future_leakage_checks
    },
    downloads: manifest.symbols,
    download_errors: manifest.download_errors,
    changed_thresholds: false,
    production_changes: false,
    merged_or_deployed: false
  };
  const traceColumns = [
    'symbol','candle_open_time_utc','candle_close_time_utc','close_price','daily_change_24h_pct',
    'move_1h_pct','move_4h_pct','classification','reason','strict_baseline_classification','strict_baseline_reason','temporal_promotion',
    'outcome_mfe_next_24h_pct_lookahead_only','first_blocker_key','first_blocker_value','strict_baseline_first_blocker_key','strict_baseline_first_blocker_value','strict_baseline_first_blocker_threshold',
    'first_blocker_threshold','narrow_base_range_pct','atr_current','atr_baseline','atr_contraction_ratio',
    'bollinger_width_pct','bollinger_width_baseline_pct','bollinger_width_ratio','higher_lows','support_stable',
    'support_undercut_pct','resistance_distance_pct','volume_recent_vs_baseline','volume_middle_vs_oldest',
    'volume_recent_vs_middle','trades_recent_vs_baseline','trades_middle_vs_oldest','trades_recent_vs_middle',
    'flow_state','core_base_passed','outcome_mfe_next_4h_pct_lookahead_only','candle_close_time_ms','evidence_json'
  ];
  await saveGzip(path.join(OUT, 'candidate-candle-trace.csv.gz'), asCsv(traces, traceColumns));
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const md = [];
  md.push('# QUIET_BASE_PRE_EXPANSION — Binance Spot 5m Historical Replay');
  md.push('');
  md.push('Status: ' + report.status);
  md.push('Generated: ' + report.generated_at);
  md.push('Window: ' + report.window_start_utc + ' through ' + report.window_end_utc);
  md.push('Source: Binance public Spot REST raw 5m klines');
  md.push('');
  md.push('## Important method limits');
  md.push('- Detector input contains only closed five-minute candles at each simulated timestamp.');
  md.push('- Outcome look-ahead is labeled explicitly and is not used as a detector feature.');
  md.push('- The comparison set is selected algorithmically from a current Binance 24h ticker snapshot; it is not a representative unbiased universe.');
  md.push('- No thresholds, production files, schedules, API, UI, APK, or Radar 9 were changed by this diagnostic run.');
  md.push('');
  md.push('## Production coverage reference and proposed light lane');
  md.push('| Metric | Before | Proposed after (diagnostic branch only) |');
  md.push('|---|---:|---:|');
  md.push('| Eligible assets per cycle (observed) | 338–339 | 338–339 |');
  md.push('| Quiet-base light candidates per cycle | 0 | ' + manifest.production_coverage_reference.light_screen_candidates_per_cycle + ' |');
  md.push('| Light screen / eligible | 0% | ' + manifest.production_coverage_reference.light_screen_fraction_of_eligible_pct + '% |');
  md.push('| Full micro scans per cycle | 12 | 12 (unchanged) |');
  md.push('| Deep scans per cycle | 3 | 3 (unchanged) |');
  md.push('| Deep scan / eligible | ' + manifest.production_coverage_reference.deep_scan_fraction_of_eligible_pct + '% | ' + manifest.production_coverage_reference.deep_scan_fraction_of_eligible_pct + '% |');
  md.push('| Theoretical light rotation sweep | Not available | ' + manifest.production_coverage_reference.theoretical_rotation_sweep_cycles + ' cycles for 339 symbols; actual time depends on cycle duration |');
  md.push('');
  md.push('## Strict baseline vs temporal path');
  md.push('| Symbol | Strict WATCH candles | New WATCH candles | Strict PRE candles | New PRE candles | Temporal promotions |');
  md.push('|---|---:|---:|---:|---:|---:|');
  for(const item of summaries)md.push('| '+item.symbol+' | '+(item.strict_baseline_classifications.WATCH_EARLY||0)+' | '+(item.classifications.WATCH_EARLY||0)+' | '+(item.strict_baseline_classifications.PRE_EXPANSION||0)+' | '+(item.classifications.PRE_EXPANSION||0)+' | '+item.temporal_promotion_candles+' |');
  md.push('');
  md.push('## Stage outcome caveat');
  md.push('Stage rows are grouped into consecutive classification episodes (new WATCH/PRE only when stage changes); repeated per-candle rows are a repetition proxy, not actual push notifications. MFE outcomes inspect future highs only after the signal time and are not detector inputs. The 24h horizon is incomplete for the latest 288 candles.');
  md.push('');
  md.push('## Per-symbol replay');
  md.push('| Symbol | Candle count | First move threshold | WATCH before move | PRE before move | Core-base episodes | Quiet-then-rise 4h | Quiet-no-rise 4h | Quiet-no-rise 24h |');
  md.push('|---|---:|---|---|---|---:|---:|---:|---:|');
  for (const item of summaries) md.push('| ' + item.symbol + ' | ' + item.raw_closed_candles + ' | ' +
    (item.first_event_threshold_crossing?.time_utc || 'not observed') + ' | ' +
    (item.first_watch_early_within_24h_before_event?.time_utc || 'none') + ' | ' +
    (item.first_pre_expansion_within_24h_before_event?.time_utc || 'none') + ' | ' +
    item.quiet_core_base_episodes_total + ' | ' + item.quiet_then_rise_episodes_4h + ' | ' + item.quiet_no_rise_episodes_4h + ' | ' + item.quiet_no_rise_episodes_24h + ' |');
  md.push('');
  md.push('## Failure/coverage diagnosis');
  md.push('See report.json for strict-before/temporal-after stage counts, episode outcome labels at 4h and 24h, first blockers, evidence ratios, scan coverage, source endpoints, gaps, and future-leakage checks. candidate-candle-trace.csv.gz contains the per-candidate candle trace; future MFE fields are outcome labels only.');
  md.push('');
  md.push('## Download failures');
  md.push(manifest.download_errors.length ? JSON.stringify(manifest.download_errors, null, 2) : 'None.');
  md.push('');
  md.push('## Future leakage');
  md.push('Checks: ' + report.future_leakage.passed + '/' + report.future_leakage.checks + ' passed; failed=' + report.future_leakage.failed + '.');
  await writeFile(path.join(OUT, 'report.md'), md.join('\n') + '\n');
  manifest.status = report.status;
  manifest.completed_at = new Date().toISOString();
  manifest.closed_candle_count_total = manifest.symbols.reduce((sum, item) => sum + (Number(item.closed_rows) || 0), 0);
  manifest.replay_candidate_trace_rows = traces.length;
  manifest.core_base_episodes = allEpisodes.length;
  await writeFile(path.join(OUT, 'download-diagnostics.json'), JSON.stringify(manifest, null, 2));

  console.log('[REPLAY_REPORT_WRITTEN] ' + JSON.stringify({
    status: report.status,
    symbols_requested: symbols.length,
    symbols_replayed: summaries.length,
    raw_closed_candles: manifest.closed_candle_count_total,
    comparison_symbols: comparisons,
    core_base_episodes: allEpisodes.length,
    episode_labels: episodeSummary,
    trace_rows: traces.length,
    future_leakage_passed: report.future_leakage.passed,
    future_leakage_failed: report.future_leakage.failed,
    download_errors: manifest.download_errors.length,
    report_path: path.join(OUT, 'report.md')
  }));
  if (manifest.download_errors.some(item => item.stage === 'klines_5m' || item.stage === 'future_leakage_check') ||
      !summaries.some(item => item.symbol === 'MAGICUSDT') ||
      !summaries.some(item => item.symbol === 'KAIAUSDT') ||
      report.future_leakage.failed > 0) {
    process.exitCode = 2;
  }
}

main().catch(async error => {
  console.error('[REPLAY_FATAL] ' + String(error?.stack || error));
  try {
    await mkdir(OUT, { recursive: true });
    await writeFile(path.join(OUT, 'fatal-error.txt'), String(error?.stack || error) + '\n');
  } catch {}
  process.exitCode = 2;
});
