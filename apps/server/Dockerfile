# Nightshift MCP server. Build context: repo root.
#   docker build -f apps/server/Dockerfile .
# Stages: build (all deps, prisma generate, tsc; also used for `prisma migrate deploy`)
#         runtime (production deps only, non-root, healthcheck).

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/demo-target/package.json apps/demo-target/
# postinstall runs `prisma generate`, which needs the schema and config.
COPY apps/server/prisma apps/server/prisma
COPY apps/server/prisma7.config.ts apps/server/
RUN npm ci -w @nightshift/server --no-audit --no-fund
COPY apps/server/tsconfig.json apps/server/tsconfig.build.json apps/server/
COPY apps/server/src apps/server/src
RUN npm run build -w @nightshift/server

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/demo-target/package.json apps/demo-target/
RUN npm ci -w @nightshift/server --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
COPY apps/server/config apps/server/config
WORKDIR /app/apps/server
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/index.js"]
