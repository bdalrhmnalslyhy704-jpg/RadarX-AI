# RadarX Backend — Railway deployment

This document prepares the existing Node.js/WebSocket backend for manual Railway deployment.

## Safety invariants

- paper_trading=true
- real_order_execution=false
- confidence_score=UNKNOWN
- Binance Public REST API only
- No Binance API key or secret
- No buy, sell, cancel, or withdrawal endpoints
- No persistent disk is required

## Repository and branch

Repository: bdalrhmnalslyhy704-jpg/RadarX-AI

Branch: phase3-railway-public-runtime

Backend root: backend-node

## Manual Railway settings

1. Create a new Railway project.
2. Choose Deploy from GitHub repo and connect the RadarX-AI repository.
3. Select branch phase3-railway-public-runtime.
4. Set the service Root Directory to /backend-node.
5. Keep the detected Dockerfile builder.
6. No environment secrets are required.
7. Generate a Railway public domain.
8. Set Healthcheck Path to /healthz.
9. Do not add a volume or database.
10. Keep deployment in the Free/Trial plan until its limits are understood.

The server already binds to 0.0.0.0 and reads PORT from the environment.

## Public endpoints after a successful deployment

HTTPS API:
https://<railway-domain>/api/signal?symbol=BTCUSDT

Health:
https://<railway-domain>/healthz

Readiness:
https://<railway-domain>/readyz

WebSocket:
wss://<railway-domain>/ws?symbol=BTCUSDT

The browser must use HTTPS and WSS when the frontend is served over HTTPS.

## Important free-plan limitation

Railway's current Free plan is $0/month with $1 of monthly resource credit. A new account gets a one-time $5 trial grant for up to 30 days. Resource usage is metered, including memory while the service is running. If the available credit is exhausted, Railway stops workloads rather than silently charging the Free plan.

A continuously running WebSocket backend may exceed the $1 monthly Free allowance. Continuous 24/7 operation after the free allowance therefore requires a paid plan.

## Cost after the free allowance

Railway Hobby is $5/month and includes $5 of resource-usage credit. Usage above that amount is billed at the published resource rates. A paid subscription requires a credit card.

Do not add a payment method unless you have reviewed these terms yourself.

## No deployment is performed by this repository change

This file only documents manual deployment. Creating the Railway account, project, service, domain, or billing connection is a separate user action.
