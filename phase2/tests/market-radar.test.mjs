/* Bottom Radar v2 regression coverage: live flow, squeeze, structure, whale heuristic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {MarketUniverseScanner, buildSpotUniverse, rankTickerRows, boundedMap, normalizeRadarLimit, normalizeTickerRow, buildBottomMarketContext} from '../market/universe-scanner.mjs';

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
    {symbol:'BTCUSDT',lastPrice:'100',highPrice:'112',lowPrice:'92',quoteVolume:'100000000',count:500000,priceChangePercent:'2'},
    {symbol:'ETHUSDT',lastPrice:'50',highPrice:'56',lowPrice:'44',quoteVolume:'40000000',count:250000,priceChangePercent:'5'},
    {symbol:'LOWUSDT',lastPrice:'2',highPrice:'3',lowPrice:'1',quoteVolume:'100',count:10,priceChangePercent:'50'}
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

test('ticker rows preserve 24h high and low for Bottom Radar',()=>{
  const row=normalizeTickerRow(tickers()[0],'USDT');
  assert.equal(row.highPrice24h,112);
  assert.equal(row.lowPrice24h,92);
});

test('Bottom Radar derives current price, last rise, range position and closed-candle algorithms',()=>{
  const now=2_000_000_000_000;
  const prices=[
    [100,101,97,98],[98,99,95,96],[96,98,94,97],
    [97,100,96,99],[99,103,98,102],[102,106,101,105],
    [105,104,100,101],[101,103,99,102],[102,107,100,106],
    [106,105,101,104]
  ];
  const candles=prices.map((p,i)=>({
    openTime:now-(prices.length-i)*900000,
    closeTime:now-(prices.length-i)*900000+899999,
    open:p[0],high:p[1],low:p[2],close:p[3],volume:1000+i*120,
    takerBuyBaseVolume:(1000+i*120)*(i%3===0?.42:i%3===1?.55:.64),
    tradeCount:100,closed:true
  }));
  const ctx=buildBottomMarketContext(
    {'15m':candles,'1h':candles.map((x,i)=>({...x,closeTime:x.closeTime,closed:true}))},
    {lastPrice:104,highPrice24h:110,lowPrice24h:92},
    now,
    {book:{
      bids:[['103.9','120'],['103.5','80'],['103','60']],
      asks:[['104.1','30'],['104.5','20'],['105','10']]
    },liquidity:{bid:103.9,ask:104.1,bidDepth:22000,askDepth:6000,totalDepth:28000}}
  );
  assert.equal(ctx.closed_candles_only,true);
  assert.equal(ctx.current_price,104);
  assert.equal(ctx.high_24h,110);
  assert.equal(ctx.low_24h,92);
  assert.ok(Number.isFinite(ctx.last_rise.high));
  assert.ok(Number.isFinite(ctx.last_rise.low));
  assert.ok(Number.isFinite(ctx.last_rise.rise_pct));
  assert.ok(Number.isFinite(ctx.last_rise.drawdown_from_high_pct));
  assert.ok(ctx.algorithms.rsi14);
  assert.ok(ctx.algorithms.stochastic14);
  assert.ok(ctx.algorithms.obv_accumulation);
  assert.ok(ctx.algorithms.volume_price_divergence);
  assert.ok(ctx.algorithms.ema20_50_reclaim);
  assert.ok(ctx.algorithms.wyckoff_spring);
  assert.ok(ctx.algorithms.vwap_position);
  assert.ok(ctx.algorithms.price_structure);
  assert.ok(ctx.algorithms.taker_flow);
  assert.ok(ctx.algorithms.orderbook_pressure);
  assert.ok(ctx.algorithms.whale_pressure);
  assert.ok(ctx.algorithms.sell_exhaustion);
  assert.ok(ctx.algorithms.squeeze);
  assert.ok(ctx.algorithms.momentum_awaken);
  assert.ok(ctx.algorithms.mtf_alignment);
  assert.ok(ctx.metrics);
  assert.equal(ctx.closed_candles_only,true);
  assert.ok(Number.isFinite(ctx.metrics.buying_pressure));
  assert.ok(Number.isFinite(ctx.metrics.selling_exhaustion));
  assert.ok(Number.isFinite(ctx.metrics.compression));
  assert.ok(Number.isFinite(ctx.metrics.momentum));
  assert.ok(Number.isFinite(ctx.metrics.structure));
  assert.ok(Number.isFinite(ctx.metrics.whale_pressure));
  assert.ok(Number.isFinite(ctx.metrics.orderbook_imbalance));
  assert.ok(Number.isFinite(ctx.metrics.mtf_alignment));
  assert.equal(Math.round(ctx.range_position_pct),67);
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

test('Bottom Radar range position and flow metrics are symbol-specific and bounded',()=>{
  const now=2_000_000_000_000;
  const a=Array.from({length:60},(_,i)=>({
    openTime:now-(60-i)*900000,closeTime:now-(60-i)*900000+899999,
    open:100+i%2,high:102+i%3,low:98-i%2,close:100+i*.02,
    volume:1000+i*10,takerBuyBaseVolume:i%5===0?200:700,tradeCount:50,closed:true
  }));
  const b=a.map((x,i)=>({...x,open:x.open+2,high:x.high+5,low:x.low+1,close:x.close+4,
    takerBuyBaseVolume:i%2?900:300}));
  const ca=buildBottomMarketContext(
    {'15m':a,'1h':a,'4h':a},
    {lastPrice:101,highPrice24h:110,lowPrice24h:90},now,
    {book:{bids:[['100.9','200']],asks:[['101.1','100']]},liquidity:{bid:100.9,ask:101.1}}
  );
  const cb=buildBottomMarketContext(
    {'15m':b,'1h':b,'4h':b},
    {lastPrice:105,highPrice24h:110,lowPrice24h:90},now,
    {book:{bids:[['104.9','50']],asks:[['105.1','300']]},liquidity:{bid:104.9,ask:105.1}}
  );
  for(const ctx of [ca,cb]){
    for(const key of ['buying_pressure','selling_exhaustion','compression','momentum','structure','whale_pressure','orderbook_imbalance']){
      assert.ok(Number.isFinite(ctx.metrics[key]),key);
      assert.ok(ctx.metrics[key]>=0&&ctx.metrics[key]<=100,key);
    }
    assert.ok(ctx.metrics.taker_buy_ratio>=0&&ctx.metrics.taker_buy_ratio<=1);
    assert.ok(ctx.range_position_pct>=0&&ctx.range_position_pct<=100);
  }
  assert.notEqual(ca.metrics.buying_pressure,cb.metrics.buying_pressure);
  assert.notEqual(ca.metrics.whale_pressure,cb.metrics.whale_pressure);
});

test('Pre-Move Radar detects quiet early acceleration instead of chasing large 24h movers',()=>{
  const now=Date.UTC(2026,9,2,7,30);
  const step=15*60*1000;
  const start=Date.UTC(2026,9,2,1,0);
  const make=(base,boost)=>Array.from({length:28},(_,i)=>{
    const t=start+i*step;
    const p=base+i*(i<20?.01:.18)+boost*(i>22?i-22:0);
    return {openTime:t,closeTime:t+step-1,open:p-.03,high:p+.05,low:p-.05,close:p,volume:i<22?900:i%2?1700:2200,takerBuyBaseVolume:i<22?430:(i%2?1250:1600),closed:true};
  });
  const a=make(100,0.0);
  const b=make(100,0.0).map((x,i)=>({...x,close:x.close+(i<22?2.5:2.5),open:x.open+2.5,high:x.high+2.5,low:x.low+2.5,volume:i<22?800:(i%2?2400:2800),takerBuyBaseVolume:i<22?380:(i%2?1750:2200)}));
  const btc=make(100,0);
  const lowChange={symbol:'CALMUSDT',lastPrice:103,priceChangePercent:3,quoteVolume:9000000,count:80000,highPrice:106,lowPrice:95};
  const hotChange={symbol:'HOTUSDT',lastPrice:125,priceChangePercent:25,quoteVolume:9000000,count:90000,highPrice:130,lowPrice:90};
  const discovery=rankPreMoveTickerRows([lowChange,hotChange],[
    {symbol:'CALMUSDT',quoteAsset:'USDT',baseAsset:'CALM',status:'TRADING'},
    {symbol:'HOTUSDT',quoteAsset:'USDT',baseAsset:'HOT',status:'TRADING'}
  ],{limit:2,minQuoteVolume24h:750000});
  assert.equal(discovery[0].symbol,'CALMUSDT');
  const bottom={
    metrics:{compression:75,structure:74,buying_pressure:73,whale_pressure:76},
    last_rise:{high:106}
  };
  const ctx=buildPreMoveContext({'15m':b},lowChange,now,bottom);
  assert.ok(Number.isFinite(ctx.score));
  assert.ok(Number.isFinite(ctx.volume_acceleration));
  assert.ok(Number.isFinite(ctx.taker_buy_acceleration));
  assert.equal(ctx.closed_candles_only,true);
  assert.equal(ctx.timezone,'Asia/Aden');
  assert.ok(ctx.session_return_pct<=6);
  assert.ok(ctx.reasons.includes('NOT_EXTENDED'));
  assert.ok(ctx.components.acceleration>=50);
});
