const TRUE='true';
const FALSE='false';

function required(name,value){
  if(String(value??'').trim()==='') throw new Error(name+'_REQUIRED');
  return String(value).trim();
}

export function assertStagingEnvironment(env=process.env){
  const runtime=String(env.RADARX_ENV??'').trim().toLowerCase();
  if(runtime!=='staging') throw new Error('STAGING_ENV_REQUIRED');

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
  if(origins.some(x=>!x.startsWith('https://')||x.length<10)) throw new Error('STAGING_ALLOWED_ORIGINS_MUST_USE_HTTPS');

  if(String(env.RADARX_REAL_ORDER_EXECUTION??'false').trim().toLowerCase()!==FALSE)
    throw new Error('REAL_ORDER_EXECUTION_MUST_REMAIN_FALSE');

  if(String(env.RADARX_PAPER_TRADING??'true').trim().toLowerCase()!==TRUE)
    throw new Error('PAPER_TRADING_MUST_REMAIN_TRUE');

  if(String(env.RADARX_CONFIDENCE_MODE??'UNKNOWN').trim().toUpperCase()!=='UNKNOWN')
    throw new Error('CONFIDENCE_MODE_MUST_REMAIN_UNKNOWN');

  const host=String(env.RADARX_HOST??'127.0.0.1').trim();
  if(!['127.0.0.1','localhost','::1'].includes(host)) throw new Error('STAGING_HOST_MUST_BE_LOOPBACK');

  return {environment:'staging',pushProvider:provider,testPushEnabled:testFlag===TRUE,allowedOrigins:origins,
    paperTrading:true,realOrderExecution:false,confidenceMode:'UNKNOWN'};
}

export function assertReadOnlyStagingConfig(config){
  if(config?.paper?.paperTrading!==true) throw new Error('PAPER_TRADING_MUST_REMAIN_TRUE');
  if(config?.paper?.realOrderExecution!==false) throw new Error('REAL_ORDER_EXECUTION_MUST_REMAIN_FALSE');
  return true;
}
