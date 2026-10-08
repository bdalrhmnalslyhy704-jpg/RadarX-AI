import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMoveForensics} from '../core/move-forensics.mjs';

test('mover forensics detects an OGN-like ignition fingerprint',()=>{
  const alert={
    radar:'EARLY_EXPANSION_RADAR',
    price_change_24h:2.4,
    data_quality:94,
    liquidity_quality:82,
    opportunity_score:86,
    components:{
      volume_ratio:6.2,
      trade_ratio:3.8,
      taker_buy_ratio:.575,
      breakout:91,
      compression:87,
      relative_strength:84,
      momentum_score:88
    },
    market_cap:28500000,
    quote_volume_24h:128000000,
    market_rotation_pct:6.5,
    news_items:[{title:'OGN buyback and staking update'}]
  };
  const f=buildMoveForensics(alert,Date.now());
  assert.equal(f.hard_fail,false);
  assert.ok(f.ignition_score>=80);
  assert.ok(f.price_elasticity_score>=60);
  assert.ok(f.signatures.includes('LIQUIDITY_VOLUME_IGNITION'));
  assert.ok(f.signatures.includes('TRADE_PARTICIPATION_BURST'));
  assert.ok(f.signatures.includes('COMPRESSION_TO_BREAKOUT'));
  assert.ok(f.signatures.includes('RELATIVE_STRENGTH_ROTATION'));
  assert.ok(f.catalyst_keyword_hits.includes('BUYBACK'));
  assert.ok(f.catalyst_keyword_hits.includes('STAKING'));
});

test('post-move forensic replay explains factors but remains non-notifiable',()=>{
  const alert={
    radar:'EARLY_EXPANSION_RADAR',
    price_change_24h:88,
    data_quality:94,
    liquidity_quality:82,
    opportunity_score:96,
    components:{volume_ratio:8,trade_ratio:5,taker_buy_ratio:.58,breakout:96,compression:90,relative_strength:92,momentum_score:96},
    market_cap:28500000,
    quote_volume_24h:128000000
  };
  const f=buildMoveForensics(alert,Date.now());
  assert.equal(f.hard_fail,false);
  assert.equal(f.decision,'HIGH_IMPULSE_QUALITY');
  assert.ok(f.signatures.length>=4);
});
