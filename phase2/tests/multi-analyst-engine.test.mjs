import assert from 'node:assert/strict';
import {MULTI_ANALYST_NAMES,analyzeMultiAnalystCandidate} from '../core/multi-analyst-engine.mjs';

function candle(i,{tf='15m',base=100,trend=0.001,volume=1000}={}){
  const openTime=i*900000,close=base*(1+trend*i);
  const open=base*(1+trend*Math.max(0,i-1));
  const high=Math.max(open,close)*1.002,low=Math.min(open,close)*.998;
  return {openTime,open,high,low,close,volume,closeTime:openTime+899000,closed:true,takerBuyBaseVolume:volume*.56};
}
function series(count,{base=100,trend=.001}={}){
  return Array.from({length:count},(_,i)=>candle(i,{base,trend,volume:1000+(i%7)*50}));
}
function rawFor({valid=true,price=130,liq=85,dq=100}={}){
  const s15=series(120,{base:100,trend:.0019});
  const s1=series(100,{base:100,trend:.002});
  const s4=series(60,{base:100,trend:.003});
  if(!valid)s15[s15.length-1].closeTime=Date.now()+3600000;
  return {
    symbol:'TESTUSDT',last_price:price,price_change_24h:6,high_price_24h:135,low_price_24h:96,quote_volume_24h:2000000,
    liquidity_quality:liq,data_quality:dq,accepted_strategies:['A','B','C'],
    coverage:{strategy_count:14},best_strategy:'TEST',risk_flags:[],
    strategies:Array.from({length:14},(_,i)=>({score:{value:70+i%4}})),
    _analysis:{
      completedAt:Date.now(),series:{'4h':s4,'1h':s1,'15m':s15},
      depth:{bids:[['129.9','1000'],['129.8','900'],['129.5','800']],asks:[['130.1','500'],['130.3','450'],['130.5','400']]},
      liquidity:{quality:liq,spreadBps:5},
      evaluation:[]
    }
  };
}

assert.equal(MULTI_ANALYST_NAMES.length,20);
const good=analyzeMultiAnalystCandidate(rawFor(),{btc15:series(120,{base:90,trend:.0008}),btc1:series(100,{base:90,trend:.0008}),marketMedian24h:1,breadthPct:62});
assert.equal(good.specialist.a.length,19);
assert.equal(good.final.totalAnalysts,19);
assert.ok(['STRONG_CANDIDATE','CANDIDATE','WATCH','REJECT'].includes(good.final.verdict));
assert.ok(Number.isFinite(good.final.score));
assert.ok(Number.isFinite(good.final.early_score));
assert.ok(Number.isFinite(good.final.agreement));
assert.ok(['RISK_ON','RISK_OFF','MIXED'].includes(good.final.market_regime));
assert.ok(['EARLY_SETUP','CONFIRMING_SETUP','EXTENDED','BEARISH','NO_SETUP'].includes(good.final.timing));
assert.ok(Object.prototype.hasOwnProperty.call(good.final,'self_calibration'));

const badData=analyzeMultiAnalystCandidate(rawFor({valid:false,dq:40}),{});
assert.equal(badData.final.verdict,'REJECT');
assert.ok(badData.final.hardReasons.includes('DATA_GATE_FAILED'));

const badLiq=analyzeMultiAnalystCandidate(rawFor({liq:20}),{});
assert.equal(badLiq.final.verdict,'REJECT');
assert.ok(badLiq.final.hardReasons.includes('LIQUIDITY_TOO_WEAK'));

console.log('multi-analyst-engine.test.mjs: PASS');
