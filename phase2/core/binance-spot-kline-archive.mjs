import {createHash} from 'node:crypto';

const FINITE = value => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Binance public Spot archives changed candle timestamps from milliseconds
 * to microseconds on 2025-01-01. Normalize both representations to ms.
 */
export function normalizeBinanceSpotKlineArchiveTimestamp(value) {
  const parsed = FINITE(value);
  if (parsed === null || parsed <= 0) return null;
  return Math.trunc(parsed >= 100_000_000_000_000 ? parsed / 1000 : parsed);
}

/**
 * Parse official headerless Spot kline CSV into the raw row layout expected
 * by adaptive-trader-engine. Malformed, open, impossible and duplicate rows
 * are counted instead of being silently treated as valid history.
 */
export function parseBinanceSpotKlineArchiveCsv(csv, {intervalMs} = {}) {
  const step = Math.trunc(Number(intervalMs));
  if (!Number.isFinite(step) || step <= 0) throw new Error('INVALID_KLINE_INTERVAL_MS');
  const byOpen = new Map();
  const rejected = {
    malformed: 0,
    invalid_timestamp: 0,
    invalid_price_or_volume: 0,
    invalid_close_boundary: 0,
    duplicate_open_time: 0
  };
  const lines = String(csv ?? '').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = line.split(',');
    if (fields.length < 11) {
      rejected.malformed++;
      continue;
    }
    const openTime = normalizeBinanceSpotKlineArchiveTimestamp(fields[0]);
    const closeTime = normalizeBinanceSpotKlineArchiveTimestamp(fields[6]);
    if (openTime === null || closeTime === null) {
      rejected.invalid_timestamp++;
      continue;
    }
    if (closeTime !== openTime + step - 1) {
      rejected.invalid_close_boundary++;
      continue;
    }
    const open = FINITE(fields[1]), high = FINITE(fields[2]);
    const low = FINITE(fields[3]), close = FINITE(fields[4]);
    const volume = FINITE(fields[5]), quoteVolume = FINITE(fields[7]);
    const tradeCount = FINITE(fields[8]), takerBuyBase = FINITE(fields[9]);
    const takerBuyQuote = FINITE(fields[10]);
    if ([open, high, low, close, volume, quoteVolume, tradeCount,
      takerBuyBase, takerBuyQuote].some(value => value === null) ||
      open <= 0 || high < low || low <= 0 || close <= 0 ||
      volume < 0 || quoteVolume < 0 || tradeCount < 0 ||
      takerBuyBase < 0 || takerBuyQuote < 0) {
      rejected.invalid_price_or_volume++;
      continue;
    }
    const row = [
      openTime, fields[1], fields[2], fields[3], fields[4], fields[5],
      closeTime, fields[7], fields[8], fields[9], fields[10], fields[11] ?? '0'
    ];
    if (byOpen.has(openTime)) rejected.duplicate_open_time++;
    byOpen.set(openTime, row);
  }
  const rows = [...byOpen.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
  const contiguousBars = rows.length > 1
    ? rows.slice(1).reduce((count, row, index) =>
      count + (Number(row[0]) - Number(rows[index][0]) === step ? 1 : 0), 0)
    : 0;
  const expectedAdjacentBars = Math.max(0, rows.length - 1);
  return {
    rows,
    rejected,
    continuity_ratio: expectedAdjacentBars
      ? Number((contiguousBars / expectedAdjacentBars).toFixed(6))
      : (rows.length ? 1 : 0),
    sha256_csv: createHash('sha256').update(String(csv ?? '')).digest('hex')
  };
}

export function listBinanceSpotArchiveMonths(startMs, endExclusiveMs) {
  const start = Number(startMs), end = Number(endExclusiveMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start) {
    throw new Error('INVALID_ARCHIVE_WINDOW');
  }
  const first = new Date(start);
  const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
  const months = [];
  while (cursor.getTime() < end) {
    months.push(cursor.getUTCFullYear() + '-' + String(cursor.getUTCMonth() + 1).padStart(2, '0'));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}
