import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CoinHunterRadar,
  COIN_HUNTER_DEFAULTS,
  featureSet,
  findPreMoveCheckpoint,
  buildCoinHunterNotificationAlert
} from '../core/coin-hunter-radar.mjs';
import {evaluateRadarNotificationGate,resetRadarNotificationGateForTests} from '../core/radar-notification-gate.mjs';

const HOUR = 60 * 60 * 1000;

function hourlyCandles(count, now = Date.now()) {
  const start = now - count * HOUR - 1000;
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i * 0.2;
    const burst = i >= count - 4;
    const volume = burst ? 200 : 100;
    return {
      openTime: start + i * HOUR,
      closeTime: start + (i + 1) * HOUR - 1,
      open: i === 0 ? close - 0.1 : 100 + (i - 1) * 0.2,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume,
      quoteVolume: volume * close,
      tradeCount: burst ? 160 : 80,
      takerBuyBaseVolume: burst ? 120 : 52,
      closed: true
    };
  });
}

const noLog = { warn() {}, debug() {} };

function marketSymbol(symbol, baseAsset, quoteAsset = 'USDT', extra = {}) {
  return {
    symbol, baseAsset, quoteAsset, status: 'TRADING',
    isSpotTradingAllowed: true, permissions: ['SPOT'],
    ...extra
  };
}

test('Coin Hunter excludes non-directional USDT instruments before ranking or deep scanning', async () => {
  const symbols = [
    marketSymbol('SOLUSDT', 'SOL'),
    marketSymbol('USDCUSDT', 'USDC'),
    marketSymbol('BTCUSDT', 'BTC'),
    marketSymbol('WBTCUSDT', 'WBTC'),
    marketSymbol('TSLABUSDT', 'TSLAB'),
    marketSymbol('MARGINUSDT', 'MARGIN', 'USDT', { permissions: ['MARGIN'] }),
    marketSymbol('HALTEDUSDT', 'HALTED', 'USDT', { status: 'BREAK' }),
    marketSymbol('OTHERBTC', 'OTHER', 'BTC')
  ];
  const tickerData = symbols.map((s, i) => ({
    symbol: s.symbol,
    lastPrice: String(1 + i),
    priceChangePercent: '0.4',
    quoteVolume: '2500000',
    count: '4000',
    highPrice: String(1.1 + i),
    lowPrice: String(0.9 + i)
  }));
  const rest = {
    async request(path) {
      if (path === '/api/v3/exchangeInfo') return { data: { symbols }, source: 'TEST_FIXTURE' };
      if (path === '/api/v3/ticker/24hr') return { data: tickerData, source: 'TEST_FIXTURE' };
      throw new Error('UNEXPECTED_REQUEST: ' + path);
    }
  };
  const radar = new CoinHunterRadar({ rest, logger: noLog });
  const rows = await radar.refreshUniverse('USDT');
  assert.deepEqual(rows.map(x => x.symbol), ['SOLUSDT']);
  assert.equal(radar.isSpotSymbol(marketSymbol('USDCUSDT', 'USDC'), 'USDT'), false);
  assert.equal(radar.isSpotSymbol(marketSymbol('SOLUSDT', 'SOL'), 'USDT'), true);
});

test('Coin Hunter feature engine measures volume, trade and taker-buy acceleration from closed candles', () => {
  const candles = hourlyCandles(64);
  const features = featureSet(candles, { lastPrice: candles.at(-1).close }, 1.2);
  assert.ok(features);
  assert.equal(features.volumeAcceleration, 2);
  assert.equal(features.tradeAcceleration, 2);
  assert.equal(features.takerRatio, 0.6);
  assert.equal(features.btcChange, 1.2);
  assert.ok(Number.isFinite(features.ema20));
  assert.ok(Number.isFinite(features.ema50));
});

test('Coin Hunter refuses to score an insufficient or not-yet-closed hourly window', () => {
  const short = hourlyCandles(15);
  assert.equal(featureSet(short, { lastPrice: short.at(-1).close }), null);
  const withFutureTail = hourlyCandles(16);
  withFutureTail[15] = {
    ...withFutureTail[15],
    openTime: Date.now() + 60_000,
    closeTime: Date.now() + 60_000
  };
  assert.equal(featureSet(withFutureTail, { lastPrice: withFutureTail.at(-1).close }), null);
});

test('Coin Hunter rejects stale hourly history and gaps inside the scored window', () => {
  const now = Date.now();
  const stale = hourlyCandles(64, now - 4 * HOUR);
  assert.equal(featureSet(stale, { lastPrice: stale.at(-1).close }, null, now), null);

  const gapped = hourlyCandles(64, now);
  gapped[55] = {
    ...gapped[55],
    openTime: gapped[55].openTime + HOUR,
    closeTime: gapped[55].closeTime + HOUR
  };
  assert.equal(featureSet(gapped, { lastPrice: gapped.at(-1).close }, null, now), null);
});

test('Coin Hunter records the first confirmed pre-move checkpoint, not a later candle', () => {
  const dayStart = Date.now() - 3 * HOUR;
  const rows = [
    { openTime: dayStart, closeTime: dayStart + HOUR - 1, open: 100, high: 100.7, low: 99.7, close: 100.4 },
    { openTime: dayStart + HOUR, closeTime: dayStart + 2 * HOUR - 1, open: 100.4, high: 101.8, low: 100.2, close: 101.5 },
    { openTime: dayStart + 2 * HOUR, closeTime: dayStart + 3 * HOUR - 1, open: 101.5, high: 102.4, low: 101.1, close: 102.1 }
  ];
  const checkpoint = findPreMoveCheckpoint(rows, dayStart, 2);
  assert.deepEqual(checkpoint, {
    index: 2, returnPct: 2.0999999999999943, price: 102.1,
    time: dayStart + 3 * HOUR - 1
  });
  assert.equal(findPreMoveCheckpoint(rows.slice(0, 2), dayStart, 2), null);
});

test('Coin Hunter rotates bounded candidate scans across the eligible universe and persists its cursor', async () => {
  const now=Date.now();
  const symbols=[];
  const tickerData=[];
  for(let i=0;i<24;i++){
    const base='LEAD'+String(i).padStart(2,'0');
    symbols.push(marketSymbol(base+'USDT',base));
    tickerData.push({symbol:base+'USDT',lastPrice:'10',priceChangePercent:String(12+i/10),
      quoteVolume:'5000000',count:'50000',highPrice:'11',lowPrice:'9'});
  }
  for(let i=0;i<48;i++){
    const base='CAND'+String(i).padStart(2,'0');
    symbols.push(marketSymbol(base+'USDT',base));
    tickerData.push({symbol:base+'USDT',lastPrice:'10',priceChangePercent:'-2',
      quoteVolume:String(3000000+i*1000),count:String(30000+i),highPrice:'11',lowPrice:'9'});
  }
  const rest={
    async request(path){
      if(path==='/api/v3/exchangeInfo')return{data:{symbols},source:'TEST_FIXTURE'};
      if(path==='/api/v3/ticker/24hr')return{data:tickerData,source:'TEST_FIXTURE'};
      throw new Error('UNEXPECTED_REQUEST:'+path);
    },
    async klines(symbol,tf){
      const data=tf==='1h'?hourlyCandles(72,now):Array.from({length:96},(_,i)=>{
        const step=15*60*1000,start=now-96*step-1000,close=10+i*.001;
        return{openTime:start+i*step,closeTime:start+(i+1)*step-1,open:close-.001,high:close+.005,low:close-.005,close,volume:i>90?200:100,quoteVolume:close*(i>90?200:100),tradeCount:i>90?200:100,takerBuyBaseVolume:i>90?120:55,closed:true};
      });
      return{candles:data,source:'TEST_FIXTURE',receivedAt:now};
    }
  };
  const saved=new Map();
  const store={
    async getDedupKey(key){return saved.get(key)||null;},
    async putDedupKey(key,value){saved.set(key,value);}
  };
  const config={leaderCount:8,leaderConcurrency:6,candidatePool:16,deepCount:8,deepConcurrency:4,
    minQuoteVolume24h:750000,minCandidateMovePct:-3,maxCandidateMovePct:8,minHunterScore:101};
  const firstSymbols=[];
  const originalKlines=rest.klines;
  const firstRadar=new CoinHunterRadar({rest,store,logger:noLog,config});
  rest.klines=async(symbol,tf,options)=>{
    if(symbol.startsWith('CAND')&&tf==='1h')firstSymbols.push(symbol);
    return originalKlines(symbol,tf,options);
  };
  assert.equal(await firstRadar.scan('USDT'),true);
  const first=[...new Set(firstSymbols)];
  assert.equal(first.length,16);
  assert.equal(firstRadar.lastCoverage.candidate_rotation_cycle,0);
  assert.equal(firstRadar.lastCoverage.candidate_rotation_width,48);
  assert.equal(firstRadar.lastCoverage.candidate_rotation_cursor_source,'DURABLE_STORE');
  assert.equal(firstRadar.lastCoverage.candidate_rotation_cursor_persisted,true);
  assert.equal(saved.get('RADARX:COIN_HUNTER_ROTATION_CURSOR:V1:USDT').next_cycle,1);

  const secondSymbols=[];
  const secondRadar=new CoinHunterRadar({rest,store,logger:noLog,config});
  rest.klines=async(symbol,tf,options)=>{
    if(symbol.startsWith('CAND')&&tf==='1h')secondSymbols.push(symbol);
    return originalKlines(symbol,tf,options);
  };
  assert.equal(await secondRadar.scan('USDT'),true);
  const second=[...new Set(secondSymbols)];
  assert.equal(second.length,16);
  assert.equal(secondRadar.lastCoverage.candidate_rotation_cycle,1);
  assert.equal(secondRadar.lastCoverage.candidate_rotation_cursor_source,'DURABLE_STORE');
  assert.equal(secondRadar.lastCoverage.candidate_rotation_cursor_persisted,true);
  assert.equal(saved.get('RADARX:COIN_HUNTER_ROTATION_CURSOR:V1:USDT').next_cycle,2);
  assert.ok(second.some(symbol=>!first.includes(symbol)),'a fresh process must include candidates omitted by the prior cycle');
  assert.ok(secondRadar.lastCoverage.candidate_rotation_tier_offsets.recovery>=0);
});

test('Coin Hunter notification payload requires validated Binance candle history and measured order-book liquidity', () => {
  const now=Date.now(),closeTime=now-60_000;
  const row={
    radar:'COIN_HUNTER_RADAR',symbol:'ALPHAUSDT',score:91,decision:'قنص',similarity:82,
    price:1.025,quote_volume_24h:5_000_000,trade_count_24h:55_000,
    today_pct:1.7,change_24h_pct:2.1,opportunity_score:91,
    market_data_validation:{
      one_hour_valid:true,fifteen_minute_valid:true,
      one_hour_source:'Binance Public REST',fifteen_minute_source:'Binance Public REST',
      one_hour_closed_count:72,fifteen_minute_closed_count:96
    },
    factors:{
      today_pct:1.7,one_hour_pct:.3,four_hour_pct:.8,relative_vs_btc_pct:1.5,
      higher_low_count:5,ema20:1.02,ema50:1.01,
      micro_volume_acceleration:2.0,micro_trade_acceleration:1.6,micro_taker_buy_ratio:.62,
      micro_compression_ratio:.55,micro_higher_low_count:5,micro_momentum3:.4,
      micro_resistance_distance_pct:1.7,early_setup_score:87,
      early_timing_fingerprint:{
        closeTime,earlySetupScore:87,volumeAcceleration:2.0,tradeAcceleration:1.6,
        takerRatio:.62,compressionRatio:.55,higherLowCount:5,momentum3:.4,breakoutRoom:1.7
      }
    },
    reasons:['micro volume acceleration','taker-buy pressure'],
    risk_flags:[],detected_at:now,source:'Binance Public REST',
    paper_trading:true,real_order_execution:false,closed_candles_only:true
  };
  const liquidity={allowed:true,quality:91,spreadBps:4.2,totalDepth:240000,bidDepth:150000,askDepth:90000,reasons:[]};
  const alert=buildCoinHunterNotificationAlert(row,liquidity,now);
  assert.ok(alert);
  const urlSourcedAlert=buildCoinHunterNotificationAlert({
    ...row,market_data_validation:{
      ...row.market_data_validation,
      one_hour_source:'https://data-api.binance.vision',
      fifteen_minute_source:'https://api1.binance.com'
    }
  },liquidity,now);
  assert.ok(urlSourcedAlert,'actual public Binance REST base URLs must pass the live-source gate');
  assert.equal(buildCoinHunterNotificationAlert({
    ...row,market_data_validation:{
      ...row.market_data_validation,
      one_hour_source:'https://api.fake-binance.vision'
    }
  },liquidity,now),null,'a lookalike host must not pass the live-source gate');
  assert.equal(alert.data_quality,100);
  assert.equal(alert.liquidity_quality,91);
  assert.equal(alert.data_status.data_valid,true);
  assert.equal(alert.data_status.stale,false);
  assert.equal(alert.data_status.candle_closed,true);
  assert.equal(alert.detected_candle_close_time,closeTime);
  assert.equal(alert.market,'SPOT');
  assert.equal(alert.paper_trading,true);
  assert.equal(alert.real_order_execution,false);
  resetRadarNotificationGateForTests();
  const gate=evaluateRadarNotificationGate(alert,{now,commit:false});
  assert.equal(gate.eligible,true,JSON.stringify({mode:gate.mode,score:gate.score,failures:gate.failures,falcon:gate.falcon_eye}));
  assert.equal(gate.mode,'STRICT_NOTIFICATION');

  assert.equal(buildCoinHunterNotificationAlert({
    ...row,market_data_validation:{...row.market_data_validation,one_hour_valid:false}
  },liquidity,now),null,'invalid candle continuity cannot be converted into a notification');
  assert.equal(buildCoinHunterNotificationAlert(row,{...liquidity,allowed:false,quality:0},now),null,
    'unqualified order-book liquidity must block notification');
  assert.equal(buildCoinHunterNotificationAlert({
    ...row,market_data_validation:{...row.market_data_validation,one_hour_source:'TEST_FIXTURE'}
  },liquidity,now),null,'test/mock market history cannot be treated as live alert evidence');
});

test('Coin Hunter health keeps Spot paper-only and reports unknown confidence honestly', () => {
  const radar = new CoinHunterRadar({ rest: {}, logger: noLog });
  const health = radar.health();
  assert.equal(COIN_HUNTER_DEFAULTS.quote, 'USDT');
  assert.equal(health.closed_candles_only, true);
  assert.equal(health.paper_trading, true);
  assert.equal(health.real_order_execution, false);
  assert.equal(health.confidence_score, 'UNKNOWN');
  assert.equal(health.source, 'Binance Public REST');
});

test('Coin Hunter samples leader history concurrently within its configured cap', async () => {
  const now=Date.now();
  const symbols=[];
  const tickerData=[];
  for(let i=0;i<36;i++){
    const base='LEAD'+String(i).padStart(2,'0');
    symbols.push(marketSymbol(base+'USDT',base));
    tickerData.push({symbol:base+'USDT',lastPrice:'10',priceChangePercent:String(10+i/10),
      quoteVolume:'5000000',count:'50000',highPrice:'11',lowPrice:'9'});
  }
  for(let i=0;i<16;i++){
    const base='CAND'+String(i).padStart(2,'0');
    symbols.push(marketSymbol(base+'USDT',base));
    tickerData.push({symbol:base+'USDT',lastPrice:'10',priceChangePercent:'-2',
      quoteVolume:'3000000',count:'30000',highPrice:'11',lowPrice:'9'});
  }
  let activeLeader=0,maxActiveLeader=0,leaderCalls=0;
  const rest={
    async request(path){
      if(path==='/api/v3/exchangeInfo')return{data:{symbols},source:'TEST_FIXTURE'};
      if(path==='/api/v3/ticker/24hr')return{data:tickerData,source:'TEST_FIXTURE'};
      throw new Error('UNEXPECTED_REQUEST:'+path);
    },
    async klines(symbol,tf){
      if(symbol.startsWith('LEAD')&&tf==='1h'){
        activeLeader++;leaderCalls++;maxActiveLeader=Math.max(maxActiveLeader,activeLeader);
        try{await new Promise(resolve=>setTimeout(resolve,15));}
        finally{activeLeader--;}
      }else{
        await new Promise(resolve=>setTimeout(resolve,2));
      }
      const data=tf==='1h'?hourlyCandles(72,now):Array.from({length:96},(_,i)=>{
        const step=15*60*1000,start=now-96*step-1000,close=10+i*.001;
        return{openTime:start+i*step,closeTime:start+(i+1)*step-1,open:close-.001,high:close+.005,low:close-.005,close,volume:i>90?200:100,quoteVolume:close*(i>90?200:100),tradeCount:i>90?200:100,takerBuyBaseVolume:i>90?120:55,closed:true};
      });
      return{candles:data,source:'TEST_FIXTURE',receivedAt:now};
    }
  };
  const radar=new CoinHunterRadar({
    rest,logger:noLog,
    config:{leaderCount:12,leaderConcurrency:6,candidatePool:16,deepCount:8,deepConcurrency:4,
      minQuoteVolume24h:750000,minCandidateMovePct:-3,maxCandidateMovePct:8,minHunterScore:101}
  });
  const started=Date.now();
  const ok=await radar.scan('USDT');
  const elapsed=Date.now()-started;
  assert.equal(ok,true,'Coin Hunter scan should complete with fixture market data');
  assert.equal(leaderCalls,36,'leader history sample should remain broad');
  assert.ok(maxActiveLeader>1,'leader Kline history must be fetched concurrently, not one-by-one');
  assert.ok(maxActiveLeader<=6,'leader Kline concurrency must respect its bounded configured cap');
  assert.equal(radar.lastCoverage.leader_sample_requested,36);
  assert.equal(radar.lastCoverage.leader_scan_concurrency,6);
  assert.ok(radar.lastCoverage.scan_duration_ms>0);
  assert.equal(radar.lastCoverage.scan_over_watchdog_budget,false);
  assert.ok(elapsed<2500,'bounded fake-market scan should complete promptly');
});
