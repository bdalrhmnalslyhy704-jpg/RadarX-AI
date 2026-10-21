import assert from 'node:assert/strict';
import test from 'node:test';

// Validate built-in defaults independently of a deployment's environment.
delete process.env.BINANCE_WS_URLS;
delete process.env.BINANCE_REST_URLS;

const {CONFIG} = await import('../config.mjs?market-data-endpoint-defaults');

test('default Spot WebSocket endpoints use the official public market-data stream', () => {
  assert.deepEqual(CONFIG.websocket.urls, [
    'wss://data-stream.binance.vision/stream',
    'wss://stream.binance.com:9443/stream'
  ]);
  assert.deepEqual(CONFIG.moveRadar.websocket.urls, [
    'wss://data-stream.binance.vision/stream',
    'wss://stream.binance.com:9443/stream'
  ]);
});

test('default Spot REST endpoints use the official public market-data REST endpoint', () => {
  assert.deepEqual(CONFIG.rest.urls, [
    'https://data-api.binance.vision'
  ]);
});

test('deployment endpoint overrides remain honored', async () => {
  process.env.BINANCE_WS_URLS = 'wss://custom-market-data.example/stream';
  process.env.BINANCE_REST_URLS = 'https://custom-market-data.example';
  const {CONFIG: overridden} = await import('../config.mjs?market-data-endpoint-override');
  assert.deepEqual(overridden.websocket.urls, [
    'wss://custom-market-data.example/stream',
    'wss://data-stream.binance.vision/stream',
    'wss://stream.binance.com:9443/stream'
  ]);
  assert.deepEqual(overridden.moveRadar.websocket.urls, [
    'wss://custom-market-data.example/stream',
    'wss://data-stream.binance.vision/stream',
    'wss://stream.binance.com:9443/stream'
  ]);
  assert.deepEqual(overridden.rest.urls, ['https://custom-market-data.example']);
});
