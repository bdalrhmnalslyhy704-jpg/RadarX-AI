import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';

const toCandle = payload => {
  const k=payload?.k;
  if(payload?.e!=='kline'||!k) return null;
  return {
    symbol:String(k.s||'').toUpperCase(), openTime:Number(k.t), closeTime:Number(k.T),
    open:Number(k.o),high:Number(k.h),low:Number(k.l),close:Number(k.c),volume:Number(k.v),
    quoteVolume:Number(k.q),tradeCount:Number(k.n),takerBuyBaseVolume:Number(k.V),
    takerBuyQuoteVolume:Number(k.Q),closed:Boolean(k.x),source:'BINANCE_PUBLIC_WS',
    sourceTime:Number(payload.E)||Date.now(),timeframe:String(k.i||'')
  };
};

export class BinanceStreamClient {
  constructor({urls,streams,WebSocketImpl=WebSocket,initialBackoffMs=1000,maxBackoffMs=60000,jitterRatio=0.2,
    heartbeatTimeoutMs=90000,maxConnectionMs=82800000,onCandle=()=>{},onState=()=>{}}){
    if(!streams.length||streams.length>1024) throw new Error('INVALID_STREAM_COUNT');
    this.urls=[...urls];this.streams=streams.map(x=>x.toLowerCase());this.WebSocketImpl=WebSocketImpl;
    this.initialBackoffMs=initialBackoffMs;this.maxBackoffMs=maxBackoffMs;this.jitterRatio=jitterRatio;
    this.heartbeatTimeoutMs=heartbeatTimeoutMs;this.maxConnectionMs=maxConnectionMs;
    this.onCandle=onCandle;this.onState=onState;this.socket=null;this.running=false;
    this.timer=null;this.heartbeatTimer=null;this.connectionTimer=null;this.attempt=0;this.urlIndex=0;
    this.lastMessageAt=null;this.lastConnectedAt=null;this.reconnectCount=0;this.state='STOPPED';this.connectionId=null;
  }
  health(){return {state:this.state,last_message_at:this.lastMessageAt,last_connected_at:this.lastConnectedAt,
    reconnect_attempts:this.reconnectCount,url:this.urls[this.urlIndex]??null};}
  start(){if(this.running)return;this.running=true;this.attempt=0;this.connect();}
  stop(){this.running=false;for(const t of [this.timer,this.heartbeatTimer,this.connectionTimer])if(t)clearTimeout(t);
    this.timer=this.heartbeatTimer=this.connectionTimer=null;try{this.socket?.close();}catch{}this.socket=null;this.state='STOPPED';this.onState(this.state);}
  url(){const u=new URL(this.urls[this.urlIndex]);u.searchParams.set('streams',this.streams.join('/'));return u.toString();}
  scheduleReconnect(reason){
    if(!this.running)return;this.state='BACKING_OFF';this.onState(this.state,reason);
    const exp=Math.min(this.maxBackoffMs,this.initialBackoffMs*(2**this.attempt));
    const delay=Math.min(this.maxBackoffMs,Math.round(exp+exp*this.jitterRatio*Math.random()));
    this.attempt++;this.reconnectCount++;
    this.timer=setTimeout(()=>{this.timer=null;this.urlIndex=(this.urlIndex+1)%this.urls.length;this.connect();},delay);
  }
  connect(){
    if(!this.running)return;this.state='CONNECTING';this.onState(this.state);
    const id=randomUUID();this.connectionId=id;let socket;
    try{socket=new this.WebSocketImpl(this.url());}catch(e){this.scheduleReconnect(String(e?.message??e));return;}
    this.socket=socket;
    const guard=fn=>(...args)=>{if(this.connectionId===id)fn(...args);};
    socket.on('open',guard(()=>{
      this.lastConnectedAt=Date.now();this.lastMessageAt=this.lastConnectedAt;this.attempt=0;this.state='LIVE';this.onState(this.state);
      this.connectionTimer=setTimeout(()=>{try{socket.close();}catch{}},this.maxConnectionMs);
      this.heartbeatTimer=setTimeout(()=>this.checkHeartbeat(socket),this.heartbeatTimeoutMs);
    }));
    socket.on('message',guard(raw=>{
      this.lastMessageAt=Date.now();this.state='LIVE';
      try{const x=JSON.parse(raw.toString());const candle=toCandle(x?.data??x);if(candle)this.onCandle(candle);}
      catch(e){this.onState(this.state,'INVALID_WS_JSON:'+String(e?.message??e));}
    }));
    socket.on('ping',guard(()=>{try{socket.pong?.();}catch{}}));
    socket.on('error',guard(e=>this.onState(this.state,'WS_ERROR:'+String(e?.message??e))));
    socket.on('close',guard(()=>{for(const t of [this.heartbeatTimer,this.connectionTimer])if(t)clearTimeout(t);
      this.heartbeatTimer=this.connectionTimer=null;this.socket=null;if(this.running)this.scheduleReconnect('WS_CLOSED');}));
  }
  checkHeartbeat(socket){
    if(!this.running||this.socket!==socket)return;
    if(this.lastMessageAt&&Date.now()-this.lastMessageAt>this.heartbeatTimeoutMs){try{socket.terminate?.();}catch{try{socket.close();}catch{}}return;}
    this.heartbeatTimer=setTimeout(()=>this.checkHeartbeat(socket),this.heartbeatTimeoutMs);
  }
}
export {toCandle};
