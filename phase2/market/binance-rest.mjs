import {normalizeEpochMs} from '../core/data-quality.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after');
  if (raw == null) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(raw);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}

export class RestRateLimitError extends Error {
  constructor(retryMs) {
    super('BINANCE_RATE_LIMIT');
    this.name = 'RestRateLimitError';
    this.retryMs = retryMs;
    this.status = 429;
  }
}

/*
 * All RadarX RestClient instances share this broker.
 * The app intentionally creates separate clients so each radar can fail independently,
 * but Binance rate limits apply to the source/IP rather than to a JavaScript object.
 * A process-wide budget + in-flight coalescing prevents the 11-radar fleet from
 * stampeding the public API at the same time.
 */
const SHARED = {
  inflight: new Map(),
  cache: new Map(),
  cachePruneAt: 0,
  usedAt: [],
  lastRequestAt: 0,
  rateLimitedUntil: 0,
  budgetQueue: Promise.resolve(),
  observedUsedWeight1m: null,
  observedUsedWeightAt: null,
  klineObservers: new Set()
};

// Keep conservative count and request-weight ceilings. The request-budget
// lock is held only while checking/reserving a slot, never during rate-limit sleep;
// otherwise one heavy request can block lighter requests that still fit the budget.
const SHARED_MAX_REQUESTS_PER_MINUTE = 600;
const SHARED_MAX_REQUEST_WEIGHT_PER_MINUTE = 4000;
const SHARED_MIN_INTERVAL_MS = 100;
// Cache recent public Klines long enough for overlapping radars to reuse them,
// but keep a strict entry cap so cross-radar reuse cannot grow process RSS without bound.
const SHARED_MAX_CACHE_ENTRIES = 256;
const SHARED_CACHE_PRUNE_INTERVAL_MS = 1000;

export function estimateBinanceRequestWeight(path, query = {}) {
  if (path === '/api/v3/exchangeInfo') return 20;
  // Current Binance Spot weight: 2 with one symbol, 4 for all book tickers.
  if (path === '/api/v3/ticker/bookTicker') return query.symbol ? 2 : 4;
  // Binance Spot GET /api/v3/aggTrades has a request weight of 4.
  if (path === '/api/v3/aggTrades') return 4;
  if (path === '/api/v3/ticker/24hr') {
    if (query.symbol) return 2;
    if (query.symbols) {
      let count = 0;
      try {
        const parsed = typeof query.symbols === 'string' ? JSON.parse(query.symbols) : query.symbols;
        count = Array.isArray(parsed) ? parsed.length : 0;
      } catch {}
      if (count > 0 && count <= 20) return 2;
      if (count > 20 && count <= 100) return 40;
    }
    return 80;
  }
  if (path === '/api/v3/klines') {
    const limit = Math.max(1, Number(query.limit) || 500);
    return limit <= 99 ? 1 : limit <= 499 ? 2 : limit <= 1000 ? 5 : 10;
  }
  if (path === '/api/v3/depth') {
    const limit = Math.max(1, Number(query.limit) || 100);
    return limit <= 100 ? 5 : limit <= 500 ? 25 : limit <= 1000 ? 50 : 250;
  }
  return 1;
}

function waitUntilMs(entries, now, requiredWeight) {
  let remaining = entries.reduce((sum, item) => sum + item.weight, 0);
  for (const item of entries) {
    remaining -= item.weight;
    if (remaining + requiredWeight <= SHARED_MAX_REQUEST_WEIGHT_PER_MINUTE) {
      return Math.max(0, item.at + 60000 - now);
    }
  }
  return Math.max(0, (entries[0]?.at ?? now) + 60000 - now);
}

async function waitSharedBudget(path, query = {}) {
  const weight = estimateBinanceRequestWeight(path, query);
  for (;;) {
    // Serialize only the budget decision and reservation. Never sleep while
    // owning the global queue: a heavy request awaiting weight headroom must not
    // head-of-line block a light request that can safely use the remaining budget.
    let release;
    const previous = SHARED.budgetQueue;
    SHARED.budgetQueue = new Promise(resolve => { release = resolve; });
    let waitMs = 0;
    let reservedAt = null;
    try {
      await previous;
      const now = Date.now();
      const cooldown = SHARED.rateLimitedUntil - now;
      if (cooldown > 0) {
        waitMs = cooldown;
      } else {
        SHARED.usedAt = SHARED.usedAt.filter(item => item.at > now - 60000);
        const usedWeight = SHARED.usedAt.reduce((sum, item) => sum + item.weight, 0);
        const requestWait = SHARED.usedAt.length >= SHARED_MAX_REQUESTS_PER_MINUTE
          ? Math.max(0, SHARED.usedAt[0].at + 60000 - now)
          : 0;
        const weightWait = usedWeight + weight > SHARED_MAX_REQUEST_WEIGHT_PER_MINUTE
          ? waitUntilMs(SHARED.usedAt, now, weight)
          : 0;
        const spacingWait = Math.max(0, SHARED.lastRequestAt + SHARED_MIN_INTERVAL_MS - now);
        waitMs = Math.max(requestWait, weightWait, spacingWait);
        if (waitMs === 0) {
          reservedAt = Date.now();
          SHARED.lastRequestAt = reservedAt;
          SHARED.usedAt.push({ at: reservedAt, weight });
        }
      }
    } finally {
      release();
    }
    if (reservedAt !== null) return reservedAt;
    // Re-enter the atomic reservation path after sleeping. The budget may have
    // changed while this request was waiting, so never assume the old reservation
    // is still valid.
    await sleep(Math.max(1, waitMs));
  }
}

function recordObservedUsedWeight(responseHeaders) {
  const raw = responseHeaders?.get?.('x-mbx-used-weight-1m')
    ?? responseHeaders?.get?.('X-MBX-USED-WEIGHT-1M');
  const value = Number(raw);
  if (raw != null && Number.isFinite(value) && value >= 0) {
    SHARED.observedUsedWeight1m = value;
    SHARED.observedUsedWeightAt = Date.now();
  }
}

function normalizedQuery(query = {}) {
  return Object.entries(query)
    .filter(([, v]) => v != null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [k, String(v)]);
}

export function sharedResponseCacheTtlMs(path, query = {}) {
  if (path === '/api/v3/exchangeInfo') return 5 * 60 * 1000;
  if (path === '/api/v3/ticker/24hr') return query.symbol ? 1500 : 2500;
  if (path === '/api/v3/depth') return 700;
  if (path === '/api/v3/klines') {
    // Closed-candle timestamps, not cache receive time, remain the freshness
    // authority downstream. These short interval-specific TTLs reduce duplicate
    // Kline requests across RadarX clients without allowing open/stale candles
    // through existing candle-quality gates.
    const ttlByInterval = {
      '1m': 12_000, '3m': 15_000, '5m': 20_000,
      '15m': 30_000, '30m': 30_000,
      '1h': 45_000, '2h': 45_000, '4h': 45_000,
      '6h': 45_000, '8h': 45_000, '12h': 45_000, '1d': 45_000
    };
    return ttlByInterval[String(query.interval || '').toLowerCase()] ?? 5_000;
  }
  return 0;
}

// A cached REST snapshot must expire before any candle that was still open at
// receive time reaches its close timestamp. Otherwise a later cache hit could
// relabel a partial candle as closed merely because wall time advanced.
export function sharedResponseCacheExpiresAt(path, query = {}, result = {}, now = Date.now()) {
  const ttl = sharedResponseCacheTtlMs(path, query);
  if (!(ttl > 0)) return Number(now);
  let expiresAt = Number(now) + ttl;
  if (path !== '/api/v3/klines' || !Array.isArray(result?.data)) return expiresAt;
  const receivedAt = Number(result?.receivedAt);
  const snapshotAt = Number.isFinite(receivedAt) ? receivedAt : Number(now);
  let firstOpenCandleCloseTime = Infinity;
  for (const row of result.data) {
    if (!Array.isArray(row) || Number(row[0]) > snapshotAt) continue;
    const closeTime = Number(row[6]);
    if (Number.isFinite(closeTime) && closeTime >= snapshotAt && closeTime < firstOpenCandleCloseTime) {
      firstOpenCandleCloseTime = closeTime;
    }
  }
  if (Number.isFinite(firstOpenCandleCloseTime)) expiresAt = Math.min(expiresAt, firstOpenCandleCloseTime);
  return expiresAt;
}

function cacheKey(baseUrls, path, query) {
  // GET /api/v3/ticker/24hr without symbol(s) is Binance's full-market batch
  // endpoint. Its public Spot payload is interchangeable across the configured
  // Binance REST mirrors, so all radar-specific RestClient instances can share
  // one in-flight fetch and one short-lived snapshot instead of each downloading
  // the same price/volume array through its own fallback list.
  const allMarketTickerSnapshot=path==='/api/v3/ticker/24hr'&&query.symbol==null&&query.symbols==null;
  const sourceScope=allMarketTickerSnapshot?'BINANCE_PUBLIC_ALL_TICKERS':baseUrls.slice().sort();
  return JSON.stringify([sourceScope, path, normalizedQuery(query)]);
}

function pruneSharedCache(now = Date.now(), force = false) {
  if (!force && now < SHARED.cachePruneAt && SHARED.cache.size <= SHARED_MAX_CACHE_ENTRIES) return;
  SHARED.cachePruneAt = now + SHARED_CACHE_PRUNE_INTERVAL_MS;
  for (const [key, item] of SHARED.cache) {
    if (!item || !Number.isFinite(Number(item.expiresAt)) || Number(item.expiresAt) <= now) {
      SHARED.cache.delete(key);
    }
  }
  while (SHARED.cache.size > SHARED_MAX_CACHE_ENTRIES) {
    const oldest = SHARED.cache.keys().next();
    if (oldest.done) break;
    SHARED.cache.delete(oldest.value);
  }
}

function cacheSharedValue(key, value, now = Date.now()) {
  pruneSharedCache(now);
  // Replacing a key also moves it to the newest position in the bounded FIFO.
  SHARED.cache.delete(key);
  SHARED.cache.set(key, value);
  while (SHARED.cache.size > SHARED_MAX_CACHE_ENTRIES) {
    const oldest = SHARED.cache.keys().next();
    if (oldest.done) break;
    SHARED.cache.delete(oldest.value);
  }
}

function cachedValue(key, now = Date.now()) {
  pruneSharedCache(now);
  const item = SHARED.cache.get(key);
  if (!item || item.expiresAt <= now) {
    if (item) SHARED.cache.delete(key);
    return null;
  }
  return item.value;
}

function annotateClientSuccess(client, result, sourceIndex = null) {
  if (Number.isInteger(sourceIndex)) client.currentBaseIndex = sourceIndex;
  client.lastSuccessAt = Date.now();
  client.lastError = null;
  client.state = 'LIVE';
  return result;
}

export class RestClient {
  constructor({baseUrls,fetchImpl=globalThis.fetch,timeoutMs=9000,minIntervalMs=100,maxRequestsPerMinute=240}) {
    this.baseUrls=[...baseUrls]; this.fetchImpl=fetchImpl; this.timeoutMs=timeoutMs;
    this.minIntervalMs=minIntervalMs; this.maxRequestsPerMinute=maxRequestsPerMinute;
    this.usedAt=[]; this.lastRequestAt=0; this.currentBaseIndex=0;
    this.lastSuccessAt=null; this.lastError=null; this.rateLimitedUntil=0; this.state='INIT';
  }
  subscribeKlines(observer){
    if(typeof observer!=='function')throw new Error('KLINE_OBSERVER_MUST_BE_FUNCTION');
    SHARED.klineObservers.add(observer);
    return ()=>SHARED.klineObservers.delete(observer);
  }
  health(){return {
    state:this.state,last_success_at:this.lastSuccessAt,last_error:this.lastError,
    rate_limited_until:this.rateLimitedUntil||null,
    current_base_url:this.baseUrls[this.currentBaseIndex]??null,
    shared_queue_depth:SHARED.inflight.size,
    shared_cache_entries:SHARED.cache.size,
    shared_requests_last_minute:SHARED.usedAt.length,
    shared_max_requests_per_minute:SHARED_MAX_REQUESTS_PER_MINUTE,
    shared_estimated_weight_last_minute:SHARED.usedAt.reduce((sum,item)=>sum+item.weight,0),
    shared_max_weight_per_minute:SHARED_MAX_REQUEST_WEIGHT_PER_MINUTE,
    binance_reported_used_weight_1m:SHARED.observedUsedWeight1m,
    binance_reported_used_weight_at:SHARED.observedUsedWeightAt
  };}
  async waitBudget(path, query = {}){
    let now=Date.now();
    if(this.rateLimitedUntil>now) await sleep(this.rateLimitedUntil-now);
    const cutoff=Date.now()-60000;
    this.usedAt=this.usedAt.filter(x=>x>cutoff);
    if(this.usedAt.length>=this.maxRequestsPerMinute) {
      await sleep(Math.max(100,this.usedAt[0]+60000-Date.now()));
    }
    now=Date.now();
    const gap=now-this.lastRequestAt;
    if(gap<this.minIntervalMs) await sleep(this.minIntervalMs-gap);
    await waitSharedBudget(path, query);
  }
  async request(path,query={}) {
    if(!String(path).startsWith('/api/v3/')) throw new Error('REST_PATH_NOT_ALLOWED');
    const key=cacheKey(this.baseUrls,path,query);
    const ttl=sharedResponseCacheTtlMs(path,query);
    const hit=cachedValue(key);
    if(hit){
      return annotateClientSuccess(this,{data:hit.data,source:hit.source,receivedAt:Date.now()},null);
    }
    if(SHARED.inflight.has(key)){
      try{
        const shared=await SHARED.inflight.get(key);
        return annotateClientSuccess(this,{data:shared.data,source:shared.source,receivedAt:Date.now()},null);
      }catch(error){
        this.lastError=String(error?.message??error);
        throw error;
      }
    }

    const task=(async()=>{
      let error=null;
      for(let attempt=0;attempt<this.baseUrls.length;attempt++){
        await this.waitBudget(path, query);
        const idx=(this.currentBaseIndex+attempt)%this.baseUrls.length;
        const qs=new URLSearchParams(normalizedQuery(query));
        const url=this.baseUrls[idx]+path+(qs.toString()?'?'+qs:'');
        const ac=new AbortController(); const tm=setTimeout(()=>ac.abort(),this.timeoutMs);
        const requestAt=Date.now();
        this.lastRequestAt=requestAt; this.usedAt.push(requestAt);
        this.state='REQUESTING';
        try{
          const r=await this.fetchImpl(url,{method:'GET',signal:ac.signal,headers:{Accept:'application/json'}});
          if(r.status===429||r.status===418){
            const wait=retryAfterMs(r.headers)??Math.min(60000,1500*(2**attempt));
            SHARED.rateLimitedUntil=Math.max(SHARED.rateLimitedUntil,Date.now()+wait);
            this.rateLimitedUntil=Date.now()+wait; this.state='RATE_LIMITED';
            throw new RestRateLimitError(wait);
          }
          if(!r.ok) throw new Error('HTTP_'+r.status);
          recordObservedUsedWeight(r.headers);
          const data=await r.json();
          const result={data,source:this.baseUrls[idx],receivedAt:Date.now()};
          // Do not retain malformed/seconds-based Kline payloads in the short
          // shared cache: another consumer must be able to try REST fallback.
          const cacheableKlines=path!=='/api/v3/klines' || (
            Array.isArray(data) && data.length>0 && data.every(row =>
              Array.isArray(row) && Number.isFinite(Number(row[0])) &&
              Number(row[0])>1e12 && Number.isFinite(Number(row[6])) && Number(row[6])>1e12
            )
          );
          if(ttl>0 && cacheableKlines) {
            const cacheNow=Date.now();
            const expiresAt=sharedResponseCacheExpiresAt(path,query,result,cacheNow);
            if(expiresAt>cacheNow) cacheSharedValue(key,{expiresAt,value:result},cacheNow);
          }
          this.currentBaseIndex=idx; this.lastSuccessAt=Date.now();
          this.lastError=null; this.state='LIVE';
          return result;
        }catch(e){
          const timedOut=ac.signal.aborted||e?.name==='AbortError';
          error=timedOut
            ?new Error(`REST_REQUEST_TIMEOUT path=${path} timeout_ms=${this.timeoutMs} base=${this.baseUrls[idx]}`)
            :e;
          if(timedOut)error.name='RestTimeoutError';
          this.lastError=String(error?.message??error);
          if(error?.name==='RestRateLimitError') break;
        }finally{clearTimeout(tm);}
      }
      if(error?.name==='RestRateLimitError') throw error;
      throw error??new Error('REST_REQUEST_FAILED');
    })();

    SHARED.inflight.set(key,task);
    try{
      const result=await task;
      return annotateClientSuccess(this,{data:result.data,source:result.source,receivedAt:Date.now()},null);
    }catch(error){
      this.state=error?.name==='RestRateLimitError'?'RATE_LIMITED':'ERROR';
      throw error;
    }finally{
      if(SHARED.inflight.get(key)===task) SHARED.inflight.delete(key);
    }
  }
  async klines(symbol,interval,opts={}) {
    const r=await this.request('/api/v3/klines',{
      symbol,interval,limit:opts.limit??250,startTime:opts.startTime,endTime:opts.endTime
    });
    const now=Date.now();
    const receivedAt=Number(r.receivedAt)||now;
    const candles=r.data.map(x=>{
      const openTime=normalizeEpochMs(x[0], 'openTime');
      const closeTime=normalizeEpochMs(x[6], 'closeTime');
      return {
        openTime,open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),
        volume:Number(x[5]),closeTime,quoteVolume:Number(x[7]),tradeCount:Number(x[8]),
        takerBuyBaseVolume:Number(x[9]),takerBuyQuoteVolume:Number(x[10]),
        closed:closeTime<now,source:'BINANCE_PUBLIC_REST',sourceTime:receivedAt,
        receivedAt,ageMs:Math.max(0,receivedAt-closeTime),eventTime:null,transportLatencyMs:null
      };
    });
    const result={source:r.source,receivedAt,candles};
    for(const observer of [...SHARED.klineObservers]){
      try{observer({symbol:String(symbol||'').toUpperCase(),interval:String(interval||''),source:r.source,receivedAt,candles});}
      catch{}
    }
    return result;
  }
  depth(symbol,limit=100){return this.request('/api/v3/depth',{symbol,limit});}
  ticker24h(symbol){return this.request('/api/v3/ticker/24hr',{symbol});}
}
