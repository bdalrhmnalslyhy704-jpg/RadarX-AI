import test from 'node:test';
import assert from 'node:assert/strict';
import {assessDataGate,assessLiquidity,latestClosed,futureIssues,timestampUnit,normalizeEpochMs,FUTURE_DATA_CLOCK_SKEW_MS,DATA_STATUS} from '../core/data-quality.mjs';
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


test('TEST_FIXTURE: current open candle is not future data and is not the analysis candle',()=>{
  const now=1700000000000;
  const makeSeries=(tf,count,lastClose)=>{
    const step=tf==='4h'?14400000:tf==='1h'?3600000:900000;
    const lastOpen=lastClose-step+1;
    return Array.from({length:count},(_,i)=>{
      const openTime=lastOpen-(count-1-i)*step;
      return {openTime,closeTime:openTime+step-1,open:100,high:101,low:99,close:100,volume:1000,closed:true};
    });
  };
  const closed15m={openTime:now-900000,closeTime:now-1,open:100,high:101,low:99,close:100,volume:1000,closed:true};
  const open={openTime:now,closeTime:now+899999,open:100,high:102,low:98,close:101,volume:2000,closed:false};
  assert.deepEqual(futureIssues([closed15m,open],now),[]);
  assert.equal(latestClosed([closed15m,open]),closed15m);
  const g=assessDataGate({
    series4h:makeSeries('4h',30,now-1),
    series1h:makeSeries('1h',30,now-1),
    series15m:[...makeSeries('15m',30,now-1),open],
    now,sourceLive:true
  });
  assert.equal(g.allowed,true);
  assert.equal(g.quality>0,true);
});

test('TEST_FIXTURE: real future candle is rejected without bypassing the gate',()=>{
  const now=1700000000000;
  const future={openTime:now+900000,closeTime:now+1799999,open:100,high:101,low:99,close:100,volume:1000,closed:false};
  assert.deepEqual(futureIssues([future],now),['FUTURE_OPEN_0']);
  const base=series('15m',30,now-30*900000);
  const g=assessDataGate({
    series4h:series('4h',30,now-30*14400000),
    series1h:series('1h',30,now-30*3600000),
    series15m:[...base,future],
    now,sourceLive:true
  });
  assert.equal(g.allowed,false);
  assert.equal(g.quality,0);
  assert.ok(g.blocked.includes('FUTURE_DATA'));
});


test('TEST_FIXTURE: data gate classifies live, partial, stale, unavailable and offline without weakening the gate',()=>{
  const now=1700000000000;
  const base={
    series4h:series('4h',30,now-30*14400000),
    series1h:series('1h',30,now-30*3600000),
    series15m:series('15m',30,now-30*900000),
    now,sourceLive:true
  };
  assert.equal(assessDataGate(base).status,DATA_STATUS.LIVE);

  const gap=[...base.series15m];gap.splice(10,1);
  assert.equal(assessDataGate({...base,series15m:gap}).status,DATA_STATUS.PARTIAL);

  const staleNow=now+60*60*1000;
  assert.equal(assessDataGate({...base,now:staleNow,maxStaleTriggerMs:60000}).status,DATA_STATUS.STALE);

  assert.equal(assessDataGate({...base,series15m:[],minDataQuality:0}).status,DATA_STATUS.UNAVAILABLE);
  assert.equal(assessDataGate({...base,now:staleNow,maxStaleTriggerMs:60000,sourceLive:false}).status,DATA_STATUS.STALE);
  assert.equal(assessDataGate({...base,sourceLive:false}).status,DATA_STATUS.OFFLINE);
  assert.equal(assessDataGate({...base,series15m:[],sourceLive:false}).status,DATA_STATUS.OFFLINE);

  assert.equal(assessDataGate({...base,sourceLive:false}).allowed,false);
  assert.equal(assessDataGate({...base,series15m:gap}).allowed,false);
});

test('TEST_FIXTURE: timestamp units are explicit; seconds are rejected and milliseconds are accepted',()=>{
  assert.equal(timestampUnit(1700000000),'SECONDS');
  assert.equal(timestampUnit(1700000000000),'MILLISECONDS');
  assert.throws(()=>normalizeEpochMs(1700000000,'openTime'),/openTime_TIMESTAMP_UNIT_SECONDS/);
  assert.equal(normalizeEpochMs(1700000000000,'openTime'),1700000000000);
});

test('TEST_FIXTURE: small declared clock skew tolerance does not turn normal open candle into future data',()=>{
  const now=1700000000000;
  const openTime=now+FUTURE_DATA_CLOCK_SKEW_MS-1;
  const closeTime=openTime+899999;
  const open={openTime,closeTime,open:100,high:101,low:99,close:100,volume:1000,closed:false};
  assert.deepEqual(futureIssues([open],now),[]);
  assert.ok(FUTURE_DATA_CLOCK_SKEW_MS>0 && FUTURE_DATA_CLOCK_SKEW_MS<=10000);
});
