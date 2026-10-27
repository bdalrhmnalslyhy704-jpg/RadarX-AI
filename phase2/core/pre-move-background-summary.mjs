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
