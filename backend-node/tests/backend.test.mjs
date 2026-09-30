import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('public backend is Node/WebSocket and read-only', async () => {
  const s = await fs.readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(s, /from 'node:http'/);
  assert.match(s, /from 'ws'/);
  assert.match(s, /\/healthz/);
  assert.match(s, /\/readyz/);
  assert.match(s, /BINANCE_BASES/);
  assert.match(s, /paper_trading:true/);
  assert.match(s, /real_order_execution:false/);
  assert.doesNotMatch(s, /apiKey|apiSecret|secret|API_KEY|API_SECRET/);
  assert.doesNotMatch(s, /createOrder|placeOrder|withdraw/i);
});

test('public backend never returns cached market data as live after source failure', async () => {
  const s = await fs.readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(s, /LIVE_DATA_UNAVAILABLE/);
  assert.match(s, /live:false/);
  assert.match(s, /state\.lastError/);
});
