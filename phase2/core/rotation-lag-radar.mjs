import {buildSpotUniverse,normalizeTickerRow} from '../market/universe-scanner.mjs';
import {decorateRadarAlert} from './radar-alert-meta.mjs';
import {evaluateEliteGate} from './elite-confluence-gate.mjs';
import {evaluateRadarNotificationGate,rememberRadarAlert} from './radar-notification-gate.mjs';

const clamp=(x,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number(x)));
const finite=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const mean=xs=>{const a=xs.filter(Number.isFinite);return a.length?a.reduce((s,x)=>s+x,0)/a.length:null};
const pct=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&b>0?(a-b)/b*100:null;
const sign=v=>Number.isFinite(v)?(v>0?1:v<0?-1:0):0;

function closedCandles(rows,now){
  return (Array.isArray(rows)?rows:[]).filter(c=>
    c?.closed!==false&&Number.isFinite(Number(c?.openTime))&&Number.isFinite(Number(c?.closeTime))&&
    Number(c.closeTime)<=now&&Number(c.open)>0&&Number(c.high)>=Number(c.low)&&Number(c.low)>0&&
    Number(c.close)>0&&Number(c.volume)>=0
  ).sort((a,b)=>Number(a.openTime)-Number(b.openTime));
}

function rollingVwap(candles,n){
  const rows=candles.slice(-n);
  let den=0,num=0;
  for(const c of rows){
    const v=Math.max(0,Number(c.volume)||0);
    const tp=(Number(c.high)+Number(c.low)+Number(c.close))/3;
    den+=v;num+=tp*v;
  }
  return den>0?num/den:null;
}

function rsi(values,period=14){
  const xs=values.map(Number).filter(Number.isFinite);
  if(xs.length<period+2)return null;
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){const d=xs[i]-xs[i-1];if(d>=0)gain+=d;else loss-=d;}
  let ag=gain/period,al=loss/period;
  const out=[al===0?100:100-(100/(1+ag/al))];
  for(let i=period+1;i<xs.length;i++){
    const d=xs[i]-xs[i-1],g=Math.max(0,d),l=Math.max(0,-d);
    ag=(ag*(period-1)+g)/period;al=(al*(period-1)+l)/period;
    out.push(al===0?100:100-(100/(1+ag/al)));
  }
  return out.at(-1);
}

function moneyFlowIndex(candles,period=14){
  if(candles.length<period+1)return null;
  const rows=candles.slice(-(period+1));
  const tp=rows.map(c=>(Number(c.high)+Number(c.low)+Number(c.close))/3);
  let pos=0,neg=0;
  for(let i=1;i<tp.length;i++){
    const flow=tp[i]*Math.max(0,Number(rows[i].volume)||0);
    if(tp[i]>tp[i-1])pos+=flow;else if(tp[i]<tp[i-1])neg+=flow;
  }
  if(neg===0)return pos>0?100:50;
  return 100-(100/(1+pos/neg));
}

function stoch(candles,period=14){
  const rows=candles.slice(-period);
  if(rows.length<period)return null;
  const hi=Math.max(...rows.map(c=>Number(c.high)));
  const lo=Math.min(...rows.map(c=>Number(c.low)));
  if(!(hi>lo))return 50;
  return (Number(rows.at(-1).close)-lo)/(hi-lo)*100;
}

function avgRange(candles,n){
  const rows=candles.slice(-n);
  return mean(rows.map(c=>Number(c.high)-Number(c.low)));
}

function closeLocation(candles,n=20){
  const rows=candles.slice(-n);
  const hi=Math.max(...rows.map(c=>Number(c.high)));
  const lo=Math.min(...rows.map(c=>Number(c.low)));
  const last=Number(rows.at(-1)?.close);
  return hi>lo?clamp((last-lo)/(hi-lo)*100):50;
}

function persistence(candles,n=8){
  const rows=candles.slice(-(n+1)),changes=[];
  for(let i=1;i<rows.length;i++)changes.push(sign(Number(rows[i].close)-Number(rows[i-1].close)));
  const nonZero=changes.filter(Boolean);
  if(!nonZero.length)return 0.5;
  const pos=nonZero.filter(x=>x>0).length,neg=nonZero.length-pos;
  return Math.max(pos,neg)/nonZero.length;
}

function slope(values){
  const xs=values.filter(Number.isFinite);
  if(xs.length<4)return null;
  const n=xs.length,x=(n-1)/2;
  let num=0,den=0;
  for(let i=0;i<n;i++){num+=(i-x)*(xs[i]-mean(xs));den+=(i-x)**2;}
  return den>0?num/den:null;
}

function benchmarkReturn(series,n){
  const rows=closedCandles(series,Date.now());
  return rows.length>n?pct(Number(rows.at(-1).close),Number(rows.at(-(n+1)).close)):null;
}

function makeRelativeComponent(symbolRet,marketRet,dir){
  if(!Number.isFinite(symbolRet)||!Number.isFinite(marketRet))return 45;
  const spread=dir==='UP'?marketRet-symbolRet:symbolRet-marketRet;
  return clamp(50+spread*32);
}

export function buildRotationAnalysis(fifteenMin,oneHour,benchmarks,ticker,now=Date.now()){
  const m15=closedCandles(fifteenMin,now),h1=closedCandles(oneHour,now);
  const btc15=closedCandles(benchmarks?.BTCUSDT?.fifteen_min,now);
  const eth15=closedCandles(benchmarks?.ETHUSDT?.fifteen_min,now);
  const btc1h=closedCandles(benchmarks?.BTCUSDT?.one_hour,now);
  const eth1h=closedCandles(benchmarks?.ETHUSDT?.one_hour,now);

  if(m15.length<60||h1.length<30||btc15.length<12||eth15.length<12){
    return {eligible:false,stage:'INSUFFICIENT_DATA',score:null,closed_candles_only:true,
      counts:{fifteen_min:m15.length,one_hour:h1.length,btc15:btc15.length,eth15:eth15.length}};
  }

  const close15=m15.map(c=>Number(c.close));
  const r15=pct(close15.at(-1),close15.at(-2));
  const r30=pct(close15.at(-1),close15.at(-3));
  const r60=pct(close15.at(-1),close15.at(-5));
  const r2h=pct(close15.at(-1),close15.at(-9));
  const hr=pct(Number(h1.at(-1).close),Number(h1.at(-3).close));

  const br15=[pct(Number(btc15.at(-1).close),Number(btc15.at(-2).close)),pct(Number(eth15.at(-1).close),Number(eth15.at(-2).close))].filter(Number.isFinite);
  const br30=[pct(Number(btc15.at(-1).close),Number(btc15.at(-3).close)),pct(Number(eth15.at(-1).close),Number(eth15.at(-3).close))].filter(Number.isFinite);
  const br60=[pct(Number(btc15.at(-1).close),Number(btc15.at(-5).close)),pct(Number(eth15.at(-1).close),Number(eth15.at(-5).close))].filter(Number.isFinite);
  const br2h=[pct(Number(btc15.at(-1).close),Number(btc15.at(-9).close)),pct(Number(eth15.at(-1).close),Number(eth15.at(-9).close))].filter(Number.isFinite);
  const market15=mean(br15),market30=mean(br30),market60=mean(br60),market2h=mean(br2h);
  const marketHour=mean([
    pct(Number(btc1h.at(-1)?.close),Number(btc1h.at(-2)?.close)),
    pct(Number(eth1h.at(-1)?.close),Number(eth1h.at(-2)?.close))
  ].filter(Number.isFinite));

  const upBias=mean([market30,market60,market2h,marketHour].filter(x=>Number.isFinite(x)))??0;
  const direction=upBias>=0?'UP_ROTATION':'DOWN_ROTATION';

  const range6=avgRange(m15,6),range24=avgRange(m15,24);
  const rangeRatio=Number.isFinite(range6)&&Number.isFinite(range24)&&range24>0?range6/range24:null;

  const recentVol=mean(m15.slice(-3).map(c=>Number(c.volume)));
  const baseVol=mean(m15.slice(-27,-3).map(c=>Number(c.volume)));
  const volumeRatio=Number.isFinite(recentVol)&&Number.isFinite(baseVol)&&baseVol>0?recentVol/baseVol:null;

  const vwap=rollingVwap(m15,40);
  const vwapDistance=Number.isFinite(vwap)&&vwap>0?(Number(m15.at(-1).close)-vwap)/vwap*100:null;
  const priorClose=Number(m15.at(-2)?.close);
  const vwapReclaim=Number.isFinite(vwapDistance)&&Number.isFinite(priorClose)
    ?(Number(m15.at(-1).close)>vwap&&priorClose<=vwap*1.002?96:clamp(50+vwapDistance*30)):50;

  const hi20=Math.max(...m15.slice(-21,-1).map(c=>Number(c.high)));
  const lo20=Math.min(...m15.slice(-21,-1).map(c=>Number(c.low)));
  const last=Number(m15.at(-1).close);
  const mid20=(hi20+lo20)/2;
  const valueAcceptance=hi20>lo20?clamp(50+(last-mid20)/(hi20-lo20)*90):50;

  const rs30=direction==='UP_ROTATION'?market30-r30:r30-market30;
  const rs2h=direction==='UP_ROTATION'?market2h-r2h:r2h-market2h;
  const lagScore=clamp(50+(Number.isFinite(rs30)?rs30*34:0)+(Number.isFinite(rs2h)?rs2h*11:0));

  const silentDislocation=Number.isFinite(volumeRatio)
    ?clamp(52+(volumeRatio-1)*22-(Math.abs(Number(r30)||0)*9))
    :45;

  const rsiNow=rsi(close15,14);
  const mfiNow=moneyFlowIndex(m15,14);
  const rsiValues=[];
  const mfiValues=[];
  for(let i=Math.max(20,m15.length-8);i<m15.length;i++){
    const rr=rsi(m15.slice(0,i+1).map(c=>Number(c.close)),14);
    const mm=moneyFlowIndex(m15.slice(0,i+1),14);
    if(Number.isFinite(rr))rsiValues.push(rr);
    if(Number.isFinite(mm))mfiValues.push(mm);
  }
  const rsiSlope=slope(rsiValues);
  const mfiSlope=slope(mfiValues);
  const rsiTurn=Number.isFinite(rsiNow)?clamp(55+(rsiSlope||0)*9-(rsiNow>68?(rsiNow-68)*2:0)):45;
  const mfiTurn=Number.isFinite(mfiNow)?clamp(52+(mfiSlope||0)*7-(mfiNow>78?(mfiNow-78)*1.3:0)):45;

  const stochNow=stoch(m15,14);
  const stochPrev=stoch(m15.slice(0,-1),14);
  const stochTurn=Number.isFinite(stochNow)&&Number.isFinite(stochPrev)
    ?(direction==='UP_ROTATION'
      ?clamp(50+(stochNow-stochPrev)*2+(stochNow>=20&&stochNow<=65?18:0))
      :clamp(50+(stochPrev-stochNow)*2+(stochNow>=35&&stochNow<=80?18:0)))
    :45;

  const loc=closeLocation(m15,20);
  const pathPersistence=persistence(m15,8);
  const persistenceScore=clamp(35+pathPersistence*80+(direction==='UP_ROTATION'&&loc>=65?8:direction==='DOWN'&&loc<=35?8:0));

  const compressionScore=Number.isFinite(rangeRatio)
    ?clamp(rangeRatio<=0.9?82+(0.9-rangeRatio)*80:68-(rangeRatio-0.9)*80)
    :45;

  const reclaimOrReject=direction==='UP_ROTATION'
    ?clamp(45+(loc-50)*0.9+(Number.isFinite(vwapDistance)&&vwapDistance>0?15:0))
    :clamp(45+(50-loc)*0.9+(Number.isFinite(vwapDistance)&&vwapDistance<0?15:0));

  const resilience=direction==='UP_ROTATION'
    ?makeRelativeComponent(r2h,market2h,'UP')
    :makeRelativeComponent(r2h,market2h,'DOWN');

  const activation=clamp(
    silentDislocation*.22+
    reclaimOrReject*.18+
    valueAcceptance*.18+
    (direction==='UP_ROTATION'?rsiTurn:mfiTurn)*.12+
    (direction==='UP_ROTATION'?mfiTurn:rsiTurn)*.10+
    stochTurn*.08+
    persistenceScore*.07+
    compressionScore*.05
  );

  const score=clamp(
    lagScore*.24+
    resilience*.13+
    silentDislocation*.16+
    reclaimOrReject*.12+
    valueAcceptance*.10+
    rsiTurn*.07+
    mfiTurn*.06+
    stochTurn*.04+
    persistenceScore*.04+
    compressionScore*.04
  );

  const confirmations=[];
  const push=(ok,label)=>{if(ok)confirmations.push(label)};
  if(direction==='UP_ROTATION'){
    push(Number.isFinite(market30)&&market30>=0.25,'MARKET_UPSHIFT');
    push(Number.isFinite(rs30)&&rs30>=0.25,'LAG_TO_MARKET');
    push(Number.isFinite(volumeRatio)&&volumeRatio>=1.25,'SILENT_VOLUME');
    push(vwapReclaim>=68,'VWAP_RECLAIM');
    push(valueAcceptance>=70,'VALUE_ACCEPTANCE');
    push(rsiTurn>=68,'RSI_TURN');
    push(mfiTurn>=66,'MFI_TURN');
    push(stochTurn>=68,'STOCHASTIC_TURN');
    push(resilience>=64,'MARKET_RESILIENCE');
    push(persistenceScore>=68,'PRICE_PERSISTENCE');
  }else{
    push(Number.isFinite(market30)&&market30<=-0.25,'MARKET_DOWNSHIFT');
    push(Number.isFinite(rs30)&&rs30>=0.25,'LAG_TO_MARKET');
    push(Number.isFinite(volumeRatio)&&volumeRatio>=1.25,'DISTRIBUTION_VOLUME');
    push(vwapReclaim<=38,'VWAP_REJECTION');
    push(valueAcceptance<=30,'VALUE_REJECTION');
    push(rsiTurn>=68,'RSI_FALL');
    push(mfiTurn>=66,'MFI_FALL');
    push(stochTurn>=68,'STOCHASTIC_FALL');
    push(resilience>=64,'MARKET_PRESSURE');
    push(persistenceScore>=68,'PRICE_PERSISTENCE');
  }

  const rotationTrigger=score>=78&&confirmations.length>=4&&(
    (direction==='UP_ROTATION'&&Number.isFinite(market30)&&market30>=0.25&&Number.isFinite(rs30)&&rs30>=0.20&&activation>=64) ||
    (direction==='DOWN_ROTATION'&&Number.isFinite(market30)&&market30<=-0.25&&Number.isFinite(rs30)&&rs30>=0.20&&activation>=64)
  );

  const stage=rotationTrigger
    ?(score>=90?'ROTATION_BREAKOUT_READY':'ROTATION_READY')
    :score>=70?'BUILDING_ROTATION'
    :'WATCH';

  const reasons=confirmations.slice(0,10).map(x=>x.replaceAll('_',' '));
  const marketRegime=upBias>=0.4?'RISK_ON_SHIFT':upBias<=-0.4?'RISK_OFF_SHIFT':'MIXED';

  return {
    eligible:rotationTrigger,
    closed_candles_only:true,
    stage,
    direction,
    score:Math.round(score*10)/10,
    activation_score:Math.round(activation*10)/10,
    confirmations:confirmations.length,
    market_regime:marketRegime,
    counts:{
      fifteen_min:m15.length,
      one_hour:h1.length,
      btc15:btc15.length,
      eth15:eth15.length
    },
    metrics:{
      return_15m:r15,return_30m:r30,return_60m:r60,return_2h:r2h,return_1h:hr,
      market_return_15m:market15,market_return_30m:market30,market_return_60m:market60,
      market_return_2h:market2h,market_return_1h:marketHour,
      relative_30m_pct:rs30,relative_2h_pct:rs2h,volume_ratio:volumeRatio,
      range_ratio:rangeRatio,vwap,vwap_distance_pct:vwapDistance,
      close_location_pct:loc,value_acceptance_score:valueAcceptance,
      rsi:rsiNow,rsi_slope:rsiSlope,mfi:mfiNow,mfi_slope:mfiSlope,
      stochastic:stochNow,stochastic_delta:Number.isFinite(stochNow)&&Number.isFinite(stochPrev)?stochNow-stochPrev:null,
      path_persistence:pathPersistence,resilience_score:resilience
    },
    component_scores:{
      lag:lagScore,resilience,silent_volume:silentDislocation,reclaim_or_reject:reclaimOrReject,
      value_acceptance:valueAcceptance,rsi_turn:rsiTurn,mfi_turn:mfiTurn,
      stochastic_turn:stochTurn,persistence:persistenceScore,compression:compressionScore
    },
    trigger:{
      min_score:78,min_confirmations:4,min_market_shift_pct:0.25,min_relative_edge_pct:0.20,min_activation_score:64
    },
    confirmations,
    reasons,
    source:'Binance Public REST',
    detected_at:now,
    processed_at:now,
    paper_trading:true,
    real_order_execution:false,
    confidence_score:'UNKNOWN'
  };
}

export function buildRotationAlert(candidate,now=Date.now()){
  const a=buildRotationAnalysis(candidate.fifteen_min,candidate.one_hour,candidate.benchmarks,candidate.ticker,now);
  const ticker=candidate.ticker||{};
  const symbol=String(ticker.symbol||'UNKNOWN').toUpperCase();
  return {
    id:'ROTATION:'+symbol+':'+a.direction+':'+now,
    event:'ROTATION_LAG_ALERT',
    radar:'ROTATION_LAG_RADAR',
    symbol,
    market:'SPOT',
    direction:a.direction,
    price:finite(ticker.lastPrice),
    price_change_24h:finite(ticker.priceChange24h),
    opportunity_score:a.score,
    potential_label:a.stage,
    rotation:a,
    reasons:a.reasons,
    risk_flags:[
      Math.abs(finite(ticker.priceChange24h,0))>=10?'24H_ALREADY_EXTENDED':null,
      a.metrics.volume_ratio<0.8?'LOW_ACTIVITY':null,
      a.metrics.range_ratio>1.8?'VOLATILITY_ELEVATED':null
    ].filter(Boolean),
    source:a.source,
    detected_at:now,
    processed_at:now,
    paper_trading:true,
    real_order_execution:false,
    confidence_score:'UNKNOWN',
    eligible:a.eligible,
    disclaimer:'رادار Rotation/Lag يبحث عن دوران/لحاق نسبي وتحول سلوكي قبل اتساع الحركة؛ لا يضمن اتجاه الحركة أو استمرارها.'
  };
}

const STABLE_BASES=new Set(['USDC','BUSD','FDUSD','TUSD','USDP','DAI','USDE','USD1']);

export class RotationLagRadar {
  constructor({rest,store,pushManager=null,config={},clock=()=>Date.now(),logger=console}={}){
    if(!rest)throw new Error('REST_CLIENT_REQUIRED');
    if(!store)throw new Error('STORE_REQUIRED');
    this.rest=rest;this.store=store;this.pushManager=pushManager;this.clock=clock;this.logger=logger;
    this.config={
      quote:'USDT',pollMs:45000,universeRefreshMs:5*60*1000,minQuoteVolume24h:1000000,
      rotationBatchSize:5,topLaggers:2,maxAbs24hMovePct:6,alertCooldownMs:15*60*1000,
      minScore:82,minConfirmations:5,...config
    };
    this.running=false;this.timer=null;this.universe=[];this.universeAt=0;this.cursor=0;
    this.lastScanAt=new Map();this.lastAlertAt=new Map();
    this.alertCount=0;this.scans=0;this.lastError=null;this.lastScanAtMs=null;this.busy=false;
  }

  start(){
    if(this.running)return;
    this.running=true;
    this.refreshUniverse()
      .then(()=>this.tick())
      .catch(e=>this.noteError(e));
    this.timer=setInterval(()=>this.tick().catch(e=>this.noteError(e)),this.config.pollMs);
  }

  async stop(){this.running=false;if(this.timer)clearInterval(this.timer);this.timer=null;}

  noteError(e){this.lastError=String(e?.message??e);this.logger.warn?.('ROTATION_LAG',this.lastError);}

  async refreshUniverse(){
    const r=await this.rest.request('/api/v3/exchangeInfo');
    const symbols=buildSpotUniverse(r.data,this.config.quote);
    this.universe=symbols.map(x=>x.symbol).filter(s=>{
      const base=s.endsWith(this.config.quote)?s.slice(0,-this.config.quote.length):s;
      return !STABLE_BASES.has(base);
    });
    this.universeAt=this.clock();this.cursor=0;
  }

  async tickerRows(){
    const r=await this.rest.request('/api/v3/ticker/24hr');
    return (Array.isArray(r.data)?r.data:[])
      .map(x=>normalizeTickerRow(x,this.config.quote)).filter(Boolean)
      .filter(x=>this.universe.includes(x.symbol))
      .filter(x=>x.quoteVolume24h>=this.config.minQuoteVolume24h)
      .filter(x=>Math.abs(x.priceChange24h)<=this.config.maxAbs24hMovePct);
  }

  async benchmarkData(){
    const symbols=['BTCUSDT','ETHUSDT'].filter(x=>x.endsWith(this.config.quote));
    const pairs=await Promise.all(symbols.map(async symbol=>{
      const [f,h]=await Promise.all([
        this.rest.klines(symbol,'15m',{limit:120}),
        this.rest.klines(symbol,'1h',{limit:60})
      ]);
      return [symbol,{fifteen_min:f.candles,one_hour:h.candles}];
    }));
    return Object.fromEntries(pairs);
  }

  selectBatch(rows){
    if(!rows.length)return [];
    const active=[...rows].sort((a,b)=>{
      const sa=Math.abs(a.priceChange24h)*4+Math.log10(Math.max(1,a.quoteVolume24h))*3;
      const sb=Math.abs(b.priceChange24h)*4+Math.log10(Math.max(1,b.quoteVolume24h))*3;
      return sa-sb||b.quoteVolume24h-a.quoteVolume24h;
    });
    const selected=active.slice(0,this.config.topLaggers);
    const n=Math.max(1,this.config.rotationBatchSize);
    for(let i=0;i<n&&this.universe.length;i++){
      const symbol=this.universe[this.cursor%this.universe.length];
      this.cursor=(this.cursor+1)%this.universe.length;
      const row=rows.find(x=>x.symbol===symbol);
      if(row)selected.push(row);
    }
    return [...new Map(selected.map(x=>[x.symbol,x])).values()];
  }

  async scanRow(row,benchmarks){
    const last=this.lastScanAt.get(row.symbol)||0;
    if(this.clock()-last<Math.max(10000,this.config.pollMs*0.75))return null;
    this.lastScanAt.set(row.symbol,this.clock());
    const [f,h]=await Promise.all([
      this.rest.klines(row.symbol,'15m',{limit:120}),
      this.rest.klines(row.symbol,'1h',{limit:60})
    ]);
    const alert=buildRotationAlert({
      ticker:row,fifteen_min:f.candles,one_hour:h.candles,benchmarks
    },this.clock());
    this.scans++;
    const a=alert.rotation||{};
    const cs=a.component_scores||{};
    const m=a.metrics||{};
    const gate=evaluateEliteGate({
      radar:'ROTATION_LAG_RADAR',
      direction:a.direction,
      baseScore:a.score,
      priceChange24h:row.priceChange24h,
      liquidityScore:clamp(70+Math.log10(Math.max(1,row.quoteVolume24h/this.config.minQuoteVolume24h))*30),
      dataQualityScore:90,
      triggerScore:a.activation_score||50,
      structureScore:Math.max(Number(cs.reclaim_or_reject)||0,Number(cs.value_acceptance)||0),
      participationScore:Number(cs.silent_volume)||50,
      flowScore:Math.max(Number(cs.mfi_turn)||0,Number(cs.rsi_turn)||0),
      relativeScore:Math.max(Number(cs.lag)||0,Number(cs.resilience)||0),
      momentumScore:Number(cs.stochastic_turn)||Number(cs.persistence)||50,
      compressionScore:Number(cs.compression)||50,
      confirmations:a.confirmations,
      minConfirmations:6,minScore:86,max24hMovePct:5,requireTrigger:true,minCategoryHits:5
    });
    alert.elite_gate=gate;
    const notificationGate=evaluateRadarNotificationGate(alert,{now:this.clock()});
    alert.notification_gate=notificationGate;
    if(!alert.eligible||a.score<this.config.minScore||a.confirmations<this.config.minConfirmations||!gate.eligible||!notificationGate.eligible)return alert;
    const lastAlert=this.lastAlertAt.get(row.symbol)||0;
    if(this.clock()-lastAlert<this.config.alertCooldownMs)return alert;
    this.lastAlertAt.set(row.symbol,this.clock());
    const decorated=decorateRadarAlert(alert,'Radar 3 — Rotation/Lag');
    await this.store.appendRotationAlert(decorated);
    if(this.pushManager?.notifyRadarAlert)await this.pushManager.notifyRadarAlert(decorated);
    rememberRadarAlert(decorated,this.clock());
    this.alertCount++;
    return alert;
  }

  async tick(){
    if(!this.running||this.busy)return;
    this.busy=true;
    try{
      if(this.clock()-this.universeAt>this.config.universeRefreshMs)await this.refreshUniverse();
      const [rows,benchmarks]=await Promise.all([this.tickerRows(),this.benchmarkData()]);
      const selected=this.selectBatch(rows);
      this.lastScanAtMs=this.clock();
      for(const row of selected){
        if(!this.running)break;
        try{await this.scanRow(row,benchmarks);}catch(e){this.noteError(e);}
      }
    }finally{this.busy=false;}
  }

  health(){
    return {
      running:this.running,radar:'ROTATION_LAG_RADAR',universe:this.universe.length,
      last_universe_refresh_at:this.universeAt||null,last_scan_at:this.lastScanAtMs,
      scans:this.scans,alerts_emitted:this.alertCount,last_error:this.lastError,busy:this.busy,
      rest:this.rest?.health?.()||null,
      algorithms:[
        'CROSS_MARKET_LEAD_LAG','RELATIVE_STRENGTH_SPREAD','SILENT_VOLUME_PRICE_DISLOCATION',
        'VWAP_RECLAIM_REJECTION','VALUE_ACCEPTANCE','RSI_TURN','MFI_TURN',
        'STOCHASTIC_TURN','PRICE_PERSISTENCE','RANGE_COMPRESSION'
      ],
      source:'Binance Public REST',closed_candles_only:true,
      paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
    };
  }
}
