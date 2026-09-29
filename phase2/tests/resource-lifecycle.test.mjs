import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test,{closeServer,activeResourceSnapshot} from './test-helpers.mjs';

test('TEST_FIXTURE: HTTP server cleanup removes the server resource',async()=>{
  const server=createServer((_,res)=>res.end('ok'));
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).on('error',reject));
  try{assert.equal(server.listening,true);}
  finally{await closeServer(server);}
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(server.listening,false);
  const handles=typeof process._getActiveHandles==='function'?process._getActiveHandles():[];
  assert.equal(handles.includes(server),false);
});

test('TEST_FIXTURE: timers and WebSocket fixture are stopped after monitor shutdown',async()=>{
  const state={stopped:false};
  const ws={stop(){state.stopped=true;},health(){return{state:'LIVE'};}};
  const timer=setInterval(()=>{},60000);
  try{
    assert.equal(timer!=null,true);
    ws.stop();
    assert.equal(state.stopped,true);
  }finally{
    clearInterval(timer);
  }
  await new Promise(resolve=>setImmediate(resolve));
  const snapshot=activeResourceSnapshot();
  assert.equal(snapshot.active_handles.some(h=>h.type==='Server'),false);
});
