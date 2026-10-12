import {buildSpotUniverse,normalizeTickerRow} from '../market/universe-scanner.mjs';
import {decorateRadarAlert} from './radar-alert-meta.mjs';
import {evaluateEliteGate} from './elite-confluence-gate.mjs';
import {evaluateRadarNotificationGate,rememberRadarAlert} from './radar-notification-gate.mjs';
import {recordRadarDecision} from './radar-telemetry.mjs';

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

function madStats(sample,current){
  const clean=sample.map(Number).filter(Number.isFinite);
  if(!clean.length||!Number.isFinite(Number(current)))return {median:null,mad:null,scale:null,z:null,capped_value:null,outlier:false};
  const med=median(clean),mad=median(clean.map(x=>Math.abs(x-med)))??0;
  const scale=Math.max(1.4826*mad,Math.abs(med)*0.05,1e-9),z=(Number(current)-med)/scale;
  return {median:med,mad,scale,z,capped_value:Math.min(Number(current),med+6*scale),outlier:z>8};
}
export function buildLiquidityAccelerationMetrics(rows,now=Date.now()){
  const a=closedCandles(rows,now),q=a.map(c=>Number(c.quoteVolume));
  if(a.length<39||q.slice(-39).some(v=>!Number.isFinite(v)||v<0))return {
    available:false,score:null,reason:'INSUFFICIENT_QUOTE_VOLUME_HISTORY',one_minute_rvol:null,
    one_minute_mad_z:null,three_minute_rvol:null,three_minute_acceleration:null,outlier_1m:false,outlier_3m:false
  };
  const oneStats=madStats(q.slice(-31,-1).filter(v=>v>0),q.at(-1));
  const rvol1m=oneStats.median>0?oneStats.capped_value/oneStats.median:null;
  const baseRows=a.slice(-39,-9),hist3=[];
  for(let i=0;i+2<baseRows.length;i+=3){
    const total=baseRows.slice(i,i+3).reduce((s,c)=>s+Number(c.quoteVolume),0);
    if(Number.isFinite(total)&&total>0)hist3.push(total);
  }
  const totals=[a.slice(-9,-6),a.slice(-6,-3),a.slice(-3)].map(w=>w.reduce((s,c)=>s+Number(c.quoteVolume),0));
  const [older3m,previous3m,current3m]=totals,threeStats=madStats(hist3,current3m);
  const rvol3m=threeStats.median>0?threeStats.capped_value/threeStats.median:null;
  const rateRecent=previous3m>0?current3m/previous3m:null,ratePrevious=older3m>0?previous3m/older3m:null;
  const acceleration=Number.isFinite(rateRecent)&&Number.isFinite(ratePrevious)?rateRecent-ratePrevious:null;
  const oneScore=Number.isFinite(rvol1m)?clamp(50+Math.log2(Math.max(.01,rvol1m))*12+clamp(Number(oneStats.z)||0,0,6)*2):45;
  const threeScore=Number.isFinite(rvol3m)?clamp(50+Math.log2(Math.max(.01,rvol3m))*12+clamp(Number(threeStats.z)||0,0,6)*2+
    (Number.isFinite(acceleration)?clamp(acceleration,-2,6)*2:0)):45;
  return {available:true,score:clamp(oneScore*.45+threeScore*.55),one_minute_quote_volume:q.at(-1),
    one_minute_baseline_median:oneStats.median,one_minute_mad:oneStats.mad,one_minute_mad_z:oneStats.z,
    one_minute_rvol:rvol1m,three_minute_quote_volume:current3m,three_minute_baseline_median:threeStats.median,
    three_minute_mad:threeStats.mad,three_minute_mad_z:threeStats.z,three_minute_rvol:rvol3m,
    three_minute_window_quote_volume:totals,three_minute_rate_recent:rateRecent,three_minute_rate_previous:ratePrevious,
    three_minute_acceleration:acceleration,outlier_1m:oneStats.outlier,outlier_3m:threeStats.outlier,
    mad_outlier_policy:'WINSORIZE_AT_MEDIAN_PLUS_6_ROBUST_SCALES'};
}
export function buildThreeSecondLiquidityMetrics(trades,now=Date.now()){
  const width=3000,boundary=Math.floor(now/width)*width,lastStart=boundary-width,firstStart=lastStart-19*width,map=new Map();
  for(let t=firstStart;t<=lastStart;t+=width)map.set(t,{start:t,quote:0,takerBuyQuote:0,count:0});
  for(const trade of (Array.isArray(trades)?trades:[])){
    const at=Number(trade?.T??trade?.time??trade?.timestamp),price=Number(trade?.p??trade?.price),qty=Number(trade?.q??trade?.quantity);
    const maker=trade?.m??trade?.buyerIsMaker,makerKnown=typeof maker==='boolean'||maker===0||maker===1||maker==='0'||maker==='1'||maker==='true'||maker==='false';
    if(!Number.isFinite(at)||at<firstStart||at>=boundary||at>now||!Number.isFinite(price)||price<=0||
      !Number.isFinite(qty)||qty<=0||!makerKnown)continue;
    const bin=map.get(Math.floor(at/width)*width);if(!bin)continue;
    const quote=price*qty;bin.quote+=quote;bin.count++;
    const buyerIsMaker=maker===true||maker===1||maker==='1'||maker==='true';
    if(!buyerIsMaker)bin.takerBuyQuote+=quote;
  }
  const bins=[...map.values()].sort((a,b)=>a.start-b.start),latest=bins.at(-1),previous=bins.at(-2),previous2=bins.at(-3);
  const history=bins.slice(0,-1).map(b=>b.quote).filter(v=>v>0);
  if(history.length<5||!(latest?.quote>0)||!(previous?.quote>0)||!(previous2?.quote>0))return {
    available:false,reason:'INSUFFICIENT_3S_TRADE_HISTORY',score:null,taker_buy_ratio:null,
    quote_volume_3s:latest?.quote??0,valid_3s_windows:history.length
  };
  const stats=madStats(history,latest.quote),rvol=stats.median>0?stats.capped_value/stats.median:null;
  const rateRecent=latest.quote/previous.quote,ratePrevious=previous.quote/previous2.quote;
  const acceleration=rateRecent-ratePrevious,buyRatio=latest.takerBuyQuote/latest.quote;
  const score=clamp(50+(Number.isFinite(rvol)?Math.log2(Math.max(.01,rvol))*12:0)+clamp(acceleration,-2,6)*2+clamp(Number(stats.z)||0,0,6)*2);
  return {available:true,score,taker_buy_ratio:buyRatio,quote_volume_3s:latest.quote,taker_buy_quote_volume_3s:latest.takerBuyQuote,
    trade_count_3s:latest.count,three_second_rvol:rvol,three_second_mad:stats.mad,three_second_mad_z:stats.z,
    three_second_acceleration:acceleration,valid_3s_windows:history.length+1,outlier_3s:stats.outlier,
    mad_outlier_policy:'WINSORIZE_AT_MEDIAN_PLUS_6_ROBUST_SCALES',source:'BINANCE_PUBLIC_AGG_TRADES'};
}
export function buildStrongMoveAnalysis(oneM,fiveM,ticker,now,aggTrades=[]){
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
  const recentQuoteRows=recent3.map(x=>Number(x.quoteVolume));
  const recentTakerBuyQuoteRows=recent3.map(x=>Number(x.takerBuyQuoteVolume));
  const previousQuoteRows=a.slice(-8,-5).map(x=>Number(x.quoteVolume));
  const previousTakerBuyQuoteRows=a.slice(-8,-5).map(x=>Number(x.takerBuyQuoteVolume));
  const recentQuoteSum=recentQuoteRows.every(Number.isFinite)?recentQuoteRows.reduce((s,x)=>s+Math.max(0,x),0):null;
  const recentTakerBuyQuoteSum=recentTakerBuyQuoteRows.every(Number.isFinite)?recentTakerBuyQuoteRows.reduce((s,x)=>s+Math.max(0,x),0):null;
  const previousQuoteSum=previousQuoteRows.every(Number.isFinite)?previousQuoteRows.reduce((s,x)=>s+Math.max(0,x),0):null;
  const previousTakerBuyQuoteSum=previousTakerBuyQuoteRows.every(Number.isFinite)?previousTakerBuyQuoteRows.reduce((s,x)=>s+Math.max(0,x),0):null;
  const buyRatio=Number.isFinite(recentQuoteSum)&&recentQuoteSum>0&&Number.isFinite(recentTakerBuyQuoteSum)?recentTakerBuyQuoteSum/recentQuoteSum:null;
  const prevBuyRatio=Number.isFinite(previousQuoteSum)&&previousQuoteSum>0&&Number.isFinite(previousTakerBuyQuoteSum)?previousTakerBuyQuoteSum/previousQuoteSum:null;
  const buyDelta=Number.isFinite(buyRatio)&&Number.isFinite(prevBuyRatio)?buyRatio-prevBuyRatio:null;
  const liquidityAcceleration=buildLiquidityAccelerationMetrics(a,now);
  const threeSecondLiquidity=buildThreeSecondLiquidityMetrics(aggTrades,now);
  const buyPressureConfirmed=Number.isFinite(buyRatio)&&buyRatio>0.70;
  const threeSecondBuyPressureConfirmed=threeSecondLiquidity.available&&Number.isFinite(threeSecondLiquidity.taker_buy_ratio)&&threeSecondLiquidity.taker_buy_ratio>0.70;

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
  const volumeScore=Number.isFinite(liquidityAcceleration.score)?liquidityAcceleration.score:(Number.isFinite(volumeRatio)?clamp(45+(volumeRatio-1)*24):45);
  const tradeScore=Number.isFinite(tradeRatio)?clamp(45+(tradeRatio-1)*24):45;
  const takerScore=Number.isFinite(buyRatio)?clamp(50+(buyRatio-.5)*250+(Number.isFinite(buyDelta)?buyDelta*180:0)):45;
  const rangeScore=Number.isFinite(rangeRatio)?clamp(50+(rangeRatio-1)*70):45;
  const breakoutScore=breakUp?96:breakDown?96:
    Number.isFinite(breakoutDistanceUp)&&breakoutDistanceUp>-0.6?82:
    Number.isFinite(breakoutDistanceDown)&&breakoutDistanceDown>-0.6?82:42;
  const bbScore=Number.isFinite(bbExpansion)?clamp(48+(bbExpansion-1)*75):45;
  const efficiencyScore=Number.isFinite(efficiency)?clamp(35+efficiency*80):45;
  const atrScore=Number.isFinite(atrRatio)?clamp(50+(atrRatio-1)*70):45;
  const flashComponents={
    return_1m:Number.isFinite(r1)?clamp(50+r1*80):45,return_3m:Number.isFinite(r3)?clamp(50+r3*42):45,
    price_acceleration:Number.isFinite(accel)?clamp(50+accel*46):45,liquidity_1m_3m:volumeScore,
    trade_count:Number.isFinite(tradeRatio)?clamp(45+(tradeRatio-1)*28):45,
    taker_buy_flow:Number.isFinite(buyRatio)?clamp(50+(buyRatio-.5)*250+(Number.isFinite(buyDelta)?buyDelta*180:0)):45,
    liquidity_3s:Number.isFinite(threeSecondLiquidity.score)?threeSecondLiquidity.score:45,
    breakout:microBreak?92:breakoutScore*.45,close_location:clamp(closeLocation)
  };
  const flashScore=clamp(
    flashComponents.return_1m*.12+flashComponents.return_3m*.15+flashComponents.price_acceleration*.10+
    flashComponents.liquidity_1m_3m*.16+flashComponents.trade_count*.08+flashComponents.taker_buy_flow*.15+
    flashComponents.liquidity_3s*.10+flashComponents.breakout*.06+flashComponents.close_location*.08
  );

  const liquidity3sScore=Number.isFinite(threeSecondLiquidity.score)?threeSecondLiquidity.score:45;
  const upScore=clamp(
    velocityScore*.20+volumeScore*.20+tradeScore*.07+takerScore*.17+liquidity3sScore*.10+
    rangeScore*.05+breakoutScore*.09+emaBurst*.04+vwapImpulse*.03+bbScore*.02+efficiencyScore*.02+atrScore*.01
  );
  const downScore=clamp(
    (Number.isFinite(r1)?clamp(50-r1*55):45)*.20+(Number.isFinite(r3)?clamp(50-r3*28):45)*.23+
    volumeScore*.20+tradeScore*.07+(Number.isFinite(buyRatio)?clamp(50-(buyRatio-.5)*250):45)*.14+
    liquidity3sScore*.08+rangeScore*.04+breakoutScore*.02+bbScore*.01+atrScore*.01
  );
  const direction=upScore>=downScore?'UP_SURGE':'DOWN_SURGE';
  const compositeScore=Math.max(upScore,downScore);
  const shortReturn=direction==='UP_SURGE'?r3:(Number.isFinite(r3)?-r3:null);
  const flashConfirmations=[
    Number.isFinite(r1)&&r1>=0.20,Number.isFinite(r3)&&r3>=0.45,Number.isFinite(volumeRatio)&&volumeRatio>=1.50,
    Number.isFinite(tradeRatio)&&tradeRatio>=1.35,buyPressureConfirmed,Number.isFinite(buyDelta)&&buyDelta>=0.010,
    microBreak||breakUp,Number.isFinite(closeLocation)&&closeLocation>=68,
    Number.isFinite(liquidityAcceleration.score)&&liquidityAcceleration.score>=60,threeSecondBuyPressureConfirmed
  ].filter(Boolean).length;
  const independentConfirmations=[
    Number.isFinite(r3)&&r3>=0.45,Number.isFinite(volumeRatio)&&volumeRatio>=1.50,Number.isFinite(tradeRatio)&&tradeRatio>=1.35,
    buyPressureConfirmed,microBreak||breakUp,Number.isFinite(liquidityAcceleration.score)&&liquidityAcceleration.score>=60,
    threeSecondBuyPressureConfirmed,fiveTrend>=65,Number.isFinite(closeLocation)&&closeLocation>=68
  ].filter(Boolean).length;
  const flashTrigger=direction==='UP_SURGE'&&buyPressureConfirmed&&threeSecondBuyPressureConfirmed&&flashScore>=74&&flashConfirmations>=4&&
    ((Number.isFinite(r3)&&r3>=0.45)||(Number.isFinite(volumeRatio)&&volumeRatio>=1.50)||microBreak||breakUp);
  const score=Math.max(compositeScore,flashScore);
  const alternateTrigger=
    (Number.isFinite(shortReturn)&&shortReturn>=0.65)||
    (Number.isFinite(volumeRatio)&&volumeRatio>=2.5&&compositeScore>=72)||
    (Number.isFinite(accel)&&accel>=0.45&&compositeScore>=72);
  const triggerChecks=[
    {code:'TAKER_BUY_QUOTE_RATIO_GT_70_PERCENT',eligible:buyPressureConfirmed,observed:buyRatio,operator:'>',threshold:0.70},
    {code:'THREE_SECOND_TAKER_BUY_RATIO_GT_70_PERCENT',eligible:threeSecondBuyPressureConfirmed,observed:threeSecondLiquidity.taker_buy_ratio??null,operator:'>',threshold:0.70},
    {code:'STRONG_MOVE_SCORE_GE_74',eligible:score>=74,observed:score,operator:'>=',threshold:74},
    {code:'FLASH_OR_ALTERNATE_PRICE_TRIGGER',eligible:Boolean(flashTrigger||alternateTrigger),observed:{flash_trigger:flashTrigger,alternate_trigger:alternateTrigger,return_3m:shortReturn,volume_ratio:volumeRatio,acceleration:accel,composite_score:compositeScore},operator:'OR',threshold:null}
  ];
  const triggerFailures=triggerChecks.filter(x=>!x.eligible).map(x=>x.code);
  const strongTrigger=triggerFailures.length===0;
  const stage=strongTrigger?(score>=88?'EXPLOSIVE':'STRONG_MOVE'):score>=68?'BUILDING':'WATCH';

  const reasons=[];
  const push=(ok,s)=>{if(ok)reasons.push(s)};
  push(Number.isFinite(r3)&&Math.abs(r3)>=0.65,'3m momentum burst');
  push(Number.isFinite(accel)&&accel>=0.30,'price acceleration');
  push(Number.isFinite(volumeRatio)&&volumeRatio>=2,'volume climax');
  push(Number.isFinite(tradeRatio)&&tradeRatio>=1.8,'trade-count surge');
  push(buyPressureConfirmed,'taker-buy quote-volume ratio >70%');
  push(threeSecondBuyPressureConfirmed,'3s taker-buy quote-volume ratio >70%');
  push(Number.isFinite(liquidityAcceleration.three_minute_acceleration)&&liquidityAcceleration.three_minute_acceleration>0,'3m liquidity acceleration');
  push(Number.isFinite(buyDelta)&&buyDelta>=0.015,'taker-flow acceleration');
  push(Number.isFinite(rangeRatio)&&rangeRatio>=1.5,'range expansion');
  push(breakUp,'Donchian breakout');
  push(Number.isFinite(bbExpansion)&&bbExpansion>=1.25,'Bollinger expansion');
  push(Number.isFinite(efficiency)&&efficiency>=0.45,'directional efficiency');
  push(Number.isFinite(atrRatio)&&atrRatio>=1.3,'ATR expansion');
  push(Number.isFinite(vwapDistance)&&vwapDistance>=0.5,'VWAP displacement');

  return {
    eligible:strongTrigger,
    trigger_diagnostics:{eligible:strongTrigger,checks:triggerChecks,failed_checks:triggerFailures},
    closed_candles_only:true,
    source_candle_close_at:finite(last?.closeTime),
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
      taker_buy_quote_volume_ratio:buyRatio,taker_buy_pressure_confirmed:buyPressureConfirmed,independent_confirmations:independentConfirmations,
      liquidity_acceleration:liquidityAcceleration,three_second_liquidity:threeSecondLiquidity,three_second_taker_buy_ratio:threeSecondLiquidity.taker_buy_ratio??null,
      range_ratio:rangeRatio,breakout_up:breakUp,breakout_down:breakDown,breakout_distance_up_pct:breakoutDistanceUp,
      breakout_distance_down_pct:breakoutDistanceDown,ema9,ema21,ema55,vwap,vwap_distance_pct:vwapDistance,
      bb_width:bbWidth,bb_expansion_ratio:bbExpansion,efficiency_ratio:efficiency,atr_ratio:atrRatio,
      five_min_return:fiveReturn,five_min_trend:fiveTrend
    },
    component_scores:{
      velocity:velocityScore,volume:volumeScore,trades:tradeScore,taker:takerScore,range:rangeScore,
      flash:flashScore,liquidity_acceleration:liquidityAcceleration.score,liquidity_3s:liquidity3sScore,
      breakout:breakoutScore,ema:emaBurst,vwap:vwapImpulse,bollinger:bbScore,efficiency:efficiencyScore,atr:atrScore
    },
    trigger:{
      min_3m_move_pct:0.45,
      min_score:74,
      flash_score_trigger:74,
      flash_confirmations:4,
      min_taker_buy_ratio:0.70,min_three_second_taker_buy_ratio:0.70,
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
  const a=buildStrongMoveAnalysis(candidate.one_minute,candidate.five_minute,candidate.ticker,now,candidate.agg_trades||[]);
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
      !Number.isFinite(a.metrics?.taker_buy_ratio)||a.metrics.taker_buy_ratio<=0.70?'TAKER_BUY_PRESSURE_NOT_CONFIRMED':null,
      !a.metrics?.three_second_liquidity?.available?'THREE_SECOND_FLOW_UNAVAILABLE':null,
      Math.abs(finite(ticker.priceChange24h,0))>=20?'24H_ALREADY_EXTENDED':null,
      a.component_scores.taker<45?'SELLING_PRESSURE_HIGH':null,
      a.component_scores.range>90?'VOLATILITY_EXTREME':null
    ].filter(Boolean),
    source:a.source,
    source_candle_close_at:a.source_candle_close_at??null,
    detected_at:now,
    processed_at:now,
    paper_trading:true,
    real_order_execution:false,
    confidence_score:'UNKNOWN',
    eligible:a.eligible,
    disclaimer:'رادار الحركة القوية يلتقط توسعًا/تسارعًا ظهر فعليًا؛ لا يضمن استمرار الحركة أو اتجاهها لاحقًا.'
  };
}


export function finalizeStrongMoveCandidate(alert,row,{now=Date.now(),clock=()=>Date.now(),minScore=76,lastAlertAt=0,alertCooldownMs=0,telemetry=true}={}){
  const decisionStartedAt=Number.isFinite(Number(now))?Number(now):Date.now();
  const alertScore=Math.max(Number(alert?.strong_move?.score)||0,Number(alert?.strong_move?.component_scores?.flash)||0);
  const a=alert?.strong_move||{},cs=a.component_scores||{},m=a.metrics||{};
  const minQuoteVolume=Math.max(1,Number(row?.minQuoteVolume24h)||1_000_000);
  const gate=evaluateEliteGate({
    radar:'STRONG_MOVE_RADAR',
    direction:a.direction,
    baseScore:alertScore,
    priceChange24h:row?.priceChange24h,
    liquidityScore:clamp(70+Math.log10(Math.max(1,Number(row?.quoteVolume24h||0)/minQuoteVolume))*30),
    dataQualityScore:90,
    triggerScore:Number(cs.breakout)||0,structureScore:Number(cs.ema)||0,
    participationScore:mean([Number(cs.volume),Number(cs.trades)])||50,flowScore:Number(cs.taker)||0,
    relativeScore:Number(m.five_min_trend)||50,momentumScore:Number(cs.velocity)||0,compressionScore:Number(cs.bollinger)||0,
    confirmations:Number(m.independent_confirmations)||0,takerBuyRatio:m.taker_buy_ratio,
    requireTakerBuyRatio:true,minTakerBuyRatio:0.70,
    minConfirmations:4,minScore:86,max24hMovePct:8,requireTrigger:true,minCategoryHits:5
  });
  alert.elite_gate=gate;
  const notificationGate=evaluateRadarNotificationGate(alert,{now,telemetry:false});
  const failures=[...(notificationGate.failures||[])];
  if(!alert?.eligible)failures.push('BASE_ALERT_NOT_ELIGIBLE');
  if(alertScore<Number(minScore))failures.push('RADAR_SCORE_BELOW_MINIMUM');
  if(!gate.eligible)failures.push('ELITE_GATE_NOT_ELIGIBLE');
  const cooldownAt=Number(lastAlertAt)||0;
  const cooldown=Math.max(0,Number(alertCooldownMs)||0);
  const inCooldown=cooldownAt>0&&now-cooldownAt<cooldown;
  if(inCooldown)failures.push('SYMBOL_ALERT_COOLDOWN');
  const accepted=Boolean(alert?.eligible)&&alertScore>=Number(minScore)&&gate.eligible&&notificationGate.eligible&&!inCooldown;
  const finalGate={...notificationGate,eligible:accepted,failures:[...new Set(failures)],stage_decision:accepted?'GATE_ACCEPTED':'REJECTED'};
  const completedRaw=typeof clock==='function'?clock():decisionStartedAt;
  const decisionCompletedAt=Number.isFinite(Number(completedRaw))?Number(completedRaw):decisionStartedAt;
  finalGate.decision_started_at=decisionStartedAt;
  finalGate.decision_completed_at=decisionCompletedAt;
  alert.notification_gate=finalGate;
  if(telemetry)recordRadarDecision(alert,finalGate,{now:decisionCompletedAt,extraReasons:[]});
  return {accepted,alertScore,gate,notificationGate:finalGate,decisionStartedAt,decisionCompletedAt,alert};
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
    if(typeof this.rest.aggTrades!=='function')throw new Error('AGG_TRADES_UNAVAILABLE');
    const tradeFlow=await this.rest.aggTrades(row.symbol,{limit:1000,endTime:this.clock()});
    const sourceObservedAt=Math.max(
      Number(one?.receivedAt)||0,Number(five?.receivedAt)||0,Number(tradeFlow?.receivedAt)||0
    )||this.clock();
    const alert=buildStrongMoveAlert({
      ticker:row,one_minute:one.candles,five_minute:five.candles,agg_trades:tradeFlow.trades??tradeFlow.data??[]
    },sourceObservedAt);
    this.scans++;
    alert.observed_at=sourceObservedAt;
    alert.source_event_at=alert.source_candle_close_at==null?null:finite(alert.source_candle_close_at);
    alert.source_data_age_ms=alert.source_event_at==null?null:Math.max(0,sourceObservedAt-alert.source_event_at);
    const restHealth=this.rest?.health?.()||{};
    alert.rest_queue_depth=finite(restHealth.queue_depth);
    alert.rest_queue_wait_ms=finite(restHealth.queue_wait_ms_last);
    const decisionStartedAt=this.clock();
    alert.processed_at=decisionStartedAt;
    const finalized=finalizeStrongMoveCandidate(alert,{...row,minQuoteVolume24h:this.config.minQuoteVolume24h},{
      now:decisionStartedAt,clock:this.clock,minScore:this.config.minScore,lastAlertAt:this.lastAlertAt.get(row.symbol)||0,
      alertCooldownMs:this.config.alertCooldownMs,telemetry:true
    });
    if(!finalized.accepted)return alert;
    this.lastAlertAt.set(row.symbol,observedAt);
    const decorated=decorateRadarAlert(alert,'Radar 2 — Strong-Move');
    await this.store.appendStrongMoveAlert(decorated);
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
      algorithms:['MOMENTUM_BURST','NORMALIZED_FLASH_SCORE','EQUAL_3M_VOLUME_WINDOWS','MAD_WINSORIZED_1M_3M_LIQUIDITY','AGG_TRADES_3S_ACCELERATION','TAKER_BUY_QUOTE_RATIO_GT_70_PERCENT','INDEPENDENT_CONFLUENCE_FAMILIES','DONCHIAN_BREAKOUT','EMA_BURST','VWAP_DISPLACEMENT','BOLLINGER_EXPANSION','ATR_EXPANSION'],
      source:'Binance Public REST',
      closed_candles_only:true,
      paper_trading:true,
      real_order_execution:false,
      confidence_score:'UNKNOWN'
    };
  }
}
