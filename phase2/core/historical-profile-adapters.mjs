import {CONFIG} from '../config.mjs';
import {buildLiquidityAbsorptionAnalysis} from '../core/liquidity-absorption-radar.mjs';
import {buildWhaleAccumulationAnalysis} from '../core/whale-accumulation-radar.mjs';
import {buildFalconEyeAnalysis} from '../core/falcon-eye-radar.mjs';
import {featureSet as coinHunterFeatureSet, earlyTimingFingerprint as coinHunterEarlyTimingFingerprint, scoreHunter as coinHunterScore} from '../core/coin-hunter-radar.mjs';
import {buildBottomMarketContext, buildPreMoveContext, aggregateClosed15mIntoHourly} from '../market/universe-scanner.mjs';

const HOUR_MS=60*60_000;

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
    const ticker={...input.ticker,dataQuality:90};
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
    const context=buildPreMoveContext(series,ticker,input.now,bottom,{btcReturn});
    const eligible=context.evidence_complete===true&&context.flow_transition_confirmed===true&&
      context.price_window_valid===true&&context.structure_confirmed===true&&context.already_moved!==true&&
      ['READY','EARLY_WAKE','QUIET_BUILD'].includes(String(context.stage||''));
    const analysis={...context,eligible,direction:'UP',score:context.score,data_quality:90,
      closed_candles_only:true,reason_codes:context.reasons||[],
      risk_flags:context.already_moved?['ALREADY_MOVED']:[],
      bottom_context:bottom,closed_hourly_candles:hourly.length};
    return {analysis,eligible,score:context.score,stage:context.stage,
      reasonCodes:[...(context.reasons||[]),...(context.missing_evidence||[])],
      extraGateFailures:['HISTORICAL_ORDERBOOK_UNAVAILABLE','HISTORICAL_LIQUIDITY_QUALITY_UNAVAILABLE','LIVE_PUSH_GATE_NOT_SIMULATED']};
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
      closed_candles_only:true,data_quality:features&&micro?90:0,data_stale:false,
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
