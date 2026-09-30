export function getReadyState(state, now = Date.now(), staleMs = 120000) {
  const liveDataReady =
    state.latestSuccessAt > 0 &&
    now - state.latestSuccessAt < staleMs &&
    state.lastError === null;

  return {
    statusCode: liveDataReady ? 200 : 503,
    body: {
      status: liveDataReady ? 'ready' : 'not_ready',
      live_data_ready: liveDataReady,
      latest_successful_update: state.latestSuccessAt || null,
      source: state.latestSource,
      last_error: state.lastError,
      reason: liveDataReady ? null : 'LIVE_DATA_NOT_READY'
    }
  };
}
