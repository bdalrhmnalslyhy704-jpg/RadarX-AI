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

test('market scan requests a persisted server worker cycle and waits for real completion',()=>{
  assert.match(html,/\/api\/adaptive-trader\/scan/);
  assert.match(html,/method:'POST'/);
  assert.match(html,/JSON\.stringify\(\{limit:limit\}\)/);
  assert.match(html,/successful_scans/);
  assert.match(html,/worker\.in_flight!==false/);
  assert.match(html,/ADAPTIVE_TRADER_SCAN_COOLDOWN/);
  assert.match(html,/SERVER_SCAN_RESULT_NOT_VERIFIED/);
  assert.doesNotMatch(html,/\/api\/adaptive-trader\/market-snapshot\?limit=/);
});

test('adaptive trader UI has visible data coverage and paper-only status',()=>{
  assert.match(html,/kpiEligible/);
  assert.match(html,/kpiScanned/);
  assert.match(html,/coverage_pct/);
  assert.match(html,/SERVER_SCAN_RESULT_NOT_VERIFIED|ADAPTIVE_TRADER_WORKER_SCAN_FAILED|DATA_UNAVAILABLE/);
  assert.match(html,/real_order_execution/);
  assert.match(html,/لا مفاتيح API/);
  assert.match(html,/تغطية جزئية/);
});

test('dashboard consumes the verified server worker snapshot and reports network or CORS failure',()=>{
  assert.match(html,/value\.last_summary/);
  assert.match(html,/BACKEND_NETWORK_OR_CORS_UNAVAILABLE/);
  assert.match(html,/successful_scans/);
  assert.match(html,/آخر نجاح/);
});

test('offline learning placeholder uses the same 60-result threshold as the server',()=>{
  assert.match(client,/minSamples\\s*=\\s*60/);
  assert.match(html,/Number\\(model\\.required_samples\\)\\|\\|60/);
});

test('server learning profile is preferred even when its resolved sample count is zero',()=>{
  assert.match(html,/if\(remote&&typeof remote==='object'\)return remote/);
  assert.match(html,/return buildAdaptiveLearningProfile\(\[\]\)/);
  assert.doesNotMatch(html,/resolveLearningSamples\(snapshot,now\)/);
  assert.match(html,/const resolvedCount=state\.serverStatus&&state\.serverStatus\.learning_profile/);
  assert.match(html,/لقطات السوق الواسعة للتدقيق فقط/);
  assert.doesNotMatch(html,/if\(remote&&\(remote\.ready===true\|\|\(Number\(remote\.resolved_samples\)\|\|0\)>0\)\)return remote/);
});

test('dashboard shows already-extended movers in a separate audit-only list, never as entry candidates',()=>{
  assert.match(html,/moverAuditList/);
  assert.match(html,/function renderMoverAudit\(\)/);
  assert.match(html,/mover_audit/);
  assert.match(html,/LATE_MOVE/);
  assert.match(html,/paper_candidate===false/);
  assert.match(html,/entry_eligible===false/);
  assert.match(html,/real_order_execution===false/);
  assert.match(html,/حركة ممتدة — لا مطاردة/);
  assert.match(html,/تدقيق فقط/);
});

test('dashboard distinguishes push-provider status from actual device delivery',()=>{
  assert.match(html,/value\.notification_transport/);
  assert.match(html,/fcm_devices/);
  assert.match(html,/لا يوجد جهاز مسجّل/);
  assert.match(html,/الاستلام الفعلي غير مثبت/);
  assert.match(html,/مزود إشعارات الهاتف/);
});

test('server owns the recurring scan loop; page visibility only polls status',()=>{
  assert.match(html,/setInterval\(function\(\)\{if\(document\.visibilityState==='visible'\)void refreshWorkerStatus\(\);\},15\*1000\)/);
  assert.doesNotMatch(html,/setInterval\(function\(\)\{if\(document\.visibilityState==='visible'&&!scanBusy\)void scanMarket\(\);\},5\*60\*1000\)/);
  assert.doesNotMatch(html,/setTimeout\(function\(\)\{if\(document\.visibilityState==='visible'\)void scanMarket\(\);\},500\)/);
});

test('sidecar client contains no exchange order execution endpoint or secret storage',()=>{
  assert.doesNotMatch(client,/\/api\/v3\/order/);
  assert.doesNotMatch(client,/newOrder|createOrder|apiSecret|secretKey|BINANCE_API_SECRET/i);
  assert.match(client,/real_order_execution\s*!==\s*false/);
});
