import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {writeRawSpotKlineArchive} from '../core/neural-closure-raw-archive.mjs';
import {binanceServerRetryDelayMs} from '../core/binance-server-retry-policy.mjs';
import {selectBinanceSpotUsdtUniverse,verifyProspectiveUniverseCapture,verifyProspectiveCohortRowCoverage} from '../core/neural-closure-universe.mjs';
import {writeJsonObjectWithArrayStreaming} from '../core/neural-closure-json-writer.mjs';
import {
  NEURAL_CLOSURE_DATASET_SCHEMA,parseBinanceSpotKline,
  createNeuralClosureDecisionSchedule,buildNeuralClosureFeatureSnapshot,
  buildNeuralClosureHistoricalLiquiditySnapshot,
  buildNeuralClosureEventRow,verifyNeuralClosureRawCoverage
} from '../core/neural-closure-data-builder.mjs';
import {validateFourHourRows,NEURAL_CLOSURE_HORIZON_MS} from '../core/neural-closure-contracts.mjs';

const FIFTEEN=15*60_000,FIVE=5*60_000,MINUTE=60_000;
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


test('candidate prefilter includes every currently eligible Spot USDT pair above the liquidity floor and never top-N truncates',()=>{
  const symbols=[];
  const tickers=[];
  for(let index=0;index<125;index++){
    const base='ASSET'+String(index).padStart(3,'0');
    symbols.push({symbol:base+'USDT',baseAsset:base,quoteAsset:'USDT',
      status:'TRADING',isSpotTradingAllowed:true});
    tickers.push({symbol:base+'USDT',quoteVolume:String(900_000+index*1000),
      lastPrice:'1',priceChangePercent:'0'});
  }
  symbols.push({symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',
    status:'TRADING',isSpotTradingAllowed:true});
  tickers.push({symbol:'BTCUSDT',quoteVolume:'1000000000',lastPrice:'90000',
    priceChangePercent:'0'});
  symbols.push({symbol:'LOWUSDT',baseAsset:'LOW',quoteAsset:'USDT',
    status:'TRADING',isSpotTradingAllowed:true});
  tickers.push({symbol:'LOWUSDT',quoteVolume:'749999',lastPrice:'1',
    priceChangePercent:'0'});
  symbols.push({symbol:'USDCUSDT',baseAsset:'USDC',quoteAsset:'USDT',
    status:'TRADING',isSpotTradingAllowed:true});
  tickers.push({symbol:'USDCUSDT',quoteVolume:'9000000',lastPrice:'1',
    priceChangePercent:'0'});
  symbols.push({symbol:'OFFUSDT',baseAsset:'OFF',quoteAsset:'USDT',
    status:'BREAK',isSpotTradingAllowed:true});
  tickers.push({symbol:'OFFUSDT',quoteVolume:'9000000',lastPrice:'1',
    priceChangePercent:'0'});
  const result=selectBinanceSpotUsdtUniverse({symbols},tickers,{
    minimumQuoteVolume:750_000,maxSymbols:200,includeAllEligible:true
  });
  assert.equal(result.eligible.length,126);
  assert.equal(result.selected.length,126);
  assert.equal(result.selected.length,result.eligible.length);
  assert.equal(result.selected.some(item=>item.symbol==='BTCUSDT'),true);
  assert.equal(result.selected.some(item=>item.symbol==='LOWUSDT'),false);
  assert.equal(result.selected.some(item=>item.symbol==='USDCUSDT'),false);
  assert.equal(result.selected.some(item=>item.symbol==='OFFUSDT'),false);
  assert.throws(()=>selectBinanceSpotUsdtUniverse({symbols},tickers,{
    minimumQuoteVolume:750_000,maxSymbols:100,includeAllEligible:true
  }),/ELIGIBLE_UNIVERSE_EXCEEDS_CONFIGURED_MAX_SYMBOLS:126:100/);
  const legacy=selectBinanceSpotUsdtUniverse({symbols},tickers,{
    minimumQuoteVolume:750_000,maxSymbols:100,includeAllEligible:false
  });
  assert.equal(legacy.selected.length,100,
    'the legacy historical collector retains its top-N selection contract');
  assert.equal(legacy.selected.some(item=>item.symbol==='BTCUSDT'),true);
});

test('prospective candidate set ignores current ticker liquidity and ordering; eligibility is deferred to point-in-time history',()=>{
  const exchangeInfo={symbols:[
    {symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true},
    {symbol:'ETHUSDT',baseAsset:'ETH',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true},
    {symbol:'LOWUSDT',baseAsset:'LOW',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true},
    {symbol:'MISSINGUSDT',baseAsset:'MISSING',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true},
    {symbol:'USDCUSDT',baseAsset:'USDC',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true}
  ]};
  const tickers=[
    {symbol:'BTCUSDT',quoteVolume:'1000000000',lastPrice:'90000'},
    {symbol:'ETHUSDT',quoteVolume:'9000000',lastPrice:'3000'},
    {symbol:'LOWUSDT',quoteVolume:'1',lastPrice:'1'}
  ];
  const result=selectBinanceSpotUsdtUniverse(exchangeInfo,tickers,{
    minimumQuoteVolume:750_000,maxSymbols:10,includeAllEligible:true,
    historicalEligibilityOnly:true
  });
  assert.deepEqual(result.selected.map(item=>item.symbol),
    ['BTCUSDT','ETHUSDT','LOWUSDT','MISSINGUSDT']);
  assert.equal(result.selected.find(item=>item.symbol==='LOWUSDT').quote_volume_24h,1,
    'current quote volume is recorded only as a diagnostic and cannot exclude an historically liquid event');
  assert.equal(result.selected.find(item=>item.symbol==='MISSINGUSDT').quote_volume_24h,null,
    'a missing current ticker must not remove a pair from historical event eligibility');
  const changedTickers=tickers.map(item=>({...item,quoteVolume:String(Number(item.quoteVolume)*100)}));
  const changed=selectBinanceSpotUsdtUniverse(exchangeInfo,changedTickers,{
    minimumQuoteVolume:750_000,maxSymbols:10,includeAllEligible:true,
    historicalEligibilityOnly:true
  });
  assert.deepEqual(changed.selected.map(item=>item.symbol),
    result.selected.map(item=>item.symbol),
    'changing collection-time ticker volumes cannot change the candidate cohort or its order');
});

test('prospective universe includes exactly 500 eligible pairs and rejects 501 without truncation',()=>{
  const makeUniverse=count=>{
    const symbols=[];
    const tickers=[];
    for(let index=0;index<count-1;index++){
      const base='BOUND'+String(index).padStart(3,'0');
      symbols.push({symbol:base+'USDT',baseAsset:base,quoteAsset:'USDT',
        status:'TRADING',isSpotTradingAllowed:true});
      tickers.push({symbol:base+'USDT',quoteVolume:'900000',
        lastPrice:'1',priceChangePercent:'0'});
    }
    symbols.push({symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',
      status:'TRADING',isSpotTradingAllowed:true});
    tickers.push({symbol:'BTCUSDT',quoteVolume:'1000000000',
      lastPrice:'90000',priceChangePercent:'0'});
    return {exchangeInfo:{symbols},tickers};
  };

  const atCap=makeUniverse(500);
  const complete=selectBinanceSpotUsdtUniverse(atCap.exchangeInfo,atCap.tickers,{
    minimumQuoteVolume:750_000,maxSymbols:500,includeAllEligible:true
  });
  assert.equal(complete.eligible.length,500);
  assert.equal(complete.selected.length,500);
  assert.equal(complete.selected.length,complete.eligible.length);

  const overCap=makeUniverse(501);
  assert.throws(()=>selectBinanceSpotUsdtUniverse(
    overCap.exchangeInfo,overCap.tickers,{
      minimumQuoteVolume:750_000,maxSymbols:500,includeAllEligible:true
    }
  ),/ELIGIBLE_UNIVERSE_EXCEEDS_CONFIGURED_MAX_SYMBOLS:501:500/);
});

test('candidate prefilter fails closed when BTC or the exchange universe evidence is missing',()=>{
  assert.throws(()=>selectBinanceSpotUsdtUniverse({symbols:[]},[],{
    minimumQuoteVolume:750_000,maxSymbols:500,includeAllEligible:true
  }),/BTCUSDT_NOT_IN_750K_USDT_SPOT_UNIVERSE/);
  assert.throws(()=>selectBinanceSpotUsdtUniverse(null,[],{}),
    /BINANCE_SPOT_USDT_UNIVERSE_ARGUMENTS_INVALID/);
});

test('prospective capture audit requires every eligible symbol to have a complete included result',()=>{
  const eligible=['BTCUSDT','ETHUSDT','SOLUSDT'];
  const selected=['BTCUSDT','ETHUSDT','SOLUSDT'];
  const symbolResults=eligible.map(symbol=>({symbol,status:'INCLUDED'}));
  const audit=verifyProspectiveUniverseCapture({eligible,selected,symbolResults});
  assert.equal(audit.status,'COMPLETE');
  assert.equal(audit.eligible_candidate_count,3);
  assert.equal(audit.selected_candidate_count,3);
  assert.equal(audit.included_symbol_count,3);
  assert.equal(audit.rejected_symbol_count,0);
  assert.equal(audit.all_eligible_symbols_have_rows,true);
  assert.deepEqual(audit.included_symbols,['BTCUSDT','ETHUSDT','SOLUSDT']);
});

test('prospective capture audit fails closed when one eligible symbol has incomplete raw coverage',()=>{
  const eligible=['BTCUSDT','ETHUSDT','SOLUSDT'];
  const selected=[...eligible];
  const symbolResults=[
    {symbol:'BTCUSDT',status:'INCLUDED'},
    {symbol:'ETHUSDT',status:'REJECTED_INCOMPLETE_RAW_ARCHIVE',
      coverage:{one_minute:{valid:false,reason:'MISSING_CANDLE'}}},
    {symbol:'SOLUSDT',status:'INCLUDED'}
  ];
  assert.throws(()=>verifyProspectiveUniverseCapture({
    eligible,selected,symbolResults
  }),/PROSPECTIVE_UNIVERSE_COVERAGE_INCOMPLETE/);
});

test('prospective capture audit fails closed for a missing result or missing selected candidate',()=>{
  assert.throws(()=>verifyProspectiveUniverseCapture({
    eligible:['BTCUSDT','ETHUSDT'],selected:['BTCUSDT','ETHUSDT'],
    symbolResults:[{symbol:'BTCUSDT',status:'INCLUDED'}]
  }),/PROSPECTIVE_UNIVERSE_COVERAGE_INCOMPLETE/);
  assert.throws(()=>verifyProspectiveUniverseCapture({
    eligible:['BTCUSDT','ETHUSDT'],selected:['BTCUSDT'],
    symbolResults:[{symbol:'BTCUSDT',status:'INCLUDED'}]
  }),/PROSPECTIVE_UNIVERSE_COVERAGE_INCOMPLETE/);
});

test('prospective capture audit rejects duplicate or unexpected symbol results',()=>{
  assert.throws(()=>verifyProspectiveUniverseCapture({
    eligible:['BTCUSDT','ETHUSDT'],selected:['BTCUSDT','ETHUSDT'],
    symbolResults:[
      {symbol:'BTCUSDT',status:'INCLUDED'},
      {symbol:'BTCUSDT',status:'INCLUDED'}
    ]
  }),/PROSPECTIVE_UNIVERSE_CAPTURE_DUPLICATE_SYMBOL/);
  assert.throws(()=>verifyProspectiveUniverseCapture({
    eligible:['BTCUSDT','ETHUSDT'],selected:['BTCUSDT','ETHUSDT'],
    symbolResults:[
      {symbol:'BTCUSDT',status:'INCLUDED'},
      {symbol:'FAKEUSDT',status:'INCLUDED'}
    ]
  }),/PROSPECTIVE_UNIVERSE_COVERAGE_INCOMPLETE/);
});

test('prospective cohort row coverage requires every row to match the declared 4h decision grid',()=>{
  const first=Date.UTC(2026,10,18,0,15,0)-1,interval=4*60*60*1000;
  const schedule={
    first_decision_at:first,last_decision_at:first+4*interval,
    decision_interval_ms:interval,decision_count:5,
    decision_times:Array.from({length:5},(_,index)=>first+index*interval)
  };
  const validRows=[0,1,2,4].map(index=>({
    symbol:'BTCUSDT',at:first+index*interval,
    resolved_at:first+(index+1)*interval
  }));
  const common={
    selectedSymbols:['BTCUSDT'],
    symbolResults:[{symbol:'BTCUSDT',status:'INCLUDED',valid_events:4,
      historically_ineligible_events:1,rejected_events:0,expected_events:5,
      historical_ineligibility_reasons:{HISTORICAL_24H_QUOTE_VOLUME_BELOW_MINIMUM:1},
      rejection_reasons:{}}],
    counts:{rows:4,included_symbols:1,requested_symbols:1,
      historically_ineligible_events:1,rejected_events:0},schedule
  };
  const valid=verifyProspectiveCohortRowCoverage({...common,rows:validRows});
  assert.equal(valid.all_rows_on_declared_decision_grid,true);
  assert.equal(valid.historical_ineligible_event_accounting_matches_schedule,true);
  const offGrid=[...validRows];
  offGrid[0]={...offGrid[0],at:first+1,resolved_at:first+1+interval};
  assert.throws(()=>verifyProspectiveCohortRowCoverage({...common,rows:offGrid}),
    /PROSPECTIVE_COHORT_ROW_OFF_SCHEDULE/);
  const beforeGrid=[...validRows];
  beforeGrid[0]={...beforeGrid[0],at:first-interval,resolved_at:first};
  assert.throws(()=>verifyProspectiveCohortRowCoverage({...common,rows:beforeGrid}),
    /PROSPECTIVE_COHORT_ROW_OFF_SCHEDULE/);
  const afterGrid=[...validRows];
  afterGrid[3]={...afterGrid[3],at:first+4*interval+1,
    resolved_at:first+5*interval+1};
  assert.throws(()=>verifyProspectiveCohortRowCoverage({...common,rows:afterGrid}),
    /PROSPECTIVE_COHORT_ROW_OFF_SCHEDULE/);
});

test('locked out-of-time cohort metadata explicitly identifies retrospective backfill, not live-forward observation',async()=>{
  const source=await readFile(new URL(
    '../tools/build-neural-closure-dataset.mjs',import.meta.url
  ),'utf8');
  const workflow=await readFile(new URL(
    '../../.github/workflows/neural-closure-prospective-cohort.yml',import.meta.url
  ),'utf8');
  assert.match(source,/role:'RETROSPECTIVE_OUT_OF_TIME_BACKFILL_ONLY'/);
  assert.match(source,/collection_mode:'BINANCE_PUBLIC_HISTORICAL_BACKFILL_AFTER_LEGACY_LABEL_PURGE'/);
  assert.match(source,/real_time_forward_observation:false/);
  assert.match(source,/live_forward_validation:false/);
  assert.match(workflow,/Capture a retrospective out-of-time, locked, unscored cohort/);
  assert.match(workflow,/OUT_OF_TIME_BACKFILL_MODE_OR_LIVE_FORWARD_CLAIM_INVALID/);
});

test('prospective builder separates historical liquidity ineligibility from data rejection and persists complete per-symbol accounting',async()=>{
  const source=await readFile(new URL(
    '../tools/build-neural-closure-dataset.mjs',import.meta.url
  ),'utf8');
  assert.match(source,/key==='HISTORICAL_24H_QUOTE_VOLUME_BELOW_MINIMUM'/);
  assert.match(source,/historically_ineligible_events:historicallyIneligibleEvents/);
  assert.match(source,/historical_ineligibility_reasons:historicalIneligibilityReasons/);
  assert.match(source,/rejected_events:symbolRejected/);
  assert.match(source,/coverage:coverage\.checks/);
  assert.match(source,/if\(!args\.prospectiveOnly&&\s*symbolRows\.length<Math\.ceil\(schedule\.decision_count\*0\.8\)\)/,
    'the 80% row threshold is legacy-only; prospective exclusions must be accounted separately');
});

test('prospective cohort row coverage requires rejection reason counts to equal rejected events',()=>{
  const first=Date.UTC(2026,10,18,0,15,0)-1,interval=4*60*60*1000;
  const schedule={
    first_decision_at:first,last_decision_at:first+4*interval,
    decision_interval_ms:interval,decision_count:5,
    decision_times:Array.from({length:5},(_,index)=>first+index*interval)
  };
  const rows=[0,1,2,4].map(index=>({
    symbol:'BTCUSDT',at:first+index*interval,
    resolved_at:first+(index+1)*interval
  }));
  const base={
    selectedSymbols:['BTCUSDT'],
    counts:{rows:3,included_symbols:1,requested_symbols:1,
      historically_ineligible_events:1,rejected_events:1},schedule,
    rows:rows.slice(0,3)
  };
  const accepted=verifyProspectiveCohortRowCoverage({
    ...base,symbolResults:[{symbol:'BTCUSDT',status:'INCLUDED',valid_events:3,
      historically_ineligible_events:1,rejected_events:1,expected_events:5,
      historical_ineligibility_reasons:{HISTORICAL_24H_QUOTE_VOLUME_BELOW_MINIMUM:1},
      rejection_reasons:{MISSING_EVENT_COVERAGE:1}}]
  });
  assert.equal(accepted.rejection_reason_accounting_matches_schedule,true);
  assert.equal(accepted.all_event_outcomes_accounted,true);
  assert.throws(()=>verifyProspectiveCohortRowCoverage({
    ...base,symbolResults:[{symbol:'BTCUSDT',status:'INCLUDED',valid_events:3,
      historically_ineligible_events:1,rejected_events:1,expected_events:5,
      historical_ineligibility_reasons:{HISTORICAL_24H_QUOTE_VOLUME_BELOW_MINIMUM:1},
      rejection_reasons:{}}]
  }),/PROSPECTIVE_COHORT_SYMBOL_EVENT_COVERAGE_INVALID/);
  assert.throws(()=>verifyProspectiveCohortRowCoverage({
    ...base,symbolResults:[{symbol:'BTCUSDT',status:'INCLUDED',valid_events:3,
      historically_ineligible_events:1,rejected_events:1,expected_events:5,
      historical_ineligibility_reasons:{HISTORICAL_24H_QUOTE_VOLUME_BELOW_MINIMUM:1},
      rejection_reasons:{MISSING_EVENT_COVERAGE:0}}]
  }),/PROSPECTIVE_COHORT_SYMBOL_EVENT_COVERAGE_INVALID/);
});

test('prospective cohort row coverage accounts for eligible, historically ineligible and rejected events without conflating them',()=>{
  const first=Date.UTC(2026,10,18,0,15,0)-1,interval=4*60*60*1000;
  const schedule={
    first_decision_at:first,last_decision_at:first+4*interval,
    decision_interval_ms:interval,decision_count:5,
    decision_times:Array.from({length:5},(_,index)=>first+index*interval)
  };
  const makeRows=count=>Array.from({length:count},(_,index)=>({
    symbol:'BTCUSDT',at:first+index*interval,resolved_at:first+(index+1)*interval
  }));
  const base={
    selectedSymbols:['BTCUSDT'],
    counts:{rows:2,included_symbols:1,requested_symbols:1,
      historically_ineligible_events:2,rejected_events:1},schedule
  };
  const accepted=verifyProspectiveCohortRowCoverage({
    ...base,
    symbolResults:[{symbol:'BTCUSDT',status:'INCLUDED',
      valid_events:2,historically_ineligible_events:2,rejected_events:1,
      expected_events:5,
      historical_ineligibility_reasons:{
        HISTORICAL_24H_QUOTE_VOLUME_BELOW_MINIMUM:2
      },rejection_reasons:{AMBIGUOUS_BOTH_BARRIERS:1}}],
    rows:makeRows(2)
  });
  assert.equal(accepted.all_event_outcomes_accounted,true);
  assert.equal(accepted.historical_ineligible_event_accounting_matches_schedule,true);
  assert.throws(()=>verifyProspectiveCohortRowCoverage({
    ...base,
    symbolResults:[{symbol:'BTCUSDT',status:'INCLUDED',
      valid_events:2,historically_ineligible_events:2,rejected_events:0,
      expected_events:5,
      historical_ineligibility_reasons:{
        HISTORICAL_24H_QUOTE_VOLUME_BELOW_MINIMUM:2
      },rejection_reasons:{}}],
    rows:makeRows(2)
  }),/PROSPECTIVE_COHORT_SYMBOL_EVENT_COVERAGE_INVALID/);
});

test('prospective cohort row coverage rejects an invalid decision schedule',()=>{
  assert.throws(()=>verifyProspectiveCohortRowCoverage({
    selectedSymbols:['BTCUSDT'],
    symbolResults:[{symbol:'BTCUSDT',status:'INCLUDED',valid_events:1}],
    rows:[{symbol:'BTCUSDT',at:1,resolved_at:14400001}],
    counts:{rows:1,included_symbols:1,requested_symbols:1},
    schedule:{first_decision_at:1,last_decision_at:20000000,decision_interval_ms:1000}
  }),/PROSPECTIVE_COHORT_DECISION_SCHEDULE_INVALID/);
});

test('prospective cohort row coverage verifies exact per-symbol row counts and totals',()=>{
  const first=Date.UTC(2026,10,18,0,15,0)-1,interval=4*60*60*1000;
  const schedule={
    first_decision_at:first,last_decision_at:first+4*interval,
    decision_interval_ms:interval,decision_count:5,
    decision_times:Array.from({length:5},(_,index)=>first+index*interval)
  };
  const selectedSymbols=['BTCUSDT','ETHUSDT'];
  const symbolResults=['BTCUSDT','ETHUSDT'].map(symbol=>({
    symbol,status:'INCLUDED',valid_events:4,historically_ineligible_events:0,
    rejected_events:1,expected_events:5,
    historical_ineligibility_reasons:{},
    rejection_reasons:{EVENT_REJECTED:1}
  }));
  const rows=['BTCUSDT','ETHUSDT'].flatMap(symbol=>
    [0,1,2,4].map(index=>({
      symbol,at:first+index*interval,resolved_at:first+(index+1)*interval
    }))
  );
  const audit=verifyProspectiveCohortRowCoverage({
    selectedSymbols,symbolResults,rows,schedule,
    counts:{rows:8,included_symbols:2,requested_symbols:2,
      historically_ineligible_events:0,rejected_events:2}
  });
  assert.equal(audit.status,'VERIFIED');
  assert.equal(audit.symbols_verified,2);
  assert.equal(audit.rows_verified,8);
  assert.equal(audit.decision_count,5);
  assert.equal(audit.per_symbol_event_accounting_matches_schedule,true);
});

test('prospective cohort row coverage rejects a symbol whose stored valid-event count lies',()=>{
  const first=Date.UTC(2026,10,18,0,15,0)-1,interval=4*60*60*1000;
  const schedule={
    first_decision_at:first,last_decision_at:first+4*interval,
    decision_interval_ms:interval,decision_count:5,
    decision_times:Array.from({length:5},(_,index)=>first+index*interval)
  };
  const btcRows=[0,1,2,4].map(index=>({
    symbol:'BTCUSDT',at:first+index*interval,
    resolved_at:first+(index+1)*interval
  }));
  assert.throws(()=>verifyProspectiveCohortRowCoverage({
    selectedSymbols:['BTCUSDT','ETHUSDT'],
    symbolResults:[
      {symbol:'BTCUSDT',status:'INCLUDED',valid_events:4,
        historically_ineligible_events:0,rejected_events:1,expected_events:5,
        historical_ineligibility_reasons:{},rejection_reasons:{EVENT_REJECTED:1}},
      {symbol:'ETHUSDT',status:'INCLUDED',valid_events:4,
        historically_ineligible_events:0,rejected_events:1,expected_events:5,
        historical_ineligibility_reasons:{},rejection_reasons:{EVENT_REJECTED:1}}
    ],
    rows:[...btcRows,{symbol:'ETHUSDT',at:first,resolved_at:first+interval}],
    schedule,
    counts:{rows:5,included_symbols:2,requested_symbols:2,
      historically_ineligible_events:0,rejected_events:2}
  }),/PROSPECTIVE_COHORT_SYMBOL_ROW_COUNT_MISMATCH/);
});

test('prospective cohort row coverage rejects foreign or missing symbol rows',()=>{
  const first=Date.UTC(2026,10,18,0,15,0)-1,interval=4*60*60*1000;
  const schedule={
    first_decision_at:first,last_decision_at:first+4*interval,
    decision_interval_ms:interval,decision_count:5,
    decision_times:Array.from({length:5},(_,index)=>first+index*interval)
  };
  const common={
    selectedSymbols:['BTCUSDT','ETHUSDT'],
    symbolResults:['BTCUSDT','ETHUSDT'].map(symbol=>({
      symbol,status:'INCLUDED',valid_events:4,historically_ineligible_events:0,
      rejected_events:1,expected_events:5,
      historical_ineligibility_reasons:{},rejection_reasons:{EVENT_REJECTED:1}
    })),
    counts:{rows:8,included_symbols:2,requested_symbols:2,
      historically_ineligible_events:0,rejected_events:2},schedule
  };
  assert.throws(()=>verifyProspectiveCohortRowCoverage({
    ...common,rows:[
      {symbol:'BTCUSDT',at:first,resolved_at:first+interval},
      {symbol:'FAKEUSDT',at:first,resolved_at:first+interval}
    ]
  }),/PROSPECTIVE_COHORT_ROW_SYMBOL_UNEXPECTED/);
  assert.throws(()=>verifyProspectiveCohortRowCoverage({
    ...common,rows:[{symbol:'BTCUSDT',at:first,resolved_at:first+interval}]
  }),/PROSPECTIVE_COHORT_SYMBOL_ROW_COUNT_MISMATCH/);
});

test('prospective cohort row coverage rejects mismatched aggregate counts and duplicate symbols',()=>{
  const first=Date.UTC(2026,10,18,0,15,0)-1,interval=4*60*60*1000;
  const schedule={
    first_decision_at:first,last_decision_at:first+4*interval,
    decision_interval_ms:interval,decision_count:5,
    decision_times:Array.from({length:5},(_,index)=>first+index*interval)
  };
  const fourRows=[0,1,2,4].map(index=>({
    symbol:'BTCUSDT',at:first+index*interval,
    resolved_at:first+(index+1)*interval
  }));
  assert.throws(()=>verifyProspectiveCohortRowCoverage({
    selectedSymbols:['BTCUSDT','ETHUSDT','ETHUSDT'],
    symbolResults:[],rows:[],schedule,
    counts:{rows:0,included_symbols:3,requested_symbols:3,
      historically_ineligible_events:0,rejected_events:0}
  }),/PROSPECTIVE_COHORT_SELECTED_SYMBOLS_INVALID/);
  assert.throws(()=>verifyProspectiveCohortRowCoverage({
    selectedSymbols:['BTCUSDT'],
    symbolResults:[{symbol:'BTCUSDT',status:'INCLUDED',valid_events:4,
      historically_ineligible_events:0,rejected_events:1,expected_events:5,
      historical_ineligibility_reasons:{},rejection_reasons:{EVENT_REJECTED:1}}],
    rows:fourRows,schedule,
    counts:{rows:5,included_symbols:1,requested_symbols:1,
      historically_ineligible_events:0,rejected_events:0}
  }),/PROSPECTIVE_COHORT_AGGREGATE_COUNTS_MISMATCH/);
});


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
  assert.equal(schedule.fifteen_minute_start_open_at,
    schedule.first_decision_at-96*FIFTEEN+1,
    'the raw 15m archive must contain the full trailing 24h liquidity window before the first decision');
  assert.equal((schedule.one_minute_end_open_at-schedule.one_minute_start_open_at)/MINUTE+1,60*24*60);
});

test('prospective cohort schedule starts after the immutable legacy cohort and contains only matured 4h decisions',()=>{
  const legacyLastDecision=Date.parse('2026-11-17T16:14:59.999Z');
  const legacyLastLabelResolved=legacyLastDecision+FOUR_HOURS();
  const prospectiveStart=Date.parse('2026-11-18T00:14:59.999Z');
  const serverTime=Date.parse('2026-11-26T06:00:00.000Z');
  const schedule=createNeuralClosureDecisionSchedule({
    serverTime,startAt:prospectiveStart
  });
  assert.equal(schedule.mode,'PROSPECTIVE_LOCKED_OUT_OF_TIME');
  assert.equal(schedule.first_decision_at,prospectiveStart);
  assert.equal(legacyLastLabelResolved,Date.parse('2026-11-17T20:14:59.999Z'));
  assert.ok(schedule.first_decision_at>legacyLastDecision);
  assert.ok(schedule.first_decision_at-legacyLastLabelResolved>=FOUR_HOURS(),
    'four-hour purge must follow maturity of every legacy label');
  assert.equal(schedule.start_boundary_was_rounded,false);
  assert.equal(schedule.decision_times[0],prospectiveStart);
  assert.equal(schedule.decision_times.at(-1),schedule.last_decision_at);
  assert.ok(schedule.last_decision_at+FOUR_HOURS()<=serverTime,
    'the final event label must be mature at collection time');
  assert.ok(schedule.decision_count>=12);
  for(let index=1;index<schedule.decision_times.length;index++)
    assert.equal(schedule.decision_times[index]-schedule.decision_times[index-1],
      FOUR_HOURS());
  assert.equal(schedule.one_minute_start_open_at,prospectiveStart+1);
  assert.equal(schedule.fifteen_minute_end_open_at,
    schedule.last_decision_at-FIFTEEN+1);
});

test('prospective schedule rejects unaligned or unmatured start boundaries',()=>{
  const prospectiveStart=Date.parse('2026-11-18T00:14:59.999Z');
  assert.throws(()=>createNeuralClosureDecisionSchedule({
    serverTime:Date.parse('2026-11-26T06:00:00Z'),
    startAt:prospectiveStart+1
  }),/PROSPECTIVE_SCHEDULE_BOUNDARY_INVALID/);
  assert.throws(()=>createNeuralClosureDecisionSchedule({
    serverTime:Date.parse('2026-11-26T06:00:00Z'),
    startAt:'not-a-time'
  }),/PROSPECTIVE_SCHEDULE_BOUNDARY_INVALID/);
  assert.throws(()=>createNeuralClosureDecisionSchedule({
    serverTime:prospectiveStart+60*60_000,
    startAt:prospectiveStart
  }),/PROSPECTIVE_SCHEDULE_BOUNDARY_INVALID/);
  assert.throws(()=>createNeuralClosureDecisionSchedule({
    serverTime:Date.parse('2026-11-26T06:00:00Z'),
    startAt:Date.parse('2026-11-26T00:14:59.999Z')
  }),/PROSPECTIVE_SCHEDULE_SUPPORT_INVALID/);
});

function FOUR_HOURS(){return 4*60*60_000;}

test('raw coverage gate rejects a missing or duplicate candle rather than filling the gap',()=>{
  const at=Date.UTC(2026,0,1,0,14,59,999);
  const schedule={
    one_minute_start_open_at:at+1,
    one_minute_end_open_at:at+FOUR_HOURS()-MINUTE+1,
    five_minute_start_open_at:at-24*FIVE+1,
    five_minute_end_open_at:at-FIVE+1,
    fifteen_minute_start_open_at:at-96*FIFTEEN+1,
    fifteen_minute_end_open_at:at-FIFTEEN+1
  };
  const minute=Array.from({length:240},(_,index)=>
    makeCandle(at+1+index*MINUTE,MINUTE));
  const five=Array.from({length:24},(_,index)=>
    makeCandle(schedule.five_minute_start_open_at+index*FIVE,FIVE));
  const fifteen=Array.from({length:96},(_,index)=>
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

test('historical liquidity uses exactly 96 closed 15m candles ending at the decision and ignores future candles',()=>{
  const at=Date.UTC(2026,0,2,0,0,0)-1;
  const firstOpen=at-96*FIFTEEN+1;
  const rows=Array.from({length:96},(_,index)=>
    makeCandle(firstOpen+index*FIFTEEN,FIFTEEN,{
      base:100,volume:100,trades:20
    }));
  const expected=rows.reduce((sum,row)=>sum+row.quoteVolume,0);
  const future=makeCandle(at+1,FIFTEEN,{base:100,volume:1_000_000,trades:99_999});
  const snapshot=buildNeuralClosureHistoricalLiquiditySnapshot({
    symbolCandles:[...rows,future],decisionAt:at,
    minimumQuoteVolume24hUsdt:750_000
  });
  assert.equal(snapshot.ready,true);
  assert.equal(snapshot.eligible,true);
  assert.equal(snapshot.window_candle_count,96);
  assert.equal(snapshot.window_start_open_at,firstOpen);
  assert.equal(snapshot.window_end_close_at,at);
  assert.equal(snapshot.decision_at,at);
  assert.equal(snapshot.quote_volume_24h_usdt,expected);
  assert.match(snapshot.window_evidence_sha256,/^[a-f0-9]{64}$/);
  const modifiedRows=rows.map((row,index)=>index===0?{...row,quoteVolume:row.quoteVolume+1}:row);
  const changed=buildNeuralClosureHistoricalLiquiditySnapshot({
    symbolCandles:modifiedRows,decisionAt:at,
    minimumQuoteVolume24hUsdt:750_000
  });
  assert.notEqual(changed.window_evidence_sha256,snapshot.window_evidence_sha256,
    'the point-in-time liquidity evidence digest must change when any source candle changes');
  assert.equal(snapshot.no_future_candles_used,true);
  assert.equal(snapshot.source,'BINANCE_OFFICIAL_CLOSED_15M_KLINE_QUOTE_VOLUME');
});

test('historical liquidity rejects a below-floor 24h window and fails closed on gaps',()=>{
  const at=Date.UTC(2026,0,2,0,0,0)-1;
  const firstOpen=at-96*FIFTEEN+1;
  const lowRows=Array.from({length:96},(_,index)=>
    makeCandle(firstOpen+index*FIFTEEN,FIFTEEN,{
      base:100,volume:1,trades:2
    }));
  const low=buildNeuralClosureHistoricalLiquiditySnapshot({
    symbolCandles:lowRows,decisionAt:at,minimumQuoteVolume24hUsdt:750_000
  });
  assert.equal(low.ready,true);
  assert.equal(low.eligible,false);
  assert.equal(low.reason,'HISTORICAL_24H_QUOTE_VOLUME_BELOW_MINIMUM');
  const gap=[...lowRows];gap.splice(30,1);
  const incomplete=buildNeuralClosureHistoricalLiquiditySnapshot({
    symbolCandles:gap,decisionAt:at,minimumQuoteVolume24hUsdt:750_000
  });
  assert.equal(incomplete.ready,false);
  assert.equal(incomplete.eligible,false);
  assert.equal(incomplete.reason,'HISTORICAL_24H_15M_WINDOW_INCOMPLETE');
});

test('one shared event row has 18 audited MLP features, 24x29 closed sequence and a 1m first-touch label',()=>{
  const firstFifteenOpen=Date.UTC(2026,0,1,0,0,0);
  const fifteen=Array.from({length:96},(_,index)=>
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
    quoteVolume24h:1_000_000_000
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
  assert.equal(built.row.historical_liquidity.window_candle_count,96);
  assert.equal(built.row.historical_liquidity.window_end_close_at,at);
  assert.equal(built.row.historical_liquidity.no_future_candles_used,true);
  assert.equal(built.row.quote_volume_24h,
    built.row.historical_liquidity.quote_volume_24h_usdt);
  assert.notEqual(built.row.quote_volume_24h,1_000_000_000,
    'the current ticker value passed by a legacy caller must not replace historical closed-candle volume');
  assert.equal(validateFourHourRows([built.row]).length,1);
});


test('large neural dataset JSON is written row-by-row with valid atomic output',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'radarx-neural-stream-'));
  const output=join(directory,'dataset.json');
  const rows=Array.from({length:420},(_,index)=>({
    id:'SAMPLE:'+index,
    temporal_sequence:Array.from({length:24},(_,step)=>
      Array.from({length:29},(_,channel)=>Number(((index+step+channel)%97/97).toFixed(6))))
  }));
  try{
    await writeJsonObjectWithArrayStreaming(output,{
      schema:'RADARX_STREAMING_TEST_V1',
      count:rows.length,
      target:{horizon_hours:4}
    },'rows',rows);
    const parsed=JSON.parse(await readFile(output,'utf8'));
    assert.equal(parsed.schema,'RADARX_STREAMING_TEST_V1');
    assert.equal(parsed.count,rows.length);
    assert.equal(parsed.rows.length,rows.length);
    assert.deepEqual(parsed.rows[0],rows[0]);
    assert.deepEqual(parsed.rows.at(-1),rows.at(-1));
    assert.ok((await stat(output)).size>1_000_000);
    assert.deepEqual(await readdir(directory),['dataset.json']);
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
});

test('failed row serialization never leaves a partial dataset at the destination',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'radarx-neural-stream-fail-'));
  const output=join(directory,'dataset.json');
  try{
    await assert.rejects(
      writeJsonObjectWithArrayStreaming(output,{schema:'INVALID_V1'},'rows',[{id:'ok'},{value:1n}])
    );
    assert.deepEqual(await readdir(directory),[]);
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
});


test('raw Binance Spot archives stream canonical JSON and preserve raw/compressed SHA-256 manifests',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'radarx-raw-archive-'));
  const rows=Array.from({length:6000},(_,index)=>[
    1_800_000_000_000+index*60_000,
    String(100+index/1000),String(101+index/1000),
    String(99+index/1000),String(100.5+index/1000),
    String(1200+index),1_800_000_059_999+index*60_000,
    String((100.5+index/1000)*(1200+index)),120+index,
    String((1200+index)*0.56),String((100.5+index/1000)*(1200+index)*0.56),'0'
  ]);
  const file=join(directory,'ETHUSDT.1m.json.gz');
  try{
    const result=await writeRawSpotKlineArchive({
      symbol:'ETHUSDT',interval:'1m',rawRows:rows,archiveDir:directory
    });
    const compressed=await readFile(file);
    const raw=gunzipSync(compressed);
    const parsed=JSON.parse(raw.toString('utf8'));
    assert.equal(parsed.schema,'BINANCE_SPOT_RAW_KLINE_ARCHIVE_V1');
    assert.equal(parsed.symbol,'ETHUSDT');
    assert.equal(parsed.interval,'1m');
    assert.deepEqual(parsed.rows,rows);
    assert.equal(result.row_count,rows.length);
    assert.equal(result.raw_bytes,raw.length);
    assert.equal(result.compressed_bytes,compressed.length);
    assert.equal(result.raw_sha256,createHash('sha256').update(raw).digest('hex'));
    assert.equal(result.compressed_sha256,createHash('sha256').update(compressed).digest('hex'));
    assert.equal(result.streaming,true);
    assert.equal(result.atomic,true);
    assert.deepEqual(await readdir(directory),['ETHUSDT.1m.json.gz']);
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
});

test('raw archive stream fails closed without leaving a partial gzip file',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'radarx-raw-archive-fail-'));
  try{
    await assert.rejects(writeRawSpotKlineArchive({
      symbol:'ETHUSDT',interval:'1m',archiveDir:directory,
      rawRows:[['valid'],[1n]]
    }));
    assert.deepEqual(await readdir(directory),[]);
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
});


test('Binance transient 5xx/408 retries are finite, exponential and never mask hard failures',()=>{
  assert.equal(binanceServerRetryDelayMs(500,1),750);
  assert.equal(binanceServerRetryDelayMs(502,2),1500);
  assert.equal(binanceServerRetryDelayMs(503,3),3000);
  assert.equal(binanceServerRetryDelayMs(504,4),null);
  assert.equal(binanceServerRetryDelayMs(408,1),750);
  assert.equal(binanceServerRetryDelayMs(418,1),null);
  assert.equal(binanceServerRetryDelayMs(429,1),null);
  assert.equal(binanceServerRetryDelayMs(451,1),null);
  assert.equal(binanceServerRetryDelayMs(400,1),null);
  assert.equal(binanceServerRetryDelayMs(500,1,'5'),5000);
  assert.equal(binanceServerRetryDelayMs(500,2,'0.2'),1500);
});

test('prospective cohort workflow is manual, locked, data-only and training-free',async()=>{
  const workflow=await readFile(new URL(
    '../../.github/workflows/neural-closure-prospective-cohort.yml',import.meta.url
  ),'utf8');
  assert.match(workflow,/workflow_dispatch:/);
  assert.match(workflow,/2026-11-17T20:14:59\.999Z/);
  assert.match(workflow,/--prospectiveOnly true/);
  assert.match(workflow,/PROSPECTIVE_CANDIDATE_CAPTURE_INCOMPLETE/);
  assert.match(workflow,/all_eligible_symbols_have_rows/);
  assert.ok(workflow.includes('if: success()'));
  assert.ok(!workflow.includes('if: always()'));
  assert.match(workflow,/--startAt "\$PROSPECTIVE_START_AT"/);
  assert.match(workflow,/PROSPECTIVE_COHORT_CAPTURED_LOCKED/);
  assert.match(workflow,/LOCKED_UNSCORED/);
  assert.match(workflow,/training_allowed!==false/);
  assert.match(workflow,/model_scoring_allowed!==false/);
  assert.match(workflow,/retention-days: 90/);
  assert.match(workflow,/RADARX_PROSPECTIVE_COHORT_ENCRYPTION_KEY_HEX/);
  assert.match(workflow,/secure-prospective-cohort-bundle\.mjs encrypt/);
  assert.match(workflow,/path: artifacts\/secure\/\*\.enc/);
  assert.match(workflow,/rm -rf artifacts\/neural-closure-prospective/);
  assert.doesNotMatch(workflow,/path: artifacts\/neural-closure-prospective\//);
  assert.doesNotMatch(workflow,/phase2\/tools\/train-neural-closure-models\.mjs/);
  assert.doesNotMatch(workflow,/--hurdleInnerOnly/);
  assert.doesNotMatch(workflow,/--openHoldout/);
  assert.doesNotMatch(workflow,/real_order_execution:\s*true/);
});
