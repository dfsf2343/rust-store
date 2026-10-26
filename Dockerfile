# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain in case better-sqlite3 has no prebuilt binary for this platform (for example ARM64).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json server/
RUN npm --prefix server ci
COPY web/package.json web/package-lock.json web/
RUN npm --prefix web ci
COPY server server
COPY web web
COPY config config
RUN npm --prefix web run build \
  && npm --prefix server run build \
  && npm --prefix server prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    CONFIG_DIR=/app/config \
    WEB_DIST_DIR=/app/web/dist
WORKDIR /app
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY config config
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
WORKDIR /app/server
CMD ["node", "dist/index.js"]
