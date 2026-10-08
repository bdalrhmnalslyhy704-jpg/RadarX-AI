const num=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
const arr=v=>Array.isArray(v)?v:[];

const HORIZONS=Object.freeze([
  ['15m',15*60*1000,0.005],
  ['1h',60*60*1000,0.012],
  ['4h',4*60*60*1000,0.025],
  ['24h',24*60*60*1000,0.05]
]);
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

function emptyStats(){return {15m:{samples:0,hits:0,neutral:0},1h:{samples:0,hits:0,neutral:0},4h:{samples:0,hits:0,neutral:0},24h:{samples:0,hits:0,neutral:0}};}

function outcomeFor(direction,ret,target){
  const r=num(ret,null);
  if(r==null)return 'PENDING';
  if(direction==='UP')return r>=target?'HIT':r<=-target*.7?'MISS':'NEUTRAL';
  return r<=-target?'HIT':r>=target*.7?'MISS':'NEUTRAL';
}

function scoreStats(stats){
  const xs=[];
  for(const [h,s] of Object.entries(stats||{})){
    const n=num(s.samples,0),hits=num(s.hits,0);
    if(n>0)xs.push(hits/n);
  }
  return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length*100:50;
}

async function load(store,symbol){
  const raw=await store.getIntelligenceMemory(symbol);
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
  await store.putIntelligenceMemory(m.symbol,slim);
  return slim;
}

export async function updateSignalOutcomes(store,{symbol,price,now=Date.now()}={}){
  const s=String(symbol||'').trim().toUpperCase();
  const p=num(price,null);
  if(!s||p==null||p<=0||!store?.getIntelligenceMemory||!store?.putIntelligenceMemory)return null;
  const m=await load(store,s);
  if(!m.predictions.length)return {symbol:s,updated:0,calibration_score:scoreStats(m.stats),stats:m.stats};
  let updated=0;
  const keep=[];
  for(const pred of m.predictions){
    if(!pred||pred.symbol!==s||num(pred.entry_price,null)==null||!pred.direction){continue;}
    const age=Math.max(0,Number(now)-Number(pred.created_at));
    const returns={...pred.returns};
    const outcomes={...pred.outcomes};
    for(const [h,ms,target] of HORIZONS){
      if(outcomes[h])continue;
      if(age<ms)continue;
      returns[h]=Number(((p/Number(pred.entry_price)-1)*100).toFixed(4));
      outcomes[h]=outcomeFor(pred.direction,returns[h]/100,target);
      if(outcomes[h]!=='PENDING'){
        m.stats[h].samples=num(m.stats[h].samples,0)+1;
        if(outcomes[h]==='HIT')m.stats[h].hits=num(m.stats[h].hits,0)+1;
        if(outcomes[h]==='NEUTRAL')m.stats[h].neutral=num(m.stats[h].neutral,0)+1;
        updated++;
      }
    }
    const complete=HORIZONS.every(([h])=>Boolean(outcomes[h]));
    if(complete){
      m.history.push({
        prediction_id:pred.prediction_id,
        created_at:pred.created_at,
        resolved_at:Number(now),
        direction:pred.direction,
        strategy:pred.strategy,
        score:pred.score,
        outcomes,
        returns
      });
    }else{
      keep.push({...pred,returns,outcomes});
    }
  }
  m.predictions=keep;
  if(updated>0||m.history.length!==((await store.getIntelligenceMemory(s))?.history?.length||0))await save(store,m);
  return {symbol:s,updated,calibration_score:Number(scoreStats(m.stats).toFixed(1)),stats:m.stats,pending:m.predictions.length};
}

export async function recordSignalPrediction(store,{symbol,direction,entryPrice,score,strategy,radar,reasonCodes=[],now=Date.now()}={}){
  const s=String(symbol||'').trim().toUpperCase();
  const p=num(entryPrice,null);
  const d=normalizeDirection(direction);
  if(!s||p==null||p<=0||!d||!store?.getIntelligenceMemory||!store?.putIntelligenceMemory)return null;
  const m=await load(store,s);
  const prediction_id=`${s}:${Number(now)}:${m.predictions.length+1}`;
  m.predictions.push({
    prediction_id,symbol:s,direction:d,entry_price:p,score:num(score,50),
    strategy:String(strategy||'UNKNOWN'),
    radar:String(radar||'SIGNAL_SERVICE'),
    reason_codes:arr(reasonCodes).slice(0,12).map(String),
    created_at:Number(now)||Date.now(),returns:{},outcomes:{}
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
  if(!s||!store?.getIntelligenceMemory)return null;
  const m=await load(store,s);
  return {
    version:'OUTCOME_CALIBRATION_V1',
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
