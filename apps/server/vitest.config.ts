import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Live-stack tests run only via `npm run test:integration` (vitest.integration.config.ts).
    exclude: ['test/integration/**', '**/node_modules/**'],
    environment: 'node',
  },
});
