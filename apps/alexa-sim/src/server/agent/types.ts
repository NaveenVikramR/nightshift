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

export interface ModelResponse {
  message: Message;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
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
