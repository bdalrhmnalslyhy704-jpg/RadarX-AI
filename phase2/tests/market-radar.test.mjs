import test from 'node:test';
import assert from 'node:assert/strict';
import {MarketUniverseScanner, buildSpotUniverse, rankTickerRows, boundedMap, normalizeRadarLimit} from '../market/universe-scanner.mjs';

function candle(t, close=100, tfMs=900000) {
  return {
    openTime:t,
    closeTime:t+tfMs-1,
    open:close-1,
    high:close+1,
    low:close-2,
    close,
    volume:1000,
    quoteVolume:100000,
    tradeCount:1000,
    closed:true,
    source:'TEST_FIXTURE',
    sourceTime:Date.now()
  };
}
function series(tf, count=250, lastAgeMs=60_000) {
  const step = tf==='4h' ? 14_400_000 : tf==='1h' ? 3_600_000 : 900_000;
  const lastOpen = Date.now() - lastAgeMs - step + 1;
  return Array.from({length:count},(_,i)=>candle(lastOpen-(count-1-i)*step,100+i*0.05,step));
}

function exchangeInfo() {
  return {symbols:[
    {symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']},
    {symbol:'ETHUSDT',baseAsset:'ETH',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']},
    {symbol:'LOWUSDT',baseAsset:'LOW',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']},
    {symbol:'OFFUSDT',baseAsset:'OFF',quoteAsset:'USDT',status:'BREAK',isSpotTradingAllowed:true,permissions:['SPOT']},
    {symbol:'MARGINUSDT',baseAsset:'MARGIN',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:false,permissions:['MARGIN']},
    {symbol:'ETHBTC',baseAsset:'ETH',quoteAsset:'BTC',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']},
    {symbol:'USDTUSDT',baseAsset:'USDT',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']},
    {symbol:'BAD-USDT',baseAsset:'BAD',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']}
  ]};
}

function tickers() {
  return [
    {symbol:'BTCUSDT',lastPrice:'100',quoteVolume:'100000000',count:500000,priceChangePercent:'2'},
    {symbol:'ETHUSDT',lastPrice:'50',quoteVolume:'40000000',count:250000,priceChangePercent:'5'},
    {symbol:'LOWUSDT',lastPrice:'2',quoteVolume:'100',count:10,priceChangePercent:'50'}
  ];
}

function makeRest({wideSpread=false}={}) {
  const calls=[];
  let active=0,maxActive=0;
  const rest = {
    calls,
    get maxActive(){return maxActive;},
    request:async(path)=>{
      calls.push({type:'request',path});
      if(path==='/api/v3/exchangeInfo') return {data:exchangeInfo(),source:'TEST'};
      if(path==='/api/v3/ticker/24hr') return {data:tickers(),source:'TEST'};
      throw new Error('UNEXPECTED_PATH');
    },
    klines:async(symbol,tf)=>{
      calls.push({type:'klines',symbol,tf});
      active++;maxActive=Math.max(maxActive,active);
      try{
        await new Promise(r=>setTimeout(r,5));
        return {source:'TEST',receivedAt:Date.now(),candles:series(tf)};
      } finally {active--;}
    },
    depth:async(symbol)=>{
      calls.push({type:'depth',symbol});
      return {source:'TEST',data:{
        bids:[['100',wideSpread?'10':'10000']],
        asks:[[wideSpread?'100.5':'100.01',wideSpread?'10':'10000']]
      }};
    }
  };
  return rest;
}

const evaluator = () => ({
  signal:{risk_reasons:[]},
  strategies:{
    trend:{strategy:'MTF_TREND',state:'CANDIDATE',direction:'LONG',score:{trendScore:72},reasonCodes:['TREND_OK'],evidence:{alignment:90}},
    breakout:{strategy:'CONFIRMED_BREAKOUT',state:'REJECTED',direction:'NONE',score:{},reasonCodes:['BREAKOUT_NOT_MET'],evidence:{}},
    meanReversion:{strategy:'MEAN_REVERSION',state:'REJECTED',direction:'NONE',score:{},reasonCodes:['MR_NOT_MET'],evidence:{}}
  }
});

test('exchangeInfo filters Spot + TRADING + USDT and rejects invalid symbols',()=>{
  const rows=buildSpotUniverse(exchangeInfo(),'USDT');
  assert.deepEqual(rows.map(x=>x.symbol),['BTCUSDT','ETHUSDT','LOWUSDT']);
});

test('ticker ranking prioritizes liquid rows and enforces minimum volume',()=>{
  const symbols=buildSpotUniverse(exchangeInfo(),'USDT');
  const rows=rankTickerRows(tickers(),symbols,{minQuoteVolume24h:750000,limit:2});
  assert.deepEqual(rows.map(x=>x.symbol),['BTCUSDT','ETHUSDT']);
});

test('limit normalization is bounded',()=>{
  assert.equal(normalizeRadarLimit(undefined),20);
  assert.equal(normalizeRadarLimit(999),50);
  assert.equal(normalizeRadarLimit(0),1);
});

test('boundedMap never exceeds requested concurrency',async()=>{
  let active=0,max=0;
  await boundedMap([1,2,3,4,5,6],2,async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));active--;});
  assert.equal(max,2);
});

test('market scanner deduplicates symbols and only deep-scans selected rows',async()=>{
  const rest=makeRest();
  const scanner=new MarketUniverseScanner({rest,config:{minQuoteVolume24h:750000,scanLimit:2,returnLimit:2,deepConcurrency:2},strategyEvaluator:evaluator});
  const result=await scanner.scan({quote:'USDT',limit:2});
  assert.equal(result.universe.scanned,2);
  const deepPairs=new Set(rest.calls.filter(x=>x.type==='klines').map(x=>x.symbol));
  assert.deepEqual([...deepPairs].sort(),['BTCUSDT','ETHUSDT']);
  assert.equal(rest.calls.filter(x=>x.type==='request'&&x.path==='/api/v3/ticker/24hr').length,1);
  assert.equal(rest.calls.filter(x=>x.type==='request'&&x.path==='/api/v3/exchangeInfo').length,1);
  assert.equal(rest.calls.filter(x=>x.type==='depth').length,2);
  assert.ok(rest.maxActive >= 3, 'timeframes should be fetched concurrently per symbol');
});

test('open candle is excluded from strategy analysis',async()=>{
  const rest=makeRest();
  const original=rest.klines;
  rest.klines=async(symbol,tf)=>{
    const out=await original(symbol,tf);
    const step=tf==='4h'?14_400_000:tf==='1h'?3_600_000:900_000;
    const now=Date.now();
    out.candles.push({...out.candles.at(-1),openTime:now-1000,closeTime:now+step-1,closed:false});
    return out;
  };
  let observed=null;
  const scanner=new MarketUniverseScanner({
    rest,
    config:{minQuoteVolume24h:750000,scanLimit:1,returnLimit:1,deepConcurrency:1},
    strategyEvaluator:({series15m})=>{observed=series15m;return evaluator();},
  });
  const result=await scanner.scan({quote:'USDT',limit:1});
  const candidate=result.candidates[0];
  assert.equal(candidate.data_status.closed_candle_only,true);
  assert.equal(candidate.data_status.analysis_candle.closed,true);
  assert.equal(candidate.data_status.analysis_candle.timeframe,'15m');
  assert.equal(candidate.data_status.excluded_open_candle_count,1);
  assert.equal(observed.some(c=>c.closed!==true),false);
  assert.ok(Number(candidate.data_status.analysis_candle.close_time)<=Date.now());
});

test('missing ticker prevents symbol from being deep-scanned',async()=>{
  const rest=makeRest();
  rest.request=async(path)=>{
    rest.calls.push({type:'request',path});
    if(path==='/api/v3/exchangeInfo') return {data:exchangeInfo(),source:'TEST'};
    if(path==='/api/v3/ticker/24hr') return {data:tickers().filter(x=>x.symbol!=='ETHUSDT'),source:'TEST'};
    throw new Error('UNEXPECTED_PATH');
  };
  const scanner=new MarketUniverseScanner({rest,config:{minQuoteVolume24h:750000,scanLimit:2,returnLimit:2},strategyEvaluator:evaluator});
  const result=await scanner.scan({quote:'USDT',limit:2});
  assert.deepEqual(result.candidates.map(x=>x.symbol),['BTCUSDT']);
  assert.equal(rest.calls.some(x=>x.type==='klines'&&x.symbol==='ETHUSDT'),false);
});

test('wide spread fails liquidity gate and never produces a scored candidate',async()=>{
  const rest=makeRest({wideSpread:true});
  const scanner=new MarketUniverseScanner({rest,config:{minQuoteVolume24h:750000,scanLimit:1,returnLimit:1,minLiquidityQuality:60},strategyEvaluator:evaluator});
  const result=await scanner.scan({quote:'USDT',limit:1});
  assert.equal(result.candidates.length,1);
  assert.equal(result.candidates[0].liquidity_quality<60,true);
  assert.equal(result.candidates[0].overall_score,null);
  assert.equal(result.candidates[0].signal_state,'INSUFFICIENT_DATA');
});

test('timeout is retried with backoff and still returns fresh data',async()=>{
  const rest=makeRest();
  const original=rest.klines;
  let failed=false;
  rest.klines=async(symbol,tf)=>{
    if(symbol==='BTCUSDT'&&tf==='4h'&&!failed){failed=true;throw new Error('TIMEOUT');}
    return original(symbol,tf);
  };
  const scanner=new MarketUniverseScanner({rest,config:{minQuoteVolume24h:750000,scanLimit:1,returnLimit:1,retryAttempts:1,retryBaseMs:1},sleepFn:async()=>{},strategyEvaluator:evaluator});
  const result=await scanner.scan({quote:'USDT',limit:1});
  assert.equal(result.candidates[0].data_status.data_valid,true);
  assert.equal(failed,true);
  assert.ok(rest.calls.filter(x=>x.type==='klines'&&x.symbol==='BTCUSDT'&&x.tf==='4h').length>=1);
});

test('Binance failure does not fabricate market data',async()=>{
  const rest=makeRest();
  rest.request=async(path)=>{
    rest.calls.push({type:'request',path});
    throw new Error('BINANCE_UNAVAILABLE');
  };
  await assert.rejects(()=>new MarketUniverseScanner({rest}).scan({quote:'USDT',limit:1}),/BINANCE_UNAVAILABLE/);
});

test('stale candles are rejected as non-live and have no overall score',async()=>{
  const rest=makeRest();
  rest.klines=async(symbol,tf)=>({source:'TEST',receivedAt:Date.now(),candles:series(tf,250,4*60*60*1000)});
  const scanner=new MarketUniverseScanner({rest,config:{minQuoteVolume24h:750000,scanLimit:1,returnLimit:1,maxTriggerAgeMs:30*60*1000},strategyEvaluator:evaluator});
  const result=await scanner.scan({quote:'USDT',limit:1});
  assert.equal(result.candidates[0].data_status.data_stale,true);
  assert.equal(result.candidates[0].overall_score,null);
  assert.equal(result.candidates[0].signal_state,'INSUFFICIENT_DATA');
  assert.equal(result.meta.live,false);
});

test('candidate contract preserves paper-only policy and evidence',async()=>{
  const rest=makeRest();
  const scanner=new MarketUniverseScanner({rest,config:{minQuoteVolume24h:750000,scanLimit:1,returnLimit:1},strategyEvaluator:evaluator});
  const result=await scanner.scan({quote:'USDT',limit:1});
  const c=result.candidates[0];
  assert.equal(c.paper_trading,true);
  assert.equal(c.real_order_execution,false);
  assert.equal(result.meta.confidence_score,'UNKNOWN');
  assert.ok(c.evidence.length>0);
  assert.ok(c.reason_codes.length>0);
  assert.ok(c.invalidation.length>0);
  assert.equal(c.data_status.data_valid,true);
  assert.equal(result.meta.live,true);
});

test('scanner exposes no execution fields and uses no synthetic fallback values',()=>{
  const scanner = new MarketUniverseScanner({rest:makeRest()});
  const source = String(scanner.scan);
  assert.doesNotMatch(source,/createOrder|placeOrder|withdraw/i);
  assert.doesNotMatch(source,/mock|synthetic|fakePrice/i);
});


test('current open candle with future closeTime does not block live candidate quality',async()=>{
  const rest=makeRest();
  const now=Date.now();
  const original=rest.klines;
  rest.klines=async(symbol,tf)=>{
    const r=await original(symbol,tf);
    if(tf==='15m'){
      const step=900000;
      const previous=r.candles.at(-1);
      const open=previous.closeTime+1;
      r.candles=[...r.candles,{
        openTime:open,closeTime:open+step-1,open:100,high:102,low:99,close:101,volume:2500,
        quoteVolume:100000,tradeCount:1000,closed:false,source:'BINANCE_PUBLIC_REST',sourceTime:now
      }];
    }
    return r;
  };
  const scanner=new MarketUniverseScanner({rest,config:{minQuoteVolume24h:750000,scanLimit:1,returnLimit:1},strategyEvaluator:evaluator});
  const result=await scanner.scan({quote:'USDT',limit:1});
  const candidate=result.candidates[0];
  assert.equal(candidate.data_status.data_valid,true);
  assert.equal(candidate.data_status.data_stale,false);
  assert.equal(Number.isFinite(candidate.overall_score),true);
  assert.ok(candidate.overall_score>0);
  assert.equal(result.meta.live,true);
  assert.ok(!candidate.reason_codes.includes('FUTURE_DATA'));
});

test('genuinely future candle remains hard-blocked',async()=>{
  const rest=makeRest();
  const now=Date.now();
  const original=rest.klines;
  rest.klines=async(symbol,tf)=>{
    const r=await original(symbol,tf);
    if(tf==='15m')r.candles=[...r.candles.slice(0,-1),{
      openTime:now+900000,closeTime:now+1799999,open:100,high:101,low:99,close:100,volume:1000,
      quoteVolume:100000,tradeCount:1000,closed:false,source:'BINANCE_PUBLIC_REST',sourceTime:now
    }];
    return r;
  };
  const scanner=new MarketUniverseScanner({rest,config:{minQuoteVolume24h:750000,scanLimit:1,returnLimit:1},strategyEvaluator:evaluator});
  const result=await scanner.scan({quote:'USDT',limit:1});
  const candidate=result.candidates[0];
  assert.equal(candidate.data_status.data_valid,false);
  assert.equal(candidate.overall_score,null);
  assert.ok(candidate.reason_codes.includes('FUTURE_DATA'));
  assert.equal(result.meta.live,false);
});
