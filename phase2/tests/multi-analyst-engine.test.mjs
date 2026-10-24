import assert from 'node:assert/strict';
import {MULTI_ANALYST_NAMES,MULTI_ANALYST_ROLE_CONTRACT,analyzeMultiAnalystCandidate,MultiAnalystEngine,nextContinuousScanDelayMs,isMomentumLiquidityEligible,selectWithPriorityRotation,selectDiscoveryWithRadarReviewPriority,countAnalystEvidenceCoverage,buildMultiAnalystMarketMoverObservations} from '../core/multi-analyst-engine.mjs';

// Continuous analyst cycles target one minute start-to-start, subtracting the
// time spent scanning and never scheduling a negative delay after a slow cycle.
assert.equal(nextContinuousScanDelayMs(60000,0),60000);
assert.equal(nextContinuousScanDelayMs(60000,12500),47500);
assert.equal(nextContinuousScanDelayMs(60000,60000),0);
assert.equal(nextContinuousScanDelayMs(60000,93000),0);
assert.equal(nextContinuousScanDelayMs(1000,0),15000);
// The default 20-analyst deep pool is bounded for the small production container.
{
  const engine=new MultiAnalystEngine({rest:{request:async()=>({data:[]})}});
  assert.equal(engine.config.deepScanPool,12);
  assert.equal(engine.config.deepConcurrency,3);
}

assert.equal(isMomentumLiquidityEligible(1_000_000,2.5),true);
assert.equal(isMomentumLiquidityEligible(4_060_000,2.6),true);
assert.equal(isMomentumLiquidityEligible(999_999,3.2),false);
assert.equal(isMomentumLiquidityEligible(4_060_000,2.49),false);
assert.equal(isMomentumLiquidityEligible('N/A',4.0),false);

function candle(i,{tf='15m',base=100,trend=0.001,volume=1000}={}){
  const openTime=i*900000,close=base*(1+trend*i);
  const open=base*(1+trend*Math.max(0,i-1));
  const high=Math.max(open,close)*1.002,low=Math.min(open,close)*.998;
  return {openTime,open,high,low,close,volume,closeTime:openTime+899000,closed:true,takerBuyBaseVolume:volume*.56};
}
function series(count,{base=100,trend=.001}={}){
  return Array.from({length:count},(_,i)=>candle(i,{base,trend,volume:1000+(i%7)*50}));
}
function rawFor({valid=true,price=130,liq=85,dq=100}={}){
  const s15=series(120,{base:100,trend:.0019});
  const s1=series(100,{base:100,trend:.002});
  const s4=series(60,{base:100,trend:.003});
  if(!valid)s15[s15.length-1].closeTime=Date.now()+3600000;
  return {
    symbol:'TESTUSDT',last_price:price,price_change_24h:6,high_price_24h:135,low_price_24h:96,quote_volume_24h:2000000,
    liquidity_quality:liq,data_quality:dq,accepted_strategies:['A','B','C'],
    coverage:{strategy_count:14},best_strategy:'TEST',risk_flags:[],
    strategies:Array.from({length:14},(_,i)=>({score:{value:70+i%4}})),
    _analysis:{
      completedAt:Date.now(),series:{'4h':s4,'1h':s1,'15m':s15},
      depth:{bids:[['129.9','1000'],['129.8','900'],['129.5','800']],asks:[['130.1','500'],['130.3','450'],['130.5','400']]},
      liquidity:{quality:liq,spreadBps:5},
      evaluation:[]
    }
  };
}

assert.equal(MULTI_ANALYST_NAMES.length,20);
assert.equal(MULTI_ANALYST_ROLE_CONTRACT.length,19,'exactly 19 specialist functions must precede the final analyst');
assert.equal(new Set(MULTI_ANALYST_ROLE_CONTRACT.map(x=>x.role)).size,19,'all specialist roles must be distinct');
const sharedTestMarket={btc15:series(120,{base:90,trend:.0008}),btc1:series(100,{base:90,trend:.0008}),marketMedian24h:1,breadthPct:62,snapshot_id:'TEST-SPOT-SNAPSHOT-1',as_of:Date.now(),snapshot_source:'TEST'};
const good=analyzeMultiAnalystCandidate(rawFor(),sharedTestMarket);
assert.equal(good.specialist.a.length,19);
assert.equal(new Set(good.specialist.a.map(x=>x.role)).size,19,'all 19 specialists must return unique roles');
assert.deepEqual([...good.specialist.a.map(x=>x.role)].sort(),MULTI_ANALYST_ROLE_CONTRACT.map(x=>x.role).sort(),'the returned team must implement the declared specialist contract');
assert.equal(good.specialist.sharedSnapshot.available,true,'specialists must share one timestamped market context');
assert.equal(good.final.decision,'REJECT','specialist agreement cannot override invalid or incomplete market data');
assert.ok(good.final.hardReasons.includes('DATA_GATE_FAILED'));
assert.ok(good.final.hardReasons.includes('CANDLE_COVERAGE_INCOMPLETE'),'missing/stale/gapped closed candles must be a hard block');
assert.equal(good.final.totalAnalysts,19);
assert.ok(['STRONG_CANDIDATE','CANDIDATE','WATCH','REJECT'].includes(good.final.verdict));
assert.ok(Number.isFinite(good.final.score));
assert.ok(Number.isFinite(good.final.early_score));
assert.ok(Number.isFinite(good.final.agreement));
assert.ok(['RISK_ON','RISK_OFF','MIXED'].includes(good.final.market_regime));
assert.ok(['EARLY_SETUP','CONFIRMING_SETUP','EXTENDED','BEARISH','NO_SETUP'].includes(good.final.timing));
assert.ok(Object.prototype.hasOwnProperty.call(good.final,'self_calibration'));
assert.ok(Number.isFinite(good.final.setup_fingerprint));
assert.ok(Number.isFinite(good.final.evidence_coverage));
assert.ok(good.final.group_consensus && Object.keys(good.final.group_consensus).length >= 10);
assert.equal(good.final.totalAnalysts, 19);
assert.equal(good.specialist.a.length, 19);
assert.ok(good.specialist.a.every(function(a){return typeof a.group==='string'&&Number.isFinite(Number(a.score))&&Number.isFinite(Number(a.coverage));}));


const badData=analyzeMultiAnalystCandidate(rawFor({valid:false,dq:40}),{});
assert.equal(badData.final.verdict,'REJECT');
assert.ok(badData.final.hardReasons.includes('DATA_GATE_FAILED'));

const badLiq=analyzeMultiAnalystCandidate(rawFor({liq:20}),{});
assert.equal(badLiq.final.verdict,'REJECT');
assert.ok(badLiq.final.hardReasons.includes('LIQUIDITY_TOO_WEAK'));


console.log('multi-analyst-engine.test.mjs: PASS');

// A fixed priority head is retained while lower-ranked wake/quiet candidates rotate.
{
  const rows=Array.from({length:12},(_,i)=>({symbol:'QUIET'+String(i).padStart(2,'0')+'USDT'}));
  const seen=new Set();
  let cursor=0;
  for(let cycle=0;cycle<3;cycle++){
    const selected=selectWithPriorityRotation(rows,6,cursor);
    assert.deepEqual(selected.rows.slice(0,3).map(x=>x.symbol),
      ['QUIET00USDT','QUIET01USDT','QUIET02USDT'],
      'top-ranked opportunities must remain in every cycle');
    for(const row of selected.rows.slice(3))seen.add(row.symbol);
    cursor=selected.nextCursor;
  }
  assert.equal(seen.size,9,'the rotating half should expose all nine lower-ranked candidates in three cycles');
}
console.log('multi-analyst fair candidate rotation: PASS');



// Regression: a discovered coin must not disappear before the 19-specialist lab.
// Invalid data is handled fail-closed by the final judge, but remains visible as a rejected lab result.
{
  let exchangeInfoCalls=0,tickerCalls=0;
  const engine = new MultiAnalystEngine({
    rest: {request: async () => ({data: []})},
    config: {discoveryPool: 1, returnLimit: 1, deepConcurrency: 1,universeRefreshMs:30*60*1000}
  });
  engine.scanner = {
    exchangeInfo: async () => {
      exchangeInfoCalls++;
      return ({
      data: {symbols: [
        {symbol:'TESTUSDT',baseAsset:'TEST',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']}
      ]},
      source: 'TEST'
      });
    },
    ticker24h: async () => {
      tickerCalls++;
      return ({
      data: [{
        symbol:'TESTUSDT',lastPrice:'1',quoteVolume:'1000000',count:'1000',
        priceChangePercent:'1',highPrice:'1.1',lowPrice:'0.9',closeTime:Date.now()
      }],
      source:'TEST'
      });
    },
    scanSymbol: async () => ({
      symbol:'TESTUSDT',rank:1,last_price:1,price_change_24h:1,
      quote_volume_24h:1000000,liquidity_quality:0,data_quality:0,
      accepted_strategies:[],best_strategy:null,risk_flags:['LIQUIDITY_DATA_UNAVAILABLE'],
      reason_codes:['INSUFFICIENT_CLOSED_DATA','LIQUIDITY_GATE_FAILED'],
      invalidation:['CANDLE_GAP_OR_INTEGRITY_ERROR'],
      data_status:{data_valid:false,data_stale:false,last_error:'TEST_INVALID_DATA'},
      _analysis:{completedAt:Date.now(),series:{'4h':[],'1h':[],'15m':[]},depth:null}
    })
  };
  const out = await engine.scan({quote:'USDT',limit:1});
  assert.equal(out.universe.discovery_pool, 1);
  assert.equal(out.universe.scanned, 1);
  assert.equal(out.summary.rejected, 1);
  assert.equal(out.candidates.length, 0);
  assert.equal(out.watchlist.length, 0);
  assert.equal(out.lab_results.length, 1);
  assert.equal(out.lab_results[0].symbol, 'TESTUSDT');
  assert.equal(out.lab_results[0].verdict, 'REJECT');
  assert.equal(out.lab_results[0].data_status.data_valid, false);
  assert.match(out.lab_results[0].data_status.last_error, /TEST_INVALID_DATA/);
  assert.equal(out.summary.rejected, 1);
  assert.equal(out.diagnostics.attempted_analyses, 1);
  assert.equal(out.diagnostics.successful_analyses, 0);
  assert.equal(out.diagnostics.gate_rejected, 1);
  assert.equal(exchangeInfoCalls,1,'the live Spot universe is fetched initially');
  assert.equal(tickerCalls,1,'ticker data is fetched for the analysis');
  const cached=await engine.scan({quote:'USDT',limit:1});
  assert.equal(cached.as_of,out.as_of,'normal request may reuse unexpired snapshot');
  assert.equal(tickerCalls,1,'normal request may reuse unexpired completed analysis');
  const forced=await engine.scan({quote:'USDT',limit:1,forceRefresh:true,requestId:'forced-test-2'});
  assert.equal(tickerCalls,2,'forced request bypasses analysis result TTL');
  assert.equal(exchangeInfoCalls,1,'universe refresh cadence is independent of forced market scans');
  assert.equal(forced.meta.force_refresh_requested,true);
  assert.equal(forced.meta.request_id,'forced-test-2');
  assert.equal(forced.meta.analysis_mode,'FORCED_SCAN');
}

console.log('multi-analyst-engine lab-entry regression: PASS');

// Regression: a strategy-pipeline runtime error must not delete a discovered coin.
// The scanner returns the coin as a fail-closed lab rejection with the error attached.
{
  const base15=series(120,{base:100,trend:.001});
  const base1=series(100,{base:100,trend:.001});
  const base4=series(60,{base:100,trend:.001});
  const rawKlines=(xs)=>xs.map(x=>[
    x.openTime,String(x.open),String(x.high),String(x.low),String(x.close),String(x.volume),
    x.closeTime,String(x.volume),1000,String(x.takerBuyBaseVolume),String(x.takerBuyBaseVolume)
  ]);
  const scannerRest={
    request:async(path)=>{
      if(path==='/api/v3/exchangeInfo')return {data:{symbols:[
        {symbol:'TESTUSDT',baseAsset:'TEST',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']}
      ]},source:'TEST'};
      if(path==='/api/v3/ticker/24hr')return {data:[{
        symbol:'TESTUSDT',lastPrice:String(base15.at(-1).close),quoteVolume:'2000000',count:'5000',
        priceChangePercent:'1',highPrice:'101',lowPrice:'99',closeTime:Date.now()
      }],source:'TEST'};
      throw new Error('UNEXPECTED_REQUEST:'+path);
    },
    klines:async(symbol,interval)=>({candles:interval==='15m'?base15:interval==='1h'?base1:base4,source:'TEST'}),
    depth:async()=>({data:{
      bids:[['99.9','5000'],['99.8','4000']],asks:[['100.1','2000'],['100.2','1500']]
    },source:'TEST'})
  };
  const engineWithStrategyError=new MultiAnalystEngine({
    rest:scannerRest,
    config:{discoveryPool:1,returnLimit:1,deepConcurrency:1,deepKlines:120},
  });
  engineWithStrategyError.scanner.strategyEvaluator=()=>{throw new Error('SIMULATED_STRATEGY_PIPELINE_ERROR');};
  const out=await engineWithStrategyError.scan({quote:'USDT',limit:1});
  assert.equal(out.universe.scanned,1);
  assert.equal(out.candidates.length,0);
  assert.equal(out.watchlist.length,0);
  assert.equal(out.diagnostics.gate_rejected,1);
  assert.match(String(out.diagnostics.gate_rejections[0].last_error||''),/STRATEGY_PIPELINE_FAILED/);
  assert.equal(out.diagnostics.failed_analyses,0);
  assert.equal(out.diagnostics.gate_rejected,1);
}

console.log('multi-analyst-engine runtime-error regression: PASS');

// Regression: an unexpected scan-construction failure must fail closed without dropping the discovered symbol.
{
  const base15=series(120,{base:100,trend:.001});
  const base1=series(100,{base:100,trend:.001});
  const base4=series(60,{base:100,trend:.001});
  const scanner=new (await import('../market/universe-scanner.mjs')).MarketUniverseScanner({
    rest:{
      request:async()=>({data:[],source:'TEST'}),
      klines:async(symbol,interval)=>({candles:interval==='15m'?base15:interval==='1h'?base1:base4,source:'TEST'}),
      depth:async()=>({data:{bids:[['99.9','5000']],asks:[['100.1','2000']]},source:'TEST'})
    },
    config:{deepKlines:120}
  });
  scanner.computeLiquidity=()=>{throw new Error('SIMULATED_LIQUIDITY_COMPUTATION_ERROR');};
  const row=await scanner.scanSymbol(
    {symbol:'TESTUSDT',rank:1,lastPrice:100,priceChange24h:1,highPrice24h:101,lowPrice24h:99,quoteVolume24h:2000000,tradeCount24h:5000},
    1,
    {exchangeInfo:'TEST',ticker:'TEST'},
    {klinesLimit:120,includeAnalysisPayload:true}
  );
  assert.equal(row.data_status.data_valid,false);
  assert.match(String(row.data_status.last_error||''),/LIQUIDITY_COMPUTATION_FAILED/);
  assert.ok(row._analysis && row._analysis.series['15m'].length===120);
}

console.log('multi-analyst scan fail-closed regression: PASS');

// Regression: the multi-analyst scan requests the internal analysis payload;
// candidate construction must expose evaluated strategies without throwing.
{
  const base15=series(120,{base:100,trend:.001});
  const base1=series(100,{base:100,trend:.001});
  const base4=series(60,{base:100,trend:.001});
  const scanner=new (await import('../market/universe-scanner.mjs')).MarketUniverseScanner({
    rest:{
      request:async()=>({data:[],source:'TEST'}),
      klines:async(symbol,interval)=>({candles:interval==='15m'?base15:interval==='1h'?base1:base4,source:'TEST'}),
      depth:async()=>({data:{bids:[['99.9','5000'],['99.8','4000']],asks:[['100.1','2000'],['100.2','1500']]},source:'TEST'})
    },
    config:{deepKlines:120}
  });
  const row=await scanner.scanSymbol(
    {symbol:'TESTUSDT',rank:1,lastPrice:100,priceChange24h:1,highPrice24h:101,lowPrice24h:99,quoteVolume24h:2000000,tradeCount24h:5000},
    1,
    {exchangeInfo:'TEST',ticker:'TEST'},
    {klinesLimit:120,includeAnalysisPayload:true}
  );
  assert.ok(row._analysis);
  assert.ok(Array.isArray(row._analysis.evaluation));
  assert.equal(row.data_status.last_error,null);
}

console.log('multi-analyst scan payload regression: PASS');



// Build 224 radar alerts are queued for a later bounded analyst review without
// changing the original notification. Queue deduplication and capacity stay bounded.
{
  let now=1_800_000_000_000;
  const engine=new MultiAnalystEngine({
    rest:{request:async()=>({data:[]})},
    clock:()=>now,
    config:{radarReviewMaxQueue:2,radarReviewSlotsPerCycle:1,radarReviewQueueTtlMs:10000}
  });
  assert.equal(engine.enqueueRadarReview('BTCUSDT',{sourceRadar:'RADAR1'}).queued,true);
  assert.equal(engine.enqueueRadarReview('BTCUSDT',{sourceRadar:'RADAR8'}).already_queued,true);
  assert.equal(engine.enqueueRadarReview('ETHUSDT',{sourceRadar:'RADAR9'}).queued,true);
  let snapshot=engine.radarReviewQueueSnapshot();
  assert.equal(snapshot.pending_count,2);
  assert.deepEqual(snapshot.pending_reviews[0].source_radars,['RADAR1','RADAR8']);
  assert.equal(engine.enqueueRadarReview('SOLUSDT',{sourceRadar:'RADAR11'}).queued,true);
  snapshot=engine.radarReviewQueueSnapshot();
  assert.equal(snapshot.pending_count,2);
  assert.deepEqual(snapshot.pending_reviews.map(x=>x.symbol),['ETHUSDT','SOLUSDT']);
  assert.equal(engine.enqueueRadarReview('NOT/A/SYMBOL',{sourceRadar:'RADAR1'}).queued,false);
  now+=11000;
  assert.equal(engine.radarReviewQueueSnapshot().pending_count,0);
}

console.log('multi-analyst radar-review queue bounds/dedupe/expiry: PASS');

// Expose whether every named specialist and the final judge actually ran; a list
// of 19 placeholder analysts must never be recorded as a complete result.
{
  let now=1_800_000_100_000;
  const engine=new MultiAnalystEngine({
    rest:{request:async()=>({data:[]})},clock:()=>now,
    config:{radarReviewAssessmentTtlMs:60000}
  });
  const analysts=Array.from({length:19},(_,i)=>({id:'SPECIALIST_'+String(i+1).padStart(2,'0'),score:75,direction:'LONG'}));
  engine._recordLatestAssessment({
    symbol:'TESTUSDT',verdict:'WATCH',direction:'LONG',final_score:76,
    analysts,analyst_execution:{specialists_complete:true,final_analyst_complete:true,analysis_failed:false},
    final_judge:{sniper_score:79,hardReasons:[]},intelligence:{early_score:74,analyst_agreement:82},
    data_status:{data_valid:true},reason_codes:[]
  },now);
  const result=engine.latestAssessments({symbols:['TESTUSDT']})[0];
  assert.ok(result);
  assert.equal(result.specialists_complete,true);
  assert.equal(result.final_analyst_complete,true);
  assert.equal(result.unique_specialists,19);
  assert.equal(result.data_valid,true);
  now+=61000;
  assert.equal(engine.getLatestAssessment('TESTUSDT'),null);
}

console.log('multi-analyst role-completion evidence/freshness: PASS');


// Queued radar alerts get first access to existing deep-analysis slots, with no
// duplicated symbols and the ordinary round-robin universe kept behind them.
{
  const priority=[
    {symbol:'GTCUSDT',_radar_review_priority:true},
    {symbol:'BTCUSDT',_radar_review_priority:true},
    {symbol:'GTCUSDT',_radar_review_priority:true}
  ];
  const buckets=[
    [{symbol:'BTCUSDT'},{symbol:'BNBUSDT'}],
    [{symbol:'ETHUSDT'},{symbol:'SOLUSDT'}],
    [{symbol:'XRPUSDT'}]
  ];
  const selected=selectDiscoveryWithRadarReviewPriority(priority,buckets,5);
  assert.deepEqual(selected.map(x=>x.symbol),['GTCUSDT','BTCUSDT','ETHUSDT','XRPUSDT','BNBUSDT']);
  assert.deepEqual(buckets[0].map(x=>x.symbol),['BTCUSDT','BNBUSDT'],'input buckets must not be mutated');
  assert.equal(new Set(selected.map(x=>x.symbol)).size,selected.length);
  assert.deepEqual(selectDiscoveryWithRadarReviewPriority(priority,buckets,1).map(x=>x.symbol),['GTCUSDT']);
  const underfilled=selectDiscoveryWithRadarReviewPriority(
    [{symbol:'GTCUSDT'}],
    [[{symbol:'BTCUSDT'}],[{symbol:'ETHUSDT'}]],
    5,
    [{symbol:'BTCUSDT'},{symbol:'ETHUSDT'},{symbol:'ADAUSDT'},{symbol:'SOLUSDT'}]
  );
  assert.deepEqual(underfilled.map(x=>x.symbol),['GTCUSDT','BTCUSDT','ETHUSDT','ADAUSDT','SOLUSDT'],
    'fallback rows must fill unused scan slots without duplicating bucket symbols');
}

console.log('multi-analyst queued radar priority/capacity preservation: PASS');


// Missing/null/blank evidence must not inflate the analysts' own coverage score.
{
  const coverage=countAnalystEvidenceCoverage({missing:null,blank:' ',flag:false,zero:0,nested:{missing:null,score:82}});
  assert.deepEqual(coverage,{used:2,total:5});
  const allMissing=countAnalystEvidenceCoverage({price:null,volume:'',signal:false});
  assert.deepEqual(allMissing,{used:0,total:3});
}
console.log('analyst evidence integrity regression: PASS');

// High 24h movement remains visible even if a symbol did not enter the deep analyst pool.
{
  const rows=[
    {symbol:'BMTUSDT',lastPrice:.04163,priceChange24h:46.33,quoteVolume24h:36550000,count:20000},
    {symbol:'ERAUSDT',lastPrice:.096,priceChange24h:40.97,quoteVolume24h:20400000,count:18000},
    {symbol:'KATUSDT',lastPrice:.00459,priceChange24h:15.04,quoteVolume24h:4840000,count:5000},
    {symbol:'FLATUSDT',lastPrice:1,priceChange24h:2,quoteVolume24h:1000000,count:1000}
  ];
  const analysed=[{
    symbol:'KATUSDT',verdict:'REJECT',final_score:42,
    data_quality:95,liquidity_quality:90,
    analyst_execution:{specialist_count:19,analysis_failed:false},
    reason_codes:['NO_EARLY_SETUP'],
    final_judge:{hardReasons:['BUY_FLOW_NOT_CONFIRMED']}
  }];
  const out=buildMultiAnalystMarketMoverObservations(rows,analysed,{limit:10,minQuoteVolume24h:300000});
  assert.deepEqual(out.map(x=>x.symbol),['BMTUSDT','ERAUSDT','KATUSDT']);
  assert.equal(out[0].price_change_24h,46.33);
  assert.equal(out[0].stage,'ALREADY_EXTENDED');
  assert.equal(out[0].analysis_status,'NOT_DEEP_SCANNED_THIS_CYCLE');
  assert.equal(out[1].entry_eligible,false);
  assert.equal(out[2].analysis_status,'ANALYZED_THIS_CYCLE');
  assert.equal(out[2].analyst_verdict,'REJECT');
  assert.ok(out.every(x=>x.diagnostic_only===true&&x.watch_only===true&&x.entry_eligible===false));
}
console.log('multi-analyst ticker-mover visibility regression: PASS');



// Per-horizon calibration must use its own closed candle, not a much later ticker price.
{
  const engine=new MultiAnalystEngine({rest:{request:async()=>({data:[]})}});
  const asOf=1_900_000_000_000;
  const at=(minutes,close)=>({closed:true,openTime:asOf+minutes*60_000-15*60_000+1,
    closeTime:asOf+minutes*60_000,open:100,high:Math.max(100,close)+0.2,low:Math.min(100,close)-0.2,
    close,volume:1000});
  engine.pendingOutcomes.set('TESTUSDT',[{
    symbol:'TESTUSDT',entryPrice:100,direction:'LONG',earlyScore:80,asOf,
    analysts:[{id:'PRE_BREAKOUT',direction:'LONG',score:90}],
    evaluated:{'15m':false,'1h':false,'4h':false}
  }]);
  engine._settleOutcome('TESTUSDT',asOf+7*60*60*1000,[at(15,100.5),at(60,101.5),at(240,104.5)]);
  const self=engine.calibration.summary().find(x=>x.id==='PRE_BREAKOUT');
  assert.ok(self,'analyst calibration should have a sample from the matured 4h horizon');
  assert.equal(self.wins,1,'only the 4h candle reaches its own +4% target');
  assert.equal(self.losses,0);
  assert.equal(self.neutral,2,'the 15m and 1h markouts remain neutral at their own horizons');
  assert.equal(self.samples,1);
  assert.equal(engine.pendingOutcomes.has('TESTUSDT'),false,'matured work items should release their memory');
}
console.log('per-horizon analyst self-calibration regression: PASS');
