from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import Any, Awaitable, Callable

from .binance import BinanceRest, BinanceStreams
from .config import Settings
from .indicators import atr_pct, bollinger_width, mtf_bull, order_imbalance, pct_change, tape_buy_pct, volume_ratio, vwap_distance_pct
from .models import Signal, Ticker

log = logging.getLogger("radarx.scanner")

EXCLUDED = {
    "USDCUSDT", "USDPUSDT", "FDUSDUSDT", "TUSDUSDT", "DAIUSDT", "USDEUSDT", "BUSDUSDT"
}


def clamp(value: float, lo: float = 0, hi: float = 100) -> float:
    return max(lo, min(hi, float(value)))


def priority(ticker: Ticker) -> float:
    liquidity = min(35, max(0, math.log10(max(1, ticker.quote_volume / 1_000_000)) * 12))
    move = min(35, abs(ticker.change_24h) * 3)
    upside = max(0, ticker.change_24h) * 2
    return liquidity + move + upside


class RadarScanner:
    def __init__(self, settings: Settings, rest: BinanceRest, streams: BinanceStreams):
        self.settings = settings
        self.rest = rest
        self.streams = streams
        self.last_result: dict[str, Any] | None = None
        self.last_scan_at = 0.0
        self.lock = asyncio.Lock()
        self.on_alert: Callable[[Signal], Awaitable[None]] | None = None
        # Only freshly computed signals may be submitted to the execution layer.
        self.latest_signals: dict[str, Signal] = {}

    def universe(self) -> list[Ticker]:
        now_ms = int(time.time() * 1000)
        out = []
        for ticker in self.streams.snapshot().values():
            symbol = ticker.symbol
            if symbol in EXCLUDED or not symbol.endswith("USDT"):
                continue
            if any(x in symbol for x in ("UP", "DOWN", "BULL", "BEAR")):
                continue
            if ticker.last <= 0 or ticker.quote_volume < self.settings.min_quote_volume:
                continue
            if now_ms - ticker.event_time > self.settings.ticker_stale_sec * 1000:
                continue
            out.append(ticker)
        return out

    async def rest_universe(self) -> list[Ticker]:
        rows = await self.rest.tickers_24h()
        now_ms = int(time.time() * 1000)
        out = []
        for row in rows if isinstance(rows, list) else []:
            symbol = str(row.get("symbol") or "").upper()
            try:
                last = float(row.get("lastPrice") or 0)
                volume = float(row.get("quoteVolume") or 0)
                change = float(row.get("priceChangePercent") or 0)
            except (TypeError, ValueError):
                continue
            if symbol in EXCLUDED or not symbol.endswith("USDT") or last <= 0 or volume < self.settings.min_quote_volume:
                continue
            out.append(Ticker(symbol, last, change, volume, now_ms))
        return out

    async def scan(self, force: bool = False) -> dict[str, Any]:
        async with self.lock:
            now = time.monotonic()
            if not force and self.last_result and now - self.last_scan_at < self.settings.scan_interval_sec:
                return self.last_result

            universe = self.universe()
            source = "websocket"
            if len(universe) < 20:
                universe = await self.rest_universe()
                source = "rest-fallback"
            if not universe:
                raise RuntimeError("BINANCE_MARKET_DATA_UNAVAILABLE")

            universe.sort(key=priority, reverse=True)
            stage1 = universe[: self.settings.stage1_limit]
            await self.streams.set_candidates([x.symbol for x in stage1[: self.settings.stage2_limit]])

            # Regime is computed from closed short-term candles, not a division of
            # the 24h percentage. This makes the market context responsive to the
            # same intraday horizon used by the candidate engine.
            try:
                btc_5m, btc_1h, eth_5m = await asyncio.gather(
                    self.rest.klines("BTCUSDT", "5m", 80),
                    self.rest.klines("BTCUSDT", "1h", 50),
                    self.rest.klines("ETHUSDT", "5m", 80),
                )
                b5, b60, e5 = map(self._bars, (btc_5m, btc_1h, eth_5m))
                if len(b5) >= 16 and len(b60) >= 3 and len(e5) >= 16:
                    btc15 = pct_change(b5[-4]["c"], b5[-1]["c"])
                    btc60 = pct_change(b60[-2]["c"], b60[-1]["c"])
                    eth15 = pct_change(e5[-4]["c"], e5[-1]["c"])
                else:
                    raise ValueError("INSUFFICIENT_REGIME_HISTORY")
            except Exception:
                btc = next((x for x in universe if x.symbol == "BTCUSDT"), None)
                eth = next((x for x in universe if x.symbol == "ETHUSDT"), None)
                btc15 = btc.change_24h / 4 if btc else 0
                btc60 = btc.change_24h if btc else 0
                eth15 = eth.change_24h / 4 if eth else 0

            breadth = sum(1 for x in universe if x.change_24h > 0) / len(universe) * 100
            regime_score = clamp(
                50
                + (10 if btc15 > 0 else -10)
                + (15 if btc60 > 0 else -12)
                + (6 if eth15 > 0 else -5)
                + (breadth - 50) * 0.25
            )

            semaphore = asyncio.Semaphore(self.settings.max_concurrent_rest)

            async def analyze_one(ticker: Ticker) -> Signal | None:
                async with semaphore:
                    try:
                        return await self._analyze(ticker, regime_score, btc15)
                    except Exception as exc:
                        log.debug("deep scan %s failed: %s", ticker.symbol, exc)
                        return None

            results = await asyncio.gather(*(analyze_one(t) for t in stage1[: self.settings.stage2_limit]))
            rows = sorted((x for x in results if x), key=lambda x: x.score, reverse=True)
            self.latest_signals = {x.symbol.upper(): x for x in rows[: self.settings.stage2_limit]}

            alerts = []
            for signal in rows:
                if signal.score >= self.settings.alert_score and signal.trap_risk <= self.settings.alert_trap_max and signal.phase in {"PRE-BREAKOUT", "BREAKOUT"}:
                    alerts.append(signal.to_dict())
                    if self.on_alert:
                        await self.on_alert(signal)
                    if len(alerts) >= 3:
                        break

            result = {
                "ok": True,
                "engine": "RadarX Backend 0.1",
                "source": source,
                "checked_at": int(time.time() * 1000),
                "universe": len(universe),
                "stage1": len(stage1),
                "deep_scanned": len(rows),
                "regime": {
                    "score": round(regime_score, 1),
                    "btc15": round(btc15, 3),
                    "btc60": round(btc60, 3),
                    "eth15": round(eth15, 3),
                    "breadth": round(breadth, 1),
                },
                "alerts": alerts,
                "top": [x.to_dict() for x in rows[:10]],
            }
            self.last_result = result
            self.last_scan_at = now
            return result

    async def _analyze(self, ticker: Ticker, regime_score: float, btc15: float) -> Signal | None:
        symbol = ticker.symbol
        m1, m5, m15, h1, depth, trades = await asyncio.gather(
            self.rest.klines(symbol, "1m", 130),
            self.rest.klines(symbol, "5m", 100),
            self.rest.klines(symbol, "15m", 70),
            self.rest.klines(symbol, "1h", 55),
            self.rest.depth(symbol, 20),
            self.rest.agg_trades(symbol, 120),
        )
        b1, b5, b15, b60 = map(self._bars, (m1, m5, m15, h1))
        if len(b5) < 35 or len(b15) < 30 or len(b60) < 25:
            return None

        last = b5[-1]
        high20 = max(x["h"] for x in b5[-21:-1])
        r5 = pct_change(b5[-2]["c"], last["c"])
        r15 = pct_change(b15[-2]["c"], b15[-1]["c"])
        r60 = pct_change(b60[-2]["c"], b60[-1]["c"])
        prev_r5 = pct_change(b5[-3]["c"], b5[-2]["c"])
        acceleration = r5 - prev_r5
        vr = volume_ratio(b5, 20)
        bb = bollinger_width(b5, 20)
        bb_prev = bollinger_width(b5[:-1], 20)
        squeeze = bb / bb_prev if bb and bb_prev else None
        atr = atr_pct(b5, 14)
        vw_dist = vwap_distance_pct(b5, 20)
        imb = order_imbalance(depth)
        buy_pct = tape_buy_pct(trades)
        mtf = mtf_bull(b5, b15, b60)
        breakout_distance = pct_change(last["c"], high20)
        break_pct = pct_change(high20, last["c"])
        rs = r15 - btc15

        liquidity = clamp(50 + min(35, math.log10(max(1, ticker.quote_volume / 1_000_000)) * 11))
        momentum = clamp(50 + r5 * 22 + r15 * 10 + max(0, acceleration) * 15)
        volume_score = clamp(45 + max(0, vr - 1) * 30 + max(0, vr - 1) * 12)
        compression = clamp(55 + ((1 - squeeze) * 80 if squeeze is not None else 0) + (10 if bb is not None and bb < 2 else 0))
        structure = clamp(60 + (24 if break_pct >= 0 else 8) + max(0, min(12, 1.2 - max(0, breakout_distance) * 5)))
        flow = clamp(50 + (buy_pct - 50) * 1.15)
        book = clamp(50 + (imb - 50) * 1.2)
        mtf_score = {0: 30, 1: 55, 2: 78, 3: 95}[mtf]
        relative = clamp(50 + rs * 22)
        score = clamp(
            regime_score * 0.10 + structure * 0.15 + momentum * 0.14 + volume_score * 0.14 +
            compression * 0.10 + flow * 0.12 + book * 0.10 + mtf_score * 0.08 +
            relative * 0.04 + liquidity * 0.03
        )

        trap = 8.0
        trap_reasons = []
        if r15 > 4.5:
            trap += 18; trap_reasons.append("15m overextension")
        if vw_dist > 3.2:
            trap += 10; trap_reasons.append("far above VWAP")
        candle_range = max(1e-12, last["h"] - last["l"])
        upper_wick = max(0, last["h"] - max(last["o"], last["c"])) / candle_range * 100
        if upper_wick > 45:
            trap += 12; trap_reasons.append("upper-wick rejection")
        if vr < 1 and r5 > 0.6:
            trap += 12; trap_reasons.append("price up without volume")
        if imb < 43:
            trap += 15; trap_reasons.append("bearish order-book imbalance")
        if buy_pct < 44:
            trap += 15; trap_reasons.append("sell-heavy tape")
        if break_pct > 2.2:
            trap += 12; trap_reasons.append("extended breakout")
        if mtf == 0:
            trap += 16; trap_reasons.append("multi-timeframe conflict")
        trap = clamp(trap)

        breakout = break_pct >= 0.20
        pre = score >= 82 and trap < 35 and -0.10 <= breakout_distance <= 1.20
        if trap >= 60:
            phase = "EXHAUSTED-HIGH RISK"
        elif breakout:
            phase = "BREAKOUT"
        elif pre:
            phase = "PRE-BREAKOUT"
        elif score >= 68:
            phase = "BUILDING"
        else:
            phase = "NORMAL"

        entry = last["c"] if breakout else high20 * 1.0015
        risk_unit = max((atr or 0.6) * last["c"] / 100 * 1.2, last["c"] * 0.004)
        sl = max(0, entry - risk_unit)
        tp1, tp2, tp3 = entry + risk_unit, entry + 2 * risk_unit, entry + 3 * risk_unit

        reasons = []
        if regime_score >= 68: reasons.append("supportive BTC/ETH regime")
        if mtf >= 2: reasons.append("multi-timeframe alignment")
        if vr >= 1.4: reasons.append("relative volume expansion")
        if squeeze is not None and squeeze < 0.82: reasons.append("volatility compression")
        if 0 <= breakout_distance <= 0.8: reasons.append("near prior resistance")
        if imb >= 57: reasons.append("bid-side depth advantage")
        if buy_pct >= 57: reasons.append("buy-dominant tape")
        if rs >= 0.7: reasons.append("relative strength vs BTC")

        return Signal(
            symbol=symbol,
            price=last["c"],
            score=round(score, 2),
            trap_risk=round(trap, 2),
            phase=phase,
            entry=entry,
            sl=sl,
            tp1=tp1,
            tp2=tp2,
            tp3=tp3,
            risk_reward_1=round((tp1 - entry) / max(entry - sl, 1e-12), 2),
            r5=r5,
            r15=r15,
            r60=r60,
            volume_ratio=vr,
            squeeze_ratio=squeeze,
            atr_pct=atr,
            vwap_dist_pct=vw_dist,
            breakout_distance_pct=breakout_distance,
            order_imbalance_pct=imb,
            tape_buy_pct=buy_pct,
            mtf_bull=mtf,
            relative_strength=rs,
            reasons=reasons,
            trap_reasons=trap_reasons,
            checked_at=int(time.time() * 1000),
        )

    @staticmethod
    def _bars(rows: list[list[Any]]) -> list[dict[str, Any]]:
        result = []
        for row in rows if isinstance(rows, list) else []:
            if len(row) < 10:
                continue
            try:
                item = {
                    "t": int(row[0]), "o": float(row[1]), "h": float(row[2]), "l": float(row[3]),
                    "c": float(row[4]), "v": float(row[5]), "q": float(row[7]),
                    "closed": int(row[6]) <= int(time.time() * 1000),
                }
            except (TypeError, ValueError):
                continue
            if item["c"] > 0 and item["h"] >= max(item["o"], item["c"]) and item["l"] <= min(item["o"], item["c"]):
                result.append(item)
        return result


    def latest_signal(self, symbol: str) -> Signal | None:
        return self.latest_signals.get(str(symbol or "").upper())
