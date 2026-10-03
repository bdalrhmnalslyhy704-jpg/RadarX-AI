FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY phase1/ ./phase1/
COPY phase2/ ./phase2/

ENV NODE_ENV=production
ENV RADARX_HOST=0.0.0.0

CMD ["npm", "start"]
