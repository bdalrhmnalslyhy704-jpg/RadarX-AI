import { buildBottomMarketContext, buildPreMoveContext } from '../market/universe-scanner.mjs';

const MIN_HISTORY_BARS = 300;
const INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const finite = value => value !== null && value !== undefined && value !== '' &&
  typeof value !== 'boolean' && Number.isFinite(Number(value));
const numberOrNull = value => finite(value) ? Number(value) : null;
const pct = (from, to) => Number.isFinite(from) && from > 0 && Number.isFinite(to)
  ? (to / from - 1) * 100 : null;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function normalizedCandles(input, now) {
  const rows = Array.isArray(input) ? input : [];
  const out = rows.map(row => {
    if (!row || typeof row !== 'object') return null;
    const openTime = numberOrNull(row.openTime ?? row.open_time ?? row.t);
    const closeTime = numberOrNull(row.closeTime ?? row.close_time ?? row.T);
    const open = numberOrNull(row.open ?? row.o);
    const high = numberOrNull(row.high ?? row.h);
    const low = numberOrNull(row.low ?? row.l);
    const close = numberOrNull(row.close ?? row.c);
    const volume = numberOrNull(row.volume ?? row.v);
    const quoteVolume = numberOrNull(row.quoteVolume ?? row.quote_volume ?? row.q);
    const tradeCount = numberOrNull(row.tradeCount ?? row.trade_count ?? row.count);
    const takerBuyBaseVolume = numberOrNull(row.takerBuyBaseVolume ?? row.taker_buy_base_volume);
    const takerBuyQuoteVolume = numberOrNull(row.takerBuyQuoteVolume ?? row.taker_buy_quote_volume);
    if ([openTime, closeTime, open, high, low, close, volume].some(value => value === null)) return null;
    if (openTime <= 0 || closeTime <= openTime || closeTime > now || row.closed === false) return null;
    if (open <= 0 || close <= 0 || low <= 0 || volume < 0 ||
        high < Math.max(open, close) || low > Math.min(open, close) || high < low) return null;
    return {
      openTime, closeTime, open, high, low, close, volume,
      quoteVolume: quoteVolume !== null && quoteVolume >= 0 ? quoteVolume : volume * close,
      tradeCount: tradeCount !== null && tradeCount >= 0 ? tradeCount : null,
      takerBuyBaseVolume: takerBuyBaseVolume !== null && takerBuyBaseVolume >= 0 ? takerBuyBaseVolume : null,
      takerBuyQuoteVolume: takerBuyQuoteVolume !== null && takerBuyQuoteVolume >= 0 ? takerBuyQuoteVolume : null
    };
  }).filter(Boolean).sort((a, b) => a.closeTime - b.closeTime);
  const deduped = [];
  for (const row of out) {
    if (deduped.length && deduped[deduped.length - 1].closeTime === row.closeTime) deduped[deduped.length - 1] = row;
    else deduped.push(row);
  }
  return deduped;
}

function aggregateClosedFiveMinuteCandles(rows, targetIntervalMs, asOf) {
  const count = targetIntervalMs / INTERVAL_MS;
  if (!Number.isInteger(count) || count < 1) return [];
  const buckets = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const openTime = Number(row?.openTime), closeTime = Number(row?.closeTime);
    if (!Number.isFinite(openTime) || !Number.isFinite(closeTime) ||
        closeTime > asOf || closeTime !== openTime + INTERVAL_MS - 1) continue;
    const bucketStart = Math.floor(openTime / targetIntervalMs) * targetIntervalMs;
    if (!buckets.has(bucketStart)) buckets.set(bucketStart, []);
    buckets.get(bucketStart).push(row);
  }
  const out = [];
  for (const [bucketStart, group] of [...buckets.entries()].sort((a,b)=>a[0]-b[0])) {
    group.sort((a,b)=>Number(a.openTime)-Number(b.openTime));
    if (group.length !== count) continue;
    let contiguous = true;
    for (let i=0;i<count;i++) {
      const expectedOpen = bucketStart + i * INTERVAL_MS;
      if (Number(group[i]?.openTime) !== expectedOpen ||
          Number(group[i]?.closeTime) !== expectedOpen + INTERVAL_MS - 1) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous || bucketStart + targetIntervalMs - 1 > asOf) continue;
    const sumField = field => group.every(row => finite(row?.[field]))
      ? group.reduce((sum,row)=>sum+Number(row[field]),0) : null;
    out.push({
      openTime:bucketStart,
      closeTime:bucketStart + targetIntervalMs - 1,
      open:Number(group[0].open),
      high:Math.max(...group.map(row=>Number(row.high))),
      low:Math.min(...group.map(row=>Number(row.low))),
      close:Number(group.at(-1).close),
      volume:group.reduce((sum,row)=>sum+Number(row.volume),0),
      quoteVolume:sumField('quoteVolume'),
      tradeCount:sumField('tradeCount'),
      takerBuyBaseVolume:sumField('takerBuyBaseVolume'),
      takerBuyQuoteVolume:sumField('takerBuyQuoteVolume'),
      closed:true,
      source:'BINANCE_SPOT_CLOSED_5M_AGGREGATED'
    });
  }
  return out;
}

function adenMorningStartMs(now) {
  const offsetMs = 3 * 60 * 60 * 1000;
  const local = new Date(now + offsetMs);
  local.setUTCHours(4,0,0,0);
  let start = local.getTime() - offsetMs;
  if (start > now) start -= DAY_MS;
  return start;
}

/**
 * Replays the production Pre-Move core against only candles that had closed by
 * the requested historical timestamp. It deliberately does not claim to replay
 * historical order-book liquidity, persisted 24h-ticker activity baselines,
 * scan-rotation timing, or phone push delivery.
 */
function replayProductionPreMoveCore(symbol, candles, benchmarkRows, asOf) {
  const available = (Array.isArray(candles)?candles:[])
    .filter(row=>Number(row?.closeTime)<=asOf)
    .sort((a,b)=>Number(a.closeTime)-Number(b.closeTime));
  const latest = available.at(-1) || null;
  const empty = (status, reason) => ({
    status, symbol, as_of:new Date(asOf).toISOString(),
    source:'BINANCE_SPOT_CLOSED_5M_CANDLES',
    no_future_data_used:true,
    latest_closed_candle_at:latest?new Date(latest.closeTime).toISOString():null,
    history:{closed_5m_candles:available.length,continuous_trailing_24h:false},
    core_setup_gate_passed:false,
    full_alert_reconstruction:'UNKNOWN_HISTORICAL_ORDERBOOK_AND_TICKER_ACTIVITY_BASELINE_UNAVAILABLE',
    reason
  });
  if (!latest || available.length < MIN_HISTORY_BARS) {
    return empty('INSUFFICIENT_HISTORY','NEED_AT_LEAST_300_CLOSED_5M_CANDLES');
  }
  const endIndex = available.length - 1;
  const dailyReturnWindow = available.slice(endIndex-288,endIndex+1);
  const trailingVolumeWindow = available.slice(endIndex-287,endIndex+1);
  const continuousTrailing24h = dailyReturnWindow.length===289 &&
    dailyReturnWindow.every((row,i)=>i===0||
      Number(row.closeTime)-Number(dailyReturnWindow[i-1].closeTime)===INTERVAL_MS);
  const priceChange24h = continuousTrailing24h
    ? pct(Number(dailyReturnWindow[0].close),Number(latest.close)) : null;
  const quoteVolume24h = continuousTrailing24h &&
    trailingVolumeWindow.every(row=>finite(row.quoteVolume))
    ? trailingVolumeWindow.reduce((sum,row)=>sum+Number(row.quoteVolume),0) : null;
  const tradeCount24h = continuousTrailing24h &&
    trailingVolumeWindow.every(row=>finite(row.tradeCount))
    ? trailingVolumeWindow.reduce((sum,row)=>sum+Number(row.tradeCount),0) : null;
  const highPrice24h = continuousTrailing24h
    ? Math.max(...trailingVolumeWindow.map(row=>Number(row.high))) : null;
  const lowPrice24h = continuousTrailing24h
    ? Math.min(...trailingVolumeWindow.map(row=>Number(row.low))) : null;
  const ticker = {
    symbol, lastPrice:Number(latest.close),
    priceChange24h, quoteVolume24h, tradeCount24h,
    highPrice24h, lowPrice24h,
    dataQuality:continuousTrailing24h?100:null,
    tickerTime:Number(latest.closeTime)
  };
  const series = {
    '15m':aggregateClosedFiveMinuteCandles(available,15*60*1000,asOf),
    '1h':aggregateClosedFiveMinuteCandles(available,60*60*1000,asOf),
    '4h':aggregateClosedFiveMinuteCandles(available,4*60*60*1000,asOf)
  };
  const contextCandleCount = series['15m'].length;
  if (contextCandleCount < 16) {
    return {
      ...empty('INSUFFICIENT_AGGREGATED_HISTORY','NEED_AT_LEAST_16_COMPLETE_CLOSED_15M_CANDLES'),
      history:{closed_5m_candles:available.length,closed_15m_candles:contextCandleCount,
        closed_1h_candles:series['1h'].length,closed_4h_candles:series['4h'].length,
        continuous_trailing_24h:continuousTrailing24h}
    };
  }
  const sessionStart = adenMorningStartMs(asOf);
  const btc15 = aggregateClosedFiveMinuteCandles(
    (Array.isArray(benchmarkRows)?benchmarkRows:[]).filter(row=>Number(row?.closeTime)<=asOf),
    15*60*1000,asOf
  );
  const btcSession = btc15.filter(row=>Number(row.closeTime)>=sessionStart&&Number(row.closeTime)<=asOf);
  const btcOpen = Number(btcSession[0]?.open);
  const btcClose = Number(btcSession.at(-1)?.close);
  const btcReturn = Number.isFinite(btcOpen)&&btcOpen>0&&Number.isFinite(btcClose)
    ? (btcClose-btcOpen)/btcOpen*100 : null;
  try {
    const bottom = buildBottomMarketContext(series,ticker,asOf);
    const context = buildPreMoveContext(series,ticker,asOf,bottom,{btcReturn});
    const coreReady = continuousTrailing24h &&
      ['READY','EARLY_WAKE'].includes(context.stage) &&
      context.evidence_complete===true &&
      context.flow_transition_confirmed===true &&
      context.price_window_valid===true &&
      context.structure_confirmed===true &&
      context.already_moved!==true;
    return {
      status:continuousTrailing24h?'CORE_CONTEXT_REPLAYED':'INCOMPLETE_TRAILING_24H_HISTORY',
      symbol,as_of:new Date(asOf).toISOString(),
      source:'BINANCE_SPOT_CLOSED_5M_AGGREGATED_TO_15M',
      no_future_data_used:available.every(row=>Number(row.closeTime)<=asOf),
      latest_closed_candle_at:new Date(latest.closeTime).toISOString(),
      history:{
        closed_5m_candles:available.length,closed_15m_candles:series['15m'].length,
        closed_1h_candles:series['1h'].length,closed_4h_candles:series['4h'].length,
        continuous_trailing_24h:continuousTrailing24h,
        reconstructed_24h_return_pct:priceChange24h,
        reconstructed_quote_volume_24h:quoteVolume24h,
        historical_ticker_fields_reconstructed_from_candles:true
      },
      market_context:{btc_session_return_pct:Number.isFinite(btcReturn)?btcReturn:null},
      core:{
        stage:context.stage,score:context.score,evidence_complete:context.evidence_complete,
        flow_transition_confirmed:context.flow_transition_confirmed,
        price_window_valid:context.price_window_valid,structure_confirmed:context.structure_confirmed,
        already_moved:context.already_moved,session_return_pct:context.session_return_pct,
        one_hour_return_pct:context.one_hour_return_pct,
        volume_acceleration:context.volume_acceleration,trade_acceleration:context.trade_acceleration,
        taker_buy_ratio:context.taker_buy_ratio,taker_buy_acceleration:context.taker_buy_acceleration,
        mean_close_location:context.mean_close_location,
        relative_strength_vs_btc_pct:context.relative_strength_vs_btc_pct,
        components:context.components,missing_evidence:context.missing_evidence,reasons:context.reasons
      },
      core_setup_gate_passed:coreReady,
      full_alert_reconstruction:'UNKNOWN_HISTORICAL_ORDERBOOK_AND_TICKER_ACTIVITY_BASELINE_UNAVAILABLE',
      limitation:'CORE_STAGE_REPLAY_ONLY_NOT_PROOF_THAT_A_LIVE_ALERT_OR_PHONE_PUSH_WOULD_HAVE_OCCURRED'
    };
  } catch (error) {
    return empty('CORE_REPLAY_ERROR',String(error?.message??error??'CORE_REPLAY_ERROR').slice(0,160));
  }
}

function indexAtOrBefore(rows, time) {
  let low = 0, high = rows.length - 1, answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (rows[middle].closeTime <= time) {
      answer = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return answer;
}

function returnAtHorizon(rows, index, candlesBack) {
  const startIndex = index - candlesBack;
  if (startIndex < 0) return null;
  const start = rows[startIndex], end = rows[index];
  if (!start || !end) return null;
  if (Math.abs((end.closeTime - start.closeTime) - candlesBack * INTERVAL_MS) > 10 * 60 * 1000) return null;
  return pct(start.close, end.close);
}

function averageRatio(rows, index, getter, recentCount = 3, priorCount = 24) {
  const recentStart = index - recentCount + 1;
  const priorEnd = recentStart - 1;
  const priorStart = priorEnd - priorCount + 1;
  if (priorStart < 0) return null;
  const recentValues = rows.slice(recentStart, index + 1).map(getter);
  const priorValues = rows.slice(priorStart, priorEnd + 1).map(getter);
  if ([...recentValues, ...priorValues].some(value => value === null || !Number.isFinite(value))) return null;
  const recentMean = mean(recentValues), priorMean = mean(priorValues);
  return priorMean > 0 ? recentMean / priorMean : null;
}

function bandWidth(rows, start, end) {
  if (start < 0 || end - start + 1 < 20) return null;
  const closes = rows.slice(end - 19, end + 1).map(row => row.close);
  if (closes.length !== 20) return null;
  const middle = mean(closes);
  if (!(middle > 0)) return null;
  const variance = mean(closes.map(value => (value - middle) ** 2));
  return Math.sqrt(variance) * 4 / middle * 100;
}

function benchmarkReturnAt(benchmark, timestamp, candlesBack) {
  if (!benchmark.length) return null;
  const endIndex = indexAtOrBefore(benchmark, timestamp);
  if (endIndex < candlesBack) return null;
  const end = benchmark[endIndex], start = benchmark[endIndex - candlesBack];
  if (timestamp - end.closeTime > 10 * 60 * 1000 || Math.abs((end.closeTime - start.closeTime) - candlesBack * INTERVAL_MS) > 10 * 60 * 1000) return null;
  return pct(start.close, end.close);
}

function knownFlag(value) {
  return typeof value === 'boolean' ? value : null;
}

function earlyEvidence(features) {
  const checks = {
    volume_activity_expanding: features.quote_volume_ratio_15m_vs_prior_2h === null
      ? null : features.quote_volume_ratio_15m_vs_prior_2h >= 1.30,
    trade_activity_expanding: features.trade_count_ratio_15m_vs_prior_2h === null
      ? null : features.trade_count_ratio_15m_vs_prior_2h >= 1.20,
    buyer_pressure_positive: features.taker_buy_share_15m === null
      ? null : features.taker_buy_share_15m >= 0.52,
    volatility_compressed: features.compression_ratio_20_vs_previous_20 === null
      ? null : features.compression_ratio_20_vs_previous_20 <= 0.85,
    three_higher_lows: knownFlag(features.three_higher_lows),
    relative_strength_vs_btc_positive: features.relative_strength_vs_btc_1h_pct === null
      ? null : features.relative_strength_vs_btc_1h_pct > 0,
    not_extended_24h: features.return_24h_pct === null
      ? null : features.return_24h_pct >= -8 && features.return_24h_pct <= 8,
    not_chasing_1h: features.return_1h_pct === null
      ? null : features.return_1h_pct <= 3 && features.return_1h_pct >= -8,
    close_near_prior_resistance: features.distance_below_prior_1h_high_pct === null
      ? null : features.distance_below_prior_1h_high_pct >= -0.2 && features.distance_below_prior_1h_high_pct <= 2
  };
  const known = Object.values(checks).filter(value => value !== null);
  return {
    checks,
    evidence_count: known.filter(Boolean).length,
    evidence_checks_known: known.length,
    interpretation: 'DESCRIPTIVE_FEATURE_CHECKS_NOT_A_VALIDATED_PROBABILITY'
  };
}

function featuresAt(rows, index, benchmarkRows) {
  if (index < 0 || index >= rows.length) return null;
  const row = rows[index];
  const return1h = returnAtHorizon(rows, index, 12);
  const benchmark1h = benchmarkReturnAt(benchmarkRows, row.closeTime, 12);
  const last20Width = bandWidth(rows, index - 19, index);
  const previous20Width = bandWidth(rows, index - 39, index - 20);
  const lows = index >= 2 ? rows.slice(index - 2, index + 1).map(item => item.low) : [];
  const priorRange = index >= 12 ? rows.slice(index - 12, index) : [];
  const oneHourRange = priorRange.length
    ? (Math.max(...priorRange.map(item => item.high)) / Math.min(...priorRange.map(item => item.low)) - 1) * 100
    : null;
  const candleRange = row.high - row.low;
  const recentTaker = rows.slice(Math.max(0, index - 2), index + 1);
  const takerBase = recentTaker.every(item => item.takerBuyBaseVolume !== null)
    ? recentTaker.reduce((sum, item) => sum + item.takerBuyBaseVolume, 0) : null;
  const takerQuote = recentTaker.every(item => item.takerBuyQuoteVolume !== null)
    ? recentTaker.reduce((sum, item) => sum + item.takerBuyQuoteVolume, 0) : null;
  const recentBaseVolume = recentTaker.reduce((sum, item) => sum + item.volume, 0);
  const recentQuoteVolume = recentTaker.reduce((sum, item) => sum + item.quoteVolume, 0);
  const takerShare = takerQuote !== null && recentQuoteVolume > 0 ? takerQuote / recentQuoteVolume
    : takerBase !== null && recentBaseVolume > 0 ? takerBase / recentBaseVolume : null;
  const return24h = returnAtHorizon(rows, index, 288);
  const distanceToHigh = priorRange.length && row.close > 0
    ? (Math.max(...priorRange.map(item => item.high)) / row.close - 1) * 100 : null;
  const features = {
    price: row.close,
    observed_at: new Date(row.closeTime).toISOString(),
    return_5m_pct: returnAtHorizon(rows, index, 1),
    return_15m_pct: returnAtHorizon(rows, index, 3),
    return_1h_pct: return1h,
    return_4h_pct: returnAtHorizon(rows, index, 48),
    return_24h_pct: return24h,
    quote_volume_ratio_15m_vs_prior_2h: averageRatio(rows, index, item => item.quoteVolume),
    trade_count_ratio_15m_vs_prior_2h: averageRatio(rows, index, item => item.tradeCount),
    taker_buy_share_15m: takerShare,
    compression_ratio_20_vs_previous_20: last20Width !== null && previous20Width !== null && previous20Width > 0
      ? last20Width / previous20Width : null,
    bollinger_width_20_pct: last20Width,
    range_1h_pct: oneHourRange,
    distance_below_prior_1h_high_pct: distanceToHigh,
    close_location_pct: candleRange > 0 ? (row.close - row.low) / candleRange * 100 : null,
    three_higher_lows: lows.length === 3 ? lows[0] < lows[1] && lows[1] < lows[2] : null,
    relative_strength_vs_btc_1h_pct: return1h !== null && benchmark1h !== null ? return1h - benchmark1h : null,
    data_basis: 'BINANCE_SPOT_CLOSED_5M_CANDLES',
    historical_orderbook_spread: null,
    historical_orderbook_imbalance: null
  };
  features.early_evidence = earlyEvidence(features);
  return features;
}

function buildFirstIntradayRunup(rows, benchmarkRows, {
  now = Date.now(), searchWindowHours = 24, runupWindowHours = 4, thresholdPct = 5
} = {}) {
  const asOf = Number(now);
  const lookbackHours = Number(searchWindowHours);
  const localWindowHours = Number(runupWindowHours);
  const threshold = Number(thresholdPct);
  const base = {
    status: 'NO_RUNUP_THRESHOLD_CROSSING_IN_WINDOW',
    source: 'BINANCE_SPOT_CLOSED_5M_CANDLES',
    definition: 'FIRST_CLOSED_5M_CLOSE_AT_LEAST_THRESHOLD_PCT_ABOVE_THE_LOWEST_LOW_IN_THE_PRIOR_4H',
    search_window_hours: lookbackHours,
    runup_window_hours: localWindowHours,
    threshold_pct: threshold,
    no_future_data_used_for_features: true,
    baseline_reference_is_intrabar_low_not_guaranteed_executable_price: true
  };
  if (!Array.isArray(rows) || rows.length < 300) {
    return {...base, status:'INSUFFICIENT_CLOSED_CANDLES', reason:'NEED_AT_LEAST_300_CLOSED_5M_CANDLES'};
  }
  if (!Number.isFinite(asOf) || !Number.isFinite(lookbackHours) ||
      lookbackHours < 6 || lookbackHours > 48 ||
      !Number.isFinite(localWindowHours) || localWindowHours < 1 || localWindowHours > 12 ||
      !Number.isFinite(threshold) || threshold < 1 || threshold > 30) {
    return {...base, status:'INVALID_RUNUP_OPTIONS'};
  }
  const firstSearchTime = asOf - lookbackHours * 60 * 60 * 1000;
  const firstSearchIndex = rows.findIndex(row => row.closeTime >= firstSearchTime);
  if (firstSearchIndex < 0) return {...base, reason:'NO_CANDLE_IN_SEARCH_WINDOW'};
  const windowBars = Math.round(localWindowHours * 60 / 5);
  for (let index = Math.max(windowBars, firstSearchIndex); index < rows.length; index++) {
    const event = rows[index];
    if (event.closeTime > asOf) continue;
    const start = index - windowBars;
    const windowRows = rows.slice(start, index);
    if (windowRows.length !== windowBars) continue;
    let gap = false;
    for (let j = start + 1; j <= index; j++) {
      if (rows[j].closeTime - rows[j - 1].closeTime > 10 * 60 * 1000) {
        gap = true;
        break;
      }
    }
    if (gap) continue;
    let lowIndex = start;
    for (let j = start + 1; j < index; j++) {
      if (rows[j].low < rows[lowIndex].low) lowIndex = j;
    }
    const lowRow = rows[lowIndex];
    if (!(lowRow.low > 0) || event.close < lowRow.low * (1 + threshold / 100)) continue;

    const snapshotLeads = [60, 30, 15, 5];
    const snapshots = snapshotLeads.map(lead => {
      const targetAt = event.closeTime - lead * 60 * 1000;
      const snapshotIndex = indexAtOrBefore(rows, targetAt);
      const row = snapshotIndex >= 0 ? rows[snapshotIndex] : null;
      if (!row || snapshotIndex >= index || targetAt - row.closeTime > 10 * 60 * 1000) {
        return {
          requested_lead_minutes: lead, status:'NO_CLOSED_CANDLE_NEAR_TARGET',
          target_at:new Date(targetAt).toISOString(), observed_at:null, price:null,
          minutes_before_runup:null, price_change_to_runup_pct:null, features:null
        };
      }
      return {
        requested_lead_minutes: lead, status:'CLOSED_CANDLE_SNAPSHOT',
        target_at:new Date(targetAt).toISOString(),
        observed_at:new Date(row.closeTime).toISOString(),
        price:row.close,
        minutes_before_runup:Number(((event.closeTime-row.closeTime)/60000).toFixed(2)),
        price_change_to_runup_pct:pct(row.close,event.close),
        features:featuresAt(rows,snapshotIndex,benchmarkRows)
      };
    });
    const forward = rows.slice(index + 1).filter(row => row.closeTime <= asOf);
    const latest = forward.at(-1) || null;
    const highAfter = forward.length ? Math.max(...forward.map(row=>row.high)) : null;
    const lowAfter = forward.length ? Math.min(...forward.map(row=>row.low)) : null;
    return {
      ...base,
      status:'RUNUP_THRESHOLD_CROSSING_FOUND',
      runup_window_bars:windowBars,
      baseline:{
        observed_at:new Date(lowRow.closeTime).toISOString(),
        candle_close:lowRow.close,
        reference_low:lowRow.low,
        close_to_close_return_to_runup_pct:pct(lowRow.close,event.close),
        reference_low_to_runup_close_pct:pct(lowRow.low,event.close),
        minutes_from_reference_candle_to_runup:Number(((event.closeTime-lowRow.closeTime)/60000).toFixed(2))
      },
      runup:{
        observed_at:new Date(event.closeTime).toISOString(),
        price:event.close,
        reference_low:lowRow.low,
        return_from_reference_low_pct:pct(lowRow.low,event.close),
        return_from_baseline_close_pct:pct(lowRow.close,event.close)
      },
      lead_snapshots_before_runup:snapshots,
      retrospective_outcome:{
        as_of:new Date(asOf).toISOString(),
        latest_observed_at:latest?new Date(latest.closeTime).toISOString():null,
        latest_price:latest?.close??null,
        return_from_runup_to_latest_pct:latest?pct(event.close,latest.close):null,
        max_favorable_pct_since_runup:highAfter!==null?pct(event.close,highAfter):null,
        max_adverse_pct_since_runup:lowAfter!==null?pct(event.close,lowAfter):null,
        forward_candles:forward.length,
        basis:'RETROSPECTIVE_ONLY_NOT_AVAILABLE_AT_RUNUP_TIME'
      }
    };
  }
  return {...base, reason:'NO_4H_ROLLING_LOW_TO_CLOSE_THRESHOLD_CROSSING_FOUND'};
}

/**
 * Retrospectively reconstructs the first sampled close at which the trailing
 * 24-hour return crossed a threshold. Every feature snapshot is computed from
 * candles closed no later than its own timestamp; no future candle is leaked.
 */
export function buildEarlyMoverCaseStudy(symbol, inputCandles, {
  now = Date.now(),
  benchmarkCandles = [],
  thresholdPct = 5,
  windowHours = 24,
  leadMinutes = 60
} = {}) {
  const cleanSymbol = String(symbol || '').trim().toUpperCase();
  const threshold = Number(thresholdPct);
  const window = Number(windowHours);
  const lead = Number(leadMinutes);
  if (!/^[A-Z0-9]{2,20}USDT$/.test(cleanSymbol)) throw new Error('BINANCE_SPOT_USDT_SYMBOL_REQUIRED');
  if (!Number.isFinite(threshold) || threshold < 1 || threshold > 30) throw new Error('INVALID_THRESHOLD_PCT');
  if (!Number.isFinite(window) || window < 6 || window > 48) throw new Error('INVALID_WINDOW_HOURS');
  if (!Number.isFinite(lead) || lead < 15 || lead > 240) throw new Error('INVALID_LEAD_MINUTES');
  const asOf = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const candles = normalizedCandles(inputCandles, asOf);
  const benchmark = normalizedCandles(benchmarkCandles, asOf);
  const summary = {
    symbol: cleanSymbol,
    status: 'INSUFFICIENT_CLOSED_CANDLES',
    as_of: new Date(asOf).toISOString(),
    source: 'BINANCE_SPOT_PUBLIC_REST',
    interval: '5m',
    closed_candles: candles.length,
    requested_threshold_pct: threshold,
    threshold_measure: 'TRAILING_24H_CLOSE_TO_CLOSE_RETURN',
    search_window_hours: window,
    pre_move_lead_minutes: lead,
    no_future_data_used: true,
    orderbook_history_status: 'NOT_AVAILABLE_FROM_KLINES',
    findings: []
  };
  summary.intraday_runup = buildFirstIntradayRunup(candles, benchmark, {
    now: asOf, searchWindowHours: window, runupWindowHours: 4, thresholdPct: threshold
  });
  if (Array.isArray(summary.intraday_runup?.lead_snapshots_before_runup)) {
    summary.intraday_runup.lead_snapshots_before_runup =
      summary.intraday_runup.lead_snapshots_before_runup.map(row=>({
        ...row,
        production_pre_move_replay:row.status==='CLOSED_CANDLE_SNAPSHOT'&&row.observed_at
          ?replayProductionPreMoveCore(cleanSymbol,candles,benchmark,Date.parse(row.observed_at)):null
      }));
  }
  if (candles.length < MIN_HISTORY_BARS) {
    summary.reason = 'NEED_AT_LEAST_300_CLOSED_5M_CANDLES_FOR_A_24H_BASELINE_AND_LEAD_UP';
    return summary;
  }
  const latestIndex = candles.length - 1;
  const latest = featuresAt(candles, latestIndex, benchmark);
  summary.latest = latest;
  const windowStart = asOf - window * 60 * 60 * 1000;
  let crossingIndex = -1;
  let bestReturn = null;
  let firstObservedReturn = null;
  for (let index = 288; index < candles.length; index++) {
    const candle = candles[index];
    const ret = returnAtHorizon(candles, index, 288);
    if (candle.closeTime >= windowStart && ret !== null) {
      if (firstObservedReturn === null) firstObservedReturn = ret;
      if (bestReturn === null || ret > bestReturn) bestReturn = ret;
      const previousRet = index > 288 ? returnAtHorizon(candles, index - 1, 288) : null;
      if (crossingIndex < 0 && ret >= threshold && previousRet !== null && previousRet < threshold) {
        crossingIndex = index;
      }
    }
  }
  summary.best_trailing_24h_return_pct_in_window = bestReturn;
  summary.first_trailing_24h_return_pct_in_window = firstObservedReturn;
  if (crossingIndex < 0) {
    summary.status = latest.return_24h_pct !== null && latest.return_24h_pct >= threshold &&
      firstObservedReturn !== null && firstObservedReturn >= threshold
      ? 'ALREADY_ABOVE_THRESHOLD_AT_WINDOW_START'
      : 'NO_THRESHOLD_CROSSING_IN_WINDOW';
    summary.reason = summary.status === 'ALREADY_ABOVE_THRESHOLD_AT_WINDOW_START'
      ? 'The sampled window began after the threshold had already been crossed.'
      : 'No first crossing of the selected trailing-24h-return threshold was observed in this window.';
    return summary;
  }

  const crossing = candles[crossingIndex];
  const previousCrossing = candles[crossingIndex - 1];
  const baselineIndex = crossingIndex - 288;
  const baseline = candles[baselineIndex];
  const targetLeadTime = crossing.closeTime - lead * 60 * 1000;
  const preMoveIndex = indexAtOrBefore(candles, targetLeadTime);
  const preMove = preMoveIndex >= 0 ? candles[preMoveIndex] : null;
  const crossingFeatures = featuresAt(candles, crossingIndex, benchmark);
  const preFeatures = preMoveIndex >= 0 ? featuresAt(candles, preMoveIndex, benchmark) : null;
  const postMovePct = preMove && preMove.close > 0 ? pct(preMove.close, crossing.close) : null;
  const crossingReturn = returnAtHorizon(candles, crossingIndex, 288);
  const previousReturn = returnAtHorizon(candles, crossingIndex - 1, 288);
  summary.status = 'THRESHOLD_CROSSING_FOUND';
  summary.crossing = {
    observed_at: new Date(crossing.closeTime).toISOString(),
    price: crossing.close,
    previous_closed_candle_at: previousCrossing ? new Date(previousCrossing.closeTime).toISOString() : null,
    previous_trailing_24h_return_pct: previousReturn,
    trailing_24h_return_pct: crossingReturn,
    price_24h_before_crossing: baseline?.close ?? null,
    rise_from_24h_reference_pct: crossingReturn,
    move_from_pre_move_snapshot_pct: postMovePct
  };
  summary.pre_move = preMove && preFeatures ? {
    observed_at: new Date(preMove.closeTime).toISOString(),
    price: preMove.close,
    minutes_before_crossing: Number(((crossing.closeTime - preMove.closeTime) / 60000).toFixed(2)),
    price_change_from_pre_move_to_crossing_pct: postMovePct,
    features: preFeatures,
    early_evidence: preFeatures.early_evidence,
    production_pre_move_replay:replayProductionPreMoveCore(cleanSymbol,candles,benchmark,preMove.closeTime)
  } : {
    observed_at: null,
    price: null,
    minutes_before_crossing: null,
    price_change_from_pre_move_to_crossing_pct: null,
    reason: 'NO_CLOSED_CANDLE_AT_REQUESTED_LEAD_TIME'
  };
  summary.at_crossing = {
    observed_at: new Date(crossing.closeTime).toISOString(),
    features: crossingFeatures,
    early_evidence: crossingFeatures.early_evidence,
    production_pre_move_replay:replayProductionPreMoveCore(cleanSymbol,candles,benchmark,crossing.closeTime)
  };

  // Compare fixed closed-candle snapshots instead of relying on one lead time.
  // These describe historical prices; they do not claim an alert actually fired.
  const snapshotLeads = [60, 30, 15, 5];
  summary.lead_snapshots_before_crossing = snapshotLeads.map(lead => {
    const targetAt = crossing.closeTime - lead * 60 * 1000;
    const index = indexAtOrBefore(candles, targetAt);
    const row = index >= 0 ? candles[index] : null;
    const closeEnough = row && targetAt - row.closeTime <= 10 * 60 * 1000;
    if (!row || index >= crossingIndex || !closeEnough) {
      return {
        requested_lead_minutes: lead,
        status: 'NO_CLOSED_CANDLE_NEAR_TARGET',
        target_at: new Date(targetAt).toISOString(),
        observed_at: null,
        price: null,
        minutes_before_crossing: null,
        price_change_to_crossing_pct: null,
        features: null
      };
    }
    const features = featuresAt(candles, index, benchmark);
    return {
      requested_lead_minutes: lead,
      status: 'CLOSED_CANDLE_SNAPSHOT',
      target_at: new Date(targetAt).toISOString(),
      observed_at: new Date(row.closeTime).toISOString(),
      price: row.close,
      minutes_before_crossing: Number(((crossing.closeTime - row.closeTime) / 60000).toFixed(2)),
      price_change_to_crossing_pct: pct(row.close, crossing.close),
      features,
      production_pre_move_replay:replayProductionPreMoveCore(cleanSymbol,candles,benchmark,row.closeTime)
    };
  });

  // Forward candles score outcomes only after the historical crossing. They are
  // separate from pre-crossing features and never used to calculate those features.
  const outcomeHorizons = [
    { key: '5m', ms: 5 * 60 * 1000 },
    { key: '15m', ms: 15 * 60 * 1000 },
    { key: '30m', ms: 30 * 60 * 1000 },
    { key: '60m', ms: 60 * 60 * 1000 },
    { key: '4h', ms: 4 * 60 * 60 * 1000 },
    { key: '24h', ms: DAY_MS }
  ];
  summary.post_crossing_outcomes = Object.fromEntries(outcomeHorizons.map(horizon => {
    const targetAt = crossing.closeTime + horizon.ms;
    if (targetAt > asOf || targetAt > candles.at(-1).closeTime) {
      return [horizon.key, {
        status: 'PENDING_HORIZON',
        target_at: new Date(targetAt).toISOString(),
        observed_at: null,
        close_price: null,
        close_return_pct: null,
        max_favorable_pct: null,
        max_adverse_pct: null
      }];
    }
    const index = indexAtOrBefore(candles, targetAt);
    const endpoint = index >= 0 ? candles[index] : null;
    if (!endpoint || index <= crossingIndex ||
        targetAt - endpoint.closeTime > INTERVAL_MS * 1.5) {
      return [horizon.key, {
        status: 'INCOMPLETE_CLOSED_CANDLE_DATA',
        target_at: new Date(targetAt).toISOString(),
        observed_at: endpoint ? new Date(endpoint.closeTime).toISOString() : null,
        close_price: null,
        close_return_pct: null,
        max_favorable_pct: null,
        max_adverse_pct: null
      }];
    }
    let gap = false;
    for (let i = crossingIndex + 1; i <= index; i++) {
      if (candles[i].closeTime - candles[i - 1].closeTime > 10 * 60 * 1000) {
        gap = true;
        break;
      }
    }
    if (gap) {
      return [horizon.key, {
        status: 'INCOMPLETE_CLOSED_CANDLE_DATA',
        target_at: new Date(targetAt).toISOString(),
        observed_at: new Date(endpoint.closeTime).toISOString(),
        close_price: null,
        close_return_pct: null,
        max_favorable_pct: null,
        max_adverse_pct: null
      }];
    }
    const forward = candles.slice(crossingIndex + 1, index + 1);
    const highest = Math.max(...forward.map(row => row.high));
    const lowest = Math.min(...forward.map(row => row.low));
    return [horizon.key, {
      status: 'COMPLETE',
      target_at: new Date(targetAt).toISOString(),
      observed_at: new Date(endpoint.closeTime).toISOString(),
      close_price: endpoint.close,
      close_return_pct: pct(crossing.close, endpoint.close),
      max_favorable_pct: pct(crossing.close, highest),
      max_adverse_pct: pct(crossing.close, lowest)
    }];
  }));
  summary.findings = [
    'Feature values are descriptive measurements from closed five-minute spot candles, not validated predictions.',
    'The observed threshold time is the first sampled five-minute close crossing the trailing-24h return threshold.',
    'Historical order-book spread and depth are unknown because Binance klines do not contain historical order-book snapshots.',
    'A historical signal could not be notified unless the same data and candidate were actually available to RadarX at that time.'
  ];
  return summary;
}
