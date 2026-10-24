import test from 'node:test';
import assert from 'node:assert/strict';
import {RestClient,RestRateLimitError,retryAfterMs,estimateBinanceRequestWeight,sharedResponseCacheTtlMs,sharedResponseCacheExpiresAt,assertSharedBudgetWaitBound} from '../market/binance-rest.mjs';
import {CONFIG} from '../config.mjs';


test('TEST_FIXTURE: each REST client keeps its independent conservative request cap',async()=>{
  const client=new RestClient({baseUrls:['https://rest-default-budget.test'],fetchImpl:async()=>({status:200,ok:true,headers:new Map(),json:async()=>({})})});
  assert.equal(client.maxRequestsPerMinute,240);
  assert.equal(CONFIG.rest.maxRequestsPerMinute,240);
});

test('TEST_FIXTURE: REST weight estimator is conservative for shared market-data endpoints',()=>{
  assert.equal(estimateBinanceRequestWeight('/api/v3/aggTrades',{symbol:'BTCUSDT',limit:1000}),4);
  assert.equal(estimateBinanceRequestWeight('/api/v3/ticker/24hr',{}),80);
  assert.equal(estimateBinanceRequestWeight('/api/v3/ticker/24hr',{symbol:'BTCUSDT'}),2);
  assert.equal(estimateBinanceRequestWeight('/api/v3/ticker/24hr',{symbols:'["BTCUSDT","ETHUSDT"]'}),2);
  assert.equal(estimateBinanceRequestWeight('/api/v3/klines',{symbol:'BTCUSDT',interval:'1m',limit:180}),2);
  assert.equal(estimateBinanceRequestWeight('/api/v3/klines',{symbol:'BTCUSDT',interval:'1m',limit:1000}),5);
  assert.equal(estimateBinanceRequestWeight('/api/v3/ticker/bookTicker',{}),4);
  assert.equal(estimateBinanceRequestWeight('/api/v3/ticker/bookTicker',{symbol:'BTCUSDT'}),2);
  assert.equal(estimateBinanceRequestWeight('/api/v3/depth',{symbol:'BTCUSDT',limit:100}),5);
  assert.equal(estimateBinanceRequestWeight('/api/v3/depth',{symbol:'BTCUSDT',limit:500}),25);
});

test('TEST_FIXTURE: crowded shared request budget defers long waits instead of pinning scans',()=>{
  assert.equal(assertSharedBudgetWaitBound(0),0);
  assert.equal(assertSharedBudgetWaitBound(2500),2500);
  assert.throws(()=>assertSharedBudgetWaitBound(2501),error=>error instanceof RestRateLimitError&&error.retryMs===2501);
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
  assert.ok(starts[1]-starts[0]>=90,JSON.stringify(starts));
  assert.ok(starts[2]-starts[1]>=90,JSON.stringify(starts));
  const health=client.health();
  assert.equal(health.binance_reported_used_weight_1m,103);
  assert.equal(health.shared_max_requests_per_minute,600);
  assert.equal(health.shared_max_weight_per_minute,4000);
  assert.ok(Number(health.shared_estimated_weight_last_minute)>=6);
});

test('TEST_FIXTURE: Kline cache uses interval-aware bounded TTLs while depth stays short-lived',()=>{
  assert.equal(sharedResponseCacheTtlMs('/api/v3/klines',{interval:'1m'}),12_000);
  assert.equal(sharedResponseCacheTtlMs('/api/v3/klines',{interval:'5m'}),20_000);
  assert.equal(sharedResponseCacheTtlMs('/api/v3/klines',{interval:'15m'}),30_000);
  assert.equal(sharedResponseCacheTtlMs('/api/v3/klines',{interval:'1h'}),45_000);
  assert.equal(sharedResponseCacheTtlMs('/api/v3/klines',{interval:'4h'}),45_000);
  assert.equal(sharedResponseCacheTtlMs('/api/v3/klines',{interval:'unknown'}),5_000);
  assert.equal(sharedResponseCacheTtlMs('/api/v3/depth',{symbol:'BTCUSDT'}),700);
  assert.equal(sharedResponseCacheTtlMs('/api/v3/exchangeInfo'),300_000);
});

test('TEST_FIXTURE: open Kline cache entries expire before the candle can be mistaken for closed',()=>{
  const receivedAt=1_800_000_000_000;
  const openCandleCloseTime=receivedAt+5_000;
  const openKline=[receivedAt-60_000,'100','101','99','100','1000',openCandleCloseTime,100000,10,500,50000,'0'];
  const openSnapshot={receivedAt,data:[openKline]};
  const expiresBeforeClose=sharedResponseCacheExpiresAt(
    '/api/v3/klines',{interval:'1m'},openSnapshot,receivedAt
  );
  assert.equal(expiresBeforeClose,openCandleCloseTime);
  assert.ok(expiresBeforeClose<receivedAt+12_000,'open candle must shorten the nominal 1m cache TTL');

  const closedSnapshot={receivedAt,data:[[receivedAt-60_000,'100','101','99','100','1000',receivedAt-1,100000,10,500,50000,'0']]};
  assert.equal(sharedResponseCacheExpiresAt(
    '/api/v3/klines',{interval:'1m'},closedSnapshot,receivedAt
  ),receivedAt+12_000,'already-closed candles may use the interval TTL');
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
  // Use the current 15-minute bucket; subtracting 5s made this flaky at interval boundaries.
  const open=Math.floor(now/900000)*900000;
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


test('TEST_FIXTURE: a very short Kline response cache reduces duplicate calls without promoting open candles',async()=>{
  const now=Date.now(),step=5*60_000,currentOpen=Math.floor(now/step)*step,previousOpen=currentOpen-step;
  let calls=0;
  const raw=[
    [previousOpen,'100','101','99','100','1000',previousOpen+step-1,100000,10,500,50000,'0'],
    [currentOpen,'100','101','99','100','1000',currentOpen+step-1,100000,10,500,50000,'0']
  ];
  const client=new RestClient({
    baseUrls:['https://kline-cache.test'],timeoutMs:200,minIntervalMs:0,maxRequestsPerMinute:100,
    fetchImpl:async()=>{calls++;return{status:200,ok:true,headers:new Map(),json:async()=>raw};}
  });
  const first=await client.klines('CACHEKLINEUSDT','5m',{limit:96});
  const second=await client.klines('CACHEKLINEUSDT','5m',{limit:96});
  assert.equal(calls,1,'identical public Kline requests within the short cache window are reused');
  assert.equal(first.candles.length,2);
  assert.equal(second.candles[0].closed,true,'completed candles remain available from the shared cache');
  assert.equal(second.candles[1].closed,false,'a cached in-progress candle remains open and downstream gates must reject it');
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


test('TEST_FIXTURE: full-market batch ticker snapshot is multiplexed across radar REST clients',async()=>{
  let calls=0;
  const makeFetch=label=>async url=>{
    calls++;
    assert.ok(url.endsWith('/api/v3/ticker/24hr'));
    return {status:200,ok:true,headers:new Map(),json:async()=>[{symbol:label+'USDT',lastPrice:'1',quoteVolume:'1000'}]};
  };
  const a=new RestClient({baseUrls:['https://ticker-primary.test','https://ticker-fallback.test'],fetchImpl:makeFetch('A'),timeoutMs:200,minIntervalMs:0,maxRequestsPerMinute:100});
  const b=new RestClient({baseUrls:['https://data-api.binance.vision','https://ticker-fallback.test'],fetchImpl:makeFetch('B'),timeoutMs:200,minIntervalMs:0,maxRequestsPerMinute:100});
  const [first,second]=await Promise.all([
    a.request('/api/v3/ticker/24hr'),
    b.request('/api/v3/ticker/24hr')
  ]);
  assert.equal(calls,1,'all radar clients should share one all-symbol ticker REST request');
  assert.deepEqual(second.data,first.data);
});


test('TEST_FIXTURE: REST timeout errors identify the timed-out endpoint and fallback host',async()=>{
  let attempts=0;
  const baseUrls=['https://timeout-a.test','https://timeout-b.test'];
  const fetchImpl=(_url,{signal})=>new Promise((resolve,reject)=>{
    attempts++;
    if(signal.aborted){reject(new Error('This operation was aborted'));return;}
    signal.addEventListener('abort',()=>reject(new Error('This operation was aborted')),{once:true});
  });
  const client=new RestClient({
    baseUrls,fetchImpl,timeoutMs:5,minIntervalMs:0,maxRequestsPerMinute:100
  });
  await assert.rejects(
    ()=>client.request('/api/v3/klines',{symbol:'TIMEOUTDIAGUSDT',interval:'17m',limit:1}),
    /REST_REQUEST_TIMEOUT path=\/api\/v3\/klines timeout_ms=5 base=https:\/\/timeout-b\.test/
  );
  assert.equal(attempts,2,'the bounded REST fallback should try each configured host');
  assert.match(client.health().last_error,/REST_REQUEST_TIMEOUT/);
});

test('TEST_FIXTURE: expired analyst scan deadline blocks outbound REST requests immediately',async()=>{
  let calls=0;
  const client=new RestClient({baseUrls:['https://scan-deadline.test'],timeoutMs:100,minIntervalMs:0,
    fetchImpl:async()=>{calls++;return{status:200,ok:true,headers:new Map(),json:async()=>({})};}});
  client.requestDeadlineAtMs=Date.now()-1;
  await assert.rejects(()=>client.request('/api/v3/exchangeInfo'),/MULTI_ANALYST_SCAN_DEADLINE_EXCEEDED/);
  assert.equal(calls,0,'expired scan deadlines must not start a network request');
  assert.equal(client.health().state,'ERROR');
  assert.match(client.health().last_error,/MULTI_ANALYST_SCAN_DEADLINE_EXCEEDED/);
});

test('TEST_FIXTURE: a long Retry-After never blocks a radar request for hours',async()=>{
  let calls=0;
  const fetchImpl=async()=>{
    calls++;
    return{status:429,headers:new Map([['retry-after','86400']]),ok:false,json:async()=>({})};
  };
  const client=new RestClient({baseUrls:['https://long-cooldown.test'],fetchImpl,timeoutMs:100,minIntervalMs:0,maxRequestsPerMinute:100});
  await assert.rejects(
    ()=>client.request('/api/v3/klines',{symbol:'COOLDOWNTESTUSDT',interval:'1m'}),
    error=>error instanceof RestRateLimitError&&error.retryMs>=86_000_000
  );
  const started=Date.now();
  await assert.rejects(
    ()=>client.request('/api/v3/klines',{symbol:'COOLDOWNTESTUSDT',interval:'5m'}),
    error=>error instanceof RestRateLimitError&&error.retryMs>80_000_000
  );
  assert.ok(Date.now()-started<250,'long server cooldown must defer to the next scan instead of sleeping inside it');
  assert.equal(calls,1,'while the shared ban is active no extra request should be sent');
  assert.ok(client.health().rate_limited_until>Date.now()+80_000_000);
});
