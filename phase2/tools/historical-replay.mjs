#!/usr/bin/env node
import {mkdir, writeFile, rename} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {CONFIG} from '../config.mjs';
import {RestClient} from '../market/binance-rest.mjs';
import {buildStrongMoveAlert, finalizeStrongMoveCandidate} from '../core/strong-move-radar.mjs';
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
  while (cursor <= end && pages < 20) {
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
  return {candles: [...byOpen.values()].sort((a, b) => a.openTime - b.openTime), pages, complete: cursor > end || rows.length < pages * 1000};
}

async function fetchAggregateTrades(client, symbol, start, end, {maxPages, maxTrades}) {
  let cursor = start;
  let fromId = null;
  const all = new Map();
  let pages = 0;
  let complete = false;
  let lastTimestamp = null;
  while (pages < maxPages && all.size < maxTrades) {
    const remaining = maxTrades - all.size;
    const result = await client.aggTrades(symbol, fromId == null
      ? {startTime: cursor, endTime: end, limit: Math.min(1000, remaining)}
      : {fromId, endTime: end, limit: Math.min(1000, remaining)});
    const page = normalizedTrades(result.trades ?? result.data ?? []);
    pages++;
    if (!page.length) { complete = true; break; }
    for (const trade of page) all.set(trade.a, trade);
    const last = page[page.length - 1];
    lastTimestamp = last.T;
    if (last.T >= end) { complete = true; break; }
    if (page.length < Math.min(1000, remaining)) { complete = true; break; }
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
      '       [--lookback-hours 24] [--max-trade-pages 300] [--max-trades 250000] [--output path]',
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
  const start = timeArg(flag(args, '--start'), 'start') ?? (end - lookbackHours * HOUR_MS);
  if (start >= end || end > now + MINUTE_MS || end - start > 7 * 24 * HOUR_MS) throw new Error('INVALID_REPLAY_WINDOW');
  const maxPages = integerArg(flag(args, '--max-trade-pages', '300'), 300, 1, 1000, 'max-trade-pages');
  const maxTrades = integerArg(flag(args, '--max-trades', '250000'), 250000, 1000, 1000000, 'max-trades');
  const output = resolve(flag(args, '--output', './.radarx-data/historical-replay-' + new Date(now).toISOString().replace(/[:.]/g, '-') + '.json'));
  const config = CONFIG;
  const client = new RestClient({...config.rest, baseUrls: config.rest.baseUrls ?? config.rest.urls});
  const report = {
    engine: 'RADARX_HISTORICAL_REPLAY_BATCH_V1',
    generated_at: new Date(now).toISOString(),
    window: {start, start_iso: new Date(start).toISOString(), end, end_iso: new Date(end).toISOString()},
    symbol_count: symbols.length,
    note: 'The evaluator receives only history available by each candle close. Outcome labels use later candles only after a decision has been recorded.',
    results: [],
    policy: {market: 'SPOT', paper_trading: true, real_order_execution: false, confidence_score: 'UNKNOWN'}
  };

  for (const symbol of symbols) {
    process.stderr.write('[REPLAY] ' + symbol + ' fetching closed 1m candles…\n');
    const candleFetch = await fetchOneMinute(client, symbol, start - 24 * HOUR_MS - 125 * MINUTE_MS, end);
    const tradeFetch = await fetchAggregateTrades(client, symbol, start - 65_000, end, {maxPages, maxTrades});
    const tickerConfig = config.strongMoveRadar || {};
    const minQuoteVolume24h = Number(tickerConfig.minQuoteVolume24h ?? 1_000_000);
    const lastAlertAt = {value: 0};
    const replay = runHistoricalReplay({
      symbol,
      oneMinuteCandles: candleFetch.candles,
      aggTrades: tradeFetch.trades,
      startTime: start,
      endTime: end,
      tradeCoverageComplete: tradeFetch.complete,
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
        const finalized = finalizeStrongMoveCandidate(alert, {
          ...input.ticker, minQuoteVolume24h
        }, {
          now: input.now,
          minScore: Number(tickerConfig.minScore ?? 76),
          lastAlertAt: lastAlertAt.value,
          alertCooldownMs: Number(tickerConfig.alertCooldownMs ?? 12 * MINUTE_MS),
          telemetry: false
        });
        if (finalized.accepted) lastAlertAt.value = input.now;
        return {
          accepted: finalized.accepted,
          alert,
          score: finalized.alertScore,
          stage: alert.potential_label ?? alert.strong_move?.stage,
          notificationGate: finalized.notificationGate,
          reason_codes: finalized.notificationGate.failures,
          liquidity_acceleration: alert.strong_move?.metrics?.liquidity_acceleration?.three_minute_acceleration ?? null
        };
      }
    });
    replay.data_quality.candle_pages = candleFetch.pages;
    replay.data_quality.candle_fetch_complete = candleFetch.complete;
    replay.data_quality.trade_coverage_complete = tradeFetch.complete;
    replay.data_quality.trade_coverage = tradeFetch.coverage;
    replay.data_quality.trades_missing = !tradeFetch.complete;
    report.results.push(replay);
    process.stderr.write('[REPLAY] ' + symbol + ' steps=' + replay.summary.replay_steps +
      ' accepted=' + replay.summary.accepted + ' rejected=' + replay.summary.rejected +
      ' trade_coverage=' + (tradeFetch.complete ? 'COMPLETE' : 'INCOMPLETE') + '\n');
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
      rejected: x.summary.rejected, trade_coverage_complete: x.data_quality.trade_coverage_complete,
      first_window_50pct_at: x.summary.first_actual_window_50pct_at,
      first_window_70pct_at: x.summary.first_actual_window_70pct_at
    })),
    policy: report.policy
  }, null, 2) + '\n');
  if (report.results.some(x => !x.data_quality.trade_coverage_complete || !x.data_quality.candle_fetch_complete)) {
    process.exitCode = 2;
  }
}
main().catch(error => {
  process.stderr.write('[REPLAY_ERROR] ' + String(error?.stack ?? error) + '\n');
  process.exitCode = 1;
});
