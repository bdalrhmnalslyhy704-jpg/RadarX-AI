const CHECKS = [
  {id:'binance', label:'Binance Spot', url:'https://data-api.binance.vision/api/v3/ping', family:'crypto'},
  {id:'okx', label:'OKX Spot', url:'https://www.okx.com/api/v5/public/time', family:'crypto'},
  {id:'bybit', label:'Bybit Spot', url:'https://api.bybit.com/v5/market/time', family:'crypto'},
  {id:'gate', label:'Gate Spot', url:'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT', family:'crypto'},
  {id:'coinbase', label:'Coinbase', url:'https://api.exchange.coinbase.com/products/BTC-USD/ticker', family:'crypto'},
  {id:'coingecko', label:'CoinGecko', url:'https://api.coingecko.com/api/v3/ping', family:'global'},
  {id:'binanceFutures', label:'Binance Futures', url:'https://fapi.binance.com/fapi/v1/ping', family:'derivatives'},
  {id:'yahoo', label:'Yahoo Finance', url:'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=1d&interval=5m', family:'metals'}
];

function timeoutSignal(ms){
  const c=new AbortController();
  const timer=setTimeout(()=>c.abort(),ms);
  return {signal:c.signal,clear:()=>clearTimeout(timer)};
}

async function probe(x){
  const started=Date.now();
  const t=timeoutSignal(3500);
  try{
    const r=await fetch(x.url,{method:'GET',headers:{Accept:'application/json'},cache:'no-store',redirect:'follow',signal:t.signal});
    const latency=Date.now()-started;
    if(!r.ok)throw new Error('HTTP '+r.status);
    const data=await r.json();
    return {id:x.id,label:x.label,family:x.family,ok:true,latencyMs:latency,checkedAt:Date.now(),httpStatus:r.status,hasData:data!=null};
  }catch(e){
    return {id:x.id,label:x.label,family:x.family,ok:false,latencyMs:Date.now()-started,checkedAt:Date.now(),error:String(e?.message||e)};
  }finally{t.clear();}
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept');
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return res.status(405).json({ok:false,error:'METHOD_NOT_ALLOWED'});
  const started=Date.now();
  const results=await Promise.all(CHECKS.map(probe));
  const crypto=results.filter(x=>x.family==='crypto');
  const summary={
    checkedAt:Date.now(),
    durationMs:Date.now()-started,
    total:results.length,
    online:results.filter(x=>x.ok).length,
    cryptoOnline:crypto.filter(x=>x.ok).length,
    metalsOnline:results.filter(x=>x.family==='metals'&&x.ok).length,
    results
  };
  return res.status(200).json({ok:true,...summary});
}
