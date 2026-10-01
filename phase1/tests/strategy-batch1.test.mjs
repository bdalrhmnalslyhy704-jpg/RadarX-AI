import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateEMARibbonAlignment,
  evaluateADXTrendStrength,
  evaluateMACDTrendContinuation,
  evaluateBollingerBandReversion,
  evaluateVWAPReversion,
  evaluateRelativeVolumeSurge,
  evaluateATRExpansion
} from '../strategy-batch1.mjs';
import {normalizeStrategyResult,listActiveStrategies} from '../strategy-registry.mjs';

const NOW = 2_000_000_000_000;
const STEP = { '15m':900000, '1h':3600000, '4h':14400000 };

function makeSeries(tf, values, volumes=1000) {
  const step=STEP[tf], lastClose=NOW-60000, lastOpen=lastClose-(step-1);
  return values.map((close,i)=>{
    const open=close-0.4;
    const high=Math.max(open,close)+0.6;
    const low=Math.min(open,close)-0.6;
    const openTime=lastOpen-(values.length-1-i)*step;
    return {openTime,closeTime:openTime+step-1,open,high,low,close,volume:Array.isArray(volumes)?volumes[i]:volumes,closed:true,source:'TEST_FIXTURE'};
  });
}
function trendValues(n,start,delta) { return Array.from({length:n},(_,i)=>start+i*delta); }

function fixtures(id, direction) {
  if (id==='EMA_RIBBON_ALIGNMENT') return {series1h:makeSeries('1h',trendValues(220,direction==='LONG'?100:300,direction==='LONG'?1:-1))};
  if (id==='ADX_TREND_STRENGTH') return {series1h:makeSeries('1h',trendValues(100,direction==='LONG'?100:200,direction==='LONG'?1.2:-1.2))};
  if (id==='MACD_TREND_CONTINUATION') {
    const v1=trendValues(95,direction==='LONG'?100:200,direction==='LONG'?1:-1);
    const v4=trendValues(55,direction==='LONG'?100:200,direction==='LONG'?2:-2);
    const tail1=direction==='LONG'?[196,199,203,208,214]:[104,101,97,92,86];
    const tail4=direction==='LONG'?[210,214,219,225,232]:[90,86,81,75,68];
    return {series1h:makeSeries('1h',v1.concat(tail1)),series4h:makeSeries('4h',v4.concat(tail4))};
  }
  if (id==='BOLLINGER_BAND_REVERSION') {
    const base=Array(40).fill(100);
    const tail=direction==='LONG'?[96,94,92,90,88,86,84,82,80,76]:[104,106,108,110,112,114,116,118,120,124];
    const s=makeSeries('1h',[...base,...tail]);
    const x=s.at(-1);
    s[s.length-1]={...x,open:direction==='LONG'?74:126,close:direction==='LONG'?76:124,high:direction==='LONG'?78:130,low:direction==='LONG'?70:122};
    return {series1h:s};
  }
  if (id==='VWAP_REVERSION') {
    const vals=Array(29).fill(100);
    if(direction==='LONG') vals[27]=90;
    vals.push(direction==='LONG'?98.5:101.5);
    const s=makeSeries('15m',vals,1000);
    const x=s.at(-1);
    s[s.length-2]={...s.at(-2),close:direction==='LONG'?95:105,open:direction==='LONG'?95:105,high:direction==='LONG'?96:106,low:direction==='LONG'?94:104};
    s[s.length-1]={...x,open:direction==='LONG'?95:105,close:direction==='LONG'?98:102,high:direction==='LONG'?101:108,low:direction==='LONG'?94:99};
    return {series15m:s,liquidityQuality:100};
  }
  if (id==='RELATIVE_VOLUME_SURGE') {
    const vals=trendValues(24,direction==='LONG'?100:124,direction==='LONG'?1:-1).concat(direction==='LONG'?126:98);
    const volumes=Array(24).fill(1000).concat(3000);
    const s=makeSeries('15m',vals,volumes);
    const x=s.at(-1);
    s[s.length-1]={...x,open:direction==='LONG'?124:100,close:direction==='LONG'?126:98,high:direction==='LONG'?127:101,low:direction==='LONG'?123:97};
    return {series15m:s};
  }
  if (id==='ATR_EXPANSION') {
    const vals=trendValues(39,direction==='LONG'?100:139,direction==='LONG'?.2:-.2).concat(direction==='LONG'?108:131);
    const s=makeSeries('15m',vals,1000);
    const x=s.at(-1);
    s[s.length-1]={...x,open:direction==='LONG'?100:139,close:direction==='LONG'?108:131,high:direction==='LONG'?110:140,low:direction==='LONG'?99:129};
    return {series15m:s,liquidityQuality:100};
  }
  throw new Error(id);
}

const cases=[
  ['EMA_RIBBON_ALIGNMENT',evaluateEMARibbonAlignment],
  ['ADX_TREND_STRENGTH',evaluateADXTrendStrength],
  ['MACD_TREND_CONTINUATION',evaluateMACDTrendContinuation],
  ['BOLLINGER_BAND_REVERSION',evaluateBollingerBandReversion],
  ['VWAP_REVERSION',evaluateVWAPReversion],
  ['RELATIVE_VOLUME_SURGE',evaluateRelativeVolumeSurge],
  ['ATR_EXPANSION',evaluateATRExpansion]
];

for (const [id,evaluator] of cases) {
  test(id+' produces a real LONG/ascending result',()=>{
    const r=evaluator({...fixtures(id,'LONG'),now:NOW});
    assert.equal(r.direction,'LONG',JSON.stringify(r));
    assert.ok(['CANDIDATE','CONFIRMED'].includes(r.state),JSON.stringify(r));
    assert.ok(Number.isFinite(r.score?.value),JSON.stringify(r));
  });
  test(id+' produces a real BEARISH/descending result',()=>{
    const r=evaluator({...fixtures(id,'BEARISH'),now:NOW});
    assert.equal(r.direction,'BEARISH',JSON.stringify(r));
    assert.ok(['CANDIDATE','CONFIRMED'].includes(r.state),JSON.stringify(r));
    assert.ok(Number.isFinite(r.score?.value),JSON.stringify(r));
  });
  test(id+' rejects missing data as INSUFFICIENT_DATA',()=>{
    const r=evaluator({now:NOW});
    assert.equal(r.state,'INSUFFICIENT_DATA');
    assert.equal(r.score?.value,undefined);
  });
  test(id+' ignores an unclosed current candle',()=>{
    const args=fixtures(id,'LONG');
    const baseline=evaluator({...args,now:NOW});
    const key=Object.keys(args).find(k=>Array.isArray(args[k]));
    const modified={...args,[key]:[...args[key],{...args[key].at(-1),openTime:NOW-1000,closeTime:NOW+STEP[key.includes('15m')?'15m':key.includes('4h')?'4h':'1h']-1,closed:false,open:1,high:2,low:.5,close:1,volume:999999}]};
    const r=evaluator({...modified,now:NOW});
    assert.equal(r.direction,baseline.direction);
    assert.equal(r.state,baseline.state);
  });
  test(id+' rejects future closed data',()=>{
    const args=fixtures(id,'LONG');
    const key=Object.keys(args).find(k=>Array.isArray(args[k]));
    const s=args[key].map(x=>({...x}));
    s.push({...s.at(-1),openTime:NOW+STEP[key==='series15m'?'15m':key==='series4h'?'4h':'1h'],closeTime:NOW+STEP[key==='series15m'?'15m':key==='series4h'?'4h':'1h']*2,closed:true});
    const r=evaluator({...args,[key]:s,now:NOW});
    assert.equal(r.state,'REJECTED');
    assert.ok(r.reasonCodes.includes('FUTURE_DATA'));
    assert.equal(r.score?.value,undefined);
  });
  test(id+' rejects gaps and invalid candles',()=>{
    const args=fixtures(id,'LONG');
    const key=Object.keys(args).find(k=>Array.isArray(args[k]));
    const gap=[...args[key].map(x=>({...x}))];
    gap[Math.floor(gap.length/2)].openTime+=STEP[key==='series15m'?'15m':key==='series4h'?'4h':'1h'];
    gap[Math.floor(gap.length/2)].closeTime=gap[Math.floor(gap.length/2)].openTime+STEP[key==='series15m'?'15m':key==='series4h'?'4h':'1h']-1;
    const bad=evaluator({...args,[key]:gap,now:NOW});
    assert.equal(bad.state,'REJECTED');
    assert.ok(bad.reasonCodes.some(x=>String(x).includes('INVALID_DATA')||String(x).includes('GAP')));
  });
  test(id+' preserves evidence and reason codes',()=>{
    const r=evaluator({...fixtures(id,'LONG'),now:NOW});
    assert.ok(r.evidence && typeof r.evidence==='object');
    assert.ok(Array.isArray(r.reasonCodes) && r.reasonCodes.length>0);
    assert.equal(r.confidence_score,'UNKNOWN');
  });
}

test('first strategy batch has exactly seven ACTIVE implementations in the registry',()=>{
  const ids=listActiveStrategies().map(x=>x.id);
  for(const id of cases.map(x=>x[0])) assert.ok(ids.includes(id),id);
  assert.equal(ids.length,10);
});

test('each first-batch evaluator has a real function and metadata',()=>{
  for(const id of cases.map(x=>x[0])) {
    const entry=listActiveStrategies().find(x=>x.id===id);
    assert.equal(typeof entry.evaluator,'function');
    assert.ok(entry.requiredData.length);
    assert.ok(entry.hardGates.length);
    assert.ok(entry.reasonCodes.length);
    assert.ok(entry.invalidationRules.length);
    assert.match(entry.testReference,/strategy-batch1\.test\.mjs$/);
  }
});

test('first batch hard-gate failures never expose a score',()=>{
  const bad=[
    ['EMA_RIBBON_ALIGNMENT',evaluateEMARibbonAlignment,{emaRibbonMinSeparationPct:99}],
    ['ADX_TREND_STRENGTH',evaluateADXTrendStrength,{minAdx:999}],
    ['MACD_TREND_CONTINUATION',evaluateMACDTrendContinuation,{minHistogramFraction:999}],
    ['BOLLINGER_BAND_REVERSION',evaluateBollingerBandReversion,{bbStdDev:100}],
    ['VWAP_REVERSION',evaluateVWAPReversion,{minLiquidityQuality:101}],
    ['RELATIVE_VOLUME_SURGE',evaluateRelativeVolumeSurge,{minRvol:99}],
    ['ATR_EXPANSION',evaluateATRExpansion,{minExpansionRatio:99}]
  ];
  for(const [id,evaluator,config] of bad){
    const args=fixtures(id,'LONG');
    const r=evaluator({...args,config,now:NOW});
    assert.equal(r.state,'REJECTED',id);
    assert.equal(r.score?.value,undefined,id);
  }
});

test('coverage below 1 suppresses score for every first-batch strategy',()=>{
  for(const [id,evaluator] of cases){
    const r=evaluator({...fixtures(id,'LONG'),now:NOW});
    const n=normalizeStrategyResult(id,r,{coverage:.5});
    assert.equal(n.score.value,null,id);
    assert.equal(n.score.decision_band,'insufficient',id);
  }
});
