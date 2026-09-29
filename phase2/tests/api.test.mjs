import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApiServer} from '../http/api.mjs';
import {DurableStore} from '../core/store.mjs';
import {createSessionToken} from '../core/auth.mjs';
import {NoopPushProvider} from '../push/index.mjs';
import {pushSubscription} from './fixtures.mjs';

test('TEST_FIXTURE: subscription/settings API requires auth and never returns push keys',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-api-')),store=await new DurableStore({dir}).init();
  const secret='TEST_FIXTURE_AUTH_SECRET';
  const config={auth:{secret,allowedOrigins:[]},api:{maxBodyBytes:65536,rateLimitPerMinute:100}};
  const monitor={health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'}})};
  const server=createApiServer({config,store,monitor,pushProvider:new NoopPushProvider()});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,base='http://127.0.0.1:'+port;
  const bad=await fetch(base+'/v1/settings');assert.equal(bad.status,401);
  const token=createSessionToken({userId:'u1',secret,ttlSec:3600}),h={Authorization:'Bearer '+token,'content-type':'application/json'};
  const save=await fetch(base+'/v1/settings',{method:'PUT',headers:h,body:JSON.stringify({enabled:true,symbols:['BTCUSDT'],timeframes:['15m'],minDataQuality:80,minLiquidityQuality:70,signalTypes:['CONFIRMED']})});
  assert.equal(save.status,200);
  const add=await fetch(base+'/v1/subscriptions',{method:'POST',headers:h,body:JSON.stringify(pushSubscription())});assert.equal(add.status,201);
  const got=await add.json();assert.equal(got.subscription.endpoint,pushSubscription().endpoint);assert.equal('keys' in JSON.stringify(got),false);
  const list=await fetch(base+'/v1/subscriptions',{headers:{Authorization:'Bearer '+token}});assert.equal(list.status,200);
  const rows=await list.json();assert.equal(rows.subscriptions.length,1);
  const del=await fetch(base+'/v1/subscriptions/'+rows.subscriptions[0].id,{method:'DELETE',headers:{Authorization:'Bearer '+token}});
  assert.equal(del.status,200);await new Promise(r=>server.close(r));
});
