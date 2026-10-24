import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateHistoricalProfileAdapter,HISTORICAL_PROFILE_ADAPTERS} from '../core/historical-profile-adapters.mjs';

const MINUTE=60_000;
function candles(interval,count,now=Date.now(),seed=10){
  const lastOpen=Math.floor(now/interval)*interval-interval;
  const rows=[];
  let price=seed;
  for(let i=0;i<count;i++){
    const openTime=lastOpen-(count-1-i)*interval;
    const open=price;
    const drift=i%9===0?0.0005:0.00008;
    const close=open*(1+drift);
    const volume=100_000+i*350;
    rows.push({
      openTime,closeTime:openTime+interval-1,open,high:Math.max(open,close)*1.002,
      low:Math.min(open,close)*0.998,close,volume,quoteVolume:volume*close,
      tradeCount:80+(i%20),takerBuyBaseVolume:volume*0.61,
      takerBuyQuoteVolume:volume*close*0.61,closed:true
    });
    price=close;
  }
  return rows;
}
function fixture(){
  const now=Date.now();
  const oneMinute=candles(MINUTE,120,now,10);
  const fiveMinute=candles(5*MINUTE,60,now,10);
  const fifteen=candles(15*MINUTE,240,now,10);
  const hourly=candles(60*MINUTE,50,now,10);
  const btcOne=candles(MINUTE,120,now,60_000);
  const btcFive=candles(5*MINUTE,60,now,60_000);
  const btcFifteen=candles(15*MINUTE,240,now,60_000);
  const btcHourly=candles(60*MINUTE,30,now,60_000);
  const ticker={
    symbol:'ADAUSDT',lastPrice:oneMinute.at(-1).close,
    priceChange24h:1.2,quoteVolume24h:20_000_000,tradeCount24h:25_000,
    highPrice24h:oneMinute.at(-1).close*1.04,lowPrice24h:oneMinute.at(-1).close*.96,
    dataQuality:90
  };
  const aggTrades=Array.from({length:16},(_,i)=>({
    a:i+1,T:now-20_000+i*500,p:String(ticker.lastPrice),q:'100000',m:false
  }));
  return {
    now,oneMinute,fiveMinute,ticker,aggTrades,
    timeframes:{
      '15m':fifteen,'1h':hourly,'BTCUSDT:1m':btcOne,'BTCUSDT:5m':btcFive,
      'BTCUSDT:15m':btcFifteen,'BTCUSDT:1h':btcHourly
    },
    dataPolicy:{tradeCoverageComplete:true}
  };
}

test('the isolated historical-adapter registry covers the five partial-evidence radar families',()=>{
  assert.deepEqual(HISTORICAL_PROFILE_ADAPTERS,[
    'EARLY_MOVE_RADAR','LIQUIDITY_ABSORPTION_RADAR','FALCON_EYE_RADAR',
    'COIN_HUNTER_RADAR','WHALE_ACCUMULATION_RADAR'
  ]);
});

test('partial-evidence historical adapters return explicit limitations without claiming a push',()=>{
  const input=fixture();
  const expectations={
    EARLY_MOVE_RADAR:'HISTORICAL_ORDERBOOK_UNAVAILABLE',
    LIQUIDITY_ABSORPTION_RADAR:'HISTORICAL_ORDERBOOK_UNAVAILABLE',
    FALCON_EYE_RADAR:'HISTORICAL_FUTURES_SNAPSHOTS_UNAVAILABLE',
    COIN_HUNTER_RADAR:'HISTORICAL_LEADER_COHORT_UNAVAILABLE',
    WHALE_ACCUMULATION_RADAR:'HISTORICAL_ORDERBOOK_UNAVAILABLE'
  };
  for(const [profile,expected] of Object.entries(expectations)){
    const result=evaluateHistoricalProfileAdapter(profile,input);
    assert.ok(result,profile+' adapter must exist');
    assert.ok(result.analysis&&typeof result.analysis==='object',profile+' returns detector evidence');
    assert.equal(typeof result.eligible,'boolean',profile+' reports candidate state explicitly');
    assert.ok(result.extraGateFailures.includes(expected),profile+' exposes its unavailable evidence');
    assert.ok(result.extraGateFailures.includes('LIVE_PUSH_GATE_NOT_SIMULATED'),profile+' does not claim push delivery');
    assert.notEqual(result.analysis.real_order_execution,true,profile+' never enables live execution');
  }
});

test('Whale adapter cannot form a candidate when aggregate-trade history is incomplete',()=>{
  const input=fixture();
  input.dataPolicy={tradeCoverageComplete:false};
  const result=evaluateHistoricalProfileAdapter('WHALE_ACCUMULATION_RADAR',input);
  assert.equal(result.eligible,false);
  assert.ok(result.reasonCodes.includes('TRADE_AND_CANDLE_PROXY_ORDERBOOK_UNAVAILABLE')===false);
  assert.ok(result.extraGateFailures.includes('HISTORICAL_ORDERBOOK_UNAVAILABLE'));
});
