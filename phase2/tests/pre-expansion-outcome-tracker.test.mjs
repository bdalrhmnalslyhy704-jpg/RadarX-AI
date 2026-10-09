import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {
  buildPreExpansionOutcomeReport,
  classifyEvaluationMarketRegime,
  evaluateHistoricalPreExpansionSignal,
  recordPreExpansionSignals,
  updatePreExpansionMarkouts
} from '../core/pre-expansion-outcome-tracker.mjs';

const NOW=1_900_000_000_000;
async function withStore(fn){
  const dir=await mkdtemp(join(tmpdir(),'radarx-preexp-outcomes-'));
  try{const store=await new DurableStore({dir}).init();await fn(store);}
  finally{await rm(dir,{recursive:true,force:true});}
}
function signal({radar='EARLY_EXPANSION_RADAR',symbol='ABCUSDT',stage='PRE_EXPANSION',at=NOW,price=100,move=1.2,metrics={}}={}){
  return {
    id:radar+':'+symbol+':'+stage+':'+at,radar,symbol,price,price_change_24h:move,
    pre_expansion_stage:stage,decision_band:stage,data_quality:88,detected_at:at,
    reason_codes:['HIGHER_LOW_SEQUENCE','VOLUME_PARTICIPATION_IMPROVING'],
    metrics:{price_change_5m_pct:.2,price_change_15m_pct:.5,five_min_resistance:105,...metrics},
    risk_flags:[],closed_candles_only:true,source:'test-public-candle-fixture'
  };
}
function candle(openTime,close,{step=60_000,high=close+.1,low=close-.1,open=close-.02,volume=1000}={}){
  return {openTime,closeTime:openTime+step-1,open,high,low,close,volume,quoteVolume:close*volume,closed:true};
}

test('market regime classifier separates bullish, bearish, and ranging conditions',()=>{
  assert.equal(classifyEvaluationMarketRegime({marketMedianChange24hPct:1.2,marketBreadthPct:70,btcReturn5mPct:.3,btcReturn1hPct:.8}),'BULLISH');
  assert.equal(classifyEvaluationMarketRegime({marketMedianChange24hPct:-1.1,marketBreadthPct:34,btcReturn5mPct:-.4,btcReturn1hPct:-1.2}),'BEARISH');
  assert.equal(classifyEvaluationMarketRegime({marketMedianChange24hPct:.1,marketBreadthPct:51,btcReturn5mPct:.01}),'RANGING');
  assert.equal(classifyEvaluationMarketRegime({}),'UNKNOWN');
});

test('records Radar 8/Radar 9 observations with time, entry, stage, data quality, reasons, and market regime; de-duplicates repeated stages',async()=>{
  await withStore(async store=>{
    const first=await recordPreExpansionSignals(store,[signal({stage:'WATCH_EARLY'})],{
      now:NOW,marketContext:{marketMedianChange24hPct:1,marketBreadthPct:65,btcReturn5mPct:.3}
    });
    assert.deepEqual(first,{recorded:1,skipped:0});
    const duplicate=await recordPreExpansionSignals(store,[signal({stage:'WATCH_EARLY',at:NOW+30_000})],{now:NOW+30_000});
    assert.equal(duplicate.recorded,0);
    const promotion=await recordPreExpansionSignals(store,[signal({stage:'PRE_EXPANSION',at:NOW+60_000})],{now:NOW+60_000});
    const otherRadar=await recordPreExpansionSignals(store,[signal({radar:'FALCON_EYE_RADAR',stage:'PRE_EXPANSION',at:NOW+60_000})],{now:NOW+60_000});
    assert.equal(promotion.recorded,1);
    assert.equal(otherRadar.recorded,1);
    const state=await store.getPreExpansionOutcomes();
    assert.equal(state.records.length,3);
    const r8=state.records.find(x=>x.radar==='RADAR_8'&&x.signal_type==='WATCH_EARLY');
    assert.equal(r8.entry_price,100);
    assert.equal(r8.detected_at,NOW);
    assert.equal(r8.data_quality,88);
    assert.deepEqual(r8.reason_codes,['HIGHER_LOW_SEQUENCE','VOLUME_PARTICIPATION_IMPROVING']);
    assert.equal(r8.market_regime,'BULLISH');
    assert.equal(state.records.find(x=>x.radar==='RADAR_9').radar,'RADAR_9');
  });
});

test('live markouts sample six horizons and detect a sampled resistance rejection',async()=>{
  await withStore(async store=>{
    const at=NOW+100_000;
    await recordPreExpansionSignals(store,[signal({stage:'BREAKOUT_DEVELOPING',at,metrics:{five_min_resistance:105}})],{now:at});
    let r=await updatePreExpansionMarkouts(store,[{symbol:'ABCUSDT',lastPrice:106}],{now:at+30_000});
    assert.equal(r.updated,1);
    r=await updatePreExpansionMarkouts(store,[{symbol:'ABCUSDT',lastPrice:106.2}],{now:at+5*60_000+30_000});
    assert.equal(r.updated,1);
    r=await updatePreExpansionMarkouts(store,[{symbol:'ABCUSDT',lastPrice:99.6}],{now:at+7*60_000});
    r=await updatePreExpansionMarkouts(store,[{symbol:'ABCUSDT',lastPrice:104.5}],{now:at+8*60_000});
    const state=await store.getPreExpansionOutcomes(),item=state.records[0];
    assert.equal(item.marks['5m'].sample_quality,'NEAR_TARGET');
    assert.ok(item.marks['5m'].return_pct>6);
    assert.equal(item.false_breakout,true);
    assert.equal(item.false_breakout_basis,'SAMPLED_SPOT_PRICE_REJECTION');
    assert.ok(item.max_favorable_pct>=6);
    assert.ok(item.max_adverse_pct<=0);
    assert.ok(item.max_adverse_pct>=-.5);
    assert.ok(item.observations>=3);
  });
});

test('missing daily change is recorded as data-insufficient, not as a successful early signal',async()=>{
  await withStore(async store=>{
    await recordPreExpansionSignals(store,[signal({stage:'DATA_INSUFFICIENT',move:null})],{now:NOW});
    const state=await store.getPreExpansionOutcomes();
    assert.equal(state.records[0].signal_type,'DATA_INSUFFICIENT');
    assert.equal(state.records[0].data_quality,0);
    assert.equal(state.records[0].data_quality_status,'INSUFFICIENT');
    assert.equal(state.records[0].detected_before_move,false);
    assert.equal(state.records[0].entry_price,100);
  });
});

test('historical replay uses closed OHLC candles for markouts, MFE/MAE and false-breakout labeling',()=>{
  const at=NOW,start=at+60_000,one=[],five=[];
  for(let i=0;i<80;i++){
    const close=i<12?100.2:100.2+(i-12)*.12;
    one.push(candle(start+i*60_000,close,{high:i===0?101.2:close+.25,low:i===0?99.7:close-.2,step:60_000}));
  }
  for(let i=0;i<300;i++){
    const close=i<1?100.2:100.2+i*.1;
    five.push(candle(start+i*5*60_000,close,{step:5*60_000,high:i===0?101.2:close+.35,low:i===0?99.6:close-.25}));
  }
  const result=evaluateHistoricalPreExpansionSignal({
    signal_id:'RADAR_8:ABCUSDT:BREAKOUT_DEVELOPING:'+at,
    radar:'RADAR_8',symbol:'ABCUSDT',signal_type:'BREAKOUT_DEVELOPING',
    entry_price:100,detected_at:at,market_regime:'BULLISH',
    resistance_price:100.5,initial_daily_change_pct:1.1,initial_metrics:{return_5m_pct:.2}
  },{candles1m:one,candles5m:five,now:start+25*60*60_000});
  assert.equal(result.ok,true);
  assert.equal(result.record.observed_price_source,'HISTORICAL_CLOSED_OHLC');
  assert.equal(result.record.false_breakout,true);
  assert.equal(result.record.marks['5m'].sample_quality,'HISTORICAL_CLOSED_OHLC');
  assert.ok(result.record.excursions['4h'].max_favorable_pct>3);
  assert.ok(result.record.excursions['4h'].max_adverse_pct<0);
  assert.equal(result.record.outcome_status,'COMPLETE');
});

test('evaluation report separates radar, stage, and market regime and warns on small samples',()=>{
  const at=NOW,start=at+60_000;
  const one=Array.from({length:80},(_,i)=>{
    const close=i<1?100.2:100.2+i*.12;
    return candle(start+i*60_000,close,{high:i===0?101.2:close+.4,low:i===0?99.6:close-.25});
  });
  const five=Array.from({length:300},(_,i)=>{
    const close=i<1?100.2:100.2+i*.1;
    return candle(start+i*5*60_000,close,{step:5*60_000,high:i===0?101.2:close+.4,low:i===0?99.6:close-.25});
  });
  const historical=evaluateHistoricalPreExpansionSignal({
    radar:'RADAR_8',symbol:'ABCUSDT',signal_type:'PRE_EXPANSION',entry_price:100,detected_at:at,market_regime:'BULLISH',
    initial_daily_change_pct:1.1,initial_metrics:{return_5m_pct:.2}
  },{candles1m:one,candles5m:five,now:start+25*60*60_000});
  const report=buildPreExpansionOutcomeReport({version:'PRE_EXPANSION_OUTCOMES_V1',records:[historical.record],now:NOW});
  assert.equal(report.total_records,1);
  assert.equal(report.groups.by_radar.RADAR_8.records,1);
  assert.equal(report.groups.by_stage.PRE_EXPANSION.records,1);
  assert.equal(report.groups.by_market_regime.BULLISH.records,1);
  assert.equal(report.comparison.radar9,null);
  assert.equal(report.groups.by_stage.PRE_EXPANSION.sample_warning,'SMALL_SAMPLE_LESS_THAN_30_MATURED_4H_SIGNALS');
  assert.equal(report.scope.impact_thresholds_pct['4h'],3);
});
