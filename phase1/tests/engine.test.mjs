import test from '../../phase2/tests/test-helpers.mjs';
import assert from 'node:assert/strict';
import {makeCandle,upSeries,downSeries,breakoutSeries,oversoldSeries} from './fixtures.mjs';
import {ema,rsi,bollinger,atr,rvol,macd,validateCandle,validateSeries,rejectFutureData,liquidityQuality,spreadBps,obi,evaluateBreakout,evaluateMeanReversion,evaluateMTFTrend,riskFilter,makeSignal,shouldEmitSignal,roundTripNetRR} from '../radarx-phase1-engine.mjs';

const resample=(cs,f)=>{const out=[];for(let i=0;i<cs.length;i+=f){const a=cs.slice(i,i+f);if(!a.length)break;out.push({openTime:a[0].openTime,closeTime:a.at(-1).closeTime,open:a[0].open,high:Math.max(...a.map(x=>x.high)),low:Math.min(...a.map(x=>x.low)),close:a.at(-1).close,volume:a.reduce((s,x)=>s+x.volume,0),closed:true});}return out;};

test('indicators: EMA RSI Bollinger ATR RVOL MACD',()=>{
  const e=ema([1,2,3,4,5],3);assert.equal(e[2],2);assert.ok(e[4]>e[3]);
  assert.equal(rsi(Array.from({length:20},(_,i)=>i+1),14)[14],100);
  assert.equal(bollinger(Array.from({length:25},(_,i)=>100+i),20,2).middle[19],109.5);
  assert.ok(atr(Array.from({length:20},(_,i)=>makeCandle(i*60000,100+i,101+i,99+i,100.5+i,1000)),14).at(-1)>=0);
  assert.equal(rvol(Array(25).fill(1000),20)[19],1);
  assert.ok(macd(Array.from({length:60},(_,i)=>100+i)).histogram.some(v=>v!==null));
});
test('data integrity: malformed, gap, duplicate and future detection',()=>{
  const bad=makeCandle(0,100,101,99,100,1000);bad.high=98;assert.equal(validateCandle(bad).valid,false);
  const a=makeCandle(0,100,101,99,100,1000),b=makeCandle(600000,100,101,99,100,1000),d={...b};
  const v=validateSeries([a,b,d],'5m');assert.ok(v.issues.some(x=>x.includes('DUPLICATE')));assert.ok(v.issues.some(x=>x.includes('GAP')));
  assert.equal(rejectFutureData([makeCandle(2000,1,2,0,1,1)],1000),true);
});
test('liquidity math is deterministic',()=>{
  assert.equal(Math.round(spreadBps(100,100.1)*10)/10,10);
  assert.equal(obi({bidDepth:600,askDepth:400,totalDepth:1000}),.2);
  assert.ok(liquidityQuality({spread:5,totalDepth:100000,quoteVolume24h:1e8,tradeCount24h:10000})>=80);
});
test('breakout requires closed price confirmation and volume and rejects wick fakeout',()=>{
  const s=breakoutSeries({n:60,breakClose:103}),book={spreadBps:5,obi:.2,liquidityQuality:90};
  const ok=evaluateBreakout({series4h:resample(upSeries({n:240}),16),series1h:resample(upSeries({n:240}),4),series15m:s,book});
  assert.equal(ok.state,'CONFIRMED');assert.equal(ok.direction,'LONG');
  s[s.length-1]={...s.at(-1),high:104,open:99.5,close:99.7};
  const bad=evaluateBreakout({series4h:resample(upSeries({n:240}),16),series1h:resample(upSeries({n:240}),4),series15m:s,book});
  assert.equal(bad.reasonCodes[0],'FALSE_BREAKOUT');
});
test('mean reversion blocks panic selling even when oversold',()=>{
  const h1=oversoldSeries({n:80}),h4=resample(downSeries({n:320}),4),m15=resample(h1,1),x=m15.at(-1);
  m15[m15.length-1]={...x,open:x.close+2,high:x.close+2.2,low:x.close-.2,close:x.close-1.5,volume:6000};
  const r=evaluateMeanReversion({series4h:h4,series1h:h1,series15m:m15,liquidityQuality:90});
  assert.equal(r.state,'REJECTED');assert.equal(r.reasonCodes[0],'PANIC_SELL_FILTER');
});
test('trend ignores incomplete trigger candle',()=>{
  const s=upSeries({n:240});s.at(-1).closed=false;
  assert.equal(evaluateMTFTrend({series4h:s,series1h:s,series15m:s.slice(-100)}).state,'REJECTED');
});
test('risk filter fails unknown costs and low liquidity',()=>{
  const a=riskFilter({candleClosed:true,dataQuality:95,liquidityQuality:90});assert.equal(a.value,'FAIL');assert.ok(a.reasons.includes('UNKNOWN_COST_MODEL'));
  assert.equal(riskFilter({candleClosed:true,dataQuality:95,liquidityQuality:40,netRR:2}).value,'FAIL');
  assert.ok(roundTripNetRR({entry:100,stop:98,target:104,feeRate:.001,slippageBps:5})>1.5);
});
test('signal contract is spot/read-only and confidence is UNKNOWN until calibrated',()=>{
  const s=makeSignal({symbol:'TESTUSDT',strategy:'MTF_TREND',direction:'LONG',candle:{timeframe:'15m',openTime:1,closeTime:2,closed:true},scores:{trendScore:80},dataQuality:95,liquidityQuality:90,risk:{value:'FAIL',reasons:['UNKNOWN_COST_MODEL']},source:'TEST_FIXTURE'});
  assert.equal(s.market,'SPOT');assert.equal(s.scores.confidence_score,'UNKNOWN');assert.equal(s.paper_trade.real_order_execution,false);
});
test('duplicate signal is suppressed',()=>{
  const common={symbol:'TESTUSDT',strategy:'MTF_TREND',direction:'LONG',candle:{timeframe:'15m',openTime:1,closeTime:2,closed:true}};
  assert.equal(shouldEmitSignal(makeSignal(common),makeSignal(common),{now:Date.now(),cooldownMs:900000}),false);
});
