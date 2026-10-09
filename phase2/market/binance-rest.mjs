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
  usedAt: [],
  lastRequestAt: 0,
  rateLimitedUntil: 0
};

const SHARED_MAX_REQUESTS_PER_MINUTE = 90;
const SHARED_MIN_INTERVAL_MS = 300;

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

function cachedValue(key, now = Date.now()) {
  const item = SHARED.cache.get(key);
  if (!item || item.expiresAt <= now) {
    if (item) SHARED.cache.delete(key);
    return null;
  }
  return item.value;
}

async function waitSharedBudget() {
  const now = Date.now();
  if (SHARED.rateLimitedUntil > now) {
    await sleep(SHARED.rateLimitedUntil - now);
  }
  let t = Date.now();
  SHARED.usedAt = SHARED.usedAt.filter(x => x > t - 60000);
  if (SHARED.usedAt.length >= SHARED_MAX_REQUESTS_PER_MINUTE) {
    const wait = Math.max(100, SHARED.usedAt[0] + 60000 - t);
    await sleep(wait);
  }
  t = Date.now();
  const gap = t - SHARED.lastRequestAt;
  if (gap < SHARED_MIN_INTERVAL_MS) await sleep(SHARED_MIN_INTERVAL_MS - gap);
}

function annotateClientSuccess(client, result, sourceIndex = null) {
  if (Number.isInteger(sourceIndex)) client.currentBaseIndex = sourceIndex;
  client.lastSuccessAt = Date.now();
  client.lastError = null;
  client.state = 'LIVE';
  return result;
}

export class RestClient {
  constructor({baseUrls,fetchImpl=globalThis.fetch,timeoutMs=9000,minIntervalMs=100,maxRequestsPerMinute=120}) {
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
    shared_cache_entries:SHARED.cache.size
  };}
  async waitBudget(){
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
    await waitSharedBudget();
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
        await this.waitBudget();
        const idx=(this.currentBaseIndex+attempt)%this.baseUrls.length;
        const qs=new URLSearchParams(normalizedQuery(query));
        const url=this.baseUrls[idx]+path+(qs.toString()?'?'+qs:'');
        const ac=new AbortController(); const tm=setTimeout(()=>ac.abort(),this.timeoutMs);
        const requestAt=Date.now();
        this.lastRequestAt=requestAt; this.usedAt.push(requestAt);
        SHARED.lastRequestAt=requestAt; SHARED.usedAt.push(requestAt);
        SHARED.usedAt=SHARED.usedAt.filter(x=>x>Date.now()-60000);
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
          const data=await r.json();
          const result={data,source:this.baseUrls[idx],receivedAt:Date.now()};
          if(ttl>0) SHARED.cache.set(key,{expiresAt:Date.now()+ttl,value:result});
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
