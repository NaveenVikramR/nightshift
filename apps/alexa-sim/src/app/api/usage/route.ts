/** GET /alexa/api/usage → usage counters and caps (counts only; signed-in users). */
import type { NextRequest } from 'next/server';
import { guard, json } from '@/server/http';
import { runtime } from '@/server/runtime';

export async function GET(req: NextRequest) {
  const g = guard(req, { session: true });
  if ('response' in g) return g.response;
  const { usage, agent, speechCap, sessions } = runtime();
  return json({
    counts: usage.counts,
    today: {
      modelRequests: agent.modelCap.count,
      modelRequestCap: agent.modelCap.limit,
      speechRequests: speechCap.count,
      speechRequestCap: speechCap.limit,
    },
    sessions: sessions.size,
  });
}
