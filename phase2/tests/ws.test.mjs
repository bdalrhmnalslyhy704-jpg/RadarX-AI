import test from 'node:test';
import assert from 'node:assert/strict';
import {BinanceStreamClient} from '../market/binance-ws.mjs';
import {resolvePublicSpotWsUrls} from '../config.mjs';

class Socket{
  static instances=[];
  constructor(url){this.url=url;this.handlers={};Socket.instances.push(this);}
  on(name,fn){this.handlers[name]=fn;}
  emit(name,...args){this.handlers[name]?.(...args);}
  close(){this.closed=true;}
  terminate(){this.terminated=true;this.emit('close');}
  pong(){}
}

test('default public Spot websocket configuration has a data-only endpoint and a standard endpoint fallback',()=>{
  assert.deepEqual(resolvePublicSpotWsUrls({}),[
    'wss://data-stream.binance.vision/stream',
    'wss://stream.binance.com:9443/stream'
  ]);
  assert.deepEqual(resolvePublicSpotWsUrls({BINANCE_WS_URLS:'wss://one.test/stream, wss://two.test/stream'}),[
    'wss://one.test/stream',
    'wss://two.test/stream',
    'wss://data-stream.binance.vision/stream',
    'wss://stream.binance.com:9443/stream'
  ]);
});

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

import {BinanceAllMarketTickerClient,normalizeTicker} from '../market/binance-market-ticker-ws.mjs';

test('TEST_FIXTURE: ticker heartbeat timeout is explicit and backoff resets only after feed data',async()=>{
  Socket.instances.length=0;
  const states=[];
  const tickers=[];
  const client=new BinanceAllMarketTickerClient({
    urls:['wss://one.test/stream','wss://two.test/stream'],
    WebSocketImpl:Socket,
    heartbeatTimeoutMs:20,
    maxConnectionMs:1000,
    initialBackoffMs:5,
    maxBackoffMs:20,
    jitterRatio:0,
    onTicker:t=>tickers.push(t),
    onState:(state,reason)=>states.push({state,reason})
  });
  client.start();
  Socket.instances[0].emit('open');
  await new Promise(resolve=>setTimeout(resolve,55));
  assert.ok(states.some(x=>x.reason?.includes('WS_HEARTBEAT_TIMEOUT')));
  assert.ok(Socket.instances.length>=2);
  const second=Socket.instances[1];
  second.emit('open');
  assert.equal(client.attempt,1,'opening a silent socket must not reset backoff');
  second.emit('message',Buffer.from(JSON.stringify({stream:'!miniTicker@arr',data:[{
    s:'BTCUSDT',c:'100',o:'99',h:'101',l:'98',q:'1000000',E:Date.now()
  }]})));
  assert.equal(client.attempt,0,'a valid ticker payload resets backoff');
  assert.equal(tickers.length,1);
  assert.equal(tickers[0].symbol,'BTCUSDT');
  assert.equal(client.health().tickers_received,1);
  assert.match(client.health().last_disconnect_reason,/WS_HEARTBEAT_TIMEOUT/);
  client.stop();
});

test('TEST_FIXTURE: ticker websocket records HTTP rejection status before retry',()=>{
  Socket.instances.length=0;
  const states=[];
  const client=new BinanceAllMarketTickerClient({
    urls:['wss://one.test/stream','wss://two.test/stream'],
    WebSocketImpl:Socket,
    heartbeatTimeoutMs:1000,
    maxConnectionMs:1000,
    initialBackoffMs:5,
    maxBackoffMs:20,
    jitterRatio:0,
    onState:(state,reason)=>states.push({state,reason})
  });
  client.start();
  let resumed=false;
  Socket.instances[0].emit('unexpected-response',{},{
    statusCode:451,
    resume(){resumed=true;}
  });
  assert.equal(resumed,true);
  assert.ok(states.some(x=>x.reason==='WS_HTTP_451'));
  assert.equal(client.health().last_disconnect_reason,'WS_HTTP_451');
  client.stop();
});
test('TEST_FIXTURE: normalizes Binance Spot mini tickers without pretending trade count is available',()=>{
  const row=normalizeTicker({s:'BTCUSDT',c:'101',o:'100',h:'102',l:'99',q:'123456',E:1700000000000});
  assert.equal(row.symbol,'BTCUSDT');
  assert.equal(row.priceChange24h,1);
  assert.equal(row.quoteVolume24h,123456);
  assert.equal(row.tradeCount24h,null);
});

test('TEST_FIXTURE: supported all-market mini ticker stream uses the raw Binance /ws endpoint',()=>{
  const client=new BinanceAllMarketTickerClient({
    urls:['wss://data-stream.binance.vision/stream?streams=stale&timeUnit=MICROSECOND','wss://stream.binance.com:9443/stream'],
    WebSocketImpl:Socket,
    onState:()=>{}
  });
  assert.equal(client.url(),'wss://data-stream.binance.vision/ws/!miniTicker@arr?timeUnit=MICROSECOND');
  client.urlIndex=1;
  assert.equal(client.url(),'wss://stream.binance.com:9443/ws/!miniTicker@arr');
  client.stop();
});
