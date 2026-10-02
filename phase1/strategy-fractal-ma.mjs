import { lastClosedIndex, validateSeries } from './radarx-phase1-engine.mjs';

const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number(x)));
const finite = x => Number.isFinite(Number(x));
const unique = a => [...new Set(a)];

function reject(strategy, reasonCodes, evidence = {}) {
  return {
    strategy,
    direction: 'NONE',
    state: 'REJECTED',
    score: {},
    evidence,
    reasonCodes: unique(reasonCodes),
    hardGatesPassed: false,
    dataQuality: 0,
    confidence_score: 'UNKNOWN',
    paper_trading: true,
    real_order_execution: false
  };
}

function prepare(series, timeframe, minBars, now) {
  if (!Array.isArray(series)) return reject(null, ['INSUFFICIENT_DATA']);
  const idx = lastClosedIndex(series);
  if (idx < 0) return reject(null, ['INSUFFICIENT_CLOSED_DATA']);
  const candles = series.slice(0, idx + 1);
  if (candles.some(c => c?.closed !== true)) return reject(null, ['INCOMPLETE_CANDLE']);
  if (candles.some(c => Number(c?.openTime) > now || Number(c?.closeTime) > now)) return reject(null, ['FUTURE_DATA']);
  if (candles.length < minBars) return reject(null, ['INSUFFICIENT_DATA']);
  const valid = validateSeries(candles, timeframe);
  if (!valid.valid) return reject(null, ['INVALID_DATA', ...valid.issues.slice(0, 4)]);
  const last = candles.at(-1);
  const ageMs = Math.max(0, now - Number(last.closeTime));
  const timeframeMs = timeframe === '1h' ? 3600000 : 900000;
  if (ageMs > timeframeMs * 2) return reject(null, ['STALE_DATA'], { age_ms: ageMs });
  return { candles, ageMs };
}

function emaSeries(values, period) {
  const n = values.length;
  const out = Array(n).fill(null);
  if (n === 0) return out;
  const p = Math.max(2, Math.trunc(period));
  if (n < p) return out;
  let seed = 0;
  for (let i = 0; i < p; i++) seed += values[i];
  seed /= p;
  out[p - 1] = seed;
  const alpha = 2 / (p + 1);
  for (let i = p; i < n; i++) out[i] = alpha * values[i] + (1 - alpha) * out[i - 1];
  return out;
}

function fractals(candles, span = 2) {
  const highs = [], lows = [];
  for (let i = span; i < candles.length - span; i++) {
    const h = Number(candles[i]?.high);
    const l = Number(candles[i]?.low);
    if (!finite(h) || !finite(l)) continue;
    let highOk = true, lowOk = true;
    for (let d = 1; d <= span; d++) {
      highOk = highOk && h >= Number(candles[i - d]?.high) && h >= Number(candles[i + d]?.high);
      lowOk = lowOk && l <= Number(candles[i - d]?.low) && l <= Number(candles[i + d]?.low);
    }
    if (highOk) highs.push({ index: i, price: h, close: Number(candles[i]?.close), time: Number(candles[i]?.closeTime) });
    if (lowOk) lows.push({ index: i, price: l, close: Number(candles[i]?.close), time: Number(candles[i]?.closeTime) });
  }
  return { highs, lows };
}

function volumeStats(candles, lookback = 20) {
  const n = candles.length;
  const recent = Number(candles[n - 1]?.volume);
  const base = candles.slice(Math.max(0, n - lookback - 1), n - 1).map(c => Number(c?.volume)).filter(finite);
  const avg = base.length ? base.reduce((a, b) => a + b, 0) / base.length : null;
  const rvol = finite(recent) && Number.isFinite(avg) && avg > 0 ? recent / avg : null;
  return { recent, average: avg, rvol };
}

function bullishCandle(candle) {
  const o = Number(candle?.open), c = Number(candle?.close), h = Number(candle?.high), l = Number(candle?.low);
  if (![o, c, h, l].every(finite) || h <= l) return false;
  const range = h - l;
  return c > o && (c - l) / range >= 0.55;
}

function finalize(strategy, state, score, evidence, reasonCodes) {
  return {
    strategy,
    direction: 'LONG',
    state,
    score: { value: clamp(score) },
    evidence,
    reasonCodes: unique(reasonCodes),
    hardGatesPassed: true,
    dataQuality: 100,
    confidence_score: 'UNKNOWN',
    paper_trading: true,
    real_order_execution: false
  };
}

function bottomMetrics(candles, config = {}) {
  const closes = candles.map(c => Number(c.close));
  const e20 = emaSeries(closes, 20);
  const e50 = emaSeries(closes, 50);
  const i = candles.length - 1;
  const f = fractals(candles, Number(config.fractalSpan ?? 2));
  const lows = f.lows.slice(-4);
  const highs = f.highs.slice(-4);
  const last = candles[i];
  const previous = candles[i - 1];
  const price = Number(last.close);
  const ema20 = e20[i], ema20Prev = e20[i - 1];
  const ema50 = e50[i], ema50Prev = e50[i - 1];
  const rvol = volumeStats(candles, 20);
  const prevClose = Number(previous?.close);
  const reclaim = finite(ema20) && finite(prevClose) && finite(price) && prevClose <= ema20Prev && price > ema20;
  const nearReclaim = finite(ema20) && finite(price) && price >= ema20 * 0.99 && price <= ema20 * 1.015;
  const crossed50 = finite(ema20) && finite(ema50) && finite(prevClose) && finite(ema20Prev) && finite(ema50Prev)
    && ema20Prev <= ema50Prev && ema20 > ema50;
  const above50 = finite(ema50) && price > ema50;
  const maSlope = finite(ema20) && finite(ema20Prev) && ema20Prev > 0 ? (ema20 - ema20Prev) / ema20Prev * 100 : null;
  const lastLow = lows.at(-1) || null;
  const priorLow = lows.at(-2) || null;
  const lastHigh = highs.at(-1) || null;
  const priorHigh = highs.at(-2) || null;
  const higherLow = Boolean(lastLow && priorLow && lastLow.price >= priorLow.price * (1 + Number(config.minHigherLowPct ?? 0.1) / 100));
  const higherHigh = Boolean(lastHigh && priorHigh && lastHigh.price >= priorHigh.price * (1 + Number(config.minHigherHighPct ?? 0.1) / 100));
  const brokeFractalHigh = Boolean(lastHigh && price > lastHigh.price);
  const nearFractalHigh = Boolean(lastHigh && price >= lastHigh.price * 0.985);
  const bullish = bullishCandle(last);
  const rangeLow = candles.slice(-24).reduce((m, c) => Math.min(m, Number(c.low)), Infinity);
  const rangeHigh = candles.slice(-24).reduce((m, c) => Math.max(m, Number(c.high)), -Infinity);
  const rangePosition = finite(price) && rangeHigh > rangeLow ? (price - rangeLow) / (rangeHigh - rangeLow) * 100 : null;
  return {
    price, e20: ema20, e50: ema50, e20Prev: ema20Prev, e50Prev: ema50Prev,
    maSlopePct: maSlope, reclaim, nearReclaim, crossed50, above50,
    higherLow, higherHigh, brokeFractalHigh, nearFractalHigh, bullish,
    lastLow, priorLow, lastHigh, priorHigh,
    rvolRatio: rvol.rvol, rangePositionPct: rangePosition
  };
}

export function evaluateFractalMABottomReversal({
  series1h,
  config = { fractalSpan: 2, minHigherLowPct: 0.1 },
  now = Date.now()
} = {}) {
  const p = prepare(series1h, '1h', 80, now);
  if (p.strategy === null) return { ...p, strategy: 'FRACTAL_MA_BOTTOM_REVERSAL' };
  const m = bottomMetrics(p.candles, config);
  const ready = m.higherLow && (m.reclaim || m.nearReclaim) && m.maSlopePct != null && m.maSlopePct > 0;
  if (!ready) return reject('FRACTAL_MA_BOTTOM_REVERSAL', ['FRACTAL_MA_BOTTOM_NOT_CONFIRMED'], m);
  const score = 52 +
    (m.higherLow ? 14 : 0) +
    (m.reclaim ? 12 : 5) +
    (m.maSlopePct > 0.05 ? 7 : 3) +
    (m.above50 ? 6 : 0) +
    (m.bullish ? 4 : 0) +
    (finite(m.rvolRatio) && m.rvolRatio >= 1.1 ? 5 : 0);
  const state = score >= 78 && m.reclaim ? 'CONFIRMED' : 'CANDIDATE';
  return finalize(
    'FRACTAL_MA_BOTTOM_REVERSAL',
    state,
    score,
    {
      timeframe: '1h', fractal_span: Number(config.fractalSpan ?? 2),
      latest_fractal_low: m.lastLow?.price ?? null, prior_fractal_low: m.priorLow?.price ?? null,
      higher_low: m.higherLow, ema20: m.e20, ema50: m.e50,
      ema20_slope_pct: m.maSlopePct, ema20_reclaim: m.reclaim, ema20_near_reclaim: m.nearReclaim,
      above_ema50: m.above50, rvol_ratio: m.rvolRatio, age_ms: p.ageMs
    },
    ['HIGHER_LOW','EMA20_RECLAIM_OR_NEAR_RECLAIM', ...(m.above50 ? ['PRICE_ABOVE_EMA50'] : []), ...(finite(m.rvolRatio) && m.rvolRatio >= 1.1 ? ['RVOL_SUPPORT'] : [])]
  );
}

export function evaluateFractalMABreakout({
  series15m,
  config = { fractalSpan: 2, minHigherLowPct: 0.1, breakoutBufferPct: 0.15 },
  now = Date.now()
} = {}) {
  const p = prepare(series15m, '15m', 90, now);
  if (p.strategy === null) return { ...p, strategy: 'FRACTAL_MA_BREAKOUT' };
  const m = bottomMetrics(p.candles, config);
  const breakout = m.brokeFractalHigh;
  const near = m.nearFractalHigh;
  const maAligned = finite(m.e20) && finite(m.e50) && m.e20 >= m.e50 && m.price >= m.e20 * 0.995;
  if (!(breakout || (near && maAligned))) {
    return reject('FRACTAL_MA_BREAKOUT', ['FRACTAL_BREAKOUT_NOT_CONFIRMED'], m);
  }
  const breakoutPct = m.lastHigh?.price > 0 ? (m.price - m.lastHigh.price) / m.lastHigh.price * 100 : null;
  const score = 55 +
    (breakout ? 18 : 8) +
    (maAligned ? 10 : 0) +
    (m.higherLow ? 7 : 0) +
    (m.bullish ? 4 : 0) +
    (finite(m.rvolRatio) && m.rvolRatio >= 1.35 ? 8 : finite(m.rvolRatio) && m.rvolRatio >= 1.1 ? 4 : 0);
  const state = breakout && score >= 78 ? 'CONFIRMED' : 'CANDIDATE';
  return finalize(
    'FRACTAL_MA_BREAKOUT',
    state,
    score,
    {
      timeframe: '15m', fractal_span: Number(config.fractalSpan ?? 2),
      latest_fractal_high: m.lastHigh?.price ?? null, prior_fractal_high: m.priorHigh?.price ?? null,
      breakout_above_fractal: breakout, breakout_pct: breakoutPct, near_breakout: near,
      ema20: m.e20, ema50: m.e50, ma_alignment: maAligned,
      higher_low: m.higherLow, rvol_ratio: m.rvolRatio, age_ms: p.ageMs
    },
    ['FRACTAL_HIGH_BREAKOUT_OR_NEAR_BREAKOUT', ...(maAligned ? ['EMA20_ABOVE_OR_NEAR_EMA50'] : []), ...(m.higherLow ? ['HIGHER_LOW_STRUCTURE'] : []), ...(finite(m.rvolRatio) && m.rvolRatio >= 1.35 ? ['RVOL_BREAKOUT'] : [])]
  );
}

export function evaluateFractalMATrendShift({
  series1h,
  series15m,
  config = { fractalSpan: 2, minHigherLowPct: 0.1 },
  now = Date.now()
} = {}) {
  const p1 = prepare(series1h, '1h', 80, now);
  if (p1.strategy === null) return { ...p1, strategy: 'FRACTAL_MA_TREND_SHIFT' };
  const p15 = prepare(series15m, '15m', 90, now);
  if (p15.strategy === null) return { ...p15, strategy: 'FRACTAL_MA_TREND_SHIFT' };

  const h = bottomMetrics(p1.candles, config);
  const l = bottomMetrics(p15.candles, config);
  const multiTfStructure = h.higherLow && (h.higherHigh || l.higherHigh);
  const maShift = h.crossed50 || (finite(h.e20) && finite(h.e50) && h.e20 > h.e50 && h.maSlopePct > 0);
  const priceConfirm = h.above50 && l.price >= l.e20 * 0.995;
  const momentumConfirm = l.bullish || (finite(l.rvolRatio) && l.rvolRatio >= 1.1);
  if (!(multiTfStructure && maShift && priceConfirm)) {
    return reject('FRACTAL_MA_TREND_SHIFT', ['FRACTAL_MA_TREND_SHIFT_NOT_CONFIRMED'], {
      one_hour: h, fifteen_min: l
    });
  }
  const score = 58 +
    (multiTfStructure ? 14 : 0) +
    (h.crossed50 ? 10 : 6) +
    (priceConfirm ? 8 : 0) +
    (momentumConfirm ? 6 : 0) +
    (l.higherLow ? 4 : 0);
  const state = score >= 80 && (h.crossed50 || h.maSlopePct > 0.08) ? 'CONFIRMED' : 'CANDIDATE';
  return finalize(
    'FRACTAL_MA_TREND_SHIFT',
    state,
    score,
    {
      required_timeframes: ['1h','15m'],
      one_hour: {
        fractal_low: h.lastLow?.price ?? null, prior_fractal_low: h.priorLow?.price ?? null,
        higher_low: h.higherLow, fractal_high: h.lastHigh?.price ?? null, higher_high: h.higherHigh,
        ema20: h.e20, ema50: h.e50, ema20_crossed_ema50: h.crossed50, ema20_slope_pct: h.maSlopePct,
        price_above_ema50: h.above50
      },
      fifteen_min: {
        fractal_low: l.lastLow?.price ?? null, higher_low: l.higherLow,
        fractal_high: l.lastHigh?.price ?? null, higher_high: l.higherHigh,
        ema20: l.e20, ema50: l.e50, rvol_ratio: l.rvolRatio, bullish_candle: l.bullish
      }
    },
    ['MULTI_TIMEFRAME_FRACTAL_STRUCTURE','EMA20_EMA50_TREND_SHIFT','PRICE_ABOVE_EMA50', ...(momentumConfirm ? ['15M_MOMENTUM_CONFIRMATION'] : [])]
  );
}
