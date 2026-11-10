/**
 * Turn numeric scoring into a plain-language, auditable decision.
 * This is analysis-only: no recommendation from this helper can place an order.
 */
export function buildAdaptiveTraderRecommendation(candidate, {now=Date.now()} = {}) {
  const symbol=String(candidate?.symbol||'').trim().toUpperCase();
  const features=candidate?.features&&typeof candidate.features==='object'?candidate.features:{};
  const reasons=Array.isArray(candidate?.reason_codes)?candidate.reason_codes.map(String):[];
  const score=finite(candidate?.score);
  const daily=finite(candidate?.change_24h_pct);
  const hourly=finite(features.hourly_return_pct);
  const reportedAge=finite(candidate?.candle_age_ms);
  const closeTime=finite(candidate?.candle_close_time);
  const elapsedSinceClose=closeTime!==null?Number(now)-closeTime:null;
  const age=reportedAge===null?elapsedSinceClose:elapsedSinceClose===null?reportedAge:Math.max(reportedAge,elapsedSinceClose);
  const out=(decision,label,action,priority,nextStep,reasonCodes=[])=>({
    decision,label_ar:label,action,priority,symbol,score,
    reason_codes:[...new Set([...reasons,...reasonCodes])].slice(0,12),
    next_step_ar:nextStep,
    entry_eligible:false,paper_trading:true,real_order_execution:false,
    confidence_score:'UNKNOWN'
  });
  if(!/^[A-Z0-9]{5,30}$/.test(symbol)||candidate?.data_valid!==true||
     candidate?.data_stale===true||candidate?.closed_candles_only!==true||
     !(finite(candidate?.price)>0)||score===null||age===null||age<0||age>POLICY.maxCandleAgeMs) {
    return out('DATA_UNAVAILABLE','لا تدخل — البيانات أو الشموع المغلقة غير مكتملة','NO_TRADE',-1,
      'انتظر بيانات Binance Spot حديثة وصالحة؛ لا تعتمد على سعر قديم.',['LIVE_DATA_AND_CLOSED_CANDLE_REQUIRED']);
  }
  const late= candidate?.tier==='LATE_MOVE'||candidate?.thresholds?.late_move===true||
    (daily!==null&&daily>=8)||(hourly!==null&&hourly>=5)||
    (finite(features.recent_15m_return_pct)!==null&&Number(features.recent_15m_return_pct)>=2.5)||
    (finite(features.micro_5m_return_pct)!==null&&Number(features.micro_5m_return_pct)>=3.0);
  if(late) {
    return out('AVOID_CHASING','تجنّب مطاردة الصعود — الحركة امتدّت بالفعل','AVOID',-1,
      'لا تشترِ بسبب الارتفاع اليومي وحده؛ انتظر قاعدة سعرية جديدة وإشارة مبكرة صالحة.',['ALREADY_EXTENDED','ANTI_CHASE']);
  }
  if(candidate?.tier==='EARLY_SETUP'&&candidate?.paper_candidate===true&&candidate?.thresholds?.no_chase===true) {
    const strictSetup=score>=75&&
      finite(features.volume_ratio)!==null&&Number(features.volume_ratio)>=1.75&&
      finite(features.trade_ratio)!==null&&Number(features.trade_ratio)>=1.5&&
      finite(features.taker_buy_ratio)!==null&&Number(features.taker_buy_ratio)>=0.56&&
      finite(features.close_location)!==null&&Number(features.close_location)>=0.65&&
      finite(features.relative_strength_vs_btc_pct)!==null&&Number(features.relative_strength_vs_btc_pct)>=0.25&&
      features.breakout_above_prior_high===true&&daily!==null&&daily>=-3&&daily<=7&&
      hourly!==null&&hourly>=-2.5&&hourly<=3.5&&age<=10*60*1000&&
      features.micro_5m_available===true&&finite(features.micro_5m_taker_buy_ratio)!==null&&
      Number(features.micro_5m_taker_buy_ratio)>=0.53&&finite(features.micro_5m_volume_ratio)!==null&&
      Number(features.micro_5m_volume_ratio)>=1.1;
    if(strictSetup) {
      const temporal=candidate?.cognitive_assessment||{};
      const temporalStatus=String(temporal.temporal_model_status||candidate?.temporal_model_status||'');
      const temporalProbability=finite(temporal.temporal_up_probability);
      const temporalValidated=[
        'OUT_OF_SAMPLE_VALIDATED_PAPER_ONLY',
        'LIVE_GATE_PASSED_OUT_OF_SAMPLE'
      ].includes(temporalStatus);
      if(!temporalValidated||temporalProbability===null) {
        return out('WAIT_FOR_TEMPORAL_VALIDATION','نموذج الشموع ما زال يتعلم — لا توصية دخول',
          'WAIT',1,
          'تجمعت شروط فنية أولية، لكن الشبكة الزمنية لم تجتز الاختبار المستقل بعد. أبقِ العملة في المراقبة فقط.',
          ['TEMPORAL_MODEL_NOT_OUT_OF_SAMPLE_VALIDATED']);
      }
      if(temporalProbability<65) {
        return out('WATCH_ONLY','الشبكة لم تؤيد احتمال الصعود الكافي — مراقبة فقط',
          'WAIT',1,
          'لا تدخل؛ احتمال النموذج الزمني أقل من حد المراجعة المحدد. انتظر شموعًا جديدة أو تجاوز العملة.',
          ['TEMPORAL_PROBABILITY_BELOW_REVIEW_THRESHOLD']);
      }
      return out('ENTRY_CANDIDATE','مرشّح مبكر للمراجعة الورقية فقط — ليس أمر شراء','REVIEW_ENTRY',3,
        'اجتازت الشبكة الزمنية اختبارها المستقل وأيدت هذا المرشح. تحقّق من السعر والسيولة والسبريد والرسوم وحدد وقف الخسارة؛ التنفيذ الحقيقي متوقف.',
        ['STRICT_EARLY_SETUP','CLOSED_CANDLE_BREAKOUT','BUY_FLOW_AND_ACTIVITY_CONFIRMED',
         'TEMPORAL_TCN_OUT_OF_SAMPLE_VALIDATED']);
    }
    return out('WAIT_FOR_CONFIRMATION','فرصة مبكرة — انتظر تأكيدًا قبل الدخول','WAIT',2,
      'لا تدخل الآن لمجرد ظهور المرشّح؛ انتظر إغلاق شمعة 15 دقيقة يؤكد الاختراق، مع استمرار ضغط الشراء وعدم امتداد السعر.',
      ['EARLY_SETUP_NOT_FULLY_CONFIRMED']);
  }
  if(candidate?.tier==='WATCH'||(score>=52&&candidate?.tier!=='NO_SETUP')) {
    return out('WATCH_ONLY','مراقبة فقط — شروط الدخول لم تكتمل','WAIT',1,
      'لا تدخل بعد؛ راقب زيادة الحجم والصفقات وضغط الشراء وبنية السعر على شمعة مغلقة.');
  }
  return out('NO_SETUP','لا توجد فرصة دخول واضحة الآن','NO_TRADE',0,
    'تجاوز هذه العملة في الوقت الحالي، واستمر في فحص بقية الأزواج.');
}

export const HISTORICAL_TRAINING_SAMPLES_PER_SYMBOL=110;

const POLICY = Object.freeze({
  minQuoteVolume24h: 750000,
  minClosedCandles: 12,
  maxCandleAgeMs: 20 * 60 * 1000,
  defaultUniverseLimit: 80,
  maxUniverseLimit: 120,
  learningMinOutcomes: 60,
  paperPositionPct: 5,
  maxPaperPositions: 3,
  takeProfitPct: 3,
  stopLossPct: -2,
  maxHoldMs: 4 * 60 * 60 * 1000,
  estimatedRoundTripCostPct: 0.30,
  realOrderExecution: false
});

export function buildAdaptiveTraderCoveragePlan(eligibleCount, scanLimit) {
  const eligible=Math.max(0,Math.trunc(Number(eligibleCount)||0));
  const batch=Math.min(eligible,Math.max(0,Math.trunc(Number(scanLimit)||0)));
  // Half of each bounded batch is reserved for deterministic round-robin
  // discovery; the other half remains available to event/liquidity priorities.
  // This gives a finite sweep bound instead of leaving only 15% for rotation.
  // Keep roughly half the batch on the fair cursor, while assigning one
  // explicit slot to the extended-mover audit lane. These rows are audit-only
  // and never gain entry permission; they must not displace the next rising pair.
  const rotationSlots=batch?Math.min(batch,Math.max(1,batch>1?Math.ceil(batch/2)-1:1)):0;
  return {
    eligible_symbols:eligible,
    scan_batch_limit:batch,
    rotation_slots_per_cycle:rotationSlots,
    priority_slots_per_cycle:Math.max(0,batch-rotationSlots),
    estimated_full_sweep_cycles:rotationSlots?Math.ceil(eligible/rotationSlots):0
  };
}

const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
function mergeOlderKlinePage(current,older){
  const currentRows=Array.isArray(current?.data)?current.data:[];
  const olderRows=Array.isArray(older?.data)?older.data:[];
  if(!currentRows.length||!olderRows.length)return current;
  const earliestOpen=finite(currentRows[0]?.[0]);
  if(earliestOpen===null)return current;
  const unique=new Map();
  for(const row of [...olderRows.filter(row=>finite(row?.[0])!==null&&Number(row[0])<earliestOpen),...currentRows]){
    const open=finite(row?.[0]);
    if(open!==null)unique.set(open,row);
  }
  const data=[...unique.entries()].sort((a,b)=>a[0]-b[0]).map(([,row])=>row);
  return {...current,data,historical_pages_fetched:2,historical_window_candles:data.length,
    historical_backfill_error:null};
}
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const pct = (a, b) => Number.isFinite(a) && Number.isFinite(b) && b > 0 ? (a / b - 1) * 100 : null;
const isLeveragedToken = symbol => /(?:UP|DOWN|BULL|BEAR)USDT$/.test(String(symbol || '').toUpperCase());

function normalizeCandle(row, intervalMs = 15 * 60 * 1000) {
  if (!Array.isArray(row) || row.length < 11) return null;
  const values = {
    openTime: finite(row[0]), open: finite(row[1]), high: finite(row[2]),
    low: finite(row[3]), close: finite(row[4]), volume: finite(row[5]),
    closeTime: finite(row[6]), quoteVolume: finite(row[7]), trades: finite(row[8]),
    takerBuyBaseVolume: finite(row[9]), takerBuyQuoteVolume: finite(row[10])
  };
  if (Object.values(values).some(v => v === null) ||
      values.openTime <= 0 || values.closeTime !== values.openTime + intervalMs - 1 ||
      values.low <= 0 || values.high < values.low || values.close <= 0 ||
      values.quoteVolume < 0 || values.trades < 0) return null;
  return values;
}


function buildTemporalSequenceWithDiagnostics(candles, btcCandles, fastCandles) {
  const fail=(reason,stepIndex=null,at=null)=>({
    sequence:null,rejection_reason:reason,step_index:stepIndex,at
  });
  const steps=24;
  if(!Array.isArray(candles)||!Array.isArray(btcCandles)||!Array.isArray(fastCandles))
    return fail('TEMPORAL_INPUT_ARRAY_INVALID');
  const start=candles.length-steps;
  if(start<96)return fail('INSUFFICIENT_ASSET_TENSOR_CONTEXT');
  const history=candles.slice(start-24);
  if(history.length!==48||history.some((row,index)=>
    index>0&&row.openTime-history[index-1].openTime!==15*60*1000))
    return fail('ASSET_RECENT_48_CANDLE_HISTORY_GAP');
  const btcByClose=new Map(btcCandles.map(row=>[Number(row.closeTime),row]));
  const btcIndexByClose=new Map(btcCandles.map((row,index)=>[Number(row.closeTime),index]));
  const fastByOpen=new Map(fastCandles.map(row=>[Number(row.openTime),row]));
  const microStep=5*60*1000;
  const sequence=[];
  for(let index=start;index<candles.length;index++){
    const current = candles[index], previous = candles[index - 1];
    const baseline = candles.slice(index - 24, index);
    const volumeBase = mean(baseline.map(row => row.quoteVolume));
    const tradesBase = mean(baseline.map(row => row.trades));
    const ranges = baseline.map(row => (row.high - row.low) / row.close);
    const rangeBase = mean(ranges);
    const rangeNow = (current.high - current.low) / current.close;
    const buyShare = current.quoteVolume > 0 ? current.takerBuyQuoteVolume / current.quoteVolume : null;
    const closeLocation = current.high > current.low
      ? (current.close - current.low) / (current.high - current.low) : 0.5;
    const body = current.high > current.low ? (current.close - current.open) / (current.high - current.low) : 0;
    const btcCurrent=btcByClose.get(Number(current.closeTime));
    const btcPrevious=btcByClose.get(Number(previous.closeTime));
    const btcIndex=btcIndexByClose.get(Number(current.closeTime));
    const btcBaseline=Number.isInteger(btcIndex)&&btcIndex>=24?btcCandles.slice(btcIndex-24,btcIndex):[];
    const btcBaselineContiguous=btcBaseline.length===24&&btcBaseline.every((row,index)=>
      index===0||row.openTime-btcBaseline[index-1].openTime===15*60*1000);
    const btcRangeBase=mean(btcBaseline.map(row=>(row.high-row.low)/row.close));
    const btcRangeNow=btcCurrent?(btcCurrent.high-btcCurrent.low)/btcCurrent.close:null;
    const btcVolumeBase=mean(btcBaseline.map(row=>row.quoteVolume));
    const btcTradesBase=mean(btcBaseline.map(row=>row.trades));
    const btcVolumeRatio=btcCurrent&&btcVolumeBase>0?btcCurrent.quoteVolume/btcVolumeBase:null;
    const btcTradeRatio=btcCurrent&&btcTradesBase>0?btcCurrent.trades/btcTradesBase:null;
    const btcDayBaseline=Number.isInteger(btcIndex)&&btcIndex>=96?btcCandles.slice(btcIndex-96,btcIndex):[];
    const btcDayContiguous=btcDayBaseline.length===96&&btcDayBaseline.every((row,index)=>
      index===0||row.openTime-btcDayBaseline[index-1].openTime===15*60*1000);
    const btcFourHourPrior=Number.isInteger(btcIndex)&&btcIndex>=16?btcCandles[btcIndex-16]:null;
    const btcDayPrior=btcDayBaseline[0]||null;
    const btcReturn4h=btcCurrent&&btcFourHourPrior&&btcFourHourPrior.close>0
      ?(btcCurrent.close/btcFourHourPrior.close-1)*100:null;
    const btcReturn24h=btcCurrent&&btcDayPrior&&btcDayPrior.close>0
      ?(btcCurrent.close/btcDayPrior.close-1)*100:null;
    const btcDayRange=btcDayBaseline.map(row=>(row.high-row.low)/row.close);
    const btcDayVolatility=btcDayRange.length?Math.sqrt(mean(btcDayRange.map(value=>value*value))):null;
    const btcDayHigh=btcDayBaseline.length?Math.max(...btcDayBaseline.map(row=>row.high)):null;
    const btcDrawdownFromDayHigh=btcDayHigh>0&&btcCurrent
      ?(btcCurrent.close/btcDayHigh-1)*100:null;
    // Asset's own prior-day context: strictly 96 closed candles before current.
    const assetDayBaseline=candles.slice(index-96,index);
    const assetDayContiguous=assetDayBaseline.length===96&&assetDayBaseline.every((row,offset)=>
      offset===0||row.openTime-assetDayBaseline[offset-1].openTime===15*60*1000);
    const assetFourHourPrior=candles[index-16]||null;
    const assetDayPrior=assetDayBaseline[0]||null;
    const assetReturn4h=assetFourHourPrior&&assetFourHourPrior.close>0
      ?(current.close/assetFourHourPrior.close-1)*100:null;
    const assetReturn24h=assetDayPrior&&assetDayPrior.close>0
      ?(current.close/assetDayPrior.close-1)*100:null;
    const assetDayRanges=assetDayBaseline.map(row=>(row.high-row.low)/row.close);
    const assetDayVolatility=assetDayRanges.length
      ?Math.sqrt(mean(assetDayRanges.map(value=>value*value))):null;
    const assetDayVolumeBase=mean(assetDayBaseline.map(row=>row.quoteVolume));
    const assetDayTradesBase=mean(assetDayBaseline.map(row=>row.trades));
    const assetRelativeReturn24h=assetReturn24h!==null&&btcReturn24h!==null
      ?assetReturn24h-btcReturn24h:null;
    // Align three completed 5m candles to this exact 15m candle and compare
    // them with the preceding 24 completed 5m candles. Older historical windows
    // may not have a full 5m archive. In that case keep the valid 15m/BTC row and
    // emit an explicit micro-availability mask; zero-filled micro channels are
    // never interpreted without the final mask channel.
    const microBase=[];
    const microCurrent=[];
    let microAvailable=true;
    for(let offset=24;offset>=1;offset--){
      const row=fastByOpen.get(Number(current.openTime)-offset*microStep);
      if(!row){microAvailable=false;break;}
      microBase.push(row);
    }
    if(microAvailable){
      for(let offset=0;offset<3;offset++){
        const row=fastByOpen.get(Number(current.openTime)+offset*microStep);
        if(!row){microAvailable=false;break;}
        microCurrent.push(row);
      }
    }
    if(microAvailable){
      const contiguousMicro=[...microBase,...microCurrent].every((row,slot,rows)=>
        slot===0||row.openTime-rows[slot-1].openTime===microStep);
      microAvailable=contiguousMicro&&microCurrent.length===3&&
        microCurrent[2].closeTime===current.closeTime;
    }
    if(!microAvailable){microBase.length=0;microCurrent.length=0;}
    const microBaseVolume=microAvailable?mean(microBase.map(row=>row.quoteVolume)):null;
    const microBaseTrades=microAvailable?mean(microBase.map(row=>row.trades)):null;
    const microBaseRange=microAvailable?mean(microBase.map(row=>(row.high-row.low)/row.close)):null;
    const microBaseBuyVolume=microAvailable?microBase.reduce((sum,row)=>sum+row.takerBuyQuoteVolume,0):null;
    const microBaseTotalVolume=microAvailable?microBase.reduce((sum,row)=>sum+row.quoteVolume,0):null;
    const microBaseBuyShare=microAvailable&&microBaseTotalVolume>0?microBaseBuyVolume/microBaseTotalVolume:null;
    const microCurrentVolume=microAvailable?mean(microCurrent.map(row=>row.quoteVolume)):null;
    const microCurrentTrades=microAvailable?mean(microCurrent.map(row=>row.trades)):null;
    const microCurrentRange=microAvailable?mean(microCurrent.map(row=>(row.high-row.low)/row.close)):null;
    const microBuyVolume=microAvailable?microCurrent.reduce((sum,row)=>sum+row.takerBuyQuoteVolume,0):null;
    const microTotalVolume=microAvailable?microCurrent.reduce((sum,row)=>sum+row.quoteVolume,0):null;
    const microBuyShare=microAvailable&&microTotalVolume>0?microBuyVolume/microTotalVolume:null;
    const microReturnPct=microAvailable?(microCurrent[2].close/microCurrent[0].open-1)*100:null;
    const stepIndex=index-start,stepAt=current.closeTime;
    if(!btcCurrent||!btcPrevious||!(btcPrevious.close>0))
      return fail('BTC_15M_CANDLE_ALIGNMENT_MISSING',stepIndex,stepAt);
    if(!btcBaselineContiguous||!btcDayContiguous)
      return fail('BTC_15M_HISTORY_GAP',stepIndex,stepAt);
    if(!assetDayContiguous)
      return fail('ASSET_96_CANDLE_CONTEXT_GAP',stepIndex,stepAt);
    if(!(volumeBase>0)||!(tradesBase>0)||!(rangeBase>0)||!(buyShare>=0&&buyShare<=1))
      return fail('ASSET_24_CANDLE_FEATURE_BASELINE_INVALID',stepIndex,stepAt);
    if(!(btcRangeBase>0)||!(btcRangeNow>0)||!(btcVolumeRatio>0)||!(btcTradeRatio>0)||
       !Number.isFinite(btcReturn4h)||!Number.isFinite(btcReturn24h)||
       !(btcDayVolatility>0)||!Number.isFinite(btcDrawdownFromDayHigh))
      return fail('BTC_FEATURE_CONTEXT_INVALID',stepIndex,stepAt);
    if(!Number.isFinite(assetReturn4h)||!Number.isFinite(assetReturn24h)||
       !Number.isFinite(assetRelativeReturn24h)||!(assetDayVolatility>0)||
       !(assetDayVolumeBase>0)||!(assetDayTradesBase>0))
      return fail('ASSET_DAILY_FEATURE_CONTEXT_INVALID',stepIndex,stepAt);
    if(microAvailable&&(!(microBaseVolume>0)||!(microBaseTrades>0)||!(microBaseRange>0)||
       !(microBaseBuyShare>=0&&microBaseBuyShare<=1)||!(microBuyShare>=0&&microBuyShare<=1)||
       !(microCurrentVolume>0)||!(microCurrentTrades>0)||!(microCurrentRange>0)))
      return fail('MICRO_5M_FEATURE_CONTEXT_INVALID',stepIndex,stepAt);
    const assetReturn=(current.close/previous.close-1)*100;
    const btcReturn=(btcCurrent.close/btcPrevious.close-1)*100;
    const relativeReturn=assetReturn-btcReturn;
    const values=[
      Math.tanh(assetReturn/2),
      clamp(Math.log2(clamp(current.quoteVolume/volumeBase,0.05,20))/2,-2,2),
      clamp(Math.log2(clamp(current.trades/tradesBase,0.05,20))/2,-2,2),
      clamp((buyShare-0.5)/0.1,-2,2),
      clamp((closeLocation-0.5)*2,-1,1),
      clamp(body,-1,1),
      clamp(Math.log2(clamp(rangeNow/rangeBase,0.05,20)),-2,2),
      Math.tanh(relativeReturn/2),
      microAvailable?clamp(Math.log2(clamp(microCurrentVolume/microBaseVolume,0.05,20))/2,-2,2):0,
      microAvailable?clamp(Math.log2(clamp(microCurrentTrades/microBaseTrades,0.05,20))/2,-2,2):0,
      microAvailable?clamp((microBuyShare-0.5)/0.1,-2,2):0,
      microAvailable?clamp((microBuyShare-microBaseBuyShare)/0.1,-2,2):0,
      microAvailable?Math.tanh(microReturnPct/1):0,
      microAvailable?clamp(Math.log2(clamp(microCurrentRange/microBaseRange,0.05,20)),-2,2):0,
      Math.tanh(btcReturn/2),
      clamp(Math.log2(clamp(btcRangeNow/btcRangeBase,0.05,20)),-2,2),
      clamp(Math.log2(clamp(btcVolumeRatio,0.05,20))/2,-2,2),
      clamp(Math.log2(clamp(btcTradeRatio,0.05,20))/2,-2,2),
      Math.tanh(btcReturn4h/5),
      Math.tanh(btcReturn24h/10),
      Math.tanh(btcDayVolatility*100),
      Math.tanh(btcDrawdownFromDayHigh/5),
      Math.tanh(assetReturn4h/5),
      Math.tanh(assetReturn24h/10),
      Math.tanh(assetRelativeReturn24h/10),
      clamp(Math.log2(clamp(rangeNow/assetDayVolatility,0.05,20)),-2,2),
      clamp(Math.log2(clamp(current.quoteVolume/assetDayVolumeBase,0.05,20))/2,-2,2),
      clamp(Math.log2(clamp(current.trades/assetDayTradesBase,0.05,20))/2,-2,2),
      microAvailable?1:0
    ];
    if (!values.every(Number.isFinite))
      return fail('NON_FINITE_TENSOR_CHANNEL',index-start,current.closeTime);
    sequence.push(values);
  }
  if(sequence.length!==steps)
    return fail('TEMPORAL_SEQUENCE_LENGTH_MISMATCH',sequence.length,null);
  return {sequence,rejection_reason:null,step_index:null,at:null};
}

function buildTemporalSequence(candles,btcCandles,fastCandles) {
  return buildTemporalSequenceWithDiagnostics(candles,btcCandles,fastCandles).sequence;
}

function firstPassageLabel(baseline, future15m) {
  const upLevel = baseline.close * 1.03;
  const downLevel = baseline.close * 0.98;
  const endAt = baseline.closeTime + 4 * 60 * 60 * 1000;
  // TCN target definition is deliberately fixed to 16 closed 15m candles.
  // 5m candles remain useful model inputs, but must never change label resolution
  // across samples in the same chronological training/validation/holdout set.
  const path = (Array.isArray(future15m) ? future15m : []).slice(0,16);
  const complete = path.length === 16 && path.every((row,index) =>
    index === 0
      ? row.openTime === baseline.closeTime + 1
      : row.openTime - path[index - 1].openTime === 15 * 60 * 1000);
  if (!complete || path[15].closeTime !== endAt) return null;
  for (const candle of path) {
    const upHit = candle.high >= upLevel;
    const downHit = candle.low <= downLevel;
    if (upHit && downHit) return {
      outcome:'FLAT', hit:'AMBIGUOUS_BOTH_LEVELS_IN_SAME_CANDLE',
      target_price:null, target_at:candle.closeTime, path_resolution:'15M'
    };
    if (upHit) return {
      outcome:'UP', hit:'TAKE_PROFIT_REACHED_FIRST',
      target_price:upLevel, target_at:candle.closeTime, path_resolution:'15M'
    };
    if (downHit) return {
      outcome:'DOWN', hit:'STOP_LEVEL_REACHED_FIRST',
      target_price:downLevel, target_at:candle.closeTime, path_resolution:'15M'
    };
  }
  return {
    outcome:'FLAT', hit:'NEITHER_LEVEL_REACHED_WITHIN_4H',
    target_price:null, target_at:endAt, path_resolution:'15M'
  };
}

export function scoreAdaptiveTraderCandidate({ symbol, ticker, klines, fastKlines = null, btcKlines = null, now = Date.now(), minQuoteVolume24h = POLICY.minQuoteVolume24h } = {}) {
  const cleanSymbol = String(symbol || ticker?.symbol || '').trim().toUpperCase();
  const lastPrice = finite(ticker?.lastPrice ?? ticker?.last_price);
  const quoteVolume24h = finite(ticker?.quoteVolume ?? ticker?.quote_volume_24h);
  const change24hPct = finite(ticker?.priceChangePercent ?? ticker?.price_change_24h);
  const receivedAt = finite(klines?.receivedAt);
  const scanStartedAt = finite(now) ?? Date.now();
  // REST receive time is local transport metadata, not exchange candle time. A
  // slow scan may finish after scanStartedAt; evaluate candles at the response
  // time instead of misclassifying that fresh response as data from the future.
  const evaluationNow = receivedAt !== null && receivedAt <= scanStartedAt + 5 * 60 * 1000
    ? Math.max(scanStartedAt, receivedAt)
    : scanStartedAt;
  const candles = (Array.isArray(klines?.data) ? klines.data : Array.isArray(klines) ? klines : [])
    .map(row => normalizeCandle(row)).filter(Boolean).filter(candle => candle.closeTime < evaluationNow)
    .sort((a, b) => a.closeTime - b.closeTime);
  const source = String(klines?.source || 'BINANCE_PUBLIC_REST');

  const base = {
    symbol: cleanSymbol,
    price: lastPrice,
    quote_volume_24h: quoteVolume24h,
    change_24h_pct: change24hPct,
    source,
    data_valid: false,
    data_stale: false,
    closed_candles_only: true,
    confidence_score: 'UNKNOWN',
    paper_trading: true,
    real_order_execution: false
  };

  if (!/^[A-Z0-9]{5,30}$/.test(cleanSymbol) || !cleanSymbol.endsWith('USDT') ||
      isLeveragedToken(cleanSymbol) || !(lastPrice > 0) || !(quoteVolume24h >= minQuoteVolume24h) ||
      change24hPct === null) {
    return { ...base, tier: 'DATA_REJECTED', score: null, reason_codes: ['UNIVERSE_OR_TICKER_GATE'] };
  }
  if (receivedAt !== null && (receivedAt > scanStartedAt + 5 * 60 * 1000 || scanStartedAt - receivedAt > 5 * 60 * 1000)) {
    return { ...base, data_stale: true, tier: 'DATA_REJECTED', score: null, reason_codes: ['TICKER_SNAPSHOT_STALE_OR_FUTURE'] };
  }
  if (candles.length < POLICY.minClosedCandles) {
    return { ...base, data_stale: candles.length > 0 && evaluationNow - candles[candles.length - 1].closeTime > POLICY.maxCandleAgeMs,
      tier: 'DATA_REJECTED', score: null, reason_codes: ['INSUFFICIENT_CLOSED_CANDLES'] };
  }

  const current = candles[candles.length - 1];
  const recentWindow = candles.slice(-12);
  const hasCandleGaps = recentWindow.some((candle, index) => index > 0 &&
    candle.openTime - recentWindow[index - 1].openTime !== 15 * 60 * 1000);
  if (hasCandleGaps) {
    return { ...base, tier: 'DATA_REJECTED', score: null, reason_codes: ['CLOSED_CANDLE_GAPS'] };
  }
  const candleAgeMs = evaluationNow - current.closeTime;
  if (candleAgeMs < 0 || candleAgeMs > POLICY.maxCandleAgeMs) {
    return { ...base, data_stale: true, tier: 'DATA_REJECTED', score: null, candle_age_ms: candleAgeMs,
      reason_codes: ['CLOSED_CANDLE_STALE_OR_FUTURE'] };
  }

  const prior8 = candles.slice(-9, -1);
  const prior3 = candles.slice(-4, -1);
  const previous8Ranges = candles.slice(-12, -4).map(c => (c.high - c.low) / c.close * 100);
  const recent4Ranges = candles.slice(-4).map(c => (c.high - c.low) / c.close * 100);
  const volumeBaseline = mean(prior8.map(c => c.quoteVolume));
  const tradeBaseline = mean(prior8.map(c => c.trades));
  const volumeRatio = volumeBaseline > 0 ? current.quoteVolume / volumeBaseline : null;
  const tradeRatio = tradeBaseline > 0 ? current.trades / tradeBaseline : null;
  const takerBuyRatio = current.quoteVolume > 0
    ? current.takerBuyQuoteVolume / current.quoteVolume : null;
  const closeLocation = current.high > current.low
    ? clamp((current.close - current.low) / (current.high - current.low), 0, 1) : 0.5;
  const priorHigh = Math.max(...prior3.map(c => c.high));
  const breakoutAbovePriorHigh = current.close > priorHigh;
  const higherLow = candles[candles.length - 1].low > candles[candles.length - 2].low &&
    candles[candles.length - 2].low >= candles[candles.length - 3].low;
  const priorRange = mean(previous8Ranges);
  const recentRange = mean(recent4Ranges);
  const compressionRatio = priorRange > 0 && recentRange !== null ? recentRange / priorRange : null;
  const compressionScore = compressionRatio === null ? 0 : clamp((1.5 - compressionRatio) / 1.2 * 100, 0, 100);
  const oneHourReturnPct = candles.length >= 5 ? pct(current.close, candles[candles.length - 5].close) : null;
  const shortReturnPct = candles.length >= 2 ? pct(current.close, candles[candles.length - 2].close) : null;
  const return30mPct = candles.length >= 3 ? pct(current.close, candles[candles.length - 3].close) : null;
  const return3hPct = candles.length >= 13 ? pct(current.close, candles[candles.length - 13].close) : null;
  const sma8 = mean(candles.slice(-8).map(candle => candle.close));
  const priorSma8 = mean(candles.slice(-16, -8).map(candle => candle.close));
  const trendAligned = sma8 !== null && priorSma8 !== null && current.close >= sma8 && sma8 >= priorSma8;
  const currentRangePct = current.close > 0 ? (current.high - current.low) / current.close * 100 : null;
  const upperWickPct = current.close > 0 ? (current.high - Math.max(current.open, current.close)) / current.close * 100 : null;
  const lowerWickPct = current.close > 0 ? (Math.min(current.open, current.close) - current.low) / current.close * 100 : null;
  const breakoutDistancePct = priorHigh > 0 ? pct(current.close, priorHigh) : null;
  // Independent closed 5m lens: a failed fast feed is neutral, never fabricated data.
  const fastReceivedAt = finite(fastKlines?.receivedAt);
  const fastEvaluationNow = fastReceivedAt !== null && fastReceivedAt <= scanStartedAt + 5 * 60 * 1000
    ? Math.max(scanStartedAt, fastReceivedAt) : scanStartedAt;
  const fastCandles = (Array.isArray(fastKlines?.data) ? fastKlines.data : Array.isArray(fastKlines) ? fastKlines : [])
    .map(row => normalizeCandle(row, 5 * 60 * 1000)).filter(Boolean)
    .filter(candle => candle.closeTime < fastEvaluationNow).sort((a,b)=>a.closeTime-b.closeTime);
  const fastRecent = fastCandles.slice(-12);
  const fastContiguous = fastRecent.length===12&&fastRecent.every((candle,index)=>
    index===0||candle.openTime-fastRecent[index-1].openTime===5*60*1000);
  const fastLast=fastCandles[fastCandles.length-1];
  const fastAgeMs=fastLast?fastEvaluationNow-fastLast.closeTime:null;
  const microAvailable=Boolean(fastContiguous&&fastLast&&fastAgeMs>=0&&fastAgeMs<=10*60*1000);
  const fastPrior=fastCandles.slice(-9,-1);
  const fastVolumeBaseline=mean(fastPrior.map(candle=>candle.quoteVolume));
  const fastTradeBaseline=mean(fastPrior.map(candle=>candle.trades));
  const microVolumeRatio=microAvailable&&fastVolumeBaseline>0?fastLast.quoteVolume/fastVolumeBaseline:null;
  const microTradeRatio=microAvailable&&fastTradeBaseline>0?fastLast.trades/fastTradeBaseline:null;
  const microTakerBuyRatio=microAvailable&&fastLast.quoteVolume>0?fastLast.takerBuyQuoteVolume/fastLast.quoteVolume:null;
  const microCloseLocation=microAvailable&&fastLast.high>fastLast.low
    ?clamp((fastLast.close-fastLast.low)/(fastLast.high-fastLast.low),0,1):null;
  const microReturnPct=microAvailable&&fastCandles.length>=2
    ?pct(fastLast.close,fastCandles[fastCandles.length-2].close):null;
  const btcReceivedAt = finite(btcKlines?.receivedAt);
  const btcEvaluationNow = btcReceivedAt !== null && btcReceivedAt <= scanStartedAt + 5 * 60 * 1000
    ? Math.max(scanStartedAt, btcReceivedAt)
    : scanStartedAt;
  const btcCandles = (Array.isArray(btcKlines?.data) ? btcKlines.data : Array.isArray(btcKlines) ? btcKlines : [])
    .map(row => normalizeCandle(row)).filter(Boolean).filter(candle => candle.closeTime < btcEvaluationNow).sort((a,b)=>a.closeTime-b.closeTime);
  const btcLast = btcCandles[btcCandles.length-1];
  const btcRecent = btcCandles.slice(-5);
  const btcContiguous = btcRecent.length===5 && btcRecent.every((candle,index)=>index===0||candle.openTime-btcRecent[index-1].openTime===15*60*1000);
  const btcOneHourReturnPct = btcContiguous && btcLast && btcEvaluationNow-btcLast.closeTime<=POLICY.maxCandleAgeMs
    ? pct(btcLast.close,btcCandles[btcCandles.length-5].close) : null;
  const temporalDiagnostics=buildTemporalSequenceWithDiagnostics(candles,btcCandles,fastCandles);
  const temporalSequence=temporalDiagnostics.sequence;
  const relativeStrengthVsBtcPct = oneHourReturnPct!==null&&btcOneHourReturnPct!==null
    ? Number((oneHourReturnPct-btcOneHourReturnPct).toFixed(3)) : null;

  const volumeScore = volumeRatio === null ? 0 : clamp((volumeRatio - 0.5) / 2.5 * 100, 0, 100);
  const tradeScore = tradeRatio === null ? 0 : clamp((tradeRatio - 0.5) / 2.0 * 100, 0, 100);
  const flowScore = takerBuyRatio === null ? 0 : clamp((takerBuyRatio - 0.45) / 0.25 * 100, 0, 100);
  const structureScore = breakoutAbovePriorHigh ? 95 : higherLow ? 74 : closeLocation >= 0.65 ? 56 : 32;
  const relativeStrengthScore = relativeStrengthVsBtcPct===null ? 50 : clamp((relativeStrengthVsBtcPct+2)/4*100,0,100);
  const momentumScore = shortReturnPct===null?50:clamp((shortReturnPct+0.5)/1.5*100,0,100);
  const trendScore = return3hPct===null?50:clamp((return3hPct+2)/6*100,0,100);
  const candleQualityScore = upperWickPct===null||!(currentRangePct>0)?50:clamp(100-(upperWickPct/currentRangePct)*110,0,100);
  const microVolumeScore = microVolumeRatio===null?50:clamp((microVolumeRatio-0.7)/2.0*100,0,100);
  const microTradeScore = microTradeRatio===null?50:clamp((microTradeRatio-0.7)/1.8*100,0,100);
  const microFlowScore = microTakerBuyRatio===null?50:clamp((microTakerBuyRatio-0.45)/0.25*100,0,100);
  const score = Number((
    volumeScore*0.12 + tradeScore*0.08 + flowScore*0.12 + closeLocation*100*0.08 +
    structureScore*0.14 + compressionScore*0.08 + relativeStrengthScore*0.10 +
    momentumScore*0.08 + trendScore*0.04 + candleQualityScore*0.02 +
    microVolumeScore*0.06 + microTradeScore*0.04 + microFlowScore*0.04
  ).toFixed(1));

  const lateMove = change24hPct >= 8 || (oneHourReturnPct !== null && oneHourReturnPct >= 5) ||
    (shortReturnPct !== null && shortReturnPct >= 2.5) || (microReturnPct !== null && microReturnPct >= 3.0);
  const noChase = change24hPct >= -5 && !lateMove && change24hPct <= 7 &&
    (oneHourReturnPct === null || oneHourReturnPct <= 4) &&
    (shortReturnPct === null || shortReturnPct <= 1.5) &&
    (microReturnPct === null || microReturnPct <= 1.8) &&
    (relativeStrengthVsBtcPct === null || relativeStrengthVsBtcPct >= -0.25);
  const earlySetup = score >= 68 && volumeRatio !== null && volumeRatio >= 1.5 &&
    tradeRatio !== null && tradeRatio >= 1.25 && takerBuyRatio !== null && takerBuyRatio >= 0.52 &&
    closeLocation >= 0.58 && (higherLow || breakoutAbovePriorHigh) && noChase;

  let tier = 'NO_SETUP';
  if (lateMove) tier = 'LATE_MOVE';
  else if (earlySetup) tier = 'EARLY_SETUP';
  else if (score >= 52) tier = 'WATCH';
  const reasons = [];
  if (volumeRatio !== null && volumeRatio >= 1.5) reasons.push('VOLUME_ACTIVITY_EXPANDING');
  else reasons.push('VOLUME_ACCELERATION_NOT_CONFIRMED');
  if (tradeRatio !== null && tradeRatio >= 1.25) reasons.push('TRADE_ACTIVITY_EXPANDING');
  else reasons.push('TRADE_ACCELERATION_NOT_CONFIRMED');
  if (takerBuyRatio !== null && takerBuyRatio >= 0.52) reasons.push('BUY_FLOW_POSITIVE');
  else reasons.push('BUY_FLOW_NOT_CONFIRMED');
  if (higherLow) reasons.push('HIGHER_LOW_STRUCTURE');
  if (breakoutAbovePriorHigh) reasons.push('CLOSED_CANDLE_LOCAL_BREAKOUT');
  if (compressionRatio !== null && compressionRatio <= 0.8) reasons.push('VOLATILITY_COMPRESSION');
  if (relativeStrengthVsBtcPct !== null && relativeStrengthVsBtcPct >= 0.25) reasons.push('RELATIVE_STRENGTH_VS_BTC');
  if (relativeStrengthVsBtcPct === null) reasons.push('BTC_BENCHMARK_UNAVAILABLE');
  if (shortReturnPct !== null && shortReturnPct >= 0.15 && shortReturnPct <= 1.5) reasons.push('15M_MOMENTUM_BUILDING');
  if (return3hPct !== null && return3hPct > 0 && trendAligned) reasons.push('MULTI_HOUR_TREND_ALIGNED');
  if (microAvailable && microTakerBuyRatio !== null && microTakerBuyRatio >= 0.55) reasons.push('FIVE_MINUTE_BUY_FLOW_POSITIVE');
  if (microAvailable && microVolumeRatio !== null && microVolumeRatio >= 1.4) reasons.push('FIVE_MINUTE_VOLUME_ACCELERATION');
  if (microReturnPct !== null && microReturnPct >= 3.0) reasons.push('FIVE_MINUTE_MOVE_EXTENDED');
  if (!microAvailable) reasons.push('FIVE_MINUTE_CONFIRMATION_UNAVAILABLE');
  if (upperWickPct !== null && currentRangePct > 0 && upperWickPct / currentRangePct >= 0.55) reasons.push('UPPER_WICK_REJECTION_RISK');
  if (change24hPct < -5) reasons.push('DAILY_DRAWDOWN_BLOCK');
  if (!noChase) reasons.push('ANTI_CHASE_BLOCK');
  if (lateMove) reasons.push('ALREADY_EXTENDED');

  return {
    ...base,
    data_valid: true,
    data_stale: false,
    as_of: new Date(evaluationNow).toISOString(),
    candle_close_time: current.closeTime,
    candle_close_price: current.close,
    candle_age_ms: candleAgeMs,
    temporal_sequence: temporalSequence,
    temporal_sequence_status:temporalSequence?'READY':'UNAVAILABLE',
    temporal_sequence_failure_reason:temporalDiagnostics.rejection_reason,
    temporal_sequence_failure_step:temporalDiagnostics.step_index,
    temporal_sequence_failure_at:temporalDiagnostics.at,
    temporal_sequence_steps: temporalSequence?.length || 0,
    temporal_sequence_channels: temporalSequence?.[0]?.length || 0,
    score,
    tier,
    entry_eligible: false,
    paper_candidate: earlySetup,
    features: {
      volume_ratio: Number((volumeRatio ?? 0).toFixed(3)),
      trade_ratio: Number((tradeRatio ?? 0).toFixed(3)),
      taker_buy_ratio: Number((takerBuyRatio ?? 0).toFixed(4)),
      close_location: Number(closeLocation.toFixed(4)),
      higher_low: higherLow,
      breakout_above_prior_high: breakoutAbovePriorHigh,
      compression_ratio: compressionRatio === null ? null : Number(compressionRatio.toFixed(3)),
      compression_score: Number(compressionScore.toFixed(1)),
      hourly_return_pct: oneHourReturnPct === null ? null : Number(oneHourReturnPct.toFixed(3)),
      return_30m_pct: return30mPct === null ? null : Number(return30mPct.toFixed(3)),
      return_3h_pct: return3hPct === null ? null : Number(return3hPct.toFixed(3)),
      trend_aligned: trendAligned,
      sma8_price: sma8 === null ? null : Number(sma8.toFixed(8)),
      previous_sma8_price: priorSma8 === null ? null : Number(priorSma8.toFixed(8)),
      btc_hourly_return_pct: btcOneHourReturnPct === null ? null : Number(btcOneHourReturnPct.toFixed(3)),
      relative_strength_vs_btc_pct: relativeStrengthVsBtcPct,
      relative_strength_score: Number(relativeStrengthScore.toFixed(1)),
      recent_15m_return_pct: shortReturnPct === null ? null : Number(shortReturnPct.toFixed(3)),
      current_range_pct: currentRangePct === null ? null : Number(currentRangePct.toFixed(3)),
      upper_wick_pct: upperWickPct === null ? null : Number(upperWickPct.toFixed(3)),
      lower_wick_pct: lowerWickPct === null ? null : Number(lowerWickPct.toFixed(3)),
      breakout_distance_pct: breakoutDistancePct === null ? null : Number(breakoutDistancePct.toFixed(3)),
      momentum_score: Number(momentumScore.toFixed(1)),
      trend_score: Number(trendScore.toFixed(1)),
      candle_quality_score: Number(candleQualityScore.toFixed(1)),
      micro_5m_available: microAvailable,
      micro_5m_age_ms: fastAgeMs===null?null:Math.max(0,Math.trunc(fastAgeMs)),
      micro_5m_volume_ratio: microVolumeRatio === null ? null : Number(microVolumeRatio.toFixed(3)),
      micro_5m_trade_ratio: microTradeRatio === null ? null : Number(microTradeRatio.toFixed(3)),
      micro_5m_taker_buy_ratio: microTakerBuyRatio === null ? null : Number(microTakerBuyRatio.toFixed(4)),
      micro_5m_close_location: microCloseLocation === null ? null : Number(microCloseLocation.toFixed(4)),
      micro_5m_return_pct: microReturnPct === null ? null : Number(microReturnPct.toFixed(3)),
      base_price: current.close
    },
    reason_codes: reasons,
    thresholds: {
      min_quote_volume_24h: minQuoteVolume24h,
      no_chase: noChase,
      late_move: lateMove,
      policy_revision: 'ADAPTIVE_SIDECAR_V1'
    }
  };
}

/**
 * Build matured, leak-free training examples from historical Binance Spot
 * candles. Each feature snapshot is evaluated using only bars closed at or
 * before its baseline timestamp; its +4h label comes from later closed bars.
 */
export function buildAdaptiveTraderHistoricalOutcomeSamples({
  symbol,klines,fastKlines=null,btcKlines=null,now=Date.now(),
  minQuoteVolume24h=POLICY.minQuoteVolume24h,maxSamples=8
}={}){
  const cleanSymbol=String(symbol||'').trim().toUpperCase();
  if(!/^[A-Z0-9]{5,30}$/.test(cleanSymbol)||!cleanSymbol.endsWith('USDT')||isLeveragedToken(cleanSymbol))return [];
  const rows=Array.isArray(klines?.data)?klines.data:Array.isArray(klines)?klines:[];
  const candles=rows.map(raw=>({raw,candle:normalizeCandle(raw)}))
    .filter(item=>item.candle&&item.candle.closeTime<Number(now))
    .sort((a,b)=>a.candle.closeTime-b.candle.closeTime);
  const fastRows=Array.isArray(fastKlines?.data)?fastKlines.data:Array.isArray(fastKlines)?fastKlines:[];
  const fastCandles=fastRows.map(raw=>({raw,candle:normalizeCandle(raw,5*60*1000)}))
    .filter(item=>item.candle&&item.candle.closeTime<Number(now))
    .sort((a,b)=>a.candle.closeTime-b.candle.closeTime);
  const btcRows=Array.isArray(btcKlines?.data)?btcKlines.data:Array.isArray(btcKlines)?btcKlines:[];
  const btcCandles=btcRows.map(raw=>({raw,candle:normalizeCandle(raw)}))
    .filter(item=>item.candle&&item.candle.closeTime<Number(now))
    .sort((a,b)=>a.candle.closeTime-b.candle.closeTime);
  const btcByClose=new Map(btcCandles.map(item=>[item.candle.closeTime,item.candle]));
  const horizonBars=16,dayBars=96;
  const generationAudit={
    phase_anchors:0,selected_anchors:0,
    skipped_incomplete_asset_15m_tensor_history:0,
    tensor_rejection_counts:{},candidate_rejection_counts:{},
    rejected_samples:[],samples_emitted:0
  };
  const recordRejection=(bucket,reason,details={})=>{
    const key=String(reason||'UNKNOWN_REJECTION');
    const counts=bucket==='tensor'?generationAudit.tensor_rejection_counts:
      generationAudit.candidate_rejection_counts;
    counts[key]=(counts[key]||0)+1;
    generationAudit.rejected_samples.push({
      symbol:cleanSymbol,reason:key,...details
    });
  };
  const possible=[];
  // A 24-step tensor needs 96 day-context candles before its first step, then 24 model steps.
  for(let index=Math.max(dayBars,119);index+horizonBars<candles.length;index++){
    const sequence=candles.slice(index-dayBars,index+horizonBars+1);
    if(sequence.length!==dayBars+horizonBars+1||
      sequence.some((item,offset)=>offset>0&&item.candle.openTime-sequence[offset-1].candle.openTime!==15*60*1000))continue;
    const baseline=candles[index].candle,future=candles[index+horizonBars].candle;
    if(future.closeTime-baseline.closeTime!==4*60*60*1000)continue;
    const volume24h=candles.slice(index-dayBars+1,index+1)
      .reduce((sum,item)=>sum+item.candle.quoteVolume,0);
    if(!(volume24h>=minQuoteVolume24h))continue;
    const dailyReturn=pct(baseline.close,candles[index-dayBars].candle.close);
    if(dailyReturn===null)continue;
    // A 24x29 tensor contains 24 steps, each requiring 96 prior closed
    // candles. Its earliest step therefore needs the full 120-candle
    // history ending at this baseline, not merely the 96 bars used by the
    // tabular candidate snapshot. Audit this before candidate selection.
    const tensorHistory=candles.slice(index-119,index+1);
    const tensorWarmupReady=tensorHistory.length===120&&tensorHistory.every((item,offset)=>
      offset===0||item.candle.openTime-tensorHistory[offset-1].candle.openTime===15*60*1000);
    const absolute15mBar=Math.floor((baseline.closeTime+1)/(15*60*1000));
    possible.push({index,absolute15mBar,volume24h,dailyReturn,baseline,future,tensorWarmupReady});
  }
  const desired=Math.max(1,Math.min(118,Math.trunc(Number(maxSamples)||48)));
  // Anchor each symbol to a stable phase on the absolute 4h time grid. Using
  // the Binance candle timestamp (not its page-relative row index) means a
  // rolling 2,000-candle window cannot shift the phase and create overlapping
  // labels across repeated scans. The hash only staggers symbols across time.
  let phaseHash=2166136261;
  for(const char of cleanSymbol){
    phaseHash^=char.charCodeAt(0);
    phaseHash=Math.imul(phaseHash,16777619)>>>0;
  }
  const samplingPhase=phaseHash%horizonBars;
  const phaseRows=possible.filter(item=>item.absolute15mBar%horizonBars===samplingPhase);
  generationAudit.phase_anchors=phaseRows.length;
  for(const item of phaseRows){
    if(item.tensorWarmupReady!==true){
      generationAudit.skipped_incomplete_asset_15m_tensor_history++;
      recordRejection('tensor','ASSET_15M_TENSOR_WARMUP_GAP',{
        id:'HISTORICAL_FIRST_PASSAGE_CLOSED_CANDLE:'+cleanSymbol+':'+String(item.baseline.closeTime),
        at:item.baseline.closeTime,baseline_index:item.index
      });
    }
  }
  const tensorReadyPhaseRows=phaseRows.filter(item=>item.tensorWarmupReady===true);
  const selectedCount=Math.min(desired,tensorReadyPhaseRows.length);
  generationAudit.selected_anchors=selectedCount;
  const selected=[];
  if(selectedCount>0&&selectedCount<=64){
    // Preserve the original 64-row schedule for stable IDs when the quota grows.
    if(selectedCount===1)selected.push(tensorReadyPhaseRows.at(-1));
    else for(let slot=0;slot<selectedCount;slot++){
      const index=Math.round(slot*(tensorReadyPhaseRows.length-1)/(selectedCount-1));
      selected.push(tensorReadyPhaseRows[index]);
    }
  }else if(selectedCount>64){
    const legacyCount=Math.min(64,tensorReadyPhaseRows.length);
    const legacyIndexes=new Set();
    for(let slot=0;slot<legacyCount;slot++){
      const index=legacyCount===1?tensorReadyPhaseRows.length-1:
        Math.round(slot*(tensorReadyPhaseRows.length-1)/(legacyCount-1));
      legacyIndexes.add(index);
    }
    const remainingIndexes=tensorReadyPhaseRows.map((_,index)=>index)
      .filter(index=>!legacyIndexes.has(index));
    const extraCount=Math.max(0,selectedCount-legacyIndexes.size);
    const extraIndexes=[];
    if(extraCount===1){extraIndexes.push(remainingIndexes[Math.floor((remainingIndexes.length-1)/2)]);}
    else if(extraCount>1){
      for(let slot=0;slot<extraCount;slot++){
        extraIndexes.push(remainingIndexes[Math.round(slot*(remainingIndexes.length-1)/(extraCount-1))]);
      }
    }
    for(const index of [...legacyIndexes,...extraIndexes].filter(Number.isInteger).sort((a,b)=>a-b))
      selected.push(tensorReadyPhaseRows[index]);
  }
  const out=[];
  // Selected anchors are chronological. Advance each reference-series cursor
  // once instead of filtering the full 12-month BTC/5m history for every sample.
  // This preserves the exact <=baseline cutoff while changing archive replay
  // from repeated O(history × samples) scans to a linear pass plus bounded slices.
  selected.sort((a,b)=>a.index-b.index);
  let btcCursor=-1,fastCursor=-1;
  for(const item of selected){
    const {index,volume24h,dailyReturn,baseline,future}=item;
    const evaluationNow=baseline.closeTime+1;
    const priorDay=candles[index-dayBars].candle;
    const btcCurrent=btcByClose.get(baseline.closeTime);
    const btcPrior=btcByClose.get(priorDay.closeTime);
    const btcDailyReturn=btcCurrent&&btcPrior?pct(btcCurrent.close,btcPrior.close):null;
    // TCN requires 96 prior closed 15m candles for asset-day context plus 24 model steps.
    // Keep this historical replay slice wide enough to build the same 24x29 tensor as live scans.
    const baselineRaw=candles.slice(Math.max(0,index-119),index+1).map(row=>row.raw);
    while(btcCursor+1<btcCandles.length&&
      btcCandles[btcCursor+1].candle.closeTime<=baseline.closeTime)btcCursor++;
    while(fastCursor+1<fastCandles.length&&
      fastCandles[fastCursor+1].candle.closeTime<=baseline.closeTime)fastCursor++;
    const btcEnd=btcCursor+1,fastEnd=fastCursor+1;
    const baseBtcRaw=btcEnd>0
      ?btcCandles.slice(Math.max(0,btcEnd-1000),btcEnd).map(row=>row.raw):[];
    const baseFastRaw=fastEnd>0
      ?fastCandles.slice(Math.max(0,fastEnd-720),fastEnd).map(row=>row.raw):[];
    const ticker={
      symbol:cleanSymbol,lastPrice:String(baseline.close),
      quoteVolume:String(volume24h),priceChangePercent:String(dailyReturn)
    };
    const candidate=scoreAdaptiveTraderCandidate({
      symbol:cleanSymbol,ticker,
      klines:{data:baselineRaw,source:klines?.source||'BINANCE_PUBLIC_REST',receivedAt:evaluationNow},
      fastKlines:{data:baseFastRaw,source:fastKlines?.source||'BINANCE_PUBLIC_REST',receivedAt:evaluationNow},
      btcKlines:{data:baseBtcRaw,source:btcKlines?.source||'BINANCE_PUBLIC_REST',receivedAt:evaluationNow},
      now:evaluationNow,minQuoteVolume24h
    });
    if(candidate.data_valid!==true||candidate.data_stale===true||!Number.isFinite(future.close)||!(baseline.close>0)){
      recordRejection('candidate','HISTORICAL_CANDIDATE_DATA_INVALID',{
        id:'HISTORICAL_FIRST_PASSAGE_CLOSED_CANDLE:'+cleanSymbol+':'+String(baseline.closeTime),
        at:baseline.closeTime,reason_codes:candidate.reason_codes||[]
      });
      continue;
    }
    const tensor=candidate.temporal_sequence;
    const tensorValid=Array.isArray(tensor)&&tensor.length===24&&
      tensor.every(step=>Array.isArray(step)&&step.length===29&&step.every(Number.isFinite));
    if(!tensorValid){
      recordRejection('tensor',candidate.temporal_sequence_failure_reason||'TEMPORAL_SEQUENCE_SHAPE_INVALID',{
        id:'HISTORICAL_FIRST_PASSAGE_CLOSED_CANDLE:'+cleanSymbol+':'+String(baseline.closeTime),
        at:baseline.closeTime,step_index:candidate.temporal_sequence_failure_step??null,
        failure_at:candidate.temporal_sequence_failure_at??null
      });
      continue;
    }
    const move=(future.close/baseline.close-1)*100;
    const passage=firstPassageLabel(baseline,candles.slice(index+1,index+17).map(item=>item.candle));
    if(!passage){
      recordRejection('candidate','FIRST_PASSAGE_LABEL_UNAVAILABLE',{
        id:'HISTORICAL_FIRST_PASSAGE_CLOSED_CANDLE:'+cleanSymbol+':'+String(baseline.closeTime),
        at:baseline.closeTime
      });
      continue;
    }
    const outcome=passage.outcome;
    const features={
      ...(candidate.features||{}),
      quote_volume_24h:Number(volume24h.toFixed(2)),
      change_24h_pct:Number(dailyReturn.toFixed(3)),
      relative_24h_strength_vs_btc_pct:btcDailyReturn===null?null:Number((dailyReturn-btcDailyReturn).toFixed(3))
    };
    out.push({
      id:'HISTORICAL_FIRST_PASSAGE_CLOSED_CANDLE:'+cleanSymbol+':'+String(baseline.closeTime),
      symbol:cleanSymbol,price:baseline.close,at:baseline.closeTime,
      base_score:Number(candidate.score),tier:String(candidate.tier||'NO_SETUP'),
      observation_type:'HISTORICAL_CLOSED_CANDLE',historical_baseline:true,training_eligible:true,
      quote_volume_24h:Number(volume24h.toFixed(2)),change_24h_pct:Number(dailyReturn.toFixed(3)),
      selection_lane:'HISTORICAL_CLOSED_CANDLE',features,outcome,
      temporal_sequence:candidate.temporal_sequence,
      target_definition:'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2',
      first_passage:passage,
      outcome_source:'HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1',
      mark_price:future.close,
      return_pct:Number((passage.outcome==='UP'?3:passage.outcome==='DOWN'?-2:move).toFixed(3)),
      close_return_pct:Number(move.toFixed(3)),close_return_source:'FOUR_HOUR_TERMINAL_CLOSE',
      resolved_at:future.closeTime,horizon_ms:future.closeTime-baseline.closeTime
    });
  }
  generationAudit.samples_emitted=out.length;
  Object.defineProperty(out,'generation_audit',{
    value:generationAudit,enumerable:false,configurable:false,writable:false
  });
  return out;
}

export function buildAdaptiveTraderClosedCandleOutcomeLabels({symbol,klines,fastKlines=null,pendingSamples=[],now=Date.now()}={}){
  const cleanSymbol=String(symbol||'').trim().toUpperCase();
  if(!/^[A-Z0-9]{5,30}$/.test(cleanSymbol)||!cleanSymbol.endsWith('USDT'))return [];
  const rows=Array.isArray(klines?.data)?klines.data:Array.isArray(klines)?klines:[];
  const candles=rows.map(row=>normalizeCandle(row)).filter(candle=>candle&&candle.closeTime<Number(now)).sort((a,b)=>a.closeTime-b.closeTime);
  if(!candles.length)return [];
  const fastRows=Array.isArray(fastKlines?.data)?fastKlines.data:Array.isArray(fastKlines)?fastKlines:[];
  const fastCandles=fastRows.map(row=>normalizeCandle(row,5*60*1000))
    .filter(candle=>candle&&candle.closeTime<Number(now)).sort((a,b)=>a.closeTime-b.closeTime);
  const byClose=new Map(candles.map(candle=>[candle.closeTime,candle]));
  const out=[];
  for(const sample of (Array.isArray(pendingSamples)?pendingSamples:[])){
    if(String(sample?.symbol||'').trim().toUpperCase()!==cleanSymbol||sample?.closed_candle_baseline!==true||
       sample?.training_eligible!==true||sample?.target_definition!=='FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2'||
       sample?.outcome)continue;
    const at=finite(sample?.at),baselinePrice=finite(sample?.price);
    if(at===null||!(baselinePrice>0)||Number(now)-at<4*60*60*1000)continue;
    const baseline=byClose.get(at),future=byClose.get(at+4*60*60*1000);
    if(!baseline||!future||future.closeTime-baseline.closeTime!==4*60*60*1000)continue;
    if(Math.abs(baseline.close-baselinePrice)>Math.max(1e-12,Math.abs(baseline.close)*1e-8))continue;
    const move=(future.close/baseline.close-1)*100;
    const startIndex=candles.findIndex(candle=>candle.closeTime===baseline.closeTime);
    const passage=firstPassageLabel(baseline,candles.slice(startIndex+1,startIndex+17));
    if(!passage)continue;
    out.push({sample_id:String(sample.id||''),symbol:cleanSymbol,at:baseline.closeTime,
      baseline_price:baseline.close,mark_price:future.close,
      outcome:passage.outcome,first_passage:passage,
      target_definition:'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2',
      return_pct:Number((passage.outcome==='UP'?3:passage.outcome==='DOWN'?-2:move).toFixed(3)),
      close_return_pct:Number(move.toFixed(3)),close_return_source:'FOUR_HOUR_TERMINAL_CLOSE',
      resolved_at:future.closeTime,horizon_ms:future.closeTime-baseline.closeTime,
      outcome_source:'CLOSED_CANDLE_4H_FIRST_PASSAGE_V1'});
  }
  return out;
}

function attachClosedCandleOutcomes(snapshot,outcomes){
  // Both arrays are intentionally non-enumerable so the public API does not
  // serialize large training payloads. Preserve the historical array explicitly:
  // spreading a snapshot drops non-enumerable properties, which previously meant
  // the worker saw historical_training_samples_available > 0 but received no rows.
  const result={...snapshot};
  Object.defineProperty(result,'historical_training_samples',{
    value:Array.isArray(snapshot?.historical_training_samples)?snapshot.historical_training_samples:[],
    enumerable:false,configurable:false,writable:false
  });
  Object.defineProperty(result,'closed_candle_outcomes',{value:Array.isArray(outcomes)?outcomes:[],
    enumerable:false,configurable:false,writable:false});
  return result;
}

function attachHistoricalTrainingSamples(snapshot,samples){
  const result={...snapshot};
  Object.defineProperty(result,'historical_training_samples',{
    value:Array.isArray(samples)?samples:[],enumerable:false,configurable:false,writable:false
  });
  // Preserve outcome labels when the other non-enumerable training payload is
  // reattached to a cached snapshot.
  Object.defineProperty(result,'closed_candle_outcomes',{
    value:Array.isArray(snapshot?.closed_candle_outcomes)?snapshot.closed_candle_outcomes:[],
    enumerable:false,configurable:false,writable:false
  });
  return result;
}

async function mapLimit(items, limit, worker) {
  const result = new Array(items.length);
  let cursor = 0;
  const runner = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { result[index] = await worker(items[index], index); }
      catch (error) { result[index] = { error: String(error?.message || error).slice(0, 160) }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, runner));
  return result;
}


/**
 * Summarize one public Spot depth snapshot. It is evidence about visible
 * liquidity at one instant, not proof of spoofing, hidden orders or trader
 * identity. The caller bounds requests to a handful of strongest candidates.
 */
export function summarizePublicSpotOrderBook(response, now = Date.now()) {
  const root=response&&typeof response==='object'?response:{};
  const data=root.data&&typeof root.data==='object'?root.data:root;
  const receivedAt=finite(root.receivedAt??root.received_at??data.receivedAt)??Number(now);
  const ageMs=Number(now)-receivedAt;
  const bids=(Array.isArray(data.bids)?data.bids:[]).map(level=>({
    price:finite(Array.isArray(level)?level[0]:level?.price),
    quantity:finite(Array.isArray(level)?level[1]:level?.quantity)
  })).filter(x=>x.price>0&&x.quantity>=0).sort((a,b)=>b.price-a.price);
  const asks=(Array.isArray(data.asks)?data.asks:[]).map(level=>({
    price:finite(Array.isArray(level)?level[0]:level?.price),
    quantity:finite(Array.isArray(level)?level[1]:level?.quantity)
  })).filter(x=>x.price>0&&x.quantity>=0).sort((a,b)=>a.price-b.price);
  if(ageMs<0||ageMs>15_000||!bids.length||!asks.length||bids[0].price>=asks[0].price){
    return {order_book_checked:false,order_book_status:ageMs>15_000?'STALE_OR_INVALID_DEPTH':'DEPTH_UNAVAILABLE',
      order_book_received_at:receivedAt,order_book_age_ms:Number.isFinite(ageMs)?Math.trunc(ageMs):null,
      spoofing_assessment:'NOT_ASSESSABLE_SINGLE_SNAPSHOT'};
  }
  const bestBid=bids[0].price,bestAsk=asks[0].price,mid=(bestBid+bestAsk)/2;
  const spreadBps=(bestAsk-bestBid)/mid*10_000;
  const bidDepth=bids.filter(x=>x.price>=mid*0.995).reduce((sum,x)=>sum+x.price*x.quantity,0);
  const askDepth=asks.filter(x=>x.price<=mid*1.005).reduce((sum,x)=>sum+x.price*x.quantity,0);
  const depthTotal=bidDepth+askDepth;
  const ratio=askDepth>0?Math.min(50,bidDepth/askDepth):bidDepth>0?50:null;
  const imbalance=depthTotal>0?(bidDepth-askDepth)/depthTotal*100:null;
  return {
    order_book_checked:true,order_book_status:'SINGLE_PUBLIC_SPOT_SNAPSHOT',
    order_book_received_at:receivedAt,order_book_age_ms:Math.max(0,Math.trunc(ageMs)),
    order_book_best_bid:bestBid,order_book_best_ask:bestAsk,order_book_mid_price:mid,
    order_book_spread_bps:Number(spreadBps.toFixed(2)),
    order_book_bid_depth_quote_05pct:Number(bidDepth.toFixed(2)),
    order_book_ask_depth_quote_05pct:Number(askDepth.toFixed(2)),
    order_book_bid_ask_depth_ratio:ratio===null?null:Number(ratio.toFixed(3)),
    order_book_imbalance_pct:imbalance===null?null:Number(imbalance.toFixed(1)),
    order_book_persistence_samples:1,
    spoofing_assessment:'NOT_ASSESSABLE_SINGLE_SNAPSHOT'
  };
}

export async function buildAdaptiveTraderMarketSnapshot({ rest, limit = POLICY.defaultUniverseLimit, now = Date.now(),
  offset = 0, retrySymbols = [], previousSnapshot = null, pendingSamples = [], minQuoteVolume24h = POLICY.minQuoteVolume24h } = {}) {
  if (!rest || typeof rest.request !== 'function') throw new Error('ADAPTIVE_TRADER_REST_UNAVAILABLE');
  const safeLimit = clamp(Math.trunc(Number(limit) || POLICY.defaultUniverseLimit), 20, POLICY.maxUniverseLimit);
  // BTC is only a comparative benchmark. A failure to fetch it must not block
  // the entire Spot universe when valid per-symbol closed candles are available.
  const [exchangeInfo, tickerResult, btcResult] = await Promise.all([
    rest.request('/api/v3/exchangeInfo'),
    rest.request('/api/v3/ticker/24hr'),
    rest.request('/api/v3/klines', { symbol: 'BTCUSDT', interval: '15m', limit: 1000 })
      .then(value => ({value,error:null}))
      .catch(error => ({value:null,error:String(error?.message??error).slice(0,160)}))
  ]);
  let btcKlines = btcResult.value;
  if(Array.isArray(btcKlines?.data)&&btcKlines.data.length){
    const earliestOpen=finite(btcKlines.data[0]?.[0]);
    if(earliestOpen!==null){
      try{
        const older=await rest.request('/api/v3/klines',{
          symbol:'BTCUSDT',interval:'15m',limit:1000,endTime:earliestOpen-1
        });
        btcKlines=mergeOlderKlinePage(btcKlines,older);
      }catch(error){
        btcKlines={...btcKlines,historical_pages_fetched:1,
          historical_window_candles:btcKlines.data.length,
          historical_backfill_error:String(error?.message??error).slice(0,120)};
      }
    }
  }
  const symbolInfo = Array.isArray(exchangeInfo?.data?.symbols) ? exchangeInfo.data.symbols : [];
  const activeSpot = new Set(symbolInfo.filter(item =>
    item && item.status === 'TRADING' && item.quoteAsset === 'USDT' &&
    item.isSpotTradingAllowed !== false &&
    (!Array.isArray(item.permissions) || item.permissions.length === 0 || item.permissions.includes('SPOT'))
  ).map(item => String(item.symbol || '').toUpperCase()));
  const tickers = Array.isArray(tickerResult?.data) ? tickerResult.data : [];
  const previousAsOf = Date.parse(String(previousSnapshot?.as_of || ''));
  const previousSnapshotAgeMs = Number.isFinite(previousAsOf) ? Number(now) - previousAsOf : null;
  const previousPriceRows = Array.isArray(previousSnapshot?.latest_prices) ? previousSnapshot.latest_prices : [];
  const previousPrices = new Map(previousPriceRows
    .map(row => [String(row?.symbol || '').toUpperCase(), finite(row?.price)]));
  const previousTickerRows = new Map(previousPriceRows
    .map(row => [String(row?.symbol || '').toUpperCase(), row]));
  const marketTickers = tickers.filter(row => {
    const symbol = String(row?.symbol || '').toUpperCase();
    return activeSpot.has(symbol) && symbol.endsWith('USDT') && !isLeveragedToken(symbol) &&
      finite(row?.lastPrice) > 0 && finite(row?.quoteVolume) !== null && finite(row?.priceChangePercent) !== null;
  }).map(row => {
    const symbol=String(row.symbol||'').toUpperCase(),price=finite(row.lastPrice);
    const previousPrice=previousPrices.get(symbol);
    const pulseFresh=previousSnapshotAgeMs!==null&&previousSnapshotAgeMs>=0&&previousSnapshotAgeMs<=10*60*1000;
    return {...row,move_since_previous_pct:pulseFresh&&previousPrice>0
      ?Number(((price/previousPrice-1)*100).toFixed(3)):null};
  });
  const eligible = marketTickers.filter(row => finite(row?.quoteVolume) >= minQuoteVolume24h)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume));
  const scanOffset = eligible.length
    ? Math.max(0, Math.trunc(Number(offset) || 0)) % eligible.length
    : 0;
  const selectedCount = Math.min(safeLimit, eligible.length);
  const eligibleBySymbol = new Map(eligible.map(row=>[String(row.symbol||'').toUpperCase(),row]));
  const changePct = row => finite(row?.priceChangePercent);
  // Deep-scan slots are split across liquid leaders, emerging movers and an
  // explicitly audit-only lane for already-extended movers. This lets the
  // trader recognize missed rallies without treating them as new entries.
  const emergingMovers = eligible.filter(row => {
    const change = changePct(row);
    return change !== null && change >= 0.15 && change < 4.5;
  }).sort((a,b) => {
    const rank = row => clamp(100 - Math.abs((changePct(row) ?? -100) - 4.0) * 15, 0, 100);
    return rank(b)-rank(a) ||
      Number(b.quoteVolume)-Number(a.quoteVolume) ||
      String(a.symbol||'').localeCompare(String(b.symbol||''));
  });
  // A separate ticker-counter lane finds participation shocks before the daily
  // percentage move becomes obvious. This is only a deep-scan priority: every
  // candidate still passes the closed-candle, data-quality, liquidity, flow,
  // anti-chase and analyst gates before it can become a watch or recommendation.
  const activityWindowMs = Number.isFinite(previousSnapshotAgeMs) &&
    previousSnapshotAgeMs >= 20_000 && previousSnapshotAgeMs <= 10 * 60_000
    ? previousSnapshotAgeMs : null;
  const activityAccelerationMovers = activityWindowMs === null ? [] : eligible.map(row => {
    const symbol=String(row?.symbol||'').toUpperCase();
    const prior=previousTickerRows.get(symbol);
    const currentQuote=finite(row?.quoteVolume);
    const priorQuote=finite(prior?.quote_volume_24h);
    const currentTrades=finite(row?.count);
    const priorTrades=finite(prior?.trade_count_24h);
    if (![currentQuote,priorQuote,currentTrades,priorTrades].every(Number.isFinite) ||
        currentQuote<=0 || priorQuote<0 || currentTrades<=0 || priorTrades<0) return null;
    const minutes=activityWindowMs/60_000;
    const volumeRate=Math.max(0,currentQuote-priorQuote)/minutes;
    const tradeRate=Math.max(0,currentTrades-priorTrades)/minutes;
    const averageVolumeRate=Math.max(1,currentQuote/1440);
    const averageTradeRate=Math.max(0.1,currentTrades/1440);
    const volumeRatio=volumeRate/averageVolumeRate;
    const tradeRatio=tradeRate/averageTradeRate;
    const daily=changePct(row);
    const pulse=finite(row?.move_since_previous_pct);
    // Exclude already extended daily/short-term moves from the early lane.
    if (daily===null || daily < -5 || daily > 7 || (pulse!==null && pulse > 2.5) ||
        volumeRate < Math.max(150,averageVolumeRate*1.5) ||
        tradeRate < Math.max(1,averageTradeRate*1.3)) return null;
    const score=Number((Math.log2(Math.max(1,volumeRatio))*35+
      Math.log2(Math.max(1,tradeRatio))*25+
      Math.min(15,Math.max(0,pulse||0)*5)).toFixed(3));
    return {
      row,score,
      evidence:{
        observed_at:Number(now),
        baseline_age_ms:activityWindowMs,
        volume_delta_usdt_per_min:Number(volumeRate.toFixed(2)),
        volume_rate_vs_24h_average:Number(volumeRatio.toFixed(3)),
        trade_delta_per_min:Number(tradeRate.toFixed(3)),
        trade_rate_vs_24h_average:Number(tradeRatio.toFixed(3)),
        short_term_price_change_pct:pulse
      }
    };
  }).filter(Boolean).sort((a,b)=>b.score-a.score ||
    b.evidence.volume_rate_vs_24h_average-a.evidence.volume_rate_vs_24h_average ||
    b.evidence.trade_rate_vs_24h_average-a.evidence.trade_rate_vs_24h_average ||
    String(a.row.symbol||'').localeCompare(String(b.row.symbol||'')));
  const extendedMovers = eligible.filter(row => {
    const change = changePct(row);
    return change !== null && change >= 8;
  }).sort((a,b) =>
    Number(changePct(b))-Number(changePct(a)) ||
    Number(b.quoteVolume)-Number(a.quoteVolume) ||
    String(a.symbol||'').localeCompare(String(b.symbol||''))
  );
  const selectedBySymbol = new Map();
  const retrySet = new Set();
  // A broken endpoint should not consume the whole scan forever. Retry at most
  // 20% of a batch and rotate unattempted retries ahead of repeated failures.
  const retryLimit = Math.min(selectedCount, Math.max(1, Math.floor(selectedCount * 0.20)));
  for (const symbol of (Array.isArray(retrySymbols)?retrySymbols:[])) {
    const clean=String(symbol||'').trim().toUpperCase();
    const row=eligibleBySymbol.get(clean);
    if (!row || retrySet.has(clean) || retrySet.size>=retryLimit) continue;
    retrySet.add(clean);
    selectedBySymbol.set(clean,{...row,selection_lane:'RETRY'});
  }
  const coveragePlan=buildAdaptiveTraderCoveragePlan(eligible.length,selectedCount);
  const rotationReserve=coveragePlan.rotation_slots_per_cycle;
  const priorityBudget = Math.max(0,selectedCount-rotationReserve);
  const addLane = (rows,quota,lane) => {
    let added=0;
    for (const row of rows) {
      if (selectedBySymbol.size>=priorityBudget || selectedBySymbol.size>=selectedCount || added>=quota) break;
      const symbol=String(row?.symbol||'').trim().toUpperCase();
      if (!symbol || selectedBySymbol.has(symbol)) continue;
      selectedBySymbol.set(symbol,{...row,selection_lane:lane});
      added++;
    }
  };
  const volumeLeaders = eligible.filter(row => {
    const change=changePct(row);
    return change===null || change<8;
  });
  const accelerationMovers = eligible.filter(row => {
    const pulse=finite(row?.move_since_previous_pct),daily=changePct(row);
    return pulse!==null&&pulse>=0.12&&pulse<4.5&&daily!==null&&daily>=-5&&daily<8&&!isLeveragedToken(row.symbol);
  }).sort((a,b)=>(Number(b.move_since_previous_pct)||0)-(Number(a.move_since_previous_pct)||0)||
    Number(b.quoteVolume)-Number(a.quoteVolume)||String(a.symbol||'').localeCompare(String(b.symbol||'')));
  // A large very-short-term pulse used to fall outside the acceleration lane.
  // It is now deep-scanned as an audit-only event, never as an automatic entry.
  const burstMovers = eligible.filter(row => {
    const pulse=finite(row?.move_since_previous_pct);
    return pulse!==null&&pulse>=4.5;
  }).sort((a,b)=>(Number(b.move_since_previous_pct)||0)-(Number(a.move_since_previous_pct)||0)||
    Number(b.quoteVolume)-Number(a.quoteVolume)||String(a.symbol||'').localeCompare(String(b.symbol||'')));
  addLane(volumeLeaders,Math.ceil(selectedCount*0.15),'TOP_VOLUME');
  // Counter-based participation acceleration gets its own quota before price
  // pulses and daily movers, so quiet accumulation candidates are not starved.
  const activityQuota=Math.ceil(selectedCount*0.20);
  let activityAdded=0;
  for (const item of activityAccelerationMovers) {
    if(selectedBySymbol.size>=priorityBudget||activityAdded>=activityQuota)break;
    const symbol=String(item.row?.symbol||'').toUpperCase();
    if(!symbol||selectedBySymbol.has(symbol))continue;
    selectedBySymbol.set(symbol,{...item.row,selection_lane:'MARKET_ACTIVITY_ACCELERATION',
      market_activity_acceleration:item.evidence});
    activityAdded++;
  }
  // Short-term price pulses outrank the broad daily-mover bucket so a coin
  // cannot be consumed by the latter before its acceleration is deep-scanned.
  addLane(accelerationMovers,Math.ceil(selectedCount*0.20),'PRICE_ACCELERATION');
  addLane(burstMovers,Math.ceil(selectedCount*0.10),'SHOCK_MOVE_AUDIT');
  addLane(emergingMovers,Math.ceil(selectedCount*0.15),'EMERGING_MOVER');
  addLane(extendedMovers,Math.ceil(selectedCount*0.25),'EXTENDED_MOVER_AUDIT');

  let rotationVisited=0;
  while(selectedBySymbol.size<selectedCount && rotationVisited<eligible.length) {
    const row=eligible[(scanOffset+rotationVisited)%eligible.length];
    rotationVisited++;
    const symbol=String(row?.symbol||'').trim().toUpperCase();
    if(!symbol || selectedBySymbol.has(symbol)) continue;
    selectedBySymbol.set(symbol,{...row,selection_lane:'ROTATING_COVERAGE'});
  }
  const activityEvidenceBySymbol=new Map(activityAccelerationMovers.map(item=>[
    String(item.row?.symbol||'').toUpperCase(),item.evidence
  ]));
  const selected=[...selectedBySymbol.values()].slice(0,selectedCount).map(row=>({
    ...row,
    market_activity_acceleration:row.market_activity_acceleration||
      activityEvidenceBySymbol.get(String(row?.symbol||'').toUpperCase())||null
  }));
  // Advance by the number of rows actually traversed. Repeated priority picks
  // do not freeze coverage, and previously failed pairs cannot pin this cursor.
  const rotationAdvanceCount=rotationVisited;
  const selectionLaneCounts=selected.reduce((counts,row)=>{
    const lane=String(row?.selection_lane||'UNKNOWN');
    counts[lane]=(counts[lane]||0)+1;
    return counts;
  },{});

  // Keep one recent 5m page per selected symbol. This is enough for short-term
  // flow diagnostics; the explicit micro-availability mask keeps older samples
  // valid when 5m history is absent. The broader 15m/BTC pages remain the primary
  // historical training source, avoiding one extra REST request per pair.
  const pendingBySymbol=new Map();
  for(const sample of (Array.isArray(pendingSamples)?pendingSamples:[])){
    const symbol=String(sample?.symbol||'').trim().toUpperCase();
    if(!symbol)continue;
    if(!pendingBySymbol.has(symbol))pendingBySymbol.set(symbol,[]);
    pendingBySymbol.get(symbol).push(sample);
  }
  const analyzed = await mapLimit(selected, 7, async ticker => {
    // Start the optional 5m request concurrently, but do not await it before
    // extending the primary 15m history. This prevents a slow micro-window
    // response from consuming the remaining shared scan deadline needed for
    // the older 15m page that feeds historical model training.
    const fastLatestPromise=rest.request('/api/v3/klines', {
      symbol:ticker.symbol,interval:'5m',limit:1000
    }).then(value=>({value,error:null}))
      .catch(error=>({value:null,error:String(error?.message??error).slice(0,120)}));
    const first15m=await rest.request('/api/v3/klines', {
      symbol:ticker.symbol,interval:'15m',limit:1000
    });
    let result=first15m;
    if(Array.isArray(first15m?.data)&&first15m.data.length){
      const earliestOpen=finite(first15m.data[0]?.[0]);
      if(earliestOpen!==null){
        try{
          const older=await rest.request('/api/v3/klines',{
            symbol:ticker.symbol,interval:'15m',limit:1000,endTime:earliestOpen-1
          });
          result=mergeOlderKlinePage(first15m,older);
        }catch(error){
          result={...first15m,historical_pages_fetched:1,
            historical_window_candles:first15m.data.length,
            historical_backfill_error:String(error?.message??error).slice(0,120)};
        }
      }
    }
    const fastLatest=await fastLatestPromise;
    const fastResult=fastLatest.value&&Array.isArray(fastLatest.value.data)
      ?{value:{
          ...fastLatest.value,
          data:fastLatest.value.data.slice(),
          historical_pages_fetched:1,
          historical_window_candles:fastLatest.value.data.length,
          historical_backfill_error:null
        },error:null}
      :fastLatest;
    const candidate=scoreAdaptiveTraderCandidate({symbol:ticker.symbol,ticker,klines:result,fastKlines:fastResult.value,btcKlines,now,minQuoteVolume24h});
    const historicalSamples=buildAdaptiveTraderHistoricalOutcomeSamples({
      symbol:ticker.symbol,klines:result,fastKlines:fastResult.value,btcKlines,now,minQuoteVolume24h,
      maxSamples:HISTORICAL_TRAINING_SAMPLES_PER_SYMBOL
    });
    const closedCandleOutcomes=buildAdaptiveTraderClosedCandleOutcomeLabels({
      symbol:ticker.symbol,klines:result,fastKlines:fastResult.value,
      pendingSamples:pendingBySymbol.get(String(ticker.symbol||'').toUpperCase())||[],now
    });
    return {candidate,historicalSamples,closedCandleOutcomes,history:{
      asset_15m_pages:Number(result?.historical_pages_fetched)||1,
      asset_15m_candles:Array.isArray(result?.data)?result.data.length:0,
      asset_15m_backfill_error:String(result?.historical_backfill_error||''),
      asset_5m_pages:Number(fastResult.value?.historical_pages_fetched)||1,
      asset_5m_candles:Array.isArray(fastResult.value?.data)?fastResult.value.data.length:0,
      asset_5m_backfill_error:String(fastResult.value?.historical_backfill_error||fastResult.error||'')
    }};
  });
  const historicalTrainingSamples=analyzed.flatMap(entry=>Array.isArray(entry?.historicalSamples)?entry.historicalSamples:[]);
  const closedCandleOutcomes=analyzed.flatMap(entry=>Array.isArray(entry?.closedCandleOutcomes)?entry.closedCandleOutcomes:[]);
  const candidates = analyzed.map((entry, index) => entry?.candidate && !entry.error
    ? {
      ...entry.candidate,
      selection_lane: selected[index]?.selection_lane || 'ROTATING_COVERAGE',
      market_activity_acceleration:selected[index]?.market_activity_acceleration||null,
      ...(selected[index]?.market_activity_acceleration?{
        features:{
          ...(entry.candidate.features||{}),
          market_activity_volume_rate_vs_24h_average:selected[index].market_activity_acceleration.volume_rate_vs_24h_average,
          market_activity_trade_rate_vs_24h_average:selected[index].market_activity_acceleration.trade_rate_vs_24h_average,
          market_activity_baseline_age_ms:selected[index].market_activity_acceleration.baseline_age_ms
        },
        reason_codes:[...new Set([...(entry.candidate.reason_codes||[]),
          'MARKET_WIDE_ACTIVITY_ACCELERATION_SCAN_PRIORITY'])].slice(0,12)
      }:{}),
      ...(selected[index]?.selection_lane==='SHOCK_MOVE_AUDIT'?{
        shock_move_audit_only:true,
        // A sharp inter-snapshot jump is diagnostic evidence, not an early setup.
        // Force the shared decision helper to return AVOID_CHASING even when
        // the last closed candle's own features still look constructive.
        tier:'LATE_MOVE',
        paper_candidate:false,
        entry_eligible:false,
        reason_codes:[...new Set([...(entry.candidate.reason_codes||[]),
          'SHARP_MARKET_PULSE_AUDIT_ONLY','ALREADY_EXTENDED','ANTI_CHASE_BLOCK'])].slice(0,12)
      }:{})
    }
    : {
      symbol: selected[index]?.symbol || 'UNKNOWN',
      price: finite(selected[index]?.lastPrice),
      quote_volume_24h: finite(selected[index]?.quoteVolume),
      data_valid: false,
      data_stale: false,
      source: 'BINANCE_PUBLIC_REST',
      tier: 'DATA_UNAVAILABLE',
      score: null,
      reason_codes: ['KLINE_FETCH_FAILED'],
      error: String(entry?.error || 'KLINE_FETCH_FAILED'),
      selection_lane: selected[index]?.selection_lane || 'ROTATING_COVERAGE',
      paper_trading: true,
      real_order_execution: false,
      confidence_score: 'UNKNOWN'
    });
  // Query public Spot depth only for a tiny shortlist; a book snapshot is
  // never promoted into proof of spoofing or an actionable entry condition.
  const orderBookTargets=candidates.filter(row=>row?.data_valid===true&&row?.data_stale!==true&&
    row?.tier!=='LATE_MOVE'&&row?.shock_move_audit_only!==true&&
    (finite(row?.features?.volume_ratio)>=1.5||finite(row?.features?.trade_ratio)>=1.25)&&
    finite(row?.features?.taker_buy_ratio)>=0.52)
    .sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0)).slice(0,4);
  const orderBookResults=typeof rest.depth==='function'
    ?await mapLimit(orderBookTargets,2,async row=>({
      symbol:row.symbol,evidence:summarizePublicSpotOrderBook(await rest.depth(row.symbol,20),Date.now())
    }))
    :[];
  const orderBookBySymbol=new Map(orderBookResults.filter(row=>row&&!row.error&&row.evidence?.order_book_checked===true)
    .map(row=>[String(row.symbol).toUpperCase(),row.evidence]));
  for(const candidate of candidates){
    const evidence=orderBookBySymbol.get(String(candidate.symbol||'').toUpperCase());
    candidate.order_book_checked=evidence?.order_book_checked===true;
    candidate.order_book=evidence||{
      order_book_checked:false,order_book_status:'NOT_CHECKED',
      spoofing_assessment:'NOT_ASSESSABLE_SINGLE_SNAPSHOT'
    };
    candidate.features={...(candidate.features||{}),
      order_book_checked:candidate.order_book.order_book_checked===true,
      order_book_spread_bps:finite(candidate.order_book.order_book_spread_bps),
      order_book_bid_ask_depth_ratio:finite(candidate.order_book.order_book_bid_ask_depth_ratio),
      order_book_imbalance_pct:finite(candidate.order_book.order_book_imbalance_pct),
      order_book_persistence_samples:finite(candidate.order_book.order_book_persistence_samples)??0
    };
  }
  const decoratedCandidates = candidates.map(candidate => ({...candidate, trade_decision:buildAdaptiveTraderRecommendation(candidate,{now})}));
  candidates.splice(0,candidates.length,...decoratedCandidates);
  candidates.sort((a, b) => (Number(b.score) || -1) - (Number(a.score) || -1));
  const validCount = candidates.filter(row => row.data_valid && !row.data_stale).length;
  const fetchFailedSymbols = candidates
    .filter(row=>Array.isArray(row.reason_codes)&&row.reason_codes.includes('KLINE_FETCH_FAILED'))
    .map(row=>String(row.symbol||'').toUpperCase()).filter(Boolean);
  const source = String(tickerResult?.source || exchangeInfo?.source || 'BINANCE_PUBLIC_REST');
  const snapshot = {
    status: validCount > 0 ? 'LIVE_DATA' : 'DATA_UNAVAILABLE',
    source: 'Binance Public REST',
    as_of: new Date(Number(now)).toISOString(),
    universe: {
      quote: 'USDT',
      eligible_symbols: eligible.map(row=>String(row.symbol||'').toUpperCase()),
      eligible_spot_symbols: eligible.length,
      analyzed_symbols: candidates.length,
      valid_symbols: validCount,
      monitored_spot_symbols: marketTickers.length,
      market_wide_price_tracking: true,
      price_acceleration_candidates_available: accelerationMovers.length,
      micro_5m_symbols_available: analyzed.filter(row=>row?.candidate?.features?.micro_5m_available===true).length,
      micro_5m_symbols_unavailable: Math.max(0,candidates.length-analyzed.filter(row=>row?.candidate?.features?.micro_5m_available===true).length),
      historical_training_samples_available: historicalTrainingSamples.length,
      historical_training_samples_per_symbol:HISTORICAL_TRAINING_SAMPLES_PER_SYMBOL,
      historical_sampling_strategy:'DETERMINISTIC_TIME_STRATIFIED_PER_SYMBOL_V1',
      asset_15m_extended_symbols:analyzed.filter(row=>Number(row?.history?.asset_15m_pages)>=2).length,
      asset_5m_extended_symbols:analyzed.filter(row=>Number(row?.history?.asset_5m_pages)>=2).length,
      asset_5m_deep_history_symbols:analyzed.filter(row=>Number(row?.history?.asset_5m_pages)>=4).length,
      asset_5m_max_history_candles:Math.max(0,...analyzed.map(row=>Number(row?.history?.asset_5m_candles)||0)),
      asset_15m_backfill_failures:analyzed.filter(row=>Boolean(row?.history?.asset_15m_backfill_error)).length,
      asset_5m_backfill_failures:analyzed.filter(row=>Boolean(row?.history?.asset_5m_backfill_error)).length,
      asset_15m_backfill_error_samples:analyzed.filter(row=>row?.history?.asset_15m_backfill_error).slice(0,5).map(row=>({symbol:row.candidate?.symbol||'UNKNOWN',error:row.history.asset_15m_backfill_error})),
      asset_5m_backfill_error_samples:analyzed.filter(row=>row?.history?.asset_5m_backfill_error).slice(0,5).map(row=>({symbol:row.candidate?.symbol||'UNKNOWN',error:row.history.asset_5m_backfill_error})),
      previous_snapshot_age_ms: Number.isFinite(previousSnapshotAgeMs)?Math.max(0,Math.trunc(previousSnapshotAgeMs)):null,
      requested_limit: safeLimit,
      scan_offset: scanOffset,
      scan_advance_count: rotationAdvanceCount,
      rotation_slots_per_cycle:coveragePlan.rotation_slots_per_cycle,
      priority_slots_per_cycle:coveragePlan.priority_slots_per_cycle,
      estimated_full_sweep_cycles:coveragePlan.estimated_full_sweep_cycles,
      scan_success_count: analyzed.filter(row=>row?.candidate&&!row.error).length,
      fetch_failed_symbols: fetchFailedSymbols.length,
      retry_symbols_pending: fetchFailedSymbols,
      coverage_pct: eligible.length ? Number((candidates.length / eligible.length * 100).toFixed(1)) : 0,
      scan_complete: candidates.length === eligible.length,
      min_quote_volume_24h: minQuoteVolume24h,
      emerging_movers_available: emergingMovers.length,
      extended_movers_available: extendedMovers.length,
      price_acceleration_movers_available: accelerationMovers.length,
      rapid_burst_movers_available: burstMovers.length,
      order_book_candidates_checked:orderBookBySymbol.size,
      order_book_snapshot_limit:4,
      activity_acceleration_movers_available:activityAccelerationMovers.length,
      activity_acceleration_movers_scanned:candidates.filter(row=>row.selection_lane==='MARKET_ACTIVITY_ACCELERATION').length,
      selection_strategy: 'MOVER_AWARE_FLOW_ACCELERATION_FAIR_ROTATION_V5',
      selection_lane_counts: selectionLaneCounts,
      excluded_leveraged_tokens: true
    },
    candidates,
    // Track all active non-leveraged Spot USDT pairs even while deep-scan slots rotate.
    latest_prices: marketTickers.map(row => ({
      symbol:String(row.symbol),price:finite(row.lastPrice),
      quote_volume_24h:finite(row.quoteVolume),trade_count_24h:finite(row.count),
      change_24h_pct:finite(row.priceChangePercent),
      move_since_previous_pct:finite(row.move_since_previous_pct)
    })),
    meta: {
      live: validCount > 0,
      paper_trading: true,
      real_order_execution: false,
      confidence_score: 'UNKNOWN',
      closed_candles_only: true,
      engine: 'ADAPTIVE_TRADER_SIDECAR_V1',
      execution: 'DISABLED',
      learning_scope: 'SERVER_MARKET_WIDE_AND_DEEP_CANDIDATE_OUTCOMES',
      source_host: source,
      btc_benchmark_available: Boolean(btcKlines?.data),
      btc_benchmark_error: btcResult.error,
      btc_15m_historical_pages:Number(btcKlines?.historical_pages_fetched)||1,
      btc_15m_historical_window_candles:Number(btcKlines?.historical_window_candles)||btcKlines?.data?.length||0,
      btc_15m_historical_backfill_error:String(btcKlines?.historical_backfill_error||''),
      cache_policy: 'SERVER_PUBLIC_REST_CACHE',
      historical_learning_enabled:true
    }
  };
  return attachClosedCandleOutcomes(attachHistoricalTrainingSamples(snapshot,historicalTrainingSamples),closedCandleOutcomes);
}

export function createAdaptiveTraderSnapshotService({
  rest, ttlMs = 90000, minQuoteVolume24h = POLICY.minQuoteVolume24h, scanTimeoutMs = 60_000
} = {}) {
  const cache = new Map();
  const flights = new Map();
  const flightMeta = new Map();
  const rotationCursors = new Map();
  const retryQueues = new Map();
  const flightOffsets = new Map();
  const flightTimeoutMs=Math.max(250,Math.min(60_000,Math.trunc(Number(scanTimeoutMs)||60_000)));
  const evictFlight=(limit,task)=>{
    if(flights.get(limit)!==task)return false;
    const meta=flightMeta.get(limit);
    try{meta?.controller?.abort();}catch{}
    if(meta&&rest.requestAbortSignal===meta.controller.signal)
      rest.requestAbortSignal=meta.previousAbortSignal??null;
    if(meta&&rest.requestDeadlineAtMs===meta.effectiveDeadline)
      rest.requestDeadlineAtMs=meta.previousDeadline??null;
    flights.delete(limit);flightOffsets.delete(limit);flightMeta.delete(limit);
    return true;
  };
  const waitForFlight=async(limit,task)=>{
    const meta=flightMeta.get(limit);
    const fallbackDeadline=Date.now()+flightTimeoutMs+1000;
    const deadline=Number(meta?.deadlineAtMs)||fallbackDeadline;
    const waitMs=Math.max(250,deadline-Date.now()+1000);
    let timer=null;
    const result=await Promise.race([
      Promise.resolve(task).then(value=>({kind:'DONE',value}),error=>({kind:'ERROR',error})),
      new Promise(resolve=>{timer=setTimeout(()=>resolve({kind:'TIMEOUT'}),waitMs);})
    ]);
    if(timer!==null)clearTimeout(timer);
    if(result.kind==='TIMEOUT'){
      evictFlight(limit,task);
    }
    return result;
  };
  const getSnapshot = async ({ limit = POLICY.defaultUniverseLimit, now = Date.now(), offset, pendingSamples = [] } = {}) => {
    const safeLimit = clamp(Math.trunc(Number(limit) || POLICY.defaultUniverseLimit), 20, POLICY.maxUniverseLimit);
    const requestedOffset = offset === undefined || offset === null || !Number.isFinite(Number(offset))
      ? null : Math.max(0, Math.trunc(Number(offset)));
    const needsClosedCandleOutcomes = Array.isArray(pendingSamples) && pendingSamples.length > 0;
    const hit = cache.get(safeLimit);
    const hitEligibleCount = Number(hit?.snapshot?.universe?.eligible_spot_symbols) || 0;
    const normalizedRequestedOffset = requestedOffset === null ? null
      : (hitEligibleCount > 0 ? requestedOffset % hitEligibleCount : requestedOffset);
    const hitOffset = Number(hit?.snapshot?.universe?.scan_offset);
    const cacheOffsetMatches = requestedOffset === null ||
      (Number.isFinite(hitOffset) && hitOffset === normalizedRequestedOffset);
    if (!needsClosedCandleOutcomes && hit && cacheOffsetMatches && Number(now) - hit.cachedAt < ttlMs) {
      return attachHistoricalTrainingSamples({
        ...hit.snapshot,
        meta: { ...hit.snapshot.meta, cache_mode: 'FRESH_SERVER_CACHE', cache_age_ms: Math.max(0, Number(now) - hit.cachedAt) }
      },hit.snapshot.historical_training_samples);
    }
    // One sidecar scan at a time; the REST client uses a process-shared budget
    // with the other radars. Coalescing different universe requests avoids a
    // burst of overlapping 40/80/120-pair scans on that shared budget.
    const activeEntry = flights.entries().next().value;
    if (activeEntry) {
      const [activeLimit, active] = activeEntry;
      const sameRequest=activeLimit===safeLimit&&
        (requestedOffset===null||flightOffsets.get(activeLimit)===requestedOffset);
      const outcome=await waitForFlight(activeLimit,active);
      if(needsClosedCandleOutcomes){
        // Maturing labels are independent of the coalesced market scan result;
        // retry the requested outcome attachment even when that flight failed.
        return getSnapshot({limit:safeLimit,now:Date.now(),offset:requestedOffset,pendingSamples});
      }
      if(sameRequest&&outcome.kind==='DONE')return outcome.value;
      if(sameRequest&&outcome.kind==='ERROR')throw outcome.error;
      // Different callers and requests must wait for the current flight, but
      // never forever. A stale flight is aborted and evicted before retry.
      return getSnapshot({limit:safeLimit,now:Date.now(),offset:requestedOffset,pendingSamples});
    }
    const previousDeadline = Number(rest.requestDeadlineAtMs) > 0 ? Number(rest.requestDeadlineAtMs) : null;
    const previousAbortSignal=rest.requestAbortSignal??null;
    const controller=new AbortController();
    const deadline = Date.now()+flightTimeoutMs;
    rest.requestDeadlineAtMs = previousDeadline === null ? deadline : Math.min(previousDeadline, deadline);
    rest.requestAbortSignal=controller.signal;
    const effectiveDeadline = rest.requestDeadlineAtMs;
    const flight={controller,previousDeadline,previousAbortSignal,effectiveDeadline,
      deadlineAtMs:effectiveDeadline};
    const scanOffset = requestedOffset === null ? (rotationCursors.get(safeLimit) || 0) : requestedOffset;
    const queuedRetries = retryQueues.get(safeLimit) || [];
    const task = buildAdaptiveTraderMarketSnapshot({
      rest, limit: safeLimit, now, offset: scanOffset, retrySymbols: queuedRetries,
      previousSnapshot:hit?.snapshot||null,pendingSamples,minQuoteVolume24h
    }).then(snapshot => {
      const eligibleCount = Number(snapshot.universe?.eligible_spot_symbols) || 0;
      const advance = Number(snapshot.universe?.scan_advance_count) || 0;
      if (eligibleCount > 0 && advance > 0) {
        rotationCursors.set(safeLimit, (scanOffset + advance) % eligibleCount);
      } else if (eligibleCount > 0) {
        rotationCursors.set(safeLimit, scanOffset % eligibleCount);
      }
      const attempted = new Set((snapshot.candidates||[]).map(row=>String(row?.symbol||'').toUpperCase()).filter(Boolean));
      const eligibleNow = new Set((snapshot.latest_prices||[]).map(row=>String(row?.symbol||'').toUpperCase()).filter(Boolean));
      const newlyFailed = Array.isArray(snapshot.universe?.retry_symbols_pending) ? snapshot.universe.retry_symbols_pending : [];
      const notYetAttempted = queuedRetries.filter(symbol=>eligibleNow.has(symbol)&&!attempted.has(symbol));
      // Rotate never-attempted retry entries to the front so the same failing
      // eight pairs cannot indefinitely starve the tail of the retry queue.
      retryQueues.set(safeLimit,[...new Set([
        ...notYetAttempted,
        ...newlyFailed.filter(symbol=>!notYetAttempted.includes(symbol))
      ])].slice(0,safeLimit));
      const cachedAt = Date.now();
      cache.set(safeLimit, { snapshot, cachedAt });
      // Only the supported dashboard tiers are used in production. Keep this cache bounded even if callers vary inputs.
      while (cache.size > 4) cache.delete(cache.keys().next().value);
      return attachClosedCandleOutcomes(attachHistoricalTrainingSamples({ ...snapshot, meta: { ...snapshot.meta, cache_mode: 'FRESH_SCAN', cache_age_ms: 0 } },snapshot.historical_training_samples),snapshot.closed_candle_outcomes);
    }).finally(() => {
      if (rest.requestAbortSignal === controller.signal) rest.requestAbortSignal=previousAbortSignal;
      if (rest.requestDeadlineAtMs === effectiveDeadline) rest.requestDeadlineAtMs = previousDeadline;
      if(flights.get(safeLimit)===task){
        flights.delete(safeLimit);flightOffsets.delete(safeLimit);
        if(flightMeta.get(safeLimit)===flight)flightMeta.delete(safeLimit);
      }
    });
    flights.set(safeLimit, task);
    flightOffsets.set(safeLimit, scanOffset);
    flightMeta.set(safeLimit,flight);
    return task;
  };
  return getSnapshot;
}

export function buildAdaptiveLearningProfile(samples = [], { minSamples = 60, minimumBucket = 8 } = {}) {
  const resolved=(Array.isArray(samples)?samples:[]).filter(row=>
    row&&['UP','DOWN','FLAT'].includes(row.outcome)&&row.features&&typeof row.features==='object');
  const positive=resolved.filter(row=>row.outcome==='UP').length;
  const negative=resolved.filter(row=>row.outcome==='DOWN').length;
  const flat=resolved.filter(row=>row.outcome==='FLAT').length;
  const overallRate=resolved.length?(positive+2)/(resolved.length+4):0.5;
  const meanReturn=mean(resolved.map(row=>finite(row.return_pct)).filter(value=>value!==null))??0;
  const featureKeys={
    volume:row=>finite(row.features.volume_ratio)!==null&&Number(row.features.volume_ratio)>=1.5,
    trade_activity:row=>finite(row.features.trade_ratio)!==null&&Number(row.features.trade_ratio)>=1.25,
    buyer_flow:row=>finite(row.features.taker_buy_ratio)!==null&&Number(row.features.taker_buy_ratio)>=0.52,
    structure:row=>row.features.higher_low===true||row.features.breakout_above_prior_high===true,
    compression:row=>finite(row.features.compression_ratio)!==null&&Number(row.features.compression_ratio)<=0.8,
    relative_strength:row=>((finite(row.features.relative_strength_vs_btc_pct)!==null&&Number(row.features.relative_strength_vs_btc_pct)>=0.25)||(finite(row.features.relative_24h_strength_vs_btc_pct)!==null&&Number(row.features.relative_24h_strength_vs_btc_pct)>=0.25)),
    short_momentum:row=>{const value=finite(row.features.recent_15m_return_pct)??finite(row.features.price_change_15m_pct);return value!==null&&value>=0&&value<=1.5;},
    multi_hour_trend:row=>row.features.trend_aligned===true||(finite(row.features.return_3h_pct)!==null&&Number(row.features.return_3h_pct)>0)||(finite(row.features.price_change_4h_pct)!==null&&Number(row.features.price_change_4h_pct)>0),
    five_minute_flow:row=>finite(row.features.micro_5m_taker_buy_ratio)!==null&&Number(row.features.micro_5m_taker_buy_ratio)>=0.55,
    ticker_momentum:row=>{const value=finite(row.features.price_change_15m_pct)??finite(row.features.recent_15m_return_pct);return value!==null&&value>0;},
    daily_regime:row=>finite(row.features.change_24h_pct)!==null&&Number(row.features.change_24h_pct)>=-2&&Number(row.features.change_24h_pct)<=7,
    market_activity_acceleration:row=>
      finite(row.features.market_activity_volume_rate_vs_24h_average)!==null&&
      Number(row.features.market_activity_volume_rate_vs_24h_average)>=1.5&&
      finite(row.features.market_activity_trade_rate_vs_24h_average)!==null&&
      Number(row.features.market_activity_trade_rate_vs_24h_average)>=1.3
  };
  const buckets={},adjustments={};
  for(const [key,matcher] of Object.entries(featureKeys)){
    const rows=resolved.filter(matcher),wins=rows.filter(row=>row.outcome==='UP').length;
    const losses=rows.filter(row=>row.outcome==='DOWN').length,flats=rows.filter(row=>row.outcome==='FLAT').length;
    const rate=(wins+2)/(rows.length+4);
    const sampleReturn=mean(rows.map(row=>finite(row.return_pct)).filter(value=>value!==null));
    buckets[key]={samples:rows.length,wins,losses,flats,positive_rate_pct:Number((rate*100).toFixed(1)),
      mean_return_pct:sampleReturn===null?null:Number(sampleReturn.toFixed(3))};
    const returnDelta=sampleReturn===null?0:clamp((sampleReturn-meanReturn)*0.8,-2,2);
    const rateDelta=(rate-overallRate)*10;
    adjustments[key]=rows.length>=minimumBucket?Number(clamp(returnDelta+rateDelta,-4,4).toFixed(2)):0;
  }
  const coveredBuckets=Object.values(buckets).filter(row=>row.samples>=minimumBucket).length;
  const ready=resolved.length>=minSamples&&coveredBuckets>=4;
  return {
    ready,resolved_samples:resolved.length,required_samples:minSamples,covered_factor_buckets:coveredBuckets,
    positive_outcome_rate_pct:Number((overallRate*100).toFixed(1)),outcome_counts:{up:positive,down:negative,flat},
    candidate_samples:resolved.filter(row=>row.observation_type==='DEEP_CANDIDATE').length,
    market_wide_samples:resolved.filter(row=>row.observation_type==='MARKET_WIDE_TICKER').length,
    historical_samples:resolved.filter(row=>row.observation_type==='HISTORICAL_CLOSED_CANDLE').length,
    adjustments:ready?adjustments:Object.fromEntries(Object.keys(featureKeys).map(key=>[key,0])),
    buckets,
    note:ready?'MARKET_WIDE_OUTCOME_CALIBRATION_ONLY_NO_AUTOMATIC_RULE_OR_EXECUTION_CHANGES'
      :'INSUFFICIENT_OUTCOMES_OR_FACTOR_COVERAGE_NO_LEARNING_ADJUSTMENT_APPLIED'
  };
}

export function applyAdaptiveLearning(baseScore,features={},profile={}){
  const score=finite(baseScore);if(score===null)return null;
  if(profile?.ready!==true)return Number(clamp(score,0,100).toFixed(1));
  const active=[],add=(name,condition)=>{if(condition)active.push(finite(profile.adjustments?.[name])||0);};
  add('volume',finite(features.volume_ratio)!==null&&Number(features.volume_ratio)>=1.5);
  add('trade_activity',finite(features.trade_ratio)!==null&&Number(features.trade_ratio)>=1.25);
  add('buyer_flow',finite(features.taker_buy_ratio)!==null&&Number(features.taker_buy_ratio)>=0.52);
  add('structure',features.higher_low===true||features.breakout_above_prior_high===true);
  add('compression',finite(features.compression_ratio)!==null&&Number(features.compression_ratio)<=0.8);
  add('relative_strength',(finite(features.relative_strength_vs_btc_pct)!==null&&Number(features.relative_strength_vs_btc_pct)>=0.25)||(finite(features.relative_24h_strength_vs_btc_pct)!==null&&Number(features.relative_24h_strength_vs_btc_pct)>=0.25));
  add('short_momentum',((finite(features.recent_15m_return_pct)??finite(features.price_change_15m_pct))!==null&&(finite(features.recent_15m_return_pct)??finite(features.price_change_15m_pct))>=0&&(finite(features.recent_15m_return_pct)??finite(features.price_change_15m_pct))<=1.5));
  add('multi_hour_trend',features.trend_aligned===true||(finite(features.return_3h_pct)!==null&&Number(features.return_3h_pct)>0)||(finite(features.price_change_4h_pct)!==null&&Number(features.price_change_4h_pct)>0));
  add('five_minute_flow',finite(features.micro_5m_taker_buy_ratio)!==null&&Number(features.micro_5m_taker_buy_ratio)>=0.55);
  add('ticker_momentum',((finite(features.price_change_15m_pct)??finite(features.recent_15m_return_pct))!==null&&(finite(features.price_change_15m_pct)??finite(features.recent_15m_return_pct))>0));
  add('daily_regime',finite(features.change_24h_pct)!==null&&Number(features.change_24h_pct)>=-2&&Number(features.change_24h_pct)<=7);
  add('market_activity_acceleration',
    finite(features.market_activity_volume_rate_vs_24h_average)!==null&&
    Number(features.market_activity_volume_rate_vs_24h_average)>=1.5&&
    finite(features.market_activity_trade_rate_vs_24h_average)!==null&&
    Number(features.market_activity_trade_rate_vs_24h_average)>=1.3);
  const delta=active.length?active.reduce((a,b)=>a+b,0)/active.length:0;
  return Number(clamp(score+clamp(delta,-4,4),0,100).toFixed(1));
}

export function findMissedMoverEvents({ history = [], currentPrices = [], now = Date.now(), thresholdPct = 5, maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  const current = new Map((Array.isArray(currentPrices) ? currentPrices : [])
    .map(row => [String(row?.symbol || '').toUpperCase(), finite(row?.price ?? row?.lastPrice)]));
  const newestQualifying = new Map();
  const newestEvaluatedQualifying = new Map();
  for (const row of (Array.isArray(history) ? history : [])) {
    const symbol = String(row?.symbol || '').toUpperCase();
    const at = finite(row?.at);
    const price = finite(row?.price);
    if (!symbol || at === null || price === null || price <= 0 || at >= Number(now) ||
        Number(now) - at < 15 * 60 * 1000 || Number(now) - at > maxAgeMs) continue;
    const livePrice = current.get(symbol);
    if (!(livePrice > 0)) continue;
    const move = (livePrice / price - 1) * 100;
    if (move < thresholdPct) continue;
    const candidate = { ...row, symbol, at, price, move };
    const prior = newestQualifying.get(symbol);
    if (!prior || at > prior.at) newestQualifying.set(symbol, candidate);
    if (row.evaluated === true) {
      const evaluatedPrior = newestEvaluatedQualifying.get(symbol);
      if (!evaluatedPrior || at > evaluatedPrior.at) newestEvaluatedQualifying.set(symbol, candidate);
    }
  }
  const events = [];
  for (const [symbol, fallback] of newestQualifying) {
    // Prefer the latest snapshot the detector truly analyzed. A later unassessed
    // snapshot must not erase evidence that a previously analyzed setup was missed.
    const previous = newestEvaluatedQualifying.get(symbol) || fallback;
    const price = current.get(symbol);
    const move = (price / previous.price - 1) * 100;
    const previousTier = String(previous.tier || 'NOT_EVALUATED');
    const wasEvaluated = previous.evaluated === true;
    const wasOnRadar = wasEvaluated && ['EARLY_SETUP', 'WATCH'].includes(previousTier);
    const baselineFeatures=previous.features&&typeof previous.features==='object'?previous.features:{};
    const diagnosticReasons=Array.isArray(previous.reason_codes)&&previous.reason_codes.length
      ?previous.reason_codes.slice(0,8).map(String)
      :!wasEvaluated?['NOT_IN_DEEP_SCAN_BATCH_AT_BASELINE']:[];
    if(wasEvaluated&&!diagnosticReasons.length){
      const volume=finite(baselineFeatures.volume_ratio),trades=finite(baselineFeatures.trade_ratio);
      const buy=finite(baselineFeatures.taker_buy_ratio),score=finite(previous.score);
      if(volume===null||volume<1.5)diagnosticReasons.push('VOLUME_ACCELERATION_NOT_CONFIRMED');
      if(trades===null||trades<1.25)diagnosticReasons.push('TRADE_ACCELERATION_NOT_CONFIRMED');
      if(buy===null||buy<0.52)diagnosticReasons.push('BUY_FLOW_NOT_CONFIRMED');
      if(baselineFeatures.higher_low!==true&&baselineFeatures.breakout_above_prior_high!==true)
        diagnosticReasons.push('STRUCTURE_CONFIRMATION_MISSING');
      if(score!==null&&score<68)diagnosticReasons.push('SCORE_BELOW_EARLY_SETUP_GATE');
      if(!diagnosticReasons.length)diagnosticReasons.push('SETUP_NOT_CONFIRMED_BY_BASELINE_RULES');
    }
    events.push({
      id: symbol + ':' + String(previous.at),
      symbol,
      baseline_at: new Date(previous.at).toISOString(),
      baseline_price: previous.price,
      current_price: price,
      move_pct: Number(move.toFixed(2)),
      baseline_tier: previousTier,
      baseline_score:finite(previous.score),
      baseline_features:baselineFeatures,
      baseline_reason_codes:diagnosticReasons,
      baseline_quote_volume_24h:finite(previous.quote_volume_24h),
      baseline_change_24h_pct:finite(previous.change_24h_pct),
      baseline_was_evaluated: wasEvaluated,
      classification: !wasEvaluated ? 'UNASSESSED_MOVE' : wasOnRadar ? 'FOLLOW_UP_MOVE' : 'POTENTIAL_MISSED_MOVER',
      diagnostic_only: true,
      reason: 'OBSERVED_PRICE_MOVED_AFTER_PRIOR_SNAPSHOT',
      no_future_data_used_for_baseline: true
    });
  }
  return events.sort((a, b) => b.move_pct - a.move_pct);
}

export function createPaperPortfolio(startingBalance = 10000) {
  const amount = finite(startingBalance);
  const balance = amount !== null && amount > 0 ? amount : 10000;
  return {
    version: 1,
    mode: 'PAPER_ONLY',
    enabled: false,
    starting_balance: balance,
    cash: balance,
    open_positions: [],
    closed_trades: [],
    created_at: Date.now(),
    paper_trading: true,
    real_order_execution: false
  };
}

export function openPaperPosition(portfolio, candidate, now = Date.now()) {
  if (!portfolio || portfolio.enabled !== true || portfolio.real_order_execution !== false) return { opened: false, reason: 'PAPER_MODE_DISABLED' };
  if (!candidate || candidate.data_valid !== true || candidate.data_stale === true ||
      candidate.closed_candles_only !== true || candidate.real_order_execution !== false ||
      candidate.tier !== 'EARLY_SETUP' || candidate.paper_candidate !== true ||
      candidate.entry_eligible !== false || !candidate.thresholds?.no_chase ||
      !candidate.features || Number(candidate.score) < 68 ||
      Number(candidate.features.volume_ratio) < 1.5 ||
      Number(candidate.features.trade_ratio) < 1.25 ||
      Number(candidate.features.taker_buy_ratio) < 0.52 ||
      Number(candidate.features.close_location) < 0.58 ||
      Number(candidate.quote_volume_24h) < POLICY.minQuoteVolume24h) {
    return { opened: false, reason: 'STRICT_PAPER_SETUP_GATE_FAILED' };
  }
  const symbol = String(candidate.symbol || '').toUpperCase();
  const price = finite(candidate.price);
  if (!symbol.endsWith('USDT') || !(price > 0)) return { opened: false, reason: 'PAPER_SYMBOL_OR_PRICE_INVALID' };
  if ((portfolio.open_positions || []).some(row => row.symbol === symbol)) return { opened: false, reason: 'PAPER_POSITION_ALREADY_OPEN' };
  if ((portfolio.open_positions || []).length >= POLICY.maxPaperPositions) return { opened: false, reason: 'PAPER_POSITION_LIMIT' };
  const equity = estimatePaperEquity(portfolio);
  const notional = Math.min(Number(portfolio.cash) || 0, equity * POLICY.paperPositionPct / 100);
  if (!(notional > 0)) return { opened: false, reason: 'PAPER_CASH_EXHAUSTED' };
  const position = {
    id: 'PAPER:' + symbol + ':' + String(now),
    symbol,
    entry_price: price,
    mark_price: price,
    quantity: notional / price,
    notional,
    opened_at: Number(now),
    entry_score: Number(candidate.score),
    entry_features: { ...candidate.features },
    mode: 'PAPER_ONLY',
    paper_trading: true,
    real_order_execution: false
  };
  portfolio.cash = Number(portfolio.cash) - notional;
  portfolio.open_positions = [...(portfolio.open_positions || []), position];
  return { opened: true, reason: null, position: { ...position }, portfolio };
}

export function advancePaperPortfolio(portfolio, currentPrices = [], now = Date.now()) {
  if (!portfolio || portfolio.real_order_execution !== false || portfolio.mode !== 'PAPER_ONLY') {
    throw new Error('PAPER_PORTFOLIO_POLICY_VIOLATION');
  }
  const prices = new Map((Array.isArray(currentPrices) ? currentPrices : [])
    .map(row => [String(row?.symbol || '').toUpperCase(), finite(row?.price)]));
  const open = [];
  const newlyClosed = [];
  for (const position of (portfolio.open_positions || [])) {
    const price = prices.get(String(position.symbol || '').toUpperCase());
    const mark = price !== null && price !== undefined && price > 0 ? price : finite(position.mark_price) || finite(position.entry_price);
    const entry = finite(position.entry_price);
    const age = Number(now) - Number(position.opened_at);
    const gross = entry > 0 ? (mark / entry - 1) * 100 : 0;
    const reason = gross >= POLICY.takeProfitPct ? 'PAPER_TAKE_PROFIT'
      : gross <= POLICY.stopLossPct ? 'PAPER_STOP_LOSS'
      : age >= POLICY.maxHoldMs ? 'PAPER_TIME_EXIT' : null;
    if (reason) {
      const notional = Number(position.notional) || 0;
      const pnl = notional * (gross - POLICY.estimatedRoundTripCostPct) / 100;
      portfolio.cash = Number(portfolio.cash) + notional + pnl;
      newlyClosed.push({
        ...position, exit_price: mark, closed_at: Number(now), gross_return_pct: Number(gross.toFixed(3)),
        net_pnl: Number(pnl.toFixed(4)), net_return_pct: Number((gross - POLICY.estimatedRoundTripCostPct).toFixed(3)),
        exit_reason: reason, paper_trading: true, real_order_execution: false
      });
    } else {
      open.push({ ...position, mark_price: mark, gross_return_pct: Number(gross.toFixed(3)),
        estimated_net_pnl: Number((Number(position.notional) * (gross - 0.15) / 100).toFixed(4)),
        age_ms: Math.max(0, age) });
    }
  }
  portfolio.open_positions = open;
  portfolio.closed_trades = [...(portfolio.closed_trades || []), ...newlyClosed].slice(-2000);
  portfolio.updated_at = Number(now);
  return { portfolio, newlyClosed, equity: estimatePaperEquity(portfolio), real_order_execution: false };
}

export function estimatePaperEquity(portfolio) {
  const cash = finite(portfolio?.cash) || 0;
  const marked = (Array.isArray(portfolio?.open_positions) ? portfolio.open_positions : []).reduce((sum, position) => {
    const entry = finite(position.entry_price);
    const mark = finite(position.mark_price) || entry;
    return sum + (entry > 0 ? (Number(position.notional) || 0) * mark / entry : 0);
  }, 0);
  const floatingCost = (Array.isArray(portfolio?.open_positions) ? portfolio.open_positions : []).reduce((sum, position) =>
    sum + (Number(position.notional) || 0) * 0.0015, 0);
  return Number((cash + marked - floatingCost).toFixed(2));
}

export const ADAPTIVE_TRADER_POLICY = POLICY;
