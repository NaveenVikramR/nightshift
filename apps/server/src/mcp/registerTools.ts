import type { McpServer } from '@modelcontextprotocol/server';
import { pingNightshift } from '../tools/ping_nightshift.js';
import { runTool } from '../tools/runTool.js';
import type { ToolDefinition, ToolDeps } from '../tools/types.js';

/** Every Nightshift tool. Add new tools here (see the add-mcp-tool skill). */
export const TOOLS: readonly ToolDefinition[] = [pingNightshift as ToolDefinition];

export function registerTools(server: McpServer, deps: ToolDeps): void {
  for (const def of TOOLS) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: def.annotations,
      },
      (input, ctx) => runTool(def, deps, input, ctx.http?.authInfo),
    );
  }
}
