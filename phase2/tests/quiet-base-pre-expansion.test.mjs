import test from 'node:test';
import assert from 'node:assert/strict';
import { assessQuietBasePreExpansion, summarizeQuietBasePreExpansion } from '../core/quiet-base-pre-expansion.mjs';

const start = 1_800_000_000_000;
const step = 5 * 60_000;
const closeTime = candle => candle.openTime + step - 1;

function quietBase({ participation = 'gradual', taker = 0.5, count = 90 } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const openTime = start + i * step;
    const baseClose = 1 + Math.min(i, count - 14) * 0.00025;
    const halfRange = i < count - 14 ? 0.004 : 0.0003;
    let volume = 1000, tradeCount = 100;
    if (participation === 'gradual' && i >= count - 12) {
      const bucket = Math.floor((i - (count - 12)) / 4);
      volume = [1050, 1150, 1320][bucket];
      tradeCount = [105, 116, 134][bucket];
    }
    rows.push({
      openTime, closeTime: openTime + step - 1,
      open: baseClose - 0.00008, high: baseClose + halfRange,
      low: baseClose - halfRange, close: baseClose,
      volume, quoteVolume: volume * baseClose, tradeCount,
      takerBuyBaseVolume: volume * taker, closed: true
    });
  }
  return rows;
}

function analyze(rows, { daily = 2.1, ageMs = 1, dataReady = true } = {}) {
  return assessQuietBasePreExpansion({
    fiveMinute: rows,
    ticker: { symbol: 'MAGICUSDT', lastPrice: rows.at(-1)?.close, priceChange24h: daily },
    now: closeTime(rows.at(-1)) + ageMs,
    dataReady
  });
}

test('MAGIC-like quiet base is identified before the withheld breakout using closed candles only', () => {
  const base = quietBase();
  const asOf = closeTime(base.at(-1)) + 1;
  const future = [];
  for (let i = 0; i < 3; i++) {
    const prev = future.at(-1) || base.at(-1);
    const openTime = prev.openTime + step;
    const open = prev.close;
    const close = open * 1.018;
    future.push({
      openTime, closeTime: openTime + step - 1, open,
      high: close * 1.01, low: open * 0.995, close,
      volume: 5000, quoteVolume: close * 5000, tradeCount: 400,
      takerBuyBaseVolume: 1900, closed: true
    });
  }
  const withoutFuture = assessQuietBasePreExpansion({
    fiveMinute: base, ticker: { lastPrice: base.at(-1).close, priceChange24h: 2.1 }, now: asOf
  });
  const withFuture = assessQuietBasePreExpansion({
    fiveMinute: [...base, ...future], ticker: { lastPrice: base.at(-1).close, priceChange24h: 2.1 }, now: asOf
  });
  assert.equal(withoutFuture.classification, 'PRE_EXPANSION', JSON.stringify(withoutFuture));
  assert.equal(withFuture.classification, withoutFuture.classification);
  assert.equal(withFuture.candle_close_time_ms, closeTime(base.at(-1)));
  assert.equal(withFuture.metrics.last_closed_price, withoutFuture.metrics.last_closed_price);
  assert.equal(withFuture.metrics.future_candles_excluded, future.length);
  assert.ok(withFuture.evidence.every(item => item.used_through_candle_close_time_ms === closeTime(base.at(-1))));
  assert.equal(withFuture.closed_candles_only, true);
});

test('quiet price alone does not create a pre-expansion signal when volume and trades stay flat', () => {
  const result = analyze(quietBase({ participation: 'flat' }));
  assert.notEqual(result.classification, 'PRE_EXPANSION');
  assert.ok(['WATCH_EARLY', 'NO_SIGNAL'].includes(result.classification));
  assert.equal(result.detected, false);
  assert.ok(result.evidence.some(item => item.key === 'gradual_volume_vs_same_coin' && item.passed === false));
  assert.ok(result.evidence.some(item => item.key === 'gradual_trades_vs_same_coin' && item.passed === false));
});

test('extended setup is anti-chase, not relabeled as quiet pre-expansion', () => {
  const result = analyze(quietBase(), { daily: 14 });
  assert.equal(result.classification, 'ALREADY_EXTENDED');
  assert.equal(result.detected, false);
  assert.ok(result.evidence.find(item => item.key === 'anti_chase').passed === false);
});

test('missing daily percentage is DATA_INSUFFICIENT instead of assuming the coin is quiet', () => {
  const rows = quietBase();
  const result = assessQuietBasePreExpansion({
    fiveMinute: rows,
    ticker: { symbol: 'MAGICUSDT', lastPrice: rows.at(-1).close, priceChange24h: null },
    now: closeTime(rows.at(-1)) + 1
  });
  assert.equal(result.classification, 'DATA_INSUFFICIENT');
  assert.ok(result.evidence[0].reason === 'DAILY_CHANGE_UNKNOWN');
});

test('stale closed candles are DATA_INSUFFICIENT', () => {
  const rows = quietBase();
  const result = analyze(rows, { ageMs: 10 * 60_000 });
  assert.equal(result.classification, 'DATA_INSUFFICIENT');
  assert.equal(result.metrics.stale, true);
});

test('a missing candle in the used 5m replay window is rejected instead of compressing across the gap', () => {
  const rows = quietBase();
  rows.splice(75, 1);
  const result = analyze(rows);
  assert.equal(result.classification, 'DATA_INSUFFICIENT');
  assert.equal(result.reason, 'CLOSED_CANDLE_SEQUENCE_HAS_GAPS');
});

test('low taker-buy does not independently reject a valid quiet base', () => {
  const result = analyze(quietBase({ taker: 0.32 }));
  assert.equal(result.classification, 'PRE_EXPANSION', JSON.stringify(result));
  assert.equal(result.metrics.flow_state, 'POSSIBLE_ABSORPTION');
  assert.equal(result.detected, true);
});

test('cycle summary counts fingerprint stages, participation rejections and scan latency', async () => {
  const { summarizeQuietBasePreExpansion } = await import('../core/quiet-base-pre-expansion.mjs');
  const valid = analyze(quietBase());
  const flat = analyze(quietBase({ participation: 'flat' }));
  const extended = analyze(quietBase(), { daily: 14 });
  const missing = assessQuietBasePreExpansion({
    fiveMinute: [], ticker: { lastPrice: 1, priceChange24h: 1 }, now: closeTime(quietBase().at(-1)) + 1
  });
  const summary = summarizeQuietBasePreExpansion([
    { symbol: 'MAGICUSDT', pre_expansion_fingerprint: { quiet_base_pre_expansion: valid }, quiet_base_scan_latency_ms: 1200 },
    { symbol: 'FLATUSDT', pre_expansion_fingerprint: { quiet_base_pre_expansion: flat }, quiet_base_scan_latency_ms: 2800 },
    { symbol: 'LATEUSDT', pre_expansion_fingerprint: { quiet_base_pre_expansion: extended }, quiet_base_scan_latency_ms: 800 },
    { symbol: 'MISSINGUSDT', pre_expansion_fingerprint: { quiet_base_pre_expansion: missing }, quiet_base_scan_latency_ms: null },
    { symbol: 'FAILEDUSDT', failed: true }
  ]);
  assert.equal(summary.evaluated_total, 4);
  assert.equal(summary.pre_expansion_total, 1);
  assert.equal(summary.already_extended_total, 1);
  assert.equal(summary.data_insufficient_total, 1);
  assert.equal(summary.no_signal_total + summary.watch_early_total, 1);
  assert.ok(summary.any_participation_not_improving_total >= 1);
  assert.equal(summary.average_scan_latency_ms, 1600);
  assert.equal(summary.max_scan_latency_ms, 2800);
});


test('cycle summary reads micro-stage fingerprints and derives measured scheduler latency',()=>{
  const fingerprint=analyze(quietBase());
  const summary=summarizeQuietBasePreExpansion([{
    row:{symbol:'MICROUSDT'},
    scheduler_scan_started_at_ms:1000,
    scheduler_scan_completed_at_ms:1750,
    micro_fingerprint:{quiet_base_pre_expansion:fingerprint}
  }]);
  assert.equal(summary.evaluated_total,1);
  assert.equal(summary.pre_expansion_total,1);
  assert.equal(summary.average_scan_latency_ms,750);
  assert.equal(summary.max_scan_latency_ms,750);
});
