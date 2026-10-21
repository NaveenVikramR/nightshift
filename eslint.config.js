import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/src/generated/**',
      '**/.next/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: [
      '**/scripts/**',
      '**/prisma/seed.ts',
      'apps/demo-target/src/main.ts',
      'apps/alexa-sim/test/e2e/**',
    ],
    rules: { 'no-console': 'off' },
  },
  {
    // MCP Apps cards: tool data (incl. untrusted alert/commit/advisory text) is only ever
    // inserted as text. Build DOM with el()/svg() from src/ui/view/shared/dom.ts.
    files: ['apps/server/src/ui/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Use el()/textContent: card data is untrusted.' },
        { property: 'outerHTML', message: 'Use el()/textContent: card data is untrusted.' },
        { property: 'insertAdjacentHTML', message: 'Use el(): card data is untrusted.' },
        { object: 'document', property: 'write', message: 'Use el(): card data is untrusted.' },
      ],
    },
  },
  {
    // Landing page script (served by Caddy, runs in the browser).
    files: ['infra/caddy/site/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
      },
    },
  },
  {
    // Playwright e2e: Node script whose page.evaluate callbacks run in the browser.
    files: ['apps/alexa-sim/test/e2e/**'],
    languageOptions: {
      globals: {
        setTimeout: 'readonly',
        URL: 'readonly',
        window: 'readonly',
        document: 'readonly',
      },
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        Response: 'readonly',
      },
    },
  },
);
