import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  normalizeBinanceSpotArchiveTimestamp,
  parseBinanceSpotAggTradeArchiveLine,
  serializeBinanceSpotAggTrades
} from '../core/binance-spot-aggtrade-archive.mjs';

test('normalizes Binance Spot archive microseconds to RadarX milliseconds', () => {
  assert.equal(normalizeBinanceSpotArchiveTimestamp('1735689600010866'), 1735689600010.866);
});

test('keeps legacy Binance Spot archive millisecond timestamps unchanged', () => {
  assert.equal(normalizeBinanceSpotArchiveTimestamp('1720000000123'), 1720000000123);
});

test('parses the eight-column official Spot aggTrades CSV row', () => {
  assert.deepEqual(
    parseBinanceSpotAggTradeArchiveLine('123,0.00250000,10.00000000,120,123,1735689600010866,False,True'),
    {a:123,p:'0.00250000',q:'10.00000000',f:120,l:123,T:1735689600010.866,m:false,M:true}
  );
});

test('rejects headers, malformed rows, and invalid market values', () => {
  assert.equal(parseBinanceSpotAggTradeArchiveLine('aggTradeId,price,qty,firstTradeId,lastTradeId,time,isBuyerMaker,isBestMatch'), null);
  assert.equal(parseBinanceSpotAggTradeArchiveLine('1,0,10,1,1,1735689600010,false,true'), null);
  assert.equal(parseBinanceSpotAggTradeArchiveLine('1,2,10,1,1,not-a-time,false,true'), null);
});

test('serializes verified archive JSONL and checksum from the exact same bytes', () => {
  const trades = [
    {a:123,p:'0.00250000',q:'10.00000000',f:120,l:123,T:1735689600010.866,m:false,M:true},
    {a:124,p:'0.00260000',q:'5.00000000',f:124,l:124,T:1735689600011.200,m:true,M:true}
  ];
  const serialized = serializeBinanceSpotAggTrades(trades);
  assert.equal(serialized.content, trades.map(row => JSON.stringify(row)).join('\\n') + '\\n');
  assert.equal(serialized.rowCount, 2);
  assert.equal(serialized.sha256, createHash('sha256').update(serialized.content).digest('hex'));
  assert.doesNotMatch(serialized.sha256, /undefined/);
});

test('empty verified archive serialization has stable empty-file checksum', () => {
  const serialized = serializeBinanceSpotAggTrades([]);
  assert.equal(serialized.content, '');
  assert.equal(serialized.rowCount, 0);
  assert.equal(serialized.sha256, createHash('sha256').update('').digest('hex'));
});
