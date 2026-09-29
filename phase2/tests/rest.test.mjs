import test from './test-helpers.mjs';
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
