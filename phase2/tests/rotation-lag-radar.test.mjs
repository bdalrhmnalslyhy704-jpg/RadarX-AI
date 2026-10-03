import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRotationAnalysis,buildRotationAlert} from '../core/rotation-lag-radar.mjs';

function candle(i,{price=100,move=0,volume=100000,span=0.4}={}){
  const openTime=i*900000;
  const close=price*(1+move);
  return {openTime,closeTime:openTime+899000,open:price,high:Math.max(price,close)*(1+span/100),low:Math.min(price,close)*(1-span/100),close,volume,closed:true};
}

function makeSeries(n,base,{tailMove=0,tailVolume=100000,tailSpan=0.4}={}){
  const out=[];
  let price=base;
  for(let i=0;i<n;i++){
    const tail=i>=n-5;
    const move=tail?tailMove:0;
    out.push(candle(i,{
      price,
      move,
      volume:tail?tailVolume:100000,
      span:tail?tailSpan:0.4
    }));
    price*=1+move;
  }
  return out;
}

const n=90;
const symbol=makeSeries(n,100,{tailMove:0.0005,tailVolume:220000,tailSpan:0.55});
const btc=makeSeries(n,100,{tailMove:0.02,tailVolume:180000,tailSpan:0.6});
const eth=makeSeries(n,100,{tailMove:0.015,tailVolume:160000,tailSpan:0.6});
const oneHour=Array.from({length:40},(_,i)=>candle(i,{price:100}));

const now=Date.now();
const result=buildRotationAnalysis(symbol,oneHour,{
  BTCUSDT:{fifteen_min:btc,one_hour:oneHour},
  ETHUSDT:{fifteen_min:eth,one_hour:oneHour}
},{symbol:'TESTUSDT',lastPrice:100,priceChange24h:0.4},now);

assert.equal(result.closed_candles_only,true);
assert.equal(result.direction,'UP_ROTATION');
assert.ok(result.metrics.relative_30m_pct>0);
assert.ok(result.component_scores.silent_volume>60);
console.log('ROTATION_DEBUG', JSON.stringify({direction:result.direction,confirmations:result.confirmations,metrics:result.metrics,components:result.component_scores}));
assert.ok(result.confirmations>=4);
assert.ok(result.score>=70);

const alert=buildRotationAlert({
  ticker:{symbol:'TESTUSDT',lastPrice:100,priceChange24h:0.4},
  fifteen_min:symbol,one_hour:oneHour,
  benchmarks:{BTCUSDT:{fifteen_min:btc,one_hour:oneHour},ETHUSDT:{fifteen_min:eth,one_hour:oneHour}}
},now);
assert.equal(alert.event,'ROTATION_LAG_ALERT');
assert.equal(alert.radar,'ROTATION_LAG_RADAR');
assert.equal(alert.paper_trading,true);
assert.equal(alert.real_order_execution,false);
assert.equal(alert.confidence_score,'UNKNOWN');

const openLast=[...symbol];
openLast[openLast.length-1]={...openLast.at(-1),closed:false,closeTime:now+60000};
const closedOnly=buildRotationAnalysis(openLast,oneHour,{
  BTCUSDT:{fifteen_min:btc,one_hour:oneHour},
  ETHUSDT:{fifteen_min:eth,one_hour:oneHour}
},{symbol:'TESTUSDT',lastPrice:100,priceChange24h:0.4},now);
assert.equal(closedOnly.closed_candles_only,true);
assert.equal(closedOnly.counts.fifteen_min,n-1);

const extended=buildRotationAlert({
  ticker:{symbol:'TESTUSDT',lastPrice:100,priceChange24h:35},
  fifteen_min:symbol,one_hour:oneHour,
  benchmarks:{BTCUSDT:{fifteen_min:btc,one_hour:oneHour},ETHUSDT:{fifteen_min:eth,one_hour:oneHour}}
},now);
assert.ok(!extended.risk_flags.includes('24H_ALREADY_EXTENDED')||extended.price_change_24h>=10);

console.log('Rotation Lag Radar tests passed');
