const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function healthOf(instance){try{return typeof instance?.health==='function'?(instance.health()||{}):{};}catch(error){return {running:false,health_error:String(error?.message??error)};}}
function describeError(error){return String(error?.message??error??'UNKNOWN_START_FAILURE').slice(0,500);}

/** Coordinates lifecycle only. Each worker retains its own bounded scan and REST budgets. */
export class RadarSwarmCoordinator {
  constructor({runners=[],expectedCount=12,startupSpacingMs=150,logger=console,clock=()=>Date.now(),watchdogIntervalMs=10000,restartCooldownMs=15000,maxRestarts=3}={}){
    this.expectedCount=Math.max(1,Math.trunc(Number(expectedCount)||12));
    this.startupSpacingMs=Math.max(0,Math.min(5000,Math.trunc(Number(startupSpacingMs)||0)));
    this.watchdogIntervalMs=Math.max(10,Math.min(60000,Math.trunc(Number(watchdogIntervalMs)||10000)));
    this.restartCooldownMs=Math.max(0,Math.min(300000,Math.trunc(Number(restartCooldownMs)||0)));
    this.maxRestarts=Math.max(0,Math.min(10,Math.trunc(Number(maxRestarts)||0)));
    this.logger=logger;this.clock=clock;this.running=false;this.generation=0;this.startPromise=null;this.runners=[];this.states=new Map();
    this.watchdogTimer=null;this.watchdogPromise=null;
    for(const item of (Array.isArray(runners)?runners:[])){
      const id=String(item?.id??'').trim().toUpperCase();
      if(!id)throw new Error('RADAR_SWARM_RUNNER_ID_REQUIRED');
      if(this.states.has(id))throw new Error('RADAR_SWARM_DUPLICATE_ID:'+id);
      if(!item?.instance||typeof item.instance.start!=='function'||typeof item.instance.stop!=='function')throw new Error('RADAR_SWARM_RUNNER_LIFECYCLE_REQUIRED:'+id);
      const runner={id,name:String(item.name??id),instance:item.instance};this.runners.push(runner);
      this.states.set(id,{id,name:runner.name,status:'IDLE',launch_attempts:0,restart_attempts:0,last_restart_attempt_at:null,started_at:null,stopped_at:null,last_error:null});
    }
  }
  _failed(runner,error,generation=null){
    const state=this.states.get(runner.id);if(!state)return;
    if(generation!==null&&generation!==this.generation&&state.status==='STOPPED')return;
    state.status='FAILED';state.last_error=describeError(error);state.last_error_at=this.clock();
    try{this.logger.warn?.('[RADAR_SWARM_START_FAILED] '+runner.id+' '+state.last_error);}catch{}
    // A failed async bootstrap may already have created a timer. Stop that worker
    // without waiting for it; one cleanup failure must not block the other radars.
    state.stop_invoked=true;
    try{
      state.cleanupPromise=Promise.resolve(runner.instance.stop()).catch(stopError=>{state.cleanup_error=describeError(stopError);});
    }catch(stopError){state.cleanup_error=describeError(stopError);state.cleanupPromise=Promise.resolve();}
  }
  _launch(runner,generation){
    if(!this.running||generation!==this.generation)return;const state=this.states.get(runner.id);if(!state||['STARTING','RUNNING'].includes(state.status))return;
    state.status='STARTING';state.launch_attempts++;state.last_error=null;state.last_start_attempt_at=this.clock();state.stop_invoked=false;state.cleanupPromise=null;let result;
    try{result=runner.instance.start();}catch(error){this._failed(runner,error);return;}
    const health=healthOf(runner.instance);if(health.running===true){state.status='RUNNING';state.started_at=this.clock();}
    if(result&&typeof result.then==='function')Promise.resolve(result).then(()=>{
      if(generation!==this.generation)return;const current=healthOf(runner.instance);
      if(current.running===true||current.running===undefined){state.status='RUNNING';state.started_at=state.started_at??this.clock();state.last_error=null;state.last_error_at=null;}
      else if(state.status==='STARTING'){state.status='DEGRADED';state.last_error='START_RESOLVED_BUT_HEALTH_NOT_RUNNING';}
    }).catch(error=>this._failed(runner,error,generation));
    else if(health.running===true||health.running===undefined){state.status='RUNNING';state.started_at=this.clock();state.last_error=null;state.last_error_at=null;}
    else{state.status='DEGRADED';state.last_error=health.health_error??'START_RETURNED_NOT_RUNNING';}
  }
  _startWatchdog(generation){
    if(this.watchdogTimer)clearInterval(this.watchdogTimer);
    this.watchdogTimer=setInterval(()=>{
      if(this.watchdogPromise)return;
      this.watchdogPromise=this._runWatchdog(generation)
        .catch(error=>{try{this.logger.warn?.('[RADAR_SWARM_WATCHDOG_FAILED] '+describeError(error));}catch{}})
        .finally(()=>{this.watchdogPromise=null;});
    },this.watchdogIntervalMs);
    this.watchdogTimer.unref?.();
  }
  async _runWatchdog(generation){
    if(!this.running||generation!==this.generation)return;
    for(const runner of this.runners){
      if(!this.running||generation!==this.generation)return;
      const state=this.states.get(runner.id);
      if(!state||state.launch_attempts===0||state.status==='STARTING')continue;
      const health=healthOf(runner.instance);
      if(state.status==='RUNNING'&&health.running===false){
        state.status='DEGRADED';
        state.last_error=health.health_error||'WORKER_HEALTH_NOT_RUNNING';
        state.last_error_at=this.clock();
        try{this.logger.warn?.('[RADAR_SWARM_WORKER_UNHEALTHY] '+runner.id+' '+state.last_error);}catch{}
      }
      const busySince=Number(health.busy_since_at);
      const pollMs=Number(health.poll_ms)||20000;
      const stuckScanLimitMs=Math.max(120000,Math.min(240000,pollMs*6));
      const busyForMs=this.clock()-busySince;
      const stuckScan=health.running===true&&health.busy===true&&Number.isFinite(busySince)&&busySince>0&&busyForMs>stuckScanLimitMs;
      if(stuckScan&&state.status==='RUNNING'){
        state.status='DEGRADED';
        state.last_error='WORKER_SCAN_STUCK:busy_ms='+Math.max(0,Math.trunc(busyForMs));
        state.last_error_at=this.clock();
        try{this.logger.warn?.('[RADAR_SWARM_SCAN_STUCK] '+JSON.stringify({id:runner.id,busy_ms:Math.max(0,Math.trunc(busyForMs)),timeout_ms:stuckScanLimitMs,action:'BOUNDED_WORKER_RESTART',paper_trading:true,real_order_execution:false}));}catch{}
      }
      if(!['FAILED','DEGRADED'].includes(state.status))continue;
      const stuckRestart=String(state.last_error||'').startsWith('WORKER_SCAN_STUCK:');
      if(health.running===true&&state.status!=='FAILED'&&!stuckRestart)continue;
      if(Number(state.restart_attempts||0)>=this.maxRestarts)continue;
      const now=this.clock();
      const last=Number(state.last_restart_attempt_at);
      if(Number.isFinite(last)&&now-last<this.restartCooldownMs)continue;
      try{
        state.stop_invoked=true;
        await runner.instance.stop();
        state.cleanupPromise=Promise.resolve();
      }catch(error){
        state.cleanup_error=describeError(error);
        state.last_error='WATCHDOG_CLEANUP_FAILED: '+state.cleanup_error;
        state.last_error_at=this.clock();
        try{this.logger.warn?.('[RADAR_SWARM_RESTART_CLEANUP_FAILED] '+runner.id+' '+state.cleanup_error);}catch{}
        continue;
      }
      if(!this.running||generation!==this.generation)return;
      state.restart_attempts=Number(state.restart_attempts||0)+1;
      state.last_restart_attempt_at=this.clock();
      try{this.logger.warn?.('[RADAR_SWARM_RESTART_ATTEMPT] '+JSON.stringify({id:runner.id,attempt:state.restart_attempts,max_attempts:this.maxRestarts}));}catch{}
      this._launch(runner,generation);
    }
  }
  start(){
    if(this.running)return this.startPromise??Promise.resolve(this.snapshot());this.running=true;const generation=++this.generation;
    this._startWatchdog(generation);
    this.startPromise=(async()=>{for(let i=0;i<this.runners.length;i++){if(!this.running||generation!==this.generation)break;this._launch(this.runners[i],generation);if(this.startupSpacingMs>0&&i<this.runners.length-1)await delay(this.startupSpacingMs);}return this.snapshot();})().catch(error=>{try{this.logger.error?.('[RADAR_SWARM_SCHEDULER_FAILED] '+describeError(error));}catch{}return this.snapshot();});
    return this.startPromise;
  }
  snapshot(){
    const radars=this.runners.map(r=>{
      const state=this.states.get(r.id)||{},health=healthOf(r.instance);
      const healthReported=typeof health.running==='boolean';
      const runtimeDown=state.status==='RUNNING'&&healthReported&&health.running===false;
      const failed=['FAILED','DEGRADED'].includes(state.status)||runtimeDown;
      const isRunning=(health.running===true||(health.running===undefined&&state.status==='RUNNING'))&&!failed;
      const status=state.status==='FAILED'?'FAILED':failed?'DEGRADED':(isRunning?'RUNNING':state.status);
      const lastError=state.last_error??(runtimeDown?'WORKER_HEALTH_NOT_RUNNING':(health.health_error??null));
      return {id:r.id,name:r.name,status,running:isRunning,launch_attempts:state.launch_attempts||0,
        restart_attempts:state.restart_attempts||0,max_restarts:this.maxRestarts,
        last_restart_attempt_at:state.last_restart_attempt_at??null,
        started_at:state.started_at??null,last_start_attempt_at:state.last_start_attempt_at??null,last_error:lastError,health};
    });
    const running_count=radars.filter(r=>r.running).length,failed_count=radars.filter(r=>['FAILED','DEGRADED'].includes(r.status)).length,missing_count=Math.max(0,this.expectedCount-radars.length);
    const status=missing_count>0||radars.length!==this.expectedCount?'INCOMPLETE':failed_count>0?'DEGRADED':running_count===this.expectedCount?'RUNNING':this.running?'STARTING':'STOPPED';
    return {coordinator:'RADAR_SWARM_12',status,expected_count:this.expectedCount,registered_count:radars.length,running_count,failed_count,missing_count,startup_spacing_ms:this.startupSpacingMs,
      watchdog:{enabled:this.running&&Boolean(this.watchdogTimer),interval_ms:this.watchdogIntervalMs,restart_cooldown_ms:this.restartCooldownMs,max_restarts_per_radar:this.maxRestarts},
      lifecycle_running:this.running,updated_at:this.clock(),radars};
  }
  async stop(){
    this.running=false;this.generation++;
    if(this.watchdogTimer)clearInterval(this.watchdogTimer);
    this.watchdogTimer=null;
    const priorCleanups=this.runners.map(r=>this.states.get(r.id)?.cleanupPromise).filter(Boolean);
    const active=this.runners.filter(r=>{const state=this.states.get(r.id);return (state?.launch_attempts||0)>0&&!state?.stop_invoked;});
    for(const runner of active){const state=this.states.get(runner.id);if(state)state.stop_invoked=true;}
    const results=await Promise.allSettled(active.map(async runner=>{await runner.instance.stop();const state=this.states.get(runner.id);if(state){state.status='STOPPED';state.stopped_at=this.clock();state.cleanupPromise=Promise.resolve();}}));
    await Promise.allSettled(priorCleanups);
    for(let i=0;i<results.length;i++)if(results[i].status==='rejected'){const state=this.states.get(active[i].id);if(state){state.status='DEGRADED';state.last_error='STOP_FAILED: '+describeError(results[i].reason);}}
    this.startPromise=null;return this.snapshot();
  }
}
