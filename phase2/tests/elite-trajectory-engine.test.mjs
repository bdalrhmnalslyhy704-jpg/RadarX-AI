import assert from 'node:assert/strict';
import {analyzeMultiAnalystCandidate} from '../core/multi-analyst-engine.mjs';

function candle(i,{base=100,trend=.001,volume=1000,tfMs=900000}={}){
  const openTime=i*tfMs,close=base*(1+trend*i);
  const open=base*(1+trend*Math.max(0,i-1));
  const high=Math.max(open,close)*1.002,low=Math.min(open,close)*.998;
  return {openTime,open,high,low,close,volume,closeTime:openTime+tfMs-1000,closed:true,takerBuyBaseVolume:volume*.56};
}
function series(count,opts={}){return Array.from({length:count},(_,i)=>candle(i,opts));}
function raw({move=1,dq=95,liq=85}={}){
  return {
    symbol:'TESTUSDT',last_price:130,price_change_24h:move,high_price_24h:135,low_price_24h:96,
    quote_volume_24h:2000000,liquidity_quality:liq,data_quality:dq,
    accepted_strategies:['A','B','C'],coverage:{strategy_count:14,ratio:1},best_strategy:'TEST',risk_flags:[],
    strategies:Array.from({length:14},(_,i)=>({score:{value:72+i%4}})),
    _analysis:{
      completedAt:Date.now(),
      series:{
        '4h':series(60,{base:100,trend:.003,tfMs:14400000}),
        '1h':series(100,{base:100,trend:.002,tfMs:3600000}),
        '15m':series(120,{base:100,trend:.0019,tfMs:900000})
      },
      depth:{
        bids:[['129.9','1000'],['129.8','900'],['129.5','800']],
        asks:[['130.1','500'],['130.3','450'],['130.5','400']]
      }
    }
  };
}

const first=analyzeMultiAnalystCandidate(raw(),{marketMedian24h:1,breadthPct:62});
assert.equal(first.specialist.a.length,19);
assert.equal(first.final.totalAnalysts,19);
assert.ok(Number.isFinite(first.final.score));
assert.ok(Number.isFinite(first.final.temporal_trajectory));
const extension=first.specialist.a.find(x=>x.id==='EXTENSION');
assert.ok(extension);
assert.ok(Number.isFinite(Number(extension.evidence.distanceFromEmaPct)),'distanceFromEmaPct must be defined');

const now=Date.now();
const memory={
  as_of:now-2*60*1000,
  early_score:66,
  history:[
    {as_of:now-12*60*1000,early_score:55,final_score:60},
    {as_of:now-8*60*1000,early_score:61,final_score:66},
    {as_of:now-4*60*1000,early_score:66,final_score:70}
  ]
};
const withTrajectory=analyzeMultiAnalystCandidate(raw(),{marketMedian24h:1,breadthPct:62},memory);
assert.ok(withTrajectory.final.temporal_trajectory>50);
assert.equal(withTrajectory.final.temporal_trajectory_observations,3);

const chased=analyzeMultiAnalystCandidate(raw({move:10}),{marketMedian24h:1,breadthPct:62});
assert.ok(chased.final.hardReasons.includes('EARLY_WINDOW_LOST'));

console.log('elite-trajectory-engine.test.mjs: PASS');
