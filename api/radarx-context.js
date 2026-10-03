/* RadarX Multi-Source Context 6.0
   Independent market context: CoinGecko + CoinMarketCap keyless + Alternative.me.
   No trade execution, no synthetic values; partial-source success is valid. */
const G=globalThis.__RADARX_CONTEXT_6__||(globalThis.__RADARX_CONTEXT_6__={ts:0,data:null});
const SOURCES=[
  {id:'coingecko',url:'https://api.coingecko.com/api/v3/global'},
  {id:'cmc',url:'https://pro-api.coinmarketcap.com/public-api/v1/global-metrics/quotes/latest'},
  {id:'cmcFg',url:'https://pro-api.coinmarketcap.com/public-api/v3/fear-and-greed/latest'},
  {id:'alternativeFg',url:'https://api.alternative.me/fng/?limit=1'}
];
function timeoutSignal(ms){const c=new AbortController();const timer=setTimeout(()=>c.abort(),ms);return{signal:c.signal,clear:()=>clearTimeout(timer)};}
async function get(id,url){
  const t=timeoutSignal(4500),started=Date.now();
  try{
    const r=await fetch(url,{method:'GET',headers:{Accept:'application/json'},cache:'no-store',signal:t.signal});
    if(!r.ok)throw new Error('HTTP '+r.status);
    return {id,data:await r.json(),latencyMs:Date.now()-started};
  }finally{t.clear();}
}
function n(x){const v=Number(x);return Number.isFinite(v)?v:null;}
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept');
  res.setHeader('Cache-Control','public, max-age=10, s-maxage=10, stale-while-revalidate=30');
  res.setHeader('X-RadarX-Context','6.0');
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return res.status(405).json({ok:false,error:'METHOD_NOT_ALLOWED'});
  if(G.data && Date.now()-G.ts<12000)return res.status(200).json({...G.data,cache:'HIT',ageMs:Date.now()-G.ts});
  const rr=await Promise.allSettled(SOURCES.map(s=>get(s.id,s.url)));
  const source={}; for(const x of rr)if(x.status==='fulfilled')source[x.value.id]={ok:true,data:x.value.data,latencyMs:x.value.latencyMs};
  const cg=source.coingecko?.data?.data||{};
  const cmc=source.cmc?.data?.data||{};
  const cmcFg=source.cmcFg?.data?.data||source.cmcFg?.data?.data?.[0]||{};
  const alt=source.alternativeFg?.data?.data?.[0]||{};
  const btcD=n(cg.market_cap_percentage?.btc)??n(cmc.btc_dominance);
  const totalMcap=n(cg.total_market_cap?.usd)??n(cmc.total_market_cap?.usd);
  const mcap24=n(cg.market_cap_change_percentage_24h_usd)??n(cmc.total_market_cap_by_obscuration);
  const fg=n(cmcFg.value)??n(cmcFg.score)??n(alt.value);
  const fgLabel=cmcFg.value_classification||alt.value_classification||null;
  const out={
    ok:Object.keys(source).length>0,
    checkedAt:Date.now(),
    sources:Object.fromEntries(SOURCES.map(s=>[s.id,source[s.id]?{ok:true,latencyMs:source[s.id].latencyMs}:{ok:false}])),
    availableSources:Object.keys(source),
    btcDominance:btcD,
    totalMarketCapUsd:totalMcap,
    marketCapChange24h:n(cg.market_cap_change_percentage_24h_usd),
    fearGreed:fg,
    fearGreedLabel:fgLabel,
    sourcePriority:['coingecko','cmc','cmcFg','alternativeFg']
  };
  G.ts=Date.now();G.data=out;
  return res.status(200).json({...out,cache:'MISS',ageMs:0});
}
