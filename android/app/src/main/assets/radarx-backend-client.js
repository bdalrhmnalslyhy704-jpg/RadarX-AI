export const DEFAULT_BACKEND_BASE_URL = 'https://radarx-ai-production.up.railway.app';

function assertAllowedBackend(url) {
  if (url.origin !== DEFAULT_BACKEND_BASE_URL || url.pathname !== '/' || url.username || url.password) {
    throw new Error('BACKEND_ORIGIN_NOT_ALLOWED');
  }
}

export function normalizeBackendBaseUrl(raw = DEFAULT_BACKEND_BASE_URL) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return DEFAULT_BACKEND_BASE_URL;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('BACKEND_BASE_URL_MUST_USE_HTTP_OR_HTTPS');
  }
  assertAllowedBackend(url);
  return DEFAULT_BACKEND_BASE_URL;
}

export async function requestJson(baseUrl, path, fetchImpl = globalThis.fetch) {
  try {
    const base = normalizeBackendBaseUrl(baseUrl);
    const response = await fetchImpl(base + path, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, ok: response.ok, body, error: null };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      body: null,
      error: String(error && error.message || error)
    };
  }
}

export async function fetchBackendState(baseUrl, symbol, fetchImpl = globalThis.fetch) {
  const safeSymbol = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(safeSymbol)) {
    throw new Error('INVALID_SYMBOL');
  }

  const base = normalizeBackendBaseUrl(baseUrl);
  const health = await requestJson(base, '/healthz', fetchImpl);
  const readiness = await requestJson(base, '/readyz', fetchImpl);
  const signal = await requestJson(
    base,
    '/api/signal?symbol=' + encodeURIComponent(safeSymbol),
    fetchImpl
  );

  return { base, health, readiness, signal };
}

export function isFreshLiveSignal(response) {
  if (!response || response.status !== 200) return false;

  const status = response && response.body && response.body.signal && response.body.signal.data_status;
  const meta = response && response.body && response.body.meta;

  return (
    status && status.data_stale === false &&
    status && status.data_valid === true &&
    status && status.last_error == null &&
    meta && meta.live === true &&
    meta && meta.paper_trading === true &&
    meta && meta.real_order_execution === false &&
    meta && meta.confidence_score === 'UNKNOWN'
  );
}

export function isFreshLiveState(state) {
  if (!state) return false;
  const readiness = state.readiness;
  return (
    state.health && state.health.status === 200 &&
    readiness && readiness.status === 200 &&
    readiness && readiness.body && readiness.body.data_stale === false &&
    readiness && readiness.body && readiness.body.data_valid === true &&
    readiness && readiness.body && readiness.body.last_error == null &&
    isFreshLiveSignal(state.signal)
  );
}

export function classifyBackendState(state) {
  if (!state || state.health && state.health.status === 0 || state.readiness && readiness.status === 0 || state.signal && state.signal.status === 0) {
    return 'DISCONNECTED';
  }

  if (isFreshLiveState(state)) return 'LIVE_DATA';

  const stale =
    state.readiness && readiness.body && readiness.body.data_stale === true ||
    state.readiness && state.readiness.body && state.readiness.body.reason === 'SNAPSHOT_STALE' ||
    state.signal?.body?.signal?.data_status && status.data_stale === true;

  if (stale || state.readiness && readiness.status === 503 || state.signal && state.signal.status === 503) {
    return 'DATA_STALE';
  }

  return state.health && state.health.status >= 500 || state.readiness && readiness.status >= 500 || state.signal && state.signal.status >= 500
    ? 'DISCONNECTED'
    : 'DATA_UNAVAILABLE';
}
