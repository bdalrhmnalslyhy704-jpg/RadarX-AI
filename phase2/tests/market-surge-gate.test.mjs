import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSurgeFingerprint,rankMeaningfulCandidates} from '../core/market-surge-gate.mjs';

const base={
  last_price:100,
  high_price_24h:101,
  price_change_24h:8,
  liquidity_quality:85,
  data_quality:100,
  overall_score:78,
  risk_flags:[],
  pre_move_context:{score:80},
  fast_impulse_context:{
    score:82,acceleration_pct:.45,
    scores:{momentum:84,volume:86,taker_buy:81,breakout:90,range_expansion:80,body:78}
  }
};

test('six-percent moves with confirmation become explosive candidates',()=>{
  const x=buildSurgeFingerprint(base);
  assert.equal(x.tier,'EXPLOSIVE_6P');
  assert.equal(x.meaningful,true);
  assert.ok(x.ignition_score>=70);
});

test('quiet pre-breakout setup can surface before six percent',()=>{
  const x=buildSurgeFingerprint({...base,price_change_24h:2.1,overall_score:72});
  assert.equal(x.tier,'EARLY_BREAKOUT');
  assert.ok(x.early_score>=70);
});

test('minor flat watch candidates do not dominate meaningful surface',()=>{
  const a={...base,symbol:'BIG',price_change_24h:9};
  const b={...base,symbol:'SMALL',price_change_24h:1,pre_move_context:{score:50},fast_impulse_context:{score:48,scores:{momentum:48,volume:48,taker_buy:48,breakout:48,range_expansion:48,body:48}}};
  const ranked=rankMeaningfulCandidates([b,a]);
  assert.equal(ranked[0].symbol,'BIG');
  assert.equal(ranked[1].surge_fingerprint.tier,'WATCH');
});
