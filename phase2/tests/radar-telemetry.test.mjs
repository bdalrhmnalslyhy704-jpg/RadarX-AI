import test from 'node:test';
import assert from 'node:assert/strict';
import {RadarTelemetry, renderRadarTelemetryDashboard} from '../core/radar-telemetry.mjs';

test('telemetry records latency, candle age, rejection reason, phase and liquidity acceleration', () => {
  let now = 1_800_000_000_000;
  const telemetry = new RadarTelemetry({capacity: 100, clock: () => now});
  const event = telemetry.recordDecision({
    id: 'STRONG:GTCUSDT', radar: 'STRONG_MOVE_RADAR', symbol: 'GTCUSDT',
    observed_at: now - 15, source_event_at: now - 1_015,
    opportunity_score: 88, potential_label: 'EXPLOSIVE', price: 0.42,
    rest_queue_depth: 2, rest_queue_wait_ms: 9,
    strong_move: {metrics: {liquidity_acceleration: {three_minute_acceleration: 2.75}}}
  }, {eligible: false, score: 86, failures: ['ELITE_GATE_NOT_ELIGIBLE', 'LOW_CATEGORY_DIVERSITY']}, {now});
  assert.equal(event.decision, 'REJECTED');
  assert.equal(event.stage_observed, 'EXPLOSIVE');
  assert.equal(event.pipeline_latency_ms, 15);
  assert.equal(event.source_data_age_ms, 1_015);
  assert.equal(event.liquidity_acceleration, 2.75);
  assert.equal(event.queue_depth, 2);
  assert.ok(event.reason_codes.includes('LOW_CATEGORY_DIVERSITY'));
  const snapshot = telemetry.snapshot({limit: 10});
  assert.equal(snapshot.summary.cycles, 1);
  assert.equal(snapshot.summary.rejected, 1);
  assert.equal(snapshot.summary.gate_accepted, 0);
  assert.equal(snapshot.by_radar[0].radar, 'STRONG_MOVE_RADAR');
  assert.equal(snapshot.top_rejection_reasons[0].reason, 'ELITE_GATE_NOT_ELIGIBLE');
  now += 5;
  telemetry.recordDecision({radar: 'EARLY_MOVE_RADAR', symbol: 'WUSDT', observed_at: now}, {eligible: true}, {now});
  assert.equal(telemetry.snapshot().summary.gate_accepted, 1);
});

test('telemetry ring buffer is bounded and reports missing ages as null, not zero', () => {
  const telemetry = new RadarTelemetry({capacity: 100, clock: () => 1_800_000_000_000});
  for (let i = 0; i < 130; i++) {
    telemetry.recordDecision({radar: 'RADAR_' + (i % 2), symbol: 'GTCUSDT', observed_at: 1_800_000_000_000 - i}, {
      eligible: i % 3 === 0, failures: i % 3 === 0 ? [] : ['TEST_REJECT']
    }, {now: 1_800_000_000_000});
  }
  const snapshot = telemetry.snapshot({limit: 500});
  assert.equal(snapshot.buffer_capacity, 100);
  assert.equal(snapshot.retained_events, 100);
  assert.equal(snapshot.total_recorded, 130);
  assert.equal(snapshot.events.length, 100);
  assert.equal(snapshot.events[0].source_event_at, null);
  assert.equal(snapshot.events[0].source_data_age_ms, null);
});

test('dashboard is RTL, reads telemetry endpoint and safely renders values as text', () => {
  const html = renderRadarTelemetryDashboard();
  assert.match(html, /dir="rtl"/);
  assert.match(html, /\/api\/radar-telemetry\?limit=80/);
  assert.match(html, /setInterval\(update,5000\)/);
  assert.match(html, /textContent/);
  assert.match(html, /ليس زمن الشبكة الكامل|ليس زمن الشبكة/);
  assert.match(html, /Spot \/ Paper Trading/);
});
