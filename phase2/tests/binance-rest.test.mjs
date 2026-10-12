import test from 'node:test';
import assert from 'node:assert/strict';
import {RestClient,RestRateLimitError,requestWeightFor,observedRequestWeight} from '../market/binance-rest.mjs';

function response(status=200,body={},headers={}){
  return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
}

test('Binance Spot request weights match the current endpoint policy',()=>{
  assert.equal(requestWeightFor('/api/v3/exchangeInfo'),20);
  assert.equal(requestWeightFor('/api/v3/klines',{limit:180}),2);
  assert.equal(requestWeightFor('/api/v3/aggTrades',{symbol:'BTCUSDT',limit:1000}),4);
  assert.equal(requestWeightFor('/api/v3/depth',{limit:100}),5);
  assert.equal(requestWeightFor('/api/v3/depth',{limit:500}),25);
  assert.equal(requestWeightFor('/api/v3/depth',{limit:1000}),50);
  assert.equal(requestWeightFor('/api/v3/depth',{limit:5000}),250);
  assert.equal(requestWeightFor('/api/v3/ticker/24hr'),80);
  assert.equal(requestWeightFor('/api/v3/ticker/24hr',{symbol:'BTCUSDT'}),2);
  assert.equal(requestWeightFor('/api/v3/ticker/24hr',{symbols:'["BTCUSDT","ETHUSDT"]'}),2);
  assert.equal(requestWeightFor('/api/v3/ticker/24hr',{symbols:JSON.stringify(Array.from({length:50},()=> 'XUSDT'))}),40);
  assert.equal(requestWeightFor('/api/v3/ticker/24hr',{symbols:JSON.stringify(Array.from({length:101},()=> 'XUSDT'))}),80);
});

test('Concurrent REST calls are serialized by one queue and local REQUEST_WEIGHT never exceeds policy',async()=>{
  let now=1000000,active=0,maxActive=0,calls=0,maxWeightSeen=0;
  const sleepFn=async ms=>{now+=Math.max(0,Number(ms)||0);};
  const client=new RestClient({
    baseUrls:['https://example.test'],
    timeoutMs:1000,minIntervalMs:0,
    maxWeightPerMinute:20,safetyMarginWeight:0,
    clock:()=>now,sleepFn,
    fetchImpl:async()=>{calls++;active++;maxActive=Math.max(maxActive,active);await Promise.resolve();active--;const used=(calls%10||10)*2;return response(200,[],{'X-MBX-USED-WEIGHT-1M':String(used)});}
  });
  await Promise.all(Array.from({length:12},(_,i)=>client.klines('A'+String(i).padStart(3,'0')+'USDT','1m',{limit:180})));
  maxWeightSeen=Math.max(maxWeightSeen,...client.usedAt.map(x=>x.weight));
  assert.equal(maxActive,1);
  assert.equal(calls,12);
  assert.ok(maxWeightSeen<=2);
  assert.ok(client.health().request_weight_used_last_minute<=20);
  assert.ok(now>=1000000+60000);
  assert.equal(client.health().observed_request_weight_1m,4);
});

test('identical overlapping reads are coalesced across RestClient instances sharing endpoint routes',async()=>{
  let firstCalls=0,secondCalls=0,releaseFirst;
  const firstResponse=new Promise(resolve=>{releaseFirst=resolve;});
  const common={baseUrls:['https://shared-market.example'],minIntervalMs:0,maxWeightPerMinute:100,safetyMarginWeight:0,
    clock:()=>1_900_100_000_000,sleepFn:async()=>{}};
  const firstClient=new RestClient({...common,fetchImpl:async()=>{firstCalls++;await firstResponse;return response(200,[{symbol:'GTCUSDT'}]);}});
  const secondClient=new RestClient({...common,fetchImpl:async()=>{secondCalls++;return response(200,[{symbol:'GTCUSDT',fresh:true}]);}});
  const first=firstClient.request('/api/v3/ticker/24hr');
  const second=secondClient.request('/api/v3/ticker/24hr');
  try {
    assert.equal(firstCalls,0);
    assert.equal(secondCalls,0);
  } finally {
    // Never leave the mocked fetch blocked if an assertion fails; otherwise the test
    // hangs until Node's global timeout and hides the real assertion error.
    releaseFirst();
  }
  const [a,b]=await Promise.all([first,second]);
  assert.deepEqual(a.data,b.data);
  assert.equal(firstCalls,1);
  assert.equal(secondCalls,0);
  assert.equal(secondClient.health().coalesced_request_count,1);
  const fresh=await secondClient.request('/api/v3/ticker/24hr');
  assert.equal(secondCalls,1,'a later call must use the second client and fetch fresh market data');
  assert.equal(fresh.data[0].fresh,true);
});

test('overlapping identical public GETs are coalesced without caching later requests',async()=>{
  let calls=0,releaseFetch;
  const responseWait=new Promise(resolve=>{releaseFetch=resolve;});
  const client=new RestClient({
    baseUrls:['https://example.test'],minIntervalMs:0,maxWeightPerMinute:6000,safetyMarginWeight:0,
    clock:()=>1_900_000_000_000,sleepFn:async()=>{},
    fetchImpl:async()=>{calls++;await responseWait;return response(200,[{symbol:'GTCUSDT'}]);}
  });
  const first=client.ticker24h();
  const second=client.ticker24h();
  try {
    assert.equal(calls,0);
    assert.equal(client.health().inflight_request_count,1);
  } finally {
    // Ensure an early assertion cannot strand fetchImpl on responseWait forever.
    releaseFetch();
  }
  const [a,b]=await Promise.all([first,second]);
  assert.equal(calls,1);
  assert.deepEqual(a.data,b.data);
  assert.equal(client.health().coalesced_request_count,1);
  assert.equal(client.health().inflight_request_count,0);
  await client.ticker24h();
  assert.equal(calls,2,'subsequent non-overlapping calls must fetch fresh data');
});

test('aggTrades fromId pagination is supported and REST queue wait is observable',async()=>{
  let requestedUrl='';
  const client=new RestClient({
    baseUrls:['https://example.test'],minIntervalMs:0,maxWeightPerMinute:100,safetyMarginWeight:0,
    clock:()=>1_900_000_000_000,sleepFn:async()=>{},
    fetchImpl:async url=>{
      requestedUrl=String(url);
      return response(200,[{a:77,p:'0.5',q:'12',T:1_899_999_999_999,m:false}]);
    }
  });
  const result=await client.aggTrades('GTCUSDT',{fromId:77,limit:1000});
  const url=new URL(requestedUrl);
  assert.equal(url.searchParams.get('fromId'),'77');
  assert.equal(url.searchParams.has('startTime'),false);
  assert.equal(url.searchParams.has('endTime'),false);
  assert.equal(result.trades[0].a,77);
  assert.equal(client.health().queue_wait_samples,1);
  assert.equal(client.health().queue_wait_ms_last,0);
  assert.equal(client.health().queue_wait_ms_p95,0);
});

test('429 and 418 responses establish explicit backoff and the queue honors Retry-After',async()=>{
  let now=2000000,attempt=0,slept=0;
  const sleepFn=async ms=>{slept+=ms;now+=Math.max(0,Number(ms)||0);};
  const client=new RestClient({
    baseUrls:['https://example.test'],
    minIntervalMs:0,maxWeightPerMinute:100,safetyMarginWeight:0,
    clock:()=>now,sleepFn,
    fetchImpl:async()=>{
      attempt++;
      if(attempt===1)return response(429,{}, {'Retry-After':'2'});
      return response(200,[],{'X-MBX-USED-WEIGHT-1M':'2'});
    }
  });
  await assert.rejects(()=>client.request('/api/v3/klines',{symbol:'AAAUSDT',interval:'1m',limit:10}),e=>{
    assert.ok(e instanceof RestRateLimitError);
    assert.equal(e.status,429);
    assert.equal(e.retryMs,2000);
    return true;
  });
  assert.equal(client.health().state,'RATE_LIMITED');
  const ok=await client.request('/api/v3/klines',{symbol:'AAAUSDT',interval:'1m',limit:10});
  assert.deepEqual(ok.data,[]);
  assert.ok(slept>=2000);

  let now418=3000000;
  const client418=new RestClient({
    baseUrls:['https://example.test'],minIntervalMs:0,maxWeightPerMinute:100,safetyMarginWeight:0,
    clock:()=>now418,sleepFn:async ms=>{now418+=ms;},
    fetchImpl:async()=>response(418,{}, {})
  });
  await assert.rejects(()=>client418.request('/api/v3/klines',{symbol:'AAAUSDT',interval:'1m',limit:10}),e=>{
    assert.equal(e.status,418);
    assert.ok(e.retryMs>=120000);
    return true;
  });
});

test('X-MBX-USED-WEIGHT-1M is parsed when present',()=>{
  const h=new Headers({'X-MBX-USED-WEIGHT-1M':'321'});
  assert.equal(observedRequestWeight(h),321);
});
