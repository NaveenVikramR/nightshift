/** POST /alexa/api/turn { text, voice } → the agent's reply, cards, trace and speech. */
import type { NextRequest } from 'next/server';
import { runTurn } from '@/server/agent/loop';
import { guard, json, readJson } from '@/server/http';
import { log } from '@/server/log';
import { runtime } from '@/server/runtime';
import { speakReply, voiceOf } from '@/server/speak';

export const maxDuration = 90;

export async function POST(req: NextRequest) {
  const g = guard(req, { session: true });
  if ('response' in g) return g.response;
  const { agent, speech, metrics } = runtime();
  const session = g.session;

  const body = await readJson(req);
  const text = typeof body?.['text'] === 'string' ? body['text'].trim().slice(0, 500) : '';
  if (!text) return json({ error: 'empty' }, 400);

  const started = Date.now();
  const turn = await runTurn(agent, session, text);
  const { audio, characters } = await speakReply(
    speech,
    session,
    turn.reply,
    voiceOf(body?.['voice']),
  );

  const s = turn.stats;
  metrics.record({
    AgentTurns: 1,
    ToolCalls: s.toolCalls,
    GuardrailBlocks: s.guardrailBlocks,
    ModelErrors: s.modelErrors,
    PollyCharacters: characters,
  });
  // Counts only: approximate cost inputs per turn.
  log.info('turn', {
    ms: Date.now() - started,
    modelCalls: s.modelCalls,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    tools: s.toolCalls,
    guardrailBlocks: s.guardrailBlocks,
    pollyCharacters: characters,
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
    usage: {
      modelCalls: s.modelCalls,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      pollyCharacters: characters,
    },
  });
}
