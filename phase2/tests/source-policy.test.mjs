import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';

test('TEST_FIXTURE: phase2 exposes only the allowlisted public market-data API surface outside isolated execution',async()=>{
  const root=new URL('..',import.meta.url);
  const dir=root.pathname;
  const allowedPublic=new Set(['exchangeInfo','klines','depth','ticker/24hr','ticker/bookTicker','aggTrades']);
  const allowedExecutor=new Set([
    'GET /api/v3/time',
    'GET /api/v3/account',
    'GET /sapi/v1/account/apiRestrictions',
    'GET /api/v3/exchangeInfo',
    'GET /api/v3/ticker/price',
    'GET /api/v3/orderList',
    'GET /api/v3/order',
    'POST /api/v3/order',
    'POST /api/v3/orderList/oco'
  ]);
  const check=async(file)=>{
    const source=await readFile(file,'utf8');
    if(file.endsWith(join('core','adaptive-trader-execution.mjs'))){
      const declaration=source.match(/const allowed=new Set\(\[([\s\S]*?)\]\);/);
      assert.ok(declaration,'isolated execution must declare an explicit endpoint allowlist');
      const configured=[...declaration[1].matchAll(/['"]((?:GET|POST) \/(?:api\/v3|sapi\/v1)\/[A-Za-z0-9_\/-]+)['"]/g)].map(x=>x[1]);
      assert.deepEqual(new Set(configured),allowedExecutor,'isolated execution may call only documented account-read, Spot order, and exchange metadata routes');
      assert.equal(configured.length,allowedExecutor.size,'duplicate executor endpoint declarations are not allowed');
      assert.equal(/\/sapi\/v1\/(?!account\/apiRestrictions)/i.test(source),false,'isolated execution must not call transfer, deposit, withdrawal, or other SAPI routes');
      assert.equal(/\/(?:sapi|api\/v3)\/(?:withdraw|transfer|deposit|margin|futures|loan|capital)/i.test(source),false,'asset movement or derivatives endpoint is forbidden');
      assert.match(source,/RADARX_ADAPTIVE_TRADER_LIVE_ENABLED/,'live execution must be independently gated');
      assert.match(source,/RADARX_ADAPTIVE_TRADER_KILL_SWITCH/,'live execution must have an emergency kill switch');
      assert.match(source,/enableWithdrawals!==false/,'preflight must reject keys whose withdrawal permission is enabled');
      assert.match(source,/enableFutures!==false/,'preflight must reject keys whose futures permission is enabled');
      assert.match(source,/enableMargin!==false/,'preflight must reject keys whose margin permission is enabled');
      assert.match(source,/ipRestrict!==true/,'preflight must require IP restriction');
      assert.match(source,/this\.config\.enabled/,'execution controller must fail closed when not configured');
      return;
    }
    assert.equal(/\/sapi\//i.test(source),false,'restricted API namespace in '+file);
    for(const match of source.matchAll(/\/api\/v3\/([A-Za-z0-9_\/-]+)/g)){
      const path=match[1].split('?')[0];
      assert.ok(allowedPublic.has(path),'unexpected public endpoint: '+path+' in '+file);
    }
  };
  const walk=async path=>{
    for(const entry of await readdir(path,{withFileTypes:true})){
      const file=join(path,entry.name);
      if(entry.isDirectory()){if(entry.name==='tests')continue;await walk(file);}
      else if(entry.name.endsWith('.mjs'))await check(file);
    }
  };
  await walk(dir);
});
