import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSupremeFusion,rankSupremeCandidates} from './app/src/main/assets/radarx-supreme-fusion.mjs';

const ids=[
  'MARKET_REGIME','MTF_ALIGNMENT','MARKET_STRUCTURE','BOTTOM_TURN','MOMENTUM',
  'VOLUME_CONFIRMATION','VOLATILITY_COMPRESSION','PRE_BREAKOUT','SUPPORT_RESISTANCE',
  'RELATIVE_STRENGTH','ORDERBOOK_PRESSURE','LIQUIDITY_QUALITY','LARGE_PLAYER_PROXY',
  'ABSORPTION','RISK_TRAPS','EXTENSION','STRATEGY_CONSENSUS','MARKET_BREADTH','DATA_INTEGRITY'
];
const analysts=ids.map((id,i)=>({id,score:79+(i%4),direction:'LONG',decision:'PASS',evidence:{closed_candles:1}}));
const candidate={
  symbol:'TESTUSDT',direction:'LONG',price_change_24h:1.2,data_quality:94,liquidity_quality:91,
  risk_flags:[],pre_move_context:{score:92,compression_score:86},
  pre_breakout_fingerprint:{trapRisk:10},
  fast_impulse_context:{score:83,scores:{momentum:83,volume:82,taker_buy:81,breakout:84}},
  surge_fingerprint:{early_score:92,ignition_score:83,participation_score:82,near_high_score:70}
};
const verdict={agents:analysts,decision:{direction:'LONG',score:84}};

test('Supreme Fusion identifies an early multi-family paper candidate',()=>{
  const out=evaluateSupremeFusion({candidate,verdict});
  assert.ok(out.score>=84,JSON.stringify(out));
  assert.ok(out.early_edge_score>=70);
  assert.ok(out.cluster_hits>=4);
  assert.equal(out.policy.real_order_execution,false);
  assert.equal(out.policy.confidence_score,'UNKNOWN');
  assert.equal(out.eligible,true,JSON.stringify(out));
});

test('invalid or stale data cannot become an eligible fusion candidate',()=>{
  const out=evaluateSupremeFusion({candidate:{...candidate,data_quality:0},verdict});
  assert.equal(out.eligible,false);
  assert.equal(out.action,'SPOT_AVOID');
});

test('late extended move is not promoted as an early setup',()=>{
  const late={...candidate,price_change_24h:14,pre_breakout_fingerprint:{trapRisk:60},pre_move_context:{score:55,compression_score:35},surge_fingerprint:{early_score:55,ignition_score:95,participation_score:80,near_high_score:98}};
  const out=evaluateSupremeFusion({candidate:late,verdict});
  assert.equal(out.eligible,false);
  assert.ok(['LATE_CHASE','REJECT'].includes(out.stage)||out.action==='WAIT_CONFIRMATION');
});

test('ranking orders candidates by Supreme Fusion score',()=>{
  const rows=rankSupremeCandidates([
    {symbol:'LOWUSDT',supreme_fusion:{score:60,early_edge_score:70}},
    {symbol:'HIGHUSDT',supreme_fusion:{score:88,early_edge_score:82}}
  ]);
  assert.equal(rows[0].symbol,'HIGHUSDT');
});
