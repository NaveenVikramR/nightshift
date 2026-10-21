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
  /**
   * Run the guardrail on the latest plain user utterance (first model call of a
   * turn only, so earlier history and tool results aren't billed again).
   */
  guardUtterance?: boolean;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  message: Message;
  /** 'guardrail' = the guardrail blocked the user's words; message holds its safe text. */
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'guardrail' | 'other';
  usage?: TokenUsage;
}

/** A chat model with tool use (Bedrock Converse, or the local scripted model). */
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
