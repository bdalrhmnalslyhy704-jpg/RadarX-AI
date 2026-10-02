import assert from 'node:assert/strict';
import {buildMoveAlert,EarlyMoveSentinel} from '../core/early-move-sentinel.mjs';

const candidate={
  symbol:'TESTUSDT',
  last_price:1.01,
  price_change_24h:1.2,
  liquidity_quality:86,
  data_quality:94,
  data_status:{data_valid:true,data_stale:false},
  pre_move_context:{score:82,session_return_pct:2.1,resistance_distance_pct:6},
  bottom_context:{
    metrics:{
      composite_algorithm_score:84,
      structure:86,
      buying_pressure:81,
      selling_exhaustion:77,
      compression:80,
      whale_pressure:76
    },
    algorithms:{
      volume_price_divergence:{score:84},
      momentum_awaken:{score:82,atr_ratio:1.2}
    }
  },
  strategies:[
    {id:'VCP_PRE_BREAKOUT',accepted:true,score:{value:84}},
    {id:'RELATIVE_VOLUME_SURGE',accepted:true,score:{value:79}},
    {id:'MTF_TREND',accepted:false,score:{value:61}}
  ],
  accepted_strategies:['VCP_PRE_BREAKOUT','RELATIVE_VOLUME_SURGE']
};

const alert=buildMoveAlert(candidate,{movePct:1.2,previousMovePct:.7},{now:1710000000000});
assert.equal(alert.event,'EARLY_MOVE_ALERT');
assert.equal(alert.direction,'UP_MOVE');
assert.ok(alert.opportunity_score>=70);
assert.equal(alert.strategy_confluence.accepted_count,2);
assert.equal(alert.paper_trading,true);
assert.equal(alert.real_order_execution,false);
assert.equal(alert.confidence_score,'UNKNOWN');
assert.ok(alert.reasons.length>0);

const sentinel=new EarlyMoveSentinel({
  rest:{},
  store:{},
  config:{thresholdPct:1},
  tickerWsFactory:()=>({start(){},stop(){},health(){return{state:'STOPPED'}}})
});
sentinel.running=true;
sentinel.spotSymbols=new Set(['TESTUSDT']);
let queued=null;
sentinel.queueDeep=(symbol,row,trigger)=>{queued={symbol,row,trigger};};
sentinel.processTicker({symbol:'TESTUSDT',lastPrice:1,priceChange24h:.8},false);
assert.equal(queued,null);
sentinel.processTicker({symbol:'TESTUSDT',lastPrice:1.01,priceChange24h:1.01},false);
assert.equal(queued.symbol,'TESTUSDT');
assert.equal(queued.trigger.movePct,1.01);
assert.equal(queued.trigger.previousMovePct,.8);

console.log('Early Move Sentinel tests passed');
