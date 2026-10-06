import test from 'node:test';
import assert from 'node:assert/strict';
import {RestClient,RestRateLimitError,requestWeightFor,observedRequestWeight} from '../market/binance-rest.mjs';

function response(status=200,body={},headers={}){
  return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
}

test('Binance Spot request weights match the current endpoint policy',()=>{
  assert.equal(requestWeightFor('/api/v3/exchangeInfo'),20);
  assert.equal(requestWeightFor('/api/v3/klines',{limit:180}),2);
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
  await Promise.all(Array.from({length:12},()=>client.klines('AAAUSDT','1m',{limit:180})));
  maxWeightSeen=Math.max(maxWeightSeen,...client.usedAt.map(x=>x.weight));
  assert.equal(maxActive,1);
  assert.equal(calls,12);
  assert.ok(maxWeightSeen<=2);
  assert.ok(client.health().request_weight_used_last_minute<=20);
  assert.ok(now>=1000000+60000);
  assert.equal(client.health().observed_request_weight_1m,4);
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
