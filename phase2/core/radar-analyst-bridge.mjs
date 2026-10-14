import {recordRadarDecision} from './radar-telemetry.mjs';

function safeMessage(error){
  return String(error?.message??error??'UNKNOWN_ERROR').replace(/[^a-z0-9_.:-]/gi,'_').slice(0,160);
}

/**
 * Sends radar-emitted symbols into the bounded MultiAnalystEngine review queue.
 * This bridge is advisory only: it never waits for analysis, suppresses an alert,
 * edits its score, or changes PushManager's normal notification result.
 */
export function connectRadarAlertsToAnalysts({
  pushManager,
  multiAnalystRadar,
  logger=console,
  clock=()=>Date.now(),
  decisionRecorder=recordRadarDecision
}={}){
  if(!pushManager||typeof pushManager.notifyRadarAlert!=='function'){
    return {installed:false,reason:'PUSH_MANAGER_NOTIFY_REQUIRED'};
  }
  if(!multiAnalystRadar||typeof multiAnalystRadar.enqueueRadarReview!=='function'){
    return {installed:false,reason:'MULTI_ANALYST_REVIEW_QUEUE_REQUIRED'};
  }
  if(pushManager.__radarAnalystReviewBridgeInstalled===true){
    return {installed:false,reason:'ALREADY_INSTALLED'};
  }

  const originalNotify=pushManager.notifyRadarAlert.bind(pushManager);
  Object.defineProperty(pushManager,'__radarAnalystReviewBridgeInstalled',{
    value:true,configurable:true,enumerable:false
  });
  pushManager.notifyRadarAlert=async function(alert,...args){
    const now=clock();
    const symbol=String(alert?.symbol??alert?.asset??'').trim().toUpperCase();
    const sourceRadar=String(alert?.radar??alert?.radar_id??alert?.radar_name??'RADAR_ALERT')
      .trim().toUpperCase().slice(0,80)||'RADAR_ALERT';
    if(/^[A-Z0-9]{2,30}$/.test(symbol)){
      try{
        const queued=multiAnalystRadar.enqueueRadarReview(symbol,{sourceRadar});
        if(queued?.queued&&queued?.already_queued!==true){
          try{
            logger.info?.('[RADAR_ANALYST_REVIEW_QUEUED] '+JSON.stringify({
              symbol,radar:sourceRadar,pending_count:queued.pending_count??null,
              mode:'NON_BLOCKING_REVIEW_ONLY',at:new Date(now).toISOString()
            }));
          }catch{}
        }
      }catch(error){
        try{
          logger.warn?.('[RADAR_ANALYST_REVIEW_QUEUE_FAILED] '+JSON.stringify({
            symbol,radar:sourceRadar,error:safeMessage(error)
          }));
        }catch{}
      }

      try{
        decisionRecorder({
          ...alert,
          radar:sourceRadar,
          symbol,
          observed_at:alert?.observed_at??alert?.detected_at??alert?.created_at??now,
          processed_at:now,
          stage:alert?.potential_label??alert?.stage??alert?.signal_type??'RADAR_ALERT_EMITTED'
        },{
          radar:sourceRadar,
          eligible:true,
          score:alert?.score??alert?.signal_score??alert?.final_score??alert?.strong_move?.score??null,
          accepted_mode:'RADAR_ALERT_EMITTED_REVIEW_PENDING',
          soft_failures:['MULTI_ANALYST_REVIEW_QUEUED']
        },{now,source:'LIVE'});
      }catch{}
    }
    // Preserve the original notification path and its exact return/error behavior.
    return originalNotify(alert,...args);
  };

  return {installed:true,mode:'NON_BLOCKING_REVIEW_ONLY'};
}
