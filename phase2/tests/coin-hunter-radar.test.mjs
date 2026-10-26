import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CoinHunterRadar,
  COIN_HUNTER_DEFAULTS,
  featureSet,
  findPreMoveCheckpoint
} from '../core/coin-hunter-radar.mjs';

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
