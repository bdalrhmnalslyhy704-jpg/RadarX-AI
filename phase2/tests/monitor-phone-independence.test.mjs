import test from 'node:test';
import assert from 'node:assert/strict';
import {MarketMonitor} from '../core/monitor.mjs';

const step={'4h':14400000,'1h':3600000,'15m':900000};
function candle(symbol,tf,openTime){
  const closeTime=openTime+step[tf]-1;
  return {symbol,timeframe:tf,openTime,closeTime,open:100,high:101,low:99,close:100.5,volume:1000,quoteVolume:100500,
    tradeCount:100,takerBuyBaseVolume:500,takerBuyQuoteVolume:50250,closed:true,source:'TEST_FIXTURE',sourceTime:closeTime};
}
class FakeRest{
  constructor(now){this.now=now;this.lastSuccessAt=now;}
  async klines(symbol,tf){this.lastSuccessAt=this.now;return{source:'TEST_FIXTURE',candles:[candle(symbol,tf,this.now-3*step[tf])]};}
  async depth(){return{source:'TEST_FIXTURE',data:{bids:[['100','200']],asks:[['101','200']]}};}
  async ticker24h(){return{source:'TEST_FIXTURE',data:{quoteVolume:'1000000',count:1000}};}
  health(){return{state:'LIVE',last_success_at:this.lastSuccessAt};}
}
class FakeWs{
  constructor(opts){this.opts=opts;this.started=false;}
  start(){this.started=true;this.opts.onState('LIVE');}
  stop(){this.started=false;}
  health(){return{state:this.started?'LIVE':'STOPPED',last_message_at:this.started?this.opts.now:null,last_connected_at:null,reconnect_attempts:0,url:'TEST_FIXTURE'};}
}

test('TEST_FIXTURE: market monitor remains server-side and runs without a PWA client',async()=>{
  const now=1700054000000,rest=new FakeRest(now),analyses=[];
  const config={
    symbols:['BTCUSDT'],timeframes:['4h','1h','15m'],
    websocket:{urls:['wss://test.invalid'],initialBackoffMs:1,maxBackoffMs:2,jitterRatio:0,heartbeatTimeoutMs:1000,maxConnectionMs:10000},
    monitoring:{bootstrapKlines:1,repairKlines:1,periodicRepairMs:100000,pushRetryMs:100000,maxSeriesLength:10,maxStaleTriggerMs:1800000,minDataQuality:0,minLiquidityQuality:0}
  };
  let wsOpts;
  const monitor=new MarketMonitor({
    config,rest,wsFactory:opts=>{wsOpts=opts;return new FakeWs(opts)},signalService:{
      async evaluateSnapshot(input){analyses.push(input);return{emitted:false};}
    },store:{init:async()=>{},health:()=>({state:'LIVE'})},pushManager:null,clock:()=>now,logger:{info(){},warn(){},error(){}}
  });
  try {
  await monitor.start();
  assert.equal(monitor.running,true);
  assert.equal(monitor.bootstrapDone,true);
  assert.equal((await monitor.health()).monitoring.running,true);
  assert.equal(wsOpts!=null,true);

  const next=now-2*step['15m'];
  await monitor.onCandle(candle('BTCUSDT','15m',next));
  assert.equal(analyses.length>=1,true);
  assert.equal(monitor.health().monitoring.running,true);

  // There is deliberately no browser/PWA client in this test.
  // The server continues monitoring and can process the next candle on its own.
  await monitor.onCandle(candle('BTCUSDT','15m',next+step['15m']));
  assert.equal(analyses.length>=2,true);
  assert.equal(monitor.health().monitoring.running,true);
  } finally {
    await monitor.stop();
  }
  assert.equal((await monitor.health()).monitoring.running,false);
});
