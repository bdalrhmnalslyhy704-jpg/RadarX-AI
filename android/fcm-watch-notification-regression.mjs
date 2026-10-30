import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [service,push,mainActivity,registration,dashboard]=await Promise.all([
  readFile(new URL('./app/src/main/java/com/radarx/app/RadarXFirebaseMessagingService.java',import.meta.url),'utf8'),
  readFile(new URL('../phase2/push/index.mjs',import.meta.url),'utf8'),
  readFile(new URL('./app/src/main/java/com/radarx/app/MainActivity.java',import.meta.url),'utf8'),
  readFile(new URL('./app/src/main/java/com/radarx/app/RadarXPushRegistration.java',import.meta.url),'utf8'),
  readFile(new URL('./app/src/main/assets/index.html',import.meta.url),'utf8')
]);


test('Android dashboard exposes registration status and device-receipt verification without exposing FCM credentials',()=>{
  assert.ok(mainActivity.includes('getPushStatus()'));
  assert.ok(mainActivity.includes('syncPushRegistration()'));
  assert.ok(mainActivity.includes('refreshPushStatus()'));
  assert.ok(mainActivity.includes('requestPushTest()'));
  assert.ok(dashboard.includes('fcmDiagnosticsCard'));
  assert.ok(dashboard.includes('fcmRefreshButton'));
  assert.ok(dashboard.includes('fcmTestButton'));
  assert.ok(dashboard.includes('DEVICE_RECEIPT_VERIFIED'));
  assert.ok(registration.includes('/api/push/device/status?'));
  assert.ok(registration.includes('/api/push/device/test'));
  assert.ok(registration.includes('registration_state'));
  assert.ok(registration.includes('delivery_verified'));
  const statusMethod=registration.slice(registration.indexOf('static String statusJson('),registration.indexOf('static void refreshServerStatus('));
  assert.ok(statusMethod.includes('firebase_configured'));
  assert.ok(statusMethod.includes('registered'));
  assert.ok(!statusMethod.includes('fcm_token'));
  assert.ok(!statusMethod.includes('token"'));
});

test('Android whitelists only the bounded, Spot, non-entry Pre-Move monitor event',()=>{
  const start=service.indexOf('private static boolean isApprovedPreMoveWatch(');
  const end=service.indexOf('private static double numericValue(',start);
  assert.ok(start>=0&&end>start,'the FCM watch allow-list helper exists');
  const helper=service.slice(start,end);
  for(const field of [
    'PRE_MOVE_RADAR_WATCH_ONLY','RADARX_RADAR_ALERT','PRE_MOVE_WATCH_ONLY',
    'HIGH_ACTIVITY_STRUCTURE_PENDING','EARLY_FLOW_MONITOR',
    'TICKER_ACTIVITY_ACCELERATION_MONITOR','ACCUMULATION_PREP_MONITOR',
    'COMPRESSED_BUYER_ABSORPTION_MONITOR','SPOT','WATCH_ONLY',
    'closed_candles_only','data_valid','data_stale','future_data_detected',
    'data_quality','liquidity_quality','paper_trading','real_order_execution',
    'requires_follow_up_confirmation','symbol.matches','unsafeRisk'
  ]) assert.ok(helper.includes(field),'FCM allow-list requires '+field);
  assert.match(helper,/entry_eligible", "true"\)\)/);
  assert.match(helper,/notification_gate_eligible", "true"\)\)/);
  assert.match(helper,/dataQuality >= 70\.0 && liquidityQuality >= 60\.0 && price > 0\.0/);
});

test('Android allows only the dedicated verified Radar early-track monitor-only FCM lane',()=>{
  const start=service.indexOf('private static boolean isApprovedRadarEarlyTrackWatch(');
  const end=service.indexOf('private static double numericValue(',start);
  assert.ok(start>=0&&end>start,'the FCM early-track allow-list helper exists');
  const helper=service.slice(start,end);
  for(const field of [
    'RADAR_WATCH_ONLY_EARLY_TRACK','RADAR_ALERT','RADARX_RADAR_ALERT',
    'RADAR_EARLY_TRACK_WATCH_ONLY','SPOT','WATCH_ONLY','closed_candles_only',
    'data_valid','data_stale','future_data_detected','data_quality','liquidity_quality',
    'price_change_24h','paper_trading','real_order_execution','requires_follow_up_confirmation',
    'symbol.matches','isTrustedBinancePublicSpotSource','unsafeRisk'
  ]) assert.ok(helper.includes(field),'early-track FCM allow-list requires '+field);
  assert.match(helper,/dailyMove >= -5\.0 && dailyMove <= 7\.0/);
  assert.match(helper,/entry_eligible", "true"\)\)/);
  assert.match(helper,/notification_gate_eligible", "true"\)\)/);
  assert.match(helper,/dataQuality >= 70\.0 && liquidityQuality >= 60\.0 && price > 0\.0/);
});

test('All other unconfirmed or generic watch events still pass through the original strict suppression gate',()=>{
  assert.match(service,/if \(!explicitTest && !approvedPreMoveWatch && !approvedRadarEarlyTrackWatch &&\s*\(watchOnly \|\| watchEvent \|\| !risingDirection \|\| !entryEligible \|\|\s*!notificationGateEligible \|\| followUpRequired \|\| lifecycleConflicts \|\| !finalConfirmation\)\)/);
  assert.ok(service.includes('FCM_MESSAGE_SUPPRESSED_WATCH_OR_UNCONFIRMED'));
  assert.ok(service.includes('FCM_PRE_MOVE_WATCH_NOTIFICATION_POSTED'));
});

test('FCM data payload forwards every field required by the device-side allow-list',()=>{
  const start=push.indexOf('for(const key of [',push.indexOf('export class FcmPushProvider'));
  const end=push.indexOf(']){',start);
  assert.ok(start>=0&&end>start,'FCM data whitelist is present');
  const whitelist=push.slice(start,end);
  for(const field of [
    'watch_notification_tier','closed_candles_only','data_valid','data_stale',
    'future_data_detected','data_quality','liquidity_quality','notification_gate_mode',
    'notification_gate_eligible','requires_follow_up_confirmation','watch_only',
    'entry_eligible','real_order_execution','paper_trading'
  ]) assert.ok(whitelist.includes("'"+field+"'"),'FCM payload forwards '+field);
});
