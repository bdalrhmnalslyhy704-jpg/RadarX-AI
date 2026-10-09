import test from 'node:test';
import assert from 'node:assert/strict';
import {BinanceStreamClient} from '../market/binance-ws.mjs';

class Socket{
  static instances=[];
  constructor(url){this.url=url;this.handlers={};Socket.instances.push(this);}
  on(name,fn){this.handlers[name]=fn;}
  emit(name,...args){this.handlers[name]?.(...args);}
  close(){this.closed=true;}
  terminate(){this.terminated=true;this.emit('close');}
  pong(){}
}

test('TEST_FIXTURE: websocket disconnect enters backoff and reconnects with another route',async()=>{
  Socket.instances.length=0;
  const states=[];
  const c=new BinanceStreamClient({urls:['wss://one.test/stream','wss://two.test/stream'],streams:['btcusdt@kline_15m'],
    WebSocketImpl:Socket,initialBackoffMs:5,maxBackoffMs:10,jitterRatio:0,heartbeatTimeoutMs:1000,maxConnectionMs:1000,onState:s=>states.push(s)});
  c.start();Socket.instances[0].emit('open');assert.equal(c.state,'LIVE');
  Socket.instances[0].emit('close');
  await new Promise(r=>setTimeout(r,12));
  assert.equal(Socket.instances.length,2);assert.match(Socket.instances[1].url,/one|two/);
  c.stop();assert.equal(c.state,'STOPPED');assert.ok(states.includes('BACKING_OFF'));
});



test('TEST_FIXTURE: websocket candle carries event, receive, age and transport timing separately',()=>{
  Socket.instances.length=0;
  const received=[];
  const client=new BinanceStreamClient({urls:['wss://one.test/stream'],streams:['btcusdt@kline_15m'],
    WebSocketImpl:Socket,heartbeatTimeoutMs:1000,maxConnectionMs:1000,onCandle:c=>received.push(c)});
  client.start();
  const now=Date.now();
  const open=Math.floor((now-900000)/900000)*900000;
  const close=open+899999;
  const eventTime=now-12;
  const payload={e:'kline',E:eventTime,s:'BTCUSDT',k:{t:open,T:close,s:'BTCUSDT',
    o:'100',h:'101',l:'99',c:'100',v:'10',q:'1000',n:10,V:'5',Q:'500',x:true,i:'15m'}};
  Socket.instances[0].emit('open');
  Socket.instances[0].emit('message',Buffer.from(JSON.stringify(payload)));
  client.stop();
  assert.equal(received.length,1);
  const candle=received[0];
  assert.equal(candle.source,'BINANCE_PUBLIC_WS');
  assert.equal(candle.eventTime,eventTime);
  assert.equal(candle.sourceTime,eventTime);
  assert.ok(Number.isFinite(candle.receivedAt));
  assert.ok(candle.receivedAt>=eventTime);
  assert.ok(Number.isFinite(candle.ageMs));
  assert.equal(candle.transportLatencyMs,candle.receivedAt-eventTime);
  assert.equal(candle.closed,true);
});

test('TEST_FIXTURE: websocket kline timestamps are milliseconds; seconds are rejected',async()=>{
  Socket.instances.length=0;
  const errors=[];
  const c=new BinanceStreamClient({urls:['wss://one.test/stream'],streams:['btcusdt@kline_15m'],
    WebSocketImpl:Socket,heartbeatTimeoutMs:1000,maxConnectionMs:1000,onState:(s,r)=>{if(r)errors.push(r)}});
  c.start();
  const payload={
    e:'kline',E:1700000000,s:'BTCUSDT',
    k:{t:1700000000,T:1700000899,s:'BTCUSDT',o:'100',h:'101',l:'99',c:'100',v:'10',q:'1000',n:10,V:'5',Q:'500',x:true,i:'15m'}
  };
  Socket.instances[0].emit('open');
  Socket.instances[0].emit('message',Buffer.from(JSON.stringify(payload)));
  c.stop();
  assert.ok(errors.some(x=>/INVALID_WS_JSON:openTime_TIMESTAMP_UNIT_SECONDS/.test(x)));
});
