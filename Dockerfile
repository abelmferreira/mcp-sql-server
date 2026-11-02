# syntax=docker/dockerfile:1

# Node major used by every stage. Must satisfy "engines" in package.json.
ARG NODE_VERSION=22

# ---------- Build stage ----------
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app

# All dependencies (dev included) exactly as pinned in the lockfile.
# --ignore-scripts: "prepare" would run the build before the sources are
# copied (we build explicitly below); it also skips the optional native addon
# of ssh2 (cpu-features), which ssh2 does not need.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- Test stage (docker build --target test .) ----------
# Unit tests only; the real SQL Server tests are skipped without TEST_MSSQL_SERVER.
FROM builder AS test
COPY vitest.config.ts ./
COPY tests ./tests
RUN npm test

# ---------- Production dependencies ----------
FROM node:${NODE_VERSION}-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---------- Runtime stage ----------
FROM node:${NODE_VERSION}-alpine AS runtime

# OCI metadata. In CI docker/metadata-action sets these labels as well (and
# wins); the build args let local builds fill them in too.
ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE=https://github.com/abelmferreira/mcp-sql-server
LABEL org.opencontainers.image.title="mcp-sql-server" \
      org.opencontainers.image.description="MCP server for SQL Server with read-only mode, built-in SSH tunnel and .env support." \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.url="${SOURCE}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="Abel Ferreira"

ENV NODE_ENV=production
WORKDIR /app

# Files stay owned by root (read-only for the runtime user), so the process
# cannot change its own code.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY package.json ./

# Unprivileged "node" user (uid/gid 1000) shipped with the base image.
# A private key mounted read-only for the SSH tunnel must be readable by this
# uid; if the host file is 0600 and owned by another uid, run with
# --user "$(id -u):$(id -g)".
USER node

# MCP talks over stdio: run with `docker run -i`. No port is exposed.
ENTRYPOINT ["node", "build/index.js"]
