# syntax=docker/dockerfile:1

# ---- build: install workspace + build api & web ----
FROM node:26-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@12.21.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@kinglet/api --filter=@kinglet/web
# Never let local data/secrets or turbo cache reach the deploy output.
RUN rm -rf apps/api/data apps/api/.turbo
# Production-only tree: dist + drizzle + prod dependencies (no TS, tsx,
# drizzle-kit, sources, or test files).
RUN pnpm --filter @kinglet/api --prod deploy /out/api --legacy

# ---- runtime: one process, one image, non-root ----
FROM node:26-bookworm-slim
ENV NODE_ENV=production
ENV KINGLET_DB_PATH=/data/kinglet.db
WORKDIR /app
COPY --from=build /out/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KINGLET_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]
