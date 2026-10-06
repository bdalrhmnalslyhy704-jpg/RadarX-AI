import assert from 'node:assert/strict';
import {buildStrongMoveAnalysis,buildStrongMoveAlert,buildEarlyActivationContext,StrongMoveRadar} from '../core/strong-move-radar.mjs';

const NOW=10_000_000_000;

function make1m(){
  const rows=[];
  let price=100;
  for(let i=0;i<120;i++){
    const burst=i>=114;
    const open=price;
    const step=burst?0.45:0.03;
    const close=open+step;
    const high=close+0.08;
    const low=open-0.02;
    price=close;
    rows.push({
      openTime:NOW-(120-i)*60_000,
      closeTime:NOW-(120-i)*60_000+60_000,
      open,high,low,close,
      volume:burst?500_000:80_000,
      tradeCount:burst?4_000:700,
      takerBuyBaseVolume:burst?360_000:38_000,
      closed:true
    });
  }
  return rows;
}

function make5m(){
  const rows=[];let price=100;
  for(let i=0;i<40;i++){
    const burst=i>=37;
    const open=price,close=open+(burst?1.5:0.10);
    price=close;
    rows.push({
      openTime:NOW-(40-i)*300_000,
      closeTime:NOW-(40-i)*300_000+300_000,
      open,high:close+0.2,low:open-0.05,close,
      volume:burst?2_000_000:500_000,
      tradeCount:burst?10_000:3_000,
      takerBuyBaseVolume:burst?1_500_000:240_000,
      closed:true
    });
  }
  return rows;
}


function makeEarly1m(){
  const rows=[];let price=100;
  for(let i=0;i<120;i++){
    const wake=i>=115;
    const open=price;
    const close=open+(wake?0.18:0.01);
    const high=close+(wake?0.05:0.02);
    const low=open-0.015;
    price=close;
    rows.push({openTime:NOW-(120-i)*60_000,closeTime:NOW-(120-i)*60_000+60_000,open,high,low,close,volume:wake?150_000:85_000,tradeCount:wake?1_150:800,takerBuyBaseVolume:wake?86_000:42_000,closed:true});
  }
  return rows;
}

const activationContext=buildEarlyActivationContext(
  {symbol:'EARLYUSDT',lastPrice:100.7,priceChange24h:.70,quoteVolume24h:3_006_000,tradeCount24h:100_120,highPrice24h:102,lowPrice24h:98},
  {symbol:'EARLYUSDT',lastPrice:100.2,priceChange24h:.42,quoteVolume24h:3_000_000,tradeCount24h:100_000,highPrice24h:102,lowPrice24h:98},
  {minQuoteVolume24h:400000}
);
assert.equal(activationContext.eligible,true);
assert.ok(activationContext.activation_score>=66);
assert.ok(activationContext.delta_move_pct>=.2);
assert.ok(activationContext.quote_volume_growth_pct>0);

const earlyAnalysis=buildStrongMoveAnalysis(
  makeEarly1m(),make5m(),
  {symbol:'EARLYUSDT',lastPrice:100.9,priceChange24h:.72,quoteVolume24h:3_006_000,tradeCount24h:100_120},
  NOW,
  {...activationContext,eligible:true,activation_score:82,delta_move_pct:.28,quote_volume_growth_pct:.12,trade_growth_pct:.12}
);
assert.equal(earlyAnalysis.closed_candles_only,true);
assert.equal(earlyAnalysis.stage,'EARLY_ACCELERATION');
assert.equal(earlyAnalysis.eligible,true);
assert.ok(earlyAnalysis.metrics.early_trigger);
assert.ok(earlyAnalysis.metrics.early_confirmations>=4);

const flatRows=make1m().map(x=>({...x,volume:500000,tradeCount:5000,takerBuyBaseVolume:250000}));
const flatAnalysis=buildStrongMoveAnalysis(
  flatRows,make5m(),
  {symbol:'FLATUSDT',lastPrice:107,priceChange24h:3,quoteVolume24h:8_000_000,tradeCount24h:200_000},
  NOW,
  {eligible:false,activation_score:90}
);
assert.equal(flatAnalysis.eligible,false);

const ticker={symbol:'BURSTUSDT',lastPrice:107,priceChange24h:4.2,quoteVolume24h:8_000_000,tradeCount24h:200_000};
const analysis=buildStrongMoveAnalysis(make1m(),make5m(),ticker,NOW);
assert.equal(analysis.closed_candles_only,true);
assert.equal(analysis.eligible,true);
assert.ok(analysis.score>=76);
assert.ok(analysis.component_scores.velocity>=70);
assert.ok(analysis.component_scores.volume>=70);
assert.ok(analysis.component_scores.trades>=70);
assert.ok(analysis.component_scores.taker>=60);
assert.ok(Number.isFinite(analysis.component_scores.flash));
assert.ok(Number.isFinite(analysis.metrics.flash_score));
assert.equal(analysis.metrics.flash_trigger,true);
assert.ok(['STRONG_MOVE','EXPLOSIVE'].includes(analysis.stage));
assert.ok(analysis.reasons.includes('volume climax'));
assert.ok(analysis.reasons.includes('trade-count surge'));

const alert=buildStrongMoveAlert({one_minute:make1m(),five_minute:make5m(),ticker},NOW);
assert.equal(alert.event,'STRONG_MOVE_ALERT');
assert.equal(alert.radar,'STRONG_MOVE_RADAR');
assert.equal(alert.eligible,true);
assert.equal(alert.paper_trading,true);
assert.equal(alert.real_order_execution,false);
assert.equal(alert.confidence_score,'UNKNOWN');

const openRows=make1m();
openRows.at(-1).closed=false;
const closedOnly=buildStrongMoveAnalysis(openRows,make5m(),ticker,NOW);
assert.equal(closedOnly.closed_candles_only,true);
assert.ok(closedOnly.metrics.return_1m!==analysis.metrics.return_1m);

const radar=new StrongMoveRadar({
  rest:{},
  store:{},
  config:{pollMs:60_000},
  clock:()=>NOW
});
assert.equal(radar.health().radar,'STRONG_MOVE_RADAR');
assert.equal(radar.health().closed_candles_only,true);

radar.universe=['EARLYUSDT','BURSTUSDT','ROW3USDT','ROW4USDT','ROW5USDT'];
radar.lastTickerMap.set('EARLYUSDT',{symbol:'EARLYUSDT',lastPrice:100.2,priceChange24h:.42,quoteVolume24h:3_000_000,tradeCount24h:100_000,highPrice24h:102,lowPrice24h:98});
const selected=radar.selectBatch([
  {symbol:'EARLYUSDT',lastPrice:100.7,priceChange24h:.70,quoteVolume24h:3_006_000,tradeCount24h:100_120,highPrice24h:102,lowPrice24h:98},
  {symbol:'BURSTUSDT',lastPrice:107,priceChange24h:4.2,quoteVolume24h:8_000_000,tradeCount24h:200_000,highPrice24h:108,lowPrice24h:90},
  {symbol:'ROW3USDT',lastPrice:101,priceChange24h:.1,quoteVolume24h:2_000_000,tradeCount24h:100_000,highPrice24h:105,lowPrice24h:95},
  {symbol:'ROW4USDT',lastPrice:101,priceChange24h:.2,quoteVolume24h:2_000_000,tradeCount24h:100_000,highPrice24h:105,lowPrice24h:95},
  {symbol:'ROW5USDT',lastPrice:101,priceChange24h:.3,quoteVolume24h:2_000_000,tradeCount24h:100_000,highPrice24h:105,lowPrice24h:95}
]);
assert.ok(selected.some(x=>x.symbol==='EARLYUSDT' && x.__activation?.eligible===true));

const originalTick=radar.tick;
let tickCalled=false;
radar.tick=async()=>{tickCalled=true;};
radar.refreshUniverse=async()=>{radar.universe=['BURSTUSDT'];radar.universeAt=NOW;};
await radar.start();
assert.equal(radar.running,true);
assert.equal(tickCalled,true);
await radar.stop();
assert.equal(radar.running,false);
radar.tick=originalTick;

// CI trigger: independent radar regression coverage stays on this branch.\nconsole.log('Strong Move Radar tests passed');
