/**
 * The MCP client side of the simulator: one MCP session (official client SDK,
 * Streamable HTTP, protocol 2025-11-25) per browser session, authenticated with
 * the person's Nightshift token. Everything Nightshift does for the simulator
 * goes through here: no shortcuts to Prometheus, Alertmanager or the demo target.
 */
import {
  Client,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { log } from './log';

export const PROTOCOL_VERSION = '2025-11-25';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP Apps card for this tool, if any (`_meta.ui.resourceUri`). */
  resourceUri: string | null;
}

export interface McpToolResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** What the agent loop and routes need from Nightshift (fakes implement this in tests). */
export interface McpGateway {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  readResource(uri: string): Promise<{ text: string; mimeType: string }>;
  close(): Promise<void>;
}

function resourceUriOf(meta: unknown): string | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const m = meta as Record<string, unknown>;
  const ui = m['ui'] as { resourceUri?: unknown } | undefined;
  const uri = ui?.resourceUri ?? m['ui/resourceUri'];
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : null;
}

/** The SDK's request timeout (the call may still be running on the server). */
export function isRequestTimeout(err: unknown): boolean {
  return err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout;
}

export class NightshiftMcp implements McpGateway {
  private client: Client | undefined;
  private tools: McpTool[] | undefined;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: 'nightshift-alexa-sim', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
      protocolVersion: PROTOCOL_VERSION,
    });
    await client.connect(transport, { timeout: this.timeoutMs });
    this.client = client;
    return client;
  }

  /**
   * Runs `fn`; on a transport/session failure (not a tool error), reconnects once and retries.
   * Never after a request timeout: the server may still be running the call (a live scan was
   * repeated that way), so it is reported, not retried.
   */
  private async withReconnect<T>(what: string, fn: (c: Client) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.connect());
    } catch (err) {
      if (isRequestTimeout(err)) throw err;
      log.warn('mcp call failed, reconnecting', {
        what,
        error: err instanceof Error ? err.name : 'unknown',
      });
      await this.reset();
      return fn(await this.connect());
    }
  }

  private async reset(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    await c?.close().catch(() => undefined);
  }

  async listTools(): Promise<McpTool[]> {
    if (this.tools) return this.tools;
    const res = await this.withReconnect('tools/list', (c) =>
      c.listTools({}, { timeout: this.timeoutMs }),
    );
    this.tools = res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      resourceUri: resourceUriOf(t._meta),
    }));
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return (await this.withReconnect('tools/call', (c) =>
      c.callTool({ name, arguments: args }, { timeout: this.timeoutMs }),
    )) as McpToolResult;
  }

  async readResource(uri: string): Promise<{ text: string; mimeType: string }> {
    const res = await this.withReconnect('resources/read', (c) =>
      c.readResource({ uri }, { timeout: this.timeoutMs }),
    );
    const first = res.contents[0] as { text?: unknown; mimeType?: unknown } | undefined;
    if (!first || typeof first.text !== 'string') throw new Error('resource has no text');
    return {
      text: first.text,
      mimeType: typeof first.mimeType === 'string' ? first.mimeType : 'text/html',
    };
  }

  async close(): Promise<void> {
    await this.reset();
  }
}

/** { speak, data } from a CallToolResult (structuredContent, else the JSON text block). */
export function speakAndData(result: McpToolResult): {
  speak: string;
  data: Record<string, unknown>;
} {
  let s: unknown = result.structuredContent;
  if (typeof s !== 'object' || s === null) {
    const first = result.content?.[0] as { type?: unknown; text?: unknown } | undefined;
    if (first?.type === 'text' && typeof first.text === 'string') {
      try {
        s = JSON.parse(first.text);
      } catch {
        s = { speak: first.text };
      }
    }
  }
  const o = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>;
  return {
    speak: typeof o['speak'] === 'string' ? o['speak'] : '',
    data:
      typeof o['data'] === 'object' && o['data'] !== null
        ? (o['data'] as Record<string, unknown>)
        : {},
  };
}
