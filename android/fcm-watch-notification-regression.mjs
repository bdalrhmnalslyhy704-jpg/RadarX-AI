import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [service,push]=await Promise.all([
  readFile(new URL('./app/src/main/java/com/radarx/app/RadarXFirebaseMessagingService.java',import.meta.url),'utf8'),
  readFile(new URL('../phase2/push/index.mjs',import.meta.url),'utf8')
]);

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

test('All other unconfirmed or generic watch events still pass through the original strict suppression gate',()=>{
  assert.match(service,/if \(!explicitTest && !approvedPreMoveWatch &&\s*\(watchOnly \|\| watchEvent \|\| !risingDirection \|\| !entryEligible \|\|\s*!notificationGateEligible \|\| followUpRequired \|\| lifecycleConflicts \|\| !finalConfirmation\)\)/);
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
