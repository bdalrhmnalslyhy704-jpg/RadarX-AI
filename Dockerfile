# DHDTech Build 224 redeploy trigger: refresh from the pinned Build 224 branch.
# Runtime model code and the persisted TCN-sequence backfill must ship in this image.
# Use the official Node.js 22 slim image directly. The ECR Public mirror has
# returned 429 Data limit exceeded in CI; this is the equivalent upstream image.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY phase1/ ./phase1/
COPY phase2/ ./phase2/

ENV NODE_ENV=production
ENV RADARX_RADARS_AUTOSTART=true
ENV RADARX_HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

# Boot with safe read-only defaults on hosts that provide no environment panel values.
CMD ["sh", "phase2/deploy/dhdtech-entrypoint.sh"]
