export function computeFreshness({
  latestSuccessAt = 0,
  latestDataValid = false,
  latestClosedCandle = null,
  source = null,
  lastError = null
} = {}, now = Date.now(), staleMs = 120000) {
  const hasSuccess = Number.isFinite(Number(latestSuccessAt)) && Number(latestSuccessAt) > 0;
  const latestSuccessfulUpdate = hasSuccess ? Number(latestSuccessAt) : null;
  const fetchAgeMs = hasSuccess ? Math.max(0, now - Number(latestSuccessAt)) : null;
  const snapshotFresh = hasSuccess && fetchAgeMs < staleMs;
  const dataValid = latestDataValid === true;
  const noError = lastError == null;
  const candleAgeMs = latestClosedCandle == null ? null : Math.max(0, now - Number(latestClosedCandle));
  const dataStale = !(snapshotFresh && dataValid && noError);
  const live = !dataStale;

  return {
    ready: live,
    live,
    snapshotFresh,
    fetchAgeMs,
    latestSuccessfulUpdate,
    latestClosedCandle: latestClosedCandle ?? null,
    candleAgeMs,
    dataValid,
    dataStale,
    source: source ?? null,
    lastError: lastError ?? null
  };
}

export function buildDataStatus({ base = {}, latestSuccessAt = 0, latestDataValid = false, latestClosedCandle = null, source = null, lastError = null, now = Date.now(), staleMs = 120000 } = {}) {
  const freshness = computeFreshness({ latestSuccessAt, latestDataValid, latestClosedCandle, source, lastError }, now, staleMs);
  return {
    ...base,
    source: freshness.source,
    stale: freshness.dataStale,
    data_stale: freshness.dataStale,
    data_valid: freshness.dataValid,
    latest_successful_update: freshness.latestSuccessfulUpdate,
    fetch_age_ms: freshness.fetchAgeMs,
    latest_closed_candle: freshness.latestClosedCandle,
    candle_age_ms: freshness.candleAgeMs,
    last_error: freshness.lastError
  };
}

export function buildLiveMeta(freshness) {
  return { live: freshness?.live === true };
}
