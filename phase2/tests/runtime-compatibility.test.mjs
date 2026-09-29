import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveHost,resolvePort,assertAllowedHost,sanitizeLogMessage} from '../runtime.mjs';
import {CONFIG} from '../config.mjs';
import {startServer} from '../server.mjs';

async function freePort(){
  const s=createServer();
  await new Promise((resolve,reject)=>s.listen(0,'127.0.0.1',resolve).on('error',reject));
  const p=s.address().port;
  await new Promise(resolve=>s.close(resolve));
  return p;
}

function withEnv(values){
  const previous={};
  for(const [key,value] of Object.entries(values)){
    previous[key]=Object.hasOwn(process.env,key)?process.env[key]:undefined;
    if(value===undefined)delete process.env[key]; else process.env[key]=String(value);
  }
  return ()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}};
}

function safeStagingConfig(host,port,dataDir){
  return {...CONFIG,
    environment:'staging',host,port,confidenceMode:'UNKNOWN',
    paper:{...CONFIG.paper,paperTrading:true,realOrderExecution:false},
    push:{...CONFIG.push,provider:'webpush',vapidSubject:'mailto:operator@example.test',vapidPublicKey:'TEST_FIXTURE_VAPID_PUBLIC',vapidPrivateKey:'TEST_FIXTURE_VAPID_PRIVATE'},
    auth:{...CONFIG.auth,secret:'TEST_FIXTURE_AUTH_SECRET_12345678901234567890',allowedOrigins:['https://staging.example.test']},
    staging:{...CONFIG.staging,testPushEnabled:true},
    monitoring:{...CONFIG.monitoring,bootstrapKlines:1,repairKlines:1,periodicRepairMs:100000}
  };
}

function fakeMonitorFactory(){
  return {
    async start(){},
    async stop(){},
    health:()=>({database:{state:'LIVE'},websocket:{state:'LIVE'},rest:{state:'LIVE'},monitoring:{running:true},bootstrap_done:true})
  };
}

async function startAndCheck({host,port}){
  const dataDir=await mkdtemp(join(tmpdir(),'radarx-runtime-smoke-'));
  const restore=withEnv({
    RADARX_ENV:'staging',
    RADARX_STAGING_TEST_PUSH_ENABLED:'true',
    RADARX_PUSH_PROVIDER:'webpush',
    RADARX_AUTH_SECRET:'TEST_FIXTURE_AUTH_SECRET_12345678901234567890',
    VAPID_SUBJECT:'mailto:operator@example.test',
    VAPID_PUBLIC_KEY:'TEST_FIXTURE_VAPID_PUBLIC',
    VAPID_PRIVATE_KEY:'TEST_FIXTURE_VAPID_PRIVATE',
    RADARX_ALLOWED_ORIGINS:'https://staging.example.test',
    RADARX_PUBLIC_API_ORIGIN:'https://api.example.test',
    RADARX_HOST:host,
    PORT:String(port),
    RADARX_DATA_DIR:dataDir,
    RADARX_PAPER_TRADING:'true',
    RADARX_REAL_ORDER_EXECUTION:'false',
    RADARX_CONFIDENCE_MODE:'UNKNOWN'
  });
  const logs=[];
  try{
    const started=await startServer({
      config:safeStagingConfig(host,port,dataDir),
      monitorFactory:()=>fakeMonitorFactory(),
      logger:{info:msg=>logs.push(String(msg)),warn:()=>{},error:()=>{}}
    });
    const base='http://127.0.0.1:'+port;
    const health=await fetch(base+'/healthz');
    const ready=await fetch(base+'/readyz');
    assert.equal(health.status,200);
    assert.equal(ready.status,200);
    assert.equal((await ready.json()).ready,true);
    assert.ok(logs.some(x=>x.includes(host+':'+port)));
    await started.close();
  }finally{restore();}
}

test('local runtime defaults to loopback and fixed fallback port only when PORT/RADARX_PORT are absent',()=>{
  assert.equal(resolveHost({}),'127.0.0.1');
  assert.equal(resolvePort({}),8787);
});

test('PORT takes precedence over RADARX_PORT and is validated',()=>{
  assert.equal(resolvePort({PORT:'19001',RADARX_PORT:'19002'}),19001);
  assert.throws(()=>resolvePort({PORT:'0'}),/PORT_OUT_OF_RANGE/);
  assert.throws(()=>resolvePort({PORT:'65536'}),/PORT_OUT_OF_RANGE/);
  assert.throws(()=>resolvePort({PORT:'abc'}),/PORT_MUST_BE_INTEGER/);
});

test('0.0.0.0 is accepted only explicitly in staging/production',()=>{
  assert.equal(assertAllowedHost('0.0.0.0','staging',{explicit:true}),'0.0.0.0');
  assert.equal(assertAllowedHost('0.0.0.0','production',{explicit:true}),'0.0.0.0');
  assert.throws(()=>assertAllowedHost('0.0.0.0','development',{explicit:true}),/WILDCARD_HOST_ONLY_ALLOWED_IN_STAGING_OR_PRODUCTION/);
  assert.throws(()=>assertAllowedHost('0.0.0.0','staging',{explicit:false}),/WILDCARD_HOST_MUST_BE_EXPLICIT/);
  assert.throws(()=>assertAllowedHost('10.0.0.1','staging',{explicit:true}),/HOST_NOT_ALLOWED/);
});

test('startup log sanitization removes auth and bearer secrets',()=>{
  const env={RADARX_AUTH_SECRET:'TEST_FIXTURE_SECRET_SHOULD_NOT_LOG',VAPID_PRIVATE_KEY:'TEST_FIXTURE_VAPID_PRIVATE'};
  const out=sanitizeLogMessage('error RADARX_AUTH_SECRET='+env.RADARX_AUTH_SECRET+' VAPID_PRIVATE_KEY='+env.VAPID_PRIVATE_KEY+' Authorization: Bearer TEST_TOKEN',env);
  assert.equal(out.includes(env.RADARX_AUTH_SECRET),false);
  assert.equal(out.includes(env.VAPID_PRIVATE_KEY),false);
  assert.equal(out.includes('TEST_TOKEN'),false);
});

test('server binds locally on 127.0.0.1 and health/readiness succeed',async()=>{
  await startAndCheck({host:'127.0.0.1',port:await freePort()});
});

test('server binds on 0.0.0.0 with staging PORT and health/readiness succeed',async()=>{
  await startAndCheck({host:'0.0.0.0',port:await freePort()});
});


test('async store health is awaited and rendered as JSON object in /readyz',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-readyz-async-'));const port=await freePort();
  await startAndCheck({host:'127.0.0.1',port,storeHealth:async()=>{await new Promise(r=>setTimeout(r,5));return{state:'LIVE',path:dir,last_write_at:123};}});
});

test('/readyz returns 503 with JSON database state when storage is not ready',async()=>{
  const port=await freePort(),dataDir=await mkdtemp(join(tmpdir(),'radarx-readyz-fail-'));const restore=withEnv({RADARX_ENV:'staging',RADARX_STAGING_TEST_PUSH_ENABLED:'false',RADARX_PUSH_PROVIDER:'webpush',RADARX_AUTH_SECRET:'TEST_FIXTURE_AUTH_SECRET_12345678901234567890',VAPID_SUBJECT:'mailto:operator@example.test',VAPID_PUBLIC_KEY:'TEST_FIXTURE_VAPID_PUBLIC',VAPID_PRIVATE_KEY:'TEST_FIXTURE_VAPID_PRIVATE',RADARX_ALLOWED_ORIGINS:'https://staging.example.test',RADARX_PUBLIC_API_ORIGIN:'https://api.example.test',RADARX_HOST:'127.0.0.1',PORT:String(port),RADARX_DATA_DIR:dataDir,RADARX_PAPER_TRADING:'true',RADARX_REAL_ORDER_EXECUTION:'false',RADARX_CONFIDENCE_MODE:'UNKNOWN'});
  try{const started=await startServer({config:safeStagingConfig('127.0.0.1',port,dataDir),monitorFactory:()=>({async start(){},async stop(){},health:async()=>({database:{state:'ERROR',error:'STORAGE_DOWN'},websocket:{state:'LIVE'},rest:{state:'LIVE'},monitoring:{running:true},bootstrap_done:true})}),logger:{info(){},warn(){},error(){}}});
    const r=await fetch('http://127.0.0.1:'+port+'/readyz'),raw=await r.text(),json=JSON.parse(raw);assert.equal(r.status,503);assert.equal(json.ready,false);assert.equal(json.health.database.state,'ERROR');assert.equal(typeof json.health.database,'object');assert.equal(raw.includes('{}'),false);await started.close();
  }finally{restore();}
});
