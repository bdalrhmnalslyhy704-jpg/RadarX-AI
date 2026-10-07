import assert from 'node:assert/strict';
import test from 'node:test';
import {buildWhaleAccumulationAnalysis,buildWhaleAccumulationAlert} from '../core/whale-accumulation-radar.mjs';
import {evaluateRadarQuality} from '../core/radar-quality-v3.mjs';

function candle(i,p){
  const openTime=Date.now()-((140-i)*60*1000);
  const close=p*1.001;
  return {
    openTime,closeTime:openTime+59999,
    open:p,high:p*1.004,low:p*.998,close,volume:1000,
    quoteVolume:1000*p,tradeCount:120,takerBuyBaseVolume:540,takerBuyQuoteVolume:540*p,closed:true
  };
}
function agg(i,notional,buy){
  return {a:i,p:String(100),q:String(notional/100),T:Date.now()-((40-i)*4000),m:!buy,M:true};
}

test('whale analysis detects repeated large buy-side footprint with absorption',()=>{
  const candles=Array.from({length:80},(_,i)=>candle(i,100+i*.015));
  const aggTrades=[
    ...Array.from({length:8},(_,i)=>agg(i,60000,true)),
    ...Array.from({length:2},(_,i)=>agg(i+10,65000,false)),
    ...Array.from({length:8},(_,i)=>agg(i+20,70000,true))
  ];
  const book={
    bids:[['99.9','1500'],['99.8','1400'],['99.7','1350'],['99.6','1200'],['99.5','1100']],
    asks:[['100.1','500'],['100.2','450'],['100.3','420'],['100.4','400'],['100.5','380']]
  };
  const x=buildWhaleAccumulationAnalysis({
    ticker:{symbol:'TESTUSDT',lastPrice:100,priceChange24h:1.2,quoteVolume24h:15000000},
    oneMinute:candles,fiveMinute:candles.slice(40),
    aggTrades,book,previousBook:book
  });
  assert.equal(x.source.includes('/aggTrades'),true);
  assert.equal(x.direction,'BUY_SIDE');
  assert.ok(x.large_prints.largeBuyCount>x.large_prints.largeSellCount);
  assert.ok(x.large_prints.largeNotionalRatio>0);
  assert.ok(x.orderbook.nearImbalance>0);
  assert.ok(Number.isFinite(x.score));
  assert.equal(x.paper_trading,true);
  assert.equal(x.real_order_execution,false);
});

test('whale alert never claims trader identity',()=>{
  const candles=Array.from({length:80},(_,i)=>candle(i,100));
  const aggTrades=Array.from({length:12},(_,i)=>agg(i,80000,true));
  const book={bids:[['99.9','2000']],asks:[['100.1','500']]};
  const a=buildWhaleAccumulationAlert({
    ticker:{symbol:'TESTUSDT',lastPrice:100,priceChange24h:0.4,quoteVolume24h:20000000},
    oneMinute:candles,fiveMinute:candles.slice(40),aggTrades,book,previousBook:book
  });
  assert.equal(a.radar,'WHALE_ACCUMULATION_RADAR');
  assert.equal(a.paper_trading,true);
  assert.equal(a.real_order_execution,false);
  assert.equal(a.confidence_score,'UNKNOWN');
  assert.match(a.limitation,'identity');
  assert.match(a.disclaimer,'هوية');
});

test('quality V3 rejects explicit stale/invalid data',()=>{
  const q=evaluateRadarQuality({
    radar:'WHALE_ACCUMULATION_RADAR',opportunity_score:90,data_quality:95,liquidity_quality:90,
    reasons:['a','b','c'],risk_flags:['STALE_DATA']
  });
  assert.equal(q.hard_fail,true);
  assert.equal(q.decision,'REJECT');
});
