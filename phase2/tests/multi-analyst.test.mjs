import assert from 'node:assert/strict';
import {MultiAnalystEngine} from '../core/multi-analyst-engine.mjs';

const now=Date.now();
function kline(i,tfMs,base=100){
  const openTime=now-(220-i)*tfMs;
  const closeTime=openTime+tfMs-1000;
  const drift=i*0.03;
  const open=base+drift,close=open+0.15;
  return {
    openTime,open,high:close+0.4,low:open-0.2,close,volume:1000+i*2,
    closeTime,quoteVolume:(1000+i*2)*close,tradeCount:500+i,
    takerBuyBaseVolume:600+i*1.2,takerBuyQuoteVolume:(600+i*1.2)*close,
    closed:true,sourceTime:closeTime
  };
}
const seriesFor=tf=>Array.from({length:220},(_,i)=>kline(i,tf,100));
const rest={
  async request(path){
    if(path==='/api/v3/exchangeInfo') return {
      data:{symbols:[{symbol:'TESTUSDT',baseAsset:'TEST',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']}]},
      source:'BINANCE_PUBLIC_REST',receivedAt:now
    };
    if(path==='/api/v3/ticker/24hr') return {
      data:[{symbol:'TESTUSDT',lastPrice:'106.5',quoteVolume:'8000000',count:250000,priceChangePercent:'4.2',highPrice:'108',lowPrice:'95',closeTime:now}],
      source:'BINANCE_PUBLIC_REST',receivedAt:now
    };
    if(path==='/api/v3/depth') return {
      data:{bids:[['106.4','1200'],['106.3','1000'],['106','900']],asks:[['106.6','700'],['106.7','600'],['107','500']]},
      source:'BINANCE_PUBLIC_REST',receivedAt:now
    };
    throw new Error('UNEXPECTED_REQUEST:'+path);
  },
  async klines(symbol,interval){
    const ms=interval==='4h'?14400000:interval==='1h'?3600000:interval==='5m'?300000:900000;
    return {candles:seriesFor(ms),source:'BINANCE_PUBLIC_REST',receivedAt:now};
  },
  async depth(symbol){
    return await this.request('/api/v3/depth');
  }
};
const engine=new MultiAnalystEngine({
  rest,
  config:{discoveryPool:1,returnLimit:1,deepConcurrency:1,minQuoteVolume24h:300000,minDataQuality:0,minLiquidityQuality:0,ttlMs:1}
});
const out=await engine.scan({quote:'USDT',limit:1});
assert.equal(out.meta.analyst_count,20);
assert.equal(out.meta.specialist_count,19);
assert.equal(out.pipeline.length,4);
assert.ok(Array.isArray(out.candidates));
assert.equal(out.candidates.length,1);
const c=out.candidates[0];
assert.equal(c.analysts.length,19);
assert.equal(c.final_judge.totalAnalysts,19);
assert.ok(Number.isFinite(c.final_score));
assert.ok(typeof c.verdict==='string');
assert.equal(c.paper_trading,true);
assert.equal(c.real_order_execution,false);
assert.equal(c.confidence_score,'UNKNOWN');
console.log('multi-analyst.test: ok');
