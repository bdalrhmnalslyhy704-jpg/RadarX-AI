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

    # Exchange credentials MUST live on the backend/VPS, never in the APK.
    cloud_relay_url: str = os.getenv("RADARX_CLOUD_RELAY_URL", "").strip()
    api_key: str = os.getenv("BINANCE_API_KEY", "").strip()
    api_secret: str = os.getenv("BINANCE_API_SECRET", "").strip()
    recv_window_ms: int = min(60000, max(1000, _int("BINANCE_RECV_WINDOW_MS", 5000)))

    # Sensitive API endpoints require a separate RadarX control token.
    control_token: str = os.getenv("RADARX_CONTROL_TOKEN", "").strip()
    require_control_token: bool = _bool("RADARX_REQUIRE_CONTROL_TOKEN", True)

    scan_interval_sec: float = max(2.0, _float("RADARX_SCAN_INTERVAL_SEC", 8.0))
    ticker_stale_sec: float = max(3.0, _float("RADARX_TICKER_STALE_SEC", 8.0))
    min_quote_volume: float = max(0.0, _float("RADARX_MIN_QUOTE_VOLUME", 750000))
    stage1_limit: int = max(20, _int("RADARX_STAGE1_LIMIT", 80))
    stage2_limit: int = max(5, _int("RADARX_STAGE2_LIMIT", 30))
    alert_score: float = max(0.0, min(100.0, _float("RADARX_ALERT_SCORE", 82)))
    alert_trap_max: float = max(0.0, min(100.0, _float("RADARX_ALERT_TRAP_MAX", 35)))
    max_concurrent_rest: int = max(2, _int("RADARX_MAX_CONCURRENT_REST", 12))
    rest_timeout_sec: float = max(2.0, _float("RADARX_REST_TIMEOUT_SEC", 5.5))

    risk_pct: float = max(0.05, min(5.0, _float("RADARX_RISK_PCT", 0.5)))
    max_notional_usdt: float = max(5.0, _float("RADARX_MAX_NOTIONAL_USDT", 50))
    daily_loss_pct: float = max(0.1, min(10.0, _float("RADARX_DAILY_LOSS_PCT", 2)))

    # Spot-only safety defaults. Futures stays hard-disabled unless a future
    # dedicated derivatives execution layer is intentionally added.
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

    @property
    def sensitive_api_ready(self) -> bool:
        return self.has_binance_credentials and (
            bool(self.control_token) or not self.require_control_token
        )


SETTINGS = Settings()
