const INTERVALS=new Set(['1m','5m','15m']);
const SYMBOL_PATTERN=/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}USDT$/u;

/**
 * Normalize and validate the opaque Binance Spot USDT symbol. Binance symbols
 * are identifiers, not guaranteed to be ASCII; filenames are encoded
 * separately so Unicode never becomes a path separator or platform-specific
 * filename ambiguity.
 */
export function normalizeBinanceSpotUsdtSymbol(symbol){
  const normalized=String(symbol??'').trim().toUpperCase();
  if(!SYMBOL_PATTERN.test(normalized))
    throw new TypeError('NEURAL_RAW_ARCHIVE_SYMBOL_INVALID:'+JSON.stringify(normalized.slice(0,80)));
  return normalized;
}

/**
 * Keep existing ASCII archive names stable. Encode every non-ASCII identifier
 * as a tilde-prefixed UTF-8 hex stem; tilde is excluded from valid exchange
 * symbols so this encoding cannot collide with a plain ASCII symbol.
 */
export function binanceRawArchiveFilename(symbol,interval){
  const normalized=normalizeBinanceSpotUsdtSymbol(symbol);
  const normalizedInterval=String(interval??'').trim();
  if(!INTERVALS.has(normalizedInterval))
    throw new TypeError('NEURAL_RAW_ARCHIVE_INTERVAL_INVALID');
  const stem=/^[A-Z0-9_-]+$/.test(normalized)
    ?normalized
    :'~'+Buffer.from(normalized,'utf8').toString('hex');
  return stem+'.'+normalizedInterval+'.json.gz';
}

export function isBinanceRawArchiveFilename(value){
  return typeof value==='string'&&
    /^(?:[A-Z0-9_-]+|~[a-f0-9]+)\.(?:1m|5m|15m)\.json\.gz$/.test(value);
}
