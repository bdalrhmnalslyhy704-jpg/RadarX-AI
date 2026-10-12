import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const service = await readFile('android/app/src/main/java/com/radarx/app/RadarXBackgroundMonitorService.java', 'utf8');
const main = await readFile('android/app/src/main/java/com/radarx/app/MainActivity.java', 'utf8');
const replayFixture = await readFile('android/background-replay-test-server.mjs', 'utf8');
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
assert.match(service, /notifyNewRadarAlerts\(JSONArray alerts, boolean oldestFirst, boolean cursorAdvanceAllowed\)/,
  'notifications must preserve oldest-first replay order after reconnect');
assert.match(service, /persistDurableAlertCursor\(at, replayKey, seen\)/,
  'the durable replay cursor must advance only after each individual event has been handled');
assert.match(service, /private boolean persistDurableAlertCursor\(long at, String replayKey, Set<String> seen\)/,
  'cursor checkpoint persistence must return a success state');
assert.match(service, /\.putStringSet\("radar_alert_seen_ids", seen\)[\s\S]*?\.putStringSet\("radar_alert_pending_notification_ids", pending\)[\s\S]*?\.commit\(\)/,
  'each handled event must atomically persist its compound cursor and clear its pending notification reservation');
assert.match(service, /if \(!persistDurableAlertCursor\(at, replayKey, seen\)\)/,
  'replay must stop when local cursor persistence fails');
assert.doesNotMatch(service, /maxAt = Math\.max\(cursor, nextCursor\.optLong\("since", cursor\)\)/,
  'the page next_cursor must never leap past events that have not been posted or safely skipped');
assert.match(service, /private boolean notifyRadarAlert\(JSONObject alert\)/,
  'the notification post operation must report whether Android accepted the request');
assert.match(service, /manager\.areNotificationsEnabled\(\)/,
  'disabled Android notifications must leave the current alert pending');
assert.match(service, /manager\.getNotificationChannel\(CHANNEL_RADAR_ALERTS\)/,
  'the service must inspect the alert channel before advancing the durable cursor');
assert.match(service, /channel\.getImportance\(\) == NotificationManager\.IMPORTANCE_NONE/,
  'a disabled notification channel must leave the current alert pending');
assert.match(service, /if \(!notifyRadarAlert\(alert\)\)/,
  'an alert that cannot be posted must stop page processing without skipping its cursor');
assert.match(service, /if \(identity\.isEmpty\(\)\)/,
  'rows without a source id must still receive a stable compound cursor identity');
assert.match(service, /ALERT_POST_REQUEST_ACCEPTED/,
  'logs must distinguish NotificationManager acceptance from actual device delivery');
assert.ok(service.includes('alert.optString("replay_cursor_id", "")'),
  'notification identity must follow the compound cursor for rows that lack a source id');
assert.ok(service.includes('testFeed.matches("http://10\\\\.0\\\\.2\\\\.2:18[0-9]{3}/api/radar-alerts\\\\?radar=ALL")'),
  'the local replay test feed must be restricted to the emulator host and radar-alert route');
assert.ok(service.includes('isDebugBuild() && testFeed.matches'),
  'release builds must never honor the debug replay fixture URL');
assert.ok(main.includes('FLAG_DEBUGGABLE') && main.includes('REPLAY_TEST_OVERRIDE_CONFIGURED'),
  'MainActivity must gate and report persisted debug-only test overrides');
assert.ok(main.includes('"10.0.2.2"') && main.includes('intervalMs <= 5000L'),
  'test override must restrict its host and polling interval');
assert.ok(replayFixture.includes('length: 623') && replayFixture.includes('replay_cursor_id') &&
  replayFixture.includes('emptyRequests') && replayFixture.includes('queuedRequests'),
  'the replay fixture must generate more than 500 ordered events and expose outage/reconnect counters');


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
assert.ok(service.includes('radar_alert_fallback_seen_ids') && service.includes('fallbackSeen.contains(replayKey)'),
  'fallback notifications must be de-duplicated against the later durable replay');
assert.ok(service.includes('meta.put("feed_mode", "NON_DURABLE_LEGACY_FALLBACK")'),
  'legacy 200 responses must be treated as bounded non-durable feeds');
assert.ok(service.includes('at > 0L && at >= cursor'),
  'fallback must not omit events with the current timestamp when stable IDs differ');
assert.ok(service.includes('sortAlertsChronologically(root)') && service.includes('root.put("oldest_first", true)'),
  'bounded fallback candidates must be notified in chronological order without moving the durable cursor');
