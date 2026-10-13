# syntax=docker/dockerfile:1
# Next.js standalone build: small runtime image, non-root, tini as PID 1.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG VERSION=dev
ENV NEXT_PUBLIC_VERSION=$VERSION
RUN npm run build

FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# Graceful stop (src/instrumentation.ts): on SIGTERM the console refuses new changes and waits up to 25 s for the ones
# in flight. Give the container at least 30 s to stop (ECS stopTimeout, compose stop_grace_period, docker run
# --stop-timeout 30). tini (PID 1) passes the signal on to Node.
ENV NEXT_MANUAL_SIG_HANDLE=true
STOPSIGNAL SIGTERM
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# Demo config (used only with CONSOLE_SOURCE=mock) and the writable SQLite location (mount a volume here, or use Postgres).
COPY --from=build --chown=node:node /app/examples ./examples
RUN mkdir -p /app/data && chown node:node /app/data
ENV CONSOLE_DATA_DIR=/app/data
VOLUME ["/app/data"]
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/healthz >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
