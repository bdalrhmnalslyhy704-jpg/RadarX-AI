import test from 'node:test';
import assert from 'node:assert/strict';
import {buildUnifiedFeatureSnapshot} from '../core/unified-feature-engine.mjs';

const STEP=5*60_000;
function candle(openTime, close, {
  open=close-0.01, high=close+0.04, low=close-0.04,
  volume=1000, trades=80, taker=0.5, closed=true
}={}) {
  const quoteVolume=close*volume;
  return {
    openTime, closeTime:openTime+STEP-1, open, high, low, close,
    volume, quoteVolume, tradeCount:trades,
    takerBuyBaseVolume:volume*taker, takerBuyQuoteVolume:quoteVolume*taker,
    closed, source:'BINANCE_PUBLIC_REST'
  };
}
function makeQuietBase({now=1_900_000_000_000,n=80}={}) {
  const endOpen=Math.floor(now/STEP)*STEP-STEP;
  const origin=endOpen-(n-1)*STEP;
  const rows=[];
  for(let i=0;i<n;i++){
    const quiet=i>=68;
    const close=i<56
      ? 100 + (i%8)*0.22
      : 101.5 + (i-56)*0.03;
    const finalClose=quiet ? 101.84 + (i-68)*0.002 : close;
    rows.push(candle(origin+i*STEP,finalClose,{
      open:finalClose-0.006,
      high:finalClose+(quiet?0.018:0.13),
      low:finalClose-(quiet?0.018:0.13),
      volume:i>=77?2600:1000,
      trades:i>=77?235:82,
      taker:i>=77?0.58:0.50,
    }));
  }
  return {rows,now:rows.at(-1).closeTime+1000};
}
function snapshot(overrides={}) {
  const base=makeQuietBase();
  return buildUnifiedFeatureSnapshot({
    symbol:'TESTUSDT',candles:base.rows,
    ticker:{symbol:'TESTUSDT',lastPrice:base.rows.at(-1).close,priceChange24h:1.5,quoteVolume24h:8_000_000,tradeCount24h:40_000},
    marketBaseline24hPct:0.2,now:base.now,...overrides
  });
}

test('detects a quiet base using each coin\'s own participation baseline before price expansion',()=>{
  const result=snapshot();
  assert.equal(result.data_ready,true);
  assert.equal(result.closed_candles_only,true);
  assert.ok(result.features.quote_turnover_vs_self_baseline>1.12);
  assert.ok(result.features.trade_count_vs_self_baseline>1.08);
  assert.equal(result.features.buy_pressure_improving,true);
  assert.ok(['PRE_EXPANSION','BREAKOUT_DEVELOPING','WATCH_EARLY'].includes(result.stage),
    JSON.stringify({stage:result.stage,reasons:result.reasons,features:result.features}));
  assert.ok(result.score>=0&&result.score<=100);
});

test('the engine strictly excludes candles not marked closed and future close times',()=>{
  const base=makeQuietBase();
  const lastClosed=base.rows.at(-1);
  const open=candle(lastClosed.openTime+STEP,lastClosed.close+50,{closed:false});
  const future=candle(lastClosed.openTime+2*STEP,lastClosed.close+100,{closed:true});
  future.closeTime=base.now+STEP*3;
  const result=snapshot({candles:[...base.rows,open,future]});
  assert.equal(result.closed_candle_count,base.rows.length);
  assert.equal(result.latest_closed_candle_close_time_ms,lastClosed.closeTime);
  assert.equal(Number(result.features.last_price).toFixed(8),Number(lastClosed.close).toFixed(8));
});

test('missing or stale closed candles fail closed rather than using open candle values',()=>{
  const base=makeQuietBase();
  const incomplete=snapshot({candles:base.rows.slice(-19)});
  assert.equal(incomplete.stage,'DATA_INSUFFICIENT');
  assert.equal(incomplete.data_ready,false);
  const stale=snapshot({now:base.rows.at(-1).closeTime+30*60_000});
  assert.equal(stale.stage,'DATA_INSUFFICIENT');
  assert.equal(stale.data_ready,false);
});

test('extended price movement is classified as ALREADY_EXTENDED instead of chased',()=>{
  const base=makeQuietBase();
  const result=snapshot({
    ticker:{symbol:'TESTUSDT',lastPrice:base.rows.at(-1).close,priceChange24h:15,quoteVolume24h:8_000_000,tradeCount24h:40_000}
  });
  assert.equal(result.stage,'ALREADY_EXTENDED');
  assert.ok(result.reasons.includes('ANTI_CHASE_EXTENSION_LIMIT'));
});

test('no fabricated buyer flow: missing taker-buy data cannot create PRE_EXPANSION',()=>{
  const base=makeQuietBase();
  const rows=base.rows.map(c=>({...c,takerBuyQuoteVolume:null,takerBuyBaseVolume:null}));
  const result=snapshot({candles:rows});
  assert.equal(result.features.taker_buy_quote_share_recent,null);
  assert.notEqual(result.stage,'PRE_EXPANSION');
  assert.notEqual(result.stage,'BREAKOUT_DEVELOPING');
});

test('actual best bid/ask and depth produce measured spread and book imbalance',()=>{
  const base=makeQuietBase();
  const price=base.rows.at(-1).close;
  const result=snapshot({
    bookTicker:{bidPrice:String(price-0.01),askPrice:String(price+0.01)},
    depth:{
      bids:[[String(price-0.01),'10'],[String(price-0.1),'30']],
      asks:[[String(price+0.01),'8'],[String(price+0.1),'25']]
    }
  });
  const book=result.features.liquidity.actual_top_of_book_and_depth;
  assert.equal(book.available,true);
  assert.ok(book.spread_bps>0);
  assert.equal(book.depth_available,true);
  assert.ok(book.bid_quote_depth_within_1pct>0);
  assert.ok(book.ask_quote_depth_within_1pct>0);
  assert.equal(result.features.data_quality.spread_available,true);
  assert.equal(result.features.data_quality.depth_available,true);
});

test('without book data the spread and depth stay unknown, not synthesized',()=>{
  const result=snapshot();
  const book=result.features.liquidity.actual_top_of_book_and_depth;
  assert.equal(book.spread_bps,null);
  assert.equal(book.depth_available,false);
  assert.equal(book.total_quote_depth_within_1pct,null);
  assert.equal(result.features.data_quality.spread_available,false);
});

test('relative strength is measured against the supplied real benchmark series and market baseline',()=>{
  const base=makeQuietBase();
  const benchmark=base.rows.map((c,i)=>candle(c.openTime,100+i*0.001,{
    open:100+i*0.001-0.002,high:100+i*0.001+0.004,low:100+i*0.001-0.004,
    volume:1000,trades:80,taker:0.5
  }));
  const result=snapshot({benchmarkCandles:benchmark,marketBaseline24hPct:1});
  assert.notEqual(result.features.relative_strength_vs_btc_15m_pct,null);
  assert.equal(result.features.relative_strength_vs_market_24h_pct,0.5);
});

test('paper-only flags remain explicit and output identifies real closed-candle evidence',()=>{
  const result=snapshot();
  assert.equal(result.version,'RADARX_FEATURE_ENGINE_V1');
  assert.equal(result.features.data_quality.closed_candles_only,true);
  assert.equal(result.features.data_quality.taker_flow_available,true);
});
