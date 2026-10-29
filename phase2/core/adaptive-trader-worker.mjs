import {ADAPTIVE_TRADER_POLICY,buildAdaptiveLearningProfile,findMissedMoverEvents,applyAdaptiveLearning,buildAdaptiveTraderRecommendation,createPaperPortfolio,openPaperPosition,advancePaperPortfolio,estimatePaperEquity} from './adaptive-trader-engine.mjs';
import {buildAdaptiveTraderPaperValidationProfile} from './adaptive-trader-execution.mjs';

const finite=value=>{
  if(value===null||value===undefined||value==='')return null;
  const n=Number(value);return Number.isFinite(n)?n:null;
};
const DEFAULT_INTERVAL_MS=3*60*1000;
const SAMPLE_HORIZON_MS=4*60*60*1000;
const HISTORY_MIN_INTERVAL_MS=15*60*1000;
const SNAPSHOT_LIMIT=80;
const MAX_SAMPLES=6000;
const MAX_HISTORY=60000;
const MAX_MISSED=500;

function createServerPaperPortfolio(){
  const portfolio=createPaperPortfolio(10000);
  portfolio.enabled=true;
  return portfolio;
}
function emptyState(){
  const paperPortfolio=createServerPaperPortfolio();
  return {
    version:1,enabled:false,scan_count:0,successful_scans:0,scan_cursor:0,
    last_started_at:null,last_scan_at:null,last_duration_ms:null,last_error:null,
    last_summary:null,learning_profile:buildAdaptiveLearningProfile([]),
    paper_portfolio:paperPortfolio,
    paper_validation_profile:buildAdaptiveTraderPaperValidationProfile(paperPortfolio),
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
  constructor({store,snapshotProvider,logger=console,intervalMs=DEFAULT_INTERVAL_MS,scanLimit=SNAPSHOT_LIMIT,executionController=null}={}){
    if(!store||typeof store.getAdaptiveTraderState!=='function'||typeof store.putAdaptiveTraderState!=='function')
      throw new Error('ADAPTIVE_TRADER_DURABLE_STORE_UNAVAILABLE');
    if(typeof snapshotProvider!=='function')throw new Error('ADAPTIVE_TRADER_SNAPSHOT_PROVIDER_UNAVAILABLE');
    this.store=store;this.snapshotProvider=snapshotProvider;this.logger=logger;this.executionController=executionController;this.lastExecutionResult=null;
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
            scan_cursor:Number.isFinite(Number(saved.scan_cursor))&&Number(saved.scan_cursor)>=0
              ?Math.trunc(Number(saved.scan_cursor))
              :Math.max(0,Math.trunc(Number(saved.last_summary?.universe?.scan_offset)||0)+
                Math.trunc(Number(saved.last_summary?.universe?.scan_advance_count)||0)),
            samples:saved.samples.slice(-MAX_SAMPLES),
            price_history:saved.price_history.slice(-MAX_HISTORY),
            missed_movers:Array.isArray(saved.missed_movers)?saved.missed_movers.slice(-MAX_MISSED):[],
            learning_profile:saved.learning_profile||buildAdaptiveLearningProfile(saved.samples),
            paper_portfolio:saved.paper_portfolio&&saved.paper_portfolio.mode==='PAPER_ONLY'&&saved.paper_portfolio.real_order_execution===false&&
              Array.isArray(saved.paper_portfolio.open_positions)&&Array.isArray(saved.paper_portfolio.closed_trades)
              ?{...createServerPaperPortfolio(),...saved.paper_portfolio,enabled:true,paper_trading:true,real_order_execution:false,
                open_positions:saved.paper_portfolio.open_positions.slice(-3),closed_trades:saved.paper_portfolio.closed_trades.slice(-2000)}
              :createServerPaperPortfolio()
          };
          this.state.paper_validation_profile=buildAdaptiveTraderPaperValidationProfile(this.state.paper_portfolio);
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
      const snapshot=await this.snapshotProvider({limit:this.scanLimit,now:Date.now(),offset:this.state.scan_cursor});
      if(!snapshot||snapshot.status!=='LIVE_DATA'||snapshot.meta?.live!==true||
         snapshot.meta?.paper_trading!==true||snapshot.meta?.real_order_execution!==false||
         snapshot.meta?.closed_candles_only!==true||snapshot.meta?.engine!=='ADAPTIVE_TRADER_SIDECAR_V1'||
         !Array.isArray(snapshot.candidates)||!Array.isArray(snapshot.latest_prices)){
        throw new Error('LIVE_ADAPTIVE_TRADER_SNAPSHOT_NOT_VERIFIED');
      }
      const now=Date.parse(snapshot.as_of);
      if(!Number.isFinite(now)||now>Date.now()+5000)throw new Error('ADAPTIVE_TRADER_SNAPSHOT_TIME_INVALID');
      const eligibleCount=Number(snapshot.universe?.eligible_spot_symbols)||0;
      const scanOffset=Number(snapshot.universe?.scan_offset);
      const advanceCount=Number(snapshot.universe?.scan_advance_count);
      if(eligibleCount>0&&Number.isFinite(scanOffset)&&Number.isFinite(advanceCount)){
        this.state.scan_cursor=(Math.max(0,Math.trunc(scanOffset))+Math.max(0,Math.trunc(advanceCount)))%eligibleCount;
      }
      this.resolveSamples(snapshot,now);
      this.collectPriceHistory(snapshot,now);
      this.collectMissedMovers(snapshot,now);
      this.state.successful_scans=(Number(this.state.successful_scans)||0)+1;
      this.state.last_scan_at=now;
      this.state.last_error=null;
      this.state.last_duration_ms=Math.max(0,Date.now()-started);
      this.state.learning_profile=buildAdaptiveLearningProfile(this.state.samples);
      const adaptiveCandidates=snapshot.candidates.map(candidate=>{
        const baseScore=finite(candidate?.score);
        const learnedScore=applyAdaptiveLearning(baseScore,candidate?.features||{},this.state.learning_profile);
        return baseScore===null||learnedScore===null?candidate:{
          ...candidate,base_score:baseScore,score:learnedScore,
          learning_adjustment:Number((learnedScore-baseScore).toFixed(2))
        };
      }).sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0));
      const executionSnapshot={...snapshot,candidates:adaptiveCandidates};
      this.recordServerPaperPortfolio(executionSnapshot,now);
      this.lastExecutionResult=null;
      if(this.executionController){
        try{
          this.lastExecutionResult=await this.executionController.processSnapshot(executionSnapshot,{
            learningProfile:this.state.learning_profile,
            paperValidationProfile:this.state.paper_validation_profile
          });
        }catch(error){
          this.lastExecutionResult={status:'EXECUTION_CONTROLLER_ERROR',error:String(error?.message??error).slice(0,180)};
          this.logger.warn?.('[ADAPTIVE_TRADER_EXECUTION_CONTROLLER_FAILED] '+this.lastExecutionResult.error);
        }
      }
      this.state.last_summary=this.buildSummary({...snapshot,candidates:adaptiveCandidates});
      await this.persist();
      this.logger.info?.('[ADAPTIVE_TRADER_SCAN_COMPLETE] '+JSON.stringify({
        as_of:snapshot.as_of,scan_count:this.state.scan_count,
        eligible:snapshot.universe?.eligible_spot_symbols??null,
        analyzed:snapshot.universe?.analyzed_symbols??snapshot.candidates.length,
        valid:snapshot.universe?.valid_symbols??snapshot.candidates.filter(row=>row.data_valid).length,
        early_setup:snapshot.candidates.filter(row=>row.data_valid&&row.tier==='EARLY_SETUP').length,
        late_move_audit:snapshot.candidates.filter(row=>row.data_valid&&row.tier==='LATE_MOVE').length,
        selection_lanes:snapshot.universe?.selection_lane_counts||{},
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

  recordServerPaperPortfolio(snapshot,now){
    const portfolio=this.state.paper_portfolio;
    if(!portfolio||portfolio.mode!=='PAPER_ONLY'||portfolio.real_order_execution!==false){
      this.state.paper_portfolio=createServerPaperPortfolio();
    }
    const paper=this.state.paper_portfolio;
    paper.enabled=true;paper.paper_trading=true;paper.real_order_execution=false;
    const advanced=advancePaperPortfolio(paper,snapshot.latest_prices,now);
    const candidates=[...(snapshot.candidates||[])].sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0));
    let opened=0;
    for(const candidate of candidates){
      if((paper.open_positions||[]).length>=3)break;
      const symbol=cleanSymbol(candidate?.symbol);
      if(!symbol)continue;
      const priorTimes=[
        ...(paper.open_positions||[]).filter(row=>cleanSymbol(row.symbol)===symbol).map(row=>finite(row.opened_at)||0),
        ...(paper.closed_trades||[]).filter(row=>cleanSymbol(row.symbol)===symbol).map(row=>finite(row.closed_at)||0)
      ];
      const lastEntryAt=priorTimes.length?Math.max(...priorTimes):0;
      if(lastEntryAt>0&&Number(now)-lastEntryAt<SAMPLE_HORIZON_MS)continue;
      const openedResult=openPaperPosition(paper,candidate,now);
      if(openedResult.opened)opened++;
    }
    paper.updated_at=Number(now);
    this.state.paper_validation_profile=buildAdaptiveTraderPaperValidationProfile(paper);
    this.state.paper_activity={
      last_updated_at:Number(now),
      newly_closed:(advanced.newlyClosed||[]).length,
      newly_opened:opened,
      equity:estimatePaperEquity(paper),
      net_pnl_usdt:Number(((Number(paper.starting_balance)||10000)===0?0:
        estimatePaperEquity(paper)-(Number(paper.starting_balance)||10000)).toFixed(2))
    };
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

    // Build a per-symbol index once, so thousands of market-wide observations
    // do not turn each scan into a full-history search for every trading pair.
    const historyBySymbol=new Map();
    for(const row of this.state.price_history){
      const symbol=cleanSymbol(row?.symbol);
      if(!symbol||!Number.isFinite(Number(row?.at)))continue;
      if(!historyBySymbol.has(symbol))historyBySymbol.set(symbol,[]);
      historyBySymbol.get(symbol).push(row);
    }
    const latestTickerBySymbol=new Map((snapshot.latest_prices||[]).map(row=>
      [cleanSymbol(row?.symbol),row]));
    const btcDaily=finite(latestTickerBySymbol.get('BTCUSDT')?.change_24h_pct);
    const candidateBySymbol=new Map((Array.isArray(snapshot.candidates)?snapshot.candidates:[])
      .map(row=>[cleanSymbol(row?.symbol),row]));
    const newest=new Map();
    for(const sample of this.state.samples){
      const symbol=cleanSymbol(sample.symbol),old=newest.get(symbol);
      if(!old||Number(sample.at)>Number(old.at))newest.set(symbol,sample);
    }
    let newMarketSamples=0,newDeepSamples=0;
    for(const row of (Array.isArray(snapshot.latest_prices)?snapshot.latest_prices:[])){
      const symbol=cleanSymbol(row?.symbol),price=finite(row?.price);
      if(!symbol||!(price>0))continue;
      const old=newest.get(symbol);
      if(old&&now-Number(old.at)<SAMPLE_HORIZON_MS)continue;

      const historical=historyBySymbol.get(symbol)||[];
      const findPrior=(minAgeMs,maxAgeMs)=>{
        let best=null,bestDistance=Infinity;
        for(const prior of historical){
          const age=now-Number(prior.at);
          if(age<minAgeMs||age>maxAgeMs||!(Number(prior.price)>0))continue;
          const distance=Math.abs(age-(minAgeMs+maxAgeMs)/2);
          if(distance<bestDistance){best=prior;bestDistance=distance;}
        }
        return best;
      };
      const prior15=findPrior(10*60*1000,30*60*1000);
      const prior1h=findPrior(45*60*1000,75*60*1000);
      const prior4h=findPrior(3.5*60*60*1000,4.5*60*60*1000);
      const relative=(finite(row?.change_24h_pct)!==null&&btcDaily!==null)
        ?Number((Number(row.change_24h_pct)-btcDaily).toFixed(3)):null;
      const tickerFeatures={
        change_24h_pct:finite(row?.change_24h_pct),
        quote_volume_24h:finite(row?.quote_volume_24h),
        price_change_15m_pct:prior15?Number(((price/Number(prior15.price)-1)*100).toFixed(3)):null,
        price_change_1h_pct:prior1h?Number(((price/Number(prior1h.price)-1)*100).toFixed(3)):null,
        price_change_4h_pct:prior4h?Number(((price/Number(prior4h.price)-1)*100).toFixed(3)):null,
        relative_24h_strength_vs_btc_pct:relative,
        move_since_previous_pct:finite(row?.move_since_previous_pct)
      };
      const candidate=candidateBySymbol.get(symbol);
      const deepValid=Boolean(candidate&&candidate.data_valid===true&&candidate.data_stale!==true&&finite(candidate.score)!==null);
      const quoteVolume=finite(row?.quote_volume_24h);
      // Keep low-liquidity prices in the audit history, but only train on eligible
      // Spot pairs or deep candidates that passed the same liquidity universe gate.
      if(!deepValid&&!(quoteVolume>=ADAPTIVE_TRADER_POLICY.minQuoteVolume24h))continue;
      // Market-wide ticker observations learn how liquid coins behaved before,
      // during, and after rallies even when the deeper kline batch has not visited.
      const features=deepValid?{...tickerFeatures,...(candidate.features||{})}:tickerFeatures;
      const item={
        id:symbol+':'+String(now),symbol,price,at:now,
        base_score:deepValid?Number(candidate.score):null,
        tier:deepValid?String(candidate.tier||'NO_SETUP'):'NOT_EVALUATED',
        observation_type:deepValid?'DEEP_CANDIDATE':'MARKET_WIDE_TICKER',
        training_eligible:true,
        quote_volume_24h:quoteVolume,
        change_24h_pct:finite(row?.change_24h_pct),
        selection_lane:candidate?.selection_lane||null,
        features,outcome:null,mark_price:null,return_pct:null
      };
      this.state.samples.push(item);
      newest.set(symbol,item);
      if(deepValid)newDeepSamples++;else newMarketSamples++;
    }
    this.state.samples=this.state.samples.slice(-MAX_SAMPLES);
    this.state.last_learning_capture={
      at:now,new_market_wide_samples:newMarketSamples,new_deep_candidate_samples:newDeepSamples,
      active_spot_prices:(snapshot.latest_prices||[]).length,
      tracked_samples:this.state.samples.length,
      resolved_samples:this.state.samples.filter(row=>row.outcome).length
    };
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
        quote_volume_24h:finite(row.quote_volume_24h),
        change_24h_pct:finite(row.change_24h_pct),
        move_since_previous_pct:finite(row.move_since_previous_pct),
        tier:candidate?String(candidate.tier||'NO_SETUP'):'NOT_EVALUATED',
        score:candidate&&candidate.data_valid===true?finite(candidate.score):null,
        features:candidate&&candidate.data_valid===true&&!candidate.data_stale?{...(candidate.features||{})}:null,
        evaluated:Boolean(candidate&&candidate.data_valid===true&&!candidate.data_stale)
      });
      latest.set(symbol,{symbol,price,at:now});
    }
    this.state.price_history=this.state.price_history.slice(-MAX_HISTORY);
  }

  collectMissedMovers(snapshot,now){
    const events=findMissedMoverEvents({
      history:this.state.price_history,currentPrices:snapshot.latest_prices,
      now,thresholdPct:3,maxAgeMs:24*60*60*1000
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
    const candidates=(Array.isArray(snapshot.candidates)?snapshot.candidates:[]).map(row=>({...row,trade_decision:buildAdaptiveTraderRecommendation(row)}));
    const latestPrices=(Array.isArray(snapshot.latest_prices)?snapshot.latest_prices:[]).map(row=>({...row}));
    return {
      as_of:snapshot.as_of,source:snapshot.source,status:snapshot.status,
      universe:{...(snapshot.universe||{})},
      // Carry the latest verified server snapshot so the dashboard can display the
      // worker's result without starting a second full REST scan from the phone.
      candidates,
      latest_prices:latestPrices,
      meta:{
        live:snapshot.meta?.live===true,
        paper_trading:true,real_order_execution:false,closed_candles_only:true,
        engine:'ADAPTIVE_TRADER_SIDECAR_V1'
      },
      counts:{
        valid:candidates.filter(row=>row.data_valid===true&&!row.data_stale).length,
        early_setup:candidates.filter(row=>row.data_valid===true&&row.tier==='EARLY_SETUP').length,
        watch:candidates.filter(row=>row.data_valid===true&&row.tier==='WATCH').length,
        late_move:candidates.filter(row=>row.data_valid===true&&row.tier==='LATE_MOVE').length,
        entry_candidates:candidates.filter(row=>row.trade_decision?.decision==='ENTRY_CANDIDATE').length,
        waiting_confirmation:candidates.filter(row=>row.trade_decision?.decision==='WAIT_FOR_CONFIRMATION').length,
        avoid_chasing:candidates.filter(row=>row.trade_decision?.decision==='AVOID_CHASING').length,
        no_setup:candidates.filter(row=>row.trade_decision?.decision==='NO_SETUP').length,
        rejected:candidates.filter(row=>row.data_valid!==true||row.data_stale===true).length
      },
      current_recommendation:(()=>{const top=candidates.filter(row=>row.data_valid===true&&!row.data_stale)
        .slice().sort((a,b)=>(Number(b.trade_decision?.priority)||0)-(Number(a.trade_decision?.priority)||0)||
          (Number(b.score)||0)-(Number(a.score)||0))[0];
        return top?{symbol:top.symbol,price:top.price,score:top.score,tier:top.tier,
          decision:top.trade_decision?.decision||'NO_SETUP',label_ar:top.trade_decision?.label_ar||'لا توجد توصية',
          action:top.trade_decision?.action||'NO_TRADE',reason_codes:top.trade_decision?.reason_codes||[],
          next_step_ar:top.trade_decision?.next_step_ar||'انتظر بيانات مؤكدة',
          entry_eligible:false,paper_trading:true,real_order_execution:false}:
          {decision:'DATA_UNAVAILABLE',label_ar:'لا تدخل — لا توجد بيانات صالحة حديثة',action:'NO_TRADE',entry_eligible:false,paper_trading:true,real_order_execution:false};
      })(),
      top_candidates:candidates.filter(row=>row.data_valid===true&&!row.data_stale)
        .slice().sort((a,b)=>(Number(b.trade_decision?.priority)||0)-(Number(a.trade_decision?.priority)||0)||
          (Number(b.score)||0)-(Number(a.score)||0)).slice(0,20).map(row=>({
          symbol:row.symbol,price:row.price,score:row.score,tier:row.tier,
          trade_decision:row.trade_decision,
          selection_lane:row.selection_lane||null,
          quote_volume_24h:row.quote_volume_24h,change_24h_pct:row.change_24h_pct,
          candle_close_time:row.candle_close_time,features:row.features,reason_codes:row.reason_codes
        })),
      // Keep late movers visible even when their score is below early-entry candidates.
      // This is an audit list, never an entry list.
      mover_audit:candidates.filter(row=>row.data_valid===true&&!row.data_stale&&row.tier==='LATE_MOVE')
        .slice().sort((a,b)=>(Number(b.change_24h_pct)||0)-(Number(a.change_24h_pct)||0)).slice(0,15).map(row=>({
          symbol:row.symbol,price:row.price,score:row.score,tier:'LATE_MOVE',
          quote_volume_24h:row.quote_volume_24h,
          change_24h_pct:row.change_24h_pct,selection_lane:row.selection_lane||null,
          reason_codes:row.reason_codes,paper_candidate:false,entry_eligible:false,
          paper_trading:true,real_order_execution:false
        })),
      paper_trading:true,real_order_execution:false
    };
  }

  snapshot(){
    const status=!this.enabled?'STOPPED':this.inFlight?'SCANNING':this.state.last_error?'DEGRADED':
      this.state.last_summary?'RUNNING':'STARTING';
    return {
      scanner_contract:'SERVER_DRIVEN_SCAN_V2',
      status,enabled:this.enabled,running:this.enabled,in_flight:this.inFlight,
      interval_ms:this.intervalMs,scan_limit:this.scanLimit,scan_cursor:Number(this.state.scan_cursor)||0,
      scan_count:Number(this.state.scan_count)||0,
      successful_scans:Number(this.state.successful_scans)||0,
      last_started_at:this.state.last_started_at,
      last_scan_at:this.state.last_scan_at?new Date(this.state.last_scan_at).toISOString():null,
      last_duration_ms:this.state.last_duration_ms,last_error:this.state.last_error,
      next_scan_at:this.enabled?new Date(Date.now()+this.intervalMs).toISOString():null,
      last_summary:this.state.last_summary,
      learning_profile:this.state.learning_profile||buildAdaptiveLearningProfile(this.state.samples),
      learning_capture:this.state.last_learning_capture||null,
      paper_validation_profile:this.state.paper_validation_profile||buildAdaptiveTraderPaperValidationProfile(this.state.paper_portfolio),
      server_paper_portfolio:{
        starting_balance:Number(this.state.paper_portfolio?.starting_balance)||10000,
        equity:estimatePaperEquity(this.state.paper_portfolio),
        net_pnl_usdt:Number((estimatePaperEquity(this.state.paper_portfolio)-(Number(this.state.paper_portfolio?.starting_balance)||10000)).toFixed(2)),
        open_positions:(this.state.paper_portfolio?.open_positions||[]).length,
        closed_trades:(this.state.paper_portfolio?.closed_trades||[]).length,
        activity:this.state.paper_activity||null
      },
      missed_movers:(this.state.missed_movers||[]).slice(0,100),
      paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
      execution:this.executionController?.snapshot?.()||{
        mode:'PAPER_ONLY',enabled:false,requested:false,paper_trading:true,real_order_execution:false,
        block_reasons:['LIVE_EXECUTION_CONTROLLER_NOT_CONFIGURED']
      },
      last_execution_result:this.lastExecutionResult,
      memory:{resolved_samples:(this.state.samples||[]).filter(row=>row.outcome).length,
        unresolved_samples:(this.state.samples||[]).filter(row=>!row.outcome).length,
        deep_candidate_samples:(this.state.samples||[]).filter(row=>row.observation_type==='DEEP_CANDIDATE').length,
        market_wide_samples:(this.state.samples||[]).filter(row=>row.observation_type==='MARKET_WIDE_TICKER').length,
        history_rows:(this.state.price_history||[]).length,
        potential_missed_movers:(this.state.missed_movers||[]).filter(row=>row.classification==='POTENTIAL_MISSED_MOVER').length,
        unassessed_moves:(this.state.missed_movers||[]).filter(row=>row.classification==='UNASSESSED_MOVE').length}
    };
  }
}

export const ADAPTIVE_TRADER_WORKER_DEFAULTS=Object.freeze({
  intervalMs:DEFAULT_INTERVAL_MS,initialDelayMs:25_000,scanLimit:SNAPSHOT_LIMIT,
  sampleHorizonMs:SAMPLE_HORIZON_MS,historyMinIntervalMs:HISTORY_MIN_INTERVAL_MS
});
