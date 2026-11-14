import test from 'node:test';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  NEURAL_CLOSURE_DATASET_SCHEMA,parseBinanceSpotKline,
  createNeuralClosureDecisionSchedule,buildNeuralClosureFeatureSnapshot,
  buildNeuralClosureEventRow,verifyNeuralClosureRawCoverage
} from '../core/neural-closure-data-builder.mjs';
import {validateFourHourRows,NEURAL_CLOSURE_HORIZON_MS} from '../core/neural-closure-contracts.mjs';

const FIFTEEN=15*60_000,FIVE=5*60_000,MINUTE=60_000;

test('dataset runner imports the canonical 4h horizon before writing target metadata',async()=>{
  const source=await readFile(new URL('../tools/build-neural-closure-dataset.mjs',import.meta.url),'utf8');
  assert.match(source,/import\\s*\\{[\\s\\S]*NEURAL_CLOSURE_HORIZON_MS[\\s\\S]*\\}\\s*from\\s*['"]\\.\\.\\/core\\/neural-closure-contracts\\.mjs['"]/);
  assert.match(source,/horizon_ms:\\s*NEURAL_CLOSURE_HORIZON_MS/);
  assert.equal(NEURAL_CLOSURE_HORIZON_MS,4*60*60_000);
});
const makeCandle=(openTime,intervalMs,{base=100,step=0,volume=1000,trades=100,taker=0.56}={})=>{
  const close=base+step;
  const high=close*1.002,low=close*0.998;
  const quoteVolume=volume*close;
  return {
    openTime,open:close,high,low,close,
    closeTime:openTime+intervalMs-1,
    volume,quoteVolume,numberOfTrades:trades,
    takerBuyBaseVolume:volume*taker,takerBuyQuoteVolume:quoteVolume*taker,
    is_closed:true,closed:true,source:'BINANCE_PUBLIC_REST'
  };
};

test('Binance Spot kline parser preserves closed-candle OHLCV and rejects bad ranges',()=>{
  const raw=[1_000,'100','102','99','101','50',60_999,'5050','125','30','3030','0'];
  const candle=parseBinanceSpotKline(raw,{serverTime:61_001,intervalMs:60_000});
  assert.equal(candle.openTime,1_000);
  assert.equal(candle.closeTime,60_999);
  assert.equal(candle.quoteVolume,5_050);
  assert.equal(candle.numberOfTrades,125);
  assert.equal(candle.takerBuyQuoteVolume,3_030);
  assert.equal(candle.closed,true);
  assert.equal(candle.source,'BINANCE_PUBLIC_REST');
  assert.throws(()=>parseBinanceSpotKline(
    [1_000,'100','98','99','101','50',60_999,'5050','125','30','3030','0'],
    {serverTime:61_001,intervalMs:60_000}
  ),/OHLCV_OR_TIME_INVALID/);
  assert.throws(()=>parseBinanceSpotKline(raw.slice(0,10),{
    serverTime:61_001,intervalMs:60_000
  }),/TUPLE_INVALID/);
});

test('60-day event schedule uses only matured 4h decisions on 15m close boundaries',()=>{
  const serverTime=Date.UTC(2026,10,14,23,0,0);
  const schedule=createNeuralClosureDecisionSchedule({serverTime,days:60});
  assert.equal(schedule.days,60);
  assert.equal(schedule.decision_count,360);
  assert.equal(schedule.decision_times.length,360);
  for(let index=1;index<schedule.decision_times.length;index++)
    assert.equal(schedule.decision_times[index]-schedule.decision_times[index-1],NEURAL_CLOSURE_HORIZON_MS);
  assert.equal(schedule.first_decision_at%FOUR_HOURS(),15*60_000-1);
  assert.ok(schedule.last_decision_at+NEURAL_CLOSURE_HORIZON_MS<=serverTime);
  assert.equal((schedule.one_minute_end_open_at-schedule.one_minute_start_open_at)/MINUTE+1,60*24*60);
});

function FOUR_HOURS(){return 4*60*60_000;}

test('raw coverage gate rejects a missing or duplicate candle rather than filling the gap',()=>{
  const at=Date.UTC(2026,0,1,0,14,59,999);
  const schedule={
    one_minute_start_open_at:at+1,
    one_minute_end_open_at:at+FOUR_HOURS()-MINUTE+1,
    five_minute_start_open_at:at-24*FIVE+1,
    five_minute_end_open_at:at-FIVE+1,
    fifteen_minute_start_open_at:at-24*FIFTEEN+1,
    fifteen_minute_end_open_at:at-FIFTEEN+1
  };
  const minute=Array.from({length:240},(_,index)=>
    makeCandle(at+1+index*MINUTE,MINUTE));
  const five=Array.from({length:24},(_,index)=>
    makeCandle(schedule.five_minute_start_open_at+index*FIVE,FIVE));
  const fifteen=Array.from({length:24},(_,index)=>
    makeCandle(schedule.fifteen_minute_start_open_at+index*FIFTEEN,FIFTEEN));
  const good=verifyNeuralClosureRawCoverage({
    minuteCandles:minute,fiveMinuteCandles:five,
    fifteenMinuteCandles:fifteen,benchmarkFifteenMinuteCandles:fifteen,schedule
  });
  assert.equal(good.valid,true);
  const gap=minute.map(row=>({...row}));
  gap.splice(100,1);
  const bad=verifyNeuralClosureRawCoverage({
    minuteCandles:gap,fiveMinuteCandles:five,
    fifteenMinuteCandles:fifteen,benchmarkFifteenMinuteCandles:fifteen,schedule
  });
  assert.equal(bad.valid,false);
  assert.match(bad.checks.minute.reason,/GAP_OR_DUPLICATE/);
});

test('one shared event row has 18 audited MLP features, 24x29 closed sequence and a 1m first-touch label',()=>{
  const firstFifteenOpen=Date.UTC(2026,0,1,0,0,0);
  const fifteen=Array.from({length:24},(_,index)=>
    makeCandle(firstFifteenOpen+index*FIFTEEN,FIFTEEN,{
      base:100+index*0.02,step:0,volume:1000+index*5,trades:100+index,taker:0.56
    }));
  const at=fifteen.at(-1).closeTime;
  const btc=fifteen.map((row,index)=>makeCandle(
    row.openTime,FIFTEEN,{base:50_000+index*4,volume:10_000,trades:800,taker:0.53}
  ));
  const fiveStart=at-24*FIVE+1;
  const five=Array.from({length:24},(_,index)=>
    makeCandle(fiveStart+index*FIVE,FIVE,{
      base:100+index*0.004,volume:350,trades:40,taker:0.62
    }));
  const sequence=buildNeuralClosureFeatureSnapshot({
    symbolCandles:fifteen,benchmarkCandles:btc,
    fiveMinuteCandles:five,decisionAt:at
  });
  assert.equal(sequence.ready,true);
  assert.equal(sequence.temporal_sequence.length,24);
  assert.ok(sequence.temporal_sequence.every(step=>step.length===29));
  assert.equal(sequence.feature_vector.length,18);
  assert.equal(sequence.feature_names.length,18);
  assert.equal(sequence.temporal_feature_names.length,29);
  assert.equal(sequence.micro_availability_mask,1);
  assert.equal(sequence.order_book_available,false);
  assert.equal(sequence.aggregate_trade_available,false);
  assert.equal(sequence.trade_level_volume_profile_available,false);

  const entry=Number(fifteen.at(-1).close);
  const minute=Array.from({length:240},(_,index)=>{
    const openTime=at+1+index*MINUTE;
    const open=entry;
    const high=index===0?entry*1.04:entry*1.002;
    const low=entry*0.997;
    const close=entry*1.001;
    return {
      openTime,open,high,low,close,closeTime:openTime+MINUTE-1,
      is_closed:true,closed:true,source:'BINANCE_PUBLIC_REST'
    };
  });
  const built=buildNeuralClosureEventRow({
    symbol:'ETHUSDT',decisionAt:at,
    minuteCandles:minute,fiveMinuteCandles:five,
    fifteenMinuteCandles:fifteen,benchmarkFifteenMinuteCandles:btc,
    firstMinuteOpenAt:at+1,sourceReceivedAt:at+NEURAL_CLOSURE_HORIZON_MS+MINUTE,
    quoteVolume24h:900_000
  });
  assert.equal(built.ready,true,built.reason);
  assert.equal(built.row.outcome,'UP');
  assert.equal(built.row.training_eligible,true);
  assert.equal(built.row.source_audit.observed_candles,240);
  assert.equal(built.row.first_touch.exit_price_source,'BARRIER');
  assert.equal(built.row.features.micro_5m_available,true);
  assert.equal(built.row.temporal_sequence.length,24);
  assert.equal(built.row.feature_names.length,18);
  assert.equal(built.row.temporal_feature_names.length,29);
  assert.match(built.row.feature_snapshot_sha,/^[a-f0-9]{64}$/);
  assert.equal(built.row.market,'BINANCE_SPOT_USDT');
  assert.equal(built.row.quote_volume_24h,900_000);
  assert.equal(validateFourHourRows([built.row]).length,1);
});
