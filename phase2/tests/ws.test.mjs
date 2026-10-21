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
  assert.equal(client.state,'WAITING_FOR_DATA','an open socket is not proof that tickers are flowing');
  await new Promise(resolve=>setTimeout(resolve,55));
  assert.ok(states.some(x=>x.reason?.includes('WS_HEARTBEAT_TIMEOUT')));
  assert.ok(Socket.instances.length>=2);
  const second=Socket.instances[1];
  second.emit('open');
  assert.equal(client.state,'WAITING_FOR_DATA');
  assert.equal(client.attempt,1,'opening a silent socket must not reset backoff');
  second.emit('message',Buffer.from(JSON.stringify([{
    e:'24hrMiniTicker',E:Date.now(),s:'BTCUSDT',
    c:'100',o:'99',h:'101',l:'98',v:'12000',q:'1000000'
  }])));
  assert.equal(client.state,'LIVE','a valid ticker payload changes feed state to LIVE');
  assert.equal(client.attempt,0,'a valid ticker payload resets backoff');
  assert.ok(states.some(x=>x.state==='WAITING_FOR_DATA'));
  assert.ok(states.some(x=>x.state==='LIVE'&&x.reason==='WS_FIRST_VALID_TICKER_RECEIVED'));
  assert.equal(tickers.length,1);
  assert.equal(tickers[0].symbol,'BTCUSDT');
  assert.ok(Math.abs(tickers[0].priceChange24h-((100/99-1)*100))<1e-9);
  assert.equal(tickers[0].quoteVolume24h,1000000);
  assert.equal(tickers[0].tradeCount24h,null,'mini-ticker does not provide a trade count');
  assert.equal(client.health().tickers_received,1);
  assert.match(client.health().last_disconnect_reason,/WS_HEARTBEAT_TIMEOUT/);
  client.stop();
});

test('TEST_FIXTURE: silent ticker socket is rejected at the configured deadline and reports diagnostics',(t)=>{
  Socket.instances.length=0;
  const states=[];
  const timeoutMs=90;
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const client=new BinanceAllMarketTickerClient({
    urls:['wss://one.test/stream','wss://two.test/stream'],
    WebSocketImpl:Socket,
    heartbeatTimeoutMs:timeoutMs,
    maxConnectionMs:1_000_000,
    initialBackoffMs:1000,
    maxBackoffMs:2000,
    jitterRatio:0,
    onState:(state,reason)=>states.push({state,reason})
  });
  client.start();
  Socket.instances[0].emit('open');
  assert.equal(client.state,'WAITING_FOR_DATA');
  t.mock.timers.tick(timeoutMs);
  assert.ok(states.some(x=>x.reason?.includes('WS_HEARTBEAT_TIMEOUT')),
    'the heartbeat must fail at one configured silence interval, not a second interval later');
  assert.match(client.health().last_disconnect_reason,/heartbeat_timeout_ms=90/);
  assert.equal(client.health().messages_since_connect,0);
  assert.equal(client.health().tickers_since_connect,0);
  client.stop();
});

test('TEST_FIXTURE: mini-ticker is normalized without fabricating missing trade counts',()=>{
  const ticker=normalizeTicker({
    e:'24hrMiniTicker',E:1900000000000,s:'ETHUSDT',
    c:'2100',o:'2000',h:'2200',l:'1950',v:'1234.5',q:'2600000'
  });
  assert.ok(ticker);
  assert.ok(Math.abs(ticker.priceChange24h-5)<1e-9,'derived percentage should be 5% within floating-point precision');
  assert.equal(ticker.highPrice24h,2200);
  assert.equal(ticker.lowPrice24h,1950);
  assert.equal(ticker.quoteVolume24h,2600000);
  assert.equal(ticker.tradeCount24h,null);
});

test('TEST_FIXTURE: empty ticker arrays cannot keep the market-feed watchdog alive',(t)=>{
  Socket.instances.length=0;
  const states=[];
  const timeoutMs=90;
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const client=new BinanceAllMarketTickerClient({
    urls:['wss://one.test/stream','wss://two.test/stream'],
    WebSocketImpl:Socket,
    heartbeatTimeoutMs:timeoutMs,
    maxConnectionMs:1_000_000,
    initialBackoffMs:1000,
    maxBackoffMs:2000,
    jitterRatio:0,
    onState:(state,reason)=>states.push({state,reason})
  });
  client.start();
  Socket.instances[0].emit('open');
  Socket.instances[0].emit('message',Buffer.from('[]'));
  t.mock.timers.tick(timeoutMs);
  const timeout=states.find(x=>x.reason?.includes('WS_HEARTBEAT_TIMEOUT'));
  assert.ok(timeout,'empty application arrays must not reset the valid-ticker watchdog');
  assert.match(timeout.reason,/feed_age_ms=90/);
  assert.match(timeout.reason,/message_age_ms=90/);
  assert.equal(client.health().tickers_since_connect,0);
  assert.equal(client.health().messages_since_connect,1);
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
test('TEST_FIXTURE: all-market ticker stream uses the raw Binance /ws endpoint',()=>{
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
