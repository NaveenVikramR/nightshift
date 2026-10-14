import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, Express, Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import { createMcpServer } from '../mcp/createMcpServer.js';
import { log } from '../lib/log.js';
import { jsonRpcError } from './jsonRpcError.js';
import { originGuard } from './originGuard.js';
import { SessionStore } from './sessionStore.js';

export interface AppDeps {
  config: Config;
  now?: () => number;
}

export interface NightshiftApp {
  app: Express;
  sessions: SessionStore;
  close(): Promise<void>;
}

export function createApp({ config, now = Date.now }: AppDeps): NightshiftApp {
  const sessions = new SessionStore(config.sessionIdleTtlMs, now);

  // SDK app: express.json({ limit }) + Host-header DNS-rebinding guard (+ its own
  // hostname-level Origin check). Our originGuard below adds the exact-origin check.
  const app = createMcpExpressApp({
    host: config.host,
    ...(config.allowedHosts.length > 0 && { allowedHosts: config.allowedHosts }),
    allowedOrigins: config.allowedOrigins.map((o) => new URL(o).hostname),
    jsonLimit: `${config.maxBodyBytes}b`,
  });
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.get('/healthz', (_req, res) => {
    res.type('text/plain').send('ok');
  });

  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    const actor = 'anonymous';
    const sessionId = req.header('mcp-session-id');

    if (sessionId !== undefined) {
      const entry = sessions.get(sessionId, actor);
      if (!entry) {
        res.status(404).json(jsonRpcError(-32001, 'Session not found'));
        return;
      }
      await entry.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method === 'POST' && isInitializeRequest(req.body)) {
      const server = createMcpServer();
      const transport: NodeStreamableHTTPServerTransport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(), // crypto-secure (CSPRNG) v4 UUID
        onsessioninitialized: (id: string): void => sessions.add(id, { transport, server, actor }),
        onsessionclosed: (id) => sessions.forget(id), // client sent DELETE
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.forget(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res
      .status(400)
      .json(
        jsonRpcError(-32000, 'Bad Request: missing MCP-Session-Id or not an initialize request'),
      );
  };

  app.use('/mcp', originGuard(config.allowedOrigins));
  app.post('/mcp', handleMcp);
  app.get('/mcp', handleMcp);
  app.delete('/mcp', handleMcp);
  app.all('/mcp', (_req, res) => {
    res
      .status(405)
      .set('Allow', 'GET, POST, DELETE')
      .json(jsonRpcError(-32000, 'Method not allowed'));
  });

  app.use(errorHandler);

  const sweeper = setInterval(() => void sessions.sweep(), 60_000);
  sweeper.unref();

  return {
    app,
    sessions,
    async close() {
      clearInterval(sweeper);
      await sessions.closeAll();
    },
  };
}

const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status = (err as { status?: unknown }).status;
  if (status === 413) {
    res.status(413).json(jsonRpcError(-32600, 'Request body too large'));
  } else if (status === 400) {
    res.status(400).json(jsonRpcError(-32700, 'Parse error: invalid JSON'));
  } else {
    log.error('unhandled request error', { error: err instanceof Error ? err.message : 'unknown' });
    res.status(500).json(jsonRpcError(-32603, 'Internal error'));
  }
};
