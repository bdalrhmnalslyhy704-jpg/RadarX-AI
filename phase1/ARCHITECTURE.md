# RadarX Phase 1 — Architecture

## Mobile PWA

The phone is a presentation and interaction client. It may read public market-data APIs when online, but it is not the authoritative continuous market monitor.

The PWA:
- renders the read-only dashboard;
- shows connection and data-freshness state;
- displays the last successful update time and data source;
- never labels cached UI or old market values as live;
- is prepared for Push Notifications without requiring a persistent mobile WebSocket.

## Continuous Server Monitoring

The production architecture is:

Public market feeds → server-side collector → normalized time series → feature engine → strategy engine → risk/data gates → alert event → Push provider → phone PWA

The server-side collector is the continuity layer. It can keep monitoring when the browser is closed. The phone should not be required to keep a WebSocket alive for continuous scanning.

## Data Semantics

ONLINE means network connectivity is currently available.

LIVE_DATA means the current scan successfully received fresh market data.

DISCONNECTED means the current market-data request cannot be completed. Cached application files may still load, but cached market values are not treated as live.

last_successful_update and source are displayed separately from live-status state.

## Notifications

Phase 1 does not perform Push delivery. The UI is intentionally ready for a future subscription flow:
PWA subscription → server stores subscription → background scanner emits alert → Push gateway → device notification.

No trading API permission is required for this architecture.

## Security Boundary

Allowed: public market-data APIs, local non-sensitive presentation metadata, and Paper Trading records.

Not allowed: exchange trading keys, withdrawal permission, order creation/cancelation, or user-data trading endpoints.

## Offline Rule

The service worker caches the application shell only. It does not cache exchange market responses. When offline, the app shell opens and shows DISCONNECTED; the last successful update metadata may remain visible, but market values are cleared from the live view.