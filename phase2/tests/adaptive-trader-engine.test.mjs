import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_TRADER_POLICY,
  scoreAdaptiveTraderCandidate,
  buildAdaptiveTraderRecommendation,
  buildAdaptiveLearningProfile,
  applyAdaptiveLearning,
  findMissedMoverEvents,
  createAdaptiveTraderSnapshotService,
  createPaperPortfolio,
  openPaperPosition,
  advancePaperPortfolio,
  estimatePaperEquity
} from '../core/adaptive-trader-engine.mjs';

function marketFixture({now=Date.now(),change24h=2.3,quoteVolume=5_000_000,currentMove=0.6,lastCloseTime=null}={}) {
  const candles=[];
  let price=10;
  for(let i=0;i<20;i++){
    const openTime=now-(20-i)*15*60*1000;
    const open=price;
    const drift=i>15?0.0015:0.0003;
    price=open*(1+drift);
    const low=open*0.994;
    const high=price*1.006;
    let qv=100000;
    let trades=1000;
    let buyRatio=0.48;
    if(i===19){qv=300000;trades=2200;buyRatio=0.61;price=open*(1+currentMove/100);}
    const baseVolume=qv/price;
    const closeTime=lastCloseTime!==null&&i===19?lastCloseTime:openTime+15*60*1000-1;
    candles.push([
      openTime,open,high,low,price,baseVolume,closeTime,qv,trades,
      baseVolume*buyRatio,qv*buyRatio,0
    ]);
  }
  return {
    symbol:'TESTUSDT',
    ticker:{symbol:'TESTUSDT',lastPrice:String(price),quoteVolume:String(quoteVolume),priceChangePercent:String(change24h)},
    klines:{data:candles,source:'https://data-api.binance.vision',receivedAt:now-1000},
    now
  };
}


function fiveMinuteFixture(now=Date.now()) {
  const data=[];
  let price=10;
  for(let i=0;i<20;i++){
    const openTime=now-(20-i)*5*60*1000;
    const open=price;
    price=open*(1+(i>15?0.001:0.0002));
    const low=open*0.995,high=price*1.005;
    const quoteVolume=i===19?240000:100000;
    const trades=i===19?2100:1000;
    const buyRatio=i===19?0.62:0.49;
    const baseVolume=quoteVolume/price;
    data.push([openTime,open,high,low,price,baseVolume,openTime+5*60*1000-1,
      quoteVolume,trades,baseVolume*buyRatio,quoteVolume*buyRatio,0]);
  }
  return {data,source:'https://data-api.binance.vision',receivedAt:now-1000};
}

test('5m closed candles add micro volume, trade and buy-flow evidence to the 15m score',()=>{
  const f=marketFixture();
  const result=scoreAdaptiveTraderCandidate({...f,fastKlines:fiveMinuteFixture(f.now)});
  assert.equal(result.data_valid,true);
  assert.equal(result.features.micro_5m_available,true);
  assert.ok(result.features.micro_5m_volume_ratio>1.5);
  assert.ok(result.features.micro_5m_trade_ratio>1.5);
  assert.ok(result.features.micro_5m_taker_buy_ratio>=0.6);
  assert.ok(result.reason_codes.includes('FIVE_MINUTE_BUY_FLOW_POSITIVE'));
  assert.ok(result.features.return_3h_pct!==null);
});

test('live closed-candle scoring produces a transparent candidate, never an entry signal',()=>{
  const f=marketFixture();
  const result=scoreAdaptiveTraderCandidate(f);
  assert.equal(result.symbol,'TESTUSDT');
  assert.equal(result.data_valid,true);
  assert.equal(result.data_stale,false);
  assert.equal(result.closed_candles_only,true);
  assert.equal(result.paper_trading,true);
  assert.equal(result.real_order_execution,false);
  assert.equal(result.entry_eligible,false);
  assert.ok(result.score>=0 && result.score<=100);
  assert.ok(['EARLY_SETUP','WATCH','NO_SETUP','LATE_MOVE'].includes(result.tier));
  assert.ok(Array.isArray(result.reason_codes));
  assert.ok(result.features.volume_ratio>1);
});

test('adaptive trader gives a strict, explained candidate verdict without enabling an order',()=>{
  const now=Date.now();
  const base={
    symbol:'SETUPUSDT',price:1.25,change_24h_pct:2.1,quote_volume_24h:5_000_000,
    score:82,tier:'EARLY_SETUP',data_valid:true,data_stale:false,closed_candles_only:true,
    paper_candidate:true,entry_eligible:false,real_order_execution:false,
    as_of:new Date(now).toISOString(),candle_close_time:now-60_000,candle_age_ms:60_000,
    thresholds:{no_chase:true,late_move:false},
    features:{volume_ratio:2.1,trade_ratio:1.7,taker_buy_ratio:0.59,close_location:0.72,
      higher_low:true,breakout_above_prior_high:true,compression_ratio:0.7,
      hourly_return_pct:1.1,relative_strength_vs_btc_pct:0.8,micro_5m_available:true,
      micro_5m_taker_buy_ratio:0.59,micro_5m_volume_ratio:1.8},
    reason_codes:['VOLUME_ACTIVITY_EXPANDING']
  };
  const result=buildAdaptiveTraderRecommendation(base,{now});
  assert.equal(result.decision,'ENTRY_CANDIDATE');
  assert.equal(result.symbol,'SETUPUSDT');
  assert.match(result.label_ar,/مرشّح دخول للمراجعة/);
  assert.equal(result.entry_eligible,false);
  assert.equal(result.real_order_execution,false);
  assert.equal(result.paper_trading,true);
  assert.ok(result.reason_codes.includes('CLOSED_CANDLE_BREAKOUT'));
  assert.ok(result.next_step_ar.length>20);

  const waiting=buildAdaptiveTraderRecommendation({...base,features:{...base.features,breakout_above_prior_high:false}},{now});
  assert.equal(waiting.decision,'WAIT_FOR_CONFIRMATION');
  assert.equal(waiting.entry_eligible,false);
});

test('adaptive trader explicitly rejects chasing late movers and all stale data',()=>{
  const now=Date.now();
  const base={
    symbol:'LATEUSDT',price:2.5,change_24h_pct:47.41,score:91,tier:'LATE_MOVE',
    data_valid:true,data_stale:false,closed_candles_only:true,paper_candidate:false,
    candle_age_ms:60_000,candle_close_time:now-60_000,as_of:new Date(now).toISOString(),
    thresholds:{no_chase:false,late_move:true},
    features:{hourly_return_pct:12,volume_ratio:4,trade_ratio:3,taker_buy_ratio:0.7,close_location:0.9},
    reason_codes:['ALREADY_EXTENDED']
  };
  const late=buildAdaptiveTraderRecommendation(base,{now});
  assert.equal(late.decision,'AVOID_CHASING');
  assert.equal(late.action,'AVOID');
  assert.equal(late.entry_eligible,false);

  const stale=buildAdaptiveTraderRecommendation({...base,data_stale:true,tier:'EARLY_SETUP',change_24h_pct:2},{now});
  assert.equal(stale.decision,'DATA_UNAVAILABLE');
  assert.equal(stale.entry_eligible,false);
  assert.equal(stale.action,'NO_TRADE');
});

test('fresh REST responses received during a slow scan are not misclassified as future data',()=>{
  const scanStartedAt=Date.now()-15_000;
  const f=marketFixture({now:scanStartedAt});
  f.klines.receivedAt=scanStartedAt+8_000;
  const result=scoreAdaptiveTraderCandidate(f);
  assert.equal(result.data_valid,true);
  assert.equal(result.data_stale,false);
  assert.equal(Date.parse(result.as_of),scanStartedAt+8_000);
  assert.ok(result.candle_age_ms>=8_000);
});

test('incomplete or future candles are rejected rather than treated as live evidence',()=>{
  const f=marketFixture({now:Date.now()});
  f.klines.data=f.klines.data.slice(0,11);
  const missing=scoreAdaptiveTraderCandidate(f);
  assert.equal(missing.data_valid,false);
  assert.ok(missing.reason_codes.includes('INSUFFICIENT_CLOSED_CANDLES'));

  const future=marketFixture();
  future.klines.data[19][6]=future.now+1000;
  const futureResult=scoreAdaptiveTraderCandidate(future);
  assert.equal(futureResult.closed_candles_only,true);
  assert.ok(futureResult.data_valid===false || futureResult.candle_close_time<future.now);
});

test('BTC-relative weakness and deep daily drawdown block early setup claims',()=>{
  const candidate=marketFixture({change24h:-12,currentMove:0.9});
  const result=scoreAdaptiveTraderCandidate(candidate);
  assert.equal(result.data_valid,true);
  assert.equal(result.paper_candidate,false);
  assert.ok(result.reason_codes.includes('DAILY_DRAWDOWN_BLOCK'));

  // Use one identical evaluation clock for both fixtures. Separate Date.now()
  // calls can differ by a few milliseconds, making BTC's final candle appear
  // to close after the relative fixture's scan start and causing a flaky result.
  const comparisonNow=Date.now();
  const relative=marketFixture({now:comparisonNow,change24h:2.2,currentMove:0.6});
  const btc=marketFixture({now:comparisonNow,change24h:4.1,currentMove:2.4});
  const compared=scoreAdaptiveTraderCandidate({...relative,btcKlines:btc.klines});
  assert.equal(compared.data_valid,true);
  assert.ok(Number.isFinite(compared.features.relative_strength_vs_btc_pct));
  assert.ok(compared.features.relative_strength_vs_btc_pct<0);
});

test('late daily/hourly moves are explicitly blocked from the early setup tier',()=>{
  const f=marketFixture({change24h:15,currentMove:1.1});
  const result=scoreAdaptiveTraderCandidate(f);
  assert.equal(result.tier,'LATE_MOVE');
  assert.equal(result.paper_candidate,false);
  assert.ok(result.reason_codes.includes('ALREADY_EXTENDED'));
  assert.equal(result.entry_eligible,false);
});

test('adaptive profile waits for enough labelled outcomes and never rewrites rules automatically',()=>{
  const few=Array.from({length:10},(_,i)=>({
    outcome:i<6?'UP':'DOWN',
    features:{volume_ratio:2,taker_buy_ratio:0.6,higher_low:true,compression_ratio:0.7}
  }));
  const pending=buildAdaptiveLearningProfile(few);
  assert.equal(pending.ready,false);
  assert.equal(pending.adjustments.volume,0);
  assert.equal(applyAdaptiveLearning(70,{volume_ratio:2},pending),70);

  const sufficient=Array.from({length:80},(_,i)=>({
    outcome:i%2===0?'UP':'DOWN',
    features:{
      volume_ratio:i%3===0?2.2:0.8,
      taker_buy_ratio:i%2===0?0.59:0.47,
      higher_low:i%4===0,
      breakout_above_prior_high:i%5===0,
      compression_ratio:i%3===0?0.65:1.2
    }
  }));
  const profile=buildAdaptiveLearningProfile(sufficient);
  assert.equal(profile.ready,true);
  assert.equal(profile.note,'CALIBRATION_ONLY_NO_AUTOMATIC_RULE_OR_EXECUTION_CHANGES');
  const adjusted=applyAdaptiveLearning(75,{volume_ratio:2.2,taker_buy_ratio:0.59,higher_low:true,compression_ratio:0.65},profile);
  assert.ok(adjusted>=71&&adjusted<=79);
});

test('missed-mover audit identifies only observed moves from a previous non-watch snapshot',()=>{
  const now=2_000_000_000_000;
  const history=[
    {symbol:'MISSEDUSDT',price:1,at:now-60*60*1000,tier:'NO_SETUP',evaluated:true},
    {symbol:'WATCHUSDT',price:2,at:now-60*60*1000,tier:'WATCH',evaluated:true},
    {symbol:'RECENTUSDT',price:1,at:now-5*60*1000,tier:'NO_SETUP'}
  ];
  const events=findMissedMoverEvents({history,currentPrices:[
    {symbol:'MISSEDUSDT',price:1.07},
    {symbol:'WATCHUSDT',price:2.2},
    {symbol:'RECENTUSDT',price:1.08}
  ],now});
  assert.equal(events.length,2);
  const missed=events.find(row=>row.symbol==='MISSEDUSDT');
  const watched=events.find(row=>row.symbol==='WATCHUSDT');
  assert.equal(missed.classification,'POTENTIAL_MISSED_MOVER');
  assert.equal(missed.diagnostic_only,true);
  assert.equal(watched.classification,'FOLLOW_UP_MOVE');
  const unassessed=findMissedMoverEvents({history:[{symbol:'UNSEENUSDT',price:1,at:now-60*60*1000,tier:'NOT_EVALUATED',evaluated:false}],currentPrices:[{symbol:'UNSEENUSDT',price:1.08}],now});
  assert.equal(unassessed[0].classification,'UNASSESSED_MOVE');
});

test('missed-move review finds a multi-candle rise after the latest 15-minute return cooled',()=>{
  const now=2_000_000_000_000;
  const events=findMissedMoverEvents({
    history:[
      {symbol:'COOLEDUSDT',price:1,at:now-60*60*1000,tier:'NO_SETUP',evaluated:true},
      {symbol:'COOLEDUSDT',price:1.04,at:now-30*60*1000,tier:'WATCH',evaluated:true}
    ],
    currentPrices:[{symbol:'COOLEDUSDT',price:1.07}],
    now,thresholdPct:5
  });
  assert.equal(events.length,1);
  assert.equal(events[0].baseline_tier,'NO_SETUP');
  assert.equal(events[0].classification,'POTENTIAL_MISSED_MOVER');
  assert.ok(events[0].move_pct>=5);

  const seen=findMissedMoverEvents({
    history:[
      {symbol:'SEENUSDT',price:1,at:now-60*60*1000,tier:'NO_SETUP',evaluated:true},
      {symbol:'SEENUSDT',price:1.05,at:now-30*60*1000,tier:'WATCH',evaluated:true}
    ],
    currentPrices:[{symbol:'SEENUSDT',price:1.11}],
    now,thresholdPct:5
  });
  assert.equal(seen[0].baseline_tier,'WATCH');
  assert.equal(seen[0].classification,'FOLLOW_UP_MOVE');
});

test('paper portfolio opens only strict labelled setups, estimates costs and never enables real execution',()=>{
  const portfolio=createPaperPortfolio(10000);
  portfolio.enabled=true;
  const f=marketFixture();
  const candidate=scoreAdaptiveTraderCandidate(f);
  const rejected=openPaperPosition(portfolio,{...candidate,tier:'WATCH',paper_candidate:false},f.now);
  assert.equal(rejected.opened,false);

  const valid={
    ...candidate,tier:'EARLY_SETUP',score:82,paper_candidate:true,entry_eligible:false,
    thresholds:{no_chase:true},
    features:{volume_ratio:2,trade_ratio:1.6,taker_buy_ratio:0.6,close_location:0.75,higher_low:true,compression_ratio:0.7}
  };
  const opened=openPaperPosition(portfolio,valid,f.now);
  if(candidate.tier==='EARLY_SETUP') {
    assert.equal(opened.opened,true);
    assert.equal(opened.position.real_order_execution,false);
    assert.equal(opened.position.mode,'PAPER_ONLY');
    const initialEquity=estimatePaperEquity(portfolio);
    const advanced=advancePaperPortfolio(portfolio,[{symbol:'TESTUSDT',price:opened.position.entry_price*1.04}],f.now+60_000);
    assert.equal(advanced.newlyClosed.length,1);
    assert.equal(advanced.newlyClosed[0].exit_reason,'PAPER_TAKE_PROFIT');
    assert.equal(advanced.newlyClosed[0].real_order_execution,false);
    assert.ok(advanced.portfolio.cash>0);
    assert.ok(Number.isFinite(initialEquity));
  } else {
    // The fixture can intentionally rank below the setup threshold; an override is
    // used only above to prove that the simulator itself has a distinct paper gate.
    assert.equal(opened.opened,true);
    const advanced=advancePaperPortfolio(portfolio,[{symbol:'TESTUSDT',price:opened.position.entry_price*0.97}],f.now+60_000);
    assert.equal(advanced.newlyClosed.length,1);
    assert.equal(advanced.newlyClosed[0].exit_reason,'PAPER_STOP_LOSS');
  }
  assert.equal(portfolio.real_order_execution,false);
  assert.equal(ADAPTIVE_TRADER_POLICY.realOrderExecution,false);
});

test('market snapshot service obtains exchange universe, tickers and candles from the injected public REST client',async()=>{
  const f=marketFixture();
  const requests=[];
  const rest={async request(path,query={}) {
    requests.push({path,query});
    if(path==='/api/v3/exchangeInfo')return {data:{symbols:[
      {symbol:'TESTUSDT',status:'TRADING',quoteAsset:'USDT',isSpotTradingAllowed:true,permissions:['SPOT']},
      {symbol:'BADUPUSDT',status:'TRADING',quoteAsset:'USDT',isSpotTradingAllowed:true,permissions:['SPOT']}
    ]},source:'https://data-api.binance.vision',receivedAt:f.now};
    if(path==='/api/v3/ticker/24hr')return {data:[
      {...f.ticker,quoteVolume:'5000000'},
      {symbol:'BADUPUSDT',lastPrice:'1',quoteVolume:'90000000',priceChangePercent:'2'}
    ],source:'https://data-api.binance.vision',receivedAt:f.now};
    if(path==='/api/v3/klines')return {data:f.klines.data,source:'https://data-api.binance.vision',receivedAt:f.now};
    throw new Error('UNEXPECTED_REQUEST');
  }};
  const service=createAdaptiveTraderSnapshotService({rest,ttlMs:90000});
  const snapshot=await service({limit:20,now:f.now});
  assert.equal(snapshot.status,'LIVE_DATA');
  assert.equal(snapshot.source,'Binance Public REST');
  assert.equal(snapshot.universe.eligible_spot_symbols,1);
  assert.equal(snapshot.universe.analyzed_symbols,1);
  assert.equal(snapshot.meta.real_order_execution,false);
  assert.equal(snapshot.candidates[0].symbol,'TESTUSDT');
  const cached=await service({limit:20,now:f.now+1000});
  assert.equal(cached.meta.cache_mode,'FRESH_SERVER_CACHE');
  assert.equal(requests.filter(x=>x.path==='/api/v3/klines'&&x.query.interval==='15m').length,2);
  assert.equal(requests.filter(x=>x.path==='/api/v3/klines'&&x.query.interval==='5m').length,1);
});


test('BTC benchmark failure does not disable otherwise valid Spot candidate analysis',async()=>{
  const f=marketFixture();
  const rest={
    request:async(path,query={})=>{
      if(path==='/api/v3/exchangeInfo')return {data:{symbols:[
        {symbol:'TESTUSDT',status:'TRADING',quoteAsset:'USDT',isSpotTradingAllowed:true,permissions:['SPOT']}
      ]},source:'https://data-api.binance.vision',receivedAt:f.now};
      if(path==='/api/v3/ticker/24hr')return {data:[{...f.ticker,quoteVolume:'5000000'}],source:'https://data-api.binance.vision',receivedAt:f.now};
      if(path==='/api/v3/klines'&&query.symbol==='BTCUSDT')throw new Error('BTC_BENCHMARK_TEMPORARILY_UNAVAILABLE');
      if(path==='/api/v3/klines'&&query.symbol==='TESTUSDT')return f.klines;
      throw new Error('UNEXPECTED_REQUEST');
    }
  };
  const snapshot=await createAdaptiveTraderSnapshotService({rest})({limit:20,now:f.now});
  assert.equal(snapshot.status,'LIVE_DATA');
  assert.equal(snapshot.universe.valid_symbols,1);
  assert.equal(snapshot.candidates[0].data_valid,true);
  assert.ok(snapshot.candidates[0].reason_codes.includes('BTC_BENCHMARK_UNAVAILABLE'));
  assert.equal(snapshot.meta.btc_benchmark_available,false);
  assert.equal(snapshot.meta.btc_benchmark_error,'BTC_BENCHMARK_TEMPORARILY_UNAVAILABLE');
  assert.equal(rest.requestDeadlineAtMs,null);
});

test('mover-aware scan includes rising and extended Spot pairs outside the highest-volume rows',async()=>{
  const f=marketFixture();
  const regular=Array.from({length:100},(_,i)=>({
    symbol:'ROT'+String(i).padStart(3,'0')+'USDT',
    lastPrice:'10',
    quoteVolume:String(10_000_000-i*89_000),
    priceChangePercent:'0.1',
    count:'2000'
  }));
  const early=Array.from({length:15},(_,i)=>({
    symbol:i===0?'EARLYUSDT':'EARM'+String(i).padStart(2,'0')+'USDT',
    lastPrice:'10',
    quoteVolume:String(1_000_000-i*2_000),
    priceChangePercent:String(i===0?2.5:(0.8+i*0.15).toFixed(2)),
    count:'2500'
  }));
  const lateSymbols=[
    ['INITUSDT',28.49],['WENBUSDT',16.31],['BLURUSDT',14.07],['KORUBUSDT',13.44],
    ['SKHYBUSDT',12.29],['SHELLUSDT',11.64],['SNXXBUSDT',10.72],['AXTIBUSDT',9.40],['BMTUSDT',9.11]
  ];
  const late=lateSymbols.map(([symbol,change],i)=>({
    symbol,lastPrice:'10',quoteVolume:String(900_000-i*4_000),
    priceChangePercent:String(change),count:'3500'
  }));
  const tickers=[...regular,...early,...late];
  const rest={async request(path,query={}) {
    if(path==='/api/v3/exchangeInfo')return {data:{symbols:tickers.map(row=>({
      symbol:row.symbol,status:'TRADING',quoteAsset:'USDT',isSpotTradingAllowed:true,permissions:['SPOT']
    }))},source:'https://data-api.binance.vision',receivedAt:f.now};
    if(path==='/api/v3/ticker/24hr')return {data:tickers,source:'https://data-api.binance.vision',receivedAt:f.now};
    if(path==='/api/v3/klines')return f.klines;
    throw new Error('UNEXPECTED_REQUEST '+path);
  }};
  const snapshot=await createAdaptiveTraderSnapshotService({rest,ttlMs:0})({limit:40,now:f.now});
  assert.equal(snapshot.status,'LIVE_DATA');
  assert.equal(snapshot.universe.selection_strategy,'MOVER_AWARE_ACCELERATION_ROTATION_V2');
  assert.equal(snapshot.universe.emerging_movers_available,15);
  assert.equal(snapshot.universe.extended_movers_available,9);
  assert.equal(snapshot.universe.selection_lane_counts.EXTENDED_MOVER_AUDIT,9);
  const earlyCandidate=snapshot.candidates.find(row=>row.symbol==='EARLYUSDT');
  assert.ok(earlyCandidate);
  assert.equal(earlyCandidate.selection_lane,'EMERGING_MOVER');
  for(const [symbol] of lateSymbols){
    const candidate=snapshot.candidates.find(row=>row.symbol===symbol);
    assert.ok(candidate, symbol+' must be inspected even when it is outside the top-volume rows');
    assert.equal(candidate.selection_lane,'EXTENDED_MOVER_AUDIT');
    assert.equal(candidate.tier,'LATE_MOVE');
    assert.equal(candidate.paper_candidate,false);
    assert.equal(candidate.entry_eligible,false);
    assert.equal(candidate.real_order_execution,false);
  }
});

test('universe rotation continues after the last successful pair and retries the failed tail',async()=>{
  const f=marketFixture();
  const symbols=Array.from({length:100},(_,i)=>'ROT'+String(i).padStart(3,'0')+'USDT');
  let failTail=true;
  const symbolRequests=[];
  const rest={async request(path,query={}) {
    if(path==='/api/v3/exchangeInfo')return {data:{symbols:symbols.map(symbol=>({
      symbol,status:'TRADING',quoteAsset:'USDT',isSpotTradingAllowed:true,permissions:['SPOT']
    }))},source:'https://data-api.binance.vision',receivedAt:Date.now()};
    if(path==='/api/v3/ticker/24hr')return {data:symbols.map((symbol,i)=>({
      symbol,lastPrice:'10',quoteVolume:String(5_000_000-i*10_000),priceChangePercent:'2'
    })),source:'https://data-api.binance.vision',receivedAt:Date.now()};
    if(path==='/api/v3/klines'&&query.symbol==='BTCUSDT')return f.klines;
    if(path==='/api/v3/klines'&&query.interval==='5m')return f.klines;
    if(path==='/api/v3/klines'){
      symbolRequests.push(query.symbol);
      const index=Number(String(query.symbol).slice(3,6));
      if(failTail&&index>=28)throw new Error('TEST_TEMPORARY_KLINE_FAILURE');
      return f.klines;
    }
    throw new Error('UNEXPECTED_REQUEST '+path);
  }};
  const service=createAdaptiveTraderSnapshotService({rest,ttlMs:0,scanTimeoutMs:60_000});
  const first=await service({limit:40,now:f.now});
  assert.equal(first.universe.eligible_spot_symbols,100);
  assert.equal(first.universe.scan_offset,0);
  assert.equal(first.universe.scan_advance_count,40);
  assert.equal(first.universe.scan_success_count,28);
  assert.equal(first.universe.valid_symbols,28);
  assert.equal(first.universe.fetch_failed_symbols,12);
  assert.equal(symbolRequests[0],'ROT000USDT');
  assert.equal(symbolRequests[28],'ROT028USDT');

  failTail=false;
  const countBeforeSecond=symbolRequests.length;
  const second=await service({limit:40,now:Date.now()+1000});
  assert.equal(second.universe.scan_offset,
    (first.universe.scan_offset+first.universe.scan_advance_count)%100);
  assert.equal(second.universe.scan_success_count,40);
  assert.equal(second.universe.valid_symbols,40);
  assert.ok(second.universe.scan_advance_count>0);
  assert.equal(symbolRequests[countBeforeSecond],'ROT028USDT');
  assert.equal(symbolRequests[countBeforeSecond+7],'ROT035USDT');
  assert.equal(second.candidates[0].real_order_execution,false);

  const countBeforeThird=symbolRequests.length;
  const third=await service({limit:40,now:Date.now()+2000});
  assert.equal(third.universe.scan_offset,
    (second.universe.scan_offset+second.universe.scan_advance_count)%100);
  assert.equal(third.universe.valid_symbols,40);
  assert.equal(symbolRequests[countBeforeThird],'ROT036USDT');
});


test('explicit persisted scan offset overrides the process-local cursor and cached result',async()=>{
  const f=marketFixture();
  const symbols=Array.from({length:100},(_,i)=>'OFF'+String(i).padStart(3,'0')+'USDT');
  const rest={async request(path,query={}){
    if(path==='/api/v3/exchangeInfo')return {data:{symbols:symbols.map(symbol=>({
      symbol,status:'TRADING',quoteAsset:'USDT',isSpotTradingAllowed:true,permissions:['SPOT']
    }))},source:'https://data-api.binance.vision',receivedAt:Date.now()};
    if(path==='/api/v3/ticker/24hr')return {data:symbols.map((symbol,i)=>({
      symbol,lastPrice:'10',quoteVolume:String(5_000_000-i*10_000),priceChangePercent:'1.5'
    })),source:'https://data-api.binance.vision',receivedAt:Date.now()};
    if(path==='/api/v3/klines'&&query.symbol==='BTCUSDT')return f.klines;
    if(path==='/api/v3/klines')return f.klines;
    throw new Error('UNEXPECTED_REQUEST '+path);
  }};
  const service=createAdaptiveTraderSnapshotService({rest,ttlMs:90_000,scanTimeoutMs:60_000});
  const first=await service({limit:40,now:Date.now(),offset:5});
  assert.equal(first.universe.scan_offset,5);
  const second=await service({limit:40,now:Date.now()+1000,offset:50});
  assert.equal(second.universe.scan_offset,50);
  assert.equal(second.candidates.length,40);
});

test('concurrent universe sizes keep distinct server-cache entries',async()=>{
  const f=marketFixture();
  const rest={async request(path,query={}) {
    if(path==='/api/v3/exchangeInfo')return {data:{symbols:[
      {symbol:'TESTUSDT',status:'TRADING',quoteAsset:'USDT',isSpotTradingAllowed:true,permissions:['SPOT']}
    ]},source:'https://data-api.binance.vision',receivedAt:f.now};
    if(path==='/api/v3/ticker/24hr')return {data:[{...f.ticker,quoteVolume:'5000000'}],source:'https://data-api.binance.vision',receivedAt:f.now};
    if(path==='/api/v3/klines')return {data:f.klines.data,source:'https://data-api.binance.vision',receivedAt:f.now};
    throw new Error('UNEXPECTED_REQUEST');
  }};
  const service=createAdaptiveTraderSnapshotService({rest,ttlMs:90000});
  const [small,large]=await Promise.all([service({limit:40,now:f.now}),service({limit:80,now:f.now})]);
  assert.equal(small.universe.requested_limit,40);
  assert.equal(large.universe.requested_limit,80);
  const cached=await service({limit:40,now:f.now+1000});
  assert.equal(cached.universe.requested_limit,40);
  assert.equal(cached.meta.cache_mode,'FRESH_SERVER_CACHE');
});


test('market-wide ticker pulse prioritizes new short-term acceleration and tracks pairs below deep-scan liquidity gate',async()=>{
  const f=marketFixture();
  let pulsePrice=10;
  const rows=[
    ...Array.from({length:40},(_,i)=>({symbol:'REG'+String(i).padStart(3,'0')+'USDT',lastPrice:'10',
      quoteVolume:String(5_000_000-i*20_000),priceChangePercent:'1.2',count:'1500'})),
    {symbol:'PULSEUSDT',lastPrice:String(pulsePrice),quoteVolume:'950000',priceChangePercent:'3.1',count:'2100'},
    {symbol:'LOWVOLUSDT',lastPrice:'0.12',quoteVolume:'15000',priceChangePercent:'0.4',count:'120'}
  ];
  const rest={async request(path,query={}){
    if(path==='/api/v3/exchangeInfo')return {data:{symbols:rows.map(row=>({symbol:row.symbol,status:'TRADING',
      quoteAsset:'USDT',isSpotTradingAllowed:true,permissions:['SPOT']}))},source:'https://data-api.binance.vision',receivedAt:f.now};
    if(path==='/api/v3/ticker/24hr')return {data:rows.map(row=>({...row})),source:'https://data-api.binance.vision',receivedAt:f.now};
    if(path==='/api/v3/klines'&&query.symbol==='BTCUSDT')return f.klines;
    if(path==='/api/v3/klines')return f.klines;
    throw new Error('UNEXPECTED_REQUEST '+path);
  }};
  const service=createAdaptiveTraderSnapshotService({rest,ttlMs:0});
  const first=await service({limit:40,now:f.now});
  assert.ok(first.latest_prices.some(row=>row.symbol==='LOWVOLUSDT'),
    'all active Spot pairs remain visible in price tracking even below the deep scan gate');
  pulsePrice=10.12;
  rows.find(row=>row.symbol==='PULSEUSDT').lastPrice=String(pulsePrice);
  const second=await service({limit:40,now:f.now+3*60*1000});
  assert.ok(second.universe.price_acceleration_candidates_available>=1);
  const pulse=second.candidates.find(row=>row.symbol==='PULSEUSDT');
  assert.ok(pulse,'a new short-term price pulse should reserve a deep-scan slot');
  assert.equal(pulse.selection_lane,'PRICE_ACCELERATION');
  assert.ok(second.latest_prices.find(row=>row.symbol==='PULSEUSDT').move_since_previous_pct>=1);
});

test('adaptive learning calibrates on market-wide outcomes and exposes up/down/flat counts',()=>{
  const samples=Array.from({length:80},(_,i)=>({
    id:'MKT'+i,observation_type:'MARKET_WIDE_TICKER',
    outcome:i%3===0?'DOWN':i%3===1?'UP':'FLAT',
    return_pct:i%3===0?-3:i%3===1?2.5:0.1,
    features:{
      price_change_15m_pct:i%2===0?0.3:-0.15,
      price_change_4h_pct:i%4===0?2:-1,
      relative_24h_strength_vs_btc_pct:i%3===1?1:-0.4,
      change_24h_pct:i%5===0?10:2,
      quote_volume_24h:1_000_000
    }
  }));
  const profile=buildAdaptiveLearningProfile(samples);
  assert.equal(profile.ready,true);
  assert.equal(profile.market_wide_samples,80);
  assert.equal(profile.candidate_samples,0);
  assert.equal(profile.resolved_samples,80);
  assert.equal(profile.outcome_counts.up,26);
  assert.equal(profile.outcome_counts.down,27);
  assert.equal(profile.outcome_counts.flat,27);
  assert.ok(profile.covered_factor_buckets>=4);
  assert.equal(profile.note,'MARKET_WIDE_OUTCOME_CALIBRATION_ONLY_NO_AUTOMATIC_RULE_OR_EXECUTION_CHANGES');
});
