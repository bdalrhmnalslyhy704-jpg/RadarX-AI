import {defaultSettings} from '../core/signal-service.mjs';

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

const payload=s=>({type:'RADARX_SIGNAL',signal_id:s.signal_id,symbol:s.symbol,market:s.market,strategy:s.strategy,direction:s.direction,
  signal_type:s.signal_type,timeframe:s.candle?.timeframe,candle_close_time:s.candle?.close_time,price:s.price?.reference??null,
  data_quality:s.scores?.data_quality,liquidity_quality:s.scores?.liquidity_quality,reason_codes:s.reason_codes,
  confidence_score:'UNKNOWN',paper_trading:true,real_order_execution:false});

export class PushManager{
  constructor({provider,store,retryBaseMs=15000}){this.provider=provider;this.store=store;this.retryBaseMs=retryBaseMs;this.retryQueue=new Map();}
  status(){return this.provider.status();}
  async notifySignal(signal){
    const rows=await this.store.getSubscriptions(),cache=new Map(),out=[];
    for(const sub of rows){
      let settings=cache.get(sub.user_id);if(!settings){settings=await this.store.getUserSettings(sub.user_id)||defaultSettings();cache.set(sub.user_id,settings);}
      if(!settings.enabled||!settings.symbols.includes(signal.symbol)||!settings.timeframes.includes(signal.candle?.timeframe)||!settings.signalTypes.includes(signal.signal_type))continue;
      if(Number(signal.scores?.data_quality)<settings.minDataQuality||Number(signal.scores?.liquidity_quality)<settings.minLiquidityQuality)continue;
      const r=await this.provider.send(sub,payload(signal)),audit={signal_id:signal.signal_id,subscription_id:sub.id,user_id:sub.user_id,status:r.status,
        provider:this.provider.status().provider,attempted_at:Date.now(),reason:r.reason??null,http_status:r.httpStatus??null};
      await this.store.appendNotificationAudit(audit);out.push(audit);
      if(r.status==='GONE')await this.store.disableSubscription(sub.id);
      if(!r.ok&&r.status==='FAILED')this.retryQueue.set(sub.id+'|'+signal.signal_id,{subscription:sub,signal,nextAt:Date.now()+this.retryBaseMs,attempt:1});
    }
    return out;
  }
  async flushRetries(now=Date.now()){
    for(const [k,j] of [...this.retryQueue.entries()]){
      if(j.nextAt>now)continue;const r=await this.provider.send(j.subscription,payload(j.signal));
      await this.store.appendNotificationAudit({signal_id:j.signal.signal_id,subscription_id:j.subscription.id,user_id:j.subscription.user_id,status:r.status,
        provider:this.provider.status().provider,attempted_at:now,reason:r.reason??null,http_status:r.httpStatus??null,retry_attempt:j.attempt});
      if(r.ok||r.status==='GONE')this.retryQueue.delete(k);else{j.attempt++;j.nextAt=now+Math.min(this.retryBaseMs*(2**j.attempt),10*60*1000);}
    }
  }
}
