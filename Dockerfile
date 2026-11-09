# syntax=docker/dockerfile:1
# The IMAP Source as a plugin container (ADR-0001 of Family Agenda).
#   docker build -t family-agenda-imap .
FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build

# Node.js has not shipped Corepack since version 25, so it comes from npm. git fetches the kit.
RUN npm install --global corepack@0.36.0 && corepack enable \
  && apt-get update && apt-get install --yes --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Production dependencies only (tsx runs the TypeScript sources): no vitest, no typescript.
RUN pnpm install --frozen-lockfile --prod --store-dir /tmp/store \
  && rm -rf /tmp/store

FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER node
ENV PORT=8080
# Every IMAP connection is tunnelled through the egress proxy that compose.plugins.yaml sets in HTTPS_PROXY.
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/main.ts"]
