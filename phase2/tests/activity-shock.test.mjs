import test from 'node:test';
import assert from 'node:assert/strict';
import {assessQuietBaseActivityShock,isFastActivityShockCandidate} from '../core/activity-shock.mjs';

const start=1_800_000_000_000,step=5*60_000;
function baseCandles({shock=null,count=30}={}){
  const rows=[];
  for(let i=0;i<count;i++){
    const close=100+i*.0005;
    const narrow=i>=count-9;
    const halfRange=narrow?.1:.4;
    const openTime=start+i*step;
    rows.push({
      openTime,closeTime:openTime+step-1,open:close-.02,high:close+halfRange,low:close-halfRange,
      close,volume:1000,quoteVolume:close*1000,tradeCount:100,takerBuyBaseVolume:500,closed:true
    });
  }
  if(shock){
    const i=count-1,openTime=start+i*step;
    const {open=100,high=101.3,low=99.8,close=101.2,volume=6000,trades=400,taker=.4}=shock;
    rows[i]={openTime,closeTime:openTime+step-1,open,high,low,close,volume,quoteVolume:close*volume,
      tradeCount:trades,takerBuyBaseVolume:volume*taker,closed:true};
  }
  return rows;
}
const ticker={symbol:'TESTUSDT',lastPrice:101.2,priceChange24h:4.8};

test('detects a compressed-base activity shock even when taker-buy is below 50%',()=>{
  const candles=baseCandles({shock:{volume:6000,trades:400,taker:.392}});
  const result=assessQuietBaseActivityShock({fiveMinute:candles,ticker,now:candles.at(-1).closeTime+1});
  assert.equal(result.detected,true);
  assert.equal(result.stage,'QUIET_BASE_ACTIVITY_SHOCK');
  assert.equal(result.watch_only,true);
  assert.equal(result.entry_eligible,false);
  assert.equal(result.taker_buy_is_required,false);
  assert.equal(result.taker_flow_confirmed,false);
  assert.ok(result.metrics.volume_shock_ratio>=5);
  assert.ok(result.metrics.trade_shock_ratio>=3);
  assert.ok(result.reasons.includes('TAKER_BUY_BELOW_50_NOT_A_REJECTION'));
});

test('detects an event-style break while explicitly blocking entry after a huge 5m move',()=>{
  const candles=baseCandles({shock:{open:100,high:120,low:99.8,close:119.05,volume:1_500_000,trades:191_500,taker:.451}});
  const result=assessQuietBaseActivityShock({fiveMinute:candles,ticker:{...ticker,lastPrice:119.05,priceChange24h:25},now:candles.at(-1).closeTime+1});
  assert.equal(result.detected,true);
  assert.equal(result.stage,'EVENT_DRIVEN_BREAKOUT');
  assert.equal(result.extended,true);
  assert.equal(result.watch_only,true);
  assert.equal(result.entry_eligible,false);
  assert.ok(result.metrics.return_5m_pct>18);
});

test('rejects an isolated volume spike without trade participation or price acceptance',()=>{
  const candles=baseCandles({shock:{open:100,high:101.3,low:99.8,close:100.1,volume:50_000,trades:100,taker:.38}});
  const result=assessQuietBaseActivityShock({fiveMinute:candles,ticker,now:candles.at(-1).closeTime+1});
  assert.equal(result.detected,false);
  assert.equal(result.stage,'NO_SHOCK');
});

test('does not use the still-open 5m candle as a shock confirmation',()=>{
  const candles=baseCandles({shock:{open:100,high:101.3,low:99.8,close:101.2,volume:6000,trades:400,taker:.4}});
  const now=candles.at(-1).openTime+60_000;
  const result=assessQuietBaseActivityShock({fiveMinute:candles,ticker,now});
  assert.equal(result.detected,false);
  assert.equal(result.closed_candles_only,true);
  assert.equal(result.metrics.closed_candles,candles.length-1);
});

test('fast ticker activity can reserve a micro-scan slot even after the daily move extends',()=>{
  assert.equal(isFastActivityShockCandidate(
    {symbol:'KAIAUSDT',lastPrice:0.06,priceChange24h:40},
    {price_change_pct:3.2,price_acceleration_pct:1.1,volume_accel_ratio:20,trade_accel_ratio:15}
  ),true);
  assert.equal(isFastActivityShockCandidate(
    {symbol:'FLATUSDT',lastPrice:1,priceChange24h:1},
    {price_change_pct:0,price_acceleration_pct:0,volume_accel_ratio:20,trade_accel_ratio:15}
  ),false);
});
