FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.mjs engine.mjs ./

ENV NODE_ENV=production

EXPOSE 8080

CMD ["npm", "start"]
