import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {MarketMonitor} from '../core/monitor.mjs';
import {BinanceStreamClient} from '../market/binance-ws.mjs';
import test,{closeServer,activeResourceSnapshot} from './test-helpers.mjs';

class Rest{
  constructor(){this.lastSuccessAt=Date.now();}
  health(){return{state:'LIVE',last_success_at:this.lastSuccessAt};}
  async klines(){return{source:'TEST_FIXTURE',candles:[]};}
  async depth(){return{data:{bids:[],asks:[]}};}
  async ticker24h(){return{data:{quoteVolume:'0',count:0}};}
}
class FakeSocket{
  static instances=[];
  constructor(){this.handlers={};FakeSocket.instances.push(this);}
  on(name,fn){this.handlers[name]=fn;}
  emit(name,...args){this.handlers[name]?.(...args);}
  close(){this.closed=true;}
  terminate(){this.terminated=true;}
}

test('TEST_FIXTURE: HTTP server is absent from active handles after cleanup',async()=>{
  const server=createServer((_,res)=>res.end('ok'));
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).on('error',reject));
  try{
    assert.equal(server.listening,true);
  }finally{
    await closeServer(server);
  }
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(server.listening,false);
  const snapshot=activeResourceSnapshot();
  assert.equal(snapshot.active_handles.some(x=>x.ref===server),false);
  assert.equal(snapshot.active_requests.some(x=>x.ref===server),false);
});

test('TEST_FIXTURE: MarketMonitor.stop closes timers and WebSocket resource',async()=>{
  const config={
    symbols:['BTCUSDT'],timeframes:['4h','1h','15m'],
    websocket:{urls:['wss://fixture.test'],initialBackoffMs:1000,maxBackoffMs:2000,jitterRatio:0,heartbeatTimeoutMs:1000,maxConnectionMs:1000},
    monitoring:{bootstrapKlines:1,repairKlines:1,periodicRepairMs:60000,pushRetryMs:60000,maxSeriesLength:10,maxStaleTriggerMs:1800000,minDataQuality:0,minLiquidityQuality:0}
  };
  const wsInstances=[];
  const wsFactory=opts=>{
    const ws=new FakeSocket();
    wsInstances.push(ws);
    return {
      start(){opts.onState('LIVE');},
      stop(){ws.close();opts.onState('STOPPED');},
      health(){return{state:'LIVE'};}
    };
  };
  const monitor=new MarketMonitor({
    config,rest:new Rest(),wsFactory,
    signalService:{evaluateSnapshot:async()=>({})},
    store:{init:async()=>{},health:async()=>({state:'LIVE'})},
    pushManager:null,logger:{info(){},warn(){},error(){}}
  });
  await monitor.start();
  assert.equal(monitor.running,true);
  assert.equal(monitor.repairTimer!=null,true);
  assert.equal(monitor.retryTimer!=null,true);
  assert.equal(wsInstances.length,1);
  await monitor.stop();
  assert.equal(monitor.running,false);
  assert.equal(monitor.repairTimer,null);
  assert.equal(monitor.retryTimer,null);
  assert.equal(monitor.ws,null);
  assert.equal(wsInstances[0].closed,true);
});

test('TEST_FIXTURE: BinanceStreamClient.stop clears connection timers and socket',async()=>{
  FakeSocket.instances.length=0;
  const client=new BinanceStreamClient({
    urls:['wss://fixture.test'],streams:['btcusdt@kline_15m'],WebSocketImpl:FakeSocket,
    heartbeatTimeoutMs:1000,maxConnectionMs:1000
  });
  client.start();
  const socket=FakeSocket.instances[0];
  socket.emit('open');
  assert.equal(client.state,'LIVE');
  assert.equal(client.heartbeatTimer!=null,true);
  assert.equal(client.connectionTimer!=null,true);
  client.stop();
  assert.equal(client.state,'STOPPED');
  assert.equal(client.timer,null);
  assert.equal(client.heartbeatTimer,null);
  assert.equal(client.connectionTimer,null);
  assert.equal(client.socket,null);
});
