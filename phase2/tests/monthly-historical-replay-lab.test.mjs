import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

test('monthly historical replay lab dry-run declares the actual replay scope and never reads the input',()=>{
  const script=resolve(dirname(fileURLToPath(import.meta.url)),'../tools/monthly-historical-replay-lab.mjs');
  const run=spawnSync(process.execPath,[script,'--dry-run','--input','missing-monthly-report.json','--outcome-horizon-hours','24'],{
    encoding:'utf8',timeout:10_000
  });
  assert.equal(run.status,0,run.stderr||run.stdout);
  const plan=JSON.parse(run.stdout);
  assert.equal(plan.status,'DRY_RUN_NO_NETWORK');
  assert.equal(plan.detector_profile,'STRONG_MOVE_RADAR');
  assert.equal(plan.outcome_horizon_hours,24);
  assert.equal(plan.policy.event_marker_is_evaluator_input,false);
});

test('monthly historical replay lab fails closed without an input report',()=>{
  const script=resolve(dirname(fileURLToPath(import.meta.url)),'../tools/monthly-historical-replay-lab.mjs');
  const run=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:10_000});
  assert.equal(run.status,1);
  assert.match(run.stderr,/MONTHLY_FORENSICS_INPUT_REQUIRED/);
});
