import { createMetrics } from './metrics.ts';
import { createDemoServer } from './server.ts';
import { DemoState } from './state.ts';
import { startTraffic } from './traffic.ts';

const port = Number(process.env['PORT'] ?? 8080);
const host = process.env['HOST'] ?? '0.0.0.0';
const adminToken = process.env['DEMO_ADMIN_TOKEN'] ?? '';
if (adminToken.length < 16) {
  console.error('DEMO_ADMIN_TOKEN must be set (at least 16 characters).');
  process.exit(1);
}

const state = new DemoState();
const metrics = createMetrics();
metrics.updateBreakers(state);
const stopTraffic = startTraffic(state, metrics);
const server = createDemoServer({ state, metrics, adminToken });

server.listen(port, host, () => {
  console.error(JSON.stringify({ msg: 'demo-target listening', host, port }));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopTraffic();
    server.close(() => process.exit(0));
  });
}
