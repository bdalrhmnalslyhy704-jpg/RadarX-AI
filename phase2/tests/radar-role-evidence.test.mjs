import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRadarRoleEvidence,validateClosedCandleSeries} from '../core/radar-role-evidence.mjs';
const START=1_800_000_000_000;
function bars({n=45,interval=60_000,endAt=START+n*interval-1,startPrice=100,delta=0.002,vol=1000,trades=100}={}){
 const origin=endAt-(n-1)*interval-(interval-1);
 return Array.from({length:n},(_,i)=>{const close=startPrice*(1+delta*i);return {openTime:origin+i*interval,closeTime:origin+i*interval+interval-1,
 open:close/(1+delta/2),high:close*1.002,low:close*0.998,close,volume:vol,quoteVolume:vol*close,tradeCount:trades,takerBuyBaseVolume:vol*0.55,closed:true};});
}
test('closed candle validator explicitly rejects gaps, stale candles and future timestamps',()=>{
 const now=START+50*60_000-1,gap=bars({n:50,endAt:now});gap.splice(43,1);
 assert.ok(validateClosedCandleSeries(gap,{now,intervalMs:60_000,minCount:30,windowBars:20,maxAgeMs:180_000}).reasons.includes('CLOSED_CANDLE_SEQUENCE_HAS_GAPS'));
 assert.ok(validateClosedCandleSeries(bars({n:50,endAt:now-10*60_000}),{now,intervalMs:60_000,minCount:30,maxAgeMs:180_000}).reasons.includes('STALE_CLOSED_CANDLES'));
 const future=[...bars({n:50,endAt:now}),{...bars({n:1,endAt:now+120_000})[0],openTime:now+60_000,closeTime:now+119_999}];
 assert.ok(validateClosedCandleSeries(future,{now,intervalMs:60_000,minCount:30,maxAgeMs:180_000}).reasons.includes('FUTURE_CANDLE_TIMESTAMP'));
});
test('relative strength compares matched closed-candle returns to a benchmark',()=>{
 const now=START+60*60_000-1,coin=bars({n:50,interval:300_000,endAt:now,delta:0.006}),btc=bars({n:50,interval:300_000,endAt:now,delta:0.001});
 const r=buildRadarRoleEvidence({candles:coin,relativeCandles:coin,benchmarkCandles:btc,now,intervalMs:300_000,relativeIntervalMs:300_000,marketExcessPct:0.9,peerExcessPct:1.1});
 assert.equal(r.relative_strength.status,'OUTPERFORMING');assert.ok(r.relative_strength.excess_vs_benchmark_pct>0);
 assert.equal(r.relative_strength.excess_vs_market_24h_pct,0.9);assert.equal(r.relative_strength.excess_vs_liquidity_peers_24h_pct,1.1);
});
test('failed breakout requires a resistance pierce, weak close and selling or fading activity',()=>{
 const now=START+50*60_000-1,data=bars({n:50,endAt:now,delta:0.0005}),resistance=Math.max(...data.slice(-24,-4).map(c=>c.high));
 for(const c of data.slice(-4)){c.high=resistance*1.012;c.open=resistance*1.006;c.close=resistance*0.992;c.low=resistance*0.97;c.takerBuyBaseVolume=c.volume*0.44;c.quoteVolume=c.close*c.volume;}
 const r=buildRadarRoleEvidence({candles:data,now,intervalMs:60_000,volumeRatio:0.8,tradeRatio:0.8,takerBuyRatio:0.44});
 assert.equal(r.failed_breakout.detected,true);assert.equal(r.failed_breakout.status,'FAILED_BREAKOUT_TRAP');
});
test('continuation reports weak when a recent breakout loses its level and participation',()=>{
 const now=START+50*60_000-1,data=bars({n:50,endAt:now,delta:0.0002}),resistance=Math.max(...data.slice(-23,-3).map(c=>c.high));
 data.at(-3).close=resistance*1.01;data.at(-2).close=resistance*0.99;data.at(-1).close=resistance*0.985;
 for(const c of data.slice(-3)){c.open=resistance*1.002;c.high=resistance*1.012;c.low=resistance*0.98;c.quoteVolume=c.close*c.volume;}
 const r=buildRadarRoleEvidence({candles:data,now,intervalMs:60_000,volumeRatio:0.9,tradeRatio:0.8,takerBuyRatio:0.46});
 assert.equal(r.continuation.status,'WEAK');assert.equal(r.continuation.confirmed,false);
});
