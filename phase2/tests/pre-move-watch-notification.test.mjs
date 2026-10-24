import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPreMoveWatchOnlyAlert} from '../http/api.mjs';
import {PushManager} from '../push/index.mjs';
import {DurableStore} from '../core/store.mjs';
import {SignalDeduplicator} from '../core/dedup.mjs';
import {defaultSettings} from '../core/signal-service.mjs';
import {pushSubscription} from './fixtures.mjs';

function fixture(now=Date.now()){
  const p={
    stage:'WATCH_EARLY',watch_only:true,actionable:false,evidence_complete:true,closed_candles_only:true,
    already_moved:false,session_close:now-60_000,score:72.2,session_return_pct:.98,one_hour_return_pct:2.11,
    volume_acceleration:.96,trade_acceleration:1.078,taker_buy_ratio:.552,taker_buy_acceleration:.069,
    mean_close_location:.82,relative_strength_vs_market_pct:2.18,
    components:{squeeze:23.3,structure:76.4,buying_pressure:67.1},
    reasons:['TRADE_COUNT_ACCELERATING','TAKER_BUY_ACCELERATING','RELATIVE_STRENGTH']
  };
  const candidate={
    symbol:'DASHUSDT',last_price:51.31,price_change_24h:-4.628,data_quality:100,liquidity_quality:97.56,
    data_status:{data_valid:true,data_stale:false,stale:false,future_data_detected:false},
    watch_only:true,alert_eligible:false,watch_reason_codes:['VOLUME_ACCELERATION_NOT_CONFIRMED'],
    risk_flags:[],pre_move_context:p
  };
  const snapshot={source:'Binance Public REST',meta:{radar:'PRE_MOVE',live:true,paper_trading:true,real_order_execution:false}};
  return {candidate,snapshot,now};
}

test('Build 224 converts qualified Pre-Move WATCH_EARLY into a non-entry watch alert only',()=>{
  const {candidate,snapshot,now}=fixture();
  const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
  assert.ok(alert);
  assert.equal(alert.event,'PRE_MOVE_RADAR_WATCH_ONLY');
  assert.equal(alert.radar,'PRE_MOVE');
  assert.equal(alert.symbol,'DASHUSDT');
  assert.equal(alert.watch_only,true);
  assert.equal(alert.entry_eligible,false);
  assert.equal(alert.closed_candles_only,true);
  assert.equal(alert.paper_trading,true);
  assert.equal(alert.real_order_execution,false);
  assert.equal(alert.detected_candle_close_time,now-60_000);
});

test('Pre-Move watch creation fails closed for stale, incomplete, extended, or low-confluence observations',()=>{
  const base=fixture();
  assert.equal(buildPreMoveWatchOnlyAlert({...base.candidate,data_status:{data_valid:false}},base.snapshot,base.now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...base.candidate,pre_move_context:{...base.candidate.pre_move_context,session_close:base.now-21*60_000}},base.snapshot,base.now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...base.candidate,price_change_24h:13},base.snapshot,base.now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...base.candidate,pre_move_context:{...base.candidate.pre_move_context,already_moved:true}},base.snapshot,base.now),null);
  assert.equal(buildPreMoveWatchOnlyAlert({...base.candidate,pre_move_context:{...base.candidate.pre_move_context,trade_acceleration:.5,taker_buy_ratio:.48,taker_buy_acceleration:0,mean_close_location:.3,relative_strength_vs_market_pct:-1}},base.snapshot,base.now),null);
  assert.equal(buildPreMoveWatchOnlyAlert(base.candidate,{...base.snapshot,meta:{...base.snapshot.meta,live:false}},base.now),null);
});

test('Pre-Move watch notification sends only as WATCH_ONLY and suppresses repeat delivery',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-pre-move-watch-'));
  const store=await new DurableStore({dir}).init();
  try{
    await store.putUserSettings('u1',{...defaultSettings(),enabled:true,minDataQuality:70,minLiquidityQuality:60});
    await store.upsertSubscription('u1',pushSubscription());
    const sent=[];
    const provider={status:()=>({provider:'TEST_FIXTURE',enabled:true}),async send(sub,payload){
      sent.push(payload);return{ok:true,status:'SENT',httpStatus:201};
    }};
    const manager=new PushManager({provider,store,deduplicator:new SignalDeduplicator({store,windowMs:15*60*1000})});
    const {candidate,snapshot,now}=fixture();
    const alert=buildPreMoveWatchOnlyAlert(candidate,snapshot,now);
    assert.ok(alert);
    const first=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(first.status,'SENT',JSON.stringify(first));
    assert.equal(first.sent_count,1);
    assert.equal(sent.length,1);
    assert.equal(sent[0].watch_only,true);
    assert.equal(sent[0].entry_eligible,false);
    assert.equal(sent[0].paper_trading,true);
    assert.equal(sent[0].real_order_execution,false);
    assert.match(sent[0].title,/رادار ما قبل الحركة/);
    const second=await manager.notifyRadarWatchOnlyAlert(alert);
    assert.equal(second.status,'DUPLICATE_SUPPRESSED');
    assert.equal(sent.length,1);
    const audits=await store.readRecent('notifications',10);
    assert.equal(audits.filter(x=>x.event==='RADAR_WATCH_ONLY_NOTIFICATION'&&x.symbol==='DASHUSDT').length,1);
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});
