import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const here = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Served at https://<domain>/alexa behind Caddy (and http://127.0.0.1:3002/alexa locally).
  basePath: '/alexa',
  output: 'standalone',
  // Monorepo: dependencies are hoisted to the repo root.
  outputFileTracingRoot: join(here, '..', '..'),
  poweredByHeader: false,
  reactStrictMode: true,
  // Security headers for everything this app serves; pages also get a nonce CSP from proxy.ts.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Permissions-Policy',
            value: 'microphone=(self), camera=(), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
