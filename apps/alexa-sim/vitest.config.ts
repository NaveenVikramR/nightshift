import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws outside Next's react-server build; tests run plain Node.
      'server-only': fileURLToPath(new URL('./test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**', '**/node_modules/**'],
    environment: 'node',
  },
});
