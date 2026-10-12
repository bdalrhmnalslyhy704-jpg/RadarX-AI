import assert from 'node:assert/strict';
import {buildStrongMoveAnalysis,buildStrongMoveAlert,finalizeStrongMoveCandidate,StrongMoveRadar} from '../core/strong-move-radar.mjs';
import {radarTelemetry} from '../core/radar-telemetry.mjs';

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
      quoteVolume:close*(burst?500_000:80_000),
      tradeCount:burst?4_000:700,
      takerBuyBaseVolume:burst?360_000:38_000,
      takerBuyQuoteVolume:close*(burst?500_000:80_000)*(burst?0.72:0.47),
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
      quoteVolume:close*(burst?2_000_000:500_000),
      tradeCount:burst?10_000:3_000,
      takerBuyBaseVolume:burst?1_500_000:240_000,
      takerBuyQuoteVolume:close*(burst?2_000_000:500_000)*(burst?0.75:0.48),
      closed:true
    });
  }
  return rows;
}

const ticker={symbol:'BURSTUSDT',lastPrice:107,priceChange24h:4.2,quoteVolume24h:8_000_000,tradeCount24h:200_000};
function makeAggTrades(now=NOW){
  const width=3_000,lastStart=Math.floor(now/width)*width-width,firstStart=lastStart-17*width,trades=[];
  for(let b=0;b<18;b++){const start=firstStart+b*width,quotePerTrade=(20+b*8)/8;
    for(let i=0;i<8;i++)trades.push({a:b*8+i,p:'100',q:String(quotePerTrade/100),T:start+200+i*300,m:i>=6});
  }return trades;
}

const aggTrades=makeAggTrades();
const analysis=buildStrongMoveAnalysis(make1m(),make5m(),ticker,NOW,aggTrades);
assert.equal(analysis.closed_candles_only,true);
assert.equal(analysis.eligible,true);
assert.equal(analysis.trigger_diagnostics.eligible,true);
assert.deepEqual(analysis.trigger_diagnostics.failed_checks,[]);
assert.ok(analysis.trigger_diagnostics.checks.every(x=>x.eligible===true));
assert.ok(analysis.score>=76);
assert.ok(analysis.component_scores.velocity>=70);
assert.ok(analysis.component_scores.volume>50,'MAD winsorization should cap isolated volume spikes');
assert.ok(analysis.component_scores.trades>=70);
assert.ok(analysis.component_scores.taker>=60);
assert.ok(Number.isFinite(analysis.component_scores.flash));
assert.ok(Number.isFinite(analysis.metrics.flash_score));
assert.ok(analysis.metrics.flash_score<100,'micro-breakout must not saturate flashScore');
assert.ok(analysis.metrics.taker_buy_ratio>0.70,'taker-buy quote volume must exceed 70%');
assert.ok(analysis.metrics.three_second_taker_buy_ratio>0.70,'3s taker-buy flow must exceed 70%');
assert.equal(analysis.metrics.liquidity_acceleration.available,true);
assert.equal(analysis.metrics.three_second_liquidity.available,true);
assert.ok(Number.isFinite(analysis.metrics.liquidity_acceleration.three_minute_acceleration));
assert.equal(analysis.metrics.liquidity_acceleration.outlier_1m,true);
assert.equal(analysis.metrics.liquidity_acceleration.outlier_3m,true);
assert.equal(analysis.metrics.flash_trigger,true);
assert.ok(['STRONG_MOVE','EXPLOSIVE'].includes(analysis.stage));
assert.ok(analysis.reasons.includes('volume climax'));
assert.ok(analysis.reasons.includes('trade-count surge'));

const alert=buildStrongMoveAlert({one_minute:make1m(),five_minute:make5m(),ticker,agg_trades:aggTrades},NOW);
assert.equal(alert.event,'STRONG_MOVE_ALERT');
assert.equal(alert.radar,'STRONG_MOVE_RADAR');
assert.equal(alert.eligible,true);
assert.equal(alert.paper_trading,true);
assert.equal(alert.real_order_execution,false);
assert.equal(alert.confidence_score,'UNKNOWN');

// End-to-end timing: do not reuse the observation timestamp as the final gate timestamp.
const observedAt=NOW+100;
alert.observed_at=observedAt;
alert.source_event_at=NOW;
const telemetryCountBefore=radarTelemetry.totalRecorded;
const finalizedTiming=finalizeStrongMoveCandidate(alert,{...ticker,minQuoteVolume24h:1_000_000},{
  now:NOW+120,clock:()=>NOW+125,minScore:76,lastAlertAt:0,alertCooldownMs:0,telemetry:true
});
assert.equal(finalizedTiming.decisionStartedAt,NOW+120);
assert.equal(finalizedTiming.decisionCompletedAt,NOW+125);
assert.equal(radarTelemetry.totalRecorded,telemetryCountBefore+1);
const timingEvent=radarTelemetry.events.at(-1);
assert.equal(timingEvent.symbol,'BURSTUSDT');
assert.equal(timingEvent.pipeline_latency_ms,25);
assert.equal(timingEvent.source_data_age_ms,125);
const lowBuy=make1m();
for(const c of lowBuy.slice(-3))c.takerBuyQuoteVolume=c.quoteVolume*0.69;
const rejectedBuy=buildStrongMoveAnalysis(lowBuy,make5m(),ticker,NOW,aggTrades);
assert.equal(rejectedBuy.eligible,false,'69% taker-buy flow must fail closed');
assert.ok(rejectedBuy.trigger_diagnostics.failed_checks.includes('TAKER_BUY_QUOTE_RATIO_GT_70_PERCENT'));

const openRows=make1m();
openRows.at(-1).closed=false;
const closedOnly=buildStrongMoveAnalysis(openRows,make5m(),ticker,NOW);
assert.equal(closedOnly.closed_candles_only,true);
assert.ok(closedOnly.metrics.return_1m!==analysis.metrics.return_1m);

const concurrencyRadar=new StrongMoveRadar({
  rest:{},store:{},config:{pollMs:60_000,scanConcurrency:2,topMoverCount:4,rotationBatchSize:0},
  clock:()=>NOW
});
concurrencyRadar.running=true;
concurrencyRadar.universe=['AUSDT','BUSDT','CUSDT','DUSDT'];
concurrencyRadar.universeAt=NOW;
concurrencyRadar.tickerRows=async()=>concurrencyRadar.universe.map((symbol,index)=>({
  symbol,priceChange24h:index+1,quoteVolume24h:5_000_000
}));
let activeScans=0,maxActiveScans=0;
concurrencyRadar.scanRow=async()=>{
  activeScans++;maxActiveScans=Math.max(maxActiveScans,activeScans);
  await Promise.resolve();
  activeScans--;
};
await concurrencyRadar.tick();
assert.equal(maxActiveScans,2,'symbol scans should overlap at the configured bounded concurrency');
assert.equal(concurrencyRadar.busy,false);
assert.equal(concurrencyRadar.health().scan_concurrency,2);
await concurrencyRadar.stop();

const radar=new StrongMoveRadar({
  rest:{},
  store:{},
  config:{pollMs:60_000},
  clock:()=>NOW
});
assert.equal(radar.health().radar,'STRONG_MOVE_RADAR');
assert.equal(radar.health().closed_candles_only,true);

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
