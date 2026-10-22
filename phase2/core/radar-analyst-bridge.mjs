import {recordRadarDecision} from './radar-telemetry.mjs';
import {advanceSignalLifecycle,evaluateRadarNotificationGate} from './radar-notification-gate.mjs';

function safeMessage(error){
  return String(error?.message??error??'UNKNOWN_ERROR').replace(/[^a-z0-9_.:-]/gi,'_').slice(0,160);
}

/**
 * Sends radar-emitted symbols into the bounded MultiAnalystEngine review queue.
 * The review stays non-blocking, but the shared notification gate is enforced at
 * the final delivery boundary. Rejected/unknown-gate alerts are logged for review,
 * not sent as push notifications. Explicit watch-only alerts use the dedicated path.
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
      let embeddedGate=alert?.notification_gate??alert?.radar_notification_gate??alert?.gate_result??{};
      // Attach a shared-gate decision at the notification boundary whenever the
      // radar did not provide an explicit boolean eligibility decision. This gate
      // is final: an unknown/failed gate must not fall through to push delivery.
      if(typeof embeddedGate?.eligible!=='boolean'){
        try{
          const sharedGate=evaluateRadarNotificationGate({...alert,radar:sourceRadar},{now});
          if(sharedGate&&typeof sharedGate==='object'){
            // Keep the actual outcome (including a rejection) for accurate telemetry.
            embeddedGate=sharedGate;
            try{alert.notification_gate=sharedGate;}catch{}
            if(sharedGate.eligible===true&&sharedGate.watch_only===true){
              try{
                logger.info?.('[RADAR_SHARED_WATCH_ONLY_CLASSIFIED] '+JSON.stringify({
                  symbol,radar:sourceRadar,mode:sharedGate.mode,score:sharedGate.score,
                  failures:sharedGate.failures?.slice(0,8)||[],at:new Date(now).toISOString()
                }));
              }catch{}
            }
          }
        }catch(error){
          try{logger.warn?.('[RADAR_SHARED_WATCH_CLASSIFIER_FAILED] '+JSON.stringify({
            symbol,radar:sourceRadar,error:safeMessage(error)
          }));}catch{}
        }
      }
      const knownStates=['MONITOR','EARLY_SETUP','SIGNAL_REVIEW','CONFIRMED','INVALIDATED'];
      const lifecycle=knownStates.includes(embeddedGate?.signal_lifecycle?.state)
        ?embeddedGate.signal_lifecycle
        :advanceSignalLifecycle(alert,{
          ...embeddedGate,radar:sourceRadar,
          eligible:embeddedGate?.eligible===true,
          mode:embeddedGate?.mode??alert?.notification_mode??'NO_GATE_DECISION',
          failures:Array.isArray(embeddedGate?.failures)?embeddedGate.failures:[]
        },{now});
      try{alert.signal_lifecycle=lifecycle;}catch{}
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

      const gateKnown=typeof embeddedGate?.eligible==='boolean';
      const gateAccepted=gateKnown&&embeddedGate.eligible===true;
      const explicitWatchOnly=alert?.watch_only===true||alert?.entry_eligible===false||embeddedGate?.entry_eligible===false;
      const watchOnly=embeddedGate?.watch_only===true||explicitWatchOnly;
      if(gateAccepted&&!explicitWatchOnly&&watchOnly){
        // A shared-gate early corridor may still send a labelled watch alert, but it
        // is never entry-eligible. Explicit watch-only inputs must use the separately
        // validated notifyRadarWatchOnlyAlert path instead.
        try{alert.watch_only=true;alert.entry_eligible=false;}catch{}
      }
      const deliveryBlocked=!/^[A-Z0-9]{2,30}$/.test(symbol)||!gateAccepted||explicitWatchOnly;
      const blockedReasons=[
        ...(!/^[A-Z0-9]{2,30}$/.test(symbol)?['INVALID_SYMBOL']:[]),
        ...(!gateKnown?['SHARED_NOTIFICATION_GATE_UNKNOWN']:[]),
        ...(gateKnown&&!gateAccepted?(Array.isArray(embeddedGate?.failures)?embeddedGate.failures:['SHARED_NOTIFICATION_GATE_REJECTED']):[]),
        ...(explicitWatchOnly?['WATCH_ONLY_REQUIRES_DEDICATED_DELIVERY']:[])
      ].slice(0,20);
      if(deliveryBlocked){
        try{logger.warn?.('[RADAR_PUSH_BLOCKED_SHARED_GATE] '+JSON.stringify({symbol:symbol||null,radar:sourceRadar,blocked_reasons:blockedReasons,at:new Date(now).toISOString()}));}catch{}
      }
      try{
        const gateKnown=typeof embeddedGate?.eligible==='boolean';
        const actuallyEligible=gateKnown&&embeddedGate.eligible===true&&!watchOnly;
        const acceptedMode=watchOnly
          ?'WATCH_ONLY_REVIEW_PENDING'
          :actuallyEligible
            ?'STRICT_GATE_PASSED_REVIEW_PENDING'
            :gateKnown
              ?'RADAR_ALERT_EMITTED_GATE_REJECTED_REVIEW_PENDING'
              :'RADAR_ALERT_EMITTED_GATE_UNKNOWN_REVIEW_PENDING';
        const failureCodes=[
          ...(Array.isArray(embeddedGate?.failures)?embeddedGate.failures:[]),
          ...(watchOnly?['WATCH_ONLY_NOT_ENTRY_ELIGIBLE']:[]),
          'MULTI_ANALYST_REVIEW_QUEUED'
        ];
        decisionRecorder({
          ...alert,
          radar:sourceRadar,
          symbol,
          observed_at:alert?.observed_at??alert?.detected_at??alert?.created_at??now,
          processed_at:now,
          stage:alert?.potential_label??alert?.stage??alert?.signal_type??'RADAR_ALERT_EMITTED',
          watch_only:watchOnly,
          entry_eligible:actuallyEligible
        },{
          radar:embeddedGate?.radar??sourceRadar,
          eligible:actuallyEligible,
          score:alert?.score??alert?.signal_score??alert?.final_score??alert?.strong_move?.score??null,
          accepted_mode:acceptedMode,
          soft_failures:failureCodes
        },{now,source:'LIVE'});
      }catch{}
      if(deliveryBlocked){
        return {status:'BLOCKED_SHARED_NOTIFICATION_GATE',attempted:false,notifications:[],blocked_reasons:blockedReasons,watch_only:watchOnly,entry_eligible:false};
      }
    }
    if(!/^[A-Z0-9]{2,30}$/.test(symbol)){
      return {status:'BLOCKED_SHARED_NOTIFICATION_GATE',attempted:false,notifications:[],blocked_reasons:['INVALID_SYMBOL'],watch_only:false,entry_eligible:false};
    }
    // Push delivery is permitted only after a positive shared-gate decision. A
    // radar alert can still be queued for multi-analyst review when rejected.
    return originalNotify(alert,...args);
  };

  // Route dedicated watch-only notifications into the same analyst review queue.
  // They stay explicitly non-actionable and do not use the accepted-alert telemetry lane.
  if(typeof pushManager.notifyRadarWatchOnlyAlert==='function'){
    const originalWatchOnlyNotify=pushManager.notifyRadarWatchOnlyAlert.bind(pushManager);
    pushManager.notifyRadarWatchOnlyAlert=async function(alert,...args){
      const now=clock();
      const symbol=String(alert?.symbol??alert?.asset??'').trim().toUpperCase();
      const sourceRadar=String(alert?.radar??alert?.radar_id??alert?.radar_name??'RADAR_WATCH_ONLY')
        .trim().toUpperCase().slice(0,80)||'RADAR_WATCH_ONLY';
      if(/^[A-Z0-9]{2,30}$/.test(symbol)){
        try{
          const queued=multiAnalystRadar.enqueueRadarReview(symbol,{
            sourceRadar,watchOnly:true,
            stage:String(alert?.decision_band??alert?.potential_label??alert?.signal_type??'WATCH_EARLY')
          });
          if(queued?.queued&&queued?.already_queued!==true){
            try{
              logger.info?.('[RADAR_ANALYST_WATCH_REVIEW_QUEUED] '+JSON.stringify({
                symbol,radar:sourceRadar,pending_count:queued.pending_count??null,
                stage:String(alert?.decision_band??alert?.potential_label??alert?.signal_type??'WATCH_EARLY'),
                watch_only:true,entry_eligible:false,at:new Date(now).toISOString()
              }));
            }catch{}
          }
        }catch(error){
          try{
            logger.warn?.('[RADAR_ANALYST_WATCH_REVIEW_QUEUE_FAILED] '+JSON.stringify({
              symbol,radar:sourceRadar,error:safeMessage(error)
            }));}catch{}
        }
        try{
          decisionRecorder({
            ...alert,radar:sourceRadar,symbol,
            observed_at:alert?.observed_at??alert?.detected_at??alert?.created_at??now,
            processed_at:now,
            stage:alert?.decision_band??alert?.potential_label??alert?.signal_type??'WATCH_EARLY',
            watch_only:true,entry_eligible:false
          },{
            radar:sourceRadar,eligible:false,
            score:alert?.score??alert?.signal_score??alert?.final_score??null,
            accepted_mode:'WATCH_ONLY_REVIEW_PENDING',
            soft_failures:['WATCH_ONLY_NOT_ENTRY_ELIGIBLE','MULTI_ANALYST_REVIEW_QUEUED']
          },{now,source:'LIVE'});
        }catch{}
      }
      // Do not block or alter the dedicated watch-only delivery path.
      return originalWatchOnlyNotify(alert,...args);
    };
  }

  return {installed:true,mode:'SHARED_GATE_ENFORCED_NON_BLOCKING_REVIEW'};
}
