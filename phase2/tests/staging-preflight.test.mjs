import test from './test-helpers.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertDeploymentEnvironment,assertReadOnlyStagingConfig} from '../deploy/preflight.mjs';

const base={
  RADARX_ENV:'staging',
  RADARX_STAGING_TEST_PUSH_ENABLED:'true',
  RADARX_PUSH_PROVIDER:'webpush',
  RADARX_AUTH_SECRET:'TEST_FIXTURE_AUTH_SECRET_12345678901234567890',
  VAPID_SUBJECT:'mailto:operator@example.test',
  VAPID_PUBLIC_KEY:'TEST_FIXTURE_VAPID_PUBLIC',
  VAPID_PRIVATE_KEY:'TEST_FIXTURE_VAPID_PRIVATE',
  RADARX_ALLOWED_ORIGINS:'https://staging.example.test',
  RADARX_PUBLIC_API_ORIGIN:'https://api.example.test',
  RADARX_HOST:'127.0.0.1',
  RADARX_PAPER_TRADING:'true',
  RADARX_REAL_ORDER_EXECUTION:'false',
  RADARX_CONFIDENCE_MODE:'UNKNOWN'
};

async function validEnv(overrides={}){
  return {...base,RADARX_DATA_DIR:await mkdtemp(join(tmpdir(),'radarx-preflight-')),PORT:'18087',...overrides};
}

test('TEST_FIXTURE: staging preflight accepts complete safe configuration and storage',async()=>{
  const env=await validEnv();
  const out=assertDeploymentEnvironment(env);
  assert.deepEqual(out,{environment:'staging',pushProvider:'webpush',testPushEnabled:true,allowedOrigins:['https://staging.example.test'],
    host:'127.0.0.1',port:18087,dataDir:env.RADARX_DATA_DIR,paperTrading:true,realOrderExecution:false,confidenceMode:'UNKNOWN'});
});

test('TEST_FIXTURE: staging preflight accepts explicit 0.0.0.0 for managed runtime',async()=>{
  const out=assertDeploymentEnvironment(await validEnv({RADARX_HOST:'0.0.0.0'}));
  assert.equal(out.host,'0.0.0.0');
});

test('TEST_FIXTURE: staging preflight fails when required secret is missing',async()=>{
  const env=await validEnv();delete env.RADARX_AUTH_SECRET;
  assert.throws(()=>assertDeploymentEnvironment(env),/RADARX_AUTH_SECRET_REQUIRED/);
});

test('TEST_FIXTURE: staging preflight fails on non-HTTPS origin',async()=>{
  const env=await validEnv({RADARX_ALLOWED_ORIGINS:'http://staging.example.test'});
  assert.throws(()=>assertDeploymentEnvironment(env),/STAGING_ALLOWED_ORIGINS_MUST_USE_HTTPS/);
});

test('TEST_FIXTURE: staging preflight requires an explicit test-push flag',async()=>{
  const env=await validEnv();delete env.RADARX_STAGING_TEST_PUSH_ENABLED;
  assert.throws(()=>assertDeploymentEnvironment(env),/RADARX_STAGING_TEST_PUSH_ENABLED_MUST_BE_EXPLICIT_TRUE_OR_FALSE/);
});

test('TEST_FIXTURE: staging preflight blocks attempts to turn on real order execution',async()=>{
  const env=await validEnv({RADARX_REAL_ORDER_EXECUTION:'true'});
  assert.throws(()=>assertDeploymentEnvironment(env),/REAL_ORDER_EXECUTION_MUST_REMAIN_FALSE/);
});

test('TEST_FIXTURE: staging preflight blocks disabling paper trading',async()=>{
  const env=await validEnv({RADARX_PAPER_TRADING:'false'});
  assert.throws(()=>assertDeploymentEnvironment(env),/PAPER_TRADING_MUST_REMAIN_TRUE/);
});

test('TEST_FIXTURE: staging preflight blocks changing confidence mode',async()=>{
  const env=await validEnv({RADARX_CONFIDENCE_MODE:'70'});
  assert.throws(()=>assertDeploymentEnvironment(env),/CONFIDENCE_MODE_MUST_REMAIN_UNKNOWN/);
});

test('TEST_FIXTURE: invalid PORT is rejected',async()=>{
  const badInteger=await validEnv({PORT:'not-a-port'});
  const zero=await validEnv({PORT:'0'});
  const tooHigh=await validEnv({PORT:'65536'});
  assert.throws(()=>assertDeploymentEnvironment(badInteger),/PORT_MUST_BE_INTEGER/);
  assert.throws(()=>assertDeploymentEnvironment(zero),/PORT_OUT_OF_RANGE/);
  assert.throws(()=>assertDeploymentEnvironment(tooHigh),/PORT_OUT_OF_RANGE/);
});

test('TEST_FIXTURE: disallowed host is rejected',async()=>{
  const env=await validEnv({RADARX_HOST:'192.168.1.5'});
  assert.throws(()=>assertDeploymentEnvironment(env),/HOST_NOT_ALLOWED/);
});

test('TEST_FIXTURE: wildcard host is rejected outside staging/production',async()=>{
  const env=await validEnv({RADARX_ENV:'development',RADARX_HOST:'0.0.0.0'});
  assert.throws(()=>assertDeploymentEnvironment(env),/STAGING_OR_PRODUCTION_ENV_REQUIRED/);
});

test('TEST_FIXTURE: missing data directory is created, but a file path is rejected',async()=>{
  const env=await validEnv({RADARX_DATA_DIR:join(await mkdtemp(join(tmpdir(),'radarx-data-')),'new-data')});
  const out=assertDeploymentEnvironment(env);
  assert.equal(out.dataDir,env.RADARX_DATA_DIR);
  const root=await mkdtemp(join(tmpdir(),'radarx-file-'));const filePath=join(root,'not-a-directory');await writeFile(filePath,'TEST_FIXTURE');
  assert.throws(()=>assertDeploymentEnvironment({...env,RADARX_DATA_DIR:filePath}),/RADARX_DATA_DIR_NOT_WRITABLE_OR_CREATABLE/);
});

test('TEST_FIXTURE: read-only runtime flags include UNKNOWN confidence',()=>{
  const cfg={paper:{paperTrading:true,realOrderExecution:false},confidenceMode:'UNKNOWN'};
  assert.equal(assertReadOnlyStagingConfig(cfg),true);
  assert.throws(()=>assertReadOnlyStagingConfig({paper:{paperTrading:true,realOrderExecution:true},confidenceMode:'UNKNOWN'}),/REAL_ORDER_EXECUTION_MUST_REMAIN_FALSE/);
  assert.throws(()=>assertReadOnlyStagingConfig({paper:{paperTrading:false,realOrderExecution:false},confidenceMode:'UNKNOWN'}),/PAPER_TRADING_MUST_REMAIN_TRUE/);
  assert.throws(()=>assertReadOnlyStagingConfig({paper:{paperTrading:true,realOrderExecution:false},confidenceMode:'70'}),/CONFIDENCE_MODE_MUST_REMAIN_UNKNOWN/);
});


test('TEST_FIXTURE: staging requires explicit Render persistent data directory',async()=>{const env=await validEnv();delete env.RADARX_DATA_DIR;assert.throws(()=>assertDeploymentEnvironment(env),/RADARX_DATA_DIR_REQUIRED/);});

test('TEST_FIXTURE: production cannot enable the staging-only test endpoint',async()=>{const env=await validEnv({RADARX_ENV:'production'});assert.throws(()=>assertDeploymentEnvironment(env),/TEST_PUSH_ONLY_STAGING_ONLY/);});

test('TEST_FIXTURE: staging public API origin must be exact HTTPS',async()=>{const env=await validEnv({RADARX_PUBLIC_API_ORIGIN:'http://api.example.test'});assert.throws(()=>assertDeploymentEnvironment(env),/RADARX_PUBLIC_API_ORIGIN_MUST_BE_EXACT_HTTPS_ORIGIN/);});
