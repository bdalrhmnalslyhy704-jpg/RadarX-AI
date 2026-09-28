/* RadarX Smart Scan Bulk Kline Gateway 6.9
   Fetches 1m + 5m spot candles for a bounded symbol set server-side.
   The client still keeps a per-symbol fallback path when this gateway fails.
   No synthetic market data is produced. */
const UPSTREAMS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com'
];
const state = globalThis.__RADARX_SMART_69__ || (globalThis.__RADARX_SMART_69__ = {ts:0,key:'',data:null});
function cleanSymbol(s){return String(s||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');}
function validSymbol(s){return /^[A-Z0-9]{4,24}USDT$/.test(s) && !/^(USDC|USDP|FDUSD|TUSD|DAI|USDE|USDS|BUSD)USDT$/.test(s) && !/(UP|DOWN|BULL|BEAR)USDT$/.test(s);}
function timeoutSignal(ms){const c=new AbortController();const timer=setTimeout(()=>c.abort(),ms);return{signal:c.signal,clear:()=>clearTimeout(timer)};}
async function fetchOne(pathname){
  let last=null;
  for(const base of UPSTREAMS){
    const t=timeoutSignal(3500);
    try{
      const r=await fetch(base+pathname,{method:'GET',headers:{Accept:'application/json','User-Agent':'RadarX-Smart/6.9'},cache:'no-store',signal:t.signal});
      if(!r.ok)throw new Error('HTTP '+r.status);
      const data=await r.json();
      if(!Array.isArray(data))throw new Error('INVALID_KLINES');
      return data;
    }catch(e){last=e;}finally{t.clear();}
  }
  throw last||new Error('UPSTREAM_UNAVAILABLE');
}
async function mapLimit(items,limit,worker){
  const out=new Array(items.length), cursor={i:0};
  async function run(){
    while(cursor.i<items.length){
      const i=cursor.i++;
      try{out[i]=await worker(items[i],i);}catch{out[i]=null;}
    }
  }
  const n=Math.min(limit,items.length);
  await Promise.all(Array.from({length:n},run));
  return out;
}
function normalize(rows){
  return (rows||[]).map(r=>({
    t:Number(r[0]),o:Number(r[1]),h:Number(r[2]),l:Number(r[3]),c:Number(r[4]),v:Number(r[5]),q:Number(r[7]),trades:Number(r[8]),tb:Number(r[9]),closed:Number(r[6])<=Date.now()
  })).filter(r=>r.t>0&&r.o>0&&r.h>0&&r.l>0&&r.c>0&&r.h>=Math.max(r.o,r.c)&&r.l<=Math.min(r.o,r.c)&&r.h>=r.l&&r.v>=0&&r.q>=0);
}
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept');
  res.setHeader('Cache-Control','public, s-maxage=5, stale-while-revalidate=15');
  res.setHeader('X-RadarX-Smart-Gateway','6.9');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return res.status(405).json({ok:false,error:'METHOD_NOT_ALLOWED'});
  const symbols=String(req.query?.symbols||'').split(',').map(cleanSymbol).filter(validSymbol);
  const unique=[...new Set(symbols)].slice(0,32);
  if(!unique.length)return res.status(400).json({ok:false,error:'NO_SYMBOLS'});
  const key=unique.join(',');
  if(state.data&&state.key===key&&Date.now()-state.ts<5000)return res.status(200).json({...state.data,cache:'HIT',ageMs:Date.now()-state.ts});
  const started=Date.now();
  const rows=await mapLimit(unique,8,async symbol=>{
    const [one,five]=await Promise.all([
      fetchOne('/api/v3/klines?symbol='+encodeURIComponent(symbol)+'&interval=1m&limit=64'),
      fetchOne('/api/v3/klines?symbol='+encodeURIComponent(symbol)+'&interval=5m&limit=96')
    ]);
    return {symbol,rows1m:normalize(one),rows5m:normalize(five)};
  });
  const bySymbol={};
  rows.forEach(x=>{if(x?.symbol)bySymbol[x.symbol]={symbol:x.symbol,rows1m:x.rows1m||[],rows5m:x.rows5m||[]};});
  const data={ok:Object.keys(bySymbol).length>0,provider:'binance',checkedAt:Date.now(),latencyMs:Date.now()-started,requested:unique.length,returned:Object.keys(bySymbol).length,bySymbol};
  if(data.ok){state.ts=Date.now();state.key=key;state.data=data;}
  return res.status(data.ok?200:502).json(data);
}
