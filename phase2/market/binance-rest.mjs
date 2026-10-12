import {normalizeEpochMs} from '../core/data-quality.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export const SPOT_REQUEST_WEIGHT_LIMIT_PER_MINUTE = 6000;
const sharedInFlightRequests = new Map();

export function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after');
  if (raw == null) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(raw);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}

function parseSymbolsParam(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  const text=String(value);
  try {
    const parsed=JSON.parse(text);
    return Array.isArray(parsed)?parsed:null;
  } catch {
    return null;
  }
}

export function requestWeightFor(path,query={}) {
  const p=String(path||'').split('?')[0];
  if(p==='/api/v3/exchangeInfo')return 20;
  if(p==='/api/v3/klines')return 2;
  if(p==='/api/v3/aggTrades')return 4;
  if(p==='/api/v3/depth'){
    const n=Math.trunc(Number(query?.limit??100));
    if(n<=100)return 5;
    if(n<=500)return 25;
    if(n<=1000)return 50;
    return 250;
  }
  if(p==='/api/v3/ticker/24hr'){
    if(query?.symbol!=null)return 2;
    const symbols=parseSymbolsParam(query?.symbols);
    if(!symbols)return 80;
    if(symbols.length<=20)return 2;
    if(symbols.length<=100)return 40;
    return 80;
  }
  return 1;
}

export class RestRateLimitError extends Error {
  constructor(retryMs,status=429) {
    super('BINANCE_RATE_LIMIT');
    this.name='RestRateLimitError';
    this.retryMs=Math.max(0,Number(retryMs)||0);
    this.status=status;
  }
}

function headerNumber(headers,name){
  const raw=headers?.get?.(name);
  const n=Number(raw);
  return Number.isFinite(n)?n:null;
}

export function observedRequestWeight(headers) {
  const direct=headerNumber(headers,'x-mbx-used-weight-1m');
  if(direct!=null)return direct;
  if(!headers?.entries)return null;
  let best=null;
  for(const [k,v] of headers.entries()){
    if(!/^x-mbx-used-weight-\d+m$/i.test(k))continue;
    const n=Number(v);
    if(Number.isFinite(n))best=best==null?n:Math.max(best,n);
  }
  return best;
}

export function createRestRequestBudget({maxConcurrentRequests=16}={}){
  const cap=Math.max(1,Math.min(64,Math.trunc(Number(maxConcurrentRequests)||16)));
  return {usedAt:[],rateLimitedUntil:0,observedWeight:null,observedWeightAt:null,reservationQueue:Promise.resolve(),reservationQueueDepth:0,maxConcurrentRequests:cap,activeRequests:0,maxObservedActiveRequests:0,requestSlotWaiters:[]};
}

export class RestClient {
  constructor({
    baseUrls,
    fetchImpl=globalThis.fetch,
    timeoutMs=9000,
    minIntervalMs=100,
    maxRequestsPerMinute=120,
    maxWeightPerMinute=SPOT_REQUEST_WEIGHT_LIMIT_PER_MINUTE,
    safetyMarginWeight=100,
    clock=()=>Date.now(),
    sleepFn=sleep,
    budget=null,
    maxConcurrentRequests=1
  }) {
    this.baseUrls=[...baseUrls];
    this.fetchImpl=fetchImpl;
    this.timeoutMs=timeoutMs;
    this.minIntervalMs=minIntervalMs;
    this.maxRequestsPerMinute=maxRequestsPerMinute;
    this.maxWeightPerMinute=Math.max(1,Math.trunc(Number(maxWeightPerMinute)||SPOT_REQUEST_WEIGHT_LIMIT_PER_MINUTE));
    this.safetyMarginWeight=Math.max(0,Math.trunc(Number(safetyMarginWeight)||0));
    this.clock=clock;
    this.sleepFn=sleepFn;
    this.budget=budget??createRestRequestBudget();
    this.maxConcurrentRequests=Math.max(1,Math.min(64,Math.trunc(Number(maxConcurrentRequests)||1)));
    this.activeRequests=0;
    this.pendingTasks=[];
    if(!this.budget||!Array.isArray(this.budget.usedAt)||!(this.budget.reservationQueue instanceof Promise))throw new Error('INVALID_REST_REQUEST_BUDGET');
    this.usedAt=this.budget.usedAt;
    this.lastRequestAt=0;
    this.currentBaseIndex=0;
    this.lastSuccessAt=null;
    this.lastError=null;
    this.state='INIT';
    this.queue=Promise.resolve();
    this.queueDepth=0;
    this.queueWaitSamples=[];
    this.lastQueueWaitMs=null;
    this.maxQueueWaitMs=0;
    this.inflightRequests=new Map();
    this.coalescedRequestCount=0;
  }

  get rateLimitedUntil(){return this.budget.rateLimitedUntil;}
  set rateLimitedUntil(value){this.budget.rateLimitedUntil=Math.max(0,Number(value)||0);}
  get observedWeight(){return this.budget.observedWeight;}
  set observedWeight(value){this.budget.observedWeight=value==null?null:Number(value);}
  get observedWeightAt(){return this.budget.observedWeightAt;}
  set observedWeightAt(value){this.budget.observedWeightAt=value==null?null:Number(value);}

  get budgetLimit() {
    return Math.max(1,this.maxWeightPerMinute-this.safetyMarginWeight);
  }

  health(){return {
    state:this.state,
    last_success_at:this.lastSuccessAt,
    last_error:this.lastError,
    rate_limited_until:this.rateLimitedUntil||null,
    current_base_url:this.baseUrls[this.currentBaseIndex]??null,
    queue_depth:this.queueDepth,
    shared_budget_waiters:this.budget.reservationQueueDepth,
    active_request_count:this.activeRequests,
    max_concurrent_requests:this.maxConcurrentRequests,
    shared_active_requests:this.budget.activeRequests,
    shared_max_concurrent_requests:this.budget.maxConcurrentRequests,
    shared_request_slot_waiters:this.budget.requestSlotWaiters.length,
    queue_wait_ms_last:this.lastQueueWaitMs,
    queue_wait_ms_p95:this.queueWaitSamples.length ? [...this.queueWaitSamples].sort((a,b)=>a-b)[Math.ceil(this.queueWaitSamples.length*0.95)-1] : null,
    queue_wait_ms_max:this.queueWaitSamples.length ? this.maxQueueWaitMs : null,
    queue_wait_samples:this.queueWaitSamples.length,
    inflight_request_count:this.inflightRequests.size,
    coalesced_request_count:this.coalescedRequestCount,
    request_weight_used_last_minute:this.localWeightUsed(),
    observed_request_weight_1m:this.observedWeight,
    observed_request_weight_at:this.observedWeightAt,
    max_weight_per_minute:this.maxWeightPerMinute,
    safety_margin_weight:this.safetyMarginWeight,
    budget_limit_weight:this.budgetLimit
  };}

  localWeightUsed(now=this.clock()){
    const cutoff=now-60000;let write=0;
    for(const item of this.usedAt)if(item.at>cutoff)this.usedAt[write++]=item;
    this.usedAt.length=write;
    return this.usedAt.reduce((s,x)=>s+x.weight,0);
  }

  async waitBudget(weight) {
    const w=Math.max(1,Math.trunc(Number(weight)||1));
    this.budget.reservationQueueDepth++;
    try{
      while(true){
        let release;
        const previous=this.budget.reservationQueue;
        this.budget.reservationQueue=new Promise(resolve=>{release=resolve;});
        await previous;
        let reserved=false,waitMs=0;
        try{
          const now=this.clock();
          if(this.rateLimitedUntil>now)waitMs=this.rateLimitedUntil-now;
          else{
            const local=this.localWeightUsed(now);
            const observed=this.observedWeight;
            const observedFresh=observed!=null&&this.observedWeightAt!=null&&(now-this.observedWeightAt<60000);
            if(local+w<=this.budgetLimit&&(!observedFresh||observed+w<=this.budgetLimit)){
              const gap=this.clock()-this.lastRequestAt;
              if(gap<this.minIntervalMs)waitMs=this.minIntervalMs-gap;
              else{
                // Reserve weight atomically across all clients using this budget, before
                // the network await begins; independent clients can still fetch in parallel.
                const reservedAt=this.clock();
                this.usedAt.push({at:reservedAt,weight:w});
                this.lastRequestAt=reservedAt;
                reserved=true;
              }
            }else{
              const oldest=this.usedAt[0]?.at;
              waitMs=oldest!=null?Math.max(100,oldest+60000-now):1000;
              if(observedFresh&&observed+w>this.budgetLimit)waitMs=Math.max(waitMs,60000-(now%60000)+250);
            }
          }
        }finally{release();}
        if(reserved)return;
        await this.sleepFn(Math.max(1,waitMs||100));
      }
    }finally{this.budget.reservationQueueDepth=Math.max(0,this.budget.reservationQueueDepth-1);}
  }

  async enqueue(task) {
    this.queueDepth++;
    const queuedAt=this.clock();
    return new Promise((resolve,reject)=>{
      this.pendingTasks.push({task,resolve,reject,queuedAt});
      this._drainQueue();
    });
  }

  _drainQueue(){
    while(this.activeRequests<this.maxConcurrentRequests&&this.pendingTasks.length){
      const item=this.pendingTasks.shift();
      this.activeRequests++;
      const waited=Math.max(0,this.clock()-item.queuedAt);
      this.lastQueueWaitMs=waited;this.maxQueueWaitMs=Math.max(this.maxQueueWaitMs,waited);
      this.queueWaitSamples.push(waited);if(this.queueWaitSamples.length>256)this.queueWaitSamples.shift();
      Promise.resolve().then(item.task).then(item.resolve,item.reject).finally(()=>{
        this.activeRequests=Math.max(0,this.activeRequests-1);
        this.queueDepth=Math.max(0,this.queueDepth-1);
        this._drainQueue();
      });
    }
  }

  _makeSlotRelease(){
    let released=false;const budget=this.budget;
    return ()=>{
      if(released)return;released=true;
      const next=budget.requestSlotWaiters.shift();
      if(next)next(this._makeSlotRelease());
      else budget.activeRequests=Math.max(0,budget.activeRequests-1);
    };
  }

  async acquireRequestSlot(){
    const budget=this.budget;
    if(budget.activeRequests<budget.maxConcurrentRequests){
      budget.activeRequests++;
      budget.maxObservedActiveRequests=Math.max(budget.maxObservedActiveRequests,budget.activeRequests);
      return this._makeSlotRelease();
    }
    const release=await new Promise(resolve=>budget.requestSlotWaiters.push(resolve));
    return release;
  }

  async _request(path,query={}) {
    if(!String(path).startsWith('/api/v3/'))throw new Error('REST_PATH_NOT_ALLOWED');
    const qs=new URLSearchParams();
    for(const [k,v] of Object.entries(query))if(v!=null)qs.set(k,String(v));
    const weight=requestWeightFor(path,query);
    let error=null;
    for(let attempt=0;attempt<this.baseUrls.length;attempt++){
      await this.waitBudget(weight);
      const releaseSlot=await this.acquireRequestSlot();
      const idx=(this.currentBaseIndex+attempt)%this.baseUrls.length;
      const url=this.baseUrls[idx]+path+(qs.toString()?'?'+qs:'');
      const ac=new AbortController();
      const tm=setTimeout(()=>ac.abort(),this.timeoutMs);
      // Request weight was reserved by waitBudget before this network call.
      this.state='REQUESTING';
      try{
        const r=await this.fetchImpl(url,{method:'GET',signal:ac.signal,headers:{Accept:'application/json'}});
        const observed=observedRequestWeight(r.headers);
        if(observed!=null){this.observedWeight=observed;this.observedWeightAt=this.clock();}
        if(r.status===429||r.status===418){
          const retryHeader=retryAfterMs(r.headers);
          const fallback=r.status===418
            ?Math.min(15*60*1000,120000*Math.pow(2,attempt))
            :Math.min(60000,1000*Math.pow(2,attempt));
          const wait=Math.max(retryHeader??0,fallback);
          this.rateLimitedUntil=this.clock()+wait;
          this.state='RATE_LIMITED';
          throw new RestRateLimitError(wait,r.status);
        }
        if(!r.ok)throw new Error('HTTP_'+r.status);
        const data=await r.json();
        this.currentBaseIndex=idx;
        this.lastSuccessAt=this.clock();
        this.lastError=null;
        this.state='LIVE';
        return {data,source:this.baseUrls[idx],weight,observedRequestWeight:this.observedWeight};
      }catch(e){
        error=e;
        this.lastError=String(e?.message??e);
        if(e?.name==='RestRateLimitError')break;
      }finally{clearTimeout(tm);releaseSlot();}
    }
    if(error?.name==='RestRateLimitError')throw error;
    this.state='ERROR';
    throw error??new Error('REST_REQUEST_FAILED');
  }

  request(path,query={}) {
    const normalized=Object.entries(query||{}).filter(([,value])=>value!=null)
      .map(([key,value])=>[key,String(value)]).sort(([a],[b])=>a.localeCompare(b));
    const key=String(path)+'?'+new URLSearchParams(normalized).toString();
    const local=this.inflightRequests.get(key);
    if(local){
      this.coalescedRequestCount++;
      return local;
    }
    const sharedKey=JSON.stringify(this.baseUrls)+'|'+key;
    const shared=sharedInFlightRequests.get(sharedKey);
    if(shared){
      this.coalescedRequestCount++;
      return shared;
    }
    const work=this.enqueue(()=>this._request(path,query));
    let tracked;
    tracked=work.finally(()=>{
      if(this.inflightRequests.get(key)===tracked)this.inflightRequests.delete(key);
      if(sharedInFlightRequests.get(sharedKey)===tracked)sharedInFlightRequests.delete(sharedKey);
    });
    this.inflightRequests.set(key,tracked);
    sharedInFlightRequests.set(sharedKey,tracked);
    return tracked;
  }

  async klines(symbol,interval,opts={}) {
    const r=await this.request('/api/v3/klines',{
      symbol,interval,limit:opts.limit??250,startTime:opts.startTime,endTime:opts.endTime
    });
    const now=this.clock();
    return {source:r.source,receivedAt:now,candles:r.data.map(x=>({
      openTime:normalizeEpochMs(x[0],'openTime'),open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),
      volume:Number(x[5]),closeTime:normalizeEpochMs(x[6],'closeTime'),quoteVolume:Number(x[7]),tradeCount:Number(x[8]),
      takerBuyBaseVolume:Number(x[9]),takerBuyQuoteVolume:Number(x[10]),
      closed:Number(x[6])<now,source:'BINANCE_PUBLIC_REST',sourceTime:now
    }))};
  }
  depth(symbol,limit=100){return this.request('/api/v3/depth',{symbol,limit});}
  aggTrades(symbol,opts={}){
    return this.request('/api/v3/aggTrades',{symbol,limit:Math.min(1000,Math.max(1,Math.trunc(Number(opts.limit)||1000))),startTime:opts.startTime,endTime:opts.endTime,fromId:opts.fromId})
      .then(r=>({source:r.source,receivedAt:this.clock(),trades:r.data,data:r.data}));
  }
  ticker24h(symbol){return this.request('/api/v3/ticker/24hr',symbol?{symbol}:{});}
}
