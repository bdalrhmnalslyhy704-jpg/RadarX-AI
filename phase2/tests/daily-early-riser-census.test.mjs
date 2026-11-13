import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_EARLY_RISER_OUTCOME_SOURCE,
  DAILY_EARLY_RISER_HORIZON_BARS,
  classifyDailyEarlyRiserFirstPassage,
  classifyDailyEarlyRiserTargetSet,
  classifyDailyEarlyRiserEventualTouch,
  classifyDailyEarlyRiserEventualTargetSet,
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

test('a later daily surge remains a market-move event after the adverse barrier was already hit',()=>{
  const baseline=baselineCandle();
  const future=pathAfter(baseline,(row,index)=>{
    if(index===3)return {...row,low:97.8,high:100.5,close:98.1};
    if(index===38)return {...row,low:99,high:106,close:105.2};
    return row;
  });
  const result=classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:future,targetPct:5,adversePct:2
  });
  assert.equal(result.status,'RESOLVED');
  assert.equal(result.outcome,'DOWN',
    'tradeable first-passage outcome remains DOWN because the adverse barrier came first');
  assert.equal(result.market_move_event.status,'RESOLVED');
  assert.equal(result.market_move_event.outcome,'UP',
    'the daily census must still count the later +5% market move');
  assert.equal(result.market_move_event.target_touch_after_adverse_barrier,true);
  assert.equal(result.market_move_event.first_touch_index,38);
});

test('same-bar target and adverse touch is ambiguous for tradeability but still confirms a market move',()=>{
  const baseline=baselineCandle();
  const future=pathAfter(baseline,(row,index)=>index===8
    ?{...row,high:106,low:97,close:100}:row);
  const result=classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:future,targetPct:5,adversePct:2
  });
  assert.equal(result.status,'AMBIGUOUS');
  assert.equal(result.market_move_event.outcome,'UP');
  assert.equal(result.market_move_event.target_and_adverse_touched_same_15m_candle,true);
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
  assert.equal(result.market_move_event.outcome,'FLAT',
    'an adverse-first path with no later target touch is not a daily gainer event');
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
  const fifteen=Array.from({length:count},(_,index)=>{
    const price=100+index*0.01;
    return candle(base+index*INTERVAL,{open:price,high:price+0.2,low:price-0.2,close:price});
  });
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
  assert.ok(result.samples.length>=8,JSON.stringify(result.audit));
  assert.equal(result.audit.non_overlapping_24h_labels,true);
  assert.equal(result.audit.overlap_violations,0);
  assert.ok(result.samples.every(row=>row.at<row.targets.plus_5_pct.resolved_at));
  assert.ok(result.samples.every(row=>row.feature_information_cutoff_at===row.at));
  assert.ok(result.samples.every(row=>row.outcome_source===DAILY_EARLY_RISER_OUTCOME_SOURCE));
  assert.ok(result.samples.every(row=>row.targets.plus_5_pct.outcome==='FLAT'));
  assert.ok(result.samples.every(row=>row.targets.plus_10_pct.outcome==='FLAT'));
  assert.ok(result.samples.every(row=>row.targets.plus_15_pct.outcome==='FLAT'));
  assert.ok(result.samples.every(row=>row.features&&Number.isFinite(row.base_score)));
  for(const sample of result.samples){
    const index=fifteen.findIndex(row=>row.closeTime===sample.at);
    assert.ok(index>=96,'sample has an exact 24h prior close');
    const expected=(fifteen[index].close/fifteen[index-96].close-1)*100;
    assert.ok(Math.abs(sample.daily_change_pct-expected)<1e-5,
      '24h return must compare prices exactly 96 closed 15m bars apart');
  }
  assert.ok(result.samples.every(row=>row.temporal_sequence_available===true),
    'complete official 5m history should support the 24x29 temporal tensor');
});


test('eventual multi-horizon label preserves a later INIT-like rise while keeping the earlier drawdown as risk',()=>{
  const baseline=baselineCandle();
  const future=Array.from({length:288},(_,index)=>{
    const row=candle(baseline.closeTime+1+index*INTERVAL);
    if(index===2)return {...row,high:100.3,low:97.7,close:98.1};
    if(index===150)return {...row,open:104,high:111,low:101,close:109.5};
    return row;
  });
  const events=classifyDailyEarlyRiserEventualTargetSet({
    baseline,future15m:future,targetsPct:[5,10],horizonsHours:[24,48,72],adversePct:2
  });
  assert.equal(events.status,'RESOLVED');
  assert.equal(events.targets.plus_10_pct['24h'].outcome,'FLAT');
  assert.equal(events.targets.plus_10_pct['48h'].outcome,'UP');
  assert.equal(events.targets.plus_10_pct['72h'].outcome,'UP');
  const later=events.targets.plus_10_pct['72h'];
  assert.equal(later.adverse_before_target,true);
  assert.equal(later.target_touch_after_adverse_barrier,true);
  assert.equal(later.target_vs_adverse_order,'ADVERSE_FIRST');
  assert.ok(later.max_adverse_excursion_pct<=-2);
  assert.ok(later.time_to_target_minutes>24*60/4);
  const oldTradeable=classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:future.slice(0,96),targetPct:10,adversePct:2
  });
  assert.equal(oldTradeable.outcome,'DOWN',
    'the legacy first-passage tradeability label remains separate and unchanged');
});

test('eventual upside label fails closed on incomplete or gapped 72h paths',()=>{
  const baseline=baselineCandle();
  const full=Array.from({length:288},(_,index)=>candle(
    baseline.closeTime+1+index*INTERVAL));
  assert.equal(classifyDailyEarlyRiserEventualTouch({
    baseline,future15m:full.slice(0,287),targetPct:5,horizonHours:72
  }).reason,'INCOMPLETE_24H_PATH');
  const gap=full.map((row,index)=>index===50
    ?{...row,openTime:row.openTime+INTERVAL,closeTime:row.closeTime+INTERVAL}:row);
  assert.equal(classifyDailyEarlyRiserEventualTouch({
    baseline,future15m:gap,targetPct:5,horizonHours:72
  }).reason,'FUTURE_CANDLE_GAP_OR_BAD_CLOSE_TIME');
});

test('isolated Micro census accepts only the bounded 100k-to-750k quote-volume lane and non-overlapping 72h labels',()=>{
  const count=1800;
  const base=Math.floor(1_700_000_000_000/INTERVAL)*INTERVAL;
  const fifteen=Array.from({length:count},(_,index)=>{
    const price=100+index*0.001;
    return candle(base+index*INTERVAL,{
      open:price,high:price+0.2,low:price-0.2,close:price,
      quoteVolume:5000,trades:80,buyShare:0.56
    });
  });
  const fast=Array.from({length:count*3},(_,index)=>{
    const price=100+Math.floor(index/3)*0.001;
    return candle(base+index*FIVE,{
      interval:FIVE,open:price,high:price+0.08,low:price-0.08,close:price,
      quoteVolume:1666.67,trades:27,buyShare:0.56
    });
  });
  const btc=Array.from({length:count},(_,index)=>{
    const price=30000+index*0.01;
    return candle(base+index*INTERVAL,{
      open:price,high:price+3,low:price-3,close:price,
      quoteVolume:500000,trades:6000,buyShare:0.5
    });
  });
  const now=base+count*INTERVAL+60000;
  const result=buildDailyEarlyRiserHistoricalSamples({
    symbol:'MICROTESTUSDT',
    klines:{data:fifteen,source:'BINANCE_OFFICIAL_ARCHIVE'},
    fastKlines:{data:fast,source:'BINANCE_OFFICIAL_ARCHIVE'},
    btcKlines:{data:btc,source:'BINANCE_OFFICIAL_ARCHIVE'},
    now,minQuoteVolume24h:100000,maxSamplesPerSymbol:40,
    sampleStrideBars:288,extendedEventLabels:true,liquidityLane:'MICRO'
  });
  assert.equal(result.audit.status,'READY',JSON.stringify(result.audit));
  assert.ok(result.samples.length>=3);
  assert.equal(result.audit.extended_event_labels,true);
  assert.equal(result.audit.liquidity_lane,'MICRO');
  assert.equal(result.audit.minimum_anchor_gap_ms,72*60*60*1000);
  assert.ok(result.samples.every(row=>row.liquidity_lane==='MICRO'));
  assert.ok(result.samples.every(row=>row.quote_volume_24h>=100000&&row.quote_volume_24h<750000));
  assert.ok(result.samples.every(row=>row.eventual_targets?.plus_5_pct?.['72h']?.status==='RESOLVED'));
  assert.ok(result.samples.every((row,index)=>index===0||
    row.at-result.samples[index-1].at>=72*60*60*1000));
});

test('malformed future OHLC candles are rejected even when timestamps and numbers are finite',()=>{
  const baseline=baselineCandle();
  const future=pathAfter(baseline,(row,index)=>index===2?{...row,high:99.5}:row);
  const result=classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:future,targetPct:5,adversePct:2
  });
  assert.equal(result.status,'INVALID');
  assert.equal(result.reason,'INVALID_FUTURE_CANDLE');
});
