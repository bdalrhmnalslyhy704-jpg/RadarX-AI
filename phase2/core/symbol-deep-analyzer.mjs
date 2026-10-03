const finite = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value)));

function cleanClosed(candles, now = Date.now()) {
  return (Array.isArray(candles) ? candles : [])
    .filter(c =>
      Number.isFinite(c?.open) &&
      Number.isFinite(c?.high) &&
      Number.isFinite(c?.low) &&
      Number.isFinite(c?.close) &&
      Number.isFinite(c?.volume) &&
      Number.isFinite(c?.quoteVolume) &&
      Number.isFinite(c?.closeTime) &&
      c.high >= c.low &&
      c.low <= c.open &&
      c.high >= c.open &&
      c.low <= c.close &&
      c.closeTime < now - 1000
    )
    .sort((a, b) => a.closeTime - b.closeTime);
}

function ema(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    seed = values[i] * k + seed * (1 - k);
    out[i] = seed;
  }
  return out;
}

function rsi(values, period = 14) {
  const out = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];
    gain += Math.max(delta, 0);
    loss += Math.max(-delta, 0);
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - (100 / (1 + gain / loss));
  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    gain = ((gain * (period - 1)) + Math.max(delta, 0)) / period;
    loss = ((loss * (period - 1)) + Math.max(-delta, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - (100 / (1 + gain / loss));
  }
  return out;
}

function atr(candles, period = 14) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    return Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
  });
  const out = Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = value;
  for (let i = period; i < candles.length; i++) {
    value = ((value * (period - 1)) + tr[i]) / period;
    out[i] = value;
  }
  return out;
}

function sma(values, period) {
  const out = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function stdDev(values, period) {
  const out = Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + ((b - mean) ** 2), 0) / period;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

function macd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const line = values.map((_, i) => fast[i] != null && slow[i] != null ? fast[i] - slow[i] : null);
  const usable = line.map(v => v ?? 0);
  const signalRaw = ema(usable, 9);
  const signal = line.map((v, i) => v == null || signalRaw[i] == null ? null : signalRaw[i]);
  const hist = line.map((v, i) => v == null || signal[i] == null ? null : v - signal[i]);
  return {line, signal, hist};
}

function adx(candles, period = 14) {
  if (candles.length < period + 2) return {adx:null, plusDi:null, minusDi:null};
  const tr = [];
  const plus = [];
  const minus = [];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  }
  let trSmooth = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let plusSmooth = plus.slice(0, period).reduce((a, b) => a + b, 0);
  let minusSmooth = minus.slice(0, period).reduce((a, b) => a + b, 0);
  const dx = [];
  let lastPlus = null;
  let lastMinus = null;
  for (let i = period; i < tr.length; i++) {
    if (i === period) {
      trSmooth = tr.slice(0, period).reduce((a, b) => a + b, 0);
      plusSmooth = plus.slice(0, period).reduce((a, b) => a + b, 0);
      minusSmooth = minus.slice(0, period).reduce((a, b) => a + b, 0);
    } else {
      trSmooth = trSmooth - (trSmooth / period) + tr[i];
      plusSmooth = plusSmooth - (plusSmooth / period) + plus[i];
      minusSmooth = minusSmooth - (minusSmooth / period) + minus[i];
    }
    const p = trSmooth === 0 ? 0 : 100 * plusSmooth / trSmooth;
    const m = trSmooth === 0 ? 0 : 100 * minusSmooth / trSmooth;
    const d = p + m === 0 ? 0 : 100 * Math.abs(p - m) / (p + m);
    dx.push({dx:d,p,m});
    lastPlus = p;
    lastMinus = m;
  }
  if (dx.length < period) return {adx:null, plusDi:lastPlus, minusDi:lastMinus};
  let adxValue = dx.slice(0, period).reduce((a, b) => a + b.dx, 0) / period;
  for (let i = period; i < dx.length; i++) adxValue = ((adxValue * (period - 1)) + dx[i].dx) / period;
  const last = dx[dx.length - 1];
  return {adx:adxValue, plusDi:last?.p ?? null, minusDi:last?.m ?? null};
}

function vwap(candles, lookback = 96) {
  const slice = candles.slice(-lookback);
  let pv = 0;
  let vol = 0;
  for (const c of slice) {
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
  }
  return vol > 0 ? pv / vol : null;
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((a,b) => a+b,0) / clean.length : null;
}

function lastFinite(values) {
  for (let i = values.length - 1; i >= 0; i--) if (Number.isFinite(values[i])) return values[i];
  return null;
}

function percentile(values, p) {
  const clean = values.filter(Number.isFinite).slice().sort((a,b)=>a-b);
  if (!clean.length) return null;
  const pos = (clean.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? clean[lo] : clean[lo] + (clean[hi] - clean[lo]) * (pos - lo);
}

function localLevels(candles, atrValue) {
  const highs = [];
  const lows = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    if (c.high >= candles[i-1].high && c.high >= candles[i-2].high && c.high >= candles[i+1].high && c.high >= candles[i+2].high) highs.push(c.high);
    if (c.low <= candles[i-1].low && c.low <= candles[i-2].low && c.low <= candles[i+1].low && c.low <= candles[i+2].low) lows.push(c.low);
  }
  const tolerance = Math.max(Number(atrValue) * 0.55, (candles[candles.length - 1]?.close || 0) * 0.0025);
  function cluster(levels) {
    const sorted = levels.filter(Number.isFinite).slice(-40).sort((a,b)=>a-b);
    const groups = [];
    for (const level of sorted) {
      const g = groups[groups.length - 1];
      if (!g || Math.abs(level - g.mean) > tolerance) groups.push({values:[level],mean:level});
      else {
        g.values.push(level);
        g.mean = g.values.reduce((a,b)=>a+b,0) / g.values.length;
      }
    }
    return groups.sort((a,b)=>b.values.length-a.values.length || Math.abs(a.mean-(candles.at(-1)?.close||0))-Math.abs(b.mean-(candles.at(-1)?.close||0)));
  }
  return {highs:cluster(highs), lows:cluster(lows)};
}

function nearestLevels(close, levels) {
  const lower = levels.filter(x=>x < close).sort((a,b)=>b-a);
  const upper = levels.filter(x=>x > close).sort((a,b)=>a-b);
  return {lower:lower[0] ?? null, upper:upper[0] ?? null};
}

function analyzeTimeframe(candles, timeframe) {
  const closes = candles.map(c=>c.close);
  const volumes = candles.map(c=>c.volume);
  const e20 = lastFinite(ema(closes,20));
  const e50 = lastFinite(ema(closes,50));
  const e100 = lastFinite(ema(closes,100));
  const e200 = lastFinite(ema(closes,200));
  const r = rsi(closes);
  const r14 = lastFinite(r);
  const rPrev = r.length > 2 ? r[r.length - 2] : null;
  const a = atr(candles);
  const atr14 = lastFinite(a);
  const m = macd(closes);
  const macdLine = lastFinite(m.line);
  const macdSignal = lastFinite(m.signal);
  const macdHist = lastFinite(m.hist);
  const macdHistPrev = m.hist.length > 2 ? m.hist[m.hist.length - 2] : null;
  const mean = lastFinite(sma(closes,20));
  const sd = lastFinite(stdDev(closes,20));
  const bbUpper = mean != null && sd != null ? mean + sd * 2 : null;
  const bbLower = mean != null && sd != null ? mean - sd * 2 : null;
  const adxData = adx(candles);
  const vw = vwap(candles);
  const recent = candles.at(-1);
  const prev = candles.at(-2);
  const rvolBase = average(volumes.slice(-21,-1));
  const rvol = rvolBase && recent ? recent.volume / rvolBase : null;
  const ret3 = candles.length > 3 ? ((recent.close / candles[candles.length-4].close)-1)*100 : null;
  const ret12 = candles.length > 12 ? ((recent.close / candles[candles.length-13].close)-1)*100 : null;
  const lowerWick = recent ? Math.max(0, Math.min(recent.open,recent.close) - recent.low) : null;
  const upperWick = recent ? Math.max(0, recent.high - Math.max(recent.open,recent.close)) : null;
  const body = recent ? Math.abs(recent.close - recent.open) : null;
  const bullishRejection = Boolean(recent && body != null && lowerWick != null && recent.close >= recent.open && lowerWick > Math.max(body * 1.15, (atr14 || 0) * 0.12));
  const bearishRejection = Boolean(recent && body != null && upperWick != null && recent.close <= recent.open && upperWick > Math.max(body * 1.15, (atr14 || 0) * 0.12));
  const levels = localLevels(candles, atr14 || recent?.close * 0.005 || 1);
  const pivots = [...levels.lows.map(x=>x.mean), ...levels.highs.map(x=>x.mean)];
  const nearest = nearestLevels(recent?.close ?? 0, pivots);
  const trendSignals = [];
  if (recent && e20 && recent.close > e20) trendSignals.push(1); else if (recent && e20) trendSignals.push(-1);
  if (recent && e50 && recent.close > e50) trendSignals.push(1); else if (recent && e50) trendSignals.push(-1);
  if (e20 && e50) trendSignals.push(e20 > e50 ? 1 : -1);
  if (e50 && e100) trendSignals.push(e50 > e100 ? 1 : -1);
  if (e100 && e200) trendSignals.push(e100 > e200 ? 1 : -1);
  const trend = trendSignals.length ? trendSignals.reduce((a,b)=>a+b,0)/trendSignals.length : 0;
  const momentumSignals = [];
  if (Number.isFinite(r14)) momentumSignals.push(clamp((r14 - 50) / 20, -1, 1));
  if (Number.isFinite(macdHist)) momentumSignals.push(clamp(macdHist / Math.max(atr14 || recent.close * 0.01, 1e-12), -1, 1));
  if (Number.isFinite(ret3)) momentumSignals.push(clamp(ret3 / 3, -1, 1));
  if (Number.isFinite(ret12)) momentumSignals.push(clamp(ret12 / 7, -1, 1));
  const momentum = average(momentumSignals) ?? 0;
  const directionScore = clamp(50 + 25 * trend + 25 * momentum);
  const reversalScore = clamp(
    50 +
    (bullishRejection ? 18 : 0) -
    (bearishRejection ? 18 : 0) +
    (r14 != null && rPrev != null && r14 > rPrev ? 10 : 0) -
    (r14 != null && rPrev != null && r14 < rPrev ? 10 : 0) +
    (rvol != null && rvol >= 1.1 ? (recent.close >= recent.open ? 8 : -8) : 0) +
    (recent && nearest.lower && Math.abs(recent.close-nearest.lower) <= (atr14||recent.close*.005)*1.25 ? 10 : 0) -
    (recent && nearest.upper && Math.abs(recent.close-nearest.upper) <= (atr14||recent.close*.005)*1.25 ? 10 : 0)
  );
  return {
    timeframe,
    candles: candles.length,
    closed_candles: candles.length,
    price: recent?.close ?? null,
    ema20:e20, ema50:e50, ema100:e100, ema200:e200,
    rsi14:r14,
    rsi_turn:r14 != null && rPrev != null ? (r14-rPrev) : null,
    atr14,
    macd:{line:macdLine,signal:macdSignal,histogram:macdHist,histogram_delta:macdHist != null && macdHistPrev != null ? macdHist-macdHistPrev:null},
    adx:adxData.adx, plus_di:adxData.plusDi, minus_di:adxData.minusDi,
    vwap:vw,
    bollinger:{middle:mean,upper:bbUpper,lower:bbLower,width:mean ? (bbUpper-bbLower)/mean*100:null},
    rvol,
    return_3_candles_pct:ret3,
    return_12_candles_pct:ret12,
    bullish_rejection:bullishRejection,
    bearish_rejection:bearishRejection,
    trend_score:Number(directionScore.toFixed(1)),
    momentum_score:Number(clamp(50 + 50 * momentum).toFixed(1)),
    reversal_score:Number(reversalScore.toFixed(1)),
    structure:{support_levels:levels.lows.slice(0,5).map(x=>({price:x.mean,touches:x.values.length})),resistance_levels:levels.highs.slice(0,5).map(x=>({price:x.mean,touches:x.values.length}))},
    nearest_support:nearest.lower,
    nearest_resistance:nearest.upper
  };
}

function depthPressure(book, price) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  const levels = rows => rows.map(x=>({p:Number(x?.[0]),q:Number(x?.[1])})).filter(x=>Number.isFinite(x.p)&&Number.isFinite(x.q)&&x.p>0&&x.q>0);
  const b = levels(bids);
  const a = levels(asks);
  const bidNotional = b.reduce((sum,x)=>sum + x.p*x.q,0);
  const askNotional = a.reduce((sum,x)=>sum + x.p*x.q,0);
  const near = rows => rows.filter(x => Math.abs(x.p-price)/Math.max(price,1e-12) <= 0.005).reduce((sum,x)=>sum+x.p*x.q,0);
  const nearBid = near(b);
  const nearAsk = near(a);
  const total = bidNotional + askNotional;
  const obi = total > 0 ? (bidNotional-askNotional)/total : null;
  const nearTotal = nearBid + nearAsk;
  const nearObi = nearTotal > 0 ? (nearBid-nearAsk)/nearTotal : null;
  return {bidNotional,askNotional,near_bid_notional:nearBid,near_ask_notional:nearAsk,obi,near_obi:nearObi,bid_levels:b.length,ask_levels:a.length};
}

function pressureScore(ticker, depth) {
  const taker = finite(ticker?.takerBuyQuoteVolume) != null && finite(ticker?.quoteVolume)
    ? Number(ticker.takerBuyQuoteVolume) / Math.max(Number(ticker.quoteVolume),1e-12)
    : null;
  const obi = finite(depth?.near_obi) ?? finite(depth?.obi);
  return {
    taker_buy_ratio:taker,
    orderbook_imbalance:obi,
    score:Number(clamp(50 + (taker != null ? (taker - 0.5) * 90 : 0) + (obi != null ? obi * 35 : 0)).toFixed(1))
  };
}

function liquidityScore(ticker, depth, price) {
  const quoteVolume = finite(ticker?.quoteVolume);
  const nearDepth = (finite(depth?.near_bid_notional)||0) + (finite(depth?.near_ask_notional)||0);
  const volComponent = quoteVolume == null ? 0 : clamp((Math.log10(Math.max(quoteVolume,1)) - 5) * 18);
  const depthComponent = nearDepth <= 0 ? 0 : clamp((Math.log10(Math.max(nearDepth,1)) - Math.log10(Math.max(price,1)) - 2) * 17);
  const score = clamp(volComponent * 0.72 + depthComponent * 0.28);
  return {score:Number(score.toFixed(1)),quote_volume_24h:quoteVolume,near_book_notional:nearDepth};
}

function combineTimeframes(rows, pressure, supportContext) {
  const weights = { '4h':0.45, '1h':0.35, '15m':0.20 };
  const weightedTrend = rows.reduce((sum,row)=>sum + ((weights[row.timeframe]||0) * (row.trend_score-50)/50),0);
  const weightedMomentum = rows.reduce((sum,row)=>sum + ((weights[row.timeframe]||0) * (row.momentum_score-50)/50),0);
  let score = 50 + weightedTrend*28 + weightedMomentum*20;
  score += ((pressure.score-50) * 0.22);
  score += ((supportContext.bonus||0));
  const up = clamp(score);
  const bias = up >= 67 ? 'UPWARD_BIAS' : up <= 33 ? 'DOWNWARD_BIAS' : 'RANGE_NEUTRAL';
  return {direction_score:Number(up.toFixed(1)),bias};
}

function analyzeZones(rows) {
  const primary = rows.find(x=>x.timeframe==='15m') || rows[0];
  const price = finite(primary?.price);
  if (price == null) return {support:null,resistance:null,retest:null,position:'UNKNOWN',bounce_signal:'UNKNOWN'};
  const supportCandidates = rows.map(x=>x.nearest_support).filter(v=>v!=null);
  const resistanceCandidates = rows.map(x=>x.nearest_resistance).filter(v=>v!=null);
  const support = supportCandidates.filter(v=>v<price).sort((a,b)=>b-a)[0] ?? null;
  const resistance = resistanceCandidates.filter(v=>v>price).sort((a,b)=>a-b)[0] ?? null;
  const atrValue = finite(primary?.atr14) || price*0.005;
  const nearSupport = support != null && Math.abs(price-support) <= atrValue*1.5;
  const nearResistance = resistance != null && Math.abs(resistance-price) <= atrValue*1.5;
  const bullish15 = primary?.bullish_rejection;
  const bearish15 = primary?.bearish_rejection;
  let position = 'MID_RANGE';
  if (nearSupport) position = 'NEAR_SUPPORT';
  else if (nearResistance) position = 'NEAR_RESISTANCE';
  let bonus = 0;
  if (nearSupport && bullish15) bonus += 8;
  if (nearResistance && bearish15) bonus -= 8;
  if (nearSupport && primary?.rsi14 != null && primary.rsi14 < 38) bonus += 5;
  if (nearResistance && primary?.rsi14 != null && primary.rsi14 > 62) bonus -= 5;
  return {
    support,
    resistance,
    distance_to_support_pct:support ? Number(((price/support-1)*100).toFixed(3)) : null,
    distance_to_resistance_pct:resistance ? Number(((resistance/price-1)*100).toFixed(3)) : null,
    retest:nearSupport ? 'SUPPORT_RETEST' : nearResistance ? 'RESISTANCE_RETEST' : 'NO_RETEST',
    position,
    bounce_signal:nearSupport && bullish15 ? 'BULLISH_REBOUND_SETUP' : nearResistance && bearish15 ? 'BEARISH_REJECTION_SETUP' : 'NOT_CONFIRMED',
    bonus
  };
}

function assessMomentum(rows) {
  const m15 = rows.find(x=>x.timeframe==='15m') || rows[0];
  const h1 = rows.find(x=>x.timeframe==='1h') || rows[0];
  const h4 = rows.find(x=>x.timeframe==='4h') || rows[0];
  const values = [
    finite(m15?.momentum_score),
    finite(h1?.momentum_score),
    finite(h4?.momentum_score)
  ];
  const score = average(values);
  const improving = (m15?.rsi_turn || 0) > 0 && (m15?.macd?.histogram_delta || 0) > 0;
  const weakening = (m15?.rsi_turn || 0) < 0 && (m15?.macd?.histogram_delta || 0) < 0;
  return {
    score:Number((score ?? 50).toFixed(1)),
    state:improving ? 'ACCELERATING' : weakening ? 'DECELERATING' : 'MIXED',
    rsi_turn_15m:finite(m15?.rsi_turn),
    macd_histogram_delta_15m:finite(m15?.macd?.histogram_delta),
    alignment:{
      '15m':m15?.momentum_score >= 58 ? 'BULLISH' : m15?.momentum_score <= 42 ? 'BEARISH':'MIXED',
      '1h':h1?.momentum_score >= 58 ? 'BULLISH' : h1?.momentum_score <= 42 ? 'BEARISH':'MIXED',
      '4h':h4?.momentum_score >= 58 ? 'BULLISH' : h4?.momentum_score <= 42 ? 'BEARISH':'MIXED'
    }
  };
}

function assessTrapRisk(rows, pressure, zones) {
  const m15 = rows.find(x=>x.timeframe==='15m') || rows[0];
  let risk = 28;
  if (pressure.score < 42 && m15?.trend_score > 60) risk += 15;
  if (m15?.rvol != null && m15.rvol > 2.5 && Math.abs(m15?.return_3_candles_pct || 0) < 0.4) risk += 10;
  if (zones.position === 'NEAR_RESISTANCE' && pressure.score < 50) risk += 12;
  if (zones.position === 'NEAR_SUPPORT' && pressure.score > 54) risk -= 8;
  if (m15?.adx != null && m15.adx < 14) risk += 4;
  return Number(clamp(risk).toFixed(1));
}

function quality(candles, ticker, depth, source) {
  const counts = candles.map(x=>x.length);
  const coverage = counts.every(x=>x>=180);
  const closeOk = counts.every(x=>x>0);
  const complete = closeOk && candles.every(arr=>arr.every(c=>c.closeTime < Date.now()));
  const score = clamp((coverage?75:55) + (complete?20:0) + (ticker?5:0));
  return {
    score:Number(score.toFixed(1)),
    closed_candles:counts.reduce((a,b)=>a+b,0),
    per_timeframe:{'15m':counts[0],'1h':counts[1],'4h':counts[2]},
    source,
    no_open_candles_used:true
  };
}

export function normalizeDeepScanSymbol(raw, quote = 'USDT') {
  const value = String(raw ?? '').trim().toUpperCase().replace(/[\/_\-\s]/g,'');
  if (!value) throw new Error('INVALID_SYMBOL');
  const safeQuote = String(quote || 'USDT').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(safeQuote)) throw new Error('INVALID_QUOTE');
  const symbol = value.endsWith(safeQuote) ? value : value + safeQuote;
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw new Error('INVALID_SYMBOL');
  return symbol;
}

export class SymbolDeepAnalyzer {
  constructor({rest,config={}}) {
    this.rest = rest;
    this.config = {
      quote: String(config.quote || 'USDT').toUpperCase(),
      klineLimit: Math.max(180, Math.min(300, Number(config.klineLimit || 240)))
    };
  }

  async scan(rawSymbol) {
    const symbol = normalizeDeepScanSymbol(rawSymbol, this.config.quote);
    const now = Date.now();
    const intervals = ['15m','1h','4h'];
    const fetched = [];
    for (const interval of intervals) {
      const result = await this.rest.klines(symbol, interval, {limit:this.config.klineLimit});
      const closed = cleanClosed(result.candles, now);
      if (closed.length < 120) throw new Error('INSUFFICIENT_CLOSED_CANDLES');
      fetched.push({interval, closed, source:result.source || 'Binance Public REST'});
    }
    const tickerResult = await this.rest.ticker24h(symbol);
    const ticker = tickerResult?.data || null;
    const depthResult = await this.rest.depth(symbol, 100);
    const depth = depthPressure(depthResult?.data, Number(ticker?.lastPrice));
    const rows = fetched.map(x=>analyzeTimeframe(x.closed,x.interval));
    const zones = analyzeZones(rows);
    const pressure = pressureScore(ticker, depth);
    const liquidity = liquidityScore(ticker, depth, Number(ticker?.lastPrice || rows[0]?.price || 1));
    const momentum = assessMomentum(rows);
    const direction = combineTimeframes(rows,pressure,zones);
    const trapRisk = assessTrapRisk(rows,pressure,zones);
    const strongBull = direction.direction_score >= 72 && pressure.score >= 58 && momentum.score >= 58;
    const strongBear = direction.direction_score <= 28 && pressure.score <= 42 && momentum.score <= 42;
    const marketRead = strongBull ? 'صعودي قوي' : strongBear ? 'هبوطي قوي' : direction.bias === 'UPWARD_BIAS' ? 'ميل صاعد' : direction.bias === 'DOWNWARD_BIAS' ? 'ميل هابط' : 'محايد / نطاقي';
    const signalContext = zones.bounce_signal !== 'NOT_CONFIRMED'
      ? zones.bounce_signal
      : (rows[0].trend_score > 62 && rows[0].rvol != null && rows[0].rvol >= 1.3 ? 'MOMENTUM_CONTINUATION_WATCH' : 'WAIT_FOR_CONFIRMATION');
    return {
      status:'ok',
      symbol,
      market:'SPOT',
      meta:{
        live:true,
        source:'Binance Public REST',
        as_of:new Date(Date.now()).toISOString(),
        paper_trading:true,
        real_order_execution:false,
        confidence_score:'UNKNOWN'
      },
      price:{
        last:finite(ticker?.lastPrice) ?? rows.find(x=>x.timeframe==='15m')?.price ?? null,
        change_24h_pct:finite(ticker?.priceChangePercent),
        high_24h:finite(ticker?.highPrice),
        low_24h:finite(ticker?.lowPrice)
      },
      assessment:{
        direction_bias:direction.bias,
        direction_score:direction.direction_score,
        market_read:marketRead,
        signal_context:signalContext,
        trap_risk:trapRisk,
        analysis_strength:Number(clamp((liquidity.score*0.22)+(momentum.score*0.32)+(pressure.score*0.28)+(100-trapRisk)*0.18).toFixed(1))
      },
      liquidity:{
        score:liquidity.score,
        quote_volume_24h:liquidity.quote_volume_24h,
        near_book_notional:liquidity.near_book_notional,
        order_book:depth
      },
      pressure:{
        score:pressure.score,
        taker_buy_ratio:pressure.taker_buy_ratio,
        orderbook_imbalance:pressure.orderbook_imbalance,
        reading:pressure.score >= 62 ? 'ضغط شراء واضح' : pressure.score <= 38 ? 'ضغط بيع واضح' : 'ضغط متوازن'
      },
      momentum,
      zones,
      timeframes:{
        '15m':rows.find(x=>x.timeframe==='15m'),
        '1h':rows.find(x=>x.timeframe==='1h'),
        '4h':rows.find(x=>x.timeframe==='4h')
      },
      data_quality:quality(fetched.map(x=>x.closed),ticker,depth,'Binance Public REST'),
      algorithms:[
        'EMA 20/50/100/200',
        'RSI 14 + divergence-ready turns',
        'MACD 12/26/9',
        'ADX 14 + directional movement',
        'ATR 14',
        'VWAP',
        'Bollinger Bands 20/2',
        'Relative Volume',
        'Taker-buy pressure',
        'Order-book imbalance within ±0.5%',
        'Fractal swing support/resistance clustering',
        'Multi-timeframe weighted regime',
        'Rejection / retest logic',
        'Trap-risk heuristic'
      ]
    };
  }
}
