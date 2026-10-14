import { McpServer } from '@modelcontextprotocol/server';
import type { ToolDeps } from '../tools/types.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';
import { registerTools } from './registerTools.js';

/** One McpServer per session. */
export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, deps);
  return server;
}
