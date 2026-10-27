import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_TRADER_POLICY,
  scoreAdaptiveTraderCandidate,
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

  const relative=marketFixture({change24h:2.2,currentMove:0.6});
  const btc=marketFixture({change24h:4.1,currentMove:2.4});
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

  const sufficient=Array.from({length:40},(_,i)=>({
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
  assert.equal(requests.filter(x=>x.path==='/api/v3/klines').length,2);
});
