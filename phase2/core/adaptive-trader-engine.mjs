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
      return out('ENTRY_CANDIDATE','مرشّح دخول للمراجعة — ليس أمر شراء مضمونًا','REVIEW_ENTRY',3,
        'تحقّق من السعر الحالي والسيولة والسبريد والرسوم وحدّد وقف الخسارة قبل أي قرار؛ التنفيذ الحقيقي متوقف، وهذه النتيجة للمحاكاة والمراجعة فقط.',
        ['STRICT_EARLY_SETUP','CLOSED_CANDLE_BREAKOUT','BUY_FLOW_AND_ACTIVITY_CONFIRMED']);
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

const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
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
  const possible=[];
  for(let index=dayBars;index+horizonBars<candles.length;index++){
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
    possible.push({index,volume24h,dailyReturn,baseline,future});
  }
  const desired=Math.max(1,Math.min(16,Math.trunc(Number(maxSamples)||8)));
  const selected=[];
  // Give each symbol a deterministic phase on the 4h sampling grid. This keeps
  // that symbol's own outcomes non-overlapping, while preventing every market
  // pair from contributing labels at the exact same eight timestamps. The hash
  // only stratifies historical sampling; it is never a model feature.
  let phaseHash=2166136261;
  for(const char of cleanSymbol){
    phaseHash^=char.charCodeAt(0);
    phaseHash=Math.imul(phaseHash,16777619)>>>0;
  }
  const samplingPhase=phaseHash%horizonBars;
  for(let cursor=possible.length-1;cursor>=0&&selected.length<desired;cursor--){
    const item=possible[cursor];
    if(item.index%horizonBars!==samplingPhase)continue;
    selected.push(item);
  }
  selected.reverse();
  const out=[];
  for(const item of selected){
    const {index,volume24h,dailyReturn,baseline,future}=item;
    const evaluationNow=baseline.closeTime+1;
    const priorDay=candles[index-dayBars].candle;
    const btcCurrent=btcByClose.get(baseline.closeTime);
    const btcPrior=btcByClose.get(priorDay.closeTime);
    const btcDailyReturn=btcCurrent&&btcPrior?pct(btcCurrent.close,btcPrior.close):null;
    const baselineRaw=candles.slice(Math.max(0,index-19),index+1).map(row=>row.raw);
    const baseBtcRaw=btcCandles.filter(row=>row.candle.closeTime<=baseline.closeTime).slice(-150).map(row=>row.raw);
    const baseFastRaw=fastCandles.filter(row=>row.candle.closeTime<=baseline.closeTime).slice(-720).map(row=>row.raw);
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
    if(candidate.data_valid!==true||candidate.data_stale===true||!Number.isFinite(future.close)||!(baseline.close>0))continue;
    const move=(future.close/baseline.close-1)*100;
    const outcome=move>=2?'UP':move<=-2?'DOWN':'FLAT';
    const features={
      ...(candidate.features||{}),
      quote_volume_24h:Number(volume24h.toFixed(2)),
      change_24h_pct:Number(dailyReturn.toFixed(3)),
      relative_24h_strength_vs_btc_pct:btcDailyReturn===null?null:Number((dailyReturn-btcDailyReturn).toFixed(3))
    };
    out.push({
      id:'HISTORICAL_CLOSED_CANDLE:'+cleanSymbol+':'+String(baseline.closeTime),
      symbol:cleanSymbol,price:baseline.close,at:baseline.closeTime,
      base_score:Number(candidate.score),tier:String(candidate.tier||'NO_SETUP'),
      observation_type:'HISTORICAL_CLOSED_CANDLE',historical_baseline:true,training_eligible:true,
      quote_volume_24h:Number(volume24h.toFixed(2)),change_24h_pct:Number(dailyReturn.toFixed(3)),
      selection_lane:'HISTORICAL_CLOSED_CANDLE',features,outcome,
      mark_price:future.close,return_pct:Number(move.toFixed(3)),
      resolved_at:future.closeTime,horizon_ms:future.closeTime-baseline.closeTime
    });
  }
  return out;
}

export function buildAdaptiveTraderClosedCandleOutcomeLabels({symbol,klines,pendingSamples=[],now=Date.now()}={}){
  const cleanSymbol=String(symbol||'').trim().toUpperCase();
  if(!/^[A-Z0-9]{5,30}$/.test(cleanSymbol)||!cleanSymbol.endsWith('USDT'))return [];
  const rows=Array.isArray(klines?.data)?klines.data:Array.isArray(klines)?klines:[];
  const candles=rows.map(row=>normalizeCandle(row)).filter(candle=>candle&&candle.closeTime<Number(now)).sort((a,b)=>a.closeTime-b.closeTime);
  if(!candles.length)return [];
  const byClose=new Map(candles.map(candle=>[candle.closeTime,candle]));
  const out=[];
  for(const sample of (Array.isArray(pendingSamples)?pendingSamples:[])){
    if(String(sample?.symbol||'').trim().toUpperCase()!==cleanSymbol||sample?.closed_candle_baseline!==true||
       sample?.training_eligible!==true||sample?.outcome)continue;
    const at=finite(sample?.at),baselinePrice=finite(sample?.price);
    if(at===null||!(baselinePrice>0)||Number(now)-at<4*60*60*1000)continue;
    const baseline=byClose.get(at),future=byClose.get(at+4*60*60*1000);
    if(!baseline||!future||future.closeTime-baseline.closeTime!==4*60*60*1000)continue;
    if(Math.abs(baseline.close-baselinePrice)>Math.max(1e-12,Math.abs(baseline.close)*1e-8))continue;
    const move=(future.close/baseline.close-1)*100;
    out.push({sample_id:String(sample.id||''),symbol:cleanSymbol,at:baseline.closeTime,
      baseline_price:baseline.close,mark_price:future.close,
      outcome:move>=2?'UP':move<=-2?'DOWN':'FLAT',return_pct:Number(move.toFixed(3)),
      resolved_at:future.closeTime,horizon_ms:future.closeTime-baseline.closeTime,
      outcome_source:'CLOSED_CANDLE_4H'});
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

export async function buildAdaptiveTraderMarketSnapshot({ rest, limit = POLICY.defaultUniverseLimit, now = Date.now(),
  offset = 0, retrySymbols = [], previousSnapshot = null, pendingSamples = [], minQuoteVolume24h = POLICY.minQuoteVolume24h } = {}) {
  if (!rest || typeof rest.request !== 'function') throw new Error('ADAPTIVE_TRADER_REST_UNAVAILABLE');
  const safeLimit = clamp(Math.trunc(Number(limit) || POLICY.defaultUniverseLimit), 20, POLICY.maxUniverseLimit);
  // BTC is only a comparative benchmark. A failure to fetch it must not block
  // the entire Spot universe when valid per-symbol closed candles are available.
  const [exchangeInfo, tickerResult, btcResult] = await Promise.all([
    rest.request('/api/v3/exchangeInfo'),
    rest.request('/api/v3/ticker/24hr'),
    rest.request('/api/v3/klines', { symbol: 'BTCUSDT', interval: '15m', limit: 240 })
      .then(value => ({value,error:null}))
      .catch(error => ({value:null,error:String(error?.message??error).slice(0,160)}))
  ]);
  const btcKlines = btcResult.value;
  const symbolInfo = Array.isArray(exchangeInfo?.data?.symbols) ? exchangeInfo.data.symbols : [];
  const activeSpot = new Set(symbolInfo.filter(item =>
    item && item.status === 'TRADING' && item.quoteAsset === 'USDT' &&
    item.isSpotTradingAllowed !== false &&
    (!Array.isArray(item.permissions) || item.permissions.length === 0 || item.permissions.includes('SPOT'))
  ).map(item => String(item.symbol || '').toUpperCase()));
  const tickers = Array.isArray(tickerResult?.data) ? tickerResult.data : [];
  const previousAsOf = Date.parse(String(previousSnapshot?.as_of || ''));
  const previousSnapshotAgeMs = Number.isFinite(previousAsOf) ? Number(now) - previousAsOf : null;
  const previousPrices = new Map((Array.isArray(previousSnapshot?.latest_prices) ? previousSnapshot.latest_prices : [])
    .map(row => [String(row?.symbol || '').toUpperCase(), finite(row?.price)]));
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
  const rotationReserve = selectedCount
    ? Math.min(selectedCount,Math.max(1,Math.ceil(selectedCount*0.15)))
    : 0;
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
  const selected=[...selectedBySymbol.values()].slice(0,selectedCount);
  // Advance by the number of rows actually traversed. Repeated priority picks
  // do not freeze coverage, and previously failed pairs cannot pin this cursor.
  const rotationAdvanceCount=rotationVisited;
  const selectionLaneCounts=selected.reduce((counts,row)=>{
    const lane=String(row?.selection_lane||'UNKNOWN');
    counts[lane]=(counts[lane]||0)+1;
    return counts;
  },{});

  const pendingBySymbol=new Map();
  for(const sample of (Array.isArray(pendingSamples)?pendingSamples:[])){
    const symbol=String(sample?.symbol||'').trim().toUpperCase();
    if(!symbol)continue;
    if(!pendingBySymbol.has(symbol))pendingBySymbol.set(symbol,[]);
    pendingBySymbol.get(symbol).push(sample);
  }
  const analyzed = await mapLimit(selected, 5, async ticker => {
    const [result,fastResult] = await Promise.all([
      rest.request('/api/v3/klines', { symbol: ticker.symbol, interval: '15m', limit: 240 }),
      rest.request('/api/v3/klines', { symbol: ticker.symbol, interval: '5m', limit: 720 })
        .then(value=>({value,error:null})).catch(error=>({value:null,error:String(error?.message??error).slice(0,120)}))
    ]);
    const candidate=scoreAdaptiveTraderCandidate({symbol:ticker.symbol,ticker,klines:result,fastKlines:fastResult.value,btcKlines,now,minQuoteVolume24h});
    const historicalSamples=buildAdaptiveTraderHistoricalOutcomeSamples({
      symbol:ticker.symbol,klines:result,fastKlines:fastResult.value,btcKlines,now,minQuoteVolume24h,maxSamples:8
    });
    const closedCandleOutcomes=buildAdaptiveTraderClosedCandleOutcomeLabels({
      symbol:ticker.symbol,klines:result,pendingSamples:pendingBySymbol.get(String(ticker.symbol||'').toUpperCase())||[],now
    });
    return {candidate,historicalSamples,closedCandleOutcomes};
  });
  const historicalTrainingSamples=analyzed.flatMap(entry=>Array.isArray(entry?.historicalSamples)?entry.historicalSamples:[]);
  const closedCandleOutcomes=analyzed.flatMap(entry=>Array.isArray(entry?.closedCandleOutcomes)?entry.closedCandleOutcomes:[]);
  const candidates = analyzed.map((entry, index) => entry?.candidate && !entry.error
    ? {
      ...entry.candidate,
      selection_lane: selected[index]?.selection_lane || 'ROTATING_COVERAGE',
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
      eligible_spot_symbols: eligible.length,
      analyzed_symbols: candidates.length,
      valid_symbols: validCount,
      monitored_spot_symbols: marketTickers.length,
      market_wide_price_tracking: true,
      price_acceleration_candidates_available: accelerationMovers.length,
      micro_5m_symbols_available: analyzed.filter(row=>row?.candidate?.features?.micro_5m_available===true).length,
      micro_5m_symbols_unavailable: Math.max(0,candidates.length-analyzed.filter(row=>row?.candidate?.features?.micro_5m_available===true).length),
      historical_training_samples_available: historicalTrainingSamples.length,
      previous_snapshot_age_ms: Number.isFinite(previousSnapshotAgeMs)?Math.max(0,Math.trunc(previousSnapshotAgeMs)):null,
      requested_limit: safeLimit,
      scan_offset: scanOffset,
      scan_advance_count: rotationAdvanceCount,
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
      selection_strategy: 'MOVER_AWARE_ACCELERATION_ROTATION_V3',
      selection_lane_counts: selectionLaneCounts,
      excluded_leveraged_tokens: true
    },
    candidates,
    // Track all active non-leveraged Spot USDT pairs even while deep-scan slots rotate.
    latest_prices: marketTickers.map(row => ({
      symbol:String(row.symbol),price:finite(row.lastPrice),
      quote_volume_24h:finite(row.quoteVolume),change_24h_pct:finite(row.priceChangePercent),
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
  const rotationCursors = new Map();
  const retryQueues = new Map();
  const flightOffsets = new Map();
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
      if(needsClosedCandleOutcomes){
        try{await active;}catch{}
        return getSnapshot({limit:safeLimit,now:Date.now(),offset:requestedOffset,pendingSamples});
      }
      // Identical requests should share one scan. A different universe size
      // waits, then gets its own scan rather than consuming the wrong result.
      if (activeLimit === safeLimit) {
        const activeOffset = flightOffsets.get(activeLimit);
        if (requestedOffset === null || activeOffset === requestedOffset) return active;
        try { await active; } catch {}
        return getSnapshot({ limit: safeLimit, now: Date.now(), offset: requestedOffset });
      }
      try { await active; } catch {}
      return getSnapshot({ limit: safeLimit, now: Date.now(), offset: requestedOffset });
    }
    const previousDeadline = Number(rest.requestDeadlineAtMs) > 0 ? Number(rest.requestDeadlineAtMs) : null;
    const deadline = Date.now() + Math.max(5_000, Math.min(60_000, Math.trunc(Number(scanTimeoutMs) || 45_000)));
    rest.requestDeadlineAtMs = previousDeadline === null ? deadline : Math.min(previousDeadline, deadline);
    const effectiveDeadline = rest.requestDeadlineAtMs;
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
      if (rest.requestDeadlineAtMs === effectiveDeadline) rest.requestDeadlineAtMs = previousDeadline;
      for (const [key, activeTask] of flights) {
        if (activeTask === task) { flights.delete(key); flightOffsets.delete(key); }
      }
    });
    flights.set(safeLimit, task);
    flightOffsets.set(safeLimit, scanOffset);
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
    daily_regime:row=>finite(row.features.change_24h_pct)!==null&&Number(row.features.change_24h_pct)>=-2&&Number(row.features.change_24h_pct)<=7
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
