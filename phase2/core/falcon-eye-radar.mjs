import {buildSpotUniverse,normalizeTickerRow} from '../market/universe-scanner.mjs';
import {updateMarketPulseHistory} from './falcon-market-pulse.mjs';
import {decorateRadarAlert} from './radar-alert-meta.mjs';
import {evaluateRadarNotificationGate} from './radar-notification-gate.mjs';
import {assessPreExpansionFingerprint,measureGradualParticipation} from './pre-expansion-fingerprint.mjs';
import {assessQuietBaseActivityShock} from './activity-shock.mjs';
import {recordPreExpansionSignals,updatePreExpansionMarkouts,maybeLogPreExpansionOutcomeReport,importHistoricalPreExpansionSignals,backfillHistoricalPreExpansionOutcomes} from './pre-expansion-outcome-tracker.mjs';

function normalizeRadarTickerRow(row,quote){
  const normalized=normalizeTickerRow(row,quote);
  if(normalized)return normalized;
  if(!row||typeof row.symbol!=='string'||!/^[A-Z0-9]{5,30}$/i.test(row.symbol))return null;
  const lastPrice=Number(row.lastPrice),quoteVolume=Number(row.quoteVolume),count=Number(row.count);
  if(!Number.isFinite(lastPrice)||lastPrice<=0||!Number.isFinite(quoteVolume)||quoteVolume<0||!Number.isFinite(count)||count<0)return null;
  const rawChange=row.priceChangePercent;
  const dailyKnown=rawChange!==null&&rawChange!==undefined&&!(typeof rawChange==='string'&&rawChange.trim()==='')&&Number.isFinite(Number(rawChange));
  const high=Number(row.highPrice),low=Number(row.lowPrice);
  const tickerTime=['closeTime','eventTime','openTime'].map(key=>Number(row[key])).find(Number.isFinite)??null;
  return {
    symbol:String(row.symbol).toUpperCase(),quoteAsset:String(quote).toUpperCase(),
    lastPrice,quoteVolume24h:quoteVolume,tradeCount24h:count,
    priceChange24h:dailyKnown?Number(rawChange):null,
    highPrice24h:Number.isFinite(high)&&high>0?high:null,
    lowPrice24h:Number.isFinite(low)&&low>0?low:null,tickerTime
  };
}
const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number.isFinite(Number(v))?Number(v):min));
const finite=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const hasFiniteValue=v=>v!==null&&v!==undefined&&!(typeof v==='string'&&v.trim()==='')&&Number.isFinite(Number(v));
const dailyMoveAbs=row=>hasFiniteValue(row?.priceChange24h)?Math.abs(Number(row.priceChange24h)):null;
const avg=xs=>{const a=xs.map(Number).filter(Number.isFinite);return a.length?a.reduce((s,x)=>s+x,0)/a.length:null;};
const median=xs=>{const a=xs.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;};
const pct=(a,b)=>Number.isFinite(Number(a))&&Number.isFinite(Number(b))&&Number(b)!==0?(Number(a)-Number(b))/Math.abs(Number(b))*100:null;
const safeRows=(rows,now)=> (Array.isArray(rows)?rows:[]).filter(c=>
  c?.closed!==false &&
  Number.isFinite(Number(c?.openTime)) && Number.isFinite(Number(c?.closeTime)) &&
  Number(c.closeTime)<=Number(now) &&
  Number(c.close)>0 && Number(c.high)>=Number(c.low) && Number(c.low)>0 &&
  Number.isFinite(Number(c.volume))
).sort((a,b)=>Number(a.openTime)-Number(b.openTime));

function ema(values,period){
  const xs=values.map(Number).filter(Number.isFinite); if(!xs.length)return null;
  const p=Math.max(2,Math.trunc(period));
  let out=avg(xs.slice(0,Math.min(p,xs.length)));
  if(!Number.isFinite(out))return null;
  const alpha=2/(p+1);
  for(const x of xs.slice(Math.min(p,xs.length)))out=alpha*x+(1-alpha)*out;
  return out;
}
function stdev(values){const xs=values.map(Number).filter(Number.isFinite);if(xs.length<2)return null;const m=avg(xs);return Math.sqrt(avg(xs.map(x=>(x-m)**2)));}

function bollingerStats(closes){
  const now=closes.slice(-20),base=closes.slice(-50,-20);
  const m=avg(now),sd=stdev(now),bm=avg(base),bsd=stdev(base);
  const width=Number.isFinite(m)&&m>0&&Number.isFinite(sd)?4*sd/m:null;
  const baseWidth=Number.isFinite(bm)&&bm>0&&Number.isFinite(bsd)?4*bsd/bm:null;
  return {width,base_width:baseWidth,ratio:Number.isFinite(width)&&Number.isFinite(baseWidth)&&baseWidth>0?width/baseWidth:null};
}

function atrRatio(candles){
  const trs=[];
  for(let i=1;i<candles.length;i++){
    const h=Number(candles[i].high),l=Number(candles[i].low),pc=Number(candles[i-1].close);
    trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  const now=avg(trs.slice(-14)),base=median(trs.slice(-44,-14));
  return {now,base,ratio:Number.isFinite(now)&&Number.isFinite(base)&&base>0?now/base:null};
}

function higherLowScore(candles){
  const rows=candles.slice(-12), lows=rows.map(x=>Number(x.low)).filter(Number.isFinite);
  if(lows.length<8)return 40;
  const groups=[lows.slice(-4),lows.slice(-8,-4)];
  const a=avg(groups[0]),b=avg(groups[1]);
  if(!Number.isFinite(a)||!Number.isFinite(b)||b<=0)return 40;
  const rise=(a-b)/b*100;
  const monotonic=rows.slice(-6).every((x,i,a)=>i===0||Number(x.low)>=Number(a[i-1].low)*0.995);
  return clamp(50+rise*18+(monotonic?18:0));
}

function vwap(candles){
  const rows=candles.slice(-30);
  let num=0,den=0;
  for(const x of rows){
    const vol=Math.max(0,Number(x.volume)||0);
    num+=((Number(x.high)+Number(x.low)+Number(x.close))/3)*vol; den+=vol;
  }
  return den>0?num/den:null;
}

function takerStats(candles){
  const recent=candles.slice(-4),base=candles.slice(-16,-4);
  const ratio=(rows)=>{
    const vol=rows.reduce((s,x)=>s+Math.max(0,Number(x.volume)||0),0);
    const buy=rows.reduce((s,x)=>s+Math.max(0,Number(x.takerBuyBaseVolume)||0),0);
    return vol>0?buy/vol:null;
  };
  const recentRatio=ratio(recent),baseRatio=ratio(base);
  return {ratio:recentRatio,base:baseRatio,delta:Number.isFinite(recentRatio)&&Number.isFinite(baseRatio)?recentRatio-baseRatio:null};
}

function tradeAndVolumeStats(candles){
  const vols=candles.map(x=>Number(x.volume)),trades=candles.map(x=>Number(x.tradeCount));
  const recentVol=avg(vols.slice(-4)),baseVol=median(vols.slice(-28,-4));
  const recentTrades=avg(trades.slice(-4)),baseTrades=median(trades.slice(-28,-4));
  return {
    volume_ratio:Number.isFinite(recentVol)&&Number.isFinite(baseVol)&&baseVol>0?recentVol/baseVol:null,
    trade_ratio:Number.isFinite(recentTrades)&&Number.isFinite(baseTrades)&&baseTrades>0?recentTrades/baseTrades:null
  };
}

function microBreakout(candles){
  const last=Number(candles.at(-1)?.close);
  const prior=candles.slice(-31,-1);
  const high=Math.max(...prior.map(x=>Number(x.high)).filter(Number.isFinite));
  const low=Math.min(...prior.map(x=>Number(x.low)).filter(Number.isFinite));
  return {
    high,low,
    break_up:Number.isFinite(last)&&Number.isFinite(high)&&last>=high,
    break_down:Number.isFinite(last)&&Number.isFinite(low)&&last<=low,
    distance_up_pct:Number.isFinite(last)&&Number.isFinite(high)&&high>0?(last-high)/high*100:null
  };
}

function relativeStrength(one,five,btcOne,btcFive){
  const coin5=pct(Number(five.at(-1)?.close),Number(five.at(-2)?.close));
  const coin15=pct(Number(five.at(-1)?.close),Number(five.at(-4)?.close));
  const btc5=btcFive?.length>1?pct(Number(btcFive.at(-1)?.close),Number(btcFive.at(-2)?.close)):null;
  const btc15=btcFive?.length>3?pct(Number(btcFive.at(-1)?.close),Number(btcFive.at(-4)?.close)):null;
  const spread5=Number.isFinite(coin5)&&Number.isFinite(btc5)?coin5-btc5:null;
  const spread15=Number.isFinite(coin15)&&Number.isFinite(btc15)?coin15-btc15:null;
  return {coin_5m:coin5,btc_5m:btc5,spread_5m:spread5,coin_15m:coin15,btc_15m:btc15,spread_15m:spread15};
}

function liquidationStats(rows,now){
  const a=(Array.isArray(rows)?rows:[]).filter(x=>Number(x?.time)<=Number(now)&&Number(x?.price)>0&&Number(x?.origQty)>0);
  let shortLiq=0,longLiq=0;
  for(const x of a){
    const n=Number(x.price)*Number(x.origQty);
    const side=String(x.side||'').toUpperCase();
    if(side==='BUY')shortLiq+=n; else if(side==='SELL')longLiq+=n;
  }
  return {available:a.length>0,count:a.length,short_liquidation_notional:shortLiq,long_liquidation_notional:longLiq,total_notional:shortLiq+longLiq};
}

function derivativesQuality(futures,previousFutures,spotQuoteVolume,liquidations){
  const fv=finite(futures?.quoteVolume,null),oi=finite(futures?.openInterest,null),funding=finite(futures?.fundingRate,null);
  const f2s=Number.isFinite(fv)&&spotQuoteVolume>0?fv/spotQuoteVolume:null;
  const oiDelta=Number.isFinite(oi)&&Number.isFinite(previousFutures?.openInterest)&&previousFutures.openInterest>0
    ?(oi-previousFutures.openInterest)/previousFutures.openInterest*100:null;
  const fundingScore=Number.isFinite(funding)?clamp(
    funding<=-0.006?96:
    funding<=-0.003?90:
    funding<=-0.0015?82:
    funding<0?72:
    funding<=0.001?50:
    40
  ):50;
  const oiScore=Number.isFinite(oiDelta)?clamp(58+oiDelta*5):50;
  const ratioScore=Number.isFinite(f2s)?clamp(48+Math.log10(Math.max(1,f2s))*32):50;
  const liqScore=liquidations?.available
    ?clamp(50+Math.min(45,liquidations.short_liquidation_notional/(Math.max(1,spotQuoteVolume))*220))
    :50;
  return {
    futures_available:Boolean(Number.isFinite(fv)||Number.isFinite(oi)||Number.isFinite(funding)),
    futures_quote_volume:fv,open_interest:oi,funding_rate:funding,futures_spot_volume_ratio:f2s,oi_change_pct:oiDelta,
    funding_score:fundingScore,oi_score:oiScore,derivatives_volume_score:ratioScore,liquidation_score:liqScore
  };
}

export function buildFalconEyeAnalysis({
  ticker={},oneMinute=[],fiveMinute=[],btcOneMinute=[],btcFiveMinute=[],futures={},previousFutures=null,liquidations=[],now=Date.now(),config={}
}={}){
  const one=safeRows(oneMinute,now),five=safeRows(fiveMinute,now),btc1=safeRows(btcOneMinute,now),btc5=safeRows(btcFiveMinute,now);
  const activityShock=assessQuietBaseActivityShock({fiveMinute:five,ticker,now,config});
  if(one.length<70||five.length<30){
    return {eligible:false,stage:'INSUFFICIENT_DATA',pre_expansion_stage:'DATA_INSUFFICIENT',pre_expansion_fingerprint:{stage:'DATA_INSUFFICIENT',reason:'CLOSED_CANDLES_INSUFFICIENT'},activity_shock:activityShock,score:null,closed_candles_only:true,one_minute_count:one.length,five_minute_count:five.length};
  }
  const price=finite(ticker.lastPrice,null);
  const move24=hasFiniteValue(ticker.priceChange24h)?Number(ticker.priceChange24h):null;
  const closes=one.map(x=>Number(x.close));
  const r1=pct(Number(one.at(-1)?.close),Number(one.at(-2)?.close));
  const r3=pct(Number(one.at(-1)?.close),Number(one.at(-4)?.close));
  const r5=pct(Number(one.at(-1)?.close),Number(one.at(-6)?.close));
  const r10=pct(Number(one.at(-1)?.close),Number(one.at(-11)?.close));
  const r20=pct(Number(one.at(-1)?.close),Number(one.at(-21)?.close));
  const prev10=pct(Number(one.at(-11)?.close),Number(one.at(-21)?.close));
  const accel=Number.isFinite(r10)&&Number.isFinite(prev10)?r10-prev10:null;
  const last=one.at(-1),lastClose=Number(last.close),range=Math.max(0,Number(last.high)-Number(last.low));
  const closeLocation=range>0?(lastClose-Number(last.low))/range*100:50;
  const va=tradeAndVolumeStats(one),tk=takerStats(one),bb=bollingerStats(closes),atr=atrRatio(one),br=microBreakout(one);
  const e9=ema(closes,9),e21=ema(closes,21),e55=ema(closes,55),v=vwap(one);
  const e21Distance=Number.isFinite(e21)&&e21>0?(lastClose-e21)/e21*100:null;
  const vwapDistance=Number.isFinite(v)&&v>0?(lastClose-v)/v*100:null;
  const hl=higherLowScore(one);
  const rel=relativeStrength(one,five,btc1,btc5);
  const liq=liquidationStats(liquidations,now);
  const d=derivativesQuality(futures,previousFutures,Math.max(1,Number(ticker.quoteVolume24h)||0),liq);
  const recentRange=avg(one.slice(-5).map(x=>Number(x.high)-Number(x.low)));
  const baseRange=median(one.slice(-35,-5).map(x=>Number(x.high)-Number(x.low)));
  const rangeRatio=Number.isFinite(recentRange)&&Number.isFinite(baseRange)&&baseRange>0?recentRange/baseRange:null;
  const bodyPath=one.slice(-10).reduce((s,x)=>s+Math.abs(Number(x.close)-Number(x.open)),0);
  const net=Math.abs(lastClose-Number(one.at(-11)?.close));
  const efficiency=bodyPath>0?net/bodyPath:null;
  const resistanceGap=Number.isFinite(br.high)&&br.high>0?(br.high-lastClose)/br.high*100:null;
  const compressionScore=clamp(
    (Number.isFinite(bb.ratio)?clamp(92-Math.max(0,bb.ratio-0.8)*75):50)*0.58+
    (Number.isFinite(atr.ratio)?clamp(92-Math.max(0,atr.ratio-0.85)*70):50)*0.42
  );
  const expansionScore=clamp(
    (Number.isFinite(rangeRatio)?50+(rangeRatio-1)*60:50)*0.40+
    (Number.isFinite(atr.ratio)?50+(atr.ratio-1)*55:50)*0.25+
    (Number.isFinite(bb.ratio)?50+(bb.ratio-1)*55:50)*0.20+
    (Number.isFinite(accel)?50+accel*20:50)*0.15
  );
  const momentumScore=clamp(
    (Number.isFinite(r3)?50+r3*26:50)*0.25+
    (Number.isFinite(r5)?50+r5*18:50)*0.20+
    (Number.isFinite(accel)?50+accel*20:50)*0.20+
    (Number.isFinite(r1)?50+r1*48:50)*0.10+
    (Number.isFinite(r20)?50+r20*8:50)*0.25
  );
  const volumeScore=Number.isFinite(va.volume_ratio)?clamp(46+(va.volume_ratio-1)*31):45;
  const tradeScore=Number.isFinite(va.trade_ratio)?clamp(46+(va.trade_ratio-1)*30):45;
  const takerScore=Number.isFinite(tk.ratio)?clamp(50+(tk.ratio-.5)*250+(Number.isFinite(tk.delta)?tk.delta*160:0)):45;
  const structureScore=clamp(
    hl*0.55+
    (Number.isFinite(e21)&&lastClose>=e21?82:42)*0.20+
    (Number.isFinite(e9)&&Number.isFinite(e21)&&e9>=e21?82:45)*0.12+
    (Number.isFinite(e55)&&lastClose>=e55?78:44)*0.13
  );
  const resistanceScore=Number.isFinite(resistanceGap)
    ?clamp(resistanceGap<0?86+Math.min(14,Math.abs(resistanceGap)*12):100-Math.min(50,resistanceGap*38))
    :50;
  const relativeScore=clamp(
    (Number.isFinite(rel.spread_5m)?50+rel.spread_5m*36:50)*0.56+
    (Number.isFinite(rel.spread_15m)?50+rel.spread_15m*22:50)*0.44
  );
  const antiChasePenalty =
    (Number.isFinite(move24)&&move24>8?28:0)+
    (Number.isFinite(r10)&&r10>3.8?24:0)+
    (Number.isFinite(r5)&&r5>2.5?18:0)+
    (Number.isFinite(e21Distance)&&e21Distance>4?18:0)+
    (Number.isFinite(resistanceGap)&&resistanceGap<-1.2&&Number.isFinite(r5)&&r5>2?16:0);
  const quietScore=clamp(
    (Number.isFinite(move24)?100-Math.min(100,Math.max(0,Math.abs(move24)-1)*8):50)*0.52+
    (Number.isFinite(r10)?100-Math.min(100,Math.max(0,r10-0.5)*24):50)*0.26+
    (Number.isFinite(e21Distance)?100-Math.min(100,Math.abs(e21Distance)*18):50)*0.22
  );
  const derivativeScore=clamp(
    d.funding_score*.30+d.oi_score*.28+d.derivatives_volume_score*.22+d.liquidation_score*.20
  );
  const score=clamp(
    quietScore*.13+
    compressionScore*.10+
    momentumScore*.10+
    volumeScore*.10+
    tradeScore*.07+
    takerScore*.10+
    structureScore*.10+
    resistanceScore*.07+
    relativeScore*.08+
    derivativeScore*.15+
    expansionScore*.05-
    antiChasePenalty*.20
  );
  const confirmations=[
    quietScore>=68,
    compressionScore>=62,
    momentumScore>=58,
    volumeScore>=62,
    tradeScore>=60,
    takerScore>=62,
    structureScore>=68,
    resistanceScore>=70,
    relativeScore>=60,
    derivativeScore>=62,
    hl>=62,
    d.futures_available,
    Number.isFinite(d.oi_change_pct)&&d.oi_change_pct>0,
    Number.isFinite(d.funding_rate)&&d.funding_rate<0
  ].filter(Boolean).length;
  const notChasing=antiChasePenalty<20 &&
    (!Number.isFinite(move24)||Math.abs(move24)<=8) &&
    (!Number.isFinite(r10)||Math.abs(r10)<=3.8) &&
    (!Number.isFinite(r5)||Math.abs(r5)<=2.5) &&
    (!Number.isFinite(e21Distance)||e21Distance<=4.2) &&
    (!Number.isFinite(resistanceGap)||resistanceGap>=-1.2);
  const independentFlowConfirmation=takerScore>=60||(activityShock.detected===true&&activityShock.score>=76&&!activityShock.extended);
  const earlyStructure=
    score>=78&&confirmations>=8&&notChasing&&
    volumeScore>=60&&tradeScore>=58&&independentFlowConfirmation&&
    (structureScore>=68||hl>=70)&&
    (Number.isFinite(resistanceGap)&&resistanceGap<=1.4||br.break_up);
  const ignition=
    score>=84&&confirmations>=9&&notChasing&&
    (br.break_up||Number.isFinite(r3)&&r3>=0.35)&&
    volumeScore>=62&&(takerScore>=62||(activityShock.detected===true&&activityShock.score>=76&&!activityShock.extended));
  const volumeTrend=measureGradualParticipation(one.map(x=>x.quoteVolume??x.volume));
  const tradeTrend=measureGradualParticipation(one.map(x=>x.tradeCount));
  const currentAtrPct=Number.isFinite(atr.now)&&lastClose>0?atr.now/lastClose*100:null;
  const resistanceDistanceAtr=Number.isFinite(resistanceGap)&&Number.isFinite(currentAtrPct)&&currentAtrPct>0
    ?resistanceGap/currentAtrPct:null;
  const rsKnown=[rel.spread_5m,rel.spread_15m].filter(Number.isFinite);
  const relativeStrengthBtcPct=rsKnown.length?rsKnown.reduce((sum,x)=>sum+x,0)/rsKnown.length:null;
  const btcMarketReturn15m=btc5.length>=4?pct(Number(btc5.at(-1)?.close),Number(btc5.at(-4)?.close)):null;
  const marketRegimeLabel=Number.isFinite(btcMarketReturn15m)?(btcMarketReturn15m>0?'BULLISH':btcMarketReturn15m<0?'BEARISH':'MIXED'):'UNKNOWN';
  const falseBreakout=Number.isFinite(br.high)&&Number(last.high)>br.high*1.001&&lastClose<br.high&&closeLocation<55;
  const preExpansion=assessPreExpansionFingerprint({
    dataReady:one.length>=70&&five.length>=30&&Number.isFinite(price)&&price>0,
    dailyChangePct:ticker.priceChange24h,lastPrice:price,maxMove24hPct:8,maxMove5mPct:2.5,maxMove10mPct:3.8,maxMove15mPct:6,
    baseScore:hl*0.42+compressionScore*0.38+quietScore*0.20,
    higherLowScore:hl,compressionScore,
    compressionRatio:bb.ratio,rangeCompressionRatio:rangeRatio,bollingerRatio:bb.ratio,atrRatio:atr.ratio,
    volumeRatio:va.volume_ratio,tradeRatio:va.trade_ratio,volumeTrend,tradeTrend,
    relativeStrengthBtcPct,relativeStrengthMarketPct:hasFiniteValue(ticker.relativeStrengthMarket24hPct)?Number(ticker.relativeStrengthMarket24hPct):null,marketRegimeLabel,
    resistanceDistanceAtr,breakoutConfirmed:br.break_up,falseBreakout,
    return5mPct:r5,return10mPct:r10,return15mPct:pct(Number(one.at(-1)?.close),Number(one.at(-16)?.close)),
    alreadyExtended:!notChasing
  });
  const eligible=Boolean((earlyStructure||ignition)&&
    (preExpansion.stage==='PRE_EXPANSION'||preExpansion.stage==='BREAKOUT_DEVELOPING'));
  const stage=ignition?'IGNITION':earlyStructure?'PRE_ATTACK':score>=68?'BUILDING':'WATCH';
  const reasons=[];
  const push=(ok,s)=>{if(ok)reasons.push(s);};
  push(quietScore>=72,'قاعدة هادئة قبل الحركة');
  push(compressionScore>=70,'انكماش ATR/Bollinger');
  push(va.volume_ratio>=1.25,'تسارع الحجم');
  push(va.trade_ratio>=1.20,'تسارع عدد الصفقات');
  push(tk.ratio>=0.515&&tk.delta>=0.005,'تسارع ضغط الشراء');
  push(hl>=68,'Higher-Low / دعم سعري');
  push(Number.isFinite(resistanceGap)&&resistanceGap<=1.4,'اقتراب من المقاومة');
  push(br.break_up,'اختراق مقاومة قصيرة');
  push(relativeScore>=65,'قوة نسبية مقابل BTC');
  push(d.futures_spot_volume_ratio>=3,'العقود تتضخم مقارنة بالسبوت');
  push(d.oi_change_pct>0.5,'Open Interest يرتفع مع الحركة');
  push(d.funding_rate<0,'Funding سلبي: ضغط شورت قابل للانقلاب');
  push(liq.short_liquidation_notional>0,'تصفية مراكز بيع ظاهرة');
  push(expansionScore>=70,'انتقال نظام التذبذب إلى توسع');
  return {
    eligible,stage,pre_expansion_stage:preExpansion.stage,pre_expansion_fingerprint:preExpansion,activity_shock:activityShock,market_regime_label:marketRegimeLabel,closed_candles_only:true,score:Number(score.toFixed(1)),
    confirmation_count:confirmations,not_chasing:notChasing,
    anti_chase_penalty:Number(antiChasePenalty.toFixed(1)),
    metrics:{
      price,last_price:lastClose,move_24h_pct:move24,return_1m:r1,return_3m:r3,return_5m:r5,return_10m:r10,return_20m:r20,acceleration:accel,
      volume_ratio:va.volume_ratio,trade_ratio:va.trade_ratio,taker_buy_ratio:tk.ratio,taker_buy_delta:tk.delta,
      ema9:e9,ema21:e21,ema55:e55,ema21_distance_pct:e21Distance,vwap:v,vwap_distance_pct:vwapDistance,
      resistance_gap_pct:resistanceGap,local_high:br.high,local_low:br.low,micro_breakout:br.break_up,
      bollinger_width:bb.width,bollinger_ratio:bb.ratio,atr_ratio:atr.ratio,range_ratio:rangeRatio,efficiency_ratio:efficiency,
      close_location_pct:closeLocation,higher_low_score:hl,
      relative_strength_5m_spread_pct:rel.spread_5m,relative_strength_15m_spread_pct:rel.spread_15m,
      futures_spot_volume_ratio:d.futures_spot_volume_ratio,open_interest:d.open_interest,oi_change_pct:d.oi_change_pct,
      funding_rate:d.funding_rate,short_liquidation_notional:liq.short_liquidation_notional,long_liquidation_notional:liq.long_liquidation_notional
    },
    component_scores:{
      quietness:quietScore,compression:compressionScore,momentum:momentumScore,volume:volumeScore,trades:tradeScore,taker:takerScore,
      structure:structureScore,resistance:resistanceScore,relative_strength:relativeScore,derivatives:derivativeScore,
      breakout:br.break_up?94:resistanceScore,ema:Number.isFinite(e21Distance)?clamp(75-e21Distance*16):50,
      vwap:Number.isFinite(vwapDistance)?clamp(55+vwapDistance*24):50,bollinger:compressionScore,efficiency:Number.isFinite(efficiency)?clamp(35+efficiency*85):45,
      atr:expansionScore,range:expansionScore
    },
    derivatives:d,
    liquidations:liq,
    trigger:{min_score:78,ignition_score:84,min_confirmations:8,max_abs_24h_move_pct:8,max_10m_move_pct:3.8,max_5m_move_pct:2.5,max_ema21_distance_pct:4.2},
    alert_quality:{sniper_freshness:Number(clamp(100-antiChasePenalty*2.6).toFixed(1)),early_structure:earlyStructure,ignition:ignition,not_chasing:notChasing},
    reasons:[...new Set(reasons)].slice(0,14),
    source:'Binance Public REST (Spot + public Futures)',
    detected_at:now,processed_at:now,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
  };
}

export function buildFalconEyeAlert(input,now=Date.now(),config={}){
  const a=buildFalconEyeAnalysis({...input,now,config});
  const t=input.ticker||{};
  return {
    id:'FALCON:'+String(t.symbol||'UNKNOWN').toUpperCase()+':'+now,
    event:'FALCON_EYE_ALERT',
    radar:'FALCON_EYE_RADAR',
    symbol:String(t.symbol||'UNKNOWN').toUpperCase(),
    market:'SPOT',direction:'UP_PREBREAKOUT',
    price:finite(t.lastPrice),price_change_24h:hasFiniteValue(t.priceChange24h)?Number(t.priceChange24h):null,
    opportunity_score:a.score,potential_label:a.pre_expansion_stage??a.stage,
    falcon_eye:a,reasons:a.reasons,activity_shock:a.activity_shock??null,
    data_quality:90,liquidity_quality:clamp(62+Math.log10(Math.max(1,(Number(t.quoteVolume24h)||0)/1000000))*22),
    confirmation_count:a.confirmation_count,
    pre_breakout_fingerprint:{
      ready:a.eligible,score:a.score,late:!a.not_chasing,pre_expansion_stage:a.pre_expansion_stage??'DATA_INSUFFICIENT',micro_move:false,
      impulse_quality_score:a.component_scores.momentum,
      confirmation_count:a.confirmation_count
    },
    risk_flags:[
      (a.pre_expansion_stage==='ALREADY_EXTENDED'||(hasFiniteValue(t.priceChange24h)&&Math.abs(Number(t.priceChange24h))>=8))?'ALREADY_EXTENDED':null,
      a.not_chasing?null:'EXTENDED_CHASE',
      Number(a.metrics?.funding_rate)>0.004?'POSITIVE_FUNDING_CROWDING':null,
      Number(a.metrics?.resistance_gap_pct)<-1.2?'RESISTANCE_BROKEN_EXTENDED':null
    ].filter(Boolean),
    source:a.source,detected_at:now,processed_at:now,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
    eligible:Boolean(a.eligible),pre_expansion_stage:a.pre_expansion_stage??'DATA_INSUFFICIENT',
    disclaimer:'عين الصقر تبحث عن تشابهات ما قبل انفجار OGN: قاعدة + توسع مشاركة + ضغط شراء + مقاومة/اختراق + مشتقات عند توفرها. لا تضمن ارتفاعًا أو ربحًا.'
  };
}

export class FalconEyeRadar {
  constructor({rest,futuresRest=null,store,pushManager=null,config={},clock=()=>Date.now(),logger=console}={}){
    if(!rest)throw new Error('REST_CLIENT_REQUIRED');
    if(!store)throw new Error('STORE_REQUIRED');
    this.clock=typeof clock==='function'?clock:()=>Date.now();
    this.rest=rest;this.futuresRest=futuresRest;this.store=store;this.pushManager=pushManager;this.config={
      quote:'USDT',pollMs:30000,universeRefreshMs:5*60*1000,minQuoteVolume24h:500000,fastMinQuoteVolume24h:200000,
      scanBatchSize:8,pulseTopCandidates:3,quietCandidates:2,patrolBatchSize:2,deepScanMinIntervalMs:90_000,deepConcurrency:3,
      maxExtended24hMovePct:18,maxQuiet24hMovePct:8,quietMinBaseScore:55,quietMinCompressionScore:60,
      quietMinHigherLowScore:60,quietMinParticipationScore:58,quietMinBurstRatio:1.08,
      exceptionalRotationBypassSlots:2,exceptionalVolumeBurstRatio:2.2,exceptionalTradeBurstRatio:1.8,
      alertCooldownMs:45*60*1000,maxAlertsPerHour:3,minScore:78,
      ...config
    };
    this.running=false;this.timer=null;this.universe=[];this.universeAt=0;this.cursor=0;
    this.lastScanAt=new Map();this.lastSelectedAt=new Map();this.lastSelectionCycleBySymbol=new Map();this.selectionCycle=0;
    this.lastAlertAt=new Map();this.lastFutures=new Map();this.alertTimestamps=[];
    this.scans=0;this.alertCount=0;this.lastScanAtMs=null;this.lastError=null;this.busy=false;this.latestCandidates=[];this.lastBatchSymbols=[];this.lastBatchAt=null;this.lastPatrolVisits=0;
    this.pulseHistory=new Map();this.marketCoverage=0;this.pulseReadyCount=0;this.marketBreadthPct=0;this.fastCandidates=0;
    this.lastSelectionStats={cycle:0,input_rows:0,eligible_total:0,target:0,selected_total:0,quiet_selected:0,patrol_selected:0,exceptional_bypass_selected:0,incomplete_selected:0,shortfall:0,selected_symbols:[]};
  }
  start(){
    if(this.running)return;
    this.running=true;this.lastError=null;
    this.refreshUniverse().then(()=>this.tick()).catch(e=>{this.lastError=String(e?.message??e);});
    this.timer=setInterval(()=>this.tick().catch(e=>{this.lastError=String(e?.message??e);}),this.config.pollMs);
  }
  async stop(){this.running=false;if(this.timer)clearInterval(this.timer);this.timer=null;}
  async refreshUniverse(){
    const info=await this.rest.request('/api/v3/exchangeInfo');
    const symbols=buildSpotUniverse(info.data,this.config.quote);
    this.universe=symbols.filter(x=>x.symbol).map(x=>x.symbol);
    this.universeAt=this.clock();this.cursor=0;
  }
  async tickerRows(){
    const r=await this.rest.request('/api/v3/ticker/24hr');
    const raw=(Array.isArray(r.data)?r.data:[]).map(x=>normalizeRadarTickerRow(x,this.config.quote)).filter(Boolean)
      .filter(x=>x.quoteVolume24h>=this.config.fastMinQuoteVolume24h&&this.universe.includes(x.symbol));
    const marketMoves=raw.map(x=>x.priceChange24h).filter(hasFiniteValue).map(Number);
    const marketMedianChange24hPct=median(marketMoves);
    const benchmarked=raw.map(row=>({...row,
      marketMedianChange24hPct,
      relativeStrengthMarket24hPct:hasFiniteValue(row.priceChange24h)&&Number.isFinite(marketMedianChange24hPct)
        ?Number(row.priceChange24h)-marketMedianChange24hPct:null
    }));
    const pulse=updateMarketPulseHistory(benchmarked,this.pulseHistory,this.clock(),{intervalMs:this.config.pollMs});
    this.marketCoverage=pulse.coverage;this.pulseReadyCount=pulse.readyCount;this.marketBreadthPct=pulse.breadthPct;
    this.fastCandidates=pulse.rows.filter(x=>x.market_pulse?.fast_trigger).length;
    return pulse.rows;
  }
  quietSelectionEvidence(row){
    const move=dailyMoveAbs(row),pulse=row?.market_pulse||{};
    if(move===null||move>Number(this.config.maxQuiet24hMovePct??8)||pulse.ready!==true||pulse.fast_trigger)return null;
    const cached=this.latestCandidates.find(x=>String(x?.symbol||'').toUpperCase()===String(row.symbol).toUpperCase());
    const deep=cached?.falcon_eye||cached||{},components=deep.component_scores||{},metrics=deep.metrics||{};
    const base=hasFiniteValue(pulse.baseBreakScore)?Number(pulse.baseBreakScore):
      hasFiniteValue(components.quietness)?Number(components.quietness):null;
    const compression=hasFiniteValue(pulse.compressionScore)?Number(pulse.compressionScore):
      hasFiniteValue(components.compression)?Number(components.compression):null;
    const higherLow=hasFiniteValue(pulse.higherLowScore)?Number(pulse.higherLowScore):
      hasFiniteValue(metrics.higher_low_score)?Number(metrics.higher_low_score):
      hasFiniteValue(components.structure)?Number(components.structure):null;
    const volume=hasFiniteValue(pulse.volumeBurstRatio)?Number(pulse.volumeBurstRatio):null;
    const trades=hasFiniteValue(pulse.tradeBurstRatio)?Number(pulse.tradeBurstRatio):null;
    const participation=hasFiniteValue(pulse.participationScore)?Number(pulse.participationScore):
      Math.max(hasFiniteValue(components.volume)?Number(components.volume):0,hasFiniteValue(components.trades)?Number(components.trades):0);
    const delta=hasFiniteValue(pulse.priceDeltaPct)?Number(pulse.priceDeltaPct):null;
    const acceleration=hasFiniteValue(pulse.accelerationScore)?Number(pulse.accelerationScore):null;
    const activityEvidence=(volume!==null&&volume>=Number(this.config.quietMinBurstRatio??1.08))||
      (trades!==null&&trades>=Number(this.config.quietMinBurstRatio??1.08))||
      (delta!==null&&delta>0.015&&acceleration!==null&&acceleration>=52)||
      ((hasFiniteValue(components.volume)&&Number(components.volume)>=Number(this.config.quietMinParticipationScore??58))||
       (hasFiniteValue(components.trades)&&Number(components.trades)>=Number(this.config.quietMinParticipationScore??58)));
    if(base===null||compression===null||higherLow===null||
      participation<Number(this.config.quietMinParticipationScore??58)||
      base<Number(this.config.quietMinBaseScore??55)||
      compression<Number(this.config.quietMinCompressionScore??60)||
      higherLow<Number(this.config.quietMinHigherLowScore??60)||!activityEvidence)return null;
    const proximity=hasFiniteValue(pulse.highProximityScore)?Number(pulse.highProximityScore):50;
    return {score:(100-move*6)*.20+base*.15+compression*.20+higherLow*.20+participation*.20+proximity*.05,
      move,base,compression,higherLow,participation,volume,trades,proximity};
  }
  isExceptionalPulseCandidate(row){
    const move=dailyMoveAbs(row),pulse=row?.market_pulse||{};
    if(move===null||move>Number(this.config.maxExtended24hMovePct??18)||pulse.ready!==true||pulse.fast_trigger!==true)return false;
    const volume=hasFiniteValue(pulse.volumeBurstRatio)?Number(pulse.volumeBurstRatio):0;
    const trades=hasFiniteValue(pulse.tradeBurstRatio)?Number(pulse.tradeBurstRatio):0;
    return volume>=Number(this.config.exceptionalVolumeBurstRatio??2.2)||
      trades>=Number(this.config.exceptionalTradeBurstRatio??1.8)||
      (pulse.explosive===true&&move<=Number(this.config.maxQuiet24hMovePct??8));
  }
  selectBatch(rows,now=this.clock()){
    const input=Array.isArray(rows)?rows:[];
    const deduplicated=[...new Map(input.filter(x=>x?.symbol).map(x=>[String(x.symbol).toUpperCase(),x])).values()];
    const usable=deduplicated.filter(row=>{
      const move=dailyMoveAbs(row);
      return move===null||move<=Number(this.config.maxExtended24hMovePct??18);
    });
    const minRescanMs=Math.max(90_000,Number(this.config.deepScanMinIntervalMs)||0,Number(this.config.pollMs||30_000)*2);
    const urgentRescanMs=Math.max(10_000,Number(this.config.pollMs||30_000)*.7);
    const urgent=row=>{
      const p=row?.market_pulse||{};
      return p.stage==='EVENT'||p.explosive===true||
        (hasFiniteValue(p.priceDeltaPct)&&Number(p.priceDeltaPct)>=.55)||
        (hasFiniteValue(p.volumeBurstRatio)&&Number(p.volumeBurstRatio)>=3)||
        (hasFiniteValue(p.tradeBurstRatio)&&Number(p.tradeBurstRatio)>=3)||
        (hasFiniteValue(p.score)&&Number(p.score)>=82&&p.fast_trigger===true);
    };
    const dueRows=usable.filter(row=>{
      const symbol=String(row.symbol).toUpperCase();
      const lastScan=Number(this.lastScanAt.get(symbol)||0);
      const lastSelected=Number(this.lastSelectedAt.get(symbol)||0);
      const last=Math.max(lastScan,lastSelected);
      if(!last)return true;
      const age=now-last;
      return age>=minRescanMs||(urgent(row)&&age>=urgentRescanMs);
    });
    const pulseRanked=dueRows.filter(x=>x.market_pulse?.ready===true&&x.market_pulse?.fast_trigger===true)
      .sort((a,b)=>(Number(b.market_pulse?.score)||0)-(Number(a.market_pulse?.score)||0)||
        (Number(b.market_pulse?.volumeBurstRatio)||0)-(Number(a.market_pulse?.volumeBurstRatio)||0)||
        String(a.symbol).localeCompare(String(b.symbol)));
    const quietRanked=dueRows.map(row=>({row,evidence:this.quietSelectionEvidence(row)}))
      .filter(x=>x.evidence)
      .sort((a,b)=>a.evidence.move-b.evidence.move||b.evidence.score-a.evidence.score||String(a.row.symbol).localeCompare(String(b.row.symbol)))
      .map(x=>x.row);
    const exceptional=pulseRanked.filter(row=>this.isExceptionalPulseCandidate(row));
    const patrolRanked=[...dueRows].sort((a,b)=>{
      const sa=String(a.symbol).toUpperCase(),sb=String(b.symbol).toUpperCase();
      const ta=Math.max(Number(this.lastScanAt.get(sa)||0),Number(this.lastSelectedAt.get(sa)||0));
      const tb=Math.max(Number(this.lastScanAt.get(sb)||0),Number(this.lastSelectedAt.get(sb)||0));
      if(ta!==tb)return ta-tb;
      const ca=this.lastSelectionCycleBySymbol.has(sa)?Number(this.lastSelectionCycleBySymbol.get(sa)):-1;
      const cb=this.lastSelectionCycleBySymbol.has(sb)?Number(this.lastSelectionCycleBySymbol.get(sb)):-1;
      if(ca!==cb)return ca-cb;
      const ia=this.universe.indexOf(sa),ib=this.universe.indexOf(sb);
      const ra=ia<0?Number.MAX_SAFE_INTEGER:(ia-this.cursor+this.universe.length)%Math.max(1,this.universe.length);
      const rb=ib<0?Number.MAX_SAFE_INTEGER:(ib-this.cursor+this.universe.length)%Math.max(1,this.universe.length);
      return ra-rb||sa.localeCompare(sb);
    });

    const batchLimit=Math.min(Math.max(1,Math.min(16,Math.trunc(Number(this.config.scanBatchSize)||8))),dueRows.length);
    const selected=[],seen=new Set(),counts={pulse:0,quiet:0,patrol:0,exceptional:0,incomplete:0};
    const take=(row,lane)=>{
      const symbol=String(row?.symbol||'').toUpperCase();
      if(!symbol||seen.has(symbol)||selected.length>=batchLimit)return false;
      selected.push({...row,_selection_lane:lane});seen.add(symbol);counts[lane]=(counts[lane]||0)+1;
      if(row.market_pulse?.ready!==true||dailyMoveAbs(row)===null)counts.incomplete++;
      return true;
    };
    const takeLane=(pool,quota,lane)=>{
      const limit=Math.max(0,Math.trunc(Number(quota)||0));let added=0;
      for(const row of pool||[]){
        if(selected.length>=batchLimit||added>=limit)break;
        if(take(row,lane))added++;
      }
      return added;
    };
    const exceptionSlots=Math.min(batchLimit,Math.max(0,Math.trunc(Number(this.config.exceptionalRotationBypassSlots)||0)));
    takeLane(exceptional,exceptionSlots,'exceptional');
    takeLane(pulseRanked,this.config.pulseTopCandidates,'pulse');
    takeLane(quietRanked,this.config.quietCandidates,'quiet');
    takeLane(patrolRanked,this.config.patrolBatchSize,'patrol');
    // Lane overlap must not silently reduce the actual due batch.
    takeLane(pulseRanked,batchLimit-selected.length,'pulse_fill');
    takeLane(quietRanked,batchLimit-selected.length,'quiet_fill');
    takeLane(patrolRanked,batchLimit-selected.length,'patrol_fill');
    takeLane(dueRows,batchLimit-selected.length,'fill_any');

    this.selectionCycle++;
    for(const row of selected){
      const symbol=String(row.symbol).toUpperCase();
      this.lastSelectedAt.set(symbol,now);
      this.lastSelectionCycleBySymbol.set(symbol,this.selectionCycle);
      if(row._selection_lane==='patrol'||row._selection_lane==='patrol_fill'){
        const index=this.universe.indexOf(symbol);
        if(index>=0)this.cursor=(index+1)%Math.max(1,this.universe.length);
      }
    }
    if(this.lastSelectedAt.size>6000){
      const oldest=[...this.lastSelectedAt.entries()].sort((a,b)=>a[1]-b[1]);
      for(const [symbol] of oldest.slice(0,this.lastSelectedAt.size-5000)){
        this.lastSelectedAt.delete(symbol);this.lastSelectionCycleBySymbol.delete(symbol);
      }
    }
    this.lastBatchSymbols=selected.map(row=>row.symbol);
    this.lastBatchAt=now;
    this.lastPatrolVisits=Math.min(this.universe.length,selected.filter(x=>x._selection_lane==='patrol'||x._selection_lane==='patrol_fill').length);
    this.lastSelectionStats={cycle:this.selectionCycle,input_rows:input.length,unique_rows:deduplicated.length,
      eligible_total:usable.length,due_total:dueRows.length,target:batchLimit,selected_total:selected.length,
      pulse_selected:counts.pulse+(counts.pulse_fill||0),quiet_selected:counts.quiet+(counts.quiet_fill||0),
      patrol_selected:counts.patrol+(counts.patrol_fill||0),exceptional_bypass_selected:counts.exceptional,
      incomplete_selected:counts.incomplete,shortfall:Math.max(0,batchLimit-selected.length),selected_symbols:this.lastBatchSymbols.slice()};
    return selected;
  }
  async futuresData(symbol){
    if(!this.futuresRest)return {futures:{},liquidations:[]};
    const safe=async(path)=>{try{const r=await this.futuresRest.request(path);return Array.isArray(r.data)?r.data:(r.data||null);}catch{return null;}};
    const [ticker,oi,funding,liquidations]=await Promise.all([
      safe('/fapi/v1/ticker/24hr?symbol='+encodeURIComponent(symbol)),
      safe('/fapi/v1/openInterest?symbol='+encodeURIComponent(symbol)),
      safe('/fapi/v1/fundingRate?symbol='+encodeURIComponent(symbol)+'&limit=1'),
      safe('/fapi/v1/allForceOrders?symbol='+encodeURIComponent(symbol)+'&limit=50')
    ]);
    const fr=Array.isArray(funding)?funding.at(-1):funding;
    const futuresRow=Array.isArray(ticker)?ticker[0]:ticker;
    return {
      futures:{
        quoteVolume:finite(futuresRow?.quoteVolume,null),
        openInterest:finite(oi?.openInterest??(Array.isArray(oi)?oi.at(-1)?.openInterest:null),null),
        fundingRate:finite(fr?.fundingRate,null)
      },
      liquidations:Array.isArray(liquidations)?liquidations:[]
    };
  }
  async scanRow(row,btcContext={}){
    const now=this.clock(),last=this.lastScanAt.get(row.symbol)||0;
    if(now-last<Math.max(10000,this.config.pollMs*0.7))return null;
    this.lastScanAt.set(row.symbol,now);
    const [one,five,fd]=await Promise.all([
      this.rest.klines(row.symbol,'1m',{limit:120}),
      this.rest.klines(row.symbol,'5m',{limit:72}),
      this.futuresData(row.symbol)
    ]);
    const previous=this.lastFutures.get(row.symbol)||null;
    const alert=buildFalconEyeAlert({
      ticker:row,oneMinute:one.candles,fiveMinute:five.candles,btcOneMinute:btcContext.one||[],btcFiveMinute:btcContext.five||[],
      futures:fd.futures,previousFutures:previous,liquidations:fd.liquidations
    },now,this.config);
    alert.market_pulse=row.market_pulse||null;
    alert.fast_lane=Boolean(row.market_pulse?.fast_trigger);
    this.lastFutures.set(row.symbol,fd.futures);
    this.scans++;
    const gate=evaluateRadarNotificationGate(alert,{now});
    alert.elite_gate=gate;
    this.latestCandidates=[alert,...this.latestCandidates.filter(x=>x.symbol!==alert.symbol)].sort((a,b)=>
      Number(b.opportunity_score||0)-Number(a.opportunity_score||0)
    ).slice(0,20);
    if(!alert.eligible||alert.opportunity_score<this.config.minScore||!gate.eligible)return alert;
    const lastAlert=this.lastAlertAt.get(row.symbol)||0;
    if(now-lastAlert<this.config.alertCooldownMs)return alert;
    this.alertTimestamps=this.alertTimestamps.filter(t=>now-t<60*60*1000);
    if(this.alertTimestamps.length>=this.config.maxAlertsPerHour)return alert;
    const decorated=decorateRadarAlert(alert,'Radar 9 — عين الصقر');
    await this.store.appendFalconEyeAlert(decorated);
    if(this.pushManager?.notifyRadarAlert)await this.pushManager.notifyRadarAlert(decorated);
    this.lastAlertAt.set(row.symbol,now);this.alertTimestamps.push(now);this.alertCount++;
    return decorated;
  }
  async tick(){
    if(!this.running||this.busy)return;
    this.busy=true;
    try{
      if(this.clock()-this.universeAt>this.config.universeRefreshMs)await this.refreshUniverse();
      const rows=await this.tickerRows();
      const btc=await Promise.all([
        this.rest.klines('BTCUSDT','1m',{limit:30}).catch(()=>({candles:[]})),
        this.rest.klines('BTCUSDT','5m',{limit:20}).catch(()=>({candles:[]}))
      ]);
      const marketContext={
        marketMedianChange24hPct:rows.find(x=>hasFiniteValue(x.marketMedianChange24hPct))?.marketMedianChange24hPct??null,
        marketBreadthPct:this.marketBreadthPct,
        fiveMinute:btc[1].candles||[],
        oneMinute:btc[0].candles||[]
      };
      const outcomeNow=this.clock(),historyAlerts=[];
      try{
        if(typeof this.store.readEarlyExpansionAlerts==='function')historyAlerts.push(...await this.store.readEarlyExpansionAlerts({sinceMs:outcomeNow-45*24*60*60*1000,limit:100}));
        if(typeof this.store.readFalconEyeAlerts==='function')historyAlerts.push(...await this.store.readFalconEyeAlerts({sinceMs:outcomeNow-45*24*60*60*1000,limit:100}));
      }catch(e){this.lastError=String(e?.message??e);}
      await importHistoricalPreExpansionSignals(this.store,historyAlerts,{now:outcomeNow,logger:this.logger}).catch(e=>{this.lastError=String(e?.message??e);});
      await updatePreExpansionMarkouts(this.store,rows,{now:outcomeNow,marketContext,logger:this.logger}).catch(e=>{this.lastError=String(e?.message??e);});
      await backfillHistoricalPreExpansionOutcomes(this.store,this.rest,{now:outcomeNow,logger:this.logger}).catch(e=>{this.lastError=String(e?.message??e);});
      await maybeLogPreExpansionOutcomeReport(this.store,{logger:this.logger,now:this.clock()}).catch(e=>{this.lastError=String(e?.message??e);});
      const selected=this.selectBatch(rows);
      this.lastScanAtMs=this.clock();
      const concurrency=Math.max(1,Math.min(this.config.deepConcurrency||3,selected.length||1));
      for(let i=0;i<selected.length;i+=concurrency){
        if(!this.running)break;
        const batch=selected.slice(i,i+concurrency);
        const batchAlerts=await Promise.all(batch.map(async row=>{
          try{return await this.scanRow(row,{one:btc[0].candles||[],five:btc[1].candles||[],marketContext});}
          catch(e){this.lastScanAt.delete(row.symbol);this.lastError=String(e?.message??e);return null;}
        }));
        await recordPreExpansionSignals(this.store,batchAlerts.filter(Boolean),{now:this.clock(),marketContext,logger:this.logger})
          .catch(e=>{this.lastError=String(e?.message??e);});
      }
    }finally{this.busy=false;}
  }
  async readFalconEyeAlerts({sinceMs=0,limit=100}={}){return this.store.readFalconEyeAlerts({sinceMs,limit});}
  health(){
    const now=this.clock();
    return {
      running:this.running,radar:'FALCON_EYE_RADAR',radar_name:'Radar 9 — عين الصقر',universe:this.universe.length,last_batch_symbols:this.lastBatchSymbols.slice(),last_batch_count:this.lastBatchSymbols.length,last_batch_at:this.lastBatchAt,last_patrol_visits:this.lastPatrolVisits,deep_scan_min_interval_ms:Math.max(90_000,Number(this.config.deepScanMinIntervalMs)||0,Number(this.config.pollMs||30_000)*2),
      market_coverage:this.marketCoverage,pulse_ready_count:this.pulseReadyCount,market_breadth_pct:this.marketBreadthPct,fast_candidates:this.fastCandidates,
      last_universe_refresh_at:this.universeAt||null,last_scan_at:this.lastScanAtMs,scans:this.scans,alerts:this.alertCount,
      last_error:this.lastError,latest_candidates:this.latestCandidates.slice(0,10),selection:this.lastSelectionStats,active_alerts_last_hour:this.alertTimestamps.filter(t=>now-t<60*60*1000).length,
      alert_budget_per_hour:this.config.maxAlertsPerHour,features:['OGN pre-explosion fingerprint','Quiet-base activity shock (taker buy is not mandatory)','Spot/Futures volume ratio','Open Interest','Funding squeeze context','Forced-liquidation context','Higher-Lows','Compression→Expansion','Relative Strength vs BTC','Anti-chase']
    };
  }
}
