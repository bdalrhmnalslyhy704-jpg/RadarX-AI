import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiServer} from '../http/api.mjs';
import {NoopPushProvider} from '../push/index.mjs';

test('TEST_FIXTURE: rotation radar endpoint exposes independent read-only feed',async()=>{
  const calls=[];
  const store={
    readRotationAlerts:async({sinceMs,limit})=>{
      calls.push({sinceMs,limit});
      return [{id:'ROTATION:TESTUSDT:UP_ROTATION:1',event:'ROTATION_LAG_ALERT',symbol:'TESTUSDT',
        radar:'ROTATION_LAG_RADAR',eligible:true,processed_at:2,opportunity_score:81,
        paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}];
    }
  };
  const rotationLagRadar={health:()=>({
    running:true,radar:'ROTATION_LAG_RADAR',universe:100,scans:12,alerts_emitted:1,
    algorithms:['CROSS_MARKET_LEAD_LAG','SILENT_VOLUME_PRICE_DISLOCATION'],closed_candles_only:true
  })};
  const monitor={health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})};
  const config={
    auth:{secret:'TEST_FIXTURE_AUTH_SECRET',allowedOrigins:[]},
    api:{maxBodyBytes:65536,rateLimitPerMinute:100},
    rotationRadar:{minScore:78,minConfirmations:4}
  };
  const server=createApiServer({config,store,monitor,pushProvider:new NoopPushProvider(),rotationLagRadar});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  try{
    const response=await fetch('http://127.0.0.1:'+port+'/api/rotation-radar?since=1&limit=10');
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.meta.radar,'ROTATION_LAG_RADAR');
    assert.equal(body.meta.paper_trading,true);
    assert.equal(body.meta.real_order_execution,false);
    assert.equal(body.meta.confidence_score,'UNKNOWN');
    assert.equal(body.monitoring.running,true);
    assert.deepEqual(body.thresholds,{min_score:78,min_confirmations:4,market:'SPOT',primary_timeframe:'15m',confirmation_timeframe:'1h'});
    assert.equal(body.alerts[0].symbol,'TESTUSDT');
    assert.equal(calls.length,1);
    assert.equal(calls[0].sinceMs,1);
    assert.equal(calls[0].limit,10);
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});
