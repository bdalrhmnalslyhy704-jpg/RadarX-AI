from __future__ import annotations

import time
from dataclasses import asdict, dataclass
from typing import Any

from .binance import BinanceRest
from .config import Settings
from .models import Signal


@dataclass(slots=True)
class RiskPlan:
    allowed: bool
    risk_usdt: float
    quantity: float
    notional: float
    reason: str


class RiskEngine:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.daily_realized_loss_usdt = 0.0

    def size(self, balance_usdt: float, signal: Signal) -> RiskPlan:
        if signal.entry <= signal.sl or signal.entry <= 0:
            return RiskPlan(False, 0, 0, 0, "INVALID_RISK_GEOMETRY")
        risk_usdt = balance_usdt * self.settings.risk_pct / 100
        if risk_usdt <= 0:
            return RiskPlan(False, 0, 0, 0, "NO_RISK_BUDGET")
        if self.daily_realized_loss_usdt >= balance_usdt * self.settings.daily_loss_pct / 100:
            return RiskPlan(False, 0, 0, 0, "DAILY_LOSS_GUARD")
        stop_distance = signal.entry - signal.sl
        quantity = risk_usdt / stop_distance
        notional = quantity * signal.entry
        if notional > self.settings.max_notional_usdt:
            notional = self.settings.max_notional_usdt
            quantity = notional / signal.entry
        return RiskPlan(True, risk_usdt, quantity, notional, "OK")


class ExecutionEngine:
    def __init__(self, settings: Settings, rest: BinanceRest, risk: RiskEngine):
        self.settings = settings
        self.rest = rest
        self.risk = risk
        self.last_order_at: dict[str, float] = {}

    async def safety_check(self) -> dict[str, Any]:
        if not self.settings.has_binance_credentials:
            return {"ok": False, "mode": "paper", "reason": "BINANCE_CREDENTIALS_MISSING"}
        restrictions = await self.rest.api_restrictions()
        if restrictions.get("enableWithdrawals"):
            return {"ok": False, "mode": "blocked", "reason": "WITHDRAWALS_ENABLED_ON_API_KEY"}
        if restrictions.get("enableMargin"):
            return {"ok": False, "mode": "blocked", "reason": "MARGIN_PERMISSION_PRESENT"}
        if restrictions.get("enableFutures") and not self.settings.allow_futures:
            return {"ok": False, "mode": "blocked", "reason": "FUTURES_PERMISSION_PRESENT_BUT_DISABLED"}
        return {
            "ok": True,
            "mode": "live-capable" if self.settings.allow_live_trading else "paper",
            "permissions": restrictions,
        }

    async def plan(self, signal: Signal, balance_usdt: float) -> dict[str, Any]:
        safety = await self.safety_check()
        risk = self.risk.size(balance_usdt, signal)
        return {
            "safety": safety,
            "risk": asdict(risk),
            "signal": signal.to_dict(),
            "live_execution_enabled": bool(self.settings.allow_live_trading and self.settings.auto_execution),
        }

    async def execute_limit_buy(self, signal: Signal, balance_usdt: float) -> dict[str, Any]:
        if not (self.settings.allow_live_trading and self.settings.auto_execution):
            return {"ok": True, "mode": "paper", "action": "WOULD_PLACE_LIMIT_BUY", "plan": await self.plan(signal, balance_usdt)}
        safety = await self.safety_check()
        if not safety.get("ok"):
            return {"ok": False, "mode": "blocked", "reason": safety.get("reason")}
        if time.monotonic() - self.last_order_at.get(signal.symbol, 0) < 60:
            return {"ok": False, "mode": "blocked", "reason": "SYMBOL_COOLDOWN"}
        risk = self.risk.size(balance_usdt, signal)
        if not risk.allowed:
            return {"ok": False, "mode": "blocked", "reason": risk.reason}
        order = await self.rest.order({
            "symbol": signal.symbol,
            "side": "BUY",
            "type": "LIMIT",
            "timeInForce": "GTC",
            "quantity": f"{risk.quantity:.12f}",
            "price": f"{signal.entry:.12f}",
            "newOrderRespType": "RESULT",
        })
        self.last_order_at[signal.symbol] = time.monotonic()
        return {"ok": True, "mode": "live", "order": order}
