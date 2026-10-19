import { McpServer } from '@modelcontextprotocol/server';
import type { ToolDefinition, ToolDeps } from '../tools/types.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';
import { registerCards } from '../ui/cards.js';
import { registerPrompts } from './registerPrompts.js';
import { registerTools, TOOLS } from './registerTools.js';

/** One McpServer per session. */
export function createMcpServer(
  deps: ToolDeps,
  tools: readonly ToolDefinition[] = TOOLS,
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, deps, tools);
  registerCards(server);
  registerPrompts(server, deps);
  return server;
}
