import {decorateRadarAlert} from './radar-alert-meta.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number(x)));
const finite = x => Number.isFinite(Number(x)) ? Number(x) : null;
const avg = a => {
  const xs = a.map(Number).filter(Number.isFinite);
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
};
const pct = (a, b) => Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? (a - b) / b * 100 : null;

function ema(values, period) {
  const xs = values.map(Number).filter(Number.isFinite);
  if (!xs.length) return null;
  const p = Math.max(2, Math.min(Math.trunc(period), xs.length));
  let out = avg(xs.slice(0, p));
  const alpha = 2 / (p + 1);
  for (const x of xs.slice(p)) out = alpha * x + (1 - alpha) * out;
  return out;
}

function std(values) {
  const xs = values.map(Number).filter(Number.isFinite);
  if (xs.length < 2) return null;
  const m = avg(xs);
  return Math.sqrt(avg(xs.map(x => (x - m) ** 2)));
}

function closedCandles(rows, now) {
  return (Array.isArray(rows) ? rows : []).filter(c =>
    c && c.closed !== false &&
    Number.isFinite(Number(c.closeTime)) &&
    Number(c.closeTime) <= now &&
    Number(c.openTime) < Number(c.closeTime) &&
    Number.isFinite(Number(c.open)) &&
    Number.isFinite(Number(c.high)) &&
    Number.isFinite(Number(c.low)) &&
    Number.isFinite(Number(c.close)) &&
    Number(c.volume) >= 0
  );
}

export function findPreMoveCheckpoint(closed,dayStart,thresholdPct=2){
  const day=closed.filter(x=>Number(x.openTime)>=Number(dayStart));
  if(day.length<3)return null;
  const base=Number(day[0]?.open);
  if(!(base>0))return null;
  for(let i=1;i<day.length;i++){
    const ret=(Number(day[i].close)-base)/base*100;
    if(Number.isFinite(ret)&&ret>=thresholdPct){
      return {index:i,returnPct:ret,price:Number(day[i].close),time:Number(day[i].closeTime)||null};
    }
  }
  return null;
}

export function featureSet(candles, ticker, btcChange = null) {
  const c = closedCandles(candles, Date.now());
  if (c.length < 16) return null;

  const closes = c.map(x => Number(x.close));
  const volumes = c.map(x => Number(x.volume));
  const trades = c.map(x => Number(x.tradeCount));
  const last = c.at(-1);
  const prev = c.at(-2);
  const current = Number(ticker.referencePrice ?? ticker.lastPrice);

  const baseVolume = avg(volumes.slice(-12, -4));
  const recentVolume = avg(volumes.slice(-4));
  const volumeAcceleration = Number.isFinite(baseVolume) && baseVolume > 0 && Number.isFinite(recentVolume)
    ? recentVolume / baseVolume : null;

  const baseTrades = avg(trades.slice(-12, -4));
  const recentTrades = avg(trades.slice(-4));
  const tradeAcceleration = Number.isFinite(baseTrades) && baseTrades > 0 && Number.isFinite(recentTrades)
    ? recentTrades / baseTrades : null;

  const takerRecent = c.slice(-4).reduce((s, x) => s + (Number(x.takerBuyBaseVolume) || 0), 0);
  const volRecent = c.slice(-4).reduce((s, x) => s + (Number(x.volume) || 0), 0);
  const takerRatio = volRecent > 0 ? takerRecent / volRecent : null;

  const range20 = c.slice(-20);
  const widths = range20.map(x => {
    const h = Number(x.high), l = Number(x.low), cl = Number(x.close);
    return cl > 0 ? (h - l) / cl * 100 : null;
  }).filter(Number.isFinite);
  const recentWidth = avg(widths.slice(-4));
  const baseWidth = avg(widths.slice(-16, -4));
  const compressionRatio = Number.isFinite(recentWidth) && Number.isFinite(baseWidth) && baseWidth > 0
    ? recentWidth / baseWidth : null;

  const ema9 = ema(closes.slice(-60), 9);
  const ema20 = ema(closes.slice(-80), 20);
  const ema50 = ema(closes.slice(-100), 50);
  const emaSlope = Number.isFinite(ema20) && Number.isFinite(ema20) && ema20 > 0 && closes.length >= 8
    ? pct(ema20, ema(closes.slice(-88, -8), 20)) : null;

  const lows = c.slice(-10).map(x => Number(x.low));
  let higherLowCount = 0;
  for (let i = 1; i < lows.length; i++) if (lows[i] > lows[i - 1]) higherLowCount += 1;

  const highs20 = c.slice(-20).map(x => Number(x.high)).filter(Number.isFinite);
  const lows20 = c.slice(-20).map(x => Number(x.low)).filter(Number.isFinite);
  const localHigh = highs20.length ? Math.max(...highs20) : null;
  const localLow = lows20.length ? Math.min(...lows20) : null;
  const rangePosition = Number.isFinite(current) && Number.isFinite(localHigh) && Number.isFinite(localLow) && localHigh > localLow
    ? (current - localLow) / (localHigh - localLow) * 100 : null;

  const roc1h = c.length >= 2 ? pct(Number(last.close), Number(prev.close)) : null;
  const roc4h = c.length >= 5 ? pct(Number(last.close), Number(c.at(-5).close)) : null;
  const roc12h = c.length >= 13 ? pct(Number(last.close), Number(c.at(-13).close)) : null;

  const closes20 = closes.slice(-20);
  const mid = avg(closes20);
  const sd20 = std(closes20);
  const bbWidth = Number.isFinite(mid) && mid > 0 && Number.isFinite(sd20) ? 4 * sd20 / mid * 100 : null;

  const breakoutRoom = Number.isFinite(localHigh) && localHigh > 0 && Number.isFinite(current)
    ? (localHigh - current) / current * 100 : null;

  return {
    volumeAcceleration, tradeAcceleration, takerRatio, compressionRatio,
    ema9, ema20, ema50, emaSlope, higherLowCount,
    rangePosition, roc1h, roc4h, roc12h, bbWidth, breakoutRoom,
    btcChange
  };
}

function earlyTimingFingerprint(candles) {
  const c=closedCandles(candles,Date.now());
  if(c.length<24)return null;
  const closes=c.map(x=>Number(x.close)).filter(Number.isFinite);
  const vols=c.map(x=>Number(x.volume)).filter(Number.isFinite);
  const trades=c.map(x=>Number(x.tradeCount)).filter(Number.isFinite);
  const recentVol=avg(vols.slice(-3)),baseVol=avg(vols.slice(-15,-3));
  const recentTrades=avg(trades.slice(-3)),baseTrades=avg(trades.slice(-15,-3));
  const recentBase=c.slice(-3).reduce((s,x)=>s+(Number(x.takerBuyBaseVolume)||0),0);
  const recentQuote=c.slice(-3).reduce((s,x)=>s+(Number(x.volume)||0),0);
  const takerRatio=recentQuote>0?recentBase/recentQuote:null;
  const widths=c.slice(-15).map(x=>{
    const cl=Number(x.close),h=Number(x.high),l=Number(x.low);
    return cl>0?(h-l)/cl*100:null;
  }).filter(Number.isFinite);
  const compressionRatio=widths.length>=15?avg(widths.slice(-3))/(avg(widths.slice(0,12))||1):null;
  const ema9=ema(closes.slice(-40),9),ema20=ema(closes.slice(-50),20);
  const priorEma9=ema(closes.slice(-13,-3),9);
  const emaSlope=Number.isFinite(ema9)&&Number.isFinite(priorEma9)&&priorEma9>0?pct(ema9,priorEma9):null;
  const lows=c.slice(-6).map(x=>Number(x.low)).filter(Number.isFinite);
  let higherLows=0;
  for(let i=1;i<lows.length;i++)if(lows[i]>lows[i-1])higherLows++;
  const last=c.at(-1);
  const lastClose=Number(last.close);
  const lastRange=Math.max(0,Number(last.high)-Number(last.low));
  const closeLocation=lastRange>0?(lastClose-Number(last.low))/lastRange:0.5;
  const momentum3=c.length>=4?pct(lastClose,Number(c.at(-4).close)):null;
  const localHigh=Math.max(...c.slice(-24).map(x=>Number(x.high)).filter(Number.isFinite));
  const breakoutRoom=Number.isFinite(localHigh)&&lastClose>0?(localHigh-lastClose)/lastClose*100:null;
  const volumeScore=Number.isFinite(recentVol)&&Number.isFinite(baseVol)&&baseVol>0?clamp((recentVol/baseVol-0.9)*160):35;
  const tradeScore=Number.isFinite(recentTrades)&&Number.isFinite(baseTrades)&&baseTrades>0?clamp((recentTrades/baseTrades-0.9)*150):35;
  const takerScore=Number.isFinite(takerRatio)?clamp(50+(takerRatio-0.5)*600):40;
  const squeezeScore=Number.isFinite(compressionRatio)?clamp(100-compressionRatio*110):40;
  const structureScore=clamp(higherLows*18);
  const emaScore=Number.isFinite(ema9)&&Number.isFinite(ema20)&&Number.isFinite(emaSlope)
    ?clamp((ema9>=ema20?62:42)+(emaSlope>0?Math.min(28,emaSlope*10):0)):40;
  const locationScore=clamp(closeLocation*100);
  const roomScore=Number.isFinite(breakoutRoom)?clamp(100-Math.abs(breakoutRoom-1.8)*24):40;
  let earlySetupScore=volumeScore*.18+tradeScore*.12+takerScore*.18+squeezeScore*.14+structureScore*.12+emaScore*.12+locationScore*.05+roomScore*.09;
  if(Number.isFinite(momentum3)&&momentum3>1.8)earlySetupScore-=Math.min(18,(momentum3-1.8)*10);
  if(Number.isFinite(takerRatio)&&takerRatio<0.49)earlySetupScore-=12;
  if(Number.isFinite(breakoutRoom)&&breakoutRoom<0.35)earlySetupScore-=10;
  return {
    volumeAcceleration:Number.isFinite(recentVol)&&Number.isFinite(baseVol)&&baseVol>0?recentVol/baseVol:null,
    tradeAcceleration:Number.isFinite(recentTrades)&&Number.isFinite(baseTrades)&&baseTrades>0?recentTrades/baseTrades:null,
    takerRatio,compressionRatio,higherLowCount:higherLows,emaSlope,
    momentum3,breakoutRoom,closeLocation,earlySetupScore:clamp(earlySetupScore)
  };
}

function normalizeLeaderFeatures(leaderRows) {
  const fields = ['volumeAcceleration','tradeAcceleration','takerRatio','compressionRatio','emaSlope','higherLowCount','rangePosition','roc1h','roc4h','roc12h','bbWidth','breakoutRoom','btcChange'];
  const profile = {};
  for (const key of fields) profile[key] = avg(leaderRows.map(x => x.features?.[key]).filter(Number.isFinite));
  return profile;
}

function similarity(features, profile) {
  const specs = [
    ['volumeAcceleration', 0.22, 0.8],
    ['tradeAcceleration', 0.14, 0.7],
    ['takerRatio', 0.12, 0.08],
    ['compressionRatio', 0.12, 0.35],
    ['emaSlope', 0.08, 2.0],
    ['higherLowCount', 0.10, 4],
    ['rangePosition', 0.08, 25],
    ['roc4h', 0.06, 4],
    ['bbWidth', 0.05, 2.5],
    ['breakoutRoom', 0.03, 2.5]
  ];
  let total = 0, weight = 0;
  for (const [key, w, scale] of specs) {
    const a = finite(features[key]), b = finite(profile[key]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    total += w * clamp(100 - Math.abs(a - b) / scale * 100);
    weight += w;
  }
  return weight > 0 ? total / weight : null;
}

function patternLesson(leaderRows) {
  const profile = normalizeLeaderFeatures(leaderRows);
  const factors = [
    ['volumeAcceleration', profile.volumeAcceleration, 'تسارع الحجم'],
    ['tradeAcceleration', profile.tradeAcceleration, 'تسارع عدد الصفقات'],
    ['takerRatio', profile.takerRatio, 'تفوق شراء Taker'],
    ['compressionRatio', profile.compressionRatio, 'انكماش النطاق قبل التمدد'],
    ['emaSlope', profile.emaSlope, 'ميل المتوسط 20'],
    ['higherLowCount', profile.higherLowCount, 'قيعان أعلى متتالية'],
    ['breakoutRoom', profile.breakoutRoom, 'مسافة معقولة عن المقاومة']
  ];
  return {
    samples: leaderRows.length,
    profile,
    top_factors: factors
      .filter(x => Number.isFinite(Number(x[1])))
      .sort((a, b) => {
        const score = key => ({
          volumeAcceleration: 1.0,
          tradeAcceleration: .9,
          takerRatio: .85,
          compressionRatio: .8,
          emaSlope: .75,
          higherLowCount: .7,
          breakoutRoom: .65
        })[key] || .5;
        return score(b[0]) - score(a[0]);
      })
      .slice(0, 6)
      .map(([key, value, label]) => ({key, label, value}))
  };
}

function scoreHunter({ticker, features, micro, lesson, todayPct, dayHigh, dayLow, btcTodayPct}) {
  const maxMove = Number(lesson.max_accepted_24h_move_pct ?? 8);
  const move = finite(todayPct);
  const oneHour = finite(features?.roc1h);
  const fiveHour = finite(features?.roc4h);
  const volume = finite(features?.volumeAcceleration);
  const trades = finite(features?.tradeAcceleration);
  const taker = finite(features?.takerRatio);
  const compression = finite(features?.compressionRatio);
  const hls = finite(features?.higherLowCount);
  const rangePos = finite(features?.rangePosition);
  const room = finite(features?.breakoutRoom);
  const similarityScore = finite(similarity(features, lesson.profile));
  const rel = Number.isFinite(move) && Number.isFinite(btcTodayPct) ? move - btcTodayPct : null;

  const quiet = Number.isFinite(move)
    ? clamp(100 - Math.max(0, move - 2) * 12 - Math.max(0, -move - 3) * 7)
    : 40;
  const extensionPenalty = Math.max(0, Number.isFinite(move) ? move - maxMove : 0) * 10;
  const moveRoom = Number.isFinite(room) ? clamp(100 - Math.abs(room - 1.8) * 28) : 45;
  const volScore = Number.isFinite(volume) ? clamp((volume - 0.8) * 120) : 35;
  const tradeScore = Number.isFinite(trades) ? clamp((trades - 0.85) * 115) : 35;
  const takerScore = Number.isFinite(taker) ? clamp(50 + (taker - 0.5) * 500) : 40;
  const squeezeScore = Number.isFinite(compression) ? clamp(100 - compression * 125) : 40;
  const hlScore = Number.isFinite(hls) ? clamp(hls * 13) : 25;
  const emaScore =
    Number.isFinite(ticker.lastPrice) && Number.isFinite(features?.ema20) && Number.isFinite(features?.ema50)
      ? clamp(features.ema20 >= features.ema50
        ? (Number(ticker.lastPrice) >= features.ema20 ? 92 : 68)
        : (Number(ticker.lastPrice) >= features.ema20 ? 52 : 28))
      : 35;
  const relativeScore = Number.isFinite(rel) ? clamp(50 + rel * 8) : 45;
  const timeScore = Number.isFinite(oneHour) && Number.isFinite(fiveHour)
    ? clamp(72 + oneHour * 6 + fiveHour * 2) : 45;

  const microScore=finite(micro?.earlySetupScore) ?? 35;
  let score =
    quiet * 0.08 +
    volScore * 0.11 +
    tradeScore * 0.07 +
    takerScore * 0.09 +
    squeezeScore * 0.10 +
    hlScore * 0.08 +
    emaScore * 0.08 +
    relativeScore * 0.07 +
    moveRoom * 0.09 +
    timeScore * 0.04 +
    (similarityScore ?? 45) * 0.07 +
    microScore * 0.12;

  score -= extensionPenalty;
  if (Number.isFinite(oneHour) && oneHour > 2.5) score -= 12;
  if (Number.isFinite(fiveHour) && fiveHour > 5) score -= 10;
  if (Number.isFinite(taker) && taker < 0.485) score -= 10;
  score = clamp(score);

  const microReady=Number.isFinite(microScore)&&microScore>=74;
  const microVolume=Number.isFinite(micro?.volumeAcceleration)&&Number(micro.volumeAcceleration)>=1.05;
  const microTaker=Number.isFinite(micro?.takerRatio)&&Number(micro.takerRatio)>=0.505;
  const microRoom=Number.isFinite(micro?.breakoutRoom)&&Number(micro.breakoutRoom)>=0.35&&Number(micro.breakoutRoom)<=4.5;
  const earlyMove=Number.isFinite(move)&&move<=4.5&&Number(move)>=-2.5;
  const recentNotChasing=(!Number.isFinite(oneHour)||oneHour<=1.8)&&(!Number.isFinite(fiveHour)||fiveHour<=3.5);
  let decision = 'راقب';
  if (score >= 86 && earlyMove && recentNotChasing && microReady && microVolume && microTaker && microRoom && taker >= 0.50 && (similarityScore ?? 0) >= 70) {
    decision = 'قنص';
  } else if (score >= 78 && earlyMove && microScore >= 62 && (!Number.isFinite(micro?.momentum3)||micro.momentum3<=2.5)) {
    decision = 'ترقّب';
  } else {
    decision = 'مرفوض';
  }

  const reasons = [];
  if (similarityScore >= 70) reasons.push('بصمة قريبة من المتحركين الأقوياء اليوم');
  if (volume >= 1.2) reasons.push('الحجم يتسارع');
  if (trades >= 1.15) reasons.push('عدد الصفقات يتسارع');
  if (taker >= 0.515) reasons.push('ضغط شراء Taker واضح');
  if (compression <= 0.85) reasons.push('انكماش قبل التمدد');
  if (hls >= 4) reasons.push('سلسلة Higher-Lows');
  if (emaScore >= 80) reasons.push('السعر فوق/مع EMA20 وEMA50');
  if (Number.isFinite(rel) && rel >= 1) reasons.push('قوة نسبية أفضل من BTC');
  if (microScore >= 74) reasons.push('بصمة مبكرة على 15m متوافقة');
  if (Number(micro?.volumeAcceleration) >= 1.1) reasons.push('تسارع حجم 15m');
  if (Number(micro?.takerRatio) >= 0.51) reasons.push('ضغط شراء 15m داعم');
  if (Number(micro?.higherLowCount) >= 3) reasons.push('Higher-Lows على 15m');
  if (Number(micro?.compressionRatio) <= 0.9) reasons.push('انكماش 15m قبل التوسع');
  if (moveRoom <= 2.5 && moveRoom >= 0) reasons.push('السعر قريب من المقاومة بدون تمدد كبير');

  const riskFlags = [];
  if (!microReady) riskFlags.push('EARLY_FINGERPRINT_WEAK');
  if (Number.isFinite(micro?.volumeAcceleration) && micro.volumeAcceleration < 1.05) riskFlags.push('MICRO_VOLUME_WEAK');
  if (Number.isFinite(micro?.takerRatio) && micro.takerRatio < 0.505) riskFlags.push('MICRO_SELLER_PRESSURE');
  if (Number.isFinite(micro?.momentum3) && micro.momentum3 > 2.5) riskFlags.push('MICRO_CHASE_RISK');
  if (Number.isFinite(micro?.breakoutRoom) && micro.breakoutRoom < 0.35) riskFlags.push('RESISTANCE_TOO_CLOSE');
  if (move > maxMove) riskFlags.push('EXTENDED_24H');
  if (oneHour > 2.5) riskFlags.push('EXTENDED_1H');
  if (fiveHour > 5) riskFlags.push('EXTENDED_4H');
  if (taker < 0.49) riskFlags.push('SELLER_PRESSURE');
  if (move < -4) riskFlags.push('FALLING_KNIFE');

  return {
    score: Number(score.toFixed(1)),
    decision,
    similarity: Number((similarityScore ?? 0).toFixed(1)),
    metrics: {
      today_pct: move,
      one_hour_pct: oneHour,
      four_hour_pct: fiveHour,
      volume_acceleration: volume,
      trade_acceleration: trades,
      taker_buy_ratio: taker,
      compression_ratio: compression,
      higher_low_count: hls,
      range_position_pct: rangePos,
      resistance_distance_pct: room,
      relative_vs_btc_pct: rel,
      ema20: features?.ema20 ?? null,
      ema50: features?.ema50 ?? null,
      day_high: dayHigh,
      day_low: dayLow,
      early_setup_score: microScore,
      micro_volume_acceleration: micro?.volumeAcceleration ?? null,
      micro_trade_acceleration: micro?.tradeAcceleration ?? null,
      micro_taker_buy_ratio: micro?.takerRatio ?? null,
      micro_compression_ratio: micro?.compressionRatio ?? null,
      micro_higher_low_count: micro?.higherLowCount ?? null,
      micro_momentum3: micro?.momentum3 ?? null,
      micro_resistance_distance_pct: micro?.breakoutRoom ?? null
    },
    reasons,
    risk_flags: riskFlags
  };
}

export const COIN_HUNTER_DEFAULTS = Object.freeze({
  quote: 'USDT',
  pollMs: 60000,
  universeRefreshMs: 10 * 60 * 1000,
  minQuoteVolume24h: 750000,
  leaderCount: 12,
  candidatePool: 48,
  deepCount: 20,
  deepConcurrency: 4,
  minLeaderMovePct: 6,
  maxCandidateMovePct: 4.5,
  minCandidateMovePct: -2.5,
  alertCooldownMs: 8 * 60 * 1000,
  minHunterScore: 86,
  maxHunter24hMovePct: 8
});

export class CoinHunterRadar {
  constructor({rest, store, config = {}, logger = console} = {}) {
    this.rest = rest;
    this.store = store;
    this.config = {...COIN_HUNTER_DEFAULTS, ...config};
    this.logger = logger;
    this.running = false;
    this.busy = false;
    this.timer = null;
    this.universe = [];
    this.universeAt = 0;
    this.lastScanAtMs = null;
    this.lastError = null;
    this.scans = 0;
    this.alertCount = 0;
    this.lastCoverage = {};
    this.latestCandidates = [];
    this.lesson = {samples: 0, profile: {}, top_factors: [], learned_at: null};
    this.dayStartMs = null;
    this.lastAlertsBySymbol = new Map();
  }

  normalizeQuote(raw) {
    const q = String(raw || this.config.quote).trim().toUpperCase();
    if (!/^[A-Z]{2,10}$/.test(q)) throw new Error('INVALID_QUOTE');
    return q;
  }

  dayStartInAden() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Aden', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const get = type => Number(parts.find(x => x.type === type)?.value);
    return Date.UTC(get('year'), get('month') - 1, get('day')) - 3 * 60 * 60 * 1000;
  }

  isSpotSymbol(x, quote) {
    return String(x?.status || '').toUpperCase() === 'TRADING' &&
      String(x?.quoteAsset || '').toUpperCase() === quote &&
      x?.isSpotTradingAllowed !== false &&
      String(x?.baseAsset || '').toUpperCase() !== quote;
  }

  async refreshUniverse(quote) {
    const now = Date.now();
    if (!this.universe.length || now - this.universeAt >= Number(this.config.universeRefreshMs)) {
      const info = await this.rest.request('/api/v3/exchangeInfo');
      const symbols = new Set(
        (info.data?.symbols || [])
          .filter(x => this.isSpotSymbol(x, quote))
          .map(x => String(x.symbol).toUpperCase())
      );
      this.universe = [...symbols].map(symbol => ({symbol}));
      this.universeAt = now;
    }
    const ticker = await this.rest.request('/api/v3/ticker/24hr');
    const allowed = new Set(this.universe.map(x => x.symbol));
    const tickers = (Array.isArray(ticker.data) ? ticker.data : [])
      .map(x => ({
        symbol: String(x.symbol || '').toUpperCase(),
        lastPrice: finite(x.lastPrice),
        priceChangePercent: finite(x.priceChangePercent),
        quoteVolume: finite(x.quoteVolume),
        count: finite(x.count),
        highPrice: finite(x.highPrice),
        lowPrice: finite(x.lowPrice)
      }))
      .filter(x => allowed.has(x.symbol) && Number.isFinite(x.lastPrice) && Number.isFinite(x.priceChangePercent))
      .filter(x => Number(x.quoteVolume) >= Number(this.config.minQuoteVolume24h));
    this.universe = tickers;
    return tickers;
  }

  async scan(quote = this.config.quote) {
    if (this.busy) return false;
    this.busy = true;
    const started = Date.now();
    try {
      const q = this.normalizeQuote(quote);
      const tickers = await this.refreshUniverse(q);
      if (!tickers.length) throw new Error('HUNTER_EMPTY_UNIVERSE');

      const dayStart = this.dayStartInAden();
      this.dayStartMs = dayStart;
      const btcTicker = q === 'USDT' ? (tickers.find(x => x.symbol === 'BTCUSDT') || null) : null;
      const positive = tickers
        .filter(x => Number(x.priceChangePercent) > 0)
        .sort((a,b) => Number(b.priceChangePercent) - Number(a.priceChangePercent));
      const leaderCandidates = positive
        .filter((x,i) => i < Math.max(Number(this.config.leaderCount) * 3, 24))
        .slice(0, Math.max(Number(this.config.leaderCount) * 3, 24));

      const leaderRows = [];
      for (const t of leaderCandidates) {
        try {
          const k = await this.rest.klines(t.symbol, '1h', {limit: 72});
          const closed = closedCandles(k.candles, Date.now());
          const day = closed.filter(x=>Number(x.openTime)>=Number(dayStart));
          const dayPct = day.length >= 1 ? pct(Number(day.at(-1).close), Number(day[0].open)) : null;
          const checkpoint = findPreMoveCheckpoint(closed, dayStart, 2);
          const sourceIndex = checkpoint ? closed.findIndex(x=>Number(x.closeTime)===checkpoint.time) : -1;
          const source = checkpoint ? closed.slice(0, Math.max(0,sourceIndex)) : [];
          const refPrice = checkpoint ? checkpoint.price : null;
          const features = source.length>=16 && Number.isFinite(refPrice)
            ? featureSet(source, {...t,referencePrice:refPrice}, null)
            : null;
          if (features) leaderRows.push({symbol:t.symbol,todayPct:dayPct ?? Number(t.priceChangePercent),features,checkpoint});
        } catch (error) {
          this.logger.warn?.('COIN_HUNTER_LEADER '+t.symbol+': '+String(error?.message ?? error));
        }
      }
      const qualifyingLeaders=leaderRows.filter(x=>Number(x.todayPct)>=Number(this.config.minLeaderMovePct));
      const trainingLeaders=qualifyingLeaders.length>=3?qualifyingLeaders:leaderRows;
      this.lesson = {...patternLesson(trainingLeaders), qualifying_leaders:qualifyingLeaders.length, training_samples:trainingLeaders.length, learned_at:new Date(started).toISOString(), max_accepted_24h_move_pct:Number(this.config.maxHunter24hMovePct)};

      const btcToday = btcTicker ? Number(btcTicker.priceChangePercent) : null;
      const eligiblePool=tickers
        .filter(x => Number(x.priceChangePercent) >= Number(this.config.minCandidateMovePct))
        .filter(x => Number(x.priceChangePercent) <= Number(this.config.maxCandidateMovePct))
        .filter(x => x.symbol !== 'BTCUSDT' && x.symbol !== 'ETHUSDT');
      const rankQuiet=(a,b)=>Number(b.quoteVolume)-Number(a.quoteVolume)||Number(b.count)-Number(a.count);
      const quiet=eligiblePool.filter(x=>Number(x.priceChangePercent)>=-1&&Number(x.priceChangePercent)<2).sort(rankQuiet);
      const waking=eligiblePool.filter(x=>Number(x.priceChangePercent)>=2&&Number(x.priceChangePercent)<5).sort(rankQuiet);
      const recovery=eligiblePool.filter(x=>Number(x.priceChangePercent)>=-3&&Number(x.priceChangePercent)<-1).sort(rankQuiet);
      const wanted=Math.max(1,Number(this.config.candidatePool));
      const pool=[];
      const appendTier=(rows,count)=>{
        for(const row of rows){if(pool.length>=wanted||count<=0)break;if(!pool.some(x=>x.symbol===row.symbol)){pool.push(row);count--;}}
      };
      appendTier(quiet,Math.ceil(wanted*0.55));
      appendTier(waking,Math.ceil(wanted*0.30));
      appendTier(recovery,Math.ceil(wanted*0.10));
      appendTier(eligiblePool.filter(x=>!pool.some(y=>y.symbol===x.symbol)).sort(rankQuiet),wanted-pool.length);

      const ranked = [];
      let scanned = 0;
      const concurrency = Math.max(1, Math.min(8, Number(this.config.deepConcurrency)));
      for (let i = 0; i < pool.length; i += concurrency) {
        const batch = pool.slice(i, i + concurrency);
        const rows = await Promise.all(batch.map(async t => {
          try {
            const [k1h,k15m] = await Promise.all([
              this.rest.klines(t.symbol, '1h', {limit: 72}),
              this.rest.klines(t.symbol, '15m', {limit: 96})
            ]);
            const closed = closedCandles(k1h.candles, Date.now());
            const micro = earlyTimingFingerprint(k15m.candles);
            const features = featureSet(closed, t, btcToday);
            if (!features || !micro) return null;
            scanned += 1;
            const day = closed.filter(x=>Number(x.openTime)>=Number(dayStart));
            const dayPct = day.length >= 1 ? pct(Number(day.at(-1).close), Number(day[0].open)) : Number(t.priceChangePercent);
            const score = scoreHunter({
              ticker:t, features, micro, lesson:this.lesson,
              todayPct:dayPct,
              dayHigh:t.highPrice, dayLow:t.lowPrice, btcTodayPct:btcToday
            });
            return decorateRadarAlert({
              symbol:t.symbol,
              score:score.score,
              decision:score.decision,
              similarity:score.similarity,
              today_pct:dayPct,
              price:Number(t.lastPrice),
              quote_volume_24h:Number(t.quoteVolume),
              trade_count_24h:Number(t.count),
              factors:{...score.metrics,early_timing_fingerprint:micro},
              reasons:score.reasons,
              risk_flags:score.risk_flags,
              detected_at:Date.now(),
              radar:'COIN_HUNTER_RADAR',
              opportunity_score:score.score,
              source:'Binance Public REST',
              paper_trading:true,
              real_order_execution:false,
              confidence_score:'UNKNOWN',
              closed_candles_only:true
            },'🎯 صائد العملات');
          } catch (error) {
            this.logger.debug?.('COIN_HUNTER '+t.symbol+': '+String(error?.message ?? error));
            return null;
          }
        }));
        ranked.push(...rows.filter(Boolean));
        await sleep(20);
      }

      ranked.sort((a,b) => Number(b.score) - Number(a.score) || Number(b.similarity) - Number(a.similarity));
      this.latestCandidates = ranked.slice(0, Number(this.config.deepCount));

      for (const row of this.latestCandidates.filter(x => x.decision === 'قنص' && Number(x.score) >= Number(this.config.minHunterScore))) {
        const last = this.lastAlertsBySymbol.get(row.symbol) || 0;
        if (Date.now() - last >= Number(this.config.alertCooldownMs)) {
          this.lastAlertsBySymbol.set(row.symbol, Date.now());
          this.alertCount += 1;
          try { await this.store?.appendCoinHunterAlert?.(row); } catch {}
        }
      }

      this.lastCoverage = {
        universe_total: tickers.length,
        leader_sampled: leaderRows.length,
        qualifying_leaders: leaderRows.filter(x=>Number(x.todayPct)>=Number(this.config.minLeaderMovePct)).length,
        candidate_pool: pool.length,
        deep_scanned_total: scanned,
        hunter_hits: this.latestCandidates.filter(x => x.decision === 'قنص').length,
        learned_samples: leaderRows.length
      };
      this.scans += 1;
      this.lastScanAtMs = Date.now();
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.logger.warn?.('COIN_HUNTER_SCAN '+this.lastError);
      this.lastScanAtMs = started;
      return false;
    } finally {
      this.busy = false;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.scan();
    this.timer = setInterval(() => this.scan(), Math.max(30000, Number(this.config.pollMs) || 60000));
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(limit = 16, quote = this.config.quote) {
    const q = this.normalizeQuote(quote);
    return {
      radar:'COIN_HUNTER_RADAR',
      radar_name:'🎯 صائد العملات',
      quote:q,
      as_of:this.lastScanAtMs ? new Date(this.lastScanAtMs).toISOString() : null,
      running:this.running,
      busy:this.busy,
      candidates:this.latestCandidates.slice(0, Math.max(1, Math.min(50, Number(limit) || 16))),
      lesson:this.lesson,
      coverage:this.lastCoverage,
      day_start:this.dayStartMs ? new Date(this.dayStartMs).toISOString() : null,
      last_error:this.lastError,
      algorithms:[
        'Today-mover pattern extraction',
        'Adaptive leader fingerprint',
        'Pre-breakout quiet-range filter',
        'Volume acceleration',
        'Trade-count acceleration',
        'Taker-buy pressure',
        'Higher-Low structure',
        'EMA20/EMA50 alignment',
        'Bollinger compression',
        'Resistance room',
        'Relative strength vs BTC',
        'Anti-chase extension gates',
        '15m Early Timing Fingerprint',
        'Micro RVOL/Trade acceleration',
        'Micro Taker pressure and Higher-Lows',
        'Micro compression and resistance-room gates',
        'Liquidity and data-integrity gates'
      ],
      data_policy:{spot_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',closed_candles_only:true,no_synthetic_prices:true}
    };
  }

  health() {
    return {
      running:this.running,
      busy:this.busy,
      radar:'COIN_HUNTER_RADAR',
      radar_name:'🎯 صائد العملات',
      universe_total:this.universe.length,
      last_scan_at:this.lastScanAtMs,
      scans:this.scans,
      alerts_emitted:this.alertCount,
      last_error:this.lastError,
      coverage:this.lastCoverage,
      learned_samples:this.lesson.samples || 0,
      poll_ms:Number(this.config.pollMs),
      candidate_pool:Number(this.config.candidatePool),
      deep_count:Number(this.config.deepCount),
      closed_candles_only:true,
      paper_trading:true,
      real_order_execution:false,
      confidence_score:'UNKNOWN',
      source:'Binance Public REST'
    };
  }
}
