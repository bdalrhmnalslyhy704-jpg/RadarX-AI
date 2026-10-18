import {buildSpotUniverse,normalizeTickerRow} from '../market/universe-scanner.mjs';
import {decorateRadarAlert} from './radar-alert-meta.mjs';
import {evaluateEliteGate} from './elite-confluence-gate.mjs';
import {evaluateRadarNotificationGate} from './radar-notification-gate.mjs';
import {isDirectionalCandidateSymbol} from './market-wide-light-scan.mjs';

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
    return {eligible:false,stage:'INSUFFICIENT_DATA',direction:'NONE',score:null,closed_candles_only:true,one_minute_count:a.length,five_minute_count:b.length,data_quality:0,data_stale:true};
  }
  const oneAge=Math.max(0,Number(now)-Number(a.at(-1)?.closeTime));
  const fiveAge=Math.max(0,Number(now)-Number(b.at(-1)?.closeTime));
  if(!Number.isFinite(oneAge)||!Number.isFinite(fiveAge)||oneAge>3*60*1000||fiveAge>10*60*1000){
    return {eligible:false,stage:'STALE_DATA',direction:'NONE',score:null,closed_candles_only:true,
      one_minute_count:a.length,five_minute_count:b.length,data_quality:0,data_stale:true,
      reason_codes:['STALE_CLOSED_CANDLES'],one_minute_age_ms:oneAge,five_minute_age_ms:fiveAge};
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

  const latestFiveCandle=b.at(-1);
  const fiveClose=Number(latestFiveCandle?.close),fivePrev=Number(b.at(-3)?.close);
  const fiveReturn=pct(fiveClose,fivePrev);
  const closedFiveCandleReturnPct=Number(latestFiveCandle?.open)>0
    ?(Number(latestFiveCandle.close)-Number(latestFiveCandle.open))/Number(latestFiveCandle.open)*100:null;
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
    data_quality:90,data_stale:false,candle_freshness:{one_minute_age_ms:oneAge,five_minute_age_ms:fiveAge},
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
      five_min_return:fiveReturn,five_min_trend:fiveTrend,
      closed_5m_candle_return_pct:Number.isFinite(closedFiveCandleReturnPct)?Math.round(closedFiveCandleReturnPct*1000)/1000:null,
      closed_5m_candle_close_time_ms:Number.isFinite(Number(latestFiveCandle?.closeTime))?Number(latestFiveCandle.closeTime):null
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
      a.data_stale===true?'STALE_DATA':null,
      (a.component_scores?.taker??50)<45?'SELLING_PRESSURE_HIGH':null,
      (a.component_scores?.range??0)>90?'VOLATILITY_EXTREME':null
    ].filter(Boolean),
    source:a.source,
    detected_at:now,
    processed_at:now,
    paper_trading:true,
    real_order_execution:false,
    confidence_score:'UNKNOWN',
    data_quality:finite(a.data_quality,0),
    data_status:{status:a.data_stale?'DATA_STALE':'LIVE_DATA',stale:Boolean(a.data_stale),future_data_detected:false,source:'Binance Public REST'},
    liquidity_quality:clamp(70+Math.log10(Math.max(1,(Number(ticker.quoteVolume24h)||0)/1000000))*30),
    eligible:a.eligible,
    disclaimer:'رادار الحركة القوية يلتقط توسعًا/تسارعًا ظهر فعليًا؛ لا يضمن استمرار الحركة أو اتجاهها لاحقًا.'
  };
}

export function buildEmergencyBreakoutAlert({five_minute,ticker}={},now=Date.now()){
  const symbol=String(ticker?.symbol||'').trim().toUpperCase();
  if(!/^[A-Z0-9]{2,25}USDT$/.test(symbol))return null;
  // Liquidity is disclosed as a risk flag, never used as an emergency eligibility floor.
  const quoteVolume=Number(ticker?.quoteVolume24h);
  const quoteVolumeKnown=Number.isFinite(quoteVolume)&&quoteVolume>=0;
  const rows=(Array.isArray(five_minute)?five_minute:[])
    .filter(c=>c?.closed===true&&Number.isFinite(Number(c.openTime))&&
      Number.isFinite(Number(c.closeTime))&&Number(c.closeTime)<=now&&
      Number.isFinite(Number(c.open))&&Number.isFinite(Number(c.high))&&
      Number.isFinite(Number(c.low))&&Number.isFinite(Number(c.close))&&
      Number(c.open)>0&&Number(c.low)>0&&Number(c.high)>=Math.max(Number(c.open),Number(c.close))&&
      Number(c.low)<=Math.min(Number(c.open),Number(c.close)))
    .sort((a,b)=>Number(a.openTime)-Number(b.openTime));
  const candle=rows.at(-1);
  if(!candle||rows.length<13)return null;
  const closeTime=Number(candle.closeTime),ageMs=now-closeTime;
  if(!Number.isFinite(ageMs)||ageMs<0||ageMs>8*60_000)return null;
  const open=Number(candle.open),close=Number(candle.close);
  const movePct=(close-open)/open*100;
  const candleQuoteVolume=row=>{
    const q=Number(row?.quoteVolume);
    if(Number.isFinite(q)&&q>0)return q;
    const volume=Number(row?.volume),price=Number(row?.close);
    return Number.isFinite(volume)&&volume>0&&Number.isFinite(price)&&price>0?volume*price:null;
  };
  const history=rows.slice(-13);
  for(let i=1;i<history.length;i++){
    if(Math.abs((Number(history[i].openTime)-Number(history[i-1].openTime))-5*60_000)>1_000)return null;
  }
  const priorRows=history.slice(0,-1);
  const currentQuoteVolume=candleQuoteVolume(candle);
  const priorVolumes=priorRows.map(candleQuoteVolume).filter(value=>Number.isFinite(value)&&value>0);
  const baselineQuoteVolume=median(priorVolumes);
  const volumeRatio=Number.isFinite(currentQuoteVolume)&&Number.isFinite(baselineQuoteVolume)&&baselineQuoteVolume>0
    ?currentQuoteVolume/baselineQuoteVolume:null;
  const currentTradesRaw=candle?.tradeCount??candle?.count;
  const currentTrades=currentTradesRaw!==null&&currentTradesRaw!==undefined&&currentTradesRaw!==''&&Number.isFinite(Number(currentTradesRaw))&&Number(currentTradesRaw)>=0
    ?Number(currentTradesRaw):null;
  const priorTradeCounts=priorRows.map(row=>{
    const raw=row?.tradeCount??row?.count;
    return raw!==null&&raw!==undefined&&raw!==''&&Number.isFinite(Number(raw))&&Number(raw)>=0?Number(raw):null;
  }).filter(value=>value!==null);
  const baselineTrades=median(priorTradeCounts);
  const tradeRatio=currentTrades!==null&&Number.isFinite(baselineTrades)&&baselineTrades>0?currentTrades/baselineTrades:null;
  const takerShareOf=row=>{
    const volume=Number(row?.volume),buy=Number(row?.takerBuyBaseVolume);
    if(row?.takerBuyBaseVolume===null||row?.takerBuyBaseVolume===undefined||row?.takerBuyBaseVolume===''||
       !Number.isFinite(volume)||volume<=0||!Number.isFinite(buy)||buy<0||buy>volume)return null;
    return buy/volume;
  };
  const takerBuyShare=takerShareOf(candle);
  const baselineTakerBuyShare=median(priorRows.map(takerShareOf).filter(value=>value!==null));
  const takerBuyShareDelta=takerBuyShare!==null&&Number.isFinite(baselineTakerBuyShare)
    ?takerBuyShare-baselineTakerBuyShare:null;
  const priorHigh=Math.max(...priorRows.map(row=>Number(row.high)).filter(Number.isFinite));
  const brokePriorResistance=Number.isFinite(priorHigh)&&close>priorHigh;
  const closeLocationPct=Number(candle.high)>Number(candle.low)
    ?(close-Number(candle.low))/(Number(candle.high)-Number(candle.low))*100:50;
  const buyerFlowConfirmed=takerBuyShare!==null&&
    (takerBuyShare>=0.50||(takerBuyShare>=0.48&&Number.isFinite(takerBuyShareDelta)&&takerBuyShareDelta>=0.02));
  const participationConfirmed=Number.isFinite(volumeRatio)&&volumeRatio>=1.8&&
    Number.isFinite(tradeRatio)&&tradeRatio>=1.3;
  const largeMoveCandle=Number.isFinite(movePct)&&movePct>=7;
  // Keep low absolute turnover eligible as an advisory, but demand relative turnover,
  // trade participation, buyer pressure and a closed-candle resistance break.
  const priceBreakout=largeMoveCandle&&participationConfirmed&&buyerFlowConfirmed&&
    brokePriorResistance&&closeLocationPct>=70;
  const volumeSpike=Number.isFinite(volumeRatio)&&volumeRatio>=3&&
    Number.isFinite(tradeRatio)&&tradeRatio>=2;
  const volumeTriggered=!priceBreakout&&Number.isFinite(movePct)&&movePct>=1.5&&
    volumeSpike&&buyerFlowConfirmed&&brokePriorResistance&&closeLocationPct>=65;
  if(!priceBreakout&&!volumeTriggered)return null;
  const score=priceBreakout
    ?Math.min(100,80+Math.max(0,movePct-7)*1.25)
    :Math.min(100,76+Math.min(24,Math.max(0,volumeRatio-3)*4));
  const lowDailyLiquidity=!quoteVolumeKnown||quoteVolume<1_000_000;
  const flags=[
    'EMERGENCY_BREAKOUT_VOLATILITY',
    ...(lowDailyLiquidity?['LOW_24H_QUOTE_VOLUME_ADVISORY']:[]),
    ...(Number.isFinite(currentQuoteVolume)&&currentQuoteVolume<100_000?['LOW_ABSOLUTE_CANDLE_VOLUME_ADVISORY']:[]),
    ...(Math.abs(Number(ticker?.priceChange24h)||0)>15?['24H_ALREADY_EXTENDED']:[])
  ];
  return {
    id:(volumeTriggered?'EMERGENCY_VOLUME_SPIKE:':'EMERGENCY:')+symbol+':'+closeTime,
    event:volumeTriggered?'EMERGENCY_VOLUME_SPIKE_ALERT':'EMERGENCY_BREAKOUT_ALERT',
    radar:'STRONG_MOVE_RADAR',symbol,market:'SPOT',direction:'UP_SURGE',
    price:close,last_price:close,
    price_change_24h:Number.isFinite(Number(ticker?.priceChange24h))?Number(ticker.priceChange24h):null,
    opportunity_score:Math.round(score*10)/10,
    potential_label:volumeTriggered?'EMERGENCY_VOLUME_SPIKE':'EMERGENCY_BREAKOUT',
    strong_move:{
      eligible:true,emergency:true,stage:volumeTriggered?'EMERGENCY_VOLUME_SPIKE':'EMERGENCY_BREAKOUT',
      direction:'UP_SURGE',score:Math.round(score*10)/10,data_quality:90,data_stale:false,closed_candles_only:true,
      metrics:{
        closed_5m_candle_return_pct:Math.round(movePct*1000)/1000,
        closed_5m_candle_close_time_ms:closeTime,closed_5m_candle_age_ms:ageMs,
        closed_5m_candle_volume:Number.isFinite(Number(candle.volume))?Number(candle.volume):null,
        closed_5m_candle_quote_volume:currentQuoteVolume,
        closed_5m_candle_trade_count:Number.isFinite(Number(candle.tradeCount??candle.count))?Number(candle.tradeCount??candle.count):null,
        baseline_5m_quote_volume:Number.isFinite(baselineQuoteVolume)?baselineQuoteVolume:null,
        volume_spike_ratio:Number.isFinite(volumeRatio)?Math.round(volumeRatio*100)/100:null,
        trade_spike_ratio:Number.isFinite(tradeRatio)?Math.round(tradeRatio*100)/100:null,
        closed_5m_taker_buy_share:Number.isFinite(takerBuyShare)?Math.round(takerBuyShare*1000)/1000:null,
        baseline_taker_buy_share:Number.isFinite(baselineTakerBuyShare)?Math.round(baselineTakerBuyShare*1000)/1000:null,
        taker_buy_share_delta:Number.isFinite(takerBuyShareDelta)?Math.round(takerBuyShareDelta*1000)/1000:null,
        close_location_pct:Number.isFinite(closeLocationPct)?Math.round(closeLocationPct*10)/10:null,
        prior_5m_resistance:Number.isFinite(priorHigh)?priorHigh:null,
        broke_prior_5m_resistance:brokePriorResistance,
        buyer_flow_confirmed:buyerFlowConfirmed,
        participation_confirmed:participationConfirmed,
        low_daily_liquidity_advisory:lowDailyLiquidity
      },
      reasons:volumeTriggered
        ?['شمعة 5 دقائق مغلقة بإغلاق إيجابي ≥1.5%','توسع الحجم والصفقات مقابل خط أساس العملة مع ضغط شراء واختراق مقاومة']
        :['شمعة 5 دقائق مغلقة ارتفعت 7% أو أكثر','تأكد الحجم والصفقات وضغط الشراء والإغلاق فوق المقاومة السابقة']
    },
    reasons:volumeTriggered
      ?['EMERGENCY_CLOSED_5M_VOLUME_SPIKE','VOLUME_RATIO_GTE_3X','TRADE_RATIO_GTE_2X','BUY_FLOW_CONFIRMED','PRIOR_RESISTANCE_BROKEN','LOW_LIQUIDITY_IS_WARNING_ONLY']
      :['EMERGENCY_CLOSED_5M_BREAKOUT','VOLUME_AND_TRADES_CONFIRMED','BUY_FLOW_CONFIRMED','PRIOR_RESISTANCE_BROKEN','LOW_LIQUIDITY_IS_WARNING_ONLY'],
    risk_flags:flags,
    data_quality:90,
    data_status:{status:'LIVE_DATA',stale:false,data_stale:false,future_data_detected:false,source:'Binance Public REST',last_error:null},
    liquidity_quality:quoteVolumeKnown&&quoteVolume>0
      ?clamp(30+Math.log10(Math.max(1,quoteVolume/1_000_000))*20,0,100):0,
    eligible:true,emergency:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
    disclaimer:'تنبيه طارئ من شمعة 5 دقائق مغلقة أو تضاعف حجمها؛ لا يوجد حد سيولة للالتقاط، والسيولة المنخفضة تحذير مخاطر وليست تأكيد شراء أو ضمان ربح.'
  };
}

export class StrongMoveRadar {
  constructor({rest,store,pushManager=null,config={},clock=()=>Date.now(),logger=console}={}){
    if(!rest)throw new Error('REST_CLIENT_REQUIRED');
    if(!store)throw new Error('STORE_REQUIRED');
    this.rest=rest;this.store=store;this.pushManager=pushManager;this.clock=clock;this.logger=logger;
    this.config={
      quote:'USDT',pollMs:30000,universeRefreshMs:30*60*1000,minQuoteVolume24h:0,
      rotationBatchSize:4,topMoverCount:3,alertCooldownMs:12*60*1000,
      emergencyAlertCooldownMs:5*60*1000,minScore:76, ...config
    };
    this.running=false;this.timer=null;this.universe=[];this.universeAt=0;this.cursor=0;
    this.lastTickerMap=new Map();this.lastScanAt=new Map();this.lastAlertAt=new Map();
    this.lastEmergencyCandleAt=new Map();this.lastEmergencyAlertAt=new Map();
    this.emergencyAlertCount=0;this.alertCount=0;this.lastError=null;this.scans=0;this.lastScanAtMs=null;this.busy=false;
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
    const now=this.clock();
    const rows=(Array.isArray(r.data)?r.data:[]).map(x=>normalizeTickerRow(x,this.config.quote)).filter(Boolean)
      .filter(x=>isDirectionalCandidateSymbol(x.symbol)&&this.universe.includes(x.symbol));
    const present=new Set();
    const enriched=rows.map(row=>{
      const symbol=String(row.symbol||'').toUpperCase();
      const previous=this.lastTickerMap.get(symbol);
      const ageMs=previous?Math.max(0,now-Number(previous.at)):null;
      const recentMovePct=previous&&Number(previous.lastPrice)>0&&Number.isFinite(ageMs)&&ageMs<=Math.max(90_000,this.config.pollMs*3)
        ?(Number(row.lastPrice)-Number(previous.lastPrice))/Number(previous.lastPrice)*100:null;
      this.lastTickerMap.set(symbol,{lastPrice:Number(row.lastPrice),priceChange24h:Number(row.priceChange24h),at:now});
      present.add(symbol);
      return {...row,recent_move_pct:Number.isFinite(recentMovePct)?recentMovePct:null,recent_observation_age_ms:ageMs};
    });
    if(this.lastTickerMap.size>1200){
      for(const [symbol,item] of this.lastTickerMap)if(!present.has(symbol)&&now-Number(item.at)>30*60*1000)this.lastTickerMap.delete(symbol);
    }
    return enriched;
  }
  selectBatch(rows){
    const byMove=[...(Array.isArray(rows)?rows:[])].sort((a,b)=>{
      const am=Number(a.priceChange24h),bm=Number(b.priceChange24h);
      const ae=Math.abs(am)>8,be=Math.abs(bm)>8;
      if(ae!==be)return Number(ae)-Number(be);
      if(!ae&&am!==bm)return bm-am;
      return Math.abs(bm)-Math.abs(am)||b.quoteVolume24h-a.quoteVolume24h;
    });
    const selected=[],seen=new Set();
    const take=row=>{if(row?.symbol&&!seen.has(row.symbol)){selected.push(row);seen.add(row.symbol);return true;}return false;};
    const topCount=Math.max(0,Math.trunc(Number(this.config.topMoverCount)||0));
    const rotationCount=Math.max(0,Math.trunc(Number(this.config.rotationBatchSize)||0));
    const target=Math.min(new Set(byMove.map(x=>x.symbol)).size,topCount+rotationCount);
    // A fresh quote-price pulse gets first access to Micro even when its 24h change is extended.
    const pulseLane=byMove.filter(row=>Number.isFinite(Number(row.recent_move_pct))&&Number(row.recent_move_pct)>=1.5)
      .sort((a,b)=>Number(b.recent_move_pct)-Number(a.recent_move_pct)).slice(0,Math.min(2,target));
    for(const row of pulseLane)take(row);
    const earlyLane=byMove.filter(row=>Math.abs(Number(row.priceChange24h)||0)<=8);
    for(const row of earlyLane){
      if(selected.length>=Math.min(topCount,target))break;
      take(row);
    }
    for(const row of byMove){
      if(selected.length>=Math.min(topCount,target))break;
      take(row);
    }
    // Reserve two scan slots for daily surge candidates; without this, early movers can starve the emergency lane.
    const surgeLane=byMove.filter(row=>Number.isFinite(Number(row.priceChange24h))&&Number(row.priceChange24h)>=7)
      .sort((a,b)=>(Number(b.recent_move_pct)||0)-(Number(a.recent_move_pct)||0)||
        Number(b.priceChange24h)-Number(a.priceChange24h)||Number(b.quoteVolume24h)-Number(a.quoteVolume24h))
      .slice(0,2);
    for(const row of surgeLane){
      if(selected.length>=Math.max(0,target-2))break;
      take(row);
    }
    let visited=0;
    while(selected.length<target&&visited<this.universe.length){
      const symbol=this.universe[this.cursor%this.universe.length];this.cursor=(this.cursor+1)%this.universe.length;visited++;
      take(byMove.find(x=>x.symbol===symbol));
    }
    return selected;
  }
  async scanRow(row){
    const last=this.lastScanAt.get(row.symbol)||0;
    if(this.clock()-last<Math.max(5000,Number(this.config.pollMs)*0.75))return null;
    this.lastScanAt.set(row.symbol,this.clock());
    // Launch the normal 1m analysis in parallel, but never let it delay a 5m emergency.
    const oneResultPromise=this.rest.klines(row.symbol,'1m',{limit:120})
      .then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason}));
    const five=this.rest.klines(row.symbol,'5m',{limit:60});
    const fiveResult=await five;
    const now=this.clock();
    const emergency=buildEmergencyBreakoutAlert({ticker:row,five_minute:fiveResult.candles},now);
    this.scans++;
    if(emergency){
      const candleCloseTime=Number(emergency.strong_move.metrics.closed_5m_candle_close_time_ms);
      const previousCandle=Number(this.lastEmergencyCandleAt.get(row.symbol)||0);
      const lastEmergencyAt=Number(this.lastEmergencyAlertAt.get(row.symbol)||0);
      if(previousCandle===candleCloseTime)return {...emergency,emergency_deduplicated:true};
      if(now-lastEmergencyAt<Math.max(60_000,Number(this.config.emergencyAlertCooldownMs)||5*60*1000))
        return {...emergency,emergency_suppressed_by_cooldown:true};
      const decoratedEmergency=decorateRadarAlert(emergency,'Radar 2 — Strong-Move / Emergency');
      await this.store.appendStrongMoveAlert(decoratedEmergency);
      // Mark the persisted candle before push delivery, so a push outage cannot duplicate the stored alert.
      this.lastEmergencyCandleAt.set(row.symbol,candleCloseTime);
      this.lastEmergencyAlertAt.set(row.symbol,now);
      this.lastAlertAt.set(row.symbol,now);
      this.alertCount++;
      this.emergencyAlertCount++;
      try{
        if(this.pushManager?.notifyRadarAlert)await this.pushManager.notifyRadarAlert(decoratedEmergency);
      }catch(pushError){
        this.lastError=String(pushError?.message??pushError);
        this.logger.warn?.('STRONG_MOVE_EMERGENCY_PUSH',this.lastError);
      }
      return emergency;
    }
    const oneResult=await oneResultPromise;
    if(oneResult.status!=='fulfilled')throw oneResult.reason||new Error('ONE_MINUTE_KLINES_UNAVAILABLE');
    const one=oneResult.value;
    const alert=buildStrongMoveAlert({
      ticker:row,one_minute:one.candles,five_minute:fiveResult.candles
    },now);
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
    alert.data_quality=finite(a.data_quality,0);
    alert.liquidity_quality=clamp(70+Math.log10(Math.max(1,Number(row.quoteVolume24h)/this.config.minQuoteVolume24h))*30);
    alert.data_status={status:a.data_stale?'DATA_STALE':'LIVE_DATA',stale:Boolean(a.data_stale),future_data_detected:false,source:'Binance Public REST'};
    if(!alert.eligible||alertScore<this.config.minScore||!gate.eligible)return alert;
    const notificationGate=evaluateRadarNotificationGate(alert,{now:this.clock(),commit:true});
    alert.notification_gate=notificationGate;
    if(!notificationGate.eligible)return alert;
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
      emergency_alerts_emitted:this.emergencyAlertCount,
      emergency_trigger:'CLOSED_5M_MOVE_GTE_7_PERCENT_OR_POSITIVE_MOVE_GTE_1_5_PERCENT_WITH_3X_VOLUME_SPIKE; NO_24H_QUOTE_VOLUME_FLOOR',
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
