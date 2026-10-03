import http from 'node:http';
import {verifySessionToken} from '../core/auth.mjs';
import {defaultSettings} from '../core/signal-service.mjs';
import {DurableStore} from '../core/store.mjs';
import {MarketUniverseScanner} from '../market/universe-scanner.mjs';

function send(res,status,body,extra={}){
  const data=JSON.stringify(body);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...extra});
  res.end(data);
}
async function body(req,max){
  let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>max){throw new Error('BODY_TOO_LARGE');}}
  try{return raw?JSON.parse(raw):{};}catch{throw new Error('INVALID_JSON');}
}
function validSettings(x,allowedSymbols){
  const out={...defaultSettings(),...x};
  out.enabled=Boolean(out.enabled);
  if(!Array.isArray(out.symbols)||!out.symbols.length)throw new Error('INVALID_SYMBOLS');
  if(!Array.isArray(out.timeframes)||!out.timeframes.length||out.timeframes.some(x=>!['15m','1h','4h'].includes(x)))throw new Error('INVALID_TIMEFRAMES');
  if(!Array.isArray(out.signalTypes)||!out.signalTypes.length||out.signalTypes.some(x=>!['ENTRY_CANDIDATE','CONFIRMED'].includes(x)))throw new Error('INVALID_SIGNAL_TYPES');
  out.symbols=out.symbols.map(x=>String(x).toUpperCase()).filter(x=>/^[A-Z0-9]{5,20}$/.test(x));
  if(Array.isArray(allowedSymbols)&&out.symbols.some(x=>!allowedSymbols.includes(x)))throw new Error('SYMBOL_NOT_MONITORED');
  out.minDataQuality=Math.max(0,Math.min(100,Number(out.minDataQuality)));
  out.minLiquidityQuality=Math.max(0,Math.min(100,Number(out.minLiquidityQuality)));
  if(!Number.isFinite(out.minDataQuality)||!Number.isFinite(out.minLiquidityQuality))throw new Error('INVALID_QUALITY_THRESHOLDS');
  return {enabled:out.enabled,symbols:[...new Set(out.symbols)],timeframes:[...new Set(out.timeframes)],
    minDataQuality:out.minDataQuality,minLiquidityQuality:out.minLiquidityQuality,signalTypes:[...new Set(out.signalTypes)]};
}

const PUBLIC_SIGNAL_SYMBOL_RE=/^[A-Z0-9]{5,20}$/;
const DEFAULT_SIGNAL_FRESHNESS_MS=30*60*1000;

function finiteOrNull(value){const n=Number(value);return Number.isFinite(n)?n:null;}
function publicSource(value){return String(value||'').toUpperCase()==='BINANCE_PUBLIC_WS'?'Binance Public WebSocket':'Binance Public REST';}
function strategyById(strategies,id){
  if(Array.isArray(strategies))return strategies.find(x=>String(x?.strategy||x?.id||'').toUpperCase()===id)||null;
  const key=({MTF_TREND:'trend',CONFIRMED_BREAKOUT:'breakout',MEAN_REVERSION:'meanReversion'})[id];
  return key&&strategies&&typeof strategies==='object'?strategies[key]||null:null;
}
function signalScore(strategy,key){return finiteOrNull(strategy?.score?.[key]);}
function emptyPublicSignal(symbol,{source='Binance Public REST',stale=false,gaps=false,future=false,dataValid=false,lastError=null}={}){
  return {
    price:{reference:null,entry:null,stop_loss:null,tp1:null,tp2:null,tp3:null},
    scores:{trend_score:null,breakout_score:null,mean_reversion_score:null,data_quality:null,liquidity_quality:null,confidence_score:'UNKNOWN'},
    risk_filter:'UNKNOWN',risk_reasons:[],
    data_status:{source,stale,gaps,future_data_detected:future,data_valid:dataValid,last_error:lastError},
    strategies:{trend:null,breakout:null,meanReversion:null},
    reason_codes:[]
  };
}
function publicSignalMeta({live=false,source='Binance Public REST',asOfMs=null,now,maxFreshnessMs}){
  const fetchAgeMs=Number.isFinite(asOfMs)?Math.max(0,now-asOfMs):null;
  return {live,source,as_of:Number.isFinite(asOfMs)?new Date(asOfMs).toISOString():null,fetch_age_ms:fetchAgeMs,
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'};
}
function inspectPublicSignal(snapshot,now,maxFreshnessMs,minDataQuality){
  const signal=snapshot?.signal;
  const symbol=String(snapshot?.symbol||signal?.symbol||'').trim().toUpperCase();
  if(!snapshot||!signal||!PUBLIC_SIGNAL_SYMBOL_RE.test(symbol))return{kind:'unavailable',reason:'SNAPSHOT_INVALID'};
  if(String(signal.symbol||'').toUpperCase()!==symbol)return{kind:'unavailable',reason:'SYMBOL_MISMATCH'};
  const asOfMs=finiteOrNull(snapshot.processed_at);
  if(asOfMs===null)return{kind:'unavailable',reason:'SNAPSHOT_TIMESTAMP_MISSING'};
  const ds=signal.data_status&&typeof signal.data_status==='object'?signal.data_status:{};
  const candleCloseMs=finiteOrNull(signal.candle?.close_time);
  const future=Boolean(ds.future_data_detected) ||
    (candleCloseMs!==null && candleCloseMs>now+5000) ||
    asOfMs>now+5000;
  const fetchAgeMs=Math.max(0,now-asOfMs);
  const candleAgeMs=candleCloseMs===null?Infinity:Math.max(0,now-candleCloseMs);
  const stale=Boolean(ds.stale) || fetchAgeMs>maxFreshnessMs || candleAgeMs>maxFreshnessMs;
  const gaps=Boolean(ds.gaps);
  const dq=finiteOrNull(signal.scores?.data_quality);
  const sourceKey=String(ds.source||'').trim().toUpperCase();
  const sourceAllowed=sourceKey==='BINANCE_PUBLIC_REST'||sourceKey==='BINANCE_PUBLIC_WS';
  const source=publicSource(sourceKey);
  const strategies=snapshot.strategies;
  const trend=strategyById(strategies,'MTF_TREND');
  const breakout=strategyById(strategies,'CONFIRMED_BREAKOUT');
  const meanReversion=strategyById(strategies,'MEAN_REVERSION');
  const completeStrategies=Boolean(trend&&breakout&&meanReversion);
  const invalid=future||stale||gaps||!sourceAllowed||dq===null||dq<minDataQuality||!completeStrategies||
    signal.paper_trade?.enabled!==true||signal.paper_trade?.real_order_execution!==false;
  let reason=null;
  if(future)reason='FUTURE_DATA';
  else if(stale)reason='STALE_SNAPSHOT';
  else if(gaps)reason='DATA_GAPS';
  else if(!sourceAllowed)reason='SOURCE_UNAVAILABLE';
  else if(!sourceAllowed)reason='SOURCE_UNAVAILABLE';
  else if(dq===null||dq<minDataQuality)reason='LOW_DATA_QUALITY';
  else if(!completeStrategies)reason='PARTIAL_ANALYSIS';
  else if(signal.paper_trade?.enabled!==true||signal.paper_trade?.real_order_execution!==false)reason='READ_ONLY_POLICY_VIOLATION';
  const dataValid=!future&&!stale&&!gaps&&dq!==null&&dq>=minDataQuality;
  return {kind:invalid?'not_ready':'ok',symbol,signal,trend,breakout,meanReversion,source,asOfMs,fetchAgeMs,stale,gaps,future,dataValid,reason};
}
function buildPublicSignalBody(result,now,maxFreshnessMs){
  const {symbol,signal,trend,breakout,meanReversion,source,asOfMs,fetchAgeMs,stale,gaps,future,dataValid,reason}=result;
  const baseSignal=emptyPublicSignal(symbol,{source,stale,gaps,future,dataValid,lastError:reason});
  baseSignal.price={
    reference:finiteOrNull(signal.price?.reference),entry:finiteOrNull(signal.price?.entry),stop_loss:finiteOrNull(signal.price?.stop_loss),
    tp1:finiteOrNull(signal.price?.tp1),tp2:finiteOrNull(signal.price?.tp2),tp3:finiteOrNull(signal.price?.tp3)
  };
  baseSignal.scores={
    trend_score:signalScore(trend,'trendScore'),
    breakout_score:signalScore(breakout,'breakoutScore'),
    mean_reversion_score:signalScore(meanReversion,'meanReversionScore'),
    data_quality:finiteOrNull(signal.scores?.data_quality),
    liquidity_quality:finiteOrNull(signal.scores?.liquidity_quality),
    confidence_score:'UNKNOWN'
  };
  baseSignal.risk_filter=['PASS','FAIL'].includes(signal.risk_filter)?signal.risk_filter:'UNKNOWN';
  baseSignal.risk_reasons=Array.isArray(signal.risk_reasons)?signal.risk_reasons:[];
  baseSignal.data_status.source=source;
  baseSignal.data_status.stale=stale;
  baseSignal.data_status.gaps=gaps;
  baseSignal.data_status.future_data_detected=future;
  baseSignal.data_status.data_valid=dataValid;
  baseSignal.data_status.last_error=reason;
  baseSignal.strategies={trend:trend||null,breakout:breakout||null,meanReversion:meanReversion||null};
  baseSignal.reason_codes=Array.isArray(signal.reason_codes)?signal.reason_codes:[];
  const live=result.kind==='ok';
  const status=live?'ok':'not_ready';
  return {status,symbol,meta:publicSignalMeta({live,source,asOfMs,now,maxFreshnessMs}),signal:baseSignal,
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
    ...(live?{}:{error:reason||'SIGNAL_NOT_READY'})};
}

function subscriptionValid(x){
  if(typeof x?.endpoint!=='string'||!x.endpoint.startsWith('https://'))throw new Error('INVALID_PUSH_ENDPOINT');
  if(typeof x?.keys?.p256dh!=='string'||typeof x?.keys?.auth!=='string')throw new Error('INVALID_PUSH_KEYS');
  return {endpoint:x.endpoint,expirationTime:x.expirationTime??null,keys:{p256dh:x.keys.p256dh,auth:x.keys.auth}};
}
export function createApiServer({config,store,monitor,pushProvider,pushManager=null,moveSentinel=null,strongMoveRadar=null,rotationLagRadar=null}){
  const counters=new Map();
  const moveConfig=config.moveRadar||{thresholdPct:1};
  const originList=config.auth.allowedOrigins;
  const marketRadar = monitor?.rest ? new MarketUniverseScanner({
    rest: monitor.rest,
    config: config.marketRadar ?? {}
  }) : null;
  function allowedOrigin(req){
    const o=req.headers.origin;if(!o||!originList.length)return null;return originList.includes(o)?o:null;
  }
  function requireTrustedBrowser(req){
    const o=allowedOrigin(req);return o&&o===req.headers.origin?o:null;
  }
  function authUser(req){
    const header=req.headers.authorization||'';if(!header.startsWith('Bearer '))return null;
    const token=header.slice(7);return verifySessionToken(token,config.auth.secret)?.sub||null;
  }
  function rateOk(key){
    const now=Date.now(),cut=now-60000,a=(counters.get(key)||[]).filter(t=>t>cut);
    if(a.length>=config.api.rateLimitPerMinute){counters.set(key,a);return false;}
    a.push(now);counters.set(key,a);return true;
  }
  return http.createServer(async(req,res)=>{
    const cors=allowedOrigin(req);if(cors)res.setHeader('access-control-allow-origin',cors);
    res.setHeader('vary','Origin');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');
    if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':cors||'null','access-control-allow-methods':'GET,PUT,POST,DELETE,OPTIONS','access-control-allow-headers':'authorization,content-type'});return res.end();}
    const key=(req.socket.remoteAddress||'unknown')+'|'+(req.headers.authorization||'');
    if(!rateOk(key))return send(res,429,{error:'RATE_LIMITED'});
    try{
      const u=new URL(req.url,'http://localhost');
      if(u.pathname==='/healthz'&&req.method==='GET')return send(res,200,{...monitor.health(),move_radar:moveSentinel?.health?.()||{running:false},strong_move_radar:strongMoveRadar?.health?.()||{running:false},rotation_lag_radar:rotationLagRadar?.health?.()||{running:false}});
      if(u.pathname==='/readyz'&&req.method==='GET'){
        const h=monitor.health(),ok=h.database.state==='LIVE'&&(h.websocket.state==='LIVE'||h.rest.state==='LIVE');return send(res,ok?200:503,{ready:ok,health:h});
      }
      if(u.pathname==='/api/move-radar'&&req.method==='GET'){
        if(!moveSentinel)return send(res,503,{error:'MOVE_RADAR_UNAVAILABLE'});
        const sinceRaw=Number(u.searchParams.get('since')||0);
        const limit=Math.max(1,Math.min(100,Math.trunc(Number(u.searchParams.get('limit')||50))));
        try{
          const alerts=typeof store.readMoveAlerts==='function'
            ? await store.readMoveAlerts({sinceMs:Number.isFinite(sinceRaw)?Math.max(0,sinceRaw):0,limit})
            : [];
          return send(res,200,{
            meta:{live:moveSentinel.health().running===true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',radar:'MOVE_RADAR'},
            source:'Binance Public REST/WS',
            as_of:new Date(Date.now()).toISOString(),
            monitoring:moveSentinel.health(),
            thresholds:{move_pct:moveConfig.thresholdPct??1,market:'SPOT'},
            alerts
          });
        }catch(e){
          return send(res,503,{error:String(e?.message??e),alerts:[],meta:{live:false,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',radar:'MOVE_RADAR'}});
        }
      }
      if(u.pathname==='/api/strong-move-radar'&&req.method==='GET'){
        if(!strongMoveRadar)return send(res,503,{error:'STRONG_MOVE_RADAR_UNAVAILABLE'});
        const sinceRaw=Number(u.searchParams.get('since')||0);
        const limit=Math.max(1,Math.min(100,Math.trunc(Number(u.searchParams.get('limit')||50))));
        try{
          const alerts=typeof store.readStrongMoveAlerts==='function'
            ? await store.readStrongMoveAlerts({sinceMs:Number.isFinite(sinceRaw)?Math.max(0,sinceRaw):0,limit})
            : [];
          const health=strongMoveRadar.health();
          return send(res,200,{
            meta:{live:health.running===true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',radar:'STRONG_MOVE_RADAR'},
            source:'Binance Public REST',
            as_of:new Date(Date.now()).toISOString(),
            monitoring:health,
            thresholds:{min_score:Number(config.strongMoveRadar?.minScore??76),market:'SPOT',fast_timeframe:'1m',confirmation_timeframe:'5m'},
            algorithms:health.algorithms||[],
            alerts
          });
        }catch(e){
          return send(res,503,{error:String(e?.message??e),alerts:[],meta:{live:false,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',radar:'STRONG_MOVE_RADAR'}});
        }
      }
      if(u.pathname==='/api/rotation-radar'&&req.method==='GET'){
        if(!rotationLagRadar)return send(res,503,{error:'ROTATION_LAG_RADAR_UNAVAILABLE'});
        const sinceRaw=Number(u.searchParams.get('since')||0);
        const limit=Math.max(1,Math.min(100,Math.trunc(Number(u.searchParams.get('limit')||50))));
        try{
          const alerts=typeof store.readRotationAlerts==='function'
            ? await store.readRotationAlerts({sinceMs:Number.isFinite(sinceRaw)?Math.max(0,sinceRaw):0,limit})
            : [];
          const health=rotationLagRadar.health();
          return send(res,200,{
            meta:{live:health.running===true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',radar:'ROTATION_LAG_RADAR'},
            source:'Binance Public REST',
            as_of:new Date(Date.now()).toISOString(),
            monitoring:health,
            thresholds:{min_score:Number(config.rotationRadar?.minScore??78),min_confirmations:Number(config.rotationRadar?.minConfirmations??4),market:'SPOT',primary_timeframe:'15m',confirmation_timeframe:'1h'},
            algorithms:health.algorithms||[],
            alerts
          });
        }catch(e){
          return send(res,503,{error:String(e?.message??e),alerts:[],meta:{live:false,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',radar:'ROTATION_LAG_RADAR'}});
        }
      }
      if(u.pathname==='/api/pre-move-radar'&&req.method==='GET'){
        if(!marketRadar)return send(res,503,{error:'PRE_MOVE_RADAR_UNAVAILABLE'});
        const quote=String(u.searchParams.get('quote')||'USDT').trim().toUpperCase();
        const limit=u.searchParams.get('limit')||'30';
        try{
          return send(res,200,await marketRadar.scanPreMove({quote,limit}));
        }catch(e){
          const m=String(e?.message??e);
          const status=/INVALID_QUOTE|INVALID_EXCHANGE_INFO/.test(m)?400:/RATE_LIMIT|TIMEOUT|UNAVAILABLE|FAILED/.test(m)?502:500;
          return send(res,status,{error:m,meta:{live:false,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',radar:'PRE_MOVE'},source:'Binance Public REST',candidates:[]});
        }
      }
      if(u.pathname==='/api/market-radar'&&req.method==='GET'){
        if(!marketRadar)return send(res,503,{error:'MARKET_RADAR_UNAVAILABLE'});
        const quote=String(u.searchParams.get('quote')||'USDT').trim().toUpperCase();
        const limit=u.searchParams.get('limit')||'20';
        try{
          return send(res,200,await marketRadar.scan({quote,limit}));
        }catch(e){
          const m=String(e?.message??e);
          const status=/INVALID_QUOTE|INVALID_EXCHANGE_INFO/.test(m)?400:/RATE_LIMIT|TIMEOUT|UNAVAILABLE|FAILED/.test(m)?502:500;
          return send(res,status,{error:m,meta:{live:false,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'},source:'Binance Public REST',candidates:[]});
        }
      }
      if(u.pathname==='/api/signal'&&req.method==='GET'){
        const rawSymbol=String(u.searchParams.get('symbol')||'').trim().toUpperCase();
        if(!PUBLIC_SIGNAL_SYMBOL_RE.test(rawSymbol))return send(res,400,{status:'bad_request',symbol:rawSymbol||null,meta:publicSignalMeta({live:false,source:'Binance Public REST',asOfMs:null,now:Date.now(),maxFreshnessMs:DEFAULT_SIGNAL_FRESHNESS_MS}),signal:emptyPublicSignal(rawSymbol||null,{source:'Binance Public REST',dataValid:false,lastError:'INVALID_SYMBOL'}),paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',error:'INVALID_SYMBOL'});
        const now=Date.now();
        try{
          const snapshot=typeof store.getSignalSnapshot==='function'?await store.getSignalSnapshot(rawSymbol):null;
          if(!snapshot)return send(res,503,{status:'unavailable',symbol:rawSymbol,meta:publicSignalMeta({live:false,source:'Binance Public REST',asOfMs:null,now,maxFreshnessMs:DEFAULT_SIGNAL_FRESHNESS_MS}),signal:emptyPublicSignal(rawSymbol,{source:'Binance Public REST',dataValid:false,lastError:'DATA_UNAVAILABLE'}),paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',error:'DATA_UNAVAILABLE'});
          const maxFreshnessMs=Math.max(1,Number(config.monitoring?.maxStaleTriggerMs??DEFAULT_SIGNAL_FRESHNESS_MS));
          const minDataQuality=Math.max(0,Number(config.monitoring?.minDataQuality??70));
          const result=inspectPublicSignal(snapshot,now,maxFreshnessMs,minDataQuality);
          if(result.kind==='unavailable')return send(res,503,{status:'unavailable',symbol:rawSymbol,meta:publicSignalMeta({live:false,source:result.source||'Binance Public REST',asOfMs:result.asOfMs??null,now,maxFreshnessMs}),signal:emptyPublicSignal(rawSymbol,{source:result.source||'Binance Public REST',dataValid:false,lastError:result.reason}),paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',error:result.reason});
          const payload=buildPublicSignalBody(result,now,maxFreshnessMs);
          return send(res,result.kind==='ok'?200:503,payload);
        }catch(e){
          const m=String(e?.message??e);
          return send(res,503,{status:'unavailable',symbol:rawSymbol,meta:publicSignalMeta({live:false,source:'Binance Public REST',asOfMs:null,now, maxFreshnessMs:DEFAULT_SIGNAL_FRESHNESS_MS}),signal:emptyPublicSignal(rawSymbol,{source:'Binance Public REST',dataValid:false,lastError:m}),paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',error:'DATA_UNAVAILABLE'});
        }
      }
      if(!u.pathname.startsWith('/v1/'))return send(res,404,{error:'NOT_FOUND'});
      const user=authUser(req);if(!user)return send(res,401,{error:'UNAUTHORIZED'});
      if(u.pathname==='/v1/config'&&req.method==='GET')return send(res,200,{environment:config.environment??'unknown',symbols:config.symbols,timeframes:config.timeframes,
        push:{provider:pushProvider.status().provider,enabled:pushProvider.status().enabled,vapidPublicKey:config.push.vapidPublicKey||null,testPushEnabled:Boolean(config.staging?.testPushEnabled)}});

      if(u.pathname==='/v1/push/test'&&req.method==='POST'){
        if(config.environment!=='staging'||config.staging?.testPushEnabled!==true)return send(res,404,{error:'STAGING_TEST_PUSH_DISABLED'});
        if(!requireTrustedBrowser(req))return send(res,403,{error:'TRUSTED_ORIGIN_REQUIRED'});
        const status=pushProvider.status();
        if(status.provider!=='webpush'||!status.enabled)return send(res,503,{error:'WEB_PUSH_NOT_ENABLED'});
        if(!pushManager)return send(res,503,{error:'PUSH_MANAGER_UNAVAILABLE'});
        const result=await pushManager.notifyTestPush({userId:user,testId:(await body(req,config.api.maxBodyBytes)).test_id});
        if(result.status==='DUPLICATE')return send(res,409,{error:'DUPLICATE_TEST_PUSH',...result});
        if(result.status==='NO_SUBSCRIPTIONS')return send(res,409,{error:'NO_ACTIVE_PUSH_SUBSCRIPTIONS',...result});
        return send(res,result.status==='SENT'?202:502,{ok:result.status==='SENT',...result});
      }

      if(u.pathname==='/v1/settings'&&req.method==='GET')return send(res,200,{settings:await store.getUserSettings(user)||defaultSettings()});
      if(u.pathname==='/v1/settings'&&req.method==='PUT'){
        const s=validSettings(await body(req,config.api.maxBodyBytes),config.symbols);return send(res,200,{settings:await store.putUserSettings(user,s)});
      }
      if(u.pathname==='/v1/subscriptions'&&req.method==='GET'){
        const list=await store.getSubscriptions(user);return send(res,200,{subscriptions:list.map(DurableStore.publicSubscription)});
      }
      if(u.pathname==='/v1/subscriptions'&&req.method==='POST'){
        const s=subscriptionValid(await body(req,config.api.maxBodyBytes));const row=await store.upsertSubscription(user,s);
        return send(res,201,{subscription:DurableStore.publicSubscription(row),provider:pushProvider.status()});
      }
      const prefix='/v1/subscriptions/';
      if(u.pathname.startsWith(prefix)&&req.method==='DELETE'){
        const id=decodeURIComponent(u.pathname.slice(prefix.length));
        if(!id||id.includes('/'))return send(res,400,{error:'INVALID_SUBSCRIPTION_ID'});
        const ok=await store.deleteSubscription(user,id);return send(res,ok?200:404,{deleted:ok});
      }
      const signalPrefix='/v1/signals/';
      if(u.pathname.startsWith(signalPrefix)&&req.method==='GET'){
        const id=decodeURIComponent(u.pathname.slice(signalPrefix.length));
        const events=await store.readRecent('signals',200);const hit=events.find(x=>x.signal_id===id&&x.signal_snapshot);
        return send(res,hit?200:404,hit?{event:hit}:{error:'SIGNAL_NOT_FOUND'});
      }
      if(u.pathname==='/v1/signals'&&req.method==='GET')return send(res,200,{events:await store.readRecent('signals',Math.min(200,Number(u.searchParams.get('limit')||50)))});
      if(u.pathname==='/v1/notifications'&&req.method==='GET'){
        const events=await store.readRecent('notifications',Math.min(200,Number(u.searchParams.get('limit')||50)));
        return send(res,200,{events:events.filter(x=>x.user_id===user)});
      }
      if(u.pathname==='/v1/push/status'&&req.method==='GET')return send(res,200,pushProvider.status());
      return send(res,404,{error:'NOT_FOUND'});
    }catch(e){
      const m=String(e?.message??e);const status=/BODY_TOO_LARGE/.test(m)?413:/INVALID_|PUSH_|TIME/.test(m)?400:500;
      return send(res,status,{error:m});
    }
  });
}
