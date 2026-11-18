# syntax=docker/dockerfile:1

# ---- build stage: install workspace + build api & web ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile || pnpm install
COPY turbo.json ./
RUN pnpm exec turbo run build --filter=@kinglet/api --filter=@kinglet/web

# ---- runtime: one process, one image ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
