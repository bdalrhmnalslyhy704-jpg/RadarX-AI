const STABLE_BASE_ASSETS=new Set([
  'USDC','BUSD','TUSD','FDUSD','USDP','DAI','USDE','EUR','AEUR',
  'EURI','TRY','BRL','BIDR','IDRT','UST','USTC','PAXG'
]);

// Binance bStocks are tokenized securities, not crypto assets. This explicit
// list is anchored to Binance's 2026-08-28 bStocks Spot bot-pair announcement.
// Keep these instruments out of the crypto-only pre-move cohort; corporate
// actions and exchange suspensions can break continuous kline chronology.
// Canonical current Binance Spot bStocks base-asset universe. Every entry below
// is backed by an official Binance Spot/Convert listing announcement; the date
// comments identify the listing batch. This excludes tokenized securities from
// the crypto-only signal cohort. Refresh this list before collection whenever
// Binance adds a new bStocks Spot pair.
// Canonical current Binance Spot bStocks base-asset universe. Every entry below
// is backed by an official Binance Spot/Convert listing announcement; the date
// comments identify the listing batch. This excludes tokenized securities from
// the crypto-only signal cohort. Refresh this list before collection whenever
// Binance adds a new bStocks Spot pair.
const BINANCE_BSTOCK_BASE_ASSETS=new Set([
  // 2026-06-11
  'CRCLB', 'MUB', 'NVDAB', 'SNDKB', 'TSLAB',
  // 2026-06-12
  'SPCXB',
  // 2026-06-23
  'AMDB', 'EWYB', 'INTCB', 'MSTRB',
  // 2026-06-30
  'LITEB', 'METAB', 'MSFTB', 'PLTRB', 'QQQB',
  // 2026-07-07
  'CBRSB', 'COINB', 'DRAMB', 'GLWB', 'GOOGLB', 'NBISB', 'QCOMB', 'SOXLB', 'SPYB', 'WDCB',
  // 2026-07-15
  'AAOIB', 'ARMB', 'AVGOB', 'BABAB', 'HOODB', 'IBMB', 'MRVLB', 'NOKB', 'RKLBB', 'TSMB',
  // 2026-07-22
  'AXTIB', 'CRWVB', 'INTWB', 'KORUB', 'MUUB', 'MVLLB', 'ORCLB', 'QNTB', 'SNXXB', 'TQQQB',
  // 2026-08-05
  'ALABB', 'ASMLB', 'ASTSB', 'BMNRB', 'COHRB', 'CRDOB', 'IRENB', 'NFLXB', 'SMCIB', 'USARB',
  // 2026-08-12
  'GMEB',
  // 2026-09-02
  'CRWDB', 'MRNAB', 'SQQQB', 'STXB',
  // 2026-10-07
  'JPMB', 'LLYB', 'SECZB', 'USDEB',
  // 2026-10-14
  'BBB', 'MDBB', 'PENGB', 'UVXYB',
  // 2026-10-28
  'APPB', 'BSPB', 'GEVB', 'SKDDB', 'SKUUB',
  // 2026-11-18
  'EWJB', 'EWTB', 'EWZB', 'EWZSB', 'IWMB', 'MELIB', 'NUB',
  // 2026-11-19
  'ANTB',
  // 2026-11-25
  'ARTYB', 'FRHCB', 'IBITB', 'IGVB', 'SOXXB'
]);
const finite=value=>value!==null&&value!==undefined&&value!==''&&
  typeof value!=='boolean'&&Number.isFinite(Number(value));
const num=value=>finite(value)?Number(value):null;

/**
 * Resolve all currently-trading Binance Spot USDT pairs over the 24h floor.
 * Legacy cohorts retain top-N selection; prospective cohorts opt into
 * includeAllEligible and fail closed if the resource cap would truncate them.
 */
export function selectBinanceSpotUsdtUniverse(exchangeInfo,tickers,{
  minimumQuoteVolume=750_000,maxSymbols=100,includeAllEligible=false,
  historicalEligibilityOnly=false
}={}){
  if(!Array.isArray(exchangeInfo?.symbols)||!Array.isArray(tickers)||
    !finite(minimumQuoteVolume)||Number(minimumQuoteVolume)<750_000||
    !Number.isInteger(maxSymbols)||maxSymbols<10||maxSymbols>1000||
    typeof includeAllEligible!=='boolean'||
    typeof historicalEligibilityOnly!=='boolean')
    throw new TypeError('BINANCE_SPOT_USDT_UNIVERSE_ARGUMENTS_INVALID');
  const tickerMap=new Map(tickers.map(item=>[String(item?.symbol??''),item]));
  const isCurrentSpotUsdt=item=>
    item?.status==='TRADING'&&item?.quoteAsset==='USDT'&&
    item?.isSpotTradingAllowed===true;
  const excludedNonCrypto=exchangeInfo.symbols
    .filter(item=>isCurrentSpotUsdt(item)&&
      BINANCE_BSTOCK_BASE_ASSETS.has(String(item?.baseAsset||'').toUpperCase()))
    .map(item=>({
      symbol:String(item.symbol),base_asset:String(item.baseAsset),
      quote_asset:String(item.quoteAsset),
      exclusion_reason:'TOKENIZED_SECURITY_BSTOCK_NOT_CRYPTO_SPOT_ASSET',
      exclusion_policy:'BINANCE_BSTOCK_TOKENIZED_SECURITIES_V3_2026_11_27'
    }))
    .sort((a,b)=>a.symbol.localeCompare(b.symbol));
  const allowed=exchangeInfo.symbols.filter(item=>
    isCurrentSpotUsdt(item)&&
    !STABLE_BASE_ASSETS.has(String(item?.baseAsset||'').toUpperCase())&&
    !BINANCE_BSTOCK_BASE_ASSETS.has(String(item?.baseAsset||'').toUpperCase())&&
    !/(UP|DOWN|BULL|BEAR)$/.test(String(item?.baseAsset||'').toUpperCase()));
  const eligible=allowed.map(symbol=>{
    const ticker=tickerMap.get(String(symbol.symbol));
    const quoteVolume=num(ticker?.quoteVolume);
    if(!historicalEligibilityOnly&&
      (quoteVolume===null||quoteVolume<Number(minimumQuoteVolume)))return null;
    return {
      symbol:symbol.symbol,base_asset:symbol.baseAsset,
      quote_asset:symbol.quoteAsset,quote_volume_24h:quoteVolume,
      last_price:num(ticker?.lastPrice),price_change_pct:num(ticker?.priceChangePercent)
    };
  }).filter(Boolean).sort((a,b)=>historicalEligibilityOnly
    ?a.symbol.localeCompare(b.symbol)
    :b.quote_volume_24h-a.quote_volume_24h||a.symbol.localeCompare(b.symbol));
  if(!eligible.some(item=>item.symbol==='BTCUSDT'))
    throw new Error(historicalEligibilityOnly
      ?'BTCUSDT_NOT_IN_CURRENT_SPOT_USDT_UNIVERSE'
      :'BTCUSDT_NOT_IN_750K_USDT_SPOT_UNIVERSE');
  if(includeAllEligible&&eligible.length>maxSymbols)
    throw new Error('ELIGIBLE_UNIVERSE_EXCEEDS_CONFIGURED_MAX_SYMBOLS:'+
      eligible.length+':'+maxSymbols);
  let selected=includeAllEligible?eligible:eligible.slice(0,maxSymbols);
  if(!selected.some(item=>item.symbol==='BTCUSDT')){
    selected=selected.slice(0,Math.max(0,maxSymbols-1));
    selected.push(eligible.find(item=>item.symbol==='BTCUSDT'));
    selected.sort((a,b)=>historicalEligibilityOnly
      ?a.symbol.localeCompare(b.symbol)
      :b.quote_volume_24h-a.quote_volume_24h||a.symbol.localeCompare(b.symbol));
  }
  return {
    eligible,selected,
    excluded_non_crypto:excludedNonCrypto,
    excluded_non_crypto_policy:{
      id:'BINANCE_BSTOCK_TOKENIZED_SECURITIES_V3_2026_11_27',
      source:'BINANCE_OFFICIAL_BSTOCK_SPOT_LISTINGS_2026_06_11_TO_2026_11_25',
      count:excludedNonCrypto.length
    }
  };
}

/**
 * Verify that every eligible current-universe symbol produced valid event rows.
 * Candidate selection alone is not enough: incomplete history or event coverage
 * must not silently turn a nominally full universe into a partial cohort.
 */
export function verifyProspectiveUniverseCapture({eligible,selected,symbolResults}={}){
  if(!Array.isArray(eligible)||!Array.isArray(selected)||!Array.isArray(symbolResults))
    throw new TypeError('PROSPECTIVE_UNIVERSE_CAPTURE_AUDIT_ARGUMENTS_INVALID');
  const symbols=(items,label)=>{
    const values=items.map(item=>String(
      typeof item==='string'?item:item?.symbol??''
    ));
    if(values.some(value=>!value))
      throw new Error('PROSPECTIVE_UNIVERSE_CAPTURE_SYMBOL_INVALID:'+label);
    if(new Set(values).size!==values.length)
      throw new Error('PROSPECTIVE_UNIVERSE_CAPTURE_DUPLICATE_SYMBOL:'+label);
    return values.sort();
  };
  const eligibleSymbols=symbols(eligible,'ELIGIBLE');
  const selectedSymbols=symbols(selected,'SELECTED');
  const resultSymbols=symbols(symbolResults,'RESULTS');
  const includedSymbols=symbolResults
    .filter(item=>item?.status==='INCLUDED')
    .map(item=>String(item.symbol)).sort();
  const rejectedSymbols=symbolResults
    .filter(item=>item?.status!=='INCLUDED')
    .map(item=>({
      symbol:String(item?.symbol??''),
      status:String(item?.status??'MISSING_STATUS'),
      rejection_reasons:item?.rejection_reasons??item?.coverage??null
    }));
  const sameSet=(left,right)=>left.length===right.length&&
    left.every((value,index)=>value===right[index]);
  const missingResults=selectedSymbols.filter(symbol=>!resultSymbols.includes(symbol));
  const unexpectedResults=resultSymbols.filter(symbol=>!eligibleSymbols.includes(symbol));
  if(!sameSet(eligibleSymbols,selectedSymbols)||
    !sameSet(eligibleSymbols,includedSymbols)||
    resultSymbols.length!==selectedSymbols.length||
    missingResults.length>0||unexpectedResults.length>0||rejectedSymbols.length>0){
    throw new Error('PROSPECTIVE_UNIVERSE_COVERAGE_INCOMPLETE:'+JSON.stringify({
      eligible_candidate_count:eligibleSymbols.length,
      selected_candidate_count:selectedSymbols.length,
      result_count:resultSymbols.length,
      included_symbol_count:includedSymbols.length,
      missing_results:missingResults,
      unexpected_results:unexpectedResults,
      rejected_symbols:rejectedSymbols
    }));
  }
  return {
    schema:'PROSPECTIVE_UNIVERSE_CAPTURE_AUDIT_V1',
    status:'COMPLETE',
    eligible_candidate_count:eligibleSymbols.length,
    selected_candidate_count:selectedSymbols.length,
    included_symbol_count:includedSymbols.length,
    rejected_symbol_count:0,
    all_eligible_symbols_have_rows:true,
    included_symbols:includedSymbols
  };
}


/**
 * Independently cross-check the persisted per-symbol row counts against the
 * actual prospective cohort rows before a cohort can be marked complete.
 */
export function verifyProspectiveCohortRowCoverage({
  selectedSymbols,symbolResults,rows,counts,schedule
}={}){
  if(!Array.isArray(selectedSymbols)||!Array.isArray(symbolResults)||
    !Array.isArray(rows)||!counts||typeof counts!=='object'||
    !schedule||typeof schedule!=='object')
    throw new TypeError('PROSPECTIVE_COHORT_ROW_COVERAGE_ARGUMENTS_INVALID');
  const firstDecisionAt=Number(schedule.first_decision_at);
  const lastDecisionAt=Number(schedule.last_decision_at);
  const decisionIntervalMs=Number(schedule.decision_interval_ms);
  const decisionCount=Number(schedule.decision_count);
  const decisionTimes=Array.isArray(schedule.decision_times)
    ?schedule.decision_times.map(Number):[];
  const expectedDecisionCount=Number.isSafeInteger(firstDecisionAt)&&
    Number.isSafeInteger(lastDecisionAt)&&Number.isSafeInteger(decisionIntervalMs)&&
    decisionIntervalMs>0
    ?Math.floor((lastDecisionAt-firstDecisionAt)/decisionIntervalMs)+1:0;
  const validSchedule=Number.isSafeInteger(firstDecisionAt)&&
    Number.isSafeInteger(lastDecisionAt)&&
    Number.isSafeInteger(decisionIntervalMs)&&
    decisionIntervalMs===4*60*60*1000&&
    lastDecisionAt>=firstDecisionAt&&
    (lastDecisionAt-firstDecisionAt)%decisionIntervalMs===0&&
    Number.isSafeInteger(decisionCount)&&decisionCount===expectedDecisionCount&&
    decisionTimes.length===decisionCount&&
    decisionTimes.every((at,index)=>Number.isSafeInteger(at)&&
      at===firstDecisionAt+index*decisionIntervalMs);
  if(!validSchedule)
    throw new Error('PROSPECTIVE_COHORT_DECISION_SCHEDULE_INVALID');
  const selected=selectedSymbols.map(value=>String(value??'').trim().toUpperCase()).sort();
  if(selected.some(value=>!value)||new Set(selected).size!==selected.length)
    throw new Error('PROSPECTIVE_COHORT_SELECTED_SYMBOLS_INVALID');
  const parseReasonMap=value=>value&&typeof value==='object'&&!Array.isArray(value)
    ?Object.entries(value):null;
  const results=symbolResults.map(item=>{
    const rejectionEntries=parseReasonMap(item?.rejection_reasons);
    const ineligibleEntries=parseReasonMap(item?.historical_ineligibility_reasons);
    const reasonEntriesValid=entries=>Array.isArray(entries)&&entries.every(([reason,count])=>
      typeof reason==='string'&&reason.trim().length>0&&
      Number.isSafeInteger(Number(count))&&Number(count)>0);
    const reasonCount=entries=>Array.isArray(entries)
      ?entries.reduce((sum,[,count])=>sum+Number(count),0):NaN;
    return {
      symbol:String(item?.symbol??'').trim().toUpperCase(),
      status:item?.status,
      valid_events:Number(item?.valid_events),
      historically_ineligible_events:Number(item?.historically_ineligible_events),
      rejected_events:Number(item?.rejected_events),
      expected_events:Number(item?.expected_events),
      rejection_reasons_valid:reasonEntriesValid(rejectionEntries),
      rejection_reason_count:reasonCount(rejectionEntries),
      historical_ineligibility_reasons_valid:reasonEntriesValid(ineligibleEntries),
      historical_ineligibility_reason_count:reasonCount(ineligibleEntries)
    };
  });
  const resultNames=results.map(item=>item.symbol).sort();
  const same=(a,b)=>a.length===b.length&&a.every((value,index)=>value===b[index]);
  if(results.some(item=>!item.symbol)||new Set(resultNames).size!==resultNames.length||
    !same(selected,resultNames)||results.some(item=>item.status!=='INCLUDED'||
      !Number.isSafeInteger(item.valid_events)||item.valid_events<0||
      !Number.isSafeInteger(item.historically_ineligible_events)||
        item.historically_ineligible_events<0||
      !Number.isSafeInteger(item.rejected_events)||item.rejected_events<0||
      !Number.isSafeInteger(item.expected_events)||item.expected_events!==decisionCount||
      item.valid_events+item.historically_ineligible_events+
        item.rejected_events!==item.expected_events||
      item.rejection_reasons_valid!==true||
      item.rejection_reason_count!==item.rejected_events||
      item.historical_ineligibility_reasons_valid!==true||
      item.historical_ineligibility_reason_count!==item.historically_ineligible_events||
      (item.historically_ineligible_events>0&&
        Object.keys(symbolResults.find(result=>
          String(result?.symbol??'').trim().toUpperCase()===item.symbol
        )?.historical_ineligibility_reasons??{}).some(reason=>
          reason!=='HISTORICAL_24H_QUOTE_VOLUME_BELOW_MINIMUM'))))
    throw new Error('PROSPECTIVE_COHORT_SYMBOL_EVENT_COVERAGE_INVALID');
  const rowCounts=new Map(selected.map(symbol=>[symbol,0]));
  const rowIdentities=new Set();
  for(const row of rows){
    const symbol=String(row?.symbol??'').trim().toUpperCase();
    if(!rowCounts.has(symbol))
      throw new Error('PROSPECTIVE_COHORT_ROW_SYMBOL_UNEXPECTED:'+symbol);
    const at=Number(row?.at);
    const resolvedAt=Number(row?.resolved_at);
    if(!Number.isSafeInteger(at)||at<firstDecisionAt||at>lastDecisionAt||
      (at-firstDecisionAt)%decisionIntervalMs!==0||
      !Number.isSafeInteger(resolvedAt)||resolvedAt!==at+decisionIntervalMs)
      throw new Error('PROSPECTIVE_COHORT_ROW_OFF_SCHEDULE:'+symbol+':'+String(row?.at));
    const identity=symbol+':'+at;
    if(rowIdentities.has(identity))
      throw new Error('PROSPECTIVE_COHORT_DUPLICATE_SYMBOL_DECISION:'+identity);
    rowIdentities.add(identity);
    rowCounts.set(symbol,rowCounts.get(symbol)+1);
  }
  for(const result of results){
    if(rowCounts.get(result.symbol)!==result.valid_events)
      throw new Error('PROSPECTIVE_COHORT_SYMBOL_ROW_COUNT_MISMATCH:'+
        result.symbol+':'+result.valid_events+':'+rowCounts.get(result.symbol));
  }
  if(Number(counts.rows)!==rows.length||
    Number(counts.included_symbols)!==selected.length||
    Number(counts.requested_symbols)!==selected.length||
    Number(counts.historically_ineligible_events)!==
      results.reduce((sum,item)=>sum+item.historically_ineligible_events,0)||
    Number(counts.rejected_events)!==results.reduce((sum,item)=>sum+item.rejected_events,0))
    throw new Error('PROSPECTIVE_COHORT_AGGREGATE_COUNTS_MISMATCH');
  return {
    schema:'PROSPECTIVE_COHORT_ROW_COVERAGE_AUDIT_V4',
    status:'VERIFIED',
    symbols_verified:selected.length,
    rows_verified:rows.length,
    first_decision_at:firstDecisionAt,
    last_decision_at:lastDecisionAt,
    decision_interval_ms:decisionIntervalMs,
    decision_count:decisionCount,
    no_unexpected_symbols:true,
    per_symbol_row_counts_match:true,
    per_symbol_event_accounting_matches_schedule:true,
    historical_ineligible_event_accounting_matches_schedule:true,
    rejection_reason_accounting_matches_schedule:true,
    all_event_outcomes_accounted:true,
    all_rows_on_declared_decision_grid:true
  };
}


/**
 * Audit whether each currently-trading candidate has the exact 15m candle
 * needed to begin the cohort's 24h historical-liquidity lookback. Candidates
 * without this prehistory are explicitly excluded before collection; gaps
 * after the start boundary remain hard failures in the full archive audit.
 */
export function auditProspectiveHistoryStart({
  candidates,results,expectedStartOpenAt
}={}){
  if(!Array.isArray(candidates)||!Array.isArray(results)||
    !Number.isSafeInteger(expectedStartOpenAt)||expectedStartOpenAt<=0)
    throw new TypeError('PROSPECTIVE_HISTORY_START_AUDIT_ARGUMENTS_INVALID');
  const names=items=>items.map(item=>String(
    typeof item==='string'?item:item?.symbol??''
  ).trim().toUpperCase());
  const candidateNames=names(candidates).sort();
  const resultNames=names(results).sort();
  if(candidateNames.some(name=>!name)||new Set(candidateNames).size!==candidateNames.length)
    throw new Error('PROSPECTIVE_HISTORY_START_CANDIDATES_INVALID');
  if(resultNames.some(name=>!name)||new Set(resultNames).size!==resultNames.length)
    throw new Error('PROSPECTIVE_HISTORY_START_DUPLICATE_OR_INVALID_RESULT');
  const same=(left,right)=>left.length===right.length&&
    left.every((value,index)=>value===right[index]);
  if(!same(candidateNames,resultNames))
    throw new Error('PROSPECTIVE_HISTORY_START_RESULT_SET_MISMATCH');
  for(const item of results){
    if(item?.status==='AVAILABLE'){
      if(Number(item.first_open_at)!==expectedStartOpenAt||
        item.reason!==null&&item.reason!==undefined)
        throw new Error('PROSPECTIVE_HISTORY_START_AVAILABLE_EVIDENCE_INVALID:'+
          String(item?.symbol??''));
    }else if(item?.status==='UNAVAILABLE'){
      if(item.first_open_at!==null||
        item.reason!=='NO_CANDLE_AT_REQUIRED_START')
        throw new Error('PROSPECTIVE_HISTORY_START_EXCLUSION_EVIDENCE_INVALID:'+
          String(item?.symbol??''));
    }else{
      throw new Error('PROSPECTIVE_HISTORY_START_STATUS_INVALID:'+
        String(item?.symbol??''));
    }
  }
  const included=results.filter(item=>item.status==='AVAILABLE')
    .map(item=>String(item.symbol).trim().toUpperCase()).sort();
  const excluded=results.filter(item=>item.status==='UNAVAILABLE')
    .map(item=>({
      symbol:String(item.symbol).trim().toUpperCase(),
      reason:item.reason,
      first_open_at:null
    })).sort((a,b)=>a.symbol.localeCompare(b.symbol));
  if(!included.includes('BTCUSDT'))
    throw new Error('BTCUSDT_REQUIRED_PREHISTORY_UNAVAILABLE');
  return {
    schema:'PROSPECTIVE_HISTORY_START_PREFLIGHT_V1',
    status:'VERIFIED',
    expected_start_open_at:expectedStartOpenAt,
    candidate_count:candidateNames.length,
    included_candidate_count:included.length,
    excluded_candidate_count:excluded.length,
    included_symbols:included,
    excluded_symbols:excluded,
    every_candidate_accounted:true,
    current_ticker_liquidity_not_used:true,
    no_top_n_truncation:true
  };
}
