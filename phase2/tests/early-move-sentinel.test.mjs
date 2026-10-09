import assert from 'node:assert/strict';
import {buildMoveAlert,buildEarlyWakeAlert,buildPreExplosionAlert,rankPreExplosionTickerRows,EarlyMoveSentinel} from '../core/early-move-sentinel.mjs';
import {buildFastImpulseContext} from '../market/universe-scanner.mjs';

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


const wakeCandidate={
  ...earlyCandidate,
  price_change_24h:0.55,
  data_quality:88,
  liquidity_quality:86,
  pre_move_context:{
    ...earlyCandidate.pre_move_context,
    score:72,
    session_return_pct:0.7,
    already_moved:false,
    resistance_distance_pct:1.8,
    components:{
      ...earlyCandidate.pre_move_context.components,
      relative_strength:72,
      resistance_proximity:90
    }
  },
  fast_impulse_context:{
    score:82,
    scores:{momentum:84,volume:86,taker_buy:82,breakout:78,ema:80,range_expansion:76,body:74},
    acceleration_pct:0.55
  },
  bottom_context:{
    ...earlyCandidate.bottom_context,
    metrics:{
      ...earlyCandidate.bottom_context.metrics,
      momentum:74,
      structure:67,
      buying_pressure:70,
      compression:72,
      orderbook_imbalance:70,
      mtf_alignment:62
    },
    algorithms:{
      ...earlyCandidate.bottom_context.algorithms,
      volume_price_divergence:{score:76,rvol_ratio:1.4},
      momentum_awaken:{score:74,atr_ratio:1.08},
      taker_flow:{buy_ratio:0.545,previous_buy_ratio:0.518,score:78},
      orderbook_pressure:{score:70,imbalance:0.11},
      ema20_50_reclaim:{score:72},
      rsi14:{score:84,value:46,bullish_divergence:true},
      obv_accumulation:{score:67},
      wyckoff_spring:{score:62}
    }
  },
  strategies:[]
};
const wake=buildEarlyWakeAlert(wakeCandidate,{movePct:0.55,previousMovePct:0.30,deltaPct:0.25},{now:1710000010000});
assert.equal(wake.event,'EARLY_WAKE_ALERT');
assert.equal(wake.direction,'UP_MOVE');
assert.equal(wake.eligible,true);
assert.ok(wake.early_wake.leader_count>=3);
assert.ok(wake.opportunity_score>=68);

const tooLate=buildEarlyWakeAlert({...wakeCandidate,price_change_24h:1.2},{
  movePct:1.2,previousMovePct:0.8,deltaPct:0.4
},{now:1710000011000});
assert.equal(tooLate.eligible,false);
assert.equal(tooLate.early_wake.already_moved,true);


const fastCandles=[];
for(let i=0;i<60;i++){
  const accelerating=i>=54;
  const open=100+i*0.03;
  const close=accelerating?open*(1+0.006*(i-53)):open;
  const high=accelerating?close*1.004:open*1.001;
  const low=accelerating?open*0.998:open*0.999;
  const volume=accelerating?500000:100000;
  const takerBuyBaseVolume=accelerating?340000:51000;
  fastCandles.push({
    openTime:i*300000,
    closeTime:(i+1)*300000,
    open,high,low,close,volume,takerBuyBaseVolume,
    closed:true
  });
}
const fastContext=buildFastImpulseContext(fastCandles,{lastPrice:fastCandles.at(-1).close},20*60*60*1000);
assert.equal(fastContext.available,true);
assert.equal(fastContext.closed_candles_only,true);
assert.ok(fastContext.score>=68);
assert.ok(['EARLY_IMPULSE','IMPULSE_START'].includes(fastContext.stage));
assert.ok(fastContext.leaders.includes('FAST_VOLUME_AWAKENING'));
assert.ok(fastContext.leaders.includes('FAST_TAKER_BUY_PRESSURE'));
assert.ok(fastContext.scores.momentum>=62);

const openLast=[...fastCandles];
openLast[openLast.length-1]={...openLast[openLast.length-1],closed:false};
const closedOnlyContext=buildFastImpulseContext(openLast,{lastPrice:openLast.at(-1).close},20*60*60*1000);
assert.equal(closedOnlyContext.closed_candles_only,true);
assert.equal(closedOnlyContext.last_closed_time,openLast.at(-2).closeTime);


test('Pre-explosion patrol rotates beyond the highest-ranked symbols without duplicate queue entries',()=>{
  let now=1710001000000;
  const symbols=Array.from({length:12},(_,i)=>`P${String(i).padStart(2,'0')}USDT`);
  const sentinel=new EarlyMoveSentinel({
    rest:{},store:{},
    config:{maxEarlyDiscovery:4,minQuoteVolume24h:100000,earlyMax24hMovePct:1.25,earlyMin24hMovePct:-8,earlyScanCooldownMs:120000,maxDeepPerCycle:2},
    clock:()=>now,
    logger:{warn(){}},
    tickerWsFactory:()=>({start(){},stop(){},health(){return{state:'STOPPED'}}})
  });
  sentinel.running=true;
  sentinel.spotSymbols=new Set(symbols);
  sentinel.drainDeepQueue=async()=>{};
  const rows=symbols.map((symbol,i)=>({
    symbol,lastPrice:1+i*0.01,quoteVolume:2_000_000-i*30_000,count:10000+i*100,
    priceChangePercent:0.1+i*0.05,highPrice:1.2+i*0.01,lowPrice:0.8+i*0.01
  }));
  const covered=new Set();
  for(let cycle=0;cycle<3;cycle++){
    sentinel.queuePreExplosionDiscovery(rows);
    const queued=sentinel.deepQueue.splice(0);
    assert.equal(queued.length,4);
    assert.equal(new Set(queued.map(x=>x.symbol)).size,4);
    for(const job of queued)covered.add(job.symbol);
    now+=120001;
  }
  assert.ok(covered.size>=8,`expected three patrol cycles to cover at least 8 symbols; got ${covered.size}`);
  assert.ok(sentinel.preExplosionRotationTotal>0);
});

test('failed pre-explosion scan releases its cooldown so it can be retried',async()=>{
  const now=1710002000000;
  const sentinel=new EarlyMoveSentinel({
    rest:{},store:{},config:{maxDeepPerCycle:1,earlyScanCooldownMs:120000},
    clock:()=>now,logger:{warn(){}}
  });
  sentinel.running=true;
  sentinel.scanner={scanSymbol:async()=>{throw new Error('TRANSIENT_FIXTURE_FAILURE');}};
  sentinel.lastEarlyScanAt.set('RETRYUSDT',now);
  sentinel.deepQueue.push({symbol:'RETRYUSDT',row:{symbol:'RETRYUSDT'},trigger:{},queuedAt:now,mode:'PRE_EXPLOSION'});
  await sentinel.drainDeepQueue();
  assert.equal(sentinel.lastEarlyScanAt.has('RETRYUSDT'),false);
  assert.match(sentinel.lastError,/TRANSIENT_FIXTURE_FAILURE/);
});
