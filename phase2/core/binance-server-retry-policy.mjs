const RETRYABLE_SERVER_STATUSES=new Set([408,500,502,503,504]);
const MAX_SERVER_RETRIES=3;

/**
 * Return a bounded delay for a transient Binance gateway/server response.
 * Authentication/geography, IP-ban, rate-limit and other client responses are
 * intentionally excluded and retain their stricter dedicated handling.
 */
export function binanceServerRetryDelayMs(status,attempt,retryAfterHeader=null){
  const code=Number(status),index=Number(attempt);
  if(!RETRYABLE_SERVER_STATUSES.has(code)||
    !Number.isInteger(index)||index<1||index>MAX_SERVER_RETRIES)return null;
  const exponential=Math.min(8000,750*(2**(index-1)));
  const retryAfter=Number(retryAfterHeader);
  return Number.isFinite(retryAfter)&&retryAfter>0
    ?Math.max(exponential,retryAfter*1000):exponential;
}
