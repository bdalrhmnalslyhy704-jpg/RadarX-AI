export const TEST_FIXTURE = Object.freeze({name:'TEST_FIXTURE'});

export function candle(openTime,{tf='15m',price=100,closed=true,volume=100}={}){
  const step=tf==='4h'?14400000:tf==='1h'?3600000:900000;
  return {symbol:'TEST',timeframe:tf,openTime,closeTime:openTime+step-1,open:price,high:price+1,low:price-1,close:price+0.5,
    volume,quoteVolume:price*volume,tradeCount:100,takerBuyBaseVolume:volume/2,takerBuyQuoteVolume:price*volume/2,
    closed,source:'TEST_FIXTURE',sourceTime:openTime+step-1};
}
export function series(tf,count=30,start=1700000000000){
  const step=tf==='4h'?14400000:tf==='1h'?3600000:900000;
  return Array.from({length:count},(_,i)=>candle(start+i*step,{tf,price:100+i*0.1,closed:true,volume:100}));
}
export function incompleteSeries(tf,count=30,start=1700000000000){
  const a=series(tf,count,start);a.push(candle(start+count*(tf==='4h'?14400000:tf==='1h'?3600000:900000),{tf,closed:false,price:105}));return a;
}
export function pushSubscription(){return{endpoint:'https://push.example.test/subscription',expirationTime:null,device_token:'TEST_FIXTURE_DEVICE_TOKEN_123456789012345678901234',keys:{p256dh:'TEST_FIXTURE_P256DH',auth:'TEST_FIXTURE_AUTH'}};}
