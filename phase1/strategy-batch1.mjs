import {
  sma,
  ema,
  rsi,
  bollinger,
  macd,
  dailyVwap,
  rvol,
  atr,
  adx,
  rma,
  trueRange,
  lastClosedIndex,
  validateSeries,
  bodyFrac,
  upperWickFrac,
  lowerWickFrac
} from './radarx-phase1-engine.mjs';

const num = x => Number.isFinite(Number(x));
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number(x)));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const timeframeMs = Object.freeze({ '15m': 900000, '1h': 3600000, '4h': 14400000 });

function reject(strategy, reasonCodes, evidence = {}, extra = {}) {
  return {
    strategy,
    direction: 'NONE',
    state: extra.state ?? 'REJECTED',
    score: {},
    evidence,
    reasonCodes: [...new Set(reasonCodes)],
    hardGatesPassed: false,
    dataQuality: extra.dataQuality ?? 0,
    ...extra
  };
}

function prepare(series, timeframe, minBars, now) {
  if (!Array.isArray(series)) return { result: reject(null, ['INSUFFICIENT_DATA'], {}, {state:'INSUFFICIENT_DATA'}), candles: [] };
  const i = lastClosedIndex(series);
  if (i < 0) return { result: reject(null, ['INSUFFICIENT_CLOSED_DATA'], {}, {state:'INSUFFICIENT_DATA'}), candles: [] };

  const future = series.some(c => c?.closed === true && (Number(c.openTime) > now || Number(c.closeTime) > now));
  if (future) return { result: reject(null, ['FUTURE_DATA']), candles: [] };

  const candles = series.slice(0, i + 1);
  if (candles.some(c => c?.closed !== true)) return { result: reject(null, ['INCOMPLETE_CANDLE']), candles };
  if (candles.length < minBars) return { result: reject(null, ['INSUFFICIENT_DATA'], {}, {state:'INSUFFICIENT_DATA'}), candles };

  const valid = validateSeries(candles, timeframe);
  if (!valid.valid) return { result: reject(null, ['INVALID_DATA', ...valid.issues.slice(0, 4)]), candles };

  const last = candles.at(-1);
  const ageMs = Math.max(0, now - Number(last.closeTime));
  const freshnessLimit = (timeframeMs[timeframe] ?? 0) * 2;
  if (freshnessLimit && ageMs > freshnessLimit) {
    return { result: reject(null, ['STALE_DATA'], { age_ms: ageMs, freshness_limit_ms: freshnessLimit }), candles };
  }

  return { candles, ageMs, dataQuality: 100 };
}

function finalize(strategy, direction, state, score, evidence, reasonCodes, hardGatesPassed) {
  if (!hardGatesPassed) {
    return reject(strategy, reasonCodes, evidence);
  }
  return {
    strategy,
    direction,
    state,
    score: state === 'REJECTED' || state === 'INSUFFICIENT_DATA' ? {} : { value: clamp(score) },
    evidence,
    reasonCodes: [...new Set(reasonCodes)],
    hardGatesPassed: true,
    dataQuality: 100,
    confidence_score: 'UNKNOWN',
    paper_trading: true,
    real_order_execution: false
  };
}

function ribbonScore(values, i) {
  const e20 = ema(values, 20), e50 = ema(values, 50), e100 = ema(values, 100), e200 = ema(values, 200);
  if (![e20[i], e50[i], e100[i], e200[i]].every(num)) return null;
  const p = values[i];
  const spread = Math.min(
    Math.abs(e20[i] - e50[i]) / Math.max(p, 1),
    Math.abs(e50[i] - e100[i]) / Math.max(p, 1),
    Math.abs(e100[i] - e200[i]) / Math.max(p, 1)
  );
  return { e20:e20[i], e50:e50[i], e100:e100[i], e200:e200[i], spreadPct:spread*100 };
}

export function evaluateEMARibbonAlignment({series1h, config = {emaRibbonMinSeparationPct:0.08}, now = Date.now()} = {}) {
  const p = prepare(series1h, '1h', 200, now);
  if (p.result) return {...p.result, strategy:'EMA_RIBBON_ALIGNMENT'};
  const values = p.candles.map(c => c.close), i = values.length - 1, r = ribbonScore(values, i);
  if (!r) return reject('EMA_RIBBON_ALIGNMENT',['INSUFFICIENT_DATA']);
  const bullish = r.e20 > r.e50 && r.e50 > r.e100 && r.e100 > r.e200 && values[i] > r.e20;
  const bearish = r.e20 < r.e50 && r.e50 < r.e100 && r.e100 < r.e200 && values[i] < r.e20;
  const minSep = Number(config.emaRibbonMinSeparationPct ?? 0.08);
  const separationOk = r.spreadPct >= minSep;
  const evidence = { timeframe:'1h', ema20:r.e20, ema50:r.e50, ema100:r.e100, ema200:r.e200, separation_pct:r.spreadPct, minimum_separation_pct:minSep, age_ms:p.ageMs };
  if (!separationOk) return reject('EMA_RIBBON_ALIGNMENT',['RIBBON_SEPARATION_TOO_SMALL'],evidence);
  if (bullish) {
    const score = clamp(65 + Math.min(20, r.spreadPct * 80) + (values[i] > r.e20 ? 15 : 0));
    return finalize('EMA_RIBBON_ALIGNMENT','LONG','CANDIDATE',score,evidence,['BULLISH_RIBBON','EMA20_ABOVE_50_ABOVE_100_ABOVE_200','PRICE_ABOVE_RIBBON'],true);
  }
  if (bearish) {
    const score = clamp(65 + Math.min(20, r.spreadPct * 80) + (values[i] < r.e20 ? 15 : 0));
    return finalize('EMA_RIBBON_ALIGNMENT','BEARISH','CANDIDATE',score,evidence,['BEARISH_RIBBON','EMA20_BELOW_50_BELOW_100_BELOW_200','PRICE_BELOW_RIBBON'],true);
  }
  return reject('EMA_RIBBON_ALIGNMENT',['RIBBON_ALIGNMENT_NOT_MET'],evidence);
}

function diSeries(candles, n = 14) {
  const tr = trueRange(candles), pdm = Array(candles.length).fill(0), mdm = Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i-1].high;
    const down = candles[i-1].low - candles[i].low;
    pdm[i] = up > down && up > 0 ? up : 0;
    mdm[i] = down > up && down > 0 ? down : 0;
  }
  const A = rma(tr, n), P = rma(pdm, n), M = rma(mdm, n);
  return candles.map((_, i) => A[i] != null ? { plus:100*P[i]/A[i], minus:100*M[i]/A[i] } : null);
}

export function evaluateADXTrendStrength({series1h, config = {minAdx:20, minDiSeparation:5}, now = Date.now()} = {}) {
  const p = prepare(series1h, '1h', 60, now);
  if (p.result) return {...p.result, strategy:'ADX_TREND_STRENGTH'};
  const values = p.candles.map(c=>c.close), i = values.length - 1, ad = adx(p.candles, Number(config.adxPeriod ?? 14)), di = diSeries(p.candles, Number(config.adxPeriod ?? 14)), a = ad[i], d = di[i];
  const minAdx = Number(config.minAdx ?? 20), minSep = Number(config.minDiSeparation ?? 5);
  const ema50 = ema(values,50)[i];
  const evidence = { timeframe:'1h', adx:a, plus_di:d?.plus ?? null, minus_di:d?.minus ?? null, min_adx:minAdx, min_di_separation:minSep, confirmation:'trend filter + direction required', age_ms:p.ageMs };
  if (!num(a) || !d || !num(ema50)) return reject('ADX_TREND_STRENGTH',['INSUFFICIENT_DATA'],evidence);
  const bullish = a >= minAdx && d.plus - d.minus >= minSep && values[i] > ema50;
  const bearish = a >= minAdx && d.minus - d.plus >= minSep && values[i] < ema50;
  if (bullish) return finalize('ADX_TREND_STRENGTH','LONG','CANDIDATE',clamp(50 + Math.min(35,(a-minAdx)*1.5) + Math.min(15,(d.plus-d.minus))),evidence,['ADX_STRONG','PLUS_DI_DOMINANT','PRICE_ABOVE_EMA50'],true);
  if (bearish) return finalize('ADX_TREND_STRENGTH','BEARISH','CANDIDATE',clamp(50 + Math.min(35,(a-minAdx)*1.5) + Math.min(15,(d.minus-d.plus))),evidence,['ADX_STRONG','MINUS_DI_DOMINANT','PRICE_BELOW_EMA50'],true);
  return reject('ADX_TREND_STRENGTH', a < minAdx ? ['ADX_TOO_WEAK','ADX_IS_CONFIRMATION_NOT_ENTRY'] : ['ADX_DIRECTION_CONFIRMATION_NOT_MET'],evidence);
}

export function evaluateMACDTrendContinuation({series1h, series4h, config = {minHistogramFraction:0}, now = Date.now()} = {}) {
  const p1 = prepare(series1h,'1h',60,now), p4 = prepare(series4h,'4h',35,now);
  if (p1.result || p4.result) {
    const reason = [...(p1.result?.reasonCodes ?? []), ...(p4.result?.reasonCodes ?? [])].includes('INSUFFICIENT_CLOSED_DATA') || p1.candles.length<60 || p4.candles.length<35 ? 'INSUFFICIENT_DATA' : 'INVALID_DATA';
    return reject('MACD_TREND_CONTINUATION',[reason]);
  }
  const c1=p1.candles,c4=p4.candles,v1=c1.map(c=>c.close),v4=c4.map(c=>c.close),i1=v1.length-1,i4=v4.length-1,m1=macd(v1,12,26,9),m4=macd(v4,12,26,9);
  const line=m1.line[i1], sig=m1.signal[i1], hist=m1.histogram[i1], prevHist=m1.histogram[i1-1], highLine=m4.line[i4], highSig=m4.signal[i4];
  const aboveHigher = num(highLine) && num(highSig) && highLine > highSig, belowHigher = num(highLine) && num(highSig) && highLine < highSig;
  const bullish = num(line)&&num(sig)&&num(hist)&&line>sig&&hist>Number(config.minHistogramFraction??0)&&aboveHigher;
  const bearish = num(line)&&num(sig)&&num(hist)&&line<sig&&hist< -Number(config.minHistogramFraction??0)&&belowHigher;
  const weakeningBull = bullish && num(prevHist) && hist < prevHist, weakeningBear = bearish && num(prevHist) && hist > prevHist;
  const evidence={timeframe:'1h',higher_timeframe:'4h',macd_line:line,signal:sig,histogram:hist,previous_histogram:prevHist,higher_macd_line:highLine,higher_signal:highSig,continuation_context:true,age_ms_1h:p1.ageMs,age_ms_4h:p4.ageMs};
  if (bullish && !weakeningBull) return finalize('MACD_TREND_CONTINUATION','LONG','CANDIDATE',clamp(60+Math.min(20,Math.abs(hist)*1000)+10),evidence,['MACD_BULLISH_CONTINUATION','HIGHER_TF_CONFIRMATION'],true);
  if (bearish && !weakeningBear) return finalize('MACD_TREND_CONTINUATION','BEARISH','CANDIDATE',clamp(60+Math.min(20,Math.abs(hist)*1000)+10),evidence,['MACD_BEARISH_CONTINUATION','HIGHER_TF_CONFIRMATION'],true);
  if (weakeningBull || weakeningBear) return reject('MACD_TREND_CONTINUATION',['MACD_WEAKENING_OR_DIVERGENCE'],evidence);
  return reject('MACD_TREND_CONTINUATION',['MACD_CONFIRMATION_NOT_MET'],evidence);
}

export function evaluateBollingerBandReversion({series1h, config = {rsiPeriod:14,bbPeriod:20,bbStdDev:2,panicRvol:3}, now = Date.now()} = {}) {
  const p=prepare(series1h,'1h',40,now);
  if (p.result) return {...p.result,strategy:'BOLLINGER_BAND_REVERSION'};
  const c=p.candles,v=c.map(x=>x.close),i=v.length-1,x=c[i],bb=bollinger(v,Number(config.bbPeriod??20),Number(config.bbStdDev??2)),rr=rsi(v,Number(config.rsiPeriod??14)),rv=rvol(c.map(z=>z.volume),20);
  const adxv=adx(c,14)[i], e200=ema(v,Math.min(200,c.length))[i], panic=(rv[i]??0)>=Number(config.panicRvol??3)&&bodyFrac(x)>=.65&&x.close<x.open;
  const lower=bb.lower[i],upper=bb.upper[i], evidence={timeframe:'1h',lower_band:lower,middle_band:bb.middle[i],upper_band:upper,rsi:rr[i],rvol:rv[i],panic_volume:panic,regime_adx:adxv,age_ms:p.ageMs};
  if (panic) return reject('BOLLINGER_BAND_REVERSION',['PANIC_VOLUME_REJECTION'],evidence);
  const strongBear=num(adxv)&&adxv>=30&&x.close<e200, strongBull=num(adxv)&&adxv>=30&&x.close>e200;
  const bull = num(lower)&&num(rr[i])&&x.close<=lower&&rr[i]<=35&&x.close>x.open&&lowerWickFrac(x)>=.2&&!strongBear;
  const bear = num(upper)&&num(rr[i])&&x.close>=upper&&rr[i]>=65&&x.close<x.open&&upperWickFrac(x)>=.2&&!strongBull;
  if (bull) return finalize('BOLLINGER_BAND_REVERSION','LONG','CANDIDATE',clamp(60+Math.min(20,(35-rr[i])*2)+Math.min(20,lowerWickFrac(x)*50)),evidence,['LOWER_BAND_TOUCH','RSI_OVERSOLD','BULLISH_CANDLE_REVERSAL','REGIME_FILTER_OK'],true);
  if (bear) return finalize('BOLLINGER_BAND_REVERSION','BEARISH','CANDIDATE',clamp(60+Math.min(20,(rr[i]-65)*2)+Math.min(20,upperWickFrac(x)*50)),evidence,['UPPER_BAND_TOUCH','RSI_OVERBOUGHT','BEARISH_CANDLE_REVERSAL','REGIME_FILTER_OK'],true);
  return reject('BOLLINGER_BAND_REVERSION',['BOLLINGER_REVERSION_FILTER_NOT_MET'],evidence);
}

export function evaluateVWAPReversion({series15m, liquidityQuality=0, config = {minLiquidityQuality:60,minDeviationPct:1}, now = Date.now()} = {}) {
  const p=prepare(series15m,'15m',30,now);
  if (p.result) return {...p.result,strategy:'VWAP_REVERSION'};
  const c=p.candles,v=c.map(x=>x.close),i=v.length-1,x=c[i],vw=dailyVwap(c),current=vw[i],prev=vw[i-1],dev=num(current)?(x.close-current)/current*100:null;
  const minDev=Math.abs(Number(config.minDeviationPct??1)), evidence={timeframe:'15m',daily_vwap:current,deviation_pct:dev,min_deviation_pct:minDev,liquidity_quality:liquidityQuality,age_ms:p.ageMs};
  if (liquidityQuality < Number(config.minLiquidityQuality??60)) return reject('VWAP_REVERSION',['LOW_LIQUIDITY'],evidence);
  if (!num(dev) || !num(prev) || Math.abs(dev)<minDev) return reject('VWAP_REVERSION',['VWAP_DEVIATION_TOO_SMALL'],evidence);
  const bullishReturn=x.close>x.open && x.close>v[i-1] && x.low<=current && x.close<current;
  const bearishReturn=x.close<x.open && x.close<v[i-1] && x.high>=current && x.close>current;
  if (bullishReturn) return finalize('VWAP_REVERSION','LONG','CANDIDATE',clamp(65+Math.min(25,Math.abs(dev)*8)),evidence,['VWAP_UNDERSHOOT','RETURN_TOWARD_VWAP','BULLISH_REVERSAL_CANDLE'],true);
  if (bearishReturn) return finalize('VWAP_REVERSION','BEARISH','CANDIDATE',clamp(65+Math.min(25,Math.abs(dev)*8)),evidence,['VWAP_OVERSHOOT','RETURN_TOWARD_VWAP','BEARISH_REVERSAL_CANDLE'],true);
  return reject('VWAP_REVERSION',['VWAP_RETURN_CONFIRMATION_NOT_MET'],evidence);
}

export function evaluateRelativeVolumeSurge({series15m, config = {rvolPeriod:20,minRvol:1.8,minBodyFraction:.25}, now = Date.now()} = {}) {
  const p=prepare(series15m,'15m',25,now);
  if (p.result) return {...p.result,strategy:'RELATIVE_VOLUME_SURGE'};
  const c=p.candles,v=c.map(x=>x.close),i=v.length-1,x=c[i],rv=rvol(c.map(z=>z.volume),Number(config.rvolPeriod??20)),e20=ema(v,20)[i],r=rv[i],body=bodyFrac(x);
  const evidence={timeframe:'15m',rvol_period:Number(config.rvolPeriod??20),rvol:r,body_fraction:body,close:x.close,previous_close:v[i-1],ema20:e20,age_ms:p.ageMs};
  if (!num(r)||r<Number(config.minRvol??1.8)) return reject('RELATIVE_VOLUME_SURGE',['RVOL_THRESHOLD_NOT_MET'],evidence);
  const bullish=x.close>x.open&&x.close>v[i-1]&&x.close>(e20??-Infinity),bearish=x.close<x.open&&x.close<v[i-1]&&x.close<(e20??Infinity);
  if (body < Number(config.minBodyFraction??.25)) return reject('RELATIVE_VOLUME_SURGE',['PRICE_ACTION_TOO_WEAK'],evidence);
  if (bullish) return finalize('RELATIVE_VOLUME_SURGE','LONG','CANDIDATE',clamp(55+Math.min(30,(r-1)*20)+Math.min(15,body*20)),evidence,['RVOL_SURGE','BULLISH_PRICE_ACTION','EMA20_CONTEXT'],true);
  if (bearish) return finalize('RELATIVE_VOLUME_SURGE','BEARISH','CANDIDATE',clamp(55+Math.min(30,(r-1)*20)+Math.min(15,body*20)),evidence,['RVOL_SURGE','BEARISH_PRICE_ACTION','EMA20_CONTEXT'],true);
  return reject('RELATIVE_VOLUME_SURGE',['PRICE_DIRECTION_CONTEXT_NOT_MET'],evidence);
}

export function evaluateATRExpansion({series15m, liquidityQuality=0, config = {atrPeriod:14,atrAveragePeriod:20,minExpansionRatio:1.35,minLiquidityQuality:60,minBodyFraction:.35}, now = Date.now()} = {}) {
  const p=prepare(series15m,'15m',40,now);
  if (p.result) return {...p.result,strategy:'ATR_EXPANSION'};
  const c=p.candles,v=c.map(x=>x.close),i=v.length-1,x=c[i],a=atr(c,Number(config.atrPeriod??14)),current=a[i],prior=a.slice(Math.max(0,i-Number(config.atrAveragePeriod??20)),i).filter(num),baseline=mean(prior),ratio=num(current)&&num(baseline)&&baseline>0?current/baseline:null,body=bodyFrac(x);
  const evidence={timeframe:'15m',atr_period:Number(config.atrPeriod??14),atr_current:current,atr_baseline:baseline,expansion_ratio:ratio,min_expansion_ratio:Number(config.minExpansionRatio??1.35),body_fraction:body,liquidity_quality:liquidityQuality,age_ms:p.ageMs};
  if(liquidityQuality<Number(config.minLiquidityQuality??60)) return reject('ATR_EXPANSION',['LOW_LIQUIDITY'],evidence);
  if(!num(ratio)||ratio<Number(config.minExpansionRatio??1.35)) return reject('ATR_EXPANSION',['ATR_EXPANSION_NOT_MET'],evidence);
  if(body<Number(config.minBodyFraction??.35)) return reject('ATR_EXPANSION',['PRICE_CONFIRMATION_WEAK'],evidence);
  const bullish=x.close>x.open&&x.close>v[i-1],bearish=x.close<x.open&&x.close<v[i-1];
  if(bullish) return finalize('ATR_EXPANSION','LONG','CANDIDATE',clamp(60+Math.min(25,(ratio-1)*35)+Math.min(15,body*20)),evidence,['ATR_EXPANDING','BULLISH_PRICE_CONFIRMATION','LIQUIDITY_OK'],true);
  if(bearish) return finalize('ATR_EXPANSION','BEARISH','CANDIDATE',clamp(60+Math.min(25,(ratio-1)*35)+Math.min(15,body*20)),evidence,['ATR_EXPANDING','BEARISH_PRICE_CONFIRMATION','LIQUIDITY_OK'],true);
  return reject('ATR_EXPANSION',['PRICE_DIRECTION_CONTEXT_NOT_MET'],evidence);
}

export const STRATEGY_BATCH_1 = Object.freeze({
  EMA_RIBBON_ALIGNMENT: evaluateEMARibbonAlignment,
  ADX_TREND_STRENGTH: evaluateADXTrendStrength,
  MACD_TREND_CONTINUATION: evaluateMACDTrendContinuation,
  BOLLINGER_BAND_REVERSION: evaluateBollingerBandReversion,
  VWAP_REVERSION: evaluateVWAPReversion,
  RELATIVE_VOLUME_SURGE: evaluateRelativeVolumeSurge,
  ATR_EXPANSION: evaluateATRExpansion
});
