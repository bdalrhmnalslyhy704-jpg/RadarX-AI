import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBinanceSpotKlineArchiveTimestamp,
  parseBinanceSpotKlineArchiveCsv,
  listBinanceSpotArchiveMonths
} from '../core/binance-spot-kline-archive.mjs';

test('normalizes Binance Spot archive microseconds and preserves REST milliseconds',()=>{
  assert.equal(normalizeBinanceSpotKlineArchiveTimestamp(1735689600000000),1735689600000);
  assert.equal(normalizeBinanceSpotKlineArchiveTimestamp(1735689600000),1735689600000);
  assert.equal(normalizeBinanceSpotKlineArchiveTimestamp(null),null);
  assert.equal(normalizeBinanceSpotKlineArchiveTimestamp(-1),null);
});

test('parses only valid closed Spot 15m archive rows and audits duplicates',()=>{
  const open=1735689600000000;
  const row=(time,closeTime,price='100')=>[
    time,price,'101','99',price,'10',closeTime,'1000','25','5','500','0'
  ].join(',');
  const csv=[
    row(open,open+899999999),
    row(open+900000000,open+1799999999,'101'),
    row(open,open+899999999),
    row(open+1800000000,open+2699999000),
    'bad,row'
  ].join('\n');
  const parsed=parseBinanceSpotKlineArchiveCsv(csv,{intervalMs:15*60*1000});
  assert.equal(parsed.rows.length,2);
  assert.equal(parsed.rows[0][0],1735689600000);
  assert.equal(parsed.rows[0][6],1735690499999);
  assert.equal(parsed.rows[1][0],1735690500000);
  assert.equal(parsed.rejected.duplicate_open_time,1);
  assert.equal(parsed.rejected.invalid_close_boundary,1);
  assert.equal(parsed.rejected.malformed,1);
  assert.equal(parsed.continuity_ratio,1);
});

test('lists full UTC monthly archive windows without adding the exclusive end month',()=>{
  const months=listBinanceSpotArchiveMonths(
    Date.parse('2026-05-19T12:00:00.000Z'),
    Date.parse('2026-08-01T00:00:00.000Z')
  );
  assert.deepEqual(months,['2026-05','2026-06','2026-07']);
});
