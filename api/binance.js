// RadarX Binance Public Market Data Proxy
const UPSTREAMS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com'
];

const ALLOWED_PATHS = new Set([
  '/api/v3/ping','/api/v3/time','/api/v3/exchangeInfo',
  '/api/v3/ticker','/api/v3/ticker/24hr','/api/v3/ticker/bookTicker',
  '/api/v3/ticker/price','/api/v3/klines','/api/v3/uiKlines',
  '/api/v3/depth','/api/v3/aggTrades','/api/v3/trades'
]);

function timeoutSignal(ms){
  const c=new AbortController();
  const timer=setTimeout(()=>c.abort(),ms);
  return {signal:c.signal,clear:()=>clearTimeout(timer)};
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept');
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return res.status(405).json({code:-1,msg:'Method not allowed'});

  const rawPath=String(req.query?.path||'');
  if(!rawPath.startsWith('/api/v3/'))return res.status(400).json({code:-1,msg:'Invalid Binance path'});

  let parsed;
  try{parsed=new URL('https://data-api.binance.vision'+rawPath);}
  catch{return res.status(400).json({code:-1,msg:'Invalid Binance URL'});}

  if(!ALLOWED_PATHS.has(parsed.pathname))return res.status(403).json({code:-1,msg:'Endpoint not allowed'});

  const suffix=parsed.pathname+parsed.search;
  const makeRequest=async(base)=>{
    const t=timeoutSignal(4500);
    try{
      const r=await fetch(base+suffix,{method:'GET',headers:{Accept:'application/json'},redirect:'follow',cache:'no-store',signal:t.signal});
      if(!r.ok)throw new Error('HTTP '+r.status);
      return await r.json();
    }finally{t.clear();}
  };

  try{
    const data=await Promise.any(UPSTREAMS.map(makeRequest));
    return res.status(200).json(data);
  }catch(e){
    return res.status(502).json({code:-1,msg:'All Binance upstreams failed',detail:e?.message||'upstream_unavailable'});
  }
}
