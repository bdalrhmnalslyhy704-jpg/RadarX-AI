from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .binance import BinanceRest, BinanceStreams
from .config import SETTINGS
from .execution import ExecutionEngine, RiskEngine
from .scanner import RadarScanner

logging.basicConfig(level=SETTINGS.log_level)
log = logging.getLogger("radarx")


class AppState:
    def __init__(self):
        self.rest = BinanceRest(SETTINGS)
        self.streams = BinanceStreams(SETTINGS)
        self.scanner = RadarScanner(SETTINGS, self.rest, self.streams)
        self.execution = ExecutionEngine(SETTINGS, self.rest, RiskEngine(SETTINGS))
        self.tasks: list[asyncio.Task] = []
        self.started_at = time.time()
        self.alerts: list[dict[str, Any]] = []

    async def start(self):
        await self.streams.start()
        self.tasks = [asyncio.create_task(self.scanner_loop(), name="radarx-scanner-loop")]

    async def stop(self):
        for task in self.tasks:
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.streams.stop()
        await self.rest.close()

    async def scanner_loop(self):
        await asyncio.sleep(1)
        while True:
            try:
                result = await self.scanner.scan(force=True)
                if result.get("alerts"):
                    self.alerts = (result["alerts"] + self.alerts)[:50]
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("scanner loop: %s", exc)
            await asyncio.sleep(max(2, SETTINGS.scan_interval_sec))


STATE = AppState()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await STATE.start()
    yield
    await STATE.stop()


app = FastAPI(title="RadarX Backend", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(SETTINGS.cors_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/v1/health")
async def health():
    try:
        ping = await STATE.rest.ping()
        return {
            "ok": True,
            "uptime_sec": round(time.time() - STATE.started_at, 1),
            "binance": ping,
            "websocket_connected": STATE.streams.connected,
            "last_ws_message_age_ms": round((time.monotonic() - STATE.streams.last_message) * 1000, 1) if STATE.streams.last_message else None,
            "symbols_live": len(STATE.streams.latest),
            "server_time_ms": int(time.time() * 1000),
        }
    except Exception as exc:
        raise HTTPException(502, detail=str(exc)) from exc


@app.get("/api/v1/market")
async def market(limit: int = 50):
    rows = sorted(STATE.streams.snapshot().values(), key=lambda x: x.quote_volume, reverse=True)
    return {"ok": True, "live": STATE.streams.connected, "items": [x.to_dict() for x in rows[: max(1, min(200, limit))]]}


@app.get("/api/v1/scan")
async def scan(force: bool = False):
    try:
        return await STATE.scanner.scan(force=force)
    except Exception as exc:
        raise HTTPException(502, detail=str(exc)) from exc


@app.get("/api/v1/alerts")
async def alerts():
    return {"ok": True, "items": STATE.alerts}


@app.get("/api/v1/account")
async def account():
    try:
        safety = await STATE.execution.safety_check()
        if not SETTINGS.has_binance_credentials:
            return {"ok": False, "mode": "paper", "reason": "BINANCE_CREDENTIALS_MISSING"}
        account = await STATE.rest.account()
        return {"ok": True, "safety": safety, "account": account}
    except Exception as exc:
        raise HTTPException(502, detail=str(exc)) from exc


@app.get("/api/v1/config")
async def public_config():
    return {
        "ok": True,
        "spot_default": True,
        "auto_execution": SETTINGS.auto_execution,
        "live_trading": SETTINGS.allow_live_trading,
        "futures_enabled": SETTINGS.allow_futures,
        "scan_interval_sec": SETTINGS.scan_interval_sec,
        "min_quote_volume": SETTINGS.min_quote_volume,
        "stage1_limit": SETTINGS.stage1_limit,
        "stage2_limit": SETTINGS.stage2_limit,
        "risk_pct": SETTINGS.risk_pct,
        "max_notional_usdt": SETTINGS.max_notional_usdt,
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            await websocket.send_json(STATE.scanner.last_result or {
                "ok": True,
                "status": "warming_up",
                "symbols_live": len(STATE.streams.latest),
                "websocket_connected": STATE.streams.connected,
            })
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass


@app.get("/")
async def root():
    return {"app": "RadarX", "backend": "0.1.0", "ok": True, "docs": "/docs"}
