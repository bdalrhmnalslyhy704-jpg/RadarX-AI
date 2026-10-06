import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DurableStore} from '../core/store.mjs';

test('DurableStore preserves main data and Radar 8 persistence without data loss',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-store-r8-'));
  try{
    const store=await new DurableStore({dir}).init();
    const legacySubscription=await store.upsertSubscription('legacy-user',{
      endpoint:'https://example.test/legacy',
      keys:{p256dh:'legacy-p256dh',auth:'legacy-auth'}
    });
    const legacySettings=await store.putUserSettings('legacy-user',{theme:'legacy',radar:'legacy'});
    const legacyDedup={scope:'legacy',seen:true};
    await store.putDedupKey('legacy-key',legacyDedup);
    await store.putSignalSnapshot('BTCUSDT',{signal_id:'legacy-signal',symbol:'BTCUSDT',price:{reference:100}});
    await store.appendSignalAudit({id:'legacy-signal',processed_at:1000});
    await store.appendNotificationAudit({id:'legacy-notification',processed_at:1000});

    const now=Date.now();
    await store.appendEarlyExpansionAlert({
      id:'r8-alert-1',radar:'EARLY_EXPANSION_RADAR',symbol:'BTCUSDT',processed_at:now,detected_at:now,decision_band:'PRE_EXPANSION'
    });
    await store.appendEarlyExpansionEvent({
      id:'r8-event-1',radar:'EARLY_EXPANSION_RADAR',symbol:'BTCUSDT',processed_at:now,detected_at:now,event_type:'CANDIDATE'
    });

    const subscriptions=await store.getSubscriptions('legacy-user');
    assert.equal(subscriptions.length,1);
    assert.equal(subscriptions[0].id,legacySubscription.id);
    assert.deepEqual(await store.getUserSettings('legacy-user'),legacySettings);
    assert.deepEqual(await store.getDedupKey('legacy-key'),legacyDedup);
    assert.equal((await store.getSignalSnapshot('BTCUSDT')).signal_id,'legacy-signal');
    assert.equal((await store.readRecent('signals',10))[0].id,'legacy-signal');
    assert.equal((await store.readRecent('notifications',10))[0].id,'legacy-notification');

    const alerts=await store.readEarlyExpansionAlerts({sinceMs:now-1,limit:10});
    const events=await store.readEarlyExpansionEvents({sinceMs:now-1,limit:10});
    assert.equal(alerts.length,1);
    assert.equal(alerts[0].id,'r8-alert-1');
    assert.equal(events.length,1);
    assert.equal(events[0].id,'r8-event-1');

    const persistedAlertText=await readFile(join(dir,'early-expansion-alerts.jsonl'),'utf8');
    const persistedEventText=await readFile(join(dir,'early-expansion-events.jsonl'),'utf8');
    assert.match(persistedAlertText,/r8-alert-1/);
    assert.match(persistedEventText,/r8-event-1/);
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});
