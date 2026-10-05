import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPreBreakoutFingerprint,isPreBreakoutNotificationEligible} from '../core/radar-prebreakout-engine.mjs';

function candidate(overrides={}){
  return {
    symbol:'TESTUSDT',
    priceChange24h:1.2,
    bottom:{
      metrics:{compression:82,structure:78,buying_pressure:76,orderbook_imbalance:74,momentum:75,mtf_alignment:72},
      algorithms:{
        squeeze:{score:82},
        price_structure:{score:78,higher_low:true,break_of_structure:false},
        taker_flow:{buy_ratio:.54},
        orderbook_pressure:{score:74,imbalance:.10},
        whale_pressure:{score:72},
        ema20_50_reclaim:{score:80},
        obv_accumulation:{score:74},
        volume_price_divergence:{score:76,rvol_ratio:1.35}
      }
    },
    preMove:{
      session_return_pct:2.1,
      price_acceleration_pct:.32,
      relative_strength_vs_market_pct:2.2,
      relative_strength_vs_btc_pct:2.8,
      taker_buy_acceleration:.028,
      components:{compression:82,structure:78,buying_pressure:76,whale_pressure:72,resistance_proximity:78,relative_strength:76}
    },
    fast:{
      score:81,
      acceleration_pct:.28,
      volume_ratio:1.42,
      taker_buy_ratio:.54,
      taker_buy_delta:.022,
      breakout_distance_pct:-.25,
      scores:{momentum:78,volume:79,taker_buy:82,breakout:84,ema:80,range_expansion:74,body:77}
    },
    strategies:[{accepted:true,score:{value:82}},{accepted:true,score:{value:76}},{accepted:false,score:{value:68}}],
    ...overrides
  };
}

test('pre-breakout fingerprint confirms aligned multi-factor setup',()=>{
  const fp=buildPreBreakoutFingerprint({ticker:candidate(),bottom:candidate().bottom,preMove:candidate().preMove,fast:candidate().fast,strategies:candidate().strategies,dataQuality:92,liquidity:84});
  assert.equal(fp.late,false);
  assert.equal(fp.micro_move,false);
  assert.ok(fp.confirmation_count>=6);
  assert.ok(fp.group_count>=4);
  assert.ok(fp.score>=78);
});

test('micro movement is rejected as noise',()=>{
  const c=candidate({
    priceChange24h:.15,
    preMove:{session_return_pct:.1,price_acceleration_pct:.01,relative_strength_vs_market_pct:.1,components:{compression:80,structure:50,buying_pressure:51,whale_pressure:50,resistance_proximity:70,relative_strength:50}},
    fast:{score:58,acceleration_pct:.01,volume_ratio:1.02,taker_buy_ratio:.501,taker_buy_delta:.001,breakout_distance_pct:-2,scores:{momentum:52,volume:52,taker_buy:51,breakout:45,ema:52,range_expansion:48,body:51}}
  });
  const fp=buildPreBreakoutFingerprint({ticker:c,bottom:c.bottom,preMove:c.preMove,fast:c.fast,strategies:c.strategies,dataQuality:95,liquidity:90});
  assert.equal(fp.micro_move,true);
  assert.equal(isPreBreakoutNotificationEligible(fp,{requireConfirmed:true}),false);
});

test('late move is rejected even when indicators look strong',()=>{
  const c=candidate({priceChange24h:14,preMove:{...candidate().preMove,session_return_pct:13,already_moved:true}});
  const fp=buildPreBreakoutFingerprint({ticker:c,bottom:c.bottom,preMove:c.preMove,fast:c.fast,strategies:c.strategies,dataQuality:96,liquidity:92});
  assert.equal(fp.late,true);
  assert.equal(fp.ready,false);
  assert.equal(isPreBreakoutNotificationEligible(fp,{requireConfirmed:false}),false);
});
