import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveRadarAutostart} from '../config.mjs';

test('production runtime auto-starts optional radars when no explicit override exists',()=>{
  assert.equal(resolveRadarAutostart({NODE_ENV:'production'}),true);
  assert.equal(resolveRadarAutostart({RAILWAY_ENVIRONMENT:'production'}),true);
  assert.equal(resolveRadarAutostart({RAILWAY_ENVIRONMENT_NAME:'production'}),true);
  assert.equal(resolveRadarAutostart({RADARX_ENV:'production'}),true);
  assert.equal(resolveRadarAutostart({NODE_ENV:'prod'}),true);
});

test('explicit radar autostart setting always wins',()=>{
  assert.equal(resolveRadarAutostart({NODE_ENV:'production',RADARX_RADARS_AUTOSTART:'false'}),false);
  assert.equal(resolveRadarAutostart({NODE_ENV:'development',RADARX_RADARS_AUTOSTART:'true'}),true);
  assert.equal(resolveRadarAutostart({RADARX_RADARS_AUTOSTART:'False'}),false);
});

test('development remains opt-in rather than auto-starting every optional radar',()=>{
  assert.equal(resolveRadarAutostart({NODE_ENV:'development'}),false);
  assert.equal(resolveRadarAutostart({}),false);
});
