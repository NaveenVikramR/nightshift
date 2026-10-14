/**
 * Seed demo data. Stub for now: incidents, scans and findings arrive with
 * their features. Run with `npm run seed` (needs DATABASE_URL).
 */
import { loadConfig } from '../src/config.js';
import { createPrismaClient } from '../src/db/prisma.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file
}

const { databaseUrl } = loadConfig();
if (!databaseUrl) {
  console.error('DATABASE_URL is not set (apps/server/.env).');
  process.exit(1);
}

const db = createPrismaClient(databaseUrl);
try {
  const audits = await db.auditLog.count();
  console.log(`Seed stub: database reachable (${audits} audit rows). Nothing to seed yet.`);
} finally {
  await db.$disconnect();
}
