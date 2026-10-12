import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDoomsdayAnalysis,DoomsdayRadar} from '../core/doomsday-radar.mjs';

function candle(openTime,close,opts={}){
  const open=opts.open??close-0.02,high=opts.high??close+0.05,low=opts.low??close-0.05;
  return {openTime,closeTime:openTime+(opts.step??59_999),open,high,low,close,volume:opts.volume??1000,quoteVolume:opts.quoteVolume??close*(opts.volume??1000),tradeCount:opts.tradeCount??100,takerBuyBaseVolume:opts.takerBuyBaseVolume??(opts.volume??1000)*0.54,closed:true};
}
function series(n,base=100,step=60_000,boost=0,endAt=null){
  const out=[];
  const start=endAt!==null&&endAt!==undefined&&Number.isFinite(Number(endAt))?Number(endAt)-n*step:1_700_000_000_000;
  for(let i=0;i<n;i++){
    const c=base+i*.01+(i>n-8?(i-(n-8))*boost:0);
    out.push(candle(start+i*step,c,{step:step-1,volume:i>n-8?2600:900,tradeCount:i>n-8?220:80,takerBuyBaseVolume:i>n-8?1500:430}));
  }
  return out;
}

test('Doomsday keeps closed-candle policy and exposes the early/ignition fingerprint',()=>{
  const now=1_700_000_000_000+119*60_000;
  const one=series(120,100,60_000,.08);
  const five=series(80,100,300_000,.12,now);
  const btc=series(80,100,300_000,.02,now);
  const a=buildDoomsdayAnalysis({oneMinute:one,fiveMinute:five,btcFiveMinute:btc,ticker:{lastPrice:110,priceChange24h:4},instantChangePct:.25,now});
  assert.equal(a.closed_candles_only,true);
  assert.ok(Number.isFinite(a.early_score));
  assert.ok(Number.isFinite(a.ignition_score));
  assert.ok(Number.isFinite(a.score));
  assert.ok(a.metrics.volume_ratio>1);
  assert.ok(a.metrics.trade_ratio>1);
  assert.ok(Number.isFinite(a.metrics.relative_strength_pct));
});

test('Doomsday rejects an already extreme 24h extension',()=>{
  const now=1_700_000_000_000+119*60_000;
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


test('Doomsday rejects a fresh-looking setup after a short-term pump',()=>{
  const now=1_700_000_000_000+119*60_000;
  const one=[];
  for(let i=0;i<120;i++){
    const close=i<109?100+i*.01:101.1+(i-109)*0.42;
    const open=i===0?100:one.at(-1).close;
    const volume=i>=109?3200:900;
    const tradeCount=i>=109?260:80;
    one.push(candle(1_700_000_000_000+i*60_000,close,{step:59_999,open,high:Math.max(open,close)+.04,low:Math.min(open,close)-.04,volume,tradeCount,takerBuyBaseVolume:volume*.57}));
  }
  const five=series(80,100,300_000,.05,now);
  const btc=series(80,100,300_000,.02,now);
  const a=buildDoomsdayAnalysis({oneMinute:one,fiveMinute:five,btcFiveMinute:btc,ticker:{lastPrice:105.3,priceChange24h:5},instantChangePct:.3,now});
  assert.equal(a.closed_candles_only,true);
  assert.equal(a.eligible,false);
  assert.equal(a.alert_quality.not_chasing,false);
  assert.ok(Number(a.metrics.ten_minute_move_pct)>2.8);
});


function freshSeries(n,base,step,now,boost=0){
  return Array.from({length:n},(_,i)=>{
    const close=base+i*.01+(i>n-8?(i-(n-8))*boost:0);
    const openTime=now-(n-i)*step;
    const vol=i>n-8?2600:900;
    const trades=i>n-8?220:80;
    return candle(openTime,close,{
      step:step-1,open:close-.01,high:close+.05,low:close-.05,
      volume:vol,quoteVolume:close*vol,tradeCount:trades,
      takerBuyBaseVolume:i>n-8?vol*.59:vol*.48
    });
  });
}

test('Doomsday rejects stale 5m candles and BTC reference data',()=>{
  const now=Date.now();
  const one=freshSeries(120,100,60_000,now,.01);
  const five=freshSeries(80,100,300_000,now,.03);
  const btc=freshSeries(80,100,300_000,now,.005);
  const oldFive=five.map(c=>({...c,openTime:c.openTime-20*60*1000,closeTime:c.closeTime-20*60*1000}));
  const result=buildDoomsdayAnalysis({
    oneMinute:one,fiveMinute:oldFive,btcFiveMinute:btc,
    ticker:{lastPrice:101,priceChange24h:1,quoteVolume24h:3_000_000},now
  });
  assert.equal(result.eligible,false);
  assert.equal(result.stage,'STALE_DATA');
  assert.equal(result.data_quality,0);
  assert.equal(result.data_stale,true);
  assert.ok(result.reason_codes.includes('FIVE_MINUTE_CANDLES_STALE'));
});

test('Doomsday provides the freshness values actually consumed by the notification gate',()=>{
  const now=Date.now();
  const one=freshSeries(120,100,60_000,now,.01);
  const five=freshSeries(80,100,300_000,now,.03);
  const btc=freshSeries(80,100,300_000,now,.005);
  const result=buildDoomsdayAnalysis({
    oneMinute:one,fiveMinute:five,btcFiveMinute:btc,
    ticker:{lastPrice:101,priceChange24h:1,quoteVolume24h:3_000_000},now
  });
  assert.notEqual(result.stage,'STALE_DATA');
  assert.ok(Number.isFinite(result.data_quality));
  assert.ok(result.data_quality>0);
  assert.ok(Number.isFinite(result.alert_quality.sniper_freshness));
  assert.ok(Number.isFinite(result.alert_quality.confirmation_bars));
  assert.equal(typeof result.alert_quality.not_chasing,'boolean');
  assert.ok(Number.isFinite(result.candle_freshness.one_minute_age_ms));
});

test('Doomsday marks insufficient history as unavailable rather than live-quality',()=>{
  const now=Date.now();
  const result=buildDoomsdayAnalysis({
    oneMinute:freshSeries(35,100,60_000,now),
    fiveMinute:freshSeries(20,100,300_000,now),
    btcFiveMinute:freshSeries(20,100,300_000,now),
    ticker:{lastPrice:101,priceChange24h:1},now
  });
  assert.equal(result.eligible,false);
  assert.equal(result.stage,'WARMING_UP');
  assert.equal(result.data_quality,0);
  assert.equal(result.data_stale,false);
  assert.ok(result.reason_codes.includes('INSUFFICIENT_CLOSED_CANDLES'));
});
