import { computeFreshness } from './freshness.mjs';

export function getReadyState(state, now = Date.now(), staleMs = 120000) {
  const freshness = computeFreshness({
    latestSuccessAt: state.latestSuccessAt,
    latestDataValid: state.latestDataValid,
    latestClosedCandle: state.latestClosedCandle,
    source: state.latestSource,
    lastError: state.lastError
  }, now, staleMs);

  const status = freshness.ready ? 'ready' : 'not_ready';
  const statusCode = freshness.ready ? 200 : 503;
  const reason = freshness.ready
    ? null
    : freshness.lastError
      ? 'LIVE_DATA_UNAVAILABLE'
      : freshness.dataValid === false
        ? 'INVALID_MARKET_DATA'
        : 'SNAPSHOT_STALE';

  return {
    statusCode,
    body: {
      status,
      live_data_ready: freshness.ready,
      latest_successful_update: freshness.latestSuccessfulUpdate,
      fetch_age_ms: freshness.fetchAgeMs,
      latest_closed_candle: freshness.latestClosedCandle,
      candle_age_ms: freshness.candleAgeMs,
      data_stale: freshness.dataStale,
      data_valid: freshness.dataValid,
      source: freshness.source,
      last_error: freshness.lastError,
      reason
    }
  };
}
