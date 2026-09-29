const BASE_KEY='radarx.phase2.base_url';
const TOKEN_KEY='radarx.phase2.session_token';

export function getBaseUrl(){
  if(typeof localStorage==='undefined')return '';
  return (localStorage.getItem(BASE_KEY)||window.location.origin).replace(/\/+$/,'');
}
export function setBaseUrl(v){
  const clean=String(v||'').trim().replace(/\/+$/,'');
  if(typeof localStorage!=='undefined')localStorage.setItem(BASE_KEY,clean||window.location.origin);
  return getBaseUrl();
}
export function getSessionToken(){
  if(typeof sessionStorage==='undefined')return '';
  return sessionStorage.getItem(TOKEN_KEY)||'';
}
export function setSessionToken(v){
  if(typeof sessionStorage==='undefined')return String(v||'');
  const t=String(v||'').trim();if(t)sessionStorage.setItem(TOKEN_KEY,t);else sessionStorage.removeItem(TOKEN_KEY);return t;
}
async function request(path,{method='GET',body,auth=true,timeoutMs=10000}={}){
  const headers={'Accept':'application/json'};
  const token=getSessionToken();if(auth&&token)headers.Authorization='Bearer '+token;
  if(body!==undefined)headers['content-type']='application/json';
  const ac=new AbortController();const timer=setTimeout(()=>ac.abort(),timeoutMs);
  try{
    const res=await fetch(getBaseUrl()+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:ac.signal});
    let data=null;try{data=await res.json();}catch{}
    if(!res.ok){
      const err=new Error(data?.error||('HTTP_'+res.status));err.status=res.status;throw err;
    }
    return data;
  }catch(e){
    if(e.name==='AbortError')throw new Error('API_TIMEOUT');
    throw e;
  }finally{clearTimeout(timer);}
}
export const apiHealth=()=>request('/healthz',{auth:false});
export const apiReady=()=>request('/readyz',{auth:false});
export const apiConfig=()=>request('/v1/config');
export const apiSettings=()=>request('/v1/settings');
export const apiSaveSettings=settings=>request('/v1/settings',{method:'PUT',body:settings});
export const apiSubscriptions=()=>request('/v1/subscriptions');
export const apiAddSubscription=subscription=>request('/v1/subscriptions',{method:'POST',body:subscription});
export const apiDeleteSubscription=id=>request('/v1/subscriptions/'+encodeURIComponent(id),{method:'DELETE'});
export const apiSignals=limit=>request('/v1/signals?limit='+(limit||50));
export const apiSignal=id=>request('/v1/signals/'+encodeURIComponent(id));
export const apiNotifications=limit=>request('/v1/notifications?limit='+(limit||50));
export const apiPushStatus=()=>request('/v1/push/status');
export const apiTestPush=testId=>request('/v1/push/test',{method:'POST',body:{test_id:String(testId||'android-manual')}});
export const apiPushValidation=()=>request('/v1/push/validation');
export {request};
