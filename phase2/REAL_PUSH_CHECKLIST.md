# RadarX Phase 2 — Real Push Field Checklist

Use this checklist for staging only. Mark an item complete only after it is observed. CI passing does not count as physical-device Push receipt.

## A. Hosting / security
- [ ] HTTPS certificate is valid and publicly trusted.
- [ ] PWA loads from the HTTPS staging origin.
- [ ] API loads from its HTTPS staging origin.
- [ ] RADARX_ENV=staging.
- [ ] RADARX_STAGING_TEST_PUSH_ENABLED=true only on staging.
- [ ] RADARX_AUTH_SECRET is present in the host secret store and absent from Git.
- [ ] VAPID public/private keys are configured in the host secret store.
- [ ] RADARX_ALLOWED_ORIGINS contains exactly the PWA origin.
- [ ] No Binance API key/secret exists in deployment or frontend.
- [ ] real_order_execution=false.
- [ ] paper_trading=true.
- [ ] confidence_score=UNKNOWN.

## B. Server health
- [ ] GET /healthz returns HTTP 200.
- [ ] GET /readyz returns HTTP 200.
- [ ] monitoring.running=true.
- [ ] WebSocket is LIVE (or configured REST fallback is LIVE).
- [ ] Last completed candle is current enough for the freshness policy.
- [ ] Audit storage is writable and persistent.
- [ ] Process supervisor keeps the service running.

## C. PWA / subscription
- [ ] PWA is installed from HTTPS on the Android phone.
- [ ] Notification permission is requested only after the user taps the enable action.
- [ ] Permission is granted.
- [ ] Authenticated config reports webpush and enabled=true.
- [ ] One staging Push Subscription is visible for the test user.
- [ ] Subscription keys are never returned by the public subscription response.

## D. TEST_PUSH_ONLY — required before live-signal testing
- [ ] Test endpoint call is authenticated.
- [ ] Test endpoint Origin matches RADARX_ALLOWED_ORIGINS.
- [ ] Unauthenticated test call is rejected.
- [ ] Missing/unknown Origin is rejected.
- [ ] Repeating the same test_id inside the dedup window is rejected as duplicate.
- [ ] Audit records show event_class=TEST_PUSH_ONLY.
- [ ] Notification shows exactly: اختبار إشعار فقط — ليس تحليلًا للسوق.
- [ ] Notification contains no numeric confidence.
- [ ] Notification is not labeled LIVE_MARKET_SIGNAL.
- [ ] Test notification click opens Settings, not signal.html.
- [ ] Physical Android phone actually displays the notification.
- [ ] Test audit contains no TEST_FIXTURE marker.

## E. LIVE_MARKET_SIGNAL — real market path
- [ ] TEST_PUSH_ONLY physical receipt passed first.
- [ ] A real completed public Binance candle was observed.
- [ ] Data Quality passed the configured threshold.
- [ ] Liquidity Quality passed the configured threshold.
- [ ] Risk Filter passed.
- [ ] Audit event_class=LIVE_MARKET_SIGNAL.
- [ ] Audit source is a real public source, not TEST_FIXTURE.
- [ ] Audit has valid source_time and processed timestamp.
- [ ] Signal Deduplication is recorded before notification.
- [ ] Notification audit matches the same signal ID.
- [ ] Android received the real market notification.
- [ ] Notification click opens signal.html.
- [ ] signal.html shows the same signal_id.
- [ ] source_time matches the audit record.
- [ ] Browser receipt time is later than source time.
- [ ] confidence_score=UNKNOWN is shown; no numeric confidence appears.
- [ ] paper_trading=true and real_order_execution=false are shown.

## F. iPhone documentation test
- [ ] iPhone/iPadOS version recorded.
- [ ] PWA added to Home Screen from the HTTPS origin.
- [ ] Notification permission requested from direct user interaction.
- [ ] Permission granted for the Home Screen web app.
- [ ] Push Subscription saved by the server.
- [ ] TEST_PUSH_ONLY delivered physically to iPhone, or explicitly marked NOT TESTED.
- [ ] Test notification click opens Settings.
- [ ] LIVE_MARKET_SIGNAL delivered physically to iPhone, or explicitly marked NOT TESTED.

## G. Evidence log
- Staging PWA URL: ______________________________
- Staging API URL: _______________________________
- Android model / browser / version: ____________
- iPhone model / iOS version: ___________________
- Test user: ____________________________________
- TEST_PUSH_ONLY test_id: _______________________
- TEST_PUSH_ONLY received at: ____________________
- LIVE_MARKET_SIGNAL signal_id: _________________
- LIVE_MARKET_SIGNAL received at: _______________
- Notification audit ID(s): ______________________
- Notes / device network: ________________________

## H. Stop and cleanup
- [ ] Stop staging after the field window: sudo systemctl stop radarx-phase2-staging.
- [ ] Disable the test endpoint with RADARX_STAGING_TEST_PUSH_ENABLED=false and restart when appropriate.
- [ ] Use Settings → إيقاف/إلغاء الاشتراك, then verify zero active subscriptions for the staging user.
- [ ] Revoke the staging session token according to the deployment auth procedure.
- [ ] Preserve audit evidence before deleting anything.

## Explicit non-goals
- exchange trading;
- Binance API keys or authenticated exchange user-data access;
- order placement/cancellation;
- withdrawals;
- production deployment;
- merging any staging branch into main.