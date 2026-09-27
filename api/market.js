const PROVIDERS = {
  okx:{bases:['https://www.okx.com'],allow:p=>p.startsWith('/api/v5/market/')||p.startsWith('/api/v5/public/'),},
  bybit:{bases:['https://api.bybit.com'],allow:p=>p.startsWith('/v5/market/')},
  gate:{bases:['https://api.gateio.ws','https://api.gate.us'],allow:p=>p.startsWith('/api/v4/spot/')},
  coinbase:{bases:['https://api.exchange.coinbase.com'],allow:p=>p.startsWith('/products')},
  coingecko:{bases:['https://api.coingecko.com'],allow:p=>p.startsWith('/api/v3/')},
  binanceFutures:{bases:['https://fapi.binance.com'],allow:p=>p.startsWith('/fapi/v1/')||p.startsWith('/futures/data/')}
};

function timeoutSignal(ms){const c=new AbortController();const timer=setTimeout(()=>c.abort(),ms);return{signal:c.signal,clear:()=>clearTimeout(timer)};}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept');
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});

  const provider=String(req.query?.provider||'').trim();
  const raw=String(req.query?.path||'');
  const cfg=PROVIDERS[provider];
  if(!cfg)return res.status(400).json({error:'UNKNOWN_PROVIDER'});
  let path;
  try{path=decodeURIComponent(raw);}catch{return res.status(400).json({error:'BAD_PATH'});}
  if(!path.startsWith('/')||path.includes('://')||path.includes('\\')||!cfg.allow(path)){
    return res.status(403).json({error:'PATH_NOT_ALLOWED'});
  }

  const request=async base=>{
    const t=timeoutSignal(4500);
    try{
      const r=await fetch(base+path,{method:'GET',headers:{Accept:'application/json'},redirect:'follow',cache:'no-store',signal:t.signal});
      if(!r.ok)throw new Error('HTTP '+r.status);
      return await r.json();
    }finally{t.clear();}
  };

  try{
    const data=await Promise.any(cfg.bases.map(request));
    return res.status(200).json(data);
  }catch(e){
    return res.status(502).json({error:'UPSTREAM_UNAVAILABLE',provider,detail:e?.message||'upstream_failed'});
  }
}
