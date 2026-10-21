/**
 * Per-call tool trimming (cost): offer the model only the tools this turn can
 * use, with one-sentence descriptions and no property descriptions. Safety does
 * not depend on this: Nightshift checks roles and the human-yes guard checks
 * confirm_action whatever the model is offered.
 */
import type { Role } from '../sessions';
import type { McpTool } from '../mcp';
import type { Message, ToolSpec } from './types';

/** Tools that change something (responders only). */
export const WRITE_TOOLS = new Set([
  'prepare_action',
  'confirm_action',
  'acknowledge_alert',
  'silence_alert',
  'add_incident_note',
]);

export interface TurnToolContext {
  role: Role;
  /** This session holds a prepared confirmation (from an earlier turn or a card). */
  pendingConfirmation: boolean;
  /** Tool names already in the history (Converse needs them in toolConfig). */
  inHistory: Set<string>;
}

export function toolsForTurn(tools: McpTool[], ctx: TurnToolContext): McpTool[] {
  return tools.filter((t) => {
    if (ctx.inHistory.has(t.name)) return true;
    if (!WRITE_TOOLS.has(t.name)) return true;
    if (ctx.role !== 'responder') return false;
    return t.name !== 'confirm_action' || ctx.pendingConfirmation;
  });
}

export function toolNamesIn(history: Message[]): Set<string> {
  const names = new Set<string>();
  for (const m of history) for (const b of m.content) if ('toolUse' in b) names.add(b.toolUse.name);
  return names;
}

/** First sentence, at most 160 characters. */
export function firstSentence(text: string): string {
  const s = text.trim().split(/(?<=[.!?])\s/)[0] ?? '';
  return s.length > 160 ? `${s.slice(0, 159)}…` : s;
}

/** A JSON Schema without `$schema`, `description`, `title` or `examples` (recursively). */
export function slimSchema(schema: unknown, depth = 0): unknown {
  if (depth > 10 || typeof schema !== 'object' || schema === null) return schema;
  if (Array.isArray(schema)) return schema.map((s) => slimSchema(s, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === 'description' || k === 'title' || k === 'examples') continue;
    // Inside `properties`, keys are property names (keep them all, even "description").
    out[k] =
      k === 'properties' && typeof v === 'object' && v !== null && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, slimSchema(s, depth + 1)]))
        : slimSchema(v, depth + 1);
  }
  return out;
}

export function toSpecs(tools: McpTool[]): ToolSpec[] {
  return tools.map((t) => ({
    name: t.name,
    description: firstSentence(t.description),
    inputSchema: slimSchema(t.inputSchema) as Record<string, unknown>,
  }));
}
