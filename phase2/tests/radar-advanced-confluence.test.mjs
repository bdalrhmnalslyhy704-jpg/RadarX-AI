import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateAdvancedConfluence,buildAdvancedRiskFlags} from '../core/radar-advanced-confluence.mjs';

test('advanced confluence rewards aligned multi-factor ignition',()=>{
  const x=evaluateAdvancedConfluence({
    baseScore:91,priceChange24h:1.2,confirmations:9,minConfirmations:7,
    categories:{trigger:90,structure:86,participation:84,flow:82,relative:80,momentum:89,compression:78}
  });
  assert.equal(x.eligible,true);
  assert.ok(x.score>=84);
  assert.equal(x.regime,'COMPRESSION_IGNITION');
  assert.ok(x.confirmation_breadth>=70);
  assert.ok(x.algorithms.length>=6);
});

test('advanced confluence rejects disjointed high-volume noise',()=>{
  const x=evaluateAdvancedConfluence({
    baseScore:92,priceChange24h:1.5,confirmations:8,minConfirmations:7,
    categories:{trigger:88,structure:42,participation:97,flow:35,relative:43,momentum:45,compression:38}
  });
  assert.equal(x.eligible,false);
  assert.ok(buildAdvancedRiskFlags(x).length>0);
});

test('anti-chase guard penalizes already extended moves without network work',()=>{
  const early=evaluateAdvancedConfluence({
    baseScore:90,priceChange24h:1.0,confirmations:8,minConfirmations:7,
    categories:{trigger:88,structure:84,participation:84,flow:82,relative:80,momentum:87,compression:76}
  });
  const extended=evaluateAdvancedConfluence({
    baseScore:90,priceChange24h:16,confirmations:8,minConfirmations:7,
    categories:{trigger:88,structure:84,participation:84,flow:82,relative:80,momentum:87,compression:76}
  });
  assert.ok(early.anti_chase>extended.anti_chase);
  assert.ok(extended.score<early.score);
});
