import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRadarOutcomeLearningSnapshot,
  applyRadarOutcomeLearningAdjustment
} from '../core/radar-outcome-learning.mjs';

const HOUR=60*60*1000;
const BASE=1_700_000_000_000;
const NOW=BASE+400*HOUR;

function makeFeatures(positive){
  return {
    volume_ratio:positive?2.1:0.75,
    trade_ratio:positive?1.8:0.72,
    taker_buy_ratio:positive?0.62:0.40,
    close_location:positive?0.82:0.24,
    higher_low:positive,
    breakout_above_prior_high:positive,
    compression_ratio:positive?0.65:1.18,
    hourly_return_pct:positive?0.7:-0.8,
    return_3h_pct:positive?1.2:-1.4,
    trend_aligned:positive,
    relative_strength_vs_btc_pct:positive?1.4:-1.2,
    recent_15m_return_pct:positive?0.5:-0.8,
    current_range_pct:1.2,
    upper_wick_pct:positive?0.1:0.8,
    micro_5m_available:true,
    micro_5m_taker_buy_ratio:positive?0.61:0.39,
    feature_snapshot_available_count:15
  };
}
function outcome(at,horizonMs,positive,overrides={}){
  return {
    status:'COMPLETE',source:'BINANCE_PUBLIC_CLOSED_OHLC',
    sample_quality:'HISTORICAL_CLOSED_OHLC',horizon_ms:horizonMs,
    close_return_pct:positive?2.4:-2.2,
    max_favorable_pct:positive?4.2:0.6,
    max_adverse_pct:positive?-0.6:-4.1,
    horizon_window_complete_through:at+horizonMs-1,
    updated_at:at+horizonMs+60_000,
    future_trade_time_claimed:false,
    ...overrides
  };
}
function record(index,{features=true,radar='RADAR_1',future=false,incomplete=false}={}){
  const at=BASE+index*2*HOUR,positive=index%2===0;
  const row={
    signal_id:radar+'|CASE-'+index,source_alert_id:'CASE-'+index,radar,
    symbol:'CASE'+String(index).padStart(4,'0')+'USDT',
    stage:positive?'PRE_EXPANSION':'WATCH_EARLY',
    detected_at:at,entry_price:1,baseline_status:'COMPLETE',
    source:'ARCHIVED_RADAR_ALERT',
    feature_snapshot_available_count:features?15:0,
    features:features?makeFeatures(positive):{},
    reason_codes:positive?['VOLUME_EXPANSION','BUYER_FLOW_SUPPORT']:['WEAK_BUYER_FLOW','UPPER_WICK_REJECTION'],
    risk_flags:positive?[]:['TRAP_RISK'],
    updated_at:at+1000,
    outcomes:{
      '60m':outcome(at,HOUR,positive,{
        ...(future?{updated_at:NOW+HOUR,horizon_window_complete_through:NOW+HOUR}:{}),
        ...(incomplete?{status:'INCOMPLETE',sample_quality:null}:{}),
      }),
      '24h':outcome(at,24*HOUR,positive,{
        ...(future?{updated_at:NOW+HOUR,horizon_window_complete_through:NOW+HOUR}:{}),
        ...(incomplete?{status:'PENDING',sample_quality:null}:{}),
      })
    }
  };
  return row;
}

test('twelve-radar outcomes become 1h and 24h training cases only after complete closed OHLC windows',()=>{
  const records=Array.from({length:120},(_,i)=>record(i,{radar:'RADAR_'+(i%12+1)}));
  const snapshot=buildRadarOutcomeLearningSnapshot({records},NOW);
  assert.equal(snapshot.source,'BINANCE_PUBLIC_CLOSED_OHLC');
  assert.equal(snapshot.scope,'TWELVE_RADARS_SPOT_USDT');
  assert.equal(snapshot.training_records['60m'],120);
  assert.equal(snapshot.training_records['24h'],120);
  assert.equal(snapshot.case_study_count,120);
  assert.equal(snapshot.case_studies.length,100);
  assert.equal(snapshot.horizon_profiles['60m'].resolved_samples,120);
  assert.equal(snapshot.horizon_profiles['24h'].resolved_samples,120);
  assert.equal(snapshot.horizon_profiles['60m'].outcome_horizon_ms,HOUR);
  assert.equal(snapshot.horizon_profiles['24h'].outcome_horizon_ms,24*HOUR);
  assert.equal(snapshot.case_studies[0].no_future_data_used,true);
  assert.equal(snapshot.policy.entry_gate_changes,false);
  assert.equal(snapshot.policy.radar_threshold_changes,false);
});

test('future, incomplete and featureless cases are kept as case studies but never become training labels',()=>{
  const records=[
    record(1,{future:true}),
    record(2,{incomplete:true}),
    record(3,{features:false}),
    record(4,{radar:'RADAR_9'})
  ];
  const snapshot=buildRadarOutcomeLearningSnapshot({records},NOW);
  assert.equal(snapshot.case_study_count,4);
  assert.equal(snapshot.training_records['60m'],1);
  assert.equal(snapshot.training_records['24h'],1);
  const future=snapshot.case_studies.find(x=>x.id==='RADAR_1|CASE-1');
  assert.equal(future.one_hour.status,'PENDING');
  assert.equal(future.one_hour.close_return_pct,null);
  const incomplete=snapshot.case_studies.find(x=>x.id==='RADAR_1|CASE-2');
  assert.equal(incomplete.twenty_four_hour.status,'PENDING');
  assert.equal(snapshot.capture['60m'].excluded_incomplete_or_untrusted,3);
});

test('training labels use closed-candle close returns, not intrahorizon wick hits',()=>{
  const row=record(20);
  row.outcomes['60m'].close_return_pct=0.2;
  row.outcomes['60m'].max_favorable_pct=8;
  row.outcomes['60m'].max_adverse_pct=-0.3;
  const snapshot=buildRadarOutcomeLearningSnapshot({records:[row]},NOW);
  assert.equal(snapshot.capture['60m'].outcome_counts.flat,1);
  assert.equal(snapshot.capture['60m'].outcome_counts.up,0);
  assert.equal(snapshot.capture['60m'].outcome_counts.down,0);
});

test('automatic rank update remains disabled until nested walk-forward validation and untouched holdout both beat baseline',()=>{
  const sparse=buildRadarOutcomeLearningSnapshot({records:[record(1),record(2),record(3)]},NOW);
  const base=77;
  const blocked=applyRadarOutcomeLearningAdjustment(base,makeFeatures(true),sparse);
  assert.equal(blocked.score,77);
  assert.equal(blocked.adjustment,0);
  assert.equal(blocked.status,'OBSERVATION_ONLY_UNTIL_OUT_OF_SAMPLE_VALIDATION');
  assert.deepEqual(blocked.used_horizons,[]);
});

test('one-snapshot case review lists evidence contradictions without claiming whale identity or causation',()=>{
  const bad=record(7,{features:true});
  bad.features={...makeFeatures(false),volume_ratio:2.0,taker_buy_ratio:0.42,close_location:0.3,upper_wick_pct:0.9};
  const snapshot=buildRadarOutcomeLearningSnapshot({records:[bad]},NOW);
  const item=snapshot.case_studies[0];
  assert.ok(item.retrospective_review_reasons.includes('HIGH_VOLUME_WITH_WEAK_TAKER_BUY_FLOW'));
  assert.ok(item.retrospective_review_reasons.includes('UPPER_WICK_REJECTION'));
  assert.equal(item.no_future_data_used,true);
  assert.equal(item.causality,'CORRELATIONAL_CASE_STUDY_NOT_PROOF_OF_WHALE_INTENT');
});
