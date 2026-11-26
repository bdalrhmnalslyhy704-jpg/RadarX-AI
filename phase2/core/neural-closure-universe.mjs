const STABLE_BASE_ASSETS=new Set([
  'USDC','BUSD','TUSD','FDUSD','USDP','DAI','USDE','EUR','AEUR',
  'EURI','TRY','BRL','BIDR','IDRT','UST','USTC','PAXG'
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
  minimumQuoteVolume=750_000,maxSymbols=100,includeAllEligible=false
}={}){
  if(!Array.isArray(exchangeInfo?.symbols)||!Array.isArray(tickers)||
    !finite(minimumQuoteVolume)||Number(minimumQuoteVolume)<750_000||
    !Number.isInteger(maxSymbols)||maxSymbols<10||maxSymbols>500||
    typeof includeAllEligible!=='boolean')
    throw new TypeError('BINANCE_SPOT_USDT_UNIVERSE_ARGUMENTS_INVALID');
  const tickerMap=new Map(tickers.map(item=>[String(item?.symbol??''),item]));
  const allowed=exchangeInfo.symbols.filter(item=>
    item?.status==='TRADING'&&item?.quoteAsset==='USDT'&&
    item?.isSpotTradingAllowed===true&&
    !STABLE_BASE_ASSETS.has(String(item?.baseAsset||'').toUpperCase())&&
    !/(UP|DOWN|BULL|BEAR)$/.test(String(item?.baseAsset||'').toUpperCase()));
  const eligible=allowed.map(symbol=>{
    const ticker=tickerMap.get(String(symbol.symbol));
    const quoteVolume=num(ticker?.quoteVolume);
    return quoteVolume!==null&&quoteVolume>=Number(minimumQuoteVolume)?{
      symbol:symbol.symbol,base_asset:symbol.baseAsset,
      quote_asset:symbol.quoteAsset,quote_volume_24h:quoteVolume,
      last_price:num(ticker?.lastPrice),price_change_pct:num(ticker?.priceChangePercent)
    }:null;
  }).filter(Boolean).sort((a,b)=>
    b.quote_volume_24h-a.quote_volume_24h||a.symbol.localeCompare(b.symbol));
  if(!eligible.some(item=>item.symbol==='BTCUSDT'))
    throw new Error('BTCUSDT_NOT_IN_750K_USDT_SPOT_UNIVERSE');
  if(includeAllEligible&&eligible.length>maxSymbols)
    throw new Error('ELIGIBLE_UNIVERSE_EXCEEDS_CONFIGURED_MAX_SYMBOLS:'+
      eligible.length+':'+maxSymbols);
  let selected=includeAllEligible?eligible:eligible.slice(0,maxSymbols);
  if(!selected.some(item=>item.symbol==='BTCUSDT')){
    selected=selected.slice(0,Math.max(0,maxSymbols-1));
    selected.push(eligible.find(item=>item.symbol==='BTCUSDT'));
    selected.sort((a,b)=>
      b.quote_volume_24h-a.quote_volume_24h||a.symbol.localeCompare(b.symbol));
  }
  return {eligible,selected};
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
  const results=symbolResults.map(item=>({
    symbol:String(item?.symbol??'').trim().toUpperCase(),
    status:item?.status,
    valid_events:Number(item?.valid_events),
    rejected_events:Number(item?.rejected_events),
    expected_events:Number(item?.expected_events),
    minimum_valid_events:Number(item?.minimum_valid_events),
    rejection_reasons:item?.rejection_reasons,
    rejection_reason_entries:item?.rejection_reasons&&
      typeof item.rejection_reasons==='object'&&!Array.isArray(item.rejection_reasons)
      ?Object.entries(item.rejection_reasons):null
  })).map(item=>({
    ...item,
    rejection_reasons_valid:Array.isArray(item.rejection_reason_entries)&&
      item.rejection_reason_entries.every(([reason,count])=>
        typeof reason==='string'&&reason.trim().length>0&&
        Number.isSafeInteger(Number(count))&&Number(count)>0),
    rejection_reason_count:Array.isArray(item.rejection_reason_entries)
      ?item.rejection_reason_entries.reduce((sum,[,count])=>sum+Number(count),0):NaN
  }));
  const resultNames=results.map(item=>item.symbol).sort();
  const same=(a,b)=>a.length===b.length&&a.every((value,index)=>value===b[index]);
  const minimumValidEvents=Math.ceil(decisionCount*0.8);
  if(results.some(item=>!item.symbol)||new Set(resultNames).size!==resultNames.length||
    !same(selected,resultNames)||results.some(item=>item.status!=='INCLUDED'||
      !Number.isSafeInteger(item.valid_events)||item.valid_events<minimumValidEvents||
      !Number.isSafeInteger(item.rejected_events)||item.rejected_events<0||
      !Number.isSafeInteger(item.expected_events)||item.expected_events!==decisionCount||
      !Number.isSafeInteger(item.minimum_valid_events)||
      item.minimum_valid_events!==minimumValidEvents||
      item.rejection_reasons_valid!==true||
      item.rejection_reason_count!==item.rejected_events||
      item.valid_events+item.rejected_events!==item.expected_events))
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
    Number(counts.requested_symbols)!==selected.length)
    throw new Error('PROSPECTIVE_COHORT_AGGREGATE_COUNTS_MISMATCH');
  return {
    schema:'PROSPECTIVE_COHORT_ROW_COVERAGE_AUDIT_V3',
    status:'VERIFIED',
    symbols_verified:selected.length,
    rows_verified:rows.length,
    first_decision_at:firstDecisionAt,
    last_decision_at:lastDecisionAt,
    decision_interval_ms:decisionIntervalMs,
    decision_count:decisionCount,
    minimum_valid_events_per_symbol:minimumValidEvents,
    no_unexpected_symbols:true,
    per_symbol_row_counts_match:true,
    per_symbol_event_accounting_matches_schedule:true,
    rejection_reason_accounting_matches_schedule:true,
    minimum_event_coverage_met_for_every_symbol:true,
    all_rows_on_declared_decision_grid:true
  };
}
