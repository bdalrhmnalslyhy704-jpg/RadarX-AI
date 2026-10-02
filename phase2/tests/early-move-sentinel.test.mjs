import assert from 'node:assert/strict';
import {buildMoveAlert,buildPreExplosionAlert,rankPreExplosionTickerRows,EarlyMoveSentinel} from '../core/early-move-sentinel.mjs';

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
assert.equal(alert.detected_at,1710000000000);
assert.equal(alert.processed_at,1710000000000);
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


const earlyCandidate={
  ...candidate,
  price_change_24h:0.4,
  liquidity_quality:88,
  data_quality:95,
  pre_move_context:{
    ...candidate.pre_move_context,
    score:86,
    session_return_pct:4.2,
    already_moved:false,
    resistance_distance_pct:4.5
  },
  bottom_context:{
    ...candidate.bottom_context,
    metrics:{
      ...candidate.bottom_context.metrics,
      momentum:82,
      structure:78,
      buying_pressure:80,
      compression:84,
      mtf_alignment:79
    },
    algorithms:{
      ...candidate.bottom_context.algorithms,
      volume_price_divergence:{score:84},
      momentum_awaken:{score:82,atr_ratio:1.18},
      mtf_alignment:{score:79},
      taker_flow:{buy_ratio:0.57}
    }
  },
  strategies:[
    {id:'VCP_PRE_BREAKOUT',accepted:true,score:{value:86}},
    {id:'RELATIVE_VOLUME_SURGE',accepted:true,score:{value:82}},
    {id:'MTF_TREND',accepted:true,score:{value:80}}
  ],
  accepted_strategies:['VCP_PRE_BREAKOUT','RELATIVE_VOLUME_SURGE','MTF_TREND']
};

const preAlert=buildPreExplosionAlert(earlyCandidate,{movePct:0.4,discoveryScore:91},{now:1710000001000});
assert.equal(preAlert.event,'PRE_EXPLOSION_ALERT');
assert.equal(preAlert.direction,'UP_MOVE');
assert.equal(preAlert.price_change_24h,0.4);
assert.ok(preAlert.pre_explosion.confirmation_count>=6);
assert.ok(preAlert.opportunity_score>=78);
assert.equal(preAlert.eligible,true);

const pumped={...earlyCandidate,price_change_24h:40,pre_move_context:{...earlyCandidate.pre_move_context,session_return_pct:25,already_moved:true}};
const pumpedAlert=buildPreExplosionAlert(pumped,{movePct:40,discoveryScore:10},{now:1710000002000});
assert.equal(pumpedAlert.eligible,false);
assert.equal(pumpedAlert.pre_explosion.already_moved,true);
assert.ok(pumpedAlert.risk_flags.includes('ALREADY_MOVED'));

const discovery=rankPreExplosionTickerRows([
  {symbol:'SANDUSDT',lastPrice:'1',quoteVolume:'3000000',count:'100000',priceChangePercent:'40',highPrice:'1',lowPrice:'1',closeTime:'1'},
  {symbol:'NIGHTUSDT',lastPrice:'1',quoteVolume:'3000000',count:'100000',priceChangePercent:'18',highPrice:'1',lowPrice:'1',closeTime:'1'},
  {symbol:'TESTUSDT',lastPrice:'1',quoteVolume:'3000000',count:'100000',priceChangePercent:'0.4',highPrice:'1',lowPrice:'1',closeTime:'1'},
  {symbol:'DIPUSDT',lastPrice:'1',quoteVolume:'3000000',count:'100000',priceChangePercent:'-3.2',highPrice:'1',lowPrice:'1',closeTime:'1'}
],[
 {symbol:'SANDUSDT'},{symbol:'NIGHTUSDT'},{symbol:'TESTUSDT'},{symbol:'DIPUSDT'}
],{limit:10});
assert.equal(discovery.some(x=>x.symbol==='SANDUSDT'),false);
assert.equal(discovery.some(x=>x.symbol==='NIGHTUSDT'),false);
assert.ok(discovery.some(x=>x.symbol==='TESTUSDT'));
assert.ok(discovery.some(x=>x.symbol==='DIPUSDT'));
