import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';

test('TEST_FIXTURE: phase2 contains no trading or withdrawal endpoints',async()=>{
  const root=new URL('..',import.meta.url);const dir=root.pathname;const bad=/\/api\/v3\/(order|account|openOrders)|\/sapi\/|withdraw/i;
  for(const name of await readdir(dir,{withFileTypes:true})){
    if(!name.isFile()||!name.name.endsWith('.mjs'))continue;
    const text=await readFile(join(dir,name.name),'utf8').catch(()=> '');
    assert.equal(bad.test(text),false,'forbidden endpoint in '+name.name);
  }
  const walk=async p=>{
    for(const e of await readdir(p,{withFileTypes:true})){
      const f=join(p,e.name);if(e.isDirectory()){if(e.name==='tests')continue;await walk(f);}
      else if(e.name.endsWith('.mjs'))assert.equal(bad.test(await readFile(f,'utf8')),false,'forbidden endpoint in '+f);
    }
  };
  await walk(dir);
});
