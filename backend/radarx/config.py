from dataclasses import dataclass
import os


def _bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    return default if value is None else value.strip().lower() in {"1", "true", "yes", "on"}


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    host: str = os.getenv("RADARX_HOST", "0.0.0.0")
    port: int = _int("RADARX_PORT", 8000)
    log_level: str = os.getenv("RADARX_LOG_LEVEL", "INFO").upper()

    market_base_urls: tuple[str, ...] = (
        "https://api.binance.com",
        "https://data-api.binance.vision",
        "https://api-gcp.binance.com",
        "https://api1.binance.com",
        "https://api2.binance.com",
        "https://api3.binance.com",
        "https://api4.binance.com",
    )
    ws_urls: tuple[str, ...] = (
        "wss://stream.binance.com:9443/stream",
        "wss://stream.binance.com:443/stream",
        "wss://data-stream.binance.vision/stream",
        "wss://stream.binance.com/stream",
    )

    cloud_relay_url: str = os.getenv("RADARX_CLOUD_RELAY_URL", "").strip()
    api_key: str = os.getenv("BINANCE_API_KEY", "").strip()
    api_secret: str = os.getenv("BINANCE_API_SECRET", "").strip()
    recv_window_ms: int = _int("BINANCE_RECV_WINDOW_MS", 5000)

    scan_interval_sec: float = _float("RADARX_SCAN_INTERVAL_SEC", 8.0)
    ticker_stale_sec: float = _float("RADARX_TICKER_STALE_SEC", 8.0)
    min_quote_volume: float = _float("RADARX_MIN_QUOTE_VOLUME", 750000)
    stage1_limit: int = _int("RADARX_STAGE1_LIMIT", 80)
    stage2_limit: int = _int("RADARX_STAGE2_LIMIT", 30)
    alert_score: float = _float("RADARX_ALERT_SCORE", 82)
    alert_trap_max: float = _float("RADARX_ALERT_TRAP_MAX", 35)
    max_concurrent_rest: int = _int("RADARX_MAX_CONCURRENT_REST", 12)
    rest_timeout_sec: float = _float("RADARX_REST_TIMEOUT_SEC", 5.5)

    risk_pct: float = _float("RADARX_RISK_PCT", 0.5)
    max_notional_usdt: float = _float("RADARX_MAX_NOTIONAL_USDT", 50)
    daily_loss_pct: float = _float("RADARX_DAILY_LOSS_PCT", 2)

    allow_live_trading: bool = _bool("RADARX_ALLOW_LIVE_TRADING", False)
    auto_execution: bool = _bool("RADARX_AUTO_EXECUTION", False)
    allow_futures: bool = _bool("RADARX_ALLOW_FUTURES", False)

    alert_webhook_url: str = os.getenv("RADARX_ALERT_WEBHOOK_URL", "").strip()
    cors_origins: tuple[str, ...] = tuple(
        x.strip() for x in os.getenv("RADARX_CORS_ORIGINS", "*").split(",") if x.strip()
    )

    @property
    def has_binance_credentials(self) -> bool:
        return bool(self.api_key and self.api_secret)


SETTINGS = Settings()
