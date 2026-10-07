import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';

test('TEST_FIXTURE: phase2 exposes only the allowlisted public market-data API surface',async()=>{
  const root=new URL('..',import.meta.url);
  const dir=root.pathname;
  const allowed=new Set(['exchangeInfo','klines','depth','ticker/24hr','aggTrades']);
  const check=async(file)=>{
    const text=await readFile(file,'utf8');
    assert.equal(/\/sapi\//i.test(text),false,'restricted API namespace in '+file);
    for(const m of text.matchAll(/\/api\/v3\/([A-Za-z0-9_\/-]+)/g)){
      const path=m[1].split('?')[0];
      assert.ok(allowed.has(path),'unexpected public endpoint: '+path);
    }
  };
  const walk=async pth=>{
    for(const e of await readdir(pth,{withFileTypes:true})){
      const f=join(pth,e.name);
      if(e.isDirectory()){if(e.name==='tests')continue;await walk(f);}
      else if(e.name.endsWith('.mjs'))await check(f);
    }
  };
  await walk(dir);
});
