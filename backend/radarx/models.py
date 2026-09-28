from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any


@dataclass(slots=True)
class Ticker:
    symbol: str
    last: float
    change_24h: float
    quote_volume: float
    event_time: int
    bid: float = 0.0
    ask: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class Signal:
    symbol: str
    price: float
    score: float
    trap_risk: float
    phase: str
    entry: float
    sl: float
    tp1: float
    tp2: float
    tp3: float
    risk_reward_1: float
    r5: float
    r15: float
    r60: float
    volume_ratio: float
    squeeze_ratio: float | None
    atr_pct: float | None
    vwap_dist_pct: float
    breakout_distance_pct: float
    order_imbalance_pct: float
    tape_buy_pct: float
    mtf_bull: int
    relative_strength: float
    reasons: list[str]
    trap_reasons: list[str]
    checked_at: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
