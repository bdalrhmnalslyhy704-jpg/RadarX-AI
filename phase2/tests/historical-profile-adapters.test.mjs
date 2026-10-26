import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateHistoricalProfileAdapter,HISTORICAL_PROFILE_ADAPTERS,assessHistoricalPreMoveWatchProxy} from '../core/historical-profile-adapters.mjs';

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

test('historical pre-move proxy records strong buyer flow before positive price confirmation without claiming an entry',()=>{
  const now=Date.parse('2026-10-25T12:00:00Z');
  const context={
    evidence_complete:true,closed_candles_only:true,already_moved:false,current_price:1.02,
    session_close:now-60_000,score:76,session_return_pct:-1,one_hour_return_pct:-0.7,
    volume_acceleration:3,trade_acceleration:2,taker_buy_ratio:0.65,
    taker_buy_acceleration:0.05,mean_close_location:0.56,
    relative_strength_vs_market_pct:null,relative_strength_vs_btc_pct:0.7,
    components:{structure:54,squeeze:62,buying_pressure:63}
  };
  const ticker={priceChange24h:1.1,quoteVolume24h:1_200_000,lastPrice:1.02,ticker_24h_coverage_complete:true};
  const result=assessHistoricalPreMoveWatchProxy(context,ticker,now);
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.tier,'EARLY_FLOW_MONITOR');
  assert.equal(result.proxy_only,true);
  assert.equal(result.entry_eligible,false);
  assert.equal(result.relative_strength_source,'BTC_PROXY');
  assert.ok(result.limitations.includes('HISTORICAL_LIQUIDITY_QUALITY_UNAVAILABLE'));
  assert.ok(result.limitations.includes('BTC_RELATIVE_STRENGTH_USED_AS_PROXY'));
});

test('historical watch proxy stays aligned with the lower live monitor corridor without claiming delivery',()=>{
  const now=Date.parse('2026-10-25T12:00:00Z');
  const context={
    evidence_complete:true,closed_candles_only:true,already_moved:false,current_price:1.02,
    session_close:now-60_000,score:69,session_return_pct:-0.6,one_hour_return_pct:-0.2,
    volume_acceleration:1.4,trade_acceleration:1.1,taker_buy_ratio:0.54,
    taker_buy_acceleration:0.03,mean_close_location:0.56,
    relative_strength_vs_market_pct:null,relative_strength_vs_btc_pct:0.3,
    components:{structure:52,squeeze:44,buying_pressure:61}
  };
  const ticker={priceChange24h:1.1,quoteVolume24h:1_200_000,lastPrice:1.02,ticker_24h_coverage_complete:true};
  const result=assessHistoricalPreMoveWatchProxy(context,ticker,now);
  assert.equal(result.eligible,true,JSON.stringify(result));
  assert.equal(result.tier,'EARLY_FLOW_MONITOR');
  assert.equal(result.proxy_only,true);
  assert.equal(result.entry_eligible,false);
  assert.ok(result.limitations.includes('HISTORICAL_ORDERBOOK_UNAVAILABLE'));
  assert.ok(result.limitations.includes('LIVE_PUSH_GATE_NOT_SIMULATED'));
});

test('historical pre-move proxy fails closed on missing evidence, stale candles, low volume, and extended price',()=>{
  const now=Date.parse('2026-10-25T12:00:00Z');
  const context={
    evidence_complete:true,closed_candles_only:true,already_moved:false,current_price:1.02,
    session_close:now-60_000,score:76,session_return_pct:-1,one_hour_return_pct:-0.7,
    volume_acceleration:3,trade_acceleration:2,taker_buy_ratio:0.65,
    taker_buy_acceleration:0.05,mean_close_location:0.56,
    relative_strength_vs_btc_pct:0.7,components:{structure:54}
  };
  const ticker={priceChange24h:1.1,quoteVolume24h:1_200_000,lastPrice:1.02};
  assert.equal(assessHistoricalPreMoveWatchProxy({...context,evidence_complete:false},ticker,now).eligible,false);
  assert.equal(assessHistoricalPreMoveWatchProxy({...context,session_close:now-21*60_000},ticker,now).eligible,false);
  assert.equal(assessHistoricalPreMoveWatchProxy(context,{...ticker,quoteVolume24h:749_999},now).eligible,false);
  assert.equal(assessHistoricalPreMoveWatchProxy(context,{...ticker,priceChange24h:12},now).eligible,false);
});

test('historical adapters never invent a numeric data-quality score when it was not measured',()=>{
  const input=fixture();
  const early=evaluateHistoricalProfileAdapter('EARLY_MOVE_RADAR',input);
  const hunter=evaluateHistoricalProfileAdapter('COIN_HUNTER_RADAR',input);
  assert.equal(early.analysis.data_quality,undefined);
  assert.equal(hunter.analysis.data_quality,undefined);
  assert.ok(early.extraGateFailures.includes('HISTORICAL_MARKET_MEDIAN_UNAVAILABLE'));
  const measured=evaluateHistoricalProfileAdapter('EARLY_MOVE_RADAR',{
    ...input,marketMedianReturnPct:1.25,marketMedianSampleCount:8,
    marketMedianSource:'HISTORICAL_REQUESTED_SPOT_COHORT_MEDIAN'
  });
  assert.ok(!measured.extraGateFailures.includes('HISTORICAL_MARKET_MEDIAN_UNAVAILABLE'));
  assert.equal(measured.analysis.market_median_source,'HISTORICAL_REQUESTED_SPOT_COHORT_MEDIAN');
  assert.equal(measured.analysis.market_median_sample_count,8);
});

test('Whale adapter cannot form a candidate when aggregate-trade history is incomplete',()=>{
  const input=fixture();
  input.dataPolicy={tradeCoverageComplete:false};
  const result=evaluateHistoricalProfileAdapter('WHALE_ACCUMULATION_RADAR',input);
  assert.equal(result.eligible,false);
  assert.ok(result.reasonCodes.includes('TRADE_AND_CANDLE_PROXY_ORDERBOOK_UNAVAILABLE')===false);
  assert.ok(result.extraGateFailures.includes('HISTORICAL_ORDERBOOK_UNAVAILABLE'));
});
