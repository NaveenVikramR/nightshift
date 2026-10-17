import { ClientError, fetchJson, type FetchLike } from '../../../clients/errors.js';
import type { ActionName, ResolvedAction } from '../types.js';
import type { ActionExecutor, ExecutionResult } from './types.js';

/**
 * rollback_deploy via a GitHub Actions workflow_dispatch:
 *   POST /repos/{repo}/actions/workflows/{workflow}/dispatches
 *   { ref, inputs: { service, version } }   → 204
 * The workflow does the actual rollback. Needs a fine-grained token with
 * Actions: write on that repo. Rollback only; it can't report live state.
 */
export class GitHubWorkflowExecutor implements ActionExecutor {
  readonly type = 'github_workflow' as const;

  constructor(
    readonly name: string,
    private readonly opts: {
      apiUrl: string;
      repo: string;
      workflow: string;
      ref: string;
      token: string | undefined;
      timeoutMs: number;
    },
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  supports(action: ActionName): boolean {
    return action === 'rollback_deploy';
  }

  async state(): Promise<null> {
    return null;
  }

  async execute(a: ResolvedAction): Promise<ExecutionResult> {
    if (a.action !== 'rollback_deploy') {
      throw new ClientError(
        'GitHub',
        'rejected',
        `${a.action} is not supported by a workflow executor`,
      );
    }
    const { repo, workflow, ref, token, apiUrl, timeoutMs } = this.opts;
    if (!token)
      throw new ClientError(
        'GitHub',
        'rejected',
        `token env var for executor ${this.name} is not set`,
      );
    const { status } = await fetchJson(
      'GitHub',
      `${apiUrl}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'nightshift-mcp',
        },
        body: JSON.stringify({ ref, inputs: { service: a.service, version: a.toVersion } }),
      },
      timeoutMs,
      this.fetchImpl,
    );
    return { detail: { workflow, ref, status, dispatched: true } };
  }
}
