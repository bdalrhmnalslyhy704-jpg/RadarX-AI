#!/usr/bin/env node
import {mkdir, writeFile, rename} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CONFIG} from '../config.mjs';
import {RestClient} from '../market/binance-rest.mjs';
import {buildStrongMoveAlert} from '../core/strong-move-radar.mjs';
import {buildEarlyExpansionEvidence} from '../core/early-expansion-radar.mjs';
import {buildAlMuqawimAnalysis} from '../core/al-muqawim-radar.mjs';
import {buildDoomsdayAnalysis} from '../core/doomsday-radar.mjs';
import {evaluateEliteGate} from '../core/elite-confluence-gate.mjs';
import {evaluateRadarNotificationGate} from '../core/radar-notification-gate.mjs';
import {evaluateDynamicEarlyWarningGate} from '../core/dynamic-early-warning-gate.mjs';
import {runHistoricalReplay} from '../core/historical-replay.mjs';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Historical replay is an offline evaluation tool and may wait for a bounded
 * public-API cooldown. The live radar path intentionally defers work instead:
 * this retry policy must not be copied into latency-sensitive production scans.
 */
export async function withHistoricalRateLimitRetry(operation, {
  label = 'historical public-data request',
  maxAttempts = 5,
  maxWaitMs = 120_000,
  sleepFn = sleep,
  onRetry = ({attempt, waitMs}) => process.stderr.write(
    '[HISTORICAL_RATE_LIMIT_RETRY] ' + label + ' attempt=' + attempt + ' wait_ms=' + waitMs + '\n'
  )
} = {}) {
  const attempts = Math.max(1, Math.trunc(Number(maxAttempts) || 1));
  const waitLimit = Math.max(0, Number(maxWaitMs) || 0);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const rateLimited = error?.name === 'RestRateLimitError' ||
        String(error?.message || '') === 'BINANCE_RATE_LIMIT';
      if (!rateLimited || attempt >= attempts) throw error;
      const retryValue = Number(error?.retryMs);
      const waitMs = Number.isFinite(retryValue) && retryValue > 0
        ? Math.ceil(retryValue) : Math.min(60_000, 1_000 * (2 ** (attempt - 1)));
      if (waitMs > waitLimit) {
        error.message = String(error.message || 'BINANCE_RATE_LIMIT') +
          ' HISTORICAL_RETRY_WAIT_EXCEEDS_LIMIT retry_ms=' + waitMs;
        throw error;
      }
      onRetry({attempt, waitMs, label});
      await sleepFn(waitMs);
    }
  }
  throw new Error('HISTORICAL_RATE_LIMIT_RETRY_UNREACHABLE');
}
function flag(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}
function timeArg(raw, label) {
  if (raw == null) return null;
  const numeric = Number(raw);
  const time = raw.trim() !== '' && Number.isFinite(numeric) ? numeric : Date.parse(raw);
  if (!Number.isFinite(time)) throw new Error('INVALID_' + label.toUpperCase());
  return time;
}
function integerArg(raw, fallback, min, max, label) {
  const n = Math.trunc(Number(raw ?? fallback));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error('INVALID_' + label.toUpperCase());
  return n;
}
function normalizedTrades(rows) {
  return (Array.isArray(rows) ? rows : []).map(x => ({
    ...x,
    a: Number(x?.a),
    T: Number(x?.T),
    p: String(x?.p ?? ''),
    q: String(x?.q ?? ''),
    m: x?.m
  })).filter(x => Number.isFinite(x.a) && Number.isFinite(x.T));
}

const HISTORICAL_INTERVAL_MS=Object.freeze({
  '1m':MINUTE_MS,'5m':5*MINUTE_MS,'15m':15*MINUTE_MS,'1h':HOUR_MS,'4h':4*HOUR_MS
});
async function fetchHistoricalTimeframe(client,symbol,interval,start,end,lookbackBars){
  const intervalMs=HISTORICAL_INTERVAL_MS[interval];
  if(!intervalMs)throw new Error('UNSUPPORTED_HISTORICAL_INTERVAL');
  const bars=Math.max(1,Math.trunc(Number(lookbackBars)||1));
  const requestedStart=Math.floor((start-bars*intervalMs)/intervalMs)*intervalMs;
  const expected=Math.ceil((end-requestedStart+1)/intervalMs)+2;
  const maxPages=Math.min(40,Math.max(1,Math.ceil(expected/1000)+1));
  const seen=new Map();
  let cursor=requestedStart,pages=0,complete=false;
  while(cursor<=end&&pages<maxPages){
    const result=await withHistoricalRateLimitRetry(
      ()=>client.klines(symbol,interval,{limit:1000,startTime:cursor,endTime:end}),
      {label:'klines:'+symbol+':'+interval}
    );
    const page=Array.isArray(result?.candles)?result.candles:[];
    pages++;
    if(!page.length){complete=true;break;}
    for(const candle of page){
      const open=Number(candle?.openTime);
      if(Number.isFinite(open))seen.set(open,candle);
    }
    const lastOpen=Number(page.at(-1)?.openTime);
    if(!Number.isFinite(lastOpen)||lastOpen<cursor)throw new Error('HISTORICAL_TIMEFRAME_PAGINATION_STALLED');
    cursor=lastOpen+intervalMs;
    if(page.length<1000){complete=true;break;}
  }
  const candles=[...seen.values()].sort((a,b)=>Number(a.openTime)-Number(b.openTime))
    .filter(c=>Number(c?.closeTime)<=end&&Number(c?.closeTime)<=Date.now());
  const historyBeforeStart=candles.filter(c=>Number(c.closeTime)<start).slice(-bars);
  const tailContiguous=historyBeforeStart.length>=bars&&historyBeforeStart.every((c,i)=>
    i===0||Number(c.openTime)===Number(historyBeforeStart[i-1].openTime)+intervalMs);
  const fullSeriesContiguous=candles.length>0&&candles.every((c,i)=>
    i===0||Number(c.openTime)===Number(candles[i-1].openTime)+intervalMs);
  return {candles,complete:Boolean(complete&&tailContiguous&&fullSeriesContiguous),interval,symbol,
    requested_start:requestedStart,requested_end:end,rows:candles.length,
    required_history_bars:bars,pages,tail_history_contiguous:tailContiguous,
    full_series_contiguous:fullSeriesContiguous,source:'BINANCE_PUBLIC_REST'};
}

function numericOrNull(value){
  if(value===null||value===undefined||value===''||typeof value==='boolean')return null;
  const n=Number(value);return Number.isFinite(n)?n:null;
}
function uniqueReasonCodes(...groups){
  return [...new Set(groups.flatMap(x=>Array.isArray(x)?x:[]).map(x=>String(x??'').trim()).filter(Boolean))].slice(0,30);
}
function buildCandidateShadowResult(profile,analysis,input,{eligible,score,stage,reasonCodes=[],extraGateFailures=[]}={}){
  const reasons=uniqueReasonCodes(
    reasonCodes,analysis?.reason_codes,analysis?.data_quality_reasons,analysis?.watch_blockers,
    analysis?.risk_flags
  );
  const canonical=profile==='RADAR8_PREMOVE_SHADOW'?'EARLY_EXPANSION_RADAR':profile;
  const nested=profile==='RADAR8_PREMOVE_SHADOW'?'early_expansion':
    profile==='ALMUQAWIM_RADAR'?'almuqawim':
    profile==='DOOMSDAY_RADAR'?'doomsday':'analysis';
  const dataQuality=numericOrNull(analysis?.data_quality ?? analysis?.gates?.data_gate?.quality);
  const isStale=analysis?.data_stale===true || analysis?.data_stale===false?analysis.data_stale:
    analysis?.gates?.data_gate?.valid===false&&reasons.some(x=>/STALE/i.test(x));
  const blocked=['HISTORICAL_PUSH_DELIVERY_NOT_SIMULATED',...extraGateFailures];
  const alert={
    symbol:input.symbol,radar:canonical,direction:analysis?.direction??'UP',
    eligible:Boolean(eligible),score:numericOrNull(score),opportunity_score:numericOrNull(score),
    stage:stage||analysis?.stage||analysis?.decision_band||analysis?.pre_expansion_stage||'NO_SETUP',
    data_quality:dataQuality,liquidity_quality:null,data_stale:Boolean(isStale),
    closed_candles_only:true,source:'BINANCE_PUBLIC_HISTORICAL_CANDLES',
    reason_codes:reasons,risk_flags:Array.isArray(analysis?.risk_flags)?analysis.risk_flags:[],
    [nested]:analysis,
    ...(profile==='RADAR8_PREMOVE_SHADOW'?{
      early_expansion_score:numericOrNull(analysis?.early_expansion_score),
      pre_expansion_fingerprint:analysis?.pre_expansion_fingerprint??null,
      metrics:analysis?.metrics||{},
      quote_volume_24h:numericOrNull(input.ticker?.quoteVolume24h)
    }:{}),
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
  };
  const outcomeReasonCodes=eligible
    ?uniqueReasonCodes(reasons,['HISTORICAL_CANDIDATE_DETECTED','CANDIDATE_SHADOW_NOT_A_PUSH'])
    :uniqueReasonCodes(reasons,['DETECTOR_CANDIDATE_NOT_CONFIRMED']);
  return {
    accepted:Boolean(eligible),
    accepted_mode:eligible?profile+'_CANDIDATE_SHADOW':'NONE',
    alert,
    score:numericOrNull(score),
    stage:alert.stage,
    candidate_eligible:Boolean(eligible),
    core_trigger_eligible:Boolean(analysis?.eligible===true),
    notificationGate:{eligible:null,failures:blocked},
    notification_gate:{eligible:null,failures:blocked},
    strict_gate_failures:uniqueReasonCodes(reasons,blocked),
    reason_codes:outcomeReasonCodes,
    shadow_evaluation:{
      profile,detector_candidate:Boolean(eligible),live_notification_simulated:false,
      unavailable_historical_evidence:blocked
    }
  };
}

function profileSnapshot(profile){
  const profiles={
    STRONG_MOVE_RADAR:{mode:'ACTIONABLE_GATE_REPLAY',requires:['closed 1m/5m candles','aggregate trade history or explicitly marked candle-only fallback'],historical_book_required:false},
    RADAR8_PREMOVE_SHADOW:{mode:'PRE_MOVE_CANDLE_ONLY_SHADOW',requires:['closed 1m/5m/15m/1h/4h candles','BTC 5m closed candles for relative strength'],historical_book_required:true},
    ALMUQAWIM_RADAR:{mode:'CANDLE_ONLY_CANDIDATE_SHADOW',requires:['closed 15m/1h/4h candles'],historical_book_required:false},
    DOOMSDAY_RADAR:{mode:'CANDLE_ONLY_CANDIDATE_SHADOW',requires:['closed 1m/5m candles','BTC 5m closed candles'],historical_book_required:true}
  };
  const result=profiles[profile];
  if(!result)throw new Error('UNSUPPORTED_HISTORICAL_DETECTOR_PROFILE:'+profile);
  return {profile,...result};
}

async function fetchOneMinute(client, symbol, start, end) {
  const rows = [];
  let cursor = start;
  let pages = 0;
  const maxPages=Math.min(40,Math.max(1,Math.ceil((end-start+1)/(1000*MINUTE_MS))+1));
  while (cursor <= end && pages < maxPages) {
    const result = await withHistoricalRateLimitRetry(
      () => client.klines(symbol, '1m', {limit: 1000, startTime: cursor, endTime: end}),
      {label: 'klines:' + symbol}
    );
    const page = Array.isArray(result.candles) ? result.candles : [];
    pages++;
    if (!page.length) break;
    rows.push(...page);
    const lastOpen = Number(page[page.length - 1].openTime);
    if (!Number.isFinite(lastOpen) || lastOpen < cursor) throw new Error('KLINES_PAGINATION_STALLED');
    cursor = lastOpen + MINUTE_MS;
    if (page.length < 1000) break;
  }
  const byOpen = new Map();
  for (const candle of rows) {
    const openTime = Number(candle.openTime);
    if (Number.isFinite(openTime)) byOpen.set(openTime, candle);
  }
  return {candles: [...byOpen.values()].sort((a, b) => a.openTime - b.openTime), pages, complete: cursor > end};
}

export async function fetchAggregateTrades(client, symbol, start, end, {maxPages, maxTrades}) {
  let cursor = start;
  let fromId = null;
  const all = new Map();
  let pages = 0;
  let complete = false;
  let lastTimestamp = null;
  while (pages < maxPages && all.size < maxTrades) {
    const remaining = maxTrades - all.size;
    const query = fromId == null
      ? {symbol, startTime: cursor, endTime: end, limit: Math.min(1000, remaining)}
      : {symbol, fromId, limit: Math.min(1000, remaining)};
    // Production RestClient intentionally exposes a generic allowlisted request()
    // rather than endpoint-specific aggTrades(); keep replay compatible with it.
    const result = await withHistoricalRateLimitRetry(
      () => client.request('/api/v3/aggTrades', query),
      {label: 'aggTrades:' + symbol}
    );
    const page = normalizedTrades(result.trades ?? result.data ?? []);
    pages++;
    if (!page.length) { complete = true; break; }
    for (const trade of page) all.set(trade.a, trade);
    const last = page[page.length - 1];
    lastTimestamp = last.T;
    if (last.T >= end) { complete = true; break; }
    if (page.length < Math.min(1000, remaining)) {
      // A short page before the requested end is not proof that the window was covered.
      complete = false; break;
    }
    if (!Number.isFinite(last.a) || last.a < 0) break;
    fromId = last.a + 1;
    cursor = last.T + 1;
    if (all.size >= maxTrades) break;
  }
  const trades = [...all.values()].sort((a, b) => a.T - b.T || a.a - b.a);
  const coverage = {
    complete, pages, rows: trades.length, requested_start_time: start,
    requested_end_time: end, last_trade_time: lastTimestamp,
    limit_reached: pages >= maxPages || trades.length >= maxTrades,
    pagination: 'aggTrade id cursor; unique aggregate trade IDs'
  };
  return {trades, complete, coverage};
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write([
      'RadarX historical replay (public Binance Spot data; read-only)',
      'Usage: node phase2/tools/historical-replay.mjs [--symbols GTCUSDT,WUSDT] [--start ISO|ms] [--end ISO|ms]',
      '       [--detector-profile STRONG_MOVE_RADAR|RADAR8_PREMOVE_SHADOW|ALMUQAWIM_RADAR|DOOMSDAY_RADAR]',
      '       [--lookback-hours 24] [--outcome-horizon-hours 24] [--max-trade-pages 500] [--max-trades 500000] [--output path] [--dry-run]',
      'Default window: last completed minute minus 24 hours. Maximum window: 7 days.',
      'Candle-only profiles are labeled candidate shadows; missing historical order-book/news data is never synthesized.',
      'Trade-history pagination that reaches a cap is flagged incomplete and fails closed. No orders or credentials are used.'
    ].join('\n') + '\n');
    return;
  }
  const detectorProfile=String(flag(args,'--detector-profile','STRONG_MOVE_RADAR')).trim().toUpperCase();
  const detectorSpec=profileSnapshot(detectorProfile);
  if(args.includes('--dry-run')){
    const startRaw=timeArg(flag(args,'--start'),'start');
    const endRaw=timeArg(flag(args,'--end'),'end');
    process.stdout.write(JSON.stringify({
      status:'DRY_RUN_NO_NETWORK',
      detector:detectorSpec,
      symbols:String(flag(args,'--symbols','GTCUSDT,WUSDT')).split(',').map(x=>x.trim().toUpperCase()).filter(Boolean),
      window:{start:startRaw,end:endRaw,lookback_hours:integerArg(flag(args,'--lookback-hours','24'),24,1,168,'lookback-hours'),
        outcome_horizon_hours:integerArg(flag(args,'--outcome-horizon-hours','24'),24,1,168,'outcome-horizon-hours')},
      policy:{market:'BINANCE_SPOT_USDT',paper_trading:true,real_order_execution:false,credentials_used:false}
    },null,2)+'\\n');
    return;
  }
  const symbols = String(flag(args, '--symbols', 'GTCUSDT,WUSDT')).split(',')
    .map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length || symbols.some(s => !/^[A-Z0-9]{5,20}$/.test(s))) throw new Error('INVALID_SYMBOLS');
  const now = Date.now();
  const end = timeArg(flag(args, '--end'), 'end') ?? (Math.floor(now / MINUTE_MS) * MINUTE_MS - 1);
  const lookbackHours = integerArg(flag(args, '--lookback-hours', '24'), 24, 1, 168, 'lookback-hours');
  const outcomeHorizonHours = integerArg(flag(args, '--outcome-horizon-hours', '24'), 24, 1, 168, 'outcome-horizon-hours');
  const start = timeArg(flag(args, '--start'), 'start') ?? (end - lookbackHours * HOUR_MS);
  if (start >= end || end > now + MINUTE_MS || end - start > 7 * 24 * HOUR_MS) throw new Error('INVALID_REPLAY_WINDOW');
  const latestClosedMinuteEnd = Math.floor(now / MINUTE_MS) * MINUTE_MS - 1;
  const requestedOutcomeEnd = end + outcomeHorizonHours * HOUR_MS;
  const observationEnd = Math.min(latestClosedMinuteEnd, requestedOutcomeEnd);
  if (observationEnd < end) throw new Error('OUTCOME_OBSERVATION_WINDOW_INVALID');
  const maxPages = integerArg(flag(args, '--max-trade-pages', '500'), 500, 1, 1000, 'max-trade-pages');
  const maxTrades = integerArg(flag(args, '--max-trades', '500000'), 500000, 1000, 1000000, 'max-trades');
  const output = resolve(flag(args, '--output', './.radarx-data/historical-replay-' + new Date(now).toISOString().replace(/[:.]/g, '-') + '.json'));
  const config = CONFIG;
  const client = new RestClient({...config.rest, baseUrls: config.rest.baseUrls ?? config.rest.urls});
  const report = {
    engine: 'RADARX_HISTORICAL_REPLAY_BATCH_V1',
    generated_at: new Date(now).toISOString(),
    window: {start, start_iso: new Date(start).toISOString(), end, end_iso: new Date(end).toISOString(),
      outcome_horizon_hours:outcomeHorizonHours,observation_end:observationEnd,observation_end_iso:new Date(observationEnd).toISOString()},
    symbol_count: symbols.length,
    detector_profile:detectorSpec,
    note: 'The evaluator receives only history available by each candle close. Outcome labels use later candles only after a decision has been recorded. Candidate-shadow profiles do not simulate real notifications.',
    results: [],
    policy: {market: 'SPOT', paper_trading: true, real_order_execution: false, confidence_score: 'UNKNOWN'}
  };

  for (const symbol of symbols) {
    try {
    process.stderr.write('[REPLAY] ' + symbol + ' fetching closed 1m candles…\n');
    const candleFetch = await fetchOneMinute(client, symbol, start - 24 * HOUR_MS - 125 * MINUTE_MS, observationEnd);
    const timeframeCandles={},timeframeCoverage={},timeframeFetchErrors=[];
    const fetchFrame=async(key,frameSymbol,interval,bars)=>{
      try{
        const fetched=await fetchHistoricalTimeframe(client,frameSymbol,interval,start,observationEnd,bars);
        timeframeCandles[key]=fetched.candles;
        timeframeCoverage[key]={symbol:frameSymbol,interval,rows:fetched.rows,required_history_bars:fetched.required_history_bars,
          complete:fetched.complete,source:fetched.source,requested_start:fetched.requested_start,requested_end:fetched.requested_end};
        if(!fetched.complete)timeframeFetchErrors.push('TIMEFRAME_COVERAGE_INCOMPLETE:'+key);
      }catch(error){
        timeframeCandles[key]=[];
        timeframeCoverage[key]={symbol:frameSymbol,interval,rows:0,required_history_bars:bars,complete:false,
          error:String(error?.message??error).slice(0,180)};
        timeframeFetchErrors.push('TIMEFRAME_FETCH_FAILED:'+key);
      }
    };
    if(['RADAR8_PREMOVE_SHADOW','ALMUQAWIM_RADAR'].includes(detectorProfile)){
      await fetchFrame('15m',symbol,'15m',Number(config.earlyExpansionRadar?.fifteenMinuteKlines)||160);
      await fetchFrame('1h',symbol,'1h',Number(config.earlyExpansionRadar?.oneHourKlines)||260);
      await fetchFrame('4h',symbol,'4h',Number(config.earlyExpansionRadar?.fourHourKlines)||220);
    }
    if(detectorProfile==='RADAR8_PREMOVE_SHADOW'){
      await fetchFrame('BTCUSDT:5m','BTCUSDT','5m',60);
    }else if(detectorProfile==='DOOMSDAY_RADAR'){
      await fetchFrame('BTCUSDT:5m','BTCUSDT','5m',60);
    }
    let tradeFetch;
    try {
      tradeFetch = await fetchAggregateTrades(client, symbol, start - 65_000, end, {maxPages, maxTrades});
    } catch (error) {
      // Public aggTrade history can be unavailable or capped even when closed klines
      // are complete. Keep the failure explicit and continue with candle-only replay.
      tradeFetch = {
        trades: [], complete: false,
        coverage: {
          complete: false, pages: 0, rows: 0,
          requested_start_time: start - 65_000, requested_end_time: end,
          last_trade_time: null, limit_reached: false,
          pagination: 'aggTrade ID cursor; unique aggregate trade IDs',
          fallback_reason: String(error?.message ?? error).slice(0, 240)
        }
      };
    }
    const tickerConfig = config.strongMoveRadar || {};
    const minQuoteVolume24h = Number(tickerConfig.minQuoteVolume24h ?? 1_000_000);
    const lastAlertAt = {value: 0};
    const replay = runHistoricalReplay({
      symbol,
      oneMinuteCandles: candleFetch.candles,
      // Partial aggTrade pages are deliberately discarded: mixing partial flow into
      // a decision could bias ratios. Candle-only replay uses actual closed Binance
      // candles and marks every result with the exact-trade-timestamp limitation.
      aggTrades: tradeFetch.complete ? tradeFetch.trades : [],
      startTime: start,
      endTime: end,
      outcomeEndTime:observationEnd,
      outcomeHorizonMs:outcomeHorizonHours*HOUR_MS,
      tradeCoverageComplete: tradeFetch.complete,
      allowCandleOnlyFallback: true,
      timeframeCandles,
      tradeCoverage: {...tradeFetch.coverage, candle_pages: candleFetch.pages, candles_complete: candleFetch.complete,
        detector_profile:detectorProfile,additional_timeframes:timeframeCoverage,additional_timeframe_errors:timeframeFetchErrors},
      alertCooldownMs: Number(tickerConfig.alertCooldownMs ?? 12 * MINUTE_MS),
      evaluate: input => {
        if(detectorProfile==='RADAR8_PREMOVE_SHADOW'){
          const evidence=buildEarlyExpansionEvidence({
            series:{
              '1m':input.oneMinute,'5m':input.fiveMinute,
              '15m':input.timeframes?.['15m']||[],
              '1h':input.timeframes?.['1h']||[],
              '4h':input.timeframes?.['4h']||[]
            },
            ticker:input.ticker,
            marketContext:{fiveMinute:input.timeframes?.['BTCUSDT:5m']||[]},
            now:input.now,config:config.earlyExpansionRadar||{},historicalReplay:true,
            liveAggTrades:input.aggTrades
          });
          const fp=evidence.pre_expansion_fingerprint||{};
          const stage=String(fp.stage||evidence.pre_expansion_stage||'DATA_INSUFFICIENT');
          const valid=evidence.gates?.data_gate?.valid===true&&Number(evidence.data_quality)>=Number(config.earlyExpansionRadar?.minDataQuality??70)&&
            evidence.data_stale!==true&&evidence.closed_candles_only===true&&numericOrNull(input.ticker.priceChange24h)!==null;
          const forbidden=new Set(['ALREADY_EXTENDED','HIGH_RISK_PUMP','HIGH_RISK_DUMP','RECENT_FAKEOUT','CONTINUATION_NOT_CONFIRMED']);
          const risk=(Array.isArray(evidence.risk_flags)?evidence.risk_flags:[]).some(x=>forbidden.has(String(x).toUpperCase()));
          const eligible=valid&&!risk&&['PRE_EXPANSION','WATCH_EARLY'].includes(stage);
          return buildCandidateShadowResult(detectorProfile,evidence,input,{
            eligible,score:evidence.forensic_evidence_score??evidence.early_expansion_score,stage,
            reasonCodes:[...(evidence.reason_codes||[]),...(!valid?['HISTORICAL_DATA_OR_FRESHNESS_GATE_FAILED']:[]),
              ...(risk?['ANTI_CHASE_OR_FAKEOUT_GATE_FAILED']:[])],
            extraGateFailures:['HISTORICAL_ORDERBOOK_UNAVAILABLE','LIVE_PUSH_GATE_NOT_SIMULATED']
          });
        }
        if(detectorProfile==='ALMUQAWIM_RADAR'){
          const series={
            '15m':input.timeframes?.['15m']||[],
            '1h':input.timeframes?.['1h']||[],
            '4h':input.timeframes?.['4h']||[]
          };
          const analysis=buildAlMuqawimAnalysis(series,input.ticker,input.now,config.alMuqawimRadar||{});
          const eligible=analysis.eligible===true&&analysis.direction==='UP'&&analysis.closed_candles_only===true;
          return buildCandidateShadowResult(detectorProfile,analysis,input,{
            eligible,score:analysis.score,stage:analysis.stage,
            reasonCodes:analysis.reason_codes||analysis.data_quality_reasons||[],
            extraGateFailures:['HISTORICAL_PUSH_DELIVERY_NOT_SIMULATED']
          });
        }
        if(detectorProfile==='DOOMSDAY_RADAR'){
          const analysis=buildDoomsdayAnalysis({
            oneMinute:input.oneMinute,fiveMinute:input.fiveMinute,
            btcFiveMinute:input.timeframes?.['BTCUSDT:5m']||[],
            ticker:input.ticker,instantChangePct:input.ticker.priceChange24h,
            now:input.now,max24hMovePct:Number(config.doomsdayRadar?.max24hMovePct)||18
          });
          const eligible=analysis.eligible===true&&analysis.direction==='UP'&&analysis.closed_candles_only===true&&analysis.data_stale!==true;
          return buildCandidateShadowResult(detectorProfile,analysis,input,{
            eligible,score:analysis.early_score??analysis.score,stage:analysis.stage,
            reasonCodes:analysis.reason_codes||analysis.data_quality_reasons||[],
            extraGateFailures:['HISTORICAL_ORDERBOOK_UNAVAILABLE','LIVE_PUSH_GATE_NOT_SIMULATED']
          });
        }
        const alert = buildStrongMoveAlert({
          one_minute: input.oneMinute,
          five_minute: input.fiveMinute,
          ticker: input.ticker,
          agg_trades: input.aggTrades
        }, input.now);
        alert.observed_at = input.now;
        alert.source_event_at = alert.source_candle_close_at ?? input.now;
        const a = alert.strong_move || {};
        const cs = a.component_scores || {};
        const m = a.metrics || {};
        const alertScore = Math.max(Number(a.score) || 0, Number(cs.flash) || 0);
        const volumeQuote = Math.max(1, Number(input.ticker.quoteVolume24h) || 0);
        const liquidityScore = Math.max(0, Math.min(100, 70 + Math.log10(Math.max(1, volumeQuote / minQuoteVolume24h)) * 30));
        const participationValues = [Number(cs.volume), Number(cs.trades)].filter(Number.isFinite);
        const participationScore = participationValues.length
          ? participationValues.reduce((sum, value) => sum + value, 0) / participationValues.length : 50;
        const eliteGate = evaluateEliteGate({
          radar: 'STRONG_MOVE_RADAR',
          direction: a.direction,
          baseScore: alertScore,
          priceChange24h: input.ticker.priceChange24h,
          liquidityScore,
          // Use the analyzer's observed closed-candle quality; never seed a perfect historical score.
          dataQualityScore: Number(a.data_quality) || 0,
          triggerScore: Math.max(Number(cs.flash) || 0, Number(cs.breakout) || 0),
          structureScore: Math.max(Number(cs.breakout) || 0, Number(cs.ema) || 0),
          participationScore,
          flowScore: Number(cs.taker) || 50,
          relativeScore: Number(m.five_min_trend) || 50,
          momentumScore: Math.max(Number(cs.velocity) || 0, Number(cs.flash) || 0),
          compressionScore: Math.max(Number(cs.bollinger) || 0, Number(cs.range) || 0),
          confirmations: Number(m.flash_confirmations) || 0,
          minConfirmations: 4, minScore: 86, max24hMovePct: 8,
          requireTrigger: true, minCategoryHits: 5
        });
        alert.elite_gate = eliteGate;
        alert.data_quality = Number(a.data_quality) || 0;
        alert.liquidity_quality = liquidityScore;
        alert.data_status = {status:a.data_stale?'DATA_STALE':'LIVE_DATA',stale:Boolean(a.data_stale),future_data_detected:false,source:'Binance Public REST'};
        const strictFailures = [];
        if (!alert.eligible) strictFailures.push('STRONG_MOVE_CORE_GATE_FAILED');
        if (alertScore < Number(tickerConfig.minScore ?? 76)) strictFailures.push('SCORE_BELOW_STRICT_THRESHOLD');
        if (!eliteGate.eligible) strictFailures.push(...(Array.isArray(eliteGate.failures)?eliteGate.failures:['ELITE_GATE_NOT_ELIGIBLE']));
        let notificationGate = {eligible:false,failures:strictFailures,standard_gate_failures:strictFailures};
        const cooldownBlocked = input.now - lastAlertAt.value < Number(tickerConfig.alertCooldownMs ?? 12 * MINUTE_MS);
        if (!strictFailures.length && !cooldownBlocked) {
          notificationGate = evaluateRadarNotificationGate(alert, {now:input.now,commit:false});
        }
        if (!notificationGate.eligible) strictFailures.push(...(Array.isArray(notificationGate.failures)?notificationGate.failures:[]));
        if (cooldownBlocked) strictFailures.push('LOCAL_ALERT_COOLDOWN');
        const earlyGate = evaluateDynamicEarlyWarningGate(alert, input.ticker, {
          now:input.now,
          alertScore,
          minQuoteVolume24h,
          strictFailures,
          coreTriggerFailures: Array.isArray(eliteGate.failures)?eliteGate.failures:[],
          lastAlertAt:lastAlertAt.value,
          earlyCooldownMs:Number(tickerConfig.alertCooldownMs ?? 12 * MINUTE_MS)
        });
        const strictAccepted = Boolean(alert.eligible && alertScore >= Number(tickerConfig.minScore ?? 76) &&
          eliteGate.eligible && notificationGate.eligible && !cooldownBlocked);
        // Historical replay records early warnings as their own accepted lane without
        // pretending that they passed the strict entry gate.
        const earlyWarningAccepted = Boolean(!strictAccepted && earlyGate.eligible && !cooldownBlocked);
        const accepted = strictAccepted || earlyWarningAccepted;
        if (accepted) lastAlertAt.value = input.now;
        return {
          accepted,
          accepted_mode: strictAccepted ? 'STRICT' : (earlyWarningAccepted ? 'EARLY_WARNING' : 'NONE'),
          early_warning: earlyGate,
          strict_gate_failures: notificationGate.standard_gate_failures ?? notificationGate.failures ?? strictFailures,
          alert,
          score: alertScore,
          stage: alert.potential_label ?? a.stage,
          notificationGate,
          reason_codes: notificationGate.failures ?? strictFailures,
          liquidity_acceleration: a.metrics?.liquidity_acceleration?.three_minute_acceleration ?? null
        };
      }
    });
    const expectedWindowCandles = Math.floor((end - start) / MINUTE_MS) + 1;
    const observedWindowCandles = replay.steps.length;
    const windowCandlesComplete = observedWindowCandles >= expectedWindowCandles;
    const outcomeObservationComplete = observationEnd >= end + outcomeHorizonHours * HOUR_MS && candleFetch.complete &&
      replay.steps.length>0 && replay.steps.every(step=>step?.outcome?.horizon_observed===true);
    replay.detector_profile=detectorSpec;
    replay.detector_evaluation_mode=detectorSpec.mode;
    replay.data_quality.detector_profile=detectorProfile;
    replay.data_quality.additional_timeframes=timeframeCoverage;
    replay.data_quality.additional_timeframe_errors=timeframeFetchErrors;
    replay.data_quality.candle_pages = candleFetch.pages;
    replay.data_quality.candle_fetch_complete = windowCandlesComplete;
    replay.data_quality.outcome_candle_fetch_complete = outcomeObservationComplete;
    replay.data_quality.outcome_observation_end_time = observationEnd;
    replay.data_quality.outcome_horizon_hours = outcomeHorizonHours;
    replay.data_quality.window_candles_expected = expectedWindowCandles;
    replay.data_quality.window_candles_observed = observedWindowCandles;
    replay.data_quality.trade_coverage_complete = tradeFetch.complete;
    replay.data_quality.trade_coverage = tradeFetch.coverage;
    replay.data_quality.trade_coverage_window_end = end;
    replay.data_quality.trades_missing = !tradeFetch.complete;
    replay.data_quality.candle_only_fallback_used = !tradeFetch.complete && windowCandlesComplete && replay.steps.length > 0;
    replay.data_quality.replay_mode = !windowCandlesComplete ? 'BLOCKED_INCOMPLETE' :
      (tradeFetch.complete ? 'FULL_TRADE' : (replay.data_quality.candle_only_fallback_used ? 'CANDLE_ONLY_FALLBACK' : 'BLOCKED_INCOMPLETE'));
    replay.data_quality.coverage_status = replay.data_quality.replay_mode === 'BLOCKED_INCOMPLETE'
      ? 'INCOMPLETE' : (tradeFetch.complete ? 'COMPLETE' : 'COMPLETE_WITH_CANDLE_FALLBACK');
    replay.data_quality.synthetic_data_used = false;
    report.results.push(replay);
    process.stderr.write('[REPLAY] ' + symbol + ' steps=' + replay.summary.replay_steps +
      ' accepted=' + replay.summary.accepted + ' rejected=' + replay.summary.rejected +
      ' trade_coverage=' + (tradeFetch.complete ? 'COMPLETE' : 'INCOMPLETE') + '\n');
    } catch (error) {
      const message = String(error?.message ?? error).replace(/[^a-z0-9_.:\- ]/gi, '_').slice(0, 240);
      report.results.push({
        engine: 'RADARX_HISTORICAL_REPLAY_V1', symbol,
        range: {start_time: start, end_time: end},
        data_quality: {source: 'BINANCE_PUBLIC_REST', real_market_data_required: true,
          synthetic_data_used: false, candle_fetch_complete: false, trade_coverage_complete: false,
          failure: message},
        summary: {replay_steps: 0, accepted: 0, rejected: 0,
          first_accepted_at: null, first_actual_window_50pct_at: null, first_actual_window_70pct_at: null},
        steps: [],
        policy: {market: 'SPOT', paper_trading: true, real_order_execution: false, confidence_score: 'UNKNOWN'}
      });
      process.stderr.write('[REPLAY_ERROR] ' + symbol + ' ' + message + '\n');
    }
  }
  const dir = dirname(output);
  await mkdir(dir, {recursive: true});
  const temp = output + '.tmp-' + process.pid;
  await writeFile(temp, JSON.stringify(report, null, 2) + '\n', {encoding: 'utf8', flag: 'wx'});
  await rename(temp, output);
  process.stdout.write(JSON.stringify({
    output, generated_at: report.generated_at,
    symbols: report.results.map(x => ({
      symbol: x.symbol, steps: x.summary.replay_steps, accepted: x.summary.accepted,
      accepted_modes: x.summary.accepted_mode_counts ?? [],
      rejected: x.summary.rejected, trade_coverage_complete: x.data_quality.trade_coverage_complete,
      replay_mode: x.data_quality.replay_mode ?? 'BLOCKED_INCOMPLETE',
      candle_only_fallback_used: x.data_quality.candle_only_fallback_used === true,
      premove_50_status: x.summary.premove_50_status,
      first_accepted_at: x.summary.first_accepted_at,
      first_early_warning_accepted_at: x.summary.first_early_warning_accepted_at,
      first_strict_accepted_at: x.summary.first_strict_accepted_at,
      first_window_5pct_at:x.summary.first_actual_window_5pct_at,
      first_window_15pct_at:x.summary.first_actual_window_15pct_at,
      first_window_50pct_at: x.summary.first_actual_window_50pct_at,
      first_window_70pct_at: x.summary.first_actual_window_70pct_at,
      move_outcomes: x.evaluation ? {
        moderate_move: x.evaluation.moderate_move?.classification ?? 'UNAVAILABLE',
        minutes_before_5pct: x.evaluation.moderate_move?.minutes_before_move ?? null,
        strong_move: x.evaluation.strong_move?.classification ?? 'UNAVAILABLE',
        minutes_before_15pct: x.evaluation.strong_move?.minutes_before_move ?? null,
        accepted_with_matured_outcomes: x.evaluation.observation?.accepted_with_matured_outcomes ?? 0,
        low_follow_through_count: x.evaluation.summary?.low_follow_through_count ?? 0,
        missed_move_failure_codes: x.evaluation.missed_move_failure_codes ?? []
      } : null
    })),
    policy: report.policy
  }, null, 2) + '\n');
  // The batch succeeds when every symbol has a complete closed-candle replay.
  // Incomplete aggregate-trade history remains visible in each row and cannot be
  // mistaken for precise trade-crossing timestamps; missing candle coverage still fails.
  if (report.results.some(x => x.data_quality.candle_fetch_complete !== true ||
      !(Number(x.summary.replay_steps) > 0) ||
      !['FULL_TRADE', 'CANDLE_ONLY_FALLBACK'].includes(x.data_quality.replay_mode))) {
    process.exitCode = 2;
  }
}
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write('[REPLAY_ERROR] ' + String(error?.stack ?? error) + '\n');
    process.exitCode = 1;
  });
}
