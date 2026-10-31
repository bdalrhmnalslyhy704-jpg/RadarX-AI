import {normalizeEpochMs} from '../core/data-quality.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function awaitBeforeDeadline(promise, deadlineAtMs, onTimeout, signal=null) {
  const deadline=Number(deadlineAtMs);
  if(!Number.isFinite(deadline)||deadline<=0)return promise;
  const remaining=deadline-Date.now();
  if(remaining<=0)return Promise.reject(onTimeout());
  return new Promise((resolve,reject)=>{
    let settled=false,timer=null;
    const cleanup=()=>{
      if(timer!==null)clearTimeout(timer);
      signal?.removeEventListener?.('abort',onAbort);
    };
    const finish=(error,value)=>{
      if(settled)return;
      settled=true;cleanup();
      error?reject(error):resolve(value);
    };
    const onAbort=()=>finish(onTimeout());
    timer=setTimeout(()=>finish(onTimeout()),remaining);
    if(signal?.aborted===true)onAbort();
    else signal?.addEventListener?.('abort',onAbort,{once:true});
    Promise.resolve(promise).then(
      value=>finish(null,value),
      error=>finish(error)
    );
  });
}

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

export class RestRegionRestrictedError extends Error {
  constructor(message='BINANCE_REGION_RESTRICTED:HTTP_451') {
    super(message);
    this.name='RestRegionRestrictedError';
    this.code='BINANCE_REGION_RESTRICTED';
    this.status=451;
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
// Reserve part of the existing process-wide ceiling for Spot universe discovery.
// This does not raise Binance's overall limits; it prevents the radar fleet's
// Kline/depth traffic from consuming every discovery slot first.
const SHARED_DISCOVERY_RESERVED_REQUESTS_PER_MINUTE = 60;
const SHARED_DISCOVERY_RESERVED_WEIGHT_PER_MINUTE = 600;
const SHARED_GENERAL_MAX_REQUESTS_PER_MINUTE =
  SHARED_MAX_REQUESTS_PER_MINUTE-SHARED_DISCOVERY_RESERVED_REQUESTS_PER_MINUTE;
const SHARED_GENERAL_MAX_REQUEST_WEIGHT_PER_MINUTE =
  SHARED_MAX_REQUEST_WEIGHT_PER_MINUTE-SHARED_DISCOVERY_RESERVED_WEIGHT_PER_MINUTE;
const SHARED_MIN_INTERVAL_MS = 100;
// Long exchange cooldowns must defer a scan, not block its busy latch for hours.
const MAX_INLINE_RATE_LIMIT_WAIT_MS = 1500;
// Do not let a radar scan wait for several seconds on a crowded process-wide
// request budget. Defer that request to the next cycle instead of pinning the
// caller's busy latch while other radars keep consuming the same budget.
const MAX_SHARED_BUDGET_WAIT_MS = 2500;
export function assertSharedBudgetWaitBound(waitMs) {
  const wait = Number(waitMs);
  if (!Number.isFinite(wait) || wait < 0) throw new TypeError('INVALID_SHARED_BUDGET_WAIT_MS');
  if (wait > MAX_SHARED_BUDGET_WAIT_MS) throw new RestRateLimitError(wait);
  return wait;
}
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

function waitUntilMs(entries, now, requiredWeight, maxWeight=SHARED_MAX_REQUEST_WEIGHT_PER_MINUTE) {
  let remaining = entries.reduce((sum, item) => sum + (Number(item?.weight)||0), 0);
  for (const item of entries) {
    remaining -= Number(item?.weight)||0;
    if (remaining + requiredWeight <= maxWeight) {
      return Math.max(0, (Number(item?.at)||now) + 60000 - now);
    }
  }
  return Math.max(0, (Number(entries[0]?.at)||now) + 60000 - now);
}

function waitUntilCountMs(entries, now, maxCount) {
  if(entries.length<maxCount)return 0;
  const index=entries.length-maxCount;
  return Math.max(0,(Number(entries[index]?.at)||now)+60000-now);
}

function isMarketDiscoveryRequest(path,query={}) {
  return path==='/api/v3/exchangeInfo' ||
    (path==='/api/v3/ticker/24hr'&&query.symbol==null&&query.symbols==null);
}

// Pure policy helper for deterministic coverage of the shared Binance budget.
export function calculateSharedBudgetWait(path,query={},usedAt=[],now=Date.now()) {
  const active=(Array.isArray(usedAt)?usedAt:[])
    .filter(item=>Number.isFinite(Number(item?.at))&&Number(item.at)>now-60000)
    .sort((a,b)=>Number(a.at)-Number(b.at));
  const discovery=isMarketDiscoveryRequest(path,query);
  const general=active.filter(item=>item?.discovery!==true);
  const weight=estimateBinanceRequestWeight(path,query);
  const totalWeight=active.reduce((sum,item)=>sum+(Number(item?.weight)||0),0);
  const generalWeight=general.reduce((sum,item)=>sum+(Number(item?.weight)||0),0);
  const totalRequestWait=active.length>=SHARED_MAX_REQUESTS_PER_MINUTE
    ?waitUntilCountMs(active,now,SHARED_MAX_REQUESTS_PER_MINUTE):0;
  const generalRequestWait=!discovery&&general.length>=SHARED_GENERAL_MAX_REQUESTS_PER_MINUTE
    ?waitUntilCountMs(general,now,SHARED_GENERAL_MAX_REQUESTS_PER_MINUTE):0;
  const totalWeightWait=totalWeight+weight>SHARED_MAX_REQUEST_WEIGHT_PER_MINUTE
    ?waitUntilMs(active,now,weight,SHARED_MAX_REQUEST_WEIGHT_PER_MINUTE):0;
  const generalWeightWait=!discovery&&generalWeight+weight>SHARED_GENERAL_MAX_REQUEST_WEIGHT_PER_MINUTE
    ?waitUntilMs(general,now,weight,SHARED_GENERAL_MAX_REQUEST_WEIGHT_PER_MINUTE):0;
  const requestWaitMs=Math.max(totalRequestWait,generalRequestWait);
  const weightWaitMs=Math.max(totalWeightWait,generalWeightWait);
  return {discovery,requestWaitMs,weightWaitMs,waitMs:Math.max(requestWaitMs,weightWaitMs)};
}

function scanDeadlineFailure(onDeadline) {
  if (typeof onDeadline === 'function') onDeadline();
  const error = new Error('MULTI_ANALYST_SCAN_DEADLINE_EXCEEDED');
  error.name = 'ScanDeadlineError';
  throw error;
}

// Every wait inside a bounded radar request observes the enclosing scan's
// deadline and abort signal. This includes Binance's process-wide cooldown,
// request-weight queue, and per-client spacing waits, not just fetch() itself.
async function waitWithinRestWindow(ms, {deadlineAtMs=null, signal=null, onDeadline=null}={}) {
  const requestedMs=Math.max(0,Number(ms)||0);
  const deadline=Number(deadlineAtMs);
  const hasDeadline=Number.isFinite(deadline)&&deadline>0;
  const assertActive=()=>{
    if(signal?.aborted===true||(hasDeadline&&Date.now()>=deadline))scanDeadlineFailure(onDeadline);
  };
  assertActive();
  if(requestedMs===0)return;
  const remaining=hasDeadline?Math.max(0,deadline-Date.now()):Infinity;
  if(remaining<=0)scanDeadlineFailure(onDeadline);
  const waitMs=Math.min(requestedMs,remaining);
  const deadlineTruncated=waitMs<requestedMs;
  await new Promise((resolve,reject)=>{
    let settled=false,timer=null;
    const cleanup=()=>{
      if(timer!==null)clearTimeout(timer);
      signal?.removeEventListener?.('abort',abort);
    };
    const finish=(error=null)=>{
      if(settled)return;
      settled=true;cleanup();
      error?reject(error):resolve();
    };
    const abort=()=>{
      try{scanDeadlineFailure(onDeadline);}catch(error){finish(error);}
    };
    timer=setTimeout(()=>finish(),Math.max(1,waitMs));
    if(signal?.aborted===true)abort();
    else signal?.addEventListener?.('abort',abort,{once:true});
  });
  if(deadlineTruncated||signal?.aborted===true||(hasDeadline&&Date.now()>=deadline))scanDeadlineFailure(onDeadline);
}

async function waitSharedBudget(path, query = {}, controls = {}) {
  const weight = estimateBinanceRequestWeight(path, query);
  for (;;) {
    if(controls.signal?.aborted===true ||
      (Number.isFinite(Number(controls.deadlineAtMs))&&Number(controls.deadlineAtMs)>0&&Date.now()>=Number(controls.deadlineAtMs)))
      scanDeadlineFailure(controls.onDeadline);
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
      if(controls.signal?.aborted===true ||
        (Number.isFinite(Number(controls.deadlineAtMs))&&Number(controls.deadlineAtMs)>0&&Date.now()>=Number(controls.deadlineAtMs)))
        scanDeadlineFailure(controls.onDeadline);
      const now = Date.now();
      const cooldown = SHARED.rateLimitedUntil - now;
      if (cooldown > MAX_INLINE_RATE_LIMIT_WAIT_MS) {
        throw new RestRateLimitError(cooldown);
      }
      if (cooldown > 0) {
        waitMs = cooldown;
      } else {
        SHARED.usedAt = SHARED.usedAt.filter(item => item.at > now - 60000);
        const budget=calculateSharedBudgetWait(path,query,SHARED.usedAt,now);
        const spacingWait = Math.max(0, SHARED.lastRequestAt + SHARED_MIN_INTERVAL_MS - now);
        waitMs = Math.max(budget.waitMs, spacingWait);
        if (waitMs === 0) {
          reservedAt = Date.now();
          SHARED.lastRequestAt = reservedAt;
          SHARED.usedAt.push({ at: reservedAt, weight, discovery:budget.discovery });
        }
      }
    } finally {
      release();
    }
    if (reservedAt !== null) return reservedAt;
    const boundedWaitMs = assertSharedBudgetWaitBound(waitMs);
    await waitWithinRestWindow(Math.max(1,boundedWaitMs),controls);
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
    this.baseUrls=[...baseUrls]; this.fetchImpl=fetchImpl;
    // A deployment override must not turn one public REST request into a 60s+
    // blocking wait. Bound each host attempt so the scanner can fail over to the
    // next official Binance Spot endpoint within its absolute scan deadline.
    const requestedTimeoutMs=Number(timeoutMs);
    this.timeoutMs=Number.isFinite(requestedTimeoutMs)&&requestedTimeoutMs>0
      ?Math.min(9000,requestedTimeoutMs):9000;
    this.minIntervalMs=minIntervalMs; this.maxRequestsPerMinute=maxRequestsPerMinute;
    this.usedAt=[]; this.lastRequestAt=0; this.currentBaseIndex=0;
    this.lastSuccessAt=null; this.lastError=null; this.rateLimitedUntil=0; this.state='INIT';
    this.lastRequestPath=null;this.lastRequestUrl=null;this.lastRequestPhase=null;
    this.lastRequestHttpStatus=null;this.lastRequestStartedAt=null;this.lastRequestDurationMs=null;
    // Set only for a bounded top-level radar scan; null means ordinary REST use.
    this.requestDeadlineAtMs=null;
    // A bounded radar cycle may cancel all its own in-flight REST work together.
    this.requestAbortSignal=null;
  }
  subscribeKlines(observer){
    if(typeof observer!=='function')throw new Error('KLINE_OBSERVER_MUST_BE_FUNCTION');
    SHARED.klineObservers.add(observer);
    return ()=>SHARED.klineObservers.delete(observer);
  }
  health(){return {
    state:this.state,last_success_at:this.lastSuccessAt,last_error:this.lastError,
    last_request_path:this.lastRequestPath,last_request_url:this.lastRequestUrl,
    last_request_phase:this.lastRequestPhase,last_request_http_status:this.lastRequestHttpStatus,
    last_request_started_at:this.lastRequestStartedAt,last_request_duration_ms:this.lastRequestDurationMs,
    rate_limited_until:Math.max(this.rateLimitedUntil||0,SHARED.rateLimitedUntil||0)||null,
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
  async waitBudget(path, query = {}, controls = {}){
    const waitControls={
      deadlineAtMs:controls.deadlineAtMs??this.requestDeadlineAtMs,
      signal:controls.signal??this.requestAbortSignal,
      onDeadline:controls.onDeadline
    };
    const cooldownUntil=Math.max(this.rateLimitedUntil||0,SHARED.rateLimitedUntil||0);
    const cooldownMs=cooldownUntil-Date.now();
    if(cooldownMs>MAX_INLINE_RATE_LIMIT_WAIT_MS){
      this.state='RATE_LIMITED';
      this.lastError='BINANCE_RATE_LIMIT_WAIT_DEFERRED retry_ms='+Math.ceil(cooldownMs);
      throw new RestRateLimitError(cooldownMs);
    }
    if(cooldownMs>0) await waitWithinRestWindow(cooldownMs,waitControls);
    const cutoff=Date.now()-60000;
    this.usedAt=this.usedAt.filter(x=>x>cutoff);
    if(this.usedAt.length>=this.maxRequestsPerMinute) {
      const waitMs=Math.max(100,this.usedAt[0]+60000-Date.now());
      try{assertSharedBudgetWaitBound(waitMs);}
      catch(error){
        this.state='RATE_LIMITED';
        this.lastError='REST_BUDGET_WAIT_DEFERRED retry_ms='+Math.ceil(waitMs);
        throw error;
      }
      await waitWithinRestWindow(waitMs,waitControls);
    }
    const gap=Date.now()-this.lastRequestAt;
    if(gap<this.minIntervalMs)await waitWithinRestWindow(this.minIntervalMs-gap,waitControls);
    await waitSharedBudget(path,query,waitControls);
  }
  async request(path,query={}) {
    if(!String(path).startsWith('/api/v3/')) throw new Error('REST_PATH_NOT_ALLOWED');
    const startedAt=Date.now();
    // RadarX consumes public Spot data only. Binance exchangeInfo defaults to
    // symbols with several permission classes; explicitly request active Spot
    // symbols at the source so every scanner receives the smallest safe universe.
    const requestQuery=path==='/api/v3/exchangeInfo'&&
      query&&typeof query==='object'&&Object.keys(query).length===0
      ?{permissions:'SPOT',symbolStatus:'TRADING'}:query;
    this.lastRequestPath=path;
    this.lastRequestUrl=null;
    this.lastRequestPhase='CACHE_LOOKUP';
    this.lastRequestHttpStatus=null;
    this.lastRequestStartedAt=startedAt;
    this.lastRequestDurationMs=null;
    const assertRequestDeadline=()=>{
      const deadline=Number(this.requestDeadlineAtMs);
      const externallyAborted=this.requestAbortSignal?.aborted===true;
      if(!externallyAborted&&(!Number.isFinite(deadline)||deadline<=0||Date.now()<deadline))return;
      const previous=String(this.lastError||'').replace(/\s+/g,' ').slice(0,180);
      const host=this.lastRequestUrl?new URL(this.lastRequestUrl).host:
        (this.baseUrls[this.currentBaseIndex]?new URL(this.baseUrls[this.currentBaseIndex]).host:'UNKNOWN');
      const error=new Error('MULTI_ANALYST_SCAN_DEADLINE_EXCEEDED'+
        ':phase='+String(this.lastRequestPhase||'UNKNOWN')+
        ':path='+path+':host='+host+
        (previous&&previous!=='MULTI_ANALYST_SCAN_DEADLINE_EXCEEDED'?':last_error='+previous:''));
      error.name='ScanDeadlineError';
      this.lastError=error.message;
      this.state='ERROR';
      throw error;
    };
    assertRequestDeadline();
    const key=cacheKey(this.baseUrls,path,requestQuery);
    const ttl=sharedResponseCacheTtlMs(path,requestQuery);
    const hit=cachedValue(key);
    if(hit){
      return annotateClientSuccess(this,{data:hit.data,source:hit.source,receivedAt:Date.now()},null);
    }
    if(SHARED.inflight.has(key)){
      const sharedTask=SHARED.inflight.get(key);
      // A coalesced public request is useful only while its owner is responsive.
      // Bound the wait independently from the enclosing scan deadline. If a
      // peer's response body/parser stalls, evict only that exact in-flight
      // promise and let this caller perform its own official-mirror fallback.
      const sharedWaitDeadline=Date.now()+Math.max(250,Math.min(4000,Math.trunc(this.timeoutMs*2)));
      const scanDeadline=Number(this.requestDeadlineAtMs);
      const waitDeadline=Number.isFinite(scanDeadline)&&scanDeadline>0
        ?Math.min(sharedWaitDeadline,scanDeadline):sharedWaitDeadline;
      try{
        const shared=await awaitBeforeDeadline(sharedTask,waitDeadline,()=>{
          const scanAborted=this.requestAbortSignal?.aborted===true||
            (Number.isFinite(scanDeadline)&&scanDeadline>0&&Date.now()>=scanDeadline);
          const error=new Error(scanAborted?'MULTI_ANALYST_SCAN_DEADLINE_EXCEEDED':
            'REST_SHARED_INFLIGHT_TIMEOUT path='+path+' timeout_ms='+Math.max(250,Math.min(4000,Math.trunc(this.timeoutMs*2))));
          error.name=scanAborted?'ScanDeadlineError':'RestTimeoutError';
          this.lastError=error.message;
          this.state='ERROR';
          return error;
        },this.requestAbortSignal);
        return annotateClientSuccess(this,{data:shared.data,source:shared.source,receivedAt:Date.now()},null);
      }catch(error){
        this.lastError=String(error?.message??error);
        if(error?.name==='ScanDeadlineError'){
          this.state='ERROR';
          throw error;
        }
        if(error?.name!=='RestTimeoutError'&&this.requestAbortSignal?.aborted!==true)throw error;
        if(SHARED.inflight.get(key)===sharedTask)SHARED.inflight.delete(key);
        if(this.requestAbortSignal?.aborted===true){
          const aborted=new Error('MULTI_ANALYST_SCAN_DEADLINE_EXCEEDED');
          aborted.name='ScanDeadlineError';this.lastError=aborted.message;this.state='ERROR';throw aborted;
        }
        // Continue below with a fresh bounded request rather than inheriting a
        // permanently pending promise from another RestClient instance.
      }
    }

    const task=(async()=>{
      let error=null;
      const attemptFailures=[];
      for(let attempt=0;attempt<this.baseUrls.length;attempt++){
        this.lastRequestPhase='WAIT_BUDGET';
        await this.waitBudget(path, requestQuery, {deadlineAtMs:this.requestDeadlineAtMs,signal:this.requestAbortSignal,onDeadline:assertRequestDeadline});
        assertRequestDeadline();
        const idx=(this.currentBaseIndex+attempt)%this.baseUrls.length;
        const qs=new URLSearchParams(normalizedQuery(requestQuery));
        const url=this.baseUrls[idx]+path+(qs.toString()?'?'+qs:'');
        this.lastRequestUrl=url;this.lastRequestPhase='FETCH';
        const ac=new AbortController();
        const parentSignal=this.requestAbortSignal;
        const abortFromParent=()=>{if(!ac.signal.aborted)ac.abort();};
        if(parentSignal?.aborted)abortFromParent();
        else parentSignal?.addEventListener('abort',abortFromParent,{once:true});
        const deadline=Number(this.requestDeadlineAtMs);
        const requestTimeoutMs=Number.isFinite(deadline)&&deadline>0
          ?Math.max(1,Math.min(this.timeoutMs,deadline-Date.now())):this.timeoutMs;
        const tm=setTimeout(()=>ac.abort(),requestTimeoutMs);
        const requestAt=Date.now();
        this.lastRequestAt=requestAt; this.usedAt.push(requestAt);
        this.state='REQUESTING';
        try{
          const r=await this.fetchImpl(url,{method:'GET',signal:ac.signal,headers:{Accept:'application/json'}});
          this.lastRequestHttpStatus=Number(r.status)||null;this.lastRequestPhase='READ_RESPONSE';
          if(r.status===429||r.status===418){
            const wait=retryAfterMs(r.headers)??Math.min(60000,1500*(2**attempt));
            SHARED.rateLimitedUntil=Math.max(SHARED.rateLimitedUntil,Date.now()+wait);
            this.rateLimitedUntil=Date.now()+wait; this.state='RATE_LIMITED';
            throw new RestRateLimitError(wait);
          }
          if(!r.ok){
            let responseDetail='';
            try{
              const responseCopy=typeof r.clone==='function'?r.clone():null;
              if(responseCopy&&typeof responseCopy.text==='function'){
                responseDetail=String(await responseCopy.text()).replace(/\s+/g,' ').slice(0,180);
              }
            }catch{}
            const host=new URL(url).host;
            const message='HTTP_'+r.status+' path='+path+' host='+host+
              (responseDetail?' response='+responseDetail:'');
            if(r.status===451)throw new RestRegionRestrictedError('BINANCE_REGION_RESTRICTED:'+message);
            throw new Error(message);
          }
          recordObservedUsedWeight(r.headers);
          this.lastRequestPhase='PARSE_JSON';
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
            const expiresAt=sharedResponseCacheExpiresAt(path,requestQuery,result,cacheNow);
            if(expiresAt>cacheNow) cacheSharedValue(key,{expiresAt,value:result},cacheNow);
          }
          this.currentBaseIndex=idx; this.lastSuccessAt=Date.now();
          this.lastError=null; this.state='LIVE';
          this.lastRequestPhase='COMPLETE';this.lastRequestDurationMs=Math.max(0,Date.now()-startedAt);
          return result;
        }catch(e){
          const timedOut=ac.signal.aborted||e?.name==='AbortError';
          const scanAborted=parentSignal?.aborted===true||
            (Number.isFinite(deadline)&&deadline>0&&Date.now()>=deadline);
          error=scanAborted
            ?new Error('MULTI_ANALYST_SCAN_DEADLINE_EXCEEDED')
            :timedOut
              ?new Error(`REST_REQUEST_TIMEOUT path=${path} timeout_ms=${requestTimeoutMs} base=${this.baseUrls[idx]}`)
              :e;
          if(scanAborted)error.name='ScanDeadlineError';
          else if(timedOut)error.name='RestTimeoutError';
          const message=String(error?.message??error).slice(0,260);
          this.lastRequestPhase='ATTEMPT_FAILED';
          this.lastRequestDurationMs=Math.max(0,Date.now()-startedAt);
          attemptFailures.push(message);
          this.lastError=message;
          if(error?.name==='RestRateLimitError'||error?.name==='RestRegionRestrictedError'||error?.name==='ScanDeadlineError') break;
        }finally{
          clearTimeout(tm);
          parentSignal?.removeEventListener('abort',abortFromParent);
        }
      }
      if(error?.name==='RestRateLimitError'||error?.name==='ScanDeadlineError') throw error;
      if(error&&attemptFailures.length){
        error.message=(String(error.message||'REST_REQUEST_FAILED')+
          ' attempts=['+attemptFailures.join(' | ')+']').slice(0,1500);
      }
      throw error??new Error('REST_REQUEST_FAILED');
    })();

    SHARED.inflight.set(key,task);
    try{
      const result=await task;
      return annotateClientSuccess(this,{data:result.data,source:result.source,receivedAt:Date.now()},null);
    }catch(error){
      this.state=error?.name==='RestRateLimitError'?'RATE_LIMITED':
        error?.name==='RestRegionRestrictedError'?'REGION_RESTRICTED':'ERROR';
      this.lastError=String(error?.message??error).slice(0,1500);
      this.lastRequestPhase='FAILED';this.lastRequestDurationMs=Math.max(0,Date.now()-startedAt);
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
