import test from 'node:test';
import assert from 'node:assert/strict';
import {assessDataGate,assessLiquidity,latestClosed} from '../core/data-quality.mjs';
import {series,incompleteSeries,TEST_FIXTURE} from './fixtures.mjs';

test('TEST_FIXTURE: incomplete candle is not selected as latest completed candle',()=>{
  const a=incompleteSeries('15m');assert.equal(latestClosed(a).closed,true);assert.equal(latestClosed(a).openTime,a[a.length-2].openTime);
});

test('TEST_FIXTURE: future data blocks signal eligibility',()=>{
  const now=1700000000000, a=series('15m',30,now-30*900000);a.push({...a.at(-1),openTime:now+900000,closeTime:now+900000+899999,closed:false});
  const g=assessDataGate({series4h:series('4h',30,now-30*14400000),series1h:series('1h',30,now-30*3600000),series15m:a,now,sourceLive:true});
  assert.equal(g.allowed,false);assert.ok(g.blocked.includes('FUTURE_DATA'));
});

test('TEST_FIXTURE: delayed trigger data blocks signal',()=>{
  const now=1701000000000;
  const g=assessDataGate({series4h:series('4h'),series1h:series('1h'),series15m:series('15m'),now,sourceLive:true,maxStaleTriggerMs:60000});
  assert.equal(g.allowed,false);assert.ok(g.blocked.includes('STALE_DATA'));
});

test('TEST_FIXTURE: gap blocks signal until repaired',()=>{
  const now=1700000000000,a=series('15m',30,now-30*900000);a.splice(10,1);
  const g=assessDataGate({series4h:series('4h',30,now-30*14400000),series1h:series('1h',30,now-30*3600000),series15m:a,now,sourceLive:true});
  assert.equal(g.allowed,false);assert.ok(g.blocked.includes('UNRESOLVED_GAP')===false);assert.ok(g.blocked.includes('SERIES_INTEGRITY_FAILURE'));
});

test('TEST_FIXTURE: low liquidity prevents notification eligibility',()=>{
  const result=assessLiquidity({book:{bids:[['100','1']],asks:[['100.5','1']]},ticker24h:{quoteVolume:'1000',count:1},minQuality:60});
  assert.equal(result.allowed,false);assert.ok(result.reasons.includes('LOW_LIQUIDITY')||result.reasons.includes('WIDE_SPREAD'));
});
