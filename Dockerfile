# syntax=docker/dockerfile:1

# ---- build stage: install workspace + build api & web ----
FROM node:26-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10.15.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY drizzle ./drizzle
RUN pnpm install --frozen-lockfile || pnpm install
COPY turbo.json ./
RUN pnpm exec turbo run build --filter=@kinglet/api --filter=@kinglet/web

# ---- runtime: one process, one image ----
FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
