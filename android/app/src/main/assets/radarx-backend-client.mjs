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

export function isFreshLiveState(state) {
  if (!state) return false;
  const health = state.health;
  const signal = state.signal;
  return health && health.status === 200 && isFreshLiveSignal(signal);
}

export function classifyBackendState(state) {
  const readiness = state && state.readiness;
  const health = state && state.health;
  const signal = state && state.signal;

  if (!state ||
      (health && health.status === 0) ||
      (readiness && readiness.status === 0) ||
      (signal && signal.status === 0)) {
    return 'DISCONNECTED';
  }

  if (isFreshLiveState(state)) return 'LIVE_DATA';

  const readinessBody = readiness && readiness.body;
  const signalStatus = signal && signal.body && signal.body.signal && signal.body.signal.data_status;
  const stale =
    (readinessBody && readinessBody.data_stale === true) ||
    (readinessBody && readinessBody.reason === 'SNAPSHOT_STALE') ||
    (signalStatus && signalStatus.data_stale === true);

  if (stale ||
      (readiness && readiness.status === 503) ||
      (signal && signal.status === 503)) {
    return 'DATA_STALE';
  }

  return (health && health.status >= 500) ||
         (readiness && readiness.status >= 500) ||
         (signal && signal.status >= 500)
    ? 'DISCONNECTED'
    : 'DATA_UNAVAILABLE';
}


export async function getMarketRadar({ quote = 'USDT', limit = 20 } = {}, fetchImpl = globalThis.fetch) {
  const safeQuote = String(quote || 'USDT').trim().toUpperCase();
  if (!/^[A-Z]{2,10}$/.test(safeQuote)) throw new Error('INVALID_QUOTE');
  const safeLimit = Number(limit);
  if (!Number.isInteger(safeLimit) || safeLimit < 1 || safeLimit > 50) throw new Error('INVALID_LIMIT');
  const base = normalizeBackendBaseUrl(DEFAULT_BACKEND_BASE_URL);
  return requestJson(
    base,
    '/api/market-radar?quote=' + encodeURIComponent(safeQuote) + '&limit=' + encodeURIComponent(String(safeLimit)),
    fetchImpl
  );
}

export async function getPreMoveRadar({quote = 'USDT', limit = 30 } = {}, fetchImpl = globalThis.fetch) {
  const safeQuote = String(quote || 'USDT').trim().toUpperCase();
  if (!/^[A-Z]{2,10}$/.test(safeQuote)) throw new Error('INVALID_QUOTE');
  const safeLimit = Number(limit);
  if (!Number.isInteger(safeLimit) || safeLimit < 10 || safeLimit > 50) throw new Error('INVALID_LIMIT');
  const base = normalizeBackendBaseUrl(DEFAULT_BACKEND_BASE_URL);
  return requestJson(
    base,
    '/api/pre-move-radar?quote=' + encodeURIComponent(safeQuote) + '&limit=' + encodeURIComponent(String(safeLimit)),
    fetchImpl
  );
}


export async function getMoveRadar({quote='USDT',limit=50,since=0}={},fetchImpl=globalThis.fetch){
  const safeQuote=String(quote||'USDT').trim().toUpperCase();
  if(!/^[A-Z]{2,10}$/.test(safeQuote))throw new Error('INVALID_QUOTE');
  const safeLimit=Number(limit);
  if(!Number.isInteger(safeLimit)||safeLimit<1||safeLimit>100)throw new Error('INVALID_LIMIT');
  const safeSince=Number(since);
  const sinceParam=Number.isFinite(safeSince)&&safeSince>0?'&since='+encodeURIComponent(String(Math.trunc(safeSince))):'';
  const base=normalizeBackendBaseUrl(DEFAULT_BACKEND_BASE_URL);
  return requestJson(base,'/api/move-radar?quote='+encodeURIComponent(safeQuote)+'&limit='+encodeURIComponent(String(safeLimit))+sinceParam,fetchImpl);
}
