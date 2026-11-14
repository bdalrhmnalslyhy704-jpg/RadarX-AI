import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const workflow=readFileSync(resolve(root,'.github/workflows/neural-closure-data-collection.yml'),'utf8');
const events=workflow.split('\npermissions:')[0];

test('PR events do not start a duplicate 60-day Binance collection',()=>{
  assert.match(events,/^  pull_request:/m);
  assert.match(workflow,/^  collect:\n    if: github\.event_name != 'pull_request'$/m);
});

test('collector concurrency is keyed by event and source branch, not synthetic SHA/ref',()=>{
  assert.match(workflow,/group: build224-neural-closure-dataset-\$\{\{ github\.event_name \}\}-\$\{\{ github\.head_ref \|\| github\.ref_name \}\}/);
  assert.doesNotMatch(workflow,/group:.*\$\{\{\s*github\.(?:ref|sha)\s*\}\}/);
  assert.match(workflow,/cancel-in-progress: false/);
});

test('push and manual collection remain enabled on the research branch',()=>{
  assert.match(events,/^  push:/m);
  assert.match(events,/^  workflow_dispatch:/m);
  assert.match(events,/branches:\n\s+- research\/neural-closure-4h-20261114/);
});
