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
    allowedOrigins: list(process.env.RADARX_ALLOWED_ORIGINS, [])
  },
  staging: {
    testPushEnabled: String(process.env.RADARX_STAGING_TEST_PUSH_ENABLED ?? 'false').toLowerCase() === 'true'
  },
  api: {
    publicOrigin: String(process.env.RADARX_PUBLIC_API_ORIGIN ?? '').trim().replace(/\/+$/,''),
    maxBodyBytes: int(process.env.RADARX_MAX_BODY_BYTES, 64 * 1024),
    rateLimitPerMinute: int(process.env.RADARX_API_RATE_LIMIT_PER_MINUTE, 60)
  }
});
