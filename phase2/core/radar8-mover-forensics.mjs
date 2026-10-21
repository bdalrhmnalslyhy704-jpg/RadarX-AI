import {evaluateProposedExtendedContinuationWatch} from './activity-shock.mjs';
export {evaluateProposedExtendedContinuationWatch};

const MINUTE_MS = 60_000;
const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const median = values => {
  const rows = values.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
};

export const RADAR8_MOVER_FORENSICS_ASSET_CLASSES = Object.freeze({
  CYPHBUSDT: 'BINANCE_BSTOCK_TOKENIZED_SECURITY',
  AMCBUSDT: 'BINANCE_BSTOCK_TOKENIZED_SECURITY',
  AGPUBUSDT: 'BINANCE_BSTOCK_TOKENIZED_SECURITY',
  BOTBUSDT: 'BINANCE_BSTOCK_TOKENIZED_SECURITY',
  BRKBBUSDT: 'BINANCE_BSTOCK_TOKENIZED_SECURITY',
  KSTRBUSDT: 'BINANCE_BSTOCK_TOKENIZED_SECURITY',
  TMFBUSDT: 'BINANCE_BSTOCK_TOKENIZED_SECURITY',
  VSTBUSDT: 'BINANCE_BSTOCK_TOKENIZED_SECURITY'
});


export function classifyForRadar8MoverForensics(symbol) {
  const key = String(symbol || '').trim().toUpperCase();
  return RADAR8_MOVER_FORENSICS_ASSET_CLASSES[key] || 'CRYPTO_SPOT_TOKEN';
}

/**
 * Reconstructs Radar 8's fast ticker-delta features from consecutive historical
 * ticker snapshots. It deliberately keeps missing deltas unknown instead of
 * fabricating zero volume or trade activity.
 */
export function buildReplayFastSnapshot(row = {}, history = [], at = Date.now()) {
  const previousRows = Array.isArray(history) ? history : [];
  const previous = previousRows.at(-1) || null;
  const previous2 = previousRows.at(-2) || null;

  const price = finite(row.lastPrice) && Number(row.lastPrice) > 0 ? Number(row.lastPrice) : null;
  const quote = finite(row.quoteVolume24h) && Number(row.quoteVolume24h) >= 0 ? Number(row.quoteVolume24h) : null;
  const trades = finite(row.tradeCount24h) && Number(row.tradeCount24h) >= 0 ? Number(row.tradeCount24h) : null;
  const priceChange = price !== null && previous?.price > 0
    ? (price / previous.price - 1) * 100
    : (previous ? null : 0);
  const priorPriceChange = previous?.priceChange;
  const acceleration = finite(priceChange) && finite(priorPriceChange) ? priceChange - Number(priorPriceChange) : null;
  const quoteDelta = quote !== null && finite(previous?.quote) ? quote - Number(previous.quote) : (previous ? null : 0);
  const tradeDelta = trades !== null && finite(previous?.trades) ? trades - Number(previous.trades) : (previous ? null : 0);

  const priorQuoteDeltas = previousRows.slice(-10).map(item => item.qDelta).filter(x => finite(x) && Number(x) > 0).map(Number);
  const priorTradeDeltas = previousRows.slice(-10).map(item => item.tDelta).filter(x => finite(x) && Number(x) > 0).map(Number);
  const quoteBaseline = median(priorQuoteDeltas);
  const tradeBaseline = median(priorTradeDeltas);
  const volumeRatio = finite(quoteDelta) && finite(quoteBaseline) && quoteBaseline > 0
    ? Math.max(0, Number(quoteDelta)) / quoteBaseline : null;
  const tradeRatio = finite(tradeDelta) && finite(tradeBaseline) && tradeBaseline > 0
    ? Math.max(0, Number(tradeDelta)) / tradeBaseline : null;

  const snapshot = {
    price, quote, trades, qDelta: quoteDelta, tDelta: tradeDelta,
    priceChange, at: Number(at)
  };
  const nextHistory = [...previousRows, snapshot].slice(-12);
  return {
    history: nextHistory,
    fast: {
      price_change_pct: priceChange,
      price_acceleration_pct: acceleration,
      volume_delta_quote: quoteDelta,
      trade_delta: tradeDelta,
      volume_accel_ratio: volumeRatio,
      trade_accel_ratio: tradeRatio,
      at: Number(at),
      warmed_up: Boolean(previous)
    }
  };
}

export function firstClosedCandleCrossing(candles, {startTime, endTime, baselinePrice, targetPct} = {}) {
  const start = Number(startTime), end = Number(endTime), baseline = Number(baselinePrice), target = Number(targetPct);
  if (![start, end, baseline, target].every(Number.isFinite) || !(baseline > 0) || start >= end) return null;
  const rows = (Array.isArray(candles) ? candles : [])
    .filter(c => c && Number(c.openTime) >= start && Number(c.closeTime) <= end &&
      c.closed === true && finite(c.high) && Number(c.high) >= baseline * (1 + target / 100))
    .sort((a,b)=>Number(a.closeTime)-Number(b.closeTime));
  return rows.length ? Number(rows[0].closeTime) : null;
}

/** Returns a lead only when the candidate was observable strictly before the target candle closed. */
export function minutesBeforeClosedCandleCrossing(signalAt, crossingAt) {
  const signal = Number(signalAt), crossing = Number(crossingAt);
  if (!Number.isFinite(signal) || !Number.isFinite(crossing) || signal >= crossing) return null;
  return Number(((crossing - signal) / MINUTE_MS).toFixed(2));
}
