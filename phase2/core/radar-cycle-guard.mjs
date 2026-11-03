const DEFAULT_RADAR_SCAN_TIMEOUT_MS=180_000;

/**
 * Bind one bounded radar cycle to the REST client's real abort signal and
 * absolute deadline. This cancels the underlying fetch; it is not merely a
 * Promise.race that leaves a stale network request alive after the scan latch
 * has been released.
 */
export function beginRadarCycle(rest,{timeoutMs=DEFAULT_RADAR_SCAN_TIMEOUT_MS,label='RADAR_SCAN'}={}){
  if(!rest)throw new Error('RADAR_CYCLE_REST_CLIENT_REQUIRED');
  const requested=Number(timeoutMs);
  const durationMs=Math.max(1_000,Math.min(240_000,
    Number.isFinite(requested)&&requested>0?Math.trunc(requested):DEFAULT_RADAR_SCAN_TIMEOUT_MS));
  const startedAtMs=Date.now();
  const deadlineAtMs=startedAtMs+durationMs;
  const controller=new AbortController();
  const previousDeadlineAtMs=rest.requestDeadlineAtMs??null;
  const previousAbortSignal=rest.requestAbortSignal??null;
  let timedOut=false;
  let cancelReason=null;
  let finished=false;
  const abort=(reason='STOP_OR_RESTART')=>{
    if(finished||controller.signal.aborted)return false;
    cancelReason=String(reason||'STOP_OR_RESTART');
    if(cancelReason==='DEADLINE')timedOut=true;
    controller.abort();
    return true;
  };
  rest.requestDeadlineAtMs=deadlineAtMs;
  rest.requestAbortSignal=controller.signal;
  const timer=setTimeout(()=>abort('DEADLINE'),durationMs);
  timer.unref?.();
  return {
    signal:controller.signal,
    startedAtMs,
    deadlineAtMs,
    durationMs,
    get timedOut(){return timedOut;},
    get cancelReason(){return cancelReason;},
    abort,
    finish(){
      if(finished)return;
      finished=true;
      clearTimeout(timer);
      // A cancelled older generation must never overwrite a newer scan's
      // AbortSignal or deadline if the instance is restarted by its watchdog.
      if(rest.requestAbortSignal===controller.signal){
        rest.requestAbortSignal=previousAbortSignal;
        rest.requestDeadlineAtMs=previousDeadlineAtMs;
      }
    }
  };
}
