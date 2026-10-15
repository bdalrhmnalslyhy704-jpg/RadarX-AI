const RADAR_TELEMETRY_ALIASES = Object.freeze({
  EARLY_MOVE_RADAR: ['RADAR1', 'RADAR_1', 'EARLY_MOVE_RADAR'],
  STRONG_MOVE_RADAR: ['RADAR2', 'RADAR_2', 'STRONG_MOVE_RADAR'],
  ROTATION_LAG_RADAR: ['RADAR3', 'RADAR_3', 'ROTATION_LAG_RADAR'],
  LIQUIDITY_ABSORPTION_RADAR: ['RADAR4', 'RADAR_4', 'LIQUIDITY_ABSORPTION_RADAR'],
  KAHIR_RADAR: ['RADAR5', 'RADAR_5', 'KAHIR_RADAR'],
  DOOMSDAY_RADAR: ['RADAR6', 'RADAR_6', 'DOOMSDAY_RADAR'],
  ALMUQAWIM_RADAR: ['RADAR7', 'RADAR_7', 'ALMUQAWIM_RADAR'],
  EARLY_EXPANSION_RADAR: ['RADAR8', 'RADAR_8', 'EARLY_EXPANSION_RADAR'],
  FALCON_EYE_RADAR: ['RADAR9', 'RADAR_9', 'RADAR9_FALCON_EYE', 'FALCON_EYE_RADAR'],
  COIN_HUNTER_RADAR: ['RADAR10', 'RADAR_10', 'RADAR10_COIN_HUNTER', 'COIN_HUNTER_RADAR'],
  WHALE_ACCUMULATION_RADAR: ['RADAR11', 'RADAR_11', 'RADAR11_WHALE', 'WHALE_ACCUMULATION_RADAR'],
  PROFESSOR_RADAR: ['RADAR12', 'RADAR_12', 'RADAR12_PROFESSOR', 'PROFESSOR_RADAR']
});

function numeric(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function timestamp(value) {
  const number = numeric(value);
  if (number !== null && number > 0) return number;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function percentile(values, p) {
  const sorted = values.map(numeric).filter(value => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] * 100) / 100;
}
function safeTopReasons(events) {
  const counts = new Map();
  for (const event of events) {
    if (event?.event_type !== 'CANDIDATE_DECISION' || event?.accepted !== false) continue;
    for (const reason of Array.isArray(event.reason_codes) ? event.reason_codes : []) {
      const key = String(reason || '').slice(0, 120);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([reason, count]) => ({reason, count}));
}

/**
 * Build a read-only live audit. It reports observed readiness and gaps; it never
 * changes a radar threshold, promotes incomplete candles, or turns paper trading off.
 */
export function buildRadarReadinessAudit({
  radars = [], swarm = null, telemetry = null, candleCache = null,
  warmupReport = null, now = Date.now(), staleCycleAfterMs = 10 * 60_000
} = {}) {
  const events = Array.isArray(telemetry?.events) ? telemetry.events : [];
  const aliasMap = new Map();
  for (const [id, aliases] of Object.entries(RADAR_TELEMETRY_ALIASES)) {
    aliasMap.set(id, new Set([id, ...aliases]));
  }
  const perRadar = (Array.isArray(radars) ? radars : []).map(entry => {
    const id = String(entry?.radar || entry?.id || 'UNKNOWN_RADAR').trim().toUpperCase();
    const aliases = aliasMap.get(id) || new Set([id]);
    const matching = events.filter(event => aliases.has(String(event?.radar || '').trim().toUpperCase()));
    const cycles = matching.filter(event => event?.event_type === 'BACKGROUND_CYCLE')
      .sort((a, b) => (timestamp(b?.decision_at) ?? 0) - (timestamp(a?.decision_at) ?? 0));
    const decisions = matching.filter(event => event?.event_type === 'CANDIDATE_DECISION');
    const latestCycle = cycles[0] || null;
    const cycleAt = timestamp(latestCycle?.decision_at);
    const cycleAge = cycleAt === null ? null : Math.max(0, Number(now) - cycleAt);
    const cycleDurations = cycles.map(event => numeric(event?.pipeline_latency_ms)).filter(value => value !== null);
    const errors = cycles.filter(event =>
      (Array.isArray(event?.reason_codes) ? event.reason_codes : []).some(reason => String(reason).startsWith('CYCLE_ERROR:')));
    const health = entry?.health && typeof entry.health === 'object' ? entry.health : {};
    const healthActivityAt = timestamp(health.last_scan_at ?? health.last_tick_at ?? health.last_alert_at ?? health.updated_at);
    return {
      radar: id,
      radar_name: String(entry?.radar_name || entry?.name || id),
      running: entry?.running === true || health.running === true,
      health_running: health.running === true,
      busy: health.busy === true,
      last_error: String(health.last_error || health.error || '').slice(0, 200) || null,
      last_activity_at: cycleAt ?? healthActivityAt,
      last_cycle_at: cycleAt,
      last_cycle_age_ms: cycleAge,
      last_cycle_duration_ms: numeric(latestCycle?.pipeline_latency_ms),
      cycle_duration_ms_p50: percentile(cycleDurations, 0.50),
      cycle_duration_ms_p95: percentile(cycleDurations, 0.95),
      cycles_observed: cycles.length,
      cycle_errors: errors.length,
      cycle_state: latestCycle
        ? (errors.some(event => event.id === latestCycle.id) ? 'LAST_CYCLE_ERROR' : 'OBSERVED')
        : 'NO_CYCLE_TELEMETRY_YET',
      cycle_is_stale: cycleAge !== null && cycleAge > Math.max(60_000, Number(staleCycleAfterMs) || 10 * 60_000),
      candidate_decisions_observed: decisions.length,
      gate_accepted: decisions.filter(event => event.accepted === true).length,
      gate_rejected: decisions.filter(event => event.accepted === false).length,
      decision_latency_ms_p50: percentile(decisions.map(event => event.pipeline_latency_ms), 0.50),
      decision_latency_ms_p95: percentile(decisions.map(event => event.pipeline_latency_ms), 0.95),
      top_rejection_reasons: safeTopReasons(matching)
    };
  });

  const expected = Math.max(1, Math.trunc(numeric(swarm?.expected_count) ?? 12));
  const registered = perRadar.length;
  const running = perRadar.filter(radar => radar.running).length;
  const failed = numeric(swarm?.failed_count) ?? perRadar.filter(radar => !radar.running).length;
  const cacheExpected = Math.max(0, Math.trunc(numeric(candleCache?.expected_symbols) ?? 0));
  const cacheReady = Math.max(0, Math.trunc(numeric(candleCache?.ready_symbols) ?? 0));
  const coverageRatio = cacheExpected > 0 ? Math.min(1, cacheReady / cacheExpected) : null;
  const fullCacheReady = candleCache?.full_market_coverage_ready === true &&
    cacheExpected > 0 && cacheReady >= cacheExpected &&
    candleCache?.websocket_live === true && candleCache?.websocket_sync_ready === true;
  const cacheStatus = cacheExpected === 0 ? 'UNAVAILABLE'
    : fullCacheReady ? 'READY'
      : cacheReady > 0 ? 'WARMING' : 'UNAVAILABLE';

  const readinessReasons = [];
  if (registered !== expected) readinessReasons.push('RADAR_REGISTRATION_INCOMPLETE');
  for (const radar of perRadar) {
    if (!radar.running) readinessReasons.push('RADAR_NOT_RUNNING:' + radar.radar);
    if (radar.cycle_is_stale) readinessReasons.push('RADAR_CYCLE_STALE:' + radar.radar);
  }
  const missingCycleTelemetry = perRadar.filter(radar => radar.cycles_observed === 0);
  for (const radar of missingCycleTelemetry) readinessReasons.push('RADAR_CYCLE_TELEMETRY_MISSING:' + radar.radar);
  if (swarm?.status && swarm.status !== 'RUNNING') readinessReasons.push('RADAR_SWARM_' + String(swarm.status).toUpperCase());
  if (!fullCacheReady) readinessReasons.push('CLOSED_CANDLE_CACHE_' + cacheStatus);
  if (candleCache?.websocket_live !== true) readinessReasons.push('CANDLE_WEBSOCKET_NOT_LIVE');
  if (candleCache?.websocket_sync_ready !== true) readinessReasons.push('CANDLE_WEBSOCKET_NOT_SYNC_READY');

  const allWorkersRunning = registered === expected && running === expected &&
    failed === 0 && (!swarm?.status || swarm.status === 'RUNNING');
  const allCyclesObserved = missingCycleTelemetry.length === 0;
  const noStaleCycles = !perRadar.some(radar => radar.cycle_is_stale);
  const status = allWorkersRunning && allCyclesObserved && fullCacheReady && noStaleCycles ? 'READY'
    : allWorkersRunning && allCyclesObserved && cacheStatus === 'WARMING' && noStaleCycles ? 'WARMING'
      : 'DEGRADED';

  const warmup = warmupReport && typeof warmupReport === 'object' ? {
    status: String(warmupReport.status || 'UNKNOWN'),
    requested_symbols: numeric(warmupReport.requested_symbols),
    ready_before: numeric(warmupReport.ready_before),
    ready_after: numeric(warmupReport.ready_after),
    expected_symbols: numeric(warmupReport.expected_symbols),
    fetch_successes: numeric(warmupReport.fetch_successes),
    fetch_errors: numeric(warmupReport.fetch_errors),
    still_not_ready: numeric(warmupReport.still_not_ready),
    completed_at_ms: numeric(warmupReport.completed_at_ms)
  } : null;

  return {
    audit: 'RADARX_LIVE_READINESS_AUDIT_V1',
    as_of: new Date(Number(now)).toISOString(),
    status,
    readiness_reasons: [...new Set(readinessReasons)],
    summary: {
      expected_radars: expected,
      registered_radars: registered,
      running_radars: running,
      failed_radars: failed,
      radars_with_stale_cycles: perRadar.filter(radar => radar.cycle_is_stale).length,
      radars_without_cycle_telemetry: missingCycleTelemetry.length,
      candle_cache_status: cacheStatus,
      candle_cache_ready_symbols: cacheReady,
      candle_cache_expected_symbols: cacheExpected,
      candle_cache_coverage_ratio: coverageRatio,
      websocket_live: candleCache?.websocket_live === true,
      websocket_sync_ready: candleCache?.websocket_sync_ready === true,
      full_market_candle_coverage_ready: fullCacheReady,
      telemetry_events_retained: events.length,
      telemetry_total_recorded: numeric(telemetry?.total_recorded) ?? null
    },
    market_data: {
      state: candleCache?.state || 'UNKNOWN',
      running: candleCache?.running === true,
      ready_symbols: cacheReady,
      expected_symbols: cacheExpected,
      missing_symbols: numeric(candleCache?.missing_symbols),
      stale_symbols: numeric(candleCache?.stale_symbols),
      incomplete_symbols: numeric(candleCache?.incomplete_symbols),
      cached_closed_candles: numeric(candleCache?.cached_closed_candles),
      websocket_live: candleCache?.websocket_live === true,
      websocket_subscription_complete: candleCache?.websocket_subscription_complete === true,
      websocket_subscribed_symbols: numeric(candleCache?.websocket_subscribed_symbols),
      websocket_sync_ready: candleCache?.websocket_sync_ready === true,
      websocket_advanced_symbols: numeric(candleCache?.websocket_advanced_symbols),
      full_market_coverage_ready: fullCacheReady,
      last_error: candleCache?.last_error || null,
      warmup
    },
    radars: perRadar,
    policy: {
      build_version: 'Build 224',
      market: 'SPOT',
      paper_trading: true,
      real_order_execution: false,
      confidence_score: 'UNKNOWN',
      detection_thresholds_changed: false,
      live_orders_enabled: false
    }
  };
}
