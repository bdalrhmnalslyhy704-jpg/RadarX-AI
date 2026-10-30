/* Bottom Radar v2 regression coverage: live flow, squeeze, structure, whale heuristic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {MarketUniverseScanner, PRE_MOVE_MAX_CONCURRENT_DEEP_SCANS, buildSpotUniverse, rankTickerRows, rankBottomTickerRows, boundedMap, normalizeRadarLimit, normalizeTickerRow, buildBottomMarketContext, buildPreMoveContext, rankPreMoveTickerRows, buildPreMoveTickerActivitySignals, buildPreMoveWatchCandidates, aggregateClosed15mIntoHourly, buildPreMoveTargetPlan, scorePreMoveComponents} from '../market/universe-scanner.mjs';

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
function series(tf, count=250, lastAgeMs=60_000, nowMs=Date.now()) {
  const step = tf==='4h' ? 14_400_000 : tf==='1h' ? 3_600_000 : 900_000;
  const lastOpen = Math.floor((nowMs - lastAgeMs - step) / step) * step;
  return Array.from({length:count},(_,i)=>candle(lastOpen-(count-1-i)*step,100+i*0.05,step));
}

function stablePreMoveTestTime(nowMs=Date.now()) {
  // These tests depend on the Asia/Aden 04:00 session boundary. Pin scans to
  // 08:00 local on the current Aden calendar date so CI does not fail at 04:00
  // before enough closed 15m candles have formed for live evidence.
  const parts=new Intl.DateTimeFormat('en-CA',{
    timeZone:'Asia/Aden',year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(new Date(nowMs));
  const value=Object.fromEntries(parts.filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  const sessionReady=new Date(`${value.year}-${value.month}-${value.day}T08:00:00+03:00`).getTime();
  return Math.max(nowMs,sessionReady);
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

function makeRest({wideSpread=false,clock=()=>Date.now()}={}) {
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
        return {source:'TEST',receivedAt:clock(),candles:series(tf,250,60_000,clock())};
      } finally {active--;}
    },
    depth:async(symbol,limit)=>{
      calls.push({type:'depth',symbol,limit});
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

test('Pre-Move discovery promotes accelerating ticker volume and trades before candle confirmation',()=>{
  const symbols=[
    {symbol:'ABASEUSDT',baseAsset:'ABASE',quoteAsset:'USDT',status:'TRADING'},
    {symbol:'ZFASTUSDT',baseAsset:'ZFAST',quoteAsset:'USDT',status:'TRADING'}
  ];
  const baseline={
    version:1,
    snapshots:[
      {captured_at:120000,rows:{
        ABASEUSDT:{quote_volume_24h:4900000,trade_count_24h:490000},
        ZFASTUSDT:{quote_volume_24h:1100000,trade_count_24h:110000}
      }},
      {captured_at:60000,rows:{
        ABASEUSDT:{quote_volume_24h:4800000,trade_count_24h:480000},
        ZFASTUSDT:{quote_volume_24h:1000000,trade_count_24h:100000}
      }}
    ]
  };
  const current=[
    {symbol:'ABASEUSDT',lastPrice:'10',highPrice:'12',lowPrice:'8',quoteVolume:'5000000',count:500000,priceChangePercent:'1'},
    {symbol:'ZFASTUSDT',lastPrice:'10',highPrice:'12',lowPrice:'8',quoteVolume:'1500000',count:150000,priceChangePercent:'1'}
  ].map(x=>normalizeTickerRow(x,'USDT'));
  const signals=buildPreMoveTickerActivitySignals(current,baseline,180000);
  assert.equal(signals.has('ABASEUSDT'),false,'steady high-volume pair should not receive an acceleration boost');
  assert.ok(signals.get('ZFASTUSDT')?.score>=10,'rapidly accelerating volume and trades should be prioritized');
  assert.ok(signals.get('ZFASTUSDT')?.volume_acceleration_ratio>=3);
  assert.ok(signals.get('ZFASTUSDT')?.trade_acceleration_ratio>=3);

  const raw=current.map(x=>({
    symbol:x.symbol,lastPrice:String(x.lastPrice),highPrice:String(x.highPrice24h),lowPrice:String(x.lowPrice24h),
    quoteVolume:String(x.quoteVolume24h),count:x.tradeCount24h,priceChangePercent:String(x.priceChange24h)
  }));
  const ordinary=rankPreMoveTickerRows(raw,symbols,{minQuoteVolume24h:750000,limit:2});
  const accelerated=rankPreMoveTickerRows(raw,symbols,{minQuoteVolume24h:750000,limit:2,activitySignals:signals});
  assert.equal(ordinary[0].symbol,'ABASEUSDT','ordinary liquidity ranking should prefer the larger steady pair');
  assert.equal(accelerated[0].symbol,'ZFASTUSDT','market-wide activity acceleration should promote the early mover');
  assert.ok(accelerated[0].pre_move_activity_score>=10);
});

test('Pre-Move ticker activity acceleration ignores absent, stale, or future baselines',()=>{
  const current=[normalizeTickerRow({symbol:'FASTUSDT',lastPrice:'10',highPrice:'12',lowPrice:'8',quoteVolume:'1500000',count:150000,priceChangePercent:'1'},'USDT')];
  const good={
    version:1,
    snapshots:[
      {captured_at:120000,rows:{FASTUSDT:{quote_volume_24h:1100000,trade_count_24h:110000}}},
      {captured_at:60000,rows:{FASTUSDT:{quote_volume_24h:1000000,trade_count_24h:100000}}}
    ]
  };
  assert.equal(buildPreMoveTickerActivitySignals(current,null,180000).size,0);
  assert.equal(buildPreMoveTickerActivitySignals(current,good,600001).size,0,'stale samples must not influence discovery ranking');
  const future={version:1,snapshots:[{captured_at:200000,rows:{}},{captured_at:100000,rows:{}}]};
  assert.equal(buildPreMoveTickerActivitySignals(current,future,180000).size,0,'future baseline timestamps must fail closed');
});

test('Pre-Move discovery pins 20%, reserves activity-priority slots, and rotates the rest across the eligible market',()=>{
  const symbols=Array.from({length:80},(_,i)=>({
    symbol:'C'+String(i).padStart(3,'0')+'USDT',
    baseAsset:'C'+String(i).padStart(3,'0'),
    quoteAsset:'USDT',
    status:'TRADING'
  }));
  const rows=symbols.map((x,i)=>({
    symbol:x.symbol,lastPrice:'10',highPrice:'12',lowPrice:'8',
    quoteVolume:String(5_000_000+i*1000),count:50000+i*100,
    priceChangePercent:'4'
  }));
  const first=rankPreMoveTickerRows(rows,symbols,{minQuoteVolume24h:750000,limit:24,rotationOffset:0});
  const second=rankPreMoveTickerRows(rows,symbols,{minQuoteVolume24h:750000,limit:24,rotationOffset:16});
  assert.equal(first.length,24);
  assert.equal(second.length,24);
  assert.equal(new Set(first.map(x=>x.symbol)).size,24);
  assert.deepEqual(first.slice(0,5).map(x=>x.symbol),second.slice(0,5).map(x=>x.symbol),'the top 20% stays pinned for stable core coverage');
  assert.notDeepEqual(first.slice(5).map(x=>x.symbol),second.slice(5).map(x=>x.symbol),'the rotating lane must not scan the same static list forever');

  const third=rankPreMoveTickerRows(rows,symbols,{minQuoteVolume24h:750000,limit:24,rotationOffset:32});
  const union=new Set([...first,...second,...third].map(x=>x.symbol));
  assert.ok(union.size>=56,'three cycles should cover 56 unique pairs when no burst consumes a priority slot');
});

test('Pre-Move discovery pulls a measured ticker-activity burst ahead of the alphabetical rotation',()=>{
  const symbols=Array.from({length:80},(_,i)=>({
    symbol:'C'+String(i).padStart(3,'0')+'USDT',
    baseAsset:'C'+String(i).padStart(3,'0'),quoteAsset:'USDT',status:'TRADING'
  }));
  symbols.push({symbol:'ZFASTUSDT',baseAsset:'ZFAST',quoteAsset:'USDT',status:'TRADING'});
  const rows=symbols.map((x,i)=>({
    symbol:x.symbol,lastPrice:'10',highPrice:'12',lowPrice:'8',
    quoteVolume:String(x.symbol==='ZFASTUSDT'?180000:5_000_000+i*1000),
    count:x.symbol==='ZFASTUSDT'?1000:50000+i*100,
    priceChangePercent:'2'
  }));
  const activitySignals=new Map([['ZFASTUSDT',{
    score:15,volume_acceleration_ratio:3.5,trade_acceleration_ratio:2.2,
    observed_at:180000,baseline_age_ms:60000
  }]]);
  const picked=rankPreMoveTickerRows(rows,symbols,{
    minQuoteVolume24h:750000,limit:24,rotationOffset:0,activitySignals
  });
  assert.equal(picked.length,24);
  assert.equal(new Set(picked.map(x=>x.symbol)).size,24);
  assert.equal(picked[5].symbol,'ZFASTUSDT',
    'a measured volume/trade burst must be deep-scanned immediately after the pinned core');
  assert.equal(picked[5].pre_move_activity_score,15);
});

test('Pre-Move activity-priority lane deep-scans up to eight independent acceleration bursts',()=>{
  const symbols=Array.from({length:80},(_,i)=>({
    symbol:'C'+String(i).padStart(3,'0')+'USDT',
    baseAsset:'C'+String(i).padStart(3,'0'),quoteAsset:'USDT',status:'TRADING'
  }));
  const bursts=Array.from({length:10},(_,i)=>({
    symbol:'BURST'+String(i).padStart(2,'0')+'USDT',baseAsset:'BURST'+String(i).padStart(2,'0'),
    quoteAsset:'USDT',status:'TRADING'
  }));
  const allSymbols=[...symbols,...bursts];
  const rows=allSymbols.map((x,i)=>({
    symbol:x.symbol,lastPrice:'10',highPrice:'12',lowPrice:'8',
    quoteVolume:String(x.symbol.startsWith('BURST')?100000:5000000+i*1000),
    count:x.symbol.startsWith('BURST')?1000:50000+i*100,priceChangePercent:'2'
  }));
  const activitySignals=new Map(bursts.map((x,i)=>[x.symbol,{
    score:18-i*0.1,volume_acceleration_ratio:2.4-i*0.01,trade_acceleration_ratio:1.8-i*0.01,
    observed_at:180000,baseline_age_ms:60000
  }]));
  const picked=rankPreMoveTickerRows(rows,allSymbols,{
    minQuoteVolume24h:750000,limit:40,rotationOffset:0,activitySignals
  });
  assert.equal(picked.length,40);
  const priority=picked.filter(row=>row.ticker_activity_priority_selected===true);
  assert.equal(priority.length,8,'the bounded Pre-Move lane must reserve eight slots for measured activity bursts');
  assert.ok(picked.slice(4,12).every(row=>row.ticker_activity_priority_selected===true),
    'activity bursts must be examined directly after the stable pinned cohort');
  assert.equal(picked[12].ticker_activity_priority_selected,false,
    'the remaining slots must continue the fair rotating market scan');
});

test('Pre-Move rotation remains fair when non-pinned market scores change between cycles',()=>{
  const symbols=Array.from({length:80},(_,i)=>({
    symbol:'C'+String(i).padStart(3,'0')+'USDT',
    baseAsset:'C'+String(i).padStart(3,'0'),
    quoteAsset:'USDT',
    status:'TRADING'
  }));
  const rows=symbols.map((x,i)=>({
    symbol:x.symbol,lastPrice:'10',highPrice:'12',lowPrice:'8',
    quoteVolume:String(5_000_000+i*1000),count:50000+i*100,
    priceChangePercent:'4'
  }));
  const changed=rows.map((x,i)=>({
    ...x,
    count:i<68?String((68-i)*700+1):x.count,
    priceChangePercent:i<68?(i%2===0?'1.2':'7.8'):x.priceChangePercent
  }));
  const first=rankPreMoveTickerRows(rows,symbols,{limit:24,rotationOffset:0});
  const later=rankPreMoveTickerRows(changed,symbols,{limit:24,rotationOffset:0});
  assert.deepEqual(first.slice(0,5).map(x=>x.symbol),later.slice(0,5).map(x=>x.symbol),
    'the pinned 20% high-ranking cohort remains stable in this fixture');
  assert.deepEqual(first.slice(5).map(x=>x.symbol),later.slice(5).map(x=>x.symbol),
    'rotation must not be reshuffled by score changes among unpinned symbols');
  assert.equal(new Set(later.map(x=>x.symbol)).size,24);
});

test('Pre-Move discovery excludes stablecoin and tokenized-equity pairs while retaining BTC context',()=>{
  const symbols=[
    ['RLUSDUSDT','RLUSD'],['AAPLBUSDT','AAPLB'],['APPBUSDT','APPB'],['BSPBUSDT','BSPB'],
    ['GEVBUSDT','GEVB'],['SKDDBUSDT','SKDDB'],['SKUUBUSDT','SKUUB'],['SOXSBUSDT','SOXSB'],
    ['BTCUSDT','BTC'],['EARLYUSDT','EARLY'],['MIDUSDT','MID']
  ].map(([symbol,baseAsset])=>({symbol,baseAsset,quoteAsset:'USDT',status:'TRADING'}));
  const rows=symbols.map((x,i)=>({
    symbol:x.symbol,lastPrice:'10',highPrice:'12',lowPrice:'8',
    quoteVolume:String(5_000_000+i*1000),count:50000+i*100,priceChangePercent:'2'
  }));
  const picked=rankPreMoveTickerRows(rows,symbols,{minQuoteVolume24h:750000,limit:10,rotationOffset:0});
  const pickedSymbols=new Set(picked.map(x=>x.symbol));
  assert.equal(pickedSymbols.has('BTCUSDT'),true,'BTC remains available for market-relative context');
  assert.equal(pickedSymbols.has('EARLYUSDT'),true);
  assert.equal(pickedSymbols.has('MIDUSDT'),true);
  assert.equal(pickedSymbols.has('RLUSDUSDT'),false,'stablecoins must not consume deep-scan slots');
  assert.equal(pickedSymbols.has('AAPLBUSDT'),false,'tokenized equity pairs must not consume deep-scan slots');
  for(const symbol of ['APPBUSDT','BSPBUSDT','GEVBUSDT','SKDDBUSDT','SKUUBUSDT','SOXSBUSDT']){
    assert.equal(pickedSymbols.has(symbol),false,symbol+' is a tokenized bStocks instrument, not a crypto-altcoin candidate');
  }
});

test('Pre-Move discovery includes active low-volume Spot pairs for rotating screening',()=>{
  const symbols=[{symbol:'EARLYUSDT',baseAsset:'EARLY',quoteAsset:'USDT',status:'TRADING'}];
  const rows=[{symbol:'EARLYUSDT',lastPrice:'1.02',highPrice:'1.05',lowPrice:'0.95',quoteVolume:'18000',count:420,priceChangePercent:'1.6'}];
  const picked=rankPreMoveTickerRows(rows,symbols,{minQuoteVolume24h:750000,limit:1,rotationOffset:0});
  assert.equal(picked.length,1,'active symbols must not disappear from discovery merely because they are below the final alert volume floor');
  assert.equal(picked[0].symbol,'EARLYUSDT');
  assert.equal(picked[0].quoteVolume24h,18000);
});

test('Bottom Radar discovery prioritizes symbols near the 24h low while retaining liquidity',()=>{
  const symbols=buildSpotUniverse(exchangeInfo(),'USDT');
  const rows=rankBottomTickerRows([
    {symbol:'BTCUSDT',lastPrice:'93',highPrice:'100',lowPrice:'90',quoteVolume:'5000000',count:50000,priceChangePercent:'-4'},
    {symbol:'ETHUSDT',lastPrice:'55',highPrice:'80',lowPrice:'50',quoteVolume:'40000000',count:250000,priceChangePercent:'-2'},
    {symbol:'LOWUSDT',lastPrice:'2',highPrice:'3',lowPrice:'1',quoteVolume:'100',count:10,priceChangePercent:'-20'}
  ],symbols,{minQuoteVolume24h:750000,limit:2});
  assert.deepEqual(new Set(rows.map(x=>x.symbol)),new Set(['BTCUSDT','ETHUSDT']));
  assert.ok(rows[0].range_position_pct < 50);
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

test('dedicated Bottom Radar scan uses the optimized discovery path',async()=>{
  const rest=makeRest();
  const scanner=new MarketUniverseScanner({
    rest,
    config:{minQuoteVolume24h:750000,scanLimit:2,returnLimit:2,bottomDiscoveryPool:18,bottomDeepConcurrency:2,bottomDeepKlines:180},
    strategyEvaluator:evaluator
  });
  const result=await scanner.scanBottom({quote:'USDT',limit:2});
  assert.equal(result.meta.radar,'BOTTOM_REVERSAL');
  assert.equal(result.meta.paper_trading,true);
  assert.equal(result.meta.real_order_execution,false);
  assert.equal(result.universe.scanned,2);
  assert.equal(result.universe.deep_scan_cap,10);
  assert.equal(result.candidates.length,2);
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

test('concurrent identical market scans share one in-flight scan',async()=>{
  const rest=makeRest();
  const scanner=new MarketUniverseScanner({
    rest,
    config:{minQuoteVolume24h:750000,scanLimit:2,returnLimit:2,deepConcurrency:2},
    strategyEvaluator:evaluator
  });
  const [first,second]=await Promise.all([
    scanner.scan({quote:'USDT',limit:2}),
    scanner.scan({quote:'USDT',limit:2})
  ]);
  assert.deepEqual(second,first);
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
    return {openTime:t,closeTime:t+step-1,open:p-.03,high:p+.05,low:p-.05,close:p,volume:i<22?900:i%2?1700:2200,tradeCount:i<22?50:(i%2?65:70),takerBuyBaseVolume:i<22?430:(i%2?1250:1600),closed:true};
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
  assert.equal(ctx.evidence_complete,true,'a candidate with full recent flow, baseline and core microstructure metrics should have complete evidence');
  assert.equal(ctx.timezone,'Asia/Aden');
  assert.ok(ctx.session_return_pct<=6);
  assert.ok(ctx.reasons.includes('NOT_EXTENDED'));
  assert.ok(ctx.components.acceleration>=50);

  const flowLedBars=b.map((row,i)=>{
    const shift=3;
    const shifted={...row,open:Number(row.open)-shift,high:Number(row.high)-shift,
      low:Number(row.low)-shift,close:Number(row.close)-shift};
    return i>=22
      ?{...shifted,close:shifted.low+(shifted.high-shifted.low)*0.75}
      :shifted;
  });
  const expansionWithoutCompression=buildPreMoveContext({'15m':flowLedBars},lowChange,now,{
    last_rise:{high:106},
    metrics:{compression:4,structure:78,buying_pressure:90,whale_pressure:null}
  },{btcReturn:0.6});
  assert.equal(expansionWithoutCompression.flow_transition_confirmed,true);
  assert.equal(expansionWithoutCompression.price_window_valid,true);
  assert.equal(expansionWithoutCompression.structure_confirmed,false,
    'the ordinary compression-based structure gate must remain visible as false');
  assert.equal(expansionWithoutCompression.flow_led_expansion_confirmed,true,
    'exceptionally strong independent volume, trade and buy-flow evidence can qualify without compression');
  assert.equal(expansionWithoutCompression.structure_gate_passed,true);
  assert.ok(['READY','EARLY_WAKE'].includes(expansionWithoutCompression.stage),
    'the high-confidence flow-led path must surface before a move without claiming compression');
  const weakBuyerBars=flowLedBars.map((row,i)=>i>=22
    ?{...row,takerBuyBaseVolume:Number(row.volume)*0.25}
    :row);
  const weakBuyer=buildPreMoveContext({'15m':weakBuyerBars},lowChange,now,{
    last_rise:{high:106},
    metrics:{compression:4,structure:78,buying_pressure:90,whale_pressure:null}
  },{btcReturn:0.6});
  assert.equal(weakBuyer.flow_led_expansion_confirmed,false,
    'large volume alone must not bypass the buyer-flow gate');
  assert.equal(weakBuyer.structure_gate_passed,false);

  const lateCtx=buildPreMoveContext({'15m':b},{...lowChange,lastPrice:112},now,bottom);
  assert.equal(lateCtx.already_moved,true,'more than 9% since the Yemen morning-session start must be treated as extended');
  assert.equal(lateCtx.stage,'ALREADY_MOVED');

  const unflagged={...b.at(-1),openTime:now-900000,closeTime:now-100};
  delete unflagged.closed;
  const strictCtx=buildPreMoveContext({'15m':[...b,unflagged]},lowChange,now,bottom);
  const lastExplicitlyClosed=b.filter(x=>x.closeTime<=now).at(-1);
  assert.equal(strictCtx.session_close,lastExplicitlyClosed.closeTime,'a candle with no explicit closed=true flag must not enter session metrics');

  const missingCore=buildPreMoveContext({'15m':b},lowChange,now,{
    last_rise:{high:106},metrics:{compression:null,structure:null,buying_pressure:null,whale_pressure:null}
  });
  assert.equal(missingCore.evidence_complete,false,'missing indicators must not be silently treated as numeric zero');
  assert.ok(missingCore.missing_evidence.includes('compression'));
  assert.ok(missingCore.missing_evidence.includes('structure'));
  assert.ok(missingCore.missing_evidence.includes('buying_pressure'));
  assert.equal(missingCore.components.buying_pressure,null);
});


test('Pre-Move composite score uses only normalized 0-100 components, never raw flow ratios',()=>{
  const scores={
    calm:90,acceleration:80,relative_strength:70,low_reclaim:75,
    resistance_proximity:65,squeeze:70,structure:65,buying_pressure:70,whale_pressure:60
  };
  const base=scorePreMoveComponents(scores);
  const withRawMeasurements=scorePreMoveComponents({
    ...scores,
    volume_acceleration:1.8,trade_acceleration:2.1,taker_buy_ratio:0.62,
    taker_buy_acceleration:0.08,mean_close_location:0.72
  });
  const expected=Object.values(scores).reduce((sum,value)=>sum+value,0)/Object.values(scores).length;
  assert.ok(Math.abs(base-expected)<1e-9,'normalized score should equal the mean of normalized components');
  assert.equal(withRawMeasurements,base,'raw ratios must not dilute 0-100 score components');
  assert.ok(base>=70,'a strong group of normalized components should not collapse below 50 due to ratio units');
});

test('Pre-Move aggregates hourly evidence only from four complete aligned closed 15m candles',()=>{
  const hour=60*60*1000,step=15*60*1000;
  const start=Math.floor((Date.now()-12*hour)/hour)*hour;
  const candles=Array.from({length:16},(_,i)=>candle(start+i*step,100+i*0.25,step));
  const hourly=aggregateClosed15mIntoHourly(candles,Date.now());
  assert.equal(hourly.length,4);
  assert.equal(hourly[0].openTime,start);
  assert.equal(hourly[0].closeTime,start+hour-1);
  assert.equal(hourly[0].open,candles[0].open);
  assert.equal(hourly[0].close,candles[3].close);
  assert.equal(hourly[0].constituent_candles,4);
  assert.equal(hourly[0].source,'BINANCE_PUBLIC_REST_AGGREGATED_15M');
  const gap=candles.filter((_,i)=>i!==5);
  assert.equal(aggregateClosed15mIntoHourly(gap,Date.now()).length,3,'a 15m gap discards the containing hour rather than interpolating it');
  const partial=candles.map((x,i)=>i===15?{...x,closed:false}:x);
  assert.equal(aggregateClosed15mIntoHourly(partial,Date.now()).length,3,'an incomplete 15m candle must not complete an hourly bar');
});

test('Pre-Move target plan exposes ATR risk, invalidation and bounded targets without promising a rise',()=>{
  const step=15*60*1000;
  const start=Math.floor((Date.now()-100*step)/step)*step;
  const candles=Array.from({length:80},(_,i)=>{
    const close=100+i*0.035+Math.sin(i/3)*0.14;
    return {
      openTime:start+i*step,closeTime:start+(i+1)*step-1,
      open:close-0.025,high:close+0.12+Math.sin(i)*0.015,
      low:close-0.13,close,volume:1000+i*8,quoteVolume:100000+i*800,
      tradeCount:600+i*4,takerBuyBaseVolume:550+i*4,
      takerBuyQuoteVolume:55000+i*400,closed:true,sourceTime:Date.now()
    };
  });
  const plan=buildPreMoveTargetPlan(candles,{lastPrice:102.1,highPrice24h:104.8},Date.now());
  assert.equal(plan.method,'ATR_15M_RISK_REWARD_V2');
  assert.equal(plan.valid,true);
  assert.ok(plan.invalidation_price>0&&plan.invalidation_price<plan.reference_price);
  assert.ok(plan.target_2_price>plan.reference_price);
  assert.ok(plan.target_1_price===null||plan.target_1_price>plan.reference_price);
  assert.ok(Number.isFinite(plan.risk_pct));
  assert.equal(plan.price_basis,'LAST_TICKER_PRICE_AT_SCAN');
  assert.equal(plan.closed_candles_only,true);
  assert.equal(plan.paper_only,true);
  assert.equal(plan.not_guaranteed,true);

  // When resistance is less than 1R above entry, target 1 must be an explicitly
  // conditional projection beyond resistance rather than a target below entry.
  const nearEntry=candles.at(-1).close+0.1;
  const nearResistancePlan=buildPreMoveTargetPlan(
    candles,
    {lastPrice:nearEntry,highPrice24h:nearEntry+0.2},
    Date.now()
  );
  assert.equal(nearResistancePlan.target_1_requires_resistance_breakout,true);
  assert.ok(nearResistancePlan.target_1_price>nearResistancePlan.reference_price);
  assert.ok(nearResistancePlan.target_1_price>nearResistancePlan.resistance_price);
  assert.ok(nearResistancePlan.target_1_rr>=1);
  assert.ok(nearResistancePlan.target_2_price>nearResistancePlan.target_1_price);
  assert.ok(nearResistancePlan.target_2_rr>=1.5);
  assert.equal(nearResistancePlan.reward_risk_ok,true);
});

// PRE_MOVE_RADAR_CI_TRIGGER


test('Pre-Move deep scan keeps a low-volume symbol non-actionable and records the reason',async()=>{
  const rest=makeRest();
  const scanner=new MarketUniverseScanner({
    rest,
    config:{minQuoteVolume24h:750000,minDataQuality:70,minLiquidityQuality:60,deepKlines:160},
    strategyEvaluator:evaluator
  });
  const result=await scanner.scanPreMoveSymbol({
    symbol:'BTCUSDT',lastPrice:100,priceChange24h:1,highPrice24h:102,lowPrice24h:98,
    quoteVolume24h:18000,tradeCount24h:420,quoteAsset:'USDT'
  },1,{});
  assert.equal(result.data_status.volume_gate_pass,false);
  assert.equal(rest.calls.find(call=>call.type==='depth')?.limit,20,
    'the broad Pre-Move pass should fetch only the 20 closest book levels, sufficient for near-spread liquidity checks');
  assert.equal(result.data_status.data_valid,false,'broad discovery must not weaken the minimum-volume gate for alert-eligible results');
  assert.ok(result.reason_codes.includes('BELOW_MIN_QUOTE_VOLUME'));
});

test('Pre-Move default watch floor surfaces a qualified partial setup without making it actionable',()=>{
  const nearMiss={
    symbol:'TRXUSDT',last_price:0.34,price_change_24h:0.579,quote_volume_24h:23_223_167,
    liquidity_quality:96.21,data_quality:100,risk_flags:[],
    data_status:{candle_data_valid:true,data_stale:false,data_valid:true,volume_gate_pass:true,last_error:null},
    pre_move_context:{
      score:48.5,evidence_complete:true,closed_candles_only:true,session_return_pct:0.4259,
      one_hour_return_pct:0.1516,volume_acceleration:1.1586,trade_acceleration:0.7319,
      taker_buy_ratio:0.7872,taker_buy_acceleration:0.4877,mean_close_location:0.75,
      components:{squeeze:45.2,structure:72.4,buying_pressure:100},
      flow_transition_confirmed:false,price_window_valid:true,structure_confirmed:false,
      already_moved:false,stage:'NO_SETUP',reasons:[]
    }
  };
  // No custom minScore: exercises the production default watch floor.
  const rows=buildPreMoveWatchCandidates([nearMiss]);
  assert.equal(rows.length,1,'qualified early observations below the strict score threshold should remain visible for review');
  assert.equal(rows[0].watch_only,true);
  assert.equal(rows[0].alert_eligible,false);
  assert.equal(rows[0].pre_move_context.stage,'WATCH_EARLY');
  assert.equal(rows[0].pre_move_context.actionable,false);
  assert.ok(rows[0].watch_reason_codes.includes('TRADE_ACCELERATION_NOT_CONFIRMED'));
  assert.ok(rows[0].watch_reason_codes.includes('COMPRESSION_NOT_CONFIRMED'));
  assert.ok(rows[0].watch_reason_codes.includes('SCORE_BELOW_ACTIONABLE_THRESHOLD'));
});

test('HYPE-like compressed buyer absorption is surfaced before the breakout as monitor-only',()=>{
  const candidate={
    symbol:'HYPEUSDT',last_price:79.39,price_change_24h:-3.723,quote_volume_24h:125_370_000,
    liquidity_quality:96,data_quality:100,risk_flags:[],
    data_status:{candle_data_valid:true,data_stale:false,stale:false,data_valid:true,volume_gate_pass:true,last_error:null},
    pre_move_context:{
      stage:'NO_SETUP',score:72.6,evidence_complete:true,closed_candles_only:true,
      session_return_pct:-0.9482,one_hour_return_pct:0.2526,
      volume_acceleration:0.267,trade_acceleration:0.5407,
      taker_buy_ratio:0.6822,taker_buy_acceleration:0.1231,mean_close_location:0.5575,
      relative_strength_vs_market_pct:0.1599,relative_strength_vs_btc_pct:0.1599,
      components:{squeeze:48.68,structure:60.68,buying_pressure:99.83},
      flow_transition_confirmed:false,price_window_valid:false,structure_confirmed:false,
      already_moved:false,reasons:['TAKER_BUY_ACCELERATING','BUYERS_HOLDING_CANDLE_CLOSES']
    }
  };
  const rows=buildPreMoveWatchCandidates([candidate]);
  assert.equal(rows.length,1,'compressed buyer absorption must reach watch evaluation without 1.12x volume acceleration');
  assert.equal(rows[0].symbol,'HYPEUSDT');
  assert.equal(rows[0].pre_move_context.original_stage,'NO_SETUP');
  assert.equal(rows[0].pre_move_context.stage,'WATCH_EARLY');
  assert.equal(rows[0].pre_move_context.compressed_buyer_absorption_monitor_only,true);
  assert.equal(rows[0].pre_move_context.compressed_buyer_absorption_checks,7);
  assert.ok(rows[0].watch_reason_codes.includes('COMPRESSED_BUYER_ABSORPTION_MONITOR_ONLY'));
  assert.equal(rows[0].watch_only,true);
  assert.equal(rows[0].alert_eligible,false);
  assert.equal(rows[0].pre_move_context.actionable,false);

  const weak={
    ...candidate,pre_move_context:{
      ...candidate.pre_move_context,
      components:{...candidate.pre_move_context.components,buying_pressure:72}
    }
  };
  const weakRow=buildPreMoveWatchCandidates([weak])[0];
  assert.ok(weakRow,'weak-absorption candidate may remain a generic watch');
  assert.notEqual(weakRow.pre_move_context.compressed_buyer_absorption_monitor_only,true,
    'a weaker buyer-pressure score must not receive the special tier');
});

test('Pre-Move surfaces partial early-flow candidates with slightly negative one-hour return as watch-only',()=>{
  const partial={
    symbol:'SOXLBUSDT',last_price:100,price_change_24h:1.995,quote_volume_24h:42_209_579,
    liquidity_quality:98.52,data_quality:100,risk_flags:[],
    data_status:{candle_data_valid:true,data_stale:false,data_valid:true,volume_gate_pass:true,last_error:null},
    pre_move_context:{
      score:45.7,evidence_complete:true,closed_candles_only:true,session_return_pct:0.3928,
      one_hour_return_pct:-0.4856,volume_acceleration:0.4582,trade_acceleration:0.4087,
      taker_buy_ratio:0.8175,taker_buy_acceleration:0.1179,mean_close_location:0.5542,
      components:{squeeze:57.89,structure:58.45,buying_pressure:100},
      flow_transition_confirmed:false,price_window_valid:false,structure_confirmed:false,
      already_moved:false,stage:'NO_SETUP',reasons:[]
    }
  };
  const rows=buildPreMoveWatchCandidates([partial]);
  assert.equal(rows.length,1,'partial, fresh, non-extended flow should be surfaced for visual monitoring');
  assert.equal(rows[0].watch_only,true);
  assert.equal(rows[0].alert_eligible,false);
  assert.equal(rows[0].pre_move_context.stage,'WATCH_EARLY');
  assert.equal(rows[0].pre_move_context.actionable,false);
  assert.ok(rows[0].watch_reason_codes.includes('VOLUME_ACCELERATION_NOT_CONFIRMED'));
  assert.ok(rows[0].watch_reason_codes.includes('TRADE_ACCELERATION_NOT_CONFIRMED'));
});

test('Pre-Move watch builder admits a fresh ticker-activity burst only through the separate monitor-only lane',()=>{
  const base={
    symbol:'CFGUSDT',last_price:1.01,price_change_24h:.59,quote_volume_24h:5_000_000,
    liquidity_quality:85,data_quality:100,ticker_activity:{
      score:14,volume_delta_per_minute:1200,trade_delta_per_minute:65,
      volume_acceleration_ratio:2.4,trade_acceleration_ratio:1.7,
      observed_at:Date.now()-45_000,baseline_age_ms:90_000
    },
    data_status:{candle_data_valid:true,data_stale:false,data_valid:true,volume_gate_pass:true,last_error:null},
    risk_flags:[],
    pre_move_context:{
      stage:'NO_SETUP',score:77.5,evidence_complete:true,closed_candles_only:true,
      already_moved:false,session_return_pct:.59,one_hour_return_pct:0,
      volume_acceleration:1.05,trade_acceleration:.92,taker_buy_ratio:.52,taker_buy_acceleration:.084,
      mean_close_location:.48,relative_strength_vs_market_pct:1.32,
      components:{squeeze:45,structure:55,buying_pressure:54},
      flow_transition_confirmed:false,price_window_valid:false,structure_confirmed:false,
      reasons:['VOLUME_ACCELERATING']
    }
  };
  const rows=buildPreMoveWatchCandidates([base]);
  assert.equal(rows.length,1,'strong current market-activity data can enter the early-watch lane');
  assert.equal(rows[0].watch_only,true);
  assert.equal(rows[0].alert_eligible,false);
  assert.equal(rows[0].pre_move_context.stage,'WATCH_EARLY');
  assert.equal(rows[0].pre_move_context.ticker_activity_monitor_only,true);
  assert.ok(rows[0].watch_reason_codes.includes('TICKER_ACTIVITY_ACCELERATION_MONITOR_ONLY'));
  assert.equal(rows[0].pre_move_context.actionable,false);

  const weak=buildPreMoveWatchCandidates([{...base,ticker_activity:{...base.ticker_activity,score:6}}]);
  assert.equal(weak.length,0,'weak acceleration must not bypass candle confirmation');
});

test('Pre-Move near misses are surfaced as watch-only rows but never promoted to actionable signals',()=>{
  const base={
    symbol:'EARLYUSDT',last_price:1.01,price_change_24h:1.2,quote_volume_24h:1_200_000,
    liquidity_quality:82,data_quality:91,risk_flags:[],
    data_status:{candle_data_valid:true,data_stale:false,data_valid:true,volume_gate_pass:true,last_error:null},
    pre_move_context:{
      score:65,evidence_complete:true,closed_candles_only:true,session_return_pct:2.1,
      one_hour_return_pct:0.1,volume_acceleration:1.3,trade_acceleration:1.1,
      taker_buy_ratio:0.54,taker_buy_acceleration:0.02,mean_close_location:0.56,
      components:{squeeze:70,structure:65,buying_pressure:50},
      flow_transition_confirmed:true,price_window_valid:false,structure_confirmed:false,
      already_moved:false,stage:'NO_SETUP',reasons:['VOLUME_ACCELERATING']
    }
  };
  const rows=buildPreMoveWatchCandidates([base],{
    minQuoteVolume24h:750000,minLiquidityQuality:60,minDataQuality:70,minScore:58
  });
  assert.equal(rows.length,1);
  assert.equal(rows[0].watch_only,true);
  assert.equal(rows[0].alert_eligible,false);
  assert.equal(rows[0].pre_move_context.stage,'WATCH_EARLY');
  assert.equal(rows[0].pre_move_context.original_stage,'NO_SETUP');
  assert.ok(rows[0].watch_reason_codes.includes('PRICE_WINDOW_NOT_CONFIRMED'));
  assert.ok(rows[0].watch_reason_codes.includes('BUYING_PRESSURE_NOT_CONFIRMED'));
  assert.equal(rows[0].pre_move_context.actionable,false);

  const extended={
    ...base,symbol:'LATEUSDT',
    pre_move_context:{...base.pre_move_context,already_moved:true,stage:'ALREADY_MOVED'}
  };
  const stale={
    ...base,symbol:'STALEUSDT',
    data_status:{...base.data_status,candle_data_valid:false,data_stale:true}
  };
  const rejected=buildPreMoveWatchCandidates([extended,stale],{});
  assert.equal(rejected.length,0,'late movers and stale candles must not leak into the early watch list');
});


test('Pre-Move scan caps each cycle at 40 symbols and rotates broad coverage',async()=>{
  const scanNow=stablePreMoveTestTime();
  const alpha=n=>{
    let value=n,out='';
    do{out=String.fromCharCode(65+(value%26))+out;value=Math.floor(value/26)-1;}while(value>=0);
    return out;
  };
  const names=Array.from({length:70},(_,i)=>'COIN'+alpha(i)+'USDT');
  const exchangeRows=names.map(symbol=>({
    symbol,baseAsset:symbol.slice(0,-4),quoteAsset:'USDT',status:'TRADING',
    isSpotTradingAllowed:true,permissions:['SPOT']
  }));
  const tickerRows=names.map((symbol,i)=>({
    symbol,lastPrice:'1',highPrice:'1.1',lowPrice:'0.9',
    quoteVolume:String(5_000_000+i*1000),count:100_000+i,priceChangePercent:'1'
  }));
  const rest={
    async request(path){
      if(path==='/api/v3/exchangeInfo')return {data:{symbols:exchangeRows},source:'TEST'};
      if(path==='/api/v3/ticker/24hr')return {data:tickerRows,source:'TEST'};
      throw new Error('UNEXPECTED_PATH:'+path);
    },
    async klines(){throw new Error('DEEP_SCAN_SHOULD_USE_STUB');},
    async depth(){throw new Error('DEEP_SCAN_SHOULD_USE_STUB');}
  };
  const scanner=new MarketUniverseScanner({
    rest,clock:()=>scanNow,
    config:{minQuoteVolume24h:750000,scanLimit:50,deepConcurrency:4}
  });
  let seen=[],active=0,maxActive=0;
  scanner.scanPreMoveSymbol=async ticker=>{
    seen.push(ticker.symbol);
    active++;
    maxActive=Math.max(maxActive,active);
    await new Promise(resolve=>setTimeout(resolve,2));
    active--;
    return null;
  };

  const first=await scanner.scanPreMove({quote:'USDT',limit:50});
  const firstSymbols=new Set(seen);
  assert.equal(PRE_MOVE_MAX_CONCURRENT_DEEP_SCANS,24);
  assert.equal(maxActive,24,'a 40-symbol batch must use bounded concurrency, not a 40-way REST burst');
  assert.equal(first.universe.requested,50);
  assert.equal(first.universe.per_cycle_scan_cap,40);
  assert.equal(first.universe.discovered,40);
  assert.equal(first.universe.deep_scanned,40);
  assert.equal(first.universe.rotation_width,28);
  assert.equal(seen.length,40);

  seen=[];
  const second=await scanner.scanPreMove({quote:'USDT',limit:50});
  assert.equal(second.universe.rotation_cycle,1);
  assert.equal(second.universe.discovered,40);
  assert.equal(second.universe.deep_scanned,40);
  const newlyCovered=seen.filter(symbol=>!firstSymbols.has(symbol));
  assert.ok(newlyCovered.length>=25,
    'the scan cap must not cause each cycle to repeat the same top-ranked symbols');
});

test('Pre-Move diagnostic audit exposes blocker evidence but never promotes audit rows to candidates',async()=>{
  const scanNow=stablePreMoveTestTime();
  const scanner=new MarketUniverseScanner({
    rest:makeRest({clock:()=>scanNow}),
    clock:()=>scanNow,
    config:{minQuoteVolume24h:750000,scanLimit:2,returnLimit:2,deepConcurrency:2,deepKlines:160},
    strategyEvaluator:evaluator
  });
  const result=await scanner.scanPreMove({quote:'USDT',limit:10});
  assert.ok(Array.isArray(result.near_miss_audit));
  assert.ok(result.near_miss_audit.length>0,'fresh observed non-extended rows should explain why the strict path declined them');
  for(const row of result.near_miss_audit){
    assert.equal(row.diagnostic_only,true);
    assert.equal(row.watch_only,true);
    assert.equal(row.alert_eligible,false);
    assert.ok(Array.isArray(row.blocker_codes)&&row.blocker_codes.length>0);
    assert.ok(!result.candidates.some(candidate=>candidate.symbol===row.symbol),
      'near-miss diagnostic rows are never promoted to actionable candidates');
  }
});


test('Pre-Move scan removes already-extended coins before limiting actionable results',async()=>{
  const scanNow=stablePreMoveTestTime();
  const cursorRows=new Map();
  const rotationStateStore={
    async getDedupKey(key){return cursorRows.get(key)||null;},
    async putDedupKey(key,value){cursorRows.set(key,value);}
  };
  const rest=makeRest({clock:()=>scanNow});
  const originalRequest=rest.request;
  rest.request=async path=>{
    const response=await originalRequest(path);
    if(path==='/api/v3/ticker/24hr'){
      return {...response,data:response.data.map(row=>({...row,priceChangePercent:'25'}))};
    }
    return response;
  };
  const scanner=new MarketUniverseScanner({
    rest,clock:()=>scanNow,rotationStateStore,
    config:{minQuoteVolume24h:750000,scanLimit:2,returnLimit:2,deepConcurrency:2,deepKlines:160},
    strategyEvaluator:evaluator
  });
  const result=await scanner.scanPreMove({quote:'USDT',limit:10});
  assert.equal(result.meta.radar,'PRE_MOVE');
  assert.equal(result.meta.live,true,'live valid market data must stay live even if all symbols are too extended');
  assert.equal(result.meta.paper_trading,true);
  assert.equal(result.meta.real_order_execution,false);
  assert.ok(result.universe.valid_data>0);
  assert.equal(result.universe.extended_excluded,result.universe.observed_candle_data,'extended_exclusion counts all fresh observed symbols, including those below the alert-liquidity gate');
  assert.equal(result.universe.coverage_mode,'PINNED_PLUS_ROTATING_V1');
  assert.equal(result.universe.rotation_cursor_source,'DURABLE_STORE');
  assert.equal(result.universe.rotation_cursor_persisted,true);
  assert.equal(result.universe.rotation_sequence,'COMPLETED_SCAN_CURSOR_V1');
  assert.equal(result.universe.rotation_cycle,0);
  assert.equal(cursorRows.size,2,'a completed scan persists both the rotation cursor and ticker activity baseline');
  assert.ok(cursorRows.has('RADARX:PRE_MOVE_ROTATION_CURSOR:V1:USDT'));
  assert.ok(cursorRows.has('RADARX:PRE_MOVE_TICKER_ACTIVITY_BASELINE:V1:USDT'));
  const restartedScanner=new MarketUniverseScanner({
    rest:makeRest(),clock:()=>scanNow,rotationStateStore,
    config:{minQuoteVolume24h:750000,scanLimit:2,returnLimit:2,deepConcurrency:2,deepKlines:160},
    strategyEvaluator:evaluator
  });
  const afterRestart=await restartedScanner.scanPreMove({quote:'USDT',limit:10});
  assert.equal(afterRestart.universe.rotation_cursor_source,'DURABLE_STORE');
  assert.equal(afterRestart.universe.rotation_cursor_persisted,true);
  assert.equal(afterRestart.universe.rotation_cycle,1,
    'a new scanner instance must continue from persisted progress instead of repeating cycle zero');
  assert.equal(result.candidates.length,0,'no already-extended symbol should be promoted as a Pre-Move candidate');
  assert.equal(result.watch_candidates.length,0,'already-extended symbols must not leak into the watch-only list');
  const scannedTimeframes=rest.calls.filter(x=>x.type==='klines').map(x=>x.tf);
  assert.ok(scannedTimeframes.length>0);
  assert.deepEqual([...new Set(scannedTimeframes)],['15m'],'Pre-Move fetches 15m candles once and aggregates closed hourly bars locally');
  assert.ok(!scannedTimeframes.includes('4h'),'Pre-Move must not pay for the unrelated 4h strategy timeframe');
});


test('Pre-Move scans at different limits are serialized per quote and identical requests coalesce',async()=>{
  const scanner=new MarketUniverseScanner({rest:makeRest()});
  let active=0,maxActive=0;
  const starts=[];
  scanner._scanPreMove=async({quote,limit})=>{
    active++;
    maxActive=Math.max(maxActive,active);
    starts.push({quote,limit,at:'start'});
    await new Promise(resolve=>setTimeout(resolve,20));
    starts.push({quote,limit,at:'end'});
    active--;
    return {quote,limit};
  };
  const small=scanner.scanPreMove({quote:'USDT',limit:10});
  const largeA=scanner.scanPreMove({quote:'usdt',limit:50});
  const largeB=scanner.scanPreMove({quote:'USDT',limit:50});
  const [smallResult,largeResultA,largeResultB]=await Promise.all([small,largeA,largeB]);
  assert.equal(maxActive,1,'different Pre-Move scopes may not scan the shared REST request cache concurrently');
  assert.deepEqual(starts.filter(x=>x.at==='start').map(x=>x.limit),[10,50]);
  assert.equal(smallResult.limit,10);
  assert.equal(largeResultA.limit,50);
  assert.strictEqual(largeResultA,largeResultB,'identical quote/limit requests share one in-flight scan');
});
