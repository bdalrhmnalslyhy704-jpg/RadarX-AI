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
