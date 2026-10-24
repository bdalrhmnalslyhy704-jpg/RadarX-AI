import { RADAR_OUTCOME_ARCHIVES } from './radar-signal-outcomes.mjs';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_AUDIT_AGE_MS = 45 * DAY_MS;
const SNAPSHOT_BUCKET_MS = MINUTE_MS;
const MAX_ENDPOINT_GAP_MS = 3 * MINUTE_MS;
const ALERT_RELEVANCE_LOOKBACK_MS = 15 * MINUTE_MS;
const DEFAULT_MOVE_THRESHOLD_PCT = 5;

export const RADAR_MISSED_MOVER_HORIZONS = Object.freeze([
  Object.freeze({ key: '5m', ms: 5 * MINUTE_MS }),
  Object.freeze({ key: '15m', ms: 15 * MINUTE_MS }),
  Object.freeze({ key: '30m', ms: 30 * MINUTE_MS }),
  Object.freeze({ key: '60m', ms: 60 * MINUTE_MS }),
  Object.freeze({ key: '4h', ms: 4 * 60 * MINUTE_MS }),
  Object.freeze({ key: '24h', ms: DAY_MS })
]);

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestamp(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '' || value === '.INCOMPLETE') continue;
    const number = finite(value);
    if (number !== null && number > 0) return Math.trunc(Math.abs(number) < 1e12 ? number * 1000 : number);
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

function symbolOf(row) {
  const raw = row && typeof row === 'object' ? row : {};
  const symbol = String(raw.symbol ?? raw.ticker?.symbol ?? raw.market?.symbol ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{2,15}USDT$/.test(symbol) ? symbol : null;
}

function priceOf(coin) {
  const ticker = coin && typeof coin.ticker === 'object' ? coin.ticker : {};
  const price = finite(ticker.price ?? coin.current_price ?? coin.price);
  return price !== null && price > 0 ? price : null;
}

function movePct(price, entry) {
  return price > 0 && entry > 0 ? Number(((price / entry - 1) * 100).toFixed(5)) : null;
}

function normalizeCycleSnapshots(cycles, now, maxAgeMs) {
  const rows = [];
  const dropped = { non_complete_cycles: 0, future_cycles: 0, stale_cycles: 0, invalid_snapshots: 0 };
  for (const cycle of Array.isArray(cycles) ? cycles : []) {
    if (!cycle || cycle.radar !== 'RADAR_8' || cycle.status !== 'COMPLETE' || !Array.isArray(cycle.coins)) {
      dropped.non_complete_cycles++;
      continue;
    }
    const cycleAt = timestamp(cycle.started_at, cycle.completed_at);
    const completedAt = timestamp(cycle.completed_at);
    if (cycleAt === null || completedAt === null || completedAt > now || cycleAt > now) {
      dropped.future_cycles++;
      continue;
    }
    if (now - completedAt > maxAgeMs) {
      dropped.stale_cycles++;
      continue;
    }
    for (const coin of cycle.coins) {
      const symbol = symbolOf(coin);
      const price = priceOf(coin);
      const observedAt = timestamp(coin.fast_scan_at, coin.eligibility_at, cycle.eligible_at, cycle.started_at);
      if (!symbol || price === null || observedAt === null || observedAt > now || now - observedAt > maxAgeMs) {
        dropped.invalid_snapshots++;
        continue;
      }
      rows.push({
        symbol,
        price,
        at: observedAt,
        eligible: coin.eligible === true ? true : coin.eligible === false ? false : null,
        quote_volume_24h: finite(coin.ticker?.quote_volume_24h ?? coin.ticker?.quoteVolume24h),
        coin,
        cycle_id: String(cycle.cycle_id || ''),
        cycle_number: finite(cycle.cycle_number),
        source: String(coin.ticker?.source || cycle.source || 'UNKNOWN')
      });
    }
  }
  rows.sort((a, b) => a.at - b.at || a.symbol.localeCompare(b.symbol));
  return { rows, dropped };
}

function dedupeSnapshots(rows) {
  const firstPerBucket = new Map();
  for (const row of rows) {
    const bucket = Math.floor(row.at / SNAPSHOT_BUCKET_MS);
    const key = row.symbol + '|' + bucket;
    if (!firstPerBucket.has(key)) firstPerBucket.set(key, row);
  }
  return [...firstPerBucket.values()].sort((a, b) => a.at - b.at || a.symbol.localeCompare(b.symbol));
}

function normalizeAlerts(alertsByRadar, now) {
  const bySymbol = new Map();
  const counts = {};
  for (const radar of RADAR_OUTCOME_ARCHIVES) {
    const rows = Array.isArray(alertsByRadar?.[radar.id]) ? alertsByRadar[radar.id] : [];
    counts[radar.id] = rows.length;
    for (const row of rows) {
      const symbol = symbolOf(row);
      const at = timestamp(row?.detected_at, row?.detectedAt, row?.signal_at, row?.created_at,
        row?.event_at, row?.timestamp, row?.processed_at);
      if (!symbol || at === null || at > now) continue;
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
      bySymbol.get(symbol).push({ symbol, at, radar: radar.id, alert_id: String(row?.id ?? row?.alert_id ?? '') });
    }
  }
  for (const rows of bySymbol.values()) rows.sort((a, b) => a.at - b.at);
  return { bySymbol, counts };
}

function rejectionReason(coin) {
  const existing = value => typeof value === 'string' && value.trim() && value !== '.INCOMPLETE' ? value.trim() : null;
  if (coin?.eligible === false) return existing(coin.rejection_reason) || 'NOT_ELIGIBLE_FOR_SPOT_USDT_SCAN';
  if (coin?.eligible !== true) return 'ELIGIBILITY_NOT_RECORDED';
  if (!timestamp(coin.fast_scan_at, coin.eligibility_at)) return 'FAST_SCAN_TIMESTAMP_MISSING';
  const light = coin.market_wide_light_scan && typeof coin.market_wide_light_scan === 'object'
    ? coin.market_wide_light_scan : {};
  if (light.evaluated === false) return existing(light.reason) || existing(light.rejection_reason) || 'LIGHT_SCAN_NOT_EVALUATED';
  if (!timestamp(coin.micro_selected_at)) return existing(coin.rejection_reason) || 'NOT_SELECTED_FOR_MICRO_CAPACITY';
  if (!timestamp(coin.micro_scan_completed_at)) return existing(coin.rejection_reason) || 'MICRO_SCAN_NOT_COMPLETED';
  if (String(coin.deep_scan_status || '').toUpperCase() === 'FAILED') return existing(coin.rejection_reason) || 'DEEP_SCAN_FAILED';
  if (String(coin.deep_scan_status || '').toUpperCase() !== 'COMPLETED') return 'DEEP_SCAN_NOT_COMPLETED';
  if (existing(coin.notification_gate_rejection_reason)) return existing(coin.notification_gate_rejection_reason);
  if (String(coin.notification_status || '').toUpperCase() === 'FAILED') return 'NOTIFICATION_DELIVERY_FAILED';
  return 'NO_RADAR_ALERT_BEFORE_OBSERVED_MOVE';
}

function horizonOutcome({ start, snapshots, horizon, now, alerts, thresholdPct }) {
  const endAt = start.at + horizon.ms;
  const window = snapshots.filter(row => row.at > start.at && row.at <= endAt);
  if (now < endAt) {
    return {
      status: 'PENDING',
      reason: 'HORIZON_NOT_MATURED',
      expected_end_at: endAt,
      observed_points: window.length,
      close_return_pct: null,
      max_favorable_pct: null,
      max_adverse_pct: null,
      mover: false,
      captured_before_move: null,
      missed: null
    };
  }
  const last = window.at(-1);
  if (!last || endAt - last.at > MAX_ENDPOINT_GAP_MS) {
    return {
      status: 'INCOMPLETE',
      reason: 'NO_NEAR_ENDPOINT_SNAPSHOT',
      expected_end_at: endAt,
      last_observed_at: last?.at ?? null,
      observed_points: window.length,
      close_return_pct: null,
      max_favorable_pct: null,
      max_adverse_pct: null,
      mover: false,
      captured_before_move: null,
      missed: null
    };
  }
  const returns = window.map(row => movePct(row.price, start.price)).filter(value => value !== null);
  const maxFavorable = returns.length ? Math.max(0, ...returns) : 0;
  const maxAdverse = returns.length ? Math.min(0, ...returns) : 0;
  const closeReturn = movePct(last.price, start.price);
  const crossing = window.find(row => {
    const value = movePct(row.price, start.price);
    return value !== null && value >= thresholdPct;
  }) || null;
  const relevantAlerts = crossing
    ? (alerts || []).filter(alert => alert.at >= start.at - ALERT_RELEVANCE_LOOKBACK_MS && alert.at < crossing.at)
    : [];
  const captured = Boolean(crossing && relevantAlerts.length);
  const missed = Boolean(crossing && start.eligible === true && !captured);
  const lateAlerts = crossing
    ? (alerts || []).filter(alert => alert.at >= crossing.at && alert.at <= endAt)
    : [];
  return {
    status: 'COMPLETE',
    reason: null,
    expected_end_at: endAt,
    last_observed_at: last.at,
    observed_points: window.length,
    close_return_pct: closeReturn,
    max_favorable_pct: maxFavorable,
    max_adverse_pct: maxAdverse,
    mover: Boolean(crossing),
    observed_move_at: crossing?.at ?? null,
    observed_move_delay_ms: crossing ? crossing.at - start.at : null,
    move_threshold_pct: thresholdPct,
    captured_before_move: crossing ? captured : null,
    capturing_radars: [...new Set(relevantAlerts.map(alert => alert.radar))],
    late_alert_radars: [...new Set(lateAlerts.map(alert => alert.radar))],
    missed,
    missed_reason: missed ? rejectionReason(start.coin) : null,
    outcome_source: 'SCAN_JOURNEY_TICKER_SNAPSHOTS',
    sample_quality: 'OBSERVED_SNAPSHOT_PROXY_NOT_CLOSED_OHLC',
    closed_ohlc_confirmed: false
  };
}

export function buildRadarMissedMoverAuditReport({
  cycles = [],
  alertsByRadar = {},
  now = Date.now(),
  minMovePct = DEFAULT_MOVE_THRESHOLD_PCT,
  maxAgeMs = MAX_AUDIT_AGE_MS
} = {}) {
  const asOf = timestamp(now) ?? Date.now();
  const threshold = finite(minMovePct);
  const thresholdPct = threshold !== null && threshold > 0 ? Math.min(1000, threshold) : DEFAULT_MOVE_THRESHOLD_PCT;
  const ageLimit = Math.max(60 * MINUTE_MS, Math.min(180 * DAY_MS, finite(maxAgeMs) ?? MAX_AUDIT_AGE_MS));
  const normalized = normalizeCycleSnapshots(cycles, asOf, ageLimit);
  const snapshots = dedupeSnapshots(normalized.rows);
  const bySymbol = new Map();
  for (const row of snapshots) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
    bySymbol.get(row.symbol).push(row);
  }
  const alertInfo = normalizeAlerts(alertsByRadar, asOf);
  const horizonSummary = Object.fromEntries(RADAR_MISSED_MOVER_HORIZONS.map(horizon => [horizon.key, {
    eligible_baseline_samples: 0,
    complete_samples: 0,
    pending_samples: 0,
    incomplete_samples: 0,
    observed_mover_samples: 0,
    captured_before_move_samples: 0,
    missed_mover_samples: 0,
    missed_symbols: 0,
    average_close_return_pct: null,
    average_max_favorable_pct: null,
    average_max_adverse_pct: null,
    sample_quality: 'OBSERVED_SNAPSHOT_PROXY_NOT_CLOSED_OHLC',
    rate_status: 'INSUFFICIENT_SAMPLE'
  }]));
  const sum = Object.fromEntries(RADAR_MISSED_MOVER_HORIZONS.map(horizon => [horizon.key, {
    close: [], favorable: [], adverse: [], missedSymbols: new Set()
  }]));
  const missedExamples = [];
  const moverSymbols = new Set();
  const eligibleSymbols = new Set();
  let baselines = 0, unknownEligibility = 0, excludedBaselines = 0, capturedMoverSamples = 0;
  const perSymbolRows = [...bySymbol.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [symbol, symbolSnapshots] of perSymbolRows) {
    for (let index = 0; index < symbolSnapshots.length; index++) {
      const start = symbolSnapshots[index];
      baselines++;
      if (start.eligible === null) { unknownEligibility++; continue; }
      if (start.eligible === false) { excludedBaselines++; continue; }
      eligibleSymbols.add(symbol);
      const future = symbolSnapshots.slice(index + 1);
      const alerts = alertInfo.bySymbol.get(symbol) || [];
      for (const horizon of RADAR_MISSED_MOVER_HORIZONS) {
        const result = horizonOutcome({ start, snapshots: future, horizon, now: asOf, alerts, thresholdPct });
        const target = horizonSummary[horizon.key];
        target.eligible_baseline_samples++;
        if (result.status === 'PENDING') { target.pending_samples++; continue; }
        if (result.status === 'INCOMPLETE') { target.incomplete_samples++; continue; }
        target.complete_samples++;
        if (result.close_return_pct !== null) sum[horizon.key].close.push(result.close_return_pct);
        if (result.max_favorable_pct !== null) sum[horizon.key].favorable.push(result.max_favorable_pct);
        if (result.max_adverse_pct !== null) sum[horizon.key].adverse.push(result.max_adverse_pct);
        if (!result.mover) continue;
        target.observed_mover_samples++;
        moverSymbols.add(symbol);
        if (result.captured_before_move) {
          target.captured_before_move_samples++;
          capturedMoverSamples++;
        } else if (result.missed) {
          target.missed_mover_samples++;
          sum[horizon.key].missedSymbols.add(symbol);
          if (missedExamples.length < 100) missedExamples.push({
            symbol,
            radar_snapshot_at: start.at,
            cycle_id: start.cycle_id,
            cycle_number: start.cycle_number,
            entry_price: start.price,
            quote_volume_24h: start.quote_volume_24h,
            horizon: horizon.key,
            move_threshold_pct: thresholdPct,
            observed_move_at: result.observed_move_at,
            observed_move_delay_ms: result.observed_move_delay_ms,
            max_favorable_pct: result.max_favorable_pct,
            max_adverse_pct: result.max_adverse_pct,
            close_return_pct: result.close_return_pct,
            reason: result.missed_reason,
            late_alert_radars: result.late_alert_radars
          });
        }
      }
    }
  }
  for (const horizon of RADAR_MISSED_MOVER_HORIZONS) {
    const item = horizonSummary[horizon.key];
    const values = sum[horizon.key];
    item.missed_symbols = values.missedSymbols.size;
    item.average_close_return_pct = values.close.length
      ? Number((values.close.reduce((a, b) => a + b, 0) / values.close.length).toFixed(5)) : null;
    item.average_max_favorable_pct = values.favorable.length
      ? Number((values.favorable.reduce((a, b) => a + b, 0) / values.favorable.length).toFixed(5)) : null;
    item.average_max_adverse_pct = values.adverse.length
      ? Number((values.adverse.reduce((a, b) => a + b, 0) / values.adverse.length).toFixed(5)) : null;
    item.rate_status = item.complete_samples >= 30 ? 'SAMPLE_N_GE_30_NOT_A_GUARANTEE' : 'INSUFFICIENT_SAMPLE';
  }
  const reasonCounts = {};
  for (const example of missedExamples) reasonCounts[example.reason] = (reasonCounts[example.reason] || 0) + 1;
  const auditTimes = snapshots.map(row => row.at);
  return {
    version: 'RADAR_MISSED_MOVER_AUDIT_V1',
    as_of: new Date(asOf).toISOString(),
    status: snapshots.length ? 'AUDIT_DATA_AVAILABLE' : 'NO_VALID_SCAN_JOURNEY_SNAPSHOTS',
    scope: 'RADAR_8_FULL_MARKET_SCAN_SNAPSHOTS_CROSS_CHECKED_AGAINST_ALL_12_RADAR_ALERT_ARCHIVES',
    market: 'BINANCE_SPOT_USDT',
    source: 'DURABLE_SCAN_JOURNEY_AND_ARCHIVED_ALERTS',
    interpretation: {
      mover_threshold_pct: thresholdPct,
      horizon_values_are_observed_ticker_snapshot_proxies: true,
      closed_ohlc_validation_for_missed_movers: false,
      only_completed_cycles_are_used: true,
      future_or_stale_snapshots_are_excluded: true,
      alert_counts_as_early_only_if_timestamp_precedes_observed_move: true,
      per_minute_snapshot_deduplication: true,
      repeated_baselines_are_not_independent_trades: true,
      unknown_eligibility_is_not_counted_as_a_miss: true,
      no_profitability_or_future_detection_guarantee: true
    },
    coverage: {
      completed_cycles_seen: (Array.isArray(cycles) ? cycles : []).filter(x => x?.radar === 'RADAR_8' && x?.status === 'COMPLETE').length,
      snapshot_rows_after_validation: normalized.rows.length,
      baseline_samples_after_deduplication: snapshots.length,
      symbols_with_snapshots: bySymbol.size,
      eligible_symbols_observed: eligibleSymbols.size,
      unknown_eligibility_baselines: unknownEligibility,
      explicitly_excluded_baselines: excludedBaselines,
      dropped: normalized.dropped,
      first_snapshot_at: auditTimes.length ? Math.min(...auditTimes) : null,
      last_snapshot_at: auditTimes.length ? Math.max(...auditTimes) : null,
      snapshot_bucket_ms: SNAPSHOT_BUCKET_MS,
      max_snapshot_age_ms: ageLimit,
      endpoint_tolerance_ms: MAX_ENDPOINT_GAP_MS
    },
    summary: {
      eligible_baseline_samples: baselines - unknownEligibility - excludedBaselines,
      unique_eligible_symbols: eligibleSymbols.size,
      unique_symbols_with_observed_threshold_moves: moverSymbols.size,
      captured_mover_samples: capturedMoverSamples,
      missed_mover_samples_5m: horizonSummary['5m'].missed_mover_samples,
      missed_mover_samples_15m: horizonSummary['15m'].missed_mover_samples,
      missed_mover_samples_1h: horizonSummary['60m'].missed_mover_samples,
      missed_mover_samples_4h: horizonSummary['4h'].missed_mover_samples,
      missed_mover_samples_24h: horizonSummary['24h'].missed_mover_samples,
      unique_missed_symbols_24h: horizonSummary['24h'].missed_symbols,
      missed_reason_counts_in_returned_examples: reasonCounts
    },
    by_horizon: horizonSummary,
    missed_examples: missedExamples,
    radar_alert_archive_coverage: Object.fromEntries(RADAR_OUTCOME_ARCHIVES.map(radar => [radar.id, {
      name: radar.name,
      archived_alert_rows_loaded: alertInfo.counts[radar.id] || 0
    }])),
    limitations: [
      'This audit uses the Radar 8 full-market scan journey as the per-symbol baseline because that is the available exhaustive scan ledger.',
      'Forward high/low excursions use sampled ticker prices, not continuous trades or closed-candle OHLC; snapshot gaps can hide intracycle moves.',
      'A mover can count more than once through separate one-minute baseline samples; use distinct symbols and the sample definitions when interpreting rates.',
      'This report audits outcomes visible in the retained cycle window only; it does not prove every eligible Binance symbol was retained for every time horizon.'
    ],
    policy: { paper_trading: true, real_order_execution: false, confidence_score: 'UNKNOWN' }
  };
}
