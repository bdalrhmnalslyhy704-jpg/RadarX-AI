import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRadarMissedMoverAuditReport, RADAR_MISSED_MOVER_HORIZONS } from '../core/radar-missed-mover-audit.mjs';

const BASE = 1_800_000_000_000;
const MINUTE = 60_000;

function makeCycles({minutes=22,moveAt=3,movePrice=106,duplicateFirstMinute=false,now=BASE+22*MINUTE}={}) {
  const cycles = [];
  for (let i=0;i<=minutes;i++) {
    const at=BASE+i*MINUTE;
    const price=i>=moveAt?movePrice:100;
    const coin={
      symbol:'AAAUSDT',eligible:true,fast_scan_at:at,eligibility_at:at,
      ticker:{price,quote_volume_24h:2_000_000},
      market_wide_light_scan:{evaluated:true,reason:'LIGHT_FEATURES_RANK_ONLY'},
      micro_selected_at:at+100,micro_scan_completed_at:at+200,
      deep_scan_status:'COMPLETED',rejection_reason:'.INCOMPLETE',
      notification_gate_rejection_reason:'.INCOMPLETE',notification_status:'.INCOMPLETE'
    };
    cycles.push({
      schema_version:'RADARX_SCAN_JOURNEY_V1',
      cycle_id:'RADAR8:USDT:'+at,cycle_number:i+1,radar:'RADAR_8',status:'COMPLETE',
      started_at:at,completed_at:at+500,source:'BINANCE_PUBLIC_REST',
      coins:[coin],data_policy:{closed_candles_only:true,paper_trading:true,real_order_execution:false}
    });
    if (duplicateFirstMinute&&i===0) cycles.push({
      schema_version:'RADARX_SCAN_JOURNEY_V1',
      cycle_id:'RADAR8:USDT:DUP:'+at,cycle_number:999,radar:'RADAR_8',status:'COMPLETE',
      started_at:at+500,completed_at:at+700,source:'BINANCE_PUBLIC_REST',
      coins:[{...coin,fast_scan_at:at+500,ticker:{price:101,quote_volume_24h:2_000_000}}]
    });
  }
  return {cycles,now};
}

test('missed-mover audit maps all twelve archives and does not claim closed-OHLC truth',()=>{
  const {cycles,now}=makeCycles({minutes:22});
  const report=buildRadarMissedMoverAuditReport({cycles,now,alertsByRadar:{}});
  assert.equal(RADAR_MISSED_MOVER_HORIZONS.length,6);
  assert.equal(Object.keys(report.radar_alert_archive_coverage).length,12);
  assert.equal(report.scope,'RADAR_8_FULL_MARKET_SCAN_SNAPSHOTS_CROSS_CHECKED_AGAINST_ALL_12_RADAR_ALERT_ARCHIVES');
  assert.equal(report.interpretation.closed_ohlc_validation_for_missed_movers,false);
  assert.equal(report.policy.paper_trading,true);
  assert.equal(report.policy.real_order_execution,false);
  assert.ok(report.by_horizon['5m'].complete_samples>0);
  assert.ok(report.by_horizon['5m'].missed_mover_samples>0);
  assert.ok(report.missed_examples.some(row=>row.symbol==='AAAUSDT'&&row.horizon==='5m'&&row.reason==='NO_RADAR_ALERT_BEFORE_OBSERVED_MOVE'));
});

test('an archived radar alert strictly before the observed rise prevents a missed-mover label',()=>{
  const {cycles,now}=makeCycles({minutes:22});
  const report=buildRadarMissedMoverAuditReport({
    cycles,now,
    alertsByRadar:{RADAR_3:[{symbol:'AAAUSDT',detected_at:BASE+2*MINUTE,id:'ROTATION-1'}]}
  });
  assert.ok(report.by_horizon['5m'].captured_before_move_samples>0);
  assert.equal(report.by_horizon['5m'].missed_mover_samples,0);
});

test('failed, future, stale and invalid-price scan records cannot create mover samples',()=>{
  const now=BASE+30*MINUTE;
  const {cycles}=makeCycles({minutes:10,now});
  cycles.push({...cycles[0],cycle_id:'FAILED',status:'FAILED'});
  cycles.push({...cycles[0],cycle_id:'FUTURE',started_at:now+1,completed_at:now+100});
  cycles.push({...cycles[0],cycle_id:'BADPRICE',started_at:now-1,completed_at:now-1,
    coins:[{symbol:'BBBUSDT',eligible:true,fast_scan_at:now-1,ticker:{price:null}}]});
  const report=buildRadarMissedMoverAuditReport({cycles,now,alertsByRadar:{}});
  assert.ok(report.coverage.dropped.non_complete_cycles>=1);
  assert.ok(report.coverage.dropped.future_cycles>=1);
  assert.ok(report.coverage.dropped.invalid_snapshots>=1);
  assert.ok(report.missed_examples.every(row=>row.symbol==='AAAUSDT'));
});

test('one symbol is sampled at most once per minute and unknown eligibility is not counted as a miss',()=>{
  const {cycles,now}=makeCycles({minutes:22,duplicateFirstMinute:true});
  cycles[0].coins[0].eligible=null;
  const report=buildRadarMissedMoverAuditReport({cycles,now,alertsByRadar:{}});
  assert.ok(report.coverage.baseline_samples_after_deduplication<report.coverage.snapshot_rows_after_validation);
  assert.ok(report.coverage.unknown_eligibility_baselines>0);
  assert.equal(report.interpretation.unknown_eligibility_is_not_counted_as_a_miss,true);
});

test('all expected horizons remain explicit and incomplete data stays marked incomplete',()=>{
  const {cycles,now}=makeCycles({minutes:4,now:BASE+5*MINUTE});
  const report=buildRadarMissedMoverAuditReport({cycles,now,alertsByRadar:{}});
  for (const horizon of RADAR_MISSED_MOVER_HORIZONS) {
    assert.ok(report.by_horizon[horizon.key]);
    assert.ok(['INSUFFICIENT_SAMPLE','SAMPLE_N_GE_30_NOT_A_GUARANTEE'].includes(report.by_horizon[horizon.key].rate_status));
  }
  assert.ok(report.by_horizon['24h'].pending_samples>0);
});
