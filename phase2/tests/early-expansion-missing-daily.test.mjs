import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEarlyExpansionEvidence} from '../core/early-expansion-radar.mjs';

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
});
