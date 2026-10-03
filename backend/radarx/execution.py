from __future__ import annotations

import time
from dataclasses import asdict, dataclass
from decimal import Decimal, ROUND_DOWN, InvalidOperation
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


def _dec(value: Any, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal(default)


def _round_down(value: Decimal, step: Decimal) -> Decimal:
    if step <= 0:
        return value
    return (value / step).to_integral_value(rounding=ROUND_DOWN) * step


class RiskEngine:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.daily_realized_loss_usdt = 0.0

    def size(self, balance_usdt: float, signal: Signal) -> RiskPlan:
        if signal.entry <= signal.sl or signal.entry <= 0:
            return RiskPlan(False, 0, 0, 0, "INVALID_RISK_GEOMETRY")
        balance = max(0.0, float(balance_usdt))
        risk_usdt = balance * self.settings.risk_pct / 100
        if risk_usdt <= 0:
            return RiskPlan(False, 0, 0, 0, "NO_RISK_BUDGET")
        if self.daily_realized_loss_usdt >= balance * self.settings.daily_loss_pct / 100:
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

        # RadarX is explicitly spot-only for this execution layer:
        # - reading must be enabled
        # - spot trading must be enabled
        # - withdrawals must be disabled
        # - margin and futures must be disabled
        if restrictions.get("enableWithdrawals"):
            return {"ok": False, "mode": "blocked", "reason": "WITHDRAWALS_ENABLED_ON_API_KEY"}
        if not restrictions.get("enableReading", False):
            return {"ok": False, "mode": "blocked", "reason": "READ_PERMISSION_MISSING"}
        if not restrictions.get("enableSpotAndMarginTrading", False):
            return {"ok": False, "mode": "blocked", "reason": "SPOT_TRADE_PERMISSION_MISSING"}
        if restrictions.get("enableMargin"):
            return {"ok": False, "mode": "blocked", "reason": "MARGIN_PERMISSION_PRESENT"}
        if restrictions.get("enableFutures"):
            return {"ok": False, "mode": "blocked", "reason": "FUTURES_PERMISSION_PRESENT"}
        if restrictions.get("enablePortfolioMarginTrading"):
            return {"ok": False, "mode": "blocked", "reason": "PORTFOLIO_MARGIN_PERMISSION_PRESENT"}
        if self.settings.require_control_token and not self.settings.control_token:
            return {"ok": False, "mode": "blocked", "reason": "RADARX_CONTROL_TOKEN_MISSING"}

        return {
            "ok": True,
            "mode": "live-capable" if self.settings.allow_live_trading else "paper",
            "execution_surface": "BINANCE_SPOT",
            "permissions": {
                "enableReading": bool(restrictions.get("enableReading")),
                "enableSpotAndMarginTrading": bool(restrictions.get("enableSpotAndMarginTrading")),
                "enableWithdrawals": bool(restrictions.get("enableWithdrawals")),
                "enableMargin": bool(restrictions.get("enableMargin")),
                "enableFutures": bool(restrictions.get("enableFutures")),
            },
        }

    async def plan(self, signal: Signal, balance_usdt: float) -> dict[str, Any]:
        safety = await self.safety_check()
        risk = self.risk.size(balance_usdt, signal)
        return {
            "safety": safety,
            "risk": asdict(risk),
            "signal": signal.to_dict(),
            "live_execution_enabled": bool(
                safety.get("ok") and self.settings.allow_live_trading and self.settings.auto_execution
            ),
        }

    async def _normalize_limit_buy(self, symbol: str, raw_quantity: float, raw_price: float) -> tuple[str, str, float]:
        info = await self.rest.exchange_info(symbol)
        rows = info.get("symbols") if isinstance(info, dict) else None
        symbol_info = rows[0] if isinstance(rows, list) and rows else None
        if not isinstance(symbol_info, dict):
            raise RuntimeError("SYMBOL_RULES_UNAVAILABLE")

        filters = {
            str(x.get("filterType")): x
            for x in (symbol_info.get("filters") or [])
            if isinstance(x, dict)
        }

        price_filter = filters.get("PRICE_FILTER", {})
        lot_filter = filters.get("LOT_SIZE", {}) or filters.get("MARKET_LOT_SIZE", {})
        min_notional_filter = filters.get("NOTIONAL") or filters.get("MIN_NOTIONAL") or {}

        price = _round_down(
            _dec(raw_price),
            _dec(price_filter.get("tickSize"), "0.00000001"),
        )
        quantity = _round_down(
            _dec(raw_quantity),
            _dec(lot_filter.get("stepSize"), "0.00000001"),
        )

        min_price = _dec(price_filter.get("minPrice"))
        max_price = _dec(price_filter.get("maxPrice"))
        min_qty = _dec(lot_filter.get("minQty"))
        max_qty = _dec(lot_filter.get("maxQty"))
        min_notional = _dec(
            min_notional_filter.get("minNotional")
            or min_notional_filter.get("notional")
        )
        if min_price > 0 and price < min_price:
            price = min_price
        if max_price > 0 and price > max_price:
            price = max_price
        if min_qty > 0 and quantity < min_qty:
            quantity = min_qty
        if max_qty > 0 and quantity > max_qty:
            quantity = max_qty

        notional = quantity * price
        if min_notional > 0 and notional < min_notional:
            needed = (min_notional / max(price, Decimal("0.0000000000001")))
            quantity = _round_down(
                needed + _dec(lot_filter.get("stepSize"), "0.00000001"),
                _dec(lot_filter.get("stepSize"), "0.00000001"),
            )
            if max_qty > 0 and quantity > max_qty:
                raise RuntimeError("MIN_NOTIONAL_EXCEEDS_MAX_QTY")
            notional = quantity * price

        if quantity <= 0 or price <= 0:
            raise RuntimeError("NORMALIZED_ORDER_INVALID")
        if min_qty > 0 and quantity < min_qty:
            raise RuntimeError("MIN_QTY_NOT_MET")
        if max_qty > 0 and quantity > max_qty:
            raise RuntimeError("MAX_QTY_EXCEEDED")
        if min_notional > 0 and notional < min_notional:
            raise RuntimeError("MIN_NOTIONAL_NOT_MET")

        return format(quantity, "f"), format(price, "f"), float(notional)

    async def execute_limit_buy(self, signal: Signal, balance_usdt: float) -> dict[str, Any]:
        safety = await self.safety_check()
        if not (self.settings.allow_live_trading and self.settings.auto_execution and safety.get("ok")):
            return {
                "ok": True,
                "mode": "paper",
                "action": "WOULD_PLACE_LIMIT_BUY",
                "plan": {
                    "safety": safety,
                    "risk": asdict(self.risk.size(balance_usdt, signal)),
                    "signal": signal.to_dict(),
                },
            }

        if time.monotonic() - self.last_order_at.get(signal.symbol, 0) < 60:
            return {"ok": False, "mode": "blocked", "reason": "SYMBOL_COOLDOWN"}

        risk = self.risk.size(balance_usdt, signal)
        if not risk.allowed:
            return {"ok": False, "mode": "blocked", "reason": risk.reason}

        quantity, price, notional = await self._normalize_limit_buy(
            signal.symbol, risk.quantity, signal.entry
        )

        order = await self.rest.order({
            "symbol": signal.symbol,
            "side": "BUY",
            "type": "LIMIT",
            "timeInForce": "GTC",
            "quantity": quantity,
            "price": price,
            "newOrderRespType": "RESULT",
        })
        self.last_order_at[signal.symbol] = time.monotonic()
        return {
            "ok": True,
            "mode": "live",
            "order": order,
            "normalized": {
                "quantity": quantity,
                "price": price,
                "notional": notional,
            },
        }
