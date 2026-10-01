import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyBackendState, isFreshLiveSignal, isFreshLiveState } from './app/src/main/assets/radarx-backend-client.mjs';

const freshSignal = {
  status: 200,
  body: {
    signal: { data_status: { data_stale: false, data_valid: true, last_error: null } },
    meta: { live: true, paper_trading: true, real_order_execution: false, confidence_score: 'UNKNOWN' }
  }
};
const ready503 = {
  status: 503,
  ok: false,
  body: { reason: 'SNAPSHOT_STALE', data_stale: true, data_valid: false, last_error: 'SNAPSHOT_STALE' }
};

assert.equal(isFreshLiveSignal(freshSignal), true);
assert.equal(isFreshLiveState({ health: { status: 200 }, readiness: ready503, signal: freshSignal }), true);
assert.equal(classifyBackendState({ health: { status: 200 }, readiness: ready503, signal: freshSignal }), 'LIVE_DATA');

const staleSignal = {
  status: 200,
  body: {
    signal: { data_status: { data_stale: true, data_valid: false, last_error: 'SNAPSHOT_STALE' } },
    meta: { live: true, paper_trading: true, real_order_execution: false, confidence_score: 'UNKNOWN' }
  }
};
assert.equal(classifyBackendState({ health: { status: 200 }, readiness: ready503, signal: staleSignal }), 'DATA_STALE');
assert.equal(classifyBackendState({ health: { status: 500 }, readiness: { status: 500 }, signal: { status: 500 } }), 'DISCONNECTED');
assert.equal(classifyBackendState({ health: { status: 0 }, readiness: { status: 200 }, signal: { status: 0 } }), 'DISCONNECTED');

const indexHtml = await readFile(new URL('./app/src/main/assets/index.html', import.meta.url), 'utf8');
assert.match(indexHtml, /id="retryBackend"/);
assert.match(indexHtml, /15000/);
assert.match(indexHtml, /catch\(error\)/);
assert.match(indexHtml, /scanInFlight/);
assert.match(indexHtml, /SCAN_COMPLETE/);
assert.match(indexHtml, /id="price"/);
assert.match(indexHtml, /RadarX scan error/);

console.log('backend-client regression tests passed');
