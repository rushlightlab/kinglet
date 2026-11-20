# syntax=docker/dockerfile:1

# ---- build: install workspace + build api & web ----
FROM node:26.13.1-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@12.21.0

# Dependency layer: copy only manifests so source edits do not invalidate install.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/sdk-node/package.json packages/sdk-node/package.json
COPY packages/mcp/package.json packages/mcp/package.json
RUN --mount=type=cache,id=kinglet-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages
RUN --mount=type=cache,id=kinglet-turbo-cache,target=/app/.turbo \
    pnpm exec turbo run build --filter=@kinglet/api --filter=@kinglet/web

# Production-only tree: dist + drizzle + prod dependencies (no TS, tsx,
# drizzle-kit, sources, or test files).
RUN --mount=type=cache,id=kinglet-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @kinglet/api --prod deploy /out/api --legacy

# ---- runtime: one process, one image, non-root ----
FROM node:26.13.1-bookworm-slim
ENV NODE_ENV=production
ENV KINGLET_DB_PATH=/data/kinglet.db
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /out/api ./apps/api
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KINGLET_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]
