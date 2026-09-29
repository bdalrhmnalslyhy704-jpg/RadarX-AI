# RadarX Phase 1 — Technical Specification

## Scope

Read-only Binance Spot public market analysis plus Paper Trading. No live order execution, no withdrawals, no user-data APIs.

## Strategy 1 — Multi-Timeframe Trend Following

- Regime: 4H
- Setup: 1H
- Trigger: 15m
- EMA: 20/50/100/200
- ADX: 14, minimum 20 by default
- ATR: 14
- Long requires 4H bullish regime, 1H alignment, controlled pullback within 1.5 ATR, and structure/trigger confirmation.
- Bearish state is informational in Spot and means exit/avoid, not short execution.
- Stop: structural swing low or ATR-based protection with buffer.
- Minimum net RR: 1.5 after known costs; unknown costs keep RR UNKNOWN and risk filter FAIL.

## Strategy 2 — Confirmed Breakout with Volume and Liquidity

- Trigger timeframe: 15m
- Context: 4H/1H
- Support/resistance: prior Donchian 20, with confirmed swing levels as an extension point
- Breakout buffer: 0.10 ATR
- RVOL threshold: 1.50
- Volume acceleration: 5-volume average / 20-volume average >= 1.15
- Spread ceiling: 20 bps
- Liquidity Quality floor: 60
- Order-book imbalance is supporting evidence, not a standalone signal.
- Fakeout rejection: wick-only break, weak volume, adverse spread/depth, or return inside range.
- Confirmed state requires a valid closed candle.

## Strategy 3 — Filtered Mean Reversion

- Context: 4H
- Setup: 1H
- Trigger: 15m
- RSI: 14; oversold 30, overbought 70
- Bollinger Bands: 20, 2 standard deviations
- EMA200 and ADX are regime filters
- ATR: 14
- Long requires oversold + lower-band touch + non-strong-bear regime + reversal evidence + liquidity pass.
- Panic-selling filter blocks entries when RVOL is very high and the bearish candle body dominates the range.
- Bearish state is informational in Spot and means exit/avoid, not short execution.

## Common Rules

1. No entry from an incomplete candle.
2. No future data.
3. No invented values; missing critical values are UNKNOWN.
4. No production Mock data. Test fixtures are marked TEST_FIXTURE.
5. No trade API keys or trading endpoints.
6. Scores are heuristic evidence scores.
7. Confidence is UNKNOWN until calibrated from out-of-sample outcomes.
8. Correlated indicators are grouped so they do not receive independent full weights.
9. Signal deduplication uses symbol + strategy + direction + trigger candle close time.
10. Public data-source failure prevents risky signals instead of converting failure to zero-valued market data.
11. A known fee/slippage model is required before Risk Filter can PASS for an actionable signal.

## Data Quality

The engine validates OHLC relationships, ordering, gaps, duplicates, stale data and future-data violations. A critical integrity failure blocks a risky signal.

## Cost Model

For a long paper trade:

- entry slippage moves fill upward;
- exit slippage moves fill downward;
- entry and exit fees are charged separately;
- RR is evaluated on net PnL when fee rate and slippage are known.

## Confidence Calibration

Raw strategy scores are not treated as probabilities. A calibration mapping must be trained only with historical observations that were available at decision time, evaluated out-of-sample, and withheld from tuning. Until enough samples exist, confidence is UNKNOWN.
