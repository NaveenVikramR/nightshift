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

/** MCP JSON Schema -> Bedrock tool schema (drops keys Bedrock doesn't need). */
function toolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _drop, ...rest } = schema;
  return { type: 'object', ...rest };
}

export function buildConverseInput(modelId: string, req: ModelRequest): ConverseCommandInput {
  return {
    modelId,
    system: [{ text: req.system }],
    messages: req.messages as ConverseCommandInput['messages'],
    toolConfig: {
      tools: req.tools.map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description.slice(0, 1000),
          inputSchema: { json: toolSchema(t.inputSchema) },
        },
      })) as NonNullable<ConverseCommandInput['toolConfig']>['tools'],
    },
    // Short, deterministic answers for a voice device.
    inferenceConfig: { maxTokens: 400, temperature: 0.2 },
  };
}

function toStopReason(r: string | undefined): ModelResponse['stopReason'] {
  return r === 'end_turn' || r === 'tool_use' || r === 'max_tokens' ? r : 'other';
}

export class BedrockModel implements ModelClient {
  readonly label: string;

  constructor(
    private readonly modelId: string,
    private readonly client: ConverseSender,
  ) {
    this.label = `Amazon Bedrock (${modelId})`;
  }

  static fromRegion(modelId: string, region: string | undefined): BedrockModel {
    return new BedrockModel(modelId, new BedrockRuntimeClient(region ? { region } : {}));
  }

  async converse(req: ModelRequest): Promise<ModelResponse> {
    const out = await this.client.send(
      new ConverseCommand(buildConverseInput(this.modelId, req)),
      req.signal ? { abortSignal: req.signal } : undefined,
    );
    const msg = out.output && 'message' in out.output ? out.output.message : undefined;
    const content = ((msg?.content ?? []) as ContentBlock[]).filter(
      (b) => 'text' in b || 'toolUse' in b,
    );
    const message: Message = { role: 'assistant', content };
    return { message, stopReason: toStopReason(out.stopReason) };
  }
}
