import test from 'node:test';
import assert from 'node:assert/strict';
import {RADAR_NAMES,RADAR_PROFILES,radarPowerScore,decorateRadarAlert} from '../core/radar-alert-meta.mjs';

test('TEST_RADAR_SUITE: four named radars are distinct and independently profiled',()=>{
  const ids=['EARLY_MOVE_RADAR','STRONG_MOVE_RADAR','ROTATION_LAG_RADAR','LIQUIDITY_ABSORPTION_RADAR'];
  const names=ids.map(id=>RADAR_NAMES[id]);
  assert.deepEqual(names,['Radar 1 — المدمر','Radar 2 — ملك الظلام','Radar 3 — الجوكر','Radar 4 — الكاسح']);
  assert.equal(new Set(ids.map(id=>RADAR_PROFILES[id].color)).size,4);
  assert.ok(ids.every(id=>RADAR_PROFILES[id].mission&&RADAR_PROFILES[id].algorithms.length>=7));
});

test('TEST_RADAR_SUITE: second-layer power score gates by radar-specific strength threshold',()=>{
  const cases=[
    ['EARLY_MOVE_RADAR',72],['STRONG_MOVE_RADAR',76],
    ['ROTATION_LAG_RADAR',78],['LIQUIDITY_ABSORPTION_RADAR',82]
  ];
  for(const [radar,threshold] of cases){
    const weak=radarPowerScore({radar,opportunity_score:threshold-8,risk_flags:[],data_quality:100});
    const strong=radarPowerScore({radar,opportunity_score:threshold,risk_flags:[],data_quality:100});
    assert.equal(weak.gate,false);
    assert.equal(strong.threshold,threshold);
    assert.equal(strong.gate,true);
  }
});

test('TEST_RADAR_SUITE: alert decoration preserves paper-only policy and adds power score',()=>{
  const alert=decorateRadarAlert({radar:'STRONG_MOVE_RADAR',symbol:'SANDUSDT',opportunity_score:83,risk_flags:[]},null);
  assert.equal(alert.radar_name,'Radar 2 — ملك الظلام');
  assert.ok(Number.isFinite(alert.radar_power_score));
  assert.equal(alert.radar_v2.gate,true);
  assert.equal(alert.paper_trading,true);
  assert.equal(alert.real_order_execution,false);
  assert.equal(alert.confidence_score,'UNKNOWN');
});


test('TEST_RADAR_SUITE: all seven radar profiles are named and Kahir power scoring uses its analysis block',()=>{
  const ids=['EARLY_MOVE_RADAR','STRONG_MOVE_RADAR','ROTATION_LAG_RADAR','LIQUIDITY_ABSORPTION_RADAR','KAHIR_RADAR','DOOMSDAY_RADAR','PROFESSOR_RADAR'];
  assert.deepEqual(ids.map(id=>RADAR_NAMES[id]),[
    'Radar 1 — المدمر','Radar 2 — ملك الظلام','Radar 3 — الجوكر','Radar 4 — الكاسح',
    'Radar 5 — القاهر','Radar 6 — يوم القيامة','Radar 7 — البروفيسور'
  ]);
  assert.ok(ids.every(id=>RADAR_PROFILES[id]?.mission));
  const kahir=radarPowerScore({radar:'KAHIR_RADAR',opportunity_score:84,kahir_analysis:{score:96},risk_flags:[],data_quality:100});
  assert.equal(kahir.component_mean,96);
  assert.equal(kahir.gate,true);
  const professor=radarPowerScore({radar:'PROFESSOR_RADAR',opportunity_score:80,professor_opinion:{technical_score:86,stream_score:80,news_score:78},risk_flags:[],data_quality:100});
  assert.equal(professor.component_mean,81.3);
  assert.equal(professor.gate,true);
});
