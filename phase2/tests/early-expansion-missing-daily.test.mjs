import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEarlyExpansionEvidence,buildMicroFingerprint} from '../core/early-expansion-radar.mjs';

test('missing 24h movement is unknown, never scored as a quiet zero-percent base', () => {
  const result = buildEarlyExpansionEvidence({
    series: {'1m': [], '5m': [], '15m': [], '1h': [], '4h': []},
    ticker: {
      symbol: 'TESTUSDT',
      lastPrice: 1,
      priceChange24h: null,
      quoteVolume24h: 2_000_000,
      tradeCount24h: 2_000
    },
    now: 1_800_000_000_000
  });

  assert.equal(result.early_expansion_score, null);
  assert.ok(result.reason_codes.includes('TICKER_24H_CHANGE_UNKNOWN'));
  assert.equal(result.pre_expansion_stage, 'DATA_INSUFFICIENT');
  assert.equal(result.gates.anti_chase.allowed, false);
  assert.equal(result.gates.anti_chase.hard_extended_24h, null);

  const makeCandles = (symbol, intervalMs, count) => {
    const latestOpen = Math.floor((1_800_000_000_000 - intervalMs) / intervalMs) * intervalMs;
    return Array.from({length: count}, (_, i) => {
      const openTime = latestOpen - (count - 1 - i) * intervalMs;
      return {
        symbol, openTime, closeTime: openTime + intervalMs - 1,
        open: 100, high: 101, low: 99, close: 100.5, volume: 100,
        quoteVolume: 10_000, tradeCount: 100, takerBuyBaseVolume: 60,
        takerBuyQuoteVolume: 6_000, closed: true, source: 'BINANCE_PUBLIC_REST',
        receivedAt: 1_800_000_000_000 - 1_000
      };
    });
  };
  const micro = buildMicroFingerprint({
    oneMinute: makeCandles('TESTUSDT', 60_000, 80),
    fiveMinute: makeCandles('TESTUSDT', 5 * 60_000, 40),
    btcFiveMinute: makeCandles('BTCUSDT', 5 * 60_000, 20),
    ticker: {symbol: 'TESTUSDT', lastPrice: 100, priceChange24h: null},
    now: 1_800_000_000_000
  });
  assert.equal(micro.eligible, false);
  assert.equal(micro.stage, 'DATA_INSUFFICIENT');
  assert.ok(micro.reason_codes.includes('TICKER_24H_CHANGE_UNKNOWN'));
});
