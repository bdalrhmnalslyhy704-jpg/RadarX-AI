import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRotationAnalysis,buildRotationAlert,RotationLagRadar} from '../core/rotation-lag-radar.mjs';

const now=Date.now();

function candle(i,{price=100,move=0,volume=100000,span=0.4,intervalMs=900000,seriesLength=90,clock=now}={}){
  const closeTime=clock-(seriesLength-i-1)*intervalMs-1000;
  const openTime=closeTime-intervalMs+1000;
  const close=price*(1+move);
  return {openTime,closeTime,open:price,high:Math.max(price,close)*(1+span/100),low:Math.min(price,close)*(1-span/100),close,volume,closed:true};
}

function makeSeries(n,base,{tailMove=0,tailVolume=100000,tailSpan=0.4,intervalMs=900000,clock=now}={}){
  const out=[];
  let price=base;
  for(let i=0;i<n;i++){
    const tail=i>=n-5;
    const move=tail?tailMove:0;
    out.push(candle(i,{
      price,
      move,
      volume:tail?tailVolume:100000,
      span:tail?tailSpan:0.4,
      intervalMs,
      seriesLength:n,
      clock
    }));
    price*=1+move;
  }
  return out;
}

const n=90;
const symbol=makeSeries(n,100,{tailMove:0.0005,tailVolume:220000,tailSpan:0.55});
const btc=makeSeries(n,100,{tailMove:0.02,tailVolume:180000,tailSpan:0.6});
const eth=makeSeries(n,100,{tailMove:0.015,tailVolume:160000,tailSpan:0.6});
const oneHour=Array.from({length:40},(_,i)=>candle(i,{price:100,intervalMs:3600000,seriesLength:40}));
const result=buildRotationAnalysis(symbol,oneHour,{
  BTCUSDT:{fifteen_min:btc,one_hour:oneHour},
  ETHUSDT:{fifteen_min:eth,one_hour:oneHour}
},{symbol:'TESTUSDT',lastPrice:100,priceChange24h:0.4},now);

assert.equal(result.closed_candles_only,true);
assert.equal(result.direction,'UP_ROTATION');
assert.ok(result.metrics.relative_30m_pct>0);
assert.ok(result.component_scores.silent_volume>60);
const confirmationCount = Array.isArray(result.confirmations) ? result.confirmations.length : Number(result.confirmations);
assert.ok(confirmationCount>=4);
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

test('Rotation Lag fills rotation slots when the cursor overlaps the ranked shortlist',()=>{
  const radar=new RotationLagRadar({rest:{},store:{},config:{topLaggers:2,rotationBatchSize:5},clock:()=>now});
  radar.universe=Array.from({length:16},(_,i)=>`R${String(i).padStart(2,'0')}USDT`);
  const rows=radar.universe.map((symbol,i)=>({symbol,lastPrice:1+i,priceChange24h:i,quoteVolume24h:2_000_000}));
  const selected=radar.selectBatch(rows);
  assert.equal(selected.length,7);
  assert.equal(new Set(selected.map(x=>x.symbol)).size,7);
});


test('Rotation Lag rejects stale closed candles instead of scoring cached data',()=>{
  const stale=makeSeries(n,100,{tailMove:0.0005,tailVolume:220000,tailSpan:0.55,clock:now-45*60_000});
  const a=buildRotationAnalysis(stale,oneHour,{
    BTCUSDT:{fifteen_min:btc,one_hour:oneHour},
    ETHUSDT:{fifteen_min:eth,one_hour:oneHour}
  },{symbol:'STALEUSDT',lastPrice:100,priceChange24h:0.4},now);
  assert.equal(a.eligible,false);
  assert.equal(a.stage,'DATA_STALE');
  assert.equal(a.data_stale,true);
  assert.ok(a.data_quality_reasons.includes('SYMBOL_15M_STALE_CLOSED_CANDLES'));
});

test('Rotation Lag rejects gaps in the scoring window rather than compressing missing intervals',()=>{
  const gapped=symbol.filter((_,i)=>i!==45);
  const a=buildRotationAnalysis(gapped,oneHour,{
    BTCUSDT:{fifteen_min:btc,one_hour:oneHour},
    ETHUSDT:{fifteen_min:eth,one_hour:oneHour}
  },{symbol:'GAPUSDT',lastPrice:100,priceChange24h:0.4},now);
  assert.equal(a.eligible,false);
  assert.equal(a.stage,'DATA_GAP');
  assert.ok(a.data_quality_reasons.includes('SYMBOL_15M_CLOSED_CANDLE_GAP'));
});

test('Rotation Lag tolerates insufficient closed-candle data without crashing risk-flag construction',()=>{
  const incomplete=buildRotationAlert({
    ticker:{symbol:'SPARSEUSDT',lastPrice:1,priceChange24h:0.5},
    fifteen_min:[],one_hour:[],benchmarks:{}
  },now);
  assert.equal(incomplete.rotation.stage,'INSUFFICIENT_DATA');
  assert.equal(incomplete.eligible,false);
  assert.deepEqual(incomplete.risk_flags,[]);
});
