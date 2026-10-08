import assert from 'node:assert/strict';
import {MULTI_ANALYST_NAMES,analyzeMultiAnalystCandidate,MultiAnalystEngine} from '../core/multi-analyst-engine.mjs';

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
assert.ok(Number.isFinite(good.final.setup_fingerprint));
assert.ok(Number.isFinite(good.final.evidence_coverage));
assert.ok(good.final.group_consensus && Object.keys(good.final.group_consensus).length >= 10);
assert.equal(good.final.totalAnalysts, 19);
assert.equal(good.specialist.a.length, 19);
assert.ok(good.specialist.a.every(function(a){return typeof a.group==='string'&&Number.isFinite(Number(a.score))&&Number.isFinite(Number(a.coverage));}));


const badData=analyzeMultiAnalystCandidate(rawFor({valid:false,dq:40}),{});
assert.equal(badData.final.verdict,'REJECT');
assert.ok(badData.final.hardReasons.includes('DATA_GATE_FAILED'));

const badLiq=analyzeMultiAnalystCandidate(rawFor({liq:20}),{});
assert.equal(badLiq.final.verdict,'REJECT');
assert.ok(badLiq.final.hardReasons.includes('LIQUIDITY_TOO_WEAK'));

console.log('multi-analyst-engine.test.mjs: PASS');


// Regression: a discovered coin must not disappear before the 19-specialist lab.
// Invalid data is handled fail-closed by the final judge, but remains visible as a rejected lab result.
{
  const engine = new MultiAnalystEngine({
    rest: {request: async () => ({data: []})},
    config: {discoveryPool: 1, returnLimit: 1, deepConcurrency: 1}
  });
  engine.scanner = {
    exchangeInfo: async () => ({
      data: {symbols: [
        {symbol:'TESTUSDT',baseAsset:'TEST',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']}
      ]},
      source: 'TEST'
    }),
    ticker24h: async () => ({
      data: [{
        symbol:'TESTUSDT',lastPrice:'1',quoteVolume:'1000000',count:'1000',
        priceChangePercent:'1',highPrice:'1.1',lowPrice:'0.9',closeTime:Date.now()
      }],
      source:'TEST'
    }),
    scanSymbol: async () => ({
      symbol:'TESTUSDT',rank:1,last_price:1,price_change_24h:1,
      quote_volume_24h:1000000,liquidity_quality:0,data_quality:0,
      accepted_strategies:[],best_strategy:null,risk_flags:['LIQUIDITY_DATA_UNAVAILABLE'],
      reason_codes:['INSUFFICIENT_CLOSED_DATA','LIQUIDITY_GATE_FAILED'],
      invalidation:['CANDLE_GAP_OR_INTEGRITY_ERROR'],
      data_status:{data_valid:false,data_stale:false,last_error:'TEST_INVALID_DATA'},
      _analysis:{completedAt:Date.now(),series:{'4h':[],'1h':[],'15m':[]},depth:null}
    })
  };
  const out = await engine.scan({quote:'USDT',limit:1});
  assert.equal(out.universe.discovery_pool, 1);
  assert.equal(out.universe.scanned, 1);
  assert.equal(out.summary.rejected, 1);
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].verdict, 'REJECT');
  assert.equal(out.diagnostics.attempted_analyses, 1);
  assert.equal(out.diagnostics.successful_analyses, 0);
  assert.equal(out.diagnostics.gate_rejected, 1);
}

console.log('multi-analyst-engine lab-entry regression: PASS');

// Regression: a strategy-pipeline runtime error must not delete a discovered coin.
// The scanner returns the coin as a fail-closed lab rejection with the error attached.
{
  const base15=series(120,{base:100,trend:.001});
  const base1=series(100,{base:100,trend:.001});
  const base4=series(60,{base:100,trend:.001});
  const rawKlines=(xs)=>xs.map(x=>[
    x.openTime,String(x.open),String(x.high),String(x.low),String(x.close),String(x.volume),
    x.closeTime,String(x.volume),1000,String(x.takerBuyBaseVolume),String(x.takerBuyBaseVolume)
  ]);
  const scannerRest={
    request:async(path)=>{
      if(path==='/api/v3/exchangeInfo')return {data:{symbols:[
        {symbol:'TESTUSDT',baseAsset:'TEST',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']}
      ]},source:'TEST'};
      if(path==='/api/v3/ticker/24hr')return {data:[{
        symbol:'TESTUSDT',lastPrice:String(base15.at(-1).close),quoteVolume:'2000000',count:'5000',
        priceChangePercent:'1',highPrice:'101',lowPrice:'99',closeTime:Date.now()
      }],source:'TEST'};
      throw new Error('UNEXPECTED_REQUEST:'+path);
    },
    klines:async(symbol,interval)=>({candles:interval==='15m'?base15:interval==='1h'?base1:base4,source:'TEST'}),
    depth:async()=>({data:{
      bids:[['99.9','5000'],['99.8','4000']],asks:[['100.1','2000'],['100.2','1500']]
    },source:'TEST'})
  };
  const engineWithStrategyError=new MultiAnalystEngine({
    rest:scannerRest,
    config:{discoveryPool:1,returnLimit:1,deepConcurrency:1,deepKlines:120},
  });
  engineWithStrategyError.scanner.strategyEvaluator=()=>{throw new Error('SIMULATED_STRATEGY_PIPELINE_ERROR');};
  const out=await engineWithStrategyError.scan({quote:'USDT',limit:1});
  assert.equal(out.universe.scanned,1);
  assert.equal(out.candidates.length,1);
  assert.equal(out.candidates[0].verdict,'REJECT');
  assert.equal(out.candidates[0].data_status.data_valid,false);
  assert.match(String(out.candidates[0].data_status.last_error||''),/STRATEGY_PIPELINE_FAILED/);
  assert.equal(out.diagnostics.failed_analyses,0);
  assert.equal(out.diagnostics.gate_rejected,1);
}

console.log('multi-analyst-engine runtime-error regression: PASS');

// Regression: an unexpected scan-construction failure must fail closed without dropping the discovered symbol.
{
  const base15=series(120,{base:100,trend:.001});
  const base1=series(100,{base:100,trend:.001});
  const base4=series(60,{base:100,trend:.001});
  const scanner=new (await import('../market/universe-scanner.mjs')).MarketUniverseScanner({
    rest:{
      request:async()=>({data:[],source:'TEST'}),
      klines:async(symbol,interval)=>({candles:interval==='15m'?base15:interval==='1h'?base1:base4,source:'TEST'}),
      depth:async()=>({data:{bids:[['99.9','5000']],asks:[['100.1','2000']]},source:'TEST'})
    },
    config:{deepKlines:120}
  });
  scanner.computeLiquidity=()=>{throw new Error('SIMULATED_LIQUIDITY_COMPUTATION_ERROR');};
  const row=await scanner.scanSymbol(
    {symbol:'TESTUSDT',rank:1,lastPrice:100,priceChange24h:1,highPrice24h:101,lowPrice24h:99,quoteVolume24h:2000000,tradeCount24h:5000},
    1,
    {exchangeInfo:'TEST',ticker:'TEST'},
    {klinesLimit:120,includeAnalysisPayload:true}
  );
  assert.equal(row.data_status.data_valid,false);
  assert.match(String(row.data_status.last_error||''),/LIQUIDITY_COMPUTATION_FAILED/);
  assert.ok(row._analysis && row._analysis.series['15m'].length===120);
}

console.log('multi-analyst scan fail-closed regression: PASS');

// Regression: the multi-analyst scan requests the internal analysis payload;
// candidate construction must expose evaluated strategies without throwing.
{
  const base15=series(120,{base:100,trend:.001});
  const base1=series(100,{base:100,trend:.001});
  const base4=series(60,{base:100,trend:.001});
  const scanner=new (await import('../market/universe-scanner.mjs')).MarketUniverseScanner({
    rest:{
      request:async()=>({data:[],source:'TEST'}),
      klines:async(symbol,interval)=>({candles:interval==='15m'?base15:interval==='1h'?base1:base4,source:'TEST'}),
      depth:async()=>({data:{bids:[['99.9','5000'],['99.8','4000']],asks:[['100.1','2000'],['100.2','1500']]},source:'TEST'})
    },
    config:{deepKlines:120}
  });
  const row=await scanner.scanSymbol(
    {symbol:'TESTUSDT',rank:1,lastPrice:100,priceChange24h:1,highPrice24h:101,lowPrice24h:99,quoteVolume24h:2000000,tradeCount24h:5000},
    1,
    {exchangeInfo:'TEST',ticker:'TEST'},
    {klinesLimit:120,includeAnalysisPayload:true}
  );
  assert.ok(row._analysis);
  assert.ok(Array.isArray(row._analysis.evaluation));
  assert.equal(row.data_status.last_error,null);
}

console.log('multi-analyst scan payload regression: PASS');

