# DHDTech build-context workaround for RadarX Build 224.
# This file lives in backend-node/ so the platform can select that folder
# as the build context even when its picker cannot select the repository root.

FROM node:22-bookworm-slim AS source

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

RUN git clone --depth 1 --filter=blob:none --sparse \
      --branch build224-multi-analyst-20261007 \
      https://github.com/bdalrhmnalslyhy704-jpg/RadarX-AI.git . \
    && git sparse-checkout set --no-cone \
      '/package.json' \
      '/package-lock.json' \
      '/phase1/**' \
      '/phase2/**'

FROM node:22-bookworm-slim

WORKDIR /app

COPY --from=source /src/package.json /src/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=source /src/phase1/ ./phase1/
COPY --from=source /src/phase2/ ./phase2/

ENV NODE_ENV=production
ENV RADARX_HOST=0.0.0.0

CMD ["npm", "start"]
