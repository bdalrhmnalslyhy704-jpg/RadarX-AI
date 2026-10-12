import assert from 'node:assert/strict';
import {classifyBackendState,isFreshLiveSignal,isFreshLiveState,getFalconEyeRadar} from './app/src/main/assets/radarx-backend-client.mjs';
import {readFile} from 'node:fs/promises';

const freshSignal={status:200,body:{signal:{data_status:{data_stale:false,data_valid:true,last_error:null}},meta:{live:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}}};
const ready503={status:503,ok:false,body:{reason:'SNAPSHOT_STALE',data_stale:true,data_valid:false,last_error:'SNAPSHOT_STALE'}};
assert.equal(isFreshLiveSignal(freshSignal),true);
assert.equal(isFreshLiveState({health:{status:200},readiness:ready503,signal:freshSignal}),true);
assert.equal(classifyBackendState({health:{status:200},readiness:ready503,signal:freshSignal}),'LIVE_DATA');
const staleSignal={status:200,body:{signal:{data_status:{data_stale:true,data_valid:false,last_error:'SNAPSHOT_STALE'}},meta:{live:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}}};
assert.equal(classifyBackendState({health:{status:200},readiness:ready503,signal:staleSignal}),'DATA_STALE');
assert.equal(classifyBackendState({health:{status:500},readiness:{status:500},signal:{status:500}}),'DISCONNECTED');
assert.equal(classifyBackendState({health:{status:0},readiness:{status:200},signal:{status:0}}),'DISCONNECTED');
let falconRequestUrl='';
const falconRead=await getFalconEyeRadar({limit:12,since:123,scan:false},async url=>{
  falconRequestUrl=String(url);
  return {ok:true,status:200,json:async()=>({radar:'FALCON_EYE_RADAR',
    candidates:[{symbol:'PLUMEUSDT',eligible:true}],alerts:[],
    monitoring:{running:true},scan:{requested:false,completed:true}})};
});
assert.equal(falconRead.ok,true);
assert.equal(falconRead.body.candidates[0].symbol,'PLUMEUSDT');
assert.match(falconRequestUrl,/\\/api\\/falcon-eye-radar\\?limit=12&since=123&scan=0/);
await assert.rejects(getFalconEyeRadar({limit:51,scan:false},async()=>({ok:true,status:200,json:async()=>({})})),/INVALID_LIMIT/);

const falconScreen=await readFile(new URL('./app/src/main/assets/radarx-radar-screen.mjs',import.meta.url),'utf8');
assert.match(falconScreen,/getFalconEyeRadar/);
assert.match(falconScreen,/مرشحون تحت المراقبة/);
assert.match(falconScreen,/data-c/);
assert.match(falconScreen,/getFalconEyeRadar\(\{limit:50,scan:false\}\)/);
assert.match(falconScreen,/ليس تنبيه شراء أو أمر تداول/);
const index=await readFile(new URL('./app/src/main/assets/index.html',import.meta.url),'utf8');
assert.match(index,/radarx-market-radar-screen.mjs/);
assert.match(index,/UI_READY/);
const moveService=await readFile(new URL('./app/src/main/java/com/radarx/app/RadarXBackgroundMonitorService.java',import.meta.url),'utf8');
assert.match(moveService,/detectedAt = alert\.optLong\("detected_at", alert\.optLong\("processed_at"/);
assert.match(moveService,/وقت اكتشاف الخادم/);
assert.match(moveService,/وقت إرسال الإشعار/);
assert.match(moveService,/السجل الدائم عند عودة الاتصال/);
assert.match(moveService,/السعر وقت الكشف/);
assert.doesNotMatch(moveService,/عند انقطاع الإنترنت: حُفظ التنبيه على الخادم ثم أُرسل عند عودة الاتصال/);

const screen=await readFile(new URL('./app/src/main/assets/radarx-market-radar-screen.mjs',import.meta.url),'utf8');
assert.match(screen,/SCAN_COMPLETE/);
assert.match(screen,/Paper Trading/);
console.log('Android backend-client regression tests passed');

// Dashboard CI trigger; no runtime behavior.

const background = await readFile(new URL('./app/src/main/java/com/radarx/app/RadarXBackgroundMonitorService.java', import.meta.url), 'utf8');
assert.match(background,/api\/rotation-radar\?quote=USDT&limit=50/);
assert.match(background,/rotation_alert_cursor_at/);
assert.match(background,/CHANNEL_ROTATION_ALERTS/);
assert.match(background,/KAHIR_RADAR/);

const tradliActivity = await readFile(new URL('./app/src/main/java/com/radarx/app/TradliActivity.java', import.meta.url), 'utf8');
assert.match(tradliActivity,/PRIMARY_BACKEND_ORIGIN\s*=\s*"https:\/\/radarx-ai-triple-production\.up\.railway\.app"/);
assert.match(tradliActivity,/FALLBACK_BACKEND_ORIGIN\s*=\s*"https:\/\/radarx-ai-production\.up\.railway\.app"/);
assert.match(tradliActivity,/PRIMARY_BACKEND_ORIGIN\.equalsIgnoreCase\(origin\)/);
assert.match(tradliActivity,/FALLBACK_BACKEND_ORIGIN\.equalsIgnoreCase\(origin\)/);
const manifest = await readFile(new URL('./app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
const mainActivity = await readFile(new URL('./app/src/main/java/com/radarx/app/MainActivity.java', import.meta.url), 'utf8');
assert.match(manifest,/android:foregroundServiceType="dataSync\\|specialUse"/);
assert.match(manifest,/android:process=":radar_background"/);
// UI_READY is emitted from the WebView bridge and is verified by the native emulator smoke test, not by this source-level regression suite.
assert.equal(mainActivity.includes('BACKGROUND_START_DELAY_MS'),false);
assert.equal(mainActivity.includes('postDelayed(backgroundStartRunnable, BACKGROUND_START_DELAY_MS)'),false);
