import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CoinHunterRadar,
  COIN_HUNTER_DEFAULTS,
  featureSet,
  findPreMoveCheckpoint
} from '../core/coin-hunter-radar.mjs';

const HOUR = 60 * 60 * 1000;

function hourlyCandles(count, now = Date.now()) {
  const start = now - count * HOUR - 1000;
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i * 0.2;
    const burst = i >= count - 4;
    const volume = burst ? 200 : 100;
    return {
      openTime: start + i * HOUR,
      closeTime: start + (i + 1) * HOUR - 1,
      open: i === 0 ? close - 0.1 : 100 + (i - 1) * 0.2,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume,
      quoteVolume: volume * close,
      tradeCount: burst ? 160 : 80,
      takerBuyBaseVolume: burst ? 120 : 52,
      closed: true
    };
  });
}

const noLog = { warn() {}, debug() {} };

function marketSymbol(symbol, baseAsset, quoteAsset = 'USDT', extra = {}) {
  return {
    symbol, baseAsset, quoteAsset, status: 'TRADING',
    isSpotTradingAllowed: true, permissions: ['SPOT'],
    ...extra
  };
}

test('Coin Hunter excludes non-directional USDT instruments before ranking or deep scanning', async () => {
  const symbols = [
    marketSymbol('SOLUSDT', 'SOL'),
    marketSymbol('USDCUSDT', 'USDC'),
    marketSymbol('BTCUSDT', 'BTC'),
    marketSymbol('WBTCUSDT', 'WBTC'),
    marketSymbol('TSLABUSDT', 'TSLAB'),
    marketSymbol('MARGINUSDT', 'MARGIN', 'USDT', { permissions: ['MARGIN'] }),
    marketSymbol('HALTEDUSDT', 'HALTED', 'USDT', { status: 'BREAK' }),
    marketSymbol('OTHERBTC', 'OTHER', 'BTC')
  ];
  const tickerData = symbols.map((s, i) => ({
    symbol: s.symbol,
    lastPrice: String(1 + i),
    priceChangePercent: '0.4',
    quoteVolume: '2500000',
    count: '4000',
    highPrice: String(1.1 + i),
    lowPrice: String(0.9 + i)
  }));
  const rest = {
    async request(path) {
      if (path === '/api/v3/exchangeInfo') return { data: { symbols }, source: 'TEST_FIXTURE' };
      if (path === '/api/v3/ticker/24hr') return { data: tickerData, source: 'TEST_FIXTURE' };
      throw new Error('UNEXPECTED_REQUEST: ' + path);
    }
  };
  const radar = new CoinHunterRadar({ rest, logger: noLog });
  const rows = await radar.refreshUniverse('USDT');
  assert.deepEqual(rows.map(x => x.symbol), ['SOLUSDT']);
  assert.equal(radar.isSpotSymbol(marketSymbol('USDCUSDT', 'USDC'), 'USDT'), false);
  assert.equal(radar.isSpotSymbol(marketSymbol('SOLUSDT', 'SOL'), 'USDT'), true);
});

test('Coin Hunter feature engine measures volume, trade and taker-buy acceleration from closed candles', () => {
  const candles = hourlyCandles(32);
  const features = featureSet(candles, { lastPrice: candles.at(-1).close }, 1.2);
  assert.ok(features);
  assert.equal(features.volumeAcceleration, 2);
  assert.equal(features.tradeAcceleration, 2);
  assert.equal(features.takerRatio, 0.6);
  assert.equal(features.btcChange, 1.2);
  assert.ok(Number.isFinite(features.ema20));
  assert.ok(Number.isFinite(features.ema50));
});

test('Coin Hunter refuses to score an insufficient or not-yet-closed hourly window', () => {
  const short = hourlyCandles(15);
  assert.equal(featureSet(short, { lastPrice: short.at(-1).close }), null);
  const withFutureTail = hourlyCandles(16);
  withFutureTail[15] = {
    ...withFutureTail[15],
    openTime: Date.now() + 60_000,
    closeTime: Date.now() + 60_000
  };
  assert.equal(featureSet(withFutureTail, { lastPrice: withFutureTail.at(-1).close }), null);
});

test('Coin Hunter records the first confirmed pre-move checkpoint, not a later candle', () => {
  const dayStart = Date.now() - 3 * HOUR;
  const rows = [
    { openTime: dayStart, closeTime: dayStart + HOUR - 1, open: 100, high: 100.7, low: 99.7, close: 100.4 },
    { openTime: dayStart + HOUR, closeTime: dayStart + 2 * HOUR - 1, open: 100.4, high: 101.8, low: 100.2, close: 101.5 },
    { openTime: dayStart + 2 * HOUR, closeTime: dayStart + 3 * HOUR - 1, open: 101.5, high: 102.4, low: 101.1, close: 102.1 }
  ];
  const checkpoint = findPreMoveCheckpoint(rows, dayStart, 2);
  assert.deepEqual(checkpoint, {
    index: 2, returnPct: 2.0999999999999943, price: 102.1,
    time: dayStart + 3 * HOUR - 1
  });
  assert.equal(findPreMoveCheckpoint(rows.slice(0, 2), dayStart, 2), null);
});

test('Coin Hunter health keeps Spot paper-only and reports unknown confidence honestly', () => {
  const radar = new CoinHunterRadar({ rest: {}, logger: noLog });
  const health = radar.health();
  assert.equal(COIN_HUNTER_DEFAULTS.quote, 'USDT');
  assert.equal(health.closed_candles_only, true);
  assert.equal(health.paper_trading, true);
  assert.equal(health.real_order_execution, false);
  assert.equal(health.confidence_score, 'UNKNOWN');
  assert.equal(health.source, 'Binance Public REST');
});
