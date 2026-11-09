import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_EARLY_RISER_OUTCOME_SOURCE,
  DAILY_EARLY_RISER_HORIZON_BARS,
  classifyDailyEarlyRiserFirstPassage,
  classifyDailyEarlyRiserTargetSet,
  buildDailyEarlyRiserHistoricalSamples
} from '../core/daily-early-riser-census.mjs';

const INTERVAL=15*60*1000;
const FIVE=5*60*1000;

function candle(openTime,{
  open=100,high=100.2,low=99.8,close=100,
  quoteVolume=300_000,trades=1800,buyShare=0.55,interval=INTERVAL
}={}){
  return {
    openTime,open,high,low,close,closeTime:openTime+interval-1,
    quoteVolume,trades,takerBuyQuoteVolume:quoteVolume*buyShare
  };
}
function pathAfter(baseline,mutate=()=>{}){
  return Array.from({length:DAILY_EARLY_RISER_HORIZON_BARS},(_,index)=>{
    const openTime=baseline.closeTime+1+index*INTERVAL;
    const row=candle(openTime);
    return mutate(row,index)||row;
  });
}
function baselineCandle(){
  return candle(1_700_000_000_000);
}

test('daily +5% first passage is resolved only when it precedes the -2% adverse barrier',()=>{
  const baseline=baselineCandle();
  const future=pathAfter(baseline,(row,index)=>index===19
    ?{...row,high:105.1,low:99.2,close:104.8}:row);
  const result=classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:future,targetPct:5,adversePct:2
  });
  assert.equal(result.status,'RESOLVED');
  assert.equal(result.outcome,'UP');
  assert.equal(result.first_touch_index,19);
  assert.equal(result.time_to_first_touch_minutes,300);
  assert.equal(result.outcome_source,DAILY_EARLY_RISER_OUTCOME_SOURCE);
  assert.equal(result.horizon_bars,96);
});

test('daily first passage labels an earlier adverse barrier as DOWN',()=>{
  const baseline=baselineCandle();
  const future=pathAfter(baseline,(row,index)=>index===3
    ?{...row,low:97.9,high:101.1,close:98.2}:row);
  const result=classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:future,targetPct:5,adversePct:2
  });
  assert.equal(result.status,'RESOLVED');
  assert.equal(result.outcome,'DOWN');
  assert.equal(result.first_touch_index,3);
});

test('same 15m candle touching both target and adverse barrier is ambiguous, never a win',()=>{
  const baseline=baselineCandle();
  const future=pathAfter(baseline,(row,index)=>index===7
    ?{...row,high:105.5,low:97.5,close:101}:row);
  const result=classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:future,targetPct:5,adversePct:2
  });
  assert.equal(result.status,'AMBIGUOUS');
  assert.equal(result.outcome,'AMBIGUOUS');
  assert.equal(result.reason,'TARGET_AND_ADVERSE_BARRIER_TOUCHED_IN_SAME_15M_CANDLE');
});

test('daily first passage rejects a missing candle or a path gap instead of inventing a label',()=>{
  const baseline=baselineCandle();
  const complete=pathAfter(baseline);
  const gap=complete.map((row,index)=>index===12
    ?{...row,openTime:row.openTime+INTERVAL,closeTime:row.closeTime+INTERVAL}:row);
  assert.equal(classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:complete.slice(0,95),targetPct:5
  }).reason,'INCOMPLETE_24H_PATH');
  assert.equal(classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:gap,targetPct:5
  }).reason,'FUTURE_CANDLE_GAP_OR_BAD_CLOSE_TIME');
});

test('multi-target labels are resolved independently without collapsing +5%, +10% and +15%',()=>{
  const baseline=baselineCandle();
  const future=pathAfter(baseline,(row,index)=>index===11
    ?{...row,high:106,low:99,close:105.5}:row);
  const result=classifyDailyEarlyRiserTargetSet({
    baseline,future15m:future,targetsPct:[5,10,15],adversePct:2
  });
  assert.equal(result.targets.plus_5_pct.outcome,'UP');
  assert.equal(result.targets.plus_10_pct.outcome,'FLAT');
  assert.equal(result.targets.plus_15_pct.outcome,'FLAT');
  assert.equal(result.status,'RESOLVED');
});

test('historical daily census uses closed baseline features, one non-overlapping anchor per day, and future-only labels',()=>{
  const count=1800;
  const base=Math.floor(1_700_000_000_000/INTERVAL)*INTERVAL;
  const fifteen=Array.from({length:count},(_,index)=>candle(base+index*INTERVAL));
  const fast=Array.from({length:count*3},(_,index)=>candle(base+index*FIVE,{
    interval:FIVE,quoteVolume:100_000,trades:600,high:100.1,low:99.9
  }));
  const btc=Array.from({length:count},(_,index)=>candle(base+index*INTERVAL,{
    quoteVolume:2_000_000,trades:12_000
  }));
  const now=base+count*INTERVAL+60_000;
  const result=buildDailyEarlyRiserHistoricalSamples({
    symbol:'CENSUSUSDT',
    klines:{data:fifteen,source:'BINANCE_OFFICIAL_ARCHIVE'},
    fastKlines:{data:fast,source:'BINANCE_OFFICIAL_ARCHIVE'},
    btcKlines:{data:btc,source:'BINANCE_OFFICIAL_ARCHIVE'},
    now,minQuoteVolume24h:750_000,maxSamplesPerSymbol:40
  });
  assert.equal(result.audit.status,'READY');
  assert.ok(result.samples.length>=8);
  assert.equal(result.audit.non_overlapping_24h_labels,true);
  assert.equal(result.audit.overlap_violations,0);
  assert.ok(result.samples.every(row=>row.at<row.targets.plus_5_pct.resolved_at));
  assert.ok(result.samples.every(row=>row.feature_information_cutoff_at===row.at));
  assert.ok(result.samples.every(row=>row.outcome_source===DAILY_EARLY_RISER_OUTCOME_SOURCE));
  assert.ok(result.samples.every(row=>row.targets.plus_5_pct.outcome==='FLAT'));
  assert.ok(result.samples.every(row=>row.targets.plus_10_pct.outcome==='FLAT'));
  assert.ok(result.samples.every(row=>row.targets.plus_15_pct.outcome==='FLAT'));
  assert.ok(result.samples.every(row=>row.features&&Number.isFinite(row.base_score)));
  assert.ok(result.samples.every(row=>row.temporal_sequence_available===true),
    'complete official 5m history should support the 24x29 temporal tensor');
});
