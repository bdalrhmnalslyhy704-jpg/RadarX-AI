import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';

test('TEST_FIXTURE: durable settings subscriptions and audit jsonl survive a fresh read',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-store-'));
  const store=await new DurableStore({dir}).init();
  const settings={enabled:true,symbols:['BTCUSDT'],timeframes:['15m'],minDataQuality:70,minLiquidityQuality:60,signalTypes:['CONFIRMED']};
  await store.putUserSettings('u1',settings);
  assert.equal((await store.getUserSettings('u1')).enabled,true);
  await store.upsertSubscription('u1',{endpoint:'https://push.example.test/x',expirationTime:null,keys:{p256dh:'TEST_FIXTURE_P256DH',auth:'TEST_FIXTURE_AUTH'}});
  assert.equal((await store.getSubscriptions('u1')).length,1);
  await store.appendNotificationAudit({signal_id:'TEST_FIXTURE',user_id:'u1',status:'SENT'});
  const rows=await store.readRecent('notifications',10);
  assert.equal(rows[0].signal_id,'TEST_FIXTURE');assert.equal(rows[0].status,'SENT');
});


test('TEST_FIXTURE: Radar 4 alert log survives fresh reads',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-radar4-store-'));
  const store=await new DurableStore({dir}).init();
  const alert={id:'TEST_RADAR4',event:'LIQUIDITY_ABSORPTION_ALERT',radar:'LIQUIDITY_ABSORPTION_RADAR',symbol:'TESTUSDT',processed_at:Date.now(),detected_time_12h:'12:00:01 ص'};
  await store.appendLiquidityAbsorptionAlert(alert);
  const rows=await store.readLiquidityAbsorptionAlerts({sinceMs:0,limit:10});
  assert.equal(rows.length,1);assert.equal(rows[0].radar,'LIQUIDITY_ABSORPTION_RADAR');assert.equal(rows[0].symbol,'TESTUSDT');
});
