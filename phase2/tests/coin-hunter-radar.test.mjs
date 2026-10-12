import test from 'node:test';
import assert from 'node:assert/strict';
import {assessCoinHunterSeries,closedCandles,featureSet} from '../core/coin-hunter-radar.mjs';

const NOW=1700000000000;
const HOUR=60*60*1000;
const FIFTEEN=15*60*1000;

function makeCandles(count,intervalMs,now=NOW,ageMs=10_000){
  const lastClose=now-ageMs;
  return Array.from({length:count},(_,i)=>{
    const closeTime=lastClose-(count-1-i)*intervalMs;
    const openTime=closeTime-intervalMs+1;
    const close=100+i*.15;
    const volume=1000+i*10;
    return {openTime,closeTime,open:close-.2,high:close+.4,low:close-.5,close,volume,
      tradeCount:80+i,takerBuyBaseVolume:volume*.56,closed:true};
  });
}

test('Coin Hunter only uses valid closed candles in chronological order',()=>{
  const rows=makeCandles(30,HOUR).reverse();
  rows.push({...rows[0],openTime:null,closeTime:NOW,open:null});
  rows.push({...rows[0],openTime:NOW+HOUR,closeTime:NOW+2*HOUR});
  const closed=closedCandles(rows,NOW);
  assert.equal(closed.length,30);
  assert.ok(closed.every((c,i)=>i===0||Number(c.openTime)>Number(closed[i-1].openTime)));
  assert.ok(closed.every(c=>Number(c.close)>0&&Number(c.volume)>=0));
});

test('Coin Hunter rejects stale candles and differentiates insufficient history',()=>{
  const stale=assessCoinHunterSeries(makeCandles(40,HOUR,NOW,4*HOUR),{now:NOW,intervalMs:HOUR,minCount:16});
  assert.equal(stale.eligible,false);
  assert.equal(stale.data_status,'DATA_STALE');
  assert.equal(stale.data_stale,true);

  const short=assessCoinHunterSeries(makeCandles(8,HOUR,NOW),{now:NOW,intervalMs:HOUR,minCount:16});
  assert.equal(short.eligible,false);
  assert.equal(short.data_status,'DATA_INSUFFICIENT');
  assert.equal(short.data_stale,false);
});

test('Coin Hunter blocks gaps and missing trade/taker evidence',()=>{
  const gapRows=makeCandles(40,HOUR);
  gapRows.splice(25,1);
  const gap=assessCoinHunterSeries(gapRows,{now:NOW,intervalMs:HOUR,minCount:16});
  assert.equal(gap.eligible,false);
  assert.equal(gap.data_status,'DATA_GAP');

  const weakRows=makeCandles(40,HOUR).map(({tradeCount,takerBuyBaseVolume,...row})=>row);
  const weak=assessCoinHunterSeries(weakRows,{now:NOW,intervalMs:HOUR,minCount:16});
  assert.equal(weak.eligible,false);
  assert.equal(weak.data_status,'DATA_QUALITY_LOW');
  assert.equal(weak.data_quality,50);
});

test('Coin Hunter ignores null OHLCV instead of treating null as numeric zero',()=>{
  const rows=makeCandles(30,FIFTEEN);
  rows[10]={...rows[10],close:null};
  const result=assessCoinHunterSeries(rows,{now:NOW,intervalMs:FIFTEEN,minCount:16});
  assert.equal(result.eligible,false);
  assert.ok(['DATA_GAP','DATA_QUALITY_LOW'].includes(result.data_status));
});

test('Coin Hunter feature extraction supports a deterministic as-of clock',()=>{
  const rows=makeCandles(60,HOUR,NOW,10_000);
  const features=featureSet(rows,{lastPrice:109,referencePrice:109},0,NOW);
  assert.ok(features);
  assert.equal(features.candle_count,60);
});
