import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const service = await readFile('android/app/src/main/java/com/radarx/app/RadarXBackgroundMonitorService.java', 'utf8');
const api = await readFile('phase2/http/api.mjs', 'utf8');
const store = await readFile('phase2/core/store.mjs', 'utf8');

assert.match(service, /\/api\/falcon-eye-radar\?since=/,
  'native background monitoring must query Radar 9 history directly');
assert.match(service, /mergeFalconEyeHistory\(root, cursor\)/,
  'Radar 9 history must be merged into the primary feed');
assert.match(service, /radar_alert_cursor_initialized/,
  'first-run history cursor must be initialized without replaying old notifications');
assert.match(service, /HEARTBEAT_KEY/,
  'the monitor must distinguish a live service from stale SharedPreferences');
assert.match(service, /السعر وقت الكشف/,
  'notifications must include the recorded detection price');
assert.match(service, /detected_time_12h/,
  'notifications must include the original detection time');
assert.match(service, /السجل الدائم عند عودة الاتصال/,
  'offline status must explain that durable server history is checked after reconnect');
assert.doesNotMatch(service, /حُفظ التنبيه على الخادم ثم أُرسل عند عودة الاتصال/,
  'offline status must not claim that an alert was saved when that is not verified');

assert.match(api, /u\.pathname===['"]\/api\/falcon-eye-radar['"]/,
  'server must expose Falcon Eye history endpoint');
assert.match(api, /readFalconEyeAlerts/,
  'Falcon Eye endpoint must read durable alert history');
assert.match(store, /async readFalconEyeAlerts/,
  'Radar 9 history must be stored/read through DurableStore');

console.log('Background monitoring regression checks passed: Radar 9 replay, durable cursor, stale monitor recovery, detection price/time, and truthful offline status.');

assert.match(service, /oldest_first=1&since_id=/,
  'background sync must request chronological replay pages from its durable cursor');
assert.match(service, /radar_alert_cursor_id/,
  'equal-timestamp detections must be paginated without advancing past unseen alerts');
assert.match(service, /notifyNewRadarAlerts\(JSONArray alerts, boolean oldestFirst, JSONObject nextCursor, boolean cursorAdvanceAllowed\)/,
  'notifications must preserve oldest-first replay order after reconnect');

assert.match(service, /getRunningAppProcesses\(\)/,
  'a fresh stored heartbeat must not be treated as proof that Android still has the background process');
assert.match(service, /getPackageName\(\)\s*\+\s*":radar_background"/,
  'background recovery must specifically verify the dedicated service process after force-stop');
assert.ok(service.includes('manager.notify(notificationIdentity, notificationId, builder.build())'),
  'distinct archived alert IDs must have distinct notification identities rather than overwriting each other by symbol');
assert.ok(service.includes('/api/whale-accumulation-radar?quote=USDT&limit=50'),
  'individual-endpoint fallback must include Whale Accumulation');
assert.ok(service.includes('meta.put("cursor_advance_allowed", false)'),
  'non-durable fallback feeds must not advance the durable replay cursor');
assert.ok(service.includes('radar_alert_fallback_seen_ids') && service.includes('fallbackSeen.contains(id)'),
  'fallback notifications must be de-duplicated against the later durable replay');
assert.ok(service.includes('meta.put("feed_mode", "NON_DURABLE_LEGACY_FALLBACK")'),
  'legacy 200 responses must be treated as bounded non-durable feeds');
assert.ok(service.includes('at > 0L && at >= cursor'),
  'fallback must not omit events with the current timestamp when stable IDs differ');
assert.ok(service.includes('sortAlertsChronologically(root)') && service.includes('root.put("oldest_first", true)'),
  'bounded fallback candidates must be notified in chronological order without moving the durable cursor');
