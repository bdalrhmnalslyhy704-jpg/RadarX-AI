import test from 'node:test';
import assert from 'node:assert/strict';
import {assessPreExpansionFingerprint,measureGradualParticipation} from '../core/pre-expansion-fingerprint.mjs';
import {EarlyExpansionRadar,buildEarlyExpansionEvidence} from '../core/early-expansion-radar.mjs';
import {FalconEyeRadar,buildFalconEyeAnalysis} from '../core/falcon-eye-radar.mjs';

const rising=[92,95,98,100,104,109,115,121,128,136,145,155];
const gradualVolume=measureGradualParticipation(rising);
const gradualTrades=measureGradualParticipation(rising.map(x=>Math.round(x*.72)));
const baseInput={
  dataReady:true,dailyChangePct:1.4,lastPrice:1.25,maxMove24hPct:8,
  baseScore:84,higherLowScore:86,compressionScore:82,
  rangeCompressionRatio:.78,bollingerRatio:.82,atrRatio:.86,
  volumeRatio:1.22,tradeRatio:1.16,volumeTrend:gradualVolume,tradeTrend:gradualTrades,
  relativeStrengthBtcPct:.38,relativeStrengthMarketPct:.22,
  resistanceDistanceAtr:2.1,return5mPct:.12,return10mPct:.25,return15mPct:.35
};

test('pre-expansion classifier detects a quiet, compressed base with higher lows',()=>{
  const result=assessPreExpansionFingerprint(baseInput);
  assert.equal(result.stage,'PRE_EXPANSION');
  assert.equal(result.base_detected,true);
  assert.equal(result.compression_detected,true);
  assert.equal(result.participation_improving,true);
  assert.equal(result.daily_change_known,true);
});

test('gradual volume and trade improvement is measured across three smoothed buckets',()=>{
  assert.equal(gradualVolume.available,true);
  assert.equal(gradualVolume.improving,true);
  assert.ok(gradualVolume.recent>gradualVolume.middle);
  assert.ok(gradualVolume.middle>=gradualVolume.baseline);
  const result=assessPreExpansionFingerprint({...baseInput,volumeRatio:1.05,tradeRatio:1.04,volumeTrend:gradualVolume,tradeTrend:gradualTrades});
  assert.equal(result.stage,'PRE_EXPANSION');
  assert.equal(result.volume_improving,true);
  assert.equal(result.trades_improving,true);
});

test('zero middle participation bucket returns an unknown step ratio without crashing Radar 8',()=>{
  const result=measureGradualParticipation([100,100,100,100,0,0,0,0,150,150,150,150]);
  assert.equal(result.samples,12);
  assert.equal(result.baseline,100);
  assert.equal(result.middle,0);
  assert.equal(result.recent,150);
  assert.equal(result.step_ratio,null);
  assert.equal(result.improving,false,'a missing middle-to-recent ratio must not be treated as improving participation');
});

test('missing 24-hour percentage is DATA_INSUFFICIENT, never a quiet setup',()=>{
  const result=assessPreExpansionFingerprint({...baseInput,dailyChangePct:null});
  assert.equal(result.stage,'DATA_INSUFFICIENT');
  assert.equal(result.reason,'DAILY_CHANGE_UNKNOWN');
  assert.equal(result.daily_change_known,false);
});

test('late extended movement cannot be relabeled as an early opportunity',()=>{
  const daily=assessPreExpansionFingerprint({...baseInput,dailyChangePct:11.2});
  const intraday=assessPreExpansionFingerprint({...baseInput,dailyChangePct:3.1,return10mPct:4.2});
  assert.equal(daily.stage,'ALREADY_EXTENDED');
  assert.equal(intraday.stage,'ALREADY_EXTENDED');
});

test('a failed resistance wick is not promoted to pre-expansion or breakout-developing',()=>{
  const result=assessPreExpansionFingerprint({...baseInput,resistanceDistanceAtr:.15,breakoutConfirmed:true,falseBreakout:true});
  assert.equal(result.stage,'WATCH_EARLY');
  assert.equal(result.reason,'FALSE_BREAKOUT_REJECTED');
  assert.equal(result.false_breakout_detected,true);
});

function candle(openTime,close,{open=close-.02,high=close+.06,low=close-.06,volume=900,tradeCount=80,taker=.50,step=60_000}={}){
  return {openTime,closeTime:openTime+step-1,open,high,low,close,volume,quoteVolume:close*volume,tradeCount,takerBuyBaseVolume:volume*taker,closed:true};
}
function risingBase(n=100,start=100,step=60_000){
  const out=[];
  for(let i=0;i<n;i++){
    const close=start+i*.004;
    const early=i<n-8;
    const lift=early?0:(i-(n-8)+1)*.09;
    const value=close+lift;
    out.push(candle(1_800_000_000_000+i*step,value,{volume:early?850:2500,tradeCount:early?75:230,taker:early ? 0.50 : 0.56,step}));
  }
  return out;
}
function flat(n=80,start=100,step=300_000){
  return Array.from({length:n},(_,i)=>{
    const close=start+i*.001,openTime=1_800_000_000_000+i*step;
    return {openTime,closeTime:openTime+step-1,open:close-.005,high:close+.02,low:close-.02,close,volume:1200,quoteVolume:close*1200,tradeCount:120,takerBuyBaseVolume:600,closed:true};
  });
}
function falconInput({dailyMove=2.8,wickFailure=false}={}){
  const now=1_800_000_000_000+240*60_000,one=risingBase(),five=flat(),btc=flat();
  if(wickFailure){
    const last=one.at(-1),priorHigh=Math.max(...one.slice(-31,-1).map(x=>Number(x.high)));
    last.open=priorHigh*.997;last.close=priorHigh*.998;last.low=priorHigh*.996;last.high=priorHigh*1.02;
  }
  return {
    ticker:{symbol:'EARLYUSDT',lastPrice:one.at(-1).close,priceChange24h:dailyMove,quoteVolume24h:2_500_000},
    oneMinute:one,fiveMinute:five,btcFiveMinute:btc,
    futures:{quoteVolume:25_000_000,openInterest:1_030_000,fundingRate:-.004},
    previousFutures:{openInterest:1_000_000},
    liquidations:[{time:now-10_000,price:'101',origQty:'1000',side:'BUY'}],now
  };
}

test('Radar 9 exposes the explicit missing-data stage and blocks eligibility when daily change is absent',()=>{
  const input=falconInput();
  input.ticker.priceChange24h=null;
  const result=buildFalconEyeAnalysis(input);
  assert.equal(result.pre_expansion_stage,'DATA_INSUFFICIENT');
  assert.equal(result.eligible,false);
  assert.equal(result.pre_expansion_fingerprint.daily_change_known,false);
});

test('Radar 9 rejects a late daily move as ALREADY_EXTENDED',()=>{
  const result=buildFalconEyeAnalysis(falconInput({dailyMove:14}));
  assert.equal(result.pre_expansion_stage,'ALREADY_EXTENDED');
  assert.equal(result.eligible,false);
});

test('Radar 9 detects a wick-only failed breakout and keeps it on WATCH_EARLY',()=>{
  const result=buildFalconEyeAnalysis(falconInput({dailyMove:2.8,wickFailure:true}));
  assert.equal(result.pre_expansion_fingerprint.false_breakout_detected,true);
  assert.equal(result.pre_expansion_stage,'WATCH_EARLY');
  assert.equal(result.eligible,false);
});

test('Radar 8 exposes DATA_INSUFFICIENT when its daily-change value is missing',()=>{
  const result=buildEarlyExpansionEvidence({series:{},ticker:{symbol:'UNKNOWNUSDT',lastPrice:1,priceChange24h:null},now:1_900_000_000_000});
  assert.equal(result.pre_expansion_stage,'DATA_INSUFFICIENT');
  assert.equal(result.decision_band,'DATA_INSUFFICIENT');
});


test('Radar 8 keeps a ticker with missing daily change so it can be labeled DATA_INSUFFICIENT',async()=>{
  const radar=new EarlyExpansionRadar({
    rest:{request:async()=>({data:[{symbol:'MISSINGUSDT',lastPrice:'1.25',quoteVolume:'2500000',count:'12000',highPrice:'1.3',lowPrice:'1.1'}],source:'fixture'})},
    store:{},clock:()=>1_900_000_000_000,logger:{warn(){}}
  });
  const result=await radar.tickerRows();
  assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].symbol,'MISSINGUSDT');
  assert.equal(result.rows[0].priceChange24h,null);
});

test('Radar 9 keeps a ticker with missing daily change and preserves null in the fast pulse',async()=>{
  const radar=new FalconEyeRadar({
    rest:{request:async()=>({data:[{symbol:'MISSINGUSDT',lastPrice:'1.25',quoteVolume:'2500000',count:'12000',highPrice:'1.3',lowPrice:'1.1'}]}),klines:async()=>({candles:[]})},
    store:{},config:{fastMinQuoteVolume24h:100000,quote:'USDT'},clock:()=>1_900_000_000_000,logger:{warn(){}}
  });
  radar.universe=['MISSINGUSDT'];
  const rows=await radar.tickerRows();
  assert.equal(rows.length,1);
  assert.equal(rows[0].priceChange24h,null);
  assert.equal(rows[0].market_pulse.priceChange24h,null);
  assert.equal(radar.selectBatch(rows).some(x=>x.symbol==='MISSINGUSDT'),true);
});
