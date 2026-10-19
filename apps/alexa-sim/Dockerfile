# Simulated Alexa+ (Next.js standalone). Build context: repo root.
#   docker build -f apps/alexa-sim/Dockerfile .
# Runs as the non-root node user; served at /alexa behind Caddy.

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/demo-target/package.json apps/demo-target/
COPY apps/alexa-sim/package.json apps/alexa-sim/
RUN npm ci -w @nightshift/alexa-sim --ignore-scripts --no-audit --no-fund
COPY apps/alexa-sim apps/alexa-sim
RUN npm run build -w @nightshift/alexa-sim

FROM node:24-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
# Standalone output keeps the monorepo layout (outputFileTracingRoot = repo root).
COPY --from=build --chown=node:node /app/apps/alexa-sim/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/alexa-sim/.next/static ./apps/alexa-sim/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/alexa/api/health || exit 1
CMD ["node", "apps/alexa-sim/server.js"]
