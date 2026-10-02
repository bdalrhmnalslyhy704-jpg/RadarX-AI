// RadarX Binance Spot Public Market Data Relay
// Browser -> same-origin Vercel relay -> Binance Spot.
// The relay deliberately avoids parallel fan-out to Binance because Binance rate
// limits are IP-based and repeated 429s can lead to temporary IP bans.

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

const state = globalThis.__RADARX_BINANCE_RELAY__ || (globalThis.__RADARX_BINANCE_RELAY__ = {
  preferred: 0,
  health: UPSTREAMS.map(() => ({ok:0,fail:0,lastOk:0,lastFail:0,latencyMs:0,cooldownUntil:0})),
  cache: new Map()
});

function now(){ return Date.now(); }

function timeoutSignal(ms){
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), ms);
  return {signal:c.signal, clear:()=>clearTimeout(timer)};
}

function ttlFor(pathname){
  if(pathname === '/api/v3/exchangeInfo') return 5 * 60 * 1000;
  if(pathname === '/api/v3/ticker/24hr' || pathname === '/api/v3/ticker') return 1200;
  if(pathname === '/api/v3/klines' || pathname === '/api/v3/uiKlines') return 1800;
  if(pathname === '/api/v3/depth') return 700;
  if(pathname === '/api/v3/aggTrades' || pathname === '/api/v3/trades') return 600;
  if(pathname === '/api/v3/time' || pathname === '/api/v3/ping') return 1000;
  return 1000;
}

function staleTtlFor(pathname){
  return Math.max(ttlFor(pathname) * 12, 3000);
}

function getCached(key, allowStale=false){
  const hit = state.cache.get(key);
  if(!hit) return null;
  const age = now() - hit.ts;
  if(age <= ttlFor(hit.pathname) || (allowStale && age <= staleTtlFor(hit.pathname))){
    return {...hit, age};
  }
  state.cache.delete(key);
  return null;
}

function setCached(key, pathname, body){
  state.cache.set(key,{pathname,ts:now(),body});
  if(state.cache.size>350){
    const oldest = [...state.cache.entries()].sort((a,b)=>a[1].ts-b[1].ts).slice(0,80);
    oldest.forEach(([k])=>state.cache.delete(k));
  }
}

function orderedIndexes(){
  const list=[];
  const add=i=>{if(i>=0&&i<UPSTREAMS.length&&!list.includes(i))list.push(i);};
  add(state.preferred);
  const scored=state.health.map((h,i)=>({i,h})).sort((a,b)=>{
    const sa=(a.h.cooldownUntil>now()?-100000:0)+(a.h.lastOk?Math.min(40,(now()-a.h.lastOk<30000)?20:0):0)+(a.h.ok-a.h.fail*2)*0.4-(a.h.latencyMs||0)/300;
    const sb=(b.h.cooldownUntil>now()?-100000:0)+(b.h.lastOk?Math.min(40,(now()-b.h.lastOk<30000)?20:0):0)+(b.h.ok-b.h.fail*2)*0.4-(b.h.latencyMs||0)/300;
    return sb-sa;
  });
  scored.forEach(({i})=>add(i));
  return list;
}

function mark(i,ok,latencyMs=0,cooldownUntil=0){
  const h=state.health[i];
  if(!h)return;
  if(ok){h.ok++;h.lastOk=now();h.latencyMs=latencyMs||h.latencyMs||0;h.cooldownUntil=0;state.preferred=i;}
  else{h.fail++;h.lastFail=now();if(cooldownUntil)h.cooldownUntil=cooldownUntil;}
}

async function requestUpstream(index,url){
  const t0=now();
  const timeout=timeoutSignal(5200);
  try{
    const r=await fetch(url,{
      method:'GET',
      headers:{Accept:'application/json','User-Agent':'RadarX-AI/5.11'},
      redirect:'follow',
      cache:'no-store',
      signal:timeout.signal
    });
    const latency=now()-t0;
    const raw=await r.text();
    let data=null;
    try{data=raw?JSON.parse(raw):null;}catch{throw Object.assign(new Error('UPSTREAM_INVALID_JSON'),{httpStatus:r.status});}
    if(!r.ok){
      const retryAfter=Number(r.headers.get('retry-after')||0);
      const cooldown=Math.max(retryAfter*1000, r.status===429?10000:0);
      const err=Object.assign(new Error('HTTP '+r.status),{status:r.status,retryAfterMs:cooldown,body:data});
      mark(index,false,latency,cooldown?now()+cooldown:0);
      throw err;
    }
    mark(index,true,latency);
    return {data,latency};
  }catch(e){
    if(e?.name==='AbortError'){
      mark(index,false,now()-t0);
      throw Object.assign(new Error('UPSTREAM_TIMEOUT'),{status:504});
    }
    if(!e?.status)mark(index,false,now()-t0);
    throw e;
  }finally{timeout.clear();}
}

function setCors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept');
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('X-RadarX-Relay','binance-spot');
}

export default async function handler(req,res){
  setCors(res);
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return res.status(405).json({code:-1,msg:'Method not allowed'});

  const rawPath=String(req.query?.path||'');
  if(!rawPath.startsWith('/api/v3/'))return res.status(400).json({code:-1,msg:'Invalid Binance path'});

  let parsed;
  try{parsed=new URL('https://data-api.binance.vision'+rawPath);}
  catch{return res.status(400).json({code:-1,msg:'Invalid Binance URL'});}
  if(!ALLOWED_PATHS.has(parsed.pathname))return res.status(403).json({code:-1,msg:'Endpoint not allowed'});

  const key=parsed.pathname+parsed.search;
  const fresh=getCached(key,false);
  if(fresh){
    res.setHeader('X-RadarX-Cache','HIT');
    res.setHeader('X-RadarX-Data-Age-Ms',String(fresh.age));
    res.setHeader('X-RadarX-Upstream','cache');
    return res.status(200).json(fresh.body);
  }

  const indexes=orderedIndexes();
  let lastErr=null;
  for(const i of indexes){
    if(state.health[i]?.cooldownUntil>now())continue;
    try{
      const base=UPSTREAMS[i];
      const result=await requestUpstream(i,base+key);
      setCached(key,parsed.pathname,result.data);
      res.setHeader('X-RadarX-Cache','MISS');
      res.setHeader('X-RadarX-Upstream',base);
      res.setHeader('X-RadarX-Latency-Ms',String(result.latency));
      res.setHeader('X-RadarX-Data-Age-Ms','0');
      return res.status(200).json(result.data);
    }catch(e){
      lastErr=e;
    }
  }

  // A short stale window is safer than manufacturing data. The client-side
  // freshness gates decide whether stale data can be used for a live signal.
  const stale=getCached(key,true);
  if(stale){
    res.setHeader('X-RadarX-Cache','STALE');
    res.setHeader('X-RadarX-Upstream','cache');
    res.setHeader('X-RadarX-Data-Age-Ms',String(stale.age));
    return res.status(200).json(stale.body);
  }

  return res.status(502).json({
    code:-1,
    msg:'Binance Spot relay unavailable',
    detail:lastErr?.message||'upstream_unavailable',
    status:lastErr?.status||502
  });
}
