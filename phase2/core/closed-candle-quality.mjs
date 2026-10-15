const finite = value => {
  if (value === null || value === undefined || typeof value === 'boolean' ||
      (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function assessClosedCandleSeries(rows, {
  now = Date.now(),
  intervalMs,
  minCount,
  maxAgeMs,
  label = 'CANDLES'
} = {}) {
  const input = Array.isArray(rows) ? rows : [];
  const required = Math.max(1, Math.trunc(Number(minCount) || 1));
  const interval = finite(intervalMs);
  const maxAge = finite(maxAgeMs);
  const valid = input.filter(row => {
    const candle = row && typeof row === 'object' ? row : {};
    const openTime = finite(candle.openTime), closeTime = finite(candle.closeTime);
    const open = finite(candle.open), high = finite(candle.high);
    const low = finite(candle.low), close = finite(candle.close), volume = finite(candle.volume);
    return candle.closed !== false && openTime !== null && closeTime !== null &&
      closeTime <= Number(now) && closeTime >= openTime &&
      open !== null && high !== null && low !== null && close !== null && volume !== null &&
      open > 0 && high > 0 && low > 0 && close > 0 && volume >= 0 &&
      high >= Math.max(open, close) && low <= Math.min(open, close);
  }).sort((a, b) => Number(a.openTime) - Number(b.openTime));
  if (valid.length < required) {
    return { ready: false, status: 'INSUFFICIENT_DATA', reason: label + '_COUNT_BELOW_MINIMUM',
      count: valid.length, required, age_ms: null, gap_count: null };
  }
  const recent = valid.slice(-required);
  if (!Number.isFinite(interval) || interval <= 0) {
    return { ready: false, status: 'INVALID_CONFIG', reason: label + '_INTERVAL_INVALID',
      count: recent.length, required, age_ms: null, gap_count: null };
  }
  let gapCount = 0;
  for (let i = 1; i < recent.length; i++) {
    const difference = Number(recent[i].openTime) - Number(recent[i - 1].openTime);
    if (difference !== interval) gapCount++;
  }
  const latestClose = Number(recent.at(-1).closeTime);
  const age = Number(now) - latestClose;
  if (gapCount > 0) {
    return { ready: false, status: 'INCOMPLETE_DATA', reason: label + '_SEQUENCE_HAS_GAPS',
      count: recent.length, required, age_ms: Number.isFinite(age) ? Math.max(0, age) : null,
      gap_count: gapCount, latest_close_time: latestClose };
  }
  if (!Number.isFinite(age) || age < 0) {
    return { ready: false, status: 'INVALID_DATA', reason: label + '_LATEST_CLOSE_TIME_INVALID',
      count: recent.length, required, age_ms: null, gap_count: 0, latest_close_time: latestClose };
  }
  if (!Number.isFinite(maxAge) || maxAge <= 0 || age > maxAge) {
    return { ready: false, status: 'STALE_DATA', reason: label + '_LATEST_CANDLE_STALE',
      count: recent.length, required, age_ms: age, max_age_ms: maxAge,
      gap_count: 0, latest_close_time: latestClose };
  }
  return { ready: true, status: 'READY', reason: null, count: recent.length, required,
    age_ms: age, max_age_ms: maxAge, gap_count: 0, latest_close_time: latestClose };
}

export function assessCandleReadinessSet(checks) {
  const rows = Object.entries(checks || {});
  const failed = rows.filter(([, value]) => !value?.ready);
  return {
    ready: rows.length > 0 && failed.length === 0,
    status: failed.some(([, value]) => value?.status === 'STALE_DATA') ? 'STALE_DATA' :
      failed.some(([, value]) => value?.status === 'INVALID_CONFIG' || value?.status === 'INVALID_DATA') ? 'INVALID_DATA' :
      failed.length ? 'INCOMPLETE_DATA' : 'READY',
    reason_codes: failed.map(([name, value]) => name + ':' + String(value?.reason || 'NOT_READY')),
    checks: Object.fromEntries(rows)
  };
}
