import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateSupportResistanceConfirmation
} from '../strategy-support-resistance.mjs';
import { listActiveStrategies } from '../strategy-registry.mjs';

const NOW = Date.now();
const FIFTEEN_MIN = 900000;

function makeCandles(closes, volumeIndex = null) {
  return closes.map((close, i) => {
    const previous = i === 0 ? close : closes[i - 1];
    const open = i === closes.length - 1 && volumeIndex === i ? previous : previous;
    const high = Math.max(open, close) + 0.6;
    const low = Math.min(open, close) - 0.6;
    const openTime = NOW - (closes.length - i) * FIFTEEN_MIN;
    return {
      openTime,
      closeTime: openTime + FIFTEEN_MIN - 1,
      open,
      high,
      low,
      close,
      volume: volumeIndex === i ? 4000 : 1000,
      quoteVolume: close * (volumeIndex === i ? 4000 : 1000),
      tradeCount: 500,
      takerBuyBaseVolume: (volumeIndex === i ? 4000 : 1000) * 0.6,
      takerBuyQuoteVolume: close * (volumeIndex === i ? 4000 : 1000) * 0.6,
      closed: true,
      source: 'TEST_FIXTURE',
      sourceTime: NOW
    };
  });
}

function breakoutCloses() {
  const out = [];
  for (let i = 0; i < 120; i++) out.push(100 + i * 0.12);
  out[104] = 116.5;
  out[105] = 117.8;
  out[106] = 119.5;
  out[107] = 117.2;
  out[108] = 118.0;
  out[109] = 118.4;
  out[110] = 118.7;
  out[111] = 118.9;
  out[112] = 119.1;
  out[113] = 118.8;
  out[114] = 119.0;
  out[115] = 119.2;
  out[116] = 119.0;
  out[117] = 119.1;
  out[118] = 119.0;
  out[119] = 120.2;
  return out;
}

test('registry exposes support/resistance confirmation strategy', () => {
  const ids = new Set(listActiveStrategies().map(x => x.id));
  assert.ok(ids.has('SUPPORT_RESISTANCE_CONFIRMATION'));
  assert.equal(listActiveStrategies().length, 15);
});

test('resistance breakout is confirmed from a closed candle with RVOL and EMA alignment', () => {
  const candles = makeCandles(breakoutCloses(), 119);
  const result = evaluateSupportResistanceConfirmation({
    series15m: candles,
    now: NOW,
    config: {
      fractalSpan: 2,
      supportProximityPct: 1.0,
      resistanceProximityPct: 1.5,
      breakoutBufferPct: 0.15,
      minRvolBounce: 1.05,
      minRvolBreakout: 1.2
    }
  });
  assert.equal(result.direction, 'LONG');
  assert.ok(['CANDIDATE', 'CONFIRMED'].includes(result.state));
  assert.equal(result.evidence.resistance_breakout, true);
  assert.equal(result.evidence.ma_aligned, true);
  assert.ok(result.evidence.rvol_ratio >= 1.2);
  assert.ok(result.levels.tp1 > result.entry);
  assert.ok(result.levels.tp2 > result.levels.tp1);
});

test('incomplete trigger candle is rejected and never becomes a signal', () => {
  const candles = makeCandles(breakoutCloses(), 119);
  candles.at(-1).closed = false;
  const result = evaluateSupportResistanceConfirmation({series15m: candles, now: NOW});
  assert.equal(result.hardGatesPassed, false);
  assert.notEqual(result.state, 'CONFIRMED');
});

test('future trigger candle is rejected', () => {
  const candles = makeCandles(breakoutCloses(), 119);
  candles.at(-1).closeTime = NOW + 60000;
  candles.at(-1).openTime = NOW;
  const result = evaluateSupportResistanceConfirmation({series15m: candles, now: NOW});
  assert.equal(result.hardGatesPassed, false);
  assert.ok(result.reasonCodes.includes('FUTURE_DATA'));
});
