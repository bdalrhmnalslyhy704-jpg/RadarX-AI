import {buildSpotUniverse,normalizeTickerRow} from '../market/universe-scanner.mjs';
import {decorateRadarAlert} from './radar-alert-meta.mjs';
import {evaluateEliteGate} from './elite-confluence-gate.mjs';

const clamp=(x,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number.isFinite(Number(x))?Number(x):0));
const finite=(x,d=null)=>Number.isFinite(Number(x))?Number(x):d;
const mean=a=>{const x=(Array.isArray(a)?a:[]).map(Number).filter(Number.isFinite);return x.length?x.reduce((s,v)=>s+v,0)/x.length:null;};
const median=a=>{const x=(Array.isArray(a)?a:[]).map(Number).filter(Number.isFinite).sort((p,q)=>p-q);if(!x.length)return null;const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;};
const pct=(a,b)=>Number.isFinite(Number(a))&&Number(b)>0?(Number(a)/Number(b)-1)*100:null;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function closed(rows,now){
  return (Array.isArray(rows)?rows:[]).filter(c=>
    c?.closed!==false &&
    Number.isFinite(Number(c?.openTime)) &&
    Number.isFinite(Number(c?.closeTime)) &&
    Number(c.closeTime)<=now &&
    Number(c.open)>0 && Number(c.high)>=Number(c.low) &&
    Number(c.low)>0 && Number(c.close)>0 && Number(c.volume)>=0
  ).sort((a,b)=>Number(a.openTime)-Number(b.openTime));
}
function returns(rows,n){
  if(rows.length<=n)return null;
  return pct(rows.at(-1).close,rows.at(-(n+1)).close);
}
function trueRanges(rows){
  const out=[];
  for(let i=1;i<rows.length;i++){
    const h=Number(rows[i].high),l=Number(rows[i].low),pc=Number(rows[i-1].close);
    if(h>0&&l>0&&pc>0)out.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  return out;
}
function atr(rows,len=14){
  const tr=trueRanges(rows);
  return tr.length>=len?mean(tr.slice(-len)):null;
}
function ema(values,len){
  const x=values.map(Number).filter(Number.isFinite);
  if(x.length<len)return null;
  const k=2/(len+1);let e=mean(x.slice(0,len));
  for(let i=len;i<x.length;i++)e=x[i]*k+e*(1-k);
  return e;
}
function vwap(rows,len=20){
  const a=rows.slice(-len);let pv=0,v=0;
  for(const c of a){const q=Number(c.quoteVolume??(Number(c.volume)*Number(c.close)));if(Number.isFinite(q)&&q>=0&&Number(c.close)>0){pv+=Number(c.close)*q;v+=q;}}
  return v>0?pv/v:null;
}
function bb(rows,len=20){
  const a=rows.slice(-len).map(c=>Number(c.close)).filter(Number.isFinite);
  if(a.length<len)return null;
  const m=mean(a),sd=Math.sqrt(mean(a.map(x=>(x-m)**2)))||0;
  return {mid:m,upper:m+2*sd,lower:m-2*sd,width:m>0?(4*sd/m*100):null};
}
function donchian(rows,len=20){
  const a=rows.slice(-(len+1),-1);
  if(a.length<len)return null;
  return {high:Math.max(...a.map(c=>Number(c.high))),low:Math.min(...a.map(c=>Number(c.low)))};
}
function closeLocation(rows,len=30){
  const a=rows.slice(-len);if(!a.length)return null;
  const hi=Math.max(...a.map(c=>Number(c.high))),lo=Math.min(...a.map(c=>Number(c.low))),last=Number(a.at(-1).close);
  return hi>lo?(last-lo)/(hi-lo)*100:null;
}
function ratio(current,history){const b=median(history);return Number.isFinite(current)&&Number.isFinite(b)&&b>0?current/b:null;}
function normRatio(v,base=1){return clamp(50+((Number(v)-base)*55));}
function safeSymbol(v){const s=String(v||'').trim().toUpperCase();return /^[A-Z0-9]{5,20}$/.test(s)?s:null;}

export const DOOMSDAY_RADAR_DEFAULTS=Object.freeze({
  quote:'USDT',
  pollMs:15000,
  universeRefreshMs:5*60*1000,
  minQuoteVolume24h:500000,
  deepCandidates:10,
  deepConcurrency:4,
  oneMinuteKlines:120,
  fiveMinuteKlines:80,
  watchlist:['FETUSDT','SCRUSDT','CHIPUSDT','ORCAUSDT','TSTUSDT','GTCUSDT'],
  alertCooldownMs:8*60*1000,
  minEarlyScore:78,
  minIgnitionScore:82,
  minPowerScore:90,
  minVolumeRatio:1.35,
  minTradeRatio:1.25,
  minTakerRatio:0.515,
  minRelativeStrengthPct:0.08,
  max24hMovePct:18,
  breakoutProximityPct:1.5,
  majorMoveCandidatePct:15,
  majorMoveAuditPct:25,
  retryAttempts:1
});

export function buildDoomsdayAnalysis({oneMinute=[],fiveMinute=[],btcFiveMinute=[],ticker={},instantChangePct=0,now=Date.now(),max24hMovePct=18}={}){
  const m1=closed(oneMinute,now),m5=closed(fiveMinute,now),btc=closed(btcFiveMinute,now);
  if(m1.length<60||m5.length<50||btc.length<20)return {eligible:false,stage:'WARMING_UP',score:null,early_score:null,closed_candles_only:true};
  const price=finite(ticker.lastPrice,0);
  if(!(price>0))return {eligible:false,stage:'INVALID_PRICE',score:null,early_score:null,closed_candles_only:true};

  const r1=returns(m1,1),r3=returns(m1,3),r5=returns(m5,1),r10=returns(m1,10);
  const btc5=returns(btc,1);
  const relStrength=Number.isFinite(r5)&&Number.isFinite(btc5)?r5-btc5:null;
  const priorReturns=m1.slice(-31,-1).map((_,i)=>returns(m1.slice(0,m1.length-30+i),1)).filter(Number.isFinite);
  const accelZ=Number.isFinite(r1)&&priorReturns.length>=8
    ? (r1-(mean(priorReturns)||0))/((Math.sqrt(mean(priorReturns.map(x=>(x-(mean(priorReturns)||0))**2)))||0.001))
    : 0;

  const qv=m1.map(c=>Number(c.quoteVolume??(Number(c.volume)*Number(c.close)))).filter(Number.isFinite);
  const tv=m1.map(c=>Number(c.tradeCount)).filter(Number.isFinite);
  const buyRatios=m1.map(c=>{const v=Number(c.volume),b=Number(c.takerBuyBaseVolume);return v>0&&Number.isFinite(b)?b/v:null;}).filter(Number.isFinite);
  const currentQ=qv.at(-1)??0,currentT=tv.at(-1)??0,currentBuy=buyRatios.at(-1)??0.5;
  const volumeRatio=ratio(currentQ,qv.slice(-31,-1))??1;
  const tradeRatio=ratio(currentT,tv.slice(-31,-1))??1;
  const buyBaseline=median(buyRatios.slice(-31,-1))??0.5;
  const buyDelta=currentBuy-buyBaseline;

  const ranges=trueRanges(m1);
  const rangeRatio=ratio(ranges.at(-1),ranges.slice(-31,-1))??1;
  const atrNow=atr(m5,14),atrHist=[];
  for(let i=0;i<20;i++){const end=m5.length-1-i;if(end>=16)atrHist.push(atr(m5.slice(0,end+1),14));}
  const atrRatio=ratio(atrNow,atrHist)??1;

  const closes=m5.map(c=>Number(c.close));
  const e9=ema(closes,9),e21=ema(closes,21);
  const atrBase=atrNow||Math.max(price*0.002,0.00000001);
  const emaSpreadPct=(e9!=null&&e21!=null&&e21>0)?(e9/e21-1)*100:null;
  const emaBurstScore=Number.isFinite(emaSpreadPct)?clamp(50+emaSpreadPct*70):45;

  const vv=vwap(m5,20);
  const vwapDistancePct=vv>0?(price/vv-1)*100:null;
  const vwapScore=Number.isFinite(vwapDistancePct)?clamp(50+vwapDistancePct*60):45;

  const b=bb(m5,20),bbHist=[];
  for(let i=1;i<=20;i++){const end=m5.length-i;if(end>=20){const z=bb(m5.slice(0,end+1),20);if(z?.width!=null)bbHist.push(z.width);}}
  const squeezeBase=median(bbHist);
  const squeezeReleaseRatio=b?.width!=null&&squeezeBase>0?b.width/squeezeBase:null;

  const d=donchian(m5,20);
  const breakoutDistancePct=d?.high>0?(price/d.high-1)*100:null;
  const microBreakout=Boolean(d?.high&&price>d.high);
  const breakoutProximityScore=Number.isFinite(breakoutDistancePct)
    ? microBreakout?100:clamp(100-Math.abs(breakoutDistancePct)*35)
    : 45;

  const location=closeLocation(m5,30);
  const acceptanceScore=Number.isFinite(location)?clamp(location*1.05):45;

  const dailyMove=Math.abs(finite(ticker.priceChange24h,0));
  const extended=Number.isFinite(dailyMove)&&dailyMove>=max24hMovePct;
  const majorMoveAudit=(Number.isFinite(dailyMove)&&dailyMove>=25)||
    (Number.isFinite(dailyMove)&&dailyMove>=max24hMovePct&&((Number.isFinite(r3)&&r3>=3)||(Number.isFinite(r5)&&r5>=2)));
  const volumeScore=normRatio(volumeRatio,1);
  const tradeScore=normRatio(tradeRatio,1);
  const takerScore=clamp(50+(currentBuy-0.5)*420+buyDelta*320);
  const impulseScore=clamp(50+(Number.isFinite(r1)?r1*75:0)+(Number.isFinite(r3)?r3*28:0)+accelZ*8);
  const squeezeScore=squeezeReleaseRatio==null?45:clamp(68+(squeezeReleaseRatio-1)*80);
  const rsScore=Number.isFinite(relStrength)?clamp(50+relStrength*160):45;
  const accelerationScore=clamp(50+accelZ*12+Number(instantChangePct||0)*160);
  const rangeScore=normRatio(rangeRatio,1);
  const atrScore=normRatio(atrRatio,1);
  const closeScore=acceptanceScore;

  const earlyScore=clamp(
    volumeScore*.15+tradeScore*.09+takerScore*.13+breakoutProximityScore*.14+
    emaBurstScore*.10+vwapScore*.08+squeezeScore*.09+rsScore*.09+
    accelerationScore*.09+closeScore*.04
  );
  const ignitionScore=clamp(
    impulseScore*.23+volumeScore*.14+tradeScore*.08+takerScore*.13+
    rangeScore*.07+atrScore*.06+breakoutProximityScore*.11+emaBurstScore*.05+
    vwapScore*.04+squeezeScore*.03+rsScore*.06
  );
  const score=clamp(Math.max(earlyScore,ignitionScore));

  const earlyEvidence=[
    volumeRatio>=1.25,
    tradeRatio>=1.15,
    currentBuy>=0.51,
    breakoutProximityScore>=82,
    Number.isFinite(emaSpreadPct)&&emaSpreadPct>=0.05,
    Number.isFinite(vwapDistancePct)&&vwapDistancePct>=0,
    Number.isFinite(squeezeReleaseRatio)&&squeezeReleaseRatio>=1.02,
    Number.isFinite(relStrength)&&relStrength>=0.02,
    accelerationScore>=60
  ].filter(Boolean).length;

  const ignitionEvidence=[
    Number.isFinite(r3)&&r3>=0.45,
    Number.isFinite(volumeRatio)&&volumeRatio>=1.50,
    Number.isFinite(tradeRatio)&&tradeRatio>=1.35,
    currentBuy>=0.515,
    microBreakout,
    Number.isFinite(rangeRatio)&&rangeRatio>=1.30,
    Number.isFinite(atrRatio)&&atrRatio>=1.08,
    Number.isFinite(r5)&&r5>=0.35
  ].filter(Boolean).length;

  const earlyTrigger=!extended&&earlyScore>=DOOMSDAY_RADAR_DEFAULTS.minEarlyScore &&
    volumeRatio>=DOOMSDAY_RADAR_DEFAULTS.minVolumeRatio &&
    tradeRatio>=DOOMSDAY_RADAR_DEFAULTS.minTradeRatio &&
    currentBuy>=DOOMSDAY_RADAR_DEFAULTS.minTakerRatio &&
    earlyEvidence>=5 &&
    (breakoutProximityScore>=78||accelerationScore>=68||Number(instantChangePct)>0.18);

  const ignitionTrigger=!extended&&ignitionScore>=DOOMSDAY_RADAR_DEFAULTS.minIgnitionScore &&
    ignitionEvidence>=4 &&
    ((Number.isFinite(r3)&&r3>=0.45)||microBreakout||volumeRatio>=2);

  const eligible=earlyTrigger||ignitionTrigger;
  const stage=majorMoveAudit?'MAJOR_MOVE_AUDIT':!eligible?'WATCH':ignitionScore>=DOOMSDAY_RADAR_DEFAULTS.minPowerScore?'POWER_SURGE':ignitionTrigger?'IGNITION':'PRE_BREAKOUT';
  const reasons=[];
  const push=(ok,s)=>{if(ok)reasons.push(s)};
  push(volumeRatio>=1.35,'تسارع الحجم مقارنة بخط العملة');
  push(tradeRatio>=1.25,'تسارع عدد الصفقات');
  push(currentBuy>=0.515,'تفوق تدفق الشراء taker');
  push(buyDelta>=0.01,'زيادة حديثة في نسبة شراء taker');
  push(Number.isFinite(r3)&&r3>=0.45,'اندفاع 3 دقائق');
  push(Number.isFinite(r5)&&r5>=0.35,'اندفاع 5 دقائق');
  push(microBreakout,'اختراق قمة النطاق القصير');
  push(Number.isFinite(breakoutDistancePct)&&breakoutDistancePct>-1.5&&breakoutDistancePct<0,'اقتراب قوي من مقاومة قصيرة');
  push(Number.isFinite(emaSpreadPct)&&emaSpreadPct>=0.05,'تحول EMA9 فوق EMA21');
  push(Number.isFinite(vwapDistancePct)&&vwapDistancePct>=0.05,'استعادة/ابتعاد عن VWAP');
  push(Number.isFinite(squeezeReleaseRatio)&&squeezeReleaseRatio>=1.02,'تحرر من الانكماش');
  push(Number.isFinite(relStrength)&&relStrength>=0.08,'قوة نسبية مقابل BTC');
  push(Number.isFinite(rangeRatio)&&rangeRatio>=1.3,'اتساع النطاق');
  push(Number.isFinite(atrRatio)&&atrRatio>=1.08,'انتقال ATR إلى نظام أعلى');
  push(accelerationScore>=65,'تسارع فوري فوق خط الأساس');
  if(extended)reasons.push('الحركة اليومية ممتدة — لا تُعامل كإشارة دخول مبكرة');
  if(majorMoveAudit)reasons.push('تدقيق مستقل: الحركة الكبيرة دخلت سوق المراقبة حتى بعد تجاوز بوابة ما قبل الانفجار');

  return {
    eligible,major_move_audit:majorMoveAudit,stage,score:Number(score.toFixed(1)),early_score:Number(earlyScore.toFixed(1)),ignition_score:Number(ignitionScore.toFixed(1)),
    direction:ignitionScore>=earlyScore?'UP':'WATCH',closed_candles_only:true,
    confirmation_count:earlyEvidence,ignition_confirmations:ignitionEvidence,confirmation_total:9,
    metrics:{
      return_1m:r1,return_3m:r3,return_5m:r5,return_10m:r10,btc_5m_return:btc5,relative_strength_pct:relStrength,
      acceleration_z:accelZ,instant_change_pct:Number(instantChangePct||0),
      volume_ratio:volumeRatio,trade_ratio:tradeRatio,taker_buy_ratio:currentBuy,taker_buy_delta:buyDelta,
      range_ratio:rangeRatio,atr_ratio:atrRatio,ema9:e9,ema21:e21,ema_spread_pct:emaSpreadPct,
      vwap:vv,vwap_distance_pct:vwapDistancePct,bb_width:b?.width??null,squeeze_release_ratio:squeezeReleaseRatio,
      breakout_distance_pct:breakoutDistancePct,micro_breakout:microBreakout,close_location_pct:location,
      volume_score:volumeScore,trade_score:tradeScore,taker_score:takerScore
    },
    component_scores:{
      impulse:impulseScore,volume:volumeScore,trades:tradeScore,taker:takerScore,breakout:breakoutProximityScore,
      ema:emaBurstScore,vwap:vwapScore,squeeze:squeezeScore,relative_strength:rsScore,
      acceleration:accelerationScore,range:rangeScore,atr:atrScore,acceptance:closeScore
    },
    triggers:{
      min_early_score:DOOMSDAY_RADAR_DEFAULTS.minEarlyScore,min_ignition_score:DOOMSDAY_RADAR_DEFAULTS.minIgnitionScore,
      min_volume_ratio:DOOMSDAY_RADAR_DEFAULTS.minVolumeRatio,min_trade_ratio:DOOMSDAY_RADAR_DEFAULTS.minTradeRatio,
      min_taker_ratio:DOOMSDAY_RADAR_DEFAULTS.minTakerRatio,min_relative_strength_pct:DOOMSDAY_RADAR_DEFAULTS.minRelativeStrengthPct,
      breakout_proximity_pct:DOOMSDAY_RADAR_DEFAULTS.breakoutProximityPct,max_24h_move_pct:max24hMovePct
    },
    reasons:[...new Set(reasons)].slice(0,15),
    source:'Binance Public REST',detected_at:now,processed_at:now,
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
  };
}

function buildAlert(candidate,analysis,now){
  const symbol=String(candidate.symbol).toUpperCase();
  return {
    id:'DOOMSDAY:'+symbol+':'+now,
    event:analysis.stage==='MAJOR_MOVE_AUDIT'?'DOOMSDAY_MAJOR_MOVE_AUDIT':analysis.stage==='PRE_BREAKOUT'?'DOOMSDAY_EARLY_WARNING':analysis.stage==='IGNITION'?'DOOMSDAY_IGNITION':'DOOMSDAY_POWER_SURGE',
    radar:'DOOMSDAY_RADAR',
    radar_name:'Radar 6 — يوم القيامة',
    symbol,market:'SPOT',direction:'UP_MOVE',
    price:finite(candidate.lastPrice),price_change_24h:finite(candidate.priceChange24h),
    opportunity_score:analysis.score,potential_label:analysis.stage,
    doomsday:analysis,reasons:analysis.reasons,
    risk_flags:[
      Math.abs(finite(candidate.priceChange24h,0))>=12?'DAILY_EXTENSION_ATTENTION':null,
      analysis.major_move_audit?'MAJOR_MOVE_AUDIT_NO_EARLY_ENTRY':null,
      analysis.metrics.taker_buy_ratio<0.50?'TAKER_BALANCE_WEAK':null,
      analysis.component_scores.relative_strength<45?'BTC_RELATIVE_STRENGTH_WEAK':null
    ].filter(Boolean),
    source:analysis.source,detected_at:now,processed_at:now,
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
    eligible:Boolean(analysis.eligible),
    audit_only:Boolean(analysis.major_move_audit),
    disclaimer:'رادار يوم القيامة يلتقط بصمة توسع/استيقاظ قصيرة المدى؛ لا يضمن استمرار السعر، وكل الإشارات ورقية فقط.'
  };
}

function discoveryScore(row,instantChangePct){
  const move=Math.abs(Number(row.priceChange24h)||0);
  const quiet=move<=3?72:clamp(80-move*3);
  const burst=clamp(50+Number(instantChangePct||0)*220);
  const volume=clamp(Math.log10(Math.max(1,row.quoteVolume24h/500000))*18+55);
  return quiet*.35+burst*.40+volume*.25;
}

export class DoomsdayRadar{
  constructor({rest,store,pushManager=null,config={},clock=()=>Date.now(),sleepFn=sleep,logger=console}={}){
    if(!rest)throw new Error('REST_CLIENT_REQUIRED');
    if(!store)throw new Error('STORE_REQUIRED');
    this.rest=rest;this.store=store;this.pushManager=pushManager;this.config={...DOOMSDAY_RADAR_DEFAULTS,...config};
    this.clock=clock;this.sleepFn=sleepFn;this.logger=logger;
    this.running=false;this.busy=false;this.timer=null;this.universe=[];this.universeAt=0;
    this.lastPrices=new Map();this.lastAlertAt=new Map();this.latestCandidates=[];
    this.lastScanAtMs=null;this.lastError=null;this.scans=0;this.alertCount=0;
  }
  start(){
    if(this.running)return;
    this.running=true;this.lastError=null;
    this.refreshUniverse().then(()=>this.tick()).catch(e=>this.noteError(e,'bootstrap'));
    this.timer=setInterval(()=>this.tick().catch(e=>this.noteError(e,'tick')),this.config.pollMs);
  }
  async stop(){this.running=false;if(this.timer)clearInterval(this.timer);this.timer=null;}
  noteError(e,where='scan'){this.lastError=String(e?.message??e);this.logger.warn?.('DOOMSDAY_RADAR_'+where,this.lastError);}
  async refreshUniverse(){
    const r=await this.rest.request('/api/v3/exchangeInfo');
    this.universe=buildSpotUniverse(r.data,this.config.quote).map(x=>x.symbol);
    this.universeAt=this.clock();
  }
  async tickerRows(){
    const r=await this.rest.request('/api/v3/ticker/24hr');
    return (Array.isArray(r.data)?r.data:[])
      .map(x=>normalizeTickerRow(x,this.config.quote)).filter(Boolean)
      .filter(x=>(x.quoteVolume24h>=this.config.minQuoteVolume24h || Math.max(0,Number(x.priceChange24h)||0)>=Number(this.config.majorMoveCandidatePct||15))&&this.universe.includes(x.symbol));
  }
  selectCandidates(rows){
    const updates=[];
    for(const row of rows){
      const prev=this.lastPrices.get(row.symbol);
      const instantChangePct=prev?.price>0?(row.lastPrice/prev.price-1)*100:0;
      updates.push({...row,instantChangePct});
      this.lastPrices.set(row.symbol,{price:row.lastPrice,at:this.clock()});
    }
    const watchSet=new Set((this.config.watchlist||[]).map(s=>String(s).toUpperCase()));
    const watch=updates.filter(x=>watchSet.has(x.symbol));
    const major=updates.filter(x=>Math.max(0,Number(x.priceChange24h)||0)>=Number(this.config.majorMoveCandidatePct||15))
      .sort((a,b)=>Number(b.priceChange24h||0)-Number(a.priceChange24h||0)).slice(0,4);
    const ranked=[...updates].sort((a,b)=>discoveryScore(b,b.instantChangePct)-discoveryScore(a,a.instantChangePct));
    const merged=[...watch,...major,...ranked].filter((x,i,a)=>a.findIndex(y=>y.symbol===x.symbol)===i);
    return merged.slice(0,Math.max(Number(this.config.deepCandidates)||10,watch.length,major.length));
  }
  async deepScan(row,btcFiveMinute){
    const [one,five]=await Promise.all([
      this.rest.klines(row.symbol,'1m',{limit:this.config.oneMinuteKlines}),
      this.rest.klines(row.symbol,'5m',{limit:this.config.fiveMinuteKlines})
    ]);
    const analysis=buildDoomsdayAnalysis({oneMinute:one.candles,fiveMinute:five.candles,btcFiveMinute,ticker:row,instantChangePct:row.instantChangePct,now:this.clock(),max24hMovePct:this.config.max24hMovePct});
    this.scans++;
    const cs=analysis.component_scores||{};
    const gate=evaluateEliteGate({
      radar:'DOOMSDAY_RADAR',
      direction:analysis.direction||'UP',
      baseScore:analysis.score,
      priceChange24h:row.priceChange24h,
      liquidityScore:Math.min(100,60+Math.log10(Math.max(1,row.quoteVolume24h/500000))*32),
      dataQualityScore:90,
      triggerScore:Math.max(Number(cs.acceleration)||0,Number(cs.breakout)||0,Number(cs.impulse)||0),
      structureScore:Math.max(Number(cs.breakout)||0,Number(cs.ema)||0,Number(cs.acceptance)||0),
      participationScore:Math.max(Number(cs.volume)||0,Number(cs.trades)||0),
      flowScore:Number(cs.taker)||50,
      relativeScore:Number(cs.relative_strength)||50,
      momentumScore:Math.max(Number(cs.impulse)||0,Number(cs.acceleration)||0),
      compressionScore:Math.max(Number(cs.squeeze)||0,Number(cs.atr)||0),
      confirmations:Math.max(Number(analysis.confirmation_count)||0,Number(analysis.ignition_confirmations)||0),
      minConfirmations:analysis.stage==='POWER_SURGE'?7:6,
      minScore:analysis.stage==='POWER_SURGE'?93:analysis.stage==='IGNITION'?89:84,
      max24hMovePct:analysis.stage==='PRE_BREAKOUT'?5:10,
      requireTrigger:true,
      minCategoryHits:5
    });
    analysis.elite_gate=gate;
    if((analysis.eligible&&gate.eligible)||analysis.major_move_audit){
      const last=this.lastAlertAt.get(row.symbol)||0;
      if(this.clock()-last>=this.config.alertCooldownMs){
        const alert=decorateRadarAlert(buildAlert(row,analysis,this.clock()),'Radar 6 — يوم القيامة');
        await this.store.appendDoomsdayAlert(alert);
        if(this.pushManager?.notifyRadarAlert)await this.pushManager.notifyRadarAlert(alert);
        this.lastAlertAt.set(row.symbol,this.clock());this.alertCount++;
      }
    }
    return {symbol:row.symbol,lastPrice:row.lastPrice,priceChange24h:row.priceChange24h,instantChangePct:row.instantChangePct,stage:analysis.stage,score:analysis.score,early_score:analysis.early_score,ignition_score:analysis.ignition_score,eligible:analysis.eligible,analysis};
  }
  async tick({forcedSymbols=[]}={}){
    if(!this.running||this.busy)return false;
    this.busy=true;
    try{
      if(this.clock()-this.universeAt>this.config.universeRefreshMs)await this.refreshUniverse();
      const rows=await this.tickerRows();
      const selected=this.selectCandidates(rows);
      const forcedSet=new Set((Array.isArray(forcedSymbols)?forcedSymbols:[]).map(s=>String(s).toUpperCase()).filter(Boolean));
      const selectedForced=rows.filter(x=>forcedSet.has(x.symbol));
      const merged=[...selectedForced,...selected].filter((x,i,a)=>a.findIndex(y=>y.symbol===x.symbol)===i)
        .slice(0,Math.max(Number(this.config.deepCandidates)||10,(forcedSet.size||0)));
      const btcRow=rows.find(x=>x.symbol==='BTCUSDT');
      let btcFive=null;
      if(btcRow){
        const r=await this.rest.klines('BTCUSDT','5m',{limit:this.config.fiveMinuteKlines});
        btcFive=r.candles;
      }
      const out=new Array(merged.length);let next=0;
      const width=Math.max(1,Math.min(12,Number(this.config.deepConcurrency)||4));
      const worker=async()=>{while(true){const i=next++;if(i>=merged.length)return;try{out[i]=await this.deepScan(merged[i],btcFive||[]);}catch(e){this.noteError(e,'row');}}};
      await Promise.all(Array.from({length:Math.min(width,merged.length||1)},worker));
      this.latestCandidates=out.filter(x=>x?.analysis?.major_move_audit || (x?.eligible&&x?.analysis?.elite_gate?.eligible))
        .sort((a,b)=>Number(Boolean(b?.analysis?.major_move_audit))-Number(Boolean(a?.analysis?.major_move_audit)) || Number(b.analysis?.score||0)-Number(a.analysis?.score||0) || Number(b.analysis?.elite_gate?.score||0)-Number(a.analysis?.elite_gate?.score||0)).slice(0,5);
      this.lastScanAtMs=this.clock();this.lastError=null;
      return true;
    }finally{this.busy=false;}
  }
  async scanSymbols(symbols=[]){
    const forced=(Array.isArray(symbols)?symbols:[]).map(s=>safeSymbol(s)).filter(Boolean);
    if(!forced.length)throw new Error('NO_VALID_SYMBOLS');
    const wasRunning=this.running;
    if(!wasRunning)this.running=true;
    try{return await this.tick({forcedSymbols:forced});}finally{if(!wasRunning)this.running=false;}
  }
  snapshot(limit=20){
    return {radar:'DOOMSDAY_RADAR',radar_name:'Radar 6 — يوم القيامة',as_of:this.lastScanAtMs?new Date(this.lastScanAtMs).toISOString():null,
      universe:{eligible_spot_symbols:this.universe.length,scanned:this.latestCandidates.length,deep_scanned:this.scans},
      candidates:(this.latestCandidates||[]).slice(0,Math.max(1,Math.min(50,Number(limit)||20))),
      monitoring:this.health(),meta:{live:this.running,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'},
      watchlist:this.config.watchlist||[]};
  }
  health(){
    return {running:this.running,busy:this.busy,radar:'DOOMSDAY_RADAR',radar_name:'Radar 6 — يوم القيامة',universe:this.universe.length,
      last_universe_refresh_at:this.universeAt||null,last_scan_at:this.lastScanAtMs,scans:this.scans,alerts_emitted:this.alertCount,last_error:this.lastError,
      algorithms:['1m/3m/5m Momentum','Acceleration vs Self Baseline','Relative Volume','Trade Count Surge','Taker Flow','Squeeze Release','Donchian Breakout','EMA9/21 Burst','VWAP Reclaim','ATR Expansion','Relative Strength vs BTC','Range Acceptance'],
      source:'Binance Public REST',closed_candles_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'};
  }
}
