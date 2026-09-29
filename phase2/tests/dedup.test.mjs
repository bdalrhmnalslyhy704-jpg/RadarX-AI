import test from './test-helpers.mjs';
import assert from 'node:assert/strict';
import {SignalDeduplicator} from '../core/dedup.mjs';

const signal={symbol:'BTCUSDT',direction:'LONG',reason_codes:['CLOSE_ABOVE_RANGE','RVOL_OK'],candle:{timeframe:'15m',close_time:1700000000000}};

test('TEST_FIXTURE: duplicate key is blocked within the same time window',async()=>{
  const d=new SignalDeduplicator({windowMs:900000});
  assert.equal((await d.canEmit(signal,1700000001000)).allowed,true);
  await d.markEmitted(signal,1700000001000);
  const again=await d.canEmit({...signal,reason_codes:['RVOL_OK','CLOSE_ABOVE_RANGE']},1700000002000);
  assert.equal(again.allowed,false);assert.equal(again.reason,'DUPLICATE_SIGNAL');
});

test('TEST_FIXTURE: different reason or window can emit',async()=>{
  const d=new SignalDeduplicator({windowMs:900000});
  await d.markEmitted(signal,1700000000000);
  assert.equal((await d.canEmit({...signal,reason_codes:['OTHER_REASON']},1700000001000)).allowed,true);
  assert.equal((await d.canEmit(signal,1700000900000)).allowed,true);
});
