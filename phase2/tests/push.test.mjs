import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {PushManager,defaultSettings} from '../push/index.mjs';
import {pushSubscription} from './fixtures.mjs';

class ToggleProvider{
  constructor(){this.fail=true;this.calls=0;}
  status(){return{provider:'TEST_FIXTURE',enabled:true};}
  async send(){this.calls++;return this.fail?{ok:false,status:'FAILED',reason:'TEST_FIXTURE_PUSH_FAILURE'}:{ok:true,status:'SENT',httpStatus:201};}
}
function signal(){return{signal_id:'TEST_FIXTURE_SIGNAL',symbol:'BTCUSDT',market:'SPOT',strategy:'CONFIRMED_BREAKOUT',direction:'LONG',
  signal_type:'CONFIRMED',candle:{timeframe:'15m',close_time:1700000000000},price:{reference:100},scores:{data_quality:95,liquidity_quality:90},
  reason_codes:['CLOSE_ABOVE_RANGE'],confidence_score:'UNKNOWN'};}

test('TEST_FIXTURE: failed push is queued and succeeds after provider recovery',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-push-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{enabled:true,symbols:['BTCUSDT'],timeframes:['15m'],minDataQuality:70,minLiquidityQuality:60,signalTypes:['CONFIRMED']});
  await store.upsertSubscription('u1',pushSubscription());
  assert.equal((await store.getUserSettings('u1')).enabled,true);assert.equal((await store.getSubscriptions('u1')).length,1);
  const p=new ToggleProvider(),m=new PushManager({provider:p,store,retryBaseMs:1});
  const first=await m.notifySignal(signal());assert.equal(first[0].status,'FAILED');
  p.fail=false;await m.flushRetries(Date.now()+100);
  const events=await store.readRecent('notifications',10);
  assert.ok(events.some(x=>x.status==='SENT'));assert.ok(p.calls>=2);
});

test('TEST_FIXTURE: low data quality prevents push attempt',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-lowdq-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',defaultSettings());await store.upsertSubscription('u1',pushSubscription());
  assert.equal((await store.getSubscriptions()).length,1);
  const p=new ToggleProvider(),m=new PushManager({provider:p,store});
  const s={...signal(),scores:{data_quality:50,liquidity_quality:95}};
  const out=await m.notifySignal(s);
  assert.equal(out.length,0);assert.equal(p.calls,0);
});


test('TEST_FIXTURE: early radar watch pushes explicitly say monitoring only, not confirmation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-watch-push-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70});
  await store.upsertSubscription('u1',pushSubscription());
  const sent=[];
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){sent.push(payload);return{ok:true,status:'SENT'};}};
  const m=new PushManager({provider,store});
  await m.notifyRadarAlert({
    radar:'STRONG_MOVE_RADAR',radar_name:'Radar 2',symbol:'EARLYUSDT',data_quality:95,
    notification_gate:{eligible:true,watch_only:true,requires_follow_up_confirmation:true,mode:'RADAR_WATCH_ONLY_EARLY_TRACK'},
    signal_lifecycle:{state:'EARLY_SETUP',label:'إعداد مبكر',transition:'EARLY_EVIDENCE_CONVERGED',reason_codes:['RELATED_EARLY_EVIDENCE']}
  });
  assert.equal(sent.length,1);
  assert.equal(sent[0].notification_mode,'WATCH_ONLY_EARLY_TRACK');
  assert.equal(sent[0].watch_only,true);
  assert.equal(sent[0].requires_follow_up_confirmation,true);
  assert.equal(sent[0].message,'EARLYUSDT • مراقبة مبكرة فقط — تحتاج تأكيدًا');
  assert.match(sent[0].title,/مراقبة مبكرة/);
});

test('TEST_FIXTURE: radar notifications forward lifecycle labels and reasons to the push provider',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-lifecycle-push-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70});
  await store.upsertSubscription('u1',pushSubscription());
  const sent=[];
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){sent.push(payload);return{ok:true,status:'SENT'};}};
  const m=new PushManager({provider,store});
  await m.notifyRadarAlert({
    radar:'EARLY_EXPANSION_RADAR',radar_name:'Radar 8',symbol:'EARLYUSDT',data_quality:95,
    signal_lifecycle:{state:'EARLY_SETUP',label:'إعداد مبكر',transition:'EARLY_EVIDENCE_CONVERGED',reason_codes:['RELATED_EARLY_EVIDENCE']}
  });
  assert.equal(sent.length,1);
  assert.equal(sent[0].signal_lifecycle_state,'EARLY_SETUP');
  assert.equal(sent[0].signal_lifecycle_label,'إعداد مبكر');
  assert.equal(sent[0].signal_lifecycle_transition,'EARLY_EVIDENCE_CONVERGED');
  assert.deepEqual(sent[0].signal_lifecycle_reason_codes,['RELATED_EARLY_EVIDENCE']);
  assert.equal(sent[0].message,'EARLYUSDT • إعداد مبكر');
});

