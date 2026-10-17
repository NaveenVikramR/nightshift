import { HttpAlertmanagerClient } from './clients/alertmanager.js';
import { DeploySourceRouter, GitHubDeploySource, IngestDeploySource } from './clients/deploys.js';
import { HttpPrometheusClient } from './clients/prometheus.js';
import { ConfigError, loadConfig } from './config.js';
import { PrismaAckStore, PrismaSilenceStore } from './db/alertStores.js';
import { PrismaDeployStore } from './db/deployStore.js';
import { PrismaIncidentStore } from './db/incidentStore.js';
import { PrismaPendingActionStore } from './db/pendingActionStore.js';
import { PrismaSecurityStore } from './db/securityStore.js';
import { createPostureScanner } from './domain/posture/index.js';
import { ExecutorRegistry } from './domain/actions/executors/registry.js';
import { createPrismaClient } from './db/prisma.js';
import { PrismaAuditLog } from './db/prismaAuditLog.js';
import { createApp } from './http/createApp.js';
import { log } from './lib/log.js';
import { loadServiceConfig } from './serviceConfig.js';
import { SERVER_VERSION, TARGET_PROTOCOL_VERSION } from './version.js';

function loadDotEnv(): void {
  try {
    process.loadEnvFile(); // Node >= 20.12: reads ./.env if present; real env wins
  } catch {
    // no .env file: rely on the real environment
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  if (config.tokens.length === 0) {
    log.warn('NIGHTSHIFT_TOKENS is empty: every /mcp request will get 401. Run npm run token:new');
  }
  if (!config.databaseUrl) {
    throw new ConfigError('DATABASE_URL is required (audit log). See apps/server/.env.example');
  }
  const db = createPrismaClient(config.databaseUrl);
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    throw new ConfigError("Can't reach the database at DATABASE_URL. Is it running and migrated?");
  }

  const catalog = loadServiceConfig();
  const githubServices = catalog.services.filter((s) => s.deploys?.source === 'github');
  if (githubServices.length > 0 && !config.githubToken) {
    log.warn('GITHUB_TOKEN is not set: deploy history for these services is unavailable', {
      services: githubServices.map((s) => s.name),
    });
  }
  const missing = ExecutorRegistry.missingTokens(catalog, process.env);
  if (missing.length > 0) {
    log.warn('executor token env vars are not set: those actions will be refused', {
      executors: missing,
    });
  }
  const deployStore = new PrismaDeployStore(db);
  const prometheus = new HttpPrometheusClient(catalog.prometheus.url, catalog.prometheus.timeoutMs);
  const nightshift = createApp({
    config,
    deployStore,
    deps: {
      audit: new PrismaAuditLog(db),
      prometheus,
      alertmanager: new HttpAlertmanagerClient(
        catalog.alertmanager.url,
        catalog.alertmanager.timeoutMs,
      ),
      services: catalog.services,
      acks: new PrismaAckStore(db),
      silences: new PrismaSilenceStore(db),
      deploys: new DeploySourceRouter({
        ingest: new IngestDeploySource(deployStore),
        github: new GitHubDeploySource(
          catalog.github.apiUrl,
          config.githubToken,
          catalog.github.timeoutMs,
        ),
      }),
      incidents: new PrismaIncidentStore(db),
      executors: ExecutorRegistry.fromConfig(catalog, process.env),
      pendingActions: new PrismaPendingActionStore(db),
      security: new PrismaSecurityStore(db),
      posture: createPostureScanner({
        security: catalog.security,
        services: catalog.services,
        prometheus,
        githubApiUrl: catalog.github.apiUrl,
        githubToken: config.githubToken,
        now: () => new Date(),
      }),
      timeZone: catalog.display.timeZone,
    },
  });
  log.info('service catalog loaded', {
    services: catalog.services.map((s) => s.name),
    prometheus: catalog.prometheus.url,
    alertmanager: catalog.alertmanager.url,
    timeZone: catalog.display.timeZone,
    ingestSources: config.ingestTokens.map((t) => t.source),
  });

  const server = nightshift.app.listen(config.port, config.host, () => {
    log.info('nightshift listening', {
      url: `http://${config.host}:${config.port}/mcp`,
      version: SERVER_VERSION,
      protocol: TARGET_PROTOCOL_VERSION,
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    log.error('http server error', { code: err.code, error: err.message });
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    server.close();
    void nightshift
      .close()
      .then(() => db.$disconnect())
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  log.error(err instanceof ConfigError ? err.message : 'startup failed', {
    error: err instanceof Error && !(err instanceof ConfigError) ? err.message : undefined,
  });
  process.exit(1);
});
