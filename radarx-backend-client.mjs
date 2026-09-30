export const DEFAULT_BACKEND_BASE_URL = 'https://radarx-ai-production.up.railway.app';

export function normalizeBackendBaseUrl(raw = DEFAULT_BACKEND_BASE_URL) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return DEFAULT_BACKEND_BASE_URL;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('BACKEND_BASE_URL_MUST_USE_HTTP_OR_HTTPS');
  }
  return url.toString().replace(/\/$/, '');
}

export async function requestJson(baseUrl, path, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(normalizeBackendBaseUrl(baseUrl) + path, {
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
      error: String(error?.message || error)
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

  const status = response.body?.signal?.data_status;
  const meta = response.body?.meta;

  return (
    status?.data_stale === false &&
    status?.data_valid === true &&
    status?.last_error == null &&
    meta?.live === true &&
    meta?.paper_trading === true &&
    meta?.real_order_execution === false &&
    meta?.confidence_score === 'UNKNOWN'
  );
}

export function classifySignalResponse(response) {
  if (!response || response.status === 0) return 'DISCONNECTED';
  if (isFreshLiveSignal(response)) return 'LIVE_DATA';

  const stale = response.body?.signal?.data_status?.data_stale === true;
  const readinessStale = response.body?.reason === 'SNAPSHOT_STALE';

  if (response.status === 503 && (stale || readinessStale)) return 'DATA_STALE';
  if (stale) return 'DATA_STALE';

  return response.status >= 500 ? 'DISCONNECTED' : 'DATA_UNAVAILABLE';
}
