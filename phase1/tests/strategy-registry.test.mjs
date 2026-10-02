import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGY_REGISTRY, getStrategyDefinition, listActiveStrategies, normalizeStrategyResult } from '../strategy-registry.mjs';

test('registry contains all eleven implemented strategies as ACTIVE',()=>{
  assert.deepEqual(listActiveStrategies().map(x=>x.id).sort(),['ADX_TREND_STRENGTH','ATR_EXPANSION','BOLLINGER_BAND_REVERSION','CONFIRMED_BREAKOUT','EMA_RIBBON_ALIGNMENT','MACD_TREND_CONTINUATION','MEAN_REVERSION','MTF_TREND','RELATIVE_VOLUME_SURGE','VCP_PRE_BREAKOUT','VWAP_REVERSION']);
  assert.equal(Object.keys(STRATEGY_REGISTRY).length,11); for (const s of listActiveStrategies()) assert.equal(s.status,'ACTIVE');
});
test('every active strategy has evaluator',()=>{ for (const s of listActiveStrategies()) assert.equal(typeof s.evaluator,'function'); });
test('every active strategy has requiredData',()=>{ for (const s of listActiveStrategies()) assert.ok(s.requiredData.length>0); });
test('every active strategy has hardGates',()=>{ for (const s of listActiveStrategies()) assert.ok(s.hardGates.length>0); });
test('every active strategy has reasonCodes',()=>{ for (const s of listActiveStrategies()) assert.ok(s.reasonCodes.length>0); });
test('every active strategy has invalidationRules',()=>{ for (const s of listActiveStrategies()) assert.ok(s.invalidationRules.length>0); });
test('normalize LONG result to common contract',()=>{
  const o=normalizeStrategyResult('MTF_TREND',{direction:'LONG',state:'CANDIDATE',score:{trendScore:82},evidence:{alignment:90},reasonCodes:['1H_ALIGNED']},{coverage:1,hardGatesPassed:true,dataQuality:96});
  assert.equal(o.direction,'LONG'); assert.equal(o.signal_state,'CANDIDATE'); assert.equal(o.score.value,82); assert.equal(o.score.coverage,1); assert.equal(o.score.decision_band,'strong'); assert.equal(o.confidence_score,'UNKNOWN');
});
test('normalize BEARISH result to common contract',()=>{
  const o=normalizeStrategyResult('CONFIRMED_BREAKOUT',{direction:'BEARISH',state:'CONFIRMED',score:{breakoutScore:74},evidence:{volume:88},reasonCodes:['CLOSE_BELOW_RANGE']},{coverage:1,hardGatesPassed:true,dataQuality:91});
  assert.equal(o.direction,'BEARISH'); assert.equal(o.signal_state,'CONFIRMED'); assert.equal(o.score.value,74); assert.equal(o.score.decision_band,'positive');
});
test('normalize REJECTED result without manufacturing a score',()=>{
  const o=normalizeStrategyResult('MEAN_REVERSION',{direction:'NONE',state:'REJECTED',score:{},evidence:{},reasonCodes:['MEAN_REVERSION_FILTER_NOT_MET']},{coverage:1,hardGatesPassed:true,dataQuality:100});
  assert.equal(o.direction,'NONE'); assert.equal(o.signal_state,'REJECTED'); assert.equal(o.score.value,null); assert.equal(o.score.decision_band,'insufficient');
});
test('normalize INSUFFICIENT_DATA result and block score on failed coverage',()=>{
  const o=normalizeStrategyResult('MTF_TREND',{direction:'NONE',state:'INSUFFICIENT_DATA',score:{trendScore:99},evidence:{},reasonCodes:['INSUFFICIENT_CLOSED_DATA']},{coverage:{required:['4h','1h','15m'],available:['4h','1h'],ratio:2/3},hardGatesPassed:false,dataQuality:40});
  assert.equal(o.signal_state,'INSUFFICIENT_DATA'); assert.equal(o.score.value,null); assert.equal(o.score.decision_band,'insufficient'); assert.equal(o.score.coverage,2/3);
});
test('failed hard gate suppresses score even with a high evaluator score',()=>{
  const o=normalizeStrategyResult('CONFIRMED_BREAKOUT',{direction:'LONG',state:'CONFIRMED',score:{breakoutScore:99},evidence:{},reasonCodes:['LIQUIDITY_GATE_FAILED']},{coverage:1,hardGatesPassed:false,dataQuality:100});
  assert.equal(o.score.value,null); assert.equal(o.signal_state,'INSUFFICIENT_DATA');
});
test('unimplemented strategy cannot be marked ACTIVE or normalized',()=>{
  assert.throws(()=>getStrategyDefinition('FUTURE_STRATEGY'),/STRATEGY_NOT_ACTIVE/); assert.equal(listActiveStrategies().some(x=>x.id==='FUTURE_STRATEGY'),false);
});

test('common contract preserves paper-only invariants',()=>{
  const o=normalizeStrategyResult('MTF_TREND',{direction:'LONG',state:'CANDIDATE',score:{trendScore:70},evidence:{},reasonCodes:['TREND_OK']},{coverage:1,hardGatesPassed:true,dataQuality:88});
  assert.equal(o.paper_trading,true); assert.equal(o.real_order_execution,false); assert.equal(o.confidence_score,'UNKNOWN');
});
