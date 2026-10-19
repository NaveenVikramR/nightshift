/** POST /alexa/api/turn { text, voice } → the agent's reply, cards, trace and speech. */
import { randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { runTurn } from '@/server/agent/loop';
import { guard, json, readJson } from '@/server/http';
import { log } from '@/server/log';
import { runtime } from '@/server/runtime';
import type { VoiceId } from '@/server/tts';

export const maxDuration = 90;

export async function POST(req: NextRequest) {
  const g = guard(req, { session: true });
  if ('response' in g) return g.response;
  const { agent, speech } = runtime();
  const session = g.session;

  const body = await readJson(req);
  const text = typeof body?.['text'] === 'string' ? body['text'].trim().slice(0, 500) : '';
  const voice: VoiceId = body?.['voice'] === 'en-US' ? 'en-US' : 'en-IN';
  if (!text) return json({ error: 'empty' }, 400);

  const started = Date.now();
  const turn = await runTurn(agent, session, text);

  // Speech: Polly MP3 kept in session memory for one fetch, or "browser" (local).
  let audio: { provider: 'browser' } | { provider: 'polly'; id: string } | { provider: 'none' } = {
    provider: 'none',
  };
  try {
    const s = await speech.synthesize(turn.reply, voice, AbortSignal.timeout(10_000));
    if (s.provider === 'polly') {
      const id = randomBytes(12).toString('base64url');
      session.audio.clear();
      session.audio.set(id, s.audio);
      audio = { provider: 'polly', id };
    } else if (s.provider === 'browser') audio = { provider: 'browser' };
  } catch {
    log.warn('speech failed');
  }

  log.info('turn', {
    ms: Date.now() - started,
    tools: turn.trace.filter((t) => t.tool !== 'human').length,
    cards: turn.cards.length,
    source: turn.replySource,
  });
  return json({
    reply: turn.reply,
    replySource: turn.replySource,
    cards: turn.cards,
    trace: turn.trace,
    audio,
    model: turn.modelLabel,
  });
}
