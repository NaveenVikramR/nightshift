/** GET /alexa/api/session → who is signed in (no token), the CSRF token, providers and limits. */
import type { NextRequest } from 'next/server';
import { guard, json } from '@/server/http';
import { runtime } from '@/server/runtime';
import { VOICES } from '@/server/tts';

export async function GET(req: NextRequest) {
  const g = guard(req, { session: true });
  if ('response' in g) return g.response;
  const { agent, speech, cfg } = runtime();
  const s = g.session;
  return json({
    actor: s.actor,
    role: s.role,
    csrf: s.csrf,
    model: agent.model.label,
    speech: speech.label,
    speechProvider: cfg.TTS_PROVIDER,
    voices: Object.entries(VOICES).map(([id, v]) => ({ id, label: v.label })),
    demo: s.role === 'responder' && Boolean(cfg.DEMO_ADMIN_URL && cfg.DEMO_ADMIN_TOKEN),
    trace: s.trace.slice(-50),
  });
}
