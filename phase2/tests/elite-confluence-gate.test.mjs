import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateEliteGate} from '../core/elite-confluence-gate.mjs';

test('elite gate accepts true multi-factor pre-expansion setup',()=>{
  const x=evaluateEliteGate({
    radar:'TEST',direction:'UP_MOVE',baseScore:91,priceChange24h:1.2,liquidityScore:82,dataQualityScore:95,
    triggerScore:88,structureScore:84,participationScore:86,flowScore:83,relativeScore:79,
    momentumScore:88,compressionScore:76,confirmations:9,minConfirmations:7,minScore:84,max24hMovePct:3
  });
  assert.ok(Number.isFinite(x.score));
  assert.ok(x.score>=84);
  assert.ok(x.category_hits>=5);
  assert.ok(x.categories.trigger>=70);
  assert.ok(x.categories.structure>=70);
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

test('elite gate fails closed if required taker-buy ratio is missing or not above 70%',()=>{
  const base={direction:'UP_MOVE',baseScore:99,priceChange24h:1,liquidityScore:90,dataQualityScore:95,
    triggerScore:92,structureScore:90,participationScore:92,flowScore:94,relativeScore:88,momentumScore:92,
    compressionScore:85,confirmations:9,minConfirmations:6,minScore:84,max24hMovePct:5,requireTakerBuyRatio:true,minTakerBuyRatio:0.70};
  assert.equal(evaluateEliteGate(base).eligible,false);
  assert.ok(evaluateEliteGate(base).risk_flags.includes('TAKER_BUY_RATIO_DATA_MISSING'));
  const edge=evaluateEliteGate({...base,takerBuyRatio:0.70});
  assert.equal(edge.eligible,false);
  assert.ok(edge.risk_flags.includes('TAKER_BUY_RATIO_NOT_ABOVE_70_PERCENT'));
  assert.equal(evaluateEliteGate({...base,takerBuyRatio:0.71}).eligible,true);
});
test('base composite does not alter the score for fixed independent evidence categories',()=>{
  const base={direction:'UP_MOVE',priceChange24h:1,liquidityScore:90,dataQualityScore:95,
    triggerScore:88,structureScore:84,participationScore:86,flowScore:83,relativeScore:79,
    momentumScore:88,compressionScore:76,confirmations:9,minConfirmations:7,minScore:84,max24hMovePct:3};
  assert.equal(evaluateEliteGate({...base,baseScore:0}).score,evaluateEliteGate({...base,baseScore:100}).score);
});


test('negative 24h performance does not mislabel an upward reversal as an extended chase',()=>{
  const x=evaluateEliteGate({
    radar:'TEST',direction:'UP_MOVE',baseScore:95,priceChange24h:-12,liquidityScore:95,dataQualityScore:95,
    triggerScore:95,structureScore:90,participationScore:92,flowScore:90,relativeScore:88,momentumScore:94,
    compressionScore:87,confirmations:10,minConfirmations:7,minScore:84,max24hMovePct:5
  });
  assert.equal(x.risk_flags.includes('ALREADY_EXTENDED_24H'),false);
  assert.equal(x.advanced.anti_chase,100);
  assert.equal(x.eligible,true);
});

test('a positive prior move still trips the upward anti-chase guard',()=>{
  const x=evaluateEliteGate({
    radar:'TEST',direction:'UP_MOVE',baseScore:95,priceChange24h:12,liquidityScore:95,dataQualityScore:95,
    triggerScore:95,structureScore:90,participationScore:92,flowScore:90,relativeScore:88,momentumScore:94,
    compressionScore:87,confirmations:10,minConfirmations:7,minScore:84,max24hMovePct:5
  });
  assert.equal(x.risk_flags.includes('ALREADY_EXTENDED_24H'),true);
  assert.equal(x.eligible,false);
});
