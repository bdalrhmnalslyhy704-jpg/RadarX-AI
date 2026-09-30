import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { computeFreshness, buildDataStatus } from '../freshness.mjs';
import { getReadyState } from '../readiness.mjs';

const now = 1_000_000;

test('public backend is Node/WebSocket, read-only, Binance REST fallback, and never uses mock data', async () => {
  const s = await fs.readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(s, /from 'node:http'/);
  assert.match(s, /from 'ws'/);
  assert.match(s, /\/healthz/);
  assert.match(s, /\/readyz/);
  assert.match(s, /BINANCE_BASES/);
  assert.match(s, /https:\/\/data-api\\.binance\\.vision/);
  assert.match(s, /paper_trading:true/);
  assert.match(s, /real_order_execution:false/);
  assert.match(s, /confidence_score:'UNKNOWN'/);
  assert.doesNotMatch(s, /apiKey|apiSecret|secret|API_KEY|API_SECRET/);
  assert.doesNotMatch(s, /createOrder|placeOrder|withdraw/i);
  assert.doesNotMatch(s, /mock/i);
  assert.doesNotMatch(s, /cached/i);
  assert.doesNotMatch(s, /proxy|vpn/i);
});

test('readyz fresh snapshot -> HTTP 200 and body.status ready', () => {
  const readiness = getReadyState({
    latestSuccessAt: now - 1_000,
    latestDataValid: true,
    latestClosedCandle: now - 300_000,
    latestSource: 'https://data-api.binance.vision',
    lastError: null
  }, now);
  assert.equal(readiness.statusCode, 200);
  assert.equal(readiness.body.status, 'ready');
  assert.equal(readiness.body.live_data_ready, true);
  assert.equal(readiness.body.data_stale, false);
  assert.equal(readiness.body.fetch_age_ms, 1_000);
  assert.equal(readiness.body.candle_age_ms, 300_000);
});

test('readyz stale snapshot -> HTTP 503 and never body.status ready', () => {
  const readiness = getReadyState({
    latestSuccessAt: now - 120_001,
    latestDataValid: true,
    latestClosedCandle: now - 300_000,
    latestSource: 'https://data-api.binance.vision',
    lastError: null
  }, now);
  assert.equal(readiness.statusCode, 503);
  assert.equal(readiness.body.status, 'not_ready');
  assert.equal(readiness.body.live_data_ready, false);
  assert.equal(readiness.body.data_stale, true);
  assert.notEqual(readiness.statusCode === 503 && readiness.body.status === 'ready', true);
});

test('readyz fetch error -> HTTP 503', () => {
  const readiness = getReadyState({
    latestSuccessAt: now - 1_000,
    latestDataValid: true,
    latestClosedCandle: now - 60_000,
    latestSource: 'https://data-api.binance.vision',
    lastError: 'ALL_DATA_SOURCES_FAILED'
  }, now);
  assert.equal(readiness.statusCode, 503);
  assert.equal(readiness.body.status, 'not_ready');
  assert.equal(readiness.body.last_error, 'ALL_DATA_SOURCES_FAILED');
  assert.equal(readiness.body.live_data_ready, false);
});

test('stale closed 15m candle alone does not make transport stale', () => {
  const freshness = computeFreshness({
    latestSuccessAt: now - 1_000,
    latestDataValid: true,
    latestClosedCandle: now - 10 * 60_000,
    source: 'https://data-api.binance.vision',
    lastError: null
  }, now);
  assert.equal(freshness.candleAgeMs, 600_000);
  assert.equal(freshness.snapshotFresh, true);
  assert.equal(freshness.dataStale, false);
  assert.equal(freshness.live, true);
});

test('signal stale -> data_status stale and live false', () => {
  const status = buildDataStatus({
    base: {gaps:false,future_data_detected:false},
    latestSuccessAt: now - 120_001,
    latestDataValid: true,
    latestClosedCandle: now - 600_000,
    source: 'https://data-api.binance.vision',
    lastError: null,
    now
  });
  assert.equal(status.stale, true);
  assert.equal(status.data_stale, true);
  const metaLive = !status.stale && status.data_valid === true && status.last_error === null;
  assert.equal(metaLive, false);
});

test('signal fresh -> data_status fresh and live true', () => {
  const status = buildDataStatus({
    base: {gaps:false,future_data_detected:false},
    latestSuccessAt: now - 1_000,
    latestDataValid: true,
    latestClosedCandle: now - 600_000,
    source: 'https://data-api.binance.vision',
    lastError: null,
    now
  });
  assert.equal(status.stale, false);
  assert.equal(status.data_stale, false);
  const metaLive = !status.stale && status.data_valid === true && status.last_error === null;
  assert.equal(metaLive, true);
});

test('invalid data is never live', () => {
  const status = buildDataStatus({
    base: {gaps:true,future_data_detected:false},
    latestSuccessAt: now - 1_000,
    latestDataValid: false,
    latestClosedCandle: now - 60_000,
    source: 'https://data-api.binance.vision',
    lastError: 'INVALID_MARKET_DATA',
    now
  });
  assert.equal(status.stale, true);
  assert.equal(status.data_valid, false);
  assert.equal(status.last_error, 'INVALID_MARKET_DATA');
});

test('readiness contract has no HTTP 503 + ready combination', () => {
  for (const state of [
    {latestSuccessAt:now-1_000,latestDataValid:true,lastError:null},
    {latestSuccessAt:now-120_001,latestDataValid:true,lastError:null},
    {latestSuccessAt:now-1_000,latestDataValid:false,lastError:'INVALID_MARKET_DATA'},
    {latestSuccessAt:0,latestDataValid:false,lastError:null}
  ]) {
    const r = getReadyState(state, now);
    assert.equal(r.body.status === 'ready', r.statusCode === 200);
    assert.equal(r.statusCode === 503 ? r.body.status : r.body.status, r.body.status);
    assert.notEqual(r.statusCode === 503 && r.body.status === 'ready', true);
  }
});

test('diagnostic fields are present and do not expose secrets', async () => {
  const readinessSource = await fs.readFile(new URL('../readiness.mjs', import.meta.url), 'utf8');
  assert.match(readinessSource, /latest_successful_update/);
  assert.match(readinessSource, /fetch_age_ms/);
  assert.match(readinessSource, /latest_closed_candle/);
  assert.match(readinessSource, /candle_age_ms/);
  assert.match(readinessSource, /data_stale/);
  assert.match(readinessSource, /source/);
  assert.match(readinessSource, /last_error/);
  assert.doesNotMatch(readinessSource, /apiKey|apiSecret|API_KEY|API_SECRET/);
});
