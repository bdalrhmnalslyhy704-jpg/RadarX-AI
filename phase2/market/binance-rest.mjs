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
  observedUsedWeightAt: null
};

// Let the shared broker schedule up to six raw requests per second while keeping
// the stricter weighted budget at 4,000/minute (below Binance's documented 6,000).
// The existing shared 429/418 cooldown is still applied before any request resumes.
const SHARED_MAX_REQUESTS_PER_MINUTE = 360;
const SHARED_MAX_REQUEST_WEIGHT_PER_MINUTE = 4000;
const SHARED_MIN_INTERVAL_MS = 167;
// TTL only helps if expired entries are removed. Symbols rotate continuously,
// so prune expired market-data payloads and cap the shared cache to bound heap use.
const SHARED_MAX_CACHE_ENTRIES = 512;
const SHARED_CACHE_PRUNE_INTERVAL_MS = 1000;

export function estimateBinanceRequestWeight(path, query = {}) {
  if (path === '/api/v3/exchangeInfo') return 20;
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
  // A small promise lock makes budget checks + reservations atomic. Without it,
  // concurrent scan workers could all pass the same check and burst together.
  let release;
  const previous = SHARED.budgetQueue;
  SHARED.budgetQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    const weight = estimateBinanceRequestWeight(path, query);
    for (;;) {
      const now = Date.now();
      const cooldown = SHARED.rateLimitedUntil - now;
      if (cooldown > 0) {
        await sleep(cooldown);
        continue;
      }
      SHARED.usedAt = SHARED.usedAt.filter(item => item.at > now - 60000);
      const usedWeight = SHARED.usedAt.reduce((sum, item) => sum + item.weight, 0);
      const requestWait = SHARED.usedAt.length >= SHARED_MAX_REQUESTS_PER_MINUTE
        ? Math.max(0, SHARED.usedAt[0].at + 60000 - now)
        : 0;
      const weightWait = usedWeight + weight > SHARED_MAX_REQUEST_WEIGHT_PER_MINUTE
        ? waitUntilMs(SHARED.usedAt, now, weight)
        : 0;
      const spacingWait = Math.max(0, SHARED.lastRequestAt + SHARED_MIN_INTERVAL_MS - now);
      const waitMs = Math.max(requestWait, weightWait, spacingWait);
      if (waitMs > 0) {
        await sleep(waitMs);
        continue;
      }
      const reservedAt = Date.now();
      SHARED.lastRequestAt = reservedAt;
      SHARED.usedAt.push({ at: reservedAt, weight });
      return reservedAt;
    }
  } finally {
    release();
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

function cacheTtlMs(path, query = {}) {
  if (path === '/api/v3/exchangeInfo') return 5 * 60 * 1000;
  if (path === '/api/v3/ticker/24hr') return query.symbol ? 1500 : 2500;
  if (path === '/api/v3/depth') return 700;
  if (path === '/api/v3/klines') return 0;
  return 0;
}

function cacheKey(baseUrls, path, query) {
  return JSON.stringify([baseUrls.slice().sort(), path, normalizedQuery(query)]);
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
  health(){return {
    state:this.state,last_success_at:this.lastSuccessAt,last_error:this.lastError,
    rate_limited_until:this.rateLimitedUntil||null,
    current_base_url:this.baseUrls[this.currentBaseIndex]??null,
    shared_queue_depth:SHARED.inflight.size,
    shared_cache_entries:SHARED.cache.size,
    shared_requests_last_minute:SHARED.usedAt.length,
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
    const ttl=cacheTtlMs(path,query);
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
          if(ttl>0) cacheSharedValue(key,{expiresAt:Date.now()+ttl,value:result});
          this.currentBaseIndex=idx; this.lastSuccessAt=Date.now();
          this.lastError=null; this.state='LIVE';
          return result;
        }catch(e){
          error=e; this.lastError=String(e?.message??e);
          if(e?.name==='RestRateLimitError') break;
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
    return {source:r.source,receivedAt,candles:r.data.map(x=>{
      const openTime=normalizeEpochMs(x[0], 'openTime');
      const closeTime=normalizeEpochMs(x[6], 'closeTime');
      return {
        openTime,open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),
        volume:Number(x[5]),closeTime,quoteVolume:Number(x[7]),tradeCount:Number(x[8]),
        takerBuyBaseVolume:Number(x[9]),takerBuyQuoteVolume:Number(x[10]),
        closed:closeTime<now,source:'BINANCE_PUBLIC_REST',sourceTime:receivedAt,
        receivedAt,ageMs:Math.max(0,receivedAt-closeTime),eventTime:null,transportLatencyMs:null
      };
    })};
  }
  depth(symbol,limit=100){return this.request('/api/v3/depth',{symbol,limit});}
  ticker24h(symbol){return this.request('/api/v3/ticker/24hr',{symbol});}
}
