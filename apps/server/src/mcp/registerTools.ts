import type { McpServer } from '@modelcontextprotocol/server';
import { listActiveAlerts } from '../tools/list_active_alerts.js';
import { pingNightshift } from '../tools/ping_nightshift.js';
import { runTool } from '../tools/runTool.js';
import type { ToolDefinition, ToolDeps } from '../tools/types.js';
import { passThroughSchema } from './passThroughSchema.js';

/** Every Nightshift tool. Add new tools here (see the add-mcp-tool skill). */
export const TOOLS: readonly ToolDefinition[] = [
  pingNightshift,
  listActiveAlerts,
] as unknown as readonly ToolDefinition[];

export function registerTools(
  server: McpServer,
  deps: ToolDeps,
  tools: readonly ToolDefinition[] = TOOLS,
): void {
  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        // Advertises the real schema; validation happens in runTool (audited).
        inputSchema: passThroughSchema(def.inputSchema),
        annotations: def.annotations,
      },
      (input, ctx) => runTool(def, deps, input, ctx.http?.authInfo),
    );
  }
}
