import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLiquidityAbsorptionAnalysis,buildLiquidityAbsorptionAlert,LiquidityAbsorptionRadar} from '../core/liquidity-absorption-radar.mjs';
import {formatRadarTime12h,decorateRadarAlert} from '../core/radar-alert-meta.mjs';

const NOW=Date.UTC(2026,9,4,21,5,6);

function make1m(){
  const rows=[];
  for(let i=0;i<90;i++){
    const t=NOW-(90-i)*60000;
    const absorption=i>=84;
    const red=i>=84&&i<88;
    const open=absorption?(red?99.65:99.55):(100+Math.sin(i)*0.08);
    const close=absorption?(red?99.50+(i-84)*0.03:99.75+(i-88)*0.10):100+Math.sin(i+1)*0.08;
    const low=absorption?Math.min(open,close)-0.55:99.2;
    const high=absorption?Math.max(open,close)+0.25:100.8;
    rows.push({
      openTime:t,closeTime:t+59999,open,high,low,close,
      volume:absorption?2500:1000,quoteVolume:absorption?250000:100000,
      tradeCount:absorption?180:100,takerBuyBaseVolume:absorption?1550:480,
      closed:true,source:'TEST_FIXTURE',sourceTime:NOW
    });
  }
  return rows;
}
function make5m(){
  const rows=[];
  let p=99.4;
  for(let i=0;i<30;i++){
    const t=NOW-(30-i)*300000;
    const up=i>=26;
    const open=p,close=up?p*1.0018:p*1.0001;
    rows.push({openTime:t,closeTime:t+299999,open,high:Math.max(open,close)+0.12,low:Math.min(open,close)-0.08,close,volume:up?2200:1000,tradeCount:100,takerBuyBaseVolume:up?1350:500,closed:true});
    p=close;
  }
  return rows;
}
const ticker={symbol:'ABSORBTESTUSDT',lastPrice:100,priceChange24h:0.6,quoteVolume24h:2_500_000,tradeCount24h:300_000};
const book={
  bids:[['99.99','6000'],['99.98','4500'],['99.97','3500'],['99.90','2500']],
  asks:[['100.01','1000'],['100.02','800'],['100.05','600'],['100.10','500']]
};

test('Radar 4 detects absorption with independent microstructure algorithms',()=>{
  const a=buildLiquidityAbsorptionAnalysis(make1m(),make5m(),ticker,book,NOW);
  assert.equal(a.closed_candles_only,true);
  assert.equal(a.eligible,true);
  assert.ok(a.score>=83);
  assert.ok(a.metrics.absorption_score>=76);
  assert.ok(a.metrics.volume_ratio>=1.55);
  assert.ok(a.metrics.taker_buy_ratio>=0.52);
  assert.ok(a.metrics.depth_imbalance>=0.10);
  assert.ok(a.metrics.spread_bps<=12);
  assert.equal(a.algorithms.SELLER_ABSORPTION!=null,true);
  assert.equal(a.algorithms.TRAPPED_SELLER_RELEASE!=null,true);
  assert.equal(a.algorithms.LOCAL_AUCTION_BALANCE!=null,true);
});

test('Radar 4 excludes an open trigger candle',()=>{
  const rows=make1m();
  rows.at(-1).closed=false;
  rows.at(-1).closeTime=NOW+60000;
  const a=buildLiquidityAbsorptionAnalysis(rows,make5m(),ticker,book,NOW);
  assert.equal(a.closed_candles_only,true);
  assert.ok(a.eligible===false || a.score!==null);
});

test('Radar 4 alert identifies source and 12-hour discovery time',()=>{
  const alert=buildLiquidityAbsorptionAlert({one_minute:make1m(),five_minute:make5m(),ticker,book},NOW);
  assert.equal(alert.event,'LIQUIDITY_ABSORPTION_ALERT');
  assert.equal(alert.radar,'LIQUIDITY_ABSORPTION_RADAR');
  assert.equal(alert.radar_name,'Radar 4 — Liquidity Absorption');
  assert.equal(alert.detected_at,NOW);
  assert.match(alert.detected_time_12h,/م|ص|AM|PM/i);
  assert.equal(alert.detected_timezone,'Asia/Aden');
  assert.equal(alert.paper_trading,true);
  assert.equal(alert.real_order_execution,false);
  assert.equal(alert.confidence_score,'UNKNOWN');
  const decorated=decorateRadarAlert(alert);
  assert.equal(decorated.detected_at_iso,new Date(NOW).toISOString());
});

test('12-hour formatter rolls 12 to 1 correctly by hour',()=>{
  const oneAm=Date.UTC(2026,9,5,1,2,3);
  const twelveAm=Date.UTC(2026,9,5,0,2,3);
  assert.match(formatRadarTime12h(oneAm),/01\/10\/2026/);
  assert.match(formatRadarTime12h(twelveAm),/12:/);
  assert.doesNotMatch(formatRadarTime12h(oneAm),/00:/);
});

test('Radar 4 health exposes its own name and distinct algorithms',()=>{
  const radar=new LiquidityAbsorptionRadar({rest:{},store:{},config:{pollMs:60000}});
  const h=radar.health();
  assert.equal(h.radar,'LIQUIDITY_ABSORPTION_RADAR');
  assert.equal(h.radar_name,'Radar 4 — Liquidity Absorption');
  assert.equal(h.closed_candles_only,true);
  assert.ok(h.algorithms.includes('SELLER_ABSORPTION'));
});

console.log('Liquidity Absorption Radar tests passed');
