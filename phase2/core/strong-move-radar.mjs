import {buildSpotUniverse,normalizeTickerRow} from '../market/universe-scanner.mjs';
import {decorateRadarAlert} from './radar-alert-meta.mjs';
import {evaluateEliteGate} from './elite-confluence-gate.mjs';

const clamp=(x,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number(x)));
const finite=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const mean=xs=>{const a=xs.filter(Number.isFinite);return a.length?a.reduce((s,x)=>s+x,0)/a.length:null};
const median=xs=>{const a=xs.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2};
const pct=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&b>0?(a-b)/b*100:null;

function closedCandles(rows,now){
  return (Array.isArray(rows)?rows:[]).filter(c=>
    c?.closed!==false&&Number.isFinite(Number(c?.openTime))&&Number.isFinite(Number(c?.closeTime))&&
    Number(c.closeTime)<=now&&Number.isFinite(Number(c?.open))&&Number.isFinite(Number(c?.high))&&
    Number.isFinite(Number(c?.low))&&Number.isFinite(Number(c?.close))&&Number.isFinite(Number(c?.volume))&&
    Number(c.high)>=Number(c.low)&&Number(c.low)>0
  ).sort((a,b)=>Number(a.openTime)-Number(b.openTime));
}

function ema(xs,p){
  const a=xs.filter(Number.isFinite);if(!a.length)return null;
  const n=Math.max(2,Math.trunc(p));let out=mean(a.slice(0,Math.min(n,a.length)));
  const alpha=2/(n+1);
  for(const x of a.slice(Math.min(n,a.length)))out=alpha*x+(1-alpha)*out;
  return out;
}

function stdev(xs){
  const a=xs.filter(Number.isFinite);if(a.length<2)return null;
  const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)));
}

export function buildStrongMoveAnalysis(oneM,fiveM,ticker,now){
  const a=closedCandles(oneM,now),b=closedCandles(fiveM,now);
  if(a.length<40||b.length<20){
    return {eligible:false,stage:'INSUFFICIENT_DATA',score:null,closed_candles_only:true,one_minute_count:a.length,five_minute_count:b.length};
  }

  const closes=a.map(x=>Number(x.close));
  const last=a.at(-1),prev=a.at(-2);
  const lastClose=Number(last.close);
  const r1=pct(lastClose,Number(a.at(-2)?.close));
  const r3=pct(lastClose,Number(a.at(-4)?.close));
  const r5=pct(lastClose,Number(a.at(-6)?.close));
  const r10=pct(lastClose,Number(a.at(-11)?.close));
  const r20=pct(lastClose,Number(a.at(-21)?.close));
  const prev3=pct(Number(a.at(-4)?.close),Number(a.at(-7)?.close));
  const accel=Number.isFinite(r3)&&Number.isFinite(prev3)?r3-prev3:null;
  const priorMicroHigh=Math.max(...a.slice(-21,-1).map(x=>Number(x.high)).filter(Number.isFinite));
  const microBreak=Number.isFinite(priorMicroHigh)&&lastClose>=priorMicroHigh;
  const closeLocation=Number(last.high)>Number(last.low)
    ? (lastClose-Number(last.low))/(Number(last.high)-Number(last.low))*100
    : 50;

  const recent3=a.slice(-3),recent5=a.slice(-5),base30=a.slice(-35,-5);
  const recentVol=mean(recent3.map(x=>Number(x.volume))),baseMedianVol=median(base30.map(x=>Number(x.volume)));
  const volumeRatio=Number.isFinite(recentVol)&&Number.isFinite(baseMedianVol)&&baseMedianVol>0?recentVol/baseMedianVol:null;
  const recentTrades=mean(recent3.map(x=>Number(x.tradeCount)));
  const baseMedianTrades=median(base30.map(x=>Number(x.tradeCount)));
  const tradeRatio=Number.isFinite(recentTrades)&&Number.isFinite(baseMedianTrades)&&baseMedianTrades>0?recentTrades/baseMedianTrades:null;
  const recentBuy=recent3.reduce((s,x)=>s+Math.max(0,Number(x.takerBuyBaseVolume)||0),0);
  const recentVolSum=recent3.reduce((s,x)=>s+Math.max(0,Number(x.volume)||0),0);
  const prevBuy= a.slice(-8,-5).reduce((s,x)=>s+Math.max(0,Number(x.takerBuyBaseVolume)||0),0);
  const prevVolSum=a.slice(-8,-5).reduce((s,x)=>s+Math.max(0,Number(x.volume)||0),0);
  const buyRatio=recentVolSum>0?recentBuy/recentVolSum:null;
  const prevBuyRatio=prevVolSum>0?prevBuy/prevVolSum:null;
  const buyDelta=Number.isFinite(buyRatio)&&Number.isFinite(prevBuyRatio)?buyRatio-prevBuyRatio:null;

  const rangeRecent=mean(recent5.map(x=>Number(x.high)-Number(x.low)));
  const rangeBase=median(base30.map(x=>Number(x.high)-Number(x.low)));
  const rangeRatio=Number.isFinite(rangeRecent)&&Number.isFinite(rangeBase)&&rangeBase>0?rangeRecent/rangeBase:null;

  const prior20=a.slice(-21,-1);
  const priorHigh=Math.max(...prior20.map(x=>Number(x.high)).filter(Number.isFinite));
  const priorLow=Math.min(...prior20.map(x=>Number(x.low)).filter(Number.isFinite));
  const breakUp=lastClose>=priorHigh;
  const breakDown=lastClose<=priorLow;
  const breakoutDistanceUp=priorHigh>0?(lastClose-priorHigh)/priorHigh*100:null;
  const breakoutDistanceDown=priorLow>0?(priorLow-lastClose)/priorLow*100:null;

  const ema9=ema(closes,9),ema21=ema(closes,21),ema55=ema(closes,55);
  const emaBurst=Number.isFinite(ema9)&&Number.isFinite(ema21)
    ? lastClose>ema9&&ema9>ema21 ? 90 : lastClose>ema21 ? 68 : 35
    : 50;

  const vwapRows=a.slice(-30);
  const vDen=vwapRows.reduce((s,x)=>s+Math.max(0,Number(x.volume)||0),0);
  const vNum=vwapRows.reduce((s,x)=>s+((Number(x.high)+Number(x.low)+Number(x.close))/3)*(Math.max(0,Number(x.volume)||0)),0);
  const vwap=vDen>0?vNum/vDen:null;
  const vwapDistance=Number.isFinite(vwap)&&vwap>0?(lastClose-vwap)/vwap*100:null;
  const vwapImpulse=Number.isFinite(vwapDistance)?clamp(50+vwapDistance*22):50;

  const bbCloses=closes.slice(-21);
  const bbMean=mean(bbCloses),bbSd=stdev(bbCloses);
  const bbWidth=Number.isFinite(bbMean)&&bbMean>0&&Number.isFinite(bbSd)?4*bbSd/bbMean:null;
  const bbBase=stdev(closes.slice(-51,-21));
  const bbBaseMean=mean(closes.slice(-51,-21));
  const bbBaseWidth=Number.isFinite(bbBaseMean)&&bbBaseMean>0&&Number.isFinite(bbBase)?4*bbBase/bbBaseMean:null;
  const bbExpansion=Number.isFinite(bbWidth)&&Number.isFinite(bbBaseWidth)&&bbBaseWidth>0?bbWidth/bbBaseWidth:null;

  const net=Math.abs(Number(a.at(-1).close)-Number(a.at(-11).close));
  const path=a.slice(-10).reduce((s,x)=>s+Math.abs(Number(x.close)-Number(x.open)),0);
  const efficiency=path>0?net/path:null;

  const trueRanges=[];
  for(let i=1;i<a.length;i++){
    const h=Number(a[i].high),l=Number(a[i].low),pc=Number(a[i-1].close);
    trueRanges.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  const atrNow=mean(trueRanges.slice(-14)),atrBase=median(trueRanges.slice(-44,-14));
  const atrRatio=Number.isFinite(atrNow)&&Number.isFinite(atrBase)&&atrBase>0?atrNow/atrBase:null;

  const fiveClose=Number(b.at(-1)?.close),fivePrev=Number(b.at(-3)?.close);
  const fiveReturn=pct(fiveClose,fivePrev);
  const fiveEma20=ema(b.map(x=>Number(x.close)),20);
  const fiveTrend=Number.isFinite(fiveEma20)&&fiveClose>fiveEma20?75:35;

  const velocityScore=clamp(
    (Number.isFinite(r1)?clamp(50+r1*55):45)*0.22+
    (Number.isFinite(r3)?clamp(50+r3*28):45)*0.30+
    (Number.isFinite(r5)?clamp(50+r5*18):45)*0.18+
    (Number.isFinite(r10)?clamp(50+r10*10):45)*0.10+
    (Number.isFinite(accel)?clamp(50+accel*32):45)*0.20
  );
  const volumeScore=Number.isFinite(volumeRatio)?clamp(45+(volumeRatio-1)*24):45;
  const tradeScore=Number.isFinite(tradeRatio)?clamp(45+(tradeRatio-1)*24):45;
  const takerScore=Number.isFinite(buyRatio)?clamp(50+(buyRatio-.5)*250+(Number.isFinite(buyDelta)?buyDelta*180:0)):45;
  const rangeScore=Number.isFinite(rangeRatio)?clamp(50+(rangeRatio-1)*70):45;
  const breakoutScore=breakUp?96:breakDown?96:
    Number.isFinite(breakoutDistanceUp)&&breakoutDistanceUp>-0.6?82:
    Number.isFinite(breakoutDistanceDown)&&breakoutDistanceDown>-0.6?82:42;
  const bbScore=Number.isFinite(bbExpansion)?clamp(48+(bbExpansion-1)*75):45;
  const efficiencyScore=Number.isFinite(efficiency)?clamp(35+efficiency*80):45;
  const atrScore=Number.isFinite(atrRatio)?clamp(50+(atrRatio-1)*70):45;
  const flashScore=clamp(
    (Number.isFinite(r1)?clamp(50+r1*80):45)*.18+
    (Number.isFinite(r3)?clamp(50+r3*42):45)*.22+
    (Number.isFinite(accel)?clamp(50+accel*46):45)*.14+
    (Number.isFinite(volumeRatio)?clamp(45+(volumeRatio-1)*34):45)*.16+
    (Number.isFinite(tradeRatio)?clamp(45+(tradeRatio-1)*28):45)*.08+
    (Number.isFinite(buyRatio)?clamp(50+(buyRatio-.5)*300):45)*.10+
    (microBreak?92:breakoutScore*.45)+
    (Number.isFinite(closeLocation)&&closeLocation>=70?8:0)
  );

  const upScore=clamp(
    velocityScore*.24+volumeScore*.17+tradeScore*.08+takerScore*.14+
    rangeScore*.08+breakoutScore*.11+emaBurst*.06+vwapImpulse*.04+
    bbScore*.03+efficiencyScore*.03+atrScore*.02+fiveTrend*.00
  );
  const downScore=clamp(
    (Number.isFinite(r1)?clamp(50-r1*55):45)*.20+
    (Number.isFinite(r3)?clamp(50-r3*28):45)*.28+
    volumeScore*.16+tradeScore*.08+
    (Number.isFinite(buyRatio)?clamp(50-(buyRatio-.5)*250):45)*.10+
    rangeScore*.07+breakoutScore*.06+bbScore*.03+atrScore*.02
  );
  const direction=upScore>=downScore?'UP_SURGE':'DOWN_SURGE';
  const compositeScore=Math.max(upScore,downScore);
  const shortReturn=direction==='UP_SURGE'?r3:(Number.isFinite(r3)?-r3:null);
  const flashConfirmations=[
    Number.isFinite(r1)&&r1>=0.20,
    Number.isFinite(r3)&&r3>=0.45,
    Number.isFinite(volumeRatio)&&volumeRatio>=1.50,
    Number.isFinite(tradeRatio)&&tradeRatio>=1.35,
    Number.isFinite(buyRatio)&&buyRatio>=0.53,
    Number.isFinite(buyDelta)&&buyDelta>=0.010,
    microBreak||breakUp,
    Number.isFinite(closeLocation)&&closeLocation>=68
  ].filter(Boolean).length;
  const flashTrigger=direction==='UP_SURGE'&&flashScore>=74&&flashConfirmations>=3&&
    ((Number.isFinite(r3)&&r3>=0.45) ||
     (Number.isFinite(volumeRatio)&&volumeRatio>=1.50) ||
     microBreak);
  const score=Math.max(compositeScore,flashScore);
  const strongTrigger=score>=74 && (flashTrigger ||
    ((Number.isFinite(shortReturn)&&shortReturn>=0.65) ||
     (Number.isFinite(volumeRatio)&&volumeRatio>=2.5&&compositeScore>=72) ||
     (Number.isFinite(accel)&&accel>=0.45&&compositeScore>=72)));
  const stage=strongTrigger?(score>=88?'EXPLOSIVE':'STRONG_MOVE'):score>=68?'BUILDING':'WATCH';

  const reasons=[];
  const push=(ok,s)=>{if(ok)reasons.push(s)};
  push(Number.isFinite(r3)&&Math.abs(r3)>=0.65,'3m momentum burst');
  push(Number.isFinite(accel)&&accel>=0.30,'price acceleration');
  push(Number.isFinite(volumeRatio)&&volumeRatio>=2,'volume climax');
  push(Number.isFinite(tradeRatio)&&tradeRatio>=1.8,'trade-count surge');
  push(Number.isFinite(buyRatio)&&buyRatio>=0.54,'taker-buy pressure');
  push(Number.isFinite(buyDelta)&&buyDelta>=0.015,'taker-flow acceleration');
  push(Number.isFinite(rangeRatio)&&rangeRatio>=1.5,'range expansion');
  push(breakUp,'Donchian breakout');
  push(Number.isFinite(bbExpansion)&&bbExpansion>=1.25,'Bollinger expansion');
  push(Number.isFinite(efficiency)&&efficiency>=0.45,'directional efficiency');
  push(Number.isFinite(atrRatio)&&atrRatio>=1.3,'ATR expansion');
  push(Number.isFinite(vwapDistance)&&vwapDistance>=0.5,'VWAP displacement');

  return {
    eligible:strongTrigger,
    closed_candles_only:true,
    stage,
    direction,
    score:Math.round(score*10)/10,
    up_score:Math.round(upScore*10)/10,
    down_score:Math.round(downScore*10)/10,
    metrics:{
      return_1m:r1,return_3m:r3,return_5m:r5,return_10m:r10,return_20m:r20,acceleration:accel,
      flash_score:flashScore,flash_trigger:flashTrigger,flash_confirmations:flashConfirmations,
      micro_breakout:microBreak,close_location_pct:closeLocation,
      volume_ratio:volumeRatio,trade_ratio:tradeRatio,taker_buy_ratio:buyRatio,taker_buy_delta:buyDelta,
      range_ratio:rangeRatio,breakout_up:breakUp,breakout_down:breakDown,breakout_distance_up_pct:breakoutDistanceUp,
      breakout_distance_down_pct:breakoutDistanceDown,ema9,ema21,ema55,vwap,vwap_distance_pct:vwapDistance,
      bb_width:bbWidth,bb_expansion_ratio:bbExpansion,efficiency_ratio:efficiency,atr_ratio:atrRatio,
      five_min_return:fiveReturn,five_min_trend:fiveTrend
    },
    component_scores:{
      velocity:velocityScore,volume:volumeScore,trades:tradeScore,taker:takerScore,range:rangeScore,
      flash:flashScore,
      breakout:breakoutScore,ema:emaBurst,vwap:vwapImpulse,bollinger:bbScore,efficiency:efficiencyScore,atr:atrScore
    },
    trigger:{
      min_3m_move_pct:0.45,
      min_score:74,
      flash_score_trigger:74,
      flash_confirmations:3,
      volume_ratio_trigger:2.5,
      acceleration_trigger_pct:0.45
    },
    reasons:[...new Set(reasons)].slice(0,12),
    source:'Binance Public REST',
    detected_at:now,
    processed_at:now,
    paper_trading:true,
    real_order_execution:false,
    confidence_score:'UNKNOWN'
  };
}

export function buildStrongMoveAlert(candidate,now=Date.now()){
  const a=buildStrongMoveAnalysis(candidate.one_minute,candidate.five_minute,candidate.ticker,now);
  const ticker=candidate.ticker||{};
  return {
    id:'STRONG:'+String(ticker.symbol||'UNKNOWN').toUpperCase()+':'+a.direction+':'+now,
    event:'STRONG_MOVE_ALERT',
    radar:'STRONG_MOVE_RADAR',
    symbol:String(ticker.symbol||'UNKNOWN').toUpperCase(),
    market:'SPOT',
    direction:a.direction,
    price:finite(ticker.lastPrice),
    price_change_24h:finite(ticker.priceChange24h),
    opportunity_score:a.score,
    potential_label:a.stage,
    strong_move:a,
    reasons:a.reasons,
    risk_flags:[
      Math.abs(finite(ticker.priceChange24h,0))>=20?'24H_ALREADY_EXTENDED':null,
      a.component_scores.taker<45?'SELLING_PRESSURE_HIGH':null,
      a.component_scores.range>90?'VOLATILITY_EXTREME':null
    ].filter(Boolean),
    source:a.source,
    detected_at:now,
    processed_at:now,
    paper_trading:true,
    real_order_execution:false,
    confidence_score:'UNKNOWN',
    eligible:a.eligible,
    disclaimer:'رادار الحركة القوية يلتقط توسعًا/تسارعًا ظهر فعليًا؛ لا يضمن استمرار الحركة أو اتجاهها لاحقًا.'
  };
}

export class StrongMoveRadar {
  constructor({rest,store,pushManager=null,config={},clock=()=>Date.now(),logger=console}={}){
    if(!rest)throw new Error('REST_CLIENT_REQUIRED');
    if(!store)throw new Error('STORE_REQUIRED');
    this.rest=rest;this.store=store;this.pushManager=pushManager;this.clock=clock;this.logger=logger;
    this.config={
      quote:'USDT',pollMs:30000,universeRefreshMs:60000,minQuoteVolume24h:1000000,
      rotationBatchSize:4,topMoverCount:3,alertCooldownMs:12*60*1000,
      minScore:76, ...config
    };
    this.running=false;this.timer=null;this.universe=[];this.universeAt=0;this.cursor=0;
    this.lastTickerMap=new Map();this.lastScanAt=new Map();this.lastAlertAt=new Map();
    this.alertCount=0;this.lastError=null;this.scans=0;this.lastScanAtMs=null;this.busy=false;
  }
  start(){
    if(this.running)return;
    this.running=true;
    this.lastError=null;
    this.refreshUniverse()
      .then(()=>this.tick())
      .catch(e=>{
        this.lastError=String(e?.message??e);
        this.logger.warn?.('STRONG_MOVE_BOOTSTRAP',this.lastError);
      });
    this.timer=setInterval(()=>this.tick().catch(e=>{
      this.lastError=String(e?.message??e);
      this.logger.warn?.('STRONG_MOVE',this.lastError);
    }),this.config.pollMs);
  }
  async stop(){this.running=false;if(this.timer)clearInterval(this.timer);this.timer=null;}
  async refreshUniverse(){
    const info=await this.rest.request('/api/v3/exchangeInfo');
    const universe=buildSpotUniverse(info.data,this.config.quote);
    this.universe=universe.filter(x=>x.symbol).map(x=>x.symbol);
    this.universeAt=this.clock();
    this.cursor=0;
  }
  async tickerRows(){
    const r=await this.rest.request('/api/v3/ticker/24hr');
    return (Array.isArray(r.data)?r.data:[]).map(x=>normalizeTickerRow(x,this.config.quote)).filter(Boolean)
      .filter(x=>x.quoteVolume24h>=this.config.minQuoteVolume24h&&this.universe.includes(x.symbol));
  }
  selectBatch(rows){
    const byMove=[...rows].sort((a,b)=>Math.abs(b.priceChange24h)-Math.abs(a.priceChange24h)||b.quoteVolume24h-a.quoteVolume24h);
    const selected=[];
    for(const x of byMove.slice(0,this.config.topMoverCount))selected.push(x);
    const n=this.config.rotationBatchSize;
    for(let i=0;i<n&&this.universe.length;i++){
      const symbol=this.universe[this.cursor%this.universe.length];this.cursor=(this.cursor+1)%this.universe.length;
      const row=rows.find(x=>x.symbol===symbol);if(row)selected.push(row);
    }
    return [...new Map(selected.map(x=>[x.symbol,x])).values()];
  }
  async scanRow(row){
    const last=this.lastScanAt.get(row.symbol)||0;
    if(this.clock()-last<Math.max(5000,Number(this.config.pollMs)*0.75))return null;
    this.lastScanAt.set(row.symbol,this.clock());
    const [one,five]=await Promise.all([
      this.rest.klines(row.symbol,'1m',{limit:120}),
      this.rest.klines(row.symbol,'5m',{limit:60})
    ]);
    const alert=buildStrongMoveAlert({
      ticker:row,one_minute:one.candles,five_minute:five.candles
    },this.clock());
    this.scans++;
    const alertScore=Math.max(
      Number(alert?.strong_move?.score)||0,
      Number(alert?.strong_move?.component_scores?.flash)||0
    );
    const a=alert?.strong_move||{};
    const cs=a.component_scores||{};
    const m=a.metrics||{};
    const gate=evaluateEliteGate({
      radar:'STRONG_MOVE_RADAR',
      direction:a.direction,
      baseScore:alertScore,
      priceChange24h:row.priceChange24h,
      liquidityScore:clamp(70+Math.log10(Math.max(1,row.quoteVolume24h/this.config.minQuoteVolume24h))*30),
      dataQualityScore:90,
      triggerScore:Math.max(Number(cs.flash)||0,Number(cs.breakout)||0),
      structureScore:Math.max(Number(cs.breakout)||0,Number(cs.ema)||0),
      participationScore:mean([Number(cs.volume),Number(cs.trades)])||50,
      flowScore:Number(cs.taker)||50,
      relativeScore:Number(m.five_min_trend)||50,
      momentumScore:Math.max(Number(cs.velocity)||0,Number(cs.flash)||0),
      compressionScore:Math.max(Number(cs.bollinger)||0,Number(cs.range)||0),
      confirmations:Number(m.flash_confirmations)||0,
      minConfirmations:4,minScore:86,max24hMovePct:8,requireTrigger:true,minCategoryHits:5
    });
    alert.elite_gate=gate;
    if(!alert.eligible||alertScore<this.config.minScore||!gate.eligible)return alert;
    const lastAlert=this.lastAlertAt.get(row.symbol)||0;
    if(this.clock()-lastAlert<this.config.alertCooldownMs)return alert;
    this.lastAlertAt.set(row.symbol,this.clock());
    const decorated=decorateRadarAlert(alert,'Radar 2 — Strong-Move');
    await this.store.appendStrongMoveAlert(decorated);
    if(this.pushManager?.notifyRadarAlert)await this.pushManager.notifyRadarAlert(decorated);
    this.alertCount++;
    return alert;
  }
  async tick(){
    if(!this.running||this.busy)return;
    this.busy=true;
    try{
      if(this.clock()-this.universeAt>this.config.universeRefreshMs)await this.refreshUniverse();
      const rows=await this.tickerRows();
      const selected=this.selectBatch(rows);
      this.lastScanAtMs=this.clock();
      for(const row of selected){
        if(!this.running)break;
        try{await this.scanRow(row);}catch(e){this.lastError=String(e?.message??e);}
      }
    }finally{
      this.busy=false;
    }
  }
  health(){
    return {
      running:this.running,
      radar:'STRONG_MOVE_RADAR',
      universe:this.universe.length,
      last_universe_refresh_at:this.universeAt||null,
      last_scan_at:this.lastScanAtMs,
      scans:this.scans,
      alerts_emitted:this.alertCount,
      last_error:this.lastError,
      busy:this.busy,
      rest:this.rest?.health?.()||null,
      algorithms:['MOMENTUM_BURST','FLASH_ACCELERATION','VOLUME_CLIMAX','TRADE_COUNT_SURGE','TAKER_FLOW_ACCELERATION','DONCHIAN_BREAKOUT','MICRO_BREAKOUT','EMA_BURST','VWAP_DISPLACEMENT','BOLLINGER_EXPANSION','EFFICIENCY_RATIO','ATR_EXPANSION'],
      source:'Binance Public REST',
      closed_candles_only:true,
      paper_trading:true,
      real_order_execution:false,
      confidence_score:'UNKNOWN'
    };
  }
}
