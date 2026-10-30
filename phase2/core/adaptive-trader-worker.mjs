import {ADAPTIVE_TRADER_POLICY,buildAdaptiveLearningProfile,findMissedMoverEvents,applyAdaptiveLearning,buildAdaptiveTraderRecommendation,createPaperPortfolio,openPaperPosition,advancePaperPortfolio,estimatePaperEquity} from './adaptive-trader-engine.mjs';
import {buildAdaptiveTraderPaperValidationProfile} from './adaptive-trader-execution.mjs';
import {buildCognitiveLearningProfile,assessCognitiveCandidate} from './cognitive-brain.mjs';

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
const MAX_COGNITIVE_JOURNAL=3000;

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
    cognitive_profile:buildCognitiveLearningProfile([]),cognitive_journal:[],cognitive_capture:null,
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
            samples:saved.samples.slice(-MAX_SAMPLES).map(row=>{
              const sample={...row,observation_type:row.observation_type||'DEEP_CANDIDATE'};
              const historical=sample.observation_type==='HISTORICAL_CLOSED_CANDLE'&&sample.historical_baseline===true;
              const closedBaseline=sample.closed_candle_baseline===true;
              sample.training_eligible=historical||closedBaseline;
              if(historical){
                sample.outcome_source=sample.outcome_source||'HISTORICAL_CLOSED_CANDLE';
              }else if(!closedBaseline||sample.outcome_source!=='CLOSED_CANDLE_4H'){
                // Earlier Build 224 versions labeled live samples from current ticker prices.
                // Retract those labels instead of carrying unverified outcomes into learning.
                sample.outcome=null;sample.resolved_at=null;sample.mark_price=null;
                sample.return_pct=null;sample.horizon_ms=null;
                sample.outcome_source=null;
              }
              return sample;
            }),
            price_history:saved.price_history.slice(-MAX_HISTORY),
            missed_movers:Array.isArray(saved.missed_movers)?saved.missed_movers.slice(-MAX_MISSED):[],
            cognitive_journal:Array.isArray(saved.cognitive_journal)?saved.cognitive_journal.slice(-MAX_COGNITIVE_JOURNAL):[],
            cognitive_capture:saved.cognitive_capture&&typeof saved.cognitive_capture==='object'?saved.cognitive_capture:null,
            learning_profile:buildAdaptiveLearningProfile(saved.samples.filter(row=>
              row&&row.training_eligible===true&&(row.historical_baseline===true||row.closed_candle_baseline===true))),
            paper_portfolio:saved.paper_portfolio&&saved.paper_portfolio.mode==='PAPER_ONLY'&&saved.paper_portfolio.real_order_execution===false&&
              Array.isArray(saved.paper_portfolio.open_positions)&&Array.isArray(saved.paper_portfolio.closed_trades)
              ?{...createServerPaperPortfolio(),...saved.paper_portfolio,enabled:true,paper_trading:true,real_order_execution:false,
                open_positions:saved.paper_portfolio.open_positions.slice(-3),closed_trades:saved.paper_portfolio.closed_trades.slice(-2000)}
              :createServerPaperPortfolio()
          };
          this.state.paper_validation_profile=buildAdaptiveTraderPaperValidationProfile(this.state.paper_portfolio);
          this.state.cognitive_profile=buildCognitiveLearningProfile(this.trainingSamples());
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

  trainingSamples(){
    return this.state.samples.filter(row=>row&&row.training_eligible===true&&
      (row.historical_baseline===true||row.closed_candle_baseline===true));
  }

  async runOnce({limit:requestedLimit}={}){
    if(!this.enabled)return {status:'STOPPED',reason:'WORKER_DISABLED'};
    if(this.inFlight)return {status:'SCANNING',reason:'SCAN_ALREADY_IN_FLIGHT'};
    const scanLimit=requestedLimit===undefined?this.scanLimit:Number(requestedLimit);
    if(!Number.isInteger(scanLimit)||scanLimit<40||scanLimit>120)return {status:'INVALID_LIMIT',reason:'SCAN_LIMIT_MUST_BE_40_TO_120'};
    this.inFlight=true;
    const started=Date.now();
    this.state.scan_count=(Number(this.state.scan_count)||0)+1;
    this.state.last_started_at=started;
    this.state.last_error=null;
    try{
      const scanStartedAt=Date.now();
      const pendingSamples=this.state.samples.filter(sample=>
        sample&&sample.closed_candle_baseline===true&&sample.training_eligible===true&&!sample.outcome&&
        Number.isFinite(Number(sample.at))&&scanStartedAt-Number(sample.at)>=SAMPLE_HORIZON_MS&&
        scanStartedAt-Number(sample.at)<=48*60*60*1000
      ).map(sample=>({id:sample.id,symbol:sample.symbol,price:sample.price,at:sample.at,
        closed_candle_baseline:true,training_eligible:true}));
      const snapshot=await this.snapshotProvider({limit:scanLimit,now:scanStartedAt,offset:this.state.scan_cursor,pendingSamples});
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
      this.state.learning_profile=buildAdaptiveLearningProfile(this.trainingSamples());
      this.state.cognitive_profile=buildCognitiveLearningProfile(this.trainingSamples());
      const cognitiveAssessments=[];
      const adaptiveCandidates=snapshot.candidates.map(candidate=>{
        const baseScore=finite(candidate?.score);
        const learnedScore=applyAdaptiveLearning(baseScore,candidate?.features||{},this.state.learning_profile);
        const ranked=baseScore===null||learnedScore===null?candidate:{
          ...candidate,base_score:baseScore,score:learnedScore,
          learning_adjustment:Number((learnedScore-baseScore).toFixed(2))
        };
        const cognitive=assessCognitiveCandidate(ranked,this.state.cognitive_profile,now);
        const enriched={...ranked,cognitive_assessment:cognitive};
        this.recordCognitiveAssessment(enriched,now);
        cognitiveAssessments.push(enriched);
        return enriched;
      }).sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0));
      this.refreshCognitiveOutcomeLinks();
      this.state.cognitive_capture=this.buildCognitiveCapture(cognitiveAssessments,now);
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
        learning_capture:this.state.last_learning_capture||null,
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

  
  recordCognitiveAssessment(candidate,now){
    const symbol=cleanSymbol(candidate?.symbol);
    const closeAt=finite(candidate?.candle_close_time??candidate?.candle_close_time_ms??candidate?.closed_candle_close_time);
    if(!symbol||closeAt===null||closeAt<=0||closeAt>Number(now)+5000)return;
    const id=symbol+':'+String(Math.trunc(closeAt));
    const assessment=candidate?.cognitive_assessment||{};
    const existing=(this.state.cognitive_journal||[]).find(row=>row.id===id);
    const row={
      id,symbol,at:Math.trunc(closeAt),
      price:finite(candidate?.candle_close_price)??finite(candidate?.price),
      base_score:finite(candidate?.base_score??candidate?.score),
      ranked_score:finite(candidate?.score),tier:String(candidate?.tier||'NO_SETUP'),
      decision:String(assessment.decision||'DATA_UNAVAILABLE'),
      summary_ar:String(assessment.summary_ar||''),
      reason_codes:Array.isArray(assessment.reason_codes)?assessment.reason_codes.slice(0,10):[],
      hypotheses:Array.isArray(assessment.hypotheses)?assessment.hypotheses.slice(0,6):[],
      contradictions:Array.isArray(assessment.contradictions)?assessment.contradictions.slice(0,6):[],
      evidence_domains:finite(assessment.evidence_domains),
      predicted_up_probability:finite(assessment.predicted_up_probability),
      confidence_label:String(assessment.confidence_label||'UNKNOWN'),
      features:candidate?.features&&typeof candidate.features==='object'?{...candidate.features}:{},
      data_valid:candidate?.data_valid===true,data_stale:candidate?.data_stale===true,
      closed_candles_only:candidate?.closed_candles_only===true,
      entry_eligible:false,paper_trading:true,real_order_execution:false,
      first_seen_at:existing?.first_seen_at??Number(now),last_seen_at:Number(now),
      outcome:existing?.outcome??null,return_pct:existing?.return_pct??null,
      resolved_at:existing?.resolved_at??null,outcome_source:existing?.outcome_source??null
    };
    if(existing){
      const index=this.state.cognitive_journal.findIndex(item=>item.id===id);
      if(index>=0)this.state.cognitive_journal[index]=row;
    }else this.state.cognitive_journal.push(row);
    this.state.cognitive_journal=this.state.cognitive_journal.slice(-MAX_COGNITIVE_JOURNAL);
  }

  refreshCognitiveOutcomeLinks(){
    const byId=new Map(this.trainingSamples().map(sample=>[String(sample.id||''),sample]));
    for(const row of this.state.cognitive_journal||[]){
      const sample=byId.get(String(row.id||''));
      if(!sample||!sample.outcome)continue;
      row.outcome=sample.outcome;
      row.return_pct=finite(sample.return_pct);
      row.resolved_at=finite(sample.resolved_at);
      row.outcome_source=String(sample.outcome_source||'CLOSED_CANDLE_OUTCOME');
    }
  }

  buildCognitiveCapture(candidates,now){
    const rows=Array.isArray(candidates)?candidates:[];
    const decisions={};
    let valid=0,invalid=0,reviewable=0,contradictory=0;
    for(const row of rows){
      const brain=row?.cognitive_assessment||{};
      const decision=String(brain.decision||'DATA_UNAVAILABLE');
      decisions[decision]=(decisions[decision]||0)+1;
      if(decision==='DATA_UNAVAILABLE')invalid++;else valid++;
      if(decision==='EARLY_SETUP_REVIEW')reviewable++;
      if(Array.isArray(brain.contradictions)&&brain.contradictions.length)contradictory++;
    }
    const profile=this.state.cognitive_profile||buildCognitiveLearningProfile(this.trainingSamples());
    const journal=this.state.cognitive_journal||[];
    return {
      at:Number(now),assessed_candidates:rows.length,valid_data_candidates:valid,
      invalid_data_candidates:invalid,early_setup_reviews:reviewable,
      candidates_with_contradictions:contradictory,decision_counts:decisions,
      journal_records:journal.length,
      journal_resolved:journal.filter(row=>['UP','DOWN','FLAT'].includes(row.outcome)).length,
      journal_pending:journal.filter(row=>!['UP','DOWN','FLAT'].includes(row.outcome)).length,
      ranking_ready:profile.ranking_ready===true,
      probability_ready:profile.probability_ready===true,
      training_samples:Number(profile.training_samples)||0,
      holdout_samples:Number(profile.holdout_samples)||0,
      holdout:profile.holdout||null,method:profile.method
    };
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
    const knownIds=new Set(this.state.samples.map(row=>String(row?.id||'')));
    const historicalRows=Array.isArray(snapshot.historical_training_samples)?snapshot.historical_training_samples:[];
    const historicalRejected={
      missing_id:0,duplicate_id:0,invalid_outcome:0,missing_features:0,
      invalid_timestamp:0,invalid_price:0,invalid_return:0,resolved_in_future:0,horizon_too_short:0
    };
    let newHistoricalSamples=0;
    for(const row of historicalRows){
      const id=String(row?.id||''),at=finite(row?.at),resolvedAt=finite(row?.resolved_at),move=finite(row?.return_pct);
      if(!id){historicalRejected.missing_id++;continue;}
      if(knownIds.has(id)){historicalRejected.duplicate_id++;continue;}
      if(!['UP','DOWN','FLAT'].includes(row?.outcome)){historicalRejected.invalid_outcome++;continue;}
      if(!row.features||typeof row.features!=='object'){historicalRejected.missing_features++;continue;}
      if(at===null||resolvedAt===null){historicalRejected.invalid_timestamp++;continue;}
      if(!(finite(row.price)>0)){historicalRejected.invalid_price++;continue;}
      if(move===null){historicalRejected.invalid_return++;continue;}
      if(resolvedAt>Number(now)+5000){historicalRejected.resolved_in_future++;continue;}
      if(resolvedAt-at<SAMPLE_HORIZON_MS){historicalRejected.horizon_too_short++;continue;}
      this.state.samples.push({...row,observation_type:'HISTORICAL_CLOSED_CANDLE',historical_baseline:true,
        training_eligible:true,outcome_source:row.outcome_source||'HISTORICAL_CLOSED_CANDLE'});
      knownIds.add(id);newHistoricalSamples++;
    }
    let newClosedCandleOutcomes=0;
    const sampleById=new Map(this.state.samples.map(row=>[String(row?.id||''),row]));
    for(const label of (Array.isArray(snapshot.closed_candle_outcomes)?snapshot.closed_candle_outcomes:[])){
      const sample=sampleById.get(String(label?.sample_id||''));
      const at=finite(label?.at),baselinePrice=finite(label?.baseline_price);
      const markPrice=finite(label?.mark_price),resolvedAt=finite(label?.resolved_at),move=finite(label?.return_pct);
      if(!sample||sample.closed_candle_baseline!==true||sample.training_eligible!==true||sample.outcome||
         cleanSymbol(sample.symbol)!==cleanSymbol(label?.symbol)||at===null||at!==Number(sample.at)||
         baselinePrice===null||Math.abs(baselinePrice-Number(sample.price))>Math.max(1e-12,Math.abs(baselinePrice)*1e-8)||
         markPrice===null||resolvedAt===null||resolvedAt>Number(now)+5000||
         resolvedAt-at!==SAMPLE_HORIZON_MS||label?.horizon_ms!==SAMPLE_HORIZON_MS||
         label?.outcome_source!=='CLOSED_CANDLE_4H'||!['UP','DOWN','FLAT'].includes(label?.outcome)||move===null)continue;
      sample.outcome=label.outcome;sample.mark_price=markPrice;sample.return_pct=move;
      sample.resolved_at=resolvedAt;sample.horizon_ms=SAMPLE_HORIZON_MS;sample.outcome_source='CLOSED_CANDLE_4H';
      newClosedCandleOutcomes++;
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
    const newestTraining=new Map(),newestMarketAudit=new Map();
    for(const sample of this.state.samples){
      const symbol=cleanSymbol(sample.symbol);
      if(!symbol)continue;
      const target=sample.training_eligible===true?newestTraining:newestMarketAudit;
      const old=target.get(symbol);
      if(!old||Number(sample.at)>Number(old.at))target.set(symbol,sample);
    }
    let newMarketSamples=0,newDeepSamples=0;
    for(const row of (Array.isArray(snapshot.latest_prices)?snapshot.latest_prices:[])){
      const symbol=cleanSymbol(row?.symbol),price=finite(row?.price);
      if(!symbol||!(price>0))continue;
      const oldTraining=newestTraining.get(symbol);
      if(oldTraining&&now-Number(oldTraining.at)<SAMPLE_HORIZON_MS)continue;

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
      const deepValid=Boolean(candidate&&candidate.data_valid===true&&candidate.data_stale!==true&&
        finite(candidate.score)!==null&&finite(candidate.candle_close_time)!==null&&finite(candidate.candle_close_price)>0);
      const quoteVolume=finite(row?.quote_volume_24h);
      // Market-wide ticker snapshots remain audit-only. Training starts from the
      // exact baseline close of a valid 15m candle, never from an intrabar ticker.
      if(quoteVolume<ADAPTIVE_TRADER_POLICY.minQuoteVolume24h&&!deepValid)continue;
      if(deepValid){
        const at=Number(candidate.candle_close_time),closedPrice=Number(candidate.candle_close_price);
        if(!Number.isFinite(at)||!(closedPrice>0))continue;
        const item={
          id:symbol+':'+String(at),symbol,price:closedPrice,at,
          base_score:Number(candidate.score),tier:String(candidate.tier||'NO_SETUP'),
          observation_type:'DEEP_CANDIDATE',training_eligible:true,closed_candle_baseline:true,
          quote_volume_24h:quoteVolume,change_24h_pct:finite(row?.change_24h_pct),
          selection_lane:candidate.selection_lane||null,features:{...(candidate.features||{})},
          outcome:null,mark_price:null,return_pct:null,outcome_source:null
        };
        if(knownIds.has(item.id)||this.state.samples.some(sample=>String(sample?.id||'')===item.id))continue;
        this.state.samples.push(item);
        newestTraining.set(symbol,item);
        knownIds.add(item.id);newDeepSamples++;
        continue;
      }
      const oldAudit=newestMarketAudit.get(symbol);
      if(oldAudit&&now-Number(oldAudit.at)<SAMPLE_HORIZON_MS)continue;
      const item={
        id:'MARKET_WIDE_AUDIT:'+symbol+':'+String(now),symbol,price,at:now,
        base_score:null,tier:'NOT_EVALUATED',observation_type:'MARKET_WIDE_TICKER',
        training_eligible:false,closed_candle_baseline:false,
        quote_volume_24h:quoteVolume,change_24h_pct:finite(row?.change_24h_pct),
        selection_lane:null,features:tickerFeatures,outcome:null,mark_price:null,return_pct:null,
        outcome_source:null
      };
      this.state.samples.push(item);
      newestMarketAudit.set(symbol,item);newMarketSamples++;
    }
    this.state.samples=this.state.samples.slice(-MAX_SAMPLES);
    const closedCandleOutcomeRows=Array.isArray(snapshot.closed_candle_outcomes)?snapshot.closed_candle_outcomes:[];
    this.state.last_learning_capture={
      at:now,
      historical_input_samples:historicalRows.length,
      new_historical_samples:newHistoricalSamples,
      historical_rejected:historicalRejected,
      snapshot_historical_samples_available:Math.max(0,Math.trunc(Number(snapshot.universe?.historical_training_samples_available)||0)),
      snapshot_closed_candle_outcomes_input:closedCandleOutcomeRows.length,
      new_market_wide_samples:newMarketSamples,new_deep_candidate_samples:newDeepSamples,
      active_spot_prices:(snapshot.latest_prices||[]).length,
      tracked_samples:this.state.samples.length,
      historical_resolved_samples:this.state.samples.filter(row=>row.observation_type==='HISTORICAL_CLOSED_CANDLE'&&row.outcome).length,
      resolved_samples:this.trainingSamples().filter(row=>row.outcome).length,
      unresolved_training_samples:this.trainingSamples().filter(row=>!row.outcome).length,
      new_closed_candle_outcomes:newClosedCandleOutcomes
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
        reason_codes:candidate&&candidate.data_valid===true&&!candidate.data_stale?Array.isArray(candidate.reason_codes)?candidate.reason_codes.slice(0,12):[]:[],
        selection_lane:candidate?.selection_lane||null,
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
      cognitive_brain:{
        method:this.state.cognitive_profile?.method||'BAYESIAN_FACTOR_EVIDENCE_WITH_CHRONOLOGICAL_HOLDOUT_V1',
        ranking_ready:this.state.cognitive_profile?.ranking_ready===true,
        probability_ready:this.state.cognitive_profile?.probability_ready===true,
        resolved_samples:Number(this.state.cognitive_profile?.resolved_samples)||0,
        training_samples:Number(this.state.cognitive_profile?.training_samples)||0,
        holdout_samples:Number(this.state.cognitive_profile?.holdout_samples)||0,
        holdout:this.state.cognitive_profile?.holdout||null,
        capture:this.state.cognitive_capture||null,journal_records:(this.state.cognitive_journal||[]).length
      },
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
          cognitive_assessment:top.cognitive_assessment||null,
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
          cognitive_assessment:row.cognitive_assessment||null,
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
      learning_profile:this.state.learning_profile||buildAdaptiveLearningProfile(this.trainingSamples()),
      learning_capture:this.state.last_learning_capture||null,
      cognitive_brain:{
        method:this.state.cognitive_profile?.method||'BAYESIAN_FACTOR_EVIDENCE_WITH_CHRONOLOGICAL_HOLDOUT_V1',
        status:this.state.cognitive_profile?.probability_ready===true?'OUT_OF_SAMPLE_VALIDATED':
          this.state.cognitive_profile?.ranking_ready===true?'RANKING_EVIDENCE_READY':'LEARNING',
        profile:this.state.cognitive_profile||buildCognitiveLearningProfile(this.trainingSamples()),
        capture:this.state.cognitive_capture||null,journal_rows:(this.state.cognitive_journal||[]).length,
        resolved_journal_rows:(this.state.cognitive_journal||[]).filter(row=>['UP','DOWN','FLAT'].includes(row.outcome)).length,
        recent_journal:(this.state.cognitive_journal||[]).slice(-30).reverse()
      },
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
      memory:{resolved_samples:this.trainingSamples().filter(row=>row.outcome).length,
        unresolved_samples:this.trainingSamples().filter(row=>!row.outcome).length,
        deep_candidate_samples:this.trainingSamples().filter(row=>row.observation_type==='DEEP_CANDIDATE').length,
        market_wide_samples:(this.state.samples||[]).filter(row=>row.observation_type==='MARKET_WIDE_TICKER').length,
        historical_samples:this.trainingSamples().filter(row=>row.observation_type==='HISTORICAL_CLOSED_CANDLE'&&row.outcome).length,
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
