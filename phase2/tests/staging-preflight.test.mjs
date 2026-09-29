import test from 'node:test';
import assert from 'node:assert/strict';
import {assertStagingEnvironment,assertReadOnlyStagingConfig} from '../deploy/preflight.mjs';

const base={
  RADARX_ENV:'staging',
  RADARX_STAGING_TEST_PUSH_ENABLED:'true',
  RADARX_PUSH_PROVIDER:'webpush',
  RADARX_AUTH_SECRET:'TEST_FIXTURE_AUTH_SECRET_12345678901234567890',
  VAPID_SUBJECT:'mailto:operator@example.test',
  VAPID_PUBLIC_KEY:'TEST_FIXTURE_VAPID_PUBLIC',
  VAPID_PRIVATE_KEY:'TEST_FIXTURE_VAPID_PRIVATE',
  RADARX_ALLOWED_ORIGINS:'https://staging.example.test',
  RADARX_HOST:'127.0.0.1',
  RADARX_PAPER_TRADING:'true',
  RADARX_REAL_ORDER_EXECUTION:'false',
  RADARX_CONFIDENCE_MODE:'UNKNOWN'
};

test('TEST_FIXTURE: staging preflight accepts complete safe configuration',()=>{
  const out=assertStagingEnvironment({...base});
  assert.deepEqual(out,{environment:'staging',pushProvider:'webpush',testPushEnabled:true,allowedOrigins:['https://staging.example.test'],
    paperTrading:true,realOrderExecution:false,confidenceMode:'UNKNOWN'});
});

test('TEST_FIXTURE: staging preflight fails when required secret is missing',()=>{
  const env={...base};delete env.RADARX_AUTH_SECRET;
  assert.throws(()=>assertStagingEnvironment(env),/RADARX_AUTH_SECRET_REQUIRED/);
});

test('TEST_FIXTURE: staging preflight fails on non-HTTPS origin',()=>{
  const env={...base,RADARX_ALLOWED_ORIGINS:'http://staging.example.test'};
  assert.throws(()=>assertStagingEnvironment(env),/STAGING_ALLOWED_ORIGINS_MUST_USE_HTTPS/);
});

test('TEST_FIXTURE: staging preflight requires an explicit test-push flag',()=>{
  const env={...base};delete env.RADARX_STAGING_TEST_PUSH_ENABLED;
  assert.throws(()=>assertStagingEnvironment(env),/RADARX_STAGING_TEST_PUSH_ENABLED_MUST_BE_EXPLICIT_TRUE_OR_FALSE/);
});

test('TEST_FIXTURE: staging preflight blocks attempts to turn on real order execution',()=>{
  const env={...base,RADARX_REAL_ORDER_EXECUTION:'true'};
  assert.throws(()=>assertStagingEnvironment(env),/REAL_ORDER_EXECUTION_MUST_REMAIN_FALSE/);
});

test('TEST_FIXTURE: staging preflight rejects non-loopback application bind',()=>{
  const env={...base,RADARX_HOST:'0.0.0.0'};
  assert.throws(()=>assertStagingEnvironment(env),/STAGING_HOST_MUST_BE_LOOPBACK/);
});

test('TEST_FIXTURE: read-only runtime flags are enforced',()=>{
  assert.equal(assertReadOnlyStagingConfig({paper:{paperTrading:true,realOrderExecution:false}}),true);
  assert.throws(()=>assertReadOnlyStagingConfig({paper:{paperTrading:true,realOrderExecution:true}}),/REAL_ORDER_EXECUTION_MUST_REMAIN_FALSE/);
  assert.throws(()=>assertReadOnlyStagingConfig({paper:{paperTrading:false,realOrderExecution:false}}),/PAPER_TRADING_MUST_REMAIN_TRUE/);
});
