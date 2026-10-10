import test from 'node:test';
import assert from 'node:assert/strict';
import {SHADOW_ARM,shadowArmForCycle,compareShadowPairCycles,summarizeShadowArm}
  from '../core/market-wide-shadow-experiment.mjs';

test('30-cycle AB/BA plan is balanced and includes one of each arm in every pair',()=>{
  const rows=Array.from({length:30},(_,index)=>shadowArmForCycle(index+1));
  assert.equal(rows.filter(row=>row.arm===SHADOW_ARM.LEGACY).length,15);
  assert.equal(rows.filter(row=>row.arm===SHADOW_ARM.LIGHT_POOL).length,15);
  assert.deepEqual(rows.slice(0,4).map(row=>row.arm),[
    SHADOW_ARM.LEGACY,SHADOW_ARM.LIGHT_POOL,SHADOW_ARM.LIGHT_POOL,SHADOW_ARM.LEGACY
  ]);
  for(let pair=1;pair<=15;pair++){
    const members=rows.filter(row=>row.pair_index===pair);
    assert.equal(members.length,2);
    assert.deepEqual(new Set(members.map(row=>row.arm)),
      new Set([SHADOW_ARM.LEGACY,SHADOW_ARM.LIGHT_POOL]));
  }
  assert.equal(rows[0].expected_micro_pool_applied,false);
  assert.equal(rows[1].expected_micro_pool_applied,true);
  assert.throws(()=>shadowArmForCycle(0),/INVALID_SHADOW_CYCLE_NUMBER/);
});

test('paired comparison reports changed symbols, intersection, Jaccard, and duration delta',()=>{
  const pair=compareShadowPairCycles([
    {shadow_arm:'LEGACY',shadow_pair_index:1,shadow_cycle:1,scan_duration_ms:40000,
      micro_symbols:['AAAUSDT','BBBUSDT','CCCUSDT'],light_candidate_total:4,deep_completed_total:3,
      deep_failed_total:0,micro_pre_expansion_total:1,deep_pre_expansion_total:0,actual_binance_http_attempts:12,
      binance_rest_calls_added_by_light_scan:0},
    {shadow_arm:'LIGHT_POOL',shadow_pair_index:1,shadow_cycle:2,scan_duration_ms:36000,
      micro_symbols:['BBBUSDT','CCCUSDT','DDDUSDT'],light_candidate_total:7,deep_completed_total:3,
      deep_failed_total:0,micro_pre_expansion_total:2,deep_pre_expansion_total:1,actual_binance_http_attempts:10,
      binance_rest_calls_added_by_light_scan:0}
  ]);
  assert.equal(pair.complete,true);
  assert.equal(pair.micro_intersection_total,2);
  assert.equal(pair.micro_union_total,4);
  assert.equal(pair.micro_jaccard_ratio,0.5);
  assert.equal(pair.selection_changed,true);
  assert.deepEqual(pair.legacy_only_micro_symbols,['AAAUSDT']);
  assert.deepEqual(pair.light_pool_only_micro_symbols,['DDDUSDT']);
  assert.equal(pair.light_pool_duration_delta_ms,-4000);
  assert.equal(pair.light_candidate_delta,3);
  assert.equal(pair.light_scan_added_rest_calls,0);
});

test('arm summary detects selector activation mismatch and computes durations',()=>{
  const rows=[
    {shadow_arm:'LEGACY',micro_pool_applied:false,legacy_micro_selector_active:true,scan_duration_ms:40000,
      light_candidate_total:2,micro_candidate_pool_total:48,micro_selected_total:12,deep_completed_total:3,
      deep_failed_total:0,missing_ticker_total:0,actual_binance_http_attempts:10,actual_5m_kline_http_attempts:2,
      binance_rest_calls_added_by_light_scan:0,micro_symbols:['AAAUSDT']},
    {shadow_arm:'LEGACY',micro_pool_applied:false,legacy_micro_selector_active:true,scan_duration_ms:60000,
      light_candidate_total:4,micro_candidate_pool_total:48,micro_selected_total:12,deep_completed_total:3,
      deep_failed_total:0,missing_ticker_total:0,actual_binance_http_attempts:12,actual_5m_kline_http_attempts:3,
      binance_rest_calls_added_by_light_scan:0,micro_symbols:['BBBUSDT']},
    {shadow_arm:'LIGHT_POOL',micro_pool_applied:true,legacy_micro_selector_active:false,scan_duration_ms:35000,
      light_candidate_total:5,micro_candidate_pool_total:48,micro_selected_total:12,deep_completed_total:3,
      deep_failed_total:0,missing_ticker_total:0,actual_binance_http_attempts:8,actual_5m_kline_http_attempts:1,
      binance_rest_calls_added_by_light_scan:0,micro_symbols:['CCCUSDT']},
    {shadow_arm:'LIGHT_POOL',micro_pool_applied:false,legacy_micro_selector_active:true,scan_duration_ms:38000,
      light_candidate_total:5,micro_candidate_pool_total:48,micro_selected_total:12,deep_completed_total:3,
      deep_failed_total:0,missing_ticker_total:0,actual_binance_http_attempts:8,actual_5m_kline_http_attempts:1,
      binance_rest_calls_added_by_light_scan:0,micro_symbols:['DDDUSDT']}
  ];
  const legacy=summarizeShadowArm(rows,SHADOW_ARM.LEGACY);
  const pool=summarizeShadowArm(rows,SHADOW_ARM.LIGHT_POOL);
  assert.equal(legacy.cycles,2);
  assert.equal(legacy.pool_activation_verified,true);
  assert.equal(legacy.avg_scan_duration_ms,50000);
  assert.equal(pool.cycles,2);
  assert.equal(pool.pool_activation_verified,false);
  assert.equal(pool.light_scan_added_rest_calls,0);
});
