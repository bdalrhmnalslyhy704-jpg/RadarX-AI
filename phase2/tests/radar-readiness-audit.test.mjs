import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRadarReadinessAudit} from '../core/radar-readiness-audit.mjs';

const IDS = [
  'EARLY_MOVE_RADAR','STRONG_MOVE_RADAR','ROTATION_LAG_RADAR','LIQUIDITY_ABSORPTION_RADAR',
  'KAHIR_RADAR','DOOMSDAY_RADAR','ALMUQAWIM_RADAR','EARLY_EXPANSION_RADAR',
  'FALCON_EYE_RADAR','COIN_HUNTER_RADAR','WHALE_ACCUMULATION_RADAR','PROFESSOR_RADAR'
];
function fixture({missingCache = false, stopped = null, staleCycle = false, missingCycleTelemetry = false, cycleError = false, websocketDown = false, analystRuntime = null, radarIds = IDS} = {}) {
  const now = 1_000_000;
  const radars = radarIds.map(radar => ({
    radar, radar_name: radar, running: radar !== stopped,
    health: {running: radar !== stopped, last_error: null}
  }));
  const aliases = ['RADAR1','RADAR2','RADAR3','RADAR4','RADAR5','RADAR6','RADAR7','RADAR8',
    'RADAR9_FALCON_EYE','RADAR10_COIN_HUNTER','RADAR11_WHALE','RADAR12_PROFESSOR'];
  const events = aliases.filter((radar,index)=>!missingCycleTelemetry||index<11).map((radar,index) => ({
    id: 'cycle-'+index, radar, symbol:'SYSTEM', event_type:'BACKGROUND_CYCLE',
    decision_at: staleCycle && index===0 ? 1 : now - 1000,
    pipeline_latency_ms: 200 + index,
    accepted: null, reason_codes:[cycleError && index===0 ? 'CYCLE_ERROR:TEST_FAILURE' : 'CYCLE_COMPLETED_WITHOUT_GATE_DECISION']
  }));
  events.push({id:'decision-1',radar:'RADAR8',symbol:'HBARUSDT',event_type:'CANDIDATE_DECISION',
    decision_at:now-500,pipeline_latency_ms:31,accepted:false,reason_codes:['VOLUME_NOT_IMPROVING']});
  const swarm = {status:stopped?'DEGRADED':'RUNNING',expected_count:12,registered_count:12,
    running_count:stopped?11:12,failed_count:stopped?1:0,missing_count:0};
  const candleCache = {
    state:'LIVE',running:true,expected_symbols:282,ready_symbols:missingCache?280:282,
    missing_symbols:missingCache?2:0,stale_symbols:0,incomplete_symbols:missingCache?2:0,
    cached_closed_candles:282*96,websocket_live:!websocketDown,websocket_subscription_complete:!websocketDown,
    websocket_subscribed_symbols:websocketDown?0:282,websocket_sync_ready:!websocketDown,websocket_advanced_symbols:websocketDown?0:282,
    full_market_coverage_ready:!missingCache&&!websocketDown,last_error:websocketDown?'WS_DISCONNECTED':null
  };
  const audit=buildRadarReadinessAudit({radars,swarm,telemetry:{events,total_recorded:events.length},candleCache,analystRuntime,now});
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

test('live audit is DEGRADED if the latest observed radar cycle failed',()=>{
  const {audit}=fixture({cycleError:true});
  assert.equal(audit.status,'DEGRADED');
  assert.ok(audit.readiness_reasons.includes('RADAR_LAST_CYCLE_ERROR:EARLY_MOVE_RADAR'));
});

test('live audit is DEGRADED rather than WARMING when the candle websocket is down',()=>{
  const {audit}=fixture({websocketDown:true});
  assert.equal(audit.status,'DEGRADED');
  assert.ok(audit.readiness_reasons.includes('CANDLE_WEBSOCKET_NOT_LIVE'));
  assert.ok(audit.readiness_reasons.includes('CANDLE_WEBSOCKET_NOT_SYNC_READY'));
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


test('audit never reports READY when a registered radar has no observed cycle telemetry',()=>{
  const {audit}=fixture({missingCycleTelemetry:true});
  assert.equal(audit.status,'DEGRADED');
  assert.equal(audit.summary.radars_without_cycle_telemetry,1);
  assert.ok(audit.readiness_reasons.includes('RADAR_CYCLE_TELEMETRY_MISSING:PROFESSOR_RADAR'));
});


function healthyAnalystRuntime(now, overrides = {}) {
  const assessment = {
    symbol: 'BTCUSDT',
    assessed_at_ms: now - 500,
    age_ms: 500,
    fresh: true,
    specialist_count: 19,
    unique_specialists: 19,
    unique_roles: 19,
    specialists_complete: true,
    final_analyst_complete: true,
    analysis_failed: false,
    data_valid: true
  };
  return {
    configured: true,
    running: true,
    monitorStats: {
      scan_count: 3,
      last_scan_at: new Date(now - 1000).toISOString(),
      next_scan_at: new Date(now + 59000).toISOString(),
      last_scan_successful: true,
      last_error: null
    },
    assessments: [assessment],
    queue: {pending_count: 2, max_queue: 200, oldest_pending_age_ms: 1000},
    ...overrides
  };
}

test('readiness is READY only when the full twelve-radar swarm and fresh 19+1 analyst result are healthy', () => {
  const now = 1_000_000;
  const {audit} = fixture({analystRuntime: healthyAnalystRuntime(now)});
  assert.equal(audit.status, 'READY');
  assert.equal(audit.analysts.required, true);
  assert.equal(audit.analysts.status, 'READY');
  assert.equal(audit.analysts.expected_analysts, 20);
  assert.equal(audit.analysts.specialists_per_assessment, 19);
  assert.equal(audit.analysts.final_analyst_per_assessment, 1);
  assert.equal(audit.analysts.complete_fresh_assessments, 1);
  assert.equal(audit.summary.analyst_complete_fresh_assessments, 1);
});

test('readiness stays WARMING when the twenty-analyst worker has no fresh complete assessment yet', () => {
  const now = 1_000_000;
  const {audit} = fixture({
    analystRuntime: healthyAnalystRuntime(now, {assessments: []})
  });
  assert.equal(audit.status, 'WARMING');
  assert.equal(audit.analysts.status, 'WARMING');
  assert.ok(audit.readiness_reasons.includes('MULTI_ANALYST_ASSESSMENTS_NOT_READY'));
});

test('readiness is DEGRADED when the continuous analyst worker is stopped', () => {
  const now = 1_000_000;
  const {audit} = fixture({
    analystRuntime: healthyAnalystRuntime(now, {running: false})
  });
  assert.equal(audit.status, 'DEGRADED');
  assert.equal(audit.analysts.status, 'DEGRADED');
  assert.ok(audit.readiness_reasons.includes('MULTI_ANALYST_WORKER_NOT_RUNNING'));
});

test('readiness is DEGRADED when a fresh assessment has missing specialists or a missing final analyst', () => {
  const now = 1_000_000;
  const runtime = healthyAnalystRuntime(now, {
    assessments: [{
      symbol: 'ETHUSDT', age_ms: 250, fresh: true,
      specialist_count: 18, unique_specialists: 18, unique_roles: 18,
      specialists_complete: false, final_analyst_complete: false, analysis_failed: true,
      data_valid: true
    }]
  });
  const {audit} = fixture({analystRuntime: runtime});
  assert.equal(audit.status, 'DEGRADED');
  assert.equal(audit.analysts.incomplete_fresh_assessments, 1);
  assert.ok(audit.readiness_reasons.includes('MULTI_ANALYST_ASSESSMENT_INCOMPLETE'));
});

test('readiness is DEGRADED on a live analyst scan error even if an older complete result is cached', () => {
  const now = 1_000_000;
  const runtime = healthyAnalystRuntime(now, {
    monitorStats: {
      scan_count: 4, last_scan_at: new Date(now - 500).toISOString(),
      last_scan_successful: false, last_error: 'REST_TIMEOUT'
    }
  });
  const {audit} = fixture({analystRuntime: runtime});
  assert.equal(audit.status, 'DEGRADED');
  assert.ok(audit.readiness_reasons.includes('MULTI_ANALYST_LAST_SCAN_ERROR'));
});

test('stale analyst assessments are reported, not counted as currently ready', () => {
  const now = 1_000_000;
  const runtime = healthyAnalystRuntime(now, {
    assessments: [{
      symbol: 'BTCUSDT', age_ms: 240000, fresh: false,
      specialist_count: 19, unique_specialists: 19, unique_roles: 19,
      specialists_complete: true, final_analyst_complete: true, analysis_failed: false,
      data_valid: true
    }]
  });
  const {audit} = fixture({analystRuntime: runtime});
  assert.equal(audit.status, 'WARMING');
  assert.equal(audit.analysts.stale_assessments, 1);
  assert.equal(audit.analysts.complete_fresh_assessments, 0);
});


test('readiness detects a missing canonical radar role even when twelve workers are registered', () => {
  const radarIds = [...IDS.slice(0, 11), 'UNEXPECTED_RADAR'];
  const {audit} = fixture({radarIds});
  assert.equal(audit.status, 'DEGRADED');
  assert.equal(audit.summary.registered_radars, 12);
  assert.equal(audit.summary.radar_role_coverage_ready, false);
  assert.ok(audit.summary.missing_radar_roles.includes('PROFESSOR_RADAR'));
  assert.ok(audit.summary.unexpected_radar_roles.includes('UNEXPECTED_RADAR'));
  assert.ok(audit.readiness_reasons.includes('RADAR_ROLE_COVERAGE_INCOMPLETE'));
});
