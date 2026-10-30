const finiteOrNull = value => value !== null && value !== undefined &&
  value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value))
    ? Number(value) : null;

const boundedString = (value, fallback, max) =>
  String(value || fallback).slice(0, max);

/**
 * Build a small, bounded status summary from a completed Pre-Move scan.
 * This is diagnostic only: it does not change candidate eligibility or push delivery.
 */
export function buildPreMoveBackgroundScanSummary({snapshot={}, watchAlerts=[], elapsedMs=0}={}) {
  const universe = snapshot?.universe && typeof snapshot.universe === 'object' ? snapshot.universe : {};
  const diagnostics = snapshot?.watch_notification_diagnostics &&
    typeof snapshot.watch_notification_diagnostics === 'object'
      ? snapshot.watch_notification_diagnostics : {};
  const alerts = Array.isArray(watchAlerts) ? watchAlerts : [];
  const nearMissRows = Array.isArray(snapshot?.near_miss_audit) ? snapshot.near_miss_audit : [];

  const blockerCounts = {};
  for (const row of nearMissRows) {
    for (const rawCode of (Array.isArray(row?.blocker_codes) ? row.blocker_codes : [])) {
      const code = boundedString(rawCode, 'UNKNOWN', 80);
      blockerCounts[code] = (blockerCounts[code] || 0) + 1;
    }
  }

  const watchSamples = (Array.isArray(diagnostics.samples) ? diagnostics.samples : [])
    .filter(row => row?.eligible !== true)
    .slice(0, 5)
    .map(row => ({
      symbol: boundedString(row?.symbol, '', 30),
      reason: boundedString(row?.reason, 'UNKNOWN', 100),
      score: finiteOrNull(row?.score),
      session_return_pct: finiteOrNull(row?.session_return_pct),
      one_hour_return_pct: finiteOrNull(row?.one_hour_return_pct),
      data_valid: row?.data_valid === true,
      data_stale: row?.data_stale === true,
      data_quality: finiteOrNull(row?.data_quality),
      liquidity_quality: finiteOrNull(row?.liquidity_quality)
    }));

  const nearMissSamples = nearMissRows.slice(0, 5).map(row => ({
    symbol: boundedString(row?.symbol, '', 30),
    stage: boundedString(row?.stage, 'UNKNOWN', 40),
    score: finiteOrNull(row?.score),
    session_return_pct: finiteOrNull(row?.session_return_pct),
    one_hour_return_pct: finiteOrNull(row?.one_hour_return_pct),
    volume_acceleration: finiteOrNull(row?.volume_acceleration),
    trade_acceleration: finiteOrNull(row?.trade_acceleration),
    data_valid: row?.data_valid === true,
    liquidity_quality: finiteOrNull(row?.liquidity_quality),
    blocker_codes: (Array.isArray(row?.blocker_codes) ? row.blocker_codes : [])
      .slice(0, 8).map(code => boundedString(code, 'UNKNOWN', 80))
  }));

  const rejectionCounts = diagnostics.rejection_counts &&
    typeof diagnostics.rejection_counts === 'object' && !Array.isArray(diagnostics.rejection_counts)
      ? Object.fromEntries(Object.entries(diagnostics.rejection_counts).slice(0, 12))
      : {};

  return {
    discovered: Number(universe.discovered) || 0,
    deep_scanned: Number(universe.deep_scanned) || 0,
    scanned: Number(universe.scanned) || 0,
    valid_data: Number(universe.valid_data) || 0,
    observed_candle_data: Number(universe.observed_candle_data) || 0,
    watch_only: Number(universe.watch_only) || 0,
    actionable: Number(universe.actionable) || 0,
    returned: Number(universe.returned) || 0,
    elapsed_ms: Number(universe.elapsed_ms) || Math.max(0, Number(elapsedMs) || 0),
    eligible_spot_symbols: Number(universe.eligible_spot_symbols) || 0,
    coverage_mode: boundedString(universe.coverage_mode, 'UNKNOWN', 60),
    rotation_cycle: Number(universe.rotation_cycle) || 0,
    rotation_offset: Number(universe.rotation_offset) || 0,
    rotation_width: finiteOrNull(universe.rotation_width),
    pinned_fraction: finiteOrNull(universe.pinned_fraction),
    activity_priority_slots: finiteOrNull(universe.activity_priority_slots),
    ticker_activity_priority_selected: finiteOrNull(universe.ticker_activity_priority_selected),
    rotation_cursor_source: boundedString(universe.rotation_cursor_source, 'UNAVAILABLE', 40),
    rotation_cursor_persisted: typeof universe.rotation_cursor_persisted === 'boolean'
      ? universe.rotation_cursor_persisted : null,
    ticker_activity_signal_count: finiteOrNull(universe.ticker_activity_signal_count),
    ticker_activity_baseline_source: boundedString(universe.ticker_activity_baseline_source, 'UNAVAILABLE', 40),
    ticker_activity_baseline_persisted: typeof universe.ticker_activity_baseline_persisted === 'boolean'
      ? universe.ticker_activity_baseline_persisted : null,
    ticker_activity_baseline_error: universe.ticker_activity_baseline_error
      ? boundedString(universe.ticker_activity_baseline_error, 'UNKNOWN', 160) : null,
    watch_notification_evaluated: Number(diagnostics.evaluated) || 0,
    watch_notification_eligible: Number(diagnostics.eligible) || alerts.length,
    watch_notification_rejected: Number(diagnostics.rejected) || 0,
    watch_notification_rejection_counts: rejectionCounts,
    watch_notification_top_rejections: watchSamples,
    watch_notification_symbols: alerts.map(row => String(row?.symbol || '')).filter(Boolean).slice(0, 3),
    near_miss_review_count: nearMissRows.length,
    near_miss_blocker_counts: Object.fromEntries(
      Object.entries(blockerCounts).sort((a, b) => b[1] - a[1]).slice(0, 12)
    ),
    near_miss_samples: nearMissSamples
  };
}


/**
 * Track outcomes of the actual watch-only push call separately from candidate
 * eligibility. This makes provider-disabled, no-subscription, gate-rejected, and
 * delivery-failed states distinguishable without exposing user/subscription IDs.
 */
export function buildPreMoveNotificationDeliveryState(previous, outcome, now = Date.now()) {
  const base = previous && typeof previous === 'object' ? previous : {};
  const counts = base.status_counts && typeof base.status_counts === 'object' && !Array.isArray(base.status_counts)
    ? { ...base.status_counts } : {};
  const reasons = base.reason_counts && typeof base.reason_counts === 'object' && !Array.isArray(base.reason_counts)
    ? { ...base.reason_counts } : {};
  const lastResults = Array.isArray(base.last_results) ? base.last_results.slice() : [];
  const status = boundedString(outcome?.status, 'UNKNOWN', 80);
  const reason = outcome?.reason ? boundedString(outcome.reason, 'UNKNOWN', 120) : null;
  const sentCount = Math.max(0, Math.min(100, Math.trunc(finiteOrNull(outcome?.sent_count) ?? 0)));
  const attemptedCount = Math.max(0, Math.min(100, Math.trunc(finiteOrNull(outcome?.attempted_count) ?? 0)));
  const attempted = outcome?.attempted === true;
  const symbol = boundedString(outcome?.symbol, '', 30);
  const atMs = Number.isFinite(Number(now)) && Number(now) > 0 ? Number(now) : Date.now();
  const item = {
    at: new Date(atMs).toISOString(),
    symbol,
    status,
    reason,
    attempted,
    attempted_count: attemptedCount,
    sent_count: sentCount,
    error: outcome?.error ? boundedString(outcome.error, 'PUSH_DELIVERY_ERROR', 160) : null
  };
  counts[status] = (Number(counts[status]) || 0) + 1;
  if (reason) reasons[reason] = (Number(reasons[reason]) || 0) + 1;
  lastResults.unshift(item);
  return {
    results: Math.max(0, Math.trunc(Number(base.results) || 0)) + 1,
    send_calls: Math.max(0, Math.trunc(Number(base.send_calls) || 0)) + (attempted ? 1 : 0),
    recipients_attempted: Math.max(0, Math.trunc(Number(base.recipients_attempted) || 0)) + attemptedCount,
    notifications_sent: Math.max(0, Math.trunc(Number(base.notifications_sent) || 0)) + sentCount,
    current_status: status,
    current_reason: reason,
    last_result_at: item.at,
    status_counts: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    reason_counts: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    last_results: lastResults.slice(0, 10)
  };
}
