/* RadarX Smart Deep Bulk Gateway 6.9
   Collects the same evidence used by Smart Trader's deep stage for up to 8
   Binance Spot symbols. No synthetic data. */
const UPSTREAMS=['https://data-api.binance.vision','https://api.binance.com','https://api-gcp.binance.com','https://api1.binance.com','https://api2.binance.com'];
const state=globalThis.__RADARX_SMART_DEEP_69__||(globalThis.__RADARX_SMART_DEEP_69__={ts:0,key:'',data:null});
function clean(s){return String(s||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');}
function valid(s){return /^[A-Z0-9]{4,24}USDT$/.test(s)&&!/^(USDC|USDP|FDUSD|TUSD|DAI|USDE|USDS|BUSD)USDT$/.test(s)&&!/(UP|DOWN|BULL|BEAR)USDT$/.test(s);}
function timeoutSignal(ms){const c=new AbortController(),tm=setTimeout(()=>c.abort(),ms);return{signal:c.signal,clear:()=>clearTimeout(tm)};}
async function get(path){
  let last=null;
  for(const base of UPSTREAMS){
    const t=timeoutSignal(3500);
    try{
      const r=await fetch(base+path,{headers:{Accept:'application/json','User-Agent':'RadarX-Smart-Deep/6.9'},cache:'no-store',signal:t.signal});
      if(!r.ok)throw new Error('HTTP '+r.status);
      return await r.json();
    }catch(e){last=e;}finally{t.clear();}
  }
  throw last||new Error('UPSTREAM_UNAVAILABLE');
}
function normK(rows){return (rows||[]).map(r=>({t:Number(r[0]),o:Number(r[1]),h:Number(r[2]),l:Number(r[3]),c:Number(r[4]),v:Number(r[5]),q:Number(r[7]),trades:Number(r[8]),tb:Number(r[9]),closed:Number(r[6])<=Date.now()})).filter(r=>r.t>0&&r.o>0&&r.h>0&&r.l>0&&r.c>0&&r.h>=Math.max(r.o,r.c)&&r.l<=Math.min(r.o,r.c)&&r.h>=r.l&&r.v>=0&&r.q>=0);}
function normD(d){return{bids:Array.isArray(d?.bids)?d.bids:[],asks:Array.isArray(d?.asks)?d.asks:[]};}
function normT(rows){return (rows||[]).map(x=>({id:x.a,price:Number(x.p),amount:Number(x.q),buy:!x.m,t:Number(x.T)})).filter(x=>x.price>0&&x.amount>0&&x.t>0);}
async function mapLimit(items,limit,worker){
  const out=new Array(items.length),cursor={i:0};
  async function run(){while(cursor.i<items.length){const i=cursor.i++;try{out[i]=await worker(items[i]);}catch{out[i]=null;}}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},run));
  return out;
}
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept');
  res.setHeader('Cache-Control','public, s-maxage=4, stale-while-revalidate=12');
  res.setHeader('X-RadarX-Smart-Deep','6.9');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return res.status(405).json({ok:false,error:'METHOD_NOT_ALLOWED'});
  const syms=[...new Set(String(req.query?.symbols||'').split(',').map(clean).filter(valid))].slice(0,8);
  if(!syms.length)return res.status(400).json({ok:false,error:'NO_SYMBOLS'});
  const key=syms.join(',');
  if(state.data&&state.key===key&&Date.now()-state.ts<4500)return res.status(200).json({...state.data,cache:'HIT',ageMs:Date.now()-state.ts});
  const started=Date.now();
  const rows=await mapLimit(syms,4,async symbol=>{
    const [depth,trades,k15,k1h]=await Promise.all([
      get('/api/v3/depth?symbol='+encodeURIComponent(symbol)+'&limit=100'),
      get('/api/v3/aggTrades?symbol='+encodeURIComponent(symbol)+'&limit=500'),
      get('/api/v3/klines?symbol='+encodeURIComponent(symbol)+'&interval=15m&limit=90'),
      get('/api/v3/klines?symbol='+encodeURIComponent(symbol)+'&interval=1h&limit=90')
    ]);
    return {symbol,depth:normD(depth),trades:normT(trades),rows15m:normK(k15),rows1h:normK(k1h)};
  });
  const bySymbol={};rows.forEach(x=>{if(x?.symbol)bySymbol[x.symbol]=x;});
  const data={ok:Object.keys(bySymbol).length>0,provider:'binance',checkedAt:Date.now(),latencyMs:Date.now()-started,requested:syms.length,returned:Object.keys(bySymbol).length,bySymbol};
  if(data.ok){state.ts=Date.now();state.key=key;state.data=data;}
  return res.status(data.ok?200:502).json(data);
}
