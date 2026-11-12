import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_EARLY_RISER_OUTCOME_SOURCE,
  DAILY_EARLY_RISER_HORIZON_BARS,
  classifyDailyEarlyRiserFirstPassage,
  classifyDailyEarlyRiserUpsideOpportunity,
  classifyDailyEarlyRiserDrawdownRisk,
  classifyDailyEarlyRiserTargetSet,
  buildDailyEarlyRiserHistoricalSamples
} from '../core/daily-early-riser-census.mjs';
import {summarizeDailyTargetDiagnostics,auditSampleLabelHorizons} from '../tools/daily-early-riser-historical-census.mjs';

const INTERVAL=15*60*1000;
const FIVE=5*60*1000;

function candle(openTime,{
  open=100,high=100.2,low=99.8,close=100,
  quoteVolume=300_000,trades=1800,buyShare=0.55,interval=INTERVAL
}={}){
  return {
    openTime,open,high,low,close,closeTime:openTime+interval-1,
    quoteVolume,trades,takerBuyQuoteVolume:quoteVolume*buyShare
  };
}
function pathAfter(baseline,mutate=()=>{}){
  return Array.from({length:DAILY_EARLY_RISER_HORIZON_BARS},(_,index)=>{
    const openTime=baseline.closeTime+1+index*INTERVAL;
    const row=candle(openTime);
    return mutate(row,index)||row;
  });
}
function baselineCandle(){
  return candle(1_700_000_000_000);
}

test('daily +5% first passage is resolved only when it precedes the -2% adverse barrier',()=>{
  const baseline=baselineCandle();
  const future=pathAfter(baseline,(row,index)=>index===19
    ?{...row,high:105.1,low:99.2,close:104.8}:row);
  const result=classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:future,targetPct:5,adversePct:2
  });
  assert.equal(result.status,'RESOLVED');
  assert.equal(result.outcome,'UP');
  assert.equal(result.first_touch_index,19);
  assert.equal(result.time_to_first_touch_minutes,300);
  assert.equal(result.outcome_source,DAILY_EARLY_RISER_OUTCOME_SOURCE);
  assert.equal(result.horizon_bars,96);
});

test('a later daily surge remains a market-move event after the adverse barrier was already hit',()=>{
  const baseline=baselineCandle();
  const future=pathAfter(baseline,(row,index)=>{
    if(index===3)return {...row,low:97.8,high:100.5,close:98.1};
    if(index===38)return {...row,low:99,high:106,close:105.2};
    return row;
  });
  const result=classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:future,targetPct:5,adversePct:2
  });
  assert.equal(result.status,'RESOLVED');
  assert.equal(result.outcome,'DOWN',
    'tradeable first-passage outcome remains DOWN because the adverse barrier came first');
  assert.equal(result.market_move_event.status,'RESOLVED');
  assert.equal(result.market_move_event.outcome,'UP',
    'the daily census must still count the later +5% market move');
  assert.equal(result.market_move_event.target_touch_after_adverse_barrier,true);
  assert.equal(result.market_move_event.first_touch_index,38);
});

test('same-bar target and adverse touch is ambiguous for tradeability but still confirms a market move',()=>{
  const baseline=baselineCandle();
  const future=pathAfter(baseline,(row,index)=>index===8
    ?{...row,high:106,low:97,close:100}:row);
  const result=classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:future,targetPct:5,adversePct:2
  });
  assert.equal(result.status,'AMBIGUOUS');
  assert.equal(result.market_move_event.outcome,'UP');
  assert.equal(result.market_move_event.target_and_adverse_touched_same_15m_candle,true);
});

test('daily first passage labels an earlier adverse barrier as DOWN',()=>{
  const baseline=baselineCandle();
  const future=pathAfter(baseline,(row,index)=>index===3
    ?{...row,low:97.9,high:101.1,close:98.2}:row);
  const result=classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:future,targetPct:5,adversePct:2
  });
  assert.equal(result.status,'RESOLVED');
  assert.equal(result.outcome,'DOWN');
  assert.equal(result.market_move_event.outcome,'FLAT',
    'an adverse-first path with no later target touch is not a daily gainer event');
  assert.equal(result.first_touch_index,3);
});

test('same 15m candle touching both target and adverse barrier is ambiguous, never a win',()=>{
  const baseline=baselineCandle();
  const future=pathAfter(baseline,(row,index)=>index===7
    ?{...row,high:105.5,low:97.5,close:101}:row);
  const result=classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:future,targetPct:5,adversePct:2
  });
  assert.equal(result.status,'AMBIGUOUS');
  assert.equal(result.outcome,'AMBIGUOUS');
  assert.equal(result.reason,'TARGET_AND_ADVERSE_BARRIER_TOUCHED_IN_SAME_15M_CANDLE');
});

test('daily first passage rejects a missing candle or a path gap instead of inventing a label',()=>{
  const baseline=baselineCandle();
  const complete=pathAfter(baseline);
  const gap=complete.map((row,index)=>index===12
    ?{...row,openTime:row.openTime+INTERVAL,closeTime:row.closeTime+INTERVAL}:row);
  assert.equal(classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:complete.slice(0,95),targetPct:5
  }).reason,'INCOMPLETE_24H_PATH');
  assert.equal(classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:gap,targetPct:5
  }).reason,'FUTURE_CANDLE_GAP_OR_BAD_CLOSE_TIME');
});

test('multi-target labels are resolved independently without collapsing +5%, +10% and +15%',()=>{
  const baseline=baselineCandle();
  const future=pathAfter(baseline,(row,index)=>index===11
    ?{...row,high:106,low:99,close:105.5}:row);
  const result=classifyDailyEarlyRiserTargetSet({
    baseline,future15m:future,targetsPct:[5,10,15],adversePct:2
  });
  assert.equal(result.targets.plus_5_pct.outcome,'UP');
  assert.equal(result.targets.plus_10_pct.outcome,'FLAT');
  assert.equal(result.targets.plus_15_pct.outcome,'FLAT');
  assert.equal(result.status,'RESOLVED');
});

test('historical daily census uses closed baseline features, one non-overlapping anchor per day, and future-only labels',()=>{
  const count=1800;
  const base=Math.floor(1_700_000_000_000/INTERVAL)*INTERVAL;
  const fifteen=Array.from({length:count},(_,index)=>{
    const price=100+index*0.01;
    return candle(base+index*INTERVAL,{open:price,high:price+0.2,low:price-0.2,close:price});
  });
  const fast=Array.from({length:count*3},(_,index)=>candle(base+index*FIVE,{
    interval:FIVE,quoteVolume:100_000,trades:600,high:100.1,low:99.9
  }));
  const btc=Array.from({length:count},(_,index)=>candle(base+index*INTERVAL,{
    quoteVolume:2_000_000,trades:12_000
  }));
  const now=base+count*INTERVAL+60_000;
  const result=buildDailyEarlyRiserHistoricalSamples({
    symbol:'CENSUSUSDT',
    klines:{data:fifteen,source:'BINANCE_OFFICIAL_ARCHIVE'},
    fastKlines:{data:fast,source:'BINANCE_OFFICIAL_ARCHIVE'},
    btcKlines:{data:btc,source:'BINANCE_OFFICIAL_ARCHIVE'},
    now,minQuoteVolume24h:750_000,maxSamplesPerSymbol:40
  });
  assert.equal(result.audit.status,'READY');
  assert.ok(result.samples.length>=8,JSON.stringify(result.audit));
  assert.equal(result.audit.non_overlapping_24h_labels,true);
  assert.equal(result.audit.overlap_violations,0);
  assert.ok(result.samples.every(row=>row.at<row.targets.plus_5_pct.resolved_at));
  assert.ok(result.samples.every(row=>row.feature_information_cutoff_at===row.at));
  assert.ok(result.samples.every(row=>row.outcome_source===DAILY_EARLY_RISER_OUTCOME_SOURCE));
  assert.ok(result.samples.every(row=>row.targets.plus_5_pct.outcome==='FLAT'));
  assert.ok(result.samples.every(row=>row.targets.plus_10_pct.outcome==='FLAT'));
  assert.ok(result.samples.every(row=>row.targets.plus_15_pct.outcome==='FLAT'));
  assert.ok(result.samples.every(row=>row.features&&Number.isFinite(row.base_score)));
  for(const sample of result.samples){
    const index=fifteen.findIndex(row=>row.closeTime===sample.at);
    assert.ok(index>=96,'sample has an exact 24h prior close');
    const expected=(fifteen[index].close/fifteen[index-96].close-1)*100;
    assert.ok(Math.abs(sample.daily_change_pct-expected)<1e-5,
      '24h return must compare prices exactly 96 closed 15m bars apart');
  }
  assert.ok(result.samples.every(row=>row.temporal_sequence_available===true),
    'complete official 5m history should support the 24x29 temporal tensor');
});



function pathAfterBars(baseline,bars,mutate=()=>{}){
  return Array.from({length:bars},(_,index)=>{
    const openTime=baseline.closeTime+1+index*INTERVAL;
    const row=candle(openTime);
    return mutate(row,index)||row;
  });
}

test('72h upside opportunity remains positive after an earlier drawdown; risk is a separate label',()=>{
  const baseline=baselineCandle();
  const future=pathAfterBars(baseline,288,(row,index)=>{
    if(index===5)return {...row,low:97.5,high:100.4,close:98.1};
    if(index===210)return {...row,open:101.5,low:101,high:106.4,close:105.8};
    return row;
  });
  const upside=classifyDailyEarlyRiserUpsideOpportunity({
    baseline,future15m:future,targetPct:5,horizonHours:72
  });
  const risk=classifyDailyEarlyRiserDrawdownRisk({
    baseline,future15m:future,adversePct:2,horizonHours:72
  });
  assert.equal(upside.status,'RESOLVED');
  assert.equal(upside.outcome,'UP');
  assert.equal(upside.first_target_index,210);
  assert.equal(upside.independent_of_adverse_barrier,true);
  assert.equal(upside.horizon_hours,72);
  assert.equal(risk.status,'RESOLVED');
  assert.equal(risk.outcome,'DOWN');
  assert.equal(risk.first_drawdown_index,5);
  assert.equal(risk.horizon_hours,72);
  assert.equal(upside.resolved_at,baseline.closeTime+288*INTERVAL);
  assert.equal(risk.resolved_at,upside.resolved_at);
});

test('opportunity and drawdown labels reject incomplete long-horizon paths',()=>{
  const baseline=baselineCandle();
  const short=pathAfterBars(baseline,287);
  assert.equal(classifyDailyEarlyRiserUpsideOpportunity({
    baseline,future15m:short,targetPct:5,horizonHours:72
  }).reason,'INCOMPLETE_72H_PATH');
  assert.equal(classifyDailyEarlyRiserDrawdownRisk({
    baseline,future15m:short,adversePct:2,horizonHours:72
  }).reason,'INCOMPLETE_72H_PATH');
});

test('extended census can retain under-750k events for Micro Watch research without upgrading liquidity eligibility',()=>{
  const count=1500;
  const base=Math.floor(1_700_000_000_000/INTERVAL)*INTERVAL;
  const fifteen=Array.from({length:count},(_,index)=>{
    const price=100+index*0.001;
    return candle(base+index*INTERVAL,{
      open:price,high:price+0.1,low:price-0.1,close:price,
      quoteVolume:4_000,trades:40,buyShare:0.57
    });
  });
  const fast=Array.from({length:count*3},(_,index)=>candle(base+index*FIVE,{
    interval:FIVE,quoteVolume:1_000,trades:12,high:100.1,low:99.9
  }));
  const btc=Array.from({length:count},(_,index)=>candle(base+index*INTERVAL,{
    quoteVolume:2_000_000,trades:12_000
  }));
  const result=buildDailyEarlyRiserHistoricalSamples({
    symbol:'MICROUSDT',
    klines:{data:fifteen,source:'BINANCE_OFFICIAL_ARCHIVE'},
    fastKlines:{data:fast,source:'BINANCE_OFFICIAL_ARCHIVE'},
    btcKlines:{data:btc,source:'BINANCE_OFFICIAL_ARCHIVE'},
    now:base+count*INTERVAL+60_000,
    minQuoteVolume24h:0,
    opportunityHorizonsHours:[24,48,72],
    drawdownAdversePcts:[2,5],
    sampleStrideBars:288,
    maxSamplesPerSymbol:100
  });
  assert.equal(result.audit.status,'READY');
  assert.equal(result.audit.non_overlapping_max_opportunity_horizon_labels,true);
  assert.equal(result.audit.max_opportunity_horizon_hours,72);
  assert.equal(result.audit.anchor_stride_bars,288);
  assert.ok(result.samples.length>=3);
  assert.ok(result.samples.every(row=>row.quote_volume_24h<750_000));
  assert.ok(result.samples.every(row=>row.liquidity_lane==='MICRO_WATCH_ONLY_UNDER_750K'));
  for(const sample of result.samples){
    for(const hours of [24,48,72]){
      const key=hours+'h';
      assert.equal(sample.opportunity_targets[key].plus_5_pct.horizon_hours,hours);
      assert.equal(sample.drawdown_risks[key].minus_2_pct.horizon_hours,hours);
      assert.equal(sample.opportunity_targets[key].plus_5_pct.status,'RESOLVED');
      assert.equal(sample.drawdown_risks[key].minus_2_pct.status,'RESOLVED');
    }
  }
});

test('malformed future OHLC candles are rejected even when timestamps and numbers are finite',()=>{
  const baseline=baselineCandle();
  const future=pathAfter(baseline,(row,index)=>index===2?{...row,high:99.5}:row);
  const result=classifyDailyEarlyRiserFirstPassage({
    baseline,future15m:future,targetPct:5,adversePct:2
  });
  assert.equal(result.status,'INVALID');
  assert.equal(result.reason,'INVALID_FUTURE_CANDLE');
});


test('label audit rejects missing horizon labels and any incorrect under-floor liquidity lane',()=>{
  const at=1_800_000_000_000,volume=520_000;
  const targets={},opportunity_targets={},drawdown_risks={};
  for(const target of [5,10,15]){
    const key='plus_'+target+'_pct';
    targets[key]={
      status:'RESOLVED',outcome:'FLAT',resolved_at:at+24*60*60*1000,
      horizon_ms:24*60*60*1000,
      outcome_source:DAILY_EARLY_RISER_OUTCOME_SOURCE,
      target_definition:'FIRST_PASSAGE_PLUS_'+target+'_PCT_BEFORE_MINUS_2_PCT_24H_15M_V1'
    };
  }
  for(const hours of [24,48,72]){
    const h=hours+'h',ms=hours*60*60*1000;
    opportunity_targets[h]={};drawdown_risks[h]={};
    for(const target of [5,10,15]){
      const key='plus_'+target+'_pct';
      opportunity_targets[h][key]={
        status:'RESOLVED',outcome:'FLAT',resolved_at:at+ms,horizon_ms:ms,
        outcome_source:'BINANCE_OFFICIAL_CLOSED_15M_UPSIDE_TOUCH_HORIZONS_V1',
        target_definition:'ANY_UPSIDE_TOUCH_PLUS_'+target+'_PCT_WITHIN_'+hours+'H_15M_V1',
        independent_of_adverse_barrier:true
      };
    }
    for(const threshold of [2,5]){
      const key='minus_'+threshold+'_pct';
      drawdown_risks[h][key]={
        status:'RESOLVED',outcome:'FLAT',resolved_at:at+ms,horizon_ms:ms,
        outcome_source:'BINANCE_OFFICIAL_CLOSED_15M_INDEPENDENT_DRAWDOWN_HORIZONS_V1',
        target_definition:'ANY_DRAWDOWN_TOUCH_MINUS_'+threshold+'_PCT_WITHIN_'+hours+'H_15M_V1',
        independent_of_upside_barrier:true
      };
    }
  }
  const sample={
    id:'AUDITUSDT',symbol:'AUDITUSDT',at,quote_volume_24h:volume,
    liquidity_lane:'MICRO_WATCH_ONLY_UNDER_750K',
    targets,opportunity_targets,drawdown_risks
  };
  const clean=auditSampleLabelHorizons([sample]);
  assert.equal(clean.total,0,JSON.stringify(clean));
  delete sample.opportunity_targets['72h'].plus_10_pct;
  sample.liquidity_lane='STANDARD_750K_PLUS';
  const bad=auditSampleLabelHorizons([sample]);
  assert.equal(bad.opportunity_horizon_violations,1);
  assert.equal(bad.liquidity_lane_violations,1);
});

test('historical report keeps 72h upside events independent from drawdown and separates Micro Watch',()=>{
  const make=(id,score,up,lane,mae,mfe)=>{
    const target={status:'RESOLVED',outcome:up?'UP':'FLAT',
      time_to_target_minutes:up?210:null,max_favorable_excursion_pct:mfe,
      max_adverse_excursion_pct:mae};
    const risk={status:'RESOLVED',outcome:mae<=-2?'DOWN':'FLAT',
      time_to_drawdown_minutes:mae<=-2?90:null,
      max_adverse_excursion_pct:mae,max_favorable_excursion_pct:mfe};
    return {
      id,base_score:score,tier:'WATCH',liquidity_lane:lane,
      targets:{plus_5_pct:{
        status:'RESOLVED',outcome:'DOWN',time_to_first_touch_minutes:null,
        market_move_event:{status:'RESOLVED',outcome:'UP',time_to_target_minutes:210,
          target_touch_after_adverse_barrier:true,target_and_adverse_touched_same_15m_candle:false}
      }},
      opportunity_targets:{'72h':{plus_5_pct:target}},
      drawdown_risks:{'72h':{minus_2_pct:risk}}
    };
  };
  const summary=summarizeDailyTargetDiagnostics([
    make('micro-late-rally',0.9,true,'MICRO_WATCH_ONLY_UNDER_750K',-4.2,8.1),
    make('standard-steady',0.8,false,'STANDARD_750K_PLUS',-1.1,2.0),
    make('standard-rally',0.7,true,'STANDARD_750K_PLUS',-2.8,6.4),
    make('micro-no-touch',0.6,false,'MICRO_WATCH_ONLY_UNDER_750K',-0.8,1.2)
  ],5);
  const event=summary.independent_opportunity_and_drawdown_diagnostics['72h'].opportunity.plus_5_pct;
  assert.equal(event.eligible_samples,4);
  assert.equal(event.upside_events,2);
  assert.equal(event.no_touch_events,2);
  assert.equal(event.top_10_pct.precision_pct,100);
  assert.equal(event.top_10_pct.recall_pct,50);
  assert.equal(event.micro_watch_only.samples,2);
  assert.equal(event.micro_watch_only.upside_events,1);
  assert.equal(event.standard_750k_plus.samples,2);
  assert.equal(event.standard_750k_plus.upside_events,1);
  const risk=summary.independent_opportunity_and_drawdown_diagnostics['72h']
    .independent_drawdown_risk.minus_2_pct;
  assert.equal(risk.eligible_samples,4);
  assert.equal(risk.drawdown_events,2);
  assert.equal(risk.drawdown_rate_pct,50);
  assert.equal(summary.tradeable_first_passage.successful_event_count,0);
  assert.equal(summary.market_move_event.successful_event_count,4);
});

