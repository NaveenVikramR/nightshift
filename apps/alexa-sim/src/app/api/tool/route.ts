/**
 * POST /alexa/api/tool { name, arguments, voice } → a card button through the MCP
 * Apps bridge. Only prepare_action, confirm_action (for a confirmation this
 * session prepared; the click is the explicit yes) and get_security_findings.
 * The answer is spoken too: Polly reads the tool's server-authored `speak`.
 */
import type { NextRequest } from 'next/server';
import { runCardTool } from '@/server/agent/loop';
import { GUARDRAIL_SPOKEN } from '@/server/agent/guardrail';
import { guard, json, readJson } from '@/server/http';
import { log } from '@/server/log';
import { runtime } from '@/server/runtime';
import { speakReply, voiceOf } from '@/server/speak';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const g = guard(req, { session: true });
  if ('response' in g) return g.response;
  const { agent, speech, metrics } = runtime();
  const body = await readJson(req);
  const name = typeof body?.['name'] === 'string' ? body['name'] : '';
  const args =
    typeof body?.['arguments'] === 'object' &&
    body['arguments'] !== null &&
    !Array.isArray(body['arguments'])
      ? (body['arguments'] as Record<string, unknown>)
      : {};
  const voice = voiceOf(body?.['voice']);
  const out = await runCardTool(agent, g.session, name, args);
  if ('refused' in out) {
    const { audio } = await speakReply(speech, g.session, out.refused, voice);
    // A tool-shaped error the card can show (server-authored text only).
    return json({
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ speak: out.refused, data: { error: 'refused' } }),
          },
        ],
        isError: true,
      },
      trace: [],
      speak: out.refused,
      audio,
    });
  }
  const spoken = out.blocked ? `${GUARDRAIL_SPOKEN} ${out.speak}`.trim() : out.speak;
  const { audio, characters } = await speakReply(speech, g.session, spoken, voice);
  metrics.record({
    AgentTurns: 0,
    ToolCalls: 1,
    GuardrailBlocks: out.blocked ? 1 : 0,
    ModelErrors: 0,
    PollyCharacters: characters,
  });
  log.info('card tool', { tool: name, pollyCharacters: characters });
  return json({ result: out.result, trace: out.trace, speak: spoken, audio });
}
