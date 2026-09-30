import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  DEFAULT_BACKEND_BASE_URL,
  normalizeBackendBaseUrl,
  fetchBackendState,
  isFreshLiveSignal,
  classifySignalResponse
} from '../../radarx-backend-client.mjs';

const freshSignal = {
  status: 200,
  body: {
    signal: {
      data_status: {
        data_stale: false,
        data_valid: true,
        last_error: null
      }
    },
    meta: {
      live: true,
      paper_trading: true,
      real_order_execution: false,
      confidence_score: 'UNKNOWN'
    }
  }
};

test('default backend base URL is Railway', () => {
  assert.equal(DEFAULT_BACKEND_BASE_URL, 'https://radarx-ai-production.up.railway.app');
});

test('fresh valid Backend 200 is LIVE_DATA', () => {
  assert.equal(isFreshLiveSignal(freshSignal), true);
  assert.equal(classifySignalResponse(freshSignal), 'LIVE_DATA');
});

test('Backend 503 with stale signal is DATA_STALE', () => {
  const response = {
    status: 503,
    body: {
      signal: {
        data_status: {
          data_stale: true,
          data_valid: true,
          last_error: null
        }
      }
    }
  };
  assert.equal(isFreshLiveSignal(response), false);
  assert.equal(classifySignalResponse(response), 'DATA_STALE');
});

test('stale data can never become LIVE_DATA', () => {
  const stale = {
    ...freshSignal,
    body: {
      ...freshSignal.body,
      signal: {
        data_status: {
          data_stale: true,
          data_valid: true,
          last_error: null
        }
      }
    }
  };
  assert.equal(isFreshLiveSignal(stale), false);
  assert.equal(classifySignalResponse(stale), 'DATA_STALE');
});

test('invalid data, errors, or unsafe trading flags cannot become LIVE_DATA', () => {
  for (const mutation of [
    { data_valid: false },
    { last_error: 'INVALID_MARKET_DATA' },
    { meta: { live: true, paper_trading: false, real_order_execution: false, confidence_score: 'UNKNOWN' } },
    { meta: { live: true, paper_trading: true, real_order_execution: true, confidence_score: 'UNKNOWN' } },
    { meta: { live: true, paper_trading: true, real_order_execution: false, confidence_score: 'HIGH' } }
  ]) {
    const body = JSON.parse(JSON.stringify(freshSignal.body));
    if (mutation.meta) body.meta = mutation.meta;
    else Object.assign(body.signal.data_status, mutation);
    assert.equal(isFreshLiveSignal({ status: 200, body }), false);
  }
});

test('fetchBackendState uses only Backend health, readiness, and signal endpoints', async () => {
  const calls = [];
  const responses = [
    { status: 200, body: { status: 'ok' } },
    { status: 503, body: { status: 'not_ready', reason: 'SNAPSHOT_STALE' } },
    freshSignal
  ];

  const fetchMock = async (url) => {
    calls.push(url);
    const next = responses.shift();
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      async json() { return next.body; }
    };
  };

  const result = await fetchBackendState(DEFAULT_BACKEND_BASE_URL, 'BTCUSDT', fetchMock);
  assert.deepEqual(calls, [
    'https://radarx-ai-production.up.railway.app/healthz',
    'https://radarx-ai-production.up.railway.app/readyz',
    'https://radarx-ai-production.up.railway.app/api/signal?symbol=BTCUSDT'
  ]);
  assert.equal(result.health.status, 200);
  assert.equal(result.readiness.status, 503);
  assert.equal(result.signal.status, 200);
  assert.equal(isFreshLiveSignal(result.signal), true);
});

test('frontend uses the Railway Backend and never calls Binance directly', async () => {
  const html = await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8');

  assert.ok(html.includes("from './radarx-backend-client.mjs'"));
  assert.ok(html.includes('https://radarx-ai-production.up.railway.app'));
  assert.ok(html.includes('fetchBackendState(base,symbol)'));
  assert.ok(html.includes("'/healthz'"));
  assert.ok(html.includes("'/readyz'"));
  assert.ok(html.includes("'/api/signal?symbol='"));

  assert.equal(html.includes('BinancePublicData'), false);
  assert.equal(html.includes('https://api.binance.com'), false);
  assert.equal(html.includes('https://data-api.binance.vision'), false);
  assert.equal(html.includes('radarx.phase1.last_success_metadata'), false);
  assert.ok(html.includes('Backend'));
  assert.ok(html.includes('Background monitoring'));
  assert.ok(html.includes('Not enabled'));
  assert.ok(html.includes('Push notifications'));
  assert.ok(html.includes('Not configured'));
  assert.ok(html.includes('Paper Signals only'));
});
