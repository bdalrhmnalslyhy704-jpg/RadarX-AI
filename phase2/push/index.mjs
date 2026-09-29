import {randomUUID} from 'node:crypto';
import {defaultSettings} from '../core/signal-service.mjs';
import {EVENT_CLASS,marketEventClass} from '../core/event-types.mjs';

export class PushProvider{async send(){throw new Error('PUSH_PROVIDER_NOT_IMPLEMENTED');}status(){return{provider:'unknown',enabled:false};}}
export class NoopPushProvider extends PushProvider{
  async send(){return{ok:false,status:'DISABLED',reason:'PUSH_DISABLED'};}
  status(){return{provider:'none',enabled:false};}
}
export class WebPushProvider extends PushProvider{
  constructor({subject,publicKey,privateKey,webPushImpl=null}){super();this.subject=subject;this.publicKey=publicKey;this.privateKey=privateKey;this.impl=webPushImpl;}
  async load(){if(this.impl)return this.impl;const m=await import('web-push');this.impl=m.default||m;this.impl.setVapidDetails(this.subject,this.publicKey,this.privateKey);return this.impl;}
  async send(s,p){
    if(!this.subject||!this.publicKey||!this.privateKey)return{ok:false,status:'DISABLED',reason:'VAPID_CONFIGURATION_MISSING'};
    try{const m=await this.load();const r=await m.sendNotification({endpoint:s.endpoint,expirationTime:s.expirationTime??null,keys:s.keys},JSON.stringify(p));
      return{ok:true,status:'SENT',httpStatus:r?.statusCode??201};}
    catch(e){const code=Number(e?.statusCode||0);if(code===404||code===410)return{ok:false,status:'GONE',reason:'PUSH_SUBSCRIPTION_EXPIRED',httpStatus:code};
      return{ok:false,status:'FAILED',reason:String(e?.message??e),httpStatus:code||null};}
  }
  status(){return{provider:'webpush',enabled:Boolean(this.subject&&this.publicKey&&this.privateKey)};}
}
export function createPushProvider(c){return c?.provider==='webpush'?new WebPushProvider({subject:c.vapidSubject,publicKey:c.vapidPublicKey,privateKey:c.vapidPrivateKey}):new NoopPushProvider();}

const payload=(s,processedAt=Date.now())=>({type:'RADARX_SIGNAL',event_class:marketEventClass(s.data_status?.source??s.source),signal_id:s.signal_id,symbol:s.symbol,market:s.market,strategy:s.strategy,direction:s.direction,
  signal_type:s.signal_type,timeframe:s.candle?.timeframe,candle_open_time:s.candle?.open_time,candle_close_time:s.candle?.close_time,
  price:s.price?.reference??null,data_quality:s.scores?.data_quality,liquidity_quality:s.scores?.liquidity_quality,
  risk_filter:s.risk_filter,risk_reasons:s.risk_reasons,reason_codes:s.reason_codes,source:s.data_status?.source??'UNKNOWN',
  source_time:s.candle?.close_time??null,server_processed_at:processedAt,confidence_score:'UNKNOWN',paper_trading:true,real_order_execution:false});

const testPayload=(eventId,testId,processedAt=Date.now(),ack={})=>({
  type:EVENT_CLASS.TEST_PUSH_ONLY,event_class:EVENT_CLASS.TEST_PUSH_ONLY,event_id:eventId,test_id:testId,
  title:'RadarX • TEST_PUSH_ONLY',message:'اختبار إشعار فقط — ليس تحليلًا للسوق',
  server_processed_at:processedAt,confidence_score:'UNKNOWN',paper_trading:true,real_order_execution:false,
  subscription_id:ack.subscriptionId??null,device_token:ack.deviceToken??null,ack_token:ack.ackToken??null,ack_url:ack.ackUrl??null
});

export class PushManager{
  constructor({provider,store,deduplicator=null,retryBaseMs=15000,config={environment:'development',api:{publicOrigin:''}}}){this.provider=provider;this.store=store;this.deduplicator=deduplicator;this.retryBaseMs=retryBaseMs;this.retryQueue=new Map();this.config=config;}
  status(){return this.provider.status();}
  async notifySignal(signal){
    let validation=null;
    if(this.config.environment==='staging'){
      validation=await this.store.getStagingPushValidationStatus();
      if(validation.status!=='VALIDATED')return{status:'BLOCKED_STAGING_PUSH_VALIDATION',notifications:[],validation};
      const active=await this.store.getSubscriptions();
      if(!active.some(x=>x.id===validation.subscription_id))return{status:'BLOCKED_STAGING_PUSH_VALIDATION_STALE',notifications:[],validation};
    }
    const rows=await this.store.getSubscriptions(),cache=new Map(),out=[];
    for(const sub of rows){
      if(this.config.environment==='staging'&&sub.id!==validation.subscription_id)continue;
      let settings=cache.get(sub.user_id);if(!settings){settings=await this.store.getUserSettings(sub.user_id)||defaultSettings();cache.set(sub.user_id,settings);}
      if(!settings.enabled||!settings.symbols.includes(signal.symbol)||!settings.timeframes.includes(signal.candle?.timeframe)||!settings.signalTypes.includes(signal.signal_type))continue;
      if(Number(signal.scores?.data_quality)<settings.minDataQuality||Number(signal.scores?.liquidity_quality)<settings.minLiquidityQuality)continue;
      const r=await this.provider.send(sub,payload(signal,Date.now())),audit={event:'NOTIFICATION_ATTEMPT',event_class:marketEventClass(signal.data_status?.source??signal.source),
        signal_id:signal.signal_id,subscription_id:sub.id,user_id:sub.user_id,status:r.status,
        provider:this.provider.status().provider,attempted_at:Date.now(),reason:r.reason??null,http_status:r.httpStatus??null};
      await this.store.appendNotificationAudit(audit);out.push(audit);
      if(r.status==='GONE')await this.store.disableSubscription(sub.id);
      if(!r.ok&&r.status==='FAILED')this.retryQueue.set(sub.id+'|'+signal.signal_id,{subscription:sub,signal,nextAt:Date.now()+this.retryBaseMs,attempt:1});
    }
    const status=out.some(x=>x.status==='SENT')?'SENT_OR_ATTEMPTED':out.length?'FAILED_OR_DISABLED':'NO_SUBSCRIBERS';
    return{status,notifications:out,validation};
  }
  async notifyTestPush({userId,testId}) {
    const clean=String(testId||'').trim()||randomUUID();
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(clean))throw new Error('INVALID_TEST_ID');
    if(!this.deduplicator)throw new Error('DEDUPLICATOR_REQUIRED');
    const now=Date.now();
    const eventId='TEST_PUSH_ONLY:'+String(userId)+':'+clean;
    const synthetic={signal_id:eventId,symbol:'TEST_PUSH_ONLY',market:'SPOT',strategy:'TEST_PUSH_ONLY',direction:'NONE',
      signal_type:'TEST_PUSH_ONLY',candle:{timeframe:'TEST',close_time:now,closed:true},reason_codes:['TEST_PUSH_ONLY',clean],
      confidence_score:'UNKNOWN',paper_trade:{enabled:true,real_order_execution:false}};
    const d=await this.deduplicator.canEmit(synthetic,now);
    if(!d.allowed){
      await this.store.appendSignalAudit({event:'TEST_PUSH_ONLY',event_class:EVENT_CLASS.TEST_PUSH_ONLY,event_id:eventId,test_id:clean,
        user_id:String(userId),status:'DUPLICATE',source:'TEST_PUSH_ONLY',source_time:null,processed_at:now,
        confidence_score:'UNKNOWN',paper_trading:true,real_order_execution:false,blocked_reason:d.reason});
      return{status:'DUPLICATE',event_id:eventId,test_id:clean,notifications:[]};
    }
    await this.deduplicator.markEmitted(synthetic,now);
    const rows=await this.store.getSubscriptions(String(userId));
    await this.store.appendSignalAudit({event:'TEST_PUSH_ONLY',event_class:EVENT_CLASS.TEST_PUSH_ONLY,event_id:eventId,test_id:clean,
      user_id:String(userId),status:rows.length?'QUEUED':'NO_SUBSCRIPTIONS',source:'TEST_PUSH_ONLY',source_time:null,processed_at:now,
      confidence_score:'UNKNOWN',paper_trading:true,real_order_execution:false,signal_id:null});
    if(!rows.length)return{status:'NO_SUBSCRIPTIONS',event_id:eventId,test_id:clean,notifications:[]};
    const notifications=[];
    for(const sub of rows){
      if(!sub.device_token)continue;
      const ackToken=randomUUID(),ackRequestedAt=Date.now();
      await this.store.createStagingPushValidationChallenge({userId,subscriptionId:sub.id,testEventId:eventId,deviceToken:sub.device_token,ackToken,requestedAt:ackRequestedAt});
      const ackUrl=(this.config.api?.publicOrigin||'')+'/v1/push/ack';
      const attemptedAt=Date.now(),r=await this.provider.send(sub,testPayload(eventId,clean,attemptedAt,{subscriptionId:sub.id,deviceToken:sub.device_token,ackToken,ackUrl}));
      await this.store.recordStagingPushValidationDelivery({subscriptionId:sub.id,testEventId:eventId,status:r.status,sentAt:Date.now()});
      const audit={event:'NOTIFICATION_ATTEMPT',event_class:EVENT_CLASS.TEST_PUSH_ONLY,event_id:eventId,test_id:clean,
        signal_id:null,subscription_id:sub.id,user_id:String(userId),status:r.status,provider:this.provider.status().provider,
        attempted_at:attemptedAt,reason:r.reason??null,http_status:r.httpStatus??null};
      await this.store.appendNotificationAudit(audit);notifications.push(audit);
      if(r.status==='GONE')await this.store.disableSubscription(sub.id);
    }
    const status=notifications.some(x=>x.status==='SENT')?'SENT':notifications.some(x=>x.status==='GONE')?'GONE':'FAILED';
    await this.store.appendSignalAudit({event:'TEST_PUSH_ONLY_RESULT',event_class:EVENT_CLASS.TEST_PUSH_ONLY,event_id:eventId,test_id:clean,
      user_id:String(userId),status,source:'TEST_PUSH_ONLY',source_time:null,processed_at:Date.now(),
      confidence_score:'UNKNOWN',paper_trading:true,real_order_execution:false});
    return{status,event_id:eventId,test_id:clean,notifications,validation:await this.store.getStagingPushValidationStatus()};
  }
  async flushRetries(now=Date.now()){
    for(const [k,j] of [...this.retryQueue.entries()]){
      if(j.nextAt>now)continue;const r=await this.provider.send(j.subscription,payload(j.signal,now));
      await this.store.appendNotificationAudit({event:'NOTIFICATION_RETRY',event_class:marketEventClass(j.signal.data_status?.source??j.signal.source),
        signal_id:j.signal.signal_id,subscription_id:j.subscription.id,user_id:j.subscription.user_id,status:r.status,
        provider:this.provider.status().provider,attempted_at:now,reason:r.reason??null,http_status:r.httpStatus??null,retry_attempt:j.attempt});
      if(r.ok||r.status==='GONE')this.retryQueue.delete(k);else{j.attempt++;j.nextAt=now+Math.min(this.retryBaseMs*(2**j.attempt),10*60*1000);}
    }
  }
}

export {defaultSettings};
