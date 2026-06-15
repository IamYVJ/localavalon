# syntax=docker/dockerfile:1
# ============================================================================
# Avalon authoritative server image.
# Built for linux/arm64 in GitHub Actions (see .github/workflows/server.yml),
# pulled and run on the Raspberry Pi. NEVER built on the Pi itself.
#
# Build context is the REPO ROOT (so the shared engine in js/ is reachable):
#   docker build -f server/Dockerfile -t avalon-server .
# ============================================================================

# ---- deps: install production node_modules in isolation --------------------
FROM node:20-alpine AS deps
WORKDIR /app/server
COPY server/package.json ./
# No lockfile committed yet, so use `npm install`. The single dep (ws) is pinned
# exactly in package.json for reproducibility. Commit a package-lock.json and
# switch to `npm ci` if you want fully locked installs.
RUN npm install --omit=dev --no-audit --no-fund

# ---- runtime ---------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ARG APP_VERSION=dev
ENV NODE_ENV=production
ENV PORT=9000
ENV APP_VERSION=${APP_VERSION}

# Shared game engine — only the three modules the server actually imports.
COPY js/state.js js/rules.js js/stats.js ./js/
# Server source.
COPY server ./server
# Production dependencies from the deps stage.
COPY --from=deps /app/server/node_modules ./server/node_modules

EXPOSE 9000
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:9000/health || exit 1

CMD ["node", "server/index.js"]
