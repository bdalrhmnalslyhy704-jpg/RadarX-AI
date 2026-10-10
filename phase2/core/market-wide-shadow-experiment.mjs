export const SHADOW_ARM = Object.freeze({ LEGACY: 'LEGACY', LIGHT_POOL: 'LIGHT_POOL' });

export function shadowArmForCycle(cycleNumber) {
  const cycle = Number(cycleNumber);
  if (!Number.isInteger(cycle) || cycle < 1) throw new Error('INVALID_SHADOW_CYCLE_NUMBER');
  const pairIndex = Math.floor((cycle - 1) / 2) + 1;
  const position = (cycle - 1) % 2;
  const firstArm = pairIndex % 2 === 1 ? SHADOW_ARM.LEGACY : SHADOW_ARM.LIGHT_POOL;
  const arm = position === 0 ? firstArm :
    (firstArm === SHADOW_ARM.LEGACY ? SHADOW_ARM.LIGHT_POOL : SHADOW_ARM.LEGACY);
  return {cycle, pair_index:pairIndex, pair_position:position+1, arm,
    expected_micro_pool_applied:arm === SHADOW_ARM.LIGHT_POOL};
}

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const sorted = values => values.filter(Number.isFinite).sort((a,b)=>a-b);
const mean = values => {
  const rows=values.filter(Number.isFinite);
  return rows.length?rows.reduce((sum,value)=>sum+value,0)/rows.length:null;
};
const percentile = (values,p) => {
  const rows=sorted(values);
  return rows.length?rows[Math.min(rows.length-1,Math.max(0,Math.ceil(rows.length*p)-1))]:null;
};
const symbols = value => [...new Set((Array.isArray(value)?value:[])
  .map(item=>String(item||'').trim().toUpperCase()).filter(Boolean))].sort();

export function compareShadowPairCycles(input) {
  const rows=Array.isArray(input)?input:[];
  const legacy=rows.find(row=>row?.shadow_arm===SHADOW_ARM.LEGACY);
  const pool=rows.find(row=>row?.shadow_arm===SHADOW_ARM.LIGHT_POOL);
  if(!legacy||!pool)return {complete:false,reason:'PAIR_REQUIRES_ONE_CYCLE_PER_ARM'};
  if(legacy.shadow_pair_index!==pool.shadow_pair_index)return {complete:false,reason:'PAIR_INDEX_MISMATCH'};
  const legacySymbols=symbols(legacy.micro_symbols),poolSymbols=symbols(pool.micro_symbols);
  const legacySet=new Set(legacySymbols),poolSet=new Set(poolSymbols);
  const intersection=legacySymbols.filter(symbol=>poolSet.has(symbol));
  const union=[...new Set([...legacySymbols,...poolSymbols])];
  const legacyOnly=legacySymbols.filter(symbol=>!poolSet.has(symbol));
  const poolOnly=poolSymbols.filter(symbol=>!legacySet.has(symbol));
  const durationDelta=finite(pool.scan_duration_ms)!==null&&finite(legacy.scan_duration_ms)!==null
    ?Number(pool.scan_duration_ms)-Number(legacy.scan_duration_ms):null;
  const candidateDelta=finite(pool.light_candidate_total)!==null&&finite(legacy.light_candidate_total)!==null
    ?Number(pool.light_candidate_total)-Number(legacy.light_candidate_total):null;
  return {
    complete:true,pair_index:legacy.shadow_pair_index,legacy_cycle:legacy.shadow_cycle,
    light_pool_cycle:pool.shadow_cycle,
    order:legacy.shadow_cycle<pool.shadow_cycle?'LEGACY_THEN_LIGHT_POOL':'LIGHT_POOL_THEN_LEGACY',
    legacy_micro_total:legacySymbols.length,light_pool_micro_total:poolSymbols.length,
    micro_intersection_total:intersection.length,micro_union_total:union.length,
    micro_jaccard_ratio:union.length?intersection.length/union.length:null,
    selection_changed:legacyOnly.length>0||poolOnly.length>0,
    legacy_only_micro_symbols:legacyOnly,light_pool_only_micro_symbols:poolOnly,
    legacy_duration_ms:finite(legacy.scan_duration_ms),light_pool_duration_ms:finite(pool.scan_duration_ms),
    light_pool_duration_delta_ms:durationDelta,
    legacy_light_candidates:finite(legacy.light_candidate_total),
    light_pool_light_candidates:finite(pool.light_candidate_total),light_candidate_delta:candidateDelta,
    legacy_deep_completed:finite(legacy.deep_completed_total),
    light_pool_deep_completed:finite(pool.deep_completed_total),
    legacy_deep_failed:finite(legacy.deep_failed_total),light_pool_deep_failed:finite(pool.deep_failed_total),
    legacy_micro_pre_expansion:finite(legacy.micro_pre_expansion_total),
    light_pool_micro_pre_expansion:finite(pool.micro_pre_expansion_total),
    legacy_deep_pre_expansion:finite(legacy.deep_pre_expansion_total),
    light_pool_deep_pre_expansion:finite(pool.deep_pre_expansion_total),
    legacy_http_attempts:finite(legacy.actual_binance_http_attempts),
    light_pool_http_attempts:finite(pool.actual_binance_http_attempts),
    light_scan_added_rest_calls:(finite(legacy.binance_rest_calls_added_by_light_scan)||0)+
      (finite(pool.binance_rest_calls_added_by_light_scan)||0)
  };
}

export function summarizeShadowArm(input,arm) {
  const rows=(Array.isArray(input)?input:[]).filter(row=>row?.shadow_arm===arm);
  const durations=rows.map(row=>finite(row.scan_duration_ms)).filter(value=>value!==null);
  const microCounts=rows.map(row=>finite(row.micro_selected_total)).filter(value=>value!==null);
  const deepCounts=rows.map(row=>finite(row.deep_completed_total)).filter(value=>value!==null);
  return {
    arm,cycles:rows.length,
    pool_activation_verified:rows.length>0&&rows.every(row=>
      row.micro_pool_applied===(arm===SHADOW_ARM.LIGHT_POOL)&&
      row.legacy_micro_selector_active===(arm===SHADOW_ARM.LEGACY)),
    avg_scan_duration_ms:mean(durations),p50_scan_duration_ms:percentile(durations,0.50),
    p95_scan_duration_ms:percentile(durations,0.95),
    max_scan_duration_ms:durations.length?Math.max(...durations):null,
    avg_light_candidate_total:mean(rows.map(row=>finite(row.light_candidate_total)).filter(value=>value!==null)),
    avg_micro_candidate_pool_total:mean(rows.map(row=>finite(row.micro_candidate_pool_total)).filter(value=>value!==null)),
    avg_micro_selected_total:mean(microCounts),micro_selected_total:microCounts.reduce((sum,value)=>sum+value,0),
    deep_completed_total:deepCounts.reduce((sum,value)=>sum+value,0),
    deep_failed_total:rows.reduce((sum,row)=>sum+(finite(row.deep_failed_total)||0),0),
    missing_ticker_total:rows.reduce((sum,row)=>sum+(finite(row.missing_ticker_total)||0),0),
    actual_binance_http_attempts:rows.reduce((sum,row)=>sum+(finite(row.actual_binance_http_attempts)||0),0),
    actual_5m_kline_http_attempts:rows.reduce((sum,row)=>sum+(finite(row.actual_5m_kline_http_attempts)||0),0),
    light_scan_added_rest_calls:rows.reduce((sum,row)=>sum+(finite(row.binance_rest_calls_added_by_light_scan)||0),0),
    micro_pre_expansion_total:rows.reduce((sum,row)=>sum+(finite(row.micro_pre_expansion_total)||0),0),
    deep_pre_expansion_total:rows.reduce((sum,row)=>sum+(finite(row.deep_pre_expansion_total)||0),0),
    symbols_selected:symbols(rows.flatMap(row=>row.micro_symbols||[]))
  };
}
