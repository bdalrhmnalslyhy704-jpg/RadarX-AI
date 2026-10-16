#!/usr/bin/env node
import {mkdir, writeFile, rename} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CONFIG} from '../config.mjs';
import {RestClient} from '../market/binance-rest.mjs';
import {buildStrongMoveAlert} from '../core/strong-move-radar.mjs';
import {evaluateEliteGate} from '../core/elite-confluence-gate.mjs';
import {evaluateRadarNotificationGate} from '../core/radar-notification-gate.mjs';
import {evaluateDynamicEarlyWarningGate} from '../core/dynamic-early-warning-gate.mjs';
import {runHistoricalReplay} from '../core/historical-replay.mjs';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
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

async function fetchOneMinute(client, symbol, start, end) {
  const rows = [];
  let cursor = start;
  let pages = 0;
  const maxPages=Math.min(40,Math.max(1,Math.ceil((end-start+1)/(1000*MINUTE_MS))+1));
  while (cursor <= end && pages < maxPages) {
    const result = await client.klines(symbol, '1m', {limit: 1000, startTime: cursor, endTime: end});
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
    const result = await client.request('/api/v3/aggTrades', query);
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
      '       [--lookback-hours 24] [--outcome-horizon-hours 24] [--max-trade-pages 500] [--max-trades 500000] [--output path]',
      'Default window: last completed minute minus 24 hours. Maximum window: 7 days.',
      'Trade-history pagination that reaches a cap is flagged incomplete and fails closed.',
      'No orders are created, no keys are read, and no Railway deploy is performed.'
    ].join('\n') + '\n');
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
    note: 'The evaluator receives only history available by each candle close. Outcome labels use later candles only after a decision has been recorded.',
    results: [],
    policy: {market: 'SPOT', paper_trading: true, real_order_execution: false, confidence_score: 'UNKNOWN'}
  };

  for (const symbol of symbols) {
    try {
    process.stderr.write('[REPLAY] ' + symbol + ' fetching closed 1m candles…\n');
    const candleFetch = await fetchOneMinute(client, symbol, start - 24 * HOUR_MS - 125 * MINUTE_MS, observationEnd);
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
      tradeCoverage: {...tradeFetch.coverage, candle_pages: candleFetch.pages, candles_complete: candleFetch.complete},
      alertCooldownMs: Number(tickerConfig.alertCooldownMs ?? 12 * MINUTE_MS),
      evaluate: input => {
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
          dataQualityScore: 90,
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
      first_window_70pct_at: x.summary.first_actual_window_70pct_at
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
