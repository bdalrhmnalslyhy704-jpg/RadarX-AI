import test from 'node:test';
import assert from 'node:assert/strict';
import {RadarSwarmCoordinator} from '../core/radar-swarm-coordinator.mjs';
function makeRunner({fail=false}={}){const state={running:false,starts:0,stops:0};return {state,instance:{start(){state.starts++;if(fail)return Promise.reject(new Error('synthetic start failure'));state.running=true;},stop(){state.stops++;state.running=false;},health(){return {running:state.running};}}};}
test('swarm launches twelve independent radars and isolates a failed worker',async()=>{const workers=Array.from({length:12},(_,i)=>makeRunner({fail:i===4}));const swarm=new RadarSwarmCoordinator({runners:workers.map((w,i)=>({id:'RADAR_'+(i+1),instance:w.instance})),startupSpacingMs:0,logger:{warn(){},error(){}}});const first=swarm.start(),second=swarm.start();assert.equal(first,second,'repeated start reuses the launch plan');await first;await new Promise(resolve=>setImmediate(resolve));const state=swarm.snapshot();assert.equal(state.expected_count,12);assert.equal(state.registered_count,12);assert.equal(state.running_count,11);assert.equal(state.failed_count,1);assert.equal(state.status,'DEGRADED');assert.ok(workers.every(w=>w.state.starts===1));await swarm.stop();assert.ok(workers.every(w=>w.state.stops===1));});
test('swarm rejects duplicate worker ownership and reports missing slots',()=>{const a=makeRunner(),b=makeRunner();assert.throws(()=>new RadarSwarmCoordinator({runners:[{id:'dup',instance:a.instance},{id:'DUP',instance:b.instance}]}),/RADAR_SWARM_DUPLICATE_ID/);const swarm=new RadarSwarmCoordinator({runners:[{id:'RADAR_1',instance:a.instance}],expectedCount:12});assert.equal(swarm.snapshot().status,'INCOMPLETE');assert.equal(swarm.snapshot().missing_count,11);});

test('an asynchronously failed bootstrap stays failed and is stopped even if it set running first',async()=>{
  const state={running:false,starts:0,stops:0};
  const instance={start(){state.starts++;state.running=true;return Promise.reject(new Error('bootstrap failed after timer start'));},stop(){state.stops++;state.running=false;},health(){return {running:state.running};}};
  const swarm=new RadarSwarmCoordinator({runners:[{id:'EARLY',instance}],expectedCount:1,startupSpacingMs:0,logger:{warn(){},error(){}}});
  await swarm.start();await new Promise(resolve=>setImmediate(resolve));
  const snapshot=swarm.snapshot();
  assert.equal(snapshot.radars[0].status,'FAILED');assert.equal(snapshot.running_count,0);assert.equal(state.stops,1);assert.equal(state.running,false);
  await swarm.stop();
});


test('watchdog detects a running radar that stops after startup and restarts it within budget', async () => {
  const worker = makeRunner();
  const swarm = new RadarSwarmCoordinator({
    runners: [{id: 'RADAR_8', name: 'Lightning', instance: worker.instance}],
    expectedCount: 1,
    startupSpacingMs: 0,
    watchdogIntervalMs: 10,
    restartCooldownMs: 0,
    maxRestarts: 2,
    logger: {warn() {}, error() {}}
  });
  await swarm.start();
  assert.equal(swarm.snapshot().status, 'RUNNING');
  worker.state.running = false; // simulate the interval/service unexpectedly stopping
  await new Promise(resolve => setTimeout(resolve, 45));
  const recovered = swarm.snapshot();
  assert.equal(worker.state.starts, 2);
  assert.equal(recovered.status, 'RUNNING');
  assert.equal(recovered.running_count, 1);
  assert.equal(recovered.failed_count, 0);
  assert.equal(recovered.radars[0].restart_attempts, 1);
  assert.equal(recovered.watchdog.enabled, true);
  await swarm.stop();
});

test('snapshot immediately reports a stopped worker as DEGRADED even before watchdog recovery runs', async () => {
  const worker = makeRunner();
  const swarm = new RadarSwarmCoordinator({
    runners: [{id: 'RADAR_1', instance: worker.instance}],
    expectedCount: 1,
    startupSpacingMs: 0,
    watchdogIntervalMs: 10000,
    maxRestarts: 0,
    logger: {warn() {}, error() {}}
  });
  await swarm.start();
  worker.state.running = false;
  const snapshot = swarm.snapshot();
  assert.equal(snapshot.status, 'DEGRADED');
  assert.equal(snapshot.radars[0].status, 'DEGRADED');
  assert.equal(snapshot.radars[0].running, false);
  assert.equal(snapshot.radars[0].last_error, 'WORKER_HEALTH_NOT_RUNNING');
  await swarm.stop();
});


test('watchdog does not restart a healthy radar sweep that lasts about four minutes', async () => {
  let now = 1_000_000;
  const state = {running: false, busy: false, busy_since_at: null, starts: 0, stops: 0};
  const instance = {
    start() { state.starts++; state.running = true; },
    stop() { state.stops++; state.running = false; state.busy = false; state.busy_since_at = null; },
    health() { return {running: state.running, busy: state.busy, busy_since_at: state.busy_since_at, poll_ms: 20_000}; }
  };
  const swarm = new RadarSwarmCoordinator({
    runners: [{id: 'COIN_HUNTER_RADAR', name: 'Coin Hunter', instance}], expectedCount: 1,
    startupSpacingMs: 0, watchdogIntervalMs: 10_000, restartCooldownMs: 0,
    maxRestarts: 1, clock: () => now, logger: {warn() {}, error() {}}
  });
  await swarm.start();
  state.busy = true; state.busy_since_at = now - 241_610;
  await swarm._runWatchdog(swarm.generation);
  const observed = swarm.snapshot();
  assert.equal(state.starts, 1);
  assert.equal(state.stops, 0);
  assert.equal(observed.status, 'RUNNING');
  assert.equal(observed.running_count, 1);
  assert.equal(observed.failed_count, 0);
  assert.equal(observed.radars[0].status, 'RUNNING');
  await swarm.stop();
});

test('watchdog restarts a radar whose scan latch stays busy beyond its deadline', async () => {
  let now = 1_000_000;
  const state = {running: false, busy: false, busy_since_at: null, starts: 0, stops: 0};
  const instance = {
    start() { state.starts++; state.running = true; state.busy = false; state.busy_since_at = null; },
    stop() { state.stops++; state.running = false; state.busy = false; state.busy_since_at = null; },
    health() { return {running: state.running, busy: state.busy, busy_since_at: state.busy_since_at, poll_ms: 20_000}; }
  };
  const swarm = new RadarSwarmCoordinator({
    runners: [{id: 'RADAR_8', name: 'Lightning', instance}], expectedCount: 1,
    startupSpacingMs: 0, watchdogIntervalMs: 10_000, restartCooldownMs: 0,
    maxRestarts: 1, clock: () => now, logger: {warn() {}, error() {}}
  });
  await swarm.start();
  state.busy = true; state.busy_since_at = now - 310_000;
  await swarm._runWatchdog(swarm.generation);
  const recovered = swarm.snapshot();
  assert.equal(state.starts, 2); assert.equal(state.stops, 1);
  assert.equal(recovered.radars[0].restart_attempts, 1);
  assert.equal(recovered.status, 'RUNNING'); assert.equal(recovered.running_count, 1);
  assert.equal(recovered.failed_count, 0);
  await swarm.stop();
});
