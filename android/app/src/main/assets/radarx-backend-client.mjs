export const DEFAULT_BACKEND_BASE_URL = 'https://radarx-ai-triple-production.up.railway.app';
export const BACKEND_FALLBACK_URLS = Object.freeze([
  'https://radarx-ai-production.up.railway.app'
]);

function assertAllowedBackend(url) {
  const allowed = new Set([DEFAULT_BACKEND_BASE_URL, ...BACKEND_FALLBACK_URLS]);
  if (!allowed.has(url.origin) || url.pathname !== '/' || url.username || url.password) {
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

export async function requestJson(baseUrl, path, fetchImpl = globalThis.fetch, timeoutMs = 65000) {
  let firstError = null;
  const bases = [normalizeBackendBaseUrl(baseUrl), ...BACKEND_FALLBACK_URLS];
  for (const base of bases) {
    try {
      const response = await Promise.race([
        fetchImpl(base + path, {
          method: 'GET',
          cache: 'no-store',
          headers: { Accept: 'application/json' }
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('BACKEND_TIMEOUT')), timeoutMs))
      ]);
      let body = null;
      try { body = await response.json(); } catch {}
      if (response.ok) {
        return { status: response.status, ok: true, body, error: null, base };
      }
      if (response.status === 404 && base !== bases.at(-1)) {
        firstError = new Error('HTTP_404');
        continue;
      }
      if (response.status >= 400 && response.status < 500) {
        return { status: response.status, ok: false, body, error: 'HTTP_' + response.status, base };
      }
      firstError = new Error('HTTP_' + response.status);
    } catch (error) {
      firstError ||= error;
    }
  }
  return {
    status: 0,
    ok: false,
    body: null,
    error: String(firstError?.message || firstError || 'BACKEND_CONNECTION_FAILED')
  };
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

export async function getBottomRadar({quote = 'USDT', limit = 10} = {}, fetchImpl = globalThis.fetch) {
  const safeQuote = String(quote || 'USDT').trim().toUpperCase();
  if (!/^[A-Z]{2,10}$/.test(safeQuote)) throw new Error('INVALID_QUOTE');
  const safeLimit = Number(limit);
  if (!Number.isInteger(safeLimit) || safeLimit < 1 || safeLimit > 50) throw new Error('INVALID_LIMIT');
  const base = normalizeBackendBaseUrl(DEFAULT_BACKEND_BASE_URL);
  return requestJson(
    base,
    '/api/bottom-radar?quote=' + encodeURIComponent(safeQuote) + '&limit=' + encodeURIComponent(String(safeLimit)),
    fetchImpl,
    180000
  );
}

export async function getKahirRadar({quote = 'USDT', limit = 20, since = 0, scan = true} = {}, fetchImpl = globalThis.fetch) {
  const safeQuote = String(quote || 'USDT').trim().toUpperCase();
  const safeLimit = Number(limit);
  if (!/^[A-Z]{2,10}$/.test(safeQuote)) throw new Error('INVALID_QUOTE');
  if (!Number.isInteger(safeLimit) || safeLimit < 1 || safeLimit > 50) throw new Error('INVALID_LIMIT');
  const safeSince = Number(since);
  const sinceParam = Number.isFinite(safeSince) && safeSince > 0 ? '&since=' + encodeURIComponent(String(Math.trunc(safeSince))) : '';
  const scanParam = scan ? '&scan=1' : '';
  const base = normalizeBackendBaseUrl(DEFAULT_BACKEND_BASE_URL);
  return requestJson(base, '/api/kahir-radar?quote=' + encodeURIComponent(safeQuote) + '&limit=' + encodeURIComponent(String(safeLimit)) + sinceParam + scanParam, fetchImpl, 180000);
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
export async function getSymbolDeepScan(symbol, fetchImpl = globalThis.fetch) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9_\/-]{2,20}$/.test(raw)) throw new Error('INVALID_SYMBOL');
  const base = normalizeBackendBaseUrl(DEFAULT_BACKEND_BASE_URL);
  return requestJson(
    base,
    '/api/symbol-deep-scan?symbol=' + encodeURIComponent(raw),
    fetchImpl
  );
}


export async function getAlMuqawimRadar({limit=20,since=0}={},fetchImpl=globalThis.fetch){
  const safeLimit=Number(limit);
  if(!Number.isInteger(safeLimit)||safeLimit<1||safeLimit>100)throw new Error('INVALID_LIMIT');
  const safeSince=Number(since);
  const sinceParam=Number.isFinite(safeSince)&&safeSince>0?'&since='+encodeURIComponent(String(Math.trunc(safeSince))):'';
  const base=normalizeBackendBaseUrl(DEFAULT_BACKEND_BASE_URL);
  return requestJson(base,'/api/almuqawim-radar?limit='+encodeURIComponent(String(safeLimit))+sinceParam,fetchImpl,120000);
}

export async function getProfessorRadar({quote='USDT',limit=10,since=0,scan=true}={},fetchImpl=globalThis.fetch){
  const safeQuote=String(quote||'USDT').trim().toUpperCase();
  const safeLimit=Number(limit);
  if(!/^[A-Z]{2,10}$/.test(safeQuote))throw new Error('INVALID_QUOTE');
  if(!Number.isInteger(safeLimit)||safeLimit<1||safeLimit>50)throw new Error('INVALID_LIMIT');
  const safeSince=Number(since);
  const sinceParam=Number.isFinite(safeSince)&&safeSince>0?'&since='+encodeURIComponent(String(Math.trunc(safeSince))):'';
  const scanParam=scan?'&scan=1':'';
  const base=normalizeBackendBaseUrl(DEFAULT_BACKEND_BASE_URL);
  return requestJson(base,'/api/professor-radar?quote='+encodeURIComponent(safeQuote)+'&limit='+encodeURIComponent(String(safeLimit))+sinceParam+scanParam,fetchImpl,180000);
}

export async function getKingIntelligence({symbol,deep=true}={},fetchImpl=globalThis.fetch){
  const raw=String(symbol||'').trim().toUpperCase();
  if(!/^[A-Z0-9]{5,20}$/.test(raw))throw new Error('INVALID_SYMBOL');
  const base=normalizeBackendBaseUrl(DEFAULT_BACKEND_BASE_URL);
  return requestJson(base,'/api/king?symbol='+encodeURIComponent(raw)+'&deep='+(deep?'1':'0'),fetchImpl,120000);
}
export async function getKingMarket({limit=5,deep=false}={},fetchImpl=globalThis.fetch){
  const safeLimit=Number(limit);
  if(!Number.isInteger(safeLimit)||safeLimit<1||safeLimit>10)throw new Error('INVALID_LIMIT');
  const base=normalizeBackendBaseUrl(DEFAULT_BACKEND_BASE_URL);
  return requestJson(base,'/api/king-market?limit='+encodeURIComponent(String(safeLimit))+'&deep='+(deep?'1':'0'),fetchImpl,120000);
}
export async function getRadarStatus(fetchImpl = globalThis.fetch) {
  const base = normalizeBackendBaseUrl(DEFAULT_BACKEND_BASE_URL);
  return requestJson(base, '/api/radar-status', fetchImpl);
}

export async function getRadarAlerts({radar='ALL',limit=20,since=0}={}, fetchImpl = globalThis.fetch) {
  const safeRadar=String(radar||'ALL').trim().toUpperCase();
  if(!/^[A-Z0-9_]{2,40}$/.test(safeRadar)) throw new Error('INVALID_RADAR');
  const safeLimit=Number(limit);
  if(!Number.isInteger(safeLimit)||safeLimit<1||safeLimit>100) throw new Error('INVALID_LIMIT');
  const safeSince=Number(since);
  const sinceParam=Number.isFinite(safeSince)&&safeSince>0?'&since='+encodeURIComponent(String(Math.trunc(safeSince))):'';
  const base=normalizeBackendBaseUrl(DEFAULT_BACKEND_BASE_URL);
  return requestJson(base,'/api/radar-alerts?radar='+encodeURIComponent(safeRadar)+'&limit='+encodeURIComponent(String(safeLimit))+sinceParam,fetchImpl);
}

export async function setRadarState(radar, action, fetchImpl = globalThis.fetch) {
  const safeRadar=String(radar||'').trim().toUpperCase();
  const safeAction=String(action||'').trim().toLowerCase();
  if(!/^[A-Z0-9_]{2,40}$/.test(safeRadar)) throw new Error('INVALID_RADAR');
  if(!['start','stop'].includes(safeAction)) throw new Error('INVALID_RADAR_ACTION');
  const bases=[normalizeBackendBaseUrl(DEFAULT_BACKEND_BASE_URL),...BACKEND_FALLBACK_URLS];
  let lastError=null;
  for(const base of bases){
    try{
      const response=await Promise.race([
        fetchImpl(base+'/api/radar-control?radar='+encodeURIComponent(safeRadar)+'&action='+encodeURIComponent(safeAction),{
          method:'GET',cache:'no-store',headers:{Accept:'application/json'}
        }),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('BACKEND_TIMEOUT')),15000))
      ]);
      let body=null;try{body=await response.json();}catch{}
      if(response.status===404&&base!==bases.at(-1))continue;
      return {status:response.status,ok:response.ok,body,error:null,base};
    }catch(error){lastError=error;}
  }
  return {status:0,ok:false,body:null,error:String(lastError?.message||lastError||'BACKEND_CONNECTION_FAILED')};
}

export async function getCoinHunterRadar({quote='USDT',limit=16,scan=false}={},fetchImpl=globalThis.fetch){
  const safeQuote=String(quote||'USDT').trim().toUpperCase();
  const safeLimit=Number(limit);
  if(!/^[A-Z]{2,10}$/.test(safeQuote))throw new Error('INVALID_QUOTE');
  if(!Number.isInteger(safeLimit)||safeLimit<1||safeLimit>50)throw new Error('INVALID_LIMIT');
  const base=normalizeBackendBaseUrl(DEFAULT_BACKEND_BASE_URL);
  const scanParam=scan?'&scan=1':'';
  return requestJson(base,'/api/coin-hunter-radar?quote='+encodeURIComponent(safeQuote)+'&limit='+encodeURIComponent(String(safeLimit))+scanParam,fetchImpl,130000);
}
