import {buildAdaptiveLearningProfile,findMissedMoverEvents} from './adaptive-trader-engine.mjs';

const finite=value=>{
  if(value===null||value===undefined||value==='')return null;
  const n=Number(value);return Number.isFinite(n)?n:null;
};
const DEFAULT_INTERVAL_MS=5*60*1000;
const SAMPLE_HORIZON_MS=4*60*60*1000;
const HISTORY_MIN_INTERVAL_MS=15*60*1000;
const SNAPSHOT_LIMIT=40;
const MAX_SAMPLES=1000;
const MAX_HISTORY=15000;
const MAX_MISSED=500;

function emptyState(){
  return {
    version:1,enabled:false,scan_count:0,successful_scans:0,
    last_started_at:null,last_scan_at:null,last_duration_ms:null,last_error:null,
    last_summary:null,learning_profile:buildAdaptiveLearningProfile([]),
    samples:[],price_history:[],missed_movers:[]
  };
}
function cleanSymbol(value){return String(value||'').trim().toUpperCase();}
function mapCurrentPrices(rows){
  return new Map((Array.isArray(rows)?rows:[]).map(row=>[
    cleanSymbol(row?.symbol),finite(row?.price??row?.lastPrice)
  ]).filter(([symbol,price])=>symbol&&price!==null&&price>0));
}

export class AdaptiveTraderWorker{
  constructor({store,snapshotProvider,logger=console,intervalMs=DEFAULT_INTERVAL_MS,scanLimit=SNAPSHOT_LIMIT}={}){
    if(!store||typeof store.getAdaptiveTraderState!=='function'||typeof store.putAdaptiveTraderState!=='function')
      throw new Error('ADAPTIVE_TRADER_DURABLE_STORE_UNAVAILABLE');
    if(typeof snapshotProvider!=='function')throw new Error('ADAPTIVE_TRADER_SNAPSHOT_PROVIDER_UNAVAILABLE');
    this.store=store;this.snapshotProvider=snapshotProvider;this.logger=logger;
    this.intervalMs=Math.max(60_000,Math.min(10*60_000,Math.trunc(Number(intervalMs)||DEFAULT_INTERVAL_MS)));
    this.scanLimit=Math.max(40,Math.min(120,Math.trunc(Number(scanLimit)||SNAPSHOT_LIMIT)));
    this.state=emptyState();this.enabled=false;this.inFlight=false;
    this.interval=null;this.initialTimer=null;this.starting=null;
  }

  async start({initialDelayMs=25_000}={}){
    if(this.enabled)return this.snapshot();
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      try{
        const saved=await this.store.getAdaptiveTraderState();
        if(saved&&saved.version===1&&Array.isArray(saved.samples)&&Array.isArray(saved.price_history)){
          this.state={
            ...emptyState(),...saved,
            samples:saved.samples.slice(-MAX_SAMPLES),
            price_history:saved.price_history.slice(-MAX_HISTORY),
            missed_movers:Array.isArray(saved.missed_movers)?saved.missed_movers.slice(-MAX_MISSED):[],
            learning_profile:saved.learning_profile||buildAdaptiveLearningProfile(saved.samples)
          };
        }
      }catch(error){
        this.logger.warn?.('[ADAPTIVE_TRADER_STATE_LOAD_FAILED] '+String(error?.message??error).slice(0,180));
      }
      this.enabled=true;this.state.enabled=true;this.state.last_error=null;
      this.interval=setInterval(()=>{void this.runOnce();},this.intervalMs);
      this.interval.unref?.();
      const delay=Math.max(0,Math.min(this.intervalMs,Math.trunc(Number(initialDelayMs)||0)));
      this.initialTimer=setTimeout(()=>{this.initialTimer=null;void this.runOnce();},delay);
      this.initialTimer.unref?.();
      await this.persist();
      this.logger.info?.('[ADAPTIVE_TRADER_WORKER_STARTED] '+JSON.stringify({
        interval_ms:this.intervalMs,initial_delay_ms:delay,scan_limit:this.scanLimit,
        mode:'ISOLATED_READ_ONLY_PAPER_LEARNING',paper_trading:true,real_order_execution:false
      }));
      return this.snapshot();
    })().finally(()=>{this.starting=null;});
    return this.starting;
  }

  async stop(){
    if(this.interval)clearInterval(this.interval);
    if(this.initialTimer)clearTimeout(this.initialTimer);
    this.interval=null;this.initialTimer=null;this.enabled=false;this.state.enabled=false;
    await this.persist();
    return this.snapshot();
  }

  async persist(){
    try{await this.store.putAdaptiveTraderState({...this.state,enabled:this.enabled});}
    catch(error){this.logger.warn?.('[ADAPTIVE_TRADER_STATE_PERSIST_FAILED] '+String(error?.message??error).slice(0,180));}
  }

  async runOnce(){
    if(!this.enabled)return {status:'STOPPED',reason:'WORKER_DISABLED'};
    if(this.inFlight)return {status:'SCANNING',reason:'SCAN_ALREADY_IN_FLIGHT'};
    this.inFlight=true;
    const started=Date.now();
    this.state.scan_count=(Number(this.state.scan_count)||0)+1;
    this.state.last_started_at=started;
    this.state.last_error=null;
    try{
      const snapshot=await this.snapshotProvider({limit:this.scanLimit,now:Date.now()});
      if(!snapshot||snapshot.status!=='LIVE_DATA'||snapshot.meta?.live!==true||
         snapshot.meta?.paper_trading!==true||snapshot.meta?.real_order_execution!==false||
         snapshot.meta?.closed_candles_only!==true||snapshot.meta?.engine!=='ADAPTIVE_TRADER_SIDECAR_V1'||
         !Array.isArray(snapshot.candidates)||!Array.isArray(snapshot.latest_prices)){
        throw new Error('LIVE_ADAPTIVE_TRADER_SNAPSHOT_NOT_VERIFIED');
      }
      const now=Date.parse(snapshot.as_of);
      if(!Number.isFinite(now)||now>Date.now()+5000)throw new Error('ADAPTIVE_TRADER_SNAPSHOT_TIME_INVALID');
      this.resolveSamples(snapshot,now);
      this.collectPriceHistory(snapshot,now);
      this.collectMissedMovers(snapshot,now);
      this.state.successful_scans=(Number(this.state.successful_scans)||0)+1;
      this.state.last_scan_at=now;
      this.state.last_error=null;
      this.state.last_duration_ms=Math.max(0,Date.now()-started);
      this.state.learning_profile=buildAdaptiveLearningProfile(this.state.samples);
      this.state.last_summary=this.buildSummary(snapshot);
      await this.persist();
      this.logger.info?.('[ADAPTIVE_TRADER_SCAN_COMPLETE] '+JSON.stringify({
        as_of:snapshot.as_of,scan_count:this.state.scan_count,
        eligible:snapshot.universe?.eligible_spot_symbols??null,
        analyzed:snapshot.universe?.analyzed_symbols??snapshot.candidates.length,
        valid:snapshot.universe?.valid_symbols??snapshot.candidates.filter(row=>row.data_valid).length,
        early_setup:snapshot.candidates.filter(row=>row.data_valid&&row.tier==='EARLY_SETUP').length,
        resolved_samples:this.state.learning_profile.resolved_samples,
        missed_movers:this.state.missed_movers.filter(row=>row.classification==='POTENTIAL_MISSED_MOVER').length,
        worker_interval_ms:this.intervalMs,paper_trading:true,real_order_execution:false
      }));
      return {status:'SUCCESS',as_of:snapshot.as_of,summary:this.state.last_summary};
    }catch(error){
      this.state.last_error=String(error?.message??error).slice(0,240);
      this.state.last_duration_ms=Math.max(0,Date.now()-started);
      await this.persist();
      this.logger.warn?.('[ADAPTIVE_TRADER_SCAN_FAILED] '+JSON.stringify({
        scan_count:this.state.scan_count,error:this.state.last_error,
        paper_trading:true,real_order_execution:false
      }));
      return {status:'FAILED',error:this.state.last_error};
    }finally{this.inFlight=false;}
  }

  resolveSamples(snapshot,now){
    const prices=mapCurrentPrices(snapshot.latest_prices);
    for(const sample of this.state.samples){
      if(sample.outcome||now-Number(sample.at)<SAMPLE_HORIZON_MS)continue;
      const price=prices.get(cleanSymbol(sample.symbol));
      if(!(price>0)||!(sample.price>0))continue;
      const move=(price/sample.price-1)*100;
      sample.outcome=move>=2?'UP':move<=-2?'DOWN':'FLAT';
      sample.mark_price=price;sample.return_pct=Number(move.toFixed(3));
      sample.resolved_at=now;sample.horizon_ms=now-Number(sample.at);
    }
    const newest=new Map();
    for(const sample of this.state.samples){
      const old=newest.get(cleanSymbol(sample.symbol));
      if(!old||Number(sample.at)>Number(old.at))newest.set(cleanSymbol(sample.symbol),sample);
    }
    for(const candidate of snapshot.candidates){
      if(candidate?.data_valid!==true||candidate.data_stale===true||!(Number(candidate.price)>0)||finite(candidate.score)===null)continue;
      const symbol=cleanSymbol(candidate.symbol),old=newest.get(symbol);
      if(old&&now-Number(old.at)<SAMPLE_HORIZON_MS)continue;
      this.state.samples.push({
        id:symbol+':'+String(now),symbol,price:Number(candidate.price),at:now,
        base_score:Number(candidate.score),tier:String(candidate.tier||'NO_SETUP'),
        features:{...(candidate.features||{})},outcome:null,mark_price:null,return_pct:null
      });
      newest.set(symbol,{symbol,at:now});
    }
    this.state.samples=this.state.samples.slice(-MAX_SAMPLES);
  }

  collectPriceHistory(snapshot,now){
    const candidates=new Map(snapshot.candidates.map(row=>[cleanSymbol(row.symbol),row]));
    const latest=new Map();
    for(const row of this.state.price_history){
      const symbol=cleanSymbol(row.symbol),old=latest.get(symbol);
      if(!old||Number(row.at)>Number(old.at))latest.set(symbol,row);
    }
    for(const row of snapshot.latest_prices){
      const symbol=cleanSymbol(row.symbol),price=finite(row.price);
      if(!symbol||!(price>0))continue;
      const previous=latest.get(symbol);
      if(previous&&now-Number(previous.at)<HISTORY_MIN_INTERVAL_MS)continue;
      const candidate=candidates.get(symbol);
      this.state.price_history.push({
        symbol,price,at:now,
        tier:candidate?String(candidate.tier||'NO_SETUP'):'NOT_EVALUATED',
        score:candidate&&candidate.data_valid===true?finite(candidate.score):null,
        evaluated:Boolean(candidate&&candidate.data_valid===true&&!candidate.data_stale)
      });
      latest.set(symbol,{symbol,price,at:now});
    }
    this.state.price_history=this.state.price_history.slice(-MAX_HISTORY);
  }

  collectMissedMovers(snapshot,now){
    const events=findMissedMoverEvents({
      history:this.state.price_history,currentPrices:snapshot.latest_prices,
      now,thresholdPct:5,maxAgeMs:6*60*60*1000
    });
    const ids=new Set(this.state.missed_movers.map(row=>row.id));
    for(const event of events){
      if(ids.has(event.id))continue;
      const alreadyReported=(this.state.missed_movers||[]).some(row=>
        row.symbol===event.symbol&&now-Number(row.recorded_at||0)<6*60*60*1000);
      if(alreadyReported)continue;
      this.state.missed_movers.unshift({...event,recorded_at:now});
      ids.add(event.id);
    }
    this.state.missed_movers=this.state.missed_movers.slice(0,MAX_MISSED);
  }

  buildSummary(snapshot){
    return {
      as_of:snapshot.as_of,source:snapshot.source,status:snapshot.status,
      universe:{...(snapshot.universe||{})},
      counts:{
        valid:snapshot.candidates.filter(row=>row.data_valid===true&&!row.data_stale).length,
        early_setup:snapshot.candidates.filter(row=>row.data_valid===true&&row.tier==='EARLY_SETUP').length,
        watch:snapshot.candidates.filter(row=>row.data_valid===true&&row.tier==='WATCH').length,
        late_move:snapshot.candidates.filter(row=>row.data_valid===true&&row.tier==='LATE_MOVE').length,
        rejected:snapshot.candidates.filter(row=>row.data_valid!==true||row.data_stale===true).length
      },
      top_candidates:snapshot.candidates.filter(row=>row.data_valid===true&&!row.data_stale)
        .slice().sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0)).slice(0,20).map(row=>({
          symbol:row.symbol,price:row.price,score:row.score,tier:row.tier,
          quote_volume_24h:row.quote_volume_24h,change_24h_pct:row.change_24h_pct,
          candle_close_time:row.candle_close_time,features:row.features,reason_codes:row.reason_codes
        })),
      paper_trading:true,real_order_execution:false
    };
  }

  snapshot(){
    const status=!this.enabled?'STOPPED':this.inFlight?'SCANNING':this.state.last_error?'DEGRADED':
      this.state.last_summary?'RUNNING':'STARTING';
    return {
      status,enabled:this.enabled,running:this.enabled,in_flight:this.inFlight,
      interval_ms:this.intervalMs,scan_limit:this.scanLimit,
      scan_count:Number(this.state.scan_count)||0,
      successful_scans:Number(this.state.successful_scans)||0,
      last_started_at:this.state.last_started_at,
      last_scan_at:this.state.last_scan_at?new Date(this.state.last_scan_at).toISOString():null,
      last_duration_ms:this.state.last_duration_ms,last_error:this.state.last_error,
      next_scan_at:this.enabled?new Date(Date.now()+this.intervalMs).toISOString():null,
      last_summary:this.state.last_summary,
      learning_profile:this.state.learning_profile||buildAdaptiveLearningProfile(this.state.samples),
      missed_movers:(this.state.missed_movers||[]).slice(0,100),
      paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
      memory:{resolved_samples:(this.state.samples||[]).filter(row=>row.outcome).length,
        unresolved_samples:(this.state.samples||[]).filter(row=>!row.outcome).length,
        history_rows:(this.state.price_history||[]).length,
        potential_missed_movers:(this.state.missed_movers||[]).filter(row=>row.classification==='POTENTIAL_MISSED_MOVER').length}
    };
  }
}

export const ADAPTIVE_TRADER_WORKER_DEFAULTS=Object.freeze({
  intervalMs:DEFAULT_INTERVAL_MS,initialDelayMs:25_000,scanLimit:SNAPSHOT_LIMIT,
  sampleHorizonMs:SAMPLE_HORIZON_MS,historyMinIntervalMs:HISTORY_MIN_INTERVAL_MS
});
