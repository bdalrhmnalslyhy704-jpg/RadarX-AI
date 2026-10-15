const num=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const arr=v=>Array.isArray(v)?v:[];

// Resolve a markout only from a market observation close to its actual horizon.
// A later price must never be reused as if it were the 15m, 1h, or 4h price.
const HORIZONS=Object.freeze([
  ['15m',15*60*1000,0.005,5*60*1000],
  ['1h',60*60*1000,0.012,10*60*1000],
  ['4h',4*60*60*1000,0.025,30*60*1000],
  ['24h',24*60*60*1000,0.05,2*60*60*1000]
]);
const CANDLE_MARKOUT_GRACE_MS=15*60*1000;
const MAX_PENDING=36;
const MAX_HISTORY=120;

function normalizeDirection(v){
  const d=String(v||'').toUpperCase();
  if(d.includes('UP')||d.includes('BUY')||d==='LONG')return 'UP';
  if(d.includes('DOWN')||d.includes('SELL')||d==='SHORT')return 'DOWN';
  return null;
}

function safeMemory(raw,symbol){
  const m=raw&&typeof raw==='object'?raw:{};
  return {
    symbol:String(symbol||m.symbol||'').toUpperCase(),
    predictions:Array.isArray(m.predictions)?m.predictions:[],
    history:Array.isArray(m.history)?m.history:[],
    stats:m.stats&&typeof m.stats==='object'?m.stats:{}
  };
}

function emptyStats(){
  return {
    '15m':{samples:0,hits:0,misses:0,neutral:0,unavailable:0},
    '1h':{samples:0,hits:0,misses:0,neutral:0,unavailable:0},
    '4h':{samples:0,hits:0,misses:0,neutral:0,unavailable:0},
    '24h':{samples:0,hits:0,misses:0,neutral:0,unavailable:0}
  };
}

function outcomeFor(direction,ret,target){
  const r=num(ret,null);
  if(r==null)return 'PENDING';
  if(direction==='UP')return r>=target?'HIT':r<=-target*.7?'MISS':'NEUTRAL';
  return r<=-target?'HIT':r>=target*.7?'MISS':'NEUTRAL';
}

function scoreStats(stats){
  const xs=[];
  for(const [,s] of Object.entries(stats||{})){
    const n=num(s.samples,0),hits=num(s.hits,0);
    if(n>0)xs.push(hits/n);
  }
  return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length*100:50;
}

function horizonCandle(rows,dueAt,now){
  if(!Array.isArray(rows))return null;
  return rows.filter(c=>{
    if(c?.closed!==true)return false;
    const closeTime=Number(c?.closeTime),close=Number(c?.close);
    return Number.isFinite(closeTime)&&closeTime>=dueAt&&
      closeTime<=dueAt+CANDLE_MARKOUT_GRACE_MS&&closeTime<=now&&
      Number.isFinite(close)&&close>0;
  }).sort((a,b)=>Number(a.closeTime)-Number(b.closeTime))[0]||null;
}

async function load(store,symbol){
  const raw=await store.getPredictionCalibration(symbol);
  const m=safeMemory(raw,symbol);
  const defaults=emptyStats();
  for(const h of Object.keys(defaults))m.stats[h]={...defaults[h],...(m.stats[h]||{})};
  return m;
}

async function save(store,m){
  const slim={
    symbol:m.symbol,
    predictions:m.predictions.slice(-MAX_PENDING),
    history:m.history.slice(-MAX_HISTORY),
    stats:m.stats,
    updated_at:Date.now()
  };
  await store.putPredictionCalibration(m.symbol,slim);
  return slim;
}

export async function updateSignalOutcomes(store,{symbol,price,now=Date.now(),priceHistory}={}){
  const s=String(symbol||'').trim().toUpperCase();
  const p=num(price,null);
  const at=num(now,null);
  if(!s||p==null||p<=0||at==null||at<=0||!store?.getPredictionCalibration||!store?.putPredictionCalibration)return null;
  const m=await load(store,s);
  if(!m.predictions.length)return {symbol:s,updated:0,unavailable:0,calibration_score:scoreStats(m.stats),stats:m.stats};
  let updated=0;
  let unavailable=0;
  let changed=false;
  const keep=[];
  for(const pred of m.predictions){
    if(!pred||pred.symbol!==s||num(pred.entry_price,null)==null||Number(pred.entry_price)<=0||!pred.direction){
      changed=true;
      continue;
    }
    const createdAt=Number(pred.created_at);
    // Invalid/future timestamps cannot be used to produce markouts.
    if(!Number.isFinite(createdAt)||createdAt<=0||at<createdAt){
      keep.push(pred);
      continue;
    }
    const age=at-createdAt;
    const returns={...pred.returns};
    const outcomes={...pred.outcomes};
    const markoutSources={...pred.markout_sources};
    for(const [h,ms,target,toleranceMs] of HORIZONS){
      if(outcomes[h])continue;
      if(age<ms)continue;
      const dueAt=createdAt+ms;
      // Prefer a genuine closed 15m candle at the forecast horizon. This lets
      // a later scan backfill the correct historical mark instead of using its
      // current price for several older horizons.
      const candle=horizonCandle(priceHistory,dueAt,at);
      let markPrice=null;
      if(candle){
        markPrice=Number(candle.close);
        markoutSources[h]='CLOSED_15M_CANDLE';
      }else if(!Array.isArray(priceHistory)&&age-ms<=toleranceMs){
        // Compatibility path for callers that can provide only a current
        // snapshot. Its bounded time window prevents late-price leakage.
        markPrice=p;
        markoutSources[h]='CURRENT_SNAPSHOT_WITHIN_WINDOW';
      }else if(age-ms>toleranceMs){
        outcomes[h]='UNAVAILABLE';
        m.stats[h].unavailable=num(m.stats[h].unavailable,0)+1;
        unavailable++;
        changed=true;
        continue;
      }else{
        // The horizon's sample window is not over yet; allow a later update
        // to supply the matching closed candle.
        continue;
      }
      returns[h]=Number(((markPrice/Number(pred.entry_price)-1)*100).toFixed(4));
      outcomes[h]=outcomeFor(pred.direction,returns[h]/100,target);
      if(['HIT','MISS','NEUTRAL'].includes(outcomes[h])){
        m.stats[h].samples=num(m.stats[h].samples,0)+1;
        if(outcomes[h]==='HIT')m.stats[h].hits=num(m.stats[h].hits,0)+1;
        if(outcomes[h]==='MISS')m.stats[h].misses=num(m.stats[h].misses,0)+1;
        if(outcomes[h]==='NEUTRAL')m.stats[h].neutral=num(m.stats[h].neutral,0)+1;
        updated++;
      }
      changed=true;
    }
    const complete=HORIZONS.every(([h])=>Boolean(outcomes[h]));
    if(complete){
      m.history.push({
        prediction_id:pred.prediction_id,
        created_at:pred.created_at,
        resolved_at:at,
        direction:pred.direction,
        strategy:pred.strategy,
        radar:pred.radar||'SIGNAL_SERVICE',
        score:pred.score,
        outcomes,
        returns,
        markout_sources:markoutSources,
        unavailable_horizons:HORIZONS.filter(([h])=>outcomes[h]==='UNAVAILABLE').map(([h])=>h)
      });
      changed=true;
    }else{
      keep.push({...pred,returns,outcomes,markout_sources:markoutSources});
    }
  }
  m.predictions=keep;
  if(changed)await save(store,m);
  return {
    symbol:s,updated,unavailable,
    calibration_score:Number(scoreStats(m.stats).toFixed(1)),
    stats:m.stats,pending:m.predictions.length
  };
}

export async function recordSignalPrediction(store,{symbol,direction,entryPrice,score,strategy,radar,reasonCodes=[],now=Date.now()}={}){
  const s=String(symbol||'').trim().toUpperCase();
  const p=num(entryPrice,null);
  const d=normalizeDirection(direction);
  const at=num(now,null);
  if(!s||p==null||p<=0||!d||at==null||at<=0||!store?.getPredictionCalibration||!store?.putPredictionCalibration)return null;
  const m=await load(store,s);
  const prediction_id=`${s}:${Number(at)}:${m.predictions.length+1}`;
  m.predictions.push({
    prediction_id,symbol:s,direction:d,entry_price:p,score:num(score,50),
    strategy:String(strategy||'UNKNOWN'),
    radar:String(radar||'SIGNAL_SERVICE'),
    reason_codes:arr(reasonCodes).slice(0,12).map(String),
    created_at:Number(at),
    returns:{},outcomes:{},markout_sources:{}
  });
  await save(store,m);
  return {
    prediction_id,
    calibration_score:Number(scoreStats(m.stats).toFixed(1)),
    samples:Object.values(m.stats).reduce((n,x)=>n+num(x.samples,0),0),
    pending:m.predictions.length
  };
}

export async function getPredictionCalibration(store,symbol){
  const s=String(symbol||'').trim().toUpperCase();
  if(!s||!store?.getPredictionCalibration)return null;
  const m=await load(store,s);
  return {
    version:'OUTCOME_CALIBRATION_V2',
    symbol:s,
    score:Number(scoreStats(m.stats).toFixed(1)),
    stats:m.stats,
    pending:m.predictions.length,
    recent_history:m.history.slice(-12).reverse()
  };
}

export function assertCalibrationDirection(direction){
  if(!normalizeDirection(direction))throw new Error('CALIBRATION_DIRECTION_INVALID');
}
