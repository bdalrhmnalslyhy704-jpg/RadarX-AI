from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
from collections import defaultdict
from typing import Any
from urllib.parse import urlencode

import httpx
from websockets.asyncio.client import connect

from .config import Settings
from .models import Ticker

log = logging.getLogger("radarx.binance")


class TTLCache:
    def __init__(self, max_items: int = 700):
        self.max_items = max_items
        self.data: dict[str, tuple[float, Any]] = {}
        self.lock = asyncio.Lock()

    async def get(self, key: str, max_age: float) -> Any | None:
        async with self.lock:
            item = self.data.get(key)
            if not item:
                return None
            ts, value = item
            if time.monotonic() - ts > max_age:
                self.data.pop(key, None)
                return None
            return value

    async def put(self, key: str, value: Any) -> None:
        async with self.lock:
            self.data[key] = (time.monotonic(), value)
            if len(self.data) > self.max_items:
                old = sorted(self.data, key=lambda k: self.data[k][0])[: max(20, self.max_items // 8)]
                for key in old:
                    self.data.pop(key, None)


class RouteHealth:
    def __init__(self, count: int):
        self.ok = [0] * count
        self.fail = [0] * count
        self.last_ok = [0.0] * count
        self.latency = [0.0] * count
        self.lock = asyncio.Lock()

    async def mark(self, index: int, success: bool, latency: float) -> None:
        async with self.lock:
            if success:
                self.ok[index] += 1
                self.last_ok[index] = time.monotonic()
                if latency > 0:
                    self.latency[index] = latency
            else:
                self.fail[index] += 1

    async def order(self, preferred: int) -> list[int]:
        async with self.lock:
            now = time.monotonic()
            ranked = []
            for i in range(len(self.ok)):
                score = (self.ok[i] - 2 * self.fail[i]) * 0.5
                if now - self.last_ok[i] < 30:
                    score += 20
                if self.latency[i] > 0:
                    score -= self.latency[i] * 2
                ranked.append((i, score))
        ranked.sort(key=lambda x: x[1], reverse=True)
        return [preferred] + [i for i, _ in ranked if i != preferred]


class BinanceRest:
    def __init__(self, settings: Settings):
        self.settings = settings
        limits = httpx.Limits(max_connections=30, max_keepalive_connections=20, keepalive_expiry=30)
        self.client = httpx.AsyncClient(
            http2=True,
            timeout=httpx.Timeout(settings.rest_timeout_sec),
            limits=limits,
            follow_redirects=True,
            headers={"Accept": "application/json", "User-Agent": "RadarX-Backend/0.1"},
        )
        self.cache = TTLCache()
        self.health = RouteHealth(len(settings.market_base_urls))
        self.preferred = 0
        self.sem = asyncio.Semaphore(settings.max_concurrent_rest)

    async def close(self) -> None:
        await self.client.aclose()

    def _sign(self, params: dict[str, Any]) -> str:
        query = urlencode(params, doseq=True)
        return hmac.new(self.settings.api_secret.encode(), query.encode(), hashlib.sha256).hexdigest()

    async def request(
        self,
        path: str,
        params: dict[str, Any] | None = None,
        *,
        signed: bool = False,
        method: str = "GET",
        cache_ttl: float = 0,
        stale_ttl: float = 0,
    ) -> Any:
        params = dict(params or {})
        cache_key = method + " " + path + "?" + urlencode(sorted(params.items()))
        if not signed and cache_ttl > 0:
            cached = await self.cache.get(cache_key, cache_ttl)
            if cached is not None:
                return cached

        if signed:
            if not self.settings.has_binance_credentials:
                raise RuntimeError("BINANCE_CREDENTIALS_MISSING")
            params.setdefault("timestamp", int(time.time() * 1000))
            params.setdefault("recvWindow", self.settings.recv_window_ms)
            signature = self._sign(params)
            params["signature"] = signature

        last_exc: Exception | None = None
        async with self.sem:
            order = await self.health.order(self.preferred)
            routes: list[tuple[int, str, dict[str, Any] | None]] = []

            if not signed and self.settings.cloud_relay_url:
                relay_params = {"path": path}
                if params:
                    relay_params["path"] = path + "?" + urlencode(params)
                routes.append((-1, self.settings.cloud_relay_url, relay_params))

            routes.extend((i, self.settings.market_base_urls[i] + path, params) for i in order)

            for index, url, query_params in routes:
                started = time.monotonic()
                try:
                    headers = {}
                    if signed:
                        headers["X-MBX-APIKEY"] = self.settings.api_key
                    response = await self.client.request(method, url, params=query_params, headers=headers)
                    if response.status_code >= 400:
                        raise RuntimeError(f"BINANCE_HTTP_{response.status_code}:{response.text[:200]}")
                    data = response.json()
                    latency = time.monotonic() - started
                    if index >= 0:
                        await self.health.mark(index, True, latency)
                        self.preferred = index
                    if not signed and cache_ttl > 0:
                        await self.cache.put(cache_key, data)
                    return data
                except Exception as exc:
                    last_exc = exc
                    if index >= 0:
                        await self.health.mark(index, False, time.monotonic() - started)

        if not signed and stale_ttl > 0:
            stale = await self.cache.get(cache_key, stale_ttl)
            if stale is not None:
                return stale
        raise last_exc or RuntimeError("BINANCE_UNAVAILABLE")

    async def ping(self) -> dict[str, Any]:
        started = time.monotonic()
        data = await self.request("/api/v3/ping", cache_ttl=0.5)
        return {"ok": True, "latency_ms": round((time.monotonic() - started) * 1000, 1), "data": data}

    async def tickers_24h(self) -> list[dict[str, Any]]:
        return await self.request("/api/v3/ticker/24hr", cache_ttl=1.0, stale_ttl=5.0)

    async def klines(self, symbol: str, interval: str, limit: int) -> list[list[Any]]:
        return await self.request(
            "/api/v3/klines",
            {"symbol": symbol, "interval": interval, "limit": min(1000, max(10, limit))},
            cache_ttl=1.5 if interval in {"1m", "5m"} else 2.5,
            stale_ttl=8,
        )

    async def depth(self, symbol: str, limit: int = 20) -> dict[str, Any]:
        return await self.request(
            "/api/v3/depth",
            {"symbol": symbol, "limit": min(100, max(5, limit))},
            cache_ttl=0.45,
            stale_ttl=3,
        )

    async def agg_trades(self, symbol: str, limit: int = 120) -> list[dict[str, Any]]:
        return await self.request(
            "/api/v3/aggTrades",
            {"symbol": symbol, "limit": min(1000, max(10, limit))},
            cache_ttl=0.5,
            stale_ttl=3,
        )

    async def account(self) -> dict[str, Any]:
        return await self.request("/api/v3/account", signed=True, cache_ttl=1, stale_ttl=3)

    async def api_restrictions(self) -> dict[str, Any]:
        return await self.request("/sapi/v1/account/apiRestrictions", signed=True, cache_ttl=30, stale_ttl=90)

    async def order(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.request("/api/v3/order", params, signed=True, method="POST")


class BinanceStreams:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.latest: dict[str, Ticker] = {}
        self.klines: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        self.depth: dict[str, dict[str, Any]] = {}
        self.trades: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.connected = False
        self.last_message = 0.0
        self._tasks: list[asyncio.Task] = []
        self._candidate_symbols: tuple[str, ...] = ()
        self._wake = asyncio.Event()
        self._stop = asyncio.Event()
        self._preferred_ws = 0

    async def start(self) -> None:
        self._stop.clear()
        self._tasks = [
            asyncio.create_task(self._run_ticker(), name="radarx-ticker-ws"),
            asyncio.create_task(self._run_deep(), name="radarx-deep-ws"),
        ]

    async def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        self.connected = False

    async def set_candidates(self, symbols: list[str]) -> None:
        desired = tuple(sorted(set(s.upper() for s in symbols if s)))
        if desired != self._candidate_symbols:
            self._candidate_symbols = desired
            self._wake.set()

    def snapshot(self) -> dict[str, Ticker]:
        return dict(self.latest)

    async def _connect(self, streams: list[str]):
        ordered = [
            self.settings.ws_urls[(self._preferred_ws + i) % len(self.settings.ws_urls)]
            for i in range(len(self.settings.ws_urls))
        ]
        last: Exception | None = None
        for base in ordered:
            try:
                url = base + "?streams=" + "/".join(streams)
                socket = await connect(
                    url,
                    ping_interval=15,
                    ping_timeout=10,
                    close_timeout=5,
                    max_size=8 * 1024 * 1024,
                )
                self._preferred_ws = self.settings.ws_urls.index(base)
                return socket
            except Exception as exc:
                last = exc
        raise last or RuntimeError("BINANCE_WS_UNAVAILABLE")

    async def _run_ticker(self) -> None:
        while not self._stop.is_set():
            socket = None
            try:
                socket = await self._connect(["!miniTicker@arr"])
                self.connected = True
                opened = time.monotonic()
                async for raw in socket:
                    self.last_message = time.monotonic()
                    payload = json.loads(raw)
                    rows = payload if isinstance(payload, list) else payload.get("data", payload)
                    for row in rows if isinstance(rows, list) else [rows]:
                        if not isinstance(row, dict) or not row.get("s"):
                            continue
                        last = float(row.get("c") or 0)
                        if last <= 0:
                            continue
                        symbol = str(row["s"]).upper()
                        self.latest[symbol] = Ticker(
                            symbol=symbol,
                            last=last,
                            change_24h=float(row.get("P") or 0),
                            quote_volume=float(row.get("q") or 0),
                            event_time=int(row.get("E") or int(time.time() * 1000)),
                        )
                    if time.monotonic() - opened > 22 * 3600:
                        break
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("ticker websocket reconnect: %s", exc)
                await asyncio.sleep(1)
            finally:
                self.connected = False
                if socket is not None:
                    try:
                        await socket.close()
                    except Exception:
                        pass

    async def _run_deep(self) -> None:
        while not self._stop.is_set():
            await self._wake.wait()
            self._wake.clear()
            if self._stop.is_set():
                break
            current = self._candidate_symbols
            streams: list[str] = []
            for symbol in current[:30]:
                s = symbol.lower()
                streams.extend([
                    f"{s}@kline_1m",
                    f"{s}@kline_5m",
                    f"{s}@depth20@100ms",
                    f"{s}@aggTrade",
                ])
            if not streams:
                await asyncio.sleep(0.5)
                continue

            socket = None
            try:
                socket = await self._connect(streams)
                opened = time.monotonic()
                while not self._stop.is_set() and current == self._candidate_symbols:
                    try:
                        raw = await asyncio.wait_for(socket.recv(), timeout=25)
                    except asyncio.TimeoutError:
                        await socket.ping()
                        continue
                    self.last_message = time.monotonic()
                    message = json.loads(raw)
                    data = message.get("data", message)
                    event = data.get("e")
                    symbol = str(data.get("s") or "").upper()
                    if not symbol:
                        continue

                    if event == "kline":
                        k = data.get("k", {})
                        key = (symbol, str(k.get("i") or "1m"))
                        row = {
                            "t": int(k.get("t") or 0),
                            "o": float(k.get("o") or 0),
                            "h": float(k.get("h") or 0),
                            "l": float(k.get("l") or 0),
                            "c": float(k.get("c") or 0),
                            "v": float(k.get("v") or 0),
                            "q": float(k.get("q") or 0),
                            "closed": bool(k.get("x")),
                        }
                        arr = self.klines[key]
                        if arr and arr[-1]["t"] == row["t"]:
                            arr[-1] = row
                        else:
                            arr.append(row)
                        del arr[:-220]
                    elif event == "depthUpdate":
                        self.depth[symbol] = {
                            "bids": data.get("b", []),
                            "asks": data.get("a", []),
                            "E": data.get("E"),
                        }
                    elif event == "aggTrade":
                        arr = self.trades[symbol]
                        arr.append({
                            "p": float(data.get("p") or 0),
                            "q": float(data.get("q") or 0),
                            "m": bool(data.get("m")),
                            "T": int(data.get("T") or 0),
                            "a": int(data.get("a") or 0),
                        })
                        del arr[:-400]
                    if time.monotonic() - opened > 22 * 3600:
                        break
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("deep websocket reconnect: %s", exc)
                await asyncio.sleep(1)
            finally:
                if socket is not None:
                    try:
                        await socket.close()
                    except Exception:
                        pass
            self._wake.set()
