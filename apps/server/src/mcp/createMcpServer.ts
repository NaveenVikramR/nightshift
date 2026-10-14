import { McpServer } from '@modelcontextprotocol/server';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';

/** One McpServer per session. Tool registration lives in src/mcp/registerTools.ts. */
export function createMcpServer(): McpServer {
  return new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
}
