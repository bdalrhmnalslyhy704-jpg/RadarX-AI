import {randomUUID,createSign} from 'node:crypto';
import {defaultSettings} from '../core/signal-service.mjs';
import {EVENT_CLASS,marketEventClass} from '../core/event-types.mjs';
import {formatRadarTime12h} from '../core/radar-alert-meta.mjs';

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

const FCM_SCOPE='https://www.googleapis.com/auth/firebase.messaging';
const FCM_TOKEN_URL='https://oauth2.googleapis.com/token';
const FCM_API_BASE='https://fcm.googleapis.com/v1/projects/';
const b64url=value=>Buffer.from(value).toString('base64url');

export class FcmPushProvider extends PushProvider{
  constructor({projectId='',serviceAccountJson='',fetchImpl=globalThis.fetch,clock=()=>Date.now()}={}){
    super();
    this.serviceAccount=null;this.fetchImpl=fetchImpl;this.clock=clock;
    try{this.serviceAccount=typeof serviceAccountJson==='string'?JSON.parse(serviceAccountJson):serviceAccountJson;}catch{}
    this.projectId=String(projectId||this.serviceAccount?.project_id||'').trim();
    this.cachedAccessToken='';this.accessTokenExpiresAt=0;
  }
  status(){return{provider:'fcm',enabled:Boolean(this.projectId&&this.serviceAccount?.client_email&&this.serviceAccount?.private_key&&this.fetchImpl)};}
  async getAccessToken(){
    const now=this.clock();
    if(this.cachedAccessToken&&this.accessTokenExpiresAt>now+60000)return this.cachedAccessToken;
    if(!this.status().enabled)throw new Error('FCM_CONFIGURATION_MISSING');
    const issuedAt=Math.floor(now/1000);
    const head=b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
    const claims=b64url(JSON.stringify({iss:this.serviceAccount.client_email,scope:FCM_SCOPE,aud:FCM_TOKEN_URL,iat:issuedAt,exp:issuedAt+3600}));
    const unsigned=head+'.'+claims;
    const signature=createSign('RSA-SHA256').update(unsigned).sign(this.serviceAccount.private_key).toString('base64url');
    const assertion=unsigned+'.'+signature;
    const response=await this.fetchImpl(FCM_TOKEN_URL,{
      method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}).toString(),
      signal:AbortSignal.timeout(8000)
    });
    let data={};try{data=await response.json();}catch{}
    if(!response.ok||typeof data.access_token!=='string'||!data.access_token)throw new Error('FCM_OAUTH_TOKEN_FAILED_'+Number(response.status||0));
    this.cachedAccessToken=data.access_token;
    this.accessTokenExpiresAt=now+Math.max(60000,Number(data.expires_in||3600)*1000-60000);
    return this.cachedAccessToken;
  }
  async send(subscription,payload){
    if(!this.status().enabled)return{ok:false,status:'DISABLED',reason:'FCM_CONFIGURATION_MISSING'};
    if(subscription?.provider!=='fcm'||typeof subscription?.fcm_token!=='string'||!subscription.fcm_token)
      return{ok:false,status:'SKIPPED',reason:'FCM_DEVICE_TOKEN_MISSING'};
    try{
      const token=await this.getAccessToken();
      const title=String(payload?.title||((payload?.radar_name||'RadarX')+' • '+(payload?.symbol||'تنبيه'))).slice(0,120);
      const body=String(payload?.message||[payload?.symbol,payload?.event||payload?.potential_label||payload?.type].filter(Boolean).join(' • ')||'تنبيه جديد من RadarX').slice(0,220);
      const data={};
      for(const key of ['type','event_class','event','radar','radar_name','symbol','market','direction','price','opportunity_score','potential_label','detected_at','detected_at_iso','detected_time_12h','detected_timezone','sent_at','sent_at_iso','sent_timezone','server_processed_at','signal_id','source','test_id','event_id']){
        const value=payload?.[key];
        if(value!==undefined&&value!==null)data[key]=String(value).slice(0,500);
      }
      // Send data-only HIGH priority messages so Android's native service can post
      // one notification, set a deterministic tap target, and record device receipt
      // even when the application process is in the background.
      data.title=title;
      data.body=body;
      data.paper_trading='true';data.real_order_execution='false';data.confidence_score='UNKNOWN';
      const response=await this.fetchImpl(FCM_API_BASE+encodeURIComponent(this.projectId)+'/messages:send',{
        method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
        body:JSON.stringify({message:{
          token:subscription.fcm_token,
          data,
          android:{priority:'HIGH',ttl:'30s'}
        }}),
        signal:AbortSignal.timeout(8000)
      });
      let result={};try{result=await response.json();}catch{}
      if(response.ok)return{ok:true,status:'SENT',httpStatus:Number(response.status||200),messageId:result?.name||null};
      const details=Array.isArray(result?.error?.details)?result.error.details:[];
      const fcmCode=details.find(x=>String(x?.['@type']||'').endsWith('.FcmError'))?.errorCode;
      if(fcmCode==='UNREGISTERED')return{ok:false,status:'GONE',reason:'FCM_TOKEN_UNREGISTERED',httpStatus:Number(response.status||404)};
      return{ok:false,status:'FAILED',reason:String(result?.error?.status||'FCM_SEND_FAILED').slice(0,120),httpStatus:Number(response.status||0)||null};
    }catch(error){
      return{ok:false,status:'FAILED',reason:String(error?.message||'FCM_SEND_FAILED').replace(/[^A-Z0-9_:-]/gi,'_').slice(0,120),httpStatus:null};
    }
  }
}

export function createPushProvider(c){
  if(c?.provider==='fcm')return new FcmPushProvider({projectId:c.fcmProjectId,serviceAccountJson:c.fcmServiceAccountJson});
  if(c?.provider==='webpush')return new WebPushProvider({subject:c.vapidSubject,publicKey:c.vapidPublicKey,privateKey:c.vapidPrivateKey});
  return new NoopPushProvider();
}


const radarTitle=s=>s?.radar_name||({
  EARLY_MOVE_RADAR:'Radar 1 — Early-Wake',
  STRONG_MOVE_RADAR:'Radar 2 — Strong-Move',
  ROTATION_LAG_RADAR:'Radar 3 — Rotation/Lag',
  LIQUIDITY_ABSORPTION_RADAR:'Radar 4 — Liquidity Absorption'
}[String(s?.radar||'').toUpperCase()]||'RadarX');
const radarPayload=(alert,processedAt=Date.now())=>({
  type:'RADARX_RADAR_ALERT',
  event_class:EVENT_CLASS.RADAR_ALERT??'RADAR_ALERT',
  event:alert.event||'RADAR_ALERT',
  radar:alert.radar||'UNKNOWN_RADAR',
  radar_name:radarTitle(alert),
  symbol:alert.symbol,
  market:alert.market||'SPOT',
  direction:alert.direction||'NONE',
  price:alert.price??null,
  opportunity_score:alert.opportunity_score??null,
  potential_label:alert.potential_label||null,
  price_change_24h:alert.price_change_24h??null,
  reasons:Array.isArray(alert.reasons)?alert.reasons.slice(0,8):[],
  detected_at:Number(alert.detected_at)||processedAt,
  detected_at_iso:alert.detected_at_iso||new Date(Number(alert.detected_at)||processedAt).toISOString(),
  detected_time_12h:alert.detected_time_12h||formatRadarTime12h(alert.detected_at||processedAt),
  detected_timezone:'Asia/Aden',
  sent_at:processedAt,
  sent_at_iso:new Date(processedAt).toISOString(),
  sent_time_12h:formatRadarTime12h(processedAt),
  sent_timezone:'Asia/Aden',
  source:alert.source||'Binance Public REST',
  confidence_score:'UNKNOWN',
  paper_trading:true,
  real_order_execution:false,
  title:radarTitle(alert)+' • '+String(alert.symbol||'UNKNOWN')
});

const payload=(s,processedAt=Date.now())=>({type:'RADARX_SIGNAL',event_class:marketEventClass(s.data_status?.source??s.source),signal_id:s.signal_id,symbol:s.symbol,market:s.market,strategy:s.strategy,direction:s.direction,
  signal_type:s.signal_type,timeframe:s.candle?.timeframe,candle_open_time:s.candle?.open_time,candle_close_time:s.candle?.close_time,
  price:s.price?.reference??null,data_quality:s.scores?.data_quality,liquidity_quality:s.scores?.liquidity_quality,
  risk_filter:s.risk_filter,risk_reasons:s.risk_reasons,reason_codes:s.reason_codes,source:s.data_status?.source??'UNKNOWN',
  source_time:s.candle?.close_time??null,server_processed_at:processedAt,confidence_score:'UNKNOWN',paper_trading:true,real_order_execution:false});

const testPayload=(eventId,testId,processedAt=Date.now())=>({
  type:EVENT_CLASS.TEST_PUSH_ONLY,event_class:EVENT_CLASS.TEST_PUSH_ONLY,event_id:eventId,test_id:testId,
  title:'RadarX • TEST_PUSH_ONLY',
  message:'اختبار إشعار فقط — ليس تحليلًا للسوق',
  server_processed_at:processedAt,confidence_score:'UNKNOWN',paper_trading:true,real_order_execution:false
});

export class PushManager{
  constructor({provider,store,deduplicator=null,retryBaseMs=15000}){this.provider=provider;this.store=store;this.deduplicator=deduplicator;this.retryBaseMs=retryBaseMs;this.retryQueue=new Map();}
  status(){return this.provider.status();}
  providerSubscriptions(rows){
    const provider=this.provider.status()?.provider;
    if(provider==='fcm')return rows.filter(row=>row.provider==='fcm');
    if(provider==='webpush')return rows.filter(row=>(row.provider||'webpush')==='webpush');
    return rows;
  }
  async notifySignal(signal){
    const rows=this.providerSubscriptions(await this.store.getSubscriptions()),cache=new Map(),out=[];
    for(const sub of rows){
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
    return out;
  }

  async notifyRadarAlert(alert){
    const rows=this.providerSubscriptions(await this.store.getSubscriptions()),out=[];
    for(const sub of rows){
      const settings=await this.store.getUserSettings(sub.user_id)||defaultSettings();
      if(!settings.enabled)continue;
      const dq=Number(alert?.data_quality??alert?.strong_move?.data_quality??alert?.liquidity_absorption?.data_quality??100);
      if(Number.isFinite(dq)&&dq<Number(settings.minDataQuality))continue;
      const r=await this.provider.send(sub,radarPayload(alert,Date.now()));
      const audit={event:'RADAR_ALERT_NOTIFICATION',event_class:'RADAR_ALERT',radar:alert.radar||'UNKNOWN_RADAR',radar_name:radarTitle(alert),
        symbol:alert.symbol,alert_id:alert.id||null,subscription_id:sub.id,user_id:sub.user_id,status:r.status,
        attempted_at:Date.now(),reason:r.reason??null,http_status:r.httpStatus??null};
      await this.store.appendNotificationAudit(audit);out.push(audit);
      if(r.status==='GONE')await this.store.disableSubscription(sub.id);
    }
    return out;
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
    const rows=this.providerSubscriptions(await this.store.getSubscriptions(String(userId)));
    await this.store.appendSignalAudit({event:'TEST_PUSH_ONLY',event_class:EVENT_CLASS.TEST_PUSH_ONLY,event_id:eventId,test_id:clean,
      user_id:String(userId),status:rows.length?'QUEUED':'NO_SUBSCRIPTIONS',source:'TEST_PUSH_ONLY',source_time:null,processed_at:now,
      confidence_score:'UNKNOWN',paper_trading:true,real_order_execution:false,signal_id:null});
    if(!rows.length)return{status:'NO_SUBSCRIPTIONS',event_id:eventId,test_id:clean,notifications:[]};
    const notifications=[];
    for(const sub of rows){
      const attemptedAt=Date.now(),r=await this.provider.send(sub,testPayload(eventId,clean,attemptedAt));
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
    return{status,event_id:eventId,test_id:clean,notifications};
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
