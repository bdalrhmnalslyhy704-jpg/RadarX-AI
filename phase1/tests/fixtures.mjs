export const TEST_FIXTURE = true;

export function makeCandle(openTime, open, high, low, close, volume, closed=true){
  return {openTime,closeTime:openTime+59_999,open,high,low,close,volume,
    quoteVolume:close*volume,tradeCount:100,takerBuyBaseVolume:volume*0.55,
    takerBuyQuoteVolume:close*volume*0.55,closed,source:'TEST_FIXTURE'};
}
export function upSeries({n=240,start=100,step=.5,volume=1000}={}){
  const out=[]; for(let i=0;i<n;i++){const o=start+i*step,c=o+step;out.push(makeCandle(i*60_000,o,c+.2,o-.1,c,volume*(1+(i%7)*.01)));} return out;
}
export function downSeries({n=240,start=200,step=.5,volume=1000}={}){
  const out=[]; for(let i=0;i<n;i++){const o=start-i*step,c=o-step;out.push(makeCandle(i*60_000,o,o+.1,c-.2,c,volume*(1+(i%7)*.01)));} return out;
}
export function breakoutSeries({n=60,base=100,range=1,breakClose=103,volume=1000}={}){
  const out=[]; for(let i=0;i<n;i++){if(i<n-1)out.push(makeCandle(i*900_000,base,base+range,base-range,base+.1,volume));else out.push(makeCandle(i*900_000,base+.2,breakClose+.2,base+.1,breakClose,volume*2.2));} return out;
}
export function oversoldSeries({n=60,start=100}={}){
  const out=[]; let p=start; for(let i=0;i<n-2;i++){const next=p-.6;out.push(makeCandle(i*3_600_000,p,p+.2,next-.1,next,1200));p=next;}
  out.push(makeCandle((n-2)*3_600_000,p,p+.15,p-1,p-.8,2600));
  out.push(makeCandle((n-1)*3_600_000,p-.8,p+.9,p-.9,p+.6,1400)); return out;
}