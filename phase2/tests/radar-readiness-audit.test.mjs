import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRadarReadinessAudit} from '../core/radar-readiness-audit.mjs';

const IDS = [
  'EARLY_MOVE_RADAR','STRONG_MOVE_RADAR','ROTATION_LAG_RADAR','LIQUIDITY_ABSORPTION_RADAR',
  'KAHIR_RADAR','DOOMSDAY_RADAR','ALMUQAWIM_RADAR','EARLY_EXPANSION_RADAR',
  'FALCON_EYE_RADAR','COIN_HUNTER_RADAR','WHALE_ACCUMULATION_RADAR','PROFESSOR_RADAR'
];
function fixture({missingCache = false, stopped = null, staleCycle = false} = {}) {
  const now = 100_000;
  const radars = IDS.map(radar => ({
    radar, radar_name: radar, running: radar !== stopped,
    health: {running: radar !== stopped, last_error: null}
  }));
  const aliases = ['RADAR1','RADAR2','RADAR3','RADAR4','RADAR5','RADAR6','RADAR7','RADAR8',
    'RADAR9_FALCON_EYE','RADAR10_COIN_HUNTER','RADAR11_WHALE','RADAR12_PROFESSOR'];
  const events = aliases.map((radar,index) => ({
    id: 'cycle-'+index, radar, symbol:'SYSTEM', event_type:'BACKGROUND_CYCLE',
    decision_at: staleCycle && index===0 ? 1 : now - 1000,
    pipeline_latency_ms: 200 + index,
    accepted: null, reason_codes:['CYCLE_COMPLETED_WITHOUT_GATE_DECISION']
  }));
  events.push({id:'decision-1',radar:'RADAR8',symbol:'HBARUSDT',event_type:'CANDIDATE_DECISION',
    decision_at:now-500,pipeline_latency_ms:31,accepted:false,reason_codes:['VOLUME_NOT_IMPROVING']});
  const swarm = {status:stopped?'DEGRADED':'RUNNING',expected_count:12,registered_count:12,
    running_count:stopped?11:12,failed_count:stopped?1:0,missing_count:0};
  const candleCache = {
    state:'LIVE',running:true,expected_symbols:282,ready_symbols:missingCache?280:282,
    missing_symbols:missingCache?2:0,stale_symbols:0,incomplete_symbols:missingCache?2:0,
    cached_closed_candles:282*96,websocket_live:true,websocket_subscription_complete:true,
    websocket_subscribed_symbols:282,websocket_sync_ready:true,websocket_advanced_symbols:282,
    full_market_coverage_ready:!missingCache,last_error:null
  };
  const audit=buildRadarReadinessAudit({radars,swarm,telemetry:{events,total_recorded:events.length},candleCache,now});
  return {audit, now};
}

test('live audit reports READY only when all 12 workers and the full fresh candle cache are ready',()=>{
  const {audit}=fixture();
  assert.equal(audit.status,'READY');
  assert.equal(audit.summary.expected_radars,12);
  assert.equal(audit.summary.registered_radars,12);
  assert.equal(audit.summary.running_radars,12);
  assert.equal(audit.summary.candle_cache_coverage_ratio,1);
  assert.equal(audit.summary.full_market_candle_coverage_ready,true);
  assert.equal(audit.radars.length,12);
  assert.equal(audit.policy.paper_trading,true);
  assert.equal(audit.policy.real_order_execution,false);
});

test('live audit remains WARMING rather than claiming full readiness while candles are missing',()=>{
  const {audit}=fixture({missingCache:true});
  assert.equal(audit.status,'WARMING');
  assert.equal(audit.summary.candle_cache_coverage_ratio,280/282);
  assert.equal(audit.summary.full_market_candle_coverage_ready,false);
  assert.ok(audit.readiness_reasons.includes('CLOSED_CANDLE_CACHE_WARMING'));
  assert.equal(audit.market_data.missing_symbols,2);
});

test('a stopped radar fails the overall audit without weakening candle or notification gates',()=>{
  const {audit}=fixture({stopped:'FALCON_EYE_RADAR'});
  assert.equal(audit.status,'DEGRADED');
  assert.ok(audit.readiness_reasons.includes('RADAR_NOT_RUNNING:FALCON_EYE_RADAR'));
  assert.equal(audit.policy.detection_thresholds_changed,false);
  assert.equal(audit.policy.live_orders_enabled,false);
});

test('audit surfaces stale cycles and per-radar rejection evidence',()=>{
  const {audit}=fixture({staleCycle:true});
  const early= audit.radars.find(radar=>radar.radar==='EARLY_MOVE_RADAR');
  const radar8=audit.radars.find(radar=>radar.radar==='EARLY_EXPANSION_RADAR');
  assert.equal(early.cycle_is_stale,true);
  assert.ok(audit.readiness_reasons.includes('RADAR_CYCLE_STALE:EARLY_MOVE_RADAR'));
  assert.equal(radar8.candidate_decisions_observed,1);
  assert.equal(radar8.gate_rejected,1);
  assert.equal(radar8.top_rejection_reasons[0].reason,'VOLUME_NOT_IMPROVING');
});
