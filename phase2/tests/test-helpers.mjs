import nodeTest from 'node:test';
import {basename} from 'node:path';

export const TEST_TIMEOUT_MS=15000;
export const FILE_TIMEOUT_MS=30000;

function fileLabel(metaUrl){
  try{return basename(new URL(metaUrl).pathname);}catch{return String(metaUrl);}
}

export function markTestFile(metaUrl){
  const label=fileLabel(metaUrl);
  console.error('[TEST FILE START] '+label);
  nodeTest.after(()=>console.error('[TEST FILE END] '+label));
  return label;
}

export default function test(name,fn){
  return nodeTest(name,{timeout:TEST_TIMEOUT_MS},async ctx=>{
    console.error('[TEST START] '+name);
    try{return await fn(ctx);}
    finally{console.error('[TEST END] '+name);}
  });
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

export function activeResourceSnapshot(){
  const handles=typeof process._getActiveHandles==='function'?process._getActiveHandles():[];
  const requests=typeof process._getActiveRequests==='function'?process._getActiveRequests():[];
  return {
    active_handles:handles.map(h=>({type:h?.constructor?.name??typeof h})),
    active_requests:requests.map(r=>({type:r?.constructor?.name??typeof r}))
  };
}

export function installDiagnostics(){
  const dump=reason=>{
    const snapshot=activeResourceSnapshot();
    console.error('[TEST RESOURCE DUMP] '+reason);
    console.error(JSON.stringify(snapshot,null,2));
  };
  process.on('SIGUSR2',()=>dump('SIGUSR2'));
  process.on('unhandledRejection',error=>console.error('[TEST UNHANDLED REJECTION]',error?.stack??error));
  process.on('uncaughtException',error=>console.error('[TEST UNCAUGHT EXCEPTION]',error?.stack??error));
  return dump;
}
