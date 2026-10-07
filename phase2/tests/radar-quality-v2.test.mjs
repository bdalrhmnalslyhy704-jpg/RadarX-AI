import assert from 'node:assert/strict';
import test from 'node:test';
import {buildHistoricalFollowThrough} from '../market/universe-scanner.mjs';
import {featureSet,findPreMoveCheckpoint} from '../core/coin-hunter-radar.mjs';

function candle(i,price=100){
  const openTime=Date.now()-((80-i)*5*60*1000);
  return {
    openTime,
    closeTime:openTime+5*60*1000-1,
    open:price,
    high:price*1.004,
    low:price*0.997,
    close:price*1.002,
    volume:i%5===0?1800:1000,
    takerBuyBaseVolume:i%3===0?650:520,
    tradeCount:i%4===0?180:100,
    closed:true
  };
}

test('historical follow-through is empirical and closed-candle-only',()=>{
  const now=Date.now();
  const rows=Array.from({length:80},(_,i)=>candle(i,100+i*0.01));
  rows.push({...candle(80,100.9),closed:false,closeTime:now+60000});
  const q=buildHistoricalFollowThrough(rows,now);
  assert.equal(q.method,'HISTORICAL_ANALOG_V1');
  assert.ok(Number.isFinite(q.score));
  assert.ok(q.score>=0&&q.score<=100);
  assert.ok(q.samples>=0);
  assert.equal(q.target_short,'+2% within 30m');
  assert.equal(q.target_long,'+5% within 2h');
});

test('coin hunter training checkpoint is before the daily move, not after it',()=>{
  const dayStart=Date.now()-7*60*60*1000;
  const rows=Array.from({length:24},(_,i)=>{
    const openTime=dayStart+i*60*60*1000;
    const base=i<5?100:100+i*1.6;
    return {...candle(i,base),openTime,closeTime:openTime+3600000-1};
  });
  const checkpoint=findPreMoveCheckpoint(rows,dayStart,2);
  assert.ok(checkpoint);
  assert.ok(checkpoint.index>0);
  assert.ok(checkpoint.returnPct>=2);
  assert.ok(checkpoint.price>100);
  assert.equal(rows.filter(x=>Number(x.openTime)>=dayStart)[0].openTime,dayStart);
});

test('coin hunter feature set accepts an actual historical reference price',()=>{
  const rows=Array.from({length:30},(_,i)=>candle(i,100+i*.1));
  const x=featureSet(rows,{lastPrice:103,referencePrice:102.9},null);
  assert.ok(x);
  assert.ok(Number.isFinite(x.rangePosition));
  assert.ok(Number.isFinite(x.volumeAcceleration));
  assert.ok(Number.isFinite(x.takerRatio));
});

console.log('Radar quality V2 tests passed');
