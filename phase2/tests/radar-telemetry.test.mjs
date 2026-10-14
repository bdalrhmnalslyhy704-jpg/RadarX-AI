import test from 'node:test';
import assert from 'node:assert/strict';
import {instrumentRadarCycle,radarTelemetry} from '../core/radar-telemetry.mjs';

function clockSequence(values){
  let index=0;
  return ()=>values[Math.min(index++,values.length-1)];
}

test('instrumentRadarCycle records an active tick duration and preserves return value',async()=>{
  const radarId='TEST_RADAR_TELEMETRY_TICK';
  const before=radarTelemetry.totalRecorded;
  const radar={running:true,busy:false,async tick(){this.busy=true;await Promise.resolve();this.busy=false;return 'tick-result';}};
  assert.equal(instrumentRadarCycle(radar,radarId,{clock:clockSequence([1000,1042])}),true);
  assert.equal(await radar.tick(),'tick-result');
  assert.equal(instrumentRadarCycle(radar,radarId),false,'the same instance must not be wrapped twice');
  const event=radarTelemetry.events.slice().reverse().find(row=>row.radar===radarId);
  assert.ok(event);
  assert.equal(event.event_type,'BACKGROUND_CYCLE');
  assert.equal(event.pipeline_latency_ms,42);
  assert.equal(event.reason_codes[0],'CYCLE_COMPLETED_WITHOUT_GATE_DECISION');
  assert.equal(radarTelemetry.totalRecorded,before+1);
});

test('instrumentRadarCycle also supports scan and reconciliation workers',async()=>{
  for(const [method,radarId] of [['scan','TEST_RADAR_TELEMETRY_SCAN'],['reconcile','TEST_RADAR_TELEMETRY_RECONCILE']]){
    const before=radarTelemetry.totalRecorded;
    const instance={running:true,busy:false,async [method](){return method;}};
    assert.equal(instrumentRadarCycle(instance,radarId,{clock:clockSequence([2000,2025])}),true);
    assert.equal(await instance[method](),method);
    const event=radarTelemetry.events.slice().reverse().find(row=>row.radar===radarId);
    assert.ok(event);
    assert.equal(event.pipeline_latency_ms,25);
    assert.equal(radarTelemetry.totalRecorded,before+1);
  }
});

test('instrumentRadarCycle rethrows errors and records a bounded cycle error',async()=>{
  const radarId='TEST_RADAR_TELEMETRY_ERROR';
  const instance={running:true,busy:false,async tick(){throw new Error('bad network / retry');}};
  instrumentRadarCycle(instance,radarId,{clock:clockSequence([3000,3010])});
  await assert.rejects(instance.tick(),/bad network/);
  const event=radarTelemetry.events.slice().reverse().find(row=>row.radar===radarId);
  assert.ok(event);
  assert.equal(event.pipeline_latency_ms,10);
  assert.match(event.reason_codes[0],/^CYCLE_ERROR:bad_network___retry$/);
});

test('stopped radar ticks run normally without fake cycle telemetry',async()=>{
  const radarId='TEST_RADAR_TELEMETRY_STOPPED';
  const before=radarTelemetry.totalRecorded;
  const instance={running:false,busy:false,async tick(){return 'stopped';}};
  instrumentRadarCycle(instance,radarId,{clock:clockSequence([4000,4001])});
  assert.equal(await instance.tick(),'stopped');
  assert.equal(radarTelemetry.totalRecorded,before);
});
