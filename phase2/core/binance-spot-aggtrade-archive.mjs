import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const DAY_MS = 24 * 60 * 60_000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const DEFAULT_CACHE_DIR = join(tmpdir(), 'radarx-binance-spot-aggtrades-cache');

export function normalizeBinanceSpotArchiveTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Binance public-data archives changed Spot timestamps to microseconds from 2025-01-01.
  // REST responses used by RadarX are milliseconds, so normalize archive rows before replay.
  return Math.trunc(n >= 100_000_000_000_000 ? n / 1000 : n);
}

function parseBoolean(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return null;
}

export function parseBinanceSpotAggTradeArchiveLine(line) {
  const fields = String(line ?? '').trim().split(',');
  if (fields.length !== 8) return null;
  const a = Number(fields[0]);
  const p = String(fields[1] ?? '').trim();
  const q = String(fields[2] ?? '').trim();
  const f = Number(fields[3]);
  const l = Number(fields[4]);
  const T = normalizeBinanceSpotArchiveTimestamp(fields[5]);
  const m = parseBoolean(fields[6]);
  const M = parseBoolean(fields[7]);
  if (!Number.isSafeInteger(a) || a < 0 ||
      !Number.isFinite(Number(p)) || Number(p) <= 0 ||
      !Number.isFinite(Number(q)) || Number(q) <= 0 ||
      !Number.isSafeInteger(f) || f < 0 ||
      !Number.isSafeInteger(l) || l < f ||
      T === null || m === null || M === null) return null;
  return {a, p, q, f, l, T, m, M};
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function responseText(fetchImpl, url) {
  const response = await fetchImpl(url, {signal: AbortSignal.timeout(30_000)});
  if (!response.ok) return null;
  return await response.text();
}

async function ensureVerifiedArchive(url, cachePath, fetchImpl) {
  const expectedPath = cachePath + '.verified-sha256';
  try {
    const [expected, info] = await Promise.all([
      readFile(expectedPath, 'utf8'),
      stat(cachePath)
    ]);
    if (info.size > 0 && expected.trim().match(/^[a-f0-9]{64}$/i) &&
        (await sha256File(cachePath)) === expected.trim().toLowerCase()) {
      return {path: cachePath, sha256: expected.trim().toLowerCase(), url, cache_hit: true};
    }
  } catch {}

  await rm(cachePath, {force: true}).catch(() => {});
  await rm(expectedPath, {force: true}).catch(() => {});
  let checksumText;
  try {
    checksumText = await responseText(fetchImpl, url + '.CHECKSUM');
  } catch (error) {
    return {unavailable: true, reason: 'CHECKSUM_FETCH_FAILED:' + String(error?.message || error).slice(0, 120)};
  }
  const expected = checksumText?.match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase();
  if (!expected) return {unavailable: true, reason: 'OFFICIAL_CHECKSUM_UNAVAILABLE'};

  let response;
  try {
    response = await fetchImpl(url, {signal: AbortSignal.timeout(120_000)});
  } catch (error) {
    return {unavailable: true, reason: 'ARCHIVE_FETCH_FAILED:' + String(error?.message || error).slice(0, 120)};
  }
  if (!response.ok || !response.body) {
    return {unavailable: true, reason: 'ARCHIVE_HTTP_' + response.status};
  }
  const announcedSize = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(announcedSize) && announcedSize > MAX_ARCHIVE_BYTES) {
    return {unavailable: true, reason: 'ARCHIVE_EXCEEDS_SIZE_LIMIT'};
  }

  await mkdir(join(cachePath, '..'), {recursive: true});
  const tempPath = cachePath + '.part-' + process.pid;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath, {flags: 'wx'}));
    const info = await stat(tempPath);
    if (info.size <= 0 || info.size > MAX_ARCHIVE_BYTES) {
      await rm(tempPath, {force: true});
      return {unavailable: true, reason: 'ARCHIVE_SIZE_INVALID'};
    }
    const actual = await sha256File(tempPath);
    if (actual !== expected) {
      await rm(tempPath, {force: true});
      return {unavailable: true, reason: 'ARCHIVE_CHECKSUM_MISMATCH'};
    }
    await rename(tempPath, cachePath);
    await writeFile(expectedPath, expected + '\n', 'utf8');
    return {path: cachePath, sha256: actual, url, cache_hit: false};
  } catch (error) {
    await rm(tempPath, {force: true}).catch(() => {});
    return {unavailable: true, reason: 'ARCHIVE_WRITE_OR_VERIFY_FAILED:' + String(error?.message || error).slice(0, 120)};
  }
}

function utcDaysBetween(startTime, endTime) {
  const first = Math.floor(startTime / DAY_MS) * DAY_MS;
  const last = Math.floor(endTime / DAY_MS) * DAY_MS;
  const days = [];
  for (let day = first; day <= last; day += DAY_MS) days.push(day);
  return days;
}

async function findArchive(symbol, dayStart, cacheDir, fetchImpl) {
  const day = new Date(dayStart).toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const dayUrl = 'https://data.binance.vision/data/spot/daily/aggTrades/' + symbol + '/' +
    symbol + '-aggTrades-' + day + '.zip';
  const dayFile = join(cacheDir, symbol + '-aggTrades-' + day + '.zip');
  const daily = await ensureVerifiedArchive(dayUrl, dayFile, fetchImpl);
  if (!daily.unavailable) return {...daily, granularity: 'daily', day};

  // Monthly archive fallback is allowed only for completed prior months. The current
  // month's archive may not yet contain the full month and therefore cannot prove coverage.
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (month >= currentMonth) {
    return {unavailable: true, reason: daily.reason || 'DAILY_ARCHIVE_UNAVAILABLE', day};
  }
  const monthUrl = 'https://data.binance.vision/data/spot/monthly/aggTrades/' + symbol + '/' +
    symbol + '-aggTrades-' + month + '.zip';
  const monthFile = join(cacheDir, symbol + '-aggTrades-' + month + '.zip');
  const monthly = await ensureVerifiedArchive(monthUrl, monthFile, fetchImpl);
  if (monthly.unavailable) {
    return {unavailable: true, reason: monthly.reason || daily.reason || 'ARCHIVE_UNAVAILABLE', day};
  }
  return {...monthly, granularity: 'monthly', day};
}

async function readTradesFromArchive(archivePath, startTime, endTime, maxTrades) {
  const child = spawn('unzip', ['-p', archivePath], {stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = '';
  let spawnError = null;
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
    if (stderr.length > 2000) stderr = stderr.slice(-2000);
  });
  child.on('error', error => { spawnError = error; });
  const closed = new Promise(resolve => child.once('close', resolve));
  const trades = [];
  let totalMatching = 0;
  let invalidRows = 0;
  let pending = '';
  const visitLine = line => {
    if (!String(line ?? '').trim()) return;
    const trade = parseBinanceSpotAggTradeArchiveLine(line);
    if (!trade) { invalidRows++; return; }
    if (trade.T < startTime || trade.T > endTime) return;
    totalMatching++;
    if (trades.length < maxTrades) trades.push(trade);
  };
  try {
    for await (const chunk of child.stdout) {
      pending += chunk.toString('utf8');
      let boundary = pending.indexOf('\n');
      while (boundary >= 0) {
        visitLine(pending.slice(0, boundary).replace(/\r$/, ''));
        pending = pending.slice(boundary + 1);
        boundary = pending.indexOf('\n');
      }
    }
  } catch (error) {
    child.kill('SIGKILL');
    await closed;
    throw error;
  }
  if (pending.trim()) visitLine(pending);
  const exitCode = await closed;
  if (spawnError) throw spawnError;
  if (exitCode !== 0) throw new Error('BINANCE_ARCHIVE_UNZIP_FAILED:' + stderr.slice(-500));
  return {trades, totalMatching, invalidRows, limitReached: totalMatching > maxTrades};
}

function cacheKey(symbol, startTime, endTime, maxTrades) {
  return symbol + '-' + Math.trunc(startTime) + '-' + Math.trunc(endTime) + '-' + maxTrades;
}

async function readCachedWindow(metaPath, tradesPath) {
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    if (meta?.complete !== true || meta?.source !== 'BINANCE_DATA_VISION_SPOT_AGGTRADES') return null;
    const contents = await readFile(tradesPath, 'utf8');
    const trades = contents.split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (trades.length !== Number(meta.rows)) return null;
    return {trades, complete: true, coverage: {...meta, cache_hit: true}};
  } catch {
    return null;
  }
}

/**
 * Read a historical Spot aggTrade window only from official, checksum-verified Binance
 * Data Vision archives. It intentionally returns incomplete when any requested day lacks
 * a verifiable archive or a configured trade cap is reached; the caller can then fall
 * back to REST without mislabeling partial archive data as complete.
 */
export async function fetchBinanceSpotAggTradesArchive(symbol, startTime, endTime, {
  maxTrades = 500_000,
  cacheDir = process.env.RADARX_HISTORICAL_ARCHIVE_CACHE || DEFAULT_CACHE_DIR,
  fetchImpl = globalThis.fetch
} = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const start = Number(startTime);
  const end = Number(endTime);
  const cap = Math.max(1, Math.trunc(Number(maxTrades) || 500_000));
  if (!/^[A-Z0-9]{5,20}$/.test(normalizedSymbol) ||
      !Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start ||
      typeof fetchImpl !== 'function') {
    return {trades: [], complete: false, coverage: {source: 'BINANCE_DATA_VISION_SPOT_AGGTRADES', reason: 'INVALID_ARCHIVE_REQUEST'}};
  }
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (new Date(end).toISOString().slice(0, 10) >= todayUtc) {
    return {trades: [], complete: false, coverage: {
      source: 'BINANCE_DATA_VISION_SPOT_AGGTRADES', reason: 'ARCHIVE_NOT_MATURED_FOR_CURRENT_UTC_DAY',
      requested_start_time: start, requested_end_time: end
    }};
  }

  const key = cacheKey(normalizedSymbol, start, end, cap);
  const cacheRoot = join(cacheDir, normalizedSymbol);
  await mkdir(cacheRoot, {recursive: true});
  const metaPath = join(cacheRoot, key + '.json');
  const tradesPath = join(cacheRoot, key + '.jsonl');
  const cached = await readCachedWindow(metaPath, tradesPath);
  if (cached) return cached;

  const archiveFiles = [];
  const unavailableDays = [];
  for (const dayStart of utcDaysBetween(start, end)) {
    const archive = await findArchive(normalizedSymbol, dayStart, cacheRoot, fetchImpl);
    if (archive.unavailable) {
      unavailableDays.push({day: archive.day || new Date(dayStart).toISOString().slice(0, 10), reason: archive.reason});
      continue;
    }
    archiveFiles.push({
      day: archive.day, day_start_ms: dayStart, granularity: archive.granularity,
      url: archive.url, sha256: archive.sha256, cache_hit: archive.cache_hit === true,
      path: archive.path
    });
  }
  if (unavailableDays.length) {
    return {trades: [], complete: false, coverage: {
      source: 'BINANCE_DATA_VISION_SPOT_AGGTRADES', reason: 'ARCHIVE_OR_CHECKSUM_UNAVAILABLE',
      requested_start_time: start, requested_end_time: end, archives_verified: archiveFiles.length,
      unavailable_days: unavailableDays, checksum_verified: false
    }};
  }

  const tradesById = new Map();
  let matchingRows = 0;
  for (const archive of archiveFiles) {
    const dayStart = Number(archive.day_start_ms);
    const dayEnd = dayStart + DAY_MS - 1;
    const parsed = await readTradesFromArchive(archive.path, Math.max(start, dayStart), Math.min(end, dayEnd), cap);
    matchingRows += parsed.totalMatching;
    if (parsed.invalidRows > 0) {
      return {trades: [], complete: false, coverage: {
        source: 'BINANCE_DATA_VISION_SPOT_AGGTRADES', reason: 'ARCHIVE_ROW_PARSE_FAILURE',
        requested_start_time: start, requested_end_time: end, invalid_archive_rows: parsed.invalidRows,
        archives_verified: archiveFiles.length, checksum_verified: true,
        archive_files: archiveFiles.map(({path, ...item}) => item)
      }};
    }
    for (const trade of parsed.trades) {
      if (!tradesById.has(trade.a)) tradesById.set(trade.a, trade);
      if (tradesById.size >= cap) break;
    }
    if (matchingRows > cap || tradesById.size >= cap) break;
  }
  if (matchingRows > cap || tradesById.size >= cap) {
    return {trades: [], complete: false, coverage: {
      source: 'BINANCE_DATA_VISION_SPOT_AGGTRADES', reason: 'ARCHIVE_TRADE_CAP_REACHED',
      requested_start_time: start, requested_end_time: end, trade_cap: cap,
      rows_observed_at_least: Math.max(matchingRows, tradesById.size), archives_verified: archiveFiles.length,
      archive_files: archiveFiles.map(({path, ...item}) => item), checksum_verified: true
    }};
  }

  const trades = [...tradesById.values()].sort((a, b) => a.T - b.T || a.a - b.a);
  const temporaryTradesPath = tradesPath + '.part-' + process.pid;
  const temporaryMetaPath = metaPath + '.part-' + process.pid;
  try {
    await writeFile(temporaryTradesPath, trades.map(trade => JSON.stringify(trade)).join('\n') + (trades.length ? '\n' : ''), 'utf8');
    const coverage = {
      source: 'BINANCE_DATA_VISION_SPOT_AGGTRADES', complete: true, rows: trades.length,
      trades_sha256: createHash('sha256').update(serializedTrades).digest('hex'),
      requested_start_time: start, requested_end_time: end,
      first_trade_time: trades[0]?.T ?? null, last_trade_time: trades.at(-1)?.T ?? null,
      archives_verified: archiveFiles.length, checksum_verified: true,
      timestamp_normalization: 'SPOT_ARCHIVE_MICROSECONDS_TO_MILLISECONDS_FROM_2025',
      archive_files: archiveFiles.map(({path, ...item}) => item)
    };
    await writeFile(temporaryMetaPath, JSON.stringify(coverage), 'utf8');
    await rename(temporaryTradesPath, tradesPath);
    await rename(temporaryMetaPath, metaPath);
    return {trades, complete: true, coverage};
  } catch (error) {
    await rm(temporaryTradesPath, {force: true}).catch(() => {});
    await rm(temporaryMetaPath, {force: true}).catch(() => {});
    throw error;
  }
}
