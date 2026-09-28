/* RadarX community/social chatter gateway.
   Reddit public RSS is treated as community context only, never as a trade signal by itself. */
const cache=new Map();

function clean(s){
  return String(s||"").replace(/<!\[CDATA\[/g,"").replace(/\]\]>/g,"")
    .replace(/<[^>]*>/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<")
    .replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/\s+/g," ").trim();
}
function tag(block,name){
  const m=String(block).match(new RegExp("<"+name+"(?:\\s[^>]*)?>([\\s\\S]*?)</"+name+">","i"));
  return m?clean(m[1]):"";
}
function linkOf(block){
  const m=String(block).match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  return m?clean(m[1]):"";
}
function parse(xml){
  const blocks=String(xml||"").match(/<entry\b[\s\S]*?<\/entry>/gi)||[];
  return blocks.map(b=>{
    const title=tag(b,"title"), url=linkOf(b), published=tag(b,"updated")||tag(b,"published"), ts=Date.parse(published);
    return title&&url&&Number.isFinite(ts)?{title,url,publishedAt:new Date(ts).toISOString(),ts}:null;
  }).filter(Boolean).sort((a,b)=>b.ts-a.ts).slice(0,50);
}
function score(rows,symbol){
  const q=String(symbol||"").toUpperCase().replace(/USDT$/,"").replace(/USD$/,"");
  if(!q)return {available:false};
  const positive=/(bullish|breakout|buy|long|accumulat|adopt|partnership|launch|upgrade|airdrop|listing|growth|strong|undervalued)/i;
  const negative=/(bearish|sell|short|scam|hack|exploit|rug|dump|collapse|delist|lawsuit|ban|loss|weak|overvalued)/i;
  const safe=q.replace(/[.*+?^()\[\]\\]/g,"\\$&");
  const matched=rows.filter(x=>new RegExp("(^|[^A-Z0-9])"+safe+"([^A-Z0-9]|$)","i").test(x.title));
  if(!matched.length)return {available:false,symbol:q,samples:0};
  let s=50;
  for(const x of matched.slice(0,12)){
    const ageH=Math.max(0,(Date.now()-x.ts)/3600000),w=Math.max(.12,Math.exp(-ageH/18));
    s+=(positive.test(x.title)?1:negative.test(x.title)?-1:0)*7*w;
  }
  return {available:true,symbol:q,score:Number(Math.max(0,Math.min(100,s)).toFixed(2)),samples:matched.length,
    latestAt:matched[0].publishedAt,headlines:matched.slice(0,5).map(x=>({title:x.title,url:x.url,publishedAt:x.publishedAt})),
    source:"Reddit public RSS",communityOnly:true};
}
export default async function handler(req,res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Accept");
  res.setHeader("Cache-Control","s-maxage=120, stale-while-revalidate=240");
  if(req.method==="OPTIONS")return res.status(204).end();
  if(req.method!=="GET")return res.status(405).json({ok:false,error:"METHOD_NOT_ALLOWED"});
  const symbols=String(req.query?.symbols||"").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean).slice(0,8);
  const socialBySymbol={};
  for(const symbol of symbols){
    const key=symbol.replace(/[^A-Z0-9]/g,""), hit=cache.get(key);
    let rows=hit&&Date.now()-hit.ts<120000?hit.rows:null;
    if(!rows){
      try{
        const url="https://www.reddit.com/search.rss?q="+encodeURIComponent('"'+symbol.replace(/USDT$/,"")+'" crypto')+"&sort=new&t=day";
        const r=await fetch(url,{headers:{Accept:"application/atom+xml, application/xml, text/xml;q=0.9","User-Agent":"RadarX-Social/1.0"}});
        if(!r.ok)throw new Error("HTTP "+r.status);
        rows=parse(await r.text()); cache.set(key,{ts:Date.now(),rows});
      }catch(e){rows=hit?.rows||[];}
    }
    socialBySymbol[symbol]=score(rows,symbol);
  }
  return res.status(200).json({ok:true,source:"Reddit public RSS",checkedAt:Date.now(),socialBySymbol});
}
