import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateEliteGate} from '../core/elite-confluence-gate.mjs';

test('elite gate accepts true multi-factor pre-expansion setup',()=>{
  const x=evaluateEliteGate({
    radar:'TEST',direction:'UP_MOVE',baseScore:91,priceChange24h:1.2,liquidityScore:82,dataQualityScore:95,
    triggerScore:88,structureScore:84,participationScore:86,flowScore:83,relativeScore:79,
    momentumScore:88,compressionScore:76,confirmations:9,minConfirmations:7,minScore:84,max24hMovePct:3
  });
  assert.equal(x.eligible,true);
  assert.equal(x.stage,'ELITE_IGNITION');
  assert.ok(x.category_hits>=5);
});

test('elite gate rejects volume-only fake candidate',()=>{
  const x=evaluateEliteGate({
    radar:'TEST',direction:'UP_MOVE',baseScore:92,priceChange24h:1.5,liquidityScore:82,dataQualityScore:95,
    triggerScore:86,structureScore:45,participationScore:96,flowScore:42,relativeScore:44,
    momentumScore:48,compressionScore:46,confirmations:8,minConfirmations:7,minScore:84,max24hMovePct:3
  });
  assert.equal(x.eligible,false);
  assert.ok(x.risk_flags.includes('LOW_CATEGORY_DIVERSITY'));
});

test('elite gate rejects already extended moves for early detection',()=>{
  const x=evaluateEliteGate({
    radar:'TEST',direction:'UP_MOVE',baseScore:95,priceChange24h:12,liquidityScore:95,dataQualityScore:95,
    triggerScore:95,structureScore:90,participationScore:92,flowScore:90,relativeScore:88,
    momentumScore:94,compressionScore:87,confirmations:10,minConfirmations:7,minScore:84,max24hMovePct:5
  });
  assert.equal(x.eligible,false);
  assert.ok(x.risk_flags.includes('ALREADY_EXTENDED_24H'));
});
