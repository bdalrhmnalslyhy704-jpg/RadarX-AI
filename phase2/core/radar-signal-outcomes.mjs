const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MAX_RECORDS = 1800;
const ARCHIVE_LIMIT_PER_RADAR = 100;
const DEFAULT_LOOKBACK_DAYS = 45;
const MAX_FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const MIN_RATE_SAMPLE = 30;

export const RADAR_OUTCOME_HORIZONS = Object.freeze([
  Object.freeze({ key: '5m', ms: 5 * MINUTE_MS, family: 'oneMinute', interval: '1m', intervalMs: MINUTE_MS }),
  Object.freeze({ key: '15m', ms: 15 * MINUTE_MS, family: 'oneMinute', interval: '1m', intervalMs: MINUTE_MS }),
  Object.freeze({ key: '30m', ms: 30 * MINUTE_MS, family: 'oneMinute', interval: '1m', intervalMs: MINUTE_MS }),
  Object.freeze({ key: '60m', ms: 60 * MINUTE_MS, family: 'oneMinute', interval: '1m', intervalMs: MINUTE_MS }),
  Object.freeze({ key: '4h', ms: 4 * 60 * MINUTE_MS, family: 'fiveMinute', interval: '5m', intervalMs: 5 * MINUTE_MS }),
  Object.freeze({ key: '24h', ms: DAY_MS, family: 'fiveMinute', interval: '5m', intervalMs: 5 * MINUTE_MS })
]);

export const RADAR_OUTCOME_ARCHIVES = Object.freeze([
  Object.freeze({ id: 'RADAR_1', name: 'المدمر', reader: 'readMoveAlerts', archive: 'moveAlerts' }),
  Object.freeze({ id: 'RADAR_2', name: 'ملك الظلام', reader: 'readStrongMoveAlerts', archive: 'strongMoveAlerts' }),
  Object.freeze({ id: 'RADAR_3', name: 'الجوكر', reader: 'readRotationAlerts', archive: 'rotationAlerts' }),
  Object.freeze({ id: 'RADAR_4', name: 'الكاسح', reader: 'readLiquidityAbsorptionAlerts', archive: 'liquidityAbsorptionAlerts' }),
  Object.freeze({ id: 'RADAR_5', name: 'القاهر', reader: 'readKahirAlerts', archive: 'kahirAlerts' }),
  Object.freeze({ id: 'RADAR_6', name: 'يوم القيامة', reader: 'readDoomsdayAlerts', archive: 'doomsdayAlerts' }),
  Object.freeze({ id: 'RADAR_7', name: 'المقاوم', reader: 'readAlMuqawimAlerts', archive: 'alMuqawimAlerts' }),
  Object.freeze({ id: 'RADAR_8', name: 'البرق', reader: 'readEarlyExpansionAlerts', archive: 'earlyExpansionAlerts' }),
  Object.freeze({ id: 'RADAR_9', name: 'عين الصقر', reader: 'readFalconEyeAlerts', archive: 'falconEyeAlerts' }),
  Object.freeze({ id: 'RADAR_10', name: 'صائد العملات', reader: 'readCoinHunterAlerts', archive: 'coinHunterAlerts' }),
  Object.freeze({ id: 'RADAR_11', name: 'تجمع الحيتان', reader: 'readWhaleAccumulationAlerts', archive: 'whaleAccumulationAlerts' }),
  Object.freeze({ id: 'RADAR_12', name: 'البروفيسور', reader: 'readProfessorAlerts', archive: 'professorAlerts' })
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean' ||
      (typeof value === 'string' && value.trim() === '')) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function positive(...values) {
  for (const value of values) {
    const parsed = finite(value);
    if (parsed !== null && parsed > 0) return parsed;
  }
  return null;
}
function timestamp(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const numeric = finite(value);
    if (numeric !== null) {
      const ms = Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
      if (ms > 0) return Math.trunc(ms);
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}
function stageOf(row) {
  const r = object(row);
  const falcon = object(r.falcon_eye);
  const strong = object(r.strong_move);
  const early = object(r.early_expansion);
  return String(r.pre_expansion_stage ?? r.stage ?? r.potential_label ?? r.decision_band ??
    falcon.pre_expansion_stage ?? strong.stage ?? early.stage ?? r.action ?? 'UNKNOWN').trim().toUpperCase().slice(0, 80);
}
function symbolOf(row) {
  const r = object(row);
  const symbol = String(r.symbol ?? r.ticker?.symbol ?? r.market?.symbol ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{2,15}USDT$/.test(symbol) ? symbol : null;
}
function entryPriceOf(row) {
  const r = object(row);
  const falcon = object(r.falcon_eye);
  const strong = object(r.strong_move);
  const metrics = object(r.metrics);
  const nestedMetrics = object(falcon.metrics);
  const ticker = object(r.ticker);
  return positive(r.entry_price, r.price, r.last_price, r.lastPrice, r.reference_price,
    ticker.lastPrice, ticker.last_price, metrics.last_price, metrics.price,
    nestedMetrics.last_price, strong.price, strong.last_price, r.current_price);
}
function signalTimeOf(row) {
  const r = object(row);
  return timestamp(r.detected_at, r.detectedAt, r.signal_at, r.created_at, r.timestamp,
    r.time, r.as_of_ms, r.processed_at, r.updated_at);
}
function rowIdOf(row) {
  const r = object(row);
  return String(r.id ?? r.alert_id ?? r.signal_id ?? r.event_id ?? '').trim().slice(0, 150);
}

export function normalizeArchivedRadarSignal(row, radarId, now = Date.now()) {
  const raw = object(row);
  const radar = String(radarId || '').toUpperCase();
  const symbol = symbolOf(raw);
  const entryPrice = entryPriceOf(raw);
  const detectedAt = signalTimeOf(raw);
  const sourceId = rowIdOf(raw);
  const stage = stageOf(raw);
  const reasons = [];
  if (!symbol) reasons.push('SYMBOL_MISSING_OR_NOT_USDT_SPOT');
  if (entryPrice === null) reasons.push('ENTRY_PRICE_MISSING');
  if (detectedAt === null) reasons.push('SIGNAL_TIMESTAMP_MISSING');
  if (detectedAt !== null && detectedAt > Number(now) + MINUTE_MS) reasons.push('SIGNAL_TIMESTAMP_IN_FUTURE');
  if (detectedAt !== null && detectedAt < Number(now) - 180 * DAY_MS) reasons.push('SIGNAL_TOO_OLD_FOR_RETAINED_OUTCOME_WINDOW');
  const identity = [radar, sourceId || 'ARCHIVE_ROW', symbol || 'NO_SYMBOL',
    detectedAt ?? 'NO_TIME', entryPrice ?? 'NO_PRICE', stage].join('|');
  const signalId = identity.slice(0, 240);
  const validBaseline = symbol !== null && entryPrice !== null && detectedAt !== null &&
    detectedAt <= Number(now) + MINUTE_MS && detectedAt >= Number(now) - 180 * DAY_MS;
  return {
    signal_id: signalId,
    source_alert_id: sourceId || null,
    radar,
    symbol,
    stage,
    detected_at: detectedAt,
    detected_at_iso: detectedAt === null ? null : new Date(detectedAt).toISOString(),
    entry_price: entryPrice,
    baseline_status: validBaseline ? 'COMPLETE' : 'INCOMPLETE',
    baseline_missing_reasons: reasons,
    alert_archive: RADAR_OUTCOME_ARCHIVES.find(x => x.id === radar)?.archive || null,
    source: 'ARCHIVED_RADAR_ALERT',
    outcomes: Object.fromEntries(RADAR_OUTCOME_HORIZONS.map(h => [h.key, {
      status: validBaseline ? 'PENDING' : 'EXCLUDED_INCOMPLETE_BASELINE',
      reason: validBaseline ? 'WAITING_FOR_CLOSED_CANDLE_HORIZON' : reasons.join(',') || 'BASELINE_INCOMPLETE',
      source: 'BINANCE_PUBLIC_CLOSED_OHLC_REQUIRED',
      interval: h.interval,
      interval_ms: h.intervalMs,
      horizon_ms: h.ms,
      expected_bars: null,
      observed_bars: 0,
      close_return_pct: null,
      max_favorable_pct: null,
      max_adverse_pct: null,
      hit_1pct_at: null,
      hit_3pct_at: null,
      hit_5pct_at: null,
      hit_10pct_at: null,
      sample_quality: null,
      updated_at: null
    }])),
    fetch_attempts: {},
    next_retry_at: {},
    created_at: Number(now),
    updated_at: Number(now)
  };
}

export function emptyRadarSignalOutcomeState() {
  return {
    version: 'RADAR_SIGNAL_OUTCOMES_V1',
    records: [],
    last_import_at: null,
    last_import_counts: {},
    last_pass_at: null,
    last_pass: null,
    updated_at: 0
  };
}
function normalizeState(raw) {
  const s = object(raw);
  return {
    ...emptyRadarSignalOutcomeState(),
    ...s,
    version: 'RADAR_SIGNAL_OUTCOMES_V1',
    records: Array.isArray(s.records) ? s.records.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : [],
    last_import_counts: object(s.last_import_counts),
    last_pass: s.last_pass === null ? null : object(s.last_pass)
  };
}
function missingOutcomes(record) {
  return object(record?.outcomes);
}
function expectedOpenTimes(detectedAt, horizonMs, intervalMs) {
  const endAt = Number(detectedAt) + Number(horizonMs);
  const firstOpen = Math.ceil(Number(detectedAt) / Number(intervalMs)) * Number(intervalMs);
  const times = [];
  for (let open = firstOpen; open < endAt; open += intervalMs) times.push(open);
  return { firstOpen, endAt, times };
}
function validClosedCandle(row, now) {
  const c = object(row);
  const openTime = finite(c.openTime), closeTime = finite(c.closeTime);
  const open = finite(c.open), high = finite(c.high), low = finite(c.low), close = finite(c.close);
  const volume = finite(c.volume);
  if (c.closed === false || openTime === null || closeTime === null || closeTime >= now ||
      closeTime < openTime || openTime > closeTime || open === null || high === null ||
      low === null || close === null || volume === null || open <= 0 || high <= 0 ||
      low <= 0 || close <= 0 || volume < 0 || high < Math.max(open, close) ||
      low > Math.min(open, close)) return null;
  return { openTime, closeTime, open, high, low, close, volume };
}
function pct(value, base) {
  return Number.isFinite(value) && Number.isFinite(base) && base > 0
    ? Number(((value / base - 1) * 100).toFixed(5)) : null;
}
function evaluateClosedHorizon(record, rows, horizon, now) {
  const endAt = Number(record.detected_at) + horizon.ms;
  if (Number(now) < endAt + horizon.intervalMs) {
    return { status: 'PENDING', reason: 'HORIZON_NOT_MATURED_WITH_CLOSED_CANDLE_TOLERANCE' };
  }
  const expected = expectedOpenTimes(record.detected_at, horizon.ms, horizon.intervalMs);
  if (!expected.times.length) return { status: 'INCOMPLETE', reason: 'NO_EXPECTED_CLOSED_CANDLES', expected_bars: 0, observed_bars: 0 };
  const byOpen = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const candle = validClosedCandle(raw, now);
    if (candle && candle.openTime >= expected.firstOpen && candle.openTime < expected.endAt) {
      const prior = byOpen.get(candle.openTime);
      if (!prior || candle.closeTime > prior.closeTime) byOpen.set(candle.openTime, candle);
    }
  }
  const missing = expected.times.filter(openTime => !byOpen.has(openTime));
  const bars = expected.times.map(openTime => byOpen.get(openTime)).filter(Boolean);
  if (missing.length || bars.length !== expected.times.length) {
    return {
      status: 'INCOMPLETE',
      reason: missing.length ? 'CLOSED_CANDLE_WINDOW_HAS_GAPS' : 'CLOSED_CANDLE_WINDOW_INCOMPLETE',
      expected_bars: expected.times.length,
      observed_bars: bars.length,
      missing_open_times: missing.slice(0, 25),
      missing_open_times_count: missing.length,
      first_open_time: expected.firstOpen,
      target_end_time: expected.endAt,
      last_observed_close_time: bars.length ? bars[bars.length - 1].closeTime : null
    };
  }
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].openTime - bars[i - 1].openTime !== horizon.intervalMs) {
      return {
        status: 'INCOMPLETE', reason: 'CLOSED_CANDLE_SEQUENCE_NOT_CONTIGUOUS',
        expected_bars: expected.times.length, observed_bars: bars.length
      };
    }
  }
  const entry = Number(record.entry_price);
  const maxHigh = Math.max(...bars.map(x => x.high));
  const minLow = Math.min(...bars.map(x => x.low));
  const final = bars[bars.length - 1];
  const firstHit = threshold => {
    const bar = bars.find(c => c.high >= entry * (1 + threshold / 100));
    return bar ? { at: bar.closeTime, delay_ms: Math.max(0, bar.closeTime - Number(record.detected_at)), resolution: 'CANDLE_CLOSE_TIME_NOT_EXACT_TRADE_TIME' } : null;
  };
  return {
    status: 'COMPLETE',
    reason: null,
    source: 'BINANCE_PUBLIC_CLOSED_OHLC',
    interval: horizon.interval,
    interval_ms: horizon.intervalMs,
    horizon_ms: horizon.ms,
    expected_bars: expected.times.length,
    observed_bars: bars.length,
    first_open_time: bars[0].openTime,
    last_close_time: final.closeTime,
    target_end_time: expected.endAt,
    end_offset_ms: final.closeTime - expected.endAt,
    close_return_pct: pct(final.close, entry),
    max_favorable_pct: pct(maxHigh, entry),
    max_adverse_pct: pct(minLow, entry),
    hit_1pct_at: firstHit(1),
    hit_3pct_at: firstHit(3),
    hit_5pct_at: firstHit(5),
    hit_10pct_at: firstHit(10),
    sample_quality: 'HISTORICAL_CLOSED_OHLC',
    updated_at: Number(now),
    future_trade_time_claimed: false
  };
}
function dueHorizons(record, family, now) {
  return RADAR_OUTCOME_HORIZONS.filter(h => h.family === family &&
    record?.outcomes?.[h.key]?.status === 'PENDING' &&
    Number(now) >= Number(record.detected_at) + h.ms + h.intervalMs);
}
function taskForRecord(record, now) {
  if (record?.baseline_status !== 'COMPLETE') return null;
  for (const family of ['oneMinute', 'fiveMinute']) {
    const due = dueHorizons(record, family, now);
    if (!due.length) continue;
    const retryAt = finite(record.next_retry_at?.[family]) ?? 0;
    if (retryAt > now) continue;
    return { record, family, due };
  }
  return null;
}
function safeError(error) {
  return String(error?.code || error?.message || error || 'UNKNOWN_ERROR')
    .replace(/[^a-z0-9_.:-]/gi, '_').slice(0, 140);
}
function summarizeHorizon(records, key) {
  const horizonRecords = records.filter(r => r.baseline_status === 'COMPLETE');
  const complete = horizonRecords.map(r => r.outcomes?.[key]).filter(x =>
    x?.status === 'COMPLETE' && x?.sample_quality === 'HISTORICAL_CLOSED_OHLC');
  const pending = horizonRecords.filter(r => r.outcomes?.[key]?.status === 'PENDING').length;
  const incomplete = horizonRecords.filter(r => r.outcomes?.[key]?.status === 'INCOMPLETE').length;
  const average = keyName => {
    const values = complete.map(x => finite(x[keyName])).filter(x => x !== null);
    return values.length ? Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(4)) : null;
  };
  const rate = predicate => complete.length >= MIN_RATE_SAMPLE
    ? Number((complete.filter(predicate).length / complete.length * 100).toFixed(2)) : null;
  return {
    completed_samples: complete.length,
    pending_samples: pending,
    incomplete_samples: incomplete,
    rate_status: complete.length >= MIN_RATE_SAMPLE ? 'READY_N_GE_30' : 'INSUFFICIENT_SAMPLE',
    avg_close_return_pct: average('close_return_pct'),
    avg_max_favorable_pct: average('max_favorable_pct'),
    avg_max_adverse_pct: average('max_adverse_pct'),
    max_favorable_gte_1pct_rate: rate(x => finite(x.max_favorable_pct) !== null && x.max_favorable_pct >= 1),
    max_favorable_gte_3pct_rate: rate(x => finite(x.max_favorable_pct) !== null && x.max_favorable_pct >= 3),
    max_favorable_gte_5pct_rate: rate(x => finite(x.max_favorable_pct) !== null && x.max_favorable_pct >= 5),
    max_adverse_lte_minus_2pct_rate: rate(x => finite(x.max_adverse_pct) !== null && x.max_adverse_pct <= -2),
    source: 'BINANCE_PUBLIC_CLOSED_OHLC_ONLY'
  };
}
export function buildRadarSignalOutcomeReport(input = {}, now = Date.now()) {
  const state = normalizeState(input);
  const byRadar = RADAR_OUTCOME_ARCHIVES.map(radar => {
    const records = state.records.filter(row => row.radar === radar.id);
    const baselineComplete = records.filter(row => row.baseline_status === 'COMPLETE');
    const baselineIncomplete = records.filter(row => row.baseline_status !== 'COMPLETE');
    return {
      radar: radar.id,
      name: radar.name,
      archived_signals: records.length,
      measurable_baselines: baselineComplete.length,
      incomplete_baselines: baselineIncomplete.length,
      last_signal_at: records.reduce((latest, row) => Math.max(latest, finite(row.detected_at) ?? 0), 0) || null,
      missing_baseline_reasons: baselineIncomplete.reduce((acc, row) => {
        for (const reason of row.baseline_missing_reasons || []) acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {}),
      horizons: Object.fromEntries(RADAR_OUTCOME_HORIZONS.map(h => [h.key, summarizeHorizon(records, h.key)]))
    };
  });
  const records = state.records;
  return {
    version: 'RADAR_SIGNAL_OUTCOME_REPORT_V1',
    as_of: new Date(Number(now)).toISOString(),
    scope: 'EMITTED_ARCHIVED_ALERTS_ONLY',
    interpretation: {
      measured_source: 'BINANCE_PUBLIC_CLOSED_OHLC',
      horizon_resolution: { '5m': '1m', '15m': '1m', '30m': '1m', '60m': '1m', '4h': '5m', '24h': '5m' },
      min_samples_for_rates: MIN_RATE_SAMPLE,
      candle_high_thresholds_are_not_exact_trade_times: true,
      misses_not_measured_by_this_report: true,
      no_profitability_claim: true
    },
    limits: { max_records: MAX_RECORDS, archive_scan_limit_per_radar: ARCHIVE_LIMIT_PER_RADAR, lookback_days: DEFAULT_LOOKBACK_DAYS },
    summary: {
      expected_radars: RADAR_OUTCOME_ARCHIVES.length,
      radars_with_archived_signals: byRadar.filter(x => x.archived_signals > 0).length,
      archived_signals: records.length,
      measurable_baselines: records.filter(x => x.baseline_status === 'COMPLETE').length,
      incomplete_baselines: records.filter(x => x.baseline_status !== 'COMPLETE').length,
      completed_24h_outcomes: records.filter(x => x.outcomes?.['24h']?.status === 'COMPLETE').length,
      incomplete_24h_outcomes: records.filter(x => x.outcomes?.['24h']?.status === 'INCOMPLETE').length,
      pending_24h_outcomes: records.filter(x => x.baseline_status === 'COMPLETE' && x.outcomes?.['24h']?.status === 'PENDING').length
    },
    last_import_at: state.last_import_at,
    last_import_counts: state.last_import_counts,
    last_pass_at: state.last_pass_at,
    last_pass: state.last_pass,
    by_radar: byRadar,
    updated_at: state.updated_at || null,
    policy: { market: 'BINANCE_SPOT', paper_trading: true, real_order_execution: false, confidence_score: 'UNKNOWN' }
  };
}
async function fetchHorizonCandles(rest, record, family, due, now) {
  const interval = family === 'oneMinute' ? '1m' : '5m';
  const intervalMs = family === 'oneMinute' ? MINUTE_MS : 5 * MINUTE_MS;
  const maxHorizon = Math.max(...due.map(h => h.ms));
  const firstOpen = Math.ceil(Number(record.detected_at) / intervalMs) * intervalMs;
  const targetEnd = Number(record.detected_at) + maxHorizon;
  const startTime = firstOpen;
  const endTime = Math.min(Number(now) - 1, targetEnd + intervalMs);
  if (!(startTime < endTime)) return { candles: [], source: null };
  const required = Math.ceil((targetEnd - firstOpen) / intervalMs) + 2;
  const limit = Math.max(2, Math.min(300, required));
  const result = await rest.klines(record.symbol, interval, { startTime, endTime, limit });
  return { candles: Array.isArray(result?.candles) ? result.candles : [], source: result?.source || 'BINANCE_PUBLIC_REST' };
}
function applyGroupResult(record, family, due, candles, error, now) {
  const attempts = Math.max(0, Math.trunc(finite(record.fetch_attempts?.[family]) ?? 0)) + 1;
  record.fetch_attempts ||= {};
  record.next_retry_at ||= {};
  record.fetch_attempts[family] = attempts;
  record.last_fetch_at = Number(now);
  record.last_fetch_family = family;
  record.last_fetch_error = error ? safeError(error) : null;
  let stillPending = false;
  for (const h of due) {
    const previous = record.outcomes?.[h.key];
    if (previous?.status !== 'PENDING') continue;
    let outcome = error ? { status: 'INCOMPLETE', reason: 'BINANCE_KLINE_FETCH_FAILED' } :
      evaluateClosedHorizon(record, candles, h, now);
    if (outcome.status === 'INCOMPLETE' && attempts < MAX_FETCH_ATTEMPTS) {
      stillPending = true;
      record.outcomes[h.key] = {
        ...previous, status: 'PENDING',
        reason: 'RETRYING_' + String(outcome.reason || 'CANDLE_COVERAGE_INCOMPLETE'),
        last_failed_reason: String(outcome.reason || 'CANDLE_COVERAGE_INCOMPLETE'),
        attempts, last_attempt_at: Number(now)
      };
    } else {
      record.outcomes[h.key] = {
        ...previous, ...outcome,
        status: outcome.status,
        reason: outcome.reason || null,
        attempts,
        last_attempt_at: Number(now),
        updated_at: Number(now)
      };
    }
  }
  if (stillPending) record.next_retry_at[family] = Number(now) + RETRY_DELAY_MS;
  else delete record.next_retry_at[family];
  record.updated_at = Number(now);
  return { attempts, stillPending };
}
function trimRecords(records) {
  const sorted = [...records].sort((a, b) => (finite(a.detected_at) ?? 0) - (finite(b.detected_at) ?? 0));
  return sorted.length > MAX_RECORDS ? sorted.slice(sorted.length - MAX_RECORDS) : sorted;
}

export async function runRadarSignalOutcomePass({
  store, rest, now = Date.now(), maxRestCalls = 2,
  lookbackDays = DEFAULT_LOOKBACK_DAYS, archiveLimit = ARCHIVE_LIMIT_PER_RADAR, logger = console
} = {}) {
  if (typeof store?.getRadarSignalOutcomes !== 'function' ||
      typeof store?.updateRadarSignalOutcomes !== 'function') {
    return { ok: false, reason: 'RADAR_SIGNAL_OUTCOME_STORE_UNAVAILABLE' };
  }
  if (typeof rest?.klines !== 'function') return { ok: false, reason: 'RADAR_SIGNAL_OUTCOME_REST_UNAVAILABLE' };
  const cutoff = Number(now) - Math.max(1, Math.min(180, Number(lookbackDays) || DEFAULT_LOOKBACK_DAYS)) * DAY_MS;
  const incoming = [];
  const importCounts = {};
  for (const radar of RADAR_OUTCOME_ARCHIVES) {
    const reader = store[radar.reader];
    if (typeof reader !== 'function') {
      importCounts[radar.id] = { scanned: 0, imported: 0, status: 'READER_UNAVAILABLE' };
      continue;
    }
    try {
      const rows = await reader.call(store, { sinceMs: cutoff, limit: Math.max(1, Math.min(100, Number(archiveLimit) || 100)) });
      const normalized = (Array.isArray(rows) ? rows : []).map(row => normalizeArchivedRadarSignal(row, radar.id, now));
      incoming.push(...normalized);
      importCounts[radar.id] = { scanned: normalized.length, status: 'OK' };
    } catch (error) {
      importCounts[radar.id] = { scanned: 0, status: 'READ_FAILED', reason: safeError(error) };
    }
  }
  let newlyImported = 0;
  await store.updateRadarSignalOutcomes(raw => {
    const state = normalizeState(raw);
    const known = new Set(state.records.map(row => String(row.signal_id)));
    for (const row of incoming) {
      if (known.has(row.signal_id)) continue;
      known.add(row.signal_id);
      state.records.push(row);
      newlyImported++;
      importCounts[row.radar] ||= { scanned: 0 };
      importCounts[row.radar].imported = (importCounts[row.radar].imported || 0) + 1;
    }
    state.records = trimRecords(state.records);
    state.last_import_at = Number(now);
    state.last_import_counts = importCounts;
    state.updated_at = Number(now);
    return state;
  });

  let requests = 0, evaluatedRecords = 0, completeHorizons = 0, failedRequests = 0;
  const requestBudget = Math.max(0, Math.min(10, Math.trunc(Number(maxRestCalls) || 0)));
  while (requests < requestBudget) {
    const state = normalizeState(await store.getRadarSignalOutcomes());
    const candidates = state.records
      .map(record => taskForRecord(record, Number(now)))
      .filter(Boolean)
      .sort((a, b) => Number(a.record.detected_at) - Number(b.record.detected_at) ||
        String(a.record.radar).localeCompare(String(b.record.radar)));
    const task = candidates[0];
    if (!task) break;
    let candles = [], fetchError = null, source = null;
    try {
      const result = await fetchHorizonCandles(rest, task.record, task.family, task.due, Number(now));
      candles = result.candles;
      source = result.source;
    } catch (error) {
      fetchError = error;
      failedRequests++;
    }
    const dueKeys = task.due.map(h => h.key);
    const previousComplete = task.record.outcomes || {};
    const previouslyComplete = dueKeys.filter(k => previousComplete[k]?.status === 'COMPLETE').length;
    const localRecord = {...task.record, outcomes: {...previousComplete}};
    const update = applyGroupResult(localRecord, task.family, task.due, candles, fetchError, Number(now));
    const newlyComplete = dueKeys.filter(k => localRecord.outcomes[k]?.status === 'COMPLETE').length - previouslyComplete;
    completeHorizons += Math.max(0, newlyComplete);
    evaluatedRecords++;
    await store.updateRadarSignalOutcomes(raw => {
      const state = normalizeState(raw);
      const index = state.records.findIndex(row => row.signal_id === task.record.signal_id);
      if (index < 0) return false;
      const current = state.records[index];
      const merged = {
        ...current,
        outcomes: { ...object(current.outcomes), ...localRecord.outcomes },
        fetch_attempts: { ...object(current.fetch_attempts), ...localRecord.fetch_attempts },
        next_retry_at: { ...object(current.next_retry_at), ...localRecord.next_retry_at },
        last_fetch_at: localRecord.last_fetch_at,
        last_fetch_family: localRecord.last_fetch_family,
        last_fetch_error: fetchError ? safeError(fetchError) : null,
        updated_at: Number(now)
      };
      state.records[index] = merged;
      state.updated_at = Number(now);
      return state;
    });
    requests++;
    if (fetchError) {
      try { logger.warn?.('[RADAR_OUTCOME_FETCH_FAILED] ' + JSON.stringify({radar: task.record.radar, symbol: task.record.symbol, family: task.family, error: safeError(fetchError)})); } catch {}
    } else if (update.stillPending) {
      try { logger.warn?.('[RADAR_OUTCOME_COVERAGE_RETRY] ' + JSON.stringify({radar: task.record.radar, symbol: task.record.symbol, family: task.family, attempts: update.attempts, source})); } catch {}
    }
  }
  const pass = {
    ok: true, at: Number(now), imported: newlyImported, archives_scanned: incoming.length,
    rest_requests: requests, records_evaluated: evaluatedRecords, completed_horizons: completeHorizons,
    failed_requests: failedRequests, request_budget: requestBudget
  };
  await store.updateRadarSignalOutcomes(raw => {
    const state = normalizeState(raw);
    state.last_pass_at = Number(now);
    state.last_pass = pass;
    state.updated_at = Number(now);
    return state;
  });
  return { ...pass, report: buildRadarSignalOutcomeReport(await store.getRadarSignalOutcomes(), now) };
}

export class RadarSignalOutcomeWorker {
  constructor({ store, rest, logger = console, clock = () => Date.now(), pollMs = 60_000, maxRestCalls = 2 } = {}) {
    this.store = store;
    this.rest = rest;
    this.logger = logger;
    this.clock = clock;
    this.pollMs = Math.max(15_000, Math.trunc(finite(pollMs) ?? 60_000));
    this.maxRestCalls = Math.max(0, Math.min(10, Math.trunc(finite(maxRestCalls) ?? 2)));
    this.running = false;
    this.busy = false;
    this.timer = null;
    this.lastError = null;
    this.lastRunAt = null;
    this.lastResult = null;
  }
  start() {
    if (this.running) return false;
    this.running = true;
    this.lastError = null;
    const run = () => this.runOnce().catch(error => {
      this.lastError = safeError(error);
      try { this.logger.warn?.('[RADAR_OUTCOME_WORKER_ERROR] ' + this.lastError); } catch {}
    });
    void run();
    this.timer = setInterval(run, this.pollMs);
    this.timer.unref?.();
    return true;
  }
  async runOnce() {
    if (this.busy) return { ok: false, reason: 'OUTCOME_PASS_ALREADY_RUNNING' };
    this.busy = true;
    try {
      const result = await runRadarSignalOutcomePass({
        store: this.store, rest: this.rest, now: this.clock(),
        maxRestCalls: this.maxRestCalls, logger: this.logger
      });
      this.lastRunAt = this.clock();
      this.lastResult = result;
      this.lastError = result?.ok === false ? String(result.reason || 'OUTCOME_PASS_FAILED') : null;
      return result;
    } finally {
      this.busy = false;
    }
  }
  snapshot() {
    const state = typeof this.store?.getRadarSignalOutcomes === 'function' ? null : null;
    return {
      service: 'RADAR_SIGNAL_OUTCOME_WORKER_V1',
      running: this.running,
      busy: this.busy,
      poll_ms: this.pollMs,
      max_rest_calls_per_pass: this.maxRestCalls,
      last_run_at: this.lastRunAt,
      last_error: this.lastError,
      last_pass: this.lastResult && {
        ok: this.lastResult.ok, imported: this.lastResult.imported ?? 0,
        archives_scanned: this.lastResult.archives_scanned ?? 0,
        rest_requests: this.lastResult.rest_requests ?? 0,
        records_evaluated: this.lastResult.records_evaluated ?? 0,
        completed_horizons: this.lastResult.completed_horizons ?? 0,
        failed_requests: this.lastResult.failed_requests ?? 0
      },
      limits: { max_records: MAX_RECORDS, source: 'PUBLIC_SPOT_CLOSED_OHLC_ONLY' },
      policy: { paper_trading: true, real_order_execution: false, confidence_score: 'UNKNOWN' }
    };
  }
  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
