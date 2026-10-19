import type { AgentDeps } from '../src/server/agent/loop';
import type { Message, ModelClient, ModelRequest, ModelResponse } from '../src/server/agent/types';
import { DailyCap, RateLimiter, Usage } from '../src/server/limits';
import type { McpGateway, McpTool, McpToolResult } from '../src/server/mcp';
import { SessionStore, type Session } from '../src/server/sessions';

export const TOOLS: McpTool[] = [
  {
    name: 'get_ops_brief',
    description: 'brief',
    inputSchema: { type: 'object', properties: {} },
    resourceUri: 'ui://nightshift/brief.html',
  },
  {
    name: 'explain_incident',
    description: 'why',
    inputSchema: { type: 'object', properties: { service: { type: 'string' } } },
    resourceUri: 'ui://nightshift/incident.html',
  },
  {
    name: 'prepare_action',
    description: 'prepare',
    inputSchema: { type: 'object' },
    resourceUri: 'ui://nightshift/confirm.html',
  },
  {
    name: 'confirm_action',
    description: 'confirm',
    inputSchema: { type: 'object' },
    resourceUri: 'ui://nightshift/confirm.html',
  },
  {
    name: 'get_security_findings',
    description: 'findings',
    inputSchema: { type: 'object' },
    resourceUri: 'ui://nightshift/security.html',
  },
  {
    name: 'get_incident_timeline',
    description: 'timeline',
    inputSchema: { type: 'object' },
    resourceUri: null,
  },
];

export const result = (
  speak: string,
  data: Record<string, unknown> = {},
  isError = false,
): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ speak, data }) }],
  structuredContent: { speak, data },
  ...(isError && { isError: true }),
});

/** Fake Nightshift: canned answers per tool; records every call. */
export class FakeMcp implements McpGateway {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  readonly answers = new Map<string, (args: Record<string, unknown>) => McpToolResult>([
    [
      'get_ops_brief',
      () => result('Critical: payments API errors at 45 percent.', { services: [] }),
    ],
    [
      'explain_incident',
      () =>
        result(
          'Critical. Payments API errors at 45 percent for 4 minutes. The Razorpay breaker is open. I can fail over to Stripe.',
          {
            causes: [
              {
                id: 'provider_failure',
                suggestedActions: [
                  {
                    action: 'failover_provider',
                    params: { service: 'payments-api', from: 'razorpay', to: 'stripe' },
                    requiresConfirmation: true,
                  },
                ],
              },
            ],
            series: {},
          },
        ),
    ],
    [
      'prepare_action',
      () =>
        result(
          'This will route all payments API traffic from Razorpay to Stripe. Shall I go ahead?',
          { confirmationId: 'cfm_abcdef123456', summary: {}, expiresAt: '' },
        ),
    ],
    [
      'confirm_action',
      () =>
        result('Done. Payments API now uses Stripe. Recovered: errors at 0.5 percent.', {
          confirmationId: 'cfm_abcdef123456',
          status: 'succeeded',
          verification: { outcome: 'recovered', before: 0.45, after: 0.005 },
        }),
    ],
    [
      'get_security_findings',
      () => result('Security grade A. No open issues.', { grade: 'A', checks: [] }),
    ],
    [
      'get_incident_timeline',
      () => result('Critical incident on payments API, resolved after 1 minute.', {}),
    ],
  ]);
  closed = false;

  async listTools() {
    return TOOLS;
  }
  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    const a = this.answers.get(name);
    return a ? a(args) : result('Unknown tool.', { error: 'unknown_tool' }, true);
  }
  async readResource() {
    return { text: '<!doctype html>', mimeType: 'text/html;profile=mcp-app' };
  }
  async close() {
    this.closed = true;
  }
}

type Step = ModelResponse | ((req: ModelRequest) => ModelResponse | Promise<ModelResponse>);

/** A model that replays scripted steps and records each request. */
export class FakeModel implements ModelClient {
  readonly label = 'fake model';
  readonly requests: ModelRequest[] = [];
  constructor(
    private readonly steps: Step[],
    private readonly fallback?: Step,
  ) {}
  async converse(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push({ ...req, messages: [...req.messages] });
    const step = this.steps.shift() ?? this.fallback;
    if (!step) throw new Error('no more scripted steps');
    return typeof step === 'function' ? step(req) : step;
  }
}

let n = 0;
export const useTool = (name: string, input: Record<string, unknown> = {}): ModelResponse => ({
  message: { role: 'assistant', content: [{ toolUse: { toolUseId: `t${++n}`, name, input } }] },
  stopReason: 'tool_use',
});
export const say = (text: string): ModelResponse => ({
  message: { role: 'assistant', content: [{ text }] },
  stopReason: 'end_turn',
});

export function makeDeps(model: ModelClient, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    model,
    rate: new RateLimiter(20, 10 * 60_000),
    modelCap: new DailyCap(500),
    usage: new Usage(),
    maxToolCallsPerTurn: 6,
    maxTurnsPerSession: 40,
    modelTimeoutMs: 1_000,
    mcpTimeoutMs: 1_000,
    turnTimeoutMs: 2_000,
    ...over,
  };
}

export function makeSession(
  mcp = new FakeMcp(),
  role: 'viewer' | 'responder' = 'responder',
): { session: Session; mcp: FakeMcp } {
  const store = new SessionStore(30 * 60_000);
  return {
    session: store.create({ token: 'test-token-0123456789', actor: 'alice', role, mcp }),
    mcp,
  };
}

/** Every toolUse is followed by its toolResult, and roles alternate. */
export function historyIsValid(history: Message[]): boolean {
  for (let i = 1; i < history.length; i++)
    if (history[i]!.role === history[i - 1]!.role) return false;
  for (let i = 0; i < history.length; i++) {
    const uses = history[i]!.content.filter((b) => 'toolUse' in b);
    if (!uses.length) continue;
    const next = history[i + 1];
    if (!next) return false;
    const ids = new Set(
      next.content.flatMap((b) => ('toolResult' in b ? [b.toolResult.toolUseId] : [])),
    );
    if (!uses.every((u) => 'toolUse' in u && ids.has(u.toolUse.toolUseId))) return false;
  }
  return true;
}
