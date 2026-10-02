import {MarketUniverseScanner,buildSpotUniverse,normalizeTickerRow} from '../market/universe-scanner.mjs';
import {BinanceAllMarketTickerClient} from '../market/binance-market-ticker-ws.mjs';

const clamp=(n,min=0,max=100)=>Math.max(min,Math.min(max,Number(n)||0));
const finite=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const avg=xs=>{const a=xs.filter(Number.isFinite);return a.length?a.reduce((s,x)=>s+x,0)/a.length:null};

export const MOVE_RADAR_DEFAULTS=Object.freeze({
  quote:'USDT',
  thresholdPct:1,
  fastRealertDeltaPct:0.8,
  pollMs:5000,
  reconcileMs:15000,
  cooldownMs:30*60*1000,
  maxDeepPerCycle:3,
  minQuoteVolume24h:750000,
  minDataQuality:70,
  minLiquidityQuality:60,
  deepKlines:220,
  deepConcurrency:4
});

function strategyScore(candidate) {
  const rows=Array.isArray(candidate?.strategies)?candidate.strategies:[];
  const accepted=rows.filter(x=>x?.accepted&&Number.isFinite(Number(x?.score?.value)));
  const best=rows.map(x=>Number(x?.score?.value)).filter(Number.isFinite).reduce((m,x)=>Math.max(m,x),0);
  const acceptedMean=avg(accepted.map(x=>Number(x.score.value)))??0;
  return {acceptedCount:accepted.length,bestScore:best,acceptedMean};
}

function component(candidate,keyPaths,fallback=50){
  for(const path of keyPaths){
    let node=candidate;
    for(const key of path.split('.')) node=node?.[key];
    const n=Number(node);
    if(Number.isFinite(n)) return clamp(n);
  }
  return fallback;
}

export function buildMoveAlert(candidate,trigger,{now=Date.now()}={}) {
  const direction=Number(trigger?.movePct)>=0?'UP_MOVE':'DOWN_MOVE';
  const ctx=candidate?.pre_move_context||{};
  const bottom=candidate?.bottom_context||{};
  const strategies=strategyScore(candidate);
  const liquidity=finite(candidate?.liquidity_quality,0);
  const dataQuality=finite(candidate?.data_quality,0);
  const preMove=component(candidate,['pre_move_context.score'],45);
  const bottomScore=component(candidate,['bottom_context.metrics.composite_algorithm_score'],45);
  const structure=component(candidate,['bottom_context.metrics.structure','bottom_context.algorithms.price_structure.score'],45);
  const buying=component(candidate,['bottom_context.metrics.buying_pressure','bottom_context.algorithms.orderbook_pressure.score'],45);
  const exhaustion=component(candidate,['bottom_context.metrics.selling_exhaustion','bottom_context.algorithms.sell_exhaustion.score'],45);
  const squeeze=component(candidate,['bottom_context.metrics.compression','bottom_context.algorithms.squeeze.score'],45);
  const volume=component(candidate,['bottom_context.algorithms.volume_price_divergence.score','bottom_context.algorithms.momentum_awaken.score'],45);
  const relative=component(candidate,['pre_move_context.components.relative_strength','bottom_context.algorithms.mtf_alignment.score'],50);
  const whale=component(candidate,['bottom_context.metrics.whale_pressure','bottom_context.algorithms.whale_pressure.score'],50);
  const atrRatio=finite(bottom?.algorithms?.momentum_awaken?.atr_ratio,null);
  const atrScore=Number.isFinite(atrRatio)?clamp(50+(atrRatio-1)*80):50;
  const acceptedConfluence=clamp(strategies.acceptedCount*22+strategies.bestScore*0.35);

  const setupScore=clamp(
    strategies.bestScore*0.30+
    acceptedConfluence*0.15+
    preMove*0.15+
    bottomScore*0.15+
    volume*0.08+
    relative*0.07+
    liquidity*0.05+
    dataQuality*0.05
  );

  const expansionPotential=clamp(
    squeeze*0.20+
    volume*0.20+
    structure*0.18+
    relative*0.14+
    atrScore*0.10+
    whale*0.08+
    buying*0.05+
    liquidity*0.05
  );

  const reversalPotential=clamp(
    bottomScore*0.24+
    exhaustion*0.18+
    buying*0.18+
    structure*0.14+
    squeeze*0.10+
    strategies.bestScore*0.08+
    liquidity*0.04+
    dataQuality*0.04
  );

  const opportunityScore=direction==='UP_MOVE'?clamp(setupScore*0.6+expansionPotential*0.4):reversalPotential;
  const eligible=direction==='UP_MOVE'
    ? dataQuality>=MOVE_RADAR_DEFAULTS.minDataQuality &&
      liquidity>=MOVE_RADAR_DEFAULTS.minLiquidityQuality &&
      strategies.bestScore>=65 &&
      opportunityScore>=70
    : dataQuality>=MOVE_RADAR_DEFAULTS.minDataQuality &&
      liquidity>=MOVE_RADAR_DEFAULTS.minLiquidityQuality &&
      reversalPotential>=72;

  const reasons=[];
  const push=(ok,text)=>{if(ok)reasons.push(text)};
  push(strategies.bestScore>=75,'استراتيجية قوية');
  push(strategies.acceptedCount>=2,'توافق استراتيجيات');
  push(volume>=72,'الحجم يستيقظ');
  push(relative>=68,'قوة نسبية');
  push(squeeze>=70,'انكماش قبل التوسع');
  push(structure>=70,'الهيكل يتحسن');
  push(buying>=70,'ضغط شراء');
  push(exhaustion>=70,'انحسار بيع');
  push(whale>=72,'ضغط سيولة شرائية');
  push(preMove>=72,'بصمة ما قبل الحركة');
  if(direction==='DOWN_MOVE'&&reversalPotential>=72) reasons.push('فرصة ارتداد بعد الهبوط');
  if(!reasons.length)reasons.push('حركة وصلت عتبة الرادار مع فحص عميق صالح');

  const potentialLabel=opportunityScore>=82?'HIGH_EXPANSION_SETUP':opportunityScore>=72?'EXPANSION_WATCH':'EARLY_MOVE';
  const riskFlags=[];
  if(finite(candidate?.price_change_24h,0)>20)riskFlags.push('ALREADY_EXTENDED_24H');
  if(finite(candidate?.data_quality,0)<80)riskFlags.push('DATA_QUALITY_NEEDS_ATTENTION');
  if(finite(candidate?.liquidity_quality,0)<70)riskFlags.push('LIQUIDITY_NEEDS_ATTENTION');
  if(finite(ctx.resistance_distance_pct,null)!=null&&finite(ctx.resistance_distance_pct,999)<=3)riskFlags.push('RESISTANCE_NEAR');

  return {
    id:'MOVE:'+candidate.symbol+':'+Number(trigger?.movePct).toFixed(3)+':'+now,
    event:'EARLY_MOVE_ALERT',
    symbol:candidate.symbol,
    market:'SPOT',
    direction,
    trigger:{
      type:'24H_PERCENT_THRESHOLD',
      threshold_pct:MOVE_RADAR_DEFAULTS.thresholdPct,
      move_pct:finite(trigger?.movePct),
      crossed_from_pct:finite(trigger?.previousMovePct)
    },
    price:finite(candidate?.last_price),
    price_change_24h:finite(candidate?.price_change_24h),
    setup_score:Math.round(setupScore*10)/10,
    expansion_potential:Math.round(expansionPotential*10)/10,
    reversal_potential:Math.round(reversalPotential*10)/10,
    opportunity_score:Math.round(opportunityScore*10)/10,
    potential_label:potentialLabel,
    strategy_confluence:{
      active_count:Array.isArray(candidate?.strategies)?candidate.strategies.length:0,
      accepted_count:strategies.acceptedCount,
      best_score:strategies.bestScore,
      accepted_mean:Math.round(strategies.acceptedMean*10)/10,
      accepted_ids:(candidate?.accepted_strategies||[]).slice(0,8)
    },
    components:{pre_move:preMove,bottom:bottomScore,structure,buying_pressure:buying,selling_exhaustion:exhaustion,squeeze,volume,relative_strength:relative,whale_pressure:whale,atr_expansion:atrScore,liquidity,data_quality:dataQuality},
    session_return_pct:finite(ctx.session_return_pct),
    reasons:[...new Set(reasons)],
    risk_flags:[...new Set(riskFlags)],
    data_status:candidate?.data_status||{},
    source:'Binance Public REST/WS',
    detected_at:now,
    processed_at:now,
    paper_trading:true,
    real_order_execution:false,
    confidence_score:'UNKNOWN',
    eligible,
    disclaimer:'Detection of an early setup is not a guarantee of a future +30% move.'
  };
}

export class EarlyMoveSentinel {
  constructor({rest,store,config={},clock=()=>Date.now(),logger=console,tickerWsFactory=null,scannerFactory=null}){
    if(!rest)throw new Error('REST_CLIENT_REQUIRED');
    if(!store)throw new Error('STORE_REQUIRED');
    this.rest=rest;
    this.store=store;
    this.config={...MOVE_RADAR_DEFAULTS,...config};
    this.clock=clock;
    this.logger=logger;
    this.scannerFactory=scannerFactory;
    this.scanner=null;
    this.tickerWsFactory=tickerWsFactory || (opts => new BinanceAllMarketTickerClient(opts));
    this.running=false;
    this.reconcileTimer=null;
    this.spotSymbols=new Set();
    this.lastTicker=new Map();
    this.lastAlertAt=new Map();
    this.lastAlertScore=new Map();
    this.deepQueue=[];
    this.deepActive=0;
    this.ws=null;
    this.lastTickAt=null;
    this.lastReconcileAt=null;
    this.alertCount=0;
    this.lastError=null;
  }

  async start(){
    if(this.running)return;
    this.running=true;
    await this.store.init();
    this.scanner=this.scannerFactory?this.scannerFactory(this.rest):new MarketUniverseScanner({
      rest:this.rest,
      config:{
        minQuoteVolume24h:this.config.minQuoteVolume24h,
        minDataQuality:this.config.minDataQuality,
        minLiquidityQuality:this.config.minLiquidityQuality,
        deepKlines:this.config.deepKlines,
        deepConcurrency:this.config.deepConcurrency
      }
    });
    await this.reconcile(true);
    this.ws=this.tickerWsFactory({
      urls:this.config.websocket.urls,
      heartbeatTimeoutMs:this.config.websocket.heartbeatTimeoutMs,
      maxConnectionMs:this.config.websocket.maxConnectionMs,
      initialBackoffMs:this.config.websocket.initialBackoffMs,
      maxBackoffMs:this.config.websocket.maxBackoffMs,
      jitterRatio:this.config.websocket.jitterRatio,
      onTicker:t=>this.onTicker(t),
      onState:(state,reason)=>this.logger.info?.('MOVE_WS',state,reason||'')
    });
    this.ws.start();
    this.reconcileTimer=setInterval(()=>this.reconcile(false).catch(e=>{
      this.lastError=String(e?.message??e);
      this.logger.warn?.('MOVE_RECONCILE',this.lastError);
    }),this.config.reconcileMs);
  }

  async stop(){
    this.running=false;
    if(this.reconcileTimer)clearInterval(this.reconcileTimer);
    this.reconcileTimer=null;
    this.ws?.stop();
    this.ws=null;
    this.deepQueue=[];
    this.deepActive=0;
  }

  health(){
    return {
      running:this.running,
      universe:this.spotSymbols.size,
      websocket:this.ws?.health?.()||{state:'STOPPED'},
      last_tick_at:this.lastTickAt,
      last_reconcile_at:this.lastReconcileAt,
      last_error:this.lastError,
      queued_deep_scans:this.deepQueue.length,
      active_deep_scans:this.deepActive,
      alerts_emitted:this.alertCount
    };
  }

  eligibleSymbol(symbol){
    return this.spotSymbols.has(String(symbol||'').toUpperCase());
  }

  async reconcile(initial=false){
    if(!this.running)return;
    const info=await this.rest.request('/api/v3/exchangeInfo');
    const universe=buildSpotUniverse(info.data,this.config.quote);
    this.spotSymbols=new Set(universe.map(x=>x.symbol));
    const tick=await this.rest.request('/api/v3/ticker/24hr');
    const rows=Array.isArray(tick.data)?tick.data:[];
    this.lastReconcileAt=this.clock();
    for(const raw of rows){
      const row=normalizeTickerRow(raw,this.config.quote);
      if(row&&this.eligibleSymbol(row.symbol))this.processTicker(row,initial);
    }
  }

  onTicker(ticker){
    if(!this.running||!this.eligibleSymbol(ticker?.symbol))return;
    const row={
      symbol:String(ticker.symbol).toUpperCase(),
      lastPrice:Number(ticker.lastPrice),
      quoteVolume24h:Number(ticker.quoteVolume24h),
      tradeCount24h:Number(ticker.tradeCount24h),
      priceChange24h:Number(ticker.priceChange24h),
      highPrice24h:Number(ticker.highPrice24h),
      lowPrice24h:Number(ticker.lowPrice24h),
      tickerTime:Number(ticker.eventTime)||this.clock(),
      quoteAsset:this.config.quote
    };
    this.processTicker(row,false);
  }

  processTicker(row,initial=false){
    const symbol=row.symbol;
    const prev=this.lastTicker.get(symbol);
    this.lastTicker.set(symbol,row);
    this.lastTickAt=this.clock();
    if(initial||!prev)return;
    const previous=Number(prev.priceChange24h), current=Number(row.priceChange24h);
    if(!Number.isFinite(previous)||!Number.isFinite(current))return;
    const crossedUp=previous<this.config.thresholdPct&&current>=this.config.thresholdPct;
    const crossedDown=previous>-this.config.thresholdPct&&current<=-this.config.thresholdPct;
    const rapid=Math.abs(current-previous)>=this.config.fastRealertDeltaPct;
    const trigger= crossedUp||crossedDown ? {movePct:current,previousMovePct:previous} :
      rapid&&Math.abs(current)>=this.config.thresholdPct ? {movePct:current,previousMovePct:previous}:null;
    if(!trigger)return;
    this.queueDeep(symbol,row,trigger);
  }

  queueDeep(symbol,row,trigger){
    const now=this.clock();
    const last=this.lastAlertAt.get(symbol)||0;
    if(now-last<this.config.cooldownMs)return;
    if(this.deepQueue.some(x=>x.symbol===symbol))return;
    this.deepQueue.push({symbol,row,trigger,queuedAt:now});
    this.drainDeepQueue().catch(e=>{
      this.lastError=String(e?.message??e);
      this.logger.warn?.('MOVE_DEEP',this.lastError);
    });
  }

  async drainDeepQueue(){
    while(this.running&&this.deepActive<this.config.maxDeepPerCycle&&this.deepQueue.length){
      const job=this.deepQueue.shift();
      this.deepActive++;
      try{
        const candidate=await this.scanner.scanSymbol(job.row,1,{exchangeInfo:'Binance Public REST',ticker:'Binance Public REST'},{klinesLimit:this.config.deepKlines});
        const alert=buildMoveAlert(candidate,job.trigger,{now:this.clock()});
        if(!alert.eligible)continue;
        const recent=this.lastAlertScore.get(job.symbol)||0;
        if(alert.opportunity_score<recent+5&&this.clock()-(this.lastAlertAt.get(job.symbol)||0)<this.config.cooldownMs)continue;
        this.lastAlertAt.set(job.symbol,this.clock());
        this.lastAlertScore.set(job.symbol,alert.opportunity_score);
        await this.store.appendMoveAlert(alert);
        this.alertCount++;
      }catch(error){
        this.lastError=String(error?.message??error);
      }finally{
        this.deepActive--;
      }
    }
  }
}
