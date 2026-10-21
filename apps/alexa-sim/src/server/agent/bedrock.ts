/**
 * Amazon Bedrock Converse API with tool use. Credentials come from the AWS SDK's
 * default provider chain: the EC2 instance role in prod, a local profile in
 * development. Never from code or a committed .env.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import type { ContentBlock, Message, ModelClient, ModelRequest, ModelResponse } from './types';

/** The one SDK method we use (a fake implements it in tests). */
export interface ConverseSender {
  send(
    command: ConverseCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ConverseCommandOutput>;
}

export interface GuardrailRef {
  id: string;
  version: string;
}

/** MCP JSON Schema -> Bedrock tool schema (drops keys Bedrock doesn't need). */
function toolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _drop, ...rest } = schema;
  return { type: 'object', ...rest };
}

/** The latest plain user utterance becomes guardContent, so the guardrail checks only it. */
function guardLatestUtterance(messages: Message[]): unknown[] {
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && m.content.every((b) => 'text' in b)) {
      idx = i;
      break;
    }
  }
  return messages.map((m, i) =>
    i !== idx
      ? m
      : {
          role: m.role,
          content: m.content.map((b) => ({
            guardContent: { text: { text: (b as { text: string }).text } },
          })),
        },
  );
}

export function buildConverseInput(
  modelId: string,
  req: ModelRequest,
  guardrail?: GuardrailRef,
): ConverseCommandInput {
  const guard = Boolean(guardrail && req.guardUtterance);
  return {
    modelId,
    system: [{ text: req.system }],
    messages: (guard
      ? guardLatestUtterance(req.messages)
      : req.messages) as ConverseCommandInput['messages'],
    toolConfig: {
      tools: req.tools.map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description.slice(0, 1000),
          inputSchema: { json: toolSchema(t.inputSchema) },
        },
      })) as NonNullable<ConverseCommandInput['toolConfig']>['tools'],
      toolChoice: { auto: {} },
    },
    // Short, deterministic answers for a voice device.
    inferenceConfig: { maxTokens: 300, temperature: 0 },
    ...(guardrail && {
      guardrailConfig: {
        guardrailIdentifier: guardrail.id,
        guardrailVersion: guardrail.version,
        trace: 'enabled',
      },
    }),
  };
}

function toStopReason(r: string | undefined): ModelResponse['stopReason'] {
  if (r === 'guardrail_intervened') return 'guardrail';
  return r === 'end_turn' || r === 'tool_use' || r === 'max_tokens' ? r : 'other';
}

export class BedrockModel implements ModelClient {
  readonly label: string;

  constructor(
    private readonly modelId: string,
    private readonly client: ConverseSender,
    private readonly guardrail?: GuardrailRef,
  ) {
    this.label = `Amazon Bedrock · ${modelId}`;
  }

  static fromRegion(modelId: string, region: string, guardrail?: GuardrailRef): BedrockModel {
    return new BedrockModel(modelId, new BedrockRuntimeClient({ region }), guardrail);
  }

  async converse(req: ModelRequest): Promise<ModelResponse> {
    const out = await this.client.send(
      new ConverseCommand(buildConverseInput(this.modelId, req, this.guardrail)),
      req.signal ? { abortSignal: req.signal } : undefined,
    );
    const msg = out.output && 'message' in out.output ? out.output.message : undefined;
    const content = ((msg?.content ?? []) as ContentBlock[]).filter(
      (b) => 'text' in b || 'toolUse' in b,
    );
    const message: Message = { role: 'assistant', content };
    return {
      message,
      stopReason: toStopReason(out.stopReason),
      usage: {
        inputTokens: out.usage?.inputTokens ?? 0,
        outputTokens: out.usage?.outputTokens ?? 0,
      },
    };
  }
}
