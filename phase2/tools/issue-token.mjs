import {createSessionToken} from '../core/auth.mjs';
const secret=process.env.RADARX_AUTH_SECRET;
const user=process.argv.find((x,i)=>process.argv[i-1]==='--user')||process.env.RADARX_DEV_USER||'local-user';
if(!secret){console.error('Set RADARX_AUTH_SECRET in the shell; the token is printed only and is not stored.');process.exit(2);}
console.log(createSessionToken({userId:user,secret,ttlSec:Number(process.env.RADARX_AUTH_TOKEN_TTL_SEC||86400)}));
