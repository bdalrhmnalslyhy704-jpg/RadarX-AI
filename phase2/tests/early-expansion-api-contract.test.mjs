import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApiServer} from '../http/api.mjs';
import {DurableStore} from '../core/store.mjs';
import {NoopPushProvider} from '../push/index.mjs';
import {EarlyExpansionRadar,emptyEarlyExpansionSnapshot} from '../core/early-expansion-radar.mjs';

const config={
  quote:'USDT',
  auth:{secret:'TEST_FIXTURE_AUTH_SECRET',allowedOrigins:[]},
  api:{maxBodyBytes:65536,rateLimitPerMinute:100},
  earlyExpansionRadar:{quote:'USDT'}
};
const monitor={health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})};

function keyShape(body){
  return Object.keys(body).sort();
}

test('Radar 8 API contract is identical before and after first scan and honors query quote',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-radar8-api-contract-'));
  const store=await new DurableStore({dir}).init();
  const radar=new EarlyExpansionRadar({rest:{},store,config:{quote:'USDT'}});
  const server=createApiServer({config,store,monitor,pushProvider:new NoopPushProvider(),earlyExpansionRadar:radar});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const beforeRes=await fetch(base+'/api/early-expansion-radar?quote=USDT&limit=100');
    assert.equal(beforeRes.status,200);
    const before=await beforeRes.json();

    const baseSnapshot=emptyEarlyExpansionSnapshot(radar.config,'USDT');
    radar.lastResult={
      ...baseSnapshot,
      as_of:new Date(1700000000000).toISOString(),
      universe:{
        ...baseSnapshot.universe,
        expected_total:900,received_total:890,missing_ticker_total:10,
        eligible_total:700,fast_scanned_total:700,scanned_total:700,
        deep_scanned_total:10,skipped_total:690,failed_total:2,
        coverage_ratio:890/900,eligible_coverage_ratio:700/890,deep_coverage_ratio:10/700,
        failed_symbols:['FAILUSDT']
      }
    };
    radar.latestCandidates=[{symbol:'AAAUSDT',decision_band:'PRE_EXPANSION',early_expansion_score:84}];
    radar.running=true;
    const afterRes=await fetch(base+'/api/early-expansion-radar?quote=USDT&limit=100');
    assert.equal(afterRes.status,200);
    const after=await afterRes.json();

    assert.deepEqual(keyShape(before),keyShape(after));
    for(const body of [before,after]){
      assert.equal(body.schema_version,'RADAR8_V1');
      assert.equal(body.radar,'EARLY_EXPANSION_RADAR');
      assert.equal(body.quote,'USDT');
      assert.equal(body.meta.paper_trading,true);
      assert.equal(body.meta.real_order_execution,false);
      assert.equal(body.meta.confidence_score,'UNKNOWN');
      assert.equal(body.universe.scope,'ALL_ELIGIBLE_SPOT_USDT');
      for(const key of ['expected_total','received_total','missing_ticker_total','eligible_total','fast_scanned_total','scanned_total','deep_scanned_total','skipped_total','failed_total','coverage_ratio','deep_coverage_ratio'])assert.ok(Object.hasOwn(body.universe,key),key);
      for(const key of ['running','last_scan_at','failed_total','poll_ms','deep_candidates','deep_concurrency'])assert.ok(Object.hasOwn(body.monitoring,key),key);
      for(const key of ['requested','completed','error'])assert.ok(Object.hasOwn(body.scan,key),key);
      for(const key of ['min_alert_score','min_pre_expansion_score','min_breakout_developing_score'])assert.ok(Object.hasOwn(body.thresholds,key),key);
    }
    assert.equal(after.universe.expected_total,900);
    assert.equal(after.universe.missing_ticker_total,10);

    const mismatch=await fetch(base+'/api/early-expansion-radar?quote=BTC&limit=100');
    assert.equal(mismatch.status,400);
    assert.equal((await mismatch.json()).error,'QUOTE_NOT_CONFIGURED');
  }finally{
    await new Promise(r=>server.close(r));
  }
});

test('Radar 8 API unavailable state still preserves the paper-only contract',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-radar8-api-contract-unavailable-'));
  const store=await new DurableStore({dir}).init();
  const server=createApiServer({config,store,monitor,pushProvider:new NoopPushProvider(),earlyExpansionRadar:null});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/early-expansion-radar?quote=USDT&limit=100');
  assert.equal(res.status,503);
  const body=await res.json();
  assert.equal(body.meta.paper_trading,true);
  assert.equal(body.meta.real_order_execution,false);
  assert.equal(body.meta.confidence_score,'UNKNOWN');
  await new Promise(r=>server.close(r));
});
