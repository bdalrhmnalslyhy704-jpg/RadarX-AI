import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBinanceSpotKlineArchiveTimestamp,
  parseBinanceSpotKlineArchiveCsv,
  listBinanceSpotArchiveMonths,
  listBinanceSpotArchiveDays,
  summarizeBinanceSpotArchiveCoverage
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
    row(open+1800000000,open+2699989999),
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


test('archive coverage allows pre-listing 404s but rejects gaps after first verified month',()=>{
  const summarize=files=>import('../core/binance-spot-kline-archive.mjs')
    .then(module=>module.summarizeBinanceSpotArchiveMonthCoverage(files));
  return Promise.all([
    summarize([
      {month:'2025-11',status:'MISSING'},
      {month:'2025-12',status:'MISSING'},
      {month:'2026-01',status:'VERIFIED'},
      {month:'2026-02',status:'VERIFIED'}
    ]).then(result=>{
      assert.equal(result.first_available_month,'2026-01');
      assert.equal(result.pre_listing_missing_months,2);
      assert.equal(result.complete_from_first_available,true);
      assert.equal(result.coverage_ratio_after_first_available,1);
    }),
    summarize([
      {month:'2025-11',status:'MISSING'},
      {month:'2025-12',status:'VERIFIED'},
      {month:'2026-01',status:'MISSING'},
      {month:'2026-02',status:'VERIFIED'}
    ]).then(result=>{
      assert.equal(result.missing_months_after_first_available,1);
      assert.equal(result.complete_from_first_available,false);
    }),
    summarize([
      {month:'2025-11',status:'FAILED'},
      {month:'2025-12',status:'VERIFIED'}
    ]).then(result=>{
      assert.equal(result.failed_archive_months,1);
      assert.equal(result.complete_from_first_available,false);
    })
  ]);
});

test('lists UTC daily Spot archive dates through the exclusive end only',()=>{
  const days=listBinanceSpotArchiveDays(
    Date.parse('2026-11-01T00:00:00.000Z'),
    Date.parse('2026-11-10T00:00:00.000Z')
  );
  assert.deepEqual(days,[
    '2026-11-01','2026-11-02','2026-11-03','2026-11-04','2026-11-05',
    '2026-11-06','2026-11-07','2026-11-08','2026-11-09'
  ]);
});
test('merged monthly and daily archive coverage allows only leading pre-listing 404s',()=>{
  const healthy=summarizeBinanceSpotArchiveCoverage([
    {period:'2026-09',period_type:'monthly',status:'MISSING'},
    {period:'2026-10',period_type:'monthly',status:'VERIFIED'},
    {period:'2026-11-01',period_type:'daily',status:'VERIFIED'},
    {period:'2026-11-02',period_type:'daily',status:'VERIFIED'}
  ]);
  assert.equal(healthy.first_available_period,'2026-10');
  assert.equal(healthy.pre_listing_missing_periods,1);
  assert.equal(healthy.expected_periods_after_first_available,3);
  assert.equal(healthy.verified_periods_after_first_available,3);
  assert.equal(healthy.complete_from_first_available,true);
  const gap=summarizeBinanceSpotArchiveCoverage([
    {period:'2026-10',period_type:'monthly',status:'VERIFIED'},
    {period:'2026-11-01',period_type:'daily',status:'VERIFIED'},
    {period:'2026-11-02',period_type:'daily',status:'MISSING'},
    {period:'2026-11-03',period_type:'daily',status:'VERIFIED'}
  ]);
  assert.equal(gap.missing_periods_after_first_available,1);
  assert.equal(gap.complete_from_first_available,false);
});
