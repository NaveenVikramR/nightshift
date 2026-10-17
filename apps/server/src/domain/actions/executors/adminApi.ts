import { z } from 'zod';
import { ClientError, fetchJson, type FetchLike } from '../../../clients/errors.js';
import { sanitizeLabel } from '../../../lib/untrusted.js';
import type { ActionName, ResolvedAction } from '../types.js';
import type { ActionExecutor, ExecutionResult, TargetState } from './types.js';

/**
 * The admin API contract a target implements to be remediable by Nightshift
 * (demo-target implements it; any app can):
 *   GET  /admin/state            → { activeProvider?, version?, restarting? }
 *   POST /admin/route-provider   { provider }
 *   POST /admin/rollback         { version }
 *   POST /admin/restart
 * Bearer token from an env var named in nightshift.yaml (never in config or logs).
 */
const stateSchema = z.looseObject({
  activeProvider: z.string().optional(),
  version: z.string().optional(),
  restarting: z.boolean().optional(),
});

export class AdminApiExecutor implements ActionExecutor {
  readonly type = 'admin_api' as const;

  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  supports(_action: ActionName): boolean {
    return true;
  }

  async state(_service: string): Promise<TargetState> {
    const body = await this.call('GET', '/admin/state');
    const parsed = stateSchema.safeParse(body);
    if (!parsed.success) throw new ClientError('AdminApi', 'bad_response', 'state shape');
    return {
      activeProvider: sanitizeLabel(parsed.data.activeProvider ?? '') || null,
      version: sanitizeLabel(parsed.data.version ?? '') || null,
      restarting: parsed.data.restarting ?? false,
    };
  }

  async execute(a: ResolvedAction): Promise<ExecutionResult> {
    const [path, payload] =
      a.action === 'failover_provider'
        ? ['/admin/route-provider', { provider: a.to }]
        : a.action === 'rollback_deploy'
          ? ['/admin/rollback', { version: a.toVersion }]
          : ['/admin/restart', {}];
    const body = await this.call('POST', path, payload);
    const state = stateSchema.safeParse(body);
    return {
      detail: {
        endpoint: path,
        activeProvider: state.data?.activeProvider ?? null,
        version: state.data?.version ?? null,
      },
    };
  }

  private async call(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<unknown> {
    if (!this.token) {
      throw new ClientError(
        'AdminApi',
        'rejected',
        `token env var for executor ${this.name} is not set`,
      );
    }
    const { body } = await fetchJson(
      'AdminApi',
      `${this.baseUrl}${path}`,
      {
        method,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        ...(payload !== undefined && { body: JSON.stringify(payload) }),
      },
      this.timeoutMs,
      this.fetchImpl,
    );
    return body;
  }
}
