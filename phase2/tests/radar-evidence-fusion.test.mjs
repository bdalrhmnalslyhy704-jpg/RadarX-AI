import test from 'node:test';
import assert from 'node:assert/strict';
import {RadarEvidenceFusion,canonicalRadarId} from '../core/radar-evidence-fusion.mjs';
const NOW=1_800_000_000_000;
function alert(radar,overrides={}){return {symbol:'EARLYUSDT',radar,score:82,direction:'UP',price_change_24h:2.1,data_quality:94,liquidity_quality:88,detected_at:NOW-1000,data_status:{data_valid:true,stale:false,future_data_detected:false},closed_candles_only:true,...overrides};}
test('aliases are one radar identity; duplicate ticks cannot create fake quorum',()=>{
 const f=new RadarEvidenceFusion({clock:()=>NOW});const first=f.observe(alert('RADAR8'),{now:NOW});
 const repeated=f.observe(alert('EARLY_EXPANSION_RADAR',{score:84,detected_at:NOW}),{now:NOW});
 assert.equal(canonicalRadarId('RADAR8'),'EARLY_EXPANSION_RADAR');assert.equal(first.distinct_radars,1);assert.equal(repeated.distinct_radars,1);
 assert.deepEqual(repeated.qualified_radars,['EARLY_EXPANSION_RADAR']);
});
test('independent radars build review priority; three-way bullish confluence remains review-only',()=>{
 const f=new RadarEvidenceFusion({clock:()=>NOW});f.observe(alert('RADAR8'),{now:NOW});
 const two=f.observe(alert('RADAR10_COIN_HUNTER',{detected_at:NOW}),{now:NOW});
 assert.equal(two.distinct_radars,2);assert.equal(two.classification,'CROSS_RADAR_REVIEW');
 const three=f.observe(alert('FALCON_EYE_RADAR',{detected_at:NOW}),{now:NOW});
 assert.equal(three.distinct_radars,3);assert.equal(three.classification,'CROSS_RADAR_PREMOVE_CONFLUENCE');
 assert.equal(three.notification_eligible,false);assert.equal(three.entry_eligible,false);assert.equal(three.qualified_radars.length,3);
});
test('missing/stale data and inadequate liquidity do not count as evidence',()=>{
 const f=new RadarEvidenceFusion({clock:()=>NOW});
 assert.equal(f.observe(alert('RADAR8',{data_quality:null}),{now:NOW}).distinct_radars,0);
 assert.equal(f.observe(alert('RADAR10',{data_status:{data_valid:false,stale:true}}),{now:NOW}).distinct_radars,0);
 assert.equal(f.observe(alert('RADAR11',{liquidity_quality:40}),{now:NOW}).distinct_radars,0);
});
test('opposed directional evidence is conflict, not confluence',()=>{
 const f=new RadarEvidenceFusion({clock:()=>NOW});f.observe(alert('RADAR8'),{now:NOW});
 const result=f.observe(alert('RADAR10',{direction:'DOWN',detected_at:NOW}),{now:NOW});
 assert.equal(result.distinct_radars,2);assert.equal(result.classification,'MIXED_DIRECTION_REQUIRES_REVIEW');assert.equal(result.notification_eligible,false);
});
test('expired evidence is pruned',()=>{
 let now=NOW;const f=new RadarEvidenceFusion({clock:()=>now,ttlMs:60_000});f.observe(alert('RADAR8'),{now});
 now+=61_000;const result=f.get('EARLYUSDT',{now});assert.equal(result.distinct_radars,0);assert.equal(result.classification,'NO_QUALIFIED_EVIDENCE');
});
