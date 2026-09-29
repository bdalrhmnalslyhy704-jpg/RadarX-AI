process.on('SIGUSR2',()=>{
  const handles=typeof process._getActiveHandles==='function'?process._getActiveHandles():[];
  const requests=typeof process._getActiveRequests==='function'?process._getActiveRequests():[];
  const describe=x=>({type:x?.constructor?.name??typeof x,listening:typeof x?.listening==='boolean'?x.listening:undefined,destroyed:typeof x?.destroyed==='boolean'?x.destroyed:undefined,address:typeof x?.address==='function'?x.address?.():undefined});
  console.error('[RADARX-DIAG] ACTIVE_HANDLES '+JSON.stringify(handles.map(describe)));
  console.error('[RADARX-DIAG] ACTIVE_REQUESTS '+JSON.stringify(requests.map(describe)));
});
