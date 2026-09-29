import http from 'node:http';
import {verifySessionToken} from '../core/auth.mjs';
import {defaultSettings} from '../core/signal-service.mjs';
import {DurableStore} from '../core/store.mjs';

function send(res,status,body,extra={}){
  const data=JSON.stringify(body);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...extra});
  res.end(data);
}
async function body(req,max){
  let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>max){throw new Error('BODY_TOO_LARGE');}}
  try{return raw?JSON.parse(raw):{};}catch{throw new Error('INVALID_JSON');}
}
function validSettings(x){
  const out={...defaultSettings(),...x};
  out.enabled=Boolean(out.enabled);
  if(!Array.isArray(out.symbols)||!out.symbols.length)throw new Error('INVALID_SYMBOLS');
  if(!Array.isArray(out.timeframes)||!out.timeframes.length||out.timeframes.some(x=>!['5m','15m','1h','4h'].includes(x)))throw new Error('INVALID_TIMEFRAMES');
  if(!Array.isArray(out.signalTypes)||!out.signalTypes.length||out.signalTypes.some(x=>!['ENTRY_CANDIDATE','CONFIRMED'].includes(x)))throw new Error('INVALID_SIGNAL_TYPES');
  out.symbols=out.symbols.map(x=>String(x).toUpperCase()).filter(x=>/^[A-Z0-9]{5,20}$/.test(x));
  out.minDataQuality=Math.max(0,Math.min(100,Number(out.minDataQuality)));
  out.minLiquidityQuality=Math.max(0,Math.min(100,Number(out.minLiquidityQuality)));
  if(!Number.isFinite(out.minDataQuality)||!Number.isFinite(out.minLiquidityQuality))throw new Error('INVALID_QUALITY_THRESHOLDS');
  return {enabled:out.enabled,symbols:[...new Set(out.symbols)],timeframes:[...new Set(out.timeframes)],
    minDataQuality:out.minDataQuality,minLiquidityQuality:out.minLiquidityQuality,signalTypes:[...new Set(out.signalTypes)]};
}
function subscriptionValid(x){
  if(typeof x?.endpoint!=='string'||!/^https:\\/\\//.test(x.endpoint))throw new Error('INVALID_PUSH_ENDPOINT');
  if(typeof x?.keys?.p256dh!=='string'||typeof x?.keys?.auth!=='string')throw new Error('INVALID_PUSH_KEYS');
  return {endpoint:x.endpoint,expirationTime:x.expirationTime??null,keys:{p256dh:x.keys.p256dh,auth:x.keys.auth}};
}
export function createApiServer({config,store,monitor,pushProvider}){
  const counters=new Map();
  const originList=config.auth.allowedOrigins;
  function allowedOrigin(req){
    const o=req.headers.origin;if(!o||!originList.length)return null;return originList.includes(o)?o:null;
  }
  function authUser(req){
    const header=req.headers.authorization||'';if(!header.startsWith('Bearer '))return null;
    const token=header.slice(7);return verifySessionToken(token,config.auth.secret)?.sub||null;
  }
  function rateOk(key){
    const now=Date.now(),cut=now-60000,a=(counters.get(key)||[]).filter(t=>t>cut);
    if(a.length>=config.api.rateLimitPerMinute){counters.set(key,a);return false;}
    a.push(now);counters.set(key,a);return true;
  }
  return http.createServer(async(req,res)=>{
    const cors=allowedOrigin(req);if(cors)res.setHeader('access-control-allow-origin',cors);
    res.setHeader('vary','Origin');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');
    if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':cors||'null','access-control-allow-methods':'GET,PUT,POST,DELETE,OPTIONS','access-control-allow-headers':'authorization,content-type'});return res.end();}
    const key=(req.socket.remoteAddress||'unknown')+'|'+(req.headers.authorization||'');
    if(!rateOk(key))return send(res,429,{error:'RATE_LIMITED'});
    try{
      const u=new URL(req.url,'http://localhost');
      if(u.pathname==='/healthz'&&req.method==='GET')return send(res,200,monitor.health());
      if(u.pathname==='/readyz'&&req.method==='GET'){
        const h=monitor.health(),ok=h.database.state==='LIVE'&&(h.websocket.state==='LIVE'||h.rest.state==='LIVE');return send(res,ok?200:503,{ready:ok,health:h});
      }
      if(!u.pathname.startsWith('/v1/'))return send(res,404,{error:'NOT_FOUND'});
      const user=authUser(req);if(!user)return send(res,401,{error:'UNAUTHORIZED'});
      if(u.pathname==='/v1/settings'&&req.method==='GET')return send(res,200,{settings:await store.getUserSettings(user)||defaultSettings()});
      if(u.pathname==='/v1/settings'&&req.method==='PUT'){
        const s=validSettings(await body(req,config.api.maxBodyBytes));return send(res,200,{settings:await store.putUserSettings(user,s)});
      }
      if(u.pathname==='/v1/subscriptions'&&req.method==='GET'){
        const list=await store.getSubscriptions(user);return send(res,200,{subscriptions:list.map(DurableStore.publicSubscription)});
      }
      if(u.pathname==='/v1/subscriptions'&&req.method==='POST'){
        const s=subscriptionValid(await body(req,config.api.maxBodyBytes));const row=await store.upsertSubscription(user,s);
        return send(res,201,{subscription:DurableStore.publicSubscription(row),provider:pushProvider.status()});
      }
      const match=u.pathname.match(/^\\/v1\\/subscriptions\\/([^/]+)$/);
      if(match&&req.method==='DELETE'){
        const ok=await store.deleteSubscription(user,match[1]);return send(res,ok?200:404,{deleted:ok});
      }
      if(u.pathname==='/v1/signals'&&req.method==='GET')return send(res,200,{events:await store.readRecent('signals',Math.min(200,Number(u.searchParams.get('limit')||50)))});
      if(u.pathname==='/v1/notifications'&&req.method==='GET')return send(res,200,{events:await store.readRecent('notifications',Math.min(200,Number(u.searchParams.get('limit')||50)))});
      if(u.pathname==='/v1/push/status'&&req.method==='GET')return send(res,200,pushProvider.status());
      return send(res,404,{error:'NOT_FOUND'});
    }catch(e){
      const m=String(e?.message??e);const status=/BODY_TOO_LARGE/.test(m)?413:/INVALID_|PUSH_|TIME/.test(m)?400:500;
      return send(res,status,{error:m});
    }
  });
}
