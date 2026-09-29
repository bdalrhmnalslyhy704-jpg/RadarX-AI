import test from 'node:test';
import assert from 'node:assert/strict';
import {assertReadOnlySignal,READ_ONLY_POLICY} from '../core/signal-service.mjs';

test('TEST_FIXTURE: policy is permanently read-only for this phase',()=>{
  assert.equal(READ_ONLY_POLICY.market,'SPOT');assert.equal(READ_ONLY_POLICY.paper_trading,true);assert.equal(READ_ONLY_POLICY.real_order_execution,false);
  assert.doesNotThrow(()=>assertReadOnlySignal({paper_trade:{enabled:true,real_order_execution:false}}));
  assert.throws(()=>assertReadOnlySignal({paper_trade:{enabled:true,real_order_execution:true}}),/READ_ONLY_POLICY_VIOLATION/);
});
