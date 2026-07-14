# syntax=docker/dockerfile:1

# ── build: install workspace deps and build the web app ──────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY . .
# Scope the install to the workspaces this image runs: relay + web + the shared
# contract. This skips pi-extension (which pulls the Ericsson-only
# @earendil-works/pi-coding-agent) and pty-host (node-pty) — neither runs here.
# Install from the PUBLIC npm registry (all relay + web deps are public) so a
# plain `docker build` works anywhere, independent of any internal registry.
RUN rm -f package-lock.json \
 && npm install --registry=https://registry.npmjs.org/ --ignore-scripts --no-audit --no-fund --legacy-peer-deps \
    -w @pi-comm/a2a-contract -w @pi-comm/relay -w @pi-comm/web --include-workspace-root
RUN npm run build --workspace @pi-comm/web

# ── runtime: one process = relay + A2A + terminal + the built web (same origin) ─
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    RELAY_PORT=8787 \
    RELAY_WEB_DIR=/app/apps/web/dist
COPY --from=build /app ./
EXPOSE 8787
# The shared bearer token must be supplied at runtime:
#   docker run -e RELAY_TOKEN=<token> -p 8787:8787 pi-comm
CMD ["node", "--experimental-strip-types", "packages/relay/src/index.ts"]
