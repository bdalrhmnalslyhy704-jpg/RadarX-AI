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
