import {normalizeEpochMs} from '../core/data-quality.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SHARED_STATE = globalThis.__RADARX_BINANCE_REST_SHARED__ ??= {
  cache: new Map(),
  usedAt: [],
  lastRequestAt: 0,
  rateLimitedUntil: 0
};

const ttlFor = (path, query = {}) => {
  const p=String(path||'');
  if (p.endsWith('/exchangeInfo')) return 10*60*1000;
  if (p.endsWith('/ticker/24hr')) return query.symbol ? 3000 : 5000;
  if (p.endsWith('/depth')) return 2500;
  if (p.endsWith('/klines')) {
    const tf=String(query.interval||'');
    return ({'1m':4000,'3m':5000,'5m':8000,'15m':12000,'30m':20000,'1h':45000,'2h':60000,'4h':120000,'6h':150000,'12h':180000,'1d':300000}[tf] ?? 15000);
  }
  return 0;
};

const cacheKey = (path, query = {}) => {
  const entries=Object.entries(query)
    .filter(([,v])=>v!=null)
    .filter(([k])=>!(String(path).endsWith('/klines')||String(path).endsWith('/depth')) || k!=='limit')
    .sort(([a],[b])=>a.localeCompare(b));
  return String(path)+'?'+new URLSearchParams(entries).toString();
};

const cloneCached = (data, query = {}, entryQuery = {}, path = '') => {
  if (String(path).endsWith('/klines') && Array.isArray(data)) {
    const requested=Math.max(1,Number(query.limit)||data.length);
    const storedLimit=Math.max(1,Number(entryQuery.limit)||data.length);
    if (storedLimit<requested || data.length<requested) return null;
    return data.slice(-requested);
  }
  return data;
};

async function waitSharedBudget(maxRequestsPerMinute=100,minIntervalMs=120){
  let now=Date.now();
  if(SHARED_STATE.rateLimitedUntil>now) await sleep(SHARED_STATE.rateLimitedUntil-now);
  const max=Math.max(20,Math.trunc(Number(maxRequestsPerMinute)||100));
  const cutoff=Date.now()-60000;
  SHARED_STATE.usedAt=SHARED_STATE.usedAt.filter(x=>x>cutoff);
  if(SHARED_STATE.usedAt.length>=max) {
    await sleep(Math.max(100,SHARED_STATE.usedAt[0]+60000-Date.now()));
  }
  now=Date.now();
  const gap=now-SHARED_STATE.lastRequestAt;
  if(gap<Math.max(0,Number(minIntervalMs)||0)) await sleep(Math.max(0,Number(minIntervalMs)||0)-gap);
}

export function clearSharedRestCache(){
  SHARED_STATE.cache.clear();
}

export function sharedRestCacheSize(){
  return SHARED_STATE.cache.size;
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

export class RestClient {
  constructor({
    baseUrls,fetchImpl=globalThis.fetch,timeoutMs=9000,minIntervalMs=100,maxRequestsPerMinute=120,
    sharedMinIntervalMs=120,sharedMaxRequestsPerMinute=100
  }) {
    this.baseUrls=[...baseUrls]; this.fetchImpl=fetchImpl; this.timeoutMs=timeoutMs;
    this.minIntervalMs=minIntervalMs; this.maxRequestsPerMinute=maxRequestsPerMinute;
    this.sharedMinIntervalMs=sharedMinIntervalMs; this.sharedMaxRequestsPerMinute=sharedMaxRequestsPerMinute;
    this.usedAt=[]; this.lastRequestAt=0; this.currentBaseIndex=0;
    this.lastSuccessAt=null; this.lastError=null; this.rateLimitedUntil=0; this.state='INIT';
  }
  health(){return {
    state:this.state,last_success_at:this.lastSuccessAt,last_error:this.lastError,
    rate_limited_until:this.rateLimitedUntil||null,
    current_base_url:this.baseUrls[this.currentBaseIndex]??null,
    shared_cache_entries:SHARED_STATE.cache.size
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
  }
  async request(path,query={}) {
    if(!String(path).startsWith('/api/v3/')) throw new Error('REST_PATH_NOT_ALLOWED');

    const ttl=ttlFor(path,query);
    const key=cacheKey(path,query);
    if(ttl>0){
      const cached=SHARED_STATE.cache.get(key);
      if(cached){
        const age=Date.now()-cached.at;
        if(age<=ttl){
          const data=cloneCached(cached.data,query,cached.query,path);
          if(data!==null){
            this.lastSuccessAt=cached.receivedAt;
            this.lastError=null;
            this.state='LIVE';
            return {data,source:cached.source,receivedAt:cached.receivedAt,cache_hit:true};
          }
        }else{
          SHARED_STATE.cache.delete(key);
        }
      }
    }

    const qs=new URLSearchParams();
    for(const [k,v] of Object.entries(query)) if(v!=null) qs.set(k,String(v));
    let error=null;
    for(let attempt=0;attempt<this.baseUrls.length;attempt++){
      await waitSharedBudget(this.sharedMaxRequestsPerMinute,this.sharedMinIntervalMs);
      await this.waitBudget();
      const idx=(this.currentBaseIndex+attempt)%this.baseUrls.length;
      const url=this.baseUrls[idx]+path+(qs.toString()?'?'+qs:'');
      const ac=new AbortController(); const tm=setTimeout(()=>ac.abort(),this.timeoutMs);
      this.lastRequestAt=Date.now(); this.usedAt.push(this.lastRequestAt); SHARED_STATE.lastRequestAt=this.lastRequestAt; SHARED_STATE.usedAt.push(this.lastRequestAt); this.state='REQUESTING';
      try{
        const r=await this.fetchImpl(url,{method:'GET',signal:ac.signal,headers:{Accept:'application/json'}});
        if(r.status===429||r.status===418){
          const wait=retryAfterMs(r.headers)??Math.min(60000,1000*(2**attempt));
          this.rateLimitedUntil=Date.now()+wait; SHARED_STATE.rateLimitedUntil=Math.max(SHARED_STATE.rateLimitedUntil,Date.now()+wait);
          this.state='RATE_LIMITED'; throw new RestRateLimitError(wait);
        }
        if(!r.ok) throw new Error('HTTP_'+r.status);
        const data=await r.json();
        const receivedAt=Date.now();
        this.currentBaseIndex=idx; this.lastSuccessAt=receivedAt;
        this.lastError=null; this.state='LIVE';
        if(ttl>0) SHARED_STATE.cache.set(key,{at:receivedAt,receivedAt,data,source:this.baseUrls[idx],query:{...query}});
        return {data,source:this.baseUrls[idx],receivedAt,cache_hit:false};
      }catch(e){
        error=e; this.lastError=String(e?.message??e);
        if(e?.name==='RestRateLimitError') break;
      }finally{clearTimeout(tm);}
    }
    if(error?.name==='RestRateLimitError') throw error;
    this.state='ERROR'; throw error??new Error('REST_REQUEST_FAILED');
  }
  async klines(symbol,interval,opts={}) {
    const r=await this.request('/api/v3/klines',{
      symbol,interval,limit:opts.limit??250,startTime:opts.startTime,endTime:opts.endTime
    });
    const now=Date.now();
    return {source:r.source,receivedAt:r.receivedAt??now,cache_hit:Boolean(r.cache_hit),candles:r.data.map(x=>({
      openTime:normalizeEpochMs(x[0], 'openTime'),open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),
      volume:Number(x[5]),closeTime:normalizeEpochMs(x[6], 'closeTime'),quoteVolume:Number(x[7]),tradeCount:Number(x[8]),
      takerBuyBaseVolume:Number(x[9]),takerBuyQuoteVolume:Number(x[10]),
      closed:Number(x[6])<now,source:'BINANCE_PUBLIC_REST',sourceTime:r.receivedAt??now
    }))};
  }
  depth(symbol,limit=100){return this.request('/api/v3/depth',{symbol,limit});}
  ticker24h(symbol){return this.request('/api/v3/ticker/24hr',{symbol});}
}
