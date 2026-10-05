import test from 'node:test';
import assert from 'node:assert/strict';
import {RestClient,RestRateLimitError,retryAfterMs} from '../market/binance-rest.mjs';

test('TEST_FIXTURE: HTTP 429 records rate limit and retry-after without spamming fallback',async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;return{status:429,headers:new Map([['retry-after','0.001']]),ok:false,json:async()=>({})};};
  const c=new RestClient({baseUrls:['https://a.test','https://b.test'],fetchImpl,timeoutMs:100,minIntervalMs:0,maxRequestsPerMinute:100});
  await assert.rejects(()=>c.request('/api/v3/klines',{symbol:'BTCUSDT',interval:'15m'}),e=>e instanceof RestRateLimitError);
  assert.equal(calls,1);assert.equal(c.health().state,'RATE_LIMITED');assert.ok(c.health().rate_limited_until>Date.now()-1);
});

test('TEST_FIXTURE: retry-after header is parsed in milliseconds',()=>{
  const h=new Map([['retry-after','2']]);assert.equal(retryAfterMs(h),2000);
});


test('TEST_FIXTURE: Binance kline timestamps are milliseconds; seconds are rejected clearly',async()=>{
  const fetchImpl=async()=>({status:200,ok:true,headers:new Map(),json:async()=>[
    [1700000000,'100','101','99','100','1000',1700000899,100000,10,500,50000,'0']
  ]});
  const client=new RestClient({baseUrls:['https://test.binance'],fetchImpl,timeoutMs:100,minIntervalMs:0,maxRequestsPerMinute:100});
  await assert.rejects(()=>client.klines('BTCUSDT','15m'),/openTime_TIMESTAMP_UNIT_SECONDS/);
});

test('TEST_FIXTURE: Binance millisecond kline timestamps normalize and current open candle stays open',async()=>{
  const now=Date.now();
  const open=Math.floor(now/900000)*900000;
  const fetchImpl=async()=>({status:200,ok:true,headers:new Map(),json:async()=>[
    [open,'100','101','99','100','1000',open+899999,100000,10,500,50000,'0']
  ]});
  const client=new RestClient({baseUrls:['https://test.binance'],fetchImpl,timeoutMs:100,minIntervalMs:0,maxRequestsPerMinute:100});
  const result=await client.klines('BTCUSDT','15m');
  assert.equal(result.candles[0].openTime,open);
  assert.equal(result.candles[0].closeTime,open+899999);
  assert.equal(result.candles[0].closed,false);
});
