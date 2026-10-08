import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSupremeFusion,rankSupremeCandidates,buildSupremeMarketState} from '../core/supreme-fusion.mjs';

const agents=ids=>ids.map((id,i)=>({id,score:78+i%5,data_points:{market:3,news:1,official:1}}));
const baseCandidate={
  symbol:'TESTUSDT',direction:'BUY_BIAS',price_change_24h:1.2,data_quality:92,liquidity_quality:88,
  pre_move_context:{score:88,compression_score:82},
  fast_impulse_context:{score:74,scores:{momentum:78,volume:76,taker_buy:72,breakout:74}},
  surge_fingerprint:{early_score:90,ignition_score:78,participation_score:76,near_high_score:70}
};
const verdict=ids=>({agents:agents(ids),decision:{direction:'BUY_BIAS',score:80},learning:{weights:{HISTORY_LEARNER:1.04}}});

test('Supreme Fusion rewards an early multi-family setup',()=>{
  const ids=['MTF_STRUCTURE','TREND_ALIGNMENT','SUPPORT_RESISTANCE','MOMENTUM_ENGINE','MACD_TREND_CONTINUATION','BREAKOUT_VALIDATOR','RVOL_ACCELERATION','ORDER_FLOW_PRESSURE','LIQUIDITY_QUALITY','VOLATILITY_SQUEEZE','ATR_EXPANSION','RELATIVE_STRENGTH','MARKET_REGIME','TRAP_DETECTOR','RISK_GEOMETRY','HISTORY_LEARNER'];
  const out=evaluateSupremeFusion({candidate:baseCandidate,verdict:verdict(ids)});
  assert.ok(out.score>=70);
  assert.ok(out.early_edge_score>=70);
  assert.ok(out.anti_chase_score>=80);
  assert.ok(out.cluster_hits>=4);
  assert.notEqual(out.policy.confidence_score,'HIGH');
});

test('Supreme Fusion blocks a late extended chase',()=>{
  const c={...baseCandidate,price_change_24h:14,pre_move_context:{score:65,compression_score:40},surge_fingerprint:{...baseCandidate.surge_fingerprint,early_score:55,ignition_score:92,near_high_score:98}};
  const ids=['MTF_STRUCTURE','TREND_ALIGNMENT','SUPPORT_RESISTANCE','MOMENTUM_ENGINE','BREAKOUT_VALIDATOR','RVOL_ACCELERATION','ORDER_FLOW_PRESSURE','LIQUIDITY_QUALITY','VOLATILITY_SQUEEZE','RELATIVE_STRENGTH','MARKET_REGIME','TRAP_DETECTOR','RISK_GEOMETRY'];
  const out=evaluateSupremeFusion({candidate:c,verdict:verdict(ids)});
  assert.ok(out.anti_chase_score<60);
  assert.ok(['LATE_CHASE','REJECT'].includes(out.stage) || out.action==='WAIT_CONFIRMATION' || !out.eligible);
});

test('ranking prefers fusion score and market state is compact',()=>{
  const a={symbol:'AUSDT',price_change_24h:1,supreme_fusion:{score:91,early_edge_score:84,eligible:true,tier:'S',stage:'PRE_MOVE',action:'PAPER_ENTRY_CANDIDATE',failure_risk:20,anti_chase_score:90}};
  const b={symbol:'BUSDT',price_change_24h:0,supreme_fusion:{score:82,early_edge_score:88,eligible:false,tier:'WATCH_STRONG',stage:'WATCH',action:'PAPER_WATCH',failure_risk:35,anti_chase_score:95}};
  const ranked=rankSupremeCandidates([b,a],{limit:2});
  assert.equal(ranked[0].symbol,'AUSDT');
  const state=buildSupremeMarketState(ranked,{limit:2});
  assert.equal(state.engine,'RADARX_SUPREME_FUSION_V1');
  assert.equal(state.eligible_count,1);
});
