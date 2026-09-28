/* RadarX secondary market-data gateway 6.0
   Sequential provider failover + short cache to prevent request storms. */
const PROVIDERS = {
  okx:{bases:['https://www.okx.com'],allow:p=>p.startsWith('/api/v5/market/')||p.startsWith('/api/v5/public/')},
  bybit:{bases:['https://api.bybit.com'],allow:p=>p.startsWith('/v5/market/')},
  gate:{bases:['https://api.gateio.ws','https://api.gate.us'],allow:p=>p.startsWith('/api/v4/spot/')},
  coinbase:{bases:['https://api.exchange.coinbase.com'],allow:p=>p.startsWith('/products')},
  coingecko:{bases:['https://api.coingecko.com'],allow:p=>p.startsWith('/api/v3/')},
  binanceFutures:{bases:['https://fapi.binance.com'],allow:p=>p.startsWith('/fapi/v1/')||p.startsWith('/futures/data/')}
};
const store=globalThis.__RADARX_MARKET_GATEWAY__||(globalThis.__RADARX_MARKET_GATEWAY__={cache:new Map(),health:new Map()});
function now(){return Date.now();}
function ttl(provider){return provider==='coingecko'?15000:provider==='binanceFutures'?2500:3500;}
function timeoutSignal(ms){const c=new AbortController();const timer=setTimeout(()=>c.abort(),ms);return{signal:c.signal,clear:()=>clearTimeout(timer)};}
async function request(base,path){
  const t=timeoutSignal(5000),started=now();
  try{
    const r=await fetch(base+path,{method:'GET',headers:{Accept:'application/json'},redirect:'follow',cache:'no-store',signal:t.signal});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const data=await r.json();
    return {data,latency:now()-started};
  }finally{t.clear();}
}
function getCached(key,age){const hit=store.cache.get(key);return hit&&now()-hit.ts<=age?hit:null;}
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept');
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('X-RadarX-Gateway','market-6.0');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  const provider=String(req.query?.provider||'').trim(),raw=String(req.query?.path||''),cfg=PROVIDERS[provider];
  if(!cfg)return res.status(400).json({error:'UNKNOWN_PROVIDER'});
  let path;try{path=decodeURIComponent(raw);}catch{return res.status(400).json({error:'BAD_PATH'});}
  if(!path.startsWith('/')||path.includes('://')||path.includes('\\')||!cfg.allow(path))return res.status(403).json({error:'PATH_NOT_ALLOWED'});
  const key=provider+':'+path,hit=getCached(key,ttl(provider));
  if(hit){res.setHeader('X-RadarX-Cache','HIT');return res.status(200).json(hit.data);}
  let last=null;
  for(let i=0;i<cfg.bases.length;i++){
    const base=cfg.bases[i];
    try{
      const r=await request(base,path);
      store.cache.set(key,{ts:now(),data:r.data});
      store.health.set(provider,{ok:true,latency:r.latency,at:now()});
      res.setHeader('X-RadarX-Cache','MISS');res.setHeader('X-RadarX-Upstream',base);res.setHeader('X-RadarX-Latency-Ms',String(r.latency));
      return res.status(200).json(r.data);
    }catch(e){last=e;}
  }
  store.health.set(provider,{ok:false,error:String(last?.message||last),at:now()});
  return res.status(502).json({error:'UPSTREAM_UNAVAILABLE',provider,detail:String(last?.message||'upstream_failed')});
}
