import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEarlyMoverCaseStudy } from '../core/missed-mover-case-study.mjs';

const INTERVAL = 5 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

function makeCandles({length=1000,now=NOW,moveStart=810,moveEnd=830,base=100}={}) {
  const rows=[];
  for(let i=0;i<length;i++) {
    let close=base;
    if(i>=moveStart&&i<=moveEnd) {
      const fraction=(i-moveStart+1)/(moveEnd-moveStart+1);
      close=base*(1+0.12*fraction);
    } else if(i>moveEnd) close=base*1.12;
    const priorMove = i>=moveStart-6;
    const volume=priorMove?220:100;
    const tradeCount=priorMove?32:20;
    const takerShare=priorMove?0.61:0.48;
    const open=rows.length?rows[rows.length-1].close:close;
    const low=Math.min(open,close)*0.998;
    const high=Math.max(open,close)*1.002;
    const closeTime=now-(length-1-i)*INTERVAL;
    rows.push({
      openTime:closeTime-INTERVAL,closeTime,open,high,low,close,volume,
      quoteVolume:volume*close,tradeCount,
      takerBuyBaseVolume:volume*takerShare,
      takerBuyQuoteVolume:volume*takerShare*close,
      closed:true
    });
  }
  return rows;
}

test('case study finds first trailing-24h threshold crossing and snapshots only prior closed candles',()=>{
  const candles=makeCandles();
  const report=buildEarlyMoverCaseStudy('HUMAUSDT',candles,{now:NOW,thresholdPct:5,windowHours:24,leadMinutes:60});
  assert.equal(report.status,'THRESHOLD_CROSSING_FOUND',JSON.stringify(report));
  assert.equal(report.no_future_data_used,true);
  assert.ok(report.crossing.trailing_24h_return_pct>=5);
  assert.ok(report.crossing.previous_trailing_24h_return_pct<5);
  assert.ok(report.pre_move.minutes_before_crossing>=55);
  assert.ok(report.pre_move.minutes_before_crossing<=60);
  assert.ok(report.pre_move.features.observed_at<report.crossing.observed_at);
  assert.ok(report.pre_move.price<report.crossing.price);
  assert.ok(report.pre_move.features.quote_volume_ratio_15m_vs_prior_2h>1.5);
  assert.ok(report.pre_move.features.trade_count_ratio_15m_vs_prior_2h>1.2);
  assert.ok(report.pre_move.features.taker_buy_share_15m>0.55);
  assert.equal(report.at_crossing.features.price,report.crossing.price);
  assert.equal(report.pre_move.features.historical_orderbook_spread,null);

  assert.deepEqual(report.lead_snapshots_before_crossing.map(row=>row.requested_lead_minutes),[60,30,15,5]);
  assert.ok(report.lead_snapshots_before_crossing.every(row=>
    row.status==='CLOSED_CANDLE_SNAPSHOT' &&
    row.observed_at < report.crossing.observed_at &&
    row.price > 0 &&
    Number.isFinite(row.price_change_to_crossing_pct)
  ));
  assert.equal(report.post_crossing_outcomes['5m'].status,'COMPLETE');
  assert.ok(Number.isFinite(report.post_crossing_outcomes['5m'].close_return_pct));
  assert.ok(Number.isFinite(report.post_crossing_outcomes['5m'].max_favorable_pct));
  assert.ok(Number.isFinite(report.post_crossing_outcomes['5m'].max_adverse_pct));
  assert.equal(report.post_crossing_outcomes['24h'].status,'PENDING_HORIZON');
});

test('missing numeric features remain null rather than silently becoming zero',()=>{
  const candles=makeCandles().map(row=>({...row,tradeCount:null,takerBuyBaseVolume:null,takerBuyQuoteVolume:null}));
  const report=buildEarlyMoverCaseStudy('SYNUSDT',candles,{now:NOW,thresholdPct:5,windowHours:24,leadMinutes:60});
  assert.equal(report.status,'THRESHOLD_CROSSING_FOUND');
  assert.equal(report.pre_move.features.trade_count_ratio_15m_vs_prior_2h,null);
  assert.equal(report.pre_move.features.taker_buy_share_15m,null);
  assert.equal(report.pre_move.early_evidence.checks.trade_activity_expanding,null);
  assert.equal(report.pre_move.early_evidence.checks.buyer_pressure_positive,null);
});

test('stale, open, malformed, and future candles are excluded from the sample',()=>{
  const candles=makeCandles().map(row=>({...row}));
  candles[10].closed=false;
  candles[11].closeTime=NOW+INTERVAL;
  candles[12].high=1;
  const report=buildEarlyMoverCaseStudy('REZUSDT',candles,{now:NOW});
  assert.equal(report.closed_candles,candles.length-3);
  assert.equal(report.no_future_data_used,true);
});

test('reports insufficient history and rejects non-Spot / malformed symbols',()=>{
  const short=buildEarlyMoverCaseStudy('ANIMEUSDT',makeCandles({length:120}),{now:NOW});
  assert.equal(short.status,'INSUFFICIENT_CLOSED_CANDLES');
  assert.throws(()=>buildEarlyMoverCaseStudy('SOXLB',makeCandles(),{now:NOW}),/BINANCE_SPOT_USDT_SYMBOL_REQUIRED/);
  assert.throws(()=>buildEarlyMoverCaseStudy('PARTIUSDT',makeCandles(),{now:NOW,thresholdPct:0}),/INVALID_THRESHOLD_PCT/);
});

test('does not invent a threshold crossing when the window began above the threshold',()=>{
  const candles=makeCandles({moveStart:100,moveEnd:120});
  const report=buildEarlyMoverCaseStudy('PARTIUSDT',candles,{now:NOW,thresholdPct:5,windowHours:24});
  assert.notEqual(report.status,'THRESHOLD_CROSSING_FOUND');
});
