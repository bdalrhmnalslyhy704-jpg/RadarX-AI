import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRadarNotificationGate,notificationGateHealth,resetRadarNotificationGateForTests} from '../core/radar-notification-gate.mjs';
import {evaluateRadarQuality} from '../core/radar-quality-v3.mjs';

const NOW=1_900_000_000_000;
function baseline(radar,extra={}){
  return {radar,symbol:'TESTUSDT',opportunity_score:95,radar_power_score:95,data_quality:96,liquidity_quality:90,price_change_24h:1.2,
    detected_at:NOW,processed_at:NOW,eligible:true,direction:'UP',reasons:['closed candle','volume participation'],reason_codes:['VOLUME_PARTICIPATION'],
    risk_flags:[],components:{momentum:90,volume:90,trades:90,taker:90,range:90,breakout:90,ema:90,vwap:90,bollinger:90,efficiency:90,atr:90},...extra};
}
test('all twelve declared radar profiles are present and health reports them',()=>{
  resetRadarNotificationGateForTests();const h=notificationGateHealth();assert.equal(h.registered_profile_count,12);
  for(const radar of ['EARLY_MOVE_RADAR','STRONG_MOVE_RADAR','ROTATION_LAG_RADAR','LIQUIDITY_ABSORPTION_RADAR','KAHIR_RADAR','DOOMSDAY_RADAR','PROFESSOR_RADAR','ALMUQAWIM_RADAR','EARLY_EXPANSION_RADAR','COIN_HUNTER_RADAR','WHALE_ACCUMULATION_RADAR','FALCON_EYE_RADAR'])assert.ok(h.registered_profiles.includes(radar),radar);
});
test('unknown radar ids cannot inherit the more permissive Professor profile',()=>{
  resetRadarNotificationGateForTests();const r=evaluateRadarNotificationGate(baseline('UNREGISTERED_RADAR'),{now:NOW});
  assert.ok(r.failures.includes('RADAR_PROFILE_MISSING'));assert.equal(r.profile_thresholds.min_score,90);assert.equal(r.profile_thresholds.min_data_quality,90);
});
test('Al-Muqawim uses its own multi-timeframe and entry-freshness conditions',()=>{
  resetRadarNotificationGateForTests();const a=baseline('ALMUQAWIM_RADAR',{eligible:false,almuqawim:{eligible:false,direction:'UP',components:{higher_timeframe_alignment:75,market_structure:82,lower_timeframe_agreement:72,entry_timing:60,entry_freshness:40}}});
  const r=evaluateRadarNotificationGate(a,{now:NOW});assert.equal(r.profile_thresholds.min_score,86);
  for(const code of ['ALMUQAWIM_ANALYSIS_NOT_ELIGIBLE','ALMUQAWIM_HIGHER_TIMEFRAME_ALIGNMENT_WEAK','ALMUQAWIM_MARKET_STRUCTURE_WEAK','ALMUQAWIM_LOWER_TIMEFRAME_DISAGREEMENT','ALMUQAWIM_ENTRY_TIMING_STALE'])assert.ok(r.failures.includes(code),code);
});
test('Lightning recognises pre-expansion fingerprint alias and blocks late setups',()=>{
  resetRadarNotificationGateForTests();const a=baseline('EARLY_EXPANSION_RADAR',{pre_expansion_fingerprint:{ready:true,late:true,micro_move:false,score:88},pre_expansion_stage:'ALREADY_EXTENDED',early_expansion_score:90,metrics:{rvol_5m:2.1,trade_ratio:1.7,taker_buy_ratio:.58,price_change_5m_pct:1.1}});
  const r=evaluateRadarNotificationGate(a,{now:NOW});assert.ok(r.failures.includes('LATE_SETUP_CHASE_GUARD'));assert.ok(r.failures.includes('EARLY_EXPANSION_STAGE_NOT_NOTIFIABLE'));
});
test('Coin Hunter cannot pass without its own micro-participation and anti-chase measurements',()=>{
  resetRadarNotificationGateForTests();const r=evaluateRadarNotificationGate(baseline('COIN_HUNTER_RADAR',{factors:{early_setup_score:80}}),{now:NOW});
  for(const code of ['COIN_HUNTER_MICRO_PARTICIPATION_MISSING','COIN_HUNTER_RESISTANCE_ROOM_INSUFFICIENT','COIN_HUNTER_ANTI_CHASE_OR_UNKNOWN'])assert.ok(r.failures.includes(code),code);
});
test('Kahir category diversity reads scores from nested analysis',()=>{
  resetRadarNotificationGateForTests();const a=baseline('KAHIR_RADAR',{components:undefined,kahir_analysis:{eligible:true,score:90,direction:'UP',data_quality:92,confirmation_count:8,metrics:{one_minute_z:2.2,five_minute_z:2},algorithms:{
    PARTICIPATION_REGIME:{score:86},VOLATILITY_REGIME_TRANSITION:{score:78},KAUFMAN_EFFICIENCY_SHIFT:{score:80},RANGE_ACCEPTANCE:{score:77},IMPULSE_PERSISTENCE:{score:82}}}});
  const r=evaluateRadarNotificationGate(a,{now:NOW});assert.ok(r.category_hits>=5,'nested Kahir scores count: '+r.category_hits);
});
test('null or blank component values do not inflate evidence count',()=>{
  const missing=evaluateRadarQuality({radar:'STRONG_MOVE_RADAR',components:{volume:null,breakout:'',trades:undefined}});
  const measured=evaluateRadarQuality({radar:'STRONG_MOVE_RADAR',components:{volume:0,breakout:82,trades:undefined}});
  assert.equal(missing.evidence_count,0);assert.equal(measured.evidence_count,2);
});
