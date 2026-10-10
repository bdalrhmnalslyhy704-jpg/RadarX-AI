import test from 'node:test';
import assert from 'node:assert/strict';
import {RestClient,RestRateLimitError,retryAfterMs,estimateBinanceRequestWeight} from '../market/binance-rest.mjs';
import {CONFIG} from '../config.mjs';


test('TEST_FIXTURE: each REST client keeps its independent conservative request cap',async()=>{
  const client=new RestClient({baseUrls:['https://rest-default-budget.test'],fetchImpl:async()=>({status:200,ok:true,headers:new Map(),json:async()=>({})})});
  assert.equal(client.maxRequestsPerMinute,240);
  assert.equal(CONFIG.rest.maxRequestsPerMinute,240);
});

test('TEST_FIXTURE: REST weight estimator is conservative for shared market-data endpoints',()=>{
  assert.equal(estimateBinanceRequestWeight('/api/v3/ticker/24hr',{}),80);
  assert.equal(estimateBinanceRequestWeight('/api/v3/ticker/24hr',{symbol:'BTCUSDT'}),2);
  assert.equal(estimateBinanceRequestWeight('/api/v3/ticker/24hr',{symbols:'["BTCUSDT","ETHUSDT"]'}),2);
  assert.equal(estimateBinanceRequestWeight('/api/v3/klines',{symbol:'BTCUSDT',interval:'1m',limit:180}),2);
  assert.equal(estimateBinanceRequestWeight('/api/v3/klines',{symbol:'BTCUSDT',interval:'1m',limit:1000}),5);
  assert.equal(estimateBinanceRequestWeight('/api/v3/depth',{symbol:'BTCUSDT',limit:100}),5);
  assert.equal(estimateBinanceRequestWeight('/api/v3/depth',{symbol:'BTCUSDT',limit:500}),25);
});

test('TEST_FIXTURE: concurrent distinct REST requests reserve the shared budget serially and record exchange usage',async()=>{
  const starts=[];let calls=0;
  const fetchImpl=async()=>{
    starts.push(Date.now());const n=++calls;
    return {status:200,ok:true,headers:new Map([['x-mbx-used-weight-1m',String(100+n)]]),json:async()=>({n})};
  };
  const client=new RestClient({baseUrls:['https://weighted-queue.test'],fetchImpl,timeoutMs:300,minIntervalMs:0,maxRequestsPerMinute:100});
  const results=await Promise.all(['QUEUEAUSDT','QUEUEBUSDT','QUEUECUSDT'].map(symbol=>
    client.request('/api/v3/ticker/24hr',{symbol})
  ));
  assert.equal(results.length,3);assert.equal(calls,3);
  assert.ok(starts[1]-starts[0]>=130,JSON.stringify(starts));
  assert.ok(starts[2]-starts[1]>=130,JSON.stringify(starts));
  const health=client.health();
  assert.equal(health.binance_reported_used_weight_1m,103);
  assert.equal(health.shared_max_weight_per_minute,4000);
  assert.ok(Number(health.shared_estimated_weight_last_minute)>=6);
});

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
  const open=Math.floor((now-5000)/900000)*900000;
  const fetchImpl=async()=>({status:200,ok:true,headers:new Map(),json:async()=>[
    [open,'100','101','99','100','1000',open+899999,100000,10,500,50000,'0']
  ]});
  const client=new RestClient({baseUrls:['https://test.binance'],fetchImpl,timeoutMs:100,minIntervalMs:0,maxRequestsPerMinute:100});
  const result=await client.klines('BTCUSDT','15m');
  assert.equal(result.candles[0].openTime,open);
  assert.equal(result.candles[0].closeTime,open+899999);
  assert.equal(result.candles[0].closed,false);
  assert.equal(result.candles[0].source,'BINANCE_PUBLIC_REST');
  assert.ok(Number.isFinite(result.candles[0].receivedAt));
  assert.ok(Number.isFinite(result.candles[0].ageMs));
  assert.equal(result.candles[0].eventTime,null);
  assert.equal(result.candles[0].transportLatencyMs,null);
});


test('TEST_FIXTURE: shared RestClient coalesces identical in-flight public requests',async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;await new Promise(r=>setTimeout(r,25));return{status:200,ok:true,headers:new Map(),json:async()=>({ok:true})};};
  const a=new RestClient({baseUrls:['https://shared.test'],fetchImpl,timeoutMs:200,minIntervalMs:0,maxRequestsPerMinute:100});
  const b=new RestClient({baseUrls:['https://shared.test'],fetchImpl,timeoutMs:200,minIntervalMs:0,maxRequestsPerMinute:100});
  const [ra,rb]=await Promise.all([
    a.request('/api/v3/ticker/24hr',{symbol:'COALESCEUSDT'}),
    b.request('/api/v3/ticker/24hr',{symbol:'COALESCEUSDT'})
  ]);
  assert.equal(calls,1);
  assert.deepEqual(ra.data,{ok:true});
  assert.deepEqual(rb.data,{ok:true});
});

test('TEST_FIXTURE: short market-data cache reuses fresh identical requests',async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;return{status:200,ok:true,headers:new Map(),json:async()=>({call:calls})};};
  const client=new RestClient({baseUrls:['https://cache.test'],fetchImpl,timeoutMs:200,minIntervalMs:0,maxRequestsPerMinute:100});
  const first=await client.request('/api/v3/ticker/24hr',{symbol:'CACHEUSDT'});
  const second=await client.request('/api/v3/ticker/24hr',{symbol:'CACHEUSDT'});
  assert.equal(calls,1);
  assert.deepEqual(first.data,second.data);
});


test('TEST_FIXTURE: shared REST cache prunes expired rotating-symbol payloads instead of retaining them indefinitely',async()=>{
  let calls=0;
  const fetchImpl=async url=>{
    calls++;
    return{status:200,ok:true,headers:new Map(),json:async()=>({url,call:calls})};
  };
  const client=new RestClient({baseUrls:['https://cache-retention.test'],fetchImpl,timeoutMs:200,minIntervalMs:0,maxRequestsPerMinute:100});
  for(let i=0;i<20;i++){
    await client.request('/api/v3/ticker/24hr',{symbol:`ROTATE${String(i).padStart(2,'0')}USDT`});
  }
  // Pruning is deliberately bounded to a one-second cadence, not synchronous
  // with every cache insertion. Let that cadence run, then trigger one request
  // so the assertion observes the post-prune state rather than an in-between tail.
  await new Promise(resolve=>setTimeout(resolve,1100));
  await client.request('/api/v3/ticker/24hr',{symbol:'ROTATE_FINAL_USDT'});
  const health=client.health();
  assert.equal(calls,21,'each distinct symbol should be requested once');
  assert.ok(health.shared_cache_entries<=12,
    `expired symbol payloads must be pruned after the bounded cleanup interval; current entries=${health.shared_cache_entries}`);
});
