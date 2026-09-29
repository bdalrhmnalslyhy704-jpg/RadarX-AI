export const TEST_FIXTURE = true;

export function makeCandle(openTime, open, high, low, close, volume, closed=true){
  return {openTime,closeTime:openTime+59_999,open,high,low,close,volume,
    quoteVolume:close*volume,tradeCount:100,takerBuyBaseVolume:volume*0.55,
    takerBuyQuoteVolume:close*volume*0.55,closed,source:'TEST_FIXTURE'};
}
