import {buildSpotUniverse,normalizeTickerRow} from '../market/universe-scanner.mjs';
import {formatRadarTime12h} from './radar-alert-meta.mjs';
import {evaluateEliteGate} from './elite-confluence-gate.mjs';

const clamp=(x,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number(x)||0));
const finite=(x,d=null)=>Number.isFinite(Number(x))?Number(x):d;
const mean=xs=>{const a=xs.filter(Number.isFinite);return a.length?a.reduce((s,x)=>s+x,0)/a.length:null};
const median=xs=>{const a=xs.filter(Number.isFinite).sort((a,b)=>a-b);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2};
const std=xs=>{const a=xs.filter(Number.isFinite);if(a.length<2)return null;const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)))};
const pct=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&a!==0?(b/a-1)*100:null;
const closed=(rows,now)=> (Array.isArray(rows)?rows:[]).filter(c=>
  c?.closed!==false &&
  Number.isFinite(Number(c?.openTime)) &&
  Number.isFinite(Number(c?.closeTime)) &&
  Number(c.closeTime)<=now &&
  Number(c.open)>0 && Number(c.high)>=Number(c.low) &&
  Number(c.low)>0 && Number(c.close)>0 &&
  Number(c.volume)>=0
).sort((a,b)=>Number(a.openTime)-Number(b.openTime));

function returns(rows){
  const out=[];
  for(let i=1;i<rows.length;i++){
    const a=Number(rows[i-1].close),b=Number(rows[i].close);
    if(a>0&&b>0)out.push((b/a-1)*100);
  }
  return out;
}
function zscore(value,history){
  const m=mean(history),s=std(history);
  if(!Number.isFinite(value)||!Number.isFinite(m)||!Number.isFinite(s)||s<=0)return 0;
  return (value-m)/s;
}
function ratio(value,history){
  const base=median(history);
  return Number.isFinite(value)&&Number.isFinite(base)&&base>0?value/base:null;
}
function atr(rows,len=14){
  if(rows.length<len+1)return null;
  const trs=[];
  for(let i=1;i<rows.length;i++){
    const h=Number(rows[i].high),l=Number(rows[i].low),pc=Number(rows[i-1].close);
    trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  return mean(trs.slice(-len));
}
function efficiency(rows,len=8){
  if(rows.length<len+1)return null;
  const slice=rows.slice(-(len+1));
  const net=Math.abs(Number(slice.at(-1).close)-Number(slice[0].close));
  let path=0;
  for(let i=1;i<slice.length;i++)path+=Math.abs(Number(slice[i].close)-Number(slice[i-1].close));
  return path>0?net/path:null;
}
function closeLocation(rows,len=24){
  const a=rows.slice(-len);
  if(!a.length)return null;
  const hi=Math.max(...a.map(x=>Number(x.high))),lo=Math.min(...a.map(x=>Number(x.low))),last=Number(a.at(-1).close);
  return hi>lo?(last-lo)/(hi-lo)*100:null;
}
function followThrough(rows){
  const a=rows.slice(-6);
  if(a.length<6)return 0;
  const ups=a.filter(x=>Number(x.close)>Number(x.open)).length;
  const net=pct(Number(a[0].open),Number(a.at(-1).close))||0;
  const ranges=a.map(x=>Math.abs(pct(Number(x.open),Number(x.close))||0));
  const avgR=mean(ranges)||0;
  const persistence=clamp(50+net*18+ups*7-(avgR>1.2?8:0));
  return persistence;
}

export const KAHIR_RADAR_DEFAULTS=Object.freeze({
  quote:'USDT',
  pollMs:30000,
  universeRefreshMs:5*60*1000,
  minQuoteVolume24h:500000,
  baselineHistory:8,
  deepCandidates:14,
  deepRotationReserve:2,
  deepConcurrency:4,
  deepOneMinuteKlines:150,
  deepFiveMinuteKlines:100,
  alertCooldownMs:20*60*1000,
  minScore:84,
  minOneMinuteZ:1.8,
  minFiveMinuteZ:1.6,
  minVolumeRatio:1.35,
  minEfficiency:0.52,
  minRelativeAccelerationBps:1.5,
  maxAbs24hMovePct:15
});

export function buildKahirAnalysis({oneMinute=[],fiveMinute=[],ticker={},selfHistory=[],marketVelocityBps=0,now=Date.now()}={}){
  const m1=closed(oneMinute,now),m5=closed(fiveMinute,now);
  if(m1.length<80||m5.length<50)return {eligible:false,stage:'WARMING_UP',score:null,closed_candles_only:true};
  const price=finite(ticker.lastPrice,0);
  if(!(price>0))return {eligible:false,stage:'INVALID_PRICE',score:null,closed_candles_only:true};

  const r1=returns(m1),r5=returns(m5);
  const current1=r1.at(-1)??0,current5=r5.at(-1)??0;
  const baseline1=r1.slice(-61,-1),baseline5=r5.slice(-41,-1);
  const z1=zscore(current1,baseline1),z5=zscore(current5,baseline5);

  const recentVol=Number(m1.at(-1)?.quoteVolume ?? m1.at(-1)?.volume*price ?? 0);
  const volHistory=m1.slice(-41,-1).map(x=>Number(x.quoteVolume ?? x.volume*price));
  const volumeRatio=ratio(recentVol,volHistory) ?? 0;

  const recentTrades=Number(m1.at(-1)?.tradeCount ?? 0);
  const tradeHistory=m1.slice(-41,-1).map(x=>Number(x.tradeCount ?? 0));
  const tradeRatio=ratio(recentTrades,tradeHistory) ?? 0;

  const atrNow=atr(m5,14);
  const atrBase=m5.slice(-41,-14).map((_,i)=>atr(m5.slice(0,m5.length-27+i),14)).filter(Number.isFinite);
  const atrRatio=ratio(atrNow,atrBase) ?? 1;

  const eff=efficiency(m5,8) ?? 0;
  const acceptance=closeLocation(m5,24) ?? 50;
  const persistence=followThrough(m5);

  const prevSelf=selfHistory.at(-1);
  const currentSelfReturn=prevSelf?.price>0?((price/prevSelf.price)-1)*100:0;
  const previousSelfReturn=selfHistory.at(-2)?.price>0&&prevSelf?.price>0?((prevSelf.price/selfHistory.at(-2).price)-1)*100:0;
  const selfAccelerationPct=currentSelfReturn-previousSelfReturn;
  const relativeAccelerationBps=selfAccelerationPct*100-(finite(marketVelocityBps,0));

  const participationScore=clamp(50+(volumeRatio-1)*28+(tradeRatio-1)*22);
  const impulseScore=clamp(50+z1*15+z5*18);
  const volatilityShiftScore=clamp(48+(atrRatio-1)*65);
  const efficiencyScore=clamp(35+eff*90);
  const acceptanceScore=clamp(acceptance>=65?55+(acceptance-65)*1.5:acceptance>=50?45+(acceptance-50)*.7:35);
  const persistenceScore=persistence;
  const selfAccelerationScore=clamp(50+relativeAccelerationBps*5);

  const direction=(current5>=0&&current1>=0)||(z5>0.8&&z1>0.8)?'UP':'DOWN';
  const extended=Math.abs(Number(ticker.priceChange24h)||0)>=KAHIR_RADAR_DEFAULTS.maxAbs24hMovePct;
  const score=clamp(
    impulseScore*.24+
    participationScore*.19+
    volatilityShiftScore*.14+
    efficiencyScore*.13+
    acceptanceScore*.10+
    persistenceScore*.10+
    selfAccelerationScore*.10
  );

  const eligible=direction==='UP'&&!extended&&
    score>=KAHIR_RADAR_DEFAULTS.minScore&&
    (z1>=KAHIR_RADAR_DEFAULTS.minOneMinuteZ||z5>=KAHIR_RADAR_DEFAULTS.minFiveMinuteZ)&&
    volumeRatio>=KAHIR_RADAR_DEFAULTS.minVolumeRatio&&
    eff>=KAHIR_RADAR_DEFAULTS.minEfficiency&&
    relativeAccelerationBps>=KAHIR_RADAR_DEFAULTS.minRelativeAccelerationBps;

  const stage=eligible?(score>=92?'POWER_SURGE':'IGNITION'):score>=76?'BUILDING_PRESSURE':'WATCH';
  const confirmations=[
    z1>=KAHIR_RADAR_DEFAULTS.minOneMinuteZ,
    z5>=KAHIR_RADAR_DEFAULTS.minFiveMinuteZ,
    volumeRatio>=KAHIR_RADAR_DEFAULTS.minVolumeRatio,
    tradeRatio>=1.2,
    atrRatio>=1.08,
    eff>=KAHIR_RADAR_DEFAULTS.minEfficiency,
    acceptance>=65,
    persistence>=68,
    relativeAccelerationBps>=KAHIR_RADAR_DEFAULTS.minRelativeAccelerationBps
  ].filter(Boolean);

  const reasons=[];
  const push=(ok,s)=>{if(ok)reasons.push(s)};
  push(z1>=1.8,'صدمـة عائد ذاتية 1m أعلى من خطها المعتاد');
  push(z5>=1.6,'تسارع 5m غير اعتيادي للعملة نفسها');
  push(volumeRatio>=1.35,'المشاركة الحجمية ترتفع فوق خط العملة');
  push(tradeRatio>=1.2,'عدد الصفقات يتسارع');
  push(atrRatio>=1.08,'انتقال من هدوء إلى نظام تذبذب أعلى');
  push(eff>=.52,'كفاءة الحركة مرتفعة وليست تذبذبًا عشوائيًا');
  push(acceptance>=65,'الإغلاق مقبول قرب أعلى نطاقه');
  push(persistence>=68,'استمرارية الدفع عبر الشموع');
  push(relativeAccelerationBps>=1.5,'تسارع العملة يتفوق على سرعة السوق');
  if(extended)reasons.push('رفض: الحركة اليومية ممتدة');

  return {
    eligible,stage,score:Math.round(score*10)/10,closed_candles_only:true,
    confirmation_count:confirmations.length,confirmation_total:9,direction,
    algorithms:{
      SELF_BASELINE_Z:{one_minute_z:z1,five_minute_z:z5,self_acceleration_pct:selfAccelerationPct,relative_acceleration_bps:relativeAccelerationBps},
      PARTICIPATION_REGIME:{volume_ratio:volumeRatio,trade_ratio:tradeRatio,score:participationScore},
      VOLATILITY_REGIME_TRANSITION:{atr_ratio:atrRatio,score:volatilityShiftScore},
      KAUFMAN_EFFICIENCY_SHIFT:{efficiency:eff,score:efficiencyScore},
      RANGE_ACCEPTANCE:{close_location_pct:acceptance,score:acceptanceScore},
      IMPULSE_PERSISTENCE:{score:persistenceScore},
      MARKET_SPEED_SPREAD:{market_velocity_bps:marketVelocityBps,coin_velocity_bps:currentSelfReturn*100,relative_acceleration_bps:relativeAccelerationBps}
    },
    metrics:{
      one_minute_return_pct:current1,five_minute_return_pct:current5,one_minute_z:z1,five_minute_z:z5,
      volume_ratio:volumeRatio,trade_ratio:tradeRatio,atr_ratio:atrRatio,efficiency:eff,
      range_acceptance_pct:acceptance,persistence_score:persistenceScore,
      self_acceleration_pct:selfAccelerationPct,relative_acceleration_bps:relativeAccelerationBps,
      market_velocity_bps:marketVelocityBps
    },
    reasons:[...new Set(reasons)].slice(0,10),
    trigger:{
      min_score:KAHIR_RADAR_DEFAULTS.minScore,
      min_1m_z:KAHIR_RADAR_DEFAULTS.minOneMinuteZ,
      min_5m_z:KAHIR_RADAR_DEFAULTS.minFiveMinuteZ,
      min_volume_ratio:KAHIR_RADAR_DEFAULTS.minVolumeRatio,
      min_efficiency:KAHIR_RADAR_DEFAULTS.minEfficiency,
      min_relative_acceleration_bps:KAHIR_RADAR_DEFAULTS.minRelativeAccelerationBps,
      max_abs_24h_move_pct:KAHIR_RADAR_DEFAULTS.maxAbs24hMovePct
    },
    source:'Binance Public REST',detected_at:now,processed_at:now,
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
  };
}

function buildKahirAlert(candidate,analysis,now=Date.now()){
  return {
    id:'KAHIR:'+String(candidate.symbol).toUpperCase()+':'+now,
    event:'KAHIR_POWER_MOVE',
    radar:'KAHIR_RADAR',
    radar_name:'Radar 5 — القاهر',
    symbol:String(candidate.symbol).toUpperCase(),
    market:'SPOT',
    direction:'UP_MOVE',
    price:finite(candidate.lastPrice),
    price_change_24h:finite(candidate.priceChange24h),
    opportunity_score:analysis.score,
    potential_label:analysis.stage,
    kahir_analysis:analysis,
    self_change_pct:finite(candidate.selfChangePct),
    self_velocity_bps:finite(candidate.velocityBps),
    market_velocity_bps:finite(candidate.marketVelocityBps),
    relative_velocity_bps:finite(candidate.relativeVelocityBps),
    reasons:analysis.reasons,
    risk_flags:Math.abs(Number(candidate.priceChange24h)||0)>=10?['DAILY_EXTENSION_ATTENTION']:[],
    source:'Binance Public REST',detected_at:now,processed_at:now,
    detected_at_iso:new Date(now).toISOString(),detected_time_12h:formatRadarTime12h(now),
    detected_timezone:'Asia/Aden',
    paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
    eligible:true,
    disclaimer:'القاهر يرصد تغيرًا غير اعتيادي في سلوك العملة ويجمع عوامل تأكيد؛ ليس ضمانًا لارتفاع مستقبلي ولا إشارة تنفيذ.'
  };
}

export class KahirRadar{
  constructor({rest,store,pushManager=null,config={},clock=()=>Date.now(),logger=console}={}){
    if(!rest)throw new Error('REST_CLIENT_REQUIRED');
    if(!store)throw new Error('STORE_REQUIRED');
    this.rest=rest;this.store=store;this.pushManager=pushManager;this.clock=clock;this.logger=logger;
    this.config={...KAHIR_RADAR_DEFAULTS,...config};
    this.running=false;this.timer=null;this.universe=[];this.universeAt=0;this.busy=false;
    this.lastScanAtMs=null;this.lastError=null;this.scans=0;this.alertCount=0;
    this.latestCandidates=[];this.selfSnapshots=new Map();this.lastMarketVelocityBps=0;this.deepCursor=0;
    this.lastResult=null;this.lastAlertAt=new Map();
  }

  start(){
    if(this.running)return;
    this.running=true;this.lastError=null;
    this.refreshUniverse().then(()=>this.tick()).catch(e=>this.noteError(e,'bootstrap'));
    this.timer=setInterval(()=>this.tick().catch(e=>this.noteError(e,'tick')),this.config.pollMs);
  }
  async stop(){this.running=false;if(this.timer)clearInterval(this.timer);this.timer=null;}
  noteError(e,where='scan'){this.lastError=String(e?.message??e);this.logger.warn?.('KAHIR_RADAR_'+where,this.lastError);}
  async refreshUniverse(){
    const r=await this.rest.request('/api/v3/exchangeInfo');
    this.universe=buildSpotUniverse(r.data,this.config.quote).map(x=>x.symbol);
    this.universeAt=this.clock();
  }
  async tickerRows(){
    const r=await this.rest.request('/api/v3/ticker/24hr');
    return (Array.isArray(r.data)?r.data:[])
      .map(x=>normalizeTickerRow(x,this.config.quote)).filter(Boolean)
      .filter(x=>this.universe.includes(x.symbol))
      .filter(x=>x.quoteVolume24h>=this.config.minQuoteVolume24h);
  }
  snapshotTicker(row){
    return {price:finite(row.lastPrice,0),velocity_bps:0,at:this.clock()};
  }
  buildDiscovery(rows){
    const velocities=[];
    const updates=[];
    for(const row of rows){
      const history=this.selfSnapshots.get(row.symbol)||[];
      const prev=history.at(-1);
      const price=finite(row.lastPrice,0);
      const selfChangePct=prev?.price>0?((price/prev.price)-1)*100:0;
      const velocityBps=selfChangePct*100;
      velocities.push(velocityBps);
      updates.push({symbol:row.symbol,price,selfChangePct,velocityBps,at:this.clock()});
    }
    const marketVelocityBps=median(velocities)??0;
    this.lastMarketVelocityBps=marketVelocityBps;
    for(const u of updates){
      const h=this.selfSnapshots.get(u.symbol)||[];
      h.push(u);
      while(h.length>this.config.baselineHistory)h.shift();
      this.selfSnapshots.set(u.symbol,h);
      u.marketVelocityBps=marketVelocityBps;
      u.relativeVelocityBps=u.velocityBps-marketVelocityBps;
    }
    return {marketVelocityBps,updates};
  }
  selectDeep(rows,updates){
    const bySym=new Map(updates.map(x=>[x.symbol,x]));
    const ranked=[...rows].map(row=>{
      const u=bySym.get(row.symbol)||{};
      const history=this.selfSnapshots.get(row.symbol)||[];
      const accel=u.relativeVelocityBps+(finite(u.selfChangePct,0)-finite(history.at(-2)?.selfChangePct,0))*100;
      const activity=Math.log10(Math.max(1,row.quoteVolume24h/this.config.minQuoteVolume24h))*12+
        Math.max(0,u.relativeVelocityBps)*1.8+
        Math.max(0,row.priceChange24h)*0.35;
      return {...row,_kahir:u,_activityScore:activity,_accelerationScore:accel};
    }).sort((a,b)=>b._activityScore-a._activityScore||b._accelerationScore-a._accelerationScore);
    const target=Math.min(ranked.length,Math.max(4,Math.trunc(this.config.deepCandidates)||14));
    if(!target)return [];
    const reserve=Math.min(Math.max(0,Math.trunc(this.config.deepRotationReserve??2)),Math.max(0,target-1));
    const activeSlots=target-reserve;
    const selected=ranked.slice(0,activeSlots);
    const seen=new Set(selected.map(x=>x.symbol));
    const rotationPool=ranked.slice(activeSlots);
    let visited=0;
    while(selected.length<target&&rotationPool.length&&visited<rotationPool.length){
      const row=rotationPool[this.deepCursor%rotationPool.length];
      this.deepCursor=(this.deepCursor+1)%rotationPool.length;
      visited++;
      if(row&&!seen.has(row.symbol)){selected.push(row);seen.add(row.symbol);}
    }
    return selected;
  }
  async deepScan(row){
    const [m1,m5]=await Promise.all([
      this.rest.klines(row.symbol,'1m',{limit:this.config.deepOneMinuteKlines}),
      this.rest.klines(row.symbol,'5m',{limit:this.config.deepFiveMinuteKlines})
    ]);
    const u=row._kahir||{};
    const history=(this.selfSnapshots.get(row.symbol)||[]).filter(x=>Number.isFinite(x?.price));
    return buildKahirAnalysis({
      oneMinute:m1.candles,fiveMinute:m5.candles,ticker:row,selfHistory:history.slice(0,-1),
      marketVelocityBps:this.lastMarketVelocityBps,now:this.clock()
    });
  }
  async scanRow(row){
    const analysis=await this.deepScan(row);
    this.scans++;
    const u=row._kahir||{};
    const candidate={
      symbol:row.symbol,lastPrice:row.lastPrice,priceChange24h:row.priceChange24h,
      selfChangePct:u.selfChangePct||0,velocityBps:u.velocityBps||0,
      marketVelocityBps:u.marketVelocityBps||0,relativeVelocityBps:u.relativeVelocityBps||0
    };
    const result={...candidate,score:finite(analysis.score,0),stage:analysis.stage,eligible:analysis.eligible,analysis};
    const gate=evaluateEliteGate({
      radar:'KAHIR_RADAR',
      direction:analysis.direction,
      baseScore:analysis.score,
      priceChange24h:row.priceChange24h,
      liquidityScore:clamp(70+Math.log10(Math.max(1,row.quoteVolume24h/this.config.minQuoteVolume24h))*30),
      dataQualityScore:90,
      triggerScore:clamp(50+Math.max(Number(analysis.metrics?.one_minute_z)||0,Number(analysis.metrics?.five_minute_z)||0)*14),
      structureScore:analysis.algorithms?.RANGE_ACCEPTANCE?.score||50,
      participationScore:analysis.algorithms?.PARTICIPATION_REGIME?.score||50,
      flowScore:clamp(50+(Number(analysis.metrics?.volume_ratio||1)-1)*25),
      relativeScore:clamp(50+(Number(analysis.metrics?.relative_acceleration_bps)||0)*9),
      momentumScore:clamp(50+(Number(analysis.metrics?.one_minute_z)||0)*14),
      compressionScore:analysis.algorithms?.VOLATILITY_REGIME_TRANSITION?.score||50,
      confirmations:analysis.confirmation_count,
      minConfirmations:7,minScore:88,max24hMovePct:6,requireTrigger:true,minCategoryHits:4
    });
    result.elite_gate=gate;
    if(analysis.eligible&&gate.eligible){
      const lastAlert=this.lastAlertAt.get(row.symbol)||0;
      if(this.clock()-lastAlert>=this.config.alertCooldownMs){
        const alert=buildKahirAlert(candidate,analysis,this.clock());
        alert.elite_gate=gate;
        this.lastAlertAt.set(row.symbol,alert.detected_at);
        await this.store.appendKahirAlert(alert);
        if(this.pushManager?.notifyRadarAlert)await this.pushManager.notifyRadarAlert(alert);
        this.alertCount++;
      }
    }
    return result;
  }
  async tick(){
    if(!this.running||this.busy)return false;
    this.busy=true;
    try{
      if(this.clock()-this.universeAt>this.config.universeRefreshMs)await this.refreshUniverse();
      const rows=await this.tickerRows();
      const {updates}=this.buildDiscovery(rows);
      const selected=this.selectDeep(rows,updates);
      const limit=Math.max(1,Math.min(8,Math.trunc(this.config.deepConcurrency)||4));
      const out=Array(selected.length);let next=0;
      const worker=async()=>{while(true){const i=next++;if(i>=selected.length)return;try{out[i]=await this.scanRow(selected[i]);}catch(e){this.noteError(e,'row');out[i]=null;}}};
      await Promise.all(Array.from({length:Math.min(limit,selected.length)},worker));
      this.latestCandidates=out.filter(x=>x?.eligible&&x?.elite_gate?.eligible).sort((a,b)=>Number(b.elite_gate.score||0)-Number(a.elite_gate.score||0)).slice(0,3);
      this.lastScanAtMs=this.clock();
      this.lastError=null;
      this.lastResult={
        radar:'KAHIR_RADAR',radar_name:'Radar 5 — القاهر',as_of:new Date(this.lastScanAtMs).toISOString(),
        universe:{eligible_spot_symbols:this.universe.length,scanned:rows.length,deep_scanned:selected.length},
        market:{velocity_bps:this.lastMarketVelocityBps},
        candidates:this.latestCandidates,
        meta:{live:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}
      };
      return true;
    }catch(e){
      this.lastScanAtMs=this.clock();
      this.noteError(e,'tick');
      if(!this.lastResult){
        this.lastResult={
          radar:'KAHIR_RADAR',radar_name:'Radar 5 — القاهر',as_of:new Date(this.lastScanAtMs).toISOString(),
          universe:{eligible_spot_symbols:this.universe.length,scanned:0,deep_scanned:0},
          market:{velocity_bps:this.lastMarketVelocityBps},
          candidates:this.latestCandidates||[],
          scan_error:this.lastError,
          meta:{live:Boolean(this.running),paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}
        };
      }else{
        this.lastResult={...this.lastResult,scan_error:this.lastError,as_of:new Date(this.lastScanAtMs).toISOString()};
      }
      return false;
    }finally{this.busy=false;}
  }
  snapshot(limit=20){
    return {
      ...(this.lastResult||{
        radar:'KAHIR_RADAR',radar_name:'Radar 5 — القاهر',
        as_of:null,universe:{eligible_spot_symbols:this.universe.length,scanned:0,deep_scanned:0},
        market:{velocity_bps:this.lastMarketVelocityBps},candidates:[],
        meta:{live:false,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}
      }),
      candidates:(this.latestCandidates||[]).slice(0,Math.max(1,Math.min(50,Number(limit)||20)))
    };
  }
  health(){
    return {
      running:this.running,radar:'KAHIR_RADAR',radar_name:'Radar 5 — القاهر',
      universe:this.universe.length,last_universe_refresh_at:this.universeAt||null,last_scan_at:this.lastScanAtMs,
      scans:this.scans,alerts_emitted:this.alertCount,last_error:this.lastError,busy:this.busy,
      market_velocity_bps:this.lastMarketVelocityBps,
      algorithms:['SELF_BASELINE_Z','PARTICIPATION_REGIME','VOLATILITY_REGIME_TRANSITION','KAUFMAN_EFFICIENCY_SHIFT','RANGE_ACCEPTANCE','IMPULSE_PERSISTENCE','MARKET_SPEED_SPREAD'],
      source:'Binance Public REST',closed_candles_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
    };
  }
}
