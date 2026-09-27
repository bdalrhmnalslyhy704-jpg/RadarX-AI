// RadarX Web Push Subscription API
async function kvConfig(){
  const url=String(process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL||'').trim();
  const token=String(process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN||'').trim();
  return url&&token?{url,token}:null;
}
async function kv(cmd,args=[]){
  const c=await kvConfig(); if(!c)throw new Error('KV_NOT_CONFIGURED');
  const r=await fetch(c.url,{method:'POST',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:JSON.stringify([cmd,...args])});
  if(!r.ok)throw new Error('KV_HTTP_'+r.status); const d=await r.json(); if(d.error)throw new Error(String(d.error)); return d.result;
}
let runtimeKeys=null;
async function ensureKeys(){
  const pub=String(process.env.RADARX_VAPID_PUBLIC_KEY||'').trim(), priv=String(process.env.RADARX_VAPID_PRIVATE_KEY||'').trim();
  if(pub&&priv)return {publicKey:pub,privateKey:priv};
  if(runtimeKeys)return runtimeKeys;
  try{
    const cached=JSON.parse(await kv('get',['radarx:vapid'])||'null');
    if(cached?.publicKey&&cached?.privateKey){runtimeKeys=cached;return cached;}
  }catch{}
  const wp=(await import('web-push')).default || (await import('web-push'));
  const generated=wp.generateVAPIDKeys();
  try{await kv('set',['radarx:vapid',JSON.stringify(generated)]); }catch{}
  runtimeKeys=generated; return generated;
}
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept');
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  if(req.method==='OPTIONS')return res.status(204).end();
  try{
    const mode=String(req.query?.mode||'public-key');
    const keys=await ensureKeys();
    if(mode==='public-key')return res.status(200).json({ok:true,configured:true,publicKey:keys.publicKey});
    if(mode==='unsubscribe'){
      const raw=typeof req.body==='string'?req.body:JSON.stringify(req.body||{});
      await kv('srem',['radarx:push:subs',raw]); return res.status(200).json({ok:true});
    }
    if(req.method!=='POST')return res.status(405).json({ok:false,error:'METHOD_NOT_ALLOWED'});
    const sub=req.body&&typeof req.body==='object'?req.body:JSON.parse(typeof req.body==='string'?req.body:'{}');
    if(!sub?.endpoint) return res.status(400).json({ok:false,error:'INVALID_SUBSCRIPTION'});
    await kv('sadd',['radarx:push:subs',JSON.stringify(sub)]);
    return res.status(200).json({ok:true,subscribed:true});
  }catch(e){return res.status(503).json({ok:false,configured:false,error:String(e?.message||e)});}
}
