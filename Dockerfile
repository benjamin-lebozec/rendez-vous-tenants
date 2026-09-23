FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    CONFIG_PATH=/app/config/config.yaml \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
# modèle utilisé pour créer config.yaml au premier démarrage s'il n'existe pas
COPY config/config.example.yaml ./config.example.yaml

RUN mkdir -p /data /app/config && chown node:node /data /app/config
USER node
VOLUME ["/data", "/app/config"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "src/server.js"]
