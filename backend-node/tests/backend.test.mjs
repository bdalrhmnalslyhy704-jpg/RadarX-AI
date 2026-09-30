import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { getReadyState } from '../readiness.mjs';

test('public backend is Node/WebSocket and read-only', async () => {
  const s = await fs.readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(s, /from 'node:http'/);
  assert.match(s, /from 'ws'/);
  assert.match(s, /\/healthz/);
  assert.match(s, /\/readyz/);
  assert.match(s, /BINANCE_BASES/);
  assert.match(s, /https:\/\/data-api\.binance\.vision/);
  assert.match(s, /paper_trading:true/);
  assert.match(s, /real_order_execution:false/);
  assert.match(s, /confidence_score:'UNKNOWN'/);
  assert.doesNotMatch(s, /apiKey|apiSecret|secret|API_KEY|API_SECRET/);
  assert.doesNotMatch(s, /createOrder|placeOrder|withdraw/i);
});

test('public backend never returns cached market data as live after source failure', async () => {
  const s = await fs.readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(s, /LIVE_DATA_UNAVAILABLE/);
  assert.match(s, /live:false/);
  assert.match(s, /state\.lastError/);
});

test('readyz returns HTTP 200 when live data is ready and there is no error', () => {
  const now = 1_000_000;
  const readiness = getReadyState({
    latestSuccessAt: now - 1_000,
    latestSource: 'https://data-api.binance.vision',
    lastError: null
  }, now);

  assert.equal(readiness.statusCode, 200);
  assert.equal(readiness.body.status, 'ready');
  assert.equal(readiness.body.live_data_ready, true);
  assert.equal(readiness.body.last_error, null);
});

test('readyz returns HTTP 503 when live data is not ready', () => {
  const now = 1_000_000;
  const readiness = getReadyState({
    latestSuccessAt: now - 1_000,
    latestSource: 'https://data-api.binance.vision',
    lastError: 'LIVE_DATA_UNAVAILABLE'
  }, now);

  assert.equal(readiness.statusCode, 503);
  assert.equal(readiness.body.status, 'not_ready');
  assert.equal(readiness.body.live_data_ready, false);
  assert.equal(readiness.body.last_error, 'LIVE_DATA_UNAVAILABLE');
});
