/**
 * POST /alexa/api/demo/{scenario} (responder only) → break or reset the demo
 * service through its token-protected admin API, server-side. Diagnosis and
 * fixes still go through Nightshift.
 */
import type { NextRequest } from 'next/server';
import { isScenario, runScenario } from '@/server/demo';
import { guard, json } from '@/server/http';
import { log } from '@/server/log';
import { runtime } from '@/server/runtime';

export async function POST(req: NextRequest, ctx: { params: Promise<{ scenario: string }> }) {
  const g = guard(req, { session: true });
  if ('response' in g) return g.response;
  const { cfg, demoLimiter } = runtime();
  const { scenario } = await ctx.params;
  if (g.session.role !== 'responder') return json({ error: 'forbidden' }, 403);
  if (!isScenario(scenario)) return json({ error: 'unknown_scenario' }, 404);
  if (!cfg.DEMO_ADMIN_URL || !cfg.DEMO_ADMIN_TOKEN) return json({ error: 'demo_disabled' }, 503);
  if (!demoLimiter.take(g.session.tokenKey)) return json({ error: 'rate_limited' }, 429);

  const out = await runScenario(scenario, {
    adminUrl: cfg.DEMO_ADMIN_URL,
    adminToken: cfg.DEMO_ADMIN_TOKEN,
    deployUrl: cfg.NIGHTSHIFT_DEPLOY_URL,
    ingestToken: cfg.NIGHTSHIFT_INGEST_TOKEN,
  });
  g.session.trace.push({
    turn: g.session.turn,
    at: new Date().toISOString(),
    source: 'demo',
    tool: `demo:${scenario}`,
    input: {},
    outcome: out.ok ? 'ok' : 'error',
    note: out.message,
  });
  log.info('demo scenario', { scenario, ok: out.ok });
  return json(out, out.ok ? 200 : 502);
}
