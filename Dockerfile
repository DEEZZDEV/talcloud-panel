# syntax=docker/dockerfile:1

# ── Frontend ──
FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY shared ./shared
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --no-audit --no-fund
COPY web ./web
RUN cd web && npm run build

# ── Backend ──
FROM node:22-bookworm-slim AS server
# Outils de compilation : uniquement utilisés si un module natif n'a pas de binaire précompilé.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY shared ./shared
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --no-audit --no-fund
COPY server ./server
RUN cd server && npm run build && npm prune --omit=dev

# ── Image finale ──
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIST_DIR=/app/web/dist
WORKDIR /app/server
COPY --from=server /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY --from=server /app/server/package.json ./package.json
COPY --from=web /app/web/dist /app/web/dist
RUN mkdir -p /data && chown node:node /data
# Le panel ne tourne jamais en root.
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
