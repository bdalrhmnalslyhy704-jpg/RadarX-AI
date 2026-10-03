from __future__ import annotations

from statistics import pstdev


def avg(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def pct_change(a: float, b: float) -> float:
    return (b / a - 1.0) * 100 if a > 0 else 0.0


def ema(values: list[float], length: int) -> float:
    if not values:
        return 0.0
    k = 2.0 / (length + 1)
    result = values[0]
    for value in values[1:]:
        result = value * k + result * (1 - k)
    return result


def atr_pct(bars: list[dict], length: int = 14) -> float | None:
    if len(bars) < length + 1:
        return None
    true_ranges = []
    for i in range(1, len(bars)):
        bar, prev = bars[i], bars[i - 1]
        true_ranges.append(max(
            bar["h"] - bar["l"],
            abs(bar["h"] - prev["c"]),
            abs(bar["l"] - prev["c"]),
        ))
    atr = avg(true_ranges[-length:])
    return atr / bars[-1]["c"] * 100 if bars[-1]["c"] > 0 else None


def bollinger_width(bars: list[dict], length: int = 20) -> float | None:
    if len(bars) < length:
        return None
    closes = [x["c"] for x in bars[-length:]]
    mean = avg(closes)
    return 4 * pstdev(closes) / mean * 100 if mean > 0 else None


def vwap_distance_pct(bars: list[dict], length: int = 20) -> float:
    sample = bars[-length:]
    total_volume = sum(max(0.0, x["v"]) for x in sample)
    if total_volume <= 0:
        return 0.0
    vwap = sum(((x["h"] + x["l"] + x["c"]) / 3) * x["v"] for x in sample) / total_volume
    return pct_change(vwap, bars[-1]["c"]) if vwap > 0 else 0.0


def volume_ratio(bars: list[dict], length: int = 20) -> float:
    if len(bars) < length + 1:
        return 0.0
    base = avg([x["v"] for x in bars[-length - 1:-1]])
    return bars[-1]["v"] / base if base > 0 else 0.0


def order_imbalance(depth: dict) -> float:
    bids = depth.get("bids", [])[:20]
    asks = depth.get("asks", [])[:20]
    bid_notional = sum(float(row[0]) * float(row[1]) for row in bids if len(row) >= 2)
    ask_notional = sum(float(row[0]) * float(row[1]) for row in asks if len(row) >= 2)
    total = bid_notional + ask_notional
    return bid_notional / total * 100 if total > 0 else 50.0


def tape_buy_pct(trades: list[dict]) -> float:
    buy = sell = 0.0
    for row in trades[-150:]:
        notional = float(row.get("p", 0)) * float(row.get("q", 0))
        if row.get("m"):
            sell += notional
        else:
            buy += notional
    total = buy + sell
    return buy / total * 100 if total > 0 else 50.0


def mtf_bull(bars_5: list[dict], bars_15: list[dict], bars_60: list[dict]) -> int:
    score = 0
    for bars in (bars_5, bars_15, bars_60):
        if len(bars) < 30:
            continue
        closes = [x["c"] for x in bars]
        if closes[-1] > ema(closes[-60:], min(20, len(closes))):
            score += 1
    return score
