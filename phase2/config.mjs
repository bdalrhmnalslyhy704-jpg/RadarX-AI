import {resolvePort,resolveHost} from './runtime.mjs';

const int = (v, d) => Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d;
const float = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;
const list = (v, d) => {
  const a = String(v ?? '').split(',').map(x => x.trim()).filter(Boolean);
  return a.length ? a : d;
};

export const CONFIG = Object.freeze({
  environment: (process.env.RADARX_ENV ?? 'development').toLowerCase(),
  confidenceMode: String(process.env.RADARX_CONFIDENCE_MODE ?? 'UNKNOWN').toUpperCase(),
  host: resolveHost(process.env),
  port: resolvePort(process.env),
  symbols: list(process.env.RADARX_SYMBOLS, ['BTCUSDT','ETHUSDT']).map(x => x.toUpperCase()),
  timeframes: ['4h','1h','15m'],
  websocket: {
    urls: list(process.env.BINANCE_WS_URLS, [
      'wss://stream.binance.com:9443/stream',
      'wss://stream.binance.com:443/stream'
    ]),
    initialBackoffMs: int(process.env.RADARX_WS_BACKOFF_MS, 1000),
    maxBackoffMs: int(process.env.RADARX_WS_MAX_BACKOFF_MS, 60000),
    jitterRatio: float(process.env.RADARX_WS_JITTER, 0.2),
    heartbeatTimeoutMs: int(process.env.RADARX_WS_HEARTBEAT_TIMEOUT_MS, 90000),
    maxConnectionMs: int(process.env.RADARX_WS_MAX_CONNECTION_MS, 23 * 60 * 60 * 1000)
  },
  rest: {
    urls: list(process.env.BINANCE_REST_URLS, [
      'https://api.binance.com',
      'https://api-gcp.binance.com',
      'https://api1.binance.com',
      'https://api2.binance.com',
      'https://api3.binance.com',
      'https://api4.binance.com',
      'https://data-api.binance.vision'
    ]),
    timeoutMs: int(process.env.RADARX_REST_TIMEOUT_MS, 9000),
    minIntervalMs: int(process.env.RADARX_REST_MIN_INTERVAL_MS, 100),
    maxRequestsPerMinute: int(process.env.RADARX_REST_MAX_REQUESTS_PER_MINUTE, 120)
  },
  monitoring: {
    bootstrapKlines: int(process.env.RADARX_BOOTSTRAP_KLINES, 250),
    repairKlines: int(process.env.RADARX_REPAIR_KLINES, 300),
    periodicRepairMs: int(process.env.RADARX_PERIODIC_REPAIR_MS, 60000),
    pushRetryMs: int(process.env.RADARX_PUSH_RETRY_MS, 15000),
    maxSeriesLength: int(process.env.RADARX_MAX_SERIES_LENGTH, 300),
    maxStaleTriggerMs: int(process.env.RADARX_MAX_STALE_TRIGGER_MS, 30 * 60 * 1000),
    minDataQuality: int(process.env.RADARX_MIN_DATA_QUALITY, 70),
    minLiquidityQuality: int(process.env.RADARX_MIN_LIQUIDITY_QUALITY, 60)
  },
  moveRadar: {
    quote: 'USDT',
    thresholdPct: float(process.env.RADARX_MOVE_THRESHOLD_PCT, 1),
    fastRealertDeltaPct: float(process.env.RADARX_MOVE_FAST_REALERT_DELTA_PCT, 0.8),
    pollMs: int(process.env.RADARX_MOVE_POLL_MS, 5000),
    reconcileMs: int(process.env.RADARX_MOVE_RECONCILE_MS, 15000),
    cooldownMs: int(process.env.RADARX_MOVE_ALERT_COOLDOWN_MS, 30 * 60 * 1000),
    maxDeepPerCycle: int(process.env.RADARX_MOVE_MAX_DEEP, 3),
    minQuoteVolume24h: int(process.env.RADARX_MOVE_MIN_QUOTE_VOLUME_24H, 750000),
    minDataQuality: int(process.env.RADARX_MIN_DATA_QUALITY, 70),
    minLiquidityQuality: int(process.env.RADARX_MIN_LIQUIDITY_QUALITY, 60),
    deepKlines: int(process.env.RADARX_MOVE_DEEP_KLINES, 220),
    deepConcurrency: int(process.env.RADARX_MOVE_DEEP_CONCURRENCY, 4),
    earlyMax24hMovePct: float(process.env.RADARX_MOVE_EARLY_MAX_24H_PCT, 1.25),
    earlyMin24hMovePct: float(process.env.RADARX_MOVE_EARLY_MIN_24H_PCT, -8),
    earlyWakeTriggerPct: float(process.env.RADARX_MOVE_EARLY_WAKE_TRIGGER_PCT, 0.45),
    earlyWakeDeltaPct: float(process.env.RADARX_MOVE_EARLY_WAKE_DELTA_PCT, 0.25),
    earlyWakeMax24hMovePct: float(process.env.RADARX_MOVE_EARLY_WAKE_MAX_24H_PCT, 0.90),
    earlyWakeMin24hMovePct: float(process.env.RADARX_MOVE_EARLY_WAKE_MIN_24H_PCT, -2),
    earlyWakeScanCooldownMs: int(process.env.RADARX_MOVE_EARLY_WAKE_SCAN_COOLDOWN_MS, 90000),
    earlyWakeAlertCooldownMs: int(process.env.RADARX_MOVE_EARLY_WAKE_ALERT_COOLDOWN_MS, 600000),
    earlyWakeMinScore: int(process.env.RADARX_MOVE_EARLY_WAKE_MIN_SCORE, 68),
    earlyWakeMinLeaders: int(process.env.RADARX_MOVE_EARLY_WAKE_MIN_LEADERS, 3),
    fastInterval: process.env.RADARX_MOVE_FAST_INTERVAL ?? '5m',
    fastKlines: int(process.env.RADARX_MOVE_FAST_KLINES, 96),
    earlyScanCooldownMs: int(process.env.RADARX_MOVE_EARLY_SCAN_COOLDOWN_MS, 120000),
    maxEarlyDiscovery: int(process.env.RADARX_MOVE_MAX_EARLY_DISCOVERY, 36),
    earlyMinPreMoveScore: int(process.env.RADARX_MOVE_EARLY_MIN_PREMOVE, 78),
    earlyMinExpansionScore: int(process.env.RADARX_MOVE_EARLY_MIN_EXPANSION, 78),
    earlyMinStrategyScore: int(process.env.RADARX_MOVE_EARLY_MIN_STRATEGY, 72),
    earlyMinAcceptedStrategies: int(process.env.RADARX_MOVE_EARLY_MIN_ACCEPTED, 2),
    earlyMinConfirmations: int(process.env.RADARX_MOVE_EARLY_MIN_CONFIRMATIONS, 6),
    websocket: {
      urls: list(process.env.BINANCE_WS_URLS, [
        'wss://stream.binance.com:9443/stream',
        'wss://stream.binance.com:443/stream'
      ]),
      initialBackoffMs: int(process.env.RADARX_WS_BACKOFF_MS, 1000),
      maxBackoffMs: int(process.env.RADARX_WS_MAX_BACKOFF_MS, 60000),
      jitterRatio: float(process.env.RADARX_WS_JITTER, 0.2),
      heartbeatTimeoutMs: int(process.env.RADARX_WS_HEARTBEAT_TIMEOUT_MS, 90000),
      maxConnectionMs: int(process.env.RADARX_WS_MAX_CONNECTION_MS, 23 * 60 * 60 * 1000)
    }
  },
  strongMoveRadar: {
    quote: 'USDT',
    pollMs: int(process.env.RADARX_STRONG_MOVE_POLL_MS, 15000),
    universeRefreshMs: int(process.env.RADARX_STRONG_MOVE_UNIVERSE_REFRESH_MS, 60000),
    minQuoteVolume24h: int(process.env.RADARX_STRONG_MOVE_MIN_QUOTE_VOLUME_24H, 1000000),
    rotationBatchSize: int(process.env.RADARX_STRONG_MOVE_ROTATION_BATCH, 7),
    topMoverCount: int(process.env.RADARX_STRONG_MOVE_TOP_MOVERS, 6),
    alertCooldownMs: int(process.env.RADARX_STRONG_MOVE_ALERT_COOLDOWN_MS, 5 * 60 * 1000),
    minScore: int(process.env.RADARX_STRONG_MOVE_MIN_SCORE, 76)
  },
  symbolDeepScan: {
    quote: 'USDT',
    klineLimit: int(process.env.RADARX_SYMBOL_DEEP_KLINES, 240)
  },
  rotationRadar: {
    quote: 'USDT',
    pollMs: int(process.env.RADARX_ROTATION_RADAR_POLL_MS, 30000),
    universeRefreshMs: int(process.env.RADARX_ROTATION_RADAR_UNIVERSE_REFRESH_MS, 5 * 60 * 1000),
    minQuoteVolume24h: int(process.env.RADARX_ROTATION_RADAR_MIN_QUOTE_VOLUME_24H, 750000),
    rotationBatchSize: int(process.env.RADARX_ROTATION_RADAR_BATCH, 7),
    topLaggers: int(process.env.RADARX_ROTATION_RADAR_TOP_LAGGERS, 3),
    maxAbs24hMovePct: float(process.env.RADARX_ROTATION_RADAR_MAX_24H_MOVE_PCT, 8),
    alertCooldownMs: int(process.env.RADARX_ROTATION_RADAR_ALERT_COOLDOWN_MS, 10 * 60 * 1000),
    minScore: int(process.env.RADARX_ROTATION_RADAR_MIN_SCORE, 78),
    minConfirmations: int(process.env.RADARX_ROTATION_RADAR_MIN_CONFIRMATIONS, 4)
  },
  radarControl: {
    autostart: String(process.env.RADARX_RADARS_AUTOSTART ?? ((process.env.RADARX_ENV ?? 'development').toLowerCase() === 'production' ? 'true' : 'false')).toLowerCase() === 'true'
  },
  liquidityAbsorptionRadar: {
    quote: 'USDT',
    pollMs: int(process.env.RADARX_LIQUIDITY_ABSORPTION_POLL_MS, 45000),
    universeRefreshMs: int(process.env.RADARX_LIQUIDITY_ABSORPTION_UNIVERSE_REFRESH_MS, 5 * 60 * 1000),
    minQuoteVolume24h: int(process.env.RADARX_LIQUIDITY_ABSORPTION_MIN_QUOTE_VOLUME_24H, 1500000),
    rotationBatchSize: int(process.env.RADARX_LIQUIDITY_ABSORPTION_BATCH, 4),
    topLiquidityCount: int(process.env.RADARX_LIQUIDITY_ABSORPTION_TOP, 3),
    alertCooldownMs: int(process.env.RADARX_LIQUIDITY_ABSORPTION_ALERT_COOLDOWN_MS, 20 * 60 * 1000),
    minScore: int(process.env.RADARX_LIQUIDITY_ABSORPTION_MIN_SCORE, 83),
    minConfirmations: int(process.env.RADARX_LIQUIDITY_ABSORPTION_MIN_CONFIRMATIONS, 6)
  },
  kahirRadar: {
    quote: 'USDT',
    pollMs: int(process.env.RADARX_KAHIR_POLL_MS, 30000),
    universeRefreshMs: int(process.env.RADARX_KAHIR_UNIVERSE_REFRESH_MS, 5 * 60 * 1000),
    minQuoteVolume24h: int(process.env.RADARX_KAHIR_MIN_QUOTE_VOLUME_24H, 500000),
    baselineHistory: int(process.env.RADARX_KAHIR_BASELINE_HISTORY, 8),
    deepCandidates: int(process.env.RADARX_KAHIR_DEEP_CANDIDATES, 14),
    deepConcurrency: int(process.env.RADARX_KAHIR_DEEP_CONCURRENCY, 4),
    deepOneMinuteKlines: int(process.env.RADARX_KAHIR_1M_KLINES, 150),
    deepFiveMinuteKlines: int(process.env.RADARX_KAHIR_5M_KLINES, 100),
    alertCooldownMs: int(process.env.RADARX_KAHIR_ALERT_COOLDOWN_MS, 20 * 60 * 1000),
    minScore: int(process.env.RADARX_KAHIR_MIN_SCORE, 84),
    minOneMinuteZ: float(process.env.RADARX_KAHIR_MIN_1M_Z, 1.8),
    minFiveMinuteZ: float(process.env.RADARX_KAHIR_MIN_5M_Z, 1.6),
    minVolumeRatio: float(process.env.RADARX_KAHIR_MIN_VOLUME_RATIO, 1.35),
    minEfficiency: float(process.env.RADARX_KAHIR_MIN_EFFICIENCY, 0.52),
    minRelativeAccelerationBps: float(process.env.RADARX_KAHIR_MIN_RELATIVE_ACCEL_BPS, 1.5),
    maxAbs24hMovePct: float(process.env.RADARX_KAHIR_MAX_24H_MOVE_PCT, 15)
  },
  doomsdayRadar: {
    quote: 'USDT',
    pollMs: int(process.env.RADARX_DOOMSDAY_POLL_MS, 15000),
    universeRefreshMs: int(process.env.RADARX_DOOMSDAY_UNIVERSE_REFRESH_MS, 5 * 60 * 1000),
    minQuoteVolume24h: int(process.env.RADARX_DOOMSDAY_MIN_QUOTE_VOLUME_24H, 500000),
    deepCandidates: int(process.env.RADARX_DOOMSDAY_DEEP_CANDIDATES, 10),
    deepConcurrency: int(process.env.RADARX_DOOMSDAY_DEEP_CONCURRENCY, 4),
    oneMinuteKlines: int(process.env.RADARX_DOOMSDAY_1M_KLINES, 120),
    fiveMinuteKlines: int(process.env.RADARX_DOOMSDAY_5M_KLINES, 80),
    alertCooldownMs: int(process.env.RADARX_DOOMSDAY_ALERT_COOLDOWN_MS, 8 * 60 * 1000),
    minEarlyScore: int(process.env.RADARX_DOOMSDAY_MIN_EARLY_SCORE, 78),
    minIgnitionScore: int(process.env.RADARX_DOOMSDAY_MIN_IGNITION_SCORE, 82),
    minPowerScore: int(process.env.RADARX_DOOMSDAY_MIN_POWER_SCORE, 90),
    minVolumeRatio: float(process.env.RADARX_DOOMSDAY_MIN_VOLUME_RATIO, 1.35),
    minTradeRatio: float(process.env.RADARX_DOOMSDAY_MIN_TRADE_RATIO, 1.25),
    minTakerRatio: float(process.env.RADARX_DOOMSDAY_MIN_TAKER_RATIO, 0.515),
    max24hMovePct: float(process.env.RADARX_DOOMSDAY_MAX_24H_MOVE_PCT, 18),
    retryAttempts: int(process.env.RADARX_DOOMSDAY_RETRY_ATTEMPTS, 1),
    watchlist: ['FETUSDT','SCRUSDT','CHIPUSDT','ORCAUSDT','TSTUSDT','GTCUSDT']
  },
  professorRadar: {
    quote: 'USDT',
    pollMs: int(process.env.RADARX_PROFESSOR_POLL_MS, 120000),
    universeRefreshMs: int(process.env.RADARX_PROFESSOR_UNIVERSE_REFRESH_MS, 15 * 60 * 1000),
    liveSearchLimit: int(process.env.RADARX_PROFESSOR_LIVE_SEARCH_LIMIT, 8),
    transcriptStreams: int(process.env.RADARX_PROFESSOR_TRANSCRIPT_STREAMS, 2),
    newsLimit: int(process.env.RADARX_PROFESSOR_NEWS_LIMIT, 35),
    deepCandidates: int(process.env.RADARX_PROFESSOR_DEEP_CANDIDATES, 5),
    deepConcurrency: int(process.env.RADARX_PROFESSOR_DEEP_CONCURRENCY, 2),
    alertCooldownMs: int(process.env.RADARX_PROFESSOR_ALERT_COOLDOWN_MS, 30 * 60 * 1000),
    minEntryScore: int(process.env.RADARX_PROFESSOR_MIN_ENTRY_SCORE, 78),
    minWatchScore: int(process.env.RADARX_PROFESSOR_MIN_WATCH_SCORE, 66),
    webTimeoutMs: int(process.env.RADARX_PROFESSOR_WEB_TIMEOUT_MS, 7000),
    transcriptTimeoutMs: int(process.env.RADARX_PROFESSOR_TRANSCRIPT_TIMEOUT_MS, 6000)
  },
  paper: {
    feeRate: float(process.env.RADARX_PAPER_FEE_RATE, 0.001),
    slippageBps: float(process.env.RADARX_PAPER_SLIPPAGE_BPS, 5),
    paperTrading: true,
    realOrderExecution: false
  },
  push: {
    provider: (process.env.RADARX_PUSH_PROVIDER ?? 'none').toLowerCase(),
    vapidSubject: process.env.VAPID_SUBJECT ?? '',
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? ''
  },
  auth: {
    secret: process.env.RADARX_AUTH_SECRET ?? '',
    ttlSec: int(process.env.RADARX_AUTH_TOKEN_TTL_SEC, 86400),
    allowedOrigins: list(process.env.RADARX_ALLOWED_ORIGINS, ['https://appassets.androidplatform.net'])
  },
  staging: {
    testPushEnabled: String(process.env.RADARX_STAGING_TEST_PUSH_ENABLED ?? 'false').toLowerCase() === 'true'
  },
  api: {
    maxBodyBytes: int(process.env.RADARX_MAX_BODY_BYTES, 64 * 1024),
    rateLimitPerMinute: int(process.env.RADARX_API_RATE_LIMIT_PER_MINUTE, 60)
  }
});
