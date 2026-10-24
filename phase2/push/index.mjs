import {randomUUID,createSign} from 'node:crypto';
import {parseFcmServiceAccount} from './fcm-service-account.mjs';
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
    this.serviceAccount=parseFcmServiceAccount(serviceAccountJson);
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
      for(const key of ['type','event_class','event','notification_mode','watch_only','entry_eligible','requires_follow_up_confirmation','radar','radar_name','symbol','market','direction','price','price_change_24h','opportunity_score','potential_label','risk_flags','reason_codes','early_flow_watch_evidence','signal_lifecycle_state','signal_lifecycle_label','signal_lifecycle_transition','signal_lifecycle_reason_codes','detected_at','detected_at_iso','detected_time_12h','detected_timezone','sent_at','sent_at_iso','sent_timezone','server_processed_at','signal_id','source','test_id','event_id','paper_trading','real_order_execution','confidence_score']){
        const value=payload?.[key];
        if(value!==undefined&&value!==null)data[key]=(Array.isArray(value)?value.map(String).join(','):typeof value==='object'?JSON.stringify(value):String(value)).slice(0,500);
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
const radarPayload=(alert,processedAt=Date.now())=>{
  const watchOnly=alert?.notification_gate?.watch_only===true||alert?.watch_only===true;
  const needsFollowUp=watchOnly||alert?.notification_gate?.requires_follow_up_confirmation===true;
  const lowLiquidityWatch=alert?.low_liquidity_burst_bypass===true||
    (Array.isArray(alert?.risk_flags)&&alert.risk_flags.includes('LOW_LIQUIDITY_WATCH_ONLY'));
  return {
  type:'RADARX_RADAR_ALERT',
  event_class:EVENT_CLASS.RADAR_ALERT??'RADAR_ALERT',
  event:alert.event||'RADAR_ALERT',
  notification_mode:watchOnly?'WATCH_ONLY_EARLY_TRACK':'STANDARD_RADAR_ALERT',
  watch_only:watchOnly,
  entry_eligible:watchOnly?false:(alert?.entry_eligible??null),
  requires_follow_up_confirmation:needsFollowUp,
  signal_lifecycle_state:alert?.signal_lifecycle?.state??null,
  signal_lifecycle_label:alert?.signal_lifecycle?.label??null,
  signal_lifecycle_transition:alert?.signal_lifecycle?.transition??null,
  signal_lifecycle_reason_codes:Array.isArray(alert?.signal_lifecycle?.reason_codes)?alert.signal_lifecycle.reason_codes.slice(0,8):[],
  message:watchOnly
    ?[alert.symbol,lowLiquidityWatch?'مراقبة مبكرة فقط — سيولة ضعيفة — تحتاج تأكيدًا':'مراقبة مبكرة فقط — تحتاج تأكيدًا'].filter(Boolean).join(' • ')
    :alert?.signal_lifecycle?.state&&alert.signal_lifecycle.state!=='MONITOR'&&alert?.signal_lifecycle?.label
      ?[alert.symbol,alert.signal_lifecycle.label].filter(Boolean).join(' • ')
      :undefined,
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
  reason_codes:Array.isArray(alert.reason_codes)?alert.reason_codes.slice(0,10):[],
  risk_flags:Array.isArray(alert.risk_flags)?alert.risk_flags.slice(0,10):[],
  micro_fingerprint_score:alert.micro_fingerprint_score??null,
  early_flow_watch_evidence:watchOnly&&alert?.early_flow_watch_evidence
    ?alert.early_flow_watch_evidence:null,
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
  title:radarTitle(alert)+(watchOnly?' • مراقبة مبكرة':'')+' • '+String(alert.symbol||'UNKNOWN')
  };
};

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

  async notifyRadarWatchOnlyAlert(alert){
    const now=Date.now();
    const rejected=(reason)=>({status:'REJECTED_WATCH_ONLY',reason,attempted:false,notifications:[],sent_count:0,attempted_count:0});
    const symbol=String(alert?.symbol||'').trim().toUpperCase();
    const event=String(alert?.event||alert?.potential_label||alert?.decision_band||'').trim().toUpperCase();
    const risks=(Array.isArray(alert?.risk_flags)?alert.risk_flags:[]).map(x=>String(x).toUpperCase());
    const firstFinite=(values)=>{
      for(const value of values){
        if(value===null||value===undefined||value===''||typeof value==='boolean')continue;
        const n=Number(value);if(Number.isFinite(n))return n;
      }
      return null;
    };

    // This route is only for explicitly non-actionable observations. It can never
    // turn a watch into an entry signal or invoke an exchange order.
    if(!/^[A-Z0-9]{5,30}$/.test(symbol))return rejected('INVALID_SYMBOL');
    if(alert?.watch_only!==true||alert?.entry_eligible!==false)return rejected('WATCH_ONLY_MARKER_REQUIRED');
    if(!/WATCH_ONLY|WATCH_EARLY/.test(event))return rejected('WATCH_ONLY_EVENT_REQUIRED');
    if(alert?.market&&String(alert.market).toUpperCase()!=='SPOT')return rejected('SPOT_ONLY');
    if(alert?.real_order_execution===true||alert?.paper_trading===false)return rejected('READ_ONLY_POLICY_REQUIRED');
    if(alert?.closed_candles_only!==true)return rejected('CLOSED_CANDLE_EVIDENCE_REQUIRED');
    if(alert?.data_stale===true||alert?.data_status?.stale===true||alert?.data_status?.data_stale===true||
       alert?.data_status?.data_valid===false||alert?.data_status?.future_data_detected===true)
      return rejected('STALE_OR_INVALID_DATA');

    const source=String(alert?.source||alert?.data_status?.source||'').trim().toUpperCase().replace(/\s+/g,'_');
    if(!['BINANCE_PUBLIC_REST','BINANCE_PUBLIC_WS','BINANCE_PUBLIC_WEBSOCKET','BINANCE_SPOT_PUBLIC_REST'].includes(source))
      return rejected('UNTRUSTED_OR_UNKNOWN_MARKET_SOURCE');

    const dataQuality=firstFinite([
      alert?.data_quality,alert?.data_status?.data_quality,
      alert?.notification_gate?.data_quality,alert?.elite_gate?.data_quality,
      alert?.components?.data_quality,alert?.early_expansion?.data_quality,
      alert?.early_move?.data_quality,alert?.early_wake?.data_quality,alert?.pre_explosion?.data_quality,
      alert?.strong_move?.data_quality,alert?.rotation?.data_quality,alert?.kahir_analysis?.data_quality,
      alert?.doomsday?.data_quality,alert?.professor_opinion?.data_quality,alert?.almuqawim?.data_quality,
      alert?.coin_hunter?.data_quality,alert?.factors?.data_quality,alert?.whale_accumulation?.data_quality,
      alert?.falcon_eye?.data_quality,alert?.components?.dataQuality,alert?.early_flow_watch_evidence?.data_quality
    ]);
    const liquidityQuality=firstFinite([
      alert?.liquidity_quality_live,alert?.liquidity_quality,
      alert?.notification_gate?.liquidity_quality,alert?.elite_gate?.liquidity_quality,
      alert?.liquidity_metrics?.liquidity_quality,alert?.early_expansion?.liquidity_quality,
      alert?.early_move?.liquidity_quality,alert?.early_wake?.liquidity_quality,alert?.pre_explosion?.liquidity_quality,
      alert?.strong_move?.liquidity_quality,alert?.rotation?.liquidity_quality,alert?.kahir_analysis?.liquidity_quality,
      alert?.doomsday?.liquidity_quality,alert?.professor_opinion?.liquidity_quality,alert?.almuqawim?.liquidity_quality,
      alert?.coin_hunter?.liquidity_quality,alert?.whale_accumulation?.liquidity_quality,alert?.falcon_eye?.liquidity_quality,
      alert?.early_flow_watch_evidence?.liquidity_quality
    ]);
    // The Micro watch lane has validated closed public Spot candles but deliberately
    // has not queried order-book depth yet. Permit that lane to notify as WATCH ONLY
    // only when both scores are genuinely unavailable and 24h quote volume clears
    // the established floor; never synthesize a data-quality or liquidity score.
    const quoteVolume24h=firstFinite([alert?.quote_volume_24h]);
    const microValidatedEarlyFlow=event==='EARLY_FLOW_WATCH_ONLY'&&
      alert?.micro_data_validated===true&&alert?.closed_candles_only===true&&
      alert?.low_liquidity_burst_bypass!==true&&quoteVolume24h!==null&&quoteVolume24h>=750000&&
      dataQuality===null&&liquidityQuality===null;
    if(alert?.low_liquidity_burst_bypass===true||risks.includes('LOW_LIQUIDITY_WATCH_ONLY'))
      return rejected('LOW_LIQUIDITY_WATCH_ONLY');
    if(!microValidatedEarlyFlow&&(dataQuality===null||dataQuality<70||dataQuality>100))
      return rejected('DATA_QUALITY_MISSING_OR_LOW');
    if(!microValidatedEarlyFlow&&(liquidityQuality===null||liquidityQuality<60||liquidityQuality>100))
      return rejected('LIQUIDITY_QUALITY_MISSING_OR_LOW');
    if(risks.some(x=>/ALREADY_EXTENDED|EXTENDED_CHASE|HIGH_RISK|STALE|FUTURE_DATA|DATA_GAP|WIDE_SPREAD|FAILED_BREAKOUT|TRAP_RISK/.test(x)))
      return rejected('RISK_OR_ANTI_CHASE_GUARD');

    const evidence=alert?.early_flow_watch_evidence||{};
    const quiet=alert?.quiet_base_pre_expansion||{};
    const shock=alert?.activity_shock||{};
    const closeTime=firstFinite([
      alert?.detected_candle_close_time,alert?.candle?.close_time,alert?.candle?.closeTime,
      alert?.data_status?.close_time,alert?.data_status?.source_time,alert?.source_time,
      alert?.early_expansion?.detected_candle_close_time,alert?.early_expansion?.metrics?.closed_candle_close_time,
      alert?.metrics?.closed_candle_close_time,evidence?.closed_candle_close_time,
      quiet?.candle_close_time_ms,quiet?.metrics?.buy_pressure_transition?.closed_candle_close_time,
      shock?.detected_candle_close_time
    ]);
    if(closeTime===null||closeTime>now+5000)return rejected('CLOSED_CANDLE_TIMESTAMP_INVALID');
    if(now-closeTime>20*60*1000)return rejected('CLOSED_CANDLE_EVIDENCE_TOO_OLD');
    const price=firstFinite([alert?.price,alert?.last_price,alert?.lastPrice]);
    if(price===null||price<=0)return rejected('LIVE_PRICE_MISSING');

    if(event==='EARLY_FLOW_WATCH_ONLY'){
      const dailyMove=firstFinite([alert?.price_change_24h]);
      if(dailyMove===null||Math.abs(dailyMove)>=18)
        return rejected('EARLY_FLOW_ANTI_CHASE_OR_MOVE_UNKNOWN');
      const micro=firstFinite([evidence?.micro_score,alert?.micro_fingerprint_score]);
      const confirmations=firstFinite([evidence?.confirmation_count]);
      const volumeRatio=Math.max(...[evidence?.rvol_1m,evidence?.rvol_5m].map(Number).filter(Number.isFinite),-Infinity);
      const tradeRatio=Math.max(...[evidence?.trade_rvol_1m,evidence?.trade_rvol_5m].map(Number).filter(Number.isFinite),-Infinity);
      const taker=firstFinite([evidence?.taker_buy_ratio]);
      const acceleration=Math.max(...[evidence?.acceleration_1m_pct,evidence?.acceleration_5m_pct].map(Number).filter(Number.isFinite),-Infinity);
      const recentReturn=Math.max(...[evidence?.return_1m,evidence?.return_5m].map(Number).filter(Number.isFinite),-Infinity);
      const participationConfirmed=microValidatedEarlyFlow
        ?volumeRatio>=1.20||tradeRatio>=1.15||(taker!==null&&taker>=0.54&&(volumeRatio>=1||tradeRatio>=1))
        :volumeRatio>=1.10&&tradeRatio>=1.05&&taker!==null&&taker>=0.52;
      const minimumMicroScore=microValidatedEarlyFlow?58:68;
      const minimumConfirmations=microValidatedEarlyFlow?3:4;
      if(evidence?.closed_candles_only!==true||micro===null||micro<minimumMicroScore||
         confirmations===null||confirmations<minimumConfirmations||!participationConfirmed||
         !(acceleration>0||recentReturn>0))
        return rejected('EARLY_FLOW_EVIDENCE_INCOMPLETE');
    }else if(event==='QUIET_BASE_PRE_EXPANSION_WATCH_ONLY'){
      const flow=quiet?.metrics?.buy_pressure_transition||{};
      const proof=Array.isArray(quiet?.evidence)?quiet.evidence:[];
      const passed=(key)=>proof.some(x=>String(x?.key||'').toLowerCase()===key&&x?.passed===true);
      if(quiet?.watch_only!==true||quiet?.reason!=='QUIET_BASE_NEAR_MISS_BUY_FLOW_TRANSITION'||
         flow?.available!==true||flow?.watch_only_qualified!==true||
         firstFinite([flow?.near_miss_signal_count])===null||Number(flow.near_miss_signal_count)<3||
         !passed('anti_chase')||
         !(passed('higher_lows_or_stable_support')||passed('stable_support'))||
         !passed('narrow_price_base_range_pct'))
        return rejected('QUIET_BASE_EVIDENCE_INCOMPLETE');
    }else if(event==='ACTIVITY_SHOCK_WATCH_ONLY'){
      if(shock?.detected!==true||shock?.watch_only!==true||
         firstFinite([shock?.score])===null||Number(shock.score)<76||shock?.extended===true)
        return rejected('ACTIVITY_SHOCK_EVIDENCE_INCOMPLETE');
    }else if(event==='RADAR_WATCH_ONLY_EARLY_TRACK'){
      const gate=alert?.notification_gate||alert?.elite_gate||{};
      const mode=String(gate?.mode||'').toUpperCase();
      const earlyMode=['FALCON_EARLY_TRACK','RADAR_WATCH_ONLY_EARLY_TRACK'].includes(mode);
      const persistentMode=['PERSISTENT_EARLY_TRACK','RADAR_WATCH_ONLY_PERSISTENT_EARLY_TRACK'].includes(mode);
      const allowedModes=earlyMode||persistentMode;
      const softFailures=new Set(['SCORE_BELOW_STRICT_THRESHOLD','CONFIRMATION_BREADTH_LOW','CATEGORY_DIVERSITY_LOW']);
      const failures=(Array.isArray(gate?.failures)?gate.failures:[]).map(x=>String(x||''));
      const eye=gate?.falcon_eye||{};
      const gateScore=firstFinite([gate?.score,alert?.opportunity_score,alert?.early_expansion_score]);
      const capture=firstFinite([eye?.capture]);
      const eyeQuality=firstFinite([eye?.quality]);
      const domains=firstFinite([eye?.independent_domains]);
      const captureFloor=persistentMode?80:74;
      const qualityFloor=persistentMode?60:68;
      if(gate?.eligible!==true||gate?.watch_only!==true||!allowedModes||
         failures.some(x=>!softFailures.has(x))||gateScore===null||gateScore<70||
         capture===null||capture<captureFloor||eyeQuality===null||eyeQuality<qualityFloor||
         domains===null||domains<3)
        return rejected('EARLY_TRACK_GATE_NOT_QUALIFIED');
    }else{
      return rejected('WATCH_ONLY_EVENT_UNSUPPORTED');
    }

    const providerStatus=this.provider.status();
    if(providerStatus?.enabled!==true)return {
      status:'PUSH_PROVIDER_DISABLED',reason:'PUSH_PROVIDER_DISABLED',
      attempted:false,notifications:[],sent_count:0,attempted_count:0
    };

    const rows=this.providerSubscriptions(await this.store.getSubscriptions());
    const recipients=[];
    for(const sub of rows){
      const settings=await this.store.getUserSettings(sub.user_id)||defaultSettings();
      if(!settings.enabled)continue;
      if(microValidatedEarlyFlow){
        // If a user raised quality floors above the defaults, do not guess at scores
        // that do not exist for this Micro-only, depth-unchecked observation.
        if(Number(settings.minDataQuality??70)>70||Number(settings.minLiquidityQuality??60)>60)continue;
      }else if(dataQuality<Number(settings.minDataQuality??70)||
         liquidityQuality<Number(settings.minLiquidityQuality??60))continue;
      recipients.push(sub);
    }
    if(!recipients.length)return {
      status:rows.length?'NO_ELIGIBLE_SUBSCRIPTIONS':'NO_SUBSCRIPTIONS',
      reason:rows.length?'USER_SETTINGS_OR_QUALITY_FILTER':'NO_PUSH_SUBSCRIPTIONS',
      attempted:false,notifications:[],sent_count:0,attempted_count:0
    };

    if(this.deduplicator){
      const dedupSignal={
        symbol,direction:'NONE',candle:{timeframe:'WATCH_ONLY'},
        reason_codes:['RADAR_WATCH_ONLY',String(alert?.radar||'UNKNOWN_RADAR'),event]
      };
      const check=await this.deduplicator.canEmit(dedupSignal,now);
      if(!check.allowed)return {
        status:'DUPLICATE_SUPPRESSED',reason:check.reason||'DUPLICATE_SIGNAL',
        attempted:false,notifications:[],sent_count:0,attempted_count:0
      };
      await this.deduplicator.markEmitted(dedupSignal,now);
    }

    const out=[];
    for(const sub of recipients){
      let response;
      try{response=await this.provider.send(sub,radarPayload({
        ...alert,market:'SPOT',price,watch_only:true,entry_eligible:false,
        paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
      },Date.now()));}
      catch(error){response={ok:false,status:'FAILED',reason:String(error?.message??error).slice(0,160)};}
      const audit={
        event:'RADAR_WATCH_ONLY_NOTIFICATION',event_class:'RADAR_ALERT',
        radar:String(alert?.radar||'EARLY_EXPANSION_RADAR'),radar_name:radarTitle(alert),
        symbol,alert_id:alert?.id||null,subscription_id:sub.id,user_id:sub.user_id,
        status:response?.status||'FAILED',provider:providerStatus.provider||'unknown',
        attempted_at:Date.now(),reason:response?.reason??null,http_status:response?.httpStatus??null,
        watch_only:true,entry_eligible:false,paper_trading:true,real_order_execution:false,
        confidence_score:'UNKNOWN',data_quality:dataQuality,liquidity_quality:liquidityQuality,
        micro_data_validated:microValidatedEarlyFlow,
        liquidity_evidence_status:microValidatedEarlyFlow?'ORDER_BOOK_NOT_CHECKED_AT_MICRO_STAGE':null,
        quote_volume_24h:microValidatedEarlyFlow?quoteVolume24h:null,
        event_type:event,source
      };
      try{await this.store.appendNotificationAudit(audit);}catch{}
      out.push(audit);
      if(response?.status==='GONE'){
        try{await this.store.disableSubscription(sub.id);}catch{}
      }
    }
    const sent=out.filter(x=>x.status==='SENT').length;
    return {
      status:sent?'SENT':out.length?'FAILED':'NO_ELIGIBLE_SUBSCRIPTIONS',
      attempted:out.length>0,notifications:out,sent_count:sent,attempted_count:out.length,
      watch_only:true,entry_eligible:false,paper_trading:true,real_order_execution:false
    };
  }
  async notifyRadarAlert(alert){
    const gate=alert?.notification_gate||alert?.elite_gate||{};
    // A qualified early-track gate is a monitoring notification, not an entry alert.
    // Route it through the stricter watch-only validator rather than silently dropping it
    // or allowing it to bypass the watch-only metadata and anti-chase checks.
    const explicitlyQualifiedJokerWatch=String(alert?.radar||'').toUpperCase()==='ROTATION_LAG_RADAR'&&alert?.watch_only===true&&alert?.entry_eligible===false&&alert?.rotation?.watch_eligible===true;
    if(gate?.eligible===true&&gate?.watch_only===true&&(alert?.eligible!==false||explicitlyQualifiedJokerWatch)){
      const timeCandidates=[
        alert?.detected_candle_close_time,alert?.candle?.close_time,alert?.candle?.closeTime,
        alert?.data_status?.close_time,alert?.data_status?.source_time,alert?.source_time,
        alert?.early_expansion?.detected_candle_close_time,alert?.early_expansion?.metrics?.closed_candle_close_time,
        alert?.metrics?.closed_candle_close_time
      ];
      const closeValue=timeCandidates.find(value=>value!==null&&value!==undefined&&value!==''&&
        typeof value!=='boolean'&&Number.isFinite(Number(value)));
      const rawPrice=alert?.price?.reference??alert?.price??alert?.last_price??alert?.lastPrice??alert?.entry_price;
      const result=await this.notifyRadarWatchOnlyAlert({
        ...alert,
        event:'RADAR_WATCH_ONLY_EARLY_TRACK',
        potential_label:alert?.potential_label||alert?.pre_expansion_stage||alert?.decision_band||'EARLY_SETUP',
        price:rawPrice,
        detected_candle_close_time:closeValue===undefined?null:Number(closeValue),
        closed_candles_only:alert?.closed_candles_only===true||alert?.candle?.closed===true||
          alert?.data_status?.candle_closed===true||alert?.early_expansion?.closed_candles_only===true,
        watch_only:true,entry_eligible:false,market:'SPOT',
        data_quality:alert?.data_quality??gate?.data_quality,
        liquidity_quality:alert?.liquidity_quality??gate?.liquidity_quality,
        source:alert?.source??alert?.data_status?.source,
        paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
      });
      return Array.isArray(result?.notifications)?result.notifications:[];
    }
    // Unqualified watch/rejected candidates still cannot use the generic entry route.
    const watchLabel=[alert?.event,alert?.decision_band,alert?.potential_label].filter(Boolean).join(' ').toUpperCase();
    if(alert?.watch_only===true||alert?.entry_eligible===false||
       alert?.notification_gate?.watch_only===true||alert?.notification_gate?.eligible===false||
       alert?.eligible===false||/WATCH_ONLY|WATCH_EARLY/.test(watchLabel)){
      return [];
    }
    const rows=this.providerSubscriptions(await this.store.getSubscriptions()),out=[];
    for(const sub of rows){
      const settings=await this.store.getUserSettings(sub.user_id)||defaultSettings();
      if(!settings.enabled)continue;
      // Missing quality is not perfect quality. Resolve the native payload field
      // for each radar and fail closed when no measured value is present.
      const dq=Number(
        alert?.data_quality ??
        alert?.data_status?.data_quality ??
        alert?.components?.data_quality ??
        alert?.components?.dataQuality ??
        alert?.early_move?.data_quality ??
        alert?.early_wake?.data_quality ??
        alert?.pre_explosion?.data_quality ??
        alert?.strong_move?.data_quality ??
        alert?.rotation?.data_quality ??
        alert?.liquidity_absorption?.data_quality ??
        alert?.kahir_analysis?.data_quality ??
        alert?.analysis?.data_quality ??
        alert?.doomsday?.data_quality ??
        alert?.professor_opinion?.data_quality ??
        alert?.deep_scan?.assessment?.data_quality ??
        alert?.almuqawim?.data_quality ??
        alert?.early_expansion?.data_quality ??
        alert?.coin_hunter?.data_quality ??
        alert?.factors?.data_quality ??
        alert?.whale_accumulation?.data_quality ??
        alert?.falcon_eye?.data_quality ??
        0
      );
      if(!Number.isFinite(dq)||dq<Number(settings.minDataQuality))continue;
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
