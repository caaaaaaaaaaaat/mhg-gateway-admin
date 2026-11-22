# SPDX-License-Identifier: GPL-3.0-or-later
# syntax=docker/dockerfile:1
#
# Multi-stage image for mhg-gateway-admin.
#
# Why multi-stage: the runtime never needs a package manager, a compiler or the
# npm cache. Stage 1 only resolves the optional MySQL driver (mysql2 is the single
# runtime dependency, and it is optional so a SQLite-only deployment can skip it).
# Stage 2 is a small Node runtime with the sources and the resolved modules.
#
# Node 22 is required for node:sqlite (the built-in SQLite driver). node:22-bookworm-slim
# is pinned by digest in production builds; the tag is kept readable here.

# ---------------------------------------------------------------------------
# Stage 1: dependencies
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps

WORKDIR /build

# Only the manifest is needed to resolve node_modules, so the layer caches
# independently of source changes.
COPY package.json package-lock.json* ./

# mysql2 is an optionalDependency: a full install gets it (so the same image can
# talk to MySQL by changing config), while `--omit=dev` keeps the tree minimal.
# `npm ci` is used when a lockfile exists, otherwise `npm install`.
RUN if [ -f package-lock.json ]; then \
        npm ci --omit=dev --no-audit --no-fund; \
    else \
        npm install --omit=dev --no-audit --no-fund; \
    fi \
    && npm cache clean --force \
    && rm -rf /root/.npm

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="mhg-gateway-admin" \
      org.opencontainers.image.description="MHXX/MHGU crossplay gateway batch management console" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/caaaaaaaaaaat/MHXX-GU-Gateway"

ENV NODE_ENV=production \
    MHGA_HOST=0.0.0.0 \
    MHGA_PORT=8720 \
    MHGA_DB_DRIVER=sqlite \
    MHGA_SQLITE_PATH=/data/mhg-gateway-admin.db \
    MHGA_RUNTIME_DIR=/data/rooms \
    MHGA_LOG_LEVEL=info

# tini reaps zombies: the console spawns gateway children, and a PID-1 node
# process does not reap orphans, which would slowly accumulate defunct entries.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a source edit does not invalidate the module layer.
COPY --from=deps /build/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY config/docker.json ./config.json
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data/rooms /app/bin \
    && chown -R node:node /data /app

# The container runs as the unprivileged `node` user. Gateway children inherit it,
# so a gateway port below 1024 needs an explicit change of user; the defaults in
# config.json stay above 1024 for exactly that reason.
USER node

# 8720 is the console; the gateway UDP ports in the default pools are exposed
# range-wise in the docs. Declaring them keeps `docker run -P` useful for the
# console only, which is the common case.
EXPOSE 8720

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.MHGA_PORT||8720)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
