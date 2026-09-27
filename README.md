# RadarX AI

RadarX Ultimate 5.1 — live crypto market radar.

## Included
- `index.html` — app entry point
- `RadarX_Ultimate_5.1.js` — main app engine
- `RadarX_Ultimate_5.1.css` — UI stylesheet
- `RadarX_ProEngine_5.1.js` — multi-layer pre-breakout engine
- `manifest-5.1.webmanifest` — PWA manifest
- `radarx-sw-5.1.js` — service worker / notification bridge
- `.github/workflows/pages.yml` — GitHub Pages deployment

The app uses Binance public market data paths with resilient WebSocket/REST/cache/offline handling. It does not embed private API keys.

## GitHub Pages
In the repository settings, set Pages → Build and deployment → Source to **GitHub Actions**. The included workflow deploys the repository on pushes to `main`.
