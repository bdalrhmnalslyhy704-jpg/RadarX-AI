import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  fetchBinanceSpotAggTradesArchive,
  normalizeBinanceSpotArchiveTimestamp,
  parseBinanceSpotAggTradeArchiveLine
} from '../core/binance-spot-aggtrade-archive.mjs';

test('normalizes Binance Spot archive microseconds to RadarX milliseconds', () => {
  assert.equal(normalizeBinanceSpotArchiveTimestamp('1735689600010866'), 1735689600010);
});

test('keeps legacy Binance Spot archive millisecond timestamps unchanged', () => {
  assert.equal(normalizeBinanceSpotArchiveTimestamp('1720000000123'), 1720000000123);
});

test('rejects invalid timestamps', () => {
  for (const input of [null, undefined, '', 'not-a-time', 0, -1, NaN, Infinity]) {
    assert.equal(normalizeBinanceSpotArchiveTimestamp(input), null);
  }
});

test('parses the eight-column official Spot aggTrades CSV row', () => {
  assert.deepEqual(
    parseBinanceSpotAggTradeArchiveLine('123,0.00250000,10.00000000,120,123,1735689600010866,False,True'),
    {a:123,p:'0.00250000',q:'10.00000000',f:120,l:123,T:1735689600010,m:false,M:true}
  );
});

test('rejects headers, malformed rows, and invalid market values', () => {
  for (const line of [
    'aggTradeId,price,qty,firstTradeId,lastTradeId,time,isBuyerMaker,isBestMatch',
    '1,0,10,1,1,1735689600010,false,true',
    '1,2,0,1,1,1735689600010,false,true',
    '1,2,10,2,1,1735689600010,false,true',
    '1,2,10,1,1,not-a-time,false,true',
    '1,2,10,1,1,1735689600010,unknown,true',
    '1,2,10,1,1,1735689600010,false,unknown',
    '1,2,10,1,1,1735689600010,false'
  ]) {
    assert.equal(parseBinanceSpotAggTradeArchiveLine(line), null, line);
  }
});

test('downloads only checksum-matching archive data, parses it, and validates the cached window hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radarx-binance-archive-test-'));
  const dayStart = Date.parse('2024-01-02T00:00:00.000Z');
  const end = dayStart + 1000;
  const csv = '1,1.25000000,2.00000000,1,1,' + (dayStart + 100) + ',false,true\n';
  const fakeArchive = Buffer.from('a synthetic archive payload used with the injected unzip reader');
  const archiveDigest = createHash('sha256').update(fakeArchive).digest('hex');
  let fetchCount = 0;
  let readerCount = 0;
  const fetchImpl = async (url) => {
    fetchCount++;
    if (url.endsWith('.zip.CHECKSUM')) {
      const file = url.split('/').at(-1).replace('.CHECKSUM', '');
      return new Response(archiveDigest + '  ' + file + '\n', {status: 200});
    }
    if (url.endsWith('.zip')) {
      return new Response(fakeArchive, {status: 200, headers: {'content-length': String(fakeArchive.length)}});
    }
    return new Response('not found', {status: 404});
  };
  const spawnImpl = () => {
    readerCount++;
    const child = new EventEmitter();
    child.stdout = Readable.from([csv]);
    child.stderr = Readable.from([]);
    child.kill = () => true;
    process.nextTick(() => child.emit('close', 0, null));
    return child;
  };
  try {
    const first = await fetchBinanceSpotAggTradesArchive('GTCUSDT', dayStart, end, {
      cacheDir: root, fetchImpl, spawnImpl, maxTrades: 100
    });
    assert.equal(first.complete, true);
    assert.equal(first.coverage.checksum_verified, true);
    assert.equal(first.coverage.source, 'BINANCE_DATA_VISION_SPOT_AGGTRADES');
    assert.equal(first.coverage.rows, 1);
    assert.equal(first.trades[0]?.T, dayStart + 100);
    assert.equal(readerCount, 1);
    const cachedContents = await readFile(join(root, 'GTCUSDT', 'GTCUSDT-' + dayStart + '-' + end + '-100.jsonl'), 'utf8');
    assert.equal(first.coverage.trades_sha256, createHash('sha256').update(cachedContents).digest('hex'));

    const afterFirstFetchCount = fetchCount;
    const second = await fetchBinanceSpotAggTradesArchive('GTCUSDT', dayStart, end, {
      cacheDir: root, fetchImpl, spawnImpl, maxTrades: 100
    });
    assert.equal(second.complete, true);
    assert.equal(second.coverage.cache_hit, true);
    assert.equal(second.trades.length, 1);
    assert.equal(readerCount, 1);
    assert.equal(fetchCount, afterFirstFetchCount);

    // A corrupted normalized cache must not be accepted as verified.
    const tradesPath = join(root, 'GTCUSDT', 'GTCUSDT-' + dayStart + '-' + end + '-100.jsonl');
    const {writeFile} = await import('node:fs/promises');
    await writeFile(tradesPath, '{"a":999}\n', 'utf8');
    const third = await fetchBinanceSpotAggTradesArchive('GTCUSDT', dayStart, end, {
      cacheDir: root, fetchImpl, spawnImpl, maxTrades: 100
    });
    assert.equal(third.complete, true);
    assert.equal(third.trades[0]?.a, 1);
    assert.equal(readerCount, 2);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('refuses archives whose official checksum does not match the downloaded bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'radarx-binance-checksum-test-'));
  const dayStart = Date.parse('2024-01-03T00:00:00.000Z');
  const fakeArchive = Buffer.from('wrong bytes');
  const spawnImpl = () => {
    throw new Error('Reader must not be called for an archive with a checksum mismatch');
  };
  const fetchImpl = async url => {
    if (url.endsWith('.zip.CHECKSUM')) return new Response('0'.repeat(64) + ' archive.zip\n', {status: 200});
    if (url.endsWith('.zip')) return new Response(fakeArchive, {status: 200});
    return new Response('', {status: 404});
  };
  try {
    const result = await fetchBinanceSpotAggTradesArchive('GTCUSDT', dayStart, dayStart + 1000, {
      cacheDir: root, fetchImpl, spawnImpl, maxTrades: 100
    });
    assert.equal(result.complete, false);
    assert.equal(result.coverage.reason, 'ARCHIVE_OR_CHECKSUM_UNAVAILABLE');
    assert.equal(result.trades.length, 0);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
