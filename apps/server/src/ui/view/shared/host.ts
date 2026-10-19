/**
 * What a card needs from its host. In the real host this is the ext-apps App
 * (see main.ts); in tests and screenshots it's a fake. Cards never talk to the
 * network: data comes only from tool results.
 */
export interface ToolResult {
  /** Server-authored spoken summary (safe to show). */
  speak: string;
  data: Record<string, unknown>;
  isError: boolean;
}

export interface CardHost {
  now(): number;
  /** Calls a Nightshift tool through the host (the host may ask the user first). */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/** A CallToolResult as delivered to the View, reduced to Nightshift's { speak, data } contract. */
export interface RawToolResult {
  structuredContent?: unknown;
  content?: unknown[] | undefined;
  isError?: boolean | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function toToolResult(raw: RawToolResult): ToolResult {
  let structured: unknown = raw.structuredContent;
  if (!isRecord(structured)) {
    // Spec: structuredContent is also sent as JSON text; some hosts only forward content.
    const first = raw.content?.[0];
    if (isRecord(first) && first['type'] === 'text' && typeof first['text'] === 'string') {
      try {
        structured = JSON.parse(first['text']);
      } catch {
        structured = undefined;
      }
    }
  }
  const s = isRecord(structured) ? structured : {};
  return {
    speak: typeof s['speak'] === 'string' ? s['speak'] : '',
    data: isRecord(s['data']) ? s['data'] : {},
    isError: raw.isError === true,
  };
}
