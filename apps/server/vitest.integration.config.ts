import { defineConfig } from 'vitest/config';

/** Runs against the live docker stack (npm run stack:up). Not part of `npm test`. */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 360_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
