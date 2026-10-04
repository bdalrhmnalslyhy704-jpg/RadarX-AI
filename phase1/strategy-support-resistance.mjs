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
  if (candles.some(c => Number(c?.openTime) > now || Number(c?.closeTime) > now)) {
    return reject(null, ['FUTURE_DATA']);
  }
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
  const p = Math.max(2, Math.trunc(period));
  const out = Array(values.length).fill(null);
  if (values.length < p) return out;
  let seed = 0;
  for (let i = 0; i < p; i++) seed += Number(values[i]);
  seed /= p;
  out[p - 1] = seed;
  const alpha = 2 / (p + 1);
  for (let i = p; i < values.length; i++) out[i] = alpha * Number(values[i]) + (1 - alpha) * out[i - 1];
  return out;
}

function atrSeries(candles, period = 14) {
  if (candles.length < period + 1) return [];
  const tr = candles.map((c, i) => {
    const high = Number(c?.high), low = Number(c?.low);
    const prevClose = i > 0 ? Number(candles[i - 1]?.close) : Number(c?.open);
    if (![high, low, prevClose].every(finite) || high < low) return null;
    return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  });
  const out = Array(candles.length).fill(null);
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += Number(tr[i]);
  out[period] = seed / period;
  for (let i = period + 1; i < candles.length; i++) {
    out[i] = ((out[i - 1] * (period - 1)) + Number(tr[i])) / period;
  }
  return out;
}

function pivotLevels(candles, span = 2) {
  const supports = [];
  const resistances = [];
  for (let i = span; i < candles.length - span; i++) {
    const low = Number(candles[i]?.low);
    const high = Number(candles[i]?.high);
    if (!finite(low) || !finite(high)) continue;
    let lowOk = true, highOk = true;
    for (let d = 1; d <= span; d++) {
      if (!(low <= Number(candles[i - d]?.low) && low <= Number(candles[i + d]?.low))) lowOk = false;
      if (!(high >= Number(candles[i - d]?.high) && high >= Number(candles[i + d]?.high))) highOk = false;
    }
    if (lowOk) supports.push({ index: i, price: low, time: Number(candles[i]?.closeTime) });
    if (highOk) resistances.push({ index: i, price: high, time: Number(candles[i]?.closeTime) });
  }
  return { supports, resistances };
}

function volumeStats(candles, lookback = 20) {
  const n = candles.length;
  const recent = Number(candles[n - 1]?.volume);
  const base = candles.slice(Math.max(0, n - lookback - 1), n - 1)
    .map(c => Number(c?.volume))
    .filter(finite);
  const avg = base.length ? base.reduce((a, b) => a + b, 0) / base.length : null;
  return {
    recent,
    average: avg,
    rvol: finite(recent) && finite(avg) && avg > 0 ? recent / avg : null
  };
}

function candleShape(candle) {
  const o = Number(candle?.open), h = Number(candle?.high), l = Number(candle?.low), c = Number(candle?.close);
  if (![o, h, l, c].every(finite) || h <= l) return null;
  const range = h - l;
  return {
    bullish: c > o,
    bodyPct: Math.abs(c - o) / range * 100,
    lowerWickPct: (Math.min(o, c) - l) / range * 100,
    upperWickPct: (h - Math.max(o, c)) / range * 100,
    closePositionPct: (c - l) / range * 100
  };
}

function nearestSupport(levels, price, maxAbovePct = 0.5) {
  return [...levels]
    .filter(x => finite(x.price) && x.price <= price * (1 + maxAbovePct / 100))
    .sort((a, b) => b.price - a.price)[0] ?? null;
}

function nearestResistance(levels, price, maxBelowPct = 1.5) {
  return [...levels]
    .filter(x => finite(x.price) && x.price >= price * (1 - maxBelowPct / 100))
    .sort((a, b) => a.price - b.price)[0] ?? null;
}

function finalize(state, score, evidence, reasonCodes, levels) {
  return {
    strategy: 'SUPPORT_RESISTANCE_CONFIRMATION',
    direction: 'LONG',
    state,
    score: { value: clamp(score) },
    entry: levels.entry,
    stopLoss: levels.stopLoss,
    levels: { tp1: levels.tp1, tp2: levels.tp2, tp3: levels.tp3 },
    evidence,
    reasonCodes: unique(reasonCodes),
    hardGatesPassed: true,
    dataQuality: 100,
    confidence_score: 'UNKNOWN',
    paper_trading: true,
    real_order_execution: false
  };
}

export function evaluateSupportResistanceConfirmation({
  series15m,
  config = {
    fractalSpan: 2,
    supportProximityPct: 1.0,
    resistanceProximityPct: 1.5,
    breakoutBufferPct: 0.15,
    minRvolBounce: 1.05,
    minRvolBreakout: 1.2
  },
  now = Date.now()
} = {}) {
  const p = prepare(series15m, '15m', 90, now);
  if (p.strategy === null) return { ...p, strategy: 'SUPPORT_RESISTANCE_CONFIRMATION' };

  const candles = p.candles;
  const closes = candles.map(c => Number(c.close));
  const e20 = emaSeries(closes, 20);
  const e50 = emaSeries(closes, 50);
  const atr = atrSeries(candles, 14);
  const i = candles.length - 1;
  const last = candles[i];
  const previous = candles[i - 1];
  const price = Number(last.close);
  const previousClose = Number(previous?.close);
  const ema20 = e20[i];
  const ema50 = e50[i];
  const atr14 = atr[i];
  const shape = candleShape(last);
  const volume = volumeStats(candles, 20);
  const levels = pivotLevels(candles, Number(config.fractalSpan ?? 2));

  const support = nearestSupport(levels.supports, price, Number(config.resistanceProximityPct ?? 1.5));
  const resistance = nearestResistance(levels.resistances, price, Number(config.resistanceProximityPct ?? 1.5));

  const atrPct = finite(atr14) && price > 0 ? atr14 / price * 100 : null;
  const proximityPct = Math.max(
    Number(config.supportProximityPct ?? 1.0),
    finite(atrPct) ? atrPct * 1.25 : 0
  );

  const supportDistancePct = support?.price > 0 ? Math.abs(price - support.price) / price * 100 : null;
  const nearSupport = Boolean(support && finite(supportDistancePct) && supportDistancePct <= proximityPct);
  const supportReclaim = Boolean(
    support &&
    finite(previousClose) &&
    previousClose <= support.price * 1.005 &&
    price > support.price
  );
  const supportBounce = nearSupport && Boolean(
    supportReclaim ||
    (shape?.bullish && shape.lowerWickPct >= 25 && shape.closePositionPct >= 55)
  );

  const resistanceDistancePct = resistance?.price > 0 ? Math.abs(resistance.price - price) / price * 100 : null;
  const nearResistance = Boolean(
    resistance && finite(resistanceDistancePct) &&
    resistanceDistancePct <= Number(config.resistanceProximityPct ?? 1.5)
  );
  const breakoutBuffer = Number(config.breakoutBufferPct ?? 0.15);
  const resistanceBreak = Boolean(
    resistance &&
    price >= resistance.price * (1 + breakoutBuffer / 100) &&
    finite(previousClose) &&
    previousClose <= resistance.price * 1.005
  );
  const maAligned = finite(ema20) && finite(ema50) && price >= ema20 * 0.995 && ema20 >= ema50 * 0.998;
  const bounceVolume = finite(volume.rvol) && volume.rvol >= Number(config.minRvolBounce ?? 1.05);
  const breakoutVolume = finite(volume.rvol) && volume.rvol >= Number(config.minRvolBreakout ?? 1.2);
  const bullishBreakoutCandle = Boolean(shape?.bullish && shape.bodyPct >= 35 && shape.closePositionPct >= 65);

  const bounceReady = supportBounce && maAligned;
  const breakoutReady = resistanceBreak && maAligned && breakoutVolume && bullishBreakoutCandle;
  if (!bounceReady && !breakoutReady) {
    return reject('SUPPORT_RESISTANCE_CONFIRMATION', ['SUPPORT_RESISTANCE_NOT_CONFIRMED'], {
      price,
      support,
      resistance,
      support_distance_pct: supportDistancePct,
      resistance_distance_pct: resistanceDistancePct,
      near_support: nearSupport,
      near_resistance: nearResistance,
      support_reclaim: supportReclaim,
      support_bounce: supportBounce,
      resistance_breakout: resistanceBreak,
      ma_aligned: maAligned,
      rvol: volume.rvol,
      atr_pct: atrPct
    });
  }

  const atrRisk = finite(atr14) && atr14 > 0 ? atr14 : price * 0.01;
  const entry = price;
  const stopLoss = bounceReady && support
    ? Math.min(entry - atrRisk * 1.25, support.price - atrRisk * 0.35)
    : Math.min(entry - atrRisk * 1.15, (resistance?.price ?? entry) - atrRisk * 0.8);
  const risk = Math.max(entry - stopLoss, atrRisk * 0.5);
  const tp1 = entry + risk;
  const tp2 = entry + risk * 1.8;
  const tp3 = resistance && resistance.price > entry + risk ? resistance.price : entry + risk * 2.6;

  const score =
    50 +
    (bounceReady ? 14 : 0) +
    (breakoutReady ? 18 : 0) +
    (nearSupport ? 8 : 0) +
    (resistanceBreak ? 10 : 0) +
    (maAligned ? 8 : 0) +
    (bounceVolume ? 5 : 0) +
    (breakoutVolume ? 7 : 0) +
    (shape?.bullish ? 4 : 0);

  const state = score >= 80 ? 'CONFIRMED' : 'CANDIDATE';
  return finalize(
    state,
    score,
    {
      timeframe: '15m',
      support: support?.price ?? null,
      resistance: resistance?.price ?? null,
      support_distance_pct: supportDistancePct,
      resistance_distance_pct: resistanceDistancePct,
      near_support: nearSupport,
      near_resistance: nearResistance,
      support_reclaim: supportReclaim,
      support_bounce: supportBounce,
      resistance_breakout: resistanceBreak,
      ma_aligned: maAligned,
      ema20,
      ema50,
      rvol_ratio: volume.rvol,
      atr14,
      atr_pct: atrPct,
      bullish_candle: Boolean(shape?.bullish),
      rejection_wick_pct: shape?.lowerWickPct ?? null,
      close_position_pct: shape?.closePositionPct ?? null,
      age_ms: p.ageMs
    },
    [
      ...(bounceReady ? ['SUPPORT_BOUNCE_CONFIRMATION'] : []),
      ...(resistanceBreak ? ['RESISTANCE_BREAKOUT'] : []),
      ...(maAligned ? ['EMA20_EMA50_ALIGNMENT'] : []),
      ...(bounceVolume ? ['RVOL_BOUNCE_SUPPORT'] : []),
      ...(breakoutVolume ? ['RVOL_BREAKOUT_CONFIRMATION'] : []),
      ...(shape?.bullish ? ['BULLISH_CANDLE_CONFIRMATION'] : [])
    ],
    { entry, stopLoss, tp1, tp2, tp3 }
  );
}
