import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RADAR_OUTCOME_ARCHIVES,
  RADAR_OUTCOME_HORIZONS,
  normalizeArchivedRadarSignal,
  emptyRadarSignalOutcomeState,
  evaluateRadarOutcomeHorizon,
  buildRadarSignalOutcomeReport,
  runRadarSignalOutcomePass
} from '../core/radar-signal-outcomes.mjs';

const BASE = 1_800_000_000_000;
const minute = 60_000;
function candle(openTime, intervalMs, {open=100,high=101,low=99,close=100.5,closed=true}={}) {
  return {openTime,closeTime:openTime+intervalMs-1,open,high,low,close,volume:100,closed};
}
function completeOutcome() {
  return {
    status:'COMPLETE',source:'BINANCE_PUBLIC_CLOSED_OHLC',sample_quality:'HISTORICAL_CLOSED_OHLC',
    close_return_pct:1,max_favorable_pct:4,max_adverse_pct:-1,
    hit_1pct_at:{at:BASE+1000},hit_3pct_at:{at:BASE+2000},hit_5pct_at:null,hit_10pct_at:null
  };
}

test('all twelve radar alert archives have explicit reader mappings',()=>{
  assert.equal(RADAR_OUTCOME_ARCHIVES.length,12);
  assert.equal(new Set(RADAR_OUTCOME_ARCHIVES.map(x=>x.id)).size,12);
  assert.ok(RADAR_OUTCOME_ARCHIVES.every(x=>x.reader&&x.archive&&x.name));
  assert.equal(RADAR_OUTCOME_HORIZONS.length,6);
});

test('archive normalization never substitutes missing price or timestamp with zero',()=>{
  const now=BASE+30*minute;
  const good=normalizeArchivedRadarSignal({
    id:'alert-1',symbol:'ABCUSDT',detected_at:BASE,processed_at:BASE+1000,price:'0.5',stage:'PRE_EXPANSION'
  },'RADAR_9',now);
  assert.equal(good.baseline_status,'COMPLETE');
  assert.equal(good.entry_price,0.5);
  assert.equal(good.detected_at,BASE);

  const missing=normalizeArchivedRadarSignal({
    id:'alert-2',symbol:'ABCUSDT',detected_at:null,processed_at:null,price:null,stage:'WATCH_EARLY'
  },'RADAR_9',now);
  assert.equal(missing.baseline_status,'INCOMPLETE');
  assert.equal(missing.entry_price,null);
  assert.equal(missing.detected_at,null);
  assert.ok(missing.baseline_missing_reasons.includes('ENTRY_PRICE_MISSING'));
  assert.ok(missing.baseline_missing_reasons.includes('SIGNAL_TIMESTAMP_MISSING'));
});

test('horizon outcomes use complete closed candles and report OHLC excursions without claiming exact trade times',()=>{
  const detectedAt=BASE;
  const horizon=RADAR_OUTCOME_HORIZONS.find(x=>x.key==='5m');
  const now=detectedAt+horizon.ms+horizon.intervalMs+minute;
  const record={detected_at:detectedAt,entry_price:100};
  const rows=Array.from({length:5},(_,i)=>candle(detectedAt+i*minute,minute,{
    open:100,high:i===2?104:101,low:i===3?98:99,close:i===4?102:100.5
  }));
  const outcome=evaluateRadarOutcomeHorizon(record,rows,horizon,now);
  assert.equal(outcome.status,'COMPLETE');
  assert.equal(outcome.sample_quality,'HISTORICAL_CLOSED_OHLC');
  assert.equal(outcome.expected_bars,5);
  assert.equal(outcome.observed_bars,5);
  assert.equal(outcome.close_return_pct,2);
  assert.equal(outcome.max_favorable_pct,4);
  assert.equal(outcome.max_adverse_pct,-2);
  assert.ok(outcome.hit_3pct_at);
  assert.equal(outcome.future_trade_time_claimed,false);
});

test('missing candle windows fail closed instead of making a partial horizon look complete',()=>{
  const horizon=RADAR_OUTCOME_HORIZONS.find(x=>x.key==='5m');
  const now=BASE+horizon.ms+horizon.intervalMs+minute;
  const rows=[0,1,3,4].map(i=>candle(BASE+i*minute,minute));
  const outcome=evaluateRadarOutcomeHorizon({detected_at:BASE,entry_price:100},rows,horizon,now);
  assert.equal(outcome.status,'INCOMPLETE');
  assert.equal(outcome.reason,'CLOSED_CANDLE_WINDOW_HAS_GAPS');
  assert.equal(outcome.expected_bars,5);
  assert.equal(outcome.observed_bars,4);
  assert.equal(outcome.missing_open_times_count,1);
});

test('outcome report exposes all twelve radars and withholds performance rates under thirty complete samples',()=>{
  const state=emptyRadarSignalOutcomeState();
  state.records.push({
    signal_id:'RADAR_2|sample',radar:'RADAR_2',baseline_status:'COMPLETE',
    outcomes:{'60m':completeOutcome()},detected_at:BASE,entry_price:100
  });
  const report=buildRadarSignalOutcomeReport(state,BASE+minute);
  assert.equal(report.by_radar.length,12);
  const radar2=report.by_radar.find(x=>x.radar==='RADAR_2');
  assert.equal(radar2.horizons['60m'].completed_samples,1);
  assert.equal(radar2.horizons['60m'].rate_status,'INSUFFICIENT_SAMPLE');
  assert.equal(radar2.horizons['60m'].max_favorable_gte_3pct_rate,null);
  assert.equal(report.interpretation.misses_not_measured_by_this_report,true);
  assert.equal(report.policy.real_order_execution,false);
});

test('bounded maintenance imports archived alerts and respects the per-pass REST budget',async()=>{
  const now=BASE+26*60*minute;
  let state=emptyRadarSignalOutcomeState();
  const alert={id:'r1-alert-1',symbol:'ABCUSDT',detected_at:BASE,processed_at:BASE,price:100,stage:'EARLY_MOVE'};
  const store={
    async getRadarSignalOutcomes(){return state;},
    async updateRadarSignalOutcomes(updater){
      const result=await updater(state);
      if(result!==false)state=result;
      return state;
    }
  };
  for(const radar of RADAR_OUTCOME_ARCHIVES){
    store[radar.reader]=async()=>radar.id==='RADAR_1'?[alert]:[];
  }
  let requests=0;
  const rest={
    async klines(symbol,interval,{startTime,endTime,limit}={}){
      requests++;
      const step=interval==='1m'?minute:5*minute;
      const candles=[];
      for(let openTime=startTime;openTime<=endTime&&candles.length<limit;openTime+=step){
        if(openTime+step-1>=now)continue;
        candles.push(candle(openTime,step,{open:100,high:104,low:99,close:101}));
      }
      return {source:'BINANCE_PUBLIC_REST',candles};
    }
  };
  const result=await runRadarSignalOutcomePass({store,rest,now,maxRestCalls:2,logger:{warn(){}}});
  assert.equal(result.ok,true);
  assert.equal(result.imported,1);
  assert.ok(requests<=2);
  assert.equal(result.rest_requests,requests);
  const row=state.records.find(x=>x.radar==='RADAR_1');
  assert.ok(row);
  assert.equal(row.outcomes['5m'].status,'COMPLETE');
  assert.equal(row.outcomes['60m'].status,'COMPLETE');
  assert.equal(row.outcomes['4h'].status,'COMPLETE');
  assert.equal(row.outcomes['24h'].status,'COMPLETE');
  assert.equal(result.report.summary.completed_24h_outcomes,1);
});

test('performance rates become eligible only at the documented minimum sample size',()=>{
  const state=emptyRadarSignalOutcomeState();
  for(let i=0;i<30;i++){
    const outcome=completeOutcome();
    state.records.push({
      signal_id:'RADAR_6|'+i,radar:'RADAR_6',baseline_status:'COMPLETE',
      detected_at:BASE-i*minute,entry_price:100,
      outcomes:{'4h':outcome}
    });
  }
  const report=buildRadarSignalOutcomeReport(state,BASE+minute);
  const stats=report.by_radar.find(x=>x.radar==='RADAR_6').horizons['4h'];
  assert.equal(stats.completed_samples,30);
  assert.equal(stats.rate_status,'READY_N_GE_30');
  assert.equal(stats.max_favorable_gte_3pct_rate,100);
  assert.equal(stats.max_adverse_lte_minus_2pct_rate,0);
});
