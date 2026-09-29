import {createHmac,timingSafeEqual} from 'node:crypto';

const b64=x=>Buffer.from(x).toString('base64url');

export function createSessionToken({userId,secret,now=Date.now(),ttlSec=86400}){
  if(!secret)throw new Error('AUTH_SECRET_REQUIRED');
  const p={sub:String(userId),iat:Math.floor(now/1000),exp:Math.floor(now/1000)+ttlSec};
  const body=b64(JSON.stringify(p));const sig=createHmac('sha256',secret).update(body).digest('base64url');return body+'.'+sig;
}
export function verifySessionToken(token,secret,now=Date.now()){
  if(!token||!secret)return null;const parts=String(token).split('.');if(parts.length!==2)return null;
  const a=createHmac('sha256',secret).update(parts[0]).digest(),b=Buffer.from(parts[1],'base64url');
  if(a.length!==b.length||!timingSafeEqual(a,b))return null;let p;try{p=JSON.parse(Buffer.from(parts[0],'base64url').toString());}catch{return null;}
  return p?.sub&&Number(p.exp)>=Math.floor(now/1000)?p:null;
}
