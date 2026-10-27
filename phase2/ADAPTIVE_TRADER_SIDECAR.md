# RadarX Adaptive Trader Sidecar — Build 224

The Adaptive Trader is a sidecar beside the existing RadarX system. Its scanner, execution ledger, and learning records remain separate from the twelve existing radar implementations and twenty-analyst review path.

## Scanner and learning

- Market data: Binance Spot public REST; eligible USDT spot symbols only, excluding leveraged tokens.
- Analysis uses contiguous closed 15-minute candles, relative volume and trade-count acceleration, taker-buy flow, close location, higher-low/local breakout structure, volatility compression, one-hour movement, and relative strength versus BTC.
- The scanner ranks 40/80/120 highest-volume eligible symbols per requested scan. It does not claim full-market coverage unless the response says the scan is complete.
- A separate five-minute worker stores observed price/feature samples and labels them after four hours: UP at +2% or more, DOWN at -2% or less, otherwise FLAT.
- Market-sample calibration waits for at least 30 resolved observations and sufficient feature buckets, then adjusts ranking scores by at most four points. The server also maintains a separate paper portfolio, with up to three positions, modeled take-profit/stop-loss/time exits, and transaction-cost estimates. Realized outcomes from paper closes are checked independently from observed market moves. Before a LIVE configuration can send a new mainnet buy, it must pass at least 100 closed server-side paper trades, a win rate of at least 55%, positive total net PnL, and maximum realized drawdown no greater than 8%, in addition to at least 100 resolved market outcomes. These are conservative readiness gates, not proof of future profitability. The controller separately calibrates from confirmed real sells after a sufficient outcome sample; neither calibration rewrites code or changes the original radar rules.

## Execution modes

The default is **PAPER_ONLY**. The scanner and worker make no trade requests unless live execution is explicitly configured on the backend. The Android client never receives exchange API secrets.

To request live execution, the backend environment must explicitly configure all of these values:
- `RADARX_ADAPTIVE_TRADER_LIVE_ENABLED=true`
- `RADARX_ADAPTIVE_TRADER_NETWORK=LIVE`
- `RADARX_ADAPTIVE_TRADER_LIVE_CONFIRMATION=RADARX_SPOT_LIVE_TRADING_CONFIRMED`
- `BINANCE_SPOT_API_KEY` and `BINANCE_SPOT_API_SECRET`
- `RADARX_ADAPTIVE_TRADER_MAX_ORDER_USDT` between 6 and 25
- `RADARX_ADAPTIVE_TRADER_DAILY_LOSS_LIMIT_USDT` between 1 and 5

For exchange testing, use `RADARX_ADAPTIVE_TRADER_NETWORK=TESTNET` with testnet-specific credentials. Never use mainnet credentials in a test environment.

The Binance key must be IP-restricted, permit Spot trading, and have withdrawals, futures, and margin disabled. Preflight checks fail closed when those permissions cannot be verified. Do not put secrets in the APK, repository, client-side storage, logs, or chat. Use the hosting provider's secret/environment-variable interface only.

## Live order controls

- Only one tracked position at a time; at most two entries per UTC day.
- An eligible entry requires a fresh live snapshot, closed/contiguous candles, early-setup classification, calibrated score of at least 75, at least 100 resolved market outcomes, a passing server-side paper-trade validation profile, strong volume/trade acceleration, positive taker-buy flow, BTC-relative strength, and anti-chase/day/hour movement gates.
- Each order is capped at the configured 6–25 USDT maximum, and the code leaves a small USDT reserve. Actual Binance symbol filters and account balance are checked before an entry.
- The controller sends a Spot market buy with a stable client-order ID, records the intent before the request, and avoids resubmitting orders whose result is uncertain.
- After a confirmed fill it requests an exchange-managed OCO exit: an approximate +3% take-profit limit and a -2% stop-loss market leg. Binance maintains those exit legs at the exchange rather than depending on an Android screen or each five-minute scan.
- If OCO placement is definitively rejected, it attempts one emergency market sell and halts. If the order result is uncertain, it does not blindly duplicate the order; trading is halted for reconciliation.
- A daily realized-loss limit halts new entries. A kill switch is available with `RADARX_ADAPTIVE_TRADER_KILL_SWITCH=true`.
- The OCO trigger values are not guaranteed execution prices. Gaps, spread, commissions, partial fills, outages, API permission changes, and exchange rejects can still cause losses or require manual reconciliation.

## Validation boundaries

CI tests validate scoring gates, market and trade-learning gates, paper validation criteria, signed-request construction, exchange permission checks, risk caps, idempotency behavior, emergency recovery, persistent paper history, and the paper-only default. Testnet execution and a deployment with actual credentials must be verified separately. Passing software tests does not establish trading profitability, and historical market outcomes do not guarantee future returns.
