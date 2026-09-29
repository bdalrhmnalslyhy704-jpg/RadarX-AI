# Install RadarX Phase 1 on a Phone

## Android (Chrome)

1. Open the hosted RadarX Phase 1 page over HTTPS.
2. Load it once while online.
3. Open the browser menu.
4. Choose Install app or Add to Home screen (wording varies by browser/device).
5. Confirm installation.
6. Launch RadarX from the Home screen.

## iPhone / iPad (Safari)

1. Open the hosted RadarX Phase 1 page over HTTPS in Safari.
2. Tap Share.
3. Choose Add to Home Screen.
4. Confirm the name and add it.
5. Open RadarX from the Home Screen.

## Important

- HTTPS hosting is required for service-worker deployment in normal browsers.
- The first successful online load caches the application shell for offline reopening.
- Offline mode does not invent, refresh, or silently reuse market data as live data.
- Last successful update is historical metadata only.
- Push Notifications are a future server-side feature; the phone is not expected to maintain a permanent WebSocket.