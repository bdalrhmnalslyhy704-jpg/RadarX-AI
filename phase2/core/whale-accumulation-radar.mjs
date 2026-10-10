import {buildSpotUniverse,normalizeTickerRow} from '../market/universe-scanner.mjs';
import {ScanSchedulerJournal, schedulerLaneReason} from './scan-scheduler.mjs';
import {formatRadarTime12h,decorateRadarAlert} from './radar-alert-meta.mjs';
import {evaluateEliteGate} from './elite-confluence-gate.mjs';

const clamp=(x,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number.isFinite(Number(x))?Number(x):0));
const finite=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const mean=xs=>{const a=xs.map(Number).filter(Number.isFinite);return a.length?a.reduce((s,x)=>s+x,0)/a.length:null};
const median=xs=>{const a=xs.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2};
const pct=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&b!==0?(a-b)/b*100:null;
const sum=xs=>xs.reduce((s,x)=>s+(Number.isFinite(Number(x))?Number(x):0),0);

function closed(rows,now){
  return (Array.isArray(rows)?rows:[]).filter(c=>
    c&&c.closed!==false&&Number.isFinite(Number(c.openTime))&&Number.isFinite(Number(c.closeTime))&&
    Number(c.closeTime)<=now&&Number(c.open)>0&&Number(c.high)>=Number(c.low)&&
    Number(c.low)>0&&Number(c.close)>0&&Number(c.volume)>=0
  ).sort((a,b)=>Number(a.openTime)-Number(b.openTime));
}

function depthStats(book,price){
  if(!(price>0)||!book)return {
    spreadBps:null,nearBid:0,nearAsk:0,midBid:0,midAsk:0,
    nearImbalance:0,midImbalance:0,bidWallScore:40,askWallScore:40,
    supportNotional:0,resistanceNotional:0,totalNear:0
  };
  const bids=Array.isArray(book.bids)?book.bids:[],asks=Array.isArray(book.asks)?book.asks:[];
  const bestBid=finite(bids[0]&&bids[0][0],null),bestAsk=finite(asks[0]&&asks[0][0],null);
  const spreadBps=bestBid&&bestAsk&&bestAsk>=bestBid?((bestAsk-bestBid)/((bestAsk+bestBid)/2))*10000:null;
  function sideNotional(rows,bps){
    const band=price*bps/10000;
    return sum(rows.map(x=>{
      const p=Number(x&&x[0]),q=Number(x&&x[1]);
      if(!(p>0)||!(q>=0))return 0;
      return Math.abs(p-price)<=band?p*q:0;
    }));
  }
  const nearBid=sideNotional(bids,5),nearAsk=sideNotional(asks,5);
  const midBid=sideNotional(bids,15),midAsk=sideNotional(asks,15);
  const nearTotal=nearBid+nearAsk,midTotal=midBid+midAsk;
  const nearImbalance=nearTotal>0?(nearBid-nearAsk)/nearTotal:0;
  const midImbalance=midTotal>0?(midBid-midAsk)/midTotal:0;
  const topBidQty=median(bids.slice(0,10).map(x=>Number(x&&x[1])));
  const topAskQty=median(asks.slice(0,10).map(x=>Number(x&&x[1])));
  const biggestBid=Math.max(0,...bids.slice(0,25).map(x=>Number(x&&x[0])*Number(x&&x[1])).filter(Number.isFinite));
  const biggestAsk=Math.max(0,...asks.slice(0,25).map(x=>Number(x&&x[0])*Number(x&&x[1])).filter(Number.isFinite));
  const bidWallScore=Number.isFinite(topBidQty)&&topBidQty>0?clamp(50+(biggestBid/(topBidQty*Math.max(bestBid,1))-1)*12):40;
  const askWallScore=Number.isFinite(topAskQty)&&topAskQty>0?clamp(50+(biggestAsk/(topAskQty*Math.max(bestAsk,1))-1)*8):40;
  return {
    spreadBps,nearBid,nearAsk,midBid,midAsk,nearImbalance,midImbalance,
    bidWallScore,askWallScore,supportNotional:nearBid,resistanceNotional:nearAsk,totalNear:nearTotal
  };
}

function tradeRows(rows){
  return (Array.isArray(rows)?rows:[]).map(x=>{
    const price=Number(x&&x.p),qty=Number(x&&x.q),time=Number(x&&x.T);
    if(!(price>0)&&!(qty>0))return null;
    const notional=price*qty;
    return {id:Number(x&&x.a)||null,price,qty,notional,time,buyerIsMaker:Boolean(x&&x.m)};
  }).filter(x=>x&&x.notional>0&&Number.isFinite(x.time)).sort((a,b)=>a.time-b.time);
}

function largePrintStats(rows,ticker,now,config){
  const trades=tradeRows(rows).filter(x=>x.time<=now);
  if(!trades.length)return {
    available:false,tradeCount:0,largeCount:0,largeBuyCount:0,largeSellCount:0,
    largeBuyNotional:0,largeSellNotional:0,largeBuyRatio:null,largeNotionalRatio:null,
    thresholdNotional:null,repeatBuyScore:40,burstScore:40,score:40,topPrints:[]
  };
  const qv=Math.max(0,Number(ticker&&ticker.quoteVolume24h)||0);
  const floor=Math.max(Number(config.minWhaleNotional)||25000,qv/Math.max(1,Number(config.volumeDivisor)||10000));
  const notionals=trades.map(x=>x.notional);
  const p90=Number.isFinite(median(notionals))?percentile(notionals,0.90):floor;
  const threshold=Math.max(floor,p90);
  const large=trades.filter(x=>x.notional>=threshold);
  if(!large.length)return {
    available:true,tradeCount:trades.length,largeCount:0,largeBuyCount:0,largeSellCount:0,
    largeBuyNotional:0,largeSellNotional:0,largeBuyRatio:null,largeNotionalRatio:null,
    thresholdNotional:threshold,repeatBuyScore:40,burstScore:40,score:40,topPrints:[]
  };
  const buys=large.filter(x=>!x.buyerIsMaker);
  const sells=large.filter(x=>x.buyerIsMaker);
  const buyN=sum(buys.map(x=>x.notional)),sellN=sum(sells.map(x=>x.notional));
  const totalN=buyN+sellN;
  const largeBuyRatio=large.length?buys.length/large.length:null;
  const largeNotionalRatio=totalN>0?(buyN-sellN)/totalN:null;
  const first=trades[Math.max(0,trades.length-250)],last=trades.at(-1);
  const midpoint=first&&last?(first.time+last.time)/2:null;
  const firstLarge=midpoint!==null?large.filter(x=>x.time<midpoint):large.slice(0,Math.floor(large.length/2));
  const secondLarge=midpoint!==null?large.filter(x=>x.time>=midpoint):large.slice(Math.floor(large.length/2));
  const firstBuy=sum(firstLarge.filter(x=>!x.buyerIsMaker).map(x=>x.notional));
  const secondBuy=sum(secondLarge.filter(x=>!x.buyerIsMaker).map(x=>x.notional));
  const burstRatio=firstBuy>0?secondBuy/firstBuy:(secondBuy>0?2:null);
  const repeatBuyScore=largeBuyRatio===null?40:clamp(35+largeBuyRatio*90+(largeNotionalRatio||0)*80);
  const burstScore=burstRatio===null?40:clamp(50+(burstRatio-1)*45);
  const sizeConcentration=totalN>0?clamp(50+Math.log10(Math.max(1,totalN/Math.max(qv,1))*10000)*18):40;
  const score=clamp(repeatBuyScore*.42+burstScore*.20+sizeConcentration*.18+(large.length>=4?76:54)*.20);
  const topPrints=[...large].sort((a,b)=>b.notional-a.notional).slice(0,8).map(x=>({
    notional:Number(x.notional.toFixed(2)),price:x.price,qty:x.qty,
    side:x.buyerIsMaker?'SELL_AGGRESSOR':'BUY_AGGRESSOR',time:x.time
  }));
  return {
    available:true,tradeCount:trades.length,largeCount:large.length,
    largeBuyCount:buys.length,largeSellCount:sells.length,
    largeBuyNotional:Number(buyN.toFixed(2)),largeSellNotional:Number(sellN.toFixed(2)),
    largeBuyRatio:Number(largeBuyRatio.toFixed(4)),
    largeNotionalRatio:Number((largeNotionalRatio||0).toFixed(4)),
    thresholdNotional:Number(threshold.toFixed(2)),
    repeatBuyScore:Number(repeatBuyScore.toFixed(1)),
    burstScore:Number(burstScore.toFixed(1)),
    sizeConcentration:Number(sizeConcentration.toFixed(1)),
    score:Number(score.toFixed(1)),topPrints
  };
}

function percentile(values,p){
  const a=values.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!a.length)return null;
  const i=(a.length-1)*Math.max(0,Math.min(1,p)),lo=Math.floor(i),hi=Math.ceil(i);
  return lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(i-lo);
}

function candleAccumulation(candles,now){
  const rows=closed(candles,now);
  if(rows.length<30)return {
    available:false,volumeRatio:null,takerBuyRatio:null,priceMovePct:null,
    lowerWickScore:40,higherLowScore:40,absorptionScore:40,score:40
  };
  const recent=rows.slice(-6),base=rows.slice(-30,-6);
  const recentVol=mean(recent.map(x=>Number(x.volume))),baseVol=median(base.map(x=>Number(x.volume)));
  const volumeRatio=recentVol&&baseVol?recentVol/baseVol:null;
  const buy=sum(recent.map(x=>Number(x.takerBuyBaseVolume)||0));
  const vol=sum(recent.map(x=>Number(x.volume)||0));
  const takerBuyRatio=vol>0?buy/vol:null;
  const priceMovePct=pct(Number(recent.at(-1).close),Number(recent[0].open));
  const lowerWickRatio=mean(recent.map(x=>{
    const o=Number(x.open),c=Number(x.close),l=Number(x.low),r=Math.max(Number(x.high)-l,1e-12);
    return Math.max(0,Math.min(o,c)-l)/r;
  }));
  const lowerWickScore=Number.isFinite(lowerWickRatio)?clamp(lowerWickRatio*280):40;
  const lows=recent.map(x=>Number(x.low));
  let higherLow=0;
  for(let i=1;i<lows.length;i++)if(lows[i]>lows[i-1])higherLow++;
  const higherLowScore=clamp(higherLow*17);
  const stable=Math.abs(Number(priceMovePct)||0)<=1.5?88:Math.abs(Number(priceMovePct)||0)<=3?68:35;
  const buyScore=Number.isFinite(takerBuyRatio)?clamp(50+(takerBuyRatio-.5)*360):45;
  const volumeScore=Number.isFinite(volumeRatio)?clamp(48+(volumeRatio-1)*34):45;
  const absorptionScore=clamp(volumeScore*.28+stable*.25+lowerWickScore*.15+buyScore*.20+higherLowScore*.12);
  return {
    available:true,volumeRatio:Number.isFinite(volumeRatio)?Number(volumeRatio.toFixed(3)):null,
    takerBuyRatio:Number.isFinite(takerBuyRatio)?Number(takerBuyRatio.toFixed(4)):null,
    priceMovePct:Number.isFinite(priceMovePct)?Number(priceMovePct.toFixed(3)):null,
    lowerWickScore:Number(lowerWickScore.toFixed(1)),higherLowScore:Number(higherLowScore.toFixed(1)),
    absorptionScore:Number(absorptionScore.toFixed(1)),score:Number(absorptionScore.toFixed(1))
  };
}

function relativeContext(ticker,btc){
  const move=finite(ticker&&ticker.priceChange24h,0),bm=finite(btc&&btc.priceChange24h,0);
  return {
    ticker24h:move,btc24h:bm,
    relativeVsBtc:Number((move-bm).toFixed(3)),
    score:Number(clamp(52+(move-bm)*10).toFixed(1))
  };
}

export function buildWhaleAccumulationAnalysis({ticker,oneMinute,fiveMinute,aggTrades,book,previousBook=null,now=Date.now(),config={}}={}){
  const t=ticker||{},price=finite(t.lastPrice,0);
  const prints=largePrintStats(aggTrades,t,now,config);
  const candles=candleAccumulation(oneMinute,now);
  const five=closed(fiveMinute,now);
  const depth=depthStats(book,price);
  const previous=depthStats(previousBook,price);
  const depthPersistence=previousBook
    ? clamp(50+(depth.nearImbalance>=previous.nearImbalance?28:0)+(depth.midImbalance>=previous.midImbalance?22:0))
    : 50;
  const quiet24=Math.abs(Number(t.priceChange24h)||0)<=3.5;
  const notExtended=Math.abs(Number(t.priceChange24h)||0)<Number(config.maxExtended24hPct||8);
  const spreadOk=depth.spreadBps===null||depth.spreadBps<=Number(config.maxSpreadBps||15);
  const recent5m= five.slice(-6);
  const fiveMove=recent5m.length>=2?pct(Number(recent5m.at(-1).close),Number(recent5m[0].open)):null;
  const fiveScore=Number.isFinite(fiveMove)?clamp(52+fiveMove*22):45;
  const buyDominance=prints.largeNotionalRatio===null?45:clamp(50+(prints.largeNotionalRatio||0)*100);
  const supportScore=clamp(
    (50+depth.nearImbalance*170)*.48+
    (50+depth.midImbalance*140)*.22+
    depth.bidWallScore*.10+
    depthPersistence*.20
  );
  const stabilityScore=clamp(
    (quiet24?88:62)*.30+
    (candles.absorptionScore||45)*.30+
    (fiveScore>=45?fiveScore:45)*.15+
    (notExtended?90:20)*.25
  );
  const confirmations=[
    prints.largeCount>=4,
    prints.largeBuyRatio>=Number(config.minLargeBuyRatio||0.60),
    prints.largeNotionalRatio>=Number(config.minLargeNotionalImbalance||0.12),
    prints.repeatBuyScore>=Number(config.minRepeatBuyScore||67),
    prints.burstScore>=Number(config.minBurstScore||58),
    candles.volumeRatio>=Number(config.minVolumeRatio||1.15),
    candles.takerBuyRatio>=Number(config.minTakerBuyRatio||0.515),
    candles.absorptionScore>=Number(config.minAbsorptionScore||67),
    depth.nearImbalance>=Number(config.minNearImbalance||0.08),
    depth.midImbalance>=Number(config.minMidImbalance||0.05),
    supportScore>=Number(config.minSupportScore||65),
    depthPersistence>=60,
    spreadOk,
    quiet24,
    notExtended,
    fiveScore>=48
  ];
  const confirmationCount=confirmations.filter(Boolean).length;
  const score=clamp(
    prints.score*.31+
    candles.absorptionScore*.21+
    buyDominance*.14+
    supportScore*.17+
    stabilityScore*.10+
    fiveScore*.04+
    relativeNeutrality(quiet24)*.03
  );
  const eligible=
    price>0&&
    score>=Number(config.minScore||84)&&
    confirmationCount>=Number(config.minConfirmations||8)&&
    prints.largeBuyRatio>=Number(config.minLargeBuyRatio||0.60)&&
    prints.largeNotionalRatio>=Number(config.minLargeNotionalImbalance||0.12)&&
    prints.largeCount>=4&&
    candles.absorptionScore>=Number(config.minAbsorptionScore||67)&&
    depth.nearImbalance>=Number(config.minNearImbalance||0.08)&&
    supportScore>=Number(config.minSupportScore||65)&&
    spreadOk&&
    notExtended;
  const stage=eligible&&score>=92?'WHALE_ACCUMULATION_CONFIRMED':score>=87?'WHALE_ACCUMULATION_ACTIVE':score>=78?'WHALE_BUILDING':'WATCH';
  const direction=buyDominance>=65?'BUY_SIDE':'BALANCED';
  const reasons=[];
  const push=(ok,s)=>{if(ok)reasons.push(s)};
  push(prints.largeBuyRatio>=0.60,'Large prints تميل بقوة لجهة الشراء');
  push(prints.largeNotionalRatio>=0.12,'صافي القيمة الكبيرة لصالح المشترين');
  push(prints.repeatBuyScore>=67,'تكرار صفقات كبيرة شرائية');
  push(prints.burstScore>=58,'تسارع في الطباعة الكبيرة');
  push(candles.volumeRatio>=1.15,'الحجم مرتفع فوق خط الأساس');
  push(candles.takerBuyRatio>=0.515,'Taker Buy يؤكد الطلب');
  push(candles.absorptionScore>=67,'السعر يمتص ضغط البيع بدل الانهيار');
  push(depth.nearImbalance>=0.08,'عمق قريب لصالح الطلب');
  push(depth.midImbalance>=0.05,'عمق متوسط لصالح الطلب');
  push(depthPersistence>=60,'الدعم السعري مستمر في لقطتين');
  push(candles.higherLowScore>=50,'قيعان أعلى');
  push(fiveScore>=48,'تأكيد 5m');
  if(!spreadOk)reasons.push('رفض: السبريد واسع');
  if(!notExtended)reasons.push('رفض: الحركة اليومية ممتدة');
  const risk=[];
  if(Math.abs(Number(t.priceChange24h)||0)>5)risk.push('MOVING_TOO_FAST');
  if(depth.spreadBps!==null&&depth.spreadBps>10)risk.push('SPREAD_ATTENTION');
  if(prints.largeNotionalRatio<0)risk.push('LARGE_SELL_PRESSURE');
  if(depth.nearImbalance<0)risk.push('ASK_DEPTH_DOMINANT');
  if(!previousBook)risk.push('NO_DEPTH_PERSISTENCE_YET');
  return {
    eligible,stage,score:Number(score.toFixed(1)),direction,
    confirmation_count:confirmationCount,confirmation_total:confirmations.length,
    large_prints:prints,candle_flow:candles,orderbook:depth,
    orderbook_persistence:{score:Number(depthPersistence.toFixed(1)),has_previous:Boolean(previousBook),previous_near_imbalance:Number(previous.nearImbalance.toFixed(4)),current_near_imbalance:Number(depth.nearImbalance.toFixed(4))},
    price_context:{price,price_change_24h:finite(t.priceChange24h,0),five_minute_move_pct:fiveMove,quiet_24h:quiet24,not_extended:notExtended},
    support_score:Number(supportScore.toFixed(1)),stability_score:Number(stabilityScore.toFixed(1)),
    relative:{score:50},
    trigger:{
      min_score:Number(config.minScore||84),min_confirmations:Number(config.minConfirmations||8),
      min_large_buy_ratio:Number(config.minLargeBuyRatio||0.60),
      min_large_notional_imbalance:Number(config.minLargeNotionalImbalance||0.12),
      min_near_imbalance:Number(config.minNearImbalance||0.08),
      min_support_score:Number(config.minSupportScore||65)
    },
    reasons:[...new Set(reasons)].slice(0,14),
    risk_flags:[...new Set(risk)],
    source:'Binance Public REST (/aggTrades + /depth + /klines)',
    limitation:'Large-order/whale footprint inferred from public market microstructure; trader identity is not available.',
    detected_at:now,processed_at:now,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
  };
}

function relativeNeutrality(quiet){return quiet?82:48;}

export function buildWhaleAccumulationAlert(input,now=Date.now()){
  const a=buildWhaleAccumulationAnalysis({...input,now});
  const t=input.ticker||{};
  const gate=evaluateEliteGate({
    radar:'WHALE_ACCUMULATION_RADAR',
    direction:'UP_MOVE',
    baseScore:a.score,
    priceChange24h:finite(t.priceChange24h,0),
    liquidityScore:clamp(50+Math.log10(Math.max(1,(Number(t.quoteVolume24h)||1)/1500000))*30),
    dataQualityScore:100,
    triggerScore:a.large_prints.score,
    structureScore:a.candle_flow.higherLowScore,
    participationScore:a.candle_flow.absorptionScore,
    flowScore:a.support_score,
    relativeScore:a.price_context.quiet_24h?68:50,
    momentumScore:a.candle_flow.absorptionScore,
    compressionScore:a.stability_score,
    confirmations:a.confirmation_count,
    minConfirmations:Math.min(8,Number(a.trigger.min_confirmations)||8),
    minScore:Math.max(84,Number(a.trigger.min_score)||84),
    max24hMovePct:8,
    requireTrigger:true,
    minCategoryHits:5
  });
  a.elite_gate=gate;
  return decorateRadarAlert({
    id:'WHALE:'+String(t.symbol||'UNKNOWN').toUpperCase()+':'+now,
    event:'WHALE_ACCUMULATION_ALERT',
    radar:'WHALE_ACCUMULATION_RADAR',
    radar_name:'🐋 تجمع الحيتان',
    symbol:String(t.symbol||'UNKNOWN').toUpperCase(),
    market:'SPOT',direction:'UP_MOVE',
    price:finite(t.lastPrice,null),
    price_change_24h:finite(t.priceChange24h,null),
    opportunity_score:a.score,potential_label:a.stage,
    whale_accumulation:a,reasons:a.reasons,risk_flags:a.risk_flags,
    source:a.source,limitation:a.limitation,
    detected_at:now,processed_at:now,detected_at_iso:new Date(now).toISOString(),
    detected_time_12h:formatRadarTime12h(now),detected_timezone:'Asia/Aden',
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
    eligible:Boolean(a.eligible&&gate.eligible),disclaimer:'بصمة تجمع كبيرة مستنتجة من بيانات السوق العامة؛ لا يمكن إثبات هوية الحوت من هذه البيانات وحدها. النتائج مراقبة ورقية فقط.'
  },'🐋 تجمع الحيتان');
}

export const WHALE_ACCUMULATION_DEFAULTS=Object.freeze({
  quote:'USDT',pollMs:60000,universeRefreshMs:10*60*1000,
  minQuoteVolume24h:1500000,topAnchors:8,rotationBatchSize:10,deepConcurrency:5,
  schedulerFastPathSlots:2,schedulerQuietAnchorSlots:4,
  schedulerExceptionalVolumeRatio:2.2,schedulerExceptionalTradeRatio:1.8,
  schedulerExceptionalPriceStepPct:0.15,schedulerQuietParticipationRatio:1.12,
  schedulerQuietMaxDailyMovePct:8,
  minWhaleNotional:25000,volumeDivisor:10000,
  minLargeBuyRatio:0.60,minLargeNotionalImbalance:0.12,minRepeatBuyScore:67,minBurstScore:58,
  minVolumeRatio:1.15,minTakerBuyRatio:0.515,minAbsorptionScore:67,
  minNearImbalance:0.08,minMidImbalance:0.05,minSupportScore:65,maxSpreadBps:15,
  minScore:84,minConfirmations:8,maxExtended24hPct:8,alertCooldownMs:12*60*1000
});

export class WhaleAccumulationRadar{
  constructor({rest,store,pushManager=null,config={},clock=()=>Date.now(),logger=console}={}){
    if(!rest)throw new Error('REST_CLIENT_REQUIRED');
    if(!store)throw new Error('STORE_REQUIRED');
    this.rest=rest;this.store=store;this.pushManager=pushManager;this.config={...WHALE_ACCUMULATION_DEFAULTS,...config};
    this.clock=clock;this.logger=logger;this.running=false;this.busy=false;this.timer=null;
    this.pendingTick=false;this.pendingTickAt=null;this.coalescedTickCount=0;this.nextCyclePendingWaitMs=0;
    this.universe=[];this.universeAt=0;this.cursor=0;this.scans=0;this.alertCount=0;this.lastError=null;this.lastScanAtMs=null;
    this.latestCandidates=[];this.previousDepth=new Map();this.lastAlertAt=new Map();this.lastCoverage={};
    this.lastRowTimings=new Map();
    this.scheduler=new ScanSchedulerJournal({radar:'RADAR_9',store,clock,logger});
    this.fastHistoryBySymbol=new Map();this.lastSelectionDistribution={};
  }
  start(){
    if(this.running)return Promise.resolve();
    this.running=true;
    const initial=Promise.resolve().then(()=>this.tick()).catch(e=>{this.lastError=String(e?.message??e);});
    this.timer=setInterval(()=>this.tick().catch(e=>{this.lastError=String(e?.message??e);}),Math.max(30000,Number(this.config.pollMs)||60000));
    return initial;
  }
  async stop(){this.running=false;if(this.timer)clearInterval(this.timer);this.timer=null;}
  async refreshUniverse(){
    const r=await this.rest.request('/api/v3/exchangeInfo');
    this.universe=buildSpotUniverse(r.data,this.config.quote).map(x=>x.symbol);
    this.universeAt=this.clock();
    if(this.universe.length)this.cursor=this.cursor%this.universe.length;
  }
  async tickerRows(){
    const r=await this.rest.request('/api/v3/ticker/24hr');
    const rows=(Array.isArray(r.data)?r.data:[]).map(x=>normalizeTickerRow(x,this.config.quote)).filter(Boolean)
      .filter(x=>this.universe.includes(x.symbol)&&Number(x.quoteVolume24h)>=Number(this.config.minQuoteVolume24h));
    return rows;
  }
  updateFastSnapshot(row, at = this.clock()) {
    const symbol=String(row?.symbol||'').toUpperCase();
    if(!symbol)return {volume_accel_ratio:null,trade_accel_ratio:null,price_acceleration_pct:null,warmed_up:false};
    const history=this.fastHistoryBySymbol.get(symbol)||[];
    const previous=history.length?history[history.length-1]:null;
    const spanMs=previous?Math.max(1,at-previous.at):null;
    const quoteDelta=previous?Math.max(0,Number(row.quoteVolume24h)-previous.quoteVolume24h):null;
    const tradeDelta=previous?Math.max(0,Number(row.tradeCount24h)-previous.tradeCount24h):null;
    const volumeRate=previous?quoteDelta/Math.max(1,spanMs/60000):null;
    const tradeRate=previous?tradeDelta/Math.max(1,spanMs/60000):null;
    const priorVolumes=history.slice(-8).map(x=>x.volumeRate).filter(x=>Number.isFinite(x)&&x>0);
    const priorTrades=history.slice(-8).map(x=>x.tradeRate).filter(x=>Number.isFinite(x)&&x>0);
    const median=values=>{
      const sorted=[...values].sort((a,b)=>a-b);
      if(!sorted.length)return null;
      const mid=Math.floor(sorted.length/2);
      return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
    };
    const volumeBase=median(priorVolumes),tradeBase=median(priorTrades);
    const previousPrice=Number(previous?.lastPrice),currentPrice=Number(row.lastPrice);
    const priceStep=previousPrice>0&&currentPrice>0?(currentPrice/previousPrice-1)*100:null;
    const snapshot={
      at,quoteVolume24h:Number(row.quoteVolume24h)||0,tradeCount24h:Number(row.tradeCount24h)||0,
      lastPrice:currentPrice,volumeRate,tradeRate,priceStepPct:priceStep
    };
    history.push(snapshot);
    while(history.length>12)history.shift();
    this.fastHistoryBySymbol.set(symbol,history);
    return {
      volume_accel_ratio:Number.isFinite(volumeBase)&&volumeBase>0&&Number.isFinite(volumeRate)?volumeRate/volumeBase:null,
      trade_accel_ratio:Number.isFinite(tradeBase)&&tradeBase>0&&Number.isFinite(tradeRate)?tradeRate/tradeBase:null,
      price_acceleration_pct:Number.isFinite(priceStep)?priceStep:null,
      quote_delta:quoteDelta,trade_delta:tradeDelta,observed_at:at,warmed_up:history.length>=3
    };
  }
  selectBatch(rows, at = this.clock()) {
    const uniqueBySymbol=new Map();
    for(const row of Array.isArray(rows)?rows:[]){
      const symbol=String(row?.symbol||'').toUpperCase();
      if(symbol&&!uniqueBySymbol.has(symbol))uniqueBySymbol.set(symbol,row);
    }
    const all=[...uniqueBySymbol.values()].map(row=>{
      const symbol=String(row.symbol).toUpperCase();
      const fast=row._schedulerFast||this.fastHistoryBySymbol.get(symbol)?.at(-1)||{};
      const move=Number(row.priceChange24h);
      const validMove=Number.isFinite(move);
      const exceptional=(Number(fast.volume_accel_ratio)>=Number(this.config.schedulerExceptionalVolumeRatio)||
        Number(fast.trade_accel_ratio)>=Number(this.config.schedulerExceptionalTradeRatio)||
        Number(fast.price_acceleration_pct)>=Number(this.config.schedulerExceptionalPriceStepPct));
      const quiet=validMove&&Math.abs(move)<=Number(this.config.schedulerQuietMaxDailyMovePct)&&
        (Number(fast.volume_accel_ratio)>=Number(this.config.schedulerQuietParticipationRatio)||
         Number(fast.trade_accel_ratio)>=Number(this.config.schedulerQuietParticipationRatio)||
         (Number(fast.price_acceleration_pct)>0&&Number(fast.price_acceleration_pct)<Number(this.config.schedulerExceptionalPriceStepPct)));
      const lastAt=this.scheduler.lastScanAt('DEEP',symbol);
      const queuedAt=this.scheduler.queueStartedAt('DEEP',symbol);
      const cursorIndex=this.universe.indexOf(symbol);
      const cursorDistance=cursorIndex<0?Number.MAX_SAFE_INTEGER:(cursorIndex-this.cursor+this.universe.length)%Math.max(1,this.universe.length);
      const qa=Math.max(0,Number(row.quoteVolume24h)||0);
      const rank=(validMove?100-Math.min(60,Math.abs(move)*10):0)+Math.log10(Math.max(1,qa))*3;
      return {...row,_schedulerFast:fast,_exceptional:exceptional,_quiet:quiet,_schedulerRank:rank,
        _lastDeepAt:lastAt,_neverDeepScanned:lastAt===null,
        _deepWaitAgeMs:lastAt===null?Number.MAX_SAFE_INTEGER:Math.max(0,at-lastAt),
        _queueAgeMs:queuedAt===null?0:Math.max(0,at-queuedAt),
        _cursorDistance:cursorDistance};
    });
    const rankDesc=[...all].sort((a,b)=>b._schedulerRank-a._schedulerRank||a.symbol.localeCompare(b.symbol));
    const quietRank=all.filter(x=>x._quiet).sort((a,b)=>
      Math.abs(Number(a.priceChange24h))-Math.abs(Number(b.priceChange24h))||
      b._schedulerRank-a._schedulerRank||a.symbol.localeCompare(b.symbol));
    const exceptional=all.filter(x=>x._exceptional).sort((a,b)=>
      b._schedulerRank-a._schedulerRank||b._deepWaitAgeMs-a._deepWaitAgeMs||a.symbol.localeCompare(b.symbol));
    const rotation=[...all].sort((a,b)=>
      Number(b._exceptional)-Number(a._exceptional)||
      Number(b._neverDeepScanned)-Number(a._neverDeepScanned)||
      b._deepWaitAgeMs-a._deepWaitAgeMs||
      b._queueAgeMs-a._queueAgeMs||
      a._cursorDistance-b._cursorDistance||a.symbol.localeCompare(b.symbol));
    const topCount=Math.max(1,Math.trunc(Number(this.config.topAnchors)||8));
    const rotationCount=Math.max(1,Math.trunc(Number(this.config.rotationBatchSize)||10));
    const target=Math.min(all.length,topCount+rotationCount);
    const anchorTarget=Math.min(topCount,target);
    const rotationTarget=Math.min(rotationCount,Math.max(0,target-anchorTarget));
    const selected=[],seen=new Set();
    const take=(pool,count,lane)=>{
      const limit=Math.max(0,Math.trunc(Number(count)||0));
      if(limit===0)return 0;
      let added=0;
      for(const row of pool){
        const symbol=String(row?.symbol||'').toUpperCase();
        if(!symbol||seen.has(symbol))continue;
        seen.add(symbol);selected.push({...row,_selection_lane:lane});added++;
        if(added>=limit)break;
      }
      return added;
    };
    const fastSlots=Math.min(anchorTarget,Math.max(0,Math.trunc(Number(this.config.schedulerFastPathSlots)||2)));
    take(exceptional,fastSlots,'exceptional');
    const quietSlots=Math.min(Math.max(0,Math.trunc(Number(this.config.schedulerQuietAnchorSlots)||4)),Math.max(0,anchorTarget-selected.length));
    take(quietRank,quietSlots,'quiet');
    take(rankDesc,Math.max(0,anchorTarget-selected.length),'anchor');
    take(rotation,rotationTarget,'rotation');
    // If a lane overlaps or has too few eligible candidates, use unique bounded fallbacks.
    take(exceptional,target-selected.length,'fast');
    take(rotation,target-selected.length,'rotation_fill');
    take(rankDesc,target-selected.length,'rank_fill');
    this.lastSelectionDistribution=selected.reduce((out,row)=>{
      const lane=row._selection_lane||'unknown';out[lane]=(out[lane]||0)+1;return out;
    },{});
    return selected.slice(0,target);
  }
  async scanRow(row){
    const symbol=String(row?.symbol||'').toUpperCase();
    const rowStartedAt=this.clock();
    const timing={symbol,data_fetch_ms:0,signal_analysis_ms:0,signal_archive_write_ms:0,result_send_ms:0,row_total_ms:0};
    try{
      const dataStartedAt=this.clock();
      const aggTradesPromise=typeof this.rest.aggTrades==='function'
        ?this.rest.aggTrades(row.symbol,{limit:1000})
        :this.rest.request('/api/v3/aggTrades',{symbol:row.symbol,limit:1000});
      const [one,five,agg,depth]=await Promise.all([
        this.rest.klines(row.symbol,'1m',{limit:120}),
        this.rest.klines(row.symbol,'5m',{limit:60}),
        aggTradesPromise,
        this.rest.depth(row.symbol,100)
      ]);
      timing.data_fetch_ms=Math.max(0,this.clock()-dataStartedAt);
      const analysisStartedAt=this.clock();
      const prev=this.previousDepth.get(row.symbol)||null;
      const alert=buildWhaleAccumulationAlert({
        ticker:row,oneMinute:one.candles,fiveMinute:five.candles,aggTrades:agg.data,book:depth.data,previousBook:prev
      },this.clock());
      this.previousDepth.set(row.symbol,depth.data);
      this.latestCandidates.push(alert);
      this.latestCandidates.sort((a,b)=>Number(b.opportunity_score||0)-Number(a.opportunity_score||0));
      this.latestCandidates=this.latestCandidates.slice(0,60);
      this.scans++;
      timing.signal_analysis_ms=Math.max(0,this.clock()-analysisStartedAt);
      if(alert.eligible){
        const last=this.lastAlertAt.get(row.symbol)||0;
        if(this.clock()-last>=Number(this.config.alertCooldownMs||720000)){
          this.lastAlertAt.set(row.symbol,this.clock());
          const archiveStartedAt=this.clock();
          await this.store.appendWhaleAccumulationAlert(alert);
          timing.signal_archive_write_ms+=Math.max(0,this.clock()-archiveStartedAt);
          if(this.pushManager?.notifyRadarAlert){
            const sendStartedAt=this.clock();
            await this.pushManager.notifyRadarAlert(alert);
            timing.result_send_ms+=Math.max(0,this.clock()-sendStartedAt);
          }
          this.alertCount++;
        }
      }
      return alert;
    }finally{
      timing.row_total_ms=Math.max(0,this.clock()-rowStartedAt);
      this.lastRowTimings.set(symbol,timing);
    }
  }
  async tick(){
    if(!this.running)return;
    if(this.busy){
      this.pendingTick=true;
      if(this.pendingTickAt===null)this.pendingTickAt=this.clock();
      this.coalescedTickCount++;
      return;
    }
    this.busy=true;
    const cycleStartedAt=this.clock();
    const pollMs=Math.max(30000,Number(this.config.pollMs)||60000);
    const metrics={
      radar:'RADAR_9',cycle:Math.max(1,Math.trunc(Number(this.lastCoverage?.cycle||0))+1),
      cadence_ms:pollMs,started_at:new Date(cycleStartedAt).toISOString(),
      archive_hydration_ms:0,universe_refresh_ms:0,ticker_collection_ms:0,data_collection_ms:0,
      fast_snapshot_ms:0,fast_selection_ms:0,fast_scan_ms:0,
      micro_scan_ms:null,micro_scan_status:'NOT_APPLICABLE_RADAR_9_HAS_NO_MICRO_STAGE',
      deep_scan_wall_ms:0,deep_row_time_sum_ms:0,deep_data_fetch_sum_ms:0,
      signal_analysis_sum_ms:0,signal_archive_write_ms:0,result_send_ms:0,
      scheduler_archive_write_ms:0,fast_symbols:0,deep_selected:0,deep_attempted:0,
      deep_completed:0,incomplete:0,failed:0,unattempted:0,
      unique_selected_symbols:0,duplicate_selected_count:0,selection_distribution:{},
      quiet_selected_count:0,exceptional_selected_count:0,deep_concurrency:0,
      coalesced_tick_count:0,pending_tick_age_ms:0,deep_wait_ms:[],selected_symbols:[],
      paper_trading:true,real_order_execution:false
    };
    metrics.pending_tick_wait_ms=this.nextCyclePendingWaitMs;
    this.nextCyclePendingWaitMs=0;
    let selected=[];
    let cycleError=null;
    try{
      const hydrationStartedAt=this.clock();
      await this.scheduler.hydrate();
      metrics.archive_hydration_ms=Math.max(0,this.clock()-hydrationStartedAt);
      const refreshStartedAt=this.clock();
      if(!this.universe.length||this.clock()-this.universeAt>=Number(this.config.universeRefreshMs))
        await this.refreshUniverse();
      metrics.universe_refresh_ms=Math.max(0,this.clock()-refreshStartedAt);

      const collectionStartedAt=this.clock();
      const fetchedRows=await this.tickerRows();
      metrics.ticker_collection_ms=Math.max(0,this.clock()-collectionStartedAt);
      const fastSeenAt=this.clock();

      const snapshotStartedAt=this.clock();
      const rows=fetchedRows.map(row=>({...row,_schedulerFast:this.updateFastSnapshot(row,fastSeenAt),_fastSeenAt:fastSeenAt}));
      metrics.fast_snapshot_ms=Math.max(0,this.clock()-snapshotStartedAt);
      metrics.fast_symbols=rows.length;
      for(const row of rows)this.scheduler.ensureQueued('DEEP',row.symbol,fastSeenAt);

      const selectionStartedAt=this.clock();
      selected=this.selectBatch(rows,fastSeenAt);
      metrics.fast_selection_ms=Math.max(0,this.clock()-selectionStartedAt);
      metrics.fast_scan_ms=metrics.fast_snapshot_ms+metrics.fast_selection_ms;
      metrics.data_collection_ms=metrics.universe_refresh_ms+metrics.ticker_collection_ms;
      metrics.deep_selected=selected.length;
      metrics.unique_selected_symbols=new Set(selected.map(x=>String(x.symbol||'').toUpperCase())).size;
      metrics.duplicate_selected_count=selected.length-metrics.unique_selected_symbols;
      metrics.selected_symbols=selected.map(x=>String(x.symbol||'').toUpperCase());
      metrics.selection_distribution=selected.reduce((out,row)=>{
        const lane=row._selection_lane||'unknown';out[lane]=(out[lane]||0)+1;return out;
      },{});
      metrics.quiet_selected_count=Number(metrics.selection_distribution.quiet)||0;
      metrics.exceptional_selected_count=Number(metrics.selection_distribution.exceptional)||0;
      const selectedSymbols=new Set(metrics.selected_symbols);

      for(const row of rows){
        const symbol=String(row.symbol).toUpperCase();
        const fast=row._schedulerFast||{};
        const fastSnapshot={last_price:row.lastPrice,quote_volume_24h:row.quoteVolume24h,
          trade_count_24h:row.tradeCount24h,volume_accel_ratio:fast.volume_accel_ratio??null,
          trade_accel_ratio:fast.trade_accel_ratio??null,price_acceleration_pct:fast.price_acceleration_pct??null};
        this.scheduler.record({stage:'FAST',symbol:row.symbol,eventType:'COMPLETED',cycle:metrics.cycle,
          at:fastSeenAt,queuedAt:collectionStartedAt,startedAt:collectionStartedAt,
          elapsedMs:metrics.ticker_collection_ms,fastSeenAt,
          reasonCode:'RADAR9_FAST_TICKER_SNAPSHOT_RECEIVED',extra:fastSnapshot});
        if(!selectedSymbols.has(symbol)){
          const reason=row._exceptional?'EXCEPTIONAL_FAST_PATH_CAPACITY':row._quiet?'QUIET_ANCHOR_CAPACITY':'OVERDUE_ROTATION_CAPACITY';
          this.scheduler.defer('DEEP',symbol,{cycle:metrics.cycle,at:fastSeenAt,fastSeenAt,reasonCode:reason,
            extra:{lane:'deferred',fast_snapshot:fastSnapshot}});
        }
      }
      this.scheduler.record({stage:'FAST',eventType:'CYCLE_COMPLETE',cycle:metrics.cycle,at:fastSeenAt,
        elapsedMs:metrics.ticker_collection_ms,reasonCode:'RADAR9_TICKER_SNAPSHOT_RECEIVED',
        extra:{symbols_total:rows.length,data_collection_ms:metrics.data_collection_ms,
          fast_snapshot_ms:metrics.fast_snapshot_ms,selection_ms:metrics.fast_selection_ms}});
      for(const row of selected){
        const symbol=String(row.symbol).toUpperCase(),lane=row._selection_lane||'anchor',fast=row._schedulerFast||{};
        this.scheduler.selected('DEEP',symbol,{cycle:metrics.cycle,at:fastSeenAt,lane,
          reasonCode:schedulerLaneReason(lane,'DEEP'),fastSeenAt,
          extra:{fast_snapshot:{last_price:row.lastPrice,quote_volume_24h:row.quoteVolume24h,
            trade_count_24h:row.tradeCount24h}}});
      }

      let nextIndex=0;
      const concurrency=Math.min(selected.length||1,5,Math.max(1,Math.trunc(Number(this.config.deepConcurrency)||5)));
      metrics.deep_concurrency=concurrency;
      this.lastRowTimings.clear();
      const deepStartedAt=this.clock();
      const worker=async()=>{
        for(;;){
          const index=nextIndex++;
          if(index>=selected.length)return;
          const row=selected[index];
          const symbol=String(row.symbol).toUpperCase();
          const lane=row._selection_lane||'anchor';
          const startedAt=this.clock();
          const scheduledStart=this.scheduler.started('DEEP',symbol,{cycle:metrics.cycle,at:startedAt,lane,
            reasonCode:schedulerLaneReason(lane,'DEEP'),fastSeenAt,
            extra:{fast_snapshot:{last_price:row.lastPrice,quote_volume_24h:row.quoteVolume24h,
              trade_count_24h:row.tradeCount24h}}});
          metrics.deep_wait_ms.push(scheduledStart.wait_ms);
          metrics.deep_attempted++;
          try{
            const result=await this.scanRow(row);
            const outcomeTiming=this.lastRowTimings.get(symbol)||{};
            metrics.deep_row_time_sum_ms+=Number(outcomeTiming.row_total_ms)||0;
            metrics.deep_data_fetch_sum_ms+=Number(outcomeTiming.data_fetch_ms)||0;
            metrics.signal_analysis_sum_ms+=Number(outcomeTiming.signal_analysis_ms)||0;
            metrics.signal_archive_write_ms+=Number(outcomeTiming.signal_archive_write_ms)||0;
            metrics.result_send_ms+=Number(outcomeTiming.result_send_ms)||0;
            const a=result?.whale_accumulation||{};
            const stage=String(a.stage||result?.potential_label||'').toUpperCase();
            const dataIncomplete=!result||['DATA_INSUFFICIENT','INCOMPLETE','WARMING_UP'].includes(stage)||
              result?.data_status==='INCOMPLETE'||result?.data_status==='DATA_UNAVAILABLE';
            this.scheduler.finished('DEEP',symbol,{cycle:metrics.cycle,at:this.clock(),startedAt,
              outcome:dataIncomplete?'INCOMPLETE':'COMPLETED',lane,
              reasonCode:dataIncomplete?'DATA_MISSING_OR_NOT_MATURE':result?.eligible?'SIGNAL_CONFIRMED':'NO_SIGNAL_NOT_A_FAILURE',
              failureCounted:false,fastSeenAt,
              extra:{signal_eligible:Boolean(result?.eligible),signal_stage:stage||null,data_complete:!dataIncomplete,
                row_timings_ms:outcomeTiming}});
            if(dataIncomplete)metrics.incomplete++;else metrics.deep_completed++;
          }catch(e){
            const outcomeTiming=this.lastRowTimings.get(symbol)||{};
            metrics.deep_row_time_sum_ms+=Number(outcomeTiming.row_total_ms)||0;
            metrics.deep_data_fetch_sum_ms+=Number(outcomeTiming.data_fetch_ms)||0;
            metrics.signal_analysis_sum_ms+=Number(outcomeTiming.signal_analysis_ms)||0;
            metrics.signal_archive_write_ms+=Number(outcomeTiming.signal_archive_write_ms)||0;
            metrics.result_send_ms+=Number(outcomeTiming.result_send_ms)||0;
            metrics.failed++;
            this.lastError=String(e?.message??e);
            this.logger.warn?.('[RADARX_RADAR9_SCAN_FAILED] '+JSON.stringify({
              cycle:metrics.cycle,symbol,error:String(e?.message??e),stack:e?.stack||null
            }));
            this.scheduler.finished('DEEP',symbol,{cycle:metrics.cycle,at:this.clock(),startedAt,outcome:'FAILED',lane,
              reasonCode:'RADAR9_SCAN_EXCEPTION',failureCounted:true,fastSeenAt,
              extra:{error:String(e?.message??e),row_timings_ms:outcomeTiming}});
          }
        }
      };
      const workers=Array.from({length:Math.min(concurrency,selected.length)},()=>worker());
      await Promise.all(workers);
      metrics.deep_scan_wall_ms=Math.max(0,this.clock()-deepStartedAt);
      metrics.unattempted=Math.max(0,selected.length-metrics.deep_attempted);
      this.cursor=(this.cursor+Math.max(1,metrics.deep_attempted))%Math.max(1,this.universe.length);
      const cycleCompletedAt=this.clock();
      this.lastCoverage={
        cycle:metrics.cycle,universe_total:rows.length,batch_size:selected.length,
        scanned_successfully:metrics.deep_completed,failed:metrics.failed,rotation_cursor:this.cursor,
        candidates_retained:this.latestCandidates.length,last_scan_at:cycleCompletedAt,
        deep_attempted:metrics.deep_attempted,incomplete:metrics.incomplete,unattempted:metrics.unattempted
      };
      this.lastScanAtMs=cycleCompletedAt;
      this.lastSelectionDistribution={...metrics.selection_distribution};
      this.lastError=metrics.failed?this.lastError:null;
    }catch(error){
      cycleError=error;
      this.lastError=String(error?.message??error);
      metrics.cycle_error=this.lastError;
      this.logger.warn?.('[RADARX_RADAR9_CYCLE_ERROR] '+JSON.stringify({cycle:metrics.cycle,error:this.lastError}));
    }finally{
      metrics.coalesced_tick_count=this.coalescedTickCount;
      metrics.pending_tick_age_ms=this.pendingTickAt===null?0:Math.max(0,this.clock()-this.pendingTickAt);
      const firstFlushStartedAt=this.clock();
      const firstFlush=await this.scheduler.flush();
      metrics.scheduler_archive_write_ms=Math.max(0,this.clock()-firstFlushStartedAt);
      metrics.scheduler_archive_events_written=Number(firstFlush?.written)||0;
      metrics.cycle_duration_ms=Math.max(0,this.clock()-cycleStartedAt);
      metrics.cycle_overrun_ms=Math.max(0,metrics.cycle_duration_ms-pollMs);
      metrics.ended_at=new Date(this.clock()).toISOString();
      this.scheduler.record({stage:'CYCLE',eventType:'COMPLETED',cycle:metrics.cycle,at:this.clock(),
        elapsedMs:metrics.cycle_duration_ms,reasonCode:'RADAR9_CYCLE_TIMINGS',
        extra:{...metrics,cycle_error:cycleError?this.lastError:null}});
      const summaryFlushStartedAt=this.clock();
      const summaryFlush=await this.scheduler.flush();
      metrics.scheduler_archive_write_ms+=Math.max(0,this.clock()-summaryFlushStartedAt);
      metrics.scheduler_archive_events_written+=Number(summaryFlush?.written)||0;
      metrics.cycle_duration_ms=Math.max(0,this.clock()-cycleStartedAt);
      metrics.cycle_overrun_ms=Math.max(0,metrics.cycle_duration_ms-pollMs);
      metrics.ended_at=new Date(this.clock()).toISOString();
      this.logger.info?.('[RADARX_SCHEDULER_REPORT] '+JSON.stringify({
        ...metrics,
        deep_selected:selected.length,
        deep_completed:metrics.deep_completed,
        incomplete:metrics.incomplete,
        failed:metrics.failed,
        unique_selected_symbols:metrics.unique_selected_symbols,
        duplicate_selected_count:metrics.duplicate_selected_count,
        quiet_selected_total:metrics.quiet_selected_count,
        exceptional_bypass_total:metrics.exceptional_selected_count,
        paper_trading:true,real_order_execution:false
      }));
      this.busy=false;
      const shouldRunPending=this.running&&this.pendingTick;
      const pendingAt=this.pendingTickAt;
      this.pendingTick=false;
      this.pendingTickAt=null;
      this.coalescedTickCount=0;
      if(shouldRunPending){
        this.nextCyclePendingWaitMs=pendingAt===null?0:Math.max(0,this.clock()-pendingAt);
        queueMicrotask(()=>this.tick().catch(error=>{
          this.lastError=String(error?.message??error);
          this.logger.warn?.('[RADARX_RADAR9_PENDING_CYCLE_FAILED] '+JSON.stringify({error:this.lastError}));
        }));
      }
    }
  }
  snapshot(limit=20){
    const rows=this.latestCandidates.slice(0,Math.max(1,Math.min(50,Number(limit)||20)));
    const confirmed=rows.filter(x=>x.eligible);
    return {
      radar:'WHALE_ACCUMULATION_RADAR',radar_name:'🐋 تجمع الحيتان',quote:this.config.quote,
      as_of:this.lastScanAtMs?new Date(this.lastScanAtMs).toISOString():null,running:this.running,busy:this.busy,
      candidates:rows.map(x=>({...x,report:x.whale_accumulation||null})),
      confirmed_count:confirmed.length,alerts_emitted:this.alertCount,
      coverage:this.lastCoverage,last_error:this.lastError,
      methodology:{
        large_trade_source:'Binance Public /api/v3/aggTrades',
        orderbook_source:'Binance Public /api/v3/depth',
        closed_candles_only:true,
        whale_identity:'NOT_AVAILABLE',
        interpretation:'Large-order accumulation footprint, not identity attribution.'
      },
      report:{
        title:'تقرير تجمع الحيتان',
        what_it_measures:['صفقات كبيرة متكررة','صافي قيمة شراء كبيرة','تسارع الطباعة الكبيرة','امتصاص السعر','اختلال عمق الطلب','استمرارية الدعم','تأكد 5m'],
        thresholds:this.config
      },
      meta:{live:this.running,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',source:'Binance Public REST'}
    };
  }
  health(){
    return {
      running:this.running,busy:this.busy,radar:'WHALE_ACCUMULATION_RADAR',radar_name:'🐋 تجمع الحيتان',
      universe:this.universe.length,last_scan_at:this.lastScanAtMs,scans:this.scans,alerts_emitted:this.alertCount,
      retained_candidates:this.latestCandidates.length,last_error:this.lastError,coverage:this.lastCoverage,
      source:'Binance Public REST (/aggTrades + /depth + /klines)',closed_candles_only:true,
      paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
    };
  }
}
