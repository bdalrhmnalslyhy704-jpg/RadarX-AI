import nodeTest from 'node:test';

export const TEST_TIMEOUT_MS=15000;

export function testWithTimeout(name,fn){
  return nodeTest(name,{timeout:TEST_TIMEOUT_MS},fn);
}

export async function fetchWithTimeout(resource,options={},timeoutMs=5000){
  const ac=new AbortController();
  const timer=setTimeout(()=>ac.abort(),timeoutMs);
  try{
    return await fetch(resource,{...options,signal:ac.signal});
  }finally{
    clearTimeout(timer);
  }
}

export async function closeServer(server){
  if(!server)return;
  try{server.closeAllConnections?.();}catch{}
  if(!server.listening)return;
  await new Promise((resolve,reject)=>{
    server.close(error=>error?reject(error):resolve());
  });
  try{server.closeAllConnections?.();}catch{}
}

export default testWithTimeout;

export function activeResourceSnapshot(){
  const handles=typeof process._getActiveHandles==='function'?process._getActiveHandles():[];
  const requests=typeof process._getActiveRequests==='function'?process._getActiveRequests():[];
  return {
    active_handles:handles.map(h=>({type:h?.constructor?.name??typeof h,ref:h})),
    active_requests:requests.map(r=>({type:r?.constructor?.name??typeof r,ref:r}))
  };
}
