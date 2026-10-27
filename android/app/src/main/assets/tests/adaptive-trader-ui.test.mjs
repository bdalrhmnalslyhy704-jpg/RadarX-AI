import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html=await readFile(new URL('../adaptive-trader.html',import.meta.url),'utf8');
const home=await readFile(new URL('../index.html',import.meta.url),'utf8');
const client=await readFile(new URL('../adaptive-trader-client.js',import.meta.url),'utf8');

test('standalone Arabic adaptive trader page is linked from the existing RadarX home screen',()=>{
  assert.match(html,/<html lang="ar" dir="rtl">/);
  assert.match(html,/ADAPTIVE TRADER/);
  assert.match(html,/فرص التي فاتت/);
  assert.match(html,/محاكاة الصفقات تلقائيًا/);
  assert.match(html,/ذاكرة التعلّم/);
  assert.match(html,/adaptive-trader-client\.js/);
  assert.match(home,/href="\.\/adaptive-trader\.html"/);
  assert.match(home,/openAdaptiveTraderBtn/);
});

test('adaptive trader UI has visible data coverage and paper-only status',()=>{
  assert.match(html,/kpiEligible/);
  assert.match(html,/kpiScanned/);
  assert.match(html,/coverage_pct/);
  assert.match(html,/LIVE_MARKET_DATA_NOT_VERIFIED|DATA_UNAVAILABLE/);
  assert.match(html,/real_order_execution/);
  assert.match(html,/لا مفاتيح API/);
  assert.match(html,/تغطية جزئية/);
});

test('sidecar client contains no exchange order execution endpoint or secret storage',()=>{
  assert.doesNotMatch(client,/\/api\/v3\/order/);
  assert.doesNotMatch(client,/newOrder|createOrder|apiSecret|secretKey|BINANCE_API_SECRET/i);
  assert.match(client,/real_order_execution\s*!==\s*false/);
});
