import {mkdirSync,accessSync,constants} from 'node:fs';
import {resolvePort,assertAllowedHost} from '../runtime.mjs';

const TRUE='true';
const FALSE='false';

function required(name,value){
  if(String(value??'').trim()==='') throw new Error(name+'_REQUIRED');
  return String(value).trim();
}

function verifyDataDir(env){
  const dir=String(env.RADARX_DATA_DIR??'./.radarx-data').trim()||'./.radarx-data';
  try{
    mkdirSync(dir,{recursive:true});
    accessSync(dir,constants.W_OK);
    return dir;
  }catch{
    throw new Error('RADARX_DATA_DIR_NOT_WRITABLE_OR_CREATABLE');
  }
}

export function assertDeploymentEnvironment(env=process.env){
  const runtime=String(env.RADARX_ENV??'').trim().toLowerCase();
  if(!['staging','production'].includes(runtime)) throw new Error('STAGING_OR_PRODUCTION_ENV_REQUIRED');

  const testFlag=String(env.RADARX_STAGING_TEST_PUSH_ENABLED??'').trim().toLowerCase();
  if(testFlag!==TRUE&&testFlag!==FALSE) throw new Error('RADARX_STAGING_TEST_PUSH_ENABLED_MUST_BE_EXPLICIT_TRUE_OR_FALSE');

  const provider=String(env.RADARX_PUSH_PROVIDER??'').trim().toLowerCase();
  if(provider!=='webpush') throw new Error('RADARX_PUSH_PROVIDER_WEBPUSH_REQUIRED');

  const auth=required('RADARX_AUTH_SECRET',env.RADARX_AUTH_SECRET);
  if(auth.length<32) throw new Error('RADARX_AUTH_SECRET_TOO_SHORT');

  required('VAPID_SUBJECT',env.VAPID_SUBJECT);
  required('VAPID_PUBLIC_KEY',env.VAPID_PUBLIC_KEY);
  required('VAPID_PRIVATE_KEY',env.VAPID_PRIVATE_KEY);

  const origins=String(env.RADARX_ALLOWED_ORIGINS??'').split(',').map(x=>x.trim()).filter(Boolean);
  if(!origins.length) throw new Error('RADARX_ALLOWED_ORIGINS_REQUIRED');
  if(runtime==='staging'&&origins.some(x=>!x.startsWith('https://')||x.endsWith('/'))) throw new Error('STAGING_ALLOWED_ORIGINS_MUST_BE_EXACT_HTTPS_ORIGINS');
  if(runtime==='staging'){const publicApiOrigin=required('RADARX_PUBLIC_API_ORIGIN',env.RADARX_PUBLIC_API_ORIGIN);if(!publicApiOrigin.startsWith('https://')||publicApiOrigin.endsWith('/'))throw new Error('RADARX_PUBLIC_API_ORIGIN_MUST_BE_EXACT_HTTPS_ORIGIN');}
  if(origins.some(x=>!x.startsWith('https://')||x.length<10)) throw new Error('STAGING_ALLOWED_ORIGINS_MUST_USE_HTTPS');

  if(String(env.RADARX_REAL_ORDER_EXECUTION??'false').trim().toLowerCase()!==FALSE)
    throw new Error('REAL_ORDER_EXECUTION_MUST_REMAIN_FALSE');

  if(String(env.RADARX_PAPER_TRADING??'true').trim().toLowerCase()!==TRUE)
    throw new Error('PAPER_TRADING_MUST_REMAIN_TRUE');

  if(String(env.RADARX_CONFIDENCE_MODE??'UNKNOWN').trim().toUpperCase()!=='UNKNOWN')
    throw new Error('CONFIDENCE_MODE_MUST_REMAIN_UNKNOWN');

  const hostRaw=String(env.RADARX_HOST??'').trim();
  const host=assertAllowedHost(hostRaw||'127.0.0.1',runtime,{explicit:Boolean(hostRaw)});
  const port=resolvePort(env);
  const dataDir=required('RADARX_DATA_DIR',env.RADARX_DATA_DIR);verifyDataDir({...env,RADARX_DATA_DIR:dataDir});
  if(runtime==='production'&&testFlag===TRUE)throw new Error('TEST_PUSH_ONLY_STAGING_ONLY');

  return {environment:runtime,pushProvider:provider,testPushEnabled:testFlag===TRUE,allowedOrigins:origins,
    host,port,dataDir,paperTrading:true,realOrderExecution:false,confidenceMode:'UNKNOWN'};
}

export const assertStagingEnvironment=assertDeploymentEnvironment;

export function assertReadOnlyStagingConfig(config){
  if(config?.paper?.paperTrading!==true) throw new Error('PAPER_TRADING_MUST_REMAIN_TRUE');
  if(config?.paper?.realOrderExecution!==false) throw new Error('REAL_ORDER_EXECUTION_MUST_REMAIN_FALSE');
  if(config?.confidenceMode!=='UNKNOWN') throw new Error('CONFIDENCE_MODE_MUST_REMAIN_UNKNOWN');
  return true;
}
