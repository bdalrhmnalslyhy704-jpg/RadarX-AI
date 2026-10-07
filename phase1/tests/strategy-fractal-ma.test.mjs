import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateFractalMABottomReversal,
  evaluateFractalMABreakout,
  evaluateFractalMATrendShift
} from '../strategy-fractal-ma.mjs';
import { listActiveStrategies } from '../strategy-registry.mjs';

function makeCandles(closes, intervalMs, startMs, volumeBoostIndex = null) {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    const high = Math.max(open, close) + 0.6;
    const low = Math.min(open, close) - 0.6;
    const volume = volumeBoostIndex === i ? 5000 : 1000;
    const openTime = startMs + i * intervalMs;
    return {
      openTime,
      closeTime: openTime + intervalMs - 1,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume: volume * close,
      tradeCount: 100,
      takerBuyBaseVolume: volume * 0.55,
      takerBuyQuoteVolume: volume * close * 0.55,
      closed: true
    };
  });
}

function bottomCloses() {
  const out = [];
  for (let i = 0; i < 120; i++) {
    let c = 100 - 0.12 * i + 4.5 * Math.sin(i * 0.42);
    if (i >= 80 && i <= 89) c = 85 + Math.abs(i - 85) * 0.7;
    else if (i >= 90 && i <= 104) c = 88 + (i - 90) * 0.45 + 1.2 * Math.sin((i - 90) * 0.6);
    else if (i >= 105 && i <= 112) c = 94 + (i - 105) * 0.4 + 0.7 * Math.sin((i - 105) * 0.7);
    if (i === 113) c = 98;
    if (i === 114) c = 97.8;
    if (i === 115) c = 98.2;
    if (i === 116) c = 99.0;
    if (i === 117) c = 100.0;
    if (i === 118) c = 93.5;
    if (i === 119) c = 99.5;
    out.push(c);
  }
  return out;
}

function breakoutCloses() {
  const out = [];
  for (let i = 0; i < 120; i++) {
    let c = 88 + 0.04 * i + 2.4 * Math.sin(i * 0.43);
    if (i >= 90 && i <= 101) c = 94 + (i - 90) * 0.35 + 0.8 * Math.sin((i - 90) * 0.7);
    const tail = {102:97.5,103:96.5,104:98,105:99,106:98.3,107:100.4,108:99.7,109:100.2,110:99.5,111:100,112:100.8,113:100.1,114:101.2,115:102,116:101.6,117:102.2,118:102.4,119:104.5};
    if (tail[i] !== undefined) c = tail[i];
    out.push(c);
  }
  return out;
}

const now = Date.now();
const oneHour = 3600000;
const fifteenMin = 900000;

test('registry exposes the three fractal + moving-average strategies', () => {
  const ids = new Set(listActiveStrategies().map(x => x.id));
  assert.ok(ids.has('FRACTAL_MA_BOTTOM_REVERSAL'));
  assert.ok(ids.has('FRACTAL_MA_BREAKOUT'));
  assert.ok(ids.has('FRACTAL_MA_TREND_SHIFT'));
  assert.equal(listActiveStrategies().length, 15);
});

test('bottom reversal detects higher-low plus EMA20 reclaim using closed 1h candles', () => {
  const closes = bottomCloses();
  const candles = makeCandles(closes, oneHour, now - 120 * oneHour);
  const result = evaluateFractalMABottomReversal({ series1h: candles, now, config: { fractalSpan: 2, minHigherLowPct: 0.1 } });
  assert.equal(result.direction, 'LONG');
  assert.ok(['CANDIDATE', 'CONFIRMED'].includes(result.state));
  assert.ok(result.evidence.higher_low);
  assert.ok(result.evidence.ema20_reclaim || result.evidence.ema20_near_reclaim);
});

test('fractal breakout detects close above latest confirmed fractal high', () => {
  const closes = breakoutCloses();
  const candles = makeCandles(closes, fifteenMin, now - 120 * fifteenMin, 119);
  const result = evaluateFractalMABreakout({ series15m: candles, now, config: { fractalSpan: 2, breakoutBufferPct: 0.15 } });
  assert.equal(result.direction, 'LONG');
  assert.ok(['CANDIDATE', 'CONFIRMED'].includes(result.state));
  assert.equal(result.evidence.breakout_above_fractal, true);
});

test('trend shift requires both 1h and 15m fractal + MA confirmation', () => {
  const candles1h = makeCandles(bottomCloses(), oneHour, now - 120 * oneHour);
  const candles15m = makeCandles(breakoutCloses(), fifteenMin, now - 120 * fifteenMin, 119);
  const result = evaluateFractalMATrendShift({ series1h: candles1h, series15m: candles15m, now, config: { fractalSpan: 2, minHigherLowPct: 0.1 } });
  assert.equal(result.direction, 'LONG');
  assert.ok(['CANDIDATE', 'CONFIRMED'].includes(result.state));
  assert.ok(result.evidence.one_hour.higher_low);
  assert.ok(result.evidence.one_hour.price_above_ema50);
});

test('open or future candles are never accepted as the trigger candle', () => {
  const closes = bottomCloses();
  const candles = makeCandles(closes, oneHour, now - 120 * oneHour);
  candles.at(-1).closed = false;
  const result = evaluateFractalMABottomReversal({ series1h: candles, now });
  assert.notEqual(result.state, 'CONFIRMED');
  assert.equal(result.hardGatesPassed, false);
});
