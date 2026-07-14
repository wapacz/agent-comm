# syntax=docker/dockerfile:1

# ── build: install workspace deps and build the web app ──────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY . .
# --ignore-scripts skips node-pty's native build; the relay never spawns PTYs
# (pty-hosts run on the agent machines, not in this image).
RUN npm ci --ignore-scripts
RUN npm run build --workspace @pi-comm/web

# ── runtime: one process = relay + A2A + terminal + the built web (same origin) ─
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    RELAY_PORT=8787 \
    RELAY_WEB_DIR=/app/apps/web/dist
COPY --from=build /app ./
# Drop dev deps (vite, vitest, types); node-pty stays unbuilt and unused here.
RUN npm prune --omit=dev --ignore-scripts || true
EXPOSE 8787
# The shared bearer token must be supplied at runtime:
#   docker run -e RELAY_TOKEN=<token> -p 8787:8787 pi-comm
CMD ["node", "--experimental-strip-types", "packages/relay/src/index.ts"]
