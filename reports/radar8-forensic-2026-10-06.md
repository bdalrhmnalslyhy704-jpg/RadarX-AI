# Radar 8 — البرق: Miss / Forensic Analysis — 2026-10-06

## Baseline
- Official base: Build 224
- Build 224 base commit: `c8d12d6f217aeedd628c22350965d4efd321080a`
- Development branch: `feature/build224-radar8-early-expansion-20261006`
- Paper only: `paper_trading=true`
- Real execution: `real_order_execution=false`
- `confidence_score=UNKNOWN`

## Method
Historical Binance Spot USDT public REST Klines were replayed with closed candles only at 24h, 12h, 6h, 3h, 1h, 15m and 5m before each derived move anchor.

The replay deliberately does NOT fabricate historical order-book, spread, news, listing or Futures snapshots. Those are recorded as unavailable where no historical source exists.

The derived anchor is the earliest closed 1m candle before the observed local peak satisfying a forward 1h/4h expansion threshold while avoiding an already-large prior 1h move. This is a forensic definition, not a claim that Binance provides a canonical “move start”.

## Named cases

| Symbol | Derived anchor UTC | Peak UTC | Observed run from anchor | Earliest partial evidence |
|---|---|---|---:|---:|
| RLCUSDT | 2026-10-05 16:30 | 2026-10-06 11:06 | +91.06% | 2026-10-04 19:55, score 75.8 |
| RADUSDT | 2026-10-05 14:46 | 2026-10-06 06:24 | +65.78% | 2026-10-04 16:06, score 74.0 |
| ORCAUSDT | 2026-10-05 17:23 | 2026-10-06 11:31 | +39.24% | 2026-10-04 17:38, score 73.4 |
| API3USDT | 2026-10-05 15:16 | 2026-10-06 07:52 | +39.29% | 2026-10-04 23:11, score 72.7 |
| DIAUSDT | 2026-10-05 14:46 | 2026-10-06 11:24 | +16.46% | 2026-10-04 19:16, score 72.0 |
| OGNUSDT | 2026-10-05 16:09 | 2026-10-06 10:32 | +2.32% | 2026-10-04 21:04, score 73.7 |
| UMAUSDT | 2026-10-05 22:23 | 2026-10-06 09:20 | +15.80% | 2026-10-05 01:43, score 73.2 |

### Important OGN note
The supplied observation (~+15%) is a 24h rolling-gain observation, while the derived anchor/peak definition is a local forward-expansion event. OGN therefore does not qualify as a clean +15% forward-peak case under this forensic definition. It is explicitly retained rather than being forced into a matching explanation.

## Repeating pre-move evidence
Across the named cases, the replay repeatedly found combinations of:
- short-horizon RVOL acceleration,
- quote-volume acceleration,
- compression/BB expansion,
- proximity to local resistance,
- higher-low structure,
- taker buy pressure,
- VWAP reclaim/acceptance,
- ATR expansion,
- positive DI/ADX,
- constructive RSI/MACD/OBV,
- supportive BTC regime.

The strongest repeated pattern is not one indicator; it is a multi-signal transition from compression/quiet activity into participation and structure improvement.

## Why the seven existing systems can miss
Historical alert emission cannot be reconstructed from stored Klines alone, so exact “this radar should have fired” claims are not made.

Static code audit identifies structural miss risks:
- Legacy market ranking uses 24h volume/trades and 24h change before deep analysis, which is inherently late for quiet pre-move coins.
- Deep-candidate caps mean full-market pre-move coverage is not guaranteed.
- Some discovery scores reward positive 24h movement, which biases toward already-moving symbols.
- Liquidity-absorption logic needs historical order-book states that public Klines do not contain.
- Professor is an intelligence/news fusion radar, not a universal microstructure scanner.
- WebSocket 451 cannot be treated as the sole market feed; Radar 8 therefore uses REST polling independently.

No claim is made that every miss was caused by WebSocket 451, stale gates, universe exclusion, or another single cause without a historical alert trace.

## Radar 8 structural response
Radar 8 now:
1. builds the active Spot USDT universe from exchangeInfo;
2. fast-scans every eligible ticker each cycle instead of using a top-20 market ranking;
3. maintains per-symbol short-horizon self-baselines for price, quote-volume and trade acceleration;
4. selects both fast accelerators and a quiet reserve for deep scanning;
5. deep-scans 1m/5m/15m/1h/4h plus live order book only for those candidates;
6. blocks live scoring on stale/future/gap/insufficient-candle data, weak liquidity, wide spread and already-extended moves;
7. stores alert trace/history and applies cooldown/deduplication;
8. remains background-capable on the existing backend service.

## Validation limits
- The seven named cases all produced a derived anchor.
- The seven named cases all produced partial historical evidence before their derived anchor.
- Historical order-book and historical spread evidence: UNAVAILABLE from Binance public Klines.
- True precision/recall/false-positive rate is NOT claimed from seven positive cases alone.
- A larger time-split control sample is required for production calibration and any success-rate claim.

This report is evidence-first. Unknown historical evidence remains unknown.
