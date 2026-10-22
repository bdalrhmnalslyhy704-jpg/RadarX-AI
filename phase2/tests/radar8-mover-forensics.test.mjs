import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReplayFastSnapshot,
  classifyForRadar8MoverForensics,
  evaluateProposedExtendedContinuationWatch,
  firstClosedCandleCrossing,
  minutesBeforeClosedCandleCrossing
} from '../core/radar8-mover-forensics.mjs';

test('Radar 8 replay fast features stay unknown until a measurable baseline exists',()=>{
  let history=[];
  let result=buildReplayFastSnapshot({lastPrice:100,quoteVolume24h:1000,tradeCount24h:100},history,1000);
  assert.equal(result.fast.warmed_up,false);
  assert.equal(result.fast.volume_accel_ratio,null);
  assert.equal(result.fast.trade_accel_ratio,null);
  history=result.history;

  result=buildReplayFastSnapshot({lastPrice:100.1,quoteVolume24h:1100,tradeCount24h:110},history,61000);
  assert.equal(result.fast.warmed_up,true);
  assert.equal(result.fast.volume_accel_ratio,null);
  history=result.history;

  result=buildReplayFastSnapshot({lastPrice:100.3,quoteVolume24h:1300,tradeCount24h:130},history,121000);
  assert.equal(result.fast.warmed_up,true);
  assert.equal(result.fast.volume_accel_ratio,2);
  assert.equal(result.fast.trade_accel_ratio,2);
  assert.ok(Number.isFinite(result.fast.price_acceleration_pct));
});

test('Radar 8 replay does not turn missing ticker deltas into false activity spikes',()=>{
  const first=buildReplayFastSnapshot({lastPrice:10,quoteVolume24h:null,tradeCount24h:null},[],1000);
  const second=buildReplayFastSnapshot({lastPrice:10.1,quoteVolume24h:null,tradeCount24h:null},first.history,61000);
  assert.equal(second.fast.volume_delta_quote,null);
  assert.equal(second.fast.trade_delta,null);
  assert.equal(second.fast.volume_accel_ratio,null);
  assert.equal(second.fast.trade_accel_ratio,null);
});

test('CYPHB is labeled as a tokenized bStock security, not a native crypto token',()=>{
  assert.equal(classifyForRadar8MoverForensics('CYPHBUSDT'),'BINANCE_BSTOCK_TOKENIZED_SECURITY');
  assert.equal(classifyForRadar8MoverForensics('IOSTUSDT'),'CRYPTO_SPOT_TOKEN');
});

test('closed-candle crossing uses observed high and ignores incomplete/future candles',()=>{
  const candles=[
    {openTime:0,closeTime:59999,high:104,closed:true},
    {openTime:60000,closeTime:119999,high:105.5,closed:true},
    {openTime:120000,closeTime:179999,high:110,closed:false}
  ];
  assert.equal(firstClosedCandleCrossing(candles,{startTime:0,endTime:179999,baselinePrice:100,targetPct:5}),119999);
});

test('a signal on the target-crossing candle is not counted as an early detection',()=>{
  assert.equal(minutesBeforeClosedCandleCrossing(61000,119999),0.98);
  assert.equal(minutesBeforeClosedCandleCrossing(119999,119999),null);
  assert.equal(minutesBeforeClosedCandleCrossing(120000,119999),null);
});

test('proposed extended continuation watch catches resumed flow but never grants entry',()=>{
  const result=evaluateProposedExtendedContinuationWatch({
    ticker:{symbol:'IOSTUSDT',priceChange24h:35.7},
    fast:{warmed_up:true,price_change_pct:1.30,price_acceleration_pct:0.18,
      volume_accel_ratio:15.37,trade_accel_ratio:14.51},
    microFingerprint:{stage:'ANTI_CHASE',score:100,confirmation_count:9,closed_candles_only:true},
    fastActivityShockCandidate:true
  });
  assert.equal(result.eligible,true);
  assert.equal(result.watch_only,true);
  assert.equal(result.entry_eligible,false);
  assert.equal(result.proposed_only,true);
  assert.equal(result.policy,'DIAGNOSTIC_ONLY_DO_NOT_EMIT_PRODUCTION_PUSH_OR_AUTHORIZE_ENTRY');
});

test('proposed extended watch rejects stale/unwarmed, non-accelerating, or not-extended coins',()=>{
  const base={
    ticker:{priceChange24h:35},
    fast:{warmed_up:true,price_change_pct:0.8,price_acceleration_pct:0.1},
    microFingerprint:{stage:'ANTI_CHASE',score:90,confirmation_count:6,closed_candles_only:true},
    fastActivityShockCandidate:true
  };
  assert.equal(evaluateProposedExtendedContinuationWatch({...base,fast:{...base.fast,warmed_up:false}}).eligible,false);
  assert.equal(evaluateProposedExtendedContinuationWatch({...base,fast:{...base.fast,price_change_pct:0.1}}).eligible,false);
  assert.equal(evaluateProposedExtendedContinuationWatch({...base,ticker:{priceChange24h:7}}).eligible,false);
  assert.equal(evaluateProposedExtendedContinuationWatch({...base,fastActivityShockCandidate:false}).eligible,false);
  assert.equal(evaluateProposedExtendedContinuationWatch({...base,microFingerprint:{...base.microFingerprint,stage:'PRE_BREAK'}}).eligible,false);
});
