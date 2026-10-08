import {buildSpotUniverse, normalizeTickerRow, boundedMap} from '../market/universe-scanner.mjs';
import {collectAgentEvidence, buildAgentVerdict, evaluateMemory, createMemoryEntries} from './ai-agent-hub.mjs';
import {buildSurgeFingerprint, rankMeaningfulCandidates, selectSurgeSurface} from './market-surge-gate.mjs';
import {evaluateSupremeFusion, rankSupremeCandidates, buildSupremeMarketState} from './supreme-fusion.mjs';

const clamp=(v,a=0,b=100)=>Math.max(a,Math.min(b,Number.isFinite(Number(v))?Number(v):50));
const num=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const uniq=a=>[...new Set(a||[])];
const wait=ms=>new Promise(r=>setTimeout(r,ms));

export const AUTONOMOUS_AGENT_DEFAULTS=Object.freeze({
  quote:'USDT',
  pollMs:60000,
  universeRefreshMs:300000,
  minQuoteVolume24h:750000,
  deepCandidates:12,
  deepPool:120,
  deepConcurrency:3,
  deepKlines:220,
  webCandidates:3,
  memoryDays:30,
  resultLimit:20,
  learningLimit:2000
});

function logNorm(value,lo,hi){
  const n=Math.log10(Math.max(1,Number(value)||0)),a=Math.log10(Math.max(1,lo)),b=Math.log10(Math.max(1,hi));
  return b<=a?(n>=b?100:0):clamp((n-a)/(b-a)*100);
}

export function rankAgentDiscovery(tickers,symbols,{minQuoteVolume24h=750000}={}){
  const allowed=new Map((symbols||[]).map(x=>[String(x.symbol).toUpperCase(),x]));
  const rows=(Array.isArray(tickers)?tickers:[])
    .map(x=>normalizeTickerRow(x,'USDT'))
    .filter(Boolean)
    .filter(x=>allowed.has(x.symbol));
  const maxVol=Math.max(minQuoteVolume24h*1000,...rows.map(x=>x.quoteVolume24h));
  const maxTrades=Math.max(1000000,...rows.map(x=>x.tradeCount24h));
  const medianChange=rows.map(x=>x.priceChange24h).sort((a,b)=>a-b);
  const med=medianChange.length?medianChange[Math.floor(medianChange.length/2)]:0;
  return rows.map(x=>{
    const volume=logNorm(x.quoteVolume24h,Math.max(1,minQuoteVolume24h),maxVol);
    const activity=logNorm(x.tradeCount24h,100,maxTrades);
    const upsideMove=x.priceChange24h>=0?clamp(x.priceChange24h*7):clamp(x.priceChange24h*-2);
    const movePressure=x.priceChange24h>=12?100:x.priceChange24h>=9?94:x.priceChange24h>=6?88:x.priceChange24h>=4?76:x.priceChange24h>=2?60:x.priceChange24h>=0.7?48:30;
    const quietBuild=x.priceChange24h<=6&&x.priceChange24h>=-8?clamp(92-Math.abs(x.priceChange24h)*5):30;
    const unusual=clamp(50+Math.abs(x.priceChange24h-med)*8);
    const score=volume*.22+activity*.13+movePressure*.34+quietBuild*.16+unusual*.10+upsideMove*.05;
    return {...x,discovery_score:Number(score.toFixed(2)),move_pressure_score:Number(movePressure.toFixed(1)),
      discovery_reasons:[
        movePressure>=85?'MEANINGFUL_MOVE_PRESSURE':null,
        volume>=65?'LIQUIDITY_BREADTH':null,
        activity>=65?'HIGH_ACTIVITY':null,
        quietBuild>=75?'PRE_MOVE_WINDOW':null,
        unusual>=70?'MARKET_OUTLIER':null,
        x.priceChange24h>=4?'MOMENTUM_BUILD':null,
        x.priceChange24h<=-4?'DOWNSIDE_REVERSAL_WATCH':null
      ].filter(Boolean)};
  }).sort((a,b)=>b.discovery_score-a.discovery_score||b.move_pressure_score-a.move_pressure_score||b.quoteVolume24h-a.quoteVolume24h||a.symbol.localeCompare(b.symbol));
}

export function selectAgentDeepTargets(ranked,{deepCandidates=12,deepPool=120,cursor=0}={}){
  const list=Array.isArray(ranked)?ranked:[], pool=list.slice(0,Math.max(1,Math.min(200,deepPool)));
  const n=Math.max(1,Math.min(24,Math.trunc(deepCandidates)||12));
  if(!pool.length)return {targets:[],nextCursor:0,poolSize:0,buckets:{surge:0,early:0,rotation:0}};
  const surge=pool.filter(x=>Number(x.priceChange24h)>=4).sort((a,b)=>Number(b.priceChange24h)-Number(a.priceChange24h)||Number(b.move_pressure_score)-Number(a.move_pressure_score));
  const early=pool.filter(x=>Number(x.priceChange24h)<4&&Number(x.priceChange24h)>-6&&x.discovery_reasons?.includes('PRE_MOVE_WINDOW'))
    .sort((a,b)=>Number(b.discovery_score)-Number(a.discovery_score));
  const targets=[],seen=new Set();
  const add=(row)=>{if(row&&!seen.has(row.symbol)&&targets.length<n){seen.add(row.symbol);targets.push(row)}};
  // Preserve the highest-priority surge/early symbols, but reserve one slot when
  // there is a larger pool so the cursor can actually rotate coverage between cycles.
  const rotationReserve=pool.length>n?1:0;
  const fixedBudget=Math.max(0,n-rotationReserve);
  surge.slice(0,Math.min(5,fixedBudget)).forEach(add);
  early.slice(0,Math.min(4,fixedBudget-targets.length)).forEach(add);
  const rotating=[];
  for(let i=0;i<pool.length&&rotating.length<n-targets.length;i++){
    const idx=(Math.max(0,Math.trunc(cursor))+i)%pool.length;
    const row=pool[idx];if(!seen.has(row.symbol))rotating.push(row);
  }
  rotating.forEach(add);
  return {targets, nextCursor:(Math.max(0,Math.trunc(cursor))+Math.max(1,rotating.length+1))%pool.length,poolSize:pool.length,buckets:{surge:surge.length,early:early.length,rotation:rotating.length}};
}

function makeMarketDeep(candidate){
  const m=candidate?.bottom_context?.metrics||{};
  const f=candidate?.fast_impulse_context||{};
  const strategies=Array.isArray(candidate?.strategies)?candidate.strategies:[];
  const best=Number(candidate?.overall_score);
  const direction=String(candidate?.direction||'NONE').toUpperCase();
  const dirScore=Number.isFinite(best)?(direction==='BUY'?best:direction==='SELL'?100-best:50):clamp(
    (Number(m.structure)||50)*.35+(Number(m.momentum)||50)*.35+(Number(candidate?.pre_move_context?.score)||50)*.30
  );
  const trap=clamp((35+(candidate?.risk_flags?.length||0)*9+Math.max(0,Number(candidate?.price_change_24h)||0)-10)*2);
  const rvol=num(f.volume_ratio,1);
  return {
    price:{last:num(candidate?.last_price)},
    assessment:{direction_score:dirScore,trap_risk:trap},
    fast_impulse_score:num(f.score,50),
    fast_momentum_score:num(f.scores?.momentum,50),
    fast_volume_score:num(f.scores?.volume,50),
    fast_taker_score:num(f.scores?.taker_buy,50),
    liquidity:{score:num(candidate?.liquidity_quality,50)},
    pressure:{score:num(m.buying_pressure,num(f.scores?.taker_buy,50))},
    data_quality:{score:num(candidate?.data_quality,0)},
    ticker:{priceChangePercent:num(candidate?.price_change_24h,0)},
    timeframes:{
      '15m':{trend_score:num(m.structure,50),momentum_score:num(m.momentum,50),rvol},
      '1h':{trend_score:num(m.mtf_alignment,50),momentum_score:num(m.momentum,50),rvol:Math.max(0.5,rvol*.9)},
      '4h':{trend_score:num(m.structure,50),momentum_score:num(m.momentum,50),rvol:Math.max(0.5,rvol*.8)}
    },
    strategies
  };
}

function profile(memory){
  const latest=new Map();
  for(const x of memory||[]){const id=String(x?.id||'');if(id&&!latest.has(id))latest.set(id,x);}
  const byAgent={};
  for(const x of latest.values()){
    const id=String(x?.agent_id||'');if(!id)continue;
    const s=byAgent[id]??={wins:0,losses:0,neutral:0,pending:0};
    if(x.outcome==='WIN')s.wins++;else if(x.outcome==='LOSS')s.losses++;else if(x.outcome==='NEUTRAL')s.neutral++;else s.pending++;
  }
  const agents=Object.entries(byAgent).map(([agent_id,s])=>{
    const resolved=s.wins+s.losses,rate=resolved?(s.wins/resolved*100):null;
    return {agent_id,...s,win_rate_pct:rate===null?null:Number(rate.toFixed(1)),score_weight:Number(Math.max(.82,Math.min(1.18,.82+((resolved>=3?(s.wins+2)/(resolved+4):.5))*.36)).toFixed(3))};
  }).sort((a,b)=>Number(b.win_rate_pct??-1)-Number(a.win_rate_pct??-1));
  return {total_predictions:latest.size,resolved:agents.reduce((s,x)=>s+x.wins+x.losses+x.neutral,0),agents};
}

export class AutonomousAgentMarket {
  constructor({scanner,store,config={},clock=()=>Date.now(),logger=console}={}){
    if(!scanner)throw new Error('SCANNER_REQUIRED');
    this.scanner=scanner;this.store=store;this.config={...AUTONOMOUS_AGENT_DEFAULTS,...config};
    this.clock=clock;this.logger=logger;this.running=false;this.timer=null;this.cycleBusy=false;
    this.lastCycle=null;this.nextCycleAt=null;this.cursor=0;this.webCursor=0;this.universeCache=null;this.previousSupreme=new Map();
  }

  async start(){
    if(this.running)return;
    await this.store?.init?.();
    this.running=true;
    this.nextCycleAt=this.clock();
    await this.cycle().catch(e=>this.logger.warn?.('AI_AGENT_MARKET initial cycle failed',String(e?.message??e)));
    this.timer=setInterval(()=>this.cycle().catch(e=>this.logger.warn?.('AI_AGENT_MARKET cycle failed',String(e?.message??e))),Math.max(30000,Number(this.config.pollMs)||60000));
  }

  async stop(){
    this.running=false;
    if(this.timer)clearInterval(this.timer);
    this.timer=null;this.nextCycleAt=null;
  }

  async cycle(){
    if(!this.running||this.cycleBusy)return this.lastCycle;
    this.cycleBusy=true;
    const startedAt=this.clock();
    try{
      if(typeof this.scanner.exchangeInfo!=='function'||typeof this.scanner.ticker24h!=='function')throw new Error('SCANNER_MARKET_METHODS_UNAVAILABLE');
      this.scanner._requests=new Map();
      const info=await this.scanner.exchangeInfo(this.config.quote);
      const universe=buildSpotUniverse(info.data,this.config.quote);
      const tickers=await this.scanner.ticker24h();
      const ranked=rankAgentDiscovery(tickers.data,universe,{minQuoteVolume24h:this.config.minQuoteVolume24h});
      const pendingMemory=typeof this.store?.readAgentMemory==='function'
        ? await this.store.readAgentMemory({sinceMs:startedAt-(Number(this.config.memoryDays)||30)*86400000,limit:Number(this.config.learningLimit)||2000})
        : [];
      const tickerPrice=new Map(ranked.map(x=>[x.symbol,x.lastPrice]));
      if(pendingMemory.length&&typeof this.store?.appendAgentMemory==='function'){
        const bySymbol=new Map();
        for(const row of pendingMemory.filter(x=>x.outcome==='PENDING'))bySymbol.set(String(x.symbol).toUpperCase(),x);
        const evaluated=[];
        for(const [symbol,row] of bySymbol){
          const price=tickerPrice.get(symbol);
          if(Number.isFinite(price))evaluated.push(...evaluateMemory(pendingMemory.filter(x=>String(x.symbol).toUpperCase()===symbol),{symbol,currentPrice:price,now:startedAt}));
        }
        for(const row of evaluated)await this.store.appendAgentMemory(row);
        if(evaluated.length)pendingMemory.push(...evaluated);
      }

      const targetInfo=selectAgentDeepTargets(ranked,{deepCandidates:this.config.deepCandidates,deepPool:this.config.deepPool,cursor:this.cursor});
      this.cursor=targetInfo.nextCursor;
      const scanned=await boundedMap(targetInfo.targets,Math.max(1,Math.min(8,this.config.deepConcurrency)),(ticker,i)=>this.scanner.scanSymbol(
        ticker,i+1,{exchangeInfo:info.source,ticker:tickers.source},
        {klinesLimit:this.config.deepKlines,fastInterval:'5m',fastKlines:96}
      ));

      const rankedScanned=rankMeaningfulCandidates(scanned.filter(Boolean));
      const meaningful=rankedScanned.filter(x=>x.surge_fingerprint?.meaningful);
      const webCount=Math.max(0,Math.min(meaningful.length,Number(this.config.webCandidates)||3));
      const webTargetSymbols=new Set(meaningful.slice(0,webCount).map(x=>x.symbol));
      const decisions=[];
      for(const candidate of meaningful){
        let evidence={news:[],official:[],social:[],all:[],independent_domains:0,comment_count:0,corroboration:{verified:0,unverified:0},source_coverage:{gdelt:0,google_news:0,reddit_posts:0,reddit_comments:0}};
        if(webTargetSymbols.has(candidate.symbol)){
          try{evidence=await collectAgentEvidence({symbol:candidate.symbol});}catch(e){this.logger.warn?.('AI_AGENT_WEB '+candidate.symbol,String(e?.message??e));}
          await wait(30);
        }
        const memory=[...pendingMemory.filter(x=>String(x.symbol).toUpperCase()===candidate.symbol.toUpperCase())];
        const deepScan=makeMarketDeep(candidate);
        const verdict=buildAgentVerdict({symbol:candidate.symbol,evidence,deepScan,memory});
        const previousFusion=this.previousSupreme.get(candidate.symbol);
        const supremeFusion=evaluateSupremeFusion({candidate,verdict,previous:previousFusion});
        this.previousSupreme.set(candidate.symbol,{supreme_score:supremeFusion.score,observed_at:startedAt});
        const newEntries=createMemoryEntries({symbol:candidate.symbol,price:candidate.last_price,agents:verdict.agents,now:startedAt});
        const recent=memory.some(x=>Number(x.created_at||0)>startedAt-15*60*1000);
        if(!recent&&typeof this.store?.appendAgentMemory==='function'){
          for(const row of newEntries)await this.store.appendAgentMemory({...row,discovery_score:candidate.discovery_score,surge_tier:candidate.surge_fingerprint.tier,source:'AUTONOMOUS_MARKET'});
          pendingMemory.push(...newEntries);
        }
        const action=verdict.decision?.action||'WAIT_CONFIRMATION';
        decisions.push({
          symbol:candidate.symbol,last_price:candidate.last_price,discovery_score:candidate.discovery_score,
          discovery_reasons:candidate.discovery_reasons||[],score:verdict.decision?.score??null,
          direction:verdict.decision?.direction??'NEUTRAL',action,
          risk_score:verdict.decision?.risk_score??null,trap_risk:verdict.decision?.trap_risk??null,
          signal_state:candidate.signal_state,best_strategy:candidate.best_strategy,
          pre_move_score:candidate.pre_move_context?.score??null,
          data_quality:candidate.data_quality,liquidity_quality:candidate.liquidity_quality,
          surge_score:candidate.surge_fingerprint.score,surge_early_score:candidate.surge_fingerprint.early_score,
          surge_ignition_score:candidate.surge_fingerprint.ignition_score,surge_tier:candidate.surge_fingerprint.tier,
          surge_reasons:candidate.surge_fingerprint.reasons||[],
          top_agents:(verdict.agents||[]).filter(x=>x.id!=='CHIEF_DECIDER').sort((a,b)=>b.score-a.score).slice(0,4).map(x=>({id:x.id,name:x.name,score:x.score,direction:x.direction,weight:x.weight})),
          supreme_fusion:supremeFusion,
          supreme_score:supremeFusion.score,
          supreme_stage:supremeFusion.stage,
          supreme_action:supremeFusion.action,
          reasons:[...(candidate.reason_codes||[]).slice(0,4),...(verdict.decision?.stance?[verdict.decision.stance]:[]),...(supremeFusion.positive_reasons||[]).slice(0,3)],
          source_coverage:evidence.source_coverage||{},
          observed_at:startedAt
        });
      }
      const sorted=rankSupremeCandidates(decisions,{limit:Math.max(20,Number(this.config.resultLimit)||20)});
      const surface=selectSurgeSurface(scanned.filter(Boolean),{limit:Number(this.config.resultLimit)||20});
      const learning=profile(pendingMemory);
      const state={
        engine:'AUTONOMOUS_TEN_AGENT_MARKET_V2',
        engine_name:'🧠 عقل السوق الذاتي — موجات حقيقية',
        running:this.running,
        as_of:new Date(startedAt).toISOString(),
        universe:{quote:this.config.quote,eligible_spot_symbols:universe.length,ticker_rows:Array.isArray(tickers.data)?tickers.data.length:0,observed_symbols:ranked.length,liquid_symbols:ranked.filter(x=>x.quoteVolume24h>=Number(this.config.minQuoteVolume24h)).length},
        rotation:{pool_size:targetInfo.poolSize,next_cursor:this.cursor,deep_targets:targetInfo.targets.map(x=>x.symbol),deep_scanned:scanned.filter(Boolean).length,buckets:targetInfo.buckets},
        discovery:{top:ranked.slice(0,Math.min(30,Number(this.config.resultLimit)||20)).map(x=>({symbol:x.symbol,price:x.lastPrice,change_24h:x.priceChange24h,quote_volume_24h:x.quoteVolume24h,trade_count_24h:x.tradeCount24h,score:x.discovery_score,move_pressure:x.move_pressure_score,reasons:x.discovery_reasons}))},
        surge_surface:{
          meaningful:surface.meaningful.map(x=>({symbol:x.symbol,price:x.last_price,change_24h:x.price_change_24h,surge_score:x.surge_fingerprint.score,early_score:x.surge_fingerprint.early_score,ignition_score:x.surge_fingerprint.ignition_score,tier:x.surge_fingerprint.tier,reasons:x.surge_fingerprint.reasons,fast_score:x.fast_impulse_context?.score??null})),
          explosive_6p:surface.explosive.map(x=>({symbol:x.symbol,price:x.last_price,change_24h:x.price_change_24h,surge_score:x.surge_fingerprint.score,ignition_score:x.surge_fingerprint.ignition_score,reasons:x.surge_fingerprint.reasons})),
          early_breakout:surface.early.map(x=>({symbol:x.symbol,price:x.last_price,change_24h:x.price_change_24h,surge_score:x.surge_fingerprint.score,early_score:x.surge_fingerprint.early_score,ignition_score:x.surge_fingerprint.ignition_score,reasons:x.surge_fingerprint.reasons}))
        },
        decisions:sorted.slice(0,Math.min(Number(this.config.resultLimit)||20,20)),
        learning,
        policy:{spot_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',closed_candles_only:true,no_synthetic_prices:true,meaningful_moves_only:true},
        supreme_fusion_market:buildSupremeMarketState(sorted,{limit:Number(this.config.resultLimit)||20}),
        diagnostics:{elapsed_ms:Math.max(0,this.clock()-startedAt),web_candidates:[...webTargetSymbols],last_error:null}
      };
      this.lastCycle=state;
      this.nextCycleAt=this.clock()+Math.max(30000,Number(this.config.pollMs)||60000);
      if(typeof this.store?.putAgentMarketState==='function')await this.store.putAgentMarketState(state);
      return state;
    }catch(error){
      const m=String(error?.message??error);
      this.lastCycle={engine:'AUTONOMOUS_TEN_AGENT_MARKET_V2',engine_name:'🧠 عقل السوق الذاتي — موجات حقيقية',running:this.running,as_of:new Date(this.clock()).toISOString(),error:m,universe:{eligible_spot_symbols:0,observed_symbols:0},decisions:[],supreme_fusion_market:buildSupremeMarketState([]),learning:profile([]),policy:{spot_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}};
      throw error;
    }finally{this.cycleBusy=false;}
  }

  async readState(){
    if(this.lastCycle)return this.lastCycle;
    const stored=await this.store?.getAgentMarketState?.();
    return stored||{engine:'AUTONOMOUS_TEN_AGENT_MARKET_V2',engine_name:'🧠 عقل السوق الذاتي — موجات حقيقية',running:this.running,decisions:[],discovery:{top:[]},surge_surface:{meaningful:[],explosive_6p:[],early_breakout:[]},supreme_fusion_market:buildSupremeMarketState([]),learning:profile([])};
  }

  async learning(){
    const memory=typeof this.store?.readAgentMemory==='function'?await this.store.readAgentMemory({sinceMs:this.clock()-(Number(this.config.memoryDays)||30)*86400000,limit:Number(this.config.learningLimit)||2000}):[];
    return {engine:'TEN_AI_AGENTS_LEARNING',as_of:new Date(this.clock()).toISOString(),profile:profile(memory),recent:memory.slice(0,100).map(x=>({...x})),policy:{spot_only:true,paper_trading:true,real_order_execution:false}};
  }

  health(){
    return {running:this.running,busy:this.cycleBusy,last_cycle_at:this.lastCycle?.as_of??null,next_cycle_at:this.nextCycleAt?new Date(this.nextCycleAt).toISOString():null,universe_size:this.lastCycle?.universe?.eligible_spot_symbols??0,deep_scanned:this.lastCycle?.rotation?.deep_scanned??0,learning_predictions:this.lastCycle?.learning?.total_predictions??0,error:this.lastCycle?.error??null};
  }
}
