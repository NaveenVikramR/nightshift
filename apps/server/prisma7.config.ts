// Prisma 7.10 looks for prisma7.config.ts first (prisma.config.ts is the legacy name).
import { defineConfig } from 'prisma/config';

try {
  process.loadEnvFile(); // apps/server/.env, if present; real env vars win
} catch {
  // no .env file
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
