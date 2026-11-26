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
