import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDoomsdayAnalysis,DoomsdayRadar,estimateDoomsdayMovementStart} from '../core/doomsday-radar.mjs';

function candle(openTime,close,opts={}){
  const open=opts.open??close-0.02,high=opts.high??close+0.05,low=opts.low??close-0.05;
  return {openTime,closeTime:openTime+(opts.step??59_999),open,high,low,close,volume:opts.volume??1000,quoteVolume:opts.quoteVolume??close*(opts.volume??1000),tradeCount:opts.tradeCount??100,takerBuyBaseVolume:opts.takerBuyBaseVolume??(opts.volume??1000)*0.54,closed:true};
}
const TEST_NOW=1_700_000_000_000+119*60_000;
function series(n,base=100,step=60_000,boost=0,endAt=TEST_NOW){
  const out=[],origin=endAt-n*step;
  for(let i=0;i<n;i++){const close=base+i*.01+(i>n-8?(i-(n-8))*boost:0);out.push(candle(origin+i*step,close,{step:step-1,volume:i>n-8?2600:900,tradeCount:i>n-8?220:80,takerBuyBaseVolume:i>n-8?1500:430}));}
  return out;
}

test('Doomsday keeps closed-candle policy and exposes the early/ignition fingerprint',()=>{
  const now=TEST_NOW;
  const one=series(120,100,60_000,.08);
  const five=series(80,100,300_000,.12);
  const btc=series(80,100,300_000,.02);
  const a=buildDoomsdayAnalysis({oneMinute:one,fiveMinute:five,btcFiveMinute:btc,ticker:{lastPrice:110,priceChange24h:4},instantChangePct:.25,now});
  assert.equal(a.closed_candles_only,true);
  assert.ok(Number.isFinite(a.early_score));
  assert.ok(Number.isFinite(a.ignition_score));
  assert.ok(Number.isFinite(a.score));
  assert.ok(a.metrics.volume_ratio>1);
  assert.ok(a.metrics.trade_ratio>1);
  assert.ok(Number.isFinite(a.metrics.relative_strength_pct));
  assert.equal(typeof a.alert_quality.not_chasing,'boolean');
  assert.ok(Number.isFinite(a.alert_quality.confirmation_bars));
  assert.ok(Number.isFinite(a.alert_quality.sniper_freshness));
  assert.ok(Number.isFinite(a.metrics.movement_start_time_ms));
  assert.ok(['CLOSED_CANDLE_ACTIVITY_STREAK','NO_RECENT_CONFIRMED_ACTIVITY_STREAK'].includes(a.metrics.movement_start_method));
});

test('Doomsday rejects closed-candle gaps instead of scoring incomplete history',()=>{
  const one=series(120);
  one.splice(80,1);
  const a=buildDoomsdayAnalysis({oneMinute:one,fiveMinute:series(80,100,300_000,.02),btcFiveMinute:series(80,100,300_000,.01),
    ticker:{lastPrice:101,priceChange24h:2},now:TEST_NOW});
  assert.equal(a.eligible,false);
  assert.equal(a.stage,'INCOMPLETE_DATA');
  assert.ok(a.data_quality_reasons.includes('ONE_MINUTE_CLOSED_CANDLE_SEQUENCE_HAS_GAPS'));
});

test('Doomsday rejects stale closed candles',()=>{
  const one=series(120).map(c=>({...c,openTime:c.openTime-10*60_000,closeTime:c.closeTime-10*60_000}));
  const five=series(80,100,300_000,.02).map(c=>({...c,openTime:c.openTime-10*60_000,closeTime:c.closeTime-10*60_000}));
  const btc=series(80,100,300_000,.01).map(c=>({...c,openTime:c.openTime-10*60_000,closeTime:c.closeTime-10*60_000}));
  const a=buildDoomsdayAnalysis({oneMinute:one,fiveMinute:five,btcFiveMinute:btc,ticker:{lastPrice:101,priceChange24h:2},now:TEST_NOW});
  assert.equal(a.eligible,false);
  assert.equal(a.stage,'DATA_STALE');
  assert.equal(a.data_stale,true);
  assert.ok(a.data_quality_reasons.includes('STALE_CLOSED_CANDLES'));
});

test('Doomsday estimates when the current confirmed activity streak began',()=>{
  const one=series(120,100,60_000,.08,TEST_NOW);
  const start=estimateDoomsdayMovementStart(one,TEST_NOW,30);
  assert.equal(start.method,'CLOSED_CANDLE_ACTIVITY_STREAK');
  assert.ok(Number.isFinite(start.started_at_ms));
  assert.equal(start.started_at_ms,one.at(-7).openTime);
  assert.equal(start.observed_bars,7);
  assert.ok(start.lag_ms>=0);
});

test('Doomsday leaves movement start unknown when there is no recent confirmed activity',()=>{
  const one=series(120,100,60_000,0,TEST_NOW);
  for(const row of one.slice(-30)){
    row.volume=900;row.quoteVolume=90_000;row.tradeCount=80;row.takerBuyBaseVolume=450;
  }
  const start=estimateDoomsdayMovementStart(one,TEST_NOW,30);
  assert.equal(start.started_at_ms,null);
  assert.equal(start.reason,'NO_RECENT_CONFIRMED_ACTIVITY_STREAK');
});

test('Doomsday rejects an already extreme 24h extension',()=>{
  const now=TEST_NOW;
  const one=series(120),five=series(80),btc=series(80);
  const a=buildDoomsdayAnalysis({oneMinute:one,fiveMinute:five,btcFiveMinute:btc,ticker:{lastPrice:120,priceChange24h:25},now});
  assert.equal(a.eligible,false);
  assert.equal(a.closed_candles_only,true);
});

test('Doomsday class is paper-only and can select forced watchlist rows',async()=>{
  const candles={};
  const rows=[
    {symbol:'FETUSDT',lastPrice:1,priceChangePercent:'2',quoteVolume:'2000000',count:10000,highPrice:'1.1',lowPrice:'.8'},
    {symbol:'BTCUSDT',lastPrice:100,priceChangePercent:'1',quoteVolume:'100000000',count:100000,highPrice:'102',lowPrice:'95'}
  ];
  const make=()=>({data:{symbols:[{symbol:'FETUSDT',baseAsset:'FET',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']},{symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']}]},source:'TEST'});
  const rest={
    request:async path=>{
      if(path==='/api/v3/exchangeInfo')return make();
      if(path==='/api/v3/ticker/24hr')return {data:rows,source:'TEST'};
      throw new Error('UNEXPECTED_REQUEST');
    },
    klines:async()=>({candles:series(120),source:'TEST'})
  };
  const store={appendDoomsdayAlert:async()=>{}};
  const radar=new DoomsdayRadar({rest,store,config:{deepCandidates:2,deepConcurrency:1,watchlist:['FETUSDT'],minQuoteVolume24h:100}});
  radar.running=true;
  await radar.tick({forcedSymbols:['FETUSDT']});
  assert.equal(radar.health().closed_candles_only,true);
  assert.equal(radar.health().real_order_execution,false);
  assert.ok(radar.scans>=1);
  assert.equal(radar.health().alerts_emitted<=1,true);
});


test('Doomsday reports scan start time while a cycle is awaiting market data',async()=>{
  const radar=new DoomsdayRadar({rest:{},store:{},config:{pollMs:15_000},clock:()=>TEST_NOW});
  radar.running=true;radar.universeAt=TEST_NOW;
  let releaseRows;
  radar.tickerRows=()=>new Promise(resolve=>{releaseRows=resolve;});
  const active=radar.tick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(radar.health().busy,true);
  assert.equal(radar.health().busy_since_at,TEST_NOW);
  releaseRows([]);
  await active;
  assert.equal(radar.health().busy,false);
  assert.equal(radar.health().busy_since_at,null);
});

test('Doomsday rejects a fresh-looking setup after a short-term pump',()=>{
  const now=TEST_NOW;
  const one=[];
  for(let i=0;i<120;i++){
    const close=i<109?100+i*.01:101.1+(i-109)*0.42;
    const open=i===0?100:one.at(-1).close;
    const volume=i>=109?3200:900;
    const tradeCount=i>=109?260:80;
    one.push(candle(1_700_000_000_000+i*60_000,close,{step:59_999,open,high:Math.max(open,close)+.04,low:Math.min(open,close)-.04,volume,tradeCount,takerBuyBaseVolume:volume*.57}));
  }
  const five=series(80,100,300_000,.05);
  const btc=series(80,100,300_000,.02);
  const a=buildDoomsdayAnalysis({oneMinute:one,fiveMinute:five,btcFiveMinute:btc,ticker:{lastPrice:105.3,priceChange24h:5},instantChangePct:.3,now});
  assert.equal(a.closed_candles_only,true);
  assert.equal(a.eligible,false);
  assert.equal(a.alert_quality.not_chasing,false);
  assert.ok(Number(a.metrics.ten_minute_move_pct)>2.8);
});
