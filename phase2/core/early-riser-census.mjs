const finite=value=>{
  if(value===null||value===undefined||value==='')return null;
  const number=Number(value);
  return Number.isFinite(number)?number:null;
};

export const EARLY_RISER_CENSUS_POLICY=Object.freeze({
  target_horizon_hours:24,
  target_thresholds_pct:[5,10,15],
  adverse_barrier_pct:3,
  candle_interval_ms:15*60*1000,
  expected_future_candles:96,
  event_cluster_gap_hours:12,
  observation_cadence_hours:2
});

/**
 * Score a strictly future 24h path using closed 15m candles.
 * A candle touching both target and adverse barrier is ambiguous, never a win.
 */
export function evaluateEarlyRiserFirstPassage(candles,index,baselinePrice,targetPct,stopPct=3){
  const rows=Array.isArray(candles)?candles:[];
  const baseline=rows[index];
  if(!Number.isInteger(index)||index<0||index+96>=rows.length||
     !(finite(baselinePrice)>0)||!baseline||
     !Number.isFinite(Number(baseline.closeTime))){
    return {status:'INCOMPLETE',reason:'MISSING_96_FUTURE_CLOSED_15M_CANDLES'};
  }
  const interval=EARLY_RISER_CENSUS_POLICY.candle_interval_ms;
  const path=rows.slice(index+1,index+97);
  if(path.length!==96||path.some((bar,offset)=>{
    const open=Number(bar?.openTime);
    return !Number.isFinite(open)||
      open!==(offset===0?Number(baseline.closeTime)+1:Number(path[offset-1]?.openTime)+interval);
  })){
    return {status:'INCOMPLETE',reason:'FUTURE_15M_GAP'};
  }
  const price=Number(baselinePrice);
  const target=price*(1+Number(targetPct)/100);
  const stop=price*(1-Number(stopPct)/100);
  if(!(target>price)||!(stop>0&&stop<price))
    return {status:'INVALID_POLICY',reason:'INVALID_TARGET_OR_STOP'};
  let maxHigh=-Infinity,minLow=Infinity;
  for(const bar of path){
    const high=finite(bar?.high),low=finite(bar?.low),closeTime=finite(bar?.closeTime);
    if(high===null||low===null||closeTime===null||high<low||low<=0)
      return {status:'INCOMPLETE',reason:'INVALID_FUTURE_CANDLE'};
    maxHigh=Math.max(maxHigh,high);
    minLow=Math.min(minLow,low);
    const targetHit=high>=target,stopHit=low<=stop;
    const excursion={
      max_favorable_pct:Number(((maxHigh/price-1)*100).toFixed(4)),
      max_adverse_pct:Number(((minLow/price-1)*100).toFixed(4))
    };
    const minutes=Math.round((closeTime-Number(baseline.closeTime))/60000);
    if(targetHit&&stopHit)return {
      status:'AMBIGUOUS',target_pct:Number(targetPct),stop_pct:Number(stopPct),
      first_hit_at:null,minutes_to_resolution:minutes,...excursion,
      reason:'TARGET_AND_STOP_TOUCHED_IN_SAME_15M_CANDLE'
    };
    if(targetHit)return {
      status:'UP_FIRST',target_pct:Number(targetPct),stop_pct:Number(stopPct),
      first_hit_at:closeTime,minutes_to_resolution:minutes,...excursion
    };
    if(stopHit)return {
      status:'DOWN_FIRST',target_pct:Number(targetPct),stop_pct:Number(stopPct),
      first_hit_at:closeTime,minutes_to_resolution:minutes,...excursion
    };
  }
  return {
    status:'NEITHER',target_pct:Number(targetPct),stop_pct:Number(stopPct),
    first_hit_at:null,minutes_to_resolution:1440,
    max_favorable_pct:Number(((maxHigh/price-1)*100).toFixed(4)),
    max_adverse_pct:Number(((minLow/price-1)*100).toFixed(4)),
    reason:'NEITHER_LEVEL_REACHED_WITHIN_24H'
  };
}

/**
 * Collapse overlapping +5% first-passage observations into transparent,
 * same-symbol event clusters. The 12h gap is a heuristic, not canonical ID.
 */
export function clusterEarlyRiserEvents(rows,{clusterGapHours=12,signalTiers=['EARLY_SETUP']}={}){
  const gapMs=Math.max(1,Number(clusterGapHours)||12)*60*60*1000;
  const signals=new Set(Array.isArray(signalTiers)?signalTiers.map(String):[]);
  const bySymbol=new Map();
  for(const row of Array.isArray(rows)?rows:[]){
    if(row?.outcomes?.p5?.status!=='UP_FIRST')continue;
    const symbol=String(row.symbol||'').toUpperCase();
    const hit=finite(row.outcomes.p5.first_hit_at);
    const at=finite(row.at);
    if(!symbol||hit===null||at===null)continue;
    if(!bySymbol.has(symbol))bySymbol.set(symbol,[]);
    bySymbol.get(symbol).push(row);
  }
  const events=[];
  for(const [symbol,items] of bySymbol){
    items.sort((a,b)=>Number(a.outcomes.p5.first_hit_at)-Number(b.outcomes.p5.first_hit_at)||
      Number(a.at)-Number(b.at));
    let cluster=[];
    const flush=()=>{
      if(!cluster.length)return;
      const firstHitAt=Math.min(...cluster.map(row=>Number(row.outcomes.p5.first_hit_at)));
      const observations=rows.filter(row=>String(row.symbol||'').toUpperCase()===symbol&&
        Number(row.at)<firstHitAt&&Number(row.at)>=firstHitAt-24*60*60*1000);
      const alerts=observations.filter(row=>signals.has(String(row.tier||'')))
        .sort((a,b)=>Number(b.at)-Number(a.at)||Number(b.base_score)-Number(a.base_score));
      const latest=alerts[0]||null;
      const best=observations.slice().sort((a,b)=>Number(b.base_score)-Number(a.base_score)||
        Number(b.at)-Number(a.at))[0]||null;
      events.push({
        event_id:symbol+':P5:'+String(firstHitAt),
        symbol,first_hit_at:firstHitAt,
        first_hit_at_utc:new Date(firstHitAt).toISOString(),
        observation_rows_in_cluster:cluster.length,
        early_setup_detected:Boolean(latest),
        signal_at:latest?Number(latest.at):null,
        lead_minutes:latest?Number(((firstHitAt-Number(latest.at))/60000).toFixed(1)):null,
        signal_score:latest?Number(latest.base_score):null,
        best_pre_hit_tier:best?.tier??null,
        best_pre_hit_score:best?Number(best.base_score):null,
        missed_reason_codes:latest?[]:(Array.isArray(best?.reason_codes)?best.reason_codes.slice(0,12):[])
      });
      cluster=[];
    };
    for(const row of items){
      const hit=Number(row.outcomes.p5.first_hit_at);
      const prior=cluster.length?Number(cluster[cluster.length-1].outcomes.p5.first_hit_at):null;
      if(prior!==null&&hit-prior>gapMs)flush();
      cluster.push(row);
    }
    flush();
  }
  return events.sort((a,b)=>a.first_hit_at-b.first_hit_at||a.symbol.localeCompare(b.symbol));
}

export function summarizeEarlyRiserRows(rows){
  const input=Array.isArray(rows)?rows:[];
  const out={samples:input.length,targets:{},by_tier:{},early_setup:{}};
  for(const target of [5,10,15]){
    const key='p'+target;
    const positives=input.filter(row=>row?.outcomes?.[key]?.status==='UP_FIRST').length;
    const negative=input.filter(row=>row?.outcomes?.[key]?.status==='DOWN_FIRST').length;
    const neither=input.filter(row=>row?.outcomes?.[key]?.status==='NEITHER').length;
    const ambiguous=input.filter(row=>row?.outcomes?.[key]?.status==='AMBIGUOUS').length;
    const incomplete=input.filter(row=>row?.outcomes?.[key]?.status==='INCOMPLETE').length;
    const ordered=input.slice().sort((a,b)=>Number(b.base_score)-Number(a.base_score)||
      String(a.symbol).localeCompare(String(b.symbol))||Number(a.at)-Number(b.at));
    const ranking={samples:input.length,up_first:positives,down_first:negative,neither,ambiguous,incomplete,
      up_first_rate_pct:input.length?Number((positives/input.length*100).toFixed(3)):null};
    for(const pct of [10,20]){
      const count=input.length?Math.max(1,Math.ceil(input.length*pct/100)):0;
      const selected=ordered.slice(0,count);
      const hit=selected.filter(row=>row?.outcomes?.[key]?.status==='UP_FIRST').length;
      ranking['top_'+pct+'_pct']={
        sample_count:count,up_first:hit,
        precision_pct:count?Number((hit/count*100).toFixed(3)):null,
        recall_pct:positives?Number((hit/positives*100).toFixed(3)):null
      };
    }
    out.targets[key]=ranking;
    const groups={};
    for(const row of input){
      const tier=String(row.tier||'UNKNOWN');
      if(!groups[tier])groups[tier]={samples:0,up_first:0,down_first:0,neither:0,ambiguous:0,incomplete:0};
      const g=groups[tier],status=row?.outcomes?.[key]?.status;
      g.samples++;
      if(status==='UP_FIRST')g.up_first++;
      else if(status==='DOWN_FIRST')g.down_first++;
      else if(status==='NEITHER')g.neither++;
      else if(status==='AMBIGUOUS')g.ambiguous++;
      else g.incomplete++;
    }
    for(const g of Object.values(groups))
      g.up_first_rate_pct=g.samples?Number((g.up_first/g.samples*100).toFixed(3)):null;
    out.by_tier[key]=groups;
  }
  const early=input.filter(row=>row.tier==='EARLY_SETUP');
  const up=early.filter(row=>row.outcomes?.p5?.status==='UP_FIRST').length;
  out.early_setup={
    samples:early.length,p5_up_first:up,
    p5_down_first:early.filter(row=>row.outcomes?.p5?.status==='DOWN_FIRST').length,
    p5_neither:early.filter(row=>row.outcomes?.p5?.status==='NEITHER').length,
    p5_ambiguous:early.filter(row=>row.outcomes?.p5?.status==='AMBIGUOUS').length,
    p5_false_or_unconfirmed:early.length-up,
    p5_up_precision_pct:early.length?Number((up/early.length*100).toFixed(3)):null
  };
  return out;
}
