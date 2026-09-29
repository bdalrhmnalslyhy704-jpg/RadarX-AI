import {randomUUID} from 'node:crypto';

export class SignalDeduplicator {
  constructor({store=null,windowMs=15*60*1000}={}){this.store=store;this.windowMs=windowMs;this.seen=new Map();}
  key(signal,now=Date.now()){
    const c=signal?.candle||{},t=Number(c.close_time||now),w=Math.floor(t/this.windowMs)*this.windowMs;
    const reasons=Array.isArray(signal?.reason_codes)?signal.reason_codes.map(String).sort().join(','):'';
    return [signal?.symbol||'UNKNOWN',signal?.direction||'NONE',c.timeframe||'UNKNOWN',reasons,w].join('|');
  }
  async canEmit(signal,now=Date.now()){
    const k=this.key(signal,now);if(this.seen.has(k))return{allowed:false,key:k,reason:'DUPLICATE_SIGNAL'};
    if(this.store&&await this.store.getDedupKey(k)){this.seen.set(k,true);return{allowed:false,key:k,reason:'DUPLICATE_SIGNAL'};}
    return{allowed:true,key:k};
  }
  async markEmitted(signal,now=Date.now()){const k=this.key(signal,now),v={id:randomUUID(),key:k,emitted_at:now};this.seen.set(k,v);
    if(this.store)await this.store.putDedupKey(k,v);return v;}
}
