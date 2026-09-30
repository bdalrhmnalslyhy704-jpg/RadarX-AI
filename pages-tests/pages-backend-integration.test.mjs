import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  DEFAULT_BACKEND_BASE_URL,
  fetchBackendState,
  isFreshLiveSignal,
  isFreshLiveState,
  classifyBackendState
} from '../radarx-backend-client.mjs';

test('fresh Backend state can be LIVE_DATA', async () => {
  const fresh = {
    health:{status:200},
    readiness:{status:200,body:{data_stale:false,data_valid:true,last_error:null}},
    signal:{
      status:200,
      body:{
        signal:{data_status:{data_stale:false,data_valid:true,last_error:null}},
        meta:{live:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}
      }
    }
  };
  assert.equal(isFreshLiveSignal(fresh.signal), true);
  assert.equal(isFreshLiveState(fresh), true);
  assert.equal(classifyBackendState(fresh), 'LIVE_DATA');
});

test('readiness 503 blocks LIVE_DATA even when signal is fresh', () => {
  const state = {
    health:{status:200},
    readiness:{status:503,body:{status:'not_ready',data_stale:true,data_valid:true,last_error:null,reason:'SNAPSHOT_STALE'}},
    signal:{
      status:200,
      body:{
        signal:{data_status:{data_stale:false,data_valid:true,last_error:null}},
        meta:{live:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}
      }
    }
  };
  assert.equal(isFreshLiveState(state), false);
  assert.equal(classifyBackendState(state), 'DATA_STALE');
});

test('Backend 503 is DATA_STALE or DISCONNECTED, never LIVE_DATA', () => {
  const state = {
    health:{status:200},
    readiness:{status:503,body:{data_stale:true,reason:'SNAPSHOT_STALE'}},
    signal:{status:503,body:{signal:{data_status:{data_stale:true,data_valid:true,last_error:null}}}}
  };
  assert.notEqual(classifyBackendState(state), 'LIVE_DATA');
  assert.equal(classifyBackendState(state), 'DATA_STALE');
});

test('frontend requests only Backend endpoints', async () => {
  const calls = [];
  const bodies = [
    {status:200,body:{status:'ok',paper_trading:true,real_order_execution:false}},
    {status:200,body:{status:'ready',live_data_ready:true,data_stale:false,data_valid:true,last_error:null}},
    {status:200,body:{
      signal:{data_status:{data_stale:false,data_valid:true,last_error:null}},
      meta:{live:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}
    }}
  ];
  const fetchMock = async url => {
    calls.push(url);
    const next = bodies.shift();
    return {status:next.status,ok:true,async json(){return next.body;}};
  };
  const state = await fetchBackendState(DEFAULT_BACKEND_BASE_URL,'BTCUSDT',fetchMock);
  assert.deepEqual(calls,[
    'https://radarx-ai-production.up.railway.app/healthz',
    'https://radarx-ai-production.up.railway.app/readyz',
    'https://radarx-ai-production.up.railway.app/api/signal?symbol=BTCUSDT'
  ]);
  assert.equal(isFreshLiveState(state),true);
});

test('static frontend has no direct Binance or market-data cache fallback', async () => {
  const index = await fs.readFile(new URL('../index.html', import.meta.url),'utf8');
  const sw = await fs.readFile(new URL('../sw.js', import.meta.url),'utf8');
  const manifest = await fs.readFile(new URL('../manifest.json', import.meta.url),'utf8');

  assert.ok(index.includes('./radarx-backend-client.mjs'));
  assert.equal(index.includes('BinancePublicData'),false);
  assert.equal(index.includes('api.binance.com'),false);
  assert.equal(index.includes('data-api.binance.vision'),false);
  assert.equal(sw.includes('api.binance.com'),false);
  assert.ok(sw.includes('url.origin !== self.location.origin'));
  assert.equal(sw.includes('./app.html'),false);
  assert.ok(sw.includes('./radarx-backend-client.mjs'));
  assert.ok(manifest.includes('"start_url":"./index.html"'));
  assert.ok(manifest.includes('"id":"./index.html"'));
});

test('live display contract preserves paper-only metadata', () => {
  const unsafe = {
    status:200,
    body:{
      signal:{data_status:{data_stale:false,data_valid:true,last_error:null}},
      meta:{live:true,paper_trading:false,real_order_execution:false,confidence_score:'UNKNOWN'}
    }
  };
  assert.equal(isFreshLiveSignal(unsafe),false);
});
