# RadarX Build 224 — Radar Specialization Contract

This contract documents what each existing radar is intended to detect, the evidence it uses, and common reasons it must not emit an entry-eligible alert. It does not claim predictive profitability. A radar being registered or having unit tests does not by itself prove that its live signals are useful.

## Required signal contract

Every entry-eligible alert must be explainable in three parts:
1. **Detection:** the particular market pattern this radar specializes in.
2. **Evidence:** the closed-candle, activity, order-flow, liquidity, relative-strength, or multi-timeframe measurements actually used by its analyzer.
3. **No-alert conditions:** missing/stale/gapped data, missing primary trigger, weak confirmation, inadequate liquidity, overextension/fakeout risk, or a cooldown/rate limit.

`WATCH`/watch-only states are monitoring states, not buy recommendations. Spot/paper policy remains `paper_trading=true` and `real_order_execution=false`.

## Existing 12-radar map

| Radar | Specialization / what it detects | Evidence used by the current implementation | Typical no-alert / rejection conditions |
|---|---|---|---|
| 1 — Early Move / Strong-Early Move | Early setup before a stronger move; not a general high-gainer list. | Pre-move fingerprint, compression, acceleration, participation, buy flow, structure, relative-strength and liquidity components. | Weak data/liquidity, late/extended move, insufficient independent confirmation or accepted strategy evidence, cooldown. |
| 2 — Strong Move | Fast, high-participation upward impulse. | Closed 1m/5m candles, flash impulse, volume/trade acceleration, taker flow, structure, data freshness and strict confluence gate. | Stale or incomplete candles, missing impulse/participation evidence, overextension, weak confluence or alert budget. Emergency breakouts are a separately defined path and must remain visible as such. |
| 3 — Rotation Lag / Joker | A coin beginning to rotate relative to the broader market rather than simply copying the market move. | Relative lag/edge, resilience, activation, value acceptance, momentum/flow turns, and persistence. | No relative edge or resilience, weak activation, poor liquidity, extended move or insufficient confirmations. |
| 4 — Liquidity Absorption / Sweeper | Possible absorption: high activity and buy/sell-flow imbalance while price movement remains limited. | Closed 1m/5m candles, volume ratio, taker-buy ratio, local structure, seller recovery, depth imbalance at multiple bands, spread, VWAP/auction balance and 5m confirmation. | Candle gaps/staleness, weak volume/flow, missing or adverse order book, wide spread, insufficient confirmations, low quote volume, or an already-extended 24h move. Flat price alone is not proof of accumulation. |
| 5 — Kahir | Unusual acceleration against the coin's own baseline and the market's speed. | 1m/5m return z-scores, self-history, market velocity, volume/trade ratios, ATR regime shift, efficiency, range acceptance and persistence. | Warm-up/incomplete or stale/gapped candles, single-volume spike without trade participation, weak acceleration/efficiency/persistence, or extended daily move. |
| 6 — Doomsday | Exceptional expansion or ignition, with an explicit early/pre-breakout path distinct from an already-mature pump. | Closed 1m/5m/BTC candles, volume/trade/taker ratios, 3m/5m/10m returns, relative strength, squeeze release, breakout proximity, confirmation streak and anti-chase freshness. | Incomplete/gapped/stale symbol or BTC candles, extended daily move, weak multi-factor evidence, insufficient confirmation bars, failing anti-chase score, cooldown or hourly budget. Delivery must have all gate inputs populated. |
| 7 — Al Muqawim / Resilience | Aligned multi-timeframe trend and, when the market benchmark is available, resilience versus the market median during a drawdown. | 4h/1h/15m closed-candle sequence, HH/HL structure, trendline, moving average, timeframe alignment, entry freshness/timing and market-relative 24h performance. | Insufficient, gapped or stale timeframe candles, higher-timeframe conflict, poor structure, weak timing, overextended entry, or material relative underperformance during a broad market decline. |
| 8 — Early Expansion / Lightning | Quiet base followed by gradually improving activity and a transition into expansion; separates pre-expansion from breakout/extended states. | Closed multi-timeframe candles, volatility compression/expansion, volume/trade trends, taker flow, higher lows, order book/spread, market regime, relative strength, fakeout detection and historical follow-through. A separate continuation confirmation checks a broken level plus sustained activity and buy flow. | Data/freshness/coverage gates fail, weak activity/flow, thin or wide-spread liquidity, recent fakeout, weak historical follow-through, extended movement, or a breakout whose level-hold/continuation evidence is still missing. Watch-only alerts are not entry signals. |
| 9 — Falcon Eye / Hawkeye | Early weak-looking pre-breakout patterns, including a quiet base before activity acceleration. | Closed 1m/5m candles, gap/freshness checks, quietness/compression, higher lows, volume/trades/taker, relative strength vs BTC, spot/futures context when available, activity shock, selection lanes and anti-chase gates. | Incomplete/stale/gapped candles, weak quiet-base/structure/flow/relative strength, overextension, too few confirmations, low score, cooldown, hourly limit or strict notification-gate rejection. Health output includes gate-rejection diagnostics. |
| 10 — Coin Hunter | Early, microstructure-level setup discovery; overlaps relative strength but is not a dedicated replacement for the other radars. | Early-timing fingerprint, micro volume and trade acceleration, taker buy ratio, resistance room, BTC-relative features and similarity score. | Late move, incomplete micro evidence, weak buy flow or resistance room, low score/similarity, insufficient liquidity or notification-gate rejection. |
| 11 — Whale Accumulation | Possible persistent large-participant-style accumulation inferred from public market data; it cannot identify a trader's real identity. | Public aggregate trades, book/depth imbalance, persistence across book snapshots, candle activity and multi-factor confirmations. | No depth persistence, incomplete trade/book data, weak accumulation evidence, insufficient confirmations, low liquidity or overextension. This radar is not the false-breakout specialist. |
| 12 — Professor | Cross-source interpretation and risk review rather than another momentum scanner. | Technical deep-scan direction and trap risk, public news/stream claims, evidence types and evidence strength. | Conflicting or unverified claims, weak technical evidence, excessive trap risk, insufficient corroboration; prefer WAIT_CONFIRMATION/WAIT over an entry claim. |

## Proposed roles 10–12: reuse, do not duplicate

- **Relative strength:** already represented in Rotation Lag, Doomsday, Early Expansion, Falcon Eye and Coin Hunter; Al Muqawim now has an explicit market-median comparison. Keep the measurements named and independently testable instead of adding another scanner.
- **False-breakout trap:** Early Expansion has a recent-fakeout guard; Falcon Eye records a false-breakout pattern; Professor applies a trap-risk penalty. The rejection reason must remain visible and tested.
- **Continuation confirmation:** Early Expansion now has a dedicated continuation assessment for an actual broken level: hold/retest, sustained volume, trade count and taker-buy flow. This is a state/gate within an existing radar, not a new radar. Pre-expansion WATCH and PRE_EXPANSION states remain distinct.

## Acceptance evidence required before declaring release readiness

- Exact-head Phase 2 tests, Triple Radar CI (including Android background smoke), and production-aligned integration gates pass.
- Live health shows all registered radars running with recent cycles and no stale/missing data gates.
- Per-radar telemetry makes accepted/rejected candidate counts and top rejection reasons available.
- Historical outcome reports distinguish complete trade-history replay from candle-only fallback. Test success and signal detection alone are not proof of profitable performance.
