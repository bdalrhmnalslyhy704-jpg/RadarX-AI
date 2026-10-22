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


test('TEST_FIXTURE: validated Radar 8 early-flow watch is pushed as monitor-only with evidence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-verified-watch-push-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70});
  await store.upsertSubscription('u1',pushSubscription());
  const sent=[];
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};}};
  const manager=new PushManager({provider,store});
  const now=Date.now();
  const alert={
    id:'RADAR8_EARLY_FLOW_WATCH:TESTUSDT:'+String(now-1000),
    event:'EARLY_FLOW_WATCH_ONLY',radar:'EARLY_EXPANSION_RADAR',radar_name:'Radar 8 — البرق',
    symbol:'TESTUSDT',market:'SPOT',direction:'UP_BIAS',price:1.01,price_change_24h:1.2,
    source:'Binance Public REST',watch_only:true,entry_eligible:false,data_stale:false,
    early_flow_watch_evidence:{
      closed_candles_only:true,closed_candle_close_time:now-1000,
      micro_score:68,confirmation_count:4,rvol_1m:1.6,rvol_5m:1.3,
      trade_rvol_1m:1.4,trade_rvol_5m:1.2,taker_buy_ratio:.55,
      acceleration_1m_pct:.03,acceleration_5m_pct:.04,return_1m:.02,return_5m:.05
    },
    risk_flags:['LOW_LIQUIDITY_WATCH_ONLY'],reason_codes:['MICRO_EARLY_FLOW']
  };
  const out=await manager.notifyRadarWatchOnlyAlert(alert);
  assert.equal(out.status,'SENT');
  assert.equal(out.sent_count,1);
  assert.equal(sent.length,1);
  assert.equal(sent[0].notification_mode,'WATCH_ONLY_EARLY_TRACK');
  assert.equal(sent[0].watch_only,true);
  assert.equal(sent[0].requires_follow_up_confirmation,true);
  assert.equal(sent[0].message,'TESTUSDT • مراقبة مبكرة فقط — تحتاج تأكيدًا');
  assert.equal(sent[0].entry_eligible,undefined,'watch notifications do not become entry-eligible signals');
  assert.equal(sent[0].early_flow_watch_evidence.micro_score,68);
  const audits=await store.readRecent('notifications',10);
  assert.ok(audits.some(x=>x.event==='RADAR_WATCH_ONLY_NOTIFICATION'&&x.status==='SENT'&&x.watch_only===true));
});

test('TEST_FIXTURE: Radar 8 watch push fails closed on stale or incomplete evidence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-invalid-watch-push-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true});
  await store.upsertSubscription('u1',pushSubscription());
  let calls=0;
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(){calls++;return{ok:true,status:'SENT'};}};
  const manager=new PushManager({provider,store});
  const out=await manager.notifyRadarWatchOnlyAlert({
    event:'EARLY_FLOW_WATCH_ONLY',radar:'EARLY_EXPANSION_RADAR',symbol:'STALEUSDT',
    watch_only:true,entry_eligible:false,price:1,price_change_24h:1,source:'Binance Public REST',
    early_flow_watch_evidence:{closed_candles_only:true,closed_candle_close_time:Date.now()-300_000,
      micro_score:90,confirmation_count:6,rvol_1m:2.5,trade_rvol_1m:2.0,acceleration_1m_pct:.3}
  });
  assert.equal(out.status,'BLOCKED_INVALID_WATCH_EVIDENCE');
  assert.equal(calls,0);
});

test('TEST_FIXTURE: missing radar data quality fails closed instead of inheriting 100',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-radar-missing-dq-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70});
  await store.upsertSubscription('u1',pushSubscription());
  let calls=0;
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(){calls++;return{ok:true,status:'SENT'};}};
  const m=new PushManager({provider,store});
  const out=await m.notifyRadarAlert({radar:'ROTATION_LAG_RADAR',symbol:'MISSINGDQUSDT',direction:'UP_ROTATION',eligible:true});
  assert.equal(out.length,0);
  assert.equal(calls,0);
});

test('TEST_FIXTURE: nested Al-Muqawim quality is honored by the shared push filter',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-radar-nested-dq-')),store=await new DurableStore({dir}).init();
  await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70});
  await store.upsertSubscription('u1',pushSubscription());
  const sent=[];
  const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){sent.push(payload);return{ok:true,status:'SENT'};}};
  const m=new PushManager({provider,store});
  const out=await m.notifyRadarAlert({radar:'ALMUQAWIM_RADAR',symbol:'RESILIENTUSDT',direction:'UP',almuqawim:{data_quality:88}});
  assert.equal(out.length,1);
  assert.equal(sent.length,1);
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

