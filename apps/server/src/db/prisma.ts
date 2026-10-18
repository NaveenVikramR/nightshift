import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';

export type Db = PrismaClient;

/**
 * Startup reachability check with plain `pg`, BEFORE Prisma is created: with
 * Prisma 7.10 + adapter-pg, a query against a refused port never settles and
 * blocks the event loop (FL-15). Resolves, or rejects within `timeoutMs`.
 */
export async function probeDatabase(databaseUrl: string, timeoutMs = 10_000): Promise<void> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Prisma 7 uses a driver adapter; the connection string comes from config, never code. */
export function createPrismaClient(databaseUrl: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}
