/** Conversation shapes modelled on the Bedrock Converse API (so the Bedrock adapter is a thin map). */

export type ContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | {
      toolResult: {
        toolUseId: string;
        content: ({ json: unknown } | { text: string })[];
        status?: 'success' | 'error';
      };
    };

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  message: Message;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
  usage?: TokenUsage;
}

/** The provider said "too many requests / tokens" (Groq 429, Bedrock ThrottlingException). */
export class ModelRateLimitError extends Error {
  constructor(readonly retryAfterSeconds?: number) {
    super('model rate limited');
    this.name = 'ModelRateLimitError';
  }
}

/**
 * Any other provider failure. Carries the HTTP status and the provider's short
 * error code (e.g. "tool_use_failed"), never the response body or message text.
 */
export class ModelError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`model error ${status}${code ? ` ${code}` : ''}`);
    this.name = 'ModelError';
  }
}

/** A chat model with tool use (Bedrock Converse, Groq, or the scripted test model). */
export interface ModelClient {
  /** Shown in the "What Nightshift did" panel. */
  readonly label: string;
  converse(req: ModelRequest): Promise<ModelResponse>;
}

export const isText = (b: ContentBlock): b is { text: string } => 'text' in b;
export const isToolUse = (b: ContentBlock): b is Extract<ContentBlock, { toolUse: unknown }> =>
  'toolUse' in b;
export const isToolResult = (
  b: ContentBlock,
): b is Extract<ContentBlock, { toolResult: unknown }> => 'toolResult' in b;
