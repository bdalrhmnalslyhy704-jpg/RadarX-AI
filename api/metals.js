const TWELVE='https://api.twelvedata.com';
const METALS='https://api.metals-api.com/api';
const YAHOO='https://query1.finance.yahoo.com/v8/finance/chart';

function timeoutSignal(ms){const c=new AbortController();const timer=setTimeout(()=>c.abort(),ms);return{signal:c.signal,clear:()=>clearTimeout(timer)};}
async function getJSON(url,headers={}){
  const t=timeoutSignal(5000);
  try{
    const r=await fetch(url,{headers:{Accept:'application/json',...headers},cache:'no-store',redirect:'follow',signal:t.signal});
    if(!r.ok)throw new Error('HTTP '+r.status);
    return await r.json();
  }finally{t.clear();}
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept');
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return res.status(405).json({ok:false,error:'METHOD_NOT_ALLOWED'});

  const symbol=String(req.query?.symbol||'XAU/USD').toUpperCase();
  const apiSymbol=symbol.includes('/')?symbol:'XAU/USD';

  const twelveKey=String(process.env.TWELVEDATA_API_KEY||'').trim();
  if(twelveKey){
    try{
      const url=TWELVE+'/price?symbol='+encodeURIComponent(apiSymbol)+'&apikey='+encodeURIComponent(twelveKey);
      const d=await getJSON(url);
      const price=Number(d?.price);
      if(Number.isFinite(price)&&price>0)return res.status(200).json({ok:true,symbol:apiSymbol,price,timestamp:Date.now(),source:'Twelve Data',quality:'provider-key'});
    }catch{}
  }

  const metalsKey=String(process.env.METALS_API_KEY||'').trim();
  if(metalsKey){
    try{
      const url=METALS+'/latest?access_key='+encodeURIComponent(metalsKey)+'&base=USD&symbols=XAU';
      const d=await getJSON(url);
      const v=Number(d?.rates?.USDXAU||0);
      if(Number.isFinite(v)&&v>0)return res.status(200).json({ok:true,symbol:'XAU/USD',price:v,timestamp:Number(d?.timestamp||Math.floor(Date.now()/1000))*1000,source:'Metals-API',quality:'provider-key'});
      const r=Number(d?.rates?.XAU||0);
      if(r>0)return res.status(200).json({ok:true,symbol:'XAU/USD',price:1/r,timestamp:Number(d?.timestamp||Math.floor(Date.now()/1000))*1000,source:'Metals-API',quality:'provider-key'});
    }catch{}
  }

  // Best-effort public fallback for visibility only. Yahoo explicitly states its
  // finance data is informational; therefore this is never labeled as a
  // trading-grade real-time source.
  const yahooMap={'XAU/USD':'GC=F','XAG/USD':'SI=F','WTI/USD':'CL=F','BRENT/USD':'BZ=F','EUR/USD':'EURUSD=X','USD/JPY':'JPY=X','DXY':'DX-Y.NYB'};
  const yahooSymbol=yahooMap[symbol]||'GC=F';
  try{
    const d=await getJSON(YAHOO+'/'+encodeURIComponent(yahooSymbol)+'?range=1d&interval=1m');
    const r=d?.chart?.result?.[0], q=r?.meta?.regularMarketPrice;
    if(Number.isFinite(Number(q))&&Number(q)>0){
      return res.status(200).json({ok:true,symbol,price:Number(q),timestamp:Number(r?.meta?.regularMarketTime||Math.floor(Date.now()/1000))*1000,source:'Yahoo Finance',quality:'public-indicative',delayed:true,instrument:yahooSymbol});
    }
  }catch{}

  return res.status(503).json({ok:false,symbol,error:'NO_METALS_PROVIDER',message:'Configure TWELVEDATA_API_KEY or METALS_API_KEY for trading-grade metal data.'});
}
