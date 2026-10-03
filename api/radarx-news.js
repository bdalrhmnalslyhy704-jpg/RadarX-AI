/* RadarX live crypto-news gateway
   Uses CoinDesk's public RSS feed. Articles keep source + publication time;
   no article is treated as a trading signal by itself. */
const FEED="https://www.coindesk.com/arc/outboundfeeds/rss/";
let cache={ts:0,items:[]};

function clean(s){
  return String(s||"")
    .replace(/<!\[CDATA\[/g,"").replace(/\]\]>/g,"")
    .replace(/<[^>]*>/g," ")
    .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/&#x27;/gi,"'").replace(/\s+/g," ").trim();
}
function tag(block,name){
  const re=new RegExp("<"+name+"(?:\\s[^>]*)?>([\\s\\S]*?)</"+name+">","i");
  const m=String(block).match(re); return m?clean(m[1]):"";
}
function linkOf(block){
  const m=String(block).match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if(m)return clean(m[1]);
  const a=String(block).match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?\s*>/i);
  return a?String(a[1]):"";
}
function parseFeed(xml){
  const out=[];
  const blocks=String(xml||"").match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)||[];
  for(const b of blocks){
    const title=tag(b,"title"), url=linkOf(b), published=tag(b,"pubDate")||tag(b,"published")||tag(b,"updated"), description=tag(b,"description")||tag(b,"summary");
    const ts=Date.parse(published);
    if(!title||!url||!Number.isFinite(ts))continue;
    out.push({title,url,source:"CoinDesk",publishedAt:new Date(ts).toISOString(),ts,description:description.slice(0,280)});
  }
  const seen=new Set();
  return out.filter(x=>{const k=x.url+"|"+x.title;if(seen.has(k))return false;seen.add(k);return true;})
    .sort((a,b)=>b.ts-a.ts).slice(0,80);
}
function symbolCatalyst(items,symbol){
  const s=String(symbol||"").toUpperCase().replace(/USDT$/,"").replace(/USD$/,"");
  if(!s||s.length<2)return {available:false};
  const safe=s.replace(/[.*+?^()|[\]\\]/g,"\\$&");
  const matched=items.filter(x=>new RegExp("(^|[^A-Z0-9])"+safe+"([^A-Z0-9]|$)","i").test(x.title+" "+x.description));
  if(!matched.length)return {available:false,symbol:s,samples:0};
  const pos=/(launch|approval|adopt|partnership|integrat|upgrade|mainnet|inflow|surge|rally|record|growth|new version|expands|positive)/i;
  const neg=/(hack|exploit|lawsuit|ban|outflow|collapse|attack|breach|halt|delist|fine|fraud|loss|plunge)/i;
  let score=50;
  for(const x of matched.slice(0,8)){
    const ageH=Math.max(0,(Date.now()-x.ts)/3600000), decay=Math.max(.15,Math.exp(-ageH/36));
    const sign=neg.test(x.title+" "+x.description)?-1:pos.test(x.title+" "+x.description)?1:0;
    score += sign*13*decay;
  }
  return {available:true,score:Math.max(0,Math.min(100,score)),samples:matched.length,
    latestAt:matched[0].publishedAt,headlines:matched.slice(0,4).map(x=>({title:x.title,url:x.url,publishedAt:x.publishedAt,source:x.source}))};
}

export default async function handler(req,res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Accept");
  res.setHeader("Cache-Control","s-maxage=60, stale-while-revalidate=120");
  if(req.method==="OPTIONS")return res.status(204).end();
  if(req.method!=="GET")return res.status(405).json({ok:false,error:"METHOD_NOT_ALLOWED"});
  const fresh=cache.items.length&&Date.now()-cache.ts<60000;
  if(!fresh){
    try{
      const r=await fetch(FEED,{headers:{"Accept":"application/rss+xml, application/xml, text/xml;q=0.9","User-Agent":"RadarX-News/1.0"}});
      if(!r.ok)throw new Error("HTTP "+r.status);
      cache={ts:Date.now(),items:parseFeed(await r.text())};
    }catch(e){
      if(!cache.items.length)return res.status(502).json({ok:false,error:"NEWS_SOURCE_UNAVAILABLE",detail:String(e&&e.message||e)});
    }
  }
  const symbols=String(req.query?.symbols||"").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean).slice(0,32);
  const catalystBySymbol={};
  for(const s of symbols)catalystBySymbol[s]=symbolCatalyst(cache.items,s);
  return res.status(200).json({
    ok:true,source:"CoinDesk RSS",feed:FEED,checkedAt:cache.ts,
    items:cache.items.map(({ts,...x})=>x),catalystBySymbol
  });
}
