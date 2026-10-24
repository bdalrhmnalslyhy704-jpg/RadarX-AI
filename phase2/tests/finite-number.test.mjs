import test from 'node:test';
import assert from 'node:assert/strict';
import {finiteNumberOr} from '../core/finite-number.mjs';
import {normalizeTickerRow} from '../market/universe-scanner.mjs';

test('missing market-data numbers stay missing instead of being coerced to zero', () => {
  assert.equal(finiteNumberOr(null), null);
  assert.equal(finiteNumberOr(undefined), null);
  assert.equal(finiteNumberOr(''), null);
  assert.equal(finiteNumberOr('   '), null);
  assert.equal(finiteNumberOr(false), null);
  assert.equal(finiteNumberOr({}), null);
});

test('finite numeric values including an actual zero are preserved', () => {
  assert.equal(finiteNumberOr(0), 0);
  assert.equal(finiteNumberOr('0'), 0);
  assert.equal(finiteNumberOr('1.25'), 1.25);
  assert.equal(finiteNumberOr(-4), -4);
});

test('non-finite values use the caller fallback', () => {
  assert.equal(finiteNumberOr(Number.NaN), null);
  assert.equal(finiteNumberOr(Number.POSITIVE_INFINITY, 'unknown'), 'unknown');
  assert.equal(finiteNumberOr('not-a-number', -1), -1);
});

test('ticker normalization rejects absent required metrics without converting them to zero', () => {
  const valid = {
    symbol:'TESTUSDT',lastPrice:'1.25',quoteVolume:'1000000',count:'5000',
    priceChangePercent:'0.4',highPrice:'1.3',lowPrice:'1.1',closeTime:'1800000000000'
  };
  assert.equal(normalizeTickerRow(valid,'USDT').priceChange24h,0.4);
  for (const key of ['lastPrice','quoteVolume','count','priceChangePercent']) {
    assert.equal(normalizeTickerRow({...valid,[key]:null},'USDT'),null,key+' null must remain missing');
    assert.equal(normalizeTickerRow({...valid,[key]:'   '},'USDT'),null,key+' blank must remain missing');
  }
  const optionalMissing = normalizeTickerRow({...valid,highPrice:null,lowPrice:'',closeTime:null},'USDT');
  assert.equal(optionalMissing.highPrice24h,null);
  assert.equal(optionalMissing.lowPrice24h,null);
  assert.equal(optionalMissing.tickerTime,null);
});
