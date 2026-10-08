import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFalconEyeAnalysis} from '../core/falcon-eye-radar.mjs';

function candle(openTime,close,{open=close-0.02,high=close+0.06,low=close-0.06,volume=900,tradeCount=80,taker=0.50}={}) {
  return {openTime,closeTime:openTime+59_999,open,high,low,close,volume,quoteVolume:close*volume,tradeCount,takerBuyBaseVolume:volume*taker,closed:true};
}

function risingBase(n=100,start=100,step=60_000){
  const rows=[];
  for(let i=0;i<n;i++){
    const close=start+i*0.004;
    const early=i<n-8;
    const lift=early?0:(i-(n-8)+1)*0.09;
    const value=close+lift;
    rows.push(candle(1_800_000_000_000+i*step,value,{volume:early?850:2500,tradeCount:early?75:230,taker:early?0.50:0.56}));
  }
  return rows;
}

function flat(n=40,start=100,step=300_000){
  return Array.from({length:n},(_,i)=>{
    const close=start+i*0.001;
    return {openTime:1_800_000_000_000+i*step,closeTime:1_800_000_000_000+i*step+step-1,open:close-0.005,high:close+0.02,low:close-0.02,close,volume:1200,quoteVolume:close*1200,tradeCount:120,takerBuyBaseVolume:600,closed:true};
  });
}

test('Falcon Eye turns the OGN fingerprint into an early, multi-factor setup',()=>{
  const now=1_800_000_000_000+100*60_000;
  const one=risingBase();
  const five=flat(80);
  const btc=flat(80,100);
  const a=buildFalconEyeAnalysis({
    ticker:{symbol:'OGNUSDT',lastPrice:one.at(-1).close,priceChange24h:2.8,quoteVolume24h:2_500_000},
    oneMinute:one,fiveMinute:five,btcFiveMinute:btc,
    futures:{quoteVolume:25_000_000,openInterest:1_030_000,fundingRate:-0.004},
    previousFutures:{openInterest:1_000_000},
    liquidations:[{time:now-10_000,price:'101',origQty:'1000',side:'BUY'}],
    now
  });
  assert.equal(a.closed_candles_only,true);
  assert.equal(a.not_chasing,true);
  assert.equal(a.eligible,true);
  assert.ok(['PRE_ATTACK','IGNITION'].includes(a.stage));
  assert.ok(a.confirmation_count>=8);
  assert.ok(a.component_scores.compression>=50);
  assert.ok(a.component_scores.volume>=60);
  assert.ok(a.component_scores.taker>=60);
  assert.ok(a.component_scores.derivatives>=70);
  assert.ok(a.metrics.futures_spot_volume_ratio>=8);
  assert.ok(a.metrics.oi_change_pct>2);
  assert.ok(a.metrics.funding_rate<0);
});

test('Falcon Eye vetoes OGN-style post-explosion chasing',()=>{
  const now=1_800_000_000_000+100*60_000;
  const one=risingBase();
  for(let i=one.length-10;i<one.length;i++){
    one[i].close=one[i-1].close*1.008;
    one[i].open=one[i-1].close;
    one[i].high=one[i].close*1.01;
    one[i].low=one[i].open*0.995;
    one[i].volume=5000;
    one[i].tradeCount=500;
    one[i].takerBuyBaseVolume=one[i].volume*0.59;
  }
  const five=flat();
  const btc=flat(40,100);
  const a=buildFalconEyeAnalysis({
    ticker:{symbol:'OGNUSDT',lastPrice:one.at(-1).close,priceChange24h:14,quoteVolume24h:5_000_000},
    oneMinute:one,fiveMinute:five,btcFiveMinute:btc,
    futures:{quoteVolume:70_000_000,openInterest:2_000_000,fundingRate:-0.008},
    previousFutures:{openInterest:1_950_000},
    now
  });
  assert.equal(a.eligible,false);
  assert.equal(a.not_chasing,false);
  assert.ok(a.anti_chase_penalty>=20);
  assert.ok(a.metrics.return_10m>3.8 || a.metrics.move_24h_pct>8);
});
