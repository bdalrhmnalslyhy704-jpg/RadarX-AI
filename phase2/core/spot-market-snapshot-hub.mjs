const DEFAULT_TICKER_TTL_MS=1500;
const DEFAULT_EXCHANGE_INFO_TTL_MS=10*60*1000;
const nowMs=clock=>{const value=Number(clock());return Number.isFinite(value)?value:Date.now();};
function bounded(value,fallback,min,max){const n=Math.trunc(Number(value));return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;}
function normalizePayload(result){
  if(!result||!Array.isArray(result.data))throw new Error('SPOT_TICKER_PAYLOAD_INVALID');
  const receivedAt=Number(result.receivedAt??result.received_at??Date.now());
  if(!Number.isFinite(receivedAt))throw new Error('SPOT_TICKER_TIMESTAMP_INVALID');
  return {data:result.data,source:String(result.source??'BINANCE_PUBLIC_REST'),receivedAt};
}

/**
 * Shared source for full-market Spot snapshots. It caches only inside a short,
 * explicit freshness window; expired prices are never returned as live. Requests
 * for the same snapshot coalesce, while each radar performs its own bounded analysis.
 */
export class SpotMarketSnapshotHub {
  constructor({rest,clock=()=>Date.now(),tickerTtlMs=DEFAULT_TICKER_TTL_MS,exchangeInfoTtlMs=DEFAULT_EXCHANGE_INFO_TTL_MS,logger=console}={}){
    if(!rest||typeof rest.request!=='function')throw new Error('SPOT_MARKET_HUB_REST_REQUIRED');
    this.rest=rest;this.clock=clock;this.logger=logger;
    this.tickerTtlMs=bounded(tickerTtlMs,DEFAULT_TICKER_TTL_MS,100,5000);
    this.exchangeInfoTtlMs=bounded(exchangeInfoTtlMs,DEFAULT_EXCHANGE_INFO_TTL_MS,1000,60*60*1000);
    this.tickerSnapshot=null;this.exchangeInfoSnapshot=null;this.tickerPromise=null;this.exchangeInfoPromise=null;
    this.metrics={ticker_rest_requests:0,ticker_cache_hits:0,ticker_coalesced_reads:0,ticker_failures:0,exchange_info_rest_requests:0,exchange_info_cache_hits:0,exchange_info_coalesced_reads:0,exchange_info_failures:0};
    this.lastTickerError=null;this.lastExchangeInfoError=null;
  }
  _fresh(snapshot,ttl,now=nowMs(this.clock)){return Boolean(snapshot&&now>=snapshot.receivedAt&&now-snapshot.receivedAt<=ttl);}
  async ticker24h({force=false}={}){
    const now=nowMs(this.clock);
    if(!force&&this._fresh(this.tickerSnapshot,this.tickerTtlMs,now)){this.metrics.ticker_cache_hits++;return {...this.tickerSnapshot,ageMs:Math.max(0,now-this.tickerSnapshot.receivedAt),cache:'FRESH'};}
    if(this.tickerPromise){this.metrics.ticker_coalesced_reads++;const value=await this.tickerPromise;const ageMs=Math.max(0,nowMs(this.clock)-value.receivedAt);if(ageMs>this.tickerTtlMs)throw new Error('SPOT_TICKER_SNAPSHOT_STALE');return {...value,ageMs,cache:'COALESCED'};}
    this.metrics.ticker_rest_requests++;
    this.tickerPromise=(async()=>{
      const raw=await this.rest.request('/api/v3/ticker/24hr');
      const normalized=normalizePayload({...raw,receivedAt:raw?.receivedAt??nowMs(this.clock)});
      if(!normalized.data.length)throw new Error('SPOT_TICKER_SNAPSHOT_EMPTY');
      this.tickerSnapshot=normalized;this.lastTickerError=null;return normalized;
    })();
    try{const value=await this.tickerPromise;const ageMs=Math.max(0,nowMs(this.clock)-value.receivedAt);if(ageMs>this.tickerTtlMs)throw new Error('SPOT_TICKER_SNAPSHOT_STALE');return {...value,ageMs,cache:'MISS'};}
    catch(error){this.metrics.ticker_failures++;this.lastTickerError=String(error?.message??error);try{this.logger.warn?.('[SPOT_MARKET_HUB] ticker snapshot unavailable '+this.lastTickerError);}catch{}throw error;}
    finally{this.tickerPromise=null;}
  }
  async exchangeInfo({force=false}={}){
    const now=nowMs(this.clock);
    if(!force&&this._fresh(this.exchangeInfoSnapshot,this.exchangeInfoTtlMs,now)){this.metrics.exchange_info_cache_hits++;return {...this.exchangeInfoSnapshot,ageMs:Math.max(0,now-this.exchangeInfoSnapshot.receivedAt),cache:'FRESH'};}
    if(this.exchangeInfoPromise){this.metrics.exchange_info_coalesced_reads++;const value=await this.exchangeInfoPromise;return {...value,ageMs:Math.max(0,nowMs(this.clock)-value.receivedAt),cache:'COALESCED'};}
    this.metrics.exchange_info_rest_requests++;
    this.exchangeInfoPromise=(async()=>{
      const raw=await this.rest.request('/api/v3/exchangeInfo');
      if(!raw||!raw.data||!Array.isArray(raw.data.symbols))throw new Error('SPOT_EXCHANGE_INFO_PAYLOAD_INVALID');
      const value={data:raw.data,source:String(raw.source??'BINANCE_PUBLIC_REST'),receivedAt:nowMs(this.clock)};
      this.exchangeInfoSnapshot=value;this.lastExchangeInfoError=null;return value;
    })();
    try{const value=await this.exchangeInfoPromise;return {...value,ageMs:Math.max(0,nowMs(this.clock)-value.receivedAt),cache:'MISS'};}
    catch(error){this.metrics.exchange_info_failures++;this.lastExchangeInfoError=String(error?.message??error);try{this.logger.warn?.('[SPOT_MARKET_HUB] exchangeInfo unavailable '+this.lastExchangeInfoError);}catch{}throw error;}
    finally{this.exchangeInfoPromise=null;}
  }
  async coverage(quote='USDT'){
    const q=String(quote||'USDT').trim().toUpperCase();
    const [info,tickers]=await Promise.all([this.exchangeInfo(),this.ticker24h()]);
    const snapshotAge=Math.max(0,nowMs(this.clock)-tickers.receivedAt);
    if(snapshotAge>this.tickerTtlMs)throw new Error('SPOT_TICKER_SNAPSHOT_STALE');
    const eligible=(info.data.symbols||[]).filter(s=>s.status==='TRADING'&&s.isSpotTradingAllowed!==false&&s.quoteAsset===q&&s.symbol&&/^[A-Z0-9]{5,30}$/.test(s.symbol));
    const available=new Set(tickers.data.map(x=>String(x?.symbol??'').toUpperCase()).filter(Boolean));
    const missing=eligible.filter(s=>!available.has(s.symbol)).map(s=>s.symbol);
    return {quote:q,eligible_spot_symbols:eligible.length,ticker_symbols_received:tickers.data.length,eligible_symbols_with_ticker:eligible.length-missing.length,missing_ticker_count:missing.length,missing_ticker_samples:missing.slice(0,25),ticker_snapshot_age_ms:snapshotAge,ticker_ttl_ms:this.tickerTtlMs,ticker_source:tickers.source,status:eligible.length===0?'UNAVAILABLE':missing.length===0?'COMPLETE':missing.length<eligible.length?'PARTIAL':'UNAVAILABLE',observed_at:tickers.receivedAt};
  }
  health(){
    const now=nowMs(this.clock),tickerAge=this.tickerSnapshot?now-this.tickerSnapshot.receivedAt:null,infoAge=this.exchangeInfoSnapshot?now-this.exchangeInfoSnapshot.receivedAt:null;
    return {service:'SPOT_MARKET_SNAPSHOT_HUB',ticker_status:this._fresh(this.tickerSnapshot,this.tickerTtlMs,now)?'LIVE':this.tickerSnapshot?'STALE':'UNAVAILABLE',ticker_age_ms:tickerAge,ticker_ttl_ms:this.tickerTtlMs,ticker_symbols:this.tickerSnapshot?.data?.length??0,ticker_source:this.tickerSnapshot?.source??null,exchange_info_status:this._fresh(this.exchangeInfoSnapshot,this.exchangeInfoTtlMs,now)?'FRESH':'UNAVAILABLE_OR_STALE',exchange_info_age_ms:infoAge,exchange_info_symbols:this.exchangeInfoSnapshot?.data?.symbols?.length??0,metrics:{...this.metrics},last_ticker_error:this.lastTickerError,last_exchange_info_error:this.lastExchangeInfoError,expired_ticker_never_served:true};
  }
}
