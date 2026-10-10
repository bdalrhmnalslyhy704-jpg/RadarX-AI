import {AsyncLocalStorage} from 'node:async_hooks';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

process.env.RADARX_ENV = 'shadow';
process.env.NODE_ENV = 'test';
process.env.RADARX_RADARS_AUTOSTART = 'false';
process.env.RADARX_EARLY_EXPANSION_MIN_QUOTE_VOLUME_24H = '750000';
process.env.RADARX_EARLY_EXPANSION_MICRO_SCAN_CANDIDATES = '12';
process.env.RADARX_EARLY_EXPANSION_DEEP_CANDIDATES = '3';

const repo = process.cwd();
const baselineDir = resolve(process.argv[2] || '../baseline');
const outputPath = process.env.RADARX_SHADOW_OUTPUT || join(tmpdir(), 'pr199-shadow-report.json');
const safeParent = resolve(process.env.RADARX_SHADOW_DATA_ROOT || process.env.RUNNER_TEMP || tmpdir());
if (safeParent === '/data' || safeParent.startsWith('/data' + sep)) throw new Error('SHADOW_DATA_DIR_MUST_NOT_USE_PRODUCTION_VOLUME');
const runDataDir = await mkdtemp(join(safeParent, 'radarx-pr199-shadow-'));
if (runDataDir === '/data' || runDataDir.startsWith('/data' + sep)) throw new Error('PRODUCTION_VOLUME_PATH_REJECTED');
await mkdir(runDataDir, {recursive: true});

const variants = {
  baseline: {dir: baselineDir, label: 'Build 224 baseline'},
  pr199: {dir: repo, label: 'PR #199 shadow'}
};
const activity = Object.fromEntries(Object.keys(variants).map(key => [key, {
  httpAttempts: 0, httpSuccess: 0, httpFailure: 0, httpErrors: {},
  httpPaths: {}, httpStatuses: {}, wsMessages: 0, wsConnectedMessages: 0,
  unattributedHttp: 0, warnings: []
}]));
const als = new AsyncLocalStorage();
const nativeFetch = globalThis.fetch;
globalThis.fetch = async function(input, init) {
  let url;
  try {
    url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  } catch {
    return nativeFetch(input, init);
  }
  const isBinance = /(^|\.)binance\.(com|vision)$/i.test(url.hostname);
  const context = als.getStore();
  if (!isBinance) return nativeFetch(input, init);
  const name = context?.variant;
  const stat = activity[name] || null;
  if (stat) {
    stat.httpAttempts++;
    stat.httpPaths[url.pathname] = (stat.httpPaths[url.pathname] || 0) + 1;
  } else {
    for (const row of Object.values(activity)) row.unattributedHttp++;
  }
  try {
    const response = await nativeFetch(input, init);
    if (stat) {
      if (response.ok) stat.httpSuccess++; else stat.httpFailure++;
      const status = String(response.status);
      stat.httpStatuses[status] = (stat.httpStatuses[status] || 0) + 1;
      const weight = response.headers?.get?.('x-mbx-used-weight-1m');
      if (weight !== null && weight !== undefined) stat.observedWeight1m = Number(weight);
    }
    return response;
  } catch (error) {
    if (stat) {
      stat.httpFailure++;
      const message = String(error?.name || 'FETCH_ERROR') + ':' + String(error?.message || error);
      stat.httpErrors[message] = (stat.httpErrors[message] || 0) + 1;
    }
    throw error;
  }
};

function urlFor(dir, path) {
  return pathToFileURL(resolve(dir, path)).href;
}
function makeLogger(name, state) {
  const record = (level, args) => {
    const line = args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ');
    if (level !== 'info') {
      const bucket = activity[name].warnings;
      if (bucket.length < 300) bucket.push({level, message: line.slice(0, 500)});
    }
    const schedulerPrefix = '[RADARX_SCHEDULER_REPORT] ';
    if (line.includes(schedulerPrefix)) {
      try { state.lastScheduler = JSON.parse(line.slice(line.indexOf(schedulerPrefix) + schedulerPrefix.length)); } catch {}
    }
    const scanPrefix = '[RADARX_SCAN_COMPLETE] ';
    if (line.includes(scanPrefix)) {
      try { state.lastScanLog = JSON.parse(line.slice(line.indexOf(scanPrefix) + scanPrefix.length)); } catch {}
    }
  };
  return {
    info: (...args) => record('info', args),
    warn: (...args) => record('warn', args),
    error: (...args) => record('error', args),
    debug: () => {}
  };
}
function snapshotCounters(name) {
  const a = activity[name];
  return {httpAttempts: a.httpAttempts, httpSuccess: a.httpSuccess, httpFailure: a.httpFailure, wsMessages: a.wsMessages};
}
function counterDelta(after, before) {
  return {
    http_attempts: after.httpAttempts - before.httpAttempts,
    http_success: after.httpSuccess - before.httpSuccess,
    http_failure: after.httpFailure - before.httpFailure,
    websocket_messages: after.wsMessages - before.wsMessages
  };
}
function topCounts(values, limit = 8) {
  const counts = {};
  for (const raw of values) {
    const key = String(raw || 'UNKNOWN');
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
    .map(([reason, count]) => ({reason, count}));
}
function countBands(candidates = []) {
  const bands = {};
  for (const item of Array.isArray(candidates) ? candidates : []) {
    const band = String(item?.pre_expansion_stage || item?.decision_band || 'UNKNOWN');
    bands[band] = (bands[band] || 0) + 1;
  }
  return bands;
}
function safeArray(value) { return Array.isArray(value) ? value : []; }
function mean(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, item) => sum + item, 0) / numbers.length : null;
}
function percentile(values, p) {
  const xs = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))];
}
function summarizeNumeric(rows, path) {
  const values = rows.map(row => path.split('.').reduce((value, key) => value?.[key], row)).filter(Number.isFinite);
  return {count: values.length, mean: mean(values), median: percentile(values, 0.5), p95: percentile(values, 0.95), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null};
}

async function createRuntime(name, dir) {
  const configMod = await import(urlFor(dir, 'phase2/config.mjs'));
  const restMod = await import(urlFor(dir, 'phase2/market/binance-rest.mjs'));
  const storeMod = await import(urlFor(dir, 'phase2/core/store.mjs'));
  const radarMod = await import(urlFor(dir, 'phase2/core/early-expansion-radar.mjs'));
  const cacheMod = await import(urlFor(dir, 'phase2/market/market-wide-kline-cache.mjs')).catch(() => ({}));
  const configRoot = configMod.CONFIG;
  const radarConfig = {
    ...configRoot.earlyExpansionRadar,
    quote: 'USDT',
    minQuoteVolume24h: 750000,
    pollMs: 45000,
    microScanCandidates: 12,
    deepCandidates: 3,
    microConcurrency: 6,
    deepConcurrency: 4
  };
  const rest = new restMod.RestClient({...configRoot.rest, baseUrls: configRoot.rest.urls, timeoutMs: 7000, maxRequestsPerMinute: 240});
  const storeDir = join(runDataDir, name);
  await mkdir(storeDir, {recursive: true});
  if (storeDir === '/data' || storeDir.startsWith('/data' + sep)) throw new Error('STORE_PATH_MUST_NOT_USE_PRODUCTION_VOLUME');
  const store = await new storeMod.DurableStore({dir: storeDir}).init({legacyDir: null});
  const state = {
    name, label: variants[name].label, dir, rest, store, radar: null,
    lastLight: null, lastMicroSymbols: [], lastMicroLanes: {}, lastMicroInputSymbols: [],
    lastScheduler: null, lastScanLog: null, lastJourney: null, lastError: null,
    lastCycleBands: {}, lastCycleAlerts: 0, lastLightReasons: [], lastPoolReasons: {},
    cache: null, config: radarConfig
  };
  const logger = makeLogger(name, state);
  const classConfig = {...radarConfig};
  const pass = {rest, store, pushManager: null, config: classConfig, logger};
  if (typeof cacheMod.MarketWideKlineCache === 'function') {
    const requireFromDir = createRequire(resolve(dir, 'package.json'));
    const WS = requireFromDir('ws');
    class CountingWebSocket extends WS {
      on(event, listener) {
        if (event === 'message') {
          return super.on(event, function(...args) {
            activity[name].wsMessages++;
            return listener.apply(this, args);
          });
        }
        return super.on(event, listener);
      }
    }
    const cache = new cacheMod.MarketWideKlineCache({
      rest,
      urls: configRoot.websocket.urls,
      WebSocketImpl: CountingWebSocket,
      initialBackoffMs: 1000,
      maxBackoffMs: 10000,
      jitterRatio: 0.1,
      heartbeatTimeoutMs: 30000,
      maxConnectionMs: 60 * 60 * 1000,
      maxSymbols: 1024,
      logger
    });
    pass.marketWideKlineCache = cache;
    state.cache = cache;
  }
  const radar = new radarMod.EarlyExpansionRadar(pass);
  // Enable tick() without start(), so no overlapping scheduler timer is created.
  radar.running = true;
  state.radar = radar;
  if (radar.marketWideLightScan?.scan) {
    const scan = radar.marketWideLightScan.scan.bind(radar.marketWideLightScan);
    radar.marketWideLightScan.scan = options => {
      const result = scan(options);
      state.lastLight = result;
      state.lastLightReasons = safeArray([...result.audit.values()]).filter(item => item?.result === 'DATA_INSUFFICIENT')
        .map(item => item?.reason || item?.rejection_reason || 'DATA_INSUFFICIENT');
      state.lastPoolReasons = {};
      for (const selected of safeArray(result.selected)) {
        const reason = String(selected.selectionReason || 'UNKNOWN');
        state.lastPoolReasons[reason] = (state.lastPoolReasons[reason] || 0) + 1;
      }
      return result;
    };
  }
  const selectMicro = radar.selectMicro.bind(radar);
  radar.selectMicro = (rows, fastBySymbol, cycle) => {
    state.lastMicroInputSymbols = safeArray(rows).map(item => String(item?.symbol || '')).filter(Boolean);
    const selected = selectMicro(rows, fastBySymbol, cycle);
    state.lastMicroSymbols = selected.map(item => String(item?.symbol || '')).filter(Boolean);
    state.lastMicroLanes = {};
    for (const item of selected) {
      const lane = String(item?._selection_lane || 'unknown');
      state.lastMicroLanes[lane] = (state.lastMicroLanes[lane] || 0) + 1;
    }
    return selected;
  };
  if (typeof store.appendScanJourneyCycle === 'function') {
    const append = store.appendScanJourneyCycle.bind(store);
    store.appendScanJourneyCycle = async (...args) => {
      state.lastJourney = args[0] || null;
      return append(...args);
    };
  }
  return state;
}

async function runOne(state) {
  state.lastLight = null;
  state.lastMicroSymbols = [];
  state.lastMicroLanes = {};
  state.lastMicroInputSymbols = [];
  state.lastScheduler = null;
  state.lastScanLog = null;
  state.lastJourney = null;
  const before = snapshotCounters(state.name);
  const started = Date.now();
  let tickError = null;
  try {
    await als.run({variant: state.name}, () => state.radar.tick());
  } catch (error) {
    tickError = String(error?.message || error);
    state.lastError = tickError;
  }
  const ended = Date.now();
  const after = snapshotCounters(state.name);
  const coverage = state.radar.lastCoverage || {};
  const light = state.lastLight?.summary || null;
  const cacheHealth = state.cache?.health?.() || null;
  const candidates = safeArray(state.radar.lastResult?.candidates || state.radar.latestCandidates);
  const staleReasons = state.lastLightReasons;
  const allLightRows = state.lastLight ? [...state.lastLight.audit.values()] : [];
  const rejectionReasons = state.lastLight
    ? allLightRows.filter(item => item?.candidate !== true).map(item => item?.rejection_reason || item?.reason || 'NO_LIGHT_CANDIDATE')
    : safeArray(state.lastJourney?.entries || state.lastJourney?.symbols || []).map(item => item?.rejection_reason || 'UNKNOWN');
  const bands = countBands(candidates);
  const scheduler = state.lastScheduler || {};
  const microSymbols = state.lastMicroSymbols;
  const deepSymbols = safeArray(scheduler.deep_symbols);
  const newSummary = {
    variant: state.name,
    elapsed_ms: Math.max(0, ended - started),
    tick_error: tickError,
    eligible_total: Number(coverage.eligible_total) || 0,
    expected_tickers: Number(coverage.expected_total) || 0,
    received_tickers: Number(coverage.received_total) || 0,
    missing_tickers: Number(coverage.missing_ticker_total) || 0,
    light_scan_symbols: light ? Number(light.eligible_total) || 0 : 0,
    light_fresh_valid: light ? Number(light.evaluated_total) || 0 : 0,
    light_cache_warmup_or_fallback: light ? Number(light.not_evaluated_total) || 0 : 0,
    light_stale: light ? Number(light.stale_total) || 0 : 0,
    light_invalid_or_gaps: light ? Number(light.invalid_total) || 0 : 0,
    light_future_excluded: allLightRows.reduce((sum, item) => sum + Number(item?.future_candles_excluded || 0), 0),
    light_duplicate_symbols: light ? Number(light.duplicate_symbol_total) || 0 : 0,
    candidate_pool_48_total: light ? Number(light.micro_candidate_pool_total) || 0 : null,
    cache_coverage_ready: light ? light.cache_coverage_ready === true : null,
    micro_pool_applied: light ? light.micro_pool_applied === true : null,
    light_selection_mode: light?.selection_mode || null,
    light_selected_reason_counts: state.lastPoolReasons,
    configured_rotation_reserve: light ? Number(light.rotation_reserve_configured) || 0 : null,
    exceptional_preserved: light ? Number(light.exceptional_preserved_total) || 0 : null,
    fair_rotation_candidate_share: light && Number(light.micro_candidate_pool_total) > 0
      ? Number(((Number(state.lastPoolReasons.FAIR_ROTATION_VALID_DATA || 0) + Number(state.lastPoolReasons.FAIR_ROTATION_CACHE_WARMUP || 0)) / Number(light.micro_candidate_pool_total)).toFixed(4)) : null,
    micro_input_total: state.lastMicroInputSymbols.length,
    micro_reached_total: Number(coverage.micro_scanned_total) || microSymbols.length,
    micro_selected_total: microSymbols.length,
    micro_selected_symbols: microSymbols,
    micro_lane_counts: state.lastMicroLanes,
    deep_reached_total: Number(coverage.deep_scanned_total) || deepSymbols.length,
    deep_selected_symbols: deepSymbols,
    micro_duplicate_selected: microSymbols.length - new Set(microSymbols).size,
    deep_duplicate_selected: deepSymbols.length - new Set(deepSymbols).size,
    deep_candidates_total: candidates.length,
    deep_final_band_counts: bands,
    pre_expansion_total: Number(bands.PRE_EXPANSION || 0),
    watch_early_total: Number(bands.WATCH_EARLY || 0),
    breakout_developing_total: Number(bands.BREAKOUT_DEVELOPING || 0),
    alerts_emitted: Number(state.radar.lastResult?.alerts_emitted_this_cycle) || 0,
    reject_reasons_top: topCounts(rejectionReasons),
    light_invalid_reasons_top: topCounts(staleReasons),
    failed_total: Number(coverage.failed_total) || 0,
    scan_duration_ms: Number(coverage.scan_duration_ms ?? state.lastScanLog?.scan_duration_ms) || Math.max(0, ended - started),
    phase_timings_ms: coverage.phase_timings_ms || state.lastScanLog?.phase_timings_ms || {},
    market_wide_rest_calls_added_by_light: Number(light?.binance_rest_calls_added_by_light_scan) || 0,
    cache_health: cacheHealth,
    actual_http: counterDelta(after, before),
    actual_http_paths_this_cycle: Object.fromEntries(Object.entries(activity[state.name].httpPaths).map(([key, value]) => [key, value])),
    http_status_totals: activity[state.name].httpStatuses,
    radar_error: state.radar.lastError || state.lastError || null
  };
  return newSummary;
}

async function runPair(phase, cycle) {
  const [base, pr] = await Promise.all([runOne(runtimes.baseline), runOne(runtimes.pr199)]);
  const baseSet = new Set(base.micro_selected_symbols);
  const prSet = new Set(pr.micro_selected_symbols);
  const baseDeepSet = new Set(base.deep_selected_symbols);
  const prDeepSet = new Set(pr.deep_selected_symbols);
  const newlyReachedMicro = [...prSet].filter(symbol => !baseSet.has(symbol));
  const newlyReachedDeep = [...prDeepSet].filter(symbol => !baseDeepSet.has(symbol));
  return {
    phase, cycle, started_at: new Date(Date.now() - Math.max(base.elapsed_ms, pr.elapsed_ms)).toISOString(),
    completed_at: new Date().toISOString(),
    baseline: base, pr199: pr,
    comparison: {
      eligible_delta: pr.eligible_total - base.eligible_total,
      micro_new_vs_baseline: newlyReachedMicro.length,
      micro_new_symbols: newlyReachedMicro,
      deep_new_vs_baseline: newlyReachedDeep.length,
      deep_new_symbols: newlyReachedDeep,
      micro_overlap: [...prSet].filter(symbol => baseSet.has(symbol)).length,
      deep_overlap: [...prDeepSet].filter(symbol => baseDeepSet.has(symbol)).length,
      cycle_duration_delta_ms: pr.scan_duration_ms - base.scan_duration_ms,
      actual_http_delta: pr.actual_http.http_attempts - base.actual_http.http_attempts
    }
  };
}

const runtimes = {
  baseline: await createRuntime('baseline', baselineDir),
  pr199: await createRuntime('pr199', repo)
};
const report = {
  schema: 'RADARX_PR199_LIVE_SHADOW_V1',
  created_at: new Date().toISOString(),
  repository: 'bdalrhmnalslyhy704-jpg/RadarX-AI',
  pr: 199,
  pr_head_sha: '3ac4f0ba5d811ab56f74bda0c9a267c9a976aa31',
  baseline_ref: '791f464720ec69357b910b211229358456fd1d6b',
  execution_mode: 'isolated_GitHub_runner_shadow_no_Railway_no_production_volume_no_push_delivery',
  data_root: runDataDir,
  market: {quote: 'USDT', min_quote_volume_24h: 750000, micro_capacity: 12, deep_capacity: 3},
  pacing: {configured_poll_ms: 45000, shadow_minimum_cycle_spacing_ms: 5000, note: 'Ticks are called directly in an isolated process; if this cadence differs from the configured 45-second cadence, cycle timing and request-per-minute results must be interpreted accordingly.'},
  warmup: {max_cycles: 60, completed: false, cycles: []},
  measurement: {target_cycles: 30, completed_cycles: [], started_at: null, completed_at: null},
  run_result: 'RUNNING'
};

let warmupReady = false;
let warmupReason = 'CACHE_COVERAGE_NOT_READY';
for (let i = 1; i <= report.warmup.max_cycles; i++) {
  const pair = await runPair('WARMUP', i);
  report.warmup.cycles.push(pair);
  const light = runtimes.pr199.lastLight?.summary;
  const eligible = Number(light?.eligible_total || 0);
  const evaluated = Number(light?.evaluated_total || 0);
  if (eligible > 0 && evaluated === eligible && light?.cache_coverage_ready === true && light?.micro_pool_applied === true) {
    warmupReady = true;
    warmupReason = 'CACHE_WARMED_AND_LIGHT_POOL_APPLIED';
    report.warmup.completed = true;
    report.warmup.completed_at = new Date().toISOString();
    report.warmup.cycles_to_ready = i;
    break;
  }
  if (pair.pr199.tick_error || pair.pr199.eligible_total === 0) {
    warmupReason = pair.pr199.tick_error || 'NO_ELIGIBLE_MARKET_DATA';
    break;
  }
}
report.warmup.reason = warmupReason;
report.warmup.cache_health = runtimes.pr199.cache?.health?.() || null;
report.warmup.eligible_last_cycle = runtimes.pr199.radar.lastCoverage?.eligible_total || 0;
report.warmup.fresh_valid_last_cycle = runtimes.pr199.lastLight?.summary?.evaluated_total || 0;

if (warmupReady) {
  report.measurement.started_at = new Date().toISOString();
  for (let i = 1; i <= report.measurement.target_cycles; i++) {
    const pairStarted = Date.now();
    const pair = await runPair('MEASUREMENT', i);
    report.measurement.completed_cycles.push(pair);
    const elapsed = Date.now() - pairStarted;
    if (i < report.measurement.target_cycles && elapsed < 5000) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5000 - elapsed));
    }
  }
  report.measurement.completed_at = new Date().toISOString();
  report.run_result = 'MEASUREMENT_COMPLETE';
} else {
  report.run_result = 'WARMUP_INCOMPLETE_NO_MEASUREMENT';
}

for (const name of Object.keys(runtimes)) {
  try { await runtimes[name].radar.stop(); } catch {}
  try { await runtimes[name].store.appendScanSchedulerEvents([]); } catch {}
}
const measured = report.measurement.completed_cycles;
const summarizeVariant = variant => {
  const rows = measured.map(item => item[variant]);
  const counterSum = key => rows.reduce((sum, row) => sum + Number(row.actual_http?.[key] || 0), 0);
  const phaseKeys = [...new Set(rows.flatMap(row => Object.keys(row.phase_timings_ms || {})))];
  const phaseTimings = {};
  for (const key of phaseKeys) phaseTimings[key] = summarizeNumeric(rows.map(row => ({value: Number(row.phase_timings_ms?.[key]) || 0})), 'value');
  return {
    cycles: rows.length,
    eligible_total: summarizeNumeric(rows, 'eligible_total'),
    light_scan_symbols: summarizeNumeric(rows, 'light_scan_symbols'),
    light_fresh_valid: summarizeNumeric(rows, 'light_fresh_valid'),
    light_cache_warmup_or_fallback: summarizeNumeric(rows, 'light_cache_warmup_or_fallback'),
    candidate_pool_48_total: summarizeNumeric(rows, 'candidate_pool_48_total'),
    micro_reached_total: summarizeNumeric(rows, 'micro_reached_total'),
    deep_reached_total: summarizeNumeric(rows, 'deep_reached_total'),
    pre_expansion_total: summarizeNumeric(rows, 'pre_expansion_total'),
    watch_early_total: summarizeNumeric(rows, 'watch_early_total'),
    scan_duration_ms: summarizeNumeric(rows, 'scan_duration_ms'),
    cycle_wall_elapsed_ms: summarizeNumeric(rows, 'elapsed_ms'),
    http_attempts_total: counterSum('http_attempts'),
    http_success_total: counterSum('http_success'),
    http_failure_total: counterSum('http_failure'),
    websocket_messages_total: counterSum('websocket_messages'),
    mean_actual_http_per_cycle: rows.length ? Number((counterSum('http_attempts') / rows.length).toFixed(2)) : null,
    phase_timings_ms: phaseTimings,
    top_rejection_reasons: topCounts(rows.flatMap(row => safeArray(row.reject_reasons_top).flatMap(item => Array(item.count).fill(item.reason)))),
    top_light_invalid_reasons: topCounts(rows.flatMap(row => safeArray(row.light_invalid_reasons_top).flatMap(item => Array(item.count).fill(item.reason)))),
    any_errors: rows.filter(row => row.tick_error || row.radar_error || Number(row.failed_total) > 0).length,
    cache_ready_cycles: rows.filter(row => row.cache_coverage_ready === true && row.micro_pool_applied === true).length,
    rotation_candidate_share_mean: mean(rows.map(row => row.fair_rotation_candidate_share).filter(Number.isFinite)),
    exceptional_preserved_mean: mean(rows.map(row => row.exceptional_preserved).filter(Number.isFinite))
  };
};
report.measurement.summary = {
  baseline: summarizeVariant('baseline'),
  pr199: summarizeVariant('pr199'),
  median_cycle_duration_delta_ms: summarizeNumeric(measured.map(row => ({delta: row.comparison.cycle_duration_delta_ms})), 'delta'),
  micro_new_vs_baseline_total: measured.reduce((sum, row) => sum + row.comparison.micro_new_vs_baseline, 0),
  deep_new_vs_baseline_total: measured.reduce((sum, row) => sum + row.comparison.deep_new_vs_baseline, 0),
  cycles_with_new_micro_candidates: measured.filter(row => row.comparison.micro_new_vs_baseline > 0).length,
  cycles_with_new_deep_candidates: measured.filter(row => row.comparison.deep_new_vs_baseline > 0).length,
  measurement_cycle_rows: measured.map(row => ({
    cycle: row.cycle,
    eligible_baseline: row.baseline.eligible_total,
    eligible_pr199: row.pr199.eligible_total,
    light_scan_symbols: row.pr199.light_scan_symbols,
    fresh_valid: row.pr199.light_fresh_valid,
    fallback: row.pr199.light_cache_warmup_or_fallback,
    pool48: row.pr199.candidate_pool_48_total,
    fair_rotation_share: row.pr199.fair_rotation_candidate_share,
    exceptional: row.pr199.exceptional_preserved,
    micro_baseline: row.baseline.micro_reached_total,
    micro_pr199: row.pr199.micro_reached_total,
    newly_reached_micro: row.comparison.micro_new_vs_baseline,
    deep_baseline: row.baseline.deep_reached_total,
    deep_pr199: row.pr199.deep_reached_total,
    newly_reached_deep: row.comparison.deep_new_vs_baseline,
    pre_expansion_baseline: row.baseline.pre_expansion_total,
    pre_expansion_pr199: row.pr199.pre_expansion_total,
    watch_early_baseline: row.baseline.watch_early_total,
    watch_early_pr199: row.pr199.watch_early_total,
    http_baseline: row.baseline.actual_http.http_attempts,
    http_pr199: row.pr199.actual_http.http_attempts,
    scan_ms_baseline: row.baseline.scan_duration_ms,
    scan_ms_pr199: row.pr199.scan_duration_ms,
    light_ms_pr199: row.pr199.phase_timings_ms?.market_wide_light_scan_ms || 0,
    errors_baseline: row.baseline.failed_total,
    errors_pr199: row.pr199.failed_total
  }))
};
report.http_totals = activity;
report.notes = [
  'This run uses public Binance market data only, no order endpoints, no real trading, no push delivery, no Railway deployment, and no /data production path.',
  'The warm-up cycles are excluded from the 30-cycle measurement summary.',
  'A successful workflow means the report was produced; it does not mean PR #199 passed the merge gate.',
  'If warm-up did not reach complete fresh-cache coverage, the measurement phase is intentionally skipped.',
  'PRE_EXPANSION and WATCH_EARLY are counted as analysis states, not assumed to be final alerts.'
];
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log('[PR199_SHADOW_REPORT] ' + JSON.stringify(report));
console.log('[PR199_SHADOW_REPORT_PATH] ' + outputPath);
