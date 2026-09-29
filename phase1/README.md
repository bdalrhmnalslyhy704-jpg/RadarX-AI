# RadarX Phase 1 — Read-Only Strategy Engine

Phase 1 is the new read-only foundation for RadarX. It is intentionally isolated on the branch `phase1-readonly-strategy-engine` so the existing application on `main` remains untouched.

### Included

- Three strategy evaluators:
  - Multi-Timeframe Trend Following
  - Confirmed Breakout with Volume and Liquidity
  - Filtered Mean Reversion
- Real public Binance Spot market-data adapter with endpoint fallback.
- Data-integrity and anti-lookahead guards.
- Liquidity quality, spread and order-book imbalance calculations.
- ATR-based risk levels and multi-TP paper levels.
- Cost-aware net RR model.
- Unified JSON signal contract.
- Signal deduplication.
- Confidence remains UNKNOWN until calibration exists.
- Node test suite using only deterministic TEST_FIXTURE data.

### Safety

This phase has no real order execution, no withdrawal API, and no user-data API. Bearish states are informational Spot alerts (exit/avoid), not short execution.

### Test

Node.js 20+:

```bash
node --test phase1/tests/*.test.mjs
```
