import {buildSpotUniverse,normalizeTickerRow} from '../market/universe-scanner.mjs';
import {formatRadarTime12h,decorateRadarAlert} from './radar-alert-meta.mjs';
import {evaluateEliteGate} from './elite-confluence-gate.mjs';

const clamp=(x,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number(x)));
const finite=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const mean=xs=>{const a=xs.filter(Number.isFinite);return a.length?a.reduce((s,x)=>s+x,0)/a.length:null};
const median=xs=>{const a=xs.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2};
const pct=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&b>0?(a-b)/b*100:null;

function closed(rows,now){
  return (Array.isArray(rows)?rows:[]).filter(c=>
    c?.closed!==false&&Number.isFinite(Number(c?.openTime))&&Number.isFinite(Number(c?.closeTime))&&Number(c.closeTime)<=now&&
    Number(c.open)>0&&Number(c.high)>=Number(c.low)&&Number(c.low)>0&&Number(c.close)>0&&Number(c.volume)>=0
  ).sort((a,b)=>Number(a.openTime)-Number(b.openTime));
}
function vwap(rows){
  let den=0,num=0;
  for(const c of rows){
    const vol=Math.max(0,Number(c.volume)||0);
    const tp=(Number(c.high)+Number(c.low)+Number(c.close))/3;
    den+=vol;num+=tp*vol;
  }
  return den>0?num/den:null;
}
function trueRanges(rows){
  const out=[];
  for(let i=1;i<rows.length;i++){
    const h=Number(rows[i].high),l=Number(rows[i].low),pc=Number(rows[i-1].close);
    out.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  return out;
}
function topDepth(book,mid,bps){
  if(!book||!Number.isFinite(mid)||mid<=0)return {bid:0,ask:0,total:0,imbalance:0};
  const band=mid*bps/10000;
  const sum=(levels,side)=> (Array.isArray(levels)?levels:[]).reduce((s,l)=>{
    const p=Number(l?.[0]),q=Number(l?.[1]);
    if(!Number.isFinite(p)||!Number.isFinite(q)||p<=0||q<0)return s;
    const ok=side==='bid'?p>=mid-band:p<=mid+band;
    return ok?s+(p*q):s;
  },0);
  const bid=sum(book.bids,'bid'),ask=sum(book.asks,'ask'),total=bid+ask;
  return {bid,ask,total,imbalance:total>0?(bid-ask)/total:0};
}
function weightedDepth(book,mid){
  const a=topDepth(book,mid,5),b=topDepth(book,mid,15),c=topDepth(book,mid,30);
  const weighted=(a.imbalance*.50+b.imbalance*.30+c.imbalance*.20);
  return {near:a,medium:b,wide:c,weightedImbalance:weighted};
}
function spreadBps(book){
  const bid=Number(book?.bids?.[0]?.[0]),ask=Number(book?.asks?.[0]?.[0]);
  return Number.isFinite(bid)&&Number.isFinite(ask)&&ask>=bid&&bid>0?((ask-bid)/((ask+bid)/2))*10000:null;
}
function sellerAbsorption(rows){
  const recent=rows.slice(-6),base=rows.slice(-36,-6);
  const rVol=mean(recent.map(x=>Number(x.volume))),bVol=median(base.map(x=>Number(x.volume)));
  const volumeRatio=Number.isFinite(rVol)&&Number.isFinite(bVol)&&bVol>0?rVol/bVol:null;
  const netMove=Math.abs(pct(Number(recent.at(-1)?.close),Number(recent[0]?.open))||0);
  const bodyMove=mean(recent.map(x=>Math.abs(pct(Number(x.close),Number(x.open))||0)));
  const lowerWick=mean(recent.map(x=>{
    const o=Number(x.open),c=Number(x.close),l=Number(x.low);
    return Math.max(0,Math.min(o,c)-l)/(Math.max(Math.abs(o-c),0.0000001));
  }));
  const buy=recent.reduce((s,x)=>s+Math.max(0,Number(x.takerBuyBaseVolume)||0),0);
  const vol=recent.reduce((s,x)=>s+Math.max(0,Number(x.volume)||0),0);
  const buyRatio=vol>0?buy/vol:null;
  const lowMoveScore=clamp(100-Math.min(100,netMove*20));
  const bodyScore=clamp(100-Math.min(100,bodyMove*35));
  const volScore=Number.isFinite(volumeRatio)?clamp(45+(volumeRatio-1)*32):45;
  const wickScore=Number.isFinite(lowerWick)?clamp(lowerWick*38):45;
  const flowScore=Number.isFinite(buyRatio)?clamp(50+(buyRatio-.5)*260):45;
  const score=clamp(volScore*.25+lowMoveScore*.20+bodyScore*.12+wickScore*.13+flowScore*.30);
  return {score,volumeRatio,netMovePct:netMove,avgBodyMovePct:bodyMove,lowerWick,buyRatio};
}
function localStructure(rows){
  if(rows.length<16)return {score:0,higherLow:false,reclaim:false,rangeBreak:false};
  const closes=rows.map(x=>Number(x.close)), highs=rows.map(x=>Number(x.high)), lows=rows.map(x=>Number(x.low));
  const priorHigh=Math.max(...highs.slice(-13,-1)),priorLow=Math.min(...lows.slice(-13,-1)),last=closes.at(-1);
  const prevLows=lows.slice(-9,-3),recentLow=Math.min(...lows.slice(-3));
  const higherLow=recentLow>Math.min(...prevLows);
  const reclaim=last>Math.max(...closes.slice(-7,-2));
  const rangeBreak=last>=priorHigh;
  return {score:clamp((higherLow?78:42)*.42+(reclaim?88:45)*.33+(rangeBreak?92:48)*.25),higherLow,reclaim,rangeBreak};
}
function microDislocation(rows){
  const recent=rows.slice(-8),base=rows.slice(-40,-8);
  const recentRange=mean(recent.map(x=>Math.abs(pct(Number(x.high),Number(x.low))||0)));
  const baseRange=median(base.map(x=>Math.abs(pct(Number(x.high),Number(x.low))||0)));
  const return8=Math.abs(pct(Number(recent.at(-1)?.close),Number(recent[0]?.open))||0);
  const path=recent.reduce((s,x)=>s+Math.abs(pct(Number(x.close),Number(x.open))||0),0);
  const efficiency=path>0?return8/path:0;
  const compression=Number.isFinite(recentRange)&&Number.isFinite(baseRange)&&baseRange>0?recentRange/baseRange:null;
  return {compressionRatio:compression,efficiency,score:clamp((Number.isFinite(compression)?100-Math.min(100,Math.max(0,compression-1)*180):50)*.52+(Number.isFinite(efficiency)?100-efficiency*80:50)*.48)};
}
function trappedSellers(rows){
  const recent=rows.slice(-7);
  const lows=recent.map(x=>Number(x.low)),closes=recent.map(x=>Number(x.close));
  const rangeLow=Math.min(...lows),last=closes.at(-1),rangeHigh=Math.max(...recent.map(x=>Number(x.high)));
  const position=rangeHigh>rangeLow?(last-rangeLow)/(rangeHigh-rangeLow):0.5;
  const red=recent.filter(x=>Number(x.close)<Number(x.open)).length;
  const recovery=Number.isFinite(position)&&position>=.62;
  const sellerCount=red>=4;
  return {score:clamp((sellerCount?80:45)*.35+(recovery?90:45)*.65),redCount:red,recovery,rangePosition:position*100};
}
function depthOpportunity(book,price){
  const d=weightedDepth(book,price);
  const spread=spreadBps(book);
  const imbalanceScore=clamp(50+d.weightedImbalance*120);
  const spreadScore=Number.isFinite(spread)?clamp(100-spread*7):40;
  const askVacuum=d.near.ask>0?clamp(50+(1-d.near.ask/Math.max(d.wide.ask,1))*90):40;
  const bidSupport=d.near.bid>0?clamp(50+(1-d.near.bid/Math.max(d.wide.bid,1))*25):40;
  return {score:clamp(imbalanceScore*.42+spreadScore*.23+askVacuum*.20+bidSupport*.15),spreadBps:spread,imbalance:d.weightedImbalance,nearBid:d.near.bid,nearAsk:d.near.ask};
}
function auctionBalance(rows){
  const recent=rows.slice(-20),vw=vwap(recent),last=Number(recent.at(-1)?.close);
  const dev=Number.isFinite(vw)&&vw>0?Math.abs((last-vw)/vw*100):null;
  const atr=mean(trueRanges(recent).slice(-14));
  const ranges=recent.map(x=>Number(x.high)-Number(x.low));
  const avgR=mean(ranges),latestR=ranges.at(-1);
  const balance=Number.isFinite(dev)?clamp(100-dev*45):50;
  const rangeScore=Number.isFinite(avgR)&&avgR>0&&Number.isFinite(latestR)?clamp(100-(latestR/avgR)*65):50;
  return {score:clamp(balance*.65+rangeScore*.35),vwap:vw,deviationPct:dev,latestRangeRatio:Number.isFinite(avgR)&&avgR>0?latestR/avgR:null};
}

export function buildLiquidityAbsorptionAnalysis(oneM,fiveM,ticker,book,now=Date.now()){
  const a=closed(oneM,now),b=closed(fiveM,now);
  if(a.length<60||b.length<24){
    return {eligible:false,stage:'INSUFFICIENT_DATA',score:null,closed_candles_only:true};
  }
  const price=finite(ticker?.lastPrice,null);
  const absorption=sellerAbsorption(a);
  const structure=localStructure(a);
  const dislocation=microDislocation(a);
  const trapped=trappedSellers(a);
  const depth=depthOpportunity(book,price);
  const auction=auctionBalance(a);
  const fiveReturn=pct(Number(b.at(-1)?.close),Number(b.at(-4)?.close));
  const fiveBias=Number.isFinite(fiveReturn)?clamp(50+fiveReturn*34):45;

  const confirmations=[
    absorption.score>=76,
    absorption.volumeRatio>=1.55&&absorption.netMovePct<=1.15,
    absorption.buyRatio>=0.52,
    structure.higherLow||structure.reclaim,
    trapped.score>=72,
    depth.imbalance>=0.10,
    depth.spreadBps!==null&&depth.spreadBps<=12,
    auction.score>=68,
    dislocation.score>=70,
    fiveBias>=55
  ];
  const confirmationCount=confirmations.filter(Boolean).length;
  const extended24h=Math.abs(Number(ticker?.priceChange24h)||0)>=7.5;
  const microMove=Math.abs(Number(absorption.netMovePct)||0);
  const score=clamp(
    absorption.score*.22+
    depth.score*.22+
    trapped.score*.13+
    structure.score*.11+
    dislocation.score*.10+
    auction.score*.10+
    fiveBias*.05+
    (extended24h?25:78)*.05+
    (microMove<=1.15?85:40)*.02
  );
  const eligible=!extended24h&&price>0&&
    score>=83&&confirmationCount>=6&&
    absorption.score>=76&&
    absorption.volumeRatio>=1.55&&
    absorption.netMovePct<=1.15&&
    depth.score>=70&&depth.spreadBps<=12&&
    depth.imbalance>=0.10&&
    liquiditySafe(ticker)&&
    !Number.isNaN(score);

  const reasons=[];
  const push=(ok,s)=>{if(ok)reasons.push(s)};
  push(absorption.score>=76,'امتصاص بيع بحجم مرتفع وحركة سعرية محدودة');
  push(absorption.volumeRatio>=1.55,'الحجم أعلى من خط الأساس');
  push(absorption.buyRatio>=0.52,'Taker Buy يميل للشراء');
  push(structure.higherLow,'قاع أعلى داخل البنية الدقيقة');
  push(structure.reclaim,'استرداد نطاق قصير');
  push(trapped.score>=72,'تحسن وضع البائعين العالقين');
  push(depth.imbalance>=0.10,'اختلال عمق لصالح الطلب');
  push(depth.spreadBps!==null&&depth.spreadBps<=12,'سبريد ضيق');
  push(auction.score>=68,'توازن مزاد قريب من القيمة');
  push(dislocation.score>=70,'انفصال حجم/حركة قابل للامتصاص');
  push(fiveBias>=55,'تأكيد اتجاه 5m');
  if(extended24h)reasons.push('رفض: الحركة اليومية ممتدة');

  const stage=score>=90?'ABSORPTION_CONFIRMED':score>=84?'LIQUIDITY_WAKE':'MICROSTRUCTURE_WATCH';
  return {
    eligible,stage,score:Math.round(score*10)/10,closed_candles_only:true,
    confirmation_count:confirmationCount,confirmation_total:confirmations.length,
    algorithms:{
      SELLER_ABSORPTION:absorption,
      DEPTH_IMBALANCE_VACUUM:depth,
      TRAPPED_SELLER_RELEASE:trapped,
      MICROSTRUCTURE_DISLOCATION:dislocation,
      LOCAL_AUCTION_BALANCE:auction,
      FRACTAL_MICRO_STRUCTURE:structure,
      FIVE_MINUTE_CONFIRMATION:{returnPct:fiveReturn,score:fiveBias}
    },
    metrics:{
      absorption_score:absorption.score,depth_score:depth.score,trapped_seller_score:trapped.score,
      dislocation_score:dislocation.score,auction_score:auction.score,structure_score:structure.score,
      depth_imbalance:depth.imbalance,spread_bps:depth.spreadBps,taker_buy_ratio:absorption.buyRatio,
      volume_ratio:absorption.volumeRatio,net_move_pct:absorption.netMovePct,micro_move_pct:microMove,
      vwap:auction.vwap,vwap_deviation_pct:auction.deviationPct
    },
    trigger:{
      min_score:83,min_confirmations:6,min_absorption_score:76,
      min_volume_ratio:1.55,max_net_move_pct:1.15,min_depth_imbalance:0.10,max_spread_bps:12,max_24h_abs_move_pct:7.5
    },
    reasons:[...new Set(reasons)].slice(0,12),
    risk_flags:[
      extended24h?'24H_EXTENDED':null,
      depth.spreadBps!==null&&depth.spreadBps>8?'SPREAD_ATTENTION':null,
      depth.imbalance<0?'ASK_PRESSURE_HIGH':null
    ].filter(Boolean),
    source:'Binance Public REST',
    detected_at:now,processed_at:now,
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
  };
}
function liquiditySafe(ticker){
  const q=Number(ticker?.quoteVolume24h);
  return Number.isFinite(q)&&q>=1500000;
}

export function buildLiquidityAbsorptionAlert(candidate,now=Date.now()){
  const a=buildLiquidityAbsorptionAnalysis(candidate.one_minute,candidate.five_minute,candidate.ticker,candidate.book,now);
  const ticker=candidate.ticker||{};
  const alert={
    id:'LIQ4:'+String(ticker.symbol||'UNKNOWN').toUpperCase()+':'+now,
    event:'LIQUIDITY_ABSORPTION_ALERT',
    radar:'LIQUIDITY_ABSORPTION_RADAR',
    radar_name:'Radar 4 — Liquidity Absorption',
    symbol:String(ticker.symbol||'UNKNOWN').toUpperCase(),
    market:'SPOT',
    direction:'UP_SETUP',
    price:finite(ticker.lastPrice),
    price_change_24h:finite(ticker.priceChange24h),
    opportunity_score:a.score,
    potential_label:a.stage,
    liquidity_absorption:a,
    reasons:a.reasons,
    risk_flags:a.risk_flags,
    source:a.source,
    detected_at:now,processed_at:now,
    detected_at_iso:new Date(now).toISOString(),
    detected_time_12h:formatRadarTime12h(now),
    detected_timezone:'Asia/Aden',
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
    eligible:a.eligible,
    disclaimer:'رادار 4 لا يلاحق القفزة السعرية؛ يبحث عن امتصاص البيع واختلال السيولة وبداية تحسن بنية السوق. النتائج مراقبة فقط وليست ضمانًا.'
  };
  return decorateRadarAlert(alert,'Radar 4 — الكاسح');
}

export class LiquidityAbsorptionRadar{
  constructor({rest,store,pushManager=null,config={},clock=()=>Date.now(),logger=console}={}){
    if(!rest)throw new Error('REST_CLIENT_REQUIRED');
    if(!store)throw new Error('STORE_REQUIRED');
    this.rest=rest;this.store=store;this.pushManager=pushManager;this.clock=clock;this.logger=logger;
    this.config={
      quote:'USDT',pollMs:45000,universeRefreshMs:5*60*1000,
      minQuoteVolume24h:1500000,rotationBatchSize:4,topLiquidityCount:3,
      alertCooldownMs:20*60*1000,minScore:83,minConfirmations:6,
      ...config
    };
    this.running=false;this.timer=null;this.universe=[];this.universeAt=0;this.cursor=0;
    this.lastScanAt=new Map();this.lastAlertAt=new Map();this.alertCount=0;this.scans=0;this.lastError=null;this.lastScanAtMs=null;this.busy=false;
  }
  start(){
    if(this.running)return;
    this.running=true;
    this.timer=setInterval(()=>this.tick().catch(e=>{
      this.lastError=String(e?.message??e);
      this.logger.warn?.('LIQUIDITY_ABSORPTION',this.lastError);
    }),this.config.pollMs);
    this.refreshUniverse()
      .then(()=>this.tick())
      .catch(e=>{
        this.lastError=String(e?.message??e);
        this.logger.warn?.('LIQUIDITY_ABSORPTION_BOOTSTRAP',this.lastError);
      });
  }
  async stop(){this.running=false;if(this.timer)clearInterval(this.timer);this.timer=null;}
  async refreshUniverse(){
    const r=await this.rest.request('/api/v3/exchangeInfo');
    this.universe=buildSpotUniverse(r.data,this.config.quote).map(x=>x.symbol);
    this.universeAt=this.clock();this.cursor=0;
  }
  async tickerRows(){
    const r=await this.rest.request('/api/v3/ticker/24hr');
    return (Array.isArray(r.data)?r.data:[]).map(x=>normalizeTickerRow(x,this.config.quote)).filter(Boolean)
      .filter(x=>this.universe.includes(x.symbol)&&x.quoteVolume24h>=this.config.minQuoteVolume24h);
  }
  selectBatch(rows){
    const ranked=[...rows].sort((a,b)=>b.quoteVolume24h-a.quoteVolume24h||Math.abs(a.priceChange24h)-Math.abs(b.priceChange24h));
    const selected=ranked.slice(0,Math.max(1,Number(this.config.topLiquidityCount)||3));
    for(let i=0;i<Math.max(1,Number(this.config.rotationBatchSize)||4)&&this.universe.length;i++){
      const sym=this.universe[this.cursor%this.universe.length];this.cursor=(this.cursor+1)%this.universe.length;
      const row=rows.find(x=>x.symbol===sym);if(row)selected.push(row);
    }
    return [...new Map(selected.map(x=>[x.symbol,x])).values()];
  }
  async scanRow(row){
    const last=this.lastScanAt.get(row.symbol)||0;
    if(this.clock()-last<Math.max(15000,Number(this.config.pollMs)*.7))return null;
    this.lastScanAt.set(row.symbol,this.clock());
    const [one,five,depth]=await Promise.all([
      this.rest.klines(row.symbol,'1m',{limit:120}),
      this.rest.klines(row.symbol,'5m',{limit:40}),
      this.rest.depth(row.symbol,100)
    ]);
    const analysis=buildLiquidityAbsorptionAlert({
      ticker:row,one_minute:one.candles,five_minute:five.candles,book:depth.data
    },this.clock());
    this.scans++;
    const a=analysis.liquidity_absorption||analysis.liquidityAbsorption||{};
    const cs=a.component_scores||a.algorithms||{};
    const m=a.metrics||{};
    const gate=evaluateEliteGate({
      radar:'LIQUIDITY_ABSORPTION_RADAR',
      direction:a.direction||'UP_ROTATION',
      baseScore:Number(analysis.opportunity_score)||0,
      priceChange24h:row.priceChange24h,
      liquidityScore:Math.min(100,60+Math.log10(Math.max(1,row.quoteVolume24h/1500000))*35),
      dataQualityScore:90,
      triggerScore:Math.max(Number(cs.absorption)||0,Number(cs.absorption_score)||0),
      structureScore:Math.max(Number(cs.structure)||0,Number(cs.structure_score)||0,Number(cs.local_structure)||0),
      participationScore:Number(cs.silent_volume)||Number(cs.absorption)||Number(m.volume_score)||50,
      flowScore:Math.max(Number(cs.depth)||0,Number(cs.depth_imbalance)||0,Number(m.depth_score)||0),
      relativeScore:Number(cs.five_minute_confirmation)||Number(m.five_bias)||50,
      momentumScore:Math.max(Number(cs.trapped_seller)||0,Number(cs.dislocation)||0),
      compressionScore:Math.max(Number(cs.auction)||0,Number(cs.compression)||0),
      confirmations:Number(analysis.liquidity_absorption?.confirmation_count ?? analysis.confirmation_count)||0,
      minConfirmations:7,minScore:90,max24hMovePct:5.5,requireTrigger:true,minCategoryHits:5
    });
    analysis.elite_gate=gate;
    if(!analysis.eligible||Number(analysis.opportunity_score)<this.config.minScore||!gate.eligible)return analysis;
    const lastAlert=this.lastAlertAt.get(row.symbol)||0;
    if(this.clock()-lastAlert<this.config.alertCooldownMs)return analysis;
    this.lastAlertAt.set(row.symbol,this.clock());
    await this.store.appendLiquidityAbsorptionAlert(analysis);
    if(this.pushManager?.notifyRadarAlert)await this.pushManager.notifyRadarAlert(analysis);
    this.alertCount++;
    return analysis;
  }
  async tick(){
    if(!this.running||this.busy)return;
    this.busy=true;
    try{
      if(this.clock()-this.universeAt>this.config.universeRefreshMs)await this.refreshUniverse();
      const rows=await this.tickerRows();
      const selected=this.selectBatch(rows);
      this.lastScanAtMs=this.clock();
      for(const row of selected){if(!this.running)break;try{await this.scanRow(row);}catch(e){this.lastError=String(e?.message??e)}}
    }finally{this.busy=false;}
  }
  health(){
    return {
      running:this.running,radar:'LIQUIDITY_ABSORPTION_RADAR',radar_name:'Radar 4 — Liquidity Absorption',
      universe:this.universe.length,last_universe_refresh_at:this.universeAt||null,last_scan_at:this.lastScanAtMs,
      scans:this.scans,alerts_emitted:this.alertCount,last_error:this.lastError,busy:this.busy,rest:this.rest?.health?.()||null,
      algorithms:['SELLER_ABSORPTION','DEPTH_IMBALANCE_VACUUM','TRAPPED_SELLER_RELEASE','MICROSTRUCTURE_DISLOCATION','LOCAL_AUCTION_BALANCE','FRACTAL_MICRO_STRUCTURE','FIVE_MINUTE_CONFIRMATION'],
      source:'Binance Public REST',closed_candles_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
    };
  }
}
