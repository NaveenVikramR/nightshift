# Demo payments API (the monitored target in the demo). Build context: repo root.
#   docker build -f apps/demo-target/Dockerfile .
# Node 24 runs the TypeScript sources directly (type stripping): no compile step.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/demo-target/package.json apps/demo-target/
RUN npm ci -w @nightshift/demo-target --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force \
  && mkdir -p apps/demo-target/node_modules

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/demo-target/node_modules apps/demo-target/node_modules
COPY apps/demo-target/package.json apps/demo-target/
COPY apps/demo-target/src apps/demo-target/src
WORKDIR /app/apps/demo-target
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/main.ts"]
