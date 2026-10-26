import {CONFIG} from '../config.mjs';
import {buildLiquidityAbsorptionAnalysis} from '../core/liquidity-absorption-radar.mjs';
import {buildWhaleAccumulationAnalysis} from '../core/whale-accumulation-radar.mjs';
import {buildFalconEyeAnalysis} from '../core/falcon-eye-radar.mjs';
import {featureSet as coinHunterFeatureSet, earlyTimingFingerprint as coinHunterEarlyTimingFingerprint, scoreHunter as coinHunterScore} from '../core/coin-hunter-radar.mjs';
import {buildBottomMarketContext, buildPreMoveContext, aggregateClosed15mIntoHourly} from '../market/universe-scanner.mjs';

const HOUR_MS=60*60_000;

/**
 * Candidate-only historical proxy for the separate pre-price confirmation watch lane.
 * Missing order-book/liquidity and market-median history stay explicit limitations;
 * these rows can measure timing/outcomes but cannot prove live alert eligibility.
 */
export function assessHistoricalPreMoveWatchProxy(context,ticker,now=Date.now(),{
  minQuoteVolume24h=750_000
}={}) {
  const n=value=>{
    if(value===null||value===undefined||value===''||typeof value==='boolean')return null;
    const parsed=Number(value);
    return Number.isFinite(parsed)?parsed:null;
  };
  const score=n(context?.score);
  const session=n(context?.session_return_pct);
  const hour=n(context?.one_hour_return_pct);
  const volume=n(context?.volume_acceleration);
  const trades=n(context?.trade_acceleration);
  const buy=n(context?.taker_buy_ratio);
  const buyDelta=n(context?.taker_buy_acceleration);
  const closeLocation=n(context?.mean_close_location);
  const marketRelative=n(context?.relative_strength_vs_market_pct);
  // The selected historical cohort does not contain a full-market median at each step.
  // BTC relative strength is a labelled proxy, never silently called market-wide strength.
  const btcRelative=n(context?.relative_strength_vs_btc_pct);
  const relative=marketRelative??btcRelative;
  const structure=n(context?.components?.structure);
  const closeAt=n(context?.session_close);
  const daily=n(ticker?.priceChange24h);
  const quoteVolume=n(ticker?.quoteVolume24h);
  const age=closeAt===null?null:Number(now)-closeAt;
  const participation=[
    volume!==null&&volume>=1.0,
    trades!==null&&trades>=1.05,
    buy!==null&&buy>=0.54,
    buyDelta!==null&&buyDelta>=0.01,
    closeLocation!==null&&closeLocation>=0.54,
    relative!==null&&relative>=0.5
  ].filter(Boolean).length;
  const common={
    score,session_return_pct:session,one_hour_return_pct:hour,
    volume_acceleration:volume,trade_acceleration:trades,
    taker_buy_ratio:buy,taker_buy_acceleration:buyDelta,
    mean_close_location:closeLocation,relative_strength_pct:relative,
    relative_strength_source:marketRelative!==null?'HISTORICAL_MARKET_MEDIAN':
      btcRelative!==null?'BTC_PROXY':'UNAVAILABLE',
    structure_score:structure,participation,closed_candle_close_time:closeAt,
    candle_age_ms:age,quote_volume_24h:quoteVolume
  };
  const reject=reason=>({eligible:false,tier:'NONE',reason,limitations:[
    'HISTORICAL_ORDERBOOK_UNAVAILABLE',
    'HISTORICAL_LIQUIDITY_QUALITY_UNAVAILABLE',
    'LIVE_PUSH_GATE_NOT_SIMULATED'
  ],...common});
  if(context?.evidence_complete!==true||context?.closed_candles_only!==true||
     context?.already_moved===true||!Number.isFinite(Number(context?.current_price))||
     Number(context.current_price)<=0) return reject('CLOSED_CANDLE_EVIDENCE_INCOMPLETE');
  if(ticker?.ticker_24h_coverage_complete!==true)
    return reject('HISTORICAL_24H_TICKER_COVERAGE_INCOMPLETE');
  if(daily===null||Math.abs(daily)>=12) return reject('DAILY_ANTI_CHASE_GATE');
  if(quoteVolume===null||quoteVolume<Number(minQuoteVolume24h))
    return reject('HISTORICAL_QUOTE_VOLUME_GATE');
  if(closeAt===null||closeAt>Number(now)+5000||age===null||age<0||age>20*60_000)
    return reject('CLOSED_CANDLE_STALE_OR_FUTURE');
  if(score===null||session===null||hour===null||volume===null||trades===null||
     buy===null||buyDelta===null||closeLocation===null||relative===null||structure===null)
    return reject('PRE_MOVE_METRICS_INCOMPLETE');

  const highActivity=score>=75&&session>=-0.75&&session<=4.5&&hour>=-0.5&&hour<=2.5&&
    volume>=3&&trades>=2&&buy>=0.65&&buyDelta>=0.05&&relative>=0.5&&
    structure>=50&&participation>=4;
  const earlyFlow=(session<0||hour<0.15||structure<60)&&
    score>=72&&session>=-1.25&&session<=4.5&&hour>=-0.75&&hour<=2.5&&
    volume>=1.6&&trades>=1.15&&buy>=0.56&&buyDelta>=0.025&&
    relative>=0.4&&structure>=50&&participation>=4;
  if(!highActivity&&!earlyFlow)return reject('EARLY_FLOW_MONITOR_THRESHOLD_NOT_MET');
  const tier=highActivity?'HIGH_ACTIVITY_STRUCTURE_PENDING':'EARLY_FLOW_MONITOR';
  return {
    eligible:true,tier,reason:null,
    proxy_only:true,entry_eligible:false,
    limitations:[
      'HISTORICAL_ORDERBOOK_UNAVAILABLE',
      'HISTORICAL_LIQUIDITY_QUALITY_UNAVAILABLE',
      'HISTORICAL_MARKET_MEDIAN_UNAVAILABLE',
      ...(marketRelative===null&&btcRelative!==null?['BTC_RELATIVE_STRENGTH_USED_AS_PROXY']:[]),
      'LIVE_PUSH_GATE_NOT_SIMULATED'
    ],
    ...common
  };
}

/**
 * Deterministic, no-network adapter layer for radar-specific historical replay.
 * Returns a candidate proxy and its missing evidence separately; it does not
 * imply that a live notification was sent or that absent data was synthesized.
 */
export function evaluateHistoricalProfileAdapter(profile,input,{config=CONFIG}={}) {
  const detectorProfile=String(profile||'').trim().toUpperCase();
  if(detectorProfile==='EARLY_MOVE_RADAR'){
    const fifteen=input.timeframes?.['15m']||[];
    const hourly=aggregateClosed15mIntoHourly(fifteen,input.now);
    const series={'15m':fifteen,'1h':hourly};
    const ticker={...input.ticker};
    const bottom=buildBottomMarketContext(series,ticker,input.now,{book:null,liquidity:null});
    const dateParts=new Intl.DateTimeFormat('en-CA',{
      timeZone:'Asia/Aden',year:'numeric',month:'2-digit',day:'2-digit'
    }).formatToParts(new Date(input.now));
    const datePart=key=>Number(dateParts.find(x=>x.type===key)?.value);
    let sessionStart=Date.UTC(datePart('year'),datePart('month')-1,datePart('day'),1,0,0,0);
    if(input.now<sessionStart)sessionStart-=24*HOUR_MS;
    const btcRows=(input.timeframes?.['BTCUSDT:15m']||[]).filter(x=>
      x?.closed===true&&Number(x.closeTime)<=input.now&&Number(x.closeTime)>=sessionStart
    );
    const btcReturn=btcRows.length&&Number(btcRows[0]?.open)>0
      ?(Number(btcRows.at(-1)?.close)/Number(btcRows[0]?.open)-1)*100:null;
    const medianValue=n(input.marketMedianReturnPct);
    const medianSampleCount=n(input.marketMedianSampleCount);
    const marketMedianAvailable=input.marketMedianSource==='HISTORICAL_REQUESTED_SPOT_COHORT_MEDIAN' &&
      medianValue!==null && medianSampleCount!==null && medianSampleCount>=5;
    const context=buildPreMoveContext(series,ticker,input.now,bottom,{
      btcReturn,marketMedianReturn:marketMedianAvailable?medianValue:null
    });
    context.market_median_source=marketMedianAvailable?input.marketMedianSource:'UNAVAILABLE';
    context.market_median_sample_count=medianSampleCount??0;
    const strictEligible=context.evidence_complete===true&&context.flow_transition_confirmed===true&&
      context.price_window_valid===true&&context.structure_confirmed===true&&context.already_moved!==true&&
      ['READY','EARLY_WAKE','QUIET_BUILD'].includes(String(context.stage||''));
    const watchProxy=assessHistoricalPreMoveWatchProxy(context,input.ticker,input.now);
    const eligible=strictEligible||watchProxy.eligible===true;
    const stage=watchProxy.eligible===true&&!strictEligible?watchProxy.tier:context.stage;
    const analysis={...context,eligible:strictEligible,direction:'UP',score:context.score,
      // Do not invent a historical data-quality score. Missing order-book/liquidity data
      // remains an explicit blocker; the monitor result is only a candle-based shadow.
      closed_candles_only:true,reason_codes:[...(context.reasons||[]),...(watchProxy.eligible?[watchProxy.tier]:[])],
      historical_watch_proxy:watchProxy,
      watch_only:watchProxy.eligible===true&&!strictEligible,
      entry_eligible:false,
      risk_flags:context.already_moved?['ALREADY_MOVED']:[],
      bottom_context:bottom,closed_hourly_candles:hourly.length};
    return {analysis,eligible,score:context.score,stage,
      reasonCodes:[...(context.reasons||[]),...(context.missing_evidence||[]),
        ...(watchProxy.eligible?['HISTORICAL_PRE_MOVE_WATCH_CANDIDATE']:[]),
        ...(watchProxy.reason?[watchProxy.reason]:[])],
      extraGateFailures:['HISTORICAL_ORDERBOOK_UNAVAILABLE','HISTORICAL_LIQUIDITY_QUALITY_UNAVAILABLE',
        ...(!marketMedianAvailable?['HISTORICAL_MARKET_MEDIAN_UNAVAILABLE']:[]),'LIVE_PUSH_GATE_NOT_SIMULATED']};
  }

  if(detectorProfile==='LIQUIDITY_ABSORPTION_RADAR'){
    const analysis=buildLiquidityAbsorptionAnalysis(
      input.oneMinute,input.fiveMinute,input.ticker,null,input.now
    );
    const metrics=analysis.metrics||{};
    const riskFlags=Array.isArray(analysis.risk_flags)?analysis.risk_flags:[];
    const candleProxy=analysis.closed_candles_only===true&&analysis.data_stale!==true&&
      Number(metrics.absorption_score)>=76&&Number(metrics.volume_ratio)>=1.55&&
      Number(metrics.net_move_pct)<=1.15&&Number(metrics.taker_buy_ratio)>=0.52&&
      Number(metrics.structure_score)>=60&&!riskFlags.includes('24H_EXTENDED');
    const eligible=analysis.eligible===true||candleProxy;
    return {analysis,eligible,score:analysis.score,stage:analysis.stage,
      reasonCodes:[...(analysis.data_quality_reasons||[]),...(analysis.reasons||[]),
        ...(candleProxy&&analysis.eligible!==true?['CANDLE_ONLY_MICROSTRUCTURE_PROXY']:[])],
      extraGateFailures:['HISTORICAL_ORDERBOOK_UNAVAILABLE','LIVE_PUSH_GATE_NOT_SIMULATED']};
  }

  if(detectorProfile==='FALCON_EYE_RADAR'){
    const btcOne=input.timeframes?.['BTCUSDT:1m']||[];
    const btcFive=input.timeframes?.['BTCUSDT:5m']||[];
    const analysis=buildFalconEyeAnalysis({
      ticker:input.ticker,oneMinute:input.oneMinute,fiveMinute:input.fiveMinute,
      btcOneMinute:btcOne,btcFiveMinute:btcFive,futures:{},previousFutures:null,
      liquidations:[],now:input.now,config:config.falconEyeRadar||{}
    });
    const stage=String(analysis.stage||'');
    const candleProxy=analysis.closed_candles_only===true&&analysis.data_stale!==true&&
      Number(analysis.data_quality)>0&&['PRE_ATTACK','IGNITION'].includes(stage);
    const eligible=analysis.eligible===true||candleProxy;
    return {analysis,eligible,score:analysis.score,stage,
      reasonCodes:[...(analysis.reasons||[]),...(analysis.data_quality_reasons||[]),
        ...(candleProxy&&analysis.eligible!==true?['CANDLE_ONLY_PRE_ATTACK_PROXY']:[])],
      extraGateFailures:['HISTORICAL_FUTURES_SNAPSHOTS_UNAVAILABLE','HISTORICAL_LIQUIDATIONS_UNAVAILABLE','LIVE_PUSH_GATE_NOT_SIMULATED']};
  }

  if(detectorProfile==='COIN_HUNTER_RADAR'){
    const hourly=input.timeframes?.['1h']||[];
    const fifteen=input.timeframes?.['15m']||[];
    const btcHourly=input.timeframes?.['BTCUSDT:1h']||[];
    const btcToday=btcHourly.length>=25&&Number(btcHourly.at(-25)?.close)>0
      ?(Number(btcHourly.at(-1)?.close)/Number(btcHourly.at(-25)?.close)-1)*100:null;
    const features=coinHunterFeatureSet(hourly,input.ticker,btcToday,input.now);
    const micro=coinHunterEarlyTimingFingerprint(fifteen,input.now);
    const score=features&&micro?coinHunterScore({
      ticker:input.ticker,features,micro,
      // Production pattern similarity needs a time-aligned cross-symbol leader cohort.
      // Do not fabricate that cohort; replay only the deterministic technical sub-score.
      lesson:{profile:{},max_accepted_24h_move_pct:8},
      todayPct:Number.isFinite(Number(input.ticker.priceChange24h))?Number(input.ticker.priceChange24h):null,
      dayHigh:input.ticker.highPrice24h,dayLow:input.ticker.lowPrice24h,btcTodayPct:btcToday
    }):null;
    const eligible=Boolean(score&&['قنص','ترقّب'].includes(String(score.decision||'')));
    const analysis={...(score||{}),eligible,direction:'UP',stage:score?.decision||'DATA_INSUFFICIENT',
      closed_candles_only:true,data_stale:false,
      reason_codes:score?.reasons||[],risk_flags:score?.risk_flags||[],
      missing_historical_context:['HISTORICAL_LEADER_COHORT_UNAVAILABLE']};
    return {analysis,eligible,score:score?.score,stage:analysis.stage,
      reasonCodes:[...(score?.reasons||[]),...(!features?['COIN_HUNTER_1H_FEATURES_UNAVAILABLE']:[]),
        ...(!micro?['COIN_HUNTER_15M_TIMING_FINGERPRINT_UNAVAILABLE']:[])],
      extraGateFailures:['HISTORICAL_LEADER_COHORT_UNAVAILABLE','LIVE_PUSH_GATE_NOT_SIMULATED']};
  }

  if(detectorProfile==='WHALE_ACCUMULATION_RADAR'){
    const analysis=buildWhaleAccumulationAnalysis({
      ticker:input.ticker,oneMinute:input.oneMinute,fiveMinute:input.fiveMinute,
      aggTrades:input.aggTrades,book:null,previousBook:null,now:input.now,
      config:config.whaleAccumulationRadar||{}
    });
    const prints=analysis.large_prints||{},flow=analysis.candle_flow||{},priceContext=analysis.price_context||{};
    const tradeCovered=input.dataPolicy?.tradeCoverageComplete===true;
    const candleProxy=tradeCovered&&analysis.closed_candles_only===true&&!analysis.data_stale&&
      Number(analysis.data_quality)>0&&!(Array.isArray(analysis.data_quality_reasons)&&analysis.data_quality_reasons.length)&&
      Number(prints.largeCount)>=4&&Number(prints.largeBuyRatio)>=0.60&&
      Number(prints.largeNotionalRatio)>=0.12&&Number(flow.volumeRatio)>=1.15&&
      Number(flow.takerBuyRatio)>=0.515&&Number(flow.absorptionScore)>=67&&
      priceContext.not_extended===true;
    const eligible=tradeCovered&&(analysis.eligible===true||candleProxy);
    return {analysis,eligible,score:analysis.score,stage:analysis.stage,
      reasonCodes:[...(analysis.reasons||[]),...(analysis.data_quality_reasons||[]),
        ...(!tradeCovered?['HISTORICAL_AGG_TRADE_COVERAGE_INCOMPLETE']:[]),
        ...(candleProxy&&analysis.eligible!==true?['TRADE_AND_CANDLE_PROXY_ORDERBOOK_UNAVAILABLE']:[])],
      extraGateFailures:['HISTORICAL_ORDERBOOK_UNAVAILABLE','LIVE_PUSH_GATE_NOT_SIMULATED']};
  }
  return null;
}

export const HISTORICAL_PROFILE_ADAPTERS=Object.freeze([
  'EARLY_MOVE_RADAR','LIQUIDITY_ABSORPTION_RADAR','FALCON_EYE_RADAR',
  'COIN_HUNTER_RADAR','WHALE_ACCUMULATION_RADAR'
]);
