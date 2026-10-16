import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

test('historical learning lab dry-run is deterministic metadata-only and performs no report/network work',()=>{
  const script=resolve(dirname(fileURLToPath(import.meta.url)),'../tools/historical-learning-lab.mjs');
  const run=spawnSync(process.execPath,[script,'--dry-run','--reports','not-read.json','--moderate-move-pct','5','--strong-move-pct','15'],{
    encoding:'utf8',timeout:10_000
  });
  assert.equal(run.status,0,run.stderr||run.stdout);
  const plan=JSON.parse(run.stdout);
  assert.equal(plan.status,'DRY_RUN_NO_NETWORK');
  assert.equal(plan.thresholds.moderate_move_pct,5);
  assert.equal(plan.thresholds.strong_move_pct,15);
  assert.equal(plan.policy.real_order_execution,false);
  assert.equal(plan.policy.live_threshold_updates,false);
});

test('historical learning lab refuses an empty run instead of producing an empty success report',()=>{
  const script=resolve(dirname(fileURLToPath(import.meta.url)),'../tools/historical-learning-lab.mjs');
  const run=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:10_000});
  assert.equal(run.status,1);
  assert.match(run.stderr,/HISTORICAL_REPLAY_REPORTS_REQUIRED/);
});
