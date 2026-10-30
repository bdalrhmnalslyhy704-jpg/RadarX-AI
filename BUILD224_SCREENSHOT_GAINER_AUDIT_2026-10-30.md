# Build 224 — Screenshot Gainer Missed-Mover Audit
**Audit date:** 2026-10-30  
**Scope:** Binance Spot USDT symbols supplied in the user's two gainers screenshots.  
**Branch:** `build224-multi-analyst-20261007` lineage; proposed fix branch `build224-screenshot-gainer-watch-lanes-20261030`.  
**Policy:** Spot public-market monitoring only; `paper_trading=true`; `real_order_execution=false`. No order placement.

## Executive finding

The previous Pre-Move run did complete scans, but it produced **zero eligible watch notifications and zero push send attempts**. This is not a case of FCM silently dropping a batch of alerts: the previous background snapshot reported 5 watch candidates evaluated, 0 eligible, 5 rejected, and notification delivery `send_calls=0`.

The old design had two material blind spots:
1. The notification-only early-flow corridor capped the one-hour return at +2.5%. The historical NIL snapshot at roughly 60 minutes before its run-up had a +3.63% one-hour return and otherwise showed a credible participation burst, so the watch gate rejected it as too advanced.
2. The standard 24h quote-volume floor of 750,000 USDT blocked PUNDIX and SOLV even though their historical closed-candle snapshots showed pronounced buyer pressure and improving structure. The market-wide discovery lane could still rotate below-floor symbols into review, but the API/push gates did not have a separate, validated low-volume observation class.

Other misses do not have one universal cause: some rises had no buyer-flow precursor in the historical candle window, and some symbols were already substantially extended before the first useful snapshot. A system must not convert every daily gainer into an early alert after the move.

## Historical replay evidence available before this patch

The seven replayed symbols below were reconstructed from Binance Spot closed 5-minute candles. The replay uses only candles closed by each decision timestamp. It does **not** reconstruct historical order-book depth, exact real-time ticker baselines, queue rotation, live push attempts, or physical-device receipt. Therefore it diagnoses gate mismatch and feature evidence; it does not prove that a phone alert would have been sent.

| Pair | Observed move from preceding 4h low | Main pre-move evidence | Historical diagnosis |
|---|---:|---|---|
| PARTIUSDT | +55.91% | At T−60m, 24h return −6.22%, session −6.94%, 1h +12.50%, volume ratio 0.73, trade ratio 0.40, structure 2.5, buying pressure 0 | No qualified precursor at T−60m. By T−30m session was +13.62% and 1h +15.09%; correctly became anti-chase/ALREADY_MOVED. This is a hard prediction case, not evidence to alert late. |
| BEAMXUSDT | +5.18% | T−60m: volume 0.63, trades 0.34, taker-buy 0.28, buyer-flow delta −0.11. Even near T−5m, volume/trades remained subdued and taker-buy was below 0.50. | The replay window shows weak/negative buyer-flow evidence before the short run-up. Do not relabel weak flow as a buy alert; retain as a market-wide miss for future study. |
| SOPHUSDT | +7.19% | Volume/trade ratios expanded to roughly 3.46x/4.06x at T−30m and 5.47x/6.89x at T−15m, but taker-buy stayed around 0.40–0.41, buyer-flow delta was negative, and structure/buying scores remained weak. Reconstructed quote volume was below 500k USDT. | Activity accelerated, but seller-side flow and weak structure did not support a bullish phone alert. It should remain a diagnostic/near-miss, not be promoted to a strong-buyer alert. |
| SOLVUSDT | +5.96% | T−60m: quote volume about 548k USDT, session −2.51%, volume 0.74, trades 0.93, taker-buy 0.616, delta 0.238, structure 76.8, buying pressure 100. | Strong buyer absorption was visible, but the standard 750k volume floor and old session lower bound prevented a useful watch-only alert. Added a narrowly bounded low-volume buyer-absorption lane. |
| LSKUSDT | +28.18% | At T−60m, session was already +25.45% and 24h return about +27.51%; taker-buy was below 0.50 and buyer pressure weak. | Correctly anti-chase. It should be reported as already extended, not advertised as a pre-move opportunity. |
| NILUSDT | +5.53% | T−60m: quote volume about 5.84M USDT, volume 2.48x, trades 2.39x, taker-buy 0.523, delta 0.101, close location 0.794, structure 80.2, buying pressure 73.2, score 63.9, but 1h return +3.63%. | Credible participation and buyer evidence; the old +2.5% one-hour notification ceiling was too narrow. Added a wider but evidence-bounded participation-surge watch tier. |
| PUNDIXUSDT | +5.45% | T−30m: quote volume about 509k USDT, score 76.4, session +3.64%, 1h +2.90%, taker-buy 0.796, delta 0.302, close location 0.843, structure 74, buying pressure 100. | Clear buyer absorption, but below the 750k volume floor and outside the old 1h cap. Added a strict 300k–750k watch-only buyer-absorption corridor. |

## All 13 screenshot symbols

The proposed DHDTech acceptance workflow and API regression test now request all 13 USDT pairs in one bounded historical case-study call:

`PARTIUSDT, BEAMXUSDT, SOXSBUSDT, SOPHUSDT, SOLVUSDT, SKDDBUSDT, LSKUSDT, NILUSDT, PUNDIXUSDT, UVXYBUSDT, KERNELUSDT, SQQQBUSDT, BREVUSDT`.

| Pair | Screenshot category | Screenshot volume shown | Audit state |
|---|---|---:|---|
| PARTIUSDT | Crypto spot | 43.92M | Historical replay above |
| BEAMXUSDT | Crypto spot | 20.31M | Historical replay above |
| SOXSBUSDT | Tokenized security / bStock | 3.62M | Included in the 13-pair regression and live-acceptance audit; new historical DHDTech result pending |
| SOPHUSDT | Crypto spot | 4.06M | Historical replay above |
| SOLVUSDT | Crypto spot | 1.51M | Historical replay above |
| SKDDBUSDT | Tokenized security / bStock | 176,449 | Historical DHDTech result pending; screenshot notional is below the normal 750k USDT floor, and below the new 300k low-volume watch floor if that figure is USDT quote volume |
| LSKUSDT | Crypto spot | 18.13M | Historical replay above |
| NILUSDT | Crypto spot | 6.67M | Historical replay above |
| PUNDIXUSDT | Crypto spot | 2.39M | Historical replay above |
| UVXYBUSDT | Tokenized security / bStock | 176,716.55 | Historical DHDTech result pending; low-volume guard remains in place |
| KERNELUSDT | Crypto spot | 3.07M | Included in the 13-pair regression and live-acceptance audit; new historical DHDTech result pending |
| SQQQBUSDT | Tokenized security / bStock | 222,268.26 | Historical DHDTech result pending; low-volume guard remains in place |
| BREVUSDT | Crypto spot | 1.25M | Included in the 13-pair regression and live-acceptance audit; new historical DHDTech result pending |

**Volume caveat:** the screenshot's displayed volume and the historical API's reconstructed 24h USDT quote volume are not guaranteed to be the same unit or timestamp. The acceptance report must use Binance `quoteVolume` from the actual Spot ticker/candle source before deciding a pair passed or failed a quote-volume threshold.

**bStocks caveat:** SOXSB, SKDDB, UVXYB and SQQQB are tokenized securities rather than ordinary crypto tokens. They are included in the symbol-by-symbol Spot audit, but must remain a separate asset category in analysis; high percentage moves in leveraged/inverse products carry different risk characteristics.

## Patch made on the Build 224 feature branch

1. Added `PARTICIPATION_SURGE_MONITOR`: catches a NIL-like early activity burst with separate participation, closed-candle, quality, liquidity, session and one-hour limits. It is a watch-only message, not an entry.
2. Added `STRONG_BUYER_ABSORPTION_MONITOR`: allows a narrow 300k–750k USDT quote-volume exception only when multiple independent closed-candle buyer/structure checks are strong. The API marks it `low_volume_watch_only=true` and keeps `data_valid=false`; this is not a bypass of the data-valid/entry gate.
3. Applied equivalent independent validation inside PushManager, so a client cannot forge the tier marker to get a push. Stale/future data, poor quality, poor measured liquidity, weak buyer flow and hard risk flags still reject. The new tiers were also added to the final phone-push allowlist; before that last step, eligible observations would remain `WATCH_ONLY_FEED_ONLY`.
4. Added a separate Pre-Move Spot monitoring class for the known bStocks base assets in the screenshots. They remain separate from crypto-altcoin ranking, but the Pre-Move rotation includes them as `asset_class=TOKENIZED_SECURITY`; the label is carried into watch alerts and phone payloads.
5. Added regression tests for NIL-like participation, PUNDIX/SOLV-like low-volume buyer absorption, scanner retention, tokenized-security labeling and push delivery, plus negative cases for stale/weak/low-liquidity data.
6. Expanded the retrospective case-study endpoint from 8 to 16 requested symbols and changed production acceptance to audit all 13 screenshot pairs.

## Acceptance gates before calling this fixed or publishing an APK

- Focused API, scanner, push-policy and 13-symbol case-study tests pass.
- Full Phase 2 regression passes.
- Exact feature-branch commit is merged into `build224-multi-analyst-20261007` and the DHDTech Build 224 deployment reports that exact commit with fresh Binance Spot data.
- DHDTech Pre-Move scan reports non-zero candidates, the new watch-tier decision/rejection counts and actual push delivery attempts where an eligible subscribed device exists.
- The 13-symbol live retrospective audit returns complete closed-candle data and records each symbol's first move and T−60/T−30/T−15/T−5 replay.
- A physical Android device confirms at least one watch-only FCM receipt; provider HTTP success alone is not device receipt.
- Android release workflow completes and publishes a new APK. Until then, no new download URL may be claimed.

This report is a diagnostic engineering artifact. It does not promise every gainer can be predicted, guarantee profitability, or authorize real orders.
