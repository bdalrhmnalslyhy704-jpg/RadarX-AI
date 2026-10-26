const RADAR_ALIASES=Object.freeze({
 RADAR1:'EARLY_MOVE_RADAR',RADAR_1:'EARLY_MOVE_RADAR',EARLY_MOVE_RADAR:'EARLY_MOVE_RADAR',
 RADAR2:'STRONG_MOVE_RADAR',RADAR_2:'STRONG_MOVE_RADAR',STRONG_MOVE_RADAR:'STRONG_MOVE_RADAR',
 RADAR3:'ROTATION_LAG_RADAR',RADAR_3:'ROTATION_LAG_RADAR',ROTATION_LAG_RADAR:'ROTATION_LAG_RADAR',JOKER_RADAR:'ROTATION_LAG_RADAR',
 RADAR4:'LIQUIDITY_ABSORPTION_RADAR',RADAR_4:'LIQUIDITY_ABSORPTION_RADAR',LIQUIDITY_ABSORPTION_RADAR:'LIQUIDITY_ABSORPTION_RADAR',SWEEPER_RADAR:'LIQUIDITY_ABSORPTION_RADAR',
 RADAR5:'KAHIR_RADAR',RADAR_5:'KAHIR_RADAR',KAHIR_RADAR:'KAHIR_RADAR',
 RADAR6:'DOOMSDAY_RADAR',RADAR_6:'DOOMSDAY_RADAR',DOOMSDAY_RADAR:'DOOMSDAY_RADAR',
 RADAR7:'ALMUQAWIM_RADAR',RADAR_7:'ALMUQAWIM_RADAR',ALMUQAWIM_RADAR:'ALMUQAWIM_RADAR',
 RADAR8:'EARLY_EXPANSION_RADAR',RADAR_8:'EARLY_EXPANSION_RADAR',EARLY_EXPANSION_RADAR:'EARLY_EXPANSION_RADAR',LIGHTNING_RADAR:'EARLY_EXPANSION_RADAR',
 RADAR9:'FALCON_EYE_RADAR',RADAR_9:'FALCON_EYE_RADAR',RADAR9_FALCON_EYE:'FALCON_EYE_RADAR',FALCON_EYE_RADAR:'FALCON_EYE_RADAR',
 RADAR10:'COIN_HUNTER_RADAR',RADAR_10:'COIN_HUNTER_RADAR',RADAR10_COIN_HUNTER:'COIN_HUNTER_RADAR',COIN_HUNTER_RADAR:'COIN_HUNTER_RADAR',
 RADAR11:'WHALE_ACCUMULATION_RADAR',RADAR_11:'WHALE_ACCUMULATION_RADAR',RADAR11_WHALE:'WHALE_ACCUMULATION_RADAR',WHALE_ACCUMULATION_RADAR:'WHALE_ACCUMULATION_RADAR',
 RADAR12:'PROFESSOR_RADAR',RADAR_12:'PROFESSOR_RADAR',RADAR12_PROFESSOR:'PROFESSOR_RADAR',PROFESSOR_RADAR:'PROFESSOR_RADAR',
 PRE_MOVE:'PRE_MOVE_RADAR',PRE_MOVE_RADAR:'PRE_MOVE_RADAR',BOTTOM_RADAR:'BOTTOM_REVERSAL_RADAR',BOTTOM_REVERSAL_RADAR:'BOTTOM_REVERSAL_RADAR'
});
const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number(v)));
function num(v){if(v===null||v===undefined||v===''||typeof v==='boolean')return null;const n=Number(v);return Number.isFinite(n)?n:null;}
function firstNumber(values){for(const v of values){const n=num(v);if(n!==null)return n;}return null;}
function toMs(v){
 if(typeof v==='string'&&!/^\d+(?:\.\d+)?$/.test(v.trim())){const n=Date.parse(v);return Number.isFinite(n)?n:null;}
 const n=num(v);if(n===null||n<=0)return null;return n<1e12?Math.trunc(n*1000):Math.trunc(n);
}
export function canonicalRadarId(value){const raw=String(value??'').trim().toUpperCase();return RADAR_ALIASES[raw]||raw.slice(0,80)||'UNKNOWN_RADAR';}
function eventAt(alert,now){
 for(const v of [alert?.source_candle_close_at,alert?.source_event_at,alert?.detected_candle_close_time,alert?.candle?.close_time,alert?.candle?.closeTime,alert?.data_status?.close_time,alert?.detected_at,alert?.detectedAt,alert?.observed_at,alert?.observedAt,alert?.created_at,alert?.timestamp,alert?.processed_at]){
  const n=toMs(v);if(n!==null)return n;
 }
 return now;
}
function scoreOf(a){return firstNumber([a?.elite_gate?.score,a?.score,a?.signal_score,a?.final_score,a?.opportunity_score,a?.radar_power_score,a?.strong_move?.score,a?.rotation?.score,a?.liquidity_absorption?.score,a?.kahir_analysis?.score,a?.doomsday?.score,a?.almuqawim?.score,a?.early_expansion?.score,a?.coin_hunter?.score,a?.whale_accumulation?.score,a?.falcon_eye?.score,a?.professor_opinion?.score,a?.pre_move_context?.score]);}
function dataQualityOf(a){return firstNumber([a?.data_quality,a?.data_status?.data_quality,a?.components?.data_quality,a?.early_expansion?.data_quality,a?.early_move?.data_quality,a?.strong_move?.data_quality,a?.rotation?.data_quality,a?.kahir_analysis?.data_quality,a?.doomsday?.data_quality,a?.almuqawim?.data_quality,a?.liquidity_absorption?.data_quality,a?.coin_hunter?.data_quality,a?.whale_accumulation?.data_quality,a?.falcon_eye?.data_quality,a?.professor_opinion?.data_quality]);}
function liquidityOf(a){return firstNumber([a?.liquidity_quality,a?.liquidity_metrics?.liquidity_quality,a?.components?.liquidity,a?.early_expansion?.liquidity_quality,a?.early_move?.liquidity_quality,a?.strong_move?.liquidity_quality,a?.rotation?.liquidity_quality,a?.kahir_analysis?.liquidity_quality,a?.doomsday?.liquidity_quality,a?.almuqawim?.liquidity_quality,a?.liquidity_absorption?.liquidity_quality,a?.coin_hunter?.liquidity_quality,a?.whale_accumulation?.liquidity_quality,a?.falcon_eye?.liquidity_quality,a?.professor_opinion?.liquidity_quality]);}
function directionOf(a){const d=String(a?.direction??a?.trend??a?.bias??a?.signal_direction??'').trim().toUpperCase();if(['UP','LONG','BULLISH','BUY','BUYING','POSITIVE'].includes(d))return'BULLISH';if(['DOWN','SHORT','BEARISH','SELL','SELLING','NEGATIVE'].includes(d))return'BEARISH';return'UNKNOWN';}
function priceChangeOf(a){return firstNumber([a?.price_change_24h,a?.priceChange24h,a?.change_24h_pct,a?.price_change_24h_pct]);}
function evaluateEvidence(a,{radar,now,ttlMs,minDataQuality,minLiquidityQuality,minScore}){
 const data=dataQualityOf(a),liquidity=liquidityOf(a),score=scoreOf(a),detected=eventAt(a,now),age=now-detected,status=a?.data_status||{};
 const explicitlyInvalid=a?.live===false||a?.meta?.live===false||status.data_valid===false||status.data_stale===true||status.stale===true||a?.data_stale===true||a?.stale===true||a?.future_data_detected===true||status.future_data_detected===true||a?.closed_candles_only===false||['STALE','OFFLINE','DATA_STALE','DATA_UNAVAILABLE'].includes(String(status.status??'').toUpperCase());
 const ageField=firstNumber([a?.data_age_ms,a?.age_ms,status.age_ms,status.fetch_age_ms]),freshness=ageField===null?age:Math.max(age,ageField);
 const reasons=[];
 if(!Object.values(RADAR_ALIASES).includes(radar))reasons.push('UNKNOWN_RADAR_ID');
 if(data===null||data<minDataQuality)reasons.push('DATA_QUALITY_NOT_MET');
 if(liquidity===null||liquidity<minLiquidityQuality)reasons.push('LIQUIDITY_QUALITY_NOT_MET');
 if(score===null||score<minScore)reasons.push('RADAR_SCORE_NOT_MET');
 if(explicitlyInvalid)reasons.push('DATA_FRESHNESS_OR_VALIDITY_FAILED');
 if(freshness<0)reasons.push('FUTURE_EVIDENCE');else if(freshness>ttlMs)reasons.push('EVIDENCE_EXPIRED');
 return {radar,score,data_quality:data,liquidity_quality:liquidity,direction:directionOf(a),price_change_24h:priceChangeOf(a),detected_at:detected,age_ms:Math.max(0,freshness),eligible:reasons.length===0,reason_codes:reasons};
}
/**
 * Deduplicates radar aliases and fuses independent fresh evidence for analyst review.
 * It never authorizes a notification or entry; the existing strict delivery gates remain final.
 */
export class RadarEvidenceFusion{
 constructor({clock=()=>Date.now(),ttlMs=20*60_000,maxSymbols=1500,minDataQuality=70,minLiquidityQuality=60,minScore=60,maxDailyExtensionPct=8}={}){
  this.clock=clock;this.ttlMs=Math.max(60_000,Math.min(60*60_000,Math.trunc(Number(ttlMs)||20*60_000)));
  this.maxSymbols=Math.max(50,Math.min(5000,Math.trunc(Number(maxSymbols)||1500)));
  this.minDataQuality=clamp(minDataQuality);this.minLiquidityQuality=clamp(minLiquidityQuality);this.minScore=clamp(minScore);
  this.maxDailyExtensionPct=clamp(maxDailyExtensionPct,1,30);this.bySymbol=new Map();this.observations=0;this.rejectedObservations=0;
 }
 _prune(now=this.clock()){
  for(const [symbol,bucket] of this.bySymbol){for(const [radar,entry] of bucket.radars){if(now-Number(entry.detected_at)>this.ttlMs)bucket.radars.delete(radar);}if(!bucket.radars.size)this.bySymbol.delete(symbol);}
  while(this.bySymbol.size>this.maxSymbols){let oldest=null,oldestAt=Infinity;for(const [symbol,bucket] of this.bySymbol){const latest=Math.max(0,...[...bucket.radars.values()].map(x=>Number(x.detected_at)||0));if(latest<oldestAt){oldestAt=latest;oldest=symbol;}}if(oldest===null)break;this.bySymbol.delete(oldest);}
 }
 observe(alert,{now=this.clock(),radar:override=null}={}){
  const symbol=String(alert?.symbol??alert?.asset??'').trim().toUpperCase();if(!/^[A-Z0-9]{2,30}$/.test(symbol)){this.rejectedObservations++;return null;}
  const radar=canonicalRadarId(override??alert?.radar??alert?.radar_id??alert?.radar_name);
  const evidence=evaluateEvidence(alert,{radar,now,ttlMs:this.ttlMs,minDataQuality:this.minDataQuality,minLiquidityQuality:this.minLiquidityQuality,minScore:this.minScore});
  this.observations++;this._prune(now);
  let bucket=this.bySymbol.get(symbol);if(!bucket){bucket={symbol,radars:new Map(),first_seen_at:now,last_seen_at:now};this.bySymbol.set(symbol,bucket);}
  bucket.last_seen_at=now;
  if(evidence.eligible){const previous=bucket.radars.get(radar);if(!previous||evidence.detected_at>=previous.detected_at)bucket.radars.set(radar,{...evidence,observed_at:now});}else this.rejectedObservations++;
  return this.get(symbol,{now});
 }
 get(symbol,{now=this.clock()}={}){
  const key=String(symbol??'').trim().toUpperCase();this._prune(now);const bucket=this.bySymbol.get(key);
  const rows=bucket?[...bucket.radars.values()].filter(x=>x.eligible&&now-x.detected_at>=0&&now-x.detected_at<=this.ttlMs):[];
  const bullish=rows.filter(x=>x.direction==='BULLISH'),bearish=rows.filter(x=>x.direction==='BEARISH'),unknown=rows.filter(x=>x.direction==='UNKNOWN');
  const mean=xs=>xs.length?xs.reduce((s,x)=>s+x,0)/xs.length:null;
  const meanScore=mean(rows.map(x=>x.score).filter(Number.isFinite)),dataValues=rows.map(x=>x.data_quality).filter(Number.isFinite),liqValues=rows.map(x=>x.liquidity_quality).filter(Number.isFinite);
  const newest=[...rows].sort((a,b)=>b.detected_at-a.detected_at)[0],latestMove=newest?.price_change_24h??null;
  const bullRatio=rows.length?bullish.length/rows.length:0,conflict=bullish.length>0&&bearish.length>0,antiChase=latestMove!==null&&latestMove<=this.maxDailyExtensionPct;
  let classification='NO_QUALIFIED_EVIDENCE';
  if(rows.length===1)classification='SINGLE_RADAR_OBSERVATION';
  if(rows.length>=2)classification='CROSS_RADAR_REVIEW';
  if(conflict)classification='MIXED_DIRECTION_REQUIRES_REVIEW';
  if(rows.length>=3&&bullish.length>=2&&bullRatio>=.67&&!conflict&&antiChase)classification='CROSS_RADAR_PREMOVE_CONFLUENCE';
  const avgData=mean(dataValues),avgLiq=mean(liqValues);
  const priority=rows.length?Math.round(clamp(rows.length*14+(meanScore??0)*.28+(avgData??0)*.07+(avgLiq??0)*.07+bullRatio*10)*10)/10:0;
  return {symbol:key,as_of:new Date(now).toISOString(),method:'UNIQUE_FRESH_RADAR_EVIDENCE_V1',distinct_radars:rows.length,
   qualified_radars:rows.map(x=>x.radar).slice(0,13),bullish_radars:bullish.map(x=>x.radar).slice(0,13),bearish_radars:bearish.map(x=>x.radar).slice(0,13),unknown_direction_radars:unknown.map(x=>x.radar).slice(0,13),
   mean_radar_score:meanScore===null?null:Math.round(meanScore*10)/10,min_data_quality:dataValues.length?Math.min(...dataValues):null,min_liquidity_quality:liqValues.length?Math.min(...liqValues):null,
   bullish_ratio:Math.round(bullRatio*1000)/1000,anti_chase_pass:antiChase,latest_price_change_24h:latestMove,classification,priority_score:priority,
   review_only:true,notification_eligible:false,entry_eligible:false,observation_count:this.observations,rejected_observation_count:this.rejectedObservations};
 }
 snapshot({now=this.clock(),limit=100}={}){
  this._prune(now);const rows=[...this.bySymbol.keys()].map(symbol=>this.get(symbol,{now})).sort((a,b)=>b.priority_score-a.priority_score||b.distinct_radars-a.distinct_radars||a.symbol.localeCompare(b.symbol));
  return {as_of:new Date(now).toISOString(),method:'UNIQUE_FRESH_RADAR_EVIDENCE_V1',retained_symbols:this.bySymbol.size,observation_count:this.observations,rejected_observation_count:this.rejectedObservations,ttl_ms:this.ttlMs,
   priority_rows:rows.slice(0,Math.max(1,Math.min(500,Math.trunc(Number(limit)||100)))),policy:{market:'BINANCE_SPOT',paper_trading:true,real_order_execution:false,notification_eligible:false}};
 }
}
