import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd();
async function read(p){return fs.readFile(path.join(root,p),'utf8')}
async function readJson(p){return JSON.parse(await read(p))}

test('manifest is valid PWA metadata',async()=>{
  const m=await readJson('phase1/manifest.json');
  assert.equal(m.name,'RadarX Phase 1');
  assert.equal(m.short_name,'RadarX');
  assert.equal(m.dir,'rtl');
  assert.equal(m.lang,'ar');
  assert.equal(m.display,'standalone');
  assert.equal(m.start_url,'./app.html');
  assert.equal(m.scope,'./');
  assert.equal(m.theme_color,'#071018');
  assert.equal(m.background_color,'#071018');
  assert.ok(Array.isArray(m.icons)&&m.icons.length>=3);
  for(const icon of m.icons){assert.match(icon.src,/^\.\/icons\/.+\.svg$/);assert.match(icon.type,/image\/svg\+xml/)}
});

test('app registers service worker and exposes connection semantics',async()=>{
  const a=await read('phase1/app.html');
  assert.match(a,/navigator\.serviceWorker\.register\(['"]\.\/sw\.js['"]\)/);
  assert.match(a,/LIVE_DATA/);
  assert.match(a,/DISCONNECTED/);
  assert.match(a,/last_successful_update/);
  assert.match(a,/window\.addEventListener\(['"]offline['"]/);
});

test('service worker caches shell but does not cache exchange API responses',async()=>{
  const sw=await read('phase1/sw.js');
  assert.match(sw,/caches\.open\(CACHE_NAME\)/);
  assert.match(sw,/caches\.match\(['"]\.\/app\.html['"]\)/);
  assert.match(sw,/Never cache exchange market\/API responses/);
  assert.doesNotMatch(sw,/api\.binance\.com/);
  assert.doesNotMatch(sw,/\/api\/v3\/klines|\/api\/v3\/depth|ticker\/24hr/);
});

test('offline mode clears live cards and keeps historical metadata separated',async()=>{
  const a=await read('phase1/app.html');
  assert.match(a,/clearLiveView\(\)/);
  assert.match(a,/setStatus\('DISCONNECTED','Disconnected'\)/);
  assert.match(a,/last_successful_update/);
  assert.match(a,/LIVE_DATA/);
});

test('incomplete candle policy remains enforced by the engine',async()=>{
  const e=await read('phase1/radarx-phase1-engine.mjs');
  assert.match(e,/lastClosedIndex/);
  assert.match(e,/closed===true/);
  assert.match(e,/INCOMPLETE_CANDLE/);
});

test('real order execution stays disabled',async()=>{
  const e=await read('phase1/radarx-phase1-engine.mjs');
  const a=await read('phase1/app.html');
  assert.match(e,/real_order_execution:false/);
  assert.match(e,/allowsTradeEndpoints:false/);
  assert.doesNotMatch(a,/real_order_execution\s*[:=]\s*true/);
  assert.doesNotMatch(a,/createOrder|placeOrder|order\/cancel/i);
});