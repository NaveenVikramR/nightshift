import { ConfigError, loadConfig } from './config.js';
import { createApp } from './http/createApp.js';
import { log } from './lib/log.js';
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
  const nightshift = createApp({ config });

  const server = nightshift.app.listen(config.port, config.host, () => {
    log.info('nightshift listening', {
      url: `http://${config.host}:${config.port}/mcp`,
      version: SERVER_VERSION,
      protocol: TARGET_PROTOCOL_VERSION,
    });
  });

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    server.close();
    void nightshift.close().finally(() => process.exit(0));
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
