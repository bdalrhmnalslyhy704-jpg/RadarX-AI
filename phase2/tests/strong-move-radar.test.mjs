import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStrongMoveAnalysis,buildStrongMoveAlert,buildStrongMoveWatchOnlyAlert,buildEmergencyBreakoutAlert,StrongMoveRadar} from '../core/strong-move-radar.mjs';

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

const ticker={symbol:'BURSTUSDT',lastPrice:107,priceChange24h:4.2,quoteVolume24h:8_000_000,tradeCount24h:200_000};

function makeEmergency5m(){
  const rows=make5m();
  const last=rows.at(-1);
  last.close=Number(last.open)*1.075;
  last.high=Math.max(Number(last.high),last.close*1.001);
  last.low=Math.min(Number(last.low),Number(last.open)*0.999);
  last.volume=3_000_000;last.quoteVolume=320_000_000;last.tradeCount=12_000;
  last.takerBuyBaseVolume=1_800_000;
  return rows;
}
const emergencyAlert=buildEmergencyBreakoutAlert({ticker,five_minute:makeEmergency5m()},NOW);
assert.ok(emergencyAlert,'a fresh closed 5m candle at +7% or more should activate emergency path');
assert.equal(emergencyAlert.event,'EMERGENCY_BREAKOUT_ALERT');
assert.equal(emergencyAlert.strong_move.stage,'EMERGENCY_BREAKOUT');
assert.ok(emergencyAlert.strong_move.metrics.closed_5m_candle_return_pct>=7);
assert.equal(emergencyAlert.paper_trading,true);
assert.equal(emergencyAlert.real_order_execution,false);
const isolatedPriceSpike=makeEmergency5m();
{
  const last=isolatedPriceSpike.at(-1);
  last.quoteVolume=1_000;last.volume=10;last.tradeCount=10;last.takerBuyBaseVolume=2;
}
assert.equal(buildEmergencyBreakoutAlert({ticker,five_minute:isolatedPriceSpike},NOW),null,
  'a 7% candle without relative volume/trade participation must not trigger an emergency alert');
const sellerDominatedSpike=makeEmergency5m();
sellerDominatedSpike.at(-1).takerBuyBaseVolume=300_000;
assert.equal(buildEmergencyBreakoutAlert({ticker,five_minute:sellerDominatedSpike},NOW),null,
  'a strong candle with weak taker-buy share must not bypass buyer-flow confirmation');
const lowLiquidityEmergency=buildEmergencyBreakoutAlert({ticker:{...ticker,quoteVolume24h:999},five_minute:makeEmergency5m()},NOW);
assert.ok(lowLiquidityEmergency,'a fresh +7% closed candle must not be rejected for low 24h turnover');
assert.ok(lowLiquidityEmergency.risk_flags.includes('LOW_24H_QUOTE_VOLUME_ADVISORY'));
const volumeSpikeBars=makeEmergency5m();
for(const row of volumeSpikeBars){row.open=100;row.close=100.2;row.high=101;row.low=99;row.quoteVolume=1_000;row.volume=10;row.takerBuyBaseVolume=5;}
const volumeSpikeLast=volumeSpikeBars.at(-1);
volumeSpikeLast.open=100;volumeSpikeLast.close=102;volumeSpikeLast.high=103;volumeSpikeLast.low=99;
volumeSpikeLast.quoteVolume=5_000;volumeSpikeLast.volume=50;volumeSpikeLast.takerBuyBaseVolume=30;
const lowTurnoverVolumeSpike=buildEmergencyBreakoutAlert({
  ticker:{...ticker,quoteVolume24h:1},five_minute:volumeSpikeBars
},NOW);
assert.ok(lowTurnoverVolumeSpike,'a fresh positive 3x 5m volume spike must bypass the 24h volume floor');
assert.equal(lowTurnoverVolumeSpike.event,'EMERGENCY_VOLUME_SPIKE_ALERT');
assert.ok(lowTurnoverVolumeSpike.strong_move.metrics.volume_spike_ratio>=3);
assert.ok(lowTurnoverVolumeSpike.risk_flags.includes('LOW_24H_QUOTE_VOLUME_ADVISORY'));
const openEmergency=makeEmergency5m();openEmergency.at(-1).closed=false;
assert.equal(buildEmergencyBreakoutAlert({ticker,five_minute:openEmergency},NOW),null);
const staleEmergency=makeEmergency5m().map(row=>({...row,closeTime:row.closeTime-9*60_000,openTime:row.openTime-9*60_000}));
assert.equal(buildEmergencyBreakoutAlert({ticker,five_minute:staleEmergency},NOW),null);
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

// A real in-flight cycle exposes its start time so the swarm watchdog can
// distinguish a responsive radar from one stuck behind shared REST traffic.
const busyRadar=new StrongMoveRadar({rest:{},store:{},config:{pollMs:60_000},clock:()=>NOW});
busyRadar.running=true;busyRadar.universeAt=NOW;
let releaseTickRows;
busyRadar.tickerRows=()=>new Promise(resolve=>{releaseTickRows=resolve;});
const busyTick=busyRadar.tick();
await new Promise(resolve=>setImmediate(resolve));
assert.equal(busyRadar.health().busy,true);
assert.equal(busyRadar.health().busy_since_at,NOW);
releaseTickRows([]);
await busyTick;
assert.equal(busyRadar.health().busy,false);
assert.equal(busyRadar.health().busy_since_at,null);

// CI trigger: independent radar regression coverage stays on this branch.
const batchRadar = new StrongMoveRadar({rest:{},store:{},config:{topMoverCount:3,rotationBatchSize:4},clock:()=>NOW});
batchRadar.universe=Array.from({length:16},(_,i)=>`B${String(i).padStart(2,'0')}USDT`);
const batchRows=batchRadar.universe.map((symbol,i)=>({symbol,lastPrice:10+i,priceChange24h:16-i,quoteVolume24h:2_000_000+i}));
const lowVolumeSurge={...batchRows[8],symbol:'LOWVOLUSDT',priceChange24h:12,recent_move_pct:1.1,quoteVolume24h:100};
const selectedBatch=batchRadar.selectBatch([...batchRows,lowVolumeSurge]);
assert.equal(selectedBatch.length,7,'Strong Move should fill its top+rotation budget when enough market rows exist');
assert.equal(new Set(selectedBatch.map(x=>x.symbol)).size,7,'Strong Move must not waste rotation slots on duplicate top movers');
assert.ok(selectedBatch.slice(0,3).every(x=>x.priceChange24h>0&&x.priceChange24h<=8),
  'early positive movers must outrank already-extended daily movers for the top-Micro scan lane');
assert.ok(selectedBatch.some(x=>x.priceChange24h>=7),
  'the rotation budget must reserve access for surge candidates regardless of 24h quote volume');
assert.ok(selectedBatch.some(x=>x.symbol==='LOWVOLUSDT'),
  'a fresh low-turnover surge candidate must retain emergency scan access');

const stale1=make1m().map(row=>({...row,openTime:row.openTime-20*60_000,closeTime:row.closeTime-20*60_000}));
const stale5=make5m().map(row=>({...row,openTime:row.openTime-20*60_000,closeTime:row.closeTime-20*60_000}));
const stale=buildStrongMoveAnalysis(stale1,stale5,ticker,NOW);
assert.equal(stale.eligible,false);
assert.equal(stale.stage,'STALE_DATA');
assert.equal(stale.data_stale,true);

const oneMinuteGap=buildStrongMoveAnalysis(make1m().filter((_,i)=>i!==116),make5m(),ticker,NOW);
assert.equal(oneMinuteGap.eligible,false);
assert.equal(oneMinuteGap.stage,'DATA_GAP');
assert.ok(oneMinuteGap.reason_codes.includes('ONE_MINUTE_CLOSED_CANDLE_GAP'));

const fiveMinuteGap=buildStrongMoveAnalysis(make1m(),make5m().filter((_,i)=>i!==38),ticker,NOW);
assert.equal(fiveMinuteGap.eligible,false);
assert.equal(fiveMinuteGap.stage,'DATA_GAP');
assert.ok(fiveMinuteGap.reason_codes.includes('FIVE_MINUTE_CLOSED_CANDLE_GAP'));

// Emergency alerts bypass analyst/elite consensus but still require fresh closed 5m data and $1M quote volume.
{
  const stored=[],pushed=[];
  const emergencyRadar=new StrongMoveRadar({
    rest:{klines:async(_symbol,tf)=>{
      if(tf==='1m')throw new Error('SIMULATED_1M_DATA_OUTAGE');
      return {candles:makeEmergency5m(),source:'TEST'};
    }},
    store:{appendStrongMoveAlert:async row=>stored.push(row)},
    pushManager:{notifyRadarAlert:async row=>pushed.push(row)},
    config:{pollMs:15_000,emergencyAlertCooldownMs:60_000},
    clock:()=>NOW
  });
  const result=await emergencyRadar.scanRow({...ticker,priceChange24h:29.5});
  assert.equal(result.event,'EMERGENCY_BREAKOUT_ALERT');
  assert.equal(stored.length,1);assert.equal(pushed.length,1);
  assert.equal(stored[0].real_order_execution,false);
  assert.equal(emergencyRadar.health().emergency_alerts_emitted,1);
  const repeated=await emergencyRadar.scanRow({...ticker,priceChange24h:29.5});
  assert.equal(repeated,null,'per-symbol scan pacing prevents duplicate work inside one poll interval');
}
console.log('Strong Move Radar tests passed');


test('near-miss strong-move observations use the separate watch-only lane without lowering strict eligibility',()=>{
  const now=Date.now(),closeAt=now-15_000;
  const alert={
    event:'STRONG_MOVE_ALERT',radar:'STRONG_MOVE_RADAR',symbol:'NEARUSDT',market:'SPOT',
    direction:'UP_SURGE',price:1.25,price_change_24h:3.2,opportunity_score:71.4,
    source:'Binance Public REST',detected_at:now,processed_at:now,
    eligible:false,data_quality:90,liquidity_quality:86,
    risk_flags:[],paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
    data_status:{status:'LIVE_DATA',stale:false,data_stale:false,future_data_detected:false,source:'Binance Public REST'},
    strong_move:{
      eligible:false,direction:'UP_SURGE',score:71.4,data_quality:90,data_stale:false,closed_candles_only:true,
      metrics:{
        closed_5m_candle_close_time_ms:closeAt,
        return_1m:0.14,return_3m:0.28,volume_ratio:1.28,trade_ratio:1.17,
        taker_buy_ratio:0.555,taker_buy_delta:0.018,close_location_pct:61,
        breakout_up:false,micro_breakout:true
      }
    }
  };
  const row={symbol:'NEARUSDT',lastPrice:1.25,priceChange24h:3.2,quoteVolume24h:3_500_000};
  const result=buildStrongMoveWatchOnlyAlert(alert,row,now,{
    minQuoteVolume24h:750_000,
    strictFailures:['STRONG_MOVE_CORE_TRIGGER_NOT_CONFIRMED','ELITE_GATE_NOT_ELIGIBLE']
  });
  assert.ok(result);
  assert.equal(result.event,'STRONG_MOVE_WATCH_ONLY');
  assert.equal(result.watch_only,true);
  assert.equal(result.entry_eligible,false);
  assert.equal(result.eligible,false);
  assert.equal(result.data_status.data_valid,true);
  assert.equal(result.detected_candle_close_time,closeAt);
  assert.ok(result.watch_evidence.confluence_count>=4);
  assert.ok(result.reason_codes.includes('ELITE_GATE_NOT_ELIGIBLE'));
  assert.equal(result.real_order_execution,false);
});

test('near-miss watch lane rejects stale, extended, low-flow and thin-liquidity cases',()=>{
  const now=Date.now();
  const base={
    event:'STRONG_MOVE_ALERT',radar:'STRONG_MOVE_RADAR',symbol:'NEARUSDT',direction:'UP_SURGE',price:1,
    price_change_24h:3,opportunity_score:71,eligible:false,data_quality:90,liquidity_quality:85,
    data_status:{status:'LIVE_DATA',stale:false,data_stale:false,future_data_detected:false,source:'Binance Public REST'},
    risk_flags:[],paper_trading:true,real_order_execution:false,
    strong_move:{eligible:false,direction:'UP_SURGE',score:71,data_quality:90,data_stale:false,closed_candles_only:true,
      metrics:{closed_5m_candle_close_time_ms:now-10_000,return_1m:0.14,return_3m:0.28,
        volume_ratio:1.28,trade_ratio:1.17,taker_buy_ratio:0.555,taker_buy_delta:0.018,
        close_location_pct:61,breakout_up:false,micro_breakout:true}}
  };
  const row={symbol:'NEARUSDT',lastPrice:1,priceChange24h:3,quoteVolume24h:3_000_000};
  assert.equal(buildStrongMoveWatchOnlyAlert(base,row,now),null);
  const stale={...base,strong_move:{...base.strong_move,metrics:{...base.strong_move.metrics,closed_5m_candle_close_time_ms:now-7*60_000}}};
  assert.equal(buildStrongMoveWatchOnlyAlert(stale,row,now),null);
  assert.equal(buildStrongMoveWatchOnlyAlert(base,{...row,priceChange24h:14},now),null);
  const noFlow={...base,strong_move:{...base.strong_move,metrics:{...base.strong_move.metrics,taker_buy_ratio:0.49,taker_buy_delta:0.002}}};
  assert.equal(buildStrongMoveWatchOnlyAlert(noFlow,row,now),null);
  assert.equal(buildStrongMoveWatchOnlyAlert(base,{...row,quoteVolume24h:100_000},now),null);
});
