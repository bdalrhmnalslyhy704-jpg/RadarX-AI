import {timeframeMs} from '../../phase1/radarx-phase1-engine.mjs';
import {expectedGap,validateSeries} from './data-quality.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

class SeriesBuffer{
  constructor(maxLength=300){this.maxLength=maxLength;this.map=new Map();}
  merge(candles){
    const byTime=new Map((this.map.size?this.map.values():[]));
    for(const c of candles){
      if(!Number.isFinite(Number(c.openTime)))continue;
      byTime.set(Number(c.openTime),{...c});
    }
    const a=[...byTime.values()].sort((x,y)=>Number(x.openTime)-Number(y.openTime));
    const closed=a.filter(x=>x.closed===true);
    const latestClosed=closed.length?closed[closed.length-1]:null;
    if(latestClosed&&closed.length>1){
      for(let i=1;i<closed.length;i++){
        if(Number(closed[i].openTime)<=Number(closed[i-1].openTime))throw new Error('UNORDERED_SERIES');
      }
    }
    this.map.clear();
    for(const c of a.slice(-this.maxLength))this.map.set(Number(c.openTime),c);
    return latestClosed;
  }
  all(){return [...this.map.values()];}
  lastClosed(){return [...this.map.values()].reverse().find(x=>x.closed===true)||null;}
}

export class MarketMonitor{
  constructor({config,rest,wsFactory,signalService,store,pushManager,clock=()=>Date.now(),logger=console}){
    this.config=config;this.rest=rest;this.wsFactory=wsFactory;this.signalService=signalService;this.store=store;this.pushManager=pushManager;this.clock=clock;this.logger=logger;
    this.series=new Map();this.unresolved=new Map();this.lastComplete=new Map();this.lastAnalysisAt=null;this.running=false;
    this.repairTimer=null;this.retryTimer=null;this.ws=null;this.wsState='STOPPED';this.bootstrapDone=false;
  }
  key(symbol,tf){return symbol.toUpperCase()+'|'+tf;}
  getSeries(symbol,tf){const k=this.key(symbol,tf);if(!this.series.has(k))this.series.set(k,new SeriesBuffer(this.config.monitoring.maxSeriesLength));return this.series.get(k);}
  isGap(symbol,tf){return Boolean(this.unresolved.get(this.key(symbol,tf))?.length);}
  markGap(symbol,tf,gaps){const k=this.key(symbol,tf);if(gaps.length)this.unresolved.set(k,[...new Set(gaps)]);else this.unresolved.delete(k);}
  mergeCandles(symbol,tf,candles){
    const buf=this.getSeries(symbol,tf);const old=buf.lastClosed();
    const normalized=candles.map(x=>({...x,symbol,timeframe:tf}));
    buf.merge(normalized);const latest=buf.lastClosed();
    if(old&&latest){
      const gaps=expectedGap(old,latest,tf);
      this.markGap(symbol,tf,gaps);
    }
    if(latest)this.lastComplete.set(this.key(symbol,tf),latest);
    const check=validateSeries(buf.all(),tf);
    if(!check.valid)this.markGap(symbol,tf,check.issues);
    return buf.all();
  }
  async bootstrap(){
    for(const symbol of this.config.symbols){
      await Promise.all(this.config.timeframes.map(async tf=>{
        try{
          const r=await this.rest.klines(symbol,tf,{limit:this.config.monitoring.bootstrapKlines});
          this.mergeCandles(symbol,tf,r.candles);
        }catch(e){this.logger.warn('REST bootstrap failed',symbol,tf,String(e?.message??e));}
      }));
    }
    this.bootstrapDone=true;
  }
  streams(){
    return this.config.symbols.flatMap(symbol=>this.config.timeframes.map(tf=>symbol.toLowerCase()+'@kline_'+tf));
  }
  async start(){
    if(this.running)return;
    this.running=true;
    await this.store.init();
    await this.bootstrap();
    this.ws=this.wsFactory({
      urls:this.config.websocket.urls,streams:this.streams(),
      initialBackoffMs:this.config.websocket.initialBackoffMs,maxBackoffMs:this.config.websocket.maxBackoffMs,
      jitterRatio:this.config.websocket.jitterRatio,heartbeatTimeoutMs:this.config.websocket.heartbeatTimeoutMs,
      maxConnectionMs:this.config.websocket.maxConnectionMs,
      onCandle:c=>this.onCandle(c),
      onState:(state,reason)=>{this.wsState=state;this.logger.info?.('WS',state,reason||'');}
    });
    this.ws.start();
    this.repairTimer=setInterval(()=>this.repairAll().catch(e=>this.logger.error('repairAll',e)),this.config.monitoring.periodicRepairMs);
    this.retryTimer=setInterval(()=>this.pushManager?.flushRetries(this.clock()).catch(e=>this.logger.error('push retry',e)),this.config.monitoring.pushRetryMs);
  }
  async stop(){
    this.running=false;
    if(this.repairTimer)clearInterval(this.repairTimer);if(this.retryTimer)clearInterval(this.retryTimer);
    this.repairTimer=this.retryTimer=null;this.ws?.stop();this.ws=null;this.wsState='STOPPED';
  }
  async repairOne(symbol,tf){
    const r=await this.rest.klines(symbol,tf,{limit:this.config.monitoring.repairKlines});
    const series=this.mergeCandles(symbol,tf,r.candles);
    const v=validateSeries(series,tf);
    if(v.valid)this.unresolved.delete(this.key(symbol,tf));
    else this.markGap(symbol,tf,v.issues);
    return {source:r.source,series,valid:v.valid,issues:v.issues};
  }
  async repairAll(){
    if(!this.running)return;
    for(const symbol of this.config.symbols){
      for(const tf of this.config.timeframes){
        try{await this.repairOne(symbol,tf);}catch(e){this.logger.warn('REST repair failed',symbol,tf,String(e?.message??e));}
      }
    }
  }
  async onCandle(candle){
    if(!this.running)return;
    const symbol=String(candle.symbol||'').toUpperCase(),tf=String(candle.timeframe||'');
    if(!this.config.symbols.includes(symbol)||!this.config.timeframes.includes(tf))return;
    const now=this.clock();
    if(Number(candle.openTime)>now||Number(candle.closeTime)>now){
      this.markGap(symbol,tf,['FUTURE_DATA']);
      try{await this.repairOne(symbol,tf);}catch{}
      return;
    }
    const previous=this.getSeries(symbol,tf).lastClosed();
    this.mergeCandles(symbol,tf,[candle]);
    if(candle.closed===true){
      const gaps=expectedGap(previous,candle,tf);
      if(gaps.length){
        this.markGap(symbol,tf,gaps);
        try{await this.repairOne(symbol,tf);}catch{}
      }
      if(tf==='15m')await this.analyzeSymbol(symbol);
    }
  }
  async freshLiquidity(symbol){
    const [book,ticker]=await Promise.all([this.rest.depth(symbol,100),this.rest.ticker24h(symbol)]);
    return {bookRaw:book.data,ticker24hRaw:ticker.data};
  }
  async analyzeSymbol(symbol){
    const s4=this.getSeries(symbol,'4h').all(),s1=this.getSeries(symbol,'1h').all(),s15=this.getSeries(symbol,'15m').all();
    const now=this.clock();
    if(!s15.some(x=>x.closed))return;
    let market;
    try{market=await this.freshLiquidity(symbol);}catch(e){this.lastAnalysisAt=now;this.logger.warn('liquidity fetch failed',symbol,String(e?.message??e));return;}
    const out=await this.signalService.evaluateSnapshot({
      symbol,series4h:s4,series1h:s1,series15m:s15,bookRaw:market.bookRaw,ticker24hRaw:market.ticker24hRaw,
      wsState:this.wsState,restLastSuccessAt:this.rest.lastSuccessAt,source:this.wsState==='LIVE'?'BINANCE_PUBLIC_WS':'BINANCE_PUBLIC_REST',
      unresolvedGap:this.isGap(symbol,'4h')||this.isGap(symbol,'1h')||this.isGap(symbol,'15m')
    });
    this.lastAnalysisAt=now;
    return out;
  }
  health(){
    const latest=[...this.lastComplete.entries()].sort((a,b)=>Number(a[1].closeTime)-Number(b[1].closeTime)).at(-1)?.[1]||null;
    return {
      websocket:this.ws?.health?.()||{state:this.wsState,last_message_at:null,last_connected_at:null,reconnect_attempts:0,url:null},
      last_complete_candle:latest?{symbol:latest.symbol||'UNKNOWN',timeframe:latest.timeframe||'UNKNOWN',open_time:latest.openTime,close_time:latest.closeTime}:null,
      last_analysis_at:this.lastAnalysisAt,
      rest:this.rest.health(),
      database:this.store.health?this.store.health():{state:'UNKNOWN'},
      monitoring:{running:this.running,bootstrap_done:this.bootstrapDone,unresolved_gaps:[...this.unresolved.entries()].filter(([,v])=>v.length).map(([k,v])=>({key:k,count:v.length}))}
    };
  }
}
