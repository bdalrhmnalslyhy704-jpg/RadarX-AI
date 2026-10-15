import test from 'node:test';
import assert from 'node:assert/strict';
import {assessClosedCandleSeries,assessCandleReadinessSet} from '../core/closed-candle-quality.mjs';

const now=1_800_000_000_000;
const minute=60_000;
function candles(n,intervalMs,{startAt=now-n*intervalMs,closeOffset=intervalMs-1}={}){
  return Array.from({length:n},(_,i)=>{
    const openTime=startAt+i*intervalMs;
    return {openTime,closeTime:openTime+closeOffset,open:100,high:101,low:99,close:100.5,volume:500,closed:true};
  });
}

test('closed-candle guard accepts adequate fresh contiguous candle sequences',()=>{
  const rows=candles(60,minute);
  const result=assessClosedCandleSeries(rows,{now,intervalMs:minute,minCount:60,maxAgeMs:3*minute,label:'TEST_1M'});
  assert.equal(result.ready,true);
  assert.equal(result.status,'READY');
  assert.equal(result.count,60);
  assert.equal(result.gap_count,0);
});

test('closed-candle guard rejects stale candles even when count is sufficient',()=>{
  const rows=candles(60,minute,{startAt:now-90*minute});
  const result=assessClosedCandleSeries(rows,{now,intervalMs:minute,minCount:60,maxAgeMs:3*minute,label:'TEST_1M'});
  assert.equal(result.ready,false);
  assert.equal(result.status,'STALE_DATA');
  assert.equal(result.reason,'TEST_1M_LATEST_CANDLE_STALE');
});

test('closed-candle guard rejects sequence gaps inside the scoring window',()=>{
  const rows=candles(80,minute);
  rows.splice(65,1);
  const result=assessClosedCandleSeries(rows,{now,intervalMs:minute,minCount:60,maxAgeMs:3*minute,label:'TEST_1M'});
  assert.equal(result.ready,false);
  assert.equal(result.status,'INCOMPLETE_DATA');
  assert.equal(result.reason,'TEST_1M_SEQUENCE_HAS_GAPS');
  assert.ok(result.gap_count>0);
});

test('closed-candle guard rejects malformed OHLC and explicit null numeric fields',()=>{
  const rows=candles(60,minute);
  rows[59]={...rows[59],volume:null};
  const result=assessClosedCandleSeries(rows,{now,intervalMs:minute,minCount:60,maxAgeMs:3*minute,label:'TEST_1M'});
  assert.equal(result.ready,false);
  assert.equal(result.status,'INSUFFICIENT_DATA');
  assert.equal(result.count,59);
});

test('readiness set aggregates individual candle defects without upgrading unknown inputs',()=>{
  const good=assessClosedCandleSeries(candles(3,minute),{now,intervalMs:minute,minCount:3,maxAgeMs:3*minute,label:'GOOD'});
  const bad=assessClosedCandleSeries(candles(3,minute,{startAt:now-60*minute}),{now,intervalMs:minute,minCount:3,maxAgeMs:3*minute,label:'BAD'});
  const result=assessCandleReadinessSet({one_minute:good,five_minute:bad});
  assert.equal(result.ready,false);
  assert.equal(result.status,'STALE_DATA');
  assert.equal(result.reason_codes.length,1);
  assert.ok(result.reason_codes[0].startsWith('five_minute:'));
});
