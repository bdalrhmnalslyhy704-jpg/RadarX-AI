import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBinanceSpotArchiveTimestamp,
  parseBinanceSpotAggTradeArchiveLine
} from '../core/binance-spot-aggtrade-archive.mjs';

test('normalizes Binance Spot archive microseconds to RadarX milliseconds', () => {
  assert.equal(normalizeBinanceSpotArchiveTimestamp('1735689600010866'), 1735689600010);
});

test('keeps legacy Binance Spot archive millisecond timestamps unchanged', () => {
  assert.equal(normalizeBinanceSpotArchiveTimestamp('1720000000123'), 1720000000123);
});

test('parses the eight-column official Spot aggTrades CSV row', () => {
  assert.deepEqual(
    parseBinanceSpotAggTradeArchiveLine('123,0.00250000,10.00000000,120,123,1735689600010866,False,True'),
    {a:123,p:'0.00250000',q:'10.00000000',f:120,l:123,T:1735689600010,m:false,M:true}
  );
});

test('rejects headers, malformed rows, and invalid market values', () => {
  assert.equal(parseBinanceSpotAggTradeArchiveLine('aggTradeId,price,qty,firstTradeId,lastTradeId,time,isBuyerMaker,isBestMatch'), null);
  assert.equal(parseBinanceSpotAggTradeArchiveLine('1,0,10,1,1,1735689600010,false,true'), null);
  assert.equal(parseBinanceSpotAggTradeArchiveLine('1,2,10,1,1,not-a-time,false,true'), null);
});
