import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApiServer} from '../http/api.mjs';
import {DurableStore} from '../core/store.mjs';
import {NoopPushProvider} from '../push/index.mjs';

function fixtureCandles(now=Date.now(),length=1000){
  const step=5*60*1000,rows=[];
  for(let i=0;i<length;i++){
    let close=100;
    if(i>=810&&i<=830)close=100*(1+0.12*(i-809)/21);
    else if(i>830)close=112;
    const priorFlow=i>=804,volume=priorFlow?220:100,tradeCount=priorFlow?32:20,taker=.61;
    const open=rows.length?rows[rows.length-1].close:close;
    const closeTime=now-(length-1-i)*step;
    rows.push({
      openTime:closeTime-step,closeTime,open,close,
      high:Math.max(open,close)*1.002,low:Math.min(open,close)*.998,
      volume,quoteVolume:volume*close,tradeCount,
      takerBuyBaseVolume:volume*taker,takerBuyQuoteVolume:volume*taker*close,closed:true
    });
  }
  return rows;
}

test('GET /api/early-mover-case-study returns bounded closed-candle diagnostics for the default crypto list',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-early-mover-case-study-api-'));
  const store=await new DurableStore({dir}).init();
  const candles=fixtureCandles(Date.now());
  const calls=[];
  const marketRest={
    baseUrls:['https://data-api.binance.vision'],
    klines:async(symbol,interval,options)=>{
      calls.push({symbol,interval,options});
      return {candles,source:'TEST_FIXTURE'};
    },
    request:async()=>({data:[],source:'TEST_FIXTURE'}),
    depth:async()=>({data:{bids:[],asks:[]},source:'TEST_FIXTURE'})
  };
  const config={
    auth:{secret:'TEST_FIXTURE_AUTH_SECRET',allowedOrigins:[]},
    api:{maxBodyBytes:65536,rateLimitPerMinute:100},
    marketRadar:{minQuoteVolume24h:750000}
  };
  const monitor={health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})};
  const server=createApiServer({config,store,monitor,pushProvider:new NoopPushProvider(),marketRadarRest:marketRest});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  server.unref();
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const response=await fetch(base+'/api/early-mover-case-study');
    assert.equal(response.status,200);
    const report=await response.json();
    assert.equal(report.report,'RADARX_EARLY_MOVER_CASE_STUDY_V1');
    assert.equal(report.results.length,6);
    assert.deepEqual(report.options.symbols,['HUMAUSDT','SYNUSDT','REZUSDT','ANIMEUSDT','PARTIUSDT','HAEDALUSDT']);
    assert.ok(report.results.every(row=>row.no_future_data_used===true));
    assert.ok(report.results.every(row=>row.status==='THRESHOLD_CROSSING_FOUND'));
    assert.ok(report.results.every(row=>
      row.intraday_runup && typeof row.intraday_runup.status==='string' &&
      Array.isArray(row.intraday_runup.lead_snapshots_before_runup)
    ));
    assert.ok(report.results.every(row=>
      Array.isArray(row.lead_snapshots_before_crossing)&&row.lead_snapshots_before_crossing.length===4
    ));
    assert.ok(report.results.every(row=>
      ['5m','15m','30m','60m','4h','24h'].every(horizon=>row.post_crossing_outcomes?.[horizon])
    ));
    assert.ok(calls.some(call=>call.symbol==='BTCUSDT'));
    assert.ok(calls.every(call=>call.interval==='5m'&&call.options.limit===1000&&Number.isFinite(call.options.endTime)));
    assert.equal(report.policy.real_order_execution,false);

    const invalid=await fetch(base+'/api/early-mover-case-study?symbols=SOXLB');
    assert.equal(invalid.status,400);
    const historicalAsOf=new Date(candles[980].closeTime).toISOString();
    const screenshotSymbols=[
      'PARTIUSDT','BEAMXUSDT','SOXSBUSDT','SOPHUSDT','SOLVUSDT','SKDDBUSDT',
      'LSKUSDT','NILUSDT','PUNDIXUSDT','UVXYBUSDT','KERNELUSDT','SQQQBUSDT','BREVUSDT'
    ];
    const screenshotAudit=await fetch(base+'/api/early-mover-case-study?symbols='+screenshotSymbols.join(',')+'&threshold_pct=5&window_hours=24&lead_minutes=60&as_of='+encodeURIComponent(historicalAsOf));
    assert.equal(screenshotAudit.status,200);
    const screenshotReport=await screenshotAudit.json();
    assert.equal(screenshotReport.report,'RADARX_EARLY_MOVER_CASE_STUDY_V1');
    assert.deepEqual(screenshotReport.options.symbols,screenshotSymbols);
    assert.equal(screenshotReport.results.length,13);
    assert.equal(screenshotReport.as_of,historicalAsOf);
    assert.ok(screenshotReport.results.every(row=>row.no_future_data_used===true));
    assert.ok(calls.some(call=>call.symbol==='SOXSBUSDT'));
    assert.ok(calls.some(call=>call.symbol==='SQQQBUSDT'));
    assert.ok(calls.some(call=>call.symbol==='PARTIUSDT'&&call.options.endTime===Date.parse(historicalAsOf)));

    const invalidTimestamp=await fetch(base+'/api/early-mover-case-study?symbols=HUMAUSDT&as_of=2099-01-01T00%3A00%3A00Z');
    assert.equal(invalidTimestamp.status,400);
  }finally{
    server.stopPreMoveWatchWorker?.();
    await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  }
});
