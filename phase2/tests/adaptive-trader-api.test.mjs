import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApiServer} from '../http/api.mjs';
import {DurableStore} from '../core/store.mjs';
import {NoopPushProvider} from '../push/index.mjs';

async function start({provider}={}) {
  const dir=await mkdtemp(join(tmpdir(),'radarx-adaptive-trader-api-'));
  const store=await new DurableStore({dir}).init();
  const config={auth:{secret:'TEST_FIXTURE_AUTH_SECRET',allowedOrigins:[]},api:{maxBodyBytes:65536,rateLimitPerMinute:100}};
  const monitor={health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})};
  const server=createApiServer({
    config,store,monitor,pushProvider:new NoopPushProvider(),
    ...(provider?{adaptiveTraderSnapshotProvider:provider}:{}),
    ...(worker?{adaptiveTraderWorker:worker}:{})
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {dir,store,server,base:'http://127.0.0.1:'+server.address().port};
}
const goodSnapshot={
  status:'LIVE_DATA',source:'Binance Public REST',as_of:new Date().toISOString(),
  universe:{eligible_spot_symbols:150,analyzed_symbols:40,valid_symbols:39,requested_limit:40,coverage_pct:26.7,scan_complete:false},
  candidates:[{symbol:'TESTUSDT',data_valid:true,data_stale:false,score:72,tier:'WATCH',entry_eligible:false,
    paper_trading:true,real_order_execution:false,closed_candles_only:true}],
  latest_prices:[{symbol:'TESTUSDT',price:1,quote_volume_24h:1000000,change_24h_pct:1}],
  meta:{live:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
    closed_candles_only:true,engine:'ADAPTIVE_TRADER_SIDECAR_V1',execution:'DISABLED',
    learning_scope:'LOCAL_DEVICE_PAPER_OUTCOMES_ONLY'}
};

test('adaptive trader market endpoint is read-only and bounds the requested universe',async()=>{
  const calls=[];
  const {dir,store,server,base}=await start({provider:async({limit})=>{calls.push(limit);return {...goodSnapshot,universe:{...goodSnapshot.universe,requested_limit:limit}};}});
  try{
    const response=await fetch(base+'/api/adaptive-trader/market-snapshot?limit=999');
    assert.equal(response.status,200);
    const snapshot=await response.json();
    assert.equal(calls.length,1);
    assert.equal(calls[0],120);
    assert.equal(snapshot.meta.real_order_execution,false);
    assert.equal(snapshot.meta.paper_trading,true);
    assert.equal(snapshot.meta.engine,'ADAPTIVE_TRADER_SIDECAR_V1');
    assert.equal(snapshot.candidates[0].entry_eligible,false);
    assert.equal((await store.getSubscriptions()).length,0);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  }
});

test('adaptive trader endpoint fails closed if sidecar is not configured',async()=>{
  const {dir,server,base}=await start();
  try{
    const response=await fetch(base+'/api/adaptive-trader/market-snapshot');
    assert.equal(response.status,503);
    const body=await response.json();
    assert.equal(body.status,'DATA_UNAVAILABLE');
    assert.equal(body.meta.real_order_execution,false);
    assert.deepEqual(body.candidates,[]);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  }
});

test('adaptive trader endpoint does not fabricate results when market fetch fails',async()=>{
  const {dir,server,base}=await start({provider:async()=>{throw new Error('TEST_FIXTURE_BINANCE_UNAVAILABLE');}});
  try{
    const response=await fetch(base+'/api/adaptive-trader/market-snapshot?limit=40');
    assert.equal(response.status,502);
    const body=await response.json();
    assert.equal(body.status,'DATA_UNAVAILABLE');
    assert.equal(body.error,'ADAPTIVE_TRADER_MARKET_DATA_FETCH_FAILED');
    assert.deepEqual(body.candidates,[]);
    assert.equal(body.meta.real_order_execution,false);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  }
});


test('adaptive trader status exposes the independent background worker with read-only policy',async()=>{
  const worker={snapshot:()=>({
    status:'RUNNING',enabled:true,running:true,in_flight:false,scan_count:5,successful_scans:5,
    interval_ms:300000,last_scan_at:new Date().toISOString(),last_error:null,
    learning_profile:{ready:false,resolved_samples:4,adjustments:{volume:0,buyer_flow:0,structure:0,compression:0}},
    missed_movers:[{id:'TESTUSDT:1',symbol:'TESTUSDT',classification:'UNASSESSED_MOVE',move_pct:5.5}],
    memory:{resolved_samples:4,unresolved_samples:16,history_rows:100,potential_missed_movers:0},
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
  })};
  const {dir,server,base}=await start({worker});
  try{
    const response=await fetch(base+'/api/adaptive-trader/status');
    assert.equal(response.status,200);
    const value=await response.json();
    assert.equal(value.service,'RADARX_ADAPTIVE_TRADER_SIDECAR');
    assert.equal(value.status,'RUNNING');
    assert.equal(value.interval_ms,300000);
    assert.equal(value.real_order_execution,false);
    assert.equal(value.paper_trading,true);
    assert.equal(value.missed_movers[0].classification,'UNASSESSED_MOVE');
  }finally{
    await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  }
});
