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
    current_base_url:this.baseUrls[this.currentBaseIndex]??null
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
    const qs=new URLSearchParams();
    for(const [k,v] of Object.entries(query)) if(v!=null) qs.set(k,String(v));
    let error=null;
    for(let attempt=0;attempt<this.baseUrls.length;attempt++){
      await this.waitBudget();
      const idx=(this.currentBaseIndex+attempt)%this.baseUrls.length;
      const url=this.baseUrls[idx]+path+(qs.toString()?'?'+qs:'');
      const ac=new AbortController(); const tm=setTimeout(()=>ac.abort(),this.timeoutMs);
      this.lastRequestAt=Date.now(); this.usedAt.push(this.lastRequestAt); this.state='REQUESTING';
      try{
        const r=await this.fetchImpl(url,{method:'GET',signal:ac.signal,headers:{Accept:'application/json'}});
        if(r.status===429||r.status===418){
          const wait=retryAfterMs(r.headers)??Math.min(60000,1000*(2**attempt));
          this.rateLimitedUntil=Date.now()+wait; this.state='RATE_LIMITED'; throw new RestRateLimitError(wait);
        }
        if(!r.ok) throw new Error('HTTP_'+r.status);
        const data=await r.json(); this.currentBaseIndex=idx; this.lastSuccessAt=Date.now();
        this.lastError=null; this.state='LIVE'; return {data,source:this.baseUrls[idx]};
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
    return {source:r.source,receivedAt:now,candles:r.data.map(x=>({
      openTime:Number(x[0]),open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),
      volume:Number(x[5]),closeTime:Number(x[6]),quoteVolume:Number(x[7]),tradeCount:Number(x[8]),
      takerBuyBaseVolume:Number(x[9]),takerBuyQuoteVolume:Number(x[10]),
      closed:Number(x[6])<now,source:'BINANCE_PUBLIC_REST',sourceTime:now
    }))};
  }
  depth(symbol,limit=100){return this.request('/api/v3/depth',{symbol,limit});}
  ticker24h(symbol){return this.request('/api/v3/ticker/24hr',{symbol});}
}
