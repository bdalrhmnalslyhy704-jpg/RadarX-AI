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
const index=await readFile(new URL('./app/src/main/assets/index.html',import.meta.url),'utf8');
assert.match(index,/radarx-market-radar-screen.mjs/);
assert.match(index,/UI_READY/);
const moveService=await readFile(new URL('./app/src/main/java/com/radarx/app/RadarXBackgroundMonitorService.java',import.meta.url),'utf8');
assert.match(moveService,/detectedAt = alert\.optLong\("detected_at", alert\.optLong\("processed_at"/);
assert.match(moveService,/وقت اكتشاف الخادم/);
assert.match(moveService,/وقت إرسال الإشعار/);
assert.match(moveService,/عند انقطاع الإنترنت: حُفظ التنبيه على الخادم ثم أُرسل عند عودة الاتصال/);

const screen=await readFile(new URL('./app/src/main/assets/radarx-market-radar-screen.mjs',import.meta.url),'utf8');
assert.match(screen,/SCAN_COMPLETE/);
assert.match(screen,/Paper Trading/);
let falconRequestUrl='';
const falconResult=await getFalconEyeRadar({limit:5,since:123,scan:true},async(url,options)=>{
  falconRequestUrl=url;
  assert.equal(options.method,'GET');
  return {ok:true,status:200,json:async()=>({radar:'FALCON_EYE_RADAR',monitoring:{running:true}})};
});
assert.equal(falconResult.ok,true);
assert.match(falconRequestUrl,/\/api\/falcon-eye-radar\?limit=5&since=123&scan=1$/);

console.log('Android backend-client regression tests passed');

// Dashboard CI trigger; no runtime behavior.

const background = await readFile(new URL('./app/src/main/java/com/radarx/app/RadarXBackgroundMonitorService.java', import.meta.url), 'utf8');
assert.match(background,/api\/rotation-radar\?quote=USDT&limit=50/);
assert.match(background,/rotation_alert_cursor_at/);
assert.match(background,/CHANNEL_ROTATION_ALERTS/);
assert.match(background,/KAHIR_RADAR/);

const manifest = await readFile(new URL('./app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
const mainActivity = await readFile(new URL('./app/src/main/java/com/radarx/app/MainActivity.java', import.meta.url), 'utf8');
assert.match(manifest,/android:foregroundServiceType="dataSync\\|specialUse"/);
assert.match(manifest,/android:process=":radar_background"/);
// UI_READY is emitted from the WebView bridge and is verified by the native emulator smoke test, not by this source-level regression suite.
assert.equal(mainActivity.includes('BACKGROUND_START_DELAY_MS'),false);
assert.equal(mainActivity.includes('postDelayed(backgroundStartRunnable, BACKGROUND_START_DELAY_MS)'),false);
assert.match(mainActivity,/if \(isAllowedBackendUri\(request\.getUrl\(\)\)\)/);
assert.match(moveService,/manager\.getRunningServices\(Integer\.MAX_VALUE\)/);

