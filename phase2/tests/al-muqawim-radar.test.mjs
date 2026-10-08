import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAlMuqawimAnalysis} from '../core/al-muqawim-radar.mjs';

function makeSeries(count,tfMs,trend=1){
  const now=Date.now();
  const rows=[];
  const pattern=[0,2,1,-1];
  for(let i=0;i<count;i++){
    const close=100+trend*i*0.55+pattern[i%4]*0.9;
    const open=close-0.15;
    rows.push({
      openTime:now-(count-i)*tfMs,
      closeTime:now-(count-i-1)*tfMs,
      open,high:close+0.55,low:close-0.55,close,volume:1000,closed:true
    });
  }
  return rows;
}

test('Al Muqawim confirms aligned bullish multi-timeframe structure',()=>{
  const now=Date.now();
  const series={
    '4h':makeSeries(100,4*60*60*1000,0.04),
    '1h':makeSeries(120,60*60*1000,0.04),
    '15m':makeSeries(160,15*60*1000,0.04)
  };
  const a=buildAlMuqawimAnalysis(series,{symbol:'TESTUSDT',lastPrice:105.46,priceChange24h:1},now,{maPeriod:50});
  assert.equal(a.direction,'UP');
  assert.equal(a.closed_candles_only,true);
  assert.equal(a.eligible,true);
  assert.ok(Number.isFinite(a.entry_timing.score));
  assert.ok(Number.isFinite(a.entry_timing.freshness));
  assert.equal(a.timeframes['4h'].structure.direction,'UP');
  assert.equal(a.timeframes['1h'].moving_average.direction.startsWith('UP'),true);
});

test('Al Muqawim flags a lower-timeframe conflict',()=>{
  const now=Date.now();
  const series={
    '4h':makeSeries(100,4*60*60*1000,1),
    '1h':makeSeries(120,60*60*1000,1),
    '15m':makeSeries(160,15*60*1000,-1)
  };
  const a=buildAlMuqawimAnalysis(series,{symbol:'TESTUSDT',lastPrice:90},now,{maPeriod:50});
  assert.equal(a.direction,'UP');
  assert.equal(a.entry_risk,'AGAINST_HTF_TREND');
  assert.equal(a.eligible,false);
});


test('Al Muqawim rejects a technically bullish but already-extended entry',()=>{
  const now=Date.now();
  const series={
    '4h':makeSeries(100,4*60*60*1000,1),
    '1h':makeSeries(120,60*60*1000,1),
    '15m':makeSeries(160,15*60*1000,1)
  };
  const a=buildAlMuqawimAnalysis(series,{symbol:'TESTUSDT',lastPrice:105.46,priceChange24h:12},now,{maPeriod:50});
  assert.equal(a.direction,'UP');
  assert.equal(a.eligible,false);
  assert.ok(a.reasons.some(x=>String(x).includes('ممتدة')));
});
