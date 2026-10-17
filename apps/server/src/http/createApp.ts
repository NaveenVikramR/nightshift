import { randomUUID } from 'node:crypto';
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import {
  hostHeaderValidation,
  localhostHostValidation,
  requireBearerAuth,
} from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest, type AuthInfo } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import type { DeployStore } from '../db/deployStore.js';
import { createMcpServer } from '../mcp/createMcpServer.js';
import { TOOLS } from '../mcp/registerTools.js';
import { createTokenVerifier, getPrincipal } from '../lib/auth.js';
import type { ToolDefinition, ToolDeps } from '../tools/types.js';
import { SERVER_VERSION } from '../version.js';
import { AuthFailureLimiter, authFailureGuard } from '../lib/authFailureLimiter.js';
import { log } from '../lib/log.js';
import { deployIngestHandler } from './deployIngest.js';
import { jsonRpcError } from './jsonRpcError.js';
import { originGuard } from './originGuard.js';
import { SessionStore } from './sessionStore.js';
import { toolCallAuditTap } from './toolCallAuditTap.js';

/** Tool dependencies supplied by the caller; runtime ones (clock, version) are added here. */
export type ExternalToolDeps = Omit<ToolDeps, 'now' | 'serverVersion' | 'startedAt'>;

export interface AppDeps {
  config: Config;
  deps: ExternalToolDeps;
  /** Where POST /events/deploy stores deploys. */
  deployStore: DeployStore;
  /** Defaults to every registered tool; tests may inject extra tools. */
  tools?: readonly ToolDefinition[];
  now?: () => number;
}

const LOCALHOST_BINDS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Same rules createMcpExpressApp applies, but placed explicitly in our chain. */
function hostGuard(config: Config): RequestHandler | undefined {
  if (config.allowedHosts.length > 0) return hostHeaderValidation(config.allowedHosts);
  if (LOCALHOST_BINDS.has(config.host)) return localhostHostValidation();
  return undefined;
}

/** requireBearerAuth attaches the verified token info as `req.auth`. */
type AuthedRequest = Request & { auth?: AuthInfo };

export interface NightshiftApp {
  app: Express;
  sessions: SessionStore;
  close(): Promise<void>;
}

export function createApp({
  config,
  deps,
  deployStore,
  tools = TOOLS,
  now = Date.now,
}: AppDeps): NightshiftApp {
  const toolDeps: ToolDeps = {
    deployLog: deployStore,
    strictSessionBinding: config.strictSessionBinding,
    ...deps,
    now: () => new Date(now()),
    serverVersion: SERVER_VERSION,
    startedAt: new Date(now()),
  };
  const sessions = new SessionStore(config.sessionIdleTtlMs, now);
  const authFailures = new AuthFailureLimiter(config.authFailLimit, config.authFailWindowMs, now);

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: config.maxBodyBytes }));

  app.get('/healthz', (_req, res) => {
    res.type('text/plain').send('ok');
  });

  const handleMcp = async (req: AuthedRequest, res: Response): Promise<void> => {
    const principal = getPrincipal(req.auth);
    if (!principal) {
      // requireBearerAuth runs first, so this only happens on a wiring bug.
      res.status(401).json(jsonRpcError(-32000, 'Unauthorized'));
      return;
    }
    const { actor } = principal;
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
      const server = createMcpServer(toolDeps, tools);
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

  // Order matters: audit tap (observes) → Host (403) → Origin (403) →
  // failed-auth limiter (429) → bearer token (401) → session (404) → transport.
  app.use(
    '/mcp',
    toolCallAuditTap({
      audit: deps.audit,
      knownTools: new Set(tools.map((t) => t.name)),
      rateLimitedDedupMs: config.authFailWindowMs,
      now,
    }),
  );
  const host = hostGuard(config);
  if (host) app.use('/mcp', host);
  else log.warn('Host header validation is off (non-localhost bind, ALLOWED_HOSTS empty)');
  app.use('/mcp', originGuard(config.allowedOrigins));
  app.use('/mcp', authFailureGuard(authFailures));
  app.use('/mcp', requireBearerAuth({ verifier: createTokenVerifier(config.tokens) }));
  app.post('/mcp', handleMcp);
  app.get('/mcp', handleMcp);
  app.delete('/mcp', handleMcp);
  app.all('/mcp', (_req, res) => {
    res
      .status(405)
      .set('Allow', 'GET, POST, DELETE')
      .json(jsonRpcError(-32000, 'Method not allowed'));
  });

  // Deploy ingest for CI systems: same Host / Origin / failed-auth guards as
  // /mcp, but only ingest tokens are accepted (never MCP tokens).
  if (host) app.use('/events', host);
  app.use('/events', originGuard(config.allowedOrigins));
  app.use('/events', authFailureGuard(authFailures));
  app.post(
    '/events/deploy',
    deployIngestHandler({
      tokens: config.ingestTokens,
      store: deployStore,
      services: deps.services,
      audit: deps.audit,
      now: () => new Date(now()),
    }),
  );

  app.use(errorHandler);

  const sweeper = setInterval(() => {
    void sessions.sweep();
    authFailures.sweep();
  }, 60_000);
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
