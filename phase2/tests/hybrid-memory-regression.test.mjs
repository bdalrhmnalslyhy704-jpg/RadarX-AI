import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('hybrid TCN training never retains every row forward cache for an epoch',async()=>{
  const source=await readFile(new URL('../core/hybrid-tcn-attention-benchmark.mjs',import.meta.url),'utf8');
  assert.ok(source.includes('SCALAR_PROBABILITY_PASS_THEN_SINGLE_ROW_RECOMPUTE'));
  assert.ok(source.includes('maximum_simultaneous_forward_caches: 1'));
  assert.ok(source.includes('const probabilities = new Array(normalizedRows.length)'));
  assert.ok(source.includes('const cache = forwardHybrid(normalizedRows[index].sequence, model)'));
  assert.ok(source.includes('accumulateTreeInPlace(gradients, item)'));
  assert.equal(source.includes('const caches = normalizedRows.map(row => forwardHybrid(row.sequence, model))'),false,
    'all row activations/depth caches must not be retained simultaneously');
});
