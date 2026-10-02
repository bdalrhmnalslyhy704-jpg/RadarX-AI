import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {MarketUniverseScanner} from '../market/universe-scanner.mjs';
import {listActiveStrategies} from '../../phase1/strategy-registry.mjs';

const NOW = Date.now();
const ACTIVE = listActiveStrategies();

function makeSeries(tf, count = 250, ageMs = 120000) {
  const step = tf === '4h' ? 14400000 : tf === '1h' ? 3600000 : 900000;
  const lastOpen = NOW - ageMs - step + 1;
  return Array.from({length: count}, (_, i) => {
    const openTime = lastOpen - (count - 1 - i) * step;
    const close = 100 + i * 0.5;
    return {
      openTime,
      closeTime: openTime + step - 1,
      open: close - 0.4,
      high: close + 0.6,
      low: close - 0.6,
      close,
      volume: 1000,
      quoteVolume: close * 1000,
      tradeCount: 2000,
      closed: true,
      source: 'TEST_FIXTURE',
      sourceTime: NOW
    };
  });
}

function makeRest(options = {}) {
  const symbols = options.symbols || ['BTCUSDT'];
  const calls = [];
  let active = 0;
  let maxActive = 0;

  return {
    calls,
    get maxActive() {
      return maxActive;
    },
    async request(path) {
      calls.push({type: 'request', path});
      if (path === '/api/v3/exchangeInfo') {
        return {
          source: 'TEST',
          data: {
            symbols: symbols.map(symbol => ({
              symbol,
              baseAsset: symbol.replace(/USDT$/, ''),
              quoteAsset: 'USDT',
              status: 'TRADING',
              isSpotTradingAllowed: true,
              permissions: ['SPOT']
            }))
          }
        };
      }
      if (path === '/api/v3/ticker/24hr') {
        return {
          source: 'TEST',
          data: symbols.map((symbol, i) => ({
            symbol,
            lastPrice: String(225 + i),
            quoteVolume: '100000000',
            count: '500000',
            priceChangePercent: '3'
          }))
        };
      }
      throw new Error('UNEXPECTED_PATH');
    },
    async klines(symbol, tf) {
      calls.push({type: 'klines', symbol, tf});
      if (options.missingTf === tf) {
        return {source: 'TEST', receivedAt: NOW, candles: []};
      }
      if (options.trackConcurrency) {
        active += 1;
        maxActive = Math.max(maxActive, active);
      }
      try {
        return {
          source: 'TEST',
          receivedAt: NOW,
          candles: makeSeries(tf, 250, options.stale ? 4 * 60 * 60 * 1000 : 120000)
        };
      } finally {
        if (options.trackConcurrency) active -= 1;
      }
    },
    async depth(symbol) {
      calls.push({type: 'depth', symbol});
      return {
        source: 'TEST',
        data: {
          bids: [['224.99', options.wideSpread ? '10' : '50000']],
          asks: [[options.wideSpread ? '226.5' : '225.01', options.wideSpread ? '10' : '50000']]
        }
      };
    }
  };
}

const scanConfig = {
  minQuoteVolume24h: 750000,
  scanLimit: 1,
  returnLimit: 1,
  deepConcurrency: 2,
  maxTriggerAgeMs: 30 * 60 * 1000
};

test('Integration 1: Registry exposes exactly 11 ACTIVE strategies', () => {
  assert.equal(ACTIVE.length, 11);
  assert.ok(ACTIVE.every(s => s.status === 'ACTIVE' && typeof s.evaluator === 'function'));
});

test('Integration 2: Market Radar evaluates all 11 Registry strategies', async () => {
  const result = await new MarketUniverseScanner({
    rest: makeRest(),
    config: scanConfig
  }).scan({quote: 'USDT', limit: 1});
  const candidate = result.candidates[0];
  assert.equal(candidate.strategies.length, 11);
  assert.deepEqual(candidate.strategies.map(s => s.id), ACTIVE.map(s => s.id));
  console.log('INTEGRATION_CANDIDATE', JSON.stringify({
    symbol: candidate.symbol,
    strategies: candidate.strategies.map(s => ({
      id: s.id,
      signal_state: s.signal_state,
      score: s.score,
      reason_codes: s.reason_codes
    }))
  }));
});

test('Integration 3: Candidate Contract strategy count is 11', async () => {
  const result = await new MarketUniverseScanner({rest: makeRest(), config: scanConfig}).scan({quote: 'USDT', limit: 1});
  const candidate = result.candidates[0];
  assert.equal(candidate.coverage.strategy_count, 11);
  assert.equal(candidate.coverage.evaluated_strategy_count, 11);
  assert.equal(candidate.strategies.length, 11);
});

test('Integration 4: Rejected strategies preserve reason_codes, evidence, invalidation and hard-gate status', async () => {
  const result = await new MarketUniverseScanner({rest: makeRest(), config: scanConfig}).scan({quote: 'USDT', limit: 1});
  const rejected = result.candidates[0].strategies.filter(s => s.signal_state === 'REJECTED');
  assert.ok(rejected.length > 0);
  for (const strategy of rejected) {
    assert.ok(strategy.reason_codes.length > 0);
    assert.ok(strategy.evidence && typeof strategy.evidence === 'object');
    assert.ok(strategy.invalidation.length > 0);
    assert.equal(typeof strategy.hard_gates_passed, 'boolean');
    assert.ok(Number.isFinite(strategy.score.coverage));
  }
});

test('Integration 5: Missing required data yields INSUFFICIENT_DATA without dropping any strategy', async () => {
  const result = await new MarketUniverseScanner({
    rest: makeRest({missingTf: '15m'}),
    config: scanConfig
  }).scan({quote: 'USDT', limit: 1});
  const candidate = result.candidates[0];
  assert.equal(candidate.strategies.length, 11);
  const insufficient = candidate.strategies.filter(s => s.signal_state === 'INSUFFICIENT_DATA');
  assert.ok(insufficient.length > 0);
  for (const strategy of insufficient) {
    assert.ok(strategy.required_data.length > 0);
    assert.ok(strategy.missing_required_data.length > 0);
    assert.ok(strategy.reason_codes.includes('INSUFFICIENT_DATA'));
  }
});

test('Integration 6: Failed hard gates suppress strategy score and overall score', async () => {
  const result = await new MarketUniverseScanner({
    rest: makeRest({wideSpread: true}),
    config: scanConfig
  }).scan({quote: 'USDT', limit: 1});
  const candidate = result.candidates[0];
  const failed = candidate.strategies.filter(s => s.hard_gates_passed === false);
  assert.ok(failed.length > 0);
  for (const strategy of failed) assert.equal(strategy.score.value, null);
  assert.equal(candidate.overall_score, null);
});

test('Integration 7: Stale data never becomes LIVE', async () => {
  const result = await new MarketUniverseScanner({
    rest: makeRest({stale: true}),
    config: scanConfig
  }).scan({quote: 'USDT', limit: 1});
  const candidate = result.candidates[0];
  assert.equal(candidate.data_status.data_stale, true);
  assert.equal(candidate.data_status.data_valid, false);
  assert.equal(result.meta.live, false);
  assert.equal(candidate.overall_score, null);
});

test('Integration 8: Market Radar makes no duplicate market-data requests per symbol', async () => {
  const rest = makeRest();
  await new MarketUniverseScanner({rest, config: scanConfig}).scan({quote: 'USDT', limit: 1});
  assert.equal(rest.calls.filter(x => x.type === 'request' && x.path === '/api/v3/exchangeInfo').length, 1);
  assert.equal(rest.calls.filter(x => x.type === 'request' && x.path === '/api/v3/ticker/24hr').length, 1);
  assert.equal(rest.calls.filter(x => x.type === 'depth').length, 1);
  for (const tf of ['4h', '1h', '15m']) {
    assert.equal(rest.calls.filter(x => x.type === 'klines' && x.tf === tf).length, 1);
  }
});

test('Integration 9: bounded concurrency is preserved across deep symbol scans', async () => {
  const rest = makeRest({symbols: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'], trackConcurrency: true});
  const result = await new MarketUniverseScanner({
    rest,
    config: {...scanConfig, scanLimit: 3, returnLimit: 3, deepConcurrency: 2}
  }).scan({quote: 'USDT', limit: 3});
  assert.equal(result.universe.scanned, 3);
  assert.ok(rest.maxActive <= 2);
});

test('Integration 10: paper_trading remains true', async () => {
  const result = await new MarketUniverseScanner({rest: makeRest(), config: scanConfig}).scan({quote: 'USDT', limit: 1});
  assert.equal(result.meta.paper_trading, true);
  assert.equal(result.candidates[0].paper_trading, true);
  assert.ok(result.candidates[0].strategies.every(s => s.paper_trading === true));
});

test('Integration 11: real_order_execution remains false', async () => {
  const result = await new MarketUniverseScanner({rest: makeRest(), config: scanConfig}).scan({quote: 'USDT', limit: 1});
  assert.equal(result.meta.real_order_execution, false);
  assert.equal(result.candidates[0].real_order_execution, false);
  assert.ok(result.candidates[0].strategies.every(s => s.real_order_execution === false));
});

test('Integration 12: confidence_score remains UNKNOWN', async () => {
  const result = await new MarketUniverseScanner({rest: makeRest(), config: scanConfig}).scan({quote: 'USDT', limit: 1});
  assert.equal(result.meta.confidence_score, 'UNKNOWN');
  assert.ok(result.candidates[0].strategies.every(s => s.confidence_score === 'UNKNOWN'));
});

test('Integration 13: node --check passes for the modified/integration modules', () => {
  for (const file of [
    'phase2/market/universe-scanner.mjs',
    'phase2/tests/strategy-market-radar-integration.test.mjs'
  ]) {
    execFileSync(process.execPath, ['--check', file], {stdio: 'pipe'});
  }
});
