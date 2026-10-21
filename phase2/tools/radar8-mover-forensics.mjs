#!/usr/bin/env node
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CONFIG} from '../config.mjs';
import {RestClient} from '../market/binance-rest.mjs';
import {normalizeHistoricalCandles, aggregateFiveMinuteCandles, runHistoricalReplay} from '../core/historical-replay.mjs';
import {
  EARLY_EXPANSION_RADAR_DEFAULTS,
  buildMicroFingerprint,
  isFastActivityShockCandidate,
  isFastEarlyWatchCandidate,
  isConfirmedEarlyFlowWatchCandidate
} from '../core/early-expansion-radar.mjs';
import {
  buildReplayFastSnapshot,
  classifyForRadar8MoverForensics,
  firstClosedCandleCrossing,
  minutesBeforeClosedCandleCrossing
} from '../core/radar8-mover-forensics.mjs';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_SYMBOLS = ['IOSTUSDT','ALTUSDT','CVXUSDT','WUSDT','ENAUSDT','CYPHBUSDT'];
const here = dirname(fileURLToPath(import.meta.url));

function flag(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : (args[index + 1] ?? fallback);
}
function isoMs(value, label) {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) throw new Error('INVALID_' + label.toUpperCase());
  return parsed;
}
function parseSymbols(raw) {
  const values = String(raw ?? DEFAULT_SYMBOLS.join(',')).split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);
  if (!values.length || values.some(x=>!/^[A-Z0-9]{5,20}$/.test(x))) throw new Error('INVALID_SYMBOL_LIST');
  return [...new Set(values)];
}
function median(values) {
  const rows = values.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length/2);
  return rows.length%2 ? rows[mid] : (rows[mid-1]+rows[mid])/2;
}
function isFiniteNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

async function fetchOneMinute(client, symbol, startMs, endMs, maxPages = 6) {
  const requestedStart = Math.floor(startMs / MINUTE_MS) * MINUTE_MS;
  const requestedLastOpen = Math.floor((endMs + 1) / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
  if (requestedLastOpen < requestedStart) throw new Error('EMPTY_CANDLE_WINDOW:' + symbol);
  const raw = [];
  let cursor = requestedStart;
  let pages = 0;
  while (cursor <= requestedLastOpen && pages < maxPages) {
    const response = await client.klines(symbol, '1m', {
      limit: 1000, startTime: cursor, endTime: endMs
    });
    const page = (Array.isArray(response?.candles) ? response.candles : [])
      .filter(c => isFiniteNumber(c?.openTime) && Number(c.openTime) >= cursor &&
        Number(c.openTime) <= requestedLastOpen && Number(c.closeTime) <= endMs)
      .sort((a,b)=>Number(a.openTime)-Number(b.openTime));
    if (!page.length) break;
    raw.push(...page);
    const next = Number(page.at(-1).openTime) + MINUTE_MS;
    if (!(next > cursor)) throw new Error('KLINE_CURSOR_DID_NOT_ADVANCE:' + symbol);
    cursor = next;
    pages++;
    if (page.length < 1000) break;
  }
  const rows = normalizeHistoricalCandles(raw, {endTime:endMs});
  const requestedRows = Math.max(0, Math.floor((requestedLastOpen - requestedStart) / MINUTE_MS) + 1);
  const observedRows = rows.filter(c => c.openTime >= requestedStart && c.openTime <= requestedLastOpen);
  let gaps = 0;
  for (let i=1; i<observedRows.length; i++) {
    if (Number(observedRows[i].openTime) - Number(observedRows[i-1].openTime) !== MINUTE_MS) gaps++;
  }
  const complete = observedRows.length === requestedRows &&
    observedRows.length > 0 &&
    Number(observedRows[0].openTime) === requestedStart &&
    Number(observedRows.at(-1).openTime) === requestedLastOpen &&
    gaps === 0;
  return {
    candles: rows, pages,
    coverage: {
      source:'BINANCE_PUBLIC_REST_CLOSED_1M_KLINES',
      requested_start_open_time:requestedStart,
      requested_last_open_time:requestedLastOpen,
      requested_closed_candles:requestedRows,
      received_closed_candles:observedRows.length,
      gap_count:gaps,
      complete
    }
  };
}

function signalLead(firstSignal, crossingAt) {
  return minutesBeforeClosedCandleCrossing(firstSignal?.timestamp, crossingAt);
}

async function replaySymbol({client,symbol,startMs,endMs,historyStartMs,btcFiveMinute,config}) {
  const fetched = await fetchOneMinute(client, symbol, historyStartMs, endMs);
  const allCandles = fetched.candles;
  const fiveMinute = aggregateFiveMinuteCandles(allCandles);
  const observationByTime = new Map();
  let fastHistory = [];
  let lastMicroAcceptedAt = -Infinity;
  let lastFlowWatchAt = -Infinity;
  let lastShockWatchAt = -Infinity;
  const microCooldown = Math.max(0, Number(config.alertCooldownMs ?? 10*MINUTE_MS));
  const flowCooldown = Math.max(0, Number(config.earlyFlowWatchCooldownMs ?? 10*MINUTE_MS));
  const shockCooldown = Math.max(0, Number(config.activityShockCooldownMs ?? 45*MINUTE_MS));

  const replay = runHistoricalReplay({
    symbol,
    oneMinuteCandles:allCandles,
    aggTrades:[],
    startTime:startMs,
    endTime:endMs,
    outcomeEndTime:endMs,
    outcomeHorizonMs:0,
    tradeCoverageComplete:false,
    allowCandleOnlyFallback:true,
    tradeCoverage:{complete:false,reason:'RADAR8_MICRO_STAGE_REPLAY_DOES_NOT_USE_AGGTRADES'},
    alertCooldownMs:0,
    evaluate: input => {
      const fastResult = buildReplayFastSnapshot(input.ticker, fastHistory, input.now);
      fastHistory = fastResult.history;
      const fast = fastResult.fast;
      const btcFive = btcFiveMinute.filter(c=>Number(c.closeTime)<=input.now).slice(-60);
      const fp = buildMicroFingerprint({
        oneMinute:input.oneMinute,
        fiveMinute:input.fiveMinute,
        btcFiveMinute:btcFive,
        ticker:input.ticker,
        now:input.now,
        config
      });
      const latestOne = (Array.isArray(input.oneMinute)?input.oneMinute:[])
        .filter(c=>c?.closed===true&&Number(c.closeTime)<=input.now).at(-1) || null;
      const fastEarly = isFastEarlyWatchCandidate(input.ticker,fast,config);
      const fastShock = isFastActivityShockCandidate(input.ticker,fast,config);
      const earlyFlowWatch = isConfirmedEarlyFlowWatchCandidate({
        row:input.ticker,fast,microFingerprint:fp,decisionBand:fp?.stage,
        dataQuality:null,dataStale:false,
        closedCandleCloseTime:latestOne?.closeTime??null,
        microDataValidated:true
      },config);
      const activityShockWatch = fp?.activity_shock?.detected === true;
      const microQualified = fp?.eligible === true;
      const now = input.now;
      let acceptedMode = 'NONE';
      if (microQualified && now-lastMicroAcceptedAt>=microCooldown) {
        acceptedMode='RADAR8_MICRO_QUALIFIED_FOR_DEEP';
        lastMicroAcceptedAt=now;
      } else if (earlyFlowWatch && now-lastFlowWatchAt>=flowCooldown) {
        acceptedMode='RADAR8_EARLY_FLOW_WATCH_ONLY';
        lastFlowWatchAt=now;
      } else if (activityShockWatch && now-lastShockWatchAt>=shockCooldown) {
        acceptedMode='RADAR8_ACTIVITY_SHOCK_WATCH_ONLY';
        lastShockWatchAt=now;
      }

      const obs = {
        timestamp:now,
        price:isFiniteNumber(input.ticker?.lastPrice)?Number(input.ticker.lastPrice):null,
        price_change_24h_pct:isFiniteNumber(input.ticker?.priceChange24h)?Number(input.ticker.priceChange24h):null,
        micro_stage:fp?.stage??'UNKNOWN',
        micro_mode:fp?.mode??'UNKNOWN',
        micro_score:isFiniteNumber(fp?.score)?Number(fp.score):null,
        micro_confirmations:isFiniteNumber(fp?.confirmation_count)?Number(fp.confirmation_count):0,
        micro_qualified:microQualified,
        early_flow_watch:earlyFlowWatch,
        activity_shock_watch:activityShockWatch,
        fast_early_watch_candidate:fastEarly,
        fast_activity_shock_candidate:fastShock,
        accepted_mode:acceptedMode,
        risk_flags:Array.isArray(fp?.risk_flags)?fp.risk_flags.slice(0,12):[],
        reason_codes:Array.isArray(fp?.reasons)?fp.reasons.slice(0,16):[],
        data_quality_reasons:Array.isArray(fp?.reason_codes)?fp.reason_codes.slice(0,16):[],
        fast:{
          volume_accel_ratio:isFiniteNumber(fast?.volume_accel_ratio)?Number(fast.volume_accel_ratio):null,
          trade_accel_ratio:isFiniteNumber(fast?.trade_accel_ratio)?Number(fast.trade_accel_ratio):null,
          price_change_pct:isFiniteNumber(fast?.price_change_pct)?Number(fast.price_change_pct):null,
          price_acceleration_pct:isFiniteNumber(fast?.price_acceleration_pct)?Number(fast.price_acceleration_pct):null,
          quote_delta:isFiniteNumber(fast?.volume_delta_quote)?Number(fast.volume_delta_quote):null,
          trade_delta:isFiniteNumber(fast?.trade_delta)?Number(fast.trade_delta):null,
          warmed_up:fast?.warmed_up===true
        },
        metrics:fp?.metrics||{}
      };
      observationByTime.set(now,obs);
      const alert={eligible:microQualified,potential_label:fp?.stage??'UNKNOWN',
        opportunity_score:isFiniteNumber(fp?.score)?Number(fp.score):null,
        risk_flags:obs.risk_flags,metrics:obs.metrics};
      return {
        accepted:acceptedMode!=='NONE',
        accepted_mode:acceptedMode,
        eligible:microQualified,
        score:isFiniteNumber(fp?.score)?Number(fp.score):null,
        stage:fp?.stage??'UNKNOWN',
        reason_codes:[...new Set([...obs.reason_codes,...obs.data_quality_reasons,
          fastEarly?'FAST_EARLY_WATCH_CANDIDATE':null,
          fastShock?'FAST_ACTIVITY_SHOCK_CANDIDATE':null,
          earlyFlowWatch?'EARLY_FLOW_WATCH_ONLY':null,
          activityShockWatch?'ACTIVITY_SHOCK_WATCH_ONLY':null].filter(Boolean))],
        early_warning:earlyFlowWatch?{eligible:true,score:obs.micro_score,confirmations:obs.micro_confirmations,mode:'RADAR8_EARLY_FLOW_WATCH_ONLY'}:null,
        alert
      };
    }
  });

  const firstWindowCandle = allCandles.find(c=>Number(c.openTime)>=startMs&&Number(c.closeTime)<=endMs);
  const baselinePrice = firstWindowCandle?.open>0?Number(firstWindowCandle.open):null;
  const crossing = targetPct => firstClosedCandleCrossing(allCandles,{
    startTime:startMs,endTime:endMs,baselinePrice,targetPct
  });
  const crosses = {
    plus_5pct_close_at:crossing(5),
    plus_15pct_close_at:crossing(15),
    plus_50pct_close_at:crossing(50),
    plus_70pct_close_at:crossing(70)
  };
  const observations = [...observationByTime.values()].sort((a,b)=>a.timestamp-b.timestamp);
  const firstOf = predicate => observations.find(predicate) || null;
  const firstMicro = firstOf(x=>x.micro_qualified);
  const firstFlowWatch = firstOf(x=>x.early_flow_watch);
  const firstShockWatch = firstOf(x=>x.activity_shock_watch);
  const firstAccepted = observations.find(x=>x.accepted_mode!=='NONE') || null;
  const accepted = observations.filter(x=>x.accepted_mode!=='NONE');
  const topScores = observations.filter(x=>x.micro_score!==null)
    .sort((a,b)=>Number(b.micro_score)-Number(a.micro_score)||a.timestamp-b.timestamp)
    .slice(0,12)
    .map(x=>({
      timestamp:x.timestamp,timestamp_iso:new Date(x.timestamp).toISOString(),price:x.price,
      price_change_24h_pct:x.price_change_24h_pct,micro_score:x.micro_score,
      confirmations:x.micro_confirmations,stage:x.micro_stage,mode:x.micro_mode,
      micro_qualified:x.micro_qualified,early_flow_watch:x.early_flow_watch,
      activity_shock_watch:x.activity_shock_watch,
      fast:x.fast,reasons:x.reason_codes,risk_flags:x.risk_flags
    }));
  const signalRows = accepted.map(x=>({
    timestamp:x.timestamp,timestamp_iso:new Date(x.timestamp).toISOString(),price:x.price,
    price_change_24h_pct:x.price_change_24h_pct,mode:x.accepted_mode,
    micro_score:x.micro_score,confirmations:x.micro_confirmations,stage:x.micro_stage,
    fast:x.fast,reasons:x.reason_codes,risk_flags:x.risk_flags
  }));
  return {
    symbol,
    asset_class:classifyForRadar8MoverForensics(symbol),
    window:{start:new Date(startMs).toISOString(),end:new Date(endMs).toISOString()},
    data_quality:{
      ...fetched.coverage,
      synthetic_data_used:false,
      orderbook_history_used:false,
      aggregate_trade_history_used:false,
      evaluation_scope:'RADAR8_MICRO_AND_WATCH_ONLY',
      final_deep_and_live_liquidity_gates_replayed:false,
      lookahead_guard:'Each decision sees only closed candles with close time at or before that decision; target crossings are measured from closed OHLC afterward.'
    },
    baseline_price:baselinePrice,
    move_crossings:crosses,
    detection:{
      replay_steps:replay.steps.length,
      micro_qualified_count:observations.filter(x=>x.micro_qualified).length,
      early_flow_watch_observations:observations.filter(x=>x.early_flow_watch).length,
      activity_shock_watch_observations:observations.filter(x=>x.activity_shock_watch).length,
      accepted_watch_or_micro_events:signalRows.length,
      first_micro_qualified_at:firstMicro?.timestamp??null,
      first_micro_qualified_at_iso:firstMicro?new Date(firstMicro.timestamp).toISOString():null,
      first_flow_watch_at:firstFlowWatch?.timestamp??null,
      first_flow_watch_at_iso:firstFlowWatch?new Date(firstFlowWatch.timestamp).toISOString():null,
      first_activity_shock_watch_at:firstShockWatch?.timestamp??null,
      first_activity_shock_watch_at_iso:firstShockWatch?new Date(firstShockWatch.timestamp).toISOString():null,
      first_accepted_event_at:firstAccepted?.timestamp??null,
      first_accepted_event_at_iso:firstAccepted?new Date(firstAccepted.timestamp).toISOString():null,
      minutes_before_plus_5pct:signalLead(firstAccepted,crosses.plus_5pct_close_at),
      minutes_before_plus_15pct:signalLead(firstAccepted,crosses.plus_15pct_close_at),
      minutes_before_plus_50pct:signalLead(firstAccepted,crosses.plus_50pct_close_at),
      minutes_before_plus_70pct:signalLead(firstAccepted,crosses.plus_70pct_close_at),
      watch_before_plus_15pct:Boolean(firstAccepted&&crosses.plus_15pct_close_at&&firstAccepted.timestamp<crosses.plus_15pct_close_at),
      micro_qualified_before_plus_15pct:Boolean(firstMicro&&crosses.plus_15pct_close_at&&firstMicro.timestamp<crosses.plus_15pct_close_at),
      flow_watch_before_plus_15pct:Boolean(firstFlowWatch&&crosses.plus_15pct_close_at&&firstFlowWatch.timestamp<crosses.plus_15pct_close_at)
    },
    signal_rows:signalRows,
    top_micro_observations:topScores
  };
}

async function main() {
  const args=process.argv.slice(2);
  if(args.includes('--help')||args.includes('-h')){
    process.stdout.write([
      'Build 224 Radar 8 historical mover forensics (Binance public Spot, candle-only diagnostic)',
      'Usage: node phase2/tools/radar8-mover-forensics.mjs [--symbols IOSTUSDT,ALTUSDT,...] [--start ISO] [--end ISO] [--lookback-hours 26] [--output reports/radar8-mover-forensics.json]',
      'Default symbols: IOSTUSDT ALTUSDT CVXUSDT WUSDT ENAUSDT CYPHBUSDT.',
      'The report evaluates the actual exported Radar 8 Micro fingerprint / WATCH-only gates. It does NOT pretend to replay order-book-dependent final Deep gates or guarantee a buy signal.'
    ].join('\n')+'\n');
    return;
  }
  const nowFloor=Math.floor(Date.now()/MINUTE_MS)*MINUTE_MS;
  const endMs=flag(args,'--end')?isoMs(flag(args,'--end'),'END'):(nowFloor-1);
  const startMs=flag(args,'--start')?isoMs(flag(args,'--start'),'START'):(endMs-DAY_MS);
  const lookbackHours=Math.trunc(Number(flag(args,'--lookback-hours','26')));
  if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs>=endMs)throw new Error('INVALID_REPLAY_RANGE');
  if(endMs>Date.now())throw new Error('REPLAY_END_IN_FUTURE');
  if(endMs-startMs>7*DAY_MS)throw new Error('REPLAY_WINDOW_EXCEEDS_7_DAYS');
  if(!Number.isInteger(lookbackHours)||lookbackHours<25||lookbackHours>48)throw new Error('INVALID_LOOKBACK_HOURS');
  const symbols=parseSymbols(flag(args,'--symbols',DEFAULT_SYMBOLS.join(',')));
  const historyStartMs=Math.floor((startMs-lookbackHours*HOUR_MS)/MINUTE_MS)*MINUTE_MS;
  const config={...EARLY_EXPANSION_RADAR_DEFAULTS,quote:'USDT'};
  const client=new RestClient({...CONFIG.rest,baseUrls:CONFIG.rest.baseUrls??CONFIG.rest.urls});
  const outputPath=resolve(flag(args,'--output','./reports/radar8-mover-forensics.json'));
  await mkdir(dirname(outputPath),{recursive:true});
  process.stderr.write('[RADAR8_MOVER_FORENSICS] '+JSON.stringify({
    symbols,start:new Date(startMs).toISOString(),end:new Date(endMs).toISOString(),
    history_start:new Date(historyStartMs).toISOString(),lookback_hours:lookbackHours,
    source:'BINANCE_PUBLIC_REST',paper_trading:true,real_order_execution:false
  })+'\n');

  const btcFetched=await fetchOneMinute(client,'BTCUSDT',historyStartMs,endMs);
  const btcFiveMinute=aggregateFiveMinuteCandles(btcFetched.candles);
  const results=[];
  for(const symbol of symbols){
    process.stderr.write('[RADAR8_MOVER_FORENSICS] '+symbol+' start\n');
    try{
      results.push(await replaySymbol({client,symbol,startMs,endMs,historyStartMs,btcFiveMinute,config}));
    }catch(error){
      results.push({
        symbol,asset_class:classifyForRadar8MoverForensics(symbol),
        window:{start:new Date(startMs).toISOString(),end:new Date(endMs).toISOString()},
        data_quality:{source:'BINANCE_PUBLIC_REST_CLOSED_1M_KLINES',synthetic_data_used:false,complete:false,
          error:String(error?.message??error).slice(0,400)},
        detection:{replay_steps:0},
        signal_rows:[],top_micro_observations:[]
      });
    }
  }
  const incomplete=results.filter(x=>x.data_quality?.complete!==true);
  const report={
    engine:'RADARX_BUILD224_RADAR8_MOVER_FORENSICS_V1',
    generated_at:new Date().toISOString(),
    window:{start:new Date(startMs).toISOString(),end:new Date(endMs).toISOString()},
    symbols,bitcoin_benchmark:{
      symbol:'BTCUSDT',
      data_quality:btcFetched.coverage,
      five_minute_closed_candles:btcFiveMinute.filter(c=>c.closed===true&&Number(c.closeTime)<=endMs).length
    },
    data_policy:{
      market:'BINANCE_SPOT',quote:'USDT',
      real_market_data_required:true,synthetic_data_used:false,
      closed_candles_only:true,lookahead_used_for_decisions:false,
      report_scope:'MICRO_SCORE_AND_WATCH_ONLY_DIAGNOSTICS',
      production_final_alert_equivalence:false,
      paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
      limitation:'This isolates Radar 8 Micro/WATCH capability. It does not replay historical order books, the final multi-timeframe Deep scan, the deployed service cadence, or push delivery.'
    },
    summary:{
      requested_symbols:symbols.length,
      completed_symbols:results.filter(x=>x.data_quality?.complete===true).length,
      incomplete_symbols:incomplete.map(x=>({symbol:x.symbol,reason:x.data_quality?.error||'CANDLE_COVERAGE_INCOMPLETE'})),
      signals_before_plus_15pct:results.filter(x=>x.detection?.watch_before_plus_15pct===true).map(x=>x.symbol),
      micro_qualified_before_plus_15pct:results.filter(x=>x.detection?.micro_qualified_before_plus_15pct===true).map(x=>x.symbol),
      flow_watch_before_plus_15pct:results.filter(x=>x.detection?.flow_watch_before_plus_15pct===true).map(x=>x.symbol)
    },
    results
  };
  await writeFile(outputPath,JSON.stringify(report,null,2)+'\n');
  process.stdout.write('[RADAR8_MOVER_FORENSICS_SUMMARY] '+JSON.stringify({
    output:outputPath,...report.summary
  })+'\n');
  if(!btcFetched.coverage.complete||incomplete.length)process.exitCode=2;
}

main().catch(error=>{
  process.stderr.write('[RADAR8_MOVER_FORENSICS_ERROR] '+String(error?.stack??error)+'\n');
  process.exitCode=1;
});
