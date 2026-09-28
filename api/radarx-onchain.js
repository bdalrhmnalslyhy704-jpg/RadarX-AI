/* RadarX on-chain DEX intelligence
   Public GeckoTerminal API; no secret is embedded in the app. */
const BASE="https://api.geckoterminal.com/api/v2";
const CACHE=new Map();

function num(x,d=null){const n=Number(x);return Number.isFinite(n)?n:d;}
function clamp(x){return Math.max(0,Math.min(100,Number(x)||0));}
function pickPool(symbol,data){
  const rows=Array.isArray(data?.data)?data.data:[];
  const sym=String(symbol||"").toUpperCase();
  const included=Array.isArray(data?.included)?data.included:[];
  const tokenMap=new Map(included.filter(x=>x?.id).map(x=>[x.id,x.attributes||{}]));
  const scored=rows.map(row=>{
    const a=row?.attributes||{};
    const reserve=num(a.reserve_in_usd,0),vol=num(a.volume_usd?.h24,0),tx=(num(a.transactions?.h24?.buys,0)+num(a.transactions?.h24?.sells,0));
    let matched=false;
    const baseRel=row?.relationships?.base_token?.data?.id;
    const base=tokenMap.get(baseRel);
    if(String(base?.symbol||"").toUpperCase()===sym)matched=true;
    if(!matched&&String(a.name||"").toUpperCase().split(/\s*[\/:]\s*/)[0]===sym)matched=true;
    return {row,a,reserve,vol,tx,matched};
  }).filter(x=>x.reserve>0||x.vol>0).sort((x,y)=>
    (Number(y.matched)-Number(x.matched))*1e18+(y.reserve-x.reserve)+(y.vol-x.vol));
  return scored[0]||null;
}
function analyze(symbol,pick){
  if(!pick)return {available:false,symbol};
  const a=pick.a, reserve=pick.reserve, vol=pick.vol;
  const buys=num(a.transactions?.h24?.buys,0), sells=num(a.transactions?.h24?.sells,0);
  const buyers=num(a.transactions?.h24?.buyers,0), sellers=num(a.transactions?.h24?.sellers,0);
  const flowRatio=(buys+sells)>0?buys/(buys+sells)*100:null;
  const tx=buys+sells;
  const pc=num(a.price_change_percentage?.h24,null);
  const score=clamp(50
    + (vol>0?Math.min(20,Math.log10(Math.max(1,vol))/8*20):0)
    + (reserve>0?Math.min(20,Math.log10(Math.max(1,reserve))/8*20):0)
    + (flowRatio!=null?(flowRatio-50)*0.22:0)
    + (tx>0?Math.min(10,Math.log10(tx+1)*2):0)
    + (pc!=null?Math.max(-10,Math.min(10,pc*1.5)):0));
  const fdv=num(a.fdv_usd,null),mc=num(a.market_cap_usd,null);
  let tokenScore=null;
  if(fdv>0&&mc>0)tokenScore=clamp((mc/fdv)*100);
  return {
    available:true,symbol,score:Number(score.toFixed(2)),
    reserveUsd:reserve,volume24hUsd:vol,tx24h:tx,buys,sells,buyers,sellers,
    buyPct:flowRatio,priceChange24h:pc,fdvUsd:fdv,marketCapUsd:mc,
    marketCapToFdv:fdv>0&&mc>0?mc/fdv:null,
    poolName:a.name||null,network:String(rowNetwork(pick.row?.id)||''),poolId:pick.row?.id||null,
    source:"GeckoTerminal"
  };
}
function rowNetwork(id){const s=String(id||"");return s.split("_")[0]||"";}

export default async function handler(req,res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Accept");
  res.setHeader("Cache-Control","s-maxage=90, stale-while-revalidate=180");
  if(req.method==="OPTIONS")return res.status(204).end();
  if(req.method!=="GET")return res.status(405).json({ok:false,error:"METHOD_NOT_ALLOWED"});
  const symbols=String(req.query?.symbols||"").split(",").map(x=>x.trim().toUpperCase().replace(/USDT$/,"")).filter(Boolean).slice(0,10);
  const onchainBySymbol={},tokenomicsBySymbol={};
  for(const sym of symbols){
    const hit=CACHE.get(sym);
    if(hit&&Date.now()-hit.ts<90000){onchainBySymbol[sym]=hit.onchain;tokenomicsBySymbol[sym]=hit.tokenomics;continue;}
    try{
      const url=BASE+"/search/pools?query="+encodeURIComponent(sym)+"&include=base_token,quote_token,dex";
      const r=await fetch(url,{headers:{Accept:"application/json","User-Agent":"RadarX-Onchain/1.0"}});
      if(!r.ok)throw new Error("HTTP "+r.status);
      const data=await r.json();
      const pool=pickPool(sym,data), result=analyze(sym,pool);
      const tokenomics=result.available&&result.marketCapToFdv!=null
        ? {available:true,score:clamp(result.marketCapToFdv*100),marketCapToFdv:result.marketCapToFdv,marketCapUsd:result.marketCapUsd,fdvUsd:result.fdvUsd,source:"GeckoTerminal"}
        : {available:false,symbol:sym};
      const cached={ts:Date.now(),onchain:result,tokenomics};
      CACHE.set(sym,cached);onchainBySymbol[sym]=result;tokenomicsBySymbol[sym]=tokenomics;
    }catch(e){
      onchainBySymbol[sym]={available:false,symbol:sym,error:String(e&&e.message||e)};
      tokenomicsBySymbol[sym]={available:false,symbol:sym,error:String(e&&e.message||e)};
    }
  }
  return res.status(200).json({ok:true,source:"GeckoTerminal",checkedAt:Date.now(),onchainBySymbol,tokenomicsBySymbol});
}
